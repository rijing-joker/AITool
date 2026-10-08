// Session transcript → Markdown export (cc-switch exportMarkdown.ts port,
// minimal): one section per message with role heading, thinking block, tool
// calls as fenced code. Plain text construction — no JSX.
const ROLE_HEADINGS = {
  user: "## User",
  assistant: "## Assistant",
  tool: "## Tool",
};

const THINKING_OPEN = "<details><summary>@@@</summary>".replace("@@@", "Thinking");

function roleHeading(role) {
  return ROLE_HEADINGS[role] || "## Message";
}

// Each reader in src/lib/sessions.js names the tool payload after its own log
// format: claude emits `input` (object), gemini `args` (object), codex
// `arguments` (a JSON *string*). Shared with the on-screen renderer so the
// transcript and the Markdown export never disagree about what a call carried.
export function toolCallPayloadText(call) {
  if (call?.input != null) return stringifyPayload(call.input);
  if (call?.args != null) return stringifyPayload(call.args);
  if (typeof call?.arguments === "string" && call.arguments) {
    try {
      return stringifyPayload(JSON.parse(call.arguments));
    } catch {
      return call.arguments;
    }
  }
  return "";
}

function stringifyPayload(payload) {
  return typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

export function exportSessionMarkdown(session, messages, formatTime, roleKey) {
  const lines = [`# ${session?.title || "CLI session"}`, ""];
  for (const message of messages) {
    lines.push(roleHeading(roleKey(message.role)));
    if (message.ts != null) lines.push(`_${formatTime(message.ts)}_`);
    if (message.thinking) {
      lines.push(THINKING_OPEN);
      lines.push("", message.thinking, "");
      lines.push("</details>", "");
    }
    if (message.content) lines.push(message.content, "");
    for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
      const payloadText = toolCallPayloadText(call);
      lines.push(`**Tool: ${call.name}**`, "", "```", payloadText, "```", "");
    }
  }
  return lines.join("\n");
}
