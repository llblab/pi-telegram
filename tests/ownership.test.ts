/**
 * Regression tests for Telegram message ownership helpers
 * Covers live message-id to target/instance ownership used by multi-instance bus routing
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as Bus from "../lib/bus.ts";
import {
  createTelegramBusMessageOwnershipRuntime,
  createTelegramMessageOwnershipStore,
} from "../lib/ownership.ts";
import { createTelegramThreadTarget } from "../lib/target.ts";

function completeOriginalRecipient(): Bus.TelegramBusInstanceRegistration {
  return { instanceId: "follower", connectedAtMs: 1, profileKey: "manual:recipient", registrationGeneration: "g1",
    sessionId: "session-a", sessionGeneration: 3, pid: 101, processBirthId: "birth-a", cwd: "/a", busSocketPath: "/endpoint-a",
    protocol: Bus.createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: [Bus.TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION] }) };
}

for (const loss of ["profile", "recipient", "callable"] as const)
test(`Native publication scope observes without a receipt and cannot renew after loss (${loss})`, () => {
  const recipient = completeOriginalRecipient(), registry = Bus.createTelegramBusFollowerRegistry(); registry.register(recipient);
  let profile = "default";
  const deps = { instanceId: "leader", getProfileKey: () => profile, listFollowers: registry.list };
  const runtime = createTelegramBusMessageOwnershipRuntime(deps), writer = runtime.captureFollowerPublication(recipient, { chatId: 7 });
  assert.ok(Object.isFrozen(writer)); writer.assertCurrent(); assert.deepEqual(runtime.store.entries(), []);
  const originalList = deps.listFollowers;
  if (loss === "profile") profile = "other";
  if (loss === "recipient") registry.register({ ...recipient, sessionId: "replacement" });
  if (loss === "callable") deps.listFollowers = () => registry.list();
  assert.throws(writer.assertCurrent); profile = "default"; registry.register(recipient); deps.listFollowers = originalList;
  assert.throws(writer.assertCurrent); assert.throws(() => writer(9)); assert.deepEqual(runtime.store.entries(), []);
});

for (const follower of [false, true]) for (const threaded of [false, true]) {
test(`Captured original fence ignores ordinary projections and keeps immutable scope (follower=${follower}, Thread=${threaded})`, () => {
  const target = { chatId: 7, ...(threaded ? { threadId: 11 } : {}) }, recipient = completeOriginalRecipient();
  if (threaded) recipient.target = target;
  const registry = Bus.createTelegramBusFollowerRegistry(); registry.register(recipient);
  const runtime = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => "default", listFollowers: registry.list });
  (follower ? runtime.captureFollowerPublication(recipient, target) : runtime.captureLocalPublication(target))(9);
  const captured = runtime.captureOriginalForwardOwnership(7, 9)!;
  assert.ok(captured); captured.assertCurrent();
  assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured.ownership) && Object.isFrozen(captured.ownership.target));
  assert.equal(captured.ownership.instanceId, follower ? "follower" : "leader");
  assert.deepEqual(captured.ownership.target, target);
  assert.equal(captured.recipient, runtime.store.getOriginal(7, 9)!.recipient);
  if (follower) assert.ok(Object.isFrozen(captured.recipient) && Object.isFrozen(captured.recipient!.protocol));
  runtime.recordLocal({ chatId: 7, messageId: 9, target });
  assert.equal(runtime.getForwardOwnership(7, 9)!.instanceId, "leader");
  captured.assertCurrent();
  assert.equal(captured.ownership.instanceId, follower ? "follower" : "leader");
  registry.register({ ...recipient, connectedAtMs: 2 });
  captured.assertCurrent();
});
}

for (const field of ["instanceId", "profileKey", "registrationGeneration", "sessionId", "sessionGeneration", "pid", "processBirthId", "cwd", "busSocketPath", "slot", "target", "protocol"] as const) {
test(`Captured original fence rechecks semantic recipient identity and never revives (${field})`, () => {
  const recipient = completeOriginalRecipient(), registry = Bus.createTelegramBusFollowerRegistry(); registry.register(recipient);
  const runtime = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => "default", listFollowers: registry.list });
  runtime.captureFollowerPublication(recipient, { chatId: 7 })(9);
  const captured = runtime.captureOriginalForwardOwnership(7, 9)!;
  const changed = { ...recipient };
  switch (field) {
    case "instanceId": registry.remove(recipient.instanceId); changed.instanceId = "replacement"; break;
    case "profileKey": changed.profileKey = "manual:other"; break;
    case "registrationGeneration": changed.registrationGeneration = "g2"; break;
    case "sessionId": changed.sessionId = "session-b"; break;
    case "sessionGeneration": changed.sessionGeneration = 4; break;
    case "pid": changed.pid = 102; break;
    case "processBirthId": changed.processBirthId = "birth-b"; break;
    case "cwd": changed.cwd = "/b"; break;
    case "busSocketPath": changed.busSocketPath = "/endpoint-b"; break;
    case "slot": changed.slot = "B"; break;
    case "target": changed.target = { chatId: 7 }; break;
    case "protocol": changed.protocol = { ...recipient.protocol!, runtimeBuild: "other" }; break;
  }
  registry.register(changed);
  assert.throws(captured.assertCurrent, /Original Telegram message receiver is unavailable/);
  assert.equal(runtime.captureOriginalForwardOwnership(7, 9), undefined);
  registry.remove(changed.instanceId); registry.register(recipient);
  assert.ok(runtime.getOriginalForwardOwnership(7, 9), "Fresh metadata is observable again but does not renew an old fence");
  assert.throws(captured.assertCurrent, /unavailable/);
});
}

for (const follower of [false, true]) for (const loss of ["profile", "forget", "forget-target", "prune", "clear"] as const) {
test(`Captured original fence binds exact cache row and profile (follower=${follower}, ${loss})`, () => {
  let profile = "default";
  const recipient = completeOriginalRecipient(), registry = Bus.createTelegramBusFollowerRegistry(); registry.register(recipient);
  const runtime = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => profile, listFollowers: registry.list });
  const publish = () => (follower ? runtime.captureFollowerPublication(recipient, { chatId: 7 }) : runtime.captureLocalPublication({ chatId: 7 }))(9);
  publish(); const captured = runtime.captureOriginalForwardOwnership(7, 9)!;
  if (loss === "profile") profile = "other";
  else if (loss === "forget") runtime.store.forget(7, 9);
  else if (loss === "forget-target") runtime.store.forgetTarget({ chatId: 7 });
  else if (loss === "prune") runtime.store.prune({ now: Date.now(), maxRecords: 0 });
  else runtime.store.clear();
  assert.throws(captured.assertCurrent, /unavailable/);
  profile = "default";
  if (loss !== "profile") publish();
  assert.ok(runtime.captureOriginalForwardOwnership(7, 9));
  assert.throws(captured.assertCurrent, /unavailable/, "An equal recreated row cannot replace the captured row");
});
}

test("Original fence capture refuses missing/incomplete origins and poisons a failed observation", () => {
  let unavailable = false;
  const recipient = completeOriginalRecipient(), registry = Bus.createTelegramBusFollowerRegistry(); registry.register(recipient);
  const runtime = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => "default", listFollowers() {
    if (unavailable) throw new Error("internal observation details"); return registry.list();
  } });
  assert.equal(runtime.captureOriginalForwardOwnership(7, 9), undefined);
  runtime.recordLocal({ chatId: 7, messageId: 10 });
  assert.equal(runtime.captureOriginalForwardOwnership(7, 10), undefined);
  runtime.recordFollower({ chatId: 7, messageId: 11, follower: { instanceId: "incomplete", connectedAtMs: 1 }, retainOriginal: true });
  assert.equal(runtime.captureOriginalForwardOwnership(7, 11), undefined);
  runtime.captureFollowerPublication(recipient, { chatId: 7 })(9);
  const captured = runtime.captureOriginalForwardOwnership(7, 9)!;
  unavailable = true; assert.throws(captured.assertCurrent, /^Error: Original Telegram message receiver is unavailable\.$/);
  unavailable = false; assert.throws(captured.assertCurrent, /unavailable/);
});

for (const mode of ["current", "before-connect-session", "before-write-endpoint", "after-write-session", "after-write-row", "after-write-source"] as const) {
test(`Captured original fence composes with native forwarding boundaries (${mode})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-orig-")), socketPath = Bus.getTelegramBusFollowerSocketPath("follower", dir);
  const recipient = { ...completeOriginalRecipient(), busSocketPath: socketPath }, registry = Bus.createTelegramBusFollowerRegistry();
  registry.register(recipient);
  const runtime = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => "default", listFollowers: registry.list });
  runtime.captureFollowerPublication(recipient, { chatId: 7 })(9);
  const captured = runtime.captureOriginalForwardOwnership(7, 9)!;
  const generic = Bus.createTelegramBusForwardOwnershipValidator(registry);
  const received: Bus.TelegramBusEnvelope[] = [];
  let sourceCurrent = true;
  const server = Bus.createTelegramBusLocalServer({ socketPath, handleEnvelope(envelope) {
    received.push(envelope); assert.equal(envelope.kind, "leader.forwardMessage");
    if (envelope.kind !== "leader.forwardMessage") throw new Error("Unexpected fixture request");
    assert.equal(envelope.auth, "fixture-secret");
    if (mode === "after-write-session") {
      registry.register({ ...recipient, sessionId: "session-b" });
      assert.equal(generic(captured.ownership), true, "Generic generation/protocol checks miss same-generation session drift");
    }
    if (mode === "after-write-row") { runtime.store.forget(7, 9); runtime.captureFollowerPublication(recipient, { chatId: 7 })(9); }
    if (mode === "after-write-source") sourceCurrent = false;
    return { kind: "bus.ack", requestId: envelope.requestId, ok: true,
      result: { deliveryId: envelope.delivery.deliveryId, sourceUpdateId: envelope.delivery.sourceUpdateId } };
  } });
  const forwarder = Bus.createTelegramBusForeignOwnedUpdateForwarder({ socketPath: captured.recipient!.busSocketPath!,
    createRequestId: () => "fixture:original", getAuthSecret: () => "fixture-secret", validateForwardOwnership: generic });
  try {
    await server.start();
    const message = { message_id: 100, pi_telegram_source_update_id: 51, get text() {
      if (mode === "before-write-endpoint") registry.register({ ...recipient, busSocketPath: "/other-endpoint" });
      return "held fixture input";
    } };
    const pending = forwarder.forwardMessage({ message, ownership: captured.ownership, ctx: {}, assertAuthority() {
      if (!sourceCurrent) throw new Error("Fixture source authority ended."); captured.assertCurrent();
    } });
    if (mode === "before-connect-session") queueMicrotask(() => registry.register({ ...recipient, sessionId: "session-b" }));
    const result = await pending;
    assert.equal(result.status, mode === "current" ? "accepted" : "retryable");
    assert.equal(result.delivery?.sourceUpdateId, 51);
    assert.equal(received.length, mode.startsWith("before-") ? 0 : 1, "Stale checks never retry or claim to unsend issued data");
    assert.doesNotMatch(JSON.stringify(received), /assertCurrent|assertAuthority|session-a|busSocketPath|processBirthId/);
    if (mode === "after-write-source") captured.assertCurrent();
  } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});
}

for (const follower of [false, true]) for (const outcome of ["known", "profile-lost", "duplicate", "bad-receipt", "receiver-lost"] as const) {
test(`Captured publication writes one original receipt without retargeting (follower=${follower}, ${outcome})`, () => {
  let profile = "default";
  const registry = Bus.createTelegramBusFollowerRegistry(), recipient = completeOriginalRecipient();
  registry.register(recipient);
  const runtime = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => profile, listFollowers: registry.list });
  const target = { chatId: 7 };
  const publish = follower ? runtime.captureFollowerPublication(recipient, target) : runtime.captureLocalPublication(target);
  target.chatId = 99; recipient.sessionId = "mutated";
  if (outcome === "profile-lost") profile = "other";
  if (outcome === "duplicate") runtime.recordLocal({ chatId: 7, messageId: 101 });
  if (outcome === "receiver-lost" && follower) registry.register({ ...completeOriginalRecipient(), registrationGeneration: "replacement" });
  if (outcome === "known" || outcome === "receiver-lost" && !follower) {
    publish(101);
    const origin = runtime.store.getOriginal(7, 101)!;
    assert.equal(origin.record.target.chatId, 7);
    if (follower) assert.equal(origin.recipient!.sessionId, "session-a");
    assert.throws(() => publish(101), /already observed/);
  } else {
    assert.throws(() => publish(outcome === "bad-receipt" ? 0 : 101));
    if (outcome === "receiver-lost") {
      assert.equal(runtime.store.getOriginal(7, 101)!.record.ownerGeneration, "g1");
      assert.equal(runtime.getOriginalForwardOwnership(7, 101), undefined);
    } else assert.equal(runtime.store.getOriginal(7, 101), undefined);
  }
});
}

test("Publication capture refuses incomplete receivers and mismatched targets before any receipt", () => {
  const registry = Bus.createTelegramBusFollowerRegistry(), recipient = completeOriginalRecipient();
  delete recipient.sessionId;
  registry.register(recipient);
  const runtime = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => "default", listFollowers: registry.list });
  assert.throws(() => runtime.captureFollowerPublication(recipient, { chatId: 7 }), /scope is unavailable/);
  assert.throws(() => runtime.captureLocalPublication({ chatId: 0 }), /scope is unavailable/);
  assert.deepEqual(runtime.store.entries(), []);
});

for (const field of ["profileKey", "registrationGeneration", "sessionId", "sessionGeneration", "pid", "processBirthId", "cwd", "busSocketPath", "protocol"] as const) {
test(`Original forwarding refuses capture-time omissions even when live metadata omits the same field (${field})`, () => {
  const registry = Bus.createTelegramBusFollowerRegistry(), recipient = completeOriginalRecipient();
  delete recipient[field];
  registry.register(recipient);
  const runtime = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => "default", listFollowers: registry.list });
  runtime.recordFollower({ chatId: 7, messageId: 9, follower: recipient, retainOriginal: true });
  assert.ok(runtime.store.getOriginal(7, 9), "Incomplete data may remain diagnostic evidence");
  assert.equal(runtime.getOriginalForwardOwnership(7, 9), undefined, "Equal absence is not complete receiver provenance");
});
}

for (const invalid of ["blank-session", "blank-birth", "blank-cwd", "blank-endpoint", "zero-pid", "fractional-pid", "negative-session", "fractional-session", "bad-connected"] as const) {
test(`Original forwarding refuses malformed required identity (${invalid})`, () => {
  const registry = Bus.createTelegramBusFollowerRegistry(), recipient = completeOriginalRecipient();
  switch (invalid) {
    case "blank-session": recipient.sessionId = " "; break;
    case "blank-birth": recipient.processBirthId = " "; break;
    case "blank-cwd": recipient.cwd = " "; break;
    case "blank-endpoint": recipient.busSocketPath = " "; break;
    case "zero-pid": recipient.pid = 0; break;
    case "fractional-pid": recipient.pid = 1.5; break;
    case "negative-session": recipient.sessionGeneration = -1; break;
    case "fractional-session": recipient.sessionGeneration = 1.5; break;
    case "bad-connected": recipient.connectedAtMs = NaN; break;
  }
  registry.register(recipient);
  const runtime = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => "default", listFollowers: registry.list });
  runtime.recordFollower({ chatId: 7, messageId: 9, follower: recipient, retainOriginal: true });
  assert.equal(runtime.getOriginalForwardOwnership(7, 9), undefined);
});
}

for (const [name, published, registered, expected] of [
  ["Classic omitted target", { chatId: 7 }, undefined, true],
  ["Classic explicit target", { chatId: 7 }, { chatId: 7 }, true],
  ["Classic foreign chat", { chatId: 7 }, { chatId: 8 }, false],
  ["Classic cannot borrow a Thread", { chatId: 7 }, { chatId: 7, threadId: 11 }, false],
  ["Threaded exact target", { chatId: 7, threadId: 11 }, { chatId: 7, threadId: 11 }, true],
  ["Threaded omitted target", { chatId: 7, threadId: 11 }, undefined, false],
  ["Threaded foreign Thread", { chatId: 7, threadId: 11 }, { chatId: 7, threadId: 12 }, false],
  ["Threaded foreign chat", { chatId: 7, threadId: 11 }, { chatId: 8, threadId: 11 }, false],
] as const) {
test(`Original receiver target completeness is explicit (${name})`, () => {
  const registry = Bus.createTelegramBusFollowerRegistry(), recipient = completeOriginalRecipient();
  recipient.target = registered;
  registry.register(recipient);
  const runtime = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => "default", listFollowers: registry.list });
  runtime.recordFollower({ chatId: 7, messageId: 9, target: published, follower: recipient, retainOriginal: true });
  assert.equal(runtime.getOriginalForwardOwnership(7, 9) !== undefined, expected);
});
}

test("Original ownership is immutable metadata while ordinary records and projections still change", () => {
  let resolutions = 0;
  const store = createTelegramMessageOwnershipStore({ isOwnerGenerationLive: () => false,
    resolveOwnerReplacement() { resolutions++; return { instanceId: "replacement", ownerGeneration: "g2" }; } });
  const target = { chatId: 7, threadId: 11 };
  const first = store.record({ chatId: 7, messageId: 9, target, instanceId: "initial", ownerGeneration: "g1", retainOriginal: true, now: 10 });
  const original = store.getOriginal(7, 9)!;
  assert.equal(resolutions, 0, "A provenance read never invokes replacement policy");
  target.threadId = 99; first.instanceId = "mutated";
  assert.equal(original.record.instanceId, "initial");
  assert.deepEqual(original.record.target, { chatId: 7, threadId: 11 });
  assert.ok(Object.isFrozen(original) && Object.isFrozen(original.record) && Object.isFrozen(original.record.target));
  assert.equal(store.get(7, 9)?.instanceId, "replacement");
  assert.equal(resolutions, 1);
  store.record({ chatId: 7, messageId: 9, target: { chatId: 7, threadId: 12 }, instanceId: "refreshed", now: 20 });
  assert.equal(store.get(7, 9)?.instanceId, "refreshed");
  assert.equal(store.getOriginal(7, 9), original);
  assert.equal(original.record.createdAt, 10); assert.equal(original.record.updatedAt, 10);
  assert.equal(store.entries()[0]!.updatedAt, 20);
});

for (const threaded of [false, true]) {
test(`Original forwarding retains exact Classic/Threaded registration without rebind (Thread=${threaded})`, () => {
  const registry = Bus.createTelegramBusFollowerRegistry();
  const target = { chatId: 7, ...(threaded ? { threadId: 11 } : {}) };
  const initial = { instanceId: "original", connectedAtMs: 1, profileKey: "manual:recipient", registrationGeneration: "g1",
    sessionId: "session-a", sessionGeneration: 3, pid: 101, processBirthId: "birth-a", cwd: "/a", busSocketPath: "/endpoint-a", target,
    protocol: Bus.createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: [Bus.TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION] }) };
  registry.register(initial);
  const runtime = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => "default", listFollowers: registry.list });
  runtime.recordFollower({ chatId: 7, messageId: 9, target, follower: initial, retainOriginal: true });
  const original = runtime.store.getOriginal(7, 9)!;
  assert.ok(Object.isFrozen(original.recipient) && Object.isFrozen(original.recipient!.protocol) &&
    Object.isFrozen(original.recipient!.protocol!.capabilities) && Object.isFrozen(original.recipient!.target));
  const candidate = runtime.getOriginalForwardOwnership(7, 9)!;
  assert.equal(Bus.createTelegramBusForwardOwnershipValidator(registry)(candidate), true);
  registry.register({ ...initial, instanceId: "replacement", registrationGeneration: "g2", sessionId: "session-b" });
  assert.equal(runtime.getForwardOwnership(7, 9)?.instanceId, "replacement", "Ordinary replacement still works");
  assert.equal(runtime.getOriginalForwardOwnership(7, 9), undefined, "An SDK origin never follows that replacement");
  assert.equal(runtime.store.getOriginal(7, 9), original);
  runtime.recordFollower({ chatId: 7, messageId: 9, target, follower: { ...initial, instanceId: "replacement", registrationGeneration: "g2" } });
  assert.equal(runtime.getOriginalForwardOwnership(7, 9), undefined, "Explicit refresh cannot rewrite first provenance");
  assert.equal(candidate.instanceId, "original"); assert.equal(Bus.createTelegramBusForwardOwnershipValidator(registry)(candidate), false);
});
}

for (const drift of ["instance", "generation", "binding", "session", "session-generation", "pid", "birth", "cwd", "endpoint", "target", "protocol", "capability", "missing-generation", "missing-protocol"] as const) {
test(`Original forwarding refuses changed or incomplete receiver identity (${drift})`, () => {
  const registry = Bus.createTelegramBusFollowerRegistry();
  const initial = { instanceId: "follower", connectedAtMs: 1, profileKey: "manual:recipient", registrationGeneration: "g1",
    sessionId: "session-a", sessionGeneration: 3, pid: 101, processBirthId: "birth-a", cwd: "/a", busSocketPath: "/endpoint-a", target: { chatId: 7, threadId: 11 },
    protocol: Bus.createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: [Bus.TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION] }) };
  registry.register(initial);
  const runtime = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => "default", listFollowers: registry.list });
  runtime.recordFollower({ chatId: 7, messageId: 9, target: initial.target, follower: initial, retainOriginal: true });
  const changed: Bus.TelegramBusInstanceRegistration = { ...initial };
  switch (drift) {
    case "instance": changed.instanceId = "other"; break;
    case "generation": changed.registrationGeneration = "g2"; break;
    case "binding": changed.profileKey = "manual:other"; break;
    case "session": changed.sessionId = "session-b"; break;
    case "session-generation": changed.sessionGeneration = 4; break;
    case "pid": changed.pid = 102; break;
    case "birth": changed.processBirthId = "birth-b"; break;
    case "cwd": changed.cwd = "/b"; break;
    case "endpoint": changed.busSocketPath = "/endpoint-b"; break;
    case "target": changed.target = { chatId: 7, threadId: 12 }; break;
    case "protocol": changed.protocol = Bus.createTelegramBusProtocolIdentity({ runtimeBuild: "new", capabilities: initial.protocol.capabilities }); break;
    case "capability": changed.protocol = Bus.createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: [] }); break;
    case "missing-generation": changed.registrationGeneration = undefined; break;
    case "missing-protocol": changed.protocol = undefined; break;
  }
  registry.register(changed);
  assert.equal(runtime.getOriginalForwardOwnership(7, 9), undefined);
  assert.equal(runtime.store.getOriginal(7, 9)!.record.ownerGeneration, "g1");
});
}

for (const changedField of ["generation", "session"] as const) {
test(`Original forwarding is a fresh candidate, not a retained RPC grant (${changedField})`, () => {
  const registry = Bus.createTelegramBusFollowerRegistry();
  const initial = { instanceId: "follower", connectedAtMs: 1, profileKey: "manual:recipient", registrationGeneration: "g1", sessionId: "session-a", sessionGeneration: 3,
    pid: 101, processBirthId: "birth-a", cwd: "/a", busSocketPath: "/endpoint-a",
    protocol: Bus.createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: [Bus.TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION] }) };
  registry.register(initial);
  let replace = false;
  const runtime = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => "default", listFollowers() {
    const snapshot = registry.list();
    if (replace) { replace = false; registry.register({ ...initial,
      ...(changedField === "generation" ? { registrationGeneration: "g2" } : { sessionId: "session-b" }) }); }
    return snapshot;
  } });
  runtime.recordFollower({ chatId: 7, messageId: 9, follower: initial, retainOriginal: true });
  replace = true;
  const stale = runtime.getOriginalForwardOwnership(7, 9)!;
  assert.equal(stale.ownerGeneration, "g1");
  assert.equal(Bus.createTelegramBusForwardOwnershipValidator(registry)(stale), changedField === "session",
    "The generic generation/protocol validator is not a full original-session fence");
  assert.equal(runtime.getOriginalForwardOwnership(7, 9), undefined);
});
}

test("Opted-in receiver provenance snapshots caller objects without changing ordinary cache semantics", () => {
  const registry = Bus.createTelegramBusFollowerRegistry();
  const initial = { instanceId: "follower", connectedAtMs: 1, profileKey: "manual:recipient", registrationGeneration: "g1", sessionId: "session-a", sessionGeneration: 3,
    pid: 101, processBirthId: "birth-a", cwd: "/a", busSocketPath: "/endpoint-a",
    target: { chatId: 7, threadId: 11 },
    protocol: Bus.createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: [Bus.TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION] }) };
  registry.register(initial);
  const runtime = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => "default", listFollowers: registry.list });
  runtime.recordFollower({ chatId: 7, messageId: 9, target: initial.target, follower: initial, retainOriginal: true });
  initial.target.threadId = 12; initial.sessionId = "mutated"; initial.protocol.capabilities.push("extra-capability");
  const origin = runtime.store.getOriginal(7, 9)!;
  assert.equal(origin.recipient!.sessionId, "session-a"); assert.deepEqual(origin.recipient!.protocol!.capabilities, [Bus.TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION]);
  assert.equal(origin.record.target.threadId, 11);
  assert.equal(runtime.store.get(7, 9)!.target.threadId, 12, "Existing current-record alias behavior is preserved");
  assert.equal(runtime.getOriginalForwardOwnership(7, 9)!.target!.threadId, 11);
  registry.heartbeat("follower", 100);
  assert.equal(runtime.getOriginalForwardOwnership(7, 9)!.instanceId, "follower", "A heartbeat is not a new receiver");
});

for (const retainFirst of [false, true]) {
test(`A later complete registration cannot upgrade missing original provenance (retained=${retainFirst})`, () => {
  const registry = Bus.createTelegramBusFollowerRegistry();
  const runtime = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => "default", listFollowers: registry.list });
  runtime.recordRouted({ chatId: 7, messageId: 9, instanceId: "follower", retainOriginal: retainFirst });
  const initial = { instanceId: "follower", connectedAtMs: 1, profileKey: "manual:recipient", registrationGeneration: "g1",
    sessionId: "session-a", sessionGeneration: 3, pid: 101, processBirthId: "birth-a", cwd: "/a", busSocketPath: "/endpoint-a",
    protocol: Bus.createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: [Bus.TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION] }) };
  registry.register(initial);
  runtime.recordFollower({ chatId: 7, messageId: 9, follower: initial, retainOriginal: true });
  assert.equal(runtime.getForwardOwnership(7, 9)?.protocolIdentity?.runtimeBuild, "fixture");
  assert.equal(runtime.getOriginalForwardOwnership(7, 9), undefined);
  runtime.recordFollower({ chatId: 7, messageId: 10, follower: initial, retainOriginal: true });
  assert.equal(runtime.getOriginalForwardOwnership(7, 10)?.instanceId, "follower");
});
}

test("Original provenance shares profile isolation and the current record's retention", () => {
  let profile = "a";
  const store = createTelegramMessageOwnershipStore({ getProfileKey: () => profile });
  const record = (messageId: number, now = 1) => store.record({ chatId: 7, messageId, instanceId: profile, retainOriginal: true, now });
  record(1);
  profile = "b"; assert.equal(store.getOriginal(7, 1), undefined); record(1, 2);
  assert.equal(store.getOriginal(7, 1)!.record.instanceId, "b");
  profile = "a"; assert.equal(store.getOriginal(7, 1)!.record.instanceId, "a");
  assert.equal(store.forget(7, 1), true); assert.equal(store.getOriginal(7, 1), undefined);
  profile = "b"; assert.equal(store.getOriginal(7, 1)!.record.instanceId, "b");
  record(2, 3); assert.equal(store.forgetTarget({ chatId: 7 }), 2); assert.equal(store.getOriginal(7, 1), undefined);
  record(3, 10); record(4, 20); store.prune({ now: 30, maxAgeMs: 15 }); assert.equal(store.getOriginal(7, 3), undefined);
  record(5, 30); store.prune({ now: 30, maxRecords: 1 }); assert.equal(store.getOriginal(7, 4), undefined);
  assert.equal(store.getOriginal(7, 5)!.record.instanceId, "b");
  store.clear(); assert.equal(store.getOriginal(7, 5), undefined);
});

test("Local origin remains local after an ordinary owner refresh and missing origins stay unavailable", () => {
  let profile = "default";
  const runtime = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => profile, listFollowers: () => [] });
  const first = runtime.recordLocal({ chatId: 7, messageId: 9, target: { chatId: 7, threadId: 11 }, retainOriginal: true });
  runtime.store.record({ chatId: 7, messageId: 9, instanceId: "other", target: { chatId: 7, threadId: 12 } });
  assert.deepEqual(runtime.getOriginalForwardOwnership(7, 9), first);
  assert.equal(runtime.getOriginalForwardOwnership(7, 10), undefined);
  profile = "other"; assert.equal(runtime.getOriginalForwardOwnership(7, 9), undefined);
});

test("Bus ownership runtime rebinds stable follower authority to a replacement generation", () => {
  let followers = [
    {
      instanceId: "follower-a",
      connectedAtMs: 10,
      profileKey: "manual:owner-a",
      registrationGeneration: "generation-a",
    },
  ];
  const runtime = createTelegramBusMessageOwnershipRuntime({
    instanceId: "leader",
    getProfileKey: () => "default",
    listFollowers: () => followers,
  });
  runtime.recordRouted({
    chatId: 7,
    messageId: 9,
    target: { chatId: 7, threadId: 11 },
    instanceId: "follower-a",
  });

  assert.equal(
    runtime.isOwnedByFollower({
      chatId: 7,
      messageId: 9,
      follower: followers[0]!,
    }),
    true,
  );
  assert.equal(
    runtime.store.get(7, 9)?.recipientBindingKey,
    "manual:owner-a",
  );
  followers = [
    {
      instanceId: "follower-b",
      connectedAtMs: 20,
      profileKey: "manual:owner-a",
      registrationGeneration: "generation-b",
    },
  ];
  assert.deepEqual(runtime.store.get(7, 9), {
    chatId: 7,
    messageId: 9,
    target: { chatId: 7, threadId: 11 },
    instanceId: "follower-b",
    profileKey: "default",
    ownerGeneration: "generation-b",
    recipientBindingKey: "manual:owner-a",
    createdAt: runtime.store.entries()[0]!.createdAt,
    updatedAt: runtime.store.entries()[0]!.updatedAt,
  });
  assert.equal(
    runtime.isOwnedByFollower({
      chatId: 7,
      messageId: 9,
      follower: followers[0]!,
    }),
    true,
  );
});

test("Forward ownership projects current protocol without caching it across registration changes", () => {
  const registry = Bus.createTelegramBusFollowerRegistry();
  let profileKey = "default";
  const runtime = createTelegramBusMessageOwnershipRuntime({
    instanceId: "leader", getProfileKey: () => profileKey, listFollowers: registry.list,
  });
  const validate = Bus.createTelegramBusForwardOwnershipValidator(registry);
  const registration = {
    instanceId: "follower", connectedAtMs: 1, profileKey: "manual:recipient",
    registrationGeneration: "g1",
    protocol: Bus.createTelegramBusProtocolIdentity({
      runtimeBuild: "fixture",
      capabilities: [Bus.TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION],
    }),
  };
  registry.register(registration);
  runtime.recordRouted({ chatId: 7, messageId: 9, instanceId: "follower" });
  const initial = runtime.getForwardOwnership(7, 9)!;
  assert.equal(validate(initial), true);
  assert.deepEqual(initial.protocolIdentity, registration.protocol);
  assert.equal("protocolIdentity" in runtime.store.get(7, 9)!, false);
  const upgraded = Bus.createTelegramBusProtocolIdentity({
    runtimeBuild: "fixture-upgrade",
    capabilities: [Bus.TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
      Bus.TELEGRAM_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE],
  });
  registry.register({ ...registration, protocol: upgraded });
  const current = runtime.getForwardOwnership(7, 9)!;
  assert.equal(validate(initial), false);
  assert.equal(validate(current), true);
  assert.deepEqual(current.protocolIdentity, upgraded);
  assert.deepEqual(initial.protocolIdentity, registration.protocol);
  registry.register({ ...registration, instanceId: "replacement", registrationGeneration: "g2" });
  const replacement = runtime.getForwardOwnership(7, 9)!;
  assert.equal(validate(current), false);
  assert.equal(validate(replacement), true);
  assert.equal(replacement.instanceId, "replacement");
  assert.equal(replacement.ownerGeneration, "g2");
  assert.equal(replacement.recipientBindingKey, registration.profileKey);
  assert.deepEqual(replacement.protocolIdentity, registration.protocol);
  assert.equal("protocolIdentity" in runtime.store.get(7, 9)!, false);
  registry.remove("replacement");
  assert.equal(validate(replacement), false);
  assert.equal(runtime.getForwardOwnership(7, 9), undefined);
  assert.equal(runtime.store.entries().length, 1);
  registry.register(registration);
  assert.equal(validate(runtime.getForwardOwnership(7, 9)!), true);
  profileKey = "other-bot";
  assert.equal(runtime.getForwardOwnership(7, 9), undefined);
  const local = runtime.recordLocal({ chatId: 7, messageId: 9 });
  assert.deepEqual(runtime.getForwardOwnership(7, 9), local);
  assert.equal(runtime.getForwardOwnership(7, 10), undefined);
});

test("Forward ownership leaves incomplete or mismatched registrations fail-closed", () => {
  const registration = {
    instanceId: "follower", connectedAtMs: 1, profileKey: "manual:recipient",
    registrationGeneration: "g1",
    protocol: Bus.createTelegramBusProtocolIdentity({
      runtimeBuild: "fixture",
      capabilities: [Bus.TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION],
    }),
  };
  const cases: Array<[string, Partial<Bus.TelegramBusInstanceRegistration>]> = [
    ["changed binding", { profileKey: "manual:other" }],
    ["missing binding", { profileKey: undefined }],
    ["missing generation", { registrationGeneration: undefined }],
    ["missing protocol", { protocol: undefined }],
    ["missing capability", { protocol: Bus.createTelegramBusProtocolIdentity({
      runtimeBuild: "fixture", capabilities: [],
    }) }],
  ];
  for (const [name, override] of cases) {
    const registry = Bus.createTelegramBusFollowerRegistry();
    registry.register(registration);
    const runtime = createTelegramBusMessageOwnershipRuntime({
      instanceId: "leader", getProfileKey: () => "default", listFollowers: registry.list,
    });
    runtime.recordFollower({ chatId: 7, messageId: 9, follower: registration });
    registry.register({ ...registration, ...override });
    const snapshot = runtime.getForwardOwnership(7, 9);
    assert.ok(snapshot, `${name}: retain known foreign ownership`);
    assert.equal(snapshot.instanceId, "follower", name);
    assert.equal(snapshot.recipientBindingKey, "manual:recipient", name);
    assert.equal(snapshot.protocolIdentity, undefined, name);
    assert.equal(Bus.createTelegramBusForwardOwnershipValidator(registry)(snapshot), false, name);
  }
});

test("Registration replacement during cache lookup rejects that snapshot but permits a fresh retry", () => {
  const registry = Bus.createTelegramBusFollowerRegistry();
  const registration = {
    instanceId: "follower", connectedAtMs: 1, profileKey: "manual:recipient",
    registrationGeneration: "g1",
    protocol: Bus.createTelegramBusProtocolIdentity({
      runtimeBuild: "fixture",
      capabilities: [Bus.TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION],
    }),
  };
  registry.register(registration);
  let replace = false;
  const runtime = createTelegramBusMessageOwnershipRuntime({
    instanceId: "leader", getProfileKey: () => "default",
    listFollowers() {
      const followers = registry.list();
      if (replace) {
        replace = false;
        registry.register({ ...registration, registrationGeneration: "g2" });
      }
      return followers;
    },
  });
  runtime.recordRouted({ chatId: 7, messageId: 9, instanceId: "follower" });
  replace = true;
  const stale = runtime.getForwardOwnership(7, 9)!;
  const validate = Bus.createTelegramBusForwardOwnershipValidator(registry);
  assert.equal(stale.ownerGeneration, "g1");
  assert.equal(validate(stale), false);
  const current = runtime.getForwardOwnership(7, 9)!;
  assert.equal(current.ownerGeneration, "g2");
  assert.equal(validate(current), true);
});

test("Message ownership records default private targets", () => {
  const store = createTelegramMessageOwnershipStore();
  const record = store.record({
    chatId: 7,
    messageId: 9,
    instanceId: "instance-a",
    now: 100,
  });
  assert.deepEqual(record, {
    chatId: 7,
    messageId: 9,
    target: { chatId: 7 },
    instanceId: "instance-a",
    createdAt: 100,
    updatedAt: 100,
  });
  assert.deepEqual(store.get(7, 9), record);
  assert.equal(store.getOriginal(7, 9), undefined, "Ordinary records do not retain receiver snapshots");
});

test("Message ownership preserves createdAt when ownership is refreshed", () => {
  const store = createTelegramMessageOwnershipStore();
  store.record({
    chatId: -1007,
    messageId: 11,
    target: createTelegramThreadTarget(-1007, 42),
    instanceId: "instance-a",
    now: 100,
  });
  const refreshed = store.record({
    chatId: -1007,
    messageId: 11,
    target: createTelegramThreadTarget(-1007, 43),
    instanceId: "instance-b",
    now: 150,
  });
  assert.deepEqual(refreshed, {
    chatId: -1007,
    messageId: 11,
    target: createTelegramThreadTarget(-1007, 43),
    instanceId: "instance-b",
    createdAt: 100,
    updatedAt: 150,
  });
});

test("Message ownership can forget a whole target", () => {
  const store = createTelegramMessageOwnershipStore();
  store.record({
    chatId: -1007,
    messageId: 1,
    target: createTelegramThreadTarget(-1007, 42),
    instanceId: "instance-a",
    now: 1,
  });
  store.record({
    chatId: -1007,
    messageId: 2,
    target: createTelegramThreadTarget(-1007, 42),
    instanceId: "instance-a",
    now: 2,
  });
  store.record({
    chatId: -1007,
    messageId: 3,
    target: createTelegramThreadTarget(-1007, 43),
    instanceId: "instance-b",
    now: 3,
  });
  assert.equal(store.forgetTarget(createTelegramThreadTarget(-1007, 42)), 2);
  assert.equal(store.get(-1007, 1), undefined);
  assert.equal(store.get(-1007, 2), undefined);
  assert.equal(store.get(-1007, 3)?.instanceId, "instance-b");
});

test("Message ownership isolates bot profiles and rejects stale follower generations", () => {
  let profileKey = "work";
  let liveGeneration = "follower-a:100";
  const store = createTelegramMessageOwnershipStore({
    getProfileKey: () => profileKey,
    isOwnerGenerationLive: (record) =>
      record.ownerGeneration === liveGeneration,
  });
  store.record({
    chatId: 7,
    messageId: 9,
    instanceId: "follower-a",
    ownerGeneration: "follower-a:100",
    now: 100,
  });
  assert.equal(store.get(7, 9)?.instanceId, "follower-a");

  profileKey = "personal";
  assert.equal(store.get(7, 9), undefined);
  store.record({
    chatId: 7,
    messageId: 9,
    instanceId: "follower-b",
    ownerGeneration: "follower-b:200",
    now: 200,
  });
  liveGeneration = "follower-b:200";
  assert.equal(store.get(7, 9)?.instanceId, "follower-b");

  profileKey = "work";
  liveGeneration = "follower-a:101";
  assert.equal(store.get(7, 9), undefined);
  assert.equal(store.entries().length, 2);
});

test("Message ownership prunes by age and record count", () => {
  const store = createTelegramMessageOwnershipStore();
  store.record({ chatId: 7, messageId: 1, instanceId: "a", now: 10 });
  store.record({ chatId: 7, messageId: 2, instanceId: "a", now: 20 });
  store.record({ chatId: 7, messageId: 3, instanceId: "a", now: 30 });
  assert.equal(store.prune({ now: 40, maxAgeMs: 25 }), 1);
  assert.equal(store.get(7, 1), undefined);
  assert.equal(store.prune({ now: 40, maxRecords: 1 }), 1);
  assert.deepEqual(
    store.entries().map((record) => record.messageId),
    [3],
  );
});
