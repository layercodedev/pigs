import { describe, it, expect } from 'vitest';
import { buildVmSummary } from '../tui.ts';
import type { VM } from '../types.ts';

function makeVM(overrides: Partial<VM> = {}): VM {
  return {
    name: 'pigs-test',
    id: 'test-id',
    status: 'running',
    createdAt: new Date().toISOString(),
    needsAttention: false,
    ...overrides,
  };
}

describe('buildVmSummary', () => {
  it('should return empty string for no VMs', () => {
    expect(buildVmSummary([])).toBe('');
  });

  it('should show total count for a single VM with no provisioning status', () => {
    expect(buildVmSummary([makeVM()])).toBe('1');
  });

  it('should show ready count for provisioned VMs', () => {
    const vms = [
      makeVM({ provisioningStatus: 'done' }),
      makeVM({ provisioningStatus: 'done' }),
    ];
    expect(buildVmSummary(vms)).toBe('2, 2 ready');
  });

  it('should show setup count for provisioning/pending VMs', () => {
    const vms = [
      makeVM({ provisioningStatus: 'provisioning' }),
      makeVM({ provisioningStatus: 'pending' }),
    ];
    expect(buildVmSummary(vms)).toBe('2, 2 setup');
  });

  it('should show attention count for VMs needing attention', () => {
    const vms = [
      makeVM({ provisioningStatus: 'done', needsAttention: true }),
      makeVM({ provisioningStatus: 'done', needsAttention: false }),
    ];
    expect(buildVmSummary(vms)).toBe('2, 2 ready, 1 !');
  });

  it('should show failed count for failed VMs', () => {
    const vms = [
      makeVM({ provisioningStatus: 'failed' }),
    ];
    expect(buildVmSummary(vms)).toBe('1, 1 fail');
  });

  it('should show all categories in a mixed fleet', () => {
    const vms = [
      makeVM({ provisioningStatus: 'done', needsAttention: false }),
      makeVM({ provisioningStatus: 'done', needsAttention: true }),
      makeVM({ provisioningStatus: 'provisioning' }),
      makeVM({ provisioningStatus: 'failed' }),
    ];
    expect(buildVmSummary(vms)).toBe('4, 2 ready, 1 setup, 1 !, 1 fail');
  });

  it('should omit zero-count categories', () => {
    const vms = [
      makeVM({ provisioningStatus: 'done' }),
      makeVM({ provisioningStatus: 'done' }),
      makeVM({ provisioningStatus: 'done' }),
    ];
    // No setup, no attention, no failed — only total and ready
    expect(buildVmSummary(vms)).toBe('3, 3 ready');
  });
});
