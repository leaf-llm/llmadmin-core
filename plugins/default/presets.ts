// Preset security bundles for the default plugin.
//
// Each preset is a preconfigured set of plugin hooks that delivers a
// complete security capability (PII detection, prompt injection defense,
// content moderation, etc). The user toggles the preset on/off in the UI;
// they never have to fill in parameters.
//
// When a preset is enabled, its hooks are appended to
// `conf.json -> settings.default_hooks` as full HookObjects with id prefix
// `preset_<presetId>_<n>`. They are then injected by `requestContext.ts`
// into every request's hook chain (before/after as declared).

import type { PresetDefinition } from '../presets-shared';

export const PRESETS: PresetDefinition[] = [
  {
    id: 'pii_detection',
    name: 'PII Detection',
    description:
      'Detects email addresses, phone numbers (CN), ID card numbers, credit card numbers, and SSN-like patterns in requests. Requests containing PII are denied.',
    i18nKey: 'plugins.presets.pii_detection',
    eventType: 'beforeRequestHook',
    deny: true,
    checks: [
      // Email
      {
        id: 'default.regexMatch',
        parameters: {
          rule: '\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b',
          not: false,
        },
      },
      // CN mobile
      { id: 'default.regexMatch', parameters: { rule: '\\b1[3-9]\\d{9}\\b', not: false } },
      // CN ID card (18 digits, last may be X)
      { id: 'default.regexMatch', parameters: { rule: '\\b\\d{17}[\\dXx]\\b', not: false } },
      // Credit card (16 digits)
      { id: 'default.regexMatch', parameters: { rule: '\\b(?:\\d[ -]*){13,16}\\b', not: false } },
      // SSN-like (US)
      { id: 'default.regexMatch', parameters: { rule: '\\b\\d{3}-\\d{2}-\\d{4}\\b', not: false } },
    ],
  },
  {
    id: 'prompt_injection',
    name: 'Prompt Injection Defense',
    description:
      'Blocks common prompt-injection phrasing like "ignore previous instructions", "disregard the above", "you are now", etc. Requests containing these phrases are denied.',
    i18nKey: 'plugins.presets.prompt_injection',
    eventType: 'beforeRequestHook',
    deny: true,
    checks: [
      {
        id: 'default.contains',
        parameters: {
          words: [
            'ignore previous instructions',
            'ignore the above instructions',
            'disregard the above',
            'disregard previous instructions',
            'forget your instructions',
            'forget previous instructions',
            'override previous',
            'override your instructions',
            'you are now',
            'new instructions:',
            'system prompt:',
            'system:',
            'reveal your system prompt',
            'reveal your instructions',
            'print your instructions',
            'show me your prompt',
          ],
          operator: 'or',
        },
      },
    ],
  },
  {
    id: 'url_safety',
    name: 'URL Safety',
    description:
      'Validates that any URL in the request resolves to a real DNS record. Mitigates SSRF and phishing-link injection. Does not deny - logs only.',
    i18nKey: 'plugins.presets.url_safety',
    eventType: 'beforeRequestHook',
    deny: false,
    checks: [{ id: 'default.validUrls', parameters: { onlyDNS: false, not: false } }],
  },
  {
    id: 'content_moderation',
    name: 'Content Moderation',
    description:
      'Detects common profanity, hate-speech markers, and explicit content keywords. Requests containing these terms are denied. Uses a curated keyword list; extend by editing conf.json.',
    i18nKey: 'plugins.presets.content_moderation',
    eventType: 'beforeRequestHook',
    deny: true,
    checks: [
      {
        id: 'default.contains',
        parameters: {
          words: [
            'fuck',
            'shit',
            'bitch',
            'asshole',
            'dick',
            'cunt',
            'nigger',
            'faggot',
            'retard',
            'whore',
            'slut',
          ],
          operator: 'or',
        },
      },
    ],
  },
  {
    id: 'length_limit',
    name: 'Length Limit',
    description:
      'Rejects requests longer than 1000 words or 10000 characters. Protects against prompt-stuffing and excessive-token attacks.',
    i18nKey: 'plugins.presets.length_limit',
    eventType: 'beforeRequestHook',
    deny: true,
    checks: [
      { id: 'default.wordCount', parameters: { maxWords: 1000, not: false } },
      { id: 'default.characterCount', parameters: { maxCharacters: 10000, not: false } },
    ],
  },
];
