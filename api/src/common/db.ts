import { Pool, PoolClient, QueryResultRow } from 'pg';
import { config } from './config';

export const pool = new Pool({ connectionString: config.databaseUrl, max: 20 });

// numeric → number (prices are numeric(12,2); safe within JS double precision for money at this scale)
import { types } from 'pg';
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // bigint counts

export type Db = Pool | PoolClient;

export async function q<T extends QueryResultRow = any>(sql: string, params: any[] = [], db: Db = pool): Promise<T[]> {
  const res = await db.query<T>(sql, params);
  return res.rows;
}

export async function one<T extends QueryResultRow = any>(sql: string, params: any[] = [], db: Db = pool): Promise<T | null> {
  const rows = await q<T>(sql, params, db);
  return rows[0] ?? null;
}

/**
 * Run fn inside a transaction. Retries automatically on serialization failures / deadlocks,
 * which can occur when concurrent orders touch the same inventory rows.
 */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const retryable = err?.code === '40001' || err?.code === '40P01';
      if (retryable && attempt < retries) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}
