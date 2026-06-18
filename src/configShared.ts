import { readFile } from 'fs/promises';

const DEFAULT_CONFIG_PATH = './conf.json';

let configPath: string | null = null;
let cachedConfig: Record<string, unknown> | null = null;

export function setConfigPath(path: string): void {
  configPath = path;
}

export function getConfigPath(): string {
  return configPath || DEFAULT_CONFIG_PATH;
}

function getDefaultConfig(): Record<string, unknown> {
  return {
    settings: {
      plugins_enabled: ['default'],
      credentials: {},
      cache: false,
      integrations: [],
    },
    gateway: {
      providers: {},
      text: { routing: [], userConfig: null },
      image: { routing: [], userConfig: null },
      video: { routing: [], userConfig: null },
      audio: { routing: [], userConfig: null },
      mcp: { routing: [], userConfig: null },
    },
    server: { port: 8700, headless: false },
  };
}

export async function loadConfig(): Promise<Record<string, unknown>> {
  const p = getConfigPath();
  try {
    const raw = await readFile(p, 'utf-8');
    cachedConfig = JSON.parse(raw) as Record<string, unknown>;
    return cachedConfig;
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      cachedConfig = getDefaultConfig();
      return cachedConfig;
    }
    throw e;
  }
}

export function getConfig(): Record<string, unknown> | null {
  return cachedConfig;
}
