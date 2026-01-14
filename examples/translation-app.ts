/**
 * Translation app example with Liquid AI model preloading
 *
 * Optimized for Japanese/English translation using:
 * - Liquid AI LFM2-350M (instant, ~200ms)
 * - Local context pooling for fast subsequent requests
 * - Subscription-first strategy to minimize API costs
 */

import { LLMGateway } from '../src/index.ts';

// Initialize gateway optimized for translation
const gateway = new LLMGateway({
  providers: {
    // Local provider with Liquid AI models for translation
    // Download from: https://huggingface.co/LiquidAI/LFM2-350M-GGUF
    local: {
      modelsPath: process.env.MODELS_PATH ?? './models',

      // Preload Liquid AI models at startup (fastest for translation)
      // HuggingFace: LiquidAI/LFM2-350M-GGUF (smallest, ~200ms inference)
      // HuggingFace: LiquidAI/LFM2-1.2B-GGUF (better quality)
      // HuggingFace: LiquidAI/LFM2.5-1.2B-Instruct-GGUF (instruction-tuned)
      preloadModels: [
        'LFM2-350M',           // Fastest - 350M params
        'LFM2.5-1.2B-Instruct', // Better quality - 1.2B params
      ],

      // Warmup prompt to prime GPU caches
      warmupPrompt: 'Hello',

      // Context pool for fast subsequent requests
      contextPool: {
        enabled: true,
        maxPerModel: 3,
        idleTimeoutMs: 120000, // 2 minutes (longer for translation app)
      },

      // Auto GPU layer allocation
      gpuLayers: 'auto',
    },

    // Ollama as backup with Qwen models (multilingual support)
    // Pull with: ollama pull qwen2.5:3b
    ollama: {
      baseUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434',
      preloadModels: ['qwen2.5:3b', 'qwen2.5:7b'],
      healthCheckTimeout: 3000,
    },

    // Subscription providers as cloud backup
    glm: {},
    'claude-code': {},

    // Pay-per-token as last resort
    openai: {},
    anthropic: {},
  },

  // Prefer subscription/local providers to minimize costs
  strategy: 'subscription-first',

  // Racing config - race local vs ollama
  racing: {
    enabled: true,
    raceCount: 2,
    staggerMs: 300, // Shorter stagger for translation (fast local)
  },

  // Faster timeout for translation (should be quick)
  globalTimeout: 10000,

  // Enable caching for repeated translations
  cache: {
    enabled: true,
    adapter: 'memory',
    ttlMs: 86400000, // 24 hours
    maxSize: 5000,
  },
});

async function main() {
  console.log('🚀 Starting translation app...\n');

  // Wait for providers to initialize
  await gateway.ready;
  console.log('✓ Gateway ready\n');

  // Warm up local models for instant first request
  console.log('⏳ Warming up Liquid AI models...');
  const warmupReport = await gateway.warmup({ providers: ['local', 'ollama'] });

  if (warmupReport.success) {
    console.log(`✓ Warmed up ${warmupReport.totalModelsLoaded} models in ${warmupReport.durationMs}ms`);
  } else {
    console.log(`⚠ Warmup completed with ${warmupReport.totalErrors} errors:`);
    for (const [provider, result] of Object.entries(warmupReport.providers)) {
      if (result.errors.length > 0) {
        console.log(`  ${provider}: ${result.errors.join(', ')}`);
      }
    }
  }

  // Check provider health
  console.log('\n📊 Provider health:');
  const status = await gateway.status();
  for (const [id, s] of Object.entries(status)) {
    const health = gateway.getProviderHealth(id);
    console.log(`  ${id}: ${s.available ? '✓' : '✗'} (latency: ${health.latency}ms, circuit: ${health.circuitState})`);
  }

  // Translation examples
  console.log('\n--- Translation Examples ---\n');

  const testPhrases = [
    { text: 'Hello, how are you?', to: 'ja' as const },
    { text: 'おはようございます', to: 'en' as const },
    { text: 'What time is it?', to: 'ja' as const },
    { text: '今日の天気はどうですか？', to: 'en' as const },
    { text: 'Nice to meet you', to: 'ja' as const },
  ];

  for (const { text, to } of testPhrases) {
    try {
      const startTime = Date.now();
      const translation = await gateway.translate({ text, to });
      const latency = Date.now() - startTime;

      console.log(`[${to.toUpperCase()}] "${text}"`);
      console.log(`    → "${translation}" (${latency}ms)\n`);
    } catch (error) {
      console.error(`Failed to translate "${text}":`, error);
    }
  }

  // Show context pool stats (for local provider)
  const localProvider = gateway.getProvider('local');
  if (localProvider && 'getPoolStats' in localProvider) {
    const poolStats = (localProvider as { getPoolStats: () => { totalContexts: number; inUse: number; idle: number } }).getPoolStats();
    console.log('\n📈 Context pool stats:');
    console.log(`  Total contexts: ${poolStats.totalContexts}`);
    console.log(`  In use: ${poolStats.inUse}`);
    console.log(`  Idle: ${poolStats.idle}`);
  }

  // Graceful shutdown
  await gateway.close();
  console.log('\n✓ Gateway closed');
}

main().catch(console.error);
