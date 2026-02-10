import { describe, it, expect } from 'bun:test';
import { buildDashboardCell } from '../tui.ts';
import type { VM } from '../types.ts';

function makeVM(overrides: Partial<VM> = {}): VM {
  return {
    name: 'pigs-abc123',
    worktreePath: '/tmp/worktrees/pigs-abc123',
    status: 'active',
    createdAt: new Date().toISOString(),
    needsAttention: false,
    provisioningStatus: 'done',
    ...overrides,
  };
}

describe('buildDashboardCell', () => {
  it('should return 3 lines for a basic active VM', () => {
    const vm = makeVM({ displayLabel: 'myapp:main' });
    const lines = buildDashboardCell(vm, '', 40);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('myapp:main');
  });

  it('should show status for active VM', () => {
    const vm = makeVM();
    const lines = buildDashboardCell(vm, '', 40);
    expect(lines[1]).toContain('active');
  });

  it('should show status for idle VM', () => {
    const vm = makeVM({ status: 'idle' });
    const lines = buildDashboardCell(vm, '', 40);
    expect(lines[1]).toContain('idle');
  });

  it('should show attention indicator', () => {
    const vm = makeVM({ needsAttention: true });
    const lines = buildDashboardCell(vm, '', 40);
    expect(lines[1]).toContain('!');
  });

  it('should show provisioning status', () => {
    const vm = makeVM({ provisioningStatus: 'provisioning' });
    const lines = buildDashboardCell(vm, '', 40);
    expect(lines[1]).toContain('[setup]');
  });

  it('should show failed provisioning status', () => {
    const vm = makeVM({ provisioningStatus: 'failed' });
    const lines = buildDashboardCell(vm, '', 40);
    expect(lines[1]).toContain('[fail]');
  });

  it('should show pending provisioning status', () => {
    const vm = makeVM({ provisioningStatus: 'pending' });
    const lines = buildDashboardCell(vm, '', 40);
    expect(lines[1]).toContain('[wait]');
  });

  it('should show last output line', () => {
    const vm = makeVM();
    const lines = buildDashboardCell(vm, 'Build succeeded!', 40);
    expect(lines[2]).toBe('Build succeeded!');
  });

  it('should show "(no output)" when last line is empty', () => {
    const vm = makeVM();
    const lines = buildDashboardCell(vm, '', 40);
    expect(lines[2]).toContain('(no output)');
  });

  it('should truncate long labels', () => {
    const vm = makeVM({ displayLabel: 'this-is-a-very-long-label-that-should-be-truncated-at-some-point' });
    const lines = buildDashboardCell(vm, '', 30);
    expect(lines[0]).toContain('...');
    expect(lines[0].length).toBeLessThanOrEqual(30);
  });

  it('should truncate long output lines', () => {
    const vm = makeVM();
    const longOutput = 'x'.repeat(100);
    const lines = buildDashboardCell(vm, longOutput, 30);
    expect(lines[2]).toContain('...');
    expect(lines[2].length).toBeLessThanOrEqual(30);
  });

  it('should use vm.name when displayLabel is not set', () => {
    const vm = makeVM({ name: 'pigs-xyz789', displayLabel: undefined });
    const lines = buildDashboardCell(vm, '', 40);
    expect(lines[0]).toBe('pigs-xyz789');
  });

  it('should show elapsed time when task is running', () => {
    const now = Date.now();
    const vm = makeVM({ taskStartedAt: now - 65000 }); // 1m05s ago
    const lines = buildDashboardCell(vm, '', 40);
    expect(lines[1]).toContain('1m');
  });
});
