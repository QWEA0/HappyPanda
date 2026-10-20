import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const executable = process.argv[2];
if (!executable) throw new Error('Usage: node scripts/remote-control-package-smoke.mjs <packaged-exe>');
const directory = await mkdtemp(join(tmpdir(), 'hp-remote-package-'));
const result = { checks: {}, error: null };
const port = await new Promise((done, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => done(value)); });
});
const env = { ...process.env, HAPPYPANDA_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
await mkdir(join(directory,'project'));
await writeFile(join(directory,'inventory.json'),JSON.stringify({
  nodes:[{id:'package-mode-node',name:'Workspace mode fixture',sshTarget:'fixture.invalid',createdAt:''}],
  workspaces:[{id:'package-mode-workspace',nodeId:'package-mode-node',name:'Local project',localPath:join(directory,'project'),remotePath:'/unused/happypanda/workspaces/package-mode-workspace',localAccess:false,syncSessionName:'hp-package-mode',createdAt:''}],sessions:[],
}));
const child = spawn(resolve(executable), [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { env, windowsHide: true, stdio: 'ignore' });
let finished = false;
let launchError;
child.once('error', error => { launchError = error; finished = true; });
const exit = new Promise(done => child.once('exit', () => { finished = true; done(); }));
const waitFor = async (action, label) => {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    const value = await action();
    if (value) return value;
    if (finished) throw new Error('Packaged application exited: ' + label);
    await new Promise(done => setTimeout(done, 60));
  }
  throw new Error('Timed out: ' + label);
};
let socket;
const pending = new Map();
let nextId = 0;
const command = (method, params = {}) => new Promise((done, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('Debugger request timed out: ' + method)); }, 15000);
  pending.set(id, { done, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const reply = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
  return reply.result.value;
};

try {
  const target = await waitFor(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(value => value.type === 'page' && value.url.includes('index.html')); }
    catch { return undefined; }
  }, 'packaged renderer');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.done(message.result);
  });
  await waitFor(() => evaluate('Boolean(window.happyPanda?.remoteControl)'), 'packaged preload');
  await evaluate('window.happyPanda.setWorkspaceMode("package-mode-workspace","mcp-only")');
  const modeState=await evaluate('window.happyPanda.getState()');
  assert.equal(modeState.workspaces[0].mode,'mcp-only');assert.equal(modeState.workspaces[0].localAccess,true);
  assert.equal(JSON.parse(await readFile(join(directory,'inventory.json'),'utf8')).workspaces[0].mode,'mcp-only');
  await assert.rejects(evaluate('window.happyPanda.setLocalAccess("package-mode-workspace",false)'),/MCP/);
  await assert.rejects(evaluate('window.happyPanda.setWorkspaceMode("package-mode-workspace","invalid")'),/Invalid workspace mode/);
  await evaluate('window.happyPanda.setWorkspaceMode("package-mode-workspace","sync")');
  assert.equal((await evaluate('window.happyPanda.getState()')).workspaces[0].mode,'sync');
  await evaluate('window.happyPanda.removeNode("package-mode-node")');
  result.checks.packagedWorkspaceModePersistenceAndMcpRequirement=true;
  const syntheticPassword = ' package-$-"-password-\u5bc6\u7801 ';
  const savedNode = await evaluate('window.happyPanda.saveNode(' + JSON.stringify({name:'Password package fixture',sshTarget:'fixture.invalid',authType:'password',password:syntheticPassword}) + ')');
  assert.equal(savedNode.hasPassword,true);
  assert.ok(!JSON.stringify(savedNode).includes(syntheticPassword));
  const inventoryPath=join(directory,'inventory.json');
  const encryptedInventory=await readFile(inventoryPath,'utf8');
  assert.ok(!encryptedInventory.includes(syntheticPassword));
  const cipher=JSON.parse(encryptedInventory).nodes[0].encryptedPassword;
  assert.ok(cipher);
  await evaluate('window.happyPanda.saveNode(' + JSON.stringify({...savedNode,name:'Renamed password fixture',password:''}) + ')');
  assert.equal(JSON.parse(await readFile(inventoryPath,'utf8')).nodes[0].encryptedPassword,cipher);
  const passwordOutput=await new Promise((done,reject)=>{
    const helper=spawn(join(directory,'ssh-transport','askpass.exe'),["fixture@fixture.invalid's password: "],{
      env:{...process.env,HAPPYPANDA_SSH_CONFIG:join(directory,'ssh-transport','config.json'),HAPPYPANDA_SSH_NODE:savedNode.id},windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='';let error='';const timer=setTimeout(()=>{helper.kill();reject(new Error('Packaged askpass timed out'));},15000);
    helper.stdout.on('data',data=>{output+=data;});helper.stderr.on('data',data=>{error+=data;});
    helper.once('error',cause=>{clearTimeout(timer);reject(cause);});
    helper.once('exit',code=>{clearTimeout(timer);code===0?done(output):reject(new Error('Packaged askpass failed: '+error));});
  });
  assert.equal(passwordOutput,syntheticPassword+'\n');
  await evaluate('window.happyPanda.saveNode(' + JSON.stringify({...savedNode,authType:'key'}) + ')');
  assert.ok(!JSON.parse(await readFile(inventoryPath,'utf8')).nodes[0].encryptedPassword);
  await evaluate('window.happyPanda.removeNode(' + JSON.stringify(savedNode.id) + ')');
  result.checks.sshPasswordSystemEncryptionAndPackagedAskpass=true;
  if(process.argv[3]){
    const sourceDir=process.env.HAPPYPANDA_DATA_DIR??join(process.env.APPDATA,'HappyPanda');
    const sourceInventory=JSON.parse(await readFile(join(sourceDir,'inventory.json'),'utf8'));
    const source=sourceInventory.nodes.find(value=>value.id===process.argv[3]);
    if(!source)throw new Error('Saved Windows test node not found');
    const runHelper=(file,args,options={})=>new Promise((done,reject)=>execFile(file,args,{windowsHide:true,encoding:'utf8',timeout:20000,...options},(error,stdout,stderr)=>error?reject(new Error(stderr||error.message)):done(stdout)));
    let nativeNode,nativeSession;
    try{
      const password=await runHelper(join(sourceDir,'ssh-transport','askpass.exe'),['Password:'],{env:{...process.env,HAPPYPANDA_SSH_CONFIG:join(sourceDir,'ssh-transport','config.json'),HAPPYPANDA_SSH_NODE:source.id}});
      nativeNode=await evaluate('window.happyPanda.saveNode('+JSON.stringify({name:'Native Windows package fixture',sshTarget:source.sshTarget,user:source.user,port:source.port,
        authType:'password',password:password.replace(/\r?\n$/,'')})+')');
      await evaluate('window.happyPanda.connect('+JSON.stringify(nativeNode.id)+')');
      const state=await evaluate('window.happyPanda.getState()');nativeSession=state.sessions.find(value=>value.nodeId===nativeNode.id)?.id;
      await waitFor(async()=>{const state=await evaluate('window.happyPanda.getState()');
        if(state.connection.phase==='failed')throw new Error('Packaged Windows connection failed: '+state.connection.message);
        return state.connection.phase==='connected'&&state.metrics?.os?.includes('Windows');},'native Windows connection and metrics');
      const capture=await command('Page.captureScreenshot',{format:'png'});
      await mkdir(resolve('.local'),{recursive:true});await writeFile(resolve('.local/windows-packaged.png'),Buffer.from(capture.data,'base64'));
      result.checks.packagedNativeWindowsConnectionAndMetrics=true;
    }finally{
      await evaluate('window.happyPanda.disconnect()').catch(()=>{});
      if(nativeSession)await evaluate('window.happyPanda.removeSession('+JSON.stringify(nativeSession)+')').catch(()=>{});
      if(nativeNode)await evaluate('window.happyPanda.removeNode('+JSON.stringify(nativeNode.id)+')').catch(()=>{});
      if(nativeNode&&nativeSession){
        const cleanup=`$ErrorActionPreference='Stop';$base=[IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.local/share/happypanda'));`+
          `$names=@('runtime/${nativeSession}','workspaces/node-${nativeNode.id}');foreach($name in $names){$target=[IO.Path]::GetFullPath((Join-Path $base $name));`+
          `if(-not $target.StartsWith($base+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid test cleanup path'};`+
          `if(Test-Path -LiteralPath $target){$actual=(Resolve-Path -LiteralPath $target).Path;if($actual -ne $target){throw 'Unexpected test path'};Remove-Item -LiteralPath $target -Recurse -Force}}`;
        const args=[...(source.user?['-l',source.user]:[]),...(source.port?['-p',String(source.port)]:[]),source.sshTarget,'powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(cleanup,'utf16le').toString('base64')];
        await runHelper(join(sourceDir,'ssh-transport','ssh.exe'),args).catch(error=>{result.checks.nativeTestCleanup=false;throw error;});
      }
    }
  }
  await evaluate('window.happyPanda.remoteControl.setEnabled(true)');
  const state = await evaluate('window.happyPanda.remoteControl.createPairing()');
  assert.equal(state.enabled, true);
  const base = `http://127.0.0.1:${state.port}`;
  const page = await fetch(base + '/remote/');
  assert.equal(page.status, 200);
  const html = await page.text();
  const assets = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^\"]+)"/g)].map(match => match[1]);
  assert.equal(assets.length, 2);
  for (const asset of assets) {
    const response = await fetch(new URL(asset, base + '/remote/'));
    assert.equal(response.status, 200);
    assert.ok((await response.arrayBuffer()).byteLength > 1000);
    assert.match(response.headers.get('content-type'), /javascript|css/);
  }
  result.checks.asarHtmlAndAssets = true;
  const response = await fetch(base + '/api/remote/pair', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: state.pairing.token, name: 'Packaged Android test' }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const info = (await response.json()).result;
  const headers = { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/api/remote/control', { method: 'POST', headers, body: JSON.stringify({ action: 'claim' }) })).status, 200);
  assert.equal((await evaluate('window.happyPanda.remoteControl.getState()')).owner.id, info.deviceId);
  result.checks.packagedPairAndClaim = true;
  await evaluate('window.happyPanda.remoteControl.takeControl()');
  await evaluate(`window.happyPanda.remoteControl.revokeDevice(${JSON.stringify(info.deviceId)})`);
  assert.equal((await fetch(base + '/api/remote/session', { headers: { Cookie: cookie } })).status, 401);
  await evaluate('window.happyPanda.remoteControl.setEnabled(false)');
  assert.equal((await evaluate('window.happyPanda.remoteControl.getState()')).enabled, false);
  result.checks.packagedRevokeAndDisable = true;
} catch (error) {
  result.error = error.stack;
  process.exitCode = 1;
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    // Quit through the real window lifecycle after disabling the remote host.
    void command('Runtime.evaluate', { expression: 'window.close()' }).catch(() => {});
  }
  await Promise.race([exit, new Promise(done => setTimeout(done, 5000))]);
  socket?.close();
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Packaged test finished')); }
  if (!finished && child.pid) {
    if (process.platform === 'win32') await new Promise(done => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, done));
    else child.kill();
    await Promise.race([exit, new Promise(done => setTimeout(done, 3000))]);
  }
  await mkdir(resolve('.local'), { recursive: true });
  await writeFile(resolve('.local/remote-control-package-smoke-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('hp-remote-package-')) throw new Error('Unsafe packaged test cleanup.');
  await rm(directory, { recursive: true, force: true });
}
