import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { SpritesClient } from '@fly/sprites';
import type { PigsSettings } from './types.ts';
import { CLAUDE_HOOKS_CONFIG } from './notification-monitor.ts';

const SETTINGS_DIR = join(homedir(), '.pigs');
const SETTINGS_PATH = join(SETTINGS_DIR, 'settings.json');
const CLAUDE_CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');

import { shellExec } from './shell-exec.ts';

/**
 * Read Claude Code credentials from macOS keychain or file fallback.
 * On macOS, Claude Code stores OAuth tokens in the keychain under "Claude Code-credentials".
 * On Linux, it uses ~/.claude/.credentials.json.
 */
async function readClaudeCredentials(): Promise<string> {
  if (platform() === 'darwin') {
    try {
      const result = await new Promise<string>((resolve, reject) => {
        execFile(
          'security',
          ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
          (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout.trim());
          },
        );
      });
      if (result) return result;
    } catch {
      // Fall through to file-based lookup
    }
  }
  return readFile(CLAUDE_CREDENTIALS_PATH, 'utf-8');
}

const DEFAULT_CLAUDE_MD = `# Agent Instructions

You are a coding agent running on a remote VM. Follow the user's instructions carefully.
`;

/**
 * Extract a meaningful error message from a shellExec failure.
 */
function extractErrorDetail(err: any): string {
  const stderr = err?.result?.stderr || err?.stderr || '';
  if (stderr) return stderr.trim().split('\n').slice(-3).join('\n');
  return err?.message || String(err);
}

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

  // Step 1: Install Claude Code globally via npm (if missing)
  log('Installing Claude Code...');
  try {
    await shellExec(sprite, 'if ! command -v claude &>/dev/null; then sudo npm install -g @anthropic-ai/claude-code; fi');
  } catch (err: any) {
    const detail = extractErrorDetail(err);
    log(`Error installing Claude Code: ${detail}`);
    throw err;
  }

  // Step 2: Install SSH server (if missing)
  log('Installing SSH server...');
  try {
    await shellExec(sprite, 'if ! command -v sshd &>/dev/null; then sudo apt-get update -qq && sudo apt-get install -y -qq openssh-server; fi');
  } catch (err: any) {
    const detail = extractErrorDetail(err);
    log(`Error installing SSH server: ${detail}`);
    throw err;
  }

  // Step 3: Start SSH server (if not running)
  log('Starting SSH server...');
  try {
    await shellExec(sprite, 'if ! pgrep -x sshd &>/dev/null; then sudo mkdir -p /run/sshd && sudo /usr/sbin/sshd; fi');
  } catch (err: any) {
    const detail = extractErrorDetail(err);
    log(`Error starting SSH server: ${detail}`);
    throw err;
  }

  // Step 4: Write CLAUDE.md from settings using base64 to avoid escaping issues
  log('Writing CLAUDE.md...');
  try {
    const resolvedSettings = settings ?? await loadSettings();
    const b64 = Buffer.from(resolvedSettings.claudeMd).toString('base64');
    await shellExec(sprite, `echo '${b64}' | base64 -d | sudo tee /root/CLAUDE.md > /dev/null`);
  } catch (err: any) {
    const detail = extractErrorDetail(err);
    log(`Error writing CLAUDE.md: ${detail}`);
    throw err;
  }

  // Step 5: Install Claude Code Stop hook for finish notifications
  log('Installing notification hook...');
  try {
    const hooksJson = JSON.stringify(CLAUDE_HOOKS_CONFIG);
    const hooksB64 = Buffer.from(hooksJson).toString('base64');
    await shellExec(sprite, `sudo mkdir -p /root/.claude && echo '${hooksB64}' | base64 -d | sudo tee /root/.claude/settings.json > /dev/null`);
  } catch (err: any) {
    const detail = extractErrorDetail(err);
    log(`Error installing notification hook: ${detail}`);
    throw err;
  }

  // Step 6: Copy Claude Code auth credentials from local machine to VM
  log('Syncing credentials...');
  try {
    const credentialsData = await readClaudeCredentials();
    const credB64 = Buffer.from(credentialsData).toString('base64');
    await shellExec(sprite, `echo '${credB64}' | base64 -d | sudo tee /root/.claude/.credentials.json > /dev/null && sudo chmod 600 /root/.claude/.credentials.json`);
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
  try {
    const b64 = Buffer.from(settings.claudeMd).toString('base64');
    await shellExec(sprite, `echo '${b64}' | base64 -d | sudo tee /root/CLAUDE.md > /dev/null`);
  } catch (err: any) {
    const detail = extractErrorDetail(err);
    log(`Error updating CLAUDE.md: ${detail}`);
    throw err;
  }

  // Update hooks
  log('Updating notification hook...');
  try {
    const hooksJson = JSON.stringify(CLAUDE_HOOKS_CONFIG);
    const hooksB64 = Buffer.from(hooksJson).toString('base64');
    await shellExec(sprite, `sudo mkdir -p /root/.claude && echo '${hooksB64}' | base64 -d | sudo tee /root/.claude/settings.json > /dev/null`);
  } catch (err: any) {
    const detail = extractErrorDetail(err);
    log(`Error updating notification hook: ${detail}`);
    throw err;
  }

  // Refresh Claude Code auth credentials
  log('Syncing credentials...');
  try {
    const credentialsData = await readClaudeCredentials();
    const credB64 = Buffer.from(credentialsData).toString('base64');
    await shellExec(sprite, `echo '${credB64}' | base64 -d | sudo tee /root/.claude/.credentials.json > /dev/null && sudo chmod 600 /root/.claude/.credentials.json`);
  } catch {
    log('Warning: Could not sync Claude Code credentials.');
  }
}
