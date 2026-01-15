/**
 * SQLite storage for usage analytics
 */

import type { UsageEntry, UsageReport } from './types.ts';

// Dynamic import for better-sqlite3 (optional dependency)
let databaseModule: any = null;

async function getDatabaseClass(): Promise<any> {
  if (!databaseModule) {
    try {
      databaseModule = await import('better-sqlite3');
    } catch {
      throw new Error('better-sqlite3 is not installed. Install it with: bun add better-sqlite3');
    }
  }
  // better-sqlite3 exports Database class directly (CommonJS)
  return databaseModule.default || databaseModule;
}

/**
 * SQLite usage tracker with analytics queries
 */
export class UsageTracker {
  private db: any = null;
  private dbPath: string;
  private insertStmt: any = null;

  constructor(dbPath: string = './usage.db') {
    this.dbPath = dbPath;
  }

  /**
   * Initialize database and create schema
   */
  async init(): Promise<void> {
    try {
      const Database = await getDatabaseClass();
      this.db = new Database(this.dbPath);

      // Create schema
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS usage_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id TEXT UNIQUE NOT NULL,
          timestamp INTEGER NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          session_id TEXT,

          -- Token counts
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          cache_read_tokens INTEGER DEFAULT 0,
          cache_write_tokens INTEGER DEFAULT 0,

          -- Performance
          latency_ms INTEGER NOT NULL,
          cached BOOLEAN NOT NULL,

          -- Cost
          cost_usd REAL,

          -- Metadata
          strategy TEXT,
          provider_order TEXT,

          -- Error tracking
          success BOOLEAN NOT NULL DEFAULT 1,
          error TEXT,

          -- Timestamps
          created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
        );

        -- Indexes for common queries
        CREATE INDEX IF NOT EXISTS idx_timestamp ON usage_logs(timestamp);
        CREATE INDEX IF NOT EXISTS idx_provider ON usage_logs(provider);
        CREATE INDEX IF NOT EXISTS idx_model ON usage_logs(model);
        CREATE INDEX IF NOT EXISTS idx_session ON usage_logs(session_id);
        CREATE INDEX IF NOT EXISTS idx_cost ON usage_logs(cost_usd);
      `);

      // Prepare insert statement
      this.insertStmt = this.db.prepare(`
        INSERT OR REPLACE INTO usage_logs (
          request_id, timestamp, provider, model, session_id,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          latency_ms, cached, cost_usd, strategy, provider_order, success, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    } catch (error) {
      console.warn('Failed to initialize usage tracker:', error);
      this.db = null;
    }
  }

  /**
   * Store a usage entry
   */
  async store(entry: UsageEntry): Promise<void> {
    if (!this.db) {
      await this.init();
      if (!this.db) return;
    }

    try {
      this.insertStmt!.run(
        entry.request_id,
        entry.timestamp,
        entry.provider,
        entry.model,
        entry.session_id ?? null,
        entry.input_tokens,
        entry.output_tokens,
        entry.cache_read_tokens ?? 0,
        entry.cache_write_tokens ?? 0,
        entry.latency_ms,
        entry.cached ? 1 : 0,
        entry.cost_usd ?? null,
        entry.strategy ?? null,
        entry.provider_order ? JSON.stringify(entry.provider_order) : null,
        entry.success ? 1 : 0,
        entry.error ?? null
      );
    } catch (error) {
      console.warn('Failed to store usage entry:', error);
    }
  }

  /**
   * Get total cost for a time range
   */
  async getTotalCost(startDate?: Date, endDate?: Date): Promise<number> {
    if (!this.db) return 0;

    const startTime = startDate?.getTime() ?? 0;
    const endTime = endDate?.getTime() ?? Date.now();

    const stmt = this.db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total
      FROM usage_logs
      WHERE timestamp BETWEEN ? AND ?
      AND success = 1
    `);

    const result = stmt.get(startTime, endTime) as { total: number };
    return result.total;
  }

  /**
   * Get usage grouped by provider
   */
  async getUsageByProvider(
    startDate?: Date,
    endDate?: Date
  ): Promise<Record<string, { tokens: number; cost: number; requests: number }>> {
    if (!this.db) return {};

    const startTime = startDate?.getTime() ?? 0;
    const endTime = endDate?.getTime() ?? Date.now();

    const stmt = this.db.prepare(`
      SELECT
        provider,
        SUM(input_tokens + output_tokens) as tokens,
        COALESCE(SUM(cost_usd), 0) as cost,
        COUNT(*) as requests
      FROM usage_logs
      WHERE timestamp BETWEEN ? AND ?
      AND success = 1
      GROUP BY provider
    `);

    const rows = stmt.all(startTime, endTime) as Array<{
      provider: string;
      tokens: number;
      cost: number;
      requests: number;
    }>;

    const result: Record<string, { tokens: number; cost: number; requests: number }> = {};
    for (const row of rows) {
      result[row.provider] = {
        tokens: row.tokens,
        cost: row.cost,
        requests: row.requests,
      };
    }

    return result;
  }

  /**
   * Get usage grouped by model
   */
  async getUsageByModel(
    provider?: string,
    startDate?: Date,
    endDate?: Date
  ): Promise<Record<string, { tokens: number; cost: number; requests: number }>> {
    if (!this.db) return {};

    const startTime = startDate?.getTime() ?? 0;
    const endTime = endDate?.getTime() ?? Date.now();

    let sql = `
      SELECT
        model,
        SUM(input_tokens + output_tokens) as tokens,
        COALESCE(SUM(cost_usd), 0) as cost,
        COUNT(*) as requests
      FROM usage_logs
      WHERE timestamp BETWEEN ? AND ?
      AND success = 1
    `;

    const params: (number | string)[] = [startTime, endTime];

    if (provider) {
      sql += ' AND provider = ?';
      params.push(provider);
    }

    sql += ' GROUP BY model';

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      model: string;
      tokens: number;
      cost: number;
      requests: number;
    }>;

    const result: Record<string, { tokens: number; cost: number; requests: number }> = {};
    for (const row of rows) {
      result[row.model] = {
        tokens: row.tokens,
        cost: row.cost,
        requests: row.requests,
      };
    }

    return result;
  }

  /**
   * Generate comprehensive usage report
   * Optimized: Parallelizes independent database queries
   */
  async getReport(options?: {
    startDate?: Date;
    endDate?: Date;
    groupBy?: 'provider' | 'model' | 'day';
  }): Promise<UsageReport> {
    // Run independent queries in parallel instead of sequentially
    const [byProvider, byModel] = await Promise.all([
      this.getUsageByProvider(options?.startDate, options?.endDate),
      this.getUsageByModel(undefined, options?.startDate, options?.endDate),
    ]);

    const totalCost = Object.values(byProvider).reduce((sum, p) => sum + p.cost, 0);
    const totalTokens = Object.values(byProvider).reduce((sum, p) => sum + p.tokens, 0);
    const totalRequests = Object.values(byProvider).reduce((sum, p) => sum + p.requests, 0);

    return {
      totalCost,
      totalTokens,
      totalRequests,
      byProvider,
      byModel,
    };
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
