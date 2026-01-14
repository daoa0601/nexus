/**
 * Subprocess utilities for spawning Claude CLI
 */

import { spawn, type SpawnOptions } from 'child_process';

/**
 * Result from Claude CLI subprocess
 */
export interface ClaudeResult {
  result: string;
  model?: string;
  session_id?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  latencyMs: number;
}

/**
 * Options for spawning Claude CLI
 */
export interface SpawnClaudeOptions {
  env?: Record<string, string | undefined>;
  timeout?: number;
  cwd?: string;
  cliPath?: string;
}

/**
 * Check if Claude CLI is available
 */
export async function isClaudeCliAvailable(cliPath?: string): Promise<boolean> {
  const cmd = cliPath || 'claude';

  return new Promise((resolve) => {
    const proc = spawn(cmd, ['--version'], {
      timeout: 5000,
      stdio: 'pipe',
    });

    proc.on('close', (code) => {
      resolve(code === 0);
    });

    proc.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Spawn Claude CLI with given arguments
 *
 * @param args - CLI arguments (e.g., ['-p', 'Hello', '--output-format', 'json'])
 * @param options - Spawn options
 * @returns Promise resolving to ClaudeResult
 */
export async function spawnClaude(
  args: string[],
  options?: SpawnClaudeOptions
): Promise<ClaudeResult> {
  const startTime = Date.now();
  const cmd = options?.cliPath || 'claude';

  const spawnOptions: SpawnOptions = {
    env: { ...process.env, ...options?.env },
    timeout: options?.timeout || 120000, // 2 minute default
    cwd: options?.cwd,
    // IMPORTANT: Use 'ignore' for stdin to prevent process hanging
    // waiting for input that will never come
    stdio: ['ignore', 'pipe', 'pipe'],
  };

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, spawnOptions);

    let stdout = '';
    let stderr = '';

    if (proc.stdout) {
      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
    }

    proc.on('error', (error) => {
      reject(new Error(`Failed to spawn Claude CLI: ${error.message}`));
    });

    proc.on('close', (code) => {
      const latencyMs = Date.now() - startTime;

      if (code !== 0) {
        reject(
          new Error(`Claude CLI exited with code ${code}: ${stderr || stdout}`)
        );
        return;
      }

      // Try to parse JSON output
      const trimmedOutput = stdout.trim();
      try {
        const parsed = JSON.parse(trimmedOutput);
        resolve({
          result: parsed.result || parsed.content || trimmedOutput,
          model: parsed.model,
          session_id: parsed.session_id,
          usage: parsed.usage,
          latencyMs,
        });
      } catch {
        // Not JSON, return raw output
        resolve({
          result: trimmedOutput,
          latencyMs,
        });
      }
    });
  });
}

/**
 * Format messages array into a prompt string for Claude CLI
 */
export function formatMessagesForCli(
  messages: Array<{ role: string; content: string }>
): string {
  // For simple cases, just use the last user message
  const userMessages = messages.filter((m) => m.role === 'user');
  if (userMessages.length === 1 && messages.length <= 2 && userMessages[0]) {
    return userMessages[0].content;
  }

  // For multi-turn, format as conversation
  return messages
    .map((m) => {
      switch (m.role) {
        case 'system':
          return `[System]: ${m.content}`;
        case 'user':
          return `[User]: ${m.content}`;
        case 'assistant':
          return `[Assistant]: ${m.content}`;
        default:
          return m.content;
      }
    })
    .join('\n\n');
}
