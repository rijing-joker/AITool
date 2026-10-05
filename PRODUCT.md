# AiTool — Product Context

register: product

## Product purpose

Local-first AI toolbox that merges three products into one dashboard:

1. **AI gateway** (EasyCLIProxyAPI / CLIProxyAPI parity) — a Node management layer driving the external `cli-proxy-api` core: OpenAI / Anthropic / Gemini-compatible endpoints on loopback, with per-request usage records and cost estimates (models.dev pricing).
2. **Provider config management** (cc-switch parity) — named per-tool provider presets one-click projected into the live config files of Claude Code / Codex / Gemini, plus shared MCP servers, per-app instruction prompts, plan-quota reads, and read-only CLI session history.
3. **Token usage analytics** (vendored TokenTracker) — 43 AI coding tools parsed into local half-hour buckets; proxied requests fold into the same trends, model breakdown, and cost views as native CLI usage.

Privacy-first: token counts only, never prompts or conversation bodies; every config write is backed up; cloud sync is strictly opt-in. Ships as a CLI (`serve` on :7680), a web dashboard (www.tokentracker.cc), and desktop apps (macOS menu bar, Windows tray, Linux, and the Tauri `AiTool.app` shell).

## Users

Developers and AI-power-users who run multiple agent CLIs daily — often against relays, pooled accounts, and provider plans they switch between — and want a single, trustworthy view of consumption and cost. They are fluent in tools like Linear, Raycast, Vercel, and GitHub. They check usage both at a desk (deep review) and on a phone (quick glance: "how much did I burn today / where am I on the leaderboard"). They distrust inflated numbers, so accuracy and legible key metrics matter more than decoration.

## Tone & principles

- Quiet, precise, trustworthy. The tool disappears into the task. Earned familiarity over novelty.
- Numbers are the hero content, but never the gradient-glow "hero-metric" cliché. Big figures must stay legible and never clip.
- Mobile is a first-class glance surface, not a shrunk desktop. Core metrics (total tokens, cost, your rank) must be visible without horizontal scrolling.
- Per-provider breakdown is secondary detail: fine to defer to a tap/expand on small screens.
- Local-first is a promise, not a tagline: loopback-only servers, backups before every config write, cloud sync off until the user opts in. Trust is the feature.

## Anti-references

- SaaS-cream landing-page gloss, neon-on-black "crypto" dashboards, gratuitous glassmorphism.
- Wide data tables that force horizontal scrolling on phones and bury the key column off-screen.
- Fluid/clamp display type that shrinks unpredictably inside narrow panels.
