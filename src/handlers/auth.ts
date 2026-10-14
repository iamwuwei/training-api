import type { LambdaFunctionURLHandler } from "aws-lambda";
import { AuthError, signSession, userIdFromEvent, verifyAppleIdToken } from "../lib/auth";
import { query, queryOne } from "../lib/db";
import type { UserRow } from "../types";
import type { AppleLoginRequest, ErrorResponse, LoginResponse, MeResponse } from "../../types/api";

// POST /apple  { id_token }  -> { token, expires_at, user }
// GET  /me     Bearer        -> { user }
//
// Closed system: a login succeeds only for a users row that already carries
// this Apple `sub`, or (first login) whose email equals the Apple ID email.

const json = <T extends LoginResponse | MeResponse | ErrorResponse>(statusCode: number, body: T) => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

export const handler: LambdaFunctionURLHandler = async (event) => {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  try {
    if (method === "POST" && path === "/apple") {
      const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? "";
      let body: AppleLoginRequest;
      try {
        body = JSON.parse(raw) as AppleLoginRequest;
      } catch {
        return json(400, { error: "invalid json" });
      }
      if (!body.id_token) return json(400, { error: "missing id_token" });

      const identity = await verifyAppleIdToken(body.id_token);

      let user = await queryOne<UserRow>("select * from users where apple_sub = $1", [identity.sub]);
      if (!user && identity.email) {
        user = await queryOne<UserRow>("select * from users where apple_sub is null and lower(email) = lower($1)", [identity.email]);
        if (user) await query("update users set apple_sub = $2 where id = $1", [user.id, identity.sub]);
      }
      if (!user) {
        console.log(`apple login rejected: sub=${identity.sub} email=${identity.email ?? "-"}`);
        return json(403, { error: "not registered" });
      }

      const { token, expiresAt } = signSession(user.id);
      return json<LoginResponse>(200, {
        token,
        expires_at: expiresAt.toISOString(),
        user: { id: user.id, display_name: user.display_name },
      });
    }

    if (method === "GET" && path === "/me") {
      const userId = userIdFromEvent(event);
      if (!userId) return json(401, { error: "unauthorized" });
      const user = await queryOne<UserRow>("select * from users where id = $1", [userId]);
      if (!user) return json(401, { error: "unauthorized" });
      return json<MeResponse>(200, { user: { id: user.id, display_name: user.display_name } });
    }

    return json(404, { error: "not found" });
  } catch (err) {
    if (err instanceof AuthError) return json(err.status, { error: err.message });
    throw err;
  }
};
