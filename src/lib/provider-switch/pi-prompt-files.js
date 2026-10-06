// pi native prompt resources (cc-switch's PiPromptFileService): pi reads two
// optional files next to AGENTS.md — SYSTEM.md overrides the built-in system
// prompt entirely, APPEND_SYSTEM.md appends to it. File exists = active,
// file deleted = off, so there is no enable/list semantics here and none of
// the prompts.json invariants apply. Writes are CAS-guarded by the sha256 of
// the content the editor last saw, so an external edit is never clobbered.

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeFileAtomic } = require("../fs");

const MAX_FILE_BYTES = 1024 * 1024;

const KINDS = {
  system_override: "SYSTEM.md",
  system_append: "APPEND_SYSTEM.md",
};

function fail(message) {
  const error = new Error(message);
  error.code = "PI_PROMPT_FILE";
  return error;
}

function filePathFor(kind) {
  const name = KINDS[kind];
  if (!name) throw fail(`Unknown pi prompt file kind: ${kind}`);
  return path.join(os.homedir(), ".pi", "agent", name);
}

function revisionOf(content) {
  return content === null ? null : crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

async function read(kind) {
  const filePath = filePathFor(kind);
  let content;
  try {
    content = await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { kind, path: filePath, exists: false, revision: null, content: "" };
    }
    throw error;
  }
  return {
    kind,
    path: filePath,
    exists: true,
    revision: revisionOf(content),
    content,
  };
}

// expectedRevision: the revision from a previous read (null = file absent).
// A mismatch means the file changed outside AiTool and the save is refused.
async function replace(kind, content, expectedRevision) {
  if (typeof content !== "string" || !content.trim()) {
    throw fail("Content must be a non-empty string (delete the file to deactivate it)");
  }
  const contentBytes = Buffer.byteLength(content, "utf8");
  if (contentBytes > MAX_FILE_BYTES) {
    throw fail(`File exceeds the ${Math.floor(MAX_FILE_BYTES / 1024)} KiB limit`);
  }
  const filePath = filePathFor(kind);
  const current = await read(kind);
  if (current.revision !== expectedRevision) {
    throw fail("File changed outside AiTool — reload and try again");
  }
  await writeFileAtomic(filePath, content);
  return { kind, path: filePath, exists: true, revision: revisionOf(content), content };
}

async function remove(kind, expectedRevision) {
  const filePath = filePathFor(kind);
  const current = await read(kind);
  if (!current.exists) {
    throw fail("File does not exist");
  }
  if (current.revision !== expectedRevision) {
    throw fail("File changed outside AiTool — reload and try again");
  }
  await fsp.rm(filePath);
  return { kind, path: filePath, exists: false, revision: null, content: "" };
}

module.exports = { KINDS, read, replace, remove };
