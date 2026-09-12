import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { loadConfig, loadRuntimeConfig } from "./config.ts";
import { parseEnvelope, readPath, verifyWebhook } from "./webhook.ts";
import type { WebhookEnvelope } from "./webhook.ts";
import type { IntakeStore } from "./record/intake.ts";
import { createRuntime } from "./runtime.ts";
import { AmbiguousClient } from "./ambiguous/client.ts";
import { createAnalyzer } from "./engine/index.ts";
import { completionFromEnv } from "./engine/model.ts";

/** enqueue must persist promptly, before returning; never run the model in intake. */
export function createApp(options: {
  secret?: string; enqueue?: (event: WebhookEnvelope) => Promise<void>; intake?: IntakeStore; now?: () => Date;
  deliveryIdPath?: string; eventTypePath?: string; engine?: "real" | "stub";
} = {}) {
  return createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200).end(JSON.stringify({ service: "reeve", status: options.engine === "real" ? "integrated" : "scaffold", engine: options.engine ?? "stub", webhook: options.secret && options.enqueue ? "configured" : "not_configured" }));
      return;
    }
    if (request.method === "POST" && request.url === "/webhooks/ambiguous") {
      if (!options.secret || !options.enqueue) {
        response.writeHead(503).end(JSON.stringify({ error: "Webhook integration pending: see docs/ambiguous-api.md" }));
        return;
      }
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          const buffer = Buffer.from(chunk);
          size += buffer.length;
          if (size > 1_048_576) {
            response.writeHead(413).end(JSON.stringify({ error: "Payload too large" }));
            return;
          }
          chunks.push(buffer);
        }
        const rawBody = Buffer.concat(chunks);
        const header = (name: string) => typeof request.headers[name] === "string" ? request.headers[name] : undefined;
        if (!verifyWebhook({ rawBody, timestamp: header("x-webhook-timestamp"), signature: header("x-webhook-signature"), secret: options.secret, now: options.now?.() })) {
          response.writeHead(401).end(JSON.stringify({ error: "Invalid webhook signature or timestamp" }));
          return;
        }
        let envelope: WebhookEnvelope;
        try { envelope = parseEnvelope(rawBody, options.eventTypePath); }
        catch { response.writeHead(400).end(JSON.stringify({ error: "Invalid event envelope" })); return; }
        if (options.deliveryIdPath) {
          const id = readPath(JSON.parse(rawBody.toString("utf8")), options.deliveryIdPath);
          if (typeof id !== "string" || !id.trim() || id.length > 256) {
            response.writeHead(400).end(JSON.stringify({ error: "Verified delivery identity is required" })); return;
          }
          envelope.delivery_id = id;
        }
        if (envelope.event !== "email.received") {
          response.writeHead(200).end(JSON.stringify({ received: true, ignored: true })); return;
        }
        if (options.intake && !envelope.delivery_id) {
          response.writeHead(400).end(JSON.stringify({ error: "Webhook delivery ID is required" }));
          return;
        }
        const accepted = options.intake ? await options.intake.accept(envelope, options.now?.() ?? new Date()) : null;
        if (!accepted?.duplicate) await options.enqueue(envelope);
        response.writeHead(200).end(JSON.stringify({ received: true }));
      } catch {
        response.writeHead(503).end(JSON.stringify({ error: "Delivery was not accepted; retry later" }));
      }
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: "Not found" }));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const runtimeConfig = loadRuntimeConfig();
  const runtime = runtimeConfig ? createRuntime({ ...runtimeConfig, recordDir: config.recordDir,
    client: new AmbiguousClient({ baseUrl: runtimeConfig.baseUrl, agentKey: runtimeConfig.agentKey }),
    analyze: createAnalyzer({ approver: runtimeConfig.approver, complete: completionFromEnv() }),
  }) : null;
  const server = createApp(runtime && runtimeConfig ? { secret: runtimeConfig.secret, intake: runtime.intake,
    enqueue: runtime.enqueue, deliveryIdPath: runtimeConfig.deliveryIdPath,
    eventTypePath: runtimeConfig.eventTypePath, engine: "real" } : {});
  server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({ service: "reeve", event: "listening", host: config.host, port: config.port, mode: runtime ? "integrated" : "scaffold" }));
    runtime?.start();
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
    server.close(() => { void runtime?.stop(); });
  });
}
