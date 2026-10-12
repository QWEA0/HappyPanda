import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ApiProvider, ProviderInput } from '../shared/types';

export interface SecretEncryption {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

const providerFields = {
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().trim().max(2048).refine(value => {
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) && Boolean(url.hostname) &&
        !url.username && !url.password && !url.search && !url.hash && !/[\s\x00-\x1f]/.test(value);
    } catch { return false; }
  }, '请输入不含用户名、密码、查询参数的 HTTP(S) API 地址。').transform(value => value.replace(/\/+$/, '')),
  authType: z.enum(['auth-token', 'api-key']),
  model: z.string().trim().max(160).regex(/^[^\s\x00-\x1f]*$/).optional().transform(value => value || undefined),
  disableNonessentialTraffic: z.boolean(),
};
const inputSchema = z.object({
  ...providerFields, id: z.string().uuid().optional(),
  token: z.string().trim().min(1).max(8192).regex(/^[^\s\x00-\x1f\x7f]+$/).optional(),
});
const savedSchema = z.array(z.object({
  ...providerFields, id: z.string().uuid(), revision: z.number().int().positive(), encryptedToken: z.string().min(1),
}));
type SavedProvider = z.infer<typeof savedSchema>[number];

export class ProviderStore {
  private providers: SavedProvider[] = [];
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private dataDir: string, private encryption?: SecretEncryption) {}
  async load() {
    try { this.providers = savedSchema.parse(JSON.parse(await readFile(join(this.dataDir, 'providers.json'), 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('提供商配置无法读取，原文件已保留。');
    }
  }
  list(): ApiProvider[] { return this.providers.map(({ encryptedToken: _, ...provider }) => ({ ...provider })); }
  private secretStore() {
    if (!this.encryption?.available()) throw new Error('系统密钥加密服务不可用，无法保存或读取 API 密钥。');
    return this.encryption;
  }
  private transaction<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.catch(() => {}).then(operation);
    this.writes = result;
    return result;
  }
  private async persist(providers: SavedProvider[]) {
    await mkdir(this.dataDir, { recursive: true });
    const target = join(this.dataDir, 'providers.json');
    const temporary = target + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(providers, null, 2), { mode: 0o600 });
    await rename(temporary, target);
    this.providers = providers;
  }
  save(input: ProviderInput): Promise<ApiProvider> {
    return this.transaction(async () => {
      const parsed = inputSchema.safeParse(input);
      // Never put the input or a validation error containing a credential into an IPC error.
      if (!parsed.success) throw new Error('请检查提供商名称、API 地址、密钥和模型名称。');
      const { token, ...values } = parsed.data;
      const existing = values.id ? this.providers.find(item => item.id === values.id) : undefined;
      if (values.id && !existing) throw new Error('提供商不存在。');
      if (!existing && !token) throw new Error('请输入 API 密钥。');
      const encryption = this.secretStore();
      const saved: SavedProvider = {
        ...values, id: existing?.id ?? randomUUID(), revision: (existing?.revision ?? 0) + 1,
        encryptedToken: token ? encryption.encrypt(token).toString('base64') : existing!.encryptedToken,
      };
      await this.persist(existing ? this.providers.map(item => item.id === saved.id ? saved : item) : [...this.providers, saved]);
      return this.list().find(item => item.id === saved.id)!;
    });
  }
  remove(id: string) {
    return this.transaction(async () => {
      if (!this.providers.some(item => item.id === id)) throw new Error('提供商不存在。');
      await this.persist(this.providers.filter(item => item.id !== id));
    });
  }
  configuration(id?: string) {
    if (!id) return { fingerprint: 'official', env: {} as Record<string, string> };
    const provider = this.providers.find(item => item.id === id);
    if (!provider) throw new Error('提供商不存在，请重新选择。');
    let token: string;
    try { token = this.secretStore().decrypt(Buffer.from(provider.encryptedToken, 'base64')); }
    catch { throw new Error('API 密钥无法解密，请编辑提供商并重新输入密钥。'); }
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: provider.baseUrl,
      [provider.authType === 'auth-token' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY']: token,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: provider.disableNonessentialTraffic ? '1' : '0',
    };
    if (provider.model) env.ANTHROPIC_MODEL = provider.model;
    return { fingerprint: provider.id + ':' + provider.revision, env };
  }
}
