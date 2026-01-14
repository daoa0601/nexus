/**
 * Unit tests for CircuitBreaker and CircuitBreakerRegistry
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { CircuitBreaker, CircuitBreakerRegistry } from '../src/router/circuit-breaker.ts';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      recoveryTimeout: 1000, // 1 second for faster tests
      successThreshold: 1,
    });
  });

  describe('initial state', () => {
    it('should start in CLOSED state', () => {
      expect(breaker.getState()).toBe('CLOSED');
    });

    it('should allow execution in CLOSED state', () => {
      expect(breaker.canExecute()).toBe(true);
    });
  });

  describe('state transitions', () => {
    it('should stay CLOSED after successful requests', () => {
      breaker.recordSuccess();
      breaker.recordSuccess();
      breaker.recordSuccess();

      expect(breaker.getState()).toBe('CLOSED');
    });

    it('should transition to OPEN after threshold failures', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe('CLOSED');

      breaker.recordFailure(); // 3rd failure
      expect(breaker.getState()).toBe('OPEN');
    });

    it('should block execution in OPEN state', () => {
      // Trip the breaker
      for (let i = 0; i < 3; i++) breaker.recordFailure();

      expect(breaker.getState()).toBe('OPEN');
      expect(breaker.canExecute()).toBe(false);
    });

    it('should transition to HALF_OPEN after recovery timeout', async () => {
      // Trip the breaker
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      expect(breaker.getState()).toBe('OPEN');

      // Wait for recovery timeout
      await new Promise((r) => setTimeout(r, 1100));

      expect(breaker.getState()).toBe('HALF_OPEN');
      expect(breaker.canExecute()).toBe(true);
    });

    it('should transition to CLOSED after success in HALF_OPEN', async () => {
      // Trip the breaker
      for (let i = 0; i < 3; i++) breaker.recordFailure();

      // Wait for recovery
      await new Promise((r) => setTimeout(r, 1100));
      expect(breaker.getState()).toBe('HALF_OPEN');

      // Record success
      breaker.recordSuccess();
      expect(breaker.getState()).toBe('CLOSED');
    });

    it('should transition back to OPEN after failure in HALF_OPEN', async () => {
      // Trip the breaker
      for (let i = 0; i < 3; i++) breaker.recordFailure();

      // Wait for recovery
      await new Promise((r) => setTimeout(r, 1100));
      expect(breaker.getState()).toBe('HALF_OPEN');

      // Record failure
      breaker.recordFailure();
      expect(breaker.getState()).toBe('OPEN');
    });
  });

  describe('failure reset', () => {
    it('should reset failure count on success', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordSuccess(); // Resets count

      // Need 3 more failures to trip
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe('CLOSED');

      breaker.recordFailure();
      expect(breaker.getState()).toBe('OPEN');
    });
  });

  describe('getTimeUntilRecovery', () => {
    it('should return 0 when CLOSED', () => {
      expect(breaker.getTimeUntilRecovery()).toBe(0);
    });

    it('should return positive value when OPEN', () => {
      for (let i = 0; i < 3; i++) breaker.recordFailure();

      const timeUntil = breaker.getTimeUntilRecovery();
      expect(timeUntil).toBeGreaterThan(0);
      expect(timeUntil).toBeLessThanOrEqual(1000);
    });
  });

  describe('reset', () => {
    it('should reset to initial state', () => {
      // Trip the breaker
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      expect(breaker.getState()).toBe('OPEN');

      breaker.reset();
      expect(breaker.getState()).toBe('CLOSED');
      expect(breaker.canExecute()).toBe(true);
    });
  });

  describe('forceState', () => {
    it('should force state to OPEN', () => {
      breaker.forceState('OPEN');
      expect(breaker.getState()).toBe('OPEN');
    });

    it('should force state to CLOSED and reset failures', () => {
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      breaker.forceState('CLOSED');

      expect(breaker.getState()).toBe('CLOSED');
      // Should need full 3 failures to trip again
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe('CLOSED');
    });
  });
});

describe('CircuitBreakerRegistry', () => {
  let registry: CircuitBreakerRegistry;

  beforeEach(() => {
    registry = new CircuitBreakerRegistry({
      failureThreshold: 3,
      recoveryTimeout: 1000,
    });
  });

  it('should create breakers on demand', () => {
    const breaker = registry.getBreaker('openai');
    expect(breaker).toBeDefined();
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('should return same breaker for same provider', () => {
    const breaker1 = registry.getBreaker('openai');
    const breaker2 = registry.getBreaker('openai');
    expect(breaker1).toBe(breaker2);
  });

  it('should check if provider can execute', () => {
    expect(registry.canExecute('openai')).toBe(true);

    // Trip the breaker
    for (let i = 0; i < 3; i++) registry.recordFailure('openai');

    expect(registry.canExecute('openai')).toBe(false);
  });

  it('should filter available providers', () => {
    // Trip openai breaker
    for (let i = 0; i < 3; i++) registry.recordFailure('openai');

    const available = registry.getAvailableProviders(['openai', 'anthropic', 'gemini']);
    expect(available).toEqual(['anthropic', 'gemini']);
  });

  it('should list open circuits', () => {
    // Trip openai breaker
    for (let i = 0; i < 3; i++) registry.recordFailure('openai');

    const open = registry.getOpenCircuits();
    expect(open).toContain('openai');
  });

  it('should reset all breakers', () => {
    // Trip multiple breakers
    for (let i = 0; i < 3; i++) {
      registry.recordFailure('openai');
      registry.recordFailure('anthropic');
    }

    registry.resetAll();

    expect(registry.canExecute('openai')).toBe(true);
    expect(registry.canExecute('anthropic')).toBe(true);
  });
});
