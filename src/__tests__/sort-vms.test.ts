import { describe, it, expect } from 'vitest';
import { sortVMs, nextSortMode } from '../tui.ts';
import type { VM } from '../types.ts';

function makeVM(overrides: Partial<VM> & { name: string }): VM {
  return {
    id: overrides.name,
    status: 'running',
    createdAt: new Date().toISOString(),
    needsAttention: false,
    ...overrides,
  };
}

describe('nextSortMode', () => {
  it('should cycle through all sort modes', () => {
    expect(nextSortMode('default')).toBe('name');
    expect(nextSortMode('name')).toBe('status');
    expect(nextSortMode('status')).toBe('attention');
    expect(nextSortMode('attention')).toBe('elapsed');
    expect(nextSortMode('elapsed')).toBe('default');
  });
});

describe('sortVMs', () => {
  it('should return same order for default sort mode', () => {
    const vms = [makeVM({ name: 'c' }), makeVM({ name: 'a' }), makeVM({ name: 'b' })];
    const result = sortVMs(vms, 'default');
    expect(result.map(v => v.name)).toEqual(['c', 'a', 'b']);
  });

  it('should not mutate input array', () => {
    const vms = [makeVM({ name: 'c' }), makeVM({ name: 'a' })];
    const result = sortVMs(vms, 'name');
    expect(result).not.toBe(vms);
  });

  it('should sort by name alphabetically', () => {
    const vms = [
      makeVM({ name: 'pigs-charlie', displayLabel: 'charlie' }),
      makeVM({ name: 'pigs-alpha', displayLabel: 'alpha' }),
      makeVM({ name: 'pigs-bravo', displayLabel: 'bravo' }),
    ];
    const result = sortVMs(vms, 'name');
    expect(result.map(v => v.displayLabel)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('should sort by name case-insensitively', () => {
    const vms = [
      makeVM({ name: 'pigs-B', displayLabel: 'Beta' }),
      makeVM({ name: 'pigs-a', displayLabel: 'alpha' }),
    ];
    const result = sortVMs(vms, 'name');
    expect(result.map(v => v.displayLabel)).toEqual(['alpha', 'Beta']);
  });

  it('should fall back to vm.name when displayLabel is absent', () => {
    const vms = [
      makeVM({ name: 'zulu' }),
      makeVM({ name: 'alpha' }),
    ];
    const result = sortVMs(vms, 'name');
    expect(result.map(v => v.name)).toEqual(['alpha', 'zulu']);
  });

  it('should sort by status: running first, stopped second, cold last', () => {
    const vms = [
      makeVM({ name: 'cold-vm', status: 'cold' }),
      makeVM({ name: 'running-vm', status: 'running' }),
      makeVM({ name: 'stopped-vm', status: 'stopped' }),
    ];
    const result = sortVMs(vms, 'status');
    expect(result.map(v => v.status)).toEqual(['running', 'stopped', 'cold']);
  });

  it('should sort by attention: attention VMs first', () => {
    const vms = [
      makeVM({ name: 'no-attn-1', needsAttention: false }),
      makeVM({ name: 'attn-1', needsAttention: true }),
      makeVM({ name: 'no-attn-2', needsAttention: false }),
      makeVM({ name: 'attn-2', needsAttention: true }),
    ];
    const result = sortVMs(vms, 'attention');
    expect(result.map(v => v.name)).toEqual(['attn-1', 'attn-2', 'no-attn-1', 'no-attn-2']);
  });

  it('should sort by elapsed: longest running first', () => {
    const now = Date.now();
    const vms = [
      makeVM({ name: 'no-task', taskStartedAt: undefined }),
      makeVM({ name: 'recent', taskStartedAt: now - 10000 }),
      makeVM({ name: 'oldest', taskStartedAt: now - 60000 }),
    ];
    const result = sortVMs(vms, 'elapsed');
    expect(result.map(v => v.name)).toEqual(['oldest', 'recent', 'no-task']);
  });

  it('should handle empty array for any sort mode', () => {
    expect(sortVMs([], 'default')).toEqual([]);
    expect(sortVMs([], 'name')).toEqual([]);
    expect(sortVMs([], 'status')).toEqual([]);
    expect(sortVMs([], 'attention')).toEqual([]);
    expect(sortVMs([], 'elapsed')).toEqual([]);
  });

  it('should handle single VM', () => {
    const vms = [makeVM({ name: 'only' })];
    expect(sortVMs(vms, 'name')).toHaveLength(1);
    expect(sortVMs(vms, 'status')).toHaveLength(1);
  });
});
