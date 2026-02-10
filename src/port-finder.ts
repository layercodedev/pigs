import { createServer } from 'node:net';

/**
 * Find an available port starting from the given base.
 * Tries ports sequentially until one is free.
 */
export async function findOpenPort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
    const available = await isPortAvailable(port);
    if (available) return port;
  }
  throw new Error(`No open port found in range ${startPort}-${startPort + 99}`);
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}
