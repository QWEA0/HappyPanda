import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = 'https://api.github.com/repos/mutagen-io/mutagen';

export function platformAsset(platform, arch, version) {
  const os = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[platform];
  const cpu = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' }[arch];
  if (!os || !cpu) throw new Error(`Unsupported Mutagen platform/architecture: ${platform}/${arch}`);
  return `mutagen_${os}_${cpu}_${version}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
}

export function checksumFor(text, filename) {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-f\d]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match && match[2] === filename) return match[1].toLowerCase();
  }
  return undefined;
}

export function validateArchiveEntries(output) {
  const entries = output.split(/\r?\n/).filter(Boolean);
  if (!entries.length) throw new Error('Mutagen archive is empty');
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
      throw new Error(`Unsafe archive entry: ${entry}`);
    }
  }
}

async function execute(file, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`${file} failed (${code}): ${errors.trim()}`)));
  });
}

async function officialFetch(url, fetchImpl) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['api.github.com', 'github.com'].includes(parsed.hostname)) throw new Error('Expected an official GitHub release URL');
  const response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'HappyPanda-Mutagen-Installer' } });
  if (!response.ok) throw new Error(`GitHub download failed (${response.status}): ${url}`);
  return response;
}

export async function installMutagen({ version, toolsDir, platform = process.platform, arch = process.arch, fetchImpl = fetch, runner = execute } = {}) {
  const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const destination = path.resolve(toolsDir ?? path.join(projectRoot, '.local', 'tools'));
  if (version && !/^v\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Version must be an official release tag, such as v0.18.1');
  const release = await (await officialFetch(`${repository}/releases/${version ? `tags/${version}` : 'latest'}`, fetchImpl)).json();
  if (!/^v\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$/.test(release.tag_name)) throw new Error('Invalid official release tag');
  const filename = platformAsset(platform, arch, release.tag_name);
  const asset = release.assets.find(item => item.name === filename);
  if (!asset) throw new Error(`Official release has no asset for ${platform}/${arch}: ${filename}`);
  let expected = /^sha256:([a-f\d]{64})$/i.exec(asset.digest ?? '')?.[1]?.toLowerCase();
  const sums = release.assets.find(item => /^(SHA256SUMS|checksums\.txt)$/i.test(item.name));
  if (sums) {
    const published = checksumFor(await (await officialFetch(sums.browser_download_url, fetchImpl)).text(), filename);
    if (!published) throw new Error(`Official checksum list has no entry for ${filename}`);
    if (expected && expected !== published) throw new Error('GitHub asset digest disagrees with the published SHA256SUMS');
    expected = published;
  }
  await mkdir(destination, { recursive: true });
  const staging = await mkdtemp(path.join(destination, '.mutagen-install-'));
  try {
    const archive = path.join(staging, filename);
    const partial = `${archive}.part`;
    const response = await officialFetch(asset.browser_download_url, fetchImpl);
    if (!response.body) throw new Error('Release asset has no response body');
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: 'wx' }));
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(partial)) hash.update(chunk);
    const sha256 = hash.digest('hex');
    if (expected && sha256 !== expected) throw new Error(`SHA256 mismatch for ${filename}`);
    await rename(partial, archive);
    validateArchiveEntries(await runner('tar', ['-tf', archive]));
    const detailed = await runner('tar', ['-tvf', archive]);
    if (detailed.split(/\r?\n/).some(line => /^[lh]/.test(line))) throw new Error('Links are not allowed in the Mutagen release archive');
    const extracted = path.join(staging, 'extracted');
    await mkdir(extracted);
    if (filename.endsWith('.zip') && platform === 'win32') {
      await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Expand-Archive -LiteralPath $env:HAPPYPANDA_MUTAGEN_ARCHIVE -DestinationPath $env:HAPPYPANDA_MUTAGEN_EXTRACT -Force'],
      { ...process.env, HAPPYPANDA_MUTAGEN_ARCHIVE: archive, HAPPYPANDA_MUTAGEN_EXTRACT: extracted });
    } else await runner('tar', ['-xzf', archive, '-C', extracted]);
    const entries = await readdir(extracted, { withFileTypes: true });
    const executable = path.join(destination, platform === 'win32' ? 'mutagen.exe' : 'mutagen');
    if (!entries.some(entry => entry.name === path.basename(executable)) || !entries.some(entry => entry.name === 'mutagen-agents.tar.gz')) throw new Error('Release must contain the CLI and mutagen-agents.tar.gz');
    for (const entry of entries) {
      if (!entry.isFile() || (await lstat(path.join(extracted, entry.name))).isSymbolicLink()) throw new Error(`Unexpected release archive entry: ${entry.name}`);
    }
    const installed = [];
    for (const entry of entries) {
      const target = path.join(destination, entry.name);
      const source = path.join(extracted, entry.name);
      if (entry.name === 'mutagen') await chmod(source, 0o755);
      await rename(source, target);
      installed.push(entry.name);
    }
    await writeFile(path.join(destination, 'mutagen-install.json'), JSON.stringify({ version: release.tag_name, asset: filename, sha256, verified: Boolean(expected), installed }, null, 2));
    return { executable, version: release.tag_name, sha256, verified: Boolean(expected), warning: expected ? undefined : 'Release has no published SHA256 digest; HTTPS download was not independently checksum-verified' };
  } finally {
    const root = await realpath(destination);
    const target = await realpath(staging);
    const relative = path.relative(root, target);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(target).startsWith('.mutagen-install-')) await rm(target, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version' && args[i + 1]) options.version = args[++i];
    else if (args[i] === '--tools-dir' && args[i + 1]) options.toolsDir = args[++i];
    else throw new Error('Usage: node scripts/install-mutagen.mjs [--version v0.18.1] [--tools-dir path]');
  }
  installMutagen(options).then(result => {
    console.log(JSON.stringify(result, null, 2));
    if (result.warning) console.warn(result.warning);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
