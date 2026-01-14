/**
 * Core types for unified-llm
 */

// Message format (OpenAI-compatible)
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// Completion parameters shared across all providers
export interface CompletionParams {
  messages: Message[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  stream?: boolean;
}

// Completion response
export interface CompletionResponse {
  content: string;
  model: string;
  provider: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  latencyMs: number;
  cached: boolean;
}

// Provider status
export interface ProviderStatus {
  id: string;
  name: string;
  available: boolean;
  models: string[];
  error?: string;
}

// Context pool configuration for local provider
export interface ContextPoolConfig {
  /** Enable context pooling. Default: true */
  enabled?: boolean;
  /** Max contexts per model. Default: 3 */
  maxPerModel?: number;
  /** Idle timeout before context disposal in ms. Default: 60000 */
  idleTimeoutMs?: number;
}

// Provider configuration types
export interface LocalProviderConfig {
  modelsPath: string;
  models?: string[];
  gpuLayers?: number | 'auto';
  /** Models to preload at startup for faster first request */
  preloadModels?: string[];
  /** Warmup prompt to run after preloading (primes GPU caches) */
  warmupPrompt?: string;
  /** Context pool configuration for VRAM reuse */
  contextPool?: ContextPoolConfig;
}

export interface OllamaProviderConfig {
  baseUrl: string;
  /** Models to pull and warm at startup */
  preloadModels?: string[];
  /** Health check timeout in ms. Default: 2000 */
  healthCheckTimeout?: number;
}

export interface OpenAIProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  organization?: string;
}

export interface AnthropicProviderConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface GeminiProviderConfig {
  apiKey?: string;
}

export interface GatewayProviderConfig {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

// Subscription-based provider configs (no pay-per-token)
export interface ClaudeCodeProviderConfig {
  /** Override path to claude binary */
  cliPath?: string;
  /** Timeout for CLI commands in ms (default: 120000) */
  timeout?: number;
}

export interface GLMProviderConfig {
  /** Z.AI API key (defaults to ZAI_API_KEY env var) */
  apiKey?: string;
  /** Use subprocess mode via Claude CLI (default: true) */
  preferSubprocess?: boolean;
  /** Base URL for direct API mode */
  baseUrl?: string;
  /** Timeout for requests in ms */
  timeout?: number;
  /** Path to Claude CLI binary */
  cliPath?: string;
}

// All provider configs
export interface ProvidersConfig {
  // Local providers
  local?: LocalProviderConfig;
  ollama?: OllamaProviderConfig;

  // Pay-per-token API providers
  openai?: OpenAIProviderConfig;
  anthropic?: AnthropicProviderConfig;
  gemini?: GeminiProviderConfig;
  gateway?: GatewayProviderConfig;

  // Subscription-based providers (no per-token billing)
  'claude-code'?: ClaudeCodeProviderConfig;
  glm?: GLMProviderConfig;
}

// Cache configuration
export interface CacheConfig {
  enabled: boolean;
  adapter: 'memory' | 'sqlite';
  ttlMs?: number;
  maxSize?: number;
  dbPath?: string;
}

// Routing strategy
export type RoutingStrategy =
  | 'fastest'            // All providers, speed-ordered
  | 'cheapest'           // Free/cheap providers first
  | 'quality'            // Best quality models first
  | 'local-only'         // Only local + Ollama
  | 'subscription-only'  // Local + GLM + Claude-subprocess (no pay-per-token APIs)
  | 'subscription-first' // Subscription providers first, then pay-per-token as fallback

// Import usage types
import type { UsageConfig, UsageReport } from './usage/types.ts';

// Re-export for convenience
export type { UsageConfig, UsageReport };

// Racing configuration for parallel provider execution
export interface RacingConfig {
  /** Enable parallel racing. Default: true */
  enabled?: boolean;
  /** Number of providers to race simultaneously. Default: 2 */
  raceCount?: number;
  /** Delay in ms before starting subsequent providers. Default: 500 */
  staggerMs?: number;
}

// Circuit breaker configuration
export interface CircuitBreakerConfig {
  /** Enable circuit breakers. Default: true */
  enabled?: boolean;
  /** Consecutive failures before opening circuit. Default: 3 */
  failureThreshold?: number;
  /** Time in ms before attempting recovery. Default: 30000 */
  recoveryTimeout?: number;
}

// Metrics configuration
export interface MetricsConfig {
  /** EWMA smoothing factor (0-1). Higher = more weight to recent data. Default: 0.3 */
  alpha?: number;
  /** Initial latency estimate in ms. Default: 500 */
  initialLatency?: number;
}

// Main gateway configuration
export interface GatewayConfig {
  providers: ProvidersConfig;
  strategy?: RoutingStrategy;
  cache?: CacheConfig;
  usage?: UsageConfig;
  defaultModel?: string;
  /** Global timeout for entire request in ms. Default: 30000 */
  globalTimeout?: number;
  /** @deprecated Use racing.enabled instead */
  timeout?: number;
  /** @deprecated Use circuit breaker instead */
  retryAttempts?: number;
  /** @deprecated Use racing.staggerMs instead */
  retryDelayMs?: number;
  /** Parallel racing configuration */
  racing?: RacingConfig;
  /** Circuit breaker configuration */
  circuitBreaker?: CircuitBreakerConfig;
  /** Metrics configuration */
  metrics?: MetricsConfig;
}

// Speed tier for routing
export interface SpeedTier {
  provider: string;
  models: string[];
  avgLatencyMs?: number;
  /** Optional task specialization (e.g., 'translation', 'generation') */
  task?: string;
}

// Model info in registry
export interface ModelInfo {
  id: string;
  provider: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  tier: 'instant' | 'fast' | 'moderate' | 'quality';
  capabilities: {
    streaming: boolean;
    vision: boolean;
    functionCalling: boolean;
  };
}

// Latency tracking data
export interface LatencyRecord {
  provider: string;
  model: string;
  latencyMs: number;
  timestamp: number;
}

// Cache entry
export interface CacheEntry {
  key: string;
  response: string;
  model: string;
  provider: string;
  createdAt: number;
  expiresAt: number;
}

// Translation task params
export interface TranslateParams {
  text: string;
  to: 'en' | 'ja' | 'zh' | 'ko' | 'es' | 'fr' | 'de';
  from?: string;
  model?: string;
}

// Generate task params
export interface GenerateParams {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

// Explain task params
export interface ExplainParams {
  pattern: string;
  sentence: string;
  language?: string;
  model?: string;
}

// Warmup report from gateway.warmup()
export interface WarmupReport {
  /** Whether all warmup operations succeeded */
  success: boolean;
  /** Per-provider warmup results */
  providers: Record<string, { loaded: string[]; errors: string[] }>;
  /** Total number of models loaded */
  totalModelsLoaded: number;
  /** Total number of errors encountered */
  totalErrors: number;
  /** Total duration of warmup in ms */
  durationMs: number;
}

// Error types
export class LLMError extends Error {
  public readonly provider: string;
  public readonly code: string;
  public override readonly cause?: Error;

  constructor(message: string, provider: string, code: string, cause?: Error) {
    super(message);
    this.name = 'LLMError';
    this.provider = provider;
    this.code = code;
    this.cause = cause;
  }
}

export class ProviderNotAvailableError extends LLMError {
  constructor(provider: string, cause?: Error) {
    super(`Provider ${provider} is not available`, provider, 'PROVIDER_NOT_AVAILABLE', cause);
    this.name = 'ProviderNotAvailableError';
  }
}

export class NoProvidersAvailableError extends LLMError {
  constructor() {
    super('No providers available', 'none', 'NO_PROVIDERS_AVAILABLE');
    this.name = 'NoProvidersAvailableError';
  }
}

export class RateLimitError extends LLMError {
  constructor(provider: string, retryAfterMs?: number) {
    super(
      `Rate limited by ${provider}${retryAfterMs ? `, retry after ${retryAfterMs}ms` : ''}`,
      provider,
      'RATE_LIMITED'
    );
    this.name = 'RateLimitError';
  }
}
