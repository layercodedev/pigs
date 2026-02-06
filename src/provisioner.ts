import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SpritesClient } from '@fly/sprites';
import type { PigsSettings } from './types.js';

const SETTINGS_DIR = join(homedir(), '.pigs');
const SETTINGS_PATH = join(SETTINGS_DIR, 'settings.json');

const DEFAULT_CLAUDE_MD = `# Agent Instructions

You are a coding agent running on a remote VM. Follow the user's instructions carefully.
`;

const PROVISION_SCRIPT = [
  'set -e',
  // Install Claude Code globally via npm
  'if ! command -v claude &>/dev/null; then npm install -g @anthropic-ai/claude-code; fi',
  // Ensure SSH server is installed and running
  'if ! command -v sshd &>/dev/null; then apt-get update -qq && apt-get install -y -qq openssh-server; fi',
  'if ! pgrep -x sshd &>/dev/null; then mkdir -p /run/sshd && /usr/sbin/sshd; fi',
].join('\n');

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
  await sprite.exec(PROVISION_SCRIPT);
  log('Claude Code and SSH installed.');

  // Step 2: Write CLAUDE.md from settings using base64 to avoid escaping issues
  log('Writing CLAUDE.md...');
  const resolvedSettings = settings ?? await loadSettings();
  const b64 = Buffer.from(resolvedSettings.claudeMd).toString('base64');
  await sprite.exec(`echo '${b64}' | base64 -d > /root/CLAUDE.md`);
  log('CLAUDE.md written.');
}
