export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid PORT");
  return {
    port,
    host: env.HOST ?? "127.0.0.1",
    recordDir: env.RECORD_DIR ?? "./data/records",
  };
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.REEVE_ENABLED !== "1") return null;
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required when REEVE_ENABLED=1`);
    return value;
  };
  const fieldPath = (name: string) => {
    const value = required(name);
    if (!/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(value) || value.split(".").some(key => ["__proto__", "constructor", "prototype"].includes(key))) {
      throw new Error(`${name} must be a verified dot-separated field path`);
    }
    return value;
  };
  const approver = { id: required("APPROVER_USER_ID"), kind: "user" as const, email: required("APPROVER_EMAIL") };
  const requester = { id: required("REQUESTER_USER_ID"), kind: "user" as const, email: required("REQUESTER_EMAIL") };
  if (approver.id === requester.id || approver.email.toLowerCase() === requester.email.toLowerCase()) throw new Error("Requester and approver must differ");
  const window = { calendarId: required("CALENDAR_ID"), start: required("CHANGE_START_AT"), end: required("CHANGE_END_AT") };
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!iso.test(window.start) || !iso.test(window.end) || !Number.isFinite(Date.parse(window.start)) ||
      !Number.isFinite(Date.parse(window.end)) || Date.parse(window.end) <= Date.parse(window.start)) throw new Error("Invalid configured change window");
  return { approver, requester, window, secret: required("WEBHOOK_SECRET"),
    agentKey: required("AMBIGUOUS_AGENT_KEY"), baseUrl: env.AMBIGUOUS_BASE ?? "https://app.ambiguous.ai",
    eventTypePath: fieldPath("WEBHOOK_EVENT_TYPE_PATH"),
    emailIdPath: fieldPath("WEBHOOK_EMAIL_ID_PATH"), deliveryIdPath: fieldPath("WEBHOOK_DELIVERY_ID_PATH") };
}
