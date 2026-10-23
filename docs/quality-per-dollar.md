# Quality per dollar / Effective Tokens (opt-in)

TokenTracker answers *"what did the tokens **cost**?"*. This optional layer adds
*"what did they **buy**?"* — by joining a small, vendor-neutral sidecar of
**outcomes** to the token/$ rows TokenTracker already tracks.

The card is **off by default**. The current local API combines manual outcomes with conservative automatic Git attribution; a manual sidecar is no longer required if local sessions can be matched to commits. With no usable outcomes, the card stays hidden.

## The metrics

- **Quality per dollar (Qual/$)** = accepted outcomes ÷ dollars
  spent, per model and per tool. For manual data, the numerator is a declared **accepted outcome** (a
  merged PR / a passed task); automatic Git attribution uses non-revert commits as a heuristic — never lines of code (LOC would just reward bloat).
- **Effective Tokens (ET)** = the share of tokens that produced accepted work
  vs. rework (`total_tokens × acceptance_rate`).

Costs come entirely from TokenTracker's existing pricing. The sidecar only
supplies the *accepted/total* counts.

## The sidecar: `outcomes.jsonl`

Location: `~/.tokentracker/tracker/outcomes.jsonl` (next to `queue.jsonl`, but
**never** read or written by the queue/sync path). One JSON object per line:

```jsonl
{"timestamp":"2026-06-30T14:02:11Z","tool":"claude","model":"claude-opus-4-8","accepted":true,"task_type":"feature"}
{"timestamp":"2026-06-30T14:40:55Z","tool":"opencode","model":"kimi-k2.7-code","accepted":true}
{"timestamp":"2026-06-30T15:10:03Z","tool":"cursor","model":"gpt-5.5","accepted":false}
```

| field | required | meaning |
|-------|----------|---------|
| `timestamp` | yes | ISO‑8601; used to join to the token/$ rows by day window |
| `model` | no (defaults `unknown`) | model id, matched to the same pricing as queue rows |
| `tool` | no (falls back to `source`, then `unknown`) | the agent/tool (`claude`, `codex`, `cursor`, …) |
| `accepted` | no (defaults `false`) | Only literal `true` counts as accepted; manual writers declare acceptance, while automatic Git rows use a non-revert heuristic. Other values count as rework. |
| `task_type` | no | optional low-cardinality label (`feature`, `bugfix`, …) |
| `status`, `session_hash`, `commit_hash`, `confidence`, `methodology`, `parent_count` | no | scalar attribution metadata supported by `sanitizeOutcome` |

Any agent (or a merged‑PR backfill, or a human) can append to this file.
See [`outcomes.sample.jsonl`](../outcomes.sample.jsonl).

### Privacy invariant — metadata only

`outcomes.jsonl` is **metadata only**. The reader
(`src/lib/outcomes-engine.js` → `sanitizeOutcome`) whitelists the scalar fields
above and **drops everything else at read time** — so PR bodies, diffs, prompts,
or message text can never reach the dashboard even if a writer accidentally
includes them. This outcomes/analytics path carries usage metrics and outcome
metadata only. The separate CLI Sessions reader can display full local transcripts;
see [PRIVACY.md](PRIVACY.md) for that boundary.

## Enabling the card

1. In the dashboard, open **Settings → Labs → Quality per dollar** and turn it on.
2. Use automatic local Git attribution, or optionally create `~/.tokentracker/tracker/outcomes.jsonl` for explicit accepted/task outcomes.

The card appears in the dashboard **only when both** the toggle is on **and**
outcome data exists. With the toggle on but no data, nothing new renders.

## Automatic Git attribution

`src/lib/git-outcomes.js` reads local Git metadata for recent session projects. It attributes a commit only when one session overlaps its author time (with the implementation’s bounded margin), records commit/session hashes, timing/model/tool and confidence, and treats a revert subject as unaccepted. It does not verify a PR merge, tests or task gates; interpret automatic acceptance as a heuristic. Commit subjects are used locally for revert detection and not retained in outcomes.

The generated `~/.tokentracker/tracker/auto-outcomes.jsonl` and `.meta.json` are local-only. Session fingerprints and a 30-minute probe TTL avoid repeated Git scans; overlapping requests share one build. `TOKENTRACKER_DISABLE_GIT_ATTRIBUTION=1` skips new probes but keeps existing attribution data. macOS protected directories are skipped unless `TOKENTRACKER_GIT_ATTRIBUTION_PROTECTED_DIRS=1`.

## Read-time join

- `GET /functions/tokentracker-outcomes?from=&to=` builds session analytics and refreshes Git attribution, then combines manual and automatic sidecars through `readAllOutcomesData`. Commit hashes deduplicate rows; other rows use timestamp/model/tool/task type.
- It joins metadata to scoped token/cost rows and returns per-model/tool ratios, effective tokens and totals. The UI prominently displays average cost per accepted outcome.
- No usable outcomes returns `{ "available": false, … }`. Scanner failure degrades to existing sidecars.
- This layer does not change `queue.jsonl` or the sync schema. None of these outcomes are uploaded by aggregate cloud sync.

Implementation tests: `test/outcomes-engine.test.js`, `test/git-outcomes.test.js`; see [architecture.md](architecture.md) for its separation from the full transcript reader.
