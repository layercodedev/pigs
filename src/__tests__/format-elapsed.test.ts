import { describe, it, expect } from 'bun:test';
import { formatElapsed } from '../tui.ts';

describe('formatElapsed', () => {
  it('should return empty string for undefined startTime', () => {
    expect(formatElapsed(undefined, Date.now())).toBe('');
  });

  it('should return 0s for same time', () => {
    const now = 1000000;
    expect(formatElapsed(now, now)).toBe('0s');
  });

  it('should format seconds only for under 1 minute', () => {
    const now = 1000000;
    expect(formatElapsed(now - 5000, now)).toBe('5s');
    expect(formatElapsed(now - 45000, now)).toBe('45s');
  });

  it('should format minutes and seconds for under 1 hour', () => {
    const now = 1000000;
    expect(formatElapsed(now - 90000, now)).toBe('1m30s');
    expect(formatElapsed(now - 60000, now)).toBe('1m00s');
    expect(formatElapsed(now - 605000, now)).toBe('10m05s');
  });

  it('should format hours and minutes for 1 hour or more', () => {
    const now = 1000000;
    expect(formatElapsed(now - 3600000, now)).toBe('1h00m');
    expect(formatElapsed(now - 5400000, now)).toBe('1h30m');
    expect(formatElapsed(now - 7500000, now)).toBe('2h05m');
  });

  it('should clamp negative elapsed to 0s', () => {
    const now = 1000000;
    expect(formatElapsed(now + 5000, now)).toBe('0s');
  });

  it('should handle exactly 59 seconds', () => {
    const now = 1000000;
    expect(formatElapsed(now - 59000, now)).toBe('59s');
  });

  it('should handle exactly 59 minutes 59 seconds', () => {
    const now = 1000000;
    expect(formatElapsed(now - 3599000, now)).toBe('59m59s');
  });

  it('should pad seconds with leading zero in minute format', () => {
    const now = 1000000;
    expect(formatElapsed(now - 63000, now)).toBe('1m03s');
  });

  it('should pad minutes with leading zero in hour format', () => {
    const now = 1000000;
    expect(formatElapsed(now - 3900000, now)).toBe('1h05m');
  });
});
