/**
 * Usage logger orchestrator - coordinates all usage tracking
 */

import type {
  CompletionResponse,
  CompletionParams,
  Message,
} from '../types.ts';
import type {
  UsageEntry,
  UsageConfig,
  UsageReport,
  LogMetadata,
} from './types.ts';
import { TokenCounter } from './token-counter.ts';
import { CostCalculator } from './cost-calculator.ts';
import { JSONLLogger } from './jsonl-logger.ts';
import { UsageTracker } from './usage-tracker.ts';

// Lazy-load uuid to handle optional dependency
let uuidv4: (() => string) | null = null;

async function getUuid(): Promise<() => string> {
  if (uuidv4) return uuidv4;

  try {
    const uuid = await import('uuid');
    uuidv4 = uuid.v4;
    return uuidv4;
  } catch {
    // Fallback: simple random ID generator
    uuidv4 = () => `id-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    return uuidv4;
  }
}

/**
 * Main usage logger class
 */
export class UsageLogger {
  private tokenCounter: TokenCounter;
  private costCalculator: CostCalculator;
  private jsonlLogger: JSONLLogger;
  private usageTracker: UsageTracker | null = null;
  private config: UsageConfig;
  private sessionId: string;

  constructor(config: UsageConfig) {
    this.config = config;
    this.sessionId = `session-${Date.now()}`;

    // Initialize components
    this.tokenCounter = new TokenCounter(config.tokenCounting);
    this.costCalculator = new CostCalculator(config.costTracking?.customPricing);
    this.jsonlLogger = new JSONLLogger(
      config.jsonlPath ?? './logs/usage.jsonl',
      config.flushInterval ?? 5000
    );

    // Initialize SQLite tracker if enabled
    if (config.database?.enabled) {
      this.usageTracker = new UsageTracker(config.database.path ?? './usage.db');
    }

    // Initialize UUID async
    getUuid().then(uuid => {
      this.sessionId = uuid();
    }).catch(() => {
      // Keep the fallback sessionId
    });
  }

  /**
   * Log a completion request/response
   */
  async log(
    response: CompletionResponse | Partial<CompletionResponse>,
    params: CompletionParams,
    metadata: LogMetadata
  ): Promise<void> {
    try {
      // Generate request ID
      const uuid = await getUuid();
      const requestId = uuid();
      const timestamp = Date.now();

      // Extract or estimate token counts (parallelized when both need estimation)
      const provider = response.provider ?? 'unknown';
      const model = response.model ?? 'unknown';

      const [inputTokens, outputTokens] = await Promise.all([
        response.usage?.promptTokens !== undefined
          ? Promise.resolve(response.usage.promptTokens)
          : this.countInputTokens(params, provider, model),
        response.usage?.completionTokens !== undefined
          ? Promise.resolve(response.usage.completionTokens)
          : this.countOutputTokens(response.content ?? '', provider, model),
      ]);

      // Calculate cache tokens
      const cacheReadTokens = this.extractCacheTokens(response.usage, 'prompt' as const);
      const cacheWriteTokens = this.extractCacheTokens(response.usage, 'completion' as const);

      // Calculate cost
      const costUsd = this.config.costTracking?.enabled
        ? this.costCalculator.calculate(
            inputTokens,
            outputTokens,
            response.model ?? 'unknown',
            response.provider ?? 'unknown'
          )
        : undefined;

      // Build usage entry
      const entry: UsageEntry = {
        request_id: requestId,
        timestamp,
        provider: response.provider ?? metadata.error?.name ?? 'unknown',
        model: response.model ?? 'unknown',
        session_id: metadata.sessionId ?? this.sessionId,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_write_tokens: cacheWriteTokens,
        latency_ms: response.latencyMs ?? 0,
        cached: response.cached ?? false,
        cost_usd: costUsd,
        strategy: metadata.strategy,
        provider_order: metadata.providerOrder,
        error: metadata.error?.message,
        success: !metadata.error,
      };

      // Log to JSONL (async, non-blocking)
      if (this.config.asyncLogging !== false) {
        this.jsonlLogger.log(entry).catch((err) => {
          console.warn('JSONL logging failed:', err);
        });
      } else {
        await this.jsonlLogger.log(entry);
      }

      // Store to SQLite (async, non-blocking)
      if (this.usageTracker) {
        if (this.config.asyncLogging !== false) {
          this.usageTracker.store(entry).catch((err) => {
            console.warn('SQLite logging failed:', err);
          });
        } else {
          await this.usageTracker.store(entry);
        }
      }
    } catch (error) {
      // Never throw - logging failures should not break completions
      console.warn('Usage logging failed:', error);
    }
  }

  /**
   * Count input tokens with fallback
   */
  private async countInputTokens(
    params: CompletionParams,
    provider: string,
    model: string
  ): Promise<number> {
    if (params.messages && params.messages.length > 0) {
      return await this.tokenCounter.countMessages(params.messages, provider, model);
    }

    // Fallback: count prompt if available
    const prompt = params.messages?.[0]?.content ?? '';
    return await this.tokenCounter.count(prompt, provider, model);
  }

  /**
   * Count output tokens with fallback
   */
  private async countOutputTokens(
    content: string,
    provider: string,
    model: string
  ): Promise<number> {
    return await this.tokenCounter.count(content, provider, model);
  }

  /**
   * Extract cache tokens from usage object
   */
  private extractCacheTokens(
    usage?: CompletionResponse['usage'],
    type?: 'prompt' | 'completion'
  ): number | undefined {
    if (!usage || !type) return undefined;

    // Check for Anthropic-style cache tokens
    if ('cache_read_input_tokens' in usage && type === 'prompt') {
      return (usage as any).cache_read_input_tokens;
    }
    if ('cache_read_input_tokens' in usage && type === 'completion') {
      return (usage as any).cache_read_output_tokens;
    }

    return undefined;
  }

  /**
   * Generate analytics report
   */
  async getReport(options?: {
    startDate?: Date;
    endDate?: Date;
    groupBy?: 'provider' | 'model' | 'day';
  }): Promise<UsageReport | null> {
    if (!this.usageTracker) {
      return null;
    }

    return await this.usageTracker.getReport(options);
  }

  /**
   * Close logger and flush pending writes
   */
  async close(): Promise<void> {
    await this.jsonlLogger.close();
    this.usageTracker?.close();
  }

  /**
   * Get current session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Set a new session ID
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }
}
