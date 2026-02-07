import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { provisionVM, reprovisionVM, loadSettings } from '../provisioner.ts';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

const mockedReadFile = vi.mocked(readFile);
const mockedMkdir = vi.mocked(mkdir);
const mockedWriteFile = vi.mocked(writeFile);

function createMockSprite() {
  const mock = {
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    execFile: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
  };
  return mock;
}

function createMockClient(mockSprite?: ReturnType<typeof createMockSprite>) {
  const sprite = mockSprite ?? createMockSprite();
  return {
    sprite: vi.fn().mockReturnValue(sprite),
    _mockSprite: sprite,
  } as any;
}

describe('loadSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return parsed settings when file exists', async () => {
    const settings = { claudeMd: '# Custom instructions' };
    mockedReadFile.mockResolvedValue(JSON.stringify(settings));

    const result = await loadSettings();

    expect(result).toEqual(settings);
    expect(mockedReadFile).toHaveBeenCalledWith(
      join(homedir(), '.pigs', 'settings.json'),
      'utf-8',
    );
  });

  it('should create default settings when file is missing', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));

    const result = await loadSettings();

    expect(result.claudeMd).toContain('Agent Instructions');
    expect(mockedMkdir).toHaveBeenCalledWith(
      join(homedir(), '.pigs'),
      { recursive: true },
    );
    expect(mockedWriteFile).toHaveBeenCalledWith(
      join(homedir(), '.pigs', 'settings.json'),
      expect.any(String),
      'utf-8',
    );
  });

  it('should write valid JSON for default settings', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));

    await loadSettings();

    const writtenJson = mockedWriteFile.mock.calls[0][1] as string;
    const parsed = JSON.parse(writtenJson);
    expect(parsed).toHaveProperty('claudeMd');
    expect(typeof parsed.claudeMd).toBe('string');
  });

  it('should include openInVscode: true in default settings', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));

    const result = await loadSettings();

    expect(result.openInVscode).toBe(true);
    const writtenJson = mockedWriteFile.mock.calls[0][1] as string;
    const parsed = JSON.parse(writtenJson);
    expect(parsed.openInVscode).toBe(true);
  });
});

describe('provisionVM', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call shellExec for provisioning script', async () => {
    const mockSprite = createMockSprite();
    const client = createMockClient(mockSprite);

    await provisionVM(client, 'pigs-abc123', { claudeMd: '# Test' });

    expect(client.sprite).toHaveBeenCalledWith('pigs-abc123');
    // Three shellExec calls: provision script, CLAUDE.md, notification hook
    expect(mockSprite.execFile).toHaveBeenCalledTimes(3);
    // shellExec calls execFile('bash', ['-c', script])
    expect(mockSprite.execFile.mock.calls[0][0]).toBe('bash');
    const firstScript = mockSprite.execFile.mock.calls[0][1][1] as string;
    expect(firstScript).toContain('claude');
    expect(firstScript).toContain('sshd');
  });

  it('should write CLAUDE.md via base64-encoded shellExec', async () => {
    const mockSprite = createMockSprite();
    const client = createMockClient(mockSprite);
    const claudeMd = '# My Instructions\nDo stuff.';

    await provisionVM(client, 'pigs-test', { claudeMd });

    // Second shellExec: write CLAUDE.md — script is in args[1][1]
    const secondScript = mockSprite.execFile.mock.calls[1][1][1] as string;
    expect(secondScript).toContain('base64');
    expect(secondScript).toContain('/root/CLAUDE.md');

    // Verify the base64 content decodes correctly
    const b64Match = secondScript.match(/echo '([^']+)'/);
    expect(b64Match).not.toBeNull();
    const decoded = Buffer.from(b64Match![1], 'base64').toString();
    expect(decoded).toBe(claudeMd);
  });

  it('should call onLog callback with progress messages', async () => {
    const mockSprite = createMockSprite();
    const client = createMockClient(mockSprite);

    const logs: string[] = [];
    await provisionVM(client, 'pigs-abc', { claudeMd: '# Test' }, (msg) => logs.push(msg));

    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs.some((m) => m.includes('Claude Code'))).toBe(true);
    expect(logs.some((m) => m.includes('CLAUDE.md'))).toBe(true);
  });

  it('should propagate exec errors', async () => {
    const mockSprite = createMockSprite();
    mockSprite.execFile.mockRejectedValueOnce(new Error('exec failed'));
    const client = createMockClient(mockSprite);

    await expect(provisionVM(client, 'pigs-fail')).rejects.toThrow('exec failed');
  });

  it('should work without onLog callback', async () => {
    const mockSprite = createMockSprite();
    const client = createMockClient(mockSprite);

    await expect(provisionVM(client, 'pigs-silent', { claudeMd: '# Test' })).resolves.toBeUndefined();
  });

  it('should fall back to loadSettings when no settings passed', async () => {
    const mockSprite = createMockSprite();
    const client = createMockClient(mockSprite);
    // loadSettings will fail (no file), triggering default creation
    mockedReadFile.mockRejectedValueOnce(new Error('ENOENT'));

    await provisionVM(client, 'pigs-new');

    // Should have created the settings file via loadSettings fallback
    expect(mockedMkdir).toHaveBeenCalled();
    expect(mockedWriteFile).toHaveBeenCalled();

    // Should still write CLAUDE.md with default content
    const secondScript = mockSprite.execFile.mock.calls[1][1][1] as string;
    const b64Match = secondScript.match(/echo '([^']+)'/);
    expect(b64Match).not.toBeNull();
    const decoded = Buffer.from(b64Match![1], 'base64').toString();
    expect(decoded).toContain('Agent Instructions');
  });

  it('should use provided settings instead of loading from disk', async () => {
    const mockSprite = createMockSprite();
    const client = createMockClient(mockSprite);
    const customSettings = { claudeMd: '# Custom from app state' };

    await provisionVM(client, 'pigs-custom', customSettings);

    // readFile should only be called for credentials sync, not for settings
    const settingsPath = join(homedir(), '.pigs', 'settings.json');
    const settingsCalls = mockedReadFile.mock.calls.filter(
      (call) => call[0] === settingsPath,
    );
    expect(settingsCalls).toHaveLength(0);

    // Should write the custom CLAUDE.md content
    const secondScript = mockSprite.execFile.mock.calls[1][1][1] as string;
    const b64Match = secondScript.match(/echo '([^']+)'/);
    expect(b64Match).not.toBeNull();
    const decoded = Buffer.from(b64Match![1], 'base64').toString();
    expect(decoded).toBe('# Custom from app state');
  });
});

describe('reprovisionVM', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should only run two exec calls (CLAUDE.md + hooks, no install)', async () => {
    const mockSprite = createMockSprite();
    const client = createMockClient(mockSprite);
    mockedReadFile.mockResolvedValue(JSON.stringify({ claudeMd: '# Updated' }));

    await reprovisionVM(client, 'pigs-reprov');

    expect(client.sprite).toHaveBeenCalledWith('pigs-reprov');
    // Three shellExec calls: CLAUDE.md, hooks, and credentials sync (no install step)
    expect(mockSprite.execFile).toHaveBeenCalledTimes(3);
  });

  it('should reload settings from disk', async () => {
    const mockSprite = createMockSprite();
    const client = createMockClient(mockSprite);
    mockedReadFile.mockResolvedValue(JSON.stringify({ claudeMd: '# Fresh from disk' }));

    await reprovisionVM(client, 'pigs-reprov');

    expect(mockedReadFile).toHaveBeenCalled();

    // Verify CLAUDE.md content matches reloaded settings
    const firstScript = mockSprite.execFile.mock.calls[0][1][1] as string;
    const b64Match = firstScript.match(/echo '([^']+)'/);
    expect(b64Match).not.toBeNull();
    const decoded = Buffer.from(b64Match![1], 'base64').toString();
    expect(decoded).toBe('# Fresh from disk');
  });

  it('should write updated hooks config', async () => {
    const mockSprite = createMockSprite();
    const client = createMockClient(mockSprite);
    mockedReadFile.mockResolvedValue(JSON.stringify({ claudeMd: '# Test' }));

    await reprovisionVM(client, 'pigs-reprov');

    const secondScript = mockSprite.execFile.mock.calls[1][1][1] as string;
    expect(secondScript).toContain('base64');
    expect(secondScript).toContain('.claude/settings.json');
  });

  it('should call onLog callback with progress messages', async () => {
    const mockSprite = createMockSprite();
    const client = createMockClient(mockSprite);
    mockedReadFile.mockResolvedValue(JSON.stringify({ claudeMd: '# Test' }));

    const logs: string[] = [];
    await reprovisionVM(client, 'pigs-reprov', (msg) => logs.push(msg));

    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs.some((m) => m.includes('CLAUDE.md'))).toBe(true);
    expect(logs.some((m) => m.includes('hook'))).toBe(true);
  });

  it('should propagate exec errors', async () => {
    const mockSprite = createMockSprite();
    mockSprite.execFile.mockRejectedValueOnce(new Error('exec failed'));
    const client = createMockClient(mockSprite);
    mockedReadFile.mockResolvedValue(JSON.stringify({ claudeMd: '# Test' }));

    await expect(reprovisionVM(client, 'pigs-fail')).rejects.toThrow('exec failed');
  });

  it('should work without onLog callback', async () => {
    const mockSprite = createMockSprite();
    const client = createMockClient(mockSprite);
    mockedReadFile.mockResolvedValue(JSON.stringify({ claudeMd: '# Test' }));

    await expect(reprovisionVM(client, 'pigs-silent')).resolves.toBeUndefined();
  });
});
