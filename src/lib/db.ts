import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { Signer } from "@aws-sdk/rds-signer";
import { Pool, type QueryResultRow } from "pg";

// Two ways to reach Postgres, picked by the environment:
//   DATABASE_URL          Supabase (or any Postgres) with a password in the URL.
//                         Use Supabase's pooler URL (port 6543, transaction mode)
//                         from Lambda: the direct host is IPv6-only.
//   DB_HOST + IAM auth    Aurora, token signed with the Lambda's own credentials
//                         (the original setup; kept until the move is finished).

const IAM_TOKEN_TTL_MS = 13 * 60 * 1000; // tokens last 15 min; rebuild the pool before that

let pool: Pool | undefined;
let poolCreatedAt = 0;

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`missing env ${name}`);
  return v;
}

export type DbConfig =
  | { kind: "url"; url: string }
  | { kind: "iam"; host: string; port: number; user: string; database: string; region: string };

/** The configuration the environment describes (DATABASE_URL wins). */
export function dbConfigFromEnv(): DbConfig {
  const url = process.env.DATABASE_URL;
  if (url) return { kind: "url", url };
  return {
    kind: "iam",
    host: env("DB_HOST"),
    port: Number(env("DB_PORT", "5432")),
    user: env("DB_USER", "postgres"),
    database: env("DB_NAME", "postgres"),
    region: env("AWS_REGION", "ap-northeast-1"),
  };
}

// Trust stores. Both databases present chains that end in their own root, so
// each gets its CA bundle (copied next to the handler by CDK's
// commandHooks.afterBundling; read from src/lib/ under tsx) plus Node's public
// roots. Aurora: the RDS global bundle. Supabase: `supabase-ca.pem`, downloaded
// from Project Settings → Database → SSL Configuration ("prod-ca-2021.crt");
// DB_SSL_CA (PEM text) overrides the file, e.g. for a one-off script.
function trustStore(file: string, envName?: string): string[] {
  const fromEnv = envName ? process.env[envName] : undefined;
  const p = path.join(__dirname, file);
  const own = fromEnv ? [fromEnv] : fs.existsSync(p) ? [fs.readFileSync(p, "utf8")] : [];
  if (!own.length) console.warn(`${file} not found: relying on Node's public roots only`);
  return [...own, ...tls.rootCertificates];
}

const common = {
  max: 2,
  // Aurora Serverless v2 at 0 ACU can take 15-30 s to wake up. API Gateway
  // (HTTP API) cuts the request at 30 s, so the api Lambda gives up earlier
  // and answers 503 (see isDbWaking); SQS/scheduler callers get the full 30 s.
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 30_000),
  idleTimeoutMillis: 60_000,
};

/** A pool for `config`; scripts that talk to two databases build their own. */
export async function makePool(config: DbConfig): Promise<Pool> {
  if (config.kind === "url") {
    return new Pool({ connectionString: config.url, ssl: { ca: trustStore("supabase-ca.pem", "DB_SSL_CA"), rejectUnauthorized: true }, ...common });
  }
  const signer = new Signer({ hostname: config.host, port: config.port, username: config.user, region: config.region });
  const token = await signer.getAuthToken();
  if (process.env.DB_DEBUG === "true") {
    // Token = "<host>:<port>/?Action=connect&DBUser=…&X-Amz-…". Log everything
    // but the signature so a Lambda token can be compared with a local one.
    const u = new URL(`https://${token}`);
    const q = Object.fromEntries(u.searchParams);
    console.log("db auth token", JSON.stringify({
      host: u.host, DBUser: q.DBUser, region: config.region, credential: q["X-Amz-Credential"],
      expires: q["X-Amz-Expires"], signedHeaders: q["X-Amz-SignedHeaders"],
      hasSessionToken: Boolean(q["X-Amz-Security-Token"]),
      keyPrefix: process.env.AWS_ACCESS_KEY_ID?.slice(0, 4), node: process.version,
    }));
  }
  return new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    database: config.database,
    password: token,
    ssl: { ca: trustStore("global-bundle.pem"), rejectUnauthorized: true },
    ...common,
  });
}

async function getPool(): Promise<Pool> {
  const config = dbConfigFromEnv();
  const fresh = config.kind === "url" || Date.now() - poolCreatedAt < IAM_TOKEN_TTL_MS;
  if (pool && fresh) return pool;

  if (pool) {
    const old = pool;
    pool = undefined;
    old.end().catch(() => {});
  }
  pool = await makePool(config);
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

/** True for the connection-timeout error pg throws while Aurora is resuming from 0 ACU. */
export function isDbWaking(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /connection timeout|timeout expired|ECONNREFUSED|ECONNRESET/i.test(msg);
}
