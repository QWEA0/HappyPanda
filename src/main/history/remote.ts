import type { ServiceNode } from '../../shared/types';
import type { RunRemote } from '../sync/remote';
import { shellQuote } from '../sync/transport';

export interface ArchiveFile { relativePath: string; sha256: string; bytes: number }
export interface ArchiveProbe { root: string; path: string; part: string; ready: boolean; recoveredPart?: boolean }

const ARCHIVE_SCRIPT = String.raw`
import os, sys, json, base64, hashlib, stat, re
p = json.loads(base64.b64decode(sys.argv[1]))
if not re.fullmatch(r'[a-f0-9]{32}', p['workspaceKey']) or not re.fullmatch(r'[a-f0-9]{64}', p['manifestHash']):
    raise ValueError('Invalid app archive identity')
home = os.path.realpath(os.path.expanduser('~'))
base = os.path.join(home, '.local', 'share', 'happypanda', 'history')
root = os.path.join(base, p['workspaceKey'], p['manifestHash'])
def directories(directory):
    if os.path.commonpath([home, directory]) != home:
        raise ValueError('Archive is outside the remote home')
    current = home
    for component in os.path.relpath(directory, home).split(os.sep):
        if component in ('', '.', '..'):
            raise ValueError('Invalid archive directory')
        current = os.path.join(current, component)
        if os.path.islink(current) or getattr(os.path, 'isjunction', lambda p: False)(current):
            raise ValueError('Archive directories must not be symbolic links')
        if os.path.lexists(current):
            if not os.path.isdir(current):
                raise ValueError('Archive directory is not a directory')
        else:
            os.mkdir(current, 0o700)
def checked(relative):
    parts = relative.split('/')
    if any(part in ('', '.', '..') for part in parts) or '\\' in relative or '\x00' in relative:
        raise ValueError('Archive file escapes its root')
    result = os.path.join(root, *parts)
    if os.path.commonpath([root, result]) != root:
        raise ValueError('Archive file escapes its root')
    directories(os.path.dirname(result))
    if os.path.islink(result):
        raise ValueError('Archive file must not be a symbolic link')
    return result
def matches(target, expected):
    if not os.path.lexists(target):
        return False
    info = os.lstat(target)
    if not stat.S_ISREG(info.st_mode):
        raise ValueError('Archive entry is not a regular file')
    if info.st_size != expected['bytes']:
        return False
    digest = hashlib.sha256()
    with open(target, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest() == expected['sha256']
directories(root)
action = p['action']
if action == 'init':
    result = {'root': root}
else:
    entry = p['file']
    if not re.fullmatch(r'[a-f0-9]{64}', entry['sha256']) or not isinstance(entry['bytes'], int) or entry['bytes'] < 0:
        raise ValueError('Invalid archive checksum or size')
    target = checked(entry['relativePath'])
    part = checked(entry['relativePath'] + '.part')
    if os.path.lexists(target):
        if not matches(target, entry):
            raise ValueError('Existing content-addressed archive is corrupt; it was preserved for review')
        result = {'root': root, 'path': target, 'part': part, 'ready': True}
    elif action == 'probe':
        ready = matches(part, entry)
        if ready:
            os.replace(part, target)
        result = {'root': root, 'path': target, 'part': part, 'ready': ready, 'recoveredPart': ready}
    elif action == 'commit':
        if not matches(part, entry):
            raise ValueError('Uploaded .part failed SHA256/size verification')
        os.replace(part, target)
        result = {'root': root, 'path': target, 'part': part, 'ready': True}
    else:
        raise ValueError('Unknown archive operation')
for key in ['root', 'path', 'part']:
    if key in result:
        result[key] = result[key].replace(os.sep, '/')
print(json.dumps(result))
`;

export async function archiveOperation<T>(runRemote: RunRemote, node: ServiceNode, payload: Record<string, unknown>): Promise<T> {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  const output = await runRemote(node, `python3 -c ${shellQuote(ARCHIVE_SCRIPT)} ${shellQuote(encoded)}`);
  return JSON.parse(output.trim()) as T;
}
