import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { query, queryOne } from "../lib/db";
import { authorizeUrl, exchangeCode } from "../lib/strava";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const html = (statusCode: number, body: string) => ({
  statusCode,
  headers: { "content-type": "text/html; charset=utf-8" },
  body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;padding:2rem;text-align:center;font-size:1.25rem">${body}</body>`,
});

// Routes /strava/oauth/start and /strava/oauth/callback on the HTTP API (no
// authorizer). The redirect_uri is derived from the request so it follows the
// API's domain (custom domain or execute-api) without configuration.
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const path = event.rawPath;
  const q = event.queryStringParameters ?? {};

  if (path.endsWith("/start")) {
    const user = q.user ?? "";
    if (!UUID_RE.test(user)) return html(400, "缺少或無效的 user 參數");
    const redirectUri = `https://${event.requestContext.domainName}${path.replace(/\/start$/, "/callback")}`;
    return {
      statusCode: 302,
      headers: { location: authorizeUrl({ redirectUri, state: user }) },
      body: "",
    };
  }

  if (path.endsWith("/callback")) {
    if (q.error) return html(400, `Strava 授權失敗：${q.error}`);
    const userId = q.state ?? "";
    if (!UUID_RE.test(userId) || !q.code) return html(400, "callback 參數不完整");

    const user = await queryOne<{ id: string; display_name: string }>(
      "select id, display_name from users where id = $1",
      [userId],
    );
    if (!user) return html(404, "找不到這個使用者");

    const token = await exchangeCode(q.code);
    if (!token.athlete?.id) return html(502, "Strava 沒有回傳 athlete id");

    await query(
      `insert into strava_connections (user_id, strava_athlete_id, access_token, refresh_token, expires_at, scope)
       values ($1, $2, $3, $4, to_timestamp($5), $6)
       on conflict (user_id) do update set
         strava_athlete_id = excluded.strava_athlete_id,
         access_token      = excluded.access_token,
         refresh_token     = excluded.refresh_token,
         expires_at        = excluded.expires_at,
         scope             = excluded.scope`,
      [userId, token.athlete.id, token.access_token, token.refresh_token, token.expires_at, q.scope ?? "activity:read_all"],
    );

    return html(200, `設定完成 ✓<br><small>${user.display_name} ↔ Strava athlete ${token.athlete.id}</small>`);
  }

  return html(404, "not found");
};
