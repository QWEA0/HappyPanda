import {readFile,readdir,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const files=[];
async function add(source,target){files.push({path:target,content:(await readFile(source)).toString('base64')});}
await add(join(root,'resources/windows-agent.cjs'),'agent.cjs');
const module=join(root,'node_modules/node-pty');
await add(join(module,'package.json'),'node-pty/package.json');
await add(join(module,'LICENSE'),'node-pty/LICENSE');
async function walk(directory,prefix){for(const entry of await readdir(directory,{withFileTypes:true})){
  if(entry.isDirectory())await walk(join(directory,entry.name),prefix+'/'+entry.name);
  else if(entry.isFile()&&!entry.name.endsWith('.test.js')&&!entry.name.endsWith('.map'))await add(join(directory,entry.name),prefix+'/'+entry.name);
}}
await walk(join(module,'lib'),'node-pty/lib');
for(const architecture of ['x64','arm64'])for(const file of ['conpty.node','conpty_console_list.node']){
  await add(join(module,'prebuilds/win32-'+architecture,file),'node-pty/prebuilds/win32-'+architecture+'/'+file);
}
files.sort((left,right)=>left.path.localeCompare(right.path));
const bundle=gzipSync(JSON.stringify({version:1,files}),{level:9});
const target=join(root,'resources/windows-runtime.json.gz');
const previous=await readFile(target).catch(()=>null);
if(!previous?.equals(bundle))await writeFile(target,bundle);
