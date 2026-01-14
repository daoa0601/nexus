/**
 * Racing Executor - Parallel provider execution with staggered starts
 *
 * Executes requests against multiple providers in parallel with configurable
 * staggered starts to balance latency reduction vs API cost.
 */

import type { CompletionParams, CompletionResponse } from '../types.ts';
import type { LLMProvider } from '../providers/base.ts';
import type { MetricsRegistry } from '../router/metrics.ts';
import type { CircuitBreakerRegistry } from '../router/circuit-breaker.ts';

export interface RacingConfig {
  /** Number of providers to race simultaneously. Default: 2 */
  raceCount?: number;
  /** Delay in ms before starting subsequent providers. Default: 500 */
  staggerMs?: number;
  /** Global timeout for entire operation in ms. Default: 30000 */
  globalTimeout?: number;
  /** Whether racing is enabled. Default: true */
  enabled?: boolean;
}

export interface RacingResult {
  response: CompletionResponse;
  /** Providers that were started (may include cancelled) */
  startedProviders: string[];
  /** Provider that won the race */
  winningProvider: string;
  /** Whether any providers were cancelled */
  hadCancellations: boolean;
}

interface RaceEntry {
  providerId: string;
  promise: Promise<CompletionResponse>;
  controller: AbortController;
  started: boolean;
  startTime: number;
}

/**
 * Executes completion requests with parallel racing and staggered starts
 */
export class RacingExecutor {
  private readonly raceCount: number;
  private readonly staggerMs: number;
  private readonly globalTimeout: number;
  private readonly enabled: boolean;

  constructor(config: RacingConfig = {}) {
    this.raceCount = config.raceCount ?? 2;
    this.staggerMs = config.staggerMs ?? 500;
    this.globalTimeout = config.globalTimeout ?? 30000;
    this.enabled = config.enabled ?? true;
  }

  /**
   * Execute request against ordered providers with racing
   *
   * @param providers - Map of all available providers
   * @param orderedIds - Provider IDs in priority order (best first)
   * @param params - Completion parameters
   * @param metrics - Optional metrics registry for recording results
   * @param circuitBreakers - Optional circuit breaker registry
   */
  async execute(
    providers: Map<string, LLMProvider>,
    orderedIds: string[],
    params: CompletionParams,
    metrics?: MetricsRegistry,
    circuitBreakers?: CircuitBreakerRegistry
  ): Promise<RacingResult> {
    // Filter to providers with closed/half-open circuits
    const eligibleIds = circuitBreakers
      ? orderedIds.filter((id) => circuitBreakers.canExecute(id))
      : orderedIds;

    if (eligibleIds.length === 0) {
      throw new Error('No eligible providers available (all circuits open or no providers)');
    }

    // If racing disabled or only one provider, fall back to sequential
    if (!this.enabled || eligibleIds.length === 1) {
      return this.executeSequential(providers, eligibleIds, params, metrics, circuitBreakers);
    }

    // Select providers to race (top N from ordered list)
    const racingIds = eligibleIds.slice(0, Math.min(this.raceCount, eligibleIds.length));

    // Create race entries with staggered starts
    const entries = this.createRaceEntries(providers, racingIds, params);

    try {
      // Race with global timeout
      const result = await this.raceWithTimeout(entries);

      // Record metrics for winner
      if (metrics) {
        metrics.recordSuccess(result.response.provider, result.response.latencyMs);
      }
      if (circuitBreakers) {
        circuitBreakers.recordSuccess(result.response.provider);
      }

      // Cancel losers
      this.cancelEntries(entries, result.winningProvider);

      return result;
    } catch (error) {
      // All racers failed - record failures and try remaining providers sequentially
      for (const entry of entries) {
        if (entry.started) {
          if (metrics) {
            metrics.recordFailure(entry.providerId);
          }
          if (circuitBreakers) {
            circuitBreakers.recordFailure(entry.providerId);
          }
        }
      }

      // Fall back to remaining providers (not in initial race)
      const remainingIds = eligibleIds.slice(this.raceCount);
      if (remainingIds.length > 0) {
        return this.executeSequential(
          providers,
          remainingIds,
          params,
          metrics,
          circuitBreakers
        );
      }

      throw error;
    }
  }

  /**
   * Create race entries with staggered start promises
   */
  private createRaceEntries(
    providers: Map<string, LLMProvider>,
    providerIds: string[],
    params: CompletionParams
  ): RaceEntry[] {
    return providerIds.map((providerId, index) => {
      const controller = new AbortController();
      const staggerDelay = index * this.staggerMs;

      const entry: RaceEntry = {
        providerId,
        controller,
        started: false,
        startTime: 0,
        promise: this.createStaggeredPromise(
          providers.get(providerId)!,
          params,
          controller.signal,
          staggerDelay,
          () => {
            entry.started = true;
            entry.startTime = Date.now();
          }
        ),
      };

      return entry;
    });
  }

  /**
   * Create a promise that waits for stagger delay before executing
   */
  private async createStaggeredPromise(
    provider: LLMProvider,
    params: CompletionParams,
    signal: AbortSignal,
    delayMs: number,
    onStart: () => void
  ): Promise<CompletionResponse> {
    // Wait for stagger delay (can be cancelled)
    if (delayMs > 0) {
      await this.delay(delayMs, signal);
    }

    // Check if cancelled during delay
    if (signal.aborted) {
      throw new Error('Request cancelled');
    }

    // Mark as started and execute
    onStart();
    return provider.complete(params);
  }

  /**
   * Race all entries with global timeout
   */
  private async raceWithTimeout(entries: RaceEntry[]): Promise<RacingResult> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Global timeout exceeded (${this.globalTimeout}ms)`));
      }, this.globalTimeout);
    });

    // Create racing promise that wraps results
    const racingPromises = entries.map(async (entry) => {
      const response = await entry.promise;
      return {
        response,
        startedProviders: entries.filter((e) => e.started).map((e) => e.providerId),
        winningProvider: entry.providerId,
        hadCancellations: entries.some((e) => e.started && e.providerId !== entry.providerId),
      } satisfies RacingResult;
    });

    return Promise.race([...racingPromises, timeoutPromise]);
  }

  /**
   * Cancel all entries except the winner
   */
  private cancelEntries(entries: RaceEntry[], winnerId: string): void {
    for (const entry of entries) {
      if (entry.providerId !== winnerId) {
        entry.controller.abort();
      }
    }
  }

  /**
   * Sequential fallback execution
   */
  private async executeSequential(
    providers: Map<string, LLMProvider>,
    orderedIds: string[],
    params: CompletionParams,
    metrics?: MetricsRegistry,
    circuitBreakers?: CircuitBreakerRegistry
  ): Promise<RacingResult> {
    let lastError: Error | undefined;

    for (const providerId of orderedIds) {
      const provider = providers.get(providerId);
      if (!provider) continue;

      // Skip if circuit is open
      if (circuitBreakers && !circuitBreakers.canExecute(providerId)) {
        continue;
      }

      try {
        const response = await provider.complete(params);

        // Record success
        if (metrics) {
          metrics.recordSuccess(providerId, response.latencyMs);
        }
        if (circuitBreakers) {
          circuitBreakers.recordSuccess(providerId);
        }

        return {
          response,
          startedProviders: [providerId],
          winningProvider: providerId,
          hadCancellations: false,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Record failure
        if (metrics) {
          metrics.recordFailure(providerId);
        }
        if (circuitBreakers) {
          circuitBreakers.recordFailure(providerId);
        }
      }
    }

    throw lastError ?? new Error('All providers failed');
  }

  /**
   * Cancellable delay
   */
  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(resolve, ms);

      if (signal) {
        if (signal.aborted) {
          clearTimeout(timeoutId);
          reject(new Error('Cancelled'));
          return;
        }

        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timeoutId);
            reject(new Error('Cancelled'));
          },
          { once: true }
        );
      }
    });
  }
}
