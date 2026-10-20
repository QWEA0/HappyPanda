import { describe, expect, it, vi } from 'vitest';
import { parseQuickCommands, terminalDisplayScale, toggleRemoteFullscreen } from '../src/renderer/src/remote-terminal-tools';

describe('complete terminal screen fitting', () => {
  it('keeps every edge visible across portrait, landscape, keyboard and large PC terminals', () => {
    for (const viewport of [{ width: 314, height: 600 }, { width: 838, height: 350 }, { width: 384, height: 150 }]) {
      for (const screen of [{ width: 840, height: 538 }, { width: 1800, height: 1200 }, { width: 300, height: 100 }]) {
        const scale = terminalDisplayScale(viewport, screen);
        expect(screen.width * scale).toBeLessThanOrEqual(viewport.width + 0.001);
        expect(screen.height * scale).toBeLessThanOrEqual(viewport.height + 0.001);
        expect(scale).toBeGreaterThan(0);
        expect(scale).toBeLessThanOrEqual(1);
      }
    }
  });

  it('does not propagate invalid dimensions during hidden or unmounted layout', () => {
    expect(terminalDisplayScale({ width: 0, height: 100 }, { width: 800, height: 500 })).toBe(1);
    expect(terminalDisplayScale({ width: 320, height: 100 }, { width: NaN, height: 500 })).toBe(1);
  });
});

describe('browser fullscreen', () => {
  it('requests actual browser fullscreen with the navigation UI hidden', async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    const target = { fullscreenElement: null, fullscreenEnabled: true, documentElement: { requestFullscreen } } as unknown as Document;
    await toggleRemoteFullscreen(target);
    expect(requestFullscreen).toHaveBeenCalledWith({ navigationUI: 'hide' });
  });

  it('exits the native fullscreen element', async () => {
    const exitFullscreen = vi.fn().mockResolvedValue(undefined);
    await toggleRemoteFullscreen({ fullscreenElement: {}, exitFullscreen } as unknown as Document);
    expect(exitFullscreen).toHaveBeenCalledOnce();
  });

  it('reports unsupported and denied fullscreen without claiming success', async () => {
    await expect(toggleRemoteFullscreen({ fullscreenEnabled: false, documentElement: {} } as unknown as Document)).rejects.toThrow('不支持全屏');
    const error = new Error('Fullscreen denied');
    const target = { fullscreenEnabled: true, documentElement: { requestFullscreen: vi.fn().mockRejectedValue(error) } } as unknown as Document;
    await expect(toggleRemoteFullscreen(target)).rejects.toThrow('未允许进入全屏');
  });
});

describe('saved quick commands', () => {
  it('restores valid custom commands without converting them to terminal input', () => {
    const saved = [{ id: 'status', label: '项目状态', command: 'git status --short' }];
    expect(parseQuickCommands(JSON.stringify(saved))).toEqual(saved);
  });

  it('rejects corrupt storage, invalid entries and duplicate identities', () => {
    expect(parseQuickCommands('{bad')).toEqual([]);
    expect(parseQuickCommands('{"command":"pwd"}')).toEqual([]);
    expect(parseQuickCommands(JSON.stringify([
      null, { id: 'bad', label: 'bad', command: {} }, { id: 'empty', label: ' ', command: 'pwd' },
      { id: 'one', label: 'first', command: 'pwd' }, { id: 'one', label: 'duplicate', command: 'ls' },
    ]))).toEqual([{ id: 'one', label: 'first', command: 'pwd' }]);
  });

  it('bounds the saved list and command length', () => {
    const items = Array.from({ length: 30 }, (_, index) => ({ id: String(index), label: 'test', command: 'pwd' }));
    expect(parseQuickCommands(JSON.stringify(items))).toHaveLength(24);
    expect(parseQuickCommands(JSON.stringify([{ id: 'long', label: 'test', command: 'x'.repeat(4097) }]))).toEqual([]);
  });
});
