import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  loadHistory,
  addToHistory,
  resetCursor,
  historyUp,
  historyDown,
  getHistory,
  _clearHistory,
} from '../prompt-history.ts';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

const mockedReadFile = vi.mocked(readFile);
const mockedWriteFile = vi.mocked(writeFile);

beforeEach(() => {
  _clearHistory();
  vi.clearAllMocks();
});

describe('prompt-history', () => {
  describe('loadHistory', () => {
    it('should load history from file', async () => {
      mockedReadFile.mockResolvedValueOnce(JSON.stringify(['prompt1', 'prompt2']));
      await loadHistory();
      expect(getHistory()).toEqual(['prompt1', 'prompt2']);
    });

    it('should start empty when no file exists', async () => {
      mockedReadFile.mockRejectedValueOnce(new Error('ENOENT'));
      await loadHistory();
      expect(getHistory()).toEqual([]);
    });

    it('should ignore non-string entries', async () => {
      mockedReadFile.mockResolvedValueOnce(JSON.stringify(['good', 42, null, 'also good']));
      await loadHistory();
      expect(getHistory()).toEqual(['good', 'also good']);
    });
  });

  describe('addToHistory', () => {
    it('should add a prompt to history', async () => {
      await addToHistory('hello world');
      expect(getHistory()).toEqual(['hello world']);
    });

    it('should persist to file', async () => {
      await addToHistory('test prompt');
      expect(mockedWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('history.json'),
        JSON.stringify(['test prompt']),
        'utf-8',
      );
    });

    it('should deduplicate entries (move to end)', async () => {
      await addToHistory('first');
      await addToHistory('second');
      await addToHistory('first');
      expect(getHistory()).toEqual(['second', 'first']);
    });

    it('should ignore empty prompts', async () => {
      await addToHistory('');
      await addToHistory('   ');
      expect(getHistory()).toEqual([]);
    });

    it('should trim whitespace', async () => {
      await addToHistory('  hello  ');
      expect(getHistory()).toEqual(['hello']);
    });
  });

  describe('historyUp', () => {
    it('should return null when history is empty', () => {
      expect(historyUp('')).toBeNull();
    });

    it('should return the most recent entry first', async () => {
      await addToHistory('first');
      await addToHistory('second');
      resetCursor();
      expect(historyUp('')).toBe('second');
    });

    it('should navigate to older entries', async () => {
      await addToHistory('first');
      await addToHistory('second');
      await addToHistory('third');
      resetCursor();
      expect(historyUp('')).toBe('third');
      expect(historyUp('')).toBe('second');
      expect(historyUp('')).toBe('first');
    });

    it('should return null at oldest entry', async () => {
      await addToHistory('only');
      resetCursor();
      historyUp('');
      expect(historyUp('')).toBeNull();
    });

    it('should save draft when first navigating up', async () => {
      await addToHistory('old');
      resetCursor();
      historyUp('my draft');
      const result = historyDown();
      expect(result).toBe('my draft');
    });
  });

  describe('historyDown', () => {
    it('should return null when at bottom', () => {
      expect(historyDown()).toBeNull();
    });

    it('should navigate to newer entries', async () => {
      await addToHistory('first');
      await addToHistory('second');
      await addToHistory('third');
      resetCursor();
      historyUp('');
      historyUp('');
      historyUp('');
      expect(historyDown()).toBe('second');
      expect(historyDown()).toBe('third');
    });

    it('should restore draft at bottom', async () => {
      await addToHistory('old');
      resetCursor();
      historyUp('my typing');
      expect(historyDown()).toBe('my typing');
    });

    it('should return null after restoring draft', async () => {
      await addToHistory('old');
      resetCursor();
      historyUp('draft');
      historyDown();
      expect(historyDown()).toBeNull();
    });
  });

  describe('resetCursor', () => {
    it('should reset navigation state', async () => {
      await addToHistory('first');
      await addToHistory('second');
      resetCursor();
      historyUp('');
      resetCursor();
      // After reset, should start from most recent again
      expect(historyUp('')).toBe('second');
    });
  });
});
