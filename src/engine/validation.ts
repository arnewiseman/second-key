import { createHash } from "node:crypto";
import type { AccessRequest, Analysis, Principal } from "../types.ts";

export const MAX_EMAIL_BYTES = 32_768;

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function principal(value: unknown): value is Principal {
  return object(value) && exactKeys(value, ["id", "kind", "email"]) &&
    typeof value.id === "string" && /^[^\s\x00-\x1f]{1,256}$/.test(value.id) &&
    (value.kind === "user" || value.kind === "service_account") &&
    typeof value.email === "string" && value.email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email);
}

export function validateInbound(inbound: { text: string; from: Principal }): void {
  if (!inbound || !principal(inbound.from) || typeof inbound.text !== "string" ||
      !inbound.text.trim() || Buffer.byteLength(inbound.text, "utf8") > MAX_EMAIL_BYTES ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(inbound.text)) {
    throw new Error("Invalid or oversized inbound request");
  }
}

export function requestId(inbound: { text: string; from: Principal }): string {
  return createHash("sha256").update(JSON.stringify([
    inbound.from.id, inbound.from.kind, inbound.from.email.trim().toLowerCase(), inbound.text,
  ])).digest("hex");
}

export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseRequest(output: string, inbound: { text: string; from: Principal }): AccessRequest {
  try {
    if (typeof output !== "string" || Buffer.byteLength(output) > 65_536) throw new Error();
    const value: unknown = JSON.parse(output);
    if (!object(value) || !exactKeys(value, ["id", "raw_text", "requester", "resource", "requested_role",
      "justification", "needed_by", "duration_days", "asserts_prior_approval", "source"]) ||
      !principal(value.requester) || typeof value.id !== "string" || typeof value.raw_text !== "string" ||
      !["email", "task", "manual"].includes(String(value.source)) ||
      typeof value.resource !== "string" || value.resource.length > 256 ||
      typeof value.requested_role !== "string" || value.requested_role.length > 256 ||
      typeof value.justification !== "string" || value.justification.length > 4000 ||
      (value.needed_by !== null && (typeof value.needed_by !== "string" || !validDate(value.needed_by))) ||
      (value.duration_days !== null && (typeof value.duration_days !== "number" || !Number.isFinite(value.duration_days))) ||
      typeof value.asserts_prior_approval !== "boolean") throw new Error();
    // These four fields belong to intake, regardless of what the model emits.
    return { id: requestId(inbound), raw_text: inbound.text, requester: { ...inbound.from }, source: "email",
      resource: value.resource.trim(), requested_role: value.requested_role.trim(),
      justification: value.justification.trim(), needed_by: value.needed_by as string | null,
      duration_days: value.duration_days as number | null, asserts_prior_approval: value.asserts_prior_approval };
  } catch {
    // Do not expose model output or transport details in errors.
    throw new Error("Parse response did not match the access-request contract");
  }
}

export function parseExplanation(output: string): string {
  if (typeof output !== "string" || Buffer.byteLength(output) > 16_384) throw new Error("Invalid explanation");
  const value: unknown = JSON.parse(output);
  if (!object(value) || !exactKeys(value, ["rationale"]) || typeof value.rationale !== "string" ||
      !value.rationale.trim() || value.rationale.length > 4000) throw new Error("Invalid explanation");
  return value.rationale.trim();
}

/** Reject obvious invented scope or claims of completed approval/execution. */
export function checkExplanation(text: string, analysis: Analysis): void {
  const allowedRoles = [analysis.request.requested_role, analysis.recommendation?.role];
  const roles = text.match(/roles\/[a-zA-Z0-9.]+/g) ?? [];
  const permissions = text.replace(/roles\/[a-zA-Z0-9.]+/g, "").match(/\b(?:storage|logging|resourcemanager)\.[a-zA-Z0-9.]+/g) ?? [];
  const claims = text.replace(/\bno (?:grant (?:has been|was) executed|access (?:has been|was) granted|approval is complete)\b/gi, "");
  if (roles.some(role => !allowedRoles.includes(role.replace(/\.$/, ""))) ||
      permissions.some(permission => !analysis.blast_radius.permissions.includes(permission.replace(/\.$/, ""))) ||
      /\b(?:ignore|disregard|bypass|forever|unlimited|already approved|approval is complete|access (?:has been|was) granted|grant (?:has been|was) executed)\b/i.test(claims)) {
    throw new Error("Explanation contains unsupported decision language");
  }
}
