import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SpritesClient } from '@fly/sprites';
import type { PigsSettings } from './types.ts';
import { CLAUDE_HOOKS_CONFIG } from './notification-monitor.ts';

const SETTINGS_DIR = join(homedir(), '.pigs');
const SETTINGS_PATH = join(SETTINGS_DIR, 'settings.json');
const CLAUDE_CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');

import { shellExec } from './shell-exec.ts';

const DEFAULT_CLAUDE_MD = `# Agent Instructions

You are a coding agent running on a remote VM. Follow the user's instructions carefully.
`;

const PROVISION_SCRIPT = [
  'set -e',
  // Install Claude Code globally via npm (needs sudo for global install)
  'if ! command -v claude &>/dev/null; then sudo npm install -g @anthropic-ai/claude-code; fi',
  // Ensure SSH server is installed and running
  'if ! command -v sshd &>/dev/null || ! command -v tmux &>/dev/null; then sudo apt-get update -qq && sudo apt-get install -y -qq openssh-server tmux; fi',
  'if ! pgrep -x sshd &>/dev/null; then sudo mkdir -p /run/sshd && sudo /usr/sbin/sshd; fi',
].join('\n');

/**
 * Load settings from ~/.pigs/settings.json, creating default if missing.
 */
export async function loadSettings(): Promise<PigsSettings> {
  try {
    const data = await readFile(SETTINGS_PATH, 'utf-8');
    return JSON.parse(data) as PigsSettings;
  } catch {
    const settings: PigsSettings = { claudeMd: DEFAULT_CLAUDE_MD, openInVscode: true };
    await mkdir(SETTINGS_DIR, { recursive: true });
    await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
    return settings;
  }
}

/**
 * Provision a VM: install Claude Code + SSH, write CLAUDE.md.
 *
 * Runs commands via sprite.exec() (non-TTY, promise-based).
 * Throws on provisioning failure.
 */
export async function provisionVM(
  client: SpritesClient,
  vmName: string,
  settings?: PigsSettings,
  onLog?: (msg: string) => void,
): Promise<void> {
  const sprite = client.sprite(vmName);
  const log = onLog ?? (() => {});

  // Step 1: Install Claude Code + SSH
  log('Installing Claude Code and SSH...');
  await shellExec(sprite, PROVISION_SCRIPT);
  log('Claude Code and SSH installed.');

  // Step 2: Write CLAUDE.md from settings using base64 to avoid escaping issues
  log('Writing CLAUDE.md...');
  const resolvedSettings = settings ?? await loadSettings();
  const b64 = Buffer.from(resolvedSettings.claudeMd).toString('base64');
  await shellExec(sprite, `echo '${b64}' | base64 -d | sudo tee /root/CLAUDE.md > /dev/null`);
  log('CLAUDE.md written.');

  // Step 3: Install Claude Code Stop hook for finish notifications
  log('Installing notification hook...');
  const hooksJson = JSON.stringify(CLAUDE_HOOKS_CONFIG);
  const hooksB64 = Buffer.from(hooksJson).toString('base64');
  await shellExec(sprite, `sudo mkdir -p /root/.claude && echo '${hooksB64}' | base64 -d | sudo tee /root/.claude/settings.json > /dev/null`);
  log('Notification hook installed.');

  // Step 4: Copy Claude Code auth credentials from local machine to VM
  log('Syncing Claude Code credentials...');
  try {
    const credentialsData = await readFile(CLAUDE_CREDENTIALS_PATH, 'utf-8');
    const credB64 = Buffer.from(credentialsData).toString('base64');
    await shellExec(sprite, `echo '${credB64}' | base64 -d | sudo tee /root/.claude/.credentials.json > /dev/null && sudo chmod 600 /root/.claude/.credentials.json`);
    log('Claude Code credentials synced.');
  } catch {
    log('Warning: Could not read local Claude Code credentials (~/.claude/.credentials.json). Claude Code on this VM will need to be authenticated manually.');
  }
}

/**
 * Re-provision a VM: reload settings and update CLAUDE.md + hooks.
 * Skips the expensive install step — only pushes config changes.
 */
export async function reprovisionVM(
  client: SpritesClient,
  vmName: string,
  onLog?: (msg: string) => void,
): Promise<void> {
  const sprite = client.sprite(vmName);
  const log = onLog ?? (() => {});

  // Reload settings from disk to pick up any changes
  const settings = await loadSettings();

  // Update CLAUDE.md
  log('Updating CLAUDE.md...');
  const b64 = Buffer.from(settings.claudeMd).toString('base64');
  await shellExec(sprite, `echo '${b64}' | base64 -d | sudo tee /root/CLAUDE.md > /dev/null`);
  log('CLAUDE.md updated.');

  // Update hooks
  log('Updating notification hook...');
  const hooksJson = JSON.stringify(CLAUDE_HOOKS_CONFIG);
  const hooksB64 = Buffer.from(hooksJson).toString('base64');
  await shellExec(sprite, `sudo mkdir -p /root/.claude && echo '${hooksB64}' | base64 -d | sudo tee /root/.claude/settings.json > /dev/null`);
  log('Notification hook updated.');

  // Refresh Claude Code auth credentials
  log('Syncing Claude Code credentials...');
  try {
    const credentialsData = await readFile(CLAUDE_CREDENTIALS_PATH, 'utf-8');
    const credB64 = Buffer.from(credentialsData).toString('base64');
    await shellExec(sprite, `echo '${credB64}' | base64 -d | sudo tee /root/.claude/.credentials.json > /dev/null && sudo chmod 600 /root/.claude/.credentials.json`);
    log('Claude Code credentials synced.');
  } catch {
    log('Warning: Could not sync Claude Code credentials.');
  }
}
