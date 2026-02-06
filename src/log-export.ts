import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';

const LOGS_DIR = join(homedir(), '.pigs', 'logs');

/**
 * Build a filename-safe timestamp string: YYYYMMDD-HHmmss
 */
export function buildTimestamp(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

/**
 * Build the log file path for a VM export.
 */
export function buildLogPath(vmLabel: string, date: Date): string {
  const safeName = vmLabel.replace(/[^a-zA-Z0-9._:-]/g, '_');
  const ts = buildTimestamp(date);
  return join(LOGS_DIR, `${safeName}-${ts}.log`);
}

/**
 * Export output lines to a log file. Creates the logs directory if needed.
 * Returns the path of the written file.
 */
export async function exportLog(vmLabel: string, lines: string[]): Promise<string> {
  await mkdir(LOGS_DIR, { recursive: true });
  const logPath = buildLogPath(vmLabel, new Date());
  await writeFile(logPath, lines.join('\n') + '\n', 'utf-8');
  return logPath;
}

export { LOGS_DIR };
