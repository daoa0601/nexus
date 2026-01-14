/**
 * Cache adapter interface
 */

import type { CacheEntry } from '../types.ts';

export interface CacheAdapter {
  /**
   * Get a cached response by key
   */
  get(key: string): Promise<CacheEntry | null>;

  /**
   * Set a cached response
   */
  set(key: string, response: string, model: string, provider: string): Promise<void>;

  /**
   * Delete a cached entry
   */
  delete(key: string): Promise<boolean>;

  /**
   * Clear all cached entries
   */
  clear(): Promise<void>;

  /**
   * Get cache statistics
   */
  stats(): Promise<{
    entries: number;
    size: number;
    hitRate?: number;
  }>;
}
