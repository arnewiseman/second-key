export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid PORT");
  return {
    port,
    host: env.HOST ?? "127.0.0.1",
    recordDir: env.RECORD_DIR ?? "./data/records",
  };
}
