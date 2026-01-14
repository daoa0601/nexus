/**
 * Test subscription-based providers (Claude Code + GLM)
 *
 * This example tests the new subscription-based providers that don't
 * charge per-token - they use existing subscriptions instead.
 *
 * Requirements:
 * - Claude CLI installed and authenticated (`claude --version`)
 * - ZAI_API_KEY env var set for GLM Coding Plan
 */

import { LLMGateway } from '../src/index.ts';

// Initialize with subscription providers only
const gateway = new LLMGateway({
  providers: {
    // Claude Code subprocess (uses existing Claude Code subscription)
    'claude-code': {},

    // GLM Coding Plan via z.ai (direct API - default, more reliable)
    glm: {},

    // Optional: Ollama for local fallback
    ollama: {
      baseUrl: 'http://localhost:11434',
    },
  },

  // Only use subscription + local providers (no pay-per-token APIs)
  strategy: 'subscription-only',

  // Enable caching
  cache: {
    enabled: true,
    adapter: 'memory',
    ttlMs: 3600000,
    maxSize: 100,
  },
});

async function testProviderStatus() {
  console.log('=== Provider Status ===\n');
  const status = await gateway.status();

  for (const [id, info] of Object.entries(status)) {
    const statusIcon = info.available ? '✓' : '✗';
    console.log(`${statusIcon} ${id}: ${info.name}`);
    if (info.available) {
      console.log(`  Models: ${info.models.join(', ')}`);
    } else if (info.error) {
      console.log(`  Error: ${info.error}`);
    }
  }
  console.log();
}

async function testGLMProvider() {
  console.log('=== GLM Provider Test ===\n');

  try {
    const response = await gateway.complete({
      messages: [{ role: 'user', content: 'What is 2 + 2? Answer in one word.' }],
    });

    console.log(`Provider: ${response.provider}`);
    console.log(`Model: ${response.model}`);
    console.log(`Response: ${response.content}`);
    console.log(`Latency: ${response.latencyMs}ms`);
    if (response.usage) {
      console.log(`Tokens: ${response.usage.totalTokens}`);
    }
    console.log();
  } catch (error) {
    console.error('GLM test failed:', error);
    console.log();
  }
}

async function testClaudeCodeProvider() {
  console.log('=== Claude Code Provider Test ===\n');

  // Temporarily switch strategy to test Claude Code directly
  const previousStrategy = gateway.getStrategy();

  try {
    // Force Claude Code by using quality strategy (Claude is prioritized)
    gateway.setStrategy('quality');

    const response = await gateway.complete({
      messages: [{ role: 'user', content: 'Write a one-line haiku about coding.' }],
    });

    console.log(`Provider: ${response.provider}`);
    console.log(`Model: ${response.model}`);
    console.log(`Response: ${response.content}`);
    console.log(`Latency: ${response.latencyMs}ms`);
    if (response.usage) {
      console.log(`Tokens: ${response.usage.totalTokens}`);
    }
    console.log();
  } catch (error) {
    console.error('Claude Code test failed:', error);
    console.log();
  } finally {
    gateway.setStrategy(previousStrategy);
  }
}

async function testTranslation() {
  console.log('=== Translation Test (subscription providers) ===\n');

  try {
    const translation = await gateway.translate({
      text: 'The quick brown fox jumps over the lazy dog.',
      to: 'ja',
    });

    console.log(`Original: The quick brown fox jumps over the lazy dog.`);
    console.log(`Japanese: ${translation}`);
    console.log();
  } catch (error) {
    console.error('Translation failed:', error);
    console.log();
  }
}

async function testStrategyComparison() {
  console.log('=== Strategy Comparison ===\n');

  const strategies = ['subscription-only', 'fastest', 'cheapest', 'quality'] as const;
  const prompt = 'Say "hello" in three languages.';

  for (const strategy of strategies) {
    try {
      gateway.setStrategy(strategy);
      console.log(`Strategy: ${strategy}`);

      const response = await gateway.complete({
        messages: [{ role: 'user', content: prompt }],
      });

      console.log(`  → ${response.provider}/${response.model} (${response.latencyMs}ms)`);
    } catch (error) {
      console.log(`  → Failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  console.log();
}

async function main() {
  console.log('Testing subscription-based providers for unified-llm\n');
  console.log('This tests providers that use existing subscriptions');
  console.log('instead of pay-per-token API billing.\n');
  console.log('─'.repeat(50));
  console.log();

  await testProviderStatus();
  await testGLMProvider();
  await testClaudeCodeProvider();
  await testTranslation();
  await testStrategyComparison();

  console.log('─'.repeat(50));
  console.log('Done!');
}

main().catch(console.error);
