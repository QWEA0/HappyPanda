import type { Terminal } from '@xterm/xterm';

/** Kinetic-scroll constants: the fling keeps ~37% of its speed every TIME_CONSTANT ms (as on iOS/Android). */
const TIME_CONSTANT = 325;
const MIN_FLING_SPEED = 0.25;
const STOP_SPEED = 0.02;
const DRAG_THRESHOLD = 6;
const SAMPLE_WINDOW = 100;

export interface TouchScrollTarget {
  /** Lines in the scrollback/screen to move; positive scrolls toward newer output. Returns how many lines moved. */
  scrollLines(lines: number): number;
  /** Pixel height of one terminal row on screen. */
  lineHeight(): number;
  /** The element that overflows when the terminal is larger than the phone (observer without fit). */
  viewport?: HTMLElement;
  /** False when a fling should not continue the drag (each step would send input). */
  kinetic?(): boolean;
}

/**
 * xterm 6 has no touch scrolling. Like Termux, a vertical drag scrolls the scrollback by rows and a fling
 * continues with exponential decay; horizontal drags stay native so a wide observer view can still pan.
 */
export function attachTouchScroll(element: HTMLElement, target: TouchScrollTarget): () => void {
  let touchId: number | undefined;
  let startX = 0, startY = 0, lastY = 0;
  let dragging = false;
  let remainder = 0;
  let samples: { time: number; y: number }[] = [];
  let frame = 0;

  const stopFling = () => { if (frame) window.cancelAnimationFrame(frame); frame = 0; };

  /** Moves by `pixels` (positive toward newer output); returns false when nothing could move. */
  const scrollBy = (pixels: number): boolean => {
    let rest = pixels;
    const viewport = target.viewport;
    // Nested scrolling: the overflowing viewport holds the live screen below the scrollback.
    if (viewport && viewport.scrollHeight > viewport.clientHeight && rest < 0) {
      const before = viewport.scrollTop;
      viewport.scrollTop = Math.max(0, before + rest);
      rest += before - viewport.scrollTop;
    }
    const height = target.lineHeight();
    let moved = rest !== pixels;
    if (height > 0 && rest !== 0) {
      remainder += rest;
      const lines = Math.trunc(remainder / height);
      if (lines) {
        const done = target.scrollLines(lines);
        remainder -= lines * height;
        if (done) moved = true;
        if (done !== lines) { rest = (lines - done) * height; remainder = 0; } else rest = 0;
      } else { moved = true; rest = 0; }
    }
    if (viewport && viewport.scrollHeight > viewport.clientHeight && rest > 0) {
      const before = viewport.scrollTop;
      viewport.scrollTop = before + rest;
      if (viewport.scrollTop !== before) moved = true;
    }
    return moved;
  };

  const fling = (velocity: number) => {
    let last = performance.now();
    const step = (now: number) => {
      const elapsed = Math.min(64, now - last);
      last = now;
      velocity *= Math.exp(-elapsed / TIME_CONSTANT);
      if (Math.abs(velocity) < STOP_SPEED || !scrollBy(velocity * elapsed)) { frame = 0; remainder = 0; return; }
      frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
  };

  const touch = (event: TouchEvent) => [...event.changedTouches].find(item => item.identifier === touchId);

  const onStart = (event: TouchEvent) => {
    stopFling();
    if (event.touches.length !== 1) { touchId = undefined; dragging = false; return; }
    const point = event.touches[0];
    touchId = point.identifier;
    startX = point.clientX; startY = lastY = point.clientY;
    dragging = false; remainder = 0;
    samples = [{ time: event.timeStamp, y: point.clientY }];
  };

  const onMove = (event: TouchEvent) => {
    const point = touch(event);
    if (!point) return;
    if (!dragging) {
      const dx = point.clientX - startX, dy = point.clientY - startY;
      if (Math.abs(dy) < DRAG_THRESHOLD || Math.abs(dy) < Math.abs(dx)) {
        if (Math.abs(dx) >= DRAG_THRESHOLD) touchId = undefined;
        return;
      }
      dragging = true;
      lastY = startY;
    }
    event.preventDefault();
    scrollBy(lastY - point.clientY);
    lastY = point.clientY;
    samples.push({ time: event.timeStamp, y: point.clientY });
    while (samples.length > 2 && event.timeStamp - samples[0].time > SAMPLE_WINDOW) samples.shift();
  };

  const onEnd = (event: TouchEvent) => {
    const point = touch(event);
    if (!point) return;
    touchId = undefined;
    if (!dragging) return;
    dragging = false;
    event.preventDefault();
    const first = samples[0], elapsed = event.timeStamp - first.time;
    // A finger that paused before lifting should not fling.
    const idle = event.timeStamp - samples[samples.length - 1].time;
    if (elapsed <= 0 || idle > 50) return;
    const velocity = (first.y - point.clientY) / elapsed;
    if (Math.abs(velocity) >= MIN_FLING_SPEED && target.kinetic?.() !== false) fling(velocity);
  };

  const onCancel = () => { touchId = undefined; dragging = false; };

  element.addEventListener('touchstart', onStart, { passive: true });
  element.addEventListener('touchmove', onMove, { passive: false });
  element.addEventListener('touchend', onEnd, { passive: false });
  element.addEventListener('touchcancel', onCancel, { passive: true });
  return () => {
    stopFling();
    element.removeEventListener('touchstart', onStart);
    element.removeEventListener('touchmove', onMove);
    element.removeEventListener('touchend', onEnd);
    element.removeEventListener('touchcancel', onCancel);
  };
}

/**
 * Scrollback scrolling for one xterm. The alternate screen has no scrollback, so (like xterm's own wheel
 * handling and Termux) a drag there sends arrow keys when this view may type and the app is not tracking the mouse.
 */
export function terminalScrollTarget(terminal: Terminal, options: { viewport?: HTMLElement; scale: () => number; canType: () => boolean }): TouchScrollTarget {
  return {
    viewport: options.viewport,
    kinetic: () => terminal.buffer.active.type === 'normal',
    lineHeight: () => {
      const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
      return screen && terminal.rows ? screen.offsetHeight / terminal.rows * options.scale() : 0;
    },
    scrollLines: lines => {
      const buffer = terminal.buffer.active;
      if (buffer.type === 'alternate') {
        if (!options.canType() || terminal.modes.mouseTrackingMode !== 'none') return 0;
        const count = Math.min(Math.abs(lines), 10);
        const key = terminal.modes.applicationCursorKeysMode ? (lines > 0 ? '\x1bOB' : '\x1bOA') : (lines > 0 ? '\x1b[B' : '\x1b[A');
        terminal.input(key.repeat(count), true);
        return Math.sign(lines) * count;
      }
      const before = buffer.viewportY;
      terminal.scrollLines(lines);
      return terminal.buffer.active.viewportY - before;
    },
  };
}
