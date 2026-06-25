import { PluginHandler } from '../types';

const EPHEMERAL = Object.freeze({ type: 'ephemeral' as const });

interface PromptCacheParameters {
  fixedPrompt?: string;
  applyToRole?: 'system' | 'user' | 'assistant';
  createIfMissing?: boolean;
  addBreakpointToLastUser?: boolean;
}

const buildFixedPromptMessage = (
  role: 'system' | 'user' | 'assistant',
  fixedPrompt: string
): Record<string, any> => {
  // Anthropic-format: array of typed content blocks, with cache_control on
  // the text block so the upstream provider can cache the prefix.
  return {
    role,
    content: [
      { type: 'text', text: fixedPrompt, cache_control: { ...EPHEMERAL } },
    ],
  };
};

const markLastUserMessageWithBreakpoint = (messages: any[]): boolean => {
  if (!Array.isArray(messages) || messages.length === 0) return false;

  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      idx = i;
      break;
    }
  }
  if (idx === -1) return false;

  const lastUser = messages[idx];

  if (Array.isArray(lastUser.content) && lastUser.content.length > 0) {
    let blockIdx = -1;
    for (let i = lastUser.content.length - 1; i >= 0; i--) {
      if (lastUser.content[i]?.type === 'text') {
        blockIdx = i;
        break;
      }
    }
    if (blockIdx === -1) return false;
    lastUser.content[blockIdx] = {
      ...lastUser.content[blockIdx],
      cache_control: { ...EPHEMERAL },
    };
    return true;
  }
  if (typeof lastUser.content === 'string') {
    lastUser.content = [
      {
        type: 'text',
        text: lastUser.content,
        cache_control: { ...EPHEMERAL },
      },
    ];
    return true;
  }
  return false;
};

const noop = () => ({
  error: null,
  verdict: true as const,
  data: null,
  transformedData: { request: { json: null }, response: { json: null } },
  transformed: false,
});

export const handler: PluginHandler<PromptCacheParameters> = async (
  context,
  parameters,
  _eventType
) => {
  try {
    const requestType = context?.requestType;
    // Only operate on Anthropic-format messages requests. OpenAI-shape
    // chatComplete requests are not supported: the OpenAI translator
    // (src/providers/openai/messages.ts) drops cache_control, and the
    // OpenAI upstream uses a different mechanism (prompt_cache_key) that
    // requires a stable identifier across requests — out of scope here.
    if (requestType !== 'messages') {
      return noop();
    }

    const fixedPrompt = parameters?.fixedPrompt;
    if (typeof fixedPrompt !== 'string' || fixedPrompt.length === 0) {
      return noop();
    }

    const applyToRole = (parameters?.applyToRole ?? 'system') as
      | 'system'
      | 'user'
      | 'assistant';
    if (!['system', 'user', 'assistant'].includes(applyToRole)) {
      return noop();
    }

    const createIfMissing = parameters?.createIfMissing ?? true;
    const addBreakpointToLastUser = parameters?.addBreakpointToLastUser ?? true;

    const requestJson = context?.request?.json;
    if (!requestJson || typeof requestJson !== 'object') {
      return noop();
    }

    const messages: any[] = Array.isArray(requestJson.messages)
      ? [...requestJson.messages]
      : [];
    let mutated = false;

    const existingIdx = messages.findIndex((m) => m?.role === applyToRole);
    if (existingIdx === -1) {
      if (!createIfMissing) {
        return noop();
      }
      const fixed = buildFixedPromptMessage(applyToRole, fixedPrompt);
      if (applyToRole === 'system') {
        messages.unshift(fixed);
      } else {
        messages.push(fixed);
      }
      mutated = true;
    } else {
      const existing = { ...messages[existingIdx] };
      existing.content = [
        {
          type: 'text',
          text: fixedPrompt,
          cache_control: { ...EPHEMERAL },
        },
      ];
      messages[existingIdx] = existing;
      mutated = true;
    }

    if (
      addBreakpointToLastUser &&
      markLastUserMessageWithBreakpoint(messages)
    ) {
      mutated = true;
    }

    return {
      error: null,
      verdict: true,
      data: null,
      transformedData: {
        request: { json: { ...requestJson, messages } },
        response: { json: null },
      },
      transformed: mutated,
    };
  } catch (e: any) {
    delete e?.stack;
    return {
      error: {
        message: 'Error in promptCache plugin: ' + (e?.message ?? String(e)),
      },
      verdict: true,
      data: null,
      transformedData: { request: { json: null }, response: { json: null } },
      transformed: false,
    };
  }
};
