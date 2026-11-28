/**
 * Demo analytics.
 *
 * Events are buffered in memory and flushed as one small batch to a collector
 * endpoint (the landing site's Cloudflare Function writing into KV). The demo
 * is a single process, so an interval flush keeps KV writes low and never
 * blocks a visitor request: failures are swallowed and the batch is dropped.
 *
 * Configure with DEMO_ANALYTICS_URL / DEMO_ANALYTICS_TOKEN. When the URL is
 * absent this module is a no-op, so self-hosted demos stay fully local.
 */

export type DemoAnalyticsEvent = {
  name: string;
  ts: number;
  props?: Record<string, unknown>;
};

const queue: DemoAnalyticsEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

function analyticsUrl(): string {
  return process.env.DEMO_ANALYTICS_URL?.trim() || '';
}

function analyticsToken(): string {
  return process.env.DEMO_ANALYTICS_TOKEN?.trim() || '';
}

function flushIntervalMs(): number {
  const parsed = Number(process.env.DEMO_ANALYTICS_FLUSH_MS);
  return Number.isFinite(parsed) && parsed >= 10_000 ? parsed : 10 * 60_000;
}

function maxQueue(): number {
  const parsed = Number(process.env.DEMO_ANALYTICS_MAX_QUEUE);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 500;
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flushDemoEvents();
  }, flushIntervalMs());
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
}

/** Record one demo event; safe to call from request paths (never throws). */
export function trackDemoEvent(
  name: string,
  props?: Record<string, unknown>
): void {
  if (!analyticsUrl()) return;
  if (queue.length >= maxQueue()) queue.shift();
  queue.push({ name, ts: Date.now(), props });
  if (queue.length >= 100) void flushDemoEvents();
  else schedule();
}

/** Send whatever is buffered. Exposed for tests and graceful shutdown. */
export async function flushDemoEvents(): Promise<void> {
  const url = analyticsUrl();
  if (!url || flushing || queue.length === 0) return;

  flushing = true;
  const batch = queue.splice(0, queue.length);
  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    const token = analyticsToken();
    if (token) headers.authorization = `Bearer ${token}`;
    await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: 'llmadmin-demo', events: batch }),
    });
  } catch {
    // Best effort: dropping a batch is better than growing memory forever.
  } finally {
    flushing = false;
    if (queue.length > 0) schedule();
  }
}
