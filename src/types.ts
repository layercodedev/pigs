export interface VM {
  name: string;
  id: string;
  status: 'cold' | 'running' | 'stopped';
  createdAt: string;
  needsAttention: boolean;
  provisioningStatus?: 'pending' | 'provisioning' | 'done' | 'failed';
  mountPath?: string;
}

export interface PigsSettings {
  claudeMd: string;
}

export interface AppState {
  vms: VM[];
  activeVmIndex: number;
  sidebarSelectedIndex: number;
  mode: 'normal' | 'confirm-delete' | 'creating' | 'console';
  settings: PigsSettings | null;
}
