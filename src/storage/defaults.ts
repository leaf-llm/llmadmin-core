/**
 * Default unified config used when no config exists yet.
 *
 * Keep this shape in sync with `conf.example.json` and the UI's
 * `createEmptyUiConfig()`; the storage layer treats it as the
 * canonical empty document for every driver.
 */
export function createDefaultUnifiedConfig(): Record<string, any> {
  const emptyCategory = () => ({ routing: [], userConfig: null });

  return {
    settings: {
      plugins_enabled: ['default'],
      credentials: {},
      cache: false,
      integrations: [],
      default_hooks: [],
      presets_enabled: {},
    },
    gateway: {
      providers: {},
      text: emptyCategory(),
      image: emptyCategory(),
      video: emptyCategory(),
      audio: emptyCategory(),
      mcp: emptyCategory(),
    },
    server: { port: 8700, headless: false },
  };
}
