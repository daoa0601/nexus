/**
 * Unit tests for ContextPool
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { ContextPool } from '../src/providers/context-pool.ts';

// Mock context with dispose method
interface MockContext {
  id: number;
  disposed: boolean;
  dispose: () => Promise<void>;
}

function createMockContext(id: number): MockContext {
  return {
    id,
    disposed: false,
    dispose: async function () {
      this.disposed = true;
    },
  };
}

describe('ContextPool', () => {
  let pool: ContextPool<MockContext>;
  let contextIdCounter: number;

  beforeEach(() => {
    pool = new ContextPool<MockContext>({
      maxPerModel: 2,
      idleTimeoutMs: 100, // Short timeout for tests
    });
    contextIdCounter = 0;
  });

  describe('acquire and release', () => {
    it('should create new context when pool is empty', async () => {
      const context = await pool.acquire('model-a', async () => createMockContext(++contextIdCounter));
      expect(context.id).toBe(1);
    });

    it('should reuse context after release', async () => {
      const context1 = await pool.acquire('model-a', async () => createMockContext(++contextIdCounter));
      pool.release('model-a', context1);

      const context2 = await pool.acquire('model-a', async () => createMockContext(++contextIdCounter));
      expect(context2.id).toBe(1); // Same context reused
    });

    it('should create new context when all are in use', async () => {
      const context1 = await pool.acquire('model-a', async () => createMockContext(++contextIdCounter));
      const context2 = await pool.acquire('model-a', async () => createMockContext(++contextIdCounter));

      expect(context1.id).toBe(1);
      expect(context2.id).toBe(2);
    });

    it('should maintain separate pools per model', async () => {
      const contextA = await pool.acquire('model-a', async () => createMockContext(++contextIdCounter));
      const contextB = await pool.acquire('model-b', async () => createMockContext(++contextIdCounter));

      expect(contextA.id).toBe(1);
      expect(contextB.id).toBe(2);

      pool.release('model-a', contextA);

      // Should reuse model-a context, not create new
      const contextA2 = await pool.acquire('model-a', async () => createMockContext(++contextIdCounter));
      expect(contextA2.id).toBe(1);

      // Model-b pool should get new context
      const contextB2 = await pool.acquire('model-b', async () => createMockContext(++contextIdCounter));
      expect(contextB2.id).toBe(3);
    });
  });

  describe('eviction', () => {
    it('should evict oldest idle context when exceeding max size', async () => {
      // Fill pool to max (2)
      const c1 = await pool.acquire('model-a', async () => createMockContext(++contextIdCounter));
      const c2 = await pool.acquire('model-a', async () => createMockContext(++contextIdCounter));

      // Release both
      pool.release('model-a', c1);
      pool.release('model-a', c2);

      // Acquire 3rd - should evict oldest (c1)
      const c3 = await pool.acquire('model-a', async () => createMockContext(++contextIdCounter));

      // Stats should show 2 total (c2 idle, c3 in use)
      const stats = pool.getStats();
      expect(stats.totalContexts).toBe(2);
    });
  });

  describe('idle timeout', () => {
    it('should dispose context after idle timeout', async () => {
      const context = await pool.acquire('model-a', async () => createMockContext(++contextIdCounter));
      pool.release('model-a', context);

      // Wait for idle timeout
      await new Promise((r) => setTimeout(r, 150));

      // Context should be disposed
      expect(context.disposed).toBe(true);

      // Pool should be empty
      const stats = pool.getStats();
      expect(stats.totalContexts).toBe(0);
    });

    it('should cancel timeout on reacquire', async () => {
      const context = await pool.acquire('model-a', async () => createMockContext(++contextIdCounter));
      pool.release('model-a', context);

      // Wait partial timeout
      await new Promise((r) => setTimeout(r, 50));

      // Reacquire
      const context2 = await pool.acquire('model-a', async () => createMockContext(++contextIdCounter));
      expect(context2.id).toBe(1); // Same context

      // Wait past original timeout
      await new Promise((r) => setTimeout(r, 100));

      // Should not be disposed (still in use)
      expect(context.disposed).toBe(false);
    });
  });

  describe('pooling disabled', () => {
    it('should create new context every time when disabled', async () => {
      const disabledPool = new ContextPool<MockContext>({ enabled: false });

      const c1 = await disabledPool.acquire('model-a', async () => createMockContext(++contextIdCounter));
      disabledPool.release('model-a', c1);

      const c2 = await disabledPool.acquire('model-a', async () => createMockContext(++contextIdCounter));

      expect(c1.id).toBe(1);
      expect(c2.id).toBe(2);
      expect(c1.disposed).toBe(true); // Disposed on release
    });
  });

  describe('getStats', () => {
    it('should return accurate statistics', async () => {
      const c1 = await pool.acquire('model-a', async () => createMockContext(++contextIdCounter));
      const c2 = await pool.acquire('model-a', async () => createMockContext(++contextIdCounter));
      const c3 = await pool.acquire('model-b', async () => createMockContext(++contextIdCounter));

      pool.release('model-a', c1);

      const stats = pool.getStats();
      expect(stats.totalContexts).toBe(3);
      expect(stats.inUse).toBe(2);
      expect(stats.idle).toBe(1);
      expect(stats.byModel['model-a']).toEqual({ total: 2, inUse: 1 });
      expect(stats.byModel['model-b']).toEqual({ total: 1, inUse: 1 });
    });
  });

  describe('dispose', () => {
    it('should dispose all contexts', async () => {
      const c1 = await pool.acquire('model-a', async () => createMockContext(++contextIdCounter));
      const c2 = await pool.acquire('model-b', async () => createMockContext(++contextIdCounter));

      pool.release('model-a', c1);

      await pool.dispose();

      expect(c1.disposed).toBe(true);
      expect(c2.disposed).toBe(true);

      const stats = pool.getStats();
      expect(stats.totalContexts).toBe(0);
    });
  });
});
