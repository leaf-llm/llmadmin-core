import type { Pool } from 'pg';

type UsageDelta = {
  total: number;
  success: number;
  failure: number;
  inputTokens: number;
  outputTokens: number;
  cacheInputTokens: number;
};

type PendingRow = UsageDelta & { day: string; provider: string };

type MetricsResponse = {
  from: string;
  to: string;
  totals: {
    totalRequests: number;
    successCount: number;
    failureCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheInputTokens: number;
  };
  daily: Array<{
    date: string;
    provider: string;
    totalRequests: number;
    successCount: number;
    failureCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheInputTokens: number;
  }>;
};

function resolveDriver(): 'postgres' | 'file' | 'memory' {
  const configured = (process.env.USAGE_STORE || 'auto').toLowerCase();
  if (configured === 'postgres' || configured === 'file' || configured === 'memory') {
    return configured;
  }
  return process.env.DATABASE_URL ? 'postgres' : 'file';
}

const driver = resolveDriver();
const pending = new Map<string, PendingRow>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let poolPromise: Promise<Pool> | null = null;
let schemaPromise: Promise<void> | null = null;
let flushing: Promise<void> | null = null;

function isEnabled(): boolean {
  return driver === 'postgres';
}

function resolveSsl(): false | { rejectUnauthorized: boolean } {
  const mode = (process.env.DATABASE_SSL || 'auto').toLowerCase();
  if (mode === 'false' || mode === 'disable' || mode === 'off') return false;
  if (mode === 'true' || mode === 'require') {
    return { rejectUnauthorized: false };
  }
  if (mode === 'verify-full' || mode === 'verify-identity') {
    return { rejectUnauthorized: true };
  }
  const url = process.env.DATABASE_URL || '';
  if (/[?&]sslmode=(require|verify-ca|verify-full)/i.test(url)) {
    return { rejectUnauthorized: false };
  }
  return false;
}

async function getPool(): Promise<Pool> {
  if (!poolPromise) {
    poolPromise = (async () => {
      const url = process.env.DATABASE_URL;
      if (!url) {
        throw new Error('USAGE_STORE=postgres requires DATABASE_URL');
      }
      const pg = await import('pg');
      const PoolCtor = (pg as any).Pool ?? (pg as any).default?.Pool;
      return new PoolCtor({
        connectionString: url,
        ssl: resolveSsl(),
        max: Number(process.env.USAGE_POOL_MAX || 2),
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
        application_name: 'llmadmin-usage',
      });
    })();
  }
  return poolPromise;
}

async function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const pool = await getPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS llmadmin_usage_daily (
          day date NOT NULL,
          provider text NOT NULL,
          total bigint NOT NULL DEFAULT 0,
          success bigint NOT NULL DEFAULT 0,
          failure bigint NOT NULL DEFAULT 0,
          input_tokens bigint NOT NULL DEFAULT 0,
          output_tokens bigint NOT NULL DEFAULT 0,
          cache_input_tokens bigint NOT NULL DEFAULT 0,
          PRIMARY KEY (day, provider)
        )
      `);
    })().catch((e) => {
      schemaPromise = null;
      throw e;
    });
  }
  return schemaPromise;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  const interval = Math.max(
    1000,
    Number(process.env.USAGE_FLUSH_MS || 10_000)
  );
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushUsage();
  }, interval);
  (flushTimer as any)?.unref?.();
}

/**
 * Buffer one request's contribution. Only PostgreSQL mode does anything;
 * file/memory mode keeps the legacy metrics.json behaviour in the log
 * middleware.
 */
export function recordUsageDelta(
  provider: string,
  day: string,
  delta: UsageDelta
): void {
  if (!isEnabled()) return;
  const key = `${day}|${provider}`;
  const current = pending.get(key);
  if (current) {
    current.total += delta.total;
    current.success += delta.success;
    current.failure += delta.failure;
    current.inputTokens += delta.inputTokens;
    current.outputTokens += delta.outputTokens;
    current.cacheInputTokens += delta.cacheInputTokens;
  } else {
    pending.set(key, { day, provider, ...delta });
  }
  scheduleFlush();
}

export async function flushUsage(): Promise<void> {
  if (!isEnabled() || pending.size === 0) return;
  if (flushing) return flushing;

  flushing = (async () => {
    await ensureSchema();
    const rows = Array.from(pending.values());
    pending.clear();

    const values: any[] = [];
    const placeholders = rows.map((row, index) => {
      const base = index * 8;
      values.push(
        row.day,
        row.provider,
        row.total,
        row.success,
        row.failure,
        row.inputTokens,
        row.outputTokens,
        row.cacheInputTokens
      );
      return `($${base + 1}::date, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
    });

    try {
      const pool = await getPool();
      await pool.query(
        `INSERT INTO llmadmin_usage_daily
           (day, provider, total, success, failure, input_tokens, output_tokens, cache_input_tokens)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (day, provider) DO UPDATE SET
           total = llmadmin_usage_daily.total + EXCLUDED.total,
           success = llmadmin_usage_daily.success + EXCLUDED.success,
           failure = llmadmin_usage_daily.failure + EXCLUDED.failure,
           input_tokens = llmadmin_usage_daily.input_tokens + EXCLUDED.input_tokens,
           output_tokens = llmadmin_usage_daily.output_tokens + EXCLUDED.output_tokens,
           cache_input_tokens = llmadmin_usage_daily.cache_input_tokens + EXCLUDED.cache_input_tokens`,
        values
      );
    } catch (e: any) {
      // Put the deltas back so a transient database outage does not lose
      // usage; the next request or flush retries.
      for (const row of rows) {
        const key = `${row.day}|${row.provider}`;
        const existing = pending.get(key);
        if (existing) {
          existing.total += row.total;
          existing.success += row.success;
          existing.failure += row.failure;
          existing.inputTokens += row.inputTokens;
          existing.outputTokens += row.outputTokens;
          existing.cacheInputTokens += row.cacheInputTokens;
        } else {
          pending.set(key, row);
        }
      }
      console.error('[usage] flush failed:', e?.message || e);
      scheduleFlush();
    }
  })().finally(() => {
    flushing = null;
  });

  return flushing;
}

export async function queryUsage(
  from: string,
  to: string
): Promise<MetricsResponse> {
  await flushUsage();
  const pool = await getPool();
  const res = await pool.query(
    `SELECT day::text AS date, provider,
            total, success, failure, input_tokens, output_tokens, cache_input_tokens
       FROM llmadmin_usage_daily
      WHERE day >= $1::date AND day <= $2::date
      ORDER BY day ASC, provider ASC`,
    [from, to]
  );

  const daily = res.rows.map((row: any) => ({
    date: String(row.date),
    provider: String(row.provider),
    totalRequests: Number(row.total),
    successCount: Number(row.success),
    failureCount: Number(row.failure),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheInputTokens: Number(row.cache_input_tokens),
  }));

  const totals = daily.reduce(
    (acc, row) => {
      acc.totalRequests += row.totalRequests;
      acc.successCount += row.successCount;
      acc.failureCount += row.failureCount;
      acc.inputTokens += row.inputTokens;
      acc.outputTokens += row.outputTokens;
      acc.cacheInputTokens += row.cacheInputTokens;
      return acc;
    },
    {
      totalRequests: 0,
      successCount: 0,
      failureCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheInputTokens: 0,
    }
  );

  return { from, to, totals, daily };
}

export function isPostgresUsageStore(): boolean {
  return isEnabled();
}

export async function initUsageStore(): Promise<void> {
  if (!isEnabled()) return;
  await ensureSchema();
}

export async function closeUsageStore(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!isEnabled()) return;
  await flushUsage();
  if (poolPromise) {
    const pool = await poolPromise;
    await pool.end();
    poolPromise = null;
    schemaPromise = null;
  }
}
