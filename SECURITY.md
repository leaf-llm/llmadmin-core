# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| `0.1.x` | ✅ Yes    |
| `< 0.1.0` | ❌ No  |

We do not promise backports to older versions. The `0.1.x` line is the only line that receives security fixes.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security bugs.**

Email **security@\<org\>.tld** (replace `<org>` with the publishing org — see the repository URL) with a description of the issue. You should receive an acknowledgement within **7 days**. If you don't, follow up on the same thread.

We follow **coordinated disclosure** with a target window of **90 days** from the report date. We will work with you to:

1. Confirm the issue and determine affected versions.
2. Develop and review a fix.
3. Cut a patched release.
4. Publish a CVE (preferred) and credit you in the release notes (with your permission).

## What to include in your report

The faster we can reproduce, the faster we can fix. Please include:

- The **affected version** (`cat package.json | grep version` in the project root).
- A **minimal reproduction** — request body, provider config, response observed, response expected.
- The **impact** you observed (data exposure, auth bypass, RCE, etc.).
- Your **environment** — Node version, OS, deployment mode (Node / Bun / Cloudflare Workers).
- Whether the issue is exploitable remotely or requires local access.

**Please do not** send live exploit code over email unless we ask for it. A description of the steps is enough at the report stage.

## Out of scope

The following are not security vulnerabilities in this project:

- **Prompt injection in user content** — a provider's response can be influenced by the prompts you send it. That is a property of the upstream model, not of this gateway.
- **Provider-side outages or quota issues** — report those to the provider (OpenAI, Anthropic, etc.).
- **Vulnerabilities in third-party plugins** — see the upstream `plugins/<name>/` project. We list the upstream source in each plugin's manifest.
- **Issues in the public admin API when `ADMIN_TOKEN` is unset** — the admin routes default to *unauthenticated* when `ADMIN_TOKEN` is empty (see `src/admin/routes.ts`). Set the env var in any non-local deployment.

## Acknowledgements

We follow responsible disclosure and will credit reporters (with permission) in the release notes and in a future "Security acknowledgements" section of this file. Thank you for helping keep `llmadmin-core` and its users safe.
