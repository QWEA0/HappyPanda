import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { smokeNode } from './smoke-node';
import { runRemote, shellQuote } from '../src/main/ssh';

const node = smokeNode();
const script = await readFile(resolve('scripts/provider-smoke-remote.py'), 'utf8');
const bootstrap = await readFile(resolve('resources/bootstrap.py'), 'utf8');
const helper = (await readFile(resolve('resources/hp_remote.py'))).toString('base64');
const command = 'python3 -c ' + shellQuote('import base64;exec(base64.b64decode(' + JSON.stringify(Buffer.from(script).toString('base64')) + '))');
const result = JSON.parse(await runRemote(node, command, JSON.stringify({ bootstrap, helper }), 60000));
await mkdir(resolve('.local'), { recursive: true });
await writeFile(resolve('.local/provider-smoke-result.json'), JSON.stringify({ ...result, completedAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify(result, null, 2));
