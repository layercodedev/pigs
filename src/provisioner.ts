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
 * Provision a worktree: merge pigs hooks into the existing .claude/settings.json.
 *
 * The .claude directory (commands, rules, skills, settings) is already copied
 * from the source repo by copyConfigFiles. This function merges in the pigs-specific
 * hooks (Stop hook for completion detection) and bypassPermissions mode.
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
 * Merge pigs hooks config into .claude/settings.json, preserving existing settings.
 */
async function writeConfigFiles(
  worktreePath: string,
  _settings: PigsSettings | undefined,
  log: (msg: string) => void,
): Promise<void> {
  const claudeDir = join(worktreePath, '.claude');
  await mkdir(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, 'settings.json');

  // Read existing settings.json (may have been copied from source repo)
  let existing: Record<string, any> = {};
  try {
    const data = await readFile(settingsPath, 'utf-8');
    existing = JSON.parse(data);
  } catch {
    // No existing file or invalid JSON, start fresh
  }

  // Merge pigs hooks into existing config
  const pigsConfig = makeHooksConfig(worktreePath);

  // Merge Stop hook (append pigs stop hook, preserve other hook types)
  existing.hooks = existing.hooks ?? {};
  existing.hooks.Stop = [
    ...(existing.hooks.Stop ?? []),
    ...pigsConfig.hooks.Stop,
  ];

  await writeFile(settingsPath, JSON.stringify(existing, null, 2), 'utf-8');
  log(`  ✓ .claude/settings.json (merged)`);
}
