"use strict";
const path = require("node:path");
const os = require("node:os");
function agentDir(env = process.env) {
  const home = env.HOME || os.homedir();
  const raw = env.OMP_PROFILE ?? env.PI_PROFILE ?? "";
  const profile = raw.trim();
  if (profile && profile !== "default") {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile)) throw new Error("Invalid OMP profile name");
    const root = env.OMP_HOME || path.join(home, env.PI_CONFIG_DIR || ".omp");
    return path.join(root, "profiles", profile, "agent");
  }
  return require("../rollout").resolveOmpAgentDir(env);
}
module.exports = { agentDir };
