import path from 'node:path';
import { readdir } from 'node:fs/promises';
import type { CommandRunner } from './transport';

const literal = (value:string) => '/' + value.replace(/[?*\[\]]/g,'\\$&');

function validate(value:string):string {
  if(path.posix.isAbsolute(value)||/[\r\n\\]/.test(value)||value.split('/').some(part=>part==='.'||part==='..'))throw new Error('Git 忽略清单含不支持的路径。');
  return value;
}

/** Use Git's own decisions, including nested/global rules. Ignored trees get a stable
 * child mask with literal exceptions for tracked files, rather than today's output list. */
export async function gitIgnorePaths(root:string,run:CommandRunner,alwaysIgnored:string[]=[]):Promise<string[]>{
  let repository:string;
  try{repository=(await run('git',['-C',root,'rev-parse','--show-toplevel'],{timeoutMs:15000})).trim();}
  catch(error){
    if(/not a git repository|ENOENT/.test(error instanceof Error?error.message:''))return [];
    throw new Error('无法读取项目的 Git 忽略清单。');
  }
  if(!repository)return [];
  const [ignored,tracked]=await Promise.all([
    run('git',['-C',root,'ls-files','--others','--ignored','--exclude-standard','--directory','--no-empty-directory','-z'],{timeoutMs:30000}),
    run('git',['-C',root,'ls-files','--cached','-z'],{timeoutMs:30000}),
  ]);
  // App exclusions are names (or a name prefix ending in '*') at any depth.
  // Redundant cache paths must not change the session configuration when caches appear.
  const eligible=(value:string)=>!value.split('/').some(part=>alwaysIgnored.some(rule=>rule.endsWith('*')?part.startsWith(rule.slice(0,-1)):part===rule));
  const files=tracked.split('\0').filter(Boolean).map(validate).filter(eligible);
  let paths=ignored.split('\0').filter(Boolean).map(validate).filter(eligible);
  let roots:string[]=[];
  for(;;){
    const candidates=new Set<string>();
    for(const value of [...files,...paths]){
      const parts=value.split('/');parts.pop();
      while(parts.length){candidates.add(parts.join('/'));parts.pop();}
    }
    // Do not append '/' to check-ignore input: Git can match a CRLF blank rule
    // against the empty final component and incorrectly report a directory ignored.
    const checked=candidates.size?await run('git',['-C',root,'check-ignore','--no-index','--stdin','-z'],{
      input:[...candidates].sort().join('\0')+'\0',acceptedExitCodes:[0,1],timeoutMs:30000,
    }):'';
    roots=[];
    for(const value of checked.split('\0').filter(Boolean).sort()){
      if(!candidates.has(value))throw new Error('Git 返回了不在查询范围内的忽略目录。');
      if(!roots.some(parent=>(value+'/').startsWith(parent)))roots.push(value+'/');
    }
    // --directory may compact an unignored folder whose current children are all
    // ignored. Expand only those folders, never large genuinely ignored data trees.
    const compacted=paths.filter(value=>value.endsWith('/')&&!roots.some(parent=>value.startsWith(parent)));
    if(!compacted.length)break;
    const children=await Promise.all(compacted.map(async directory=>{
      const entries=(await readdir(path.join(root,directory),{withFileTypes:true})).map(entry=>({name:validate(directory+entry.name),directory:entry.isDirectory()})).filter(entry=>eligible(entry.name));
      if(!entries.length)return [];
      const output=await run('git',['-C',root,'check-ignore','--no-index','--stdin','-z'],{
        input:entries.map(entry=>entry.name).join('\0')+'\0',acceptedExitCodes:[0,1],timeoutMs:30000,
      });
      const ignoredChildren=new Set(output.split('\0').filter(Boolean));
      return entries.filter(entry=>entry.directory||ignoredChildren.has(entry.name)).map(entry=>entry.name+(entry.directory?'/':''));
    }));
    paths=paths.filter(value=>!compacted.includes(value)).concat(children.flat());
  }
  const exclusions=new Set<string>(),inclusions=new Set<string>();
  for(const root of roots){
    const children=files.filter(file=>file.startsWith(root));
    if(!children.length){exclusions.add(literal(root));continue;}
    // Keep traversal open only along tracked paths. Newly generated siblings remain ignored.
    exclusions.add(literal(root)+'*');
    for(const file of children){
      inclusions.add('!'+literal(file));
      let directory=path.posix.dirname(file)+'/';
      while(directory!==root){
        exclusions.add(literal(directory)+'*');inclusions.add('!'+literal(directory));
        directory=path.posix.dirname(directory.slice(0,-1))+'/';
      }
    }
  }
  for(const value of paths){
    if(value.endsWith('/')&&files.some(file=>file.startsWith(value)))throw new Error('忽略清单覆盖已跟踪文件，已停止准备同步。');
    if(!roots.some(parent=>value.startsWith(parent)))exclusions.add(literal(value));
  }
  // Order matters: exceptions must follow masks. Mandatory app exclusions are appended later.
  return [...exclusions].sort().concat([...inclusions].sort());
}
