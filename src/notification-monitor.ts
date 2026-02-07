import type { SpritesClient } from '@fly/sprites';
import type { VM } from './types.ts';
import { shellExec } from './shell-exec.ts';

const SIGNAL_FILE = '/tmp/claude-done-signal';
const POLL_INTERVAL_MS = 5000;

/**
 * The shell command installed as a Claude Code Stop hook on each VM.
 * When Claude finishes responding, this creates a signal file.
 */
export const STOP_HOOK_COMMAND = `touch ${SIGNAL_FILE}`;

/**
 * The Claude Code hooks configuration written to the VM's
 * ~/.claude/settings.json to fire a Stop hook when Claude finishes.
 */
export const CLAUDE_HOOKS_CONFIG = {
  hooks: {
    Stop: [
      {
        hooks: [
          {
            type: 'command' as const,
            command: STOP_HOOK_COMMAND,
          },
        ],
      },
    ],
  },
};

let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start polling VMs for the done-signal file.
 * When found, sets `needsAttention = true` on the VM and removes the signal.
 *
 * @param client  Sprites API client
 * @param vms     Live reference to the VM array (mutated in place)
 * @param onChange Called whenever a VM's needsAttention flag changes
 */
export function startMonitor(
  client: SpritesClient,
  vms: VM[],
  onChange: () => void,
): void {
  if (pollTimer) return; // already running

  pollTimer = setInterval(() => {
    pollAll(client, vms, onChange);
  }, POLL_INTERVAL_MS);
}

/**
 * Stop the polling monitor.
 */
export function stopMonitor(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Check all running, provisioned VMs for the done-signal file and git repo info.
 */
async function pollAll(
  client: SpritesClient,
  vms: VM[],
  onChange: () => void,
): Promise<void> {
  const candidates = vms.filter(
    (vm) => vm.provisioningStatus === 'done',
  );

  for (const vm of candidates) {
    let changed = false;
    try {
      if (!vm.needsAttention) {
        await checkSignal(client, vm);
        if (vm.needsAttention) {
          changed = true;
        }
      }
    } catch {
      // Ignore poll errors (VM may be cold/stopped)
    }
    try {
      const labelChanged = await checkGitLabel(client, vm);
      if (labelChanged) {
        changed = true;
      }
    } catch {
      // Ignore git check errors
    }
    if (changed) {
      onChange();
    }
  }
}

/**
 * Check a single VM for the signal file and consume it.
 */
async function checkSignal(client: SpritesClient, vm: VM): Promise<void> {
  const sprite = client.sprite(vm.name);
  const { stdout } = await shellExec(sprite, `test -f ${SIGNAL_FILE} && echo FOUND && rm -f ${SIGNAL_FILE} || true`);
  if (String(stdout).trim() === 'FOUND') {
    vm.needsAttention = true;
    vm.taskStartedAt = undefined;
  }
}

/**
 * Clear the attention flag for a VM (e.g. when user activates it).
 */
export function clearAttention(vm: VM): void {
  vm.needsAttention = false;
}

/**
 * Return the default display label for a VM: last 6 chars of the VM name.
 */
export function defaultLabel(vmName: string): string {
  return vmName.slice(-6);
}

/**
 * Check a VM for a git repo and update displayLabel to "dirname:branch" if found.
 * Falls back to the last 6 chars of the VM name when not in a git repo.
 * Returns true if the label changed.
 */
async function checkGitLabel(client: SpritesClient, vm: VM): Promise<boolean> {
  // Skip VMs with user-set custom labels
  if (vm.customLabel) return false;

  const sprite = client.sprite(vm.name);
  const { stdout } = await shellExec(sprite,
    'cd /root && git rev-parse --show-toplevel --abbrev-ref HEAD 2>/dev/null || true',
  );
  const lines = String(stdout).trim().split('\n').filter(Boolean);
  let newLabel: string;
  if (lines.length === 2) {
    const dirName = lines[0].split('/').pop() || lines[0];
    const branch = lines[1];
    newLabel = `${dirName}:${branch}`;
  } else {
    newLabel = defaultLabel(vm.name);
  }
  if (vm.displayLabel !== newLabel) {
    vm.displayLabel = newLabel;
    return true;
  }
  return false;
}

// Expose for testing
export { pollAll as _pollAll, checkSignal as _checkSignal, checkGitLabel as _checkGitLabel, SIGNAL_FILE, POLL_INTERVAL_MS };
