import type { ServiceNode } from '../../shared/types';
import { shellQuote } from './transport';

export type RunRemote = (node: ServiceNode, command: string) => Promise<string>;
export interface Fingerprint { exists: boolean; sha256?: string; bytes?: number }

const FILE_SCRIPT = String.raw`
import os, sys, json, base64, hashlib, stat
p = json.loads(base64.b64decode(sys.argv[1]))
root = p['root']
if root.startswith('$HOME/'):
    root = os.path.join(os.path.expanduser('~'), root[6:])
elif root.startswith('~/'):
    root = os.path.join(os.path.expanduser('~'), root[2:])
if not os.path.isabs(root) or '..' in root.split('/') or '.git' in root.split('/') or '\\' in root:
    raise ValueError('Invalid remote workspace root')
root = os.path.normpath(root)
if root == '/':
    raise ValueError('Filesystem root is not a workspace')
def directories(directory, create=False):
    drive, tail = os.path.splitdrive(directory)
    current = drive + os.sep
    for component in tail.strip('/\\').replace('\\','/').split('/'):
        current = os.path.join(current, component)
        if os.path.islink(current) or getattr(os.path, 'isjunction', lambda p: False)(current):
            raise ValueError('Remote symbolic link is not allowed: ' + current)
        if os.path.lexists(current):
            if not os.path.isdir(current):
                raise ValueError('Expected a remote directory: ' + current)
        elif create:
            os.mkdir(current, 0o700)
def checked(relative, create=False):
    parts = relative.split('/')
    if not relative or any((c.lower() if os.name == 'nt' else c) in ('', '.', '..', '.git') for c in parts) or '\\' in relative:
        raise ValueError('Path escapes remote workspace')
    target = os.path.join(root, *parts)
    if os.path.commonpath([root, target]) != root:
        raise ValueError('Path escapes remote workspace')
    directories(os.path.dirname(target), create)
    if os.path.islink(target):
        raise ValueError('Remote symbolic link is not allowed')
    return target
def fingerprint(target):
    if not os.path.lexists(target):
        return {'exists': False}
    before = os.lstat(target)
    if not stat.S_ISREG(before.st_mode):
        raise ValueError('Only single regular files or deletions can be resolved; directories require manual review')
    digest = hashlib.sha256()
    with open(target, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    after = os.lstat(target)
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
        raise ValueError('Remote file changed while reading')
    return {'exists': True, 'sha256': digest.hexdigest(), 'bytes': before.st_size}
action = p['action']
directories(root, action == 'ensure')
if not os.path.isdir(root):
    raise ValueError('Remote workspace root no longer exists')
if action == 'ensure':
    result = {'root': root}
else:
    target = checked(p['relative'], action in ('prepare', 'replace'))
    current = fingerprint(target)
    if action == 'inspect':
        result = current
    elif action == 'prepare':
        part = checked(p['part'], True)
        if os.path.lexists(part):
            raise ValueError('Temporary destination already exists')
        result = {'part': part}
    elif action in ('replace', 'delete'):
        if current != p['expected']:
            raise ValueError('Remote destination changed; review the conflict again')
        if action == 'delete':
            if current['exists']:
                os.unlink(target)
        else:
            part = checked(p['part'])
            if fingerprint(part) != p['source']:
                raise ValueError('Transferred conflict file failed SHA256 verification')
            os.replace(part, target)
        result = {'ok': True}
    else:
        raise ValueError('Unknown file operation')
if isinstance(result.get('root'), str):
    result['root'] = result['root'].replace(os.sep, '/')
if isinstance(result.get('part'), str):
    result['part'] = result['part'].replace(os.sep, '/')
print(json.dumps(result))
`;

export async function remoteFileOperation<T>(runRemote: RunRemote, node: ServiceNode, payload: Record<string, unknown>): Promise<T> {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  const output = await runRemote(node, `python3 -c ${shellQuote(FILE_SCRIPT)} ${shellQuote(encoded)}`);
  return JSON.parse(output.trim()) as T;
}
