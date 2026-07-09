// Shared types and helpers for per-plugin preset definitions.
// Each plugin that supports presets exports a `PRESETS` array of
// `PresetDefinition` objects from its own `presets.ts` file.
// The admin layer imports these helpers here to avoid duplication.

import type { HookObject } from '../src/middlewares/hooks/types';
import { HookType } from '../src/middlewares/hooks/types';

export type PresetCheck = {
  id: string; // e.g. "default.regexMatch"
  parameters: Record<string, unknown>;
};

export type PresetDefinition = {
  id: string;
  name: string;
  description: string;
  i18nKey: string;
  eventType: 'beforeRequestHook' | 'afterRequestHook';
  checks: PresetCheck[];
  deny: boolean;
  async?: boolean;
  sequential?: boolean;
};

/**
 * Build the HookObject[] entries for a given preset.
 */
export function buildHooksForPreset(preset: PresetDefinition): HookObject[] {
  return preset.checks.map((check, idx) => ({
    type: HookType.GUARDRAIL,
    id: `preset_${preset.id}_${idx}`,
    eventType: preset.eventType,
    checks: [{ id: check.id, parameters: check.parameters }],
    deny: preset.deny,
    async: preset.async ?? false,
    sequential: preset.sequential ?? false,
  }));
}

/**
 * Filter hooks to remove all belonging to a given preset.
 */
export function stripPresetFromHooks(
  hooks: HookObject[],
  presetId: string,
): HookObject[] {
  const prefix = `preset_${presetId}_`;
  return hooks.filter((h) => !h.id.startsWith(prefix));
}

/**
 * Return the preset definitions with current enabled state, determined by
 * the persisted `presets_enabled[pluginId]` list rather than scanning hooks.
 * This survives plugin disable/enable cycles — hooks are stripped from
 * `default_hooks` when the plugin is disabled but `presets_enabled` keeps
 * the user's toggle intent.
 */
export function listPresetsWithState(
  presets: PresetDefinition[],
  enabledPresetIds: string[] | undefined,
): Array<PresetDefinition & { enabled: boolean }> {
  const enabled = new Set(enabledPresetIds ?? []);
  return presets.map((p) => ({ ...p, enabled: enabled.has(p.id) }));
}
