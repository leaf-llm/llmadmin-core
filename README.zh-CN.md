# llmadmin-core

> 同时兼容 OpenAI 与 Anthropic 协议的 LLM 网关，自托管，内置本地管理界面与用量统计。

> **📌 本项目 fork 自 [Portkey AI Gateway](https://github.com/Portkey-AI/gateway)。**
> `llmadmin-core` 基于 Portkey 的开源版本构建，并在此之上加入了：本地管理界面与用量统计、统一的 `settings`+`gateway` 配置 schema、按模态拆分的路由表，以及开箱即用的 Anthropic 兼容协议转换。感谢 Portkey 团队打下的基础；所有上游贡献记录保留在 [`LICENSE`](./LICENSE) 与源文件头中。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Forked from Portkey](https://img.shields.io/badge/fork-Portkey%20AI%20Gateway-blue)](https://github.com/Portkey-AI/gateway)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

[English](./README.md) | 中文

---

## 为什么是 `llmadmin-core`？

`llmadmin-core` 是 [Portkey AI Gateway](https://github.com/Portkey-AI/gateway) 的一个聚焦分支。在上游代码的基础上我们做了：

- **新增一等公民级别的双协议支持。** 同一个网关同时提供 `/v1/chat/completions`（OpenAI 形态）和 `/v1/messages`（Anthropic 形态），并在两种格式之间做透明转换——任意协议的客户端都可以路由到任意上游，包括用 OpenAI 形态的请求访问 Anthropic 原生服务，反之亦然。
- **加固了测试套件。** 加强了请求生命周期、协议转换器、条件路由器、用量统计存储的单元测试与集成测试，让 Features 章节中承诺的行为在每个版本都保持稳定。
- **重构了配置 schema。** 废弃了旧的顶层 `plugins_enabled` + `integrations[]` 结构，改为统一的 `settings` + `gateway` 块，新增按模态拆分的路由表（`text` / `image` / `video` / `audio` / `mcp`）、带 `apiKey` / `baseUrl` / `baseUrlAnthropic` / `lastSyncedAt` / `remark` 字段的 provider 条目，以及在运行时决定 `fallback` 还是 `loadbalance` 派发的 `userConfig.strategy` 块。完整形态见 [`conf.example.json`](./conf.example.json)。

## 功能特性

- **统一接口 (Unified interface)。** 每个协议一个端点、一套配置 schema、一套 handler。约 80 个 provider 以同一形态接入，新增模型或替换上游都不会影响客户端。协议入口在 [`src/handlers/`](./src/handlers/)，provider 适配器在 [`src/providers/`](./src/providers/)。
- **双协议支持 (Dual protocol support)。** `/v1/chat/completions`（OpenAI 形态）与 `/v1/messages`（Anthropic 形态）均为一等公民。跨格式转换逻辑位于 [`src/providers/openai/messages.ts`](./src/providers/openai/messages.ts)，入口分别是 [`src/handlers/chatCompletionsHandler.ts`](./src/handlers/chatCompletionsHandler.ts) 与 [`src/handlers/messagesHandler.ts`](./src/handlers/messagesHandler.ts)。
- **自定义模型路由 (Custom model routing)。** 通过 [`src/services/conditionalRouter.ts`](./src/services/conditionalRouter.ts) 提供声明式的 fallback 与 loadbalance 策略。支持按模态拆分的路由表（`text` / `image` / `video` / `audio` / `mcp`）、每个 provider 独立的 custom host，以及在 `userConfig.strategy` 块中声明运行时的派发方式。要接入新模型，只需在 `gateway.text.routing` 中新增一行，并在 `gateway.providers` 中加入对应条目。
- **用量统计 (Usage statistics)。** 每个 provider 每日维度的计数（请求数、成功/失败、输入/输出 token，支持处还包括缓存 token）由 [`src/middlewares/log/index.ts`](./src/middlewares/log/index.ts) 记录，并通过本地管理界面查看。数据保留在宿主机上——无外部 SaaS，无遥测外发。
- **流式响应 (Streaming)。** 同时支持 OpenAI 与 Anthropic 的 SSE 格式，使用 [`src/handlers/streamHandler.ts`](./src/handlers/streamHandler.ts) 中的分块压缩。

### 即将推出

- **Step-level intelligent routing** —— 在 agent 循环中按单步（而非整次请求）路由到最合适的模型。
- **Prompt caching** —— 一等公民的 prompt 缓存层。Provider 侧的基础字段（`prompt_cache_key`、`cache_creation_input_tokens`、`cache_read_input_tokens`）已接入；下一步是补齐路由层。

## 快速开始

前置条件：Node.js ≥ 18，且至少一个 provider 的 API key。

```bash
# 1. 复制示例配置并填入你的 key
cp conf.example.json conf.json
$EDITOR conf.json

# 2. 安装依赖
npm install

# 3. 启动网关（Node）—— 默认监听 http://localhost:8700
npm run dev:node
# 如果你使用 Bun：
bun run dev:node
```

用 OpenAI SDK 调用：

```bash
curl http://localhost:8700/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

…或用 Anthropic SDK：

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

快速检查管理界面：

```bash
curl http://localhost:8700/admin/health
```

> **注意：** `conf.json` 已被 `.gitignore` 忽略。示例文件 `conf.example.json` 是 schema 的唯一权威来源——先复制它，再编辑。

## 双协议细节

两种协议都是一等公民。[`src/providers/openai/messages.ts`](./src/providers/openai/messages.ts)（约 1000 行）中的转换器负责双向（请求 + 响应）的转换。

自动转换的内容：

- **System messages** ↔ 顶层 `system` 字段
- **Tool / function schemas** —— OpenAI `tools` ↔ Anthropic `tools`，包括流式 tool-use 事件
- **Image content blocks** —— OpenAI `image_url` ↔ Anthropic `image` source
- **Stop reasons** —— `stop`、`length`、`tool_use` / `tool_calls`、`content_filter`
- **Usage objects** —— `prompt_tokens` / `completion_tokens` ↔ `input_tokens` / `output_tokens`（支持处包括缓存 token）
- **Stream event shapes** —— OpenAI `data: {...}` SSE ↔ Anthropic `event: ...\ndata: ...` SSE（`message_start`、`content_block_start`、`content_block_delta`、`message_delta`、`message_stop`）

可以混搭：发送 OpenAI 形态的客户端可以路由到 Anthropic 原生上游，反之亦然，客户端无需任何改动。

## 配置说明

配置文件（`conf.json`，已被 gitignore）有三个顶层块：

- **`settings`** —— plugin 启用、缓存开关、旧版 integrations 列表。
- **`gateway.providers`** —— 每个 provider 的配置条目：`id`、`apiKey`、`baseUrl`、可选的 `baseUrlAnthropic`（用于在自定义 host 上提供 Anthropic 协议的 provider）、`lastSyncedAt`、自由格式的 `remark`。
- **`gateway.<modality>.routing`** —— 按模态的路由表（`text`、`image`、`video`、`audio`、`mcp`）。每一行固定一个 `(provider, model, configId)` 三元组，并标记它是否是主用。
- **`gateway.<modality>.userConfig`** —— 运行时策略：`fallback`（带 `on_status_codes`）或 `loadbalance`，以及用于派发请求的 `targets` 数组。
- **`server`** —— 监听端口与 headless 标志。

`settings.plugins_enabled` 中列出的 plugin 会在请求处理流程中插入附加能力。`default` plugin 是必需的，提供重试、fallback 与负载均衡。其余 plugin 是 guardrail（如 `aporia`、`sydelabs`、`pillar`、`patronus`、`pangea`、`promptsecurity`、`panw-prisma-airs`、`walledai`）。

完整带注释的形态见 [`conf.example.json`](./conf.example.json)。

## 支持的 Provider

Provider 分为两个层级。

### 完整测试（UI 可配置）

这些是本地管理 UI 知道如何配置的 provider。它们出现在 [`SUPPORTED_PROVIDERS`](./src/admin/config/store.ts) 中，也是我们在每个版本上跑端到端冒烟测试的对象。**如果你正在挑选一个起步的 provider，请从这份列表中选择。**

- `openai` —— 上游为 OpenAI 形态，具备完整的 **Anthropic transform**：使用 Anthropic 协议的客户端可以透明路由到该 provider。同时通过 `baseUrl` 兼容任何 OpenAI-compatible host。
- `anthropic` —— 上游为 Anthropic 形态，具备完整的 **OpenAI transform**：使用 OpenAI 协议的客户端可以透明路由到该 provider。
- `google` —— 上游为 OpenAI 形态（通过 Google 的 OpenAI-compatible 端点接入），具备完整的 **Anthropic transform**：使用 Anthropic 协议的客户端可以透明路由到该 provider。
- `zhipu` —— OpenAI、Anthropic（智谱 GLM）
- `dashscope` —— OpenAI、Anthropic（阿里云 DashScope / 通义千问）
- `moonshot` —— OpenAI、Anthropic（月之暗面 Kimi）
- `minimax` —— OpenAI、Anthropic（MiniMax 端点家族）
- `doubao` —— OpenAI、Anthropic（字节火山引擎 Ark / 豆包）
- `deepseek` —— OpenAI、Anthropic

### 其他集成

`src/providers/` 下所有其他目录（除两个共享协议基类 `open-ai-base/` 与 `anthropic-base/` 之外）同样是可以工作的 provider 适配器，但它们**不会**出现在本地管理 UI 中，也不在发布版测试矩阵内。你仍可以在 `conf.json` 的 integration 块中按目录名引用它们，但使用中可能遇到问题，遇到请向我们提 PR。

- **更多超大规模 / 直连 API：** `azure-openai`, `bedrock`, `google-vertex-ai`, `google-openai`, `azure-ai-inference`, `workers-ai`, `sagemaker`, `lambda`
- **更多 Anthropic-compatible / 聚合器：** `openrouter`, `lingyi`, `mistral-ai`, `z-ai`, `krutrim`, `cerebras`, `groq`, `fireworks-ai`, `together-ai`, `hyperbolic`, `lepton`, `novita-ai`, `nebius`, `kluster-ai`, `ovhcloud`, `nscale`, `oracle`, `cometapi`, `iointelligence`, `siliconflow`, `predibase`, `sambanova`, `inference-net`
- **开源 / 自托管：** `ollama`, `huggingface`, `x-ai`, `replicate`, `cohere`, `ai21`, `deepinfra`, `anyscale`, `palm`, `perplexity-ai`, `voyage`, `jina`, `nomic`, `milvus`, `qdrant`, `upstage`, `cortex`, `featherless-ai`, `lemonfox-ai`, `monsterapi`, `deepbricks`, `ncompass`, `nextbit`, `matterai`, `modal`, `triton`, `bytez`, `aibadgr`, `reka-ai`, `segmind`, `302ai`
- **图像 / 3D / 音频：** `stability-ai`, `recraft-ai`, `tripo3d`, `meshy`

要把这一层的 provider 升级到 UI 列表，请编辑 [`SUPPORTED_PROVIDERS`](./src/admin/config/store.ts)，并遵循 [添加新 provider 集成](./CONTRIBUTING.md#adding-a-new-provider-integration) 指南。

## 贡献

欢迎任何规模的 PR。开发环境搭建、项目结构、新增 provider 集成、PR 流程详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 安全

如发现安全漏洞，请通过 [SECURITY.md](./SECURITY.md) 中的私密上报渠道联系我们。**请勿**为安全漏洞公开开 issue。

## License

[MIT](./LICENSE) —— Copyright Portkey, Inc. (2024) 与 LLM Admin (2026)，本项目派生自 Portkey Gateway，谨此致谢。
