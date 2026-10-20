// Normalize pasted text without letting embedded controls escape a paste bracket.
export function terminalPaste(text: string, bracketed: boolean): string {
  const normalized = text.replace(/\r?\n/g, '\r').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return bracketed ? '\x1b[200~' + normalized + '\x1b[201~' : normalized;
}
