/**
 * Integration tests — test against real local git worktrees.
 *
 * These tests create a real worktree, provision it, run commands,
 * and tear it down. They verify the app actually works end-to-end
 * against the local git worktree infrastructure.
 *
 * Run with:
 *   npm run test:integration
 *
 * Requires a git repository to be available.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type { VM } from '../types.ts';
import { shellExec } from '../shell-exec.ts';

import { provisionBranch, reprovisionBranch, loadSettings } from '../provisioner.ts';

import {
  clearAttention,
  defaultLabel,
  makeStopHookCommand,
  makeHooksConfig,
} from '../notification-monitor.ts';

// ---------------------------------------------------------------------------
// Shared state across all tests
// ---------------------------------------------------------------------------
let repoDir: string;
let worktreePath: string;
let testBranch: VM;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeAll(async () => {
  // Create a temporary directory for the test repo
  repoDir = await mkdtemp(join(tmpdir(), 'pigs-itest-'));

  // Initialize a git repo
  execSync('git init', { cwd: repoDir, stdio: 'pipe' });
  execSync('git commit --allow-empty -m "initial commit"', { cwd: repoDir, stdio: 'pipe' });

  // Create a worktree
  const branchName = `pigs-itest-${Date.now().toString(36)}`;
  worktreePath = join(repoDir, '.worktrees', branchName);
  execSync(`git worktree add -b ${branchName} "${worktreePath}"`, { cwd: repoDir, stdio: 'pipe' });

  testBranch = {
    name: branchName,
    worktreePath,
    status: 'active',
    createdAt: new Date().toISOString(),
    needsAttention: false,
  };
}, 30_000);

afterAll(async () => {
  // Clean up
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, { cwd: repoDir, stdio: 'pipe' });
  } catch {
    // Best-effort cleanup
  }
  try {
    await rm(repoDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}, 30_000);

// ---------------------------------------------------------------------------
// 1. Shell execution
// ---------------------------------------------------------------------------
describe('shellExec (live)', () => {
  it('can execute a simple command in the worktree', () => {
    const { stdout } = shellExec(worktreePath, 'echo hello');
    expect(stdout.trim()).toBe('hello');
  });

  it('can execute shell commands with pipes', () => {
    const { stdout } = shellExec(worktreePath, 'echo hello | tr a-z A-Z');
    expect(stdout.trim()).toBe('HELLO');
  });

  it('can execute multi-line shell scripts', () => {
    const script = 'set -e\nA=hello\nB=world\necho "$A $B"';
    const { stdout } = shellExec(worktreePath, script);
    expect(stdout.trim()).toBe('hello world');
  });
});

// ---------------------------------------------------------------------------
// 2. Provisioning (writes Claude Code config files)
// ---------------------------------------------------------------------------
describe('Provisioning (live)', () => {
  it('provisions the worktree (writes CLAUDE.md + hooks)', async () => {
    const logs: string[] = [];
    await provisionBranch(worktreePath, undefined, (msg) => logs.push(msg));
    testBranch.provisioningStatus = 'done';

    // Verify we got log output from provisioning
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes('CLAUDE.md'))).toBe(true);
  }, 30_000);

  it('can verify CLAUDE.md was written', () => {
    const { stdout } = shellExec(worktreePath, 'cat CLAUDE.md');
    expect(stdout.trim()).toContain('Agent Instructions');
  });

  it('can verify notification hook is installed', () => {
    const { stdout } = shellExec(worktreePath, 'cat .claude/settings.json');
    const settings = JSON.parse(stdout.trim());
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.Stop).toBeDefined();
    expect(settings.permissions).toEqual({ defaultMode: 'bypassPermissions' });
  });
});

// ---------------------------------------------------------------------------
// 3. Notification monitor helpers
// ---------------------------------------------------------------------------
describe('Notification monitor (live)', () => {
  it('clearAttention sets needsAttention to false', () => {
    const branch: VM = { ...testBranch, needsAttention: true };
    clearAttention(branch);
    expect(branch.needsAttention).toBe(false);
  });

  it('defaultLabel returns the branch name', () => {
    expect(defaultLabel(testBranch.name)).toBe(testBranch.name);
  });

  it('makeStopHookCommand returns a touch command', () => {
    const cmd = makeStopHookCommand(worktreePath);
    expect(cmd).toContain('touch');
  });

  it('makeHooksConfig returns valid config', () => {
    const config = makeHooksConfig(worktreePath);
    expect(config.permissions.defaultMode).toBe('bypassPermissions');
    expect(config.hooks.Stop).toHaveLength(1);
    expect(config.hooks.Stop[0].hooks[0].type).toBe('command');
  });
});

// ---------------------------------------------------------------------------
// 4. Re-provisioning (config push without reinstall)
// ---------------------------------------------------------------------------
describe('Reprovision (live)', () => {
  it('re-provisions the worktree (updates CLAUDE.md + hooks)', async () => {
    const logs: string[] = [];
    await reprovisionBranch(worktreePath, (msg) => logs.push(msg));

    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes('CLAUDE.md'))).toBe(true);

    // Verify the CLAUDE.md was refreshed
    const { stdout } = shellExec(worktreePath, 'cat CLAUDE.md');
    expect(stdout.trim()).toContain('Agent Instructions');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 5. Settings (local file operations)
// ---------------------------------------------------------------------------
describe('Settings (live)', () => {
  it('loads settings from disk (or creates defaults)', async () => {
    const settings = await loadSettings();
    expect(settings).toBeDefined();
    expect(typeof settings.claudeMd).toBe('string');
    expect(settings.claudeMd.length).toBeGreaterThan(0);
  });
});
