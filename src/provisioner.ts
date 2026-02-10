import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PigsSettings } from './types.ts';
import { makeHooksConfig } from './notification-monitor.ts';

const SETTINGS_DIR = join(homedir(), '.pigs');
const SETTINGS_PATH = join(SETTINGS_DIR, 'settings.json');

const DEFAULT_CLAUDE_MD = `# Agent Instructions

You are a coding agent working in a git worktree. Follow the user's instructions carefully.
`;

/**
 * Load settings from ~/.pigs/settings.json, creating default if missing.
 */
export async function loadSettings(): Promise<PigsSettings> {
  try {
    const data = await readFile(SETTINGS_PATH, 'utf-8');
    return JSON.parse(data) as PigsSettings;
  } catch {
    const settings: PigsSettings = { claudeMd: DEFAULT_CLAUDE_MD };
    await mkdir(SETTINGS_DIR, { recursive: true });
    await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
    return settings;
  }
}

/**
 * Provision a worktree: write Claude Code settings/hooks config.
 *
 * For local worktrees, provisioning means writing the hooks config
 * so Claude Code creates a signal file when it finishes.
 */
export async function provisionBranch(
  worktreePath: string,
  settings?: PigsSettings,
  onLog?: (msg: string) => void,
): Promise<void> {
  const log = onLog ?? (() => {});

  log('Writing config files...');
  try {
    await writeConfigFiles(worktreePath, settings, log);
  } catch (err: any) {
    log(`Error writing config files: ${err?.message || err}`);
    throw err;
  }
}

/**
 * Re-provision a worktree: reload settings and update config files.
 */
export async function reprovisionBranch(
  worktreePath: string,
  onLog?: (msg: string) => void,
): Promise<void> {
  const log = onLog ?? (() => {});
  const settings = await loadSettings();

  log('Writing config files...');
  try {
    await writeConfigFiles(worktreePath, settings, log);
  } catch (err: any) {
    log(`Error writing config files: ${err?.message || err}`);
    throw err;
  }
}

/**
 * Write Claude Code config files to a worktree's .claude/ directory.
 */
async function writeConfigFiles(
  worktreePath: string,
  settings: PigsSettings | undefined,
  log: (msg: string) => void,
): Promise<void> {
  const resolvedSettings = settings ?? await loadSettings();

  // Write CLAUDE.md to the worktree root
  const claudeMdPath = join(worktreePath, 'CLAUDE.md');
  await writeFile(claudeMdPath, resolvedSettings.claudeMd, 'utf-8');
  log(`  ✓ CLAUDE.md`);

  // Write .claude/settings.json with hooks config
  const claudeDir = join(worktreePath, '.claude');
  await mkdir(claudeDir, { recursive: true });
  const hooksConfig = makeHooksConfig(worktreePath);
  const settingsPath = join(claudeDir, 'settings.json');
  await writeFile(settingsPath, JSON.stringify(hooksConfig, null, 2), 'utf-8');
  log(`  ✓ .claude/settings.json`);
}
