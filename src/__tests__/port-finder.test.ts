import { describe, it, expect } from 'bun:test';
import { findOpenPort } from '../port-finder.ts';
import { createServer } from 'node:net';

describe('findOpenPort', () => {
  it('returns a valid port number', async () => {
    const port = await findOpenPort(3000);
    expect(port).toBeGreaterThanOrEqual(3000);
    expect(port).toBeLessThan(3100);
  });

  it('skips ports that are in use', async () => {
    // Occupy port 4000
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(4000, '127.0.0.1', () => resolve());
    });

    try {
      const port = await findOpenPort(4000);
      expect(port).toBeGreaterThan(4000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns the first available port', async () => {
    // Use a high port range unlikely to be occupied
    const port = await findOpenPort(18900);
    expect(port).toBe(18900);
  });
});
