import tls from "node:tls";
import { Pool, type QueryResultRow } from "pg";
import { SUPABASE_CA } from "./supabase-ca";

// Postgres on Supabase, reached through DATABASE_URL: the project's pooler URL
// (…pooler.supabase.com:6543, transaction mode). Lambda is IPv4-only and the
// direct host is IPv6-only, so always the pooler. Password lives in the URL;
// TLS is verified against Supabase's own chain (supabase-ca.ts) plus Node's
// public roots. DB_SSL_CA (PEM text) overrides the compiled-in chain.

let pool: Pool | undefined;

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`missing env ${name}`);
  return v;
}

function getPool(): Pool {
  if (pool) return pool;
  pool = new Pool({
    connectionString: env("DATABASE_URL"),
    ssl: { ca: [process.env.DB_SSL_CA ?? SUPABASE_CA, ...tls.rootCertificates], rejectUnauthorized: true },
    max: 2,
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 20_000),
    idleTimeoutMillis: 60_000,
  });
  pool.on("error", (err) => console.error("pg pool error", err));
  return pool;
}

/** Run one query, return rows. Throws on connection failure (callers rely on that for SQS retry). */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await getPool().query<T>(text, params);
  return res.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(text, params);
  return rows[0];
}

/** For scripts: close the pool so the process can exit. */
export async function end(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}

/**
 * True for a connection-level failure (timeout, refused, reset) as opposed to a
 * query error. Callers answer 503 / retry once on these; a paused Supabase
 * project (free tier, after a week idle) looks like this until it resumes.
 */
export function isDbWaking(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /connection timeout|timeout expired|ECONNREFUSED|ECONNRESET/i.test(msg);
}
