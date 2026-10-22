import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Brain,
  FileText,
  FilePenLine,
  Terminal,
  Search,
  CheckCircle2,
  Clock,
  ChevronRight,
  Coins,
  Copy,
  Image as ImageIcon,
  Timer,
  Wrench,
  Globe,
  Network,
  Bot,
} from "lucide-react";
import { ProviderIcon } from "../ui/dashboard/components/ProviderIcon";
import { ContentLoadControl, useSessionText } from "./cli-session-lazy";
import { copy } from "../lib/copy";
import { useCostFormatter } from "../hooks/useCostFormatter";
import { toolCallPayloadText } from "../lib/session-export";
import {
  toolCategory,
  toolDiff,
  toolPath,
  toolTarget,
  toolStatus,
  shortPath,
  mcpTool,
  toolFacts,
} from "./cli-session-tools";
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
  const formatCost = useCostFormatter();
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
  const cost = formatCost(usage.estimatedCostUsd);
  if (cost != null) {
    chips.push({
      key: "cost",
      label: copy("clisessions.usage.cost"),
      value: cost,
      title: usage.model
        ? `${formatCost(usage.estimatedCostUsd, true)} · ${usage.model}`
        : undefined,
    });
  }
  if (chips.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-xs tabular-nums text-oai-gray-600 dark:text-oai-gray-400">
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
      {usage.pricedModels < usage.totalModels ? (
        <span className="w-full text-right">
          {copy("clisessions.usage.partial", {
            priced: usage.pricedModels,
            total: usage.totalModels,
          })}
        </span>
      ) : null}
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
    <span className="inline-flex items-center gap-1 rounded-lg border border-dashed border-oai-gray-300 px-2 py-1 text-xs text-oai-gray-500 dark:border-oai-gray-700 dark:text-oai-gray-400">
      <ImageIcon size={11} aria-hidden="true" />
      {copy(
        failed
          ? "clisessions.image.unavailable"
          : "clisessions.image.oversized",
      )}
    </span>
  );
}

function PatchDiff({ patch, query, onCopy }) {
  const [showAll, setShowAll] = useState(false);
  const truncated =
    !showAll && !textHits(patch.body, query) && 400 < patch.rows.length;
  const numbered = patch.rows.some((row) => {
    return row.old != null || row.new != null;
  });
  return (
    <div className="mt-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-oai-gray-600 dark:text-oai-gray-400">
        {patch.files.map((file, index) => (
          <button
            type="button"
            key={index}
            title={file.path}
            aria-label={copy("clisessions.copy_file_path", { path: file.path })}
            onClick={() => onCopy(file.path)}
            className="inline-flex min-h-10 min-w-0 items-center gap-2 text-left hover:text-oai-brand-600 dark:hover:text-oai-brand-400"
          >
            <FileText size={13} className="shrink-0" />
            <span className="break-all font-mono">{shortPath(file.path)}</span>
            <Copy size={12} className="shrink-0" />
          </button>
        ))}
        {patch.estimated ? (
          <span>{copy("clisessions.diff.proposed")}</span>
        ) : null}
      </div>
      <pre className="max-h-96 max-w-full overflow-auto rounded-md bg-oai-gray-50 py-2 font-mono text-xs leading-6 dark:bg-oai-gray-900/60">
        {(truncated ? patch.rows.slice(0, 400) : patch.rows).map(
          (row, index) => (
            <span
              key={index}
              className={`flex min-w-max ${row.kind === "add" ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300" : row.kind === "remove" ? "bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-300" : row.kind === "header" || row.kind === "hunk" ? "font-medium text-oai-gray-700 dark:text-oai-gray-300" : "text-oai-gray-600 dark:text-oai-gray-400"}`}
            >
              {numbered ? (
                <>
                  <span
                    aria-hidden="true"
                    className="sticky left-0 w-10 shrink-0 bg-oai-gray-100 pr-2 text-right tabular-nums text-oai-gray-600 dark:bg-oai-gray-800 dark:text-oai-gray-400"
                  >
                    {row.old ?? ""}
                  </span>
                  <span
                    aria-hidden="true"
                    className="sticky left-10 mr-3 w-10 shrink-0 bg-oai-gray-100 pr-2 text-right tabular-nums text-oai-gray-600 dark:bg-oai-gray-800 dark:text-oai-gray-400"
                  >
                    {row.new ?? ""}
                  </span>
                </>
              ) : null}
              <span className="whitespace-pre px-3">
                <HighlightedText text={row.text} query={query} />
              </span>
            </span>
          ),
        )}
      </pre>
      {truncated ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="min-h-10 text-xs text-oai-brand-600 dark:text-oai-brand-400"
        >
          {copy("clisessions.patch.show_more", {
            count: patch.rows.length - 400,
          })}
        </button>
      ) : null}
    </div>
  );
}

function codeText(node) {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(codeText).join("");
  return node?.props ? codeText(node.props.children) : "";
}

function SessionCodeBlock({ children, onCopy, complete }) {
  const element = React.Children.toArray(children)[0];
  const language =
    element?.props?.className?.replace(/^language-/, "") ||
    copy("clisessions.code");
  return (
    <div className="my-3 max-w-full overflow-hidden rounded-lg bg-oai-gray-50 dark:bg-oai-gray-800/60">
      <div className="flex items-center justify-between px-3 text-xs text-oai-gray-600 dark:text-oai-gray-400">
        <span>{language}</span>
        <button
          type="button"
          aria-label={copy("clisessions.copy_code")}
          disabled={!complete}
          title={complete ? copy("clisessions.copy_code") : copy("clisessions.expand_content")}
          onClick={() => onCopy(codeText(children).replace(/\n$/, ""))}
          className="inline-flex h-10 w-10 items-center justify-center rounded-md hover:bg-oai-gray-100 disabled:opacity-40 dark:hover:bg-oai-gray-700"
        >
          <Copy size={14} />
        </button>
      </div>
      <pre className="max-h-96 overflow-auto whitespace-pre px-3 pb-3 text-xs leading-6">
        {children}
      </pre>
    </div>
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
  appId,
}) {
  const [expanded, setExpanded] = useState(false);
  const lazy = useSessionText(message.content, message.contentRef, expanded);
  const full = lazy.text;
  const long = (message.contentRef?.length ?? full.length) > 3000;
  const forced = textHits(full, query);
  const text = long && !expanded && !forced ? `${full.slice(0, 1500)}…` : full;
  const plugins = useMemo(() => {
    return [highlightMarkdown(query)];
  }, [query]);
  const user = message.role === "user";
  const contentRef = useRef(null);
  const [rawHit, setRawHit] = useState(false);
  useEffect(() => {
    setRawHit(
      Boolean(
        forced && !contentRef.current?.querySelector("[data-session-hit]"),
      ),
    );
  }, [text, query, forced]);
  const hitAt = forced ? full.toLowerCase().indexOf(query.toLowerCase()) : -1;
  return (
    <div
      className={`group min-w-0 ${user ? "ml-auto flex max-w-[92%] flex-col items-end" : "w-full"}`}
    >
      <div
        className={`mb-1 flex min-h-6 items-center gap-2 text-xs text-oai-gray-600 dark:text-oai-gray-400 ${user ? "justify-end" : ""}`}
      >
        {!user && appId ? <ProviderIcon provider={appId} size={16} /> : null}
        <span className={compact ? "sr-only" : ""}>
          {copy(`clisessions.role.${roleKey(message.role)}`)}
        </span>
        {message.ts != null ? (
          <span className="tabular-nums" title={formatTime(message.ts)}>
            {new Date(message.ts).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}
          </span>
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
            onClick={() => { void lazy.load(true).then(onCopy).catch(() => {}); }}
            className="inline-flex h-10 w-10 items-center justify-center rounded-md hover:bg-oai-gray-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 dark:hover:bg-oai-gray-800"
          >
            <Copy size={13} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div
        className={`min-w-0 max-w-full text-sm leading-7 [overflow-wrap:anywhere] ${user ? "rounded-2xl rounded-tr-sm bg-oai-brand-50 px-4 py-2.5 dark:bg-oai-brand-950/40" : compact ? "text-oai-gray-600 dark:text-oai-gray-400" : ""}`}
      >
        <div ref={contentRef}>
          {60000 < full.length ? (
            <p className="whitespace-pre-wrap">
              <HighlightedText text={text} query={query} />
            </p>
          ) : (
            <div className="[&_p]:my-2 [&_p:first-child]:mt-0 [&_h1]:my-3 [&_h1]:text-xl [&_h2]:my-3 [&_h2]:text-lg [&_h3]:my-2 [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_pre]:my-3 [&_pre]:max-w-full [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-oai-gray-50 [&_pre]:p-3 dark:[&_pre]:bg-oai-gray-800/60 [&_code]:font-mono [&_code]:text-xs [&_blockquote]:border-l-2 [&_blockquote]:border-oai-gray-300 [&_blockquote]:pl-3 [&_a]:text-oai-brand-600 [&_a]:underline dark:[&_a]:text-oai-brand-400 [&_table]:w-full [&_th]:border [&_th]:border-oai-gray-200 [&_th]:p-2 [&_td]:border [&_td]:border-oai-gray-200 [&_td]:p-2 dark:[&_td]:border-oai-gray-700 dark:[&_th]:border-oai-gray-700 [&_mark]:rounded-sm [&_mark]:bg-amber-200 [&_mark]:text-oai-black dark:[&_mark]:bg-amber-500/40 dark:[&_mark]:text-oai-white">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={plugins}
                components={{
                  ...markdownComponents,
                  pre: ({ children }) => (
                    <SessionCodeBlock onCopy={onCopy} complete={lazy.complete && text === full}>
                      {children}
                    </SessionCodeBlock>
                  ),
                }}
                urlTransform={safeLink}
              >
                {text}
              </ReactMarkdown>
            </div>
          )}
        </div>
        {rawHit ? (
          <div className="mt-2 rounded-md bg-oai-gray-50 px-3 py-2 text-xs dark:bg-oai-gray-800">
            <p className="mb-1 text-oai-gray-600 dark:text-oai-gray-400">
              {copy("clisessions.find_raw")}
            </p>
            <pre className="overflow-auto whitespace-pre-wrap">
              <HighlightedText
                text={full.slice(
                  Math.max(0, hitAt - 70),
                  hitAt + query.length + 100,
                )}
                query={query}
              />
            </pre>
          </div>
        ) : null}
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
        {expanded || lazy.error || lazy.busy ? <ContentLoadControl content={lazy} /> : null}
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

export function ProcessStep(props) {
  return props.step.kind === "group" ? <ProcessGroup {...props} /> : <SingleProcessStep {...props} />;
}

function ProcessGroup({ step, query, onCopy, projectDir }) {
  const [expanded, setExpanded] = useState(false);
  const forced = step.children.some(child => { return textHits(stepText(child), query); });
  const Icon = step.category === "mcp" ? Network : Search;
  const targets = step.children.map(child => { return toolTarget(child.call, projectDir); }).filter(Boolean).join(" · ");
  return (
    <details open={expanded || forced} data-session-group=""
      onToggle={event => { if (!forced) setExpanded(event.currentTarget.open); }}
      className="min-w-0">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-lg px-2 text-xs text-oai-gray-600 hover:bg-oai-gray-50 dark:text-oai-gray-400 dark:hover:bg-oai-gray-800/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={12} className={`shrink-0 ${expanded || forced ? "rotate-90" : ""}`} />
        <Icon size={14} className="shrink-0" />
        <span className="max-w-[65%] shrink-0 truncate font-medium" title={step.server}>{copy(`clisessions.group_steps.${step.category}`, { count: step.children.length, server: step.server || "" })}</span>
        <span className="min-w-0 flex-1 truncate" title={targets}><HighlightedText text={targets} query={query} /></span>
        <CheckCircle2 size={14} className="shrink-0 text-emerald-700 dark:text-emerald-400" aria-label={copy("clisessions.status.success")} />
      </summary>
      {expanded || forced ? <div className="ml-4 border-l border-oai-gray-200 pl-2 dark:border-oai-gray-700">
        {step.children.map(child => <ProcessStep key={child.key} step={child} query={query} onCopy={onCopy} projectDir={projectDir} />)}
      </div> : null}
    </details>
  );
}

function ProcessOutput({ output, reference, query }) {
  const content = useSessionText(output, reference, true);
  return (
    <>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6 text-oai-gray-600 dark:text-oai-gray-400">
        <HighlightedText text={content.text} query={query} />
      </pre>
      <ContentLoadControl content={content} />
    </>
  );
}

function SingleProcessStep({ step, query, onCopy, projectDir }) {
  const [expanded, setExpanded] = useState(() => Boolean(isFailedStep(step)));
  const forced = textHits(stepText(step), query);
  const thinkingContent = useSessionText(step.message?.thinking, step.message?.thinkingRef, expanded || forced);
  const outputs = step.outputParts || [{ key: "output", output: step.output, reference: step.outputRef }];
  const hasOutput = outputs.some(part => part.output || part.reference);
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
  const patch = toolDiff(step);
  const status = toolStatus(step);
  const target = toolTarget(step.call, projectDir);
  const facts = toolFacts(step.call);
  const mcp = mcpTool(step.call);
  const category = toolCategory(step.call);
  const StepIcon = thinking
    ? Brain
    : { command: Terminal, edit: FilePenLine, read: FileText, search: Search, mcp: Network, agent: Bot, web: Globe }[
        category
      ] || Wrench;
  const StatusIcon =
    !patch && status === "success"
      ? CheckCircle2
      : !patch && status === "pending"
        ? Clock
        : null;
  const statusLabel = copy(
    `clisessions.${patch && ["success", "failed", "pending"].includes(status) ? "patch" : "status"}.${status}`,
  );
  const payload = step.call ? toolCallPayloadText(step.call) : "";
  const label = thinking
    ? copy("clisessions.thinking")
    : mcp?.name || step.call?.name || copy("clisessions.tool_output");
  return (
    <details
      open={expanded || forced}
      onToggle={(event) => {
        if (!forced) setExpanded(event.currentTarget.open);
      }}
      className={`group min-w-0 rounded-lg ${isFailedStep(step) ? "bg-red-50/60 dark:bg-red-950/20" : ""}`}
    >
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-lg px-2 text-xs text-oai-gray-600 hover:bg-oai-gray-50 dark:text-oai-gray-400 dark:hover:bg-oai-gray-800/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={12}
          className="shrink-0 group-open:rotate-90"
          aria-hidden="true"
        />
        <StepIcon size={14} className="shrink-0" aria-hidden="true" />
        <span className="max-w-[40%] shrink-0 truncate font-medium" title={step.call?.name}>
          <HighlightedText text={label} query={query} />
        </span>
        {mcp ? <span className="hidden max-w-24 truncate sm:inline">{mcp.server}</span> : null}
        {target ? (
          <span
            title={toolPath(step.call) || target}
            className={`min-w-0 flex-1 truncate text-xs text-oai-gray-700 dark:text-oai-gray-300 ${["read", "edit", "command"].includes(category) ? "font-mono" : ""}`}
          >
            <HighlightedText text={target} query={query} />
          </span>
        ) : null}
        {step.call ? (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs">
            {patch ? (
              <span className="hidden sm:inline">
                <span className="text-emerald-700 dark:text-emerald-400">
                  +{patch.rows.filter((row) => row.kind === "add").length}
                </span>{" "}
                <span className="text-red-700 dark:text-red-400">
                  −{patch.rows.filter((row) => row.kind === "remove").length}
                </span>
              </span>
            ) : null}
            {step.exitCode != null ? (
              <span className="tabular-nums">
                {copy("clisessions.exit_code", { code: step.exitCode })}
              </span>
            ) : null}
            {step.durationMs != null ? (
              <span className="hidden tabular-nums sm:inline">
                {(step.durationMs / 1000).toFixed(1)}s
              </span>
            ) : null}
            {StatusIcon ? (
              <StatusIcon
                size={14}
                className={
                  status === "success"
                    ? "text-emerald-700 dark:text-emerald-400"
                    : ""
                }
                aria-label={copy(`clisessions.status.${status}`)}
              />
            ) : (
              <span
                className={
                  status === "failed" ? "text-red-700 dark:text-red-400" : ""
                }
              >
                {statusLabel}
              </span>
            )}
          </span>
        ) : null}
      </summary>
      {expanded || forced ? <div className="mb-2 ml-6 min-w-0 border-l border-oai-gray-200 pl-3 dark:border-oai-gray-700">
        {facts.length ? <dl className="mb-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs leading-6">
          {facts.map(fact => <React.Fragment key={fact.key}>
            <dt className="text-oai-gray-600 dark:text-oai-gray-400">{copy(`clisessions.fact.${fact.key}`)}</dt>
            <dd className="break-all"><HighlightedText text={fact.value} query={query} /></dd>
          </React.Fragment>)}
        </dl> : null}
        {patch ? (
          <PatchDiff patch={patch} query={query} onCopy={onCopy} />
        ) : null}
        {thinking || (!patch && payload && !facts.length) ? (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6 text-oai-gray-600 dark:text-oai-gray-400">
            <HighlightedText
              text={thinking ? thinkingContent.text : payload}
              query={query}
            />
          </pre>
        ) : null}
        {thinking ? <ContentLoadControl content={thinkingContent} /> : null}
        {facts.length && payload ? <details open={textHits(payload, query) || undefined}>
          <summary className="min-h-10 cursor-pointer py-3 text-xs text-oai-gray-600 dark:text-oai-gray-400">{copy("clisessions.tool_parameters")}</summary>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6"><HighlightedText text={payload} query={query} /></pre>
        </details> : null}
        {patch &&
        payload &&
        textHits(payload, query) &&
        !textHits(patch.body, query) ? (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs">
            <HighlightedText text={payload} query={query} />
          </pre>
        ) : null}
        {step.message?.thinkingTruncated ? (
          <p className="text-xs text-oai-gray-600 dark:text-oai-gray-400">
            {copy("clisessions.thinking_truncated")}
          </p>
        ) : null}
        {hasOutput ? (
          <>
            <p className="mt-2 text-xs font-medium text-oai-gray-600 dark:text-oai-gray-400">
              {copy("clisessions.tool_output")}
            </p>
            {outputs.map(part => (
              <ProcessOutput key={part.key} output={part.output} reference={part.reference} query={query} />
            ))}
          </>
        ) : null}
      </div> : null}
    </details>
  );
}
