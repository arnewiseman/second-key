import { normalizeEmailEvent, type EmailLookup, type EmailParticipantInput } from "../webhook.ts";
import type { Principal } from "../types.ts";
import type { IntakeHandler } from "./worker.ts";

export type IntakeRouter = {
  receive(inbound: { text: string; from: Principal }): Promise<unknown>;
};

export type IntakeProcessorOptions = {
  router: IntakeRouter;
  resolvePrincipal: (participant: EmailParticipantInput) => Principal | null;
  getEmail?: (id: string) => Promise<EmailLookup>;
};

/** Builds the worker handler that normalizes email jobs and invokes the router. */
export function createIntakeHandler(options: IntakeProcessorOptions): IntakeHandler {
  return async job => {
    const email = await normalizeEmailEvent({
      event: job.event,
      delivery_id: job.deliveryId,
      data: job.data,
    }, {
      deliveryId: job.deliveryId,
      receivedAt: job.receivedAt,
      resolvePrincipal: options.resolvePrincipal,
      getEmail: options.getEmail,
    });
    await options.router.receive({ text: email.text, from: email.from });
  };
}
