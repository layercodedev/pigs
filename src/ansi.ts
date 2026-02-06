/**
 * Strip ANSI escape sequences from a string.
 * Handles SGR (colors/styles), cursor movement, erase, OSC, and other common sequences.
 */
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, '');
}
