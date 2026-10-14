import fs from "node:fs";
import path from "node:path";
import { Signer } from "@aws-sdk/rds-signer";
import { Pool, type QueryResultRow } from "pg";

// IAM auth tokens are valid for 15 minutes. Rebuild the pool a bit before that
// so a warm Lambda never tries to open a new connection with a stale token.
const TOKEN_TTL_MS = 13 * 60 * 1000;

let pool: Pool | undefined;
let poolCreatedAt = 0;

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`missing env ${name}`);
  return v;
}

// Bundled next to the handler by CDK (commandHooks.afterBundling); when run
// via tsx from the repo this resolves to src/lib/global-bundle.pem.
const CA = fs.readFileSync(path.join(__dirname, "global-bundle.pem"));

async function getPool(): Promise<Pool> {
  if (pool && Date.now() - poolCreatedAt < TOKEN_TTL_MS) return pool;

  if (pool) {
    const old = pool;
    pool = undefined;
    old.end().catch(() => {});
  }

  const hostname = env("DB_HOST");
  const port = Number(env("DB_PORT", "5432"));
  const username = env("DB_USER", "postgres");
  const region = env("AWS_REGION", "ap-northeast-1");

  const signer = new Signer({ hostname, port, username, region });
  const token = await signer.getAuthToken();

  pool = new Pool({
    host: hostname,
    port,
    user: username,
    database: env("DB_NAME", "postgres"),
    password: token,
    ssl: { ca: CA, rejectUnauthorized: true },
    max: 2,
    // Aurora Serverless v2 at 0 ACU takes ~10-15 s to wake up.
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 60_000,
  });
  pool.on("error", (err) => console.error("pg pool error", err));
  poolCreatedAt = Date.now();
  return pool;
}

/** Run one query, return rows. Throws on connection failure (callers rely on that for SQS retry). */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const p = await getPool();
  const res = await p.query<T>(text, params);
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
