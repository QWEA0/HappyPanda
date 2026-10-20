import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { mkdtemp,realpath,rm,readFile,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename,isAbsolute,join,relative,resolve } from 'node:path';
import { createHash } from 'node:crypto';

const mocks=vi.hoisted(()=>({terminals:[] as any[],spawn:vi.fn(),remote:vi.fn(),clipboard:vi.fn()}));
const syncMocks=vi.hoisted(()=>({ensure:vi.fn(),wait:vi.fn(),flush:vi.fn(),state:vi.fn(),pause:vi.fn(),instances:[] as any[]}));
const tunnelMocks=vi.hoisted(()=>({acquire:vi.fn(),release:vi.fn()}));
const emitted=vi.hoisted(()=>[] as any[]);
const gitMocks=vi.hoisted(()=>({sync:vi.fn(),bootstrap:vi.fn()}));
vi.mock('node-pty',()=>({spawn:mocks.spawn}));
vi.mock('../src/main/ssh',async importOriginal=>{
  const actual=await importOriginal<typeof import('../src/main/ssh')>();
  return {...actual,runRemote:mocks.remote,prepareRemoteRuntime:async()=>({platform:'posix' as const}),remoteLaunchCommand:async(_node:any,helper:string,config:string)=>'python3 '+actual.shellQuote(helper)+' launch '+actual.shellQuote(config)};
});
vi.mock('../src/main/sync',()=>({WorkspaceSync:class{
  constructor(options:any){syncMocks.state.mockImplementation(options.onState);syncMocks.instances.push(options);}
  pause=syncMocks.pause;dispose=async()=>{};
  ensure=syncMocks.ensure;waitUntilReady=syncMocks.wait;flush=syncMocks.flush;
}}));
vi.mock('../src/main/git',()=>({GitWorkspace:class{bootstrap=gitMocks.bootstrap;syncRemoteCommits=gitMocks.sync;}}));
vi.mock('../src/main/tunnel',()=>({BridgeTunnels:class{acquire=(...args:any[])=>{tunnelMocks.acquire(...args);return {ready:async()=>{},release:tunnelMocks.release};};dispose(){}}}));
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AppController } from '../src/main/controller';
import { TEST_NODE } from './fixtures/node';
import { workspaceSyncLabel,workspaceSyncTone } from '../src/renderer/src/format';
import { terminalSizeMark } from '../src/shared/terminal';

let controller:AppController|undefined;
let directory:string;
beforeEach(async()=>{
  directory=await mkdtemp(join(tmpdir(),'hp-connection-'));
  await mkdir(join(directory,'project'));
  mocks.terminals.length=0;mocks.spawn.mockReset();mocks.remote.mockReset();emitted.length=0;syncMocks.instances.length=0;tunnelMocks.acquire.mockReset();tunnelMocks.release.mockReset();
  mocks.clipboard.mockReset().mockResolvedValue({kind:'empty'});
  syncMocks.ensure.mockReset().mockResolvedValue({phase:'scanning',message:'Scanning',conflicts:[]});syncMocks.wait.mockReset();syncMocks.flush.mockReset();syncMocks.state.mockReset();
  gitMocks.sync.mockReset().mockResolvedValue({phase:'ready',message:'Git commits synchronized'});
  gitMocks.bootstrap.mockReset().mockResolvedValue(false);syncMocks.pause.mockReset().mockResolvedValue(undefined);
  mocks.remote.mockResolvedValue(JSON.stringify({configPath:'/home/ubuntu/.local/share/happypanda/test/config.json',helperPath:'/home/ubuntu/.local/share/happypanda/hp_remote.py'}));
  mocks.spawn.mockImplementation(()=>{
    const terminal={write:vi.fn(),resize:vi.fn(),kill:vi.fn(),data:undefined as undefined|((data:string)=>void),exit:undefined as undefined|((value:{exitCode:number})=>void),onData:vi.fn(),onExit:vi.fn()};
    terminal.onData.mockImplementation(callback=>{terminal.data=callback;});
    terminal.onExit.mockImplementation(callback=>{terminal.exit=callback;});
    mocks.terminals.push(terminal);return terminal;
  });
  controller=new AppController({dataDir:join(directory,'app-data'),resourcesDir:resolve('resources'),token:'isolated-test-token',emit:event=>{emitted.push(event);},readClipboard:mocks.clipboard,pickDirectory:async()=>null,openLocal:async()=>{},openURL:async()=>{},encryption:{available:()=>true,encrypt:value=>Buffer.from(value).reverse(),decrypt:value=>Buffer.from(value).reverse().toString()}});
  await controller.initialize();controller.store.nodes=[{...TEST_NODE}];vi.useFakeTimers();
});

describe('SSH authentication failures',()=>{
  it('recognizes terminal readiness before a large native startup repaint',async()=>{
    await controller!.connect('test-node');
    mocks.terminals.at(-1).data('\x1b]777;happypanda-ready\x07'+'native terminal output'.repeat(100));
    expect(controller!.snapshot().connection.phase).toBe('connected');
  });
  it('stops reconnecting when authentication fails before terminal startup',async()=>{
    mocks.remote.mockRejectedValue(new Error('fixture@host: Permission denied (password).'));
    await controller!.connect('test-node');
    expect(controller!.snapshot().connection.phase).toBe('failed');
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.remote).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

describe('clipboard paste session ownership',()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=','base64');
  const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
  const request=()=>({nodeId:'test-node',sessionId:controller!.snapshot().connection.activeSessionId!,bracketedPaste:true});
  const remotePath=(sessionId:string)=>'/home/test/.local/share/happypanda/attachments/'+hash('test-node\0'+sessionId)+'/'+hash(png)+'.png';
  const response=(sessionId:string)=>JSON.stringify({path:remotePath(sessionId),sha256:hash(png),bytes:png.length});
  async function connect(){await controller!.connect('test-node');mocks.terminals.at(-1).data('\x1b]777;happypanda-ready\x07');}
  it('uploads a phone image through the PC without reading its clipboard',async()=>{
    await connect();const target=request();mocks.remote.mockResolvedValueOnce(response(target.sessionId));
    await expect(controller!.pasteImage(target,png)).resolves.toEqual({kind:'image'});
    expect(mocks.clipboard).not.toHaveBeenCalled();
    expect(mocks.terminals[0].write).toHaveBeenCalledExactlyOnceWith('\x1b[200~ \''+remotePath(target.sessionId)+'\' \x1b[201~');
    await expect(controller!.pasteImage(target,Buffer.from('invalid-image'))).rejects.toThrow('PNG');
  });
  it('does not insert a phone image after PC reclaims control during upload',async()=>{
    await connect();const target=request();let allowed=true;let finish!:(value:string)=>void;
    mocks.remote.mockImplementationOnce(()=>new Promise<string>(resolve=>{finish=resolve;}));
    const pending=controller!.pasteImage(target,png,()=>allowed);
    const rejection=expect(pending).rejects.toThrow('变更');
    await vi.waitFor(()=>expect(mocks.remote).toHaveBeenCalledTimes(2));
    allowed=false;finish(response(target.sessionId));await rejection;
    expect(mocks.terminals[0].write).not.toHaveBeenCalled();
    await expect(controller!.pasteImage(target,png,()=>false)).rejects.toThrow('未连接');
    expect(mocks.remote).toHaveBeenCalledTimes(2);
  });
  it('pastes text with the active terminal mode and does not read a disconnected clipboard',async()=>{
    await expect(controller!.pasteClipboard({nodeId:'test-node',sessionId:'missing',bracketedPaste:true})).rejects.toThrow('未连接');
    expect(mocks.clipboard).not.toHaveBeenCalled();
    await connect();mocks.clipboard.mockResolvedValue({kind:'text',text:'中文\ntext'});
    await controller!.pasteClipboard(request());
    expect(mocks.terminals[0].write).toHaveBeenCalledExactlyOnceWith('\x1b[200~中文\rtext\x1b[201~');
    expect(mocks.remote).toHaveBeenCalledTimes(1);
  });
  it('writes a verified image path once, without submitting, and rejects duplicate in-flight pastes',async()=>{
    await connect();const original=request();mocks.clipboard.mockResolvedValue({kind:'image',png});
    let finish!:(value:string)=>void;
    mocks.remote.mockImplementationOnce(()=>new Promise<string>(resolve=>{finish=resolve;}));
    const pending=controller!.pasteClipboard(original);
    await vi.waitFor(()=>expect(mocks.remote).toHaveBeenCalledTimes(2));
    expect(mocks.terminals[0].write).not.toHaveBeenCalled();
    await expect(controller!.pasteClipboard(original)).rejects.toThrow('正在粘贴');
    finish(response(original.sessionId));expect(await pending).toEqual({kind:'image'});
    expect(mocks.terminals[0].write).toHaveBeenCalledExactlyOnceWith('\x1b[200~ \''+remotePath(original.sessionId)+'\' \x1b[201~');
    expect(mocks.terminals[0].write.mock.calls[0][0]).not.toMatch(/[\r\n]/);
  });
  it('does not insert a failed upload and allows retry',async()=>{
    await connect();mocks.clipboard.mockResolvedValue({kind:'image',png});
    mocks.remote.mockRejectedValueOnce(new Error('Synthetic upload failure'));
    await expect(controller!.pasteClipboard(request())).rejects.toThrow('Synthetic upload failure');
    expect(mocks.terminals[0].write).not.toHaveBeenCalled();
    mocks.remote.mockResolvedValueOnce(response(request().sessionId));
    expect(await controller!.pasteClipboard(request())).toEqual({kind:'image'});
    expect(mocks.terminals[0].write).toHaveBeenCalledTimes(1);
  });
  it.each(['disconnect','reconnect','switch'])('does not paste into a stale PTY after %s during image upload',async(action)=>{
    await connect();const original=request();mocks.clipboard.mockResolvedValue({kind:'image',png});
    let finish!:(value:string)=>void;mocks.remote.mockImplementationOnce(()=>new Promise<string>(resolve=>{finish=resolve;}));
    const pending=controller!.pasteClipboard(original);
    const rejection=expect(pending).rejects.toThrow('变更');
    await vi.waitFor(()=>expect(mocks.remote).toHaveBeenCalledTimes(2));
    await controller!.disconnect();
    if(action!=='disconnect'){
      if(action==='switch')controller!.store.nodes[0].lastSessionId=undefined;
      await controller!.connect('test-node',undefined,action==='reconnect'?original.sessionId:undefined);
      mocks.terminals.at(-1).data('\x1b]777;happypanda-ready\x07');
      if(action==='switch')expect(request().sessionId).not.toBe(original.sessionId);
    }
    finish(response(original.sessionId));await rejection;
    for(const terminal of mocks.terminals)expect(terminal.write).not.toHaveBeenCalled();
  });
});

describe('provider switching',()=>{
  const input={name:'Synthetic gateway',baseUrl:'https://gateway.example.com',token:'synthetic-test-secret',authType:'auth-token' as const,disableNonessentialTraffic:true};
  it('reloads the same Claude session, transports secrets only through SSH stdin, and waits for readiness',async()=>{
    await controller!.connect('test-node');
    mocks.terminals[0].data('\x1b]777;happypanda-ready\x07');
    const sessionId=controller!.snapshot().connection.activeSessionId;
    const provider=await controller!.saveProvider(input);
    let completed=false;
    const switchResult=controller!.selectProvider('test-node',provider.id).then(()=>{completed=true;});
    await vi.waitFor(()=>expect(mocks.spawn).toHaveBeenCalledTimes(2));
    expect(completed).toBe(false);
    expect(mocks.terminals[0].kill).toHaveBeenCalled();
    const [node,command,stdin]=mocks.remote.mock.calls.at(-1)!;
    expect(command).not.toContain(input.token);
    const config=JSON.parse(stdin).config;
    expect(config.provider.env.ANTHROPIC_AUTH_TOKEN).toBe(input.token);
    expect(config.reloadToken).toBeTruthy();
    expect(JSON.stringify(mocks.spawn.mock.calls)).not.toContain(input.token);
    mocks.terminals[1].data('\x1b]777;happypanda-ready\x07');
    await switchResult;
    expect(controller!.snapshot().connection.activeSessionId).toBe(sessionId);
    expect(controller!.store.sessions).toHaveLength(1);
    expect(controller!.snapshot().nodes[0].providerId).toBe(provider.id);
    expect(JSON.stringify(controller!.snapshot())).not.toContain(input.token);
    await expect(controller!.removeProvider(provider.id)).rejects.toThrow('请先');
    const official=controller!.selectProvider(node.id,null);
    await vi.waitFor(()=>expect(mocks.spawn).toHaveBeenCalledTimes(3));
    expect(JSON.parse(mocks.remote.mock.calls.at(-1)![2]).config.provider.env).toEqual({});
    mocks.terminals[2].data('\x1b]777;happypanda-ready\x07');await official;
    expect(controller!.snapshot().nodes[0].providerId).toBeUndefined();
    await controller!.removeProvider(provider.id);
  });
  it('stores a disconnected node choice without starting a session and handles invalid ids',async()=>{
    const provider=await controller!.saveProvider(input);
    await controller!.selectProvider('test-node',provider.id);
    expect(mocks.spawn).not.toHaveBeenCalled();
    await expect(controller!.selectProvider('test-node','missing')).rejects.toThrow('提供商不存在');
    expect(controller!.store.nodes[0].providerId).toBe(provider.id);
  });
  it('reports reload failures and retains the desired choice for an explicit retry',async()=>{
    await controller!.connect('test-node');mocks.terminals[0].data('\x1b]777;happypanda-ready\x07');
    const provider=await controller!.saveProvider(input);
    mocks.remote.mockRejectedValueOnce(new Error('Synthetic SSH failure'));
    await expect(controller!.selectProvider('test-node',provider.id)).rejects.toThrow('重载未完成');
    expect(controller!.snapshot().connection.phase).toBe('failed');
    expect(controller!.store.nodes[0].providerId).toBe(provider.id);
    expect(controller!.snapshot().activities.some(event=>event.title==='Claude 已按提供商配置重载')).toBe(false);
  });
  it('does not leave a switch pending when the user disconnects',async()=>{
    await controller!.connect('test-node');mocks.terminals[0].data('\x1b]777;happypanda-ready\x07');
    const provider=await controller!.saveProvider(input);
    const result=controller!.selectProvider('test-node',provider.id);
    const failed=expect(result).rejects.toThrow('重载未完成');
    await vi.waitFor(()=>expect(mocks.spawn).toHaveBeenCalledTimes(2));
    await expect(controller!.newSession()).rejects.toThrow('正在更新提供商');
    await controller!.disconnect();await failed;
    expect(controller!.snapshot().connection.phase).toBe('disconnected');
    await controller!.saveProvider({...input,name:'Can edit after cancellation'});
  });
  it('fails a reload that never receives the terminal readiness marker',async()=>{
    await controller!.connect('test-node');mocks.terminals[0].data('\x1b]777;happypanda-ready\x07');
    const provider=await controller!.saveProvider(input);
    const failed=expect(controller!.selectProvider('test-node',provider.id)).rejects.toThrow('重载未完成');
    await vi.waitFor(()=>expect(mocks.spawn).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(25000);await failed;
    expect(controller!.snapshot().connection.phase).toBe('failed');
    expect(mocks.terminals[1].kill).toHaveBeenCalled();
  });
});
afterEach(async()=>{
  vi.useRealTimers();await controller?.dispose();controller=undefined;
  const target=await realpath(directory),base=await realpath(tmpdir()),child=relative(base,target);
  if(child&&!child.startsWith('..')&&!isAbsolute(child)&&basename(target).startsWith('hp-connection-'))await rm(target,{recursive:true});
});

describe('MCP-only workspaces',()=>{
  function workspace(mode:'sync'|'mcp-only'='mcp-only'){
    const value={id:'workspace',nodeId:'test-node',name:'local-project',localPath:directory,remotePath:'/home/ubuntu/.local/share/happypanda/workspaces/workspace',mode,localAccess:mode==='mcp-only',syncSessionName:'hp-workspace',createdAt:''};
    value.localPath=join(directory,'project');controller!.store.workspaces.push(value);return value;
  }
  async function connect(){await controller!.connect('test-node','workspace');mocks.terminals.at(-1).data(']777;happypanda-ready');}
  it('connects without preparing a mirror, flushing files or bootstrapping Git and ignores old sync events',async()=>{
    workspace();await connect();
    const config=JSON.parse(mocks.remote.mock.calls[0][2]).config;
    expect(config).toMatchObject({workspaceMode:'mcp-only',waitForWorkspace:false,localPath:join(directory,'project'),localPlatform:process.platform});
    expect(config.remotePath).toBeUndefined();
    expect(controller!.snapshot().workspacePreparation?.phase).toBe('ready');
    syncMocks.state({phase:'ready',message:'Old mirror event',conflicts:[],updatedAt:''});
    expect(controller!.snapshot().sync.phase).toBe('none');
    expect(syncMocks.pause).toHaveBeenCalled();
    expect(syncMocks.ensure).not.toHaveBeenCalled();expect(syncMocks.wait).not.toHaveBeenCalled();expect(syncMocks.flush).not.toHaveBeenCalled();
    expect(gitMocks.bootstrap).not.toHaveBeenCalled();expect(gitMocks.sync).not.toHaveBeenCalled();
    await expect(controller!.syncNow()).rejects.toThrow('不使用工作区同步');
    await expect(controller!.resolveConflict('file','local')).rejects.toThrow('不使用工作区同步');
    await expect(controller!.setLocalAccess('workspace',false)).rejects.toThrow('必须开启');
    await expect(controller!.importProjectMemory('workspace')).rejects.toThrow('通过 MCP');
  });
  it('reads, writes and executes a real local command through the authenticated MCP endpoint without synchronization',async()=>{
    vi.useRealTimers();workspace();await connect();
    const client=new Client({name:'mcp-only-controller-test',version:'1'});
    try{
      const endpoint=await controller!.bridge.start();
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url),{requestInit:{headers:{Authorization:'Bearer isolated-test-token'}}}));
      const write=await client.callTool({name:'local_write_file',arguments:{workspace_id:'workspace',path:'local-only.txt',content:'MCP_ONLY_LOCAL_FILE',expected_hash:null}});
      expect(write.isError).not.toBe(true);expect(await readFile(join(directory,'project','local-only.txt'),'utf8')).toBe('MCP_ONLY_LOCAL_FILE');
      const read=await client.callTool({name:'local_read_file',arguments:{workspace_id:'workspace',path:'local-only.txt'}});
      expect(read.structuredContent).toMatchObject({content:'MCP_ONLY_LOCAL_FILE'});
      let result=await client.callTool({name:'local_exec',arguments:{workspace_id:'workspace',shell:process.platform==='win32'?'powershell':'sh',command:process.platform==='win32'?"Write-Output (Get-Content -Raw 'local-only.txt')":"cat local-only.txt",op_id:'mcp-only-real-command'}});
      await vi.waitFor(async()=>{
        const receipt=result.structuredContent as Record<string,unknown>;
        if(['requested','running'].includes(String(receipt.status)))result=await client.callTool({name:'local_job_status',arguments:{workspace_id:'workspace',job_id:receipt.job_id}});
        expect(result.structuredContent).toMatchObject({status:'completed',exit_code:0});
      },{timeout:10000});
      expect(result.isError).not.toBe(true);expect(JSON.stringify(result.structuredContent)).toContain('MCP_ONLY_LOCAL_FILE');
      expect(syncMocks.ensure).not.toHaveBeenCalled();expect(syncMocks.flush).not.toHaveBeenCalled();expect(gitMocks.bootstrap).not.toHaveBeenCalled();
    }finally{await client.close();}
  });
  it('fails before launching Claude if the previous synchronization cannot be paused',async()=>{
    workspace();syncMocks.pause.mockRejectedValueOnce(new Error('Old mirror could not be paused'));
    await controller!.connect('test-node','workspace');
    expect(controller!.snapshot().connection.phase).toBe('failed');
    expect(controller!.snapshot().workspacePreparation).toMatchObject({phase:'error',message:'Old mirror could not be paused'});
    expect(mocks.spawn).not.toHaveBeenCalled();expect(syncMocks.ensure).not.toHaveBeenCalled();
  });
  it('pauses the old mirror, persists the mode and reloads the same session before returning',async()=>{
    const value=workspace('sync');syncMocks.ensure.mockResolvedValue({phase:'ready',message:'',conflicts:[]});syncMocks.wait.mockResolvedValue(undefined);
    await connect();await vi.waitFor(()=>expect(controller!.snapshot().workspacePreparation?.phase).toBe('ready'));
    const sessionId=controller!.snapshot().connection.activeSessionId;
    const update=controller!.setWorkspaceMode('workspace','mcp-only');
    await vi.waitFor(()=>expect(mocks.spawn).toHaveBeenCalledTimes(2));
    await expect(controller!.connect('test-node','workspace')).rejects.toThrow('正在切换工作区模式');
    mocks.terminals[1].data(']777;happypanda-ready');await update;
    expect(value.localAccess).toBe(true);expect(controller!.snapshot().connection.activeSessionId).toBe(sessionId);
    expect(JSON.parse(mocks.remote.mock.calls.at(-1)![2]).config.workspaceMode).toBe('mcp-only');
    expect(JSON.parse(await readFile(join(directory,'app-data','inventory.json'),'utf8')).workspaces[0]).toMatchObject({mode:'mcp-only',localAccess:true});
    expect(syncMocks.pause).toHaveBeenCalled();expect(mocks.terminals[0].kill).toHaveBeenCalled();
  });
  it('restores normal synchronization when switching back and keeps the selection across reconnects',async()=>{
    workspace();await connect();await controller!.disconnect();await connect();
    expect(syncMocks.ensure).not.toHaveBeenCalled();
    syncMocks.ensure.mockResolvedValue({phase:'ready',message:'',conflicts:[]});syncMocks.wait.mockResolvedValue(undefined);
    const update=controller!.setWorkspaceMode('workspace','sync');
    await vi.waitFor(()=>expect(mocks.spawn).toHaveBeenCalledTimes(3));mocks.terminals[2].data(']777;happypanda-ready');await update;
    await vi.waitFor(()=>expect(gitMocks.bootstrap).toHaveBeenCalled());expect(syncMocks.ensure).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.remote.mock.calls.filter(call=>call[2]).at(-1)![2]).config).toMatchObject({workspaceMode:'sync',waitForWorkspace:true});
  });
  it('keeps a saved mode after a cancelled reload and can reconnect with it',async()=>{
    workspace();await connect();
    const update=expect(controller!.setWorkspaceMode('workspace','sync')).rejects.toThrow('重载未完成');
    await vi.waitFor(()=>expect(mocks.spawn).toHaveBeenCalledTimes(2));await controller!.disconnect();await update;
    expect(controller!.store.workspace('workspace').mode).toBe('sync');
    await controller!.setWorkspaceMode('workspace','mcp-only');await connect();
    expect(controller!.snapshot().connection.phase).toBe('connected');
  });
});

describe('remote session recovery',()=>{
  it('keeps a background tab preparing its workspace while another tab is focused',async()=>{
    await controller!.connect('test-node');mocks.terminals[0].data('\x1b]777;happypanda-ready\x07');
    const plain=controller!.snapshot().connection.activeSessionId!;
    controller!.store.workspaces.push({id:'workspace',nodeId:'test-node',name:'project',localPath:directory,remotePath:'/home/ubuntu/.local/share/happypanda/workspaces/workspace',localAccess:false,syncSessionName:'hp-workspace',createdAt:''});
    let finish!:()=>void;syncMocks.wait.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
    await controller!.connect('test-node','workspace');mocks.terminals[1].data('\x1b]777;happypanda-ready\x07');
    const project=controller!.snapshot().connection.activeSessionId!;
    await vi.waitFor(()=>expect(syncMocks.wait).toHaveBeenCalled());
    await controller!.connect('test-node',undefined,plain);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(mocks.terminals[0].kill).not.toHaveBeenCalled();expect(mocks.terminals[1].kill).not.toHaveBeenCalled();
    expect(controller!.snapshot().connection.activeWorkspaceId).toBeUndefined();
    expect(controller!.snapshot().connection.activeSessionId).toBe(plain);
    finish();await vi.waitFor(()=>expect(mocks.remote.mock.calls.some(call=>call[1].includes(' workspace-ready '))).toBe(true));
    expect(controller!.snapshot().openSessions?.find(item=>item.sessionId===project)?.phase).toBe('connected');
    expect(controller!.snapshot().connection.activeSessionId).toBe(plain);
  });
  it('cancels a pending workspace preparation when its tab closes',async()=>{
    controller!.store.workspaces.push({id:'workspace',nodeId:'test-node',name:'project',localPath:directory,remotePath:'/home/ubuntu/.local/share/happypanda/workspaces/workspace',localAccess:false,syncSessionName:'hp-workspace',createdAt:''});
    let finish!:()=>void;syncMocks.wait.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
    await controller!.connect('test-node','workspace');mocks.terminals[0].data('\x1b]777;happypanda-ready\x07');
    await vi.waitFor(()=>expect(syncMocks.wait).toHaveBeenCalled());
    await controller!.closeSession(controller!.snapshot().connection.activeSessionId!);
    expect(mocks.terminals[0].kill).toHaveBeenCalled();expect(syncMocks.pause).toHaveBeenCalledTimes(1);
    finish();await vi.advanceTimersByTimeAsync(1);
    expect(controller!.snapshot().connection.phase).toBe('disconnected');
    expect(mocks.remote.mock.calls.some(call=>call[1].includes(' workspace-ready '))).toBe(false);
  });
  it('connects SSH while initial synchronization is pending and releases Claude only when files are ready',async()=>{
    controller!.store.workspaces.push({id:'workspace',nodeId:'test-node',name:'large-project',localPath:directory,remotePath:'/home/ubuntu/.local/share/happypanda/workspaces/workspace',localAccess:false,syncSessionName:'hp-workspace',createdAt:''});
    let synchronized!:()=>void;syncMocks.wait.mockImplementation(()=>new Promise<void>(resolve=>{synchronized=resolve;}));
    await controller!.connect('test-node','workspace');
    mocks.terminals[0].data('\x1b]777;happypanda-ready\x07');
    await vi.waitFor(()=>expect(syncMocks.wait).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(121000);
    expect(controller!.snapshot().connection.phase).toBe('connected');
    expect(syncMocks.flush).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.remote.mock.calls[0][2]).config.waitForWorkspace).toBe(true);
    expect(mocks.remote.mock.calls.some(call=>call[1].includes(' workspace-ready '))).toBe(false);
    synchronized();await vi.waitFor(()=>expect(controller!.snapshot().workspacePreparation?.phase).toBe('ready'));
    expect(mocks.remote.mock.calls.some(call=>call[1].includes(' workspace-ready '))).toBe(true);
  });
  it('keeps SSH connected when workspace preparation fails and cancels obsolete initialization',async()=>{
    controller!.store.workspaces.push({id:'workspace',nodeId:'test-node',name:'project',localPath:directory,remotePath:'/home/ubuntu/.local/share/happypanda/workspaces/workspace',localAccess:false,syncSessionName:'hp-workspace',createdAt:''});
    syncMocks.ensure.mockResolvedValue({phase:'error',message:'synthetic sync failure'});
    await controller!.connect('test-node','workspace');mocks.terminals[0].data('\x1b]777;happypanda-ready\x07');
    await vi.waitFor(()=>expect(controller!.snapshot().workspacePreparation?.phase).toBe('error'));
    expect(controller!.snapshot().connection.phase).toBe('connected');
    await controller!.disconnect();
    expect(controller!.snapshot().workspacePreparation).toBeUndefined();
    expect(mocks.remote.mock.calls.some(call=>call[1].includes(' workspace-ready '))).toBe(false);
  });
  it('reattaches the same session and never replays terminal input',async()=>{
    await controller!.connect('test-node');
    const original=controller!.snapshot().connection.activeSessionId;
    mocks.terminals[0].data('\x1b]777;happypanda-ready\x07');
    controller!.writeTerminal('original prompt\r');
    expect(mocks.terminals[0].write).toHaveBeenCalledTimes(1);
    mocks.terminals[0].exit({exitCode:255});
    controller!.writeTerminal('do not queue this\r');
    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(()=>expect(mocks.spawn).toHaveBeenCalledTimes(2),{timeout:1000,interval:10});
    expect(controller!.snapshot().connection.activeSessionId).toBe(original);
    expect(controller!.store.sessions).toHaveLength(1);
    mocks.terminals[1].data('\x1b]777;happypanda-ready\x07');
    expect(mocks.terminals[1].write).not.toHaveBeenCalled();
    expect(controller!.snapshot().connection.phase).toBe('connected');
  });
  it('cancels scheduled retries when explicitly disconnected',async()=>{
    await controller!.connect('test-node');
    mocks.terminals[0].exit({exitCode:255});
    expect(controller!.snapshot().connection.phase).toBe('retrying');
    await controller!.disconnect();await vi.advanceTimersByTimeAsync(40000);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(controller!.snapshot().connection.phase).toBe('disconnected');
  });
  it('stops retries for SSH identity failures',async()=>{
    await controller!.connect('test-node');
    mocks.terminals[0].data('Permission denied (publickey).');mocks.terminals[0].exit({exitCode:255});
    await vi.advanceTimersByTimeAsync(40000);
    expect(controller!.snapshot().connection.phase).toBe('failed');
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
});

describe('automatic Git commit synchronization',()=>{
  const ready={phase:'ready',message:'Files synchronized',conflicts:[],sessionName:'hp-workspace',updatedAt:''};
  async function connect(){
    controller!.store.workspaces.push({id:'workspace',nodeId:'test-node',name:'project',localPath:directory,remotePath:'/srv/project',localAccess:false,syncSessionName:'hp-workspace',createdAt:''});
    syncMocks.ensure.mockResolvedValue(ready);syncMocks.wait.mockResolvedValue(ready);syncMocks.flush.mockResolvedValue(ready);
    await controller!.connect('test-node','workspace');mocks.terminals[0].data('\x1b]777;happypanda-ready\x07');
    await vi.waitFor(()=>expect(controller!.snapshot().workspacePreparation?.phase).toBe('ready'));
    syncMocks.state(ready);
  }
  it('checks once when ready, then only on a changed remote HEAD or a slow safety interval',async()=>{
    await connect();await vi.waitFor(()=>expect(gitMocks.sync).toHaveBeenCalledTimes(1));
    syncMocks.state(ready);await vi.advanceTimersByTimeAsync(10000);syncMocks.state(ready);await vi.advanceTimersByTimeAsync(1);
    expect(gitMocks.sync).toHaveBeenCalledTimes(1);
    const metrics=(gitHead:string)=>({type:'metrics',nodeId:'test-node',sessionId:controller!.snapshot().connection.activeSessionId,metrics:{hostname:'h',os:'Linux',cpuCount:1,load:0,memoryTotal:1,memoryAvailable:1,diskAvailable:1,uptime:1,claudeVersion:null,authenticated:true,address:'a',gitHead,sampledAt:''}});
    (controller as any).remoteEvent(metrics('a'.repeat(40)));
    await vi.waitFor(()=>expect(gitMocks.sync).toHaveBeenCalledTimes(2));
    (controller as any).remoteEvent(metrics('a'.repeat(40)));await vi.advanceTimersByTimeAsync(1);
    expect(gitMocks.sync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(61000);syncMocks.state(ready);
    await vi.waitFor(()=>expect(gitMocks.sync).toHaveBeenCalledTimes(3));
    expect(workspaceSyncLabel(controller!.snapshot().sync)).toBe('已同步');
  });
  it('checks after remote tool completion without waiting for the next idle interval',async()=>{
    await connect();await vi.waitFor(()=>expect(gitMocks.sync).toHaveBeenCalledTimes(1));
    (controller as any).remoteEvent({type:'tool',id:'commit-completed',nodeId:'test-node',sessionId:controller!.snapshot().connection.activeSessionId,event:'Stop'});
    syncMocks.state(ready);await vi.waitFor(()=>expect(gitMocks.sync).toHaveBeenCalledTimes(2));
  });
  it('shows Git conflicts separately from completed file synchronization and supports an immediate retry',async()=>{
    gitMocks.sync.mockResolvedValue({phase:'blocked',message:'Branches have diverged',reference:'refs/remotes/happypanda/workspace'});
    await connect();await vi.waitFor(()=>expect(controller!.snapshot().sync.git?.phase).toBe('blocked'));
    expect(controller!.snapshot().sync.phase).toBe('ready');expect(workspaceSyncLabel(controller!.snapshot().sync)).toBe('提交待处理');expect(workspaceSyncTone(controller!.snapshot().sync)).toBe('warning');
    gitMocks.sync.mockResolvedValue({phase:'ready',updated:true,message:'Commits synchronized'});
    expect((await controller!.syncNow()).git?.phase).toBe('ready');expect(gitMocks.sync).toHaveBeenCalledTimes(2);
  });
  it('reports transfer failures without labeling commits synchronized',async()=>{
    gitMocks.sync.mockRejectedValue(new Error('SSH failed'));
    await connect();await vi.waitFor(()=>expect(controller!.snapshot().sync.git?.phase).toBe('error'));
    expect(workspaceSyncLabel(controller!.snapshot().sync)).toBe('提交同步失败');expect(workspaceSyncTone(controller!.snapshot().sync)).toBe('danger');
    expect(controller!.snapshot().connection.phase).toBe('connected');
  });
  it('does not apply stale Git results after disconnecting and coalesces overlapping polls',async()=>{
    let finish!:(result:any)=>void;gitMocks.sync.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    await connect();await vi.waitFor(()=>expect(gitMocks.sync).toHaveBeenCalledTimes(1));
    syncMocks.state(ready);syncMocks.state(ready);expect(gitMocks.sync).toHaveBeenCalledTimes(1);
    const current=gitMocks.sync.mock.calls[0][2];expect(current()).toBe(true);
    await controller!.disconnect();expect(current()).toBe(false);
    finish({phase:'ready',updated:true,message:'Stale result'});await vi.advanceTimersByTimeAsync(1);
    expect(controller!.snapshot().activities.some(event=>event.title==='Remote commits synchronized')).toBe(false);
  });
});

describe('browser login orchestration',()=>{
  const url='https://claude.com/cai/oauth/authorize?response_type=code&state=synthetic&code_challenge=challenge&redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Fcallback';
  async function connect(){await controller!.connect('test-node');mocks.terminals[0].data('\x1b]777;happypanda-ready\x07');}
  it('keeps the current session intact if the login tunnel cannot be prepared',async()=>{
    await connect();const session=controller!.snapshot().connection.activeSessionId;
    vi.spyOn(controller!.loginBrowser,'prepare').mockRejectedValue(new Error('synthetic tunnel failure'));
    await expect(controller!.newSession('login')).rejects.toThrow('synthetic tunnel failure');
    expect(controller!.snapshot().connection.activeSessionId).toBe(session);
    expect(controller!.snapshot().connection.phase).toBe('connected');
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
  it('scopes authorization to the active login attempt and reloads the original Claude after verified success',async()=>{
    await connect();const original=controller!.snapshot().connection.activeSessionId;
    vi.spyOn(controller!.loginBrowser,'prepare').mockResolvedValue();
    const open=vi.spyOn(controller!.loginBrowser,'openAuthorization').mockResolvedValue();
    const readiness=vi.spyOn(controller!.loginBrowser,'snapshot').mockReturnValue({phase:'waiting',nodeId:'test-node',message:'',routeVerified:false});
    const loggingIn=controller!.newSession('login');
    await vi.waitFor(()=>expect(mocks.spawn).toHaveBeenCalledTimes(2));
    const config=JSON.parse(mocks.remote.mock.calls.at(-1)![2]).config;
    expect(config.nodeEgress).toBe(true);expect(config.loginAttempt).toBeTruthy();
    mocks.terminals[1].data('\x1b]777;happypanda-ready\x07');await loggingIn;
    const receive=(payload:Record<string,unknown>)=>(controller as any).remoteEvent({nodeId:'test-node',sessionId:config.sessionId,attemptId:config.loginAttempt,...payload});
    receive({type:'login-url',attemptId:'old-attempt',url});expect(open).not.toHaveBeenCalled();
    const fallback=url.replace('http%3A%2F%2Flocalhost%3A12345%2Fcallback','https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback');
    mocks.terminals[1].data('If the browser did not open, visit: '+fallback+'\r\n');
    expect(open).not.toHaveBeenCalled();
    receive({type:'login-url',url});expect(open).toHaveBeenCalledWith('test-node',url);
    mocks.terminals[1].data('If the browser did not open, visit: '+fallback+'\r\n');
    receive({type:'login-url',url:fallback});expect(open).toHaveBeenCalledTimes(1);
    readiness.mockReturnValue({phase:'ready',nodeId:'test-node',message:'',routeVerified:true});
    receive({type:'login-result',success:true});
    await vi.waitFor(()=>expect(mocks.spawn).toHaveBeenCalledTimes(3));
    mocks.terminals[2].data('\x1b]777;happypanda-ready\x07');
    expect(controller!.snapshot().connection.activeSessionId).toBe(original);
    expect(JSON.parse(mocks.remote.mock.calls.at(-1)![2]).config.nodeEgress).toBe(true);
    expect(controller!.store.nodes[0].loginViaNode).toBe(true);
  });
  it('does not accept a success event without a verified browser route and never opens an OAuth link in the default browser',async()=>{
    await expect(controller!.openExternal(url)).rejects.toThrow('当前服务器');
    await connect();vi.spyOn(controller!.loginBrowser,'prepare').mockResolvedValue();
    const login=controller!.newSession('login');await vi.waitFor(()=>expect(mocks.spawn).toHaveBeenCalledTimes(2));
    const config=JSON.parse(mocks.remote.mock.calls.at(-1)![2]).config;
    mocks.terminals[1].data('\x1b]777;happypanda-ready\x07');await login;
    (controller as any).remoteEvent({type:'login-result',nodeId:'test-node',sessionId:config.sessionId,attemptId:config.loginAttempt,success:true});
    expect(controller!.snapshot().browserLogin?.phase).toBe('failed');
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });
  it('waits for login terminal startup before handling an early success event',async()=>{
    await connect();const original=controller!.snapshot().connection.activeSessionId;
    vi.spyOn(controller!.loginBrowser,'prepare').mockResolvedValue();
    vi.spyOn(controller!.loginBrowser,'snapshot').mockReturnValue({phase:'ready',nodeId:'test-node',message:'',routeVerified:true});
    const login=controller!.newSession('login');await vi.waitFor(()=>expect(mocks.spawn).toHaveBeenCalledTimes(2));
    const config=JSON.parse(mocks.remote.mock.calls.at(-1)![2]).config;
    (controller as any).remoteEvent({type:'login-result',nodeId:'test-node',sessionId:config.sessionId,attemptId:config.loginAttempt,success:true});
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(controller!.store.nodes[0].lastSessionId).toBe(original);
    mocks.terminals[1].data('\x1b]777;happypanda-ready\x07');await login;
    await vi.waitFor(()=>expect(mocks.spawn).toHaveBeenCalledTimes(3));mocks.terminals[2].data('\x1b]777;happypanda-ready\x07');
    expect(controller!.snapshot().connection.activeSessionId).toBe(original);
  });
});

describe('concurrent sessions',()=>{
  const READY='\x1b]777;happypanda-ready\x07';
  const active=()=>controller!.snapshot().connection.activeSessionId!;
  function addWorkspace(id:string){controller!.store.workspaces.push({id,nodeId:'test-node',name:id,localPath:directory,remotePath:'/home/ubuntu/.local/share/happypanda/workspaces/'+id,localAccess:false,syncSessionName:'hp-'+id,createdAt:''});}
  async function twoTabs(){
    await controller!.connect('test-node');mocks.terminals[0].data(READY);const first=active();
    await controller!.newSession();mocks.terminals[1].data(READY);const second=active();
    return {first,second};
  }
  it('keeps every tab running, routes input and size by session and only flags background output',async()=>{
    const {first,second}=await twoTabs();
    expect(second).not.toBe(first);expect(mocks.terminals[0].kill).not.toHaveBeenCalled();
    expect(controller!.snapshot().openSessions?.map(item=>item.sessionId)).toEqual([first,second]);
    mocks.terminals[0].data('background output');
    expect(controller!.snapshot().openSessions?.find(item=>item.sessionId===first)?.unread).toBe(true);
    expect(emitted).toContainEqual({type:'terminal',data:'background output',sessionId:first,generation:expect.any(Number),end:expect.any(Number)});
    expect(controller!.getTerminalBuffer(first)).toMatchObject({end:(READY+'background output').length});
    controller!.writeTerminal('to first',first);controller!.writeTerminal('to focused');
    expect(mocks.terminals[0].write).toHaveBeenCalledExactlyOnceWith('to first');
    expect(mocks.terminals[1].write).toHaveBeenCalledExactlyOnceWith('to focused');
    controller!.resizeTerminal(120,40,first);
    expect(mocks.terminals[0].resize).toHaveBeenCalledWith(120,40);expect(mocks.terminals[1].resize).not.toHaveBeenCalled();
    controller!.focusSession(first);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    const snapshot=controller!.snapshot();
    expect(snapshot.connection.activeSessionId).toBe(first);expect(snapshot.terminalBuffer).toContain('background output');
    expect(snapshot.terminalSize).toEqual({cols:120,rows:40});
    expect(snapshot.openSessions?.find(item=>item.sessionId===first)?.unread).toBe(false);
    expect(controller!.getTerminalBuffer(second).data).toContain(READY);
    // Single-terminal clients such as the phone redraw from the newly focused scrollback.
    expect(emitted.at(-1)).toMatchObject({type:'state',resetTerminal:true,state:{connection:{activeSessionId:first}}});
    expect(emitted.at(-1).state.terminalBuffer).toContain('background output');
  });
  it('records PTY resizes in the output stream so observers and replays switch size at the right byte',async()=>{
    const {first}=await twoTabs();
    const initial=controller!.getTerminalBuffer(first);
    expect(initial.data.startsWith(terminalSizeMark(initial.cols!,initial.rows!)+READY)).toBe(true);
    mocks.terminals[0].data('wide output');
    emitted.length=0;
    controller!.resizeTerminal(45,30,first);controller!.resizeTerminal(45,30,first);
    mocks.terminals[0].data('narrow output');
    const mark=terminalSizeMark(45,30),output=READY+'wide output'+mark+'narrow output';
    expect(emitted.filter(event=>event.type!=='state')).toEqual([
      {type:'terminal',data:mark,sessionId:first,generation:expect.any(Number),end:(READY+'wide output'+mark).length},
      {type:'terminal-size',cols:45,rows:30,sessionId:first},
      {type:'terminal',data:'narrow output',sessionId:first,generation:expect.any(Number),end:output.length},
    ]);
    expect(controller!.getTerminalBuffer(first)).toMatchObject({cols:45,rows:30,end:output.length});
    expect(controller!.getTerminalBuffer(first).data.endsWith(output)).toBe(true);
  });
  it('closes one tab, focuses its neighbour and refuses to delete a session that is still open',async()=>{
    const {first,second}=await twoTabs();
    await expect(controller!.removeSession(first)).rejects.toThrow('关闭');
    await controller!.closeSession(second);
    expect(mocks.terminals[1].kill).toHaveBeenCalled();expect(mocks.terminals[0].kill).not.toHaveBeenCalled();
    expect(active()).toBe(first);expect(controller!.snapshot().connection.phase).toBe('connected');
    await controller!.closeSession(first);
    expect(controller!.snapshot().connection.phase).toBe('disconnected');expect(controller!.snapshot().openSessions).toEqual([]);
    await controller!.removeSession(first);
    expect(controller!.store.sessions.some(session=>session.id===first)).toBe(false);
  });
  it('focuses an already open session instead of reconnecting it, and reconnects only on request',async()=>{
    const {first}=await twoTabs();
    await controller!.connect('test-node',undefined,first);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);expect(active()).toBe(first);
    await controller!.reconnect();
    expect(mocks.spawn).toHaveBeenCalledTimes(3);expect(mocks.terminals[0].kill).toHaveBeenCalled();expect(mocks.terminals[1].kill).not.toHaveBeenCalled();
    expect(active()).toBe(first);
  });
  it('shares the per-node MCP tunnel and keeps reverse forwards off the terminals',async()=>{
    await twoTabs();
    expect(tunnelMocks.acquire).toHaveBeenCalledTimes(2);
    expect(new Set(tunnelMocks.acquire.mock.calls.map(call=>call[1])).size).toBe(1);
    expect(mocks.spawn.mock.calls.flatMap(call=>call[1])).not.toContain('-R');
    await controller!.disconnect();
    expect(tunnelMocks.release).toHaveBeenCalledTimes(2);
  });
  it('synchronizes two workspaces at once and pauses a mirror only after its last tab closes',async()=>{
    addWorkspace('alpha');addWorkspace('beta');
    syncMocks.ensure.mockResolvedValue({phase:'ready',message:'',conflicts:[]});syncMocks.wait.mockResolvedValue(undefined);
    await controller!.connect('test-node','alpha');mocks.terminals[0].data(READY);
    await vi.waitFor(()=>expect(controller!.snapshot().workspacePreparation?.phase).toBe('ready'));
    const alpha=active();
    await controller!.connect('test-node','beta');mocks.terminals[1].data(READY);
    await vi.waitFor(()=>expect(controller!.snapshot().workspacePreparation?.phase).toBe('ready'));
    const beta=active();
    expect(syncMocks.instances).toHaveLength(2);
    expect(syncMocks.ensure.mock.calls.map(call=>call[0].id)).toEqual(['alpha','beta']);
    expect(syncMocks.pause).not.toHaveBeenCalled();
    await controller!.newSession();mocks.terminals[2].data(READY);
    await vi.waitFor(()=>expect(controller!.snapshot().workspacePreparation?.phase).toBe('ready'));
    expect(syncMocks.instances).toHaveLength(2);
    await controller!.closeSession(beta);expect(syncMocks.pause).not.toHaveBeenCalled();
    await controller!.closeSession(active());expect(syncMocks.pause).toHaveBeenCalledTimes(1);
    expect(active()).toBe(alpha);expect(controller!.snapshot().connection.activeWorkspaceId).toBe('alpha');
  });
});