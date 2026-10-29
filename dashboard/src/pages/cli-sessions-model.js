import { toolCallPayloadText } from "../lib/session-export";
import { toolCategory } from "./cli-session-tools";
import { copy } from "../lib/copy";

const APP_LABELS = {
  claude: "pswitch.tab.claude",
  codex: "pswitch.tab.codex",
  gemini: "pswitch.tab.gemini",
  agy: "pswitch.tab.agy",
  opencode: "pswitch.tab.opencode",
  hermes: "pswitch.tab.hermes",
  grokbuild: "pswitch.tab.grokbuild",
  pi: "pswitch.tab.pi",
  omp: "pswitch.tab.omp",
  dsh: "pswitch.tab.dsh",
  mcode: "pswitch.tab.mcode",
  kimi: "pswitch.tab.kimi",
};
export const sessionAppLabel = (app) =>
  APP_LABELS[app] ? copy(APP_LABELS[app]) : app;
export const sessionIconButton =
  "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-oai-gray-600 dark:text-oai-gray-400 hover:bg-oai-gray-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oai-brand-500 disabled:opacity-40 dark:hover:bg-oai-gray-800";

// Interaction model follows cc-switch SessionManagerPage / reader/turns.ts
// (5ae6ad3). Adapt the local read-only API without changing the source logs.
export const SESSION_PREFS = {
  group: "aitool.cli-sessions.group",
  collapsed: "aitool.cli-sessions.collapsed",
  outline: "aitool.cli-sessions.outline",
  processes: "aitool.cli-sessions.processes",
};

export function readPreference(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writePreference(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Optional preference. */
  }
}

export function sessionKey(session) {
  return `${session.appId}:${session.sourcePath || session.sessionId}`;
}

export function baseName(path) {
  return (
    path
      ?.replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || ""
  );
}

export function sessionTime(session) {
  return session.lastActiveAt ?? session.createdAt ?? 0;
}

export function filterSessions(sessions, query) {
  const needle = query.trim().toLowerCase();
  return sessions
    .filter((session) =>
      [
        session.title,
        session.summary,
        session.projectDir,
        session.sessionId,
      ].some((value) =>
        String(value ?? "")
          .toLowerCase()
          .includes(needle),
      ),
    )
    .sort(
      (a, b) =>
        sessionTime(b) - sessionTime(a) ||
        sessionKey(a).localeCompare(sessionKey(b)),
    );
}

export function projectGroupKey(directory) {
  const value = String(directory || "");
  // Only Windows paths are case-insensitive. POSIX backslashes and case are
  // meaningful; preserve them regardless of which OS renders the history.
  if (/^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(value)) {
    return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }
  return value.replace(/\/+$/, "") || (value.startsWith("/") ? "/" : "");
}

export function groupSessions(sessions, mode, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const week = new Date(today);
  week.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const groups = new Map();
  for (const session of sessions) {
    const time = sessionTime(session);
    const key =
      mode === "project"
        ? projectGroupKey(session.projectDir)
        : time >= today
          ? "today"
          : time >= yesterday
            ? "yesterday"
            : time >= week
              ? "week"
              : "earlier";
    if (!groups.has(key))
      groups.set(key, {
        key,
        projectDir: session.projectDir || "",
        sessions: [],
        latest: time,
      });
    groups.get(key).sessions.push(session);
  }
  return [...groups.values()];
}

export function stepText(step) {
  return [
    step.message?.content,
    step.message?.thinking,
    step.call?.name,
    step.call && toolCallPayloadText(step.call),
    step.call?.patch?.body,
    step.result?.diff,
    step.result?.structuredPatch && JSON.stringify(step.result.structuredPatch),
    step.output,
  ]
    .filter(Boolean)
    .join("\n");
}

export function isChangeStep(step) {
  return Boolean(step.call?.patch || step.call?.patchRef || step.result?.diff || step.result?.diffRef || step.result?.structuredPatch || step.result?.structuredPatchRef) || toolCategory(step.call) === "edit";
}

export function isFailedStep(step) {
  return (
    step.call?.patch?.error ||
    step.call?.patch?.status === "failed" ||
    step.status === "failed" ||
    step.status === "interrupted" ||
    step.failed
  );
}

export function buildSessionTurns(messages) {
  const turns = [];
  let turn;
  const calls = new Map();
  const begin = (index, question = null) => {
    turn = { key: `turn-${index}`, question, steps: [], final: null };
    turns.push(turn);
  };
  const addResults = (message, index) => {
    (message.toolResults || []).forEach((result, resultIndex) => {
      const id = result.toolUseId ?? result.callId;
      const output = result.output ?? result.content ?? "";
      const outputPart = { key: `message-${index}-result-${resultIndex}`, output,
        reference: result.outputRef || result.contentRef };
      const paired = id ? calls.get(id) : null;
      const failed =
        result.isError === true ||
        result.is_error === true ||
        result.status === "failed" || (result.exitCode != null && result.exitCode !== 0);
      // Claude tool_result with no error flag is a completed result. Other
      // providers require a known status/exit code rather than output guessing.
      const status =
        result.status ||
        (failed ? "failed" : "toolUseId" in result ? "success" : undefined);
      if (paired) {
        paired.output = [paired.output, output].filter(Boolean).join("\n");
        // A field reference addresses one result, never the combined output.
        (paired.outputParts ??= []).push(outputPart);
        paired.failed ||= failed;
        if (status) paired.status = status;
        paired.result = { ...result };
        paired.exitCode = result.exitCode;
        paired.durationMs = result.durationMs;
      } else {
        if (!turn) begin(index);
        turn.steps.push({
          key: `message-${index}-result-${resultIndex}`,
          kind: "result",
          output,
          outputParts: [outputPart],
          failed,
          status,
          result: { ...result },
        });
      }
    });
  };
  messages.forEach((message, index) => {
    if (message.injected) return;
    // Mixed Claude user rows finish earlier calls before opening a question.
    if (message.role === "user") addResults(message, index);
    if (
      message.role === "user" &&
      (message.content?.trim() || message.images?.length)
    ) {
      begin(index, message);
      return;
    }
    if (!turn) begin(index);
    const key = `message-${index}`;
    if (message.thinking)
      turn.steps.push({
        key: `${key}-thinking`,
        kind: "thinking",
        message: { ...message, content: "" },
      });
    if (message.role === "tool") {
      addResults(message, index);
      if (!message.toolResults?.length && message.content)
        turn.steps.push({ key, kind: "result", output: message.content, outputRef: message.contentRef });
      return;
    }
    // The local Claude reader includes these markers alongside toolCalls.
    // Remove only known projections; retain literal, unstructured messages.
    const names = new Set(
      (message.toolCalls || []).map((call) => `[Tool: ${call.name}]`),
    );
    const content = String(message.content || "")
      .split("\n")
      .filter((line) => !names.has(line.trim()))
      .join("\n")
      .trim();
    if (content || message.images?.length) {
      turn.steps.push({
        key,
        kind: "message",
        message: { ...message, content, thinking: null, toolCalls: null },
      });
    }
    (message.toolCalls || []).forEach((call, callIndex) => {
      const step = {
        key: `${key}-call-${callIndex}`,
        kind: "tool",
        call,
        message: { ts: message.ts },
      };
      turn.steps.push(step);
      const id = call.id ?? call.callId;
      if (id) calls.set(id, step);
    });
    if (message.role !== "user") addResults(message, index);
  });
  for (const entry of turns) {
    const last = entry.steps.at(-1);
    if (last?.kind === "message" && last.message.role === "assistant")
      entry.final = entry.steps.pop().message;
  }
  return turns;
}

export function turnText(turn) {
  return [
    turn.question?.content,
    ...turn.steps.map(stepText),
    turn.final?.content,
  ]
    .filter(Boolean)
    .join("\n");
}

export function turnPreview(turn) {
  return (turn.question?.content || turn.final?.content || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}
