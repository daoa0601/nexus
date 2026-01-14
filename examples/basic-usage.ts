/**
 * Basic usage example for unified-llm
 */

import { LLMGateway } from '../src/index.ts';

// Initialize with multiple providers
const gateway = new LLMGateway({
  providers: {
    // OpenAI (uses OPENAI_API_KEY env var)
    openai: {},

    // Ollama (local server) - pull with: ollama pull qwen2.5:7b
    ollama: {
      baseUrl: 'http://localhost:11434',
      preloadModels: ['qwen2.5:7b'],
    },

    // Anthropic (uses ANTHROPIC_API_KEY env var)
    anthropic: {},

    // Gemini (uses GEMINI_API_KEY env var)
    gemini: {},
  },

  // Use fastest available provider
  strategy: 'fastest',

  // Enable caching
  cache: {
    enabled: true,
    adapter: 'memory',
    ttlMs: 3600000, // 1 hour
    maxSize: 1000,
  },
});

async function main() {
  // Check provider status
  console.log('Checking provider status...');
  const status = await gateway.status();
  console.log('Provider status:', JSON.stringify(status, null, 2));

  // Simple completion
  console.log('\n--- Simple Completion ---');
  try {
    const response = await gateway.complete({
      messages: [{ role: 'user', content: 'What is 2 + 2?' }],
    });
    console.log(`Response (${response.provider}/${response.model}): ${response.content}`);
    console.log(`Latency: ${response.latencyMs}ms, Cached: ${response.cached}`);
  } catch (error) {
    console.error('Completion failed:', error);
  }

  // Translation
  console.log('\n--- Translation ---');
  try {
    const translation = await gateway.translate({
      text: 'Hello, how are you?',
      to: 'ja',
    });
    console.log(`Translation: ${translation}`);
  } catch (error) {
    console.error('Translation failed:', error);
  }

  // Text generation
  console.log('\n--- Generation ---');
  try {
    const generated = await gateway.generate({
      prompt: 'Write a haiku about programming',
      temperature: 0.8,
    });
    console.log(`Generated:\n${generated}`);
  } catch (error) {
    console.error('Generation failed:', error);
  }

  // Grammar explanation (for language learning apps)
  console.log('\n--- Grammar Explanation ---');
  try {
    const explanation = await gateway.explain({
      pattern: '〜てもいい',
      sentence: '食べてもいいですか？',
      language: 'Japanese',
    });
    console.log(`Explanation:\n${explanation}`);
  } catch (error) {
    console.error('Explanation failed:', error);
  }
}

main().catch(console.error);
