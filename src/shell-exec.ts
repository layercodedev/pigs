import { execSync } from 'node:child_process';

/**
 * Run a shell command in a directory and return the result.
 */
export function shellExec(cwd: string, script: string): { stdout: string } {
  const stdout = execSync(script, {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  return { stdout };
}
