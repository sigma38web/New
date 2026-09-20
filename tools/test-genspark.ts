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
  console.log('Testing Genspark provider bridge connection...');
  console.log('YEONJAE_PROVIDER_MODE:', process.env.YEONJAE_PROVIDER_MODE);
  console.log('YEONJAE_GENSPARK_URL:', process.env.YEONJAE_GENSPARK_URL);

  const resolved = resolveProvidersFromEnv(process.env);
  const provider = resolved.providers().get('genspark');
  if (!provider) {
    throw new Error("Provider 'genspark' not found in resolved providers!");
  }

  const modelId = process.env.YEONJAE_MODEL_DEFAULT ?? 'gemini-3.8-flash';
  console.log(`Sending test prompt to model: ${modelId}...`);

  const res = await provider.complete({
    modelId,
    system: 'You are a test validator.',
    user: 'Respond with exactly: "GENSPARK_OK"',
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
  console.log('SUCCESS: Genspark bridge call completed successfully!');
}

main().catch((err) => {
  console.error('FAILURE: Genspark bridge call failed:', err);
  process.exit(1);
});
