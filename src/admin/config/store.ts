import { getRuntimeKey } from 'hono/adapter';
import { stat } from 'fs/promises';

import {
  ModelCategory,
  MODEL_CATEGORIES,
  ProviderId,
} from '../types';
import { getConfig, getConfigPath, loadConfig } from '../../configShared';

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

function getDefaultUiConfig(): UiConfigFile {
  return {
    providers: {},
    text: createEmptyCategoryConfig(),
    image: createEmptyCategoryConfig(),
    video: createEmptyCategoryConfig(),
    audio: createEmptyCategoryConfig(),
    mcp: createEmptyCategoryConfig(),
  };
}

// mtime-based cache: conf.json 被任何写入者（前端、手动编辑等）修改后，
// 下次调用 loadUiConfig 会通过 stat 检测到并重新加载。
let cachedUiConfig: UiConfigFile | null = null;
let cachedMtime: number | null = null;

export async function loadUiConfig(): Promise<UiConfigFile> {
  const runtime = getRuntimeKey();
  if (runtime !== 'node' && runtime !== 'bun') {
    throw new Error('UI config store is only supported in node or bun runtime');
  }

  const configPath = getConfigPath();
  let currentMtime: number | null = null;
  try {
    const fileStat = await stat(configPath);
    currentMtime = fileStat.mtimeMs;
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
  }

  if (cachedUiConfig && cachedMtime === currentMtime) {
    return cachedUiConfig;
  }

  await loadConfig();
  const unified = getConfig() as any;
  cachedUiConfig = unified?.gateway
    ? {
        providers: unified.gateway.providers || {},
        text: unified.gateway.text,
        image: unified.gateway.image,
        video: unified.gateway.video,
        audio: unified.gateway.audio,
        mcp: unified.gateway.mcp,
      }
    : getDefaultUiConfig();
  cachedMtime = currentMtime;
  return cachedUiConfig;
}

export async function loadUserConfig(
  category: ModelCategory
): Promise<Record<string, unknown> | null> {
  const config = await loadUiConfig();
  return config[category]?.userConfig ?? null;
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
