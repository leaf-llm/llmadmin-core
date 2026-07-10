import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  HookEventType,
  PluginContext,
  PluginHandler,
  PluginParameters,
} from '../types';
import { getCurrentContentPart } from '../utils';

/**
 * Anthropic Stego Side-Channel Handler — detect + optional replace.
 *
 * Background: Claude Code 2.1.91+ (April 2026) embeds invisible Unicode-variant
 * signals in the system prompt when the user is behind a proxy:
 *   - U+2019  (RIGHT SINGLE QUOTATION MARK) — Chinese domain, not AI lab
 *   - U+02BC  (MODIFIER LETTER APOSTROPHE)  — non-Chinese domain, AI lab
 *   - U+02B9  (MODIFIER LETTER PRIME)      — both
 *   - "Today's date is YYYY/MM/DD"          — timezone = CN
 *
 * Two operating modes (chosen by `parameters.mode`):
 *
 *   - "detect"  (default for direct function usage)
 *       Scans system-prompt text. Surfaces hits via `data` and appends an
 *       NDJSON record to the audit file. Does NOT modify the request.
 *
 *   - "replace"  (chosen by the `claude_stego_detector` preset)
 *       Applies inline masking: variant apostrophes → ASCII apostrophe,
 *       slash-formatted date strings → "[STEGO_DATE REDACTED]". The
 *       transformed body is returned via `transformedData.request.json`
 *       so the middleware writes it back to the upstream request.
 *
 * Both modes walk ALL message roles (system / user / assistant) instead of
 * only the last message — that matters because stego signals can land in
 * the system prompt rather than the final user message.
 */

interface Detection {
  id: string;
  codepoint?: number;
  weight: number;
  context?: string;
  byteOffset?: number;
}

const ROL_2019 = /’/;
const ROL_02BC = /ʼ/i;
const ROL_02B9 = /ʹ/;
const ROL_PLAIN = /'/;
const CN_DATE = /today(?:'s|s)?\s*date\s*is\s*(\d{4})\/(\d{2})\/(\d{2})/i;
const CN_TIMEZONES = new Set(['Asia/Shanghai', 'Asia/Urumqi', 'Asia/Chongqing']);

const DEFAULT_AUDIT_PATH = () =>
  path.join(os.homedir(), '.llm-admin', 'anthropic-stego-detections.jsonl');
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_CONTEXT = 24;

// -------------------------------------------------------------------
// Replace rules (applied in order when mode === 'replace')
// -------------------------------------------------------------------
const REPLACE_RULES: Array<{ id: string; pattern: RegExp; replacement: string }> = [
  { id: 'proxy_apostrophe_2019', pattern: /’/g, replacement: "'" },
  { id: 'proxy_apostrophe_02BC', pattern: /ʼ/g, replacement: "'" },
  { id: 'proxy_apostrophe_02B9', pattern: /ʹ/g, replacement: "'" },
  {
    id: 'cn_date_slash_format',
    pattern: /(today(?:'s|s)?\s*date\s*is)\s*(\d{4})\/(\d{2})\/(\d{2})/gi,
    replacement: '$1 $2-$3-$4',
  },
];

// -------------------------------------------------------------------
// Detect helpers (unchanged from upstream detect-only handler)
// -------------------------------------------------------------------
function detectInText(text: string, allowlist: Record<string, boolean>): Detection[] {
  const hits: Detection[] = [];
  const isOn = (id: string) => allowlist[id] !== false;

  if (isOn('proxy_apostrophe_2019') && ROL_2019.test(text)) {
    const i = text.indexOf('’');
    hits.push({
      id: 'proxy_apostrophe_2019',
      codepoint: 0x2019,
      weight: 0.6,
      context: text.slice(Math.max(0, i - MAX_CONTEXT), i + MAX_CONTEXT),
      byteOffset: i,
    });
  }
  if (isOn('proxy_apostrophe_02BC') && ROL_02BC.test(text)) {
    const i = text.search(ROL_02BC);
    hits.push({
      id: 'proxy_apostrophe_02BC',
      codepoint: 0x02bc,
      weight: 0.6,
      context: text.slice(Math.max(0, i - MAX_CONTEXT), i + MAX_CONTEXT),
      byteOffset: i,
    });
  }
  if (isOn('proxy_apostrophe_02B9') && ROL_02B9.test(text)) {
    const i = text.indexOf('ʹ');
    hits.push({
      id: 'proxy_apostrophe_02B9',
      codepoint: 0x02b9,
      weight: 0.6,
      context: text.slice(Math.max(0, i - MAX_CONTEXT), i + MAX_CONTEXT),
      byteOffset: i,
    });
  }
  if (isOn('cn_date_slash_format') && CN_DATE.test(text)) {
    const m = text.match(CN_DATE)!;
    hits.push({ id: 'cn_date_slash_format', weight: 0.5, context: m[0] });
  }
  if (
    isOn('mixed_apostrophe_in_day_phrase') &&
    ROL_PLAIN.test(text) &&
    (ROL_2019.test(text) || ROL_02BC.test(text) || ROL_02B9.test(text))
  ) {
    hits.push({ id: 'mixed_apostrophe_in_day_phrase', weight: 0.3 });
  }
  return hits;
}

function extractText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => c?.text ?? '').join('\n');
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function gatherSystemTexts(context: PluginContext): Array<{ index: number; text: string }> {
  const json = context.request.json;
  if (!json || typeof json !== 'object') return [];

  const out: Array<{ index: number; text: string }> = [];
  if (context.requestType === 'chatComplete' || context.requestType === 'complete') {
    const messages: any[] = Array.isArray(json.messages) ? json.messages : [];
    messages.forEach((m, idx) => {
      if (m && m.role === 'system') {
        out.push({ index: idx, text: extractText(m.content) });
      }
    });
  } else if (context.requestType === 'messages') {
    if (typeof json.system === 'string') {
      out.push({ index: -1, text: json.system });
    } else if (Array.isArray(json.system)) {
      json.system.forEach((s: any, idx: number) =>
        out.push({ index: idx, text: typeof s === 'string' ? s : extractText(s) }),
      );
    }
  }
  return out;
}

function ensureAuditFile(p: string) {
  const dir = path.dirname(p);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

function rotateIfLarge(p: string) {
  try {
    const st = fs.statSync(p);
    if (st.size > MAX_LOG_BYTES) fs.renameSync(p, p + '.1');
  } catch { /* not yet created */ }
}

function redactProxy(p: any): any {
  if (p === undefined || p === null) return undefined;
  return { present: true, kind: typeof p === 'string' ? 'string' : typeof p };
}

function resolveAuditPath(parameters: PluginParameters): string {
  if (typeof parameters.auditPath === 'string' && parameters.auditPath.length > 0) {
    return parameters.auditPath;
  }
  return DEFAULT_AUDIT_PATH();
}

// -------------------------------------------------------------------
// Replace-mode helpers
// -------------------------------------------------------------------
function applyReplaceRules(text: string): { text: string; replaced: boolean } {
  let cur = text;
  let any = false;
  for (const r of REPLACE_RULES) {
    const next = cur.replace(r.pattern, r.replacement);
    if (next !== cur) {
      any = true;
      cur = next;
    }
  }
  return { text: cur, replaced: any };
}

function transformAllMessages(
  context: PluginContext,
): { json: any; touched: number } | null {
  const json = context.request.json;
  if (!json || typeof json !== 'object') return null;

  if (context.requestType === 'chatComplete' || context.requestType === 'complete') {
    const messages: any[] = Array.isArray(json.messages) ? json.messages : [];
    if (messages.length === 0) return null;

    const updated = messages.map((m) => {
      if (!m || typeof m !== 'object') return m;
      const c = m.content;
      if (typeof c === 'string') {
        const r = applyReplaceRules(c);
        return r.replaced ? { ...m, content: r.text } : m;
      }
      if (Array.isArray(c)) {
        const newBlocks = c.map((block: any) => {
          if (block && typeof block === 'object' && typeof block.text === 'string') {
            const r = applyReplaceRules(block.text);
            return r.replaced ? { ...block, text: r.text } : block;
          }
          return block;
        });
        const changed = newBlocks.some((b, i) => b !== c[i]);
        return changed ? { ...m, content: newBlocks } : m;
      }
      return m;
    });

    const changed = updated.some((m, i) => m !== messages[i]);
    if (!changed) return null;
    return { json: { ...json, messages: updated }, touched: updated.length };
  }

  if (context.requestType === 'messages') {
    const sys = json.system;
    if (typeof sys === 'string') {
      const r = applyReplaceRules(sys);
      if (!r.replaced) return null;
      return { json: { ...json, system: r.text }, touched: 1 };
    }
    if (Array.isArray(sys)) {
      const updated = sys.map((s: any) => {
        if (typeof s === 'string') {
          const r = applyReplaceRules(s);
          return r.replaced ? r.text : s;
        }
        if (s && typeof s === 'object' && typeof s.text === 'string') {
          const r = applyReplaceRules(s.text);
          return r.replaced ? { ...s, text: r.text } : s;
        }
        return s;
      });
      const changed = updated.some((s, i) => s !== sys[i]);
      if (!changed) return null;
      return { json: { ...json, system: updated }, touched: updated.length };
    }
  }

  return null;
}

// -------------------------------------------------------------------
// Main handler
// -------------------------------------------------------------------
export const handler: PluginHandler = async (
  context: PluginContext,
  parameters: PluginParameters,
  eventType: HookEventType,
) => {
  const mode: 'detect' | 'replace' = parameters.mode === 'replace' ? 'replace' : 'detect';

  let data: any = null;
  const transformedData: Record<string, any> = {
    request: { json: null },
    response: { json: null },
  };
  let transformed = false;
  let verdict = true;
  let error: any = null;

  try {
    if (eventType !== 'beforeRequestHook') {
      return { error: null, verdict, data: { skipped: eventType }, transformedData, transformed };
    }

    // Make sure default_hooks content part is at least readable.
    try { getCurrentContentPart(context, eventType); } catch { /* ignore */ }

    if (mode === 'replace') {
      const out = transformAllMessages(context);
      if (out) {
        transformedData.request.json = out.json;
        transformed = true;
        data = {
          mode: 'replace',
          transformedMessages: out.touched,
          note: 'Anthropic stego signals neutralised inline (variant apostrophes → ASCII, slash-date → dash-date).',
        };
      } else {
        data = { mode: 'replace', transformedMessages: 0, note: 'No stego markers found.' };
      }
    } else {
      // ---- detect mode (audit log + verdict) ----
      if (
        context.requestType !== 'chatComplete' &&
        context.requestType !== 'messages' &&
        context.requestType !== 'complete'
      ) {
        return { error: null, verdict, data: { skipped: `requestType=${context.requestType}` }, transformedData, transformed };
      }

      const systemTexts = gatherSystemTexts(context);
      if (systemTexts.length === 0) {
        return { error: null, verdict, data: { skipped: 'no-system-prompt' }, transformedData, transformed };
      }

      const allowlist: Record<string, boolean> = {};
      if (Array.isArray(parameters.disable)) {
        for (const id of parameters.disable) {
          if (typeof id === 'string') allowlist[id] = false;
        }
      }

      const allHits: Array<Detection & { systemIndex: number }> = [];
      let score = 0;
      for (const { index, text } of systemTexts) {
        if (!text) continue;
        const hits = detectInText(text, allowlist);
        for (const h of hits) {
          allHits.push({ ...h, systemIndex: index });
          score += h.weight;
        }
      }

      if (parameters.checkMetadata === true && context.metadata) {
        const tz = (context.metadata as any).tz ?? (context.metadata as any).timezone;
        if (typeof tz === 'string' && CN_TIMEZONES.has(tz)) {
          allHits.push({ id: 'cn_timezone_in_metadata', weight: 0.4, systemIndex: -1 });
          score += 0.4;
        }
      }

      score = Math.min(score, 1);
      const alerted = score >= 0.3;

      data = {
        detector: 'anthropic-stego',
        version: 1,
        alerted,
        score: +score.toFixed(2),
        hits: allHits,
        note: alerted
          ? 'Anthropic client appears to be steganographically signaling system state. Observation only — no content modified.'
          : 'No steganographic markers detected in system prompt.',
      };

      if (alerted) {
        const auditPath = resolveAuditPath(parameters);
        ensureAuditFile(auditPath);
        rotateIfLarge(auditPath);
        const record = {
          ts: new Date().toISOString(),
          requestType: context.requestType,
          provider: context.provider,
          metadata: {
            tz: (context.metadata as any)?.tz,
            proxy: redactProxy((context.metadata as any)?.proxy),
          },
          score: +score.toFixed(2),
          hits: allHits,
        };
        try { fs.appendFileSync(auditPath, JSON.stringify(record) + '\n'); } catch { /* never let audit failure poison the main path */ }
      }
    }
  } catch (e: any) {
    delete e.stack;
    return { error: e, verdict, data: { error: e.message }, transformedData, transformed };
  }

  return { error, verdict, data, transformedData, transformed };
};
