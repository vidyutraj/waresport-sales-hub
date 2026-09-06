/**
 * CSV generation with spreadsheet formula-injection protection.
 *
 * A cell that begins with `=`, `+`, `-`, `@`, a tab or a carriage return is
 * executed as a formula by Excel / Sheets / LibreOffice. Exported lead notes
 * are attacker-influenced data, so every such cell is prefixed with a single
 * quote before quoting.
 */

const RISKY_LEADING = /^[=+\-@\t\r]/;
// Strip C0/C1 control characters except tab, newline and carriage return.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : String(value);
  s = s.replace(CONTROL_CHARS, '');
  if (RISKY_LEADING.test(s)) s = `'${s}`;
  if (/["\n\r,]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [headers.map(escapeCsvCell).join(',')];
  for (const row of rows) lines.push(row.map(escapeCsvCell).join(','));
  // A UTF-8 BOM keeps Excel from mangling non-ASCII club names.
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function csvFilename(base: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = base.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'export';
  return `${safe}-${stamp}.csv`;
}
