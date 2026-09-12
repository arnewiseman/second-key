import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntakeStore } from "../src/record/intake.ts";
import { createIntakeHandler } from "../src/record/processor.ts";

test("processor normalizes an intake job before calling the router", async t => {
  const directory = await mkdtemp(join(tmpdir(), "second-key-processor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requester = { id: "requester", kind: "user" as const, email: "arne@example.test" };
  const store = new IntakeStore(directory);
  const { job } = await store.accept({
    event: "email.received",
    delivery_id: "delivery-1",
    data: { id: "mail-1", from: { email: requester.email }, body_text: "Request access." },
  });
  const received: { text: string; from: typeof requester }[] = [];
  const handler = createIntakeHandler({
    router: { async receive(input) { received.push(input as typeof received[number]); } },
    resolvePrincipal: participant => participant.email === requester.email ? requester : null,
  });
  await handler(job);
  assert.deepEqual(received, [{ text: "Request access.", from: requester }]);
});
