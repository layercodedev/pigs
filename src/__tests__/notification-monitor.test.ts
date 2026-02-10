import { describe, it, expect, jest, beforeEach, afterEach, mock } from 'bun:test';
import {
  startMonitor,
  stopMonitor,
  clearAttention,
  defaultLabel,
  CLAUDE_HOOKS_CONFIG,
  makeStopHookCommand,
  makeHooksConfig,
  SIGNAL_FILE,
  _checkSignal,
  _checkGitLabel,
  _pollAll,
  _getSignalPath,
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
    it('should define a Stop hook with touch command', () => {
      expect(CLAUDE_HOOKS_CONFIG.hooks.Stop).toHaveLength(1);
      const hookGroup = CLAUDE_HOOKS_CONFIG.hooks.Stop[0];
      expect(hookGroup.hooks).toHaveLength(1);
      expect(hookGroup.hooks[0].type).toBe('command');
      expect(hookGroup.hooks[0].command).toContain('touch');
    });
  });

  describe('makeStopHookCommand', () => {
    it('should return a touch command for the signal path', () => {
      const cmd = makeStopHookCommand('/tmp/worktrees/test');
      expect(cmd).toContain('touch');
    });
  });

  describe('makeHooksConfig', () => {
    it('should return config with permissions and hooks', () => {
      const config = makeHooksConfig('/tmp/worktrees/test');
      expect(config.permissions).toEqual({ defaultMode: 'bypassPermissions' });
      expect(config.hooks.Stop).toHaveLength(1);
      expect(config.hooks.Stop[0].hooks[0].type).toBe('command');
      expect(config.hooks.Stop[0].hooks[0].command).toContain('touch');
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
    it('should not start multiple timers', () => {
      const branches: VM[] = [];
      const onChange = jest.fn();

      startMonitor(branches, onChange);
      startMonitor(branches, onChange); // duplicate call

      // Advance timer once - should only have one interval
      jest.advanceTimersByTime(5000);
      stopMonitor();
    });

    it('should stop polling when stopMonitor is called', () => {
      const branch = createBranch();
      const onChange = jest.fn();

      startMonitor([branch], onChange);
      stopMonitor();

      jest.advanceTimersByTime(10000);
      // No errors should occur
    });
  });
});
