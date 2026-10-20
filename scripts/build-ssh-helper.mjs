import {spawn} from 'node:child_process';
import {mkdir,stat} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

if (process.platform === 'win32') {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const source = join(root,'resources','ssh-launcher.cs');
  const target = join(root,'.local','tools','ssh-launcher.exe');
  await mkdir(dirname(target),{recursive:true});
  const built = await stat(target).catch(() => null);
  if (!built || built.mtimeMs < (await stat(source)).mtimeMs) {
    const compiler = join(process.env.SystemRoot ?? 'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
    await new Promise((resolve,reject) => {
      const child = spawn(compiler,['/nologo','/target:exe','/platform:anycpu','/optimize+','/reference:System.Web.Extensions.dll','/out:'+target,source],{stdio:'inherit',windowsHide:true});
      child.once('error',reject);child.once('exit',code => code === 0 ? resolve() : reject(new Error('SSH helper compilation failed: '+code)));
    });
  }
}
await import('./build-windows-runtime.mjs');
