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
    `tmux new-window -d -t ${sessionName} -n ${shellEscape(windowName)} ${shellEscape(command)}`,
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
  execSync(`tmux select-window -t ${sessionName}:=${shellEscape(windowName)}`, {
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
    `tmux send-keys -t ${sessionName}:=${shellEscape(windowName)} ${shellEscape(keys)}`,
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
    `tmux send-keys -t ${sessionName}:=${shellEscape(windowName)} -l ${shellEscape(command)}`,
    { stdio: 'pipe' },
  );
  execSync(
    `tmux send-keys -t ${sessionName}:=${shellEscape(windowName)} Enter`,
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
      `tmux kill-window -t ${sessionName}:=${shellEscape(windowName)}`,
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
      `tmux capture-pane -t ${sessionName}:=${shellEscape(windowName)} -p`,
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
      `tmux rename-window -t ${sessionName}:=${shellEscape(oldName)} ${shellEscape(newName)}`,
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
  execSync(`tmux split-window -d -h -t ${sessionName}:0${cmdPart}`, { stdio: 'pipe' });
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
 * Check if a tmux window exists by name.
 * Uses list-windows + filter instead of display-message with a target,
 * because tmux target syntax interprets '.' and ':' as pane/session separators.
 */
export function windowExists(
  windowName: string,
  sessionName: string = SESSION_NAME,
): boolean {
  try {
    const result = execSync(
      `tmux list-windows -t ${sessionName} -F '#{window_name}'`,
      { stdio: 'pipe', encoding: 'utf-8' },
    );
    return result.trim().split('\n').includes(windowName);
  } catch {
    return false;
  }
}

/**
 * Move a branch's tmux window pane into the right pane position (0.1).
 * The window is joined into window 0 as a horizontal split.
 * Uses exact-match (={name}) syntax to avoid tmux misinterpreting '.' or ':' in names.
 */
export function joinWindowToRightPane(
  windowName: string,
  sessionName: string = SESSION_NAME,
): void {
  execSync(
    `tmux join-pane -h -s ${sessionName}:=${shellEscape(windowName)} -t ${sessionName}:0`,
    { stdio: 'pipe' },
  );
}

/**
 * Move the right pane (0.1) out to its own window with the given name.
 */
export function breakRightPaneToWindow(
  windowName: string,
  sessionName: string = SESSION_NAME,
): void {
  execSync(
    `tmux break-pane -d -s ${sessionName}:0.1 -n ${shellEscape(windowName)}`,
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
 * Kill the right pane (0.1).
 */
export function killRightPane(sessionName: string = SESSION_NAME): void {
  execSync(`tmux kill-pane -t ${sessionName}:0.1`, { stdio: 'pipe' });
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
 * Create a grid window that tiles multiple branch terminals using tmux panes.
 * Creates a new window, then splits it into panes — one per branch.
 * Each pane runs `tail -f` on the tmux capture output or shows the branch's tmux window.
 */
export function createGridWindow(
  branches: { name: string; worktreePath: string; displayLabel?: string }[],
  sessionName: string = SESSION_NAME,
): void {
  if (branches.length === 0) return;

  // Build a portable loop command (watch is not available on macOS by default)
  const loopCmd = (branchName: string) =>
    `while true; do clear; tmux capture-pane -t ${sessionName}:=${shellEscape(branchName)} -p 2>/dev/null || echo '(no output)'; sleep 1; done`;

  // Create the grid window with the first branch's pane
  const firstBranch = branches[0];
  const firstCmd = loopCmd(firstBranch.name);
  execSync(
    `tmux new-window -t ${sessionName} -n pigs-grid ${shellEscape(firstCmd)}`,
    { stdio: 'pipe' },
  );

  // Split for remaining branches
  for (let i = 1; i < branches.length; i++) {
    const branch = branches[i];
    const cmd = loopCmd(branch.name);
    // Alternate between horizontal and vertical splits for a grid layout
    execSync(
      `tmux split-window -t ${sessionName}:pigs-grid ${shellEscape(cmd)}`,
      { stdio: 'pipe' },
    );
    // Re-tile after each split so panes stay evenly distributed
    execSync(
      `tmux select-layout -t ${sessionName}:pigs-grid tiled`,
      { stdio: 'pipe' },
    );
  }

  // Add border labels to each pane showing the branch name
  try {
    const paneIds = execSync(
      `tmux list-panes -t ${sessionName}:pigs-grid -F '#{pane_index}'`,
      { stdio: 'pipe', encoding: 'utf-8' },
    ).trim().split('\n');
    for (let i = 0; i < Math.min(paneIds.length, branches.length); i++) {
      const label = branches[i].displayLabel ?? branches[i].name;
      const truncLabel = label.length > 30 ? label.slice(0, 27) + '...' : label;
      execSync(
        `tmux select-pane -t ${sessionName}:pigs-grid.${paneIds[i]} -T ${shellEscape(truncLabel)}`,
        { stdio: 'pipe' },
      );
    }
    // Enable pane border labels
    execSync(
      `tmux set-option -t ${sessionName}:pigs-grid pane-border-status top`,
      { stdio: 'pipe' },
    );
    execSync(
      `tmux set-option -t ${sessionName}:pigs-grid pane-border-format ' #{pane_title} '`,
      { stdio: 'pipe' },
    );
  } catch {
    // Pane titles are a nice-to-have, not critical
  }

  // Bind keys so the user can exit the grid from within tmux.
  // Use run-shell to chain commands (avoids tmux ';' escaping issues).
  // Don't bind Escape — terminal escape sequences trigger it spuriously.
  // Send 'G' to the TUI so it exits grid mode and cleans up.
  const exitShell = `tmux select-window -t ${sessionName}:0 && tmux send-keys -t ${sessionName}:0.0 G`;
  for (const key of ['q', 'G']) {
    try {
      execSync(`tmux bind -n ${key} run-shell '${exitShell}'`, { stdio: 'pipe' });
    } catch {
      // Non-critical
    }
  }

  // Focus the grid window
  execSync(`tmux select-window -t ${sessionName}:pigs-grid`, { stdio: 'pipe' });
}

/**
 * Kill the grid window if it exists.
 */
export function killGridWindow(sessionName: string = SESSION_NAME): void {
  // Remove temporary grid keybindings
  for (const key of ['q', 'G']) {
    try {
      execSync(`tmux unbind -n ${key}`, { stdio: 'pipe' });
    } catch {
      // May not be bound
    }
  }
  try {
    execSync(`tmux kill-window -t ${sessionName}:pigs-grid`, { stdio: 'pipe' });
  } catch {
    // Window may not exist
  }
}

/**
 * Check if the grid window exists.
 */
export function gridWindowExists(sessionName: string = SESSION_NAME): boolean {
  const result = spawnSync(
    'tmux',
    ['display-message', '-t', `${sessionName}:pigs-grid`, '-p', '#{window_id}'],
    { stdio: 'pipe' },
  );
  return result.status === 0;
}

/**
 * Configure tmux status bar, mouse support, and keybindings for the pigs session.
 */
export function configureStatusBar(sessionName: string = SESSION_NAME): void {
  const cmds = [
    // Enable mouse — click to switch panes and scroll
    `tmux set-option -t ${sessionName} mouse on`,
    // Status bar styling
    `tmux set-option -t ${sessionName} status-style 'bg=colour236,fg=colour248'`,
    `tmux set-option -t ${sessionName} status-left '#[bg=colour25,fg=white,bold] pigs #[default] '`,
    `tmux set-option -t ${sessionName} status-left-length 10`,
    `tmux set-option -t ${sessionName} status-right '#[fg=colour248] Ctrl-K: commands #[default] '`,
    `tmux set-option -t ${sessionName} status-right-length 25`,
    // Ctrl-K opens command menu — works from any pane by switching to the sidebar first
    `tmux bind -n C-k run-shell 'tmux select-window -t ${sessionName}:0 && tmux select-pane -t ${sessionName}:0.0 && tmux send-keys -t ${sessionName}:0.0 C-k'`,
  ];
  for (const cmd of cmds) {
    try {
      execSync(cmd, { stdio: 'pipe' });
    } catch {
      // Non-critical
    }
  }
}

/**
 * Escape a string for safe use in shell commands.
 */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
