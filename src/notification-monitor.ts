import { execSync, spawn } from 'node:child_process';
import type { Branch } from './types.ts';
import type { ChildProcess } from 'node:child_process';

const LABEL_POLL_INTERVAL_MS = 10000;

/**
 * Get a unique channel name for a specific worktree, used with `tmux wait-for`.
 */
function getChannelName(worktreePath: string): string {
  try {
    const hash = execSync(`printf '%s' '${worktreePath.replace(/'/g, "'\\''")}' | md5sum 2>/dev/null | cut -c1-8 || printf '%s' '${worktreePath.replace(/'/g, "'\\''")}' | md5 -q 2>/dev/null | cut -c1-8`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    return `pigs-done-${hash}`;
  } catch {
    return `pigs-done-${worktreePath.replace(/[^a-zA-Z0-9]/g, '-')}`;
  }
}

/**
 * Build a Stop hook command that signals completion via tmux wait-for.
 */
export function makeStopHookCommand(worktreePath: string): string {
  const channel = getChannelName(worktreePath);
  return `tmux wait-for -S '${channel.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the Claude Code hooks configuration for a specific worktree.
 */
export function makeHooksConfig(worktreePath: string) {
  return {
    permissions: {
      defaultMode: 'bypassPermissions',
    },
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: 'command' as const,
              command: makeStopHookCommand(worktreePath),
            },
          ],
        },
      ],
    },
  };
}

// Legacy export for compatibility with tests
export const CLAUDE_HOOKS_CONFIG = {
  permissions: {
    defaultMode: 'bypassPermissions',
  },
  hooks: {
    Stop: [
      {
        hooks: [
          {
            type: 'command' as const,
            command: 'tmux wait-for -S pigs-done-signal',
          },
        ],
      },
    ],
  },
};

let labelPollTimer: ReturnType<typeof setInterval> | null = null;
const waitProcesses = new Map<string, ChildProcess>();
let monitorActive = false;

/**
 * Start a tmux wait-for listener for a single branch.
 * When the channel is signaled, sets needsAttention and re-registers the listener.
 */
function waitForBranch(
  branch: Branch,
  onChange: () => void,
): void {
  if (!monitorActive) return;
  if (branch.provisioningStatus !== 'done') return;

  const channel = getChannelName(branch.worktreePath);

  // Kill any existing wait process for this branch
  const existing = waitProcesses.get(branch.name);
  if (existing) {
    existing.kill();
    waitProcesses.delete(branch.name);
  }

  const proc = spawn('tmux', ['wait-for', channel], { stdio: 'ignore' });
  waitProcesses.set(branch.name, proc);

  proc.on('close', (code) => {
    waitProcesses.delete(branch.name);
    if (!monitorActive) return;

    // code 0 means the channel was signaled (agent finished)
    if (code === 0 && !branch.needsAttention) {
      branch.needsAttention = true;
      branch.taskStartedAt = undefined;
      onChange();
    }

    // Re-register the listener for the next signal
    if (monitorActive && branch.provisioningStatus === 'done') {
      waitForBranch(branch, onChange);
    }
  });
}

/**
 * Start monitoring branches for completion via tmux wait-for channels.
 * Also starts a slow poll for git label updates.
 */
export function startMonitor(
  branches: Branch[],
  onChange: () => void,
): void {
  if (monitorActive) return;
  monitorActive = true;

  // Start wait-for listeners for all provisioned branches
  for (const branch of branches) {
    if (branch.provisioningStatus === 'done') {
      waitForBranch(branch, onChange);
    }
  }

  // Slow poll for git label updates only
  labelPollTimer = setInterval(() => {
    pollLabels(branches, onChange);
  }, LABEL_POLL_INTERVAL_MS);
}

/**
 * Stop the monitor and kill all wait-for processes.
 */
export function stopMonitor(): void {
  monitorActive = false;

  if (labelPollTimer) {
    clearInterval(labelPollTimer);
    labelPollTimer = null;
  }

  // Kill all wait-for processes
  for (const [name, proc] of waitProcesses) {
    proc.kill();
    waitProcesses.delete(name);
  }
}

/**
 * Register a wait-for listener for a newly provisioned branch.
 * Call this after a branch is provisioned to start monitoring it.
 */
export function registerBranch(branch: Branch, onChange: () => void): void {
  if (!monitorActive) return;
  waitForBranch(branch, onChange);
}

/**
 * Poll all provisioned branches for git label updates only.
 */
function pollLabels(
  branches: Branch[],
  onChange: () => void,
): void {
  const candidates = branches.filter(
    (b) => b.provisioningStatus === 'done',
  );

  for (const branch of candidates) {
    try {
      const labelChanged = checkGitLabel(branch);
      if (labelChanged) {
        onChange();
      }
    } catch {
      // Ignore git check errors
    }
  }
}

/**
 * Clear the attention flag for a branch.
 */
export function clearAttention(branch: Branch): void {
  branch.needsAttention = false;
}

/**
 * Return the default display label for a branch.
 */
export function defaultLabel(branchName: string): string {
  return branchName;
}

/**
 * Check a branch for git repo info and update displayLabel if changed.
 * Returns true if the label changed.
 */
function checkGitLabel(branch: Branch): boolean {
  if (branch.customLabel) return false;

  let newLabel: string;
  try {
    const branchName = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: branch.worktreePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    newLabel = branchName || branch.name;
  } catch {
    newLabel = branch.name;
  }

  if (branch.displayLabel !== newLabel) {
    branch.displayLabel = newLabel;
    return true;
  }
  return false;
}

// Expose for testing
export { pollLabels as _pollLabels, checkGitLabel as _checkGitLabel, getChannelName as _getChannelName, LABEL_POLL_INTERVAL_MS };
