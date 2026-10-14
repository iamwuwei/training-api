import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import type { StravaWebhookEvent } from "../types";

// Route /strava/webhook on the HTTP API (no authorizer; Strava calls it).
// Strava requires a 2xx within 2 seconds: no DB, no Strava calls here.
// Everything goes to SQS and the worker does the work.

const sqs = new SQSClient({});

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const method = event.requestContext.http.method;

  if (method === "GET") {
    const q = event.queryStringParameters ?? {};
    if (q["hub.mode"] !== "subscribe" || q["hub.verify_token"] !== process.env.STRAVA_VERIFY_TOKEN) {
      return json(403, { error: "verify_token mismatch" });
    }
    return json(200, { "hub.challenge": q["hub.challenge"] ?? "" });
  }

  if (method !== "POST") return json(405, { error: "method not allowed" });

  let body: StravaWebhookEvent;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? "";
    body = JSON.parse(raw) as StravaWebhookEvent;
  } catch {
    return json(400, { error: "invalid json" });
  }

  if (body.object_type !== "activity" || (body.aspect_type !== "create" && body.aspect_type !== "update")) {
    return json(200, { ignored: true });
  }

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: process.env.QUEUE_URL,
      MessageBody: JSON.stringify(body),
    }),
  );
  return json(200, { queued: true });
};
