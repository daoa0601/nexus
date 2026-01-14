/**
 * Anthropic Provider - Claude models
 */

import Anthropic from '@anthropic-ai/sdk';
import { LLMProvider } from './base.ts';
import type {
  AnthropicProviderConfig,
  CompletionParams,
  CompletionResponse,
  ModelInfo,
} from '../types.ts';
import { LLMError, RateLimitError } from '../types.ts';

// Known Anthropic models
const ANTHROPIC_MODELS: ModelInfo[] = [
  {
    id: 'claude-opus-4-20250514',
    provider: 'anthropic',
    displayName: 'Claude Opus 4',
    contextWindow: 200000,
    maxOutputTokens: 32000,
    tier: 'quality',
    capabilities: { streaming: true, vision: true, functionCalling: true },
  },
  {
    id: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    displayName: 'Claude Sonnet 4',
    contextWindow: 200000,
    maxOutputTokens: 64000,
    tier: 'quality',
    capabilities: { streaming: true, vision: true, functionCalling: true },
  },
  {
    id: 'claude-3-5-sonnet-latest',
    provider: 'anthropic',
    displayName: 'Claude 3.5 Sonnet',
    contextWindow: 200000,
    maxOutputTokens: 8192,
    tier: 'quality',
    capabilities: { streaming: true, vision: true, functionCalling: true },
  },
  {
    id: 'claude-3-5-haiku-latest',
    provider: 'anthropic',
    displayName: 'Claude 3.5 Haiku',
    contextWindow: 200000,
    maxOutputTokens: 8192,
    tier: 'moderate',
    capabilities: { streaming: true, vision: true, functionCalling: true },
  },
  {
    id: 'claude-3-haiku-20240307',
    provider: 'anthropic',
    displayName: 'Claude 3 Haiku',
    contextWindow: 200000,
    maxOutputTokens: 4096,
    tier: 'moderate',
    capabilities: { streaming: true, vision: true, functionCalling: true },
  },
];

export class AnthropicProvider extends LLMProvider {
  readonly id = 'anthropic';
  readonly name = 'Anthropic';

  private client: Anthropic;
  private config: AnthropicProviderConfig;
  private defaultModel = 'claude-3-5-haiku-latest';

  constructor(config: AnthropicProviderConfig) {
    super();
    this.config = config;
    this.client = new Anthropic({
      apiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY,
      baseURL: config.baseUrl,
    });
  }

  async isAvailable(): Promise<boolean> {
    const apiKey = this.config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    return !!apiKey;
  }

  async getModels(): Promise<string[]> {
    // Anthropic doesn't have a models list endpoint
    return ANTHROPIC_MODELS.map((m) => m.id);
  }

  override getModelInfo(modelId: string): ModelInfo | undefined {
    return ANTHROPIC_MODELS.find((m) => m.id === modelId);
  }

  async complete(params: CompletionParams): Promise<CompletionResponse> {
    const startTime = Date.now();
    const model = params.model ?? this.defaultModel;

    // Anthropic handles system prompts differently
    const systemPrompt =
      params.systemPrompt ?? params.messages.find((m) => m.role === 'system')?.content;
    const messages = params.messages.filter((m) => m.role !== 'system');

    try {
      const response = await this.client.messages.create({
        model,
        max_tokens: params.maxTokens ?? 4096,
        system: systemPrompt,
        messages: messages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
        temperature: params.temperature,
      });

      const content =
        response.content[0]?.type === 'text' ? response.content[0].text : '';

      return this.createResponse(content, model, startTime, {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      });
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) {
        throw new RateLimitError('anthropic');
      }

      throw new LLMError(
        error instanceof Error ? error.message : 'Anthropic API error',
        'anthropic',
        'API_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }
}
