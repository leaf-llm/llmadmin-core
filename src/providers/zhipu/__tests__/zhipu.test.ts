import { describe, test, expect } from '@jest/globals';
import { ZhipuChatCompleteResponseTransform } from '../chatComplete';
import { ZhipuEmbedResponseTransform } from '../embed';
import { ZhipuMessagesResponseTransform } from '../messages';
import {
  isZhipuBusinessError,
  buildZhipuBusinessErrorResponse,
  ZHIPU_BUSINESS_ERROR_MARKER,
} from '../utils';
import { ZHIPU } from '../../../globals';

describe('isZhipuBusinessError', () => {
  test('detects success:false', () => {
    expect(isZhipuBusinessError({ code: 500, msg: 'NOT_FOUND', success: false })).toBe(true);
  });

  test('detects success:false without code', () => {
    expect(isZhipuBusinessError({ success: false })).toBe(true);
  });

  test('detects numeric code != 200', () => {
    expect(isZhipuBusinessError({ code: 401, msg: 'unauthorized' })).toBe(true);
  });

  test('does NOT detect success:undefined + code:200', () => {
    expect(
      isZhipuBusinessError({ code: 200, msg: 'ok', data: { choices: [] } })
    ).toBe(false);
  });

  test('does NOT detect a normal OpenAI-shaped success body', () => {
    expect(
      isZhipuBusinessError({
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    ).toBe(false);
  });

  test('does NOT throw on null/undefined', () => {
    expect(isZhipuBusinessError(null)).toBe(false);
    expect(isZhipuBusinessError(undefined)).toBe(false);
    expect(isZhipuBusinessError('not an object')).toBe(false);
  });
});

describe('buildZhipuBusinessErrorResponse', () => {
  test('produces an ErrorResponse with the marker and Zhipu provider', () => {
    const body = { code: 500, msg: '404 NOT_FOUND', success: false };
    const err = buildZhipuBusinessErrorResponse(body);
    expect(err.provider).toBe(ZHIPU);
    expect(err.error.code).toBe('500');
    expect(err.error.type).toBe('zhipu_business_error');
    expect(err.error.message).toContain('404 NOT_FOUND');
    expect((err as any)[ZHIPU_BUSINESS_ERROR_MARKER]).toBe(true);
  });

  test('falls back to JSON.stringify when no msg/message field', () => {
    const err = buildZhipuBusinessErrorResponse({ success: false });
    expect(err.error.message).toContain('"success":false');
  });
});

describe('ZhipuChatCompleteResponseTransform', () => {
  test('converts Zhipu business-error body into a marked ErrorResponse', () => {
    const out = ZhipuChatCompleteResponseTransform(
      { code: 500, msg: '404 NOT_FOUND', success: false },
      200
    );
    expect((out as any).provider).toBe(ZHIPU);
    expect((out as any).error.code).toBe('500');
    expect((out as any)[ZHIPU_BUSINESS_ERROR_MARKER]).toBe(true);
  });

  test('passes a normal Zhipu success body through buildOpenAIChatCompleteResponse', () => {
    const out = ZhipuChatCompleteResponseTransform(
      {
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      200
    );
    expect((out as any).choices).toBeDefined();
    expect((out as any)[ZHIPU_BUSINESS_ERROR_MARKER]).toBeUndefined();
  });

  test('still translates non-200 HTTP responses with the error envelope', () => {
    const out = ZhipuChatCompleteResponseTransform(
      { message: 'upstream error', type: 'auth', param: null, code: 401 },
      401
    );
    expect((out as any).provider).toBe(ZHIPU);
    expect((out as any).error.message).toContain('upstream error');
  });
});

describe('ZhipuEmbedResponseTransform', () => {
  test('converts Zhipu business-error body into a marked ErrorResponse', () => {
    const out = ZhipuEmbedResponseTransform(
      { code: 500, msg: 'INSUFFICIENT_BALANCE', success: false } as any,
      200
    );
    expect((out as any).provider).toBe(ZHIPU);
    expect((out as any)[ZHIPU_BUSINESS_ERROR_MARKER]).toBe(true);
  });

  test('passes a normal embed response through unchanged', () => {
    const ok = {
      object: 'list',
      model: 'embedding-2',
      usage: { prompt_tokens: 1, total_tokens: 1 },
      data: [{ embedding: [0.1, 0.2], index: 0, object: 'embedding' }],
    } as any;
    const out = ZhipuEmbedResponseTransform(ok, 200);
    expect(out).toEqual(ok);
  });
});

describe('ZhipuMessagesResponseTransform', () => {
  test('converts Zhipu business-error body into a marked ErrorResponse', () => {
    const out = ZhipuMessagesResponseTransform(
      { code: 500, msg: 'quota exhausted', success: false },
      200
    );
    expect((out as any).provider).toBe(ZHIPU);
    expect((out as any)[ZHIPU_BUSINESS_ERROR_MARKER]).toBe(true);
  });

  test('passes an Anthropic-shaped message through', () => {
    const out = ZhipuMessagesResponseTransform(
      {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        model: 'glm-4-0520',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      200
    );
    expect((out as any).type).toBe('message');
    expect((out as any)[ZHIPU_BUSINESS_ERROR_MARKER]).toBeUndefined();
  });
});