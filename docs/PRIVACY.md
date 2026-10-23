# Privacy Policy

_Last updated: 2026-10-23. Describes the current AiTool fork's CLI, dashboard, proxy, native clients and inherited optional TokenTracker cloud integrations. The upstream website and release channels are separate deployments._

AiTool reads existing AI-tool logs for local usage statistics, manages client configuration and forwards inference through a local proxy. Automatic cloud sync is off by default. Provider inference, quota reads, pricing refreshes and enabled integrations use their respective services.

## 1. Statistics and conversation content are separate

**Analytics queues and cloud usage uploads** contain usage metrics, source/model IDs, timestamps and accounting annotations. They do not contain prompts, responses, project file contents or transcripts. Local project/session sidecars can contain paths and repository names but are excluded from cloud upload.

**CLI Sessions** explicitly reads existing transcripts for nine tools, including messages, thinking, tool arguments/results and diffs, and returns them to the local browser/native window. Its process LRU is bounded to 8 sessions / 96 MiB, with no transcript disk cache. Long fields use revision-checked previews/pages. Full search and Markdown export load the complete revision; an exported file contains conversation content by the user's choice. Source logs remain owned by the originating CLI.

**Provider switching** stores API keys, presets, MCP specs, user-authored prompts and backups locally, and writes supported native config/instruction files. Enabling a prompt first captures existing live content. These stores are not analytics and are not automatically uploaded.

**Proxy inference** forwards messages and other content to the selected upstream. The usage bridge stores model/provider/tokens/status/timing metadata, not request or response bodies. Normalization removes raw client keys, upstream credential source and response headers, retaining hashes/masked values for local matching. Records can still contain account labels and error metadata. Core logs, CLI source logs and external services have their own behavior; do not treat them as sanitized analytics exports.

**Optional tools/routing** can send content when enabled/invoked: Tavily receives queries; summary/vision models receive selected search context or images; enabled classification receives a bounded portion of the last user text. Magpie tools forward arguments to the connected service. Tool counters and route events do not persist queries, results, images or task/reply bodies.

## 2. Local storage

| Location | Contents |
| --- | --- |
| `~/.tokentracker/tracker/queue.jsonl` | Append-only UTC **half-hour** aggregate snapshots; cloud usage upload source |
| `~/.tokentracker/tracker/project.queue.jsonl`, `session.queue.jsonl` | Local project/session usage and paths; never uploaded |
| `~/.tokentracker/tracker/` | Cursors, preferences, device/account configuration, upload state and quota caches |
| Other `~/.tokentracker/` directories | Local runtime, pet/skill assets, caches and native preferences |
| `~/.aitool/proxy/settings.json`, `config.yaml`, `auths/` | Plaintext management key, core settings/access keys and provider credentials |
| `~/.aitool/proxy/usage/` | Request records, bridge buckets and models.dev cache; raw records are not uploaded |
| `~/.aitool/proxy/` integration state | Adapter/subscription/routing/tool settings, local credentials or source pointers, connection receipts |
| `~/.aitool/provider-switch/` | Providers, MCP, skills, prompts, profiles, auth stashes, diagnostic/distribution receipts and recovery copies |
| AI-client config roots / selected project | Explicit provider/MCP/skill/prompt/role projections and owned project files |
| Native secret stores | Zed connection keys; macOS Antigravity official-account state |

Private files use `0600` where supported, but are not all encrypted at rest. Encrypted provider-backup export uses a passphrase, scrypt and AES-256-GCM for selected stores; it is not a backup of every live config, auth stash or integration credential.

Completed profile/distribution recovery attempts default to 20 recent copies and a 30-day maximum age. Active, uncertain or receipt-referenced copies are retained. Failed restorations can deliberately retain their only recovery copy. See [magpie-integration.md](magpie-integration.md) before deleting/restoring files.

Display privacy mode masks identities, including agy account lists. It does not remove credentials, change route IDs or sanitize explicit copying/exporting of original values.

## 3. Network behavior

These groups describe built-in request paths. User-configured upstreams, MCP commands and external services may make additional requests under their own configuration. Provider credentials go directly to the owning provider/control plane, not to TokenTracker's statistics service.

### Automatic/background requests where enabled

| Request | Destination / data | Trigger and control |
| --- | --- | --- |
| Anonymous heartbeat | Configured InsForge backend (upstream default `srctyff5.us-east.insforge.app`); one-way machine hash, version, platform, shell | At most daily; independent of cloud usage sync; telemetry opt-out applies |
| Dashboard product analytics | PostHog (`us.i.posthog.com`); pageviews and instrumented feature/shell events | Production builds; autocapture/session recording off, browser DNT respected; local/native startup requires confirmed telemetry preference |
| Hosted web metrics | Vercel Analytics / Speed Insights | Hosted deployment; these components do not render on local/native surfaces |
| Provider quota reads | Anthropic, OpenAI, Cursor, Copilot, Kimi, Z.ai, Qoder, Google and other enabled provider APIs; required credentials | Enabled quota surfaces/refreshes; provider-specific opt-ins apply |
| Aggregate pricing refresh | Public LiteLLM JSON on `raw.githubusercontent.com` | Missing/stale pricing cache; TTL-based |
| Proxy/session pricing refresh | Public `models.dev/api.json` | Estimate reads; 24-hour TTL, background refresh, failure backoff 5 minutes |
| Public repository metadata | GitHub API | Dashboard star count and related metadata |
| Native update checks/downloads | Upstream GitHub release API/assets | Update preferences, launch/periodic checks or manual action; inherited updater is not a fork release service |
| Automatic usage upload | Configured InsForge backend; aggregate rows in §4 | Account/device credentials **and** saved cloud-sync opt-in, rechecked during upload |

### Explicit setup, page or user-requested actions

| Request | Destination / data | Trigger |
| --- | --- | --- |
| AI inference | Selected provider/relay; request messages/tools/images and required auth | Client proxy request, explicit speed/test action or enabled tool/classifier inference |
| Core/runtime/dependency install | GitHub releases, Node.js distribution site, npm registry or local checkout | `proxy install`, runtime/dependency setup, platform bundling; Docker downloads core at image build |
| Provider login/credential refresh | Owning provider auth service | Explicit OAuth/refresh; core can also refresh configured credentials while serving |
| Provider-switch quota/models | Matching provider endpoint; row key or configured control-plane credentials | Quota/model-fetch actions; Command Code, Z.ai and Volcengine use their own APIs |
| Antigravity accounts | Google OAuth / Code Assist; selected account auth | Login/quota/switching; quota/deletion do not replace current login |
| WorkBuddy subscription / Magpie | WorkBuddy login/models/quota/inference or configured Magpie | Explicit login/discovery/selection; enabled adapters run with proxy and may consume credits |
| MCP check | Configured stdio command or HTTP/SSE service, auth/env | Explicit initialize/tools-list check; no tools invoked, bounded/cancelable |
| Search / vision MCP | Tavily, selected inference service or Magpie | Tool invocation after setup; queries/images can leave the machine and incur charges |
| Intent classifier | Selected model through core | Only enabled route classification; additional inference usage |
| OpenCode free models | OpenCode directory/service and models.dev | Explicit discover/enable/refresh and client inference; unsupported/unpriced models rejected |
| Skills catalogs/downloads | GitHub/raw content, `skills.sh`, configured repositories; search terms/IDs | Skills discover/search/install/update |
| Cloud-skills inventory | Configured InsForge backend; authenticated skill metadata | Skills refresh while signed in with cloud sync enabled; not transcript/skill-body upload |
| Devin quota | `server.codeium.com` GetPlanStatus; existing Devin CLI token | Off by default; enabled Devin option and authorized local request |
| TRAE Work CN usage | TRAE internal API; existing local app authorization | Only `TOKENTRACKER_TRAE_CN_USAGE=1`, eligible non-background sync and local auth; this read path does not log/persist auth |
| Account login/device pairing | Configured InsForge / OAuth provider | Explicit sign-in/pairing |
| Manual usage upload | Configured InsForge; aggregate rows | Manual `aitool sync` with credentials, even with automatic sync off |
| Exchange rates | `open.er-api.com` | Non-USD currency selection |
| Pet download | `codex-pets.net` or supported selected source | Explicit import |
| IP / status pages | `ip.net.coffee`, `claude.ai`, `1.1.1.1`, provider status APIs | Open page; endpoints observe connecting IP |
| Share-card fonts | Google Fonts | Generate share image |

Opening an integration status page does not discover Magpie, run MCP checks, log into WorkBuddy or refresh subscription quota. External MCP programs and enabled adapters still operate under their selected setup.

## 4. Cloud usage upload

Automatic upload defaults **off**, including while signed in; unset/invalid/unreadable preferences fail closed. Hooks, native publication, retries and notify/background sync must pass `canUpload()`. Preference ordering prevents a delayed old opt-in from replacing a newer opt-out.

Manual `aitool sync` parses logs and requests one-time upload if credentials are available, without changing the automatic-upload preference. Signing in alone is not automatic-sync consent; automatic sync being off does not prevent an explicit manual request.

Uploads contain `source`, `model`, UTC half-hour `hour_start`, input/output/cache/reasoning counts, `total_tokens`, `conversation_count` and supported accounting annotations. Device/account identifiers associate rows with the signed-in account. Aggregates may include `source: "cliproxy"`.

Usage upload excludes provider keys/presets, raw proxy records, transcript bodies, local paths, project/session sidecars and instructions. Public-profile visibility is independent of synchronization. The Skills page also reads/publishes inventories while signed in with cloud sync enabled: stable key, name, relative directory/source, target IDs and managed/read-only/scope flags. It excludes descriptions, SKILL.md bodies, README URLs and absolute paths. This is separate from token rows. Sign-in/auth and explicit network features have their own controls.

Audit entry points: [cloud-sync-prefs.js](../src/lib/cloud-sync-prefs.js), [sync.js](../src/commands/sync.js), [upload-queue.js](../src/lib/upload-queue.js), [telemetry.js](../src/lib/telemetry.js), [analytics.js](../dashboard/src/lib/analytics.js), [usage-record.js](../src/lib/proxy/usage-record.js), [session-transcript-cache.js](../src/lib/session-transcript-cache.js).

## 5. Controls and deletion

| Control | Effect |
| --- | --- |
| `TOKENTRACKER_NO_TELEMETRY=1` / `DO_NOT_TRACK=1` | Disable CLI heartbeat and local/native PostHog analytics |
| `"telemetry": false` in `~/.tokentracker/tracker/config.json` | Same local telemetry opt-out; confirmation failure keeps dashboard analytics off |
| Cloud-sync off / sign out | Stop automatic aggregate uploads; not inference, provider APIs, telemetry or explicit manual upload |
| `TOKENTRACKER_DISABLE_GIT_ATTRIBUTION=1` | Stop Git attribution; existing sidecars are not erased |
| Disable quota/integration/adapter/tool | Stop that capability per its lifecycle; restore owned client config separately |

To remove state, stop AiTool/clients and review backups/receipts. `aitool uninstall` removes supported analytics hooks; it is not complete provider-config/credential restoration. Deleting `~/.tokentracker/` and `~/.aitool/` removes stores but does not erase CLI source logs, exports, cloud data, projected native configs or keyring entries. Restore/remove projections deliberately before deleting recovery records.

Hosted account data belongs to the configured service. For upstream TokenTracker use its [contact/issues page](https://github.com/xiufengsun/TokenTracker/issues) for deletion requests without posting credentials. Removing local files does not delete an upstream account.

Third-party services follow their own policies, including [GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement), [PostHog](https://posthog.com/privacy), [Vercel](https://vercel.com/legal/privacy-policy), [Google](https://policies.google.com/privacy), InsForge and selected AI providers. AiTool is a developer tool, not directed at children under 13.

Fork corrections: [rijing-joker/AITool](https://github.com/rijing-joker/AITool/issues). Private reports follow [SECURITY.md](../SECURITY.md); policy changes remain in this file's Git history.
