import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ServiceNode, Workspace, SessionInfo, NodeInput } from '../shared/types';

const nodeSchema = z.object({
  id: z.string(), name: z.string(), sshTarget: z.string(), user: z.string().optional(),
  port: z.number().optional(), identityFile: z.string().optional(),
  lastWorkspaceId: z.string().optional(), lastSessionId: z.string().optional(), providerId: z.string().optional(), loginViaNode: z.boolean().optional(), createdAt: z.string(),
});
const inventorySchema = z.object({
  nodes: z.array(nodeSchema), workspaces: z.array(z.object({
    id: z.string(), nodeId: z.string(), name: z.string(), localPath: z.string(), remotePath: z.string(),
    localAccess: z.boolean(), syncSessionName: z.string(), syncGitIgnores: z.array(z.string()).optional(), createdAt: z.string(),
  })), sessions: z.array(z.object({
    id: z.string(), nodeId: z.string(), workspaceId: z.string().optional(), title: z.string(), tmuxName: z.string(),
    createdAt: z.string(), lastActiveAt: z.string(), kind: z.enum(['claude','login','shell']), transcriptPath: z.string().optional(), reloadToken: z.string().optional(),
  })),
});
const nodeInputSchema = z.object({
  id: z.string().optional(), name: z.string().trim().min(1).max(80),
  sshTarget: z.string().regex(/^(?!-)[A-Za-z0-9_.@-]+$/).max(160),
  user: z.string().regex(/^[A-Za-z0-9_.-]+$/).optional(), port: z.number().int().min(1).max(65535).optional(),
  identityFile: z.string().refine(value => !/[\r\n\0]/.test(value)).optional(),
});

export class InventoryStore {
  nodes: ServiceNode[] = [];
  workspaces: Workspace[] = [];
  sessions: SessionInfo[] = [];
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly dataDir: string) {}
  async load() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const data = inventorySchema.parse(JSON.parse(await readFile(join(this.dataDir,'inventory.json'),'utf8')));
      this.nodes = data.nodes; this.workspaces = data.workspaces; this.sessions = data.sessions;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Saved node inventory is invalid; original file has been preserved.', { cause: error });
      }
    }
  }
  save(): Promise<void> {
    const snapshot = JSON.stringify({ nodes:this.nodes, workspaces:this.workspaces, sessions:this.sessions }, null, 2);
    this.writes = this.writes.catch(() => {}).then(async () => {
      const target = join(this.dataDir,'inventory.json');
      const temporary = target + '.' + randomUUID() + '.tmp';
      await writeFile(temporary,snapshot,{mode:0o600});
      await rename(temporary,target);
    });
    return this.writes;
  }
  async saveNode(input: NodeInput) {
    const valid = nodeInputSchema.parse(input);
    const existing = valid.id ? this.nodes.find(node => node.id === valid.id) : undefined;
    if (valid.id && !existing) throw new Error('Node not found');
    const node: ServiceNode = { ...existing, ...valid, id:existing?.id ?? randomUUID(), createdAt:existing?.createdAt ?? new Date().toISOString() };
    if (existing) this.nodes = this.nodes.map(item => item.id === node.id ? node : item);
    else this.nodes.push(node);
    await this.save(); return node;
  }
  node(id: string) { const node=this.nodes.find(item=>item.id===id); if(!node) throw new Error('Node not found'); return node; }
  workspace(id: string) { const workspace=this.workspaces.find(item=>item.id===id); if(!workspace) throw new Error('Workspace not found'); return workspace; }
}
