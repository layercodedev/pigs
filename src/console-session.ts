import type { SpritesClient, SpriteCommand } from '@fly/sprites';

export interface ConsoleSession {
  vmName: string;
  command: SpriteCommand;
  started: boolean;
}

// Active sessions keyed by VM name
const sessions = new Map<string, ConsoleSession>();

/**
 * Get or create a TTY console session for a VM.
 * Spawns bash with TTY enabled and starts the command.
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
  const command = sprite.spawn('bash', [], {
    tty: true,
    cols,
    rows,
  });
  // spawn() auto-starts the command; wait for the WebSocket to be ready
  await new Promise<void>((resolve, reject) => {
    command.on('spawn', resolve);
    command.on('error', reject);
  });

  const session: ConsoleSession = {
    vmName,
    command,
    started: true,
  };
  sessions.set(vmName, session);
  return session;
}

/**
 * Detach from a console session without killing it.
 * Listeners continue buffering output while detached.
 * The mode check in listeners prevents writing to the display.
 */
export function detachConsole(vmName: string): void {
  // Listeners continue buffering output while detached.
  // The mode check in listeners prevents writing to the display.
}

/**
 * Kill and remove a console session.
 */
export function destroyConsole(vmName: string): void {
  const session = sessions.get(vmName);
  if (session) {
    try {
      session.command.kill();
    } catch {
      // Ignore errors on kill (may already be dead)
    }
    sessions.delete(vmName);
  }
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
