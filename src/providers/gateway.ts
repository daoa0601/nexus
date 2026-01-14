/**
 * Gateway Provider - Custom API endpoint support (OpenRouter, LiteLLM, custom proxies)
 */

import { LLMProvider } from './base.ts';
import type { GatewayProviderConfig, CompletionParams, CompletionResponse } from '../types.ts';
import { LLMError, RateLimitError } from '../types.ts';

interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class GatewayProvider extends LLMProvider {
  readonly id = 'gateway';
  readonly name = 'Custom Gateway';

  private config: GatewayProviderConfig;
  private defaultModel = 'gpt-4o-mini';

  constructor(config: GatewayProviderConfig) {
    super();
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/models`, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      // If models endpoint doesn't exist, assume it's available
      return true;
    }
  }

  async getModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.config.baseUrl}/models`, {
        headers: this.getHeaders(),
      });

      if (!response.ok) return [];

      const data = (await response.json()) as { data?: Array<{ id: string }> };
      return data.data?.map((m) => m.id) ?? [];
    } catch {
      return [];
    }
  }

  async complete(params: CompletionParams): Promise<CompletionResponse> {
    const startTime = Date.now();
    const formatted = this.formatMessages(params);
    const model = params.model ?? this.defaultModel;

    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: formatted.messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          temperature: params.temperature,
          max_tokens: params.maxTokens,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();

        if (response.status === 429) {
          throw new RateLimitError('gateway');
        }

        throw new Error(`Gateway API error: ${response.status} - ${errorText}`);
      }

      const data = (await response.json()) as ChatCompletionResponse;
      const content = data.choices[0]?.message?.content ?? '';

      return this.createResponse(content, data.model ?? model, startTime, {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      });
    } catch (error) {
      if (error instanceof RateLimitError) {
        throw error;
      }

      throw new LLMError(
        error instanceof Error ? error.message : 'Gateway API error',
        'gateway',
        'API_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.config.headers,
    };

    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    return headers;
  }
}
