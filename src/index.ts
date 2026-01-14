/**
 * unified-llm - Unified LLM gateway with speed-first routing
 */

// Main gateway
export { LLMGateway } from './gateway.ts';

// Types
export type {
  Message,
  CompletionParams,
  CompletionResponse,
  ProviderStatus,
  GatewayConfig,
  ProvidersConfig,
  CacheConfig,
  RoutingStrategy,
  TranslateParams,
  GenerateParams,
  ExplainParams,
  ModelInfo,
  WarmupReport,
  ContextPoolConfig,
  // Provider configs
  LocalProviderConfig,
  OllamaProviderConfig,
  OpenAIProviderConfig,
  AnthropicProviderConfig,
  GeminiProviderConfig,
  GatewayProviderConfig,
  // Subscription-based provider configs
  ClaudeCodeProviderConfig,
  GLMProviderConfig,
} from './types.ts';

// Context pool for local models
export { ContextPool } from './providers/context-pool.ts';

// Error types
export { LLMError, ProviderNotAvailableError, NoProvidersAvailableError, RateLimitError } from './types.ts';

// Provider base class (for custom providers)
export { LLMProvider } from './providers/base.ts';

// Individual providers (for direct use)
export { OpenAIProvider } from './providers/openai.ts';
export { OllamaProvider } from './providers/ollama.ts';
export { AnthropicProvider } from './providers/anthropic.ts';
export { GeminiProvider } from './providers/gemini.ts';
export { LocalProvider } from './providers/local.ts';
export { GatewayProvider } from './providers/gateway.ts';

// Subscription-based providers (no pay-per-token billing)
export { ClaudeCodeProvider } from './providers/claude-code.ts';
export { GLMProvider } from './providers/glm.ts';

// Cache adapters
export type { CacheAdapter } from './cache/adapter.ts';
export { MemoryCache } from './cache/memory.ts';

// Router (for custom routing logic)
export { Router } from './router.ts';
