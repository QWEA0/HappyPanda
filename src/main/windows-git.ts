import type {ServiceNode} from '../shared/types';
import {runRemote,shellQuote} from './ssh';

const SCRIPT=String.raw`
import sys,json,base64,subprocess,os
p=json.loads(base64.b64decode(sys.argv[1]))
root=p['root']
def git(args,check=True):
    result=subprocess.run(['git','-C',root]+args,capture_output=True)
    if check and result.returncode:
        raise RuntimeError(result.stderr.decode('utf-8',errors='replace').strip() or 'Git command failed')
    return result
action=p['action']
if action=='existing':
    if os.path.isdir(os.path.join(root,'.git')) and git(['rev-parse','--verify','HEAD'],False).returncode==0:
        print('existing')
elif action=='bootstrap':
    git(['init','-q'])
    git(['fetch','-q',p['bundle'],'HEAD:refs/heads/workspace'])
    git(['symbolic-ref','HEAD','refs/heads/workspace'])
    git(['reset','--mixed','-q',p['head']])
    os.unlink(p['bundle'])
elif action=='settings':
    for key,value in p['settings'].items():
        git(['config','--local',key,value])
elif action=='bundle':
    exclusion=['^'+p['head']] if git(['cat-file','-e',p['head']+'^{commit}'],False).returncode==0 else []
    git(['bundle','create',p['bundle'],'HEAD']+exclusion)
elif action=='remove':
    if os.path.commonpath([os.path.abspath(root),os.path.abspath(p['bundle'])])!=os.path.abspath(root):
        raise ValueError('Git transfer is outside the workspace')
    try: os.unlink(p['bundle'])
    except FileNotFoundError: pass
elif action=='git':
    result=git(p['args'])
    sys.stdout.buffer.write(result.stdout)
else:
    raise ValueError('Invalid native Git operation')
`;
export function windowsGit(node:ServiceNode,root:string,action:string,values:Record<string,unknown>={},timeoutMs=45000) {
  const payload=Buffer.from(JSON.stringify({root,action,...values})).toString('base64');
  return runRemote(node,'python3 -c '+shellQuote(SCRIPT)+' '+shellQuote(payload),undefined,timeoutMs);
}
