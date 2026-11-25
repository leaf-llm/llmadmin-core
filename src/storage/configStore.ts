/**
 * Runtime-agnostic configuration storage contract.
 *
 * The gateway historically read `conf.json` from disk on every request. That
 * does not work on a managed web platform where the filesystem is ephemeral
 * and multiple instances may serve traffic. This interface is the seam between
 * the gateway and the storage driver (file / PostgreSQL / memory / env).
 */

export type UnifiedConfig = Record<string, any>;

export type LoadedConfig = {
  doc: UnifiedConfig;
  version: string;
};

export interface ConfigStore {
  readonly driver: 'file' | 'postgres' | 'memory' | 'env';
  readonly readOnly: boolean;
  load(): Promise<LoadedConfig | null>;
  save(doc: UnifiedConfig, expectedVersion?: string): Promise<{ version: string }>;
  close?(): Promise<void>;
}

/**
 * Thrown when a conditional write loses a race. The HTTP layer maps this to
 * 409 so clients can refetch and retry instead of silently overwriting a
 * concurrent change.
 */
export class ConfigConflictError extends Error {
  constructor(
    message = 'Configuration was modified by another writer',
    public readonly currentVersion?: string
  ) {
    super(message);
    this.name = 'ConfigConflictError';
  }
}

export class ConfigReadOnlyError extends Error {
  constructor(message = 'Configuration storage is read-only') {
    super(message);
    this.name = 'ConfigReadOnlyError';
  }
}
