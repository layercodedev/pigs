import { describe, it, expect } from 'vitest';
import { filterVMs } from '../tui.js';
import type { VM } from '../types.js';

function makeVM(overrides: Partial<VM> = {}): VM {
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

describe('filterVMs', () => {
  it('returns all VMs when filter is empty', () => {
    const vms = [makeVM({ name: 'vm1' }), makeVM({ name: 'vm2' })];
    expect(filterVMs(vms, '')).toEqual(vms);
  });

  it('returns empty array when no VMs exist', () => {
    expect(filterVMs([], 'test')).toEqual([]);
  });

  it('filters by VM name', () => {
    const vms = [
      makeVM({ name: 'pigs-alpha' }),
      makeVM({ name: 'pigs-beta' }),
      makeVM({ name: 'pigs-gamma' }),
    ];
    const result = filterVMs(vms, 'beta');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('pigs-beta');
  });

  it('filters by displayLabel', () => {
    const vms = [
      makeVM({ name: 'vm1', displayLabel: 'myproject:main' }),
      makeVM({ name: 'vm2', displayLabel: 'otherproject:dev' }),
      makeVM({ name: 'vm3', displayLabel: 'myproject:feature' }),
    ];
    const result = filterVMs(vms, 'myproject');
    expect(result).toHaveLength(2);
    expect(result[0].displayLabel).toBe('myproject:main');
    expect(result[1].displayLabel).toBe('myproject:feature');
  });

  it('is case-insensitive', () => {
    const vms = [
      makeVM({ name: 'vm1', displayLabel: 'MyProject:Main' }),
      makeVM({ name: 'vm2', displayLabel: 'other:dev' }),
    ];
    const result = filterVMs(vms, 'MYPROJECT');
    expect(result).toHaveLength(1);
    expect(result[0].displayLabel).toBe('MyProject:Main');
  });

  it('filters by status', () => {
    const vms = [
      makeVM({ name: 'vm1', status: 'running' }),
      makeVM({ name: 'vm2', status: 'stopped' }),
      makeVM({ name: 'vm3', status: 'running' }),
    ];
    const result = filterVMs(vms, 'stopped');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('vm2');
  });

  it('filters by provisioningStatus', () => {
    const vms = [
      makeVM({ name: 'vm1', provisioningStatus: 'done' }),
      makeVM({ name: 'vm2', provisioningStatus: 'failed' }),
      makeVM({ name: 'vm3', provisioningStatus: 'provisioning' }),
    ];
    const result = filterVMs(vms, 'failed');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('vm2');
  });

  it('matches partial strings', () => {
    const vms = [
      makeVM({ name: 'vm1', displayLabel: 'frontend:main' }),
      makeVM({ name: 'vm2', displayLabel: 'backend:main' }),
    ];
    const result = filterVMs(vms, 'front');
    expect(result).toHaveLength(1);
    expect(result[0].displayLabel).toBe('frontend:main');
  });

  it('returns no matches when filter does not match', () => {
    const vms = [
      makeVM({ name: 'vm1', displayLabel: 'project:main' }),
      makeVM({ name: 'vm2', displayLabel: 'project:dev' }),
    ];
    const result = filterVMs(vms, 'nonexistent');
    expect(result).toHaveLength(0);
  });

  it('falls back to name when displayLabel is undefined', () => {
    const vms = [
      makeVM({ name: 'pigs-xyz789' }),
      makeVM({ name: 'pigs-abc123' }),
    ];
    const result = filterVMs(vms, 'xyz');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('pigs-xyz789');
  });

  it('matches against branch in displayLabel', () => {
    const vms = [
      makeVM({ name: 'vm1', displayLabel: 'project:feature/auth' }),
      makeVM({ name: 'vm2', displayLabel: 'project:main' }),
      makeVM({ name: 'vm3', displayLabel: 'project:feature/payments' }),
    ];
    const result = filterVMs(vms, 'feature');
    expect(result).toHaveLength(2);
  });
});
