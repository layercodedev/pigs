import { execSync, spawnSync } from 'node:child_process';

const SESSION_NAME = 'pigs';

/**
 * Check if we're currently inside a tmux session.
 */
export function insideTmux(): boolean {
  return !!process.env.TMUX;
}

/**
 * Get the pigs tmux session name.
 */
export function getSessionName(): string {
  return SESSION_NAME;
}

/**
 * Check if a tmux session exists.
 */
export function sessionExists(name: string = SESSION_NAME): boolean {
  const result = spawnSync('tmux', ['has-session', '-t', name], { stdio: 'pipe' });
  return result.status === 0;
}

/**
 * Create a new tmux session (detached) with the control pane as window 0.
 * If command is provided, it runs as the initial program in the session.
 */
export function createSession(name: string = SESSION_NAME, command?: string): void {
  const cmdPart = command ? ` ${command}` : '';
  execSync(`tmux new-session -d -s ${name} -x $(tput cols) -y $(tput lines)${cmdPart}`, {
    stdio: 'pipe',
  });
}

/**
 * Attach to an existing tmux session.
 */
export function attachSession(name: string = SESSION_NAME): void {
  // Replace current process with tmux attach
  const { status } = spawnSync('tmux', ['attach-session', '-t', name], {
    stdio: 'inherit',
  });
  if (status !== 0) {
    throw new Error(`Failed to attach to tmux session "${name}"`);
  }
}

/**
 * Create a new tmux window running a command.
 * Returns the window index.
 */
export function createWindow(
  windowName: string,
  command: string,
  sessionName: string = SESSION_NAME,
): string {
  execSync(
    `tmux new-window -t ${sessionName} -n ${shellEscape(windowName)} ${shellEscape(command)}`,
    { stdio: 'pipe' },
  );
  return windowName;
}

/**
 * Switch the active tmux window by name.
 */
export function switchToWindow(
  windowName: string,
  sessionName: string = SESSION_NAME,
): void {
  execSync(`tmux select-window -t ${sessionName}:${shellEscape(windowName)}`, {
    stdio: 'pipe',
  });
}

/**
 * Switch back to the control pane (window 0).
 */
export function switchToControlPane(sessionName: string = SESSION_NAME): void {
  execSync(`tmux select-window -t ${sessionName}:0`, { stdio: 'pipe' });
}

/**
 * Send keystrokes to a tmux window.
 */
export function sendKeys(
  windowName: string,
  keys: string,
  sessionName: string = SESSION_NAME,
): void {
  execSync(
    `tmux send-keys -t ${sessionName}:${shellEscape(windowName)} ${shellEscape(keys)}`,
    { stdio: 'pipe' },
  );
}

/**
 * Send literal text followed by Enter to a tmux window.
 */
export function sendCommand(
  windowName: string,
  command: string,
  sessionName: string = SESSION_NAME,
): void {
  execSync(
    `tmux send-keys -t ${sessionName}:${shellEscape(windowName)} -l ${shellEscape(command)}`,
    { stdio: 'pipe' },
  );
  execSync(
    `tmux send-keys -t ${sessionName}:${shellEscape(windowName)} Enter`,
    { stdio: 'pipe' },
  );
}

/**
 * Kill a tmux window by name.
 */
export function killWindow(
  windowName: string,
  sessionName: string = SESSION_NAME,
): void {
  try {
    execSync(
      `tmux kill-window -t ${sessionName}:${shellEscape(windowName)}`,
      { stdio: 'pipe' },
    );
  } catch {
    // Window may not exist
  }
}

/**
 * List all window names in a tmux session.
 */
export function listWindows(sessionName: string = SESSION_NAME): string[] {
  try {
    const result = execSync(
      `tmux list-windows -t ${sessionName} -F '#{window_name}'`,
      { stdio: 'pipe', encoding: 'utf-8' },
    );
    return result.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Capture the visible pane contents of a window.
 */
export function capturePane(
  windowName: string,
  sessionName: string = SESSION_NAME,
): string {
  try {
    return execSync(
      `tmux capture-pane -t ${sessionName}:${shellEscape(windowName)} -p`,
      { stdio: 'pipe', encoding: 'utf-8' },
    );
  } catch {
    return '';
  }
}

/**
 * Kill the entire tmux session.
 */
export function killSession(sessionName: string = SESSION_NAME): void {
  try {
    execSync(`tmux kill-session -t ${sessionName}`, { stdio: 'pipe' });
  } catch {
    // Session may not exist
  }
}

/**
 * Rename a tmux window.
 */
export function renameWindow(
  oldName: string,
  newName: string,
  sessionName: string = SESSION_NAME,
): void {
  try {
    execSync(
      `tmux rename-window -t ${sessionName}:${shellEscape(oldName)} ${shellEscape(newName)}`,
      { stdio: 'pipe' },
    );
  } catch {
    // Window may not exist
  }
}

/**
 * Get the currently active window name.
 */
export function getActiveWindow(sessionName: string = SESSION_NAME): string {
  try {
    return execSync(
      `tmux display-message -t ${sessionName} -p '#{window_name}'`,
      { stdio: 'pipe', encoding: 'utf-8' },
    ).trim();
  } catch {
    return '';
  }
}

/**
 * Create a right pane in window 0 by splitting horizontally.
 */
export function createRightPane(
  command?: string,
  sessionName: string = SESSION_NAME,
): void {
  const cmdPart = command ? ` ${shellEscape(command)}` : '';
  execSync(`tmux split-window -h -t ${sessionName}:0${cmdPart}`, { stdio: 'pipe' });
}

/**
 * Set the width of the left pane (pane 0.0) in columns.
 */
export function setLeftPaneWidth(
  cols: number,
  sessionName: string = SESSION_NAME,
): void {
  execSync(`tmux resize-pane -t ${sessionName}:0.0 -x ${cols}`, { stdio: 'pipe' });
}

/**
 * Respawn the right pane (0.1) with a new command, killing the current process.
 */
export function respawnRightPane(
  command: string,
  sessionName: string = SESSION_NAME,
): void {
  execSync(
    `tmux respawn-pane -k -t ${sessionName}:0.1 ${shellEscape(command)}`,
    { stdio: 'pipe' },
  );
}

/**
 * Capture the visible contents of the right pane (0.1).
 */
export function captureRightPane(sessionName: string = SESSION_NAME): string {
  try {
    return execSync(`tmux capture-pane -t ${sessionName}:0.1 -p`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    });
  } catch {
    return '';
  }
}

/**
 * Focus the right pane (0.1).
 */
export function focusRightPane(sessionName: string = SESSION_NAME): void {
  execSync(`tmux select-pane -t ${sessionName}:0.1`, { stdio: 'pipe' });
}

/**
 * Focus the left pane (0.0).
 */
export function focusLeftPane(sessionName: string = SESSION_NAME): void {
  execSync(`tmux select-pane -t ${sessionName}:0.0`, { stdio: 'pipe' });
}

/**
 * Send keystrokes to the right pane (0.1).
 */
export function sendKeysToRightPane(
  keys: string,
  sessionName: string = SESSION_NAME,
): void {
  execSync(
    `tmux send-keys -t ${sessionName}:0.1 ${shellEscape(keys)}`,
    { stdio: 'pipe' },
  );
}

/**
 * Check if the right pane (0.1) exists.
 */
export function rightPaneExists(sessionName: string = SESSION_NAME): boolean {
  const result = spawnSync('tmux', ['display-message', '-t', `${sessionName}:0.1`, '-p', '#{pane_id}'], {
    stdio: 'pipe',
  });
  return result.status === 0;
}

/**
 * Toggle zoom on a pane.
 */
export function zoomPane(
  paneTarget: string,
  sessionName: string = SESSION_NAME,
): void {
  execSync(`tmux resize-pane -Z -t ${sessionName}:${paneTarget}`, { stdio: 'pipe' });
}

/**
 * Check if a pane is currently zoomed.
 */
export function isZoomed(
  paneTarget: string,
  sessionName: string = SESSION_NAME,
): boolean {
  try {
    const result = execSync(
      `tmux display-message -t ${sessionName}:${paneTarget} -p '#{window_zoomed_flag}'`,
      { stdio: 'pipe', encoding: 'utf-8' },
    );
    return result.trim() === '1';
  } catch {
    return false;
  }
}

/**
 * Escape a string for safe use in shell commands.
 */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
