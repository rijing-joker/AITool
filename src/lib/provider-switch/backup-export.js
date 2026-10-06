// Encrypted backup of the provider-switch SSOT stores (cc-switch's backup
// import/export, tightened): providers.json + mcp-servers.json + prompts.json
// in one passphrase-encrypted blob (scrypt KDF, AES-256-GCM). The passphrase
// never touches disk; without it the blob is opaque, so it can safely live in
// a dotfile repo or a sync folder. The codex auth stash (OAuth tokens) is
// deliberately excluded.

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const paths = require("./paths");
const { updateJsonLocked } = require("../fs");

const FORMAT = "aitool-provider-backup";
const VERSION = 1;
const KDF_PARAMS = { N: 16384, r: 8, p: 1 };
const STORE_FILES = ["providers.json", "mcp-servers.json", "prompts.json"];

function fail(message) {
  const error = new Error(message);
  error.code = "BACKUP";
  return error;
}

function deriveKey(passphrase, salt) {
  if (typeof passphrase !== "string" || passphrase.length < 8) {
    throw fail("Passphrase must be at least 8 characters");
  }
  return crypto.scryptSync(passphrase, salt, 32, KDF_PARAMS);
}

function b64(buffer) {
  return Buffer.from(buffer).toString("base64");
}

async function exportEncrypted(passphrase, now = new Date().toISOString()) {
  const stores = {};
  for (const name of STORE_FILES) {
    try {
      stores[name] = await fsp.readFile(path.join(paths.providerSwitchRoot(), name), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // Absent stores (e.g. MCP never used) are simply not in the blob.
    }
  }
  if (Object.keys(stores).length === 0) {
    throw fail("Nothing to back up yet");
  }
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify({ version: VERSION, createdAt: now, stores });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const payload = {
    format: FORMAT,
    version: VERSION,
    createdAt: now,
    kdf: { salt: b64(salt), ...KDF_PARAMS },
    iv: b64(iv),
    tag: b64(cipher.getAuthTag()),
    ciphertext: b64(ciphertext),
  };
  // Keep the blob importable through the same API: local-api's JSON body cap
  // is 2 MiB and base64 inflates by 4/3.
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 1_400_000) {
    throw fail("Backup exceeds the import size limit (stores too large)");
  }
  return payload;
}

async function importEncrypted(passphrase, payload) {
  if (!payload || typeof payload !== "object" || payload.format !== FORMAT) {
    throw fail("Not an AiTool provider backup file");
  }
  if (payload.version !== VERSION) {
    throw fail(`Unsupported backup version: ${payload.version}`);
  }
  let salt;
  let iv;
  let tag;
  let ciphertext;
  try {
    salt = Buffer.from(payload.kdf.salt, "base64");
    iv = Buffer.from(payload.iv, "base64");
    tag = Buffer.from(payload.tag, "base64");
    ciphertext = Buffer.from(payload.ciphertext, "base64");
  } catch {
    throw fail("Corrupted backup payload");
  }
  const key = deriveKey(passphrase, salt);
  let plaintext;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw fail("Wrong passphrase or corrupted backup");
  }
  let parsed;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw fail("Corrupted backup payload");
  }
  const stores = parsed && typeof parsed === "object" ? parsed.stores : null;
  if (!stores || typeof stores !== "object" || !stores["providers.json"]) {
    throw fail("Backup has no providers store");
  }
  // Keep whatever the current files are before overwriting them.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const preImportDir = path.join(paths.backupsDir("import"), stamp);
  const restored = [];
  for (const name of STORE_FILES) {
    const content = stores[name];
    if (typeof content !== "string" || !content.trim()) continue;
    JSON.parse(content); // refuse to write a store we cannot parse
    const target = path.join(paths.providerSwitchRoot(), name);
    try {
      const current = await fsp.readFile(target, "utf8");
      await fsp.mkdir(path.join(preImportDir), { recursive: true });
      await fsp.writeFile(path.join(preImportDir, name), current, { mode: 0o600 });
    } catch {}
    // Same file lock the stores themselves use, so a concurrent provider
    // switch / failover write cannot interleave with the restore.
    await updateJsonLocked(target, () => JSON.parse(content));
    restored.push(name);
  }
  if (restored.length === 0) throw fail("Backup has no readable stores");
  return { restored, preImportDir: restored.length > 0 ? preImportDir : null };
}

module.exports = { exportEncrypted, importEncrypted, FORMAT, STORE_FILES };
