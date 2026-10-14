import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import type { LambdaFunctionURLEvent } from "aws-lambda";

// Sign in with Apple (web): the front-end gets an identity token (JWT) from
// Apple's JS SDK and posts it to the auth Lambda. We verify it against Apple's
// JWKS, then issue our own stateless HMAC session token.

const APPLE_ISS = "https://appleid.apple.com";
const APPLE_JWKS = "https://appleid.apple.com/auth/keys";
const SESSION_TTL_SEC = 30 * 24 * 3600;

interface Jwk { kid: string; kty: string; alg: string; n: string; e: string; use: string }

let jwksCache: { keys: Jwk[]; fetchedAt: number } | undefined;

async function appleKeys(forceRefresh = false): Promise<Jwk[]> {
  if (!forceRefresh && jwksCache && Date.now() - jwksCache.fetchedAt < 6 * 3600 * 1000) return jwksCache.keys;
  const res = await fetch(APPLE_JWKS);
  if (!res.ok) throw new Error(`apple jwks ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  jwksCache = { keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

const b64url = (buf: Buffer) => buf.toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url");

export interface AppleIdentity {
  sub: string;
  email?: string;
  email_verified?: boolean;
}

export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Verify an Apple identity token: RS256 signature, iss, aud (APPLE_CLIENT_ID), exp. */
export async function verifyAppleIdToken(idToken: string): Promise<AppleIdentity> {
  const audience = process.env.APPLE_CLIENT_ID;
  if (!audience) throw new Error("missing APPLE_CLIENT_ID");

  const parts = idToken.split(".");
  if (parts.length !== 3) throw new AuthError(401, "malformed id_token");
  const [h, p, s] = parts;
  const header = JSON.parse(fromB64url(h).toString("utf8")) as { kid?: string; alg?: string };
  const payload = JSON.parse(fromB64url(p).toString("utf8")) as {
    iss?: string; aud?: string | string[]; exp?: number; sub?: string; email?: string;
    email_verified?: boolean | string;
  };
  if (header.alg !== "RS256" || !header.kid) throw new AuthError(401, "unsupported id_token");

  let key = (await appleKeys()).find((k) => k.kid === header.kid);
  if (!key) key = (await appleKeys(true)).find((k) => k.kid === header.kid);
  if (!key) throw new AuthError(401, "unknown apple key id");

  const publicKey = createPublicKey({ key: { kty: key.kty, n: key.n, e: key.e }, format: "jwk" });
  const ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, fromB64url(s));
  if (!ok) throw new AuthError(401, "bad id_token signature");

  if (payload.iss !== APPLE_ISS) throw new AuthError(401, "bad issuer");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(audience)) throw new AuthError(401, "bad audience");
  if (!payload.exp || payload.exp * 1000 < Date.now()) throw new AuthError(401, "id_token expired");
  if (!payload.sub) throw new AuthError(401, "no sub");

  return {
    sub: payload.sub,
    email: payload.email,
    email_verified: payload.email_verified === true || payload.email_verified === "true",
  };
}

// ---- our session token: base64url(json).base64url(hmac) ------------------------

function secret(): Buffer {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("missing SESSION_SECRET");
  return Buffer.from(s, "utf8");
}

export function signSession(userId: string, ttlSec = SESSION_TTL_SEC): { token: string; expiresAt: Date } {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const body = b64url(Buffer.from(JSON.stringify({ u: userId, e: exp })));
  const sig = b64url(createHmac("sha256", secret()).update(body).digest());
  return { token: `${body}.${sig}`, expiresAt: new Date(exp * 1000) };
}

export function verifySession(token: string): string | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret()).update(body).digest();
  const given = fromB64url(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { u, e } = JSON.parse(fromB64url(body).toString("utf8")) as { u?: string; e?: number };
    if (!u || !e || e * 1000 < Date.now()) return null;
    return u;
  } catch {
    return null;
  }
}

/** user id from `Authorization: Bearer <session token>`, or null. */
export function userIdFromEvent(event: LambdaFunctionURLEvent): string | null {
  const auth = event.headers.authorization ?? event.headers.Authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? verifySession(m[1].trim()) : null;
}
