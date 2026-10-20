import assert from 'node:assert/strict';
import { randomBytes,randomUUID,createHash } from 'node:crypto';
import { mkdir,mkdtemp,readFile,writeFile,realpath,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { join,resolve,relative,isAbsolute } from 'node:path';
import { AppController } from '../src/main/controller';
import { HistoryImporter } from '../src/main/history';
import { remoteBridgePort } from '../src/main/mcp';
import { runRemote,uploadFile,shellQuote } from '../src/main/ssh';
import { smokeNode } from './smoke-node';

const node=smokeNode();
const root=resolve('.');
const scratch=await mkdtemp(join(tmpdir(),'happypanda-smoke-'));
const project=join(scratch,'project');await mkdir(project);
const dataDir=join(root,'.local','smoke-'+randomUUID());
const token=randomBytes(32).toString('hex');
const result:Record<string,unknown>={startedAt:new Date().toISOString(),checks:{}};
const checks=result.checks as Record<string,unknown>;
let lastPhase='';
const controller=new AppController({dataDir,resourcesDir:join(root,'resources'),token,
  pickDirectory:async()=>project,openLocal:async()=>{},openURL:async()=>{},
  emit:event=>{if(event.type==='state'&&event.state.connection.phase!==lastPhase){lastPhase=event.state.connection.phase;console.log('connection:',lastPhase,event.state.connection.message);}},
});
let workspace:Awaited<ReturnType<AppController['chooseWorkspace']>>=null;
async function waitFor(predicate:()=>boolean,timeout=120000){const start=Date.now();while(!predicate()){if(controller.snapshot().connection.phase==='failed')throw new Error(controller.snapshot().connection.message);if(Date.now()-start>timeout)throw new Error('Timed out waiting for state; '+JSON.stringify(controller.snapshot().connection));await new Promise(resolve=>setTimeout(resolve,200));}}

async function mcpSmoke(workspaceId:string){
  const remoteClient=await readFile(join(root,'scripts','mcp-smoke-client.py'));
  const port=remoteBridgePort(node.id,token);
  const command='python3 -c '+shellQuote('import base64;exec(base64.b64decode('+JSON.stringify(remoteClient.toString('base64'))+'))');
  const request=JSON.stringify({token,url:'http://127.0.0.1:'+port+'/mcp',workspaceId,opId:'smoke-'+randomUUID()});
  return JSON.parse(await runRemote(node,command,request,150000));
}

try{
  await writeFile(join(project,'hello.txt'),'happypanda-local-before\n');
  await controller.initialize();controller.store.nodes=[node];await controller.store.save();workspace=await controller.chooseWorkspace(node.id);assert(workspace);
  await controller.setLocalAccess(workspace.id,true);
  await controller.connect(node.id,workspace.id);
  await waitFor(()=>controller.snapshot().connection.phase==='connected');
  await waitFor(()=>controller.snapshot().workspacePreparation?.phase==='ready');
  assert.equal((await runRemote(node,'cat '+shellQuote(workspace.remotePath+'/hello.txt'))).trim(),'happypanda-local-before');checks.localToRemote=true;
  await runRemote(node,'printf "happypanda-remote-after\\n" > '+shellQuote(workspace.remotePath+'/hello.txt'));
  assert.equal((await controller.workspaceSync(workspace.id).flush()).phase,'ready');assert.equal((await readFile(join(project,'hello.txt'),'utf8')).trim(),'happypanda-remote-after');checks.remoteToLocal=true;
  const localResults=await mcpSmoke(workspace.id);assert(localResults.read&&localResults.exec&&localResults.output&&localResults.idempotent);checks.remoteMcpRead=true;checks.remoteMcpExec=true;checks.realCommandOutput=true;checks.operationDeduplication=true;
  const forward=await controller.addPortForward(22);
  const banner=await new Promise<string>((resolve,reject)=>{const socket=createConnection({host:'127.0.0.1',port:forward.localPort});let text='';const timeout=setTimeout(()=>{socket.destroy();reject(new Error('Forwarded SSH banner timed out'));},10000);socket.on('data',chunk=>{text+=chunk.toString();if(text.includes('SSH-2.0')){clearTimeout(timeout);socket.destroy();resolve(text);}});socket.once('error',error=>{clearTimeout(timeout);reject(error);});});
  assert(banner.includes('SSH-2.0'));assert(controller.snapshot().portForwards?.some(item=>item.id===forward.id));await controller.removePortForward(forward.id);assert(!controller.snapshot().portForwards?.some(item=>item.id===forward.id));checks.previewTunnel=true;
  const sessionId=controller.snapshot().connection.activeSessionId;
  await controller.disconnect();await controller.connect(node.id,workspace.id,sessionId);await waitFor(()=>controller.snapshot().connection.phase==='connected');assert.equal(controller.snapshot().connection.activeSessionId,sessionId);checks.sameSessionReconnect=true;
  await waitFor(()=>controller.snapshot().metrics!==null,30000);checks.serverMetrics=true;checks.authenticated=controller.snapshot().metrics?.authenticated;
  const plainTerminal=()=>controller.snapshot().terminalBuffer.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
  await waitFor(()=>plainTerminal().includes('Claude')||plainTerminal().includes('Select login'),30000);
  checks.claudeTui=true;
  const fixtureConfig=join(scratch,'claude');const fixtureProjects=join(fixtureConfig,'projects','fixture-project');await mkdir(fixtureProjects,{recursive:true});
  const fixtureId=randomUUID();const fixtureTranscript=join(fixtureProjects,fixtureId+'.jsonl');
  await writeFile(fixtureTranscript,JSON.stringify({type:'user',uuid:randomUUID(),parentUuid:null,sessionId:fixtureId,cwd:project,version:'2.1.198',message:{role:'user',content:'Synthetic migration fixture'}})+'\n');
  const importer=new HistoryImporter({dataDir,configDir:fixtureConfig,runRemote,uploadFile});
  const imported=await importer.import({workspaceId:workspace.id,sessionPaths:[fixtureTranscript]},workspace,node);assert.equal(imported.imported,1);const firstBytes=await runRemote(node,'cat '+shellQuote(imported.remotePaths[0]));assert.equal(firstBytes,await readFile(fixtureTranscript,'utf8'));checks.fixtureHistoryPreserved=true;
  const again=await importer.import({workspaceId:workspace.id,sessionPaths:[fixtureTranscript]},workspace,node);assert.equal(again.imported,0);assert.deepEqual(again.remotePaths,imported.remotePaths);checks.historyRepeatChecksum=true;
  result.ok=true;result.finishedAt=new Date().toISOString();console.log(JSON.stringify(result,null,2));
}catch(error){result.ok=false;result.error=error instanceof Error?error.message:String(error);console.error(JSON.stringify(result,null,2));process.exitCode=1;}
finally{
  const sessions=controller.store.sessions;
  await controller.dispose().catch(error=>console.error('cleanup:',error.message));
  for(const session of sessions)await runRemote(node,'tmux -L happypanda kill-session -t '+shellQuote(session.tmuxName)+' 2>/dev/null || true').catch(()=>{});
  await mkdir(join(root,'.local'),{recursive:true});await writeFile(join(root,'.local','remote-smoke-result.json'),JSON.stringify(result,null,2));
  const resolvedScratch=await realpath(scratch);const tempRoot=await realpath(tmpdir());const within=relative(tempRoot,resolvedScratch);if(within&&!within.startsWith('..')&&!isAbsolute(within)&&resolvedScratch.includes('happypanda-smoke-'))await rm(resolvedScratch,{recursive:true});
}
process.exit(process.exitCode??0);
