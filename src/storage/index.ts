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

let cached: LoadedConfig | null = null;
let cacheLoadedAt = 0;
let inFlight: Promise<LoadedConfig> | null = null;

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

export function getStorageDriver(): ConfigStore['driver'] {
  return getConfigStore().driver;
}

export function isConfigReadOnly(): boolean {
  return getConfigStore().readOnly;
}

/**
 * Build (once) the configured storage driver.
 *
 * `auto` prefers PostgreSQL when DATABASE_URL is present, otherwise the local
 * JSON file. Production deployments should set CONFIG_STORE=postgres
 * explicitly so a missing database variable fails loudly instead of silently
 * falling back to ephemeral disk.
 */
export function getConfigStore(): ConfigStore {
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

/** Test seam: swap the driver and clear the in-process cache. */
export function resetConfigStore(next?: ConfigStore): void {
  store = next ?? null;
  cached = null;
  cacheLoadedAt = 0;
  inFlight = null;
}

function cacheTtlMs(): number {
  const configured = process.env.CONFIG_CACHE_TTL_MS;
  if (configured !== undefined && configured !== '') {
    return positiveInt(configured, 1000);
  }
  return getConfigStore().driver === 'postgres' ? 5000 : 1000;
}

/**
 * Ensure the in-process cache is populated. Single-flight so a cold start with
 * concurrent requests only performs one database read.
 */
export async function ensureConfigLoaded(
  options: { force?: boolean } = {}
): Promise<LoadedConfig> {
  const force = options.force === true;
  if (!force && cached && Date.now() - cacheLoadedAt < cacheTtlMs()) {
    return cached;
  }

  if (!inFlight) {
    inFlight = (async () => {
      const loaded = await getConfigStore().load();
      cached = loaded ?? {
        doc: createDefaultUnifiedConfig(),
        version: '0',
      };
      cacheLoadedAt = Date.now();
      return cached;
    })().finally(() => {
      inFlight = null;
    });
  }

  return inFlight;
}

/** Synchronous read of the already-loaded cache. */
export function getConfig(): UnifiedConfig | null {
  return cached?.doc ?? null;
}

export function getConfigVersion(): string | null {
  return cached?.version ?? null;
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
  const configStore = getConfigStore();
  if (configStore.readOnly) {
    throw new ConfigReadOnlyError();
  }

  let attempt = 0;
  for (;;) {
    const current = await ensureConfigLoaded({ force: true });
    const base = structuredClone(current.doc);
    const next = mutator(base) ?? base;
    const expected = expectedVersion ?? current.version;

    try {
      const saved = await configStore.save(next, expected);
      cached = { doc: next, version: saved.version };
      cacheLoadedAt = Date.now();
      return cached;
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
  cached = null;
  cacheLoadedAt = 0;
  inFlight = null;
}
