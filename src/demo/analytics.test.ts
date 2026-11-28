/**
 * @jest-environment node
 */
import { flushDemoEvents, trackDemoEvent } from './analytics';

const realFetch = global.fetch;

function capture() {
  const calls: Array<{ url: string; init: any }> = [];
  (global as any).fetch = jest.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    return new Response('{}', { status: 200 });
  });
  return calls;
}

describe('demo analytics', () => {
  const originalUrl = process.env.DEMO_ANALYTICS_URL;
  const originalToken = process.env.DEMO_ANALYTICS_TOKEN;

  beforeEach(() => {
    process.env.DEMO_ANALYTICS_URL = 'https://collector.test/api/demo/collect';
    process.env.DEMO_ANALYTICS_TOKEN = 'secret-token';
  });

  afterEach(() => {
    global.fetch = realFetch;
    if (originalUrl === undefined) delete process.env.DEMO_ANALYTICS_URL;
    else process.env.DEMO_ANALYTICS_URL = originalUrl;
    if (originalToken === undefined) delete process.env.DEMO_ANALYTICS_TOKEN;
    else process.env.DEMO_ANALYTICS_TOKEN = originalToken;
  });

  it('flushes buffered events as one authenticated batch', async () => {
    const calls = capture();

    trackDemoEvent('session_created', { via: 'demo' });
    trackDemoEvent('key_generated', { rotated: false });
    await flushDemoEvents();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://collector.test/api/demo/collect');
    expect(calls[0].init.headers.authorization).toBe('Bearer secret-token');

    const payload = JSON.parse(calls[0].init.body);
    expect(payload.source).toBe('llmadmin-demo');
    expect(payload.events.map((e: any) => e.name)).toEqual([
      'session_created',
      'key_generated',
    ]);
    expect(payload.events[0].props).toEqual({ via: 'demo' });
    expect(typeof payload.events[0].ts).toBe('number');
  });

  it('does nothing when no collector is configured', async () => {
    delete process.env.DEMO_ANALYTICS_URL;
    const calls = capture();

    trackDemoEvent('request', { status: 200 });
    await flushDemoEvents();

    expect(calls).toHaveLength(0);
  });

  it('drops the batch instead of throwing when the collector is down', async () => {
    (global as any).fetch = jest.fn(async () => {
      throw new Error('network down');
    });

    trackDemoEvent('request', { status: 200 });
    await expect(flushDemoEvents()).resolves.toBeUndefined();
  });
});
