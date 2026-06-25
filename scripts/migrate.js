const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { query } = require('../db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function runMigrations() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not configured. Ensure .env exists in project root.');
    process.exit(1);
  }
  console.log('Connecting to database...');

  // Create migrations tracking table if not exists
  await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) UNIQUE NOT NULL,
      executed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const name = file.replace('.sql', '');
    const { rows } = await query('SELECT 1 FROM _migrations WHERE name = $1', [name]);
    if (rows.length > 0) {
      console.log(`Skip (already run): ${file}`);
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await query(sql);
    await query('INSERT INTO _migrations (name) VALUES ($1)', [name]);
    console.log(`Run: ${file}`);
  }

  console.log('Migrations done.');
}

runMigrations().catch((err) => {
  console.error(err);
  process.exit(1);
});
