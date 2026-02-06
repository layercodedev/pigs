/**
 * Per-VM prompt queue for sequential task execution.
 * When a VM finishes a task, the next queued prompt is sent automatically.
 */

const queues = new Map<string, string[]>();

/**
 * Add a prompt to the end of a VM's queue.
 */
export function enqueue(vmName: string, prompt: string): void {
  if (!queues.has(vmName)) {
    queues.set(vmName, []);
  }
  queues.get(vmName)!.push(prompt);
}

/**
 * Remove and return the next prompt from a VM's queue.
 * Returns undefined if the queue is empty.
 */
export function dequeue(vmName: string): string | undefined {
  const q = queues.get(vmName);
  if (!q || q.length === 0) return undefined;
  return q.shift();
}

/**
 * Peek at the next prompt without removing it.
 */
export function peek(vmName: string): string | undefined {
  const q = queues.get(vmName);
  if (!q || q.length === 0) return undefined;
  return q[0];
}

/**
 * Get the full queue for a VM (read-only copy).
 */
export function getQueue(vmName: string): string[] {
  return [...(queues.get(vmName) ?? [])];
}

/**
 * Get the number of queued prompts for a VM.
 */
export function queueSize(vmName: string): number {
  return queues.get(vmName)?.length ?? 0;
}

/**
 * Clear all queued prompts for a VM.
 */
export function clearQueue(vmName: string): void {
  queues.delete(vmName);
}

/**
 * Clear all queues (e.g., on shutdown).
 */
export function clearAllQueues(): void {
  queues.clear();
}
