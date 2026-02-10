import { describe, it, expect } from 'bun:test';
import type { VM, AppState, PigsSettings, SortMode } from '../types.ts';

describe('types', () => {
  it('should create a valid VM object', () => {
    const vm: VM = {
      name: 'pigs-test',
      worktreePath: '/tmp/worktrees/pigs-test',
      status: 'active',
      createdAt: new Date().toISOString(),
      needsAttention: false,
    };
    expect(vm.name).toBe('pigs-test');
    expect(vm.status).toBe('active');
    expect(vm.needsAttention).toBe(false);
  });

  it('should create a valid AppState', () => {
    const state: AppState = {
      vms: [],
      activeVmIndex: -1,
      sidebarSelectedIndex: 0,
      mode: 'normal',
      settings: null,
      searchFilter: '',
      sortMode: 'default',
      rightPaneVmName: null,
      sidebarHidden: false,
      repoRoot: '/tmp/repo',
    };
    expect(state.vms).toHaveLength(0);
    expect(state.activeVmIndex).toBe(-1);
    expect(state.mode).toBe('normal');
    expect(state.settings).toBeNull();
    expect(state.searchFilter).toBe('');
    expect(state.sortMode).toBe('default');
  });

  it('should allow AppState with loaded settings', () => {
    const state: AppState = {
      vms: [],
      activeVmIndex: -1,
      sidebarSelectedIndex: 0,
      mode: 'normal',
      settings: { claudeMd: '# My instructions' },
      searchFilter: '',
      sortMode: 'default',
      rightPaneVmName: null,
      sidebarHidden: false,
      repoRoot: '/tmp/repo',
    };
    expect(state.settings).not.toBeNull();
    expect(state.settings!.claudeMd).toBe('# My instructions');
  });

  it('should support provisioningStatus on VM', () => {
    const vm: VM = {
      name: 'pigs-prov',
      worktreePath: '/tmp/worktrees/pigs-prov',
      status: 'active',
      createdAt: new Date().toISOString(),
      needsAttention: false,
      provisioningStatus: 'provisioning',
    };
    expect(vm.provisioningStatus).toBe('provisioning');
  });

  it('should allow provisioningStatus to be undefined', () => {
    const vm: VM = {
      name: 'pigs-noprov',
      worktreePath: '/tmp/worktrees/pigs-noprov',
      status: 'idle',
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

  it('should support copyFiles in PigsSettings', () => {
    const settings: PigsSettings = {
      claudeMd: '# Instructions',
      copyFiles: ['file1.txt', 'file2.txt'],
    };
    expect(settings.copyFiles).toEqual(['file1.txt', 'file2.txt']);
  });

  it('should allow copyFiles to be undefined', () => {
    const settings: PigsSettings = {
      claudeMd: '# Instructions',
    };
    expect(settings.copyFiles).toBeUndefined();
  });

  it('should support displayLabel on VM', () => {
    const vm: VM = {
      name: 'pigs-abc123',
      worktreePath: '/tmp/worktrees/pigs-abc123',
      status: 'active',
      createdAt: new Date().toISOString(),
      needsAttention: false,
      displayLabel: 'myproject:main',
    };
    expect(vm.displayLabel).toBe('myproject:main');
  });

  it('should allow displayLabel to be undefined', () => {
    const vm: VM = {
      name: 'pigs-abc123',
      worktreePath: '/tmp/worktrees/pigs-abc123',
      status: 'active',
      createdAt: new Date().toISOString(),
      needsAttention: false,
    };
    expect(vm.displayLabel).toBeUndefined();
  });

  it('should support prompt mode in AppState', () => {
    const state: AppState = {
      vms: [],
      activeVmIndex: -1,
      sidebarSelectedIndex: 0,
      mode: 'prompt',
      settings: null,
      searchFilter: '',
      sortMode: 'default',
      rightPaneVmName: null,
      sidebarHidden: false,
      repoRoot: '/tmp/repo',
    };
    expect(state.mode).toBe('prompt');
  });

  it('should support broadcast mode in AppState', () => {
    const state: AppState = {
      vms: [],
      activeVmIndex: -1,
      sidebarSelectedIndex: 0,
      mode: 'broadcast',
      settings: null,
      searchFilter: '',
      sortMode: 'default',
      rightPaneVmName: null,
      sidebarHidden: false,
      repoRoot: '/tmp/repo',
    };
    expect(state.mode).toBe('broadcast');
  });

  it('should support help mode in AppState', () => {
    const state: AppState = {
      vms: [],
      activeVmIndex: -1,
      sidebarSelectedIndex: 0,
      mode: 'help',
      settings: null,
      searchFilter: '',
      sortMode: 'default',
      rightPaneVmName: null,
      sidebarHidden: false,
      repoRoot: '/tmp/repo',
    };
    expect(state.mode).toBe('help');
  });

  it('should support bulk-create mode in AppState', () => {
    const state: AppState = {
      vms: [],
      activeVmIndex: -1,
      sidebarSelectedIndex: 0,
      mode: 'bulk-create',
      settings: null,
      searchFilter: '',
      sortMode: 'default',
      rightPaneVmName: null,
      sidebarHidden: false,
      repoRoot: '/tmp/repo',
    };
    expect(state.mode).toBe('bulk-create');
  });

  it('should support confirm-delete-all mode in AppState', () => {
    const state: AppState = {
      vms: [],
      activeVmIndex: -1,
      sidebarSelectedIndex: 0,
      mode: 'confirm-delete-all',
      settings: null,
      searchFilter: '',
      sortMode: 'default',
      rightPaneVmName: null,
      sidebarHidden: false,
      repoRoot: '/tmp/repo',
    };
    expect(state.mode).toBe('confirm-delete-all');
  });

  it('should support confirm-reprovision-all mode in AppState', () => {
    const state: AppState = {
      vms: [],
      activeVmIndex: -1,
      sidebarSelectedIndex: 0,
      mode: 'confirm-reprovision-all',
      settings: null,
      searchFilter: '',
      sortMode: 'default',
      rightPaneVmName: null,
      sidebarHidden: false,
      repoRoot: '/tmp/repo',
    };
    expect(state.mode).toBe('confirm-reprovision-all');
  });

  it('should support rename mode in AppState', () => {
    const state: AppState = {
      vms: [],
      activeVmIndex: -1,
      sidebarSelectedIndex: 0,
      mode: 'rename',
      settings: null,
      searchFilter: '',
      sortMode: 'default',
      rightPaneVmName: null,
      sidebarHidden: false,
      repoRoot: '/tmp/repo',
    };
    expect(state.mode).toBe('rename');
  });

  it('should support customLabel on VM', () => {
    const vm: VM = {
      name: 'pigs-abc123',
      worktreePath: '/tmp/worktrees/pigs-abc123',
      status: 'active',
      createdAt: new Date().toISOString(),
      needsAttention: false,
      displayLabel: 'my-custom-label',
      customLabel: true,
    };
    expect(vm.customLabel).toBe(true);
    expect(vm.displayLabel).toBe('my-custom-label');
  });

  it('should allow customLabel to be undefined', () => {
    const vm: VM = {
      name: 'pigs-abc123',
      worktreePath: '/tmp/worktrees/pigs-abc123',
      status: 'active',
      createdAt: new Date().toISOString(),
      needsAttention: false,
    };
    expect(vm.customLabel).toBeUndefined();
  });

  it('should support taskStartedAt on VM', () => {
    const now = Date.now();
    const vm: VM = {
      name: 'pigs-abc123',
      worktreePath: '/tmp/worktrees/pigs-abc123',
      status: 'active',
      createdAt: new Date().toISOString(),
      needsAttention: false,
      taskStartedAt: now,
    };
    expect(vm.taskStartedAt).toBe(now);
  });

  it('should allow taskStartedAt to be undefined', () => {
    const vm: VM = {
      name: 'pigs-abc123',
      worktreePath: '/tmp/worktrees/pigs-abc123',
      status: 'active',
      createdAt: new Date().toISOString(),
      needsAttention: false,
    };
    expect(vm.taskStartedAt).toBeUndefined();
  });

  it('should support search mode in AppState', () => {
    const state: AppState = {
      vms: [],
      activeVmIndex: -1,
      sidebarSelectedIndex: 0,
      mode: 'search',
      settings: null,
      searchFilter: 'myproject',
      sortMode: 'default',
      rightPaneVmName: null,
      sidebarHidden: false,
      repoRoot: '/tmp/repo',
    };
    expect(state.mode).toBe('search');
    expect(state.searchFilter).toBe('myproject');
  });

  it('should support dashboard mode in AppState', () => {
    const state: AppState = {
      vms: [],
      activeVmIndex: -1,
      sidebarSelectedIndex: 0,
      mode: 'dashboard',
      settings: null,
      searchFilter: '',
      sortMode: 'default',
      rightPaneVmName: null,
      sidebarHidden: false,
      repoRoot: '/tmp/repo',
    };
    expect(state.mode).toBe('dashboard');
  });

  it('should support sortMode on AppState', () => {
    const modes: SortMode[] = ['default', 'name', 'status', 'attention', 'elapsed'];
    for (const sortMode of modes) {
      const state: AppState = {
        vms: [],
        activeVmIndex: -1,
        sidebarSelectedIndex: 0,
        mode: 'normal',
        settings: null,
        searchFilter: '',
        sortMode,
        rightPaneVmName: null,
        sidebarHidden: false,
        repoRoot: '/tmp/repo',
      };
      expect(state.sortMode).toBe(sortMode);
    }
  });

  it('should support queue mode in AppState', () => {
    const state: AppState = {
      vms: [],
      activeVmIndex: -1,
      sidebarSelectedIndex: 0,
      mode: 'queue',
      settings: null,
      searchFilter: '',
      sortMode: 'default',
      rightPaneVmName: null,
      sidebarHidden: false,
      repoRoot: '/tmp/repo',
    };
    expect(state.mode).toBe('queue');
  });

  it('should support broadcast-queue mode in AppState', () => {
    const state: AppState = {
      vms: [],
      activeVmIndex: -1,
      sidebarSelectedIndex: 0,
      mode: 'broadcast-queue',
      settings: null,
      searchFilter: '',
      sortMode: 'default',
      rightPaneVmName: null,
      sidebarHidden: false,
      repoRoot: '/tmp/repo',
    };
    expect(state.mode).toBe('broadcast-queue');
  });

  it('should support queue-viewer mode in AppState', () => {
    const state: AppState = {
      vms: [],
      activeVmIndex: -1,
      sidebarSelectedIndex: 0,
      mode: 'queue-viewer',
      settings: null,
      searchFilter: '',
      sortMode: 'default',
      rightPaneVmName: null,
      sidebarHidden: false,
      repoRoot: '/tmp/repo',
    };
    expect(state.mode).toBe('queue-viewer');
  });
});
