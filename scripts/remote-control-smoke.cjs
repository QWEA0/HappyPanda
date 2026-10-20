const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  void (async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hp-remote-electron-'));
    const env = { ...process.env, HAPPYPANDA_DATA_DIR: dataDir };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      process.exitCode = await new Promise((resolve, reject) => {
        const child = require('node:child_process').spawn(require('electron'), [__filename], { cwd: root, env, stdio: 'inherit', windowsHide: true });
        child.once('error', reject);
        child.once('exit', code => resolve(code ?? 1));
      });
      const report = JSON.parse(await fs.readFile(path.join(root, '.local', 'remote-control-smoke-result.json'), 'utf8'));
      if (report.error) process.exitCode = 1;
    } finally {
      if (path.dirname(path.resolve(dataDir)) !== path.resolve(os.tmpdir()) || !path.basename(dataDir).startsWith('hp-remote-electron-')) throw new Error('Unsafe Electron fixture cleanup.');
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, dialog } = require('electron');
  app.setPath('userData', process.env.HAPPYPANDA_DATA_DIR);
  app.disableHardwareAcceleration();
  const result = { checks: {}, screenshots: [], error: null };
  const evaluate = source => window.webContents.executeJavaScript(source);
  let window;
  const until = async (check, message) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const value = await check();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 35));
    }
    throw new Error(message);
  };
  dialog.showErrorBox = (title, content) => { throw new Error(title + ': ' + content); };
  const status = () => evaluate('window.happyPanda.remoteControl.getState()');
  const run = async () => {
    await import('../out/main/index.js');
    await app.whenReady();
    window = await until(() => BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed() && candidate.webContents.getURL().includes('/renderer/index.html') && !candidate.webContents.isLoadingMainFrame()), 'Desktop window did not load');
    await until(() => evaluate('Boolean(document.querySelector("button[aria-label=手机远控]"))'), 'Remote entry was not rendered');
    await evaluate('document.querySelector("button[aria-label=手机远控]").click()');
    await until(() => evaluate('Boolean(document.querySelector(".remote-admin [role=switch]"))'), 'Remote settings did not open');
    await evaluate('document.querySelector(".remote-admin [role=switch]").click()');
    const enabled = await until(async () => { const value = await status(); return value.enabled && value.pairing && value; }, 'Remote enable/pairing failed');
    await until(() => evaluate('Boolean(document.querySelector("img[alt=手机远控配对二维码]")?.naturalWidth)'), 'QR code did not render');
    result.checks.desktopEnableAndQr = true;
    await fs.mkdir(path.join(root, '.local'), { recursive: true });
    const screenshot = path.join(root, '.local', 'remote-control-desktop.png');
    await fs.writeFile(screenshot, (await window.webContents.capturePage()).toPNG());
    result.screenshots.push(screenshot);
    const base = 'http://127.0.0.1:' + enabled.port;
    const html = await fetch(base + '/remote/');
    assert.equal(html.status, 200);
    assert.ok((await html.text()).includes('HappyPanda'));
    const pair = await fetch(base + '/api/remote/pair', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: enabled.pairing.code, name: 'Android smoke fixture' }) });
    assert.equal(pair.status, 200);
    const cookie = pair.headers.get('set-cookie').split(';')[0];
    const session = (await pair.json()).result;
    const headers = { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/api/remote/control', { method: 'POST', headers, body: JSON.stringify({ action: 'claim' }) })).status, 200);
    await until(async () => (await status()).owner.id === session.deviceId, 'Phone did not acquire input ownership');
    await assert.rejects(evaluate('window.happyPanda.saveNode({name:"Must be rejected",sshTarget:"example.invalid"})'), /控制/);
    result.checks.pairingAndDesktopWriteGuard = true;
    await evaluate('document.querySelector("button[aria-label=关闭弹窗]").click()');
    await until(() => evaluate('Boolean(document.querySelector(".desktop-remote-owner"))'), 'Desktop takeover banner missing');
    window.close();
    assert.equal(window.isDestroyed(), false);
    assert.equal(window.isVisible(), false);
    assert.equal((await fetch(base + '/api/remote/session', { headers: { Cookie: cookie } })).status, 200);
    result.checks.closeKeepsPcHostRunning = true;
    window.show();
    await evaluate('window.happyPanda.remoteControl.takeControl()');
    assert.equal((await status()).owner.id, 'desktop');
    const desktopSession = (await (await fetch(base + '/api/remote/session', { headers: { Cookie: cookie } })).json()).result;
    assert.equal(desktopSession.owner.id, 'desktop');
    await evaluate('window.happyPanda.remoteControl.revokeDevice(' + JSON.stringify(session.deviceId) + ')');
    assert.equal((await fetch(base + '/api/remote/session', { headers: { Cookie: cookie } })).status, 401);
    result.checks.reclaimAndRevoke = true;
    await evaluate('window.happyPanda.remoteControl.setEnabled(false)');
    assert.equal((await status()).enabled, false);
    assert.equal((await status()).devices.length, 0);
    result.checks.disable = true;
  };
  void run().catch(error => { result.error = error.stack; process.exitCode = 1; }).finally(async () => {
    await fs.mkdir(path.join(root, '.local'), { recursive: true });
    await fs.writeFile(path.join(root, '.local', 'remote-control-smoke-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    app.quit();
  });
}
