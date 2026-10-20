import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';

const executables = process.argv.slice(2);
if (!executables.length) throw new Error('Usage: node scripts/startup-smoke.mjs <executable> [executable ...]');
const results = [];
const delay = ms => new Promise(done => setTimeout(done, ms));

for (const executable of executables) {
  if (process.platform === 'win32') {
    const running = await new Promise((done, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:HAPPYPANDA_STARTUP_EXECUTABLE } | Select-Object -ExpandProperty ProcessId'],
    { windowsHide: true, env: { ...process.env, HAPPYPANDA_STARTUP_EXECUTABLE: resolve(executable) } },
    (error, stdout) => error ? reject(error) : done(stdout.trim())));
    assert.ok(!running, 'Close the application built from this executable before benchmarking it: ' + executable);
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'hp-startup-'));
  const port = await new Promise((done, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => done(port));
    });
  });
  const env = { ...process.env, HAPPYPANDA_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const started = performance.now();
  const child = spawn(resolve(executable), [`--inspect=127.0.0.1:${port}`], { env, windowsHide: true, stdio: 'ignore' });
  let exited = false;
  let launchError;
  child.once('error', error => { launchError = error; });
  const exit = new Promise(done => child.once('exit', () => { exited = true; done(); }));
  let socket;
  let nextId = 0;
  const pending = new Map();
  const deadline = started + 60000;
  const request = (method, params = {}) => new Promise((done, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Inspector timed out: ' + method)); }, 5000);
    pending.set(id, { done, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const result = { executable: resolve(executable), dataDir };
  try {
    let target;
    while (performance.now() < deadline) {
      if (launchError) throw launchError;
      if (exited) throw new Error('Application exited before startup');
      try {
        target = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) })).json())[0];
        if (target) break;
      } catch {}
      await delay(50);
    }
    assert.ok(target, 'Application main process did not start within 60 seconds');
    result.mainProcessMs = Math.round(performance.now() - started);
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((done, reject) => {
      socket.addEventListener('open', done, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const item = pending.get(message.id);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message));
      else item.done(message.result);
    });
    // Inspect the Electron main process; no renderer debugging port is opened.
    const electron = "process.getBuiltinModule('module').createRequire(process.execPath)('electron')";
    while (performance.now() < deadline) {
      const reply = await request('Runtime.evaluate', {
        expression: `JSON.stringify((()=>{const e=${electron};return {uptime:process.uptime(),ready:e.BrowserWindow.getAllWindows().some(w=>w.webContents.getURL().includes('index.html')&&!w.webContents.isLoadingMainFrame())}})())`,
        returnByValue: true,
      });
      assert.ok(!reply.exceptionDetails, JSON.stringify(reply.exceptionDetails));
      const state = JSON.parse(reply.result.value);
      if (state.ready) {
        result.pageLoadedMs = Math.round(performance.now() - started);
        result.applicationMs = Math.round(state.uptime * 1000);
        break;
      }
      await delay(50);
    }
    assert.ok(result.pageLoadedMs, 'Application page did not load within 60 seconds');
    await request('Runtime.evaluate', { expression: `${electron}.app.quit()` }).catch(() => {});
  } catch (error) {
    result.error = error.message;
    process.exitCode = 1;
  } finally {
    socket?.close();
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Startup measurement finished')); }
    await Promise.race([exit, delay(3000)]);
    if (!exited && child.pid) {
      if (process.platform === 'win32') await new Promise(done => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, done));
      else child.kill();
      await Promise.race([exit, delay(3000)]);
    }
    if (exited) {
      assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
      assert.ok(basename(dataDir).startsWith('hp-startup-'));
      await rm(dataDir, { recursive: true, force: true });
    } else {
      result.error ??= 'Test application did not exit; its data directory was preserved';
      process.exitCode = 1;
    }
  }
  results.push(result);
  console.log(JSON.stringify(result));
}
await mkdir(resolve('.local'), { recursive: true });
await writeFile(resolve('.local/startup-smoke-result.json'), JSON.stringify({ measuredAt: new Date().toISOString(), results }, null, 2));
