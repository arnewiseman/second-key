import { createHmac, timingSafeEqual } from "node:crypto";
import type { Principal } from "./types.ts";

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
export type WebhookEnvelope = { event: string; data: unknown; delivery_id?: string };

export type EmailParticipantInput = { id?: unknown; email?: unknown };

export type EmailLookup = {
  id?: unknown;
  from?: unknown;
  sender?: unknown;
  body_text?: unknown;
  body?: unknown;
  text?: unknown;
  thread_id?: unknown;
  message_id?: unknown;
  received_at?: unknown;
};

export type NormalizedEmail = {
  deliveryId: string;
  emailId: string;
  text: string;
  from: Principal;
  receivedAt: string;
  threadId: string | null;
  messageId: string | null;
};

export type NormalizeEmailOptions = {
  deliveryId?: string;
  resolvePrincipal: (participant: EmailParticipantInput) => Principal | null;
  getEmail?: (id: string) => Promise<EmailLookup>;
  receivedAt?: string;
};

export function parseEnvelope(rawBody: Buffer): WebhookEnvelope {
  const value: unknown = JSON.parse(rawBody.toString("utf8"));
  if (!value || typeof value !== "object" || !("event" in value) ||
      typeof value.event !== "string" || !("data" in value)) throw new Error("Invalid webhook envelope");
  const deliveryId = "delivery_id" in value && typeof value.delivery_id === "string" ? value.delivery_id : undefined;
  return { event: value.event, data: value.data, ...(deliveryId ? { delivery_id: deliveryId } : {}) };
}

/** Normalizes one email event before the router or model receives it. */
export async function normalizeEmailEvent(
  envelope: WebhookEnvelope,
  options: NormalizeEmailOptions,
): Promise<NormalizedEmail> {
  if (envelope.event !== "email.received") throw new Error(`Unsupported webhook event: ${envelope.event}`);
  const payload = asRecord(envelope.data);
  const deliveryId = nonEmpty(options.deliveryId) ?? nonEmpty(envelope.delivery_id) ?? nonEmpty(payload.delivery_id);
  if (!deliveryId) throw new Error("Webhook delivery ID is required");
  const emailId = nonEmpty(payload.id) ?? nonEmpty(payload.email_id);
  const inline = readEmail(payload);
  const fetched = !inline.text && emailId && options.getEmail ? await options.getEmail(emailId) : null;
  if (!emailId) throw new Error("Email ID is required");
  const email = fetched ? readEmail(asRecord(fetched)) : inline;
  if (!email.text) throw new Error("Email body is required");
  const participant = readParticipant(email.participant);
  if (!participant) throw new Error("Trusted email sender is required");
  const from = options.resolvePrincipal(participant);
  if (!from) throw new Error("Email sender is not a trusted principal");
  const receivedAt = nonEmpty(email.receivedAt) ?? nonEmpty(options.receivedAt);
  if (!receivedAt) throw new Error("Email received time is required");
  return {
    deliveryId,
    emailId,
    text: email.text,
    from,
    receivedAt,
    threadId: nonEmpty(email.threadId),
    messageId: nonEmpty(email.messageId),
  };
}

/** Restricts unknown webhook data to a record without trusting its fields. */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Converts an unknown value to a non-empty string when the provider supplies one. */
function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Selects supported email fields from a provider record. */
function readEmail(value: Record<string, unknown>): {
  text: string | null;
  participant: unknown;
  threadId: string | null;
  messageId: string | null;
  receivedAt: string | null;
} {
  return {
    text: nonEmpty(value.body_text) ?? nonEmpty(value.body) ?? nonEmpty(value.text),
    participant: value.from ?? value.sender,
    threadId: nonEmpty(value.thread_id),
    messageId: nonEmpty(value.message_id),
    receivedAt: nonEmpty(value.received_at),
  };
}

/** Converts a provider sender projection into resolver input. */
function readParticipant(value: unknown): EmailParticipantInput | null {
  if (typeof value === "string" && value.trim()) return { email: value.trim() };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const participant = value as Record<string, unknown>;
  if (!nonEmpty(participant.email) && !nonEmpty(participant.id)) return null;
  return { id: participant.id, email: participant.email };
}
