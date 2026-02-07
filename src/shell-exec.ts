import type { Sprite, ExecResult } from '@fly/sprites';

/**
 * Run a shell command on a sprite via bash -c.
 *
 * sprite.exec() splits on whitespace and doesn't use a shell,
 * so pipes, redirects, &&/||, and multi-line scripts all need
 * to go through this wrapper instead.
 */
export function shellExec(sprite: Sprite, script: string): Promise<ExecResult> {
  return sprite.execFile('bash', ['-c', script]);
}
