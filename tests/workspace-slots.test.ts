/**
 * Workspace slot policy regressions
 * Covers bounded global allocation and pressure reclamation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  TELEGRAM_WORKSPACE_SLOTS,
  planTelegramWorkspaceSlotAllocation,
  type TelegramWorkspaceSlotOccupancy,
} from "../lib/workspace-slots.ts";

function fullProfile(): TelegramWorkspaceSlotOccupancy[] {
  return Array.from(TELEGRAM_WORKSPACE_SLOTS, (slot, index) => ({
    bindingKey: `/repo/${index}`,
    slot,
    inactiveSinceMs: 100 + index,
    protection: "eligible",
  }));
}

test("Global allocation uses the first free letter across directories and claims", () => {
  const bindings = fullProfile().slice(0, 2);
  assert.deepEqual(planTelegramWorkspaceSlotAllocation({
    bindings, reservedSlots: ["c", "e"], nowMs: 1000,
  }), { kind: "free", slot: "d" });
  assert.deepEqual(planTelegramWorkspaceSlotAllocation({
    bindings: [], reservedSlots: [], nowMs: 1000,
  }), { kind: "free", slot: "a" });
});

test("Pressure proposes the oldest eligible binding instead of alphabetic wrap", () => {
  const bindings = fullProfile();
  bindings[12].inactiveSinceMs = 1;
  const result = planTelegramWorkspaceSlotAllocation({
    bindings, reservedSlots: [], nowMs: 1000,
  });
  assert.equal(result.kind, "reclaim");
  if (result.kind !== "reclaim") return;
  assert.equal(result.candidate.slot, "m");
  assert.equal(result.candidate.bindingKey, "/repo/12");
  result.candidate.bindingKey = "changed";
  assert.equal(bindings[12].bindingKey, "/repo/12");
  assert.equal(bindings.length, 26);
});

test("Elapsed time cannot retire a binding while free capacity remains", () => {
  assert.deepEqual(planTelegramWorkspaceSlotAllocation({
    bindings: fullProfile().slice(0, 25),
    reservedSlots: [],
    nowMs: Number.MAX_SAFE_INTEGER,
  }), { kind: "free", slot: "z" });
});

test("Protected, unknown, reserved, and unproven inactivity cannot be victims", () => {
  const bindings = fullProfile();
  bindings[0].protection = "protected";
  bindings[1].protection = "unknown";
  bindings[2].inactiveSinceMs = undefined;
  bindings[3].inactiveSinceMs = NaN;
  bindings[4].inactiveSinceMs = Infinity;
  bindings[5].inactiveSinceMs = -1;
  bindings[6].inactiveSinceMs = 1001;
  const result = planTelegramWorkspaceSlotAllocation({
    bindings, reservedSlots: ["h"], nowMs: 1000,
  });
  assert.equal(result.kind, "reclaim");
  if (result.kind === "reclaim") assert.equal(result.candidate.slot, "i");
});

test("All-protected capacity fails closed without extending the alphabet", () => {
  const bindings = fullProfile().map((binding) => ({
    ...binding, protection: "protected" as const,
  }));
  for (const input of [
    { bindings, reservedSlots: [] },
    { bindings: [], reservedSlots: Array.from(TELEGRAM_WORKSPACE_SLOTS) },
  ]) {
    assert.deepEqual(planTelegramWorkspaceSlotAllocation({ ...input, nowMs: 1000 }), {
      kind: "blocked", reason: "protected-capacity",
    });
  }
});

test("Equal inactivity uses deterministic letter order independent of input order", () => {
  const bindings = fullProfile().map((binding) => ({ ...binding, inactiveSinceMs: 0 }));
  assert.deepEqual(planTelegramWorkspaceSlotAllocation({
    bindings: bindings.toReversed(), reservedSlots: [], nowMs: 1000,
  }), { kind: "reclaim", candidate: bindings[0] });
});

test("Duplicate legacy slots, duplicate binding keys, and invalid inputs block planning", () => {
  const first = fullProfile()[0];
  for (const input of [
    { bindings: [first, { ...first, bindingKey: "/other" }], reservedSlots: [], nowMs: 1000 },
    { bindings: [first, { ...first, slot: "b" }], reservedSlots: [], nowMs: 1000 },
    { bindings: [{ ...first, slot: "aa" }], reservedSlots: [], nowMs: 1000 },
    { bindings: [{ ...first, slot: "A" }], reservedSlots: [], nowMs: 1000 },
    { bindings: [{ ...first, bindingKey: "" }], reservedSlots: [], nowMs: 1000 },
    { bindings: [], reservedSlots: ["aa"], nowMs: 1000 },
    { bindings: [], reservedSlots: [], nowMs: NaN },
    { bindings: [], reservedSlots: [], nowMs: -1 },
  ]) {
    assert.deepEqual(planTelegramWorkspaceSlotAllocation(input), {
      kind: "blocked", reason: "invalid-state",
    });
  }
});
