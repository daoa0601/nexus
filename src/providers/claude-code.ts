/**
 * Claude Code subprocess provider
 *
 * Uses the `claude` CLI to leverage existing Claude Code subscription
 * instead of pay-per-token Anthropic API.
 */

import type { CompletionParams, CompletionResponse } from '../types.ts';
import { LLMProvider } from './base.ts';
import {
  spawnClaude,
  isClaudeCliAvailable,
  formatMessagesForCli,
} from '../utils/subprocess.ts';

export interface ClaudeCodeProviderConfig {
  /** Override path to claude binary */
  cliPath?: string;
  /** Timeout for CLI commands in ms (default: 120000) */
  timeout?: number;
}

/**
 * Claude Code provider using subprocess
 *
 * This provider spawns `claude -p` commands to use Claude models
 * through your existing Claude Code subscription, avoiding pay-per-token
 * API charges.
 *
 * Available models depend on your Claude Code plan:
 * - claude-haiku-4-5: Fast, economical
 * - claude-sonnet-4-5: Balanced (default)
 * - claude-opus-4-5: Best quality
 */
export class ClaudeCodeProvider extends LLMProvider {
  readonly id = 'claude-code';
  readonly name = 'Claude Code (Subscription)';

  private config: ClaudeCodeProviderConfig;
  private availableModels: string[] = [
    'claude-haiku-4-5',
    'claude-sonnet-4-5',
    'claude-opus-4-5',
  ];

  constructor(config: ClaudeCodeProviderConfig = {}) {
    super();
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    return isClaudeCliAvailable(this.config.cliPath);
  }

  async getModels(): Promise<string[]> {
    // Claude Code typically provides access to all Claude models
    // The actual availability depends on the user's subscription
    return this.availableModels;
  }

  async complete(params: CompletionParams): Promise<CompletionResponse> {
    const startTime = Date.now();

    // Format messages into a prompt string
    const formattedParams = this.formatMessages(params);
    const prompt = formatMessagesForCli(formattedParams.messages);

    // Build CLI arguments
    const args = ['-p', prompt, '--output-format', 'json'];

    // Add model selection if specified
    if (params.model) {
      // Claude Code uses different model naming
      // Map our model names to Claude Code model flags
      const modelFlag = this.mapModelToFlag(params.model);
      if (modelFlag) {
        args.push('--model', modelFlag);
      }
    }

    // Add max tokens if specified
    if (params.maxTokens) {
      args.push('--max-tokens', String(params.maxTokens));
    }

    try {
      const result = await spawnClaude(args, {
        cliPath: this.config.cliPath,
        timeout: this.config.timeout,
      });

      return {
        content: result.result,
        model: result.model || params.model || 'claude-sonnet-4-5',
        provider: this.id,
        usage: result.usage
          ? {
              promptTokens: result.usage.input_tokens,
              completionTokens: result.usage.output_tokens,
              totalTokens:
                result.usage.input_tokens + result.usage.output_tokens,
            }
          : undefined,
        latencyMs: result.latencyMs,
        cached: false,
      };
    } catch (error) {
      // Re-throw with more context
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Claude Code provider failed: ${message}`);
    }
  }

  /**
   * Map unified model names to Claude Code model identifiers
   */
  private mapModelToFlag(model: string): string | undefined {
    const modelMap: Record<string, string> = {
      'claude-haiku-4-5': 'haiku',
      'claude-sonnet-4-5': 'sonnet',
      'claude-opus-4-5': 'opus',
      // Legacy model names
      'claude-3-haiku': 'haiku',
      'claude-3-sonnet': 'sonnet',
      'claude-3-opus': 'opus',
    };

    return modelMap[model] || model;
  }
}
