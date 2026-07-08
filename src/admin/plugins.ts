import { readdir, readFile, stat } from 'fs/promises';
import { resolve, dirname } from 'path';

import { loadSettings, saveSettings, type PluginCredentials } from './config/settingsStore';
import { clearHandlerCache } from '../../plugins';
import {
  buildHooksForPreset,
  stripPresetFromHooks,
  listPresetsWithState,
  type PresetDefinition,
} from '../../plugins/presets-shared';

// ---------------------------------------------------------------------------
// Types exposed to the admin endpoint
// ---------------------------------------------------------------------------

export type PluginFunctionSummary = {
  id: string;
  name: string;
  type: 'guardrail' | 'transformer';
  description: string;         // normalised to flat string
  supportedHooks: string[];
};

export type PluginSummary = {
  id: string;                  // registry key / folder name (e.g. 'panw-prisma-airs')
  manifestId: string;          // manifest's `id` field (may differ, e.g. 'panwPrismaAirs')
  description: string;         // normalised to flat string
  type: 'guardrail' | 'transformer';
  enabled: boolean;
  credentialsRequired: boolean;
  hasCredentials: boolean;
  credentialsSchema: Record<string, unknown> | null;
  functions: PluginFunctionSummary[];
  presets: Array<PresetDefinition & { enabled: boolean }> | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the plugins directory.
 *
 * In dev mode (`bun run`) the CWD is src-gateway/ so `process.cwd() +
 * 'plugins'` works. In desktop / compiled-binary mode the CWD is
 * unpredictable, so we fall back to the directory of the running binary.
 */
function pluginsDir(): string {
  // If CWD contains a `plugins` subdirectory, use it (dev mode).
  const cwdPlugins = resolve(process.cwd(), 'plugins');
  try {
    // statSync is fine here — cheap, called once per request, blocks ok.
    const { statSync } = require('fs');
    if (statSync(cwdPlugins).isDirectory()) return cwdPlugins;
  } catch { /* cwd has no plugins dir */ }

  // Fall back to the binary's directory (compiled desktop mode).
  return resolve(dirname(process.argv[0]), 'plugins');
}

/**
 * Flatten a polymorphic description field (string | array of {type,text} objects)
 * into a single plain-text string.
 */
function flattenDescription(desc: unknown): string {
  if (typeof desc === 'string') return desc;
  if (Array.isArray(desc)) {
    return desc
      .map((item: { text?: string }) => item?.text ?? '')
      .join(' ')
      .trim();
  }
  return '';
}

/**
 * Determine whether a `credentials` schema has any required fields, and whether
 * a given credentials object satisfies those requirements.
 */
function analyseCredentials(
  schema: unknown,
  current: PluginCredentials | undefined,
): { required: boolean; satisfied: boolean } {
  if (!schema || typeof schema !== 'object') {
    return { required: false, satisfied: true };
  }
  const s = schema as Record<string, unknown>;
  if ((s.type as string) !== 'object') {
    return { required: false, satisfied: true };
  }
  const properties = s.properties as Record<string, unknown> | undefined;
  const required = (s.required as string[]) ?? [];
  const propertiesCount = properties ? Object.keys(properties).length : 0;

  if (propertiesCount === 0 && required.length === 0) {
    // Empty schema — no credentials needed (e.g. promptfoo)
    return { required: false, satisfied: true };
  }

  // We only handle top-level string properties for credential checking
  const allSatisfied = required.every((key) => {
    const value = current?.[key];
    return typeof value === 'string' && value.trim().length > 0;
  });

  return { required: required.length > 0, satisfied: allSatisfied };
}

/**
 * Determine whether a plugin is a "transformer" (vs guardrail) based on its
 * function types. A plugin is `transformer` only if ALL its functions are
 * transformers; otherwise (mixed or all guardrail) it is treated as `guardrail`.
 */
function pluginType(functions: PluginFunctionSummary[]): 'guardrail' | 'transformer' {
  if (functions.length === 0) return 'guardrail';
  return functions.every((f) => f.type === 'transformer') ? 'transformer' : 'guardrail';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all plugins found on disk, annotated with current enabled/credentials
 * state from conf.json.
 */
export async function listPlugins(): Promise<PluginSummary[]> {
  const dir = pluginsDir();

  let entries: string[];
  try {
    entries = await readdir(dir, { withFileTypes: false });
  } catch {
    // plugins directory does not exist — return empty list
    return [];
  }

  const settings = await loadSettings();

  // Lazy-init: if an enabled plugin has never had its presets initialised,
  // auto-enable its default starting set so the user sees presets active
  // from the very first boot. An explicit empty array means the user has
  // already made choices.
  {
    let changed = false;
    for (const pluginId of settings.plugins_enabled) {
      const defaults = PLUGIN_DEFAULT_PRESETS[pluginId];
      if (!defaults || settings.presets_enabled?.[pluginId] !== undefined) continue;
      settings.presets_enabled = settings.presets_enabled ?? {};
      settings.presets_enabled[pluginId] = [...defaults];
      changed = true;
      try {
        const mod = await import(`../../plugins/${pluginId}/presets`);
        let hooks = settings.default_hooks ?? [];
        for (const presetId of defaults) {
          const preset = mod.PRESETS.find((p: PresetDefinition) => p.id === presetId);
          if (preset) {
            hooks = stripPresetFromHooks(hooks, presetId);
            hooks = [...hooks, ...buildHooksForPreset(preset)];
          }
        }
        settings.default_hooks = hooks;
      } catch {
        // plugin has no presets module — shouldn't happen
      }
    }
    if (changed) await saveSettings(settings);
  }

  const enabledSet = new Set(settings.plugins_enabled);
  const allCredentials = settings.credentials;

  const results: PluginSummary[] = [];

  for (const name of entries) {
    // Skip non-directories and hidden files
    if (name.startsWith('.') || name === 'node_modules') continue;

    const manifestPath = resolve(dir, name, 'manifest.json');
    let manifestStat;
    try {
      manifestStat = await stat(manifestPath);
    } catch {
      continue; // no manifest.json in this folder
    }
    if (!manifestStat.isFile()) continue;

    let manifest: Record<string, unknown>;
    try {
      const raw = await readFile(manifestPath, 'utf-8');
      manifest = JSON.parse(raw);
    } catch {
      continue; // invalid JSON
    }

    const enabled = enabledSet.has(name);
    const currentCredentials = allCredentials[name];

    // Parse functions
    const rawFunctions = (manifest.functions as unknown[]) ?? [];
    const functions: PluginFunctionSummary[] = rawFunctions
      .filter((f): f is Record<string, unknown> => f != null && typeof f === 'object')
      .map((f) => ({
        id: String(f.id ?? ''),
        name: String(f.name ?? ''),
        type: (f.type === 'transformer' ? 'transformer' : 'guardrail') as 'guardrail' | 'transformer',
        description: flattenDescription(f.description),
        supportedHooks: Array.isArray(f.supportedHooks)
          ? f.supportedHooks.map(String)
          : [],
      }));

    const creds = analyseCredentials(manifest.credentials, currentCredentials);

    // Dynamically load per-plugin presets if the plugin has a presets.ts
    let pluginPresets: Array<PresetDefinition & { enabled: boolean }> | null = null;
    try {
      const mod = await import(`../../plugins/${name}/presets`);
      if (mod.PRESETS) {
        pluginPresets = listPresetsWithState(mod.PRESETS, settings.presets_enabled?.[name]);
      }
    } catch {
      // plugin has no presets.ts — that's fine
    }

    results.push({
      id: name,
      manifestId: String(manifest.id ?? name),
      description: flattenDescription(manifest.description),
      type: pluginType(functions),
      enabled,
      credentialsRequired: creds.required,
      hasCredentials: creds.satisfied,
      credentialsSchema: (manifest.credentials as Record<string, unknown> | null) ?? null,
      functions,
      presets: pluginPresets,
    });
  }

  // Sort: enabled plugins first, then alphabetically
  results.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  return results;
}

/**
 * Add or remove a plugin from the enabled list in conf.json. The runtime
 * registry is loaded dynamically (see plugins/index.ts), so toggling takes
 * effect on the next request — no rebuild or restart required.
 */
/** Presets auto-enabled the first time each plugin is activated. */
const PLUGIN_DEFAULT_PRESETS: Record<string, string[]> = {
  default: ['pii_detection', 'prompt_injection', 'url_safety'],
  promptcache: ['system_prompt_cache'],
};

export async function setPluginEnabled(
  id: string,
  enabled: boolean,
): Promise<{ ok: boolean; rebuildRequired: boolean }> {
  const settings = await loadSettings();

  if (enabled) {
    if (!settings.plugins_enabled.includes(id)) {
      settings.plugins_enabled.push(id);
    }
    // Restore preset hooks from presets_enabled so the user's prior toggle
    // choices take effect immediately when the plugin is re-enabled.
    // If this is the first time the plugin is being activated (no prior
    // toggle state at all), auto-enable its default starting set.
    // An explicit empty array means the user has already made choices.
    let enabledPresetIds = settings.presets_enabled?.[id];
    if (enabledPresetIds === undefined) {
      const defaults = PLUGIN_DEFAULT_PRESETS[id];
      if (defaults) {
        enabledPresetIds = [...defaults];
        settings.presets_enabled = settings.presets_enabled ?? {};
        settings.presets_enabled[id] = enabledPresetIds;
      }
    }
    if (enabledPresetIds && enabledPresetIds.length > 0) {
      try {
        const mod = await import(`../../plugins/${id}/presets`);
        let hooks = settings.default_hooks ?? [];
        for (const presetId of enabledPresetIds) {
          const preset = mod.PRESETS.find((p: PresetDefinition) => p.id === presetId);
          if (preset) {
            hooks = stripPresetFromHooks(hooks, presetId);
            hooks = [...hooks, ...buildHooksForPreset(preset)];
          }
        }
        settings.default_hooks = hooks;
      } catch {
        // Plugin has no presets module — nothing to restore
      }
    }
  } else {
    settings.plugins_enabled = settings.plugins_enabled.filter((p) => p !== id);
    // Strip all preset hooks belonging to this plugin from default_hooks so
    // they stop executing. The user's toggle choices are preserved in
    // presets_enabled and will be restored when the plugin is re-enabled.
    const enabledPresetIds = settings.presets_enabled?.[id] ?? [];
    if (enabledPresetIds.length > 0) {
      let hooks = settings.default_hooks ?? [];
      for (const presetId of enabledPresetIds) {
        hooks = stripPresetFromHooks(hooks, presetId);
      }
      settings.default_hooks = hooks;
    }
  }

  await saveSettings(settings);
  // Invalidate the runtime handler cache so newly enabled handlers are
  // re-imported on next request, and disabled handlers throw on next call.
  clearHandlerCache();
  return { ok: true, rebuildRequired: false };
}

/**
 * Replace the credentials for a given plugin in conf.json.
 * Credentials are read at runtime, so this takes effect immediately (no rebuild needed).
 */
export async function setPluginCredentials(
  id: string,
  credentials: PluginCredentials,
): Promise<{ ok: boolean }> {
  const settings = await loadSettings();
  settings.credentials = settings.credentials ?? {};
  settings.credentials[id] = credentials;
  await saveSettings(settings);
  return { ok: true };
}

/**
 * Enable or disable a preset. Enabling appends the preset's hooks to
 * `settings.default_hooks` (idempotent - won't duplicate if already there).
 * Disabling strips all hooks with the `preset_<presetId>_*` id prefix.
 *
 * The `default` plugin must be in `plugins_enabled` for the hooks to actually
 * execute at runtime - if not, we still write the config but return a hint.
 */
export async function setPresetEnabled(
  pluginId: string,
  presetId: string,
  enabled: boolean,
): Promise<{ ok: boolean; defaultPluginEnabled: boolean }> {
  let mod: { PRESETS: PresetDefinition[] };
  try {
    mod = await import(`../../plugins/${pluginId}/presets`);
  } catch {
    throw new Error(`Plugin "${pluginId}" has no presets`);
  }
  const preset = mod.PRESETS.find((p) => p.id === presetId);
  if (!preset) {
    throw new Error(`Unknown preset: ${presetId}`);
  }

  const settings = await loadSettings();
  let hooks = settings.default_hooks ?? [];
  // Always strip first, to ensure idempotency on enable.
  hooks = stripPresetFromHooks(hooks, presetId);

  // Persist the user's toggle intent in presets_enabled so it survives
  // plugin disable/enable cycles.
  const pe = settings.presets_enabled ?? {};
  const pluginPresets = pe[pluginId] ?? [];

  if (enabled) {
    hooks = [...hooks, ...buildHooksForPreset(preset)];
    if (!pluginPresets.includes(presetId)) {
      pe[pluginId] = [...pluginPresets, presetId];
    }
  } else {
    pe[pluginId] = pluginPresets.filter((id) => id !== presetId);
  }

  settings.default_hooks = hooks;
  settings.presets_enabled = pe;
  await saveSettings(settings);

  return {
    ok: true,
    defaultPluginEnabled: settings.plugins_enabled.includes('default'),
  };
}
