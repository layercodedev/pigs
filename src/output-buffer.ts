const MAX_LINES = 5000;

// Per-VM output buffers keyed by VM name
const buffers = new Map<string, string[]>();

/**
 * Append output data to a VM's buffer.
 * Splits on newlines and trims to MAX_LINES.
 */
export function appendOutput(vmName: string, data: string): void {
  let lines = buffers.get(vmName);
  if (!lines) {
    lines = [];
    buffers.set(vmName, lines);
  }
  const normalized = data.replace(/\r?\n/g, '\n');
  const newLines = normalized.split('\n');
  // Append the first fragment to the last buffered line (partial line continuation).
  // The last buffered line is partial (incomplete) only if it's non-empty —
  // an empty string at the end of lines[] means the previous chunk ended with \n.
  if (lines.length > 0 && newLines.length > 0 && lines[lines.length - 1] !== '') {
    lines[lines.length - 1] += newLines.shift();
  }
  lines.push(...newLines);
  if (lines.length > MAX_LINES) {
    buffers.set(vmName, lines.slice(lines.length - MAX_LINES));
  }
}

/**
 * Get all buffered output lines for a VM.
 */
export function getOutput(vmName: string): string[] {
  return buffers.get(vmName) ?? [];
}

/**
 * Clear the buffer for a VM.
 */
export function clearOutput(vmName: string): void {
  buffers.delete(vmName);
}

/**
 * Clear all buffers.
 */
export function clearAllOutputs(): void {
  buffers.clear();
}

export { MAX_LINES };
