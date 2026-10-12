import type { ServiceNode } from '../src/shared/types';

export function smokeNode(): ServiceNode {
  const sshTarget = process.argv[2] || process.env.HAPPYPANDA_SMOKE_NODE;
  if (!sshTarget || !/^(?!-)[A-Za-z0-9_.@-]+$/.test(sshTarget) || sshTarget.length > 160) {
    throw new Error('Pass an SSH destination as the first argument or set HAPPYPANDA_SMOKE_NODE.');
  }
  return { id: 'smoke-node', name: 'Smoke test server', sshTarget, createdAt: '' };
}
