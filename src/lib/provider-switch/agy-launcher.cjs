"use strict";
const net = require("node:net");
const { spawn } = require("node:child_process");
const socket = net.connect(process.argv[2]);
let data = "";
socket.setEncoding("utf8");
socket.setTimeout(10000, () => socket.destroy());
socket.on("data", chunk => { data += chunk; if (data.length > 1024 * 1024) socket.destroy(); });
socket.on("error", () => { process.stderr.write("Antigravity launch expired. Launch again from AiTool.\n"); process.exitCode = 1; });
socket.on("end", () => {
  try {
    const { binary, args, env } = JSON.parse(data); data = "";
    const child = spawn(binary, args, { env, stdio: "inherit" });
    child.on("error", () => { process.exitCode = 1; });
    child.on("exit", code => { process.exitCode = code || 0; });
  } catch { process.exitCode = 1; }
});
