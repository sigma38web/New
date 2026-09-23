import { existsSync } from 'node:fs';
import { resolveProvidersFromEnv } from '../packages/gateway/src/provider-mode.js';

// Auto-load .env or .env.example if present in Node 20+
if (typeof process.loadEnvFile === 'function') {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  } else if (existsSync('.env.example')) {
    process.loadEnvFile('.env.example');
  }
}

async function main() {
  console.log('Testing Notion AI provider bridge connection...');
  const url = process.env.YEONJAE_NOTION_URL || 'https://archivedb.duckdns.org/notion/v1/complete';
  console.log('YEONJAE_NOTION_URL:', url);

  const resolved = resolveProvidersFromEnv({
    ...process.env,
    YEONJAE_PROVIDER_MODE: 'notion',
    YEONJAE_NOTION_URL: url,
  });
  const provider = resolved.providers().get('notion');
  if (!provider) {
    throw new Error("Provider 'notion' not found in resolved providers!");
  }

  console.log('Sending test prompt to Notion AI...');

  const res = await provider.complete({
    modelId: 'notion-ai',
    system: 'You are a test validator.',
    user: 'Respond with exactly: "NOTION_AI_OK"',
    params: {
      temperature: 0.1,
      max_tokens: 50,
      top_p: 1,
      seed: 42,
      json_schema_mode: false,
    },
  });

  console.log('--- Result ---');
  console.log('Response:', res.text?.trim());
  console.log('Model ID:', res.modelId);
  console.log('Latency:', `${res.latencyMs}ms`);
  console.log('Usage:', res.usage);
  console.log('SUCCESS: Notion AI bridge call completed successfully!');
}

main().catch((err) => {
  console.error('FAILURE: Notion AI bridge call failed:', err);
  process.exit(1);
});
