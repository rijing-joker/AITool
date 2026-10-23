# AiTool — Product Context

register: product

## Product purpose

Local-first AI toolbox that merges three products into one dashboard:

1. **AI gateway** (EasyCLIProxyAPI / CLIProxyAPI parity) — a Node management layer driving the external `cli-proxy-api` core: OpenAI / Anthropic / Gemini-compatible endpoints on loopback, with per-request usage records and cost estimates (models.dev pricing).
2. **Provider config management** (cc-switch parity) — named per-tool provider presets one-click projected into the live config files or launch profiles of ten tools (Claude Code, Codex, Gemini, Antigravity CLI, Grok Build, OpenCode, OpenClaw, Hermes, Pi and MiniMax Code), plus shared MCP servers and skills, per-app prompts, reusable profiles, multi-app bundles, drift diagnostics and project/role distribution.
3. **Token usage analytics** (vendored TokenTracker) — 45 AI coding tools parsed into local half-hour buckets; proxied requests fold into the same trends, model breakdown, and cost views as native CLI usage.

Read-only CLI history is a separate local surface for nine tools: transcripts, tool results, diffs, full-content search and Markdown export. It reads existing logs and caches them in bounded memory; conversation bodies do not enter analytics queues or cloud sync.

Local-first: managed config writes have backups and conflict checks; automatic cloud sync is off until enabled. A manual `aitool sync` is a one-time upload request when account/device credentials are available, without changing that preference. Proxy inference forwards content to the selected upstream; optional search, vision and intent classification have their own explicit activation. See [Privacy](docs/PRIVACY.md).

This personal fork runs from a checkout as the CLI (`serve` on :7680), dashboard and native apps. The inherited hosted dashboard at www.tokentracker.cc belongs to upstream. macOS/Windows/Linux TokenTracker apps bundle Node + CLI + dashboard; the separate `desktop/` AiTool shell depends on the checkout and installed Node. Fork work follows [CLAUDE.md](CLAUDE.md): ordinary `dev` commits, no version bump or release. See the [architecture overview](docs/architecture.md) for boundaries and the [documentation index](docs/README.md) for module guides.

## Users

Developers and AI-power-users who run multiple agent CLIs daily — often against relays, pooled accounts, and provider plans they switch between — and want a single, trustworthy view of consumption and cost. They are fluent in tools like Linear, Raycast, Vercel, and GitHub. They check usage both at a desk (deep review) and on a phone (quick glance: "how much did I burn today / where am I on the leaderboard"). They distrust inflated numbers, so accuracy and legible key metrics matter more than decoration.

## Tone & principles

- Quiet, precise, trustworthy. The tool disappears into the task. Earned familiarity over novelty.
- Numbers are the hero content, but never the gradient-glow "hero-metric" cliché. Big figures must stay legible and never clip.
- Mobile is a first-class glance surface, not a shrunk desktop. Core metrics (total tokens, cost, your rank) must be visible without horizontal scrolling.
- Per-provider breakdown is secondary detail: fine to defer to a tap/expand on small screens.
- Local-first is a promise, not a tagline: loopback by default, backups and conflict checks for managed writes, automatic cloud sync off until the user opts in. Trust is the feature.

## Anti-references

- SaaS-cream landing-page gloss, neon-on-black "crypto" dashboards, gratuitous glassmorphism.
- Wide data tables that force horizontal scrolling on phones and bury the key column off-screen.
- Fluid/clamp display type that shrinks unpredictably inside narrow panels.
