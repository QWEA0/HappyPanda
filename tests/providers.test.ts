import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ProviderStore, type SecretEncryption } from '../src/main/providers';
import { InventoryStore } from '../src/main/store';

const key = randomBytes(32);
export const testEncryption: SecretEncryption = {
  available: () => true,
  encrypt(value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
  },
  decrypt(bytes) {
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
  },
};
const input = { name: 'Primary', baseUrl: 'https://gateway.example.com/', authType: 'auth-token' as const, token: 'synthetic-token-$-quote', disableNonessentialTraffic: true };

describe('provider credentials and inventory', () => {
  it('persists multiple encrypted keys and returns only public metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hp-providers-'));
    const store = new ProviderStore(directory, testEncryption); await store.load();
    const primary = await store.save(input);
    const fallback = await store.save({ ...input, name: 'Fallback', authType: 'api-key', token: 'another-synthetic-token', model: 'gateway-sonnet' });
    expect(JSON.stringify(store.list())).not.toContain(input.token);
    expect(JSON.stringify(primary)).not.toContain('encryptedToken');
    const disk = await readFile(join(directory, 'providers.json'), 'utf8');
    expect(disk).not.toContain(input.token); expect(disk).not.toContain('another-synthetic-token');
    const loaded = new ProviderStore(directory, testEncryption); await loaded.load();
    expect(loaded.list()).toHaveLength(2);
    expect(loaded.configuration(primary.id).env).toEqual({ ANTHROPIC_BASE_URL: 'https://gateway.example.com', ANTHROPIC_AUTH_TOKEN: input.token, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
    expect(loaded.configuration(fallback.id).env.ANTHROPIC_API_KEY).toBe('another-synthetic-token');
    expect(loaded.configuration(fallback.id).env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(loaded.configuration(fallback.id).env.ANTHROPIC_MODEL).toBe('gateway-sonnet');
    const updated = await loaded.save({ ...primary, name: 'Renamed', token: undefined });
    expect(loaded.configuration(primary.id).env.ANTHROPIC_AUTH_TOKEN).toBe(input.token);
    expect(updated.revision).toBe(2);
    await loaded.save({ ...updated, token: 'replacement-synthetic-token' });
    expect(loaded.configuration(primary.id).env.ANTHROPIC_AUTH_TOKEN).toBe('replacement-synthetic-token');
    await loaded.remove(fallback.id);
    expect(loaded.list()).toHaveLength(1);
    expect(loaded.configuration().env).toEqual({});
  });
  it('rejects invalid settings without including credentials in errors and refuses plaintext storage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hp-providers-'));
    const store = new ProviderStore(directory, testEncryption); await store.load();
    for (const baseUrl of ['file:///tmp/config', 'https://user:secret@example.com', 'https://example.com?token=secret', 'https://example.com/#secret']) {
      await expect(store.save({ ...input, baseUrl })).rejects.toThrow('请检查');
    }
    await expect(store.save({ ...input, token: 'synthetic\nsecret' })).rejects.not.toThrow('synthetic');
    const unavailable = new ProviderStore(directory, { ...testEncryption, available: () => false });
    await expect(unavailable.save(input)).rejects.toThrow('系统密钥加密服务不可用');
    await expect(readFile(join(directory, 'providers.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('serializes updates and persists per-node provider choice with legacy inventory support', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hp-providers-'));
    const providers = new ProviderStore(directory, testEncryption); await providers.load();
    await Promise.all([providers.save(input), providers.save({ ...input, name: 'Second' })]);
    expect(providers.list()).toHaveLength(2);
    const inventory = new InventoryStore(directory); await inventory.load();
    await inventory.saveNode({name:'Test server',sshTarget:'test-host'});
    expect(inventory.nodes[0].providerId).toBeUndefined();
    inventory.nodes[0].providerId = providers.list()[0].id;
    await inventory.save();
    const loaded = new InventoryStore(directory); await loaded.load();
    expect(loaded.nodes[0].providerId).toBe(providers.list()[0].id);
  });
});
