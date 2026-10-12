import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { mkdtemp,realpath,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename,isAbsolute,join,relative,resolve } from 'node:path';
import { createHash } from 'node:crypto';

const mocks=vi.hoisted(()=>({terminals:[] as any[],spawn:vi.fn(),remote:vi.fn(),clipboard:vi.fn()}));
const syncMocks=vi.hoisted(()=>({ensure:vi.fn(),wait:vi.fn(),flush:vi.fn()}));
vi.mock('node-pty',()=>({spawn:mocks.spawn}));
vi.mock('../src/main/ssh',async importOriginal=>{
  const actual=await importOriginal<typeof import('../src/main/ssh')>();
  return {...actual,runRemote:mocks.remote};
});
vi.mock('../src/main/sync',()=>({WorkspaceSync:class{
  pause=async()=>{};dispose=async()=>{};
  ensure=syncMocks.ensure;waitUntilReady=syncMocks.wait;flush=syncMocks.flush;
}}));
vi.mock('../src/main/git',()=>({GitWorkspace:class{bootstrap=async()=>false;}}));
import { AppController } from '../src/main/controller';
import { TEST_NODE } from './fixtures/node';

let controller:AppController|undefined;
let directory:string;
beforeEach(async()=>{
  directory=await mkdtemp(join(tmpdir(),'hp-connection-'));
  mocks.terminals.length=0;mocks.spawn.mockReset();mocks.remote.mockReset();
  mocks.clipboard.mockReset().mockResolvedValue({kind:'empty'});
  syncMocks.ensure.mockReset().mockResolvedValue({phase:'scanning',message:'Scanning',conflicts:[]});syncMocks.wait.mockReset();syncMocks.flush.mockReset();
  mocks.remote.mockResolvedValue(JSON.stringify({configPath:'/home/ubuntu/.local/share/happypanda/test/config.json',helperPath:'/home/ubuntu/.local/share/happypanda/hp_remote.py'}));
  mocks.spawn.mockImplementation(()=>{
    const terminal={write:vi.fn(),resize:vi.fn(),kill:vi.fn(),data:undefined as undefined|((data:string)=>void),exit:undefined as undefined|((value:{exitCode:number})=>void),onData:vi.fn(),onExit:vi.fn()};
    terminal.onData.mockImplementation(callback=>{terminal.data=callback;});
    terminal.onExit.mockImplementation(callback=>{terminal.exit=callback;});
    mocks.terminals.push(terminal);return terminal;
  });
  controller=new AppController({dataDir:directory,resourcesDir:resolve('resources'),token:'isolated-test-token',emit:()=>{},readClipboard:mocks.clipboard,pickDirectory:async()=>null,openLocal:async()=>{},openURL:async()=>{},encryption:{available:()=>true,encrypt:value=>Buffer.from(value).reverse(),decrypt:value=>Buffer.from(value).reverse().toString()}});
  await controller.initialize();controller.store.nodes=[{...TEST_NODE}];vi.useFakeTimers();
});

describe('clipboard paste session ownership',()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=','base64');
  const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
  const request=()=>({nodeId:'test-node',sessionId:controller!.snapshot().connection.activeSessionId!,bracketedPaste:true});
  const remotePath=(sessionId:string)=>'/home/test/.local/share/happypanda/attachments/'+hash('test-node\0'+sessionId)+'/'+hash(png)+'.png';
  const response=(sessionId:string)=>JSON.stringify({path:remotePath(sessionId),sha256:hash(png),bytes:png.length});
  async function connect(){await controller!.connect('test-node');mocks.terminals.at(-1).data('\x1b]777;happypanda-ready\x07');}
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

describe('remote session recovery',()=>{
  it('resumes a session without a workspace after visiting a project and ignores its cancelled preparation',async()=>{
    await controller!.connect('test-node');mocks.terminals[0].data('\x1b]777;happypanda-ready\x07');
    const plain=controller!.snapshot().connection.activeSessionId!;
    controller!.store.workspaces.push({id:'workspace',nodeId:'test-node',name:'project',localPath:directory,remotePath:'/home/ubuntu/.local/share/happypanda/workspaces/workspace',localAccess:false,syncSessionName:'hp-workspace',createdAt:''});
    let finish!:()=>void;syncMocks.wait.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
    await controller!.connect('test-node','workspace');mocks.terminals[1].data('\x1b]777;happypanda-ready\x07');
    await vi.waitFor(()=>expect(syncMocks.wait).toHaveBeenCalled());
    await controller!.connect('test-node',undefined,plain);mocks.terminals[2].data('\x1b]777;happypanda-ready\x07');
    finish();await vi.advanceTimersByTimeAsync(1);
    expect(controller!.snapshot().connection.activeWorkspaceId).toBeUndefined();
    expect(controller!.snapshot().connection.activeSessionId).toBe(plain);
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
