import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeRemoteViewport } from '../src/renderer/src/remote-viewport';

function setup(withVisualViewport = true) {
  const viewport = Object.assign(new EventTarget(), { width: 390, height: 800, offsetTop: 0, offsetLeft: 0 });
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const browser = Object.assign(new EventTarget(), {
    innerWidth: 390, innerHeight: 800, visualViewport: withVisualViewport ? viewport : null,
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; }),
    cancelAnimationFrame: vi.fn((id: number) => frames.delete(id)),
  });
  vi.stubGlobal('window', browser);
  const properties = new Map<string, string>();
  const element = { style: { setProperty: (key: string, value: string) => { properties.set(key, value); } } } as unknown as HTMLElement;
  const stop = observeRemoteViewport(element);
  const flush = () => { for (const [id, callback] of frames) { frames.delete(id); callback(0); } };
  return { browser, viewport, frames, properties, stop, flush };
}

afterEach(() => vi.unstubAllGlobals());

describe('remote visual viewport', () => {
  it('follows keyboard resize and browser panning even when the layout viewport stays unchanged', () => {
    const { viewport, browser, properties, flush, stop } = setup();
    viewport.height = 310;
    viewport.offsetTop = 120;
    viewport.offsetLeft = 8;
    viewport.width = 374;
    viewport.dispatchEvent(new Event('resize'));
    viewport.dispatchEvent(new Event('scroll'));
    expect(browser.requestAnimationFrame).toHaveBeenCalledTimes(1);
    flush();
    expect(properties.get('--remote-viewport-height')).toBe('310px');
    expect(properties.get('--remote-viewport-top')).toBe('120px');
    expect(properties.get('--remote-viewport-left')).toBe('8px');
    expect(properties.get('--remote-viewport-width')).toBe('374px');
    expect(browser.innerHeight).toBe(800);
    stop();
  });

  it('restores the full viewport and clears pan offsets on rotation', () => {
    const { viewport, browser, properties, flush, stop } = setup();
    Object.assign(viewport, { height: 390, width: 800, offsetTop: 0, offsetLeft: 0 });
    browser.dispatchEvent(new Event('orientationchange'));
    flush();
    expect(properties.get('--remote-viewport-height')).toBe('390px');
    expect(properties.get('--remote-viewport-width')).toBe('800px');
    expect(properties.get('--remote-viewport-top')).toBe('0px');
    stop();
  });

  it('supports browsers without the visual viewport API', () => {
    const { browser, properties, flush, stop } = setup(false);
    browser.innerHeight = 320;
    browser.dispatchEvent(new Event('resize'));
    flush();
    expect(properties.get('--remote-viewport-height')).toBe('320px');
    expect(properties.get('--remote-viewport-left')).toBe('0px');
    stop();
  });

  it('cancels pending updates and removes listeners on unmount', () => {
    const { viewport, browser, properties, frames, flush, stop } = setup();
    viewport.height = 200;
    viewport.dispatchEvent(new Event('resize'));
    expect(frames.size).toBe(1);
    stop();
    expect(frames.size).toBe(0);
    viewport.dispatchEvent(new Event('scroll'));
    browser.dispatchEvent(new Event('resize'));
    browser.dispatchEvent(new Event('orientationchange'));
    flush();
    expect(frames.size).toBe(0);
    expect(properties.get('--remote-viewport-height')).toBe('800px');
  });
});
