/**
 * Token counting with fallback for providers without usage data
 */

import type { UsageConfig } from './types.ts';
import type { Message } from '../types.ts';

/**
 * Abstract tokenizer interface
 */
interface Tokenizer {
  encode(text: string): Promise<number[]>;
  count(text: string): Promise<number>;
}

/**
 * OpenAI tiktoken wrapper (lazy-loaded)
 */
class Tiktokenizer implements Tokenizer {
  private encoder?: any;

  async init(): Promise<void> {
    if (this.encoder) return;
    try {
      const tiktoken = await import('js-tiktoken');
      this.encoder = await tiktoken.getEncoding('cl100k_base');
    } catch {
      throw new Error('js-tiktoken not available');
    }
  }

  async encode(text: string): Promise<number[]> {
    await this.init();
    return this.encoder!.encode(text);
  }

  async count(text: string): Promise<number> {
    const tokens = await this.encode(text);
    return tokens.length;
  }
}

/**
 * LLaMA tokenizer wrapper (lazy-loaded)
 */
class LlamaTokenizer implements Tokenizer {
  private tokenizer?: any;

  async init(): Promise<void> {
    if (this.tokenizer) return;
    try {
      this.tokenizer = await import('llama-tokenizer-js');
    } catch {
      throw new Error('llama-tokenizer-js not available');
    }
  }

  async encode(text: string): Promise<number[]> {
    await this.init();
    // llama-tokenizer-js might not expose encode, use count
    const count = await this.count(text);
    return Array.from({ length: count }, (_, i) => i);
  }

  async count(text: string): Promise<number> {
    try {
      await this.init();
      if (this.tokenizer?.encode) {
        const tokens = this.tokenizer.encode(text);
        return tokens.length;
      }
    } catch {
      // Fall through to estimation
    }
    // Fallback: approximate LLaMA tokens (~4 chars per token)
    return Math.ceil(text.length / 4);
  }
}

/**
 * Character-based estimation (last resort)
 */
function estimateFromChars(text: string): number {
  // Approximate: ~4 characters per token for most models
  return Math.ceil(text.length / 4);
}

/**
 * Detect tokenizer type from model name
 */
function detectTokenizer(model: string, provider: string): 'tiktoken' | 'llama' {
  // OpenAI models
  if (provider === 'openai' || model.startsWith('gpt-') || model.startsWith('o1-')) {
    return 'tiktoken';
  }

  // LLaMA models
  if (model.toLowerCase().includes('llama') || model.toLowerCase().includes('llama')) {
    return 'llama';
  }

  // Anthropic (use tiktoken as approximation)
  if (provider === 'anthropic' || model.startsWith('claude-')) {
    return 'tiktoken';
  }

  // Gemini (use tiktoken as approximation)
  if (provider === 'gemini' || model.startsWith('gemini-')) {
    return 'tiktoken';
  }

  // Local models (likely LLaMA-based)
  if (provider === 'local') {
    return 'llama';
  }

  // Ollama (model-dependent, default to tiktoken)
  if (provider === 'ollama') {
    if (model.toLowerCase().includes('llama')) {
      return 'llama';
    }
    return 'tiktoken';
  }

  // Default to tiktoken
  return 'tiktoken';
}

/**
 * Token counter with fallback strategy
 */
export class TokenCounter {
  private tokenizers: Map<string, Tokenizer> = new Map();
  private config: UsageConfig['tokenCounting'];

  constructor(config?: UsageConfig['tokenCounting']) {
    this.config = config ?? { enabled: true };
  }

  /**
   * Count tokens in text with automatic tokenizer selection
   */
  async count(
    text: string,
    provider: string,
    model: string
  ): Promise<number> {
    if (!this.config?.enabled) {
      return estimateFromChars(text);
    }

    const tokenizerType = this.config.defaultTokenizer
      ?? detectTokenizer(model, provider);

    try {
      const tokenizer = await this.getTokenizer(tokenizerType);
      return await tokenizer.count(text);
    } catch {
      return estimateFromChars(text);
    }
  }

  /**
   * Count tokens from messages array
   */
  async countMessages(
    messages: Message[],
    provider: string,
    model: string
  ): Promise<number> {
    let total = 0;

    for (const message of messages) {
      // Count content
      total += await this.count(message.content, provider, model);

      // Add overhead for role markers and special tokens
      // Approximate: ~4 tokens per message for formatting
      total += 4;
    }

    return total;
  }

  /**
   * Get or create tokenizer instance
   */
  private async getTokenizer(type: 'tiktoken' | 'llama'): Promise<Tokenizer> {
    if (this.tokenizers.has(type)) {
      return this.tokenizers.get(type)!;
    }

    let tokenizer: Tokenizer;
    if (type === 'tiktoken') {
      tokenizer = new Tiktokenizer();
    } else {
      tokenizer = new LlamaTokenizer();
    }

    // Initialize
    if ('init' in tokenizer) {
      await (tokenizer as any).init();
    }

    this.tokenizers.set(type, tokenizer);
    return tokenizer;
  }
}
