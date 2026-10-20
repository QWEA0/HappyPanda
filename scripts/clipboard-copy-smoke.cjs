/* Native clipboard + built terminal UI, without SSH or model requests. */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-clipboard-copy-'));
  const env = { ...process.env, HAPPYPANDA_COPY_SMOKE_DIR: scratch };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { cwd: path.resolve(__dirname, '..'), env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => {
    process.exitCode = code ?? 1;
    try {
      const root = fs.realpathSync(os.tmpdir()), target = fs.realpathSync(scratch), relative = path.relative(root, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(target).startsWith('hp-clipboard-copy-')) throw Error('Unexpected fixture directory');
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  });
} else {
  require('tsx/cjs');
  const { app, BrowserWindow, ipcMain, clipboard, ClipboardItem } = require('electron');
  const assert = require('node:assert/strict');
  const { randomUUID } = require('node:crypto');
  const { readClipboardContent, terminalPaste, writeClipboardText } = require('../src/main/clipboard.ts');
  const appRoot = path.resolve(process.argv[2] || '.');
  const line = 'HappyPanda clipboard ' + randomUUID();
  const unicode = 'Unicode \u4e2d\u6587';
  const multiline = line + os.EOL + unicode;
  const marker = 'hp-clipboard-copy-' + randomUUID();
  const ownedText = new Set([marker, line, multiline]);
  const node = { id: 'copy-test', name: 'Clipboard test', sshTarget: 'fixture.invalid', createdAt: '' };
  const state = {
    nodes: [node], providers: [], workspaces: [], sessions: [], activities: [], metrics: null, version: 'test',
    connection: { phase: 'connected', message: '', retryAttempt: 0, activeNodeId: node.id, activeSessionId: 'copy-test' },
    sync: { phase: 'none', message: '', conflicts: [], updatedAt: '' },
    terminalBuffer: line + '\r\n' + unicode + '\r\n',
  };
  const result = { checks: {}, sshRequests: 0, modelRequests: 0 };
  const writes = [];
  let window, originalClipboard, clipboardOwned = false, pasteCalls = 0;
  app.setPath('userData', process.env.HAPPYPANDA_COPY_SMOKE_DIR);
  app.on('window-all-closed', () => {});

  async function waitFor(predicate, message, timeout = 4000) {
    const end = Date.now() + timeout;
    while (!await predicate()) {
      if (Date.now() > end) throw Error(message);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  const evaluate = script => window.webContents.executeJavaScript(script);
  const selection = () => evaluate(`(() => {
    const data = new DataTransfer();
    document.querySelector('.xterm').dispatchEvent(new ClipboardEvent('copy', { bubbles: true, clipboardData: data }));
    return data.getData('text/plain');
  })()`);
  async function select(endRow = 0) {
    const bounds = await evaluate(`(() => {
      const rows = document.querySelectorAll('.xterm-rows > div');
      const first = rows[0].getBoundingClientRect(), last = rows[${endRow}].getBoundingClientRect();
      const end = rows[${endRow}].lastElementChild.getBoundingClientRect();
      return { x: Math.round(first.x + 1), y: Math.round(first.y + first.height / 2), endX: Math.round(end.right + 1), endY: Math.round(last.y + last.height / 2) };
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseDown', x: bounds.x, y: bounds.y, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseMove', x: bounds.endX, y: bounds.endY, button: 'left' });
    window.webContents.sendInputEvent({ type: 'mouseUp', x: bounds.endX, y: bounds.endY, button: 'left', clickCount: 1 });
    const expected = endRow ? multiline : line;
    await waitFor(async () => await selection() === expected, 'Terminal mouse selection did not match fixture');
  }
  async function key(keyCode, modifiers) {
    await evaluate('document.querySelector(".xterm-helper-textarea").focus()');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }
  async function check(name, action) {
    try { await action(); result.checks[name] = true; }
    catch (error) { result.checks[name] = error.message; process.exitCode = 1; }
  }
  async function copied(action, endRow = 0) {
    await clipboard.writeText(marker);
    await select(endRow);
    const before = writes.length;
    await action();
    await waitFor(async () => await clipboard.readText() === (endRow ? multiline : line), 'Selected terminal text was not written to the system clipboard');
    assert.equal(writes.length, before, 'Copy must not send input to the terminal');
  }

  app.whenReady().then(async () => {
    originalClipboard = await Promise.all((await clipboard.read()).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
    await clipboard.writeText(marker); clipboardOwned = true;
    ipcMain.handle('hp:getState', () => state);
    ipcMain.handle('hp:remote:getState', () => ({ enabled: false, addresses: [], devices: [], owner: { id: 'desktop', name: 'PC' } }));
    ipcMain.handle('hp:listSshAliases', () => []);
    ipcMain.handle('hp:copyText', (event, text) => {
      assert.equal(event.sender, window.webContents);
      assert.equal(event.senderFrame, window.webContents.mainFrame);
      return writeClipboardText(clipboard, text);
    });
    ipcMain.handle('hp:pasteClipboard', async (_event, request) => {
      const content = await readClipboardContent(clipboard);
      assert.equal(content.kind, 'text'); pasteCalls++;
      writes.push(terminalPaste(content.text, request.bracketedPaste));
      return { kind: content.kind };
    });
    ipcMain.on('hp:terminal-write', (_event, data) => writes.push(data));
    ipcMain.on('hp:terminal-resize', () => {});
    window = new BrowserWindow({ width: 1360, height: 880, show: false, webPreferences: {
      preload: path.join(appRoot, 'out/preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
    } });
    await window.loadFile(path.join(appRoot, 'out/renderer/index.html'));
    await waitFor(() => evaluate('Boolean(document.querySelector(".xterm-rows > div > span"))'), 'Built terminal did not render', 15000);
    await check('ctrlCSelection', () => copied(() => key('C', ['control'])));
    await check('ctrlShiftCUnicode', () => copied(() => key('C', ['control', 'shift']), 1));
    const copyButton = () => evaluate(`document.querySelector('button[aria-label="\u590d\u5236\u7ec8\u7aef\u9009\u533a"]').click()`);
    await check('copyButton', () => copied(copyButton));
    await check('copyMenu', () => copied(() => evaluate(`(() => {
      const button = [...document.querySelectorAll('details button')].find(button => button.textContent.includes('\u590d\u5236\u7ec8\u7aef\u9009\u533a'));
      button.closest('details').open = true; button.click();
    })()`)));
    await check('ctrlCInterruptWithoutSelection', async () => {
      const point = await evaluate(`(() => { const rect = document.querySelector('.xterm-screen').getBoundingClientRect(); return { x: Math.round(rect.x + 2), y: Math.round(rect.y + 2) }; })()`);
      window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
      window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
      await waitFor(async () => await selection() === '', 'Terminal selection was not cleared');
      const before = writes.length;
      await key('C', ['control']);
      await waitFor(() => writes.length > before, 'Ctrl+C did not reach the terminal');
      assert.deepEqual(writes.slice(before), ['\x03']);
    });
    await check('emptySelectionPreservesClipboard', async () => {
      await clipboard.writeText(marker);
      await copyButton();
      assert.equal(await clipboard.readText(), marker);
    });
    await check('ctrlVPasteOnce', async () => {
      await clipboard.writeText(multiline);
      const before = writes.length;
      await key('V', ['control']);
      await waitFor(() => pasteCalls === 1, 'Ctrl+V did not invoke clipboard paste');
      assert.deepEqual(writes.slice(before), [terminalPaste(multiline, false)]);
    });
    await check('nativePasteIntoTextField', async () => {
      await copied(() => key('C', ['control', 'shift']), 1);
      await evaluate(`(() => { const input = document.createElement('textarea'); input.id = 'copy-smoke-target'; document.body.append(input); input.focus(); })()`);
      window.webContents.paste();
      await waitFor(async () => await evaluate('document.getElementById("copy-smoke-target").value') === multiline.replace(/\r\n/g, '\n'), 'System clipboard could not be pasted into a text field');
    });
    await check('copyAfterDisconnect', async () => {
      state.connection.phase = 'disconnected';
      window.webContents.send('hp:event', { type: 'state', state });
      await waitFor(() => evaluate('document.querySelector(".xterm-helper-textarea").readOnly'), 'Terminal did not enter disconnected state');
      await copied(() => key('C', ['control']));
    });
  }).catch(error => { result.error = error.stack; process.exitCode = 1; }).finally(async () => {
    try {
      if (clipboardOwned && ownedText.has(await clipboard.readText())) {
        await clipboard.write(originalClipboard); result.checks.clipboardRestored = true;
      }
      window?.destroy();
    } catch (error) { result.cleanupError = error.message; process.exitCode = 1; }
    result.ok = !process.exitCode;
    fs.mkdirSync(path.resolve('.local'), { recursive: true });
    fs.writeFileSync(path.resolve('.local/clipboard-copy-smoke-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    app.exit(process.exitCode || 0);
  });
}
