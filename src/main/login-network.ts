export interface LoginNetworkCheck {
  phase: 'checking' | 'reachable' | 'failed';
  message: string;
  checkedAt?: string;
}

export type LoginPageFetcher = (url: string, signal: AbortSignal) => Promise<Response>;

async function boundedText(response: Response) {
  if (!response.body) throw new Error('empty');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error('too-large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

/** Public connectivity probe only. Never sends a user's OAuth URL or browser cookies. */
export async function checkLoginWebsite(fetchPage: LoginPageFetcher, signal: AbortSignal): Promise<LoginNetworkCheck> {
  let host = 'claude.com';
  const checked = (phase: 'reachable' | 'failed', message: string): LoginNetworkCheck => ({ phase, message, checkedAt: new Date().toISOString() });
  try {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
    const page = await fetchPage('https://claude.com/cai/oauth/authorize', timeout);
    if(page.url)host=new URL(page.url).hostname;
    if (!page.ok) {
      await page.body?.cancel();
      return checked('failed',page.headers.get('cf-mitigated')==='challenge' ? `${host} 要求浏览器验证。请在登录窗口完成验证；若持续空白，请重新登录。` : `${host} 对连接检查返回 HTTP ${page.status}。请查看浏览器中的验证或错误提示。`);
    }
    const html = await boundedText(page);
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map(match => match[1]);
    const asset = scripts.find(url => /^https:\/\/assets-proxy\.anthropic\.com\/[^?#]+\.js$/.test(url));
    if (!asset) return checked('failed', '授权站点已响应，但未收到预期页面脚本；请查看浏览器是否需要完成验证。');
    host = 'assets-proxy.anthropic.com';
    const script = await fetchPage(asset, timeout);
    if (!script.ok) { await script.body?.cancel(); return checked('failed', `登录入口脚本访问失败：${host} 返回 HTTP ${script.status}。`); }
    const body = await boundedText(script);
    if (body.trimStart().startsWith('<') || !body.trim()) return checked('failed', '脚本服务器返回了验证页或空响应，请查看浏览器中的提示。');
    return checked('reachable', '授权站点和入口脚本可访问。仍需在浏览器中完成登录。');
  } catch {
    if (signal.aborted) throw new Error('cancelled');
    return checked('failed', `连接 ${host} 失败或超过 20 秒，请重新登录后再试。`);
  }
}
