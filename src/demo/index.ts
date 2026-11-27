import { Context, Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

import { isTruthy } from '../utils/auth';
import { withConfigStore } from '../storage';
import { demoMockApp } from './mockUpstream';
import {
  DEMO_COOKIE_NAME,
  consumeDemoBudget,
  createDemoSession,
  demoMockBaseUrl,
  demoSessionView,
  demoTtlMs,
  getDemoSession,
  getDemoSessionByKey,
  issueDemoKey,
  resetDemoSession,
  revokeDemoKey,
  signSessionCookie,
  startDemoSweeper,
  verifySessionCookie,
  type DemoSession,
} from './session';

export function isDemoMode(): boolean {
  return isTruthy(process.env.DEMO_MODE);
}

export function demoSession(c: Context): DemoSession | undefined {
  return (c as any).get('demoSession');
}

export function demoClientIp(c: Context): string {
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    'unknown'
  );
}

/**
 * Demo sessions may only talk to the built-in mock upstream. Anything else
 * (a public host, a private network address, a cloud metadata endpoint, ...)
 * is rejected before it reaches the config store, so the showcase instance
 * cannot be turned into an open proxy.
 */
export function validateDemoUpstreams(gateway: any): string | null {
  const allowed = (value: unknown): boolean => {
    if (typeof value !== 'string' || !value.trim()) return true;
    return value.trim().replace(/\/+$/, '') === demoMockBaseUrl();
  };

  const providerEntries = gateway?.providers;
  if (providerEntries && typeof providerEntries === 'object') {
    for (const [provider, configs] of Object.entries(providerEntries)) {
      if (!Array.isArray(configs)) continue;
      for (const entry of configs as any[]) {
        for (const field of ['baseUrl', 'baseUrlAnthropic']) {
          if (!allowed(entry?.[field])) {
            return `演示环境只允许使用内置 Mock 上游（${provider}.${field}）`;
          }
        }
      }
    }
  }

  for (const category of ['text', 'image', 'video', 'audio', 'mcp']) {
    const userConfig = gateway?.[category]?.userConfig;
    if (!userConfig || typeof userConfig !== 'object') continue;
    const targets = Array.isArray(userConfig.targets)
      ? userConfig.targets
      : [userConfig];
    for (const target of targets) {
      for (const field of ['custom_host', 'custom_host_anthropic']) {
        if (!allowed(target?.[field])) {
          return '演示环境只允许使用内置 Mock 上游（路由地址不可修改）';
        }
      }
    }
  }

  return null;
}

export function demoGatewayUrl(c: Context): string {
  // Prefer an explicit override, then the platform-provided URL (Render sets
  // RENDER_EXTERNAL_URL for every service), then the incoming request origin.
  // This keeps the string users copy correct behind the platform proxy without
  // any extra configuration.
  const configured =
    process.env.DEMO_PUBLIC_BASE_URL?.trim() ||
    process.env.RENDER_EXTERNAL_URL?.trim();
  const base = configured
    ? configured.replace(/\/+$/, '')
    : new URL(c.req.url).origin;
  return `${base}/v1`;
}

function isSecureRequest(c: Context): boolean {
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  return proto === 'https' || new URL(c.req.url).protocol === 'https:';
}

function setDemoCookie(c: Context, sid: string): void {
  setCookie(c, DEMO_COOKIE_NAME, signSessionCookie(sid), {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecureRequest(c),
    // Cookie outlives the sliding session slightly so an active tab can
    // always refresh it; the server still enforces the real TTL.
    maxAge: Math.floor(demoTtlMs() / 1000) + 600,
  });
}

function bearerToken(c: Context): string {
  const header = c.req.header('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match) return match[1].trim();
  return (c.req.header('x-api-key') || '').trim();
}

/**
 * Resolve the demo sandbox for a request and scope storage to it.
 *
 * `/v1/*` authenticates with the per-session API key, everything else with the
 * signed session cookie. Requests without a valid identity fall through so the
 * regular auth layers can answer (or so static assets keep working).
 */
export async function demoMiddleware(c: Context, next: any): Promise<any> {
  if (!isDemoMode()) return next();

  const path = c.req.path;
  // The mock upstream is called by the gateway itself, without a user identity.
  if (path.startsWith('/__demo/')) return next();

  let session: DemoSession | null = null;
  if (path === '/v1' || path.startsWith('/v1/')) {
    session = getDemoSessionByKey(bearerToken(c));
  } else {
    const sid = verifySessionCookie(getCookie(c, DEMO_COOKIE_NAME));
    session = sid ? getDemoSession(sid) : null;
  }

  if (!session) return next();

  (c as any).set('demoSession', session);
  if (path === '/v1' || path.startsWith('/v1/')) {
    setDemoCookie(c, session.id);
  }
  return withConfigStore(session.store, () => next());
}

/** `/demo` entry point plus the internal mock upstream. */
/** Gate for `/v1/*` in demo mode: per-session key plus request budget. */
export function demoV1Authorize(c: Context): Response | null {
  const session = demoSession(c);
  if (!session) {
    return c.json(
      {
        error: {
          message:
            '还没有可用的演示密钥：请先在 Demo 页面点击「生成演示 Key」。',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      },
      401
    );
  }
  const budget = consumeDemoBudget(session);
  if (!budget.ok) {
    const message =
      budget.reason === 'session_total'
        ? '这次演示的请求额度已用完，刷新页面可以重新开始。'
        : '请求太频繁了，请稍等几秒再试。';
    return c.json(
      {
        error: {
          message,
          type: 'rate_limit_error',
          code: budget.reason === 'session_total' ? 'demo_budget_exhausted' : 'demo_rate_limited',
        },
      },
      429
    );
  }
  return null;
}

export function registerDemoRoutes(app: Hono): void {
  app.get('/demo', (c) => {
    const sid = verifySessionCookie(getCookie(c, DEMO_COOKIE_NAME));
    let session = sid ? getDemoSession(sid) : null;

    if (!session) {
      const created = createDemoSession(demoClientIp(c));
      if (!created.ok) {
        const message =
          created.reason === 'ip_limit'
            ? '这个 IP 已经打开了太多演示会话，请稍后再试，或先关闭旧标签页。'
            : '演示环境当前人数已满，请稍后再试。';
        return c.json(
          { ok: false, code: `demo_${created.reason}`, message },
          429
        );
      }
      session = created.session;
    }

    setDemoCookie(c, session.id);
    // `?key=1` opens the key panel straight away (used by the landing CTA),
    // plain visits land on the routing page.
    const wantsKey = c.req.query('key');
    return c.redirect(`/public/admin/${wantsKey ? '?key=1' : ''}`);
  });

  app.route('/__demo/mock', demoMockApp);
  startDemoSweeper();
}

/**
 * `/admin/session*` endpoints. They sit behind the regular admin auth, which
 * accepts the demo cookie in demo mode.
 */
export function registerDemoAdminRoutes(adminApp: Hono): void {
  const guard = (c: Context): DemoSession | Response => {
    const session = demoSession(c);
    if (!session) {
      return c.json(
        {
          ok: false,
          code: 'demo_session_required',
          message: '演示会话已过期，请重新打开 Demo 页面。',
        },
        401
      );
    }
    return session;
  };

  adminApp.get('/session', (c) => {
    const session = guard(c);
    if (session instanceof Response) return session;
    return c.json(demoSessionView(session, demoGatewayUrl(c)));
  });

  adminApp.post('/session/key', (c) => {
    const session = guard(c);
    if (session instanceof Response) return session;
    const apiKey = issueDemoKey(session);
    return c.json({
      ok: true,
      apiKey,
      gatewayUrl: demoGatewayUrl(c),
      keyHint: session.keyHint,
      expiresAt: new Date(session.lastSeenAt + demoTtlMs()).toISOString(),
    });
  });

  adminApp.delete('/session/key', (c) => {
    const session = guard(c);
    if (session instanceof Response) return session;
    revokeDemoKey(session);
    return c.json({ ok: true, hasKey: false });
  });

  adminApp.post('/session/reset', (c) => {
    const session = guard(c);
    if (session instanceof Response) return session;
    resetDemoSession(session);
    return c.json(demoSessionView(session, demoGatewayUrl(c)));
  });
}
