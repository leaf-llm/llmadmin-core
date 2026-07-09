import { readFile, writeFile } from 'fs/promises';

import { getConfig, getConfigPath, loadConfig } from '../../configShared';
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
 * Load the `settings` section of conf.json (plugins_enabled, credentials, etc.).
 * Re-reads from disk on every call so writes from other sources are picked up.
 */
export async function loadSettings(): Promise<Settings> {
  await loadConfig();
  const unified = getConfig() as { settings?: Settings } | null;
  const settings = unified?.settings;
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
        ? settings.presets_enabled as Record<string, string[]>
        : {},
  };
}

/**
 * Read-modify-write the `settings` section of conf.json, preserving the
 * `gateway` and `server` sections. Other concurrent writers could be lost
 * (no file lock) — acceptable for single-admin local use.
 */
export async function saveSettings(settings: Settings): Promise<void> {
  const configPath = getConfigPath();
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      // No existing config — write a fresh one with just settings + defaults.
      const fresh = {
        settings,
        gateway: {
          providers: {},
          text: { routing: [], userConfig: null },
          image: { routing: [], userConfig: null },
          video: { routing: [], userConfig: null },
          audio: { routing: [], userConfig: null },
          mcp: { routing: [], userConfig: null },
        },
        server: { port: 8700, headless: false },
      };
      await writeFile(configPath, JSON.stringify(fresh, null, 2), 'utf-8');
      return;
    }
    throw e;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('conf.json is not valid JSON — refusing to overwrite');
  }

  parsed.settings = settings;
  await writeFile(configPath, JSON.stringify(parsed, null, 2), 'utf-8');

  // Refresh the in-memory config cache so synchronous readers
  // (requestContext.getDefaultHooksFor, plugins/index.ts loadEnabled)
  // see updated settings immediately - no restart required.
  await loadConfig();
}
