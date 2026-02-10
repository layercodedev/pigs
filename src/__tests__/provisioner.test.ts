import { describe, it, expect, jest, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import { provisionBranch, reprovisionBranch, loadSettings } from '../provisioner.ts';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Mock node:fs/promises
mock.module('node:fs/promises', () => ({
	readFile: jest.fn(),
	mkdir: jest.fn().mockResolvedValue(undefined),
	writeFile: jest.fn().mockResolvedValue(undefined),
}));

const mockedReadFile = readFile as Mock<typeof readFile>;
const mockedMkdir = mkdir as Mock<typeof mkdir>;
const mockedWriteFile = writeFile as Mock<typeof writeFile>;

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
});

describe('provisionBranch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // By default, readFile returns empty JSON (no existing settings.json in worktree)
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
  });

  it('should write .claude/settings.json with hooks and permissions', async () => {
    const worktreePath = '/tmp/worktrees/test-branch';

    await provisionBranch(worktreePath, { claudeMd: '# Test' });

    // Should write .claude/settings.json
    const settingsCall = mockedWriteFile.mock.calls.find(
      (call) => String(call[0]).includes('settings.json'),
    );
    expect(settingsCall).toBeDefined();
    expect(settingsCall![0]).toBe(join(worktreePath, '.claude', 'settings.json'));
    const written = JSON.parse(settingsCall![1] as string);
    expect(written.hooks).toBeDefined();
    expect(written.hooks.Stop).toBeDefined();
  });

  it('should merge pigs hooks into existing settings.json', async () => {
    const worktreePath = '/tmp/worktrees/test-branch';
    const existingSettings = {
      permissions: {
        allow: ['Bash(git:*)'],
        deny: ['Read(**/.env)'],
        defaultMode: 'bypassPermissions',
        hooks: {
          PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier' }] }],
        },
      },
      enableAllProjectMcpServers: true,
    };
    // First readFile call is for existing .claude/settings.json
    mockedReadFile.mockResolvedValueOnce(JSON.stringify(existingSettings));

    await provisionBranch(worktreePath, { claudeMd: '# Test' });

    const settingsCall = mockedWriteFile.mock.calls.find(
      (call) => String(call[0]).includes('settings.json'),
    );
    const written = JSON.parse(settingsCall![1] as string);
    // Should preserve existing fields
    expect(written.permissions.allow).toEqual(['Bash(git:*)']);
    expect(written.permissions.deny).toEqual(['Read(**/.env)']);
    expect(written.enableAllProjectMcpServers).toBe(true);
    // Should preserve existing permissions
    expect(written.permissions.defaultMode).toBe('bypassPermissions');
    // Should have Stop hook
    expect(written.hooks.Stop).toBeDefined();
    expect(written.hooks.Stop.length).toBeGreaterThan(0);
  });

  it('should create .claude directory', async () => {
    const worktreePath = '/tmp/worktrees/test-branch';

    await provisionBranch(worktreePath, { claudeMd: '# Test' });

    expect(mockedMkdir).toHaveBeenCalledWith(
      join(worktreePath, '.claude'),
      { recursive: true },
    );
  });

  it('should call onLog callback with progress messages', async () => {
    const logs: string[] = [];
    await provisionBranch('/tmp/worktrees/test', { claudeMd: '# Test' }, (msg) => logs.push(msg));

    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs.some((m) => m.includes('Writing config files'))).toBe(true);
    expect(logs.some((m) => m.includes('.claude/settings.json'))).toBe(true);
  });

  it('should propagate write errors', async () => {
    mockedWriteFile.mockRejectedValueOnce(new Error('disk full'));

    await expect(provisionBranch('/tmp/worktrees/fail', { claudeMd: '# Test' })).rejects.toThrow('disk full');
  });

  it('should work without onLog callback', async () => {
    await expect(provisionBranch('/tmp/worktrees/silent', { claudeMd: '# Test' })).resolves.toBeUndefined();
  });

  it('should fall back to loadSettings when no settings passed', async () => {
    // First readFile: existing .claude/settings.json (not found)
    // Second readFile: loadSettings from ~/.pigs/settings.json (not found, creates default)
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));

    await provisionBranch('/tmp/worktrees/new');

    expect(mockedMkdir).toHaveBeenCalled();

    // Should write .claude/settings.json with hooks
    const settingsCall = mockedWriteFile.mock.calls.find(
      (call) => String(call[0]).includes('.claude') && String(call[0]).includes('settings.json'),
    );
    expect(settingsCall).toBeDefined();
  });

  it('should use provided settings instead of loading from disk', async () => {
    const customSettings = { claudeMd: '# Custom from app state' };

    await provisionBranch('/tmp/worktrees/custom', customSettings);

    // readFile should only be called for the existing .claude/settings.json merge, not for ~/.pigs/settings.json
    const settingsPath = join(homedir(), '.pigs', 'settings.json');
    const settingsCalls = mockedReadFile.mock.calls.filter(
      (call) => call[0] === settingsPath,
    );
    expect(settingsCalls).toHaveLength(0);
  });
});

describe('reprovisionBranch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should reload settings from disk', async () => {
    // First readFile: loadSettings from ~/.pigs/settings.json
    mockedReadFile.mockResolvedValueOnce(JSON.stringify({ claudeMd: '# Fresh from disk' }));
    // Second readFile: existing .claude/settings.json (not found)
    mockedReadFile.mockRejectedValueOnce(new Error('ENOENT'));

    await reprovisionBranch('/tmp/worktrees/reprov');

    expect(mockedReadFile).toHaveBeenCalled();
  });

  it('should write settings.json with hooks and permissions config', async () => {
    mockedReadFile.mockResolvedValueOnce(JSON.stringify({ claudeMd: '# Test' }));
    mockedReadFile.mockRejectedValueOnce(new Error('ENOENT'));

    await reprovisionBranch('/tmp/worktrees/reprov');

    const settingsCall = mockedWriteFile.mock.calls.find(
      (call) => String(call[0]).includes('settings.json'),
    );
    expect(settingsCall).toBeDefined();
    const written = JSON.parse(settingsCall![1] as string);
    expect(written.hooks).toBeDefined();
    expect(written.hooks.Stop).toBeDefined();
  });

  it('should call onLog callback with progress messages', async () => {
    mockedReadFile.mockResolvedValueOnce(JSON.stringify({ claudeMd: '# Test' }));
    mockedReadFile.mockRejectedValueOnce(new Error('ENOENT'));

    const logs: string[] = [];
    await reprovisionBranch('/tmp/worktrees/reprov', (msg) => logs.push(msg));

    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs.some((m) => m.includes('Writing config files'))).toBe(true);
  });

  it('should propagate write errors', async () => {
    mockedReadFile.mockResolvedValueOnce(JSON.stringify({ claudeMd: '# Test' }));
    mockedReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    mockedWriteFile.mockRejectedValueOnce(new Error('disk full'));

    await expect(reprovisionBranch('/tmp/worktrees/fail')).rejects.toThrow('disk full');
  });

  it('should work without onLog callback', async () => {
    mockedReadFile.mockResolvedValueOnce(JSON.stringify({ claudeMd: '# Test' }));
    mockedReadFile.mockRejectedValueOnce(new Error('ENOENT'));

    await expect(reprovisionBranch('/tmp/worktrees/silent')).resolves.toBeUndefined();
  });
});
