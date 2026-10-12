import { mkdir } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import type { ServiceNode,Workspace } from '../shared/types';
import { runProcess,runRemote,uploadFile,downloadFile,shellQuote } from './ssh';

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
      const equal=process.platform==='win32'?resolve(root).toLowerCase()===resolve(workspace.localPath).toLowerCase():resolve(root)===resolve(workspace.localPath);
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
    let remoteHead:string;
    try{remoteHead=(await runRemote(node,'git -C '+shellQuote(workspace.remotePath)+' rev-parse --verify HEAD')).trim();}catch{return null;}
    if(!/^[a-f0-9]{40,64}$/.test(remoteHead)||remoteHead===localHead)return null;
    const directory=join(this.dataDir,'git',workspace.id);await mkdir(directory,{recursive:true});
    const remoteBundle=workspace.remotePath+'/.happypanda-sync-commits.bundle';
    await runRemote(node,'git -C '+shellQuote(workspace.remotePath)+' bundle create '+shellQuote(remoteBundle)+' HEAD');
    const bundle=join(directory,'remote.bundle');await downloadFile(node,bundle,remoteBundle);
    await runProcess('git',['-C',workspace.localPath,'fetch','--no-tags',bundle,'HEAD:refs/remotes/happypanda/'+workspace.id],undefined,180000);
    await runRemote(node,'rm -f -- '+shellQuote(remoteBundle));
    return 'refs/remotes/happypanda/'+workspace.id;
  }
}
