/**
 * JSONL logger for aitok-compatible output
 */

import { promises as fs } from 'fs';
import { dirname } from 'path';
import type { UsageEntry, AitokEntry } from './types.ts';

/**
 * JSONL file writer with buffering
 */
export class JSONLLogger {
  private writeQueue: AitokEntry[] = [];
  private flushTimer?: ReturnType<typeof setInterval>;
  private flushPromise?: Promise<void>;
  private filePath: string;
  private flushInterval: number;

  constructor(
    filePath: string = './logs/usage.jsonl',
    flushInterval: number = 5000
  ) {
    this.filePath = filePath;
    this.flushInterval = flushInterval;

    // Set up periodic flush
    this.startFlushTimer();
  }

  /**
   * Log a usage entry (async, buffered)
   */
  async log(entry: UsageEntry): Promise<void> {
    const aitokEntry = this.toAitokFormat(entry);
    this.writeQueue.push(aitokEntry);

    // Flush if queue is large
    if (this.writeQueue.length >= 100) {
      await this.flush();
    }
  }

  /**
   * Flush queued entries to file
   */
  async flush(): Promise<void> {
    // If already flushing, wait for that to complete
    if (this.flushPromise) {
      await this.flushPromise;
    }

    if (this.writeQueue.length === 0) {
      return;
    }

    const entriesToWrite = this.writeQueue.splice(0);

    this.flushPromise = (async () => {
      try {
        // Ensure directory exists
        await fs.mkdir(dirname(this.filePath), { recursive: true });

        // Convert to JSONL format
        const lines = entriesToWrite.map(e => JSON.stringify(e)).join('\n') + '\n';

        // Append to file
        await fs.appendFile(this.filePath, lines, 'utf-8');
      } catch (error) {
        console.warn('JSONL logging failed:', error);
        // Re-queue entries on failure
        this.writeQueue.unshift(...entriesToWrite);
      } finally {
        this.flushPromise = undefined;
      }
    })();

    return this.flushPromise;
  }

  /**
   * Convert internal UsageEntry to aitok-compatible format
   */
  private toAitokFormat(entry: UsageEntry): AitokEntry {
    return {
      platform: 'unified-llm',
      provider: entry.provider,
      model: entry.model,
      session: entry.session_id,
      timestamp: new Date(entry.timestamp).toISOString(),
      input: entry.input_tokens,
      output: entry.output_tokens,
      cache_read: entry.cache_read_tokens,
      cache_write: entry.cache_write_tokens,
      cost: entry.cost_usd,
    };
  }

  /**
   * Start periodic flush timer
   */
  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {});
    }, this.flushInterval);
  }

  /**
   * Stop timer and flush remaining entries
   */
  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
  }
}
