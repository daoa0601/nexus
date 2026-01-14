/**
 * SQLite persistent cache implementation
 */

import type { CacheEntry } from '../types.ts';
import type { CacheAdapter } from './adapter.ts';

// Dynamic import for better-sqlite3 (optional dependency)
type DatabaseType = import('better-sqlite3').Database;
type DatabaseConstructor = new (filename: string) => DatabaseType;

let Database: DatabaseConstructor | null = null;

async function getDatabase(): Promise<DatabaseConstructor> {
  if (!Database) {
    try {
      const mod = await import('better-sqlite3');
      Database = mod.default as unknown as DatabaseConstructor;
    } catch {
      throw new Error('better-sqlite3 is not installed. Install it with: bun add better-sqlite3');
    }
  }
  return Database;
}

interface SQLiteCacheConfig {
  dbPath: string;
  ttlMs: number;
}

export class SQLiteCache implements CacheAdapter {
  private db: DatabaseType | null = null;
  private ttlMs: number;
  private dbPath: string;
  private hits = 0;
  private misses = 0;
  private initPromise: Promise<void> | null = null;

  constructor(config: SQLiteCacheConfig) {
    this.dbPath = config.dbPath;
    this.ttlMs = config.ttlMs;
    this.initPromise = this.init();
  }

  private async init(): Promise<void> {
    const DB = await getDatabase();
    this.db = new DB(this.dbPath);

    // Create table if not exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS llm_cache (
        key TEXT PRIMARY KEY,
        response TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);

    // Create index on expires_at for cleanup
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_expires_at ON llm_cache(expires_at)
    `);

    // Clean up expired entries on init
    this.cleanup();
  }

  private cleanup(): void {
    if (!this.db) return;
    const stmt = this.db.prepare('DELETE FROM llm_cache WHERE expires_at < ?');
    stmt.run(Date.now());
  }

  private async ensureInit(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
  }

  async get(key: string): Promise<CacheEntry | null> {
    await this.ensureInit();
    if (!this.db) return null;

    const stmt = this.db.prepare(`
      SELECT key, response, model, provider, created_at, expires_at
      FROM llm_cache
      WHERE key = ? AND expires_at > ?
    `);

    const row = stmt.get(key, Date.now()) as
      | {
          key: string;
          response: string;
          model: string;
          provider: string;
          created_at: number;
          expires_at: number;
        }
      | undefined;

    if (!row) {
      this.misses++;
      return null;
    }

    this.hits++;
    return {
      key: row.key,
      response: row.response,
      model: row.model,
      provider: row.provider,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  async set(key: string, response: string, model: string, provider: string): Promise<void> {
    await this.ensureInit();
    if (!this.db) return;

    const now = Date.now();
    const expiresAt = now + this.ttlMs;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO llm_cache (key, response, model, provider, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(key, response, model, provider, now, expiresAt);
  }

  async delete(key: string): Promise<boolean> {
    await this.ensureInit();
    if (!this.db) return false;

    const stmt = this.db.prepare('DELETE FROM llm_cache WHERE key = ?');
    const result = stmt.run(key);
    return result.changes > 0;
  }

  async clear(): Promise<void> {
    await this.ensureInit();
    if (!this.db) return;

    this.db.exec('DELETE FROM llm_cache');
    this.hits = 0;
    this.misses = 0;
  }

  async stats(): Promise<{ entries: number; size: number; hitRate?: number }> {
    await this.ensureInit();
    if (!this.db) return { entries: 0, size: 0 };

    const countStmt = this.db.prepare('SELECT COUNT(*) as count FROM llm_cache');
    const countRow = countStmt.get() as { count: number };

    const sizeStmt = this.db.prepare(
      'SELECT SUM(LENGTH(response)) as size FROM llm_cache'
    );
    const sizeRow = sizeStmt.get() as { size: number | null };

    const total = this.hits + this.misses;
    const hitRate = total > 0 ? this.hits / total : undefined;

    return {
      entries: countRow.count,
      size: sizeRow.size ?? 0,
      hitRate,
    };
  }

  /**
   * Remove expired entries
   */
  async prune(): Promise<number> {
    await this.ensureInit();
    if (!this.db) return 0;

    const stmt = this.db.prepare('DELETE FROM llm_cache WHERE expires_at < ?');
    const result = stmt.run(Date.now());
    return result.changes;
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
