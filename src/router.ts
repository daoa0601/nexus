/**
 * Router - Health-aware routing with EWMA latency tracking and circuit breakers
 *
 * Improvements over original:
 * - EWMA latency tracking (recent data weighted more heavily)
 * - Circuit breaker pattern (auto-disable failing providers)
 * - Parallel availability checks with caching
 * - Health score combining latency and success rate
 */

import type {
  CompletionParams,
  RoutingStrategy,
  SpeedTier,
  MetricsConfig as MetricsConfigType,
  CircuitBreakerConfig as CircuitBreakerConfigType,
} from './types.ts';
import type { LLMProvider } from './providers/base.ts';
import { MetricsRegistry, type MetricsConfig } from './router/metrics.ts';
import {
  CircuitBreakerRegistry,
  type CircuitBreakerConfig,
} from './router/circuit-breaker.ts';

// Default speed tiers based on CPU-only benchmark results (January 2025)
// Thresholds adjusted for CPU-only inference (GPU would be 2-5x faster)
// See: examples/latency-benchmark.ts for measurement methodology
const DEFAULT_SPEED_TIERS: SpeedTier[] = [
  // TIER 1: Instant (< 200ms) - Liquid AI LFM2 models (smallest, fastest)
  // HuggingFace: LiquidAI/LFM2-350M-GGUF, LiquidAI/LFM2-350M-ENJP-MT-GGUF
  // Note: node-llama-cpp has context issues, use with caution
  { provider: 'local', models: ['LFM2-350M', 'lfm2-350m'], task: 'translation' },
  { provider: 'local', models: ['LFM2-350M-ENJP-MT', 'lfm2-350m-enjp-mt'], task: 'translation' },
  // Ollama: LFM2-350M with GPU acceleration
  { provider: 'ollama', models: ['hf.co/LiquidAI/LFM2-350M-Q4_K_M-GGUF'] },

  // TIER 2: Fast (< 700ms) - Small local models (CPU-only: ~450-650ms)
  // Benchmark: Qwen3-0.6B=448ms, Qwen3-1.7B=642ms (exceeds old 500ms threshold)
  // HuggingFace: Qwen/Qwen3-0.6B-GGUF (Q5_K_M), Qwen/Qwen3-1.7B-GGUF (Q5_K_M)
  // HuggingFace: LiquidAI/LFM2-1.2B-GGUF, LiquidAI/LFM2.5-1.2B-Instruct-GGUF, LiquidAI/LFM2.5-1.2B-JP
  { provider: 'local', models: ['Qwen3-0.6B', 'qwen3-0.6b'] },
  { provider: 'local', models: ['LFM2-1.2B', 'LFM2.5-1.2B', 'lfm2-1.2b', 'lfm2.5-1.2b'] },
  { provider: 'local', models: ['LFM2.5-1.2B-JP', 'lfm2.5-1.2b-jp'] },
  // Ollama: hf.co/Qwen/Qwen3-0.6B-GGUF (fastest in tier), hf.co/Qwen/Qwen3-1.7B-GGUF
  { provider: 'ollama', models: ['hf.co/Qwen/Qwen3-0.6B-GGUF', 'hf.co/Qwen/Qwen3-1.7B-GGUF', 'qwen3:0.6b', 'qwen3:1.7b'] },
  // Ollama: LFM2-1.2B and LFM2.5-1.2B with GPU acceleration
  { provider: 'ollama', models: ['hf.co/LiquidAI/LFM2-1.2B-GGUF', 'hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF'] },

  // TIER 3: Subscription Cloud - GLM (no pay-per-token, GLM Coding Plan)
  { provider: 'glm', models: ['glm-4.5-air'] },
  { provider: 'glm', models: ['glm-4.7'] },

  // TIER 4: Subscription Cloud - Claude Code subprocess (no pay-per-token)
  { provider: 'claude-code', models: ['claude-haiku-4-5', 'haiku'] },
  { provider: 'claude-code', models: ['claude-sonnet-4-5', 'sonnet'] },
  { provider: 'claude-code', models: ['claude-opus-4-5', 'opus'] },

  // TIER 5: Moderate (< 1.5s) - Medium local + fast cloud models (CPU-only: ~900-1400ms)
  // Benchmark: Qwen3-4B=891ms (passes), Qwen3-8B=1.37s (exceeds old 1s threshold)
  // Moved: Qwen3-1.7B to Tier 5 (performs at 642ms, closer to Tier 5 than 2)
  // HuggingFace: Qwen/Qwen3-4B-GGUF (Q5_K_M), Qwen/Qwen3-8B-GGUF (Q4_K_M)
  // HuggingFace: LiquidAI/LFM2-2.6B-GGUF
  { provider: 'local', models: ['Qwen3-1.7B', 'Qwen3-4B', 'Qwen3-8B', 'LFM2-2.6B'] },
  // Ollama: hf.co/Qwen/Qwen3-1.7B-GGUF, hf.co/Qwen/Qwen3-4B-GGUF, hf.co/Qwen/Qwen3-8B-GGUF, hf.co/Qwen/Qwen3-14B-GGUF
  { provider: 'ollama', models: ['hf.co/Qwen/Qwen3-1.7B-GGUF', 'hf.co/Qwen/Qwen3-4B-GGUF', 'hf.co/Qwen/Qwen3-8B-GGUF', 'hf.co/Qwen/Qwen3-14B-GGUF', 'qwen3:1.7b', 'qwen3:4b', 'qwen3:8b', 'qwen3:14b'] },
  { provider: 'gemini', models: ['gemini-2.5-flash-lite', 'gemini-2.5-flash'] },
  { provider: 'openai', models: ['gpt-4o-mini', 'gpt-4o'] },
  { provider: 'anthropic', models: ['claude-haiku-4-5', 'claude-3-5-haiku-latest'] },

  // TIER 6: Quality (< 6s) - Full-size models + MoE (CPU-only: ~1-5s)
  // Benchmark: Qwen3-32B=5.33s (exceeds old 3s), Qwen3-Coder-30B-A3B=1.19s (excellent MoE!)
  // Moved: Qwen3-Coder-30B-A3B from Tier 7 (performs like Tier 5 due to MoE efficiency)
  // HuggingFace: Qwen/Qwen3-32B-GGUF (Q4_K_M), Qwen/Qwen3-Coder-32B-GGUF (Q4_K_M)
  // HuggingFace: BasedBase/Qwen3-Coder-30B-A3B-Instruct-480B-Distill-V2 (MoE, 30B total, 3B active)
  { provider: 'local', models: ['Qwen3-32B', 'Qwen3-Coder-32B'] },
  // Ollama: hf.co/Qwen/Qwen3-32B-GGUF, hf.co/BasedBase/Qwen3-Coder-30B-A3B-Instruct-480B-Distill-V2:Q6_K
  { provider: 'ollama', models: ['hf.co/Qwen/Qwen3-32B-GGUF', 'hf.co/BasedBase/Qwen3-Coder-30B-A3B-Instruct-480B-Distill-V2:Q6_K', 'qwen3:32b', 'qwen3-coder:30b-a3b'] },
  { provider: 'openai', models: ['gpt-5-mini', 'gpt-5.2'] },
  { provider: 'anthropic', models: ['claude-sonnet-4-5', 'claude-sonnet-4-20250514'] },
  { provider: 'gemini', models: ['gemini-2.5-pro'] },

  // TIER 7: Premium (6s+) - Largest models for maximum quality
  // Only pay-per-token cloud models here (local models are faster with MoE)
  { provider: 'anthropic', models: ['claude-opus-4-5', 'claude-opus-4-20250514'] },
  { provider: 'openai', models: ['o1-preview', 'o1-mini'] },
];

// Providers that don't charge per-token (subscription-based or free)
const SUBSCRIPTION_PROVIDERS = ['local', 'ollama', 'glm', 'claude-code'];

// Providers that charge per-token
const PAY_PER_TOKEN_PROVIDERS = ['openai', 'anthropic', 'gemini', 'gateway'];

// Availability cache entry
interface AvailabilityEntry {
  available: boolean;
  expiresAt: number;
}

export interface RouterConfig {
  strategy?: RoutingStrategy;
  metrics?: MetricsConfigType;
  circuitBreaker?: CircuitBreakerConfigType;
  /** TTL for availability cache in ms. Default: 30000 */
  availabilityCacheTtl?: number;
}

export class Router {
  private strategy: RoutingStrategy;
  private availableProviders: Set<string> = new Set();
  private speedTiers: SpeedTier[] = DEFAULT_SPEED_TIERS;

  // Health tracking
  readonly metrics: MetricsRegistry;
  readonly circuitBreakers: CircuitBreakerRegistry;

  // Availability cache
  private availabilityCache = new Map<string, AvailabilityEntry>();
  private readonly availabilityCacheTtl: number;

  constructor(config: RouterConfig = {}) {
    this.strategy = config.strategy ?? 'fastest';
    this.availabilityCacheTtl = config.availabilityCacheTtl ?? 30000;

    // Initialize metrics with EWMA
    this.metrics = new MetricsRegistry({
      alpha: config.metrics?.alpha ?? 0.3,
      initialLatency: config.metrics?.initialLatency ?? 500,
    });

    // Initialize circuit breakers
    this.circuitBreakers = new CircuitBreakerRegistry({
      failureThreshold: config.circuitBreaker?.failureThreshold ?? 3,
      recoveryTimeout: config.circuitBreaker?.recoveryTimeout ?? 30000,
    });
  }

  /**
   * Add a provider to the available pool
   */
  addProvider(providerId: string): void {
    this.availableProviders.add(providerId);
  }

  /**
   * Remove a provider from the available pool
   */
  removeProvider(providerId: string): void {
    this.availableProviders.delete(providerId);
  }

  /**
   * Set the routing strategy
   */
  setStrategy(strategy: RoutingStrategy): void {
    this.strategy = strategy;
  }

  /**
   * Get current strategy
   */
  getStrategy(): RoutingStrategy {
    return this.strategy;
  }

  /**
   * Get ordered list of providers to try based on strategy
   * Now with parallel availability checks and circuit breaker filtering
   */
  async getProviderOrder(
    providers: Map<string, LLMProvider>,
    params: CompletionParams
  ): Promise<string[]> {
    // Check availability in parallel with caching
    const available = await this.getAvailableProviders(providers);

    if (available.length === 0) return [];

    // Filter out providers with open circuits
    const healthyProviders = available.filter((id) =>
      this.circuitBreakers.canExecute(id)
    );

    if (healthyProviders.length === 0) {
      // All circuits open - return available anyway (circuit breakers will handle)
      return this.orderByStrategy(available, params);
    }

    return this.orderByStrategy(healthyProviders, params);
  }

  /**
   * Check provider availability in parallel with caching
   */
  private async getAvailableProviders(
    providers: Map<string, LLMProvider>
  ): Promise<string[]> {
    const now = Date.now();
    const checks: Promise<[string, boolean]>[] = [];
    const cachedAvailable: string[] = [];

    for (const [id, provider] of providers) {
      if (!this.availableProviders.has(id)) continue;

      // Check cache first
      const cached = this.availabilityCache.get(id);
      if (cached && cached.expiresAt > now) {
        if (cached.available) {
          cachedAvailable.push(id);
        }
        continue;
      }

      // Check in parallel
      checks.push(
        provider
          .isAvailable()
          .then((available) => {
            this.availabilityCache.set(id, {
              available,
              expiresAt: now + this.availabilityCacheTtl,
            });
            return [id, available] as [string, boolean];
          })
          .catch(() => {
            this.availabilityCache.set(id, {
              available: false,
              expiresAt: now + this.availabilityCacheTtl,
            });
            return [id, false] as [string, boolean];
          })
      );
    }

    const results = await Promise.all(checks);
    const freshAvailable = results.filter(([_, avail]) => avail).map(([id]) => id);

    return [...cachedAvailable, ...freshAvailable];
  }

  /**
   * Order providers by strategy
   */
  private orderByStrategy(available: string[], params: CompletionParams): string[] {
    switch (this.strategy) {
      case 'local-only':
        return this.getLocalOnlyOrder(available);

      case 'subscription-only':
        return this.getSubscriptionOnlyOrder(available, params);

      case 'subscription-first':
        return this.getSubscriptionFirstOrder(available, params);

      case 'fastest':
        return this.getFastestOrder(available, params);

      case 'cheapest':
        return this.getCheapestOrder(available, params);

      case 'quality':
        return this.getQualityOrder(available, params);

      default:
        return available;
    }
  }

  /**
   * Local-only: Only use local providers
   */
  private getLocalOnlyOrder(available: string[]): string[] {
    const localProviders = ['local', 'ollama'];
    return available.filter((p) => localProviders.includes(p));
  }

  /**
   * Subscription-only: Only use providers that don't charge per-token
   */
  private getSubscriptionOnlyOrder(
    available: string[],
    params: CompletionParams
  ): string[] {
    const subscriptionAvailable = available.filter((p) =>
      SUBSCRIPTION_PROVIDERS.includes(p)
    );

    if (subscriptionAvailable.length === 0) {
      return [];
    }

    // Order by tier, then refine by health
    return this.refineByHealth(this.orderByTier(subscriptionAvailable));
  }

  /**
   * Subscription-first: Prefer subscription providers, fall back to pay-per-token
   *
   * Unlike subscription-only which fails if no subscription providers are available,
   * this strategy gracefully falls back to pay-per-token APIs as a last resort.
   *
   * Order: local → ollama → glm → claude-code → openai → anthropic → gemini
   */
  private getSubscriptionFirstOrder(
    available: string[],
    _params: CompletionParams
  ): string[] {
    // Separate subscription and pay-per-token providers
    const subscription = available.filter((p) => SUBSCRIPTION_PROVIDERS.includes(p));
    const payPerToken = available.filter((p) => PAY_PER_TOKEN_PROVIDERS.includes(p));

    // Order each group by tier
    const orderedSub = this.orderByTier(subscription);
    const orderedPay = this.orderByTier(payPerToken);

    // Refine each group by health (within group)
    const healthySub = this.refineByHealth(orderedSub);
    const healthyPay = this.refineByHealth(orderedPay);

    // Subscription first, then pay-per-token as fallback
    return [...healthySub, ...healthyPay];
  }

  /**
   * Fastest: Order by speed tier, then by health score
   */
  private getFastestOrder(available: string[], _params: CompletionParams): string[] {
    const tieredOrder = this.orderByTier(available);
    return this.refineByHealth(tieredOrder);
  }

  /**
   * Cheapest: Prioritize free/subscription options, then cheapest APIs
   */
  private getCheapestOrder(available: string[], _params: CompletionParams): string[] {
    const costOrder = [
      'local',
      'ollama',
      'glm',
      'claude-code',
      'gemini',
      'openai',
      'anthropic',
      'gateway',
    ];

    return available.sort((a, b) => {
      const aIndex = costOrder.indexOf(a);
      const bIndex = costOrder.indexOf(b);
      return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
    });
  }

  /**
   * Quality: Prioritize best models
   */
  private getQualityOrder(available: string[], _params: CompletionParams): string[] {
    const qualityOrder = [
      'anthropic',
      'claude-code',
      'openai',
      'glm',
      'gemini',
      'ollama',
      'local',
      'gateway',
    ];

    return available.sort((a, b) => {
      const aIndex = qualityOrder.indexOf(a);
      const bIndex = qualityOrder.indexOf(b);
      return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
    });
  }

  /**
   * Order providers by speed tier
   */
  private orderByTier(providers: string[]): string[] {
    const ordered: string[] = [];

    for (const tier of this.speedTiers) {
      if (providers.includes(tier.provider) && !ordered.includes(tier.provider)) {
        ordered.push(tier.provider);
      }
    }

    // Add any remaining providers not in tiers
    for (const provider of providers) {
      if (!ordered.includes(provider)) {
        ordered.push(provider);
      }
    }

    return ordered;
  }

  /**
   * Refine order based on health scores (EWMA latency + success rate)
   */
  private refineByHealth(providers: string[]): string[] {
    // Need some data before health-based reordering
    const providersWithData = providers.filter((p) => this.metrics.hasReliableData(p));

    if (providersWithData.length < 2) {
      return providers; // Not enough data for meaningful reordering
    }

    // Sort by health score (higher is better)
    return [...providers].sort((a, b) => {
      const aScore = this.metrics.getMetrics(a).getHealthScore();
      const bScore = this.metrics.getMetrics(b).getHealthScore();
      return bScore - aScore; // Descending (higher score first)
    });
  }

  /**
   * Record a successful completion
   */
  recordSuccess(provider: string, latencyMs: number): void {
    this.metrics.recordSuccess(provider, latencyMs);
    this.circuitBreakers.recordSuccess(provider);
  }

  /**
   * Record a failed completion
   */
  recordFailure(provider: string): void {
    this.metrics.recordFailure(provider);
    this.circuitBreakers.recordFailure(provider);
  }

  /**
   * Get health score for a provider (for debugging/monitoring)
   */
  getHealthScore(provider: string): number {
    return this.metrics.getMetrics(provider).getHealthScore();
  }

  /**
   * Get EWMA latency for a provider
   */
  getLatency(provider: string): number {
    return this.metrics.getMetrics(provider).getLatency();
  }

  /**
   * Get circuit breaker state for a provider
   */
  getCircuitState(provider: string): 'CLOSED' | 'OPEN' | 'HALF_OPEN' {
    return this.circuitBreakers.getBreaker(provider).getState();
  }

  /**
   * Check if a provider is healthy (circuit not open)
   */
  isHealthy(provider: string): boolean {
    return this.circuitBreakers.canExecute(provider);
  }

  /**
   * Get all providers with open circuits
   */
  getOpenCircuits(): string[] {
    return this.circuitBreakers.getOpenCircuits();
  }

  /**
   * Set custom speed tiers
   */
  setSpeedTiers(tiers: SpeedTier[]): void {
    this.speedTiers = tiers;
  }

  /**
   * Clear availability cache (force re-check)
   */
  clearAvailabilityCache(): void {
    this.availabilityCache.clear();
  }

  /**
   * Reset all health tracking (metrics and circuit breakers)
   */
  resetHealth(): void {
    this.metrics.resetAll();
    this.circuitBreakers.resetAll();
  }

  // Legacy API compatibility
  /** @deprecated Use recordSuccess instead */
  recordLatency(provider: string, _model: string, latencyMs: number): void {
    this.recordSuccess(provider, latencyMs);
  }

  /** @deprecated Use getLatency instead */
  getAverageLatency(provider: string): number | undefined {
    const m = this.metrics.getMetrics(provider);
    return m.getTotalRequests() > 0 ? m.getLatency() : undefined;
  }
}
