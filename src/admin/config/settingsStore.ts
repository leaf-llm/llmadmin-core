import { ensureConfigLoaded, mutateConfig } from '../../storage';
import type { HookObject } from '../../middlewares/hooks/types';

export type PluginCredentials = Record<string, string>;

export type Settings = {
  plugins_enabled: string[];
  credentials: Record<string, PluginCredentials>;
  cache?: boolean;
  integrations?: unknown[];
  default_hooks?: HookObject[];
  /** Which presets the user has toggled on, per plugin. Persisted across
   *  plugin disable/enable cycles so presets come back automatically. */
  presets_enabled?: Record<string, string[]>;
};

function getDefaultSettings(): Settings {
  return {
    plugins_enabled: ['default'],
    credentials: {},
    cache: false,
    integrations: [],
    default_hooks: [],
    presets_enabled: {},
  };
}

/**
 * Load the `settings` section of the unified config.
 */
export async function loadSettings(): Promise<Settings> {
  const loaded = await ensureConfigLoaded();
  const settings = (loaded.doc.settings ?? null) as Settings | null;
  if (!settings) {
    return getDefaultSettings();
  }
  return {
    plugins_enabled: Array.isArray(settings.plugins_enabled)
      ? settings.plugins_enabled
      : getDefaultSettings().plugins_enabled,
    credentials:
      settings.credentials && typeof settings.credentials === 'object'
        ? settings.credentials
        : {},
    cache: typeof settings.cache === 'boolean' ? settings.cache : false,
    integrations: Array.isArray(settings.integrations)
      ? settings.integrations
      : [],
    default_hooks: Array.isArray(settings.default_hooks)
      ? settings.default_hooks
      : [],
    presets_enabled:
      settings.presets_enabled && typeof settings.presets_enabled === 'object'
        ? (settings.presets_enabled as Record<string, string[]>)
        : {},
  };
}

/**
 * Read-modify-write the `settings` section through the storage layer's
 * optimistic-concurrency path. Preserves gateway/server and unknown keys.
 */
export async function saveSettings(settings: Settings): Promise<void> {
  await mutateConfig((doc) => ({
    ...doc,
    settings,
  }));
}
