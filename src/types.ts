export interface VM {
  name: string;
  id: string;
  status: 'cold' | 'running' | 'stopped';
  createdAt: string;
  needsAttention: boolean;
  provisioningStatus?: 'pending' | 'provisioning' | 'done' | 'failed';
  mountPath?: string;
  displayLabel?: string;
}

export interface PigsSettings {
  claudeMd: string;
  openInVscode?: boolean;
}

export interface AppState {
  vms: VM[];
  activeVmIndex: number;
  sidebarSelectedIndex: number;
  mode: 'normal' | 'confirm-delete' | 'creating' | 'console' | 'prompt' | 'broadcast' | 'help' | 'bulk-create' | 'confirm-delete-all';
  settings: PigsSettings | null;
}
