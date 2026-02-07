import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTimestamp, buildLogPath, exportLog, LOGS_DIR } from '../log-export.ts';

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

describe('buildTimestamp', () => {
  it('should format a date as YYYYMMDD-HHmmss', () => {
    const date = new Date(2025, 0, 15, 9, 5, 3); // Jan 15, 2025 09:05:03
    expect(buildTimestamp(date)).toBe('20250115-090503');
  });

  it('should zero-pad single-digit values', () => {
    const date = new Date(2025, 2, 1, 1, 2, 3); // Mar 1, 2025 01:02:03
    expect(buildTimestamp(date)).toBe('20250301-010203');
  });

  it('should handle end of day', () => {
    const date = new Date(2025, 11, 31, 23, 59, 59); // Dec 31, 2025 23:59:59
    expect(buildTimestamp(date)).toBe('20251231-235959');
  });
});

describe('buildLogPath', () => {
  it('should construct path with label and timestamp', () => {
    const date = new Date(2025, 0, 15, 9, 5, 3);
    const path = buildLogPath('my-vm', date);
    expect(path).toBe(`${LOGS_DIR}/my-vm-20250115-090503.log`);
  });

  it('should sanitize unsafe characters in label', () => {
    const date = new Date(2025, 0, 15, 9, 5, 3);
    const path = buildLogPath('repo/name with spaces', date);
    expect(path).toBe(`${LOGS_DIR}/repo_name_with_spaces-20250115-090503.log`);
  });

  it('should preserve colons and dots in label', () => {
    const date = new Date(2025, 0, 15, 9, 5, 3);
    const path = buildLogPath('myrepo:main', date);
    expect(path).toBe(`${LOGS_DIR}/myrepo:main-20250115-090503.log`);
  });

  it('should handle empty label', () => {
    const date = new Date(2025, 0, 15, 9, 5, 3);
    const path = buildLogPath('', date);
    expect(path).toBe(`${LOGS_DIR}/-20250115-090503.log`);
  });
});

describe('exportLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create logs directory and write file', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const lines = ['line1', 'line2', 'line3'];
    const path = await exportLog('test-vm', lines);

    expect(mkdir).toHaveBeenCalledWith(LOGS_DIR, { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('test-vm-'),
      'line1\nline2\nline3\n',
      'utf-8',
    );
    expect(path).toContain('test-vm-');
    expect(path).toMatch(/\.log$/);
  });

  it('should include trailing newline in output', async () => {
    const { writeFile } = await import('node:fs/promises');
    await exportLog('vm', ['single line']);
    expect(writeFile).toHaveBeenCalledWith(
      expect.any(String),
      'single line\n',
      'utf-8',
    );
  });

  it('should handle empty lines array', async () => {
    const { writeFile } = await import('node:fs/promises');
    await exportLog('vm', []);
    expect(writeFile).toHaveBeenCalledWith(
      expect.any(String),
      '\n',
      'utf-8',
    );
  });

  it('should propagate write errors', async () => {
    const { writeFile } = await import('node:fs/promises');
    (writeFile as any).mockRejectedValueOnce(new Error('disk full'));
    await expect(exportLog('vm', ['data'])).rejects.toThrow('disk full');
  });
});
