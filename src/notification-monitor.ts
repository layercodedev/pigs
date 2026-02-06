import type { SpritesClient } from '@fly/sprites';
import type { VM } from './types.js';

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
 * Check all running, provisioned VMs for the done-signal file.
 */
async function pollAll(
  client: SpritesClient,
  vms: VM[],
  onChange: () => void,
): Promise<void> {
  const candidates = vms.filter(
    (vm) => vm.provisioningStatus === 'done' && !vm.needsAttention,
  );

  for (const vm of candidates) {
    try {
      await checkSignal(client, vm);
      if (vm.needsAttention) {
        onChange();
      }
    } catch {
      // Ignore poll errors (VM may be cold/stopped)
    }
  }
}

/**
 * Check a single VM for the signal file and consume it.
 */
async function checkSignal(client: SpritesClient, vm: VM): Promise<void> {
  const sprite = client.sprite(vm.name);
  const { stdout } = await sprite.exec(`test -f ${SIGNAL_FILE} && echo FOUND && rm -f ${SIGNAL_FILE} || true`);
  if (String(stdout).trim() === 'FOUND') {
    vm.needsAttention = true;
  }
}

/**
 * Clear the attention flag for a VM (e.g. when user activates it).
 */
export function clearAttention(vm: VM): void {
  vm.needsAttention = false;
}

// Expose for testing
export { pollAll as _pollAll, checkSignal as _checkSignal, SIGNAL_FILE, POLL_INTERVAL_MS };
