import { contextBridge,ipcRenderer } from 'electron';
import type { HappyPandaAPI,AppEvent } from '../shared/types';

const invoke=(method:string,...args:unknown[])=>ipcRenderer.invoke('hp:'+method,...args);
const api:HappyPandaAPI={
  getState:()=>invoke('getState'),listSshAliases:()=>invoke('listSshAliases'),
  saveProvider:input=>invoke('saveProvider',input),removeProvider:id=>invoke('removeProvider',id),selectProvider:(nodeId,providerId)=>invoke('selectProvider',nodeId,providerId),
  saveNode:input=>invoke('saveNode',input),removeNode:id=>invoke('removeNode',id),
  chooseWorkspace:id=>invoke('chooseWorkspace',id),connect:(...args)=>invoke('connect',...args),disconnect:()=>invoke('disconnect'),
  newSession:kind=>invoke('newSession',kind),writeTerminal:data=>ipcRenderer.send('hp:terminal-write',data),pasteClipboard:request=>invoke('pasteClipboard',request),resizeTerminal:(cols,rows)=>ipcRenderer.send('hp:terminal-resize',cols,rows),
  setLocalAccess:(id,enabled)=>invoke('setLocalAccess',id,enabled),syncNow:()=>invoke('syncNow'),pauseSync:()=>invoke('pauseSync'),resolveConflict:(path,prefer)=>invoke('resolveConflict',path,prefer),
  openLocalPath:id=>invoke('openLocalPath',id),openExternal:url=>invoke('openExternal',url),
  listLocalHistory:()=>invoke('listLocalHistory'),importHistory:request=>invoke('importHistory',request),resumeImported:(id,path)=>invoke('resumeImported',id,path),
  importProjectMemory:id=>invoke('importProjectMemory',id),
  addPortForward:(remote,local)=>invoke('addPortForward',remote,local),removePortForward:id=>invoke('removePortForward',id),
  onEvent:callback=>{const listener=(_event:Electron.IpcRendererEvent,event:AppEvent)=>callback(event);ipcRenderer.on('hp:event',listener);return()=>ipcRenderer.removeListener('hp:event',listener);},
};
contextBridge.exposeInMainWorld('happyPanda',api);
