# UI Foundation

App-level providers, formatting and motion primitives shared across the dashboard.

- `LocaleProvider` — locale and registry-backed copy.
- `ThemeProvider` / `ThemeToggle` — light/dark/system theme; defaults to system, persists the choice and consumes native appearance updates.
- `CurrencyProvider` / `TokenFormatProvider` — shared currency and token formatting.
- `FadeIn` — shared motion wrapper.
- `ClawdAnimated`, `BotAnimated`, `PetAtlasAnimated` — mascot/pet renderers; the bot engine is documented [here](../../lib/bot/README.md).

Shared atoms (Button / Card / Input / Sidebar / Shell) live in `../components/`; feature panels live in `../dashboard/`. Tokens and responsive conventions are in [DESIGN.md](../../../../DESIGN.md); functional boundaries are in [architecture.md](../../../../docs/architecture.md).
