import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { buildDemoConfig } from './seed';
import { SessionConfigStore } from './sessionStore';

export const DEMO_COOKIE_NAME = 'llmadmin_demo';
export const DEMO_KEY_PREFIX = 'dms_';

export type DemoSession = {
  id: string;
  ip: string;
  createdAt: number;
  lastSeenAt: number;
  store: SessionConfigStore;
  key: string | null;
  keyHash: string | null;
  keyHint: string | null;
  keyCreatedAt: number | null;
  requests: number;
  windowStartedAt: number;
  windowRequests: number;
};

const sessions = new Map<string, DemoSession>();
const keys = new Map<string, string>(); // sha256(key) -> session id
const sessionsByIp = new Map<string, number>();

function envInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function demoTtlMs(): number {
  return envInt('DEMO_TTL_MINUTES', 30) * 60_000;
}

function maxSessions(): number {
  return envInt('DEMO_MAX_SESSIONS', 200);
}

function maxSessionsPerIp(): number {
  return envInt('DEMO_MAX_SESSIONS_PER_IP', 3);
}

function maxRequestsPerSession(): number {
  return envInt('DEMO_MAX_REQUESTS', 300);
}

function maxRequestsPerMinute(): number {
  return envInt('DEMO_MAX_REQUESTS_PER_MINUTE', 60);
}

function demoSecret(): string {
  const configured = process.env.DEMO_SECRET?.trim();
  if (configured) return configured;
  // Ephemeral secret: sessions simply do not survive a restart. Fine for a
  // single-instance demo, but set DEMO_SECRET in production so a deploy does
  // not invalidate every open tab.
  const globalRef = globalThis as { __llmadminDemoSecret?: string };
  if (!globalRef.__llmadminDemoSecret) {
    globalRef.__llmadminDemoSecret = randomBytes(32).toString('hex');
    console.warn(
      '[demo] DEMO_SECRET is not set; using an ephemeral secret (sessions reset on restart)'
    );
  }
  return globalRef.__llmadminDemoSecret;
}

/** Base URL of the built-in mock upstream used by the seeded providers. */
export function demoMockBaseUrl(): string {
  const configured = process.env.DEMO_MOCK_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  const port = process.env.PORT || '8700';
  return `http://127.0.0.1:${port}/__demo/mock/v1`;
}

function sign(sid: string): string {
  return createHmac('sha256', demoSecret()).update(sid).digest('base64url');
}

export function signSessionCookie(sid: string): string {
  return `${sid}.${sign(sid)}`;
}

/** Verify `<sid>.<hmac>` and return the session id, or null. */
export function verifySessionCookie(value: string | undefined | null): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const sid = value.slice(0, dot);
  const provided = value.slice(dot + 1);
  const expected = sign(sid);
  if (provided.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
      return null;
    }
  } catch {
    return null;
  }
  return sid;
}

export function hashDemoKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function isExpired(session: DemoSession, now: number): boolean {
  return now - session.lastSeenAt > demoTtlMs();
}

function removeSession(session: DemoSession): void {
  sessions.delete(session.id);
  if (session.keyHash) keys.delete(session.keyHash);
  const count = sessionsByIp.get(session.ip) ?? 0;
  if (count <= 1) sessionsByIp.delete(session.ip);
  else sessionsByIp.set(session.ip, count - 1);
}

export type CreateSessionResult =
  | { ok: true; session: DemoSession }
  | { ok: false; reason: 'global_limit' | 'ip_limit' };

export function createDemoSession(ip: string): CreateSessionResult {
  const now = Date.now();
  sweepDemoSessions(now);

  if (sessions.size >= maxSessions()) {
    return { ok: false, reason: 'global_limit' };
  }
  const perIp = sessionsByIp.get(ip) ?? 0;
  if (perIp >= maxSessionsPerIp()) {
    return { ok: false, reason: 'ip_limit' };
  }

  const session: DemoSession = {
    id: randomUUID(),
    ip,
    createdAt: now,
    lastSeenAt: now,
    store: new SessionConfigStore(buildDemoConfig(demoMockBaseUrl())),
    key: null,
    keyHash: null,
    keyHint: null,
    keyCreatedAt: null,
    requests: 0,
    windowStartedAt: now,
    windowRequests: 0,
  };

  sessions.set(session.id, session);
  sessionsByIp.set(ip, perIp + 1);
  return { ok: true, session };
}

export function getDemoSession(sid: string): DemoSession | null {
  const session = sessions.get(sid);
  if (!session) return null;
  const now = Date.now();
  if (isExpired(session, now)) {
    removeSession(session);
    return null;
  }
  session.lastSeenAt = now;
  return session;
}

export function getDemoSessionByKey(key: string | undefined | null): DemoSession | null {
  if (!key || !key.startsWith(DEMO_KEY_PREFIX)) return null;
  const sid = keys.get(hashDemoKey(key));
  if (!sid) return null;
  return getDemoSession(sid);
}

/** Issue (or rotate) the API key for a session. Returns the plaintext once. */
export function issueDemoKey(session: DemoSession): string {
  if (session.keyHash) keys.delete(session.keyHash);
  const key = `${DEMO_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
  session.key = key;
  session.keyHash = hashDemoKey(key);
  session.keyHint = key.slice(-4);
  session.keyCreatedAt = Date.now();
  keys.set(session.keyHash, session.id);
  return key;
}

export function revokeDemoKey(session: DemoSession): void {
  if (session.keyHash) keys.delete(session.keyHash);
  session.key = null;
  session.keyHash = null;
  session.keyHint = null;
  session.keyCreatedAt = null;
}

/** Restore the session's config document to the pristine demo seed. */
export function resetDemoSession(session: DemoSession): void {
  session.store = new SessionConfigStore(buildDemoConfig(demoMockBaseUrl()));
  session.requests = 0;
  session.windowRequests = 0;
  session.windowStartedAt = Date.now();
}

export type BudgetReason = 'session_total' | 'session_rate';

export function consumeDemoBudget(session: DemoSession): { ok: true } | { ok: false; reason: BudgetReason } {
  const now = Date.now();
  if (now - session.windowStartedAt >= 60_000) {
    session.windowStartedAt = now;
    session.windowRequests = 0;
  }
  if (session.requests >= maxRequestsPerSession()) {
    return { ok: false, reason: 'session_total' };
  }
  if (session.windowRequests >= maxRequestsPerMinute()) {
    return { ok: false, reason: 'session_rate' };
  }
  session.requests += 1;
  session.windowRequests += 1;
  return { ok: true };
}

export function demoLimits(): {
  ttlSeconds: number;
  maxRequests: number;
  maxRequestsPerMinute: number;
} {
  return {
    ttlSeconds: Math.floor(demoTtlMs() / 1000),
    maxRequests: maxRequestsPerSession(),
    maxRequestsPerMinute: maxRequestsPerMinute(),
  };
}

export function demoSessionView(
  session: DemoSession,
  gatewayUrl: string
): Record<string, unknown> {
  const limits = demoLimits();
  return {
    ok: true,
    demo: true,
    hasKey: Boolean(session.keyHash),
    apiKey: session.key,
    keyHint: session.keyHint,
    keyCreatedAt: session.keyCreatedAt,
    gatewayUrl,
    expiresAt: new Date(session.lastSeenAt + demoTtlMs()).toISOString(),
    remainingSeconds: Math.max(
      0,
      Math.floor((session.lastSeenAt + demoTtlMs() - Date.now()) / 1000)
    ),
    requestsUsed: session.requests,
    requestsRemaining: Math.max(0, limits.maxRequests - session.requests),
    limits,
  };
}

export function sweepDemoSessions(now = Date.now()): void {
  for (const session of [...sessions.values()]) {
    if (isExpired(session, now)) removeSession(session);
  }
}

let sweeper: ReturnType<typeof setInterval> | null = null;

export function startDemoSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => sweepDemoSessions(), 60_000);
  // Do not keep the event loop alive just for the demo sweeper.
  if (typeof (sweeper as any).unref === 'function') (sweeper as any).unref();
}

export function demoSessionCount(): number {
  return sessions.size;
}
