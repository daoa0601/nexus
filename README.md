# unified-llm

Unified LLM gateway with health-aware routing across multiple providers.

## Features

- **Multi-provider support**: OpenAI, Anthropic, Gemini, Ollama, local GGUF models
- **Subscription providers**: Claude Code and GLM Coding Plan (no pay-per-token)
- **Parallel racing**: Race multiple providers with staggered starts for 40%+ latency reduction
- **Health-aware routing**: EWMA latency tracking + circuit breakers for intelligent provider selection
- **Automatic fallback**: Falls back to next provider if one fails
- **Caching**: In-memory (default) or SQLite persistence with SHA256 cache keys
- **High-level helpers**: Built-in translate, generate, explain methods

## Installation

```bash
bun add unified-llm
```

## Quick Start

```typescript
import { LLMGateway } from 'unified-llm';

const gateway = new LLMGateway({
  providers: {
    openai: {},                              // Uses OPENAI_API_KEY env
    ollama: { baseUrl: 'http://localhost:11434' },
    anthropic: {},                           // Uses ANTHROPIC_API_KEY env
  },
  strategy: 'fastest',
});

// Simple completion
const response = await gateway.complete({
  messages: [{ role: 'user', content: 'Hello!' }],
});
console.log(response.content);

// Translation helper
const japanese = await gateway.translate({ text: 'Hello', to: 'ja' });

// Generation helper
const poem = await gateway.generate({ prompt: 'Write a haiku' });
```

## Providers

### OpenAI (and compatible APIs)

```typescript
providers: {
  openai: {
    apiKey: 'sk-...',           // Or use OPENAI_API_KEY env
    baseUrl: 'https://...',     // Optional: for compatible APIs
    organization: 'org-...',    // Optional
  }
}
```

### Anthropic

```typescript
providers: {
  anthropic: {
    apiKey: 'sk-ant-...',       // Or use ANTHROPIC_API_KEY env
  }
}
```

### Google Gemini

```typescript
providers: {
  gemini: {
    apiKey: 'AI...',            // Or use GEMINI_API_KEY env
  }
}
```

### Ollama (local server)

```typescript
providers: {
  ollama: {
    baseUrl: 'http://localhost:11434',
  }
}
```

### Local GGUF Models

```typescript
providers: {
  local: {
    modelsPath: './models',     // Directory containing .gguf files
    gpuLayers: 'auto',          // Number of layers to offload to GPU
  }
}
```

### Custom Gateway

```typescript
providers: {
  gateway: {
    baseUrl: 'https://your-gateway.com/v1',
    apiKey: 'your-key',
    headers: { 'X-Custom': 'value' },
  }
}
```

### Claude Code (Subscription)

Uses `claude` CLI subprocess - leverages your existing Claude Code subscription (no per-token billing).

```typescript
providers: {
  'claude-code': {
    cliPath: '/path/to/claude',  // Optional: custom CLI path
    timeout: 120000,              // Optional: timeout in ms
  }
}
```

**Requirements**: Claude CLI installed and authenticated (`claude --version`)

### GLM Coding Plan (Subscription)

Uses Zhipu AI's GLM-4.7 via z.ai API - part of GLM Coding Plan subscription.

```typescript
providers: {
  glm: {
    apiKey: 'your-zai-key',      // Or use ZAI_API_KEY env var
  }
}
```

**Requirements**: ZAI_API_KEY environment variable or apiKey config

## Routing Strategies

| Strategy | Description |
|----------|-------------|
| `fastest` | Use fastest available provider (default) |
| `cheapest` | Prioritize free/local options |
| `quality` | Prioritize best models |
| `local-only` | Only use local and ollama providers |
| `subscription-only` | Only subscription providers (local, ollama, glm, claude-code) |

```typescript
const gateway = new LLMGateway({
  strategy: 'fastest',
  // ...
});

// Change strategy at runtime
gateway.setStrategy('local-only');
```

## Parallel Racing

By default, the gateway races multiple providers in parallel with staggered starts to minimize latency while controlling costs.

```typescript
const gateway = new LLMGateway({
  providers: { /* ... */ },

  // Racing configuration
  racing: {
    enabled: true,     // Enable parallel racing (default: true)
    raceCount: 2,      // Race top 2 providers (default: 2)
    staggerMs: 500,    // Start 2nd provider after 500ms delay (default: 500)
  },

  // Global timeout for entire request
  globalTimeout: 30000,  // 30 seconds (default: 30000)
});
```

**How staggered racing works:**
1. First provider starts immediately
2. Second provider starts after 500ms (if first hasn't responded)
3. First response wins; losers are cancelled via `AbortController`
4. If first provider responds in <500ms, second never starts (saves API costs)

## Health Monitoring

The gateway tracks provider health using EWMA (Exponentially Weighted Moving Average) latency and circuit breakers.

### Circuit Breakers

Automatically disable failing providers:

```typescript
const gateway = new LLMGateway({
  providers: { /* ... */ },

  circuitBreaker: {
    enabled: true,          // Enable circuit breakers (default: true)
    failureThreshold: 3,    // Open circuit after 3 consecutive failures (default: 3)
    recoveryTimeout: 30000, // Try recovery after 30s (default: 30000)
  },
});
```

**Circuit states:**
- `CLOSED`: Normal operation, requests pass through
- `OPEN`: Provider failing, requests blocked
- `HALF_OPEN`: Testing recovery (allows one request)

### Health APIs

```typescript
// Get health info for a provider
const health = gateway.getProviderHealth('openai');
// { latency: 450, healthScore: 2.2, circuitState: 'CLOSED' }

// Get all failing providers (open circuits)
const failing = gateway.getFailingProviders();
// ['anthropic'] if Anthropic circuit is open

// Reset all health tracking
gateway.resetHealthTracking();

// Force re-check provider availability
gateway.refreshAvailability();
```

### EWMA Latency Tracking

Recent latency observations are weighted more heavily than older ones (α=0.3):

```typescript
const gateway = new LLMGateway({
  providers: { /* ... */ },

  metrics: {
    alpha: 0.3,           // EWMA smoothing factor (default: 0.3)
    initialLatency: 500,  // Initial estimate in ms (default: 500)
  },
});
```

## Initialization

The gateway uses async initialization. For guaranteed provider availability, await the `ready` promise:

```typescript
const gateway = new LLMGateway({ /* ... */ });

// Option 1: Await ready explicitly
await gateway.ready;
const response = await gateway.complete({ /* ... */ });

// Option 2: complete() awaits ready internally (automatic)
const response = await gateway.complete({ /* ... */ });
```

## Caching

### In-Memory (default)

```typescript
cache: {
  enabled: true,
  adapter: 'memory',
  ttlMs: 3600000,    // 1 hour
  maxSize: 1000,     // Max entries
}
```

### SQLite (persistent)

```typescript
cache: {
  enabled: true,
  adapter: 'sqlite',
  ttlMs: 3600000,
  dbPath: './llm-cache.db',
}
```

## High-Level Helpers

### translate()

```typescript
const result = await gateway.translate({
  text: 'Hello world',
  to: 'ja',           // Target language
  from: 'en',         // Source (optional, auto-detect)
});
```

### generate()

```typescript
const result = await gateway.generate({
  prompt: 'Write a story about...',
  systemPrompt: 'You are a creative writer',
  temperature: 0.8,
  maxTokens: 500,
});
```

### explain()

Designed for language learning apps:

```typescript
const result = await gateway.explain({
  pattern: '〜てもいい',
  sentence: '食べてもいいですか？',
  language: 'Japanese',
});
```

## Error Handling

```typescript
import { LLMError, NoProvidersAvailableError, RateLimitError } from 'unified-llm';

try {
  const response = await gateway.complete({ ... });
} catch (error) {
  if (error instanceof NoProvidersAvailableError) {
    console.log('No providers configured or available');
  } else if (error instanceof RateLimitError) {
    console.log(`Rate limited by ${error.provider}`);
  } else if (error instanceof LLMError) {
    console.log(`Error from ${error.provider}: ${error.message}`);
  }
}
```

## Custom Providers

Extend `LLMProvider` to add your own:

```typescript
import { LLMProvider, type CompletionParams, type CompletionResponse } from 'unified-llm';

class MyProvider extends LLMProvider {
  readonly id = 'my-provider';
  readonly name = 'My Custom Provider';

  async isAvailable() { return true; }
  async getModels() { return ['my-model']; }

  async complete(params: CompletionParams): Promise<CompletionResponse> {
    // Your implementation
  }
}
```

## Development

```bash
# Install dependencies
bun install

# Type check
bun run lint

# Run example
bun run examples/basic-usage.ts
```

## License

MIT
