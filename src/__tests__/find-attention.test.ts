import { describe, it, expect } from 'vitest';
import { findNextAttentionIndex } from '../tui.js';
import type { VM } from '../types.js';

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

describe('findNextAttentionIndex', () => {
  it('should return -1 for empty list', () => {
    expect(findNextAttentionIndex([], 0)).toBe(-1);
  });

  it('should return -1 when no VM needs attention', () => {
    const vms = [makeVM(), makeVM(), makeVM()];
    expect(findNextAttentionIndex(vms, 0)).toBe(-1);
  });

  it('should find the next attention VM after current index', () => {
    const vms = [
      makeVM(),
      makeVM({ needsAttention: true }),
      makeVM(),
    ];
    expect(findNextAttentionIndex(vms, 0)).toBe(1);
  });

  it('should wrap around to find attention VM before current index', () => {
    const vms = [
      makeVM({ needsAttention: true }),
      makeVM(),
      makeVM(),
    ];
    expect(findNextAttentionIndex(vms, 1)).toBe(0);
  });

  it('should find itself if it is the only attention VM and current is elsewhere', () => {
    const vms = [
      makeVM(),
      makeVM({ needsAttention: true }),
    ];
    expect(findNextAttentionIndex(vms, 0)).toBe(1);
  });

  it('should find the next attention VM when current VM also needs attention', () => {
    const vms = [
      makeVM({ needsAttention: true }),
      makeVM(),
      makeVM({ needsAttention: true }),
    ];
    // Starting at 0 (which needs attention), should find 2
    expect(findNextAttentionIndex(vms, 0)).toBe(2);
  });

  it('should wrap around back to self if only one VM needs attention', () => {
    const vms = [
      makeVM({ needsAttention: true }),
      makeVM(),
      makeVM(),
    ];
    // Starting at 0, wraps all the way around back to 0
    expect(findNextAttentionIndex(vms, 0)).toBe(0);
  });

  it('should cycle through multiple attention VMs in order', () => {
    const vms = [
      makeVM({ needsAttention: true }),
      makeVM({ needsAttention: true }),
      makeVM(),
      makeVM({ needsAttention: true }),
    ];
    // From index 0, next attention is 1
    expect(findNextAttentionIndex(vms, 0)).toBe(1);
    // From index 1, next attention is 3
    expect(findNextAttentionIndex(vms, 1)).toBe(3);
    // From index 3, wraps to 0
    expect(findNextAttentionIndex(vms, 3)).toBe(0);
  });

  it('should handle single VM needing attention', () => {
    const vms = [makeVM({ needsAttention: true })];
    expect(findNextAttentionIndex(vms, 0)).toBe(0);
  });

  it('should handle single VM not needing attention', () => {
    const vms = [makeVM()];
    expect(findNextAttentionIndex(vms, 0)).toBe(-1);
  });
});
