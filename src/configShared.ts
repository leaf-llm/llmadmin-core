/**
 * Backwards-compatible facade over the storage layer.
 *
 * Older modules import `getConfig`, `loadConfig`, `setConfigPath` etc. from
 * here. Keeping this file means the request pipeline does not need to change
 * all at once, while storage can be file- or PostgreSQL-backed.
 */
export {
  setConfigPath,
  getConfigPath,
  getConfig,
  loadConfig,
  ensureConfigLoaded,
  getConfigVersion,
  getConfigStore,
  getStorageDriver,
  isConfigReadOnly,
  mutateConfig,
  replaceConfig,
  resetConfigStore,
  closeConfigStore,
} from './storage';
