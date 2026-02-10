import { execSync } from 'node:child_process';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import type { Branch, PigsSettings } from './types.ts';

/**
 * Get the root directory of the current git repository.
 */
export function getRepoRoot(): string {
  return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
}

/**
 * Get the folder name of the repo (used in labels).
 */
export function getRepoName(): string {
  return basename(getRepoRoot());
}

/**
 * List all git worktrees and return them as Branch objects.
 * Excludes the main worktree (the repo root).
 */
export function listBranches(repoRoot: string): Branch[] {
  const output = execSync('git worktree list --porcelain', {
    encoding: 'utf-8',
    cwd: repoRoot,
  });

  const branches: Branch[] = [];
  const entries = output.trim().split('\n\n').filter(Boolean);

  for (const entry of entries) {
    const lines = entry.split('\n');
    const worktreeLine = lines.find(l => l.startsWith('worktree '));
    const branchLine = lines.find(l => l.startsWith('branch '));
    const bareLine = lines.find(l => l === 'bare');

    if (!worktreeLine || bareLine) continue;

    const worktreePath = worktreeLine.replace('worktree ', '');

    // Skip the main worktree
    if (worktreePath === repoRoot) continue;

    const branchName = branchLine
      ? branchLine.replace('branch refs/heads/', '')
      : basename(worktreePath);

    branches.push({
      name: branchName,
      worktreePath,
      status: 'idle',
      createdAt: new Date().toISOString(),
      needsAttention: false,
      provisioningStatus: 'done',
      displayLabel: branchName,
    });
  }

  return branches;
}

/**
 * Create a new git worktree with a feature branch.
 * The worktree is created in a .worktrees/ directory next to the repo root.
 */
export function createBranch(repoRoot: string, branchName: string, settings?: PigsSettings): Branch {
  const worktreesDir = join(dirname(repoRoot), '.worktrees', basename(repoRoot));
  mkdirSync(worktreesDir, { recursive: true });

  const worktreePath = join(worktreesDir, branchName);

  // Create the worktree with a new branch
  execSync(`git worktree add -b ${shellEscape(branchName)} ${shellEscape(worktreePath)}`, {
    cwd: repoRoot,
    stdio: 'pipe',
  });

  // Copy config files that the app needs
  copyConfigFiles(repoRoot, worktreePath, settings);

  return {
    name: branchName,
    worktreePath,
    status: 'idle',
    createdAt: new Date().toISOString(),
    needsAttention: false,
    provisioningStatus: 'done',
    displayLabel: branchName,
  };
}

/**
 * Copy config files (like .dev.vars) from the main repo to a worktree.
 */
export function copyConfigFiles(repoRoot: string, worktreePath: string, settings?: PigsSettings): void {
  const filesToCopy = [
    '.dev.vars',
    '.env',
    '.env.local',
    ...(settings?.copyFiles ?? []),
  ];

  for (const file of filesToCopy) {
    const src = join(repoRoot, file);
    const dest = join(worktreePath, file);
    if (existsSync(src)) {
      // Ensure destination directory exists
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
  }
}

/**
 * Delete a git worktree and its branch.
 */
export function deleteBranch(repoRoot: string, branchName: string, worktreePath: string): void {
  // Remove the worktree
  try {
    execSync(`git worktree remove --force ${shellEscape(worktreePath)}`, {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  } catch {
    // If worktree remove fails, try manual cleanup
    execSync(`rm -rf ${shellEscape(worktreePath)}`, { stdio: 'pipe' });
    execSync('git worktree prune', { cwd: repoRoot, stdio: 'pipe' });
  }

  // Delete the branch (force in case it has unmerged changes)
  try {
    execSync(`git branch -D ${shellEscape(branchName)}`, {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  } catch {
    // Branch may already be deleted or may be checked out elsewhere
  }
}

/**
 * Generate a branch name for a new feature.
 */
export function generateBranchName(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `feature-${suffix}`;
}

/**
 * Run a shell command in a worktree directory and return stdout.
 */
export function execInWorktree(worktreePath: string, command: string): string {
  return execSync(command, {
    cwd: worktreePath,
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();
}

/**
 * Escape a string for safe use in shell commands.
 */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
