/**
 * GLM Provider - Zhipu AI's GLM Coding Plan
 *
 * Supports two modes:
 * 1. Direct API mode (default): Uses OpenAI-compatible z.ai endpoint
 * 2. Subprocess mode (opt-in): Uses Claude CLI with z.ai env vars
 */

import { LLMProvider } from './base.ts';
import type {
  CompletionParams,
  CompletionResponse,
  ModelInfo,
} from '../types.ts';
import { LLMError, RateLimitError } from '../types.ts';
import {
  spawnClaude,
  isClaudeCliAvailable,
  formatMessagesForCli,
} from '../utils/subprocess.ts';

export interface GLMProviderConfig {
  /** Z.AI API key (defaults to ZAI_API_KEY env var) */
  apiKey?: string;
  /** Use subprocess mode via Claude CLI (default: true) */
  preferSubprocess?: boolean;
  /** Base URL for direct API mode */
  baseUrl?: string;
  /** Timeout for requests in ms */
  timeout?: number;
  /** Path to Claude CLI binary */
  cliPath?: string;
}

// Known GLM models
const GLM_MODELS: ModelInfo[] = [
  {
    id: 'glm-4.7',
    provider: 'glm',
    displayName: 'GLM-4.7',
    contextWindow: 128000,
    maxOutputTokens: 8192,
    tier: 'quality',
    capabilities: { streaming: true, vision: false, functionCalling: true },
  },
  {
    id: 'glm-4.5-air',
    provider: 'glm',
    displayName: 'GLM-4.5 Air',
    contextWindow: 128000,
    maxOutputTokens: 8192,
    tier: 'fast',
    capabilities: { streaming: true, vision: false, functionCalling: true },
  },
];

// Z.AI API endpoints
const ZAI_ANTHROPIC_URL = 'https://api.z.ai/api/anthropic';
const ZAI_OPENAI_URL = 'https://api.z.ai/api/coding/paas/v4';

/**
 * GLM Provider for Zhipu AI's GLM Coding Plan
 *
 * Default mode uses subprocess via Claude CLI with z.ai environment variables,
 * which is proven to work reliably with the GLM Coding Plan subscription.
 *
 * Direct API mode is available as opt-in for environments where subprocess
 * spawning is not ideal.
 */
export class GLMProvider extends LLMProvider {
  readonly id = 'glm';
  readonly name = 'GLM Coding Plan';

  private config: GLMProviderConfig;
  private openaiClient: import('openai').default | null = null;
  private defaultModel = 'glm-4.7';

  constructor(config: GLMProviderConfig = {}) {
    super();
    this.config = {
      preferSubprocess: false, // Default to direct API (more reliable)
      ...config,
    };
  }

  async isAvailable(): Promise<boolean> {
    const apiKey = this.config.apiKey ?? process.env.ZAI_API_KEY;
    if (!apiKey) return false;

    // In subprocess mode, also need Claude CLI
    if (this.config.preferSubprocess === true) {
      return isClaudeCliAvailable(this.config.cliPath);
    }

    // In direct API mode (default), just need the API key
    return true;
  }

  async getModels(): Promise<string[]> {
    return GLM_MODELS.map((m) => m.id);
  }

  override getModelInfo(modelId: string): ModelInfo | undefined {
    return GLM_MODELS.find((m) => m.id === modelId);
  }

  async complete(params: CompletionParams): Promise<CompletionResponse> {
    // Use direct API mode by default (more reliable)
    if (this.config.preferSubprocess === true) {
      return this.completeViaSubprocess(params);
    }

    // Direct API mode (default)
    return this.completeViaAPI(params);
  }

  /**
   * Complete via subprocess - spawns Claude CLI with z.ai env vars
   * This replicates the claude-glm shell wrapper behavior
   */
  private async completeViaSubprocess(
    params: CompletionParams
  ): Promise<CompletionResponse> {
    const startTime = Date.now();

    // Format messages into a prompt string
    const formattedParams = this.formatMessages(params);
    const prompt = formatMessagesForCli(formattedParams.messages);

    // Build CLI arguments
    const args = ['-p', prompt, '--output-format', 'json'];

    // Add max tokens if specified
    if (params.maxTokens) {
      args.push('--max-tokens', String(params.maxTokens));
    }

    // Set up environment variables to route through z.ai
    const env: Record<string, string | undefined> = {
      ANTHROPIC_AUTH_TOKEN:
        this.config.apiKey ?? process.env.ZAI_API_KEY,
      ANTHROPIC_BASE_URL: ZAI_ANTHROPIC_URL,
    };

    try {
      const result = await spawnClaude(args, {
        env,
        cliPath: this.config.cliPath,
        timeout: this.config.timeout,
      });

      return {
        content: result.result,
        model: params.model || this.defaultModel,
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
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      throw new LLMError(
        `GLM subprocess failed: ${message}`,
        'glm',
        'SUBPROCESS_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Complete via direct API - uses OpenAI-compatible z.ai endpoint
   * This is opt-in and may not work with all GLM Coding Plan configurations
   */
  private async completeViaAPI(
    params: CompletionParams
  ): Promise<CompletionResponse> {
    const startTime = Date.now();
    const formatted = this.formatMessages(params);
    const model = params.model ?? this.defaultModel;

    // Lazy-load OpenAI client
    if (!this.openaiClient) {
      const OpenAI = (await import('openai')).default;
      this.openaiClient = new OpenAI({
        apiKey: this.config.apiKey ?? process.env.ZAI_API_KEY,
        baseURL: this.config.baseUrl ?? ZAI_OPENAI_URL,
      });
    }

    try {
      const response = await this.openaiClient.chat.completions.create({
        model,
        messages: formatted.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        temperature: params.temperature,
        max_tokens: params.maxTokens,
      });

      const content = response.choices[0]?.message?.content ?? '';

      return this.createResponse(content, model, startTime, {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      });
    } catch (error) {
      // Check for rate limit
      if (
        error instanceof Error &&
        error.message.includes('rate')
      ) {
        throw new RateLimitError('glm');
      }

      throw new LLMError(
        error instanceof Error ? error.message : 'GLM API error',
        'glm',
        'API_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }
}
