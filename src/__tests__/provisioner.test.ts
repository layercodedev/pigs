import { describe, it, expect, jest, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import { provisionVM, reprovisionVM, loadSettings } from '../provisioner.ts';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Mock node:fs/promises
mock.module('node:fs/promises', () => ({
	readFile: jest.fn(),
	mkdir: jest.fn().mockResolvedValue(undefined),
	writeFile: jest.fn().mockResolvedValue(undefined),
}));

// Mock node:child_process to prevent real keychain access in tests
mock.module('node:child_process', () => ({
	execFile: jest.fn((cmd: string, args: string[], cb: Function) => {
		cb(new Error('mock: no keychain'), '', '');
	}),
}));

const mockedReadFile = readFile as Mock<typeof readFile>;
const mockedMkdir = mkdir as Mock<typeof mkdir>;
const mockedWriteFile = writeFile as Mock<typeof writeFile>;

// Mock global fetch for Sprites FS API calls
const originalFetch = globalThis.fetch;
let mockFetch: Mock<typeof fetch>;

function createMockSprite() {
  const mock = {
    exec: jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    execFile: jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
  };
  return mock;
}

function createMockClient(mockSprite?: ReturnType<typeof createMockSprite>) {
  const sprite = mockSprite ?? createMockSprite();
  return {
    sprite: jest.fn().mockReturnValue(sprite),
    baseURL: 'https://api.sprites.dev',
    token: 'test-token',
    _mockSprite: sprite,
  } as any;
}

describe('loadSettings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
    jest.clearAllMocks();
    // Mock fetch: FS write returns 200, FS read returns 200 with content
    mockFetch = jest.fn().mockImplementation((url: string, opts?: any) => {
      return Promise.resolve(new Response('ok', { status: 200 }));
    });
    globalThis.fetch = mockFetch as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should call shellExec for install steps and fetch for file writes', async () => {
    const mockSprite = createMockSprite();
    const client = createMockClient(mockSprite);
    mockedReadFile.mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: 'test' } }));

    await provisionVM(client, 'pigs-abc123', { claudeMd: '# Test' });

    expect(client.sprite).toHaveBeenCalledWith('pigs-abc123');
    // Three shellExec calls: install claude, install ssh, start ssh
    expect(mockSprite.execFile).toHaveBeenCalledTimes(3);
    expect(mockSprite.execFile.mock.calls[0][1][1]).toContain('claude');
    expect(mockSprite.execFile.mock.calls[1][1][1]).toContain('openssh-server');
    expect(mockSprite.execFile.mock.calls[2][1][1]).toContain('sshd');
    // File writes go through fetch (FS API)
    expect(mockFetch).toHaveBeenCalled();
  });

  it('should write files via Sprites FS API', async () => {
    const mockSprite = createMockSprite();
    const client = createMockClient(mockSprite);
    const claudeMd = '# My Instructions\nDo stuff.';

    await provisionVM(client, 'pigs-test', { claudeMd });

    // Check that FS write was called for CLAUDE.md
    const writeCalls = mockFetch.mock.calls.filter(
      (call: any) => call[1]?.method === 'PUT',
    );
    const claudeMdWrite = writeCalls.find((call: any) =>
      String(call[0]).includes('CLAUDE.md'),
    );
    expect(claudeMdWrite).toBeDefined();
    expect(claudeMdWrite![1].body).toBe(claudeMd);
  });

  it('should call onLog callback with per-step progress messages', async () => {
    const mockSprite = createMockSprite();
    const client = createMockClient(mockSprite);

    const logs: string[] = [];
    await provisionVM(client, 'pigs-abc', { claudeMd: '# Test' }, (msg) => logs.push(msg));

    expect(logs.length).toBeGreaterThanOrEqual(4);
    expect(logs.some((m) => m.includes('Installing Claude Code'))).toBe(true);
    expect(logs.some((m) => m.includes('Installing SSH server'))).toBe(true);
    expect(logs.some((m) => m.includes('Starting SSH server'))).toBe(true);
    expect(logs.some((m) => m.includes('Writing config files'))).toBe(true);
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

    // Verify CLAUDE.md was written via FS API with default content
    const writeCalls = mockFetch.mock.calls.filter(
      (call: any) => call[1]?.method === 'PUT',
    );
    const claudeMdWrite = writeCalls.find((call: any) =>
      String(call[0]).includes('CLAUDE.md'),
    );
    expect(claudeMdWrite).toBeDefined();
    expect(claudeMdWrite![1].body).toContain('Agent Instructions');
  });

  it('should use provided settings instead of loading from disk', async () => {
    const mockSprite = createMockSprite();
    const client = createMockClient(mockSprite);
    const customSettings = { claudeMd: '# Custom from app state' };

    await provisionVM(client, 'pigs-custom', customSettings);

    // readFile should only be called for credentials/claude.json sync, not for settings
    const settingsPath = join(homedir(), '.pigs', 'settings.json');
    const settingsCalls = mockedReadFile.mock.calls.filter(
      (call) => call[0] === settingsPath,
    );
    expect(settingsCalls).toHaveLength(0);

    // Verify CLAUDE.md was written via FS API with custom content
    const writeCalls = mockFetch.mock.calls.filter(
      (call: any) => call[1]?.method === 'PUT',
    );
    const claudeMdWrite = writeCalls.find((call: any) =>
      String(call[0]).includes('CLAUDE.md'),
    );
    expect(claudeMdWrite).toBeDefined();
    expect(claudeMdWrite![1].body).toBe('# Custom from app state');
  });

  it('should verify files exist after writing by reading them back', async () => {
    const mockSprite = createMockSprite();
    const client = createMockClient(mockSprite);

    await provisionVM(client, 'pigs-verify', { claudeMd: '# Test' });

    // For each file written (PUT), there should be a read-back (GET)
    const putCalls = mockFetch.mock.calls.filter(
      (call: any) => call[1]?.method === 'PUT',
    );
    const getCalls = mockFetch.mock.calls.filter(
      (call: any) => !call[1]?.method || call[1]?.method === 'GET',
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(putCalls.length);
  });

  it('should log file paths with checkmarks on success', async () => {
    const mockSprite = createMockSprite();
    const client = createMockClient(mockSprite);

    const logs: string[] = [];
    await provisionVM(client, 'pigs-log', { claudeMd: '# Test' }, (msg) => logs.push(msg));

    expect(logs.some((m) => m.includes('/root/CLAUDE.md'))).toBe(true);
    expect(logs.some((m) => m.includes('/root/.claude/settings.json'))).toBe(true);
  });
});

describe('reprovisionVM', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch = jest.fn().mockImplementation((url: string, opts?: any) => {
      return Promise.resolve(new Response('ok', { status: 200 }));
    });
    globalThis.fetch = mockFetch as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should only use FS API for file writes (no shellExec install calls)', async () => {
    const mockSprite = createMockSprite();
    const client = createMockClient(mockSprite);
    mockedReadFile.mockResolvedValue(JSON.stringify({ claudeMd: '# Updated' }));

    await reprovisionVM(client, 'pigs-reprov');

    expect(client.sprite).not.toHaveBeenCalled(); // no shellExec needed
    // No execFile calls — all file writes go through fetch
    expect(mockSprite.execFile).toHaveBeenCalledTimes(0);
    expect(mockFetch).toHaveBeenCalled();
  });

  it('should reload settings from disk', async () => {
    const mockSprite = createMockSprite();
    const client = createMockClient(mockSprite);
    mockedReadFile.mockResolvedValue(JSON.stringify({ claudeMd: '# Fresh from disk' }));

    await reprovisionVM(client, 'pigs-reprov');

    expect(mockedReadFile).toHaveBeenCalled();

    // Verify CLAUDE.md content matches reloaded settings
    const writeCalls = mockFetch.mock.calls.filter(
      (call: any) => call[1]?.method === 'PUT',
    );
    const claudeMdWrite = writeCalls.find((call: any) =>
      String(call[0]).includes('CLAUDE.md'),
    );
    expect(claudeMdWrite).toBeDefined();
    expect(claudeMdWrite![1].body).toBe('# Fresh from disk');
  });

  it('should write settings.json with hooks and permissions config', async () => {
    const mockSprite = createMockSprite();
    const client = createMockClient(mockSprite);
    mockedReadFile.mockResolvedValue(JSON.stringify({ claudeMd: '# Test' }));

    await reprovisionVM(client, 'pigs-reprov');

    const writeCalls = mockFetch.mock.calls.filter(
      (call: any) => call[1]?.method === 'PUT',
    );
    const settingsWrite = writeCalls.find((call: any) =>
      String(call[0]).includes('settings.json'),
    );
    expect(settingsWrite).toBeDefined();
    const written = JSON.parse(settingsWrite![1].body);
    expect(written.permissions).toEqual({ defaultMode: 'bypassPermissions' });
    expect(written.hooks).toBeDefined();
  });

  it('should call onLog callback with progress messages', async () => {
    const mockSprite = createMockSprite();
    const client = createMockClient(mockSprite);
    mockedReadFile.mockResolvedValue(JSON.stringify({ claudeMd: '# Test' }));

    const logs: string[] = [];
    await reprovisionVM(client, 'pigs-reprov', (msg) => logs.push(msg));

    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs.some((m) => m.includes('Writing config files'))).toBe(true);
  });

  it('should propagate FS API errors', async () => {
    const client = createMockClient();
    mockedReadFile.mockResolvedValue(JSON.stringify({ claudeMd: '# Test' }));
    mockFetch.mockResolvedValueOnce(new Response('server error', { status: 500 }) as any);

    await expect(reprovisionVM(client, 'pigs-fail')).rejects.toThrow();
  });

  it('should work without onLog callback', async () => {
    const mockSprite = createMockSprite();
    const client = createMockClient(mockSprite);
    mockedReadFile.mockResolvedValue(JSON.stringify({ claudeMd: '# Test' }));

    await expect(reprovisionVM(client, 'pigs-silent')).resolves.toBeUndefined();
  });
});
