import pg from 'pg';
import { config } from '../config.js';

// Supabase's pooled connection endpoint requires SSL; the Node pg driver needs
// this set explicitly (it does not read it from the connection string).
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.nodeEnv === 'production' ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

pool.on('error', (err) => {
  // a background/idle client error should never crash the process
  console.error('Unexpected error on idle PG client', err);
});

/**
 * Run `fn` with a client inside a single transaction. Commits on success,
 * rolls back on any thrown error. Every route that calls one of the SQL
 * functions in 005_functions.sql should go through this, even though most of
 * those functions are internally atomic — this also gives us `SELECT ... FOR
 * UPDATE` semantics and a single round trip per request.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
