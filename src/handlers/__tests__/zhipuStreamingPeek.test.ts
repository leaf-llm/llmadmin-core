import { describe, test, expect } from '@jest/globals';
import { peekZhipuStreamingBusinessError } from '../streamHandler';

describe('peekZhipuStreamingBusinessError', () => {
  test('returns a 424 Response when the first SSE event is a business error', async () => {
    const sseBody =
      'data: {"code":500,"msg":"404 NOT_FOUND","success":false}\n\n' +
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
    const upstream = new Response(sseBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    const result = await peekZhipuStreamingBusinessError(upstream);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(424);
    expect(result!.statusText).toBe('Failed Dependency');
    const body = (await result!.json()) as any;
    expect(body.error.code).toBe('500');
    expect(body.error.type).toBe('zhipu_business_error');
  });

  test('returns null when the first SSE event is a normal chunk', async () => {
    const sseBody =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: [DONE]\n\n';
    const upstream = new Response(sseBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    const result = await peekZhipuStreamingBusinessError(upstream);
    expect(result).toBeNull();
  });

  test('returns null when the response has no body', async () => {
    const upstream = new Response(null, { status: 200 });
    const result = await peekZhipuStreamingBusinessError(upstream);
    expect(result).toBeNull();
  });
});