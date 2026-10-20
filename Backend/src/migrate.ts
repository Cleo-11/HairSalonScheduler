import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// src/ (run with tsx) and dist/src/ (compiled) sit at different depths below the project root.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = [path.resolve(HERE, '../migrations'), path.resolve(HERE, '../../migrations')].find(existsSync)
  ?? path.resolve(HERE, '../migrations');

/**
 * Applies every migrations/*.sql file not yet recorded in schema_migrations,
 * in filename order, each in its own transaction. Forward-only by design:
 * to change the schema, add a new numbered file.
 */
export async function migrate(connectionString: string, opts: { reset?: boolean; log?: (m: string) => void } = {}) {
  const log = opts.log ?? (() => {});
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    if (opts.reset) {
      log('Dropping schema public');
      await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    }
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`Applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}
