import type { Pool } from 'pg';

import {
  ConfigConflictError,
  type ConfigStore,
  type LoadedConfig,
  type UnifiedConfig,
} from '../configStore';

function resolveSsl(
  connectionString: string
): false | { rejectUnauthorized: boolean } {
  const mode = (process.env.DATABASE_SSL || 'auto').toLowerCase();
  if (mode === 'false' || mode === 'disable' || mode === 'off') return false;
  if (mode === 'true' || mode === 'require') {
    return { rejectUnauthorized: false };
  }
  if (mode === 'verify-full' || mode === 'verify-identity') {
    return { rejectUnauthorized: true };
  }

  // auto: honour an explicit sslmode in the URL, otherwise stay unencrypted
  // for local/Render-internal connections. Managed providers such as Neon or
  // Supabase normally need DATABASE_SSL=true.
  if (/[?&]sslmode=(require|verify-ca|verify-full)/i.test(connectionString)) {
    return { rejectUnauthorized: false };
  }
  return false;
}

/**
 * PostgreSQL driver used by the Render / web deployment.
 *
 * `llmadmin_config` holds one JSONB document plus a monotonically increasing
 * version. Conditional writes use `UPDATE ... WHERE version = $expected`, which
 * gives us optimistic concurrency without a table lock.
 */
export class PostgresConfigStore implements ConfigStore {
  readonly driver = 'postgres' as const;
  readonly readOnly = false;

  private poolPromise: Promise<Pool> | null = null;
  private schemaPromise: Promise<void> | null = null;

  constructor(private readonly connectionString: string) {}

  private async pool(): Promise<Pool> {
    if (!this.poolPromise) {
      this.poolPromise = (async () => {
        const pg = await import('pg');
        const PoolCtor = (pg as any).Pool ?? (pg as any).default?.Pool;
        if (!PoolCtor) {
          throw new Error('The "pg" package is not available');
        }
        return new PoolCtor({
          connectionString: this.connectionString,
          ssl: resolveSsl(this.connectionString),
          max: Number(process.env.DATABASE_POOL_MAX || 5),
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 10_000,
          application_name: 'llmadmin-gateway',
        });
      })();
    }
    return this.poolPromise;
  }

  private async ensureSchema(): Promise<void> {
    if (!this.schemaPromise) {
      this.schemaPromise = (async () => {
        const pool = await this.pool();
        await pool.query(`
          CREATE TABLE IF NOT EXISTS llmadmin_config (
            id text PRIMARY KEY,
            doc jsonb NOT NULL,
            version bigint NOT NULL DEFAULT 1,
            updated_at timestamptz NOT NULL DEFAULT now()
          )
        `);
        await pool.query(`
          CREATE TABLE IF NOT EXISTS llmadmin_meta (
            key text PRIMARY KEY,
            value text NOT NULL
          )
        `);
        await pool.query(
          `INSERT INTO llmadmin_meta (key, value) VALUES ('schema_version', '1')
           ON CONFLICT (key) DO NOTHING`
        );
      })().catch((e) => {
        // Allow a later request to retry after a transient database outage.
        this.schemaPromise = null;
        throw e;
      });
    }
    return this.schemaPromise;
  }

  async load(): Promise<LoadedConfig | null> {
    await this.ensureSchema();
    const pool = await this.pool();
    const res = await pool.query(
      'SELECT doc, version::text AS version FROM llmadmin_config WHERE id = $1',
      ['default']
    );
    if (res.rowCount === 0) return null;
    return {
      doc: res.rows[0].doc as UnifiedConfig,
      version: String(res.rows[0].version),
    };
  }

  async save(
    doc: UnifiedConfig,
    expectedVersion?: string
  ): Promise<{ version: string }> {
    await this.ensureSchema();
    const pool = await this.pool();
    const json = JSON.stringify(doc);

    if (expectedVersion) {
      const updated = await pool.query(
        `UPDATE llmadmin_config
            SET doc = $2::jsonb, version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $3::bigint
          RETURNING version::text AS version`,
        ['default', json, expectedVersion]
      );
      if ((updated.rowCount ?? 0) > 0) {
        return { version: String(updated.rows[0].version) };
      }

      // A brand-new store has no row yet. The in-memory cache represents that
      // state with version "0", so allow the first conditional write to insert.
      if (expectedVersion === '0') {
        const inserted = await pool.query(
          `INSERT INTO llmadmin_config (id, doc, version)
           VALUES ($1, $2::jsonb, 1)
           ON CONFLICT (id) DO NOTHING
           RETURNING version::text AS version`,
          ['default', json]
        );
        if ((inserted.rowCount ?? 0) > 0) {
          return { version: String(inserted.rows[0].version) };
        }
      }

      const current = await this.load();
      throw new ConfigConflictError(undefined, current?.version);
    }

    const upserted = await pool.query(
      `INSERT INTO llmadmin_config (id, doc, version)
       VALUES ($1, $2::jsonb, 1)
       ON CONFLICT (id) DO UPDATE
         SET doc = EXCLUDED.doc,
             version = llmadmin_config.version + 1,
             updated_at = now()
       RETURNING version::text AS version`,
      ['default', json]
    );
    return { version: String(upserted.rows[0].version) };
  }

  async close(): Promise<void> {
    if (!this.poolPromise) return;
    const pool = await this.poolPromise;
    await pool.end();
    this.poolPromise = null;
    this.schemaPromise = null;
  }
}
