import { describe, expect, it } from 'vitest';
import { appendTerminalOutput, lastTerminalSizeMark, parseTerminalSize, terminalHasOutput, terminalSizeMark, trimTerminalOutput } from '../src/shared/terminal';

describe('in-band terminal size marks', () => {
  it('round-trips sizes and rejects payloads outside the PTY limits', () => {
    expect(terminalSizeMark(120, 40)).toBe('\x1b]7337;120;40\x07');
    expect(parseTerminalSize('120;40')).toEqual({ cols: 120, rows: 40 });
    for (const payload of ['9;40', '120;2', '501;40', '120;301', '120', '120;40;1', 'a;b']) expect(parseTerminalSize(payload)).toBeUndefined();
  });

  it('finds the last mark and ignores marks when deciding whether there is output', () => {
    expect(lastTerminalSizeMark('plain output')).toBeUndefined();
    expect(lastTerminalSizeMark(terminalSizeMark(80, 24) + 'x' + terminalSizeMark(45, 30))).toBe(terminalSizeMark(45, 30));
    expect(terminalHasOutput('')).toBe(false);
    expect(terminalHasOutput(terminalSizeMark(80, 24) + terminalSizeMark(45, 30))).toBe(false);
    expect(terminalHasOutput(terminalSizeMark(80, 24) + 'prompt')).toBe(true);
  });

  it('keeps the size in effect where trimmed scrollback starts', () => {
    const data = terminalSizeMark(160, 40) + 'a'.repeat(100) + terminalSizeMark(45, 30) + 'b'.repeat(100);
    expect(trimTerminalOutput(data, 50)).toBe(terminalSizeMark(45, 30) + 'b'.repeat(50));
    expect(trimTerminalOutput(data, data.length)).toBe(data);
  });

  it('never splits a mark when the cut lands inside it', () => {
    const mark = terminalSizeMark(45, 30);
    const data = 'a'.repeat(10) + mark + 'tail';
    const trimmed = trimTerminalOutput(data, 'tail'.length + 3);
    expect(trimmed).toBe(mark + 'tail');
  });

  it('trims mirrored scrollback only after the slack is exceeded', () => {
    const start = terminalSizeMark(80, 24) + 'x'.repeat(100);
    expect(appendTerminalOutput(start, 'y', 50)).toBe(start + 'y');
    const long = appendTerminalOutput(start, 'z'.repeat(131072), 50);
    expect(long).toBe(terminalSizeMark(80, 24) + 'z'.repeat(50));
  });
});
