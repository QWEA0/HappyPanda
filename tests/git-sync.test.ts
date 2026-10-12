import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { copyFile,mkdtemp,readFile,readdir,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename,isAbsolute,join,relative,resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ServiceNode,Workspace } from '../src/shared/types';

const mocks=vi.hoisted(()=>({remote:vi.fn(),download:vi.fn()}));
vi.mock('../src/main/ssh',async original=>({...await original<typeof import('../src/main/ssh')>(),runRemote:mocks.remote,downloadFile:mocks.download}));
import { runProcess } from '../src/main/ssh';
import { GitWorkspace } from '../src/main/git';

let directory:string,local:string,remote:string,dataDir:string,base:string,remoteBundle:string;
let workspace:Workspace,mirror:GitWorkspace;
const node:ServiceNode={id:'node',name:'node',sshTarget:'isolated-test',createdAt:''};
const git=(root:string,...args:string[])=>runProcess('git',['-C',root,...args]);
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const indexHash=async()=>hash(await readFile(join(local,'.git','index')));
async function commitRemote(){
  await writeFile(join(remote,'shared.txt'),'remote commit\n');
  await writeFile(join(remote,'new file.txt'),'new file\n');
  await rm(join(remote,'deleted.txt'));
  await git(remote,'add','-A');await git(remote,'commit','-qm','remote commit');
  return (await git(remote,'rev-parse','HEAD')).trim();
}
async function mirrorFiles(){
  await copyFile(join(remote,'shared.txt'),join(local,'shared.txt'));
  await copyFile(join(remote,'new file.txt'),join(local,'new file.txt'));
  await rm(join(local,'deleted.txt'));
}
beforeEach(async()=>{
  directory=await mkdtemp(join(tmpdir(),'hp-git-sync-'));local=join(directory,'local');remote=join(directory,'remote');dataDir=join(directory,'data');
  await runProcess('git',['init','-q','-b','work',local]);
  for(const [key,value] of [['user.name','Test'],['user.email','test@example.invalid'],['core.autocrlf','false'],['core.filemode','false']])await git(local,'config',key,value);
  for(const [name,contents] of [['shared.txt','baseline\n'],['other.txt','other\n'],['deleted.txt','delete me\n'],['.gitignore','.happypanda-sync-*\n']])await writeFile(join(local,name),contents);
  await git(local,'add','-A');await git(local,'commit','-qm','baseline');base=(await git(local,'rev-parse','HEAD')).trim();
  await runProcess('git',['clone','-q','--no-hardlinks','-c','core.autocrlf=false',local,remote]);
  for(const [key,value] of [['user.name','Test'],['user.email','test@example.invalid'],['core.autocrlf','false'],['core.filemode','false']])await git(remote,'config',key,value);
  workspace={id:'test',nodeId:node.id,name:'test',localPath:local,remotePath:'/srv/project',localAccess:false,syncSessionName:'test',createdAt:''};
  mirror=new GitWorkspace(dataDir);remoteBundle=join(remote,'.happypanda-sync-commits.bundle');
  mocks.remote.mockReset().mockImplementation(async(_node,command:string)=>{
    if(command.endsWith('rev-parse --verify HEAD'))return git(remote,'rev-parse','--verify','HEAD');
    if(command.includes('bundle create')){
      const exclusion=command.match(/cat-file -e '([a-f0-9]+)\^\{commit\}'/)?.[1];
      let available=false;
      if(exclusion)try{await git(remote,'cat-file','-e',exclusion+'^{commit}');available=true;}catch{}
      return git(remote,'bundle','create',remoteBundle,'HEAD',...(available?['^'+exclusion]:[]));
    }
    if(command.startsWith('rm -f -- ')){await rm(remoteBundle,{force:true});return '';}
    throw new Error('Unexpected remote command: '+command);
  });
  mocks.download.mockReset().mockImplementation(async(_node,target:string)=>copyFile(remoteBundle,target));
});
afterEach(async()=>{
  vi.restoreAllMocks();
  const child=relative(resolve(tmpdir()),resolve(directory));
  if(child&&!child.startsWith('..')&&!isAbsolute(child)&&basename(directory).startsWith('hp-git-sync-'))await rm(directory,{recursive:true,force:true});
});

describe('remote commit synchronization with real Git repositories',()=>{
  it('fast-forwards mirrored additions, edits and deletions without rewriting working files',async()=>{
    const head=await commitRemote();await mirrorFiles();await writeFile(join(local,'untracked.txt'),'keep me\n');
    const before=hash(await readFile(join(local,'shared.txt')));
    expect(await mirror.syncRemoteCommits(workspace,node)).toMatchObject({phase:'ready',updated:true,head,message:'Git commits synchronized: '+head.slice(0,7)});
    expect((await git(local,'rev-parse','HEAD')).trim()).toBe(head);
    expect((await git(local,'status','--porcelain')).trim()).toBe('?? untracked.txt');
    expect(hash(await readFile(join(local,'shared.txt')))).toBe(before);
    expect(await readFile(join(local,'untracked.txt'),'utf8')).toBe('keep me\n');
    expect((await readdir(join(dataDir,'git',workspace.id))).some(name=>name.startsWith('index-before-'))).toBe(true);
    expect(existsSync(join(local,'.git','index.lock'))).toBe(false);
  });
  it('retires a partially staged snapshot included in the remote commit and preserves unrelated staging',async()=>{
    const head=await commitRemote();
    await writeFile(join(local,'shared.txt'),'partial stage\n');await git(local,'add','shared.txt');
    await writeFile(join(local,'other.txt'),'independent stage\n');await git(local,'add','other.txt');
    await writeFile(join(local,'other.txt'),'other\n');await mirrorFiles();
    const original=await readFile(join(local,'.git','index'));
    expect(await mirror.syncRemoteCommits(workspace,node)).toMatchObject({phase:'ready',updated:true,head,message:'Git commits synchronized: '+head.slice(0,7)});
    expect(await git(local,'show',':shared.txt')).toBe('remote commit\n');
    expect(await git(local,'show',':other.txt')).toBe('independent stage\n');
    expect(await readFile(join(local,'other.txt'),'utf8')).toBe('other\n');
    const backups=(await readdir(join(dataDir,'git',workspace.id))).filter(name=>name.startsWith('index-before-'));
    expect(hash(await readFile(join(dataDir,'git',workspace.id,backups[0])))).toBe(hash(original));
  });
  it('preserves staged and unstaged edits outside the committed paths',async()=>{
    const head=await commitRemote();await mirrorFiles();
    await writeFile(join(local,'other.txt'),'staged\n');await git(local,'add','other.txt');await writeFile(join(local,'other.txt'),'unstaged\n');
    expect(await mirror.syncRemoteCommits(workspace,node)).toMatchObject({phase:'ready',updated:true,head,message:'Git commits synchronized: '+head.slice(0,7)});
    expect(await git(local,'show',':other.txt')).toBe('staged\n');
    expect(await readFile(join(local,'other.txt'),'utf8')).toBe('unstaged\n');
    expect((await git(local,'status','--porcelain')).trim()).toBe('MM other.txt');
  });
  it('keeps HEAD and the index unchanged when staged edits overlap unmirrored content',async()=>{
    await commitRemote();await mirrorFiles();await writeFile(join(local,'shared.txt'),'local edit\n');await git(local,'add','shared.txt');
    const before=await indexHash();
    expect(await mirror.syncRemoteCommits(workspace,node)).toMatchObject({phase:'blocked',message:expect.stringContaining('staged changes overlap')});
    expect((await git(local,'rev-parse','HEAD')).trim()).toBe(base);expect(await indexHash()).toBe(before);
    expect(await readFile(join(local,'shared.txt'),'utf8')).toBe('local edit\n');
    expect(existsSync(join(local,'.git','index.lock'))).toBe(false);
  });
  it('fetches divergent history for review without merging local commits',async()=>{
    const head=await commitRemote();await writeFile(join(local,'other.txt'),'local commit\n');await git(local,'add','other.txt');await git(local,'commit','-qm','local commit');
    const localHead=(await git(local,'rev-parse','HEAD')).trim(),before=await indexHash();
    expect(await mirror.syncRemoteCommits(workspace,node)).toMatchObject({phase:'blocked',head,message:expect.stringContaining('diverged')});
    expect((await git(local,'rev-parse','HEAD')).trim()).toBe(localHead);expect(await indexHash()).toBe(before);
    expect((await git(local,'rev-parse','refs/remotes/happypanda/test')).trim()).toBe(head);
  });
  it('preserves detached HEAD and active local Git operations',async()=>{
    await commitRemote();await git(local,'checkout','-q','--detach',base);
    expect(await mirror.syncRemoteCommits(workspace,node)).toMatchObject({phase:'blocked',message:expect.stringContaining('detached')});
    await git(local,'checkout','-q','work');await writeFile(join(local,'.git','MERGE_HEAD'),base+'\n');
    expect(await mirror.syncRemoteCommits(workspace,node)).toMatchObject({phase:'blocked',message:expect.stringContaining('current local Git operation')});
    expect((await git(local,'rev-parse','HEAD')).trim()).toBe(base);
  });
  it('does not remove a lock held by another Git process',async()=>{
    await commitRemote();await writeFile(join(local,'.git','index.lock'),'existing lock');
    expect(await mirror.syncRemoteCommits(workspace,node)).toMatchObject({phase:'blocked',message:expect.stringContaining('index is busy')});
    expect(await readFile(join(local,'.git','index.lock'),'utf8')).toBe('existing lock');
  });
  it('cancels before changing refs or the index if the workspace switches during preparation',async()=>{
    await commitRemote();await mirrorFiles();const before=await indexHash();let checks=0;
    expect(await mirror.syncRemoteCommits(workspace,node,()=>++checks===1)).toMatchObject({phase:'blocked'});
    expect((await git(local,'rev-parse','HEAD')).trim()).toBe(base);expect(await indexHash()).toBe(before);
    expect(existsSync(join(local,'.git','index.lock'))).toBe(false);
  });
  it('transfers incremental commits once and reuses the fetched reference',async()=>{
    await commitRemote();const reference=await mirror.fetchRemoteCommits(workspace,node);
    expect(reference).toBe('refs/remotes/happypanda/test');
    expect(mocks.remote.mock.calls.find(call=>call[1].includes('bundle create'))![1]).toContain("'^"+base+"'");
    expect(await mirror.fetchRemoteCommits(workspace,node)).toBe(reference);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(existsSync(remoteBundle)).toBe(false);
  });
  it('surfaces SSH failures instead of silently reporting synchronized commits',async()=>{
    mocks.remote.mockRejectedValueOnce(new Error('SSH failed'));
    await expect(mirror.syncRemoteCommits(workspace,node)).rejects.toThrow('SSH failed');
    expect((await git(local,'rev-parse','HEAD')).trim()).toBe(base);
  });
  it('preserves Windows CRLF files while retiring staging consumed by a remote commit',async()=>{
    const head=await commitRemote();await git(local,'config','core.autocrlf','true');
    await writeFile(join(local,'shared.txt'),'partial stage\r\n');await git(local,'add','shared.txt');await mirrorFiles();
    await writeFile(join(local,'shared.txt'),'remote commit\r\n');await writeFile(join(local,'new file.txt'),'new file\r\n');
    expect(await mirror.syncRemoteCommits(workspace,node)).toMatchObject({phase:'ready',updated:true,head});
    expect(await readFile(join(local,'shared.txt'),'utf8')).toBe('remote commit\r\n');
    expect((await git(local,'status','--porcelain')).trim()).toBe('');
  });
  it('keeps local commits ahead of the remote without downloading or rewinding the branch',async()=>{
    await writeFile(join(local,'other.txt'),'local commit\n');await git(local,'add','other.txt');await git(local,'commit','-qm','local commit');
    const head=(await git(local,'rev-parse','HEAD')).trim();
    expect(await mirror.syncRemoteCommits(workspace,node)).toMatchObject({phase:'ready',head,message:'Remote commits already exist locally'});
    expect((await git(local,'rev-parse','HEAD')).trim()).toBe(head);expect(mocks.download).not.toHaveBeenCalled();
  });
});
