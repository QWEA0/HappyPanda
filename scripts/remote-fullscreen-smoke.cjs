const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  void (async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hp-fullscreen-smoke-'));
    const env = { ...process.env, HAPPYPANDA_FULLSCREEN_TEST_DATA: directory };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      process.exitCode = await new Promise((resolve, reject) => {
        const child = require('node:child_process').spawn(require('electron'), [__filename], { cwd: root, env, stdio: 'inherit', windowsHide: true });
        child.once('error', reject);
        child.once('exit', code => resolve(code ?? 1));
      });
    } finally {
      if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('hp-fullscreen-smoke-')) throw new Error('Unsafe test directory cleanup.');
      await fs.rm(directory, { recursive: true, force: true });
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.HAPPYPANDA_FULLSCREEN_TEST_DATA);
  app.disableHardwareAcceleration();
  const report = { checks: {}, error: null };
  let window;
  const evaluate = expression => window.webContents.executeJavaScript(expression, true);
  const until = async (read, label) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const value = await read();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error('Timed out: ' + label);
  };
  void (async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(root, '.local', 'remote-control-runtime.json'), 'utf8'));
    assert.ok(manifest.url.startsWith('http://127.0.0.1:'));
    assert.match(manifest.code, /^\d{8}$/);
    await app.whenReady();
    window = new BrowserWindow({ width: 844, height: 390, useContentSize: true, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'fullscreen'));
    await window.loadURL(manifest.url);
    await until(() => evaluate('Boolean(document.querySelector("input.remote-code-input"))'), 'pairing form');
    await evaluate(`(() => { const input=document.querySelector('input.remote-code-input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(manifest.code)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await until(() => evaluate('Boolean(document.querySelector(".remote-pair-form button[type=submit]:not(:disabled)"))'), 'pairing code state');
    await evaluate('document.querySelector(".remote-pair-form button[type=submit]").click()');
    await until(() => evaluate('Boolean(document.querySelector("button[aria-label=进入全屏]"))'), 'terminal dock');
    await evaluate('document.querySelector("button[aria-label=进入全屏]").click()');
    await until(async () => window.isFullScreen() && await evaluate('Boolean(document.fullscreenElement && document.querySelector("button[aria-label=退出全屏]"))'), 'native fullscreen entry');
    report.checks.nativeWindowAndDocumentFullscreen = true;
    await until(() => evaluate('Math.abs(document.querySelector(".remote-app").getBoundingClientRect().height - window.visualViewport.height) < 1'), 'fullscreen viewport fit');
    report.checks.viewportTracksFullscreen = true;
    report.checks.mirroredTerminalFullyVisible = await evaluate(`(() => { const screen=document.querySelector('.xterm-screen').getBoundingClientRect(), viewport=document.querySelector('.terminal-viewport').getBoundingClientRect(); return screen.left >= viewport.left-1 && screen.top >= viewport.top-1 && screen.right <= viewport.right+1 && screen.bottom <= viewport.bottom+1; })()`);
    assert.equal(report.checks.mirroredTerminalFullyVisible, true);
    await fs.mkdir(path.join(root, '.local', 'android-terminal'), { recursive: true });
    await fs.writeFile(path.join(root, '.local', 'android-terminal', 'native-fullscreen.png'), (await window.webContents.capturePage()).toPNG());
    await evaluate('document.querySelector("button[aria-label=退出全屏]").click()');
    await until(async () => !window.isFullScreen() && await evaluate('!document.fullscreenElement && Boolean(document.querySelector("button[aria-label=进入全屏]"))'), 'native fullscreen exit');
    report.checks.nativeFullscreenExit = true;
    await evaluate('document.querySelector("button[aria-label=进入全屏]").click()');
    await until(() => evaluate('Boolean(document.fullscreenElement)'), 'second fullscreen entry');
    await evaluate('document.querySelector("button[aria-label=展开会话导航]").click()');
    await until(() => evaluate('Boolean(document.querySelector("button[aria-label^=返回节点列表]"))'), 'session navigation');
    await evaluate('document.querySelector("button[aria-label^=返回节点列表]").click()');
    await until(async () => !window.isFullScreen() && await evaluate('!document.fullscreenElement && !document.querySelector(".remote-terminal")'), 'fullscreen exit on node list');
    report.checks.leavingTerminalExitsFullscreen = true;
  })().catch(error => { report.error = error.stack || String(error); app.exitCode = 1; }).finally(async () => {
    await fs.mkdir(path.join(root, '.local'), { recursive: true });
    await fs.writeFile(path.join(root, '.local', 'remote-fullscreen-smoke-result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    window?.destroy();
    app.exit(report.error ? 1 : 0);
  });
}
