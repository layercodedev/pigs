import { describe, it, expect, jest, beforeEach, afterEach } from 'bun:test';
import {
  startMonitor,
  stopMonitor,
  clearAttention,
  defaultLabel,
  CLAUDE_HOOKS_CONFIG,
  makeStopHookCommand,
  makeHooksConfig,
  _checkGitLabel,
  _pollLabels,
  _getChannelName,
  LABEL_POLL_INTERVAL_MS,
} from '../notification-monitor.ts';
import type { VM } from '../types.ts';

function createBranch(overrides: Partial<VM> = {}): VM {
  return {
    name: 'test-branch',
    worktreePath: '/tmp/worktrees/test-branch',
    status: 'active',
    createdAt: new Date().toISOString(),
    needsAttention: false,
    provisioningStatus: 'done',
    ...overrides,
  };
}

describe('notification-monitor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    stopMonitor();
    jest.useRealTimers();
  });

  describe('CLAUDE_HOOKS_CONFIG', () => {
    it('should define a Stop hook with tmux wait-for command', () => {
      expect(CLAUDE_HOOKS_CONFIG.hooks.Stop).toHaveLength(1);
      const hookGroup = CLAUDE_HOOKS_CONFIG.hooks.Stop[0];
      expect(hookGroup.hooks).toHaveLength(1);
      expect(hookGroup.hooks[0].type).toBe('command');
      expect(hookGroup.hooks[0].command).toContain('tmux wait-for -S');
    });
  });

  describe('makeStopHookCommand', () => {
    it('should return a tmux wait-for signal command', () => {
      const cmd = makeStopHookCommand('/tmp/worktrees/test');
      expect(cmd).toContain('tmux wait-for -S');
      expect(cmd).toContain('pigs-done-');
    });
  });

  describe('makeHooksConfig', () => {
    it('should return config with permissions and hooks', () => {
      const config = makeHooksConfig('/tmp/worktrees/test');
      expect(config.permissions).toEqual({ defaultMode: 'bypassPermissions' });
      expect(config.hooks.Stop).toHaveLength(1);
      expect(config.hooks.Stop[0].hooks[0].type).toBe('command');
      expect(config.hooks.Stop[0].hooks[0].command).toContain('tmux wait-for -S');
    });
  });

  describe('getChannelName', () => {
    it('should return a pigs-done- prefixed channel name', () => {
      const channel = _getChannelName('/tmp/worktrees/test');
      expect(channel).toMatch(/^pigs-done-/);
    });

    it('should return different channels for different paths', () => {
      const ch1 = _getChannelName('/tmp/worktrees/a');
      const ch2 = _getChannelName('/tmp/worktrees/b');
      expect(ch1).not.toBe(ch2);
    });
  });

  describe('clearAttention', () => {
    it('should set needsAttention to false', () => {
      const branch = createBranch({ needsAttention: true });
      clearAttention(branch);
      expect(branch.needsAttention).toBe(false);
    });

    it('should be safe to call when already false', () => {
      const branch = createBranch({ needsAttention: false });
      clearAttention(branch);
      expect(branch.needsAttention).toBe(false);
    });
  });

  describe('defaultLabel', () => {
    it('should return the branch name as-is', () => {
      expect(defaultLabel('feature/my-branch')).toBe('feature/my-branch');
    });

    it('should handle simple names', () => {
      expect(defaultLabel('main')).toBe('main');
    });
  });

  describe('startMonitor / stopMonitor', () => {
    it('should not start multiple monitors', () => {
      const branches: VM[] = [];
      const onChange = jest.fn();

      startMonitor(branches, onChange);
      startMonitor(branches, onChange); // duplicate call

      // Should not throw
      stopMonitor();
    });

    it('should stop cleanly when stopMonitor is called', () => {
      const branch = createBranch();
      const onChange = jest.fn();

      startMonitor([branch], onChange);
      stopMonitor();

      jest.advanceTimersByTime(20000);
      // No errors should occur
    });
  });

  describe('LABEL_POLL_INTERVAL_MS', () => {
    it('should be 10 seconds', () => {
      expect(LABEL_POLL_INTERVAL_MS).toBe(10000);
    });
  });
});
