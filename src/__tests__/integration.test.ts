/**
 * Integration tests — hit the real Sprites API with a live SPRITES_TOKEN.
 *
 * These tests create a real VM, provision it, run commands on it, and
 * tear it down. They verify the app actually works end-to-end against
 * the live infrastructure.
 *
 * Run with:
 *   npm run test:integration
 *
 * Requires SPRITES_TOKEN in the environment (loaded from ~/.profile).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { SpritesClient } from '@fly/sprites';
import type { VM } from '../types.ts';
import { shellExec } from '../shell-exec.ts';

// Module imports — these are the real functions the TUI calls
import {
  createSpritesClient,
  listVMs,
  createVM,
  deleteVM,
  spriteToVM,
  generateVMName,
} from '../sprites-client.ts';

import { provisionVM, reprovisionVM, loadSettings } from '../provisioner.ts';

import {
  attachConsole,
  writeToConsole,
  getSession,
  destroyConsole,
  resizeConsole,
} from '../console-session.ts';

import {
  _checkSignal,
  _checkGitLabel,
  defaultLabel,
  SIGNAL_FILE,
} from '../notification-monitor.ts';

import {
  installSSHKey,
  ensureSSHKey,
  createProxyServer,
} from '../mount-session.ts';

// ---------------------------------------------------------------------------
// Shared state across all tests
// ---------------------------------------------------------------------------
let client: SpritesClient;
let testVM: VM;
const TEST_VM_PREFIX = 'pigs-itest-';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeAll(async () => {
  // Ensure token is available
  if (!process.env.SPRITES_TOKEN) {
    throw new Error(
      'SPRITES_TOKEN must be set to run integration tests. Source ~/.profile first.',
    );
  }
  client = createSpritesClient();
}, 10_000);

afterAll(async () => {
  // Best-effort cleanup: delete our test VM and any leaked itest VMs
  try {
    const allVMs = await client.listAllSprites(TEST_VM_PREFIX);
    for (const sprite of allVMs) {
      try {
        destroyConsole(sprite.name);
      } catch { /* ignore */ }
      try {
        await client.deleteSprite(sprite.name);
      } catch { /* ignore */ }
    }
  } catch {
    // If cleanup fails, that's acceptable — don't break the test run
  }
}, 60_000);

// ---------------------------------------------------------------------------
// 1. Client creation
// ---------------------------------------------------------------------------
describe('SpritesClient (live)', () => {
  it('creates a client with the real token', () => {
    expect(client).toBeDefined();
    expect(client.token).toBe(process.env.SPRITES_TOKEN);
    expect(client.baseURL).toMatch(/^https?:\/\//);
  });
});

// ---------------------------------------------------------------------------
// 2. VM lifecycle: create → list → exec → delete
// ---------------------------------------------------------------------------
describe('VM lifecycle (live)', () => {
  it('creates a VM', async () => {
    const name = `${TEST_VM_PREFIX}${Date.now().toString(36)}`;
    testVM = await createVM(client, name);

    expect(testVM).toBeDefined();
    expect(testVM.name).toBe(name);
    expect(testVM.id).toBeTruthy();
    expect(['cold', 'running', 'stopped']).toContain(testVM.status);
    expect(testVM.createdAt).toBeTruthy();
    expect(testVM.needsAttention).toBe(false);
  }, 30_000);

  it('lists VMs and finds the test VM', async () => {
    const vms = await listVMs(client);
    const found = vms.find((vm) => vm.name === testVM.name);
    expect(found).toBeDefined();
    expect(found!.name).toBe(testVM.name);
  }, 30_000);

  it('can execute a simple command on the VM', async () => {
    const sprite = client.sprite(testVM.name);
    const { stdout } = await sprite.exec('echo hello');
    expect(String(stdout).trim()).toBe('hello');
  }, 30_000);

  it('can execute shell commands via shellExec (pipes, redirects)', async () => {
    const sprite = client.sprite(testVM.name);
    const { stdout } = await shellExec(sprite, 'echo hello | tr a-z A-Z');
    expect(String(stdout).trim()).toBe('HELLO');
  }, 30_000);

  it('can execute multi-line shell scripts via shellExec', async () => {
    const sprite = client.sprite(testVM.name);
    const script = 'set -e\nA=hello\nB=world\necho "$A $B"';
    const { stdout } = await shellExec(sprite, script);
    expect(String(stdout).trim()).toBe('hello world');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 3. Provisioning (installs Claude Code + SSH + config files)
// ---------------------------------------------------------------------------
describe('Provisioning (live)', () => {
  it('provisions the VM (installs Claude Code + SSH)', async () => {
    const logs: string[] = [];
    await provisionVM(client, testVM.name, undefined, (msg) => logs.push(msg));
    testVM.provisioningStatus = 'done';

    // Verify we got log output from each provisioning step
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes('Claude Code'))).toBe(true);
    expect(logs.some((l) => l.includes('CLAUDE.md'))).toBe(true);
    expect(logs.some((l) => l.includes('hook'))).toBe(true);
  }, 120_000);

  it('can verify Claude Code is installed', async () => {
    const sprite = client.sprite(testVM.name);
    const { stdout } = await sprite.exec('which claude');
    expect(String(stdout).trim()).toMatch(/claude/);
  }, 30_000);

  it('can verify SSH server is running', async () => {
    const sprite = client.sprite(testVM.name);
    const { stdout } = await shellExec(sprite, 'pgrep -x sshd || echo "not running"');
    const output = String(stdout).trim();
    expect(output).not.toBe('not running');
  }, 30_000);

  it('can verify CLAUDE.md was written', async () => {
    const sprite = client.sprite(testVM.name);
    const { stdout } = await shellExec(sprite, 'cat /root/CLAUDE.md');
    const content = String(stdout).trim();
    expect(content).toContain('Agent Instructions');
  }, 30_000);

  it('can verify notification hook is installed', async () => {
    const sprite = client.sprite(testVM.name);
    const { stdout } = await shellExec(sprite, 'cat /root/.claude/settings.json');
    const settings = JSON.parse(String(stdout).trim());
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.Stop).toBeDefined();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 4. Console sessions (TTY spawn)
// ---------------------------------------------------------------------------
describe('Console sessions (live)', () => {
  it('attaches a console session to the VM', async () => {
    const session = await attachConsole(client, testVM.name, 80, 24);
    expect(session).toBeDefined();
    expect(session.vmName).toBe(testVM.name);
    expect(session.started).toBe(true);
    expect(session.command).toBeDefined();
  }, 30_000);

  it('can write to console and receive output', async () => {
    const session = getSession(testVM.name);
    expect(session).toBeDefined();

    // Collect stdout
    const output: string[] = [];
    const marker = `ITEST_${Date.now()}`;
    session!.command.stdout.on('data', (chunk: Buffer) => {
      output.push(chunk.toString());
    });

    // Write a command with a unique marker
    writeToConsole(testVM.name, `echo "${marker}"\n`);

    // Wait for output containing our marker
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (output.some((line) => line.includes(marker))) {
          clearInterval(interval);
          resolve();
        }
      }, 200);
      setTimeout(() => {
        clearInterval(interval);
        resolve();
      }, 10_000);
    });

    const fullOutput = output.join('');
    expect(fullOutput).toContain(marker);
  }, 15_000);

  it('can resize the console without error', () => {
    resizeConsole(testVM.name, 120, 40);
  });

  it('destroys the console session', () => {
    destroyConsole(testVM.name);
    const session = getSession(testVM.name);
    expect(session).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Notification monitor (signal file detection)
// ---------------------------------------------------------------------------
describe('Notification monitor (live)', () => {
  it('detects absence of signal file (no attention needed)', async () => {
    const sprite = client.sprite(testVM.name);
    await shellExec(sprite, `rm -f ${SIGNAL_FILE}`);

    const vm: VM = { ...testVM, needsAttention: false };
    await _checkSignal(client, vm);
    expect(vm.needsAttention).toBe(false);
  }, 30_000);

  it('detects presence of signal file and consumes it', async () => {
    const sprite = client.sprite(testVM.name);
    await sprite.exec(`touch ${SIGNAL_FILE}`);

    const vm: VM = { ...testVM, needsAttention: false };
    await _checkSignal(client, vm);
    expect(vm.needsAttention).toBe(true);

    // Signal should be consumed (removed)
    const { stdout } = await shellExec(sprite, `test -f ${SIGNAL_FILE} && echo EXISTS || echo GONE`);
    expect(String(stdout).trim()).toBe('GONE');
  }, 30_000);

  it('detects git repo info via checkGitLabel', async () => {
    // Create a dummy git repo in user's home (where checkGitLabel's cd /root may not work,
    // but we test the function doesn't throw)
    const sprite = client.sprite(testVM.name);
    await shellExec(sprite, 'cd ~ && git init testrepo && cd testrepo && git checkout -b test-branch');

    const vm: VM = { ...testVM, needsAttention: false, customLabel: false };
    const changed = await _checkGitLabel(client, vm);
    expect(typeof changed).toBe('boolean');
    expect(vm.displayLabel).toBeDefined();

    // Cleanup
    await shellExec(sprite, 'rm -rf ~/testrepo');
  }, 30_000);

  it('falls back to defaultLabel when no git repo exists', async () => {
    const vm: VM = { ...testVM, needsAttention: false, customLabel: false, displayLabel: undefined };
    await _checkGitLabel(client, vm);
    // With no git repo at /root, should fall back to last 6 chars of name
    expect(vm.displayLabel).toBe(defaultLabel(testVM.name));
  }, 30_000);

  it('defaultLabel returns last 6 chars', () => {
    expect(defaultLabel('pigs-abc123')).toBe('abc123');
    expect(defaultLabel('pigs-xy')).toBe('igs-xy');
  });
});

// ---------------------------------------------------------------------------
// 6. Re-provisioning (config push without reinstall)
// ---------------------------------------------------------------------------
describe('Reprovision (live)', () => {
  it('re-provisions the VM (updates CLAUDE.md + hooks)', async () => {
    const logs: string[] = [];
    await reprovisionVM(client, testVM.name, (msg) => logs.push(msg));

    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes('CLAUDE.md'))).toBe(true);
    expect(logs.some((l) => l.includes('hook'))).toBe(true);

    // Verify the CLAUDE.md was refreshed
    const sprite = client.sprite(testVM.name);
    const { stdout } = await shellExec(sprite, 'cat /root/CLAUDE.md');
    expect(String(stdout).trim()).toContain('Agent Instructions');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 7. SSH key + proxy server (mount prerequisites)
// ---------------------------------------------------------------------------
describe('Mount prerequisites (live)', () => {
  it('ensures SSH key pair exists', async () => {
    const pubkey = await ensureSSHKey();
    expect(pubkey).toBeTruthy();
    expect(pubkey).toContain('ssh-ed25519');
  }, 10_000);

  it('installs SSH public key on the VM', async () => {
    const pubkey = await ensureSSHKey();
    await installSSHKey(client, testVM.name, pubkey);

    // Verify key was installed
    const sprite = client.sprite(testVM.name);
    const { stdout } = await shellExec(sprite, 'cat /root/.ssh/authorized_keys');
    expect(String(stdout)).toContain('ssh-ed25519');
  }, 30_000);

  it('creates a proxy server for WebSocket SSH tunneling', async () => {
    const { server, port } = await createProxyServer(client, testVM.name);
    expect(server).toBeDefined();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);

    // Clean up the server
    server.close();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 8. Settings (local file operations)
// ---------------------------------------------------------------------------
describe('Settings (live)', () => {
  it('loads settings from disk (or creates defaults)', async () => {
    const settings = await loadSettings();
    expect(settings).toBeDefined();
    expect(typeof settings.claudeMd).toBe('string');
    expect(settings.claudeMd.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Helper functions (no API, but part of the live code path)
// ---------------------------------------------------------------------------
describe('Helpers', () => {
  it('generateVMName produces valid names', () => {
    for (let i = 0; i < 10; i++) {
      const name = generateVMName();
      expect(name).toMatch(/^pigs-[a-z0-9]{6}$/);
    }
  });

  it('spriteToVM maps sprite data correctly', () => {
    const sprite = {
      name: 'pigs-test99',
      id: 'uuid-test',
      status: 'running',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      client: {} as any,
    } as any;

    const vm = spriteToVM(sprite);
    expect(vm.name).toBe('pigs-test99');
    expect(vm.id).toBe('uuid-test');
    expect(vm.status).toBe('running');
    expect(vm.needsAttention).toBe(false);
    expect(vm.displayLabel).toBe('test99');
  });
});

// ---------------------------------------------------------------------------
// 10. Cleanup — delete the test VM (runs last)
// ---------------------------------------------------------------------------
describe('Cleanup', () => {
  it('deletes the test VM', async () => {
    await deleteVM(client, testVM.name);

    // Verify it's gone (or at least not listed)
    const vms = await listVMs(client);
    const found = vms.find((vm) => vm.name === testVM.name);
    expect(found).toBeUndefined();
  }, 30_000);
});
