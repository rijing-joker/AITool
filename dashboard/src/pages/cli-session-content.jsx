import React, { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Brain,
  ChevronRight,
  Coins,
  Copy,
  Image as ImageIcon,
  Timer,
  Wrench,
} from "lucide-react";
import { copy } from "../lib/copy";
import { formatCostUsd } from "../lib/cost-format";
import { toolCallPayloadText } from "../lib/session-export";
import { isFailedStep, stepText } from "./cli-sessions-model";

export function formatTime(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const compactNumber = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function formatUsageTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  return compactNumber.format(value);
}

function formatUsageDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function relativeFrom(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const diff = Date.now() - ms;
  if (!Number.isFinite(diff) || diff < 0) return null;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return copy("clisessions.time.now");
  if (minutes < 60) return copy("clisessions.time.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return copy("clisessions.time.hours", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return copy("clisessions.time.days", { count: days });
  return null;
}

export function roleKey(role) {
  return ["user", "assistant", "tool"].includes(role) ? role : "unknown";
}

// Reader-header usage chips (cc-switch 31e5ae3): total tokens, active span and
// the models.dev-estimated cost, when the server could price the session.
export function UsageChips({ usage }) {
  if (!usage || typeof usage !== "object") return null;
  const chips = [];
  const tokens = formatUsageTokens(usage.totalTokens);
  if (tokens != null) {
    chips.push({
      key: "tokens",
      icon: Coins,
      label: copy("clisessions.usage.tokens"),
      value: tokens,
      title: String(usage.totalTokens),
    });
  }
  const duration = formatUsageDuration(usage.durationMs);
  if (duration != null) {
    chips.push({
      key: "duration",
      icon: Timer,
      label: copy("clisessions.usage.duration"),
      value: duration,
      title: `${Math.round(usage.durationMs / 1000)}s`,
    });
  }
  const cost = formatCostUsd(usage.estimatedCostUsd);
  if (cost != null) {
    chips.push({
      key: "cost",
      label: copy("clisessions.usage.cost"),
      value: cost,
      title: usage.model
        ? `$${usage.estimatedCostUsd.toFixed(6)} · ${usage.model}`
        : undefined,
    });
  }
  if (chips.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-[11px] tabular-nums text-oai-gray-500 dark:text-oai-gray-400">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex items-center gap-1"
          title={chip.title}
        >
          {chip.icon ? <chip.icon size={11} aria-hidden="true" /> : null}
          <span className="hidden sm:inline">{chip.label}</span>
          <span className="font-medium text-oai-gray-700 dark:text-oai-gray-300">
            {chip.value}
          </span>
        </span>
      ))}
    </div>
  );
}

// Split text into plain and hit segments for search highlighting (cc-switch
// 4ca7f47/b23c9d5: a find hit inside a collapsed block also OPENS it).
function highlightSegments(text, query) {
  if (!query) return null;
  const segments = [];
  const lower = String(text ?? "").toLowerCase();
  const needle = query.toLowerCase();
  let index = 0;
  for (;;) {
    const hit = lower.indexOf(needle, index);
    if (hit < 0) {
      if (index < text.length)
        segments.push({ text: text.slice(index), hit: false });
      break;
    }
    if (hit > index)
      segments.push({ text: text.slice(index, hit), hit: false });
    segments.push({ text: text.slice(hit, hit + needle.length), hit: true });
    index = hit + needle.length;
  }
  return segments;
}

export function HighlightedText({ text, query }) {
  const segments = highlightSegments(text, query);
  if (!segments) {
    return text;
  }
  const parts = segments.map((segment, index) => {
    if (segment.hit) {
      return (
        <mark
          data-session-hit=""
          key={index}
          className="rounded-sm bg-amber-200 px-0.5 text-oai-black dark:bg-amber-500/40 dark:text-white"
        >
          {segment.text}
        </mark>
      );
    }
    return <React.Fragment key={index}>{segment.text}</React.Fragment>;
  });
  return parts;
}

export function textHits(text, query) {
  return (
    !!query &&
    String(text ?? "")
      .toLowerCase()
      .includes(query.toLowerCase())
  );
}

function compactTokenCount(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value >= 1000)
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  return String(value);
}

function TranscriptImage({ image, index }) {
  const [failed, setFailed] = useState(false);
  if (image.dataUrl && !failed) {
    return (
      <img
        src={image.dataUrl}
        alt={copy("clisessions.image.alt", { count: index + 1 })}
        loading="lazy"
        onError={() => setFailed(true)}
        className="max-h-48 max-w-full rounded-lg border border-oai-gray-200 dark:border-oai-gray-700"
      />
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-lg border border-dashed border-oai-gray-300 px-2 py-1 text-[11px] text-oai-gray-500 dark:border-oai-gray-700 dark:text-oai-gray-400">
      <ImageIcon size={11} aria-hidden="true" />
      {copy(
        failed
          ? "clisessions.image.unavailable"
          : "clisessions.image.oversized",
      )}
    </span>
  );
}

function PatchDiff({ patch, query }) {
  const [showAll, setShowAll] = useState(false);
  const lines = patch.body.split("\n");
  const truncated =
    !showAll && !textHits(patch.body, query) && 400 < lines.length;
  return (
    <>
      {Array.isArray(patch.files) && patch.files.length !== 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {patch.files.map((file, index) => (
            <span
              key={index}
              className="break-all rounded bg-oai-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-oai-gray-600 dark:bg-oai-gray-900 dark:text-oai-gray-300"
            >
              {file.path}
            </span>
          ))}
        </div>
      ) : null}
      <pre className="mt-1.5 max-h-72 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5">
        {(truncated ? lines.slice(0, 400) : lines).map((line, index) => (
          <span
            key={index}
            className={`block ${
              line.startsWith("+")
                ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"
                : line.startsWith("-")
                  ? "bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300"
                  : line.startsWith("***")
                    ? "font-semibold text-oai-gray-700 dark:text-oai-gray-200"
                    : "text-oai-gray-500 dark:text-oai-gray-400"
            }`}
          >
            <HighlightedText text={line} query={query} />
          </span>
        ))}
      </pre>
      {truncated ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="min-h-10 text-xs text-oai-brand-600 dark:text-oai-brand-400"
        >
          {copy("clisessions.patch.show_more", { count: lines.length - 400 })}
        </button>
      ) : null}
    </>
  );
}

function highlightMarkdown(query) {
  return () => (tree) => {
    if (!query) return;
    const visit = (node) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text") {
          visit(child);
          return [child];
        }
        const parts = highlightSegments(child.value, query);
        return parts.map((part) =>
          part.hit
            ? {
                type: "element",
                tagName: "mark",
                properties: { "data-session-hit": "" },
                children: [{ type: "text", value: part.text }],
              }
            : { type: "text", value: part.text },
        );
      });
    };
    visit(tree);
  };
}

function safeLink(url) {
  return /^(https?:\/\/|mailto:)/i.test(url) ? url : "";
}

const markdownComponents = {
  a: ({ href, children }) => {
    return href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  // Session content stays local: rendering a transcript never fetches remote
  // images (which can contain tracking URLs or private query parameters).
  img: ({ src, alt }) => {
    return src ? (
      <a href={src} target="_blank" rel="noopener noreferrer">
        {alt || copy("clisessions.remote_image")}
      </a>
    ) : (
      <span>{alt}</span>
    );
  },
  table: ({ children }) => (
    <div className="max-w-full overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
};

export function MessageContent({
  message,
  query = "",
  onCopy,
  compact = false,
}) {
  const [expanded, setExpanded] = useState(false);
  const full = message.content || "";
  const long = full.length > 3000;
  const forced = textHits(full, query);
  const text = long && !expanded && !forced ? `${full.slice(0, 1500)}…` : full;
  const plugins = useMemo(() => {
    return [highlightMarkdown(query)];
  }, [query]);
  const user = message.role === "user";
  return (
    <div
      className={`group min-w-0 ${user ? "ml-auto flex max-w-[92%] flex-col items-end" : "w-full"}`}
    >
      <div
        className={`mb-1 flex min-h-6 items-center gap-2 text-[11px] text-oai-gray-400 ${user ? "justify-end" : ""}`}
      >
        <span className={compact ? "sr-only" : ""}>
          {copy(`clisessions.role.${roleKey(message.role)}`)}
        </span>
        {message.ts != null ? (
          <span className="tabular-nums">{formatTime(message.ts)}</span>
        ) : null}
        {message.model ? (
          <span className="max-w-44 truncate">{message.model}</span>
        ) : null}
        {message.usage ? (
          <span
            className="tabular-nums"
            title={copy("clisessions.msg_tokens", {
              up: message.usage.inputTokens ?? 0,
              down: message.usage.outputTokens ?? 0,
            })}
          >
            {compactTokenCount(message.usage.inputTokens)
              ? `↑${compactTokenCount(message.usage.inputTokens)} `
              : ""}
            {compactTokenCount(message.usage.outputTokens)
              ? `↓${compactTokenCount(message.usage.outputTokens)}`
              : ""}
          </span>
        ) : null}
        {full ? (
          <button
            type="button"
            aria-label={copy("clisessions.copy_message")}
            title={copy("clisessions.copy_message")}
            onClick={() => onCopy(full)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-md hover:bg-oai-gray-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 dark:hover:bg-oai-gray-800"
          >
            <Copy size={13} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div
        className={`min-w-0 max-w-full text-sm leading-7 [overflow-wrap:anywhere] ${user ? "rounded-2xl rounded-tr-sm bg-oai-brand-50 px-4 py-2.5 dark:bg-oai-brand-950/40" : compact ? "text-oai-gray-500 dark:text-oai-gray-400" : ""}`}
      >
        {user || 60000 < full.length ? (
          <p className="whitespace-pre-wrap">
            <HighlightedText text={text} query={query} />
          </p>
        ) : (
          <div className="[&_p]:my-2 [&_p:first-child]:mt-0 [&_h1]:my-3 [&_h1]:text-xl [&_h2]:my-3 [&_h2]:text-lg [&_h3]:my-2 [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_pre]:my-3 [&_pre]:max-w-full [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-oai-gray-50 [&_pre]:p-3 dark:[&_pre]:bg-oai-gray-800/60 [&_code]:font-mono [&_code]:text-xs [&_blockquote]:border-l-2 [&_blockquote]:border-oai-gray-300 [&_blockquote]:pl-3 [&_a]:text-oai-brand-600 [&_a]:underline dark:[&_a]:text-oai-brand-400 [&_table]:w-full [&_th]:border [&_th]:border-oai-gray-200 [&_th]:p-2 [&_td]:border [&_td]:border-oai-gray-200 [&_td]:p-2 dark:[&_td]:border-oai-gray-700 dark:[&_th]:border-oai-gray-700 [&_mark]:rounded-sm [&_mark]:bg-amber-200 [&_mark]:text-oai-black dark:[&_mark]:bg-amber-500/40 dark:[&_mark]:text-oai-white">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={plugins}
              components={markdownComponents}
              urlTransform={safeLink}
            >
              {text}
            </ReactMarkdown>
          </div>
        )}
        {long && !forced ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className="mt-1 min-h-10 text-xs text-oai-gray-500 hover:text-oai-brand-600"
          >
            {copy(
              expanded
                ? "clisessions.collapse_content"
                : "clisessions.expand_content",
            )}
          </button>
        ) : null}
        {message.images?.length ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {message.images.map((image, index) => (
              <TranscriptImage key={index} image={image} index={index} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ProcessStep({ step, query, onCopy }) {
  const [expanded, setExpanded] = useState(false);
  const forced = textHits(stepText(step), query);
  if (step.kind === "message") {
    return (
      <MessageContent
        message={step.message}
        query={query}
        onCopy={onCopy}
        compact
      />
    );
  }
  const thinking = step.kind === "thinking";
  const patch = step.call?.patch;
  const status = patch?.error ? "failed" : patch?.status || "pending";
  const payload = step.call ? toolCallPayloadText(step.call) : "";
  const label = thinking
    ? copy("clisessions.thinking")
    : step.call?.name || copy("clisessions.tool_output");
  return (
    <details
      open={expanded || forced}
      onToggle={(event) => {
        if (!forced) setExpanded(event.currentTarget.open);
      }}
      className={`group min-w-0 rounded-lg ${isFailedStep(step) ? "bg-red-50/60 dark:bg-red-950/20" : ""}`}
    >
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-lg px-2 text-xs text-oai-gray-500 hover:bg-oai-gray-50 dark:text-oai-gray-400 dark:hover:bg-oai-gray-800/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={12}
          className="shrink-0 group-open:rotate-90"
          aria-hidden="true"
        />
        {thinking ? (
          <Brain size={14} aria-hidden="true" />
        ) : (
          <Wrench size={14} aria-hidden="true" />
        )}
        <span className="min-w-0 truncate font-medium">
          <HighlightedText text={label} query={query} />
        </span>
        {patch ? (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px]">
            {status === "success" ? (
              <>
                <span className="text-emerald-600 dark:text-emerald-400">
                  +{patch.additions}
                </span>
                <span className="text-red-500 dark:text-red-400">
                  −{patch.deletions}
                </span>
              </>
            ) : null}
            <span className={status === "failed" ? "text-red-500" : ""}>
              {copy(`clisessions.patch.${status}`)}
            </span>
          </span>
        ) : null}
      </summary>
      <div className="mb-2 ml-6 min-w-0 border-l border-oai-gray-200 pl-3 dark:border-oai-gray-700">
        {patch ? <PatchDiff patch={patch} query={query} /> : null}
        {thinking || (!patch && payload) ? (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6 text-oai-gray-500 dark:text-oai-gray-400">
            <HighlightedText
              text={thinking ? step.message.thinking : payload}
              query={query}
            />
          </pre>
        ) : null}
        {step.output ? (
          <>
            <p className="mt-2 text-[10px] font-medium text-oai-gray-400">
              {copy("clisessions.tool_output")}
            </p>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6 text-oai-gray-500 dark:text-oai-gray-400">
              <HighlightedText text={step.output} query={query} />
            </pre>
          </>
        ) : null}
      </div>
    </details>
  );
}
