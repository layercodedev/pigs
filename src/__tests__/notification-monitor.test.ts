import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  startMonitor,
  stopMonitor,
  clearAttention,
  defaultLabel,
  CLAUDE_HOOKS_CONFIG,
  STOP_HOOK_COMMAND,
  SIGNAL_FILE,
  _pollAll,
  _checkSignal,
  _checkGitLabel,
} from '../notification-monitor.js';
import type { VM } from '../types.js';

function createMockSprite(execResult?: { stdout: string; stderr: string; exitCode: number }) {
  const result = execResult ?? { stdout: '', stderr: '', exitCode: 0 };
  return {
    exec: vi.fn().mockResolvedValue(result),
    execFile: vi.fn().mockResolvedValue(result),
  };
}

function createMockClient(mockSprite?: ReturnType<typeof createMockSprite>) {
  const sprite = mockSprite ?? createMockSprite();
  return {
    sprite: vi.fn().mockReturnValue(sprite),
    _mockSprite: sprite,
  } as any;
}

function createVM(overrides: Partial<VM> = {}): VM {
  return {
    name: 'pigs-abc123',
    id: 'pigs-abc123',
    status: 'running',
    createdAt: new Date().toISOString(),
    needsAttention: false,
    provisioningStatus: 'done',
    ...overrides,
  };
}

describe('notification-monitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopMonitor();
    vi.useRealTimers();
  });

  describe('CLAUDE_HOOKS_CONFIG', () => {
    it('should define a Stop hook with touch command', () => {
      expect(CLAUDE_HOOKS_CONFIG.hooks.Stop).toHaveLength(1);
      const hookGroup = CLAUDE_HOOKS_CONFIG.hooks.Stop[0];
      expect(hookGroup.hooks).toHaveLength(1);
      expect(hookGroup.hooks[0].type).toBe('command');
      expect(hookGroup.hooks[0].command).toBe(STOP_HOOK_COMMAND);
    });

    it('should use the correct signal file path', () => {
      expect(STOP_HOOK_COMMAND).toContain(SIGNAL_FILE);
      expect(STOP_HOOK_COMMAND).toContain('touch');
    });
  });

  describe('clearAttention', () => {
    it('should set needsAttention to false', () => {
      const vm = createVM({ needsAttention: true });
      clearAttention(vm);
      expect(vm.needsAttention).toBe(false);
    });

    it('should be safe to call when already false', () => {
      const vm = createVM({ needsAttention: false });
      clearAttention(vm);
      expect(vm.needsAttention).toBe(false);
    });
  });

  describe('_checkSignal', () => {
    it('should set needsAttention when signal file is found', async () => {
      const mockSprite = createMockSprite({ stdout: 'FOUND\n', stderr: '', exitCode: 0 });
      const client = createMockClient(mockSprite);
      const vm = createVM();

      await _checkSignal(client, vm);

      expect(client.sprite).toHaveBeenCalledWith('pigs-abc123');
      // shellExec calls execFile('bash', ['-c', script])
      expect(mockSprite.execFile).toHaveBeenCalledWith(
        'bash',
        ['-c', expect.stringContaining(SIGNAL_FILE)],
      );
      expect(vm.needsAttention).toBe(true);
    });

    it('should clear taskStartedAt when signal file is found', async () => {
      const mockSprite = createMockSprite({ stdout: 'FOUND\n', stderr: '', exitCode: 0 });
      const client = createMockClient(mockSprite);
      const vm = createVM({ taskStartedAt: Date.now() - 30000 });

      await _checkSignal(client, vm);

      expect(vm.needsAttention).toBe(true);
      expect(vm.taskStartedAt).toBeUndefined();
    });

    it('should not set needsAttention when no signal file', async () => {
      const mockSprite = createMockSprite({ stdout: '', stderr: '', exitCode: 0 });
      const client = createMockClient(mockSprite);
      const vm = createVM();

      await _checkSignal(client, vm);

      expect(vm.needsAttention).toBe(false);
    });

    it('should remove the signal file after reading', async () => {
      const mockSprite = createMockSprite({ stdout: 'FOUND\n', stderr: '', exitCode: 0 });
      const client = createMockClient(mockSprite);
      const vm = createVM();

      await _checkSignal(client, vm);

      const script = mockSprite.execFile.mock.calls[0][1][1] as string;
      expect(script).toContain('rm -f');
    });
  });

  describe('_pollAll', () => {
    it('should check provisioned VMs for signal', async () => {
      const mockSprite = createMockSprite({ stdout: 'FOUND\n', stderr: '', exitCode: 0 });
      const client = createMockClient(mockSprite);
      const vm = createVM();
      const onChange = vi.fn();

      await _pollAll(client, [vm], onChange);

      expect(vm.needsAttention).toBe(true);
      expect(onChange).toHaveBeenCalled();
    });

    it('should skip VMs that are not provisioned', async () => {
      const mockSprite = createMockSprite();
      const client = createMockClient(mockSprite);
      const vm = createVM({ provisioningStatus: 'provisioning' });
      const onChange = vi.fn();

      await _pollAll(client, [vm], onChange);

      expect(mockSprite.execFile).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
    });

    it('should skip signal check for VMs that already need attention but still check git', async () => {
      const mockSprite = createMockSprite({ stdout: '', stderr: '', exitCode: 0 });
      const client = createMockClient(mockSprite);
      const vm = createVM({ needsAttention: true, displayLabel: 'abc123' });
      const onChange = vi.fn();

      await _pollAll(client, [vm], onChange);

      // Should only be called once (git check via shellExec), not twice (signal + git)
      expect(mockSprite.execFile).toHaveBeenCalledTimes(1);
      expect(mockSprite.execFile).toHaveBeenCalledWith(
        'bash',
        ['-c', expect.stringContaining('git rev-parse')],
      );
    });

    it('should not call onChange when no signal found and label unchanged', async () => {
      const mockSprite = createMockSprite({ stdout: '', stderr: '', exitCode: 0 });
      const client = createMockClient(mockSprite);
      const vm = createVM({ displayLabel: 'abc123' }); // already has default label
      const onChange = vi.fn();

      await _pollAll(client, [vm], onChange);

      expect(onChange).not.toHaveBeenCalled();
    });

    it('should handle exec errors gracefully', async () => {
      const mockSprite = createMockSprite();
      mockSprite.execFile.mockRejectedValue(new Error('network error'));
      const client = createMockClient(mockSprite);
      const vm = createVM();
      const onChange = vi.fn();

      await expect(_pollAll(client, [vm], onChange)).resolves.toBeUndefined();
      expect(onChange).not.toHaveBeenCalled();
    });

    it('should check multiple VMs', async () => {
      const mockSprite = createMockSprite({ stdout: 'FOUND\n', stderr: '', exitCode: 0 });
      const client = createMockClient(mockSprite);
      const vm1 = createVM({ name: 'pigs-aaa' });
      const vm2 = createVM({ name: 'pigs-bbb' });
      const onChange = vi.fn();

      await _pollAll(client, [vm1, vm2], onChange);

      expect(client.sprite).toHaveBeenCalledWith('pigs-aaa');
      expect(client.sprite).toHaveBeenCalledWith('pigs-bbb');
      expect(vm1.needsAttention).toBe(true);
      expect(vm2.needsAttention).toBe(true);
      expect(onChange).toHaveBeenCalledTimes(2);
    });
  });

  describe('defaultLabel', () => {
    it('should return last 6 chars of VM name', () => {
      expect(defaultLabel('pigs-abc123')).toBe('abc123');
    });

    it('should handle short names', () => {
      expect(defaultLabel('abc')).toBe('abc');
    });
  });

  describe('_checkGitLabel', () => {
    it('should set displayLabel to dirname:branch when in a git repo', async () => {
      const mockSprite = createMockSprite({
        stdout: '/root/myproject\nmain\n',
        stderr: '',
        exitCode: 0,
      });
      const client = createMockClient(mockSprite);
      const vm = createVM({ displayLabel: 'abc123' });

      const changed = await _checkGitLabel(client, vm);

      expect(client.sprite).toHaveBeenCalledWith('pigs-abc123');
      expect(mockSprite.execFile).toHaveBeenCalledWith(
        'bash',
        ['-c', expect.stringContaining('git rev-parse')],
      );
      expect(vm.displayLabel).toBe('myproject:main');
      expect(changed).toBe(true);
    });

    it('should use directory basename not full path', async () => {
      const mockSprite = createMockSprite({
        stdout: '/home/user/deep/nested/repo\nfeature-branch\n',
        stderr: '',
        exitCode: 0,
      });
      const client = createMockClient(mockSprite);
      const vm = createVM({ displayLabel: 'abc123' });

      await _checkGitLabel(client, vm);

      expect(vm.displayLabel).toBe('repo:feature-branch');
    });

    it('should fall back to default label when not in git repo', async () => {
      const mockSprite = createMockSprite({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });
      const client = createMockClient(mockSprite);
      const vm = createVM({ name: 'pigs-xyz789', displayLabel: 'myproject:main' });

      const changed = await _checkGitLabel(client, vm);

      expect(vm.displayLabel).toBe('xyz789');
      expect(changed).toBe(true);
    });

    it('should return false when label has not changed', async () => {
      const mockSprite = createMockSprite({
        stdout: '/root/myproject\nmain\n',
        stderr: '',
        exitCode: 0,
      });
      const client = createMockClient(mockSprite);
      const vm = createVM({ displayLabel: 'myproject:main' });

      const changed = await _checkGitLabel(client, vm);

      expect(changed).toBe(false);
    });

    it('should skip VMs with customLabel set', async () => {
      const mockSprite = createMockSprite({
        stdout: '/root/myproject\nmain\n',
        stderr: '',
        exitCode: 0,
      });
      const client = createMockClient(mockSprite);
      const vm = createVM({ displayLabel: 'my-custom-name', customLabel: true });

      const changed = await _checkGitLabel(client, vm);

      expect(mockSprite.execFile).not.toHaveBeenCalled();
      expect(vm.displayLabel).toBe('my-custom-name');
      expect(changed).toBe(false);
    });

    it('should return false when default label unchanged', async () => {
      const mockSprite = createMockSprite({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });
      const client = createMockClient(mockSprite);
      const vm = createVM({ name: 'pigs-abc123', displayLabel: 'abc123' });

      const changed = await _checkGitLabel(client, vm);

      expect(changed).toBe(false);
    });
  });

  describe('startMonitor / stopMonitor', () => {
    it('should not start multiple timers', () => {
      const client = createMockClient();
      const vms: VM[] = [];
      const onChange = vi.fn();

      startMonitor(client, vms, onChange);
      startMonitor(client, vms, onChange); // duplicate call

      // Advance timer once - should only have one interval
      vi.advanceTimersByTime(5000);
      stopMonitor();
    });

    it('should stop polling when stopMonitor is called', () => {
      const mockSprite = createMockSprite();
      const client = createMockClient(mockSprite);
      const vm = createVM();
      const onChange = vi.fn();

      startMonitor(client, [vm], onChange);
      stopMonitor();

      vi.advanceTimersByTime(10000);
      expect(mockSprite.execFile).not.toHaveBeenCalled();
    });
  });
});
