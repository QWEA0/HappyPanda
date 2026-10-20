const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');

async function main() {
  const [configPath, mode, ...args] = process.argv.slice(2);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const endpoint = new URL(config.url);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw new Error();
  const request = async (route, input) => {
    const response = await fetch(new URL(route, endpoint), {method:'POST',redirect:'error',
      headers:{Authorization:config.token,'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error();
    return response.json();
  };
  if (mode === 'askpass') {
    const result = await request('/password', {nodeId:process.env.HAPPYPANDA_SSH_NODE,prompt:args.join(' ')});
    process.stdout.write(result.password + '\n');
    return;
  }
  if (mode !== 'ssh' && mode !== 'scp') throw new Error();
  const route = await request('/transport', {kind:mode,args});
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  if (route.nodeId) Object.assign(env, {SSH_ASKPASS:path.join(path.dirname(configPath), process.platform === 'win32' ? 'askpass.exe' : 'askpass'),
    SSH_ASKPASS_REQUIRE:'force',DISPLAY:'happypanda',HAPPYPANDA_SSH_CONFIG:configPath,HAPPYPANDA_SSH_NODE:route.nodeId});
  const child = spawn(route.executable, route.args, {env,stdio:'inherit',windowsHide:true});
  child.on('error', () => {process.stderr.write('HappyPanda SSH transport could not start\n');process.exitCode=1;});
  child.on('exit', code => {process.exitCode=code ?? 1;});
  for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => {child.kill(signal);});
}
main().catch(() => {process.stderr.write('HappyPanda SSH authentication failed; check the saved node and password\n');process.exitCode=1;});
