import { toolCallPayloadText } from "../lib/session-export";
import { copy } from "../lib/copy";

const APP_LABELS = {
  claude: "pswitch.tab.claude",
  codex: "pswitch.tab.codex",
  gemini: "pswitch.tab.gemini",
};
export const sessionAppLabel = (app) =>
  APP_LABELS[app] ? copy(APP_LABELS[app]) : app;
export const sessionIconButton =
  "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-oai-gray-500 hover:bg-oai-gray-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oai-brand-500 disabled:opacity-40 dark:hover:bg-oai-gray-800";

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
  return `${session.appId}:${session.sourcePath}`;
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
        ? session.projectDir || ""
        : time >= today
          ? "today"
          : time >= yesterday
            ? "yesterday"
            : time >= week
              ? "week"
              : "earlier";
    if (!groups.has(key)) groups.set(key, { key, sessions: [], latest: time });
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
    step.output,
  ]
    .filter(Boolean)
    .join("\n");
}

export function isChangeStep(step) {
  return (
    Boolean(step.call?.patch) ||
    /^(?:.*\.)?(?:apply_patch|edit|write|multiedit|write_file|replace)$/i.test(
      step.call?.name || "",
    )
  );
}

export function isFailedStep(step) {
  return (
    step.call?.patch?.error ||
    step.call?.patch?.status === "failed" ||
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
  messages.forEach((message, index) => {
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
      if (message.toolResults?.length) {
        message.toolResults.forEach((result, resultIndex) => {
          const id = result.toolUseId ?? result.callId;
          const output = result.content ?? result.output ?? "";
          const paired = id ? calls.get(id) : null;
          if (paired) {
            paired.output = [paired.output, output].filter(Boolean).join("\n");
            paired.failed ||=
              result.isError === true || result.is_error === true;
          } else {
            turn.steps.push({
              key: `${key}-result-${resultIndex}`,
              kind: "result",
              output,
              failed: result.isError === true || result.is_error === true,
            });
          }
        });
      } else if (message.content) {
        turn.steps.push({ key, kind: "result", output: message.content });
      }
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
