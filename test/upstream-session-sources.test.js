"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const sessions = require("../src/lib/sessions");
const sessionSources = require("../src/lib/session-sources");
async function fixture(t) {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"aitool-session-formats-"));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  return {home,write:async(relative,rows)=>{const file=path.join(home,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,rows.map(JSON.stringify).join("\n"));return file;}};
}
async function db(home,relative,sql) { const SQL=await require("sql.js")();const database=new SQL.Database();database.run(sql);const file=path.join(home,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,database.export());database.close();return file; }
test("Antigravity latest steps retain complete final JSON, fresh input and historically selected model",async t=>{
  const x=await fixture(t);const file=await x.write('.gemini/antigravity-cli/brain/id/.system_generated/logs/transcript_full.jsonl',[
    {step_index:0,type:"USER_INPUT",content:"<USER_REQUEST>Fix tests</USER_REQUEST><USER_SETTINGS_CHANGE>changed setting `Model Selection` from X to Gemini 3.8 Flash (High).</USER_SETTINGS_CHANGE>",created_at:"2026-10-21T01:00:00Z"},
    {step_index:1,type:"PLANNER_RESPONSE",status:"RUNNING",content:"draft",input_tokens:999},
    {step_index:1,type:"PLANNER_RESPONSE",status:"DONE",content:"done",input_tokens:80,cache_read_tokens:20,output_tokens:12},
  ]);
  const result=await sessions.readSession({app:"agy",sourcePath:file,home:x.home});assert.deepEqual(result.messages.map(row=>row.content),["Fix tests","done"]);assert.equal(result.usage.totalTokens,112);assert.equal(result.usage.model,"gemini-3.8-flash-high");
  assert.equal((await sessions.listSessions({app:"agy",home:x.home}))[0].sessionId,"id");
});
test("Antigravity binary index sessions can resume without invented transcripts",async t=>{
  const x=await fixture(t);await db(x.home,'.gemini/antigravity-cli/conversation_summaries.db',"CREATE TABLE conversation_summaries(conversation_id,title,workspace_uris,preview,last_modified_time);INSERT INTO conversation_summaries VALUES('binary','Only binary','[\"file:///tmp/project\"]','Preview','2026-10-21T01:00:00Z');");
  const [row]=await sessions.listSessions({app:"agy",home:x.home});assert.equal(row.sourcePath,null);assert.equal(row.resumeCommand,"agy --conversation=binary");assert.equal(row.projectDir,"/tmp/project");
});
test("Antigravity discovers native Windows and POSIX transcript paths", () => {
  for (const paths of [path.win32, path.posix]) {
    const root = paths === path.win32 ? "C:\\Users\\fixture" : "/home/fixture";
    const file = paths.join(root, ".gemini", "antigravity-cli", "brain", "id", ".system_generated", "logs", "transcript_full.jsonl");
    assert.equal(sessionSources.isAgyTranscript(file), true);
    assert.equal(sessionSources.isAgyTranscript(file + ".bak"), false);
    assert.equal(sessionSources.isAgyTranscript(paths.join(root, "logs", "transcript_full.jsonl")), false);
  }
});
test("Antigravity preserves execution failures and unfamiliar steps in full and lazy reads", async t => {
  const x = await fixture(t);
  const unknown = { step_index: 2, type: "UNKNOWN_STEP", details: { error: "unfamiliar failure " + "x".repeat(5000) } };
  const file = await x.write(".gemini/antigravity-cli/brain/events/.system_generated/logs/transcript_full.jsonl", [
    { step_index: 0, type: "USER_INPUT", content: "Read file" },
    { step_index: 1, type: "TOOL_RESPONSE", content: "Read failed: permission denied" },
    unknown,
    { step_index: 3, type: "PLANNER_RESPONSE", status: "DONE", content: "Could not read file" },
  ]);
  const options = { app: "agy", sourcePath: file, home: x.home };
  const result = await sessions.readSession(options);
  assert.equal(result.messages.length, 4);
  assert.equal(result.messages[1].content, "Read failed: permission denied");
  assert.deepEqual(JSON.parse(result.messages[2].content), unknown);
  assert.equal(result.messages.some(row => row.injected), false);
  const preview = await sessions.readSession({ ...options, preview: true });
  assert.equal(preview.messages[2].content.length, 1200);
  const full = await sessions.readSessionContent({ ...options, revision: preview.revision, ref: preview.messages[2].contentRef.id });
  assert.equal(full.content, result.messages[2].content);
});
for (const [app, root, relative, rows] of [
  ["pi", ".pi/agent/sessions", "pi.jsonl", [{ type: "session", version: 3, id: "pi" },
    { type: "message", id: "q", parentId: null, message: { role: "user", content: "Relocated question" } }]],
  ["agy", ".gemini/antigravity-cli", "brain/agy/.system_generated/logs/transcript_full.jsonl", [
    { step_index: 0, type: "USER_INPUT", content: "Relocated question" }]],
  ["grokbuild", ".grok/sessions", "g/chat_history.jsonl", [{ role: "user", content: "Relocated question" }]],
  ["hermes", ".hermes", "sessions/h.jsonl", [{ role: "user", content: "Relocated question" }]],
]) {
  test(`${app} lists relocated session roots and still rejects escaped files`, async t => {
    const x = await fixture(t);
    const file = await x.write(path.join(root, relative), rows);
    const configured = path.join(x.home, root);
    const moved = path.join(x.home, "relocated");
    await fs.rename(configured, moved);
    await fs.symlink(moved, configured, "junction");
    const [listed] = await sessions.listSessions({ app, home: x.home, env: {} });
    assert.ok(listed);
    assert.equal(listed.sourcePath, file);
    const options = { app, sourcePath: listed.sourcePath, home: x.home, env: {} };
    assert.equal((await sessions.readSession(options)).messages[0].content, "Relocated question");
    const outside = await x.write("outside.jsonl", rows);
    await fs.unlink(file);
    await fs.symlink(outside, file, "file");
    assert.deepEqual(await sessions.listSessions({ app, home: x.home, env: {} }), []);
    await assert.rejects(sessions.readSession(options), /outside|root|symlink/i);
  });
}
test("Pi follows the latest branch and preserves paired tool failures",async t=>{
  const x=await fixture(t);const file=await x.write('.pi/agent/sessions/a.jsonl',[
    {type:"session",version:3,id:"pi",cwd:"/project"},
    {type:"message",id:"q",parentId:null,message:{role:"user",content:"question"}},
    {type:"message",id:"old",parentId:"q",message:{role:"assistant",content:"discarded branch"}},
    {type:"message",id:"new",parentId:"q",message:{role:"assistant",content:[{type:"toolCall",id:"c",name:"read",arguments:{path:"a"}}]}},
    {type:"message",id:"result",parentId:"new",message:{role:"toolResult",toolCallId:"c",content:[{type:"text",text:"denied"}],isError:true,timestamp:200}},
  ]);const result=await sessions.readSession({app:"pi",sourcePath:file,home:x.home});assert.equal(result.messages.length,3);assert.equal(result.messages[1].toolCalls[0].id,"c");assert.equal(result.messages[2].toolResults[0].isError,true);assert.equal(result.messages[2].ts,200);
});
test("Hermes SQLite uses seconds, hides model-only rows and deduplicates protected copies",async t=>{
  const x=await fixture(t);await db(x.home,'.hermes/state.db',`CREATE TABLE sessions(id,title,started_at);INSERT INTO sessions VALUES('h','Hermes',100);CREATE TABLE messages(id,session_id,role,content,timestamp,active,display_metadata);INSERT INTO messages VALUES(1,'h','user','question',100,0,NULL),(2,'h','user','question',100,1,NULL),(3,'h','assistant','hidden',101,1,'{"model_only":true}'),(4,'h','assistant','answer',102,1,NULL);`);
  const [row]=await sessions.listSessions({app:"hermes",home:x.home});assert.equal(row.createdAt,100000);const result=await sessions.readSession({app:"hermes",sourcePath:row.sourcePath,home:x.home});assert.deepEqual(result.messages.map(row=>row.content),["question","answer"]);assert.equal(result.messages[1].ts,102000);
});
test("Hermes tool output without a completion flag keeps its status unknown", async t => {
  const x = await fixture(t);
  await db(x.home, ".hermes/state.db", `
    CREATE TABLE sessions(id,title); INSERT INTO sessions VALUES('h','Hermes');
    CREATE TABLE messages(id,session_id,role,content,timestamp,tool_calls,tool_call_id);
    INSERT INTO messages VALUES(1,'h','user','Read file',100,NULL,NULL),
      (2,'h','assistant',NULL,101,'[{"id":"c","function":{"name":"read","arguments":"{}"}}]',NULL),
      (3,'h','tool','Permission denied',102,NULL,'c');
  `);
  const [listed] = await sessions.listSessions({ app: "hermes", home: x.home });
  const result = await sessions.readSession({ app: "hermes", sourcePath: listed.sourcePath, home: x.home });
  assert.equal(result.messages[1].toolCalls[0].id, "c");
  assert.equal(result.messages[2].toolResults[0].callId, "c");
  assert.equal(result.messages[2].toolResults[0].output, "Permission denied");
  assert.equal(result.messages[2].toolResults[0].status, undefined);
  for (const app of ["hermes", "grokbuild"]) {
    const [unknown, failed, completed] = sessionSources.fold(app, [
      { role: "tool", content: "Permission denied" },
      { role: "tool", content: "Error", is_error: true },
      { role: "tool", content: "Done", status: "completed" },
    ]).messages;
    assert.equal(unknown.toolResults[0].status, undefined);
    assert.equal(failed.toolResults[0].status, "failed");
    assert.equal(completed.toolResults[0].status, "success");
  }
});
test("MiniMax reads only public display rows and treats explicit millisecond timestamps as milliseconds",async t=>{
  const x=await fixture(t);await db(x.home,'.minimax/v2/sqlite/runtime-state.sqlite',`CREATE TABLE local_runtime_sessions(session_id,title,workspace_dir,created_at_ms,updated_at_ms,visibility,archived,parent_session_id,session_kind);INSERT INTO local_runtime_sessions VALUES('m','Public','/project',100,200,'public',0,NULL,'chat'),('hidden','Hidden','/project',100,200,'hidden',0,NULL,'chat');CREATE TABLE local_runtime_message_row_migrations(session_id);INSERT INTO local_runtime_message_row_migrations VALUES('m');CREATE TABLE local_runtime_message_rows(id,session_id,role,data_json,created_at_ms);INSERT INTO local_runtime_message_rows VALUES(1,'m','user','{"msg_content":"question"}',100),(2,'m','assistant','{"msg_content":"answer"}',200);`);
  const rows=await sessions.listSessions({app:"mcode",home:x.home});assert.equal(rows.length,1);assert.equal(rows[0].createdAt,100);const result=await sessions.readSession({app:"mcode",sourcePath:rows[0].sourcePath,home:x.home});assert.deepEqual(result.messages.map(row=>row.ts),[100,200]);
});
test("OpenCode database parts retain thinking, paired output and fresh cache semantics",async t=>{
  const x=await fixture(t);await db(x.home,'.local/share/opencode/opencode.db',`CREATE TABLE session(id,title,time_created,time_updated);INSERT INTO session VALUES('s','OpenCode',100,200);CREATE TABLE message(id,session_id,data,time_created);INSERT INTO message VALUES('a','s','{"role":"assistant","modelID":"claude-opus-4-6","tokens":{"input":80,"output":12,"cache":{"read":20}}}',100);CREATE TABLE part(id,session_id,message_id,data,time_created);INSERT INTO part VALUES('p','s','a','{"type":"reasoning","text":"thinking"}',100),('t','s','a','{"type":"tool","callID":"c","tool":"read","state":{"status":"completed","input":{"path":"a"},"output":"file"}}',101);`);
  const [row]=await sessions.listSessions({app:"opencode",home:x.home});const result=await sessions.readSession({app:"opencode",sourcePath:row.sourcePath,home:x.home});assert.equal(result.messages[0].thinking,"thinking");assert.equal(result.messages[0].toolCalls[0].id,"c");assert.equal(result.messages[0].toolResults[0].status,"success");assert.equal(result.usage.totalTokens,112);
});
test("new sources reject arbitrary files, escaped symlinks and redirected WAL even after caching",async t=>{
  const x=await fixture(t);const file=await x.write('.hermes/sessions/h.jsonl',[{role:"user",content:"hello"}]);const result=await sessions.readSession({app:"hermes",sourcePath:file,home:x.home});assert.equal(result.messages.length,1);
  const outside=await x.write('outside.jsonl',[{role:"user",content:"secret"}]);await fs.unlink(file);await fs.symlink(outside,file);await assert.rejects(sessions.readSession({app:"hermes",sourcePath:file,home:x.home}),/outside|root|symlink/i);
  const database=await db(x.home,'.hermes/state.db',"CREATE TABLE sessions(id);INSERT INTO sessions VALUES('h');CREATE TABLE messages(id,session_id,role,content);INSERT INTO messages VALUES(1,'h','user','hi');");
  const [row]=await sessions.listSessions({app:"hermes",home:x.home});await sessions.readSession({app:"hermes",sourcePath:row.sourcePath,home:x.home});await fs.symlink(outside,database+'-wal');await assert.rejects(sessions.readSession({app:"hermes",sourcePath:row.sourcePath,home:x.home}),/outside|root|symlink/i);
});
test("Pi legacy chains and Grok metadata keep native tool identity and uncertain status",async t=>{
  const x=await fixture(t);
  const pi=await x.write('.pi/agent/sessions/old.jsonl',[{type:"session",version:1,id:"old"},{type:"message",message:{role:"user",content:"question"}},{type:"message",message:{role:"assistant",content:"answer"}}]);
  assert.deepEqual((await sessions.readSession({app:"pi",sourcePath:pi,home:x.home})).messages.map(row=>row.content),["question","answer"]);
  const grok=await x.write('.grok/sessions/g/chat_history.jsonl',[{role:"system",content:"injected context"},{role:"user",content:"question"},{role:"assistant",tool_calls:[{id:"c",function:{name:"read",arguments:'{"path":"a"}'}}]},{role:"tool",tool_call_id:"c",content:"result"}]);
  await fs.writeFile(path.join(path.dirname(grok),"summary.json"),JSON.stringify({info:{id:"g",cwd:"/project"},generated_title:"Native title"}));
  const [row]=await sessions.listSessions({app:"grokbuild",home:x.home});assert.equal(row.title,"Native title");assert.equal(row.projectDir,"/project");
  const result=await sessions.readSession({app:"grokbuild",sourcePath:grok,home:x.home});assert.equal(result.messages[0].injected,true);assert.equal(result.messages[2].toolCalls[0].id,"c");assert.equal(result.messages[3].toolResults[0].status,undefined);
});
test("OpenCode v2 and post-migration v1 coexist, preserving native tool names",async t=>{
  const x=await fixture(t);await db(x.home,'.local/share/opencode/opencode.db',`CREATE TABLE session_v2(id,title,directory,time_created,time_updated);INSERT INTO session_v2 VALUES('v2','V2','/project',100,300);CREATE TABLE session_message(id,session_id,type,seq,data,time_created);INSERT INTO session_message VALUES('q','v2','user',1,'{"text":"question"}',100),('a','v2','assistant',2,'{"content":[{"type":"reasoning","text":"thinking"},{"type":"tool","name":"shell","id":"c"},{"type":"text","text":"answer"}]}',200);CREATE TABLE session(id,title,time_created,time_updated);INSERT INTO session VALUES('old','Hidden old',1,50),('new','Post migration',100,250);CREATE TABLE kv(key,time_created,time_updated);INSERT INTO kv VALUES('migration.v1-v2',100,100);CREATE TABLE message(id,session_id,data,time_created);INSERT INTO message VALUES('m','new','{"role":"user"}',100);CREATE TABLE part(id,session_id,message_id,data,time_created);INSERT INTO part VALUES('p','new','m','{"type":"text","text":"retained v1"}',100);`);
  const rows=await sessions.listSessions({app:"opencode",home:x.home});assert.deepEqual(rows.map(row=>row.sessionId).sort(),["new","v2"]);
  const result=await sessions.readSession({app:"opencode",sourcePath:rows.find(row=>row.sessionId==="v2").sourcePath,home:x.home});assert.equal(result.messages[1].thinking,"thinking");assert.equal(result.messages[1].toolCalls[0].name,"shell");assert.equal(result.messages[1].toolCalls[0].id,"c");
  assert.equal((await sessions.readSession({app:"opencode",sourcePath:rows.find(row=>row.sessionId==="new").sourcePath,home:x.home})).messages[0].content,"retained v1");
});
for (const relocated of [false, true]) {
test(`legacy OpenCode lazy reads invalidate on companion edits (relocated=${relocated})`,async t=>{
  const x=await fixture(t);const storage='.local/share/opencode/storage';
  const file=path.join(x.home,storage,'session/project/s.json');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify({id:"s",directory:"/project"}));
  const message=path.join(x.home,storage,'message/s/m.json');await fs.mkdir(path.dirname(message),{recursive:true});await fs.writeFile(message,JSON.stringify({id:"m",role:"assistant",time:{created:100}}));
  const part=path.join(x.home,storage,'part/m/p.json');await fs.mkdir(path.dirname(part),{recursive:true});await fs.writeFile(part,JSON.stringify({type:"text",text:"a".repeat(5000)}));
  if (relocated) {
    const root = path.join(x.home, ".local/share/opencode");
    const moved = path.join(x.home, "relocated-opencode");
    await fs.rename(root, moved);
    await fs.symlink(moved, root, "junction");
  }
  const [listed] = await sessions.listSessions({ app: "opencode", home: x.home, env: {} });
  assert.ok(listed);
  assert.equal(listed.sourcePath, file);
  const options={app:"opencode",sourcePath:file,home:x.home};const preview=await sessions.readSession({...options,preview:true});
  assert.equal(preview.messages[0].content.length,1200);
  assert.equal((await sessions.readSessionContent({...options,revision:preview.revision,ref:preview.messages[0].contentRef.id})).content.length,5000);
  await fs.writeFile(part,JSON.stringify({type:"text",text:"b".repeat(6000)}));
  await assert.rejects(sessions.readSessionContent({...options,revision:preview.revision,ref:preview.messages[0].contentRef.id}),/changed|reload/i);
  const updated=await sessions.readSession(options);assert.equal(updated.messages[0].content.length,6000);assert.notEqual(updated.revision,preview.revision);
});
}
