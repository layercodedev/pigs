export interface VM {
  name: string;
  id: string;
  status: 'cold' | 'running' | 'stopped';
  createdAt: string;
  needsAttention: boolean;
  provisioningStatus?: 'pending' | 'provisioning' | 'done' | 'failed';
  mountPath?: string;
  displayLabel?: string;
  customLabel?: boolean;
  taskStartedAt?: number;
  pendingAction?: string;
  lastError?: string;
}

export interface PigsSettings {
  claudeMd: string;
  openInVscode?: boolean;
}

export type SortMode = 'default' | 'name' | 'status' | 'attention' | 'elapsed';

export interface AppState {
  vms: VM[];
  activeVmIndex: number;
  sidebarSelectedIndex: number;
  mode: 'normal' | 'confirm-delete' | 'creating' | 'prompt' | 'broadcast' | 'help' | 'bulk-create' | 'confirm-delete-all' | 'confirm-reprovision-all' | 'search' | 'rename' | 'dashboard' | 'queue' | 'broadcast-queue' | 'queue-viewer' | 'ralph-iterations' | 'ralph-prompt' | 'pr-chain' | 'linear';
  searchFilter: string;
  sortMode: SortMode;
  settings: PigsSettings | null;
}
