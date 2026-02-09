import { describe, it, expect } from 'bun:test';
import { Osc52Parser } from '../clipboard.ts';

describe('Osc52Parser', () => {
  it('passes through plain text unchanged', () => {
    const parser = new Osc52Parser();
    const result = parser.process('hello world');
    expect(result.cleanedData).toBe('hello world');
    expect(result.clipboardTexts).toEqual([]);
  });

  it('extracts OSC 52 with BEL terminator', () => {
    const parser = new Osc52Parser();
    const b64 = btoa('Hello World');
    const result = parser.process(`\x1b]52;c;${b64}\x07`);
    expect(result.cleanedData).toBe('');
    expect(result.clipboardTexts).toEqual(['Hello World']);
  });

  it('extracts OSC 52 with ST terminator (ESC \\)', () => {
    const parser = new Osc52Parser();
    const b64 = btoa('Hello World');
    const result = parser.process(`\x1b]52;c;${b64}\x1b\\`);
    expect(result.cleanedData).toBe('');
    expect(result.clipboardTexts).toEqual(['Hello World']);
  });

  it('handles mixed text and OSC 52', () => {
    const parser = new Osc52Parser();
    const b64 = btoa('copied');
    const result = parser.process(`before\x1b]52;c;${b64}\x07after`);
    expect(result.cleanedData).toBe('beforeafter');
    expect(result.clipboardTexts).toEqual(['copied']);
  });

  it('handles multiple OSC 52 sequences in one chunk', () => {
    const parser = new Osc52Parser();
    const b1 = btoa('first');
    const b2 = btoa('second');
    const result = parser.process(`\x1b]52;c;${b1}\x07\x1b]52;p;${b2}\x07`);
    expect(result.cleanedData).toBe('');
    expect(result.clipboardTexts).toEqual(['first', 'second']);
  });

  it('handles fragmented OSC 52 across chunks', () => {
    const parser = new Osc52Parser();
    const b64 = btoa('fragmented');
    const full = `\x1b]52;c;${b64}\x07`;
    const mid = Math.floor(full.length / 2);

    const r1 = parser.process(full.slice(0, mid));
    expect(r1.clipboardTexts).toEqual([]);

    const r2 = parser.process(full.slice(mid));
    expect(r2.clipboardTexts).toEqual(['fragmented']);
    expect(r1.cleanedData + r2.cleanedData).toBe('');
  });

  it('passes through non-52 OSC sequences untouched', () => {
    const parser = new Osc52Parser();
    const osc0 = '\x1b]0;my title\x07';
    const result = parser.process(osc0);
    expect(result.cleanedData).toBe(osc0);
    expect(result.clipboardTexts).toEqual([]);
  });

  it('handles non-52 OSC with ST terminator', () => {
    const parser = new Osc52Parser();
    const osc = '\x1b]0;my title\x1b\\';
    const result = parser.process(osc);
    expect(result.cleanedData).toBe(osc);
    expect(result.clipboardTexts).toEqual([]);
  });

  it('silently drops invalid base64', () => {
    const parser = new Osc52Parser();
    const result = parser.process('\x1b]52;c;!!!invalid!!!\x07');
    expect(result.cleanedData).toBe('');
    expect(result.clipboardTexts).toEqual([]);
  });

  it('rejects oversized payload', () => {
    const parser = new Osc52Parser();
    // 1MB+ of base64 data
    const bigPayload = 'A'.repeat(1024 * 1024 + 1);
    const result = parser.process(`\x1b]52;c;${bigPayload}\x07`);
    expect(result.cleanedData).toBe('');
    expect(result.clipboardTexts).toEqual([]);
  });

  it('handles OSC 52 without selection parameter', () => {
    const parser = new Osc52Parser();
    // Some programs send just the base64 after "52;"
    const b64 = btoa('no selection');
    const result = parser.process(`\x1b]52;${b64}\x07`);
    expect(result.cleanedData).toBe('');
    expect(result.clipboardTexts).toEqual(['no selection']);
  });

  it('handles text before and after with non-52 OSC in between', () => {
    const parser = new Osc52Parser();
    const b64 = btoa('clip');
    const input = `hello\x1b]0;title\x07\x1b]52;c;${b64}\x07world`;
    const result = parser.process(input);
    expect(result.cleanedData).toBe('hello\x1b]0;title\x07world');
    expect(result.clipboardTexts).toEqual(['clip']);
  });

  it('handles fragmented ESC at chunk boundary', () => {
    const parser = new Osc52Parser();

    // First chunk ends with just ESC
    const r1 = parser.process('text\x1b');
    // Second chunk completes the OSC 52
    const b64 = btoa('split');
    const r2 = parser.process(`]52;c;${b64}\x07more`);

    expect(r1.cleanedData + r2.cleanedData).toBe('textmore');
    expect([...r1.clipboardTexts, ...r2.clipboardTexts]).toEqual(['split']);
  });

  it('empty base64 produces no clipboard text', () => {
    const parser = new Osc52Parser();
    const result = parser.process('\x1b]52;c;\x07');
    expect(result.cleanedData).toBe('');
    expect(result.clipboardTexts).toEqual([]);
  });
});
