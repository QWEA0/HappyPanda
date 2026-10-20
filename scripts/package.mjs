import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2];
if (!['pack', 'zip', 'portable'].includes(mode)) throw new Error('Expected pack, zip or portable');
const binary = process.platform === 'win32' ? 'mutagen.exe' : 'mutagen';
await import('./build-windows-runtime.mjs');
const resources = ['bootstrap.py', 'hp_remote.py', 'import_memory.py', 'upload_image.py', 'ssh-helper.cjs', 'windows-runtime.json.gz'];
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
await run('scripts/build-ssh-helper.mjs', []);
await run('node_modules/electron-vite/bin/electron-vite.js', ['build']);
const electronArgs = [];
if (process.platform === 'win32') {
  const distribution = join(root, 'node_modules', 'electron', 'dist');
  const installed = JSON.parse(await readFile(join(root, 'node_modules', 'electron', 'package.json'), 'utf8'));
  if ((await readFile(join(distribution, 'version'), 'utf8')).trim() !== installed.version) throw new Error('Installed Electron runtime version does not match its package');
  await access(join(distribution, 'electron.exe'));
  // Reuse the installed runtime; Windows can reject renaming the freshly extracted directory.
  electronArgs.push('--config.electronDist=' + distribution);
}
await run('node_modules/electron-builder/out/cli/cli.js', [
  ...(mode === 'pack' ? ['--dir'] : ['--win', mode]),
  '--config.directories.output=' + output,
  ...electronArgs,
]);
if (process.platform === 'win32') {
  const packaged = join(output, 'win-unpacked', 'resources');
  for (const name of resources) await access(join(packaged, 'resources', name));
  for (const name of syncFiles) await access(join(packaged, 'tools', name));
  await access(join(packaged, 'tools', 'ssh-launcher.exe'));
}
console.log('Package ready: ' + output);
