/* Real Electron clipboard + production renderer + isolated SSH shell. No model call. */
const {spawn}=require('node:child_process');
const sshTarget=process.env.HAPPYPANDA_SMOKE_NODE;
if(!sshTarget||!/^(?!-)[A-Za-z0-9_.@-]+$/.test(sshTarget)||sshTarget.length>160)throw Error('Set HAPPYPANDA_SMOKE_NODE to an SSH destination.');
if(!process.versions.electron){
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'hp-clipboard-smoke-'));
  const env={...process.env,HAPPYPANDA_CLIPBOARD_SMOKE_DIR:scratch};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(require('electron'),[__filename],{env,stdio:'inherit',windowsHide:true});
  child.on('error',error=>{console.error(error.message);process.exitCode=1;});
  child.on('exit',code=>{
    process.exitCode=code??1;
    try{const root=fs.realpathSync(os.tmpdir()),target=fs.realpathSync(scratch),relative=path.relative(root,target);if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(target).startsWith('hp-clipboard-smoke-'))fs.rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:300});}
    catch(error){console.error('Fixture cleanup:',error.message);process.exitCode=1;}
  });
}else{
  require('tsx/cjs');
  const {app,BrowserWindow,ipcMain,clipboard,ClipboardItem,nativeImage}=require('electron');
  const {mkdtemp,readFile,writeFile,realpath,rm,mkdir}=require('node:fs/promises');
  const {tmpdir}=require('node:os');
  const {join,resolve,relative,isAbsolute}=require('node:path');
  const {randomUUID,randomBytes,createHash}=require('node:crypto');
  const assert=require('node:assert/strict');
  const {AppController}=require('../src/main/controller.ts');
  const {readClipboardContent,terminalPaste}=require('../src/main/clipboard.ts');
  const {runRemote,shellQuote}=require('../src/main/ssh.ts');
  const sessionId=randomUUID(),nodeId='clipboard-smoke-'+randomUUID();
  const node={id:nodeId,name:'Clipboard smoke',sshTarget,createdAt:''};
  const session={id:sessionId,nodeId,title:'Clipboard smoke',tmuxName:'hp-'+sessionId.replaceAll('-',''),createdAt:'',lastActiveAt:'',kind:'shell'};
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const sessionKey=hash(nodeId+'\0'+sessionId),marker='clipboard-smoke-'+randomUUID();
  const result={startedAt:new Date().toISOString(),checks:{},modelRequests:0};
  let window,controller,scratch,originalClipboard,clipboardOwned=false;
  let calls=0,lastPasteError;
  app.setName('happypanda-clipboard-smoke');
  app.on('window-all-closed',()=>{});
  async function waitFor(predicate,timeout=45000){
    const end=Date.now()+timeout;
    while(!await predicate()){
      if(lastPasteError)throw lastPasteError;
      if(controller?.snapshot().connection.phase==='failed')throw Error(controller.snapshot().connection.message);
      if(Date.now()>end)throw Error('Clipboard smoke timed out');
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }
  const python=script=>'python3 -c '+shellQuote('import base64;exec(base64.b64decode('+JSON.stringify(Buffer.from(script).toString('base64'))+'))');
  async function capture(index,trigger,expected){
    console.log('Starting paste capture',index);
    const ready='HP_CAPTURE_READY_'+index,done='HP_CAPTURE_DONE_'+index;
    const script=`import os,tty,termios,pathlib\np=pathlib.Path.home()/'.local/share/happypanda/runtime'/${JSON.stringify(sessionId)}/${JSON.stringify('capture-'+index+'.bin')}\nold=termios.tcgetattr(0)\ntry:\n tty.setraw(0)\n os.write(1,b'\\x1b[?2004h'+${JSON.stringify(ready)}.encode()+b'\\r\\n')\n data=b''\n while not data.endswith(b'\\x1b[201~'):\n  data+=os.read(0,4096)\n  if len(data)>1048600: raise ValueError('Capture too large')\n p.write_bytes(data)\n os.write(1,b'\\x1b[?2004l'+${JSON.stringify(done)}.encode()+b'\\r\\n')\nfinally:\n termios.tcsetattr(0,termios.TCSADRAIN,old)\n`;
    await runRemote(node,'tmux -L happypanda respawn-pane -k -t '+shellQuote(session.tmuxName+':0.0')+' '+shellQuote(python(script)));
    await waitFor(()=>controller.snapshot().terminalBuffer.includes(ready));
    console.log('Paste receiver ready',index);
    await new Promise(resolve=>setTimeout(resolve,200));
    await trigger();
    await waitFor(()=>controller.snapshot().terminalBuffer.includes(done));
    const read=`import pathlib,base64; p=pathlib.Path.home()/'.local/share/happypanda/runtime'/${JSON.stringify(sessionId)}/${JSON.stringify('capture-'+index+'.bin')}; print(base64.b64encode(p.read_bytes()).decode())`;
    const actual=Buffer.from((await runRemote(node,python(read))).trim(),'base64').toString();
    assert.equal(actual,terminalPaste(expected,true));
    assert.equal(calls,index+1,'Each gesture must paste exactly once');
    console.log('Paste capture verified',index);
  }
  app.whenReady().then(async()=>{
    scratch=process.env.HAPPYPANDA_CLIPBOARD_SMOKE_DIR||await mkdtemp(join(tmpdir(),'hp-clipboard-smoke-'));
    app.setPath('userData',join(scratch,'electron'));
    controller=new AppController({dataDir:join(scratch,'app'),resourcesDir:resolve('resources'),token:randomBytes(32).toString('hex'),
      pickDirectory:async()=>null,openLocal:async()=>{},openURL:async()=>{},readClipboard:()=>readClipboardContent(clipboard),
      emit:event=>{if(window&&!window.isDestroyed())window.webContents.send('hp:event',event);},
    });
    await controller.initialize();controller.store.nodes=[node];controller.store.sessions=[session];await controller.store.save();
    await controller.connect(node.id,undefined,session.id);
    await waitFor(()=>controller.snapshot().connection.phase==='connected');
    console.log('Isolated SSH shell connected');
    ipcMain.handle('hp:getState',()=>controller.snapshot());
    ipcMain.handle('hp:remote:getState',()=>({enabled:false,addresses:[],devices:[],owner:{id:'desktop',name:'PC'}}));
    ipcMain.handle('hp:listSshAliases',()=>[]);
    ipcMain.handle('hp:pasteClipboard',async(event,request)=>{
      assert.equal(event.sender,window.webContents);calls++;
      try{return await controller.pasteClipboard(request);}catch(error){lastPasteError=error;throw error;}
    });
    ipcMain.on('hp:terminal-write',(_event,data)=>controller.writeTerminal(data));
    ipcMain.on('hp:terminal-resize',(_event,cols,rows)=>controller.resizeTerminal(cols,rows));
    window=new BrowserWindow({width:1100,height:800,show:false,webPreferences:{preload:resolve('out/preload/index.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
    await window.loadFile(resolve('out/renderer/index.html'));
    await waitFor(()=>window.webContents.executeJavaScript('Boolean(document.querySelector(".xterm-helper-textarea"))'));
    console.log('Production terminal rendered');

    // Materialize all formats in memory before touching the user's clipboard.
    // Restore only if the clipboard still contains this fixture, preserving a new user copy.
    originalClipboard=await Promise.all((await clipboard.read()).map(async item=>new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type=>[type,await item.getType(type)]))))));
    const bitmap=Buffer.from([255,0,0,255,0,255,0,255,0,0,255,255,255,255,255,255]);
    const png=nativeImage.createFromBitmap(bitmap,{width:2,height:2}).toPNG();
    await clipboard.write([new ClipboardItem({'image/png':new Blob([png]),'text/plain':marker})]);clipboardOwned=true;
    const content=await readClipboardContent(clipboard);assert.equal(content.kind,'image');
    assert.deepEqual(nativeImage.createFromBuffer(content.png).getSize(),{width:2,height:2});result.checks.windowsClipboardPng=true;
    console.log('Windows clipboard PNG read');
    const home=(await runRemote(node,'printf "%s" "$HOME"')).trim();
    const destination=home+'/.local/share/happypanda/attachments/'+sessionKey+'/'+hash(content.png)+'.png';
    const expected=' '+shellQuote(destination)+' ';
    const key=async(modifiers)=>{
      await window.webContents.executeJavaScript('document.querySelector(".xterm-helper-textarea").focus()');
      window.webContents.sendInputEvent({type:'keyDown',keyCode:'V',modifiers});
      window.webContents.sendInputEvent({type:'keyUp',keyCode:'V',modifiers});
    };
    await capture(0,()=>key(['control']),expected);result.checks.ctrlVImage=true;
    await capture(1,()=>window.webContents.executeJavaScript('document.querySelector("button[aria-label=\\"粘贴到终端\\"]").click()'),expected);result.checks.pasteButtonImage=true;
    const imageCheck=JSON.parse(await runRemote(node,python(`import pathlib,hashlib,json; p=pathlib.Path(${JSON.stringify(destination)}); b=p.read_bytes(); print(json.dumps({'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b),'mode':p.stat().st_mode&0o777,'files':len(list(p.parent.glob('*.png')))}))`)));
    assert.equal(imageCheck.sha256,hash(content.png));assert.equal(imageCheck.bytes,content.png.length);assert.equal(imageCheck.mode,0o600);assert.equal(imageCheck.files,1);
    result.checks.remoteSha256=true;result.checks.privateFile=true;result.checks.duplicateImageReused=true;result.checks.outsideWorkspace=!destination.includes('/workspaces/');result.checks.noImageAutoSubmit=!expected.includes('\r')&&!expected.includes('\n');
    const text=marker+'\nUnicode 中文';
    await clipboard.write([new ClipboardItem({'text/plain':text})]);
    await capture(2,()=>key(['control','shift']),text);result.checks.ctrlShiftVText=true;
    result.ok=true;
  }).catch(async error=>{result.ok=false;result.error=error.stack||error.message;console.error(error.message);process.exitCode=1;await mkdir(resolve('.local'),{recursive:true});await writeFile(resolve('.local/clipboard-smoke-terminal.txt'),controller?.snapshot().terminalBuffer||'');}).finally(async()=>{
    try{
      if(clipboardOwned&&originalClipboard){
        const text=await clipboard.readText();
        if(text===marker||text===marker+'\nUnicode 中文'){await clipboard.write(originalClipboard);result.checks.clipboardRestored=true;}
        else result.checks.newUserClipboardPreserved=true;
      }
      window?.destroy();await controller?.dispose();
      await runRemote(node,'tmux -L happypanda kill-session -t '+shellQuote('='+session.tmuxName)+' 2>/dev/null || true');
      const cleanup=`import pathlib,shutil\nbase=(pathlib.Path.home()/'.local/share/happypanda').resolve()\nfor relative in ${JSON.stringify(['attachments/'+sessionKey,'runtime/'+sessionId,'workspaces/node-'+nodeId])}:\n p=base/relative\n if p.exists():\n  assert p.resolve().is_relative_to(base) and p.resolve()!=base\n  shutil.rmtree(p)\n`;
      await runRemote(node,python(cleanup));
    }catch(error){result.ok=false;result.cleanupError=error.message;process.exitCode=1;}
    result.finishedAt=new Date().toISOString();await mkdir(resolve('.local'),{recursive:true});await writeFile(resolve('.local/clipboard-smoke-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));app.exit(process.exitCode||0);
  });
}
