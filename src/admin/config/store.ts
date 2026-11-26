import { ModelCategory, ProviderId } from '../types';
import {
  ensureConfigLoaded,
  getConfigVersion,
  mutateConfig,
  type UnifiedConfig,
} from '../../storage';

export const SUPPORTED_PROVIDERS: ProviderId[] = [
  'openai',
  'anthropic',
  'google',
  'zhipu',
  'dashscope',
  'moonshot',
  'minimax',
  'doubao',
  'deepseek',
  'openai-compatible',
  'anthropic-compatible',
];

type ProviderConfig = {
  id: string;
  apiKey?: string;
  baseUrl?: string;
  baseUrlAnthropic?: string;
  lastSyncedAt?: string;
  remark?: string;
  apiFormat?: 'openai' | 'anthropic';
};

type CategoryConfig = {
  routing: RoutingEntry[];
  userConfig: Record<string, unknown> | null;
};

type RoutingEntry = {
  provider: ProviderId;
  model: string;
  configId: string;
  isPrimary: boolean;
};

type UiConfigFile = {
  providers: Record<ProviderId, ProviderConfig[]>;
} & Record<ModelCategory, CategoryConfig>;

export type { ProviderConfig, CategoryConfig, RoutingEntry, UiConfigFile };

function createEmptyCategoryConfig(): CategoryConfig {
  return { routing: [], userConfig: null };
}

export function getDefaultUiConfig(): UiConfigFile {
  return {
    providers: {},
    text: createEmptyCategoryConfig(),
    image: createEmptyCategoryConfig(),
    video: createEmptyCategoryConfig(),
    audio: createEmptyCategoryConfig(),
    mcp: createEmptyCategoryConfig(),
  };
}

function normalizeCategory(value: any): CategoryConfig {
  return {
    routing: Array.isArray(value?.routing) ? value.routing : [],
    userConfig:
      value?.userConfig && typeof value.userConfig === 'object'
        ? value.userConfig
        : null,
  };
}

export function normalizeUiConfig(gateway: any): UiConfigFile {
  const defaults = getDefaultUiConfig();
  return {
    ...defaults,
    ...(gateway && typeof gateway === 'object' ? gateway : {}),
    providers:
      gateway?.providers && typeof gateway.providers === 'object'
        ? gateway.providers
        : {},
    text: normalizeCategory(gateway?.text),
    image: normalizeCategory(gateway?.image),
    video: normalizeCategory(gateway?.video),
    audio: normalizeCategory(gateway?.audio),
    mcp: normalizeCategory(gateway?.mcp),
  };
}

/**
 * Load the gateway section of the unified config. The storage layer owns
 * caching / freshness; this function only maps to the UI shape.
 */
export async function loadUiConfig(): Promise<UiConfigFile> {
  const loaded = await ensureConfigLoaded();
  return normalizeUiConfig(loaded.doc.gateway);
}

export async function loadUnifiedConfig(): Promise<{
  doc: UnifiedConfig;
  version: string;
}> {
  const loaded = await ensureConfigLoaded();
  return { doc: loaded.doc, version: loaded.version };
}

export async function loadUserConfig(
  category: ModelCategory
): Promise<Record<string, unknown> | null> {
  const config = await loadUiConfig();
  return config[category]?.userConfig ?? null;
}

/**
 * Persist only the gateway block, preserving settings/server and any unknown
 * top-level keys. This is the write path used by the provider/routing pages.
 */
export async function saveUiConfig(
  gateway: UiConfigFile
): Promise<UiConfigFile> {
  const next = await mutateConfig((doc) => ({
    ...doc,
    gateway,
  }));
  return normalizeUiConfig(next.doc.gateway);
}

/**
 * Persist a complete unified document (settings + gateway + server). Used by
 * the Settings raw editor and by config import. Unknown top-level keys already
 * in storage are preserved unless the caller replaces the whole document.
 */
export async function saveUnifiedConfig(
  unified: UnifiedConfig,
  expectedVersion?: string
): Promise<{ version: string }> {
  const next = await mutateConfig(
    (doc) => ({
      ...doc,
      ...unified,
    }),
    expectedVersion
  );
  return { version: next.version };
}

export async function replaceUnifiedConfig(
  unified: UnifiedConfig,
  expectedVersion?: string
): Promise<{ version: string }> {
  const next = await mutateConfig(() => unified, expectedVersion);
  return { version: next.version };
}

export async function clearGatewayConfig(
  category?: ModelCategory
): Promise<UiConfigFile> {
  const next = await mutateConfig((doc) => {
    const gateway = normalizeUiConfig(doc.gateway);
    if (category) {
      gateway[category] = createEmptyCategoryConfig();
    } else {
      return { ...doc, gateway: getDefaultUiConfig() };
    }
    return { ...doc, gateway };
  });
  return normalizeUiConfig(next.doc.gateway);
}

export async function getProviderCredentialsForBilling(
  provider: ProviderId
): Promise<{
  apiKey?: string;
  baseUrl?: string;
  lastSyncedAt?: string;
} | null> {
  if (!SUPPORTED_PROVIDERS.includes(provider)) return null;
  const config = await loadUiConfig();
  const configs = config.providers?.[provider];
  const p = configs?.[0];
  if (p) {
    return {
      apiKey: p.apiKey,
      baseUrl: p.baseUrl,
      lastSyncedAt: p.lastSyncedAt,
    };
  }
  return null;
}

export { getConfigVersion };
