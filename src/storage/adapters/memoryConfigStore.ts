import {
  ConfigConflictError,
  type ConfigStore,
  type LoadedConfig,
  type UnifiedConfig,
} from '../configStore';

/** In-process store used by unit tests and ephemeral demos. */
export class MemoryConfigStore implements ConfigStore {
  readonly driver = 'memory' as const;
  readonly readOnly = false;

  private doc: UnifiedConfig | null;
  private version = 0;

  constructor(initial?: UnifiedConfig) {
    this.doc = initial ? structuredClone(initial) : null;
    this.version = initial ? 1 : 0;
  }

  async load(): Promise<LoadedConfig | null> {
    if (!this.doc) return null;
    return { doc: structuredClone(this.doc), version: String(this.version) };
  }

  async save(
    doc: UnifiedConfig,
    expectedVersion?: string
  ): Promise<{ version: string }> {
    if (expectedVersion && expectedVersion !== String(this.version)) {
      throw new ConfigConflictError(undefined, String(this.version));
    }
    this.doc = structuredClone(doc);
    this.version += 1;
    return { version: String(this.version) };
  }
}
