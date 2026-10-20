import { contextBridge,ipcRenderer } from 'electron';
import type { HappyPandaAPI,AppEvent } from '../shared/types';

const invoke=(method:string,...args:unknown[])=>ipcRenderer.invoke('hp:'+method,...args);
const api:HappyPandaAPI={
  remoteControl:{
    getState:()=>invoke('remote:getState'),setEnabled:enabled=>invoke('remote:setEnabled',enabled),
    createPairing:()=>invoke('remote:createPairing'),revokeDevice:id=>invoke('remote:revokeDevice',id),takeControl:()=>invoke('remote:takeControl'),
    onState:callback=>{const listener=(_event:Electron.IpcRendererEvent,state:Parameters<typeof callback>[0])=>callback(state);ipcRenderer.on('hp:remote-state',listener);return()=>ipcRenderer.removeListener('hp:remote-state',listener);},
  },
  getState:()=>invoke('getState'),listSshAliases:()=>invoke('listSshAliases'),
  saveProvider:input=>invoke('saveProvider',input),removeProvider:id=>invoke('removeProvider',id),selectProvider:(nodeId,providerId)=>invoke('selectProvider',nodeId,providerId),
  saveNode:input=>invoke('saveNode',input),removeNode:id=>invoke('removeNode',id),
  chooseWorkspace:(id,mode)=>invoke('chooseWorkspace',id,mode),setWorkspaceMode:(id,mode)=>invoke('setWorkspaceMode',id,mode),connect:(...args)=>invoke('connect',...args),disconnect:()=>invoke('disconnect'),reconnect:()=>invoke('reconnect'),
  focusSession:id=>invoke('focusSession',id),closeSession:id=>invoke('closeSession',id),getTerminalBuffer:id=>invoke('getTerminalBuffer',id),
  newSession:kind=>invoke('newSession',kind),removeSession:id=>invoke('removeSession',id),writeTerminal:(data,sessionId)=>ipcRenderer.send('hp:terminal-write',data,sessionId),copyText:text=>invoke('copyText',text),pasteClipboard:request=>invoke('pasteClipboard',request),resizeTerminal:(cols,rows,sessionId)=>ipcRenderer.send('hp:terminal-resize',cols,rows,sessionId),
  setLocalAccess:(id,enabled)=>invoke('setLocalAccess',id,enabled),syncNow:()=>invoke('syncNow'),pauseSync:()=>invoke('pauseSync'),resolveConflict:(path,prefer)=>invoke('resolveConflict',path,prefer),
  openLocalPath:id=>invoke('openLocalPath',id),openExternal:url=>invoke('openExternal',url),
  listLocalHistory:()=>invoke('listLocalHistory'),importHistory:request=>invoke('importHistory',request),resumeImported:(id,path)=>invoke('resumeImported',id,path),
  importProjectMemory:id=>invoke('importProjectMemory',id),
  addPortForward:(remote,local)=>invoke('addPortForward',remote,local),removePortForward:id=>invoke('removePortForward',id),
  onEvent:callback=>{const listener=(_event:Electron.IpcRendererEvent,event:AppEvent)=>callback(event);ipcRenderer.on('hp:event',listener);return()=>ipcRenderer.removeListener('hp:event',listener);},
};
contextBridge.exposeInMainWorld('happyPanda',api);
