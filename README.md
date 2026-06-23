# llmadmin-core

> OpenAI- and Anthropic-compatible LLM gateway, self-hosted, with a built-in local admin.

> **📌 This project is a fork of [Portkey AI Gateway](https://github.com/Portkey-AI/gateway).**
> `llmadmin-core` is built on top of the original Portkey open-source release and continues from there — it adds a local admin with metrics, the new unified `settings`+`gateway` config schema, per-modality routing, and Anthropic-compatible protocol translation out of the box. We are grateful to the Portkey team for the foundation; all upstream credit remains in [`LICENSE`](./LICENSE) and in the file headers.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Forked from Portkey](https://img.shields.io/badge/fork-Portkey%20AI%20Gateway-blue)](https://github.com/Portkey-AI/gateway)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

English | [中文](./README.zh-CN.md)

---

## Why `llmadmin-core`?

`llmadmin-core` is a focused fork of [Portkey AI Gateway](https://github.com/Portkey-AI/gateway). On top of the upstream code we:

- **Added first-class dual-protocol support.** The same gateway serves both `/v1/chat/completions` (OpenAI shape) and `/v1/messages` (Anthropic shape), with transparent cross-format translation so a client speaking either protocol can be routed to any upstream — including Anthropic-native providers reached via OpenAI-shape requests and vice versa.
- **Hardened the test suite.** Tightened the unit/integration coverage for the request lifecycle, the protocol translator, the conditional router, and the metric store, so the behaviors we promise in the Features section stay stable across releases.
- **Reworked the config schema.** Replaced the legacy top-level `plugins_enabled` + `integrations[]` layout with a unified `settings` + `gateway` block, adding per-modality routing tables (`text` / `image` / `video` / `audio` / `mcp`), per-provider config entries with `apiKey` / `baseUrl` / `baseUrlAnthropic` / `lastSyncedAt` / `remark`, and a `userConfig.strategy` block that drives `fallback` vs. `loadbalance` dispatch at runtime. See [`conf.example.json`](./conf.example.json) for the full shape.

## Features

- **Unified interface.** One endpoint per protocol, one config schema, one set of handlers. ~80 providers are wired in the same shape, so adding a new model or swapping an upstream doesn't change the client. See [`src/handlers/`](./src/handlers/) for the per-protocol entrypoints and [`src/providers/`](./src/providers/) for the provider adapters.
- **Dual protocol support.** `/v1/chat/completions` (OpenAI shape) and `/v1/messages` (Anthropic shape) are both first-class. Cross-format translation lives in [`src/providers/openai/messages.ts`](./src/providers/openai/messages.ts) — the entry points are [`src/handlers/chatCompletionsHandler.ts`](./src/handlers/chatCompletionsHandler.ts) and [`src/handlers/messagesHandler.ts`](./src/handlers/messagesHandler.ts).
- **Custom model routing.** Declarative fallback and load-balance strategies via [`src/services/conditionalRouter.ts`](./src/services/conditionalRouter.ts). Per-modality routing tables (`text` / `image` / `video` / `audio` / `mcp`), per-provider custom hosts, and a `userConfig.strategy` block that decides what runs in fallback vs. load-balance mode. Add a row to `gateway.text.routing` and a matching entry in `gateway.providers` to onboard a new model.
- **Usage statistics.** Per-day per-provider counts (requests, success/failure, input/output tokens, cache tokens where supported) recorded by [`src/middlewares/log/index.ts`](./src/middlewares/log/index.ts) and surfaced through the local admin. Data stays on the host — no external SaaS, no telemetry egress.
- **Streaming.** OpenAI and Anthropic SSE formats both supported, with chunked compression in [`src/handlers/streamHandler.ts`](./src/handlers/streamHandler.ts).

### Coming soon

- **Step-level intelligent routing** — route individual steps of an agent loop (not just the whole request) to the best-fit model.
- **Prompt caching** — first-class cache layer for repeated prompts. The provider-side primitives are already wired (`prompt_cache_key`, `cache_creation_input_tokens`, `cache_read_input_tokens`); the routing layer is the next milestone.

## Quickstart

Prerequisites: Node.js ≥ 18, and an API key for at least one provider.

```bash
# 1. Copy the example config and fill in your keys
cp conf.example.json conf.json
$EDITOR conf.json

# 2. Install dependencies
npm install

# 3. Run the gateway (Node) — listens on http://localhost:8700
npm run dev:node
# or, if you have Bun:
bun run dev:node
```

Talk to it with the OpenAI SDK:

```bash
curl http://localhost:8700/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

…or with the Anthropic SDK:

```bash
curl http://localhost:8700/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-5-sonnet-latest",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

Sanity check the admin:

```bash
curl http://localhost:8700/admin/health
```

> **Note:** `conf.json` is gitignored. The example file `conf.example.json` is the source of truth for the schema — copy it, then edit.

## Dual protocol in detail

Both protocols are first-class. The translator in [`src/providers/openai/messages.ts`](./src/providers/openai/messages.ts) (~1,000 lines) handles the round-trip — request and response — in both directions.

What's translated automatically:

- **System messages** ↔ top-level `system` field
- **Tool / function schemas** — OpenAI `tools` ↔ Anthropic `tools`, including streaming tool-use events
- **Image content blocks** — OpenAI `image_url` ↔ Anthropic `image` source
- **Stop reasons** — `stop`, `length`, `tool_use` / `tool_calls`, `content_filter`
- **Usage objects** — `prompt_tokens` / `completion_tokens` ↔ `input_tokens` / `output_tokens` (+ cache tokens where supported)
- **Stream event shapes** — OpenAI `data: {...}` SSE ↔ Anthropic `event: ...\ndata: ...` SSE (`message_start`, `content_block_start`, `content_block_delta`, `message_delta`, `message_stop`)

You can mix and match: a client sending the OpenAI shape can be routed to an Anthropic-native upstream, and vice versa, with no client changes.

## Configuration

The config file (`conf.json`, gitignored) has three top-level blocks:

- **`settings`** — plugin enablement, cache toggle, legacy integrations list.
- **`gateway.providers`** — per-provider config entries: `id`, `apiKey`, `baseUrl`, optional `baseUrlAnthropic` (for providers that speak the Anthropic protocol on a custom host), `lastSyncedAt`, free-form `remark`.
- **`gateway.<modality>.routing`** — per-modality routing table (`text`, `image`, `video`, `audio`, `mcp`). Each row pins a `(provider, model, configId)` triple and marks whether it is a primary.
- **`gateway.<modality>.userConfig`** — runtime strategy: `fallback` (with `on_status_codes`) or `loadbalance`, and the resolved `targets` array used to dispatch requests.
- **`server`** — listen port and headless flag.

Plugins listed in `settings.plugins_enabled` augment request handling. The `default` plugin is required and provides retries, fallbacks, and load balancing. The remaining plugins are guardrails (e.g. `aporia`, `sydelabs`, `pillar`, `patronus`, `pangea`, `promptsecurity`, `panw-prisma-airs`, `walledai`).

See [`conf.example.json`](./conf.example.json) for the full annotated shape.

## Supported providers

Providers fall into two tiers.

### Fully tested (UI-configurable)

These are the providers the local admin UI knows how to configure. They appear in [`SUPPORTED_PROVIDERS`](./src/admin/config/store.ts) and are the ones we actively run end-to-end smoke tests against on every release. **If you are picking a provider to start with, pick one from this list.**

- `openai` — OpenAI shape upstream, with full **Anthropic transform** so an Anthropic-protocol client can be routed to it transparently. Also covers any OpenAI-compatible host via `baseUrl`.
- `anthropic` — Anthropic shape upstream, with full **OpenAI transform** so an OpenAI-protocol client can be routed to it transparently.
- `google` — OpenAI shape upstream (via Google's OpenAI-compatible endpoint), with full **Anthropic transform** so an Anthropic-protocol client can be routed to it transparently.
- `zhipu` — OpenAI, Anthropic (Zhipu / GLM)
- `dashscope` — OpenAI, Anthropic (Alibaba DashScope / Qwen)
- `moonshot` — OpenAI, Anthropic (Moonshot Kimi)
- `minimax` — OpenAI, Anthropic (MiniMax endpoint family)
- `doubao` — OpenAI, Anthropic (ByteDance Volcengine Ark / Doubao)
- `deepseek` — OpenAI, Anthropic

### Other integrations

Every other folder under `src/providers/` (other than the two shared protocol bases `open-ai-base/` and `anthropic-base/`) is also a working provider adapter, but they are **not** surfaced in the local admin UI and are not part of the release-test matrix. You can still use them by listing the folder name in your `conf.json` integration block, but expect rough edges and PR them upstream if you find issues.

- **More hyperscalers / direct APIs:** `azure-openai`, `bedrock`, `google-vertex-ai`, `google-openai`, `azure-ai-inference`, `workers-ai`, `sagemaker`, `lambda`
- **More Anthropic-compatible / aggregators:** `openrouter`, `lingyi`, `mistral-ai`, `z-ai`, `krutrim`, `cerebras`, `groq`, `fireworks-ai`, `together-ai`, `hyperbolic`, `lepton`, `novita-ai`, `nebius`, `kluster-ai`, `ovhcloud`, `nscale`, `oracle`, `cometapi`, `iointelligence`, `siliconflow`, `predibase`, `sambanova`, `inference-net`
- **Open-source / self-hosted:** `ollama`, `huggingface`, `x-ai`, `replicate`, `cohere`, `ai21`, `deepinfra`, `anyscale`, `palm`, `perplexity-ai`, `voyage`, `jina`, `nomic`, `milvus`, `qdrant`, `upstage`, `cortex`, `featherless-ai`, `lemonfox-ai`, `monsterapi`, `deepbricks`, `ncompass`, `nextbit`, `matterai`, `modal`, `triton`, `bytez`, `aibadgr`, `reka-ai`, `segmind`, `302ai`
- **Image / 3D / audio:** `stability-ai`, `recraft-ai`, `tripo3d`, `meshy`

To add a provider from this tier to the UI list, edit [`SUPPORTED_PROVIDERS`](./src/admin/config/store.ts) and follow the [Adding a new provider integration](./CONTRIBUTING.md#adding-a-new-provider-integration) guide.

## Contributing

We welcome PRs of any size. Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, project layout, how to add a new provider integration, and the PR process.

## Security

If you discover a vulnerability, please see [SECURITY.md](./SECURITY.md) for private reporting instructions. **Do not** open a public issue for security bugs.

## License

[MIT](./LICENSE) — Copyright Portkey, Inc. (2024) and LLM Admin (2026), with thanks to the Portkey Gateway project from which this is derived.
