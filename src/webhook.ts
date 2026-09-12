import { createHmac, timingSafeEqual } from "node:crypto";

/** Protocol: https://www.ambiguous.ai/agents/recipes. No body parsing before HMAC. */
export function verifyWebhook(input: {
  rawBody: Buffer; timestamp: string | undefined; signature: string | undefined;
  secret: string; now?: Date;
}): boolean {
  const { timestamp, signature, secret, rawBody } = input;
  if (!secret || !timestamp || !/^\d+$/.test(timestamp) || !signature) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs((input.now ?? new Date()).getTime() / 1000 - seconds) > 300) return false;
  const hex = signature.replace(/^sha256=/, "");
  if (!/^[a-fA-F0-9]{64}$/.test(hex)) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(hex, "hex"));
}

/** Only envelope is documented; Alex must normalize data from a real delivery. */
export type WebhookEnvelope = { event: string; data: unknown };
export function parseEnvelope(rawBody: Buffer): WebhookEnvelope {
  const value: unknown = JSON.parse(rawBody.toString("utf8"));
  if (!value || typeof value !== "object" || !("event" in value) ||
      typeof value.event !== "string" || !("data" in value)) throw new Error("Invalid webhook envelope");
  return { event: value.event, data: value.data };
}
