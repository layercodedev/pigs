import { describe, it, expect } from 'bun:test';
import { stripAnsi } from '../ansi.ts';

describe('stripAnsi', () => {
  it('should return plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  it('should strip SGR color codes', () => {
    expect(stripAnsi('\x1b[31mred text\x1b[0m')).toBe('red text');
  });

  it('should strip bold/italic/underline codes', () => {
    expect(stripAnsi('\x1b[1mbold\x1b[22m \x1b[3mitalic\x1b[23m')).toBe('bold italic');
  });

  it('should strip 256-color codes', () => {
    expect(stripAnsi('\x1b[38;5;196mred\x1b[0m')).toBe('red');
  });

  it('should strip RGB/truecolor codes', () => {
    expect(stripAnsi('\x1b[38;2;255;0;0mred\x1b[0m')).toBe('red');
  });

  it('should strip cursor movement sequences', () => {
    expect(stripAnsi('\x1b[2Aup two\x1b[3Bdown three')).toBe('up twodown three');
  });

  it('should strip erase sequences', () => {
    expect(stripAnsi('\x1b[2Jclear\x1b[K')).toBe('clear');
  });

  it('should handle empty string', () => {
    expect(stripAnsi('')).toBe('');
  });

  it('should strip multiple sequences in one string', () => {
    expect(stripAnsi('\x1b[32m✓\x1b[0m \x1b[1mPassed\x1b[22m \x1b[90m(3 tests)\x1b[0m'))
      .toBe('✓ Passed (3 tests)');
  });

  it('should strip cursor position save/restore', () => {
    expect(stripAnsi('\x1b[stext\x1b[u')).toBe('text');
  });

  it('should handle string with only ANSI codes', () => {
    expect(stripAnsi('\x1b[31m\x1b[0m')).toBe('');
  });

  it('should strip scroll region sequences', () => {
    expect(stripAnsi('\x1b[1;24rtext')).toBe('text');
  });
});
