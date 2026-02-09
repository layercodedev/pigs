import { describe, it, expect, jest, beforeEach, afterEach, mock } from 'bun:test';
import net from 'node:net';
import {
  ensureSSHKey,
  installSSHKey,
  createProxyServer,
  mountVM,
  unmountVM,
  unmountAll,
  isMounted,
  getMountPath,
  getMountedNames,
  _mounts,
  KEY_PATH,
  PUBKEY_PATH,
  SSH_DIR,
  MOUNTS_DIR,
} from '../mount-session.ts';

// Mock node:fs/promises
mock.module('node:fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockResolvedValue('ssh-ed25519 AAAA... pigs-mount\n'),
  stat: jest.fn().mockResolvedValue({}),
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

// Mock node:child_process
const mockExecFile = jest.fn().mockImplementation(
  (_cmd: string, _args: string[], cb?: (err: any, stdout: string, stderr: string) => void) => {
    if (cb) cb(null, '', '');
    return { stdout: '', stderr: '' };
  },
);
mock.module('node:child_process', () => ({
  execFile: (...args: any[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') {
      mockExecFile(...args);
    }
    return mockExecFile(...args);
  },
  spawn: jest.fn().mockReturnValue({
    stderr: { on: jest.fn() },
    on: jest.fn((event: string, handler: Function) => {
      if (event === 'close') handler(0);
    }),
  }),
}));

// Mock node:util
mock.module('node:util', () => ({
  promisify: (fn: Function) => jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));

function createMockClient(execResult = { stdout: '', stderr: '', exitCode: 0 }) {
  return {
    baseURL: 'https://api.sprites.dev',
    token: 'test-token',
    sprite: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(execResult),
      execFile: jest.fn().mockResolvedValue(execResult),
    }),
  } as any;
}

function cleanupMounts() {
  _mounts.clear();
}

describe('mount-session', () => {
  beforeEach(() => {
    cleanupMounts();
    jest.clearAllMocks();
  });

  afterEach(() => {
    cleanupMounts();
  });

  describe('ensureSSHKey', () => {
    it('should return public key when key already exists', async () => {
      const pubkey = await ensureSSHKey();
      expect(pubkey).toContain('ssh-ed25519');
    });

    it('should create SSH directory', async () => {
      const { mkdir } = await import('node:fs/promises');
      await ensureSSHKey();
      expect(mkdir).toHaveBeenCalledWith(SSH_DIR, { recursive: true });
    });
  });

  describe('installSSHKey', () => {
    it('should shellExec the key install command on the VM', async () => {
      const client = createMockClient();
      await installSSHKey(client, 'pigs-abc', 'ssh-ed25519 AAAA pigs-mount');

      expect(client.sprite).toHaveBeenCalledWith('pigs-abc');
      const sprite = client.sprite.mock.results[0].value;
      expect(sprite.execFile).toHaveBeenCalled();
      // shellExec calls execFile('bash', ['-c', script])
      const script = sprite.execFile.mock.calls[0][1][1] as string;
      expect(script).toContain('mkdir -p /root/.ssh');
      expect(script).toContain('authorized_keys');
      expect(script).toContain('base64 -d');
    });

    it('should base64-encode the public key', async () => {
      const client = createMockClient();
      const pubkey = 'ssh-ed25519 AAAA pigs-mount';
      await installSSHKey(client, 'pigs-abc', pubkey);

      const sprite = client.sprite.mock.results[0].value;
      const script = sprite.execFile.mock.calls[0][1][1] as string;
      const expectedB64 = Buffer.from(pubkey).toString('base64');
      expect(script).toContain(expectedB64);
    });
  });

  describe('createProxyServer', () => {
    it('should create a local TCP server on a random port', async () => {
      const client = createMockClient();
      const { server, port } = await createProxyServer(client, 'pigs-abc');

      expect(server).toBeInstanceOf(net.Server);
      expect(port).toBeGreaterThan(0);
      expect(server.listening).toBe(true);

      server.close();
    });

    it('should listen on 127.0.0.1', async () => {
      const client = createMockClient();
      const { server } = await createProxyServer(client, 'pigs-abc');

      const addr = server.address() as net.AddressInfo;
      expect(addr.address).toBe('127.0.0.1');

      server.close();
    });
  });

  describe('isMounted', () => {
    it('should return false for unmounted VM', () => {
      expect(isMounted('pigs-abc')).toBe(false);
    });

    it('should return true for mounted VM', () => {
      const server = net.createServer();
      _mounts.set('pigs-abc', {
        vmName: 'pigs-abc',
        mountPath: '/tmp/test-mount',
        proxyServer: server,
        proxyPort: 12345,
      });
      expect(isMounted('pigs-abc')).toBe(true);
      server.close();
    });
  });

  describe('getMountPath', () => {
    it('should return undefined for unmounted VM', () => {
      expect(getMountPath('pigs-abc')).toBeUndefined();
    });

    it('should return mount path for mounted VM', () => {
      const server = net.createServer();
      _mounts.set('pigs-abc', {
        vmName: 'pigs-abc',
        mountPath: '/tmp/test-mount',
        proxyServer: server,
        proxyPort: 12345,
      });
      expect(getMountPath('pigs-abc')).toBe('/tmp/test-mount');
      server.close();
    });
  });

  describe('getMountedNames', () => {
    it('should return empty array when no mounts', () => {
      expect(getMountedNames()).toEqual([]);
    });

    it('should return mounted VM names', () => {
      const server1 = net.createServer();
      const server2 = net.createServer();
      _mounts.set('pigs-abc', {
        vmName: 'pigs-abc',
        mountPath: '/tmp/mount-abc',
        proxyServer: server1,
        proxyPort: 12345,
      });
      _mounts.set('pigs-def', {
        vmName: 'pigs-def',
        mountPath: '/tmp/mount-def',
        proxyServer: server2,
        proxyPort: 12346,
      });
      const names = getMountedNames();
      expect(names).toContain('pigs-abc');
      expect(names).toContain('pigs-def');
      expect(names).toHaveLength(2);
      server1.close();
      server2.close();
    });
  });

  describe('unmountVM', () => {
    it('should be safe to call for non-mounted VM', async () => {
      await unmountVM('nonexistent');
    });

    it('should remove mount from tracking and close proxy', async () => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1');
      const closeSpy = jest.spyOn(server, 'close');
      _mounts.set('pigs-abc', {
        vmName: 'pigs-abc',
        mountPath: '/tmp/test-mount',
        proxyServer: server,
        proxyPort: 12345,
      });

      await unmountVM('pigs-abc');

      expect(_mounts.has('pigs-abc')).toBe(false);
      expect(closeSpy).toHaveBeenCalled();
    });
  });

  describe('unmountAll', () => {
    it('should unmount all mounted VMs', async () => {
      const server1 = net.createServer();
      server1.listen(0, '127.0.0.1');
      const server2 = net.createServer();
      server2.listen(0, '127.0.0.1');
      _mounts.set('pigs-abc', {
        vmName: 'pigs-abc',
        mountPath: '/tmp/mount-abc',
        proxyServer: server1,
        proxyPort: 12345,
      });
      _mounts.set('pigs-def', {
        vmName: 'pigs-def',
        mountPath: '/tmp/mount-def',
        proxyServer: server2,
        proxyPort: 12346,
      });

      await unmountAll();

      expect(_mounts.size).toBe(0);
    });

    it('should be safe when no mounts exist', async () => {
      await unmountAll();
    });
  });

  describe('constants', () => {
    it('should have correct key paths', () => {
      expect(KEY_PATH).toContain('.pigs/ssh/id_ed25519');
      expect(PUBKEY_PATH).toContain('.pigs/ssh/id_ed25519.pub');
    });

    it('should have correct mount directory path', () => {
      expect(MOUNTS_DIR).toContain('.pigs/mounts');
    });
  });
});
