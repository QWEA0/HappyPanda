import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialState } from '../src/renderer/src/api';
import { nodeAddress } from '../src/renderer/src/format';
import { TEST_NODE } from './fixtures/node';

afterEach(() => vi.unstubAllGlobals());

describe('node display without personal presets', () => {
  it('starts empty in desktop and browser previews', () => {
    for (const happyPanda of [undefined, {}]) {
      vi.stubGlobal('window', { happyPanda });
      const state = initialState();
      expect(state.nodes).toEqual([]);
      expect(state.workspaces).toEqual([]);
      expect(state.sessions).toEqual([]);
    }
  });
  it('shows an unresolved alias without inventing an IP or user', () => {
    expect(nodeAddress(TEST_NODE)).toBe('test-host:22');
  });
  it('uses explicit node overrides and SSH alias information', () => {
    const aliases = [{ name: TEST_NODE.sshTarget, hostname: 'server.example', user: 'alias-user', port: 2200 }];
    expect(nodeAddress(TEST_NODE, aliases)).toBe('alias-user@server.example:2200');
    expect(nodeAddress({ ...TEST_NODE, user: 'node-user', port: 2222 }, aliases)).toBe('node-user@server.example:2222');
    expect(nodeAddress({ ...TEST_NODE, sshTarget: 'ssh-user@server.example' })).toBe('ssh-user@server.example:22');
  });
});
