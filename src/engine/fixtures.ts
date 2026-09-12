import { readFile } from "node:fs/promises";
import type { Principal } from "../types.ts";
import { exactKeys, object, principal } from "./validation.ts";

export type Resource = { kind: "bucket" | "project"; environment: "production" | "staging" };
/** Read-only engine seam. This implementation never resolves effective/cloud IAM. */
export interface IamResolver {
  permissions(role: string): string[] | null;
  resource(name: string): Resource | null;
  holders(resource: string): Principal[];
  roles(): string[];
}

export function fixtureResolver(roles: unknown, bindings: unknown, resources: unknown): IamResolver {
  if (!object(roles) || !object(bindings) || !object(resources) || !Object.keys(roles).length ||
      !Object.keys(resources).length) throw new Error("Invalid IAM fixture catalog");
  const roleMap = new Map<string, string[]>();
  const resourceMap = new Map<string, Resource>();
  const holderMap = new Map<string, Principal[]>();
  for (const [role, permissions] of Object.entries(roles)) {
    if (!/^roles\/[a-zA-Z0-9.]+$/.test(role) || !Array.isArray(permissions) || !permissions.length ||
        permissions.some(p => typeof p !== "string" || !/^[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)+$/.test(p)) ||
        new Set(permissions).size !== permissions.length) throw new Error("Invalid IAM role fixture");
    roleMap.set(role, [...permissions]);
  }
  for (const [name, meta] of Object.entries(resources)) {
    if (!object(meta) || !exactKeys(meta, ["kind", "environment"]) ||
        !["bucket", "project"].includes(String(meta.kind)) ||
        !["production", "staging"].includes(String(meta.environment)) ||
        !(meta.kind === "bucket" ? /^gs:\/\/[a-z0-9-]+$/ : /^projects\/[a-z0-9-]+$/).test(name)) {
      throw new Error("Invalid IAM resource fixture");
    }
    resourceMap.set(name, { kind: meta.kind as Resource["kind"], environment: meta.environment as Resource["environment"] });
    if (!Object.hasOwn(bindings, name)) throw new Error("Missing resource bindings fixture");
  }
  for (const [name, grants] of Object.entries(bindings)) {
    if (!resourceMap.has(name) || !object(grants)) throw new Error("Invalid IAM binding fixture");
    const holders = new Map<string, Principal>();
    for (const [role, members] of Object.entries(grants)) {
      if (!roleMap.has(role) || !Array.isArray(members) || !members.every(principal)) throw new Error("Invalid IAM binding fixture");
      for (const member of members) holders.set(`${member.kind}:${member.id}`, { ...member });
    }
    holderMap.set(name, [...holders.values()]);
  }
  return {
    permissions: role => roleMap.has(role) ? [...roleMap.get(role)!] : null,
    resource: name => resourceMap.has(name) ? { ...resourceMap.get(name)! } : null,
    holders: name => (holderMap.get(name) ?? []).map(holder => ({ ...holder })),
    roles: () => [...roleMap.keys()],
  };
}

export async function loadFixtures(): Promise<IamResolver> {
  const root = new URL("../../fixtures/iam/", import.meta.url);
  const values = await Promise.all(["roles.json", "bindings.json", "resources.json"].map(async name =>
    JSON.parse(await readFile(new URL(name, root), "utf8")) as unknown));
  return fixtureResolver(values[0], values[1], values[2]);
}
