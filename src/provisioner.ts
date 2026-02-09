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
const CLAUDE_JSON_PATH = join(homedir(), '.claude.json');

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

/**
 * Read oauthAccount and userID from the local ~/.claude.json.
 */
async function readLocalClaudeJson(): Promise<{ oauthAccount?: any; userID?: string }> {
  try {
    const data = await readFile(CLAUDE_JSON_PATH, 'utf-8');
    const parsed = JSON.parse(data);
    return {
      oauthAccount: parsed.oauthAccount,
      userID: parsed.userID,
    };
  } catch {
    return {};
  }
}

/**
 * Build the ~/.claude.json content for a VM, injecting the user's
 * oauthAccount and userID from their local machine.
 */
function buildVmClaudeJson(localData: { oauthAccount?: any; userID?: string }): string {
  const config: Record<string, any> = {
    numStartups: 1,
    cachedGrowthBookFeatures: {
      tengu_1p_event_batch_config: {
        scheduledDelayMillis: 5000,
        maxExportBatchSize: 200,
        maxQueueSize: 8192,
      },
      tengu_mcp_tool_search: true,
      tengu_scratch: false,
      tengu_brass_pebble: false,
      tengu_disable_bypass_permissions_mode: false,
      tengu_event_sampling_config: {},
      tengu_tool_pear: false,
      tengu_scarf_coffee: false,
      tengu_log_segment_events: false,
      tengu_log_datadog_events: true,
      tengu_keybinding_customization_release: false,
      tengu_thinkback: false,
      tengu_pid_based_version_locking: true,
      tengu_c4w_usage_limit_notifications_enabled: true,
      tengu_marble_kite: false,
      tengu_kv7_prompt_sort: false,
      'tengu-top-of-feed-tip': { tip: '', color: '' },
      tengu_react_vulnerability_warning: false,
      tengu_code_diff_cli: true,
      tengu_pr_status_cli: false,
      tengu_post_compact_survey: false,
      tengu_claudeai_mcp_connectors: true,
    },
    userID: localData.userID || '',
    firstStartTime: new Date().toISOString(),
    sonnet45MigrationComplete: true,
    opus45MigrationComplete: true,
    opusProMigrationComplete: true,
    thinkingMigrationComplete: true,
    cachedChromeExtensionInstalled: false,
    oauthAccount: localData.oauthAccount || {},
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '2.1.20',
    bypassPermissionsModeAccepted: true,
    lastReleaseNotesSeen: '2.1.20',
    projects: {
      '/home/sprite': {
        allowedTools: [],
        mcpContextUris: [],
        mcpServers: {},
        enabledMcpjsonServers: [],
        disabledMcpjsonServers: [],
        hasTrustDialogAccepted: false,
        projectOnboardingSeenCount: 1,
        hasClaudeMdExternalIncludesApproved: false,
        hasClaudeMdExternalIncludesWarningShown: false,
        exampleFiles: [],
      },
    },
    officialMarketplaceAutoInstallAttempted: true,
    officialMarketplaceAutoInstalled: true,
  };
  return JSON.stringify(config, null, 2);
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

  // Step 7: Write ~/.claude.json with user's oauthAccount and userID
  log('Writing Claude config...');
  try {
    const localData = await readLocalClaudeJson();
    const claudeJson = buildVmClaudeJson(localData);
    const claudeJsonB64 = Buffer.from(claudeJson).toString('base64');
    await shellExec(sprite, `echo '${claudeJsonB64}' | base64 -d | sudo tee /root/.claude.json > /dev/null`);
  } catch {
    log('Warning: Could not write ~/.claude.json to VM.');
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

  // Update ~/.claude.json with user's oauthAccount and userID
  log('Writing Claude config...');
  try {
    const localData = await readLocalClaudeJson();
    const claudeJson = buildVmClaudeJson(localData);
    const claudeJsonB64 = Buffer.from(claudeJson).toString('base64');
    await shellExec(sprite, `echo '${claudeJsonB64}' | base64 -d | sudo tee /root/.claude.json > /dev/null`);
  } catch {
    log('Warning: Could not write ~/.claude.json to VM.');
  }
}
