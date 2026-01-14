/**
 * OpenAI Provider - Works with OpenAI API and compatible endpoints
 */

import OpenAI from 'openai';
import { LLMProvider } from './base.ts';
import type {
  OpenAIProviderConfig,
  CompletionParams,
  CompletionResponse,
  ModelInfo,
} from '../types.ts';
import { LLMError, RateLimitError } from '../types.ts';

// Known OpenAI models
const OPENAI_MODELS: ModelInfo[] = [
  {
    id: 'gpt-4o',
    provider: 'openai',
    displayName: 'GPT-4o',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    tier: 'quality',
    capabilities: { streaming: true, vision: true, functionCalling: true },
  },
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    displayName: 'GPT-4o Mini',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    tier: 'moderate',
    capabilities: { streaming: true, vision: true, functionCalling: true },
  },
  {
    id: 'gpt-4-turbo',
    provider: 'openai',
    displayName: 'GPT-4 Turbo',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    tier: 'quality',
    capabilities: { streaming: true, vision: true, functionCalling: true },
  },
  {
    id: 'gpt-3.5-turbo',
    provider: 'openai',
    displayName: 'GPT-3.5 Turbo',
    contextWindow: 16385,
    maxOutputTokens: 4096,
    tier: 'moderate',
    capabilities: { streaming: true, vision: false, functionCalling: true },
  },
  {
    id: 'o1-preview',
    provider: 'openai',
    displayName: 'o1 Preview',
    contextWindow: 128000,
    maxOutputTokens: 32768,
    tier: 'quality',
    capabilities: { streaming: false, vision: false, functionCalling: false },
  },
  {
    id: 'o1-mini',
    provider: 'openai',
    displayName: 'o1 Mini',
    contextWindow: 128000,
    maxOutputTokens: 65536,
    tier: 'moderate',
    capabilities: { streaming: false, vision: false, functionCalling: false },
  },
];

export class OpenAIProvider extends LLMProvider {
  readonly id = 'openai';
  readonly name = 'OpenAI';

  private client: OpenAI;
  private config: OpenAIProviderConfig;
  private defaultModel = 'gpt-4o-mini';

  constructor(config: OpenAIProviderConfig) {
    super();
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: config.baseUrl,
      organization: config.organization,
    });
  }

  async isAvailable(): Promise<boolean> {
    // Check if we have an API key
    const apiKey = this.config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) return false;

    // Optionally ping the API to verify
    try {
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }

  async getModels(): Promise<string[]> {
    try {
      const response = await this.client.models.list();
      return response.data
        .filter((m) => m.id.startsWith('gpt-') || m.id.startsWith('o1'))
        .map((m) => m.id);
    } catch {
      // Return known models if API call fails
      return OPENAI_MODELS.map((m) => m.id);
    }
  }

  override getModelInfo(modelId: string): ModelInfo | undefined {
    return OPENAI_MODELS.find((m) => m.id === modelId);
  }

  async complete(params: CompletionParams): Promise<CompletionResponse> {
    const startTime = Date.now();
    const formatted = this.formatMessages(params);
    const model = params.model ?? this.defaultModel;

    try {
      const response = await this.client.chat.completions.create({
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
      if (error instanceof OpenAI.RateLimitError) {
        throw new RateLimitError('openai');
      }

      throw new LLMError(
        error instanceof Error ? error.message : 'OpenAI API error',
        'openai',
        'API_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }
}
