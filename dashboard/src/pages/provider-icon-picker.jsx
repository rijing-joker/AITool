import React, { useMemo, useState } from "react";
import {
  Activity,
  Atom,
  Award,
  Bot,
  Boxes,
  Brain,
  Braces,
  Cloud,
  Code,
  CodeXml,
  Cpu,
  Database,
  Diamond,
  Feather,
  FileCode,
  Flame,
  Gem,
  GitBranch,
  Globe,
  Hammer,
  Heart,
  Key,
  Layers,
  Lightbulb,
  Moon,
  Mountain,
  Network,
  Puzzle,
  Rocket,
  Search,
  Server,
  Sparkles,
  SquareTerminal,
  Star,
  Sun,
  Terminal,
  Trash2,
  Trees,
  Waves,
  Wind,
  Zap,
  X,
} from "lucide-react";
import { copy } from "../lib/copy";
import { Button } from "../ui/components";

// Icon picker — a compact port of cc-switch's IconPicker: searchable grid,
// one-click select, auto-assigns an avatar color with the icon.

export const PROVIDER_ICON_PALETTE = [
  "orange",
  "blue",
  "green",
  "sky",
  "violet",
  "rose",
  "amber",
  "teal",
];

export const CURATED_ICONS = [
  "sparkles",
  "terminal",
  "gem",
  "shuffle",
  "boxes",
  "moon",
  "waves",
  "zap",
  "globe",
  "bot",
  "cpu",
  "database",
  "cloud",
  "rocket",
  "star",
  "heart",
  "shield",
  "key",
  "code",
  "code-xml",
  "braces",
  "activity",
  "atom",
  "award",
  "brain",
  "diamond",
  "feather",
  "file-code",
  "flame",
  "git-branch",
  "hammer",
  "layers",
  "lightbulb",
  "mountain",
  "network",
  "puzzle",
  "server",
  "square-terminal",
  "sun",
  "trees",
  "wind",
  "trash-2",
];

const ICON_COMPONENTS = {
  activity: Activity,
  atom: Atom,
  award: Award,
  bot: Bot,
  boxes: Boxes,
  brain: Brain,
  braces: Braces,
  cloud: Cloud,
  code: Code,
  "code-xml": CodeXml,
  cpu: Cpu,
  database: Database,
  diamond: Diamond,
  feather: Feather,
  "file-code": FileCode,
  flame: Flame,
  gem: Gem,
  "git-branch": GitBranch,
  globe: Globe,
  hammer: Hammer,
  heart: Heart,
  key: Key,
  layers: Layers,
  lightbulb: Lightbulb,
  moon: Moon,
  mountain: Mountain,
  network: Network,
  puzzle: Puzzle,
  rocket: Rocket,
  server: Server,
  sparkles: Sparkles,
  "square-terminal": SquareTerminal,
  star: Star,
  sun: Sun,
  terminal: Terminal,
  "trash-2": Trash2,
  trees: Trees,
  waves: Waves,
  wind: Wind,
  zap: Zap,
};

export function iconComponentFor(name) {
  return ICON_COMPONENTS[name] || null;
}

export function ProviderIconPicker({ open, value, color, onPick, onClose }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CURATED_ICONS;
    return CURATED_ICONS.filter((name) => name.includes(q));
  }, [query]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]">
      <div
        className="flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-oai-gray-200 dark:bg-oai-gray-950 dark:ring-oai-gray-800"
        role="dialog"
        aria-modal="true"
        aria-label={copy("pswitch.icon.picker_title")}
      >
        <div className="flex items-center justify-between gap-3 border-b border-oai-gray-100 px-5 py-3 dark:border-oai-gray-800">
          <h3 className="text-sm font-semibold text-oai-black dark:text-white">
            {copy("pswitch.icon.picker_title")}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-oai-gray-400 transition-colors hover:bg-oai-gray-100 hover:text-oai-black dark:hover:bg-oai-gray-800 dark:hover:text-white"
            aria-label={copy("pswitch.action.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 pt-3">
          <div className="flex items-center gap-2 rounded-lg border border-oai-gray-200 bg-white px-3 py-2 dark:border-oai-gray-800 dark:bg-oai-gray-900">
            <Search className="h-4 w-4 text-oai-gray-400" />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={copy("pswitch.icon.search_placeholder")}
              aria-label={copy("pswitch.icon.search_placeholder")}
              className="w-full bg-transparent text-sm text-oai-black focus:outline-none dark:text-white"
            />
          </div>
        </div>
        <div className="grid flex-1 grid-cols-6 gap-2 overflow-y-auto px-5 py-4 sm:grid-cols-8">
          {filtered.length === 0 ? (
            <p className="col-span-full py-6 text-center text-sm text-oai-gray-400">
              {copy("pswitch.icon.no_results")}
            </p>
          ) : (
            filtered.map((name) => {
              const Icon = iconComponentFor(name);
              if (!Icon) return null;
              const selected = value === name;
              return (
                <button
                  key={name}
                  type="button"
                  title={name}
                  aria-label={name}
                  onClick={() => onPick(name, PROVIDER_ICON_PALETTE[CURATED_ICONS.indexOf(name) % PROVIDER_ICON_PALETTE.length])}
                  className={`flex h-10 w-10 items-center justify-center justify-self-center rounded-lg border transition-colors ${
                    selected
                      ? "border-oai-brand-500 bg-oai-brand-50 text-oai-brand-600 dark:bg-oai-brand-950/40 dark:text-oai-brand-400"
                      : "border-oai-gray-200 text-oai-gray-500 hover:border-oai-gray-300 hover:text-oai-black dark:border-oai-gray-800 dark:text-oai-gray-400 dark:hover:text-white"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                </button>
              );
            })
          )}
        </div>
        <div className="flex justify-end border-t border-oai-gray-100 px-5 py-3 dark:border-oai-gray-800">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {copy("pswitch.icon.done")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default ProviderIconPicker;
