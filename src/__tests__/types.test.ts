import { describe, it, expect } from 'vitest';
import type { VM, AppState } from '../types.js';

describe('types', () => {
  it('should create a valid VM object', () => {
    const vm: VM = {
      name: 'pigs-test',
      id: '123',
      status: 'running',
      createdAt: new Date().toISOString(),
      needsAttention: false,
    };
    expect(vm.name).toBe('pigs-test');
    expect(vm.status).toBe('running');
    expect(vm.needsAttention).toBe(false);
  });

  it('should create a valid AppState', () => {
    const state: AppState = {
      vms: [],
      activeVmIndex: -1,
      sidebarSelectedIndex: 0,
      mode: 'normal',
    };
    expect(state.vms).toHaveLength(0);
    expect(state.activeVmIndex).toBe(-1);
    expect(state.mode).toBe('normal');
  });
});
