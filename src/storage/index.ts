import { AsyncLocalStorage } from 'node:async_hooks';

import {
  ConfigReadOnlyError,
  ConfigConflictError,
  type ConfigStore,
  type LoadedConfig,
  type UnifiedConfig,
} from './configStore';
import { createDefaultUnifiedConfig } from './defaults';
import { FileConfigStore } from './adapters/fileConfigStore';
import { MemoryConfigStore } from './adapters/memoryConfigStore';
import { EnvConfigStore } from './adapters/envConfigStore';
import { PostgresConfigStore } from './adapters/postgresConfigStore';

export type { UnifiedConfig, LoadedConfig, ConfigStore };
export { ConfigConflictError, ConfigReadOnlyError };

const DEFAULT_CONFIG_PATH = './conf.json';

let configPathOverride: string | null = null;
let store: ConfigStore | null = null;

/**
 * Request-scoped storage override.
 *
 * Demo mode serves every visitor from the same process, but each visitor owns
 * an isolated configuration document. Rather than threading a store argument
 * through every handler, the demo middleware runs the request inside this
 * scope and all storage helpers below transparently resolve to that store.
 *
 * AsyncLocalStorage keeps concurrent requests from seeing each other's store,
 * including across `await` boundaries.
 */
const requestScope = new AsyncLocalStorage<ConfigStore>();

type StoreCache = {
  loaded: LoadedConfig | null;
  loadedAt: number;
  inFlight: Promise<LoadedConfig> | null;
};

let cache = new WeakMap<ConfigStore, StoreCache>();

function cacheFor(target: ConfigStore): StoreCache {
  let entry = cache.get(target);
  if (!entry) {
    entry = { loaded: null, loadedAt: 0, inFlight: null };
    cache.set(target, entry);
  }
  return entry;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function setConfigPath(path: string): void {
  configPathOverride = path;
  resetConfigStore();
}

export function getConfigPath(): string {
  return (
    configPathOverride || process.env.CONFIG_PATH?.trim() || DEFAULT_CONFIG_PATH
  );
}

/**
 * The store that should serve the current call. Demo sessions install their
 * own store through `withConfigStore`; everything else uses the process-wide
 * driver built from the environment.
 */
export function getConfigStore(): ConfigStore {
  const scoped = requestScope.getStore();
  if (scoped) return scoped;

  if (store) return store;

  const requested = (process.env.CONFIG_STORE || 'auto').toLowerCase();
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (requested === 'postgres' || (requested === 'auto' && databaseUrl)) {
    if (!databaseUrl) {
      throw new Error(
        'CONFIG_STORE=postgres requires DATABASE_URL to be set'
      );
    }
    store = new PostgresConfigStore(databaseUrl);
    return store;
  }

  if (requested === 'env') {
    const raw = process.env.LLMADMIN_CONFIG_JSON?.trim();
    if (!raw) {
      throw new Error(
        'CONFIG_STORE=env requires LLMADMIN_CONFIG_JSON to be set'
      );
    }
    store = new EnvConfigStore(raw);
    return store;
  }

  if (requested === 'memory') {
    store = new MemoryConfigStore();
    return store;
  }

  store = new FileConfigStore(getConfigPath());
  return store;
}

/** The store installed for the current request, if any. */
export function getScopedConfigStore(): ConfigStore | undefined {
  return requestScope.getStore();
}

/**
 * Run `fn` with `nextStore` as the config store for the duration of the call.
 * Used by the demo sandbox; regular deployments never call this.
 */
export function withConfigStore<T>(
  nextStore: ConfigStore,
  fn: () => T
): T {
  return requestScope.run(nextStore, fn);
}

export function getStorageDriver(): ConfigStore['driver'] {
  return getConfigStore().driver;
}

export function isConfigReadOnly(): boolean {
  return getConfigStore().readOnly;
}

/** Test seam: swap the driver and clear the in-process cache. */
export function resetConfigStore(next?: ConfigStore): void {
  store = next ?? null;
  cache = new WeakMap();
}

function cacheTtlMs(target: ConfigStore = getConfigStore()): number {
  const configured = process.env.CONFIG_CACHE_TTL_MS;
  if (configured !== undefined && configured !== '') {
    return positiveInt(configured, 1000);
  }
  return target.driver === 'postgres' ? 5000 : 1000;
}

/**
 * Ensure the in-process cache is populated. Single-flight so a cold start with
 * concurrent requests only performs one database read.
 */
export async function ensureConfigLoaded(
  options: { force?: boolean } = {}
): Promise<LoadedConfig> {
  const target = getConfigStore();
  const entry = cacheFor(target);
  const force = options.force === true;
  if (!force && entry.loaded && Date.now() - entry.loadedAt < cacheTtlMs(target)) {
    return entry.loaded;
  }

  if (!entry.inFlight) {
    entry.inFlight = (async () => {
      const loaded = await target.load();
      entry.loaded = loaded ?? {
        doc: createDefaultUnifiedConfig(),
        version: '0',
      };
      entry.loadedAt = Date.now();
      return entry.loaded;
    })().finally(() => {
      entry.inFlight = null;
    });
  }

  return entry.inFlight;
}

/** Synchronous read of the already-loaded cache. */
export function getConfig(): UnifiedConfig | null {
  return cache.get(getConfigStore())?.loaded?.doc ?? null;
}

export function getConfigVersion(): string | null {
  return cache.get(getConfigStore())?.loaded?.version ?? null;
}

/** Force a reload from storage and return the document. */
export async function loadConfig(): Promise<UnifiedConfig> {
  const loaded = await ensureConfigLoaded({ force: true });
  return loaded.doc;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read-modify-write with optimistic concurrency.
 *
 * When the caller supplies an expected version (HTTP If-Match), conflicts are
 * surfaced immediately. Internal callers omit it and get a short retry loop so
 * two admin toggles do not clobber each other.
 */
export async function mutateConfig(
  mutator: (current: UnifiedConfig) => UnifiedConfig,
  expectedVersion?: string
): Promise<LoadedConfig> {
  const target = getConfigStore();
  if (target.readOnly) {
    throw new ConfigReadOnlyError();
  }

  const entry = cacheFor(target);
  let attempt = 0;
  for (;;) {
    const current = await ensureConfigLoaded({ force: true });
    const base = structuredClone(current.doc);
    const next = mutator(base) ?? base;
    const expected = expectedVersion ?? current.version;

    try {
      const saved = await target.save(next, expected);
      entry.loaded = { doc: next, version: saved.version };
      entry.loadedAt = Date.now();
      return entry.loaded;
    } catch (e) {
      if (
        e instanceof ConfigConflictError &&
        !expectedVersion &&
        attempt < 3
      ) {
        attempt += 1;
        await sleep(25 * attempt);
        continue;
      }
      throw e;
    }
  }
}

/** Replace the whole document, preserving nothing. */
export async function replaceConfig(
  doc: UnifiedConfig,
  expectedVersion?: string
): Promise<LoadedConfig> {
  return mutateConfig(() => doc, expectedVersion);
}

export async function closeConfigStore(): Promise<void> {
  if (store?.close) {
    await store.close();
  }
  store = null;
  cache = new WeakMap();
}
