/**
 * Latency Benchmark Test
 *
 * Tests actual latency for models in each speed tier by testing
 * providers directly (bypassing router to get precise measurements).
 */

import { LocalProvider } from '../src/providers/local.ts';
import { OllamaProvider } from '../src/providers/ollama.ts';

// Test configuration - one representative model per tier
const TIER_TESTS = [
  {
    tier: 1,
    name: 'Tier 1: Instant (<200ms)',
    expectedMax: 200,
    models: [
      { provider: 'local', name: 'LFM2-350M-Q5_K_M.gguf', prompt: 'What is 1 + 1?' },
      { provider: 'local', name: 'LFM2-350M-ENJP-MT-Q5_K_M.gguf', prompt: 'Translate "hello" to Japanese' },
    ],
  },
  {
    tier: 2,
    name: 'Tier 2: Fast (<500ms)',
    expectedMax: 500,
    models: [
      { provider: 'ollama', name: 'hf.co/Qwen/Qwen3-0.6B-GGUF:latest', prompt: 'Write a sentence about cats' },
      { provider: 'ollama', name: 'hf.co/Qwen/Qwen3-1.7B-GGUF:latest', prompt: 'Translate "good morning" to Japanese' },
    ],
  },
  {
    tier: 5,
    name: 'Tier 5: Moderate (<1s)',
    expectedMax: 1000,
    models: [
      { provider: 'ollama', name: 'hf.co/Qwen/Qwen3-4B-GGUF:latest', prompt: 'Summarize the benefits of exercise in 2 sentences' },
      { provider: 'ollama', name: 'hf.co/Qwen/Qwen3-8B-GGUF:latest', prompt: 'Explain photosynthesis in one sentence' },
    ],
  },
  {
    tier: 6,
    name: 'Tier 6: Quality (1-3s)',
    expectedMax: 3000,
    models: [
      { provider: 'ollama', name: 'hf.co/Qwen/Qwen3-32B-GGUF:latest', prompt: 'Explain quantum computing in simple terms' },
    ],
  },
  {
    tier: 7,
    name: 'Tier 7: Premium (3s+)',
    expectedMax: Infinity,
    models: [
      { provider: 'ollama', name: 'hf.co/BasedBase/Qwen3-Coder-30B-A3B-Instruct-480B-Distill-V2:Q6_K', prompt: 'Write a Python function for binary search' },
    ],
  },
];

interface BenchmarkResult {
  tier: number;
  tierName: string;
  provider: string;
  model: string;
  prompt: string;
  latencyMs: number;
  expectedMax: number;
  passed: boolean;
  error?: string;
}

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function colorize(text: string, color: keyof typeof colors): string {
  return `${colors[color]}${text}${colors.reset}`;
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatResult(result: BenchmarkResult): string {
  const status = result.error
    ? colorize('ERROR', 'red')
    : result.passed
      ? colorize('PASS', 'green')
      : colorize('FAIL', 'red');

  const latency = result.error
    ? colorize(result.error, 'red')
    : formatLatency(result.latencyMs);

  const expected = result.expectedMax === Infinity ? '∞' : formatLatency(result.expectedMax);

  return `  [${status}] ${result.model}: ${latency} (expected < ${expected})`;
}

// Initialize providers directly
const localProvider = new LocalProvider({
  modelsPath: './models',
});

const ollamaProvider = new OllamaProvider({
  baseUrl: 'http://localhost:11434',
});

const providers = {
  local: localProvider,
  ollama: ollamaProvider,
};

async function warmup() {
  console.log(colorize('\n=== Warmup ===', 'cyan'));
  console.log('Sending warmup requests to initialize providers...');

  try {
    await ollamaProvider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'hf.co/Qwen/Qwen3-0.6B-GGUF:latest',
      maxTokens: 5,
    });
    console.log(colorize('✓ Ollama warmup complete', 'green'));
  } catch (error) {
    console.log(colorize('✗ Ollama warmup failed', 'yellow'));
  }

  try {
    await localProvider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'LFM2-350M-Q5_K_M.gguf',
      maxTokens: 5,
    });
    console.log(colorize('✓ Local warmup complete', 'green'));
  } catch (error) {
    console.log(colorize('✗ Local warmup failed', 'yellow'));
  }
}

async function testModel(
  tier: typeof TIER_TESTS[0],
  modelConfig: typeof TIER_TESTS[0]['models'][0]
): Promise<BenchmarkResult> {
  const provider = providers[modelConfig.provider as keyof typeof providers];

  const startTime = performance.now();
  try {
    const response = await provider.complete({
      messages: [{ role: 'user', content: modelConfig.prompt }],
      model: modelConfig.name,
      maxTokens: 50,
    });
    const endTime = performance.now();

    return {
      tier: tier.tier,
      tierName: tier.name,
      provider: modelConfig.provider,
      model: modelConfig.name,
      prompt: modelConfig.prompt,
      latencyMs: endTime - startTime,
      expectedMax: tier.expectedMax,
      passed: endTime - startTime < tier.expectedMax,
    };
  } catch (error) {
    return {
      tier: tier.tier,
      tierName: tier.name,
      provider: modelConfig.provider,
      model: modelConfig.name,
      prompt: modelConfig.prompt,
      latencyMs: 0,
      expectedMax: tier.expectedMax,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runBenchmark(): Promise<void> {
  console.log(colorize('\n╔════════════════════════════════════════════════════════╗', 'cyan'));
  console.log(colorize('║     Latency Benchmark - Speed Tier Validation      ║', 'cyan'));
  console.log(colorize('╚════════════════════════════════════════════════════════╝', 'cyan'));

  // Check provider availability
  console.log(colorize('\n=== Provider Status ===', 'cyan'));

  const localAvailable = await localProvider.isAvailable();
  const ollamaAvailable = await ollamaProvider.isAvailable();

  console.log(`  ${localAvailable ? colorize('✓', 'green') : colorize('✗', 'red')} local provider`);
  console.log(`  ${ollamaAvailable ? colorize('✓', 'green') : colorize('✗', 'red')} ollama provider`);

  const localModels = localAvailable ? await localProvider.getModels() : [];
  const ollamaModels = ollamaAvailable ? await ollamaProvider.getModels() : [];

  console.log(`\nLocal models: ${localModels.slice(0, 3).join(', ')}${localModels.length > 3 ? '...' : ''}`);
  console.log(`Ollama models: ${ollamaModels.slice(0, 3).join(', ')}${ollamaModels.length > 3 ? '...' : ''}`);

  await warmup();

  const results: BenchmarkResult[] = [];

  for (const tier of TIER_TESTS) {
    console.log(colorize(`\n${tier.name}`, 'cyan'));
    console.log(colorize('─'.repeat(50), 'cyan'));

    for (const modelConfig of tier.models) {
      // Check if provider is available
      const providerAvailable = modelConfig.provider === 'local' ? localAvailable : ollamaAvailable;
      if (!providerAvailable) {
        console.log(
          formatResult({
            tier: tier.tier,
            tierName: tier.name,
            provider: modelConfig.provider,
            model: modelConfig.name,
            prompt: modelConfig.prompt,
            latencyMs: 0,
            expectedMax: tier.expectedMax,
            passed: false,
            error: 'Provider not available',
          })
        );
        continue;
      }

      // Run 3 tests for statistical significance (warmup + 2 measured)
      const runs: BenchmarkResult[] = [];
      for (let i = 0; i < 3; i++) {
        const result = await testModel(tier, modelConfig);
        runs.push(result);

        // Small delay between requests
        if (i < 2) await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Use median latency (skip first run as warmup)
      const measuredRuns = runs.slice(1);
      const latencies = measuredRuns.filter((r) => !r.error).map((r) => r.latencyMs);

      if (latencies.length > 0) {
        const median = latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)];
        const representative = measuredRuns.find((r) => r.latencyMs === median) || measuredRuns[0];
        representative.latencyMs = median;
        representative.passed = median < tier.expectedMax;
        results.push(representative);
        console.log(formatResult(representative));
      } else if (runs[0].error) {
        console.log(formatResult(runs[0]));
        results.push(runs[0]);
      }
    }
  }

  // Summary
  console.log(colorize('\n╔════════════════════════════════════════════════════════╗', 'cyan'));
  console.log(colorize('║                    Summary                           ║', 'cyan'));
  console.log(colorize('╚════════════════════════════════════════════════════════╝', 'cyan'));

  const passed = results.filter((r) => r.passed && !r.error).length;
  const failed = results.filter((r) => !r.passed && !r.error).length;
  const errors = results.filter((r) => r.error).length;
  const total = results.length;

  console.log(`\nTotal: ${total} | ${colorize('PASS', 'green')}: ${passed} | ${colorize('FAIL', 'red')}: ${failed} | ${colorize('ERROR', 'yellow')}: ${errors}`);

  // Tier-by-tier breakdown
  console.log(colorize('\n=== Tier Breakdown ===', 'cyan'));
  for (const tier of TIER_TESTS) {
    const tierResults = results.filter((r) => r.tier === tier.tier && !r.error);
    if (tierResults.length === 0) continue;

    const avgLatency =
      tierResults.reduce((sum, r) => sum + r.latencyMs, 0) / tierResults.length;
    const passRate = (tierResults.filter((r) => r.passed).length / tierResults.length) * 100;

    const status = avgLatency < tier.expectedMax ? colorize('✓', 'green') : colorize('✗', 'red');
    console.log(
      `${status} ${tier.name}: ${colorize(formatLatency(avgLatency), passRate === 100 ? 'green' : 'red')} avg (${passRate.toFixed(0)}% pass rate)`
    );
  }

  // Recommendations
  console.log(colorize('\n=== Recommendations ===', 'cyan'));
  if (failed > 0) {
    console.log(colorize('• Some models exceeded expected latency thresholds', 'yellow'));
    console.log(colorize('  Consider: GPU offloading, quantization, or tier reclassification', 'yellow'));
  }
  if (errors > 0) {
    console.log(colorize('• Some models failed to load or respond', 'red'));
    console.log(colorize('  Check: Ollama service running, model files exist', 'red'));
  }
  if (passed === total) {
    console.log(colorize('✓ All models performing within expected latency!', 'green'));
  }

  // Speed tier insights
  console.log(colorize('\n=== Insights ===', 'cyan'));
  for (const tier of TIER_TESTS) {
    const tierResults = results.filter((r) => r.tier === tier.tier && !r.error);
    if (tierResults.length === 0) continue;

    const avgLatency =
      tierResults.reduce((sum, r) => sum + r.latencyMs, 0) / tierResults.length;

    if (tier.expectedMax === Infinity) {
      console.log(`• ${tier.name}: ${formatLatency(avgLatency)} avg (no threshold)`);
    } else if (avgLatency > tier.expectedMax * 2) {
      console.log(
        colorize(`• ${tier.name}: ${formatLatency(avgLatency)} avg - ${formatLatency(avgLatency - tier.expectedMax)} over threshold (2x+)`, 'red')
      );
    } else if (avgLatency > tier.expectedMax) {
      console.log(
        colorize(`• ${tier.name}: ${formatLatency(avgLatency)} avg - ${formatLatency(avgLatency - tier.expectedMax)} over threshold`, 'yellow')
      );
    } else {
      console.log(
        colorize(`• ${tier.name}: ${formatLatency(avgLatency)} avg - ${formatLatency(tier.expectedMax - avgLatency)} under threshold`, 'green')
      );
    }
  }
}

runBenchmark().catch(console.error);
