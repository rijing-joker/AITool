"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createManager, encode, decode } = require("../src/lib/provider-switch/agy-accounts");
const { createRecovery } = require("../src/lib/proxy/recovery");
const keys = require("../src/lib/provider-api-key-store");
const credential = id => ({ id_token: `header.${Buffer.from(JSON.stringify({ sub: id, email: `${id}@example.test` })).toString("base64url")}.signature`, token: { access_token: `private-${id}`, refresh_token: `refresh-${id}`, expiry: "2030-01-01T00:00:00Z" } });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-upstream-accounts-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let raw = encode(credential("a")); let writes = 0;
  const login = { read: async () => raw, write: async value => { raw = value; writes++; } };
  return { root, login, set: value => { raw = value; }, raw: () => raw, writes: () => writes };
}
test("account switching preserves the live login, summaries hide credentials, removal never signs out", async t => {
  const x = await fixture(t); const manager = createManager({ ...x, supported: true });
  const status = await manager.status(); assert.equal(status.currentAccountId,"a");
  assert.equal(JSON.stringify(status).includes("private-"),false);
  x.set(encode(credential("b"))); await manager.status();
  await manager.switchAccount("a");
  assert.equal(decode(x.raw()).token.access_token,"private-a");
  assert.equal((await manager.status()).accounts.length,2);
  assert.equal((await fs.stat(path.join(x.root,"agy-accounts.json"))).mode & 0o777,0o600);
  await manager.remove("a"); assert.equal(x.writes(),1);
  assert.deepEqual((await manager.status()).accounts.map(row => row.id),["b"]);
  await manager.switchAccount("b");
  assert.deepEqual((await manager.status()).accounts.map(row => row.id), ["b"]);
});
test("undecodable keychain values stop switching without writing a plaintext stash", async t => {
  const x = await fixture(t), manager = createManager({ ...x, supported: true });
  await manager.status(); x.set("unknown-format-private-token");
  await assert.rejects(manager.switchAccount("a"), /Cannot decode/);
  assert.equal(x.raw(), "unknown-format-private-token"); assert.equal(x.writes(), 0);
  await assert.rejects(fs.stat(path.join(x.root, "agy-login-stash.json")), { code: "ENOENT" });
});
test("quota refresh is per saved account and revocation survives status reads", async t => {
  const x = await fixture(t); const calls = [];
  const manager = createManager({ ...x, supported: true, now: () => Date.parse("2031-01-01T00:00:00Z"), fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ error:"invalid_grant", private:"not returned" }), { status:400 }); } });
  await manager.status();
  await assert.rejects(manager.quota("a"),/expired/);
  assert.equal(x.writes(),0);
  assert.equal((await manager.status()).accounts[0].requiresReauth,true);
  await assert.rejects(manager.switchAccount("a"),/expired/);
  assert.match(String(calls[0].options.body),/refresh_token=refresh-a/);
});
test("quota response is sanitized and never rewrites global login", async t => {
  const x = await fixture(t);
  const manager = createManager({ ...x, supported:true, fetchImpl:async () => new Response(JSON.stringify({ access_token:"secret", groups:[{displayName:"Plan",buckets:[{bucketId:"5h",remainingFraction:1.5,private:"secret"}]}] })) });
  await manager.status(); const quota = await manager.quota("a");
  assert.equal(quota.groups[0].buckets[0].remainingFraction,1);
  assert.equal(JSON.stringify(quota).includes("secret"),false); assert.equal(x.writes(),0);
});
test("OAuth rejects wrong state and uses PKCE before storing a renewable identity", async t => {
  const x = await fixture(t); let exchange;
  const manager = createManager({ ...x,supported:true,fetchImpl:async (_url,options) => { exchange = options.body; return new Response(JSON.stringify({ access_token:"oauth-private", refresh_token:"oauth-refresh",id_token:credential("oauth").id_token })); } });
  t.after(() => manager.cancel());
  const flow = await manager.startLogin(); const auth = new URL(flow.authUrl); const callback = new URL(auth.searchParams.get("redirect_uri"));
  assert.equal(auth.searchParams.get("code_challenge_method"),"S256");
  callback.searchParams.set("code","code"); callback.searchParams.set("state","wrong");
  assert.equal((await fetch(callback)).status,400); assert.equal(exchange,undefined);
  callback.searchParams.set("state",flow.flowId); assert.equal((await fetch(callback)).status,200);
  assert.ok(exchange.get("code_verifier")); assert.equal(manager.pollLogin(flow.flowId).status,"success");
  assert.equal(x.writes(),0); assert.ok((await manager.status()).accounts.some(row => row.id === "oauth"));
});
test("account storage refuses symlink files without reading outside credentials", async t => {
  const x = await fixture(t); const outside=path.join(x.root,"outside.json"); await fs.writeFile(outside,"{}"); await fs.symlink(outside,path.join(x.root,"agy-accounts.json"));
  await assert.rejects(createManager({...x,supported:true}).status(),/store/);
  assert.equal(await fs.readFile(outside,"utf8"),"{}");
});
test("local quota keys validate opaque values and tighten existing permissions", async t => {
  const x = await fixture(t); const args={home:x.root,provider:"command-code",apiKey:"  fixture-private-key  "};
  const file=await keys.writeStoredApiKey(args); await fs.chmod(file,0o644); await keys.writeStoredApiKey(args);
  assert.equal(keys.readStoredApiKey(args),"fixture-private-key"); assert.equal((await fs.stat(file)).mode & 0o777,0o600);
  await assert.rejects(keys.writeStoredApiKey({...args,apiKey:"bad\nheader"}),/Invalid/);
  assert.equal(keys.readStoredApiKey({...args,provider:"__proto__"}),"");
});
test("recovery requires two probes, retains crash budget after success, and cancels manual stop", async () => {
  let at=0, healthy=false, calls=0; const timers=[];
  const recovery=createRecovery({check:async()=>healthy,recover:async valid=>{if(valid())calls++;},now:()=>at,schedule:(fn,delay)=>{const timer={fn,delay};timers.push(timer);return timer;},cancel:timer=>{if(timer)timer.cancelled=true;}});
  recovery.arm(); await recovery.tick(); assert.equal(timers.length,0); await recovery.tick(); assert.equal(timers[0].delay,2000);
  at+=2000; await timers[0].fn(); healthy=true; await recovery.tick(); healthy=false;
  for(const delay of [5000,15000]) {await recovery.tick();await recovery.tick();const timer=timers.at(-1);assert.equal(timer.delay,delay);at+=delay;await timer.fn();}
  await recovery.tick();await recovery.tick();assert.equal(recovery.snapshot().state,"exhausted");assert.equal(calls,3);
  at+=300001;await recovery.tick();const timer=timers.at(-1);assert.equal(timer.delay,2000);recovery.disarm();await timer.fn();assert.equal(calls,3);assert.equal(recovery.snapshot().armed,false);
});
test("a stale asynchronous probe cannot schedule recovery after disarm",async()=>{
  let finish;const timers=[];const recovery=createRecovery({check:()=>new Promise(resolve=>{finish=resolve;}),recover:async()=>{},schedule:fn=>{timers.push(fn);return {};}});
  recovery.arm();const probing=recovery.tick();recovery.disarm();finish(false);await probing;assert.equal(timers.length,0);
});
