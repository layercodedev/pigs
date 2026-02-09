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
 * Write a file to a sprite using the Sprites filesystem API.
 * Uses PUT /v1/sprites/{name}/fs/write with mkdir=true.
 */
async function spriteWriteFile(
  client: SpritesClient,
  spriteName: string,
  filePath: string,
  content: string,
  mode?: string,
): Promise<void> {
  const params = new URLSearchParams({
    path: filePath,
    workingDir: '/',
    mkdir: 'true',
  });
  if (mode) params.set('mode', mode);
  const url = `${client.baseURL}/v1/sprites/${spriteName}/fs/write?${params}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${client.token}` },
    body: content,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`FS write ${filePath} failed (${resp.status}): ${body}`);
  }
}

/**
 * Read a file from a sprite using the Sprites filesystem API.
 * Uses GET /v1/sprites/{name}/fs/read. Returns null if file not found.
 */
async function spriteReadFile(
  client: SpritesClient,
  spriteName: string,
  filePath: string,
): Promise<string | null> {
  const params = new URLSearchParams({
    path: filePath,
    workingDir: '/',
  });
  const url = `${client.baseURL}/v1/sprites/${spriteName}/fs/read?${params}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${client.token}` },
  });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`FS read ${filePath} failed (${resp.status}): ${body}`);
  }
  return resp.text();
}

/**
 * Write a file to a sprite and verify it was written by reading it back.
 */
async function spriteWriteFileVerified(
  client: SpritesClient,
  spriteName: string,
  filePath: string,
  content: string,
  log: (msg: string) => void,
  mode?: string,
): Promise<void> {
  await spriteWriteFile(client, spriteName, filePath, content, mode);
  const readBack = await spriteReadFile(client, spriteName, filePath);
  if (readBack === null) {
    throw new Error(`${filePath} not found after write`);
  }
  log(`  ✓ ${filePath} (${content.length} bytes)`);
}

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
  } catch (err: any) {
    throw new Error(`Failed to read local ~/.claude.json: ${err?.message || err}`);
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

  // Step 4: Write config files via Sprites FS API
  log('Writing config files...');
  try {
    await writeConfigFiles(client, vmName, settings, log);
  } catch (err: any) {
    log(`Error writing config files: ${err?.message || err}`);
    throw err;
  }
}

/**
 * Re-provision a VM: reload settings and update config files.
 * Skips the expensive install step — only pushes config changes.
 */
export async function reprovisionVM(
  client: SpritesClient,
  vmName: string,
  onLog?: (msg: string) => void,
): Promise<void> {
  const log = onLog ?? (() => {});

  // Reload settings from disk to pick up any changes
  const settings = await loadSettings();

  log('Writing config files...');
  try {
    await writeConfigFiles(client, vmName, settings, log);
  } catch (err: any) {
    log(`Error writing config files: ${err?.message || err}`);
    throw err;
  }
}

/**
 * Write all config files to a sprite via the FS API with read-back verification.
 */
async function writeConfigFiles(
  client: SpritesClient,
  vmName: string,
  settings: PigsSettings | undefined,
  log: (msg: string) => void,
): Promise<void> {
  const resolvedSettings = settings ?? await loadSettings();

  // CLAUDE.md
  await spriteWriteFileVerified(
    client, vmName, '/root/CLAUDE.md',
    resolvedSettings.claudeMd, log,
  );

  // ~/.claude/settings.json (hooks + permissions)
  const settingsJson = JSON.stringify(CLAUDE_HOOKS_CONFIG, null, 2);
  await spriteWriteFileVerified(
    client, vmName, '/root/.claude/settings.json',
    settingsJson, log,
  );

  // ~/.claude/.credentials.json
  try {
    const credentialsData = await readClaudeCredentials();
    await spriteWriteFileVerified(
      client, vmName, '/root/.claude/.credentials.json',
      credentialsData, log, '0600',
    );
  } catch (err: any) {
    log(`  ⚠ credentials: ${err?.message || err}`);
  }

  // ~/.claude.json (oauthAccount + userID)
  try {
    const localData = await readLocalClaudeJson();
    const claudeJson = buildVmClaudeJson(localData);
    await spriteWriteFileVerified(
      client, vmName, '/root/.claude.json',
      claudeJson, log,
    );
  } catch (err: any) {
    log(`  ⚠ .claude.json: ${err?.message || err}`);
  }
}
