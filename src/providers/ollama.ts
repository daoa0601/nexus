/**
 * Ollama Provider - Local LLM server
 *
 * Performance optimizations:
 * - Removed redundant availability check from complete() (racing executor handles it)
 * - Configurable health check timeout
 * - Model preloading and warmup support
 */

import { LLMProvider } from './base.ts';
import type { OllamaProviderConfig, CompletionParams, CompletionResponse } from '../types.ts';
import { LLMError } from '../types.ts';

interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
}

interface OllamaChatResponse {
  model: string;
  message: {
    role: string;
    content: string;
  };
  done: boolean;
  total_duration?: number;
  eval_count?: number;
  prompt_eval_count?: number;
}

export class OllamaProvider extends LLMProvider {
  readonly id = 'ollama';
  readonly name = 'Ollama';

  private config: OllamaProviderConfig;
  private baseUrl: string;
  private defaultModel = 'llama3.2:3b';
  private preloadComplete = false;

  constructor(config: OllamaProviderConfig) {
    super();
    this.config = config;
    this.baseUrl = config.baseUrl.replace(/\/$/, ''); // Remove trailing slash
  }

  async isAvailable(): Promise<boolean> {
    try {
      const timeout = this.config.healthCheckTimeout ?? 2000;
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(timeout),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async getModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) return [];

      const data = (await response.json()) as { models: OllamaModel[] };
      return data.models?.map((m) => m.name) ?? [];
    } catch {
      return [];
    }
  }

  async complete(params: CompletionParams): Promise<CompletionResponse> {
    const startTime = Date.now();
    const formatted = this.formatMessages(params);
    const model = params.model ?? this.defaultModel;

    // NOTE: Removed redundant isAvailable() check
    // The racing executor already handles availability before calling complete()

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: formatted.messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          stream: false,
          options: {
            temperature: params.temperature,
            num_predict: params.maxTokens,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
      }

      const data = (await response.json()) as OllamaChatResponse;
      const content = data.message?.content ?? '';

      return this.createResponse(content, model, startTime, {
        promptTokens: data.prompt_eval_count ?? 0,
        completionTokens: data.eval_count ?? 0,
        totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      });
    } catch (error) {
      throw new LLMError(
        error instanceof Error ? error.message : 'Ollama API error',
        'ollama',
        'API_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Pull a model from Ollama library
   */
  async pullModel(modelName: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
    });

    if (!response.ok) {
      throw new Error(`Failed to pull model: ${response.statusText}`);
    }

    // The pull endpoint returns streaming progress, we just wait for it
    await response.text();
  }

  /**
   * Warm up a model by loading it into memory
   * Ollama keeps models loaded for a period after first use
   */
  async warmupModel(modelName: string): Promise<void> {
    try {
      // Send a minimal request to load the model into memory
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: 'user', content: 'Hi' }],
          stream: false,
          options: { num_predict: 1 }, // Generate minimal tokens
        }),
      });

      if (!response.ok) {
        throw new Error(`Warmup failed: ${response.statusText}`);
      }

      await response.json(); // Consume response
    } catch (error) {
      // Warmup failure is non-fatal, just log
      console.warn(`Ollama warmup failed for ${modelName}:`, error);
    }
  }

  /**
   * Preload and warm up models for faster first request
   * Call this during gateway initialization
   */
  async preload(): Promise<{ loaded: string[]; errors: string[] }> {
    const loaded: string[] = [];
    const errors: string[] = [];

    const modelsToPreload = this.config.preloadModels ?? [];
    if (modelsToPreload.length === 0) {
      this.preloadComplete = true;
      return { loaded, errors };
    }

    // Check available models first
    const availableModels = await this.getModels();
    const availableSet = new Set(availableModels);

    for (const modelName of modelsToPreload) {
      try {
        // Pull model if not already available
        if (!availableSet.has(modelName)) {
          await this.pullModel(modelName);
        }

        // Warm up the model
        await this.warmupModel(modelName);
        loaded.push(modelName);
      } catch (err) {
        errors.push(`${modelName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.preloadComplete = true;
    return { loaded, errors };
  }

  /**
   * Check if preloading is complete
   */
  isPreloaded(): boolean {
    return this.preloadComplete;
  }
}
