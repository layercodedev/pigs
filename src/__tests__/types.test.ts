import { describe, it, expect } from 'vitest';
import type { VM, AppState, PigsSettings } from '../types.js';

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
      settings: null,
    };
    expect(state.vms).toHaveLength(0);
    expect(state.activeVmIndex).toBe(-1);
    expect(state.mode).toBe('normal');
    expect(state.settings).toBeNull();
  });

  it('should allow AppState with loaded settings', () => {
    const state: AppState = {
      vms: [],
      activeVmIndex: -1,
      sidebarSelectedIndex: 0,
      mode: 'normal',
      settings: { claudeMd: '# My instructions' },
    };
    expect(state.settings).not.toBeNull();
    expect(state.settings!.claudeMd).toBe('# My instructions');
  });

  it('should support provisioningStatus on VM', () => {
    const vm: VM = {
      name: 'pigs-prov',
      id: '456',
      status: 'running',
      createdAt: new Date().toISOString(),
      needsAttention: false,
      provisioningStatus: 'provisioning',
    };
    expect(vm.provisioningStatus).toBe('provisioning');
  });

  it('should allow provisioningStatus to be undefined', () => {
    const vm: VM = {
      name: 'pigs-noprov',
      id: '789',
      status: 'cold',
      createdAt: new Date().toISOString(),
      needsAttention: false,
    };
    expect(vm.provisioningStatus).toBeUndefined();
  });

  it('should create a valid PigsSettings', () => {
    const settings: PigsSettings = {
      claudeMd: '# Instructions',
    };
    expect(settings.claudeMd).toBe('# Instructions');
  });

  it('should support openInVscode in PigsSettings', () => {
    const settings: PigsSettings = {
      claudeMd: '# Instructions',
      openInVscode: true,
    };
    expect(settings.openInVscode).toBe(true);
  });

  it('should allow openInVscode to be undefined', () => {
    const settings: PigsSettings = {
      claudeMd: '# Instructions',
    };
    expect(settings.openInVscode).toBeUndefined();
  });
});
