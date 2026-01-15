/**
 * In-memory LRU cache implementation
 */

import type { CacheEntry } from '../types.ts';
import type { CacheAdapter } from './adapter.ts';

interface MemoryCacheConfig {
  maxSize: number;
  ttlMs: number;
}

export class MemoryCache implements CacheAdapter {
  private cache: Map<string, CacheEntry> = new Map();
  private maxSize: number;
  private ttlMs: number;
  private hits = 0;
  private misses = 0;

  // Incremental size tracking to avoid O(n) iteration in stats()
  private totalSize = 0;

  constructor(config: MemoryCacheConfig) {
    this.maxSize = config.maxSize;
    this.ttlMs = config.ttlMs;
  }

  async get(key: string): Promise<CacheEntry | null> {
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.totalSize -= entry.response.length * 2; // UTF-16
      this.misses++;
      return null;
    }

    // Move to end (LRU)
    this.cache.delete(key);
    this.cache.set(key, entry);

    this.hits++;
    return entry;
  }

  async set(key: string, response: string, model: string, provider: string): Promise<void> {
    // If key already exists, subtract old size first
    const existing = this.cache.get(key);
    if (existing) {
      this.totalSize -= existing.response.length * 2;
    }

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize && !existing) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        const oldEntry = this.cache.get(oldestKey);
        if (oldEntry) {
          this.totalSize -= oldEntry.response.length * 2;
        }
        this.cache.delete(oldestKey);
      }
    }

    const now = Date.now();
    const entry: CacheEntry = {
      key,
      response,
      model,
      provider,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };

    this.cache.set(key, entry);
    this.totalSize += response.length * 2; // UTF-16
  }

  async delete(key: string): Promise<boolean> {
    const entry = this.cache.get(key);
    if (entry) {
      this.totalSize -= entry.response.length * 2;
    }
    return this.cache.delete(key);
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.totalSize = 0;
  }

  async stats(): Promise<{ entries: number; size: number; hitRate?: number }> {
    // Use incrementally tracked size (O(1) instead of O(n))
    const total = this.hits + this.misses;
    const hitRate = total > 0 ? this.hits / total : undefined;

    return {
      entries: this.cache.size,
      size: this.totalSize,
      hitRate,
    };
  }

  /**
   * Remove expired entries (call periodically)
   */
  prune(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.totalSize -= entry.response.length * 2;
        this.cache.delete(key);
        pruned++;
      }
    }

    return pruned;
  }
}
