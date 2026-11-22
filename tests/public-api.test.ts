/**
 * Regression tests for public package API exports
 * Zones: package boundary, extension interop
 * Guards stable public subpaths and the removal of deep lib wildcard exports
 */

import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTelegramFollowerApiCallAuthorizer, createTelegramBusFollowerRegistry, createTelegramBusLocalServer, createTelegramBusProtocolIdentity, sendTelegramBusLocalEnvelope, type TelegramBusEnvelope } from "../lib/bus.ts";
import { createTelegramBusArtifactAuthorityCapture, createTelegramBusLeaderEnvelopeHandler } from "../lib/bus-leader.ts";
import { createTelegramBusFollowerRegistrationState, createTelegramBusFollowerApiCaller } from "../lib/bus-follower.ts";
import { createTelegramSessionContextStore } from "../lib/lifecycle.ts";
import { createTelegramLockRuntime, createTelegramLockedPollingRuntime } from "../lib/locks.ts";
import { createTelegramWorkspaceAdmissionLedger } from "../lib/workspace-admission.ts";
import { createTelegramApiTargetActivityRuntime, createTelegramApiTargetTrackingClient, createTelegramApiWorkspaceAdmissionClient } from "../lib/telegram-api.ts";

// Validate the public source membrane without generating coordinator-owned dist during this author cohort.
registerHooks({ resolve(specifier, context, next) {
  return specifier === "@llblab/pi-telegram/delivery" ? { url: new URL("../api/delivery.ts", import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
import test from "node:test";
import { bindTelegramDeliveryRuntime, createTelegramBridgeDeliveryLifecycleHooks, createTelegramBridgeDeliveryRuntime } from "../lib/delivery.ts";
import { createTelegramBusMessageOwnershipRuntime } from "../lib/ownership.ts";
import { createTelegramBusAwareApiRuntime } from "../lib/bus-api.ts";
import { createTelegramBusLeaderApiProxy } from "../lib/bus-leader.ts";
import { TelegramApiAuthorityError, createTelegramApiClient, createTelegramBridgeApiRuntime, setTelegramApiHttpsFetchForTesting } from "../lib/telegram-api.ts";

async function assertPackagePathNotExported(specifier: string): Promise<void> {
  await assert.rejects(
    () => import(specifier),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
  );
}

test("Public package subpaths expose the stable extension API", async () => {
  const [
    root,
    inbound,
    outbound,
    delivery,
    activity,
    updates,
    commands,
    sections,
    status,
    voice,
    keyboard,
  ] = await Promise.all([
    import("@llblab/pi-telegram"),
    import("@llblab/pi-telegram/inbound"),
    import("@llblab/pi-telegram/outbound"),
    import("@llblab/pi-telegram/delivery"),
    import("@llblab/pi-telegram/activity"),
    import("@llblab/pi-telegram/updates"),
    import("@llblab/pi-telegram/commands"),
    import("@llblab/pi-telegram/sections"),
    import("@llblab/pi-telegram/status"),
    import("@llblab/pi-telegram/voice"),
    import("@llblab/pi-telegram/keyboard"),
  ]);

  assert.deepEqual(Object.keys(root), ["default"]);
  assert.deepEqual(Object.keys(inbound).sort(), [
    "registerTelegramInboundHandler",
  ]);
  assert.deepEqual(Object.keys(outbound).sort(), [
    "recordTelegramRuntimeEvent",
    "registerTelegramOutboundHandler",
  ]);
  assert.deepEqual(Object.keys(delivery).sort(), [
    "deleteTelegramView",
    "editTelegramView",
    "openTelegramChoice",
    "openTelegramConfirm",
    "openTelegramTaskView",
    "sendTelegramArtifact",
    "sendTelegramChatAction",
    "sendTelegramView",
  ]);
  assert.deepEqual(Object.keys(activity).sort(), [
    "registerTelegramActivityHandler",
  ]);
  assert.deepEqual(Object.keys(updates).sort(), [
    "assertTelegramUpdateExecutionCurrent",
    "carryTelegramUpdateExecutionFence",
    "createTelegramUpdateExecutionFenceGuard",
    "getTelegramUpdateExecutionFence",
    "registerTelegramUpdateHandler",
  ]);
  assert.deepEqual(Object.keys(commands).sort(), ["registerTelegramCommand"]);
  assert.deepEqual(Object.keys(sections).sort(), [
    "getTelegramSectionDiagnostics",
    "registerTelegramSection",
  ]);
  assert.deepEqual(Object.keys(status).sort(), [
    "registerTelegramStatusLineProvider",
  ]);
  assert.deepEqual(Object.keys(voice).sort(), [
    "TELEGRAM_VOICE_REPLY_MODES",
    "computeVoicePromptContribution",
    "computeVoiceTurnFlags",
    "getTelegramVoiceReplyMode",
    "isVoiceTurn",
    "registerTelegramVoiceSynthesisProvider",
    "registerTelegramVoiceTranscriptionProvider",
    "shouldSuppressPreviewForVoice",
  ]);
  assert.deepEqual(Object.keys(keyboard), []);
});

for (const direct of [false, true]) for (const threaded of [false, true]) {
test(`Public-import Choice consumer uses existing native direct/follower transport (direct=${direct}, Thread=${threaded})`, async () => {
  const { openTelegramChoice } = await import("@llblab/pi-telegram/delivery");
  const target = { chatId: 42, ...(threaded ? { threadId: 7 } : {}) }, payloads: unknown[] = [];
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 501 } }));
  };
  const restoreHttps = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
  const native = createTelegramBridgeApiRuntime({
    client: createTelegramApiClient(() => "123:choice-fixture"), tempDir: "/tmp",
    maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {},
  });
  const proxy = createTelegramBusLeaderApiProxy({ call: native.call, callMultipart: native.callMultipart, downloadFile: native.downloadFile });
  const api = createTelegramBusAwareApiRuntime({ directRuntime: native, ownsDirect: () => direct,
    async callFollowerApi(method, args, localOptions) {
      localOptions?.assertAuthority?.();
      const wire = structuredClone(args); payloads.push(wire);
      const result = await proxy(method, wire);
      localOptions?.assertAuthority?.();
      return result;
    },
  });
  const runtime = createTelegramBridgeDeliveryRuntime({
    generation: "public-choice", getProfileName: () => "default",
    getTargetPolicyView: () => ({ canDeliver: true, ownsDirect: direct, allowedChatId: 42,
      ...(threaded ? direct ? { leaderTarget: { chatId: 42, threadId: 7 } } : { followerTarget: { chatId: 42, threadId: 7 } } : {}) }),
    getActiveTurnTarget: () => undefined, api, recordOwnership() {},
  });
  const unbind = bindTelegramDeliveryRuntime(runtime);
  try {
    const opened = await openTelegramChoice({
      owner: "@example/export", scope: { kind: "instance" }, question: "Choose format",
      choices: [{ id: "json", label: "JSON" }], cancelLabel: "❌ Cancel", timeoutMs: 60_000,
      signal: new AbortController().signal,
    });
    assert.ok(opened.ok);
    assert.deepEqual(opened.handle.target, target);
    assert.equal(requests, 1);
    if (!direct) assert.ok(payloads.length > 0, "Wire arguments are cloneable and carry no local functions");
    const accepted = runtime.acceptChoice!({ data: `tgchoice:${opened.handle.id}:0`, from: { id: 42 },
      message: { chat: { id: 42 }, message_id: 501, ...(threaded ? { message_thread_id: 7 } : {}) } });
    assert.ok(accepted.handled && accepted.accepted);
    await api.answerCallbackQuery("choice", "Selected", { assertLocalAuthority: accepted.assertCurrent });
    assert.deepEqual(await opened.handle.result, { status: "selected", choiceId: "json" });
    await new Promise<void>(resolve => setImmediate(resolve));
  } finally {
    runtime.shutdown(); unbind(); restoreHttps(); globalThis.fetch = previousFetch;
  }
});
}

for (const direct of [false, true]) for (const threaded of [false, true])
test(`Public-import Task View preserves native direct/follower progress and advisory cancellation (direct=${direct}, Thread=${threaded})`, async () => {
  const { openTelegramTaskView } = await import("@llblab/pi-telegram/delivery");
  const target = { chatId: 42, ...(threaded ? { threadId: 7 } : {}) }, payloads: unknown[] = [];
  const previousFetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response(JSON.stringify({ ok: true, result: { message_id: 501 } })); };
  const restoreHttps = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
  const native = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:task-fixture"), tempDir: "/tmp",
    maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
  const proxy = createTelegramBusLeaderApiProxy({ call: native.call, callMultipart: native.callMultipart, downloadFile: native.downloadFile });
  const api = createTelegramBusAwareApiRuntime({ directRuntime: native, ownsDirect: () => direct,
    async callFollowerApi(method, args, localOptions) {
      localOptions?.assertAuthority?.(); const wire = structuredClone(args); payloads.push(wire);
      const value = await proxy(method, wire); localOptions?.assertAuthority?.(); return value;
    },
  });
  const runtime = createTelegramBridgeDeliveryRuntime({ generation: "public-task", getProfileName: () => "default",
    getTargetPolicyView: () => ({ canDeliver: true, ownsDirect: direct, allowedChatId: 42,
      ...(threaded ? direct ? { leaderTarget: target } : { followerTarget: target } : {}) }),
    getActiveTurnTarget: () => undefined, api, recordOwnership() {},
  });
  const unbind = bindTelegramDeliveryRuntime(runtime);
  try {
    const opened = await openTelegramTaskView({ owner: "@example/export", scope: { kind: "instance" }, title: "Export",
      state: { status: "running", text: "Preparing" }, cancellable: true, timeoutMs: 60_000, signal: new AbortController().signal });
    assert.ok(opened.ok); assert.deepEqual(opened.handle.target, target); assert.equal(requests, 1);
    const accepted = runtime.acceptTaskCancel!({ data: `tgtask:${opened.handle.id}:cancel`, from: { id: 42 },
      message: { chat: { id: 42 }, message_id: 501, ...(threaded ? { message_thread_id: 7 } : {}) } });
    assert.ok(accepted.handled && accepted.accepted);
    assert.deepEqual(await opened.handle.cancellation, { status: "requested" });
    await api.answerCallbackQuery("task", "Cancellation requested", { assertLocalAuthority: accepted.assertCurrent });
    assert.equal((await opened.handle.update({ status: "completed", text: "Producer completed before cancellation", progress: 1 })).ok, true);
    assert.deepEqual(await opened.handle.result, { status: "completed" });
    if (!direct) assert.ok(payloads.length >= 3, "Every follower operation crosses cloneable wire arguments, never local callables");
  } finally { runtime.shutdown(); unbind(); restoreHttps(); globalThis.fetch = previousFetch; }
});

for (const threaded of [false, true]) for (const outcome of ["completed", "ownership-lost", "lost-edit-ack"] as const)
test(`Public Task View uses lifecycle/native authenticated follower socket and exact message ownership (Thread=${threaded}, ${outcome})`, async () => {
  const { openTelegramTaskView } = await import("@llblab/pi-telegram/delivery");
  const dir = await mkdtemp(join(tmpdir(), "pt-task-socket-")), socketPath = join(dir, "bus.sock");
  const target = { chatId: 42, ...(threaded ? { threadId: 7 } : {}) }, protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "task-view" });
  const registry = createTelegramBusFollowerRegistry(), state = createTelegramBusFollowerRegistrationState();
  const ownership = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => "default", listFollowers: registry.list });
  const consumer = createTelegramBusMessageOwnershipRuntime({ instanceId: "follower", getProfileKey: () => "default", listFollowers: () => [] });
  const requests: { method: string; body: Record<string, unknown> }[] = [], wire: TelegramBusEnvelope[] = [];
  const previousFetch = globalThis.fetch;
  const fakeFetch: typeof fetch = async (url, init) => {
    const method = String(url).split("/").at(-1)!, body = JSON.parse(String(init!.body)) as Record<string, unknown>;
    requests.push({ method, body });
    if (method === "sendMessage") assert.deepEqual({ chatId: body.chat_id, ...(body.message_thread_id === undefined ? {} : { threadId: body.message_thread_id }) }, target);
    if (method === "editMessageText") { assert.equal(body.chat_id, 42); assert.equal(body.message_id, 501); }
    return new Response(JSON.stringify({ ok: true, result: method === "answerCallbackQuery" ? true : { message_id: 501 } }));
  };
  globalThis.fetch = fakeFetch; const restoreHttps = setTelegramApiHttpsFetchForTesting(fakeFetch);
  const native = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:task-socket"), tempDir: dir,
    maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
  const handler = createTelegramBusLeaderEnvelopeHandler({ followerRegistry: registry, authSecret: "secret", protocolIdentity: protocol,
    provisionFollowerTarget: async () => ({ ...target, ...(threaded ? { slot: "A" } : {}) }), recordFollowerMessageOwnership: ownership.recordFollower,
    authorizeFollowerApiCall: createTelegramFollowerApiCallAuthorizer({ isMessageOwned: ownership.isOwnedByFollower }),
    callApi: createTelegramBusLeaderApiProxy({ call: native.call, callMultipart: native.callMultipart, downloadFile: native.downloadFile }),
  });
  const server = createTelegramBusLocalServer({ socketPath,
    shouldDropResponse: envelope => outcome === "lost-edit-ack" && envelope.kind === "follower.callApi" && envelope.args[0] === "editMessageText",
    handleEnvelope(envelope) { wire.push(structuredClone(envelope)); return handler(envelope); },
  });
  let sequence = 0;
  const caller = createTelegramBusFollowerApiCaller({ socketPath, instanceId: "follower", createRequestId: () => `task-${++sequence}`,
    getAuthSecret: () => "secret", getRegistrationGeneration: state.getGeneration, timeoutMs: outcome === "lost-edit-ack" ? 100 : 1000 });
  const api = createTelegramBusAwareApiRuntime({ directRuntime: native, ownsDirect: () => false, callFollowerApi: caller });
  const hooks = createTelegramBridgeDeliveryLifecycleHooks({ generationSeed: "task-socket", getProfileName: () => "default",
    getTargetPolicyView: () => ({ canDeliver: state.isRegistered(), ownsDirect: false, allowedChatId: 42, followerTarget: state.getTarget() }),
    getActiveTurnTarget: () => undefined, api, recordOwnership: consumer.recordLocal });
  try {
    await server.start();
    const wrongAuth = await sendTelegramBusLocalEnvelope({ socketPath, envelope: { kind: "follower.register", requestId: "bad-auth", auth: "wrong",
      registration: { instanceId: "follower", registrationGeneration: "g1", connectedAtMs: Date.now(), protocol } } });
    assert.ok(wrongAuth?.kind === "bus.ack" && !wrongAuth.ok); assert.equal(requests.length, 0);
    const ack = await sendTelegramBusLocalEnvelope({ socketPath, envelope: { kind: "follower.register", requestId: "register", auth: "secret",
      registration: { instanceId: "follower", registrationGeneration: "g1", sessionId: "task-session", sessionGeneration: 1,
        profileKey: "task-binding", connectedAtMs: Date.now(), protocol } } });
    assert.ok(ack?.kind === "bus.ack" && ack.ok, JSON.stringify(ack)); state.setRegistered(true, target, { generation: "g1", leaderProtocol: protocol });
    await hooks.onSessionStart();
    const opened = await openTelegramTaskView({ owner: "@example/export", scope: { kind: "instance" }, title: "Export",
      state: { status: "running", text: "Preparing" }, cancellable: true, timeoutMs: 60_000, signal: new AbortController().signal });
    assert.ok(opened.ok); assert.equal(requests.length, 1);
    assert.equal(ownership.store.get(42, 501)?.instanceId, "follower"); assert.equal(consumer.store.get(42, 501)?.instanceId, "follower");
    if (outcome === "ownership-lost") ownership.store.clear();
    if (outcome === "completed") {
      const accepted = hooks.acceptTaskCancel({ data: `tgtask:${opened.handle.id}:cancel`, from: { id: 42 },
        message: { chat: { id: 42 }, message_id: 501, ...(threaded ? { message_thread_id: 7 } : {}) } });
      assert.ok(accepted.handled && accepted.accepted); assert.deepEqual(await opened.handle.cancellation, { status: "requested" });
      await api.answerCallbackQuery("task", "Cancellation requested", { assertLocalAuthority: accepted.assertCurrent });
    }
    const changed = await opened.handle.update({ status: "completed", text: "Producer finished", progress: 1 });
    assert.equal(changed.ok, outcome === "completed");
    if (!changed.ok) { assert.equal(changed.effect, "unknown"); assert.deepEqual(await opened.handle.result, { status: "invalidated" }); }
    else assert.deepEqual(await opened.handle.result, { status: "completed" });
    assert.equal(requests.filter(value => value.method === "editMessageText").length, outcome === "ownership-lost" ? 0 : outcome === "lost-edit-ack" ? 1 : 2);
    const before = requests.length;
    assert.equal((await opened.handle.update({ status: "completed", text: "Never replay" })).ok, false);
    await hooks.onSessionShutdown(); assert.equal(requests.length, before);
    assert.ok(wire.some(envelope => envelope.kind === "follower.callApi" && envelope.method === "call"));
    assert.doesNotMatch(JSON.stringify(wire), /assertAuthority|assertLocalAuthority/);
  } finally {
    await hooks.onSessionShutdown(); await server.stop(); restoreHttps(); globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

for (const direct of [true, false]) for (const outcome of [...(direct ? ["sent", "400", "429", "500", "malformed", "ownership-fail", "late-binding", "held-abort"] : ["sent", "400", "429", "500", "malformed", "ownership-fail", "late-binding", "lost-ack", "before-ipc"]), "observer-400", "authority-observer-400", "authority-observer-429", "authority-observer-500", "recovery-observer-400", "recovery-observer-500"])
test(`Public Artifact consumer traverses native ${direct ? "direct" : "authenticated registered socket follower"} activity/Workspace/multipart (${outcome})`, async () => {
  const { sendTelegramArtifact } = await import("@llblab/pi-telegram/delivery") as typeof import("../api/delivery.ts");
  const dir = await mkdtemp(join(tmpdir(), "pt-artifact-public-")), target = { chatId: 42, threadId: 7 }, ctx = { cwd: dir, sessionId: "public-session" };
  const path = join(dir, "private-source"), bytes = Buffer.from([0, 255, 10, 13, 42]);
  await writeFile(path, bytes);
  const lock = createTelegramLockRuntime({ locksPath: join(dir, "owners.json"), instanceId: "leader" });
  const sessions = createTelegramSessionContextStore<typeof ctx>(); sessions.set(ctx);
  const polling = createTelegramLockedPollingRuntime({ lock, hasBotToken: () => true, isContextCurrent: sessions.isCurrent, getSessionId: ctx => ctx.sessionId,
    startPolling() {}, async stopPolling() {}, updateStatus() {} });
  assert.equal((await polling.start(ctx)).ok, true);
  const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "artifact", capabilities: ["artifact-document-v1"] });
  const activity = createTelegramApiTargetActivityRuntime();
  let admissions = 0, releases = 0, requests = 0, ownership = 0;
  const httpEntered = Promise.withResolvers<void>(), releaseHttp = Promise.withResolvers<void>(), drained = Promise.withResolvers<void>();
  const controller = new AbortController();
  const ledger = createTelegramWorkspaceAdmissionLedger({ path: join(dir, "admission.json"), profileKey: "artifact", owner: { processId: process.pid, processBirthId: `${process.pid}:artifact` }, getProcessLiveness: () => "alive" });
  const native = createTelegramBridgeApiRuntime({ client: createTelegramApiTargetTrackingClient(createTelegramApiWorkspaceAdmissionClient(
    createTelegramApiClient(() => "123:artifact"), { acquireAdmission(input) { admissions++; return ledger.acquireAdmission(input); }, releaseAdmission(lease) { releases++; return ledger.releaseAdmission(lease); } }), activity),
    tempDir: dir, maxFileSizeBytes: 1, tempFileMaxAgeMs: 1,
    captureRequestErrorHandler: () => async () => { if (outcome.startsWith("recovery-")) throw new Error("private recovery"); },
    recordRuntimeEvent() { if (outcome.includes("observer")) throw outcome.startsWith("observer-") ? new Error("private observer") : new TelegramApiAuthorityError(false); } });
  const previousFamily = process.env.PI_TELEGRAM_NETWORK_FAMILY;
  process.env.PI_TELEGRAM_NETWORK_FAMILY = "ipv4";
  const previousFetch = globalThis.fetch;
  const fakeFetch: typeof fetch = async (_url, init) => {
    requests++;
    assert.equal(activity.hasPendingTarget(target), true); assert.equal(admissions, 1); assert.equal(releases, 0);
    const body = Buffer.from(init!.body as Uint8Array);
    assert.ok(body.includes(bytes)); assert.ok(body.includes(Buffer.from('filename="résumé.bin"')));
    assert.ok(body.includes(Buffer.from('name="chat_id"\r\n\r\n42')));
    assert.ok(body.includes(Buffer.from('name="message_thread_id"\r\n\r\n7')));
    assert.equal(body.includes(Buffer.from(path)), false);
    httpEntered.resolve();
    if (outcome === "held-abort") await releaseHttp.promise;
    if (outcome === "late-binding") bindTelegramDeliveryRuntime(runtime);
    if (outcome === "malformed") return new Response("invalid");
    const status = /(?:^|-)(400|429|500)$/.test(outcome) ? Number(outcome.slice(-3)) : 200;
    return new Response(JSON.stringify(status === 200 ? { ok: true, result: { message_id: 601 } } : { ok: false, error_code: status, description: "private rejection", parameters: { retry_after: 0 } }), { status });
  };
  globalThis.fetch = fakeFetch;
  const restore = setTelegramApiHttpsFetchForTesting(fakeFetch);
  const registry = createTelegramBusFollowerRegistry(), state = createTelegramBusFollowerRegistrationState(), wire: TelegramBusEnvelope[] = [];
  const deps = { followerRegistry: registry, authSecret: "secret", protocolIdentity: protocol, artifactApi: native,
    captureArtifactTransport: polling.captureCurrentTransportAuthority, getTelegramProfile: () => "default", getAllowedUserId: () => 42,
    provisionFollowerTarget: async () => ({ ...target, slot: "A" }), recordFollowerMessageOwnership() { ownership++; if (outcome === "ownership-fail") throw new Error("private ownership failure"); } };
  const handle = createTelegramBusLeaderEnvelopeHandler(deps), socketPath = join(dir, "bus.sock");
  const server = createTelegramBusLocalServer({ socketPath, captureArtifactAuthority: createTelegramBusArtifactAuthorityCapture(deps),
    shouldDropResponse: envelope => outcome === "lost-ack" && envelope.kind === "follower.callApi",
    handleEnvelope(envelope) { wire.push(structuredClone(envelope)); return handle(envelope); } });
  await server.start();
  const ack = await sendTelegramBusLocalEnvelope({ socketPath, envelope: { kind: "follower.register", requestId: "register", auth: "secret",
    registration: { instanceId: "follower", registrationGeneration: "generation", sessionId: "session", sessionGeneration: 1, profileKey: "artifact-binding", connectedAtMs: Date.now(), protocol } } });
  assert.ok(ack?.kind === "bus.ack" && ack.ok);
  const registration = ack.result as { registrationIncarnation: string };
  state.setRegistered(true, target, { generation: "generation", leaderProtocol: protocol, registrationIncarnation: registration.registrationIncarnation });
  const caller = createTelegramBusFollowerApiCaller({ socketPath, instanceId: "follower", createRequestId: () => "artifact-request", getAuthSecret: () => "secret", getRegistrationGeneration: state.getGeneration, timeoutMs: outcome === "lost-ack" ? 60 : 1000 });
  const api = createTelegramBusAwareApiRuntime({ directRuntime: native, ownsDirect: () => direct, callFollowerApi: caller,
    captureDirectArtifactAuthority: polling.captureCurrentTransportAuthority, captureFollowerArtifactRegistration: state.captureArtifactRegistration,
    artifactProtocol: protocol, getFollowerProtocol: state.getLeaderProtocol });
  const runtime = createTelegramBridgeDeliveryRuntime({ generation: "public-artifact", getProfileName: () => "default",
    captureDrain: () => () => { if (!runtime.hasPendingTarget?.(target)) drained.resolve(); },
    captureArtifactSession: () => { const generation = sessions.getGeneration(); return () => sessions.isCurrent(ctx, generation); },
    getTargetPolicyView: () => ({ canDeliver: true, ownsDirect: direct, allowedChatId: 42, [direct ? "leaderTarget" : "followerTarget"]: target }),
    getActiveTurnTarget: () => undefined, api, recordOwnership() { ownership++; if (outcome === "ownership-fail") throw new Error("private ownership failure"); } });
  const unbind = bindTelegramDeliveryRuntime(runtime);
  try {
    if (outcome === "before-ipc") await server.stop();
    const request = { owner: "producer", scope: { kind: "instance" as const }, file: { path, name: "résumé.bin" }, caption: "<plain>", timeoutMs: 2000, signal: controller.signal };
    const pending = sendTelegramArtifact(request);
    if (outcome === "held-abort") { await httpEntered.promise; controller.abort(); }
    const result = await pending;
    if (outcome === "held-abort") {
      assert.equal(activity.hasPendingTarget(target), true); assert.equal(releases, 0);
      const contended = await sendTelegramArtifact({ ...request, signal: new AbortController().signal });
      assert.ok(!contended.ok); assert.equal(contended.reason, "capacity-exceeded");
      const peer = registry.get("follower")!;
      const mixed = await sendTelegramBusLocalEnvelope({ socketPath, envelope: { kind: "follower.callApi", auth: "secret", requestId: "mixed-after-public-abort", instanceId: peer.instanceId, registrationGeneration: "generation", sentAtMs: 1, method: "sendArtifactDocument",
        args: [{ version: 1, registrationIncarnation: peer.registrationIncarnation, target, fileName: "peer", byteLength: 3, bytesBase64: "YWJj", expiresAt: Date.now() + 5000 }] } });
      assert.ok(mixed?.kind === "bus.ack" && mixed.ok);
      assert.equal((mixed.result as { reason: string }).reason, "capacity-exceeded", "Public abort is not native quiescence for the other route");
      assert.equal(requests, 1); releaseHttp.resolve(); await drained.promise;
    }
    const receipt = { kind: "document", target, generation: "public-artifact", messageId: 601, fileName: "résumé.bin", byteLength: bytes.length };
    if (outcome === "sent") assert.deepEqual(result, { ok: true, receipt });
    else {
      assert.ok(!result.ok); assert.equal(result.effect, outcome === "before-ipc" ? "not-issued" : outcome.endsWith("400") || outcome.endsWith("429") ? "rejected" : "unknown");
      if (outcome === "ownership-fail" || outcome === "late-binding" && direct) assert.deepEqual(result.observedReceipt, receipt);
      assert.doesNotMatch(JSON.stringify(result), /private|source|token/u);
    }
    assert.deepEqual(await readFile(path), bytes); assert.equal(requests, outcome === "before-ipc" ? 0 : 1); assert.equal(releases, outcome === "before-ipc" ? 0 : 1);
    if (outcome === "sent" || outcome === "ownership-fail") assert.ok(ownership >= 1);
    assert.equal(activity.hasPendingTarget(target), false);
    const sent = wire.filter(e => e.kind === "follower.callApi");
    assert.equal(sent.length, direct && outcome !== "held-abort" || outcome === "before-ipc" ? 0 : 1);
    assert.equal(JSON.stringify(sent).includes(path), false);
    if (!direct && outcome === "sent") {
      const repeated = await sendTelegramBusLocalEnvelope({ socketPath, envelope: sent[0]! });
      assert.ok(repeated?.kind === "bus.ack" && repeated.ok); assert.equal(requests, 1, "Exact duplicate shares the retained native attempt");
      registry.register({ ...registry.get("follower")!, connectedAtMs: Date.now() });
      const stale = await sendTelegramBusLocalEnvelope({ socketPath, envelope: sent[0]! });
      assert.ok(stale?.kind === "bus.ack" && !stale.ok); assert.equal(requests, 1, "Pre-cache authority gate rejects stale incarnation");
    }
  } finally {
    releaseHttp.resolve(); unbind(); runtime.shutdown(); await server.stop(); await polling.stop(); restore(); globalThis.fetch = previousFetch;
    if (previousFamily === undefined) delete process.env.PI_TELEGRAM_NETWORK_FAMILY; else process.env.PI_TELEGRAM_NETWORK_FAMILY = previousFamily;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Activity API declares the Pi lifecycle compatibility floor", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { peerDependencies?: Record<string, string> };
  assert.equal(
    packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"],
    ">=1.0.0",
  );
  assert.equal(
    packageJson.peerDependencies?.["@earendil-works/pi-agent-core"],
    ">=1.0.0",
  );
  assert.equal(
    packageJson.peerDependencies?.["@earendil-works/pi-ai"],
    ">=1.0.0",
  );
});

test("Package-private lib implementation paths are not exported", async () => {
  await assertPackagePathNotExported("@llblab/pi-telegram/lib/updates.ts");
  await assertPackagePathNotExported("@llblab/pi-telegram/lib/sections.ts");
  await assertPackagePathNotExported("@llblab/pi-telegram/api/updates.ts");
});
