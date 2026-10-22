"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const agy = require("../src/lib/provider-switch/agy");

test("private Antigravity launch preserves user settings and passes keys through the Unix broker", async t => {
  if (process.platform === "win32") return t.skip("Unix socket integration");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-agy-launch-"));
  t.after(() => fs.rm(home, {recursive:true,force:true}));
  t.mock.method(os,"homedir",()=>home);
  const row = {id:"relay",settingsConfig:{env:{GEMINI_API_KEY:"fixture-private-key",GOOGLE_GEMINI_BASE_URL:"https://relay.test"},config:{model:{name:"Gemini 3.8 Flash"}}}};
  const profile = path.join(home,".aitool/provider-switch/agy",crypto.createHash("sha256").update(row.id).digest("hex").slice(0,32));
  const file = path.join(profile,"antigravity-cli/settings.json");
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,JSON.stringify({modelProvider:"old",model:"old",theme:"user",custom:{keep:true}}));
  const output = path.join(home,"stub-output.json");
  const binary = path.join(home,"agy");
  await fs.writeFile(binary,`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({key:process.env.GEMINI_API_KEY,endpoint:process.env.GOOGLE_GEMINI_BASE_URL,args:process.argv.slice(2)}));\n`,{mode:0o700});
  const launched=[];
  await agy.launch(row,{resolve:async name=>name==="agy"?binary:name==="x-terminal-emulator"?"/usr/bin/xterm":null,platform:"linux",spawnImpl:(terminal,args,options)=>{
    launched.push({terminal,args});return spawn(args[1],args.slice(2),options);
  }});
  let received;
  for(let i=0;i<100;i++) {try {received=JSON.parse(await fs.readFile(output,"utf8"));break;}catch {await delay(10);}}
  assert.ok(received,"broker child ran");assert.equal(received.key,"fixture-private-key");assert.equal(received.endpoint,"https://relay.test");
  assert.deepEqual(received.args,[`--gemini_dir=${profile}`]);assert.equal(JSON.stringify(launched).includes("fixture-private-key"),false);
  const saved=JSON.parse(await fs.readFile(file,"utf8"));assert.deepEqual(saved,{modelProvider:"gemini",model:"Gemini 3.8 Flash",theme:"user",custom:{keep:true}});
  assert.equal((await fs.stat(file)).mode & 0o777,0o600);
  assert.equal(await fs.realpath(path.join(profile,"config")),path.join(home,".gemini/config"));
  const backups=await fs.readdir(path.join(home,".aitool/provider-switch/backups/agy"));assert.equal(backups.length,1);
  assert.equal(JSON.stringify(saved).includes("fixture-private-key"),false);
});
test("Antigravity model aliases map to native display IDs and unknown output fails",async()=>{
  const args={resolve:async()=>"/fixture/agy",runner:async()=>({status:0,stdout:"Alias  Model\nflash  Gemini 3.8 Flash\n│ opus │ Claude Opus 4.6 │"})};
  assert.deepEqual((await agy.models(args)).models,[{id:"Gemini 3.8 Flash",name:"Gemini 3.8 Flash",alias:"flash"},{id:"Claude Opus 4.6",name:"Claude Opus 4.6",alias:"opus"}]);
  await assert.rejects(agy.models({...args,runner:async()=>({status:0,stdout:"unrecognized"})}),/Unrecognized/);
});
