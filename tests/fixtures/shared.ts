/** Cross-suite test primitives: global fetch swap, bounded condition wait and the accepted foreign-settlement fixture. Zones: shared utils. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

/** CI-only partition of complete integration test names; absent configuration preserves local execution. */
export function createIntegrationShardSelector(specification?: string): (name: string) => boolean {
  if (specification === undefined) return () => true;
  if (!/^[0-3]\/4$/u.test(specification)) throw new Error("Integration shard must be 0/4, 1/4, 2/4 or 3/4");
  const index = Number(specification[0]);
  return name => createHash("sha256").update(name).digest().readUInt32BE(0) % 4 === index;
}

/** Installs a fetch double and returns its restorer. */
export function setTestFetch(fetchImpl: typeof fetch): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

/** Returns as soon as the predicate holds; the bound only guards a hang on loaded (Windows) runners. */
export async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for condition");
}

export function acceptedForeignUpdateSettlement(sourceUpdateId = 1) {
  return {
    status: "accepted" as const,
    delivery: {
      deliveryId: `test-delivery-${sourceUpdateId}`,
      sourceUpdateId,
      recipientBindingKey: "test-recipient",
    },
  };
}
