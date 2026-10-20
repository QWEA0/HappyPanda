import {createHash,randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,readFile,rename} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import type {ServiceNode} from '../shared/types';
import {prepareRemoteRuntime,runRemote,uploadFile,shellQuote} from './ssh';
import {runCommand} from './sync/transport';

const prepared=new Map<string,Promise<void>>();
export async function prepareWindowsMutagen(node:ServiceNode,dataDir:string,resourcesDir:string):Promise<void>{
  const runtime=await prepareRemoteRuntime(node);if(runtime.platform!=='windows')return;
  const archive=[join(resourcesDir,'../tools/mutagen-agents.tar.gz'),join(resourcesDir,'../.local/tools/mutagen-agents.tar.gz')].find(existsSync);
  if(!archive)throw new Error('Bundled Windows synchronization agent is missing');
  const metadata=JSON.parse(await readFile(join(dirname(archive),'mutagen-install.json'),'utf8'));
  const version=String(metadata.version).replace(/^v/,'');
  if(!/^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9]+)*$/.test(version))throw new Error('Invalid bundled synchronization version');
  const architecture=runtime.architecture==='ARM64'?'arm64':'amd64';
  const key=JSON.stringify([node.id,node.sshTarget,node.user,node.port,version,architecture]);
  let pending=prepared.get(key);
  if(!pending){pending=(async()=>{
    const directory=join(dataDir,'windows-mutagen',version,architecture);await mkdir(directory,{recursive:true});
    const agent=join(directory,'mutagen-agent.exe');
    if(!existsSync(agent)){
      const tar=process.platform==='win32'?join(process.env.SystemRoot??'C:\\Windows','System32','tar.exe'):'tar';
      await runCommand(tar,['-xzf',archive,'-C',directory,'windows_'+architecture],{timeoutMs:60000});
      await rename(join(directory,'windows_'+architecture),agent);
    }
    const digest=createHash('sha256').update(await readFile(agent)).digest('hex');
    const target=runtime.home+'/.local/share/happypanda/mutagen/'+version+'-'+digest.slice(0,16)+'/mutagen-agent.exe';
    const python=(script:string)=>runRemote(node,'python3 -c '+shellQuote(script));
    const present=(await python('import pathlib,hashlib;p=pathlib.Path('+JSON.stringify(target)+');p.parent.mkdir(parents=True,exist_ok=True);print(p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest()=='+JSON.stringify(digest)+')')).trim()==='True';
    if(!present){
      const part=target+'.'+randomUUID()+'.part';await uploadFile(node,agent,part);
      await python('import pathlib,hashlib,os;p=pathlib.Path('+JSON.stringify(part)+');t=pathlib.Path('+JSON.stringify(target)+');b=pathlib.Path.home()/".local/share/happypanda/mutagen";assert p.resolve().is_relative_to(b.resolve()) and t.resolve().is_relative_to(b.resolve());assert hashlib.sha256(p.read_bytes()).hexdigest()=='+JSON.stringify(digest)+';os.replace(p,t)');
    }
    runtime.mutagenAgent=target.replaceAll('/','\\');
  })().catch(error=>{prepared.delete(key);throw error;});prepared.set(key,pending);}
  await pending;
}
