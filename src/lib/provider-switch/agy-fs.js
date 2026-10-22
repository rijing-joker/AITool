"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");

// Private profiles and credentials must never follow redirected directories.
async function privateDirectory(directory, root) {
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid Antigravity private path");
  for (const file of [path.dirname(root), root, ...relative.split(path.sep).filter(Boolean).map((_, i, parts) => path.join(root, ...parts.slice(0, i + 1)))]) {
    try { await fs.mkdir(file, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = await fs.lstat(file);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Antigravity private directory is redirected");
  }
  await fs.chmod(directory, 0o700);
}
async function privateFile(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error("Invalid Antigravity private file");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
module.exports = { privateDirectory, privateFile };
