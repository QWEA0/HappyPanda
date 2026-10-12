import { randomUUID, createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, basename, posix,dirname } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import * as pty from 'node-pty';
import { z } from 'zod';
import { InventoryStore } from './store';
import { ProviderStore, type SecretEncryption } from './providers';
import { BrowserLoginManager, isAuthorizationLink } from './login-browser';
import type { LoginNetworkCheck } from './login-network';
import { sshArgs,runRemote,uploadFile,remoteHome,shellQuote,listSshAliases,sshExecutable,scpExecutable } from './ssh';
import { verifySystemIdentity,runCommand } from './sync/transport';
import { LocalMcpBridge,remoteBridgePort } from './mcp';
import { WorkspaceSync } from './sync';
import { HistoryImporter,listLocalHistory } from './history';
import { GitWorkspace } from './git';
import { ProjectMemoryImporter } from './memory';
import { ClipboardImageUploader, terminalPaste, type ClipboardContent } from './clipboard';
import type { TerminalPasteRequest, TerminalPasteResult } from '../shared/types';
import { emptySync, type AppState,type AppEvent,type ServiceNode,type SessionInfo,type Workspace,type ActivityEvent,type NodeInput,type ImportRequest,type PortForward,type ProviderInput } from '../shared/types';

const metricsSchema=z.object({hostname:z.string(),os:z.string(),cpuCount:z.number().int().min(1),load:z.number().min(0),memoryTotal:z.number().min(0),memoryAvailable:z.number().min(0),diskAvailable:z.number().min(0),uptime:z.number().min(0),claudeVersion:z.string().nullable(),authenticated:z.boolean(),address:z.string(),sampledAt:z.string()});
interface ControllerOptions {
  dataDir:string;resourcesDir:string;token:string;emit:(event:AppEvent)=>void;
  encryption?:SecretEncryption;
  checkLoginNetwork?:(proxyPort:number,signal:AbortSignal)=>Promise<LoginNetworkCheck>;
  readClipboard?:()=>ClipboardContent|Promise<ClipboardContent>;
  pickDirectory:()=>Promise<string|null>;openLocal:(path:string)=>Promise<void>;openURL:(url:string)=>Promise<void>;
}
export class AppController {
  readonly store:InventoryStore;
  readonly providers:ProviderStore;
  readonly loginBrowser:BrowserLoginManager;
  readonly bridge:LocalMcpBridge;
  readonly sync:WorkspaceSync;
  private importer:HistoryImporter;
  private imageUploader:ClipboardImageUploader;
  private clipboardPaste?:{generation:number};
  private git:GitWorkspace;
  private state:AppState;
  private terminal:pty.IPty|undefined;
  private bridgePort=0;
  private generation=0;
  private retryTimer:ReturnType<typeof setTimeout>|undefined;
  private healthTimer:ReturnType<typeof setTimeout>|undefined;
  private terminalCols=100;
  private terminalRows=32;
  private seenEvents=new Set<string>();
  private forwards=new Map<string,{process:ChildProcess,forward:PortForward}>();
  private switchingProvider=false;
  private loginStarting=false;
  private loginContext:{nodeId:string;sessionId:string;returnSessionId?:string;workspaceId?:string;attemptId:string;completing?:boolean;hookOpened?:boolean;pendingResult?:Record<string,unknown>}|undefined;
  private readyWaiter:{generation:number;resolve:()=>void;reject:(error:Error)=>void}|undefined;
  private workspaceSetup:{generation:number;abort:AbortController;promise:Promise<void>;failed:boolean;runtime:{helperPath:string;configPath:string}}|undefined;
  constructor(private options:ControllerOptions){
    this.store=new InventoryStore(options.dataDir);
    this.providers=new ProviderStore(options.dataDir,options.encryption);
    this.state={nodes:[],providers:[],workspaces:[],sessions:[],connection:{phase:'disconnected',message:'',retryAttempt:0},metrics:null,sync:emptySync(),activities:[],terminalBuffer:'',version:'0.1.0'};
    this.loginBrowser=new BrowserLoginManager({dataDir:options.dataDir,checkNetwork:options.checkLoginNetwork,onState:state=>{this.state.browserLogin=state;this.publish();}});
    const binary=process.platform==='win32'?'mutagen.exe':'mutagen';
    const mutagenPath=process.env.HAPPYPANDA_MUTAGEN_PATH??[join(options.resourcesDir,'../tools',binary),join(options.resourcesDir,'../.local/tools',binary)].find(existsSync);
    const prepareSsh=async(node:ServiceNode)=>{await verifySystemIdentity(node,runCommand);return {target:node.sshTarget,user:node.user,port:node.port,mutagenSshPath:dirname(sshExecutable()),scpPath:scpExecutable()};};
    this.sync=new WorkspaceSync({dataDir:options.dataDir,runRemote,uploadFile,mutagenPath,prepareSsh,onWorkspaceUpdated:async()=>{await this.store.save();this.publish();},onState:state=>{
      this.state.sync=state;
      const preparation=this.state.workspacePreparation;
      if(preparation&&['syncing','error'].includes(preparation.phase)&&this.workspaceSetup&&!this.workspaceSetup.failed){
        preparation.phase=['error','conflict','paused','disconnected'].includes(state.phase)?'error':'syncing';
        preparation.message=preparation.phase==='error'?state.message:'正在同步工作区；首次使用将在就绪后启动会话。';
      }
      this.publish();
    },onActivity:event=>this.activity(event)});
    this.git=new GitWorkspace(options.dataDir);
    this.bridge=new LocalMcpBridge({token:options.token,dataDir:options.dataDir,
      resolveWorkspace:id=>this.store.workspaces.find(workspace=>workspace.id===id&&this.state.connection.activeWorkspaceId===id),
      onActivity:event=>this.activity(event),onRemoteEvent:payload=>this.remoteEvent(payload),
      beforeOperation:async id=>{if(id!==this.state.connection.activeWorkspaceId)throw new Error('Workspace is not connected');if(this.state.workspacePreparation?.workspaceId===id&&this.state.workspacePreparation.phase!=='ready')throw new Error('工作区尚未准备完成，请等待同步或处理同步错误。');if(this.state.sync.phase!=='none'){const sync=await this.sync.flush();if(sync.phase!=='ready')throw new Error('Workspace synchronization is not ready');}},
      afterOperation:async id=>{if(id!==this.state.connection.activeWorkspaceId)throw new Error('Command finished in an inactive workspace; synchronize that workspace before using its artifacts');if(this.state.sync.phase!=='none'){const sync=await this.sync.flush();if(sync.phase!=='ready')throw new Error('Command finished; resulting files are awaiting synchronization');}},
    });
    this.importer=new HistoryImporter({dataDir:options.dataDir,runRemote,uploadFile});
    this.imageUploader=new ClipboardImageUploader(options.resourcesDir);
  }
  async initialize(){await this.store.load();await this.providers.load();const bridge=await this.bridge.start();this.bridgePort=bridge.port;this.publish();}
  snapshot():AppState {return structuredClone({...this.state,nodes:this.store.nodes,providers:this.providers.list(),workspaces:this.store.workspaces,sessions:this.store.sessions,portForwards:[...this.forwards.values()].map(entry=>entry.forward)});}
  private publish(){this.options.emit({type:'state',state:this.snapshot()});}
  private activity(input:Omit<ActivityEvent,'id'|'time'>){
    const activity:ActivityEvent={...input,id:randomUUID(),time:new Date().toISOString()};
    this.state.activities=[activity,...this.state.activities].slice(0,150);
    this.options.emit({type:'activity',activity});this.publish();
  }
  private remoteEvent(payload:Record<string,unknown>){
    if(payload.nodeId!==this.state.connection.activeNodeId)return;
    if(payload.type==='login-url'&&typeof payload.url==='string'&&this.loginContext&&payload.sessionId===this.loginContext.sessionId&&payload.attemptId===this.loginContext.attemptId){
      if(this.loginContext.hookOpened)return;
      const context=this.loginContext;context.hookOpened=true;
      void this.openLoginLink(payload.url).catch(()=>{if(this.loginContext===context)context.hookOpened=false;this.activity({kind:'error',title:'登录浏览器未能打开，请点击终端中的授权链接或重新登录。'});});return;
    }
    if(payload.type==='login-result'){void this.completeLogin(payload).catch(()=>this.activity({kind:'error',title:'登录完成后的会话恢复失败，请重新连接。'}));return;}
    if(payload.type==='metrics'&&payload.sessionId===this.state.connection.activeSessionId){const metrics=metricsSchema.safeParse(payload.metrics);if(metrics.success){this.state.metrics=metrics.data;this.publish();}return;}
    if(payload.type!=='tool'||typeof payload.id!=='string'||this.seenEvents.has(payload.id))return;
    this.seenEvents.add(payload.id);if(this.seenEvents.size>2000)this.seenEvents.delete(this.seenEvents.values().next().value!);
    const event=String(payload.event??'');
    if(!['PostToolUse','UserPromptSubmit','Stop','SessionStart','Notification'].includes(event))return;
    this.activity({kind:'tool',title:event==='PostToolUse'?String(payload.tool??'Tool')+' completed':event==='UserPromptSubmit'?'Prompt submitted':event==='Stop'?'Claude turn completed':event,
      detail:typeof payload.path==='string'?payload.path:undefined,location:'remote',sessionId:String(payload.sessionId??''),workspaceId:typeof payload.workspaceId==='string'?payload.workspaceId:undefined});
  }
  async saveNode(input:NodeInput){const node=await this.store.saveNode(input);this.publish();return node;}
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
    if(this.switchingProvider)throw new Error('正在切换提供商，请稍后再试。');
    if(providerId!==null&&typeof providerId!=='string')throw new Error('无效的提供商。');
    const node=this.store.node(nodeId);
    this.providers.configuration(providerId??undefined);
    const active=this.state.connection.activeNodeId===nodeId;
    const initialGeneration=this.generation;
    if(active&&['preparing','connecting','retrying'].includes(this.state.connection.phase))throw new Error('请等待当前连接完成后再切换提供商。');
    this.switchingProvider=true;
    try{
      const previous=node.providerId;
      node.providerId=providerId??undefined;
      try{await this.store.save();}catch(error){node.providerId=previous;throw error;}
      this.publish();
      if(active){
        if(initialGeneration!==this.generation)throw new Error('提供商已保存，连接已变更，请重新连接后应用。');
        const workspace=this.state.connection.activeWorkspaceId?this.store.workspace(this.state.connection.activeWorkspaceId):undefined;
        let session=this.store.sessions.find(item=>item.id===this.state.connection.activeSessionId&&item.kind==='claude');
        if(!session)session=this.createSession(node,workspace);
        session.reloadToken=randomUUID();
        try{await this.attach(node,workspace,session,true);}
        catch{throw new Error('提供商已保存，但 Claude 重载未完成。请查看连接状态并重新连接。');}
        this.activity({kind:'session',title:'Claude 已按提供商配置重载',detail:this.providers.list().find(item=>item.id===providerId)?.name??'官方账号',sessionId:session.id});
      }
    }finally{this.switchingProvider=false;}
  }
  async removeNode(id:string){this.store.node(id);if(this.state.connection.activeNodeId===id)await this.disconnect();this.store.nodes=this.store.nodes.filter(node=>node.id!==id);this.store.workspaces=this.store.workspaces.filter(workspace=>workspace.nodeId!==id);this.store.sessions=this.store.sessions.filter(session=>session.nodeId!==id);await this.store.save();this.publish();}
  listAliases(){return listSshAliases();}
  async chooseWorkspace(nodeId:string){
    const node=this.store.node(nodeId);const selected=await this.options.pickDirectory();if(!selected)return null;
    const localPath=await realpath(selected);let workspace=this.store.workspaces.find(item=>item.nodeId===nodeId&&item.localPath===localPath);
    if(!workspace){const id=randomUUID();const home=await remoteHome(node);workspace={id,nodeId,name:basename(localPath),localPath,remotePath:posix.join(home,'.local/share/happypanda/workspaces',id),localAccess:false,syncSessionName:'hp-'+id.replaceAll('-',''),createdAt:new Date().toISOString()};this.store.workspaces.push(workspace);}
    node.lastWorkspaceId=workspace.id;await this.store.save();this.publish();return workspace;
  }
  async setLocalAccess(workspaceId:string,enabled:boolean){const workspace=this.store.workspace(workspaceId);workspace.localAccess=enabled;await this.store.save();this.activity({kind:'connection',title:enabled?'Local MCP access enabled':'Local MCP access disabled',workspaceId,location:'local'});}
  private createSession(node:ServiceNode,workspace:Workspace|undefined,kind:SessionInfo['kind']='claude',transcriptPath?:string){
    const id=randomUUID();const now=new Date().toISOString();const session:SessionInfo={id,nodeId:node.id,workspaceId:workspace?.id,title:kind==='login'?'Account login':kind==='shell'?'Remote shell':workspace?.name??'Claude Code',tmuxName:'hp-'+id.replaceAll('-',''),createdAt:now,lastActiveAt:now,kind,transcriptPath};this.store.sessions.unshift(session);return session;
  }
  async connect(nodeId:string,workspaceId?:string,sessionId?:string){
    if(this.switchingProvider)throw new Error('正在更新提供商，请稍后再连接。');
    const node=this.store.node(nodeId);
    let session=sessionId?this.store.sessions.find(item=>item.id===sessionId):undefined;
    if(sessionId&&!session)throw new Error('Session not found');
    if(session&&workspaceId!==undefined&&session.workspaceId!==workspaceId)throw new Error('Session belongs to another workspace');
    const requestedWorkspace=session?session.workspaceId:workspaceId??node.lastWorkspaceId;
    const workspace=requestedWorkspace?this.store.workspace(requestedWorkspace):undefined;
    if(workspace&&workspace.nodeId!==nodeId)throw new Error('Workspace belongs to another node');
    if(session&&(session.nodeId!==nodeId||session.workspaceId!==workspace?.id))throw new Error('Session belongs to another workspace');
    if(!session)session=this.store.sessions.find(item=>item.id===node.lastSessionId&&item.workspaceId===workspace?.id&&item.kind==='claude');
    if(!session)session=this.createSession(node,workspace);
    await this.attach(node,workspace,session);
  }
  async newSession(kind:SessionInfo['kind']='claude'){
    if(this.switchingProvider)throw new Error('正在更新提供商，请稍后再新建会话。');
    if(this.loginStarting)throw new Error('正在准备登录，请稍后再试。');
    if(!['claude','login','shell'].includes(kind))throw new Error('Invalid session type');
    if(kind==='login'){await this.startLogin();return;}
    const node=this.store.node(this.state.connection.activeNodeId??'');const workspace=this.state.connection.activeWorkspaceId?this.store.workspace(this.state.connection.activeWorkspaceId):undefined;
    await this.attach(node,workspace,this.createSession(node,workspace,kind));
  }
  private async startLogin(){
    const node=this.store.node(this.state.connection.activeNodeId??'');
    if(this.state.connection.phase!=='connected')throw new Error('请先连接服务器，再发起登录。');
    if(node.providerId)throw new Error('请先在 API 提供商中选择官方账号，再发起官方登录。');
    const generation=this.generation;
    const workspace=this.state.connection.activeWorkspaceId?this.store.workspace(this.state.connection.activeWorkspaceId):undefined;
    const previous=this.loginContext?.returnSessionId??this.state.connection.activeSessionId;
    const returnSessionId=this.store.sessions.find(item=>item.id===previous&&item.kind==='claude')?.id;
    this.loginStarting=true;
    try{
      await this.loginBrowser.prepare(node);
      if(generation!==this.generation)throw new Error('登录已取消。');
      const session=this.createSession(node,workspace,'login');session.reloadToken=randomUUID();
      node.loginViaNode=true;
      this.loginContext={nodeId:node.id,sessionId:session.id,workspaceId:workspace?.id,returnSessionId,attemptId:session.reloadToken};
      await this.attach(node,workspace,session,true);
    }catch(error){if(generation===this.generation||this.state.connection.activeSessionId===this.loginContext?.sessionId){this.loginContext=undefined;this.loginBrowser.block('登录未能启动，浏览器连接已阻断。');}throw error;}
    finally{this.loginStarting=false;const result=this.loginContext?.pendingResult;if(result){this.loginContext!.pendingResult=undefined;void this.completeLogin(result).catch(()=>this.activity({kind:'error',title:'登录完成后的会话恢复失败，请重新连接。'}));}}
  }
  private async openLoginLink(url:string){
    const context=this.loginContext;
    if(!context||context.sessionId!==this.state.connection.activeSessionId)throw new Error('请通过当前服务器重新发起登录。');
    await this.loginBrowser.openAuthorization(context.nodeId,url);
  }
  private async completeLogin(payload:Record<string,unknown>){
    const context=this.loginContext;
    if(!context||context.completing||payload.sessionId!==context.sessionId||payload.attemptId!==context.attemptId||this.state.connection.activeSessionId!==context.sessionId)return;
    if(this.loginStarting){context.pendingResult=payload;return;}
    context.completing=true;
    if(payload.success!==true||!this.loginBrowser.snapshot().routeVerified){this.loginBrowser.fail('官方登录未完成，请通过当前服务器重新登录。');return;}
    this.loginBrowser.authenticated();
    this.activity({kind:'session',title:'官方账号登录成功，正在恢复 Claude 会话。',sessionId:context.sessionId});
    const node=this.store.node(context.nodeId),workspace=context.workspaceId?this.store.workspace(context.workspaceId):undefined;
    const session=this.store.sessions.find(item=>item.id===context.returnSessionId)??this.createSession(node,workspace);
    session.reloadToken=randomUUID();this.loginContext=undefined;
    await this.attach(node,workspace,session,true);
  }
  private closeTerminal(){this.readyWaiter?.reject(new Error('重载已取消。'));this.readyWaiter=undefined;if(this.retryTimer)clearTimeout(this.retryTimer);if(this.healthTimer)clearTimeout(this.healthTimer);this.retryTimer=undefined;this.healthTimer=undefined;const terminal=this.terminal;this.terminal=undefined;try{terminal?.kill();}catch{}}
  private async attach(node:ServiceNode,workspace:Workspace|undefined,session:SessionInfo,waitForReady=false){
    if((this.loginContext&&this.loginContext.sessionId!==session.id)||(this.state.browserLogin?.nodeId&&this.state.browserLogin.nodeId!==node.id)||node.providerId){this.loginContext=undefined;this.loginBrowser.block();}
    const generation=++this.generation;this.workspaceSetup?.abort.abort();this.workspaceSetup=undefined;this.closeTerminal();
    this.state.connection={phase:'preparing',message:'Preparing workspace',retryAttempt:0,activeNodeId:node.id,activeWorkspaceId:workspace?.id,activeSessionId:session.id};
    this.state.metrics=null;this.state.terminalBuffer='';this.state.workspacePreparation=workspace?{workspaceId:workspace.id,phase:'syncing',message:'正在同步工作区；首次使用将在就绪后启动会话。'}:undefined;this.publish();
    if(session.kind!=='login')node.lastSessionId=session.id;node.lastWorkspaceId=workspace?.id;session.lastActiveAt=new Date().toISOString();await this.store.save();
    try{
      if(!workspace){this.state.sync=emptySync();void this.sync.pause().catch(error=>this.activity({kind:'error',title:'暂停工作区同步失败',detail:(error as Error).message}));}
      if(generation!==this.generation){if(waitForReady)throw new Error('重载已取消。');return;}
      await this.openPty(node,workspace,session,generation,0,waitForReady);
    }catch(error){if(generation===this.generation){this.state.connection.phase='failed';this.state.connection.message=(error as Error).message;this.activity({kind:'error',title:'Connection failed',detail:(error as Error).message});}if(waitForReady)throw error;}
  }
  private async bootstrap(node:ServiceNode,workspace:Workspace|undefined,session:SessionInfo){
    const bootstrap=await readFile(join(this.options.resourcesDir,'bootstrap.py'),'utf8');
    const helper=await readFile(join(this.options.resourcesDir,'hp_remote.py'));
    const remotePort=remoteBridgePort(node.id,this.options.token);
    const provider=session.kind==='claude'?this.providers.configuration(node.providerId):undefined;
    const config={nodeId:node.id,sessionId:session.id,workspaceId:workspace?.id,remotePath:workspace?.remotePath,kind:session.kind,tmuxName:session.tmuxName,sshTarget:node.sshTarget,remotePort,token:this.options.token,transcriptPath:session.transcriptPath,provider,reloadToken:session.reloadToken,nodeEgress:session.kind==='login'||Boolean(node.loginViaNode&&!node.providerId),loginAttempt:session.kind==='login'?session.reloadToken:undefined,waitForWorkspace:Boolean(workspace)&&session.kind!=='login'};
    const command='python3 -c '+shellQuote('import base64;exec(base64.b64decode('+JSON.stringify(Buffer.from(bootstrap).toString('base64'))+'))');
    const result=JSON.parse(await runRemote(node,command,JSON.stringify({helper:helper.toString('base64'),config})));
    if(typeof result.configPath!=='string'||typeof result.helperPath!=='string')throw new Error('Invalid remote bootstrap response');
    return {...result,remotePort};
  }
  private startWorkspaceSetup(node:ServiceNode,workspace:Workspace,runtime:{helperPath:string;configPath:string},generation:number){
    if(this.workspaceSetup?.generation===generation&&!this.workspaceSetup.failed)return;
    this.workspaceSetup?.abort.abort();
    const task={generation,abort:new AbortController(),promise:Promise.resolve(),failed:false,runtime};
    this.workspaceSetup=task;
    this.state.workspacePreparation={workspaceId:workspace.id,phase:'syncing',message:'正在同步工作区；首次使用将在就绪后启动会话。'};this.publish();
    const current=()=>!task.abort.signal.aborted&&generation===this.generation;
    task.promise=(async()=>{
      try{
        const initial=await this.sync.ensure(workspace,node);
        if(!current())return;
        if(initial.phase==='error')throw new Error(initial.message);
        await this.sync.waitUntilReady(task.abort.signal,()=>workspace.syncSessionName);
        if(!current())return;
        this.state.workspacePreparation={workspaceId:workspace.id,phase:'git',message:'文件已同步，正在准备项目版本信息…'};this.publish();
        if(await this.git.bootstrap(workspace,node))this.activity({kind:'sync',title:'Remote Git baseline prepared',workspaceId:workspace.id});
        if(!current())return;
        await runRemote(node,'python3 '+shellQuote(runtime.helperPath)+' workspace-ready '+shellQuote(runtime.configPath));
        if(!current())return;
        this.state.workspacePreparation={workspaceId:workspace.id,phase:'ready',message:'工作区已就绪'};this.publish();
      }catch(error){
        if(!current())return;
        task.failed=true;
        this.state.workspacePreparation={workspaceId:workspace.id,phase:'error',message:(error as Error).message};
        this.activity({kind:'error',title:'工作区准备失败，SSH 连接保持可用',detail:(error as Error).message,workspaceId:workspace.id});
      }
    })();
  }
  private async openPty(node:ServiceNode,workspace:Workspace|undefined,session:SessionInfo,generation:number,attempt:number,waitForReady=false){
    if(generation!==this.generation)return;
    this.state.connection.phase=attempt?'retrying':'connecting';this.state.connection.retryAttempt=attempt;this.state.connection.message=attempt?'Reconnecting to existing session':'Starting secure terminal';this.publish();
    let bootstrap;
    try{bootstrap=await this.bootstrap(node,workspace,session);}catch(error){if(waitForReady)throw error;this.scheduleRetry(node,workspace,session,generation,attempt,(error as Error).message);return;}
    if(generation!==this.generation){if(waitForReady)throw new Error('重载已取消。');return;}
    const args=[...sshArgs(node),'-o','ExitOnForwardFailure=yes','-tt','-R','127.0.0.1:'+bootstrap.remotePort+':127.0.0.1:'+this.bridgePort,node.sshTarget,'python3 '+shellQuote(bootstrap.helperPath)+' launch '+shellQuote(bootstrap.configPath)];
    const terminal=pty.spawn(sshExecutable(),args,{name:'xterm-256color',cols:this.terminalCols,rows:this.terminalRows,useConptyDll:process.platform==='win32',cwd:this.options.dataDir,env:{...process.env,TERM:'xterm-256color'}});
    this.terminal=terminal;let ready=false;let markerBuffer='';let trailing='';
    const readyResult=waitForReady?new Promise<void>((resolve,reject)=>{this.readyWaiter={generation,resolve,reject};}):undefined;
    terminal.onData(data=>{
      if(generation!==this.generation||this.terminal!==terminal)return;
      markerBuffer=(markerBuffer+data).slice(-256);trailing=(trailing+data).slice(-8192);
      if(!ready&&markerBuffer.includes('\x1b]777;happypanda-ready\x07')){ready=true;if(this.healthTimer)clearTimeout(this.healthTimer);this.state.connection.phase='connected';this.state.connection.message='';this.state.connection.retryAttempt=0;this.activity({kind:'connection',title:'Connected',detail:node.name,sessionId:session.id});if(this.readyWaiter?.generation===generation){this.readyWaiter.resolve();this.readyWaiter=undefined;}}
      this.state.terminalBuffer=(this.state.terminalBuffer+data).slice(-512000);this.options.emit({type:'terminal',data});
    });
    terminal.onExit(({exitCode})=>{
      if(generation!==this.generation||this.terminal!==terminal)return;
      this.terminal=undefined;if(this.healthTimer)clearTimeout(this.healthTimer);
      if(this.loginContext?.sessionId===session.id)this.loginBrowser.block('终端连接中断，登录浏览器连接已阻断。');
      if(this.readyWaiter?.generation===generation){this.readyWaiter.reject(new Error('Claude 重载连接中断，请重新连接。'));this.readyWaiter=undefined;return;}
      if(/Permission denied|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Bad configuration/.test(trailing)){this.state.connection.phase='failed';this.state.connection.message=trailing.replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').slice(-1200).trim();this.publish();return;}
      this.scheduleRetry(node,workspace,session,generation,attempt,exitCode===0?'Terminal detached':'SSH connection closed');
    });
    this.healthTimer=setTimeout(()=>{if(generation===this.generation&&this.terminal===terminal&&!ready){if(this.readyWaiter?.generation===generation){this.readyWaiter.reject(new Error('Claude 重载超时，请重新连接。'));this.readyWaiter=undefined;this.terminal=undefined;}terminal.kill();}},25000);
    if(workspace)this.startWorkspaceSetup(node,workspace,bootstrap,generation);
    await readyResult;
  }
  private scheduleRetry(node:ServiceNode,workspace:Workspace|undefined,session:SessionInfo,generation:number,attempt:number,message:string){
    if(generation!==this.generation)return;
    if(attempt>=8){this.state.connection.phase='failed';this.state.connection.message=message;this.publish();return;}
    const delay=Math.min(30000,1000*2**attempt)*(0.8+Math.random()*0.4);
    this.state.connection.phase='retrying';this.state.connection.retryAttempt=attempt+1;this.state.connection.message=message+'; reconnecting';this.publish();
    this.retryTimer=setTimeout(()=>{void this.openPty(node,workspace,session,generation,attempt+1).catch(error=>{this.state.connection.phase='failed';this.state.connection.message=String(error);this.publish();});},delay);
  }
  writeTerminal(data:string){if(this.state.connection.phase==='connected'&&this.terminal&&typeof data==='string'&&data.length<=1048576)this.terminal.write(data);}
  async pasteClipboard(request:TerminalPasteRequest):Promise<TerminalPasteResult>{
    if(!request||typeof request.nodeId!=='string'||typeof request.sessionId!=='string'||typeof request.bracketedPaste!=='boolean')throw new Error('无效的粘贴请求。');
    const generation=this.generation,terminal=this.terminal;
    const current=()=>this.generation===generation&&this.terminal===terminal&&this.state.connection.phase==='connected'&&this.state.connection.activeNodeId===request.nodeId&&this.state.connection.activeSessionId===request.sessionId;
    if(!terminal||!current())throw new Error('终端未连接或会话已切换，请重新粘贴。');
    if(!this.options.readClipboard)throw new Error('当前环境无法读取系统剪贴板。');
    if(this.clipboardPaste?.generation===generation)throw new Error('正在粘贴，请稍候。');
    const operation={generation};this.clipboardPaste=operation;
    try{
      const content=await this.options.readClipboard();
      if(!current())throw new Error('连接或会话已变更，内容未粘贴；请重新粘贴。');
      if(content.kind==='empty')return {kind:'empty'};
      let text:string;
      if(content.kind==='image'){
        const session=this.store.sessions.find(value=>value.id===request.sessionId);
        if(!session||session.kind==='login')throw new Error('请在 Claude 或 Shell 会话中粘贴图片。');
        if(this.state.workspacePreparation&&this.state.workspacePreparation.phase!=='ready')throw new Error('工作区尚未准备完成，请就绪后再粘贴图片。');
        const remotePath=await this.imageUploader.upload({...this.store.node(request.nodeId)},request.sessionId,content.png);
        text=' '+shellQuote(remotePath)+' ';
      }else{text=content.text;if(text.length>1048576)throw new Error('剪贴板文字过长，请分段粘贴。');}
      // Check the PTY identity as well as the session: a reconnect can reuse the same ID.
      if(!current())throw new Error('连接或会话已变更，内容未粘贴；请在目标会话重新粘贴。');
      terminal.write(terminalPaste(text,request.bracketedPaste));
      if(content.kind==='image')this.activity({kind:'tool',title:'图片已粘贴到终端，等待发送',location:'remote',sessionId:request.sessionId});
      return {kind:content.kind};
    }finally{if(this.clipboardPaste===operation)this.clipboardPaste=undefined;}
  }
  resizeTerminal(cols:number,rows:number){if(Number.isInteger(cols)&&Number.isInteger(rows)&&cols>=10&&cols<=500&&rows>=3&&rows<=300){this.terminalCols=cols;this.terminalRows=rows;this.terminal?.resize(cols,rows);}}
  async disconnect(){++this.generation;this.workspaceSetup?.abort.abort();this.workspaceSetup=undefined;this.loginContext=undefined;this.loginBrowser.block();this.closeTerminal();this.state.connection={phase:'disconnected',message:'',retryAttempt:0};this.state.metrics=null;this.state.workspacePreparation=undefined;this.publish();await this.sync.pause();}
  async syncNow(){
    const generation=this.generation;
    const workspace=this.state.connection.activeWorkspaceId?this.store.workspace(this.state.connection.activeWorkspaceId):undefined;
    if(workspace)await this.sync.ensure(workspace,this.store.node(workspace.nodeId));
    if(generation!==this.generation)return this.state.sync;
    const state=await this.sync.flush();
    if(state.phase==='ready'&&workspace&&this.state.connection.activeWorkspaceId===workspace.id){
      const node=this.store.node(workspace.nodeId);
      if(this.workspaceSetup?.failed)this.startWorkspaceSetup(node,workspace,this.workspaceSetup.runtime,this.generation);
      await this.workspaceSetup?.promise;
      if(this.state.connection.activeWorkspaceId===workspace.id&&this.state.workspacePreparation?.phase==='ready'){
        const reference=await this.git.fetchRemoteCommits(workspace,node);if(reference)this.activity({kind:'sync',title:'Remote commits fetched',detail:reference,workspaceId:workspace.id});
      }
    }
    return state;
  }
  async pauseSync(){await this.sync.pause();}
  async resolveConflict(path:string,prefer:'local'|'remote'){if(!['local','remote'].includes(prefer))throw new Error('Invalid conflict preference');await this.sync.resolveConflict(path,prefer);}
  async openLocalPath(id:string){await this.options.openLocal(this.store.workspace(id).localPath);}
  async openExternal(url:string){const parsed=new URL(url);if(!['https:','http:'].includes(parsed.protocol))throw new Error('Unsupported URL');if(isAuthorizationLink(url)){await this.openLoginLink(url);return;}await this.options.openURL(parsed.toString());}
  listLocalHistory(){return listLocalHistory();}
  async importHistory(request:ImportRequest){const workspace=this.store.workspace(request.workspaceId);const result=await this.importer.import(request,workspace,this.store.node(workspace.nodeId));this.activity({kind:'session',title:'History imported',detail:String(result.imported)+' sessions',workspaceId:workspace.id});return result;}
  async importProjectMemory(workspaceId:string){
    const workspace=this.store.workspace(workspaceId);
    const result=await new ProjectMemoryImporter(this.options.resourcesDir).import(workspace,this.store.node(workspace.nodeId));
    this.activity({kind:'session',title:'项目记忆已导入',detail:`新增 ${result.imported} 份，${result.unchanged} 份相同，${result.conflicts.length} 份存在差异并已保留远端版本。`,workspaceId});
    return result;
  }
  async resumeImported(workspaceId:string,transcriptPath:string){
    if(this.switchingProvider)throw new Error('正在更新提供商，请稍后再续接会话。');
    const workspace=this.store.workspace(workspaceId);if(!transcriptPath.startsWith('/')||!transcriptPath.includes('/.local/share/happypanda/')||transcriptPath.includes('..')||!transcriptPath.endsWith('.jsonl')||/[\r\n\0]/.test(transcriptPath))throw new Error('Invalid imported transcript path');
    const node=this.store.node(workspace.nodeId);const session=this.createSession(node,workspace,'claude',transcriptPath);await this.attach(node,workspace,session);
  }
  async addPortForward(remotePort:number,requestedLocalPort?:number):Promise<PortForward>{
    if(!Number.isInteger(remotePort)||remotePort<1||remotePort>65535)throw new Error('Invalid remote port');
    const node=this.store.node(this.state.connection.activeNodeId??'');
    const localPort=requestedLocalPort??await new Promise<number>((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=(server.address() as import('node:net').AddressInfo).port;server.close(()=>resolve(port));});});
    if(!Number.isInteger(localPort)||localPort<1024||localPort>65535)throw new Error('Invalid local port');
    const child=spawn(sshExecutable(),[...sshArgs(node),'-v','-o','ExitOnForwardFailure=yes','-N','-L','127.0.0.1:'+localPort+':127.0.0.1:'+remotePort,node.sshTarget],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    await new Promise<void>((resolve,reject)=>{let error='';let settled=false;const finish=(cause?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);if(cause){child.kill();reject(cause);}else resolve();};const timer=setTimeout(()=>finish(new Error('Port forwarding connection timed out')),25000);child.stderr?.on('data',data=>{error=(error+data.toString()).slice(-8192);if(error.includes('Local forwarding listening on 127.0.0.1 port '+localPort+'.'))finish();});child.once('error',cause=>finish(cause));child.once('exit',code=>finish(new Error('Port forwarding exited '+code)));});
    const forward={id:randomUUID(),localPort,remotePort,nodeId:node.id};this.forwards.set(forward.id,{process:child,forward});child.once('exit',()=>{if(this.forwards.delete(forward.id))this.activity({kind:'connection',title:'Port forwarding closed',detail:'127.0.0.1:'+localPort});});this.publish();return forward;
  }
  async removePortForward(id:string){const entry=this.forwards.get(id);if(entry){this.forwards.delete(id);entry.process.kill();this.publish();}}
  async dispose(){await this.disconnect();await this.loginBrowser.dispose();for(const entry of this.forwards.values())entry.process.kill();this.forwards.clear();await this.sync.dispose();await this.bridge.stop();await this.store.save();}
}
