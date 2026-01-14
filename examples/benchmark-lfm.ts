#!/usr/bin/env bun
/**
 * LFM Model Performance Benchmark
 *
 * Tests Liquid AI's LFM (Lightweight Foundational Model) GGUF models
 * with GPU acceleration on Apple Silicon (Metal) and other platforms.
 *
 * Usage:
 *   bun run examples/benchmark-lfm.ts
 *   bun run examples/benchmark-lfm.ts --iterations 5
 */

import { LLMGateway } from '../src/index.ts';

// LFM models to benchmark
const LFM_MODELS = [
  {
    name: 'LFM2-350M (Ollama)',
    model: 'hf.co/LiquidAI/LFM2-350M-Q4_K_M-GGUF',
    provider: 'ollama',
    expected: '<150ms (GPU), <400ms (CPU)',
  },
  {
    name: 'LFM2-1.2B (Ollama)',
    model: 'hf.co/LiquidAI/LFM2-1.2B-GGUF',
    provider: 'ollama',
    expected: '<350ms (GPU), <900ms (CPU)',
  },
  {
    name: 'LFM2.5-1.2B-Instruct (Ollama)',
    model: 'hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF',
    provider: 'ollama',
    expected: '<400ms (GPU), <950ms (CPU)',
  },
];

// Test prompts covering different use cases
const TEST_PROMPTS = [
  'What is the capital of Japan?',
  'Translate "hello" to Japanese',
  'Explain photosynthesis in one sentence',
  'Write a haiku about coding',
  'What is 2 + 2?',
];

interface BenchmarkResult {
  model: string;
  provider: string;
  latencies: number[];
  meanLatency: number;
  stdLatency: number;
  minLatency: number;
  maxLatency: number;
  success: boolean;
  error?: string;
}

async function benchmarkModel(
  gateway: LLMGateway,
  modelName: string,
  provider: string,
  iterations: number = 3
): Promise<BenchmarkResult> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Benchmarking: ${modelName} (${provider})`);
  console.log(`${'='.repeat(60)}`);

  const latencies: number[] = [];
  const results: string[] = [];

  for (let i = 0; i < TEST_PROMPTS.length && i < iterations; i++) {
    const prompt = TEST_PROMPTS[i];

    try {
      const start = Date.now();
      const response = await gateway.complete({
        messages: [{ role: 'user', content: prompt }],
        model: modelName,
      });
      const latency = Date.now() - start;

      latencies.push(latency);
      results.push(response.content);

      const truncatedContent = response.content.slice(0, 60);
      console.log(`  [${i + 1}] ${latency.toString().padStart(4)}ms - "${truncatedContent}..."`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(`  [${i + 1}] ERROR: ${errorMsg}`);
    }
  }

  if (latencies.length === 0) {
    return {
      model: modelName,
      provider,
      latencies: [],
      meanLatency: 0,
      stdLatency: 0,
      minLatency: 0,
      maxLatency: 0,
      success: false,
      error: 'All requests failed',
    };
  }

  // Calculate statistics
  const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const variance = latencies.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / latencies.length;
  const std = Math.sqrt(variance);

  console.log(`  Mean: ${mean.toFixed(0)}ms ± ${std.toFixed(0)}ms`);
  console.log(`  Min: ${Math.min(...latencies)}ms, Max: ${Math.max(...latencies)}ms`);

  return {
    model: modelName,
    provider,
    latencies,
    meanLatency: mean,
    stdLatency: std,
    minLatency: Math.min(...latencies),
    maxLatency: Math.max(...latencies),
    success: true,
  };
}

function printComparison(results: BenchmarkResult[]): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log('Performance Comparison');
  console.log(`${'='.repeat(60)}`);

  console.log(`\n${'Model'.padEnd(35)} ${'Mean'.padStart(10)} ${'Min'.padStart(10)} ${'Max'.padStart(10)} ${'Status'}`);
  console.log('-'.repeat(80));

  for (const result of results) {
    const model = result.model.slice(0, 35);
    const mean = result.success ? `${result.meanLatency.toFixed(0)}ms` : 'FAILED';
    const min = result.success ? `${result.minLatency.toFixed(0)}ms` : '-';
    const max = result.success ? `${result.maxLatency.toFixed(0)}ms` : '-';
    const status = result.success ? '✓' : '✗';

    console.log(`${model.padEnd(35)} ${mean.padStart(10)} ${min.padStart(10)} ${max.padStart(10)} ${status}`);
  }

  console.log();
}

function printGPUSuggestion(): void {
  console.log(`${'='.repeat(60)}`);
  console.log('GPU Acceleration Notes');
  console.log(`${'='.repeat(60)}`);
  console.log('');
  console.log('Apple Silicon (M1/M2/M3):');
  console.log('  • Metal GPU acceleration is automatic in Ollama');
  console.log('  • Verify with: ollama ps (should show GPU utilization)');
  console.log('  • Expected speedup: 2-3x over CPU');
  console.log('');
  console.log('NVIDIA GPUs:');
  console.log('  • CUDA acceleration in Ollama and node-llama-cpp');
  console.log('  • Expected speedup: 3-5x over CPU');
  console.log('');
  console.log('To verify GPU is being used:');
  console.log('  ollama ps                    # Check GPU utilization');
  console.log('  sudo powermetrics --samplers gpu_power -i 1000  # macOS');
  console.log('');
}

async function main() {
  console.log('='.repeat(60));
  console.log('LFM Model Performance Benchmark');
  console.log('='.repeat(60));
  console.log('');
  console.log('This benchmark tests LFM models with various prompts.');
  console.log('Make sure Ollama is running: ollama serve');
  console.log('');

  // Check if Ollama is available
  try {
    const process = Bun.spawn(['ollama', 'list'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Wait for the process to complete
    await process.exited;
    console.log('✓ Ollama is running');
  } catch {
    console.log('⚠️  Ollama may not be running');
    console.log('   Start with: ollama serve');
    console.log('');
  }

  // Create gateway
  const gateway = new LLMGateway({
    providers: {
      ollama: {
        baseUrl: 'http://localhost:11434',
      },
    },
    strategy: 'fastest',
  });

  await gateway.ready;

  // Run benchmarks
  const results: BenchmarkResult[] = [];

  for (const modelSpec of LFM_MODELS) {
    const result = await benchmarkModel(
      gateway,
      modelSpec.model,
      modelSpec.provider
    );
    results.push(result);
  }

  // Print comparison
  printComparison(results);

  // Print GPU suggestions
  printGPUSuggestion();

  // Check if targets were met
  console.log('='.repeat(60));
  console.log('Target Performance Check');
  console.log('='.repeat(60));
  console.log('');

  const successfulResults = results.filter(r => r.success);

  if (successfulResults.length > 0) {
    const avgLatency = successfulResults.reduce((sum, r) => sum + r.meanLatency, 0) / successfulResults.length;

    console.log(`Average latency across all models: ${avgLatency.toFixed(0)}ms`);

    if (avgLatency < 500) {
      console.log('✓ Excellent! Average < 500ms (GPU likely active)');
    } else if (avgLatency < 1000) {
      console.log('~ Good performance. Average < 1s');
    } else {
      console.log('⚠️  Slower than expected. Check if GPU is enabled:');
      console.log('   ollama ps  (should show GPU utilization)');
    }
  }

  console.log('');

  // Cleanup
  await gateway.close();
}

main().catch(console.error);
