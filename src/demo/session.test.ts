import {
  consumeDemoBudget,
  createDemoSession,
  demoSessionView,
  getDemoSession,
  getDemoSessionByKey,
  hashDemoKey,
  issueDemoKey,
  resetDemoSession,
  revokeDemoKey,
  signSessionCookie,
  verifySessionCookie,
} from './session';

function create(ip = '10.0.0.1') {
  const result = createDemoSession(ip);
  if (!result.ok) throw new Error('session creation failed: ' + result.reason);
  return result.session;
}

describe('demo sessions', () => {
  beforeAll(() => {
    process.env.DEMO_SECRET = 'test-secret';
    process.env.DEMO_TTL_MINUTES = '30';
    process.env.DEMO_MAX_REQUESTS = '3';
    process.env.DEMO_MAX_REQUESTS_PER_MINUTE = '2';
  });

  it('seeds a session with the built-in mock providers', async () => {
    const session = create('10.0.0.2');
    const loaded = await session.store.load();
    const gateway = loaded!.doc.gateway;
    expect(Object.keys(gateway.providers)).toEqual([
      'openai-compatible',
      'anthropic-compatible',
    ]);
    expect(gateway.text.routing).toHaveLength(3);
    expect(gateway.text.routing[0]).toMatchObject({
      provider: 'openai-compatible',
      model: 'demo-fast',
      isPrimary: true,
    });
    expect(gateway.text.userConfig.targets).toHaveLength(3);
  });

  it('keeps configuration writes isolated per session', async () => {
    const a = create('10.0.0.3');
    const b = create('10.0.0.4');
    const docA = (await a.store.load())!.doc;
    docA.gateway.text.routing[0].model = 'demo-pro';
    await a.store.save(docA);

    const docB = (await b.store.load())!.doc;
    expect(docB.gateway.text.routing[0].model).toBe('demo-fast');
    expect((await a.store.load())!.doc.gateway.text.routing[0].model).toBe(
      'demo-pro'
    );
  });

  it('issues opaque keys that resolve back to the session', () => {
    const session = create('10.0.0.5');
    const key = issueDemoKey(session);
    expect(key.startsWith('dms_')).toBe(true);
    expect(key.length).toBeGreaterThan(20);
    expect(getDemoSessionByKey(key)?.id).toBe(session.id);
    expect(getDemoSessionByKey('dms_nope')).toBeNull();
    expect(session.keyHint).toBe(key.slice(-4));
    expect(session.keyHash).toBe(hashDemoKey(key));
  });

  it('rotating and revoking keys invalidates the previous key', () => {
    const session = create('10.0.0.6');
    const first = issueDemoKey(session);
    const second = issueDemoKey(session);
    expect(getDemoSessionByKey(first)).toBeNull();
    expect(getDemoSessionByKey(second)?.id).toBe(session.id);

    revokeDemoKey(session);
    expect(getDemoSessionByKey(second)).toBeNull();
  });

  it('resets the sandbox to the seed document', async () => {
    const session = create('10.0.0.7');
    const doc = (await session.store.load())!.doc;
    doc.gateway.text.routing = [];
    await session.store.save(doc);

    resetDemoSession(session);
    const fresh = (await session.store.load())!.doc;
    expect(fresh.gateway.text.routing).toHaveLength(3);
  });

  it('signs cookies and rejects tampering', () => {
    const session = create('10.0.0.8');
    const cookie = signSessionCookie(session.id);
    expect(verifySessionCookie(cookie)).toBe(session.id);
    expect(verifySessionCookie(cookie + 'x')).toBeNull();
    expect(verifySessionCookie('forged.signature')).toBeNull();
    expect(verifySessionCookie(undefined)).toBeNull();
  });

  it('enforces the per-minute and total request budgets', () => {
    const session = create('10.0.0.9');
    expect(consumeDemoBudget(session).ok).toBe(true);
    expect(consumeDemoBudget(session).ok).toBe(true);
    const third = consumeDemoBudget(session);
    expect(third).toEqual({ ok: false, reason: 'session_rate' });

    // Next minute window: two more requests, then the total budget is gone.
    session.windowStartedAt = Date.now() - 61_000;
    expect(consumeDemoBudget(session).ok).toBe(true);
    expect(consumeDemoBudget(session)).toEqual({
      ok: false,
      reason: 'session_total',
    });
  });

  it('reports expiry and quota in the session view', () => {
    const session = create('10.0.0.10');
    const view = demoSessionView(session, 'https://demo.example/v1');
    expect(view.gatewayUrl).toBe('https://demo.example/v1');
    expect(view.hasKey).toBe(false);
    expect(view.remainingSeconds).toBeGreaterThan(0);
    expect(view.apiKey).toBeNull();

    issueDemoKey(session);
    const withKey = demoSessionView(session, 'https://demo.example/v1');
    expect(withKey.hasKey).toBe(true);
    expect(String(withKey.apiKey)).toMatch(/^dms_/);
  });

  it('keeps sessions alive when DEMO_TTL_MINUTES is not set', () => {
    const previous = process.env.DEMO_TTL_MINUTES;
    delete process.env.DEMO_TTL_MINUTES;
    try {
      const session = create('10.0.0.12');
      session.lastSeenAt = Date.now() - 7 * 24 * 3600_000;
      expect(getDemoSession(session.id)?.id).toBe(session.id);
      const view = demoSessionView(session, 'https://demo.example/v1');
      expect(view.expiresAt).toBeNull();
      expect(view.remainingSeconds).toBeNull();
    } finally {
      process.env.DEMO_TTL_MINUTES = previous;
    }
  });

  it('evicts the least recently used session when the cap is reached', () => {
    const previous = process.env.DEMO_MAX_SESSIONS;
    process.env.DEMO_MAX_SESSIONS = '2';
    try {
      const first = create('10.1.0.1');
      const second = create('10.1.0.2');
      first.lastSeenAt = Date.now() - 60_000;
      second.lastSeenAt = Date.now();
      const third = create('10.1.0.3');
      expect(getDemoSession(first.id)).toBeNull();
      expect(getDemoSession(second.id)?.id).toBe(second.id);
      expect(getDemoSession(third.id)?.id).toBe(third.id);
    } finally {
      process.env.DEMO_MAX_SESSIONS = previous;
    }
  });

  it('returns the same session for a known id and drops expired ones', () => {
    const session = create('10.0.0.11');
    expect(getDemoSession(session.id)?.id).toBe(session.id);
    session.lastSeenAt = Date.now() - 31 * 60_000;
    expect(getDemoSession(session.id)).toBeNull();
  });
});
