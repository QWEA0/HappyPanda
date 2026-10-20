// Normalize pasted text without letting embedded controls escape a paste bracket.
export function terminalPaste(text: string, bracketed: boolean): string {
  const normalized = text.replace(/\r?\n/g, '\r').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return bracketed ? '\x1b[200~' + normalized + '\x1b[201~' : normalized;
}

/**
 * PTY resizes are recorded in the output stream itself (like asciinema's resize events). Views that do not
 * decide the size apply the mark while parsing, so output is always rendered at the size it was produced
 * for — live, and when scrollback is replayed after a reconnect. xterm ignores unregistered OSC numbers.
 */
export const TERMINAL_SIZE_OSC = 7337;
const SIZE_MARK_PREFIX = `\x1b]${TERMINAL_SIZE_OSC};`;
const SIZE_MARKS = new RegExp(`\\x1b\\]${TERMINAL_SIZE_OSC};\\d{1,3};\\d{1,3}\\x07`, 'g');

export const terminalSizeMark = (cols: number, rows: number) => `${SIZE_MARK_PREFIX}${cols};${rows}\x07`;

/** Parses the OSC payload after `7337;`. */
export function parseTerminalSize(payload: string): { cols: number; rows: number } | undefined {
  const match = /^(\d{1,3});(\d{1,3})$/.exec(payload);
  if (!match) return undefined;
  const cols = Number(match[1]), rows = Number(match[2]);
  return cols >= 10 && cols <= 500 && rows >= 3 && rows <= 300 ? { cols, rows } : undefined;
}

export function lastTerminalSizeMark(data: string): string | undefined {
  if (!data.includes(SIZE_MARK_PREFIX)) return undefined;
  let last: string | undefined;
  for (const match of data.matchAll(SIZE_MARKS)) last = match[0];
  return last;
}

/** True when the data contains anything besides size marks. */
export const terminalHasOutput = (data: string) => Boolean(data) && (!data.includes(SIZE_MARK_PREFIX) || data.replace(SIZE_MARKS, '').length > 0);

/** Keeps the last `limit` characters, prefixed with the size mark in effect where the kept output starts. */
export function trimTerminalOutput(data: string, limit: number): string {
  if (data.length <= limit) return data;
  let cut = data.length - limit;
  // Never split a mark: move the cut past one that straddles it.
  const straddling = data.lastIndexOf(SIZE_MARK_PREFIX, cut - 1);
  if (straddling >= 0 && cut - straddling < 16) {
    const end = data.indexOf('\x07', straddling);
    if (end >= cut) cut = end + 1;
  }
  return (lastTerminalSizeMark(data.slice(0, cut)) ?? '') + data.slice(cut);
}

/**
 * Appends streamed output to a mirrored scrollback. Trimming only after 128 KiB of slack keeps each chunk
 * O(chunk) instead of copying the whole 512 KB tail every time.
 */
export function appendTerminalOutput(buffer: string, data: string, limit = 512000): string {
  const next = buffer + data;
  return next.length > limit + 131072 ? trimTerminalOutput(next, limit) : next;
}