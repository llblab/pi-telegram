/**
 * Regression tests for Telegram multi-instance bus leader helpers
 * Covers leader activation, envelope handling, authorization, and polling runtime behavior
 */

import assert from "node:assert/strict";
import { createTelegramBusAwareApiRuntime } from "../lib/bus-api.ts";
import { createTelegramBusFollowerApiCaller, createTelegramBusFollowerRegistrationRuntime, createTelegramBusFollowerRegistrationState } from "../lib/bus-follower.ts";
import { createTelegramBusMessageOwnershipRuntime } from "../lib/ownership.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { withWorkspaceRestoreFixture } from "./fixtures/workspace.ts";
import { withTelegramFileTransaction, createTelegramLockRuntime, createTelegramLockedPollingRuntime } from "../lib/locks.ts";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { mock } from "node:test";
import { createTelegramSessionContextStore } from "../lib/lifecycle.ts";

import {
  createTelegramBusFollowerDeliveryIdentity,
  createTelegramFollowerApiCallAuthorizer,
  createTelegramBusFollowerRegistry,
  createTelegramBusLocalServer,
  createTelegramBusProtocolIdentity,
  resolveTelegramBusSocketPath,
  sendTelegramBusLocalEnvelope,
  TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
  TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION,
  TELEGRAM_BUS_CAPABILITY_GUARDED_API_AUTHORITY,
  TELEGRAM_BUS_CAPABILITY_API_REGISTRATION_AUTHORITY,
  TELEGRAM_BUS_CAPABILITY_ARTIFACT_DOCUMENT,
  TELEGRAM_BUS_ATTACHMENT_PUBLICATION_RECEIPT,
  parseTelegramBusAttachmentPublicationReceipt,
  TELEGRAM_BUS_CAPABILITY_PRE_DISPATCH_REBIND,
  TELEGRAM_BUS_CAPABILITY_ORPHAN_INTENT_READER,
  TELEGRAM_BUS_CAPABILITY_ORPHAN_CLEANUP_READER,
  TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF,
  TELEGRAM_BUS_CAPABILITY_QUEUE_STEER,
  TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE,
  TELEGRAM_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT,
  TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME,
  TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE,
  TELEGRAM_BUS_CAPABILITY_DIRECTORY_DISPLAY_FORMAT,
  TELEGRAM_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT,
  type TelegramBusFollowerView,
  type TelegramBusSelectedMenuDelivery,
  type TelegramBusEnvelope,
  TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY,
} from "../lib/bus.ts";
import {
  createTelegramBusArtifactAuthorityCapture,
  createTelegramBusFollowerConfirmedDeadHandler,
  createTelegramBusFollowerDisconnectHandler,
  createTelegramBusFollowerSessionReplacementAuthority,
  createTelegramBusFollowerTargetProvisioner,
  createTelegramBusInstanceLifecycleAnnouncement,
  createTelegramBusLeaderApiProxy,
  createTelegramBusSelectedMenuDeliveryHandler,
  createTelegramBusLeaderEnvelopeHandler as createRawTelegramBusLeaderEnvelopeHandler,
  createTelegramBusLeaderRuntime as createRawTelegramBusLeaderRuntime,
  createTelegramBusLeaderRuntimeAssembly,
  createTelegramBusLeaderTargetProvisioner,
  TELEGRAM_BUS_FOLLOWER_STALE_AFTER_MS,
  type TelegramBusLeaderRuntimeDeps,
} from "../lib/bus-leader.ts";
import type { TelegramThreadDisplayMode } from "../lib/config.ts";
import { createTelegramUpdateJournalStore, createTelegramUpdateJournalBotIdentity, createTelegramUpdateJournalBindingKey } from "../lib/journal.ts";
import { createTelegramThreadDisplayNameRenameBinding, createTelegramThreadDisplayNameResetBinding } from "../lib/commands.ts";
import {
  createTelegramTopicTargetStore,
  createTelegramConsolidatedWorkspaceStorage,
  createTelegramTopicTargetProvisioner,
  createTelegramWorkspaceBindingIdentity,
} from "../lib/threads.ts";
import {
  TelegramApiCommitUnknownError,
  TelegramApiAuthorityError,
  TelegramApiStaleTargetError,
  createTelegramApiClient,
  createTelegramBridgeApiRuntime,
  setTelegramApiHttpsFetchForTesting,
  type TelegramApiCallOptions,
} from "../lib/telegram-api.ts";
import {
  createTelegramWorkspaceAdmissionLedger,
  runWithTelegramWorkspaceAdmissionsAsync,
} from "../lib/workspace-admission.ts";
import {
  createTelegramWorkspaceExternalProtectionCapture,
  createTelegramWorkspaceOperationRuntime,
} from "../lib/workspace-retirement.ts";
import { waitForCondition } from "./fixtures/shared.ts";

for (const directFirst of [true, false])
test(`Artifact mixed direct/follower reservation survives logical abort/expiry (${directFirst ? "direct-first" : "follower-first"})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-artifact-mixed-")), socketPath = join(dir, "bus.sock");
  const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "artifact", capabilities: ["artifact-document-v1"] }), registry = createTelegramBusFollowerRegistry();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let uploads = 0, decodes = 0;
  const previous = globalThis.fetch, family = process.env.PI_TELEGRAM_NETWORK_FAMILY;
  process.env.PI_TELEGRAM_NETWORK_FAMILY = "ipv4";
  globalThis.fetch = async () => { uploads++; entered.resolve(); await release.promise; return new Response(JSON.stringify({ ok: true, result: { message_id: 55 } })); };
  const restore = setTelegramApiHttpsFetchForTesting(globalThis.fetch), originalFrom = Buffer.from;
  const fromMock = mock.method(Buffer, "from", ((...args: unknown[]) => { if (args[1] === "base64") decodes++; return Reflect.apply(originalFrom, Buffer, args); }) as typeof Buffer.from);
  const native = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:artifact"), tempDir: dir, maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
  const deps = { followerRegistry: registry, protocolIdentity: protocol, authSecret: "secret", artifactApi: native,
    captureArtifactTransport: () => () => true, getTelegramProfile: () => "default", getAllowedUserId: () => 7 };
  const server = createTelegramBusLocalServer({ socketPath, handleEnvelope: createRawTelegramBusLeaderEnvelopeHandler(deps), captureArtifactAuthority: createTelegramBusArtifactAuthorityCapture(deps) });
  const api = createTelegramBusAwareApiRuntime({ directRuntime: native, ownsDirect: () => true, captureDirectArtifactAuthority: () => () => true, callFollowerApi: async () => assert.fail("No route switch") });
  const controller = new AbortController();
  const direct = () => api.captureArtifactTransport!({ chatId: 7, threadId: 8 })!.send({ bytes: Buffer.from("abc"), fileName: "file", expiresAt: Date.now() + 5000, signal: controller.signal, assertAuthority() {} });
  const follower = (requestId: string, expiresAt = Date.now() + 5000) => sendTelegramBusLocalEnvelope({ socketPath, envelope: { kind: "follower.callApi", auth: "secret", instanceId: "follower", registrationGeneration: "gen", requestId, sentAtMs: 1,
    method: "sendArtifactDocument", args: [{ version: 1, registrationIncarnation: registry.get("follower")!.registrationIncarnation, target: { chatId: 7, threadId: 8 }, fileName: "file", byteLength: 3, bytesBase64: "YWJj", expiresAt }] } });
  const resultOf = (ack: Awaited<ReturnType<typeof follower>>) => { assert.ok(ack?.kind === "bus.ack" && ack.ok); return ack.result as { effect: string; reason: string }; };
  let original: Promise<unknown> | undefined;
  try {
    await server.start();
    const ack = await sendTelegramBusLocalEnvelope({ socketPath, envelope: { kind: "follower.register", requestId: "register", auth: "secret", registration: { instanceId: "follower", registrationGeneration: "gen", sessionId: "session", sessionGeneration: 1, profileKey: "binding", target: { chatId: 7, threadId: 8 }, protocol, connectedAtMs: Date.now() } } });
    assert.ok(ack?.kind === "bus.ack" && ack.ok);
    original = directFirst ? direct() : follower("original", Date.now() + 100);
    await entered.promise;
    const blocked = await Promise.race([directFirst ? follower("blocked").then(resultOf) : direct(), new Promise<{ effect: string; reason: string }>(resolve => setTimeout(() => resolve({ effect: "still-running", reason: "overlap" }), 200))]);
    assert.equal(blocked.effect, "not-issued"); assert.equal(blocked.reason, "capacity-exceeded");
    if (directFirst) controller.abort(); else await new Promise(resolve => setTimeout(resolve, 130));
    const stillBlocked = directFirst ? resultOf(await follower("still-blocked")) : await direct();
    assert.equal(stillBlocked.reason, "capacity-exceeded");
    assert.equal(uploads, 1); assert.equal(decodes, directFirst ? 0 : 1);
    release.resolve(); await original;
    const fresh = resultOf(await follower("fresh")); assert.equal(fresh.effect, "sent"); assert.equal(uploads, 2);
  } finally {
    release.resolve(); await original; await server.stop(); restore(); fromMock.mock.restore(); globalThis.fetch = previous;
    if (family === undefined) delete process.env.PI_TELEGRAM_NETWORK_FAMILY; else process.env.PI_TELEGRAM_NETWORK_FAMILY = family;
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const change of ["none", "registration-during-wait", "transport-during-wait"] as const)
test(`Artifact leader reservation outlives local IPC timeout, duplicates share one attempt and cached ACK authority is current (${change})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-artifact-leader-")), socketPath = join(dir, "bus.sock"), ctx = { cwd: dir, sessionId: "leader-session" };
  const lock = createTelegramLockRuntime({ locksPath: join(dir, "owners.json"), instanceId: "artifact-leader" });
  const sessions = createTelegramSessionContextStore<typeof ctx>(); sessions.set(ctx);
  const polling = createTelegramLockedPollingRuntime({ lock, hasBotToken: () => true, isContextCurrent: sessions.isCurrent, getSessionId: ctx => ctx.sessionId, startPolling() {}, async stopPolling() {}, updateStatus() {} });
  await polling.start(ctx);
  const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "artifact", capabilities: ["artifact-document-v1"] }), registry = createTelegramBusFollowerRegistry();
  const registrations = [
    { instanceId: "first", registrationGeneration: "gen", sessionId: "first-session", sessionGeneration: 1, profileKey: "first-binding", target: { chatId: 7, threadId: 8 }, protocol, connectedAtMs: Date.now() },
    { instanceId: "second", registrationGeneration: "gen", sessionId: "second-session", sessionGeneration: 1, profileKey: "second-binding", target: { chatId: 7, threadId: 9 }, protocol, connectedAtMs: Date.now() },
  ];
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let uploads = 0, decodes = 0;
  const originalFrom = Buffer.from;
  const fromMock = mock.method(Buffer, "from", ((...args: unknown[]) => {
    if (args[1] === "base64") decodes++;
    return Reflect.apply(originalFrom, Buffer, args);
  }) as typeof Buffer.from);
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { uploads++; entered.resolve(); await release.promise; return new Response(JSON.stringify({ ok: true, result: { message_id: 55 } })); };
  const restore = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
  const native = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:artifact"), tempDir: dir, maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
  const deps = { followerRegistry: registry, protocolIdentity: protocol, authSecret: "secret", artifactApi: native,
    captureArtifactTransport: polling.captureCurrentTransportAuthority, getTelegramProfile: () => "default", getAllowedUserId: () => 7 };
  const duplicateEntered = Promise.withResolvers<void>(), capture = createTelegramBusArtifactAuthorityCapture(deps);
  let originalAdmissions = 0;
  const handle = createRawTelegramBusLeaderEnvelopeHandler(deps), server = createTelegramBusLocalServer({ socketPath, handleEnvelope: handle,
    requestLedgerMaxEntries: 2, captureArtifactAuthority(envelope) {
      const guard = capture(envelope);
      if (envelope.requestId === "one" && ++originalAdmissions === 2) duplicateEntered.resolve();
      return guard;
    } });
  const envelope = (follower: TelegramBusFollowerView, requestId: string): TelegramBusEnvelope => ({ kind: "follower.callApi", auth: "secret", instanceId: follower.instanceId, registrationGeneration: "gen", requestId, sentAtMs: 1,
    method: "sendArtifactDocument", args: [{ version: 1, registrationIncarnation: follower.registrationIncarnation, target: follower.target, fileName: "file", byteLength: 3, bytesBase64: "YWJj", expiresAt: Date.now() + 5000 }] });
  try {
    await server.start();
    for (const registration of registrations) {
      const ack = await sendTelegramBusLocalEnvelope({ socketPath, envelope: { kind: "follower.register", auth: "secret", requestId: `register:${registration.instanceId}`, registration } });
      assert.ok(ack?.kind === "bus.ack" && ack.ok);
    }
    const first = registry.get("first")!, second = registry.get("second")!, original = envelope(first, "one");
    const timed = sendTelegramBusLocalEnvelope({ socketPath, envelope: original, timeoutMs: 40 }).then(() => false, () => true);
    await entered.promise; assert.equal(await timed, true);
    const duplicate = sendTelegramBusLocalEnvelope({ socketPath, envelope: original });
    await duplicateEntered.promise;
    const blocked = await sendTelegramBusLocalEnvelope({ socketPath, envelope: envelope(second, "two") });
    assert.ok(blocked?.kind === "bus.ack" && blocked.ok); assert.equal((blocked.result as { effect: string }).effect, "not-issued");
    assert.equal((blocked.result as { reason: string }).reason, "capacity-exceeded");
    const collision = structuredClone(original);
    if (collision.kind !== "follower.callApi") throw new Error("Wrong fixture");
    (collision.args[0] as { fileName: string }).fileName = "other";
    const refused = await sendTelegramBusLocalEnvelope({ socketPath, envelope: collision });
    assert.ok(refused?.kind === "bus.ack" && !refused.ok); assert.equal(refused.error?.code, "request-id-collision");
    assert.equal(uploads, 1); assert.equal(decodes, 1, "Only the reserved original operation decodes bytes");
    if (change === "registration-during-wait") registry.register(first);
    if (change === "transport-during-wait") { await polling.suspend(); await polling.start(ctx); }
    release.resolve();
    const settled = await duplicate; assert.ok(settled?.kind === "bus.ack"); assert.equal(settled.ok, change === "none");
    if (settled.ok) assert.equal((settled.result as { effect: string }).effect, "sent");
    const cached = await sendTelegramBusLocalEnvelope({ socketPath, envelope: original });
    assert.ok(cached?.kind === "bus.ack"); assert.equal(cached.ok, change === "none"); assert.equal(uploads, 1);
    // Evict the original with generic requests, then revoke its wire identity at the real registry owner.
    for (const requestId of ["probe1", "probe2", "probe3"]) await sendTelegramBusLocalEnvelope({ socketPath, envelope: { kind: "bus.probe", requestId, auth: "secret" } });
    registry.remove(first.instanceId); registry.register(first);
    const stale = await sendTelegramBusLocalEnvelope({ socketPath, envelope: original });
    assert.ok(stale?.kind === "bus.ack" && !stale.ok); assert.equal(uploads, 1); assert.equal(decodes, 1);
  } finally { release.resolve(); await server.stop(); await polling.stop(); restore(); fromMock.mock.restore(); globalThis.fetch = previous; rmSync(dir, { recursive: true, force: true }); }
});

for (const effect of ["send-text", "edit-text"] as const) {
for (const fault of ["current", "missing-owner", "local-capability", "peer-capability", "wrong-auth", "stale-registration", "wrong-journal", "wrong-target", "foreign-edit",
  "before-admission", "registration-during", "session-during", "profile-during", "journal-during", "epoch-during", "operator-during", "canonical-during",
  "transport-during", "port-during", "lost-response", "record-loss", "mutable-request", "scope-during", "token-loss", "json-loss", "false-publication", "release-drift", "authorization-drift", "process-during", "birth-during", "slot-during", "cwd-during", "endpoint-during", "protocol-during", "admission-drift", "old-protocol", "group", "runtime-current", "runtime-no-owner", "runtime-owner-before", "runtime-owner-during", "runtime-protocol-before", "runtime-secret-before", "runtime-registry-before", "runtime-stop", "runtime-stop-restart"] as const) {
  test(`Selected menu leader ${effect} fences actual Workspace/direct API and ownership (${fault})`, async () => {
    await withWorkspaceRestoreFixture(async f => {
      const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: [TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY] });
      const registry = createTelegramBusFollowerRegistry();
      const captured = { instanceId: "old", registrationGeneration: "registration", profileKey: f.request.owner.profileKey, sessionId: "session", sessionGeneration: 1,
        cwd: "/repo", slot: "A", target: f.request.target, pid: process.pid, processBirthId: "birth", protocol, connectedAtMs: 1 };
      registry.register(captured);
      if (fault !== "group") f.request.source.updateIds = [100];
      const intent = (await f.store.commitLiveRebind(f.request, { kind: "follower", instanceId: "old", sessionId: "session", generation: "registration" }, f.auth))!;
      f.store.advanceLiveRebind(intent, "release", f.auth);
      const wire: TelegramBusSelectedMenuDelivery & { auth?: string } = { kind: "follower.deliverSelectedMenu", requestId: "effect", auth: "secret", instanceId: "old",
        registrationGeneration: "registration", operationId: f.request.operationId, recipient: { sessionId: "session", sessionGeneration: 1, processId: process.pid,
          processBirthId: "birth", profileKey: captured.profileKey, journalBindingKey: "recipient-journal", target: f.request.target },
        executor: { instanceId: "leader", leaderEpoch: "epoch" }, operatorUserId: 7,
        effect: effect === "send-text" ? { kind: effect, text: "Status", parseMode: "HTML", replyToMessageId: 11 } : { kind: effect, text: "Status", messageId: 11 }, sentAtMs: 1000 };
      let authority = true, epoch = "epoch", operator = 7, journal = "recipient-journal", scopeKey = "profile:bot", calls = 0;
      const records: unknown[] = [], bodies: Record<string, unknown>[] = [];
      const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
      const ledger = createTelegramWorkspaceAdmissionLedger({ path: `${f.path}.menu-admission`, profileKey: "profile:bot", owner: { processId: process.pid, processBirthId: `${process.pid}:menu` }, getProcessLiveness: () => "alive" });
      const operations = createTelegramWorkspaceOperationRuntime({ getWorkspaceAdmission: () => ledger });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (_url, init) => {
        calls++; bodies.push(JSON.parse(String(init?.body))); assert.ok(ledger.read().leases.length);
        entered.resolve(); await finish.promise;
        if (fault === "lost-response") throw new Error("Response lost after issuance");
        const response = new Response(JSON.stringify({ ok: true, result: { message_id: 11 } }));
        if (fault === "json-loss") { const text = response.text.bind(response); response.text = async () => { const result = await text(); authority = false; return result; }; }
        return response;
      };
      const client = createTelegramApiClient(() => { if (fault === "token-loss") authority = false; return "123:fixture"; });
      const runtimeOptions = { client, tempDir: dirname(f.path), maxFileSizeBytes: 1024, tempFileMaxAgeMs: 1000, recordRuntimeEvent() {} };
      const api = createTelegramBridgeApiRuntime(runtimeOptions);
      const run: typeof operations.run = async (input, operation) => {
        if (fault === "admission-drift") { await Promise.resolve(); epoch = "replacement"; }
        const result = await operations.run(input, operation); if (fault === "release-drift") epoch = "replacement"; return result;
      };
      const ports = { followerRegistry: registry, protocolIdentity: protocol,
        workspace: { getScopeKey: () => scopeKey, captureAuthority: () => ({ executor: { instanceId: "leader", leaderEpoch: epoch }, operatorUserId: operator, isCurrent: () => authority }),
          getStore: () => f.store, threadStore: f.threads, getJournalBindingKey: () => journal, run },
        api: { runtime: api, authorize: () => {
          if (fault === "authorization-drift") registry.register({ ...captured, target: { chatId: 7, threadId: 99 } });
          return fault !== "foreign-edit" || effect !== "edit-text";
        }, record(record: unknown, assertCurrent: () => void) {
          if (fault === "record-loss") authority = false; assertCurrent();
          if (fault === "false-publication") return false;
          records.push(record); return true;
        } } };
      const delivery = createTelegramBusSelectedMenuDeliveryHandler(ports);
      const envelopeHandler = createRawTelegramBusLeaderEnvelopeHandler({ followerRegistry: registry, authSecret: "secret", protocolIdentity: protocol,
        selectedMenuDelivery: fault === "missing-owner" ? undefined : delivery,
        callApi() { assert.fail("Selected effects cannot use ordinary API proxy"); } });
      const runtimeMode = fault.startsWith("runtime-"), endpoint = join(dirname(f.path), "selected-runtime.sock");
      const completedDelivery = Promise.withResolvers<TelegramBusEnvelope>(); let replacements = 0;
      const runtimeDeps: TelegramBusLeaderRuntimeDeps<object> = { socketPath: endpoint, followerRegistry: registry, authSecret: "secret", protocolIdentity: protocol,
        isFollowerProcessAlive: () => true, startPolling() {}, stopPolling() {},
        selectedMenuDelivery: fault === "runtime-no-owner" ? undefined : async (input, current) => { const result = await delivery(input, current); completedDelivery.resolve(result); return result; },
        callApi() { assert.fail("Selected runtime effects cannot use ordinary API proxy"); } };
      const leaderRuntime = runtimeMode ? createRawTelegramBusLeaderRuntime(runtimeDeps) : undefined;
      const handle = leaderRuntime ? (input: TelegramBusEnvelope) => sendTelegramBusLocalEnvelope({ socketPath: endpoint, timeoutMs: 250, envelope: input }) : envelopeHandler;
      if (fault === "runtime-owner-before") runtimeDeps.selectedMenuDelivery = async input => { replacements++; throw new Error(input.requestId); };
      if (fault === "runtime-protocol-before") runtimeDeps.protocolIdentity = structuredClone(protocol);
      if (fault === "runtime-secret-before") runtimeDeps.authSecret = "replacement";
      if (fault === "runtime-registry-before") runtimeDeps.followerRegistry = createTelegramBusFollowerRegistry();
      if (fault === "local-capability") protocol.capabilities = [];
      if (fault === "peer-capability") registry.register({ ...captured, protocol: createTelegramBusProtocolIdentity({ runtimeBuild: "old", capabilities: [] }) });
      if (fault === "old-protocol") registry.register({ ...captured, protocol: { ...protocol, protocolVersion: protocol.protocolVersion + 1 } });
      if (fault === "wrong-auth") wire.auth = "wrong";
      if (fault === "stale-registration") wire.registrationGeneration = "old";
      if (fault === "wrong-journal") wire.recipient.journalBindingKey = "wrong";
      if (fault === "wrong-target") wire.recipient.target = { chatId: 7, threadId: 99 };
      if (fault === "before-admission") authority = false;
      const initialBytes = readFileSync(f.path, "utf8");
      try {
        await leaderRuntime?.startPolling({});
        const task = Promise.resolve(handle(wire)).catch(() => undefined);
        const early = ["runtime-no-owner", "runtime-owner-before", "runtime-protocol-before", "runtime-secret-before", "runtime-registry-before", "missing-owner", "local-capability", "peer-capability", "wrong-auth", "stale-registration", "wrong-journal", "wrong-target", "before-admission", "token-loss", "authorization-drift", "admission-drift", "old-protocol", "group"].includes(fault) || fault === "foreign-edit" && effect === "edit-text";
        if (!early) {
          const enteredHttp = await Promise.race([entered.promise.then(() => true), task.then(ack => { assert.fail(JSON.stringify(ack)); })]);
          assert.equal(enteredHttp, true);
          if (fault === "registration-during") registry.register({ ...captured, registrationGeneration: "replacement" });
          if (fault === "session-during") registry.register({ ...captured, sessionId: "replacement" });
          if (fault === "profile-during") registry.register({ ...captured, profileKey: "foreign" });
          if (fault === "journal-during") journal = "replacement";
          if (fault === "epoch-during") epoch = "replacement";
          if (fault === "operator-during") operator = 8;
          if (fault === "canonical-during") f.store.advanceLiveRebind(f.store.listLiveRebindings()[0]!, "not-issued", f.auth);
          if (fault === "transport-during") authority = false;
          if (fault === "port-during") ports.api.runtime = createTelegramBridgeApiRuntime(runtimeOptions);
          if (fault === "scope-during") scopeKey = "foreign-bot";
          if (fault === "process-during") registry.register({ ...captured, pid: process.pid + 1 });
          if (fault === "birth-during") registry.register({ ...captured, processBirthId: "replacement" });
          if (fault === "slot-during") registry.register({ ...captured, slot: "B" });
          if (fault === "cwd-during") registry.register({ ...captured, cwd: "/other" });
          if (fault === "endpoint-during") registry.register({ ...captured, busSocketPath: "replacement" });
          if (fault === "protocol-during") registry.register({ ...captured, protocol: { ...protocol, capabilities: [] } });
          if (fault === "mutable-request") { wire.effect.text = "changed"; wire.recipient.target = { chatId: 7, threadId: 99 }; }
          if (fault === "runtime-owner-during") runtimeDeps.selectedMenuDelivery = async input => { replacements++; throw new Error(input.requestId); };
          if (fault === "runtime-stop" || fault === "runtime-stop-restart") {
            await leaderRuntime!.stopPolling();
            if (fault === "runtime-stop-restart") { registry.register(captured); await leaderRuntime!.startPolling({}); }
          }
        }
        finish.resolve();
        const response = await task;
        const ack = response ?? await completedDelivery.promise;
        if (fault === "runtime-stop" || fault === "runtime-stop-restart") assert.equal(response, undefined, "Closed transport never publishes a late success");
        const accepted = fault === "runtime-current" || fault === "current" || fault === "mutable-request" || fault === "foreign-edit" && effect === "send-text" || ["record-loss", "false-publication"].includes(fault) && effect === "edit-text";
        assert.equal(ack.kind === "bus.ack" && ack.ok, accepted);
        assert.equal(calls, early ? 0 : 1); assert.equal(records.length, (accepted || fault === "release-drift") && effect === "send-text" ? 1 : 0);
        if (!accepted && !early) assert.equal(ack.kind === "bus.ack" && ack.error?.code, "commit-unknown");
        if (!accepted && early) assert.equal(ack.kind === "bus.ack" && ack.error, undefined);
        assert.equal(replacements, 0, "Runtime never adopts a replacement delivery owner");
        if (calls) { assert.equal(bodies[0]!.chat_id, 7); assert.equal(bodies[0]!.text, "Status"); assert.equal(bodies[0]!.message_thread_id, effect === "send-text" ? 42 : undefined); }
        if (fault !== "canonical-during") assert.equal(readFileSync(f.path, "utf8"), initialBytes);
        assert.deepEqual(ledger.read().leases, []); assert.deepEqual(f.threads.listPendingCleanups(), []); assert.deepEqual(f.store.list(), []);
      } finally { finish.resolve(); await leaderRuntime?.stopPolling(); globalThis.fetch = originalFetch; }
    }, "follower");
  });
}
}

async function waitForUnrefBackgroundTask(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Background task did not start.")), 1_000);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const TEST_BUS_PROTOCOL_IDENTITY = createTelegramBusProtocolIdentity({
  runtimeBuild: "test",
  capabilities: [
    TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
    TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF,
    TELEGRAM_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT,
    TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME,
  ],
});

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
  return async (envelope: Parameters<typeof handle>[0]) => {
    const isRegistration = envelope.kind === "follower.register" ||
      envelope.kind === "follower.restoreWorkspace";
    const injectProtocol = isRegistration && !envelope.registration.protocol;
    const response = await handle(
      isRegistration
        ? {
            ...envelope,
            registration: {
              ...envelope.registration,
              ...(envelope.registration.cwd && !envelope.registration.sessionId
                ? { sessionId: "test-session" }
                : {}),
              ...(injectProtocol ? { protocol: protocolIdentity } : {}),
            },
          }
        : envelope,
    );
    if (!injectProtocol || response.kind !== "bus.ack") return response;
    const { protocol: _protocol, ...legacyExpectation } = response;
    return legacyExpectation;
  };
}

function createTelegramBusLeaderRuntime<TContext>(
  deps: Omit<TelegramBusLeaderRuntimeDeps<TContext>, "protocolIdentity"> & {
    protocolIdentity?: TelegramBusLeaderRuntimeDeps<TContext>["protocolIdentity"];
  },
) {
  const { protocolIdentity = TEST_BUS_PROTOCOL_IDENTITY, ...ports } = deps;
  return createRawTelegramBusLeaderRuntime({ ...ports, protocolIdentity });
}

for (const fault of ["normal", "unauthorized", "stale", "local-capability", "peer-capability", "missing-epoch",
  "missing-operator", "missing-profile-reader", "no-secret", "epoch", "profile", "operator", "replacement",
  "listener-error", "diagnostic-error", "scope-error", "capability-change", "metadata", "default-profile", "held"] as const) {
  test(`Native heartbeat observations fence Restore hints (${fault})`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-restore-heartbeat-"));
    const socketPath = join(directory, "bus.sock");
    const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: [
      ...TEST_BUS_PROTOCOL_IDENTITY.capabilities, ...(fault === "local-capability" ? [] : [TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE])] });
    const peerProtocol = createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: [
      ...TEST_BUS_PROTOCOL_IDENTITY.capabilities, ...(fault === "peer-capability" ? [] : [TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE])] });
    const registry = createTelegramBusFollowerRegistry();
    const registration = { instanceId: "peer", registrationGeneration: "generation", profileKey: "manual:peer",
      cwd: "/repo", sessionId: "session", slot: "A", target: { chatId: 7, threadId: 42 }, protocol: peerProtocol, connectedAtMs: 100 };
    registry.register(registration);
    let epoch: string | undefined = fault === "missing-epoch" ? undefined : "epoch";
    let operator: number | undefined = fault === "missing-operator" ? undefined : 7;
    let profile: string | undefined = fault === "default-profile" ? undefined : "default";
    let now = 100;
    const observations: TelegramBusFollowerView[] = [];
    const frames: Array<() => boolean> = [];
    const errors: unknown[] = [];
    let releaseFirst!: () => void, releaseSecond!: () => void;
    const first = new Promise<void>(resolve => { releaseFirst = resolve; });
    const second = new Promise<void>(resolve => { releaseSecond = resolve; });
    const runtime = createTelegramBusLeaderRuntime<string>({ socketPath, followerRegistry: registry,
      authSecret: fault === "no-secret" ? undefined : "secret", protocolIdentity: protocol,
      getCurrentLeaderEpoch: () => epoch, getAllowedUserId: () => operator,
      getTelegramProfile: fault === "missing-profile-reader" ? undefined : () => {
        if (fault === "scope-error") throw new Error("Observation scope unavailable");
        return profile;
      },
      getNowMs: () => ++now, isFollowerProcessAlive: () => true, startPolling() {}, stopPolling() {},
      getFollowerDisplayTitle() {
        if (fault === "epoch") epoch = "replacement";
        if (fault === "profile") profile = "replacement";
        if (fault === "operator") operator = 8;
        if (fault === "replacement") registry.register({ ...registration, registrationGeneration: "replacement" });
        if (fault === "metadata") registry.register({ ...registry.get("peer")!, threadName: "Updated", connectedAtMs: 200 });
        if (fault === "capability-change") protocol.capabilities = protocol.capabilities.filter(value => value !== TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE);
        return "A";
      },
      onWorkspaceRestoreRecipientObserved(follower, isCurrent) {
        assert.equal(isCurrent(), true);
        observations.push(structuredClone(follower)); frames.push(isCurrent);
        follower.target!.threadId = 99; follower.slot = "Z";
        if (fault === "listener-error" || fault === "diagnostic-error") throw new Error("Observation listener failed");
        if (fault === "held") return observations.length === 1 ? first : second;
      },
      recordRuntimeEvent(_category, error, details) {
        if (details?.phase === "workspace-restore-recipient-observation") {
          errors.push(error);
          if (fault === "diagnostic-error") throw new Error("Diagnostic sink unavailable");
        }
      },
    });
    let request = 0;
    const heartbeat = () => sendTelegramBusLocalEnvelope({ socketPath, timeoutMs: 1000, envelope: {
      kind: "follower.heartbeat", requestId: `heartbeat:${++request}`, auth: fault === "unauthorized" ? "wrong" : "secret",
      instanceId: "peer", registrationGeneration: fault === "stale" ? "stale" : "generation", sentAtMs: now,
    } });
    try {
      await runtime.startPolling("ctx");
      const response = await heartbeat();
      assert.equal(response?.kind, "bus.ack");
      assert.equal(response?.kind === "bus.ack" && response.ok, fault !== "unauthorized" && fault !== "stale");
      await new Promise<void>(resolve => setImmediate(resolve));
      const notified = fault === "normal" || fault === "listener-error" || fault === "diagnostic-error" || fault === "held" || fault === "metadata" || fault === "default-profile";
      assert.equal(observations.length, notified ? 1 : 0);
      assert.equal(errors.length, fault === "listener-error" || fault === "diagnostic-error" || fault === "scope-error" ? 1 : 0);
      assert.deepEqual(registry.get("peer")?.target, registration.target, "listener data cannot mutate live registration");
      assert.equal(registry.get("peer")?.slot, "A");
      if (notified) assert.deepEqual(observations[0]?.target, registration.target);
      if (fault !== "held") {
        assert.ok(frames.every(current => !current()), "returned observations cannot lend future callback authority");
        return;
      }
      assert.equal(frames[0]!(), true);
      await heartbeat();
      assert.equal(observations.length, 1, "identical in-flight observations coalesce across heartbeat timestamps");
      const stopping = runtime.stopPolling();
      assert.equal(frames[0]!(), false, "stop invalidates the frame before asynchronous teardown");
      await stopping;
      registry.register(registration);
      await runtime.startPolling("ctx");
      await heartbeat();
      assert.equal(observations.length, 2, "a restarted runtime does not inherit old observation suppression");
      assert.equal(frames[1]!(), true);
      releaseFirst(); await new Promise<void>(resolve => setImmediate(resolve));
      await heartbeat();
      assert.equal(observations.length, 2, "old finalization cannot clear a newer in-flight observation");
      assert.equal(frames[1]!(), true);
      releaseSecond(); await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(frames[1]!(), false);
      await heartbeat();
      assert.equal(observations.length, 3, "settled observations do not suppress later hints");
    } finally {
      releaseFirst(); releaseSecond(); await runtime.stopPolling();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const fault of ["normal", "missing-port", "no-publication", "duplicate", "unknown-publication", "epoch-before", "profile-before", "operator-before", "epoch-after", "replaced-after", "metadata-after"] as const) {
  test(`Bootstrap publication callback and ACK remain fenced (${fault})`, async () => {
    const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "test", capabilities: [
      ...TEST_BUS_PROTOCOL_IDENTITY.capabilities, TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE] });
    const registry = createTelegramBusFollowerRegistry();
    let publicationAttempts = 0;
    if (fault === "unknown-publication") {
      const register = registry.register;
      registry.register = registration => { publicationAttempts += 1; register(registration); throw new Error("Publication confirmation lost"); };
    }
    let epoch = "epoch";
    let profile = "default";
    let operator = 7;
    let provisions = 0;
    let notifications = 0;
    let retained: (() => void) | undefined;
    const handle = createTelegramBusLeaderEnvelopeHandler({ followerRegistry: registry, protocolIdentity: protocol,
      authSecret: "secret", getCurrentLeaderEpoch: () => epoch, getTelegramProfile: () => profile, getAllowedUserId: () => operator,
      provisionFollowerTarget: () => { provisions += 1; return { chatId: 7, threadId: 42, slot: "A" }; },
      onFollowerRegistered() { notifications += 1; },
      ...(fault === "missing-port" ? {} : { async commitFollowerRegistration(_input, publish) {
        retained = publish;
        if (fault === "no-publication") return;
        if (fault === "epoch-before") epoch = "replacement";
        if (fault === "profile-before") profile = "other";
        if (fault === "operator-before") operator = 8;
        if (fault === "unknown-publication") {
          assert.throws(publish, /Publication confirmation lost/);
          publish();
          return;
        }
        publish();
        if (fault === "duplicate") publish();
        if (fault === "epoch-after") epoch = "replacement";
        if (fault === "replaced-after") registry.register({ ...registry.get("follower")!, registrationGeneration: "replacement" });
        if (fault === "metadata-after") {
          registry.register({ ...registry.get("follower")!, threadName: "Updated", connectedAtMs: 99 });
          registry.heartbeat("follower", 100);
        }
      } }),
    });
    const response = await handle({ kind: "follower.register", requestId: "register", auth: "secret",
      registration: { instanceId: "follower", registrationGeneration: "generation", connectedAtMs: 1,
        cwd: "/repo", sessionId: "session", protocol } });
    assert.equal(response.kind, "bus.ack");
    if (response.kind !== "bus.ack") return;
    const success = fault === "normal" || fault === "metadata-after";
    assert.equal(response.ok, success);
    assert.equal(notifications, success ? 1 : 0);
    assert.equal(provisions, fault === "missing-port" ? 0 : 1);
    if (fault === "unknown-publication") {
      assert.equal(publicationAttempts, 1);
      assert.equal(registry.get("follower")?.registrationGeneration, "generation");
    }
    if (["missing-port", "no-publication", "epoch-before", "profile-before", "operator-before"].includes(fault)) assert.equal(registry.get("follower"), undefined);
    if (fault === "replaced-after") assert.equal(registry.get("follower")?.registrationGeneration, "replacement");
    if (retained) assert.throws(retained, /no longer available/, "returned callbacks cannot borrow ended publication authority");
  });
}

for (const fault of ["normal", "late-recovery", "epoch", "operator", "profile"] as const) {
  test(`Native bootstrap commits registry under fresh admission and snapshot transaction (${fault})`, async () => {
    await withWorkspaceRestoreFixture(async ({ store, threads, request, auth, path }) => {
      const committed = (await store.commit(request, auth))!;
      const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "test", capabilities: [
        ...TEST_BUS_PROTOCOL_IDENTITY.capabilities, TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE] });
      const registry = createTelegramBusFollowerRegistry();
      const admission = createTelegramWorkspaceAdmissionLedger({ path: `${path}.admission`, profileKey: "profile:bootstrap",
        owner: { processId: process.pid, processBirthId: `${process.pid}:bootstrap` }, getProcessLiveness: () => "alive" });
      const operations = createTelegramWorkspaceOperationRuntime({ getWorkspaceAdmission: () => admission });
      const nativeRegister = registry.register;
      let publications = 0;
      registry.register = registration => {
        assert.ok(admission.read().leases.some(lease => lease.operationKind === "workspace.publish-follower-registration"));
        assert.throws(() => withTelegramFileTransaction(`${path}.transaction`, () => assert.fail("publication lock missing"),
          { attempts: 1, retryDelayMs: 0 }), /Timed out acquiring Telegram lock transaction/);
        publications += 1;
        return nativeRegister(registration);
      };
      let allowed: number | undefined;
      let epoch = "epoch";
      let profile = "default";
      let publicationAttempts = 0;
      const socketPath = `${path}.sock`;
      const runtime = createTelegramBusLeaderRuntimeAssembly({
        runtime: { socketPath, followerRegistry: registry, protocolIdentity: protocol, authSecret: "secret", startPolling() {}, stopPolling() {} },
        getAllowedUserId: () => allowed, instanceId: "leader", topicTargetStore: threads,
        getCurrentLeaderEpoch: () => epoch, getTelegramProfile: () => profile, getWorkspaceAdmission: () => admission,
        runWorkspaceOperation: (input, operation) => {
          if (input.operationKind === "workspace.reconcile-follower-provision") return Promise.reject(new Error("Background reconciliation excluded from fixture"));
          return operations.run(input, async () => {
            if (input.operationKind === "workspace.publish-follower-registration") {
              publicationAttempts += 1;
              if (fault === "epoch") epoch = "replacement";
              if (fault === "operator") allowed = 8;
              if (fault === "profile") profile = "other";
              if (fault === "late-recovery") {
                const pending = { id: "late", owner: "manual-follower" as const, instanceId: "creator",
                  profileKey: "manual:creator", workspaceBindingKey: "other-binding", slot: "B", startedAtMs: 1000 };
                threads.upsertPendingProvision(pending); await threads.persist();
                await threads.recordPendingProvisionTargetRecovery(pending, request.target);
              }
            }
            return operation();
          });
        },
        async callApi<TResponse>(method: string) { assert.equal(method, "sendMessage"); return {} as TResponse; },
        async callMultipart() {}, async downloadFile() {}, getSyncState: () => ({}), setSyncState() {}, setLeaderTarget() {}, recordRuntimeEvent() {},
      });
      try {
        await runtime.startPolling("ctx"); allowed = 7;
        const response = await sendTelegramBusLocalEnvelope({ socketPath, timeoutMs: 2000, envelope: {
          kind: "follower.register", requestId: "register", auth: "secret", registration: {
            instanceId: "successor", previousInstanceId: request.owner.instanceId, profileKey: "manual:successor",
            registrationGeneration: "generation", cwd: request.binding.cwd, sessionId: request.binding.sessionId,
            target: request.target, slot: "A", connectedAtMs: 1001, protocol,
          },
        } });
        assert.equal(response?.kind, "bus.ack");
        if (response?.kind !== "bus.ack") return;
        assert.equal(response.ok, fault === "normal", response.message);
        assert.equal(publicationAttempts, 1);
        assert.equal(publications, fault === "normal" ? 1 : 0);
        assert.equal(!!registry.get("successor"), fault === "normal");
        assert.deepEqual(store.list(), [committed]);
        assert.deepEqual(admission.read().leases, []);
      } finally { await runtime.stopPolling(); }
    }, "follower");
  });
}

test("Bus leader preserves a binding through follower reload handoff", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-gap-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  store.upsert({
    profileKey: "manual:owner-a",
    owner: { kind: "manual-follower", instanceId: "owner-a" },
    target: { chatId: 7, threadId: 42 },
    status: "active",
    createdAtMs: 900,
    updatedAtMs: 950,
    instanceId: "follower-old",
    slot: "C",
    threadName: "Cedar",
  });
  const calls: unknown[] = [];
  let syncState = {};
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { ok: true } as TResponse;
    },
    getNowMs: () => 1001,
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    recordRuntimeEvent() {},
  });
  try {
    assert.deepEqual(
      await provision({
        instanceId: "follower-new",
        profileKey: "manual:owner-a",
        target: { chatId: 7, threadId: 42 },
        connectedAtMs: 1001,
      }),
      { chatId: 7, threadId: 42, slot: "C", threadName: "Cedar" },
    );
    assert.deepEqual(calls, [
      {
        method: "sendMessage",
        body: {
          chat_id: 7,
          message_thread_id: 42,
          text: "<b>📡 Instance <i>Cedar</i> connected.</b>",
          parse_mode: "HTML",
        },
      },
    ]);
    assert.equal(store.list()[0]?.instanceId, "follower-new");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const scenario of ["old-target", "missing-identity", "foreign-session", "valid", "late-recovery", "lost-evidence"] as const) {
  test(`Follower registration preparation fences retained Restore (${scenario})`, async () => {
    await withWorkspaceRestoreFixture(async ({ store, threads, request, auth, path }) => {
      const committed = (await store.commit(request, auth))!;
      const pending = { id: "late", owner: "manual-follower" as const, instanceId: "creator", profileKey: "manual:creator",
        workspaceBindingKey: "other-binding", slot: "B", startedAtMs: 1000 };
      if (scenario === "late-recovery") { threads.upsertPendingProvision(pending); await threads.persist(); }
      let expectedSnapshot = readFileSync(path, "utf8");
      const records = threads.list();
      const calls: string[] = [];
      const provision = createTelegramBusFollowerTargetProvisioner({
        getAllowedUserId: () => 7, topicTargetStore: threads, getNowMs: () => 1001,
        getSyncState: () => ({}), setSyncState() {}, recordRuntimeEvent() {},
        async runWorkspaceOperation() { throw new Error("Background reconciliation excluded from fixture"); },
        async callApi<TResponse>(method: string) {
          calls.push(method);
          if (scenario === "late-recovery") await threads.recordPendingProvisionTargetRecovery(pending, request.target);
          if (scenario === "lost-evidence") {
            const snapshot = JSON.parse(readFileSync(path, "utf8"));
            delete snapshot.workspaceRestore;
            expectedSnapshot = JSON.stringify(snapshot);
            writeFileSync(path, expectedSnapshot);
          }
          return {} as TResponse;
        },
      });
      const connect = () => provision({ instanceId: "successor", previousInstanceId: request.owner.instanceId,
        profileKey: "manual:successor", connectedAtMs: 1001, slot: "A",
        ...(scenario === "missing-identity" ? {} : { cwd: request.binding.cwd,
          sessionId: scenario === "foreign-session" ? "foreign-session" : request.binding.sessionId }),
        target: scenario === "old-target" ? request.binding.target : request.target });
      if (scenario === "valid") {
        const result = await connect();
        assert.equal(result?.threadId, request.target.threadId);
        assert.equal(result?.slot, "A");
        assert.deepEqual(calls, ["sendMessage"]);
        assert.equal(threads.listWorkspaceBindings()[0]?.sessionId, request.binding.sessionId);
      } else {
        await assert.rejects(connect(), /Workspace Restore|Workspace identity/);
        assert.deepEqual(calls, scenario === "late-recovery" || scenario === "lost-evidence" ? ["sendMessage"] : []);
        assert.equal(readFileSync(path, "utf8"), expectedSnapshot);
        assert.deepEqual(threads.list(), records, "failed protection cannot transfer even the in-memory owner");
        assert.ok(threads.claimWorkspaceIdentity(request.binding.cwd, "after-rejection", request.owner.instanceId,
          { sessionId: request.binding.sessionId, existingBindingOnly: true }), "failed registration releases its transient claim");
        threads.releaseWorkspaceClaim("after-rejection");
      }
      if (scenario === "lost-evidence") assert.throws(() => store.list(), /Workspace Restore evidence/);
      else assert.deepEqual(store.list(), [committed]);
    }, "follower");
  });
}

test("Follower recovery shortcuts preserve pending evidence under exact cleanup or closed protection", async () => {
  for (const recovery of ["reconnect", "carried-target"] as const) {
    for (const protection of ["cleanup", "closed", "other-chat"] as const) {
      const dir = mkdtempSync(join(tmpdir(), "pi-telegram-pending-follower-protection-"));
      const path = join(dir, "state.json");
      const store = createTelegramTopicTargetStore({ path, getNowMs: () => 1000 });
      try {
        const identity = store.claimWorkspaceIdentity("/repo/workspace", "follower-a")!;
        const request = { instanceId: "follower-a", profileKey: "manual:follower-a",
          workspaceBindingKey: identity.bindingKey, workspaceCwd: identity.cwd };
        const create = createTelegramTopicTargetProvisioner({
          topicChatId: 7, store, getNowMs: () => 1000,
          resolveInitialWorkspaceDisplayTitle: () => "workspace",
          async callApi<TResponse>() { return { message_thread_id: 42 } as TResponse; },
        });
        const created = await create(request);
        if (protection === "closed") {
          store.markStaleByTarget(created.target, "closed");
          if (recovery === "reconnect") store.upsert(created.record);
        } else {
          if (recovery === "carried-target") store.markStaleByTarget(created.target, "unknown");
          store.upsertPendingCleanup({ id: "cleanup", owner: "manual-follower", instanceId: "follower-a",
            runtimeGeneration: "follower-a:1", profileKey: request.profileKey,
            target: { chatId: protection === "other-chat" ? 8 : 7, threadId: 42 }, requestedAtMs: 1001 });
        }
        await store.persist();
        const pending = store.listPendingProvisions();
        const cleanups = store.listPendingCleanups();
        const records = store.list();
        const apiCalls: string[] = [];
        const provision = createTelegramBusFollowerTargetProvisioner({
          getAllowedUserId: () => 7, topicTargetStore: store, getNowMs: () => 1002,
          getSyncState: () => ({}), setSyncState() {}, recordRuntimeEvent() {},
          async runWorkspaceOperation() { throw new Error("Background reconciliation excluded from fixture"); },
          async callApi<TResponse>(method: string) { apiCalls.push(method); return {} as TResponse; },
        });
        const connect = () => provision({ instanceId: "follower-a", profileKey: request.profileKey,
          cwd: identity.cwd, target: { chatId: 7, threadId: 42 }, connectedAtMs: 1002 });
        if (protection === "other-chat") {
          assert.equal((await connect())?.threadId, 42);
          assert.deepEqual(store.listPendingProvisions(), []);
        } else {
          await assert.rejects(connect(), /requires reconciliation/);
          assert.deepEqual(apiCalls, []);
          assert.deepEqual(store.list(), records);
          assert.deepEqual(store.listPendingProvisions(), pending);
          assert.equal(store.getWorkspaceBinding(identity.cwd), undefined);
          const reloaded = createTelegramTopicTargetStore({ path });
          await reloaded.load();
          assert.deepEqual(reloaded.listPendingProvisions(), pending);
        }
        assert.deepEqual(store.listPendingCleanups(), cleanups);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});

for (const state of ["dead", "alive", "unknown", "registered", "other-session", "ambiguous", "unknown-runtime", "missing-liveness", "missing-registry"] as const) {
  test(`Cold restore-only follower reclaims the retained Thread after predecessor death (${state})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-telegram-cold-follower-"));
    const store = createTelegramTopicTargetStore({ path: join(dir, "state.json"), getNowMs: () => 1000 });
    await store.load();
    const identity = createTelegramWorkspaceBindingIdentity("/repo", 1, "session")!;
    const target = { chatId: 7, threadId: 42 }, oldRuntime = state === "unknown-runtime" ? "opaque-runtime" : "424242:1000";
    store.upsertWorkspaceBinding({ ...identity, target, slot: "S", threadName: "Signal", displayTitle: "Home", updatedAtMs: 1,
      journalBindingKeys: ["retained-journal"], journalSources: [{ sessionId: "session", recipientBindingKey: "manual:stable" }], journalBindingsComplete: true });
    store.upsert({ profileKey: "manual:stable", owner: { kind: "manual-follower", instanceId: "stable" }, instanceId: oldRuntime,
      target, slot: "S", threadName: "Signal", status: "active", createdAtMs: 1, updatedAtMs: 1 });
    if (state === "ambiguous") {
      store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/repo", 2, "session")!, target: { chatId: 7, threadId: 43 },
        slot: "T", threadName: "Topaz", updatedAtMs: 1 });
      store.upsert({ profileKey: "manual:other", owner: { kind: "manual-follower", instanceId: "other" }, instanceId: "424243:1000",
        target: { chatId: 7, threadId: 43 }, slot: "T", threadName: "Topaz", status: "active", createdAtMs: 1, updatedAtMs: 1 });
    }
    await store.persist();
    const before = readFileSync(join(dir, "state.json"), "utf8"), registry = createTelegramBusFollowerRegistry();
    if (state === "registered") registry.register({ instanceId: oldRuntime, cwd: "/repo", sessionId: "session", target, connectedAtMs: 1 });
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const provision = createTelegramBusFollowerTargetProvisioner({ topicTargetStore: store, getAllowedUserId: () => 7,
      getLiveFollowers: state === "missing-registry" ? undefined : registry.list,
      isFollowerProcessAlive: state === "missing-liveness" ? undefined : (pid) => { assert.ok(pid === 424242 || pid === 424243); if (state === "unknown") throw new Error("PID metadata unavailable"); return state === "alive"; },
      async callApi<TResponse>(method: string, body: Record<string, unknown>) { calls.push({ method, body }); return true as TResponse; },
      getSyncState: () => ({}), setSyncState() {}, recordRuntimeEvent() {}, getNowMs: () => 1000 });
    try {
      const result = await provision({ instanceId: "successor", profileKey: "manual:successor", cwd: "/repo", sessionId: state === "other-session" ? "foreign" : "session",
        connectedAtMs: 1000 }, { existingWorkspaceBindingOnly: true });
      if (state !== "dead" && state !== "other-session") {
        assert.equal(result, undefined); assert.deepEqual(calls, []); assert.equal(readFileSync(join(dir, "state.json"), "utf8"), before);
      } else {
        assert.deepEqual(result, { ...target, slot: "S", threadName: "Signal" });
        assert.deepEqual(calls.map(call => call.method), ["sendMessage"]);
        assert.match(String(calls[0]!.body.text), /Instance <i>Home<\/i> connected/);
        // A folder whose previous session is gone hands its Thread to the successor instead of leaving an orphan.
        const successorSession = state === "other-session" ? "foreign" : "session";
        assert.deepEqual(store.getWorkspaceBindingByTarget(target, successorSession)?.journalBindingKeys, ["retained-journal"]);
        assert.equal(store.getWorkspaceBindingByTarget(target, successorSession)?.instanceSlot, "b");
        assert.equal(store.listWorkspaceBindings().length, 1);
        if (state === "other-session") assert.equal(store.getWorkspaceBindingByTarget(target, "session"), undefined);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("A new session in a folder with no live predecessor adopts the retained Thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-session-adoption-"));
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json"), getNowMs: () => 1000 });
  await store.load();
  const identity = createTelegramWorkspaceBindingIdentity("/repo", 1, "session")!;
  const target = { chatId: 7, threadId: 42 };
  store.upsertWorkspaceBinding({ ...identity, target, slot: "S", threadName: "Signal", displayTitle: "Home", updatedAtMs: 1 });
  store.upsert({ profileKey: "manual:stable", owner: { kind: "manual-follower", instanceId: "stable" }, instanceId: "424242:1000",
    target, slot: "S", threadName: "Signal", status: "active", createdAtMs: 1, updatedAtMs: 1 });
  await store.persist();
  const sourceSlot = store.getWorkspaceBindingByTarget(target, "session")?.instanceSlot;
  assert.equal(sourceSlot, "b");
  let alive = true;
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const provision = createTelegramBusFollowerTargetProvisioner({ topicTargetStore: store, getAllowedUserId: () => 7,
    getLiveFollowers: () => [],
    isFollowerProcessAlive: () => alive,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) { calls.push({ method, body }); return { message_thread_id: 43 } as TResponse; },
    getSyncState: () => ({}), setSyncState() {}, recordRuntimeEvent() {}, getNowMs: () => 1000 });
  try {
    // A live predecessor keeps its Thread; the registering session gets its own target.
    const live = await provision({ instanceId: "live-successor", profileKey: "manual:live", cwd: "/repo", sessionId: "next", connectedAtMs: 1000 });
    assert.notEqual(live?.threadId, 42);
    assert.equal(store.getWorkspaceBindingByTarget(target, "session")?.sessionId, "session");
    alive = false;
    const result = await provision({ instanceId: "successor", profileKey: "manual:successor", cwd: "/repo", sessionId: "later", connectedAtMs: 1001 });
    assert.deepEqual(result, { ...target, slot: "S", threadName: "Signal" });
    assert.equal(store.getWorkspaceBindingByTarget(target, "later")?.sessionId, "later");
    assert.equal(store.getWorkspaceBindingByTarget(target, "session"), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Bus leader restore-only provisioning does not allocate a missing Workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-restore-only-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  const calls: string[] = [];
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string) {
      calls.push(method);
      return { message_thread_id: 42 } as TResponse;
    },
    getNowMs: () => 1000,
    getSyncState: () => ({}),
    setSyncState() {},
    recordRuntimeEvent() {},
  });
  try {
    assert.equal(
      await provision({
        instanceId: "follower-new",
        profileKey: "manual:owner-new",
        cwd: "/repo/workspace",
        connectedAtMs: 1000,
      }, { existingWorkspaceBindingOnly: true }),
      undefined,
    );
    assert.equal(
      await provision({
        instanceId: "follower-without-cwd",
        profileKey: "manual:owner-without-cwd",
        connectedAtMs: 1001,
      }, { existingWorkspaceBindingOnly: true }),
      undefined,
    );
    assert.deepEqual(calls, []);
    assert.equal(store.hasWorkspaceBinding("/repo/workspace"), false);
    assert.equal(store.listWorkspaceBindings().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader reclaims a dormant follower Thread by Workspace cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-workspace-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let syncState = {};
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return (method === "createForumTopic"
        ? { message_thread_id: 42 }
        : { ok: true }) as TResponse;
    },
    getNowMs: () => 1000,
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    recordRuntimeEvent() {},
  });
  try {
    const initial = await provision({
      instanceId: "follower-old",
      profileKey: "manual:owner-old",
      cwd: "/repo/workspace",
      connectedAtMs: 1000,
    });
    assert.equal(initial?.threadId, 42);
    const workspace = store.getWorkspaceBinding("/repo/workspace");
    assert.equal(workspace?.target.threadId, 42);
    assert.equal(workspace?.threadName, initial?.threadName);
    assert.deepEqual(workspace?.journalBindingKeys, ["manual:owner-old"]);
    assert.equal(workspace?.journalBindingsComplete, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    store.markOfflineByInstanceId("follower-old");
    assert.equal(store.markWorkspaceBindingInactiveByTarget(initial!), true);
    await store.persist();
    calls.length = 0;

    const reopened = await provision({
      instanceId: "follower-new",
      profileKey: "manual:owner-new",
      cwd: "/repo/workspace/",
      connectedAtMs: 2000,
    }, { existingWorkspaceBindingOnly: true });
    assert.deepEqual(reopened, initial);
    assert.deepEqual(calls.map((call) => call.method), ["sendMessage"]);
    assert.equal(store.list()[0]?.instanceId, "follower-new");
    assert.equal(
      store.getWorkspaceBinding("/repo/workspace")?.target.threadId,
      42,
    );
    assert.equal(
      store.getWorkspaceBinding("/repo/workspace")?.inactiveSinceMs,
      undefined,
    );
    assert.deepEqual(
      store.getWorkspaceBinding("/repo/workspace")?.journalBindingKeys,
      ["manual:owner-old", "manual:owner-new"],
    );
    assert.equal(
      store.getWorkspaceBinding("/repo/workspace")?.journalBindingsComplete,
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Failed missing-slot restore leaves migration uncommitted and retries the same free letter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-missing-slot-retry-"));
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json"), getNowMs: () => 1000 });
  store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/occupied")!,
    target: { chatId: 7, threadId: 41 }, slot: "A", threadName: "Anchor", updatedAtMs: 1 });
  store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/legacy")!,
    target: { chatId: 7, threadId: 42 }, threadName: "Briar", updatedAtMs: 1 });
  let failProbe = true;
  const calls: string[] = [];
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7, topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push(`${method}:${body.message_thread_id ?? "new"}`);
      if (method === "createForumTopic") throw new Error("restore-only migration must not create a Thread");
      if (failProbe) { failProbe = false; throw new Error("fixture visibility unknown"); }
      return { ok: true } as TResponse;
    },
    getSyncState: () => ({}), setSyncState() {}, recordRuntimeEvent() {}, getNowMs: () => 1000,
  });
  try {
    await store.persist();
    await assert.rejects(provision({ instanceId: "first", cwd: "/legacy",
      connectedAtMs: 1 }, { existingWorkspaceBindingOnly: true }), /visibility unknown/);
    assert.equal(store.getWorkspaceBinding("/legacy")?.slot, undefined);
    assert.equal(store.getWorkspaceBinding("/legacy")?.inactiveSinceMs, undefined);
    assert.equal(store.list().find((record) => record.target.threadId === 42)?.status, "probe-required");
    const restored = await provision({ instanceId: "retry", cwd: "/legacy/",
      connectedAtMs: 2 }, { existingWorkspaceBindingOnly: true });
    assert.deepEqual(restored, { chatId: 7, threadId: 42, slot: "B", threadName: "Briar" });
    assert.equal(store.getWorkspaceBinding("/legacy")?.slot, "B");
    assert.equal(store.getWorkspaceBinding("/legacy")?.bindingKey,
      createTelegramWorkspaceBindingIdentity("/legacy")?.bindingKey);
    assert.equal(store.getWorkspaceBinding("/legacy")?.inactiveSinceMs, undefined);
    assert.deepEqual(store.getWorkspaceBinding("/legacy")?.journalBindingKeys, ["manual:retry"]);
    assert.equal(store.getWorkspaceBinding("/legacy")?.journalBindingsComplete, undefined);
    const recoveredRecord = store.list().find((record) => record.target.threadId === 42);
    assert.equal(recoveredRecord?.status, "active");
    assert.equal(recoveredRecord?.instanceId, "retry");
    assert.equal(recoveredRecord?.profileKey, "manual:retry");
    assert.deepEqual(calls, ["sendMessage:42", "sendMessage:42"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader migrates a persisted manual follower record into its Workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-workspace-migration-"));
  const path = join(dir, "state.json");
  const oldStore = createTelegramTopicTargetStore({ path });
  oldStore.upsert({
    profileKey: "manual:worker-profile",
    owner: { kind: "manual-follower", instanceId: "worker-profile" },
    target: { chatId: 7, threadId: 42 },
    status: "active",
    createdAtMs: 900,
    updatedAtMs: 950,
    instanceId: "follower-old",
    slot: "C",
    threadName: "Cedar",
  });
  await oldStore.persist();

  const store = createTelegramTopicTargetStore({
    path,
    getNowMs: () => 1000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let syncState = {};
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      if (method === "createForumTopic") {
        throw new Error("legacy Workspace migration must not create a topic");
      }
      return { ok: true } as TResponse;
    },
    getNowMs: () => 1000,
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    recordRuntimeEvent() {},
  });
  try {
    assert.deepEqual(
      await provision({
        instanceId: "follower-new",
        previousInstanceId: "follower-old",
        profileKey: "manual:worker-profile",
        cwd: "/repo/workspace/",
        connectedAtMs: 1000,
      }),
      { chatId: 7, threadId: 42, slot: "C", threadName: "Cedar" },
    );
    assert.deepEqual(calls.map((call) => call.method), ["sendMessage"]);
    assert.equal(
      store.getWorkspaceBinding("/repo/workspace")?.target.threadId,
      42,
    );

    const restored = createTelegramTopicTargetStore({ path });
    await restored.load();
    assert.equal(
      restored.getWorkspaceBinding("/repo/workspace")?.threadName,
      "Cedar",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader allocates a Workspace b binding for a concurrent same-cwd follower", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-workspace-b-"));
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  let nextThreadId = 41;
  let syncState = {};
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string) {
      if (method === "createForumTopic") {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return { message_thread_id: ++nextThreadId } as TResponse;
      }
      return { ok: true } as TResponse;
    },
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    recordRuntimeEvent() {},
  });
  try {
    const [first, second, third] = await Promise.all([
      provision({
        instanceId: "follower-a",
        cwd: "/repo/workspace",
        connectedAtMs: 1000,
      }),
      provision({
        instanceId: "follower-b",
        cwd: "/repo/workspace",
        connectedAtMs: 1001,
      }),
      provision({
        instanceId: "follower-c",
        cwd: "/another/workspace",
        connectedAtMs: 1002,
      }),
    ]);
    assert.deepEqual([first?.slot, second?.slot, third?.slot], ["A", "B", "C"]);
    assert.equal(store.getWorkspaceBinding("/another/workspace")?.slot, "C");
    assert.notEqual(first?.threadId, second?.threadId);
    assert.equal(
      store.getWorkspaceBinding("/repo/workspace", "a")?.target.threadId,
      first?.threadId,
    );
    assert.equal(
      store.getWorkspaceBinding("/repo/workspace", "b")?.target.threadId,
      second?.threadId,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Cold same-Workspace reopen assigns dormant bindings by claim order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-workspace-reopen-order-"));
  const path = join(dir, "state.json");
  const oldStore = createTelegramTopicTargetStore({ path });
  const firstIdentity = createTelegramWorkspaceBindingIdentity("/repo/workspace");
  const secondIdentity = createTelegramWorkspaceBindingIdentity(
    "/repo/workspace",
    1,
  );
  assert.ok(firstIdentity);
  assert.ok(secondIdentity);
  oldStore.upsertWorkspaceBinding({
    ...firstIdentity,
    target: { chatId: 7, threadId: 41 },
    threadName: "Atlas",
    slot: "A",
    updatedAtMs: 900,
  });
  oldStore.upsertWorkspaceBinding({
    ...secondIdentity,
    target: { chatId: 7, threadId: 42 },
    threadName: "Cedar",
    slot: "C",
    updatedAtMs: 901,
  });
  await oldStore.persist();

  const store = createTelegramTopicTargetStore({ path });
  const calls: string[] = [];
  let syncState = {};
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string) {
      calls.push(method);
      if (method === "createForumTopic") {
        throw new Error("cold Workspace reopen must not create a topic");
      }
      return { ok: true } as TResponse;
    },
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    recordRuntimeEvent() {},
  });
  try {
    const openedSecondInTheTerminal = await provision({
      instanceId: "terminal-second",
      cwd: "/repo/workspace",
      connectedAtMs: 1000,
    });
    const openedFirstInTheTerminal = await provision({
      instanceId: "terminal-first",
      cwd: "/repo/workspace",
      connectedAtMs: 1001,
    });

    assert.equal(openedSecondInTheTerminal?.threadId, 41);
    assert.equal(openedFirstInTheTerminal?.threadId, 42);
    assert.deepEqual(calls, ["sendMessage", "sendMessage"]);
    assert.equal(store.listWorkspaceBindings().length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Explicit same-cwd follower provisioning leaves the active leader target untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-same-cwd-leader-"));
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  const identity = createTelegramWorkspaceBindingIdentity("/repo");
  assert.ok(identity);
  store.upsertWorkspaceBinding({
    ...identity,
    target: { chatId: 7, threadId: 41 },
    threadName: "Atlas",
    slot: "A",
    updatedAtMs: 1000,
  });
  store.upsert({
    profileKey: "cwd:/repo",
    owner: { kind: "leader", cwd: "/repo", instanceId: "leader" },
    instanceId: "leader",
    target: { chatId: 7, threadId: 41 },
    status: "active",
    createdAtMs: 1000,
    updatedAtMs: 1000,
    threadName: "Atlas",
    slot: "A",
  });
  const calls: Array<{ method: string; threadId: unknown }> = [];
  let syncState = {};
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, threadId: body.message_thread_id });
      return (method === "createForumTopic"
        ? { message_thread_id: 42 }
        : { ok: true }) as TResponse;
    },
    getSyncState: () => syncState,
    setSyncState(state) { syncState = state; },
    recordRuntimeEvent() {},
  });
  try {
    await store.persist();
    assert.equal(await provision({
      instanceId: "startup",
      profileKey: "manual:startup",
      cwd: "/repo",
      connectedAtMs: 1001,
    }, { existingWorkspaceBindingOnly: true }), undefined);
    assert.equal(calls.length, 0);
    const result = await provision({
      instanceId: "follower",
      profileKey: "manual:follower",
      cwd: "/repo/",
      connectedAtMs: 1002,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(result?.threadId, 42);
    assert.equal(store.getWorkspaceBinding("/repo", "b")?.target.threadId, 42);
    assert.equal(store.getWorkspaceBinding("/repo")?.target.threadId, 41);
    assert.equal(store.getByProfileKey("cwd:/repo")?.instanceId, "leader");
    assert.equal(calls.some((call) => call.threadId === 41), false);
    assert.equal(calls.filter((call) => call.method === "createForumTopic").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Explicit follower connect recovers unknown creation without changing another binding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-connect-recovery-"));
  const path = join(dir, "state.json"), store = createTelegramTopicTargetStore({ path });
  const identity = createTelegramWorkspaceBindingIdentity("/other", 0, "other-session")!;
  store.upsertWorkspaceBinding({ ...identity, target: { chatId: 7, threadId: 80 }, slot: "A", updatedAtMs: 1 });
  await store.persist();
  const before = store.listWorkspaceBindings();
  let creates = 0, syncState = {};
  const events: unknown[] = [];
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7, topicTargetStore: store, getCurrentLeaderEpoch: () => "epoch",
    async callApi<TResponse>(method: string) {
      if (method === "createForumTopic") {
        if (++creates === 1) throw new TelegramApiCommitUnknownError(method, new Error("response lost"));
        return { message_thread_id: 42 } as TResponse;
      }
      return true as TResponse;
    },
    getSyncState: () => syncState, setSyncState: value => { syncState = value; },
    recordRuntimeEvent(_category, message) { events.push(message); },
  });
  const registration = { instanceId: "follower", profileKey: "manual:stable", cwd: "/repo", sessionId: "session", connectedAtMs: Date.now() };
  try {
    await assert.rejects(provision(registration), /may have committed/);
    assert.equal(creates, 1);
    assert.equal(store.listPendingProvisions().length, 1);
    await assert.rejects(provision(registration), /unfinished Thread|remains ambiguous/);
    assert.equal(creates, 1, "Ordinary retry never repeats unknown creation");
    assert.equal(await provision(registration, { existingWorkspaceBindingOnly: true, recoverConnection: true }), undefined);
    assert.equal(creates, 1, "Restore-only cannot reset even with a conflicting caller option");
    const target = await provision(registration, { recoverConnection: true });
    assert.equal(target?.threadId, 42);
    assert.equal(creates, 2);
    assert.deepEqual(store.listWorkspaceBindings().filter(b => b.cwd === identity.cwd), before);
    assert.deepEqual(store.listPendingProvisions(), []);
    assert.ok(events.some(value => String(value).includes("Explicit connect reset")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Follower connect reuses a known pending Thread across runtime replacement without another create", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-follower-targeted-recovery-"));
  const path = join(dir, "state.json"), store = createTelegramTopicTargetStore({ path });
  const identity = createTelegramWorkspaceBindingIdentity("/repo", 0, "session")!;
  store.upsertPendingProvision({ id: "known", owner: "manual-follower", instanceId: "old",
    profileKey: "manual:stable", workspaceBindingKey: identity.bindingKey, status: "ambiguous",
    target: { chatId: 7, threadId: 42 }, slot: "B", threadName: "Boreal", startedAtMs: 1 });
  await store.persist();
  let syncState = {};
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7, topicTargetStore: store, getCurrentLeaderEpoch: () => "epoch",
    async callApi<TResponse>(method: string) {
      assert.notEqual(method, "createForumTopic"); assert.notEqual(method, "deleteForumTopic");
      return true as TResponse;
    },
    getSyncState: () => syncState, setSyncState: value => { syncState = value; }, recordRuntimeEvent() {},
  });
  try {
    const target = await provision({ instanceId: "new", profileKey: "manual:stable", cwd: "/repo",
      sessionId: "session", connectedAtMs: Date.now() }, { recoverConnection: true });
    assert.equal(target?.threadId, 42); assert.equal(target?.slot, "B");
    assert.equal(store.getWorkspaceBinding("/repo", "a", "session")?.target.threadId, 42);
    assert.deepEqual(store.listPendingProvisions(), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Bus leader releases a failed follower Workspace claim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-workspace-fail-"));
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  let fail = true;
  let syncState = {};
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string) {
      if (method === "createForumTopic" && fail) throw new Error("offline");
      return (method === "createForumTopic"
        ? { message_thread_id: 42 }
        : { ok: true }) as TResponse;
    },
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    recordRuntimeEvent() {},
  });
  try {
    await assert.rejects(
      provision({
        instanceId: "follower-failed",
        cwd: "/repo/workspace",
        connectedAtMs: 1000,
      }),
      /offline/u,
    );
    fail = false;
    await provision({
      instanceId: "follower-retry",
      cwd: "/repo/workspace",
      connectedAtMs: 1001,
    });
    assert.ok(store.getWorkspaceBinding("/repo/workspace", "a"));
    assert.equal(store.getWorkspaceBinding("/repo/workspace", "b"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader verifies message delivery again across an immediate follower session handoff", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-notice-handoff-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let syncState = {};
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      if (method === "createForumTopic") {
        return { message_thread_id: 42 } as TResponse;
      }
      return { ok: true } as TResponse;
    },
    getNowMs: () => 1000,
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    recordRuntimeEvent() {},
  });
  try {
    const initialTarget = await provision({
      instanceId: "follower-old",
      profileKey: "manual:owner-a",
      connectedAtMs: 1000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      await provision({
        instanceId: "follower-new",
        previousInstanceId: "follower-old",
        profileKey: "manual:owner-a",
        target: initialTarget,
        connectedAtMs: 1001,
      }),
      initialTarget,
    );
    assert.deepEqual(calls.map((call) => call.method), [
      "createForumTopic",
      "sendMessage",
      "sendMessage",
    ]);
    assert.equal(
      calls.filter((call) => call.method === "sendMessage").length,
      2,
    );
    assert.deepEqual(calls.at(-1)?.body, calls[1]?.body);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader migrates a reloaded follower from generation to stable identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-identity-migration-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  store.upsert({
    profileKey: "manual:75433:generation:1000",
    owner: {
      kind: "manual-follower",
      instanceId: "75433:generation:1000",
    },
    target: { chatId: 7, threadId: 42 },
    status: "active",
    createdAtMs: 900,
    updatedAtMs: 950,
    instanceId: "follower-old",
    slot: "C",
    threadName: "Cedar",
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let syncState = {};
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { ok: true } as TResponse;
    },
    getNowMs: () => 1001,
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    recordRuntimeEvent() {},
  });
  try {
    assert.deepEqual(
      await provision({
        instanceId: "follower-new",
        previousInstanceId: "follower-old",
        profileKey: "manual:75433:start:stable",
        target: { chatId: 7, threadId: 42 },
        connectedAtMs: 1001,
      }),
      { chatId: 7, threadId: 42, slot: "C", threadName: "Cedar" },
    );
    assert.deepEqual(calls, [
      {
        method: "sendMessage",
        body: {
          chat_id: 7,
          message_thread_id: 42,
          text: "<b>📡 Instance <i>Cedar</i> connected.</b>",
          parse_mode: "HTML",
        },
      },
    ]);
    assert.equal(store.list().length, 1);
    assert.equal(
      store.getByProfileKey("manual:75433:start:stable")?.instanceId,
      "follower-new",
    );
    assert.equal(
      store.getByProfileKey("manual:75433:generation:1000"),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader API proxy forwards supported methods and recovers stale targets", async () => {
  const calls: unknown[] = [];
  const recovered: unknown[] = [];
  const proxy = createTelegramBusLeaderApiProxy({
    async call(method, body, options) {
      calls.push({ kind: "call", method, body, options });
      if (method === "sendMessage") throw new Error("stale topic");
      return { ok: true };
    },
    async callMultipart(
      method,
      fields,
      fieldName,
      filePath,
      fileName,
      options,
    ) {
      calls.push({
        kind: "multipart",
        method,
        fields,
        fieldName,
        filePath,
        fileName,
        options,
      });
      return { ok: true };
    },
    async downloadFile(fileId, destinationDir) {
      calls.push({ kind: "download", fileId, destinationDir });
      return "/tmp/file";
    },
    recoverStaleTargetError(apiBody, error) {
      recovered.push({ apiBody, message: (error as Error).message });
    },
  });
  await assert.rejects(
    () => proxy("call", ["sendMessage", { chat_id: 1 }, { maxAttempts: 1 }]),
    /stale topic/,
  );
  assert.deepEqual(
    await proxy("callMultipart", [
      "sendDocument",
      { chat_id: "1" },
      "document",
      "/tmp/a.txt",
      "a.txt",
      undefined,
    ]),
    { ok: true },
  );
  assert.equal(await proxy("downloadFile", ["file-id", "/tmp"]), "/tmp/file");
  assert.deepEqual(recovered, [
    { apiBody: { chat_id: 1 }, message: "stale topic" },
  ]);
  assert.deepEqual(calls, [
    {
      kind: "call",
      method: "sendMessage",
      body: { chat_id: 1 },
      options: { maxAttempts: 1 },
    },
    {
      kind: "multipart",
      method: "sendDocument",
      fields: { chat_id: "1" },
      fieldName: "document",
      filePath: "/tmp/a.txt",
      fileName: "a.txt",
      options: undefined,
    },
    { kind: "download", fileId: "file-id", destinationDir: "/tmp" },
  ]);
  await assert.rejects(() => proxy("unknown", []), /Unsupported/);
});

test("Bus leader follower disconnect preserves binding when deletion is unconfirmed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-disconnect-fail-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/repo")!,
    target: { chatId: 7, threadId: 42 }, slot: "A", threadName: "Anchor", updatedAtMs: 500,
  });
  store.upsert({
    profileKey: "manual:owner-a",
    owner: { kind: "manual-follower", instanceId: "owner-a" },
    target: { chatId: 7, threadId: 42 },
    status: "active",
    createdAtMs: 500,
    updatedAtMs: 500,
    instanceId: "follower-a",
  });
  const disconnect = createTelegramBusFollowerDisconnectHandler({
    topicTargetStore: store,
    async callApi<TResponse>(method: string) {
      if (method === "deleteForumTopic") {
        throw new Error("temporary Bot API failure");
      }
      return { ok: true } as TResponse;
    },
    getSyncState: () => ({}),
    setSyncState: () => undefined,
    recordRuntimeEvent: () => undefined,
  });
  try {
    await assert.rejects(
      disconnect({
        instanceId: "follower-a",
        registrationGeneration: "follower-a:1",
        connectedAtMs: 500,
        lastHeartbeatMs: 1000,
        target: { chatId: 7, threadId: 42 },
      }),
      /deletion was not confirmed/,
    );
    assert.equal(
      store.getByProfileKey("manual:owner-a")?.status,
      "active",
    );
    assert.equal(store.listPendingCleanups()[0]?.runtimeGeneration, "follower-a:1");
    assert.equal(store.getWorkspaceBinding("/repo")?.inactiveSinceMs, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const registrationThreadName of ["workspace", "Override"]) {
test(`Confirmed-dead cleanup preserves Workspace identity despite registration name ${registrationThreadName}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-workspace-dead-reopen-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  const workspaceIdentity = createTelegramWorkspaceBindingIdentity(
    "/repo/workspace",
  );
  assert.ok(workspaceIdentity);
  store.upsert({
    profileKey: "manual:worker",
    owner: { kind: "manual-follower", instanceId: "worker" },
    target: { chatId: 7, threadId: 42 },
    status: "active",
    createdAtMs: 500,
    updatedAtMs: 500,
    instanceId: "follower-dead",
    threadName: "Cedar",
    slot: "C",
  });
  store.upsertWorkspaceBinding({
    ...workspaceIdentity,
    target: { chatId: 7, threadId: 42 },
    threadName: "Cedar",
    slot: "C",
    updatedAtMs: 500,
  });
  const cleanupCalls: string[] = [];
  let syncState = {};
  const cleanup = createTelegramBusFollowerConfirmedDeadHandler({
    topicTargetStore: store,
    async callApi<TResponse>(method: string) {
      cleanupCalls.push(method);
      return { ok: true } as TResponse;
    },
    getCurrentLeaderEpoch: () => 1,
    getNowMs: () => 1000,
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    recordRuntimeEvent() {},
  });
  try {
    await cleanup({
      instanceId: "follower-dead",
      profileKey: "manual:worker",
      registrationGeneration: "dead:1",
      connectedAtMs: 500,
      lastHeartbeatMs: 900,
      target: { chatId: 7, threadId: 42 },
    });
    // Private-chat topics cannot be closed, so graceful cleanup deletes directly.
    assert.deepEqual(cleanupCalls, ["deleteForumTopic"]);
    assert.equal(store.getByProfileKey("manual:worker"), undefined);
    assert.deepEqual(store.listPendingCleanups(), []);
    assert.equal(store.listSyncObservations()[0]?.syncStatus, "deleted");
    assert.deepEqual(store.getWorkspaceBinding("/repo/workspace"), {
      ...workspaceIdentity,
      target: { chatId: 7, threadId: 42 },
      threadName: "Cedar",
      slot: "C",
      inactiveSinceMs: 1000,
      updatedAtMs: 500,
    });

    const reopenCalls: string[] = [];
    const probeEvents: unknown[] = [];
    let probeErrorExpected: boolean | undefined;
    const provision = createTelegramBusFollowerTargetProvisioner({
      getAllowedUserId: () => 7,
      topicTargetStore: store,
      async callApi<TResponse>(method: string, body: Record<string, unknown>, options?: TelegramApiCallOptions) {
        reopenCalls.push(`${method}:${body.message_thread_id ?? "new"}`);
        if (method === "sendMessage" && body.message_thread_id === 42) {
          assert.match(String(body.text), /Cedar/);
          const error = new TelegramApiStaleTargetError(
            "Telegram API sendMessage failed: message thread not found",
            { chatId: 7, threadId: 42 },
          );
          // The probe owns this expected answer, so the generic API log must stay quiet.
          probeErrorExpected = options?.isExpectedError?.(error);
          throw error;
        }
        if (method === "createForumTopic") {
          return { message_thread_id: 43 } as TResponse;
        }
        return { ok: true } as TResponse;
      },
      getNowMs: () => 1100,
      getSyncState: () => syncState,
      setSyncState: (state) => {
        syncState = state;
      },
      recordRuntimeEvent(_category, _error, details) {
        probeEvents.push(details);
      },
    });
    assert.deepEqual(
      await provision({
        instanceId: "follower-new",
        cwd: "/repo/workspace",
        threadName: registrationThreadName,
        connectedAtMs: 1100,
      }),
      { chatId: 7, threadId: 43, slot: "C", threadName: "Cedar" },
    );
    assert.equal(probeErrorExpected, true);
    assert.ok(probeEvents.some((details) =>
      (details as { phase?: string; staleThreadId?: number; threadId?: number } | undefined)?.phase ===
        "topic-lifecycle-restore-probe-recreated" &&
      (details as { staleThreadId?: number }).staleThreadId === 42 &&
      (details as { threadId?: number }).threadId === 43));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(reopenCalls, [
      "sendMessage:42",
      "createForumTopic:new",
      "sendMessage:43",
    ]);
    assert.equal(
      store.getWorkspaceBinding("/repo/workspace")?.target.threadId,
      43,
    );
    assert.equal(
      store.getWorkspaceBinding("/repo/workspace")?.inactiveSinceMs,
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

}

test("Successor leader replays durable cleanup intent before provisioning its own thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-successor-cleanup-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 2000,
  });
  store.upsert({
    profileKey: "leader:old",
    owner: { kind: "leader", instanceId: "leader-old" },
    target: { chatId: 7, threadId: 42 },
    status: "active",
    createdAtMs: 500,
    updatedAtMs: 500,
    instanceId: "leader-old",
    slot: "A",
    threadName: "Atlas",
  });
  store.upsertPendingCleanup({
    id: "cleanup:leader-old:runtime-old:7:42",
    owner: "leader",
    instanceId: "leader-old",
    runtimeGeneration: "runtime-old",
    target: { chatId: 7, threadId: 42 },
    requestedAtMs: 1000,
  });
  await store.persist();
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let syncState = {};
  const provision = createTelegramBusLeaderTargetProvisioner({
    getAllowedUserId: () => 7,
    instanceId: "leader-new",
    getCwd: () => "/repo/new",
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      if (method === "createForumTopic") {
        return { message_thread_id: 43 } as TResponse;
      }
      return { ok: true } as TResponse;
    },
    getCurrentLeaderEpoch: () => 2,
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    setLeaderTarget: () => undefined,
    recordRuntimeEvent: () => undefined,
  });
  try {
    await provision({ cwd: "/repo/new" });
    assert.deepEqual(
      calls.slice(0, 2).map((call) => call.method),
      ["deleteForumTopic", "createForumTopic"],
    );
    assert.deepEqual(store.listPendingCleanups(), []);
    assert.equal(store.getByProfileKey("leader:old"), undefined);
    assert.equal(store.getActiveByInstanceId("leader-new")?.target.threadId, 43);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Successor leader reuses its stable thread before cancelling superseded cleanup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-successor-reuse-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 2000,
  });
  store.upsert({
    profileKey: "cwd:/repo",
    owner: { kind: "leader", cwd: "/repo", instanceId: "leader-old" },
    target: { chatId: 7, threadId: 42 },
    status: "active",
    createdAtMs: 500,
    updatedAtMs: 500,
    instanceId: "leader-old",
    slot: "A",
    threadName: "Atlas",
  });
  store.upsertPendingCleanup({
    id: "cleanup:leader-old:runtime-old:7:42",
    owner: "leader",
    instanceId: "leader-old",
    runtimeGeneration: "runtime-old",
    profileKey: "cwd:/repo",
    target: { chatId: 7, threadId: 42 },
    requestedAtMs: 1000,
  });
  await store.persist();
  let leaderTarget: { target: { chatId: number; threadId?: number } } | undefined;
  const provision = createTelegramBusLeaderTargetProvisioner({
    getAllowedUserId: () => 7,
    instanceId: "leader-new",
    getCwd: () => "/repo",
    topicTargetStore: store,
    async callApi(method: string) {
      throw new Error(`Unexpected Telegram API call: ${method}`);
    },
    getCurrentLeaderEpoch: () => 2,
    getSyncState: () => ({}),
    setSyncState: () => undefined,
    setLeaderTarget: (target) => {
      leaderTarget = target;
    },
    recordRuntimeEvent: () => undefined,
  });
  try {
    await provision({ cwd: "/repo" });
    assert.deepEqual(leaderTarget?.target, { chatId: 7, threadId: 42 });
    assert.deepEqual(store.listPendingCleanups(), []);
    assert.equal(store.getByProfileKey("cwd:/repo")?.instanceId, "leader-new");
    assert.equal(
      store.getByProfileKey("cwd:/repo")?.lastReconcileAction,
      "leader-startup-skip-probe",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader follower target provisioner creates thread and announces connection", async () => {
  const dir = mkdtempSync(
    join(tmpdir(), "pi-telegram-bus-follower-provision-"),
  );
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let syncState = {};
  let provisioning = 0;
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      if (method === "createForumTopic") {
        return { message_thread_id: 12 } as TResponse;
      }
      return { ok: true } as TResponse;
    },
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    onProvisioningStart: () => {
      provisioning += 1;
    },
    onProvisioningEnd: () => {
      provisioning -= 1;
    },
    recordRuntimeEvent() {},
    getNowMs: () => 2000,
  });
  try {
    assert.deepEqual(
      await provision({ instanceId: "follower-a", cwd: "/repo",
        sessionId: "session-a", connectedAtMs: 0 }),
      { chatId: 7, threadId: 12, slot: "A", threadName: "Atlas" },
    );
    assert.equal(provisioning, 0);
    assert.deepEqual(calls, [
      { method: "createForumTopic", body: { chat_id: 7, name: "Atlas" } },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, [
      { method: "createForumTopic", body: { chat_id: 7, name: "Atlas" } },
      {
        method: "sendMessage",
        body: {
          chat_id: 7,
          message_thread_id: 12,
          text: "<b>📡 Instance <i>Atlas</i> connected.</b>",
          parse_mode: "HTML",
        },
      },
    ]);
    assert.deepEqual(syncState, {
      "target-bindings": {
        status: "fresh",
        updatedAtMs: 2000,
        lastReconcileAction: "follower-register",
      },
    });
    assert.equal(
      store.getWorkspaceBinding("/repo", "a", "session-a")?.target.threadId,
      12,
    );
    assert.deepEqual(store.getWorkspaceBinding("/repo", "a", "session-a")?.journalSources,
      [{ sessionId: "session-a", recipientBindingKey: "manual:follower-a" }]);
    assert.deepEqual(store.getWorkspaceBinding("/repo", "a", "session-a")?.journalBindingKeys, [],
      "Fresh session registration records its session journal, not a fictional flat recipient source");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader reconciles a stale follower record slot to its Workspace claim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-slot-reconcile-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  store.upsertWorkspaceBinding({
    ...createTelegramWorkspaceBindingIdentity("/old", 0, "session-old")!,
    target: { chatId: 7, threadId: 11 },
    slot: "P",
    updatedAtMs: 100,
  });
  store.upsertWorkspaceBinding({
    ...createTelegramWorkspaceBindingIdentity("/repo", 0, "session-a")!,
    target: { chatId: 7, threadId: 12 },
    slot: "Q",
    updatedAtMs: 200,
  });
  store.upsert({
    profileKey: "manual:follower-a",
    owner: { kind: "manual-follower", instanceId: "follower-a" },
    target: { chatId: 7, threadId: 12 },
    status: "active",
    createdAtMs: 100,
    updatedAtMs: 200,
    instanceId: "follower-a",
    slot: "P",
    threadName: "Quartz",
  });
  const calls: string[] = [];
  const phases: string[] = [];
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string) {
      calls.push(method);
      return { ok: true } as TResponse;
    },
    getSyncState: () => ({}),
    setSyncState: () => undefined,
    recordRuntimeEvent(_category, _error, details) {
      if (typeof details?.phase === "string") phases.push(details.phase);
    },
    getNowMs: () => 1000,
  });
  const registration = {
    instanceId: "follower-a",
    profileKey: "manual:follower-a",
    cwd: "/repo",
    sessionId: "session-a",
    target: { chatId: 7, threadId: 12 },
    connectedAtMs: 1000,
  };
  try {
    assert.deepEqual(await provision(registration), {
      chatId: 7,
      threadId: 12,
      slot: "Q",
      threadName: "Quartz",
    });
    assert.equal(store.getByProfileKey("manual:follower-a")?.slot, "Q");
    assert.equal(
      store.getWorkspaceBinding("/repo", "a", "session-a")?.slot,
      "Q",
    );
    assert.equal(
      store.getWorkspaceBinding("/old", "a", "session-old")?.slot,
      "P",
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(phases, ["follower-register-slot-reconcile"]);

    assert.equal((await provision(registration))?.slot, "Q");
    assert.deepEqual(phases, ["follower-register-slot-reconcile"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const recordSlot of ["S", "T"] as const) {
for (const boundary of ["current", "binding-drift", "epoch-loss"] as const) {
for (const mode of ["manual", "cold-restore"] as const) {
  test(`Follower registration ACK uses the committed retained slot and preserves source history (${recordSlot}, ${boundary}, ${mode})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-telegram-committed-follower-slot-"));
    const path = join(dir, "state.json"), socketPath = join(dir, "bus.sock");
    const owner = createTelegramLockRuntime({ statePath: path, key: () => "default", instanceId: "leader",
      runtimeGeneration: 1, isProcessAlive: () => true });
    assert.equal(owner.acquire({ cwd: "/leader" }).ok, true);
    const consolidated = {
      captureAuthority() {
        const epoch = owner.getOwnedLeaderEpoch();
        return epoch === undefined ? undefined : () => owner.owns() && owner.getOwnedLeaderEpoch() === epoch;
      },
      publishIfOwned: owner.publishStateSectionIfOwned!,
    };
    const storage = createTelegramConsolidatedWorkspaceStorage({ getPath: () => path, getProfile: () => "default", ...consolidated });
    const store = createTelegramTopicTargetStore({ path, consolidated,
      getNowMs: () => 1000, canPersist: () => owner.owns() });
    await store.load();
    const sourcePath = join(dir, "retained-source.json"), botIdentity = createTelegramUpdateJournalBotIdentity({ botToken: "fixture-slot-history" });
    const source = createTelegramUpdateJournalStore({ path: sourcePath, profileName: "default", botIdentity });
    source.appendBatch([{ update_id: 41 }]);
    const sourceKey = createTelegramUpdateJournalBindingKey({ path: sourcePath, profileName: "default", botIdentity });
    const sourceBytes = readFileSync(sourcePath, "utf8");
    const target = { chatId: 7, threadId: 42 }, neighborTarget = { chatId: 7, threadId: 77 };
    store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/repo", mode === "cold-restore" ? 1 : 0, "session")!, target,
      slot: "S", threadName: "Signal", manualThreadName: "Home", displayTitle: "Home", updatedAtMs: 1,
      journalBindingKeys: [sourceKey], journalSources: [{ sessionId: "session", recipientBindingKey: "manual:old-source" }],
      journalBindingsComplete: true });
    store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/repo", 0, "other-session")!, target: neighborTarget,
      slot: "T", threadName: "Topaz", updatedAtMs: 1, journalBindingKeys: ["unrelated-source"], journalBindingsComplete: true });
    store.upsert({ profileKey: "manual:neighbor", owner: { kind: "manual-follower", instanceId: "neighbor" },
      instanceId: "neighbor-runtime", target: neighborTarget, slot: "T", threadName: "Topaz", status: "active", createdAtMs: 1, updatedAtMs: 1 });
    store.upsert({ profileKey: "manual:stable", owner: { kind: "manual-follower", instanceId: "stable" },
      instanceId: mode === "cold-restore" ? "424242:1000" : "old-runtime", target, slot: recordSlot, threadName: "Signal", status: "active", createdAtMs: 1, updatedAtMs: 1 });
    await store.persist();
    const neighborBinding = store.getWorkspaceBindingByTarget(neighborTarget, "other-session");
    const neighborRecord = store.getByProfileKey("manual:neighbor");
    const registry = createTelegramBusFollowerRegistry();
    const admission = createTelegramWorkspaceAdmissionLedger({ path: join(dir, "admission.json"), profileKey: "default",
      owner: { processId: process.pid, processBirthId: `${process.pid}:committed-slot` }, getProcessLiveness: () => "alive" });
    const commitRegistration = store.commitWorkspaceRestoreRegistration;
    store.commitWorkspaceRestoreRegistration = (candidate, publish) => {
      assert.ok(admission.read().leases.some(lease => lease.operationKind === "workspace.publish-follower-registration"));
      if (boundary === "binding-drift") storage.capturePublication()!(current => {
        const changed = structuredClone(current) as { workspaceBindings: Array<{ target: typeof target; slot: string }> };
        changed.workspaceBindings.find(binding => binding.target.threadId === target.threadId)!.slot = "Z";
        return { value: changed, result: true };
      });
      if (boundary === "epoch-loss") owner.release();
      commitRegistration(candidate, publish);
    };
    let allowedUserId: number | undefined;
    const calls: string[] = [], notices: string[] = [], events: Array<{ message: string; phase?: string }> = [];
    const runtime = createTelegramBusLeaderRuntimeAssembly({
      runtime: { socketPath, followerRegistry: registry, authSecret: "fixture", protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY,
        startPolling() {}, stopPolling() {}, isFollowerProcessAlive: pid => mode !== "cold-restore" || pid !== 424242 },
      instanceId: "leader", getTelegramProfile: () => undefined, getAllowedUserId: () => allowedUserId,
      getCurrentLeaderEpoch: owner.getOwnedLeaderEpoch, topicTargetStore: store, getWorkspaceAdmission: () => admission,
      async callApi<TResponse>(method: string, body: Record<string, unknown>) {
        calls.push(method);
        if (method === "sendMessage") notices.push(String(body.text));
        assert.ok(["sendMessage", "sendChatAction", "editForumTopic"].includes(method), `Reusing a retained target cannot create or delete a tab (${method})`);
        return true as TResponse;
      },
      callMultipart: async () => true, downloadFile: async () => undefined,
      getSyncState: () => ({}), setSyncState() {}, setLeaderTarget() {},
      recordRuntimeEvent(_category, message, details) { events.push({ message: String(message), phase: details?.phase as string | undefined }); },
    });
    try {
      await runtime.startPolling("ctx"); allowedUserId = 7;
      assert.equal(store.getByProfileKey("manual:stable")?.instanceId, mode === "cold-restore" ? "424242:1000" : "old-runtime", "Startup must retain the source owner record");
      const response = await sendTelegramBusLocalEnvelope({ socketPath, timeoutMs: 2000, envelope: {
        kind: mode === "cold-restore" ? "follower.restoreWorkspace" : "follower.register", requestId: "register-new", auth: "fixture", registration: {
          instanceId: "new-runtime", profileKey: "manual:stable", cwd: "/repo", sessionId: "session", target,
          registrationGeneration: "new-runtime:1", protocol: TEST_BUS_PROTOCOL_IDENTITY, connectedAtMs: 1000,
        },
      } });
      assert.equal(response?.kind, "bus.ack");
      if (!response || response.kind !== "bus.ack") assert.fail("Missing registration ACK");
      if (boundary === "current") {
        assert.equal(response.ok, true, `${response.message}; ${events.map(event => event.message).join("; ")}`);
        assert.deepEqual(notices, ["<b>📡 Instance <i>Home</i> connected.</b>"]);
        assert.equal(response.requestId, "register-new");
        const acknowledged = response.result as { chatId: number; threadId: number; slot: string };
        assert.equal(acknowledged.slot, "S"); assert.equal(acknowledged.chatId, target.chatId);
        assert.equal(acknowledged.threadId, target.threadId);
        const registered = registry.get("new-runtime")!; assert.ok(registered);
        assert.equal(registered.slot, "S"); assert.equal(registered.target?.chatId, target.chatId);
        assert.equal(registered.target?.threadId, target.threadId);
        assert.equal(registered.profileKey, "manual:stable"); assert.equal(registered.sessionId, "session");
        assert.equal(registered.cwd, "/repo"); assert.equal(registered.registrationGeneration, "new-runtime:1");
        assert.equal(events.filter(event => event.phase === "follower-register-slot-reconcile").length,
          mode === "cold-restore" && recordSlot === "S" ? 0 : 1,
          "Cold restore adopts the retained claim; a mismatched owner record still requires exact reconciliation");
      } else {
        assert.equal(response.ok, false); assert.equal(registry.get("new-runtime"), undefined);
        if (boundary === "binding-drift") assert.match(response.message ?? "", /binding changed before publication/);
      }
      const canonical = createTelegramTopicTargetStore({ path, consolidated, canPersist: () => false });
      await canonical.load();
      const binding = canonical.getWorkspaceBindingByTarget(target, "session")!; assert.ok(binding);
      assert.equal(binding.instanceSlot, "b");
      assert.equal(binding.cwd, "/repo"); assert.equal(binding.sessionId, "session");
      assert.deepEqual(binding.target, target); assert.equal(binding.slot, boundary === "binding-drift" ? "Z" : "S");
      assert.equal(canonical.getByProfileKey("manual:stable")?.slot, "S");
      assert.equal(canonical.getByProfileKey("manual:stable")?.instanceId, "new-runtime");
      assert.equal(binding.manualThreadName, "Home");
      assert.deepEqual(binding.journalBindingKeys, [sourceKey], "Rekeying the same target cannot erase retained legacy journal references");
      assert.deepEqual(binding.journalSources, [{ sessionId: "session", recipientBindingKey: "manual:old-source" },
        { sessionId: "session", recipientBindingKey: "manual:stable" }]);
      assert.equal(binding.journalBindingsComplete, true);
      assert.deepEqual(canonical.getWorkspaceBindingByTarget(neighborTarget, "other-session"), neighborBinding);
      assert.deepEqual(canonical.getByProfileKey("manual:neighbor"), neighborRecord);
      assert.equal(readFileSync(sourcePath, "utf8"), sourceBytes, "Registration cannot execute or settle retained input");
      assert.deepEqual(source.read().entries.map(entry => entry.updateId), [41]);
      assert.deepEqual(admission.read().leases, []);
    } finally {
      await runtime.stopPolling(); owner.release(); rmSync(dir, { recursive: true, force: true });
    }
  });
}
}
}

test("Bus leader replaces only the stale session-qualified follower target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-session-target-replace-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  store.upsertWorkspaceBinding({
    ...createTelegramWorkspaceBindingIdentity("/repo", 0, "session-a")!,
    target: { chatId: 7, threadId: 12 },
    slot: "A", threadName: "Atlas", updatedAtMs: 500,
  });
  store.upsertWorkspaceBinding({
    ...createTelegramWorkspaceBindingIdentity("/repo", 1, "session-b")!,
    target: { chatId: 7, threadId: 20 },
    slot: "B", threadName: "Beacon", updatedAtMs: 500,
  });
  await store.persist();
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      if (method === "sendMessage" && body.message_thread_id === 12) {
        throw new Error("Bad Request: TOPIC_ID_INVALID");
      }
      if (method === "createForumTopic") {
        return { message_thread_id: 13 } as TResponse;
      }
      return { ok: true } as TResponse;
    },
    getSyncState: () => ({}),
    setSyncState: () => undefined,
    recordRuntimeEvent() {},
    getNowMs: () => 1000,
  });
  try {
    assert.deepEqual(await provision({
      instanceId: "follower-a", cwd: "/repo", sessionId: "session-a",
      target: { chatId: 7, threadId: 12 }, connectedAtMs: 1000,
    }), { chatId: 7, threadId: 13, slot: "A", threadName: "Atlas" });
    assert.equal(
      store.getWorkspaceBinding("/repo", "a", "session-a")?.target.threadId,
      13,
    );
    assert.equal(
      store.getWorkspaceBinding("/repo", "b", "session-b")?.target.threadId,
      20,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader follower target provisioner transfers a live session-reload target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-reload-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  const calls: unknown[] = [];
  let syncState = {};
  store.upsert({
    profileKey: "manual:owner-a",
    owner: { kind: "manual-follower", instanceId: "owner-a" },
    target: { chatId: 7, threadId: 12 },
    status: "active",
    createdAtMs: 500,
    updatedAtMs: 500,
    instanceId: "follower-a",
    slot: "E",
    threadName: "Ember",
  });
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { ok: true } as TResponse;
    },
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    recordRuntimeEvent() {},
  });
  try {
    assert.deepEqual(
      await provision({
        instanceId: "follower-reloaded",
        profileKey: "manual:owner-a",
        target: { chatId: 7, threadId: 12 },
        connectedAtMs: 1000,
      }),
      { chatId: 7, threadId: 12, slot: "E", threadName: "Ember" },
    );
    assert.deepEqual(calls, [
      {
        method: "sendMessage",
        body: {
          chat_id: 7,
          message_thread_id: 12,
          text: "<b>📡 Instance <i>Ember</i> connected.</b>",
          parse_mode: "HTML",
        },
      },
    ]);
    assert.equal(store.list()[0]?.instanceId, "follower-reloaded");
    assert.equal(
      store.list()[0]?.lastReconcileAction,
      "follower-session-handoff",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const sameProcess of [true, false]) test(`Bus leader keeps the acknowledged Thread title across a follower session handoff (same process=${sameProcess})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-new-session-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  const target = { chatId: 7, threadId: 42 };
  store.upsert({
    profileKey: "manual:100:start:1",
    owner: { kind: "manual-follower", instanceId: "100:start:1" },
    target,
    status: "active",
    createdAtMs: 500,
    updatedAtMs: 500,
    instanceId: "100:1000",
    slot: "Y",
    threadName: "Yale",
  });
  store.upsertWorkspaceBinding({
    ...createTelegramWorkspaceBindingIdentity("/repo", 0, "session-a")!,
    target,
    slot: "Y",
    threadName: "Yale",
    displayTitle: "Repo",
    updatedAtMs: 500,
  });
  await store.persist();
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let syncState = {};
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      if (method === "createForumTopic") {
        throw new Error("session handoff must not create a Thread");
      }
      return { ok: true } as TResponse;
    },
    getNowMs: () => 1000,
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    recordRuntimeEvent() {},
  });
  try {
    const instanceId = sameProcess ? "100:2000" : "200:2000";
    const assigned = await provision({
      instanceId,
      previousInstanceId: "100:1000",
      profileKey: "manual:100:start:1",
      cwd: "/repo",
      sessionId: "session-b",
      target,
      connectedAtMs: 2000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(assigned?.threadId, 42);
    assert.equal(assigned?.slot, "Y");
    assert.deepEqual(
      calls,
      sameProcess
        ? []
        : [
            {
              method: "sendMessage",
              body: {
                chat_id: 7,
                message_thread_id: 42,
                text: "<b>📡 Instance <i>Repo</i> connected.</b>",
                parse_mode: "HTML",
              },
            },
          ],
    );
    const binding = store.getWorkspaceBindingByTarget(target);
    assert.equal(binding?.sessionId, "session-b");
    assert.equal(binding?.slot, "Y");
    assert.equal(binding?.displayTitle, "Repo");
    assert.equal(store.getWorkspaceBindingByTarget(target, "session-a"), undefined);
    assert.equal(store.list()[0]?.instanceId, instanceId);
    assert.equal(store.list()[0]?.slot, "Y");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const exactHandoff of [false, true]) test(`Bus leader replaces a deleted follower target even when typing would succeed (exact handoff=${exactHandoff})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-stale-tab-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let syncState = {};
  store.upsert({
    profileKey: "manual:owner-a",
    owner: { kind: "manual-follower", instanceId: "owner-a" },
    target: { chatId: 7, threadId: 12 },
    status: "active",
    createdAtMs: 500,
    updatedAtMs: 500,
    instanceId: "follower-a",
    slot: "E",
    threadName: "Ember",
  });
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      if (method === "sendMessage" && body.message_thread_id === 12) {
        throw new Error("Bad Request: TOPIC_ID_INVALID");
      }
      if (method === "createForumTopic") {
        return { message_thread_id: 13 } as TResponse;
      }
      return { ok: true } as TResponse;
    },
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    recordRuntimeEvent() {},
    getNowMs: () => 1000,
  });
  try {
    assert.deepEqual(
      await provision({
        instanceId: "follower-reloaded",
        ...(exactHandoff ? { previousInstanceId: "follower-a" } : {}),
        profileKey: "manual:owner-a",
        target: { chatId: 7, threadId: 12 },
        connectedAtMs: 1000,
      }),
      { chatId: 7, threadId: 13, slot: "F", threadName: "Ember" },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      calls.map((call) => call.method),
      ["sendMessage", "createForumTopic", "sendMessage"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader rejects cross-session registration when visibility remains ambiguous", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-ambiguous-tab-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  store.upsert({
    profileKey: "manual:owner-a",
    owner: { kind: "manual-follower", instanceId: "owner-a" },
    target: { chatId: 7, threadId: 12 },
    status: "active",
    createdAtMs: 500,
    updatedAtMs: 500,
    instanceId: "follower-a",
    slot: "E",
    threadName: "Ember",
  });
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      if (calls.length === 1) {
        throw new Error("Telegram send acknowledgement was lost");
      }
      return { ok: true } as TResponse;
    },
    getSyncState: () => ({}),
    setSyncState: () => undefined,
    recordRuntimeEvent() {},
    getNowMs: () => 1000,
  });
  try {
    await assert.rejects(
      provision({
        instanceId: "follower-reloaded",
        profileKey: "manual:owner-a",
        target: { chatId: 7, threadId: 12 },
        connectedAtMs: 1000,
      }),
      /acknowledgement was lost/,
    );
    assert.deepEqual(calls.map((call) => call.method), ["sendMessage"]);
    const preserved = store.getByProfileKey("manual:owner-a");
    assert.equal(preserved?.status, "active");
    assert.equal(preserved?.instanceId, "follower-a");

    assert.deepEqual(
      await provision({
        instanceId: "follower-reloaded",
        profileKey: "manual:owner-a",
        connectedAtMs: 1100,
      }),
      { chatId: 7, threadId: 12, slot: "E", threadName: "Ember" },
    );
    assert.deepEqual(calls.map((call) => call.method), [
      "sendMessage",
      "sendMessage",
    ]);
    assert.equal(
      store.getByProfileKey("manual:owner-a")?.instanceId,
      "follower-reloaded",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Reloaded bus leader reuses a surviving follower's persisted target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-leader-reload-follower-"));
  const path = join(dir, "state.json");
  const previousStore = createTelegramTopicTargetStore({ path });
  previousStore.upsert({
    profileKey: "manual:owner-a",
    owner: { kind: "manual-follower", instanceId: "owner-a" },
    target: { chatId: 7, threadId: 12 },
    status: "active",
    createdAtMs: 500,
    updatedAtMs: 500,
    instanceId: "follower-a",
    slot: "E",
    threadName: "Ember",
  });
  await previousStore.persist();
  const reloadedStore = createTelegramTopicTargetStore({ path });
  const calls: unknown[] = [];
  let syncState = {};
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: reloadedStore,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { ok: true } as TResponse;
    },
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    recordRuntimeEvent() {},
  });
  try {
    assert.deepEqual(
      await provision({
        instanceId: "follower-a",
        profileKey: "manual:owner-a",
        target: { chatId: 7, threadId: 12 },
        connectedAtMs: 1000,
      }),
      { chatId: 7, threadId: 12, slot: "E", threadName: "Ember" },
    );
    assert.deepEqual(calls, []);
    assert.equal(reloadedStore.list().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader recovers a live follower target missing from persisted state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-live-target-recovery-"));
  const path = join(dir, "state.json");
  const store = createTelegramTopicTargetStore({
    path,
    getNowMs: () => 2000,
  });
  store.upsert({
    profileKey: "cwd:/leader",
    owner: { kind: "leader", cwd: "/leader" },
    target: { chatId: 7, threadId: 11 },
    status: "active",
    createdAtMs: 1000,
    updatedAtMs: 1000,
    instanceId: "leader-a",
    slot: "E",
    threadName: "Atlas",
  });
  store.setStatusSnapshot({
    liveRoster: {
      busFollowers: [
        {
          instanceId: "follower-e",
          target: {
            chatId: 7,
            threadId: 12,
            slot: "E",
            threadName: "Eagle",
          },
        },
      ],
    },
  });
  await store.persist();
  await store.persistStatus();
  const reloadedStore = createTelegramTopicTargetStore({
    path,
    getNowMs: () => 2000,
  });
  const calls: unknown[] = [];
  let syncState = {};
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: reloadedStore,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { ok: true } as TResponse;
    },
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    recordRuntimeEvent() {},
    getNowMs: () => 2000,
  });
  try {
    assert.deepEqual(
      await provision({
        instanceId: "follower-e",
        profileKey: "manual:owner-e",
        target: { chatId: 7, threadId: 12 },
        threadName: "extensions",
        connectedAtMs: 1500,
      }),
      { chatId: 7, threadId: 12, slot: "F", threadName: "Eagle" },
    );
    assert.deepEqual(
      calls.map((call) =>
        (call as { method: string; body: Record<string, unknown> }).method,
      ),
      ["sendMessage"],
    );
    const recovered = reloadedStore.getByProfileKey("manual:owner-e");
    assert.deepEqual(recovered?.target, { chatId: 7, threadId: 12 });
    assert.equal(recovered?.instanceId, "follower-e");
    assert.equal(recovered?.threadName, "Eagle");
    assert.equal(recovered?.slot, "F");
    assert.equal(recovered?.lastReconcileAction, "follower-live-target-recovery");
    assert.equal(reloadedStore.getBotState().lastSlot, "F");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader reprobes an unresolved absent carried target on targetless retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-carried-probe-retry-"));
  const path = join(dir, "state.json");
  const store = createTelegramTopicTargetStore({
    path,
    getNowMs: () => 2000,
  });
  let attempts = 0;
  const callApi = async <TResponse>() => {
    attempts += 1;
    if (attempts === 1) throw new Error("acknowledgement lost");
    return { ok: true } as TResponse;
  };
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    callApi,
    getSyncState: () => ({}),
    setSyncState: () => undefined,
    recordRuntimeEvent() {},
    getNowMs: () => 2000,
  });
  try {
    await assert.rejects(
      provision({
        instanceId: "follower-recovered",
        profileKey: "manual:owner-a",
        target: { chatId: 7, threadId: 12 },
        connectedAtMs: 2000,
      }),
      /acknowledgement lost/,
    );
    assert.equal(store.list()[0]?.status, "probe-required");

    const reloadedStore = createTelegramTopicTargetStore({
      path,
      getNowMs: () => 2100,
    });
    const retryProvision = createTelegramBusFollowerTargetProvisioner({
      getAllowedUserId: () => 7,
      topicTargetStore: reloadedStore,
      callApi,
      getSyncState: () => ({}),
      setSyncState: () => undefined,
      recordRuntimeEvent() {},
      getNowMs: () => 2100,
    });
    assert.deepEqual(
      await retryProvision({
        instanceId: "follower-recovered",
        profileKey: "manual:owner-a",
        connectedAtMs: 2100,
      }),
      {
        chatId: 7,
        threadId: 12,
        slot: "A",
        threadName: undefined,
      },
    );
    assert.equal(attempts, 2);
    assert.equal(reloadedStore.list()[0]?.status, "active");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader keeps an absent carried target provisional until visibility succeeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-carried-probe-pending-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 2000,
  });
  let resolveProbe: (() => void) | undefined;
  let probeStarted = false;
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>() {
      probeStarted = true;
      await new Promise<void>((resolve) => {
        resolveProbe = resolve;
      });
      return { ok: true } as TResponse;
    },
    getSyncState: () => ({}),
    setSyncState: () => undefined,
    recordRuntimeEvent() {},
    getNowMs: () => 2000,
  });
  try {
    const pending = provision({
      instanceId: "follower-recovered",
      profileKey: "manual:owner-a",
      target: { chatId: 7, threadId: 12 },
      connectedAtMs: 2000,
    });
    await waitForCondition(() => probeStarted);
    assert.equal(store.list().length, 0);
    resolveProbe?.();
    assert.deepEqual(await pending, {
      chatId: 7,
      threadId: 12,
      slot: "A",
      threadName: undefined,
    });
    assert.equal(store.list()[0]?.status, "active");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader replaces a carried target proven deleted after disconnect acknowledgement loss", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-disconnect-ack-loss-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 2000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      if (method === "sendMessage" && body.message_thread_id === 12) {
        throw new Error("Bad Request: TOPIC_ID_INVALID");
      }
      if (method === "createForumTopic") {
        return { message_thread_id: 13 } as TResponse;
      }
      return { ok: true } as TResponse;
    },
    getSyncState: () => ({}),
    setSyncState: () => undefined,
    recordRuntimeEvent() {},
    getNowMs: () => 2000,
  });
  try {
    assert.deepEqual(
      await provision({
        instanceId: "follower-recovered",
        profileKey: "manual:owner-a",
        target: { chatId: 7, threadId: 12 },
        connectedAtMs: 2000,
      }),
      { chatId: 7, threadId: 13, slot: "A", threadName: "Atlas" },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      calls.map((call) => call.method),
      ["sendMessage", "createForumTopic", "sendMessage"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader follower target provisioner restores an existing manual follower thread", async () => {
  const dir = mkdtempSync(
    join(tmpdir(), "pi-telegram-bus-follower-stale-provision-"),
  );
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  store.upsert({
    profileKey: "manual:follower-a",
    owner: { kind: "manual-follower", instanceId: "follower-a" },
    target: { chatId: 7, threadId: 8 },
    status: "active",
    createdAtMs: 1000,
    updatedAtMs: 1000,
    instanceId: "follower-a",
    slot: "A",
    threadName: "Amber",
  });
  await store.persist();
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const events: Array<{ category: string; details?: Record<string, unknown> }> =
    [];
  let syncState = {};
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      if (method === "createForumTopic") {
        return { message_thread_id: 13 } as TResponse;
      }
      return { ok: true } as TResponse;
    },
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    recordRuntimeEvent(category, _error, details) {
      events.push({ category, details });
    },
    getNowMs: () => 2000,
  });
  try {
    assert.deepEqual(
      await provision({ instanceId: "follower-a", connectedAtMs: 0 }),
      { chatId: 7, threadId: 8, slot: "A", threadName: "Amber" },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, []);
    assert.deepEqual(store.getByProfileKey("manual:follower-a")?.target, {
      chatId: 7,
      threadId: 8,
    });
    assert.equal(events.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader follower target provisioner coalesces concurrent follower registrations", async () => {
  const dir = mkdtempSync(
    join(tmpdir(), "pi-telegram-bus-follower-concurrent-provision-"),
  );
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let createTopicResolve:
    ((value: { message_thread_id: number }) => void) | undefined;
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      if (method === "createForumTopic") {
        return (await new Promise<{ message_thread_id: number }>((resolve) => {
          createTopicResolve = resolve;
        })) as TResponse;
      }
      return { ok: true } as TResponse;
    },
    getSyncState: () => ({}),
    setSyncState: () => undefined,
    recordRuntimeEvent() {},
    getNowMs: () => 2000,
  });
  try {
    const first = provision({ instanceId: "follower-a", connectedAtMs: 0 });
    const second = provision({ instanceId: "follower-a", connectedAtMs: 1 });
    await waitForCondition(() => createTopicResolve !== undefined);
    assert.equal(
      calls.filter((call) => call.method === "createForumTopic").length,
      1,
    );
    createTopicResolve?.({ message_thread_id: 13 });
    assert.deepEqual(await first, {
      chatId: 7,
      threadId: 13,
      slot: "A",
      threadName: "Atlas",
    });
    assert.deepEqual(await second, {
      chatId: 7,
      threadId: 13,
      slot: "A",
      threadName: "Atlas",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader visibility-probes and reclaims a dormant Workspace Thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-leader-workspace-"));
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  const workspaceIdentity = createTelegramWorkspaceBindingIdentity(
    "/repo/workspace", 0, "session-a",
  );
  assert.ok(workspaceIdentity);
  store.upsertWorkspaceBinding({
    ...workspaceIdentity,
    target: { chatId: 7, threadId: 42 },
    threadName: "Cedar",
    slot: "C",
    updatedAtMs: 1000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let leaderTarget: unknown;
  const provision = createTelegramBusLeaderTargetProvisioner({
    getAllowedUserId: () => 7,
    instanceId: "leader-new",
    getCwd: (ctx: { cwd: string }) => ctx.cwd,
    getSessionId: () => "session-a",
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      if (method === "createForumTopic") {
        throw new Error("created a duplicate Thread");
      }
      return { ok: true } as TResponse;
    },
    getSyncState: () => ({}),
    setSyncState() {},
    setLeaderTarget: (input) => {
      leaderTarget = input;
    },
    recordRuntimeEvent() {},
    getNowMs: () => 2000,
  });
  try {
    await provision({ cwd: "/repo/workspace/" });
    assert.deepEqual(leaderTarget, {
      target: { chatId: 7, threadId: 42 },
      slot: "C",
      threadName: "Cedar",
    });
    assert.deepEqual(calls, [
      {
        method: "sendMessage",
        body: {
          chat_id: 7,
          message_thread_id: 42,
          text: "<b>📡 Instance <i>Cedar</i> connected.</b>",
          parse_mode: "HTML",
        },
      },
    ]);
    assert.equal(
      store.getByProfileKey("cwd:/repo/workspace")?.instanceId,
      "leader-new",
    );
    assert.equal(store.getWorkspaceBinding("/repo/workspace"), undefined);
    assert.equal(
      store.getWorkspaceBinding("/repo/workspace", "a", "session-a")?.target.threadId,
      42,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader keeps the Workspace Thread across follower promotion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-leader-workspace-promotion-"));
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  const workspaceIdentity = createTelegramWorkspaceBindingIdentity("/repo");
  assert.ok(workspaceIdentity);
  store.upsert({
    profileKey: "manual:shared",
    owner: { kind: "manual-follower", instanceId: "shared" },
    target: { chatId: 7, threadId: 42 },
    status: "active",
    createdAtMs: 900,
    updatedAtMs: 1000,
    threadName: "Cedar",
    instanceId: "shared",
    slot: "C",
  });
  store.upsertWorkspaceBinding({
    ...workspaceIdentity,
    target: { chatId: 7, threadId: 42 },
    threadName: "Cedar",
    slot: "C",
    inactiveSinceMs: 500,
    updatedAtMs: 1000,
  });
  let leaderTarget: unknown;
  const provision = createTelegramBusLeaderTargetProvisioner({
    getAllowedUserId: () => 7,
    instanceId: "shared",
    getCwd: (ctx: { cwd: string }) => ctx.cwd,
    topicTargetStore: store,
    async callApi() {
      throw new Error("promotion must not mutate Telegram");
    },
    getSyncState: () => ({}),
    setSyncState() {},
    setLeaderTarget: (input) => {
      leaderTarget = input;
    },
    recordRuntimeEvent() {},
    getNowMs: () => 2000,
  });
  try {
    await provision({ cwd: "/repo" });
    assert.deepEqual(leaderTarget, {
      target: { chatId: 7, threadId: 42 },
      slot: "C",
      threadName: "Cedar",
    });
    const promoted = store.getByProfileKey("cwd:/repo");
    assert.equal(promoted?.owner?.kind, "leader");
    assert.equal(promoted?.instanceId, "shared");
    assert.equal(store.getWorkspaceBinding("/repo")?.target.threadId, 42);
    assert.equal(store.getWorkspaceBinding("/repo")?.inactiveSinceMs, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Former leader reopens restore-only after follower promotion without changing Workspace display identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-promotion-reopen-"));
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json"), getNowMs: () => 2000 });
  for (const [cwd, instanceId, ownerKind, slot, threadName, displayTitle, threadId] of [
    ["/alpha", "old-leader", "leader", "A", "Anchor", "A", 41],
    ["/beta", "new-leader", "manual-follower", "B", "Beacon", "B", 42],
  ] as const) {
    store.upsert({ profileKey: `${ownerKind}:${instanceId}`,
      owner: ownerKind === "leader" ? { kind: ownerKind, cwd, instanceId } : { kind: ownerKind, instanceId },
      instanceId, target: { chatId: 7, threadId }, slot, threadName,
      status: "active", createdAtMs: 1, updatedAtMs: 1 });
    store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity(cwd)!,
      target: { chatId: 7, threadId }, slot, threadName, displayTitle, updatedAtMs: 1 });
  }
  const calls: Array<{ method: string; threadId?: unknown }> = [];
  const callApi = async <TResponse>(method: string, body: Record<string, unknown>) => {
    calls.push({ method, threadId: body.message_thread_id });
    if (method === "createForumTopic") throw new Error("restore-only reopen must not create a Thread");
    return { ok: true } as TResponse;
  };
  try {
    await store.persist();
    store.markOfflineByInstanceId("old-leader");
    await store.persist();
    let promoted: unknown;
    const promote = createTelegramBusLeaderTargetProvisioner({
      getAllowedUserId: () => 7, instanceId: "new-leader", getCwd: (ctx: { cwd: string }) => ctx.cwd,
      topicTargetStore: store, callApi, getSyncState: () => ({}), setSyncState() {},
      setLeaderTarget(target) { promoted = target; }, recordRuntimeEvent() {}, getNowMs: () => 2000,
    });
    await promote({ cwd: "/beta" });
    assert.deepEqual(promoted, { target: { chatId: 7, threadId: 42 }, slot: "B", threadName: "Beacon" });
    const restore = createTelegramBusFollowerTargetProvisioner({
      getAllowedUserId: () => 7, topicTargetStore: store, callApi,
      getSyncState: () => ({}), setSyncState() {}, recordRuntimeEvent() {}, getNowMs: () => 3000,
    });
    const reopened = await restore({ instanceId: "old-reopened", profileKey: "manual:old-reopened",
      cwd: "/alpha", connectedAtMs: 3000 }, { existingWorkspaceBindingOnly: true });
    assert.deepEqual(reopened, { chatId: 7, threadId: 41, slot: "A", threadName: "Anchor" });
    assert.deepEqual(calls, [{ method: "sendMessage", threadId: 41 }]);
    assert.deepEqual(store.listWorkspaceBindings().map((binding) => ({
      cwd: binding.cwd, target: binding.target, slot: binding.slot,
      threadName: binding.threadName, displayTitle: binding.displayTitle,
    })), [
      { cwd: "/alpha", target: { chatId: 7, threadId: 41 }, slot: "A", threadName: "Anchor", displayTitle: "A" },
      { cwd: "/beta", target: { chatId: 7, threadId: 42 }, slot: "B", threadName: "Beacon", displayTitle: "B" },
    ]);
    assert.equal(store.list().find((record) => record.target.threadId === 42)?.owner?.kind, "leader");
    assert.equal(store.list().find((record) => record.target.threadId === 41)?.instanceId, "old-reopened");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader replaces a dormant Workspace Thread proven stale", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-leader-workspace-stale-"));
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  const workspaceIdentity = createTelegramWorkspaceBindingIdentity("/repo");
  assert.ok(workspaceIdentity);
  store.upsertWorkspaceBinding({
    ...workspaceIdentity,
    target: { chatId: 7, threadId: 41 },
    threadName: "Cedar",
    displayTitle: "previous-title",
    slot: "C",
    updatedAtMs: 1000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const provision = createTelegramBusLeaderTargetProvisioner({
    getAllowedUserId: () => 7,
    instanceId: "leader-new",
    getCwd: (ctx: { cwd: string }) => ctx.cwd,
    resolveInitialWorkspaceDisplayTitle: () => "repo",
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      if (method === "sendMessage" && body.message_thread_id === 41) {
        throw new TelegramApiStaleTargetError("topic deleted", {
          chatId: 7,
          threadId: 41,
        });
      }
      if (method === "createForumTopic") {
        return { message_thread_id: 42 } as TResponse;
      }
      return { ok: true } as TResponse;
    },
    getSyncState: () => ({}),
    setSyncState() {},
    setLeaderTarget() {},
    recordRuntimeEvent() {},
    getNowMs: () => 2000,
  });
  try {
    await provision({ cwd: "/repo" });
    assert.deepEqual(calls.map((call) => call.method), [
      "sendMessage",
      "createForumTopic",
      "sendMessage",
    ]);
    assert.equal(store.getWorkspaceBinding("/repo")?.target.threadId, 42);
    assert.equal(store.getWorkspaceBinding("/repo")?.displayTitle, "repo");
    assert.equal(store.getWorkspaceBinding("/repo")?.threadName, "Cedar");
    assert.equal(calls[1].body.name, "repo");
    assert.equal(calls[2].body.text, "<b>📡 Instance <i>repo</i> connected.</b>");
    assert.equal(store.list().some((record) => record.target.threadId === 41), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Display-mode follower creation and stale replacement acknowledge the initial title without redundant edits", async () => {
  const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "test",
    capabilities: [...TEST_BUS_PROTOCOL_IDENTITY.capabilities, TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE] });
  for (const mode of ["letters", "names", "directories"] as const) {
    for (const replacing of [false, true]) {
      const dir = mkdtempSync(join(tmpdir(), "pi-telegram-initial-follower-title-"));
      const socketPath = join(dir, "bus.sock");
      const path = join(dir, "state.json");
      const store = createTelegramTopicTargetStore({ path });
      if (replacing) store.upsertWorkspaceBinding({
        ...createTelegramWorkspaceBindingIdentity(
          "/repo/extensions", 0, "session-a")!,
        target: { chatId: 7, threadId: 41 }, slot: "A", threadName: "Anchor",
        displayTitle: "previous-title", showSlotSuffix: true, updatedAtMs: 1,
      });
      let allowedUserId: number | undefined;
      const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
      const errors: unknown[] = [];
      const runtime = createTelegramBusLeaderRuntimeAssembly({
        runtime: { socketPath, followerRegistry: createTelegramBusFollowerRegistry(),
          protocolIdentity: protocol, startPolling() {}, stopPolling() {} },
        getAllowedUserId: () => allowedUserId, instanceId: "leader", topicTargetStore: store,
        getCurrentLeaderEpoch: () => 1, getThreadDisplayMode: () => mode,
        async callApi<TResponse>(method: string, body: Record<string, unknown>) {
          calls.push({ method, body });
          if (method === "sendMessage" && body.message_thread_id === 41) {
            throw new TelegramApiStaleTargetError("topic deleted", { chatId: 7, threadId: 41 });
          }
          return (method === "createForumTopic" ? { message_thread_id: 42 } : true) as TResponse;
        },
        callMultipart: async () => true, downloadFile: async () => undefined,
        getSyncState: () => ({}), setSyncState() {}, setLeaderTarget() {},
        recordRuntimeEvent(_category, error) { if (error instanceof Error) errors.push(error); },
      });
      try {
        await store.persist();
        await runtime.startPolling("ctx");
        allowedUserId = 7;
        const response = await sendTelegramBusLocalEnvelope({ socketPath, envelope: {
          kind: "follower.register", requestId: "register:1",
          registration: { instanceId: "follower", registrationGeneration: "follower:1",
            cwd: "/repo/extensions", sessionId: "session-a",
            threadName: "Anchor", connectedAtMs: Date.now(), protocol },
        } });
        assert.equal(response?.kind, "bus.ack");
        if (response?.kind !== "bus.ack") throw new Error("missing ACK");
        assert.equal(response.ok, true, response.message);
        const expected = mode === "letters" ? "A" : mode === "names" ? "Anchor"
          : replacing ? "extensions_a" : "extensions";
        assert.equal((response.result as { displayTitle?: string }).displayTitle, expected);
        assert.equal((response.result as { threadName?: string }).threadName, "Anchor");
        assert.equal(calls.find((call) => call.method === "createForumTopic")?.body.name, expected);
        await waitForCondition(() => calls.some((call) =>
          call.method === "sendMessage" && call.body.message_thread_id === 42));
        assert.equal(calls.find((call) => call.method === "sendMessage" &&
          call.body.message_thread_id === 42)?.body.text,
          `<b>📡 Instance <i>${expected}</i> connected.</b>`);
        assert.deepEqual(await runtime.reconcileThreadDisplay!(), { changed: 0 });
        assert.equal(calls.filter((call) => call.method === "editForumTopic").length, 0);
        const restored = createTelegramTopicTargetStore({ path });
        await restored.load();
        assert.equal(restored.getWorkspaceBinding(
          "/repo/extensions", "a", "session-a")?.displayTitle, expected);
        assert.equal(restored.getWorkspaceBinding(
          "/repo/extensions", "a", "session-a")?.threadName, "Anchor");
        assert.deepEqual(errors, []);
      } finally {
        await runtime.stopPolling();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});

test("Bus leader target provisioner creates thread and announces connection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-leader-provision-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let syncState = {};
  let leaderTarget: unknown;
  let provisioning = 0;
  const provision = createTelegramBusLeaderTargetProvisioner({
    getAllowedUserId: () => 7,
    instanceId: "leader-a",
    getCwd: (ctx: { cwd: string }) => ctx.cwd,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      if (method === "createForumTopic") {
        return { message_thread_id: 11 } as TResponse;
      }
      return { ok: true } as TResponse;
    },
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    setLeaderTarget: (input) => {
      leaderTarget = input;
    },
    onProvisioningStart: () => {
      provisioning += 1;
    },
    onProvisioningEnd: () => {
      provisioning -= 1;
    },
    recordRuntimeEvent() {},
    getNowMs: () => 2000,
  });
  try {
    await provision({ cwd: "/repo" });
    assert.equal(provisioning, 0);
    assert.deepEqual(leaderTarget, {
      target: { chatId: 7, threadId: 11 },
      slot: "A",
      threadName: "Atlas",
    });
    assert.deepEqual(calls, [
      { method: "createForumTopic", body: { chat_id: 7, name: "Atlas" } },
      {
        method: "sendMessage",
        body: {
          chat_id: 7,
          message_thread_id: 11,
          text: "<b>📡 Instance <i>Atlas</i> connected.</b>",
          parse_mode: "HTML",
        },
      },
    ]);
    assert.deepEqual(syncState, {
      "target-bindings": {
        status: "fresh",
        updatedAtMs: 2000,
        lastReconcileAction: "leader-startup",
      },
      reservations: {
        status: "fresh",
        updatedAtMs: 2000,
        lastReconcileAction: "leader-startup",
      },
      "topic-capability": {
        status: "fresh",
        updatedAtMs: 2000,
        lastReconcileAction: "leader-startup",
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader builds connected lifecycle announcements with thread name before slot", () => {
  assert.deepEqual(
    createTelegramBusInstanceLifecycleAnnouncement({
      target: { chatId: 123, threadId: 45 },
      threadName: "Cedar",
      slot: "C",
      state: "connected",
    }),
    {
      target: { chatId: 123, threadId: 45 },
      text: "<b>📡 Instance <i>Cedar</i> connected.</b>",
      parseMode: "HTML",
    },
  );
});

test("Bus leader routes authenticated queue handoff between exact follower generations", async () => {
  const registry = createTelegramBusFollowerRegistry();
  const routed: unknown[] = [];
  registry.register({
    instanceId: "donor",
    registrationGeneration: "donor-generation",
    protocol: TEST_BUS_PROTOCOL_IDENTITY,
    connectedAtMs: 1,
  });
  registry.register({
    instanceId: "recipient",
    registrationGeneration: "recipient-generation",
    protocol: TEST_BUS_PROTOCOL_IDENTITY,
    connectedAtMs: 1,
  });
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    authSecret: "secret",
    routeQueueHandoff(follower, envelope) {
      routed.push({ follower, envelope });
      return { status: "staged", receiptId: "receipt-1", sourceUpdateIds: [1] };
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
    kind: "follower.offerQueueHandoff" as const,
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
  };
  assert.deepEqual(await handleEnvelope(envelope), {
    kind: "bus.ack",
    requestId: "handoff:1",
    ok: true,
    result: { status: "staged", receiptId: "receipt-1", sourceUpdateIds: [1] },
  });
  assert.equal(routed.length, 1);
  assert.equal((routed[0] as { follower: { instanceId: string } }).follower.instanceId, "donor");
  assert.deepEqual(
    await handleEnvelope({
      ...envelope,
      requestId: "handoff:2",
      registrationGeneration: "stale",
    }),
    {
      kind: "bus.ack",
      requestId: "handoff:2",
      ok: false,
      message: "Stale Telegram bus follower registration generation.",
    },
  );
  assert.deepEqual(
    await handleEnvelope({
      ...envelope,
      requestId: "handoff:3",
      recipientRegistrationGeneration: "stale",
    }),
    {
      kind: "bus.ack",
      requestId: "handoff:3",
      ok: false,
      message: "Stale Telegram queue handoff recipient registration generation.",
    },
  );
  assert.equal(routed.length, 1);
  const steerProtocol = createTelegramBusProtocolIdentity({ runtimeBuild: "steer", capabilities: [TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF, TELEGRAM_BUS_CAPABILITY_QUEUE_STEER] });
  for (const missing of ["leader", "donor", "recipient", "none"] as const) {
    const peers = createTelegramBusFollowerRegistry();
    peers.register({ instanceId: "donor", registrationGeneration: "donor-generation", connectedAtMs: 1,
      protocol: missing === "donor" ? TEST_BUS_PROTOCOL_IDENTITY : steerProtocol });
    peers.register({ instanceId: "recipient", registrationGeneration: "recipient-generation", connectedAtMs: 1,
      protocol: missing === "recipient" ? TEST_BUS_PROTOCOL_IDENTITY : steerProtocol });
    let stages = 0;
    const handler = createTelegramBusLeaderEnvelopeHandler({ followerRegistry: peers, authSecret: "secret",
      protocolIdentity: missing === "leader" ? TEST_BUS_PROTOCOL_IDENTITY : steerProtocol,
      routeQueueHandoff: () => { stages += 1; return { status: "staged", receiptId: "receipt-1", sourceUpdateIds: [1] }; },
    });
    const result = await handler({ ...envelope, payload: { ...payload, queueLane: "steer" } });
    assert.equal(result.kind === "bus.ack" && result.ok, missing === "none");
    assert.equal(stages, missing === "none" ? 1 : 0, "Every participant must support Steer before forwarding");
  }
});

test("Bus leader envelope handler registers and heartbeats followers", async () => {
  const registry = createTelegramBusFollowerRegistry();
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    getNowMs: () => 2000,
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.register",
      requestId: "inst-a:1",
      registration: {
        instanceId: "inst-a",
        cwd: "/repo",
        sessionId: "session-a",
        connectedAtMs: 1000,
        registrationGeneration: "inst-a:1",
        slot: "C",
      },
    }),
    { kind: "bus.ack", requestId: "inst-a:1", ok: true },
  );
  assert.deepEqual(registry.get("inst-a"), {
    instanceId: "inst-a",
    cwd: "/repo",
    connectedAtMs: 2000,
    lastHeartbeatMs: 2000,
    registrationIncarnation: registry.get("inst-a")?.registrationIncarnation,
    registrationGeneration: "inst-a:1",
    protocol: TEST_BUS_PROTOCOL_IDENTITY,
    sessionId: "session-a",
    target: undefined,
    slot: "C",
  });
  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.heartbeat",
      requestId: "inst-a:2",
      instanceId: "inst-a",
      registrationGeneration: "inst-a:1",
      sentAtMs: 1500,
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:2",
      ok: true,
      result: { eligibleElectionSlots: ["C"] },
    },
  );
  assert.equal(registry.get("inst-a")?.lastHeartbeatMs, 2000);
});

test("Bus leader generation-fences and commits follower Workspace Thread rename", async () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "inst-a",
    connectedAtMs: 1000,
    registrationGeneration: "inst-a:1",
    target: { chatId: 7, threadId: 42 },
    threadName: "Atlas",
    protocol: TEST_BUS_PROTOCOL_IDENTITY,
  });
  const renames: string[] = [];
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    renameFollowerThread: async (_follower, threadName) => {
      renames.push(threadName);
      return { threadName };
    },
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.renameThread",
      requestId: "inst-a:2",
      instanceId: "inst-a",
      registrationGeneration: "inst-a:1",
      target: { chatId: 7, threadId: 42 },
      threadName: "Navigator",
      sentAtMs: 2000,
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:2",
      ok: true,
      result: { threadName: "Navigator" },
    },
  );
  assert.equal(registry.get("inst-a")?.threadName, "Navigator");
  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.renameThread",
      requestId: "inst-a:wrong-target",
      instanceId: "inst-a",
      registrationGeneration: "inst-a:1",
      target: { chatId: 7, threadId: 99 },
      threadName: "WrongTarget",
      sentAtMs: 2001,
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:wrong-target",
      ok: false,
      message: "Stale Telegram bus follower registration generation.",
    },
  );
  assert.deepEqual(renames, ["Navigator"]);
  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.renameThread",
      requestId: "inst-a:3",
      instanceId: "inst-a",
      registrationGeneration: "stale",
      target: { chatId: 7, threadId: 42 },
      threadName: "Voyager",
      sentAtMs: 2001,
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:3",
      ok: false,
      message: "Stale Telegram bus follower registration generation.",
    },
  );
  assert.deepEqual(renames, ["Navigator"]);
});

for (const mode of ["before", "during-provision", "supported", "leader-only-reader"] as const) {
  test(`Shared pre-dispatch evidence fences incompatible follower readers (${mode})`, async () => {
    const registry = createTelegramBusFollowerRegistry();
    let needed = mode !== "during-provision", provisions = 0;
    const protocolIdentity = createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: [
      TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION, TELEGRAM_BUS_CAPABILITY_PRE_DISPATCH_REBIND,
    ] });
    const handle = createTelegramBusLeaderEnvelopeHandler({ followerRegistry: registry, protocolIdentity,
      getRequiredWorkspaceReaderCapabilities: () => needed ? [TELEGRAM_BUS_CAPABILITY_PRE_DISPATCH_REBIND] : [],
      async provisionFollowerTarget() { provisions++; needed = true; return undefined; },
    });
    const reply = await handle({ kind: "follower.register", requestId: "reader", registration: {
      instanceId: "reader", registrationGeneration: "reader:1", connectedAtMs: 1000,
      protocol: createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: [
        TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
        ...(mode === "supported" ? [TELEGRAM_BUS_CAPABILITY_PRE_DISPATCH_REBIND] : mode === "leader-only-reader" ? ["live-rebind-pre-dispatch-reader-v1"] : []),
      ] }),
    } });
    assert.equal(reply.kind === "bus.ack" && reply.ok, mode === "supported");
    assert.equal(registry.list().length, mode === "supported" ? 1 : 0);
    assert.equal(provisions, mode === "before" || mode === "leader-only-reader" ? 0 : 1);
  });
}

for (const artifact of ["source", "compiled"] as const) for (const kind of ["follower.register", "follower.restoreWorkspace"] as const) for (const codec of ["v1", "v2"] as const)
for (const mode of ["legacy-empty", "supported", "missing-remote", "missing-local", "during-admission", "during-provision", "during-publication", "combined-missing-pre", "combined-missing-orphan", "read-error"] as const)
test(`State-derived Workspace reader requirements fence registration (${artifact}/${kind}/${codec}/${mode})`, async () => {
  const M = artifact === "source" ? { createTelegramBusLeaderEnvelopeHandler: createRawTelegramBusLeaderEnvelopeHandler } : await import("../dist/lib/bus-leader.js");
  const orphan = codec === "v1" ? TELEGRAM_BUS_CAPABILITY_ORPHAN_INTENT_READER : TELEGRAM_BUS_CAPABILITY_ORPHAN_CLEANUP_READER, pre = TELEGRAM_BUS_CAPABILITY_PRE_DISPATCH_REBIND;
  const base = [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION, TELEGRAM_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT,
    ...(codec === "v2" ? [TELEGRAM_BUS_CAPABILITY_ORPHAN_INTENT_READER] : [])];
  const local = createTelegramBusProtocolIdentity({ runtimeBuild: "same-build", capabilities: [...base, pre, ...(mode === "missing-local" ? [] : [orphan])] });
  const remote = createTelegramBusProtocolIdentity({ runtimeBuild: "same-build", capabilities: [...base,
    ...(["supported", "missing-local", "combined-missing-pre"].includes(mode) ? [orphan] : []),
    ...(["supported", "combined-missing-orphan"].includes(mode) ? [pre] : []),
  ] });
  let required: string[] = ["legacy-empty", "during-admission", "during-provision", "during-publication"].includes(mode) ? [] :
    mode.startsWith("combined-") ? [orphan, pre] : [orphan];
  let provisions = 0, publications = 0, observations = 0;
  const registry = createTelegramBusFollowerRegistry();
  const handle = M.createTelegramBusLeaderEnvelopeHandler({ followerRegistry: registry, protocolIdentity: local,
    getRequiredWorkspaceReaderCapabilities() { observations++; if (mode === "read-error") throw new Error("Unreadable Workspace reader evidence"); return required; },
    runWorkspaceAdmission(_input, operation) { if (mode === "during-admission") required = [orphan]; return operation(); },
    async provisionFollowerTarget() { provisions++; if (mode === "during-provision") required = [orphan]; return { chatId: 7, threadId: 42, slot: "B" }; },
    async commitFollowerRegistration(_input, publish) { publications++; if (mode === "during-publication") required = [orphan]; publish(); },
  });
  const envelope = { kind, requestId: "reader-compatibility", registration: { instanceId: "reader", registrationGeneration: "reader:1", connectedAtMs: 1000, protocol: remote } };
  if (mode === "read-error") await assert.rejects(async () => handle(envelope), /Unreadable Workspace reader evidence/u);
  else {
    const ack = await handle(envelope), accepted = mode === "legacy-empty" || mode === "supported";
    assert.equal(ack.kind === "bus.ack" && ack.ok, accepted);
    assert.equal(registry.list().length, accepted ? 1 : 0, "An incompatible reader never acquires live routing authority");
    assert.equal(provisions, accepted || mode === "during-provision" || mode === "during-publication" ? 1 : 0);
    assert.equal(publications, accepted || mode === "during-publication" ? 1 : 0);
  }
  assert.ok(observations > 0, "The compiled handler must actually consume the state-derived contract");
  if (mode === "read-error") { assert.equal(provisions, 0); assert.deepEqual(registry.list(), []); }
});

for (const artifact of ["source", "compiled"] as const)
test(`Native leader assembly carries cold orphan codec requirements into authenticated registration (${artifact})`, async () => {
  const createAssembly = (artifact === "source" ? createTelegramBusLeaderRuntimeAssembly : (await import("../dist/lib/bus-leader.js")).createTelegramBusLeaderRuntimeAssembly) as typeof createTelegramBusLeaderRuntimeAssembly;
  await withWorkspaceRestoreFixture(async ({ store, threads, auth, path }) => {
    const target = { chatId: 7, threadId: 55 }, input = { journalBindingKey: "orphan-source", updateIds: [300] };
    assert.ok(store.registerCancelledOrphanThread(input, target, "a".repeat(32), { ...auth, sessionGeneration: 1 }, id => ({
      journalBindingKey: input.journalBindingKey, updateId: id, operatorAuthorityId: "telegram-owner:7", retainedPath: join(dirname(path), "original.json"),
      originalTarget: { ...target, messageId: 11, sourceSha256: "a".repeat(64) },
    })));
    const before = readFileSync(path, "utf8"), protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "same-build",
      capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION, TELEGRAM_BUS_CAPABILITY_ORPHAN_INTENT_READER] });
    const registry = createTelegramBusFollowerRegistry(), socketPath = `${path}.sock`;
    let allowed: number | undefined, apiCalls = 0, observations = 0;
    const cold = createTelegramTopicTargetStore({ path });
    const runtime = createAssembly({
      runtime: { socketPath, followerRegistry: registry, protocolIdentity: protocol, authSecret: "secret", startPolling() {}, stopPolling() {},
        getRequiredWorkspaceReaderCapabilities() { observations++; return cold.getWorkspaceReaderRequirements().cancelledOrphanIntent ? [TELEGRAM_BUS_CAPABILITY_ORPHAN_INTENT_READER] : []; } },
      getAllowedUserId: () => allowed, instanceId: "leader", topicTargetStore: threads,
      getCurrentLeaderEpoch: () => "epoch", getTelegramProfile: () => "default",
      async callApi<TResponse>(): Promise<TResponse> { apiCalls++; throw new Error("No Bot API issuance is permitted"); },
      async callMultipart() {}, async downloadFile() {}, getSyncState: () => ({}), setSyncState() {}, setLeaderTarget() {}, recordRuntimeEvent() {},
    });
    try {
      await runtime.startPolling("ctx"); allowed = 7;
      const ack = await sendTelegramBusLocalEnvelope({ socketPath, timeoutMs: 2000, envelope: { kind: "follower.register", requestId: "old-reader", auth: "secret",
        registration: { instanceId: "old-reader", registrationGeneration: "old-reader:1", connectedAtMs: 1000,
          protocol: createTelegramBusProtocolIdentity({ runtimeBuild: "same-build", capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION] }) } } });
      assert.ok(ack); assert.equal(ack.kind, "bus.ack");
      if (ack.kind !== "bus.ack") assert.fail("Expected correlated native ACK");
      assert.equal(ack.requestId, "old-reader"); assert.equal(ack.ok, false); assert.equal(ack.error?.code, "incompatible-protocol");
      assert.ok(observations > 0); assert.equal(apiCalls, 0); assert.deepEqual(registry.list(), []);
      assert.equal(readFileSync(path, "utf8"), before, "Reader negotiation never resets, migrates or repairs the retained Workspace state");
    } finally { await runtime.stopPolling(); }
  });
});

test("Explicit connect recovery refuses missing negotiated capability before provisioning", async () => {
  let provisions = 0;
  const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "no-recovery",
    capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION] });
  const handler = createRawTelegramBusLeaderEnvelopeHandler({
    followerRegistry: createTelegramBusFollowerRegistry(), protocolIdentity: protocol,
    provisionFollowerTarget() { provisions++; return { chatId: 7, threadId: 42 }; },
  });
  const ack = await handler({ kind: "follower.register", requestId: "recovery", recoverConnection: true,
    registration: { instanceId: "follower", registrationGeneration: "recovery", protocol, connectedAtMs: Date.now() } });
  assert.equal(ack.kind === "bus.ack" && ack.ok, false);
  assert.equal(provisions, 0);
});

test("Bus leader rejects incompatible protocol before follower provisioning", async () => {
  const registry = createTelegramBusFollowerRegistry();
  const protocolIdentity = createTelegramBusProtocolIdentity({
    runtimeBuild: "0.27.12",
    capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION],
  });
  let provisions = 0;
  const handleEnvelope = createRawTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    protocolIdentity,
    provisionFollowerTarget: () => {
      provisions += 1;
      return { chatId: 7, threadId: 42, slot: "A" };
    },
  });

  const missing = await handleEnvelope({
    kind: "follower.register",
    requestId: "missing:1",
    registration: {
      instanceId: "missing",
      registrationGeneration: "missing:1",
      connectedAtMs: 1000,
    },
  });
  assert.deepEqual(missing, {
    kind: "bus.ack",
    requestId: "missing:1",
    ok: false,
    protocol: protocolIdentity,
    error: { code: "incompatible-protocol" },
    message: "Incompatible Telegram bus protocol: missing-identity.",
  });

  const mismatched = await handleEnvelope({
    kind: "follower.register",
    requestId: "future:1",
    registration: {
      instanceId: "future",
      registrationGeneration: "future:1",
      protocol: {
        protocolVersion: protocolIdentity.protocolVersion + 1,
        runtimeBuild: "future",
        capabilities: [],
      },
      connectedAtMs: 1000,
    },
  });
  assert.equal(
    mismatched.kind === "bus.ack" ? mismatched.ok : true,
    false,
  );
  assert.equal(registry.list().length, 0);
  assert.equal(provisions, 0);

  const probe = await handleEnvelope({ kind: "bus.probe", requestId: "probe:1" });
  assert.deepEqual(probe, { kind: "bus.ack", requestId: "probe:1", ok: true, protocol: protocolIdentity },
    "A liveness probe is answered without registration");
  assert.equal(registry.list().length, 0);
  assert.equal(provisions, 0);

  const missingCapability = await handleEnvelope({
    kind: "follower.register",
    requestId: "legacy:1",
    registration: {
      instanceId: "legacy",
      registrationGeneration: "legacy:1",
      protocol: createTelegramBusProtocolIdentity({
        runtimeBuild: "0.28.0",
      }),
      connectedAtMs: 1000,
    },
  });
  assert.equal(
    missingCapability.kind === "bus.ack"
      ? missingCapability.message
      : undefined,
    "Incompatible Telegram bus protocol: missing-capability.",
  );
  assert.equal(registry.list().length, 0);
  assert.equal(provisions, 0);

  const compatible = createTelegramBusProtocolIdentity({
    runtimeBuild: "0.28.1",
    capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION],
  });
  const accepted = await handleEnvelope({
    kind: "follower.register",
    requestId: "compatible:1",
    registration: {
      instanceId: "compatible",
      registrationGeneration: "compatible:1",
      protocol: compatible,
      connectedAtMs: 1000,
    },
  });
  assert.equal(accepted.kind === "bus.ack" && accepted.ok, true);
  assert.deepEqual(
    accepted.kind === "bus.ack" ? accepted.protocol : undefined,
    protocolIdentity,
  );
  assert.deepEqual(registry.get("compatible")?.protocol, compatible);
  assert.equal(provisions, 1);
});

test("Session-native leader rejects a pre-session protocol follower", async () => {
  const registry = createTelegramBusFollowerRegistry();
  let provisionedSessionId: string | undefined = "not-called";
  const handleEnvelope = createRawTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY,
    provisionFollowerTarget(registration) {
      provisionedSessionId = registration.sessionId;
      return { chatId: 7, threadId: 42, slot: "A" };
    },
  });
  const legacyProtocol = {
    protocolVersion: 1,
    runtimeBuild: "0.45.11",
    capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION],
  };
  const response = await handleEnvelope({
    kind: "follower.register",
    requestId: "legacy:1",
    registration: {
      instanceId: "legacy",
      registrationGeneration: "legacy:1",
      protocol: legacyProtocol,
      cwd: "/repo",
      connectedAtMs: 1000,
    },
  });
  assert.equal(response.kind === "bus.ack" ? response.ok : true, false);
  assert.match(response.kind === "bus.ack" ? response.message ?? "" : "",
    /version-mismatch/u);
  assert.equal(provisionedSessionId, "not-called");
  assert.equal(registry.get("legacy"), undefined);
});

test("Non-default display modes reject incompatible followers before provisioning and live publication", async () => {
  const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "test",
    capabilities: [...TEST_BUS_PROTOCOL_IDENTITY.capabilities, TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE] });
  for (const scenario of ["names", "letters", "directories", "switching"] as const) {
    let mode: TelegramThreadDisplayMode = scenario === "switching" ? "names" : scenario;
    const registry = createTelegramBusFollowerRegistry();
    let provisions = 0;
    const handler = createRawTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry, protocolIdentity: protocol,
      getThreadDisplayMode: () => mode,
      provisionFollowerTarget() {
        provisions++;
        if (scenario === "switching") mode = "directories";
        return { chatId: 7, threadId: 42, slot: "A" };
      },
    });
    const response = await handler({
      kind: "follower.register", requestId: "legacy:1",
      registration: { instanceId: "legacy", registrationGeneration: "legacy:1",
        cwd: "/repo", sessionId: "session-a", connectedAtMs: 1,
        protocol: TEST_BUS_PROTOCOL_IDENTITY },
    });
    assert.ok(response.kind === "bus.ack");
    assert.equal(response.ok, scenario === "names", scenario);
    assert.equal(registry.list().length, scenario === "names" ? 1 : 0, scenario);
    assert.equal(provisions, scenario === "names" || scenario === "switching" ? 1 : 0, scenario);
  }
});

test("Bus leader requires negotiated capability for Workspace auto-connect", async () => {
  let provisions = 0;
  const handleEnvelope = createRawTelegramBusLeaderEnvelopeHandler({
    followerRegistry: createTelegramBusFollowerRegistry(),
    protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY,
    provisionFollowerTarget: () => {
      provisions += 1;
      return { chatId: 7, threadId: 42 };
    },
  });

  const response = await handleEnvelope({
    kind: "follower.restoreWorkspace",
    requestId: "legacy:restore:1",
    registration: {
      instanceId: "legacy",
      registrationGeneration: "legacy:restore:1",
      cwd: "/repo",
      protocol: createTelegramBusProtocolIdentity({
        runtimeBuild: "legacy",
        capabilities: [
          TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
          TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF,
          TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME,
        ],
      }),
      connectedAtMs: 1000,
    },
  });

  assert.equal(response.kind === "bus.ack" ? response.ok : true, false);
  assert.equal(
    response.kind === "bus.ack" ? response.error?.code : undefined,
    "incompatible-protocol",
  );
  assert.equal(provisions, 0);
});

test("Bus leader rejects generationless registration and disconnect envelopes", async () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "inst-a",
    connectedAtMs: 1000,
    registrationGeneration: "inst-a:1",
  });
  let disconnects = 0;
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    onFollowerDisconnected() {
      disconnects += 1;
    },
    async runWithWorkspaceCapacity() {
      throw new Error("Invalid registration must not enter rotation recovery.");
    },
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.register",
      requestId: "inst-b:1",
      registration: { instanceId: "inst-b", connectedAtMs: 1000 },
    }),
    {
      kind: "bus.ack",
      requestId: "inst-b:1",
      ok: false,
      message: "Telegram follower registration requires an exact generation.",
    },
  );
  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.disconnect",
      requestId: "inst-a:2",
      instanceId: "inst-a",
      sentAtMs: 2000,
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:2",
      ok: false,
      message: "Stale Telegram bus follower registration generation.",
    },
  );
  assert.equal(disconnects, 0);
  assert.equal(registry.get("inst-a")?.registrationGeneration, "inst-a:1");
});

test("Bus leader serializes disconnect cleanup before cross-session registration", async () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "inst-a",
    profileKey: "manual:owner-a",
    connectedAtMs: 1000,
    registrationGeneration: "inst-a:A",
    target: { chatId: 7, threadId: 42 },
  });
  let releaseCleanup: (() => void) | undefined;
  let markCleanupStarted: (() => void) | undefined;
  const cleanupStarted = new Promise<void>((resolve) => {
    markCleanupStarted = resolve;
  });
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    async onFollowerDisconnected() {
      markCleanupStarted?.();
      await new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
    },
  });

  const disconnect = handleEnvelope({
    kind: "follower.disconnect",
    requestId: "inst-a:disconnect",
    instanceId: "inst-a",
    registrationGeneration: "inst-a:A",
    sentAtMs: 2000,
  });
  await cleanupStarted;
  let replacementSettled = false;
  const replacement = Promise.resolve(
    handleEnvelope({
      kind: "follower.register",
      requestId: "inst-b:B",
      registration: {
        instanceId: "inst-b",
        profileKey: "manual:owner-a",
        connectedAtMs: 2100,
        registrationGeneration: "inst-b:B",
        target: { chatId: 7, threadId: 43 },
      },
    }),
  ).then((result) => {
    replacementSettled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(replacementSettled, false);
  releaseCleanup?.();

  assert.deepEqual(await disconnect, {
    kind: "bus.ack",
    requestId: "inst-a:disconnect",
    ok: true,
  });
  assert.deepEqual(await replacement, {
    kind: "bus.ack",
    requestId: "inst-b:B",
    ok: true,
    result: { chatId: 7, threadId: 43 },
  });
  assert.equal(registry.get("inst-a"), undefined);
  assert.equal(registry.get("inst-b")?.registrationGeneration, "inst-b:B");
  assert.deepEqual(registry.get("inst-b")?.target, {
    chatId: 7,
    threadId: 43,
  });
});

test("Bus leader stamps follower liveness after slow target provisioning", async () => {
  const registry = createTelegramBusFollowerRegistry();
  let nowMs = 1000;
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    getNowMs: () => nowMs,
    provisionFollowerTarget() {
      nowMs = 21000;
      return { chatId: -1007, threadId: 42, slot: "A" };
    },
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.register",
      requestId: "inst-a:1",
      registration: {
        instanceId: "inst-a",
        cwd: "/repo",
        connectedAtMs: 1000,
        registrationGeneration: "inst-a:1",
      },
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:1",
      ok: true,
      result: { chatId: -1007, threadId: 42, slot: "A" },
    },
  );

  assert.equal(registry.get("inst-a")?.lastHeartbeatMs, 21000);
  assert.deepEqual(registry.pruneStale(21001, 15000), []);
});

for (const capability of [true, false, undefined] as const)
test(`Bus leader relays its Thread capability on heartbeat acknowledgements (${capability})`, async () => {
  const registry = createTelegramBusFollowerRegistry();
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    getThreadCapability: () => capability,
    provisionFollowerTarget: () => ({ chatId: -1007, threadId: 42, slot: "A" }),
  });
  await handleEnvelope({ kind: "follower.register", requestId: "inst-a:1",
    registration: { instanceId: "inst-a", cwd: "/repo", connectedAtMs: 1000, registrationGeneration: "inst-a:1" } });
  const response = await handleEnvelope({ kind: "follower.heartbeat", requestId: "inst-a:2", instanceId: "inst-a",
    registrationGeneration: "inst-a:1", sentAtMs: 2000 });
  assert.equal(response?.kind === "bus.ack" && response.ok, true);
  const result = response?.kind === "bus.ack" ? (response.result as Record<string, unknown>) : {};
  assert.equal(Object.hasOwn(result, "threadCapability"), capability !== undefined, "An unknown capability is omitted so followers keep probing");
  assert.equal(result.threadCapability, capability);
  const rejected = await handleEnvelope({ kind: "follower.heartbeat", requestId: "x:1", instanceId: "missing", sentAtMs: 1 });
  assert.equal(rejected?.kind === "bus.ack" && "result" in rejected && rejected.result !== undefined, false, "Rejected heartbeats leak no capability");
});

test("Bus leader envelope handler rejects unknown follower heartbeats", async () => {
  const registry = createTelegramBusFollowerRegistry();
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.heartbeat",
      requestId: "missing:1",
      instanceId: "missing",
      sentAtMs: 1000,
    }),
    {
      kind: "bus.ack",
      requestId: "missing:1",
      ok: false,
      message: "Unknown Telegram bus follower instance.",
    },
  );
});

test("Follower registration holds profile admission through provisioning and registry publication", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-admission-"));
  try {
    const admission = createTelegramWorkspaceAdmissionLedger({
      path: join(dir, "workspace-admission.json"),
      profileKey: "profile:bus",
      owner: {
        processId: process.pid,
        processBirthId: `${process.pid}:bus-admission-test`,
      },
      getProcessLiveness: () => "alive",
    });
    const registry = createTelegramBusFollowerRegistry();
    let provisions = 0;
    let blockedDuringProvision = false;
    let observedRegistryPublication = false;
    const handleEnvelope = createRawTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY,
      runWorkspaceAdmission(input, operation) {
        assert.equal(input.operationKind, "workspace.register-follower");
        assert.deepEqual(input.scopes, [{ kind: "profile" }]);
        return runWithTelegramWorkspaceAdmissionsAsync({
          ledger: admission,
          ...input,
          operation,
        });
      },
      onFollowerRegistered() {
        observedRegistryPublication =
          registry.get("admitted")?.target?.threadId === 42 &&
          admission.read().leases.length === 1;
      },
      provisionFollowerTarget() {
        provisions += 1;
        assert.equal(admission.read().leases.length, 1);
        blockedDuringProvision =
          admission.acquireRetirementFence({
            operationId: "registration-race-fence",
            retirementIntentId: "registration-race-intent",
            bindingKey: "registration-race-binding",
            slot: "A",
            target: { chatId: 7, threadId: 42 },
            leaderEpoch: 1,
            retirementRequestedAtMs: 1,
          }).kind === "blocked";
        return { chatId: 7, threadId: 42, slot: "A" };
      },
    });
    const accepted = await handleEnvelope({
      kind: "follower.register",
      requestId: "admitted:1",
      registration: {
        instanceId: "admitted",
        registrationGeneration: "admitted:1",
        connectedAtMs: 1,
        protocol: TEST_BUS_PROTOCOL_IDENTITY,
      },
    });
    assert.equal(accepted.kind === "bus.ack" && accepted.ok, true);
    assert.equal(blockedDuringProvision, true);
    assert.equal(observedRegistryPublication, true);
    assert.equal(registry.get("admitted")?.target?.threadId, 42);
    assert.deepEqual(admission.read().leases, []);

    const fence = admission.acquireRetirementFence({
      operationId: "active-registration-fence",
      retirementIntentId: "active-registration-intent",
      bindingKey: "active-registration-binding",
      slot: "B",
      target: { chatId: 7, threadId: 43 },
      leaderEpoch: 1,
      retirementRequestedAtMs: 1,
    });
    assert.equal(fence.kind, "acquired");
    const rejected = await handleEnvelope({
      kind: "follower.register",
      requestId: "blocked:1",
      registration: {
        instanceId: "blocked",
        registrationGeneration: "blocked:1",
        connectedAtMs: 1,
        protocol: TEST_BUS_PROTOCOL_IDENTITY,
      },
    });
    assert.equal(rejected.kind === "bus.ack" && rejected.ok, false);
    assert.equal(
      rejected.kind === "bus.ack" ? rejected.message : undefined,
      "Telegram Workspace operation is blocked by retirement.",
    );
    assert.equal(provisions, 1);
    assert.equal(registry.get("blocked"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const fault of ["healthy", "artifact-only", "old-local", "old-peer", "display-rebind", "registered-rebind", "capture-provider"] as const)
test(`Bootstrap API identity comes from the original native registry owner (${fault})`, async () => {
  const registry = createTelegramBusFollowerRegistry();
  const local = createTelegramBusProtocolIdentity({ runtimeBuild: "issuer", capabilities: [TELEGRAM_BUS_CAPABILITY_GUARDED_API_AUTHORITY,
    ...(fault === "artifact-only" ? [TELEGRAM_BUS_CAPABILITY_ARTIFACT_DOCUMENT] : fault === "old-local" ? [] : [TELEGRAM_BUS_CAPABILITY_API_REGISTRATION_AUTHORITY])] });
  const peer = createTelegramBusProtocolIdentity({ runtimeBuild: "peer", capabilities: [TELEGRAM_BUS_CAPABILITY_GUARDED_API_AUTHORITY,
    ...(fault === "artifact-only" ? [TELEGRAM_BUS_CAPABILITY_ARTIFACT_DOCUMENT] : fault === "old-peer" ? [] : [TELEGRAM_BUS_CAPABILITY_API_REGISTRATION_AUTHORITY])] });
  const replace = () => { const row = registry.get("source"); assert.ok(row); registry.register(row); };
  const handle = createRawTelegramBusLeaderEnvelopeHandler({ followerRegistry: registry, authSecret: "secret", protocolIdentity: local,
    provisionFollowerTarget: () => ({ chatId: 7, threadId: 8, slot: "A" }), getFollowerDisplayTitle() {
      if (fault === "display-rebind") replace();
      if (fault === "capture-provider") { const original = registry.captureRegistration!; registry.captureRegistration = (...args) => original(...args); }
      return "Name";
    }, onFollowerRegistered() { if (fault === "registered-rebind") replace(); } });
  const response = await handle({ kind: "follower.register", requestId: "original", auth: "secret", registration: {
    instanceId: "source", connectedAtMs: 1, registrationGeneration: "original", protocol: peer } });
  assert.equal(response?.kind, "bus.ack"); if (response?.kind !== "bus.ack") assert.fail("No ACK");
  if (["display-rebind", "registered-rebind", "capture-provider"].includes(fault)) {
    assert.equal(response.ok, false); assert.match(response.message ?? "", /API registration changed before acknowledgement/u); return;
  }
  assert.equal(response.ok, true);
  const result = response.result as { apiRegistrationIncarnation?: string; registrationIncarnation?: string };
  if (fault === "healthy") {
    assert.equal(result.apiRegistrationIncarnation, registry.get("source")!.registrationIncarnation);
    assert.equal(result.registrationIncarnation, undefined, "Ordinary API identity is not an Artifact ACK");
  } else assert.equal(result.apiRegistrationIncarnation, undefined, "No substitution from old peers or Artifact proof");
});

test("Deferred follower reconciliation reacquires profile admission through settlement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-background-admission-"));
  let releaseCleanup: (() => void) | undefined;
  try {
    const admission = createTelegramWorkspaceAdmissionLedger({
      path: join(dir, "workspace-admission.json"),
      profileKey: "profile:background-reconcile",
      owner: {
        processId: process.pid,
        processBirthId: `${process.pid}:background-reconcile-test`,
      },
      getProcessLiveness: () => "alive",
    });
    const operationRuntime = createTelegramWorkspaceOperationRuntime({
      getWorkspaceAdmission: () => admission,
    });
    const store = createTelegramTopicTargetStore({
      path: join(dir, "state.json"),
      getNowMs: () => 2000,
    });
    store.upsertPendingProvision({
      id: "expired-provision",
      owner: "manual-follower",
      instanceId: "expired-owner",
      profileKey: "expired-profile",
      slot: "Z",
      startedAtMs: 1,
      expiresAtMs: 2,
      target: { chatId: 7, threadId: 99 },
    });
    await store.persist();
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupEntered: (() => void) | undefined;
    const cleanupStarted = new Promise<void>((resolve) => {
      cleanupEntered = resolve;
    });
    let reconciliation: Promise<unknown> | undefined;
    const provision = createTelegramBusFollowerTargetProvisioner({
      getAllowedUserId: () => 7,
      topicTargetStore: store,
      getCurrentLeaderEpoch: () => 1,
      getSyncState: () => ({}),
      setSyncState() {},
      getNowMs: () => 2000,
      runWorkspaceOperation(input, operation) {
        const run = operationRuntime.run(input, operation);
        if (input.operationKind === "workspace.reconcile-follower-provision") {
          reconciliation = run;
        }
        return run;
      },
      async callApi<TResponse>(
        method: string,
        body: Record<string, unknown>,
      ) {
        if (method === "createForumTopic") {
          return { message_thread_id: 12 } as TResponse;
        }
        if (
          method === "closeForumTopic" &&
          body.message_thread_id === 99
        ) {
          cleanupEntered?.();
          await cleanupGate;
        }
        return { ok: true } as TResponse;
      },
      recordRuntimeEvent() {},
    });

    assert.deepEqual(
      await provision({
        instanceId: "new-follower",
        profileKey: "new-profile",
        connectedAtMs: 1,
      }),
      { chatId: 7, threadId: 12, slot: "A", threadName: "Atlas" },
    );
    await waitForUnrefBackgroundTask(cleanupStarted);
    assert.equal(admission.read().leases.length, 1);
    assert.deepEqual(
      admission.acquireRetirementFence({
        operationId: "background-race-fence",
        retirementIntentId: "background-race-intent",
        bindingKey: "background-race-binding",
        slot: "Z",
        target: { chatId: 7, threadId: 99 },
        leaderEpoch: 1,
        retirementRequestedAtMs: 1,
      }),
      { kind: "blocked", reason: "admission-active" },
    );
    if (!releaseCleanup) throw new Error("Cleanup release was not captured.");
    releaseCleanup();
    await reconciliation;
    assert.deepEqual(admission.read().leases, []);
    assert.deepEqual(store.listPendingProvisions(), []);
  } finally {
    releaseCleanup?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Retained fence blocks deferred follower reconciliation before cleanup mutation", async () => {
  for (const phase of ["fenced", "deletion-issued"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-background-fence-"));
    try {
      const admission = createTelegramWorkspaceAdmissionLedger({
        path: join(dir, "workspace-admission.json"),
        profileKey: `profile:background-${phase}`,
        owner: {
          processId: process.pid,
          processBirthId: `${process.pid}:background-${phase}-test`,
        },
        getProcessLiveness: () => "alive",
      });
      const operationRuntime = createTelegramWorkspaceOperationRuntime({
        getWorkspaceAdmission: () => admission,
      });
      const store = createTelegramTopicTargetStore({
        path: join(dir, "state.json"),
        getNowMs: () => 2000,
      });
      store.upsertPendingProvision({
        id: `expired-${phase}`,
        owner: "manual-follower",
        instanceId: "expired-owner",
        profileKey: "expired-profile",
        slot: "Z",
        startedAtMs: 1,
        expiresAtMs: 2,
        target: { chatId: 7, threadId: 99 },
      });
      await store.persist();
      let cleanupCalls = 0;
      const reconciliationStarted = Promise.withResolvers<void>();
      let reconciliationSettled: Promise<void> | undefined;
      const errors: unknown[] = [];
      const provision = createTelegramBusFollowerTargetProvisioner({
        getAllowedUserId: () => 7,
        topicTargetStore: store,
        getCurrentLeaderEpoch: () => 1,
        getSyncState: () => ({}),
        setSyncState() {},
        getNowMs: () => 2000,
        runWorkspaceOperation(input, operation) {
          const run = operationRuntime.run(input, operation);
          if (input.operationKind === "workspace.reconcile-follower-provision") {
            reconciliationSettled = run.then(
              () => undefined,
              () => undefined,
            );
            reconciliationStarted.resolve();
          }
          return run;
        },
        async callApi<TResponse>(
          method: string,
          body: Record<string, unknown>,
        ) {
          if (method === "createForumTopic") {
            return { message_thread_id: 12 } as TResponse;
          }
          if (
            (method === "closeForumTopic" || method === "deleteForumTopic") &&
            body.message_thread_id === 99
          ) {
            cleanupCalls += 1;
          }
          return { ok: true } as TResponse;
        },
        recordRuntimeEvent(category, error, details) {
          if (
            category === "telegram" &&
            details?.phase === "follower-register-background-reconcile"
          ) {
            errors.push(error);
          }
        },
      });
      await provision({
        instanceId: `new-${phase}`,
        profileKey: `new-profile-${phase}`,
        connectedAtMs: 1,
      });
      const acquired = admission.acquireRetirementFence({
        operationId: `background-fence:${phase}`,
        retirementIntentId: `background-intent:${phase}`,
        bindingKey: `background-binding:${phase}`,
        slot: "Z",
        target: { chatId: 7, threadId: 99 },
        leaderEpoch: 1,
        retirementRequestedAtMs: 1,
      });
      assert.equal(acquired.kind, "acquired");
      if (acquired.kind !== "acquired") continue;
      if (phase === "deletion-issued") {
        assert.equal(admission.issueDeletionPermit(acquired.fence).kind, "issued");
      }
      await waitForUnrefBackgroundTask(reconciliationStarted.promise);
      await reconciliationSettled;

      assert.equal(cleanupCalls, 0);
      assert.equal(store.listPendingProvisions().length, 1);
      assert.deepEqual(admission.read().leases, []);
      assert.equal(errors.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("Bus leader provisions targets before registering followers", async () => {
  const registry = createTelegramBusFollowerRegistry();
  const provisioned: unknown[] = [];
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    provisionFollowerTarget(registration) {
      provisioned.push(registration);
      return { chatId: -1007, threadId: 42, slot: "A" };
    },
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.register",
      requestId: "inst-a:1",
      registration: {
        instanceId: "inst-a",
        profileKey: "cwd:/repo",
        threadName: "repo",
        connectedAtMs: 1000,
        registrationGeneration: "inst-a:1",
      },
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:1",
      ok: true,
      result: { chatId: -1007, threadId: 42, slot: "A" },
    },
  );
  assert.deepEqual(registry.get("inst-a")?.target, {
    chatId: -1007,
    threadId: 42,
    slot: "A",
  });
  assert.deepEqual(provisioned, [
    {
      instanceId: "inst-a",
      profileKey: "cwd:/repo",
      threadName: "repo",
      connectedAtMs: 1000,
      registrationGeneration: "inst-a:1",
      protocol: TEST_BUS_PROTOCOL_IDENTITY,
    },
  ]);
});

test("Bus leader does not acknowledge registration after ambiguous visibility failure", async () => {
  const registry = createTelegramBusFollowerRegistry();
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    async provisionFollowerTarget() {
      throw new Error("Telegram send acknowledgement was lost");
    },
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.register",
      requestId: "inst-a:1",
      registration: {
        instanceId: "inst-a",
        connectedAtMs: 1000,
        registrationGeneration: "inst-a:1",
        target: { chatId: 7, threadId: 42 },
      },
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:1",
      ok: false,
      message: "Telegram send acknowledgement was lost",
    },
  );
  assert.equal(registry.get("inst-a"), undefined);
});

test("Bus leader rejects follower registration after provisioning loses epoch", async () => {
  const registry = createTelegramBusFollowerRegistry();
  let leaderEpoch: number | undefined = 1;
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    getCurrentLeaderEpoch: () => leaderEpoch,
    async provisionFollowerTarget() {
      leaderEpoch = undefined;
      return { chatId: -1007, threadId: 42 };
    },
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.register",
      requestId: "inst-a:lost",
      registration: {
        instanceId: "inst-a",
        connectedAtMs: 1000,
        registrationGeneration: "inst-a:lost",
      },
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:lost",
      ok: false,
      message: "Telegram follower registration lost leader ownership.",
    },
  );
  assert.equal(registry.get("inst-a"), undefined);
});

for (const threaded of [false, true])
for (const fault of ["known", "missing-ready", "no-origin-scope", "no-secret", "no-authorizer", "old-peer", "unbound-peer", "wire-options", "recipient-retargeted", "profile-before-issue", "profile-after-issue", "leader-after-issue", "registration-after-issue", "registration-in-query", "mutated-body", "unknown-send", "rejected", "missing-incarnation", "wrong-incarnation", "same-generation-rebound", "same-generation-after-issue"] as const)
test(`Attachment broker authenticates and pins native original before socket ACK (Thread=${threaded}, ${fault})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-attachment-broker-")), socketPath = join(dir, "bus.sock");
  const target = { chatId: 7, ...(threaded ? { threadId: 11 } : {}) }, protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "attachment-broker",
    capabilities: fault === "old-peer" ? [] : [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION, TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION] });
  const registry = createTelegramBusFollowerRegistry(), peer = { instanceId: "attachment-follower", registrationGeneration: "g1", connectedAtMs: 1,
    profileKey: "manual:attachment", sessionId: "session-a", sessionGeneration: 1, pid: 101, processBirthId: "birth-a", cwd: "/repo", busSocketPath: "/caller", protocol,
    target: fault === "unbound-peer" ? undefined : target, ...(threaded ? { slot: "A" as const } : {}) };
  registry.register(peer); let profile = "default", requests = 0, epoch: number | undefined = 1;
  const ownership = createTelegramBusMessageOwnershipRuntime({ instanceId: "attachment-leader", getProfileKey: () => profile, listFollowers: registry.list });
  const authorize = createTelegramFollowerApiCallAuthorizer({ isMessageOwned: ownership.isOwnedByFollower });
  const prior = globalThis.fetch, family = process.env.PI_TELEGRAM_NETWORK_FAMILY; process.env.PI_TELEGRAM_NETWORK_FAMILY = "ipv4";
  globalThis.fetch = async (_url, init) => {
    requests++; const body = JSON.parse(String(init?.body)); assert.equal(body.chat_id, 7); assert.equal(body.message_thread_id, target.threadId);
    if (fault === "unknown-send") throw new Error("Lost network receipt");
    if (fault === "rejected") return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: fixture rejection" }), { status: 400 });
    if (fault === "profile-after-issue") profile = "other";
    if (fault === "leader-after-issue") epoch = undefined;
    if (fault === "registration-after-issue") registry.register({ ...peer, registrationGeneration: "g2", sessionId: "session-b" });
    if (fault === "same-generation-after-issue") registry.register(peer);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 501 } }));
  };
  const restore = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
  const native = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:attachment-broker"), tempDir: dir,
    maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
  const proxy = createTelegramBusLeaderApiProxy({ call: native.call, callMultipart: native.callMultipart, downloadFile: native.downloadFile });
  const deps: Parameters<typeof createRawTelegramBusLeaderEnvelopeHandler>[0] = { followerRegistry: registry, protocolIdentity: protocol,
    provisionFollowerTarget: () => ({ ...target, ...(threaded ? { slot: "A" } : {}) }),
    getCurrentLeaderEpoch: () => epoch, getTelegramProfile: () => profile, getAllowedUserId: () => 7,
    ...(fault !== "no-secret" ? { authSecret: "fixture-secret" } : {}),
    ...(fault !== "no-authorizer" ? { authorizeFollowerApiCall(input) {
      const allowed = authorize(input); if (fault === "mutated-body") (input.args[1] as Record<string, unknown>).chat_id = 99;
      if (fault === "recipient-retargeted") { input.follower.sessionId = "replacement"; registry.register({ ...peer, sessionId: "replacement" }); }
      return allowed;
    } } : {}),
    getTextInputReceiverBotId: () => 777,
    ...(fault !== "missing-ready" ? { getAttachmentReceiverBotId() {
      if (fault === "registration-in-query") registry.register({ ...peer, registrationGeneration: "g2", sessionId: "session-b" }); return 777;
    } } : {}),
    captureInputPublication(follower, destination) {
      const record = ownership.captureFollowerPublication(follower, destination);
      return fault === "no-origin-scope" ? messageId => record(messageId) : record;
    },
    recordFollowerMessageOwnership() { assert.fail("Attachment origin must not become ordinary ownership"); },
    callApi(method, args) { assert.equal(typeof (args[2] as TelegramApiCallOptions).assertAuthority, "function");
      if (fault === "profile-before-issue") profile = "other"; return proxy(method, args); },
  };
  const handler = createRawTelegramBusLeaderEnvelopeHandler(deps); let observed: TelegramBusEnvelope | undefined;
  const server = createTelegramBusLocalServer({ socketPath, async handleEnvelope(envelope) { const response = await handler(envelope); observed = response; return response; } });
  const state = createTelegramBusFollowerRegistrationState(); let sequence = 0;
  const registration = createTelegramBusFollowerRegistrationRuntime({ instanceId: peer.instanceId, registrationState: state, protocolIdentity: protocol,
    createRequestId: () => sequence++ === 0 ? "g1" : `control:${sequence}`, getLeaderAuthSecret: () => "fixture-secret",
    getSessionId: () => "session-a", getSessionGeneration: () => 1, getPid: () => 101, getProcessBirthId: () => "birth-a",
    getProfileKey: () => "manual:attachment", followerBusSocketPath: "/caller", heartbeatMs: 60_000 });
  const envelope = (auth: string, id: string): TelegramBusEnvelope => ({ kind: "follower.callApi", auth, requestId: id, instanceId: peer.instanceId,
    registrationGeneration: "g1", attachmentRegistrationIncarnation: registry.get(peer.instanceId)?.registrationIncarnation, method: "call", args: ["sendMessage", { chat_id: 7, text: "Question?", ...(threaded ? { message_thread_id: 11 } : {}),
      reply_markup: { inline_keyboard: [[{ text: "Cancel", callback_data: `tgattach:${"a".repeat(32)}:cancel` }]] } }], sentAtMs: 1 });
  try {
    await server.start();
    const denied = await sendTelegramBusLocalEnvelope({ socketPath, envelope: envelope("wrong", "bad-auth") });
    assert.ok(denied?.kind === "bus.ack" && !denied.ok); assert.equal(requests, 0);
    if (fault === "known" || fault === "same-generation-rebound") assert.equal(await registration.registerWithLeader({ cwd: "/repo" }, { busSocketPath: socketPath }), true);
    const request = envelope("fixture-secret", "publication");
    if (request.kind === "follower.callApi") {
      if (fault === "missing-incarnation") delete request.attachmentRegistrationIncarnation;
      if (fault === "wrong-incarnation") request.attachmentRegistrationIncarnation = "b".repeat(48);
      if (fault === "same-generation-rebound") registry.register({ ...peer, sessionId: "session-b" });
    }
    if (fault === "wire-options" && request.kind === "follower.callApi") request.args.push({ assertAuthority: "not-a-local-capability" });
    let ack: TelegramBusEnvelope | undefined;
    if ((fault === "known" || fault === "same-generation-rebound") && request.kind === "follower.callApi") {
      const caller = createTelegramBusFollowerApiCaller({ socketPath, instanceId: peer.instanceId, createRequestId: () => "publication",
        getAuthSecret: () => "fixture-secret", getRegistrationGeneration: () => registry.get(peer.instanceId)?.registrationGeneration,
        getLocalProtocol: () => protocol, getLeaderProtocol: () => protocol,
        captureAttachmentPublicationRegistration: registration.captureAttachmentPublicationRegistration });
      if (fault === "known") {
        const result = await caller(request.method, request.args); ack = observed;
        assert.ok(ack?.kind === "bus.ack"); assert.deepEqual(result, ack.result);
      } else { await assert.rejects(caller(request.method, request.args)); ack = observed; }
    } else ack = await sendTelegramBusLocalEnvelope({ socketPath, envelope: request });
    assert.ok(ack?.kind === "bus.ack"); assert.equal(ack.ok, fault === "known");
    if (fault === "known") {
      const origin = ownership.store.getOriginal(7, 501)!;
      assert.equal(origin.recipient!.sessionId, "session-a"); assert.equal(origin.recipient!.processBirthId, "birth-a");
      assert.deepEqual(origin.record.target, target); assert.equal(origin.record.ownerGeneration, "g1");
      assert.equal(ownership.getOriginalForwardOwnership(7, 501)!.instanceId, peer.instanceId);
      const receipt = parseTelegramBusAttachmentPublicationReceipt((ack.result as Record<string, unknown>)[TELEGRAM_BUS_ATTACHMENT_PUBLICATION_RECEIPT]);
      assert.ok(receipt); assert.equal(receipt.requestId, "publication"); assert.equal(receipt.instanceId, peer.instanceId);
      assert.equal(receipt.registrationGeneration, "g1"); assert.equal(receipt.registrationIncarnation, registry.get(peer.instanceId)!.registrationIncarnation); assert.equal(receipt.nonce, "a".repeat(32)); assert.equal(receipt.botId, 777);
      assert.deepEqual(receipt.target, target); assert.equal(receipt.messageId, 501);
    } else {
      assert.equal(ownership.store.getOriginal(7, 501), undefined);
      if (["profile-after-issue", "leader-after-issue", "registration-after-issue", "same-generation-after-issue", "unknown-send"].includes(fault)) assert.deepEqual(ack.error, { code: "commit-unknown", method: "sendMessage" });
      else assert.equal(ack.error?.code === "commit-unknown", false);
    }
    assert.equal(requests, ["known", "profile-after-issue", "leader-after-issue", "registration-after-issue", "same-generation-after-issue", "unknown-send", "rejected"].includes(fault) ? 1 : 0);
  } finally { registration.stop(); await server.stop(); restore(); globalThis.fetch = prior;
    if (family === undefined) delete process.env.PI_TELEGRAM_NETWORK_FAMILY; else process.env.PI_TELEGRAM_NETWORK_FAMILY = family;
    rmSync(dir, { recursive: true, force: true }); }
});

for (const threaded of [false, true]) for (const readiness of ["ready", "missing", "unavailable", "invalid", "throws", "after-send", "bot-changed", "getter-swapped"] as const) {
test(`Follower Input publication requires ready matching bot identity (Thread=${threaded}, ${readiness})`, async () => {
  const target = { chatId: 7, ...(threaded ? { threadId: 11 } : {}) };
  const registry = createTelegramBusFollowerRegistry();
  registry.register({ instanceId: "follower", connectedAtMs: 1, profileKey: "manual:recipient", registrationGeneration: "g1",
    sessionId: "session", sessionGeneration: 1, pid: 101, processBirthId: "birth", cwd: "/repo", busSocketPath: "/endpoint",
    protocol: TEST_BUS_PROTOCOL_IDENTITY, ...(threaded ? { target } : {}) });
  const ownership = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => "default", listFollowers: registry.list });
  let botId: number | undefined = readiness === "unavailable" ? undefined : readiness === "invalid" ? 0 : 777, calls = 0;
  const deps: Parameters<typeof createTelegramBusLeaderEnvelopeHandler>[0] = {
    followerRegistry: registry, captureInputPublication: ownership.captureFollowerPublication,
    ...(readiness === "missing" ? {} : { getTextInputReceiverBotId(follower: Readonly<TelegramBusFollowerView>, candidate: Readonly<typeof target>) {
      assert.equal(follower.instanceId, "follower"); assert.deepEqual(candidate, target); assert.ok(Object.isFrozen(candidate));
      if (readiness === "throws") throw new Error("observer details"); return botId;
    } }),
    callApi() { calls++;
      if (readiness === "after-send") botId = undefined;
      if (readiness === "bot-changed") botId = 778;
      if (readiness === "getter-swapped") { botId = undefined; deps.getTextInputReceiverBotId = () => 777; }
      return { message_id: 501 };
    },
  };
  const handle = createTelegramBusLeaderEnvelopeHandler(deps);
  const ack = await handle({ kind: "follower.callApi", requestId: "readiness", instanceId: "follower", registrationGeneration: "g1", method: "call",
    args: ["sendMessage", { chat_id: 7, ...(threaded ? { message_thread_id: 11 } : {}), text: "Question?",
      reply_markup: { inline_keyboard: [[{ text: "Cancel", callback_data: `tginput:${"a".repeat(32)}:cancel` }]] } }], sentAtMs: 1 });
  assert.ok(ack.kind === "bus.ack");
  assert.equal(ack.ok, readiness === "ready");
  assert.equal(calls, ["ready", "after-send", "bot-changed", "getter-swapped"].includes(readiness) ? 1 : 0);
  assert.equal(!!ownership.store.getOriginal(7, 501), readiness === "ready");
  if (!ack.ok && calls) assert.deepEqual(ack.error, { code: "commit-unknown", method: "sendMessage" });
  assert.doesNotMatch(ack.message ?? "", /observer details/);
});
}

for (const sdk of [false, true]) for (const requestIssued of [false, true]) {
test(`Follower authority errors retain SDK-only issuance uncertainty (SDK=${sdk}, issued=${requestIssued})`, async () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({ instanceId: "follower", connectedAtMs: 1, profileKey: "manual:recipient", registrationGeneration: "g1",
    sessionId: "session", sessionGeneration: 1, pid: 101, processBirthId: "birth", cwd: "/repo", busSocketPath: "/endpoint",
    protocol: TEST_BUS_PROTOCOL_IDENTITY });
  const ownership = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => "default", listFollowers: registry.list });
  const handle = createTelegramBusLeaderEnvelopeHandler({ followerRegistry: registry, captureInputPublication: ownership.captureFollowerPublication, getTextInputReceiverBotId: () => 777,
    callApi() { throw new TelegramApiAuthorityError(requestIssued); } });
  const ack = await handle({ kind: "follower.callApi", requestId: "authority", instanceId: "follower", registrationGeneration: "g1",
    method: "call", args: ["sendMessage", { chat_id: 7, text: "Question?",
      ...(sdk ? { reply_markup: { inline_keyboard: [[{ text: "Cancel", callback_data: `tginput:${"a".repeat(32)}:cancel` }]] } } : {}) }], sentAtMs: 1 });
  assert.ok(ack.kind === "bus.ack" && !ack.ok);
  assert.deepEqual(ack.error, sdk && requestIssued ? { code: "commit-unknown", method: "sendMessage" } : undefined);
  assert.deepEqual(ownership.store.entries(), []);
});
}

for (const threaded of [false, true]) for (const outcome of ["known", "missing-hook", "incomplete-peer", "descriptor-changed", "profile-lost", "registration-lost", "record-failed", "bad-receipt", "unknown-send", "mutable-envelope"] as const) {
test(`Follower Input publication pins authenticated origin before ACK (Thread=${threaded}, ${outcome})`, async () => {
  const registry = createTelegramBusFollowerRegistry();
  const target = { chatId: 7, ...(threaded ? { threadId: 11 } : {}) };
  const peer = { instanceId: "follower", connectedAtMs: 1, profileKey: "manual:recipient", registrationGeneration: "g1",
    sessionId: "session-a", sessionGeneration: 3, pid: 101 as number | undefined, processBirthId: "birth-a", cwd: "/a", busSocketPath: "/endpoint-a",
    ...(threaded ? { target } : {}), protocol: createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION] }) };
  if (outcome === "incomplete-peer") peer.pid = undefined;
  registry.register(peer);
  let profile = "default", sends = 0;
  const ownership = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => profile, listFollowers: registry.list });
  const body: Record<string, unknown> = { chat_id: 7, text: "Question?", ...(threaded ? { message_thread_id: 11 } : {}),
    reply_markup: { inline_keyboard: [[{ text: "Cancel", callback_data: `tginput:${"a".repeat(32)}:cancel` }]] } };
  const envelope: Extract<TelegramBusEnvelope, { kind: "follower.callApi" }> = { kind: "follower.callApi", requestId: "publication",
    instanceId: "follower", registrationGeneration: "g1", method: "call", args: ["sendMessage", body], sentAtMs: 1 };
  const handle = createTelegramBusLeaderEnvelopeHandler({ followerRegistry: registry,
    authorizeFollowerApiCall({ args }) { if (outcome === "descriptor-changed") args[0] = "editMessageText"; return true; },
    getTextInputReceiverBotId: () => 777,
    recordFollowerMessageOwnership() { assert.fail("SDK origin cannot be downgraded to ordinary ownership"); },
    ...(outcome === "missing-hook" ? {} : { captureInputPublication(follower: TelegramBusFollowerView, publicationTarget: { chatId: number; threadId?: number }) {
      const publish = ownership.captureFollowerPublication(follower, publicationTarget);
      return (id: number) => { if (outcome === "record-failed") throw new Error("Recorder refused"); publish(id); };
    } }),
    async callApi(_method, args) {
      sends++; assert.notEqual(args, envelope.args, "SDK data snapshots do not borrow the mutable incoming envelope");
      if (outcome === "mutable-envelope") { body.chat_id = 99; body.reply_markup = {}; }
      assert.equal((args[1] as Record<string, unknown>).chat_id, 7);
      if (outcome === "unknown-send") throw new TelegramApiCommitUnknownError("sendMessage", new Error("uncertain"));
      if (outcome === "profile-lost") profile = "other";
      if (outcome === "registration-lost") registry.register({ ...peer, registrationGeneration: "g2", sessionId: "session-b" });
      return outcome === "bad-receipt" ? [] : { message_id: 501 };
    },
  });
  const ack = await handle(envelope);
  assert.equal(ack.kind, "bus.ack"); if (ack.kind !== "bus.ack") return;
  if (outcome === "known" || outcome === "mutable-envelope") {
    assert.equal(ack.ok, true);
    const original = ownership.store.getOriginal(7, 501)!;
    assert.equal(original.recipient!.sessionId, "session-a"); assert.deepEqual(original.record.target, target);
    assert.equal(ownership.getOriginalForwardOwnership(7, 501)!.ownerGeneration, "g1");
  } else {
    assert.equal(ack.ok, false);
    if (outcome !== "missing-hook" && outcome !== "incomplete-peer" && outcome !== "descriptor-changed") assert.deepEqual(ack.error, { code: "commit-unknown", method: "sendMessage" });
    if (outcome === "registration-lost") {
      assert.equal(ownership.store.getOriginal(7, 501)!.record.ownerGeneration, "g1");
      assert.equal(ownership.getOriginalForwardOwnership(7, 501), undefined);
    } else { if (outcome === "profile-lost") profile = "default"; assert.equal(ownership.store.getOriginal(7, 501), undefined); }
  }
  assert.equal(sends, outcome === "missing-hook" || outcome === "incomplete-peer" || outcome === "descriptor-changed" ? 0 : 1);
});
}

test("Bus leader records ownership for follower-sent messages", async () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "inst-a",
    connectedAtMs: 1000,
    registrationGeneration: "generation-a",
    target: { chatId: 1, threadId: 42 },
  });
  const ownership: unknown[] = [];
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    getNowMs: () => 4000,
    callApi() {
      return { message_id: 44 };
    },
    recordFollowerMessageOwnership(record) {
      ownership.push({
        instanceId: record.follower.instanceId,
        chatId: record.chatId,
        messageId: record.messageId,
        target: record.target,
      });
    },
  });

  await handleEnvelope({
    kind: "follower.callApi",
    requestId: "inst-a:4",
    instanceId: "inst-a",
    registrationGeneration: "generation-a",
    method: "call",
    args: ["sendMessage", { chat_id: 1, text: "Menu" }],
    sentAtMs: 4000,
  });

  assert.deepEqual(ownership, [
    {
      instanceId: "inst-a",
      chatId: 1,
      messageId: 44,
      target: { chatId: 1, threadId: 42 },
    },
  ]);
});

for (const phase of ["authorize", "http", "record"] as const)
for (const fault of ["healthy", "registration", "transport", "operator", "profile", "capture-provider", "call-provider", ...(phase === "authorize" ? ["legacy", "policy-refused", "native-rejected", "wire-mutation"] as const : [])] as const)
test(`Scoped ordinary broker retains original native authority (${phase}/${fault})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-api-broker-scope-")), ctx = { cwd: dir, sessionId: "original" };
  const lock = createTelegramLockRuntime({ locksPath: join(dir, "owners.json"), instanceId: "leader" });
  const sessions = createTelegramSessionContextStore<typeof ctx>(); sessions.set(ctx);
  const polling = createTelegramLockedPollingRuntime({ lock, hasBotToken: () => true, isContextCurrent: sessions.isCurrent, getSessionId: value => value.sessionId,
    startPolling() {}, async stopPolling() {}, updateStatus() {} });
  await polling.start(ctx);
  const registry = createTelegramBusFollowerRegistry(), registration = { instanceId: "follower", registrationGeneration: "same", target: { chatId: 7, threadId: 42 }, connectedAtMs: 1 };
  registry.register(registration);
  let user = 7, profile = "default", effects = 0, records = 0;
  const mutate = () => {
    if (fault === "registration") registry.register(registration);
    if (fault === "transport") sessions.set({ ...ctx, sessionId: "replacement" });
    if (fault === "operator") user = 8;
    if (fault === "profile") profile = "replacement";
    if (fault === "capture-provider") deps.captureApiTransport = () => polling.captureCurrentTransportAuthority();
    if (fault === "call-provider") deps.callApi = (method, args) => proxy(method, args);
  };
  const previous = globalThis.fetch;
  globalThis.fetch = async () => {
    effects++; if (phase === "http") mutate();
    if (fault === "native-rejected") return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message thread not found" }), { status: 400 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 55, chat: { id: 7 }, message_thread_id: 42 } }));
  };
  const restore = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
  const api = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:broker"), tempDir: dir, maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
  const proxy = createTelegramBusLeaderApiProxy(api);
  const deps = { followerRegistry: registry, authSecret: "secret", protocolIdentity: createTelegramBusProtocolIdentity({ runtimeBuild: "broker" }),
    captureApiTransport: fault === "legacy" ? undefined : polling.captureCurrentTransportAuthority, getCurrentLeaderEpoch: lock.getOwnedLeaderEpoch,
    captureArtifactTransport() { assert.fail("Ordinary API scope cannot borrow Artifact authority"); },
    getAllowedUserId: () => user, getTelegramProfile: () => profile,
    authorizeFollowerApiCall() { if (phase === "authorize") mutate(); return fault !== "policy-refused"; },
    callApi: (method: string, args: unknown[]) => {
      if (fault === "wire-mutation") args[1] = { chat_id: 7, message_thread_id: 42, text: "Substituted" };
      return proxy(method, args);
    },
    recordFollowerMessageOwnership() { records++; if (phase === "record") mutate(); } };
  const handle = createRawTelegramBusLeaderEnvelopeHandler(deps);
  try {
    const ack = await handle({ kind: "follower.callApi", requestId: "original", auth: "secret", instanceId: "follower", registrationGeneration: "same", sentAtMs: 1,
      method: "call", args: ["sendMessage", { chat_id: 7, message_thread_id: 42, text: "Original" }, { maxAttempts: 1, retrySafety: "non-idempotent" }] });
    const success = fault === "healthy" || fault === "legacy";
    assert.equal(ack.kind, "bus.ack"); assert.equal(ack.kind === "bus.ack" && ack.ok, success);
    assert.equal(effects, success || phase !== "authorize" || fault === "native-rejected" ? 1 : 0, "Original authority loss cannot start or repeat a native effect: " + JSON.stringify(ack));
    assert.equal(records, success || phase === "record" ? 1 : 0);
    const code = ack.kind === "bus.ack" ? ack.error?.code : undefined;
    if (fault === "policy-refused") assert.equal(code, "follower-api-not-allowed", "Original policy rejection keeps its proven pre-HTTP meaning");
    else if (fault === "native-rejected") assert.equal(code, "stale-target", "Native exact-method rejection stays rejection, not unknown");
    else {
      assert.equal(code === "commit-unknown", !success && phase !== "authorize");
      assert.notEqual(code, "follower-api-not-allowed", "Authority loss is not a reusable pre-HTTP policy refusal");
    }
  } finally { await polling.stop(); restore(); globalThis.fetch = previous; rmSync(dir, { recursive: true, force: true }); }
});

for (const fault of ["healthy", "wrong", "missing", "replaced", "heartbeat", "unmarked", "no-transport", "old-peer"] as const)
test(`Native ordinary API binding cannot adopt another registry incarnation (${fault})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-api-reg-origin-")), ctx = { cwd: dir, sessionId: "origin" };
  const lock = createTelegramLockRuntime({ locksPath: join(dir, "owners.json"), instanceId: "leader" }), sessions = createTelegramSessionContextStore<typeof ctx>(); sessions.set(ctx);
  const polling = createTelegramLockedPollingRuntime({ lock, hasBotToken: () => true, isContextCurrent: sessions.isCurrent, getSessionId: value => value.sessionId,
    startPolling() {}, async stopPolling() {}, updateStatus() {} });
  await polling.start(ctx);
  const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "native-origin", capabilities: [TELEGRAM_BUS_CAPABILITY_GUARDED_API_AUTHORITY, TELEGRAM_BUS_CAPABILITY_API_REGISTRATION_AUTHORITY] });
  const peer = fault === "old-peer" ? createTelegramBusProtocolIdentity({ runtimeBuild: "old", capabilities: [TELEGRAM_BUS_CAPABILITY_GUARDED_API_AUTHORITY] }) : protocol;
  const registry = createTelegramBusFollowerRegistry(), registration = { instanceId: "source", registrationGeneration: "same", target: { chatId: 7, threadId: 42 }, protocol: peer, connectedAtMs: 1 };
  registry.register(registration); const original = registry.get("source")!.registrationIncarnation;
  if (fault === "replaced") registry.register(registration);
  if (fault === "heartbeat") registry.heartbeat("source", 20);
  let effects = 0, records = 0, authorizations = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { effects++; return new Response(JSON.stringify({ ok: true, result: { message_id: 55, chat: { id: 7 }, message_thread_id: 42 } })); };
  const restore = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
  const api = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:api-origin"), tempDir: dir, maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
  const handle = createRawTelegramBusLeaderEnvelopeHandler({ followerRegistry: registry, authSecret: "secret", protocolIdentity: protocol,
    captureApiTransport: fault === "no-transport" ? undefined : polling.captureCurrentTransportAuthority, getCurrentLeaderEpoch: lock.getOwnedLeaderEpoch,
    getTelegramProfile: () => "default", getAllowedUserId: () => 7, authorizeFollowerApiCall() { authorizations++; return true; },
    captureArtifactTransport() { assert.fail("API registration is not Artifact authority"); }, callApi: createTelegramBusLeaderApiProxy(api), recordFollowerMessageOwnership() { records++; } });
  try {
    const response = await handle({ kind: "follower.callApi", requestId: "original", auth: "secret", instanceId: "source", registrationGeneration: "same", sentAtMs: 1,
      ...(fault === "missing" ? {} : { apiRegistrationIncarnation: fault === "wrong" ? "b".repeat(48) : original }), method: "call",
      args: ["sendMessage", { chat_id: 7, message_thread_id: 42, text: "Original" }, ...(fault === "unmarked" ? [] : [{ maxAttempts: 1, retrySafety: "non-idempotent" }])] });
    assert.equal(response.kind, "bus.ack"); if (response.kind !== "bus.ack") assert.fail("No ACK");
    const accepted = fault === "healthy" || fault === "heartbeat";
    assert.equal(response.ok, accepted); assert.equal(effects, accepted ? 1 : 0); assert.equal(records, accepted ? 1 : 0);
    if (!accepted) { assert.equal(authorizations, 0); assert.notEqual(response.error?.code, "follower-api-not-allowed", "Refused native origin cannot authorize weaker fallback"); }
  } finally { await polling.stop(); restore(); globalThis.fetch = previous; rmSync(dir, { recursive: true, force: true }); }
});

for (const apiMethod of ["sendMessage", "sendRichMessage"] as const)
for (const threaded of [false, true])
for (const echo of ["complete", "legacy", "business", "legacy-business", "foreign-chat", "foreign-thread", "foreign-namespace", "bad-chat", "bad-thread", "bad-id", "missing-id"] as const)
test(`Scoped first-send ACK must not contradict the original native carrier (${apiMethod}/${threaded}/${echo})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-api-carrier-")), ctx = { cwd: dir, sessionId: "carrier" };
  const lock = createTelegramLockRuntime({ locksPath: join(dir, "owners.json"), instanceId: "leader" });
  const sessions = createTelegramSessionContextStore<typeof ctx>(); sessions.set(ctx);
  const polling = createTelegramLockedPollingRuntime({ lock, hasBotToken: () => true, isContextCurrent: sessions.isCurrent, getSessionId: value => value.sessionId,
    startPolling() {}, async stopPolling() {}, updateStatus() {} });
  await polling.start(ctx);
  const registry = createTelegramBusFollowerRegistry(), target = { chatId: 7, ...(threaded ? { threadId: 42 } : {}) };
  registry.register({ instanceId: "follower", registrationGeneration: "original", target, connectedAtMs: 1 });
  let requests = 0, records = 0;
  const message: Record<string, unknown> = { message_id: 55, chat: { id: 7 }, ...(threaded ? { message_thread_id: 42 } : {}) };
  const business = echo === "business" || echo === "legacy-business";
  if (echo === "legacy" || echo === "legacy-business") { delete message.chat; delete message.message_thread_id; }
  if (echo === "business") message.business_connection_id = "original-business";
  if (echo === "foreign-chat") message.chat = { id: 8 };
  if (echo === "foreign-thread") message.message_thread_id = 99;
  if (echo === "foreign-namespace") message.business_connection_id = "foreign-business";
  if (echo === "bad-chat") message.chat = null;
  if (echo === "bad-thread") message.message_thread_id = null;
  if (echo === "bad-id") message.message_id = "55";
  if (echo === "missing-id") delete message.message_id;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { requests++; return new Response(JSON.stringify({ ok: true, result: message })); };
  const restore = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
  const api = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:carrier"), tempDir: dir, maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
  const handle = createRawTelegramBusLeaderEnvelopeHandler({ followerRegistry: registry, authSecret: "secret", protocolIdentity: createTelegramBusProtocolIdentity({ runtimeBuild: "carrier" }),
    captureApiTransport: echo === "legacy-business" ? undefined : polling.captureCurrentTransportAuthority, getCurrentLeaderEpoch: lock.getOwnedLeaderEpoch,
    getAllowedUserId: () => 7, getTelegramProfile: () => "default", authorizeFollowerApiCall: () => true,
    callApi: createTelegramBusLeaderApiProxy(api), recordFollowerMessageOwnership(record) { records++; assert.deepEqual(record.target, target); } });
  try {
    const ack = await handle({ kind: "follower.callApi", requestId: "original", auth: "secret", instanceId: "follower", registrationGeneration: "original", sentAtMs: 1,
      method: "call", args: [apiMethod, { chat_id: 7, ...(threaded ? { message_thread_id: 42 } : {}), ...(business ? { business_connection_id: "original-business" } : {}),
        ...(apiMethod === "sendMessage" ? { text: "Original" } : { rich_message: { markdown: "Original" } }) },
        { maxAttempts: 1, retrySafety: "non-idempotent" }] });
    const valid = echo === "complete" || echo === "legacy" || business;
    assert.equal(ack.kind, "bus.ack"); assert.equal(ack.kind === "bus.ack" && ack.ok, valid);
    assert.equal(ack.kind === "bus.ack" && ack.error?.code === "commit-unknown", !valid);
    assert.equal(records, valid && !business ? 1 : 0, "A foreign/malformed ACK or business namespace cannot manufacture bot-chat ownership");
    assert.equal(requests, 1, "Uncertain first-send acknowledgements never replay");
  } finally { await polling.stop(); restore(); globalThis.fetch = previous; rmSync(dir, { recursive: true, force: true }); }
});

test("Bus leader handles follower API call envelopes for registered followers", async () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "inst-a",
    registrationGeneration: "generation-a",
    connectedAtMs: 1000,
  });
  const calls: unknown[] = [];
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    getNowMs: () => 4000,
    callApi(method, args) {
      calls.push({ method, args });
      return { message_id: 44 };
    },
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.callApi",
      requestId: "inst-a:4",
      instanceId: "inst-a",
      registrationGeneration: "generation-a",
      method: "sendRichMessage",
      args: [{ chat_id: 1 }],
      sentAtMs: 4000,
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:4",
      ok: true,
      result: { message_id: 44 },
    },
  );
  assert.deepEqual(calls, [
    { method: "sendRichMessage", args: [{ chat_id: 1 }] },
  ]);
  assert.equal(registry.get("inst-a")?.lastHeartbeatMs, 4000);
  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.callApi",
      requestId: "missing:1",
      instanceId: "missing",
      method: "sendRichMessage",
      args: [],
      sentAtMs: 5000,
    }),
    {
      kind: "bus.ack",
      requestId: "missing:1",
      ok: false,
      message: "Unknown Telegram bus follower instance.",
    },
  );
});

test("Bus leader returns exact stale-target evidence to the owning follower", async () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "inst-a",
    registrationGeneration: "generation-a",
    connectedAtMs: 1000,
  });
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    callApi() {
      throw new TelegramApiStaleTargetError(
        "Telegram API sendMessage failed: HTTP 400: Bad Request: message thread not found",
        { chatId: 1, threadId: 42 },
      );
    },
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.callApi",
      requestId: "inst-a:stale:1",
      instanceId: "inst-a",
      registrationGeneration: "generation-a",
      method: "call",
      args: [
        "sendMessage",
        { chat_id: 1, message_thread_id: 42, text: "private" },
      ],
      sentAtMs: 4000,
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:stale:1",
      ok: false,
      message:
        "Telegram API sendMessage failed: HTTP 400: Bad Request: message thread not found",
      error: { code: "stale-target", chatId: 1, threadId: 42 },
    },
  );
});

test("Bus leader rejects delayed API calls from a replaced follower generation", async () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "inst-a",
    connectedAtMs: 2000,
    registrationGeneration: "generation-new",
  });
  let apiCalls = 0;
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    callApi() {
      apiCalls += 1;
      return { ok: true };
    },
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.callApi",
      requestId: "inst-a:old:1",
      instanceId: "inst-a",
      registrationGeneration: "generation-old",
      method: "call",
      args: ["sendMessage", { chat_id: 1 }],
      sentAtMs: 3000,
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:old:1",
      ok: false,
      message: "Stale Telegram bus follower registration generation.",
    },
  );
  assert.equal(apiCalls, 0);
});

test("Bus leader encodes commit-unknown API failures structurally", async () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "inst-a",
    registrationGeneration: "generation-a",
    connectedAtMs: 1000,
  });
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    async callApi() {
      throw new TelegramApiCommitUnknownError(
        "sendMessage",
        new Error("response lost"),
      );
    },
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.callApi",
      requestId: "inst-a:ambiguous:1",
      instanceId: "inst-a",
      registrationGeneration: "generation-a",
      method: "call",
      args: ["sendMessage", { chat_id: 1 }],
      sentAtMs: 4000,
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:ambiguous:1",
      ok: false,
      message:
        "Telegram API sendMessage may have committed before transport failed.",
      error: { code: "commit-unknown", method: "sendMessage" },
    },
  );
});

test("Bus leader proxies only exact-generation traffic and preserves durable receipts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-exact-proxy-"));
  const followerSocketPath = join(dir, "follower.sock");
  let forwarded = 0;
  const followerServer = createTelegramBusLocalServer({
    socketPath: followerSocketPath,
    handleEnvelope(envelope) {
      forwarded += 1;
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
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "inst-a",
    registrationGeneration: "generation-a",
    busSocketPath: followerSocketPath,
    connectedAtMs: 1000,
  });
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
  });
  const delivery = (sourceUpdateId: number) =>
    createTelegramBusFollowerDeliveryIdentity({
      kind: "leader.forwardMessage",
      recipientBindingKey: "manual:owner-a",
      sourceUpdateId,
    });
  try {
    await followerServer.start();
    assert.deepEqual(
      await handleEnvelope({
        kind: "leader.forwardMessage",
        requestId: "leader:1",
        recipientInstanceId: "inst-a",
        recipientRegistrationGeneration: "generation-a",
        delivery: delivery(44),
        message: { message_id: 1 },
        sentAtMs: 2000,
      }),
      {
        kind: "bus.ack",
        requestId: "leader:1",
        ok: true,
        result: { deliveryId: delivery(44).deliveryId, sourceUpdateId: 44 },
      },
    );
    assert.deepEqual(
      await handleEnvelope({
        kind: "leader.forwardMessage",
        requestId: "leader:stale",
        recipientInstanceId: "inst-a",
        recipientRegistrationGeneration: "generation-old",
        delivery: delivery(45),
        message: { message_id: 2 },
        sentAtMs: 2001,
      }),
      {
        kind: "bus.ack",
        requestId: "leader:stale",
        ok: false,
        message: "Stale Telegram bus follower registration generation.",
      },
    );
    assert.deepEqual(
      await handleEnvelope({
        kind: "bus.ack",
        requestId: "nested-response",
        ok: true,
      }),
      {
        kind: "bus.ack",
        requestId: "nested-response",
        ok: false,
        message: "Telegram bus response envelope cannot be used as a request.",
      },
    );
    assert.equal(forwarded, 1);
  } finally {
    await followerServer.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader rejects unauthenticated envelopes when a secret is configured", async () => {
  const registry = createTelegramBusFollowerRegistry();
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    authSecret: "secret",
  });

  for (const envelope of [
    {
      kind: "follower.register" as const,
      requestId: "inst-a:1",
      registration: {
        instanceId: "inst-a",
        connectedAtMs: 1000,
        registrationGeneration: "inst-a:1",
      },
    },
    {
      kind: "follower.heartbeat" as const,
      requestId: "inst-a:2",
      instanceId: "inst-a",
      sentAtMs: 2000,
    },
    {
      kind: "follower.callApi" as const,
      requestId: "inst-a:3",
      instanceId: "inst-a",
      method: "call",
      args: ["sendMessage", {}],
      sentAtMs: 3000,
    },
    {
      kind: "leader.forwardMessage" as const,
      requestId: "leader:4",
      recipientInstanceId: "inst-a",
      recipientRegistrationGeneration: "inst-a:1",
      delivery: createTelegramBusFollowerDeliveryIdentity({
        kind: "leader.forwardMessage",
        recipientBindingKey: "manual:owner-a",
        sourceUpdateId: 1,
      }),
      message: { message_id: 1 },
      sentAtMs: 4000,
    },
  ]) {
    assert.deepEqual(await handleEnvelope(envelope), {
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: false,
      message: "Unauthorized Telegram bus envelope.",
    });
  }
});

test("Bus leader generation-fences agent message routing", async () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "inst-a",
    connectedAtMs: 1000,
    registrationGeneration: "generation-a",
    target: { chatId: 100, threadId: 42 },
  });
  const routed: unknown[] = [];
  const handle = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    resolveAgentTarget: (_follower, selector) =>
      selector.threadName === "Hazel"
        ? { chatId: 100, threadId: 99 }
        : undefined,
    routeAgentMessage: (follower, message) => {
      routed.push({ follower: follower.instanceId, message });
    },
  });
  assert.deepEqual(
    await handle({
      kind: "follower.resolveAgentTarget",
      requestId: "resolve",
      instanceId: "inst-a",
      registrationGeneration: "generation-a",
      selector: { threadName: "Hazel" },
      sentAtMs: 2000,
    }),
    {
      kind: "bus.ack",
      requestId: "resolve",
      ok: true,
      result: { chatId: 100, threadId: 99 },
    },
  );
  const message = {
    target: { chatId: 100, threadId: 99 },
    messageId: 8,
    text: "Review",
  };
  assert.deepEqual(
    await handle({
      kind: "follower.routeAgentMessage",
      requestId: "route",
      instanceId: "inst-a",
      registrationGeneration: "generation-a",
      message,
      sentAtMs: 3000,
    }),
    { kind: "bus.ack", requestId: "route", ok: true },
  );
  assert.deepEqual(routed, [{ follower: "inst-a", message }]);
  assert.deepEqual(
    await handle({
      kind: "follower.routeAgentMessage",
      requestId: "stale",
      instanceId: "inst-a",
      registrationGeneration: "old",
      message,
      sentAtMs: 4000,
    }),
    {
      kind: "bus.ack",
      requestId: "stale",
      ok: false,
      message: "Stale Telegram bus follower registration generation.",
    },
  );
  assert.equal(routed.length, 1);
});

test("Bus leader authorizes scoped follower API calls", async () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "inst-a",
    connectedAtMs: 1000,
    registrationGeneration: "generation-a",
    target: { chatId: 100, threadId: 42 },
  });
  const calls: unknown[] = [];
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    authorizeFollowerApiCall({ follower, method, args }) {
      const body = args[1] as Record<string, unknown> | undefined;
      return (
        follower.target?.chatId === 100 &&
        body?.chat_id === 100 &&
        body?.message_thread_id === 42 &&
        (
          (method === "call" && args[0] === "sendMessage") ||
          (method === "callMultipart" && args[0] === "sendVoice")
        )
      );
    },
    callApi(method, args) {
      calls.push({ method, args });
      return { ok: true };
    },
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.callApi",
      requestId: "inst-a:allowed",
      instanceId: "inst-a",
      registrationGeneration: "generation-a",
      method: "call",
      args: ["sendMessage", { chat_id: 100, message_thread_id: 42 }],
      sentAtMs: 2000,
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:allowed",
      ok: true,
      result: { ok: true },
    },
  );
  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.callApi",
      requestId: "inst-a:voice",
      instanceId: "inst-a",
      registrationGeneration: "generation-a",
      method: "callMultipart",
      args: [
        "sendVoice",
        { chat_id: 100, message_thread_id: 42 },
        "voice",
        "C:\\Temp\\voice output.ogg",
        "voice output.ogg",
      ],
      sentAtMs: 2500,
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:voice",
      ok: true,
      result: { ok: true },
    },
  );
  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.callApi",
      requestId: "inst-a:denied",
      instanceId: "inst-a",
      registrationGeneration: "generation-a",
      method: "call",
      args: ["deleteMessage", { chat_id: 999 }],
      sentAtMs: 3000,
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:denied",
      ok: false,
      message: "Telegram bus API call is not allowed for this follower.",
      error: { code: "follower-api-not-allowed", method: "deleteMessage" },
    },
  );
  assert.deepEqual(calls, [
    {
      method: "call",
      args: ["sendMessage", { chat_id: 100, message_thread_id: 42 }],
    },
    {
      method: "callMultipart",
      args: [
        "sendVoice",
        { chat_id: 100, message_thread_id: 42 },
        "voice",
        "C:\\Temp\\voice output.ogg",
        "voice output.ogg",
      ],
    },
  ]);
});

test("Bus leader assembly wires provisioners, reconciliation, API, and runtime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-leader-assembly-"));
  const socketPath = join(dir, "bus.sock");
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  const events: string[] = [];
  let syncState = {};
  const runtime = createTelegramBusLeaderRuntimeAssembly({
    runtime: {
      socketPath,
      followerRegistry: createTelegramBusFollowerRegistry(),
      protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY,
      startPolling: () => {
        events.push("poll-start");
      },
      stopPolling: () => {
        events.push("poll-stop");
      },
    },
    getAllowedUserId: () => undefined,
    instanceId: "leader-a",
    topicTargetStore: store,
    callApi: async <TResponse>() => ({ ok: true }) as TResponse,
    callMultipart: async () => ({ ok: true }),
    downloadFile: async () => undefined,
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    setLeaderTarget: () => undefined,
    recordRuntimeEvent: () => undefined,
  });
  try {
    await runtime.startPolling("ctx");
    await runtime.stopPolling();
    assert.deepEqual(events, ["poll-start", "poll-stop"]);
  } finally {
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Leader assembly holds chat admission through leader target provisioning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-leader-admission-"));
  const socketPath = join(dir, "bus.sock");
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  const admission = createTelegramWorkspaceAdmissionLedger({
    path: join(dir, "workspace-admission.json"),
    profileKey: "profile:bus",
    owner: {
      processId: process.pid,
      processBirthId: `${process.pid}:bus-admission-test`,
    },
    getProcessLiveness: () => "alive",
  });
  let observedAdmission = false;
  let createdTitle: unknown;
  let displayEdits = 0;
  const runtime = createTelegramBusLeaderRuntimeAssembly({
    runtime: {
      socketPath,
      followerRegistry: createTelegramBusFollowerRegistry(),
      protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY,
      startPolling() {},
      stopPolling() {},
    },
    getAllowedUserId: () => 7,
    instanceId: "leader-admitted",
    getCwd: () => "/repo/extensions",
    getCurrentLeaderEpoch: () => 1,
    getThreadDisplayMode: () => "directories",
    topicTargetStore: store,
    getWorkspaceAdmission: () => admission,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      if (method === "createForumTopic") {
        createdTitle = body.name;
        const lease = admission.read().leases[0];
        observedAdmission =
          lease?.operationKind === "workspace.provision-leader" &&
          lease.scope.kind === "chat" &&
          lease.scope.chatId === 7;
        const fence = admission.acquireRetirementFence({
          operationId: "leader-provision-race-fence",
          retirementIntentId: "leader-provision-race-intent",
          bindingKey: "leader-provision-race-binding",
          slot: "A",
          target: { chatId: 7, threadId: 42 },
          leaderEpoch: 1,
          retirementRequestedAtMs: 1,
        });
        assert.deepEqual(fence, { kind: "blocked", reason: "admission-active" });
        return { message_thread_id: 42 } as TResponse;
      }
      if (method === "editForumTopic") displayEdits++;
      if (method === "sendMessage") {
        assert.equal(body.text, "<b>📡 Instance <i>extensions</i> connected.</b>");
      }
      return true as TResponse;
    },
    callMultipart: async () => true,
    downloadFile: async () => undefined,
    getSyncState: () => ({}),
    setSyncState() {},
    setLeaderTarget() {},
    recordRuntimeEvent() {},
  });
  try {
    await runtime.startPolling("ctx");
    assert.equal(observedAdmission, true);
    assert.equal(createdTitle, "extensions");
    assert.equal(store.getWorkspaceBinding("/repo/extensions")?.displayTitle,
      "extensions");
    assert.deepEqual(await runtime.reconcileThreadDisplay?.(), { changed: 0 });
    assert.equal(displayEdits, 0);
    await assert.rejects(
      runtime.renameLeaderThreadAdmitted(
        "WrongTarget",
        { chatId: 7, threadId: 99 },
      ),
      /target changed/,
    );
    assert.equal(displayEdits, 0);
    await runtime.runWorkspaceOperation!(
      {
        operationId: "route-name-command",
        operationKind: "workspace.route-unbound-thread",
        scopes: [{ kind: "profile" }],
      },
      async () => {
        assert.equal(
          admission.read().leases.some(
            (lease) => lease.operationKind === "workspace.route-unbound-thread",
          ),
          true,
        );
        await runtime.renameLeaderThreadAdmitted(
          "Azure",
          { chatId: 7, threadId: 42 },
        );
      },
    );
    assert.equal(store.getWorkspaceBinding("/repo/extensions")?.manualThreadName, "Azure");
    assert.deepEqual(admission.read().leases, []);
  } finally {
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Leader assembly blocks Workspace mutations behind a retained retirement fence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-leader-mutation-fence-"));
  const admission = createTelegramWorkspaceAdmissionLedger({
    path: join(dir, "workspace-admission.json"),
    profileKey: "profile:bus-mutations",
    owner: {
      processId: process.pid,
      processBirthId: `${process.pid}:bus-mutation-test`,
    },
    getProcessLiveness: () => "alive",
  });
  const fence = admission.acquireRetirementFence({
    operationId: "retained-mutation-fence",
    retirementIntentId: "retained-mutation-intent",
    bindingKey: "retained-mutation-binding",
    slot: "A",
    target: { chatId: 7, threadId: 42 },
    leaderEpoch: 1,
    retirementRequestedAtMs: 1,
  });
  assert.equal(fence.kind, "acquired");
  let mode: TelegramThreadDisplayMode = "names";
  let mutationRan = false;
  let apiCalls = 0;
  let stateReads = 0;
  const topicTargetStore = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  const list = topicTargetStore.list.bind(topicTargetStore);
  topicTargetStore.list = () => { stateReads++; return list(); };
  const runtime = createTelegramBusLeaderRuntimeAssembly({
    runtime: {
      socketPath: join(dir, "bus.sock"),
      followerRegistry: createTelegramBusFollowerRegistry(),
      protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY,
      startPolling() {},
      stopPolling() {},
    },
    getAllowedUserId: () => 7,
    instanceId: "leader-fenced",
    getTelegramProfile: () => "default",
    getThreadDisplayMode: () => mode,
    async persistThreadDisplayMode(nextMode) {
      mode = nextMode;
    },
    getCurrentLeaderEpoch: () => 1,
    topicTargetStore,
    getWorkspaceAdmission: () => admission,
    async callApi<TResponse>() {
      apiCalls++;
      return true as TResponse;
    },
    callMultipart: async () => true,
    downloadFile: async () => undefined,
    getSyncState: () => ({}),
    setSyncState() {},
    setLeaderTarget() {},
    recordRuntimeEvent() {},
  });
  try {
    await assert.rejects(
      runtime.runWorkspaceOperation!(
        {
          operationId: "blocked-generic-mutation",
          operationKind: "workspace.test-mutation",
          scopes: [{ kind: "profile" }],
        },
        async () => {
          mutationRan = true;
        },
      ),
      /blocked by retirement/u,
    );
    await assert.rejects(
      runtime.renameLeaderThread!("Renamed"),
      /blocked by retirement/u,
    );
    assert.equal(stateReads, 0, "retirement admission refuses before reading Thread state");
    await assert.rejects(
      runtime.reconcileThreadDisplay!(),
      /blocked by retirement/u,
    );
    await assert.rejects(
      runtime.setThreadDisplayMode!("letters"),
      /blocked by retirement/u,
    );
    assert.equal(mutationRan, false);
    assert.equal(mode, "names");
    assert.equal(apiCalls, 0);
  } finally {
    if (fence.kind === "acquired") {
      admission.releaseUnissuedRetirementFence(fence.fence);
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Leader assembly serializes follower provisioning through its shared Workspace gate", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-workspace-gate-"));
  const socketPath = join(dir, "bus.sock");
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  const startedAt = performance.now(), stages: Array<{ stage: string; elapsedMs: number }> = [];
  const trace = (stage: string) => {
    if (stages.length < 24) stages.push({ stage, elapsedMs: Math.round(performance.now() - startedAt) });
  };
  const persist = store.persist.bind(store);
  store.persist = async () => {
    trace("persist-start");
    try { await persist(); } finally { trace("persist-end"); }
  };
  let allowedUserId: number | undefined;
  const calls: string[] = [];
  const runtime = createTelegramBusLeaderRuntimeAssembly({
    runtime: { socketPath, followerRegistry: createTelegramBusFollowerRegistry(),
      protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY, startPolling() {}, stopPolling() {} },
    getAllowedUserId: () => allowedUserId, instanceId: "leader", topicTargetStore: store,
    captureWorkspaceExternalProtection: () => ({ liveOwner: "clear",
      acceptedWork: "clear", deliveryAuthority: "unknown" }),
    async callApi<TResponse>(method: string) {
      calls.push(method);
      return (method === "createForumTopic" ? { message_thread_id: 42 } : { ok: true }) as TResponse;
    },
    callMultipart: async () => true, downloadFile: async () => undefined,
    getSyncState: () => ({}), setSyncState() {}, setLeaderTarget() {}, recordRuntimeEvent() {},
  });
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  try {
    trace("start-polling");
    await runtime.startPolling("ctx");
    trace("polling-ready");
    assert.equal(typeof runtime.captureWorkspaceExternalProtection, "function");
    allowedUserId = 7;
    const blocker = runtime.runWorkspaceOperation!({
      operationId: "test-blocker",
      operationKind: "workspace.test-blocker",
      scopes: [{ kind: "profile" }],
    }, async () => {
      entered?.();
      await held;
    });
    await started;
    trace("blocker-entered");
    const registration = sendTelegramBusLocalEnvelope({ socketPath, envelope: {
      kind: "follower.register", requestId: "follower:1",
      registration: { instanceId: "follower", registrationGeneration: "follower:1",
        cwd: "/repo", sessionId: "session-a", connectedAtMs: 1,
        protocol: TEST_BUS_PROTOCOL_IDENTITY },
    } });
    trace("registration-started");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.length, 0);
    trace("release-blocker");
    release?.();
    await blocker;
    trace("blocker-finished");
    const response = await registration;
    trace("registration-acknowledged");
    assert.ok(response?.kind === "bus.ack");
    assert.equal(response.ok, true);
    assert.equal(calls.includes("createForumTopic"), true);
  } catch (error) {
    throw new Error(`Workspace gate fixture failed. stages=${JSON.stringify(stages)}`, { cause: error });
  } finally {
    release?.();
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
    t.diagnostic(`Workspace gate fixture stages=${JSON.stringify(stages)}`);
  }
});

test("Workspace rotation integrates leader and follower allocation without bypassing admission", async (t) => {
  for (const scenario of ["leader", "followers", "already-absent", "protected", "unknown-delete"] as const) {
    await t.test(scenario, async () => {
      const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "test", capabilities: [...TEST_BUS_PROTOCOL_IDENTITY.capabilities, TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE] });
      const dir = mkdtempSync(join(tmpdir(), "pi-telegram-rotation-"));
      const socketPath = join(dir, "bus.sock");
      const admission = createTelegramWorkspaceAdmissionLedger({
        path: join(dir, "admission.json"), profileKey: "default",
        owner: { processId: process.pid, processBirthId: `${process.pid}:rotation` },
        getProcessLiveness: () => "alive",
      });
      const operations = createTelegramWorkspaceOperationRuntime({ getWorkspaceAdmission: () => admission });
      const store = createTelegramTopicTargetStore({ path: join(dir, "state.json"),
        getExternalReservedSlots: admission.listReservedSlots });
      for (let index = 0; index < 26; index++) {
        store.upsertWorkspaceBinding({
          ...createTelegramWorkspaceBindingIdentity(`/old/${index}`, 0, "old-session")!,
          target: { chatId: 7, threadId: 100 + index }, slot: String.fromCharCode(65 + index),
          inactiveSinceMs: index === 1 ? 1 : index + 100, updatedAtMs: 200,
          threadName: `Workspace${index}`, displayTitle: String.fromCharCode(65 + index),
          journalBindingKeys: [], journalBindingsComplete: true,
        });
      }
      await store.persist();
      let allowedUserId = scenario === "leader" ? 7 : undefined;
      let nextTarget = 1000;
      const effects: string[] = [];
      const runtime = createTelegramBusLeaderRuntimeAssembly({
        runtime: { socketPath, followerRegistry: createTelegramBusFollowerRegistry(),
          protocolIdentity: protocol, startPolling() {}, stopPolling() {} },
        getAllowedUserId: () => allowedUserId, instanceId: "leader",
        getCwd: () => scenario === "leader" ? "/fresh-leader" : undefined,
        getSessionId: () => "fresh-session",
        topicTargetStore: store, getCurrentLeaderEpoch: () => 1,
        ...(scenario === "protected" ? { getThreadDisplayMode: () => "letters" as const } : {}),
        getWorkspaceAdmission: () => admission, runWorkspaceOperation: operations.run,
        captureWorkspaceExternalProtection: () => ({ liveOwner: "clear",
          acceptedWork: scenario === "protected" ? "protected" : "clear", deliveryAuthority: "clear" }),
        workspaceRotation: {
          getAdmission: () => admission, runExclusive: operations.runExclusive,
          async deleteThread(authorize) {
            const target = authorize();
            assert.equal(admission.read().fence?.phase, "deletion-issued");
            assert.deepEqual(admission.read().leases, []);
            assert.equal(store.listWorkspaceBindings().length, 26);
            effects.push(`delete:${target.threadId}`);
            if (scenario === "unknown-delete") throw new Error("lost delete acknowledgement");
            if (scenario === "already-absent") throw Object.assign(
              new Error("Bad Request: message thread not found"), { status: 400, requestTarget: target },
            );
          },
        },
        async callApi<TResponse>(method: string, body: Record<string, unknown>) {
          if (method === "editForumTopic" && Number(body.message_thread_id) < 126) {
            assert.ok(admission.read().leases.length > 0, "display repair uses fresh profile admission");
            effects.push(`edit:${body.message_thread_id}:${body.name}`);
          }
          if (method === "createForumTopic") {
            assert.equal(admission.read().fence, undefined);
            assert.ok(admission.read().leases.length > 0);
            effects.push("create");
            return { message_thread_id: nextTarget++ } as TResponse;
          }
          return true as TResponse;
        },
        callMultipart: async () => true, downloadFile: async () => undefined,
        getSyncState: () => ({}), setSyncState() {}, setLeaderTarget() {}, recordRuntimeEvent() {},
      });
      const register = (instanceId: string, restore = false, cwd = `/fresh/${instanceId}`, sessionId = "fresh-session") =>
        sendTelegramBusLocalEnvelope({ socketPath, envelope: {
          kind: restore ? "follower.restoreWorkspace" : "follower.register", requestId: `register:${instanceId}`,
          registration: { instanceId, cwd, sessionId, registrationGeneration: `${instanceId}:1`,
            connectedAtMs: 1, protocol },
        } });
      try {
        await runtime.startPolling("ctx");
        allowedUserId = 7;
        if (scenario === "leader") {
          assert.deepEqual(effects, ["delete:101", "create"]);
          assert.equal(store.getWorkspaceBinding("/fresh-leader", "a", "fresh-session")?.slot, "B");
        } else {
          const restore = await register("startup", true);
          assert.equal(restore?.kind === "bus.ack" && restore.ok, false);
          assert.deepEqual(effects, []);
          const reuse = await register("reuse", false, "/old/25", "old-session");
          assert.equal(reuse?.kind === "bus.ack" && reuse.ok, true, JSON.stringify(reuse));
          assert.deepEqual(effects, []);
          const responses = await Promise.all([register("first"), register("second")]);
          if (scenario === "followers" || scenario === "already-absent" || scenario === "protected") {
            assert.ok(responses.every((response) => response?.kind === "bus.ack" && response.ok));
            // Fully protected capacity deletes nothing: the oldest letters are reassigned as metadata.
            assert.deepEqual(effects, scenario === "protected" ? ["edit:101:Workspace1", "create", "edit:100:Workspace0", "create"] : ["delete:101", "create", "delete:100", "create"]);
            assert.equal(store.getWorkspaceBinding("/fresh/first", "a", "fresh-session")?.slot, "B");
            assert.equal(store.getWorkspaceBinding("/fresh/second", "a", "fresh-session")?.slot, "A");
            if (scenario === "protected") {
              assert.equal(store.getWorkspaceBinding("/old/1", "a", "old-session")?.slot, undefined);
              assert.equal(store.getWorkspaceBinding("/old/0", "a", "old-session")?.slot, undefined);
              assert.equal(store.getWorkspaceBinding("/old/1", "a", "old-session")?.displayTitle, "Workspace1");
              assert.equal(store.getWorkspaceBinding("/old/0", "a", "old-session")?.displayTitle, "Workspace0");
              assert.equal(admission.read().fence, undefined);
            }
          } else {
            assert.ok(responses.every((response) => response?.kind === "bus.ack" && !response.ok));
            assert.deepEqual(effects, ["delete:101"]);
            assert.equal(store.getWorkspaceBinding("/old/1", "a", "old-session")?.slot, "B");
            assert.equal(admission.read().fence?.phase, "deletion-issued");
          }
        }
        assert.equal(store.listWorkspaceBindings().length, scenario === "protected" ? 28 : 26);
      } finally {
        await runtime.stopPolling();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

test("Follower provisioning without rotation reports pressure without deleting or reusing retained slots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-pressure-disabled-"));
  const socketPath = join(dir, "bus.sock");
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  for (const [index, slot] of Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ").entries()) {
    store.upsertWorkspaceBinding({
      ...createTelegramWorkspaceBindingIdentity(`/old/${index}`)!,
      target: { chatId: 7, threadId: 100 + index }, slot,
      inactiveSinceMs: index + 1, updatedAtMs: index + 1,
      journalBindingKeys: [], journalBindingsComplete: true,
    });
  }
  let allowedUserId: number | undefined;
  const calls: string[] = [];
  const runtime = createTelegramBusLeaderRuntimeAssembly({
    runtime: { socketPath, followerRegistry: createTelegramBusFollowerRegistry(),
      protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY, startPolling() {}, stopPolling() {} },
    getAllowedUserId: () => allowedUserId, instanceId: "leader", topicTargetStore: store,
    getCurrentLeaderEpoch: () => 1, getTelegramProfile: () => undefined,
    captureWorkspaceExternalProtection: () => ({ liveOwner: "clear",
      acceptedWork: "clear", deliveryAuthority: "clear" }),
    async callApi<TResponse>(method: string) { calls.push(method); return true as TResponse; },
    callMultipart: async () => true, downloadFile: async () => undefined,
    getSyncState: () => ({}), setSyncState() {}, setLeaderTarget() {}, recordRuntimeEvent() {},
  });
  try {
    await runtime.startPolling("ctx");
    allowedUserId = 7;
    for (const [instanceId, cwd] of [["fresh", "/fresh"], ["legacy", undefined]] as const) {
      const response = await sendTelegramBusLocalEnvelope({ socketPath, envelope: {
        kind: "follower.register", requestId: `pressure:${instanceId}`,
        registration: { instanceId, registrationGeneration: `${instanceId}:1`,
          ...(cwd ? { cwd, sessionId: "session-a" } : {}), connectedAtMs: 1,
          protocol: TEST_BUS_PROTOCOL_IDENTITY },
      } });
      assert.ok(response?.kind === "bus.ack");
      assert.equal(response.ok, false);
      assert.equal(response.message, "Telegram Workspace slot reservation is unavailable.");
    }
    const carried = await sendTelegramBusLocalEnvelope({ socketPath, envelope: {
      kind: "follower.register", requestId: "pressure:carried",
      registration: { instanceId: "carried", registrationGeneration: "carried:1",
        target: { chatId: 7, threadId: 900 }, slot: "A",
        connectedAtMs: 1, protocol: TEST_BUS_PROTOCOL_IDENTITY },
    } });
    assert.ok(carried?.kind === "bus.ack");
    assert.equal(carried.ok, false);
    assert.equal(carried.message, "Telegram Workspace slot reservation is unavailable.");
    assert.deepEqual(calls, []);
    assert.equal(store.listWorkspaceBindings().length, 26);
    assert.equal(store.getWorkspaceBinding("/old/0")?.slot, "A");
    assert.equal(store.getWorkspaceBinding("/fresh"), undefined);
    assert.deepEqual(store.listWorkspaceRetirementIntents(), []);
  } finally {
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Leader assembly applies display titles and publishes them through heartbeat ACKs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-display-assembly-"));
  const socketPath = join(dir, "bus.sock");
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  const registry = createTelegramBusFollowerRegistry();
  for (const [cwd, instanceId, slot, threadName, threadId] of [
    ["/leader", "leader", "A", "Anchor", 41],
    ["/follower", "follower", "B", "Beacon", 42],
  ] as const) {
    store.upsertWorkspaceBinding({
      ...createTelegramWorkspaceBindingIdentity(cwd)!,
      slot, threadName, target: { chatId: 7, threadId }, updatedAtMs: 1,
    });
    if (instanceId === "leader") store.upsert({
      profileKey: "cwd:/leader", owner: { kind: "leader", cwd, instanceId },
      instanceId, slot, threadName, target: { chatId: 7, threadId },
      status: "active", createdAtMs: 1, updatedAtMs: 1,
    });
  }
  registry.register({
    instanceId: "follower", target: { chatId: 7, threadId: 42 },
    registrationGeneration: "follower:1", connectedAtMs: Date.now(),
    protocol: createTelegramBusProtocolIdentity({ runtimeBuild: "test",
      capabilities: [...TEST_BUS_PROTOCOL_IDENTITY.capabilities, TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE] }),
    threadName: "Beacon", slot: "B",
  });
  const titles: unknown[] = [];
  let displayMode: TelegramThreadDisplayMode = "letters";
  const runtime = createTelegramBusLeaderRuntimeAssembly({
    runtime: { socketPath, followerRegistry: registry, protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY,
      startPolling() {}, stopPolling() {} },
    getAllowedUserId: () => undefined,
    instanceId: "leader",
    getCurrentLeaderEpoch: () => 2,
    getThreadDisplayMode: () => displayMode,
    async persistThreadDisplayMode(mode, isCurrent) {
      assert.equal(isCurrent(), true);
      displayMode = mode;
    },
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      assert.equal(method, "editForumTopic");
      titles.push(body.name);
      return true as TResponse;
    },
    callMultipart: async () => true,
    downloadFile: async () => undefined,
    getSyncState: () => ({}), setSyncState() {}, setLeaderTarget() {}, recordRuntimeEvent() {},
  });
  try {
    await store.persist();
    await runtime.startPolling("ctx");
    await runtime.reconcileThreadDisplay?.();
    assert.deepEqual(titles, ["A", "B"]);
    const response = await sendTelegramBusLocalEnvelope({ socketPath, envelope: {
      kind: "follower.heartbeat", requestId: "follower:2", instanceId: "follower",
      registrationGeneration: "follower:1", sentAtMs: Date.now(),
    } });
    assert.ok(response?.kind === "bus.ack");
    assert.equal((response.result as { displayTitle: string }).displayTitle, "B");
    assert.equal(store.getWorkspaceBinding("/follower")?.threadName, "Beacon");
    assert.equal(registry.get("follower")?.threadName, "Beacon");
    await runtime.setThreadDisplayMode?.("names");
    assert.deepEqual(titles, ["A", "B", "Anchor", "Beacon"]);
    registry.register({ ...registry.get("follower")!, protocol: TEST_BUS_PROTOCOL_IDENTITY });
    await assert.rejects(runtime.setThreadDisplayMode!("letters"), /all connected followers/);
    assert.equal(displayMode, "names");
    await runtime.setThreadDisplayMode?.("names");
  } finally {
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const drift of ["current", "recipient", "epoch", "operator", "profile", "session", "slot", "owner", "binding", "admission", "persistence"] as const) {
  test(`Guarded leader manual rename retains exact recipient authority (${drift})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-telegram-guarded-leader-name-"));
    const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
    const target = { chatId: 7, threadId: 41 };
    const record = { profileKey: "cwd:/repo", owner: { kind: "leader" as const, cwd: "/repo", instanceId: "leader" },
      instanceId: "leader", target, slot: "A", threadName: "Atlas", status: "active" as const, createdAtMs: 1, updatedAtMs: 1 };
    const binding = { ...createTelegramWorkspaceBindingIdentity("/repo", 0, "session")!, target, slot: "A", threadName: "Atlas", updatedAtMs: 1 };
    store.upsert(record); store.upsertWorkspaceBinding(binding);
    store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/repo", 1, "other-session")!,
      target: { chatId: 7, threadId: 42 }, slot: "B", threadName: "Briar", updatedAtMs: 1 });
    await store.persist();
    const unrelated = store.listWorkspaceBindings().find(value => value.sessionId === "other-session");
    let current = true, epoch = 1, user = 7, profile = "default", edits = 0, persistence = 0;
    const persist = store.persist.bind(store);
    const publishName = store.renameByTargetAndPersist.bind(store);
    store.renameByTargetAndPersist = async (...args) => {
      persistence++;
      if (drift === "persistence") current = false;
      return publishName(...args);
    };
    const runtime = createTelegramBusLeaderRuntimeAssembly({
      runtime: { socketPath: join(dir, "bus.sock"), followerRegistry: createTelegramBusFollowerRegistry(),
        protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY, startPolling() {}, stopPolling() {} },
      getAllowedUserId: () => user, getTelegramProfile: () => profile,
      instanceId: "leader", getCurrentLeaderEpoch: () => epoch, topicTargetStore: store,
      runWorkspaceOperation: async (_input, operation) => {
        if (drift === "admission") epoch++;
        return operation();
      },
      async callApi<TResponse>(_method: string, body: Record<string, unknown>, options?: TelegramApiCallOptions) {
        edits++;
        assert.deepEqual(body, { chat_id: 7, message_thread_id: 41, name: "Azure" });
        assert.equal(typeof options?.assertAuthority, "function");
        options!.assertAuthority!();
        if (drift === "recipient") current = false;
        if (drift === "epoch") epoch++;
        if (drift === "operator") user++;
        if (drift === "profile") profile = "other";
        if (drift === "session" || drift === "binding") {
          store.upsertWorkspaceBinding({ ...binding, target: { chatId: 7, threadId: 99 } });
          store.upsertWorkspaceBinding({ ...binding,
            ...createTelegramWorkspaceBindingIdentity("/repo", drift === "binding" ? 2 : 0,
              drift === "session" ? "replacement" : "session")!,
          });
        }
        if (drift === "slot") store.upsert({ ...record, slot: "C" });
        if (drift === "owner") store.upsert({ ...record, owner: { ...record.owner, cwd: "/replacement" } });
        return true as TResponse;
      },
      callMultipart: async () => true, downloadFile: async () => undefined,
      getSyncState: () => ({}), setSyncState() {}, setLeaderTarget() {}, recordRuntimeEvent() {},
    });
    try {
      const pending = drift === "admission" ? runtime.renameLeaderThread!("Azure")
        : runtime.renameLeaderThreadAdmitted("Azure", target, () => {
          if (!current) throw new Error("Recipient authority lost.");
        });
      if (drift === "current") {
        const renamed = await pending;
        assert.equal(renamed.manualThreadName, "Azure");
        const reopened = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
        await reopened.load();
        assert.equal(reopened.getWorkspaceBindingByTarget(target, "session")?.manualThreadName, "Azure");
      } else await assert.rejects(pending, /authority|changed|ownership/);
      assert.equal(edits, drift === "admission" ? 0 : 1);
      assert.equal(persistence, drift === "current" || drift === "persistence" ? 1 : 0);
      assert.deepEqual(store.listWorkspaceBindings().find(value => value.sessionId === "other-session"), unrelated);
      if (drift === "persistence") {
        store.setBotState({ threadMode: "enabled" });
        await persist();
        const reopened = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
        await reopened.load();
        assert.equal(reopened.getWorkspaceBindingByTarget(target, "session")?.manualThreadName, undefined,
          "An ordinary persist cannot borrow refused manual-name publication authority");
        assert.equal(reopened.getActiveByInstanceId("leader")?.manualThreadName, undefined);
        assert.equal(reopened.getBotState()?.threadMode, "enabled", "Unrelated local work still publishes");
      }
    } finally {
      await runtime.stopPolling();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const boundary of ["current", "response-loss", "binding-renewal"] as const) {
  test(`Guarded command rename binding reaches native staged leader publication (${boundary})`, async () => {
    await withWorkspaceRestoreFixture(async f => {
      const command = createTelegramThreadDisplayNameRenameBinding();
      let current = true, edits = 0, publications = 0;
      const publish = f.threads.renameByTargetAndPersist.bind(f.threads);
      f.threads.renameByTargetAndPersist = async (...args) => {
        publications++;
        if (boundary === "binding-renewal") command.bind(rename);
        return publish(...args);
      };
      const runtime = createTelegramBusLeaderRuntimeAssembly({
        runtime: { socketPath: join(f.path, "..", "bus.sock"), followerRegistry: createTelegramBusFollowerRegistry(),
          protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY, startPolling() {}, stopPolling() {} },
        getAllowedUserId: () => 7, getTelegramProfile: () => "default",
        instanceId: "old", getCurrentLeaderEpoch: () => 1, topicTargetStore: f.threads,
        async callApi<TResponse>(_method: string, body: Record<string, unknown>, options?: TelegramApiCallOptions) {
          edits++;
          assert.deepEqual(body, { chat_id: 7, message_thread_id: 10, name: "Azure" });
          options?.assertAuthority?.();
          await Promise.resolve();
          if (boundary === "response-loss") current = false;
          return true as TResponse;
        },
        callMultipart: async () => true, downloadFile: async () => undefined,
        getSyncState: () => ({}), setSyncState() {}, setLeaderTarget() {}, recordRuntimeEvent() {},
      });
      const rename: Parameters<typeof command.bind>[0] = async (target, name, options) => {
        if (typeof target.threadId !== "number") return { ok: false };
        const result = await runtime.renameLeaderThreadAdmitted(name, { chatId: target.chatId, threadId: target.threadId }, options?.assertAuthority);
        return { ok: true, threadName: result.manualThreadName };
      };
      command.bind(rename);
      try {
        const pending = command.rename({ chatId: 7, threadId: 10 }, "Azure", {
          assertAuthority() { if (!current) throw new Error("Recipient authority lost."); },
        });
        if (boundary === "current") assert.deepEqual(await pending, { ok: true, threadName: "Azure" });
        else await assert.rejects(pending, /authority|binding.*changed/i);
        f.threads.setBotState({ threadMode: "enabled" });
        await f.threads.persist();
        const reopened = createTelegramTopicTargetStore({ path: f.path });
        await reopened.load();
        assert.equal(reopened.getWorkspaceBindingByTarget({ chatId: 7, threadId: 10 }, "session")?.manualThreadName,
          boundary === "current" ? "Azure" : "My workspace",
          "A later ordinary persist cannot borrow a refused guarded command candidate");
        assert.equal(edits, 1);
        assert.equal(publications, boundary === "response-loss" ? 0 : 1);
      } finally { await runtime.stopPolling(); }
    });
  });
}

for (const layout of ["standalone", "consolidated"] as const) {
  for (const boundary of ["current", "entry-loss", "admission-loss", "api-entry-loss", "response-loss", "epoch", "profile", "operator", "owner", "binding", "mode", "newer-name", "publication-loss", "post-publication-loss", "late-name", "lost-api", "lost-publication", "captured-ports"] as const) {
    test(`Guarded leader reset composes captured API and staged publication (${layout}, ${boundary})`, async () => {
      await withWorkspaceRestoreFixture(async fixture => {
        const dir = join(fixture.path, "..");
        const rootPath = join(dir, "consolidated.json");
        const owner = createTelegramLockRuntime({ statePath: rootPath, key: () => "default", pid: 10,
          instanceId: "owner", runtimeGeneration: 1, isProcessAlive: () => true });
        owner.acquire({ cwd: "/repo" });
        const f = { dir, consolidated: {
          captureAuthority() {
            const epoch = owner.getOwnedLeaderEpoch();
            return epoch === undefined ? undefined : () => owner.owns() && owner.getOwnedLeaderEpoch() === epoch;
          },
          publishIfOwned: owner.publishStateSectionIfOwned!,
        } };
        const path = layout === "consolidated" ? rootPath : join(f.dir, "reset.json");
        const store = createTelegramTopicTargetStore({ path, telegramProfile: "default",
          ...(layout === "consolidated" ? { consolidated: f.consolidated } : {}) });
        await store.load();
        const target = { chatId: 7, threadId: 41 };
        const record = { owner: { kind: "leader" as const, cwd: "/repo", instanceId: "leader" }, profileKey: "cwd:/repo",
          instanceId: "leader", target, slot: "A", threadName: "Anchor", status: "active" as const, createdAtMs: 1, updatedAtMs: 1 };
        const binding = { ...createTelegramWorkspaceBindingIdentity("/repo", 0, "session")!,
          target, slot: "A", threadName: "Anchor", updatedAtMs: 1 };
        store.upsert(record); store.upsertWorkspaceBinding(binding); store.renameByTarget(target, "Retained");
        store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/other", 0, "other-session")!,
          target: { chatId: 7, threadId: 42 }, slot: "B", threadName: "Beacon", updatedAtMs: 1 });
        await store.persist();
        const neighbor = store.getWorkspaceBindingByTarget({ chatId: 7, threadId: 42 }, "other-session");
        let current = boundary !== "entry-loss", epoch = 1, user = 7, profile = "default";
        let mode: TelegramThreadDisplayMode = "letters";
        let edits = 0, publications = 0, admissions = 0;
        const persist = store.persist.bind(store), publish = store.clearManualNameByTargetAndPersist.bind(store);
        store.clearManualNameByTargetAndPersist = async (...args) => {
          publications++;
          if (boundary === "publication-loss") current = false;
          const result = await publish(...args);
          if (boundary === "post-publication-loss") current = false;
          if (boundary === "late-name") store.renameByTarget({ chatId: 7, threadId: 41 }, "Newer");
          if (boundary === "lost-publication") throw new Error("Reset publication reply lost");
          return result;
        };
        const deps: Parameters<typeof createTelegramBusLeaderRuntimeAssembly>[0] = {
          runtime: { socketPath: join(f.dir, "bus.sock"), followerRegistry: createTelegramBusFollowerRegistry(),
            protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY, startPolling() {}, stopPolling() {} },
          instanceId: "leader", getAllowedUserId: () => user, getTelegramProfile: () => profile,
          getCurrentLeaderEpoch: () => epoch, getThreadDisplayMode: () => mode, topicTargetStore: store,
          runWorkspaceOperation: async (_input, operation) => {
            admissions++;
            if (boundary === "admission-loss") current = false;
            if (boundary === "captured-ports") {
              target.threadId = 99;
              deps.callApi = async () => assert.fail("Replacement API cannot lend authority");
              store.clearManualNameByTargetAndPersist = async () => assert.fail("Replacement publication cannot lend authority");
            }
            return operation();
          },
          async callApi<TResponse>(method: string, body: Record<string, unknown>, options?: TelegramApiCallOptions) {
            edits++;
            assert.equal(method, "editForumTopic");
            assert.deepEqual(body, { chat_id: 7, message_thread_id: 41, name: "A" });
            assert.equal(typeof options?.assertAuthority, "function");
            if (boundary === "api-entry-loss") current = false;
            options!.assertAuthority!();
            if (boundary === "response-loss") current = false;
            if (boundary === "epoch") epoch++;
            if (boundary === "profile") profile = "other";
            if (boundary === "operator") user++;
            if (boundary === "owner") store.upsert({ ...store.getActiveByInstanceId("leader")!, owner: { ...record.owner, cwd: "/replacement" } });
            if (boundary === "binding") store.upsertWorkspaceBinding({ ...binding, target: { chatId: 7, threadId: 99 } });
            if (boundary === "mode") mode = "names";
            if (boundary === "newer-name") store.renameByTarget({ chatId: 7, threadId: 41 }, "Newer");
            if (boundary === "lost-api") throw new Error("Reset API reply lost");
            return true as TResponse;
          },
          callMultipart: async () => true, downloadFile: async () => undefined,
          getSyncState: () => ({}), setSyncState() {}, setLeaderTarget() {}, recordRuntimeEvent() {},
        };
        const runtime = createTelegramBusLeaderRuntimeAssembly(deps);
        try {
          const pending = runtime.resetLeaderThreadName(target, () => { if (!current) throw new Error("Recipient authority lost"); });
          if (boundary === "current" || boundary === "captured-ports") assert.deepEqual(await pending, { threadName: "A" });
          else await assert.rejects(pending, /authority|ownership|changed|reply lost/i);
          const issued = !["entry-loss", "admission-loss"].includes(boundary);
          const committed = ["current", "captured-ports", "post-publication-loss", "late-name", "lost-publication"].includes(boundary);
          assert.equal(edits, issued ? 1 : 0);
          assert.equal(admissions, boundary === "entry-loss" ? 0 : 1);
          assert.equal(publications, committed || boundary === "publication-loss" ? 1 : 0);
          const reopen = () => createTelegramTopicTargetStore({ path, telegramProfile: "default",
            ...(layout === "consolidated" ? { consolidated: f.consolidated } : {}) });
          const canonical = reopen(); await canonical.load();
          assert.equal(canonical.getWorkspaceBindingByTarget({ chatId: 7, threadId: 41 }, "session")?.manualThreadName,
            committed ? undefined : "Retained");
          assert.deepEqual(canonical.getWorkspaceBindingByTarget({ chatId: 7, threadId: 42 }, "other-session"), neighbor);
          store.setBotState({ threadMode: "enabled" });
          await persist();
          const later = reopen(); await later.load();
          assert.equal(later.getBotState()?.threadMode, "enabled");
          assert.equal(later.getActiveByInstanceId("leader")?.manualThreadName,
            boundary === "newer-name" || boundary === "late-name" ? "Newer" : committed ? undefined : "Retained",
            "Refused reset candidates never leak into ordinary persistence or erase newer work");
          assert.deepEqual(later.getWorkspaceBindingByTarget({ chatId: 7, threadId: 42 }, "other-session"), neighbor);
        } finally { await runtime.stopPolling(); }
      });
    });
  }
}

for (const boundary of ["current", "entry", "response", "parsing", "retry-wait", "admission-fence"] as const) {
  test(`Guarded leader reset retains native admission and direct client fences (${boundary})`, async () => {
    await withWorkspaceRestoreFixture(async f => {
      const ledger = createTelegramWorkspaceAdmissionLedger({ path: join(f.path, "..", "admission.json"), profileKey: "reset",
        owner: { processId: process.pid, processBirthId: `${process.pid}:reset-birth` }, getProcessLiveness: () => "alive" });
      const originalFetch = globalThis.fetch, family = process.env.PI_TELEGRAM_NETWORK_FAMILY;
      delete process.env.PI_TELEGRAM_NETWORK_FAMILY;
      let current = boundary !== "entry", requests = 0, sleeps = 0, publications = 0;
      const publish = f.threads.clearManualNameByTargetAndPersist.bind(f.threads);
      f.threads.clearManualNameByTargetAndPersist = (...args) => {
        publications++;
        assert.equal(ledger.read().leases.length, 1, "Admission spans native store publication");
        return publish(...args);
      };
      globalThis.fetch = async (input, init) => {
        requests++;
        assert.equal(ledger.read().leases.length, 1, "Admission spans awaited HTTP");
        assert.ok(String(input).endsWith("/editForumTopic"));
        assert.deepEqual(JSON.parse(String(init?.body)), { chat_id: 7, message_thread_id: 10, name: "A" });
        if (boundary === "response") current = false;
        if (boundary === "retry-wait") return new Response(JSON.stringify({ ok: false, description: "Too Many Requests" }), { status: 429 });
        const response = new Response(JSON.stringify({ ok: true, result: true }));
        if (boundary === "parsing") response.text = async () => { current = false; return JSON.stringify({ ok: true, result: true }); };
        return response;
      };
      const client = createTelegramApiClient(() => "123:fixture");
      const direct = createTelegramBridgeApiRuntime({ client: { ...client,
        call(method, body, options) {
          assert.equal(typeof options?.assertAuthority, "function");
          return client.call(method, body, { ...options, sleep: async () => { sleeps++; current = false; } });
        } }, tempDir: "/unused", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
      const runtime = createTelegramBusLeaderRuntimeAssembly({
        runtime: { socketPath: join(f.path, "..", "bus.sock"), followerRegistry: createTelegramBusFollowerRegistry(),
          protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY, startPolling() {}, stopPolling() {} },
        getAllowedUserId: () => 7, getTelegramProfile: () => "default", getWorkspaceAdmission: () => ledger,
        instanceId: "old", getCurrentLeaderEpoch: () => 1, topicTargetStore: f.threads, callApi: direct.call,
        callMultipart: async () => true, downloadFile: async () => undefined,
        getSyncState: () => ({}), setSyncState() {}, setLeaderTarget() {}, recordRuntimeEvent() {},
      });
      try {
        if (boundary === "admission-fence") assert.equal(ledger.acquireRetirementFence({ operationId: "fence",
          retirementIntentId: "retirement", bindingKey: "unrelated", slot: "B", target: { chatId: 7, threadId: 99 },
          leaderEpoch: 1, retirementRequestedAtMs: 1 }).kind, "acquired");
        const pending = runtime.resetLeaderThreadName({ chatId: 7, threadId: 10 }, () => {
          if (!current) throw new Error("Reset recipient revoked");
        });
        if (boundary === "current") assert.deepEqual(await pending, { threadName: "A" });
        else if (boundary === "entry" || boundary === "admission-fence") await assert.rejects(pending, /revoked|fenced|retirement/i);
        else await assert.rejects(pending, { name: "TelegramApiAuthorityError", requestIssued: true });
        assert.equal(requests, boundary === "entry" || boundary === "admission-fence" ? 0 : 1);
        assert.equal(sleeps, boundary === "retry-wait" ? 1 : 0);
        assert.equal(publications, boundary === "current" ? 1 : 0);
        assert.deepEqual(ledger.read().leases, [], "Every settled path releases its exact admission");
        f.threads.setBotState({ threadMode: "enabled" }); await f.threads.persist();
        const reopened = createTelegramTopicTargetStore({ path: f.path }); await reopened.load();
        assert.equal(reopened.getWorkspaceBindingByTarget({ chatId: 7, threadId: 10 }, "session")?.manualThreadName,
          boundary === "current" ? undefined : "My workspace");
      } finally {
        globalThis.fetch = originalFetch;
        if (family === undefined) delete process.env.PI_TELEGRAM_NETWORK_FAMILY; else process.env.PI_TELEGRAM_NETWORK_FAMILY = family;
        await runtime.stopPolling();
      }
    });
  });
}

for (const boundary of ["current", "response-loss", "binding-renewal"] as const) {
  test(`Guarded command reset binding reaches admitted staged leader publication (${boundary})`, async () => {
    await withWorkspaceRestoreFixture(async f => {
      const command = createTelegramThreadDisplayNameResetBinding();
      let current = true, edits = 0, publications = 0;
      const publish = f.threads.clearManualNameByTargetAndPersist.bind(f.threads);
      f.threads.clearManualNameByTargetAndPersist = async (...args) => {
        publications++;
        if (boundary === "binding-renewal") command.bind(reset);
        return publish(...args);
      };
      const runtime = createTelegramBusLeaderRuntimeAssembly({
        runtime: { socketPath: join(f.path, "..", "bus.sock"), followerRegistry: createTelegramBusFollowerRegistry(),
          protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY, startPolling() {}, stopPolling() {} },
        getAllowedUserId: () => 7, getTelegramProfile: () => "default",
        instanceId: "old", getCurrentLeaderEpoch: () => 1, topicTargetStore: f.threads,
        async callApi<TResponse>(_method: string, body: Record<string, unknown>, options?: TelegramApiCallOptions) {
          edits++;
          assert.deepEqual(body, { chat_id: 7, message_thread_id: 10, name: "A" });
          options?.assertAuthority?.();
          if (boundary === "response-loss") current = false;
          return true as TResponse;
        },
        callMultipart: async () => true, downloadFile: async () => undefined,
        getSyncState: () => ({}), setSyncState() {}, setLeaderTarget() {}, recordRuntimeEvent() {},
      });
      const reset: Parameters<typeof command.bind>[0] = async (target, options) => {
        if (typeof target.threadId !== "number") return { ok: false };
        const result = await runtime.resetLeaderThreadName(
          { chatId: target.chatId, threadId: target.threadId }, options?.assertAuthority);
        return { ok: true, threadName: result.threadName };
      };
      command.bind(reset);
      try {
        const pending = command.reset({ chatId: 7, threadId: 10 }, {
          assertAuthority() { if (!current) throw new Error("Recipient authority lost"); },
        });
        if (boundary === "current") assert.deepEqual(await pending, { ok: true, threadName: "A" });
        else await assert.rejects(pending, /authority|binding.*changed|changed binding/i);
        f.threads.setBotState({ threadMode: "enabled" }); await f.threads.persist();
        const reopened = createTelegramTopicTargetStore({ path: f.path }); await reopened.load();
        assert.equal(reopened.getWorkspaceBindingByTarget({ chatId: 7, threadId: 10 }, "session")?.manualThreadName,
          boundary === "current" ? undefined : "My workspace");
        assert.equal(edits, 1);
        assert.equal(publications, boundary === "response-loss" ? 0 : 1);
      } finally { await runtime.stopPolling(); }
    });
  });
}

test("Rename and reset reject target replacement during Bot API mutation", async () => {
  for (const operation of [
    "leader-rename", "leader-reset", "follower-rename", "follower-reset",
  ] as const) {
    const dir = mkdtempSync(join(tmpdir(), `pi-telegram-name-race-${operation}-`));
    const socketPath = join(dir, "bus.sock");
    const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
    const leaderRecord = {
      profileKey: "cwd:/leader",
      owner: { kind: "leader" as const, cwd: "/leader", instanceId: "leader" },
      instanceId: "leader", target: { chatId: 7, threadId: 41 }, slot: "A",
      threadName: "Anchor", status: "active" as const, createdAtMs: 1, updatedAtMs: 1,
    };
    store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/leader")!,
      target: leaderRecord.target, slot: "A", threadName: "Anchor",
      manualThreadName: "Manual Leader", updatedAtMs: 1 });
    store.upsert(leaderRecord);
    store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/follower")!,
      target: { chatId: 7, threadId: 42 }, slot: "B", threadName: "Beacon",
      manualThreadName: "Manual Follower", updatedAtMs: 1 });
    const registry = createTelegramBusFollowerRegistry();
    registry.register({ instanceId: "follower", target: { chatId: 7, threadId: 42 },
      registrationGeneration: "follower:1", connectedAtMs: 1,
      protocol: TEST_BUS_PROTOCOL_IDENTITY, slot: "B", threadName: "Beacon" });
    let editCalls = 0;
    let raceArmed = false;
    const runtime = createTelegramBusLeaderRuntimeAssembly({
      runtime: { socketPath, followerRegistry: registry,
        protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY, startPolling() {}, stopPolling() {} },
      getAllowedUserId: () => undefined,
      instanceId: "leader",
      getCwd: () => "/leader",
      getCurrentLeaderEpoch: () => 1,
      getThreadDisplayMode: () => "letters",
      topicTargetStore: store,
      async callApi<TResponse>(method: string, body: Record<string, unknown>) {
        const operationTitle = operation.endsWith("rename")
          ? "Changed" : operation === "leader-reset" ? "A" : "B";
        if (method === "editForumTopic" && raceArmed && body.name === operationTitle) {
          editCalls++;
          if (operation.startsWith("leader")) {
            store.upsertWorkspaceBinding({
              ...createTelegramWorkspaceBindingIdentity("/leader")!,
              target: { chatId: 7, threadId: 99 }, slot: "A", threadName: "Anchor",
              manualThreadName: "Replacement", updatedAtMs: 2,
            });
            store.upsert({ ...leaderRecord, target: { chatId: 7, threadId: 99 }, updatedAtMs: 2 });
          } else {
            registry.register({ ...registry.get("follower")!,
              target: { chatId: 7, threadId: 99 },
              registrationGeneration: "follower:2" });
          }
        }
        return true as TResponse;
      },
      callMultipart: async () => true,
      downloadFile: async () => undefined,
      getSyncState: () => ({}), setSyncState() {}, setLeaderTarget() {}, recordRuntimeEvent() {},
    });
    try {
      await runtime.startPolling("ctx");
      editCalls = 0;
      raceArmed = true;
      if (operation === "leader-rename") {
        await assert.rejects(runtime.renameLeaderThreadAdmitted(
          "Changed", { chatId: 7, threadId: 41 }), /target changed/);
      } else if (operation === "leader-reset") {
        await assert.rejects(runtime.resetLeaderThreadName(
          { chatId: 7, threadId: 41 }), /target changed/);
      } else {
        const envelope = operation === "follower-rename" ? {
          kind: "follower.renameThread" as const,
          requestId: operation,
          instanceId: "follower",
          registrationGeneration: "follower:1",
          target: { chatId: 7, threadId: 42 },
          threadName: "Changed",
          sentAtMs: 2,
        } : {
          kind: "follower.resetThreadName" as const,
          requestId: operation,
          instanceId: "follower",
          registrationGeneration: "follower:1",
          target: { chatId: 7, threadId: 42 },
          sentAtMs: 2,
        };
        const response = await sendTelegramBusLocalEnvelope({ socketPath, envelope });
        assert.ok(response?.kind === "bus.ack" && !response.ok);
        assert.match(response.message ?? "", /target changed/);
      }
      assert.equal(editCalls, 1);
      if (operation.startsWith("leader")) {
        assert.equal(store.getWorkspaceBinding("/leader")?.manualThreadName, "Replacement");
      } else {
        assert.equal(store.getWorkspaceBinding("/follower")?.manualThreadName, "Manual Follower");
      }
    } finally {
      await runtime.stopPolling();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("Leader startup defers display contraction until the follower roster settles", async (t) => {
  for (const scenario of ["returns", "absent", "stopped", "stopped-during-start"] as const) {
    await t.test(scenario === "returns" ? "same-cwd follower returns" :
      scenario === "absent" ? "same-cwd follower stays absent" :
      scenario === "stopped" ? "leader stops before roster settlement" :
      "leader stops while its startup is still awaiting", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const dir = mkdtempSync(join(tmpdir(), "pi-telegram-display-startup-roster-"));
      const socketPath = join(dir, "bus.sock");
      const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
      const cwd = "/repo/Extensions";
      const leaderIdentity = store.claimWorkspaceIdentity(cwd, "leader", undefined,
        { sessionId: "leader-session" });
      assert.ok(leaderIdentity);
      const leaderBinding = store.upsertWorkspaceBinding({ ...leaderIdentity,
        target: { chatId: 7, threadId: 41 }, threadName: "Anchor", updatedAtMs: 1 }, "leader");
      assert.ok(leaderBinding);
      const followerIdentity = store.claimWorkspaceIdentity(cwd, "follower", undefined,
        { sessionId: "follower-session" });
      assert.ok(followerIdentity);
      const followerBinding = store.upsertWorkspaceBinding({ ...followerIdentity,
        target: { chatId: 7, threadId: 42 }, threadName: "Briar", updatedAtMs: 1 }, "follower");
      assert.ok(followerBinding);
      const currentLeaderBinding = store.listWorkspaceBindings().find(
        (binding) => binding.bindingKey === leaderIdentity.bindingKey);
      const currentFollowerBinding = store.listWorkspaceBindings().find(
        (binding) => binding.bindingKey === followerIdentity.bindingKey);
      assert.ok(currentLeaderBinding && currentFollowerBinding);
      assert.equal(store.setWorkspaceDisplayTitle(
        currentFollowerBinding, `Extensions ${followerIdentity.slot}`), true);
      const leaderAfterFollowerTitle = store.listWorkspaceBindings().find(
        (binding) => binding.bindingKey === leaderIdentity.bindingKey);
      assert.ok(leaderAfterFollowerTitle);
      assert.equal(store.setWorkspaceDisplayTitle(
        leaderAfterFollowerTitle, `Extensions ${leaderIdentity.slot}`), true);
      store.upsert({ profileKey: "cwd:/repo/extensions",
        owner: { kind: "leader", cwd, instanceId: "leader" }, instanceId: "leader",
        target: { chatId: 7, threadId: 41 }, slot: leaderIdentity.slot,
        threadName: "Anchor", status: "active", createdAtMs: 1, updatedAtMs: 1 });
      const registry = createTelegramBusFollowerRegistry();
      const titles: string[] = [];
      let releaseStart!: () => void;
      const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
      const runtime = createTelegramBusLeaderRuntimeAssembly({
        runtime: { socketPath, followerRegistry: registry,
          protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY, followerStaleAfterMs: 25,
          followerPruneIntervalMs: 1000,
          async startPolling() { if (scenario === "stopped-during-start") await startGate; },
          stopPolling() {} },
        instanceId: "leader", getAllowedUserId: () => undefined,
        getCurrentLeaderEpoch: () => 1, getThreadDisplayMode: () => "directory-title",
        topicTargetStore: store,
        async callApi<TResponse>(method: string, body: Record<string, unknown>) {
          assert.equal(method, "editForumTopic");
          titles.push(String(body.name));
          return true as TResponse;
        },
        callMultipart: async () => true, downloadFile: async () => undefined,
        getSyncState: () => ({}), setSyncState() {}, setLeaderTarget() {}, recordRuntimeEvent() {},
      });
      let stopped = false;
      try {
        assert.equal(store.listWorkspaceBindings().find(
          (binding) => binding.bindingKey === leaderIdentity.bindingKey)?.displayTitle,
        `Extensions ${leaderIdentity.slot}`);
        await store.persist();
        if (scenario === "stopped-during-start") {
          const starting = runtime.startPolling("ctx");
          await new Promise((resolve) => setImmediate(resolve));
          // The stop is issued while the start still awaits; the inner stop then waits for that start to finish.
          const stopping = runtime.stopPolling();
          stopped = true;
          releaseStart();
          await starting;
          await stopping;
        } else await runtime.startPolling("ctx");
        assert.deepEqual(titles, [], "Startup must not contract an acknowledged suffix immediately");
        if (scenario === "returns") registry.register({
          instanceId: "follower", target: { chatId: 7, threadId: 42 },
          registrationGeneration: "follower:1", connectedAtMs: Date.now(),
          protocol: TEST_BUS_PROTOCOL_IDENTITY, slot: followerIdentity.slot,
          threadName: "Extensions B",
        });
        if (scenario === "stopped") {
          await runtime.stopPolling();
          stopped = true;
        }
        t.mock.timers.tick(25);
        for (let index = 0; index < 3; index++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        // A startup the leader stopped mid-await must not arm a stabilization timer that later renames tabs.
        assert.deepEqual(titles, scenario === "absent" ? ["Extensions"] : [], JSON.stringify({
          bindings: store.listWorkspaceBindings().map((binding) => ({
            bindingKey: binding.bindingKey, target: binding.target,
            displayTitle: binding.displayTitle, slot: binding.slot,
          })),
          followers: registry.list(),
        }));
      } finally {
        if (!stopped) await runtime.stopPolling();
        // A detached state write can land after stop. rmSync's own retries block the event loop, so that write
        // could never finish between them; yield (setTimeout is mocked here) and retry instead.
        for (let attempt = 0; ; attempt += 1) {
          try {
            rmSync(dir, { recursive: true, force: true });
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt >= 100) throw error;
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
      }
    });
  }
});

test("Same-cwd followers keep sticky directory labels until manual rename overrides them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-display-same-cwd-"));
  const socketPath = join(dir, "bus.sock");
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  const cwd = "/repo/extensions";
  const leaderIdentity = store.claimWorkspaceIdentity(cwd, "leader");
  assert.ok(leaderIdentity);
  store.upsertWorkspaceBinding({ ...leaderIdentity, target: { chatId: 7, threadId: 41 },
    threadName: "Anchor", updatedAtMs: 1 }, "leader");
  store.upsert({ profileKey: "cwd:/repo/extensions", owner: { kind: "leader", cwd, instanceId: "leader" },
    instanceId: "leader", target: { chatId: 7, threadId: 41 }, slot: leaderIdentity.slot,
    threadName: "Anchor", status: "active", createdAtMs: 1, updatedAtMs: 1 });
  const followerIdentity = store.claimWorkspaceIdentity(`${cwd}/`, "follower");
  assert.ok(followerIdentity);
  store.upsertWorkspaceBinding({ ...followerIdentity, target: { chatId: 7, threadId: 42 },
    threadName: "Briar", updatedAtMs: 1 }, "follower");
  store.upsert({ profileKey: "manual:follower", owner: { kind: "manual-follower", instanceId: "follower" },
    instanceId: "follower", target: { chatId: 7, threadId: 42 }, slot: followerIdentity.slot,
    threadName: "Briar", status: "active", createdAtMs: 1, updatedAtMs: 1 });
  const registry = createTelegramBusFollowerRegistry();
  const followerProtocol = createTelegramBusProtocolIdentity({ runtimeBuild: "test",
    capabilities: [...TEST_BUS_PROTOCOL_IDENTITY.capabilities, TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE] });
  registry.register({ instanceId: "follower", target: { chatId: 7, threadId: 42 },
    registrationGeneration: "follower:1", connectedAtMs: 1, protocol: followerProtocol,
    slot: followerIdentity.slot, threadName: "Briar" });
  let mode: TelegramThreadDisplayMode = "names";
  const titles: string[] = [];
  const runtime = createTelegramBusLeaderRuntimeAssembly({
    runtime: { socketPath, followerRegistry: registry, protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY,
      startPolling() {}, stopPolling() {} }, instanceId: "leader", getAllowedUserId: () => undefined,
    getCurrentLeaderEpoch: () => 1, getTelegramProfile: () => "default",
    getThreadDisplayMode: () => mode,
    async persistThreadDisplayMode(nextMode) { mode = nextMode; }, topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      assert.equal(method, "editForumTopic"); titles.push(String(body.name)); return true as TResponse;
    },
    callMultipart: async () => true, downloadFile: async () => undefined,
    getSyncState: () => ({}), setSyncState() {}, setLeaderTarget() {}, recordRuntimeEvent() {},
  });
  try {
    await store.persist();
    await runtime.startPolling("ctx");
    await runtime.setThreadDisplayMode!("directories");
    assert.deepEqual(titles, ["extensions_a", "extensions_b"]);
    assert.deepEqual(store.listWorkspaceBindings().map((binding) => binding.showSlotSuffix), [true, true]);
    const response = await sendTelegramBusLocalEnvelope({ socketPath, envelope: {
      kind: "follower.renameThread", requestId: "follower:rename", instanceId: "follower",
      registrationGeneration: "follower:1",
      target: { chatId: 7, threadId: 42 },
      threadName: "Navigator", sentAtMs: 2,
    } });
    assert.ok(response?.kind === "bus.ack");
    assert.equal(response.requestId, "follower:rename");
    assert.equal(response.ok, true);
    assert.deepEqual(response.result, { threadName: "Navigator" });
    assert.deepEqual(titles, ["extensions_a", "extensions_b", "Navigator"]);
    const renamed = store.getWorkspaceBinding(cwd, followerIdentity.instanceSlot);
    assert.equal(renamed?.threadName, "Briar");
    assert.equal(renamed?.manualThreadName, "Navigator");
    assert.equal(renamed?.displayTitle, "Navigator");
    assert.equal(registry.get("follower")?.threadName, "Navigator");
    await runtime.setThreadDisplayMode!("names");
    assert.deepEqual(titles, ["extensions_a", "extensions_b", "Navigator", "Anchor"]);
    assert.equal(renamed?.target.threadId, 42);
    assert.equal(renamed?.slot, "B");
    await runtime.setThreadDisplayMode!("directories");
    assert.equal(titles.at(-1), "extensions_a");
    const resetResponse = await sendTelegramBusLocalEnvelope({
      socketPath,
      envelope: {
        kind: "follower.resetThreadName",
        requestId: "follower:reset-name",
        instanceId: "follower",
        registrationGeneration: "follower:1",
        target: { chatId: 7, threadId: 42 },
        sentAtMs: 3,
      },
    });
    assert.ok(resetResponse?.kind === "bus.ack" && resetResponse.ok);
    assert.deepEqual(resetResponse.result, { threadName: "extensions_b" });
    assert.equal(
      store.getWorkspaceBinding(cwd, followerIdentity.instanceSlot)
        ?.manualThreadName,
      undefined,
    );
    assert.equal(
      store.getWorkspaceBinding(cwd, followerIdentity.instanceSlot)
        ?.displayTitle,
      "extensions_b",
    );
    assert.equal(registry.get("follower")?.threadName, "extensions_b");
    assert.equal(titles.at(-1), "extensions_b");
    assert.equal(store.getWorkspaceBinding(cwd)?.showSlotSuffix, true);
  } finally {
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const mode of ["directory-title", "directory-snake"] as const)
test(`Automatic same-cwd display skips dormant slotless tabs before updating the live leader (${mode})`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = mkdtempSync(join(tmpdir(), "pt-display-dormant-slotless-")), socketPath = join(dir, "bus.sock");
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") }), cwd = "/repo/extensions";
  const dormant = store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity(cwd)!,
    target: { chatId: 7, threadId: 10 }, threadName: "Cedar", displayTitle: "Extensions", updatedAtMs: 1 });
  assert.ok(dormant); assert.equal(dormant.slot, undefined);
  const leader = store.claimWorkspaceIdentity(cwd, "leader", undefined, { sessionId: "leader-session" }); assert.ok(leader);
  const follower = store.claimWorkspaceIdentity(cwd, "follower", undefined, { sessionId: "follower-session" }); assert.ok(follower);
  const title = (slot?: string) => mode === "directory-title" ? `Extensions${slot ? ` ${slot}` : ""}` : `extensions${slot ? `_${slot.toLowerCase()}` : ""}`;
  store.upsertWorkspaceBinding({ ...leader, target: { chatId: 7, threadId: 41 }, threadName: "Anchor", displayTitle: title(), updatedAtMs: 1 }, "leader");
  store.upsertWorkspaceBinding({ ...follower, target: { chatId: 7, threadId: 42 }, threadName: "Briar", displayTitle: title(follower.slot), updatedAtMs: 1 }, "follower");
  store.upsert({ profileKey: "leader-key", owner: { kind: "leader", cwd, instanceId: "leader" }, instanceId: "leader",
    target: { chatId: 7, threadId: 41 }, slot: leader.slot, threadName: "Anchor", status: "active", createdAtMs: 1, updatedAtMs: 1 });
  const registry = createTelegramBusFollowerRegistry(), calls: { target: unknown; title: unknown }[] = [], errors: unknown[] = [];
  const runtime = createTelegramBusLeaderRuntimeAssembly({
    runtime: { socketPath, followerRegistry: registry, protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY, followerStaleAfterMs: 25,
      followerPruneIntervalMs: 1000, startPolling() {}, stopPolling() {} }, instanceId: "leader", getAllowedUserId: () => undefined,
    getCurrentLeaderEpoch: () => 1, getThreadDisplayMode: () => mode, persistThreadDisplayMode: async () => {}, topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      assert.equal(method, "editForumTopic"); calls.push({ target: body.message_thread_id, title: body.name });
      if (body.message_thread_id === 10) throw new Error("TOPIC_ID_INVALID: dormant tab");
      return true as TResponse;
    }, callMultipart: async () => true, downloadFile: async () => undefined, getSyncState: () => ({}), setSyncState() {},
    setLeaderTarget() {}, recordRuntimeEvent(_category, error, details) { if (error instanceof Error || details?.phase === "thread-display-reconcile") errors.push(error); },
  });
  try {
    await store.persist(); await runtime.startPolling("ctx");
    registry.register({ instanceId: "follower", registrationGeneration: "follower:1", target: { chatId: 7, threadId: 42 },
      protocol: createTelegramBusProtocolIdentity({ runtimeBuild: "test", capabilities: [...TEST_BUS_PROTOCOL_IDENTITY.capabilities, TELEGRAM_BUS_CAPABILITY_DIRECTORY_DISPLAY_FORMAT] }),
      slot: follower.slot, threadName: "Briar", connectedAtMs: Date.now() });
    t.mock.timers.tick(25);
    for (let index = 0; index < 6; index++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [{ target: 41, title: title(leader.slot) }], "A historical slotless tab must not block a live suffix update");
    assert.deepEqual(errors, []);
    assert.equal(store.listWorkspaceBindings().find(b => b.bindingKey === leader.bindingKey)?.displayTitle, title(leader.slot));
    assert.equal(store.listWorkspaceBindings().find(b => b.bindingKey === dormant.bindingKey)?.displayTitle, "Extensions");
    await runtime.setThreadDisplayMode!(mode);
    assert.deepEqual(calls, [{ target: 41, title: title(leader.slot) }], "Mode application also skips dormant slotless repair");
    assert.equal(store.list().some(record => record.target.threadId === 10), false);
  } finally { await runtime.stopPolling(); rmSync(dir, { recursive: true, force: true }); }
});

for (const loss of ["disconnect", "replacement"] as const)
test(`Live slotless title repair retains the follower registration fence (${loss})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-display-live-slotless-")), store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  const binding = store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/repo/follower")!, target: { chatId: 7, threadId: 42 },
    threadName: "Briar", displayTitle: "B", updatedAtMs: 1 }); assert.ok(binding); assert.equal(binding.slot, undefined);
  const registry = createTelegramBusFollowerRegistry(), registration = { instanceId: "follower", registrationGeneration: "follower:1",
    target: { chatId: 7, threadId: 42 }, protocol: TEST_BUS_PROTOCOL_IDENTITY, connectedAtMs: 1 };
  registry.register(registration); let calls = 0;
  const runtime = createTelegramBusLeaderRuntimeAssembly({
    runtime: { socketPath: join(dir, "bus.sock"), followerRegistry: registry, protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY, startPolling() {}, stopPolling() {} },
    instanceId: "leader", getAllowedUserId: () => undefined, getCurrentLeaderEpoch: () => 1, getThreadDisplayMode: () => "letters", topicTargetStore: store,
    async callApi<TResponse>(method: string) {
      assert.equal(method, "editForumTopic"); calls++;
      if (loss === "disconnect") registry.remove("follower"); else registry.register({ ...registration, registrationGeneration: "follower:2" });
      return true as TResponse;
    }, callMultipart: async () => true, downloadFile: async () => undefined, getSyncState: () => ({}), setSyncState() {}, setLeaderTarget() {}, recordRuntimeEvent() {},
  });
  try {
    await store.persist(); await assert.rejects(runtime.reconcileThreadDisplay!(), /binding changed/);
    assert.equal(calls, 1); assert.equal(store.listWorkspaceBindings()[0]!.displayTitle, "B");
  } finally { await runtime.stopPolling(); rmSync(dir, { recursive: true, force: true }); }
});

test("Leader display repair recovers a cold slotless binding without granting it routing ownership", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-slotless-display-"));
  const path = join(dir, "state.json");
  const original = createTelegramTopicTargetStore({ path });
  original.upsertWorkspaceBinding({
    ...createTelegramWorkspaceBindingIdentity("/retained")!,
    target: { chatId: 7, threadId: 42 }, threadName: "Anchor", displayTitle: "A", updatedAtMs: 1,
  });
  await original.persist();
  const store = createTelegramTopicTargetStore({ path });
  await store.load();
  let reject = true;
  let epoch: number | undefined = 1;
  const calls: string[] = [];
  const runtime = createTelegramBusLeaderRuntimeAssembly({
    runtime: { socketPath: join(dir, "bus.sock"), followerRegistry: createTelegramBusFollowerRegistry(),
      protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY, startPolling() {}, stopPolling() {} },
    instanceId: "leader", getAllowedUserId: () => undefined, getCurrentLeaderEpoch: () => epoch,
    getThreadDisplayMode: () => "letters", topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      assert.equal(method, "editForumTopic");
      assert.equal(body.message_thread_id, 42);
      calls.push(String(body.name));
      if (reject) throw new Error("title acknowledgement unavailable");
      return true as TResponse;
    },
    callMultipart: async () => true, downloadFile: async () => undefined,
    getSyncState: () => ({}), setSyncState() {}, setLeaderTarget() {}, recordRuntimeEvent() {},
  });
  try {
    await assert.rejects(runtime.reconcileThreadDisplay!(), /acknowledgement unavailable/);
    assert.equal(store.getWorkspaceBinding("/retained")?.displayTitle, "A");
    reject = false;
    epoch = undefined;
    await assert.rejects(runtime.reconcileThreadDisplay!(), /authority/);
    assert.deepEqual(calls, ["Anchor"]);
    epoch = 1;
    assert.deepEqual(await runtime.reconcileThreadDisplay!(), { changed: 1 });
    assert.deepEqual(calls, ["Anchor", "Anchor"]);
    const cold = createTelegramTopicTargetStore({ path });
    await cold.load();
    assert.equal(cold.getWorkspaceBinding("/retained")?.displayTitle, "Anchor");
    assert.equal(cold.getWorkspaceBinding("/retained")?.slot, undefined);
    assert.deepEqual(cold.list(), [], "display repair creates no live owner record");
  } finally {
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Leader display application retains acknowledged partial progress and retries only the remainder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-display-partial-"));
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  const registry = createTelegramBusFollowerRegistry();
  for (const [cwd, instanceId, slot, threadName, threadId] of [
    ["/leader", "leader", "A", "Anchor", 41],
    ["/follower", "follower", "B", "Beacon", 42],
  ] as const) {
    store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity(cwd)!,
      target: { chatId: 7, threadId }, slot, threadName, updatedAtMs: 1 });
    if (instanceId === "leader") store.upsert({ profileKey: "cwd:/leader",
      owner: { kind: "leader", cwd, instanceId }, instanceId, target: { chatId: 7, threadId },
      slot, threadName, status: "active", createdAtMs: 1, updatedAtMs: 1 });
  }
  registry.register({ instanceId: "follower", target: { chatId: 7, threadId: 42 },
    registrationGeneration: "follower:1", connectedAtMs: 1,
    protocol: createTelegramBusProtocolIdentity({ runtimeBuild: "test",
      capabilities: [...TEST_BUS_PROTOCOL_IDENTITY.capabilities, TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE] }),
    threadName: "Beacon", slot: "B" });
  let mode: TelegramThreadDisplayMode = "names";
  let rejectFollower = true;
  const calls: string[] = [];
  const runtime = createTelegramBusLeaderRuntimeAssembly({
    runtime: { socketPath: join(dir, "bus.sock"), followerRegistry: registry,
      protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY, startPolling() {}, stopPolling() {} },
    instanceId: "leader", getAllowedUserId: () => undefined, getCurrentLeaderEpoch: () => 2,
    getTelegramProfile: () => "work", getThreadDisplayMode: () => mode,
    async persistThreadDisplayMode(nextMode, isCurrent) { assert.equal(isCurrent(), true); mode = nextMode; },
    topicTargetStore: store,
    async callApi<TResponse>(_method: string, body: Record<string, unknown>) {
      calls.push(String(body.name));
      if (rejectFollower && body.name === "B") throw new Error("fixture follower title rejection");
      return true as TResponse;
    },
    callMultipart: async () => true, downloadFile: async () => undefined,
    getSyncState: () => ({}), setSyncState() {}, setLeaderTarget() {}, recordRuntimeEvent() {},
  });
  try {
    await store.persist();
    await assert.rejects(runtime.setThreadDisplayMode!("letters"), /fixture follower title rejection/);
    assert.equal(mode, "letters");
    assert.equal(store.getWorkspaceBinding("/leader")?.displayTitle, "A");
    assert.equal(store.getWorkspaceBinding("/follower")?.displayTitle, undefined);
    rejectFollower = false;
    await runtime.setThreadDisplayMode!("letters");
    assert.deepEqual(calls, ["A", "B", "B"]);
    assert.equal(store.getWorkspaceBinding("/follower")?.displayTitle, "B");
    assert.equal(store.getWorkspaceBinding("/leader")?.threadName, "Anchor");
    assert.equal(store.getWorkspaceBinding("/follower")?.threadName, "Beacon");
  } finally {
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Leader display application fences late profile and follower-generation changes", async () => {
  for (const scenario of ["profile", "generation"] as const) {
    const dir = mkdtempSync(join(tmpdir(), `pi-telegram-display-${scenario}-`));
    const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
    const registry = createTelegramBusFollowerRegistry();
    store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/follower")!,
      target: { chatId: 7, threadId: 42 }, slot: "B", threadName: "Beacon", updatedAtMs: 1 });
    const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "test",
      capabilities: [...TEST_BUS_PROTOCOL_IDENTITY.capabilities, TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE] });
    registry.register({ instanceId: "follower", target: { chatId: 7, threadId: 42 },
      registrationGeneration: "follower:1", connectedAtMs: 1, protocol,
      threadName: "Beacon", slot: "B" });
    let profile = "work";
    let mode: TelegramThreadDisplayMode = "names";
    let releaseEdit: (() => void) | undefined;
    let announceEdit: (() => void) | undefined;
    const editStarted = new Promise<void>((resolve) => { announceEdit = resolve; });
    const editGate = new Promise<void>((resolve) => { releaseEdit = resolve; });
    let calls = 0;
    const runtime = createTelegramBusLeaderRuntimeAssembly({
      runtime: { socketPath: join(dir, "bus.sock"), followerRegistry: registry,
        protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY, startPolling() {}, stopPolling() {} },
      instanceId: "leader", getAllowedUserId: () => undefined, getCurrentLeaderEpoch: () => 2,
      getTelegramProfile: () => profile, getThreadDisplayMode: () => mode,
      async persistThreadDisplayMode(nextMode) { mode = nextMode; }, topicTargetStore: store,
      async callApi<TResponse>() {
        calls++;
        if (calls === 1) { announceEdit?.(); await editGate; }
        return true as TResponse;
      },
      callMultipart: async () => true, downloadFile: async () => undefined,
      getSyncState: () => ({}), setSyncState() {}, setLeaderTarget() {}, recordRuntimeEvent() {},
    });
    try {
      await store.persist();
      const pending = runtime.setThreadDisplayMode!("letters");
      await editStarted;
      if (scenario === "profile") profile = "other";
      else registry.register({ ...registry.get("follower")!, registrationGeneration: "follower:2" });
      releaseEdit?.();
      await assert.rejects(pending, /authority|binding changed/);
      assert.equal(mode, "letters");
      assert.equal(store.getWorkspaceBinding("/follower")?.displayTitle, undefined);
      profile = "work";
      await runtime.setThreadDisplayMode!("letters");
      assert.equal(store.getWorkspaceBinding("/follower")?.displayTitle, "B");
      assert.equal(store.getWorkspaceBinding("/follower")?.threadName, "Beacon");
      assert.equal(calls, 2);
    } finally {
      await runtime.stopPolling();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("Bus leader runtime exposes direct leader-to-follower queue handoff", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-leader-handoff-route-"));
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  const recipientSocketPath = join(dir, "recipient.sock");
  registry.register({
    instanceId: "recipient",
    pid: 202,
    target: { chatId: 7, threadId: 20 },
    busSocketPath: recipientSocketPath,
    registrationGeneration: "recipient-generation",
    protocol: TEST_BUS_PROTOCOL_IDENTITY,
    connectedAtMs: 1,
  });
  const runtime = createTelegramBusLeaderRuntime({
    socketPath,
    followerRegistry: registry,
    protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY,
    startPolling: () => undefined,
    stopPolling: () => undefined,
  });
  const recipientServer = createTelegramBusLocalServer({
    socketPath: recipientSocketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: true,
      result: { status: "staged", receiptId: "receipt-1", sourceUpdateIds: [1] },
    }),
  });
  let upgraded: typeof runtime | undefined;
  try {
    await recipientServer.start();
    const offer: Parameters<typeof runtime.routeQueueHandoff>[0] = {
      requestId: "handoff:runtime",
      auth: undefined,
      recipientInstanceId: "recipient",
      recipientRegistrationGeneration: "recipient-generation",
      donorInstanceId: "leader",
      donorProcessId: 101,
      donorProcessBirthId: "101:start:donor",
      donorSessionGeneration: 1,
      donorAcquisitionId: "acquisition",
      donorAcquiredAtMs: 1,
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
      sentAtMs: 1,
    };
    const response = await runtime.routeQueueHandoff(offer);
    assert.deepEqual(response, {
      kind: "bus.ack",
      requestId: "handoff:runtime",
      ok: true,
      result: { status: "staged", receiptId: "receipt-1", sourceUpdateIds: [1] },
    });
    const steerOffer = { ...offer, requestId: "handoff:steer", payload: { ...offer.payload, queueLane: "steer" as const } };
    assert.equal((await runtime.routeQueueHandoff(steerOffer) as { ok: boolean }).ok, false);
    const steerProtocol = createTelegramBusProtocolIdentity({ runtimeBuild: "steer", capabilities: [TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF, TELEGRAM_BUS_CAPABILITY_QUEUE_STEER] });
    upgraded = createTelegramBusLeaderRuntime({ socketPath: join(dir, "upgraded.sock"), followerRegistry: registry,
      protocolIdentity: steerProtocol, startPolling: () => undefined, stopPolling: () => undefined });
    assert.equal((await upgraded.routeQueueHandoff(steerOffer) as { ok: boolean }).ok, false, "Legacy recipient refuses before native IPC");
    registry.register({ ...registry.get("recipient")!, protocol: steerProtocol });
    const supportedResponse = await upgraded.routeQueueHandoff(steerOffer);
    assert.equal((supportedResponse as { ok: boolean }).ok, true, JSON.stringify(supportedResponse));
  } finally {
    await upgraded?.stopPolling();
    await recipientServer.stop();
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader runtime provisions leader target before polling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-leader-target-"));
  const socketPath = join(dir, "bus.sock");
  const events: string[] = [];
  const runtime = createTelegramBusLeaderRuntime({
    socketPath,
    followerRegistry: createTelegramBusFollowerRegistry(),
    provisionLeaderTarget: (ctx) => {
      events.push(`leader:${ctx}`);
    },
    startPolling: () => {
      events.push("poll:start");
    },
    stopPolling: () => {
      events.push("poll:stop");
    },
  });
  try {
    await runtime.startPolling("ctx");
    await runtime.stopPolling();
    assert.deepEqual(events, ["leader:ctx", "poll:start", "poll:stop"]);
  } finally {
    await runtime.stopPolling().catch(() => undefined);
  }
});

test("Bus leader runtime stopped during startup never publishes its follower endpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-stop-during-start-"));
  const socketPath = join(dir, "bus.sock");
  let finishProvisioning!: () => void;
  let provisioningStarted!: () => void;
  const provisioningGate = new Promise<void>((resolve) => { finishProvisioning = resolve; });
  const started = new Promise<void>((resolve) => { provisioningStarted = resolve; });
  let polling = 0;
  const runtime = createTelegramBusLeaderRuntime({
    socketPath,
    followerRegistry: createTelegramBusFollowerRegistry(),
    provisionLeaderTarget: async () => {
      provisioningStarted();
      await provisioningGate;
    },
    startPolling: () => { polling += 1; },
    stopPolling: () => undefined,
  });
  try {
    const startup = runtime.startPolling("ctx");
    await started;
    // Session shutdown arrives while the leader is still replaying cleanup.
    await runtime.stopPolling();
    finishProvisioning();
    await startup;
    await assert.rejects(() =>
      sendTelegramBusLocalEnvelope({
        socketPath,
        timeoutMs: 50,
        envelope: {
          kind: "follower.register",
          requestId: "stop-during-start:1",
          registration: { instanceId: "late", registrationGeneration: "late:1", connectedAtMs: 1000 },
        },
      }),
    "A stopped leader's endpoint never starts listening for followers");
    assert.equal(polling, 0, "A stopped startup never begins polling");
  } finally {
    finishProvisioning();
    await runtime.stopPolling().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader runtime keeps follower endpoint unpublished during cleanup replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-replay-fence-"));
  const socketPath = join(dir, "bus.sock");
  let finishProvisioning!: () => void;
  let provisioningStarted!: () => void;
  const provisioningGate = new Promise<void>((resolve) => {
    finishProvisioning = resolve;
  });
  const started = new Promise<void>((resolve) => {
    provisioningStarted = resolve;
  });
  const runtime = createTelegramBusLeaderRuntime({
    socketPath,
    followerRegistry: createTelegramBusFollowerRegistry(),
    provisionLeaderTarget: async () => {
      provisioningStarted();
      await provisioningGate;
    },
    startPolling: () => undefined,
    stopPolling: () => undefined,
  });
  try {
    const startup = runtime.startPolling("ctx");
    await started;
    const probe = () =>
      sendTelegramBusLocalEnvelope({
        socketPath,
        timeoutMs: 50,
        envelope: {
          kind: "follower.register",
          requestId: "replay-fence:1",
          registration: {
            instanceId: "replay-fence",
            registrationGeneration: "replay-fence:1",
            connectedAtMs: 1000,
          },
        },
      });
    await assert.rejects(probe);
    finishProvisioning();
    await startup;
    assert.equal((await probe())?.kind, "bus.ack");
  } finally {
    finishProvisioning();
    await runtime.stopPolling().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader runtime starts the local server around polling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-leader-"));
  const socketPath = join(dir, "bus.sock");
  const events: string[] = [];
  const registry = createTelegramBusFollowerRegistry();
  const runtime = createTelegramBusLeaderRuntime({
    socketPath,
    followerRegistry: registry,
    followerPruneIntervalMs: 10,
    startPolling: () => {
      events.push("poll:start");
    },
    stopPolling: () => {
      events.push("poll:stop");
    },
  });
  try {
    await runtime.startPolling("ctx");
    assert.equal(
      (
        await sendTelegramBusLocalEnvelope({
          socketPath,
          envelope: {
            kind: "follower.register",
            requestId: "inst-a:1",
            registration: {
              instanceId: "inst-a",
              connectedAtMs: 1000,
              registrationGeneration: "inst-a:1",
              protocol: TEST_BUS_PROTOCOL_IDENTITY,
            },
          },
        })
      )?.kind,
      "bus.ack",
    );
    assert.equal(registry.get("inst-a")?.instanceId, "inst-a");
    if (process.platform !== "win32") {
      const resolvedSocketPath = resolveTelegramBusSocketPath(socketPath);
      unlinkSync(resolvedSocketPath);
      await waitForCondition(() => existsSync(resolvedSocketPath));
    }
    assert.deepEqual(events, ["poll:start"]);
    await runtime.stopPolling();
    assert.deepEqual(events, ["poll:start", "poll:stop"]);
    await assert.rejects(
      sendTelegramBusLocalEnvelope({
        socketPath,
        envelope: {
          kind: "follower.heartbeat",
          requestId: "inst-a:2",
          instanceId: "inst-a",
          sentAtMs: 2000,
        },
        timeoutMs: 50,
      }),
    );
  } finally {
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader runtime tolerates transient follower heartbeat stalls by default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-prune-grace-"));
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  let nowMs = TELEGRAM_BUS_FOLLOWER_STALE_AFTER_MS - 1;
  registry.register({ instanceId: "delayed", connectedAtMs: 0 });
  const runtime = createTelegramBusLeaderRuntime({
    socketPath,
    followerRegistry: registry,
    getNowMs: () => nowMs,
    followerPruneIntervalMs: 5,
    startPolling: () => undefined,
    stopPolling: () => undefined,
  });
  try {
    await runtime.startPolling("ctx");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(registry.get("delayed")?.instanceId, "delayed");
    nowMs = TELEGRAM_BUS_FOLLOWER_STALE_AFTER_MS + 1;
    await waitForCondition(() => registry.get("delayed") === undefined);
  } finally {
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader runtime prunes stale followers while polling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-prune-"));
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  const runtimeEvents: string[] = [];
  let nowMs = 1000;
  registry.register({ instanceId: "fresh", connectedAtMs: 950 });
  registry.register({ instanceId: "stale", connectedAtMs: 0 });
  registry.heartbeat("fresh", 950);
  registry.heartbeat("stale", 0);
  const runtime = createTelegramBusLeaderRuntime({
    socketPath,
    followerRegistry: registry,
    getNowMs: () => nowMs,
    followerPruneIntervalMs: 5,
    followerStaleAfterMs: 100,
    startPolling: () => undefined,
    stopPolling: () => undefined,
    recordRuntimeEvent: (category, error, details) => {
      runtimeEvents.push(
        `${category}:${details?.phase}:${details?.instanceId}:${String(error)}`,
      );
    },
  });
  try {
    await runtime.startPolling("ctx");
    await waitForCondition(() => registry.get("stale") === undefined);
    assert.equal(registry.get("fresh")?.instanceId, "fresh");
    assert.equal(
      runtimeEvents.includes(
        "bus:follower-pruned:stale:Telegram bus follower heartbeat stale; preserving thread binding",
      ),
      true,
    );
  } finally {
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader owns one generation-fenced follower prune", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-prune-gate-"));
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "dead",
    connectedAtMs: 0,
    pid: 4242,
    registrationGeneration: "generation-dead",
  });
  let policyCalls = 0;
  let releasePolicy: (() => void) | undefined;
  const policy = new Promise<void>((resolve) => {
    releasePolicy = resolve;
  });
  const cleaned: string[] = [];
  const runtime = createTelegramBusLeaderRuntime({
    socketPath,
    followerRegistry: registry,
    getNowMs: () => 1000,
    followerPruneIntervalMs: 5,
    followerStaleAfterMs: 100,
    isFollowerProcessAlive: () => false,
    async shouldCleanupConfirmedDeadFollower() {
      policyCalls += 1;
      await policy;
      return true;
    },
    onFollowerConfirmedDead(follower) {
      cleaned.push(follower.instanceId);
    },
    startPolling: () => undefined,
    stopPolling: () => undefined,
  });
  try {
    await runtime.startPolling("ctx");
    await waitForCondition(() => policyCalls === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(policyCalls, 1);
    await runtime.stopPolling();
    releasePolicy?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(cleaned, []);
  } finally {
    releasePolicy?.();
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pruned follower observation retries delayed death and failed preservation without restoring routing", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const initial of ["alive", "unknown", "dead"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "pi-telegram-delayed-preserve-"));
    const socketPath = join(dir, "bus.sock");
    const registry = createTelegramBusFollowerRegistry();
    registry.register({ instanceId: "old", profileKey: "owner", pid: 42,
      target: { chatId: 7, threadId: 11 }, connectedAtMs: 0, registrationGeneration: "old:1" });
    let liveness: "alive" | "unknown" | "dead" = initial;
    let probes = 0;
    let attempts = 0;
    let completed = 0;
    let failures = 0;
    let deletes = 0;
    const runtime = createTelegramBusLeaderRuntime({
      socketPath, followerRegistry: registry, getNowMs: () => 1000,
      followerStaleAfterMs: 100, getCurrentLeaderEpoch: () => 1,
      isFollowerProcessAlive(pid) {
        assert.equal(pid, 42);
        probes++;
        if (liveness === "unknown") throw new Error("probe unavailable");
        return liveness === "alive";
      },
      shouldCleanupConfirmedDeadFollower: () => false,
      onFollowerConfirmedDead() { deletes++; },
      onFollowerConfirmedDeadPreserved(follower, isCurrent) {
        assert.equal(follower.registrationGeneration, "old:1");
        assert.equal(isCurrent(), true);
        if (++attempts === 1) throw new Error("publication unavailable");
        completed++;
        return true;
      },
      recordRuntimeEvent(_category, _error, details) {
        if (details?.phase === "follower-confirmed-dead-preserve") failures++;
      },
      startPolling() {}, stopPolling() {},
    });
    try {
      await runtime.startPolling("ctx");
      t.mock.timers.tick(1000);
      await waitForCondition(() => probes > 0);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(registry.list(), []);
      const ack = await sendTelegramBusLocalEnvelope({ socketPath, envelope: {
        kind: "follower.heartbeat", requestId: "old:heartbeat", instanceId: "old",
        registrationGeneration: "old:1", sentAtMs: 1000,
      } });
      assert.equal(ack?.kind === "bus.ack" && ack.ok, false, "retained evidence is not routing authority");
      if (initial !== "dead") {
        assert.equal(attempts, 0);
        liveness = "dead";
        t.mock.timers.tick(1000);
      }
      await waitForCondition(() => failures === 1);
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(1000);
      await waitForCondition(() => completed === 1);
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(5000);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(attempts, 2, "successful preservation ends observation");
      assert.equal(deletes, 0);
      assert.deepEqual(registry.list(), []);
    } finally {
      await runtime.stopPolling();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("Deferred preservation recovers native publication and admission prefixes without duplicate inactivity or leases", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const failure of ["write", "commit-ack", "admission-ack", "policy", "fenced", "revived"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "pi-telegram-preserve-prefix-"));
    const path = join(dir, "state.json");
    const registry = createTelegramBusFollowerRegistry();
    const follower = { instanceId: "old", profileKey: "manual:owner", pid: 42,
      target: { chatId: 7, threadId: 11 }, slot: "A", connectedAtMs: 0, registrationGeneration: "old:1" };
    registry.register(follower);
    let now = 1000;
    let alive = true;
    let armed = false;
    let injected = false;
    let probes = 0;
    let failures = 0;
    let preserved = 0;
    let writes = 0;
    let apiCalls = 0;
    const admission = createTelegramWorkspaceAdmissionLedger({ path: join(dir, "admission.json"),
      profileKey: "default", owner: { processId: process.pid, processBirthId: `${process.pid}:prefix` },
      getProcessLiveness: () => "alive" });
    const operations = createTelegramWorkspaceOperationRuntime({ getWorkspaceAdmission: () => ({
      ...admission,
      acquireAdmission(input) {
        const result = admission.acquireAdmission(input);
        if (armed && failure === "admission-ack" && !injected) {
          injected = true;
          throw new Error("admission acknowledgement lost");
        }
        return result;
      },
    }) });
    const store = createTelegramTopicTargetStore({ path, getNowMs: () => now,
      commitPersist(commit) {
        if (!armed) { commit(); return true; }
        writes++;
        assert.ok(admission.read().leases.some((lease) => lease.operationKind === "workspace.preserve-dead-follower"));
        if (!injected && failure === "revived") { injected = true; alive = true; }
        if (!injected && (failure === "write" || failure === "commit-ack")) {
          injected = true;
          if (failure === "commit-ack") commit();
          throw new Error("snapshot publication interrupted");
        }
        commit();
        return true;
      },
    });
    store.upsert({ profileKey: follower.profileKey, instanceId: follower.instanceId,
      target: follower.target, slot: "A", status: "active", createdAtMs: 1, updatedAtMs: 1 });
    store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/old")!,
      target: follower.target, slot: "A", updatedAtMs: 1 });
    const runtime = createTelegramBusLeaderRuntimeAssembly({
      runtime: { socketPath: join(dir, "bus.sock"), followerRegistry: registry,
        protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY,
        startPolling() {}, stopPolling() {}, getNowMs: () => now, followerStaleAfterMs: 100,
        isFollowerProcessAlive() { probes++; return alive; },
        shouldCleanupConfirmedDeadFollower() {
          if (failure === "policy" && !injected) { injected = true; throw new Error("policy unavailable"); }
          return false;
        } },
      instanceId: "leader", getAllowedUserId: () => undefined, topicTargetStore: store,
      getCurrentLeaderEpoch: () => 1, getTelegramProfile: () => "default",
      runWorkspaceOperation: operations.run,
      async callApi<TResponse>() { apiCalls++; return true as TResponse; },
      callMultipart: async () => true, downloadFile: async () => undefined,
      getSyncState: () => ({}), setSyncState() {}, setLeaderTarget() {},
      recordRuntimeEvent(_category, _error, details) {
        if (details?.phase === "follower-confirmed-dead-preserve" ||
            details?.phase === "follower-confirmed-dead-cleanup-policy") failures++;
        if (details?.phase === "follower-confirmed-dead-preserved") preserved++;
      },
    });
    try {
      await store.persist();
      await runtime.startPolling("ctx");
      armed = true;
      t.mock.timers.tick(1000);
      await waitForCondition(() => probes > 0);
      await new Promise((resolve) => setImmediate(resolve));
      const fence = failure === "fenced" ? admission.acquireRetirementFence({
        operationId: "other-retirement", retirementIntentId: "intent", bindingKey: "other", slot: "B",
        target: { chatId: 7, threadId: 99 }, leaderEpoch: 1, retirementRequestedAtMs: 1,
      }) : undefined;
      if (fence) assert.equal(fence.kind, "acquired");
      alive = false;
      now = 2000;
      t.mock.timers.tick(1000);
      await waitForCondition(() => failure === "revived" ? preserved === 1 : failures === 1, 2000);
      const disk = createTelegramTopicTargetStore({ path });
      await disk.load();
      assert.equal(disk.list().length, failure === "commit-ack" ? 0 : 1);
      assert.equal(disk.listWorkspaceBindings()[0]?.inactiveSinceMs, failure === "commit-ack" ? 2000 : undefined);
      await new Promise((resolve) => setImmediate(resolve));
      if (fence?.kind === "acquired") assert.equal(admission.releaseUnissuedRetirementFence(fence.fence), true);
      alive = false;
      now = 3000;
      t.mock.timers.tick(1000);
      await waitForCondition(() => preserved > 0 && store.list().length === 0, 2000);
      await disk.load();
      assert.equal(disk.listWorkspaceBindings()[0]?.inactiveSinceMs, failure === "commit-ack" ? 2000 : 3000);
      assert.equal(writes, failure === "write" || failure === "revived" ? 2 : 1);
      assert.equal(disk.listWorkspaceBindings()[0]?.slot, "A");
      assert.deepEqual(disk.listSyncObservations(), []);
      assert.deepEqual(admission.read().leases, [], failure);
      assert.deepEqual(registry.list(), []);
      assert.equal(apiCalls, 0);
    } finally {
      armed = false;
      await runtime.stopPolling();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("Deferred preservation drops obsolete scopes and never upgrades observations into deletion", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const change of ["instance", "profile-key", "target", "epoch", "profile", "stop", "cleanup-enabled", "cleanup-failure", "missing-generation", "invalid-pid"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "pi-telegram-preserve-scope-"));
    const registry = createTelegramBusFollowerRegistry();
    const old = { instanceId: "old", profileKey: "owner", target: { chatId: 7, threadId: 11 },
      connectedAtMs: 0, pid: change === "invalid-pid" ? 0 : 42,
      registrationGeneration: change === "missing-generation" ? undefined : "old:1" };
    registry.register(old);
    let epoch = 1;
    let profile = "default";
    let alive = change !== "cleanup-failure";
    let cleanup = change === "cleanup-failure";
    let ticks = 0;
    let preserved = 0;
    let deletes = 0;
    const runtime = createTelegramBusLeaderRuntime({
      socketPath: join(dir, "bus.sock"), followerRegistry: registry,
      getCurrentLeaderEpoch: () => epoch, getTelegramProfile: () => profile,
      getNowMs() { ticks++; return 1000; }, followerStaleAfterMs: 100,
      isFollowerProcessAlive: () => alive, shouldCleanupConfirmedDeadFollower: () => cleanup,
      onFollowerConfirmedDead() { deletes++; throw new Error("delete outcome unknown"); },
      onFollowerConfirmedDeadPreserved() { preserved++; return true; },
      startPolling() {}, stopPolling() {},
    });
    const tick = async () => {
      const before = ticks;
      t.mock.timers.tick(1000);
      await waitForCondition(() => ticks > before);
      await new Promise((resolve) => setImmediate(resolve));
    };
    try {
      await runtime.startPolling("ctx");
      await tick();
      assert.deepEqual(registry.list(), []);
      if (["instance", "profile-key", "target"].includes(change)) {
        const replacement = { ...old, instanceId: change === "instance" ? "old" : "new",
          profileKey: change === "profile-key" ? "owner" : "other",
          target: change === "target" ? old.target : { chatId: 7, threadId: 12 },
          registrationGeneration: "new:1", pid: 43 };
        registry.register(replacement);
        registry.remove(replacement.instanceId);
      }
      if (change === "epoch") epoch = 2;
      if (change === "profile") profile = "other";
      if (change === "stop") { await runtime.stopPolling(); await runtime.startPolling("replacement"); }
      if (change === "cleanup-enabled") cleanup = true;
      alive = false;
      await tick();
      epoch = 1;
      profile = "default";
      cleanup = false;
      await tick();
      assert.equal(preserved, 0, change);
      assert.equal(deletes, change === "cleanup-failure" ? 1 : 0, change);
      assert.deepEqual(registry.list(), []);
    } finally {
      await runtime.stopPolling();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("Late old preservation failure cannot erase a replacement runtime's retained observation", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-preserve-restart-"));
  const registry = createTelegramBusFollowerRegistry();
  const old = { instanceId: "same", profileKey: "owner", target: { chatId: 7, threadId: 11 },
    connectedAtMs: 0, pid: 42, registrationGeneration: "g1" };
  registry.register(old);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started = false;
  let oldSettled = false;
  let newAlive = true;
  let newProbes = 0;
  let completed = 0;
  const runtime = createTelegramBusLeaderRuntime({
    socketPath: join(dir, "bus.sock"), followerRegistry: registry,
    getCurrentLeaderEpoch: () => 1, getNowMs: () => 1000, followerStaleAfterMs: 100,
    isFollowerProcessAlive(pid) { if (pid === 42) return false; newProbes++; return newAlive; },
    shouldCleanupConfirmedDeadFollower: () => false,
    async onFollowerConfirmedDeadPreserved(follower, isCurrent) {
      if (follower.registrationGeneration === "g1") {
        started = true;
        await held;
        assert.equal(isCurrent(), false);
        oldSettled = true;
        throw new Error("old publication rejected");
      }
      assert.equal(isCurrent(), true);
      completed++;
      return true;
    },
    startPolling() {}, stopPolling() {},
  });
  try {
    await runtime.startPolling("old");
    t.mock.timers.tick(1000);
    await waitForCondition(() => started);
    await runtime.stopPolling();
    registry.register({ ...old, pid: 43, registrationGeneration: "g2" });
    await runtime.startPolling("new");
    t.mock.timers.tick(1000);
    await waitForCondition(() => newProbes > 0);
    release();
    await waitForCondition(() => oldSettled);
    await new Promise((resolve) => setImmediate(resolve));
    newAlive = false;
    t.mock.timers.tick(1000);
    await waitForCondition(() => completed === 1);
    assert.deepEqual(registry.list(), []);
  } finally {
    release();
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Admitted replacement provisioning cancels an old observation before live registration", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-preserve-provision-"));
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  registry.register({ instanceId: "same", profileKey: "old-owner", pid: 42, connectedAtMs: 0,
    target: { chatId: 7, threadId: 11 }, slot: "A", registrationGeneration: "g1" });
  let alive = true;
  let ticks = 0;
  let started = false;
  let preserved = 0;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const runtime = createTelegramBusLeaderRuntime({
    socketPath, followerRegistry: registry, getCurrentLeaderEpoch: () => 1,
    getNowMs() { ticks++; return 1000; }, followerStaleAfterMs: 100,
    isFollowerProcessAlive: () => alive, shouldCleanupConfirmedDeadFollower: () => false,
    onFollowerConfirmedDeadPreserved() { preserved++; return true; },
    async provisionFollowerTarget() {
      started = true;
      await held;
      return { chatId: 7, threadId: 11, slot: "A" };
    },
    startPolling() {}, stopPolling() {},
  });
  let registration: ReturnType<typeof sendTelegramBusLocalEnvelope> | undefined;
  try {
    await runtime.startPolling("ctx");
    t.mock.timers.tick(1000);
    await waitForCondition(() => registry.list().length === 0);
    await new Promise((resolve) => setImmediate(resolve));
    registration = sendTelegramBusLocalEnvelope({ socketPath, envelope: {
      kind: "follower.register", requestId: "new:1", registration: {
        instanceId: "same", profileKey: "new-owner", pid: 43, connectedAtMs: 1000,
        target: { chatId: 7, threadId: 11 }, slot: "A", registrationGeneration: "g2", protocol: TEST_BUS_PROTOCOL_IDENTITY,
      },
    } });
    await waitForCondition(() => started);
    alive = false;
    const before = ticks;
    t.mock.timers.tick(1000);
    await waitForCondition(() => ticks > before);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(preserved, 0, "the registry is not yet live, but provisioning already replaced ownership");
    release();
    const ack = await registration;
    assert.equal(ack?.kind === "bus.ack" && ack.ok, true);
  } finally {
    release();
    await registration;
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Preservation observation capacity is bounded by A-Z and overflow stays non-destructive", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-preserve-capacity-"));
  const registry = createTelegramBusFollowerRegistry();
  for (let index = 0; index < 27; index++) registry.register({
    instanceId: `f${index}`, profileKey: `owner${index}`, pid: 4000 + index,
    target: { chatId: 7, threadId: 100 + index }, connectedAtMs: 0, registrationGeneration: `g${index}`,
  });
  let alive = true;
  let probes = 0;
  let overflow = 0;
  const preserved: string[] = [];
  const runtime = createTelegramBusLeaderRuntime({
    socketPath: join(dir, "bus.sock"), followerRegistry: registry,
    getCurrentLeaderEpoch: () => 1, getNowMs: () => 1000, followerStaleAfterMs: 100,
    isFollowerProcessAlive() { probes++; return alive; },
    shouldCleanupConfirmedDeadFollower: () => false,
    onFollowerConfirmedDead() { assert.fail("observation cannot delete a Thread"); },
    onFollowerConfirmedDeadPreserved(follower) { preserved.push(follower.instanceId); return true; },
    recordRuntimeEvent(_category, _error, details) { if (details?.phase === "follower-preservation-capacity") overflow++; },
    startPolling() {}, stopPolling() {},
  });
  try {
    await runtime.startPolling("ctx");
    t.mock.timers.tick(1000);
    await waitForCondition(() => probes === 27);
    assert.equal(overflow, 1);
    assert.equal(preserved.length, 0);
    await new Promise((resolve) => setImmediate(resolve));
    alive = false;
    t.mock.timers.tick(1000);
    await waitForCondition(() => preserved.length === 26);
    assert.equal(preserved.includes("f26"), false);
    assert.deepEqual(registry.list(), []);
  } finally {
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Preserved dead followers become inactive durably and rotate only under protected capacity pressure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-preserved-pressure-"));
  const path = join(dir, "state.json");
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  const admission = createTelegramWorkspaceAdmissionLedger({
    path: join(dir, "admission.json"), profileKey: "default",
    owner: { processId: process.pid, processBirthId: `${process.pid}:preserved` },
    getProcessLiveness: () => "alive",
  });
  const operations = createTelegramWorkspaceOperationRuntime({ getWorkspaceAdmission: () => admission });
  let verifyDetachment = false;
  const store = createTelegramTopicTargetStore({ path, getNowMs: () => 1000,
    getExternalReservedSlots: admission.listReservedSlots,
    commitPersist(commit) {
      if (verifyDetachment) assert.ok(admission.read().leases.some((lease) =>
        lease.operationKind === "workspace.preserve-dead-follower"));
      commit();
      return true;
    },
  });
  for (let index = 0; index < 26; index++) {
    const instanceId = `dead-${index}`;
    const profileKey = `manual:owner-${index}`;
    const target = { chatId: 7, threadId: 100 + index };
    const slot = String.fromCharCode(65 + index);
    registry.register({ instanceId, profileKey, target, slot, pid: 4000 + index,
      connectedAtMs: 0, registrationGeneration: `${instanceId}:1` });
    store.upsert({ profileKey, instanceId, target, slot,
      status: "active", createdAtMs: 1, updatedAtMs: 1 });
    store.upsertWorkspaceBinding({
      ...createTelegramWorkspaceBindingIdentity(`/old/${String(index).padStart(2, "0")}`, 0, "old-session")!,
      target, slot, updatedAtMs: 1, journalBindingKeys: [], journalBindingsComplete: true,
    });
  }
  const accepted = [{ update: { update_id: 1,
    message: { chat: { id: 7 }, message_thread_id: 100 } } }];
  const capture = createTelegramWorkspaceExternalProtectionCapture({
    listFollowers: registry.list, getActiveTurnTarget: () => undefined, getQueuedItems: () => [],
    resolveLeaderJournal: () => ({ journal: { read: () => ({ entries: accepted }) } }),
    createFollowerJournalResolver: () => () => ({ journal: { read: () => ({ entries: [] }) } }),
    getJournalWriterProtection: () => "clear", getDeliveryAuthorityProtection: () => "clear",
  });
  let allowedUserId: number | undefined;
  const effects: string[] = [];
  const errors: unknown[] = [];
  const runtime = createTelegramBusLeaderRuntimeAssembly({
    runtime: { socketPath, followerRegistry: registry, protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY,
      startPolling() {}, stopPolling() {}, getNowMs: () => 1000,
      followerPruneIntervalMs: 5, followerStaleAfterMs: 100,
      isFollowerProcessAlive: () => false, shouldCleanupConfirmedDeadFollower: () => false },
    getAllowedUserId: () => allowedUserId, instanceId: "leader", topicTargetStore: store,
    getCurrentLeaderEpoch: () => 1, getWorkspaceAdmission: () => admission,
    runWorkspaceOperation: operations.run, captureWorkspaceExternalProtection: capture,
    workspaceRotation: {
      getAdmission: () => admission, runExclusive: operations.runExclusive,
      async deleteThread(authorize) { effects.push(`delete:${authorize().threadId}`); },
    },
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      effects.push(`${method}:${body.message_thread_id ?? "new"}`);
      return (method === "createForumTopic" ? { message_thread_id: 1000 } : true) as TResponse;
    },
    callMultipart: async () => true, downloadFile: async () => undefined,
    getSyncState: () => ({}), setSyncState() {}, setLeaderTarget() {},
    recordRuntimeEvent(_category, error) { if (error instanceof Error) errors.push(error); },
  });
  try {
    await store.persist();
    await runtime.startPolling("ctx");
    verifyDetachment = true;
    await waitForCondition(() => store.list().length === 0, 5000);
    verifyDetachment = false;
    assert.equal(effects.length, 0, "preservation must issue no Telegram requests");
    const restored = createTelegramTopicTargetStore({ path });
    await restored.load();
    assert.equal(restored.listWorkspaceBindings().length, 26);
    assert.ok(restored.listWorkspaceBindings().every((binding) => binding.inactiveSinceMs === 1000));
    assert.deepEqual(restored.listSyncObservations(), []);
    assert.equal(capture(restored.listWorkspaceBindings()[0]!).acceptedWork, "protected");
    allowedUserId = 7;
    const registration = await sendTelegramBusLocalEnvelope({ socketPath, envelope: {
      kind: "follower.register", requestId: "fresh:1", registration: {
        instanceId: "fresh", cwd: "/fresh", sessionId: "fresh-session", connectedAtMs: 1000,
        registrationGeneration: "fresh:1", protocol: TEST_BUS_PROTOCOL_IDENTITY,
      },
    } });
    assert.equal(registration?.kind === "bus.ack" && registration.ok, true);
    assert.equal(store.getWorkspaceBinding("/fresh", "a", "fresh-session")?.slot, "B");
    assert.ok(store.getWorkspaceBinding("/old/00", "a", "old-session"), "accepted work still protects A");
    assert.deepEqual(effects.filter((effect) => effect.startsWith("delete:")), ["delete:101"]);
    const reopen = await sendTelegramBusLocalEnvelope({ socketPath, envelope: {
      kind: "follower.restoreWorkspace", requestId: "restore:1", registration: {
        instanceId: "reopen", cwd: "/old/02", sessionId: "old-session", connectedAtMs: 1000,
        registrationGeneration: "reopen:1", protocol: TEST_BUS_PROTOCOL_IDENTITY,
      },
    } });
    assert.equal(reopen?.kind === "bus.ack" && reopen.ok, true);
    const rebound = store.getWorkspaceBinding("/old/02", "a", "old-session");
    assert.equal(rebound?.target.threadId, 102);
    assert.equal(rebound?.inactiveSinceMs, undefined);
    assert.deepEqual(effects.filter((effect) => effect.startsWith("delete:")), ["delete:101"]);
    assert.equal(effects.filter((effect) => effect.startsWith("createForumTopic:")).length, 1);
    assert.equal(accepted.length, 1);
    assert.deepEqual(errors, []);
  } finally {
    verifyDetachment = false;
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Preserved follower detachment rechecks external authority at commit and respects retirement admission", async () => {
  for (const race of ["replacement", "epoch", "profile", "revived", "stopped", "fenced"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "pi-telegram-preserved-fence-"));
    const path = join(dir, "state.json");
    const registry = createTelegramBusFollowerRegistry();
    const follower = { instanceId: "old", profileKey: "manual:owner", pid: 42,
      target: { chatId: 7, threadId: 11 }, connectedAtMs: 0, registrationGeneration: "old:1" };
    registry.register(follower);
    let epoch = 1;
    let profile = "default";
    let alive = false;
    let armed = false;
    let loads = 0;
    let stopped: Promise<void> | undefined;
    const admission = createTelegramWorkspaceAdmissionLedger({ path: join(dir, "admission.json"),
      profileKey: "default", owner: { processId: process.pid, processBirthId: `${process.pid}:detachment` },
      getProcessLiveness: () => "alive" });
    const store = createTelegramTopicTargetStore({ path, getNowMs: () => 1000,
      commitPersist(commit) {
        if (armed) {
          if (race === "replacement") registry.register({ ...follower, instanceId: "new", registrationGeneration: "new:1" });
          if (race === "epoch") epoch++;
          if (race === "profile") profile = "other";
          if (race === "revived") alive = true;
          if (race === "stopped") stopped = runtime.stopPolling();
        }
        commit();
        return true;
      },
    });
    const load = store.load;
    store.load = async () => { if (armed) loads++; await load(); };
    store.upsert({ profileKey: follower.profileKey, instanceId: follower.instanceId,
      target: follower.target, status: "active", slot: "A", createdAtMs: 1, updatedAtMs: 1 });
    store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/old")!,
      target: follower.target, slot: "A", updatedAtMs: 1 });
    const events: string[] = [];
    let apiCalls = 0;
    const runtime = createTelegramBusLeaderRuntimeAssembly({
      runtime: { socketPath: join(dir, "bus.sock"), followerRegistry: registry,
        protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY, startPolling() {}, stopPolling() {},
        getNowMs: () => 1000, followerPruneIntervalMs: 5, followerStaleAfterMs: 100,
        isFollowerProcessAlive: () => alive, shouldCleanupConfirmedDeadFollower: () => false },
      instanceId: "leader", getAllowedUserId: () => undefined, topicTargetStore: store,
      getWorkspaceAdmission: () => admission,
      getCurrentLeaderEpoch: () => epoch, getTelegramProfile: () => profile,
      async callApi<TResponse>() { apiCalls++; return true as TResponse; },
      callMultipart: async () => true, downloadFile: async () => undefined,
      getSyncState: () => ({}), setSyncState() {}, setLeaderTarget() {},
      recordRuntimeEvent(_category, _error, details) { events.push(String(details?.phase)); },
    });
    try {
      await store.persist();
      await runtime.startPolling("ctx");
      armed = true;
      if (race === "fenced") assert.equal(admission.acquireRetirementFence({
        operationId: "other-retirement", retirementIntentId: "intent", bindingKey: "other", slot: "B",
        target: { chatId: 7, threadId: 99 }, leaderEpoch: 1, retirementRequestedAtMs: 1,
      }).kind, "acquired");
      await waitForCondition(() => events.some((event) =>
        event === "follower-confirmed-dead-preserved" || event === "follower-confirmed-dead-preserve"), 1000);
      await stopped;
      assert.equal(store.list()[0]?.instanceId, "old", race);
      assert.equal(store.getWorkspaceBinding("/old")?.inactiveSinceMs, undefined, race);
      const disk = createTelegramTopicTargetStore({ path });
      await disk.load();
      assert.equal(disk.list()[0]?.instanceId, "old", race);
      assert.equal(disk.getWorkspaceBinding("/old")?.inactiveSinceMs, undefined, race);
      assert.equal(apiCalls, 0, race);
      if (race === "fenced") assert.equal(loads, 0, "admission rejects before state access");
    } finally {
      armed = false;
      await runtime.stopPolling();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("Bus leader cleans up a stale follower only after its process is confirmed dead and cleanup is enabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-dead-cleanup-"));
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "dead",
    connectedAtMs: 0,
    pid: 4242,
    registrationGeneration: "generation-dead",
    target: { chatId: 7, threadId: 11 },
  });
  const cleaned: string[] = [];
  const runtime = createTelegramBusLeaderRuntime({
    socketPath,
    followerRegistry: registry,
    getNowMs: () => 1000,
    followerPruneIntervalMs: 5,
    followerStaleAfterMs: 100,
    isFollowerProcessAlive: (pid) => pid !== 4242,
    shouldCleanupConfirmedDeadFollower: async () => true,
    onFollowerConfirmedDead: async (follower) => {
      cleaned.push(
        `${follower.instanceId}:${follower.registrationGeneration}:${follower.target?.chatId}:${follower.target?.threadId}`,
      );
    },
    startPolling: () => undefined,
    stopPolling: () => undefined,
  });
  try {
    await runtime.startPolling("ctx");
    await waitForCondition(() => cleaned.length === 1);
    assert.deepEqual(cleaned, ["dead:generation-dead:7:11"]);
  } finally {
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader serializes confirmed-dead cleanup before replacement registration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-dead-race-"));
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "old",
    profileKey: "manual:owner-a",
    connectedAtMs: 0,
    pid: 4242,
    registrationGeneration: "generation-old",
    target: { chatId: 7, threadId: 11 },
    slot: "A",
  });
  let markCleanupStarted: (() => void) | undefined;
  let releaseCleanup: (() => void) | undefined;
  const cleanupStarted = new Promise<void>((resolve) => {
    markCleanupStarted = resolve;
  });
  let provisionStarted = false;
  const runtime = createTelegramBusLeaderRuntime({
    socketPath,
    followerRegistry: registry,
    getNowMs: () => 1000,
    followerPruneIntervalMs: 5,
    followerStaleAfterMs: 100,
    isFollowerProcessAlive: () => false,
    shouldCleanupConfirmedDeadFollower: () => true,
    onFollowerConfirmedDead: async () => {
      markCleanupStarted?.();
      await new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
    },
    provisionFollowerTarget: async (registration) => {
      provisionStarted = true;
      return registration.target;
    },
    startPolling: () => undefined,
    stopPolling: () => undefined,
  });
  try {
    await runtime.startPolling("ctx");
    await cleanupStarted;
    const replacement = sendTelegramBusLocalEnvelope({
      socketPath,
      envelope: {
        kind: "follower.register",
        requestId: "replacement:1",
        registration: {
          instanceId: "replacement",
          profileKey: "manual:owner-a",
          connectedAtMs: 1000,
          registrationGeneration: "generation-new",
          protocol: TEST_BUS_PROTOCOL_IDENTITY,
          target: { chatId: 7, threadId: 12 },
          slot: "B",
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(provisionStarted, false);
    releaseCleanup?.();
    assert.equal((await replacement)?.kind, "bus.ack");
    assert.equal(provisionStarted, true);
    assert.equal(
      registry.get("replacement")?.registrationGeneration,
      "generation-new",
    );
  } finally {
    releaseCleanup?.();
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader preserves stale follower threads without both confirmed death and enabled cleanup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-dead-preserve-"));
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  registry.register({ instanceId: "alive", connectedAtMs: 0, pid: 1 });
  registry.register({ instanceId: "dead-disabled", connectedAtMs: 0, pid: 2,
    registrationGeneration: "dead-disabled:1", target: { chatId: 7, threadId: 11 } });
  registry.register({ instanceId: "unknown", connectedAtMs: 0 });
  registry.register({ instanceId: "invalid-pid", connectedAtMs: 0, pid: 0 });
  registry.register({ instanceId: "liveness-error", connectedAtMs: 0, pid: 3 });
  const cleaned: string[] = [];
  const detached: string[] = [];
  const runtimeEvents: string[] = [];
  const runtime = createTelegramBusLeaderRuntime({
    socketPath,
    followerRegistry: registry,
    getNowMs: () => 1000,
    followerPruneIntervalMs: 5,
    followerStaleAfterMs: 100,
    getCurrentLeaderEpoch: () => 1,
    isFollowerProcessAlive: (pid) => {
      if (pid === 3) throw new Error("liveness unknown");
      return pid === 1;
    },
    shouldCleanupConfirmedDeadFollower: () => false,
    onFollowerConfirmedDead: (follower) => {
      cleaned.push(follower.instanceId);
    },
    onFollowerConfirmedDeadPreserved(follower, isCurrent) {
      assert.equal(isCurrent(), true);
      detached.push(follower.instanceId);
      return true;
    },
    startPolling: () => undefined,
    stopPolling: () => undefined,
    recordRuntimeEvent: (_category, _error, details) => {
      runtimeEvents.push(`${details?.phase}:${details?.instanceId}`);
    },
  });
  try {
    await runtime.startPolling("ctx");
    await waitForCondition(() => registry.list().length === 0);
    assert.deepEqual(cleaned, []);
    assert.deepEqual(detached, ["dead-disabled"]);
    assert.equal(runtimeEvents.includes("follower-pruned:alive"), true);
    assert.equal(
      runtimeEvents.includes("follower-confirmed-dead-preserved:dead-disabled"),
      true,
    );
    assert.equal(runtimeEvents.includes("follower-pruned:unknown"), true);
  } finally {
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader runtime stops stale follower pruning and clears registry on stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-prune-stop-"));
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  let nowMs = 1000;
  registry.register({ instanceId: "stale", connectedAtMs: 0 });
  const runtime = createTelegramBusLeaderRuntime({
    socketPath,
    followerRegistry: registry,
    getNowMs: () => nowMs,
    followerPruneIntervalMs: 50,
    followerStaleAfterMs: 100,
    startPolling: () => undefined,
    stopPolling: () => undefined,
  });
  try {
    await runtime.startPolling("ctx");
    await runtime.stopPolling();
    nowMs = 2000;
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.deepEqual(registry.list(), []);
  } finally {
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader runtime stops the local server if polling startup fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-leader-fail-"));
  const socketPath = join(dir, "bus.sock");
  const runtime = createTelegramBusLeaderRuntime({
    socketPath,
    followerRegistry: createTelegramBusFollowerRegistry(),
    startPolling: () => {
      throw new Error("poll failed");
    },
    stopPolling: () => undefined,
  });
  try {
    await assert.rejects(runtime.startPolling("ctx"), /poll failed/);
    await assert.rejects(
      sendTelegramBusLocalEnvelope({
        socketPath,
        envelope: {
          kind: "follower.heartbeat",
          requestId: "inst-a:1",
          instanceId: "inst-a",
          sentAtMs: 1000,
        },
        timeoutMs: 50,
      }),
    );
  } finally {
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Leader publishes and claims follower session replacement only for exact live authority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-session-replacement-"));
  const path = join(dir, "state.json");
  const target = { chatId: 7, threadId: 42 };
  const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "test",
    capabilities: [TELEGRAM_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT] });
  const legacyProtocol = createTelegramBusProtocolIdentity({ runtimeBuild: "test" });
  try {
    const store = createTelegramTopicTargetStore({ path, getNowMs: () => 1000 });
    store.upsertWorkspaceBinding({
      ...createTelegramWorkspaceBindingIdentity("/follower", 0, "session-old")!,
      target, slot: "B", threadName: "Beacon", updatedAtMs: 1,
    });
    await store.persist();
    const registry = createTelegramBusFollowerRegistry();
    const source = { instanceId: "follower", cwd: "/follower", sessionId: "session-old",
      target, slot: "B", threadName: "Beacon", registrationGeneration: "follower:1",
      protocol, connectedAtMs: 1 };
    registry.register(source);
    let epoch: number | undefined = 1;
    const authority = createTelegramBusFollowerSessionReplacementAuthority({
      store, getNowMs: () => 1000,
    });
    const handler = createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      protocolIdentity: protocol,
      getNowMs: () => 1000,
      getCurrentLeaderEpoch: () => epoch,
      publishFollowerSessionReplacement: authority.publish,
      settleFollowerSessionReplacement: authority.settle,
    });
    const intent = { continuity: "workspace-thread" as const, cwd: "/follower",
      profileName: "default", sourceSessionId: "session-old", sourceUpdateId: 41,
      target, messageId: 99, slot: "B", threadName: "Beacon", createdAtMs: 1000,
      expiresAtMs: 31_000, sourceInstanceId: "follower" };
    let sequence = 0;
    const send = async (
      kind: "follower.publishSessionReplacement" | "follower.settleSessionReplacement",
      request: typeof intent | Omit<typeof intent, "sourceInstanceId">,
      registrationGeneration = "follower:1",
      instanceId = "follower",
    ) => {
      const response = await handler({ kind, requestId: `request:${sequence++}`,
        instanceId, registrationGeneration, intent: request, sentAtMs: 1000 });
      assert.equal(response.kind, "bus.ack");
      return response as Extract<typeof response, { kind: "bus.ack" }>;
    };
    const persisted = async () => {
      const reopened = createTelegramTopicTargetStore({ path });
      await reopened.load();
      return reopened.getSessionReplacementIntent();
    };
    const { sourceInstanceId: _omitted, ...unfenced } = intent;
    for (const [request, generation, instanceId] of [
      [intent, "follower:0", "follower"],
      [intent, "ghost:1", "ghost"],
      [unfenced, "follower:1", "follower"],
      [{ ...intent, sourceInstanceId: "other" }, "follower:1", "follower"],
      [{ ...intent, sourceSessionId: "session-other" }, "follower:1", "follower"],
      [{ ...intent, target: { chatId: 7, threadId: 43 } }, "follower:1", "follower"],
      [{ ...intent, cwd: "/other" }, "follower:1", "follower"],
      [{ ...intent, profileName: "work" }, "follower:1", "follower"],
      [{ ...intent, threadName: "Other" }, "follower:1", "follower"],
      [{ ...intent, createdAtMs: 0, expiresAtMs: 1000 }, "follower:1", "follower"],
      [{ ...intent, expiresAtMs: 31_001 }, "follower:1", "follower"],
    ] as const) {
      const response = await send("follower.publishSessionReplacement",
        request, generation, instanceId);
      assert.equal(response.ok, false, JSON.stringify(request));
    }
    epoch = undefined;
    assert.equal((await send("follower.publishSessionReplacement", intent)).ok, false);
    epoch = 1;
    registry.register({ ...source, protocol: legacyProtocol });
    assert.match((await send("follower.publishSessionReplacement", intent)).message ?? "",
      /compatible leader authority/);
    registry.register(source);
    assert.equal(await persisted(), undefined);

    const published = await send("follower.publishSessionReplacement", intent);
    assert.equal(published.ok, true, published.message);
    assert.deepEqual(published.result, { committed: true });
    assert.deepEqual(await persisted(), intent);
    assert.equal((await send("follower.publishSessionReplacement",
      { ...intent, messageId: 100 })).ok, false);
    assert.equal((await send("follower.settleSessionReplacement", intent)).ok, false);

    registry.register({ ...source, instanceId: "follower-next",
      previousInstanceId: "follower", sessionId: "session-new",
      registrationGeneration: "follower-next:1", connectedAtMs: 2 });
    assert.match((await send("follower.settleSessionReplacement", intent,
      "follower-next:1", "follower-next")).message ?? "", /successor binding is unavailable/);
    await assert.rejects(authority.settle({ ...source, instanceId: "intruder",
      previousInstanceId: "someone", sessionId: "session-new",
      registrationGeneration: "intruder:1", lastHeartbeatMs: 2 }, intent, () => true),
    /successor does not match/);
    assert.equal(store.claimWorkspaceIdentity("/follower", "follower-next", "follower",
      { sessionId: "session-new", existingBindingOnly: true })?.slot, "B");
    await store.persist();
    assert.equal((await send("follower.settleSessionReplacement", intent,
      "follower-next:0", "follower-next")).ok, false);
    assert.deepEqual(await persisted(), intent);
    const settled = await send("follower.settleSessionReplacement", intent,
      "follower-next:1", "follower-next");
    assert.equal(settled.ok, true, settled.message);
    assert.equal(await persisted(), undefined);
    assert.equal((await send("follower.settleSessionReplacement", intent,
      "follower-next:1", "follower-next")).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
