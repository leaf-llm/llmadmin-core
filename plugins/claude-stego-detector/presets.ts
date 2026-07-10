// Preset for the claude-stego-detector plugin.
//
// Each preset is a preconfigured set of plugin hooks that delivers a
// complete capability. The user toggles the preset on/off in the UI;
// they do not have to fill in parameters.
//
// When this preset is enabled, its hooks are appended to
// `conf.json -> settings.default_hooks` as full HookObjects with id prefix
// `preset_<presetId>_<n>`. They are then injected by `requestContext.ts`
// into every request's hook chain (before/after as declared).
//
// The `claude_stego_detector` preset applies **detect-then-replace**
// substitution (per project requirement): the single handler in this plugin
// has a `replace` mode that walks every message in the conversation and
// replaces variant apostrophes (U+2019, U+02BC, U+02B9) with ASCII, and
// converts slash-formatted dates (YYYY/MM/DD → YYYY-MM-DD).
// The request is allowed through (deny OFF) with the signal neutralised.

import type { PresetDefinition } from '../presets-shared';

export const PRESETS: PresetDefinition[] = [
  {
    id: 'claude_stego_detector',
    name: 'Claude Stego Detector',
    description:
      'Neutralises Anthropic side-channel stego signals in requests: replaces variant apostrophes (U+2019, U+02BC, U+02B9) with ASCII apostrophes and converts slash-formatted dates (YYYY/MM/DD → YYYY-MM-DD) before the request is forwarded. The request is allowed through with the signal neutralised.',
    i18nKey: 'plugins.presets.claude_stego_detector',
    eventType: 'beforeRequestHook',
    deny: false,
    sequential: true,
    checks: [
      {
        id: 'claude-stego-detector.anthropicStegoDetector',
        parameters: { mode: 'replace' },
      },
    ],
  },
];
