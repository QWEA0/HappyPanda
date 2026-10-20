import {describe,expect,it} from 'vitest';
import {powershellCommand,windowsPythonCommand,windowsOneShot,WINDOWS_STDIN_BOOTSTRAP,setRemoteRuntime} from '../src/main/remote-platform';
import {remoteCommandArguments} from '../src/main/ssh';
import {remoteRoot,mutagenRemoteEndpoint} from '../src/main/sync/transport';
import {TEST_NODE} from './fixtures/node';

describe('native Windows remote commands',()=>{
  const runtime={platform:'windows' as const,python:'C:\\Program Files\\Python312\\python.exe',node:'C:\\Program Files\\nodejs\\node.exe'};
  it('encodes PowerShell safely and preserves Python literals with legacy Windows argument passing',()=>{
    const command=windowsPythonCommand(runtime,'print("synthetic value")');
    const script=Buffer.from(command.split(' ').at(-1)!,'base64').toString('utf16le');
    expect(script).toContain("'C:\\Program Files\\Python312\\python.exe'");
    expect(script).toContain("base64.b64decode(''");
    expect(command).not.toContain('synthetic value');
  });
  it('streams long one-shot programs through stdin below the Windows command-line limit',()=>{
    const result=windowsOneShot(runtime,'python3 -c '+"'"+'# large program\n'.repeat(3000)+"'");
    expect(result.command.length).toBeLessThan(8000);
    expect(result.prefix.length).toBeGreaterThan(32000);
    expect(Buffer.from(result.prefix.toString().trim(),'base64').toString()).toContain('execute_windows');
    expect(WINDOWS_STDIN_BOOTSTRAP).toContain('readline()');
  });
  it('passes encoded commands as separate Windows SSH arguments',()=>{
    const node={...TEST_NODE,id:'native-argument-test'};setRemoteRuntime(node,runtime);
    const command=powershellCommand('Write-Output "safe value"');
    expect(remoteCommandArguments(node,command).at(-1)).toBe(Buffer.from('Write-Output "safe value"','utf16le').toString('base64'));
    expect(remoteCommandArguments(node,command)[0]).toBe('powershell.exe');
  });
  it('accepts native drive paths while rejecting drive roots and traversal',()=>{
    expect(remoteRoot('C:/Users/fixture/project')).toBe('C:/Users/fixture/project');
    expect(mutagenRemoteEndpoint({...TEST_NODE,user:'fixture',port:2222},'D:/workspace/project')).toBe('fixture@'+TEST_NODE.sshTarget+':2222:D:/workspace/project');
    for(const value of ['C:/','D:/project/../outside','D:/project/.Git','C:\\project']){
      expect(()=>remoteRoot(value)).toThrow();
    }
  });
});
