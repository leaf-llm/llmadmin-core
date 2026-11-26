import {
  ensureConfigLoaded,
  getConfig,
  mutateConfig,
  resetConfigStore,
  ConfigConflictError,
} from './index';
import { MemoryConfigStore } from './adapters/memoryConfigStore';

describe('config storage', () => {
  beforeEach(() => {
    resetConfigStore(new MemoryConfigStore());
  });

  it('returns an empty default document when storage is empty', async () => {
    const loaded = await ensureConfigLoaded({ force: true });
    expect(loaded.version).toBe('0');
    expect(loaded.doc.gateway.providers).toEqual({});
    expect(getConfig()?.gateway.text.routing).toEqual([]);
  });

  it('persists a mutation and bumps the version', async () => {
    const first = await mutateConfig((doc) => ({
      ...doc,
      settings: { ...doc.settings, cache: true },
    }));
    expect(first.version).toBe('1');
    expect(first.doc.settings.cache).toBe(true);

    const reloaded = await ensureConfigLoaded({ force: true });
    expect(reloaded.doc.settings.cache).toBe(true);
    expect(reloaded.version).toBe('1');
  });

  it('rejects a stale conditional write', async () => {
    await mutateConfig((doc) => ({ ...doc, settings: { ...doc.settings, cache: true } }));
    await expect(
      mutateConfig(() => ({ settings: {} }), '0')
    ).rejects.toBeInstanceOf(ConfigConflictError);
  });

  it('retries internal mutations after a concurrent writer', async () => {
    const store = new MemoryConfigStore({
      settings: { plugins_enabled: ['default'] },
      gateway: { providers: {} },
    });
    resetConfigStore(store);
    await ensureConfigLoaded({ force: true });

    // Simulate another process writing between load and save by wrapping save.
    const originalSave = store.save.bind(store);
    let injected = false;
    (store as any).save = async (doc: any, expected?: string) => {
      if (!injected) {
        injected = true;
        await originalSave(
          { ...doc, settings: { ...doc.settings, cache: false } },
          expected
        );
      }
      return originalSave(doc, expected);
    };

    const result = await mutateConfig((doc) => ({
      ...doc,
      settings: { ...doc.settings, cache: true },
    }));
    expect(result.doc.settings.cache).toBe(true);
    expect(injected).toBe(true);
  });
});
