import { execFile } from 'node:child_process';

/**
 * Copy text to the system clipboard using platform-native commands.
 * Returns true on success, false if no clipboard command is available.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  const commands: [string, string[]][] = process.platform === 'darwin'
    ? [['pbcopy', []]]
    : [['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];

  for (const [cmd, args] of commands) {
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = execFile(cmd, args, (err) => err ? reject(err) : resolve());
        proc.stdin?.write(text);
        proc.stdin?.end();
      });
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** Maximum base64 payload size (1 MB) to prevent memory abuse */
const MAX_PAYLOAD_SIZE = 1024 * 1024;

export interface Osc52Result {
  cleanedData: string;
  clipboardTexts: string[];
}

/**
 * Stateful parser that detects and extracts OSC 52 clipboard sequences from
 * terminal output, stripping them from the data passed to the terminal emulator.
 *
 * OSC 52 format: ESC ] 52 ; <sel> ; <base64> <terminator>
 * where terminator is BEL (\x07) or ST (ESC \)
 */
export class Osc52Parser {
  private buffer = '';

  /**
   * Process a chunk of terminal output.
   * Returns cleaned data (with OSC 52 stripped) and any decoded clipboard texts.
   */
  process(data: string): Osc52Result {
    const clipboardTexts: string[] = [];
    let input = this.buffer + data;
    this.buffer = '';
    let cleaned = '';

    while (input.length > 0) {
      // Look for ESC ] which starts any OSC sequence
      const escIdx = input.indexOf('\x1b]');
      if (escIdx === -1) {
        // No ESC] found, but a trailing lone ESC could be start of next chunk's ESC]
        if (input.endsWith('\x1b')) {
          cleaned += input.slice(0, -1);
          this.buffer = '\x1b';
        } else {
          cleaned += input;
        }
        break;
      }

      // Pass through everything before the ESC ]
      cleaned += input.slice(0, escIdx);
      input = input.slice(escIdx);

      // Check if we have enough to determine the OSC type (at least "ESC ] N ;")
      if (input.length < 4) {
        // Not enough data yet — buffer for next chunk
        this.buffer = input;
        break;
      }

      // Check if this is OSC 52
      if (input.startsWith('\x1b]52;')) {
        // Find the terminator: BEL (\x07) or ST (\x1b\\)
        const belIdx = input.indexOf('\x07', 5);
        const stIdx = input.indexOf('\x1b\\', 5);

        let termIdx = -1;
        let termLen = 0;
        if (belIdx !== -1 && stIdx !== -1) {
          if (belIdx < stIdx) {
            termIdx = belIdx;
            termLen = 1;
          } else {
            termIdx = stIdx;
            termLen = 2;
          }
        } else if (belIdx !== -1) {
          termIdx = belIdx;
          termLen = 1;
        } else if (stIdx !== -1) {
          termIdx = stIdx;
          termLen = 2;
        }

        if (termIdx === -1) {
          // No terminator yet — buffer for next chunk
          this.buffer = input;
          break;
        }

        // Extract the payload: everything between "52;<sel>;" and the terminator
        const body = input.slice(5, termIdx); // after "ESC]52;"
        const semiIdx = body.indexOf(';');
        const base64Data = semiIdx !== -1 ? body.slice(semiIdx + 1) : body;

        // Decode if within size limit and valid base64
        if (base64Data.length <= MAX_PAYLOAD_SIZE) {
          try {
            const decoded = atob(base64Data);
            if (decoded.length > 0) {
              clipboardTexts.push(decoded);
            }
          } catch {
            // Invalid base64 — silently drop
          }
        }

        // Skip past this entire OSC 52 sequence
        input = input.slice(termIdx + termLen);
      } else {
        // Non-52 OSC sequence — pass through until we find its terminator
        const belIdx = input.indexOf('\x07', 2);
        const stIdx = input.indexOf('\x1b\\', 2);

        let termIdx = -1;
        let termLen = 0;
        if (belIdx !== -1 && stIdx !== -1) {
          if (belIdx < stIdx) {
            termIdx = belIdx;
            termLen = 1;
          } else {
            termIdx = stIdx;
            termLen = 2;
          }
        } else if (belIdx !== -1) {
          termIdx = belIdx;
          termLen = 1;
        } else if (stIdx !== -1) {
          termIdx = stIdx;
          termLen = 2;
        }

        if (termIdx === -1) {
          // No terminator yet — buffer for next chunk
          this.buffer = input;
          break;
        }

        // Pass through the entire non-52 OSC sequence
        cleaned += input.slice(0, termIdx + termLen);
        input = input.slice(termIdx + termLen);
      }
    }

    return { cleanedData: cleaned, clipboardTexts };
  }
}
