import "dotenv/config";

// Registers the webhook Function URL with Strava (one subscription per app).
// Usage: npm run subscribe-webhook [-- <webhook function url>]
//        (or set WEBHOOK_URL in .env)

const API = "https://www.strava.com/api/v3/push_subscriptions";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name} in .env`);
  return v;
}

async function main() {
  const client_id = need("STRAVA_CLIENT_ID");
  const client_secret = need("STRAVA_CLIENT_SECRET");
  const verify_token = need("STRAVA_VERIFY_TOKEN");
  const callback_url = process.argv[2] ?? process.env.WEBHOOK_URL;
  if (!callback_url) throw new Error("pass the webhook URL as an argument or set WEBHOOK_URL");

  const existing = await fetch(`${API}?${new URLSearchParams({ client_id, client_secret })}`);
  if (!existing.ok) throw new Error(`GET push_subscriptions ${existing.status}: ${await existing.text()}`);
  const subs = (await existing.json()) as { id: number; callback_url: string }[];
  if (subs.length > 0) {
    console.log("existing subscription, skipping:", subs);
    return;
  }

  // Strava will GET callback_url?hub.mode=subscribe&hub.verify_token=…&hub.challenge=… during this call.
  const res = await fetch(API, {
    method: "POST",
    body: new URLSearchParams({ client_id, client_secret, callback_url, verify_token }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST push_subscriptions ${res.status}: ${text}`);
  console.log("subscribed:", text);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
