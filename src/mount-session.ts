import { execFile, spawn as cpSpawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SpritesClient } from '@fly/sprites';
import { shellExec } from './shell-exec.js';

const execFileAsync = promisify(execFile);

const PIGS_DIR = join(homedir(), '.pigs');
const SSH_DIR = join(PIGS_DIR, 'ssh');
const MOUNTS_DIR = join(PIGS_DIR, 'mounts');
const KEY_PATH = join(SSH_DIR, 'id_ed25519');
const PUBKEY_PATH = join(SSH_DIR, 'id_ed25519.pub');

interface MountState {
  vmName: string;
  mountPath: string;
  proxyServer: net.Server;
  proxyPort: number;
}

const mounts = new Map<string, MountState>();

/**
 * Ensure the SSH key pair exists in ~/.pigs/ssh/.
 * Generates a new ed25519 key pair if missing.
 */
export async function ensureSSHKey(): Promise<string> {
  await mkdir(SSH_DIR, { recursive: true });

  try {
    await stat(KEY_PATH);
    return await readFile(PUBKEY_PATH, 'utf-8');
  } catch {
    // Generate new key pair
    await execFileAsync('ssh-keygen', [
      '-t', 'ed25519',
      '-f', KEY_PATH,
      '-N', '',
      '-C', 'pigs-mount',
    ]);
    return await readFile(PUBKEY_PATH, 'utf-8');
  }
}

/**
 * Install the SSH public key on the VM so sshfs can connect.
 */
export async function installSSHKey(
  client: SpritesClient,
  vmName: string,
  pubkey: string,
): Promise<void> {
  const sprite = client.sprite(vmName);
  const b64 = Buffer.from(pubkey.trim()).toString('base64');
  await shellExec(sprite,
    `sudo mkdir -p /root/.ssh && echo '${b64}' | base64 -d | sudo tee -a /root/.ssh/authorized_keys > /dev/null && sudo chmod 600 /root/.ssh/authorized_keys`,
  );
}

/**
 * Create a local TCP server that proxies connections to the VM's SSH port
 * via the Sprites WebSocket proxy API.
 */
export function createProxyServer(
  client: SpritesClient,
  vmName: string,
): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      const wsUrl = `${client.baseURL.replace('https://', 'wss://').replace('http://', 'ws://')}/v1/sprites/${vmName}/proxy`;

      const ws = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${client.token}` },
      } as any);

      let initialized = false;

      ws.addEventListener('open', () => {
        // Send init message to connect to SSH port
        ws.send(JSON.stringify({ host: 'localhost', port: 22 }));
      });

      ws.addEventListener('message', (event) => {
        if (!initialized) {
          // First message is the proxy confirmation, now relay data
          initialized = true;
          return;
        }
        const data = event.data;
        if (data instanceof ArrayBuffer) {
          socket.write(Buffer.from(data));
        } else if (Buffer.isBuffer(data)) {
          socket.write(data);
        } else {
          socket.write(String(data));
        }
      });

      ws.addEventListener('close', () => {
        socket.end();
      });

      ws.addEventListener('error', () => {
        socket.end();
      });

      socket.on('data', (chunk) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(chunk);
        }
      });

      socket.on('close', () => {
        ws.close();
      });

      socket.on('error', () => {
        ws.close();
      });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

/**
 * Mount a VM's filesystem locally via sshfs over the Sprites proxy.
 *
 * Steps:
 * 1. Ensure SSH key exists and is installed on VM
 * 2. Create local TCP proxy to VM's SSH port
 * 3. Run sshfs to mount the VM's /root/ to ~/.pigs/mounts/{vmName}/
 */
export async function mountVM(
  client: SpritesClient,
  vmName: string,
  onLog?: (msg: string) => void,
): Promise<string> {
  const log = onLog ?? (() => {});

  if (mounts.has(vmName)) {
    return mounts.get(vmName)!.mountPath;
  }

  // Step 1: Ensure SSH key and install on VM
  log('Setting up SSH key...');
  const pubkey = await ensureSSHKey();
  await installSSHKey(client, vmName, pubkey);

  // Step 2: Create local TCP proxy to VM SSH port
  log('Starting SSH tunnel...');
  const { server, port } = await createProxyServer(client, vmName);

  // Step 3: Create mount point
  const mountPath = join(MOUNTS_DIR, vmName);
  await mkdir(mountPath, { recursive: true });

  // Step 4: Mount with sshfs
  log('Mounting filesystem...');
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = cpSpawn('sshfs', [
        `root@127.0.0.1:/root`,
        mountPath,
        '-p', String(port),
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', `IdentityFile=${KEY_PATH}`,
        '-o', 'reconnect',
        '-o', 'ServerAliveInterval=15',
        '-o', 'LogLevel=ERROR',
      ], { stdio: 'pipe' });

      let stderr = '';
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`sshfs failed (code ${code}): ${stderr.trim()}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`sshfs not found. Install sshfs to use mount: ${err.message}`));
      });
    });
  } catch (err) {
    server.close();
    throw err;
  }

  mounts.set(vmName, { vmName, mountPath, proxyServer: server, proxyPort: port });
  log(`Mounted at ${mountPath}`);
  return mountPath;
}

/**
 * Unmount a VM's filesystem.
 */
export async function unmountVM(vmName: string): Promise<void> {
  const mount = mounts.get(vmName);
  if (!mount) return;

  const cmd = platform() === 'darwin' ? 'umount' : 'fusermount';
  const args = platform() === 'darwin' ? [mount.mountPath] : ['-u', mount.mountPath];

  try {
    await execFileAsync(cmd, args);
  } catch {
    // Try force unmount
    try {
      if (platform() === 'darwin') {
        await execFileAsync('umount', ['-f', mount.mountPath]);
      } else {
        await execFileAsync('fusermount', ['-uz', mount.mountPath]);
      }
    } catch {
      // Ignore - mount may already be gone
    }
  }

  mount.proxyServer.close();
  mounts.delete(vmName);
}

/**
 * Unmount all mounted VMs.
 */
export async function unmountAll(): Promise<void> {
  for (const vmName of Array.from(mounts.keys())) {
    await unmountVM(vmName);
  }
}

/**
 * Check if a VM is currently mounted.
 */
export function isMounted(vmName: string): boolean {
  return mounts.has(vmName);
}

/**
 * Get the mount path for a VM.
 */
export function getMountPath(vmName: string): string | undefined {
  return mounts.get(vmName)?.mountPath;
}

/**
 * Get all mounted VM names.
 */
export function getMountedNames(): string[] {
  return Array.from(mounts.keys());
}

// Export internals for testing
export { PIGS_DIR, SSH_DIR, MOUNTS_DIR, KEY_PATH, PUBKEY_PATH, mounts as _mounts };
