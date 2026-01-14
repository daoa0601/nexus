/**
 * LLMGateway - Unified interface for multiple LLM providers
 *
 * Features:
 * - Parallel provider racing with staggered starts
 * - Health-aware routing with EWMA latency tracking
 * - Circuit breaker for failing providers
 * - Explicit initialization to prevent race conditions
 * - SHA256 cache key normalization
 */

import type {
  GatewayConfig,
  CompletionParams,
  CompletionResponse,
  ProviderStatus,
  TranslateParams,
  GenerateParams,
  ExplainParams,
  RoutingStrategy,
  UsageReport,
  WarmupReport,
} from './types.ts';
import { NoProvidersAvailableError, LLMError } from './types.ts';
import { LLMProvider } from './providers/base.ts';
import { Router, type RouterConfig } from './router.ts';
import type { CacheAdapter } from './cache/adapter.ts';
import { MemoryCache } from './cache/memory.ts';
import type { UsageLogger } from './usage/logger.ts';
import { RacingExecutor, type RacingConfig } from './executor/racing-executor.ts';
import { createHash } from 'crypto';

// DNS prefetch for common provider endpoints (Bun optimization)
async function prefetchDNS(): Promise<void> {
  try {
    // Dynamic import of Bun's dns module - only available in Bun runtime
    const bunModule = await import('bun');
    const dns = (bunModule as { dns?: { prefetch: (host: string) => void } }).dns;
    if (dns?.prefetch) {
      dns.prefetch('api.openai.com');
      dns.prefetch('api.anthropic.com');
      dns.prefetch('api.z.ai');
      dns.prefetch('generativelanguage.googleapis.com');
    }
  } catch {
    // Not running in Bun, skip DNS prefetch
  }
}

export class LLMGateway {
  private providers: Map<string, LLMProvider> = new Map();
  private router: Router;
  private executor: RacingExecutor;
  private cache: CacheAdapter | null = null;
  private usageLogger?: UsageLogger;
  private config: GatewayConfig;

  /**
   * Promise that resolves when all providers are initialized.
   * Await this before making requests to ensure no race conditions.
   */
  readonly ready: Promise<void>;

  constructor(config: GatewayConfig) {
    this.config = config;

    // Initialize router with new health-aware config
    const routerConfig: RouterConfig = {
      strategy: config.strategy ?? 'fastest',
      metrics: config.metrics,
      circuitBreaker: config.circuitBreaker,
    };
    this.router = new Router(routerConfig);

    // Initialize racing executor
    const racingConfig: RacingConfig = {
      enabled: config.racing?.enabled ?? true,
      raceCount: config.racing?.raceCount ?? 2,
      staggerMs: config.racing?.staggerMs ?? 500,
      globalTimeout: config.globalTimeout ?? 30000,
    };
    this.executor = new RacingExecutor(racingConfig);

    // Initialize everything and store the ready promise
    this.ready = this.initialize(config);
  }

  /**
   * Initialize all components asynchronously
   */
  private async initialize(config: GatewayConfig): Promise<void> {
    // Start DNS prefetch in background
    prefetchDNS();

    // Initialize providers, cache, and usage logger in parallel
    await Promise.all([
      this.initializeProviders(config),
      this.initializeCache(config),
      this.initializeUsage(config),
    ]);
  }

  /**
   * Initialize configured providers - waits for all to complete
   */
  private async initializeProviders(config: GatewayConfig): Promise<void> {
    const { providers } = config;
    const imports: Promise<void>[] = [];

    if (providers.openai) {
      imports.push(
        import('./providers/openai.ts').then(({ OpenAIProvider }) => {
          this.providers.set('openai', new OpenAIProvider(providers.openai!));
          this.router.addProvider('openai');
        })
      );
    }

    if (providers.ollama) {
      imports.push(
        import('./providers/ollama.ts').then(({ OllamaProvider }) => {
          this.providers.set('ollama', new OllamaProvider(providers.ollama!));
          this.router.addProvider('ollama');
        })
      );
    }

    if (providers.anthropic) {
      imports.push(
        import('./providers/anthropic.ts').then(({ AnthropicProvider }) => {
          this.providers.set('anthropic', new AnthropicProvider(providers.anthropic!));
          this.router.addProvider('anthropic');
        })
      );
    }

    if (providers.gemini) {
      imports.push(
        import('./providers/gemini.ts').then(({ GeminiProvider }) => {
          this.providers.set('gemini', new GeminiProvider(providers.gemini!));
          this.router.addProvider('gemini');
        })
      );
    }

    if (providers.local) {
      imports.push(
        import('./providers/local.ts').then(({ LocalProvider }) => {
          this.providers.set('local', new LocalProvider(providers.local!));
          this.router.addProvider('local');
        })
      );
    }

    if (providers.gateway) {
      imports.push(
        import('./providers/gateway.ts').then(({ GatewayProvider }) => {
          this.providers.set('gateway', new GatewayProvider(providers.gateway!));
          this.router.addProvider('gateway');
        })
      );
    }

    // Subscription-based providers (no pay-per-token billing)
    if (providers['claude-code']) {
      imports.push(
        import('./providers/claude-code.ts').then(({ ClaudeCodeProvider }) => {
          this.providers.set(
            'claude-code',
            new ClaudeCodeProvider(providers['claude-code']!)
          );
          this.router.addProvider('claude-code');
        })
      );
    }

    if (providers.glm) {
      imports.push(
        import('./providers/glm.ts').then(({ GLMProvider }) => {
          this.providers.set('glm', new GLMProvider(providers.glm!));
          this.router.addProvider('glm');
        })
      );
    }

    // Wait for all provider imports to complete
    await Promise.all(imports);
  }

  /**
   * Initialize cache if configured
   */
  private async initializeCache(config: GatewayConfig): Promise<void> {
    if (!config.cache?.enabled) return;

    if (config.cache.adapter === 'sqlite') {
      const { SQLiteCache } = await import('./cache/sqlite.ts');
      this.cache = new SQLiteCache({
        dbPath: config.cache.dbPath ?? './llm-cache.db',
        ttlMs: config.cache.ttlMs ?? 3600000,
      });
    } else {
      this.cache = new MemoryCache({
        maxSize: config.cache.maxSize ?? 1000,
        ttlMs: config.cache.ttlMs ?? 3600000,
      });
    }
  }

  /**
   * Initialize usage logger if configured
   */
  private async initializeUsage(config: GatewayConfig): Promise<void> {
    if (!config.usage?.enabled) return;

    try {
      const { UsageLogger } = await import('./usage/logger.ts');
      this.usageLogger = new UsageLogger(config.usage);
    } catch (err) {
      console.warn('Failed to initialize usage logger:', err);
    }
  }

  /**
   * Warm up providers by preloading models and running test inference.
   * Call this after gateway.ready to reduce first-request latency.
   *
   * @param options.providers - Which providers to warm (default: all with preload config)
   * @param options.testPrompt - Warmup prompt (default: "Hello")
   * @returns Report of loaded models and any errors
   */
  async warmup(options?: {
    providers?: string[];
    testPrompt?: string;
  }): Promise<WarmupReport> {
    await this.ready;

    const report: WarmupReport = {
      success: true,
      providers: {},
      totalModelsLoaded: 0,
      totalErrors: 0,
      durationMs: 0,
    };

    const startTime = Date.now();
    const providersToWarm = options?.providers ?? Array.from(this.providers.keys());

    for (const id of providersToWarm) {
      const provider = this.providers.get(id);
      if (!provider) continue;

      // Check if provider supports preloading
      if ('preload' in provider && typeof provider.preload === 'function') {
        try {
          const result = await (provider as { preload: () => Promise<{ loaded: string[]; errors: string[] }> }).preload();
          report.providers[id] = {
            loaded: result.loaded,
            errors: result.errors,
          };
          report.totalModelsLoaded += result.loaded.length;
          report.totalErrors += result.errors.length;
        } catch (err) {
          report.providers[id] = {
            loaded: [],
            errors: [err instanceof Error ? err.message : String(err)],
          };
          report.totalErrors += 1;
        }
      }
    }

    report.durationMs = Date.now() - startTime;
    report.success = report.totalErrors === 0;

    return report;
  }

  /**
   * Get a provider by ID
   */
  getProvider(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * Get all registered providers
   */
  getProviders(): LLMProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get status of all providers
   */
  async status(): Promise<Record<string, ProviderStatus>> {
    await this.ready; // Ensure initialized

    const statuses: Record<string, ProviderStatus> = {};

    await Promise.all(
      Array.from(this.providers.entries()).map(async ([id, provider]) => {
        statuses[id] = await provider.status();
      })
    );

    return statuses;
  }

  /**
   * Complete a request using the configured routing strategy
   * Now with parallel racing and health-aware routing
   */
  async complete(params: CompletionParams): Promise<CompletionResponse> {
    // Ensure all providers are initialized before processing
    await this.ready;

    // Check cache first
    if (this.cache) {
      const cacheKey = this.generateCacheKey(params);
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        const response: CompletionResponse = {
          content: cached.response,
          model: cached.model,
          provider: cached.provider,
          latencyMs: 0,
          cached: true,
        };

        // Log cached response
        if (this.usageLogger) {
          this.logUsage(response, params, [cached.provider], undefined).catch(() => {});
        }

        return response;
      }
    }

    // Get ordered list of providers to try
    const providerOrder = await this.router.getProviderOrder(this.providers, params);

    if (providerOrder.length === 0) {
      throw new NoProvidersAvailableError();
    }

    try {
      // Execute with racing (parallel providers with staggered starts)
      const result = await this.executor.execute(
        this.providers,
        providerOrder,
        params,
        this.router.metrics,
        this.router.circuitBreakers
      );

      const response = result.response;

      // Cache successful response
      if (this.cache && !response.cached) {
        const cacheKey = this.generateCacheKey(params);
        await this.cache.set(cacheKey, response.content, response.model, response.provider);
      }

      // Log successful usage
      if (this.usageLogger) {
        this.logUsage(response, params, result.startedProviders, undefined).catch(() => {});
      }

      return response;
    } catch (error) {
      const lastError = error instanceof Error ? error : new Error(String(error));

      // Log failed attempt
      if (this.usageLogger) {
        this.logUsage(
          {
            content: '',
            model: params.model ?? 'unknown',
            provider: 'none',
            latencyMs: 0,
            cached: false,
          },
          params,
          providerOrder,
          lastError
        ).catch(() => {});
      }

      throw new LLMError(
        `All providers failed. Last error: ${lastError.message}`,
        'none',
        'ALL_PROVIDERS_FAILED',
        lastError
      );
    }
  }

  /**
   * Generate a deterministic cache key using SHA256
   * Normalizes the input to ensure consistent hashing
   */
  private generateCacheKey(params: CompletionParams): string {
    // Normalize messages to ensure consistent ordering
    const normalizedMessages = params.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const normalized = {
      messages: normalizedMessages,
      model: params.model ?? 'default',
      temperature: params.temperature ?? 0.7,
      systemPrompt: params.systemPrompt ?? '',
      maxTokens: params.maxTokens ?? 0,
    };

    // Use SHA256 for deterministic, collision-resistant hashing
    return createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex')
      .slice(0, 32); // 32-char hex string
  }

  // ============================================
  // High-level task helpers
  // ============================================

  /**
   * Translate text between languages
   */
  async translate(params: TranslateParams): Promise<string> {
    const { text, to, from, model } = params;

    const systemPrompt = from
      ? `Translate the following text from ${from} to ${to}. Return only the translation, no explanations.`
      : `Translate the following text to ${to}. Return only the translation, no explanations.`;

    const response = await this.complete({
      messages: [{ role: 'user', content: text }],
      systemPrompt,
      model,
      temperature: 0.3,
    });

    return response.content;
  }

  /**
   * Generate text based on a prompt
   */
  async generate(params: GenerateParams): Promise<string> {
    const { prompt, systemPrompt, model, temperature, maxTokens } = params;

    const response = await this.complete({
      messages: [{ role: 'user', content: prompt }],
      systemPrompt,
      model,
      temperature,
      maxTokens,
    });

    return response.content;
  }

  /**
   * Explain a grammar pattern or concept
   */
  async explain(params: ExplainParams): Promise<string> {
    const { pattern, sentence, language = 'Japanese', model } = params;

    const systemPrompt = `You are a ${language} language teacher. Explain grammar patterns clearly with examples.`;

    const prompt = `Explain the grammar pattern 「${pattern}」 as used in: ${sentence}

Include:
1. Meaning and usage
2. Analysis of the example
3. Additional examples
4. Common mistakes to avoid`;

    const response = await this.complete({
      messages: [{ role: 'user', content: prompt }],
      systemPrompt,
      model,
      temperature: 0.5,
    });

    return response.content;
  }

  // ============================================
  // Router and health management
  // ============================================

  /**
   * Update routing strategy
   */
  setStrategy(strategy: RoutingStrategy): void {
    this.router.setStrategy(strategy);
  }

  /**
   * Get current routing strategy
   */
  getStrategy(): RoutingStrategy {
    return this.router.getStrategy();
  }

  /**
   * Get health score for a specific provider
   */
  getProviderHealth(providerId: string): {
    latency: number;
    healthScore: number;
    circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  } {
    return {
      latency: this.router.getLatency(providerId),
      healthScore: this.router.getHealthScore(providerId),
      circuitState: this.router.getCircuitState(providerId),
    };
  }

  /**
   * Get all providers with open circuits (failing)
   */
  getFailingProviders(): string[] {
    return this.router.getOpenCircuits();
  }

  /**
   * Reset health tracking for all providers
   */
  resetHealthTracking(): void {
    this.router.resetHealth();
  }

  /**
   * Force clear availability cache (triggers re-check on next request)
   */
  refreshAvailability(): void {
    this.router.clearAvailabilityCache();
  }

  // ============================================
  // Cache management
  // ============================================

  /**
   * Clear the cache
   */
  async clearCache(): Promise<void> {
    if (this.cache) {
      await this.cache.clear();
    }
  }

  // ============================================
  // Usage tracking
  // ============================================

  /**
   * Log usage (helper method)
   */
  private async logUsage(
    response: CompletionResponse,
    params: CompletionParams,
    providerOrder: string[],
    error?: Error
  ): Promise<void> {
    if (!this.usageLogger) return;

    await this.usageLogger.log(response, params, {
      sessionId: this.usageLogger.getSessionId(),
      strategy: this.router.getStrategy(),
      providerOrder,
      error,
    });
  }

  /**
   * Get usage analytics report
   */
  async getUsageReport(options?: {
    startDate?: Date;
    endDate?: Date;
    groupBy?: 'provider' | 'model' | 'day';
  }): Promise<UsageReport | null> {
    if (!this.usageLogger) return null;
    return this.usageLogger.getReport(options);
  }

  /**
   * Get current usage session ID
   */
  getUsageSessionId(): string | undefined {
    return this.usageLogger?.getSessionId();
  }

  /**
   * Set a new usage session ID
   */
  setUsageSessionId(sessionId: string): void {
    if (this.usageLogger) {
      this.usageLogger.setSessionId(sessionId);
    }
  }

  /**
   * Graceful shutdown - flush logs and close connections
   */
  async close(): Promise<void> {
    if (this.usageLogger && 'flush' in this.usageLogger) {
      await (this.usageLogger as unknown as { flush: () => Promise<void> }).flush();
    }
  }
}
