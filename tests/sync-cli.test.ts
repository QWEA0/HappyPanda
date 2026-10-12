import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { ServiceNode, Workspace } from '../src/shared/types';
import { createSyncArguments, WorkspaceSync } from '../src/main/sync';
import { normalizeMutagenState, parseMutagenSessions } from '../src/main/sync/state';
import { runCommand, type CommandRunner } from '../src/main/sync/transport';

const binary = path.resolve('.local', 'tools', process.platform === 'win32' ? 'mutagen.exe' : 'mutagen');

it.skipIf(!existsSync(binary))('validates official CLI JSON, exclusions and conflict reporting using only temporary local endpoints', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'happypanda-mutagen-cli-'));
  const alpha = path.join(directory, 'alpha with space');
  const beta = path.join(directory, 'beta with space');
  const env = { ...process.env, MUTAGEN_DATA_DIRECTORY: path.join(directory, 'daemon') };
  const cli = (args: string[]) => runCommand(binary, args, { env, timeoutMs: 60_000 });
  try {
    await mkdir(path.join(alpha, '.git'), { recursive: true });
    await mkdir(path.join(alpha, 'node_modules'), { recursive: true });
    await mkdir(path.join(alpha, 'dist'), { recursive: true });
    await mkdir(path.join(alpha,'data'));
    await mkdir(path.join(alpha,'reports [old]'));
    await mkdir(beta);
    await writeFile(path.join(alpha, '.git', 'config'), 'must not sync');
    await writeFile(path.join(alpha, 'node_modules', 'dependency.js'), 'must not sync');
    await writeFile(path.join(alpha, 'dist', 'result.txt'), 'deliverable');
    await writeFile(path.join(alpha, 'file.txt'), 'baseline');
    await writeFile(path.join(alpha,'data','weights.bin'),'excluded runtime data');
    await writeFile(path.join(alpha,'reports [old]','log.txt'),'excluded report');
    const node: ServiceNode = { id: 'test', name: 'test', sshTarget: 'never-contacted', createdAt: '' };
    const workspace: Workspace = { id: 'test', nodeId: node.id, name: 'test', localPath: alpha, remotePath: '/unused', localAccess: false, syncSessionName: 'hp-cli-test', createdAt: '' };
    const args = createSyncArguments(workspace, alpha, workspace.remotePath, node);
    args.splice(args.indexOf('--'),0,'--ignore','/data/','--ignore','/reports \\[old\\]/');
    args[args.length - 1] = beta;
    await cli(args);
    const list = () => cli(['sync', 'list', '--template', '{{ json . }}']);
    const identifier = parseMutagenSessions(await list())[0].identifier;
    await cli(['sync', 'flush', identifier]);
    const ready = parseMutagenSessions(await list())[0];
    expect(ready.mode).toBe('two-way-safe'); expect(ready.alpha.protocol).toBe('local');
    expect(normalizeMutagenState(ready).phase).toBe('ready');
    expect(await readFile(path.join(beta, 'dist', 'result.txt'), 'utf8')).toBe('deliverable');
    expect(existsSync(path.join(beta, '.git'))).toBe(false);
    expect(existsSync(path.join(beta, 'node_modules'))).toBe(false);
    expect(existsSync(path.join(beta,'data'))).toBe(false);
    expect(existsSync(path.join(beta,'reports [old]'))).toBe(false);
    await cli(['sync', 'pause', identifier]);
    await mkdir(path.join(beta, '.git'));
    await writeFile(path.join(beta, '.git', 'config'), 'independent remote Git config');
    await writeFile(path.join(alpha, 'file.txt'), 'local changed');
    await writeFile(path.join(beta, 'file.txt'), 'remote changed');
    await cli(['sync', 'resume', identifier]);
    await cli(['sync', 'flush', identifier]);
    const conflict = normalizeMutagenState(parseMutagenSessions(await list())[0]);
    expect(conflict.phase).toBe('conflict'); expect(conflict.conflicts[0].path).toBe('file.txt');
    expect(await readFile(path.join(alpha, '.git', 'config'), 'utf8')).toBe('must not sync');
    expect(await readFile(path.join(beta, '.git', 'config'), 'utf8')).toBe('independent remote Git config');
  } finally {
    await cli(['daemon', 'stop']);
    const root = await realpath(tmpdir());
    const target = await realpath(directory);
    const relative = path.relative(root, target);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(target).startsWith('happypanda-mutagen-cli-')) await rm(target, { recursive: true, force: true });
  }
}, 60_000);

it.skipIf(!existsSync(binary))('keeps ignored trees stable and drains old history before replacing a scope',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'happypanda-mutagen-scope-'));
  const alpha=path.join(directory,'alpha'),beta=path.join(directory,'beta');
  const dataDir=path.join(directory,'app');
  const env={...process.env,MUTAGEN_DATA_DIRECTORY:path.join(dataDir,'mutagen')};
  const cli=(args:string[])=>runCommand(binary,args,{env,timeoutMs:60000});
  const git=(args:string[])=>runCommand('git',['-C',alpha,...args]);
  const commands:string[][]=[];
  const runner:CommandRunner=async(file,args,options)=>{
    if(file==='git')return runCommand(file,args,options);
    commands.push([...args]);
    const actual=[...args];
    if(args[1]==='create')actual[actual.length-1]=beta;
    const output=await runCommand(file,actual,options);
    if(args[1]!=='list')return output;
    // Real local endpoints exercise Mutagen without contacting SSH; adapt only its address.
    const sessions=JSON.parse(output);
    for(const session of sessions)Object.assign(session.beta,{protocol:'ssh',host:'test-node',path:'/srv/project'});
    return JSON.stringify(sessions);
  };
  const workspace:Workspace={id:'test',nodeId:'node',name:'test',localPath:alpha,remotePath:'/srv/project',localAccess:false,syncSessionName:'hp-scope-test',createdAt:''};
  const node:ServiceNode={id:'node',name:'test',sshTarget:'test-node',createdAt:''};
  const sync=new WorkspaceSync({dataDir,mutagenPath:binary,runCommand:runner,runRemote:async()=>JSON.stringify({root:workspace.remotePath}),onState:()=>{},pollIntervalMs:0});
  const current=async()=>parseMutagenSessions(await cli(['sync','list','--template','{{ json . }}'])).find(s=>s.name===workspace.syncSessionName)!;
  try{
    await mkdir(path.join(alpha,'reports [old]','nested'),{recursive:true});await mkdir(beta);
    await git(['init','-q']);
    await writeFile(path.join(alpha,'.gitignore'),'reports*/\n');
    await writeFile(path.join(alpha,'file.txt'),'baseline');
    await writeFile(path.join(alpha,'reports [old]','nested','keep.txt'),'tracked report');
    await writeFile(path.join(alpha,'reports [old]','nested','output.log'),'ignored output');
    await git(['add','-f','reports [old]/nested/keep.txt']);
    expect((await sync.ensure(workspace,node)).phase).not.toBe('error');
    let original=await current();await cli(['sync','flush',original.identifier]);
    expect(await readFile(path.join(beta,'reports [old]','nested','keep.txt'),'utf8')).toBe('tracked report');
    expect(existsSync(path.join(beta,'reports [old]','nested','output.log'))).toBe(false);
    expect(existsSync(path.join(beta,'.git'))).toBe(false);

    await cli(['sync','pause',original.identifier]);
    await writeFile(path.join(alpha,'file.txt'),'local pending edit');
    await mkdir(path.join(alpha,'reports [old]','new-output'));
    await writeFile(path.join(alpha,'reports [old]','new-output','result.txt'),'new ignored output');
    await sync.ensure(workspace,node);await cli(['sync','flush',original.identifier]);
    expect((await current()).identifier).toBe(original.identifier);
    expect(await readFile(path.join(beta,'file.txt'),'utf8')).toBe('local pending edit');
    expect(existsSync(path.join(beta,'reports [old]','new-output'))).toBe(false);
    expect(commands.filter(args=>args[1]==='create')).toHaveLength(1);

    await cli(['sync','pause',original.identifier]);
    await writeFile(path.join(alpha,'file.txt'),'edit before scope migration');
    await writeFile(path.join(alpha,'reports [old]','new-source.txt'),'new tracked source');
    await git(['add','-f','reports [old]/new-source.txt']);
    expect((await sync.ensure(workspace,node)).phase).not.toBe('error');
    const replacement=await current();expect(replacement.identifier).not.toBe(original.identifier);
    await cli(['sync','flush',replacement.identifier]);
    expect((await sync.status()).phase).toBe('ready');
    expect(await readFile(path.join(beta,'file.txt'),'utf8')).toBe('edit before scope migration');
    expect(await readFile(path.join(beta,'reports [old]','new-source.txt'),'utf8')).toBe('new tracked source');

    original=await current();await cli(['sync','pause',original.identifier]);
    await writeFile(path.join(alpha,'file.txt'),'local concurrent edit');
    await writeFile(path.join(beta,'file.txt'),'remote concurrent edit');
    await writeFile(path.join(alpha,'reports [old]','another-source.txt'),'another tracked source');
    await git(['add','-f','reports [old]/another-source.txt']);
    expect((await sync.ensure(workspace,node)).phase).toBe('conflict');
    expect((await current()).identifier).toBe(original.identifier);
    expect(commands.filter(args=>args[1]==='create')).toHaveLength(2);
    expect(await readFile(path.join(alpha,'file.txt'),'utf8')).toBe('local concurrent edit');
    expect(await readFile(path.join(beta,'file.txt'),'utf8')).toBe('remote concurrent edit');
  }finally{
    await sync.dispose();
    const root=await realpath(tmpdir()),target=await realpath(directory),relative=path.relative(root,target);
    if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(target).startsWith('happypanda-mutagen-scope-'))await rm(target,{recursive:true,force:true});
  }
},90000);
