import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import { getUsage } from './billing';
import { metricsStore } from '../middlewares/log';
import Providers from '../providers/index';
import {
  clearGatewayConfig,
  getDefaultUiConfig,
  loadUiConfig,
  loadUnifiedConfig,
  normalizeUiConfig,
  replaceUnifiedConfig,
  saveUnifiedConfig,
} from './config/store';
import {
  formatZodError,
  parseGateway,
  parseUnifiedConfig,
} from './config/schema';
import {
  listPlugins,
  setPluginEnabled,
  setPluginCredentials,
  setPresetEnabled,
} from './plugins';
import { clearHandlerCache } from '../../plugins';

import {
  ensureConfigLoaded,
  getConfigVersion,
  getStorageDriver,
  isConfigReadOnly,
  ConfigConflictError,
  ConfigReadOnlyError,
} from '../storage';
import {
  isPostgresUsageStore,
  queryUsage,
} from '../storage/usageStore';
import { assertSafeProviderUrl } from '../utils/urlSafety';
import {
  isProduction,
  parseTokenList,
  safeEqual,
  tryParseBearerToken,
} from '../utils/auth';

import { ProviderId } from './types';

const adminApp = new Hono();

function getAdminToken(c: any): string {
  const fromEnv = c?.env?.ADMIN_TOKEN;
  return String(fromEnv ?? process.env.ADMIN_TOKEN ?? '').trim();
}

function isAdminAuthDisabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    (process.env.ADMIN_AUTH_DISABLED || '').toLowerCase()
  );
}

function allowedAdminOrigins(): string[] {
  const configured = parseTokenList(process.env.ADMIN_CORS_ORIGINS);
  if (isProduction()) return configured;
  return [
    ...configured,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:8700',
    'http://127.0.0.1:8700',
  ];
}

function getSelfOrigin(c: any): string {
  const url = new URL(c.req.url);
  const proto =
    c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() ||
    url.protocol.replace(':', '');
  const host =
    c.req.header('x-forwarded-host')?.split(',')[0]?.trim() ||
    c.req.header('host') ||
    url.host;
  return `${proto}://${host}`;
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

function isAllowedAdminOrigin(origin: string, c: any): boolean {
  return (
    origin === getSelfOrigin(c) ||
    (!isProduction() && isLoopbackOrigin(origin)) ||
    allowedAdminOrigins().includes(origin)
  );
}

function applyAdminCors(c: any): void {
  const origin = c.req.header('origin');
  if (!origin) return;
  if (isAllowedAdminOrigin(origin, c)) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
    c.header(
      'Access-Control-Allow-Headers',
      'Content-Type,Authorization,X-Admin-Token,If-Match'
    );
    c.header('Access-Control-Expose-Headers', 'ETag');
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Vary', 'Origin');
  }
}

function getExpectedVersion(c: any): string | undefined {
  const raw = c.req.header('if-match');
  if (!raw) return undefined;
  const cleaned = raw.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  return cleaned || undefined;
}

async function adminAuth(c: any, next: any) {
  const origin = c.req.header('origin');
  applyAdminCors(c);
  if (c.req.method === 'OPTIONS') return c.body(null, 204);

  // A cross-origin write from an origin we do not trust is rejected even if it
  // somehow acquired the token. Requests without Origin (curl, server-side)
  // are allowed and still require the bearer token.
  if (origin && !isAllowedAdminOrigin(origin, c)) {
    return c.json({ ok: false, message: 'Origin not allowed' }, 403);
  }

  const expected = getAdminToken(c);
  if (!expected) {
    if (isProduction() && !isAdminAuthDisabled()) {
      return c.json(
        {
          ok: false,
          code: 'admin_token_not_configured',
          message:
            'ADMIN_TOKEN is not configured. Set it in the environment (or explicitly set ADMIN_AUTH_DISABLED=true for local use).',
        },
        503
      );
    }
    return next();
  }

  const bearer = tryParseBearerToken(c.req.header('authorization'));
  const provided = bearer || c.req.header('x-admin-token') || '';
  if (!(await safeEqual(provided, expected))) {
    return c.json(
      { ok: false, code: 'unauthorized', message: 'Unauthorized' },
      401
    );
  }

  return next();
}

// Health/readiness must stay unauthenticated for platform checks.
adminApp.get('/health', (c) => {
  // The desktop webview runs on a random localhost port and calls this URL
  // cross-origin; without CORS headers useBackendHealth shows "disconnected"
  // even when the gateway is healthy.
  applyAdminCors(c);
  const adminToken = getAdminToken(c);
  const gatewayKeys = parseTokenList(process.env.GATEWAY_API_KEY);
  return c.json({
    ok: true,
    authRequired: Boolean(adminToken),
    setupRequired:
      isProduction() && !adminToken && !isAdminAuthDisabled(),
    gatewayAuthRequired: gatewayKeys.length > 0 || isProduction(),
    storage: (() => {
      try {
        return getStorageDriver();
      } catch {
        return 'unavailable';
      }
    })(),
    version: getConfigVersion(),
    readOnly: (() => {
      try {
        return isConfigReadOnly();
      } catch {
        return false;
      }
    })(),
  });
});

adminApp.get('/ready', async (c) => {
  applyAdminCors(c);
  try {
    await ensureConfigLoaded({ force: true });
    return c.json({
      ok: true,
      storage: getStorageDriver(),
      version: getConfigVersion(),
    });
  } catch (e: any) {
    return c.json(
      {
        ok: false,
        storage: 'down',
        message: e?.message || 'Storage is not ready',
      },
      503
    );
  }
});

adminApp.use('*', adminAuth);
adminApp.use(
  '*',
  bodyLimit({
    maxSize: Number(process.env.ADMIN_MAX_BODY_BYTES || 2 * 1024 * 1024),
    onError: (c) =>
      c.json(
        { ok: false, code: 'payload_too_large', message: 'Request body too large' },
        413
      ),
  })
);

// ---------------------------------------------------------------------------
// Config API
// ---------------------------------------------------------------------------

function validateProviderUrls(gateway: any): string | null {
  const providers = gateway?.providers;
  if (!providers || typeof providers !== 'object') return null;
  for (const [provider, configs] of Object.entries(providers)) {
    if (!Array.isArray(configs)) continue;
    for (const entry of configs) {
      if (!entry || typeof entry !== 'object') continue;
      for (const field of ['baseUrl', 'baseUrlAnthropic'] as const) {
        const value = (entry as any)[field];
        if (typeof value !== 'string' || !value.trim()) continue;
        try {
          assertSafeProviderUrl(value, `${provider}.${field}`);
        } catch (e: any) {
          return e?.message || `${provider}.${field} is not allowed`;
        }
      }
    }
  }
  return null;
}

function configResponse(doc: Record<string, any>, version: string) {
  return {
    ok: true,
    existed: version !== '0',
    config: normalizeUiConfig(doc.gateway),
    unified: doc,
    version,
  };
}

adminApp.get('/config', async (c) => {
  const { doc, version } = await loadUnifiedConfig();
  const response = configResponse(doc, version);
  c.header('ETag', `"${version}"`);
  return c.json(response);
});

adminApp.put('/config', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json(
      { ok: false, code: 'invalid_body', message: 'Body must be a JSON object' },
      400
    );
  }

  const expected = getExpectedVersion(c);

  try {
    const looksUnified =
      'gateway' in (body as any) ||
      'settings' in (body as any) ||
      'server' in (body as any);

    if (looksUnified) {
      const parsed = parseUnifiedConfig(body);
      const urlError = validateProviderUrls(parsed.gateway);
      if (urlError) {
        return c.json(
          { ok: false, code: 'unsafe_provider_url', message: urlError },
          400
        );
      }
      await saveUnifiedConfig(parsed as Record<string, any>, expected);
      if (parsed.settings) clearHandlerCache();
    } else {
      const gateway = parseGateway(body);
      const urlError = validateProviderUrls(gateway);
      if (urlError) {
        return c.json(
          { ok: false, code: 'unsafe_provider_url', message: urlError },
          400
        );
      }
      await saveUnifiedConfig({ gateway } as Record<string, any>, expected);
    }

    const { doc, version } = await loadUnifiedConfig();
    c.header('ETag', `"${version}"`);
    return c.json(configResponse(doc, version));
  } catch (e: any) {
    if (e instanceof z.ZodError) {
      return c.json(
        {
          ok: false,
          code: 'invalid_config',
          message: formatZodError(e),
        },
        400
      );
    }
    if (e instanceof ConfigConflictError) {
      return c.json(
        {
          ok: false,
          code: 'config_conflict',
          message: e.message,
          version: e.currentVersion,
        },
        409
      );
    }
    if (e instanceof ConfigReadOnlyError) {
      return c.json(
        { ok: false, code: 'read_only', message: e.message },
        403
      );
    }
    throw e;
  }
});

adminApp.delete('/config', async (c) => {
  const category = c.req.query('category');
  const validCategories = ['text', 'image', 'video', 'audio', 'mcp'];
  if (category && !validCategories.includes(category)) {
    return c.json(
      {
        ok: false,
        code: 'invalid_category',
        message: `category must be one of ${validCategories.join(', ')}`,
      },
      400
    );
  }

  try {
    const gateway = await clearGatewayConfig(category as any);
    const { doc, version } = await loadUnifiedConfig();
    c.header('ETag', `"${version}"`);
    return c.json({
      ok: true,
      config: gateway,
      unified: doc,
      version,
    });
  } catch (e: any) {
    if (e instanceof ConfigReadOnlyError) {
      return c.json({ ok: false, code: 'read_only', message: e.message }, 403);
    }
    throw e;
  }
});

function redactUnifiedConfig(doc: Record<string, any>): Record<string, any> {
  const clone = structuredClone(doc);
  const gateway = clone.gateway;
  if (gateway?.providers && typeof gateway.providers === 'object') {
    for (const configs of Object.values(gateway.providers)) {
      if (!Array.isArray(configs)) continue;
      for (const entry of configs) {
        if (entry && typeof entry === 'object' && entry.apiKey) {
          entry.apiKey = '***redacted***';
        }
      }
    }
  }
  const credentials = clone.settings?.credentials;
  if (credentials && typeof credentials === 'object') {
    for (const key of Object.keys(credentials)) {
      credentials[key] = Object.fromEntries(
        Object.keys(credentials[key] || {}).map((field) => [
          field,
          '***redacted***',
        ])
      );
    }
  }
  return clone;
}

adminApp.get('/config/export', async (c) => {
  const { doc } = await loadUnifiedConfig();
  const redact = c.req.query('redact') === 'true';
  const config = redact ? redactUnifiedConfig(doc) : doc;
  if (c.req.query('download') === '1') {
    c.header(
      'Content-Disposition',
      'attachment; filename="llm-admin-conf.json"'
    );
  }
  return c.json({ ok: true, config });
});

adminApp.post('/config/import', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json(
      { ok: false, code: 'invalid_body', message: 'Body must be a JSON object' },
      400
    );
  }

  const raw = (body as any).config ?? body;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return c.json(
      { ok: false, code: 'invalid_config', message: 'config must be an object' },
      400
    );
  }

  try {
    const looksUnified =
      'gateway' in raw || 'settings' in raw || 'server' in raw;
    const parsed = looksUnified
      ? parseUnifiedConfig(raw)
      : ({ gateway: parseGateway(raw) } as Record<string, any>);

    const urlError = validateProviderUrls(parsed.gateway);
    if (urlError) {
      return c.json(
        { ok: false, code: 'unsafe_provider_url', message: urlError },
        400
      );
    }

    await replaceUnifiedConfig(parsed as Record<string, any>, getExpectedVersion(c));
    if (parsed.settings) clearHandlerCache();

    const { version } = await loadUnifiedConfig();
    c.header('ETag', `"${version}"`);
    return c.json({ ok: true, version });
  } catch (e: any) {
    if (e instanceof z.ZodError) {
      return c.json(
        { ok: false, code: 'invalid_config', message: formatZodError(e) },
        400
      );
    }
    if (e instanceof ConfigConflictError) {
      return c.json(
        { ok: false, code: 'config_conflict', message: e.message },
        409
      );
    }
    if (e instanceof ConfigReadOnlyError) {
      return c.json({ ok: false, code: 'read_only', message: e.message }, 403);
    }
    throw e;
  }
});

// Desktop-only helper; the browser build downloads the export endpoint instead.
adminApp.post('/config/export-file', (c) =>
  c.json(
    {
      ok: false,
      code: 'not_supported',
      message:
        'Server-side file export is not available in web mode; use GET /admin/config/export',
    },
    501
  )
);

const UsageQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  provider: z.string().optional(),
});

adminApp.get('/usage', async (c) => {
  const from = c.req.query('from');
  const to = c.req.query('to');
  const providerParam = c.req.query('provider');
  const parsed = UsageQuerySchema.safeParse({
    from,
    to,
    provider: providerParam ?? undefined,
  });
  if (!parsed.success) {
    return c.json(
      { ok: false, message: 'Invalid query', issues: parsed.error.issues },
      400
    );
  }

  const provider = parsed.data.provider;
  const res = await getUsage({
    provider,
    from: parsed.data.from,
    to: parsed.data.to,
  });
  return c.json(res);
});

const MetricsQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

adminApp.get('/metrics', async (c) => {
  const from = c.req.query('from');
  const to = c.req.query('to');
  const parsed = MetricsQuerySchema.safeParse({ from, to });
  if (!parsed.success) {
    return c.json(
      { ok: false, message: 'Invalid query', issues: parsed.error.issues },
      400
    );
  }

  if (isPostgresUsageStore()) {
    try {
      return c.json(await queryUsage(parsed.data.from, parsed.data.to));
    } catch (e: any) {
      return c.json(
        {
          ok: false,
          code: 'usage_unavailable',
          message: e?.message || 'Usage store is unavailable',
        },
        503
      );
    }
  }

  const fromDate = new Date(parsed.data.from);
  const toDate = new Date(parsed.data.to);
  toDate.setDate(toDate.getDate() + 1);

  type DailyProviderRow = {
    date: string;
    provider: string;
    totalRequests: number;
    successCount: number;
    failureCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheInputTokens: number;
  };
  const daily: DailyProviderRow[] = [];

  let totalRequests = 0;
  let successCount = 0;
  let failureCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheInputTokens = 0;

  metricsStore.forEach((dailyProviders, dateKey) => {
    const d = new Date(dateKey);
    if (d >= fromDate && d < toDate) {
      dailyProviders.forEach((metrics, provider) => {
        totalRequests += metrics.total;
        successCount += metrics.success;
        failureCount += metrics.failure;
        inputTokens += metrics.inputTokens;
        outputTokens += metrics.outputTokens;
        cacheInputTokens += metrics.cacheInputTokens;
        daily.push({
          date: dateKey,
          provider,
          totalRequests: metrics.total,
          successCount: metrics.success,
          failureCount: metrics.failure,
          inputTokens: metrics.inputTokens,
          outputTokens: metrics.outputTokens,
          cacheInputTokens: metrics.cacheInputTokens,
        });
      });
    }
  });

  daily.sort((a, b) => {
    const dateCmp = a.date.localeCompare(b.date);
    return dateCmp !== 0 ? dateCmp : a.provider.localeCompare(b.provider);
  });

  return c.json({
    from: parsed.data.from,
    to: parsed.data.to,
    totals: {
      totalRequests,
      successCount,
      failureCount,
      inputTokens,
      outputTokens,
      cacheInputTokens,
    },
    daily,
  });
});

function resolveBackendProvider(provider: string): string {
  if (provider === 'openai-compatible') return 'openai';
  if (provider === 'anthropic-compatible') return 'anthropic';
  return provider;
}

adminApp.post('/providers/:provider/test-connectivity', async (c) => {
  const provider = c.req.param('provider') as ProviderId;
  const body = await c.req.json().catch(() => ({}));

  const providerConfig = Providers[resolveBackendProvider(provider)];
  if (!providerConfig?.api) {
    return c.json({ ok: false, message: 'Unknown provider' }, 404);
  }

  const { apiKey, baseUrl, baseUrlAnthropic, configId } = body as {
    apiKey?: string;
    baseUrl?: string;
    baseUrlAnthropic?: string;
    configId?: string;
  };

  let resolvedApiKey = apiKey?.trim();
  let resolvedBaseUrl = baseUrl?.trim();
  let resolvedBaseUrlAnthropic = baseUrlAnthropic?.trim();

  if (!resolvedApiKey && configId) {
    const uiConfig = await loadUiConfig();
    for (const providerConfigs of Object.values(uiConfig.providers)) {
      const matched = providerConfigs?.find((cfg) => cfg.id === configId);
      if (matched) {
        resolvedApiKey = matched.apiKey?.trim();
        if (!resolvedBaseUrl) resolvedBaseUrl = matched.baseUrl?.trim();
        if (!resolvedBaseUrlAnthropic)
          resolvedBaseUrlAnthropic = matched.baseUrlAnthropic?.trim();
        break;
      }
    }
  }

  if (!resolvedApiKey) {
    return c.json({ ok: false, message: 'API key is required' }, 400);
  }

  const testConnectivity = async (
    resolvedBaseUrl: string | undefined,
    label: string
  ): Promise<{ ok: boolean; message: string }> => {
    if (!resolvedBaseUrl) {
      return { ok: false, message: `${label} URL is required` };
    }

    try {
      assertSafeProviderUrl(resolvedBaseUrl, `${label} URL`);
    } catch (e: any) {
      return { ok: false, message: e?.message || `${label} URL is not allowed` };
    }

    const providerOptions = {
      apiKey: resolvedApiKey,
      customHost: resolvedBaseUrl,
    };

    try {
      const endpoint = providerConfig.api.getEndpoint({
        c: c,
        providerOptions,
        fn: 'listModels',
        gatewayRequestBodyJSON: {},
        gatewayRequestBody: {},
        gatewayRequestURL: resolvedBaseUrl + '/models',
      });

      const url = resolvedBaseUrl + endpoint;
      const headers = await providerConfig.api.headers({
        c: c,
        providerOptions,
        fn: 'listModels',
        transformedRequestBody: {},
        transformedRequestUrl: url,
        gatewayRequestBody: {},
        headers: {},
      });

      const response = await fetch(url, { headers });

      if (response.ok) {
        return { ok: true, message: 'Connected successfully' };
      }

      if (response.status === 401 || response.status === 403) {
        return { ok: false, message: 'Authentication failed — invalid API key' };
      }

      const errData: any = await response.json().catch(() => ({}));
      return {
        ok: false,
        message: errData.error?.message || `HTTP ${response.status}`,
      };
    } catch (err: any) {
      return { ok: false, message: err.message };
    }
  };

  const tests: Promise<{ ok: boolean; message: string }>[] = [
    testConnectivity(resolvedBaseUrl, 'OpenAI'),
  ];
  if (resolvedBaseUrlAnthropic) {
    tests.push(testConnectivity(resolvedBaseUrlAnthropic, 'Anthropic'));
  }
  const results = await Promise.all(tests);

  const ok = results.some((r) => r.ok);

  return c.json({
    ok,
    openai: resolvedBaseUrl ? results[0] : undefined,
    anthropic: resolvedBaseUrlAnthropic ? results[1] : undefined,
  });
});

adminApp.get('/provider-models', async (c) => {
  const provider = c.req.query('provider') as ProviderId;
  const configId = c.req.query('configId');

  const providerConfig = Providers[resolveBackendProvider(provider)];
  if (!providerConfig?.api) {
    return c.json({ object: 'list', data: [] }, 200);
  }

  const uiConfig = await loadUiConfig();
  let resolvedApiKey = '';
  let resolvedBaseUrl = '';

  for (const providerConfigs of Object.values(uiConfig.providers)) {
    const matched = providerConfigs?.find((cfg: any) => cfg.id === configId);
    if (matched) {
      resolvedApiKey = matched.apiKey?.trim() || '';
      resolvedBaseUrl = matched.baseUrl?.trim() || '';
      break;
    }
  }

  if (!resolvedApiKey) {
    return c.json({ object: 'list', data: [] }, 200);
  }

  try {
    assertSafeProviderUrl(resolvedBaseUrl, 'Provider URL');
  } catch {
    return c.json({ object: 'list', data: [] }, 200);
  }

  const providerOptions = {
    apiKey: resolvedApiKey,
    customHost: resolvedBaseUrl,
  };

  try {
    const endpoint = providerConfig.api.getEndpoint({
      c,
      providerOptions,
      fn: 'listModels',
      gatewayRequestBodyJSON: {},
      gatewayRequestBody: {},
      gatewayRequestURL: (resolvedBaseUrl || '') + '/models',
    });

    const url = (resolvedBaseUrl || '') + endpoint;
    const headers = await providerConfig.api.headers({
      c,
      providerOptions,
      fn: 'listModels',
      transformedRequestBody: {},
      transformedRequestUrl: url,
      gatewayRequestBody: {},
      headers: {},
    });

    const response = await fetch(url, { headers });
    const json = await response.json();
    return c.json(json);
  } catch {
    return c.json({ object: 'list', data: [] }, 200);
  }
});

adminApp.get('/plugins', async (c) => {
  const plugins = await listPlugins();
  return c.json({ plugins });
});

const SetPluginEnabledSchema = z.object({
  enabled: z.boolean(),
});

adminApp.put('/plugins/:id/enabled', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = SetPluginEnabledSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { ok: false, message: 'Invalid request', issues: parsed.error.issues },
      400,
    );
  }
  const result = await setPluginEnabled(id, parsed.data.enabled);
  return c.json(result);
});

const SetPluginCredentialsSchema = z.object({
  credentials: z.record(z.string(), z.string()).default({}),
});

adminApp.put('/plugins/:id/credentials', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = SetPluginCredentialsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { ok: false, message: 'Invalid request', issues: parsed.error.issues },
      400,
    );
  }
  const result = await setPluginCredentials(id, parsed.data.credentials);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// Preset security bundles - toggled within the default plugin modal.
// ---------------------------------------------------------------------------

const SetPluginPresetEnabledSchema = z.object({
  enabled: z.boolean(),
});

adminApp.put('/plugins/:pluginId/presets/:presetId', async (c) => {
  const pluginId = c.req.param('pluginId');
  const presetId = c.req.param('presetId');
  const body = await c.req.json().catch(() => ({}));
  const parsed = SetPluginPresetEnabledSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { ok: false, message: 'Invalid request', issues: parsed.error.issues },
      400,
    );
  }
  const result = await setPresetEnabled(pluginId, presetId, parsed.data.enabled);
  return c.json(result);
});

export { adminApp };