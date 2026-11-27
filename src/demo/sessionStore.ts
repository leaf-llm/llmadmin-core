import {
  ConfigConflictError,
  type ConfigStore,
  type LoadedConfig,
  type UnifiedConfig,
} from '../storage/configStore';

/**
 * In-memory config store backing a single demo session.
 *
 * Every visitor of the demo gets one of these, so edits stay inside their own
 * sandbox: the document never touches disk, PostgreSQL, or another session.
 * The demo middleware installs it as the request-scoped store, which means the
 * existing admin routes and routing pipeline work unchanged.
 */
export class SessionConfigStore implements ConfigStore {
  readonly driver = 'memory' as const;
  readonly readOnly = false;

  private doc: UnifiedConfig;
  private version: number;

  constructor(initial: UnifiedConfig) {
    this.doc = structuredClone(initial);
    this.version = 1;
  }

  async load(): Promise<LoadedConfig> {
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
