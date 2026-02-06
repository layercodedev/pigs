import { describe, it, expect, beforeEach } from 'vitest';
import { enqueue, dequeue, peek, getQueue, queueSize, clearQueue, clearAllQueues, removeFromQueue } from '../prompt-queue.js';

describe('prompt-queue', () => {
  beforeEach(() => {
    clearAllQueues();
  });

  it('should enqueue and dequeue a single prompt', () => {
    enqueue('vm1', 'fix the bug');
    expect(dequeue('vm1')).toBe('fix the bug');
  });

  it('should return undefined when dequeuing from empty queue', () => {
    expect(dequeue('vm1')).toBeUndefined();
  });

  it('should dequeue prompts in FIFO order', () => {
    enqueue('vm1', 'first');
    enqueue('vm1', 'second');
    enqueue('vm1', 'third');
    expect(dequeue('vm1')).toBe('first');
    expect(dequeue('vm1')).toBe('second');
    expect(dequeue('vm1')).toBe('third');
    expect(dequeue('vm1')).toBeUndefined();
  });

  it('should peek without removing', () => {
    enqueue('vm1', 'peek me');
    expect(peek('vm1')).toBe('peek me');
    expect(peek('vm1')).toBe('peek me');
    expect(queueSize('vm1')).toBe(1);
  });

  it('should return undefined when peeking empty queue', () => {
    expect(peek('vm1')).toBeUndefined();
  });

  it('should track queue size correctly', () => {
    expect(queueSize('vm1')).toBe(0);
    enqueue('vm1', 'a');
    expect(queueSize('vm1')).toBe(1);
    enqueue('vm1', 'b');
    expect(queueSize('vm1')).toBe(2);
    dequeue('vm1');
    expect(queueSize('vm1')).toBe(1);
    dequeue('vm1');
    expect(queueSize('vm1')).toBe(0);
  });

  it('should isolate queues per VM', () => {
    enqueue('vm1', 'prompt-for-vm1');
    enqueue('vm2', 'prompt-for-vm2');
    expect(queueSize('vm1')).toBe(1);
    expect(queueSize('vm2')).toBe(1);
    expect(dequeue('vm1')).toBe('prompt-for-vm1');
    expect(dequeue('vm2')).toBe('prompt-for-vm2');
  });

  it('should return a copy from getQueue', () => {
    enqueue('vm1', 'a');
    enqueue('vm1', 'b');
    const q = getQueue('vm1');
    expect(q).toEqual(['a', 'b']);
    // Mutating the returned array shouldn't affect the original
    q.push('c');
    expect(queueSize('vm1')).toBe(2);
  });

  it('should return empty array from getQueue for unknown VM', () => {
    expect(getQueue('unknown')).toEqual([]);
  });

  it('should clear a single VM queue', () => {
    enqueue('vm1', 'a');
    enqueue('vm1', 'b');
    enqueue('vm2', 'c');
    clearQueue('vm1');
    expect(queueSize('vm1')).toBe(0);
    expect(queueSize('vm2')).toBe(1);
  });

  it('should clear all queues', () => {
    enqueue('vm1', 'a');
    enqueue('vm2', 'b');
    enqueue('vm3', 'c');
    clearAllQueues();
    expect(queueSize('vm1')).toBe(0);
    expect(queueSize('vm2')).toBe(0);
    expect(queueSize('vm3')).toBe(0);
  });

  it('should handle clearing non-existent queue gracefully', () => {
    clearQueue('nonexistent');
    expect(queueSize('nonexistent')).toBe(0);
  });

  it('should handle queueSize for unknown VM', () => {
    expect(queueSize('unknown')).toBe(0);
  });

  it('should remove a prompt at a specific index', () => {
    enqueue('vm1', 'first');
    enqueue('vm1', 'second');
    enqueue('vm1', 'third');
    const removed = removeFromQueue('vm1', 1);
    expect(removed).toBe('second');
    expect(getQueue('vm1')).toEqual(['first', 'third']);
    expect(queueSize('vm1')).toBe(2);
  });

  it('should return undefined when removing from out-of-range index', () => {
    enqueue('vm1', 'only');
    expect(removeFromQueue('vm1', 5)).toBeUndefined();
    expect(removeFromQueue('vm1', -1)).toBeUndefined();
    expect(queueSize('vm1')).toBe(1);
  });

  it('should return undefined when removing from unknown VM', () => {
    expect(removeFromQueue('unknown', 0)).toBeUndefined();
  });

  it('should remove the first item correctly', () => {
    enqueue('vm1', 'a');
    enqueue('vm1', 'b');
    enqueue('vm1', 'c');
    expect(removeFromQueue('vm1', 0)).toBe('a');
    expect(getQueue('vm1')).toEqual(['b', 'c']);
  });

  it('should remove the last item correctly', () => {
    enqueue('vm1', 'a');
    enqueue('vm1', 'b');
    enqueue('vm1', 'c');
    expect(removeFromQueue('vm1', 2)).toBe('c');
    expect(getQueue('vm1')).toEqual(['a', 'b']);
  });
});
