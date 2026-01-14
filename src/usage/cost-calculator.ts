/**
 * Cost calculation for pay-per-token providers
 */

import type { Pricing } from './types.ts';

/**
 * Default pricing per 1M tokens (January 2025)
 */
const DEFAULT_PRICING: Record<string, Pricing> = {
  // OpenAI
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4-turbo': { input: 10.00, output: 30.00 },
  'gpt-4': { input: 30.00, output: 60.00 },
  'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
  'o1-preview': { input: 15.00, output: 60.00 },
  'o1-mini': { input: 1.10, output: 4.40 },
  'gpt-5-mini': { input: 0.15, output: 0.60 },
  'gpt-5.2': { input: 2.50, output: 10.00 },

  // Anthropic
  'claude-opus-4-5': { input: 15.00, output: 75.00 },
  'claude-sonnet-4-5': { input: 3.00, output: 15.00 },
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00 },
  'claude-haiku-4-5': { input: 0.80, output: 4.00 },
  'claude-3-5-haiku-latest': { input: 0.80, output: 4.00 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  'claude-3-sonnet': { input: 3.00, output: 15.00 },
  'claude-3-opus': { input: 15.00, output: 75.00 },

  // Gemini
  'gemini-2.5-pro': { input: 1.25, output: 5.00 },
  'gemini-2.5-flash': { input: 0.075, output: 0.30 },
  'gemini-2.5-flash-lite': { input: 0.075, output: 0.30 },
  'gemini-1.5-pro': { input: 0.50, output: 1.50 },
  'gemini-1.5-flash': { input: 0.075, output: 0.30 },
};

/**
 * Normalize model name for pricing lookup
 */
function normalizeModelName(model: string): string {
  // Remove version suffixes and variations
  return model.toLowerCase()
    .replace(/-v\d+$/, '')
    .replace(/:\d+$/, '')
    .replace(/-latest$/, '')
    .replace(/-\d{8}$/, '');  // Remove date suffixes like -20250514
}

/**
 * Find pricing for model with fallback
 * Uses Object.hasOwn() to prevent prototype chain property access attacks
 */
function findPricing(model: string, customPricing?: Record<string, Pricing>): Pricing | null {
  // Check custom pricing first (exact match)
  // Use Object.hasOwn to prevent prototype chain access (e.g., model="constructor")
  if (customPricing && Object.hasOwn(customPricing, model)) {
    return customPricing[model]!;
  }

  // Check default pricing (exact match)
  // Use Object.hasOwn to prevent prototype chain access
  if (Object.hasOwn(DEFAULT_PRICING, model)) {
    return DEFAULT_PRICING[model]!;
  }

  // Try normalized match
  const normalized = normalizeModelName(model);
  for (const [key, pricing] of Object.entries(DEFAULT_PRICING)) {
    if (normalizeModelName(key) === normalized) {
      return pricing;
    }
  }

  // Try custom pricing with normalized match
  if (customPricing) {
    for (const [key, pricing] of Object.entries(customPricing)) {
      if (normalizeModelName(key) === normalized) {
        return pricing;
      }
    }
  }

  return null;
}

/**
 * Cost calculator for token usage
 */
export class CostCalculator {
  private customPricing?: Record<string, Pricing>;

  constructor(customPricing?: Record<string, {
    inputCostPer1k: number;
    outputCostPer1k: number;
  }>) {
    if (customPricing) {
      this.customPricing = {};
      for (const [model, pricing] of Object.entries(customPricing)) {
        this.customPricing[model] = {
          input: pricing.inputCostPer1k * 1000,  // Convert to per-1M
          output: pricing.outputCostPer1k * 1000,
        };
      }
    }
  }

  /**
   * Calculate cost in USD
   * Returns undefined for free/local providers or if pricing not found
   */
  calculate(
    inputTokens: number,
    outputTokens: number,
    model: string,
    provider: string
  ): number | undefined {
    // Subscription providers don't have per-token costs
    if (this.isSubscriptionProvider(provider)) {
      return undefined;
    }

    const pricing = findPricing(model, this.customPricing);
    if (!pricing) {
      return undefined;
    }

    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;

    return inputCost + outputCost;
  }

  /**
   * Check if provider is subscription-based (no per-token cost)
   */
  private isSubscriptionProvider(provider: string): boolean {
    return ['local', 'ollama', 'glm', 'claude-code'].includes(provider);
  }

  /**
   * Get pricing for a model (for display/debugging)
   */
  getPricing(model: string): Pricing | null {
    return findPricing(model, this.customPricing);
  }
}
