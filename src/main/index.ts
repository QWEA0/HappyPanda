import { app,BrowserWindow,ipcMain,dialog,shell,safeStorage,session,clipboard,Tray,Menu } from 'electron';
import { join,dirname,resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { AppController } from './controller';
import { checkLoginWebsite } from './login-network';
import { readClipboardContent,writeClipboardText } from './clipboard';
import { RemoteControlServer } from './remote-control';
import { REMOTE_RPC_WRITE_METHODS,type RemoteControlState } from '../shared/remote';
import type { TerminalPasteRequest } from '../shared/types';

let window:BrowserWindow|undefined;
let controller:AppController|undefined;
let remote:RemoteControlServer|undefined;
let tray:Tray|undefined;
let quitting=false;
if(process.env.HAPPYPANDA_DATA_DIR){const target=resolve(process.env.HAPPYPANDA_DATA_DIR);mkdirSync(target,{recursive:true});app.setPath('userData',target);}
const ownInstance=app.requestSingleInstanceLock();
if(!ownInstance)app.quit();
app.on('second-instance',()=>{window?.show();window?.focus();});
const appRoot=join(dirname(fileURLToPath(import.meta.url)),'../..');

function showWindow(){window?.show();window?.focus();}
function remoteStateChanged(state:RemoteControlState){
  if(window&&!window.isDestroyed())window.webContents.send('hp:remote-state',state);
  if(tray){
    tray.setToolTip(state.enabled?'HappyPanda · 手机远控已开启':'HappyPanda');
    tray.setContextMenu(Menu.buildFromTemplate([
      {label:'打开 HappyPanda',click:showWindow},
      {label:'手机远控',type:'checkbox',checked:state.enabled,click:item=>{void remote?.setEnabled(item.checked).catch(error=>dialog.showErrorBox('手机远控未开启',String(error)));}},
      {label:'收回控制权',enabled:state.owner.id!=='desktop',click:()=>{void remote?.takeControl();showWindow();}},
      {type:'separator'},{label:'退出',click:()=>app.quit()},
    ]));
  }
}

async function bridgeToken(dataDir:string){
  await mkdir(dataDir,{recursive:true});
  const target=join(dataDir,'bridge-key.bin');
  try{
    const data=await readFile(target);
    if(data[0]===1)return safeStorage.decryptString(data.subarray(1));
    if(data[0]===0)return data.subarray(1).toString('utf8');
    throw new Error('Invalid bridge key');
  }catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    const token=randomBytes(32).toString('hex');
    const encrypted=safeStorage.isEncryptionAvailable();
    const bytes=encrypted?safeStorage.encryptString(token):Buffer.from(token);
    await writeFile(target,Buffer.concat([Buffer.from([encrypted?1:0]),bytes]),{mode:0o600});
    return token;
  }
}

function trusted(event:Electron.IpcMainEvent|Electron.IpcMainInvokeEvent){
  if(!window||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('Untrusted application frame');
}

async function start(){
  if(!ownInstance)return;
  const dataDir=process.env.HAPPYPANDA_DATA_DIR??app.getPath('userData');
  const resourcesDir=app.isPackaged?join(process.resourcesPath,'resources'):join(appRoot,'resources');
  window=new BrowserWindow({width:1360,height:880,minWidth:840,minHeight:540,title:'HappyPanda',backgroundColor:'#f5f6f7',show:false,
    autoHideMenuBar:true,webPreferences:{preload:join(appRoot,'out/preload/index.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  controller=new AppController({dataDir,resourcesDir,token:await bridgeToken(dataDir),
    readClipboard:()=>readClipboardContent(clipboard),
    encryption:{available:()=>safeStorage.isEncryptionAvailable() && (process.platform!=='linux'||safeStorage.getSelectedStorageBackend()!=='basic_text'),encrypt:value=>safeStorage.encryptString(value),decrypt:value=>safeStorage.decryptString(value)},
    checkLoginNetwork:async(proxyPort,signal)=>{
      const probe=session.fromPartition('hp-login-probe-'+proxyPort,{cache:false});
      await probe.setProxy({mode:'fixed_servers',proxyRules:'socks5://127.0.0.1:'+proxyPort,proxyBypassRules:'<-loopback>'});
      return checkLoginWebsite((url,abort)=>probe.fetch(url,{signal:abort,credentials:'omit',cache:'no-store'}),signal);
    },
    emit:event=>{
      if(window&&!window.isDestroyed())window.webContents.send('hp:event',event);
      // The phone mirrors only the focused session; output from background tabs stays on the desktop.
      if((event.type==='terminal'||event.type==='terminal-size')&&event.sessionId!==undefined&&event.sessionId!==controller?.focusedSessionId())return;
      remote?.publish(event);
    },
    pickDirectory:async()=>{if(!window)return null;const result=await dialog.showOpenDialog(window,{properties:['openDirectory'],title:'Select workspace'});return result.canceled?null:result.filePaths[0]??null;},
    openLocal:async path=>{const error=await shell.openPath(path);if(error)throw new Error(error);},openURL:url=>shell.openExternal(url),
  });
  await controller.initialize();
  const handlers:Record<string,(...args:any[])=>unknown>={
    getState:()=>controller!.snapshot(),listSshAliases:()=>controller!.listAliases(),saveNode:input=>controller!.saveNode(input),removeNode:id=>controller!.removeNode(id),
    saveProvider:input=>controller!.saveProvider(input),removeProvider:id=>controller!.removeProvider(id),selectProvider:(nodeId,providerId)=>controller!.selectProvider(nodeId,providerId),
    chooseWorkspace:(id,mode)=>controller!.chooseWorkspace(id,mode),setWorkspaceMode:(id,mode)=>controller!.setWorkspaceMode(id,mode),connect:(...args)=>controller!.connect(args[0],args[1],args[2]),disconnect:()=>controller!.disconnect(),reconnect:()=>controller!.reconnect(),
    focusSession:id=>controller!.focusSession(id),closeSession:id=>controller!.closeSession(id),getTerminalBuffer:id=>controller!.getTerminalBuffer(id),
    newSession:kind=>controller!.newSession(kind),removeSession:id=>controller!.removeSession(id),
    setLocalAccess:(id,enabled)=>{if(typeof enabled!=='boolean')throw new Error('Invalid local access setting');return controller!.setLocalAccess(id,enabled);},
    syncNow:()=>controller!.syncNow(),pauseSync:()=>controller!.pauseSync(),resolveConflict:(path,prefer)=>controller!.resolveConflict(path,prefer),
    copyText:text=>writeClipboardText(clipboard,text),pasteClipboard:request=>{
      const epoch=remote?.getControlEpoch();
      return controller!.pasteClipboard(request,()=>!remote||(remote.isDesktopOwner()&&remote.getControlEpoch()===epoch));
    },
    openLocalPath:id=>controller!.openLocalPath(id),openExternal:url=>controller!.openExternal(url),listLocalHistory:()=>controller!.listLocalHistory(),
    importHistory:request=>controller!.importHistory(request),resumeImported:(id,path)=>controller!.resumeImported(id,path),
    importProjectMemory:id=>controller!.importProjectMemory(id),
    addPortForward:(remote,local)=>controller!.addPortForward(remote,local),removePortForward:id=>controller!.removePortForward(id),
  };
  remote=new RemoteControlServer({
    dataDir,rendererDir:join(appRoot,'out/renderer'),getState:()=>controller!.snapshot(),onState:remoteStateChanged,
    invoke:(method,args)=>{
      if(method==='pasteImage'){
        const owner=remote!.snapshot().owner.id;
        const epoch=remote!.getControlEpoch();
        return controller!.pasteImage(args[0] as TerminalPasteRequest,Buffer.from(args[1] as string,'base64'),()=>remote!.snapshot().owner.id===owner&&remote!.getControlEpoch()===epoch);
      }
      const handler=handlers[method];if(!handler)throw new Error('Unsupported remote operation');
      return handler(...args);
    },
    writeTerminal:(data,context)=>controller!.writeTerminal(data,context.sessionId),resizeTerminal:(cols,rows,context)=>controller!.resizeTerminal(cols,rows,context.sessionId),
  });
  const writeMethods=new Set<string>([...REMOTE_RPC_WRITE_METHODS,'chooseWorkspace','pasteClipboard']);
  for(const [name,handler] of Object.entries(handlers))ipcMain.handle('hp:'+name,(event,...args)=>{trusted(event);if(writeMethods.has(name))remote!.assertDesktopControl();return handler(...args);});
  const remoteHandlers:Record<string,(...args:any[])=>unknown>={
    getState:()=>remote!.snapshot(),setEnabled:enabled=>remote!.setEnabled(enabled),createPairing:()=>remote!.createPairing(),
    revokeDevice:id=>remote!.revokeDevice(id),takeControl:()=>remote!.takeControl(),
  };
  for(const [name,handler] of Object.entries(remoteHandlers))ipcMain.handle('hp:remote:'+name,(event,...args)=>{trusted(event);return handler(...args);});
  ipcMain.on('hp:terminal-write',(event,data,sessionId)=>{trusted(event);if(remote!.isDesktopOwner())controller!.writeTerminal(data,typeof sessionId==='string'?sessionId:undefined);});
  ipcMain.on('hp:terminal-resize',(event,cols,rows,sessionId)=>{trusted(event);if(remote!.isDesktopOwner())controller!.resizeTerminal(cols,rows,typeof sessionId==='string'?sessionId:undefined);});
  tray=new Tray(await app.getFileIcon(process.execPath,{size:'small'}));
  tray.on('double-click',showWindow);
  await remote.initialize();
  remoteStateChanged(remote.snapshot());
  window.webContents.setWindowOpenHandler(({url})=>{if(/^https?:\/\//i.test(url))void controller?.openExternal(url).catch(()=>{});return {action:'deny'};});
  window.webContents.on('will-navigate',(event,url)=>{const allowed=process.env.ELECTRON_RENDERER_URL;if(allowed&&new URL(url).origin===new URL(allowed).origin)return;event.preventDefault();});
  window.once('ready-to-show',()=>window?.show());
  if(process.env.ELECTRON_RENDERER_URL)await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(join(appRoot,'out/renderer/index.html'));
  window.on('closed',()=>{window=undefined;});
  window.on('close',event=>{if(!quitting&&remote?.snapshot().enabled){event.preventDefault();window?.hide();}});
}

app.whenReady().then(start).catch(error=>{dialog.showErrorBox('HappyPanda could not start',error instanceof Error?error.message:String(error));app.quit();});
app.on('activate',showWindow);
app.on('window-all-closed',()=>{if(!remote?.snapshot().enabled)app.quit();});
app.on('before-quit',event=>{if(!quitting&&controller){event.preventDefault();quitting=true;void (async()=>{await remote?.dispose();await controller!.dispose();})().finally(()=>{tray?.destroy();app.quit();});}});
