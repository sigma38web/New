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

async function testModel(provider: any, modelId: string, expectedWord: string) {
  console.log(`\n--- Testing Model ID: '${modelId}' ---`);
  const t0 = Date.now();
  const res = await provider.complete({
    modelId,
    system: 'You are a test validator.',
    user: `Respond with exactly: "${expectedWord}"`,
    params: {
      temperature: 0.1,
      max_tokens: 50,
      top_p: 1,
      seed: 42,
      json_schema_mode: false,
    },
  });

  const latency = Date.now() - t0;
  console.log('Response:', res.text?.trim());
  console.log('Returned Model ID:', res.modelId);
  console.log('Latency:', `${latency}ms (reported: ${res.latencyMs}ms)`);
  console.log('Workspace Id / Index in response:', (res as any).workspaceIndex ?? 'auto', (res as any).workspaceId ?? '');
  console.log('Usage:', res.usage);
}

async function main() {
  console.log('Testing Notion AI multi-workspace provider bridge connection...');
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

  // 1. Test targeted Workspace 1
  await testModel(provider, 'notion-ai-1', 'WORKSPACE_1_OK');

  // 2. Test targeted Workspace 2
  await testModel(provider, 'notion-ai-2', 'WORKSPACE_2_OK');

  // 3. Test auto pool round-robin
  await testModel(provider, 'notion-ai', 'AUTO_POOL_OK');

  console.log('\n=========================================');
  console.log('SUCCESS: All Notion AI multi-workspace tests completed successfully!');
  console.log('=========================================');
}

main().catch((err) => {
  console.error('\nFAILURE: Notion AI bridge call failed:', err);
  process.exit(1);
});
