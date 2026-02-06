import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SETTINGS_DIR = join(homedir(), '.pigs');
const HISTORY_PATH = join(SETTINGS_DIR, 'history.json');
const MAX_HISTORY = 100;

let history: string[] = [];
let cursor = -1;
let draft = '';

/**
 * Load prompt history from ~/.pigs/history.json.
 */
export async function loadHistory(): Promise<void> {
  try {
    const data = await readFile(HISTORY_PATH, 'utf-8');
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      history = parsed.filter((s): s is string => typeof s === 'string');
    }
  } catch {
    // No history file yet — start empty
  }
}

/**
 * Save prompt history to ~/.pigs/history.json.
 */
async function saveHistory(): Promise<void> {
  try {
    await mkdir(SETTINGS_DIR, { recursive: true });
    await writeFile(HISTORY_PATH, JSON.stringify(history), 'utf-8');
  } catch {
    // Best-effort persistence
  }
}

/**
 * Add a prompt to history (deduplicates, most recent last).
 */
export async function addToHistory(prompt: string): Promise<void> {
  const trimmed = prompt.trim();
  if (!trimmed) return;

  // Remove duplicate if it exists
  const idx = history.indexOf(trimmed);
  if (idx !== -1) {
    history.splice(idx, 1);
  }

  history.push(trimmed);

  // Cap history size
  if (history.length > MAX_HISTORY) {
    history = history.slice(-MAX_HISTORY);
  }

  resetCursor();
  await saveHistory();
}

/**
 * Reset cursor position (called when opening a prompt dialog).
 */
export function resetCursor(): void {
  cursor = -1;
  draft = '';
}

/**
 * Navigate up (older) in history. Returns the prompt string to display,
 * or null if there is no more history.
 *
 * @param currentValue The current text in the input field
 */
export function historyUp(currentValue: string): string | null {
  if (history.length === 0) return null;

  // Save draft when first navigating up
  if (cursor === -1) {
    draft = currentValue;
  }

  const nextCursor = cursor === -1
    ? history.length - 1
    : Math.max(cursor - 1, 0);

  if (nextCursor === cursor) return null; // already at oldest

  cursor = nextCursor;
  return history[cursor];
}

/**
 * Navigate down (newer) in history. Returns the prompt string to display,
 * or null if already at the bottom (restores draft).
 */
export function historyDown(): string | null {
  if (cursor === -1) return null; // already at bottom

  if (cursor >= history.length - 1) {
    // Back to draft
    cursor = -1;
    return draft;
  }

  cursor++;
  return history[cursor];
}

/**
 * Get the current history entries (for testing).
 */
export function getHistory(): readonly string[] {
  return history;
}

/**
 * Clear history (for testing).
 */
export function _clearHistory(): void {
  history = [];
  cursor = -1;
  draft = '';
}
