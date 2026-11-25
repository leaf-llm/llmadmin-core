process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.NODE_ENV = 'test';

jest.mock('./plugins', () => ({
  listPlugins: jest.fn(async () => []),
  setPluginEnabled: jest.fn(async () => ({ ok: true })),
  setPluginCredentials: jest.fn(async () => ({ ok: true })),
  setPresetEnabled: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../../plugins', () => ({
  clearHandlerCache: jest.fn(),
}));

import { adminApp } from './routes';
import { resetConfigStore } from '../storage';
import { MemoryConfigStore } from '../storage/adapters/memoryConfigStore';

const AUTH = { Authorization: 'Bearer test-admin-token' };

async function json(res: Response) {
  return res.json() as Promise<any>;
}

describe('admin config API', () => {
  beforeEach(() => {
    resetConfigStore(new MemoryConfigStore());
  });

  it('keeps health unauthenticated and advertises auth', async () => {
    const res = await adminApp.request('/health');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.authRequired).toBe(true);
  });

  it('rejects unauthenticated config access', async () => {
    const res = await adminApp.request('/config');
    expect(res.status).toBe(401);
  });

  it('allows same-origin admin writes (browser Origin header)', async () => {
    const res = await adminApp.request('/config', {
      method: 'PUT',
      headers: {
        ...AUTH,
        'Content-Type': 'application/json',
        Origin: 'http://localhost',
      },
      body: JSON.stringify({
        providers: {},
        text: { routing: [], userConfig: null },
        image: { routing: [], userConfig: null },
        video: { routing: [], userConfig: null },
        audio: { routing: [], userConfig: null },
        mcp: { routing: [], userConfig: null },
      }),
    });
    expect(res.status).toBe(200);
  });

  it('fails closed in production when ADMIN_TOKEN is missing', async () => {
    const previousToken = process.env.ADMIN_TOKEN;
    const previousEnv = process.env.NODE_ENV;
    delete process.env.ADMIN_TOKEN;
    process.env.NODE_ENV = 'production';
    try {
      const health = await adminApp.request('/health');
      expect((await json(health)).setupRequired).toBe(true);
      const res = await adminApp.request('/config');
      expect(res.status).toBe(503);
      expect((await json(res)).code).toBe('admin_token_not_configured');
    } finally {
      process.env.ADMIN_TOKEN = previousToken;
      process.env.NODE_ENV = previousEnv;
    }
  });

  it('reads an empty config and writes a gateway document', async () => {
    const initial = await adminApp.request('/config', { headers: AUTH });
    expect(initial.status).toBe(200);
    expect((await json(initial)).existed).toBe(false);

    const gateway = {
      providers: {
        deepseek: [
          {
            id: 'cfg-1',
            apiKey: 'sk-test',
            baseUrl: 'https://api.deepseek.com/v1',
            lastSyncedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
      text: {
        routing: [
          {
            provider: 'deepseek',
            model: 'deepseek-chat',
            configId: 'cfg-1',
            isPrimary: true,
          },
        ],
        userConfig: null,
      },
      image: { routing: [], userConfig: null },
      video: { routing: [], userConfig: null },
      audio: { routing: [], userConfig: null },
      mcp: { routing: [], userConfig: null },
    };

    const put = await adminApp.request('/config', {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify(gateway),
    });
    expect(put.status).toBe(200);
    const saved = await json(put);
    expect(saved.config.providers.deepseek[0].apiKey).toBe('sk-test');
    expect(saved.existed).toBe(true);
    expect(put.headers.get('etag')).toBeTruthy();

    const reload = await adminApp.request('/config', { headers: AUTH });
    const reloaded = await json(reload);
    expect(reloaded.config.providers.deepseek[0].apiKey).toBe('sk-test');
  });

  it('rejects unsafe provider URLs unless explicitly allowed', async () => {
    const res = await adminApp.request('/config', {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providers: {
          openai: [
            {
              id: 'local',
              apiKey: 'sk-test',
              baseUrl: 'http://127.0.0.1:11434/v1',
            },
          ],
        },
        text: { routing: [], userConfig: null },
        image: { routing: [], userConfig: null },
        video: { routing: [], userConfig: null },
        audio: { routing: [], userConfig: null },
        mcp: { routing: [], userConfig: null },
      }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe('unsafe_provider_url');
  });

  it('round-trips export and import', async () => {
    const exported = await adminApp.request('/config/export', {
      headers: AUTH,
    });
    expect(exported.status).toBe(200);
    const config = (await json(exported)).config;
    expect(config.gateway).toBeTruthy();

    const imported = await adminApp.request('/config/import', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    });
    expect(imported.status).toBe(200);
    expect((await json(imported)).ok).toBe(true);
  });

  it('maps a stale If-Match to 409', async () => {
    const first = await adminApp.request('/config', { headers: AUTH });
    const version = (await json(first)).version;

    const put = await adminApp.request('/config', {
      method: 'PUT',
      headers: {
        ...AUTH,
        'Content-Type': 'application/json',
        'If-Match': `"${version}"`,
      },
      body: JSON.stringify({
        providers: {},
        text: { routing: [], userConfig: null },
        image: { routing: [], userConfig: null },
        video: { routing: [], userConfig: null },
        audio: { routing: [], userConfig: null },
        mcp: { routing: [], userConfig: null },
      }),
    });
    expect(put.status).toBe(200);

    const stale = await adminApp.request('/config', {
      method: 'PUT',
      headers: {
        ...AUTH,
        'Content-Type': 'application/json',
        'If-Match': `"${version}"`,
      },
      body: JSON.stringify({
        providers: {},
        text: { routing: [], userConfig: null },
        image: { routing: [], userConfig: null },
        video: { routing: [], userConfig: null },
        audio: { routing: [], userConfig: null },
        mcp: { routing: [], userConfig: null },
      }),
    });
    expect(stale.status).toBe(409);
  });
});
