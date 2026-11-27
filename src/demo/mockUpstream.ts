import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

/**
 * Built-in mock upstream used by the demo sandbox.
 *
 * Seeded providers point their `baseUrl` at this route, which means a demo
 * request travels the full pipeline — routing, protocol conversion, streaming,
 * usage accounting — but ends in a local, deterministic response. No API key,
 * no outbound network, no cost.
 */
export const demoMockApp = new Hono();

const MODELS = [
  { id: 'demo-fast', label: 'Demo Fast' },
  { id: 'demo-pro', label: 'Demo Pro' },
  { id: 'demo-sonnet', label: 'Demo Sonnet (Anthropic 协议)' },
];

function messageText(payload: any): string {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const lastUser = [...messages].reverse().find((m: any) => m?.role === 'user');
  const content = lastUser?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof payload?.prompt === 'string') return payload.prompt;
  return '';
}

function snippet(text: string, limit = 80): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return '（空消息）';
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
}

function replyFor(payload: any): string {
  const model = payload?.model ?? 'demo-fast';
  return [
    `我是内置 Mock 模型（${model}），收到你的消息：「${snippet(messageText(payload))}」。`,
    '这条回复由演示环境本地生成，不调用任何真实供应商，也不消耗额度。',
    '你可以继续在左侧改路由、切换模型或调整参数，观察请求是怎么被网关处理的。',
  ].join('\n');
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

demoMockApp.get('/v1/models', (c) =>
  c.json({
    object: 'list',
    data: MODELS.map((m) => ({
      id: m.id,
      object: 'model',
      created: 0,
      owned_by: 'llmadmin-demo',
      display_name: m.label,
    })),
    has_more: false,
  })
);

demoMockApp.post('/v1/chat/completions', async (c) => {
  const payload = await c.req.json().catch(() => ({} as any));
  const text = replyFor(payload);
  const id = `chatcmpl-demo-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  const model = payload?.model ?? 'demo-fast';

  if (!payload?.stream) {
    return c.json({
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: estimateTokens(messageText(payload)),
        completion_tokens: estimateTokens(text),
        total_tokens:
          estimateTokens(messageText(payload)) + estimateTokens(text),
      },
    });
  }

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      data: JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      }),
    });
    for (const chunk of text.match(/[\s\S]{1,24}/g) ?? []) {
      await stream.writeSSE({
        data: JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
        }),
      });
    }
    await stream.writeSSE({
      data: JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }),
    });
    await stream.writeSSE({ data: '[DONE]' });
  });
});

demoMockApp.post('/v1/completions', async (c) => {
  const payload = await c.req.json().catch(() => ({} as any));
  const text = replyFor(payload);
  return c.json({
    id: `cmpl-demo-${Date.now().toString(36)}`,
    object: 'text_completion',
    created: Math.floor(Date.now() / 1000),
    model: payload?.model ?? 'demo-fast',
    choices: [{ index: 0, text, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: estimateTokens(messageText(payload)),
      completion_tokens: estimateTokens(text),
      total_tokens: estimateTokens(messageText(payload)) + estimateTokens(text),
    },
  });
});

demoMockApp.post('/v1/messages', async (c) => {
  const payload = await c.req.json().catch(() => ({} as any));
  const text = replyFor(payload);
  const model = payload?.model ?? 'demo-sonnet';
  const inputTokens = estimateTokens(messageText(payload));
  const outputTokens = estimateTokens(text);
  const id = `msg_demo_${Date.now().toString(36)}`;

  if (!payload?.stream) {
    return c.json({
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    });
  }

  return streamSSE(c, async (stream) => {
    const send = (event: string, data: unknown) =>
      stream.writeSSE({ event, data: JSON.stringify(data) });

    await send('message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 1 },
      },
    });
    await send('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    for (const chunk of text.match(/[\s\S]{1,24}/g) ?? []) {
      await send('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: chunk },
      });
    }
    await send('content_block_stop', { type: 'content_block_stop', index: 0 });
    await send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: outputTokens },
    });
    await send('message_stop', { type: 'message_stop' });
  });
});

demoMockApp.post('/v1/messages/count_tokens', async (c) => {
  const payload = await c.req.json().catch(() => ({} as any));
  return c.json({ input_tokens: estimateTokens(messageText(payload)) });
});
