/**
 * Regression tests for Telegram multi-instance bus follower helpers
 * Covers follower registration, forwarded update receiving, and follower-routed API calls
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { advanceTelegramWorkspaceRestore } from "../lib/routing.ts";
import { withWorkspaceRestoreFixture as fixture, restoreFixtureRecipient as recipient } from "./fixtures/workspace.ts";
import test from "node:test";

test("Native registration notifications include equal-field replacement without widening legacy publication evidence", () => {
  let availability = 0;
  const snapshots: Array<{ registered: boolean; generation: string | undefined }> = [];
  const state = createTelegramBusFollowerRegistrationState({
    onAvailabilityChanged() { availability++; },
    onRegistrationChanged() { snapshots.push({ registered: state.isRegistered(), generation: state.getGeneration() }); },
  });
  const target = { chatId: 7, threadId: 8 }, metadata = { generation: "same" };
  state.setRegistered(true, target, metadata);
  const original = state.capturePublicationRegistration!(); assert.ok(original); assert.equal(original.isCurrent(), true);
  state.setRegistered(true, target, metadata); assert.equal(original.isCurrent(), false);
  assert.equal(state.captureArtifactRegistration!(), undefined, "A local legacy lifetime is not a remote publication or Artifact certificate");
  state.setRegistered(false); state.setRegistered(false);
  assert.equal(availability, 2, "Model availability notifications keep their original boolean-change semantics");
  assert.deepEqual(snapshots, [{ registered: true, generation: "same" }, { registered: true, generation: "same" },
    { registered: false, generation: undefined }, { registered: false, generation: undefined }]);
});

test("Artifact follower ACK lifetime cannot be refreshed by equal generation or metadata restoration", () => {
  const state = createTelegramBusFollowerRegistrationState(), target = { chatId: 7, threadId: 8 }, metadata = { generation: "same", registrationIncarnation: "a".repeat(48) };
  assert.equal(state.captureArtifactRegistration!(), undefined);
  state.setRegistered(true, target, metadata);
  const captured = state.captureArtifactRegistration!()!; assert.equal(captured.isCurrent(), true);
  state.setRegistered(true, target, metadata); assert.equal(captured.isCurrent(), false);
  const fresh = state.captureArtifactRegistration!()!; assert.equal(fresh.isCurrent(), true);
  state.setRegistered(false); state.setRegistered(true, target, metadata); assert.equal(fresh.isCurrent(), false);
  state.setRegistered(true, target, { generation: "same" }); assert.equal(state.captureArtifactRegistration!(), undefined, "Rebind/rename without a genuine incarnation ACK leaves Artifact unavailable");
});

for (const fault of ["current", "target-copy", "scope-copy", "no-owner", "no-snapshot", "capability", "invalid-target", "wrong-session", "group", "late-context", "late-operator", "late-epoch", "late-generation", "late-slot", "late-target", "context-port", "reader-port", "snapshot-port", "registration-port", "local-target", "canonical-owner", "canonical-binding", "wrong-source", "wrong-recipient", "readback-loss", "post-snapshot", "post-getter-target"] as const) {
  test(`Live status recipient capture is pre-binding availability and fresh independent canonical authority (${fault})`, async () => {
    await fixture(async f => {
      f.request.source.updateIds = [100];
      const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "capture", capabilities: ["live-thread-rebind-save-v1", "live-thread-rebind-apply-v1", "live-thread-rebind-settle-v1", "live-thread-rebind-command-set-v1", "selected-menu-delivery-v1"] });
      if (fault === "capability") protocol.capabilities = protocol.capabilities.filter(value => value !== "selected-menu-delivery-v1");
      const ctx = { cwd: "/repo" }, registration = createTelegramBusFollowerRegistrationState();
      registration.setRegistered(true, f.request.binding.target, { slot: "A", generation: "registration", leaderProtocol: protocol });
      let current = true, operator = 7, epoch = "epoch", generation = 1, readerLost = false, snapshots = 0, getterDrift = false, getterReads = 0;
      const authority = () => {
        if (getterDrift && ++getterReads === 2) registration.setRegistered(true, { chatId: 7, threadId: 99 }, { slot: "A", generation: "registration", leaderProtocol: protocol });
        return current ? { executor: { instanceId: "leader", leaderEpoch: epoch }, profileBindingKey: "workspace-scope-not-recipient-profile", operatorUserId: operator,
          cwd: "/repo", sessionId: "session", generation, leaderProtocol: protocol } : undefined;
      };
      const read = (operationId: string, profile: string) => { assert.equal(operationId, f.request.operationId); assert.equal(profile, "workspace-scope-not-recipient-profile");
        return readerLost ? undefined : f.store.listLiveRebindings()[0]; };
      const store = { ...f.threads, withWorkspaceLiveRebindSnapshot(...args: Parameters<typeof f.threads.withWorkspaceLiveRebindSnapshot>) {
        snapshots++; const result = f.threads.withWorkspaceLiveRebindSnapshot(...args); if (fault === "post-snapshot") current = false; return result;
      } };
      const deps = { instanceId: "old", getContextAuthority: authority, readRestoreIntent() { assert.fail("Cannot inspect historical Restore"); },
        readLiveRebindIntent: read, topicTargetStore: store, registrationState: registration,
        getWorkspaceAdmission() { assert.fail("Read-only capture must not acquire mutation admission"); } };
      if (fault === "no-owner") current = false;
      if (fault === "no-snapshot") Reflect.deleteProperty(store, "withWorkspaceLiveRebindSnapshot");
      const target = { ...f.request.target }, input = { operationId: f.request.operationId, sessionId: fault === "wrong-session" ? "foreign" : "session",
        registrationGeneration: "registration", target, sourceUpdateIds: fault === "group" ? [100, 101] : [100] };
      if (fault === "invalid-target") target.threadId = 0;
      const handler = createTelegramBusFollowerWorkspaceRestoreHandler(deps), before = readFileSync(f.path, "utf8");
      const captured = handler.prepareLiveCommandRecipient(input, ctx);
      const refused = ["no-owner", "no-snapshot", "capability", "invalid-target", "wrong-session", "group"].includes(fault);
      if (refused) { assert.equal(captured, undefined); assert.equal(readFileSync(f.path, "utf8"), before); assert.equal(snapshots, 0); return; }
      assert.ok(captured); assert.equal(captured.isCurrent(), true); assert.throws(captured.assertRecipientCurrent, /released intent/);
      assert.equal(readFileSync(f.path, "utf8"), before); assert.equal(snapshots, 0);
      if (fault === "target-copy") target.threadId = 99;
      if (fault === "scope-copy") { input.sourceUpdateIds[0] = 999; input.sessionId = "replacement"; }
      const intent = (await f.store.commitLiveRebind(f.request, recipient("follower"), f.auth))!;
      assert.throws(captured.assertRecipientCurrent, /released intent/);
      f.store.advanceLiveRebind(intent, "release", f.auth);
      assert.throws(captured.assertRecipientCurrent, /canonical\/local/);
      registration.setRegistered(true, f.request.target, { slot: "A", generation: "registration", leaderProtocol: protocol });
      const released = readFileSync(f.path, "utf8");
      if (fault === "post-getter-target") { getterDrift = true; assert.equal(captured.isCurrent(), false); }
      if (fault === "late-context") current = false;
      if (fault === "late-operator") operator = 8;
      if (fault === "late-epoch") epoch = "replaced";
      if (fault === "late-generation") generation++;
      if (fault === "late-slot") registration.setRegistered(true, f.request.target, { slot: "B", generation: "registration", leaderProtocol: protocol });
      if (fault === "late-target") registration.setRegistered(true, { chatId: 7, threadId: 99 }, { slot: "A", generation: "registration", leaderProtocol: protocol });
      if (fault === "local-target") registration.setRegistered(true, f.request.binding.target, { slot: "A", generation: "registration", leaderProtocol: protocol });
      if (fault === "context-port") deps.getContextAuthority = () => authority();
      if (fault === "reader-port") deps.readLiveRebindIntent = (id, scope) => read(id, scope);
      if (fault === "snapshot-port") store.withWorkspaceLiveRebindSnapshot = (...args) => f.threads.withWorkspaceLiveRebindSnapshot(...args);
      if (fault === "registration-port") { const get = registration.getTarget; registration.getTarget = () => get(); }
      if (fault === "readback-loss") readerLost = true;
      if (fault === "canonical-owner" || fault === "canonical-binding" || fault === "wrong-source" || fault === "wrong-recipient") {
        const raw = JSON.parse(readFileSync(f.path, "utf8"));
        if (fault === "canonical-owner") raw.threads[0].instanceId = "foreign";
        if (fault === "canonical-binding") raw.workspaceBindings[0].sessionId = "foreign";
        if (fault === "wrong-source") raw.workspaceRestore.liveRebindings[0].request.source.updateIds = [101];
        if (fault === "wrong-recipient") raw.workspaceRestore.liveRebindings[0].recipient.generation = "foreign";
        writeFileSync(f.path, JSON.stringify(raw));
      }
      const success = ["current", "target-copy", "scope-copy"].includes(fault);
      if (success) captured.assertRecipientCurrent(); else assert.throws(captured.assertRecipientCurrent);
      if (!fault.startsWith("canonical-") && fault !== "wrong-source" && fault !== "wrong-recipient") assert.equal(readFileSync(f.path, "utf8"), released);
      if (fault === "wrong-source" || fault === "wrong-recipient") assert.throws(() => f.store.list(), /changed without revision/);
      else assert.deepEqual(f.store.list(), []);
      assert.deepEqual(f.threads.listPendingCleanups(), []);
    }, "follower");
  });
}

import {
  createTelegramBusFollowerApiCaller,
  createTelegramBusFollowerSelectedMenuCaller,
  createTelegramBusFollowerClientRuntime,
  createTelegramBusFollowerControlState,
  createTelegramBusFollowerDurableAdmissionRuntime,
  createTelegramBusFollowerLiveRebindRuntime,
  createTelegramBusFollowerHeartbeatRecoveryHandler,
  createTelegramBusFollowerRecoveryState,
  transitionTelegramBusFollowerRecovery,
  type TelegramBusFollowerRecoveryEvent,
  createTelegramBusFollowerRegistrationRuntime as createRawTelegramBusFollowerRegistrationRuntime,
  createTelegramBusFollowerPromotionHandler,
  createTelegramBusFollowerQueueHandoffClient,
  createTelegramBusFollowerRegistrationState,
  createTelegramBusFollowerRestoreContextGetter,
  createTelegramBusFollowerWorkspaceRestoreHandler,
  createTelegramBusFollowerRuntimeAssembly,
  createTelegramBusFollowerSessionRefreshHook,
  createTelegramBusFollowerSessionReplacementSuspender,
  createTelegramBusForwardedUpdateReceiverRuntime,
  createTelegramManualFollowerProfileKeyResolver,
  getTelegramFollowerSessionHandoff,
  prepareTelegramBusFollowerJournaledUpdateForExecution,
  setTelegramFollowerSessionHandoff,
  TELEGRAM_BUS_FOLLOWER_HEARTBEAT_TIMEOUT_MS,
} from "../lib/bus-follower.ts";
import {
  createTelegramBusFollowerDeliveryIdentity,
  type TelegramBusEnvelope,
  TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY,
  TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION,
  TELEGRAM_BUS_CAPABILITY_GUARDED_API_AUTHORITY,
  TELEGRAM_BUS_CAPABILITY_API_REGISTRATION_AUTHORITY,
  TELEGRAM_BUS_ATTACHMENT_PUBLICATION_RECEIPT,
  parseTelegramBusAttachmentPublicationReceipt,
  TelegramBusLocalAuthorityError,
  createTelegramBusFollowerRegistry,
  createTelegramBusProtocolIdentity,
  createTelegramBusWorkspaceRestoreController,
  createTelegramBusLiveRebindController,
  parseTelegramBusEnvelope,
  TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SAVE,
  TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY,
  TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SETTLE,
  getTelegramBusFollowerSocketPath,
  TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE,
  type TelegramBusFollowerView,
  createTelegramBusLocalServer as createRawTelegramBusLocalServer,
  resolveTelegramBusSocketPath,
  sendTelegramBusLocalEnvelope,
  TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
  TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF,
  TELEGRAM_BUS_CAPABILITY_QUEUE_STEER,
  TELEGRAM_BUS_CAPABILITY_CONNECT_RECOVERY,
  TELEGRAM_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT,
  TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME,
  TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE,
} from "../lib/bus.ts";
import { getTelegramBusTransportKind } from "../lib/bus-transport.ts";
import { createTelegramLiveTargetWorkObserver } from "../lib/bindings.ts";
import { createTelegramQueueStore, createTelegramActiveTurnStore, type PendingTelegramTurn } from "../lib/queue.ts";
import { createTelegramBridgeRuntime } from "../lib/runtime.ts";
import { createTelegramActivityBridgeRuntime, createTelegramActivityPublicationRuntime } from "../lib/activity.ts";
import { createTelegramDeliveryRuntime } from "../lib/delivery.ts";
import { createTelegramApiTargetActivityRuntime, TelegramApiFollowerNotAllowedError } from "../lib/telegram-api.ts";
import { TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS, createTelegramLockRuntime, withTelegramFileTransaction } from "../lib/locks.ts";
import { createTelegramUpdateJournalBotIdentity, createTelegramUpdateJournalStore,
  createTelegramUpdateJournalBindingRuntime, getTelegramUpdateJournalBindingPath } from "../lib/journal.ts";
import { resolveTelegramSessionJournalPath, resolveTelegramFollowerJournalPath } from "../lib/paths.ts";
import {
  createTelegramBusFollowerTargetProvisioner,
  createTelegramBusSelectedMenuDeliveryHandler,
  createTelegramBusLeaderEnvelopeHandler as createRawTelegramBusLeaderEnvelopeHandler,
} from "../lib/bus-leader.ts";
import {
  createTelegramTopicTargetStore,
  createTelegramConsolidatedWorkspaceStorage,
  createTelegramWorkspaceBindingIdentity,
  getTelegramLeaderSessionHandoff,
  setTelegramLeaderSessionHandoff,
} from "../lib/threads.ts";
import {
  getTelegramApiErrorRequestTarget,
  isTelegramApiCommitUnknownError,
  TelegramApiAuthorityError,
  createTelegramApiClient,
  createTelegramBridgeApiRuntime,
} from "../lib/telegram-api.ts";
import { createTelegramWorkspaceAdmissionLedger } from "../lib/workspace-admission.ts";
import { createTelegramWorkspaceOperationRuntime } from "../lib/workspace-retirement.ts";

import { createTelegramUpdateWorkerRuntime, createTelegramUpdateAdmissionLifecycleRuntime } from "../lib/updates.ts";
import { createTelegramUpdateJournalBindingKey } from "../lib/journal.ts";
import { createTelegramFailureRunLog } from "../lib/logging.ts";
import { waitForCondition } from "./fixtures/shared.ts";

for (const mode of ["direct", "retained-generic", "receiver-disabled", "receiver-enabled", "receiver-missing-cap", "apply-generic", "release-generic"] as const) {
  test(`Selected status recipient cannot borrow generic save without native consumption (${mode})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-status-input-refusal-")), path = join(dir, "journal.json"), ctx = { name: "session" };
    const botIdentity = createTelegramUpdateJournalBotIdentity({ botToken: "fixture" }), journal = createTelegramUpdateJournalStore({ path, botIdentity });
    const key = createTelegramUpdateJournalBindingKey({ path, botIdentity });
    let appends = 0, handles = 0, executes = 0, worker!: ReturnType<typeof createTelegramUpdateWorkerRuntime<typeof ctx>>;
    const lifecycle = createTelegramUpdateAdmissionLifecycleRuntime<typeof ctx>({ resolveBinding: () => ({ runtimeKey: "live", recoveryKey: key,
      journal: { ...journal, appendBatch(updates) { appends++; return journal.appendBatch(updates); } } }),
      createWorker(source) { return worker = createTelegramUpdateWorkerRuntime({ journal: source, getJournalBindingKey: () => key,
        hasAuthority: () => true, isContextCurrent: value => value === ctx, async executeUpdate() { executes++; return { kind: "complete" }; } }); } });
    let targetCalls = 0;
    const peer = createTelegramBusFollowerLiveRebindRuntime({ getAdmission: () => lifecycle, async applyTarget() { targetCalls++; throw new Error("Native target must not be touched"); } });
    const caps = ["live-thread-rebind-save-v1", "live-thread-rebind-apply-v1", "live-thread-rebind-settle-v1", "selected-menu-delivery-v1", "live-thread-rebind-command-set-v1"];
    const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: mode === "receiver-missing-cap" ? caps.slice(0, -1) : caps });
    const socketPath = getTelegramBusFollowerSocketPath(dir, "status-refusal");
    const receiver = createTelegramBusForwardedUpdateReceiverRuntime({ socketPath, instanceId: "recipient", getAuthSecret: () => "secret",
      getContext: () => ctx, getRegistrationGeneration: () => "registration", getSessionId: () => "session", getRecipientBindingKey: () => "unused",
      getLiveRebindJournalBindingKey: () => key, getLeaderProtocol: () => protocol, getLocalProtocol: () => protocol, isLiveRebindSaveEnabled: () => true,
      isLiveRebindCommandSetEnabled: () => mode === "receiver-enabled" || mode === "receiver-missing-cap",
      handleLiveRebindSave(envelope, context, current) { handles++; return peer.save(envelope, context, current); },
      durableAdmission: { async admit() { assert.fail("Selected status cannot enter ordinary admission"); } } });
    const envelope = { kind: "leader.prepareLiveRebind" as const, requestId: "status", auth: "secret", operationId: "status", recipientInstanceId: "recipient",
      recipientSessionId: "session", recipientRegistrationGeneration: "registration", recipientBindingKey: key, updates: [{ update_id: 100, message: { text: "/status" } }],
      selectedCommand: { name: "status" as const, target: { chatId: 7, threadId: 42 } }, sentAtMs: 1000 };
    try {
      await lifecycle.onSessionStart(ctx); await worker.waitForDrain();
      if (["retained-generic", "apply-generic", "release-generic"].includes(mode)) peer.save({ ...envelope, selectedCommand: undefined, operationId: "generic", updates: [{ update_id: 101 }] }, ctx, () => true);
      const bytes = () => existsSync(path) ? readFileSync(path, "utf8") : undefined;
      const before = bytes(), held = worker.getState().preparedInputCount, beforeAppends = appends;
      if (mode === "direct" || mode === "retained-generic") assert.throws(() => peer.save(envelope, ctx, () => true), /command.*consumption|consumption.*command/i);
      else if (mode === "apply-generic" || mode === "release-generic") {
        const fields = { requestId: "status", auth: "secret", operationId: "generic", recipientInstanceId: "recipient", recipientSessionId: "session",
          recipientRegistrationGeneration: "registration", recipientBindingKey: key, sourceUpdateIds: [101], selectedCommand: envelope.selectedCommand, sentAtMs: 1000 };
        await assert.rejects(mode === "apply-generic" ? peer.apply({ ...fields, kind: "leader.applyLiveRebind", mode: "apply" }, ctx, () => true)
          : peer.settle({ ...fields, kind: "leader.settleLiveRebind", mode: "release" }, ctx, () => true), /command.*consumption|consumption.*command/i);
      } else { await receiver.start(); const result = await sendTelegramBusLocalEnvelope({ socketPath, retry: { attempts: 1, delayMs: 0 }, envelope });
        assert.equal(result?.kind, "bus.ack"); assert.equal(result && Reflect.get(result, "ok"), false); }
      assert.equal(handles, mode === "receiver-enabled" ? 1 : 0); assert.equal(appends, beforeAppends); assert.equal(executes, 0); assert.equal(targetCalls, 0);
      assert.equal(worker.getState().preparedInputCount, held); assert.equal(bytes(), before);
      if (mode === "retained-generic") assert.equal(peer.save({ ...envelope, selectedCommand: undefined, operationId: "generic", updates: [{ update_id: 101 }] }, ctx, () => true).status, "saved");
    } finally { await receiver.stop(); await lifecycle.onSessionShutdown(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const effect of ["send-text", "edit-text"] as const) {
for (const fault of ["current", "immutable", "entry", "callback-replacement", "registration", "session", "generation", "profile", "cwd", "journal", "process", "birth", "operator", "epoch", "secret", "endpoint", "slot", "target", "local-capability", "leader-capability", "port-replacement",
  "local-after-ipc", "wrong-request", "wrong-operation", "wrong-recipient", "wrong-effect", "wrong-message", "extra-result", "negative", "lost-response"] as const) {
  test(`Selected menu sender ${effect} captures independent local authority through registration/native IPC (${fault})`, async () => {
    await fixture(async f => {
      f.request.source.updateIds = [100];
      const committed = (await f.store.commitLiveRebind(f.request, recipient("follower"), f.auth))!;
      f.store.advanceLiveRebind(committed, "release", f.auth);
      const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: [TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY] });
      const registry = createTelegramBusFollowerRegistry();
      registry.register({ instanceId: "old", registrationGeneration: "registration", sessionId: "session", sessionGeneration: 1, pid: process.pid, processBirthId: "birth",
        profileKey: f.request.owner.profileKey, cwd: "/repo", slot: "A", target: f.request.target, protocol, connectedAtMs: 1 });
      const state = createTelegramBusFollowerRegistrationState();
      state.setRegistered(true, f.request.target, { slot: "A", generation: "registration", leaderProtocol: protocol });
      const ctx = { cwd: "/repo" }, lock = { pid: 123, instanceId: "leader", leaderEpoch: "epoch", busSecret: "secret" };
      let active = fault !== "entry", session = "session", generation = 1, profile = f.request.owner.profileKey, journal = "recipient-journal", processId = process.pid, birth = "birth", operator = 7, secret = "secret";
      let pendingRegistration = true, registered = "registration", wires = 0, requests = 0, ids = 0;
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), wait = Promise.withResolvers<string>();
      const records: unknown[] = [], received: TelegramBusEnvelope[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => { requests++; entered.resolve(); await release.promise; return new Response(JSON.stringify({ ok: true, result: { message_id: 11 } })); };
      const ledger = createTelegramWorkspaceAdmissionLedger({ path: `${f.path}.menu-admission`, profileKey: "bot:menu",
        owner: { processId: process.pid, processBirthId: `${process.pid}:menu` }, getProcessLiveness: () => "alive" });
      const operations = createTelegramWorkspaceOperationRuntime({ getWorkspaceAdmission: () => ledger });
      const api = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:fixture"), tempDir: dirname(f.path), maxFileSizeBytes: 1024, tempFileMaxAgeMs: 1000, recordRuntimeEvent() {} });
      const leaderDelivery = createTelegramBusSelectedMenuDeliveryHandler({ followerRegistry: registry, protocolIdentity: protocol,
        workspace: { getScopeKey: () => "bot:menu", captureAuthority: () => f.auth, getStore: () => f.store, threadStore: f.threads,
          getJournalBindingKey: () => "recipient-journal", run: operations.run },
        api: { runtime: api, authorize: () => true, record(value, assertCurrent) { assertCurrent(); records.push(value); return true; } } });
      const handle = createRawTelegramBusLeaderEnvelopeHandler({ followerRegistry: registry, authSecret: "secret", protocolIdentity: protocol, selectedMenuDelivery: leaderDelivery,
        callApi() { assert.fail("No ordinary API downgrade"); } });
      let endpoint = join(dirname(f.path), "menu.sock");
      const server = createRawTelegramBusLocalServer({ socketPath: endpoint, handleEnvelope: async envelope => {
        wires++; received.push(structuredClone(envelope));
        const response = await handle(envelope);
        if (response.kind === "bus.ack") {
          if (fault === "wrong-request") response.requestId = "other";
          if (fault === "negative") { response.ok = false; response.result = undefined; }
          if (fault === "lost-response") return undefined;
          const result = response.result as Record<string, any> | undefined;
          if (result) {
            if (fault === "wrong-operation") result.operationId = "other";
            if (fault === "wrong-recipient") result.recipient.sessionId = "other";
            if (fault === "wrong-effect") result.effect = "other";
            if (fault === "wrong-message") result.messageId = effect === "send-text" ? -1 : 12;
            if (fault === "extra-result") result.foreign = true;
          }
        }
        return response;
      } });
      const getAuthority = createTelegramBusFollowerRestoreContextGetter<typeof ctx>({ isContextCurrent: value => active && value === ctx,
        getSessionId: () => session, getCwd: value => value.cwd, getGeneration: () => generation, getProfileBindingKey: () => profile,
        getOperatorUserId: () => operator, getLeaderState: () => ({ kind: "active-elsewhere", lock }), getAuthenticatedSecret: () => secret,
        getLeaderProtocol: state.getLeaderProtocol, capability: TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY });
      const ports = { protocolIdentity: protocol, client: { instanceId: "old", socketPath: () => endpoint, createRequestId: () => `menu:${++ids}`,
        getAuthSecret: () => secret, getRegistrationGeneration: () => pendingRegistration ? undefined : registered,
        waitForRegistrationGeneration: async () => { const value = await wait.promise; pendingRegistration = false; return value; }, timeoutMs: 1500 },
        recipient: { getContextAuthority: getAuthority, getJournalBindingKey: () => journal,
          getProcessIdentity: () => ({ processId, processBirthId: birth }), registrationState: state } };
      const caller = createTelegramBusFollowerSelectedMenuCaller(ports);
      const input = { ctx, operationId: "restore", registrationGeneration: "registration",
        effect: effect === "send-text" ? { kind: effect, text: "Status", replyMarkup: { inline_keyboard: [[{ text: "Queue", callback_data: "queue" }]] } } : { kind: effect, text: "Status", messageId: 11 },
        assertAuthority() { if (!active) throw new Error("Recipient revoked"); } };
      const initial = readFileSync(f.path, "utf8");
      await server.start();
      try {
        const outcome = caller(input).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
        if (fault === "immutable") { input.ctx = { cwd: "/other" }; input.operationId = "other"; input.registrationGeneration = "other";
          input.effect.text = "changed"; if (input.effect.replyMarkup) input.effect.replyMarkup.inline_keyboard[0]![0]!.text = "changed"; }
        if (fault === "callback-replacement") { active = false; input.assertAuthority = () => {}; }
        if (fault === "registration") registered = "other";
        if (fault === "session") session = "other";
        if (fault === "generation") generation++;
        if (fault === "profile") profile = "other";
        if (fault === "cwd") ctx.cwd = "/other";
        if (fault === "journal") journal = "other";
        if (fault === "process") processId++;
        if (fault === "birth") birth = "other";
        if (fault === "operator") operator = 8;
        if (fault === "epoch") lock.leaderEpoch = "other";
        if (fault === "secret") secret = "other";
        if (fault === "endpoint") endpoint += ".other";
        if (fault === "slot") state.setRegistered(true, f.request.target, { slot: "B", generation: "registration", leaderProtocol: protocol });
        if (fault === "target") state.setRegistered(true, { chatId: 7, threadId: 99 }, { slot: "A", generation: "registration", leaderProtocol: protocol });
        if (fault === "local-capability") protocol.capabilities = [];
        if (fault === "leader-capability") state.setRegistered(true, f.request.target, { slot: "A", generation: "registration", leaderProtocol: createTelegramBusProtocolIdentity({ runtimeBuild: "old", capabilities: [] }) });
        if (fault === "port-replacement") ports.recipient.getJournalBindingKey = () => "recipient-journal";
        const early = ["entry", "callback-replacement", "registration", "session", "generation", "profile", "cwd", "journal", "process", "birth", "operator", "epoch", "secret", "endpoint", "slot", "target", "local-capability", "leader-capability", "port-replacement"].includes(fault);
        wait.resolve(registered);
        if (!early) {
          await Promise.race([entered.promise, outcome.then(result => { assert.fail(String(result.error)); })]);
          if (fault === "local-after-ipc") active = false;
        }
        release.resolve();
        const result = await outcome;
        const accepted = ["current", "immutable"].includes(fault);
        assert.equal(result.error === undefined, accepted);
        if (early) assert.ok(result.error instanceof TelegramApiAuthorityError && !result.error.requestIssued);
        if (!early && !accepted) assert.ok(isTelegramApiCommitUnknownError(result.error));
        assert.equal(wires, early ? 0 : 1); assert.equal(requests, early ? 0 : 1); assert.equal(records.length, !early && effect === "send-text" ? 1 : 0);
        if (wires) { const sent = received[0]!; assert.equal(sent.kind, "follower.deliverSelectedMenu"); if (sent.kind === "follower.deliverSelectedMenu") {
          assert.equal(sent.effect.text, "Status"); assert.equal(sent.recipient.journalBindingKey, "recipient-journal"); assert.deepEqual(sent.recipient.target, f.request.target);
          if (sent.effect.replyMarkup) assert.equal(sent.effect.replyMarkup.inline_keyboard[0]![0]!.text, "Queue");
        } }
        if (accepted) { assert.equal(result.value?.messageId, 11); result.value!.recipient.target.threadId = 99; assert.deepEqual(state.getTarget(), f.request.target); }
        assert.equal(readFileSync(f.path, "utf8"), initial); assert.deepEqual(ledger.read().leases, []); assert.deepEqual(f.threads.listPendingCleanups(), []);
      } finally { wait.resolve("registration"); release.resolve(); await server.stop(); globalThis.fetch = originalFetch; }
    }, "follower");
  });
}
}

for (const boundary of ["entry", "connect", "response"] as const) {
  test(`Local IPC authority stays process-local and fences actual wire (${boundary})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "menu-ipc-guard-")), socketPath = join(dir, "bus.sock");
    let checks = 0, messages = 0;
    const server = createRawTelegramBusLocalServer({ socketPath, handleEnvelope: envelope => { messages++; return { kind: "bus.ack", requestId: envelope.requestId, ok: true }; } });
    await server.start();
    try {
      await assert.rejects(sendTelegramBusLocalEnvelope({ socketPath, retry: { attempts: 3, delayMs: 0 },
        envelope: { kind: "follower.heartbeat", requestId: "guard", instanceId: "peer", sentAtMs: 1 }, assertAuthority() {
          checks++; if (checks === (boundary === "entry" ? 1 : boundary === "connect" ? 2 : 4)) throw new Error("local revoked");
        } }), error => error instanceof TelegramBusLocalAuthorityError && error.requestIssued === (boundary === "response"));
      assert.equal(messages, boundary === "response" ? 1 : 0); assert.equal(checks, boundary === "entry" ? 1 : boundary === "connect" ? 2 : 4);
    } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("Local IPC retains its original guard when caller replaces options before connect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "menu-ipc-capture-")), socketPath = join(dir, "bus.sock");
  let current = true, messages = 0;
  const server = createRawTelegramBusLocalServer({ socketPath, handleEnvelope: envelope => {
    messages++; return { kind: "bus.ack", requestId: envelope.requestId, ok: true };
  } });
  await server.start();
  try {
    const options = { socketPath, envelope: { kind: "follower.heartbeat" as const, requestId: "capture", instanceId: "peer", sentAtMs: 1 },
      assertAuthority() { if (!current) throw new Error("Original local guard revoked"); } };
    const task = sendTelegramBusLocalEnvelope(options);
    current = false; options.assertAuthority = () => {};
    await assert.rejects(task, error => error instanceof TelegramBusLocalAuthorityError && !error.requestIssued);
    assert.equal(messages, 0);
  } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("Live-rebind save wire rejects malformed groups without changing legacy Restore", () => {
  const envelope = { kind: "leader.prepareLiveRebind", requestId: "save", auth: "secret", recipientInstanceId: "recipient",
    recipientRegistrationGeneration: "generation", recipientSessionId: "session", recipientBindingKey: "binding",
    operationId: "operation", updates: [{ update_id: 2 }, { update_id: 3 }], sentAtMs: 1 };
  assert.equal(parseTelegramBusEnvelope(JSON.stringify(envelope))?.kind, "leader.prepareLiveRebind");
  for (const patch of [{ updates: [] }, { updates: [{ update_id: 2 }, { update_id: 2 }] },
    { updates: [{ update_id: -1 }] }, { updates: [{ update_id: 1.5 }] }, { updates: [null] },
    { recipientSessionId: "" }, { recipientBindingKey: "" }, { recipientRegistrationGeneration: "" }, { operationId: "x".repeat(129) }]) {
    assert.equal(parseTelegramBusEnvelope(JSON.stringify({ ...envelope, ...patch })), undefined);
  }
});

for (const mode of ["normal", "busy-worker", "legacy", "version", "disabled", "auth", "session", "binding", "generation",
  "context-after-save", "protocol-after-save", "registry-protocol-after-save", "sender-after-save", "append-failure", "append-lost-reply", "lost-ack", "mismatched-ack",
  "profile-key", "journal-missing", "journal-after-save"] as const) {
  test(`Live-rebind save holds a group through authenticated native IPC (${mode})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "live-save-"));
    const socketPath = getTelegramBusFollowerSocketPath("recipient", dir);
    const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "test", capabilities: [
      TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION, TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SAVE] });
    let ctx = { name: "live" }, generation = "generation", sessionId = "session";
    let journalCurrent = true;
    const sourcePath = join(dir, "journal.json"), identity = createTelegramUpdateJournalBotIdentity({ botToken: "test-live-save" });
    const key = createTelegramUpdateJournalBindingKey({ path: sourcePath, profileName: "work", botIdentity: identity });
    const journal = createTelegramUpdateJournalStore({ path: sourcePath, profileName: "work", botIdentity: identity });
    let worker!: ReturnType<typeof createTelegramUpdateWorkerRuntime<typeof ctx>>;
    let appends = 0, saves = 0, dropped = 0, senderCurrent = true;
    const executed: number[] = [];
    const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
    const lifecycle = createTelegramUpdateAdmissionLifecycleRuntime<typeof ctx>({
      resolveBinding: () => ({ runtimeKey: "live", recoveryKey: key, journal: { ...journal, appendBatch(updates) {
        appends++;
        if (mode === "append-failure") throw new Error("Save refused before publication");
        const result = journal.appendBatch(updates);
        if (mode === "append-lost-reply") throw new Error("Save reply lost after publication");
        return result;
      } } }),
      createWorker(source) { return worker = createTelegramUpdateWorkerRuntime({ journal: source, getJournalBindingKey: () => key,
        hasAuthority: () => true, isContextCurrent: current => current === ctx,
        async executeUpdate(update) { executed.push(update.update_id);
          if (mode === "busy-worker" && update.update_id === 1) { entered.resolve(); await finish.promise; }
          return { kind: "complete" }; } }); },
    });
    const { save } = createTelegramBusFollowerLiveRebindRuntime({ getAdmission: () => lifecycle });
    const handle = (envelope: Extract<TelegramBusEnvelope, { kind: "leader.prepareLiveRebind" }>, context: typeof ctx, current: () => boolean) => {
      saves++; const result = save(envelope, context, current);
      if (mode === "context-after-save") ctx = { name: "replacement" };
      if (mode === "protocol-after-save") protocol.protocolVersion++;
      if (mode === "sender-after-save") senderCurrent = false;
      if (mode === "journal-after-save") journalCurrent = false;
      if (mode === "registry-protocol-after-save") remote.protocol = { ...protocol, runtimeBuild: "replacement" };
      return result;
    };
    const receiver = mode === "lost-ack" || mode === "mismatched-ack" ? createRawTelegramBusLocalServer({ socketPath,
      async handleEnvelope(envelope) {
        assert.equal(envelope.auth, "secret");
        assert.equal(envelope.kind, "leader.prepareLiveRebind");
        if (envelope.kind !== "leader.prepareLiveRebind") assert.fail("Unexpected envelope");
        const result = handle(envelope, ctx, () => true);
        return { kind: "bus.ack", requestId: envelope.requestId, ok: true,
          result: mode === "mismatched-ack" ? { ...result, sourceUpdateIds: [900] } : result };
      }, shouldDropResponse() { if (mode !== "lost-ack" || dropped) return false; dropped++; return true; },
    }) : createTelegramBusForwardedUpdateReceiverRuntime({ socketPath, instanceId: "recipient",
      getAuthSecret: () => "secret", getRegistrationGeneration: () => generation, getRecipientBindingKey: () => "manual:recipient",
      getLiveRebindJournalBindingKey: () => mode === "journal-missing" || !journalCurrent ? undefined : key,
      getContext: () => ctx, getSessionId: () => sessionId, getLeaderProtocol: () => protocol, getLocalProtocol: () => protocol,
      isLiveRebindSaveEnabled: () => mode !== "disabled", handleLiveRebindSave: handle,
      durableAdmission: { async admit() { assert.fail("Live save cannot use ordinary forwarding admission"); } },
    });
    const follower: TelegramBusFollowerView = { instanceId: "recipient", cwd: "/work", pid: process.pid, connectedAtMs: 1,
      lastHeartbeatMs: 1, busSocketPath: socketPath, sessionId: "session", registrationGeneration: "generation", slot: "A", protocol };
    const remote = mode === "legacy" ? { ...follower, protocol: createTelegramBusProtocolIdentity({ runtimeBuild: "old", capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION] }) }
      : mode === "version" ? { ...follower, protocol: { ...protocol, protocolVersion: 999 } } : follower;
    let request = 0;
    const control = createTelegramBusLiveRebindController({ getFollower: () => remote, localProtocolIdentity: protocol,
      getAuthSecret: () => mode === "auth" ? "wrong" : "secret", createRequestId: () => `save-${++request}`, timeoutMs: 1000 });
    const input = { operationId: "operation", instanceId: "recipient", sessionId: "session", recipientBindingKey: key,
      updates: [{ update_id: 2, message: { text: "selected" } }, { update_id: 3, message: { text: "group" } }], isCurrent: () => senderCurrent };
    if (mode === "session") sessionId = "other-session";
    if (mode === "binding") input.recipientBindingKey = "foreign-binding";
    if (mode === "profile-key") input.recipientBindingKey = "manual:recipient";
    if (mode === "generation") generation = "replacement";
    try {
      await lifecycle.onSessionStart(ctx); await worker.waitForDrain(); await receiver.start();
      if (mode === "busy-worker") { journal.appendBatch([{ update_id: 1 }]); lifecycle.signal(); await entered.promise; }
      if (mode === "lost-ack") {
        await assert.rejects(() => control(input), /Timed out|response|closed/);
        assert.equal(appends, 1); assert.deepEqual(executed, []);
        assert.equal((await control(input))?.status, "saved", "Exact retry reobserves the held group without another append");
        assert.equal(appends, 1); assert.equal(dropped, 1);
      } else {
        const result = await control(input);
        const confirmed = mode === "normal" || mode === "busy-worker" || mode === "append-lost-reply";
        assert.equal(result?.status, confirmed ? "saved" : undefined);
      }
      assert.deepEqual(executed, mode === "busy-worker" ? [1] : [], "Save ACK never activates input");
      if (mode === "busy-worker") { journal.appendBatch([{ update_id: 4 }]); lifecycle.signal(); finish.resolve();
        await worker.waitForDrain(); assert.deepEqual(executed, [1, 4]); }
      if (["normal", "busy-worker", "append-lost-reply", "lost-ack", "mismatched-ack", "context-after-save", "protocol-after-save", "registry-protocol-after-save", "sender-after-save", "journal-after-save"].includes(mode)) {
        assert.deepEqual(journal.read().entries.map(entry => entry.updateId), [2, 3]);
        assert.equal(worker.getState().preparedInputCount, 2);
      } else assert.deepEqual(journal.read().entries, []);
      if (mode === "append-failure") {
        assert.equal(await control(input), undefined);
        assert.equal(appends, 1, "An unconfirmed save attempt never repeats its write");
      }
      if (mode === "normal") {
        assert.equal((await control(input))?.status, "saved"); assert.equal(appends, 1);
        assert.equal(await control({ ...input, updates: [{ update_id: 2, message: { text: "changed" } }] }), undefined);
        assert.equal(appends, 1);
        journal.appendBatch([{ update_id: 4 }]); lifecycle.signal(); await worker.waitForDrain();
        assert.deepEqual(executed, [4], "Unrelated work still drains while the selected group is held");
      }
      if (["legacy", "version", "disabled", "auth", "session", "binding", "generation", "profile-key", "journal-missing"].includes(mode)) assert.equal(saves, 0);
    } finally { finish.resolve(); await receiver.stop(); await lifecycle.onSessionShutdown(); rmSync(dir, { recursive: true, force: true }); }
  });
}

const TEST_BUS_PROTOCOL_IDENTITY = createTelegramBusProtocolIdentity({
  runtimeBuild: "test",
  capabilities: [
    TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
    TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF,
    TELEGRAM_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT,
  ],
});

function createTelegramBusFollowerRegistrationRuntime<TContext extends {
  cwd?: string;
}>(
  deps: Omit<
    Parameters<typeof createRawTelegramBusFollowerRegistrationRuntime<TContext>>[0],
    "protocolIdentity"
  > & {
    protocolIdentity?: Parameters<
      typeof createRawTelegramBusFollowerRegistrationRuntime<TContext>
    >[0]["protocolIdentity"];
  },
) {
  const { protocolIdentity = TEST_BUS_PROTOCOL_IDENTITY, ...ports } = deps;
  return createRawTelegramBusFollowerRegistrationRuntime({
    getSessionId: () => "test-session",
    ...ports,
    protocolIdentity,
  });
}

function createTelegramBusLocalServer(
  deps: Parameters<typeof createRawTelegramBusLocalServer>[0],
) {
  const handleEnvelope = deps.handleEnvelope;
  return createRawTelegramBusLocalServer({
    ...deps,
    async handleEnvelope(envelope) {
      const response = await handleEnvelope(envelope);
      if (
        envelope.kind === "follower.register" &&
        response?.kind === "bus.ack" &&
        !response.protocol
      ) {
        return { ...response, protocol: TEST_BUS_PROTOCOL_IDENTITY };
      }
      return response;
    },
  });
}

function createTelegramBusLeaderEnvelopeHandler(
  deps: Omit<
    Parameters<typeof createRawTelegramBusLeaderEnvelopeHandler>[0],
    "protocolIdentity"
  > & {
    protocolIdentity?: Parameters<
      typeof createRawTelegramBusLeaderEnvelopeHandler
    >[0]["protocolIdentity"];
  },
) {
  const { protocolIdentity = TEST_BUS_PROTOCOL_IDENTITY, ...ports } = deps;
  const handle = createRawTelegramBusLeaderEnvelopeHandler({
    ...ports,
    protocolIdentity,
  });
  return (envelope: Parameters<typeof handle>[0]) =>
    handle(
      envelope.kind === "follower.register" &&
        !envelope.registration.protocol
        ? {
            ...envelope,
            registration: {
              ...envelope.registration,
              protocol: protocolIdentity,
            },
          }
        : envelope,
    );
}

test("Follower control state owns active auth and transient lifecycle projection", () => {
  const state = createTelegramBusFollowerControlState();
  assert.equal(state.getActiveAuthSecret(), undefined);
  assert.equal(state.getLifecyclePhase(), undefined);

  state.setActiveAuthSecret("secret");
  state.setLifecyclePhase("electing");
  assert.equal(state.getActiveAuthSecret(), "secret");
  assert.equal(state.getLifecyclePhase(), "electing");

  state.setActiveAuthSecret(undefined);
  state.setLifecyclePhase(undefined);
  assert.equal(state.getActiveAuthSecret(), undefined);
  assert.equal(state.getLifecyclePhase(), undefined);
});

test("Bus follower profile key resolver follows the active profile", () => {
  let profileName: string | undefined;
  const resolveProfileKey = createTelegramManualFollowerProfileKeyResolver({
    getActiveProfileName: () => profileName,
    manualFollowerOwnerId: "7",
  });
  assert.equal(resolveProfileKey(), "manual:7");
  profileName = "work";
  assert.equal(resolveProfileKey(), "profile:work:manual:7");
});

test("Bus follower promotion handler transfers binding only after leadership acquisition", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-promotion-"));
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  const events: unknown[] = [];
  store.upsertWorkspaceBinding({
    ...createTelegramWorkspaceBindingIdentity("/repo", 0, "session-a")!,
    target: { chatId: 42, threadId: 11 }, slot: "E", threadName: "Ember",
    displayTitle: "repo_e", updatedAtMs: 100,
  });
  await store.persist();
  const promote = createTelegramBusFollowerPromotionHandler({
    topicTargetStore: store,
    instanceId: "inst-a",
    getActiveProfileName: () => "work",
    getSessionId: () => "session-a",
    startLeader: async (ctx: { cwd: string }, _election, onAcquired) => {
      events.push(`acquired:${ctx.cwd}`);
      await onAcquired();
      return true;
    },
    recordRuntimeEvent: (category, message, details) => {
      events.push({ category, message, details });
    },
    getPid: () => 10,
    getNowMs: () => 500,
  });
  try {
    await promote(
      { cwd: "/repo" },
      {
        target: { chatId: 42, threadId: 11 },
        slot: "E",
        threadName: "Ember",
      },
      {},
    );
    assert.equal(store.list()[0]?.profileKey, "profile:work:cwd:/repo");
    assert.equal(store.list()[0]?.owner?.kind, "leader");
    assert.equal(store.getWorkspaceBinding("/repo"), undefined);
    assert.equal(store.getWorkspaceBinding("/repo", "a", "session-a")?.threadName, "Ember");
    assert.equal(store.getWorkspaceBinding("/repo", "a", "session-a")?.displayTitle, "repo_e");
    assert.equal(events[0], "acquired:/repo");
    assert.deepEqual(events[1], {
      category: "bus",
      message: "Follower thread binding promoted to leader",
      details: {
        phase: "follower-promoted-binding",
        chatId: 42,
        threadId: 11,
        slot: "E",
        threadName: "Ember",
      },
    });
    assert.deepEqual(events[2], {
      category: "bus",
      message: "Promoted leader binding retained for session replacement",
      details: {
        phase: "follower-promoted-session-handoff",
        chatId: 42,
        threadId: 11,
        slot: "E",
        threadName: "Ember",
      },
    });
    assert.deepEqual(getTelegramLeaderSessionHandoff(), {
      pid: 10,
      instanceId: "inst-a",
      createdAtMs: 500,
      profileKey: "profile:work:cwd:/repo",
      target: { chatId: 42, threadId: 11 },
      slot: "E",
      threadName: "Ember",
    });
  } finally {
    setTelegramLeaderSessionHandoff(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower promotion is rejected before leadership acquisition by a retained fence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-promotion-fence-"));
  const admission = createTelegramWorkspaceAdmissionLedger({
    path: join(dir, "workspace-admission.json"),
    profileKey: "profile:follower-promotion",
    owner: {
      processId: process.pid,
      processBirthId: `${process.pid}:follower-promotion-test`,
    },
    getProcessLiveness: () => "alive",
  });
  const fence = admission.acquireRetirementFence({
    operationId: "follower-promotion-fence",
    retirementIntentId: "follower-promotion-intent",
    bindingKey: "follower-promotion-binding",
    slot: "E",
    target: { chatId: 42, threadId: 11 },
    leaderEpoch: 1,
    retirementRequestedAtMs: 1,
  });
  assert.equal(fence.kind, "acquired");
  let leadershipAttempted = false;
  const promote = createTelegramBusFollowerPromotionHandler({
    topicTargetStore: createTelegramTopicTargetStore({
      path: join(dir, "state.json"),
    }),
    instanceId: "inst-a",
    getActiveProfileName: () => "work",
    getWorkspaceAdmission: () => admission,
    startLeader: async () => {
      leadershipAttempted = true;
      return true;
    },
    recordRuntimeEvent() {},
  });
  try {
    await assert.rejects(
      promote(
        { cwd: "/repo" },
        { target: { chatId: 42, threadId: 11 }, slot: "E" },
        {},
      ),
      /blocked by retirement/u,
    );
    assert.equal(leadershipAttempted, false);
  } finally {
    if (fence.kind === "acquired") {
      admission.releaseUnissuedRetirementFence(fence.fence);
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower promotion rejects slotless authority at global capacity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-promotion-capacity-"));
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  store.upsert({
    profileKey: "manual:inst-a",
    owner: { kind: "manual-follower", instanceId: "inst-a" },
    target: { chatId: 42, threadId: 11 },
    status: "active",
    createdAtMs: 1,
    updatedAtMs: 1,
    instanceId: "inst-a",
  });
  for (const [index, slot] of Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ").entries()) {
    store.upsertWorkspaceBinding({
      ...createTelegramWorkspaceBindingIdentity(`/retained/${index}`)!,
      target: { chatId: 42, threadId: 100 + index },
      slot,
      updatedAtMs: index + 1,
    });
  }
  await store.persist();
  const promote = createTelegramBusFollowerPromotionHandler({
    topicTargetStore: store,
    instanceId: "inst-a",
    getActiveProfileName: () => undefined,
    startLeader: async (_ctx: { cwd: string }, _election, onAcquired) => {
      await onAcquired();
      return true;
    },
    recordRuntimeEvent: () => undefined,
  });
  try {
    await assert.rejects(promote(
      { cwd: "/repo" },
      { target: { chatId: 42, threadId: 11 } },
      {},
    ), /promotion slot authority is unavailable/u);
    const retained = store.getByProfileKey("manual:inst-a");
    assert.equal(retained?.owner?.kind, "manual-follower");
    assert.equal(retained?.slot, undefined);
    assert.equal(store.getByProfileKey("cwd:/repo"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower promotion leaves binding unchanged when election is lost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-election-lost-"));
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  const promote = createTelegramBusFollowerPromotionHandler({
    topicTargetStore: store,
    instanceId: "inst-a",
    getActiveProfileName: () => "work",
    startLeader: async () => false,
    recordRuntimeEvent: () => undefined,
  });
  try {
    assert.equal(
      await promote(
        { cwd: "/repo" },
        {
          target: { chatId: 42, threadId: 11 },
          slot: "E",
          threadName: "Ember",
        },
        { expectedOwner: { pid: 99 } },
      ),
      false,
    );
    assert.deepEqual(store.list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower receiver stages authenticated queue handoff payloads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-queue-handoff-receiver-"));
  const socketPath = join(dir, "follower.sock");
  const staged: unknown[] = [];
  let localProtocol = TEST_BUS_PROTOCOL_IDENTITY, leaderProtocol = TEST_BUS_PROTOCOL_IDENTITY;
  const receiver = createTelegramBusForwardedUpdateReceiverRuntime({
    socketPath,
    getLocalProtocol: () => localProtocol,
    getLeaderProtocol: () => leaderProtocol,
    instanceId: "inst-b",
    getAuthSecret: () => "secret",
    getRegistrationGeneration: () => "generation-b",
    getRecipientBindingKey: () => "manual:owner-b",
    getContext: () => "ctx",
    durableAdmission: {
      admit: async () => assert.fail("queue handoff must not enter update admission"),
    },
    handleQueueHandoff(envelope, ctx) {
      staged.push({ envelope, ctx });
      return {
      status: "staged",
      receiptId: "receipt-1",
      sourceUpdateIds: [1],
      queueOwner: {
        instanceId: "inst-b",
        processId: 20,
        processBirthId: "20:start:inst-b",
        sessionGeneration: 1,
        acquisitionId: "recipient-acquisition",
        acquiredAtMs: 1,
      },
    };
    },
  });
  const payload = {
    kind: "prompt" as const,
    chatId: 7,
    replyToMessageId: 10,
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
  };
  const envelope = {
    kind: "leader.offerQueueHandoff" as const,
    requestId: "handoff:1",
    auth: "secret",
    recipientInstanceId: "inst-b",
    recipientRegistrationGeneration: "generation-b",
    donorInstanceId: "inst-a",
    donorProcessId: 101,
    donorProcessBirthId: "101:start:a",
    donorSessionGeneration: 1,
    donorAcquisitionId: "acquisition-a",
    donorAcquiredAtMs: 1000,
    handoffToken: "x".repeat(32),
    payload,
    sentAtMs: 2000,
  };
  try {
    await receiver.start();
    assert.deepEqual(
      await sendTelegramBusLocalEnvelope({ socketPath, envelope }),
      {
        kind: "bus.ack",
        requestId: "handoff:1",
        ok: true,
        message: undefined,
        result: {
          status: "staged",
          receiptId: "receipt-1",
          sourceUpdateIds: [1],
          queueOwner: {
            instanceId: "inst-b",
            processId: 20,
            processBirthId: "20:start:inst-b",
            sessionGeneration: 1,
            acquisitionId: "recipient-acquisition",
            acquiredAtMs: 1,
          },
        },
      },
    );
    assert.deepEqual(staged, [{ envelope, ctx: "ctx" }]);
    assert.deepEqual(
      await sendTelegramBusLocalEnvelope({
        socketPath,
        envelope: { ...envelope, requestId: "handoff:2", auth: "tamper" },
      }),
      {
        kind: "bus.ack",
        requestId: "handoff:2",
        ok: false,
        message: "Unauthorized Telegram bus envelope.",
      },
    );
    assert.deepEqual(
      await sendTelegramBusLocalEnvelope({
        socketPath,
        envelope: {
          ...envelope,
          requestId: "handoff:3",
          recipientRegistrationGeneration: "stale",
        },
      }),
      {
        kind: "bus.ack",
        requestId: "handoff:3",
        ok: false,
        message: "Stale Telegram bus follower registration generation.",
      },
    );
    assert.equal(staged.length, 1);
    const steerProtocol = createTelegramBusProtocolIdentity({ runtimeBuild: "steer", capabilities: [TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF, TELEGRAM_BUS_CAPABILITY_QUEUE_STEER] });
    for (const missing of ["local", "leader", "none"] as const) {
      localProtocol = missing === "local" ? TEST_BUS_PROTOCOL_IDENTITY : steerProtocol;
      leaderProtocol = missing === "leader" ? TEST_BUS_PROTOCOL_IDENTITY : steerProtocol;
      const response = await sendTelegramBusLocalEnvelope({ socketPath, envelope: { ...envelope,
        requestId: `steer:${missing}`, payload: { ...payload, queueLane: "steer" } } });
      assert.equal(response?.kind === "bus.ack" && response.ok, missing === "none");
      if (missing !== "none") assert.equal(staged.length, 1, "Unsupported peers never reach staging/admission");
    }
    assert.equal(staged.length, 2);
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower receiver handles leader-forwarded updates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-forward-"));
  const leaderSocketPath = join(dir, "leader.sock");
  const followerSocketPath = join(dir, "follower.sock");
  const registry = createTelegramBusFollowerRegistry();
  const received: unknown[] = [];
  let nowMs = 2000;
  const delivery = (
    kind:
      | "leader.forwardCallback"
      | "leader.forwardReaction"
      | "leader.forwardMessage"
      | "leader.forwardEditedMessage",
    sourceUpdateId: number,
  ) =>
    createTelegramBusFollowerDeliveryIdentity({
      kind,
      recipientBindingKey: "manual:owner-b",
      sourceUpdateId,
    });
  const receiver = createTelegramBusForwardedUpdateReceiverRuntime({
    socketPath: followerSocketPath,
    instanceId: "inst-b",
    getRegistrationGeneration: () => "generation-b",
    getRecipientBindingKey: () => "manual:owner-b",
    getContext() {
      return "ctx";
    },
    durableAdmission: {
      async admit(envelope, ctx) {
        if (envelope.kind === "leader.forwardCallback") {
          received.push({ kind: "callback", query: envelope.query, ctx });
        } else if (envelope.kind === "leader.forwardReaction") {
          received.push({
            kind: "reaction",
            reactionUpdate: envelope.reactionUpdate,
            ctx,
          });
        } else if (envelope.kind === "leader.forwardMessage") {
          received.push({ kind: "message", message: envelope.message, ctx });
        } else if (envelope.kind === "leader.forwardEditedMessage") {
          received.push({
            kind: "edited-message",
            message: envelope.message,
            ctx,
          });
        } else {
          assert.fail("custody wake entered legacy durable admission");
        }
        return {
          deliveryId: envelope.delivery!.deliveryId,
          sourceUpdateId: envelope.delivery!.sourceUpdateId,
        };
      },
    },
  });
  const leader = createTelegramBusLocalServer({
    socketPath: leaderSocketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      getNowMs: () => nowMs,
    }),
  });
  try {
    await receiver.start();
    await leader.start();
    registry.register({
      instanceId: "inst-b",
      busSocketPath: followerSocketPath,
      registrationGeneration: "generation-b",
      connectedAtMs: 1000,
    });
    const callbackResponse = await sendTelegramBusLocalEnvelope({
      socketPath: leaderSocketPath,
      envelope: {
        kind: "leader.forwardCallback",
        requestId: "leader:1",
        recipientInstanceId: "inst-b",
        recipientRegistrationGeneration: "generation-b",
        delivery: delivery("leader.forwardCallback", 1),
        query: { id: "cb-1", data: "queue:pause" },
        sentAtMs: 2000,
      },
    });
    assert.equal(registry.get("inst-b")?.lastHeartbeatMs, 2000);
    nowMs = 3000;
    const reactionResponse = await sendTelegramBusLocalEnvelope({
      socketPath: leaderSocketPath,
      envelope: {
        kind: "leader.forwardReaction",
        requestId: "leader:2",
        recipientInstanceId: "inst-b",
        recipientRegistrationGeneration: "generation-b",
        delivery: delivery("leader.forwardReaction", 2),
        reactionUpdate: { message_id: 9, new_reaction: [] },
        sentAtMs: 3000,
      },
    });
    assert.equal(registry.get("inst-b")?.lastHeartbeatMs, 3000);
    nowMs = 4000;
    const messageResponse = await sendTelegramBusLocalEnvelope({
      socketPath: leaderSocketPath,
      envelope: {
        kind: "leader.forwardMessage",
        requestId: "leader:3",
        recipientInstanceId: "inst-b",
        recipientRegistrationGeneration: "generation-b",
        delivery: delivery("leader.forwardMessage", 3),
        message: { message_id: 10, text: "hi" },
        sentAtMs: 4000,
      },
    });
    assert.equal(registry.get("inst-b")?.lastHeartbeatMs, 4000);
    nowMs = 5000;
    const editedMessageResponse = await sendTelegramBusLocalEnvelope({
      socketPath: leaderSocketPath,
      envelope: {
        kind: "leader.forwardEditedMessage",
        requestId: "leader:4",
        recipientInstanceId: "inst-b",
        recipientRegistrationGeneration: "generation-b",
        delivery: delivery("leader.forwardEditedMessage", 4),
        message: { message_id: 10, text: "edited" },
        sentAtMs: 5000,
      },
    });
    assert.deepEqual(callbackResponse, {
      kind: "bus.ack",
      requestId: "leader:1",
      ok: true,
      message: undefined,
      result: {
        deliveryId: delivery("leader.forwardCallback", 1).deliveryId,
        sourceUpdateId: 1,
      },
    });
    assert.deepEqual(reactionResponse, {
      kind: "bus.ack",
      requestId: "leader:2",
      ok: true,
      message: undefined,
      result: {
        deliveryId: delivery("leader.forwardReaction", 2).deliveryId,
        sourceUpdateId: 2,
      },
    });
    assert.deepEqual(messageResponse, {
      kind: "bus.ack",
      requestId: "leader:3",
      ok: true,
      message: undefined,
      result: {
        deliveryId: delivery("leader.forwardMessage", 3).deliveryId,
        sourceUpdateId: 3,
      },
    });
    assert.deepEqual(editedMessageResponse, {
      kind: "bus.ack",
      requestId: "leader:4",
      ok: true,
      message: undefined,
      result: {
        deliveryId: delivery("leader.forwardEditedMessage", 4).deliveryId,
        sourceUpdateId: 4,
      },
    });
    assert.equal(registry.get("inst-b")?.lastHeartbeatMs, 5000);
    assert.deepEqual(received, [
      {
        kind: "callback",
        query: { id: "cb-1", data: "queue:pause" },
        ctx: "ctx",
      },
      {
        kind: "reaction",
        reactionUpdate: { message_id: 9, new_reaction: [] },
        ctx: "ctx",
      },
      { kind: "message", message: { message_id: 10, text: "hi" }, ctx: "ctx" },
      {
        kind: "edited-message",
        message: { message_id: 10, text: "edited" },
        ctx: "ctx",
      },
    ]);
  } finally {
    await leader.stop();
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower rejects retired target replacement over IPC without recipient effects", async () => {
  await fixture(async ({ path, request }) => {
    const state = createTelegramBusFollowerRegistrationState();
    state.setRegistered(true, request.binding.target, { generation: "registration", slot: "A" });
    const before = await readFile(path, "utf8");
    const socketPath = getTelegramBusFollowerSocketPath("retired-restore", dirname(path));
    const receiver = createTelegramBusForwardedUpdateReceiverRuntime({
      socketPath, instanceId: "old", getAuthSecret: () => "secret",
      getRegistrationGeneration: state.getGeneration, getRecipientBindingKey: () => "manual:old",
      getContext: () => assert.fail("retired request reached recipient context"),
      isWorkspaceRestoreEnabled: () => true,
      handleWorkspaceRestore: async () => assert.fail("retired request reached Restore"),
      durableAdmission: { async admit() { assert.fail("retired request reached admission"); } },
    });
    try {
      await receiver.start();
      for (const generation of [undefined, "registration"]) {
        // Send the retired wire shape deliberately; it is no longer a typed producer contract.
        const envelope = { kind: "leader.replaceFollowerTarget", requestId: "retired",
          recipientInstanceId: "old", recipientRegistrationGeneration: generation,
          target: request.target, oldTarget: request.binding.target,
          reason: "thread-restore", auth: "secret", sentAtMs: 1000 } as unknown as TelegramBusEnvelope;
        assert.deepEqual(await sendTelegramBusLocalEnvelope({ socketPath, envelope,
          retry: { attempts: 1, delayMs: 0 } }), {
          kind: "bus.ack", requestId: "invalid", ok: false,
          message: "Invalid Telegram bus envelope.",
        });
        assert.equal(await readFile(path, "utf8"), before);
        assert.deepEqual(state.getTarget(), request.binding.target);
        assert.equal(state.getGeneration(), "registration");
      }
    } finally {
      await receiver.stop();
    }
  }, "follower");
});

test("Bus follower receiver rejects delayed work from a replaced registration generation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-forward-generation-"));
  const socketPath = join(dir, "follower.sock");
  let handled = 0;
  const receiver = createTelegramBusForwardedUpdateReceiverRuntime({
    socketPath,
    instanceId: "inst-b",
    getRegistrationGeneration: () => "generation-new",
    getRecipientBindingKey: () => "manual:owner-b",
    getContext: () => "ctx",
    durableAdmission: {
      async admit(envelope) {
        handled += 1;
        return {
          deliveryId: envelope.delivery!.deliveryId,
          sourceUpdateId: envelope.delivery!.sourceUpdateId,
        };
      },
    },
  });
  try {
    await receiver.start();
    const response = await sendTelegramBusLocalEnvelope({
      socketPath,
      envelope: {
        kind: "leader.forwardCallback",
        requestId: "leader:old:1",
        recipientInstanceId: "inst-b",
        recipientRegistrationGeneration: "generation-old",
        delivery: createTelegramBusFollowerDeliveryIdentity({
          kind: "leader.forwardCallback",
          recipientBindingKey: "manual:owner-b",
          sourceUpdateId: 1,
        }),
        query: { id: "old", pi_telegram_source_update_id: 1 },
        sentAtMs: 2000,
      },
    });
    assert.equal(handled, 0);
    assert.deepEqual(response, {
      kind: "bus.ack",
      requestId: "leader:old:1",
      ok: false,
      message: "Stale Telegram bus follower registration generation.",
    });
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower receiver ACKs durable append before downstream execution and deduplicates replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-durable-admission-"));
  const socketPath = join(dir, "follower.sock");
  const admitted = new Set<number>();
  const journaled: unknown[] = [];
  let signals = 0;
  const durableAdmission = createTelegramBusFollowerDurableAdmissionRuntime({
    journal: {
      appendBatch(updates) {
        const updateId = updates[0]!.update_id;
        if (!admitted.has(updateId)) journaled.push(...updates);
        admitted.add(updateId);
      },
    },
    signalWorker() {
      signals += 1;
    },
  });
  const receiver = createTelegramBusForwardedUpdateReceiverRuntime({
    socketPath,
    instanceId: "inst-b",
    getRegistrationGeneration: () => "generation-b",
    getRecipientBindingKey: () => "manual:owner-b",
    durableAdmission,
    getContext: () => "ctx",
  });
  const delivery = createTelegramBusFollowerDeliveryIdentity({
    kind: "leader.forwardCallback",
    recipientBindingKey: "manual:owner-b",
    sourceUpdateId: 44,
  });
  const send = (requestId: string) =>
    sendTelegramBusLocalEnvelope({
      socketPath,
      envelope: {
        kind: "leader.forwardCallback",
        requestId,
        recipientInstanceId: "inst-b",
        recipientRegistrationGeneration: "generation-b",
        delivery,
        query: { id: "callback", pi_telegram_source_update_id: 44 },
        sentAtMs: 2000,
      },
    });
  try {
    await receiver.start();
    assert.deepEqual(await send("leader:1"), {
      kind: "bus.ack",
      requestId: "leader:1",
      ok: true,
      message: undefined,
      result: {
        deliveryId: delivery.deliveryId,
        sourceUpdateId: 44,
      },
    });
    assert.deepEqual(await send("leader:2"), {
      kind: "bus.ack",
      requestId: "leader:2",
      ok: true,
      message: undefined,
      result: {
        deliveryId: delivery.deliveryId,
        sourceUpdateId: 44,
      },
    });
    assert.deepEqual(journaled, [
      {
        update_id: 44,
        callback_query: {
          id: "callback",
          pi_telegram_source_update_id: 44,
        },
      },
    ]);
    assert.equal(signals, 1, "a repeated delivery is acknowledged without waking the worker again");
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Follower delivery replay window is bounded by age and capacity", async () => {
  const appended: number[] = [];
  let nowMs = 1000;
  const admission = createTelegramBusFollowerDurableAdmissionRuntime<string>({
    journal: { appendBatch(updates) { appended.push(...updates.map(update => update.update_id)); } },
    signalWorker() {}, getNowMs: () => nowMs, recentDeliveryLimit: { maxAgeMs: 100, maxEntries: 2 },
  });
  const admit = (sourceUpdateId: number) => admission.admit({
    kind: "leader.forwardMessage", requestId: `request-${sourceUpdateId}-${nowMs}`, recipientInstanceId: "inst-b",
    recipientRegistrationGeneration: "generation-b", sentAtMs: nowMs,
    delivery: createTelegramBusFollowerDeliveryIdentity({ kind: "leader.forwardMessage", recipientBindingKey: "manual:owner-b", sourceUpdateId }),
    message: { message_id: sourceUpdateId, chat: { id: 7, type: "private" }, pi_telegram_source_update_id: sourceUpdateId },
  } as never, "ctx");
  await admit(1); await admit(1);
  assert.deepEqual(appended, [1], "a retry inside the window is acknowledged without another append");
  nowMs += 100;
  await admit(1);
  assert.deepEqual(appended, [1, 1], "an expired delivery is admitted again");
  await admit(2); await admit(3); await admit(1);
  assert.deepEqual(appended, [1, 1, 2, 3, 1], "capacity evicts the oldest delivery first");
  await admit(3);
  assert.deepEqual(appended, [1, 1, 2, 3, 1], "recent deliveries inside capacity remain deduplicated");
});

test("Follower replay restores persisted forward grouping metadata without exposing it", () => {
  const prepared: unknown[] = [];
  const journaled = {
    update_id: 45,
    pi_telegram_forward_comment_batch_position: "forward",
    message: { message_id: 9 },
  };
  const update = prepareTelegramBusFollowerJournaledUpdateForExecution(
    journaled,
    (message, position) => prepared.push({ message, position }),
  );
  assert.deepEqual(prepared, [
    { message: { message_id: 9 }, position: "forward" },
  ]);
  assert.deepEqual(update, {
    update_id: 45,
    message: { message_id: 9 },
  });
  assert.equal(
    "pi_telegram_forward_comment_batch_position" in journaled,
    true,
  );
});

test("Bus follower receiver rejects a mismatched durable delivery binding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-delivery-binding-"));
  const socketPath = join(dir, "follower.sock");
  let handled = 0;
  const receiver = createTelegramBusForwardedUpdateReceiverRuntime({
    socketPath,
    instanceId: "inst-b",
    getRegistrationGeneration: () => "generation-b",
    getRecipientBindingKey: () => "manual:owner-b",
    getContext: () => "ctx",
    durableAdmission: {
      async admit(envelope) {
        handled += 1;
        return {
          deliveryId: envelope.delivery!.deliveryId,
          sourceUpdateId: envelope.delivery!.sourceUpdateId,
        };
      },
    },
  });
  try {
    await receiver.start();
    const response = await sendTelegramBusLocalEnvelope({
      socketPath,
      envelope: {
        kind: "leader.forwardCallback",
        requestId: "leader:1",
        recipientInstanceId: "inst-b",
        recipientRegistrationGeneration: "generation-b",
        delivery: createTelegramBusFollowerDeliveryIdentity({
          kind: "leader.forwardCallback",
          recipientBindingKey: "manual:other-owner",
          sourceUpdateId: 44,
        }),
        query: { id: "callback" },
        sentAtMs: 2000,
      },
    });
    assert.equal(handled, 0);
    assert.deepEqual(response, {
      kind: "bus.ack",
      requestId: "leader:1",
      ok: false,
      message: "Mismatched Telegram follower delivery identity.",
    });
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower receiver rejects journal admission failure without a receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-admission-failure-"));
  const socketPath = join(dir, "follower.sock");
  const receiver = createTelegramBusForwardedUpdateReceiverRuntime({
    socketPath,
    instanceId: "inst-b",
    getRegistrationGeneration: () => "generation-b",
    getRecipientBindingKey: () => "manual:owner-b",
    getContext: () => "ctx",
    durableAdmission: {
      async admit() {
        throw new Error("Telegram inbound journal capacity exceeded.");
      },
    },
  });
  try {
    await receiver.start();
    const response = await sendTelegramBusLocalEnvelope({
      socketPath,
      envelope: {
        kind: "leader.forwardCallback",
        requestId: "leader:1",
        recipientInstanceId: "inst-b",
        recipientRegistrationGeneration: "generation-b",
        delivery: createTelegramBusFollowerDeliveryIdentity({
          kind: "leader.forwardCallback",
          recipientBindingKey: "manual:owner-b",
          sourceUpdateId: 44,
        }),
        query: {
          id: "callback",
          pi_telegram_source_update_id: 44,
        },
        sentAtMs: 2000,
      },
    });
    assert.deepEqual(response, {
      kind: "bus.ack",
      requestId: "leader:1",
      ok: false,
      message: "Telegram inbound journal capacity exceeded.",
    });
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower recovery in flight cannot register after an operator stop and reconnect", async () => {
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(true, { chatId: 42, threadId: 10 }, { slot: "F", threadName: "Fjord" });
  let registers = 0;
  let releaseSleep!: () => void;
  const sleeping = new Promise<void>((resolve) => { releaseSleep = resolve; });
  const handler = createTelegramBusFollowerHeartbeatRecoveryHandler({
    registrationState,
    getRegistrationRuntime: () => ({ registerWithLeader: async () => { registers += 1; return false; }, setContext: () => undefined, stop: () => undefined }),
    getLeaderState: () => ({ kind: "active-elsewhere", lock: { pid: 99 } }) as never,
    setLifecyclePhase: () => undefined,
    updateStatus: () => undefined,
    promoteToLeader: async () => false,
    sleep: () => sleeping,
    scheduleRetry: () => undefined,
    promotionGraceMs: 0,
    recordRuntimeEvent: () => undefined,
  });
  const running = handler(new Error("heartbeat failed"), "ctx");
  await new Promise((resolve) => setImmediate(resolve));
  const before = registers;
  // `/telegram-disconnect` then `/telegram-connect` while the old recovery waits out its grace period.
  handler.halt();
  handler.resume();
  releaseSleep();
  await running;
  assert.equal(registers, before, "The old recovery's epoch ended; it cannot register beside the fresh connect");
});

for (const probe of ["acknowledged", "refused"] as const)
test(`Bus follower heartbeat recovery ${probe === "acknowledged" ? "keeps" : "replaces"} the registration when the leader ${probe === "acknowledged" ? "still answers" : "no longer answers"} (${probe})`, async () => {
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(true, { chatId: 42, threadId: 10 }, { slot: "F", threadName: "Fjord" });
  const events: string[] = [];
  const handler = createTelegramBusFollowerHeartbeatRecoveryHandler({
    registrationState,
    getRegistrationRuntime: () => ({ registerWithLeader: async () => { events.push("register"); return true; }, setContext: () => undefined, stop: () => undefined }),
    probeRegistration: async () => { events.push("probe"); return probe === "acknowledged"; },
    getLeaderState: () => ({ kind: "active-elsewhere", lock: { pid: 99 } }) as never,
    setLifecyclePhase: () => undefined,
    updateStatus: () => undefined,
    promoteToLeader: async () => false,
    sleep: async () => undefined,
    scheduleRetry: () => undefined,
    promotionGraceMs: 0,
    recordRuntimeEvent: (_category, reason, details) => { if (details?.phase === "follower-heartbeat-registration-kept") events.push("kept"); void reason; },
  });
  await handler(new Error("Timed out waiting for Telegram bus response"), "ctx");
  if (probe === "acknowledged") {
    assert.deepEqual(events, ["probe", "kept"], "A stalled but live leader keeps the same registration generation");
    assert.equal(registrationState.isRegistered(), true, "The follower never flickers to unregistered");
  } else {
    assert.deepEqual(events, ["probe", "register"], "An unanswered probe falls through to the existing re-registration");
  }
});

test("Bus follower retry armed before an operator stop and reconnect never fires a recovery", async () => {
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(true, { chatId: 42, threadId: 10 }, { slot: "F", threadName: "Fjord" });
  let retry: (() => void) | undefined;
  let promotions = 0;
  const handler = createTelegramBusFollowerHeartbeatRecoveryHandler({
    registrationState,
    getRegistrationRuntime: () => ({ registerWithLeader: async () => false, setContext: () => undefined, stop: () => undefined }),
    getLeaderState: () => ({ kind: "inactive" }) as never,
    setLifecyclePhase: () => undefined,
    updateStatus: () => undefined,
    promoteToLeader: async () => { promotions += 1; return false; },
    sleep: async () => undefined,
    scheduleRetry: (next) => { retry = next; },
    promotionGraceMs: 0,
    recordRuntimeEvent: () => undefined,
  });
  await handler(new Error("heartbeat failed"), "ctx");
  assert.ok(retry, "A lost election arms a retry");
  const before = promotions;
  handler.halt();
  handler.resume();
  retry!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(promotions, before, "The cancelled retry is inert even when its scheduler still fires it");
});

for (const outcome of ["registered", "registration-failed", "promotion-lost", "promotion-failed"] as const) {
  test(`Bus follower obsolete recovery settlement is inert after reconnect (${outcome})`, async () => {
    const registrationState = createTelegramBusFollowerRegistrationState();
    registrationState.setRegistered(true, { chatId: 42, threadId: 10 }, { slot: "F", threadName: "Fjord" });
    const target = { chatId: 42, threadId: 11 };
    let replacement = false;
    const staleEffects: string[] = [];
    let handler!: ReturnType<typeof createTelegramBusFollowerHeartbeatRecoveryHandler<string>>;
    const registration = {
      async registerWithLeader() {
        queueMicrotask(reconnect);
        if (outcome === "registration-failed") throw new Error("Obsolete registration failed");
        return true;
      },
      setContext() {},
      stop() {
        if (replacement) staleEffects.push("stop");
        registrationState.setRegistered(false);
      },
    };
    const reconnect = (): void => {
      handler.halt();
      registration.stop();
      handler.resume();
      registrationState.setRegistered(true, target, { slot: "F", threadName: "Fjord", generation: "fresh" });
      replacement = true;
    };
    handler = createTelegramBusFollowerHeartbeatRecoveryHandler({
      registrationState,
      getRegistrationRuntime: () => registration,
      getLeaderState: () => outcome.startsWith("promotion")
        ? { kind: "inactive" }
        : ({ kind: "active-elsewhere", lock: { pid: 99 } } as never),
      setLifecyclePhase: () => { if (replacement) staleEffects.push("phase"); },
      updateStatus: () => { if (replacement) staleEffects.push("status"); },
      promoteToLeader: async () => {
        queueMicrotask(reconnect);
        if (outcome === "promotion-failed") throw new Error("Obsolete promotion failed");
        return false;
      },
      sleep: async () => {},
      scheduleRetry: () => { if (replacement) staleEffects.push("retry"); },
      promotionGraceMs: 0,
      recordRuntimeEvent: () => {},
    });
    await handler(new Error("Heartbeat failed"), "ctx");
    assert.equal(replacement, true);
    assert.equal(registrationState.isRegistered(), true, "Obsolete success and failure retain the fresh registration");
    assert.equal(registrationState.getGeneration(), "fresh");
    assert.deepEqual(registrationState.getTarget(), target);
    assert.deepEqual(staleEffects, [], "An expired recovery can neither stop, clear nor retry beside the replacement");
  });
}

function runFollowerRecovery(events: TelegramBusFollowerRecoveryEvent[]) {
  let state = createTelegramBusFollowerRecoveryState();
  const effects: string[] = [];
  for (const event of events) {
    const next = transitionTelegramBusFollowerRecovery(state, event);
    state = next.state;
    effects.push(...next.effects.map((effect) => effect.type));
  }
  return { state, effects };
}

test("Bus follower recovery machine runs one recovery per epoch and fences retries by epoch", () => {
  assert.deepEqual(runFollowerRecovery([{ type: "recoverRequested" }, { type: "recoverRequested" }]).effects, ["runRecovery"]);
  const stale = runFollowerRecovery([
    { type: "recoverRequested" },
    { type: "resumed" },
    { type: "retryRequested", epoch: 0 },
    { type: "recoverySettled", epoch: 0 },
  ]);
  assert.deepEqual(stale.effects, ["runRecovery"], "An old epoch can neither arm a retry nor settle the new one");
  assert.equal(stale.state.epoch, 1);
  const retried = runFollowerRecovery([
    { type: "recoverRequested" },
    { type: "retryRequested", epoch: 0 },
    { type: "recoverySettled", epoch: 0 },
    { type: "retryFired", retryId: 1 },
  ]);
  assert.deepEqual(retried.effects, ["runRecovery", "armRetry", "runRecovery"]);
  const halted = runFollowerRecovery([
    { type: "recoverRequested" },
    { type: "retryRequested", epoch: 0 },
    { type: "halted" },
    { type: "retryFired", retryId: 1 },
    { type: "recoverRequested" },
  ]);
  assert.deepEqual(halted.effects, ["runRecovery", "armRetry", "cancelRetry"], "A halted follower never recovers");
});

test("Bus follower heartbeat recovery passes current binding into promotion", async () => {
  const promoted: unknown[] = [];
  let leaderStateCalls = 0;
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(
    true,
    { chatId: 42, threadId: 10 },
    {
      slot: "F",
      threadName: "Fjord",
    },
  );
  const handler = createTelegramBusFollowerHeartbeatRecoveryHandler({
    registrationState,
    getRegistrationRuntime: () => ({
      registerWithLeader: async () => false,
      setContext: () => undefined,
      stop: () => undefined,
    }),
    getLeaderState: () => {
      leaderStateCalls += 1;
      return leaderStateCalls === 1
        ? { kind: "active-elsewhere", lock: { pid: 99 } }
        : { kind: "inactive" };
    },
    setLifecyclePhase: () => undefined,
    updateStatus: () => undefined,
    promoteToLeader: async (_ctx, binding) => {
      promoted.push(binding);
      return true;
    },
    sleep: async () => undefined,
    promotionGraceMs: 0,
    recordRuntimeEvent: () => undefined,
  });

  await handler(new Error("heartbeat failed"), "ctx");

  assert.deepEqual(promoted, [
    { target: { chatId: 42, threadId: 10 }, slot: "F", threadName: "Fjord" },
  ]);
});

test("Bus follower recovery contains promotion authority failure and schedules retry", async () => {
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(
    true,
    { chatId: 42, threadId: 10 },
    { threadName: "Fjord" },
  );
  let scheduledRetry: (() => void) | undefined;
  const events: Array<{ error: unknown; phase?: unknown }> = [];
  const handler = createTelegramBusFollowerHeartbeatRecoveryHandler({
    registrationState,
    getRegistrationRuntime: () => ({
      registerWithLeader: async () => false,
      setContext: () => undefined,
      stop: () => undefined,
    }),
    getLeaderState: () => ({ kind: "inactive" }),
    setLifecyclePhase: () => undefined,
    updateStatus: () => undefined,
    promoteToLeader: async () => {
      throw new Error("Telegram follower promotion slot authority is unavailable.");
    },
    scheduleRetry: (retry) => {
      scheduledRetry = retry;
    },
    promotionGraceMs: 0,
    recordRuntimeEvent: (_category, error, details) => {
      events.push({ error, phase: details?.phase });
    },
  });

  await handler(new Error("leader disconnected"), "ctx");

  assert.equal(typeof scheduledRetry, "function");
  assert.equal(
    events.some(
      (event) =>
        event.phase === "follower-promotion-failed" &&
        event.error instanceof Error &&
        /promotion slot authority is unavailable/u.test(event.error.message),
    ),
    true,
  );
});

test("Bus follower election defers a higher slot to the lowest live candidate", async () => {
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(
    true,
    { chatId: 42, threadId: 10 },
    { slot: "D", threadName: "Dawn" },
  );
  registrationState.setEligibleElectionSlots(["D", "C"]);
  let state: "inactive" | "winner" = "inactive";
  let promoted = 0;
  let registered = 0;
  const events: Array<Record<string, unknown> | undefined> = [];
  const handler = createTelegramBusFollowerHeartbeatRecoveryHandler({
    registrationState,
    getRegistrationRuntime: () => ({
      registerWithLeader: async () => {
        registered += 1;
        return true;
      },
      setContext: () => undefined,
      stop: () => registrationState.setRegistered(false),
    }),
    getLeaderState: () =>
      state === "inactive"
        ? { kind: "inactive" }
        : {
            kind: "active-elsewhere",
            lock: { pid: 99, instanceId: "slot-c", leaderEpoch: "epoch-c" },
          },
    setLifecyclePhase: () => undefined,
    updateStatus: () => undefined,
    promoteToLeader: async () => {
      promoted += 1;
      return true;
    },
    sleep: async () => {
      state = "winner";
    },
    promotionGraceMs: 2500,
    recordRuntimeEvent: (_category, _message, details) => {
      events.push(details);
    },
  });

  await handler(new Error("leader disconnected"), "ctx");

  assert.equal(promoted, 0);
  assert.equal(registered, 1);
  assert.equal(
    events.some(
      (details) =>
        details?.phase === "follower-promotion-slot-priority" &&
        details.lowerEligibleSlot === "C",
    ),
    true,
  );
});

test("Bus follower heartbeat recovery never promotes over a live leader lease", async () => {
  const promoted: unknown[] = [];
  const phases: Array<string | undefined> = [];
  const events: Array<{ message: unknown; phase?: unknown }> = [];
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(true, { chatId: 42, threadId: 10 });
  const liveLeader = {
    kind: "active-elsewhere" as const,
    lock: {
      pid: 99,
      instanceId: "leader-a",
      leaderEpoch: "epoch-a",
    },
  };
  const handler = createTelegramBusFollowerHeartbeatRecoveryHandler({
    registrationState,
    getRegistrationRuntime: () => ({
      registerWithLeader: async () => false,
      setContext: () => undefined,
      stop: () => undefined,
    }),
    getLeaderState: () => liveLeader,
    setLifecyclePhase: (phase) => {
      phases.push(phase);
    },
    updateStatus: () => undefined,
    promoteToLeader: async (_ctx, binding) => {
      promoted.push(binding);
      return true;
    },
    sleep: async () => undefined,
    promotionGraceMs: 0,
    recordRuntimeEvent: (_category, message, details) => {
      events.push({ message, phase: details?.phase });
    },
  });

  await handler(new Error("heartbeat failed"), "ctx");

  assert.deepEqual(promoted, []);
  assert.equal(phases.at(-1), undefined);
  assert.equal(
    events.some(
      (event) => event.phase === "follower-promotion-live-owner",
    ),
    true,
  );
});

for (const proven of [false, true]) test(`Bus follower heartbeat recovery promotes over a live-PID leader only with bus proof (${proven ? "proven" : "unproven"})`, async () => {
  const elections: unknown[] = [];
  const proofs: unknown[] = [];
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(true, { chatId: 42, threadId: 10 });
  const liveLeader = {
    kind: "active-elsewhere" as const,
    lock: { pid: 99, instanceId: "leader-a", leaderEpoch: "epoch-a" },
  };
  const handler = createTelegramBusFollowerHeartbeatRecoveryHandler({
    registrationState,
    getRegistrationRuntime: () => ({
      registerWithLeader: async () => false,
      setContext: () => undefined,
      stop: () => undefined,
    }),
    getLeaderState: () => liveLeader,
    setLifecyclePhase: () => undefined,
    updateStatus: () => undefined,
    promoteToLeader: async (_ctx, _binding, election) => {
      elections.push(election);
      return true;
    },
    proveLeaderUnresponsive: async (owner) => {
      proofs.push(owner);
      return proven;
    },
    sleep: async () => undefined,
    promotionGraceMs: 0,
    recordRuntimeEvent: () => undefined,
  });

  await handler(new Error("heartbeat failed"), "ctx");

  assert.deepEqual(proofs, [liveLeader.lock]);
  assert.deepEqual(elections, proven ? [{ expectedOwner: liveLeader.lock, unresponsive: true }] : []);
});

test("Bus follower recovery goes offline once Threaded Mode is off and stays halted until resumed", async () => {
  const elections: unknown[] = [];
  const registrations: unknown[] = [];
  const retries: Array<() => void> = [];
  const phases: Array<string | undefined> = [];
  const events: unknown[] = [];
  let stops = 0;
  let threadModeDisabled = true;
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(true, { chatId: 42, threadId: 10 });
  const handler = createTelegramBusFollowerHeartbeatRecoveryHandler({
    registrationState,
    getRegistrationRuntime: () => ({
      registerWithLeader: async (...args: unknown[]) => {
        registrations.push(args);
        return false;
      },
      setContext: () => undefined,
      stop: () => {
        stops += 1;
      },
    }),
    getLeaderState: () => ({ kind: "active-elsewhere" as const, lock: { pid: 99, instanceId: "leader", leaderEpoch: "epoch" } }),
    setLifecyclePhase: (phase) => {
      phases.push(phase);
    },
    updateStatus: () => undefined,
    promoteToLeader: async (_ctx, _binding, election) => {
      elections.push(election);
      return true;
    },
    isThreadModeDisabled: () => threadModeDisabled,
    scheduleRetry: (retry) => {
      retries.push(retry);
    },
    sleep: async () => undefined,
    promotionGraceMs: 0,
    recordRuntimeEvent: (_category, _message, details) => {
      events.push(details?.phase);
    },
  });

  await handler(new Error("leader endpoint gone"), "ctx");
  assert.equal(stops, 1);
  assert.deepEqual(registrations, [], "No registration loop against a classic-mode leader");
  assert.deepEqual(elections, []);
  assert.deepEqual(retries, []);
  assert.equal(phases.at(-1), undefined);
  assert.ok(events.includes("follower-thread-mode-disabled"));

  threadModeDisabled = false;
  await handler(new Error("late heartbeat failure"), "ctx");
  assert.deepEqual(registrations, [], "A halted follower stays offline until a deliberate connect");
  handler.resume();
  await handler(new Error("fresh failure after reconnect"), "ctx");
  assert.equal(registrations.length > 0, true, "A deliberate registration resumes recovery");
});

test("Bus follower heartbeat recovery retries until a live lease becomes stale", async () => {
  let stateReadCount = 0;
  let scheduledRetry: (() => void) | undefined;
  let resolvePromoted: (() => void) | undefined;
  const promoted = new Promise<void>((resolve) => {
    resolvePromoted = resolve;
  });
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(
    true,
    { chatId: 42, threadId: 10 },
    { slot: "F", threadName: "Fjord" },
  );
  const liveLock = {
    pid: 99,
    instanceId: "leader-a",
    leaderEpoch: "epoch-a",
  };
  const handler = createTelegramBusFollowerHeartbeatRecoveryHandler({
    registrationState,
    getRegistrationRuntime: () => ({
      registerWithLeader: async () => false,
      setContext: () => undefined,
      stop: () => undefined,
    }),
    getLeaderState: () => {
      stateReadCount += 1;
      return stateReadCount <= 2
        ? { kind: "active-elsewhere", lock: liveLock }
        : { kind: "stale", lock: liveLock };
    },
    setLifecyclePhase: () => undefined,
    updateStatus: () => undefined,
    promoteToLeader: async (_ctx, binding, election) => {
      assert.deepEqual(binding, {
        target: { chatId: 42, threadId: 10 },
        slot: "F",
        threadName: "Fjord",
      });
      assert.deepEqual(election, { expectedOwner: liveLock });
      resolvePromoted?.();
      return true;
    },
    sleep: async () => undefined,
    scheduleRetry: (retry) => {
      scheduledRetry = retry;
    },
    getActiveContext: () => "ctx",
    promotionGraceMs: 0,
    recordRuntimeEvent: () => undefined,
  });

  await handler(new Error("heartbeat failed"), "ctx");
  assert.ok(scheduledRetry);
  scheduledRetry();
  await promoted;
});

test("Bus follower election loser schedules re-registration with the winner", async () => {
  const scheduled: Array<() => void> = [];
  let registrationCalls = 0;
  let promotionCalls = 0;
  let registrationTarget: unknown;
  let resolveRegistered: (() => void) | undefined;
  const registered = new Promise<void>((resolve) => {
    resolveRegistered = resolve;
  });
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(true, { chatId: 42, threadId: 10 });
  const staleLock = { pid: 99, leaderEpoch: "old-epoch" };
  const winnerLock = { pid: 100, leaderEpoch: "winner-epoch" };
  let state: "stale" | "winner" = "stale";
  const handler = createTelegramBusFollowerHeartbeatRecoveryHandler({
    registrationState,
    getRegistrationRuntime: () => ({
      registerWithLeader: async (_ctx, _leader, options) => {
        registrationCalls += 1;
        registrationTarget = options?.target;
        resolveRegistered?.();
        return true;
      },
      setContext: () => undefined,
      stop: () => {
        registrationState.setRegistered(false);
      },
    }),
    getLeaderState: () =>
      state === "stale"
        ? { kind: "stale", lock: staleLock }
        : { kind: "active-elsewhere", lock: winnerLock },
    setLifecyclePhase: () => undefined,
    updateStatus: () => undefined,
    promoteToLeader: async () => {
      promotionCalls += 1;
      state = "winner";
      return false;
    },
    sleep: async () => undefined,
    scheduleRetry: (retry) => {
      scheduled.push(retry);
    },
    getActiveContext: () => "ctx",
    promotionGraceMs: 0,
    recordRuntimeEvent: () => undefined,
  });

  await handler(new Error("heartbeat failed"), "ctx");
  assert.equal(promotionCalls, 1);
  assert.equal(scheduled.length, 1);
  scheduled.shift()?.();
  await registered;
  assert.equal(registrationCalls, 1);
  assert.deepEqual(registrationTarget, { chatId: 42, threadId: 10 });
});

test("Bus follower scheduled recovery transfers across session context replacement", async () => {
  const scheduled: Array<() => void> = [];
  let activeContext: string | undefined = "old-ctx";
  let stateReads = 0;
  let promotedContext: string | undefined;
  let resolvePromoted: (() => void) | undefined;
  const promoted = new Promise<void>((resolve) => {
    resolvePromoted = resolve;
  });
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(true, { chatId: 42, threadId: 10 });
  const lock = { pid: 99, leaderEpoch: "epoch-a" };
  const handler = createTelegramBusFollowerHeartbeatRecoveryHandler({
    registrationState,
    getRegistrationRuntime: () => ({
      registerWithLeader: async () => false,
      setContext: () => undefined,
      stop: () => undefined,
    }),
    getLeaderState: () => {
      stateReads += 1;
      return stateReads <= 2
        ? { kind: "active-elsewhere", lock }
        : { kind: "stale", lock };
    },
    setLifecyclePhase: () => undefined,
    updateStatus: () => undefined,
    promoteToLeader: async (ctx) => {
      promotedContext = ctx;
      resolvePromoted?.();
      return true;
    },
    sleep: async () => undefined,
    scheduleRetry: (retry) => {
      scheduled.push(retry);
    },
    getActiveContext: () => activeContext,
    promotionGraceMs: 0,
    recordRuntimeEvent: () => undefined,
  });

  await handler(new Error("heartbeat failed"), "old-ctx");
  activeContext = undefined;
  scheduled.shift()?.();
  assert.equal(scheduled.length, 1);
  activeContext = "new-ctx";
  scheduled.shift()?.();
  await promoted;
  assert.equal(promotedContext, "new-ctx");
});

test("Bus follower promotes a manually connected follower through the live session context without a retry", async () => {
  // Pi creates a fresh context per command and event: /telegram-connect registers with a command context that is
  // never the stored session object. Heartbeat failures outpace the retry grace, so retries must not be required.
  const scheduled: Array<() => void> = [];
  const promotedContexts: unknown[] = [];
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(true, { chatId: 42, threadId: 10 }, { slot: "D", threadName: "Delta" });
  const commandCtx = { cwd: "/repo", source: "command" };
  const sessionCtx = { cwd: "/repo", source: "session_start" };
  const handler = createTelegramBusFollowerHeartbeatRecoveryHandler({
    registrationState,
    getRegistrationRuntime: () => ({ registerWithLeader: async () => false, setContext: () => undefined, stop: () => undefined }),
    getLeaderState: () => ({ kind: "inactive" }),
    setLifecyclePhase: () => undefined,
    updateStatus: () => undefined,
    promoteToLeader: async (ctx) => {
      promotedContexts.push(ctx);
      return true;
    },
    sleep: async () => undefined,
    scheduleRetry: (retry) => {
      scheduled.push(retry);
    },
    getActiveContext: () => sessionCtx,
    promotionGraceMs: 0,
    recordRuntimeEvent: () => undefined,
  });
  await handler(new Error("connect ENOENT"), commandCtx);
  assert.deepEqual(promotedContexts, [sessionCtx]);
  assert.equal(scheduled.length, 0, "promotion must not depend on a retry that heartbeat failures keep re-arming");
});

test("Bus follower heartbeat recovery waits for a session context before promotion", async () => {
  const scheduled: Array<() => void> = [];
  let promotions = 0;
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(true, { chatId: 42, threadId: 10 });
  const handler = createTelegramBusFollowerHeartbeatRecoveryHandler({
    registrationState,
    getRegistrationRuntime: () => ({ registerWithLeader: async () => false, setContext: () => undefined, stop: () => undefined }),
    getLeaderState: () => ({ kind: "inactive" }),
    setLifecyclePhase: () => undefined,
    updateStatus: () => undefined,
    promoteToLeader: async () => {
      promotions += 1;
      return true;
    },
    sleep: async () => undefined,
    scheduleRetry: (retry) => {
      scheduled.push(retry);
    },
    getActiveContext: (): string | undefined => undefined,
    promotionGraceMs: 0,
    recordRuntimeEvent: () => undefined,
  });
  await handler(new Error("connect ENOENT"), "ctx");
  assert.equal(promotions, 0);
  assert.equal(scheduled.length, 1);
});

test("Bus follower heartbeat recovery swallows stale-context status updates", async () => {
  const events: unknown[] = [];
  let leaderStateCalls = 0;
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(true, { chatId: 42, threadId: 10 });
  const handler = createTelegramBusFollowerHeartbeatRecoveryHandler({
    registrationState,
    getRegistrationRuntime: () => ({
      registerWithLeader: async () => false,
      setContext: () => undefined,
      stop: () => undefined,
    }),
    getLeaderState: () => {
      leaderStateCalls += 1;
      return leaderStateCalls === 1
        ? { kind: "active-elsewhere", lock: { pid: 99 } }
        : { kind: "inactive" };
    },
    setLifecyclePhase: () => undefined,
    updateStatus: () => {
      throw new Error("This extension ctx is stale after session replacement");
    },
    promoteToLeader: async () => true,
    sleep: async () => undefined,
    promotionGraceMs: 0,
    recordRuntimeEvent: (category, error, details) => {
      events.push({ category, error, details });
    },
  });

  await handler(new Error("heartbeat failed"), "stale-ctx");

  assert.equal(registrationState.getTarget(), undefined);
  assert.equal(
    events.some(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        (event as { details?: { phase?: string } }).details?.phase ===
          "follower-stale-context-status",
    ),
    true,
  );
});

for (const scenario of ["stable", "session-drift", "session-id-drift", "superseded", "stopped", "startup-drift", "refreshed-during-heartbeat"] as const) {
test(`Registration response retains exact request/session authority (${scenario})`, { timeout: 5000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-registration-authority-"));
  const socketPath = join(dir, "leader.sock");
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const state = createTelegramBusFollowerRegistrationState();
  const ctx = { cwd: "/fixture" };
  let sessionGeneration = 1;
  let sequence = 0;
  let receivingStops = 0;
  let sessionId = "session-before-reply";
  const requests: Array<number | undefined> = [];
  const prepared: number[] = [];
  const server = createTelegramBusLocalServer({ socketPath, async handleEnvelope(envelope) {
    if (envelope.kind === "follower.register") {
      requests.push(envelope.registration.sessionGeneration);
      if (requests.length === 1 && scenario !== "startup-drift" && scenario !== "refreshed-during-heartbeat") {
        entered.resolve(); await released.promise;
      }
    }
    if (envelope.kind === "follower.heartbeat" && scenario === "refreshed-during-heartbeat") {
      entered.resolve(); await released.promise;
    }
    return { kind: "bus.ack", requestId: envelope.requestId, ok: true,
      protocol: TEST_BUS_PROTOCOL_IDENTITY, result: { target: { chatId: 7, threadId: 42 }, slot: "A" } };
  } });
  const runtime = createTelegramBusFollowerRegistrationRuntime({ instanceId: "fixture",
    registrationState: state, protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY,
    createRequestId: () => `fixture:${++sequence}`, getSessionGeneration: () => sessionGeneration,
    getSessionId: () => sessionId,
    isContextActive: current => current === ctx, heartbeatMs: 60_000,
    async startReceiving() { if (scenario === "startup-drift") { entered.resolve(); await released.promise; } },
    stopReceiving: async () => { receivingStops++; },
    onRegistered: () => { prepared.push(sessionGeneration); },
  });
  let first: Promise<boolean> | undefined;
  try {
    await server.start();
    first = runtime.registerWithLeader(ctx, { busSocketPath: socketPath });
    await entered.promise;
    if (scenario === "session-drift" || scenario === "startup-drift") sessionGeneration++;
    if (scenario === "session-id-drift") sessionId = "session-after-reply";
    if (scenario === "stopped") runtime.stop();
    let newerGeneration: string | undefined;
    if (scenario === "refreshed-during-heartbeat") {
      sessionGeneration++;
      await runtime.setContext(ctx);
      newerGeneration = state.getGeneration();
    }
    if (scenario === "superseded") {
      assert.equal(await runtime.registerWithLeader(ctx, { busSocketPath: socketPath }), true);
      newerGeneration = state.getGeneration();
    }
    const stopsBeforeReply = receivingStops;
    released.resolve();
    assert.equal(await first, scenario === "stable", "A late response cannot mint authority for an expired request");
    if (scenario === "superseded" || scenario === "refreshed-during-heartbeat") {
      assert.equal(state.getGeneration(), newerGeneration);
      assert.equal(receivingStops, stopsBeforeReply, "An obsolete request cannot stop the newer receiver");
      assert.deepEqual(prepared, [1]);
    } else {
      assert.equal(state.isRegistered(), scenario === "stable");
      assert.deepEqual(prepared, scenario === "stable" ? [1] : []);
    }
    assert.deepEqual(requests, scenario === "startup-drift" ? [] : scenario === "superseded" ? [1, 1] : [1]);
    if (scenario === "session-drift" || scenario === "session-id-drift") {
      assert.equal(await runtime.registerWithLeader(ctx, { busSocketPath: socketPath }), true);
      assert.deepEqual(prepared, [sessionGeneration]);
      assert.deepEqual(requests, [1, sessionGeneration]);
    }
  } finally {
    released.resolve(); await first?.catch(() => undefined); runtime.stop();
    await server.stop(); rmSync(dir, { recursive: true, force: true });
  }
});
}

test("Follower registration state keeps a relayed Thread capability fresh, generation-bound and registration-scoped", async () => {
  const state = createTelegramBusFollowerRegistrationState();
  state.setRelayedThreadCapability(true, "g1");
  assert.equal(state.getRelayedThreadCapability(), undefined, "Nothing is relayed to an unregistered follower");
  state.setRegistered(true, { chatId: 7, threadId: 42 }, { generation: "g1" });
  state.setRelayedThreadCapability(true, "g0");
  assert.equal(state.getRelayedThreadCapability(), undefined, "A heartbeat answered for another generation is ignored");
  state.setRelayedThreadCapability(true, "g1");
  assert.equal(state.getRelayedThreadCapability(), true);
  state.setRelayedThreadCapability(false, "g1");
  assert.equal(state.getRelayedThreadCapability(), false);
  state.setRelayedThreadCapability(undefined, "g1");
  assert.equal(state.getRelayedThreadCapability(), undefined, "An omitted capability clears the relay so the follower probes again");
  state.setRelayedThreadCapability(true, "g1");
  state.setRegistered(true, { chatId: 7, threadId: 42 }, { generation: "g2" });
  assert.equal(state.getRelayedThreadCapability(), undefined, "A new registration starts without inherited capability");
  const realNow = Date.now;
  try {
    state.setRelayedThreadCapability(true, "g2");
    Date.now = () => realNow() + 6_000;
    assert.equal(state.getRelayedThreadCapability(), undefined, "A relay older than a few heartbeats is stale");
  } finally { Date.now = realNow; }
  state.setRelayedThreadCapability(true, "g2");
  state.setRegistered(false);
  assert.equal(state.getRelayedThreadCapability(), undefined);
});

test("Registration probe reports only a leader acknowledgement of the current generation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-registration-probe-"));
  const socketPath = join(dir, "leader.sock");
  const state = createTelegramBusFollowerRegistrationState();
  const ctx = { cwd: "/fixture" };
  let sequence = 0, mode: "ok" | "rejected" = "ok";
  const heartbeats: Array<string | undefined> = [];
  const server = createTelegramBusLocalServer({ socketPath, async handleEnvelope(envelope) {
    if (envelope.kind === "follower.heartbeat") {
      heartbeats.push(envelope.registrationGeneration);
      if (mode === "rejected") return { kind: "bus.ack", requestId: envelope.requestId, ok: false, message: "Stale Telegram bus follower registration generation." };
    }
    return { kind: "bus.ack", requestId: envelope.requestId, ok: true,
      protocol: TEST_BUS_PROTOCOL_IDENTITY, result: { target: { chatId: 7, threadId: 42 }, slot: "A", threadCapability: true } };
  } });
  const runtime = createTelegramBusFollowerRegistrationRuntime({ instanceId: "fixture",
    registrationState: state, protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY,
    createRequestId: () => `fixture:${++sequence}`, getSessionGeneration: () => 1, getSessionId: () => "session",
    isContextActive: current => current === ctx, heartbeatMs: 60_000,
    async startReceiving() {}, stopReceiving: async () => {}, onRegistered: () => {},
  });
  try {
    await server.start();
    assert.equal(await runtime.probeRegistration!(), false, "Nothing to probe before an acknowledged registration");
    assert.equal(await runtime.registerWithLeader(ctx, { busSocketPath: socketPath }), true);
    const generation = state.getGeneration();
    assert.equal(state.getRelayedThreadCapability(), true, "The registration heartbeat stores the leader-relayed capability");
    const before = heartbeats.length;
    assert.equal(await runtime.probeRegistration!(), true);
    assert.equal(heartbeats.at(-1), generation, "The probe names the current generation");
    assert.equal(heartbeats.length, before + 1);
    assert.equal(state.getGeneration(), generation, "A probe never mints a new generation");
    mode = "rejected";
    assert.equal(await runtime.probeRegistration!(), false, "A rejected generation is not kept");
    assert.equal(state.isRegistered(), true, "Probing never changes registration state by itself");
  } finally {
    runtime.stop(); await server.stop(); rmSync(dir, { recursive: true, force: true });
  }
});

test("Follower assembly keeps same-session refresh stable and requires registration for a changed session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-assembly-"));
  const leaderSocketPath = join(dir, "leader.sock");
  const followerSocketPath = join(dir, "follower.sock");
  const ctx = { cwd: "/repo" };
  let sessionId = "session-a";
  let sessionGeneration = 1;
  const followerRegistry = createTelegramBusFollowerRegistry();
  const registrationState = createTelegramBusFollowerRegistrationState();
  let requestSequence = 0;
  const leader = createTelegramBusLocalServer({
    socketPath: leaderSocketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry,
      protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY,
      provisionFollowerTarget: () => ({ chatId: 7, threadId: 42, slot: "A" }),
    }),
  });
  const assembly = createTelegramBusFollowerRuntimeAssembly<{
    cwd: string;
  }>({
    failureLog: createTelegramFailureRunLog({
      category: "bus",
      failurePhase: "follower-heartbeat",
      outcomePhase: "follower-heartbeat-recovered",
      label: "follower heartbeat",
      record: () => {},
    }),
    instanceId: "inst-a",
    registrationState,
    recordRuntimeEvent: () => undefined,
    receiver: {
      socketPath: followerSocketPath,
      getContext: () => ctx,
      getRecipientBindingKey: () => "manual:inst-a",
      durableAdmission: {
        async admit(envelope) {
          return {
            deliveryId: envelope.delivery!.deliveryId,
            sourceUpdateId: envelope.delivery!.sourceUpdateId,
          };
        },
      },
    },
    recovery: {
      getLeaderState: () => ({ kind: "inactive" }),
      setLifecyclePhase: () => undefined,
      updateStatus: () => undefined,
      promoteToLeader: async () => true,
      sleep: async () => undefined,
      promotionGraceMs: 1,
    },
    registration: {
      protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY,
      getFollowerBusSocketPath: () => followerSocketPath,
      getLeaderSocketPath: () => leaderSocketPath,
      createRequestId: () => `inst-a:${++requestSequence}`,
      getSessionId: () => sessionId,
      getSessionGeneration: () => sessionGeneration,
      isContextActive: current => current === ctx,
    },
  });
  try {
    await leader.start();
    assert.equal(
      await assembly.registration.registerWithLeader(
        ctx,
        { busSocketPath: leaderSocketPath },
      ),
      true,
    );
    if (process.platform === "win32") {
      assert.equal(
        getTelegramBusTransportKind(
          resolveTelegramBusSocketPath(followerSocketPath),
        ),
        "pipe",
      );
    } else {
      assert.equal(
        existsSync(resolveTelegramBusSocketPath(followerSocketPath)),
        true,
      );
    }
    assert.deepEqual(registrationState.getTarget(), {
      chatId: 7,
      threadId: 42,
    });
    assert.equal(registrationState.getSlot(), "A");
    assert.equal(assembly.getReadySessionId(), "session-a");
    const registeredGeneration = registrationState.getGeneration();
    assert.equal(followerRegistry.get("inst-a")?.sessionId, "session-a");
    sessionGeneration++;
    await assembly.registration.setContext(ctx);
    assert.equal(assembly.getReadySessionId(), "session-a");
    assert.equal(registrationState.getGeneration(), registeredGeneration,
      "Same-session refresh does not re-register or replace transport generation");
    sessionId = "session-b";
    assert.equal(assembly.getReadySessionId(), undefined);
    await assert.rejects(async () => assembly.registration.setContext(ctx), /requires acknowledged leader registration/);
    assert.equal(assembly.getReadySessionId(), undefined);
    assert.equal(registrationState.getGeneration(), registeredGeneration);
    assert.equal(followerRegistry.get("inst-a")?.sessionId, "session-a");
    assert.equal(await assembly.registration.registerWithLeader(ctx, { busSocketPath: leaderSocketPath }), true);
    assert.equal(assembly.getReadySessionId(), "session-b");
    assert.equal(followerRegistry.get("inst-a")?.sessionId, "session-b");
    assert.notEqual(registrationState.getGeneration(), registeredGeneration);
  } finally {
    assembly.registration.stop();
    await assembly.receiver.stop();
    await leader.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Follower readiness captures session identity across preparation and reused-context refresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-session-ready-"));
  const leaderSocketPath = join(dir, "leader.sock");
  const followerSocketPath = join(dir, "follower.sock");
  const state = createTelegramBusFollowerRegistrationState();
  const ctx = { cwd: "/repo" };
  let sessionId = "before-startup";
  let sessionGeneration = 1;
  let sequence = 0;
  let admissions = 0;
  let entered = Promise.withResolvers<void>();
  let released = Promise.withResolvers<void>();
  let pausePreparation = true;
  const journals = createTelegramUpdateJournalBindingRuntime({
    base: { getProfileName: () => "work", getBotToken: () => "fixture-session-admission", getBotId: () => 7 },
    getLeaderJournalPath: () => join(dir, "inbox.work.json"),
    getFollowerJournalPath: (key, profileName, id) => id === undefined
      ? resolveTelegramFollowerJournalPath(key, dir, profileName)
      : resolveTelegramSessionJournalPath(id, key, dir, profileName),
    getActiveFollowerBindingKey: () => "manual:session-ready",
    getActiveFollowerSessionId: () => state.getSessionId(sessionId),
    isFollowerRegistered: state.isRegistered,
  });
  const leader = createTelegramBusLocalServer({ socketPath: leaderSocketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: createTelegramBusFollowerRegistry(), protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY,
      provisionFollowerTarget: () => ({ chatId: 7, threadId: 42, slot: "A" }),
    }),
  });
  const assembly = createTelegramBusFollowerRuntimeAssembly({ instanceId: "session-ready", registrationState: state,
    failureLog: createTelegramFailureRunLog({
      category: "bus",
      failurePhase: "follower-heartbeat",
      outcomePhase: "follower-heartbeat-recovered",
      label: "follower heartbeat",
      record: () => {},
    }),
    recordRuntimeEvent: () => {},
    receiver: { socketPath: followerSocketPath, getContext: () => ctx,
      getRecipientBindingKey: () => "manual:session-ready",
      durableAdmission: createTelegramBusFollowerDurableAdmissionRuntime({
        journal: { appendBatch(updates) {
          const binding = journals.resolveFollower();
          if (!binding) throw new Error("Fixture session journal is not prepared");
          binding.journal.appendBatch(updates);
        } },
        signalWorker() { admissions++; },
      }),
    },
    recovery: { getLeaderState: () => ({ kind: "inactive" }), setLifecyclePhase: () => {},
      updateStatus: () => {}, promoteToLeader: async () => false },
    registration: { protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY,
      getFollowerBusSocketPath: () => followerSocketPath, createRequestId: () => `ready:${++sequence}`,
      getProfileKey: () => "manual:session-ready", getSessionId: () => sessionId,
      getSessionGeneration: () => sessionGeneration, isContextActive: current => current === ctx,
      async onRegistered() {
        if (pausePreparation) { entered.resolve(); await released.promise; }
      },
    },
  });
  const send = () => sendTelegramBusLocalEnvelope({ socketPath: followerSocketPath, timeoutMs: 1000,
    envelope: { kind: "leader.forwardMessage", requestId: `input:${++sequence}`,
      recipientInstanceId: "session-ready", recipientRegistrationGeneration: state.getGeneration()!,
      delivery: createTelegramBusFollowerDeliveryIdentity({ kind: "leader.forwardMessage",
        recipientBindingKey: "manual:session-ready", sourceUpdateId: sequence }),
      message: { message_id: sequence, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false },
        text: "session-bound", pi_telegram_source_update_id: sequence }, sentAtMs: 1 },
  }).then(response => response?.kind === "bus.ack" ? response : undefined);
  let registration: Promise<boolean> | undefined;
  let refresh: Promise<void> | undefined;
  try {
    await leader.start();
    registration = assembly.registration.registerWithLeader(ctx, { busSocketPath: leaderSocketPath });
    await entered.promise;
    assert.equal(assembly.getReadySessionId(), undefined);
    sessionId = "session-a";
    released.resolve();
    assert.equal(await registration, false, "An ID changed during preparation cannot finalize registration");
    assert.equal(assembly.getReadySessionId(), undefined);
    assert.equal(state.isRegistered(), false);
    assert.equal(admissions, 0);
    pausePreparation = false;
    assert.equal(await assembly.registration.registerWithLeader(ctx, { busSocketPath: leaderSocketPath }), true);
    assert.equal(assembly.getReadySessionId(), "session-a");
    assert.equal((await send())?.ok, true);
    assert.equal(admissions, 1);
    const originalJournal = journals.createRecipientResolver("manual:session-ready", "session-a")()!;
    const originalSnapshot = originalJournal.journal.read();
    assert.equal(originalSnapshot.entries.length, 1);
    assert.equal(getTelegramUpdateJournalBindingPath(originalJournal.recoveryKey),
      resolveTelegramSessionJournalPath("session-a", "manual:session-ready", dir, "work"));
    entered = Promise.withResolvers<void>();
    released = Promise.withResolvers<void>();
    pausePreparation = true;
    sessionGeneration++;
    refresh = Promise.resolve(assembly.registration.setContext(ctx));
    await entered.promise;
    assert.equal(assembly.getReadySessionId(), undefined);
    sessionId = "session-b";
    released.resolve();
    await refresh;
    assert.equal(assembly.getReadySessionId(), undefined, "Refresh cannot publish an ID captured before an await");
    assert.equal(journals.resolveFollower(), undefined, "Lifecycle lookup cannot select an unacknowledged successor journal");
    assert.equal((await send())?.ok, false);
    assert.equal(admissions, 1);
    await assert.rejects(async () => assembly.registration.setContext(ctx), /requires acknowledged leader registration/);
    pausePreparation = false;
    assert.equal(await assembly.registration.registerWithLeader(ctx, { busSocketPath: leaderSocketPath }), true);
    assert.equal(assembly.getReadySessionId(), "session-b");
    assert.equal((await send())?.ok, true);
    assert.equal(admissions, 2);
    assert.deepEqual(originalJournal.journal.read(), originalSnapshot, "Refresh and successor admission cannot consume old-session custody");
    const successorJournal = journals.resolveFollower()!;
    assert.equal(successorJournal.journal.read().entries.length, 1);
    assert.equal(getTelegramUpdateJournalBindingPath(successorJournal.recoveryKey),
      resolveTelegramSessionJournalPath("session-b", "manual:session-ready", dir, "work"));
    assert.notEqual(successorJournal.recoveryKey, originalJournal.recoveryKey);
    assert.equal(existsSync(resolveTelegramFollowerJournalPath("manual:session-ready", dir, "work")), false,
      "Session-aware admission must not publish a new flat follower inbox");
    assembly.registration.stop();
    assert.equal(assembly.getReadySessionId(), undefined);
  } finally {
    released.resolve();
    await registration?.catch(() => undefined);
    await refresh?.catch(() => undefined);
    assembly.registration.stop();
    await assembly.receiver.stop();
    await leader.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Acknowledged follower session identity survives same-generation metadata but never crosses generations", () => {
  const state = createTelegramBusFollowerRegistrationState();
  const target = { chatId: 7, threadId: 42 };
  assert.equal(state.getSessionId("session-a"), undefined);
  state.setRegistered(true, target, { generation: "generation-a", sessionId: "session-a" });
  assert.equal(state.getSessionId("session-a"), "session-a");
  assert.equal(state.getSessionId("session-b"), undefined);
  assert.equal(state.getSessionId(undefined), undefined);
  state.setRegistered(true, { ...target, threadId: 43 }, { generation: "generation-a", slot: "A" });
  assert.equal(state.getSessionId("session-a"), "session-a", "Restore/rename metadata keeps acknowledged session identity");
  state.setRegistered(true, target, { generation: "generation-b" });
  assert.equal(state.getSessionId("session-a"), undefined, "A new generation cannot inherit an older acknowledgement");
  state.setRegistered(true, target, { generation: "generation-b", sessionId: "session-b" });
  assert.equal(state.getSessionId("session-b"), "session-b");
  state.setRegistered(false);
  assert.equal(state.getSessionId("session-b"), undefined);
});

test("Bus follower registration state tracks successful registration and stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-follower-state-"));
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  const availability: boolean[] = [];
  let state: ReturnType<typeof createTelegramBusFollowerRegistrationState>;
  state = createTelegramBusFollowerRegistrationState({
    onAvailabilityChanged: () => availability.push(state.isRegistered()),
  });
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      provisionFollowerTarget() {
        return {
          chatId: -1007,
          threadId: 42,
          slot: "E",
          threadName: "Ember",
        };
      },
    }),
  });
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => "inst-a:1",
    getNowMs: () => 1000,
    registrationState: state,
  });
  try {
    await server.start();
    assert.equal(state.isRegistered(), false);
    assert.equal(state.getTarget(), undefined);
    assert.equal(
      await follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
      true,
    );
    assert.equal(state.isRegistered(), true);
    assert.deepEqual(state.getTarget(), { chatId: -1007, threadId: 42 });
    assert.equal(state.getSlot(), "E");
    assert.equal(state.getThreadName(), "Ember");
    follower.stop();
    assert.equal(state.isRegistered(), false);
    assert.equal(state.getTarget(), undefined);
    assert.equal(state.getSlot(), undefined);
    assert.equal(state.getThreadName(), undefined);
    assert.deepEqual(availability, [true, false]);
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Native registration carries explicit connect recovery but never adds it to restore-only or automatic registration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-connect-recovery-wire-"));
  const socketPath = join(dir, "bus.sock"), flags: boolean[] = [];
  const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "recovery",
    capabilities: [...TEST_BUS_PROTOCOL_IDENTITY.capabilities, TELEGRAM_BUS_CAPABILITY_CONNECT_RECOVERY] });
  const registry = createTelegramBusFollowerRegistry();
  const server = createTelegramBusLocalServer({ socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({ followerRegistry: registry,
      protocolIdentity: protocol, authSecret: "secret",
      provisionFollowerTarget(_registration, options) {
        flags.push(options?.recoverConnection === true);
        return { chatId: 7, threadId: 42, slot: "A" };
      },
    }),
  });
  let request = 0;
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "follower", createRequestId: () => `register-${++request}`, protocolIdentity: protocol,
    registrationState: createTelegramBusFollowerRegistrationState(),
  });
  try {
    await server.start();
    const ctx = { cwd: "/repo" }, leader = { busSocketPath: socketPath, busSecret: "secret" };
    assert.equal(await follower.registerWithLeader(ctx, leader), true);
    assert.equal(await follower.registerWithLeader(ctx, leader, { recoverConnection: true }), true);
    assert.equal(await follower.registerWithLeader(ctx, leader, { restoreWorkspace: true, recoverConnection: true }), true);
    assert.deepEqual(flags, [false, true, false]);
  } finally { follower.stop(); await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("Bus follower restore-only registration exits quietly without a remembered Workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-auto-connect-"));
  const socketPath = join(dir, "bus.sock");
  let restoreOnly = false;
  const reasons: string[] = [];
  const registry = createTelegramBusFollowerRegistry();
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      provisionFollowerTarget(_registration, options) {
        restoreOnly = options?.existingWorkspaceBindingOnly === true;
        return undefined;
      },
    }),
  });
  const state = createTelegramBusFollowerRegistrationState();
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => "inst-a:restore:1",
    registrationState: state,
    recordRuntimeEvent(_category, _message, details) {
      if (typeof details?.reason === "string") reasons.push(details.reason);
    },
  });
  try {
    await server.start();
    assert.equal(
      await follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
        { restoreWorkspace: true },
      ),
      false,
    );
    assert.equal(restoreOnly, true);
    assert.deepEqual(reasons, ["leader-binding-unavailable"]);
    assert.equal(state.isRegistered(), false);
    assert.equal(registry.get("inst-a"), undefined);
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Restore-only registration carries its acknowledged title before the first heartbeat without allocating missing Workspaces", { timeout: 5000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-display-auto-connect-"));
  const socketPath = join(dir, "bus.sock");
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json"), getNowMs: () => 1000 });
  store.upsertWorkspaceBinding({
    ...createTelegramWorkspaceBindingIdentity("/repo", 0, "test-session")!,
    target: { chatId: 7, threadId: 42 }, slot: "A", threadName: "Anchor",
    displayTitle: "repo_a", updatedAtMs: 1 });
  const calls: string[] = [];
  let syncState = {};
  const provisionFollowerTarget = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7, topicTargetStore: store,
    async callApi<TResponse>(method: string) {
      calls.push(method);
      if (method === "createForumTopic") throw new Error("restore-only startup must not create a Thread");
      return { ok: true } as TResponse;
    },
    getSyncState: () => syncState, setSyncState(state) { syncState = state; },
    recordRuntimeEvent() {}, getNowMs: () => 1000,
  });
  const registry = createTelegramBusFollowerRegistry();
  const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "test",
    capabilities: [...TEST_BUS_PROTOCOL_IDENTITY.capabilities, TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE] });
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry, protocolIdentity: protocol,
      getThreadDisplayMode: () => "directories", provisionFollowerTarget,
      getFollowerDisplayTitle(follower) {
        return store.listWorkspaceBindings().find((binding) =>
          binding.target.chatId === follower.target?.chatId &&
          binding.target.threadId === follower.target?.threadId,
        )?.displayTitle;
      },
    }),
  });
  const state = createTelegramBusFollowerRegistrationState();
  let titleAtRegistration: string | undefined;
  let sequence = 0;
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "reopened", protocolIdentity: protocol,
    createRequestId: () => `reopened:${++sequence}`, registrationState: state,
    heartbeatMs: 60_000,
    onRegistered() { titleAtRegistration = state.getDisplayTitle(); },
  });
  const missingState = createTelegramBusFollowerRegistrationState();
  const missing = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "missing", protocolIdentity: protocol,
    createRequestId: () => `missing:${++sequence}`, registrationState: missingState,
  });
  try {
    await store.persist();
    await server.start();
    assert.equal(await follower.registerWithLeader({ cwd: "/repo/" }, { busSocketPath: socketPath },
      { restoreWorkspace: true }), true);
    assert.equal(titleAtRegistration, "repo_a");
    assert.equal(state.getThreadName(), "Anchor");
    assert.equal(state.getDisplayTitle(), "repo_a");
    assert.deepEqual(state.getTarget(), { chatId: 7, threadId: 42 });
    assert.equal(state.getSlot(), "A");
    assert.equal(await missing.registerWithLeader({ cwd: "/missing" }, { busSocketPath: socketPath },
      { restoreWorkspace: true }), false);
    assert.equal(missingState.isRegistered(), false);
    assert.equal(store.hasWorkspaceBinding("/missing"), false);
    assert.equal(registry.get("missing"), undefined);
    assert.deepEqual(calls, ["sendMessage"]);
  } finally {
    follower.stop(); missing.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Heartbeat ACK carries display titles without changing the follower's stable name", { timeout: 5000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-display-heartbeat-"));
  const socketPath = join(dir, "bus.sock");
  const state = createTelegramBusFollowerRegistrationState();
  let shown!: () => void;
  const updated = new Promise<void>((resolve) => { shown = resolve; });
  let displayTitle: string | undefined;
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: createTelegramBusFollowerRegistry(),
      provisionFollowerTarget: () => ({ chatId: 7, threadId: 42, slot: "A", threadName: "Anchor" }),
      getFollowerDisplayTitle: () => displayTitle,
    }),
  });
  let sequence = 0;
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => `inst-a:${++sequence}`,
    registrationState: state,
    heartbeatMs: 5,
    onDisplayTitleChanged() {
      shown();
      throw new Error("UI unavailable");
    },
  });
  try {
    await server.start();
    await follower.registerWithLeader({ cwd: "/repo" }, { busSocketPath: socketPath });
    displayTitle = "extensions_a";
    await updated;
    assert.equal(state.getDisplayTitle(), "extensions_a");
    assert.equal(state.getThreadName(), "Anchor");
    assert.equal(state.isRegistered(), true);
    assert.equal(state.setDisplayTitle("obsolete", "wrong-generation"), false);
    assert.equal(state.getDisplayTitle(), "extensions_a");
    follower.stop();
    assert.equal(state.getDisplayTitle(), undefined);
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const changedTarget of [false, true]) {
  test(`Heartbeat title ACK stays bound to its captured target (${changedTarget ? "rebound" : "same-target"})`, { timeout: 5000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-telegram-title-target-fence-")), socketPath = join(dir, "bus.sock");
    const state = createTelegramBusFollowerRegistrationState();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let title: string | undefined, refreshed = 0, sequence = 0;
    const handle = createTelegramBusLeaderEnvelopeHandler({ followerRegistry: createTelegramBusFollowerRegistry(),
      provisionFollowerTarget: () => ({ chatId: 7, threadId: 42, slot: "S", threadName: "Signal" }),
      getFollowerDisplayTitle: () => title });
    const server = createTelegramBusLocalServer({ socketPath, async handleEnvelope(envelope) {
      if (envelope.kind !== "follower.heartbeat") return handle(envelope);
      title = "Signal";
      const response = await handle(envelope); entered.resolve(); await release.promise;
      return response;
    } });
    const follower = createTelegramBusFollowerRegistrationRuntime({ instanceId: "follower", registrationState: state,
      createRequestId: () => `title:${++sequence}`, heartbeatMs: 60_000, onDisplayTitleChanged() { refreshed++; } });
    let connecting: Promise<boolean> | undefined;
    try {
      await server.start();
      connecting = follower.registerWithLeader({ cwd: "/repo" }, { busSocketPath: socketPath });
      await entered.promise;
      if (changedTarget) {
        const generation = state.getGeneration(); assert.ok(generation);
        state.setRegistered(true, { chatId: 7, threadId: 43 }, { slot: "S", threadName: "Signal", generation });
        assert.equal(state.setDisplayTitle("Home", generation), true);
      }
      release.resolve(); assert.equal(await connecting, true, "A healthy old-target heartbeat is not a transport failure");
      assert.equal(state.getDisplayTitle(), changedTarget ? "Home" : "Signal");
      assert.equal(refreshed, changedTarget ? 0 : 1);
      assert.equal(state.getThreadName(), "Signal"); assert.equal(state.isRegistered(), true);
    } finally {
      release.resolve(); await connecting?.catch(() => undefined); follower.stop(); await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("Follower display setting requests negotiate capability and reject lost leader authority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-display-setting-ipc-"));
  const socketPath = join(dir, "bus.sock");
  const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "test",
    capabilities: [...TEST_BUS_PROTOCOL_IDENTITY.capabilities, TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE] });
  let epoch = 1;
  const modes: string[] = [];
  const server = createTelegramBusLocalServer({ socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      protocolIdentity: protocol,
      followerRegistry: createTelegramBusFollowerRegistry(),
      getCurrentLeaderEpoch: () => epoch,
      provisionFollowerTarget: () => ({ chatId: 7, threadId: 42, slot: "A" }),
      async applyThreadDisplayMode(mode, isCurrent) {
        assert.equal(isCurrent(), true);
        modes.push(mode);
        if (mode === "names") epoch++;
      },
    }),
  });
  const state = createTelegramBusFollowerRegistrationState();
  let sequence = 0;
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "follower", protocolIdentity: protocol, registrationState: state,
    createRequestId: () => `follower:${++sequence}`,
  });
  try {
    await server.start();
    await follower.registerWithLeader({ cwd: "/repo" }, { busSocketPath: socketPath });
    await follower.setThreadDisplayMode?.("letters");
    assert.deepEqual(modes, ["letters"]);
    await assert.rejects(follower.setThreadDisplayMode!("names"), /stale registration/);
    state.setRegistered(true, state.getTarget(), {
      generation: state.getGeneration(), leaderProtocol: TEST_BUS_PROTOCOL_IDENTITY,
    });
    await assert.rejects(follower.setThreadDisplayMode!("letters"), /do not support/);
    assert.deepEqual(modes, ["letters", "names"]);
  } finally {
    follower.stop(); await server.stop(); rmSync(dir, { recursive: true, force: true });
  }
});

test("Registration title admission rejects malformed titles and requires target and generation", () => {
  const state = createTelegramBusFollowerRegistrationState();
  const target = { chatId: 7, threadId: 42 };
  for (const displayTitle of ["", "  ", "x".repeat(129)]) {
    state.setRegistered(true, target, { generation: "one", displayTitle });
    assert.equal(state.getDisplayTitle(), undefined);
  }
  state.setRegistered(true, target, { displayTitle: "repo" });
  assert.equal(state.getDisplayTitle(), undefined);
  state.setRegistered(true, undefined, { generation: "one", displayTitle: "repo" });
  assert.equal(state.getDisplayTitle(), undefined);
  state.setRegistered(true, target, { generation: "one", displayTitle: "repo", threadName: "Anchor" });
  assert.equal(state.getDisplayTitle(), "repo");
  assert.equal(state.getThreadName(), "Anchor");
  state.setRegistered(false);
  assert.equal(state.getDisplayTitle(), undefined);
});

test("Follower metadata refresh keeps the display title only within one target and generation", () => {
  const state = createTelegramBusFollowerRegistrationState();
  const target = { chatId: 7, threadId: 42 };
  state.setRegistered(true, target, { generation: "one", threadName: "Anchor" });
  assert.equal(state.setDisplayTitle("repo_a", "one"), true);
  state.setRegistered(true, target, { generation: "one", threadName: "Navigator" });
  assert.equal(state.getDisplayTitle(), "repo_a");
  assert.equal(state.getThreadName(), "Navigator");
  state.setRegistered(true, target, { generation: "two", threadName: "Navigator" });
  assert.equal(state.getDisplayTitle(), undefined);
  state.setDisplayTitle("repo_a", "two");
  state.setRegistered(true, { chatId: 7, threadId: 43 }, { generation: "two", threadName: "Navigator" });
  assert.equal(state.getDisplayTitle(), undefined);
});

test("Bus follower re-registration carries its last known target", async () => {
  const dir = mkdtempSync(
    join(tmpdir(), "pi-telegram-follower-reload-target-"),
  );
  const socketPath = join(dir, "bus.sock");
  const state = createTelegramBusFollowerRegistrationState();
  const registrations: Array<{
    target?: unknown;
    slot?: string;
    threadName?: string;
  }> = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: createTelegramBusFollowerRegistry(),
      provisionFollowerTarget(registration) {
        registrations.push({
          target: registration.target,
          slot: registration.slot,
          threadName: registration.threadName,
        });
        return {
          chatId: 7,
          threadId: 42,
          slot: "E",
          threadName: "Ember",
        };
      },
    }),
  });
  let requestSequence = 0;
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => `inst-a:reload:${++requestSequence}`,
    registrationState: state,
  });
  try {
    await server.start();
    assert.equal(
      await follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
      true,
    );
    state.setRegistered(false);
    assert.equal(
      await follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
      true,
    );
    assert.deepEqual(registrations, [
      { target: undefined, slot: undefined, threadName: "repo" },
      {
        target: { chatId: 7, threadId: 42 },
        slot: "E",
        threadName: "Ember",
      },
    ]);
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registration runtime retries while leader endpoint is starting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-follower-retry-"));
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  const state = createTelegramBusFollowerRegistrationState();
  const events: Array<Record<string, unknown> | undefined> = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      provisionFollowerTarget() {
        return { chatId: -1007, threadId: 42, slot: "A" };
      },
    }),
  });
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => "inst-a:1",
    getNowMs: () => 1000,
    registrationState: state,
    registrationTimeoutMs: 50,
    registrationRetryAttempts: 10,
    registrationRetryDelayMs: 10,
    recordRuntimeEvent(_category, _error, details) {
      events.push(details);
    },
  });
  try {
    setTimeout(() => {
      void server.start();
    }, 25);
    assert.equal(
      await follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
      true,
    );
    assert.equal(state.isRegistered(), true);
    assert.deepEqual(state.getTarget(), { chatId: -1007, threadId: 42 });
    assert.equal(
      events.some((event) => event?.phase === "follower-register-client-retry"),
      true,
    );
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registration runtime waits for slow target provisioning", async () => {
  const dir = mkdtempSync(
    join(tmpdir(), "pi-telegram-bus-follower-slow-register-"),
  );
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  const state = createTelegramBusFollowerRegistrationState();
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      async provisionFollowerTarget() {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { chatId: -1007, threadId: 42, slot: "A" };
      },
    }),
  });
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => "inst-a:1",
    getNowMs: () => 1000,
    registrationState: state,
    timeoutMs: 20,
    registrationTimeoutMs: 250,
  });
  try {
    await server.start();
    assert.equal(
      await follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
      true,
    );
    assert.equal(state.isRegistered(), true);
    assert.deepEqual(state.getTarget(), { chatId: -1007, threadId: 42 });
    assert.deepEqual(registry.get("inst-a")?.target, {
      chatId: -1007,
      threadId: 42,
      slot: "A",
    });
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registration survives a fresh same-session context object", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-follower-context-"));
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  let releaseProvision: (() => void) | undefined;
  const provisioning = new Promise<void>((resolve) => {
    releaseProvision = resolve;
  });
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      async provisionFollowerTarget() {
        await provisioning;
        return { chatId: -1007, threadId: 42, slot: "A" };
      },
    }),
  });
  const sessionCtx = { cwd: "/repo" };
  const state = createTelegramBusFollowerRegistrationState();
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => "inst-a:context:1",
    getNowMs: () => 1000,
    registrationState: state,
    getSessionId: () => "session-a",
    getSessionGeneration: () => 7,
    registrationTimeoutMs: 250,
  });
  try {
    await server.start();
    const registration = follower.registerWithLeader(sessionCtx, {
      busSocketPath: socketPath,
    });
    await new Promise((resolve) => setImmediate(resolve));
    // Pi hands every event a fresh context object for the same session.
    follower.setContext({ ...sessionCtx });
    releaseProvision?.();
    assert.equal(
      await registration,
      true,
      "A fresh event context of the same session must not cancel an in-flight registration",
    );
    assert.equal(state.isRegistered(), true);
    assert.deepEqual(state.getTarget(), { chatId: -1007, threadId: 42 });
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registration abandons an attempt when its session is replaced", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-follower-session-replaced-"));
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  let releaseProvision: (() => void) | undefined;
  const provisioning = new Promise<void>((resolve) => {
    releaseProvision = resolve;
  });
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      async provisionFollowerTarget() {
        await provisioning;
        return { chatId: -1007, threadId: 42, slot: "A" };
      },
    }),
  });
  const sessionCtx = { cwd: "/repo" };
  let sessionId = "session-a";
  const state = createTelegramBusFollowerRegistrationState();
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => "inst-a:replaced:1",
    getNowMs: () => 1000,
    registrationState: state,
    getSessionId: () => sessionId,
    getSessionGeneration: () => 7,
    registrationTimeoutMs: 250,
  });
  try {
    await server.start();
    const registration = follower.registerWithLeader(sessionCtx, {
      busSocketPath: socketPath,
    });
    await new Promise((resolve) => setImmediate(resolve));
    sessionId = "session-b";
    follower.setContext({ cwd: "/repo" });
    releaseProvision?.();
    assert.equal(await registration, false);
    assert.equal(state.isRegistered(), false);
    // The leader may already hold the completed registration; this process must not adopt it as its binding.
    assert.equal(state.getTarget(), undefined);
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const threaded of [false, true])
for (const fault of ["known", "fresh-context", "same-generation", "stop", "session", "session-generation", "profile", "cwd", "birth", "pid", "endpoint", "leader-endpoint", "auth",
  "reader", "reader-during-registration", "state-reader", "protocol", "peer-protocol", "reentry", "read-error", "callout-owner-change", "availability-reentry", "no-birth", "no-endpoint", "no-incarnation", "wrong-ack", "no-local-cap", "no-peer-cap"] as const)
test(`Attachment acknowledged registration retains native local lifetime (Thread=${threaded}, ${fault})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-attachment-reg-")), socketPath = join(dir, "bus.sock"), target = { chatId: 7, ...(threaded ? { threadId: 11 } : {}) };
  const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "0.58.3", capabilities: fault === "no-local-cap" ? [] : [TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION] });
  const peer = createTelegramBusProtocolIdentity({ runtimeBuild: "0.58.3", capabilities: fault === "no-peer-cap" ? [] : [TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION] });
  const registry = createTelegramBusFollowerRegistry(); let reentered = false;
  const state = createTelegramBusFollowerRegistrationState({ onAvailabilityChanged() {
    if (fault === "availability-reentry" && !reentered) { reentered = true; state.setRegistered(true, target, { generation: "g1", sessionId: "s1", leaderProtocol: peer, ...(threaded ? { slot: "A" } : {}) }); }
  } });
  const handler = createRawTelegramBusLeaderEnvelopeHandler({ followerRegistry: registry, protocolIdentity: peer, authSecret: "secret",
    provisionFollowerTarget: () => ({ ...target, ...(threaded ? { slot: "A" } : {}) }) });
  const server = createRawTelegramBusLocalServer({ socketPath, async handleEnvelope(envelope) {
    const response = await handler(envelope);
    if (envelope.kind === "follower.register" && response?.kind === "bus.ack" && response.ok) {
      if (fault === "wrong-ack") response.requestId = "wrong";
      if (fault === "no-incarnation" && response.result && typeof response.result === "object") delete (response.result as Record<string, unknown>).registrationIncarnation;
    }
    return response;
  } });
  let birth = "birth", endpoint = join(dir, "receiver.sock"), session = "s1", generation = 1,
    profile = "manual:attachment", pid = 123, auth: string | undefined = "secret", reenter = false, readError = false, mutateOwner = false, swappedReader = false, sequence = 0;
  const ctx = { cwd: "/repo" }, leader = { busSocketPath: socketPath, busSecret: "secret" };
  let captured: ReturnType<NonNullable<ReturnType<typeof createTelegramBusFollowerRegistrationRuntime>['captureAttachmentPublicationRegistration']>>;
  const deps = { instanceId: "consumer", createRequestId: () => `g${++sequence}`, registrationState: state, protocolIdentity: protocol,
    getSessionId: () => session, getSessionGeneration: () => generation,
    ...(fault === "no-birth" ? {} : { getProcessBirthId: () => { if (readError) throw new Error("native read failed"); return birth; } }),
    getPid: () => pid, ...(fault === "no-endpoint" ? {} : { getFollowerBusSocketPath: () => endpoint }), getLeaderAuthSecret: () => auth,
    getProfileKey: () => { if (reenter) { try { captured?.assertCurrent(); } catch {} } if (mutateOwner) deps.instanceId = "other";
      if (fault === "reader-during-registration" && !swappedReader) { swappedReader = true; deps.getPid = () => pid; } return profile; },
    registrationRetryAttempts: 1, heartbeatMs: 60_000 };
  const runtime = createRawTelegramBusFollowerRegistrationRuntime(deps);
  try {
    await server.start();
    const registration = runtime.registerWithLeader(ctx, leader);
    if (fault === "wrong-ack") {
      await assert.rejects(registration, /registration acknowledgement is unconfirmed/u);
      assert.equal(state.isRegistered(), false); assert.equal(runtime.captureAttachmentPublicationRegistration?.(), undefined); return;
    }
    assert.equal(await registration, true);
    captured = runtime.captureAttachmentPublicationRegistration?.();
    const absent = ["availability-reentry", "reader-during-registration", "no-birth", "no-endpoint", "no-incarnation", "no-local-cap", "no-peer-cap"].includes(fault);
    if (absent) { assert.equal(captured, undefined); return; }
    assert.ok(captured); captured.assertCurrent();
    assert.equal(captured.registration.registrationGeneration, "g1"); assert.equal(captured.registration.sessionId, "s1");
    assert.equal(captured.registration.processBirthId, "birth"); assert.equal(captured.registration.busSocketPath, endpoint);
    assert.equal(captured.registration.pid, 123); assert.equal(captured.leaderSocketPath, socketPath);
    assert.equal(captured.registrationIncarnation, registry.get("consumer")?.registrationIncarnation);
    assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured.registration) && Object.isFrozen(captured.registration.target) &&
      Object.isFrozen(captured.registration.protocol?.capabilities) && Object.isFrozen(captured.leaderProtocol.capabilities));
    assert.throws(() => { captured!.registration.target!.chatId = 99; }, TypeError);
    if (fault === "known" || fault === "fresh-context") {
      if (fault === "fresh-context") runtime.setContext({ cwd: "/repo" });
      captured.assertCurrent(); assert.equal(runtime.captureAttachmentPublicationRegistration?.(), captured); return;
    }
    const restore: Array<() => void> = [];
    if (fault === "same-generation") state.setRegistered(true, target, { generation: "g1", sessionId: "s1", leaderProtocol: peer,
      registrationIncarnation: captured.registrationIncarnation, ...(threaded ? { slot: "A" } : {}) });
    if (fault === "stop") runtime.stop();
    if (fault === "session") { session = "s2"; restore.push(() => { session = "s1"; }); }
    if (fault === "session-generation") { generation++; restore.push(() => { generation--; }); }
    if (fault === "profile") { profile = "other"; restore.push(() => { profile = "manual:attachment"; }); }
    if (fault === "cwd") { ctx.cwd = "/other"; restore.push(() => { ctx.cwd = "/repo"; }); }
    if (fault === "birth") { birth = "other"; restore.push(() => { birth = "birth"; }); }
    if (fault === "pid") { pid++; restore.push(() => { pid--; }); }
    if (fault === "endpoint") { endpoint += "other"; restore.push(() => { endpoint = join(dir, "receiver.sock"); }); }
    if (fault === "leader-endpoint") { leader.busSocketPath += "other"; restore.push(() => { leader.busSocketPath = socketPath; }); }
    if (fault === "auth") { auth = undefined; restore.push(() => { auth = "secret"; }); }
    if (fault === "reader") { const original = deps.getPid; deps.getPid = () => pid; restore.push(() => { deps.getPid = original; }); }
    if (fault === "state-reader") { const original = state.getTarget; state.getTarget = () => target; restore.push(() => { state.getTarget = original; }); }
    if (fault === "protocol") { protocol.capabilities = []; restore.push(() => { protocol.capabilities = [TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION]; }); }
    if (fault === "peer-protocol") state.setRegistered(true, target, { generation: "g1", sessionId: "s1", leaderProtocol: createTelegramBusProtocolIdentity({ runtimeBuild: "0.58.3" }) });
    if (fault === "reentry") { reenter = true; restore.push(() => { reenter = false; }); }
    if (fault === "read-error") { readError = true; restore.push(() => { readError = false; }); }
    if (fault === "callout-owner-change") { mutateOwner = true; restore.push(() => { mutateOwner = false; deps.instanceId = "consumer"; }); }
    assert.throws(captured.assertCurrent); for (const reset of restore) reset();
    assert.throws(captured.assertCurrent, /registration is unavailable/); assert.equal(runtime.captureAttachmentPublicationRegistration?.(), undefined);
    if (fault === "same-generation") {
      assert.equal(await runtime.registerWithLeader(ctx, leader), true);
      const replacement = runtime.captureAttachmentPublicationRegistration?.(); assert.ok(replacement && replacement !== captured);
      replacement.assertCurrent(); assert.throws(captured.assertCurrent, /registration is unavailable/);
    }
  } finally { runtime.stop(); await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("Bus follower registration runtime registers and explicitly disconnects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-follower-"));
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  const leaderProtocol = createTelegramBusProtocolIdentity({
    runtimeBuild: "0.28.0",
    capabilities: [TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME],
  });
  const followerProtocol = createTelegramBusProtocolIdentity({
    runtimeBuild: "0.28.1",
    capabilities: [TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME],
  });
  const registrationState = createTelegramBusFollowerRegistrationState();
  let disconnects = 0;
  const renames: string[] = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      protocolIdentity: leaderProtocol,
      getNowMs: () => 1000,
      provisionFollowerTarget() {
        return { chatId: 7, threadId: 42, slot: "A" };
      },
      onFollowerDisconnected() {
        disconnects += 1;
      },
      renameFollowerThread(_follower, threadName) {
        renames.push(threadName);
        return { threadName };
      },
      resetFollowerThreadName() {
        return { threadName: "A" };
      },
    }),
  });
  let sequence = 0;
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => `inst-a:${++sequence}`,
    protocolIdentity: followerProtocol,
    registrationState,
    getNowMs: () => 1000,
    getPid: () => 123,
    getProcessBirthId: () => "123:start:abc",
    getSessionId: () => "session-a",
    getSessionGeneration: () => 4,
  });
  try {
    await server.start();
    assert.equal(
      await follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
      true,
    );
    assert.deepEqual(registry.get("inst-a"), {
      instanceId: "inst-a",
      profileKey: "cwd:/repo",
      threadName: "repo",
      cwd: "/repo",
      sessionId: "session-a",
      pid: 123,
      processBirthId: "123:start:abc",
      sessionGeneration: 4,
      registrationGeneration: "inst-a:1",
      protocol: followerProtocol,
      connectedAtMs: 1000,
      lastHeartbeatMs: 1000,
      registrationIncarnation: registry.get("inst-a")?.registrationIncarnation,
      target: { chatId: 7, threadId: 42, slot: "A" },
      slot: "A",
    });
    assert.deepEqual(registrationState.getLeaderProtocol(), leaderProtocol);
    assert.equal(await follower.renameThread?.(
      { chatId: 7, threadId: 42 }, "Navigator",
    ), "Navigator");
    assert.deepEqual(renames, ["Navigator"]);
    assert.equal(registry.get("inst-a")?.threadName, "Navigator");
    assert.equal(registrationState.getThreadName(), "Navigator");
    assert.equal(await follower.resetThreadName?.(
      { chatId: 7, threadId: 42 },
    ), "A");
    assert.equal(registry.get("inst-a")?.threadName, "A");
    assert.equal(registrationState.getThreadName(), "A");
    assert.equal(await follower.disconnectFromLeader?.(), true);
    assert.equal(disconnects, 1);
    assert.equal(registry.get("inst-a"), undefined);
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const outcome of ["success", "refused", "incompatible", "identityless"] as const) for (const matching of [true, false])
test(`Registration admission requires its original bootstrap ACK (${outcome}/${matching ? "matching" : "foreign"})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-bootstrap-origin-")), socketPath = join(dir, "bus.sock"), state = createTelegramBusFollowerRegistrationState();
  state.setRegistered(true, { chatId: 7, threadId: 41 }, { generation: "previous", leaderProtocol: TEST_BUS_PROTOCOL_IDENTITY });
  const previous = state.capturePublicationRegistration!()!;
  let admitted = 0, requests = 0, receiverStops = 0, auth: string | undefined;
  const server = createRawTelegramBusLocalServer({ socketPath, handleEnvelope(envelope) {
    assert.equal(envelope.kind, "follower.register"); requests++;
    const protocol = outcome === "incompatible" ? { ...TEST_BUS_PROTOCOL_IDENTITY, protocolVersion: 1 } : TEST_BUS_PROTOCOL_IDENTITY;
    return { kind: "bus.ack", requestId: matching ? envelope.requestId : "foreign-registration", ok: outcome === "success" || outcome === "incompatible",
      ...(outcome === "identityless" ? {} : { protocol }), message: "Original broker refusal", result: { target: { chatId: 7, threadId: 42 }, slot: "A", registrationIncarnation: "a".repeat(48) } };
  } });
  const runtime = createTelegramBusFollowerRegistrationRuntime({ instanceId: "source", registrationState: state, createRequestId: () => "original-registration",
    getSessionGeneration: () => 1, getSessionId: () => "session", getLeaderAuthSecret: () => "original-secret", heartbeatMs: 60000,
    setActiveAuthSecret(value) { auth = value; }, onRegistered() { admitted++; }, async stopReceiving() { receiverStops++; } });
  const call = createTelegramBusFollowerApiCaller({ socketPath, instanceId: "source", getAuthSecret: () => auth, getRegistrationGeneration: state.getGeneration,
    getLocalProtocol: () => TEST_BUS_PROTOCOL_IDENTITY, getLeaderProtocol: state.getLeaderProtocol, capturePublicationRegistration: state.capturePublicationRegistration,
    createRequestId() { assert.fail("Inspecting a birth cannot issue API calls"); } });
  try {
    await server.start();
    const pending = runtime.registerWithLeader({ cwd: "/repo" }, { busSocketPath: socketPath });
    if (matching && outcome === "success") {
      assert.equal(await pending, true); assert.equal(state.isRegistered(), true); assert.equal(state.getGeneration(), "original-registration"); assert.equal(admitted, 1);
    } else {
      await assert.rejects(pending, !matching ? /registration acknowledgement is unconfirmed/u : outcome === "incompatible" ? /version-mismatch/u : /Original broker refusal/u);
      assert.equal(admitted, 0); assert.equal(state.isRegistered(), false); assert.equal(state.getGeneration(), undefined); assert.equal(auth, undefined); assert.equal(receiverStops, 1);
      assert.equal(call.captureAuthority(), undefined, "A foreign bootstrap cannot mint a native API birth");
    }
    assert.equal(previous.isCurrent(), false); assert.equal(requests, 1, "An unrelated reply is not permission to replay registration");
  } finally { runtime.stop(); await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

for (const matching of [true, false])
test(`Restore-only bootstrap refusal belongs to the original request (${matching ? "matching" : "foreign"})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-restore-bootstrap-")), socketPath = join(dir, "bus.sock"), state = createTelegramBusFollowerRegistrationState();
  let admitted = 0, requests = 0;
  const server = createRawTelegramBusLocalServer({ socketPath, handleEnvelope(envelope) {
    assert.equal(envelope.kind, "follower.restoreWorkspace"); requests++;
    return { kind: "bus.ack", requestId: matching ? envelope.requestId : "foreign-restore", ok: false, protocol: TEST_BUS_PROTOCOL_IDENTITY,
      error: { code: "workspace-binding-unavailable" }, message: "Known binding unavailable" };
  } });
  const runtime = createTelegramBusFollowerRegistrationRuntime({ instanceId: "source", registrationState: state, createRequestId: () => "original-restore", onRegistered() { admitted++; } });
  try {
    await server.start();
    const work = runtime.registerWithLeader({ cwd: "/repo" }, { busSocketPath: socketPath }, { restoreWorkspace: true });
    if (matching) assert.equal(await work, false);
    else await assert.rejects(work, /registration acknowledgement is unconfirmed/u);
    assert.equal(state.isRegistered(), false); assert.equal(admitted, 0); assert.equal(requests, 1);
  } finally { runtime.stop(); await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("Registration admission refuses a matching control-plane frame before protocol semantics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-bootstrap-kind-")), socketPath = join(dir, "bus.sock"), state = createTelegramBusFollowerRegistrationState();
  const server = createRawTelegramBusLocalServer({ socketPath, handleEnvelope: envelope => ({ kind: "bus.probe", requestId: envelope.requestId }) });
  const runtime = createTelegramBusFollowerRegistrationRuntime({ instanceId: "source", registrationState: state, createRequestId: () => "original" });
  try {
    await server.start();
    await assert.rejects(runtime.registerWithLeader({ cwd: "/repo" }, { busSocketPath: socketPath }), /registration acknowledgement is unconfirmed/u);
    assert.equal(state.isRegistered(), false);
  } finally { runtime.stop(); await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("Bus follower rejects an acknowledgement without protocol identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-follower-protocol-"));
  const socketPath = join(dir, "bus.sock");
  const server = createRawTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: true,
    }),
  });
  const state = createTelegramBusFollowerRegistrationState();
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => "inst-a:1",
    protocolIdentity: createTelegramBusProtocolIdentity({
      runtimeBuild: "0.28.0",
    }),
    registrationState: state,
    getNowMs: () => 1000,
  });
  try {
    await server.start();
    await assert.rejects(
      follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
      /missing-identity/u,
    );
    assert.equal(state.isRegistered(), false);
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower reports an identity-less rejection as the rejection, not a protocol mismatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-follower-rejection-"));
  const socketPath = join(dir, "bus.sock");
  const server = createRawTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({ kind: "bus.ack", requestId: envelope.requestId, ok: false,
      message: "Telegram bus handler failed." }),
  });
  const state = createTelegramBusFollowerRegistrationState();
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a", createRequestId: () => "inst-a:1",
    protocolIdentity: createTelegramBusProtocolIdentity({ runtimeBuild: "0.28.0" }),
    registrationState: state, getNowMs: () => 1000,
  });
  try {
    await server.start();
    await assert.rejects(follower.registerWithLeader({ cwd: "/repo" }, { busSocketPath: socketPath }),
      (error: unknown) => error instanceof Error && error.message === "Telegram bus handler failed.");
    assert.equal(state.isRegistered(), false);
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower rejects a pre-session protocol leader", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-follower-capability-"));
  const socketPath = join(dir, "bus.sock");
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: true,
      protocol: {
        protocolVersion: 1,
        runtimeBuild: "0.45.11",
        capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION],
      },
    }),
  });
  const state = createTelegramBusFollowerRegistrationState();
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => "inst-a:1",
    protocolIdentity: createTelegramBusProtocolIdentity({
      runtimeBuild: "0.28.0",
      capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION],
    }),
    registrationState: state,
  });
  try {
    await server.start();
    await assert.rejects(follower.registerWithLeader(
      { cwd: "/repo" },
      { busSocketPath: socketPath },
    ), /version-mismatch/u);
    assert.equal(state.isRegistered(), false);
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registration runtime accepts explicit manual profile keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-follower-profile-"));
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
    }),
  });
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => "inst-a:1",
    getNowMs: () => 1000,
    getProfileKey: () => "manual:inst-a",
  });
  try {
    await server.start();
    assert.equal(
      await follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
      true,
    );
    assert.equal(registry.get("inst-a")?.profileKey, "manual:inst-a");
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower heartbeat tolerates one delayed leader acknowledgement without flapping", async () => {
  assert.equal(
    TELEGRAM_BUS_FOLLOWER_HEARTBEAT_TIMEOUT_MS,
    TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS,
  );
  const dir = mkdtempSync(
    join(tmpdir(), "pi-telegram-bus-follower-heartbeat-delay-"),
  );
  const socketPath = join(dir, "bus.sock");
  const state = createTelegramBusFollowerRegistrationState();
  const failures: unknown[] = [];
  let heartbeatCalls = 0;
  const server = createTelegramBusLocalServer({
    socketPath,
    async handleEnvelope(envelope) {
      if (envelope.kind === "follower.heartbeat") {
        heartbeatCalls += 1;
        if (heartbeatCalls === 2) {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
        }
      }
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: true,
      };
    },
  });
  let requestSequence = 0;
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => `inst-a:${++requestSequence}`,
    registrationState: state,
    heartbeatMs: 5,
    onHeartbeatFailure(error) {
      failures.push(error);
    },
  });
  try {
    await server.start();
    assert.equal(
      await follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
      true,
    );
    await waitForCondition(() => heartbeatCalls >= 3, 2_500);
    assert.deepEqual(failures, []);
    assert.equal(state.isRegistered(), true);
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower heartbeat collapses one sustained failure run into a failure record and an outcome record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-follower-heartbeat-run-"));
  const socketPath = join(dir, "bus.sock");
  const events: Array<{ phase?: string; failureSignature?: string; failedAttempts?: number; failedForMs?: number }> = [];
  const failures: unknown[] = [];
  let requests = 0;
  const startServer = () =>
    createTelegramBusLocalServer({
      socketPath,
      handleEnvelope: (envelope) => ({ kind: "bus.ack", requestId: envelope.requestId, ok: true }),
    });
  const server = startServer();
  const follower = createTelegramBusFollowerRegistrationRuntime({
    // The logging domain owns the collapsing policy; this test supplies it explicitly.
    failureLog: createTelegramFailureRunLog({
      category: "bus",
      failurePhase: "follower-heartbeat",
      outcomePhase: "follower-heartbeat-recovered",
      label: "follower heartbeat",
      record: (_category, _errorOrMessage, details) => events.push(details ?? {}),
      getNowMs: () => nowMs,
    }),
    instanceId: "inst-a",
    createRequestId: () => `inst-a:${++requests}`,
    getNowMs: () => nowMs,
    registrationState: createTelegramBusFollowerRegistrationState(),
    heartbeatMs: 5,
    timeoutMs: 50,
    recordRuntimeEvent: (_category, _error, details) => events.push(details ?? {}),
    onHeartbeatFailure(error) {
      failures.push(error);
    },
  });
  let nowMs = 1000;
  try {
    await server.start();
    await follower.registerWithLeader({ cwd: "/repo" }, { busSocketPath: socketPath });
    await server.stop();
    // A sustained outage repeats one identical failure every interval.
    await waitForCondition(() => failures.length >= 3, 300);
    const failureEvents = () => events.filter((event) => event.phase === "follower-heartbeat");
    assert.equal(failureEvents().length, 1, "a repeated identical failure is logged once");
    assert.equal(failureEvents()[0]?.failureSignature, "ENOENT");
    nowMs += 5000;
    const replacement = startServer();
    await replacement.start();
    await waitForCondition(() => events.some((event) => event.phase === "follower-heartbeat-recovered"), 300);
    // Recovery notification stays per-failure: only diagnostics are deduplicated.
    assert.ok(failures.length >= 3, "liveness recovery keeps observing every failed heartbeat");
    assert.equal(failureEvents().length, 1);
    const recovered = events.find((event) => event.phase === "follower-heartbeat-recovered");
    assert.equal(recovered?.failureSignature, "ENOENT");
    assert.ok((recovered?.failedAttempts ?? 0) >= 3);
    assert.equal(recovered?.failedForMs, 5000 + 0);
    await replacement.stop();
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower heartbeat logs a new failure record when the failure kind changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-follower-heartbeat-change-"));
  const socketPath = join(dir, "bus.sock");
  const events: Array<{ phase?: string; failureSignature?: string; previousFailureSignature?: string }> = [];
  let requests = 0;
  let rejecting = false;
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) =>
      rejecting
        ? { kind: "bus.ack", requestId: envelope.requestId, ok: false, message: "Telegram bus follower heartbeat was rejected." }
        : { kind: "bus.ack", requestId: envelope.requestId, ok: true },
  });
  const follower = createTelegramBusFollowerRegistrationRuntime({
    // The logging domain owns the collapsing policy; this test supplies it explicitly.
    failureLog: createTelegramFailureRunLog({
      category: "bus",
      failurePhase: "follower-heartbeat",
      outcomePhase: "follower-heartbeat-recovered",
      label: "follower heartbeat",
      record: (_category, _errorOrMessage, details) => events.push(details ?? {}),
    }),
    instanceId: "inst-a",
    createRequestId: () => `inst-a:${++requests}`,
    registrationState: createTelegramBusFollowerRegistrationState(),
    heartbeatMs: 5,
    timeoutMs: 50,
    recordRuntimeEvent: (_category, _error, details) => events.push(details ?? {}),
    onHeartbeatFailure() {},
  });
  try {
    await server.start();
    await follower.registerWithLeader({ cwd: "/repo" }, { busSocketPath: socketPath });
    rejecting = true;
    await waitForCondition(() => events.some((event) => event.phase === "follower-heartbeat"), 300);
    await server.stop();
    await waitForCondition(() => events.some((event) => event.failureSignature === "ENOENT"), 300);
    const failureEvents = events.filter((event) => event.phase === "follower-heartbeat");
    const signatures = failureEvents.map((event) => event.failureSignature);
    assert.equal(signatures[0], "Telegram bus follower heartbeat was rejected.");
    // A stopped listener can reset one in-flight heartbeat before the steady connection error, and each
    // distinct failure kind earns its own record while repeats of the same kind stay suppressed.
    const connectionError = failureEvents.find((event) => event.failureSignature === "ENOENT");
    assert.ok(connectionError, `expected a connection failure among ${JSON.stringify(signatures)}`);
    assert.ok(connectionError.previousFailureSignature, "a changed failure kind reports the run it superseded");
    assert.notEqual(connectionError.previousFailureSignature, "ENOENT");
    assert.equal(signatures.filter((signature) => signature === "ENOENT").length, 1);
    assert.ok(
      signatures.every((signature, index) => index === 0 || signature !== signatures[index - 1]),
      "the same failure kind is never logged twice in a row",
    );
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registration runtime reports heartbeat failure with active context", async () => {
  const dir = mkdtempSync(
    join(tmpdir(), "pi-telegram-bus-follower-heartbeat-fail-"),
  );
  const socketPath = join(dir, "bus.sock");
  const failures: unknown[] = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: true,
    }),
  });
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => "inst-a:1",
    registrationState: createTelegramBusFollowerRegistrationState(),
    heartbeatMs: 10,
    timeoutMs: 50,
    onHeartbeatFailure(error, ctx) {
      failures.push({ error: String(error), ctx });
    },
  });
  try {
    await server.start();
    await follower.registerWithLeader(
      { cwd: "/repo" },
      { busSocketPath: socketPath },
    );
    await server.stop();
    await waitForCondition(() => failures.length > 0, 200);
    assert.deepEqual((failures[0] as { ctx: unknown }).ctx, { cwd: "/repo" });
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registration runtime reports rejected heartbeat with active context", async () => {
  const dir = mkdtempSync(
    join(tmpdir(), "pi-telegram-bus-follower-heartbeat-reject-"),
  );
  const socketPath = join(dir, "bus.sock");
  const failures: unknown[] = [];
  let requestSequence = 0;
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: envelope.kind === "follower.register",
      message:
        envelope.kind === "follower.register"
          ? undefined
          : "Unknown Telegram bus follower instance.",
    }),
  });
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => `inst-a:${++requestSequence}`,
    registrationState: createTelegramBusFollowerRegistrationState(),
    heartbeatMs: 10,
    timeoutMs: 50,
    onHeartbeatFailure(error, ctx) {
      failures.push({ error: String(error), ctx });
    },
  });
  try {
    await server.start();
    await follower.registerWithLeader(
      { cwd: "/repo" },
      { busSocketPath: socketPath },
    );
    await waitForCondition(() => failures.length > 0, 200);
    assert.deepEqual(failures[0], {
      error: "Error: Unknown Telegram bus follower instance.",
      ctx: { cwd: "/repo" },
    });
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registration runtime owns one in-flight heartbeat", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-heartbeat-gate-"));
  const socketPath = join(dir, "bus.sock");
  let heartbeatCalls = 0;
  let releaseBlockedHeartbeat: (() => void) | undefined;
  const blockedHeartbeat = new Promise<void>((resolve) => {
    releaseBlockedHeartbeat = resolve;
  });
  const server = createTelegramBusLocalServer({
    socketPath,
    async handleEnvelope(envelope) {
      if (envelope.kind === "follower.register") {
        return { kind: "bus.ack", requestId: envelope.requestId, ok: true };
      }
      heartbeatCalls += 1;
      if (heartbeatCalls > 1) await blockedHeartbeat;
      return { kind: "bus.ack", requestId: envelope.requestId, ok: true };
    },
  });
  let requestSequence = 0;
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => `inst-a:${++requestSequence}`,
    registrationState: createTelegramBusFollowerRegistrationState(),
    heartbeatMs: 5,
  });
  try {
    await server.start();
    await follower.registerWithLeader(
      { cwd: "/repo" },
      { busSocketPath: socketPath },
    );
    await waitForCondition(() => heartbeatCalls === 2, 100);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(heartbeatCalls, 2);
    follower.stop();
    releaseBlockedHeartbeat?.();
  } finally {
    follower.stop();
    releaseBlockedHeartbeat?.();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registration runtime heartbeats until stopped", async () => {
  const dir = mkdtempSync(
    join(tmpdir(), "pi-telegram-bus-follower-heartbeat-"),
  );
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  let nowMs = 1000;
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      getNowMs: () => nowMs,
    }),
  });
  let requestSequence = 0;
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => `inst-a:${++requestSequence}`,
    getNowMs: () => nowMs,
    heartbeatMs: 50,
  });
  try {
    await server.start();
    assert.equal(
      await follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
      true,
    );
    nowMs = 2000;
    await waitForCondition(
      () => registry.get("inst-a")?.lastHeartbeatMs === 2000,
      500,
    );
    follower.stop();
    nowMs = 3000;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(registry.get("inst-a")?.lastHeartbeatMs, 2000);
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registration runtime surfaces leader rejection reasons", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-follower-reject-"));
  const socketPath = join(dir, "bus.sock");
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: () => ({
      kind: "bus.ack",
      requestId: "inst-a:1",
      ok: false,
      message: "Unauthorized Telegram bus envelope.",
    }),
  });
  const stopped: string[] = [];
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => "inst-a:1",
    stopReceiving: () => {
      stopped.push("stop");
    },
  });
  try {
    await server.start();
    await assert.rejects(
      () =>
        follower.registerWithLeader(
          { cwd: "/repo" },
          { busSocketPath: socketPath },
        ),
      /Unauthorized Telegram bus envelope/,
    );
    assert.deepEqual(stopped, ["stop"]);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registration runtime derives leader socket when lock omits it", async () => {
  const dir = mkdtempSync(
    join(tmpdir(), "pi-telegram-bus-follower-derived-socket-"),
  );
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      getNowMs: () => 1000,
    }),
  });
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => "inst-a:1",
    getLeaderSocketPath: () => socketPath,
  });
  try {
    await server.start();
    assert.equal(await follower.registerWithLeader({ cwd: "/repo" }, {}), true);
    assert.equal(registry.get("inst-a")?.instanceId, "inst-a");
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower queue handoff client rejects a mismatched staged receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-queue-handoff-mismatch-"));
  const socketPath = join(dir, "leader.sock");
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: true,
      result: { status: "staged", receiptId: "wrong", sourceUpdateIds: [1] },
    }),
  });
  const client = createTelegramBusFollowerQueueHandoffClient({
    socketPath,
    instanceId: "donor",
    createRequestId: () => "handoff:mismatch",
    getRegistrationGeneration: () => "donor-generation",
  });
  try {
    await server.start();
    await assert.rejects(
      client({
        recipientInstanceId: "recipient",
        recipientRegistrationGeneration: "recipient-generation",
        donorProcessId: 101,
        donorProcessBirthId: "101:start:donor",
        donorSessionGeneration: 1,
        donorAcquisitionId: "donor-acquisition",
        donorAcquiredAtMs: 1000,
        handoffToken: "x".repeat(32),
        payload: {
          kind: "prompt",
          chatId: 7,
          replyToMessageId: 10,
          queueOrder: 1,
          queueLane: "default",
          laneOrder: 1,
          statusSummary: "handoff",
          admissionReceipts: [
            { queueKind: "prompt", receiptId: "receipt-1", sourceUpdateIds: [1] },
          ],
          sourceMessageIds: [10],
          queuedAttachments: [],
          content: [{ type: "text", text: "handoff prompt" }],
          historyText: "handoff",
        },
      }),
      /queue handoff was rejected/u,
    );
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower queue handoff client requires an exact staged acknowledgement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-queue-handoff-client-"));
  const socketPath = join(dir, "leader.sock");
  const received: unknown[] = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope(envelope) {
      received.push(envelope);
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: true,
        result: {
          status: "staged",
          receiptId: "receipt-1",
          sourceUpdateIds: [1],
          queueOwner: {
            instanceId: "recipient",
            processId: 202,
            processBirthId: "202:start:recipient",
            sessionGeneration: 2,
            acquisitionId: "recipient-acquisition",
            acquiredAtMs: 2_000,
          },
        },
      };
    },
  });
  const client = createTelegramBusFollowerQueueHandoffClient({
    socketPath,
    instanceId: "donor",
    createRequestId: () => "handoff:1",
    getAuthSecret: () => "secret",
    getRegistrationGeneration: () => "donor-generation",
    getNowMs: () => 2000,
  });
  const payload = {
    kind: "prompt" as const,
    chatId: 7,
    replyToMessageId: 10,
    queueOrder: 1,
    queueLane: "default" as const,
    laneOrder: 1,
    statusSummary: "handoff",
    admissionReceipts: [
      { queueKind: "prompt" as const, receiptId: "receipt-1", sourceUpdateIds: [1] },
    ],
    sourceMessageIds: [10],
    queuedAttachments: [],
    content: [{ type: "text" as const, text: "handoff prompt" }],
    historyText: "handoff",
  };
  try {
    await server.start();
    assert.deepEqual(
      await client({
        recipientInstanceId: "recipient",
        recipientRegistrationGeneration: "recipient-generation",
        donorProcessId: 101,
        donorProcessBirthId: "101:start:donor",
        donorSessionGeneration: 1,
        donorAcquisitionId: "donor-acquisition",
        donorAcquiredAtMs: 1000,
        handoffToken: "x".repeat(32),
        payload,
      }),
      {
        status: "staged",
        receiptId: "receipt-1",
        sourceUpdateIds: [1],
        queueOwner: {
          instanceId: "recipient",
          processId: 202,
          processBirthId: "202:start:recipient",
          sessionGeneration: 2,
          acquisitionId: "recipient-acquisition",
          acquiredAtMs: 2_000,
        },
      },
    );
    assert.deepEqual(received, [
      {
        kind: "follower.offerQueueHandoff",
        requestId: "handoff:1",
        auth: "secret",
        instanceId: "donor",
        registrationGeneration: "donor-generation",
        recipientInstanceId: "recipient",
        recipientRegistrationGeneration: "recipient-generation",
        donorProcessId: 101,
        donorProcessBirthId: "101:start:donor",
        donorSessionGeneration: 1,
        donorAcquisitionId: "donor-acquisition",
        donorAcquiredAtMs: 1000,
        handoffToken: "x".repeat(32),
        payload,
        sentAtMs: 2000,
      },
    ]);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const threaded of [false, true])
for (const fault of ["known", "old-local", "old-leader", "missing-meta", "same-version", "missing-receipt", "bad-version", "wrong-outer-id", "wrong-receipt-id",
  "wrong-nonce", "wrong-generation", "wrong-instance", "wrong-target", "wrong-incarnation", "mismatched-message", "missing-protocol", "late-protocol", "late-generation", "lost-ack",
  "missing-scope", "scope-error", "scope-reader", "scope-ended", "scope-target", "scope-session", "scope-process", "scope-endpoint", "late-scope-rebind", "late-scope-restore", "late-scope-stop"] as const)
test(`Attachment caller requires negotiated peer and exact receipt without fallback (Thread=${threaded}, ${fault})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-attachment-peer-")), socketPath = join(dir, "bus.sock"), target = { chatId: 7, ...(threaded ? { threadId: 11 } : {}) };
  const local = createTelegramBusProtocolIdentity({ runtimeBuild: "0.58.3", capabilities: fault === "old-local" ? [] : [TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION] });
  const remote = createTelegramBusProtocolIdentity({ runtimeBuild: "0.58.3", capabilities: ["old-leader", "same-version"].includes(fault) ? [] : [TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION] });
  const state = createTelegramBusFollowerRegistrationState(), registry = createTelegramBusFollowerRegistry();
  let wires = 0, waits = 0, sequence = 0, session = "session", birth = "birth", endpoint = join(dir, "receiver.sock");
  const registration = createRawTelegramBusFollowerRegistrationRuntime({ instanceId: "follower", registrationState: state, protocolIdentity: local,
    createRequestId: () => sequence++ === 0 ? "g1" : `control:${sequence}`, getLeaderAuthSecret: () => "secret", getSessionId: () => session,
    getSessionGeneration: () => 1, getProcessBirthId: () => birth, getPid: () => 101, getFollowerBusSocketPath: () => endpoint,
    getProfileKey: () => "manual:attachment", heartbeatMs: 60_000 });
  const register = createRawTelegramBusLeaderEnvelopeHandler({ followerRegistry: registry, protocolIdentity: remote, authSecret: "secret",
    provisionFollowerTarget: () => ({ ...target, ...(threaded ? { slot: "A" } : {}) }) });
  const server = createRawTelegramBusLocalServer({ socketPath, shouldDropResponse: request => fault === "lost-ack" && request.kind === "follower.callApi", async handleEnvelope(envelope) {
    if (envelope.kind !== "follower.callApi") return register(envelope);
    wires++; assert.equal(envelope.auth, "secret");
    assert.equal(envelope.attachmentRegistrationIncarnation, registry.get("follower")?.registrationIncarnation);
    const receipt: Record<string, unknown> = { version: 1, requestId: envelope.requestId, nonce: "a".repeat(32), instanceId: "follower",
      registrationGeneration: "g1", registrationIncarnation: registry.get("follower")!.registrationIncarnation, botId: 777, messageId: 501, target };
    if (fault === "bad-version") receipt.version = 2;
    if (fault === "wrong-receipt-id") receipt.requestId = "other";
    if (fault === "wrong-nonce") receipt.nonce = "b".repeat(32);
    if (fault === "wrong-generation") receipt.registrationGeneration = "g2";
    if (fault === "wrong-instance") receipt.instanceId = "other";
    if (fault === "wrong-target") receipt.target = { chatId: 8 };
    if (fault === "wrong-incarnation") receipt.registrationIncarnation = "b".repeat(48);
    if (fault === "mismatched-message") receipt.messageId = 502;
    if (fault === "late-generation") state.setRegistered(true, target, { generation: "g2", leaderProtocol: remote });
    if (fault === "late-protocol") state.setRegistered(true, target, { generation: "g1", leaderProtocol: createTelegramBusProtocolIdentity({ runtimeBuild: "0.58.3" }) });
    if (fault === "late-scope-rebind" || fault === "late-scope-restore") {
      if (fault === "late-scope-restore") state.setRegistered(false);
      state.setRegistered(true, target, { generation: "g1", sessionId: "session", leaderProtocol: remote,
        registrationIncarnation: registry.get("follower")!.registrationIncarnation, ...(threaded ? { slot: "A" } : {}) });
    }
    if (fault === "late-scope-stop") registration.stop();
    return { kind: "bus.ack", requestId: fault === "wrong-outer-id" ? "wrong" : envelope.requestId, ok: true,
      ...(fault !== "missing-protocol" ? { protocol: remote } : {}), result: { message_id: 501,
        ...(fault !== "missing-receipt" ? { [TELEGRAM_BUS_ATTACHMENT_PUBLICATION_RECEIPT]: receipt } : {}) } };
  } });
  const callerDeps = { socketPath, instanceId: "follower", createRequestId: () => {
      if (fault === "scope-reader") callerDeps.captureAttachmentPublicationRegistration = () => registration.captureAttachmentPublicationRegistration?.();
      return "publication"; }, timeoutMs: 100,
    getAuthSecret: () => "secret", getRegistrationGeneration: state.getGeneration,
    ...(fault !== "missing-scope" ? { captureAttachmentPublicationRegistration: () => {
      if (fault === "scope-error") throw new Error("scope reader failed"); return registration.captureAttachmentPublicationRegistration?.(); } } : {}),
    ...(fault !== "missing-meta" ? { getLocalProtocol: () => local, getLeaderProtocol: state.getLeaderProtocol } : {}),
    async waitForRegistrationGeneration() { waits++; return "replacement"; } };
  const call = createTelegramBusFollowerApiCaller(callerDeps);
  const preflight = ["old-local", "old-leader", "missing-meta", "same-version", "missing-scope", "scope-error", "scope-reader", "scope-ended", "scope-target", "scope-session", "scope-process", "scope-endpoint"].includes(fault);
  try {
    await server.start(); assert.equal(await registration.registerWithLeader({ cwd: "/repo" }, { busSocketPath: socketPath }), true);
    if (fault === "scope-ended") registration.stop();
    if (fault === "scope-session") session = "changed";
    if (fault === "scope-process") birth = "changed";
    if (fault === "scope-endpoint") endpoint += "changed";
    const operation = call("call", ["sendMessage", { chat_id: fault === "scope-target" ? 8 : 7, ...(threaded ? { message_thread_id: 11 } : {}), text: "Question?",
      reply_markup: { inline_keyboard: [[{ text: "Cancel", callback_data: `tgattach:${"a".repeat(32)}:cancel` }]] } }]);
    if (fault === "known") {
      const result = await operation as Record<string, unknown>; assert.ok(parseTelegramBusAttachmentPublicationReceipt(result[TELEGRAM_BUS_ATTACHMENT_PUBLICATION_RECEIPT]));
    } else if (preflight) await assert.rejects(operation, error => error instanceof TelegramApiAuthorityError && !error.requestIssued);
    else await assert.rejects(operation, isTelegramApiCommitUnknownError);
    assert.equal(wires, preflight ? 0 : 1);
    assert.equal(waits, 0, "Private publication never acquires a replacement registration or retries");
  } finally { registration.stop(); await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("Bus follower API caller sends method and multipart voice calls over local transport", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-api-caller-"));
  const socketPath = join(dir, "bus.sock");
  const voicePath = join(dir, "voice output.ogg");
  const received: unknown[] = [];
  let requestSequence = 0;
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => {
      received.push(envelope);
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: true,
        result: { message_id: 55 },
      };
    },
  });
  const callApi = createTelegramBusFollowerApiCaller({
    socketPath,
    instanceId: "inst-a",
    createRequestId: () => `inst-a:${++requestSequence}`,
    getRegistrationGeneration: () => "generation-a",
    getNowMs: () => 7000,
  });
  try {
    await server.start();
    assert.deepEqual(await callApi("sendRichMessage", [{ chat_id: 1 }]), {
      message_id: 55,
    });
    assert.deepEqual(
      await callApi("callMultipart", [
        "sendVoice",
        { chat_id: "7", message_thread_id: "42" },
        "voice",
        voicePath,
        "voice output.ogg",
      ]),
      { message_id: 55 },
    );
    assert.deepEqual(received, [
      {
        kind: "follower.callApi",
        requestId: "inst-a:1",
        instanceId: "inst-a",
        registrationGeneration: "generation-a",
        method: "sendRichMessage",
        args: [{ chat_id: 1 }],
        sentAtMs: 7000,
      },
      {
        kind: "follower.callApi",
        requestId: "inst-a:2",
        instanceId: "inst-a",
        registrationGeneration: "generation-a",
        method: "callMultipart",
        args: [
          "sendVoice",
          { chat_id: "7", message_thread_id: "42" },
          "voice",
          voicePath,
          "voice output.ogg",
        ],
        sentAtMs: 7000,
      },
    ]);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const phase of ["waiting", "connecting", "current"] as const) {
  test(`Follower typing keeps its callback local and fences IPC issuance (${phase})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-telegram-typing-local-guard-")), socketPath = join(dir, "bus.sock"), received: unknown[] = [];
    let current = true, generation: string | undefined = phase === "waiting" ? undefined : "registration", finish!: (value: string) => void;
    const registration = new Promise<string>(resolve => { finish = resolve; });
    const server = createTelegramBusLocalServer({ socketPath, handleEnvelope(envelope) {
      received.push(envelope); return { kind: "bus.ack", requestId: envelope.requestId, ok: true, result: true };
    } });
    const callApi = createTelegramBusFollowerApiCaller({ socketPath, instanceId: "instance", createRequestId: () => "typing:1",
      getRegistrationGeneration: () => generation, waitForRegistrationGeneration: async () => registration,
      getAuthSecret() { if (phase === "connecting") current = false; return "fixture-secret"; } });
    const args = ["sendChatAction", { chat_id: 7, message_thread_id: 42, action: "typing" }, { maxAttempts: 1, retrySafety: "non-idempotent" }];
    try {
      await server.start();
      const delivery = callApi("call", args, { assertAuthority() { if (!current) throw new Error("Context ended"); } });
      if (phase === "waiting") { await new Promise<void>(resolve => setImmediate(resolve)); current = false; generation = "registration"; finish(generation); }
      if (phase === "current") {
        assert.equal(await delivery, true); assert.equal(received.length, 1);
        const envelope = received[0] as { args: unknown[] }; assert.deepEqual(envelope.args, args);
        assert.equal(JSON.stringify(envelope).includes("assertAuthority"), false, "Local callback is not serialized into the envelope");
      } else {
        await assert.rejects(delivery, error => error instanceof TelegramApiAuthorityError && !error.requestIssued);
        assert.deepEqual(received, []);
      }
    } finally { finish("registration"); await server.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("Follower typing authority refuses a late native acknowledgement without replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-typing-late-ack-")), socketPath = join(dir, "bus.sock");
  const issued = Promise.withResolvers<void>(), response = Promise.withResolvers<void>();
  const received: unknown[] = [];
  let current = true;
  const server = createTelegramBusLocalServer({ socketPath, async handleEnvelope(envelope) {
    received.push(envelope); issued.resolve(); await response.promise;
    return { kind: "bus.ack", requestId: envelope.requestId, ok: true, result: true };
  } });
  const callApi = createTelegramBusFollowerApiCaller({ socketPath, instanceId: "instance", createRequestId: () => "typing:late",
    getRegistrationGeneration: () => "registration", getAuthSecret: () => "fixture-secret" });
  const args = ["sendChatAction", { chat_id: 7, message_thread_id: 42, action: "typing" }, { maxAttempts: 1, retrySafety: "non-idempotent" }];
  try {
    await server.start();
    const request = callApi("call", args, { assertAuthority() { if (!current) throw new Error("Loop ended"); } });
    await issued.promise; current = false; response.resolve();
    await assert.rejects(request, error => error instanceof TelegramApiAuthorityError && error.requestIssued);
    assert.equal(received.length, 1);
    assert.deepEqual((received[0] as { args: unknown[] }).args, args);
    assert.equal(JSON.stringify(received).includes("assertAuthority"), false);
  } finally { response.resolve(); await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("Bus follower API calls wait for heartbeat recovery before transport", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-api-recovery-"));
  const socketPath = join(dir, "bus.sock");
  const received: unknown[] = [];
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(
    true,
    { chatId: 1, threadId: 2 },
    { generation: "generation-old" },
  );
  registrationState.beginRecovery();
  registrationState.setRegistered(false);
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => {
      received.push(envelope);
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: true,
        result: { message_id: 56 },
      };
    },
  });
  let nowMs = 7001;
  const slowEvents: unknown[] = [];
  const callApi = createTelegramBusFollowerApiCaller({
    socketPath,
    instanceId: "inst-a",
    createRequestId: () => "inst-a:recovery:1",
    getRegistrationGeneration: registrationState.getGeneration,
    waitForRegistrationGeneration: registrationState.waitForGeneration,
    getNowMs: () => nowMs,
    recordRuntimeEvent: (_category, _message, details) => slowEvents.push(details),
  });
  try {
    await server.start();
    const delivery = callApi("sendRichMessage", [{ chat_id: 1 }]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(received, []);

    nowMs += 4000;
    registrationState.setRegistered(
      true,
      { chatId: 1, threadId: 2 },
      { generation: "generation-restored" },
    );

    assert.deepEqual(await delivery, { message_id: 56 });
    assert.equal(received.length, 1);
    assert.equal(
      (received[0] as { registrationGeneration?: string })
        .registrationGeneration,
      "generation-restored",
    );
    // A send held behind recovery is attributed to registration wait, not transport.
    assert.deepEqual(slowEvents, [{ phase: "follower-api-slow", method: "sendRichMessage", elapsedMs: 4000,
      registrationWaitMs: 4000, transportMs: 0, outcome: "ok" }]);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower API calls fail before transport when registration is not restored", async () => {
  let transportRequested = false;
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.beginRecovery();
  const callApi = createTelegramBusFollowerApiCaller({
    socketPath: () => {
      transportRequested = true;
      return "unused.sock";
    },
    instanceId: "inst-a",
    createRequestId: () => "inst-a:unregistered:1",
    getRegistrationGeneration: registrationState.getGeneration,
    waitForRegistrationGeneration: registrationState.waitForGeneration,
    timeoutMs: 10,
  });

  await assert.rejects(
    () => callApi("sendRichMessage", [{ chat_id: 1 }]),
    /Telegram bus follower is not registered/,
  );
  assert.equal(transportRequested, false);
});

test("Bus follower API calls do not cross an explicit recovery cancellation", async () => {
  let transportRequested = false;
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.beginRecovery();
  const callApi = createTelegramBusFollowerApiCaller({
    socketPath: () => {
      transportRequested = true;
      return "unused.sock";
    },
    instanceId: "inst-a",
    createRequestId: () => "inst-a:cancelled:1",
    getRegistrationGeneration: registrationState.getGeneration,
    waitForRegistrationGeneration: registrationState.waitForGeneration,
  });

  const delivery = callApi("sendRichMessage", [{ chat_id: 1 }]);
  await new Promise((resolve) => setImmediate(resolve));
  registrationState.cancelRecovery();
  registrationState.setRegistered(
    true,
    { chatId: 1, threadId: 2 },
    { generation: "unrelated-generation" },
  );

  await assert.rejects(
    () => delivery,
    /Telegram bus follower is not registered/,
  );
  assert.equal(transportRequested, false);
});

test("Bus follower API caller preserves structured commit-unknown errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-api-ambiguous-"));
  const socketPath = join(dir, "bus.sock");
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: false,
      message: "sendMessage response was lost",
      error: { code: "commit-unknown", method: "sendMessage" },
    }),
  });
  const callApi = createTelegramBusFollowerApiCaller({
    socketPath,
    instanceId: "inst-a",
    createRequestId: () => "inst-a:ambiguous:1",
    getRegistrationGeneration: () => "generation-a",
  });
  try {
    await server.start();
    await assert.rejects(
      () => callApi("call", ["sendMessage", { chat_id: 1, text: "hello" }]),
      isTelegramApiCommitUnknownError,
    );
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower API caller preserves structured stale-target evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-api-stale-target-"));
  const socketPath = join(dir, "bus.sock");
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: false,
      message: "Bad Request: message thread not found",
      error: { code: "stale-target", chatId: 1, threadId: 2 },
    }),
  });
  const callApi = createTelegramBusFollowerApiCaller({
    socketPath,
    instanceId: "inst-a",
    createRequestId: () => "inst-a:stale-target:1",
    getRegistrationGeneration: () => "generation-a",
  });
  try {
    await server.start();
    const error = await callApi("call", [
      "sendMessage",
      { chat_id: 1, message_thread_id: 2, text: "hello" },
    ]).catch((failure: unknown) => failure);
    assert.deepEqual(getTelegramApiErrorRequestTarget(error), {
      chatId: 1,
      threadId: 2,
    });
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower API caller types the leader's refusal of a foreign Thread with its requested target", async () => {
  let requestCount = 0;
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-api-not-allowed-"));
  const socketPath = join(dir, "bus.sock");
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: false,
      message: "Telegram bus API call is not allowed for this follower.",
    }),
  });
  const callApi = createTelegramBusFollowerApiCaller({
    socketPath,
    instanceId: "inst-a",
    createRequestId: () => `inst-a:not-allowed:${++requestCount}`,
    getRegistrationGeneration: () => "generation-a",
  });
  try {
    await server.start();
    const error = await callApi("call", ["sendMessage", { chat_id: 1, message_thread_id: 2, text: "hello" }])
      .catch((failure: unknown) => failure);
    assert.ok(error instanceof TelegramApiFollowerNotAllowedError);
    assert.deepEqual(error.requestTarget, { chatId: 1, threadId: 2 });
    assert.equal(error.rejectedRequestMethod, undefined, "Legacy text grants no pre-execution proof");
    const untargeted = await callApi("call", ["getMe", {}]).catch((failure: unknown) => failure);
    assert.ok(untargeted instanceof TelegramApiFollowerNotAllowedError);
    assert.equal(untargeted.requestTarget, undefined);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Follower API refusal evidence distinguishes pre-dispatch denial from matching API error text", async () => {
  for (const scenario of ["denied", "executed", "lost", "wrong-method", "mutated-method"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "pi-telegram-api-refusal-proof-"));
    const socketPath = join(dir, "bus.sock");
    const registry = createTelegramBusFollowerRegistry();
    registry.register({
      instanceId: "inst-a", connectedAtMs: 1000,
      registrationGeneration: "generation-a", target: { chatId: 1, threadId: 42 },
    });
    let executions = 0;
    let requests = 0;
    const args: unknown[] = ["sendMessage", { chat_id: 1, message_thread_id: 2, text: "hello" }];
    const leader = createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      authorizeFollowerApiCall: () => scenario === "executed",
      callApi: () => {
        executions += 1;
        throw new Error("Telegram bus API call is not allowed for this follower.");
      },
    });
    const server = createTelegramBusLocalServer({
      socketPath,
      handleEnvelope: async (envelope) => {
        const reply = await leader(envelope);
        if (scenario === "mutated-method") args[0] = "deleteMessage";
        return (scenario === "wrong-method" || scenario === "mutated-method") && reply?.kind === "bus.ack"
          ? { ...reply, error: { code: "follower-api-not-allowed", method: "deleteMessage" } }
          : reply;
      },
      shouldDropResponse: () => scenario === "lost",
    });
    const callApi = createTelegramBusFollowerApiCaller({
      socketPath, instanceId: "inst-a", timeoutMs: 100,
      createRequestId: () => `inst-a:proof:${++requests}`,
      getRegistrationGeneration: () => "generation-a",
    });
    try {
      await server.start();
      const error = await callApi("call", args, { assertAuthority: () => {} })
        .catch((failure: unknown) => failure);
      assert.equal(executions, scenario === "executed" ? 1 : 0, scenario);
      if (scenario === "lost") {
        assert.ok(isTelegramApiCommitUnknownError(error));
        assert.equal(error instanceof TelegramApiFollowerNotAllowedError, false);
      } else {
        assert.ok(error instanceof TelegramApiFollowerNotAllowedError, scenario);
        assert.deepEqual(error.requestTarget, { chatId: 1, threadId: 2 });
        assert.equal(error.rejectedRequestMethod, scenario === "denied" ? "sendMessage" : undefined, scenario);
      }
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

for (const method of ["call", "callMultipart"] as const) {
  for (const phase of ["registration", "serialized"] as const) {
    test(`Follower API request identity survives ${phase} mutation (${method})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-telegram-api-identity-"));
      const socketPath = join(dir, "bus.sock"), registry = createTelegramBusFollowerRegistry();
      registry.register({ instanceId: "inst-a", connectedAtMs: 1000,
        registrationGeneration: "generation-a", target: { chatId: 1, threadId: 42 } });
      const apiMethod = method === "call" ? "sendMessage" : "sendPhoto";
      const body = { chat_id: method === "call" ? 1 : "1", message_thread_id: method === "call" ? 2 : "2", text: "original" };
      const args: unknown[] = [apiMethod, body, ...(method === "callMultipart" ? ["photo", join(dir, "unused.png"), "unused.png"] : [])];
      let executions = 0, requests = 0;
      const wire: unknown[][] = [], diagnosticMethods: unknown[] = [];
      const mutate = () => { args[0] = "deleteMessage"; body.message_thread_id = 99; body.text = "changed"; };
      const leader = createTelegramBusLeaderEnvelopeHandler({ followerRegistry: registry,
        authorizeFollowerApiCall: () => false,
        callApi: () => { executions++; assert.fail("The rejected request cannot reach Telegram"); },
      });
      const server = createTelegramBusLocalServer({ socketPath,
        handleEnvelope: async (envelope) => {
          assert.equal(envelope.kind, "follower.callApi");
          if (envelope.kind === "follower.callApi") wire.push(structuredClone(envelope.args));
          const response = await leader(envelope);
          if (phase === "serialized") mutate();
          return response;
        },
      });
      const callApi = createTelegramBusFollowerApiCaller({ socketPath, instanceId: "inst-a", timeoutMs: 1000,
        createRequestId: () => `inst-a:identity:${++requests}`,
        getRegistrationGeneration: () => phase === "registration" ? undefined : "generation-a",
        waitForRegistrationGeneration: async () => { mutate(); return "generation-a"; },
        slowCallMs: 0,
        recordRuntimeEvent: (_kind, _message, details) => { diagnosticMethods.push(details?.method); },
      });
      try {
        await server.start();
        const expected = JSON.parse(JSON.stringify(args));
        const error = await callApi(method, args).catch((failure: unknown) => failure);
        assert.equal(executions, 0);
        assert.deepEqual(wire, [expected], "The one wire attempt must retain the invocation snapshot");
        assert.ok(error instanceof TelegramApiFollowerNotAllowedError);
        assert.deepEqual(error.requestTarget, { chatId: 1, threadId: 2 });
        assert.equal(error.rejectedRequestMethod, apiMethod);
        assert.deepEqual(diagnosticMethods, [apiMethod]);
      } finally {
        await server.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

for (const phase of ["before-snapshot", "during-snapshot"] as const) {
  test(`Follower API authority fences request snapshot (${phase})`, async () => {
    let current = phase !== "before-snapshot", encodes = 0, registrations = 0;
    const options = { assertAuthority() { if (!current) throw new Error("Execution ended"); } };
    const body = { toJSON() {
      encodes++; current = false; options.assertAuthority = () => {};
      return { chat_id: 1, message_thread_id: 2, text: "not sent" };
    } };
    const callApi = createTelegramBusFollowerApiCaller({ socketPath: join(tmpdir(), "unused-identity.sock"), instanceId: "inst-a",
      createRequestId: () => assert.fail("An invalidated snapshot cannot construct a wire request"),
      getRegistrationGeneration: () => { registrations++; return "generation-a"; },
    });
    await assert.rejects(callApi("call", ["sendMessage", body], options), (error: unknown) => {
      assert.ok(error instanceof TelegramApiAuthorityError);
      assert.equal(error.requestIssued, false);
      return true;
    });
    assert.equal(encodes, phase === "before-snapshot" ? 0 : 1);
    assert.equal(registrations, phase === "before-snapshot" ? 0 : 1);
  });
}

test("Follower API refusal identity follows JSON wire semantics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-api-json-identity-"));
  const socketPath = join(dir, "bus.sock"), wire: unknown[][] = [];
  const server = createTelegramBusLocalServer({ socketPath,
    handleEnvelope: (envelope) => {
      if (envelope.kind === "follower.callApi") wire.push(structuredClone(envelope.args));
      return { kind: "bus.ack", requestId: envelope.requestId, ok: false,
        message: "Telegram bus API call is not allowed for this follower.",
        error: { code: "follower-api-not-allowed", method: "sendMessage" } };
    },
  });
  const callApi = createTelegramBusFollowerApiCaller({ socketPath, instanceId: "inst-a",
    createRequestId: () => "inst-a:json-identity", getRegistrationGeneration: () => "generation-a" });
  let encodes = 0;
  const body = { chat_id: 1, message_thread_id: 99, toJSON() {
    encodes++;
    return { chat_id: 1, message_thread_id: 2, text: "wire" };
  } };
  try {
    await server.start();
    const error = await callApi("call", ["sendMessage", body]).catch((failure: unknown) => failure);
    assert.ok(error instanceof TelegramApiFollowerNotAllowedError);
    assert.deepEqual(wire, [["sendMessage", { chat_id: 1, message_thread_id: 2, text: "wire" }]]);
    assert.deepEqual(error.requestTarget, { chatId: 1, threadId: 2 });
    assert.equal(encodes, 1, "Do not re-evaluate caller serialization when interpreting refusal");
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const fault of ["healthy", "old-local", "old-peer", "incompatible", "not-ready", "no-native", "missing-auth", "native-registration", "auth", "endpoint", "local-protocol", "peer-protocol", "provider", "method"] as const)
test(`Native API birth authority is negotiated and retains its original source (${fault})`, () => {
  const capable = createTelegramBusProtocolIdentity({ runtimeBuild: "birth", capabilities: [TELEGRAM_BUS_CAPABILITY_GUARDED_API_AUTHORITY] });
  const old = createTelegramBusProtocolIdentity({ runtimeBuild: "birth", capabilities: [] });
  const state = createTelegramBusFollowerRegistrationState();
  if (fault !== "not-ready") state.setRegistered(true, { chatId: 7 }, { generation: "original" });
  let auth = fault === "missing-auth" ? undefined : "secret", endpoint = "original.sock", local = fault === "old-local" ? old : capable, peer = fault === "old-peer" ? old : fault === "incompatible" ? { ...capable, protocolVersion: 0 } : capable;
  const deps = { socketPath: () => endpoint, instanceId: "source", getAuthSecret: () => auth, getRegistrationGeneration: state.getGeneration,
    capturePublicationRegistration: fault === "no-native" ? undefined : state.capturePublicationRegistration!, getLocalProtocol: () => local, getLeaderProtocol: () => peer,
    createRequestId() { assert.fail("Birth capture issues no RPC"); }, async waitForRegistrationGeneration() { assert.fail("Birth capture cannot wait for a successor"); } };
  const call = createTelegramBusFollowerApiCaller(deps), capture = call.captureAuthority, original = capture();
  if (["old-local", "old-peer", "incompatible", "not-ready", "no-native", "missing-auth"].includes(fault)) { assert.equal(original, undefined); return; }
  assert.equal(typeof original, "function"); original!();
  if (fault === "healthy") return;
  const provider = deps.getLeaderProtocol;
  if (fault === "native-registration") state.setRegistered(true, { chatId: 7 }, { generation: "original" });
  if (fault === "auth") auth = "replacement";
  if (fault === "endpoint") endpoint = "replacement.sock";
  if (fault === "local-protocol") local = old;
  if (fault === "peer-protocol") peer = old;
  if (fault === "provider") deps.getLeaderProtocol = () => capable;
  if (fault === "method") call.captureAuthority = () => () => {};
  assert.throws(original!);
  auth = "secret"; endpoint = "original.sock"; local = capable; peer = capable; deps.getLeaderProtocol = provider; call.captureAuthority = capture;
  assert.throws(original!, "Restoring equal metadata/callables cannot revive a captured birth");
  assert.equal(typeof capture(), "function", "A fresh capture is a separate source, not revival of the old one");
});

for (const fault of ["healthy", "no-api-origin", "artifact-only", "malformed", "old-local", "old-peer", "same-value-rebind", "changed-origin", "scope-field"] as const)
test(`API registration capture binds acknowledged API identity, never Artifact (${fault})`, () => {
  const wire = createTelegramBusProtocolIdentity({ runtimeBuild: "wire", capabilities: [TELEGRAM_BUS_CAPABILITY_GUARDED_API_AUTHORITY] });
  const strong = createTelegramBusProtocolIdentity({ runtimeBuild: "api-origin", capabilities: [TELEGRAM_BUS_CAPABILITY_GUARDED_API_AUTHORITY, TELEGRAM_BUS_CAPABILITY_API_REGISTRATION_AUTHORITY] });
  const state = createTelegramBusFollowerRegistrationState(), apiOrigin = "a".repeat(48);
  const metadata = { generation: "original", ...(fault === "artifact-only" ? { registrationIncarnation: apiOrigin } : {}),
    ...(["no-api-origin", "artifact-only"].includes(fault) ? {} : { apiRegistrationIncarnation: fault === "malformed" ? "invalid" : apiOrigin }) };
  state.setRegistered(true, { chatId: 7 }, metadata);
  const native = state.capturePublicationRegistration!()!;
  const call = createTelegramBusFollowerApiCaller({ socketPath: "original.sock", instanceId: "source", getAuthSecret: () => "secret", getRegistrationGeneration: state.getGeneration,
    capturePublicationRegistration: () => native, getLocalProtocol: () => fault === "old-local" ? wire : strong, getLeaderProtocol: () => fault === "old-peer" ? wire : strong,
    createRequestId() { assert.fail("Capture is not a probe"); } });
  assert.equal(typeof call.captureAuthority(), "function", "The weaker caller-local scope remains a separate contract");
  const captured = call.captureAuthority("registration");
  if (["no-api-origin", "artifact-only", "malformed", "old-local", "old-peer"].includes(fault)) { assert.equal(captured, undefined); return; }
  assert.equal(typeof captured, "function"); captured!();
  assert.equal(state.captureArtifactRegistration!(), undefined, "A native ordinary API identity grants no Artifact authority");
  if (fault === "healthy") return;
  if (fault === "scope-field") native.apiIncarnation = "b".repeat(48);
  else state.setRegistered(true, { chatId: 7 }, { ...metadata, apiRegistrationIncarnation: fault === "changed-origin" ? "b".repeat(48) : apiOrigin });
  assert.throws(captured!);
  native.apiIncarnation = apiOrigin;
  assert.throws(captured!, "Equal-value restoration is not revival");
});

for (const outcome of ["success", "refused"] as const) for (const response of ["matching", "missing", "foreign"] as const)
test(`Negotiated guarded API ACK retains original peer identity (${outcome}/${response})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-api-peer-")), socketPath = join(dir, "bus.sock"), state = createTelegramBusFollowerRegistrationState();
  state.setRegistered(true, { chatId: 7 }, { generation: "original" });
  const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "peer", capabilities: [TELEGRAM_BUS_CAPABILITY_GUARDED_API_AUTHORITY] });
  let requests = 0;
  const server = createTelegramBusLocalServer({ socketPath, handleEnvelope(envelope) {
    requests++;
    const identity = response === "matching" ? protocol : createTelegramBusProtocolIdentity({ runtimeBuild: "foreign", capabilities: [TELEGRAM_BUS_CAPABILITY_GUARDED_API_AUTHORITY] });
    return { kind: "bus.ack", requestId: envelope.requestId, ...(response === "missing" ? {} : { protocol: identity }),
      ...(outcome === "success" ? { ok: true, result: { message_id: 55 } } : { ok: false, message: "Refused", error: { code: "follower-api-not-allowed", method: "sendMessage" } }) };
  } });
  const call = createTelegramBusFollowerApiCaller({ socketPath, instanceId: "source", getAuthSecret: () => "secret", getRegistrationGeneration: state.getGeneration,
    capturePublicationRegistration: state.capturePublicationRegistration, getLocalProtocol: () => protocol, getLeaderProtocol: () => protocol, createRequestId: () => "original" });
  try {
    await server.start();
    const work = call("call", ["sendMessage", { chat_id: 7, text: "Original" }, { maxAttempts: 1, retrySafety: "non-idempotent" }], { assertAuthority() {} });
    if (response === "matching" && outcome === "success") assert.deepEqual(await work, { message_id: 55 });
    else await assert.rejects(work, error => {
      if (response === "matching") assert.ok(error instanceof TelegramApiFollowerNotAllowedError);
      else { assert.ok(isTelegramApiCommitUnknownError(error)); assert.equal(error instanceof TelegramApiFollowerNotAllowedError, false); }
      return true;
    });
    assert.equal(requests, 1);
  } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

for (const fault of ["generation", "auth", "endpoint", "generation-reader", "auth-reader", "endpoint-reader", "scope-reader", "native-registration"] as const)
for (const phase of ["before-wire", "ack"] as const)
test(`Guarded follower API retains its original native wire admission (${fault}/${phase})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-api-admission-")), socketPath = join(dir, "bus.sock");
  const state = createTelegramBusFollowerRegistrationState(), target = { chatId: 7, threadId: 42 }, metadata = { generation: "original" };
  state.setRegistered(true, target, metadata);
  let endpoint = socketPath, auth = "original-secret", requests = 0;
  const mutate = () => {
    if (fault === "generation") state.setRegistered(true, target, { generation: "replacement" });
    if (fault === "auth") auth = "replacement-secret";
    if (fault === "endpoint") endpoint = join(dir, "other.sock");
    if (fault === "generation-reader") deps.getRegistrationGeneration = () => state.getGeneration();
    if (fault === "auth-reader") deps.getAuthSecret = () => auth;
    if (fault === "endpoint-reader") deps.socketPath = () => endpoint;
    if (fault === "scope-reader") deps.capturePublicationRegistration = () => state.capturePublicationRegistration!();
    if (fault === "native-registration") state.setRegistered(true, target, metadata);
  };
  const server = createTelegramBusLocalServer({ socketPath, handleEnvelope(envelope) {
    requests++; if (phase === "ack") mutate();
    return { kind: "bus.ack", requestId: envelope.requestId, ok: true, result: { message_id: 55 } };
  } });
  const deps = { socketPath: () => endpoint, instanceId: "source", getAuthSecret: () => auth,
    getRegistrationGeneration: state.getGeneration, capturePublicationRegistration: state.capturePublicationRegistration!,
    createRequestId() { if (phase === "before-wire") mutate(); return "original-request"; } };
  const call = createTelegramBusFollowerApiCaller(deps);
  try {
    await server.start();
    await assert.rejects(call("call", ["sendMessage", { chat_id: 7, text: "Original" }], { assertAuthority() {} }), error => {
      assert.ok(error instanceof TelegramApiAuthorityError); assert.equal(error.requestIssued, phase === "ack"); return true;
    });
    assert.equal(requests, phase === "ack" ? 1 : 0, "No replacement wire admission or replay");
  } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

for (const recovering of [false, true])
test(`Guarded follower API captures one native admission after any legacy recovery (${recovering})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-api-admission-ready-")), socketPath = join(dir, "bus.sock");
  const state = createTelegramBusFollowerRegistrationState(); let captures = 0;
  if (recovering) state.beginRecovery(); else state.setRegistered(true, { chatId: 7 }, { generation: "ready" });
  const server = createTelegramBusLocalServer({ socketPath, handleEnvelope(envelope) {
    assert.equal(envelope.kind === "follower.callApi" && envelope.registrationGeneration, "ready");
    return { kind: "bus.ack", requestId: envelope.requestId, ok: true, result: { message_id: 55 } };
  } });
  const call = createTelegramBusFollowerApiCaller({ socketPath, instanceId: "source", createRequestId: () => "ready", getAuthSecret: () => "secret",
    getRegistrationGeneration: state.getGeneration, waitForRegistrationGeneration: state.waitForGeneration,
    capturePublicationRegistration() { captures++; return state.capturePublicationRegistration!(); } });
  try {
    await server.start();
    const work = call("call", ["sendMessage", { chat_id: 7, text: "Original" }], { assertAuthority() {} });
    if (recovering) state.setRegistered(true, { chatId: 7 }, { generation: "ready" });
    else assert.equal(captures, 1, "An already-ready native source is captured before any await");
    assert.deepEqual(await work, { message_id: 55 }); assert.equal(captures, 1);
  } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("Guarded follower API rechecks original providers after its last endpoint callback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-api-last-admission-")), socketPath = join(dir, "bus.sock");
  const state = createTelegramBusFollowerRegistrationState(); state.setRegistered(true, { chatId: 7 }, { generation: "ready" });
  let issued = false, finalCaller = false, replace = false;
  const server = createTelegramBusLocalServer({ socketPath, handleEnvelope(envelope) {
    issued = true; return { kind: "bus.ack", requestId: envelope.requestId, ok: true, result: { message_id: 55 } };
  } });
  const deps = { socketPath: () => {
      if (replace) { replace = false; deps.getAuthSecret = () => "secret"; }
      return socketPath;
    }, instanceId: "source", getAuthSecret: () => "secret", getRegistrationGeneration: state.getGeneration, createRequestId: () => "ready",
    capturePublicationRegistration() {
      const native = state.capturePublicationRegistration!()!, original = native.isCurrent;
      native.isCurrent = () => {
        const current = original();
        if (issued) { if (finalCaller) replace = true; else queueMicrotask(() => { finalCaller = true; }); }
        return current;
      };
      return native;
    } };
  const call = createTelegramBusFollowerApiCaller(deps);
  try {
    await server.start();
    await assert.rejects(call("call", ["sendMessage", { chat_id: 7, text: "Original" }], { assertAuthority() {} }), error => {
      assert.ok(error instanceof TelegramApiAuthorityError); assert.equal(error.requestIssued, true); return true;
    });
  } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("Guarded follower API refuses a missing configured native admission before request construction", async () => {
  const call = createTelegramBusFollowerApiCaller({ socketPath: "unused.sock", instanceId: "source", getRegistrationGeneration: () => "ready",
    capturePublicationRegistration: () => undefined, createRequestId() { assert.fail("Missing native admission cannot construct a request"); } });
  await assert.rejects(call("call", ["sendMessage", { chat_id: 7, text: "Original" }], { assertAuthority() {} }), error => {
    assert.ok(error instanceof TelegramApiAuthorityError); assert.equal(error.requestIssued, false); return true;
  });
});

test("Unscoped legacy follower API does not acquire private wire-admission authority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-api-admission-legacy-")), socketPath = join(dir, "bus.sock");
  const server = createTelegramBusLocalServer({ socketPath, handleEnvelope(envelope) {
    return { kind: "bus.ack", requestId: envelope.requestId, ok: true, result: { message_id: 55 } };
  } });
  const call = createTelegramBusFollowerApiCaller({ socketPath, instanceId: "source", createRequestId: () => "legacy", getRegistrationGeneration: () => "legacy",
    capturePublicationRegistration() { assert.fail("Independent legacy calls do not silently acquire a native publication scope"); } });
  try { await server.start(); assert.deepEqual(await call("call", ["sendMessage", { chat_id: 7, text: "Independent" }]), { message_id: 55 }); }
  finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

for (const apiMethod of ["sendMessage", "sendVoice", "getMe"] as const)
for (const outcome of ["success", "refused", "stale", "unknown"] as const)
for (const matching of [true, false])
test(`Follower API interprets only its original ACK (${apiMethod}/${outcome}/matching=${matching})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-api-original-ack-")), socketPath = join(dir, "bus.sock");
  let requests = 0;
  const server = createTelegramBusLocalServer({ socketPath, handleEnvelope(envelope) {
    requests++;
    const requestId = matching ? envelope.requestId : "foreign-request";
    if (outcome === "success") return { kind: "bus.ack", requestId, ok: true, result: { message_id: 55 } };
    if (outcome === "refused") return { kind: "bus.ack", requestId, ok: false,
      message: "Telegram bus API call is not allowed for this follower.", error: { code: "follower-api-not-allowed", method: apiMethod } };
    if (outcome === "stale") return { kind: "bus.ack", requestId, ok: false,
      message: "Bad Request: message thread not found", error: { code: "stale-target", chatId: 7, threadId: 42 } };
    return { kind: "bus.ack", requestId, ok: false, message: "Unknown native outcome", error: { code: "commit-unknown", method: apiMethod } };
  } });
  const call = createTelegramBusFollowerApiCaller({ socketPath, instanceId: "source", createRequestId: () => "original-request",
    getRegistrationGeneration: () => "original-registration" });
  try {
    await server.start();
    const work = apiMethod === "sendVoice" ? call("callMultipart", [apiMethod, { chat_id: "7", message_thread_id: "42" }, "voice", "unused.ogg", "voice.ogg"]) :
      call("call", [apiMethod, { chat_id: 7, message_thread_id: 42, text: "Original body" }]);
    if (matching && outcome === "success") assert.deepEqual(await work, { message_id: 55 });
    else await assert.rejects(work, error => {
      assert.ok(error instanceof Error);
      if (!matching) {
        assert.equal(isTelegramApiCommitUnknownError(error), apiMethod !== "getMe", "An unrelated ACK cannot confirm or reject a non-idempotent effect");
        assert.equal(error instanceof TelegramApiFollowerNotAllowedError, false, "No pre-HTTP fallback authority from another request");
        assert.equal(getTelegramApiErrorRequestTarget(error), undefined, "No stale-target invalidation from another request");
        assert.match(String(error.cause ?? error), /acknowledgement is unconfirmed/u);
      } else if (outcome === "refused") {
        assert.ok(error instanceof TelegramApiFollowerNotAllowedError); assert.equal(error.rejectedRequestMethod, apiMethod);
      } else if (outcome === "stale") assert.deepEqual(getTelegramApiErrorRequestTarget(error), { chatId: 7, threadId: 42 });
      else assert.ok(isTelegramApiCommitUnknownError(error));
      return true;
    });
    assert.equal(requests, 1, "Unknown ACKs never replay the operation");
  } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

for (const apiMethod of ["sendMessage", "getMe"] as const)
test(`Follower API refuses a request frame in place of its ACK (${apiMethod})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-api-response-kind-")), socketPath = join(dir, "bus.sock");
  const server = createTelegramBusLocalServer({ socketPath, handleEnvelope(envelope) {
    return { kind: "bus.probe", requestId: envelope.requestId, sentAtMs: 1 };
  } });
  const call = createTelegramBusFollowerApiCaller({ socketPath, instanceId: "source", createRequestId: () => "original-request",
    getRegistrationGeneration: () => "original-registration" });
  try {
    await server.start();
    await assert.rejects(call("call", [apiMethod, { chat_id: 7, text: "Original" }]), error => {
      assert.ok(error instanceof Error); assert.equal(isTelegramApiCommitUnknownError(error), apiMethod !== "getMe"); return true;
    });
  } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("Bus follower API caller classifies non-idempotent acknowledgement loss as commit-unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-api-ack-loss-"));
  const socketPath = join(dir, "bus.sock");
  let executions = 0;
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => {
      executions += 1;
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: true,
        result: { message_id: 77 },
      };
    },
    shouldDropResponse: () => true,
  });
  const callApi = createTelegramBusFollowerApiCaller({
    socketPath,
    instanceId: "inst-a",
    createRequestId: () => "inst-a:ack-loss:1",
    getRegistrationGeneration: () => "generation-a",
    timeoutMs: 100,
  });
  try {
    await server.start();
    await assert.rejects(
      () => callApi("call", ["sendMessage", { chat_id: 1, text: "hello" }]),
      isTelegramApiCommitUnknownError,
    );
    assert.equal(executions, 1);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower initial registration consumes a pending session handoff after acknowledgement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-handoff-"));
  const socketPath = join(dir, "bus.sock");
  const registrations: Array<{
    target: unknown;
    previousInstanceId: string | undefined;
  }> = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: createTelegramBusFollowerRegistry(),
      provisionFollowerTarget(registration) {
        registrations.push({
          target: registration.target,
          previousInstanceId: registration.previousInstanceId,
        });
        return { chatId: 1, threadId: 2, slot: "B", threadName: "Beryl" };
      },
    }),
  });
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "new-inst",
    createRequestId: () => "new-inst:1",
    registrationRetryAttempts: 1,
    registrationTimeoutMs: 50,
    registrationState: createTelegramBusFollowerRegistrationState(),
  });
  setTelegramFollowerSessionHandoff({
    pid: process.pid,
    instanceId: "old-inst",
    createdAtMs: Date.now(),
    target: { chatId: 1, threadId: 2 },
    slot: "B",
    threadName: "Beryl",
  });
  try {
    await assert.rejects(() =>
      follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
    );
    assert.equal(getTelegramFollowerSessionHandoff()?.instanceId, "old-inst");

    await server.start();
    assert.equal(
      await follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
      true,
    );
    assert.deepEqual(registrations, [
      {
        target: { chatId: 1, threadId: 2 },
        previousInstanceId: "old-inst",
      },
    ]);
    assert.equal(getTelegramFollowerSessionHandoff(), undefined);
  } finally {
    follower.stop();
    setTelegramFollowerSessionHandoff(undefined);
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower restore after session replacement reuses the preserved Thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-handoff-restore-"));
  const socketPath = join(dir, "bus.sock");
  const registrations: Array<{
    target: unknown;
    previousInstanceId: string | undefined;
  }> = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: createTelegramBusFollowerRegistry(),
      provisionFollowerTarget(registration) {
        registrations.push({
          target: registration.target,
          previousInstanceId: registration.previousInstanceId,
        });
        return { chatId: 1, threadId: 2, slot: "B", threadName: "Beryl" };
      },
    }),
  });
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "new-inst",
    createRequestId: () => "new-inst:restore:1",
    registrationState: createTelegramBusFollowerRegistrationState(),
  });
  setTelegramFollowerSessionHandoff({
    pid: process.pid,
    instanceId: "old-inst",
    createdAtMs: Date.now(),
    target: { chatId: 1, threadId: 2 },
    slot: "B",
    threadName: "Beryl",
  });
  try {
    await server.start();
    // A replaced session registers through the ordinary restore path, not only through connect recovery.
    assert.equal(
      await follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
        { restoreWorkspace: true },
      ),
      true,
    );
    assert.deepEqual(registrations, [
      {
        target: { chatId: 1, threadId: 2 },
        previousInstanceId: "old-inst",
      },
    ]);
  } finally {
    follower.stop();
    setTelegramFollowerSessionHandoff(undefined);
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower session replacement preserves a same-process handoff", async () => {
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(
    true,
    { chatId: 1, threadId: 2 },
    { slot: "B", threadName: "Beryl" },
  );
  const events: unknown[] = [];
  let suspended = false;
  const suspend = createTelegramBusFollowerSessionReplacementSuspender({
    registrationState,
    instanceId: "old-inst",
    async suspendPolling() {
      suspended = true;
      registrationState.setRegistered(false);
    },
    recordRuntimeEvent(category, message, details) {
      events.push({ category, message, details });
    },
    getPid: () => 10,
    getNowMs: () => 500,
  });

  await suspend();

  assert.equal(suspended, true);
  assert.equal(registrationState.isRegistered(), false);
  assert.deepEqual(getTelegramFollowerSessionHandoff(), {
    pid: 10,
    instanceId: "old-inst",
    createdAtMs: 500,
    target: { chatId: 1, threadId: 2 },
    slot: "B",
    threadName: "Beryl",
  });
  assert.deepEqual(events, [
    {
      category: "bus",
      message: "Telegram follower registration suspended for session replacement",
      details: {
        phase: "follower-session-handoff",
        instanceId: "old-inst",
        chatId: 1,
        threadId: 2,
      },
    },
  ]);
  await suspend(false);
  assert.equal(getTelegramFollowerSessionHandoff(), undefined, "Resume never hands off source target");
});

test("Bus session replacement preserves the promoted leader binding", async () => {
  const registrationState = createTelegramBusFollowerRegistrationState();
  const events: unknown[] = [];
  const suspend = createTelegramBusFollowerSessionReplacementSuspender({
    registrationState,
    instanceId: "promoted-inst",
    suspendPolling: async () => undefined,
    isLeader: () => true,
    getLeaderBinding: () => ({
      target: { chatId: 1, threadId: 3 },
      slot: "C",
      threadName: "Cinder",
    }),
    getActiveContext: () => ({ cwd: "/repo" }),
    getActiveProfileName: () => "work",
    recordRuntimeEvent(category, message, details) {
      events.push({ category, message, details });
    },
    getPid: () => 10,
    getNowMs: () => 500,
  });

  try {
    await suspend();
    assert.deepEqual(getTelegramLeaderSessionHandoff(), {
      pid: 10,
      instanceId: "promoted-inst",
      createdAtMs: 500,
      profileKey: "profile:work:cwd:/repo",
      target: { chatId: 1, threadId: 3 },
      slot: "C",
      threadName: "Cinder",
    });
    assert.deepEqual(events, [
      {
        category: "bus",
        message: "Telegram leader binding suspended for session replacement",
        details: {
          phase: "leader-session-handoff",
          instanceId: "promoted-inst",
          chatId: 1,
          threadId: 3,
          slot: "C",
          threadName: "Cinder",
        },
      },
    ]);
    await suspend(false);
    assert.equal(getTelegramLeaderSessionHandoff(), undefined, "Resume never hands off source target");
  } finally {
    setTelegramLeaderSessionHandoff(undefined);
  }
});

test("Bus follower session refresh re-registers with the handed-off target", async () => {
  const registrationState = createTelegramBusFollowerRegistrationState();
  const registrations: unknown[] = [];
  const events: unknown[] = [];
  setTelegramFollowerSessionHandoff({
    pid: process.pid,
    instanceId: "old-inst",
    createdAtMs: Date.now(),
    target: { chatId: 1, threadId: 2 },
    slot: "B",
    threadName: "Beryl",
  });
  const refresh = createTelegramBusFollowerSessionRefreshHook({
    registrationState,
    registrationRuntime: {
      async registerWithLeader(ctx, leader, options) {
        registrations.push({ ctx, leader, options });
        registrationState.setRegistered(
          true,
          options?.target,
          { slot: "B", threadName: "Beryl" },
        );
        return true;
      },
      setContext: () => undefined,
    },
    getLeaderState: () => ({
      kind: "active-elsewhere",
      lock: { pid: 20, busSocketPath: "/tmp/leader.sock" },
    }),
    updateStatus: () => undefined,
    recordRuntimeEvent(category, message, details) {
      events.push({ category, message, details });
    },
  });

  await refresh({}, { cwd: "/repo" });

  assert.deepEqual(registrations, [
    {
      ctx: { cwd: "/repo" },
      leader: { pid: 20, busSocketPath: "/tmp/leader.sock" },
      options: {
        target: { chatId: 1, threadId: 2 },
        previousInstanceId: "old-inst",
      },
    },
  ]);
  assert.equal(registrationState.isRegistered(), true);
  assert.deepEqual(registrationState.getTarget(), { chatId: 1, threadId: 2 });
  assert.equal(getTelegramFollowerSessionHandoff(), undefined);
  assert.deepEqual(events, [
    {
      category: "bus",
      message: "Telegram follower registration restored after session replacement",
      details: {
        phase: "follower-session-restore",
        previousInstanceId: "old-inst",
      },
    },
    {
      category: "bus",
      message: "Telegram follower session context refreshed",
      details: { phase: "follower-session-refresh" },
    },
  ]);
});

test("follower client runtime exposes authenticated queue handoff transport", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-follower-client-handoff-"));
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
        result: {
          status: "staged",
          receiptId: "receipt-1",
          sourceUpdateIds: [1],
          queueOwner: {
            instanceId: "recipient",
            processId: 202,
            processBirthId: "202:start:recipient",
            sessionGeneration: 2,
            acquisitionId: "recipient-acquisition",
            acquiredAtMs: 2_000,
          },
        },
      };
    },
  });
  const client = createTelegramBusFollowerClientRuntime<
    { cwd: string },
    unknown,
    unknown,
    unknown
  >({
    socketPath,
    instanceId: "donor",
    getApiAuthSecret: () => "secret",
    getRegistrationGeneration: () => "donor-generation",
  });
  try {
    await server.start();
    assert.deepEqual(
      await client.queueHandoff({
        recipientInstanceId: "recipient",
        recipientRegistrationGeneration: "recipient-generation",
        donorProcessId: 101,
        donorProcessBirthId: "101:start:donor",
        donorSessionGeneration: 1,
        donorAcquisitionId: "donor-acquisition",
        donorAcquiredAtMs: 1000,
        handoffToken: "x".repeat(32),
        payload: {
          kind: "prompt",
          chatId: 7,
          replyToMessageId: 10,
          queueOrder: 1,
          queueLane: "default",
          laneOrder: 1,
          statusSummary: "handoff",
          admissionReceipts: [
            { queueKind: "prompt", receiptId: "receipt-1", sourceUpdateIds: [1] },
          ],
          sourceMessageIds: [10],
          queuedAttachments: [],
          content: [{ type: "text", text: "handoff prompt" }],
          historyText: "handoff",
        },
      }),
      {
        status: "staged",
        receiptId: "receipt-1",
        sourceUpdateIds: [1],
        queueOwner: {
          instanceId: "recipient",
          processId: 202,
          processBirthId: "202:start:recipient",
          sessionGeneration: 2,
          acquisitionId: "recipient-acquisition",
          acquiredAtMs: 2_000,
        },
      },
    );
    assert.equal((received[0] as { auth?: string }).auth, "secret");
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("follower client defaults the forwarding timeout to the 30s bus window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-follower-timeout-"));
  const socketPath = join(dir, "bus.sock");
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: async (envelope) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
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
  const client = createTelegramBusFollowerClientRuntime<
    { cwd: string },
    unknown,
    unknown,
    unknown
  >({
    socketPath,
    instanceId: "inst-a",
    getRegistrationGeneration: () => "generation-a",
  });
  try {
    await server.start();
    const settlement = await client.foreignOwnedUpdateForwarder.forwardMessage({
      message: {
        message_id: 1,
        chat: { id: 7, type: "supergroup" },
        pi_telegram_source_update_id: 44,
      },
      ownership: {
        instanceId: "inst-a",
        ownerGeneration: "generation-a",
        recipientBindingKey: "manual:owner-a",
      },
      ctx: { cwd: "/repo" },
    });
    assert.deepEqual(settlement, {
      status: "accepted",
      delivery: createTelegramBusFollowerDeliveryIdentity({
        kind: "leader.forwardMessage",
        recipientBindingKey: "manual:owner-a",
        sourceUpdateId: 44,
      }),
    });
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("Production Restore context uses actual Pi lifetime and authenticated owner observations", () => {
  const ctx = { cwd: "/repo" };
  let active = true;
  let session = "session";
  let generation = 1;
  let secret: string | undefined = "fixture-secret";
  let profile: string | undefined = "profile:fixture";
  let kind: "active-elsewhere" | "active-here" | "stale" = "active-elsewhere";
  const lock = { pid: 123, instanceId: "leader", leaderEpoch: "epoch", busSecret: "fixture-secret" };
  const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: [TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE] });
  const get = createTelegramBusFollowerRestoreContextGetter({ isContextCurrent: value => active && value === ctx,
    getSessionId: () => session, getCwd: value => (value as typeof ctx).cwd, getGeneration: () => generation,
    getProfileBindingKey: () => profile, getOperatorUserId: () => 7,
    getLeaderState: () => ({ kind, lock }), getAuthenticatedSecret: () => secret, getLeaderProtocol: () => protocol });
  const observed = get(ctx)!;
  assert.deepEqual(observed, { executor: { instanceId: "leader", leaderEpoch: "epoch" },
    profileBindingKey: profile, operatorUserId: 7, sessionId: session, cwd: "/repo", generation: 1, leaderProtocol: protocol });
  assert.equal(get({ cwd: "/repo" }), undefined);
  for (const rejected of ["active-here", "stale"] as const) { kind = rejected; assert.equal(get(ctx), undefined); }
  kind = "active-elsewhere";
  secret = "old-secret";
  assert.equal(get(ctx), undefined);
  secret = undefined;
  assert.equal(get(ctx), undefined);
  secret = "fixture-secret";
  profile = undefined;
  assert.equal(get(ctx), undefined);
  profile = "profile:fixture";
  session = "successor-session";
  generation = 2;
  assert.equal(get(ctx)?.sessionId, session);
  assert.equal(get(ctx)?.generation, 2);
  assert.equal(observed.sessionId, "session", "earlier captured authority never changes with the live context");
  protocol.capabilities.length = 0;
  assert.equal(get(ctx), undefined);
  assert.equal(observed.leaderProtocol?.capabilities.includes(TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE), true);
  protocol.capabilities.push(TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE);
  active = false;
  assert.equal(get(ctx), undefined);
});

test("Live-rebind apply wire accepts only an exact nonempty selected group and non-dispatch mode", () => {
  const wire = { kind: "leader.applyLiveRebind", requestId: "control", recipientInstanceId: "old", recipientSessionId: "session",
    recipientRegistrationGeneration: "registration", recipientBindingKey: "recipient-journal", operationId: "operation",
    sourceUpdateIds: [100, 101], mode: "apply", sentAtMs: 1 };
  assert.equal(parseTelegramBusEnvelope(JSON.stringify(wire))?.kind, "leader.applyLiveRebind");
  for (const mode of ["release", "discard"]) assert.equal(parseTelegramBusEnvelope(JSON.stringify({ ...wire, kind: "leader.settleLiveRebind", mode }))?.kind, "leader.settleLiveRebind");
  assert.equal(parseTelegramBusEnvelope(JSON.stringify({ ...wire, kind: "leader.settleLiveRebind", mode: "observe", oldTarget: { chatId: 7, threadId: 10 } }))?.kind, "leader.settleLiveRebind");
  for (const oldTarget of [undefined, {}, { chatId: 7, threadId: "10" }]) assert.equal(parseTelegramBusEnvelope(JSON.stringify({ ...wire, kind: "leader.settleLiveRebind", mode: "observe", oldTarget })), undefined);
  for (const mode of ["apply", "inspect", "ready"]) assert.equal(parseTelegramBusEnvelope(JSON.stringify({ ...wire, kind: "leader.settleLiveRebind", mode })), undefined);
  for (const patch of [{ sourceUpdateIds: [] }, { sourceUpdateIds: [100, 100] }, { sourceUpdateIds: [-1] },
    { mode: "release" }, { mode: "ready" }, { recipientSessionId: "" }]) assert.equal(parseTelegramBusEnvelope(JSON.stringify({ ...wire, ...patch })), undefined);
});

for (const fault of ["normal", "not-saved", "not-committed", "save-only", "disabled", "source-group", "generation",
  "local-lost-reply", "owner-lost-before-effect", "lost-ack", "context-after-apply", "concurrent",
  "release", "release-busy", "release-next", "release-replaced-owner", "release-lost-ack", "release-owner-lost", "release-before-phase", "release-before-apply", "release-context",
  "release-no-capability", "release-disabled", "discard", "discard-next", "discard-partial", "discard-lost-ack", "discard-unknown", "discard-before-publication",
  "observe", "observe-work", "observe-delivery", "observe-unknown", "observe-context", "observe-wrong-target", "observe-before-release",
  "observe-after-admission", "observe-canonical-change", "observe-lost-ack", "observe-bad-ack", "observe-replaced-owner"] as const) {
  test(`Live-rebind peer lifecycle joins the saved carrier and canonical owner over native IPC (${fault})`, async () => {
    await fixture(async f => {
      const observing = fault.startsWith("observe");
      const settlement = fault.startsWith("release") || fault.startsWith("discard") || observing, discard = fault.startsWith("discard");
      let ctx = { cwd: "/repo" }, applyingSnapshot = false, applications = 0, ownerCalls = 0, appends = 0, dropped = 0, removals = 0;
      const busyEntered = Promise.withResolvers<void>(), busyDone = Promise.withResolvers<void>();
      let runningTarget: number | undefined, workCalls = 0, collecting = false;
      const workQueue = createTelegramQueueStore(), workTurn = createTelegramActiveTurnStore(), workLifecycle = createTelegramBridgeRuntime().lifecycle;
      const workPublication = createTelegramActivityPublicationRuntime(), workActivity = createTelegramActivityBridgeRuntime({ generation: "work" });
      const workApi = createTelegramApiTargetActivityRuntime();
      const workDelivery = createTelegramDeliveryRuntime({ generation: "work", getActiveTurnTarget: () => undefined,
        getInstanceTarget: () => undefined, getAggregateTarget: () => undefined, isExplicitTargetAuthorized: () => false,
        renderView: () => [], async sendChunk() { return 1; }, async editChunk() {}, async deleteMessage() {}, async sendChatAction() {} });
      workActivity.onSessionStart?.();
      const oldTurn: PendingTelegramTurn = { kind: "prompt", chatId: f.request.binding.target.chatId, target: f.request.binding.target,
        queueOrder: 1, queueLane: "default", laneOrder: 1, statusSummary: "old captured work", replyToMessageId: 1,
        sourceMessageIds: [1], queuedAttachments: [], content: [], historyText: "" };
      const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "test", capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
        TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SAVE, ...(fault === "save-only" ? [] : [TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY]),
        ...(fault === "release-no-capability" ? [] : [TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SETTLE])] });
      const registration = createTelegramBusFollowerRegistrationState();
      registration.setRegistered(true, f.request.binding.target, { slot: "A", generation: "registration", leaderProtocol: protocol });
      const sourcePath = join(dirname(f.path), "recipient.json"), botIdentity = createTelegramUpdateJournalBotIdentity({ botToken: "live-control-fixture" });
      const key = createTelegramUpdateJournalBindingKey({ path: sourcePath, profileName: "default", botIdentity });
      const journal = createTelegramUpdateJournalStore({ path: sourcePath, profileName: "default", botIdentity });
      const executed: number[] = [];
      let worker!: ReturnType<typeof createTelegramUpdateWorkerRuntime<typeof ctx>>;
      const lifecycle = createTelegramUpdateAdmissionLifecycleRuntime<typeof ctx>({
        resolveBinding: () => ({ runtimeKey: "live-control", recoveryKey: key, journal: { ...journal, appendBatch(updates) {
          appends++;
          if (fault === "discard-partial") { journal.appendBatch(updates.slice(0, 1)); throw new Error("Partial save"); }
          return journal.appendBatch(updates); }, removeCompletedExact(...args) {
            removals++;
            if (fault === "discard-before-publication") { ctx = { cwd: "/repo" }; return journal.removeCompletedExact(...args); }
            const result = journal.removeCompletedExact(...args);
            if (fault === "discard-unknown") throw new Error("Disposal reply lost after publication");
            return result;
          } } }),
        createWorker(source) { return worker = createTelegramUpdateWorkerRuntime({ journal: { ...source, read() {
          assert.equal(applyingSnapshot, false, "Source reads must not nest a journal transaction under canonical Workspace observation"); return source.read();
        } }, getJournalBindingKey: () => key, isContextCurrent: value => value === ctx, hasAuthority: () => true,
          async executeUpdate(update) { executed.push(update.update_id);
            if (update.update_id === 99) { runningTarget = registration.getTarget()?.threadId; busyEntered.resolve(); await busyDone.promise; }
            return { kind: "complete" }; } }); },
      });
      const ledger = createTelegramWorkspaceAdmissionLedger({ path: join(dirname(f.path), "admission.json"), profileKey: "scope",
        owner: { processId: process.pid, processBirthId: `${process.pid}:live-control` }, getProcessLiveness: () => "alive" });
      const targetOwner = createTelegramBusFollowerWorkspaceRestoreHandler({ instanceId: "old", getContextAuthority: () => ({
        executor: f.auth.executor, profileBindingKey: "scope", operatorUserId: 7, cwd: "/repo", sessionId: "session", generation: 1, leaderProtocol: protocol }),
        readRestoreIntent: () => { assert.fail("Live control must not inspect legacy Restore"); },
        readLiveRebindIntent: () => f.store.listLiveRebindings()[0], getWorkspaceAdmission: () => ({ ...ledger, releaseAdmission(lease) {
          const result = ledger.releaseAdmission(lease);
          if (collecting && fault === "observe-after-admission") workQueue.setQueuedItems([oldTurn]);
          if (collecting && fault === "observe-canonical-change") assert.ok(f.store.advanceLiveRebind(f.store.listLiveRebindings()[0]!, "not-issued", f.auth));
          return result;
        } }),
        topicTargetStore: { ...f.threads, withWorkspaceLiveRebindSnapshot(expected, observe) {
          applyingSnapshot = true; try { f.threads.withWorkspaceLiveRebindSnapshot(expected, observe); } finally { applyingSnapshot = false; }
        } }, registrationState: { ...registration, setRegistered(...args) {
          applications++; registration.setRegistered(...args); if (fault === "local-lost-reply") throw new Error("Local apply reply lost");
        } },
      });
      const entered = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>();
      const observeCurrentWork = createTelegramLiveTargetWorkObserver({ queue: workQueue, activeTurn: workTurn, lifecycle: workLifecycle,
        publication: workPublication, activity: workActivity, api: workApi, delivery: {
          hasPendingTarget: target => fault === "observe-unknown" ? undefined : workDelivery.hasPendingTarget?.(target),
        }, isIdle: () => worker.getState().phase !== "executing", hasPendingMessages: () => false, hasPendingControl: () => false });
      const runtime = createTelegramBusFollowerLiveRebindRuntime({ getAdmission: () => lifecycle,
        observeWork(target, context) {
          workCalls++;
          assert.deepEqual(target, f.request.binding.target, "The collector uses canonical old target, not a caller-selected namespace");
          const result = observeCurrentWork(target, context);
          if (fault === "observe-context") ctx = { cwd: "/repo" };
          return result;
        },
        async applyTarget(input, context) {
          assert.ok(input.liveRebind);
          assert.equal(Object.hasOwn(input.liveRebind, "expectedTarget"), false, "Ordinary input has no captured command target, not an undefined field or donor constraint");
          ownerCalls++;
          if (fault === "owner-lost-before-effect" && ownerCalls === 1) throw new Error("Apply owner reply lost before effect");
          if (fault === "concurrent" && input.mode === "apply") { entered.resolve(); await proceed.promise; }
          if (fault === "release-context" && input.liveRebind?.release) ctx = { cwd: "/repo" };
          const result = await targetOwner(input, context);
          if (fault === "release-owner-lost" && input.liveRebind?.release) throw new Error("Release owner reply lost after effect");
          if (fault === "context-after-apply") ctx = { cwd: "/repo" };
          return result;
        },
      });
      const socketPath = getTelegramBusFollowerSocketPath("old", dirname(f.path));
      const receiver = ["lost-ack", "release-lost-ack", "discard-lost-ack", "observe-lost-ack", "observe-bad-ack"].includes(fault) ? createRawTelegramBusLocalServer({ socketPath,
        async handleEnvelope(envelope) {
          assert.equal(envelope.auth, "secret");
          const result = envelope.kind === "leader.prepareLiveRebind" ? runtime.save(envelope, ctx, () => true)
            : envelope.kind === "leader.applyLiveRebind" ? await runtime.apply(envelope, ctx, () => true)
            : envelope.kind === "leader.settleLiveRebind" ? await runtime.settle(envelope, ctx, () => true) : assert.fail("Unexpected envelope");
          const response = fault === "observe-bad-ack" && "work" in result ? { ...result, work: { ...result.work, unknown: undefined } } : result;
          return { kind: "bus.ack", requestId: envelope.requestId, ok: true, result: response };
        }, shouldDropResponse(envelope) {
          if (fault === "observe-bad-ack" || (fault === "observe-lost-ack" && (envelope.kind !== "leader.settleLiveRebind" || envelope.mode !== "observe"))) return false;
          if (envelope.kind !== (fault === "lost-ack" ? "leader.applyLiveRebind" : "leader.settleLiveRebind") || dropped) return false;
          dropped++; return true;
        },
      }) : createTelegramBusForwardedUpdateReceiverRuntime({ socketPath, instanceId: "old", getAuthSecret: () => "secret",
        getRegistrationGeneration: registration.getGeneration, getRecipientBindingKey: () => "manual:old",
        getLiveRebindJournalBindingKey: () => key, getSessionId: () => "session",
        getContext: () => ctx, getLeaderProtocol: () => protocol, getLocalProtocol: () => protocol,
        isLiveRebindSaveEnabled: () => true, isLiveRebindApplyEnabled: () => fault !== "disabled",
        handleLiveRebindSave: runtime.save, handleLiveRebindApply: runtime.apply,
        isLiveRebindSettleEnabled: () => fault !== "release-disabled", handleLiveRebindSettle: runtime.settle,
        durableAdmission: { async admit() { assert.fail("Live control must not enter ordinary forwarding"); } },
      });
      let requestId = 0;
      const control = createTelegramBusLiveRebindController({ getFollower: () => ({ instanceId: "old", sessionId: "session", slot: "A",
        registrationGeneration: "registration", target: registration.getTarget(), busSocketPath: socketPath,
        protocol, connectedAtMs: 1, lastHeartbeatMs: 1 }), localProtocolIdentity: protocol,
        getAuthSecret: () => "secret", createRequestId: () => `control-${++requestId}`, timeoutMs: 1000 });
      const identity = { operationId: f.request.operationId, instanceId: "old", sessionId: "session", recipientBindingKey: key, isCurrent: () => true };
      const command = { ...identity, mode: "apply" as const, sourceUpdateIds: f.request.source.updateIds, slot: "A",
        target: f.request.target, oldTarget: f.request.binding.target };
      try {
        await lifecycle.onSessionStart(ctx); await worker.waitForDrain(); await receiver.start();
        if (fault === "release-busy") { journal.appendBatch([{ update_id: 99 }]); lifecycle.signal(); await busyEntered.promise; }
        if (fault !== "not-saved") assert.equal((await control({ ...identity, updates: f.request.source.updateIds.map(update_id => ({ update_id,
          message: { message_id: update_id, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false }, text: "held input" } })) }))?.status,
          fault === "discard-partial" ? undefined : "saved");
        if (settlement && discard) {
          const settleCommand = { ...command, mode: "discard" as const };
          if (fault === "discard-lost-ack") await assert.rejects(() => control(settleCommand), /Timed out|response|closed/);
          else assert.equal((await control(settleCommand))?.status,
            fault === "discard-before-publication" ? undefined : fault === "discard-unknown" ? "unknown" : "discarded");
          if (fault !== "discard-before-publication") {
            assert.equal((await control(settleCommand))?.status, fault === "discard-unknown" ? "unknown" : "discarded");
            assert.equal(removals, 1, "Lost/unknown disposal never issues another removal");
            assert.equal(await control({ ...command, mode: "release" }), undefined, "A disposal cannot become dispatch");
            if (fault === "discard-next") {
              assert.equal((await control({ ...identity, operationId: "next", updates: [{ update_id: 200 }] }))?.status, "saved");
              assert.equal(await control(settleCommand), undefined, "The old warm outcome cannot borrow a new carrier");
            }
          } else {
            assert.equal(removals, 1); assert.deepEqual(journal.read().entries.map(value => value.updateId), f.request.source.updateIds);
          }
          worker.signal(); await worker.waitForDrain(); assert.deepEqual(executed, []);
          assert.equal(applications, 0); assert.equal(appends, fault === "discard-next" ? 2 : 1); return;
        }
        if (fault !== "not-committed") assert.ok(await f.store.commitLiveRebind(f.request, recipient("follower"), f.auth));
        if (settlement) {
          if (observing) {
            assert.equal((await control(command))?.status, "applied");
            assert.ok(f.store.advanceLiveRebind(f.store.listLiveRebindings()[0]!, "release", f.auth));
            if (fault !== "observe-before-release") assert.equal((await control({ ...command, mode: "release" }))?.status, "released");
            await worker.waitForDrain();
            if (fault === "observe-work") workQueue.setQueuedItems([oldTurn]);
            const reservation = fault === "observe-delivery" ? workPublication.reserve() : undefined;
            const request = { ...command, mode: "observe" as const,
              oldTarget: fault === "observe-wrong-target" ? { ...f.request.binding.target, threadId: 99 } : f.request.binding.target };
            if (fault === "observe-replaced-owner") { await lifecycle.onSessionShutdown(); await lifecycle.onSessionStart(ctx); await worker.waitForDrain(); }
            const failed = ["observe-context", "observe-wrong-target", "observe-before-release", "observe-canonical-change", "observe-bad-ack", "observe-replaced-owner"].includes(fault);
            collecting = true;
            if (fault === "observe-lost-ack") await assert.rejects(() => control(request), /Timed out|response|closed/);
            else {
              const result = await control(request);
              if (failed) assert.equal(result, undefined);
              else {
                assert.ok(result && "work" in result);
                assert.deepEqual(result.work, { sessionBusy: false, targetWork: fault === "observe-work" || fault === "observe-after-admission",
                  deliveryPending: fault === "observe-delivery", unknown: fault === "observe-unknown" });
              }
            }
            collecting = false;
            if (!failed) {
              reservation?.cancel();
              if (reservation) await reservation.publish(async () => assert.fail("Cancelled publication"));
              const endApi = workApi.begin("sendMessage", { chat_id: f.request.binding.target.chatId, message_thread_id: f.request.binding.target.threadId });
              const fresh = await control(request); assert.ok(fresh && "work" in fresh);
              assert.equal(fresh.work.deliveryPending, true, "A later sample must not reuse the earlier idle result");
              assert.ok(workCalls >= 2); endApi();
            }
            assert.equal(appends, 1); assert.equal(applications, 1); assert.equal(removals, 0);
            if (["observe-wrong-target", "observe-before-release", "observe-canonical-change", "observe-replaced-owner"].includes(fault)) assert.equal(workCalls, 0);
            assert.deepEqual(executed, fault === "observe-before-release" ? [] : f.request.source.updateIds);
            return;
          }
          if (fault !== "release-before-apply") assert.equal((await control(command))?.status, "applied");
          if (fault !== "release-before-phase") assert.ok(f.store.advanceLiveRebind(f.store.listLiveRebindings()[0]!, "release", f.auth));
          const settleCommand = { ...command, mode: "release" as const };
          if (fault === "release-lost-ack") await assert.rejects(() => control(settleCommand), /Timed out|response|closed/);
          else assert.equal((await control(settleCommand))?.status,
            ["release-before-phase", "release-before-apply", "release-context", "release-no-capability", "release-disabled", "release-owner-lost"].includes(fault) ? undefined : "released");
          const released = ["release", "release-busy", "release-next", "release-replaced-owner", "release-lost-ack", "release-owner-lost"].includes(fault);
          if (released) {
            const calls = ownerCalls;
            assert.equal((await control(settleCommand))?.status, "released");
            assert.equal(ownerCalls, calls, "Warm release ACK does not reinspect journal or dispatch again");
            assert.equal(await control({ ...command, mode: "discard" }), undefined, "Released work cannot be disposed as a held copy");
            if (fault === "release-busy") {
              assert.deepEqual(executed, [99], "Release does not interrupt busy work"); assert.equal(runningTarget, f.request.binding.target.threadId);
              journal.appendBatch([{ update_id: 105 }]); lifecycle.signal(); busyDone.resolve();
            }
            await worker.waitForDrain();
            assert.deepEqual(executed, fault === "release-busy" ? [99, ...f.request.source.updateIds, 105] : f.request.source.updateIds);
            assert.deepEqual(journal.read().entries, [], "Ordinary completion owns the released source removal");
            if (fault === "release-next") {
              assert.equal((await control({ ...identity, operationId: "next", updates: [{ update_id: 200 }] }))?.status, "saved");
              assert.equal(await control(settleCommand), undefined);
            }
            if (fault === "release-replaced-owner") {
              await lifecycle.onSessionShutdown(); await lifecycle.onSessionStart(ctx); await worker.waitForDrain();
              assert.equal(await control(settleCommand), undefined, "A replacement worker cannot inherit the old warm release fact");
            }
          } else { worker.signal(); await worker.waitForDrain(); assert.deepEqual(executed, []); }
          assert.equal(appends, fault === "release-next" ? 2 : 1); assert.equal(f.store.listLiveRebindings()[0]!.phase, fault === "release-before-phase" ? "rebound" : "released");
          return;
        }
        if (fault === "source-group") command.sourceUpdateIds = [900];
        if (fault === "generation") registration.setRegistered(true, f.request.binding.target, { slot: "A", generation: "replacement", leaderProtocol: protocol });
        if (fault === "lost-ack") await assert.rejects(() => control(command), /Timed out|response|closed/);
        else if (fault === "concurrent") {
          const first = control(command); await entered.promise;
          assert.equal(await control({ ...command, mode: "inspect" }), undefined, "Concurrent control cannot borrow the applying carrier");
          proceed.resolve(); assert.equal((await first)?.status, "applied");
        } else assert.equal((await control(command))?.status, fault === "normal" ? "applied" : undefined);
        if (fault === "owner-lost-before-effect") {
          assert.equal((await control(command))?.status, "saved", "Unknown apply reobserves without a second setter even when still on old target");
          assert.equal(applications, 0);
        }
        if (["normal", "local-lost-reply", "lost-ack", "concurrent"].includes(fault)) {
          assert.equal((await control(command))?.status, "applied", "A repeated apply performs exact inspection, not another setter");
          assert.equal((await control({ ...command, mode: "inspect" }))?.status, "applied");
          assert.equal(applications, 1);
        } else assert.equal(applications, fault === "context-after-apply" ? 1 : 0);
        if (["not-saved", "save-only", "disabled", "source-group", "generation"].includes(fault)) assert.equal(ownerCalls, 0);
        assert.equal(appends, fault === "not-saved" ? 0 : 1);
        worker.signal(); await worker.waitForDrain();
        assert.deepEqual(executed, [], "Applied is not released or idle");
        assert.deepEqual(journal.read().entries.map(value => value.updateId), fault === "not-saved" ? [] : f.request.source.updateIds);
        if (fault !== "not-committed") assert.equal(f.store.listLiveRebindings()[0]!.phase, "rebound");
      } finally { proceed.resolve(); busyDone.resolve(); workPublication.reset(); workActivity.onSessionShutdown(); workDelivery.shutdown();
        await receiver.stop(); await lifecycle.onSessionShutdown(); }
    }, "follower");
  });
}

for (const boundary of ["ready", "busy", "before-ready", "local-disabled", "wrong-auth", "session-refresh", "journal-missing", "command-context", "command-context-pre-dispatch", "command-context-session-refresh", "command-context-registration-refresh", "command-context-canonical-change", "command-context-missing-canonical", "command-context-foreign-session", "command-context-inactive-canonical", "command-context-preparation-change", "consolidated", "consolidated-generation", "consolidated-registration", "consolidated-source", "consolidated-no-reader", "consolidated-reader-replaced", "consolidated-observe-generation", "consolidated-release-registration", "consolidated-release-source"] as const) {
  test(`Live-rebind follower assembly uses actual ready session, journal and target owners (${boundary})`, async () => {
    await fixture(async f => {
      const dir = dirname(f.path), leaderSocket = getTelegramBusFollowerSocketPath("leader", dir);
      const socketPath = getTelegramBusFollowerSocketPath("old", dir), ctx = { cwd: "/repo" };
      const commandContext = { ...ctx, waitForIdle: async () => {} };
      const consolidated = boundary.startsWith("consolidated");
      const connectContext = boundary.startsWith("command-context") || consolidated ? commandContext : ctx;
      let receiverContext: typeof ctx | undefined = boundary === "command-context-missing-canonical" ? undefined : ctx;
      const isContextCurrent = (value: typeof ctx) => value === commandContext ||
        (boundary !== "command-context-inactive-canonical" && value === receiverContext);
      const preparedContexts: typeof ctx[] = [];
      let generation = 1, authenticatedSecret = "secret", journalCurrent = true, appends = 0, applications = 0;
      const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "assembled", capabilities: [
        TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION, TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SAVE,
        TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY, TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SETTLE,
        "live-rebind-pre-dispatch-reader-v2", "live-rebind-pre-dispatch-v1"] });
      const localProtocol = boundary === "local-disabled" ? TEST_BUS_PROTOCOL_IDENTITY : protocol;
      const registration = createTelegramBusFollowerRegistrationState(), registry = createTelegramBusFollowerRegistry();
      const sourcePath = join(dir, "assembled-recipient.json"), botIdentity = createTelegramUpdateJournalBotIdentity({ botToken: "assembled" });
      const key = createTelegramUpdateJournalBindingKey({ path: sourcePath, profileName: "default", botIdentity });
      const journal = createTelegramUpdateJournalStore({ path: sourcePath, profileName: "default", botIdentity });
      const executed: number[] = [], entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
      let worker!: ReturnType<typeof createTelegramUpdateWorkerRuntime<typeof ctx>>, capturedOldTarget: unknown;
      const admission = createTelegramUpdateAdmissionLifecycleRuntime<typeof ctx>({
        resolveBinding: () => ({ runtimeKey: "assembled", recoveryKey: key, journal: { ...journal,
          appendBatch(updates) { appends++; return journal.appendBatch(updates); } } }),
        createWorker(source) { return worker = createTelegramUpdateWorkerRuntime({ journal: source,
          getJournalBindingKey: () => key, isContextCurrent, hasAuthority: () => true,
          async executeUpdate(update) {
            executed.push(update.update_id);
            if (update.update_id === 99) { capturedOldTarget = registration.getTarget(); entered.resolve(); await finish.promise; }
            return { kind: "complete" };
          } }); },
      });
      let restoreStore = f.store, observedStore = f.threads, restoreAuthority = f.auth;
      let publicationCaptures = 0, legacySnapshots = 0;
      const rootPath = join(dir, "assembled-state.json");
      const workspaceOwner = createTelegramLockRuntime({ statePath: rootPath, key: () => "default",
        instanceId: "leader", runtimeGeneration: 1, isProcessAlive: () => true });
      if (consolidated) {
        assert.equal(workspaceOwner.acquire({ cwd: "/leader" }).ok, true);
        const writer = {
          captureAuthority() {
            const epoch = workspaceOwner.getOwnedLeaderEpoch();
            return epoch === undefined ? undefined : () => workspaceOwner.owns() && workspaceOwner.getOwnedLeaderEpoch() === epoch;
          },
          publishIfOwned: workspaceOwner.publishStateSectionIfOwned!,
        };
        const storage = createTelegramConsolidatedWorkspaceStorage({ getPath: () => rootPath, getProfile: () => "default", ...writer });
        assert.equal(storage.capturePublication()!(() => ({ value: JSON.parse(readFileSync(f.path, "utf8")), result: true })).committed, true);
        const leaderStore = createTelegramTopicTargetStore({ path: rootPath, telegramProfile: "default", consolidated: writer, getNowMs: () => 1000 });
        await leaderStore.load();
        f.request.binding = leaderStore.listWorkspaceBindings()[0]!; f.request.owner = leaderStore.list()[0]!;
        restoreAuthority = { ...f.auth, executor: { instanceId: "leader", leaderEpoch: String(workspaceOwner.getOwnedLeaderEpoch()!) }, isCurrent: () => workspaceOwner.owns() };
        restoreStore = leaderStore.workspaceRestore({ profileName: "default", tokenSha256: "a".repeat(64), getNowMs: () => 1000 });
        observedStore = createTelegramTopicTargetStore({ path: rootPath, telegramProfile: "default", canPersist: () => false, getNowMs: () => 1000,
          consolidated: {
            captureAuthority() { publicationCaptures++; return undefined; },
            publishIfOwned() { assert.fail("A follower cannot publish Workspace or borrow the leader's authority"); },
          } });
        await observedStore.load();
      }
      const reader = observedStore.workspaceRestore({ profileName: "default", tokenSha256: "a".repeat(64), getNowMs: () => 1000 });
      const snapshotStore = { ...observedStore,
        async load() {
          await observedStore.load();
          if (boundary === "consolidated-reader-replaced") snapshotStore.withWorkspaceLiveRebindSnapshot = (...args) => observedStore.withWorkspaceLiveRebindSnapshot(...args);
        },
        withWorkspaceRestoreSnapshot(...args: Parameters<typeof observedStore.withWorkspaceRestoreSnapshot>) {
          legacySnapshots++; return observedStore.withWorkspaceRestoreSnapshot(...args);
        },
      };
      const ledger = createTelegramWorkspaceAdmissionLedger({ path: join(dir, "assembled-admission.json"), profileKey: "scope",
        owner: { processId: process.pid, processBirthId: `${process.pid}:assembled` }, getProcessLiveness: () => "alive" });
      const targetOwner = createTelegramBusFollowerWorkspaceRestoreHandler<typeof ctx>({ instanceId: "old",
        getContextAuthority: createTelegramBusFollowerRestoreContextGetter<typeof ctx>({
          isContextCurrent: value => value === ctx, getSessionId: () => "session", getCwd: value => value.cwd,
          getGeneration: () => generation, getProfileBindingKey: () => ledger.getProfileKey(), getOperatorUserId: () => 7,
          getAuthenticatedSecret: () => authenticatedSecret, getLeaderProtocol: registration.getLeaderProtocol,
          getLeaderState: () => ({ kind: "active-elsewhere", lock: { pid: process.pid, cwd: "/leader", heartbeatMs: 1,
            ...restoreAuthority.executor, busSecret: "secret" } }),
          capability: TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY,
        }),
        readRestoreIntent() { assert.fail("Live composition must not consume legacy Restore"); },
        readLiveRebindIntent: (id, profile) => profile === ledger.getProfileKey()
          ? reader.listLiveRebindings().find(intent => intent.request.operationId === id) : undefined,
        topicTargetStore: snapshotStore, getWorkspaceAdmission: () => ledger,
        registrationState: { ...registration, setRegistered(...args) { applications++; registration.setRegistered(...args); } },
      });
      const queue = createTelegramQueueStore(), activeTurn = createTelegramActiveTurnStore();
      const workLifecycle = createTelegramBridgeRuntime().lifecycle, publication = createTelegramActivityPublicationRuntime();
      const activity = createTelegramActivityBridgeRuntime({ generation: "assembled" }); activity.onSessionStart?.();
      const api = createTelegramApiTargetActivityRuntime();
      const delivery = createTelegramDeliveryRuntime({ generation: "assembled", getActiveTurnTarget: () => undefined,
        getInstanceTarget: () => undefined, getAggregateTarget: () => undefined, isExplicitTargetAuthorized: () => false,
        renderView: () => [], async sendChunk() { return 1; }, async editChunk() {}, async deleteMessage() {}, async sendChatAction() {} });
      const peer = createTelegramBusFollowerLiveRebindRuntime<typeof ctx>({ getAdmission: current => current === ctx ? admission : undefined,
        applyTarget: targetOwner, observeWork: createTelegramLiveTargetWorkObserver({ queue, activeTurn, lifecycle: workLifecycle,
          publication, activity, api, delivery: { hasPendingTarget: target => delivery.hasPendingTarget?.(target) },
          isIdle: () => worker.getState().phase !== "executing", hasPendingMessages: () => false, hasPendingControl: () => false }) });
      let sequence = 0;
      const errors: string[] = [];
      const assembly = createTelegramBusFollowerRuntimeAssembly({ instanceId: "old", registrationState: registration,
        failureLog: createTelegramFailureRunLog({
          category: "bus",
          failurePhase: "follower-heartbeat",
          outcomePhase: "follower-heartbeat-recovered",
          label: "follower heartbeat",
          record: () => {},
        }),
        recordRuntimeEvent(_category, error) { errors.push(String(error)); }, receiver: { socketPath, getContext: () => receiverContext, getAuthSecret: () => authenticatedSecret,
          getRecipientBindingKey: () => "manual:old", getLiveRebindJournalBindingKey: () => journalCurrent ? admission.getJournalBindingKey() : undefined,
          getSessionId: (): string | undefined => assembly.getReadySessionId(), getLeaderProtocol: registration.getLeaderProtocol, getLocalProtocol: () => localProtocol,
          isLiveRebindSaveEnabled: () => true, isLiveRebindApplyEnabled: () => true, isLiveRebindSettleEnabled: () => true,
          handleLiveRebindSave: peer.save, handleLiveRebindApply: peer.apply, handleLiveRebindSettle: peer.settle,
          durableAdmission: { async admit() { assert.fail("Live composition cannot use ordinary forwarding"); } },
        }, recovery: { getLeaderState: () => ({ kind: "inactive" }), setLifecyclePhase() {}, updateStatus() {}, promoteToLeader: async () => false },
        registration: { protocolIdentity: localProtocol, getFollowerBusSocketPath: () => socketPath,
          createRequestId: () => `assembly-${++sequence}`, getProfileKey: () => "manual:old",
          getSessionId: current => boundary === "command-context-foreign-session" && current === receiverContext ? "foreign-session" : "session",
          getSessionGeneration: () => generation, isContextActive: isContextCurrent,
          setActiveAuthSecret: secret => { authenticatedSecret = secret ?? ""; },
          async onRegistered(current) {
            preparedContexts.push(current); await admission.onSessionStart(current);
            if (boundary === "command-context-preparation-change") receiverContext = { ...ctx };
          },
        },
      });
      const leader = createRawTelegramBusLocalServer({ socketPath: leaderSocket,
        handleEnvelope: createRawTelegramBusLeaderEnvelopeHandler({ followerRegistry: registry, protocolIdentity: protocol,
          authSecret: "secret", provisionFollowerTarget: () => ({ ...f.request.binding.target, slot: "A" }) }) });
      const sendControl = createTelegramBusLiveRebindController({ getFollower: registry.get, localProtocolIdentity: protocol,
        getAuthSecret: () => boundary === "wrong-auth" ? "foreign" : "secret", createRequestId: () => `live-${++sequence}`, timeoutMs: 1000 });
      const control = async (input: Parameters<typeof sendControl>[0]) => {
        const bytes = consolidated ? readFileSync(rootPath, "utf8") : undefined;
        try { return await sendControl(input); }
        finally { if (bytes !== undefined) assert.equal(readFileSync(rootPath, "utf8"), bytes, "Follower control must not publish even an unchanged Workspace"); }
      };
      const identity = { operationId: f.request.operationId, instanceId: "old", sessionId: "session", recipientBindingKey: key, isCurrent: () => true };
      const command = { ...identity, mode: "apply" as const, sourceUpdateIds: f.request.source.updateIds, slot: "A",
        target: f.request.target, oldTarget: f.request.binding.target };
      try {
        await leader.start();
        if (["command-context-missing-canonical", "command-context-foreign-session", "command-context-inactive-canonical"].includes(boundary)) {
          await assert.rejects(() => assembly.registration.registerWithLeader(connectContext,
            { busSocketPath: leaderSocket, busSecret: "secret" }), /current canonical context/);
          assert.equal(assembly.getReadySessionId(), undefined); assert.equal(registration.isRegistered(), false);
          assert.deepEqual(preparedContexts, []); assert.equal(appends, 0); assert.equal(applications, 0);
          assert.deepEqual(journal.read().entries, []); return;
        }
        assert.equal(await assembly.registration.registerWithLeader(connectContext, { busSocketPath: leaderSocket, busSecret: "secret" }), true);
        await worker.waitForDrain();
        if (boundary === "command-context-preparation-change") {
          assert.equal(assembly.getReadySessionId(), undefined, "An awaited preparation cannot publish a replaced canonical context");
          assert.equal(await control({ ...identity, updates: f.request.source.updateIds.map(update_id => ({ update_id,
            message: { message_id: update_id, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false }, text: "held input" } })) }), undefined);
          assert.deepEqual(preparedContexts, [ctx]); assert.equal(appends, 0); assert.equal(applications, 0);
          assert.deepEqual(journal.read().entries, []); return;
        }
        assert.equal(assembly.getReadySessionId(), "session");
        assert.equal(registry.get("old")?.profileKey, "manual:old");
        if (boundary === "before-ready") generation++;
        if (boundary === "busy") { journal.appendBatch([{ update_id: 99 }]); admission.signal(); await entered.promise; }
        const saved = await control({ ...identity, updates: f.request.source.updateIds.map(update_id => ({ update_id,
          message: { message_id: update_id, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false }, text: "held input" } })) });
        if (["before-ready", "local-disabled", "wrong-auth"].includes(boundary)) {
          assert.equal(saved, undefined); assert.equal(appends, 0); assert.equal(applications, 0); assert.deepEqual(journal.read().entries, []); return;
        }
        assert.equal(saved?.status, "saved", errors.join("\n")); assert.equal(appends, 1);
        assert.equal(preparedContexts[0], ctx, "Binding preparation uses the receiver's canonical session context, not Connect's command object");
        if (boundary === "command-context") {
          await assembly.registration.setContext(commandContext);
          assert.equal(preparedContexts.length, 1, "Same-session command refresh cannot replace held input's worker");
        }
        assert.equal((await control({ ...identity, updates: f.request.source.updateIds.map(update_id => ({ update_id,
          message: { message_id: update_id, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false }, text: "held input" } })) }))?.status, "saved");
        assert.equal(appends, 1, "Repeated save only observes the same retained carrier");
        if (boundary === "session-refresh" || boundary === "command-context-session-refresh") generation++;
        if (boundary === "command-context-registration-refresh") registration.setRegistered(true, f.request.binding.target,
          { slot: "A", generation: "replacement-registration", leaderProtocol: protocol });
        if (boundary === "command-context-canonical-change") receiverContext = { ...ctx };
        if (boundary === "journal-missing") journalCurrent = false;
        const preDispatch = boundary === "command-context-pre-dispatch" || consolidated;
        const intent = await restoreStore.commitLiveRebind(f.request, { ...recipient("follower"), generation: registration.getGeneration()! }, restoreAuthority,
          preDispatch ? { holdInput: true } : undefined);
        assert.ok(intent);
        if (boundary === "consolidated-generation") generation++;
        if (boundary === "consolidated-registration") registration.setRegistered(true, f.request.binding.target,
          { slot: "A", generation: "replacement-registration", leaderProtocol: protocol });
        if (boundary === "consolidated-source") command.sourceUpdateIds = [999];
        if (boundary === "consolidated-no-reader") Reflect.deleteProperty(snapshotStore, "withWorkspaceLiveRebindSnapshot");
        const applied = await control(command);
        if (["session-refresh", "journal-missing", "command-context-session-refresh", "command-context-registration-refresh", "command-context-canonical-change", "consolidated-generation", "consolidated-registration", "consolidated-source", "consolidated-no-reader", "consolidated-reader-replaced"].includes(boundary)) {
          assert.equal(applied, undefined); assert.equal(applications, 0); assert.deepEqual(registration.getTarget(), f.request.binding.target);
          assert.deepEqual(journal.read().entries.map(entry => entry.updateId), f.request.source.updateIds);
          assert.equal(publicationCaptures, 0); assert.equal(legacySnapshots, 0); assert.deepEqual(executed, []); return;
        }
        assert.equal(applied?.status, "applied", errors.join("\n")); assert.equal(applications, 1);
        assert.equal((await control(command))?.status, "applied"); assert.equal(applications, 1);
        let released = restoreStore.advanceLiveRebind(intent, "release", restoreAuthority)!; assert.ok(released);
        if (preDispatch) {
          if (boundary === "consolidated-observe-generation") {
            generation++;
            assert.equal(await control({ ...command, mode: "observe-held" }), undefined);
            assert.deepEqual(executed, []); assert.deepEqual(journal.read().entries.map(entry => entry.updateId), f.request.source.updateIds);
            assert.deepEqual(registration.getTarget(), f.request.target, "Refusal cannot roll back an already applied canonical target");
            assert.equal(publicationCaptures, 0); assert.equal(legacySnapshots, 0); return;
          }
          const heldWork = await control({ ...command, mode: "observe-held" }); assert.equal(heldWork?.status, "observed");
          assert.deepEqual(executed, [], "A confirmed binding and read-only work observation cannot execute held input");
          assert.equal(await control({ ...command, mode: "release" }), undefined, "Held input requires its independent durable grant");
          released = restoreStore.advanceLiveRebind(released, "issue-input", restoreAuthority)!; assert.ok(released);
        }
        if (boundary === "consolidated-release-registration" || boundary === "consolidated-release-source") {
          if (boundary === "consolidated-release-registration") registration.setRegistered(true, f.request.target,
            { slot: "A", generation: "replacement-registration", leaderProtocol: protocol });
          else command.sourceUpdateIds = [999];
          assert.equal(await control({ ...command, mode: "release" }), undefined);
          assert.deepEqual(executed, []); assert.deepEqual(journal.read().entries.map(entry => entry.updateId), f.request.source.updateIds);
          assert.equal(appends, 1); assert.equal(applications, 1); assert.equal(publicationCaptures, 0); assert.equal(legacySnapshots, 0); return;
        }
        assert.equal((await control({ ...command, mode: "release" }))?.status, "released");
        if (preDispatch) assert.ok(restoreStore.advanceLiveRebind(released, "accept-input", restoreAuthority));
        const observed = await control({ ...command, mode: "observe" }); assert.equal(observed?.status, "observed");
        if (!observed || !("work" in observed)) assert.fail("Missing authenticated work sample");
        assert.equal(observed.work.unknown, false);
        if (boundary === "busy") {
          assert.deepEqual(capturedOldTarget, f.request.binding.target); assert.equal(observed.work.sessionBusy, true);
          assert.deepEqual(executed, [99], "Selected group waits for existing work");
        }
        finish.resolve(); await worker.waitForDrain();
        assert.deepEqual(executed, boundary === "busy" ? [99, 100, 101] : [100, 101]);
        assert.equal((await control({ ...command, mode: "release" }))?.status, "released");
        assert.equal(appends, 1); assert.equal(applications, 1); assert.deepEqual(journal.read().entries, []);
        assert.equal(publicationCaptures, 0); assert.equal(legacySnapshots, 0, "Live observation must never fall back to the publication-backed Restore snapshot");
      } finally {
        finish.resolve(); assembly.registration.stop(); await assembly.receiver.stop(); await leader.stop();
        await admission.onSessionShutdown(); await activity.onSessionShutdown?.();
        if (consolidated) workspaceOwner.release();
      }
    }, "follower");
  });
}

test("Live-rebind context capability does not borrow legacy Restore negotiation", () => {
  const ctx = { cwd: "/repo" };
  const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "test", capabilities: [TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY] });
  const ports = { isContextCurrent: (value: typeof ctx) => value === ctx, getSessionId: () => "session", getCwd: (value: typeof ctx) => value.cwd,
    getGeneration: () => 1, getProfileBindingKey: () => "scope", getOperatorUserId: () => 7,
    getLeaderState: () => ({ kind: "active-elsewhere" as const, lock: { pid: 1, instanceId: "leader", leaderEpoch: "epoch", busSecret: "secret" } }),
    getAuthenticatedSecret: () => "secret", getLeaderProtocol: () => protocol };
  assert.equal(createTelegramBusFollowerRestoreContextGetter(ports)(ctx), undefined);
  const get = createTelegramBusFollowerRestoreContextGetter({ ...ports, capability: TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY });
  assert.ok(get(ctx));
  protocol.capabilities = [TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE];
  assert.equal(get(ctx), undefined);
});

for (const mode of ["apply", "inspect"] as const) {
  for (const fault of ["normal", "missing-intent", "legacy-intent", "source-group", "source-lost", "source-after-load", "recipient", "executor", "binding", "local-target", "future-current", "future-wrong", "future-copy", "future-all", "future-fraction", "future-foreign", "scope-swap"] as const) {
    test(`Live-rebind canonical target owner preserves the input barrier (${mode}, ${fault})`, async () => {
      await fixture(async f => {
        const ctx = { cwd: "/repo" }, key = "recipient-journal";
        const journal = createTelegramUpdateJournalStore({ path: join(dirname(f.path), "recipient.json"), profileName: "default",
          botIdentity: createTelegramUpdateJournalBotIdentity({ botToken: "live-apply-fixture" }) });
        const executed: number[] = [];
        let sourceCurrent = true;
        const worker = createTelegramUpdateWorkerRuntime<typeof ctx>({ journal, getJournalBindingKey: () => key,
          hasAuthority: () => true, executeUpdate(update) { executed.push(update.update_id); return { kind: "complete" }; } });
        worker.start(ctx); await worker.waitForDrain();
        const held = worker.prepareLiveInput!(ctx, f.request.source.updateIds)!;
        journal.appendBatch(f.request.source.updateIds.map(update_id => ({ update_id }))); assert.equal(held.confirmSaved(), true);
        const live = (await f.store.commitLiveRebind(f.request, recipient("follower"), f.auth))!;
        const registration = createTelegramBusFollowerRegistrationState();
        const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "test", capabilities: [TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY] });
        registration.setRegistered(true, f.request.binding.target, { slot: "A", generation: "registration", leaderProtocol: protocol });
        if (fault === "local-target") registration.setRegistered(true, { chatId: 7, threadId: 99 },
          { slot: "A", generation: "registration", leaderProtocol: protocol });
        if (fault === "source-lost") sourceCurrent = false;
        let applications = 0;
        const authority = { executor: f.auth.executor, profileBindingKey: "scope", operatorUserId: 7,
          cwd: "/repo", sessionId: "session", generation: 1, leaderProtocol: protocol };
        const handle = createTelegramBusFollowerWorkspaceRestoreHandler({ instanceId: "old", getContextAuthority: () => authority,
          readRestoreIntent: () => { assert.fail("Live apply cannot borrow legacy Restore intent"); },
          readLiveRebindIntent() {
            if (fault === "missing-intent") return undefined;
            if (fault === "legacy-intent") return { ...live, kind: undefined } as unknown as typeof live;
            if (fault === "recipient") return { ...live, recipient: { ...live.recipient, instanceId: "foreign" } };
            if (fault === "executor") return { ...live, executor: { ...live.executor, leaderEpoch: "foreign" } };
            if (fault === "binding") return { ...live, request: { ...live.request, target: { chatId: 7, threadId: 99 } } };
            return f.store.listLiveRebindings().find(value => value.request.operationId === f.request.operationId);
          },
          topicTargetStore: { ...f.threads, async load() { await f.threads.load(); if (fault === "source-after-load") sourceCurrent = false;
            if (fault === "future-copy") request.liveRebind.expectedTarget!.threadId = 99;
            if (fault === "scope-swap") request.liveRebind.isCurrent = () => true;
          } },
          registrationState: { ...registration, setRegistered(...args) { applications++; registration.setRegistered(...args); } },
          getWorkspaceAdmission: () => createTelegramWorkspaceAdmissionLedger({ path: join(dirname(f.path), "admission.json"),
            profileKey: "scope", owner: { processId: process.pid, processBirthId: `${process.pid}:live-apply` }, getProcessLiveness: () => "alive" }),
        });
        const request = { operationId: f.request.operationId, registrationGeneration: "registration", mode,
          liveRebind: { sourceUpdateIds: fault === "source-group" ? [900] : held.sourceUpdateIds,
            expectedTarget: fault.startsWith("future-") ? { chatId: fault === "future-foreign" ? 8 : 7,
              threadId: fault === "future-wrong" ? 99 : fault === "future-fraction" ? 42.5 : fault === "future-all" ? 0 : f.request.target.threadId } : undefined,
            isCurrent: () => sourceCurrent && held.confirmSaved() } };
        try {
          if (["normal", "future-current", "future-copy"].includes(fault)) {
            const result = await handle(request, ctx);
            assert.equal(result.ready, mode === "apply");
            assert.deepEqual(result.target, mode === "apply" ? f.request.target : f.request.binding.target);
            assert.equal(applications, mode === "apply" ? 1 : 0);
            const observed = await handle({ ...request, mode: "inspect", liveRebind: { ...request.liveRebind,
              expectedTarget: fault === "future-copy" ? { ...f.request.target } : request.liveRebind.expectedTarget } }, ctx);
            assert.equal(observed.ready, mode === "apply");
            assert.equal(applications, mode === "apply" ? 1 : 0, "Inspection cannot reissue local apply");
          } else {
            await assert.rejects(() => handle(request, ctx));
            assert.equal(applications, 0);
          }
          assert.equal(held.confirmSaved(), true);
          worker.signal(); await worker.waitForDrain();
          assert.deepEqual(executed, [], "Local target application is not dispatch readiness");
          assert.deepEqual(journal.read().entries.map(value => value.updateId), f.request.source.updateIds);
        } finally { await worker.stop(); }
      }, "follower");
    });
  }
}

for (const fault of ["current", "release-swap", "observer-swap"] as const) {
  test(`Live-rebind release scope captures callable owners before target awaits (${fault})`, async () => {
    await fixture(async f => {
      const intent = (await f.store.commitLiveRebind(f.request, recipient("follower"), f.auth))!;
      f.store.advanceLiveRebind(intent, "release", f.auth);
      const registration = createTelegramBusFollowerRegistrationState(), protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "fixture",
        capabilities: [TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY, TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SETTLE] });
      registration.setRegistered(true, f.request.target, { slot: "A", generation: "registration", leaderProtocol: protocol });
      let releases = 0, replacements = 0, observations = 0;
      const scope = { sourceUpdateIds: f.request.source.updateIds, expectedTarget: { ...f.request.target }, isCurrent: () => true,
        release(canRelease: () => boolean) { assert.equal(canRelease(), true); releases++; }, observeWork() { observations++; } };
      const handler = createTelegramBusFollowerWorkspaceRestoreHandler({ instanceId: "old", getContextAuthority: () => ({ executor: f.auth.executor,
        profileBindingKey: "scope", operatorUserId: 7, cwd: "/repo", sessionId: "session", generation: 1, leaderProtocol: protocol }),
        readRestoreIntent: () => undefined, readLiveRebindIntent: () => f.store.listLiveRebindings()[0],
        topicTargetStore: { ...f.threads, async load() { await f.threads.load(); if (fault === "release-swap") scope.release = () => { replacements++; };
          if (fault === "observer-swap") scope.observeWork = () => { replacements++; }; } }, registrationState: registration,
        getWorkspaceAdmission: () => createTelegramWorkspaceAdmissionLedger({ path: `${f.path}.scope-admission`, profileKey: "scope",
          owner: { processId: process.pid, processBirthId: `${process.pid}:scope` }, getProcessLiveness: () => "alive" }) });
      const request = { operationId: f.request.operationId, registrationGeneration: "registration", mode: "inspect" as const, liveRebind: scope };
      if (fault === "current") { assert.equal((await handler(request, {})).ready, true); assert.equal(releases, 1); assert.equal(observations, 1); }
      else { await assert.rejects(() => handler(request, {})); assert.equal(releases, 0); assert.equal(observations, 0); }
      assert.equal(replacements, 0); assert.deepEqual(registration.getTarget(), f.request.target);
      assert.equal(f.store.listLiveRebindings()[0]!.phase, "released");
    }, "follower");
  });
}

test("Live-rebind local target lost reply is inspected against canonical state without another apply", async () => {
  await fixture(async f => {
    const intent = (await f.store.commitLiveRebind(f.request, recipient("follower"), f.auth))!;
    const registration = createTelegramBusFollowerRegistrationState();
    const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "test", capabilities: [TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY] });
    registration.setRegistered(true, f.request.binding.target, { slot: "A", generation: "registration", leaderProtocol: protocol });
    let applications = 0;
    const handle = createTelegramBusFollowerWorkspaceRestoreHandler({ instanceId: "old", getContextAuthority: () => ({
      executor: f.auth.executor, profileBindingKey: "scope", operatorUserId: 7, cwd: "/repo", sessionId: "session", generation: 1, leaderProtocol: protocol }),
      readRestoreIntent: () => undefined, readLiveRebindIntent: () => f.store.listLiveRebindings()[0], topicTargetStore: f.threads,
      registrationState: { ...registration, setRegistered(...args) { applications++; registration.setRegistered(...args); throw new Error("Local apply reply lost"); } },
      getWorkspaceAdmission: () => createTelegramWorkspaceAdmissionLedger({ path: join(dirname(f.path), "admission.json"),
        profileKey: "scope", owner: { processId: process.pid, processBirthId: `${process.pid}:live-apply` }, getProcessLiveness: () => "alive" }),
    });
    const request = { operationId: intent.request.operationId, registrationGeneration: "registration", mode: "apply" as const,
      liveRebind: { sourceUpdateIds: intent.request.source.updateIds, isCurrent: () => true } };
    await assert.rejects(() => handle(request, {}), /reply lost/);
    assert.equal((await handle({ ...request, mode: "inspect" }, {})).ready, true);
    assert.equal(applications, 1);
    assert.equal(f.store.listLiveRebindings()[0]!.phase, "rebound", "Local apply never advances leader-owned metadata");
  }, "follower");
});

for (const mode of ["apply", "inspect"] as const) for (const fault of ["context", "target", "slot"] as const) {
  test(`Follower Restore acknowledgement recaptures authority after admission release (${mode}, ${fault})`, async () => {
    await fixture(async ({ store, threads, request, auth, path }) => {
      const relocated = (await store.commit(request, auth))!;
      const issued = store.issueRecipient(relocated, recipient("follower"), auth)!.intent;
      const registration = createTelegramBusFollowerRegistrationState();
      const initial = mode === "apply" ? request.binding.target : request.target;
      registration.setRegistered(true, initial, { generation: "registration", slot: "A" });
      const scope = { executor: auth.executor, profileBindingKey: "profile:restore", operatorUserId: 7,
        sessionId: "session", cwd: "/repo", generation: 1 };
      const ledger = createTelegramWorkspaceAdmissionLedger({ path: `${path}.release-admission`, profileKey: scope.profileBindingKey,
        owner: { processId: process.pid, processBirthId: `${process.pid}:released-recipient` }, getProcessLiveness: () => "alive" });
      let applications = 0;
      const handle = createTelegramBusFollowerWorkspaceRestoreHandler({ instanceId: "old", getContextAuthority: () => ({ ...scope }),
        readRestoreIntent: id => store.list().find(intent => intent.request.operationId === id), topicTargetStore: threads,
        getWorkspaceAdmission: () => ({ ...ledger, releaseAdmission(input) {
          const result = ledger.releaseAdmission(input);
          if (fault === "context") scope.generation++;
          if (fault === "target") registration.setRegistered(true, { chatId: 7, threadId: 99 }, { generation: "registration", slot: "A" });
          if (fault === "slot") registration.setRegistered(true, request.target, { generation: "registration", slot: "B" });
          return result;
        } }), registrationState: { ...registration, setRegistered(...args) { applications++; registration.setRegistered(...args); } } });
      const before = await readFile(path, "utf8");
      await assert.rejects(handle({ operationId: request.operationId, registrationGeneration: "registration", mode }, {}), /Stale Telegram follower Restore authority|changed after admission release/);
      assert.equal(applications, mode === "apply" ? 1 : 0, "a refused ACK does not roll back a separately applied local target");
      assert.equal(await readFile(path, "utf8"), before); assert.deepEqual(store.list(), [issued]);
      assert.deepEqual(ledger.read().leases, []);
    }, "follower");
  });
}

for (const mode of ["apply", "inspect-old", "inspect-new", "session", "cwd", "operator", "context", "generation", "executor", "recipient", "relocated", "ready-old", "slot", "cached-binding", "intent", "fence"] as const) {
  test(`Proof-aware follower Restore consumes canonical relocation without writing it (${mode})`, async () => {
    await fixture(async ({ store, threads, request, auth, path }) => {
      const relocated = await store.commit(request, auth);
      const issued = mode === "relocated" ? relocated! : store.issueRecipient(relocated!,
        { ...recipient("follower"), generation: mode === "recipient" ? "previous" : "registration" }, auth)!.intent;
      if (mode === "ready-old") store.confirmReady(issued, recipient("follower"), auth);
      const registration = createTelegramBusFollowerRegistrationState();
      registration.setRegistered(true, mode === "inspect-new" ? request.target : request.binding.target,
        { generation: mode === "generation" ? "other" : "registration", slot: mode === "slot" ? "B" : "A" });
      const scope = { executor: mode === "executor" ? { instanceId: "other", leaderEpoch: "other" } : auth.executor,
        profileBindingKey: "profile:restore", operatorUserId: mode === "operator" ? 8 : 7, cwd: mode === "cwd" ? "/other" : "/repo",
        sessionId: mode === "session" ? "other" : "session", generation: 1 };
      const ledger = createTelegramWorkspaceAdmissionLedger({ path: join(dirname(path), "admission.json"),
        profileKey: scope.profileBindingKey, owner: { processId: process.pid, processBirthId: `${process.pid}:restore-test` },
        getProcessLiveness: () => "alive" });
      if (mode === "fence") assert.equal(ledger.acquireRetirementFence({ operationId: "fence",
        retirementIntentId: "retirement", bindingKey: request.binding.bindingKey, slot: "A",
        target: request.binding.target, leaderEpoch: 1, retirementRequestedAtMs: 1 }).kind, "acquired");
      let applications = 0;
      let reads = 0;
      const handle = createTelegramBusFollowerWorkspaceRestoreHandler({ instanceId: "old",
        getContextAuthority: () => ({ ...scope }), getWorkspaceAdmission: () => ledger,
        readRestoreIntent(id, profile) {
          reads += 1;
          assert.equal(profile, scope.profileBindingKey);
          return store.list().find(value => value.request.operationId === id);
        },
        topicTargetStore: { ...threads, async load() {
          await threads.load();
          if (mode === "context") scope.generation += 1;
          if (mode === "cached-binding") threads.upsertWorkspaceBinding({ ...threads.listWorkspaceBindings()[0]!, target: { chatId: 7, threadId: 99 } });
          if (mode === "intent") {
            store.adopt(issued, { ...auth, executor: { instanceId: "next", leaderEpoch: "next" } });
            before = await readFile(path, "utf8");
          }
        } },
        registrationState: { ...registration, setRegistered(...args) { applications += 1; registration.setRegistered(...args); } },
      });
      const input = { operationId: request.operationId, registrationGeneration: "registration",
        mode: mode.startsWith("inspect") ? "inspect" as const : "apply" as const };
      let before = await readFile(path, "utf8");
      if (["apply", "inspect-old", "inspect-new", "cached-binding"].includes(mode)) {
        const result = await handle(input, {});
        assert.equal(await readFile(path, "utf8"), before, "the follower handler publishes nothing");
        assert.equal(result.ready, mode !== "inspect-old");
        assert.equal(result.target.threadId, mode === "inspect-old" ? 10 : 42);
        assert.equal(result.slot, "A");
        assert.equal(applications, mode === "apply" || mode === "cached-binding" ? 1 : 0);
        if (mode === "apply") {
          assert.equal((await handle({ ...input, mode: "inspect" }, {})).ready, true, "lost ACK is resolved without another switch");
          assert.equal((await handle(input, {})).ready, true);
          assert.equal(applications, 1);
          assert.equal(store.confirmReady(issued, result.recipient, auth)?.phase, "ready");
          before = await readFile(path, "utf8");
          assert.equal((await handle(input, {})).ready, true);
          assert.equal(applications, 1);
        }
      } else {
        await assert.rejects(handle(input, {}));
        assert.equal(applications, 0);
      }
      if (mode === "fence") assert.equal(reads, 0);
      assert.equal(await readFile(join(dirname(path), "state.json"), "utf8"), before);
    }, "follower");
  });
}

for (const fault of ["normal", "late-recovery", "disk-binding", "owner-detached", "intent-changed", "context-changed"] as const) {
  for (const mode of ["apply", "inspect"] as const) test(`Read-only recipient observation fences local effects (${fault}, ${mode})`, async () => {
    await fixture(async ({ store, threads, request, auth, path }) => {
      const relocated = (await store.commit(request, auth))!;
      const issued = store.issueRecipient(relocated, recipient("follower"), auth)!.intent;
      const pending = { id: "late", owner: "manual-follower" as const, instanceId: "creator", profileKey: "manual:creator",
        workspaceBindingKey: "other-binding", slot: "B", startedAtMs: 1000 };
      threads.upsertPendingProvision(pending); await threads.persist();
      const reader = createTelegramTopicTargetStore({ path, getNowMs: () => 1000, canPersist: () => false });
      await reader.load();
      assert.throws(() => reader.commitWorkspaceRestoreRegistration({ target: request.target,
        bindingKey: request.binding.bindingKey, slot: "A" }, () => assert.fail("follower cannot publish canonical authority")), /registration authority changed/);
      const registration = createTelegramBusFollowerRegistrationState();
      const originalTarget = mode === "apply" ? request.binding.target : request.target;
      registration.setRegistered(true, originalTarget, { generation: "registration", slot: "A" });
      const ledger = createTelegramWorkspaceAdmissionLedger({ path: `${path}.admission`, profileKey: "profile:restore",
        owner: { processId: process.pid, processBirthId: `${process.pid}:recipient-observation` }, getProcessLiveness: () => "alive" });
      const scope = { executor: auth.executor, profileBindingKey: "profile:restore", operatorUserId: 7,
        cwd: "/repo", sessionId: "session", generation: 1 };
      let applications = 0;
      let canonical = "";
      let recovery: string | undefined;
      const handle = createTelegramBusFollowerWorkspaceRestoreHandler({ instanceId: "old",
        getContextAuthority: () => ({ ...scope }), getWorkspaceAdmission: () => ledger,
        readRestoreIntent: id => store.list().find(value => value.request.operationId === id),
        topicTargetStore: { ...reader, async load() {
          await reader.load();
          if (fault === "late-recovery") {
            await threads.recordPendingProvisionTargetRecovery(pending, request.target);
            recovery = await readFile(`${path}.provision-recovery.json`, "utf8");
          }
          if (fault === "disk-binding") {
            const snapshot = JSON.parse(await readFile(path, "utf8"));
            snapshot.workspaceBindings[0].target = { chatId: 7, threadId: 99 };
            writeFileSync(path, JSON.stringify(snapshot));
          }
          if (fault === "owner-detached") assert.equal(await threads.detachTargetOwner(threads.list()[0]!, () => true), true);
          if (fault === "intent-changed") assert.ok(store.adopt(issued, { ...auth, executor: { instanceId: "next", leaderEpoch: "next" } }));
          canonical = await readFile(path, "utf8");
        }, withWorkspaceRestoreSnapshot(expected, observe) {
          reader.withWorkspaceRestoreSnapshot(expected, snapshot => {
            assert.ok(ledger.read().leases.length > 0);
            assert.throws(() => withTelegramFileTransaction(`${path}.transaction`, () => assert.fail("unlocked observation"),
              { attempts: 1, retryDelayMs: 0 }), /Timed out acquiring Telegram lock transaction/);
            if (fault === "context-changed") scope.generation += 1;
            return observe(snapshot);
          });
        } },
        registrationState: { ...registration, setRegistered(...args) {
          assert.throws(() => withTelegramFileTransaction(`${path}.transaction`, () => assert.fail("unlocked effect"),
            { attempts: 1, retryDelayMs: 0 }), /Timed out acquiring Telegram lock transaction/);
          applications += 1; registration.setRegistered(...args);
        } },
      });
      const input = { operationId: request.operationId, registrationGeneration: "registration", mode };
      if (fault === "normal") {
        assert.equal((await handle(input, {})).ready, true);
        assert.equal((await handle(input, {})).ready, true);
        assert.equal(applications, mode === "apply" ? 1 : 0, "reobservation grants no repeated apply");
      } else {
        await assert.rejects(handle(input, {}), /Protected Workspace Restore|observation changed|canonical binding is not committed|Stale Telegram follower Restore authority/);
        assert.equal(applications, 0);
        assert.deepEqual(registration.getTarget(), originalTarget);
      }
      assert.equal(await readFile(path, "utf8"), canonical);
      if (recovery) assert.equal(await readFile(`${path}.provision-recovery.json`, "utf8"), recovery);
      assert.equal(store.list()[0]?.phase, "recipient-issued");
      assert.equal(store.list()[0]?.routing, undefined);
      assert.deepEqual(ledger.read().leases, []);
      assert.equal(withTelegramFileTransaction(`${path}.transaction`, () => true, { attempts: 1, retryDelayMs: 0 }), true);
    }, "follower");
  });
}

for (const mode of ["ready", "issued-recipient", "issued-old-target", "issued-cleanup", "unadopted", "foreign-session", "old-target", "ended-epoch"] as const) {
  test(`Cold Restore successor inspection preserves original grants (${mode})`, async () => {
    await fixture(async ({ store, threads, request, auth, path, open }) => {
      let retained = store.issueRecipient((await store.commit(request, auth))!, recipient("follower"), auth)!.intent;
      if (mode !== "issued-recipient" && mode !== "issued-old-target") {
        retained = store.confirmReady(retained, recipient("follower"), auth)!;
        retained = store.issueRouting(retained, auth)!.intent;
        retained = store.recordSourceSettlement(retained, { ...request.source, kind: "completed" }, auth)!;
        if (mode === "issued-cleanup") retained = store.issueCleanup(retained, auth)!.intent;
      }
      // Registration publication is an explicit precondition, not startup proof supplied by this fixture.
      threads.upsert({ ...threads.list()[0]!, instanceId: "successor" });
      await threads.persist();
      const leader = createTelegramTopicTargetStore({ path }); await leader.load();
      const recovered = open({ threadStore: leader });
      const successorAuthority = { ...auth, executor: { instanceId: "next-leader", leaderEpoch: "next-epoch" } };
      if (mode !== "unadopted") retained = recovered.adopt(recovered.list()[0]!, successorAuthority)!;
      const before = await readFile(path, "utf8");
      const reader = createTelegramTopicTargetStore({ path, canPersist: () => false });
      const readonlyRestore = open({ threadStore: reader });
      const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: [TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE] });
      const state = createTelegramBusFollowerRegistrationState();
      state.setRegistered(true, mode === "old-target" || mode === "issued-old-target" ? request.binding.target : request.target,
        { generation: "next-registration", slot: "A", leaderProtocol: protocol });
      const scope = { executor: successorAuthority.executor, profileBindingKey: "profile:restore", operatorUserId: 7,
        sessionId: mode === "foreign-session" ? "foreign" : "session", cwd: "/repo", generation: 2 };
      const ledger = createTelegramWorkspaceAdmissionLedger({ path: join(dirname(path), "successor-admission.json"),
        profileKey: scope.profileBindingKey, owner: { processId: process.pid, processBirthId: `${process.pid}:successor` },
        getProcessLiveness: () => "alive" });
      const ctx = {};
      let applications = 0, observations = 0;
      const handle = createTelegramBusFollowerWorkspaceRestoreHandler({ instanceId: "successor",
        getContextAuthority: createTelegramBusFollowerRestoreContextGetter({
          isContextCurrent: value => value === ctx, getSessionId: () => scope.sessionId, getCwd: () => scope.cwd,
          getGeneration: () => scope.generation, getProfileBindingKey: () => scope.profileBindingKey,
          getOperatorUserId: () => scope.operatorUserId, getAuthenticatedSecret: () => "secret",
          getLeaderProtocol: state.getLeaderProtocol,
          getLeaderState: () => ({ kind: "active-elsewhere", lock: { pid: 123, instanceId: scope.executor.instanceId,
            leaderEpoch: scope.executor.leaderEpoch, busSecret: "secret" } }),
        }),
        getWorkspaceAdmission: () => ledger, readRestoreIntent: id => readonlyRestore.list().find(value => value.request.operationId === id),
        topicTargetStore: { async load() {
          await reader.load();
          if (mode === "ended-epoch") scope.executor = { ...scope.executor, leaderEpoch: "ended" };
        }, withWorkspaceRestoreSnapshot(expected, observe) {
          reader.withWorkspaceRestoreSnapshot(expected, snapshot => {
            observations += 1;
            assert.equal(ledger.read().leases.length, 1);
            assert.equal(existsSync(`${path}.transaction`), true);
            return observe(snapshot);
          });
        } },
        registrationState: { ...state, setRegistered(...args) { applications += 1; state.setRegistered(...args); } } });
      const socketPath = getTelegramBusFollowerSocketPath("successor", dirname(path));
      const follower: TelegramBusFollowerView = { instanceId: "successor", registrationGeneration: "next-registration",
        cwd: scope.cwd, sessionId: scope.sessionId, target: state.getTarget(), slot: "A", protocol,
        busSocketPath: socketPath, connectedAtMs: 1, lastHeartbeatMs: 1 };
      const receiver = createTelegramBusForwardedUpdateReceiverRuntime({ socketPath, instanceId: "successor",
        getAuthSecret: () => "secret", getRegistrationGeneration: state.getGeneration, getRecipientBindingKey: () => "unused",
        getContext: () => ctx, isWorkspaceRestoreEnabled: () => true,
        durableAdmission: { async admit() { assert.fail("Inspection cannot dispatch accepted input"); } }, handleWorkspaceRestore: handle });
      const control = createTelegramBusWorkspaceRestoreController({ getFollower: () => follower, localProtocolIdentity: protocol,
        createRequestId: () => "cold-inspection", getAuthSecret: () => "secret", timeoutMs: 1000 });
      await receiver.start();
      try {
        const observed = await control({ operationId: request.operationId, instanceId: "successor", sessionId: scope.sessionId,
          target: request.target, oldTarget: request.binding.target, slot: "A", mode: "inspect", isCurrent: () => true });
        const ready = mode === "ready" || mode === "issued-recipient" || mode === "issued-cleanup";
        assert.equal(observed?.ready === true, ready);
        assert.equal(await readFile(path, "utf8"), before, "follower inspection cannot rewrite canonical evidence");
        assert.equal(applications, 0, "a successor never consumes the original apply grant");
        assert.equal(observations, ready || mode === "old-target" || mode === "issued-old-target" ? 1 : 0);
        assert.deepEqual(state.getTarget(), mode === "old-target" || mode === "issued-old-target" ? request.binding.target : request.target);
        assert.deepEqual(ledger.read().leases, []);
        assert.equal(existsSync(`${path}.transaction`), false);
        if (ready) {
          const confirmed = recovered.confirmInspectedReady(retained, observed!.recipient, successorAuthority)!;
          assert.deepEqual(confirmed.recipient, recipient("follower"));
          assert.deepEqual(confirmed.readyRecipient, { kind: "follower", instanceId: "successor", sessionId: "session", generation: "next-registration" });
          assert.deepEqual(confirmed.routing, retained.routing, "inspection cannot settle sources or reset issued grants");
          assert.deepEqual(confirmed.request, request);
          assert.equal(recovered.issueRecipient(confirmed, observed!.recipient, successorAuthority), undefined);
          if (mode === "issued-cleanup") {
            assert.equal(recovered.issueCleanup(confirmed, successorAuthority), undefined);
            assert.equal(recovered.retire(confirmed, successorAuthority), undefined);
          }
        } else assert.deepEqual(recovered.list(), [retained]);
      } finally { await receiver.stop(); }
    }, "follower");
  });
}

for (const mode of ["normal", "capability", "version", "disabled", "auth", "generation", "reply-mismatch", "lost-ack", "transport-loss", "registry-change", "owner-replaced", "pi-replaced", "protocol-downgrade", "protocol-replacement"] as const) {
  test(`Workspace Restore crosses authenticated native IPC without replay (${mode})`, async () => {
    await fixture(async ({ store, threads, request, auth, path }) => {
      const relocated = await store.commit(request, auth);
      const issued = mode === "normal" ? undefined : store.issueRecipient(relocated!, recipient("follower"), auth)!.intent;
      const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: [TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE] });
      const state = createTelegramBusFollowerRegistrationState();
      state.setRegistered(true, request.binding.target, { generation: "registration", slot: "A", leaderProtocol: protocol });
      const scope = { executor: auth.executor, profileBindingKey: "profile:restore", operatorUserId: 7,
        cwd: "/repo", sessionId: "session", generation: 1 };
      const ledger = createTelegramWorkspaceAdmissionLedger({ path: join(dirname(path), "admission.json"),
        profileKey: scope.profileBindingKey, owner: { processId: process.pid, processBirthId: `${process.pid}:restore-ipc` },
        getProcessLiveness: () => "alive" });
      const socketPath = getTelegramBusFollowerSocketPath("old", dirname(path));
      let follower: TelegramBusFollowerView = { instanceId: "old", registrationGeneration: mode === "generation" ? "old" : "registration",
        cwd: "/repo", sessionId: "session", slot: "A", target: request.binding.target, busSocketPath: socketPath,
        protocol: mode === "capability" ? { ...protocol, capabilities: [] } : mode === "version" ? { ...protocol, protocolVersion: 999 } : protocol,
        connectedAtMs: 1, lastHeartbeatMs: 1 };
      let applications = 0;
      let requests = 0;
      const ctx = {};
      const handle = createTelegramBusFollowerWorkspaceRestoreHandler({ instanceId: "old",
        getContextAuthority: createTelegramBusFollowerRestoreContextGetter({
          isContextCurrent: value => value === ctx, getSessionId: () => scope.sessionId, getCwd: () => scope.cwd,
          getGeneration: () => scope.generation, getProfileBindingKey: () => scope.profileBindingKey,
          getOperatorUserId: () => scope.operatorUserId, getAuthenticatedSecret: () => "secret",
          getLeaderProtocol: state.getLeaderProtocol,
          getLeaderState: () => ({ kind: "active-elsewhere", lock: { pid: 123, instanceId: scope.executor.instanceId,
            leaderEpoch: scope.executor.leaderEpoch, busSecret: "secret" } }),
        }),
        getWorkspaceAdmission: () => ledger, readRestoreIntent: id => store.list().find(value => value.request.operationId === id),
        topicTargetStore: { ...threads, async load() {
          await threads.load();
          if (mode === "owner-replaced") scope.executor = { ...scope.executor, leaderEpoch: "replacement" };
          if (mode === "pi-replaced") scope.generation += 1;
          if (mode === "protocol-downgrade" || mode === "protocol-replacement") state.setRegistered(true, state.getTarget(), {
            generation: state.getGeneration(), slot: state.getSlot(), leaderProtocol: mode === "protocol-downgrade"
              ? { ...protocol, capabilities: [] } : { ...protocol, runtimeBuild: "replacement" } });
        } }, registrationState: { ...state, setRegistered(...args) { applications += 1; state.setRegistered(...args); } } });
      const handleWorkspaceRestore = async (input: { operationId: string; registrationGeneration: string; mode: "apply" | "inspect" }, context: object) => {
        requests += 1;
        const result = await handle(input, context);
        if (mode === "lost-ack" && input.mode === "apply") throw new Error("Response lost after local switch");
        if (mode === "registry-change") follower = { ...follower, registrationGeneration: "replacement" };
        return mode === "reply-mismatch" ? { ...result, slot: "B" } : result;
      };
      let droppedReplies = 0;
      const receiver = mode === "transport-loss" ? createRawTelegramBusLocalServer({ socketPath,
        async handleEnvelope(envelope) {
          assert.equal(envelope.auth, "secret");
          assert.equal(envelope.kind, "leader.workspaceRestore");
          if (envelope.kind !== "leader.workspaceRestore") assert.fail("Unexpected envelope");
          const result = await handleWorkspaceRestore({ operationId: envelope.operationId, mode: envelope.mode,
            registrationGeneration: envelope.recipientRegistrationGeneration }, ctx);
          return { kind: "bus.ack", requestId: envelope.requestId, ok: true, result };
        }, shouldDropResponse(envelope) {
          if (envelope.kind !== "leader.workspaceRestore" || envelope.mode !== "apply") return false;
          droppedReplies += 1;
          return true;
        } }) : createTelegramBusForwardedUpdateReceiverRuntime({ socketPath, instanceId: "old",
        getAuthSecret: () => "secret", getRegistrationGeneration: state.getGeneration, getRecipientBindingKey: () => "unused",
        getContext: () => ctx, isWorkspaceRestoreEnabled: () => mode !== "disabled" &&
          state.getLeaderProtocol()?.capabilities.includes(TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE) === true,
        durableAdmission: { async admit() { assert.fail("Restore must never enter input admission"); } },
        handleWorkspaceRestore });
      let requestId = 0;
      const control = createTelegramBusWorkspaceRestoreController({ getFollower: () => follower, localProtocolIdentity: protocol,
        createRequestId: () => `restore-${++requestId}`, getAuthSecret: () => mode === "auth" ? "wrong" : "secret", timeoutMs: 1000 });
      const input = { operationId: request.operationId, instanceId: "old", sessionId: "session", slot: "A",
        target: request.target, oldTarget: request.binding.target, mode: "apply" as const, isCurrent: () => true };
      await receiver.start();
      try {
        if (mode === "normal") {
          const attempt = () => advanceTelegramWorkspaceRestore({ request, authority: auth, restoreStore: store,
            getRecipient: () => recipient("follower"), runRecipient: action => control({ ...input, mode: action.mode, isCurrent: action.isCurrent }) });
          assert.equal((await attempt())?.phase, "ready");
          assert.equal((await attempt())?.phase, "ready", "ready replay inspects without another apply");
        } else {
          const result = mode === "transport-loss"
            ? (await assert.rejects(() => control(input), /Timed out waiting for Telegram bus response/), undefined)
            : await control(input);
          assert.equal(result, undefined);
          assert.equal(store.list()[0]?.phase, "recipient-issued");
          assert.equal(store.issueRecipient(store.list()[0]!, recipient("follower"), auth), undefined);
          if (mode === "lost-ack" || mode === "transport-loss") {
            const observed = await control({ ...input, mode: "inspect" });
            assert.equal(observed?.ready, true);
            assert.equal(store.confirmReady(issued!, observed!.recipient, auth)?.phase, "ready");
          }
        }
        const admitted = ["normal", "lost-ack", "transport-loss", "reply-mismatch", "registry-change"].includes(mode);
        assert.equal(applications, admitted ? 1 : 0);
        if (admitted) assert.deepEqual(state.getLeaderProtocol(), protocol, "Restore retains negotiated transport capability");
        else assert.deepEqual(state.getTarget(), request.binding.target, "rejected authority cannot change local target");
        assert.equal(requests, mode === "normal" || mode === "lost-ack" || mode === "transport-loss" ? 2 :
          admitted || mode === "owner-replaced" || mode === "pi-replaced" || mode.startsWith("protocol-") ? 1 : 0);
        assert.equal(droppedReplies, mode === "transport-loss" ? 1 : 0);
      } finally { await receiver.stop(); }
    }, "follower");
  });
}
