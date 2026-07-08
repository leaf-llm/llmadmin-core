// No-op.
//
// The plugin registry is now loaded at runtime via `plugins/index.ts`
// (dynamic import + cache, invalidated by `clearHandlerCache()`). Toggling
// `plugins_enabled` in `conf.json` takes effect immediately without a rebuild.
//
// This script is kept as a no-op so `npm run build-plugins` and
// `npm run build:gateway:plugins` continue to succeed for any tooling
// or documentation that still references them.

export {};