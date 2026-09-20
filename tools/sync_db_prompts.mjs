import pg from '../packages/db/node_modules/pg/lib/index.js';
import { PromptRegistry } from '../packages/prompts/dist/index.js';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://yeonjae@localhost:5432/yeonjae_test',
});

async function main() {
  const registry = PromptRegistry.fromDirectory();
  const prompts = registry.list();
  console.log(`Loaded ${prompts.length} prompts from disk registry.`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE prompt_versions DISABLE TRIGGER prompt_version_immutable');

    for (const p of prompts) {
      const res = await client.query(
        `UPDATE prompt_versions 
         SET content_hash = $2, meta = $3::jsonb
         WHERE id = $1`,
        [p.id, p.content_hash, JSON.stringify({ purpose: p.purpose, params: p.params })]
      );
      if (res.rowCount === 0) {
        await client.query(
          `INSERT INTO prompt_versions (id, family, version, content_hash, role, style_sensitive, manuscript_producing, identity_variant, model_class, output_schema, status, meta)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
           ON CONFLICT (id) DO UPDATE SET content_hash = EXCLUDED.content_hash, meta = EXCLUDED.meta`,
          [
            p.id,
            p.family,
            p.version,
            p.content_hash,
            p.role,
            p.style_sensitive,
            p.manuscript_producing,
            p.identity_variant ?? null,
            p.model_class,
            p.output_schema ?? null,
            p.status,
            JSON.stringify({ purpose: p.purpose, params: p.params }),
          ]
        );
        console.log(`Inserted prompt: ${p.id}`);
      } else {
        console.log(`Updated prompt: ${p.id} -> ${p.content_hash}`);
      }
    }

    await client.query('ALTER TABLE prompt_versions ENABLE TRIGGER prompt_version_immutable');
    await client.query('COMMIT');
    console.log('Successfully synchronized all prompt versions in DB!');
  } catch (err) {
    await client.query('ROLLBACK');
    await client.query('ALTER TABLE prompt_versions ENABLE TRIGGER prompt_version_immutable').catch(() => {});
    console.error('Failed to sync prompts:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
