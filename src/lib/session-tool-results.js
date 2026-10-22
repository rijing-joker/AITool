// Light, source-preserving normalization for the read-only session reader.
function statusOf(value) {
  switch (String(value || "").toLowerCase()) {
    case "success":
    case "completed":
      return "success";
    case "error":
    case "failed":
      return "failed";
    case "cancelled":
    case "canceled":
    case "interrupted":
      return "interrupted";
    case "executing":
    case "scheduled":
    case "validating":
    case "awaiting_approval":
    case "pending":
      return "pending";
    default:
      return undefined;
  }
}

function outputText(value) {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function normalizeShellOutput(raw) {
  let envelope = raw;
  if (typeof raw === "string") {
    try {
      envelope = JSON.parse(raw);
    } catch {
      /* Native plain-text result. */
    }
  }
  const structured =
    envelope && typeof envelope === "object" && !Array.isArray(envelope);
  let output =
    structured && "output" in envelope
      ? outputText(envelope.output)
      : outputText(raw);
  const metadata = structured ? envelope.metadata : null;
  const exit = output.match(
    /(?:^|\n)(?:Exit code:|Process exited with code)\s*(-?\d+)(?:\s|$)/i,
  );
  const exitCode = Number.isInteger(metadata?.exit_code)
    ? metadata.exit_code
    : exit
      ? Number(exit[1])
      : undefined;
  const time = output.match(
    /(?:^|\n)Wall time:\s*([\d.]+)\s*seconds?\s*(?:\n|$)/i,
  );
  const seconds =
    typeof metadata?.duration_seconds === "number"
      ? metadata.duration_seconds
      : time
        ? Number(time[1])
        : undefined;
  // Only remove a native header when its explicit execution metadata exists.
  if (exit || time) {
    const body = output.match(/(?:^|\n)Output:\r?\n([\s\S]*)$/);
    if (body) output = body[1];
  }
  const status =
    exitCode !== undefined
      ? exitCode === 0
        ? "success"
        : "failed"
      : statusOf(envelope?.status);
  return {
    output,
    ...(status ? { status } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(Number.isFinite(seconds) && seconds >= 0
      ? { durationMs: seconds * 1000 }
      : {}),
  };
}

function geminiToolResult(call, id) {
  const status = statusOf(call.status);
  const display = call.resultDisplay;
  let output = typeof display === "string" ? display : "";
  const diff =
    typeof display?.fileDiff === "string" ? display.fileDiff : undefined;
  if (!output.trim() && diff) output = diff;
  if (!output.trim() && display && !diff) output = outputText(display);
  if (!output.trim() && call.result != null) {
    output = Array.isArray(call.result)
      ? call.result
          .map((item) => {
            const response = item?.functionResponse?.response;
            return outputText(
              response?.output ?? response?.error ?? response ?? item,
            );
          })
          .join("\n")
      : outputText(call.result);
  }
  if (!status && !output && !diff) return null;
  return {
    callId: id,
    output,
    ...(status ? { status } : {}),
    ...(diff
      ? {
          diff,
          filePath:
            display.filePath ||
            display.fileName ||
            call.args?.file_path ||
            call.args?.path ||
            "",
        }
      : {}),
  };
}

module.exports = { statusOf, normalizeShellOutput, geminiToolResult };
