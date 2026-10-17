const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('detached adapter enable, process loss, restart, rollback and disable preserve other groups', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aitool-free-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const preload = path.join(root, 'fetch.cjs');
  fs.writeFileSync(preload, `
    const original = global.fetch;
    global.fetch = async (url, options) => {
      if (String(url).startsWith('http://127.0.0.1:')) return original(url, options);
      if (String(url).includes('models.dev')) return Response.json({ opencode: { npm: '@ai-sdk/openai-compatible', models: {
        'big-pickle': { id:'big-pickle',cost:{input:0,output:0},modalities:{output:['text']},tool_call:true }
      } } });
      return Response.json({data:[{id:'big-pickle'}]});
    };
  `);
  const script = path.join(root, 'lifecycle.cjs');
  const lib = path.resolve(__dirname, '../src/lib/proxy');
  fs.writeFileSync(script, `
    const assert = require('node:assert/strict'), fs = require('node:fs');
    const state = require(${JSON.stringify(path.join(lib, 'opencode-free/state'))});
    const management = require(${JSON.stringify(path.join(lib, 'management'))});
    const other = {name:'existing',keys:[{'api-key':'private',headers:{test:'keep'}}],models:[{name:'paid',alias:'paid'}],future:true};
    let groups = [other], failPut = false;
    management.request = async (method, route, options) => {
      assert.equal(route, '/v8/management/config/api-keys/openai-compatibility');
      if (method === 'GET') return {ok:true,status:200,data:groups};
      if (failPut) return {ok:false,status:500};
      groups = options.body; return {ok:true,status:200};
    };
    const free = require(${JSON.stringify(path.join(lib, 'opencode-free'))});
    (async () => { try {
      assert.equal((await free.status()).enabled,false);
      const enabled = await free.configure({enabled:true,models:['big-pickle']});
      assert.equal(enabled.running,true); assert.equal(groups.length,2); assert.deepEqual(groups[0],other);
      assert.equal(fs.statSync(state.settingsPath).mode & 0o777,0o600);
      assert.equal('token' in enabled,false);
      const alias = {name:'big-pickle',alias:'pickle-high',thinking:{levels:['high']}};
      groups[1].models.push(alias);
      await free.configure({enabled:true,models:['big-pickle']});
      assert.deepEqual(groups[1].models,[{name:'big-pickle',alias:'big-pickle'},alias]);
      const port = enabled.port;
      state.write(state.settingsPath,{...state.settings(),port:0});
      await free.startEnabled();
      assert.equal(state.settings().port,port);
      const runtime = state.read(state.runtimePath);
      // This PID was verified by the authenticated status check above.
      process.kill(runtime.pid,'SIGKILL');
      await new Promise(r=>setTimeout(r,200));
      assert.equal((await free.status()).running,false);
      await free.startEnabled();
      assert.equal((await free.status()).port,port);
      assert.equal((await free.status()).running,true);
      await free.syncGroup();
      assert.deepEqual(groups[1].models,[{name:'big-pickle',alias:'big-pickle'},alias]);
      failPut = true;
      await assert.rejects(free.configure({enabled:false}),/save_failed/);
      assert.equal((await free.status()).running,true); assert.equal(state.settings().enabled,true);
      failPut = false;
      await free.stop(); assert.equal((await free.status()).running,false);
      await free.startEnabled(); assert.equal((await free.status()).running,true);
      const disabled = await free.configure({enabled:false});
      assert.equal(disabled.running,false); assert.equal(disabled.enabled,false); assert.deepEqual(groups,[other]);
      const paths = require(${JSON.stringify(path.join(lib, 'paths'))});
      paths.configPath = require('node:path').join(state.root, 'offline.yaml');
      paths.pidPath = require('node:path').join(state.root, 'missing.pid');
      const YAML = require(${JSON.stringify(path.resolve(__dirname, '../node_modules/yaml'))});
      const owned = free.mergeGroup([other], state.settings(), true);
      const raw = '# keep this comment\\n' + YAML.stringify({'api-keys':{'openai-compatibility':owned},access:{'api-keys':['client']}});
      fs.writeFileSync(paths.configPath,raw);
      management.request = async()=>({ok:false,status:0,error:'ECONNREFUSED'});
      await free.configure({enabled:false});
      const after=fs.readFileSync(paths.configPath,'utf8');
      assert.ok(after.includes('# keep this comment'));
      assert.deepEqual(YAML.parse(after)['api-keys']['openai-compatibility'],[other]);
      assert.ok(fs.readdirSync(state.root).some(name=>name.endsWith('.bak')));
      console.log('lifecycle passed');
    } finally { await free.stop(); } })().catch(e=>{console.error(e);process.exitCode=1;});
  `);
  const { stdout } = await promisify(execFile)(process.execPath, [script], {
    env: { ...process.env, AITOOL_OPENCODE_FREE_DIR: path.join(root, 'state'), NODE_OPTIONS: `--require=${preload}` }, timeout: 30000,
  });
  assert.match(stdout, /lifecycle passed/);
});
