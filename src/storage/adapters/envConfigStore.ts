import {
  ConfigReadOnlyError,
  type ConfigStore,
  type LoadedConfig,
  type UnifiedConfig,
} from '../configStore';

/**
 * Read-only driver for demos / stateless deployments where the whole config is
 * supplied through `LLMADMIN_CONFIG_JSON`. The admin UI can still read, but
 * writes return 403 instead of pretending to persist.
 */
export class EnvConfigStore implements ConfigStore {
  readonly driver = 'env' as const;
  readonly readOnly = true;

  constructor(private readonly raw: string) {}

  async load(): Promise<LoadedConfig | null> {
    try {
      return {
        doc: JSON.parse(this.raw) as UnifiedConfig,
        version: 'env',
      };
    } catch {
      throw new Error(
        'LLMADMIN_CONFIG_JSON is not valid JSON — refusing to start with a broken config'
      );
    }
  }

  async save(): Promise<{ version: string }> {
    throw new ConfigReadOnlyError(
      'LLMADMIN_CONFIG_JSON is read-only; remove CONFIG_STORE=env to edit config in the admin UI'
    );
  }
}
