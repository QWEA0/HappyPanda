import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { MemoryImportResult, ServiceNode, Workspace } from '../shared/types';
import { isWithin } from './sync/paths';
import { runProcess, runRemote, shellQuote } from './ssh';

interface MemoryFile { path:string; bytes:number; sha256:string; content:string }
export async function projectMemorySnapshot(localPath:string,configDir=process.env.CLAUDE_CONFIG_DIR||path.join(homedir(),'.claude')){
  let projectRoot=await realpath(localPath);
  try{
    const common=(await runProcess('git',['-C',projectRoot,'rev-parse','--path-format=absolute','--git-common-dir'])).trim();
    if(path.basename(common)==='.git')projectRoot=await realpath(path.dirname(common));
  }catch{}
  const name=process.env.CLAUDE_CODE_PROJECT_DIR_NAME||projectRoot.replace(/[^a-zA-Z0-9]/g,'-');
  if(!name||/[\/\\\0]/.test(name)||name==='.'||name==='..')throw new Error('无效的 Claude 项目记忆目录。');
  const projects=await realpath(path.join(configDir,'projects')).catch(()=>{throw new Error('未找到本机 Claude 项目目录。');});
  const requested=path.join(projects,name,'memory');
  const root=await realpath(requested).catch(()=>{throw new Error('未找到这个项目的本机记忆目录。当前仅支持默认项目记忆位置。');});
  if(!isWithin(projects,root)||(await lstat(requested)).isSymbolicLink())throw new Error('记忆目录必须位于 Claude projects 目录内。');
  const files:MemoryFile[]=[];let totalBytes=0;
  async function visit(directory:string,depth:number):Promise<void>{
    if(depth>8)throw new Error('记忆目录层级过深。');
    for(const entry of await readdir(directory,{withFileTypes:true})){
      if(entry.isSymbolicLink())throw new Error('记忆目录含符号链接，请先检查。');
      const target=path.join(directory,entry.name);
      if(entry.isDirectory()){await visit(target,depth+1);continue;}
      if(!entry.isFile()||!entry.name.toLowerCase().endsWith('.md'))continue;
      const canonical=await realpath(target);if(!isWithin(root,canonical))throw new Error('记忆文件超出项目目录。');
      const before=await lstat(canonical);if(before.size>2*1024*1024)throw new Error('单个记忆文件超过 2 MiB。');
      const content=await readFile(canonical),after=await lstat(canonical);
      if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||content.length!==after.size)throw new Error('记忆文件正在变化，请稍后重试。');
      totalBytes+=content.length;if(totalBytes>16*1024*1024||files.length>=2000)throw new Error('项目记忆超过本次导入容量。');
      files.push({path:path.relative(root,canonical).split(path.sep).join('/'),bytes:content.length,sha256:createHash('sha256').update(content).digest('hex'),content:content.toString('base64')});
    }
  }
  await visit(root,0);
  if(!files.length)throw new Error('本机项目记忆目录为空。');
  return {sourcePath:root,files:files.sort((a,b)=>a.path.localeCompare(b.path)),bytes:totalBytes};
}

export class ProjectMemoryImporter {
  constructor(private resourcesDir:string){}
  async import(workspace:Workspace,node:ServiceNode):Promise<MemoryImportResult>{
    const source=await projectMemorySnapshot(workspace.localPath);
    const script=await readFile(path.join(this.resourcesDir,'import_memory.py'),'utf8');
    const command='python3 -c '+shellQuote('import base64;exec(base64.b64decode('+JSON.stringify(Buffer.from(script).toString('base64'))+'))');
    const output=JSON.parse(await runRemote(node,command,JSON.stringify({workspacePath:workspace.remotePath,files:source.files}),120000));
    if(!Number.isInteger(output.imported)||!Number.isInteger(output.unchanged)||!Array.isArray(output.conflicts)||typeof output.destinationPath!=='string')throw new Error('远端记忆导入结果无效。');
    return {...output,sourcePath:source.sourcePath,totalFiles:source.files.length,bytes:source.bytes};
  }
}
