// Runtime plugin loader.
//
// This module replaces the previous build-time-generated registry. Handlers
// are loaded lazily via dynamic `import()` and cached at module level. The
// cache (and the manifest cache) is invalidated by `clearHandlerCache()` —
// call this after mutating `conf.json → settings.plugins_enabled` so that the
// next hook call reflects the new enabled set without a gateway restart.
//
// Idempotent: `getHandler('qualifire.pii')` returns the same function across
// calls. A disabled plugin throws a clear error on the next access.

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { PluginHandler } from './types';

type Manifest = { enabled: Set<string>; functions: Record<string, string[]> };

let manifestCache: Manifest | null = null;

function loadManifests(): Manifest {
  if (manifestCache) return manifestCache;

  const confPath = resolve(process.cwd(), 'conf.json');
  const conf = JSON.parse(readFileSync(confPath, 'utf-8')) as {
    settings?: { plugins_enabled?: string[] };
  };
  const enabled = new Set(conf.settings?.plugins_enabled ?? []);

  const functions: Record<string, string[]> = {};
  for (const name of enabled) {
    try {
      const raw = readFileSync(
        resolve(process.cwd(), 'plugins', name, 'manifest.json'),
        'utf-8',
      );
      const manifest = JSON.parse(raw) as { functions?: { id: string }[] };
      functions[name] = (manifest.functions ?? []).map((f) => f.id);
    } catch {
      functions[name] = [];
    }
  }

  manifestCache = { enabled, functions };
  return manifestCache;
}

const HANDLER_CACHE = new Map<string, PluginHandler>();

function cacheKey(source: string, fn: string): string {
  return `${source}.${fn}`;
}

/**
 * Resolve a hook id (e.g. `"default.regexMatch"`) to its handler function.
 * Throws if the plugin is not currently enabled (per `plugins_enabled`).
 */
export async function getHandler(id: string): Promise<PluginHandler> {
  const { enabled } = loadManifests();
  const [source, fn] = id.split('.');
  if (!source || !fn) {
    throw new Error(`Invalid plugin handler id: "${id}"`);
  }
  if (!enabled.has(source)) {
    throw new Error(
      `Plugin "${source}" is not enabled. Enable it in the Plugins admin page (no rebuild required).`,
    );
  }

  const key = cacheKey(source, fn);
  const cached = HANDLER_CACHE.get(key);
  if (cached) return cached;

  const mod = await import(`./${source}/${fn}`);
  const handler = (mod.handler ?? mod.default) as PluginHandler;
  if (typeof handler !== 'function') {
    throw new Error(
      `Plugin handler "${id}" did not export a function (got ${typeof handler})`,
    );
  }
  HANDLER_CACHE.set(key, handler);
  return handler;
}

/**
 * Invalidate both the handler cache and the manifest cache. Call this after
 * mutating `plugins_enabled` so subsequent `getHandler()` calls re-read disk
 * and lazy-import newly enabled handlers.
 */
export function clearHandlerCache(): void {
  HANDLER_CACHE.clear();
  manifestCache = null;
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
        'plugins registry is now runtime-dynamic. Use `getHandler(id)` from plugins/index.ts instead.',
      );
    },
  },
);