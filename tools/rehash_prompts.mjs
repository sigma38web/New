import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash } from '../packages/prompts/dist/index.js';

const familiesDir = join(process.cwd(), 'packages/prompts/families');
let updatedCount = 0;

for (const family of readdirSync(familiesDir)) {
  const familyPath = join(familiesDir, family);
  if (!statSync(familyPath).isDirectory()) continue;
  for (const version of readdirSync(familyPath)) {
    const versionPath = join(familyPath, version);
    if (!statSync(versionPath).isDirectory()) continue;
    const promptJsonPath = join(versionPath, 'prompt.json');
    const systemMdPath = join(versionPath, 'system.md');
    const userMdPath = join(versionPath, 'user.md');

    try {
      const meta = JSON.parse(readFileSync(promptJsonPath, 'utf-8'));
      const system = readFileSync(systemMdPath, 'utf-8');
      const user = readFileSync(userMdPath, 'utf-8');
      const hash = contentHash(meta, system, user);

      if (meta.content_hash !== hash) {
        meta.content_hash = hash;
        writeFileSync(promptJsonPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
        console.log(`Updated hash for ${family}/${version}: ${hash}`);
        updatedCount++;
      }
    } catch (err) {
      console.error(`Error processing ${family}/${version}:`, err.message);
    }
  }
}

console.log(`Rehash complete. ${updatedCount} prompt(s) updated.`);
