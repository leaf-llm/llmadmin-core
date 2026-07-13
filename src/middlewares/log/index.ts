import { Context } from 'hono';
import { getRuntimeKey } from 'hono/adapter';

let logId = 0;
const MAX_RESPONSE_LENGTH = 100000;
const MAX_METRICS_AGE_DAYS = 90;

// Map to store all connected log clients
const logClients: Map<string | number, any> = new Map();

type LogClientMode = 'log' | 'counts';
type LogClient = {
  sendLog: (message: any) => Promise<unknown> | unknown;
  mode?: LogClientMode;
};

const isLogClient = (c: any): c is LogClient => c && typeof c.sendLog === 'function';

// In-memory metrics store: date string (YYYY-MM-DD) -> provider -> metrics
export type ProviderMetrics = {
  total: number;
  success: number;
  failure: number;
  inputTokens: number;
  outputTokens: number;
  cacheInputTokens: number;
};
export type DailyMetrics = Map<string, ProviderMetrics>; // provider -> metrics
export const metricsStore: Map<string, DailyMetrics> = new Map();

function getDateKey(date: Date = new Date()): string {
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// ---- Persistence ----

let _metricsSavePath: string | null = null;
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

async function _getFs() {
  const { join } = await import('path');
  const { writeFile, readFile, mkdir } = await import('fs/promises');
  return { join, writeFile, readFile, mkdir };
}

async function getMetricsPath(): Promise<string> {
  if (_metricsSavePath) return _metricsSavePath;
  const { join } = await _getFs();
  _metricsSavePath = join(
    process.env.HOME || '',
    '.llm-admin',
    'metrics.json'
  );
  return _metricsSavePath;
}

type MetricsStoreSerialized = Record<
  string,
  Record<string, ProviderMetrics>
>;

function serializeStore(): MetricsStoreSerialized {
  const data: MetricsStoreSerialized = {};
  metricsStore.forEach((dailyProviders, dateKey) => {
    const providers: Record<string, ProviderMetrics> = {};
    dailyProviders.forEach((metrics, provider) => {
      providers[provider] = { ...metrics };
    });
    data[dateKey] = providers;
  });
  return data;
}

function deserializeStore(data: MetricsStoreSerialized) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_METRICS_AGE_DAYS);

  for (const [dateKey, providers] of Object.entries(data)) {
    if (new Date(dateKey) < cutoff) continue;
    const dailyProviders: DailyMetrics = new Map();
    for (const [provider, metrics] of Object.entries(providers)) {
      dailyProviders.set(provider, {
        total: metrics.total ?? 0,
        success: metrics.success ?? 0,
        failure: metrics.failure ?? 0,
        inputTokens: metrics.inputTokens ?? 0,
        outputTokens: metrics.outputTokens ?? 0,
        cacheInputTokens: metrics.cacheInputTokens ?? 0,
      });
    }
    if (dailyProviders.size > 0) {
      metricsStore.set(dateKey, dailyProviders);
    }
  }
}

// Debounced save (at most once per 5 seconds)
function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(async () => {
    _saveTimer = null;
    try {
      const { writeFile, mkdir } = await _getFs();
      const path = await getMetricsPath();
      const dir = path.substring(0, path.lastIndexOf('/'));
      await mkdir(dir, { recursive: true });
      const serialized = serializeStore();
      await writeFile(path, JSON.stringify(serialized, null, 2), 'utf-8');
    } catch {
      // Silently ignore persistence errors — metrics are non-critical
    }
  }, 5000);
}

async function loadPersistedMetrics() {
  const runtime = getRuntimeKey();
  if (runtime !== 'node' && runtime !== 'bun') return;

  try {
    const { readFile } = await _getFs();
    const path = await getMetricsPath();
    const raw = await readFile(path, 'utf-8');
    const data: MetricsStoreSerialized = JSON.parse(raw);
    if (data && typeof data === 'object') {
      deserializeStore(data);
    }
  } catch {
    // File doesn't exist yet or is corrupt — start with empty store
  }
}

// Load persisted data on module init
loadPersistedMetrics();

function getProvider(metrics: any): string {
  return metrics?.providerOptions?.provider || 'unknown';
}

export function extractTokens(
  response: any,
  provider: string
): { inputTokens: number; outputTokens: number; cacheInputTokens: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheInputTokens = 0;

  // Try OpenAI format first (prompt_tokens, completion_tokens)
  if (response?.usage?.prompt_tokens !== undefined) {
    inputTokens = response.usage.prompt_tokens || 0;
    outputTokens = response.usage.completion_tokens || 0;
    // OpenAI: { prompt_tokens_details: { cached_tokens: N } }
    cacheInputTokens = response.usage.prompt_tokens_details?.cached_tokens || 0;
  }
  // Anthropic format (input_tokens, output_tokens)
  else if (response?.usage?.input_tokens !== undefined) {
    inputTokens = response.usage.input_tokens || 0;
    outputTokens = response.usage.output_tokens || 0;
    // Anthropic reports cache hits/writes in dedicated fields
    cacheInputTokens =
      response.usage.cache_read_input_tokens ||
      response.usage.cache_creation_input_tokens ||
      0;
  }
  // Google format (promptTokenCount, candidatesTokenCount)
  else if (response?.usageMetadata?.promptTokenCount !== undefined) {
    inputTokens = response.usageMetadata.promptTokenCount || 0;
    outputTokens = response.usageMetadata.candidatesTokenCount || 0;
    cacheInputTokens = response.usageMetadata.cachedContentTokenCount || 0;
  }

  return { inputTokens, outputTokens, cacheInputTokens };
}

function extractFromSSE(text: string): Record<string, any> | null {
  if (text.length < 10) return null;
  const lines = text.split('\n');
  let usage: Record<string, any> | null = null;
  let content = '';
  let reasoning = '';
  let model = '';
  const toolCalls: Record<number, { name: string; arguments: string }> = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
    const jsonStr = line.substring(5).trim();
    if (!jsonStr) continue;
    try {
      const parsed = JSON.parse(jsonStr);

      // --- Model name ---
      if (!model) {
        model = parsed.model || parsed.message?.model || '';
      }

      // --- Usage (take the last one seen) ---
      if (parsed?.usage && typeof parsed.usage === 'object') {
        usage = parsed.usage;
      }
      if (parsed?.delta?.usage && typeof parsed.delta.usage === 'object') {
        usage = parsed.delta.usage;
      }

      // --- OpenAI-style content & reasoning ---
      const delta = parsed?.choices?.[0]?.delta;
      if (typeof delta?.content === 'string') {
        content += delta.content;
      }
      if (typeof delta?.reasoning_content === 'string') {
        reasoning += delta.reasoning_content;
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) toolCalls[idx] = { name: '', arguments: '' };
          if (tc.function?.name) toolCalls[idx].name = tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
        }
      }

      // --- Anthropic SSE events ---
      if (parsed.type === 'content_block_delta' && parsed.delta) {
        const ad = parsed.delta;
        if (ad.type === 'text_delta' && typeof ad.text === 'string') {
          content += ad.text;
        }
        if (ad.type === 'thinking_delta' && typeof ad.thinking === 'string') {
          reasoning += ad.thinking;
        }
        if (ad.type === 'input_json_delta' && typeof ad.partial_json === 'string') {
          const idx = parsed.index ?? 0;
          if (!toolCalls[idx]) toolCalls[idx] = { name: '', arguments: '' };
          toolCalls[idx].arguments += ad.partial_json;
        }
      }
      if (
        parsed.type === 'content_block_start' &&
        parsed.content_block?.type === 'tool_use'
      ) {
        const idx = parsed.index ?? 0;
        if (!toolCalls[idx]) toolCalls[idx] = { name: '', arguments: '' };
        toolCalls[idx].name = parsed.content_block.name || '';
      }
    } catch {
      // Not valid JSON, skip
    }
  }

  if (!usage && !content && !reasoning && Object.keys(toolCalls).length === 0) {
    return null;
  }

  const result: Record<string, any> = {};
  if (model) result.model = model;
  if (content || reasoning || Object.keys(toolCalls).length > 0) {
    const msg: Record<string, any> = {};
    if (content) msg.content = content;
    if (reasoning) msg.reasoning_content = reasoning;
    if (Object.keys(toolCalls).length > 0) {
      msg.tool_calls = Object.entries(toolCalls)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([idx, tc]) => ({
          index: Number(idx),
          function: { name: tc.name, arguments: tc.arguments },
        }));
    }
    result.choices = [{ message: msg }];
  }
  if (usage) result.usage = usage;
  return result;
}

function extractUsageFromSSE(text: string): Record<string, any> | null {
  if (text.length < 10 || !text.includes('"usage"')) return null;
  const lines = text.split('\n');
  // Walk backwards to find the last meaningful SSE data chunk (usually has usage)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
    const jsonStr = line.substring(5).trim();
    if (!jsonStr) continue;
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed?.usage && typeof parsed.usage === 'object') {
        // OpenAI: { prompt_tokens, completion_tokens, total_tokens }
        if (parsed.usage.prompt_tokens !== undefined || parsed.usage.completion_tokens !== undefined) {
          return { usage: parsed.usage };
        }
        // Anthropic SSE delta might have usage_info
        if (parsed.usage.input_tokens !== undefined || parsed.usage.output_tokens !== undefined) {
          return { usage: parsed.usage };
        }
      }
      // Anthropic message_delta event: { usage: { output_tokens: N } }
      if (parsed?.delta?.usage || parsed?.usage) {
        const u = parsed.delta?.usage || parsed.usage;
        if (u.output_tokens !== undefined || u.input_tokens !== undefined) {
          return { usage: u };
        }
      }
    } catch {
      // Not valid JSON, keep looking
    }
  }
  return null;
}

async function tryReadStreamUsage(c: any): Promise<Record<string, any> | null> {
  try {
    const cloned = c.res.clone();
    // Limit read to 5 MB to prevent unbounded buffering
    const reader = cloned.body?.getReader();
    if (!reader) return null;
    const chunks: string[] = [];
    let totalSize = 0;
    const maxSize = 5 * 1024 * 1024;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = typeof value === 'string' ? value : new TextDecoder().decode(value);
      chunks.push(text);
      totalSize += text.length;
      if (totalSize > maxSize) break;
    }
    const fullText = chunks.join('');
    return extractFromSSE(fullText) || extractUsageFromSSE(fullText);
  } catch {
    return null;
  }
}

export function getCurrentTotals() {
  return {
    success: runtimeSuccess,
    failure: runtimeFailure,
    total: runtimeSuccess + runtimeFailure,
  };
}

let runtimeSuccess = 0;
let runtimeFailure = 0;

export function _resetRuntimeCountsForTest() {
  runtimeSuccess = 0;
  runtimeFailure = 0;
}

export function recordMetrics(status: number, requestOptionsArray: any[]) {
  const dateKey = getDateKey();
  const provider = getProvider(requestOptionsArray[requestOptionsArray.length - 1] || {});

  let dailyProviders = metricsStore.get(dateKey);
  if (!dailyProviders) {
    dailyProviders = new Map();
    metricsStore.set(dateKey, dailyProviders);
  }

  let metrics = dailyProviders.get(provider);
  if (!metrics) {
    metrics = {
      total: 0,
      success: 0,
      failure: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheInputTokens: 0,
    };
    dailyProviders.set(provider, metrics);
  }

  metrics.total++;
  if (status >= 200 && status < 300) {
    metrics.success++;
    runtimeSuccess++;
  } else {
    metrics.failure++;
    runtimeFailure++;
  }

  // Extract tokens from response if available
  const response = requestOptionsArray[requestOptionsArray.length - 1]?.response;
  if (response && typeof response === 'object') {
    const tokens = extractTokens(response, provider);
    metrics.inputTokens += tokens.inputTokens;
    metrics.outputTokens += tokens.outputTokens;
    metrics.cacheInputTokens += tokens.cacheInputTokens;
  }

  // Persist to disk (debounced)
  scheduleSave();
}

export const addLogClient = (clientId: any, client: LogClient) => {
  logClients.set(clientId, client);
};

export const removeLogClient = (clientId: any) => {
  logClients.delete(clientId);
};

const sendToClients = async (
  message: any,
  predicate: (client: LogClient) => boolean,
) => {
  const deadClients: any = [];

  await Promise.all(
    Array.from(logClients.entries()).map(async ([id, client]) => {
      if (!isLogClient(client) || !predicate(client)) return;
      try {
        await Promise.race([
          client.sendLog(message),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Send timeout')), 1000)
          ),
        ]);
      } catch (error: any) {
        console.error(`Failed to send log to client ${id}:`, error.message);
        deadClients.push(id);
      }
    })
  );

  deadClients.forEach((id: any) => {
    removeLogClient(id);
  });
};

const QUIET_LOG = process.argv.includes('--quiet-log');

const broadcastLog = async (log: any) => {
  if (QUIET_LOG) return;
  const message = {
    data: log,
    event: 'log',
    id: String(logId++),
  };
  await sendToClients(message, (c) => c.mode === undefined || c.mode === 'log');
};

export const broadcastCounts = async () => {
  const totals = getCurrentTotals();
  const message = {
    data: JSON.stringify(totals),
    event: 'counts',
    id: String(logId++),
  };
  await sendToClients(message, (c) => c.mode === 'counts');
};

async function processLog(c: Context, start: number) {
  const ms = Date.now() - start;
  if (!c.req.url.includes('/v1/')) return;

  const requestOptionsArray = c.get('requestOptions') || [];

  let response: any;
  let responseStatus = c.res?.status || 0;

  try {
    const isStreaming =
      requestOptionsArray.length > 0 &&
      requestOptionsArray[requestOptionsArray.length - 1].requestParams?.stream;

    if (isStreaming) {
      // Streaming response — extract content + usage from SSE.
      // Must call clone() BEFORE any other clone() since ReadableStream can only be teed once.
      const streamData = await tryReadStreamUsage(c);
      response = streamData || { message: 'The response was a stream.' };
    } else if (c.res) {
      // Non-streaming — read full JSON response.
      try {
        response = await c.res.clone().json();
      } catch {
        response = { message: 'Response body could not be parsed' };
      }
    } else {
      response = { message: 'Response not available' };
    }

    const responseString = JSON.stringify(response);
    if (requestOptionsArray.length > 0 && responseString.length > MAX_RESPONSE_LENGTH) {
      requestOptionsArray[requestOptionsArray.length - 1].response =
        responseString.substring(0, MAX_RESPONSE_LENGTH) + '...';
    } else if (requestOptionsArray.length > 0) {
      requestOptionsArray[requestOptionsArray.length - 1].response = response;
    }

    // Ensure raw_response is captured for non-streaming responses:
    // if the handler didn't store the original upstream response body, fall back
    // to the final gateway response. Skipped for streaming since the SSE stream
    // cannot provide the original upstream response format.
    if (!isStreaming && requestOptionsArray.length > 0 && response) {
      const lastEntry = requestOptionsArray[requestOptionsArray.length - 1];
      if (!lastEntry.originalResponse || lastEntry.originalResponse.body == null) {
        lastEntry.originalResponse = { body: response };
      }
    }
  } catch (error) {
    console.error('Error processing log:', error);
    response = { message: 'Error reading response' };
  }

  await broadcastLog(
    JSON.stringify({
      time: new Date().toLocaleString(),
      method: c.req.method,
      endpoint: c.req.url.split(':8700')[1],
      targetUrl: requestOptionsArray[requestOptionsArray.length - 1]?.providerOptions?.requestURL || '',
      status: responseStatus,
      duration: ms,
      requestOptions: requestOptionsArray,
    })
  );

  if (requestOptionsArray.length > 0) {
    recordMetrics(responseStatus, requestOptionsArray);
  }

  // Push a fresh aggregate snapshot to any counts-mode SSE client.
  await broadcastCounts();
}

export const logHandler = () => {
  return async (c: Context, next: any) => {
    c.set('addLogClient', addLogClient);
    c.set('removeLogClient', removeLogClient);

    const start = Date.now();

    await next();

    const runtime = getRuntimeKey();

    if (runtime == 'workerd') {
      c.executionCtx.waitUntil(processLog(c, start));
    } else if (['node', 'bun', 'deno'].includes(runtime)) {
      processLog(c, start).then().catch(console.error);
    }
  };
};
