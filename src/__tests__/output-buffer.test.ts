import { describe, it, expect, beforeEach } from 'bun:test';
import { appendOutput, getOutput, clearOutput, clearAllOutputs, MAX_LINES } from '../output-buffer.ts';

beforeEach(() => {
  clearAllOutputs();
});

describe('appendOutput', () => {
  it('should store output lines for a VM', () => {
    appendOutput('vm1', 'hello\nworld');
    expect(getOutput('vm1')).toEqual(['hello', 'world']);
  });

  it('should append to existing buffer', () => {
    appendOutput('vm1', 'line1\n');
    appendOutput('vm1', 'line2\n');
    expect(getOutput('vm1')).toEqual(['line1', '', 'line2', '']);
  });

  it('should handle trailing newlines', () => {
    appendOutput('vm1', 'hello\n');
    expect(getOutput('vm1')).toEqual(['hello', '']);
  });

  it('should handle \\r\\n line endings', () => {
    appendOutput('vm1', 'hello\r\nworld\r\n');
    expect(getOutput('vm1')).toEqual(['hello', 'world', '']);
  });

  it('should keep separate buffers per VM', () => {
    appendOutput('vm1', 'from-vm1');
    appendOutput('vm2', 'from-vm2');
    expect(getOutput('vm1')).toEqual(['from-vm1']);
    expect(getOutput('vm2')).toEqual(['from-vm2']);
  });

  it('should trim to MAX_LINES when buffer exceeds limit', () => {
    const lines = Array.from({ length: MAX_LINES + 100 }, (_, i) => `line-${i}`);
    appendOutput('vm1', lines.join('\n'));
    const result = getOutput('vm1');
    expect(result.length).toBe(MAX_LINES);
    expect(result[0]).toBe('line-100');
    expect(result[result.length - 1]).toBe(`line-${MAX_LINES + 99}`);
  });
});

describe('getOutput', () => {
  it('should return empty array for unknown VM', () => {
    expect(getOutput('nonexistent')).toEqual([]);
  });
});

describe('clearOutput', () => {
  it('should clear buffer for a specific VM', () => {
    appendOutput('vm1', 'data1');
    appendOutput('vm2', 'data2');
    clearOutput('vm1');
    expect(getOutput('vm1')).toEqual([]);
    expect(getOutput('vm2')).toEqual(['data2']);
  });

  it('should be safe to clear non-existent VM', () => {
    clearOutput('nonexistent');
    expect(getOutput('nonexistent')).toEqual([]);
  });
});

describe('clearAllOutputs', () => {
  it('should clear all VM buffers', () => {
    appendOutput('vm1', 'data1');
    appendOutput('vm2', 'data2');
    clearAllOutputs();
    expect(getOutput('vm1')).toEqual([]);
    expect(getOutput('vm2')).toEqual([]);
  });
});
