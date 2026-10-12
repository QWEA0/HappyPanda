import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2];
if (!['pack', 'portable'].includes(mode)) throw new Error('Expected pack or portable');
const binary = process.platform === 'win32' ? 'mutagen.exe' : 'mutagen';
const resources = ['bootstrap.py', 'hp_remote.py', 'import_memory.py', 'upload_image.py'];
const syncFiles = [binary, 'mutagen-agents.tar.gz'];
for (const name of resources) await access(join(root, 'resources', name));
for (const name of syncFiles) await access(join(root, '.local/tools', name));

// Never let electron-builder clean the directory of a running/previous build.
const output = join(root, 'release', 'build-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid);
async function run(script, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, script), ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Packaging command failed: ' + code)));
  });
}
await run('node_modules/electron-vite/bin/electron-vite.js', ['build']);
await run('node_modules/electron-builder/out/cli/cli.js', [
  ...(mode === 'portable' ? ['--win', 'portable'] : ['--dir']),
  '--config.directories.output=' + output,
]);
if (process.platform === 'win32') {
  const packaged = join(output, 'win-unpacked', 'resources');
  for (const name of resources) await access(join(packaged, 'resources', name));
  for (const name of syncFiles) await access(join(packaged, 'tools', name));
}
console.log('Package ready: ' + output);
