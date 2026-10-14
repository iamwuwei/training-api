import type { StravaActivity, StravaTokenResponse } from "../types";

const API = "https://www.strava.com/api/v3";
const OAUTH_TOKEN = "https://www.strava.com/oauth/token";

export class StravaError extends Error {
  constructor(public status: number, message: string) {
    super(`Strava ${status}: ${message}`);
  }
}

function clientCreds() {
  const id = process.env.STRAVA_CLIENT_ID;
  const secret = process.env.STRAVA_CLIENT_SECRET;
  if (!id || !secret) throw new Error("missing STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET");
  return { client_id: id, client_secret: secret };
}

async function tokenRequest(body: Record<string, string>): Promise<StravaTokenResponse> {
  const res = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...clientCreds(), ...body }),
  });
  if (!res.ok) throw new StravaError(res.status, await res.text());
  return (await res.json()) as StravaTokenResponse;
}

/** OAuth callback: exchange the authorization code for tokens. */
export function exchangeCode(code: string): Promise<StravaTokenResponse> {
  return tokenRequest({ code, grant_type: "authorization_code" });
}

/** Refresh an expired access token. Strava may rotate the refresh token too. */
export function refreshToken(refresh_token: string): Promise<StravaTokenResponse> {
  return tokenRequest({ refresh_token, grant_type: "refresh_token" });
}

export function authorizeUrl(opts: { redirectUri: string; state: string }): string {
  const { client_id } = clientCreds();
  const q = new URLSearchParams({
    client_id,
    response_type: "code",
    redirect_uri: opts.redirectUri,
    approval_prompt: "auto",
    scope: "activity:read_all",
    state: opts.state,
  });
  return `https://www.strava.com/oauth/authorize?${q}`;
}

async function get<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new StravaError(res.status, await res.text());
  return (await res.json()) as T;
}

/** GET /activities/{id} — DetailedActivity, includes splits_metric. */
export function getActivity(accessToken: string, id: number | string): Promise<StravaActivity> {
  return get<StravaActivity>(accessToken, `/activities/${id}`);
}

/** GET /athlete/activities — SummaryActivity[] (no splits). */
export function getActivities(
  accessToken: string,
  opts: { after?: number; before?: number; page?: number; per_page?: number } = {},
): Promise<StravaActivity[]> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) if (v !== undefined) q.set(k, String(v));
  const qs = q.toString();
  return get<StravaActivity[]>(accessToken, `/athlete/activities${qs ? `?${qs}` : ""}`);
}
