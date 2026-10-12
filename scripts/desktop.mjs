import { spawn } from 'node:child_process';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const env={...process.env};
delete env.ELECTRON_RUN_AS_NODE;
const electronDirectory=join(root,'node_modules','electron');
const run=(args)=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,args,{cwd:root,env,stdio:'inherit',windowsHide:true});
  child.once('error',reject);child.once('exit',code=>resolve(code??1));
});
if(!existsSync(join(electronDirectory,'path.txt'))){
  const code=await run([join(electronDirectory,'install.js')]);
  if(code!==0)process.exit(code);
}
const code=await run([join(root,'node_modules','electron-vite','bin','electron-vite.js'),process.argv[2]??'dev']);
process.exitCode=code;
