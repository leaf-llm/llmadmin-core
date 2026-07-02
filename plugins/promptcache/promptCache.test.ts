import { handler } from './promptCache';
import { PluginContext, PluginParameters } from '../types';

const mockEventType = 'beforeRequestHook';

const baseContext = (overrides: Partial<PluginContext> = {}): PluginContext =>
  ({
    requestType: 'messages',
    request: { json: { messages: [] } },
    ...overrides,
  }) as any;

describe('promptCache plugin', () => {
  describe('bail-outs', () => {
    it('bails out for chatComplete (OpenAI-shape) requests', async () => {
      const ctx = baseContext({ requestType: 'chatComplete' });
      const r = await handler(ctx, { fixedPrompt: 'hi' }, mockEventType);
      expect(r.error).toBeNull();
      expect(r.verdict).toBe(true);
      expect(r.transformed).toBe(false);
      expect(r.transformedData.request.json).toBeNull();
    });

    it('bails out for complete requests', async () => {
      const ctx = baseContext({ requestType: 'complete' });
      const r = await handler(ctx, { fixedPrompt: 'hi' }, mockEventType);
      expect(r.transformed).toBe(false);
      expect(r.transformedData.request.json).toBeNull();
    });

    it('bails out for embed requests', async () => {
      const ctx = baseContext({ requestType: 'embed' });
      const r = await handler(ctx, { fixedPrompt: 'hi' }, mockEventType);
      expect(r.transformed).toBe(false);
      expect(r.transformedData.request.json).toBeNull();
    });

    it('bails out when fixedPrompt is missing', async () => {
      const ctx = baseContext();
      const r = await handler(ctx, {} as PluginParameters, mockEventType);
      expect(r.transformed).toBe(false);
      expect(r.transformedData.request.json).toBeNull();
    });

    it('bails out when fixedPrompt is empty', async () => {
      const ctx = baseContext();
      const r = await handler(ctx, { fixedPrompt: '' }, mockEventType);
      expect(r.transformed).toBe(false);
      expect(r.transformedData.request.json).toBeNull();
    });

    it('bails out when fixedPrompt is not a string', async () => {
      const ctx = baseContext();
      const r = await handler(ctx, { fixedPrompt: 42 as any }, mockEventType);
      expect(r.transformed).toBe(false);
      expect(r.transformedData.request.json).toBeNull();
    });

    it('bails out when applyToRole is invalid', async () => {
      const ctx = baseContext();
      const r = await handler(
        ctx,
        { fixedPrompt: 'hi', applyToRole: 'tool' as any },
        mockEventType
      );
      expect(r.transformed).toBe(false);
      expect(r.transformedData.request.json).toBeNull();
    });

    it('returns a noop when request.json is missing', async () => {
      const ctx = baseContext({ request: { json: undefined as any } });
      const r = await handler(ctx, { fixedPrompt: 'fixed' }, mockEventType);
      expect(r.error).toBeNull();
      expect(r.transformed).toBe(false);
      expect(r.transformedData.request.json).toBeNull();
    });
  });

  describe('Anthropic /v1/messages', () => {
    it('prepends a system message in Anthropic content-array shape', async () => {
      const ctx = baseContext({
        request: {
          json: {
            model: 'claude-3-5-sonnet',
            messages: [
              { role: 'user', content: [{ type: 'text', text: 'hi' }] },
            ],
          },
        },
      });
      const r = await handler(
        ctx,
        { fixedPrompt: 'You are a helpful assistant.' },
        mockEventType
      );
      expect(r.error).toBeNull();
      expect(r.transformed).toBe(true);
      const msgs = r.transformedData.request.json.messages;
      expect(msgs).toHaveLength(2);
      expect(msgs[0].role).toBe('system');
      expect(msgs[0].content).toEqual([
        {
          type: 'text',
          text: 'You are a helpful assistant.',
          cache_control: { type: 'ephemeral' },
        },
      ]);
      // last user message — marker is on its last text block
      expect(msgs[1].content[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('replaces content of an existing system message with array shape', async () => {
      const ctx = baseContext({
        request: {
          json: {
            model: 'claude-3-5-sonnet',
            messages: [
              { role: 'system', content: [{ type: 'text', text: 'old' }] },
              { role: 'user', content: [{ type: 'text', text: 'hi' }] },
            ],
          },
        },
      });
      const r = await handler(ctx, { fixedPrompt: 'NEW' }, mockEventType);
      expect(r.transformed).toBe(true);
      const msgs = r.transformedData.request.json.messages;
      expect(msgs[0].content).toEqual([
        { type: 'text', text: 'NEW', cache_control: { type: 'ephemeral' } },
      ]);
    });

    it('marks the last text block of an array-content user message', async () => {
      const ctx = baseContext({
        request: {
          json: {
            model: 'claude-3-5-sonnet',
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'first' },
                  { type: 'text', text: 'second' },
                ],
              },
            ],
          },
        },
      });
      const r = await handler(ctx, { fixedPrompt: 'fixed' }, mockEventType);
      expect(r.transformed).toBe(true);
      const msgs = r.transformedData.request.json.messages;
      // system prepended at [0]; user at [1] with two text blocks
      expect(msgs[0].role).toBe('system');
      expect(msgs[1].role).toBe('user');
      // only the LAST text block of the user is marked
      expect(msgs[1].content[0].cache_control).toBeUndefined();
      expect(msgs[1].content[1].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('coerces string user content into a text block with marker', async () => {
      const ctx = baseContext({
        request: {
          json: {
            model: 'claude-3-5-sonnet',
            messages: [{ role: 'user', content: 'hi there' }],
          },
        },
      });
      const r = await handler(ctx, { fixedPrompt: 'fixed' }, mockEventType);
      expect(r.transformed).toBe(true);
      const msgs = r.transformedData.request.json.messages;
      // system prepended at [0]; user at [1] with string content coerced
      expect(msgs[0].role).toBe('system');
      expect(msgs[1].content).toEqual([
        {
          type: 'text',
          text: 'hi there',
          cache_control: { type: 'ephemeral' },
        },
      ]);
    });

    it('marks the last user message when there are multiple user/assistant turns', async () => {
      const ctx = baseContext({
        request: {
          json: {
            model: 'claude-3-5-sonnet',
            messages: [
              { role: 'user', content: [{ type: 'text', text: 'first' }] },
              { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
              { role: 'user', content: [{ type: 'text', text: 'second' }] },
            ],
          },
        },
      });
      const r = await handler(ctx, { fixedPrompt: 'fixed' }, mockEventType);
      expect(r.transformed).toBe(true);
      const msgs = r.transformedData.request.json.messages;
      // system prepended at [0]; only the LAST user message is marked
      expect(msgs[0].role).toBe('system');
      expect(msgs[1].content[0].cache_control).toBeUndefined();
      expect(msgs[3].content[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('creates the system message even when there is no user message', async () => {
      const ctx = baseContext({
        request: { json: { model: 'claude-3-5-sonnet', messages: [] } },
      });
      const r = await handler(ctx, { fixedPrompt: 'fixed' }, mockEventType);
      expect(r.transformed).toBe(true);
      const msgs = r.transformedData.request.json.messages;
      expect(msgs).toHaveLength(1);
      expect(msgs[0].role).toBe('system');
      expect(msgs[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('respects createIfMissing=false when role is absent', async () => {
      const ctx = baseContext({
        request: {
          json: {
            model: 'claude-3-5-sonnet',
            messages: [
              { role: 'user', content: [{ type: 'text', text: 'hi' }] },
            ],
          },
        },
      });
      const r = await handler(
        ctx,
        { fixedPrompt: 'fixed', createIfMissing: false },
        mockEventType
      );
      expect(r.transformed).toBe(false);
      expect(r.transformedData.request.json).toBeNull();
    });

    it('respects addBreakpointToLastUser=false', async () => {
      const ctx = baseContext({
        request: {
          json: {
            model: 'claude-3-5-sonnet',
            messages: [
              { role: 'user', content: [{ type: 'text', text: 'hi' }] },
            ],
          },
        },
      });
      const r = await handler(
        ctx,
        { fixedPrompt: 'fixed', addBreakpointToLastUser: false },
        mockEventType
      );
      expect(r.transformed).toBe(true);
      const msgs = r.transformedData.request.json.messages;
      // system is prepended and marked
      expect(msgs[0].role).toBe('system');
      expect(msgs[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
      // user is NOT marked
      expect(msgs[1].content[0].cache_control).toBeUndefined();
    });
  });

  describe('idempotency', () => {
    it('running the handler twice yields an equivalent result', async () => {
      const ctx = baseContext({
        request: {
          json: {
            model: 'claude-3-5-sonnet',
            messages: [
              { role: 'user', content: [{ type: 'text', text: 'hi' }] },
            ],
          },
        },
      });
      const r1 = await handler(ctx, { fixedPrompt: 'fixed' }, mockEventType);
      const r2 = await handler(
        { ...ctx, request: { json: r1.transformedData.request.json } },
        { fixedPrompt: 'fixed' },
        mockEventType
      );
      const m1 = r1.transformedData.request.json.messages;
      const m2 = r2.transformedData.request.json.messages;
      expect(m2).toHaveLength(m1.length);
      // Same length, same content text, same markers — but freshly cloned objects.
      expect(m2[0].content[0].text).toBe(m1[0].content[0].text);
      expect(m2[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
      expect(m2[1].content[0].cache_control).toEqual({ type: 'ephemeral' });
    });
  });
});
