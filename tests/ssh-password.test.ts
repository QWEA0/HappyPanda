import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdir,mkdtemp,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';
import {InventoryStore} from '../src/main/store';
import {SshAuthentication,authenticationArgs,sshEnvironment,transportAddress} from '../src/main/ssh-auth';
import {runProcess,sshArgs,sshExecutable,scpExecutable} from '../src/main/ssh';
import {scpArguments} from '../src/main/sync/transport';

const encryption = {available:()=>true,encrypt:(value:string)=>Buffer.from(value).reverse(),decrypt:(value:Buffer)=>Buffer.from(value).reverse().toString()};
const directories:string[]=[];
const services:SshAuthentication[]=[];
const servers:ChildProcess[]=[];
async function directory(){const value=await mkdtemp(join(tmpdir(),'hp-password-'));directories.push(value);return value;}
afterEach(async()=>{
  for(const child of servers.splice(0)) {child.stdin?.end('\n');await new Promise<void>(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',()=>resolve());setTimeout(()=>child.kill(),2000).unref();});}
  for(const service of services.splice(0))await service.dispose();
  for(const value of directories.splice(0))await rm(value,{recursive:true,force:true});
});

describe('SSH password credentials',()=>{
  it('encrypts passwords, redacts public state, preserves blank edits and clears on key authentication',async()=>{
    const dir=await directory();const store=new InventoryStore(dir,encryption);await store.load();
    const password=' synthetic-$-"-password ';
    const node=await store.saveNode({name:'Password server',sshTarget:'fixture@host',authType:'password',password});
    expect(node.hasPassword).toBe(true);expect(JSON.stringify(store.nodes)).not.toContain(password);
    const disk=await readFile(join(dir,'inventory.json'),'utf8');expect(disk).not.toContain(password);expect(disk).toContain('encryptedPassword');
    const loaded=new InventoryStore(dir,encryption);await loaded.load();expect(loaded.password(node.id)).toBe(password);
    await loaded.saveNode({...node,password:''});expect(loaded.password(node.id)).toBe(password);
    await loaded.saveNode({...node,password:'replacement'});expect(loaded.password(node.id)).toBe('replacement');
    await loaded.saveNode({...node,authType:'key'});expect(()=>loaded.password(node.id)).toThrow();
    expect(await readFile(join(dir,'inventory.json'),'utf8')).not.toContain('encryptedPassword');
  });
  it('rejects missing passwords, invalid input and unavailable encryption without leaking secrets',async()=>{
    const dir=await directory();const store=new InventoryStore(dir,encryption);await store.load();
    await expect(store.saveNode({name:'x',sshTarget:'host',authType:'password'})).rejects.toThrow('SSH');
    await expect(store.saveNode({name:'x',sshTarget:'host',authType:'password',password:'secret\ninvalid'})).rejects.not.toThrow('secret');
    const locked=new InventoryStore(dir,{...encryption,available:()=>false});
    await expect(locked.saveNode({name:'x',sshTarget:'host',authType:'password',password:'secret'})).rejects.toThrow('加密');
    expect(locked.nodes).toEqual([]);
  });
  it('enables password prompting for SSH and SCP without changing host verification',()=>{
    const node={id:'node',name:'Node',sshTarget:'host',createdAt:'',authType:'password' as const,identityFile:'unused.key'};
    expect(sshArgs(node)).toContain('BatchMode=no');expect(sshArgs(node)).toContain('StrictHostKeyChecking=yes');
    expect(sshArgs(node)).not.toContain('-i');expect(authenticationArgs({})).toEqual(['-o','BatchMode=yes']);
    expect(scpArguments(node,resolve('local.txt'),'/remote.txt','upload')).toContain('BatchMode=no');
    expect(scpArguments(node,resolve('local.txt'),'/remote.txt','upload')).not.toContain('-B');
  });
  it('routes only the destination, including user/port overrides and SCP paths',()=>{
    expect(transportAddress('ssh',['-oConnectTimeout=5','-p','2222','-l','override','user@host','echo other@bad'])).toEqual({host:'host',user:'override',port:2222});
    expect(transportAddress('scp',['-P','2222','C:\\local.txt','user@host:/remote.txt'])).toEqual({host:'host',user:'user',port:2222});
  });
  it('serves credentials only to authenticated local requests for password prompts',async()=>{
    const dir=await directory();const store=new InventoryStore(dir,encryption);await store.load();
    const node=await store.saveNode({name:'Node',sshTarget:'host',authType:'password',password:'synthetic'});
    const auth=new SshAuthentication({dataDir:dir,resourcesDir:resolve('resources'),store,sshExecutable:sshExecutable(),scpExecutable:scpExecutable()});services.push(auth);await auth.start();
    const config=JSON.parse(await readFile(join(auth.directory,'config.json'),'utf8'));
    const request=(token:string,prompt='Password:',origin?:string)=>fetch(config.url+'/password',{method:'POST',headers:{Authorization:token,...(origin?{Origin:origin}:{})},body:JSON.stringify({nodeId:node.id,prompt})});
    expect((await request('wrong')).status).toBe(403);expect((await request('é'.repeat(64))).status).toBe(403);
    expect((await request(config.token,'Password:','https://untrusted.example')).status).toBe(403);
    expect((await request(config.token,'Verification code:')).status).toBe(400);
    expect((await request(config.token,'Enter passphrase:')).status).toBe(400);
    expect(await (await request(config.token)).json()).toEqual({password:'synthetic'});
  });
});

describe.runIf(process.platform==='win32' && process.env.HAPPYPANDA_PASSWORD_SMOKE==='1')('Windows OpenSSH password transport',()=>{
  it('authenticates real SSH/SCP and the Mutagen transport without exposing the password',async()=>{
    const dir=await directory();const password=' synthetic-$-"-password-\u5bc6\u7801 ';
    const child=spawn('python',[resolve('tests/fixtures/password-ssh-server.py'),dir],{env:{...process.env,HP_TEST_PASSWORD:password},stdio:['pipe','pipe','pipe'],windowsHide:true});servers.push(child);
    let output='';let stderr='';child.stderr!.on('data',data=>{stderr+=data;});
    const server=await new Promise<{port:number;hostKey:string}>((resolve,reject)=>{
      child.stdout!.on('data',data=>{output+=data;const line=output.split('\n')[0];if(line)try{const info=JSON.parse(line);if(info.port)resolve(info);}catch{}});
      child.once('error',reject);child.once('exit',()=>reject(new Error(stderr)));
    });
    const knownHosts=join(dir,'known_hosts');await writeFile(knownHosts,`[127.0.0.1]:${server.port} ${server.hostKey}\n`);
    const store=new InventoryStore(dir,encryption);await store.load();
    const node=await store.saveNode({name:'Fixture',sshTarget:'127.0.0.1',user:'fixture',port:server.port,authType:'password',password});
    const auth=new SshAuthentication({dataDir:dir,resourcesDir:resolve('resources'),store,sshExecutable:sshExecutable(),scpExecutable:scpExecutable()});services.push(auth);await auth.start();await auth.prepare(node);
    expect(await runProcess(join(auth.directory,'askpass.exe'),["fixture@127.0.0.1's password: "],undefined,10000,sshEnvironment(node))).toBe(password+'\n');
    const args=['-o','UserKnownHostsFile='+knownHosts,...sshArgs(node),node.sshTarget,'echo password-ok'];
    expect((await runProcess(sshExecutable(),args,undefined,20000,sshEnvironment(node))).trim()).toBe('password-ok');
    const pty=await import('node-pty');
    const terminalOutput=await new Promise<string>((resolve,reject)=>{
      const terminal=pty.spawn(sshExecutable(),['-o','UserKnownHostsFile='+knownHosts,...sshArgs(node),'-tt',node.sshTarget,'echo password-ok'],{
        name:'xterm-256color',cols:80,rows:24,cwd:dir,useConptyDll:true,env:sshEnvironment(node)});
      let output='';const timer=setTimeout(()=>{terminal.kill();reject(new Error('Password PTY timed out'));},15000);
      terminal.onData(data=>{output+=data;});
      terminal.onExit(({exitCode})=>{clearTimeout(timer);exitCode===0?resolve(output):reject(new Error('Password PTY failed: '+output));});
    });
    expect(terminalOutput).toContain('password-ok');expect(terminalOutput).not.toContain(password);
    const source=join(dir,'source.txt');await writeFile(source,'password-authenticated upload');
    await runProcess(scpExecutable(),['-o','UserKnownHostsFile='+knownHosts,...scpArguments(node,source,'/upload.txt','upload')],undefined,20000,sshEnvironment(node));
    expect(await readFile(join(dir,'upload.txt'),'utf8')).toBe('password-authenticated upload');
    const destination=join(dir,'download.txt');
    await runProcess(scpExecutable(),['-o','UserKnownHostsFile='+knownHosts,...scpArguments(node,destination,'/upload.txt','download')],undefined,20000,sshEnvironment(node));
    expect(await readFile(destination,'utf8')).toBe('password-authenticated upload');
    expect((await runProcess(join(auth.directory,'ssh.exe'),['-o','UserKnownHostsFile='+knownHosts,'-p',String(node.port),'fixture@127.0.0.1','echo password-ok'],undefined,20000)).trim()).toBe('password-ok');
    const config=JSON.parse(await readFile(join(auth.directory,'config.json'),'utf8'));
    const headers={Authorization:config.token};
    const route=await (await fetch(config.url+'/transport',{method:'POST',headers,body:JSON.stringify({kind:'ssh',args:['-p',String(node.port),'fixture@127.0.0.1','echo password-ok']})})).text();
    expect(route).not.toContain(password);expect(JSON.stringify(sshEnvironment(node))).not.toContain(password);
    await runProcess('tar',['-xzf',resolve('.local/tools/mutagen-agents.tar.gz'),'-C',dir,'windows_amd64']);
    await rename(join(dir,'windows_amd64'),join(dir,'mutagen-agent.exe'));
    const originalRoute=(auth as any).route.bind(auth);
    vi.spyOn(auth as any,'route').mockImplementation((kind:any,values:any)=>{
      const result=originalRoute(kind,values);
      result.args.unshift('-o','UserKnownHostsFile='+knownHosts);return result;
    });
    const alpha=join(dir,'alpha');const beta=join(dir,'beta');await mkdir(alpha);await mkdir(beta);
    await writeFile(join(alpha,'from-local.txt'),'local to remote');await writeFile(join(beta,'from-remote.txt'),'remote to local');
    const mutagen=resolve('.local/tools/mutagen.exe');
    const env={...process.env,MUTAGEN_DATA_DIRECTORY:join(dir,'mutagen'),MUTAGEN_SSH_PATH:auth.directory};
    try {
      await runProcess(mutagen,['sync','create','--name','password-fixture','--no-global-configuration','--mode','two-way-safe','--',alpha,`fixture@127.0.0.1:${node.port}:${beta.replaceAll('\\','/')}`],undefined,45000,env);
      await runProcess(mutagen,['sync','flush','password-fixture'],undefined,45000,env);
      expect(await readFile(join(beta,'from-local.txt'),'utf8')).toBe('local to remote');
      expect(await readFile(join(alpha,'from-remote.txt'),'utf8')).toBe('remote to local');
    } catch(error) {throw new Error(String(error)+'; fixture: '+output+'; '+stderr);}
    finally {await runProcess(mutagen,['daemon','stop'],undefined,15000,env);}
    await store.saveNode({...node,password:'wrong-password'});
    await expect(runProcess(sshExecutable(),args,undefined,20000,sshEnvironment(node))).rejects.toThrow('Permission denied');
    expect(output.match(/"auth": false/g)).toHaveLength(1);
  },120000);
});
