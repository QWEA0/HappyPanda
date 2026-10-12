import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { realpath } from 'node:fs/promises';

// A model-free proof: VPS -> loopback SSH tunnel -> local process -> VPS.
// This accepts one fixed, harmless probe, not arbitrary commands.
const host = process.argv[2] ?? process.env.HAPPYPANDA_SMOKE_NODE;
if (!host || !/^[a-zA-Z0-9_.@-]+$/.test(host) || host.startsWith('-')) {
  throw new Error('Pass an SSH destination as the first argument or set HAPPYPANDA_SMOKE_NODE.');
}
const workspace = await realpath(process.cwd());
const token = randomBytes(32).toString('hex');
const probeCode = 'console.log(JSON.stringify({platform:process.platform,cwd:process.cwd(),node:process.version}))';
const probeArgv = [process.execPath, '-e', probeCode];
let executions = 0;
const children = new Set();

function start(executable, args, options = {}) {
  const child = spawn(executable, args, { windowsHide: true, ...options });
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}

function collect(child, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Process timed out'));
    }, timeoutMs);
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: code, signal });
    });
  });
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/probe') {
      return json(response, 404, { error: 'Not found' });
    }
    const supplied = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from('Bearer ' + token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return json(response, 401, { error: 'Unauthorized' });
    }
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (Buffer.byteLength(body) > 8192) {
        return json(response, 413, { error: 'Request too large' });
      }
    }
    const payload = JSON.parse(body);
    assert.deepEqual(payload.argv, probeArgv);
    assert.equal(payload.cwd, '.');
    assert.equal(executions, 0);
    executions += 1;
    const result = await collect(start(probeArgv[0], probeArgv.slice(1), {
      cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'],
    }));
    json(response, 200, { ...result, executor: 'local', cwd: workspace });
  } catch {
    json(response, 400, { error: 'Invalid probe' });
  }
});

const sshOptions = [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12',
  '-o', 'StrictHostKeyChecking=yes', '-o', 'ControlMaster=no',
  '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
];

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const localPort = server.address().port;
  const unauthorized = await fetch('http://127.0.0.1:' + localPort + '/probe', {
    method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(unauthorized.status, 401);
  const tunnel = start('ssh', [
    ...sshOptions, '-o', 'ExitOnForwardFailure=yes', '-N',
    '-R', '127.0.0.1:0:127.0.0.1:' + localPort, host,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const remotePort = await new Promise((resolve, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => {
      tunnel.kill();
      reject(new Error('SSH tunnel allocation timed out'));
    }, 20000);
    tunnel.stderr.on('data', (data) => {
      stderr += data.toString();
      const allocation = stderr.match(/Allocated port (\d+) for remote forward/);
      if (allocation) { clearTimeout(timeout); resolve(Number(allocation[1])); }
    });
    tunnel.once('error', (error) => { clearTimeout(timeout); reject(error); });
    tunnel.once('close', (code) => {
      clearTimeout(timeout);
      reject(new Error('SSH tunnel exited (' + code + '): ' + stderr));
    });
  });

  // The token travels through SSH stdin and is never stored or logged.
  const remoteCode = [
    'import json,sys,urllib.request',
    'p=json.load(sys.stdin)',
    'r=urllib.request.Request(p["url"],data=json.dumps(p["body"]).encode(),headers={"Authorization":"Bearer "+p["token"],"Content-Type":"application/json"},method="POST")',
    'print(urllib.request.urlopen(r,timeout=15).read().decode())',
  ].join(';');
  const encodedCode = Buffer.from(remoteCode).toString('base64');
  const remote = start('ssh', [
    ...sshOptions, host,
    'python3 -c \'import base64;exec(base64.b64decode("' + encodedCode + '"))\'',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const remoteResultPromise = collect(remote);
  remote.stdin.end(JSON.stringify({
    url: 'http://127.0.0.1:' + remotePort + '/probe', token,
    body: { argv: probeArgv, cwd: '.' },
  }));
  const remoteResult = await remoteResultPromise;
  assert.equal(remoteResult.exitCode, 0, remoteResult.stderr);
  const result = JSON.parse(remoteResult.stdout);
  const environment = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 0);
  assert.equal(environment.platform, process.platform);
  assert.equal(environment.cwd, workspace);
  assert.equal(executions, 1);
  console.log(JSON.stringify({
    ok: true, sshDestination: host, transport: 'SSH reverse forwarding',
    authenticationCheck: 'unauthorized request rejected', ...result,
  }, null, 2));
} finally {
  await Promise.all([...children].map((child) => new Promise((resolve) => {
    child.once('close', resolve);
    child.kill();
  })));
  await new Promise((resolve) => server.close(resolve));
}
