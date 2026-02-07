import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  attachConsole,
  detachConsole,
  destroyConsole,
  getSession,
  resizeConsole,
  writeToConsole,
  detachAll,
  getActiveSessionNames,
} from '../console-session.ts';

// We need to reset the module's internal sessions map between tests
// by destroying all sessions
function cleanupSessions() {
  for (const name of getActiveSessionNames()) {
    destroyConsole(name);
  }
}

function createMockSpriteCommand() {
  const stdout = {
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  };
  const stderr = {
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  };
  const stdin = {
    write: vi.fn().mockReturnValue(true),
  };
  // spawn() auto-starts and emits 'spawn' when ready
  const onHandlers = new Map<string, Function>();
  return {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    resize: vi.fn(),
    wait: vi.fn().mockResolvedValue(0),
    on: vi.fn((event: string, handler: Function) => {
      onHandlers.set(event, handler);
      // Auto-emit 'spawn' on next tick to simulate SDK behavior
      if (event === 'spawn') {
        Promise.resolve().then(() => handler());
      }
    }),
    exitCode: vi.fn().mockReturnValue(-1),
    _onHandlers: onHandlers,
  };
}

function createMockClient(mockCommand?: ReturnType<typeof createMockSpriteCommand>) {
  const cmd = mockCommand ?? createMockSpriteCommand();
  return {
    sprite: vi.fn().mockReturnValue({
      spawn: vi.fn().mockReturnValue(cmd),
    }),
    _mockCommand: cmd,
  } as any;
}

describe('console-session', () => {
  beforeEach(() => {
    cleanupSessions();
  });

  describe('attachConsole', () => {
    it('should create a TTY session with spawn and wait for spawn event', async () => {
      const mockCmd = createMockSpriteCommand();
      const client = createMockClient(mockCmd);

      const session = await attachConsole(client, 'pigs-abc', 120, 40);

      expect(client.sprite).toHaveBeenCalledWith('pigs-abc');
      const sprite = client.sprite.mock.results[0].value;
      expect(sprite.spawn).toHaveBeenCalledWith('bash', [], {
        tty: true,
        cols: 120,
        rows: 40,
      });
      // Should listen for 'spawn' event (not call start())
      expect(mockCmd.on).toHaveBeenCalledWith('spawn', expect.any(Function));
      expect(session.vmName).toBe('pigs-abc');
      expect(session.started).toBe(true);
    });

    it('should return existing session if already started', async () => {
      const mockCmd = createMockSpriteCommand();
      const client = createMockClient(mockCmd);

      const session1 = await attachConsole(client, 'pigs-abc', 80, 24);
      const session2 = await attachConsole(client, 'pigs-abc', 120, 40);

      expect(session1).toBe(session2);
      // spawn should only be called once (second call returns cached session)
      const sprite = client.sprite.mock.results[0].value;
      expect(sprite.spawn).toHaveBeenCalledTimes(1);
    });

    it('should create separate sessions for different VMs', async () => {
      const client1 = createMockClient();
      const client2 = createMockClient();

      const session1 = await attachConsole(client1, 'pigs-abc', 80, 24);
      const session2 = await attachConsole(client2, 'pigs-def', 80, 24);

      expect(session1.vmName).toBe('pigs-abc');
      expect(session2.vmName).toBe('pigs-def');
      expect(session1).not.toBe(session2);
    });
  });

  describe('detachConsole', () => {
    it('should remove stdout and stderr listeners', async () => {
      const mockCmd = createMockSpriteCommand();
      const client = createMockClient(mockCmd);

      await attachConsole(client, 'pigs-abc', 80, 24);
      detachConsole('pigs-abc');

      expect(mockCmd.stdout.removeAllListeners).toHaveBeenCalledWith('data');
      expect(mockCmd.stderr.removeAllListeners).toHaveBeenCalledWith('data');
    });

    it('should be safe to call for non-existent session', () => {
      expect(() => detachConsole('nonexistent')).not.toThrow();
    });
  });

  describe('destroyConsole', () => {
    it('should kill the command and remove the session', async () => {
      const mockCmd = createMockSpriteCommand();
      const client = createMockClient(mockCmd);

      await attachConsole(client, 'pigs-abc', 80, 24);
      destroyConsole('pigs-abc');

      expect(mockCmd.kill).toHaveBeenCalled();
      expect(getSession('pigs-abc')).toBeUndefined();
    });

    it('should handle kill errors gracefully', async () => {
      const mockCmd = createMockSpriteCommand();
      mockCmd.kill.mockImplementation(() => {
        throw new Error('already dead');
      });
      const client = createMockClient(mockCmd);

      await attachConsole(client, 'pigs-abc', 80, 24);
      expect(() => destroyConsole('pigs-abc')).not.toThrow();
      expect(getSession('pigs-abc')).toBeUndefined();
    });
  });

  describe('getSession', () => {
    it('should return undefined for non-existent session', () => {
      expect(getSession('nonexistent')).toBeUndefined();
    });

    it('should return session after attach', async () => {
      const client = createMockClient();
      await attachConsole(client, 'pigs-abc', 80, 24);

      const session = getSession('pigs-abc');
      expect(session).toBeDefined();
      expect(session!.vmName).toBe('pigs-abc');
    });
  });

  describe('resizeConsole', () => {
    it('should call resize on the command', async () => {
      const mockCmd = createMockSpriteCommand();
      const client = createMockClient(mockCmd);

      await attachConsole(client, 'pigs-abc', 80, 24);
      resizeConsole('pigs-abc', 120, 40);

      expect(mockCmd.resize).toHaveBeenCalledWith(120, 40);
    });

    it('should be safe to call for non-existent session', () => {
      expect(() => resizeConsole('nonexistent', 80, 24)).not.toThrow();
    });
  });

  describe('writeToConsole', () => {
    it('should write to stdin', async () => {
      const mockCmd = createMockSpriteCommand();
      const client = createMockClient(mockCmd);

      await attachConsole(client, 'pigs-abc', 80, 24);
      const result = writeToConsole('pigs-abc', 'ls\n');

      expect(mockCmd.stdin.write).toHaveBeenCalledWith('ls\n');
      expect(result).toBe(true);
    });

    it('should return false for non-existent session', () => {
      expect(writeToConsole('nonexistent', 'test')).toBe(false);
    });
  });

  describe('detachAll', () => {
    it('should detach from all sessions', async () => {
      const mockCmd1 = createMockSpriteCommand();
      const mockCmd2 = createMockSpriteCommand();
      const client1 = createMockClient(mockCmd1);
      const client2 = createMockClient(mockCmd2);

      await attachConsole(client1, 'pigs-abc', 80, 24);
      await attachConsole(client2, 'pigs-def', 80, 24);
      detachAll();

      expect(mockCmd1.stdout.removeAllListeners).toHaveBeenCalledWith('data');
      expect(mockCmd2.stdout.removeAllListeners).toHaveBeenCalledWith('data');
    });
  });

  describe('getActiveSessionNames', () => {
    it('should return empty array initially', () => {
      expect(getActiveSessionNames()).toEqual([]);
    });

    it('should return VM names of active sessions', async () => {
      const client1 = createMockClient();
      const client2 = createMockClient();

      await attachConsole(client1, 'pigs-abc', 80, 24);
      await attachConsole(client2, 'pigs-def', 80, 24);

      const names = getActiveSessionNames();
      expect(names).toContain('pigs-abc');
      expect(names).toContain('pigs-def');
      expect(names).toHaveLength(2);
    });
  });
});
