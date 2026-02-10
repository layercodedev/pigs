export interface Branch {
  name: string;
  worktreePath: string;
  status: 'active' | 'idle';
  createdAt: string;
  needsAttention: boolean;
  provisioningStatus?: 'pending' | 'provisioning' | 'done' | 'failed';
  displayLabel?: string;
  customLabel?: boolean;
  taskStartedAt?: number;
  pendingAction?: string;
  lastError?: string;
  devServerPort?: number;
}

// Backwards-compatible alias
export type VM = Branch;

export interface PigsSettings {
  claudeMd: string;
  copyFiles?: string[];
}

export type SortMode = 'default' | 'name' | 'status' | 'attention' | 'elapsed';

export interface AppState {
  vms: Branch[];
  activeVmIndex: number;
  sidebarSelectedIndex: number;
  mode: 'normal' | 'confirm-delete' | 'creating' | 'prompt' | 'broadcast' | 'help' | 'bulk-create' | 'confirm-delete-all' | 'confirm-reprovision-all' | 'search' | 'rename' | 'dashboard' | 'queue' | 'broadcast-queue' | 'queue-viewer' | 'ralph-iterations' | 'ralph-prompt' | 'pr-chain' | 'linear';
  searchFilter: string;
  sortMode: SortMode;
  settings: PigsSettings | null;
  rightPaneVmName: string | null;
  sidebarHidden: boolean;
  repoRoot: string;
}
