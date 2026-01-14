# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**unified-llm** is a TypeScript package providing a unified LLM gateway with speed-first routing across multiple providers (OpenAI, Anthropic, Gemini, Ollama, local GGUF models), comprehensive usage tracking with aitok integration, and optional caching.

## Development Commands

```bash
bun install              # Install dependencies
bun run lint             # TypeScript type checking
bun run build            # Build for distribution
bun test                 # Run tests
bun run examples/basic-usage.ts      # Run basic example
bun run examples/usage-tracking.ts   # Run usage tracking demo
```

## Architecture

```
src/
├── index.ts             # Public exports
├── gateway.ts           # Main LLMGateway class - entry point
├── router.ts            # Health-aware routing with EWMA + circuit breakers
├── types.ts             # All TypeScript types
├── utils/
│   └── subprocess.ts    # Claude CLI subprocess utilities
├── router/              # NEW: Routing infrastructure
│   ├── metrics.ts       # EWMA latency + success rate tracking
│   └── circuit-breaker.ts # Circuit breaker state machine
├── executor/            # NEW: Request execution
│   └── racing-executor.ts # Parallel racing with staggered starts
├── providers/
│   ├── base.ts          # Abstract LLMProvider class
│   ├── openai.ts        # OpenAI SDK wrapper
│   ├── anthropic.ts     # Anthropic SDK wrapper
│   ├── gemini.ts        # Google Generative AI wrapper
│   ├── ollama.ts        # Ollama HTTP client
│   ├── local.ts         # node-llama-cpp wrapper (GGUF)
│   ├── gateway.ts       # Custom API endpoint support
│   ├── claude-code.ts   # Claude Code subscription (subprocess)
│   └── glm.ts           # GLM Coding Plan (z.ai API)
├── usage/
│   ├── types.ts         # Usage data structures
│   ├── logger.ts        # Main usage tracking orchestrator
│   ├── token-counter.ts # Token estimation (js-tiktoken, llama-tokenizer-js)
│   ├── cost-calculator.ts # Per-model cost calculation
│   ├── jsonl-logger.ts  # aitok-compatible JSONL writer
│   └── usage-tracker.ts # SQLite analytics storage
└── cache/
    ├── adapter.ts       # Cache interface
    ├── memory.ts        # In-memory LRU cache
    └── sqlite.ts        # SQLite persistent cache
```

## Key Design Patterns

### Provider Pattern
All providers extend `LLMProvider` from `providers/base.ts`:
- `isAvailable()` - Check if provider can be used
- `getModels()` - List available models
- `complete()` - Execute completion request
- `status()` - Get provider availability and model list

### Health-Aware Routing
The `Router` class in `router.ts` uses a 7-tier speed system combined with health tracking:

**Speed Tiers (CPU-only benchmarks, GPU would be 2-5x faster):**
1. **Tier 1** (<200ms): Liquid AI LFM2-350M, LFM2-350M-ENJP-MT (JP/EN translation) (HuggingFace: LiquidAI/LFM2-350M-GGUF, LiquidAI/LFM2-350M-ENJP-MT-GGUF)
2. **Tier 2** (<700ms): Local small models (Qwen3-0.6B, LFM2-1.2B, LFM2.5-1.2B-JP), Ollama (hf.co/Qwen/Qwen3-0.6B-GGUF, Qwen3-1.7B-GGUF)
3. **Tier 3**: GLM subscription (glm-4.5-air, glm-4.7)
4. **Tier 4**: Claude Code subscription (haiku, sonnet, opus)
5. **Tier 5** (<1.5s): Medium local (Qwen3-1.7B/4B/8B, LFM2-2.6B), Ollama (Qwen3-1.7B/4B/8B/14B), fast cloud APIs
6. **Tier 6** (<6s): Large local (Qwen3-32B), Ollama (Qwen3-Coder-30B-A3B MoE!), quality cloud (GPT-5, Sonnet)
7. **Tier 7** (6s+): Premium cloud only (Opus, O1) - MoE models are faster!

**Health Tracking Components:**
- `MetricsRegistry` (`router/metrics.ts`): EWMA latency + success rate per provider
- `CircuitBreakerRegistry` (`router/circuit-breaker.ts`): Auto-disable failing providers

**Provider ordering:** Tier-based ordering refined by health score = `(1000/latency) × successRate`

### Parallel Racing Executor
The `RacingExecutor` in `executor/racing-executor.ts` handles parallel provider execution:

```typescript
// Staggered start pattern
Provider 1: |----request----|  (starts immediately)
Provider 2:      |----request----| (starts after 500ms stagger)
                 ↑
                 AbortController cancels losers when winner responds
```

**Key methods:**
- `execute()`: Main entry point, races top N providers
- `createStaggeredPromise()`: Delays provider start by stagger amount
- `raceWithTimeout()`: `Promise.race()` with global timeout
- Falls back to sequential execution if racing disabled or single provider

### Circuit Breaker Pattern
States: `CLOSED` → `OPEN` → `HALF_OPEN` → `CLOSED`

```typescript
// Circuit trips after 3 failures, recovers after 30s
breaker.recordFailure();  // Tracks consecutive failures
breaker.canExecute();     // Returns false when OPEN
breaker.recordSuccess();  // Resets failure count, closes circuit
```

### Gateway Initialization
The gateway now uses explicit async initialization to prevent race conditions:

```typescript
class LLMGateway {
  readonly ready: Promise<void>;  // Resolves when all providers loaded

  constructor(config) {
    this.ready = this.initialize(config);  // Async init
  }

  async complete(params) {
    await this.ready;  // Ensures providers are loaded
    // ...
  }
}
```

### Dynamic Imports
Providers use dynamic imports to avoid loading unused SDKs:
```typescript
// All providers loaded in parallel with Promise.all
await Promise.all([
  import('./providers/openai.ts').then(...),
  import('./providers/anthropic.ts').then(...),
]);
```

## Adding New Providers

1. Create `src/providers/newprovider.ts` extending `LLMProvider`
2. Implement required methods: `isAvailable()`, `getModels()`, `complete()`
3. Add config interface to `src/types.ts` (e.g., `NewProviderConfig`)
4. Add to `ProvidersConfig` union type in `src/types.ts`
5. Add dynamic import in `src/gateway.ts` `initializeProviders()`
6. Export from `src/providers/index.ts`
7. Optionally add to router speed tiers in `src/router.ts` if using speed-first routing

## Subscription Providers

Two providers use existing subscriptions instead of pay-per-token APIs:

### ClaudeCodeProvider
- Spawns `claude -p` CLI subprocess
- Uses existing Claude Code subscription auth
- Requires Claude CLI installed and authenticated

### GLMProvider
- Uses OpenAI SDK with z.ai API endpoint (`https://api.z.ai/api/coding/paas/v4`)
- Part of GLM Coding Plan subscription
- Requires `ZAI_API_KEY` environment variable
- Default mode: Direct API (more reliable)
- Optional subprocess mode: `preferSubprocess: true` (via Claude CLI)

### Subprocess Pattern (Important!)

When spawning CLI tools, **always use `stdio: ['ignore', 'pipe', 'pipe']`**:

```typescript
// CORRECT - prevents process hanging
spawn('claude', args, {
  stdio: ['ignore', 'pipe', 'pipe'],  // stdin ignored!
});

// WRONG - process may hang waiting for stdin
spawn('claude', args, {
  stdio: 'pipe',  // stdin stays open
});
```

See `.claude/scratchpad.md` for details on this bug fix.

## GPU Acceleration

### Local Provider GPU Configuration

The `LocalProvider` (llama.cpp) supports GPU acceleration via Metal (macOS) and CUDA (Linux/Windows):

```typescript
const gateway = new LLMGateway({
  providers: {
    local: {
      modelsPath: './models',
      gpuLayers: 'auto',  // Auto-detect optimal layers
      // gpuLayers: 30,   // Or specify exact number
    },
  },
});
```

**GPU Detection:**
- **Metal** (Apple Silicon M1/M2/M3): Automatic - detected via `process.platform === 'darwin' && process.arch === 'arm64'`
- **CUDA** (NVIDIA): Manual configuration via `gpuLayers`
- **CPU fallback**: Automatic if GPU unavailable

**Performance Expectations:**
- **Metal** (M1/M2/M3): 2-3x speedup over CPU
- **CUDA** (RTX 3080+): 3-5x speedup over CPU
- **CPU**: Baseline performance

### Ollama GPU Acceleration

Ollama automatically uses GPU acceleration when available:

```bash
# Verify GPU is being used
ollama ps  # Should show GPU utilization (e.g., "100% GPU")

# Monitor GPU usage
# macOS: sudo powermetrics --samplers gpu_power -i 1000
# Linux: nvidia-smi
```

**Ollama GPU Support:**
- **macOS**: Metal (M1/M2/M3) - built-in, automatic
- **Linux**: CUDA, ROCm (AMD) - automatic with supported hardware
- **Windows**: CUDA only - requires supported NVIDIA GPU

### LFM Models with GPU

Liquid AI's LFM models are configured in the speed tiers with GPU-aware expectations:

**Tier 1 (< 200ms with GPU):**
- `LFM2-350M` - Smallest model, instant response
- `hf.co/LiquidAI/LFM2-350M-Q4_K_M-GGUF` (Ollama)

**Tier 2 (< 500ms with GPU):**
- `LFM2-1.2B`, `LFM2.5-1.2B` - Small models, fast inference
- `hf.co/LiquidAI/LFM2-1.2B-GGUF`, `hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF` (Ollama)

### Setup LFM Models

```bash
# Download LFM models to Ollama
cd /Users/anhdao/project/lang/unified-llm
./scripts/setup-lfm-models.sh

# Verify installation
ollama list | grep lfm

# Run benchmark
bun run examples/benchmark-lfm.ts
```

### Monitoring GPU Usage

```bash
# Use the GPU monitor script
bash /Users/anhdao/project/lang/scripts/gpu-monitor.sh
```

## Usage Tracking

The gateway includes comprehensive usage tracking and logging that integrates with [aitok](../ai_ml/toktrack/) (a Rust-based CLI tool for token analytics).

### Features

- **Token counting** across all providers (including local models like Ollama/Llama.cpp via js-tiktoken and llama-tokenizer-js)
- **Cost tracking** with built-in pricing for OpenAI, Anthropic, Gemini models (Jan 2025 rates)
- **aitok integration** via JSONL logs at `./logs/usage.jsonl`
- **SQLite analytics** for grouping by provider/model (optional, requires better-sqlite3)
- **Graceful degradation** - logging failures never break completions
- **Session tracking** - group related requests with UUID-based session IDs

### Configuration

```typescript
const gateway = new LLMGateway({
  providers: { openai: {}, ollama: { baseUrl: 'http://localhost:11434' } },
  usage: {
    enabled: true,
    jsonlPath: './logs/usage.jsonl',  // aitok-compatible logs
    database: {
      enabled: false,  // true for Node.js, false for Bun (better-sqlite3 incompatible)
      path: './usage.db',
    },
    tokenCounting: {
      enabled: true,
      defaultTokenizer: 'tiktoken',  // or 'llama' for LLaMA-based models
    },
    costTracking: {
      enabled: true,
      customPricing: {
        'gpt-4o': { inputCostPer1k: 2.50, outputCostPer1k: 10.00 },
      },
    },
    asyncLogging: true,
    flushInterval: 5000,
  },
});
```

### JSONL Format

Each line in `logs/usage.jsonl` is a JSON object:

```jsonl
{"platform":"unified-llm","provider":"ollama","model":"qwen2.5vl:7b","session":"abc-123","timestamp":"2025-01-14T10:30:00.000Z","input":150,"output":50,"cache_read":0,"cache_write":0,"cost":0.00125}
```

### aitok Integration

Parse logs with aitok:
```bash
aitok parse --path ./logs/usage.jsonl
aitok dashboard
```

**Note on duplication**: unified-llm logs ALL requests that go through the gateway, including those routed through ClaudeCodeProvider. The `platform` field is always `"unified-llm"` to distinguish from direct Claude Code usage.

### API

```typescript
// Set custom session ID
gateway.setUsageSessionId('my-session-' + Date.now());

// Get usage report (requires SQLite)
const report = await gateway.getUsageReport({
  groupBy: 'provider',
  startDate: new Date('2025-01-01'),
  endDate: new Date(),
});
// Returns: { totalCost, totalTokens, totalRequests, byProvider, byModel }

// Graceful shutdown (flushes pending logs)
await gateway.close();
```

### Dependencies

- **Required**: `uuid` (for session/request IDs)
- **Optional**: `js-tiktoken`, `llama-tokenizer-js` (for token estimation)
- **Optional**: `better-sqlite3` (for SQLite analytics - Node.js only)

### Performance Overhead

Logging is async and non-blocking:
- Token counting: 1-10ms
- Cost calculation: <1ms
- JSONL write: 1-5ms (async)
- SQLite insert: 2-5ms (async)
- **Total: <20ms per request**

## Configuration Reference

### New Configuration Options (Jan 2025)

```typescript
interface GatewayConfig {
  providers: ProvidersConfig;
  strategy?: RoutingStrategy;  // 'fastest' | 'cheapest' | 'quality' | 'local-only' | 'subscription-only'

  // Racing configuration
  racing?: {
    enabled?: boolean;       // Default: true
    raceCount?: number;      // Default: 2 (race top 2 providers)
    staggerMs?: number;      // Default: 500 (500ms delay before 2nd provider)
  };

  // Circuit breaker
  circuitBreaker?: {
    enabled?: boolean;       // Default: true
    failureThreshold?: number; // Default: 3
    recoveryTimeout?: number;  // Default: 30000 (30s)
  };

  // EWMA metrics
  metrics?: {
    alpha?: number;          // Default: 0.3 (30% weight to new data)
    initialLatency?: number; // Default: 500ms
  };

  // Global timeout
  globalTimeout?: number;    // Default: 30000 (30s)

  // Cache, usage tracking unchanged...
}
```

### New Gateway APIs

```typescript
// Health monitoring
gateway.getProviderHealth(id);    // { latency, healthScore, circuitState }
gateway.getFailingProviders();    // string[] of providers with open circuits
gateway.resetHealthTracking();    // Reset all metrics and circuit breakers
gateway.refreshAvailability();    // Clear availability cache

// Initialization
await gateway.ready;              // Wait for all providers to load

// Graceful shutdown
await gateway.close();            // Flush logs
```

## Bun-Specific Notes

This project uses Bun as runtime and package manager:
- Use `bun` instead of `node`
- Use `bun test` instead of jest/vitest
- Use `bun install` instead of npm/yarn
- Bun auto-loads .env files
- DNS prefetch for cloud providers (automatic in Bun runtime)

## Build System

The build process uses two steps:
1. `bun build` - Bundles TypeScript to JavaScript (`dist/index.js`)
2. `tsc --emitDeclarationOnly` - Generates type declarations (`dist/index.d.ts`)

This separation allows Bun's fast bundling while maintaining full TypeScript type information for consumers of the package.
