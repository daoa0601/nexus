/**
 * Usage tracking types for unified-llm
 */

import type { CompletionResponse, CompletionParams } from '../types.ts';

/**
 * Usage record for a single completion request
 */
export interface UsageEntry {
  // Unique identifiers
  request_id: string;
  timestamp: number;

  // Request details
  provider: string;
  model: string;
  session_id?: string;

  // Token counts (aitok-compatible)
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;

  // Performance
  latency_ms: number;
  cached: boolean;

  // Cost tracking
  cost_usd?: number;

  // Routing metadata
  strategy?: string;
  provider_order?: string[];

  // Error tracking
  error?: string;
  success: boolean;
}

/**
 * aitok-compatible format for JSONL logs
 */
export interface AitokEntry {
  platform: string;
  provider: string;
  model: string;
  session?: string;
  timestamp: string;
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
  cost?: number;
}

/**
 * Usage logging configuration
 */
export interface UsageConfig {
  /** Enable/disable usage logging */
  enabled: boolean;

  /** JSONL log file path (aitok-compatible) */
  jsonlPath?: string;

  /** SQLite database for analytics */
  database?: {
    enabled: boolean;
    path?: string;
  };

  /** Token counting fallback for providers without usage */
  tokenCounting?: {
    /** Use tokenizer libraries for estimation */
    enabled: boolean;
    /** Tokenizer to use: 'tiktoken' | 'llama' */
    defaultTokenizer?: 'tiktoken' | 'llama';
  };

  /** Cost calculation */
  costTracking?: {
    enabled: boolean;
    /** Custom pricing per model */
    customPricing?: Record<string, {
      inputCostPer1k: number;
      outputCostPer1k: number;
    }>;
  };

  /** Performance */
  asyncLogging?: boolean;
  flushInterval?: number;
}

/**
 * Usage analytics report
 */
export interface UsageReport {
  totalCost: number;
  totalTokens: number;
  totalRequests: number;
  byProvider: Record<string, {
    tokens: number;
    cost: number;
    requests: number;
  }>;
  byModel: Record<string, {
    tokens: number;
    cost: number;
    requests: number;
  }>;
}

/**
 * Pricing per 1M tokens
 */
export interface Pricing {
  input: number;
  output: number;
}

/**
 * Log metadata passed from gateway
 */
export interface LogMetadata {
  sessionId?: string;
  strategy?: string;
  providerOrder?: string[];
  error?: Error;
}
