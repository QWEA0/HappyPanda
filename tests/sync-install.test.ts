import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const installer = await import(pathToFileURL(path.resolve('scripts/install-mutagen.mjs')).href);
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe('official Mutagen installer', () => {
  it.each([['win32', 'x64', 'windows_amd64_v0.18.1.zip'], ['win32', 'arm64', 'windows_arm64_v0.18.1.zip'],
    ['darwin', 'arm64', 'darwin_arm64_v0.18.1.tar.gz'], ['linux', 'x64', 'linux_amd64_v0.18.1.tar.gz']])('selects the %s/%s official asset', (platform, arch, suffix) => {
    expect(installer.platformAsset(platform, arch, 'v0.18.1')).toBe(`mutagen_${suffix}`);
  });
  it('requires an exact checksum entry and rejects traversal in archives', () => {
    const sha = 'a'.repeat(64);
    expect(installer.checksumFor(`${sha} *asset.zip\n`, 'asset.zip')).toBe(sha);
    expect(installer.checksumFor(`${sha} other-asset.zip`, 'asset.zip')).toBeUndefined();
    expect(() => installer.validateArchiveEntries('mutagen.exe\n../../escape')).toThrow('Unsafe');
    expect(() => installer.validateArchiveEntries('C:\\escape')).toThrow('Unsafe');
  });
  it('verifies the download and uses ZIP extraction while retaining the agent archive', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'happypanda-installer-')); directories.push(directory);
    const content = Buffer.from('mock release ZIP bytes');
    const sha = createHash('sha256').update(content).digest('hex');
    const filename = 'mutagen_windows_amd64_v0.18.1.zip';
    const release = { tag_name: 'v0.18.1', assets: [
      { name: filename, browser_download_url: `https://github.com/mutagen-io/mutagen/releases/download/v0.18.1/${filename}` },
      { name: 'SHA256SUMS', browser_download_url: 'https://github.com/mutagen-io/mutagen/releases/download/v0.18.1/SHA256SUMS' },
    ] };
    const fetchImpl = vi.fn(async (url: string) => new Response(url.includes('/releases/latest') ? JSON.stringify(release) : url.endsWith('SHA256SUMS') ? `${sha}  ${filename}\n` : content));
    const runner = vi.fn(async (file: string, args: string[], env?: NodeJS.ProcessEnv) => {
      if (args[0] === '-tf') return 'mutagen.exe\nmutagen-agents.tar.gz\n';
      if (args[0] === '-tvf') return '-rw-r--r-- mutagen.exe\n-rw-r--r-- mutagen-agents.tar.gz\n';
      expect(file).toBe('powershell.exe');
      expect(args).toContain('Expand-Archive -LiteralPath $env:HAPPYPANDA_MUTAGEN_ARCHIVE -DestinationPath $env:HAPPYPANDA_MUTAGEN_EXTRACT -Force');
      await writeFile(path.join(env!.HAPPYPANDA_MUTAGEN_EXTRACT!, 'mutagen.exe'), 'CLI');
      await writeFile(path.join(env!.HAPPYPANDA_MUTAGEN_EXTRACT!, 'mutagen-agents.tar.gz'), 'agents');
      return '';
    });
    const result = await installer.installMutagen({ toolsDir: directory, platform: 'win32', arch: 'x64', fetchImpl, runner });
    expect(result.verified).toBe(true); expect(result.sha256).toBe(sha);
    expect(await readFile(path.join(directory, 'mutagen-agents.tar.gz'), 'utf8')).toBe('agents');
    expect(JSON.parse(await readFile(path.join(directory, 'mutagen-install.json'), 'utf8')).verified).toBe(true);
    expect(fetchImpl.mock.calls.every(([url]) => url.startsWith('https://api.github.com/repos/mutagen-io/mutagen/') || url.startsWith('https://github.com/mutagen-io/mutagen/'))).toBe(true);
  });
  it('fails before extraction when the published SHA256 does not match', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'happypanda-installer-')); directories.push(directory);
    const filename = 'mutagen_linux_amd64_v0.18.1.tar.gz';
    const fetchImpl = vi.fn(async (url: string) => new Response(url.includes('/releases/latest') ? JSON.stringify({ tag_name: 'v0.18.1', assets: [
      { name: filename, digest: `sha256:${'0'.repeat(64)}`, browser_download_url: `https://github.com/mutagen-io/mutagen/releases/download/v0.18.1/${filename}` },
    ] }) : 'corrupt bytes'));
    const runner = vi.fn();
    await expect(installer.installMutagen({ toolsDir: directory, platform: 'linux', arch: 'x64', fetchImpl, runner })).rejects.toThrow('SHA256 mismatch');
    expect(runner).not.toHaveBeenCalled();
  });
});
