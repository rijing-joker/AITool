# October 2026 upstream integration

The integration uses cached, reviewed references: TokenTracker v1.4.1
(`d20f8ae`), cc-switch v4.0.12 (`51ac86f`), EasyCLIProxyAPI v0.3.38 and
CLIProxyAPI v8.0.29, plus cc-switch's post-release Codex pagination/fork repair
(`67d63e3e4c`). This is a local development integration, with no release or
version bump.

## Changes

- Token accounting retains AiTool's cache-read/write and reasoning subset
  semantics, including interleaved Codex cumulative counters and long-context
  pricing. The proxy core is pinned to v8.0.29 with staged upgrade/rollback.
- Provider presets cover local servers with direct loopback model discovery.
- Session analytics includes OpenCode SQLite and Kimi sessions, with Kimi model
  attribution and dashboard source filters. Session metadata remains local;
  no transcript text is added to the analytics queue or cloud payloads.
- Qoder CN can read authenticated CLI quota separately from web quota, and
  add-on credits remain separate from subscription allowances. See
  [qoder-cn-limits.md](qoder-cn-limits.md).
- Dashboard queue reads are asynchronous, share pending reads and yield during
  large scans/aggregations. Append/tail handling, cumulative bucket dedup and
  pricing/cache subsets are preserved.
- Codex provider changes track catalog/login fingerprints and identify stale
  clients. The dashboard can request the CLI's graceful managed-daemon restart;
  other clients receive a reopen notice. Status reads do not restart processes.
- Copilot CLI and VS Code connections are available on the proxy Keys tab. See
  [copilot-proxy.md](copilot-proxy.md).
- Codex `<thread>_<rollout>` files share a thread in analytics and the transcript
  reader, while sync retains each rollout's distinct identity. Empty pages
  retain earlier cumulative/model/tier state. Fork billing compares the child's
  leading token snapshots against the parent's ordered timeline before the fork
  time, advances cumulative baselines and excludes matched replay. Parent
  identity accepts both top-level fields and native
  `source.subagent.thread_spawn.parent_thread_id`; disagreement defers counting.

## Recovery behavior

Native Codex forks with missing, unreadable, conflicting or incomplete parent
data are deferred. Sync leaves their cursors untouched and continues other
files. Historical repair uses a guarded throwaway rebuild and refuses to
replace history when a required fork cannot be reproduced. A new repair marker
revisits older fork/pagination accounting while keeping backups and existing
cloud upload gates.

Session analytics retains the last complete sidecar and writes a durable retry
marker. Context breakdown reports `skipped_sessions` for deferred groups and
does not cache partial results. The transcript reader still shows available
messages but omits the usage estimate for an unresolved fork. Every physical
transcript page is checked against its app's permitted session roots.

## Validation

Completed on 2026-10-17 (Asia/Shanghai):

- `npm test`: 4,171 passed, 12 skipped, no failures.
- `npm --prefix dashboard test -- --minWorkers=1 --maxWorkers=2`:
  148 test files and 1,126 tests passed.
- `npm --prefix dashboard run typecheck`, `npm run dashboard:build`, and the
  copy, locale, UI-hardcode and architecture validators passed.
- The final native spawned-thread fix passed 247 related backend regressions
  (3 optional skips), followed by the full backend run and all 12 pagination /
  fork tests after the final normalization adjustment.

Quota decoding and reconciliation use recorded fixtures; no live Qoder CN
account was available. Copilot handoff and Codex daemon lifecycle are tested
with mocked clients/process catalogs. The current development chat's daemon was
not restarted. Compressed rollout and SQLite tests run when their optional
runtime dependencies are available, with explicit skips otherwise.
