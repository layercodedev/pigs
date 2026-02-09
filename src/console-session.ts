import type { SpritesClient, SpriteCommand } from '@fly/sprites';

export interface ConsoleSession {
  vmName: string;
  command: SpriteCommand;
  started: boolean;
}

// Active local connections keyed by VM name
const sessions = new Map<string, ConsoleSession>();

// Remote session IDs keyed by VM name (persist across local disconnects)
const remoteSessionIds = new Map<string, string>();

/**
 * Get or create a detachable console session for a VM.
 * Uses sprites' built-in detachable sessions so reattaching
 * reconnects to the same shell with state preserved.
 */
export async function attachConsole(
  client: SpritesClient,
  vmName: string,
  cols: number,
  rows: number,
): Promise<ConsoleSession> {
  const existing = sessions.get(vmName);
  if (existing?.started) {
    return existing;
  }

  const sprite = client.sprite(vmName);
  const existingSessionId = remoteSessionIds.get(vmName);

  let command: SpriteCommand;

  if (existingSessionId) {
    // Verify the remote session is still alive
    let alive = false;
    try {
      const remoteSessions = await sprite.listSessions();
      alive = remoteSessions.some(s => s.id === existingSessionId && s.isActive);
    } catch {
      // If listing fails, assume dead
    }

    if (alive) {
      // Reattach to existing remote session via sessionId param
      command = sprite.spawn('bash', [], {
        tty: true,
        cols,
        rows,
        sessionId: existingSessionId,
      });
    } else {
      // Session is dead, create a new detachable one
      remoteSessionIds.delete(vmName);
      command = sprite.spawn('bash', [], {
        tty: true,
        cols,
        rows,
        detachable: true,
      });
    }
  } else {
    // First connect — create a detachable session
    command = sprite.spawn('bash', [], {
      tty: true,
      cols,
      rows,
      detachable: true,
    });
  }

  // Wait for the WebSocket to be ready
  await new Promise<void>((resolve, reject) => {
    command.on('spawn', resolve);
    command.on('error', reject);
  });

  // Discover and store the remote session ID for future reattach
  if (!remoteSessionIds.has(vmName)) {
    try {
      const remoteSessions = await sprite.listSessions();
      const active = remoteSessions
        .filter(s => s.isActive)
        .sort((a, b) => b.created.getTime() - a.created.getTime());
      if (active.length > 0) {
        remoteSessionIds.set(vmName, active[0].id);
      }
    } catch {
      // Best effort
    }
  }

  const session: ConsoleSession = {
    vmName,
    command,
    started: true,
  };
  sessions.set(vmName, session);
  return session;
}

/**
 * Detach from a console session without killing the remote session.
 * Just closes the local WebSocket; the remote session stays alive for reattach.
 */
export function detachConsole(vmName: string): void {
  const session = sessions.get(vmName);
  if (session) {
    try {
      session.command.kill();
    } catch {
      // Ignore — kill() just closes the WebSocket
    }
    sessions.delete(vmName);
  }
}

/**
 * Kill and remove a console session, including the remote session ID.
 * Used when deleting a VM entirely.
 */
export function destroyConsole(vmName: string): void {
  detachConsole(vmName);
  remoteSessionIds.delete(vmName);
}

/**
 * Clean up the local connection but preserve the remote session ID for reattach.
 */
export function cleanupLocalSession(vmName: string): void {
  sessions.delete(vmName);
}

/**
 * Get an existing session for a VM.
 */
export function getSession(vmName: string): ConsoleSession | undefined {
  return sessions.get(vmName);
}

/**
 * Resize the TTY for a VM's console session.
 */
export function resizeConsole(vmName: string, cols: number, rows: number): void {
  const session = sessions.get(vmName);
  if (session?.started) {
    session.command.resize(cols, rows);
  }
}

/**
 * Write data to a VM's console stdin.
 */
export function writeToConsole(vmName: string, data: string | Buffer): boolean {
  const session = sessions.get(vmName);
  if (session?.started) {
    return session.command.stdin.write(data);
  }
  return false;
}

/**
 * Detach all sessions (for graceful exit).
 */
export function detachAll(): void {
  for (const vmName of sessions.keys()) {
    detachConsole(vmName);
  }
}

/**
 * Get all active session VM names.
 */
export function getActiveSessionNames(): string[] {
  return Array.from(sessions.keys());
}
