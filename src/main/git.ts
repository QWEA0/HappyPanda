import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join,resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { ServiceNode,Workspace } from '../shared/types';
import { runProcess,runRemote,uploadFile,downloadFile,shellQuote } from './ssh';
import { runCommand } from './sync/transport';

export interface GitSyncResult {
  phase:'ready'|'blocked';
  updated?:boolean;
  message:string;
  head?:string;
  reference?:string;
}

export class GitWorkspace {
  constructor(private dataDir:string){}
  private async alignComparisonSettings(workspace:Workspace,node:ServiceNode){
    const read=async(key:string,fallback:string)=>{try{return (await runProcess('git',['-C',workspace.localPath,'config','--get',key])).trim().toLowerCase()||fallback;}catch{return fallback;}};
    const filemode=await read('core.filemode','true');
    const autocrlf=await read('core.autocrlf','false');
    const configuredEol=await read('core.eol','native');
    const boolean=(value:string)=>['true','yes','on','1'].includes(value)?'true':['false','no','off','0'].includes(value)?'false':undefined;
    const mode=boolean(filemode),crlf=autocrlf==='input'?'input':boolean(autocrlf);
    const eol=configuredEol==='native'?(process.platform==='win32'?'crlf':'lf'):configuredEol;
    if(!mode||!crlf||!['lf','crlf'].includes(eol))throw new Error('Unsupported local Git comparison settings');
    const root=shellQuote(workspace.remotePath);
    await runRemote(node,'git -C '+root+' config --local core.filemode '+mode+' && git -C '+root+' config --local core.autocrlf '+crlf+' && git -C '+root+' config --local core.eol '+eol);
  }
  private async localHead(workspace:Workspace){
    try{
      const root=(await runProcess('git',['-C',workspace.localPath,'rev-parse','--show-toplevel'])).trim();
      const same=(left:string,right:string)=>process.platform==='win32'?resolve(left).toLowerCase()===resolve(right).toLowerCase():resolve(left)===resolve(right);
      const equal=same(root,workspace.localPath)||same(await realpath(root),await realpath(workspace.localPath));
      if(!equal)return null;
      return (await runProcess('git',['-C',workspace.localPath,'rev-parse','--verify','HEAD'])).trim();
    }catch{return null;}
  }
  async bootstrap(workspace:Workspace,node:ServiceNode):Promise<boolean>{
    const head=await this.localHead(workspace);if(!head)return false;
    const existing=await runRemote(node,'if test -d '+shellQuote(workspace.remotePath+'/.git')+' && git -C '+shellQuote(workspace.remotePath)+' rev-parse --verify HEAD >/dev/null 2>&1; then printf existing; fi');
    if(existing.trim()==='existing'){await this.alignComparisonSettings(workspace,node);return false;}
    const directory=join(this.dataDir,'git',workspace.id);await mkdir(directory,{recursive:true});
    const bundle=join(directory,'baseline.bundle');
    await runProcess('git',['-C',workspace.localPath,'bundle','create',bundle,'HEAD'],undefined,180000);
    const remoteBundle=workspace.remotePath+'/.happypanda-sync-baseline.bundle';
    await uploadFile(node,bundle,remoteBundle,15*60_000);
    await runRemote(node,'git -C '+shellQuote(workspace.remotePath)+' init -q && git -C '+shellQuote(workspace.remotePath)+' fetch -q '+shellQuote(remoteBundle)+' HEAD:refs/heads/workspace && git -C '+shellQuote(workspace.remotePath)+' symbolic-ref HEAD refs/heads/workspace && git -C '+shellQuote(workspace.remotePath)+' reset --mixed -q '+shellQuote(head)+' && rm -f -- '+shellQuote(remoteBundle));
    await this.alignComparisonSettings(workspace,node);
    for(const key of ['user.name','user.email']){
      try{const value=(await runProcess('git',['-C',workspace.localPath,'config','--get',key])).trim();if(value&&!/[\r\n\0]/.test(value))await runRemote(node,'git -C '+shellQuote(workspace.remotePath)+' config '+key+' '+shellQuote(value));}catch{}
    }
    return true;
  }
  async fetchRemoteCommits(workspace:Workspace,node:ServiceNode):Promise<string|null>{
    const localHead=await this.localHead(workspace);if(!localHead)return null;
    const root=shellQuote(workspace.remotePath);
    const remoteHead=(await runRemote(node,'git -C '+root+' rev-parse --verify HEAD')).trim();
    if(!/^[a-f0-9]{40,64}$/.test(remoteHead))throw new Error('Invalid remote Git HEAD');
    if(remoteHead===localHead)return null;
    const reference='refs/remotes/happypanda/'+workspace.id;
    try{if((await runProcess('git',['-C',workspace.localPath,'rev-parse','--verify',reference])).trim()===remoteHead)return reference;}catch{}
    let available=false;
    try{await runProcess('git',['-C',workspace.localPath,'cat-file','-e',remoteHead+'^{commit}']);available=true;}catch{}
    if(available){
      await runProcess('git',['-C',workspace.localPath,'update-ref',reference,remoteHead]);
      return reference;
    }
    const directory=join(this.dataDir,'git',workspace.id);await mkdir(directory,{recursive:true});
    const id=randomUUID(),remoteBundle=workspace.remotePath+'/.happypanda-sync-commits-'+id+'.bundle';
    const bundle=join(directory,'remote-'+id+'.bundle');
    try{
      // Transfer only new objects when both repositories share the local baseline.
      await runRemote(node,'if git -C '+root+' cat-file -e '+shellQuote(localHead+'^{commit}')+' 2>/dev/null; then git -C '+root+' bundle create '+shellQuote(remoteBundle)+' HEAD '+shellQuote('^'+localHead)+'; else git -C '+root+' bundle create '+shellQuote(remoteBundle)+' HEAD; fi',undefined,180000);
      await downloadFile(node,bundle,remoteBundle);
      await runProcess('git',['-C',workspace.localPath,'fetch','--no-tags',bundle,'+HEAD:'+reference],undefined,180000);
      return reference;
    }finally{
      await rm(bundle,{force:true});
      await runRemote(node,'rm -f -- '+shellQuote(remoteBundle));
    }
  }
  async syncRemoteCommits(workspace:Workspace,node:ServiceNode,current:()=>boolean=()=>true):Promise<GitSyncResult>{
    const reference=await this.fetchRemoteCommits(workspace,node);
    if(!reference)return {phase:'ready',message:'Git commits synchronized'};
    const git=(args:string[])=>runProcess('git',['-C',workspace.localPath,...args]);
    const head=await this.localHead(workspace);
    const remoteHead=(await git(['rev-parse','--verify',reference])).trim();
    const blocked=(message:string):GitSyncResult=>({phase:'blocked',message,head:remoteHead,reference});
    if(!head||!current())return blocked('Workspace changed before Git commits could be applied');
    if(head===remoteHead)return {phase:'ready',message:'Git commits synchronized',head,reference};
    let branch:string;
    try{branch=(await git(['symbolic-ref','--quiet','HEAD'])).trim();}catch{return blocked('Remote commits fetched; local HEAD is detached');}
    let ancestor:string;
    try{ancestor=(await git(['merge-base',head,remoteHead])).trim();}catch{return blocked('Remote commits fetched; local and remote histories need review');}
    if(ancestor===remoteHead)return {phase:'ready',message:'Remote commits already exist locally',head,reference};
    if(ancestor!==head)return blocked('Remote commits fetched; local and remote branches have diverged');
    for(const marker of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-apply','rebase-merge']){
      const location=(await git(['rev-parse','--path-format=absolute','--git-path',marker])).trim();
      if(existsSync(location))return blocked('Remote commits fetched; finish the current local Git operation first');
    }
    const index=(await git(['rev-parse','--path-format=absolute','--git-path','index'])).trim();
    const temporary=join(dirname(index),'happypanda-index-'+randomUUID());
    let lock;
    try{lock=await open(index+'.lock','wx');}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return blocked('Remote commits fetched; the local Git index is busy');throw error;}
    let ownsLock=true;
    const alternate=(args:string[],input?:string)=>runCommand('git',['--literal-pathspecs','-C',workspace.localPath,'-c','core.splitIndex=false',...args],{env:{...process.env,GIT_INDEX_FILE:temporary},input});
    try{
      if(existsSync(index))await copyFile(index,temporary);
      else await alternate(['read-tree',head]);
      const original=await readFile(temporary);
      const staged=(await alternate(['ls-files','--stage','-z'])).split('\0').filter(Boolean);
      if(staged.some(entry=>entry.slice(0,entry.indexOf('\t')).split(' ')[2]!=='0'))return blocked('Remote commits fetched; resolve local index conflicts first');
      const indexEntries=new Map(staged.map(entry=>{
        const tab=entry.indexOf('\t'),[mode,hash]=entry.slice(0,tab).split(' ');
        return [entry.slice(tab+1),mode+' '+hash] as const;
      }));
      const treeEntries=async(commit:string)=>new Map((await git(['ls-tree','-r','-z',commit])).split('\0').filter(Boolean).map(entry=>{
          const tab=entry.indexOf('\t'),[mode,,hash]=entry.slice(0,tab).split(' ');
          return [entry.slice(tab+1),mode+' '+hash] as const;
      }));
      const previous=await treeEntries(head),next=await treeEntries(remoteHead);
      const changed=(await git(['diff-tree','--no-commit-id','--name-only','--no-renames','-r','-z',head,remoteHead])).split('\0').filter(Boolean);
      const overlaps=changed.filter(path=>indexEntries.get(path)!==previous.get(path)&&indexEntries.get(path)!==next.get(path));
      if(overlaps.length){
        // Retire overlapping staging only after its working files match the
        // remote commit; preserve every index entry outside the committed paths.
        await alternate(['read-tree',remoteHead]);
        try{
          for(let offset=0;offset<overlaps.length;offset+=32)await alternate(['diff','--quiet','--no-ext-diff','--no-textconv','--',...overlaps.slice(offset,offset+32)]);
        }catch{return blocked('Remote commits fetched; staged changes overlap the remote commit');}
        await rm(temporary,{force:true});
        const restored=await open(temporary,'wx');try{await restored.writeFile(original);}finally{await restored.close();}
      }
      const removals=changed.map(path=>'0 '+'0'.repeat(head.length)+'\t'+path+'\0').join('');
      const additions=changed.filter(path=>next.has(path)).map(path=>next.get(path)+'\t'+path+'\0').join('');
      await alternate(['update-index','-z','--index-info'],removals+additions);
      if(!current()||(await git(['symbolic-ref','--quiet','HEAD'])).trim()!==branch||(await this.localHead(workspace))!==head)return blocked('Local branch changed before Git commits could be applied');
      const directory=join(this.dataDir,'git',workspace.id);await mkdir(directory,{recursive:true});
      const backup=join(directory,'index-before-'+head.slice(0,12)+'-'+randomUUID());
      const saved=await open(backup,'wx');try{await saved.writeFile(original);}finally{await saved.close();}
      await lock.writeFile(await readFile(temporary));await lock.close();lock=undefined;
      await git(['update-ref','-m','HappyPanda: synchronize remote commits',branch,remoteHead,head]);
      try{await rename(index+'.lock',index);ownsLock=false;}catch(error){await git(['update-ref',branch,head,remoteHead]);throw error;}
      return {phase:'ready',updated:true,message:'Git commits synchronized: '+remoteHead.slice(0,7),head:remoteHead,reference};
    }finally{
      await lock?.close();
      if(ownsLock)await rm(index+'.lock',{force:true});
      await rm(temporary,{force:true});
    }
  }
}
