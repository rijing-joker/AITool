# AiTool — Design System

Derived from `dashboard/src/styles.css` + `dashboard/tailwind.config.cjs`. Tailwind utility classes use the `oai-*` token names. The language is TokenTracker's, inherited unchanged by the AiTool merge — the newer AI Proxy, Provider Configs, and CLI Sessions pages are held to the same tokens.

The theme behavior is implemented in `dashboard/src/ui/foundation/ThemeProvider.jsx`; native appearance changes feed the same provider. This document describes shared tokens and conventions; feature behavior is in [docs/architecture.md](docs/architecture.md).

## Color (OKLCH, green-tinted neutrals, hue 145)

- **Neutrals** `oai-gray-50…950`: every neutral is tinted toward green (chroma ~0.005–0.03, hue 145). Surfaces, borders, text. Dark mode overrides the ramp; `ThemeProvider` defaults to `system` and persists an explicit light/dark/system choice.
- **Brand accent**: emerald — `--oai-blue: #059669` (token name is legacy; the brand is green), light `#10b981`, dark `#047857`. Exposed as `oai-brand` utilities. Used for primary action, current selection, cost figure, and "you/me" highlight only. Restrained: accent ≤10% of surface.
- **Semantic**: success `#10b981`, warning `#f59e0b`, error `#ef4444`, info `#059669`.
- Never `#000`/`#fff`: base black `#0a0a0a`, white `#fafafa`.
- Per-provider category colors come from `getProviderColor()` (data-viz only, in distribution bars/charts).

Hex fallbacks in `styles.css` support older WebViews; its `@supports` block restores OKLCH on compatible engines.

## Typography

- **Sans**: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, …` (system stack). `font-sans` and `font-oai` both resolve `--oai-font-sans`, including explicit local CJK sans fallbacks so Chinese labels do not fall through to a serif face. No font download is required.
- **Mono**: `"SF Mono", SFMono-Regular, ui-monospace, Menlo, …` (`font-mono`) for token counts, terminal-style copy, IDs.
- Numbers use `tabular-nums`.
- Fixed rem-ish scale (Tailwind `text-xs … text-7xl`); product UI uses fixed steps, NOT fluid clamp headings. The one giant metric is the exception and must be width-bounded.

## Layout & components

- Card primitive: `Card` (single border + subtle elevation). No nested cards.
- Shared atoms live in `dashboard/src/ui/components/`. Use `PageHeader` for page titles/descriptions/actions and `PageTabs` for route-local navigation, including CLI Sessions. Keep management pages on a `max-w-6xl` content grid with `px-4 sm:px-6` and `py-6 sm:py-8` spacing; the session reader keeps its full-height layout.
- Surfaces: the app canvas uses `oai-gray-50` / dark `oai-gray-950`; cards and controls use `oai-white` / dark `oai-gray-900`. Section headings use sentence case, `text-sm font-semibold`; secondary copy uses `oai-gray-600` / dark `oai-gray-400`.
- Actions: `Button` primary uses `oai-brand-700` with light text; secondary and ghost are neutral, danger uses the red semantic palette. Use `size="icon"` for square 40px icon controls. Inputs and selects share 40px height and 8px corners. Active page tabs and sidebar items carry the brand accent.
- Keyboard focus must remain visible. The global inset outline survives clipped/scrolling containers; never suppress outlines or Tailwind rings globally. Select menus render above management dialogs and expose a highlighted keyboard state.
- Responsive shell: desktop sidebar `hidden lg:flex`; mobile drawer + `MobileTopBar` (hamburger) `lg:hidden`. Content scrolls inside `div.flex-1.overflow-y-auto`.
- Breakpoints: Tailwind defaults (`sm`=640, `md`=768, `lg`=1024). Phone target 360–430px.
- Motion: `motion/react`, ease-out, 150–250ms, state-conveying only. Respect `prefers-reduced-motion`.

## Mobile structural rules (this project)

- Tab/segment groups: single horizontal-scroll row, never `flex-wrap` into stacks.
- Big metric: cap with `clamp()`/responsive font so it never clips at 360px.
- Data tables: collapse secondary columns below `sm`; keep the key metric on-screen (no horizontal scroll for core data). Detail goes to the profile/expand view.
- Touch targets ≥40px; tap feedback via `active:` states.
