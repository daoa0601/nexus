/**
 * Circuit Breaker - Prevents repeated calls to failing providers
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Provider is failing, requests are blocked
 * - HALF_OPEN: Testing if provider has recovered (allows one request)
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening circuit. Default: 3 */
  failureThreshold?: number;
  /** Time in ms before attempting recovery. Default: 30000 (30s) */
  recoveryTimeout?: number;
  /** Number of successes in HALF_OPEN before closing. Default: 1 */
  successThreshold?: number;
}

export interface CircuitBreakerSnapshot {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailure: number | null;
  lastStateChange: number;
}

/**
 * Circuit breaker for a single provider
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures: number = 0;
  private successes: number = 0;
  private lastFailure: number | null = null;
  private lastStateChange: number = Date.now();

  private readonly failureThreshold: number;
  private readonly recoveryTimeout: number;
  private readonly successThreshold: number;

  constructor(config: CircuitBreakerConfig = {}) {
    this.failureThreshold = config.failureThreshold ?? 3;
    this.recoveryTimeout = config.recoveryTimeout ?? 30000;
    this.successThreshold = config.successThreshold ?? 1;
  }

  /**
   * Check if a request can be executed
   * Returns true if circuit allows the request
   */
  canExecute(): boolean {
    switch (this.state) {
      case 'CLOSED':
        return true;

      case 'OPEN':
        // Check if recovery timeout has passed
        if (this.lastFailure && Date.now() - this.lastFailure >= this.recoveryTimeout) {
          this.transitionTo('HALF_OPEN');
          return true; // Allow one test request
        }
        return false;

      case 'HALF_OPEN':
        // In HALF_OPEN, we allow requests to test recovery
        return true;
    }
  }

  /**
   * Record a successful request
   */
  recordSuccess(): void {
    this.failures = 0;

    switch (this.state) {
      case 'CLOSED':
        // Stay closed, all is well
        break;

      case 'HALF_OPEN':
        this.successes++;
        if (this.successes >= this.successThreshold) {
          // Recovery confirmed, close the circuit
          this.transitionTo('CLOSED');
        }
        break;

      case 'OPEN':
        // Shouldn't happen (canExecute returns false), but handle gracefully
        this.transitionTo('CLOSED');
        break;
    }
  }

  /**
   * Record a failed request
   */
  recordFailure(): void {
    this.failures++;
    this.lastFailure = Date.now();

    switch (this.state) {
      case 'CLOSED':
        if (this.failures >= this.failureThreshold) {
          this.transitionTo('OPEN');
        }
        break;

      case 'HALF_OPEN':
        // Recovery failed, back to OPEN
        this.transitionTo('OPEN');
        break;

      case 'OPEN':
        // Already open, stay open
        break;
    }
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    // Check for automatic OPEN -> HALF_OPEN transition
    if (this.state === 'OPEN') {
      if (this.lastFailure && Date.now() - this.lastFailure >= this.recoveryTimeout) {
        this.transitionTo('HALF_OPEN');
      }
    }
    return this.state;
  }

  /**
   * Check if circuit is allowing requests
   */
  isAvailable(): boolean {
    return this.canExecute();
  }

  /**
   * Get time remaining until recovery attempt (ms)
   * Returns 0 if circuit is not OPEN
   */
  getTimeUntilRecovery(): number {
    if (this.state !== 'OPEN' || !this.lastFailure) {
      return 0;
    }
    const elapsed = Date.now() - this.lastFailure;
    return Math.max(0, this.recoveryTimeout - elapsed);
  }

  /**
   * Force circuit to a specific state (for testing/admin)
   */
  forceState(state: CircuitState): void {
    this.transitionTo(state);
    if (state === 'CLOSED') {
      this.failures = 0;
      this.lastFailure = null;
    }
  }

  /**
   * Reset circuit to initial closed state
   */
  reset(): void {
    this.state = 'CLOSED';
    this.failures = 0;
    this.successes = 0;
    this.lastFailure = null;
    this.lastStateChange = Date.now();
  }

  /**
   * Get a snapshot of circuit state
   */
  getSnapshot(): CircuitBreakerSnapshot {
    return {
      state: this.getState(),
      failures: this.failures,
      successes: this.successes,
      lastFailure: this.lastFailure,
      lastStateChange: this.lastStateChange,
    };
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.lastStateChange = Date.now();
      this.successes = 0; // Reset success counter on state change
    }
  }
}

/**
 * Manages circuit breakers for all providers
 */
export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();
  private readonly config: CircuitBreakerConfig;

  constructor(config: CircuitBreakerConfig = {}) {
    this.config = config;
  }

  /**
   * Get or create circuit breaker for a provider
   */
  getBreaker(providerId: string): CircuitBreaker {
    let breaker = this.breakers.get(providerId);
    if (!breaker) {
      breaker = new CircuitBreaker(this.config);
      this.breakers.set(providerId, breaker);
    }
    return breaker;
  }

  /**
   * Check if a provider can accept requests
   */
  canExecute(providerId: string): boolean {
    return this.getBreaker(providerId).canExecute();
  }

  /**
   * Record a successful request for a provider
   */
  recordSuccess(providerId: string): void {
    this.getBreaker(providerId).recordSuccess();
  }

  /**
   * Record a failed request for a provider
   */
  recordFailure(providerId: string): void {
    this.getBreaker(providerId).recordFailure();
  }

  /**
   * Get all providers that are currently available (circuit not OPEN)
   */
  getAvailableProviders(providerIds: string[]): string[] {
    return providerIds.filter((id) => this.canExecute(id));
  }

  /**
   * Get all providers with OPEN circuits
   */
  getOpenCircuits(): string[] {
    return Array.from(this.breakers.entries())
      .filter(([_, breaker]) => breaker.getState() === 'OPEN')
      .map(([id]) => id);
  }

  /**
   * Get snapshots for all circuit breakers
   */
  getAllSnapshots(): Map<string, CircuitBreakerSnapshot> {
    const snapshots = new Map<string, CircuitBreakerSnapshot>();
    for (const [id, breaker] of this.breakers) {
      snapshots.set(id, breaker.getSnapshot());
    }
    return snapshots;
  }

  /**
   * Reset all circuit breakers
   */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}
