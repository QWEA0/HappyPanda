import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,mkdtemp,rm,realpath} from 'node:fs/promises';
import {join,resolve,relative,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import stripAnsi from 'strip-ansi';
import * as pty from 'node-pty';
import {SshAuthentication,sshEnvironment} from '../src/main/ssh-auth';
import {InventoryStore} from '../src/main/store';
import {prepareRemoteRuntime,runRemote,remoteHome,remoteLaunchCommand,remoteCommandArguments,sshExecutable,scpExecutable,sshArgs,shellQuote,closeSshChannels,uploadFile,downloadFile} from '../src/main/ssh';
import {remoteFileOperation} from '../src/main/sync/remote';
import {windowsGit} from '../src/main/windows-git';
import {GitWorkspace} from '../src/main/git';
import {WorkspaceSync} from '../src/main/sync';
import {prepareWindowsMutagen} from '../src/main/windows-mutagen';
import type {ServiceNode,Workspace} from '../src/shared/types';

const dataDir=process.env.HAPPYPANDA_DATA_DIR??join(process.env.APPDATA??'', 'HappyPanda');
const inventory=JSON.parse(await readFile(join(dataDir,'inventory.json'),'utf8'));
const saved=inventory.nodes.find((node:ServiceNode)=>node.id===process.argv[2]);
if(!saved)throw new Error('Usage: npm run smoke:windows -- <saved-node-id>; keep the desktop credential broker running');
const node:ServiceNode={id:saved.id,name:saved.name,sshTarget:saved.sshTarget,user:saved.user,port:saved.port,authType:saved.authType,createdAt:saved.createdAt};
const sessionId=randomUUID(),id='windows-smoke-'+sessionId;
const scratch=await mkdtemp(join(tmpdir(),'hp-windows-smoke-'));
// Delegate credential access to the running desktop; credentials are never logged or persisted by this fixture.
const auth=new SshAuthentication({dataDir:join(scratch,'authentication'),resourcesDir:resolve('resources'),store:{nodes:[node],password:()=>execFileSync(join(dataDir,'ssh-transport','askpass.exe'),['Password:'],{
  windowsHide:true,encoding:'utf8',env:{...process.env,HAPPYPANDA_SSH_CONFIG:join(dataDir,'ssh-transport','config.json'),HAPPYPANDA_SSH_NODE:node.id}}).replace(/\r?\n$/,'')} as unknown as InventoryStore,
  sshExecutable:sshExecutable(),scpExecutable:scpExecutable()});
const report:{checks:Record<string,boolean>;error?:string}={checks:{}};
const terminals=new Set<pty.IPty>();let remotePath='',configPath='',helperPath='';let sync:WorkspaceSync|undefined;
const python=(script:string,input?:string|Buffer)=>runRemote(node,'python3 -c '+shellQuote(script),input,90000);
function terminal(command:string){
  const process=pty.spawn(sshExecutable(),[...sshArgs(node),'-tt',node.sshTarget,...remoteCommandArguments(node,command)],{
    name:'xterm-256color',cols:110,rows:34,cwd:scratch,useConptyDll:true,env:sshEnvironment(node)});
  terminals.add(process);let output='';const watchers=new Set<()=>void>();let exited=false;
  process.onData(data=>{output=(output+data).slice(-512000);for(const check of watchers)check();});
  process.onExit(()=>{exited=true;terminals.delete(process);for(const check of watchers)check();});
  const wait=(value:string)=>new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{watchers.delete(check);reject(new Error('Terminal did not emit '+value+': '+output.slice(-5000)));},25000);
    const check=()=>{if(output.includes(value)||stripAnsi(output).replace(/\s/g,'').includes(value.replace(/\s/g,''))){clearTimeout(timer);watchers.delete(check);resolve();}else if(exited){clearTimeout(timer);watchers.delete(check);reject(new Error('Terminal exited: '+output.slice(-5000)));}};watchers.add(check);check();});
  return {process,wait,output:()=>output};
}
try{
  await auth.start();await auth.prepare(node);
  const runtime=await prepareRemoteRuntime(node);assert.equal(runtime.platform,'windows');
  const home=await remoteHome(node);remotePath=home+'/.local/share/happypanda/workspaces/'+id;
  const config={nodeId:node.id,sessionId,remotePath,kind:'shell',tmuxName:'hp-'+sessionId.replaceAll('-',''),sshTarget:node.sshTarget,
    remotePort:65520,token:'synthetic-'+randomUUID(),platform:'windows',nodeExecutable:runtime.node};
  const bootstrap=await readFile('resources/bootstrap.py','utf8');const helper=await readFile('resources/hp_remote.py');
  const result=JSON.parse(await python(bootstrap,JSON.stringify({config,helper:helper.toString('base64'),windowsRuntime:(await readFile('resources/windows-runtime.json.gz')).toString('base64')})));
  configPath=result.configPath;helperPath=result.helperPath;report.checks.nativeBootstrap=true;
  if(!process.argv.includes('--cli-only')){
  const launch=await remoteLaunchCommand(node,helperPath,configPath);const first=terminal(launch);
  await first.wait('\x1b]777;happypanda-ready\x07');
  first.process.write('$global:HappyPandaSmoke=6*7; Write-Output ("HP_NATIVE_"+$global:HappyPandaSmoke)\r');await first.wait('HP_NATIVE_42');
  first.process.write('\x03');first.process.write('Write-Output ("HP_INTERRUPT_"+$global:HappyPandaSmoke)\r');await first.wait('HP_INTERRUPT_42');report.checks.ctrlCKeepsTerminalAlive=true;
  const before=JSON.parse(await python('import json,pathlib;print((pathlib.Path('+JSON.stringify(configPath)+').parent/"windows-session.json").read_text())'));
  first.process.kill();terminals.delete(first.process);
  const second=terminal(launch);await second.wait('\x1b]777;happypanda-ready\x07');
  second.process.write('Write-Output ("HP_RECONNECT_"+$global:HappyPandaSmoke)\r');await second.wait('HP_RECONNECT_42');
  const after=JSON.parse(await python('import json,pathlib;print((pathlib.Path('+JSON.stringify(configPath)+').parent/"windows-session.json").read_text())'));
  assert.equal(after.pid,before.pid);report.checks.conptyAndReconnectPreserveProcess=true;
  second.process.resize(130,40);second.process.write('Write-Output ("HP_RESIZE_"+[Console]::WindowWidth)\r');await second.wait('HP_RESIZE_130');report.checks.terminalResize=true;
  const source=join(scratch,'upload.txt');await writeFile(source,'native Windows upload');await uploadFile(node,source,remotePath+'/upload.txt');
  const downloaded=join(scratch,'download.txt');await downloadFile(node,downloaded,remotePath+'/upload.txt');assert.equal(await readFile(downloaded,'utf8'),'native Windows upload');report.checks.nativeScp=true;
  const file=await remoteFileOperation<{exists:boolean;bytes:number}>(runRemote,node,{action:'inspect',root:remotePath,relative:'upload.txt'});assert.equal(file.bytes,21);report.checks.windowsFileOperations=true;
  const metrics=JSON.parse(await python('import json,runpy;h=runpy.run_path('+JSON.stringify(helperPath)+');c=h["load"]('+JSON.stringify(configPath)+');print(json.dumps(h["metrics"](c,{})))'));
  assert.match(metrics.os,/Windows/);assert.ok(metrics.memoryTotal>0);assert.ok(metrics.cpuCount>0);report.checks.windowsMetrics=true;
  const alpha=join(scratch,'project');await mkdir(alpha);await writeFile(join(alpha,'local.txt'),'local to Windows');
  const workspace:Workspace={id,nodeId:node.id,name:'Native smoke',localPath:alpha,remotePath:remotePath+'/project',localAccess:false,syncSessionName:'hp-native-'+sessionId.replaceAll('-',''),createdAt:''};
  const transport=auth.directory;
  await prepareWindowsMutagen(node,scratch,resolve('resources'));
  sync=new WorkspaceSync({dataDir:join(scratch,'sync'),onState:()=>{},runRemote,uploadFile,mutagenPath:resolve('.local/tools/mutagen.exe'),pollIntervalMs:0,
    prepareSsh:async()=>({target:node.sshTarget,user:node.user,port:node.port,mutagenSshPath:transport,scpPath:scpExecutable(),managesIdentity:true})});
  const ensured=await sync.ensure(workspace,node);assert.notEqual(ensured.phase,'error',ensured.message);
  const flushed=await sync.flush();assert.equal(flushed.phase,'ready',flushed.message);
  await python('import pathlib;p=pathlib.Path('+JSON.stringify(workspace.remotePath)+');assert(p/"local.txt").read_text()=="local to Windows";(p/"remote.txt").write_text("Windows to local")');
  const reverse=await sync.flush();assert.equal(reverse.phase,'ready',reverse.message);assert.equal(await readFile(join(alpha,'remote.txt'),'utf8'),'Windows to local');report.checks.nativeBidirectionalSync=true;
  const {runProcess}=await import('../src/main/ssh');
  await runProcess('git',['-C',alpha,'init','-q']);await runProcess('git',['-C',alpha,'config','user.name','Native fixture']);await runProcess('git',['-C',alpha,'config','user.email','fixture@example.invalid']);await runProcess('git',['-C',alpha,'add','.']);await runProcess('git',['-C',alpha,'commit','-qm','Fixture baseline']);
  const git=new GitWorkspace(scratch);assert.equal(await git.bootstrap(workspace,node),true);assert.equal((await windowsGit(node,workspace.remotePath,'existing')).trim(),'existing');report.checks.nativeGitBootstrap=true;
  await windowsGit(node,workspace.remotePath,'git',{args:['-c','user.name=Native fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','Native remote commit']});
  const gitResult=await git.syncRemoteCommits(workspace,node);assert.equal(gitResult.updated,true,gitResult.message);report.checks.nativeGitCommitReturn=true;
  }
  const claudeId=randomUUID();let claudeConfigPath='',claudeTerminal:ReturnType<typeof terminal>|undefined;
  try{
    const claudeConfig={...config,sessionId:claudeId,kind:'claude',tmuxName:'hp-'+claudeId.replaceAll('-',''),provider:{fingerprint:'official',env:{}}};
    const claudeRuntime=JSON.parse(await python(bootstrap,JSON.stringify({config:claudeConfig,helper:helper.toString('base64'),windowsRuntime:(await readFile('resources/windows-runtime.json.gz')).toString('base64')})));
    claudeConfigPath=claudeRuntime.configPath;
    claudeTerminal=terminal(await remoteLaunchCommand(node,claudeRuntime.helperPath,claudeRuntime.configPath));
    await claudeTerminal.wait('\x1b]777;happypanda-ready\x07');
    try{await claudeTerminal.wait('Claude Code');}catch{
      const detail=stripAnsi(claudeTerminal.output()).replace(/https?:\/\/\S+/g,'[URL]').replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,'[ACCOUNT]').replace(/sk-ant-[A-Za-z0-9_-]+/g,'[REDACTED]').slice(-1800);
      throw new Error('Native Claude interface did not become ready; no conversation was submitted: '+detail);
    }
    const state=JSON.parse(await python('import pathlib;print((pathlib.Path('+JSON.stringify(claudeConfigPath)+').parent/"windows-session.json").read_text())'));
    assert.equal(state.phase,'running','Native Claude process exited before becoming interactive');
    report.checks.nativeClaudeInterface=true;
  }finally{
    claudeTerminal?.process.kill();
    if(claudeConfigPath){
      await runRemote(node,'python3 '+shellQuote(helperPath)+' stop '+shellQuote(claudeConfigPath)).catch(()=>{});
      await python('import pathlib,shutil,time;p=pathlib.Path('+JSON.stringify(claudeConfigPath)+').parent;b=pathlib.Path.home()/".local/share/happypanda/runtime";assert p.resolve()==(b/'+JSON.stringify(claudeId)+').resolve();time.sleep(1);shutil.rmtree(p,ignore_errors=True)').catch(()=>{});
    }
  }
}catch(error){report.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{
  for(const process of terminals)try{process.kill();}catch{}
  await sync?.dispose().catch(error=>{report.error??=String(error);process.exitCode=1;});
  if(configPath&&helperPath)await runRemote(node,'python3 '+shellQuote(helperPath)+' stop '+shellQuote(configPath)).catch(()=>{});
  if(remotePath&&configPath){
    await python('import pathlib,shutil,time;b=pathlib.Path.home()/".local/share/happypanda";r=pathlib.Path('+JSON.stringify(remotePath)+');c=pathlib.Path('+JSON.stringify(configPath)+').parent;assert r.resolve()==(b/"workspaces"/'+JSON.stringify(id)+').resolve();assert c.resolve()==(b/"runtime"/'+JSON.stringify(sessionId)+').resolve();time.sleep(1);shutil.rmtree(r,ignore_errors=True);shutil.rmtree(c,ignore_errors=True)').catch(()=>{});
  }
  closeSshChannels();await auth.dispose();await mkdir('.local',{recursive:true});await writeFile(process.argv.includes('--cli-only')?'.local/windows-cli-smoke-result.json':'.local/windows-remote-smoke-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  const canonical=await realpath(scratch);const root=await realpath(tmpdir());if(!relative(root,canonical).startsWith('..')&&basename(canonical).startsWith('hp-windows-smoke-'))await rm(canonical,{recursive:true,force:true});
}
process.exit(process.exitCode??0);
