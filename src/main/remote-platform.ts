import type { ServiceNode } from '../shared/types';

export interface RemoteRuntime {
  platform: 'windows' | 'posix';
  python?: string;
  node?: string;
  home?: string;
  architecture?: string;
  sftp?: string;
  mutagenAgent?: string;
}
const runtimes = new Map<string, RemoteRuntime>();
export const runtimeKey = (node:ServiceNode) => JSON.stringify([node.id,node.sshTarget,node.user,node.port]);
export const knownRemoteRuntime = (node:ServiceNode) => runtimes.get(runtimeKey(node));
export const setRemoteRuntime = (node:ServiceNode,runtime:RemoteRuntime) => runtimes.set(runtimeKey(node),runtime);
export const isWindowsRemote = (node:ServiceNode) => knownRemoteRuntime(node)?.platform === 'windows';
export const powershellQuote = (value:string) => "'" + value.replaceAll("'","''") + "'";
export function powershellCommand(script:string):string {
  return 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + Buffer.from(script,'utf16le').toString('base64');
}
export const WINDOWS_PROBE = powershellCommand(String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$python=@('python.exe','python3.exe') | ForEach-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Where-Object { $_.Source -notmatch '\\WindowsApps\\' } | Select-Object -First 1
if(-not $python){throw 'HappyPanda: install Python 3.9 or later for Windows; the Microsoft Store python3 alias is not a Python runtime.'}
$node=Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if(-not $node){throw 'HappyPanda: install Node.js 22 or later for Windows.'}
$version=& $python.Source -c 'import sys; print(sys.version_info >= (3,9))'
if($LASTEXITCODE -ne 0 -or $version -ne 'True'){throw 'HappyPanda: Python 3.9 or later is required.'}
$sftp=Join-Path $env:WINDIR 'System32\OpenSSH\sftp-server.exe'
@{platform='windows';python=$python.Source;node=$node.Source;home=$env:USERPROFILE.Replace('\','/');architecture=$env:PROCESSOR_ARCHITECTURE;sftp=$(if(Test-Path $sftp){$sftp}else{$null})} | ConvertTo-Json -Compress
`);

export function windowsPythonCommand(runtime:RemoteRuntime,code:string,args:string[]=[]):string {
  if (!runtime.python) throw new Error('Windows Python runtime is missing');
  const bootstrap = "import base64;exec(base64.b64decode('" + Buffer.from(code).toString('base64') + "'))";
  return powershellCommand("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $env:PYTHONIOENCODING='utf-8'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); & " +
    [runtime.python,'-u','-c',bootstrap,...args].map(powershellQuote).join(' ') + '; exit $LASTEXITCODE');
}

export const WINDOWS_EXECUTION = String.raw`
import shlex
def execute_windows(command, data):
    args = shlex.split(command)
    if not args:
        raise ValueError('Empty remote command')
    if args[0] == 'python3':
        args[0] = sys.executable
        return subprocess.run(args, input=data, capture_output=True, env=dict(os.environ, PYTHONIOENCODING='utf-8'))
    if command == 'printf "%s" "$HOME"':
        return subprocess.CompletedProcess(args, 0, os.path.expanduser('~').replace('\\','/').encode(), b'')
    if args[0] == 'claude' and args[1:] == ['--version']:
        helper = os.path.join(os.path.expanduser('~'), '.local', 'share', 'happypanda', 'hp_remote.py')
        if os.path.isfile(helper):
            command = __import__('runpy').run_path(helper)['claude_command']({'platform':'windows'})
            return subprocess.run(command+['--version'], input=data, capture_output=True)
        executable = __import__('shutil').which('claude.exe')
        if not executable:
            package = os.path.join(os.environ.get('APPDATA',''), 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
            return subprocess.run([__import__('shutil').which('node.exe'), package, '--version'], input=data, capture_output=True)
        return subprocess.run([executable, '--version'], input=data, capture_output=True)
    encoded = base64.b64encode(command.encode('utf-16le')).decode()
    return subprocess.run(['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], input=data, capture_output=True)
`;

export const WINDOWS_STDIN_BOOTSTRAP = 'import sys,base64;exec(base64.b64decode(sys.stdin.buffer.readline()))';
export function windowsOneShot(runtime:RemoteRuntime,command:string) {
  const script='import sys,os,json,base64,subprocess\n'+WINDOWS_EXECUTION+
    '\nr=execute_windows('+JSON.stringify(command)+',sys.stdin.buffer.read());sys.stdout.buffer.write(r.stdout);sys.stderr.buffer.write(r.stderr);sys.exit(r.returncode)';
  return {command:windowsPythonCommand(runtime,WINDOWS_STDIN_BOOTSTRAP),prefix:Buffer.from(Buffer.from(script).toString('base64')+'\n')};
}
