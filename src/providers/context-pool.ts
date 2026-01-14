/**
 * Context Pool - LRU pool for reusing llama.cpp contexts
 *
 * Why: Creating a new context requires VRAM allocation (~50-200ms overhead).
 * By pooling contexts, subsequent requests reuse existing allocations.
 *
 * Design:
 * - One pool per model (keyed by filename)
 * - LRU eviction when pool exceeds max size
 * - Idle timeout cleanup to free unused memory
 * - Thread-safe acquire/release pattern
 */

export interface ContextPoolConfig {
  /** Max contexts per model (default: 3) */
  maxPerModel?: number;
  /** Idle timeout before context disposal in ms (default: 60000 = 1 min) */
  idleTimeoutMs?: number;
  /** Whether pooling is enabled (default: true) */
  enabled?: boolean;
}

interface PooledContext<T> {
  context: T;
  modelName: string;
  lastUsed: number;
  inUse: boolean;
  timeoutId?: ReturnType<typeof setTimeout>;
}

export class ContextPool<T extends { dispose: () => Promise<void> | void }> {
  private pools: Map<string, PooledContext<T>[]> = new Map();
  private config: Required<ContextPoolConfig>;

  constructor(config: ContextPoolConfig = {}) {
    this.config = {
      maxPerModel: config.maxPerModel ?? 3,
      idleTimeoutMs: config.idleTimeoutMs ?? 60000,
      enabled: config.enabled ?? true,
    };
  }

  /**
   * Acquire a context from the pool.
   * If no context available, calls createFn to create a new one.
   *
   * @param modelName - Model identifier for pool lookup
   * @param createFn - Factory function to create new context if needed
   */
  async acquire(modelName: string, createFn: () => Promise<T>): Promise<T> {
    if (!this.config.enabled) {
      // Pooling disabled, always create new
      return createFn();
    }

    const pool = this.pools.get(modelName) ?? [];

    // Try to find an available context
    const available = pool.find((p) => !p.inUse);
    if (available) {
      // Clear any pending idle timeout
      if (available.timeoutId) {
        clearTimeout(available.timeoutId);
        available.timeoutId = undefined;
      }

      available.inUse = true;
      available.lastUsed = Date.now();
      return available.context;
    }

    // No available context, create new one
    const context = await createFn();
    const pooled: PooledContext<T> = {
      context,
      modelName,
      lastUsed: Date.now(),
      inUse: true,
    };

    // Add to pool
    pool.push(pooled);
    this.pools.set(modelName, pool);

    // Check if we need to evict (only evict idle contexts)
    await this.evictIfNeeded(modelName);

    return context;
  }

  /**
   * Release a context back to the pool for reuse.
   *
   * @param modelName - Model identifier for pool lookup
   * @param context - The context to release
   */
  release(modelName: string, context: T): void {
    if (!this.config.enabled) {
      // Pooling disabled, dispose immediately
      context.dispose();
      return;
    }

    const pool = this.pools.get(modelName);
    if (!pool) return;

    const pooled = pool.find((p) => p.context === context);
    if (!pooled) {
      // Context not in pool, dispose it
      context.dispose();
      return;
    }

    // Mark as available
    pooled.inUse = false;
    pooled.lastUsed = Date.now();

    // Set idle timeout for cleanup
    pooled.timeoutId = setTimeout(() => {
      this.disposeContext(modelName, pooled);
    }, this.config.idleTimeoutMs);
  }

  /**
   * Evict oldest idle context if pool exceeds max size
   */
  private async evictIfNeeded(modelName: string): Promise<void> {
    const pool = this.pools.get(modelName);
    if (!pool) return;

    // Only evict if we exceed max AND have idle contexts
    const idleContexts = pool.filter((p) => !p.inUse);
    const totalContexts = pool.length;

    if (totalContexts > this.config.maxPerModel && idleContexts.length > 0) {
      // Sort idle by lastUsed (oldest first)
      idleContexts.sort((a, b) => a.lastUsed - b.lastUsed);

      // Evict oldest idle context
      const oldest = idleContexts[0];
      if (oldest) {
        await this.disposeContext(modelName, oldest);
      }
    }
  }

  /**
   * Dispose a specific context and remove from pool
   */
  private async disposeContext(modelName: string, pooled: PooledContext<T>): Promise<void> {
    // Clear timeout if any
    if (pooled.timeoutId) {
      clearTimeout(pooled.timeoutId);
    }

    // Dispose the context
    try {
      await pooled.context.dispose();
    } catch {
      // Ignore disposal errors
    }

    // Remove from pool
    const pool = this.pools.get(modelName);
    if (pool) {
      const index = pool.indexOf(pooled);
      if (index !== -1) {
        pool.splice(index, 1);
      }
      if (pool.length === 0) {
        this.pools.delete(modelName);
      }
    }
  }

  /**
   * Get pool statistics for monitoring
   */
  getStats(): {
    totalContexts: number;
    inUse: number;
    idle: number;
    byModel: Record<string, { total: number; inUse: number }>;
  } {
    let totalContexts = 0;
    let inUse = 0;
    const byModel: Record<string, { total: number; inUse: number }> = {};

    for (const [modelName, pool] of this.pools) {
      const modelInUse = pool.filter((p) => p.inUse).length;
      byModel[modelName] = { total: pool.length, inUse: modelInUse };
      totalContexts += pool.length;
      inUse += modelInUse;
    }

    return {
      totalContexts,
      inUse,
      idle: totalContexts - inUse,
      byModel,
    };
  }

  /**
   * Dispose all contexts and clear pools
   */
  async dispose(): Promise<void> {
    for (const [modelName, pool] of this.pools) {
      for (const pooled of pool) {
        if (pooled.timeoutId) {
          clearTimeout(pooled.timeoutId);
        }
        try {
          await pooled.context.dispose();
        } catch {
          // Ignore disposal errors
        }
      }
    }
    this.pools.clear();
  }

  /**
   * Check if pooling is enabled
   */
  get enabled(): boolean {
    return this.config.enabled;
  }
}
