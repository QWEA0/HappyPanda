import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ServiceNode, Workspace, SessionInfo, NodeInput } from '../shared/types';
import type { SecretEncryption } from './providers';

const nodeSchema = z.object({
  id: z.string(), name: z.string(), sshTarget: z.string(), user: z.string().optional(),
  port: z.number().optional(), identityFile: z.string().optional(),
  authType: z.enum(['key', 'password']).optional(), encryptedPassword: z.string().optional(),
  lastWorkspaceId: z.string().optional(), lastSessionId: z.string().optional(), providerId: z.string().optional(), loginViaNode: z.boolean().optional(), createdAt: z.string(),
});
const inventorySchema = z.object({
  nodes: z.array(nodeSchema), workspaces: z.array(z.object({
    id: z.string(), nodeId: z.string(), name: z.string(), localPath: z.string(), remotePath: z.string(),
    localAccess: z.boolean(), mode: z.enum(['sync', 'mcp-only']).optional(), syncSessionName: z.string(), syncGitIgnores: z.array(z.string()).optional(), createdAt: z.string(),
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
  authType: z.enum(['key', 'password']).optional(),
  password: z.string().max(1023).refine(value => !/[\r\n\0]/.test(value) && Buffer.byteLength(value) <= 1023).optional(),
});

export class InventoryStore {
  nodes: ServiceNode[] = [];
  workspaces: Workspace[] = [];
  sessions: SessionInfo[] = [];
  private writes: Promise<void> = Promise.resolve();
  private passwords = new Map<string, string>();
  constructor(readonly dataDir: string, private encryption?: SecretEncryption) {}
  async load() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const data = inventorySchema.parse(JSON.parse(await readFile(join(this.dataDir,'inventory.json'),'utf8')));
      this.nodes = data.nodes.map(({encryptedPassword, ...node}) => {
        if (encryptedPassword) this.passwords.set(node.id, encryptedPassword);
        return {...node, ...(node.authType === 'password' ? {hasPassword: Boolean(encryptedPassword)} : {})};
      }); this.workspaces = data.workspaces.map(workspace => ({...workspace, localAccess: workspace.mode === 'mcp-only' || workspace.localAccess})); this.sessions = data.sessions;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Saved node inventory is invalid; original file has been preserved.', { cause: error });
      }
    }
  }
  save(): Promise<void> {
    if (this.deferred) { clearTimeout(this.deferred); this.deferred = undefined; }
    const snapshot = JSON.stringify({ nodes:this.nodes.map(({hasPassword: _, ...node}) => ({...node,
      ...(node.authType === 'password' && this.passwords.has(node.id) ? {encryptedPassword:this.passwords.get(node.id)} : {})})), workspaces:this.workspaces, sessions:this.sessions }, null, 2);
    this.writes = this.writes.catch(() => {}).then(async () => {
      const target = join(this.dataDir,'inventory.json');
      const temporary = target + '.' + randomUUID() + '.tmp';
      await writeFile(temporary,snapshot,{mode:0o600});
      await rename(temporary,target);
    });
    return this.writes;
  }
  // For frequent, low-value updates (lastActiveAt, lastSessionId): coalesce writes.
  private deferred?: ReturnType<typeof setTimeout>;
  saveSoon(delayMs = 1000): void {
    if (this.deferred) return;
    this.deferred = setTimeout(() => { this.deferred = undefined; void this.save().catch(() => {}); }, delayMs);
    this.deferred.unref?.();
  }
  async saveNode(input: NodeInput) {
    const parsed = nodeInputSchema.safeParse(input);
    if (!parsed.success) throw new Error('请检查节点名称、SSH 目标、用户名、端口和密码。');
    const {password, ...valid} = parsed.data;
    const existing = valid.id ? this.nodes.find(node => node.id === valid.id) : undefined;
    if (valid.id && !existing) throw new Error('Node not found');
    const node: ServiceNode = { ...existing, ...valid, id:existing?.id ?? randomUUID(), createdAt:existing?.createdAt ?? new Date().toISOString() };
    if (node.authType === 'password') {
      if (!password && !this.passwords.has(node.id)) throw new Error('请输入 SSH 登录密码。');
      if (password) {
        if (!this.encryption?.available()) throw new Error('系统加密服务不可用，无法保存 SSH 密码。');
        this.passwords.set(node.id, this.encryption.encrypt(password).toString('base64'));
      }
      node.hasPassword = true;
    } else {
      this.passwords.delete(node.id);
      delete node.hasPassword;
    }
    if (existing) this.nodes = this.nodes.map(item => item.id === node.id ? node : item);
    else this.nodes.push(node);
    await this.save(); return node;
  }
  password(id: string): string {
    const encrypted = this.passwords.get(id);
    if (this.node(id).authType !== 'password' || !encrypted) throw new Error('请编辑节点并输入 SSH 密码。');
    try {
      if (!this.encryption?.available()) throw new Error();
      return this.encryption.decrypt(Buffer.from(encrypted, 'base64'));
    } catch { throw new Error('SSH 密码无法解密，请编辑节点并重新输入。'); }
  }
  node(id: string) { const node=this.nodes.find(item=>item.id===id); if(!node) throw new Error('Node not found'); return node; }
  workspace(id: string) { const workspace=this.workspaces.find(item=>item.id===id); if(!workspace) throw new Error('Workspace not found'); return workspace; }
}
