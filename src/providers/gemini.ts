/**
 * Gemini Provider - Google's generative AI models
 */

import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from '@google/generative-ai';
import { LLMProvider } from './base.ts';
import type {
  GeminiProviderConfig,
  CompletionParams,
  CompletionResponse,
  ModelInfo,
} from '../types.ts';
import { LLMError, RateLimitError } from '../types.ts';

// Known Gemini models
const GEMINI_MODELS: ModelInfo[] = [
  {
    id: 'gemini-2.0-flash-exp',
    provider: 'gemini',
    displayName: 'Gemini 2.0 Flash',
    contextWindow: 1000000,
    maxOutputTokens: 8192,
    tier: 'moderate',
    capabilities: { streaming: true, vision: true, functionCalling: true },
  },
  {
    id: 'gemini-1.5-flash',
    provider: 'gemini',
    displayName: 'Gemini 1.5 Flash',
    contextWindow: 1000000,
    maxOutputTokens: 8192,
    tier: 'moderate',
    capabilities: { streaming: true, vision: true, functionCalling: true },
  },
  {
    id: 'gemini-1.5-pro',
    provider: 'gemini',
    displayName: 'Gemini 1.5 Pro',
    contextWindow: 2000000,
    maxOutputTokens: 8192,
    tier: 'quality',
    capabilities: { streaming: true, vision: true, functionCalling: true },
  },
  {
    id: 'gemini-1.0-pro',
    provider: 'gemini',
    displayName: 'Gemini 1.0 Pro',
    contextWindow: 32760,
    maxOutputTokens: 8192,
    tier: 'moderate',
    capabilities: { streaming: true, vision: false, functionCalling: true },
  },
];

export class GeminiProvider extends LLMProvider {
  readonly id = 'gemini';
  readonly name = 'Google Gemini';

  private client: GoogleGenerativeAI;
  private config: GeminiProviderConfig;
  private defaultModel = 'gemini-1.5-flash';

  constructor(config: GeminiProviderConfig) {
    super();
    this.config = config;
    const apiKey = config.apiKey ?? process.env.GEMINI_API_KEY ?? '';
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async isAvailable(): Promise<boolean> {
    const apiKey = this.config.apiKey ?? process.env.GEMINI_API_KEY;
    return !!apiKey;
  }

  async getModels(): Promise<string[]> {
    // Gemini doesn't have a public models list endpoint
    return GEMINI_MODELS.map((m) => m.id);
  }

  override getModelInfo(modelId: string): ModelInfo | undefined {
    return GEMINI_MODELS.find((m) => m.id === modelId);
  }

  async complete(params: CompletionParams): Promise<CompletionResponse> {
    const startTime = Date.now();
    const modelId = params.model ?? this.defaultModel;

    const model = this.client.getGenerativeModel({
      model: modelId,
      generationConfig: {
        temperature: params.temperature,
        maxOutputTokens: params.maxTokens,
      },
      safetySettings: [
        {
          category: HarmCategory.HARM_CATEGORY_HARASSMENT,
          threshold: HarmBlockThreshold.BLOCK_NONE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
          threshold: HarmBlockThreshold.BLOCK_NONE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
          threshold: HarmBlockThreshold.BLOCK_NONE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
          threshold: HarmBlockThreshold.BLOCK_NONE,
        },
      ],
    });

    // Build contents from messages
    const formatted = this.formatMessages(params);
    const contents = this.convertToGeminiFormat(formatted);

    try {
      const result = await model.generateContent({
        contents,
        systemInstruction: params.systemPrompt,
      });

      const response = result.response;
      const content = response.text();

      const usage = response.usageMetadata;

      return this.createResponse(content, modelId, startTime, {
        promptTokens: usage?.promptTokenCount ?? 0,
        completionTokens: usage?.candidatesTokenCount ?? 0,
        totalTokens: usage?.totalTokenCount ?? 0,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Gemini API error';

      if (message.includes('429') || message.includes('quota')) {
        throw new RateLimitError('gemini');
      }

      throw new LLMError(message, 'gemini', 'API_ERROR', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Convert OpenAI-style messages to Gemini format
   */
  private convertToGeminiFormat(
    params: CompletionParams
  ): Array<{ role: string; parts: Array<{ text: string }> }> {
    return params.messages
      .filter((m) => m.role !== 'system') // System handled separately
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
  }
}
