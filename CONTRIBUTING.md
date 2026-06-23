# Contributing to `llmadmin-core`

Thanks for your interest in `llmadmin-core`! We welcome PRs of any size — typo fixes, new provider integrations, performance improvements, or new gateway features.

## Ground rules

- Be respectful. Assume good faith. Disagree on substance, not on people.
- One logical change per PR. If your diff touches two unrelated things, split it.
- No drive-by formatting-only PRs. Format only the lines you actually changed (`prettier` will do the rest in CI).
- For new provider integrations, include a unit test under `tests/` (or `plugins/<name>/<name>.test.ts` for plugin-shaped providers).
- **Do not commit API keys, tokens, or PII.** Real keys belong in your local `conf.json` (which is gitignored). The example file `conf.example.json` uses `"REPLACE_ME"` for every credential — keep it that way.

## Dev setup

```bash
git clone https://github.com/<org>/<repo>.git
cd <repo>/src-gateway
npm install
cp conf.example.json conf.json
$EDITOR conf.json          # fill in at least one real provider key

# Run the gateway in dev mode
npm run dev:node           # Node
# or:
bun run dev:node           # Bun

# Run the test suites
npm run test:gateway
npm run test:plugins
```

The Husky `pre-push` hook runs `npm run build` + `node start-test.js`, so a push that breaks the build will be rejected locally.

## Project layout

See [README § Features](./README.md#features) for the high-level overview of what the gateway does. The four key directories to know:

- `src/handlers/` — per-protocol HTTP entrypoints. The two you'll touch most for protocol work are `chatCompletionsHandler.ts` (OpenAI shape) and `messagesHandler.ts` (Anthropic shape). Other handlers cover `completions`, `embeddings`, `imageGenerations`, `imageEdits`, `createSpeech`, `createTranscription`, `createTranslation`, `models`, `files`, `batches`, `finetune`, `modelResponses`, `realtime`, and `proxy`.
- `src/providers/<provider>/` — one folder per provider. Two of these are **not** integrations but shared protocol base classes: `open-ai-base/` (shared by all OpenAI-shape providers) and `anthropic-base/` (shared by Anthropic-shape providers). The translator that turns one shape into the other lives at `src/providers/openai/messages.ts` (~1,000 lines).
- `src/middlewares/` — cross-cutting concerns: `log/` (the metrics store at `src/middlewares/log/index.ts`), `cache/`, `requestValidator/`, `hooks/`, `configInjector/`, `streamingCompression.ts`.
- `src/services/` — request-lifecycle services: `conditionalRouter.ts` (the routing engine), `transformToProviderRequest.ts`, `realtimeLlmEventParser.ts`.

The admin endpoints (not in the default public surface) live at `src/admin/routes.ts` and are mounted at `/admin/*`.

## Adding a new provider integration

1. **Copy the closest reference.** The clearest reference is `src/providers/anthropic/` for an Anthropic-shape provider, or any folder under `src/providers/open-ai-base/` for an OpenAI-shape provider. Each integration typically exports `api.ts`, `chatComplete.ts`, `embed.ts` (or a subset).
2. **Register the provider.** Add the new provider to `src/providers/index.ts` so it shows up in the `Providers` map consumed by the handlers and the admin.
3. **Add a config example.** The new provider should be representable in `conf.example.json` — open a follow-up PR if your provider needs new fields beyond `apiKey` / `baseUrl` / `baseUrlAnthropic` / `lastSyncedAt` / `remark`.
4. **Write a test.** Add a unit test under `tests/unit/providers/<provider>/` (or wherever the existing provider tests live). The CI suite runs both `npm run test:gateway` and `npm run test:plugins`.
5. **Update the README's "Supported providers" section** with a one-line entry, grouped by category.

## Coding style

- TypeScript strict mode is on. No `any` in new code without a comment explaining why.
- Run `npm run format` before committing. CI also runs `format:check`.
- Prefer small, composable functions over clever one-liners.
- Match the conventions of the file you're editing — don't reformat lines you're not actually changing.

## Commit & PR

- Imperative-mood subject line, ≤ 72 chars. e.g. `feat(providers): add z-ai chat integration` or `fix(messages): map cache_read_input_tokens to usage`.
- Body explains *why*, not *what*. Reference the issue (`Closes #123`).
- One commit per logical change is fine; squash-merge is the default when the PR lands.
- CI must be green. If you can't get a test green locally, push a draft PR and ask for help.

## Reporting bugs

Open an issue on the issue tracker. Please include:

- The version (`cat package.json | grep version`).
- A minimal reproduction (request body, provider, expected vs. actual response).
- The relevant log line (the gateway writes its metrics and request log to a file under your `$HOME` directory — see [`src/middlewares/log/index.ts`](./src/middlewares/log/index.ts) for the exact path).

For security bugs, **do not** open a public issue — see [SECURITY.md](./SECURITY.md).
