import { describe, expect, it, vi } from 'vitest';
import { checkLoginWebsite } from '../src/main/login-network';

const asset = 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/index-synthetic.js';
const html = `<html><script type="module" crossorigin src="${asset}"></script></html>`;
describe('login website diagnostics', () => {
  it('checks the public authorization page and its actual entry script without an OAuth query', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(html)).mockResolvedValueOnce(new Response('export const loaded=true;'));
    const result = await checkLoginWebsite(fetch, new AbortController().signal);
    expect(result.phase).toBe('reachable');
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['https://claude.com/cai/oauth/authorize', asset]);
    expect(result.message).toContain('仍需');
  });
  it('does not treat an HTML shell, verification response or blocked script as a working page', async () => {
    for (const [page, script] of [
      [new Response('verify', { status: 403 }), undefined],
      [new Response('<html>please verify</html>'), undefined],
      [new Response(html), new Response('blocked', { status: 403 })],
      [new Response(html), new Response('<html>challenge</html>')],
    ] as const) {
      const fetch = vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce(script);
      expect((await checkLoginWebsite(fetch, new AbortController().signal)).phase).toBe('failed');
    }
  });
  it('reports connection failures without echoing errors or fetching arbitrary HTML links', async () => {
    const failed = await checkLoginWebsite(vi.fn().mockRejectedValue(new Error('private-error')), new AbortController().signal);
    expect(failed.message).not.toContain('private-error');
    expect(failed.message).toContain('claude.com');
    const fetch = vi.fn().mockResolvedValue(new Response('<script src="https://evil.example/steal.js"></script>'));
    expect((await checkLoginWebsite(fetch, new AbortController().signal)).phase).toBe('failed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('distinguishes an explicit website challenge from a proxy or transport failure',async()=>{
    const result=await checkLoginWebsite(vi.fn().mockResolvedValue(new Response('verify',{status:403,headers:{'cf-mitigated':'challenge'}})),new AbortController().signal);
    expect(result.message).toContain('要求浏览器验证');
    expect(result.message).not.toContain('代理');
  });
});
