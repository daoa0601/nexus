/**
 * Unit tests for ProviderMetrics and MetricsRegistry
 */

import { describe, it, expect } from 'bun:test';
import { ProviderMetrics, MetricsRegistry } from '../src/router/metrics.ts';

describe('ProviderMetrics', () => {
  describe('EWMA latency tracking', () => {
    it('should initialize with default latency', () => {
      const metrics = new ProviderMetrics();
      expect(metrics.getLatency()).toBe(500);
    });

    it('should initialize with custom latency', () => {
      const metrics = new ProviderMetrics({ initialLatency: 200 });
      expect(metrics.getLatency()).toBe(200);
    });

    it('should update EWMA on success', () => {
      const metrics = new ProviderMetrics({ initialLatency: 500, alpha: 0.3 });

      // Record 100ms latency
      metrics.recordSuccess(100);

      // EWMA = 0.3 * 100 + 0.7 * 500 = 30 + 350 = 380
      expect(metrics.getLatency()).toBe(380);
    });

    it('should weight recent observations more heavily', () => {
      const metrics = new ProviderMetrics({ initialLatency: 1000, alpha: 0.5 });

      // Record several fast responses
      metrics.recordSuccess(100);
      metrics.recordSuccess(100);
      metrics.recordSuccess(100);
      metrics.recordSuccess(100);

      // Should be much closer to 100 than 1000
      expect(metrics.getLatency()).toBeLessThan(200);
    });
  });

  describe('success rate tracking', () => {
    it('should start with 100% success rate (no data)', () => {
      const metrics = new ProviderMetrics();
      expect(metrics.getSuccessRate()).toBe(1);
    });

    it('should track success rate correctly', () => {
      const metrics = new ProviderMetrics({ successWindow: 10 });

      // Record 8 successes and 2 failures
      for (let i = 0; i < 8; i++) metrics.recordSuccess(100);
      metrics.recordFailure();
      metrics.recordFailure();

      expect(metrics.getSuccessRate()).toBe(0.8);
    });

    it('should use sliding window', () => {
      const metrics = new ProviderMetrics({ successWindow: 5 });

      // Record 5 failures (fills window)
      for (let i = 0; i < 5; i++) metrics.recordFailure();
      expect(metrics.getSuccessRate()).toBe(0);

      // Record 5 successes (replaces all failures)
      for (let i = 0; i < 5; i++) metrics.recordSuccess(100);
      expect(metrics.getSuccessRate()).toBe(1);
    });
  });

  describe('health score', () => {
    it('should calculate health score correctly', () => {
      const metrics = new ProviderMetrics({ initialLatency: 100 });

      // Health = (1000 / 100) * 1.0 = 10
      expect(metrics.getHealthScore()).toBe(10);
    });

    it('should decrease health score with failures', () => {
      const metrics = new ProviderMetrics({ initialLatency: 100, successWindow: 10 });

      const initialScore = metrics.getHealthScore();

      // Record some failures
      metrics.recordFailure();
      metrics.recordFailure();

      expect(metrics.getHealthScore()).toBeLessThan(initialScore);
    });

    it('should increase health score with low latency', () => {
      const highLatency = new ProviderMetrics({ initialLatency: 1000 });
      const lowLatency = new ProviderMetrics({ initialLatency: 100 });

      expect(lowLatency.getHealthScore()).toBeGreaterThan(highLatency.getHealthScore());
    });
  });

  describe('hasReliableData', () => {
    it('should return false with insufficient data', () => {
      const metrics = new ProviderMetrics();

      metrics.recordSuccess(100);
      metrics.recordSuccess(100);

      expect(metrics.hasReliableData()).toBe(false);
    });

    it('should return true with sufficient data', () => {
      const metrics = new ProviderMetrics();

      for (let i = 0; i < 5; i++) metrics.recordSuccess(100);

      expect(metrics.hasReliableData()).toBe(true);
    });
  });
});

describe('MetricsRegistry', () => {
  it('should create metrics on demand', () => {
    const registry = new MetricsRegistry();

    const metrics = registry.getMetrics('openai');
    expect(metrics).toBeDefined();
    expect(metrics.getLatency()).toBe(500);
  });

  it('should return same metrics for same provider', () => {
    const registry = new MetricsRegistry();

    const metrics1 = registry.getMetrics('openai');
    const metrics2 = registry.getMetrics('openai');

    expect(metrics1).toBe(metrics2);
  });

  it('should record success for provider', () => {
    const registry = new MetricsRegistry();

    registry.recordSuccess('openai', 100);

    const metrics = registry.getMetrics('openai');
    expect(metrics.getTotalRequests()).toBe(1);
  });

  it('should sort providers by health', () => {
    const registry = new MetricsRegistry();

    // Make anthropic fast, openai slow
    registry.recordSuccess('anthropic', 100);
    registry.recordSuccess('openai', 1000);

    const sorted = registry.getProvidersByHealth();
    expect(sorted[0]).toBe('anthropic');
    expect(sorted[1]).toBe('openai');
  });
});
