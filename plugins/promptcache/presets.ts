// Preset caching strategies for the promptcache plugin.
//
// Each preset is a preconfigured set of parameters for the promptCache
// transformer. The user toggles the preset on/off in the UI; they supply
// the fixedPrompt value but all other parameters are preset.

import type { PresetDefinition } from '../presets-shared';

export const PRESETS: PresetDefinition[] = [
  {
    id: 'system_prompt_cache',
    name: 'System Prompt Caching',
    description:
      'Caches a system-level prompt across requests using Anthropic prompt caching. The fixed prompt is inserted as a system message with cache_control, and the last user message gets a cache breakpoint.',
    i18nKey: 'plugins.presets.system_prompt_cache',
    eventType: 'beforeRequestHook',
    deny: false,
    checks: [
      {
        id: 'promptcache.promptCache',
        parameters: {
          fixedPrompt: '',
          applyToRole: 'system',
          createIfMissing: true,
          addBreakpointToLastUser: true,
        },
      },
    ],
  },
  {
    id: 'document_context_cache',
    name: 'Document Context Caching',
    description:
      'Caches a long document or context block as a user-role message. Useful for RAG or document Q&A where the same reference material is sent with every request.',
    i18nKey: 'plugins.presets.document_context_cache',
    eventType: 'beforeRequestHook',
    deny: false,
    checks: [
      {
        id: 'promptcache.promptCache',
        parameters: {
          fixedPrompt: '',
          applyToRole: 'user',
          createIfMissing: true,
          addBreakpointToLastUser: true,
        },
      },
    ],
  },
];
