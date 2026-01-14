/**
 * Abstract base class for LLM providers
 */

import type {
  CompletionParams,
  CompletionResponse,
  ProviderStatus,
  ModelInfo,
} from '../types.ts';

export abstract class LLMProvider {
  abstract readonly id: string;
  abstract readonly name: string;

  /**
   * Check if this provider is currently available
   */
  abstract isAvailable(): Promise<boolean>;

  /**
   * Get list of available models for this provider
   */
  abstract getModels(): Promise<string[]>;

  /**
   * Complete a chat completion request
   */
  abstract complete(params: CompletionParams): Promise<CompletionResponse>;

  /**
   * Get provider status including available models
   */
  async status(): Promise<ProviderStatus> {
    try {
      const available = await this.isAvailable();
      const models = available ? await this.getModels() : [];
      return {
        id: this.id,
        name: this.name,
        available,
        models,
      };
    } catch (error) {
      return {
        id: this.id,
        name: this.name,
        available: false,
        models: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get model info if known
   */
  getModelInfo(_modelId: string): ModelInfo | undefined {
    return undefined;
  }

  /**
   * Format messages for this provider's API
   * Override in providers that need special formatting
   */
  protected formatMessages(params: CompletionParams): CompletionParams {
    // Default: prepend system prompt as system message
    if (params.systemPrompt && !params.messages.some((m) => m.role === 'system')) {
      return {
        ...params,
        messages: [{ role: 'system', content: params.systemPrompt }, ...params.messages],
      };
    }
    return params;
  }

  /**
   * Create a standard completion response
   */
  protected createResponse(
    content: string,
    model: string,
    startTime: number,
    usage?: CompletionResponse['usage']
  ): CompletionResponse {
    return {
      content,
      model,
      provider: this.id,
      usage,
      latencyMs: Date.now() - startTime,
      cached: false,
    };
  }
}
