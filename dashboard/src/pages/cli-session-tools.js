// Local presentation model: source arguments remain intact for copy/export.
export function toolArgs(call) {
  const value = call?.input ?? call?.args ?? call?.arguments;
  if (typeof value !== "string") return value || {};
  try {
    return JSON.parse(value);
  } catch {
    return { text: value };
  }
}

export function toolCategory(call) {
  if (mcpTool(call)) return "mcp";
  if (/^web\./i.test(call?.name || "")) return "web";
  const name = String(call?.name || "")
    .split(".")
    .at(-1)
    .toLowerCase();
  if (
    /^(apply_patch|edit|multiedit|write|write_file|replace|replace_in_file)$/.test(
      name,
    )
  )
    return "edit";
  if (/^(bash|shell|exec_command|run_shell_command|terminal)$/.test(name))
    return "command";
  if (/^(read|read_file|read_many_files)$/.test(name)) return "read";
  if (/^(web|web_search|web_fetch|websearch|webfetch|google_web_search|fetch_url)$/.test(name)) return "web";
  if (/grep|search|glob|find/.test(name)) return "search";
  if (/agent|task|^(send_message|wait|resume_agent|close_agent)$/.test(name)) return "agent";
  return "tool";
}

export function mcpTool(call) {
  const name = String(call?.name || "");
  const native = name.match(/^mcp__([^]+?)__(.+)$/);
  const qualified = name.match(/^mcp[.:]([^.:]+)[.:](.+)$/);
  const match = native || qualified;
  if (match) return { server: match[1], name: match[2] };
  if (call?.server && name) return { server: call.server, name };
  return null;
}

// Merge only presentation rows. The original steps remain the search/export
// source, and an unknown, interrupted or failed result always ends a run.
export function mergeProcessSteps(steps) {
  const rows = [];
  for (let index = 0; index < steps.length;) {
    const first = steps[index];
    const keyOf = (step) => {
      if (step.kind !== "tool" || toolStatus(step) !== "success") return "";
      const category = toolCategory(step.call);
      if (category === "read" || category === "search") return "explore";
      const mcp = mcpTool(step.call);
      return mcp ? `mcp:${mcp.server}` : "";
    };
    const key = keyOf(first);
    let end = index + 1;
    if (key) while (end < steps.length && keyOf(steps[end]) === key) end++;
    rows.push(end - index > 1 ? {
      key: `${first.key}-group`, kind: "group", category: key === "explore" ? "explore" : "mcp",
      server: mcpTool(first.call)?.server, children: steps.slice(index, end),
    } : first);
    index = end;
  }
  return rows;
}

export function toolPath(call) {
  const args = toolArgs(call);
  return (
    args.file_path ||
    args.filePath ||
    args.path ||
    args.fileName ||
    call?.patch?.files?.[0]?.path ||
    ""
  );
}

export function shortPath(path, projectDir) {
  let normalized = String(path).replace(/^file:\/\//, "").replace(/\\/g, "/");
  const root = String(projectDir || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (root && normalized === root) return ".";
  if (root && normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  normalized = normalized.replace(/^\/(Users|home)\/[^/]+(?=\/)/, "~");
  if (normalized.startsWith("~/")) return normalized;
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : normalized;
}

export function toolTarget(call, projectDir) {
  const args = toolArgs(call);
  switch (toolCategory(call)) {
    case "command":
      return String(
        args.command || args.cmd || args.commands?.join(" && ") || "",
      ).replace(/\s+/g, " ");
    case "search":
      return [args.pattern || args.query || args.search_term, args.path ? shortPath(args.path, projectDir) : ""]
        .filter(Boolean)
        .join(" · ");
    case "read": {
      const path = shortPath(toolPath(call), projectDir);
      const offset = args.offset ?? args.start_line;
      const end =
        args.end_line ??
        (offset != null && args.limit != null
          ? Number(offset) + Number(args.limit) - 1
          : null);
      return `${path}${offset != null ? `:${offset}${end != null ? `–${end}` : ""}` : ""}`;
    }
    case "agent":
      return String(args.description || args.task_name || args.message || args.prompt || args.task || args.agent_id || args.target || args.id || "").replace(
        /\s+/g,
        " ",
      );
    case "web":
      return String(args.query || args.url || args.search_query?.map(item => item.q || item.query).join(" · ") || args.open?.map(item => item.ref_id).join(" · ") || "");
    case "mcp":
      return String(args.query || args.url || args.title || args.name || args.description || shortPath(toolPath(call), projectDir) || "").replace(/\s+/g, " ");
    default:
      return shortPath(toolPath(call), projectDir) || args.description || "";
  }
}

export function toolFacts(call) {
  const args = toolArgs(call);
  const category = toolCategory(call);
  const fields = category === "agent"
    ? ["subagent_type", "agent_type", "model", "agent_id", "target", "run_in_background"]
    : category === "mcp" ? ["url", "path", "limit", "method"]
    : category === "web" ? ["url", "allowed_domains", "blocked_domains"] : [];
  return fields.filter(key => args[key] != null).map(key => ({
    key, value: Array.isArray(args[key]) ? args[key].join(", ") : String(args[key]),
  }));
}

function replacementHunk(oldText, newText) {
  const before = String(oldText).split("\n");
  const after = String(newText).split("\n");
  if (oldText === "") before.length = 0;
  if (newText === "") after.length = 0;
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++;
  let tail = 0;
  while (
    tail < before.length - start &&
    tail < after.length - start &&
    before.at(-tail - 1) === after.at(-tail - 1)
  )
    tail++;
  const contextStart = Math.max(0, start - 3);
  const lines = before
    .slice(contextStart, start)
    .map((line) => ` ${line}`)
    .concat(
      before.slice(start, before.length - tail).map((line) => `-${line}`),
      after.slice(start, after.length - tail).map((line) => `+${line}`),
      before
        .slice(before.length - tail, before.length - tail + 3)
        .map((line) => ` ${line}`),
    );
  // Input replacements don't locate the snippet within its file; omit invented
  // file line numbers. Native result hunks supply their real offsets below.
  return ["@@", ...lines];
}

export function toolDiff(step) {
  const call = step.call;
  const args = toolArgs(call);
  const path = step.result?.filePath || toolPath(call);
  let body;
  let estimated = false;
  if (typeof step.result?.diff === "string") body = step.result.diff;
  else if (Array.isArray(step.result?.structuredPatch)) {
    body = [
      `--- ${path}`,
      `+++ ${path}`,
      ...step.result.structuredPatch.flatMap((hunk) => [
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        ...(hunk.lines || []),
      ]),
    ].join("\n");
  } else if (call?.patch?.body) body = call.patch.body;
  else if (toolCategory(call) === "edit") {
    const edits = Array.isArray(args.edits) ? args.edits : [args];
    const hunks = edits.flatMap((edit) => {
      const oldText = edit.old_string ?? edit.oldString ?? edit.old_str;
      const newText = edit.new_string ?? edit.newString ?? edit.new_str;
      if (typeof oldText === "string" && typeof newText === "string")
        return replacementHunk(oldText, newText);
      if (/write/i.test(call.name) && typeof edit.content === "string")
        return replacementHunk("", edit.content);
      return [];
    });
    if (hunks.length) {
      body = [`--- ${path}`, `+++ ${path}`, ...hunks].join("\n");
      estimated = true;
    }
  }
  if (!body) return null;
  return {
    body,
    estimated,
    rows: diffRows(body),
    files: call?.patch?.files || (path ? [{ path }] : []),
  };
}

export function diffRows(body) {
  const rows = [];
  const nativePatch = /^\*\*\* (Begin Patch|(?:Add|Update|Delete) File:)/m.test(body);
  let oldLine = null,
    newLine = null,
    addFile = false;
  let inHunk = false, oldRemaining = null, newRemaining = null;
  for (const text of body.split("\n")) {
    if (text === "*** Begin Patch") continue;
    if (text === "*** End Patch") break;
    const file = text.match(/^\*\*\* (Add|Update|Delete) File: (.*)/);
    // Inside a hunk these prefixes can be literal removed/added text.
    const header = nativePatch ? text.startsWith("*** ") : !inHunk && /^(--- |\+\+\+ |diff |index )/.test(text);
    if (header && !nativePatch) {
      oldLine = null;
      newLine = null;
    }
    if (file) {
      addFile = file[1] === "Add";
      oldLine = null;
      newLine = addFile ? 1 : null;
    }
    const hunk = text.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
    }
    if (!nativePatch && text.startsWith("@@")) {
      // Reconstructed input hunks use bare @@ and have no file offsets/counts.
      oldRemaining = hunk ? Number(hunk[2] ?? 1) : null;
      newRemaining = hunk ? Number(hunk[4] ?? 1) : null;
      inHunk = oldRemaining !== 0 || newRemaining !== 0;
    }
    const kind = header
      ? "header"
      : text.startsWith("@@")
        ? "hunk"
        : text.startsWith("+")
          ? "add"
          : !addFile && text.startsWith("-")
            ? "remove"
            : "context";
    const bodyLine = kind === "add" || kind === "remove" || text.startsWith(" ");
    rows.push({
      text,
      kind,
      old: bodyLine && (kind === "remove" || kind === "context") ? oldLine : null,
      new: bodyLine && (kind === "add" || kind === "context") ? newLine : null,
    });
    if (bodyLine && (kind === "remove" || kind === "context")) {
      if (oldLine != null) oldLine++;
      if (oldRemaining != null) oldRemaining--;
    }
    if (bodyLine && (kind === "add" || kind === "context")) {
      if (newLine != null) newLine++;
      if (newRemaining != null) newRemaining--;
    }
    if (oldRemaining === 0 && newRemaining === 0) inHunk = false;
  }
  return rows;
}

export function toolStatus(step) {
  if (step.call?.patch?.error || step.failed || step.status === "failed" || (step.exitCode != null && step.exitCode !== 0))
    return "failed";
  return step.status || step.call?.patch?.status || "pending";
}
