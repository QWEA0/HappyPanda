import {beforeEach,describe,expect,it,vi} from 'vitest';
import {resolve} from 'node:path';
const mocks=vi.hoisted(()=>({process:vi.fn(),remote:vi.fn(),upload:vi.fn()}));
vi.mock('../src/main/ssh',async original=>({...await original<typeof import('../src/main/ssh')>(),runProcess:mocks.process,runRemote:mocks.remote,uploadFile:mocks.upload}));
import {GitWorkspace} from '../src/main/git';
import type {Workspace,ServiceNode} from '../src/shared/types';
const workspace:Workspace={id:'test',nodeId:'node',name:'test',localPath:resolve('test-project'),remotePath:'/srv/project',localAccess:false,syncSessionName:'test',createdAt:''};
const node:ServiceNode={id:'node',name:'node',sshTarget:'example',createdAt:''};
beforeEach(()=>{mocks.process.mockReset();mocks.remote.mockReset();mocks.upload.mockReset();});
describe('Git mirror comparison',()=>{
  it('aligns cross-platform comparison on existing repositories without changing refs, index or files',async()=>{
    mocks.process.mockImplementation(async(_file,args)=>{
      if(args.includes('--show-toplevel'))return workspace.localPath;
      if(args.includes('--verify'))return 'a'.repeat(40);
      if(args.at(-1)==='core.filemode')return 'false';
      if(args.at(-1)==='core.autocrlf')return 'true';
      throw new Error('unset');
    });
    mocks.remote.mockResolvedValueOnce('existing').mockResolvedValue('');
    expect(await new GitWorkspace(resolve('.local')).bootstrap(workspace,node)).toBe(false);
    const commands=mocks.remote.mock.calls.map(call=>call[1]).join('\n');
    expect(commands).toContain('config --local core.filemode false');
    expect(commands).toContain('config --local core.autocrlf true');
    expect(commands).not.toMatch(/reset|checkout|symbolic-ref|clean|update-ref/);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
