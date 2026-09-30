// Applies one or more SQL files to the database in DATABASE_URL, all inside a
// single transaction. Dry run by default: everything is executed and then
// ROLLED BACK, so you see any error without changing anything. Pass
// --commit to keep the changes.
//
// After running, prints which public functions the API roles (anon /
// authenticated) can execute — only fn_login should be anon-callable.
//
// Usage:
//   node scripts/applySql.js sql/025_security_lockdown.sql sql/026_event_safety_fixes.sql
//   node scripts/applySql.js --commit sql/025_security_lockdown.sql sql/026_event_safety_fixes.sql
import 'dotenv/config';
import fs from 'node:fs';
import pg from 'pg';

const args = process.argv.slice(2);
const commit = args.includes('--commit');
const files = args.filter((a) => a !== '--commit');

if (files.length === 0) {
  console.error('Usage: node scripts/applySql.js [--commit] <file.sql> [...]');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query('begin');

try {
  for (const file of files) {
    await client.query(fs.readFileSync(file, 'utf8'));
    console.log(`ok  ${file}`);
  }

  const { rows } = await client.query(`
    select p.proname as fn,
           has_function_privilege('anon', p.oid, 'execute') as anon,
           has_function_privilege('authenticated', p.oid, 'execute') as authenticated
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'fn\\_%'
    order by 1`);
  const anonFns = rows.filter((r) => r.anon).map((r) => r.fn);
  console.log(`\nanon-callable functions: ${anonFns.join(', ') || '(none)'}`);
  if (anonFns.some((f) => f !== 'fn_login')) {
    console.warn('WARNING: something other than fn_login is callable without logging in.');
  }
} catch (err) {
  await client.query('rollback');
  await client.end();
  console.error(`\nFAILED — nothing was changed.\n${err.message}${err.where ? `\n${err.where}` : ''}`);
  process.exit(1);
}

await client.query(commit ? 'commit' : 'rollback');
await client.end();
console.log(commit ? '\nCOMMITTED.' : '\nDry run only — rolled back. Re-run with --commit to apply.');
