/**
 * Regression tests for Telegram multi-instance bus helpers
 * Covers the serializable leader/follower IPC contract and live follower registry behavior
 */

import assert from "node:assert/strict";
import {
  existsSync,
  readdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import {
  classifyTelegramBusTransportError,
  getTelegramBusFollowerEndpoint,
  getTelegramBusLeaderEndpoint,
  getTelegramBusTransportKind,
  getTelegramBusTransportRetryPolicy,
  probeTelegramBusEndpoint,
} from "../lib/bus-transport.ts";
for (const artifact of ["source", "compiled"] as const) for (const mode of ["empty", "supported", "legacy", "local-legacy", "no-generation", "heartbeat", "replacement", "add-remove", "remove", "clear", "prune", "provider", "local-loss", "remove-absent"] as const)
test(`Native orphan reader capture owns the whole original membership (${artifact}/${mode})`, async () => {
  const createRegistry = (artifact === "source" ? createTelegramBusFollowerRegistry : (await import("../dist/lib/bus.js")).createTelegramBusFollowerRegistry) as typeof createTelegramBusFollowerRegistry;
  const registry = createRegistry(), capability = TELEGRAM_BUS_CAPABILITY_ORPHAN_INTENT_READER;
  const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "same-build", capabilities: [capability] });
  const local = createTelegramBusProtocolIdentity({ runtimeBuild: "same-build", capabilities: mode === "local-legacy" ? [] : [capability] });
  const row = { instanceId: "reader", profileKey: "manual:reader", registrationGeneration: "g1", connectedAtMs: 1, protocol };
  if (mode !== "empty") registry.register({ ...row, ...(mode === "no-generation" ? { registrationGeneration: undefined } : {}),
    ...(mode === "legacy" ? { protocol: createTelegramBusProtocolIdentity({ runtimeBuild: "same-build", capabilities: [] }) } : {}) });
  assert.equal(typeof registry.captureOrphanIntentReaderCompatibility, "function");
  const current = registry.captureOrphanIntentReaderCompatibility!(local);
  if (["legacy", "local-legacy", "no-generation"].includes(mode)) { assert.equal(current, undefined); return; }
  assert.ok(current); assert.equal(current(), true);
  if (mode === "heartbeat") registry.heartbeat("reader", 2000);
  if (mode === "remove-absent") registry.remove("absent");
  if (mode === "replacement") registry.register(row);
  if (mode === "add-remove") { registry.register({ ...row, instanceId: "transient", profileKey: "manual:transient" }); registry.remove("transient"); }
  if (mode === "remove") registry.remove("reader");
  if (mode === "clear") registry.clear();
  if (mode === "prune") registry.pruneStale(10000, 1);
  if (mode === "provider") { const list = registry.list; registry.list = () => []; assert.equal(current(), false); registry.list = list; }
  if (mode === "local-loss") { local.capabilities = []; assert.equal(current(), false); local.capabilities = [capability]; }
  const live = ["empty", "supported", "heartbeat", "remove-absent"].includes(mode);
  assert.equal(current(), live);
  if (!live) { registry.clear(); registry.register(row); assert.equal(current(), false, "Equal restored roster/provider fields cannot revive a spent capture"); }
});

for (const artifact of ["source", "compiled"] as const) for (const localV2 of [false, true]) for (const remoteV2 of [false, true])
test(`Orphan issued-state reader support is negotiated independently (${artifact}/${localV2}/${remoteV2})`, async () => {
  const createRegistry = (artifact === "source" ? createTelegramBusFollowerRegistry : (await import("../dist/lib/bus.js")).createTelegramBusFollowerRegistry) as typeof createTelegramBusFollowerRegistry;
  const protocol = (v2: boolean) => createTelegramBusProtocolIdentity({ runtimeBuild: "same-build", capabilities: [TELEGRAM_BUS_CAPABILITY_ORPHAN_INTENT_READER,
    ...(v2 ? [TELEGRAM_BUS_CAPABILITY_ORPHAN_CLEANUP_READER] : [])] });
  const registry = createRegistry(), local = protocol(localV2);
  registry.register({ instanceId: "reader", registrationGeneration: "g1", connectedAtMs: 1, protocol: protocol(remoteV2) });
  assert.equal(registry.captureOrphanIntentReaderCompatibility!(local)?.(), true, "V1 still suffices for an unissued intent");
  const cleanup = registry.captureOrphanIntentReaderCompatibility!(local, "cleanup");
  assert.equal(cleanup?.() === true, localV2 && remoteV2, "Equal builds or V1 do not certify the issued codec");
});

test("Attachment publication receipt is bounded immutable evidence and never a default capability", () => {
  const raw = { version: 1, requestId: "publication", nonce: "a".repeat(32), instanceId: "follower", registrationGeneration: "g1", registrationIncarnation: "b".repeat(48),
    botId: 777, messageId: 501, target: { chatId: 7, threadId: 11 } };
  const receipt = parseTelegramBusAttachmentPublicationReceipt(raw); assert.ok(receipt && Object.isFrozen(receipt) && Object.isFrozen(receipt.target));
  raw.target.chatId = 99; assert.equal(receipt.target.chatId, 7);
  for (const changed of [{ version: 2 }, { requestId: "" }, { requestId: "x".repeat(513) }, { nonce: "a".repeat(33) },
    { instanceId: "bad\ninstance" }, { registrationGeneration: null }, { registrationIncarnation: "" }, { registrationIncarnation: "x".repeat(48) }, { botId: 0 }, { messageId: 1.5 }, { unknown: true },
    { target: { chatId: 0 } }, { target: { chatId: 7, threadId: -1 } }, { target: { chatId: 7, extra: true } }])
    assert.equal(parseTelegramBusAttachmentPublicationReceipt({ ...raw, ...changed }), undefined);
  assert.equal(createTelegramCurrentBusProtocolIdentity().capabilities.includes(TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION), false);
  const envelope = { kind: "follower.callApi", requestId: "publication", instanceId: "follower", registrationGeneration: "g1",
    attachmentRegistrationIncarnation: "b".repeat(48), method: "call", args: ["sendMessage", {}], sentAtMs: 1 };
  assert.deepEqual(parseTelegramBusEnvelope(JSON.stringify(envelope)), envelope);
  for (const invalid of [null, "", "b".repeat(47), "x".repeat(48), 42])
    assert.equal(parseTelegramBusEnvelope(JSON.stringify({ ...envelope, attachmentRegistrationIncarnation: invalid })), undefined);
});

import {
  createCurrentTelegramBusProcessRuntime,
  parseTelegramBusAttachmentPublicationReceipt,
  createTelegramCurrentBusProtocolIdentity,
  TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION,
  TELEGRAM_BUS_CAPABILITY_ORPHAN_INTENT_READER,
  TELEGRAM_BUS_CAPABILITY_ORPHAN_CLEANUP_READER,
  parseTelegramBusArtifactDocument,
  canUseTelegramBusInputCustodyReference,
  createTelegramBusFollowerDeliveryIdentity,
  createTelegramBusForwardOwnershipValidator,
  createTelegramBusFollowerSourceReferenceDeliveryIdentity,
  createTelegramBusFollowerRegistry,
  type TelegramBusEnvelope,
  createTelegramBusProtocolIdentity,
  createTelegramBusLiveRebindController,
  createTelegramBusForeignOwnedUpdateForwarder,
  createTelegramFollowerApiCallAuthorizer,
  createTelegramBusLocalServer,
  createTelegramBusProcessRuntime,
  createTelegramBusRequestId,
  createTelegramBusRequestIdFactory,
  encodeTelegramBusEnvelope,
  getTelegramBusEnvelopeTrafficClass,
  getTelegramBusFollowerSocketPath,
  getTelegramBusProtocolCompatibility,
  getTelegramBusSocketPath,
  getTelegramFollowerTargetOwnership,
  hasTelegramBusCapability,
  isTelegramBusEnvelopeAuthorized,
  isTelegramBusForwardOwnershipCurrent,
  isTelegramFollowerApiCallAllowed,
  isSameTelegramBusFollowerRegistration,
  markTelegramBusCrossTargetDelivery,
  parseTelegramBusEnvelope,
  probeTelegramBusLeader,
  proveTelegramBusLeaderUnresponsive,
  rejectTelegramBusRequest,
  resolveTelegramBusSocketPath,
  stripTelegramBusApiMetadata,
  sendTelegramBusLocalEnvelope,
  TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
  TELEGRAM_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE,
  TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF,
  TELEGRAM_BUS_CAPABILITY_QUEUE_STEER,
  hasTelegramBusSteerQueueHandoffCapability,
  TELEGRAM_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT,
  TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME,
  TELEGRAM_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT,
  TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY,
} from "../lib/bus.ts";
import { getTelegramProcessBirthIdentityLiveness } from "../lib/process-identity.ts";
import {
  getTelegramThreadOwnerFromProfileKey,
  getTelegramThreadOwnerKey,
} from "../lib/threads.ts";

function selectedCommandInputWire(kind: "leader.prepareLiveRebind" | "leader.applyLiveRebind" | "leader.settleLiveRebind", name = "status") {
  return { kind, requestId: "status", auth: "secret", recipientInstanceId: "follower", recipientRegistrationGeneration: "registration",
    recipientSessionId: "session", recipientBindingKey: "journal", operationId: "live", sentAtMs: 1000,
    selectedCommand: { name, target: { chatId: 7, threadId: 42 } },
    ...(kind === "leader.prepareLiveRebind" ? { updates: [{ update_id: 100, message: { text: `/${name}` } }] } : { sourceUpdateIds: [100], mode: kind === "leader.applyLiveRebind" ? "apply" : "release",
      preparedSource: { journalBindingKey: "journal", updateId: 100, sourceSha256: "a".repeat(64) } }) };
}

for (const fault of ["current", "missing-old", "foreign-old", "source", "unknown-mode"] as const) {
  test(`Pre-dispatch work observation is an exact read-only wire branch (${fault})`, () => {
    const wire: Record<string, unknown> = { ...selectedCommandInputWire("leader.settleLiveRebind"),
      mode: fault === "unknown-mode" ? "observe-hold" : "observe-held", oldTarget: { chatId: 7, threadId: 11 } };
    if (fault === "missing-old") delete wire.oldTarget;
    if (fault === "foreign-old") wire.oldTarget = { chatId: 7, threadId: 0 };
    if (fault === "source") wire.sourceUpdateIds = [101];
    const parsed = parseTelegramBusEnvelope(JSON.stringify(wire));
    assert.equal(!!parsed, fault === "current");
    if (parsed) {
      assert.equal(parsed.kind, "leader.settleLiveRebind");
      assert.equal(Reflect.get(parsed, "mode"), "observe-held");
      assert.equal(Reflect.get(parsed, "updates"), undefined);
    }
  });
}

for (const name of ["status", "abort"] as const) for (const kind of ["leader.prepareLiveRebind", "leader.applyLiveRebind", "leader.settleLiveRebind"] as const) {
  for (const mode of ["current", "legacy", "null", "other", "extra", "callback", "no-target", "target-extra", "negative", "all", "group", "raw-method", "thread-zero", "thread-float"] as const) {
    test(`Selected command input wire never downgrades branch/target into generic input (${name}/${kind}/${mode})`, () => {
      const wire: Record<string, unknown> = selectedCommandInputWire(kind, name), descriptor = wire.selectedCommand as { name: string; target: Record<string, unknown> };
      if (mode === "legacy") { delete wire.selectedCommand; delete wire.preparedSource; }
      if (mode === "null") wire.selectedCommand = null;
      if (mode === "other") descriptor.name = "generated-prompt";
      if (mode === "extra") Object.assign(descriptor, { execute: "raw" });
      if (mode === "callback") Object.assign(descriptor, { assertAuthority: "callback" });
      if (mode === "no-target") Reflect.deleteProperty(descriptor, "target");
      if (mode === "target-extra") descriptor.target.slot = "A";
      if (mode === "negative") descriptor.target.chatId = -7;
      if (mode === "all") Reflect.deleteProperty(descriptor.target, "threadId");
      if (mode === "thread-zero") descriptor.target.threadId = 0;
      if (mode === "thread-float") descriptor.target.threadId = 42.5;
      if (mode === "group") { if (kind === "leader.prepareLiveRebind") (wire.updates as unknown[]).push({ update_id: 101 }); else (wire.sourceUpdateIds as number[]).push(101); }
      if (mode === "raw-method") wire.method = "sendMessage";
      const parsed = parseTelegramBusEnvelope(JSON.stringify(wire));
      if (["current", "legacy"].includes(mode)) assert.deepEqual(parsed, wire); else assert.equal(parsed, undefined);
    });
  }
}

for (const kind of ["leader.prepareLiveRebind", "leader.applyLiveRebind", "leader.settleLiveRebind"] as const) for (const legacy of ["status-field", "abort-kind", "dual-marker", "status-mode"] as const) {
  test(`Unified command wire refuses retired markers and observation mode without a shim (${kind}/${legacy})`, () => {
    const wire: Record<string, unknown> = selectedCommandInputWire(kind, "abort");
    if (legacy === "status-field" || legacy === "dual-marker") {
      wire.selectedStatus = { kind: "status", target: { chatId: 7, threadId: 42 } };
      if (legacy === "status-field") delete wire.selectedCommand;
    }
    if (legacy === "abort-kind") wire.selectedCommand = { kind: "abort", target: { chatId: 7, threadId: 42 } };
    if (legacy === "status-mode") wire.mode = "observe-status";
    assert.equal(parseTelegramBusEnvelope(JSON.stringify(wire)), undefined);
  });
}

for (const kind of ["leader.applyLiveRebind", "leader.settleLiveRebind"] as const) for (const mode of ["missing", "id", "key", "hash", "extra", "unmarked"] as const) {
  test(`Prepared status source wire is exact expected evidence, not a completion grant (${kind}/${mode})`, () => {
    const wire: Record<string, unknown> = selectedCommandInputWire(kind), source = wire.preparedSource as Record<string, unknown>;
    if (mode === "missing") delete wire.preparedSource;
    if (mode === "id") source.updateId = 101;
    if (mode === "key") source.journalBindingKey = "foreign";
    if (mode === "hash") source.sourceSha256 = "not-a-digest";
    if (mode === "extra") source.completionSha256 = "a".repeat(64);
    if (mode === "unmarked") delete wire.selectedCommand;
    assert.equal(parseTelegramBusEnvelope(JSON.stringify(wire)), undefined);
  });
}

for (const mode of ["current", "generic", "legacy-mode", "without-branch", "old-target", "proof-missing"] as const) {
  test(`Status completion observation wire has no generic release/work fallback (${mode})`, () => {
    const wire: Record<string, unknown> = { ...selectedCommandInputWire("leader.settleLiveRebind"), mode: "observe-command" };
    if (mode === "generic") wire.mode = "observe";
    if (mode === "legacy-mode") wire.mode = "status-result";
    if (mode === "without-branch") { delete wire.selectedCommand; delete wire.preparedSource; }
    if (mode === "old-target") wire.oldTarget = { chatId: 7, threadId: 10 };
    if (mode === "proof-missing") delete wire.preparedSource;
    assert.deepEqual(parseTelegramBusEnvelope(JSON.stringify(wire)), mode === "current" ? wire : undefined);
  });
}

for (const mode of ["completed", "unknown", "not-issued", "no-ack", "released", "wrong-source", "extra-source", "extra-result", "extra-recipient", "bad-command", "not-issued-ack", "wrong-key", "missing-proof", "lost-response"] as const) {
  test(`Status completion controller observes exact expected source without issuing work (${mode})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-status-observe-")), socketPath = getTelegramBusSocketPath(dir, process.platform, "observe", "consolidated");
    const preparedSource = { journalBindingKey: "journal", updateId: 100, sourceSha256: "a".repeat(64) }, selectedCommand = { name: "status" as const, target: { chatId: 7, threadId: 42 } };
    const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: ["live-thread-rebind-save-v1", "live-thread-rebind-apply-v1", "live-thread-rebind-settle-v1", "live-thread-rebind-command-set-v1", "selected-menu-delivery-v1"] });
    let calls = 0;
    const server = createTelegramBusLocalServer({ socketPath, handleEnvelope(envelope) {
      calls++; assert.equal(envelope.kind, "leader.settleLiveRebind"); assert.equal(Reflect.get(envelope, "mode"), "observe-command");
      if (mode === "lost-response") return undefined;
      const result = { operationId: "live", recipient: { instanceId: "follower", sessionId: "session", generation: "registration", bindingKey: "journal", ...(mode === "extra-recipient" ? { receipt: "borrowed" } : {}) },
        sourceUpdateIds: [100], selectedCommand, preparedSource: mode === "missing-proof" ? undefined : preparedSource,
        status: mode === "released" ? "released" : "command-observed", command: mode === "bad-command" ? "delivered" : mode === "unknown" ? "unknown" : mode === "not-issued" || mode === "not-issued-ack" ? "not-issued" : "completed",
        ...(["not-issued", "no-ack"].includes(mode) ? {} : { sourceAck: mode === "wrong-source" ? { ...preparedSource, sourceSha256: "b".repeat(64) }
          : mode === "wrong-key" ? { ...preparedSource, journalBindingKey: "foreign" } : mode === "extra-source" ? { ...preparedSource, completionSha256: "borrowed" } : preparedSource }),
        ...(mode === "extra-result" ? { deliverySucceeded: true } : {}) };
      return { kind: "bus.ack", requestId: envelope.requestId, ok: true, result };
    } });
    const run = createTelegramBusLiveRebindController({ getFollower: () => ({ instanceId: "follower", sessionId: "session", registrationGeneration: "registration", pid: process.pid, processBirthId: `${process.pid}:observe`,
      cwd: dir, slot: "A", busSocketPath: socketPath, target: selectedCommand.target, protocol, connectedAtMs: 1, lastHeartbeatMs: 1 }), localProtocolIdentity: protocol, getAuthSecret: () => "secret", createRequestId: () => "observe",
      // Only the lost reply waits out its deadline; every answered mode uses the production window.
      ...(mode === "lost-response" ? { timeoutMs: 250 } : {}) });
    try {
      await server.start(); const query = { operationId: "live", instanceId: "follower", sessionId: "session", recipientBindingKey: "journal", isCurrent: () => true, mode: "observe-command" as const,
        sourceUpdateIds: [100], slot: "A", target: selectedCommand.target, oldTarget: { chatId: 7, threadId: 10 }, selectedCommand, preparedSource };
      if (mode === "lost-response") await assert.rejects(run(query), /Timed out|closed/);
      else { const result = await run(query); assert.equal(!!result, ["completed", "unknown", "not-issued", "no-ack"].includes(mode));
        if (result) assert.equal(result.status, "command-observed"); }
      assert.equal(calls, 1);
    } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const phase of ["save", "apply", "release"] as const) {
  for (const mode of ["current", "generic-ack", "wrong-target", "wrong-name", "extra-ack", "lost-ack", "missing-local", "missing-peer", "legacy-local", "legacy-peer", "delivery-missing", "target-mismatch", "late-protocol", "mutated-input", "missing-source", "source-key", "source-id", "source-hash", "source-extra", "input-source-bad"] as const) {
    test(`Selected status controller binds exact singleton branch across one IPC attempt (${phase}/${mode})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-status-input-wire-")), socketPath = getTelegramBusSocketPath(dir, process.platform, "status", "consolidated");
      const caps = ["live-thread-rebind-save-v1", "live-thread-rebind-apply-v1", "live-thread-rebind-settle-v1", "selected-menu-delivery-v1", "live-thread-rebind-command-set-v1"];
      const local = createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: mode === "missing-local" ? caps.slice(0, -1) : mode === "legacy-local" ? caps.map(cap => cap === "live-thread-rebind-command-set-v1" ? "live-thread-rebind-status-v1" : cap) : caps });
      const follower = { instanceId: "follower", sessionId: "session", slot: "A", cwd: dir, pid: process.pid, processBirthId: `${process.pid}:status-wire`, sessionGeneration: 1,
        registrationGeneration: "registration", busSocketPath: socketPath, connectedAtMs: 1, lastHeartbeatMs: 1, target: { chatId: 7, threadId: 10 }, protocol: createTelegramBusProtocolIdentity({ runtimeBuild: "fixture",
          capabilities: mode === "missing-peer" ? caps.slice(0, -1) : mode === "legacy-peer" ? caps.map(cap => cap === "live-thread-rebind-command-set-v1" ? "live-thread-rebind-held-command-v1" : cap) : mode === "delivery-missing" ? caps.filter(cap => cap !== "selected-menu-delivery-v1") : caps }) };
      let calls = 0;
      const preparedSource = { journalBindingKey: "journal", updateId: 100, sourceSha256: "a".repeat(64) };
      const descriptor = { name: "status" as const, target: { chatId: 7, threadId: mode === "target-mismatch" ? 99 : 42 } }, expectedDescriptor = structuredClone(descriptor);
      const server = createTelegramBusLocalServer({ socketPath, handleEnvelope(envelope) {
        calls++; assert.ok(["leader.prepareLiveRebind", "leader.applyLiveRebind", "leader.settleLiveRebind"].includes(envelope.kind));
        assert.deepEqual(Reflect.get(envelope, "selectedCommand"), expectedDescriptor);
        if (mode === "mutated-input") descriptor.target.threadId = 99;
        if (mode === "lost-ack") return undefined;
        if (mode === "late-protocol") follower.protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "replacement", capabilities: caps });
        const result = { operationId: "live", recipient: { instanceId: "follower", sessionId: "session", generation: "registration", bindingKey: "journal" }, sourceUpdateIds: [100],
          ...(mode === "missing-source" ? {} : { preparedSource: mode === "source-key" ? { ...preparedSource, journalBindingKey: "other" }
            : mode === "source-id" ? { ...preparedSource, updateId: 101 } : mode === "source-hash" ? { ...preparedSource, sourceSha256: "b".repeat(64) }
            : mode === "source-extra" ? { ...preparedSource, completionSha256: "borrowed" } : preparedSource }),
          status: phase === "save" ? "saved" : phase === "apply" ? "applied" : "released", ...(phase === "apply" ? { target: { chatId: 7, threadId: 42 }, slot: "A" } : {}),
          ...(phase === "release" ? { action: "release" } : {}), ...(mode === "generic-ack" ? {} : { selectedCommand: mode === "wrong-target" ? { name: "status", target: { chatId: 7, threadId: 99 } }
            : mode === "wrong-name" ? { ...expectedDescriptor, name: "abort" } : mode === "extra-ack" ? { ...expectedDescriptor, receipt: "borrowed" } : expectedDescriptor }) };
        return { kind: "bus.ack", requestId: envelope.requestId, ok: true, result };
      } });
      try {
        await server.start();
        const run = createTelegramBusLiveRebindController({ getFollower: () => follower, localProtocolIdentity: local, getAuthSecret: () => "secret", createRequestId: () => "status", timeoutMs: 250 });
        const task = run({ operationId: "live", instanceId: "follower", sessionId: "session", recipientBindingKey: "journal", isCurrent: () => true, selectedCommand: descriptor, preparedSource: mode === "input-source-bad" ? { ...preparedSource, sourceSha256: "bad" } : preparedSource,
          ...(phase === "save" ? { updates: [{ update_id: 100, message: { text: "/status" } }] } : { mode: phase, sourceUpdateIds: [100], slot: "A", target: { chatId: 7, threadId: 42 }, oldTarget: { chatId: 7, threadId: 10 } }) });
        let result: Awaited<typeof task>;
        if (mode === "lost-ack" || mode === "late-protocol") await assert.rejects(task, error => error instanceof Error &&
          (mode === "lost-ack" ? /Timed out|closed/.test(error.message) : Reflect.get(error, "requestIssued") === true));
        else result = await task;
        const beforeIPC = ["missing-local", "missing-peer", "legacy-local", "legacy-peer", "delivery-missing", "input-source-bad"].includes(mode) || mode === "target-mismatch" && phase !== "save";
        assert.equal(calls, beforeIPC ? 0 : 1); assert.equal(!!result, mode === "current" || mode === "mutated-input" || phase === "save" && mode === "target-mismatch");
        if (result) { assert.deepEqual(Reflect.get(result, "selectedCommand"), expectedDescriptor); assert.deepEqual(Reflect.get(result, "preparedSource"), preparedSource); }
      } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
    });
  }
}

function selectedMenuWire(kind: "send-text" | "edit-text" = "send-text") {
  return { kind: "follower.deliverSelectedMenu" as const, requestId: "effect", auth: "secret", instanceId: "follower", registrationGeneration: "registration",
    operationId: "live", recipient: { sessionId: "session", sessionGeneration: 1, processId: 123, processBirthId: "123:birth", profileKey: "manual:follower",
      journalBindingKey: "session-journal", target: { chatId: 7, threadId: 42 } }, executor: { instanceId: "leader", leaderEpoch: "epoch" }, operatorUserId: 7,
    effect: { kind, text: "Status", parseMode: "HTML", ...(kind === "send-text" ? { replyToMessageId: 11 } : { messageId: 11 }),
      replyMarkup: { inline_keyboard: [[{ text: "Queue", callback_data: "menu:queue" }]] } }, sentAtMs: 1000 };
}

for (const kind of ["send-text", "edit-text"] as const) {
  test(`Selected follower menu wire is distinct closed copied evidence, not ordinary API admission (${kind})`, () => {
    const wire = selectedMenuWire(kind), parsed = parseTelegramBusEnvelope(JSON.stringify(wire));
    assert.equal(parsed?.kind, "follower.deliverSelectedMenu");
    assert.deepEqual(parsed, wire);
    assert.equal(getTelegramBusEnvelopeTrafficClass(parsed!), "generation-fenced");
    wire.recipient.target.threadId = 99; wire.effect.text = "changed"; wire.effect.replyMarkup.inline_keyboard[0]![0]!.callback_data = "changed";
    if (parsed?.kind !== "follower.deliverSelectedMenu") assert.fail("Wrong contract");
    assert.equal(parsed.recipient.target.threadId, 42); assert.equal(parsed.effect.text, "Status");
    const local = createTelegramBusProtocolIdentity({ runtimeBuild: "candidate", capabilities: [TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY] });
    const old = createTelegramBusProtocolIdentity({ runtimeBuild: "old", capabilities: [] });
    assert.equal(hasTelegramBusCapability(local, TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY), true);
    assert.equal(hasTelegramBusCapability(old, TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY), false);
    assert.deepEqual(parseTelegramBusEnvelope(encodeTelegramBusEnvelope(parsed)), parsed);
  });
}

for (const fault of ["missing-generation", "missing-operation", "missing-session", "invalid-generation", "invalid-pid", "missing-birth", "missing-profile", "missing-journal",
  "profile-alias", "foreign-chat", "missing-thread", "invalid-thread", "unknown-recipient", "unknown-executor", "missing-epoch", "foreign-operator", "missing-request",
  "blank-text", "oversized-text", "unsupported-effect", "send-with-edit-id", "edit-with-reply", "missing-edit-id", "unknown-effect", "parse-mode", "negative-time",
  "infinite-time", "raw-method", "callback", "reply-url", "oversized-callback", "empty-keyboard-row"] as const) {
  test(`Selected follower menu wire refuses unsupported or malformed effect without ordinary fallback (${fault})`, () => {
    const value: Record<string, unknown> = selectedMenuWire(fault === "edit-with-reply" || fault === "missing-edit-id" ? "edit-text" : "send-text");
    const recipient = value.recipient as Record<string, unknown>, target = recipient.target as Record<string, unknown>;
    const executor = value.executor as Record<string, unknown>, effect = value.effect as Record<string, unknown>;
    const markup = effect.replyMarkup as { inline_keyboard: Record<string, unknown>[][] }, button = markup.inline_keyboard[0]![0]!;
    if (fault === "missing-generation") value.registrationGeneration = "";
    if (fault === "missing-operation") value.operationId = "";
    if (fault === "missing-session") recipient.sessionId = "";
    if (fault === "invalid-generation") recipient.sessionGeneration = -1;
    if (fault === "invalid-pid") recipient.processId = 1.5;
    if (fault === "missing-birth") recipient.processBirthId = "";
    if (fault === "missing-profile") recipient.profileKey = "";
    if (fault === "missing-journal") recipient.journalBindingKey = "";
    if (fault === "profile-alias") recipient.journalBindingKey = recipient.profileKey;
    if (fault === "foreign-chat") target.chatId = -7;
    if (fault === "missing-thread") delete target.threadId;
    if (fault === "invalid-thread") target.threadId = 0;
    if (fault === "unknown-recipient") recipient.callback = "not-wire-authority";
    if (fault === "unknown-executor") executor.callback = "not-wire-authority";
    if (fault === "missing-epoch") executor.leaderEpoch = "";
    if (fault === "foreign-operator") value.operatorUserId = 8;
    if (fault === "missing-request") value.requestId = "";
    if (fault === "blank-text") effect.text = " ";
    if (fault === "oversized-text") effect.text = "x".repeat(4097);
    if (fault === "unsupported-effect") effect.kind = "delete-message";
    if (fault === "send-with-edit-id") effect.messageId = 99;
    if (fault === "edit-with-reply") effect.replyToMessageId = 99;
    if (fault === "missing-edit-id") delete effect.messageId;
    if (fault === "unknown-effect") effect.extra = true;
    if (fault === "parse-mode") effect.parseMode = "MarkdownV2";
    if (fault === "negative-time") value.sentAtMs = -1;
    if (fault === "infinite-time") value.sentAtMs = Infinity;
    if (fault === "raw-method") value.method = "sendMessage";
    if (fault === "callback") value.assertAuthority = "callback-placeholder";
    if (fault === "reply-url") button.url = "https://example.invalid";
    if (fault === "oversized-callback") button.callback_data = "я".repeat(33);
    if (fault === "empty-keyboard-row") markup.inline_keyboard = [[]];
    assert.equal(parseTelegramBusEnvelope(JSON.stringify(value)), undefined);
  });
}

test("Selected menu wire decoding does not reinterpret ordinary follower API or mint callback authority", () => {
  const ordinary = { kind: "follower.callApi", requestId: "legacy", instanceId: "follower", registrationGeneration: "registration", method: "call",
    args: ["sendMessage", { chat_id: 7, text: "ordinary" }], sentAtMs: 1000 };
  assert.deepEqual(parseTelegramBusEnvelope(JSON.stringify(ordinary)), ordinary);
  const parsed = parseTelegramBusEnvelope(JSON.stringify(selectedMenuWire()));
  assert.equal(parsed?.kind, "follower.deliverSelectedMenu");
  assert.equal("assertAuthority" in parsed!, false);
  assert.equal("method" in parsed!, false); assert.equal("args" in parsed!, false);
  assert.equal(hasTelegramBusCapability(createTelegramBusProtocolIdentity({ runtimeBuild: "root-default" }), TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY), false);
});

test("Bus envelope auth compares the exact secret in constant time", () => {
  const secret = "leader-minted-secret";
  assert.equal(
    isTelegramBusEnvelopeAuthorized(
      { kind: "bus.ack", requestId: "r", ok: true, auth: secret },
      secret,
    ),
    true,
  );
  assert.equal(
    isTelegramBusEnvelopeAuthorized(
      { kind: "bus.ack", requestId: "r", ok: true, auth: "00000000000000000000" },
      secret,
    ),
    false,
  );
  assert.equal(
    isTelegramBusEnvelopeAuthorized(
      { kind: "bus.ack", requestId: "r", ok: true, auth: "short" },
      secret,
    ),
    false,
  );
  assert.equal(
    isTelegramBusEnvelopeAuthorized(
      { kind: "bus.ack", requestId: "r", ok: true },
      secret,
    ),
    false,
  );
  assert.equal(
    isTelegramBusEnvelopeAuthorized(
      { kind: "bus.ack", requestId: "r", ok: true },
      undefined,
    ),
    true,
  );
});

test("Explicit connection recovery is a register-only true wire flag", () => {
  const registration = { instanceId: "follower", connectedAtMs: 1 };
  const envelope = { kind: "follower.register", requestId: "connect", registration, recoverConnection: true };
  const parsed = parseTelegramBusEnvelope(JSON.stringify(envelope));
  assert.equal(parsed?.kind === "follower.register" && parsed.recoverConnection, true);
  for (const recoverConnection of [false, "true", 1, null]) {
    assert.equal(parseTelegramBusEnvelope(JSON.stringify({ ...envelope, recoverConnection })), undefined);
  }
  assert.equal(parseTelegramBusEnvelope(JSON.stringify({ ...envelope, kind: "follower.restoreWorkspace" })), undefined);
});

test("Bus envelopes classify bootstrap, fenced traffic, and responses", () => {
  assert.equal(
    getTelegramBusEnvelopeTrafficClass({
      kind: "follower.register",
      requestId: "register:1",
      registration: { instanceId: "follower", connectedAtMs: 1 },
    }),
    "bootstrap",
  );
  assert.equal(
    getTelegramBusEnvelopeTrafficClass({
      kind: "follower.heartbeat",
      requestId: "heartbeat:1",
      instanceId: "follower",
      registrationGeneration: "generation-1",
      sentAtMs: 1,
    }),
    "generation-fenced",
  );
  assert.equal(
    getTelegramBusEnvelopeTrafficClass({
      kind: "bus.ack",
      requestId: "response:1",
      ok: true,
    }),
    "response",
  );
});

test("Steer wire capability requires independent base handoff support", () => {
  for (const caps of [[], [TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF], [TELEGRAM_BUS_CAPABILITY_QUEUE_STEER],
    [TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF, TELEGRAM_BUS_CAPABILITY_QUEUE_STEER]]) {
    assert.equal(hasTelegramBusSteerQueueHandoffCapability(createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: caps })), caps.length === 2);
  }
  assert.equal(hasTelegramBusSteerQueueHandoffCapability(undefined), false);
});

test("Bus protocol capabilities are explicit and independently negotiable", () => {
  const identity = createTelegramBusProtocolIdentity({
    runtimeBuild: "0.28.0",
    capabilities: [TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF],
  });
  assert.equal(
    hasTelegramBusCapability(identity, TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF),
    true,
  );
  assert.equal(
    hasTelegramBusCapability(
      identity,
      TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
    ),
    false,
  );
  assert.equal(
    hasTelegramBusCapability(undefined, TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF),
    false,
  );
});

test("Bus protocol compatibility ignores build skew and enforces capabilities", () => {
  const local = createTelegramBusProtocolIdentity({
    runtimeBuild: "0.28.0",
    capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION],
  });
  const compatibleSkew = createTelegramBusProtocolIdentity({
    runtimeBuild: "0.28.1",
    capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION],
  });
  assert.deepEqual(
    getTelegramBusProtocolCompatibility({ local, remote: compatibleSkew }),
    { compatible: true, missingCapabilities: [] },
  );
  assert.deepEqual(
    getTelegramBusProtocolCompatibility({ local }),
    {
      compatible: false,
      reason: "missing-identity",
      missingCapabilities: [],
    },
  );
  assert.deepEqual(
    getTelegramBusProtocolCompatibility({
      local,
      remote: createTelegramBusProtocolIdentity({ runtimeBuild: "0.28.2" }),
    }),
    {
      compatible: false,
      reason: "missing-capability",
      missingCapabilities: [
        TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
      ],
    },
  );
});

test("Bus custody reference requires mutual capability and exact accepted handoff", () => {
  const capable = createTelegramBusProtocolIdentity({ runtimeBuild: "0.45.0",
    capabilities: [TELEGRAM_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE] });
  const legacy = createTelegramBusProtocolIdentity({ runtimeBuild: "0.44.0" });
  assert.equal(canUseTelegramBusInputCustodyReference({ local: capable, remote: capable }), true);
  assert.equal(canUseTelegramBusInputCustodyReference({ local: capable, remote: legacy }), false);
  assert.equal(canUseTelegramBusInputCustodyReference({ local: legacy, remote: capable }), false);
  const source = { updateId: 44, owner: { acquisitionId: "acquisition-44",
    handoffId: "input-handoff-44" } };
  const delivery = createTelegramBusFollowerSourceReferenceDeliveryIdentity({
    kind: "leader.wakeInputCustody", recipientBindingKey: "workspace:recipient",
    sourceRecoveryKey: "journal:source", source });
  assert.deepEqual(delivery.sourceClaim, { acquisitionId: "acquisition-44",
    handoffId: "input-handoff-44" });
  assert.equal(delivery.sourceRecoveryKey, "journal:source");
  assert.throws(() => createTelegramBusFollowerSourceReferenceDeliveryIdentity({
    kind: "leader.wakeInputCustody", recipientBindingKey: "workspace:recipient",
    sourceRecoveryKey: "journal:source", source: { ...source, owner: {
      acquisitionId: "acquisition-44" } } }), /requires an accepted handoff/);
});

test("Follower delivery identity stays stable across registration replacement", () => {
  const first = createTelegramBusFollowerDeliveryIdentity({
    kind: "leader.forwardMessage",
    recipientBindingKey: "manual:owner-a",
    sourceUpdateId: 44,
  });
  const replacement = createTelegramBusFollowerDeliveryIdentity({
    kind: "leader.forwardMessage",
    recipientBindingKey: "manual:owner-a",
    sourceUpdateId: 44,
  });
  assert.deepEqual(replacement, first);
});

test("Current bus process runtime owns process identity defaults", () => {
  const runtime = createCurrentTelegramBusProcessRuntime({
    getActiveProfileName: () => undefined,
    pid: 42,
    parentPid: 7,
    createdAtMs: 1000,
  });
  assert.equal(runtime.instanceId, "42:1000");
  assert.equal(runtime.processId, 42);
  assert.match(runtime.processBirthId, /^42:/u);
  assert.match(runtime.manualFollowerOwnerId, /^7:/u);
});

test("Wrapped follower owner keys expose their raw process-birth identity", () => {
  for (const telegramProfile of [undefined, "work"]) {
    const key = getTelegramThreadOwnerKey({ kind: "manual-follower",
      instanceId: "42:start:12345", ...(telegramProfile ? { telegramProfile } : {}) });
    const owner = getTelegramThreadOwnerFromProfileKey(key);
    assert.equal(owner.kind, "manual-follower");
    if (owner.kind !== "manual-follower") continue;
    assert.equal(owner.instanceId, "42:start:12345");
    assert.equal(getTelegramProcessBirthIdentityLiveness(owner.instanceId, {
      platform: "linux", isProcessAlive: () => false,
    }), "dead");
  }
});

test("Bus process runtime resolves live profile endpoints", () => {
  let profileName: string | undefined;
  const runtime = createTelegramBusProcessRuntime({
    getActiveProfileName: () => profileName,
    pid: 42,
    parentPid: 7,
    parentProcessIdentity: "7:start:test",
    createdAtMs: 1000,
  });
  assert.equal(runtime.instanceId, "42:1000");
  assert.equal(runtime.manualFollowerOwnerId, "7:start:test");
  const defaultLeaderPath = runtime.getLeaderSocketPath();
  const defaultFollowerPath = runtime.getFollowerSocketPath();
  profileName = "work";
  assert.notEqual(runtime.getLeaderSocketPath(), defaultLeaderPath);
  assert.notEqual(runtime.getFollowerSocketPath(), defaultFollowerPath);
  assert.match(runtime.getLeaderSocketPath(), /work/);
  assert.match(runtime.getFollowerSocketPath(), /work/);
});

test("Bus process runtime falls back to pid without a parent pid", () => {
  const runtime = createTelegramBusProcessRuntime({
    getActiveProfileName: () => undefined,
    pid: 42,
    parentPid: 0,
    parentProcessIdentity: "42:start:test",
    createdAtMs: 1000,
  });
  assert.equal(runtime.manualFollowerOwnerId, "42:start:test");
});

test("Bus transport boundary derives socket and pipe endpoints", () => {
  assert.equal(
    getTelegramBusLeaderEndpoint({ agentDir: "/agent", platform: "linux" }),
    join("/agent", "tmp", "pi-telegram", "bus.sock"),
  );
  assert.equal(
    getTelegramBusFollowerEndpoint({
      agentDir: "/agent",
      platform: "linux",
      instanceId: "pid:123",
    }),
    join("/agent", "tmp", "pi-telegram", "followers", "pid_123.sock"),
  );
  const pipe = getTelegramBusLeaderEndpoint({
    agentDir: "C:\\Users\\Admin\\.pi\\agent",
    platform: "win32",
  });
  assert.match(pipe, /^\\\\\.\\pipe\\pi-telegram-.+-bus$/);
  assert.equal(getTelegramBusTransportKind(pipe), "pipe");
  assert.equal(getTelegramBusTransportKind("/tmp/bus.sock"), "socket");
  assert.equal(
    getTelegramBusTransportKind(
      resolveTelegramBusSocketPath("C:\\tmp\\legacy.sock", "win32"),
    ),
    "pipe",
  );
  const longMacEndpoint = resolveTelegramBusSocketPath(
    `/var/folders/${"nested/".repeat(20)}bus.sock`,
    "darwin",
  );
  assert.equal(getTelegramBusTransportKind(longMacEndpoint), "socket");
  assert.ok(Buffer.byteLength(longMacEndpoint) < 104);
  assert.equal(
    resolveTelegramBusSocketPath(longMacEndpoint, "darwin"),
    longMacEndpoint,
  );
});

test("Bus transport retry policy is operation-aware", () => {
  const pipe = getTelegramBusLeaderEndpoint({
    agentDir: "C:\\Users\\Admin\\.pi\\agent",
    platform: "win32",
  });
  assert.deepEqual(
    getTelegramBusTransportRetryPolicy({
      endpoint: pipe,
      operation: "operation",
    }),
    { attempts: 3, delayMs: 100 },
  );
  assert.deepEqual(
    getTelegramBusTransportRetryPolicy({
      endpoint: "/tmp/bus.sock",
      operation: "registration",
    }),
    { attempts: 10, delayMs: 150 },
  );
  assert.deepEqual(
    getTelegramBusTransportRetryPolicy({
      endpoint: "/tmp/bus.sock",
      operation: "registration",
      overrides: { attempts: 2, delayMs: 5 },
    }),
    { attempts: 2, delayMs: 5 },
  );
  assert.equal(
    getTelegramBusTransportRetryPolicy({
      endpoint: "/tmp/bus.sock",
      operation: "operation",
    }),
    undefined,
  );
});

test("Bus transport error classifier marks transient IPC failures retryable", () => {
  const error = Object.assign(new Error("connect ENOENT"), {
    code: "ENOENT",
    syscall: "connect",
  });
  assert.deepEqual(classifyTelegramBusTransportError(error), {
    message: "connect ENOENT",
    code: "ENOENT",
    syscall: "connect",
    kind: "connect",
    retryable: true,
  });
  assert.deepEqual(
    classifyTelegramBusTransportError(
      Object.assign(new Error("operation expired"), { code: "ETIMEDOUT" }),
    ),
    {
      message: "operation expired",
      code: "ETIMEDOUT",
      syscall: undefined,
      kind: "timeout",
      retryable: true,
    },
  );
});

// Uses POSIX absolute agent paths for both layouts, which a Windows host cannot resolve as exact absolute paths.
test("Consolidated IPC uses short collision-resistant profile/recipient names and never redirects outside runtime", { skip: process.platform === "win32" }, () => {
  const agentDir = "/agent";
  const profiles = [undefined, "work", "WORK", "work/name", "work_name", "x".repeat(300)];
  for (const platform of ["linux", "win32"] as const) {
    const leaders = profiles.map(profile => getTelegramBusSocketPath(agentDir, platform, profile, "consolidated"));
    const followers = profiles.map(profile => getTelegramBusFollowerSocketPath("pid:123", agentDir, platform, profile, "consolidated"));
    assert.equal(new Set([...leaders, ...followers]).size, profiles.length * 2);
    assert.equal(leaders[0], getTelegramBusSocketPath(agentDir, platform, "default", "consolidated"));
    assert.notEqual(followers[1], getTelegramBusFollowerSocketPath("pid_123", agentDir, platform, "work", "consolidated"));
    for (const endpoint of [...leaders, ...followers]) {
      if (platform === "linux") assert.match(endpoint, /^\/agent\/tmp\/pi-telegram\/runtime\/(?:bus|f)\.[a-f0-9]{16}\.sock$/u);
      else assert.equal(getTelegramBusTransportKind(endpoint), "pipe");
      assert.equal(resolveTelegramBusSocketPath(endpoint, platform), endpoint);
    }
  }
  const longLogical = getTelegramBusSocketPath("/" + "long".repeat(30), "linux", "work", "consolidated");
  assert.match(longLogical, /\/tmp\/pi-telegram\/runtime\/bus\.[a-f0-9]{16}\.sock$/u, "Logical identity stays in the runtime namespace");
  assert.match(resolveTelegramBusSocketPath(longLogical, "linux"), /pi-telegram-[^/]+\/[a-f0-9]{16}\.sock$/u,
    "Only an over-capacity socket uses the bounded private fallback");
  assert.throws(() => getTelegramBusFollowerSocketPath("pid:123", "relative-agent", "linux", "work", "consolidated"), /exact absolute runtime path/u);
});

test("Consolidated bus process runtime retains its layout and selector while resolving current profile values", () => {
  let profile: string | undefined = "work";
  const input = { pid: 42, parentPid: 1, createdAtMs: 1000, getActiveProfileName: () => profile, endpointLayout: "consolidated" as const };
  const runtime = createTelegramBusProcessRuntime(input);
  input.getActiveProfileName = () => "replacement";
  input.endpointLayout = undefined as unknown as "consolidated";
  assert.equal(runtime.getLeaderSocketPath(), getTelegramBusSocketPath(undefined, undefined, "work", "consolidated"));
  assert.equal(runtime.getFollowerSocketPath(), getTelegramBusFollowerSocketPath(runtime.instanceId, undefined, undefined, "work", "consolidated"));
  profile = "other";
  assert.equal(runtime.getLeaderSocketPath(), getTelegramBusSocketPath(undefined, undefined, "other", "consolidated"));
});

test("Consolidated native IPC request/ACK and profile restart keep every socket/staging artifact below runtime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-ipc-"));
  let profile = "work";
  const socketPath = () => getTelegramBusSocketPath(dir, process.platform, profile, "consolidated");
  const server = createTelegramBusLocalServer({ socketPath,
    handleEnvelope: envelope => ({ kind: "bus.ack", requestId: envelope.requestId, ok: true }) });
  try {
    for (const next of ["work", "other"]) {
      profile = next;
      await server.start();
      const response = await sendTelegramBusLocalEnvelope({ socketPath: socketPath(), envelope: {
        kind: "follower.heartbeat", requestId: next, instanceId: "follower-a", sentAtMs: 1000 } });
      assert.equal(response?.kind, "bus.ack");
      assert.equal(response?.requestId, next);
      if (process.platform !== "win32") assert.deepEqual(readdirSync(join(dir, "tmp", "pi-telegram")), ["runtime"]);
      await server.stop();
    }
  } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("Bus socket path is scoped under the agent temp directory", () => {
  assert.equal(
    getTelegramBusSocketPath("/agent", "linux"),
    join("/agent", "tmp", "pi-telegram", "bus.sock"),
  );
  assert.equal(
    getTelegramBusFollowerSocketPath("pid:123", "/agent", "linux"),
    join("/agent", "tmp", "pi-telegram", "followers", "pid_123.sock"),
  );
});

test("Bus socket paths isolate named profiles and preserve default Unix paths", () => {
  assert.equal(
    getTelegramBusSocketPath("/agent", "linux", "work"),
    join("/agent", "tmp", "pi-telegram", "bus.work.sock"),
  );
  assert.equal(
    getTelegramBusFollowerSocketPath("pid:123", "/agent", "linux", "work"),
    join("/agent", "tmp", "pi-telegram", "followers", "work", "pid_123.sock"),
  );
  assert.notEqual(
    getTelegramBusSocketPath("/agent", "linux", "work"),
    getTelegramBusSocketPath("/agent", "linux", "personal"),
  );
});

test("Bus socket path uses profile-scoped Windows named pipes on win32", () => {
  assert.match(
    getTelegramBusSocketPath("C:\\Users\\me\\.pi\\agent", "win32"),
    /^\\\\\.\\pipe\\pi-telegram-[A-Za-z0-9_-]{16}-bus$/,
  );
  assert.match(
    getTelegramBusFollowerSocketPath(
      "pid:123/unsafe",
      "C:\\Users\\me\\.pi\\agent",
      "win32",
    ),
    /^\\\\\.\\pipe\\pi-telegram-[A-Za-z0-9_-]{16}-follower-pid_123_unsafe$/,
  );
  assert.match(
    getTelegramBusSocketPath("C:\\Users\\me\\.pi\\agent", "win32", "work"),
    /^\\\\\.\\pipe\\pi-telegram-[A-Za-z0-9_-]{16}-bus-work$/,
  );
  assert.match(
    getTelegramBusFollowerSocketPath(
      "pid:123/unsafe",
      "C:\\Users\\me\\.pi\\agent",
      "win32",
      "work",
    ),
    /^\\\\\.\\pipe\\pi-telegram-[A-Za-z0-9_-]{16}-follower-work-pid_123_unsafe$/,
  );
});

test("Bus request id factory owns one monotonic instance sequence", () => {
  const createRequestId = createTelegramBusRequestIdFactory("inst-a");

  assert.equal(createRequestId(), "inst-a:1");
  assert.equal(createRequestId(), "inst-a:2");
  assert.equal(createRequestId(), "inst-a:3");
});

test("Bus contract encodes and parses follower registration envelopes", () => {
  const envelope = {
    kind: "follower.register" as const,
    requestId: createTelegramBusRequestId({
      instanceId: "inst-a",
      sequence: 1,
    }),
    registration: {
      instanceId: "inst-a",
      profileKey: "repo:/work/project",
      threadName: "Eagle",
      slot: "E",
      cwd: "/work/project",
      pid: 123,
      processBirthId: "123:start:abc",
      sessionGeneration: 4,
      target: { chatId: -1007, threadId: 42 },
      protocol: createTelegramBusProtocolIdentity({
        runtimeBuild: "0.28.0",
      }),
      connectedAtMs: 1000,
    },
  };

  assert.deepEqual(
    parseTelegramBusEnvelope(encodeTelegramBusEnvelope(envelope).trimEnd()),
    envelope,
  );
});

test("Bus pre-execution API refusal requires a negative acknowledgement and exact method evidence", () => {
  const refusal = {
    kind: "bus.ack" as const, requestId: "refused", ok: false,
    error: { code: "follower-api-not-allowed" as const, method: "sendMessage" },
  };
  const parsed = parseTelegramBusEnvelope(encodeTelegramBusEnvelope(refusal));
  assert.equal(parsed?.kind, "bus.ack");
  if (parsed?.kind !== "bus.ack") throw new Error("Missing refusal acknowledgement");
  assert.deepEqual(parsed.error, refusal.error);
  for (const error of [
    { code: "follower-api-not-allowed" },
    { code: "follower-api-not-allowed", method: "" },
    { code: "follower-api-not-allowed", method: "sendMessage trailing" },
    { code: "follower-api-not-allowed", method: "s".repeat(65) },
    { code: "follower-api-not-allowed", method: 1 },
  ]) assert.equal(parseTelegramBusEnvelope(JSON.stringify({ ...refusal, error })), undefined);
  for (const contradiction of [{ ok: true }, { result: true }, { result: null }])
    assert.equal(parseTelegramBusEnvelope(JSON.stringify({ ...refusal, ...contradiction })), undefined);
});

test("Bus contract encodes and parses Workspace follower restore envelopes", () => {
  const envelope = {
    kind: "follower.restoreWorkspace" as const,
    requestId: "inst-a:restore:1",
    registration: {
      instanceId: "inst-a",
      cwd: "/work/project",
      pid: 123,
      protocol: createTelegramBusProtocolIdentity({
        runtimeBuild: "0.45.0",
        capabilities: [
          TELEGRAM_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT,
        ],
      }),
      connectedAtMs: 1000,
    },
  };

  assert.deepEqual(
    parseTelegramBusEnvelope(encodeTelegramBusEnvelope(envelope).trimEnd()),
    envelope,
  );
  assert.equal(getTelegramBusEnvelopeTrafficClass(envelope), "bootstrap");
  assert.equal(
    TELEGRAM_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT,
    "workspace-follower-auto-connect-v1",
  );
});

test("Bus contract encodes and parses explicit follower disconnect envelopes", () => {
  const envelope = {
    kind: "follower.disconnect" as const,
    requestId: "inst-a:2",
    instanceId: "inst-a",
    registrationGeneration: "inst-a:1",
    sentAtMs: 2000,
  };

  assert.deepEqual(
    parseTelegramBusEnvelope(encodeTelegramBusEnvelope(envelope).trimEnd()),
    envelope,
  );
});

test("Bus contract validates exact-generation Thread display setting envelopes", () => {
  for (const mode of ["letters", "names", "directory-snake", "directory-title"] as const) {
    const envelope = { kind: "follower.setThreadDisplayMode" as const,
      requestId: "one", instanceId: "follower", registrationGeneration: "generation", mode };
    assert.deepEqual(parseTelegramBusEnvelope(encodeTelegramBusEnvelope(envelope).trimEnd()), envelope);
    assert.equal(getTelegramBusEnvelopeTrafficClass(envelope), "generation-fenced");
    assert.equal(parseTelegramBusEnvelope(JSON.stringify({ ...envelope, mode: "directories" })), undefined);
    assert.equal(parseTelegramBusEnvelope(JSON.stringify({ ...envelope, mode: "invalid" })), undefined);
    assert.equal(parseTelegramBusEnvelope(JSON.stringify({ ...envelope, registrationGeneration: undefined })), undefined);
  }
});

test("Bus contract encodes and parses Workspace Thread rename envelopes", () => {
  const envelope = {
    kind: "follower.renameThread" as const,
    requestId: "inst-a:3",
    instanceId: "inst-a",
    registrationGeneration: "inst-a:1",
    target: { chatId: 7, threadId: 42 },
    threadName: "Navigator",
    sentAtMs: 2000,
  };

  assert.deepEqual(
    parseTelegramBusEnvelope(encodeTelegramBusEnvelope(envelope).trimEnd()),
    envelope,
  );
  assert.equal(
    TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME,
    "workspace-thread-rename-v1",
  );
  const reset = {
    kind: "follower.resetThreadName" as const,
    requestId: "inst-a:4",
    instanceId: "inst-a",
    registrationGeneration: "inst-a:1",
    target: { chatId: 7, threadId: 42 },
    sentAtMs: 2001,
  };
  assert.deepEqual(
    parseTelegramBusEnvelope(encodeTelegramBusEnvelope(reset).trimEnd()),
    reset,
  );
  assert.equal(getTelegramBusEnvelopeTrafficClass(reset), "generation-fenced");
});

test("Bus contract parses exact follower session replacement envelopes and rejects malformed intents", () => {
  const intent = {
    continuity: "workspace-thread" as const, cwd: "/repo", profileName: "default",
    sourceSessionId: "session-old", sourceUpdateId: 41,
    target: { chatId: 7, threadId: 42 }, messageId: 99, slot: "B",
    threadName: "Beacon", createdAtMs: 1000, expiresAtMs: 31_000,
    sourceInstanceId: "inst-a",
  };
  for (const kind of [
    "follower.publishSessionReplacement",
    "follower.settleSessionReplacement",
  ] as const) {
    const envelope = { kind, requestId: "inst-a:5", instanceId: "inst-a",
      registrationGeneration: "inst-a:1", intent, sentAtMs: 2000 };
    assert.deepEqual(
      parseTelegramBusEnvelope(encodeTelegramBusEnvelope(envelope).trimEnd()),
      envelope,
    );
    assert.equal(getTelegramBusEnvelopeTrafficClass(envelope), "generation-fenced");
    for (const malformed of [
      { ...intent, sourceInstanceId: "" },
      { ...intent, continuity: "classic-chat" },
      { ...intent, expiresAtMs: intent.createdAtMs },
      { ...intent, target: { chatId: "7", threadId: 42 } },
    ]) {
      assert.equal(parseTelegramBusEnvelope(JSON.stringify({ ...envelope,
        intent: malformed })), undefined);
    }
    assert.equal(parseTelegramBusEnvelope(JSON.stringify({ ...envelope,
      registrationGeneration: undefined })), undefined);
  }
  assert.equal(
    TELEGRAM_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT,
    "session-replacement-intent-v1",
  );
});

test("Bus contract rejects retired follower target replacement envelopes", () => {
  for (const generation of [undefined, "generation-b"]) {
    assert.equal(parseTelegramBusEnvelope(JSON.stringify({
      kind: "leader.replaceFollowerTarget", requestId: "leader:6",
      recipientInstanceId: "inst-b", recipientRegistrationGeneration: generation,
      target: { chatId: 7, threadId: 42 }, oldTarget: { chatId: 7, threadId: 10 },
      reason: "thread-restore", auth: "fixture", sentAtMs: 6000,
    })), undefined);
  }
});

test("Bus contract encodes and parses queue handoff envelopes", () => {
  const payload = {
    kind: "prompt" as const,
    chatId: 7,
    target: { chatId: 7, threadId: 42 },
    replyToMessageId: 10,
    guestQueryId: "guest-1",
    guestInlineMessageId: "inline-1",
    queueOrder: 1,
    queueLane: "default" as const,
    laneOrder: 1,
    statusSummary: "handoff",
    admissionReceipts: [
      {
        queueKind: "prompt" as const,
        receiptId: "receipt-1",
        sourceUpdateIds: [1],
      },
    ],
    sourceMessageIds: [10],
    queuedAttachments: [],
    content: [{ type: "text" as const, text: "handoff prompt" }],
    historyText: "handoff",
    reactionSuppressionEmoji: "👎",
  };
  const leaderEnvelope = {
    kind: "leader.offerQueueHandoff" as const,
    requestId: "leader:handoff:1",
    recipientInstanceId: "inst-b",
    recipientRegistrationGeneration: "generation-b",
    donorInstanceId: "inst-a",
    donorProcessId: 101,
    donorProcessBirthId: "101:start:a",
    donorSessionGeneration: 2,
    donorAcquisitionId: "acquisition-a",
    donorAcquiredAtMs: 1000,
    handoffToken: "x".repeat(32),
    payload,
    sentAtMs: 2000,
  };
  assert.deepEqual(
    parseTelegramBusEnvelope(
      encodeTelegramBusEnvelope(leaderEnvelope).trimEnd(),
    ),
    leaderEnvelope,
  );
  const followerEnvelope = {
    kind: "follower.offerQueueHandoff" as const,
    requestId: "follower:handoff:1",
    instanceId: "inst-a",
    registrationGeneration: "generation-a",
    recipientInstanceId: "inst-b",
    recipientRegistrationGeneration: "generation-b",
    donorProcessId: 101,
    donorProcessBirthId: "101:start:a",
    donorSessionGeneration: 2,
    donorAcquisitionId: "acquisition-a",
    donorAcquiredAtMs: 1000,
    handoffToken: "y".repeat(32),
    payload,
    sentAtMs: 2000,
  };
  assert.deepEqual(
    parseTelegramBusEnvelope(
      encodeTelegramBusEnvelope(followerEnvelope).trimEnd(),
    ),
    followerEnvelope,
  );
  assert.equal(
    parseTelegramBusEnvelope(
      JSON.stringify({ ...leaderEnvelope, handoffToken: "short" }),
    ),
    undefined,
  );
  assert.equal(
    parseTelegramBusEnvelope(
      JSON.stringify({
        ...leaderEnvelope,
        payload: { ...payload, admissionReceipts: [] },
      }),
    ),
    undefined,
  );
  assert.equal(
    parseTelegramBusEnvelope(
      JSON.stringify({
        ...leaderEnvelope,
        payload: { ...payload, reactionSuppressionEmoji: 1 },
      }),
    ),
    undefined,
  );
});

test("Bus contract encodes and parses cross-instance agent message envelopes", () => {
  const resolveEnvelope = {
    kind: "follower.resolveAgentTarget" as const,
    requestId: "inst-a:4",
    instanceId: "inst-a",
    registrationGeneration: "generation-a",
    selector: { threadName: "Hazel" },
    sentAtMs: 4000,
  };
  assert.deepEqual(
    parseTelegramBusEnvelope(
      encodeTelegramBusEnvelope(resolveEnvelope).trimEnd(),
    ),
    resolveEnvelope,
  );
  const routeEnvelope = {
    kind: "follower.routeAgentMessage" as const,
    requestId: "inst-a:5",
    instanceId: "inst-a",
    registrationGeneration: "generation-a",
    message: {
      target: { chatId: 7, threadId: 42 },
      messageId: 99,
      text: "Check the release",
    },
    sentAtMs: 5000,
  };
  assert.deepEqual(
    parseTelegramBusEnvelope(
      encodeTelegramBusEnvelope(routeEnvelope).trimEnd(),
    ),
    routeEnvelope,
  );
  assert.equal(
    parseTelegramBusEnvelope(
      JSON.stringify({
        ...resolveEnvelope,
        selector: { threadId: 42, threadName: "Hazel" },
      }),
    ),
    undefined,
  );
});

test("Bus contract encodes and parses follower API call envelopes", () => {
  const richBody = {
    chat_id: 1,
    rich_message: {
      markdown: "hi\n\n![](tg://photo?id=result)",
      media: [
        {
          id: "result",
          media: { type: "photo", media: "cached-photo" },
        },
      ],
    },
  };
  assert.deepEqual(
    parseTelegramBusEnvelope(
      encodeTelegramBusEnvelope({
        kind: "follower.callApi",
        requestId: "inst-a:4",
        instanceId: "inst-a",
        method: "sendRichMessage",
        args: [richBody],
        sentAtMs: 4000,
      }).trimEnd(),
    ),
    {
      kind: "follower.callApi",
      requestId: "inst-a:4",
      instanceId: "inst-a",
      method: "sendRichMessage",
      args: [richBody],
      sentAtMs: 4000,
    },
  );
});

test("Bus contract rejects forwarded updates without durable identity", () => {
  for (const envelope of [
    {
      kind: "leader.forwardCallback",
      requestId: "leader:2",
      recipientInstanceId: "inst-b",
      query: { id: "cb-1" },
      sentAtMs: 2000,
    },
    {
      kind: "leader.forwardReaction",
      requestId: "leader:3",
      recipientInstanceId: "inst-b",
      reactionUpdate: { message_id: 9 },
      sentAtMs: 3000,
    },
    {
      kind: "leader.forwardMessage",
      requestId: "leader:4",
      recipientInstanceId: "inst-b",
      message: { message_id: 10 },
      sentAtMs: 4000,
    },
    {
      kind: "leader.forwardEditedMessage",
      requestId: "leader:5",
      recipientInstanceId: "inst-b",
      message: { message_id: 11 },
      sentAtMs: 5000,
    },
  ]) {
    assert.equal(parseTelegramBusEnvelope(JSON.stringify(envelope)), undefined);
  }
});

test("Bus contract rejects malformed envelopes", () => {
  assert.equal(parseTelegramBusEnvelope("not-json"), undefined);
  assert.equal(
    parseTelegramBusEnvelope(JSON.stringify({ kind: "unknown" })),
    undefined,
  );
  assert.equal(
    parseTelegramBusEnvelope(
      JSON.stringify({
        kind: "follower.register",
        requestId: "bad:1",
        registration: { instanceId: "inst", target: { chatId: "bad" } },
      }),
    ),
    undefined,
  );
});

for (const kind of ["artifact", "ordinary"] as const)
for (const change of ["heartbeat", "equal-register", "rename", "remove-readd", "overlap", "prune", "clear"] as const)
test(`Native registry lifetime is owned and nonrenewing (${kind}/${change})`, () => {
  const registry = createTelegramBusFollowerRegistry(), registration = { instanceId: "artifact", connectedAtMs: 1, registrationGeneration: "same", profileKey: "profile", target: { chatId: 7, threadId: 8 } };
  const first = registry.register(registration), incarnation = first.registrationIncarnation!;
  assert.match(incarnation, /^[a-f0-9]{48}$/u);
  const capture = kind === "artifact" ? registry.captureArtifactRegistration!(registration.instanceId, incarnation)! : registry.captureRegistration!(registration.instanceId, "same")!;
  assert.equal(registry.captureRegistration!(registration.instanceId, "foreign"), undefined);
  assert.equal(capture(), true);
  if (change === "heartbeat") registry.heartbeat(registration.instanceId, 5);
  else if (change === "equal-register") registry.register(registration);
  else if (change === "rename") registry.register({ ...registration, threadName: "new" });
  else if (change === "remove-readd") { registry.remove(registration.instanceId); registry.register(registration); }
  else if (change === "overlap") registry.register({ ...registration, instanceId: "other" });
  else if (change === "prune") registry.pruneStale(100, 5);
  else registry.clear();
  assert.equal(capture(), change === "heartbeat");
  if (change !== "heartbeat") { registry.register(registration); assert.equal(capture(), false); }
  else assert.equal(registry.get(registration.instanceId)?.registrationIncarnation, incarnation);
});

test("Artifact wire rejects noncanonical base64, keys and mismatched declared size without payload allocation", () => {
  const good = { version: 1, registrationIncarnation: "a".repeat(48), target: { chatId: 7, threadId: 8 }, fileName: "file", byteLength: 1, bytesBase64: "YQ==", expiresAt: Date.now() + 10000 };
  assert.ok(parseTelegramBusArtifactDocument([good]));
  for (const bad of [{ ...good, bytesBase64: "YR==" }, { ...good, bytesBase64: "YQ==\n" }, { ...good, bytesBase64: "AAAA" }, { ...good, byteLength: 2 }, { ...good, extra: true }, { ...good, fileName: "../path" }, { ...good, expiresAt: 1 }, { ...good, target: { chatId: 7, aggregate: true } }])
    assert.equal(parseTelegramBusArtifactDocument([bad]), undefined);
  const bytes = Buffer.alloc(1_048_576, 255);
  assert.ok(parseTelegramBusArtifactDocument([{ ...good, byteLength: bytes.length, bytesBase64: bytes.toString("base64") }]));
});

test("Bus follower registry registers, heartbeats, and prunes live instances", () => {
  const registry = createTelegramBusFollowerRegistry();

  assert.deepEqual(
    registry.register({
      instanceId: "inst-a",
      threadName: "alpha",
      target: { chatId: 1 },
      connectedAtMs: 1000,
    }),
    {
      instanceId: "inst-a",
      threadName: "alpha",
      target: { chatId: 1 },
      connectedAtMs: 1000,
      lastHeartbeatMs: 1000,
      registrationIncarnation: registry.get("inst-a")?.registrationIncarnation,
    },
  );
  registry.register({
    instanceId: "inst-b",
    threadName: "beta",
    target: { chatId: 2, threadId: 20 },
    connectedAtMs: 1500,
  });

  assert.equal(registry.heartbeat("missing", 2000), undefined);
  assert.equal(registry.heartbeat("inst-a", 2200)?.lastHeartbeatMs, 2200);
  assert.deepEqual(
    registry.list().map((follower) => follower.instanceId),
    ["inst-a", "inst-b"],
  );
  assert.deepEqual(
    registry.pruneStale(3000, 1000).map((follower) => follower.instanceId),
    ["inst-b"],
  );
  assert.deepEqual(
    registry.list().map((follower) => follower.instanceId),
    ["inst-a"],
  );
  assert.equal(registry.remove("inst-a"), true);
  registry.register({ instanceId: "inst-c", connectedAtMs: 4000 });
  registry.clear();
  assert.deepEqual(registry.list(), []);
});

test("Bus follower API authorizer delegates message ownership with follower identity", () => {
  const calls: string[] = [];
  const follower = {
    instanceId: "follower-a",
    connectedAtMs: 1,
    lastHeartbeatMs: 2,
    target: { chatId: 7, threadId: 11 },
  };
  const authorize = createTelegramFollowerApiCallAuthorizer({
    isMessageOwned({ chatId, messageId, follower: owner }) {
      calls.push(`${owner.instanceId}:${chatId}:${messageId}`);
      return true;
    },
  });

  assert.equal(
    authorize({
      follower,
      method: "call",
      args: [
        "editMessageText",
        { chat_id: 7, message_thread_id: 11, message_id: 9 },
      ],
    }),
    true,
  );
  assert.deepEqual(calls, ["follower-a:7:9"]);
});

test("Bus follower API allowlist permits scoped own-thread Rich media uploads", () => {
  const follower = {
    instanceId: "inst-a",
    connectedAtMs: 1000,
    lastHeartbeatMs: 1000,
    target: { chatId: 10, threadId: 42 },
  };
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "callMultipart",
      args: [
        "sendVoice",
        { chat_id: 10, message_thread_id: 42 },
        "voice",
        "/tmp/voice.opus",
        "voice.opus",
      ],
    }),
    true,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "callMultipart",
      args: [
        "sendVoice",
        { chat_id: "10", message_thread_id: "42" },
        "voice",
        "/tmp/voice.opus",
        "voice.opus",
      ],
    }),
    true,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "callMultipart",
      args: [
        "sendAudio",
        { chat_id: 10, message_thread_id: 42 },
        "audio",
        "/tmp/audio.mp3",
        "audio.mp3",
      ],
    }),
    true,
  );
  const richMessage = JSON.stringify({
    markdown: "![](tg://photo?id=photo)",
    media: [
      {
        id: "photo",
        media: { type: "photo", media: "attach://photo_upload" },
      },
    ],
  });
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "callMultipart",
      args: [
        "sendRichMessage",
        {
          chat_id: "10",
          message_thread_id: "42",
          rich_message: richMessage,
        },
        "photo_upload",
        "/tmp/photo.jpg",
        "photo.jpg",
      ],
    }),
    true,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "callMultipart",
      args: [
        "sendRichMessage",
        {
          chat_id: "10",
          message_thread_id: "99",
          rich_message: richMessage,
        },
        "photo_upload",
        "/tmp/photo.jpg",
        "photo.jpg",
      ],
    }),
    false,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "callMultipart",
      args: [
        "sendVoice",
        { chat_id: 10 },
        "voice",
        "/tmp/voice.opus",
        "voice.opus",
      ],
    }),
    false,
  );
});

test("Bus follower API allowlist permits owned message markup/edit/delete operations", () => {
  const follower = {
    instanceId: "inst-a",
    connectedAtMs: 1000,
    lastHeartbeatMs: 1000,
    target: { chatId: 100, threadId: 42 },
  };
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["editMessageText", { chat_id: 100, message_id: 9, text: "Next" }],
      isMessageOwned: (chatId, messageId) => chatId === 100 && messageId === 9,
    }),
    true,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: [
        "editMessageReplyMarkup",
        {
          chat_id: 100,
          message_id: 9,
          reply_markup: { inline_keyboard: [] },
        },
      ],
      isMessageOwned: (chatId, messageId) => chatId === 100 && messageId === 9,
    }),
    true,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["deleteMessage", { chat_id: "100", message_id: "9" }],
      isMessageOwned: (chatId, messageId) => chatId === 100 && messageId === 9,
    }),
    true,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["deleteMessage", { chat_id: 100, message_id: 10 }],
      isMessageOwned: () => false,
    }),
    false,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["deleteMessage", { chat_id: 101, message_id: 9 }],
      isMessageOwned: () => true,
    }),
    false,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["deleteMessage", { chat_id: 100 }],
    }),
    false,
  );
});

test("Bus follower API allowlist permits bot command registration", () => {
  const follower = {
    instanceId: "inst-a",
    connectedAtMs: 1000,
    lastHeartbeatMs: 1000,
    target: { chatId: 100, threadId: 42 },
  };
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: [
        "setMyCommands",
        { commands: [{ command: "start", description: "Start" }] },
      ],
    }),
    true,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["setMyCommands", { commands: [{ command: "start" }] }],
    }),
    false,
  );
});

test("Bus follower API allowlist permits own-chat typing and safe identity reads", () => {
  const follower = {
    instanceId: "inst-a",
    connectedAtMs: 1000,
    lastHeartbeatMs: 1000,
    target: { chatId: 100, threadId: 42 },
  };
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["getMe", {}],
    }),
    true,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["sendChatAction", { chat_id: 100, action: "typing" }],
    }),
    false,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["sendChatAction", { chat_id: 101, action: "typing" }],
    }),
    false,
  );
});

test("Bus follower API refuses All even with a retained aggregate marker", () => {
  const follower = {
    instanceId: "inst-a",
    connectedAtMs: 1000,
    lastHeartbeatMs: 1000,
    target: { chatId: 100, threadId: 42 },
  };
  const marked = { chat_id: 100, text: "Aggregate", __piTelegramAggregateDelivery: true };
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["sendMessage", marked],
    }),
    false,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["sendMessage", { chat_id: 100, text: "Unmarked" }],
    }),
    false,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: [
        "sendMessage",
        { chat_id: 101, text: "Wrong chat", __piTelegramAggregateDelivery: true },
      ],
    }),
    false,
  );
  assert.deepEqual(stripTelegramBusApiMetadata(marked), {
    chat_id: 100,
    text: "Aggregate",
  });
});

test("Bus follower API allowlist permits marked cross-target delivery only in the paired chat", () => {
  const follower = {
    instanceId: "inst-a",
    connectedAtMs: 1000,
    lastHeartbeatMs: 1000,
    target: { chatId: 100, threadId: 42 },
  };
  const marked = markTelegramBusCrossTargetDelivery({
    chat_id: 100,
    message_thread_id: 99,
    rich_message: { markdown: "Cross-target" },
  });
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["sendRichMessage", marked],
    }),
    true,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: [
        "sendRichMessage",
        markTelegramBusCrossTargetDelivery({
          chat_id: 100,
          message_thread_id: 42,
        }),
      ],
    }),
    false,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: [
        "sendRichMessage",
        markTelegramBusCrossTargetDelivery({
          chat_id: 101,
          message_thread_id: 99,
        }),
      ],
    }),
    false,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: [
        "sendRichMessage",
        { chat_id: 100, message_thread_id: 99 },
      ],
    }),
    false,
  );
  assert.deepEqual(stripTelegramBusApiMetadata(marked), {
    chat_id: 100,
    message_thread_id: 99,
    rich_message: { markdown: "Cross-target" },
  });
});

test("Bus follower API allowlist permits scoped own-topic rename only", () => {
  const follower = {
    instanceId: "inst-a",
    connectedAtMs: 1000,
    lastHeartbeatMs: 1000,
    target: { chatId: 100, threadId: 42 },
  };
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: [
        "editForumTopic",
        { chat_id: 100, message_thread_id: 42, name: "Qname" },
      ],
    }),
    true,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: [
        "editForumTopic",
        { chat_id: 100, message_thread_id: 99, name: "Wrong" },
      ],
    }),
    false,
  );
});

test("Bus follower API allowlist permits scoped own-topic cleanup only", () => {
  const follower = {
    instanceId: "inst-a",
    connectedAtMs: 1000,
    lastHeartbeatMs: 1000,
    target: { chatId: 100, threadId: 42 },
  };
  for (const methodName of ["closeForumTopic", "deleteForumTopic"]) {
    assert.equal(
      isTelegramFollowerApiCallAllowed({
        follower,
        method: "call",
        args: [methodName, { chat_id: 100, message_thread_id: 42 }],
      }),
      true,
    );
    assert.equal(
      isTelegramFollowerApiCallAllowed({
        follower,
        method: "call",
        args: [methodName, { chat_id: 100, message_thread_id: 99 }],
      }),
      false,
    );
  }
});

test("Bus transport probe reports reachable and unreachable endpoints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-probe-"));
  const socketPath = join(dir, "bus.sock");
  const endpoint = resolveTelegramBusSocketPath(socketPath);
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: () => ({ kind: "bus.ack", requestId: "probe", ok: true }),
  });
  try {
    const missing = await probeTelegramBusEndpoint({
      endpoint,
      timeoutMs: 50,
    });
    assert.equal(missing.reachable, false);
    assert.equal(missing.transport, getTelegramBusTransportKind(endpoint));
    await server.start();
    const reachable = await probeTelegramBusEndpoint({
      endpoint,
      timeoutMs: 50,
    });
    assert.deepEqual(reachable, {
      endpoint,
      transport: getTelegramBusTransportKind(endpoint),
      reachable: true,
    });
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Leader probe classifies responsive, silent, refused and missing endpoints", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-leader-probe-"));
  const probe = (name: string, timeoutMs = 200) =>
    probeTelegramBusLeader({ socketPath: join(dir, name), secret: "secret", timeoutMs });
  const leader = createTelegramBusLocalServer({
    socketPath: join(dir, "leader.sock"),
    handleEnvelope: (envelope) => ({ kind: "bus.ack", requestId: envelope.requestId, ok: envelope.kind === "bus.probe" }),
  });
  // An older leader answers the unknown kind with a parse-failure ack, which still proves its event loop runs.
  const accepted: import("node:net").Socket[] = [];
  const older = createServer((socket) => {
    accepted.push(socket);
    socket.once("data", () => socket.end('{"kind":"bus.ack","requestId":"invalid","ok":false}\n'));
  });
  const silent = createServer((socket) => { accepted.push(socket); });
  const listen = (server: ReturnType<typeof createServer>, name: string) =>
    new Promise<void>((resolve) => server.listen(join(dir, name), resolve));
  try {
    await leader.start();
    await listen(older, "older.sock");
    await listen(silent, "silent.sock");
    // A dead leader leaves its socket inode behind: keep a hard link while the listener closes.
    const departed = createServer(() => undefined);
    await listen(departed, "departed.sock");
    linkSync(join(dir, "departed.sock"), join(dir, "refused.sock"));
    await new Promise((resolve) => departed.close(resolve));
    assert.equal(await probe("leader.sock"), "responsive");
    assert.equal(await probe("older.sock"), "responsive");
    assert.equal(await probe("silent.sock"), "silent");
    assert.equal(await probe("refused.sock"), "unreachable");
    assert.equal(await probe("missing.sock"), "unknown", "A live classic leader has no endpoint at all");
  } finally {
    await leader.stop();
    for (const socket of accepted) socket.destroy();
    await new Promise((resolve) => older.close(resolve));
    await new Promise((resolve) => silent.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Leader unresponsiveness proof needs a silent window or a confirmed unreachable endpoint for one owner", async () => {
  const run = async (results: string[], sameOwner = () => true) => {
    const observed = [...results];
    const sleeps: number[] = [];
    const proven = await proveTelegramBusLeaderUnresponsive({
      probe: async () => observed.shift() as never,
      isSameOwner: sameOwner,
      sleep: async (ms) => { sleeps.push(ms); },
      windowMs: 8000,
    });
    return { proven, sleeps, probes: results.length - observed.length };
  };
  assert.deepEqual(await run(["silent"]), { proven: true, sleeps: [], probes: 1 });
  assert.deepEqual(await run(["responsive"]), { proven: false, sleeps: [], probes: 1 });
  assert.deepEqual(await run(["unknown"]), { proven: false, sleeps: [], probes: 1 });
  assert.deepEqual(await run(["unreachable", "responsive"]), { proven: false, sleeps: [8000], probes: 2 },
    "A just-started leader binds its endpoint within the confirmation window");
  assert.deepEqual(await run(["unreachable", "unreachable"]), { proven: true, sleeps: [8000], probes: 2 });
  assert.deepEqual(await run(["unreachable", "silent"]), { proven: true, sleeps: [8000], probes: 2 });
  assert.deepEqual(await run(["silent"], () => false), { proven: false, sleeps: [], probes: 1 });
  assert.deepEqual(await run(["unreachable", "unreachable"], () => false), { proven: false, sleeps: [8000], probes: 1 },
    "An owner change during the window voids the proof before probing again");
});

test("Bus local server roundtrips through a bounded long-path fallback", { skip: process.platform === "win32" }, async () => {
  const socketPath = join(
    tmpdir(),
    "pi-telegram-very-long-endpoint-segment".repeat(4),
    "bus.sock",
  );
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: true,
    }),
  });
  try {
    await server.start();
    const response = await sendTelegramBusLocalEnvelope({
      socketPath,
      envelope: {
        kind: "follower.heartbeat",
        requestId: "long-path",
        instanceId: "follower-a",
        sentAtMs: 1000,
      },
    });
    assert.equal(response?.kind, "bus.ack");
  } finally {
    await server.stop();
  }
});

test("Bus local server resolves the active profile endpoint on each start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-profile-switch-"));
  let profileName = "work";
  const getSocketPath = () =>
    getTelegramBusSocketPath(dir, process.platform, profileName);
  const server = createTelegramBusLocalServer({
    socketPath: getSocketPath,
    handleEnvelope: () => ({ kind: "bus.ack", requestId: "profile", ok: true }),
  });
  const workSocketPath = getSocketPath();
  const resolvedWorkSocketPath = resolveTelegramBusSocketPath(workSocketPath);
  try {
    await server.start();
    assert.equal(
      (await probeTelegramBusEndpoint({ endpoint: resolvedWorkSocketPath })).reachable,
      true,
    );
    await server.stop();
    assert.equal(
      (await probeTelegramBusEndpoint({ endpoint: resolvedWorkSocketPath })).reachable,
      false,
    );

    profileName = "personal";
    const personalSocketPath = getSocketPath();
    const resolvedPersonalSocketPath =
      resolveTelegramBusSocketPath(personalSocketPath);
    await server.start();
    assert.notEqual(personalSocketPath, workSocketPath);
    assert.equal(
      (await probeTelegramBusEndpoint({ endpoint: resolvedPersonalSocketPath })).reachable,
      true,
    );
    assert.equal(
      (await probeTelegramBusEndpoint({ endpoint: resolvedWorkSocketPath })).reachable,
      false,
    );
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Old bus server stop cannot invalidate a replacement endpoint generation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-generation-"));
  const socketPath = join(dir, "bus.sock");
  const first = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: false,
      message: "first",
    }),
  });
  const replacement = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: true,
      message: "replacement",
    }),
  });
  try {
    await first.start();
    await replacement.start();
    await first.stop();

    assert.equal(
      (
        await probeTelegramBusEndpoint({
          endpoint: resolveTelegramBusSocketPath(socketPath),
          timeoutMs: 50,
        })
      ).reachable,
      true,
    );
    const response = await sendTelegramBusLocalEnvelope({
      socketPath,
      envelope: {
        kind: "follower.heartbeat",
        requestId: "replacement-generation",
        instanceId: "follower-a",
        sentAtMs: 2000,
      },
    });
    assert.deepEqual(response, {
      kind: "bus.ack",
      requestId: "replacement-generation",
      ok: true,
      message: "replacement",
    });
  } finally {
    await first.stop();
    await replacement.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Stale bus server cannot publish over a replacement endpoint generation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-publish-fence-"));
  const socketPath = join(dir, "bus.sock");
  let releasePublication: (() => void) | undefined;
  let signalPublicationReady: (() => void) | undefined;
  const publicationReady = new Promise<void>((resolve) => {
    signalPublicationReady = resolve;
  });
  const publicationRelease = new Promise<void>((resolve) => {
    releasePublication = resolve;
  });
  const stale = createTelegramBusLocalServer({
    socketPath,
    beforeEndpointPublication: async () => {
      signalPublicationReady?.();
      await publicationRelease;
    },
    commitEndpointPublication: () => false,
    handleEnvelope: () => undefined,
  });
  const replacement = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: true,
      message: "replacement",
    }),
  });
  try {
    const staleStart = stale.start();
    await publicationReady;
    await replacement.start();
    releasePublication?.();
    await assert.rejects(staleStart, /lost transport ownership/);

    const response = await sendTelegramBusLocalEnvelope({
      socketPath,
      envelope: {
        kind: "follower.heartbeat",
        requestId: "replacement-after-stale-publication",
        instanceId: "follower-a",
        sentAtMs: 2000,
      },
    });
    assert.deepEqual(response, {
      kind: "bus.ack",
      requestId: "replacement-after-stale-publication",
      ok: true,
      message: "replacement",
    });
  } finally {
    releasePublication?.();
    await stale.stop();
    await replacement.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus local server rebinds an externally unlinked Unix endpoint", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-rebind-"));
  const socketPath = join(dir, "bus.sock");
  const phases: string[] = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: () => ({ kind: "bus.ack", requestId: "rebind", ok: true }),
    recordTransportEvent: (phase) => phases.push(phase),
  });
  try {
    await server.start();
    const resolvedSocketPath = resolveTelegramBusSocketPath(socketPath);
    unlinkSync(resolvedSocketPath);
    assert.equal(existsSync(resolvedSocketPath), false);

    assert.equal(await server.ensureEndpoint(), true);
    assert.equal(existsSync(resolvedSocketPath), true);
    assert.equal(await server.ensureEndpoint(), false);
    assert.deepEqual(
      phases.filter((phase) => phase.includes("endpoint")),
      ["server-endpoint-missing", "server-endpoint-recovered"],
    );
    assert.equal(
      (
        await probeTelegramBusEndpoint({
          endpoint: resolvedSocketPath,
          timeoutMs: 50,
        })
      ).reachable,
      true,
    );
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus local client transport events include request diagnostics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-client-events-"));
  const socketPath = join(dir, "missing.sock");
  const events: Array<{ phase: string; details: Record<string, unknown> }> = [];
  try {
    await assert.rejects(
      sendTelegramBusLocalEnvelope({
        socketPath,
        envelope: {
          kind: "follower.heartbeat",
          requestId: "inst-a:events",
          instanceId: "inst-a",
          sentAtMs: 2000,
        },
        recordTransportEvent: (phase, details) =>
          events.push({ phase, details }),
      }),
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].phase, "client-failed");
    assert.equal(events[0].details.envelopeKind, "follower.heartbeat");
    assert.equal(events[0].details.requestId, "inst-a:events");
    assert.equal(
      events[0].details.transport,
      getTelegramBusTransportKind(resolveTelegramBusSocketPath(socketPath)),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus local client logs the first failure and the outcome, not every retry attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-client-retry-log-"));
  const socketPath = join(dir, "bus.sock");
  const envelope = { kind: "follower.heartbeat" as const, requestId: "inst-a:retry-log", instanceId: "inst-a", sentAtMs: 2000 };
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (request) => ({ kind: "bus.ack", requestId: request.requestId, ok: true }),
  });
  try {
    const failed: string[] = [];
    await assert.rejects(sendTelegramBusLocalEnvelope({ socketPath, envelope, retry: { attempts: 6, delayMs: 1 },
      recordTransportEvent: (phase, details) => failed.push(`${phase}:${details.attempt}`) }));
    assert.deepEqual(failed, ["client-failed:1", "client-retry:1", "client-failed:6"]);
    const recovered: string[] = [];
    setTimeout(() => void server.start(), 30);
    await sendTelegramBusLocalEnvelope({ socketPath, envelope, retry: { attempts: 200, delayMs: 5 },
      recordTransportEvent: (phase, details) => recovered.push(`${phase}:${details.attempt}`) });
    assert.deepEqual(recovered.slice(0, 2), ["client-failed:1", "client-retry:1"]);
    assert.equal(recovered.length, 3);
    assert.match(recovered[2]!, /^client-recovered:\d+$/);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus local client classifies response timeouts as transport timeouts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-client-timeout-"));
  const socketPath = join(dir, "bus.sock");
  const events: Array<{ phase: string; details: Record<string, unknown> }> = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: () => undefined,
  });
  try {
    await server.start();
    await assert.rejects(
      sendTelegramBusLocalEnvelope({
        socketPath,
        timeoutMs: 5,
        envelope: {
          kind: "follower.heartbeat",
          requestId: "inst-a:timeout",
          instanceId: "inst-a",
          sentAtMs: 2000,
        },
        recordTransportEvent: (phase, details) =>
          events.push({ phase, details }),
      }),
    );
    assert.equal(events[0].phase, "client-failed");
    assert.equal(events[0].details.code, "ETIMEDOUT");
    assert.equal(events[0].details.kind, "timeout");
    assert.equal(events[0].details.retryable, true);
    assert.equal(events[0].details.requestId, "inst-a:timeout");
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus local client accepts a buffered response after its event loop resumes past the deadline", { timeout: 2_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-client-stall-"));
  const socketPath = process.platform === "win32"
    ? getTelegramBusFollowerEndpoint({
        agentDir: dir,
        platform: process.platform,
        instanceId: "stall-test",
      })
    : resolveTelegramBusSocketPath(join(dir, "bus.sock"));
  const worker = new Worker(
    `
      import { createServer } from "node:net";
      import { parentPort, workerData } from "node:worker_threads";

      const server = createServer((socket) => {
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("error", () => undefined);
        socket.on("data", (chunk) => {
          buffer += chunk;
          const newlineIndex = buffer.indexOf("\\n");
          if (newlineIndex < 0) return;
          const envelope = JSON.parse(buffer.slice(0, newlineIndex));
          parentPort.postMessage("received");
          setTimeout(() => {
            socket.end(JSON.stringify({
              kind: "bus.ack",
              requestId: envelope.requestId,
              ok: true,
            }) + "\\n", () => {
              server.close(() => parentPort.close());
            });
          }, 5);
        });
      });
      server.listen(workerData.socketPath, () => parentPort.postMessage("ready"));
    `,
    { eval: true, workerData: { socketPath } },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once("message", (message) => {
        if (message === "ready") resolve();
        else reject(new Error(`Unexpected worker message: ${String(message)}`));
      });
      worker.once("error", reject);
    });
    const received = new Promise<void>((resolve) => {
      worker.once("message", () => resolve());
    });
    const responsePromise = sendTelegramBusLocalEnvelope({
      socketPath,
      timeoutMs: 100,
      envelope: {
        kind: "follower.heartbeat",
        requestId: "inst-a:stalled-event-loop",
        instanceId: "inst-a",
        sentAtMs: 2000,
      },
    });
    await received;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    assert.deepEqual(await responsePromise, {
      kind: "bus.ack",
      requestId: "inst-a:stalled-event-loop",
      ok: true,
      message: undefined,
    });
  } finally {
    await worker.terminate();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus local server memoizes completed and in-flight request results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-ledger-"));
  const socketPath = join(dir, "bus.sock");
  let executions = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createTelegramBusLocalServer({
    socketPath,
    async handleEnvelope(envelope) {
      executions += 1;
      await gate;
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: true,
        result: { executions },
      };
    },
  });
  try {
    await server.start();
    const envelope = {
      kind: "follower.heartbeat" as const,
      requestId: "follower-a:ledger:1",
      instanceId: "follower-a",
      sentAtMs: 1000,
    };
    const first = sendTelegramBusLocalEnvelope({ socketPath, envelope });
    const duplicate = sendTelegramBusLocalEnvelope({ socketPath, envelope });
    const deadline = Date.now() + 1000;
    while (executions === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(executions, 1);
    release?.();
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    const replayResult = await sendTelegramBusLocalEnvelope({
      socketPath,
      envelope,
    });
    assert.deepEqual(firstResult, duplicateResult);
    assert.deepEqual(replayResult, firstResult);
    assert.equal(executions, 1);
  } finally {
    release?.();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus retry returns the memoized result after the first acknowledgement is lost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-ledger-ack-loss-"));
  const socketPath = join(dir, "bus.sock");
  let executions = 0;
  let dropped = false;
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope(envelope) {
      executions += 1;
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: true,
        result: { message_id: 77 },
      };
    },
    shouldDropResponse() {
      if (dropped) return false;
      dropped = true;
      return true;
    },
  });
  try {
    await server.start();
    const response = await sendTelegramBusLocalEnvelope({
      socketPath,
      timeoutMs: 10,
      retry: { attempts: 2, delayMs: 0 },
      envelope: {
        kind: "follower.callApi",
        requestId: "follower-a:send:1",
        instanceId: "follower-a",
        method: "call",
        args: ["sendMessage", { chat_id: 1, text: "hello" }],
        sentAtMs: 1000,
      },
    });
    assert.deepEqual(response, {
      kind: "bus.ack",
      requestId: "follower-a:send:1",
      ok: true,
      message: undefined,
      result: { message_id: 77 },
    });
    assert.equal(executions, 1);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus local server rejects request-id reuse with a changed payload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-ledger-collision-"));
  const socketPath = join(dir, "bus.sock");
  let executions = 0;
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope(envelope) {
      executions += 1;
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: true,
      };
    },
  });
  try {
    await server.start();
    const first = {
      kind: "follower.heartbeat" as const,
      requestId: "follower-a:collision:1",
      instanceId: "follower-a",
      sentAtMs: 1000,
    };
    await sendTelegramBusLocalEnvelope({ socketPath, envelope: first });
    const collision = await sendTelegramBusLocalEnvelope({
      socketPath,
      envelope: { ...first, sentAtMs: 1001 },
    });
    assert.equal(executions, 1);
    assert.deepEqual(collision, {
      kind: "bus.ack",
      requestId: first.requestId,
      ok: false,
      message: "Telegram bus request id was reused with a different payload.",
      error: { code: "request-id-collision" },
    });
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus local IPC server reports handler failures as protocol acks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-handler-failure-"));
  const socketPath = join(dir, "bus.sock");
  const events: Array<{ phase: string; details: Record<string, unknown> }> = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: () => {
      throw new Error("boom");
    },
    recordTransportEvent: (phase, details) => events.push({ phase, details }),
  });
  try {
    await server.start();
    const response = await sendTelegramBusLocalEnvelope({
      socketPath,
      envelope: {
        kind: "follower.heartbeat",
        requestId: "inst-a:failed-handler",
        instanceId: "inst-a",
        sentAtMs: 2000,
      },
    });
    assert.deepEqual(response, {
      kind: "bus.ack",
      requestId: "inst-a:failed-handler",
      ok: false,
      message: "Telegram bus handler failed.",
    });
    const failure = events.find(
      (event) => event.phase === "server-handler-failed",
    );
    assert.equal(failure?.details.envelopeKind, "follower.heartbeat");
    assert.equal(failure?.details.requestId, "inst-a:failed-handler");
    assert.equal(
      failure?.details.transport,
      getTelegramBusTransportKind(resolveTelegramBusSocketPath(socketPath)),
    );
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus local IPC server handles request/response envelopes over a private Unix socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-"));
  const socketPath = join(dir, "bus.sock");
  const received: string[] = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => {
      received.push(envelope.kind);
      return { kind: "bus.ack", requestId: envelope.requestId, ok: true };
    },
  });
  try {
    await server.start();
    if (process.platform !== "win32") {
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(statSync(socketPath).mode & 0o777, 0o600);
    }
    const response = await sendTelegramBusLocalEnvelope({
      socketPath,
      envelope: {
        kind: "follower.heartbeat",
        requestId: "inst-a:2",
        instanceId: "inst-a",
        sentAtMs: 2000,
      },
    });
    assert.deepEqual(response, {
      kind: "bus.ack",
      requestId: "inst-a:2",
      ok: true,
      message: undefined,
    });
    assert.deepEqual(received, ["follower.heartbeat"]);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "Bus local IPC server roundtrips over a Windows named pipe",
  { skip: process.platform !== "win32" },
  async () => {
    const socketPath = getTelegramBusSocketPath(
      join(tmpdir(), `pi-telegram-bus-win-${process.pid}`),
      "win32",
    );
    const received: string[] = [];
    const server = createTelegramBusLocalServer({
      socketPath,
      handleEnvelope: (envelope) => {
        received.push(envelope.kind);
        return { kind: "bus.ack", requestId: envelope.requestId, ok: true };
      },
    });
    try {
      await server.start();
      const response = await sendTelegramBusLocalEnvelope({
        socketPath,
        envelope: {
          kind: "follower.heartbeat",
          requestId: "inst-a:win",
          instanceId: "inst-a",
          sentAtMs: 2000,
        },
      });
      assert.deepEqual(response, {
        kind: "bus.ack",
        requestId: "inst-a:win",
        ok: true,
        message: undefined,
      });
      assert.deepEqual(received, ["follower.heartbeat"]);
    } finally {
      await server.stop();
    }
  },
);

test("Bus foreign-owned update forwarder sends routed update envelopes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-forwarder-"));
  const socketPath = join(dir, "bus.sock");
  const received: unknown[] = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => {
      received.push(envelope);
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: true,
        ...("delivery" in envelope && envelope.delivery
          ? {
              result: {
                deliveryId: envelope.delivery.deliveryId,
                sourceUpdateId: envelope.delivery.sourceUpdateId,
              },
            }
          : {}),
      };
    },
  });
  let sequence = 0;
  const forwarder = createTelegramBusForeignOwnedUpdateForwarder({
    socketPath,
    createRequestId: () => `leader:${++sequence}`,
    getNowMs: () => 9000,
  });
  const expectedDelivery = createTelegramBusFollowerDeliveryIdentity({
    kind: "leader.forwardMessage",
    recipientBindingKey: "manual:owner-b",
    sourceUpdateId: 44,
  });
  try {
    await server.start();
    assert.deepEqual(
      await forwarder.forwardCallback({
        query: { id: "cb-1" },
        ownership: { instanceId: "inst-b" },
        ctx: "ctx",
      }),
      {
        status: "terminal-rejected",
        failureClass: "source-update-identity-missing",
        message: "Forwarded Telegram update has no durable source identity.",
      },
    );
    assert.deepEqual(
      await forwarder.forwardReaction({
        reactionUpdate: { message_id: 7 },
        ownership: { instanceId: "inst-b" },
        ctx: "ctx",
      }),
      {
        status: "terminal-rejected",
        failureClass: "source-update-identity-missing",
        message: "Forwarded Telegram update has no durable source identity.",
      },
    );
    const generationlessDelivery =
      createTelegramBusFollowerDeliveryIdentity({
        kind: "leader.forwardMessage",
        recipientBindingKey: "manual:owner-b",
        sourceUpdateId: 43,
      });
    assert.deepEqual(
      await forwarder.forwardMessage({
        message: { message_id: 7, pi_telegram_source_update_id: 43 },
        ownership: {
          instanceId: "inst-b",
          recipientBindingKey: "manual:owner-b",
        },
        ctx: "ctx",
      }),
      {
        status: "retryable",
        failureClass: "recipient-generation-missing",
        message: "Forwarded Telegram update has no live recipient generation.",
        delivery: generationlessDelivery,
      },
    );
    assert.deepEqual(
      await forwarder.forwardMessage({
        message: { message_id: 7, pi_telegram_source_update_id: 43 },
        ownership: {
          instanceId: "inst-b",
          ownerGeneration: "registration-b",
        },
        ctx: "ctx",
      }),
      {
        status: "terminal-rejected",
        failureClass: "recipient-binding-missing",
        message: "Forwarded Telegram update has no stable recipient binding.",
        sourceUpdateId: 43,
      },
    );
    assert.deepEqual(
      await forwarder.forwardMessage({
        message: {
          message_id: 8,
          pi_telegram_source_update_id: 44,
        },
        ownership: {
          instanceId: "inst-b",
          ownerGeneration: "registration-b",
          recipientBindingKey: "manual:owner-b",
        },
        ctx: "ctx",
      }),
      { status: "accepted", delivery: expectedDelivery },
    );
    assert.deepEqual(
      await forwarder.forwardEditedMessage({
        message: { message_id: 9 },
        ownership: { instanceId: "inst-b" },
        ctx: "ctx",
      }),
      {
        status: "terminal-rejected",
        failureClass: "source-update-identity-missing",
        message: "Forwarded Telegram update has no durable source identity.",
      },
    );
    assert.deepEqual(received, [
      {
        kind: "leader.forwardMessage",
        requestId: "leader:1",
        recipientInstanceId: "inst-b",
        recipientRegistrationGeneration: "registration-b",
        delivery: expectedDelivery,
        message: {
          message_id: 8,
          pi_telegram_source_update_id: 44,
        },
        sentAtMs: 9000,
      },
    ]);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const mode of ["current", "source-ended-initial", "source-ended-before-connect", "source-ended-before-write",
  "recipient-ended-before-connect", "source-ended-after-write", "recipient-ended-after-write", "connection-refused"] as const) {
  test(`Guarded foreign forward fences native IPC issuance and ACK (${mode})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-telegram-forward-guard-"));
    const socketPath = getTelegramBusFollowerSocketPath("guarded", dir);
    const ownership = { instanceId: "guarded", ownerGeneration: "g1", recipientBindingKey: "manual:guarded" };
    let sourceCurrent = mode !== "source-ended-initial", ownershipCurrent = true;
    let guardCalls = 0, ownershipReads = 0;
    const received: TelegramBusEnvelope[] = [];
    const server = createTelegramBusLocalServer({ socketPath, handleEnvelope(envelope) {
      received.push(envelope);
      assert.equal(envelope.kind, "leader.forwardMessage");
      if (envelope.kind !== "leader.forwardMessage") throw new Error("Unexpected probe request");
      assert.equal(envelope.auth, "guard-secret");
      assert.equal(envelope.recipientRegistrationGeneration, "g1");
      if (mode === "source-ended-after-write") sourceCurrent = false;
      if (mode === "recipient-ended-after-write") ownershipCurrent = false;
      return { kind: "bus.ack", requestId: envelope.requestId, ok: true,
        result: { deliveryId: envelope.delivery.deliveryId, sourceUpdateId: envelope.delivery.sourceUpdateId } };
    } });
    const message = { message_id: 1000, pi_telegram_source_update_id: 51,
      get text() { if (mode === "source-ended-before-write") sourceCurrent = false; return "held source"; } };
    const forwarder = createTelegramBusForeignOwnedUpdateForwarder({ socketPath,
      createRequestId: () => "guarded:request", getAuthSecret: () => "guard-secret",
      validateForwardOwnership() { ownershipReads++; return ownershipCurrent; },
    });
    try {
      if (mode !== "connection-refused") await server.start();
      const pending = forwarder.forwardMessage({ message, ownership, ctx: { generation: 1 }, assertAuthority() {
        guardCalls++;
        if (!sourceCurrent) throw new Error("Source authority changed.");
      } });
      if (mode === "source-ended-before-connect") queueMicrotask(() => { sourceCurrent = false; });
      if (mode === "recipient-ended-before-connect") queueMicrotask(() => { ownershipCurrent = false; });
      const result = await pending;
      assert.equal(result.status, mode === "current" ? "accepted" : "retryable");
      const alreadyIssued = mode === "current" || mode.endsWith("after-write");
      assert.equal(received.length, alreadyIssued ? 1 : 0,
        "Ended authority prevents new issuance; it never claims to unsend an issued envelope");
      assert.doesNotMatch(JSON.stringify(received), /assertAuthority|Source authority changed|generation/);
      assert.equal(result.delivery?.sourceUpdateId, 51, "Authority refusal retains the same durable delivery/source identity");
      if (mode === "current") {
        assert.ok(guardCalls >= 4, "The local guard reaches connect, post-encoding write and ACK boundaries");
        assert.ok(ownershipReads >= 4, "Ownership is not a one-time pre-connect observation");
      }
      if (mode === "connection-refused") assert.equal(guardCalls, 1, "Guarded sends disable platform reconnect retry");
      if (mode.startsWith("source-ended")) {
        assert.equal(result.status, "retryable");
        assert.match("message" in result ? result.message ?? "" : "", /authority/);
      }
    } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("Bus forwarder selects payload-free custody wake only for capable peers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-custody-forwarder-"));
  const socketPath = join(dir, "bus.sock");
  const received: TelegramBusEnvelope[] = [];
  const server = createTelegramBusLocalServer({ socketPath, handleEnvelope(envelope) {
    received.push(envelope);
    return { kind: "bus.ack", requestId: envelope.requestId, ok: true,
      ...(envelope.kind === "leader.wakeInputCustody" ? { result: {
        deliveryId: envelope.delivery.deliveryId,
        sourceUpdateId: envelope.delivery.sourceUpdateId } } : {}) };
  } });
  const capable = createTelegramBusProtocolIdentity({ runtimeBuild: "0.45.0",
    capabilities: [TELEGRAM_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE] });
  const expectedOwnership = { instanceId: "inst-b", ownerGeneration: "g1",
    recipientBindingKey: "workspace:recipient", protocolIdentity: capable };
  let currentOwnership = expectedOwnership;
  const forwarder = createTelegramBusForeignOwnedUpdateForwarder({ socketPath,
    createRequestId: () => "leader:custody", getNowMs: () => 9_000,
    localProtocolIdentity: capable,
    validateForwardOwnership: ownership =>
      isTelegramBusForwardOwnershipCurrent(ownership, currentOwnership),
    resolveInputCustodyReference: ({ sourceUpdateId }) => {
      if (sourceUpdateId === 46) currentOwnership = { ...expectedOwnership,
        ownerGeneration: "g2", protocolIdentity: createTelegramBusProtocolIdentity({
          runtimeBuild: "0.44.0" }) };
      return sourceUpdateId === 44 || sourceUpdateId === 46 ? {
        sourceRecoveryKey: "journal:source", source: { updateId: sourceUpdateId,
          owner: { acquisitionId: `acquisition-${sourceUpdateId}`,
            handoffId: `handoff-${sourceUpdateId}` } } } : undefined;
    },
  });
  try {
    await server.start();
    const missing = await forwarder.forwardMessage({ message: {
      message_id: 7, pi_telegram_source_update_id: 45 }, ownership: {
      instanceId: "inst-b", ownerGeneration: "g1", recipientBindingKey: "workspace:recipient",
      protocolIdentity: capable }, ctx: "ctx" });
    assert.equal(missing.status, "retryable");
    assert.equal("failureClass" in missing && missing.failureClass, "source-reference-missing");
    const accepted = await forwarder.forwardMessage({ message: {
      message_id: 8, text: "must-not-cross", pi_telegram_source_update_id: 44 },
      ownership: expectedOwnership, ctx: "ctx" });
    assert.equal(accepted.status, "accepted");
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], { kind: "leader.wakeInputCustody", requestId: "leader:custody",
      recipientInstanceId: "inst-b", recipientRegistrationGeneration: "g1",
      delivery: createTelegramBusFollowerSourceReferenceDeliveryIdentity({
        kind: "leader.wakeInputCustody", recipientBindingKey: "workspace:recipient",
        sourceRecoveryKey: "journal:source", source: { updateId: 44,
          owner: { acquisitionId: "acquisition-44", handoffId: "handoff-44" } } }),
      sentAtMs: 9_000 });
    assert.doesNotMatch(JSON.stringify(received), /must-not-cross|message_id/);
    currentOwnership = { ...expectedOwnership, ownerGeneration: "g2",
      protocolIdentity: createTelegramBusProtocolIdentity({ runtimeBuild: "0.44.0" }) };
    const postAcceptRetry = await forwarder.forwardMessage({ message: {
      message_id: 8, text: "must-not-cross", pi_telegram_source_update_id: 44 },
      ownership: expectedOwnership, ctx: "ctx" });
    assert.equal(postAcceptRetry.status, "retryable");
    assert.equal("failureClass" in postAcceptRetry && postAcceptRetry.failureClass,
      "recipient-ownership-stale");
    assert.equal(received.length, 1);
    currentOwnership = expectedOwnership;
    const stale = await forwarder.forwardMessage({ message: {
      message_id: 9, pi_telegram_source_update_id: 46 },
      ownership: expectedOwnership, ctx: "ctx" });
    assert.equal(stale.status, "retryable");
    assert.equal("failureClass" in stale && stale.failureClass, "recipient-ownership-stale");
    assert.equal(received.length, 1);
  } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("Bus durable follower forwarding rejects an ACK without the exact receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-missing-receipt-"));
  const socketPath = join(dir, "bus.sock");
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: true,
    }),
  });
  const forwarder = createTelegramBusForeignOwnedUpdateForwarder({
    socketPath,
    createRequestId: () => "leader:missing-receipt",
  });
  try {
    await server.start();
    const delivery = createTelegramBusFollowerDeliveryIdentity({
      kind: "leader.forwardMessage",
      recipientBindingKey: "manual:owner-b",
      sourceUpdateId: 44,
    });
    assert.deepEqual(
      await forwarder.forwardMessage({
        message: { message_id: 8, pi_telegram_source_update_id: 44 },
        ownership: {
          instanceId: "inst-b",
          ownerGeneration: "registration-b",
          recipientBindingKey: "manual:owner-b",
        },
        ctx: "ctx",
      }),
      {
        status: "terminal-rejected",
        failureClass: "durable-receipt-missing",
        message: "Follower acknowledgement omitted the durable receipt.",
        delivery,
      },
    );
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus durable follower forwarding classifies negative ACKs as retryable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-negative-ack-"));
  const socketPath = join(dir, "bus.sock");
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: false,
      message: "Stale Telegram bus follower registration generation.",
    }),
  });
  const forwarder = createTelegramBusForeignOwnedUpdateForwarder({
    socketPath,
    createRequestId: () => "leader:negative-ack",
  });
  const delivery = createTelegramBusFollowerDeliveryIdentity({
    kind: "leader.forwardMessage",
    recipientBindingKey: "manual:owner-b",
    sourceUpdateId: 44,
  });
  try {
    await server.start();
    assert.deepEqual(
      await forwarder.forwardMessage({
        message: { message_id: 8, pi_telegram_source_update_id: 44 },
        ownership: {
          instanceId: "inst-b",
          ownerGeneration: "registration-b",
          recipientBindingKey: "manual:owner-b",
        },
        ctx: "ctx",
      }),
      {
        status: "retryable",
        failureClass: "acknowledgement-rejected",
        message: "Stale Telegram bus follower registration generation.",
        delivery,
      },
    );
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus durable follower forwarding rejects a mismatched receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-mismatched-receipt-"));
  const socketPath = join(dir, "bus.sock");
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: true,
      result: { deliveryId: "wrong-delivery", sourceUpdateId: 44 },
    }),
  });
  const forwarder = createTelegramBusForeignOwnedUpdateForwarder({
    socketPath,
    createRequestId: () => "leader:mismatched-receipt",
  });
  const delivery = createTelegramBusFollowerDeliveryIdentity({
    kind: "leader.forwardMessage",
    recipientBindingKey: "manual:owner-b",
    sourceUpdateId: 44,
  });
  try {
    await server.start();
    assert.deepEqual(
      await forwarder.forwardMessage({
        message: { message_id: 8, pi_telegram_source_update_id: 44 },
        ownership: {
          instanceId: "inst-b",
          ownerGeneration: "registration-b",
          recipientBindingKey: "manual:owner-b",
        },
        ctx: "ctx",
      }),
      {
        status: "terminal-rejected",
        failureClass: "durable-receipt-mismatched",
        message: "Follower acknowledgement returned a mismatched durable receipt.",
        delivery,
      },
    );
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus lost ACK replay keeps delivery identity and follower admission idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-lost-ack-"));
  const socketPath = join(dir, "bus.sock");
  const admitted = new Set<number>();
  const journalAppends: number[] = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope(envelope) {
      if (!("delivery" in envelope) || !envelope.delivery) return undefined;
      if (!admitted.has(envelope.delivery.sourceUpdateId)) {
        admitted.add(envelope.delivery.sourceUpdateId);
        journalAppends.push(envelope.delivery.sourceUpdateId);
      }
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: true,
        result: {
          deliveryId: envelope.delivery.deliveryId,
          sourceUpdateId: envelope.delivery.sourceUpdateId,
        },
      };
    },
    shouldDropResponse: (request) => request.requestId === "leader:1",
  });
  let sequence = 0;
  const forwarder = createTelegramBusForeignOwnedUpdateForwarder({
    socketPath,
    createRequestId: () => `leader:${++sequence}`,
    timeoutMs: 20,
  });
  const delivery = createTelegramBusFollowerDeliveryIdentity({
    kind: "leader.forwardMessage",
    recipientBindingKey: "manual:owner-b",
    sourceUpdateId: 44,
  });
  const forward = () =>
    forwarder.forwardMessage({
      message: { message_id: 8, pi_telegram_source_update_id: 44 },
      ownership: {
        instanceId: "inst-b",
        ownerGeneration: "registration-b",
        recipientBindingKey: "manual:owner-b",
      },
      ctx: "ctx",
    });
  try {
    await server.start();
    const first = await forward();
    assert.equal(first.status, "retryable");
    assert.equal(
      first.status === "retryable" ? first.failureClass : undefined,
      "transport-failed",
    );
    assert.deepEqual(
      first.status === "retryable" ? first.delivery : undefined,
      delivery,
    );
    assert.deepEqual(await forward(), { status: "accepted", delivery });
    assert.deepEqual(journalAppends, [44]);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus foreign-owned update forwarder supports tolerant timeouts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-forwarder-slow-"));
  const socketPath = join(dir, "bus.sock");
  const server = createTelegramBusLocalServer({
    socketPath,
    async handleEnvelope(envelope) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: true,
        result:
          "delivery" in envelope && envelope.delivery
            ? {
                deliveryId: envelope.delivery.deliveryId,
                sourceUpdateId: envelope.delivery.sourceUpdateId,
              }
            : undefined,
      };
    },
  });
  const forwarder = createTelegramBusForeignOwnedUpdateForwarder({
    socketPath,
    createRequestId: () => "leader:slow",
    timeoutMs: 120,
  });
  try {
    await server.start();
    const delivery = createTelegramBusFollowerDeliveryIdentity({
      kind: "leader.forwardMessage",
      recipientBindingKey: "manual:owner-b",
      sourceUpdateId: 44,
    });
    assert.deepEqual(
      await forwarder.forwardMessage({
        message: { message_id: 8, pi_telegram_source_update_id: 44 },
        ownership: {
          instanceId: "inst-b",
          ownerGeneration: "registration-b",
          recipientBindingKey: "manual:owner-b",
        },
        ctx: "ctx",
      }),
      { status: "accepted", delivery },
    );
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registry resolves followers by target", () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "private",
    target: { chatId: 1 },
    connectedAtMs: 1000,
  });
  registry.register({
    instanceId: "thread",
    target: { chatId: 1, threadId: 2 },
    connectedAtMs: 1000,
  });

  assert.equal(registry.getByTarget({ chatId: 1 })?.instanceId, "private");
  assert.equal(
    registry.getByTarget({ chatId: 1, threadId: 2 })?.instanceId,
    "thread",
  );
  assert.equal(registry.getByTarget({ chatId: 1, threadId: 3 }), undefined);
});

test("Bus follower registry replaces stale registrations by profile and target", () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "follower:old",
    profileKey: "manual:follower",
    target: { chatId: 1, threadId: 2 },
    connectedAtMs: 1000,
  });
  registry.register({
    instanceId: "follower:new",
    profileKey: "manual:follower",
    target: { chatId: 1, threadId: 2 },
    connectedAtMs: 2000,
  });

  assert.equal(registry.get("follower:old"), undefined);
  assert.equal(
    registry.getByTarget({ chatId: 1, threadId: 2 })?.instanceId,
    "follower:new",
  );
  assert.deepEqual(
    registry.list().map((follower) => follower.instanceId),
    ["follower:new"],
  );
});

test("Bus forward ownership validator follows live registry replacement", () => {
  const registry = createTelegramBusFollowerRegistry();
  const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "0.45.0",
    capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
      TELEGRAM_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE] });
  registry.register({ instanceId: "follower", profileKey: "workspace:recipient",
    registrationGeneration: "g1", protocol, connectedAtMs: 1 });
  const validate = createTelegramBusForwardOwnershipValidator(registry);
  const ownership = { instanceId: "follower", ownerGeneration: "g1",
    recipientBindingKey: "workspace:recipient", protocolIdentity: protocol };
  assert.equal(validate(ownership), true);
  registry.register({ instanceId: "follower", profileKey: "workspace:recipient",
    registrationGeneration: "g1", protocol: createTelegramBusProtocolIdentity({
      runtimeBuild: "0.44.0", capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION] }),
    connectedAtMs: 2 });
  assert.equal(validate(ownership), false);
  registry.remove("follower");
  assert.equal(validate(ownership), false);
  registry.register({ instanceId: "follower", profileKey: "workspace:recipient",
    registrationGeneration: "g2", protocol: createTelegramBusProtocolIdentity({
      runtimeBuild: "0.44.0", capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION] }),
    connectedAtMs: 2 });
  assert.equal(validate(ownership), false);
  const current = getTelegramFollowerTargetOwnership({ target: { chatId: 1, threadId: 2 },
    followers: [{ ...registry.get("follower")!, target: { chatId: 1, threadId: 2 } }] });
  assert.ok(current);
  assert.equal(validate(current), true);
});

test("Bus follower target ownership carries the live registration generation", () => {
  assert.deepEqual(
    getTelegramFollowerTargetOwnership({
      target: { chatId: 1, threadId: 2 },
      followers: [
        {
          instanceId: "follower-live",
          profileKey: "manual:owner-live",
          target: { chatId: 1, threadId: 2 },
          registrationGeneration: "registration-2",
          protocol: createTelegramBusProtocolIdentity({
            runtimeBuild: "0.28.0",
            capabilities: [
              TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
            ],
          }),
          connectedAtMs: 2000,
          lastHeartbeatMs: 2001,
        },
      ],
    }),
    {
      instanceId: "follower-live",
      ownerGeneration: "registration-2",
      recipientBindingKey: "manual:owner-live",
      protocolIdentity: createTelegramBusProtocolIdentity({ runtimeBuild: "0.28.0",
        capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION] }),
    },
  );
});

test("Bus follower target ownership requires negotiated routing capabilities", () => {
  const follower = {
    instanceId: "follower-live",
    profileKey: "manual:owner-a",
    target: { chatId: 1, threadId: 2 },
    connectedAtMs: 1,
    lastHeartbeatMs: 2,
    registrationGeneration: "registration-2",
    protocol: createTelegramBusProtocolIdentity({
      runtimeBuild: "0.28.0",
      capabilities: [],
    }),
  };
  assert.equal(
    getTelegramFollowerTargetOwnership({
      target: { chatId: 1, threadId: 2 },
      followers: [follower],
    }),
    undefined,
  );
  follower.protocol = createTelegramBusProtocolIdentity({
    runtimeBuild: "0.28.0",
    capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION],
  });
  assert.deepEqual(
    getTelegramFollowerTargetOwnership({
      target: { chatId: 1, threadId: 2 },
      followers: [follower],
    }),
    {
      instanceId: "follower-live",
      ownerGeneration: "registration-2",
      recipientBindingKey: "manual:owner-a",
      protocolIdentity: follower.protocol,
    },
  );
  const local = createTelegramBusProtocolIdentity({ runtimeBuild: "0.45.0",
    capabilities: [TELEGRAM_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE] });
  assert.equal(canUseTelegramBusInputCustodyReference({ local,
    remote: getTelegramFollowerTargetOwnership({ target: { chatId: 1, threadId: 2 },
      followers: [follower] })?.protocolIdentity }), false);
  follower.protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "0.45.0",
    capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
      TELEGRAM_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE] });
  assert.equal(canUseTelegramBusInputCustodyReference({ local,
    remote: getTelegramFollowerTargetOwnership({ target: { chatId: 1, threadId: 2 },
      followers: [follower] })?.protocolIdentity }), true);
  follower.protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "0.44.0",
    capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION] });
  assert.equal(canUseTelegramBusInputCustodyReference({ local,
    remote: getTelegramFollowerTargetOwnership({ target: { chatId: 1, threadId: 2 },
      followers: [follower] })?.protocolIdentity }), false);
});

test("Bus follower target ownership never treats persisted bindings as live authority", () => {
  assert.equal(
    getTelegramFollowerTargetOwnership({
      target: { chatId: 1, threadId: 2 },
      followers: [],
      currentInstanceId: "leader",
      activeThreadRecords: [
        {
          status: "active",
          instanceId: "follower-a",
          profileKey: "manual:follower-a",
          owner: { kind: "manual-follower" },
          target: { chatId: 1, threadId: 2 },
        },
      ],
    }),
    undefined,
  );
  assert.equal(
    getTelegramFollowerTargetOwnership({
      target: { chatId: 1, threadId: 2 },
      followers: [],
      currentInstanceId: "leader-b",
      activeThreadRecords: [
        {
          status: "active",
          instanceId: "leader-a",
          profileKey: "cwd:/repo",
          owner: { kind: "leader" },
          target: { chatId: 1, threadId: 2 },
        },
      ],
    }),
    undefined,
  );
  assert.equal(
    getTelegramFollowerTargetOwnership({
      target: { chatId: 1, threadId: 2 },
      followers: [],
      currentInstanceId: "leader",
      activeThreadRecords: [
        {
          status: "offline",
          instanceId: "follower-a",
          profileKey: "manual:follower-a",
          owner: { kind: "manual-follower" },
          target: { chatId: 1, threadId: 2 },
        },
      ],
    }),
    undefined,
  );
});

test("Unregistered follower observations are non-routing and invalidate on replacement even after removal", () => {
  for (const change of ["instance", "profile", "target", "unrelated", "clear", "release"] as const) {
    const registry = createTelegramBusFollowerRegistry();
    const old = { instanceId: "old", profileKey: "owner", target: { chatId: 7, threadId: 11 },
      connectedAtMs: 0, pid: 42, registrationGeneration: "old:1" };
    registry.register(old);
    const liveObservation = registry.observeUnregistered(registry.get("old")!);
    assert.equal(liveObservation.isCurrent(), false);
    const [removed] = registry.pruneStale(1000, 100);
    const observation = registry.observeUnregistered(removed!);
    assert.equal(observation.isCurrent(), true);
    assert.deepEqual(registry.list(), []);
    assert.equal(registry.getByTarget(old.target), undefined);
    assert.equal(registry.heartbeat(old.instanceId, 1001), undefined);
    if (change === "clear") registry.clear();
    else if (change === "release") observation.release();
    else {
      const replacement = { ...old, instanceId: change === "instance" ? "old" : "new",
        profileKey: change === "profile" ? "owner" : "other",
        target: change === "target" ? old.target : { chatId: 7, threadId: 12 },
        registrationGeneration: "new:1", pid: 43 };
      registry.register(replacement);
      registry.remove(replacement.instanceId);
    }
    assert.equal(observation.isCurrent(), change === "unrelated", change);
    assert.equal(liveObservation.isCurrent(), false, "a former live observation never gains authority");
    observation.release();
    observation.release();
    assert.equal(observation.isCurrent(), false);
  }
});

test("Bus follower registry returns defensive copies", () => {
  const registry = createTelegramBusFollowerRegistry();
  const registered = registry.register({
    instanceId: "inst-a",
    target: { chatId: 1, threadId: 2 },
    protocol: createTelegramBusProtocolIdentity({
      runtimeBuild: "0.28.0",
      capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION],
    }),
    connectedAtMs: 1000,
  });
  registered.target = { chatId: 99 };
  registered.protocol?.capabilities.splice(0);

  assert.deepEqual(registry.get("inst-a")?.target, { chatId: 1, threadId: 2 });
  assert.deepEqual(registry.get("inst-a")?.protocol?.capabilities, [
    TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
  ]);
  const byTarget = registry.getByTarget({ chatId: 1, threadId: 2 });
  if (byTarget) byTarget.target = { chatId: 99 };
  assert.deepEqual(registry.getByTarget({ chatId: 1, threadId: 2 })?.target, {
    chatId: 1,
    threadId: 2,
  });
});

test("Bus follower registration identity ignores liveness and target but not process, endpoint or protocol", () => {
  const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: [] });
  const captured = { instanceId: "follower", profileKey: "work", sessionId: "session", registrationGeneration: "generation",
    pid: 42, processBirthId: "42:birth", sessionGeneration: 3, cwd: "/workspace", slot: "B", busSocketPath: "/tmp/follower.sock",
    protocol, connectedAtMs: 1, target: { chatId: 7, threadId: 10 } };
  assert.equal(isSameTelegramBusFollowerRegistration(
    { ...captured, connectedAtMs: 99, target: { chatId: 7, threadId: 11 }, protocol: structuredClone(protocol) }, captured), true);
  for (const change of [{ registrationGeneration: "next" }, { processBirthId: "42:other" }, { busSocketPath: "/tmp/other.sock" },
    { slot: "C" }, { protocol: createTelegramBusProtocolIdentity({ runtimeBuild: "other", capabilities: [] }) }]) {
    assert.equal(isSameTelegramBusFollowerRegistration({ ...captured, ...change }, captured), false, JSON.stringify(change));
  }
});

test("Bus rejection acknowledgements carry only the request and diagnostic", () => {
  assert.deepEqual(rejectTelegramBusRequest("request", "Refused."),
    { kind: "bus.ack", requestId: "request", ok: false, message: "Refused." });
});
