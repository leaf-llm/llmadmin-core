import {
  AZURE_OPEN_AI,
  BEDROCK,
  CONTENT_TYPES,
  COHERE,
  GOOGLE,
  REQUEST_TIMEOUT_STATUS_CODE,
  PRECONDITION_CHECK_FAILED_STATUS_CODE,
  GOOGLE_VERTEX_AI,
  ZHIPU,
} from '../globals';
import { HookSpan } from '../middlewares/hooks';
import { VertexLlamaChatCompleteStreamChunkTransform } from '../providers/google-vertex-ai/chatComplete';
import { OpenAIChatCompleteResponse } from '../providers/openai/chatComplete';
import { OpenAICompleteResponse } from '../providers/openai/complete';
import { endpointStrings } from '../providers/types';
import { Params } from '../types/requestBody';
import { getStreamModeSplitPattern, type SplitPatternType } from '../utils';
import { getErrorMessage } from '../i18n';

function readUInt32BE(buffer: Uint8Array, offset: number) {
  return (
    ((buffer[offset] << 24) |
      (buffer[offset + 1] << 16) |
      (buffer[offset + 2] << 8) |
      buffer[offset + 3]) >>>
    0
  ); // Ensure the result is an unsigned integer
}

const shouldSendHookResultChunk = (
  strictOpenAiCompliance: boolean,
  hooksResult: HookSpan['hooksResult']
) => {
  return (
    !strictOpenAiCompliance && hooksResult?.beforeRequestHooksResult?.length > 0
  );
};

function getPayloadFromAWSChunk(chunk: Uint8Array): string {
  const decoder = new TextDecoder();
  const chunkLength = readUInt32BE(chunk, 0);
  const headersLength = readUInt32BE(chunk, 4);

  // prelude 8 + Prelude crc 4 = 12
  const headersEnd = 12 + headersLength;

  const payloadLength = chunkLength - headersEnd - 4; // Subtracting 4 for the message crc
  const payload = chunk.slice(headersEnd, headersEnd + payloadLength);
  const decodedJson = JSON.parse(decoder.decode(payload));
  return decodedJson.bytes
    ? Buffer.from(decodedJson.bytes, 'base64').toString()
    : JSON.stringify(decodedJson);
}

function concatenateUint8Arrays(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0); // Copy contents of array 'a' into 'result' starting at index 0
  result.set(b, a.length); // Copy contents of array 'b' into 'result' starting at index 'a.length'
  return result;
}

export async function* readAWSStream(
  reader: ReadableStreamDefaultReader,
  transformFunction: Function | undefined,
  fallbackChunkId: string,
  strictOpenAiCompliance: boolean,
  gatewayRequest: Params
) {
  let buffer = new Uint8Array();
  let expectedLength = 0;
  const streamState = {};
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (buffer.length) {
        expectedLength = readUInt32BE(buffer, 0);
        while (buffer.length >= expectedLength && buffer.length !== 0) {
          const data = buffer.subarray(0, expectedLength);
          buffer = buffer.subarray(expectedLength);
          expectedLength = readUInt32BE(buffer, 0);
          const payload = getPayloadFromAWSChunk(data);
          if (transformFunction) {
            const transformedChunk = transformFunction(
              payload,
              fallbackChunkId,
              streamState,
              strictOpenAiCompliance,
              gatewayRequest
            );
            if (Array.isArray(transformedChunk)) {
              for (const item of transformedChunk) {
                yield item;
              }
            } else {
              yield transformedChunk;
            }
          } else {
            yield data;
          }
        }
      }
      break;
    }

    if (expectedLength === 0) {
      expectedLength = readUInt32BE(value, 0);
    }

    buffer = concatenateUint8Arrays(buffer, value);

    while (buffer.length >= expectedLength && buffer.length !== 0) {
      const data = buffer.subarray(0, expectedLength);
      buffer = buffer.subarray(expectedLength);

      expectedLength = readUInt32BE(buffer, 0);
      const payload = getPayloadFromAWSChunk(data);

      if (transformFunction) {
        const transformedChunk = transformFunction(
          payload,
          fallbackChunkId,
          streamState,
          strictOpenAiCompliance,
          gatewayRequest
        );
        if (Array.isArray(transformedChunk)) {
          for (const item of transformedChunk) {
            yield item;
          }
        } else {
          yield transformedChunk;
        }
      } else {
        yield data;
      }
    }
  }
}

export async function* readStream(
  reader: ReadableStreamDefaultReader,
  splitPattern: SplitPatternType,
  transformFunction: Function | undefined,
  isSleepTimeRequired: boolean,
  fallbackChunkId: string,
  strictOpenAiCompliance: boolean,
  gatewayRequest: Params
) {
  let buffer = '';
  const decoder = new TextDecoder();
  let isFirstChunk = true;
  const streamState = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (buffer.length > 0) {
        if (transformFunction) {
          yield transformFunction(
            buffer,
            fallbackChunkId,
            streamState,
            strictOpenAiCompliance,
            gatewayRequest
          );
        } else {
          yield buffer;
        }
      }
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    // keep buffering until we have a complete chunk

    while (buffer.split(splitPattern).length > 1) {
      const parts = buffer.split(splitPattern);
      const lastPart = parts.pop() ?? ''; // remove the last part from the array and keep it in buffer
      for (const part of parts) {
        // Some providers send ping event which can be ignored during parsing

        if (part.length > 0) {
          if (isFirstChunk) {
            isFirstChunk = false;
            await new Promise((resolve) => setTimeout(resolve, 25));
          } else if (isSleepTimeRequired) {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }

          if (transformFunction) {
            const transformedChunk = transformFunction(
              part,
              fallbackChunkId,
              streamState,
              strictOpenAiCompliance,
              gatewayRequest
            );
            if (transformedChunk !== undefined) {
              yield transformedChunk;
            }
          } else {
            yield part + splitPattern;
          }
        }
      }

      buffer = lastPart; // keep the last part (after the last '\n\n') in buffer
    }
  }
}

export async function handleTextResponse(
  response: Response,
  responseTransformer: Function | undefined
) {
  const text = await response.text();

  if (responseTransformer) {
    const transformedText = responseTransformer(
      { 'html-message': text },
      response.status
    );
    return new Response(JSON.stringify(transformedText), {
      ...response,
      status: response.status,
      headers: new Headers({
        ...Object.fromEntries(response.headers),
        'content-type': 'application/json',
      }),
    });
  }

  return new Response(text, response);
}

export async function handleNonStreamingMode(
  response: Response,
  responseTransformer: Function | undefined,
  strictOpenAiCompliance: boolean,
  gatewayRequestUrl: string,
  gatewayRequest: Params,
  areSyncHooksAvailable: boolean
): Promise<{
  response: Response;
  json: Record<string, any> | null;
  originalResponseBodyJson?: Record<string, any> | null;
}> {
  // 408 is thrown whenever a request takes more than request_timeout to respond.
  // In that case, response thrown by gateway is already in OpenAI format.
  // So no need to transform it again.
  if (
    [
      REQUEST_TIMEOUT_STATUS_CODE,
      PRECONDITION_CHECK_FAILED_STATUS_CODE,
    ].includes(response.status)
  ) {
    return { response, json: await response.clone().json() };
  }

  const isJsonParsingRequired = responseTransformer || areSyncHooksAvailable;
  const originalResponseBodyJson: Record<string, any> | null =
    isJsonParsingRequired ? await response.json() : null;
  let responseBodyJson = originalResponseBodyJson;
  if (responseTransformer) {
    responseBodyJson = responseTransformer(
      responseBodyJson,
      response.status,
      response.headers,
      strictOpenAiCompliance,
      gatewayRequestUrl,
      gatewayRequest
    );
  } else if (!areSyncHooksAvailable) {
    return {
      response: new Response(response.body, response),
      json: null,
      originalResponseBodyJson,
    };
  }

  return {
    response: new Response(JSON.stringify(responseBodyJson), {
      ...response,
      status:
        response.status === 200 &&
        originalResponseBodyJson &&
        typeof originalResponseBodyJson === 'object' &&
        (originalResponseBodyJson as any).success === false &&
        typeof (originalResponseBodyJson as any).msg === 'string'
          ? 402
          : response.status,
    }),
    json: responseBodyJson as Record<string, any>,
    // Send original response if transformer exists
    ...(responseTransformer && { originalResponseBodyJson }),
  };
}

export function handleAudioResponse(response: Response) {
  return new Response(response.body, response);
}

export function handleOctetStreamResponse(response: Response) {
  return new Response(response.body, response);
}

export function handleImageResponse(response: Response) {
  return new Response(response.body, response);
}

/**
 * Peek the first SSE event of a Zhipu streaming response to detect
 * business-level failures (HTTP 200 + { success: false, msg, code }).
 *
 * Zhipu's streaming endpoints (both /chat/completions and /messages)
 * return the same { success: false, msg, code } envelope on the first
 * SSE event when something like insufficient balance or model-not-found
 * occurs. Without this peek, that envelope would be parsed by the normal
 * OpenAI-style stream chunk transformer and bubble up to the client as
 * a malformed/empty response, while the fallback loop never sees a
 * non-2xx status and so never advances to the next target.
 *
 * Strategy: tee the upstream body, buffer the bytes from one branch
 * until the first SSE event boundary (`\n\n`), then either:
 *   - return a 402 synthetic Response with the normalized error
 *     envelope (cancelling the live reader), or
 *   - hand back a fresh Response whose body replays the buffered
 *     prefix followed by the unconsumed tail of the upstream stream.
 */
export async function peekZhipuStreamingBusinessError(
  response: Response
): Promise<Response> {
  if (!response.body || response.status !== 200) return response;

  const [peekBranch, passBranch] = response.body.tee();
  const reader = peekBranch.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (buffer.length < 32 * 1024) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const boundary = buffer.indexOf('\n\n');
      if (boundary !== -1) {
        const firstEvent = buffer.slice(0, boundary);
        const remainderText = buffer.slice(boundary + 2);

        const dataLine = firstEvent
          .split('\n')
          .find((l) => l.startsWith('data:'));
        const payload = dataLine ? dataLine.slice(5).trim() : '';
        let parsed: any = null;
        if (payload && payload !== '[DONE]') {
          try {
            parsed = JSON.parse(payload);
          } catch {
            parsed = null;
          }
        }

        const isBusinessError =
          parsed &&
          typeof parsed === 'object' &&
          parsed.success === false &&
          typeof parsed.msg === 'string';

        if (isBusinessError) {
          try {
            await reader.cancel();
          } catch {}
          const errorBody = {
            error: {
              message: parsed.msg,
              type: 'zhipu_business_error',
              param: null,
              code: parsed.code != null ? String(parsed.code) : null,
            },
            provider: ZHIPU,
          };
          return new Response(JSON.stringify(errorBody), {
            status: 402,
            statusText: 'Payment Required',
            headers: { 'content-type': 'application/json' },
          });
        }

        // Normal first event — replay buffered prefix + remainder,
        // with a debug header so we can see the actual chunk shape.
        const prefixBytes = new TextEncoder().encode(
          firstEvent + '\n\n' + remainderText
        );
        const replayed = new ReadableStream({
          async start(controller) {
            controller.enqueue(prefixBytes);
            const r2 = passBranch.getReader();
            try {
              while (true) {
                const { value, done } = await r2.read();
                if (done) break;
                controller.enqueue(value);
              }
            } finally {
              controller.close();
            }
          },
        });
        try {
          reader.releaseLock();
        } catch {}
        return new Response(replayed, {
          ...response,
          headers: {
            ...Object.fromEntries(response.headers),
            'x-zhipu-peek': JSON.stringify({ firstEvent, parsed }),
          },
        });
      }
    }
  } catch {
    // fall through to final replay
  }

  // No SSE boundary found. Check if the buffered content is a plain JSON
  // business error (no SSE formatting at all — zhipu sometimes returns
  // this for streaming errors).
  let plainParsed: any = null;
  try {
    plainParsed = JSON.parse(buffer);
  } catch {
    plainParsed = null;
  }
  const isPlainBusinessError =
    plainParsed &&
    typeof plainParsed === 'object' &&
    plainParsed.success === false &&
    typeof plainParsed.msg === 'string';

  if (isPlainBusinessError) {
    // Cancel the pass branch and return a 402 with normalized error body.
    try {
      await reader.cancel();
    } catch {}
    const passReader = passBranch.getReader();
    try {
      await passReader.cancel();
    } catch {}
    const errorBody = {
      error: {
        message: plainParsed.msg,
        type: 'zhipu_business_error',
        param: null,
        code: plainParsed.code != null ? String(plainParsed.code) : null,
      },
      provider: ZHIPU,
    };
    return new Response(JSON.stringify(errorBody), {
      status: 402,
      statusText: 'Payment Required',
      headers: { 'content-type': 'application/json' },
    });
  }

  // Genuine stream with no SSE boundary yet — replay what we have.
  const bufferedBytes = new TextEncoder().encode(buffer);
  const passReader = passBranch.getReader();
  try {
    reader.releaseLock();
  } catch {}
  const replayed = new ReadableStream({
    async start(controller) {
      if (bufferedBytes.length) controller.enqueue(bufferedBytes);
      try {
        while (true) {
          const { value, done } = await passReader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } finally {
        controller.close();
      }
    },
  });
  return new Response(replayed, {
    ...response,
    headers: {
      ...Object.fromEntries(response.headers),
      'x-zhipu-peek': JSON.stringify({ buffer }),
    },
  });
}

export function handleStreamingMode(
  response: Response,
  proxyProvider: string,
  responseTransformer: Function | undefined,
  requestURL: string,
  strictOpenAiCompliance: boolean,
  gatewayRequest: Params,
  fn: endpointStrings,
  hooksResult: HookSpan['hooksResult']
): Response {
  const splitPattern = getStreamModeSplitPattern(proxyProvider, requestURL);
  // If the provider doesn't supply completion id,
  // we generate a fallback id using the provider name + timestamp.
  const fallbackChunkId = `${proxyProvider}-${Date.now().toString()}`;

  if (!response.body) {
    throw new Error(getErrorMessage('errors.ERR_INVALID_RESPONSE'));
  }
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = response.body.getReader();
  const isSleepTimeRequired = proxyProvider === AZURE_OPEN_AI ? true : false;
  const encoder = new TextEncoder();

  if (proxyProvider === BEDROCK) {
    (async () => {
      try {
        if (shouldSendHookResultChunk(strictOpenAiCompliance, hooksResult)) {
          const hookResultChunk = constructHookResultChunk(hooksResult, fn);
          if (hookResultChunk) {
            await writer.write(encoder.encode(hookResultChunk));
          }
        }
        for await (const chunk of readAWSStream(
          reader,
          responseTransformer,
          fallbackChunkId,
          strictOpenAiCompliance,
          gatewayRequest
        )) {
          await writer.write(encoder.encode(chunk));
        }
      } catch (error) {
        console.error('Error during stream processing:', proxyProvider, error);
      } finally {
        try {
          await writer.close();
        } catch (closeError) {
          console.error(
            'Failed to close the writer:',
            proxyProvider,
            closeError
          );
        }
      }
    })();
  } else {
    (async () => {
      try {
        if (shouldSendHookResultChunk(strictOpenAiCompliance, hooksResult)) {
          const hookResultChunk = constructHookResultChunk(hooksResult, fn);
          if (hookResultChunk) {
            await writer.write(encoder.encode(hookResultChunk));
          }
        }
        for await (const chunk of readStream(
          reader,
          splitPattern,
          responseTransformer,
          isSleepTimeRequired,
          fallbackChunkId,
          strictOpenAiCompliance,
          gatewayRequest
        )) {
          await writer.write(encoder.encode(chunk));
        }
      } catch (error) {
        console.error('Error during stream processing:', proxyProvider, error);
      } finally {
        try {
          await writer.close();
        } catch (closeError) {
          console.error(
            'Failed to close the writer:',
            proxyProvider,
            closeError
          );
        }
      }
    })();
  }

  // Convert GEMINI/COHERE json stream to text/event-stream for non-proxy calls
  const isGoogleCohereOrBedrock = [GOOGLE, COHERE, BEDROCK].includes(
    proxyProvider
  );
  const isVertexLlama =
    proxyProvider === GOOGLE_VERTEX_AI &&
    responseTransformer?.name ===
      VertexLlamaChatCompleteStreamChunkTransform.name;
  const isJsonStream = isGoogleCohereOrBedrock || isVertexLlama;
  if (isJsonStream && responseTransformer) {
    return new Response(readable, {
      ...response,
      headers: new Headers({
        ...Object.fromEntries(response.headers),
        'content-type': 'text/event-stream',
      }),
    });
  }

  return new Response(readable, response);
}

export async function handleJSONToStreamResponse(
  response: Response,
  provider: string,
  responseTransformerFunction: Function,
  strictOpenAiCompliance: boolean,
  fn: endpointStrings,
  hooksResult: HookSpan['hooksResult']
): Promise<Response> {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const responseJSON: OpenAIChatCompleteResponse | OpenAICompleteResponse =
    await response.clone().json();

  if (
    Object.prototype.toString.call(responseTransformerFunction) ===
    '[object GeneratorFunction]'
  ) {
    const generator = responseTransformerFunction(responseJSON, provider);
    (async () => {
      if (shouldSendHookResultChunk(strictOpenAiCompliance, hooksResult)) {
        const hookResultChunk = constructHookResultChunk(hooksResult, fn);
        if (hookResultChunk) {
          await writer.write(encoder.encode(hookResultChunk));
        }
      }
      while (true) {
        const chunk = generator.next();
        if (chunk.done) {
          break;
        }
        await writer.write(encoder.encode(chunk.value));
      }
      writer.close();
    })();
  } else {
    const streamChunkArray = responseTransformerFunction(
      responseJSON,
      provider
    );
    (async () => {
      if (shouldSendHookResultChunk(strictOpenAiCompliance, hooksResult)) {
        const hookResultChunk = constructHookResultChunk(hooksResult, fn);
        if (hookResultChunk) {
          await writer.write(encoder.encode(hookResultChunk));
        }
      }
      for (const chunk of streamChunkArray) {
        await writer.write(encoder.encode(chunk));
      }
      writer.close();
    })();
  }

  return new Response(readable, {
    headers: new Headers({
      ...Object.fromEntries(response.headers),
      'content-type': CONTENT_TYPES.EVENT_STREAM,
    }),
    status: response.status,
    statusText: response.statusText,
  });
}

const constructHookResultChunk = (
  hooksResult: HookSpan['hooksResult'],
  fn: endpointStrings
) => {
  if (fn === 'messages') {
    return `event: hook_results\ndata: ${JSON.stringify({
      hook_results: {
        before_request_hooks: hooksResult.beforeRequestHooksResult,
      },
    })}\n\n`;
  }
  return `data: ${JSON.stringify({
    hook_results: {
      before_request_hooks: hooksResult.beforeRequestHooksResult,
    },
  })}\n\n`;
};
