import { randomUUID, createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, basename, posix } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import * as pty from 'node-pty';
import { z } from 'zod';
import { InventoryStore } from './store';
import { ProviderStore, type SecretEncryption } from './providers';
import { SshAuthentication, sshEnvironment } from './ssh-auth';
import { BrowserLoginManager, isAuthorizationLink } from './login-browser';
import type { LoginNetworkCheck } from './login-network';
import { sshArgs,runRemote,uploadFile,remoteHome,shellQuote,listSshAliases,sshExecutable,scpExecutable,closeSshChannels,prepareRemoteRuntime,remoteLaunchCommand,remoteCommandArguments } from './ssh';
import {prepareWindowsMutagen} from './windows-mutagen';
import { LocalMcpBridge,remoteBridgePort } from './mcp';
import { WorkspaceSync } from './sync';
import { MutagenCli } from './sync/mutagen';
import type { SshPreparation } from './sync/transport';
import { BridgeTunnels, type TunnelLease } from './tunnel';
import { HistoryImporter,listLocalHistory } from './history';
import { GitWorkspace } from './git';
import { ProjectMemoryImporter } from './memory';
import { ClipboardImageUploader, terminalPaste, validateClipboardPng, type ClipboardContent } from './clipboard';
import type { TerminalPasteRequest, TerminalPasteResult, WorkspaceMode, ConnectionState, ServerMetrics, OpenSessionState, BrowserLoginState } from '../shared/types';
import { emptySync, type SyncState,type AppState,type AppEvent,type ServiceNode,type SessionInfo,type Workspace,type ActivityEvent,type NodeInput,type ImportRequest,type PortForward,type ProviderInput } from '../shared/types';

const metricsSchema=z.object({hostname:z.string(),os:z.string(),cpuCount:z.number().int().min(1),load:z.number().min(0),memoryTotal:z.number().min(0),memoryAvailable:z.number().min(0),diskAvailable:z.number().min(0),uptime:z.number().min(0),claudeVersion:z.string().nullable(),authenticated:z.boolean(),address:z.string(),gitHead:z.string().regex(/^[a-f0-9]{40,64}$/).nullable().optional(),sampledAt:z.string()});
interface ControllerOptions {
  dataDir:string;resourcesDir:string;token:string;emit:(event:AppEvent)=>void;
  encryption?:SecretEncryption;
  checkLoginNetwork?:(proxyPort:number,signal:AbortSignal)=>Promise<LoginNetworkCheck>;
  readClipboard?:()=>ClipboardContent|Promise<ClipboardContent>;
  pickDirectory:()=>Promise<string|null>;openLocal:(path:string)=>Promise<void>;openURL:(url:string)=>Promise<void>;
}

const TERMINAL_SCROLLBACK=512000;
/** Scrollback kept as chunks so a PTY read costs O(chunk) instead of copying the whole 512 KB tail. */
class TerminalBuffer {
  private chunks:string[]=[];private size=0;private joined:string|undefined='';
  /** Characters appended since the last clear; terminal events carry it so a late reader can splice output exactly. */
  total=0;
  append(data:string){this.total+=data.length;this.chunks.push(data);this.size+=data.length;this.joined=undefined;while(this.chunks.length>1&&this.size-this.chunks[0].length>=TERMINAL_SCROLLBACK)this.size-=this.chunks.shift()!.length;}
  clear(){this.chunks=[];this.size=0;this.total=0;this.joined='';}
  toString(){if(this.joined===undefined){const text=this.chunks.join('');this.joined=text.length>TERMINAL_SCROLLBACK?text.slice(-TERMINAL_SCROLLBACK):text;this.chunks=[this.joined];this.size=this.joined.length;}return this.joined;}
}
interface WorkspaceSetup {generation:number;abort:AbortController;promise:Promise<void>;failed:boolean;runtime:{helperPath:string;configPath:string}}
/** One open session: its own PTY, scrollback, retry state and workspace readiness. */
interface Slot {
  session:SessionInfo;node:ServiceNode;workspace?:Workspace;generation:number;connection:ConnectionState;
  terminal?:pty.IPty;buffer:TerminalBuffer;metrics:ServerMetrics|null;preparation?:NonNullable<AppState['workspacePreparation']>;
  setup?:WorkspaceSetup;readyWaiter?:{generation:number;resolve:()=>void;reject:(error:Error)=>void};
  retryTimer?:ReturnType<typeof setTimeout>;healthTimer?:ReturnType<typeof setTimeout>;
  cols:number;rows:number;tunnel?:TunnelLease;unread:boolean;pasting?:number;
}
/** File and Git synchronization of one workspace, shared by every open session that uses it. */
interface WorkspaceRuntime {
  id:string;sync:WorkspaceSync;state:SyncState;epoch:number;ensuring?:Promise<SyncState>;gitBaseline?:Promise<boolean>;
  git?:NonNullable<SyncState['git']>;gitSynchronization?:{epoch:number;promise:Promise<void>};
  nextGitCheck:number;lastGitCheck:number;knownRemoteHead?:string|null;
}
interface AttachOptions {waitForReady?:boolean;focus?:boolean}

export class AppController {
  readonly store:InventoryStore;
  readonly providers:ProviderStore;
  readonly sshAuthentication:SshAuthentication;
  readonly loginBrowser:BrowserLoginManager;
  readonly bridge:LocalMcpBridge;
  private readonly mutagen:MutagenCli;
  private readonly tunnels:BridgeTunnels;
  private readonly prepareSsh:(node:ServiceNode)=>Promise<SshPreparation>;
  private importer:HistoryImporter;
  private imageUploader:ClipboardImageUploader;
  private git:GitWorkspace;
  private runtimes=new Map<string,WorkspaceRuntime>();
  private slots=new Map<string,Slot>();
  private focusId:string|undefined;
  private idle:ConnectionState={phase:'disconnected',message:'',retryAttempt:0};
  private lastPublish=0;
  private publishTimer:ReturnType<typeof setTimeout>|undefined;
  private state:{activities:ActivityEvent[];browserLogin?:BrowserLoginState;version:string}={activities:[],version:'0.1.0'};
  private bridgePort=0;
  private generation=0;
  private terminalCols=100;
  private terminalRows=32;
  private seenEvents=new Set<string>();
  private forwards=new Map<string,{process:ChildProcess,forward:PortForward}>();
  private switchingProvider=false;
  private switchingWorkspaceMode=false;
  private loginStarting=false;
  private loginContext:{nodeId:string;sessionId:string;returnSessionId?:string;workspaceId?:string;attemptId:string;completing?:boolean;hookOpened?:boolean;pendingResult?:Record<string,unknown>}|undefined;
  constructor(private options:ControllerOptions){
    this.store=new InventoryStore(options.dataDir,options.encryption);
    this.sshAuthentication=new SshAuthentication({...options,store:this.store,sshExecutable:sshExecutable(),scpExecutable:scpExecutable()});
    this.providers=new ProviderStore(options.dataDir,options.encryption);
    this.loginBrowser=new BrowserLoginManager({dataDir:options.dataDir,checkNetwork:options.checkLoginNetwork,onState:state=>{this.state.browserLogin=state;this.publish();}});
    const binary=process.platform==='win32'?'mutagen.exe':'mutagen';
    const mutagenPath=process.env.HAPPYPANDA_MUTAGEN_PATH??[join(options.resourcesDir,'../tools',binary),join(options.resourcesDir,'../.local/tools',binary)].find(existsSync);
    // Every workspace synchronizer talks to the same isolated daemon.
    this.mutagen=new MutagenCli({dataDir:options.dataDir,mutagenPath,restartDaemonOnTransportChange:true});
    this.prepareSsh=async(node:ServiceNode)=>{const transport=await this.sshAuthentication.prepare(node);await prepareWindowsMutagen(node,options.dataDir,options.resourcesDir);return {target:node.sshTarget,user:node.user,port:node.port,mutagenSshPath:transport,scpPath:scpExecutable(),managesIdentity:true};};
    this.tunnels=new BridgeTunnels(()=>this.bridgePort);
    this.git=new GitWorkspace(options.dataDir);
    this.bridge=new LocalMcpBridge({token:options.token,dataDir:options.dataDir,
      resolveWorkspace:id=>this.workspaceSlots(id).length?this.store.workspaces.find(workspace=>workspace.id===id):undefined,
      onActivity:event=>this.activity(event),onRemoteEvent:payload=>this.remoteEvent(payload),
      beforeOperation:async id=>{
        const connected=this.workspaceSlots(id).filter(slot=>slot.connection.phase==='connected');
        if(!connected.length)throw new Error('Workspace is not connected');
        if(!connected.some(slot=>!slot.preparation||slot.preparation.phase==='ready'))throw new Error('工作区尚未准备完成，请等待同步或处理同步错误。');
        if(this.store.workspace(id).mode==='mcp-only')return;
        const runtime=this.runtimes.get(id);
        if(runtime&&runtime.state.phase!=='none'){const sync=await runtime.sync.flush();if(sync.phase!=='ready')throw new Error('Workspace synchronization is not ready');}
      },
      afterOperation:async (id,info)=>{
        if(!this.workspaceSlots(id).length)throw new Error('Command finished in an inactive workspace; reconnect that workspace before using its artifacts');
        if(this.store.workspace(id).mode==='mcp-only'||info?.mutates===false)return;
        const runtime=this.runtimes.get(id);
        if(runtime&&runtime.state.phase!=='none'){const sync=await runtime.sync.flush();if(sync.phase!=='ready')throw new Error('Command finished; resulting files are awaiting synchronization');}
      },
    });
    this.importer=new HistoryImporter({dataDir:options.dataDir,runRemote,uploadFile});
    this.imageUploader=new ClipboardImageUploader(options.resourcesDir);
  }
  async initialize(){await this.store.load();await this.providers.load();await this.sshAuthentication.start();for(const node of this.store.nodes)if(node.authType==='password')await this.sshAuthentication.prepare(node);const bridge=await this.bridge.start();this.bridgePort=bridge.port;this.publish();}
  private focused():Slot|undefined{return this.focusId?this.slots.get(this.focusId):undefined;}
  focusedSessionId(){return this.focusId;}
  private workspaceSlots(workspaceId:string){return [...this.slots.values()].filter(slot=>slot.workspace?.id===workspaceId);}
  private current(slot:Slot,generation:number){return this.slots.get(slot.session.id)===slot&&slot.generation===generation;}
  private runtime(workspace:Workspace):WorkspaceRuntime{
    let runtime=this.runtimes.get(workspace.id);
    if(!runtime){
      const created={id:workspace.id,state:emptySync(),epoch:0,nextGitCheck:0,lastGitCheck:0} as WorkspaceRuntime;
      created.sync=new WorkspaceSync({dataDir:this.options.dataDir,runRemote,uploadFile,prepareSsh:this.prepareSsh,cli:this.mutagen,
        onWorkspaceUpdated:async()=>{await this.store.save();this.publish();},onState:state=>this.syncStateChanged(created,state),onActivity:event=>this.activity(event)});
      this.runtimes.set(workspace.id,runtime=created);
    }
    return runtime;
  }
  /** Exposes a workspace's synchronizer for smoke tests and tooling. */
  workspaceSync(workspaceId:string){return this.runtime(this.store.workspace(workspaceId)).sync;}
  private syncStateChanged(runtime:WorkspaceRuntime,state:SyncState){
    if(this.store.workspaces.find(workspace=>workspace.id===runtime.id)?.mode==='mcp-only')return;
    const slots=this.workspaceSlots(runtime.id);
    const previous=JSON.stringify([{...runtime.state,updatedAt:''},slots.map(slot=>slot.preparation)]);
    runtime.state=state;
    for(const slot of slots){
      const preparation=slot.preparation;
      if(preparation&&['syncing','error'].includes(preparation.phase)&&slot.setup&&!slot.setup.failed){
        preparation.phase=['error','conflict','paused','disconnected'].includes(state.phase)?'error':'syncing';
        preparation.message=preparation.phase==='error'?state.message:'正在同步工作区；首次使用将在就绪后启动会话。';
      }
    }
    // Status polling reports an unchanged state every few seconds; don't re-render for it.
    if(JSON.stringify([{...runtime.state,updatedAt:''},slots.map(slot=>slot.preparation)])!==previous)this.publish();
    // Remote HEAD arrives with server metrics, so SSH is only needed when it changed,
    // after a tool that can commit, or as a slow safety net.
    if(state.phase==='ready'&&(runtime.nextGitCheck===0||Date.now()-runtime.lastGitCheck>60000))void this.syncGitCommits(runtime,false);
  }
  private syncView(slot:Slot|undefined):SyncState{
    const workspace=slot?.workspace;
    const runtime=workspace&&workspace.mode!=='mcp-only'?this.runtimes.get(workspace.id):undefined;
    return runtime?{...runtime.state,git:runtime.git}:emptySync();
  }
  private openSession(slot:Slot):OpenSessionState{
    return {sessionId:slot.session.id,nodeId:slot.node.id,workspaceId:slot.workspace?.id,title:slot.session.title,kind:slot.session.kind,phase:slot.connection.phase,message:slot.connection.message,generation:slot.generation,unread:slot.unread};
  }
  /** `connection`, terminal, metrics and sync fields describe the focused session; `openSessions` lists all of them. */
  snapshot(includeTerminal=true):AppState {
    const slot=this.focused();
    return structuredClone({activities:this.state.activities,browserLogin:this.state.browserLogin,version:this.state.version,
      connection:slot?slot.connection:this.idle,metrics:slot?.metrics??null,sync:this.syncView(slot),workspacePreparation:slot?.preparation,
      terminalBuffer:includeTerminal&&slot?slot.buffer.toString():'',terminalSize:{cols:slot?.cols??this.terminalCols,rows:slot?.rows??this.terminalRows},
      terminalGeneration:slot?.generation??this.generation,openSessions:[...this.slots.values()].map(item=>this.openSession(item)),
      nodes:this.store.nodes,providers:this.providers.list(),workspaces:this.store.workspaces,sessions:this.store.sessions,portForwards:[...this.forwards.values()].map(entry=>entry.forward)});
  }
  getTerminalBuffer(sessionId:string){const slot=this.slots.get(sessionId);return {generation:slot?.generation??0,data:slot?.buffer.toString()??'',end:slot?.buffer.total??0};}
  // State events omit the (up to 512 KB) terminal scrollback: output already streams
  // as 'terminal' events and the renderer keeps its own copy; getState returns it whole.
  private publish(){
    const wait=this.lastPublish+40-Date.now();
    if(wait>0){this.publishTimer??=setTimeout(()=>{this.publishTimer=undefined;this.publish();},wait);return;}
    this.lastPublish=Date.now();
    this.options.emit({type:'state',state:this.snapshot(false)});
  }
  /** The focused session changed: single-terminal views (the phone) redraw from its scrollback. */
  private publishFocus(){
    if(this.publishTimer)clearTimeout(this.publishTimer);
    this.publishTimer=undefined;this.lastPublish=Date.now();
    this.options.emit({type:'state',state:this.snapshot(true),resetTerminal:true});
  }
  private activity(input:Omit<ActivityEvent,'id'|'time'>){
    const activity:ActivityEvent={...input,id:randomUUID(),time:new Date().toISOString()};
    this.state.activities=[activity,...this.state.activities].slice(0,150);
    this.options.emit({type:'activity',activity});
  }
  private remoteEvent(payload:Record<string,unknown>){
    const slot=typeof payload.sessionId==='string'?this.slots.get(payload.sessionId):undefined;
    // Sessions whose tab was closed keep running in tmux; their events still count while the node is open.
    if(slot?slot.node.id!==payload.nodeId:![...this.slots.values()].some(item=>item.node.id===payload.nodeId))return;
    if(payload.type==='login-url'&&typeof payload.url==='string'&&this.loginContext&&payload.sessionId===this.loginContext.sessionId&&payload.attemptId===this.loginContext.attemptId){
      if(this.loginContext.hookOpened)return;
      const context=this.loginContext;context.hookOpened=true;
      void this.openLoginLink(payload.url).catch(()=>{if(this.loginContext===context)context.hookOpened=false;this.activity({kind:'error',title:'登录浏览器未能打开，请点击终端中的授权链接或重新登录。'});});return;
    }
    if(payload.type==='login-result'){void this.completeLogin(payload).catch(()=>this.activity({kind:'error',title:'登录完成后的会话恢复失败，请重新连接。'}));return;}
    if(payload.type==='metrics'){const metrics=metricsSchema.safeParse(payload.metrics);if(slot&&metrics.success){
      slot.metrics=metrics.data;
      const head=metrics.data.gitHead,runtime=slot.workspace?this.runtimes.get(slot.workspace.id):undefined;
      if(runtime&&head&&head!==runtime.knownRemoteHead){runtime.knownRemoteHead=head;runtime.nextGitCheck=0;void this.syncGitCommits(runtime,false);}
      if(slot.session.id===this.focusId)this.publish();
    }return;}
    if(payload.type!=='tool'||typeof payload.id!=='string'||this.seenEvents.has(payload.id))return;
    this.seenEvents.add(payload.id);if(this.seenEvents.size>2000)this.seenEvents.delete(this.seenEvents.values().next().value!);
    const event=String(payload.event??'');
    if(!['PostToolUse','UserPromptSubmit','Stop','SessionStart','Notification'].includes(event))return;
    const workspaceId=typeof payload.workspaceId==='string'?payload.workspaceId:undefined;
    this.activity({kind:'tool',title:event==='PostToolUse'?String(payload.tool??'Tool')+' completed':event==='UserPromptSubmit'?'Prompt submitted':event==='Stop'?'Claude turn completed':event,
      detail:typeof payload.path==='string'?payload.path:undefined,location:'remote',sessionId:String(payload.sessionId??''),workspaceId});
    const runtime=this.runtimes.get(slot?.workspace?.id??workspaceId??'');
    if(runtime&&(event==='Stop'||(event==='PostToolUse'&&payload.tool==='Bash'))){runtime.nextGitCheck=0;void this.syncGitCommits(runtime,false);}
  }
  async saveNode(input:NodeInput){const node=await this.store.saveNode(input);if(node.authType==='password')await this.sshAuthentication.prepare(node);else this.sshAuthentication.register(node);closeSshChannels();this.publish();return node;}
  async saveProvider(input:ProviderInput){
    if(this.switchingProvider)throw new Error('正在切换提供商，请稍后再试。');
    this.switchingProvider=true;
    try{const provider=await this.providers.save(input);this.publish();return provider;}finally{this.switchingProvider=false;}
  }
  async removeProvider(id:string){
    if(this.switchingProvider)throw new Error('正在切换提供商，请稍后再试。');
    if(this.store.nodes.some(node=>node.providerId===id))throw new Error('请先为使用此提供商的服务器切换配置，再删除。');
    this.switchingProvider=true;
    try{await this.providers.remove(id);this.publish();}finally{this.switchingProvider=false;}
  }
  async selectProvider(nodeId:string,providerId:string|null){
    if(this.switchingWorkspaceMode)throw new Error('正在切换工作区模式，请稍后再试。');
    if(this.switchingProvider)throw new Error('正在切换提供商，请稍后再试。');
    if(providerId!==null&&typeof providerId!=='string')throw new Error('无效的提供商。');
    const node=this.store.node(nodeId);
    this.providers.configuration(providerId??undefined);
    const open=[...this.slots.values()].filter(slot=>slot.node.id===nodeId);
    if(open.some(slot=>['preparing','connecting','retrying'].includes(slot.connection.phase)))throw new Error('请等待当前连接完成后再切换提供商。');
    const generations=new Map(open.map(slot=>[slot,slot.generation]));
    this.switchingProvider=true;
    try{
      const previous=node.providerId;
      node.providerId=providerId??undefined;
      try{await this.store.save();}catch(error){node.providerId=previous;throw error;}
      this.publish();
      if(open.length){
        if(open.some(slot=>!this.current(slot,generations.get(slot)!)))throw new Error('提供商已保存，连接已变更，请重新连接后应用。');
        // Every open Claude session on the node switches together; background tabs stay in the background.
        const reloads=open.filter(slot=>slot.session.kind==='claude').map(slot=>({session:slot.session,workspace:slot.workspace,focus:slot.session.id===this.focusId}));
        if(!reloads.length){const base=open.find(slot=>slot.session.id===this.focusId)??open[0];reloads.push({session:this.createSession(node,base.workspace),workspace:base.workspace,focus:true});}
        const results=await Promise.allSettled(reloads.map(item=>{item.session.reloadToken=randomUUID();return this.attach(node,item.workspace,item.session,{waitForReady:true,focus:item.focus});}));
        if(results.some(result=>result.status==='rejected'))throw new Error('提供商已保存，但 Claude 重载未完成。请查看连接状态并重新连接。');
        const name=this.providers.list().find(item=>item.id===providerId)?.name??'官方账号';
        for(const item of reloads)this.activity({kind:'session',title:'Claude 已按提供商配置重载',detail:name,sessionId:item.session.id});
      }
    }finally{this.switchingProvider=false;}
  }
  async removeNode(id:string){
    this.store.node(id);
    await Promise.all([...this.slots.values()].filter(slot=>slot.node.id===id).map(slot=>this.closeSlot(slot)));
    this.store.nodes=this.store.nodes.filter(node=>node.id!==id);this.store.workspaces=this.store.workspaces.filter(workspace=>workspace.nodeId!==id);this.store.sessions=this.store.sessions.filter(session=>session.nodeId!==id);await this.store.save();this.publishFocus();
  }
  listAliases(){return listSshAliases();}
  async chooseWorkspace(nodeId:string,mode:WorkspaceMode='sync'){
    if(!['sync','mcp-only'].includes(mode))throw new Error('Invalid workspace mode');
    const node=this.store.node(nodeId);const selected=await this.options.pickDirectory();if(!selected)return null;
    const localPath=await realpath(selected);let workspace=this.store.workspaces.find(item=>item.nodeId===nodeId&&item.localPath===localPath);
    if(!workspace){const id=randomUUID();const home=await remoteHome(node);workspace={id,nodeId,name:basename(localPath),localPath,remotePath:posix.join(home,'.local/share/happypanda/workspaces',id),mode,localAccess:mode==='mcp-only',syncSessionName:'hp-'+id.replaceAll('-',''),createdAt:new Date().toISOString()};this.store.workspaces.push(workspace);}
    else if((workspace.mode??'sync')!==mode)await this.setWorkspaceMode(workspace.id,mode);
    node.lastWorkspaceId=workspace.id;await this.store.save();this.publish();return workspace;
  }
  async setWorkspaceMode(workspaceId:string,mode:WorkspaceMode){
    if(!['sync','mcp-only'].includes(mode))throw new Error('Invalid workspace mode');
    if(this.switchingWorkspaceMode||this.switchingProvider||this.loginStarting)throw new Error('正在更新会话，请稍后再切换工作区模式。');
    const workspace=this.store.workspace(workspaceId);
    if((workspace.mode??'sync')===mode)return;
    const open=this.workspaceSlots(workspaceId);
    if(open.some(slot=>slot.session.kind==='login'))throw new Error('请结束账号登录后再切换工作区模式。');
    const generations=new Map(open.map(slot=>[slot,slot.generation]));
    this.switchingWorkspaceMode=true;
    try{
      const previous={mode:workspace.mode,localAccess:workspace.localAccess};
      workspace.mode=mode;if(mode==='mcp-only')workspace.localAccess=true;
      try{await this.store.save();}catch(error){Object.assign(workspace,previous);throw error;}
      this.publish();
      if(open.length){
        if(open.some(slot=>!this.current(slot,generations.get(slot)!)))throw new Error('模式已保存，连接已变更，请重新连接后应用。');
        const results=await Promise.allSettled(open.map(slot=>{slot.session.reloadToken=randomUUID();return this.attach(this.store.node(workspace.nodeId),workspace,slot.session,{waitForReady:true,focus:slot.session.id===this.focusId});}));
        const failure=results.find(result=>result.status==='rejected');
        if(failure)throw new Error('工作区模式已保存，但会话重载未完成，请重新连接。',{cause:failure.reason});
      }
      this.activity({kind:'connection',title:mode==='mcp-only'?'已切换为仅本机 MCP':'已切换为双向同步',workspaceId,location:'local'});
    }finally{this.switchingWorkspaceMode=false;}
  }
  async setLocalAccess(workspaceId:string,enabled:boolean){const workspace=this.store.workspace(workspaceId);if(workspace.mode==='mcp-only'&&!enabled)throw new Error('仅本机 MCP 模式必须开启本机 MCP。');workspace.localAccess=enabled;await this.store.save();this.activity({kind:'connection',title:enabled?'Local MCP access enabled':'Local MCP access disabled',workspaceId,location:'local'});this.publish();}
  private createSession(node:ServiceNode,workspace:Workspace|undefined,kind:SessionInfo['kind']='claude',transcriptPath?:string){
    const id=randomUUID();const now=new Date().toISOString();const session:SessionInfo={id,nodeId:node.id,workspaceId:workspace?.id,title:kind==='login'?'Account login':kind==='shell'?'Remote shell':workspace?.name??'Claude Code',tmuxName:'hp-'+id.replaceAll('-',''),createdAt:now,lastActiveAt:now,kind,transcriptPath};this.store.sessions.unshift(session);return session;
  }
  /** Forget a session and end its tmux session on the server (best effort). */
  async removeSession(id:string){
    if(typeof id!=='string')throw new Error('Invalid session');
    const session=this.store.sessions.find(item=>item.id===id);
    if(!session)throw new Error('Session not found');
    if(this.slots.has(id))throw new Error('请先关闭该会话的标签页，再删除会话。');
    const node=this.store.nodes.find(item=>item.id===session.nodeId);
    this.store.sessions=this.store.sessions.filter(item=>item.id!==id);
    if(node?.lastSessionId===id)node.lastSessionId=undefined;
    await this.store.save();this.publish();
    if(node&&/^hp-[a-f0-9]+$/.test(session.tmuxName)){
      try{
        const runtime=await prepareRemoteRuntime(node);
        const command=runtime.platform==='windows'?'python3 -c '+shellQuote('import pathlib,runpy,sys;p=pathlib.Path.home()/".local/share/happypanda/runtime"/'+JSON.stringify(session.id)+'/"bridge.json";sys.argv=[str(p.parent.parent.parent/"hp_remote.py"),"stop",str(p)];runpy.run_path(sys.argv[0],run_name="__main__")'):
          'tmux -L happypanda kill-session -t '+shellQuote(session.tmuxName)+' 2>/dev/null; true';
        await runRemote(node,command);
      }catch{/* Removing local history remains possible when the remote node is unavailable. */}
    }
  }
  /** Opens a session in a new tab, or focuses its tab when it is already running. */
  async connect(nodeId:string,workspaceId?:string,sessionId?:string){
    if(this.switchingWorkspaceMode)throw new Error('正在切换工作区模式，请稍后再连接。');
    if(this.switchingProvider)throw new Error('正在更新提供商，请稍后再连接。');
    const node=this.store.node(nodeId);
    let session=sessionId?this.store.sessions.find(item=>item.id===sessionId):undefined;
    if(sessionId&&!session)throw new Error('Session not found');
    if(session&&workspaceId!==undefined&&session.workspaceId!==workspaceId)throw new Error('Session belongs to another workspace');
    const requestedWorkspace=session?session.workspaceId:workspaceId??node.lastWorkspaceId;
    const workspace=requestedWorkspace?this.store.workspace(requestedWorkspace):undefined;
    if(workspace&&workspace.nodeId!==nodeId)throw new Error('Workspace belongs to another node');
    if(session&&(session.nodeId!==nodeId||session.workspaceId!==workspace?.id))throw new Error('Session belongs to another workspace');
    if(!session)session=[...this.slots.values()].find(slot=>slot.node.id===nodeId&&slot.workspace?.id===workspace?.id&&slot.session.kind==='claude')?.session
      ??this.store.sessions.find(item=>item.id===node.lastSessionId&&item.workspaceId===workspace?.id&&item.kind==='claude');
    if(!session)session=this.createSession(node,workspace);
    const open=this.slots.get(session.id);
    if(open&&open.connection.phase!=='failed'){this.focusSession(session.id);return;}
    await this.attach(node,workspace,session);
  }
  /** Restarts the focused session's terminal, even when it is still connected. */
  async reconnect(){
    if(this.switchingWorkspaceMode||this.switchingProvider)throw new Error('正在更新会话，请稍后再重新连接。');
    const slot=this.focused();if(!slot)throw new Error('没有需要重新连接的会话。');
    await this.attach(this.store.node(slot.node.id),slot.workspace&&this.store.workspace(slot.workspace.id),slot.session);
  }
  focusSession(sessionId:string){
    if(typeof sessionId!=='string')throw new Error('Invalid session');
    const slot=this.slots.get(sessionId);if(!slot)throw new Error('会话未打开，请从会话列表重新打开。');
    if(this.focusId===sessionId)return;
    this.focusId=sessionId;slot.unread=false;
    if(slot.session.kind!=='login')slot.node.lastSessionId=sessionId;
    slot.node.lastWorkspaceId=slot.workspace?.id;slot.session.lastActiveAt=new Date().toISOString();this.store.saveSoon();
    this.publishFocus();
  }
  /** Closes one tab. Claude keeps running in tmux on the server and can be reopened from the session list. */
  async closeSession(sessionId:string){
    if(typeof sessionId!=='string')throw new Error('Invalid session');
    const slot=this.slots.get(sessionId);if(!slot)return;
    if(this.loginContext?.sessionId===sessionId){this.loginContext=undefined;this.loginBrowser.block();}
    const released=this.closeSlot(slot);
    this.publishFocus();
    await released;
  }
  async newSession(kind:SessionInfo['kind']='claude'){
    if(this.switchingWorkspaceMode)throw new Error('正在切换工作区模式，请稍后再新建会话。');
    if(this.switchingProvider)throw new Error('正在更新提供商，请稍后再新建会话。');
    if(this.loginStarting)throw new Error('正在准备登录，请稍后再试。');
    if(!['claude','login','shell'].includes(kind))throw new Error('Invalid session type');
    if(kind==='login'){await this.startLogin();return;}
    const focused=this.focused();if(!focused)throw new Error('请先连接服务器。');
    await this.attach(focused.node,focused.workspace,this.createSession(focused.node,focused.workspace,kind));
  }
  private async startLogin(){
    const focused=this.focused();
    if(!focused||focused.connection.phase!=='connected')throw new Error('请先连接服务器，再发起登录。');
    const node=focused.node,workspace=focused.workspace,generation=focused.generation;
    if(node.providerId)throw new Error('请先在 API 提供商中选择官方账号，再发起官方登录。');
    const previous=this.loginContext?.returnSessionId??focused.session.id;
    const returnSessionId=this.store.sessions.find(item=>item.id===previous&&item.kind==='claude')?.id;
    const replaced=this.loginContext?.sessionId;
    let attemptId:string|undefined;
    this.loginStarting=true;
    try{
      await this.loginBrowser.prepare(node);
      if(!this.current(focused,generation))throw new Error('登录已取消。');
      const session=this.createSession(node,workspace,'login');session.reloadToken=attemptId=randomUUID();
      node.loginViaNode=true;
      // A new attempt replaces the previous login tab instead of leaving a stale one open.
      const stale=replaced?this.slots.get(replaced):undefined;if(stale)await this.closeSlot(stale);
      this.loginContext={nodeId:node.id,sessionId:session.id,workspaceId:workspace?.id,returnSessionId,attemptId};
      await this.attach(node,workspace,session,{waitForReady:true});
    }catch(error){if(!attemptId||this.loginContext?.attemptId===attemptId){this.loginContext=undefined;this.loginBrowser.block('登录未能启动，浏览器连接已阻断。');}throw error;}
    finally{this.loginStarting=false;const result=this.loginContext?.pendingResult;if(result){this.loginContext!.pendingResult=undefined;void this.completeLogin(result).catch(()=>this.activity({kind:'error',title:'登录完成后的会话恢复失败，请重新连接。'}));}}
  }
  private async openLoginLink(url:string){
    const context=this.loginContext;
    if(!context||!this.slots.has(context.sessionId))throw new Error('请通过当前服务器重新发起登录。');
    await this.loginBrowser.openAuthorization(context.nodeId,url);
  }
  private async completeLogin(payload:Record<string,unknown>){
    const context=this.loginContext;
    if(!context||context.completing||payload.sessionId!==context.sessionId||payload.attemptId!==context.attemptId||!this.slots.has(context.sessionId))return;
    if(this.loginStarting){context.pendingResult=payload;return;}
    context.completing=true;
    if(payload.success!==true||!this.loginBrowser.snapshot().routeVerified){this.loginBrowser.fail('官方登录未完成，请通过当前服务器重新登录。');return;}
    this.loginBrowser.authenticated();
    this.activity({kind:'session',title:'官方账号登录成功，正在恢复 Claude 会话。',sessionId:context.sessionId});
    const node=this.store.node(context.nodeId),workspace=context.workspaceId?this.store.workspace(context.workspaceId):undefined;
    const session=this.store.sessions.find(item=>item.id===context.returnSessionId)??this.createSession(node,workspace);
    session.reloadToken=randomUUID();this.loginContext=undefined;
    await this.attach(node,workspace,session,{waitForReady:true});
    if(context.sessionId!==session.id){
      const login=this.slots.get(context.sessionId);if(login)await this.closeSlot(login);
      this.publish();
      void this.removeSession(context.sessionId).catch(()=>undefined);
    }
  }
  private closeTerminal(slot:Slot){slot.readyWaiter?.reject(new Error('重载已取消。'));slot.readyWaiter=undefined;if(slot.retryTimer)clearTimeout(slot.retryTimer);if(slot.healthTimer)clearTimeout(slot.healthTimer);slot.retryTimer=undefined;slot.healthTimer=undefined;const terminal=slot.terminal;slot.terminal=undefined;try{terminal?.kill();}catch{}}
  /** Ends a tab's terminal and releases what only it used. Focus moves to a neighbouring tab. */
  private closeSlot(slot:Slot):Promise<void>{
    const id=slot.session.id;
    if(this.slots.get(id)!==slot)return Promise.resolve();
    if(this.focusId===id){const order=[...this.slots.keys()],index=order.indexOf(id);this.focusId=order[index+1]??order[index-1];}
    this.slots.delete(id);
    if(this.focusId===id)this.focusId=undefined;
    slot.setup?.abort.abort();slot.setup=undefined;
    this.closeTerminal(slot);slot.tunnel?.release();slot.tunnel=undefined;
    return this.releaseWorkspace(slot.workspace);
  }
  /** Pause a workspace's mirror once no open session uses it; results of in-flight Git checks become stale. */
  private async releaseWorkspace(workspace:Workspace|undefined){
    if(!workspace||this.workspaceSlots(workspace.id).length)return;
    const runtime=this.runtimes.get(workspace.id);if(!runtime)return;
    runtime.epoch++;runtime.git=undefined;runtime.nextGitCheck=0;runtime.knownRemoteHead=undefined;
    await runtime.sync.pause();
  }
  private async attach(node:ServiceNode,workspace:Workspace|undefined,session:SessionInfo,{waitForReady=false,focus=true}:AttachOptions={}){
    if((this.loginContext&&this.loginContext.sessionId!==session.id)||(this.state.browserLogin?.nodeId&&this.state.browserLogin.nodeId!==node.id)||node.providerId){this.loginContext=undefined;this.loginBrowser.block();}
    const generation=++this.generation;
    let slot=this.slots.get(session.id);
    const previousSetup=slot?.setup;
    if(slot){previousSetup?.abort.abort();slot.setup=undefined;this.closeTerminal(slot);}
    else{slot={session,node,workspace,generation,connection:this.idle,buffer:new TerminalBuffer(),metrics:null,cols:this.terminalCols,rows:this.terminalRows,unread:false};this.slots.set(session.id,slot);}
    const mcpOnly=workspace?.mode==='mcp-only';
    Object.assign(slot,{session,node,workspace,generation,metrics:null,unread:false,
      connection:{phase:'preparing',message:'Preparing workspace',retryAttempt:0,activeNodeId:node.id,activeWorkspaceId:workspace?.id,activeSessionId:session.id},
      preparation:workspace?{workspaceId:workspace.id,phase:'syncing',message:mcpOnly?'正在连接本机 MCP…':'正在同步工作区；首次使用将在就绪后启动会话。'}:undefined});
    slot.buffer.clear();
    if(workspace&&!mcpOnly){const runtime=this.runtime(workspace);runtime.nextGitCheck=0;runtime.knownRemoteHead=undefined;}
    if(focus||!this.focused())this.focusId=session.id;
    const focused=this.focusId===session.id;
    if(focused){if(session.kind!=='login')node.lastSessionId=session.id;node.lastWorkspaceId=workspace?.id;this.publishFocus();}
    else this.publish();
    session.lastActiveAt=new Date().toISOString();this.store.saveSoon();
    const target=slot;
    try{
      if(mcpOnly){
        await previousSetup?.promise;await this.runtimes.get(workspace!.id)?.gitSynchronization?.promise;
        await this.runtime(workspace!).sync.pause();
        if(!this.current(target,generation)){if(waitForReady)throw new Error('重载已取消。');return;}
        target.preparation={workspaceId:workspace!.id,phase:'ready',message:'本机 MCP 已就绪'};
      }
      if(!this.current(target,generation)){if(waitForReady)throw new Error('重载已取消。');return;}
      await this.openPty(target,generation,0,waitForReady);
    }catch(error){
      if(this.current(target,generation)){target.connection.phase='failed';target.connection.message=(error as Error).message;if(mcpOnly&&workspace)target.preparation={workspaceId:workspace.id,phase:'error',message:(error as Error).message};this.activity({kind:'error',title:'Connection failed',detail:(error as Error).message,sessionId:session.id});this.publish();}
      if(waitForReady)throw error;
    }
  }
  private async bootstrap(node:ServiceNode,workspace:Workspace|undefined,session:SessionInfo){
    const runtime=await prepareRemoteRuntime(node);
    const bootstrap=await readFile(join(this.options.resourcesDir,'bootstrap.py'),'utf8');
    const helper=await readFile(join(this.options.resourcesDir,'hp_remote.py'));
    const remotePort=remoteBridgePort(node.id,this.options.token);
    const provider=session.kind==='claude'?this.providers.configuration(node.providerId):undefined;
    const mcpOnly=workspace?.mode==='mcp-only';
    const config={nodeId:node.id,sessionId:session.id,workspaceId:workspace?.id,workspaceMode:workspace?.mode??'sync',localPath:mcpOnly?workspace.localPath:undefined,localPlatform:mcpOnly?process.platform:undefined,remotePath:mcpOnly?undefined:workspace?.remotePath,kind:session.kind,tmuxName:session.tmuxName,sshTarget:node.sshTarget,remotePort,token:this.options.token,transcriptPath:session.transcriptPath,provider,reloadToken:session.reloadToken,nodeEgress:session.kind==='login'||Boolean(node.loginViaNode&&!node.providerId),loginAttempt:session.kind==='login'?session.reloadToken:undefined,waitForWorkspace:Boolean(workspace)&&!mcpOnly&&session.kind!=='login',platform:runtime.platform,nodeExecutable:runtime.node};
    const command='python3 -c '+shellQuote('import base64;exec(base64.b64decode('+JSON.stringify(Buffer.from(bootstrap).toString('base64'))+'))');
    const windowsRuntime=runtime.platform==='windows'?(await readFile(join(this.options.resourcesDir,'windows-runtime.json.gz'))).toString('base64'):undefined;
    const result=JSON.parse(await runRemote(node,command,JSON.stringify({helper:helper.toString('base64'),config,windowsRuntime})));
    if(typeof result.configPath!=='string'||typeof result.helperPath!=='string')throw new Error('Invalid remote bootstrap response');
    return {...result,remotePort};
  }
  // Sessions of one workspace share its Mutagen preparation and Git baseline; concurrent requests join the running one.
  private ensureWorkspace(runtime:WorkspaceRuntime,workspace:Workspace,node:ServiceNode){
    runtime.ensuring??=runtime.sync.ensure(workspace,node,{reuse:true}).finally(()=>{runtime.ensuring=undefined;});
    return runtime.ensuring;
  }
  private ensureGitBaseline(runtime:WorkspaceRuntime,workspace:Workspace,node:ServiceNode){
    runtime.gitBaseline??=this.git.bootstrap(workspace,node).finally(()=>{runtime.gitBaseline=undefined;});
    return runtime.gitBaseline;
  }
  private startWorkspaceSetup(slot:Slot,runtime:{helperPath:string;configPath:string},generation:number){
    if(slot.setup?.generation===generation&&!slot.setup.failed)return;
    slot.setup?.abort.abort();
    const workspace=slot.workspace!,node=slot.node,sync=this.runtime(workspace);
    const task:WorkspaceSetup={generation,abort:new AbortController(),promise:Promise.resolve(),failed:false,runtime};
    slot.setup=task;
    slot.preparation={workspaceId:workspace.id,phase:'syncing',message:'正在同步工作区；首次使用将在就绪后启动会话。'};this.publish();
    const current=()=>!task.abort.signal.aborted&&this.current(slot,generation);
    task.promise=(async()=>{
      try{
        const initial=await this.ensureWorkspace(sync,workspace,node);
        if(!current())return;
        if(initial.phase==='error')throw new Error(initial.message);
        await sync.sync.waitUntilReady(task.abort.signal,()=>workspace.syncSessionName);
        if(!current())return;
        slot.preparation={workspaceId:workspace.id,phase:'git',message:'文件已同步，正在准备项目版本信息…'};this.publish();
        if(await this.ensureGitBaseline(sync,workspace,node))this.activity({kind:'sync',title:'Remote Git baseline prepared',workspaceId:workspace.id});
        if(!current())return;
        await runRemote(node,'python3 '+shellQuote(runtime.helperPath)+' workspace-ready '+shellQuote(runtime.configPath));
        if(!current())return;
        slot.preparation={workspaceId:workspace.id,phase:'ready',message:'工作区已就绪'};this.publish();
        void this.syncGitCommits(sync,true);
      }catch(error){
        if(!current())return;
        task.failed=true;
        slot.preparation={workspaceId:workspace.id,phase:'error',message:(error as Error).message};this.publish();
        this.activity({kind:'error',title:'工作区准备失败，SSH 连接保持可用',detail:(error as Error).message,workspaceId:workspace.id});
      }
    })();
  }
  private async openPty(slot:Slot,generation:number,attempt:number,waitForReady=false){
    if(!this.current(slot,generation))return;
    const {node,workspace,session}=slot;
    slot.connection.phase=attempt?'retrying':'connecting';slot.connection.retryAttempt=attempt;slot.connection.message=attempt?'Reconnecting to existing session':'Starting secure terminal';this.publish();
    let bootstrap;
    try{
      bootstrap=await this.bootstrap(node,workspace,session);
      if(!this.current(slot,generation)){if(waitForReady)throw new Error('重载已取消。');return;}
      // The MCP bridge forward is per node and shared by every open session there. Take the new lease
      // before dropping the old one so a reload keeps the existing tunnel.
      const lease=this.tunnels.acquire(node,bootstrap.remotePort);slot.tunnel?.release();slot.tunnel=lease;
      await lease.ready();
    }catch(error){if(waitForReady)throw error;this.scheduleRetry(slot,generation,attempt,(error as Error).message);return;}
    if(!this.current(slot,generation)){if(waitForReady)throw new Error('重载已取消。');return;}
    const command=await remoteLaunchCommand(node,bootstrap.helperPath,bootstrap.configPath);
    const args=[...sshArgs(node),'-tt',node.sshTarget,...remoteCommandArguments(node,command)];
    const terminal=pty.spawn(sshExecutable(),args,{name:'xterm-256color',cols:slot.cols,rows:slot.rows,useConptyDll:process.platform==='win32',cwd:this.options.dataDir,env:{...sshEnvironment(node),TERM:'xterm-256color'}});
    slot.terminal=terminal;let ready=false;let markerBuffer='';let trailing='';
    const live=()=>this.current(slot,generation)&&slot.terminal===terminal;
    const readyResult=waitForReady?new Promise<void>((resolve,reject)=>{slot.readyWaiter={generation,resolve,reject};}):undefined;
    terminal.onData(data=>{
      if(!live())return;
      const observed=markerBuffer+data;markerBuffer=observed.slice(-256);trailing=(trailing+data).slice(-8192);
      if(!ready&&observed.includes('\x1b]777;happypanda-ready\x07')){ready=true;if(slot.healthTimer)clearTimeout(slot.healthTimer);slot.connection.phase='connected';slot.connection.message='';slot.connection.retryAttempt=0;this.activity({kind:'connection',title:'Connected',detail:node.name,sessionId:session.id});if(slot.readyWaiter?.generation===generation){slot.readyWaiter.resolve();slot.readyWaiter=undefined;}this.publish();}
      slot.buffer.append(data);this.options.emit({type:'terminal',data,sessionId:session.id,generation,end:slot.buffer.total});
      // Background output only marks the tab; it is not re-sent as state on every chunk.
      if(this.focusId!==session.id&&!slot.unread){slot.unread=true;this.publish();}
    });
    terminal.onExit(({exitCode})=>{
      if(!live())return;
      slot.terminal=undefined;if(slot.healthTimer)clearTimeout(slot.healthTimer);
      if(this.loginContext?.sessionId===session.id)this.loginBrowser.block('终端连接中断，登录浏览器连接已阻断。');
      if(slot.readyWaiter?.generation===generation){slot.readyWaiter.reject(new Error('Claude 重载连接中断，请重新连接。'));slot.readyWaiter=undefined;return;}
      if(/Permission denied|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Bad configuration|Windows terminal could not start|Windows session supervisor could not start|Failed to load native module/.test(trailing)){slot.connection.phase='failed';slot.connection.message=trailing.replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').slice(-1200).trim();this.publish();return;}
      this.scheduleRetry(slot,generation,attempt,exitCode===0?'Terminal detached':'SSH connection closed');
    });
    slot.healthTimer=setTimeout(()=>{if(live()&&!ready){if(slot.readyWaiter?.generation===generation){slot.readyWaiter.reject(new Error('Claude 重载超时，请重新连接。'));slot.readyWaiter=undefined;slot.terminal=undefined;}terminal.kill();}},25000);
    if(workspace&&workspace.mode!=='mcp-only')this.startWorkspaceSetup(slot,bootstrap,generation);
    await readyResult;
  }
  private scheduleRetry(slot:Slot,generation:number,attempt:number,message:string){
    if(!this.current(slot,generation))return;
    if(attempt>=8||/Permission denied|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Bad configuration|HappyPanda:|Claude Code is not installed|Python was not found|ModuleNotFoundError|Unsupported remote/.test(message)){slot.connection.phase='failed';slot.connection.message=message;this.publish();return;}
    const delay=Math.min(30000,1000*2**attempt)*(0.8+Math.random()*0.4);
    slot.connection.phase='retrying';slot.connection.retryAttempt=attempt+1;slot.connection.message=message+'; reconnecting';this.publish();
    slot.retryTimer=setTimeout(()=>{void this.openPty(slot,generation,attempt+1).catch(error=>{if(!this.current(slot,generation))return;slot.connection.phase='failed';slot.connection.message=String(error);this.publish();});},delay);
  }
  /** Input for a specific tab; without a session ID it goes to the focused one (phone remote control). */
  writeTerminal(data:string,sessionId?:string){const slot=sessionId===undefined?this.focused():this.slots.get(sessionId);if(slot?.connection.phase==='connected'&&slot.terminal&&typeof data==='string'&&data.length<=1048576)slot.terminal.write(data);}
  async pasteClipboard(request:TerminalPasteRequest,permitted:()=>boolean=()=>true):Promise<TerminalPasteResult>{
    return this.pasteContent(request,async()=>{
      if(!this.options.readClipboard)throw new Error('当前环境无法读取系统剪贴板。');
      return this.options.readClipboard();
    },permitted);
  }
  async pasteImage(request:TerminalPasteRequest,png:Buffer,permitted:()=>boolean=()=>true):Promise<TerminalPasteResult>{
    validateClipboardPng(png);
    return this.pasteContent(request,async()=>({kind:'image',png}),permitted);
  }
  private async pasteContent(request:TerminalPasteRequest,read:()=>Promise<ClipboardContent>,permitted:()=>boolean):Promise<TerminalPasteResult>{
    if(!request||typeof request.nodeId!=='string'||typeof request.sessionId!=='string'||typeof request.bracketedPaste!=='boolean')throw new Error('无效的粘贴请求。');
    const slot=this.slots.get(request.sessionId),generation=slot?.generation,terminal=slot?.terminal;
    // Check the PTY identity as well as the session: a reconnect can reuse the same ID.
    const current=()=>Boolean(slot&&terminal)&&permitted()&&this.current(slot!,generation!)&&slot!.terminal===terminal&&slot!.connection.phase==='connected'&&slot!.node.id===request.nodeId;
    if(!slot||!terminal||!current())throw new Error('终端未连接或会话已切换，请重新粘贴。');
    if(slot.pasting===generation)throw new Error('正在粘贴，请稍候。');
    slot.pasting=generation;
    try{
      const content=await read();
      if(!current())throw new Error('连接或会话已变更，内容未粘贴；请重新粘贴。');
      if(content.kind==='empty')return {kind:'empty'};
      let text:string;
      if(content.kind==='image'){
        if(slot.session.kind==='login')throw new Error('请在 Claude 或 Shell 会话中粘贴图片。');
        if(slot.preparation&&slot.preparation.phase!=='ready')throw new Error('工作区尚未准备完成，请就绪后再粘贴图片。');
        const remotePath=await this.imageUploader.upload({...this.store.node(request.nodeId)},request.sessionId,content.png);
        text=' '+shellQuote(remotePath)+' ';
      }else{text=content.text;if(text.length>1048576)throw new Error('剪贴板文字过长，请分段粘贴。');}
      if(!current())throw new Error('连接或会话已变更，内容未粘贴；请在目标会话重新粘贴。');
      terminal.write(terminalPaste(text,request.bracketedPaste));
      if(content.kind==='image')this.activity({kind:'tool',title:'图片已粘贴到终端，等待发送',location:'remote',sessionId:request.sessionId});
      return {kind:content.kind};
    }finally{if(slot.pasting===generation)slot.pasting=undefined;}
  }
  resizeTerminal(cols:number,rows:number,sessionId?:string){
    if(Number.isInteger(cols)&&Number.isInteger(rows)&&cols>=10&&cols<=500&&rows>=3&&rows<=300){
      this.terminalCols=cols;this.terminalRows=rows;
      const slot=sessionId===undefined?this.focused():this.slots.get(sessionId);if(!slot)return;
      const changed=slot.cols!==cols||slot.rows!==rows;
      slot.cols=cols;slot.rows=rows;slot.terminal?.resize(cols,rows);
      if(changed)this.options.emit({type:'terminal-size',cols,rows,sessionId:slot.session.id});
    }
  }
  /** Closes every tab and returns to the node list. */
  async disconnect(){
    ++this.generation;this.loginContext=undefined;this.loginBrowser.block();
    const releases=[...this.slots.values()].map(slot=>this.closeSlot(slot));
    this.focusId=undefined;this.idle={phase:'disconnected',message:'',retryAttempt:0};
    this.publishFocus();
    await Promise.all(releases);
  }
  private gitReady(runtime:WorkspaceRuntime){
    return runtime.state.phase==='ready'&&this.workspaceSlots(runtime.id).some(slot=>slot.connection.phase==='connected'&&slot.preparation?.phase==='ready');
  }
  private async syncGitCommits(runtime:WorkspaceRuntime,force:boolean):Promise<void>{
    const workspace=this.store.workspaces.find(item=>item.id===runtime.id);
    if(!workspace||workspace.mode==='mcp-only'||!this.gitReady(runtime))return;
    if(runtime.gitSynchronization){
      const running=runtime.gitSynchronization;await running.promise;
      if(running.epoch!==runtime.epoch&&this.gitReady(runtime))return this.syncGitCommits(runtime,force);
      return;
    }
    if(!force&&Date.now()<runtime.nextGitCheck)return;
    runtime.nextGitCheck=Date.now()+10000;runtime.lastGitCheck=Date.now();
    const node=this.store.node(workspace.nodeId),epoch=runtime.epoch,workspaceId=workspace.id;
    const current=()=>workspace.mode!=='mcp-only'&&epoch===runtime.epoch&&this.gitReady(runtime);
    const previous=runtime.git;
    const changed=(state:NonNullable<SyncState['git']>)=>{runtime.git=state;this.publish();};
    changed({phase:'syncing',message:'Checking remote Git commits'});
    const promise=(async()=>{
      try{
        const result=await this.git.syncRemoteCommits(workspace,node,current);
        if(!current())return;
        changed(result);
        if(result.updated||(result.phase==='blocked'&&(previous?.phase!==result.phase||previous.message!==result.message)))this.activity({kind:'sync',title:result.updated?'Remote commits synchronized':'Remote commits need review',detail:result.message+(result.reference?'\n'+result.reference:''),workspaceId});
      }catch(error){
        if(!current())return;
        const message=(error as Error).message;changed({phase:'error',message});
        if(previous?.phase!=='error'||previous.message!==message)this.activity({kind:'error',title:'Remote commit synchronization failed',detail:message,workspaceId});
      }
    })();
    runtime.gitSynchronization={epoch,promise};
    try{await promise;}finally{if(runtime.gitSynchronization?.promise===promise)runtime.gitSynchronization=undefined;}
  }
  async syncNow(){
    const slot=this.focused(),workspace=slot?.workspace;
    if(workspace?.mode==='mcp-only')throw new Error('仅本机 MCP 模式不使用工作区同步。');
    if(!slot||!workspace)return emptySync();
    const generation=slot.generation,runtime=this.runtime(workspace);
    await runtime.sync.ensure(workspace,this.store.node(workspace.nodeId));
    if(!this.current(slot,generation))return this.syncView(this.focused());
    const state=await runtime.sync.flush();
    if(state.phase==='ready'&&this.current(slot,generation)){
      if(slot.setup?.failed)this.startWorkspaceSetup(slot,slot.setup.runtime,generation);
      await slot.setup?.promise;
      if(this.current(slot,generation)&&slot.preparation?.phase==='ready')await this.syncGitCommits(runtime,true);
    }
    return this.syncView(slot);
  }
  async pauseSync(){const workspace=this.focused()?.workspace;if(!workspace||workspace.mode==='mcp-only')return;await this.runtimes.get(workspace.id)?.sync.pause();}
  async resolveConflict(path:string,prefer:'local'|'remote'){
    const workspace=this.focused()?.workspace;
    if(workspace?.mode==='mcp-only')throw new Error('仅本机 MCP 模式不使用工作区同步。');
    if(!['local','remote'].includes(prefer))throw new Error('Invalid conflict preference');
    if(!workspace)throw new Error('No workspace synchronization session');
    await this.runtime(workspace).sync.resolveConflict(path,prefer);
  }
  async openLocalPath(id:string){await this.options.openLocal(this.store.workspace(id).localPath);}
  async openExternal(url:string){const parsed=new URL(url);if(!['https:','http:'].includes(parsed.protocol))throw new Error('Unsupported URL');if(isAuthorizationLink(url)){await this.openLoginLink(url);return;}await this.options.openURL(parsed.toString());}
  listLocalHistory(){return listLocalHistory();}
  async importHistory(request:ImportRequest){const workspace=this.store.workspace(request.workspaceId);const result=await this.importer.import(request,workspace,this.store.node(workspace.nodeId));this.activity({kind:'session',title:'History imported',detail:String(result.imported)+' sessions',workspaceId:workspace.id});return result;}
  async importProjectMemory(workspaceId:string){
    const workspace=this.store.workspace(workspaceId);
    if(workspace.mode==='mcp-only')throw new Error('仅本机 MCP 模式请通过 MCP 读取本机项目记忆。');
    const result=await new ProjectMemoryImporter(this.options.resourcesDir).import(workspace,this.store.node(workspace.nodeId));
    this.activity({kind:'session',title:'项目记忆已导入',detail:`新增 ${result.imported} 份，${result.unchanged} 份相同，${result.conflicts.length} 份存在差异并已保留远端版本。`,workspaceId});
    return result;
  }
  async resumeImported(workspaceId:string,transcriptPath:string){
    if(this.switchingProvider)throw new Error('正在更新提供商，请稍后再续接会话。');
    const workspace=this.store.workspace(workspaceId);if((!transcriptPath.startsWith('/')&&!/^[A-Za-z]:\//.test(transcriptPath))||!transcriptPath.includes('/.local/share/happypanda/')||transcriptPath.includes('..')||!transcriptPath.endsWith('.jsonl')||/[\r\n\0]/.test(transcriptPath))throw new Error('Invalid imported transcript path');
    const node=this.store.node(workspace.nodeId);const session=this.createSession(node,workspace,'claude',transcriptPath);await this.attach(node,workspace,session);
  }
  async addPortForward(remotePort:number,requestedLocalPort?:number):Promise<PortForward>{
    if(!Number.isInteger(remotePort)||remotePort<1||remotePort>65535)throw new Error('Invalid remote port');
    const node=this.store.node(this.focused()?.node.id??'');
    const localPort=requestedLocalPort??await new Promise<number>((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=(server.address() as import('node:net').AddressInfo).port;server.close(()=>resolve(port));});});
    if(!Number.isInteger(localPort)||localPort<1024||localPort>65535)throw new Error('Invalid local port');
    const child=spawn(sshExecutable(),[...sshArgs(node),'-v','-o','ExitOnForwardFailure=yes','-N','-L','127.0.0.1:'+localPort+':127.0.0.1:'+remotePort,node.sshTarget],{windowsHide:true,stdio:['ignore','ignore','pipe'],env:sshEnvironment(node)});
    await new Promise<void>((resolve,reject)=>{let error='';let settled=false;const finish=(cause?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);if(cause){child.kill();reject(cause);}else resolve();};const timer=setTimeout(()=>finish(new Error('Port forwarding connection timed out')),25000);child.stderr?.on('data',data=>{error=(error+data.toString()).slice(-8192);if(error.includes('Local forwarding listening on 127.0.0.1 port '+localPort+'.'))finish();});child.once('error',cause=>finish(cause));child.once('exit',code=>finish(new Error('Port forwarding exited '+code)));});
    const forward={id:randomUUID(),localPort,remotePort,nodeId:node.id};this.forwards.set(forward.id,{process:child,forward});child.once('exit',()=>{if(this.forwards.delete(forward.id))this.activity({kind:'connection',title:'Port forwarding closed',detail:'127.0.0.1:'+localPort});});this.publish();return forward;
  }
  async removePortForward(id:string){const entry=this.forwards.get(id);if(entry){this.forwards.delete(id);entry.process.kill();this.publish();}}
  async dispose(){
    if(this.publishTimer)clearTimeout(this.publishTimer);
    await this.disconnect();await Promise.all([...this.runtimes.values()].map(runtime=>runtime.gitSynchronization?.promise));
    await this.loginBrowser.dispose();for(const entry of this.forwards.values())entry.process.kill();this.forwards.clear();
    for(const runtime of this.runtimes.values())await runtime.sync.dispose();
    // Session definitions survive; only the isolated daemon stops. A failure must not block the rest of shutdown.
    await this.mutagen.stopDaemon().catch(error=>this.activity({kind:'error',title:'停止同步守护进程失败',detail:(error as Error).message}));
    this.tunnels.dispose();await this.bridge.stop();closeSshChannels();await this.sshAuthentication.dispose();await this.store.save();
  }
}
