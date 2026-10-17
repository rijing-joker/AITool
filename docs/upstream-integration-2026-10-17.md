# Upstream integration — 2026-10-17

Starting checkout: `e143686` on `dev`. Sources reviewed: TokenTracker
`v1.4.4`, EasyCLIProxyAPI `v0.3.41`, CLIProxyAPI `v8.0.32`, and cc-switch
`v4.0.14`. This integration adapts their changes to AiTool's existing Node
management layer and local-first data contracts.

## Integrated changes

- [x] TokenTracker: WorkBuddy project attribution and independent historical
  backfill; Muse passive usage reader; dashboard device-token diagnostics.
- [x] Linux: unique tray identity, desktop database refresh for AppImage OAuth,
  and the Tauri CLI AppImage icon fix.
- [x] Provider configuration: validated Codex speed tiers and auto-review model
  selection, Haiku 1M declaration, Windows session project grouping.
- [x] Proxy: core baseline v8.0.32 and end-to-end conditional configuration
  writes with visible conflict handling.
- [x] Clients and quotas: Copilot's complete model catalog and capability
  metadata; Antigravity Hub requests and quota-window normalization.
- [x] Presentation: use the existing currency preferences for proxy request,
  budget and CLI transcript costs while retaining USD storage and exports.
- [x] Validation: targeted regressions, repeat-sync accounting checks, backend
  and dashboard suites, TypeScript, copy/locale/UI/architecture validators,
  dashboard build and available Linux native checks.

## Boundaries

Existing cache/reasoning normalization, transactional cursors, local mutation
authorization, credential backups and opt-in cloud upload gates remain part of
every adapted path. The proxy core remains an external executable. Native
plugin stores, alternate themes and Claude Desktop routing modes are outside
this integration. No application release or version bump is involved.

## Behavior and compatibility

- WorkBuddy and WorkBuddy AI keep separate project offsets and deduplication
  state, so existing total-usage history can be attributed without counting it
  twice. Missing project directories stay retryable. Queue failures preserve
  published cursors and buckets. Muse is a passive local reader; its models
  stay unpriced in both analytics and the matching edge source list.
- Dashboard OAuth device-token presence is recognized by status, doctor and
  diagnostics only when the instance and known machine match. The credential
  is never included in their output.
- Codex catalog service/speed tiers are validated and deduplicated instead of
  cleared. `meta.codexSpeedTiersEnabled: false` suppresses them for providers
  that do not support them. `meta.codexAutoReviewModel` must name a model in
  the provider's catalog and is projected onto every catalog row. Import
  restores consistent review choices and explicitly disabled speed tiers.
- Haiku mappings accept the same `[1m]` declaration as the larger Claude
  roles. Windows drive/UNC path variants share a session group; POSIX case
  stays significant and the original path remains visible.
- Config settings, raw YAML, client keys, provider groups and alias rollback
  use the core's v8 conditional writer. Revisions belong to the read snapshot;
  a conflicting save does not overwrite another writer. Drafts remain visible
  until explicitly reloaded. Creating an absent config section first obtains
  a root snapshot. YAML is sent as YAML, and structured settings preserve
  unrelated configuration.
- VS Code receives the selected model first and all other public IDs,
  including aliases, with metadata from the proxy/local models.dev cache.
  Unknown capability defaults remain conservative. The existing native secret
  handoff, private backups and conflict-aware restore remain in use. The API
  accepts client keys from native v8 `access.api-keys` as well as legacy layouts.
- Antigravity requests identify as Hub 2.23.0. Quota parsing accepts camelCase
  and snake_case, recognizes windows by their labels and displays named
  groups. Exhausted weekly allowance visibly blocks the associated five-hour
  window without changing its reported usage; expired blocks leave the cache.
- Request, budget-summary and transcript estimates/tooltips follow the
  existing currency preference. Accounting, CSV exports and budget inputs
  retain USD values.
- Linux uses a distinct tray ID, refreshes the desktop database after
  registering an AppImage OAuth handler, and updates the Tauri CLI dependency
  to 2.12.3 (including the upstream AppImage icon fix).

## Validation

The dashboard suite passed all 1,131 tests. After the final boundary fixes,
80 focused frontend tests also passed, including revision ownership, missing
sections, retained conflict drafts, grouping and blocked quota display.
TypeScript, dashboard production build, copy registry, Chinese locale
coverage, UI hardcode and architecture validators passed.

The final backend suite passed 4,243 tests, with 12 skipped and no failures
(4,255 total). Conditional-write, catalog, alias, Copilot, parser and
repeated-sync coverage passed. Muse's two consecutive background syncs leave the queue unchanged;
WorkBuddy tests cover historical project backfill and repeat-read idempotence.

## Validation limits

`cargo test --offline --test oauth` could not run because Cargo is not installed
in this environment. Linux native changes and test sources are included, but
an AppImage build and graphical OAuth handoff were not exercised. Live Copilot
and Antigravity accounts were not used; their integrations were checked with
fixtures and local HTTP servers.

The external core baseline is updated in the repository. This work does not
replace or restart an already-running core. Protected config saves require a
running v8.0.32-or-later core that supplies revisions; older cores receive an
update/reload message instead of an unconditional write.
