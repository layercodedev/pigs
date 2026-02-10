import { existsSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import type { Branch } from './types.ts';

const SIGNAL_FILE = '/tmp/claude-done-signal';
const POLL_INTERVAL_MS = 5000;

/**
 * Get the signal file path for a specific worktree.
 */
function getSignalPath(worktreePath: string): string {
  try {
    const hash = execSync(`printf '%s' '${worktreePath.replace(/'/g, "'\\''")}' | md5sum 2>/dev/null | cut -c1-8 || printf '%s' '${worktreePath.replace(/'/g, "'\\''")}' | md5 -q 2>/dev/null | cut -c1-8`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    return `/tmp/claude-done-signal-${hash}`;
  } catch {
    return `/tmp/claude-done-signal-${worktreePath.replace(/[^a-zA-Z0-9]/g, '-')}`;
  }
}

/**
 * Build a Stop hook command for a specific worktree.
 */
export function makeStopHookCommand(worktreePath: string): string {
  const signalPath = getSignalPath(worktreePath);
  return `touch '${signalPath.replace(/'/g, "'\\''")}'`;
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
            command: `touch ${SIGNAL_FILE}`,
          },
        ],
      },
    ],
  },
};

let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start polling branches for the done-signal file.
 * When found, sets `needsAttention = true` on the branch and removes the signal.
 */
export function startMonitor(
  branches: Branch[],
  onChange: () => void,
): void {
  if (pollTimer) return;

  pollTimer = setInterval(() => {
    pollAll(branches, onChange);
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
 * Check all provisioned branches for the done-signal file and git repo info.
 */
async function pollAll(
  branches: Branch[],
  onChange: () => void,
): Promise<void> {
  const candidates = branches.filter(
    (b) => b.provisioningStatus === 'done',
  );

  for (const branch of candidates) {
    let changed = false;
    try {
      if (!branch.needsAttention) {
        checkSignal(branch);
        if (branch.needsAttention) {
          changed = true;
        }
      }
    } catch {
      // Ignore poll errors
    }
    try {
      const labelChanged = checkGitLabel(branch);
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
 * Check a single branch for the signal file and consume it.
 */
function checkSignal(branch: Branch): void {
  const signalPath = getSignalPath(branch.worktreePath);
  if (existsSync(signalPath)) {
    branch.needsAttention = true;
    branch.taskStartedAt = undefined;
    try {
      unlinkSync(signalPath);
    } catch {
      // Ignore
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
export { pollAll as _pollAll, checkSignal as _checkSignal, checkGitLabel as _checkGitLabel, getSignalPath as _getSignalPath, SIGNAL_FILE, POLL_INTERVAL_MS };
