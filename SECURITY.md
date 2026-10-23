# Security Policy

This repository is the personal fork `rijing-joker/AITool`. Working code is maintained on `dev`; the inherited npm, website and desktop release channels belong to upstream TokenTracker. This fork does not promise a release-based support window. Include the commit and local changes when reporting an issue.

## Reporting a vulnerability

Do not put credentials, transcripts, private config files or exploitable details in a public issue. Check the fork's [Security page](https://github.com/rijing-joker/AITool/security) for an available private channel. For issues also affecting upstream TokenTracker, its [private advisory page](https://github.com/xiufengsun/TokenTracker/security/advisories/new) is the existing upstream reporting channel.

Include a redacted reproduction, affected commit/runtime/platform, impact and mitigation. Use synthetic session/config fixtures where possible. Do not assume a fork report has been sent to upstream.

## Local trust boundary

`serve` binds to `127.0.0.1` by default, usually :7680; the proxy core normally uses :8318. Local reads include usage, configuration and root-clamped transcripts. Mutations require a local token (header/cookie) and an allowed loopback Origin. This is a same-machine trust model, not a multi-user authentication service.

`AITOOL_BIND_HOST` can change binding. Docker uses `0.0.0.0` internally and publishes only host loopback ports by default. Exposing either port to other machines exposes local read surfaces unless an authenticating boundary is added. A provider inference key is separate from local management authorization.

Core management uses an independent Bearer key. AiTool keeps its plaintext in `~/.aitool/proxy/settings.json`; the core hashes its `config.yaml` copy. Do not disclose credential/config files in reports. Core saves use ETag/If-Match; stale or missing revisions must not overwrite newer settings.

## Areas to review

| Area | Security contract |
| --- | --- |
| `src/lib/rollout.js`, `src/commands/sync.js`, upload queue | 45-tool statistics parsing; token semantics/dedup; no bodies in analytics/upload rows |
| `src/lib/local-api.js` | Loopback binding, mutation token/Origin, bounded inputs and readable endpoint exposure |
| `sessions.js`, `session-sources.js`, `session-transcript-cache.js` | Read-only transcripts; roots/real paths, database/WAL and companion checks, revisions/paged references; bounded process cache |
| `src/lib/provider-switch/` | Supported app/file targets, private writes/backups, owned projections, conflict handling and safe recovery retention |
| `provider-switch/agy-accounts.js` | macOS official switching; quota/deletion do not replace live login; unreadable keychain state stays recoverable |
| `src/lib/proxy/` | External core lifecycle, masked/hashed usage identities, body-free usage bridge, ETag groups and bounded recovery |
| `proxy/extensions/`, `proxy/opencode-free/` | Explicit enablement, independent adapter keys, limits/cancellation, loop prevention and single accounting |
| Copilot / WorkBuddy / Zed connections | Owned config changes, native secrets where applicable, backup/conflict-aware restore |
| Native clients | Documented CLI hooks/config writes, embedded runtime, OAuth bridges, owned-process cleanup and update integrity |
| Cloud sync / edge code | Every automatic upload checks `canUpload()`; invalid/unreadable preference is disabled; usage upload contains only aggregates |

## Privacy and credentials

Analytics queues do not retain or upload prompts, responses or source file contents. Project/session sidecars are stored locally and excluded from cloud usage uploads. CLI Sessions explicitly reads local transcripts into bounded memory and can export them at the user's request; provider-switch stores credentials and user-authored instructions locally.

The proxy forwards bodies to the selected upstream. Enabled search/vision/classification can send selected content to configured services; keep it out of usage records and telemetry. Quota APIs receive required credentials directly from the user's machine.

Provider stores, auth stashes, prompts, backups and recovery manifests may contain secrets. Private writes use `0600` where supported; they are not universally encrypted at rest. Zed uses native secret stores; other credentials can be local files. Display privacy mode masks identities but does not sanitize files or explicit copy/export.

See [docs/PRIVACY.md](docs/PRIVACY.md) for network behavior and controls. Report dependency vulnerabilities to their upstream too. Arbitrary local filesystem access does not excuse a reproducible path/symlink escape in an AiTool-owned operation.
