const config = require("../lib/proxy/config");
const manager = require("../lib/proxy/manager");
const bridge = require("../lib/proxy/usage-bridge");

// `aitool proxy` — manage the embedded AI proxy (CLIProxyAPI core).
//   install   fetch the pinned core binary
//   start     start core + usage bridge
//   stop      stop both
//   status    machine + human readable status
//   repair-usage  remove historical control notifications and correct totals
//   config    print effective proxy paths

async function cmdProxy(argv = []) {
  const sub = String(argv[0] || "status").toLowerCase();

  if (sub === "repair-usage") {
    process.stdout.write(`${JSON.stringify(bridge.repairUsageHistory())}\n`);
    return;
  }

  if (sub === "install") {
    // `aitool proxy install [--local <CLIProxyAPI checkout>]` — the local
    // build carries fork fixes that upstream releases may not have yet.
    const localFlagIndex = argv.indexOf("--local");
    if (localFlagIndex !== -1) {
      const repoPath = argv[localFlagIndex + 1] && !argv[localFlagIndex + 1].startsWith("--")
        ? argv[localFlagIndex + 1]
        : process.env.AITOOL_CORE_REPO;
      if (!repoPath) {
        throw new Error("--local requires a path to a CLIProxyAPI checkout (or set AITOOL_CORE_REPO)");
      }
      const result = await manager.installFromRepo(repoPath);
      process.stdout.write(`Core installed: ${result.path} (${result.source})\n`);
      return;
    }
    const result = await manager.installCore();
    process.stdout.write(`Core installed: ${result.path} (${result.source})\n`);
    return;
  }

  if (sub === "start") {
    const result = await manager.start();
    if (result.alreadyRunning) {
      process.stdout.write("Proxy core already running.\n");
    } else {
      process.stdout.write(`Proxy core started (pid ${result.pid}).\n`);
    }
    bridge.startBridge();
    const status = await manager.status();
    process.stdout.write(`  endpoint: http://${status.host}:${status.port}\n`);
    process.stdout.write("  usage events are merged into the dashboard automatically.\n");
    return;
  }

  if (sub === "stop") {
    bridge.stopBridge();
    const result = await manager.stop();
    process.stdout.write(result.stopped ? "Proxy core stopped.\n" : "Proxy core was not running.\n");
    return;
  }

  if (sub === "config") {
    config.ensureConfig();
    const status = await manager.status();
    process.stdout.write(`config:    ${require("../lib/proxy/paths").configPath}\n`);
    process.stdout.write(`auth dir:  ${status.authDir}\n`);
    process.stdout.write(`endpoint:  http://${status.host}:${status.port} (host ${status.host})\n`);
    process.stdout.write(`binary:    ${status.binary || "not installed — run: aitool proxy install"}\n`);
    return;
  }

  // status (default)
  const status = await manager.status();
  process.stdout.write("AiTool proxy\n");
  process.stdout.write(`  core:       ${status.installed ? `installed (${status.version || "unknown version"})` : "not installed (run: aitool proxy install)"}\n`);
  process.stdout.write(`  running:    ${status.running ? `yes (pid ${status.pid})` : "no"}\n`);
  process.stdout.write(`  endpoint:   http://${status.host}:${status.port}\n`);
  process.stdout.write(`  management: ${status.managementReachable ? "reachable" : status.managementAuthError ? "auth rejected" : "unreachable"}\n`);
  const bridgeStatus = bridge.bridgeStatus();
  process.stdout.write(`  usage bridge: ${bridgeStatus.running ? "streaming" : bridgeStatus.connecting ? "connecting" : "idle"}${bridgeStatus.lastEventAt ? ` (last event ${bridgeStatus.lastEventAt})` : ""}\n`);
}

module.exports = { cmdProxy };
