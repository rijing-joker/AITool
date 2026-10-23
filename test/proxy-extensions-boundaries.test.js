"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const direct = require("../src/lib/proxy/extensions/http");
const api = require("../src/lib/proxy/api");
const { Readable } = require("node:stream");
test("concurrent runtime starts share one listener and recover interrupted port publication", async t => {
  const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-extension-lifecycle-")), options = { root };
  const runtime = require("../src/lib/proxy/extensions/runtime"), state = require("../src/lib/proxy/managed-upstream");
  t.after(async () => { await runtime.stop(options); await fs.rm(root, { recursive: true, force: true }); });
  const ports = await Promise.all([runtime.start(options), runtime.start(options)]);
  assert.equal(ports[0], ports[1]); assert.ok(ports[0] > 0);
  await state.saveSettings(value => ({ ...value, port: 0 }), options);
  assert.equal(await runtime.start(options), ports[0]);
  await runtime.stop(options); assert.equal(await runtime.control("/health", options), null);
  assert.equal(await runtime.start(options), ports[0]);
});
test("direct HTTP refuses redirects without sending credentials to the target and aborts live requests", async t => {
  let targetCalls = 0, disconnected = false;
  const target = http.createServer((req,res) => { targetCalls++; res.end("unexpected"); });
  target.listen(0,"127.0.0.1"); await once(target,"listening");
  const source = http.createServer((req,res) => {
    if (req.url === "/redirect") { res.writeHead(302,{location:`http://127.0.0.1:${target.address().port}`}); res.end(); }
    else { req.on("close",()=>{disconnected=true;}); }
  });
  source.listen(0,"127.0.0.1"); await once(source,"listening");
  t.after(()=>{source.close();source.closeAllConnections();target.close();target.closeAllConnections();});
  const url=`http://127.0.0.1:${source.address().port}`;
  await assert.rejects(direct.request(url+"/redirect",{headers:{authorization:"Bearer fixture-key"}}),/redirect/);
  assert.equal(targetCalls,0);
  const controller=new AbortController(); const pending=direct.request(url+"/slow",{signal:controller.signal});
  await new Promise(r=>setTimeout(r,25));controller.abort();await assert.rejects(pending,/abort/i);
  for(let i=0;i<30&&!disconnected;i++)await new Promise(r=>setTimeout(r,5));assert.equal(disconnected,true);
});
test("all optional integration mutations reject unauthorized requests before reading bodies or touching services", async () => {
  for(const pathname of ["/api/proxy/integrations","/api/proxy/routing","/api/proxy/tools","/api/proxy/desktop-clients/models","/api/proxy/desktop-clients/connect","/api/proxy/desktop-clients/restore"]){
    const req=new Readable({read(){throw new Error("Unauthorized body must not be read");}});req.method="POST";
    let status,body;const res={writeHead(code){status=code;},end(value){body=JSON.parse(value);}};
    assert.equal(await api.handleProxyApiRequest(req,res,new URL('http://localhost'+pathname),{isAuthorizedLocalMutation:()=>false}),true);
    assert.equal(status,401);assert.equal(body.error,"Unauthorized");req.destroy();
  }
});
