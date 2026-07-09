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
      'Detects email addresses, phone numbers (CN), ID card numbers, credit card numbers, and common API keys in requests. Detected values are masked (replaced with a placeholder) before forwarding; the request is allowed through.',
    i18nKey: 'plugins.presets.pii_detection',
    eventType: 'beforeRequestHook',
    deny: false,
    checks: [
      // Email
      {
        id: 'default.regexReplace',
        parameters: {
          rule: '\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b',
          redactText: '[EMAIL REDACTED]',
        },
      },
      // CN mobile
      {
        id: 'default.regexReplace',
        parameters: {
          rule: '\\b1[3-9]\\d{9}\\b',
          redactText: '[PHONE REDACTED]',
        },
      },
      // CN ID card (18 digits, last may be X)
      {
        id: 'default.regexReplace',
        parameters: {
          rule: '\\b\\d{17}[\\dXx]\\b',
          redactText: '[ID_CARD REDACTED]',
        },
      },
      // Credit card (16 digits)
      {
        id: 'default.regexReplace',
        parameters: {
          rule: '\\b(?:\\d[ -]*){13,16}\\b',
          redactText: '[CARD REDACTED]',
        },
      },
      // API keys: OpenAI sk-/sk-ant-, Stripe pk_/sk_/rk_, Google AIza,
      // GitHub ghp_/gho_/ghu_/ghs_/ghr_, AWS AKIA/ASIA, Slack xox[baprs]-,
      // Hugging Face hf_, Replicate r8_, Groq gsk_
      {
        id: 'default.regexReplace',
        parameters: {
          rule:
            '\\b(?:sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|pk_(?:live|test)_[A-Za-z0-9]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|rk_(?:live|test)_[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{35}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|hf_[A-Za-z0-9]{20,}|r8_[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,})\\b',
          redactText: '[API_KEY REDACTED]',
        },
      },
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
          operator: 'none',
        },
      },
    ],
  },
  {
    id: 'url_safety_ssrf',
    name: 'SSRF Guard',
    description:
      'Detects URLs that point to internal/private network ranges (loopback, link-local, private IPv4, cloud metadata IP, IPv6 loopback / ULA). These typically indicate an SSRF or prompt-injection attempt to make the upstream LLM reach internal services. The request is denied if any such URL is found.',
    i18nKey: 'plugins.presets.url_safety_ssrf',
    eventType: 'beforeRequestHook',
    deny: true,
    checks: [
      // Private / loopback hostnames
      {
        id: 'default.regexMatch',
        parameters: {
          rule:
            '\\bhttps?://(?:localhost|ip6-localhost|ip6-loopback|0\\.0\\.0\\.0|broadcasthost)\\b',
          not: false,
        },
      },
      // IPv4 loopback 127.0.0.0/8
      {
        id: 'default.regexMatch',
        parameters: {
          rule: '\\bhttps?://127\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\b',
          not: false,
        },
      },
      // Private IPv4 10.0.0.0/8
      {
        id: 'default.regexMatch',
        parameters: {
          rule:
            '\\bhttps?://10\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\b',
          not: false,
        },
      },
      // Private IPv4 172.16.0.0/12
      {
        id: 'default.regexMatch',
        parameters: {
          rule:
            '\\bhttps?://172\\.(?:1[6-9]|2[0-9]|3[01])\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\b',
          not: false,
        },
      },
      // Private IPv4 192.168.0.0/16
      {
        id: 'default.regexMatch',
        parameters: {
          rule:
            '\\bhttps?://192\\.168\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\b',
          not: false,
        },
      },
      // Link-local 169.254.0.0/16 (includes AWS/GCP/Azure metadata 169.254.169.254)
      {
        id: 'default.regexMatch',
        parameters: {
          rule:
            '\\bhttps?://169\\.254\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\b',
          not: false,
        },
      },
      // IPv4 unspecified 0.0.0.0
      {
        id: 'default.regexMatch',
        parameters: {
          rule: '\\bhttps?://0\\.0\\.0\\.0\\b',
          not: false,
        },
      },
      // IPv6 loopback ::1
      {
        id: 'default.regexMatch',
        parameters: {
          rule: '\\bhttps?://\\[?::1\\]?\\b',
          not: false,
        },
      },
      // IPv6 link-local fe80::/10
      {
        id: 'default.regexMatch',
        parameters: {
          rule: '\\bhttps?://\\[?fe80:[0-9a-fA-F:]+(\\b|\\]/?)',
          not: false,
        },
      },
      // IPv6 unique-local fc00::/7
      {
        id: 'default.regexMatch',
        parameters: {
          rule: '\\bhttps?://\\[?[fF][cdCD][0-9a-fA-F:]+(\\b|\\]/?)',
          not: false,
        },
      },
    ],
  },
  {
    id: 'url_safety_blacklist',
    name: 'URL Blacklist',
    description:
      'Detects common URL-shortener services (bit.ly, tinyurl.com, t.co, etc.) and known high-risk TLDs (.xyz, .top, .click, .tk, .ml, etc.) in the request. Matched URLs are masked (replaced with a placeholder) before forwarding; the request is allowed through.',
    i18nKey: 'plugins.presets.url_safety_blacklist',
    eventType: 'beforeRequestHook',
    deny: false,
    checks: [
      // URL shorteners and link-masking services
      {
        id: 'default.regexReplace',
        parameters: {
          rule:
            '\\bhttps?://(?:[a-z0-9-]+\\.)?(?:bit\\.ly|tinyurl\\.com|t\\.co|goo\\.gl|ow\\.ly|is\\.gd|buff\\.ly|adf\\.ly|cutt\\.ly|rebrand\\.ly|shorturl\\.at|tiny\\.cc|rb\\.gy|v\\.gd|lnkd\\.in|trib\\.al|soo\\.gd|qr\\.ae|shorte\\.st|clck\\.ru|tr\\.im|shorturl\\.com|mcaf\\.ee|po\\.st|1url\\.com|x\\.co|youtu\\.be)\\b[^\\s]*',
          redactText: '[SHORT_URL REDACTED]',
        },
      },
      // High-risk / commonly-abused TLDs
      {
        id: 'default.regexReplace',
        parameters: {
          rule:
            '\\bhttps?://[a-z0-9.-]+\\.(?:xyz|top|click|tk|ml|cf|gq|loan|work|review|country|stream|download|men|cyou|rest|monster|zip|mom|wang|win|bid|date|trade|racing|account|faith|host|press|cc|ws|su|icu|fun|app|dev|ovh|art|biz|info|name|pro|pw|red|loan)(?:[/?#][^\\s]*)?',
          redactText: '[RISKY_TLD REDACTED]',
        },
      },
    ],
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
          operator: 'none',
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
