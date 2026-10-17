// Detached entry point: it must outlive `aitool proxy start` and the dashboard.
const state = require("./state");
const { createAdapter } = require("./server");
const { createCatalog } = require("./catalog");
const settings = state.settings();
const catalog = createCatalog();
const server = createAdapter({ token: settings.token, catalog, selectedModels: () => {
  const current = state.settings();
  return current.enabled === true ? current.models : [];
} });
server.on("error", () => process.exit(1));
server.listen(settings.port, "127.0.0.1", () => {
  const port = server.address().port;
  state.write(state.runtimePath, { pid: process.pid, port });
  void catalog.refresh();
});
server.on("close", () => {
  const runtime = state.read(state.runtimePath, null);
  if (runtime?.pid === process.pid) require("node:fs").rmSync(state.runtimePath, { force: true });
  process.exit(0);
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { server.close(); server.closeAllConnections(); });
