// Static plugin handler registry.
//
// All plugin handlers are statically imported at build time so `bun build
// --compile` bundles them into a single self-contained binary. No plugin
// source files need to be shipped on disk next to the binary.
//
// Enable/disable is still runtime-toggleable via `conf.json -> settings.
// plugins_enabled` (no restart required): `getHandler(id)` consults an
// in-memory enabled-set cache that is refreshed whenever the config is
// reloaded (see `clearHandlerCache()` + `settingsStore.saveSettings()`).
//
// Idempotent: `getHandler('default.regexMatch')` returns the same function
// across calls. A disabled plugin throws a clear error on the next access.

import type { PluginHandler } from './types';
import { getConfig } from '../src/configShared';

// ---------------------------------------------------------------------------
// Static handler imports (default plugin)
// ---------------------------------------------------------------------------
import { handler as default_addPrefix } from './default/addPrefix';
import { handler as default_alllowercase } from './default/alllowercase';
import { handler as default_allowedRequestTypes } from './default/allowedRequestTypes';
import { handler as default_alluppercase } from './default/alluppercase';
import { handler as default_characterCount } from './default/characterCount';
import { handler as default_containsCode } from './default/containsCode';
import { handler as default_contains } from './default/contains';
import { handler as default_endsWith } from './default/endsWith';
import { handler as default_jsonKeys } from './default/jsonKeys';
import { handler as default_jsonSchema } from './default/jsonSchema';
import { handler as default_jwt } from './default/jwt';
import { handler as default_log } from './default/log';
import { handler as default_modelRules } from './default/modelRules';
// manifest `functions[].id` is the lowercase string "modelwhitelist" but the
// source file is camelCase `modelWhitelist.ts` - the KEY below uses the
// manifest id so it matches the check.id produced by presets/handlers.
import { handler as default_modelWhitelist } from './default/modelWhitelist';
import { handler as default_notNull } from './default/notNull';
import { handler as default_regexMatch } from './default/regexMatch';
// regexReplace is not in the default manifest but is imported for static
// reachability (tests may reference it directly).
import { handler as default_regexReplace } from './default/regexReplace';
import { handler as default_requiredMetadataKeys } from './default/requiredMetadataKeys';
import { handler as default_sentenceCount } from './default/sentenceCount';
import { handler as default_validUrls } from './default/validUrls';
import { handler as default_webhook } from './default/webhook';
import { handler as default_wordCount } from './default/wordCount';

// ---------------------------------------------------------------------------
// Static handler imports (promptcache plugin)
// ---------------------------------------------------------------------------
import { handler as promptcache_promptCache } from './promptcache/promptCache';

// ---------------------------------------------------------------------------
// Static registry - keyed by `<pluginId>.<functionId>` (e.g. "default.regexMatch")
// ---------------------------------------------------------------------------
const HANDLERS: Record<string, PluginHandler> = {
  'default.addPrefix': default_addPrefix,
  'default.alllowercase': default_alllowercase,
  'default.allowedRequestTypes': default_allowedRequestTypes,
  'default.alluppercase': default_alluppercase,
  'default.characterCount': default_characterCount,
  'default.containsCode': default_containsCode,
  'default.contains': default_contains,
  'default.endsWith': default_endsWith,
  'default.jsonKeys': default_jsonKeys,
  'default.jsonSchema': default_jsonSchema,
  'default.jwt': default_jwt,
  'default.log': default_log,
  'default.modelRules': default_modelRules,
  'default.modelwhitelist': default_modelWhitelist,
  'default.notNull': default_notNull,
  'default.regexMatch': default_regexMatch,
  'default.regexReplace': default_regexReplace,
  'default.requiredMetadataKeys': default_requiredMetadataKeys,
  'default.sentenceCount': default_sentenceCount,
  'default.validUrls': default_validUrls,
  'default.webhook': default_webhook,
  'default.wordCount': default_wordCount,
  'promptcache.promptCache': promptcache_promptCache,
};

/**
 * Cached enabled-set, rebuilt lazily from the in-memory conf.json cache.
 * Invalidated by `clearHandlerCache()` after a plugin toggle.
 */
let enabledSet: Set<string> | null = null;

function loadEnabled(): Set<string> {
  if (enabledSet) return enabledSet;
  const conf = getConfig() as
    | { settings?: { plugins_enabled?: string[] } }
    | null;
  enabledSet = new Set(conf?.settings?.plugins_enabled ?? []);
  return enabledSet;
}

/**
 * Resolve a hook id (e.g. `"default.regexMatch"`) to its handler function.
 * Synchronous - handlers are statically imported at build time.
 * Throws if the plugin is not currently enabled (per `plugins_enabled`).
 */
export function getHandler(id: string): PluginHandler {
  const [source, fn] = id.split('.');
  if (!source || !fn) {
    throw new Error(`Invalid plugin handler id: "${id}"`);
  }
  if (!loadEnabled().has(source)) {
    throw new Error(
      `Plugin "${source}" is not enabled. Enable it in the Plugins admin page (no rebuild required).`,
    );
  }
  const handler = HANDLERS[id];
  if (typeof handler !== 'function') {
    throw new Error(
      `Plugin handler "${id}" is not registered (not compiled into this binary).`,
    );
  }
  return handler;
}

/**
 * Invalidate the cached enabled-set. Call this after mutating
 * `plugins_enabled` so the next `getHandler()` re-reads the enabled set.
 * (Handlers themselves are static - nothing to clear.)
 */
export function clearHandlerCache(): void {
  enabledSet = null;
}

/**
 * Backwards-compatibility shim. The previous build-time-generated registry
 * exported a `plugins` object; any code that still imports it gets a Proxy
 * that throws on access, surfacing the migration clearly.
 *
 * New code MUST use `getHandler(id)` from this module.
 */
export const plugins = new Proxy(
  {} as Record<string, Record<string, PluginHandler>>,
  {
    get() {
      throw new Error(
        'plugins registry is now static. Use `getHandler(id)` from plugins/index.ts instead.',
      );
    },
  },
);
