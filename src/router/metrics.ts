/**
 * Provider Metrics - EWMA latency tracking and health scoring
 *
 * Uses Exponentially Weighted Moving Average for latency tracking,
 * which weights recent observations more heavily than older ones.
 */

export interface MetricsSnapshot {
  ewmaLatency: number;
  successRate: number;
  totalRequests: number;
  recentFailures: number;
  lastUpdated: number;
}

export interface MetricsConfig {
  /** EWMA smoothing factor (0-1). Higher = more weight to recent data. Default: 0.3 */
  alpha?: number;
  /** Initial latency estimate in ms. Default: 500 */
  initialLatency?: number;
  /** Window size for success rate calculation. Default: 20 */
  successWindow?: number;
}

/**
 * Tracks metrics for a single provider using EWMA
 */
export class ProviderMetrics {
  private ewmaLatency: number;
  private readonly alpha: number;
  private readonly successWindow: number;

  // Sliding window for success/failure tracking
  private outcomes: boolean[] = [];
  private totalRequests: number = 0;
  private lastUpdated: number = Date.now();

  // Incremental tracking to avoid O(n) filter operations
  private successCount: number = 0;

  constructor(config: MetricsConfig = {}) {
    this.alpha = config.alpha ?? 0.3;
    this.ewmaLatency = config.initialLatency ?? 500;
    this.successWindow = config.successWindow ?? 20;
  }

  /**
   * Record a successful request with its latency
   */
  recordSuccess(latencyMs: number): void {
    // Update EWMA: new = α * observation + (1-α) * previous
    this.ewmaLatency = this.alpha * latencyMs + (1 - this.alpha) * this.ewmaLatency;

    this.recordOutcome(true);
    this.lastUpdated = Date.now();
  }

  /**
   * Record a failed request
   */
  recordFailure(): void {
    this.recordOutcome(false);
    this.lastUpdated = Date.now();
  }

  /**
   * Get the current EWMA latency estimate
   */
  getLatency(): number {
    return this.ewmaLatency;
  }

  /**
   * Get the success rate (0-1) over the recent window
   * Optimized: O(1) using incremental tracking instead of O(n) filter
   */
  getSuccessRate(): number {
    if (this.outcomes.length === 0) return 1; // Assume success if no data
    return this.successCount / this.outcomes.length;
  }

  /**
   * Get total requests tracked
   */
  getTotalRequests(): number {
    return this.totalRequests;
  }

  /**
   * Get count of recent failures (in current window)
   * Optimized: O(1) using incremental tracking instead of O(n) filter
   */
  getRecentFailures(): number {
    return this.outcomes.length - this.successCount;
  }

  /**
   * Calculate composite health score
   * Higher is better: combines low latency with high success rate
   *
   * Formula: (1000 / latency) * successRate
   * - Latency of 100ms, 100% success = 10
   * - Latency of 500ms, 100% success = 2
   * - Latency of 500ms, 80% success = 1.6
   */
  getHealthScore(): number {
    const latency = Math.max(this.ewmaLatency, 1); // Prevent division by zero
    const successRate = this.getSuccessRate();
    return (1000 / latency) * successRate;
  }

  /**
   * Get a snapshot of all metrics
   */
  getSnapshot(): MetricsSnapshot {
    return {
      ewmaLatency: this.ewmaLatency,
      successRate: this.getSuccessRate(),
      totalRequests: this.totalRequests,
      recentFailures: this.getRecentFailures(),
      lastUpdated: this.lastUpdated,
    };
  }

  /**
   * Check if we have enough data for reliable metrics
   */
  hasReliableData(): boolean {
    return this.totalRequests >= 5;
  }

  /**
   * Reset metrics to initial state
   */
  reset(initialLatency?: number): void {
    this.ewmaLatency = initialLatency ?? 500;
    this.outcomes = [];
    this.totalRequests = 0;
    this.successCount = 0;
    this.lastUpdated = Date.now();
  }

  private recordOutcome(success: boolean): void {
    // Track evicted element before shifting
    if (this.outcomes.length >= this.successWindow) {
      const evicted = this.outcomes.shift();
      if (evicted) {
        this.successCount--;
      }
    }

    this.outcomes.push(success);
    this.totalRequests++;

    // Update incremental success count
    if (success) {
      this.successCount++;
    }
  }
}

/**
 * Manages metrics for all providers
 */
export class MetricsRegistry {
  private metrics = new Map<string, ProviderMetrics>();
  private readonly config: MetricsConfig;

  constructor(config: MetricsConfig = {}) {
    this.config = config;
  }

  /**
   * Get or create metrics for a provider
   */
  getMetrics(providerId: string): ProviderMetrics {
    let m = this.metrics.get(providerId);
    if (!m) {
      m = new ProviderMetrics(this.config);
      this.metrics.set(providerId, m);
    }
    return m;
  }

  /**
   * Record a successful request
   */
  recordSuccess(providerId: string, latencyMs: number): void {
    this.getMetrics(providerId).recordSuccess(latencyMs);
  }

  /**
   * Record a failed request
   */
  recordFailure(providerId: string): void {
    this.getMetrics(providerId).recordFailure();
  }

  /**
   * Get all providers sorted by health score (best first)
   */
  getProvidersByHealth(): string[] {
    return Array.from(this.metrics.entries())
      .sort((a, b) => b[1].getHealthScore() - a[1].getHealthScore())
      .map(([id]) => id);
  }

  /**
   * Get health scores for all tracked providers
   */
  getAllScores(): Map<string, number> {
    const scores = new Map<string, number>();
    for (const [id, m] of this.metrics) {
      scores.set(id, m.getHealthScore());
    }
    return scores;
  }

  /**
   * Get snapshots for all providers
   */
  getAllSnapshots(): Map<string, MetricsSnapshot> {
    const snapshots = new Map<string, MetricsSnapshot>();
    for (const [id, m] of this.metrics) {
      snapshots.set(id, m.getSnapshot());
    }
    return snapshots;
  }

  /**
   * Check if a provider has reliable metrics data
   */
  hasReliableData(providerId: string): boolean {
    const m = this.metrics.get(providerId);
    return m ? m.hasReliableData() : false;
  }

  /**
   * Reset all metrics
   */
  resetAll(): void {
    this.metrics.clear();
  }
}
