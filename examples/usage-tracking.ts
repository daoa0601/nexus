/**
 * Usage tracking example for unified-llm
 *
 * This example demonstrates how to:
 * - Enable usage tracking
 * - Log token usage and costs
 * - Generate usage reports
 * - Integrate with aitok
 */

import { LLMGateway } from '../src/index.ts';

// Initialize gateway with usage tracking enabled
const gateway = new LLMGateway({
  providers: {
    // Add your providers here
    // openai: {},
    // anthropic: {},
    ollama: {
      baseUrl: 'http://localhost:11434',
    },
  },

  // Specify a valid model for Ollama
  defaultModel: 'qwen2.5vl:7b',  // or use 'deepseek-r1:latest', 'llama3.3:70b-instruct-q2_K'
  strategy: 'fastest',

  // Enable usage tracking
  usage: {
    enabled: true,

    // JSONL log file (aitok-compatible)
    jsonlPath: './logs/usage.jsonl',

    // SQLite database for analytics (DISABLED - better-sqlite3 not supported in Bun yet)
    database: {
      enabled: false,  // Set to true when using Node.js instead of Bun
      path: './usage.db',
    },

    // Token counting for providers without usage
    tokenCounting: {
      enabled: true,
      defaultTokenizer: 'tiktoken',
    },

    // Cost tracking
    costTracking: {
      enabled: true,
      // Optional: custom pricing per model
      // customPricing: {
      //   'gpt-4o': {
      //     inputCostPer1k: 3.00,
      //     outputCostPer1k: 12.00,
      //   },
      // },
    },

    // Performance tuning
    asyncLogging: true,
    flushInterval: 5000,
  },
});

async function main() {
  console.log('=== Usage Tracking Example ===\n');

  // Set a custom session ID
  gateway.setUsageSessionId('example-session-' + Date.now());
  console.log('Session ID:', gateway.getUsageSessionId());

  // Make some requests
  console.log('\n--- Making requests ---\n');

  const prompts = [
    'What is 2 + 2?',
    'Write a haiku about coding',
    'Explain recursion in one sentence',
  ];

  for (const prompt of prompts) {
    try {
      console.log(`Prompt: "${prompt}"`);
      const startTime = Date.now();

      const response = await gateway.complete({
        messages: [{ role: 'user', content: prompt }],
        model: 'qwen2.5vl:7b',  // Explicitly specify the model
        temperature: 0.7,
      });

      const latency = Date.now() - startTime;
      console.log(`Response (${response.provider}/${response.model}):`);
      console.log(`  ${response.content.slice(0, 100)}${response.content.length > 100 ? '...' : ''}`);
      console.log(`  Latency: ${response.latencyMs}ms, Cached: ${response.cached}`);
      if (response.usage) {
        console.log(`  Tokens: ${response.usage.totalTokens} (in: ${response.usage.promptTokens}, out: ${response.usage.completionTokens})`);
      }
      console.log();
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      console.log();
    }
  }

  // Wait for async logging to flush
  console.log('Waiting for logs to flush...');
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Get usage report
  console.log('\n--- Usage Report ---\n');

  const report = await gateway.getUsageReport({
    groupBy: 'provider',
  });

  if (report) {
    console.log(`Total Cost: $${report.totalCost.toFixed(4)}`);
    console.log(`Total Tokens: ${report.totalTokens}`);
    console.log(`Total Requests: ${report.totalRequests}`);
    console.log();

    console.log('By Provider:');
    for (const [provider, stats] of Object.entries(report.byProvider)) {
      console.log(`  ${provider}:`);
      console.log(`    Tokens: ${stats.tokens}`);
      console.log(`    Cost: $${stats.cost.toFixed(4)}`);
      console.log(`    Requests: ${stats.requests}`);
    }
    console.log();

    console.log('By Model:');
    for (const [model, stats] of Object.entries(report.byModel)) {
      console.log(`  ${model}:`);
      console.log(`    Tokens: ${stats.tokens}`);
      console.log(`    Cost: $${stats.cost.toFixed(4)}`);
      console.log(`    Requests: ${stats.requests}`);
    }
  } else {
    console.log('No usage report available (SQLite database not enabled)');
    console.log('Note: JSONL logs are still being written to ./logs/usage.jsonl');
  }

  console.log();

  // Show aitok integration
  console.log('--- aitok Integration ---\n');
  console.log('Usage has been logged to: ./logs/usage.jsonl');
  console.log('You can now parse this file with aitok:');
  console.log('  aitok parse --path ./logs/usage.jsonl');
  console.log('  aitok dashboard');
  console.log();

  // Show sample JSONL entries
  console.log('--- Sample JSONL Entries ---\n');
  try {
    const { readFile } = await import('fs/promises');
    const content = await readFile('./logs/usage.jsonl', 'utf-8');
    const lines = content.trim().split('\n').slice(-3); // Last 3 entries

    for (const line of lines) {
      const entry = JSON.parse(line);
      console.log(JSON.stringify({
        platform: entry.platform,
        provider: entry.provider,
        model: entry.model,
        input: entry.input,
        output: entry.output,
        cost: entry.cost,
      }, null, 2));
    }
  } catch (error) {
    console.log('Could not read log file:', error instanceof Error ? error.message : 'Unknown error');
  }

  console.log();
  console.log('--- Done ---');
}

main().catch(console.error);
