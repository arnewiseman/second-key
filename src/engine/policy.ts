import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import type { AccessRequest, Analysis, Principal, PolicyFinding } from "../types.ts";
import type { IamResolver } from "./fixtures.ts";
import { exactKeys, object, principal } from "./validation.ts";

const CONDITIONS = {
  "PROD-EXPIRY": "production_resource_without_duration",
  "MAX-DURATION": "duration_exceeds_limit",
  "NO-BASIC-ROLES": "basic_role_on_production_project",
  "SEP-DUTIES": "asserts_prior_approval",
  "SELF-APPROVAL": "requester_equals_configured_approver",
  "LEAST-PRIV": "narrower_role_covers_stated_need",
  "REQUEST-VALIDATION": "unsupported_or_incomplete_request",
} as const;
type RuleId = keyof typeof CONDITIONS;
type Rule = { id: RuleId; severity: "warn" | "block"; condition: string; message: string; max_days?: number; roles?: string[] };
export type Policy = { defaultDurationDays: number; rules: Rule[] };

export function parsePolicy(text: string): Policy {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new Error("Invalid policy YAML");
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (!object(value) || !exactKeys(value, ["version", "default_duration_days", "rules"]) || value.version !== 1 ||
      !Number.isSafeInteger(value.default_duration_days) || Number(value.default_duration_days) < 1 ||
      !Array.isArray(value.rules) || value.rules.length !== Object.keys(CONDITIONS).length) throw new Error("Invalid policy configuration");
  const seen = new Set<string>();
  const rules: Rule[] = value.rules.map((rule: unknown) => {
    if (!object(rule) || typeof rule.id !== "string" || !Object.hasOwn(CONDITIONS, rule.id) || seen.has(rule.id)) {
      throw new Error("Missing, duplicate or unsupported policy rule");
    }
    const id = rule.id as RuleId;
    const keys = ["id", "severity", "condition", "message", ...(id === "MAX-DURATION" ? ["max_days"] : id === "NO-BASIC-ROLES" ? ["roles"] : [])];
    if (!exactKeys(rule, keys) || rule.condition !== CONDITIONS[id] || !["warn", "block"].includes(String(rule.severity)) ||
        typeof rule.message !== "string" || !rule.message.trim() || rule.message.length > 1000 ||
        (!["PROD-EXPIRY", "LEAST-PRIV"].includes(id) && rule.severity !== "block")) throw new Error("Invalid policy rule");
    if (id === "MAX-DURATION" && (!Number.isSafeInteger(rule.max_days) || Number(rule.max_days) < 1)) throw new Error("Invalid duration limit");
    if (id === "NO-BASIC-ROLES" && (!Array.isArray(rule.roles) || rule.roles.length !== 3 ||
        !["roles/owner", "roles/editor", "roles/viewer"].every(role => (rule.roles as unknown[]).includes(role)))) throw new Error("Invalid basic-role policy");
    seen.add(id);
    return { ...rule } as Rule;
  });
  if (Number(value.default_duration_days) > rules.find(rule => rule.id === "MAX-DURATION")!.max_days!) throw new Error("Default duration exceeds policy limit");
  return { defaultDurationDays: Number(value.default_duration_days), rules };
}

export async function loadPolicy(): Promise<Policy> {
  return parsePolicy(await readFile(new URL("../../policy/access.yaml", import.meta.url), "utf8"));
}

const normalized = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

const durationPattern = /(?<![\w.-])([+-]?\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|fourteen|thirty|sixty|ninety)[ -]+(days?|weeks?)\b/g;

function durationEvidence(text: string): number[] {
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, fourteen: 14, thirty: 30, sixty: 60, ninety: 90 };
  return [...text.matchAll(durationPattern)]
    .map(match => (words[match[1]!] ?? Number(match[1])) * (match[2]!.startsWith("week") ? 7 : 1));
}

/** Deliberately bounded evidence matching, not general natural-language IAM inference. */
function requiredPermissions(request: AccessRequest): string[] | null {
  const text = normalized(request.raw_text);
  // Additional operations are deliberately unresolved; do not claim coverage from
  // one recognized phrase when another action may need more permissions.
  if (/\b(?:also|additionally|plus|remove|removing|replace|replacing|modify|modifying|change|changing|configure|configuration|manage|retention|purge|truncate|rewrite|download|fetch)\b/.test(text)) return null;
  // Strip only explicit negative operation lists, preserving any other operation.
  const operations = text.replace(/\b(?:do not|don't|never)\s+(?:overwrite|read|delete)(?:\s+or\s+(?:overwrite|read|delete))*/g, "")
    .replace(/\bno\s+(?:overwrites?|reads?|deletes?)\b/g, "");
  if (/\b(?:write|create|upload)\s+new\s+(?:files|objects)\b/.test(text) && /\bunique\b/.test(text) &&
      /\b(?:do not|don't|never)\s+overwrite\b|\bno overwrites?\b/.test(text) &&
      !/\b(?:read|reading|overwrite|overwriting|delete|deleting|list|listing|update|updating|iam)\b/.test(operations)) {
    return ["storage.objects.create"];
  }
  if (/\bread\s+(?:(?:its|the|application)\s+)*logs\b/.test(text) &&
      !/\b(?:write|create|upload|delete|export|update|iam|objects?|buckets?)\b/.test(operations)) {
    return ["logging.logEntries.list", "logging.logs.list"];
  }
  if (/\b(?:read|list)\s+(?:existing\s+)?objects\b/.test(text) &&
      !/\b(?:write|create|upload|delete|overwrite|update|iam)\b/.test(operations)) {
    return ["storage.objects.get", "storage.objects.list"];
  }
  return null;
}

export function evaluate(request: AccessRequest, iam: IamResolver, policy: Policy, approver: Principal | null): Analysis {
  const meta = iam.resource(request.resource);
  const permissions = iam.permissions(request.requested_role);
  const needed = requiredPermissions(request);
  const reasons: string[] = [];
  const raw = normalized(request.raw_text);
  const resourceTokens = new Set(request.raw_text.match(/(?:gs:\/\/|projects\/)[a-zA-Z0-9._/-]+/g)?.map(t => t.replace(/[.,]+$/, "")) ?? []);
  const roleTokens = new Set(request.raw_text.match(/roles\/[a-zA-Z0-9.]+/g)?.map(t => t.replace(/[.]+$/, "")) ?? []);
  if (!meta) reasons.push("Resource is absent from the fixture catalog.");
  if (!permissions) reasons.push("Role is absent from the fixture catalog.");
  if (resourceTokens.size !== 1 || !resourceTokens.has(request.resource) || roleTokens.size !== 1 || !roleTokens.has(request.requested_role)) {
    reasons.push("A single explicit role and resource must match the original request.");
  }
  if (!request.justification || !raw.includes(normalized(request.justification))) reasons.push("An operational justification quoted from the original request is required.");
  if (request.duration_days !== null && (!Number.isSafeInteger(request.duration_days) || request.duration_days <= 0)) reasons.push("Duration must be a positive whole number of days.");
  const durations = new Set(durationEvidence(raw));
  if (/\b(?:months?|years?|hours?|minutes?|hundred|thousand|million|eleven|twelve|thirteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|forty|fifty|seventy|eighty|forever|permanent(?:ly)?|indefinite(?:ly)?|unlimited|until|expiry|expires?|minus|negative)\b/.test(raw.replace(/\blast-minute\b/g, "")) ||
      /\b(?:days?|weeks?)\b|\d(?:days?|weeks?)\b/.test(raw.replace(durationPattern, ""))) {
    reasons.push("Unsupported expiry or duration wording requires an explicit positive day/week duration.");
  }
  if (durations.size > 1 || (durations.size === 1 ? !durations.has(request.duration_days as number) : request.duration_days !== null)) {
    reasons.push("Duration must match one explicit supported day/week duration in the original request; conflicting or unsupported durations require clarification.");
  }
  if (/\bservice[ -]account\b|\.iam\.gserviceaccount\.com\b/i.test(request.raw_text)) reasons.push("A separate service-account grantee cannot be represented by the requester-only contract.");
  if (!needed) reasons.push("Required permissions are ambiguous or outside the supported fixture use cases.");
  if (meta && permissions && (request.requested_role.startsWith("roles/storage.") ? meta.kind !== "bucket" : meta.kind !== "project")) {
    reasons.push("The fixture role is not supported at this resource scope.");
  }
  if (needed && permissions && !needed.every(permission => permissions.includes(permission))) reasons.push("The requested role does not cover the stated need.");
  const candidates = needed && permissions && !reasons.length ? iam.roles().filter(role => {
    const candidate = iam.permissions(role)!;
    return role.startsWith("roles/storage.") === request.requested_role.startsWith("roles/storage.") &&
      candidate.length < permissions.length && candidate.every(p => permissions.includes(p)) && needed.every(p => candidate.includes(p));
  }).sort((a, b) => iam.permissions(a)!.length - iam.permissions(b)!.length || a.localeCompare(b)) : [];
  const narrower = candidates[0] ?? null;
  const missingApprover = !principal(approver) || approver.kind !== "user";
  const selfApproval = missingApprover || approver!.id === request.requester.id ||
    normalized(approver!.email) === normalized(request.requester.email);
  // An obvious process-bypass claim cannot disappear through model extraction.
  const obviousPriorApproval = /\balready\s+(?:signed off|approved)\b|\bskip\s+(?:creating\s+)?(?:an?\s+)?approval\b/.test(raw);
  const findings: PolicyFinding[] = policy.rules.map(rule => {
    const matches: Record<RuleId, boolean> = {
      "PROD-EXPIRY": meta?.environment === "production" && request.duration_days === null,
      "MAX-DURATION": request.duration_days !== null && request.duration_days > (rule.max_days ?? Infinity),
      "NO-BASIC-ROLES": meta?.environment === "production" && meta.kind === "project" && (rule.roles ?? []).includes(request.requested_role),
      "SEP-DUTIES": request.asserts_prior_approval || obviousPriorApproval,
      "SELF-APPROVAL": selfApproval,
      "LEAST-PRIV": narrower !== null,
      "REQUEST-VALIDATION": reasons.length > 0,
    };
    const hit = matches[rule.id];
    return { rule_id: rule.id, severity: hit ? rule.severity : "pass",
      message: hit ? `${rule.message}${rule.id === "REQUEST-VALIDATION" ? ` ${reasons.join(" ")}` :
        rule.id === "SELF-APPROVAL" && missingApprover ? " A configured human approver is required." : ""}` : `Check satisfied: ${rule.id}.` };
  });
  const blocks = findings.filter(f => f.severity === "block");
  const refused = blocks.length > 0;
  const role = narrower ?? request.requested_role;
  const duration = request.duration_days ?? policy.defaultDurationDays;
  const rationale = `The fixture permissions cover the supported stated need. ${narrower ? "This role has fewer fixture permissions than requested." : "The proposed role matches the request."} ` +
    (role === "roles/storage.objectCreator" ? "Object Creator only creates new objects: it does not permit reading, deleting, or overwriting existing objects. Unique object names are required. " : "") +
    `Limit the proposal to ${duration} days. This is an illustrative fixture assessment; a separate human must confirm the scope. No grant has been executed.`;
  return {
    request,
    findings,
    blast_radius: { resource: request.resource, role: request.requested_role, permissions: permissions ?? [],
      also_grants: needed ? (permissions ?? []).filter(p => !needed.includes(p)) : [],
      existing_holders: iam.holders(request.resource),
      does_not_cover: ["Illustrative local fixtures only: no inherited policies, IAM conditions, deny policies, or complete effective-access inventory.",
        ...(needed === null ? ["The stated permission need is unresolved; no safe coverage claim can be made."] : []),
        ...(role === "roles/storage.objectCreator" ? ["Proposed Object Creator cannot read, delete, or overwrite existing objects."] : []),
        "The proposed grantee is the requester under the frozen contract; a distinct pipeline identity requires clarification."] },
    recommendation: refused ? null : { role, duration_days: duration, narrower_than_requested: narrower !== null, rationale },
    decision_required: refused ? "Refuse this request; resolve the blocking findings before a separate human reviews a new request." :
      `Approve ${role} on ${request.resource} for ${request.requester.email} for ${duration} days?`,
    refused,
    refusal_reason: refused ? blocks.map(f => `${f.rule_id}: ${f.message}`).join("; ") : null,
  };
}
