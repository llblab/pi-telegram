/**
 * Telegram delivery API domain regressions
 * Zones: telegram delivery, extension API, runtime binding
 * Mirrors lib/delivery.ts and protects public operation delegation, generation fencing, and fail-soft availability
 */

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import fileSystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openTelegramTaskView, sendTelegramArtifact, openTelegramChoice, openTelegramConfirm, type TelegramTaskViewRequest, type TelegramChoiceRequest, type TelegramConfirmRequest } from "../api/delivery.ts";
import type { TelegramInlineKeyboardMarkup } from "../lib/keyboard.ts";
import {
  bindTelegramDeliveryRuntime,
  acceptTelegramTaskViewCallback,
  acceptTelegramAttachmentQuestionCallback,
  captureTelegramQuestionLifetimeOwner,
  clearTelegramDeliveryRuntime,
  createTelegramBridgeDeliveryRuntime,
  createTelegramBridgeDeliveryLifecycleHooks,
  createTelegramDeliveryLifecycleHooks,
  createTelegramDeliveryTargetPolicyRuntime,
  createTelegramDeliveryRuntime as createConcreteDeliveryRuntime,
  deleteTelegramView,
  editTelegramView,
  isTelegramDeliveryExplicitTargetAuthorized,
  resolveTelegramDeliveryAggregateTarget,
  resolveTelegramDeliveryInstanceTarget,
  sendTelegramChatAction,
  sendTelegramView,
  readTelegramTextInputReplySource,
  readTelegramAttachmentReplySource,
  type TelegramDeliveryConfirmationCallback,
  type TelegramDeliveryHandle,
  type TelegramDeliveryTarget,
  type TelegramDeliveryRuntime,
  type TelegramDeliveryRuntimeDeps,
  type TelegramQuestionAdmission,
  type TelegramQuestionLifetimeOwner,
  type TelegramTextInputRequest,
  type TelegramAttachmentQuestionRequest,
  type TelegramAttachmentReceiverGuard,
  type TelegramTextInputMessage,
  type TelegramTextInputNonUseObservation,
  type TelegramTextInputReceiverIdentity,
} from "../lib/delivery.ts";
import { TelegramApiCommitUnknownError, TelegramApiAuthorityError } from "../lib/telegram-api.ts";
import { createTelegramBusMessageOwnershipRuntime } from "../lib/ownership.ts";
import { createTelegramBusAwareApiRuntime, createTelegramButtonSelectionAuthorityCapture, createTelegramQuestionAuthorityCapture } from "../lib/bus-api.ts";
import { createTelegramBusLeaderApiProxy, createTelegramBusLeaderEnvelopeHandler } from "../lib/bus-leader.ts";
import { createTelegramFollowerApiCallAuthorizer, createTelegramBusFollowerRegistry, createTelegramBusProtocolIdentity, createTelegramBusLocalServer, TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION,
  TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION, TELEGRAM_BUS_ATTACHMENT_PUBLICATION_RECEIPT } from "../lib/bus.ts";
import { createTelegramBusFollowerApiCaller, createTelegramBusFollowerRegistrationRuntime, createTelegramBusFollowerRegistrationState } from "../lib/bus-follower.ts";
import { createTelegramApiClient, createTelegramBridgeApiRuntime, setTelegramApiHttpsFetchForTesting } from "../lib/telegram-api.ts";

const target = { chatId: 42, threadId: 7 };

for (const outcome of ["sent", "failed", "stopped", "observer-failed", "async-observer-failed"] as const)
test(`Delivery drain follows the last queued operation and keeps shutdown inert (${outcome})`, async () => {
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  let notifications = 0;
  const runtime = createConcreteDeliveryRuntime({
    generation: "drain", getActiveTurnTarget: () => target, getInstanceTarget: () => target,
    getAggregateTarget: () => target, isExplicitTargetAuthorized: () => true,
    renderView: view => [{ text: view.text, parseMode: "plain" }],
    async sendChunk() { entered.resolve(); await finish.promise; if (outcome === "failed") throw new Error("transport"); return 1; },
    async editChunk() {}, async deleteMessage() {}, async sendChatAction() {},
    captureDrain: () => () => {
      assert.equal(runtime.hasPendingTarget?.(target), false);
      if (outcome === "observer-failed") throw new Error("observer");
      if (outcome === "async-observer-failed") return Promise.reject(new Error("observer"));
      notifications++;
    },
  });
  const first = runtime.sendView({ text: "first" }, { scope: { kind: "target", target } });
  await entered.promise;
  const last = runtime.sendView({ text: "last" }, { scope: { kind: "target", target } });
  assert.equal(notifications, 0);
  if (outcome === "stopped") runtime.shutdown();
  finish.resolve();
  const results = await Promise.all([first, last]);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(notifications, outcome === "sent" || outcome === "failed" ? 1 : 0);
  assert.equal(runtime.hasPendingTarget?.(target), false);
  assert.equal(results[0]!.ok, !["failed", "stopped"].includes(outcome));
  runtime.shutdown();
});

function createRuntime(
  generation: string,
  calls: string[] = [],
): TelegramDeliveryRuntime {
  return {
    generation,
    shutdown() {},
    async sendView() {
      calls.push("send");
      return {
        ok: true,
        value: { target, messageIds: [11], generation },
      };
    },
    async editView() {
      calls.push("edit");
      return {
        ok: true,
        value: { target, messageIds: [11], generation },
      };
    },
    async deleteView() {
      calls.push("delete");
      return { ok: true, value: undefined };
    },
    async sendChatAction(action) {
      calls.push(`action:${action}`);
      return { ok: true, value: undefined };
    },
  };
}

function handle(generation: string): TelegramDeliveryHandle {
  return { target, messageIds: [11], generation };
}

test.afterEach(() => clearTelegramDeliveryRuntime());

for (const fault of ["none", "binding", "turn", "profile", "target", "session", "abort", "timeout"] as const)
test(`Artifact capacity, queue snapshot and original authority are nonrenewing (${fault})`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pt-artifact-delivery-")), path = join(dir, "source");
  await writeFile(path, "captured");
  let turn = {}, profile = "default", session = true, currentTarget = { ...target }, sends = 0;
  const captureDone = Promise.withResolvers<void>(), actualOpen = fileSystem.open;
  const openMock = mock.method(fileSystem, "open", async (...args: Parameters<typeof actualOpen>) => {
    const fd = await actualOpen(...args), close = fd.close.bind(fd);
    fd.close = async () => { await close(); captureDone.resolve(); };
    return fd;
  });
  syncBuiltinESMExports();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const controller = new AbortController();
  const api = {
    async sendMessage() { entered.resolve(); await release.promise; return { message_id: 1 }; },
    async editMessageText() { return "edited" as const; }, async deleteMessage() {}, async sendChatAction() { return true; },
    captureArtifactTransport() { return { isCurrent: () => true, async send(input: { bytes: Uint8Array; assertAuthority: () => void }) {
      input.assertAuthority(); sends++; assert.equal(Buffer.from(input.bytes).toString(), "captured"); return { effect: "sent" as const, reason: "sent", messageId: 2 };
    } }; },
  };
  const runtime = createTelegramBridgeDeliveryRuntime({ generation: "artifact", api, getProfileName: () => profile,
    captureArtifactSession: () => () => session, getActiveTurnIdentity: () => turn, getActiveTurnTarget: () => currentTarget,
    getTargetPolicyView: () => ({ canDeliver: true, ownsDirect: true, allowedChatId: 42, leaderTarget: currentTarget }), recordOwnership() {} });
  const unbind = bindTelegramDeliveryRuntime(runtime);
  try {
    const view = runtime.sendView({ text: "hold queue" }, { scope: { kind: "instance" } });
    await entered.promise;
    const request = { owner: "export", scope: { kind: "active-turn" as const }, file: { path, name: "named.bin" }, timeoutMs: fault === "timeout" ? 25 : 2000, signal: controller.signal };
    const pending = sendTelegramArtifact(request);
    const contended = await sendTelegramArtifact(request);
    assert.ok(!contended.ok); assert.equal(contended.reason, "capacity-exceeded");
    await captureDone.promise;
    await writeFile(path, "mutated"); request.file.name = "wrong.bin";
    if (fault === "binding") bindTelegramDeliveryRuntime(runtime);
    if (fault === "turn") turn = {};
    if (fault === "profile") profile = "other";
    if (fault === "target") currentTarget = { chatId: 42, threadId: 99 };
    if (fault === "session") session = false;
    if (fault === "abort") controller.abort();
    if (fault === "timeout") await new Promise(resolve => setTimeout(resolve, 30));
    release.resolve(); await view;
    const result = await pending;
    assert.equal(result.ok, fault === "none"); assert.equal(sends, fault === "none" ? 1 : 0);
    if (result.ok) assert.equal(result.receipt.fileName, "named.bin"); else assert.equal(result.effect, "not-issued");
  } finally { release.resolve(); unbind(); runtime.shutdown(); openMock.mock.restore(); syncBuiltinESMExports(); await rm(dir, { recursive: true, force: true }); }
});

test("Artifact logical timeout retains descriptor/capacity until pending native read cleanup without late upload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pt-artifact-pending-")), path = join(dir, "source");
  await writeFile(path, "original");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>();
  const keepAlive = setInterval(() => {}, 1000);
  const originalOpen = fileSystem.open; let closing = false, sends = 0;
  const mocked = mock.method(fileSystem, "open", async (...args: Parameters<typeof originalOpen>) => {
    const fd = await originalOpen(...args), read = fd.read.bind(fd), close = fd.close.bind(fd);
    fd.read = (async (...readArgs: unknown[]) => { const result = await Reflect.apply(read, fd, readArgs); entered.resolve(); await release.promise; return result; }) as typeof fd.read;
    fd.close = async () => { closing = true; await close(); closed.resolve(); };
    return fd;
  });
  syncBuiltinESMExports();
  const runtime = createConcreteDeliveryRuntime({ generation: "pending-read", getActiveTurnTarget: () => target, getInstanceTarget: () => target,
    getAggregateTarget: () => target, isExplicitTargetAuthorized: () => true, renderView: () => [], async sendChunk() { return 1; }, async editChunk() {}, async deleteMessage() {}, async sendChatAction() {},
    captureArtifactTransport: () => ({ isCurrent: () => true, async send() { sends++; return { effect: "sent", reason: "sent", messageId: 2 }; } }) });
  const unbind = bindTelegramDeliveryRuntime(runtime), request = { owner: "read", scope: { kind: "instance" as const }, file: { path, name: "file" }, timeoutMs: 30, signal: new AbortController().signal };
  try {
    const pending = sendTelegramArtifact(request); await entered.promise;
    const result = await pending; assert.ok(!result.ok); assert.equal(result.reason, "expired"); assert.equal(result.effect, "not-issued");
    assert.equal(closing, false); assert.equal(runtime.hasPendingTarget?.(target), true);
    const contended = await sendTelegramArtifact(request); assert.ok(!contended.ok); assert.equal(contended.reason, "capacity-exceeded");
    runtime.shutdown(); release.resolve(); await closed.promise; await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(sends, 0); assert.equal(runtime.hasPendingTarget?.(target), false);
  } finally { release.resolve(); clearInterval(keepAlive); mocked.mock.restore(); syncBuiltinESMExports(); unbind(); runtime.shutdown(); await rm(dir, { recursive: true, force: true }); }
});

test("Artifact optional port and invalid declarations refuse before any source or transport work", async () => {
  const request = { owner: "export", scope: { kind: "instance" as const }, file: { path: "/not/read", name: "file" }, timeoutMs: 10, signal: new AbortController().signal };
  bindTelegramDeliveryRuntime(createRuntime("old"));
  const missing = await sendTelegramArtifact(request); assert.ok(!missing.ok); assert.equal(missing.reason, "runtime-unavailable");
  for (const name of ["", " ", ".", "..", "a/b", "a\\b", "a\n", "\ud800", "ü".repeat(128)])
    assert.throws(() => sendTelegramArtifact({ ...request, file: { path: "/not/read", name } }), TypeError);
  for (const timeoutMs of [0, 300001, 1.5, NaN]) assert.throws(() => sendTelegramArtifact({ ...request, timeoutMs }), TypeError);
  assert.throws(() => sendTelegramArtifact({ ...request, caption: "x".repeat(1025) }), TypeError);
  assert.throws(() => sendTelegramArtifact({ ...request, file: { path: "relative", name: "file" } }), TypeError);
});

test("Delivery API fails softly while no runtime is bound", async () => {
  const result = await sendTelegramView(
    { text: "hello" },
    { scope: { kind: "instance" } },
  );
  assert.deepEqual(result, {
    ok: false,
    reason: "runtime-unavailable",
    message: "Telegram delivery runtime is unavailable in this Pi session.",
  });
});

test("Delivery API delegates operations to the current runtime", async () => {
  const calls: string[] = [];
  bindTelegramDeliveryRuntime(createRuntime("one", calls));
  const sent = await sendTelegramView(
    { text: "hello", parseMode: "html" },
    { scope: { kind: "active-turn" }, replyToMessageId: 5 },
  );
  assert.equal(sent.ok, true);
  await editTelegramView(handle("one"), { text: "updated" });
  await deleteTelegramView(handle("one"));
  await sendTelegramChatAction("typing", {
    scope: { kind: "aggregate" },
  });
  assert.deepEqual(calls, ["send", "edit", "delete", "action:typing"]);
});

test("Delivery API rejects empty views before transport", async () => {
  const calls: string[] = [];
  bindTelegramDeliveryRuntime(createRuntime("one", calls));
  const result = await sendTelegramView(
    { text: "  " },
    { scope: { kind: "instance" } },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid-view");
  assert.deepEqual(calls, []);
});

test("Delivery API fences handles from older runtime generations", async () => {
  const calls: string[] = [];
  bindTelegramDeliveryRuntime(createRuntime("new", calls));
  const edited = await editTelegramView(handle("old"), { text: "updated" });
  const deleted = await deleteTelegramView(handle("old"));
  assert.equal(edited.ok, false);
  assert.equal(deleted.ok, false);
  if (!edited.ok) assert.equal(edited.reason, "stale-handle");
  if (!deleted.ok) assert.equal(deleted.reason, "stale-handle");
  assert.deepEqual(calls, []);
});

test("A stale runtime disposer cannot clear its replacement", async () => {
  const firstCalls: string[] = [];
  const secondCalls: string[] = [];
  const disposeFirst = bindTelegramDeliveryRuntime(
    createRuntime("first", firstCalls),
  );
  bindTelegramDeliveryRuntime(createRuntime("second", secondCalls));
  disposeFirst();
  await sendTelegramView(
    { text: "hello" },
    { scope: { kind: "instance" } },
  );
  assert.deepEqual(firstCalls, []);
  assert.deepEqual(secondCalls, ["send"]);
});

test("Delivery lifecycle mints fresh generations and invalidates on shutdown", async () => {
  const calls: string[] = [];
  let sequence = 0;
  const lifecycle = createTelegramDeliveryLifecycleHooks(() =>
    createRuntime(`generation-${++sequence}`, calls),
  );
  await lifecycle.onSessionStart();
  const active = await sendTelegramView(
    { text: "hello" },
    { scope: { kind: "instance" } },
  );
  assert.equal(active.ok, true);
  if (!active.ok) return;

  await lifecycle.onSessionShutdown();
  const stopped = await sendTelegramView(
    { text: "hello" },
    { scope: { kind: "instance" } },
  );
  assert.equal(stopped.ok, false);
  if (!stopped.ok) assert.equal(stopped.reason, "runtime-unavailable");

  await lifecycle.onSessionStart();
  const replacement = await sendTelegramView(
    { text: "replacement" },
    { scope: { kind: "instance" } },
  );
  assert.equal(replacement.ok, true);
  if (replacement.ok) {
    assert.notEqual(replacement.value.generation, active.value.generation);
  }
  const staleEdit = await editTelegramView(active.value, { text: "stale" });
  const staleDelete = await deleteTelegramView(active.value);
  assert.equal(staleEdit.ok, false);
  assert.equal(staleDelete.ok, false);
  if (!staleEdit.ok) assert.equal(staleEdit.reason, "stale-handle");
  if (!staleDelete.ok) assert.equal(staleDelete.reason, "stale-handle");
  assert.deepEqual(calls, ["send", "send"]);
});

test("Delivery shutdown fences an in-flight chunk sequence and queued work", async () => {
  const transportCalls: string[] = [];
  let releaseFirstChunk: (() => void) | undefined;
  let markFirstChunkStarted: (() => void) | undefined;
  const firstChunkGate = new Promise<void>((resolve) => {
    releaseFirstChunk = resolve;
  });
  const firstChunkStarted = new Promise<void>((resolve) => {
    markFirstChunkStarted = resolve;
  });
  const runtime = createConcreteDeliveryRuntime({
    generation: "generation-one",
    getActiveTurnTarget: () => target,
    getInstanceTarget: () => target,
    getAggregateTarget: () => ({ chatId: target.chatId }),
    isExplicitTargetAuthorized: () => true,
    renderView: () => [
      { text: "first", parseMode: "html" },
      { text: "second", parseMode: "html" },
    ],
    async sendChunk() {
      transportCalls.push("send");
      if (transportCalls.length === 1) {
        markFirstChunkStarted?.();
        await firstChunkGate;
      }
      return 100 + transportCalls.length;
    },
    async editChunk() {
      transportCalls.push("edit");
    },
    async deleteMessage() {
      transportCalls.push("delete");
    },
    async sendChatAction() {
      transportCalls.push("action");
    },
  });

  const inFlight = runtime.sendView(
    { text: "two chunks" },
    { scope: { kind: "instance" } },
  );
  await firstChunkStarted;
  const queued = runtime.sendChatAction("typing", { kind: "instance" });
  runtime.shutdown();
  releaseFirstChunk?.();

  const [inFlightResult, queuedResult] = await Promise.all([inFlight, queued]);
  assert.equal(inFlightResult.ok, false);
  assert.equal(queuedResult.ok, false);
  if (!inFlightResult.ok) {
    assert.equal(inFlightResult.reason, "runtime-unavailable");
  }
  if (!queuedResult.ok) assert.equal(queuedResult.reason, "runtime-unavailable");
  assert.deepEqual(transportCalls, ["send"]);
});

test("Delivery API converts unexpected runtime errors into transport failures", async () => {
  const runtime = createRuntime("one");
  runtime.sendView = async () => {
    throw new Error("secret transport detail");
  };
  bindTelegramDeliveryRuntime(runtime);
  const result = await sendTelegramView(
    { text: "hello" },
    { scope: { kind: "instance" } },
  );
  assert.deepEqual(result, {
    ok: false,
    reason: "transport-failed",
    message: "Telegram delivery failed.",
  });
});

test("Delivery target policy runtime projects live authority and excludes Guest turns", () => {
  let ownsDirect = false;
  let followerRegistered = true;
  let guestQueryId: string | undefined;
  const runtime = createTelegramDeliveryTargetPolicyRuntime({
    ownsDirect: () => ownsDirect,
    isFollowerRegistered: () => followerRegistered,
    getAllowedChatId: () => 42,
    getFollowerTarget: () => ({ chatId: 42, threadId: 7 }),
    getLeaderTarget: () => ({ chatId: 42, threadId: 8 }),
    listThreadRecords: () => [
      { target: { chatId: 42, threadId: 7 } },
      { target: { chatId: 42, threadId: 8 } },
    ],
    getActiveTurnTarget: () => ({ chatId: 42, threadId: 7 }),
    getActiveGuestQueryId: () => guestQueryId,
  });

  assert.deepEqual(runtime.getTargetPolicyView(), {
    canDeliver: true,
    ownsDirect: false,
    threaded: false,
    allowedChatId: 42,
    followerTarget: { chatId: 42, threadId: 7 },
    leaderTarget: { chatId: 42, threadId: 8 },
    liveTargets: [
      { chatId: 42, threadId: 7 },
      { chatId: 42, threadId: 8 },
    ],
  });
  assert.deepEqual(runtime.getActiveTurnTarget(), {
    chatId: 42,
    threadId: 7,
  });
  guestQueryId = "guest";
  assert.equal(runtime.getActiveTurnTarget(), undefined);
  followerRegistered = false;
  ownsDirect = false;
  assert.equal(runtime.getTargetPolicyView().canDeliver, false);
});

test("Threaded delivery refuses implicit and explicit All scopes, even without a bound tab", async () => {
  let threaded = true;
  const sent: unknown[] = [];
  const policy = createTelegramDeliveryTargetPolicyRuntime({ ownsDirect: () => true, isThreadedMode: () => threaded,
    isFollowerRegistered: () => false, getAllowedChatId: () => 7, getFollowerTarget: () => undefined,
    getLeaderTarget: () => undefined, listThreadRecords: () => [], getActiveTurnTarget: () => ({ chatId: 7 }), getActiveGuestQueryId: () => undefined });
  const runtime = createTelegramBridgeDeliveryRuntime({ generation: "All-policy", getTargetPolicyView: policy.getTargetPolicyView,
    getActiveTurnTarget: policy.getActiveTurnTarget, api: { async sendMessage(body) { sent.push(body); return { message_id: 1 }; },
      async editMessageText(body) { sent.push(body); return "edited"; }, async deleteMessage() {}, async sendChatAction() { return true; } }, recordOwnership() {} });
  for (const scope of [{ kind: "instance" }, { kind: "aggregate" }, { kind: "active-turn" }, { kind: "target", target: { chatId: 7 } }] as const)
    assert.equal((await runtime.sendView({ text: "No All output" }, { scope })).ok, false);
  assert.deepEqual(sent, []);
  threaded = false;
  const classic = await runtime.sendView({ text: "Classic DM" }, { scope: { kind: "instance" } }); assert.equal(classic.ok, true);
  if (!classic.ok) return;
  threaded = true;
  assert.equal((await runtime.editView(classic.value, { text: "Cannot migrate into All" })).ok, false);
  assert.equal(sent.length, 1, "An old classic handle cannot emit fresh output after Threaded Mode activates");
});

test("Delivery target policy resolves classic, leader, and follower instance surfaces", () => {
  assert.deepEqual(
    resolveTelegramDeliveryInstanceTarget({
      canDeliver: true,
      ownsDirect: true,
      allowedChatId: 42,
    }),
    { chatId: 42 },
  );
  assert.deepEqual(
    resolveTelegramDeliveryInstanceTarget({
      canDeliver: true,
      ownsDirect: true,
      allowedChatId: 42,
      leaderTarget: { chatId: 42, threadId: 3 },
    }),
    { chatId: 42, threadId: 3 },
  );
  assert.deepEqual(
    resolveTelegramDeliveryInstanceTarget({
      canDeliver: true,
      ownsDirect: false,
      allowedChatId: 42,
      followerTarget: { chatId: 42, threadId: 7 },
    }),
    { chatId: 42, threadId: 7 },
  );
  assert.deepEqual(
    resolveTelegramDeliveryAggregateTarget({
      canDeliver: true,
      ownsDirect: false,
      allowedChatId: 42,
    }),
    { chatId: 42 },
  );
});

test("Delivery target policy restricts follower and leader explicit targets", () => {
  const followerView = {
    canDeliver: true,
    ownsDirect: false,
    allowedChatId: 42,
    followerTarget: { chatId: 42, threadId: 7 },
  };
  assert.equal(
    isTelegramDeliveryExplicitTargetAuthorized(
      { chatId: 42, threadId: 7 },
      followerView,
    ),
    true,
  );
  assert.equal(
    isTelegramDeliveryExplicitTargetAuthorized(
      { chatId: 42, threadId: 8 },
      followerView,
    ),
    false,
  );
  const leaderView = {
    canDeliver: true,
    ownsDirect: true,
    allowedChatId: 42,
    leaderTarget: { chatId: 42, threadId: 3 },
    liveTargets: [{ chatId: 42, threadId: 8 }],
  };
  assert.equal(
    isTelegramDeliveryExplicitTargetAuthorized(
      { chatId: 42, threadId: 8 },
      leaderView,
    ),
    true,
  );
  assert.equal(
    isTelegramDeliveryExplicitTargetAuthorized({ chatId: 99 }, leaderView),
    false,
  );
});

function createConcreteRuntimeHarness(
  overrides: Partial<TelegramDeliveryRuntimeDeps> = {},
) {
  let nextMessageId = 100;
  const events: Array<Record<string, unknown>> = [];
  const deps: TelegramDeliveryRuntimeDeps = {
    generation: "generation-one",
    getActiveTurnTarget: () => target,
    getInstanceTarget: () => target,
    getAggregateTarget: () => ({ chatId: target.chatId }),
    isExplicitTargetAuthorized: (candidate) => candidate.chatId === target.chatId,
    renderView: (view) =>
      view.text.split("|").map((text) => ({
        text,
        parseMode: view.parseMode ?? "plain",
      })),
    async sendChunk(deliveryTarget, chunk, options) {
      nextMessageId += 1;
      events.push({ type: "send", deliveryTarget, chunk, options, messageId: nextMessageId });
      return nextMessageId;
    },
    async editChunk(deliveryTarget, messageId, chunk, options) {
      events.push({ type: "edit", deliveryTarget, messageId, chunk, options });
    },
    async deleteMessage(deliveryTarget, messageId) {
      events.push({ type: "delete", deliveryTarget, messageId });
    },
    async sendChatAction(deliveryTarget, action) {
      events.push({ type: "action", deliveryTarget, action });
    },
    ...overrides,
  };
  return { runtime: createConcreteDeliveryRuntime(deps), events, deps };
}

test("Bridge delivery runtime owns rendering and bus-aware transport adaptation", async () => {
  const sentBodies: Array<Record<string, unknown>> = [];
  const ownership: Array<Record<string, unknown>> = [];
  const runtime = createTelegramBridgeDeliveryRuntime({
    generation: "generation-one",
    getTargetPolicyView: () => ({
      canDeliver: true,
      ownsDirect: true,
      allowedChatId: 42,
      leaderTarget: target,
    }),
    getActiveTurnTarget: () => target,
    api: {
      async sendMessage(body) {
        sentBodies.push(body);
        return { message_id: 101 };
      },
      async editMessageText() {
        return "edited";
      },
      async deleteMessage() {},
      async sendChatAction() {
        return true;
      },
    },
    recordOwnership(input) {
      ownership.push(input);
    },
  });

  const result = await runtime.sendView(
    { text: "<b>Working</b>", parseMode: "html" },
    { scope: { kind: "active-turn" }, replyToMessageId: 9 },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(sentBodies, [
    {
      chat_id: 42,
      text: "<b>Working</b>",
      parse_mode: "HTML",
      message_thread_id: 7,
      reply_parameters: {
        message_id: 9,
        allow_sending_without_reply: true,
      },
    },
  ]);
  assert.deepEqual(ownership, [
    { chatId: 42, messageId: 101, target },
  ]);
});

test("Bridge delivery runtime rejects work after transport generation replacement", async () => {
  let transportActive = true;
  let apiCalls = 0;
  const runtime = createTelegramBridgeDeliveryRuntime({
    generation: "generation-one",
    isTransportActive: () => transportActive,
    getTargetPolicyView: () => ({
      canDeliver: true,
      ownsDirect: true,
      allowedChatId: 42,
      leaderTarget: target,
    }),
    getActiveTurnTarget: () => target,
    api: {
      async sendMessage() {
        apiCalls += 1;
        return { message_id: 101 };
      },
      async editMessageText() {
        apiCalls += 1;
        return "edited";
      },
      async deleteMessage() {
        apiCalls += 1;
      },
      async sendChatAction() {
        apiCalls += 1;
        return true;
      },
    },
    recordOwnership() {},
  });
  transportActive = false;

  const result = await runtime.sendView(
    { text: "stale" },
    { scope: { kind: "instance" } },
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "runtime-unavailable");
  assert.equal(apiCalls, 0);
});

test("Concrete delivery runtime resolves scopes and rejects unauthorized targets", async () => {
  const { runtime, events } = createConcreteRuntimeHarness();
  const sent = await runtime.sendView(
    { text: "hello" },
    { scope: { kind: "instance" } },
  );
  const denied = await runtime.sendView(
    { text: "hello" },
    { scope: { kind: "target", target: { chatId: 99 } } },
  );
  assert.equal(sent.ok, true);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.reason, "target-unauthorized");
  assert.equal(events.length, 1);
});

test("Concrete delivery runtime keeps active-turn, instance, and aggregate scopes distinct", async () => {
  const activeTurnTarget = { chatId: 42, threadId: 7 };
  const instanceTarget = { chatId: 42, threadId: 3 };
  const aggregateTarget = { chatId: 42 };
  const { runtime, events } = createConcreteRuntimeHarness({
    getActiveTurnTarget: () => activeTurnTarget,
    getInstanceTarget: () => instanceTarget,
    getAggregateTarget: () => aggregateTarget,
  });

  await runtime.sendView(
    { text: "turn" },
    { scope: { kind: "active-turn" } },
  );
  await runtime.sendView(
    { text: "instance" },
    { scope: { kind: "instance" } },
  );
  await runtime.sendView(
    { text: "all" },
    { scope: { kind: "aggregate" } },
  );

  assert.deepEqual(
    events.map((event) => event.deliveryTarget),
    [activeTurnTarget, instanceTarget, aggregateTarget],
  );
});

test("Concrete delivery runtime anchors first chunk and keyboard on last chunk", async () => {
  const { runtime, events } = createConcreteRuntimeHarness();
  const replyMarkup = {
    inline_keyboard: [[{ text: "Run", callback_data: "demo:run" }]],
  };
  const result = await runtime.sendView(
    { text: "one|two", parseMode: "html", replyMarkup },
    { scope: { kind: "active-turn" }, replyToMessageId: 9 },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    events.map((event) => event.options),
    [{ replyToMessageId: 9 }, { replyMarkup }],
  );
  if (result.ok) assert.deepEqual(result.value.messageIds, [101, 102]);
});

test("Concrete delivery runtime keeps handles opaque and deeply immutable", async () => {
  const { runtime } = createConcreteRuntimeHarness();
  const sent = await runtime.sendView(
    { text: "hello" },
    { scope: { kind: "instance" } },
  );
  assert.equal(sent.ok, true);
  if (!sent.ok) return;
  assert.equal(Object.isFrozen(sent.value), true);
  assert.equal(Object.isFrozen(sent.value.target), true);
  assert.equal(Object.isFrozen(sent.value.messageIds), true);
  assert.throws(() => {
    (sent.value.target as { threadId?: number }).threadId = 999;
  }, TypeError);
  const forged = {
    ...sent.value,
    target: { ...sent.value.target },
    messageIds: [...sent.value.messageIds],
  };
  const edited = await runtime.editView(forged, { text: "forged" });
  assert.equal(edited.ok, false);
  if (!edited.ok) assert.equal(edited.reason, "stale-handle");
});

test("Concrete delivery runtime exposes non-idempotent commit-unknown outcomes", async () => {
  const { runtime } = createConcreteRuntimeHarness({
    async sendChunk() {
      throw new TelegramApiCommitUnknownError(
        "sendMessage",
        new TypeError("fetch failed"),
      );
    },
  });
  const result = await runtime.sendView(
    { text: "hello" },
    { scope: { kind: "target", target } },
  );
  assert.deepEqual(result, {
    ok: false,
    reason: "commit-unknown",
    message: "Telegram delivery send may have committed before transport failed.",
  });
});

test("Concrete delivery runtime returns a recoverable handle after partial send failure", async () => {
  let sendCount = 0;
  const deleted: number[] = [];
  const { runtime } = createConcreteRuntimeHarness({
    async sendChunk() {
      sendCount += 1;
      if (sendCount === 2) throw new Error("second chunk failed");
      return 101;
    },
    async deleteMessage(_deliveryTarget, messageId) {
      deleted.push(messageId);
    },
  });

  const result = await runtime.sendView(
    { text: "one|two" },
    { scope: { kind: "instance" } },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "transport-failed");
  assert.deepEqual(result.partial?.messageIds, [101]);
  assert.equal(result.partial?.generation, "generation-one");
  assert.deepEqual(result.partial?.target, target);
  assert.ok(result.partial);
  const cleanup = await runtime.deleteView(result.partial);
  assert.equal(cleanup.ok, true);
  assert.deepEqual(deleted, [101]);
});

test("Concrete delivery runtime returns all visible ids after edit growth failure", async () => {
  let growthSendCount = 0;
  const deleted: number[] = [];
  const { runtime } = createConcreteRuntimeHarness({
    async sendChunk() {
      growthSendCount += 1;
      if (growthSendCount === 3) throw new Error("growth chunk failed");
      return growthSendCount === 1 ? 11 : 12;
    },
    async deleteMessage(_deliveryTarget, messageId) {
      deleted.push(messageId);
    },
  });
  const initial = await runtime.sendView(
    { text: "one" },
    { scope: { kind: "instance" } },
  );
  assert.equal(initial.ok, true);
  if (!initial.ok) return;
  const result = await runtime.editView(initial.value, {
    text: "one|two|three",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "transport-failed");
  assert.deepEqual(result.partial?.messageIds, [11, 12]);
  assert.ok(result.partial);
  const cleanup = await runtime.deleteView(result.partial);
  assert.equal(cleanup.ok, true);
  assert.deepEqual(deleted, [11, 12]);
});

test("Concrete delivery runtime removes already-deleted ids from partial edit recovery", async () => {
  const deleteCalls: number[] = [];
  let failedOnce = false;
  const { runtime } = createConcreteRuntimeHarness({
    async deleteMessage(_deliveryTarget, messageId) {
      deleteCalls.push(messageId);
      if (messageId === 103 && !failedOnce) {
        failedOnce = true;
        throw new Error("shrink delete failed");
      }
    },
  });
  const initial = await runtime.sendView(
    { text: "one|two|three" },
    { scope: { kind: "instance" } },
  );
  assert.equal(initial.ok, true);
  if (!initial.ok) return;
  const result = await runtime.editView(initial.value, { text: "one" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.partial?.messageIds, [101, 103]);
  assert.ok(result.partial);
  const cleanup = await runtime.deleteView(result.partial);
  assert.equal(cleanup.ok, true);
  assert.deepEqual(deleteCalls, [102, 103, 101, 103]);
});

test("Concrete delivery runtime reconciles logical view growth and shrink", async () => {
  const { runtime, events } = createConcreteRuntimeHarness();
  const initial = await runtime.sendView(
    { text: "one" },
    { scope: { kind: "instance" } },
  );
  assert.equal(initial.ok, true);
  if (!initial.ok) return;
  events.length = 0;
  const grown = await runtime.editView(initial.value, { text: "one|two" });
  assert.equal(grown.ok, true);
  assert.deepEqual(
    events.map((event) => event.type),
    ["edit", "send"],
  );
  assert.deepEqual(events[0]?.options, { replyMarkup: null });
  if (!grown.ok) return;
  events.length = 0;
  const shrunk = await runtime.editView(grown.value, { text: "one" });
  assert.equal(shrunk.ok, true);
  assert.deepEqual(
    events.map((event) => event.type),
    ["edit", "delete"],
  );
  assert.deepEqual(events[0]?.options, { replyMarkup: null });
});

test("Concrete delivery runtime serializes operations per target", async () => {
  let releaseFirst: (() => void) | undefined;
  const order: string[] = [];
  const { runtime } = createConcreteRuntimeHarness({
    async sendChunk() {
      order.push("first-start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first-end");
      return 201;
    },
    async sendChatAction() {
      order.push("action");
    },
  });
  assert.equal(runtime.hasPendingTarget?.(target), false);
  const sending = runtime.sendView(
    { text: "one" },
    { scope: { kind: "instance" } },
  );
  assert.equal(runtime.hasPendingTarget?.(target), true, "Logical admission precedes transport entry");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const action = runtime.sendChatAction("typing", { kind: "instance" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ["first-start"]);
  releaseFirst?.();
  await Promise.all([sending, action]);
  assert.deepEqual(order, ["first-start", "first-end", "action"]);
  assert.equal(runtime.hasPendingTarget?.(target), false);
});

function confirmationRequest(signal = new AbortController().signal): TelegramConfirmRequest {
  return { owner: "@test/cache", scope: { kind: "instance" }, question: "Clear <cache> & history?",
    confirmLabel: "🗑 Clear", cancelLabel: "❌ Cancel", confirmStyle: "danger", timeoutMs: 1_000, signal };
}

function confirmationCallback(id: string, choice = "yes", messageId = 101): TelegramDeliveryConfirmationCallback {
  return { data: `tgconfirm:${id}:${choice}`, from: { id: 42 },
    message: { chat: { id: 42 }, message_thread_id: 7, message_id: messageId } };
}

function confirmationHarness(overrides: Partial<TelegramDeliveryRuntimeDeps> = {}) {
  return createConcreteRuntimeHarness({ getConfirmationAuthority: () => ({ profile: "default", operatorId: 42 }), ...overrides });
}

for (const direct of [true, false]) for (const loss of ["bot", "same-registration"] as const) {
  if (direct && loss === "same-registration") continue;
  test(`Original question provider joins native Delivery binding and registration without successor capture (${direct}/${loss})`, async () => {
    const registration = createTelegramBusFollowerRegistrationState(), target = { chatId: 42, threadId: 7 };
    const metadata = { generation: "original-generation", sessionId: "session", registrationIncarnation: "a".repeat(48) };
    registration.setRegistered(true, target, metadata);
    let botId = 123;
    const capture = createTelegramQuestionAuthorityCapture({
      captureSession: () => () => true, getTransportStamp: () => 1, isTransportStampActive: () => true,
      getAllowedUserId: () => 42, ownsDirect: () => direct, getLeaderEpoch: () => 1,
      getFollowerGeneration: registration.getGeneration, isFollowerRegistered: registration.isRegistered,
      getLeaderTarget: () => target, getFollowerTarget: registration.getTarget, getBotId: () => botId,
      captureFollowerRegistration: registration.capturePublicationRegistration!,
    });
    const h = confirmationHarness({ questionHeadTail: true, captureQuestionAuthority: capture });
    const unbind = bindTelegramDeliveryRuntime(h.runtime);
    try {
      const opened = await h.runtime.openConfirmation!(confirmationRequest()); assert.ok(opened.ok);
      const owner = captureTelegramQuestionLifetimeOwner(); assert.ok(owner); owner.assertCurrent();
      if (loss === "bot") botId = 456; else registration.setRegistered(true, target, metadata);
      assert.throws(owner.assertCurrent, /unavailable/u);
      botId = 123; registration.setRegistered(true, target, metadata);
      assert.throws(owner.assertCurrent, /unavailable/u);
      assert.equal(captureTelegramQuestionLifetimeOwner(), undefined, "The original bound runtime cannot capture a renewed owner");
      assert.equal((await h.runtime.openConfirmation!(confirmationRequest())).ok, false);
      const replacement = confirmationHarness({ questionHeadTail: true, captureQuestionAuthority: capture });
      try { assert.ok((await replacement.runtime.openConfirmation!(confirmationRequest())).ok, "Only a genuinely new runtime may capture the new native provider"); }
      finally { replacement.runtime.shutdown(); }
    } finally { unbind(); h.runtime.shutdown(); }
  });
}

async function flushConfirmationEffects(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

function taskRequest(signal = new AbortController().signal): TelegramTaskViewRequest {
  return { owner: "@test/export", scope: { kind: "instance" }, title: "Export <report>",
    state: { status: "running", text: "Gathering & validating" }, cancellable: true, timeoutMs: 60_000, signal };
}
function taskCallback(id: string): TelegramDeliveryConfirmationCallback {
  return { ...confirmationCallback(id), data: `tgtask:${id}:cancel` };
}

test("Task View projects producer state; cancellation requests never assert that execution stopped", async () => {
  const { runtime, events } = confirmationHarness(), request = taskRequest();
  try {
    const opened = await runtime.openTaskView!(request); assert.ok(opened.ok);
    assert.ok(Object.isFrozen(opened.handle) && Object.isFrozen(opened.handle.target));
    request.title = "changed"; request.state.text = "changed";
    const send = events.find(event => event.type === "send")!;
    assert.match((send.chunk as { text: string }).text, /Export &lt;report&gt;.*\nGathering &amp; validating/);
    assert.doesNotMatch((send.chunk as { text: string }).text, /0%/);
    const markup = (send.options as { replyMarkup: TelegramInlineKeyboardMarkup }).replyMarkup;
    assert.equal(markup.inline_keyboard[0]![0]!.callback_data, `tgtask:${opened.handle.id}:cancel`);
    let ended = false; void opened.handle.result.then(() => { ended = true; });
    const accepted = runtime.acceptTaskCancel!(taskCallback(opened.handle.id)); assert.ok(accepted.handled && accepted.accepted);
    assert.deepEqual(await opened.handle.cancellation, { status: "requested" });
    assert.deepEqual(runtime.acceptTaskCancel!(taskCallback(opened.handle.id)), { handled: true, accepted: false });
    await flushConfirmationEffects(); assert.equal(ended, false);
    const cancelling = events.filter(event => event.type === "edit").at(-1)!;
    assert.match((cancelling.chunk as { text: string }).text, /waiting for producer acknowledgement/);
    assert.equal((cancelling.options as { replyMarkup: TelegramInlineKeyboardMarkup }).replyMarkup.inline_keyboard.length, 0);
    assert.equal((await opened.handle.update({ status: "running", text: "Still cleaning", progress: 1 })).ok, true);
    assert.equal(ended, false, "100% progress does not infer completion");
    assert.equal((await opened.handle.update({ status: "cancelled", text: "Producer stopped its export" })).ok, true);
    assert.deepEqual(await opened.handle.result, { status: "cancelled" }); accepted.assertCurrent();
    assert.equal((await opened.handle.update({ status: "running", text: "No revival" })).ok, false);
  } finally { runtime.shutdown(); }
});

test("Task View coalesces queued snapshots without overlapping actual edits", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const texts: string[] = [];
  const { runtime } = confirmationHarness({ async editChunk(_target, _message, chunk, options) {
    options?.assertAuthority?.(); texts.push(chunk.text);
    if (texts.length === 1) { entered.resolve(); await release.promise; }
    options?.assertAuthority?.();
  } });
  try {
    const opened = await runtime.openTaskView!(taskRequest()); assert.ok(opened.ok);
    const first = opened.handle.update({ status: "running", text: "first" }); await entered.promise;
    const updates = Array.from({ length: 20 }, (_, i) => opened.handle.update({ status: "running", text: `snapshot-${i}` }));
    await flushConfirmationEffects(); assert.equal(texts.length, 1);
    release.resolve(); assert.equal((await first).ok, true);
    const results = await Promise.all(updates);
    assert.equal(results.filter(value => value.ok && value.value.status === "superseded").length, 19);
    assert.equal(results.at(-1)!.ok, true); assert.equal(texts.length, 2); assert.match(texts[1]!, /snapshot-19/);
    opened.handle.close(); assert.deepEqual(await opened.handle.cancellation, { status: "closed", reason: "closed" });
  } finally { release.resolve(); runtime.shutdown(); }
});

for (const loss of ["profile", "operator", "target", "shutdown"] as const)
test(`Task View observed authority loss is sticky (${loss})`, async () => {
  let profile = "default", operatorId = 42, authorized = true;
  const { runtime } = confirmationHarness({ getConfirmationAuthority: () => ({ profile, operatorId }), isExplicitTargetAuthorized: () => authorized });
  try {
    const opened = await runtime.openTaskView!(taskRequest()); assert.ok(opened.ok);
    if (loss === "profile") profile = "new";
    if (loss === "operator") operatorId = 43;
    if (loss === "target") authorized = false;
    if (loss === "shutdown") runtime.shutdown();
    assert.equal((await opened.handle.update({ status: "running", text: "not admitted" })).ok, false);
    assert.deepEqual(await opened.handle.result, { status: "invalidated" });
    profile = "default"; operatorId = 42; authorized = true;
    assert.equal((await opened.handle.update({ status: "running", text: "equal values cannot revive" })).ok, false);
    assert.deepEqual(runtime.acceptTaskCancel!(taskCallback(opened.handle.id)), { handled: true, accepted: false });
  } finally { runtime.shutdown(); }
});

test("Task View rejects mismatched, malformed and business-namespace controls before requesting cancellation", async () => {
  const { runtime } = confirmationHarness();
  try {
    const opened = await runtime.openTaskView!(taskRequest()); assert.ok(opened.ok);
    const query = taskCallback(opened.handle.id);
    for (const changed of [ { ...query, from: { id: 43 } },
      { ...query, message: { ...query.message!, message_id: 102 } },
      { ...query, message: { ...query.message!, chat: { id: 43 } } },
      { ...query, message: { ...query.message!, message_thread_id: undefined } },
      { ...query, message: { ...query.message!, business_connection_id: "business" } },
      { ...query, data: `tgtask:${opened.handle.id}:quit` }, { ...query, data: "tgtask:malformed" } ])
      assert.deepEqual(runtime.acceptTaskCancel!(changed), { handled: true, accepted: false });
    const accepted = runtime.acceptTaskCancel!(query); assert.ok(accepted.handled && accepted.accepted);
    assert.deepEqual(await opened.handle.cancellation, { status: "requested" });
  } finally { runtime.shutdown(); }
});

test("Task View finite lifetime settles queued and in-flight callers but retains actual-work drain", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), controller = new AbortController();
  const { runtime } = confirmationHarness({ async editChunk(_target, _message, _chunk, options) {
    options?.assertAuthority?.(); entered.resolve(); await release.promise; options?.assertAuthority?.();
  } });
  try {
    const opened = await runtime.openTaskView!(taskRequest(controller.signal)); assert.ok(opened.ok);
    const first = opened.handle.update({ status: "running", text: "in flight" }); await entered.promise;
    const second = opened.handle.update({ status: "running", text: "pending" }); controller.abort();
    assert.deepEqual(await opened.handle.result, { status: "aborted" });
    assert.deepEqual(await opened.handle.cancellation, { status: "closed", reason: "aborted" });
    const issued = await first, queued = await second; assert.ok(!issued.ok && !queued.ok);
    assert.equal(issued.effect, "unknown"); assert.equal(queued.effect, "not-issued");
    assert.equal(runtime.hasPendingTarget!(target), true, "Logical abort cannot pretend actual work drained");
    release.resolve(); await flushConfirmationEffects(); assert.equal(runtime.hasPendingTarget!(target), false);
  } finally { release.resolve(); runtime.shutdown(); }
});

test("Task View abort during opening refuses its nonce and cleans a later positively acknowledged message", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), controller = new AbortController();
  let edits = 0;
  const { runtime } = confirmationHarness({ async sendChunk() { entered.resolve(); await release.promise; return 101; },
    async editChunk(_target, _id, chunk, options) { options?.assertAuthority?.(); assert.match(chunk.text, /View closed/); edits++; } });
  try {
    const opening = runtime.openTaskView!(taskRequest(controller.signal)); await entered.promise; controller.abort();
    const failure = await opening; assert.ok(!failure.ok); assert.equal(failure.reason, "aborted"); assert.equal(failure.effect, "unknown");
    assert.equal(runtime.hasPendingTarget!(target), true);
    release.resolve(); await flushConfirmationEffects(); assert.equal(edits, 1); assert.equal(runtime.hasPendingTarget!(target), false);
  } finally { release.resolve(); runtime.shutdown(); }
});

test("Task View uncertain edit retires the projection without retry, cleanup replay or inferred completion", async () => {
  let edits = 0;
  const { runtime } = confirmationHarness({ async editChunk() { edits++; throw new TelegramApiCommitUnknownError("editMessageText", new Error("lost ACK")); } });
  try {
    const opened = await runtime.openTaskView!(taskRequest()); assert.ok(opened.ok);
    const changed = await opened.handle.update({ status: "completed", text: "Producer finished" }); assert.ok(!changed.ok);
    assert.equal(changed.reason, "commit-unknown"); assert.deepEqual(await opened.handle.result, { status: "invalidated" });
    assert.equal((await opened.handle.update({ status: "completed", text: "Do not retry" })).ok, false);
    await flushConfirmationEffects(); assert.equal(edits, 1);
  } finally { runtime.shutdown(); }
});

test("Task View terminal intent wins cancel/update races while actual preceding work drains", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let edits = 0;
  const { runtime } = confirmationHarness({ async editChunk() { if (++edits === 1) { entered.resolve(); await release.promise; } } });
  try {
    const opened = await runtime.openTaskView!(taskRequest()); assert.ok(opened.ok);
    const first = opened.handle.update({ status: "running", text: "last progress" }); await entered.promise;
    const terminal = opened.handle.update({ status: "completed", text: "Producer completed" });
    assert.deepEqual(runtime.acceptTaskCancel!(taskCallback(opened.handle.id)), { handled: true, accepted: false });
    assert.equal((await opened.handle.update({ status: "running", text: "cannot replace terminal intent" })).ok, false);
    release.resolve(); assert.equal((await first).ok, true); assert.equal((await terminal).ok, true);
    assert.deepEqual(await opened.handle.result, { status: "completed" });
    assert.deepEqual(await opened.handle.cancellation, { status: "closed", reason: "completed" }); assert.equal(edits, 2);
  } finally { release.resolve(); runtime.shutdown(); }
});

test("Task View queued close cleanup cannot follow an uncertain in-flight edit", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let edits = 0;
  const { runtime } = confirmationHarness({ async editChunk() {
    if (++edits === 1) { entered.resolve(); await release.promise; throw new TelegramApiCommitUnknownError("editMessageText", new Error("late ACK loss")); }
  } });
  try {
    const opened = await runtime.openTaskView!(taskRequest()); assert.ok(opened.ok);
    const updating = opened.handle.update({ status: "running", text: "unconfirmed progress" }); await entered.promise;
    opened.handle.close(); const outcome = await updating; assert.ok(!outcome.ok); assert.equal(outcome.effect, "unknown");
    assert.deepEqual(await opened.handle.result, { status: "closed" });
    release.resolve(); await flushConfirmationEffects();
    assert.equal(edits, 1, "Queued disposal must not become a compensating mutation after unknown edit settlement");
    assert.equal(runtime.hasPendingTarget!(target), false);
  } finally { release.resolve(); runtime.shutdown(); }
});

test("Task View failed close cleanup leaves an inert control and never changes the logical outcome", async () => {
  let edits = 0;
  const { runtime } = confirmationHarness({ async editChunk() { edits++; throw new Error("cleanup failed"); }, recordFailure() { throw new Error("observer failed"); } });
  try {
    const opened = await runtime.openTaskView!(taskRequest()); assert.ok(opened.ok); opened.handle.close();
    assert.deepEqual(await opened.handle.result, { status: "closed" }); await flushConfirmationEffects(); opened.handle.close();
    await flushConfirmationEffects(); assert.equal(edits, 1);
    assert.deepEqual(runtime.acceptTaskCancel!(taskCallback(opened.handle.id)), { handled: true, accepted: false });
    assert.deepEqual(await opened.handle.cancellation, { status: "closed", reason: "closed" });
  } finally { runtime.shutdown(); }
});

test("Task View unknown initial publication never exposes a handle, leaves a live nonce or retries", async () => {
  let sends = 0, data = "";
  const { runtime } = confirmationHarness({ async sendChunk(_target, _chunk, options) {
    sends++; data = options!.replyMarkup!.inline_keyboard[0]![0]!.callback_data!;
    throw new TelegramApiCommitUnknownError("sendMessage", new Error("ACK lost"));
  } });
  try {
    const opened = await runtime.openTaskView!(taskRequest()); assert.ok(!opened.ok);
    assert.equal(opened.reason, "commit-unknown"); assert.equal(opened.effect, "unknown");
    assert.deepEqual(runtime.acceptTaskCancel!({ ...taskCallback("unused"), data }), { handled: true, accepted: false });
    await flushConfirmationEffects(); assert.equal(sends, 1);
  } finally { runtime.shutdown(); }
});

test("Task View rechecks lifetime after rendering a producer update", async () => {
  let close: (() => void) | undefined, endDuringRender = false;
  const { runtime } = confirmationHarness({ renderView(view) {
    if (endDuringRender) close!(); return [{ text: view.text, parseMode: "html" }];
  } });
  try {
    const opened = await runtime.openTaskView!(taskRequest()); assert.ok(opened.ok); close = opened.handle.close;
    endDuringRender = true;
    let settled = false; const update = opened.handle.update({ status: "running", text: "late" }); void update.then(() => { settled = true; });
    await flushConfirmationEffects(); assert.equal(settled, true, "A renderer ending the view must not strand a new pending update");
    assert.equal((await update).ok, false);
  } finally { runtime.shutdown(); }
});

test("Task View consumes cancellation before calling an admitted authority guard", async () => {
  const { runtime } = confirmationHarness();
  try {
    const opened = await runtime.openTaskView!(taskRequest()); assert.ok(opened.ok); let observations = 0;
    let inner: unknown;
    const accepted = runtime.acceptTaskCancel!(taskCallback(opened.handle.id), () => {
      if (++observations === 2) inner = runtime.acceptTaskCancel!(taskCallback(opened.handle.id));
    });
    assert.ok(accepted.handled && accepted.accepted); assert.deepEqual(inner, { handled: true, accepted: false });
    assert.deepEqual(await opened.handle.cancellation, { status: "requested" });
  } finally { runtime.shutdown(); }
});

for (const replacement of ["unbind", "same-object", "method"] as const)
test(`Task View public handles retain the exact binding and callable (${replacement})`, async () => {
  clearTelegramDeliveryRuntime(); const { runtime } = confirmationHarness(); const unbind = bindTelegramDeliveryRuntime(runtime);
  try {
    const opened = await openTelegramTaskView(taskRequest()); assert.ok(opened.ok);
    if (replacement === "unbind") unbind();
    if (replacement === "same-object") bindTelegramDeliveryRuntime(runtime);
    if (replacement === "method") runtime.openTaskView = async () => ({ ok: false, reason: "runtime-unavailable", effect: "not-issued", message: "replacement" });
    assert.equal((await opened.handle.update({ status: "running", text: "old handle" })).ok, false);
    assert.deepEqual(await opened.handle.result, { status: "invalidated" });
  } finally { unbind(); clearTelegramDeliveryRuntime(); runtime.shutdown(); }
});

test("Task View lifecycle ports revoke equal-generation sessions and never adopt predecessor controls", async () => {
  clearTelegramDeliveryRuntime();
  const hooks = createTelegramDeliveryLifecycleHooks(() => confirmationHarness({ generation: "equal" }).runtime);
  try {
    await hooks.onSessionStart(); const first = await openTelegramTaskView(taskRequest()); assert.ok(first.ok);
    await hooks.onSessionStart(); assert.deepEqual(await first.handle.result, { status: "invalidated" });
    assert.deepEqual(hooks.acceptTaskCancel(taskCallback(first.handle.id)), { handled: true, accepted: false });
    const next = await hooks.openTaskView(taskRequest()); assert.ok(next.ok);
    const accepted = hooks.acceptTaskCancel(taskCallback(next.handle.id)); assert.ok(accepted.handled && accepted.accepted);
    assert.deepEqual(await next.handle.cancellation, { status: "requested" });
    await hooks.onSessionShutdown(); assert.deepEqual(await next.handle.result, { status: "invalidated" });
    assert.deepEqual(hooks.acceptTaskCancel(taskCallback(next.handle.id)), { handled: true, accepted: false });
    assert.equal((await hooks.openTaskView(taskRequest())).ok, false);
  } finally { await hooks.onSessionShutdown(); clearTelegramDeliveryRuntime(); }
});

test("Task View validates declarations before transport and defaults to observation without cancellation", async () => {
  let sends = 0;
  const { runtime, events } = confirmationHarness({ async sendChunk() { sends++; return 101; } });
  try {
    for (const patch of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 1.5 }, { signal: null },
      { cancellable: null }, { cancelLabel: null }, { scope: { kind: "aggregate" } }, { title: "" },
      { state: { status: "complete", text: "wrong" } }, { state: { status: "running", text: "" } },
      { state: { status: "running", text: "x", progress: NaN } }, { state: { status: "running", text: "x", progress: 1.1 } },
      { state: { status: "running", text: "x", progress: -0.1 } }])
      await assert.rejects(runtime.openTaskView!({ ...taskRequest(), ...patch } as TelegramTaskViewRequest), TypeError);
    assert.equal(sends, 0);
    const controller = new AbortController(); controller.abort();
    const aborted = await runtime.openTaskView!(taskRequest(controller.signal)); assert.ok(!aborted.ok);
    assert.equal(aborted.effect, "not-issued"); assert.equal(sends, 0);
    const opened = await runtime.openTaskView!({ ...taskRequest(), cancellable: undefined }); assert.ok(opened.ok);
    assert.deepEqual(runtime.acceptTaskCancel!(taskCallback(opened.handle.id)), { handled: true, accepted: false });
    opened.handle.close(); await flushConfirmationEffects();
    assert.deepEqual(await opened.handle.result, { status: "closed" });
    assert.match((events.filter(event => event.type === "edit").at(-1)!.chunk as { text: string }).text, /View closed/);
  } finally { runtime.shutdown(); }
});

test("Task View deadline retires controls without cancelling the producer", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const { runtime } = confirmationHarness();
  try {
    const opened = await runtime.openTaskView!({ ...taskRequest(), timeoutMs: 100 }); assert.ok(opened.ok);
    t.mock.timers.tick(101); assert.deepEqual(await opened.handle.result, { status: "expired" });
    assert.deepEqual(await opened.handle.cancellation, { status: "closed", reason: "expired" });
    assert.equal((await opened.handle.update({ status: "completed", text: "no revival" })).ok, false);
  } finally { runtime.shutdown(); }
});

test("Task View shares pending-interaction capacity and reserves controls without a runtime", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const { runtime } = confirmationHarness();
  try {
    for (let i = 0; i < 255; i++) assert.ok((await runtime.openConfirmation!(confirmationRequest())).ok);
    const opened = await runtime.openTaskView!(taskRequest()); assert.ok(opened.ok);
    const full = await runtime.openChoice!(choiceRequest()); assert.ok(!full.ok); assert.equal(full.reason, "capacity-exceeded");
    opened.handle.close(); assert.ok((await runtime.openChoice!(choiceRequest())).ok);
  } finally { runtime.shutdown(); }
  clearTelegramDeliveryRuntime(); assert.deepEqual(acceptTelegramTaskViewCallback(taskCallback("f".repeat(32))), { handled: true, accepted: false });
});

function attachmentQuestion(signal = new AbortController().signal): TelegramAttachmentQuestionRequest {
  return { owner: "@test/upload", scope: { kind: "instance" }, question: "Send <report>?", cancelLabel: "❌ Cancel", timeoutMs: 60_000, signal };
}
function attachmentHarness(overrides: Partial<TelegramDeliveryRuntimeDeps> = {}) {
  return confirmationHarness({ getAttachmentReceiverBotId: () => 99,
    publishAttachmentQuestion: async (_target, _chunk, options) => { options.assertAuthority?.(); return 101; }, ...overrides });
}
for (const missing of ["both", "publication", "readiness"] as const)
test(`Attachment question stays closed without complete native ports (${missing})`, async () => {
  let calls = 0;
  const { runtime } = attachmentHarness({ ...(missing !== "readiness" ? { publishAttachmentQuestion: undefined } : {}),
    ...(missing !== "publication" ? { getAttachmentReceiverBotId: undefined } : {}), sendChunk: async () => { calls++; return 101; } });
  try { const opened = await runtime.openAttachmentQuestion!(attachmentQuestion()); assert.ok(!opened.ok); assert.equal(opened.reason, "runtime-unavailable"); assert.equal(calls, 0); }
  finally { runtime.shutdown(); }
});
for (const threaded of [false, true])
test(`Attachment question captures exact genuine receiver without consuming input (Thread=${threaded})`, async () => {
  const destination = threaded ? target : { chatId: 42 }, publications: string[] = [];
  const { runtime, events } = attachmentHarness({ getInstanceTarget: () => destination,
    sendChunk: async () => assert.fail("Attachment publication cannot use the ordinary sender"),
    publishAttachmentQuestion: async (_target, chunk, options) => { options.assertAuthority?.(); publications.push(chunk.text); return 101; } });
  try {
    const raw = attachmentQuestion(), opened = await runtime.openAttachmentQuestion!(raw); assert.ok(opened.ok);
    assert.match(publications[0]!, /<b>Send &lt;report&gt;\?<\/b>\nReply to this message/);
    assert.ok(Object.isFrozen(opened.handle) && Object.isFrozen(opened.handle.target)); raw.question = "changed";
    const identity = { requestId: opened.handle.id, messageId: 101, operatorId: 42, botId: 99, profile: "default", target: { ...destination } };
    const first = runtime.captureAttachmentReceiver!(identity), second = runtime.captureAttachmentReceiver!(identity); assert.ok(first && second);
    assert.deepEqual(Object.keys(first), ["assertCurrent", "constraints", "deadline", "reserveSource"]); assert.ok(Object.isFrozen(first));
    assert.deepEqual(first.constraints, { accept: ["*/*"], maxFiles: 1, maxBytes: 10_485_760 });
    assert.equal(first.deadline, second.deadline);
    let settled = false; void opened.handle.result.then(() => { settled = true; }); const count = events.length;
    for (const changed of [{ requestId: "f".repeat(32) }, { messageId: 102 }, { operatorId: 43 }, { botId: 98 }, { profile: "other" },
      { target: { chatId: 43 } }, { target: { chatId: 42, threadId: threaded ? 8 : 7 } }])
      assert.equal(runtime.captureAttachmentReceiver!({ ...identity, ...changed }), undefined);
    assert.equal(runtime.captureTextInputReceiver!(identity), undefined);
    identity.target = { chatId: 999 }; first.assertCurrent(); second.assertCurrent(); await Promise.resolve();
    const owner = Object.freeze({}), other = Object.freeze({}), reservation = first.reserveSource!(owner); assert.ok(reservation && Object.isFrozen(reservation));
    assert.equal(first.reserveSource!(owner), reservation); assert.equal(second.reserveSource!(owner), reservation);
    assert.equal(first.reserveSource!(other), undefined); assert.equal(second.reserveSource!(other), undefined); reservation.assertCurrent();
    assert.throws(() => first.reserveSource!(null as unknown as object), TypeError); reservation.assertCurrent();
    assert.ok(runtime.captureAttachmentReceiver!({ ...identity, target: destination }), "Busy questions still allow non-settling observation");
    assert.equal(settled, false); assert.equal(events.length, count);
    const query = { ...confirmationCallback(opened.handle.id), data: `tgattach:${opened.handle.id}:cancel`, message: { message_id: 101, chat: { id: 42 }, ...(threaded ? { message_thread_id: 7 } : {}) } };
    assert.deepEqual(runtime.acceptAttachmentCancel!({ ...query, from: { id: 43 } }), { handled: true, accepted: false });
    assert.deepEqual(runtime.acceptAttachmentCancel!({ ...query, message: { ...query.message, message_id: 102 } }), { handled: true, accepted: false });
    const accepted = runtime.acceptAttachmentCancel!(query); assert.ok(accepted.handled && accepted.accepted);
    assert.deepEqual(await opened.handle.result, { status: "cancelled" }); accepted.assertCurrent(); assert.throws(first.assertCurrent); assert.throws(reservation.assertCurrent);
    assert.deepEqual(runtime.acceptAttachmentCancel!(query), { handled: true, accepted: false });
    await flushConfirmationEffects(); const edit = events.find(event => event.type === "edit")!;
    assert.equal((edit.options as { replyMarkup: TelegramInlineKeyboardMarkup }).replyMarkup.inline_keyboard[0]![0]!.callback_data, `tgattach:${opened.handle.id}:cancel`);
  } finally { runtime.shutdown(); }
});
test("Attachment cancellation receipt belongs only to the current reserved source, not a declined predecessor", async () => {
  const { runtime } = attachmentHarness();
  try {
    const opened = await runtime.openAttachmentQuestion!(attachmentQuestion()); assert.ok(opened.ok);
    const identity = { requestId: opened.handle.id, messageId: 101, operatorId: 42, botId: 99, profile: "default", target };
    const receiver = runtime.captureAttachmentReceiver!(identity)!, prior = receiver.reserveSource!(Object.freeze({}))!; prior.decline();
    const next = receiver.reserveSource!(Object.freeze({}))!; assert.ok(runtime.acceptAttachmentCancel!({ ...confirmationCallback(opened.handle.id), data: `tgattach:${opened.handle.id}:cancel` }).handled);
    assert.deepEqual(await opened.handle.result, { status: "cancelled" });
    assert.equal(prior.getCancellationReceipt!(), undefined); const receipt = next.getCancellationReceipt!(); assert.ok(receipt); receipt.assertAcknowledged();
  } finally { runtime.shutdown(); }
});
test("Attachment ended receipt cannot be inferred from elapsed clock or a non-settling receiver observation", async t => {
  t.mock.timers.enable({ apis: ["Date"] }); const controller = new AbortController(), { runtime } = attachmentHarness();
  try {
    const opened = await runtime.openAttachmentQuestion!(attachmentQuestion(controller.signal)); assert.ok(opened.ok);
    const receiver = runtime.captureAttachmentReceiver!({ requestId: opened.handle.id, messageId: 101, operatorId: 42, botId: 99, profile: "default", target })!;
    const scope = receiver.reserveSource!(Object.freeze({}))!; let settled = false; void opened.handle.result.then(() => { settled = true; });
    t.mock.timers.setTime(receiver.deadline + 1); assert.throws(receiver.assertCurrent);
    assert.equal(scope.getEndReceipt!(), undefined); await Promise.resolve(); assert.equal(settled, false);
    controller.abort(); assert.deepEqual(await opened.handle.result, { status: "aborted" });
    assert.equal(scope.getEndReceipt!()!.reason, "aborted", "Reason is native settlement, not an inferred clock classification");
  } finally { runtime.shutdown(); }
});
for (const reason of ["expired", "aborted"] as const)
test(`Attachment ended receipt belongs to the current source, never a declined predecessor (${reason})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); const controller = new AbortController(), { runtime } = attachmentHarness();
  try {
    const opened = await runtime.openAttachmentQuestion!(attachmentQuestion(controller.signal)); assert.ok(opened.ok);
    const receiver = runtime.captureAttachmentReceiver!({ requestId: opened.handle.id, messageId: 101, operatorId: 42, botId: 99, profile: "default", target })!;
    const prior = receiver.reserveSource!(Object.freeze({}))!; prior.decline(); const next = receiver.reserveSource!(Object.freeze({}))!;
    if (reason === "expired") t.mock.timers.tick(60_001); else controller.abort();
    assert.deepEqual(await opened.handle.result, { status: reason }); assert.equal(prior.getEndReceipt!(), undefined); assert.equal(next.getEndReceipt!()!.reason, reason);
  } finally { runtime.shutdown(); }
});

test("Attachment SDK rejects malformed synchronous output without a producer-result receipt", async () => {
  for (const shape of ["promise", "accessor", "sparse", "expired"] as const) {
    const { runtime } = attachmentHarness(); let reads = 0;
    try {
      const opened = await runtime.openAttachmentQuestion!(attachmentQuestion()); assert.ok(opened.ok);
      const receiver = runtime.captureAttachmentReceiver!({ requestId: opened.handle.id, messageId: 101, operatorId: 42, botId: 99, profile: "default", target });
      const scope = receiver!.reserveSource!(Object.freeze({})); assert.ok(scope?.handoff);
      const lease = Object.freeze({ files: Object.freeze(shape === "sparse" ? new Array(1) : [Object.freeze({ path: "/private/input", metadata: Object.freeze({}), byteLength: 1, expiresAt: 1 })]),
        expiresAt: shape === "expired" ? 1 : Date.now() + 5000, ended: new Promise<void>(() => {}) });
      const bad = shape === "promise" ? Promise.resolve({ lease, dispose: async () => false }) : shape === "accessor"
        ? Object.freeze({ get lease() { reads++; return lease; }, dispose: async () => false }) : Object.freeze({ lease, dispose: async () => false });
      let settled = false; void opened.handle.result.then(() => { settled = true; });
      assert.throws(() => scope.handoff!(() => bad as never)); assert.equal(reads, 0);
      await Promise.resolve(); assert.equal(settled, false); assert.throws(scope.assertCurrent); assert.throws(scope.decline);
      const fresh = runtime.captureAttachmentReceiver!({ requestId: opened.handle.id, messageId: 101, operatorId: 42, botId: 99, profile: "default", target });
      assert.equal(fresh!.reserveSource!(Object.freeze({})), undefined, "Failed SDK transfer cannot reopen question arbitration");
    } finally { runtime.shutdown(); }
  }
});
test("Attachment SDK rechecks lease expiry after final native authority observations", async t => {
  t.mock.timers.enable({ apis: ["Date"] }); let armed = false; const expiresAt = Date.now() + 5000;
  const { runtime } = attachmentHarness({ getConfirmationAuthority() {
    if (armed) { armed = false; t.mock.timers.setTime(expiresAt + 1); }
    return { profile: "default", operatorId: 42 };
  } });
  try {
    const opened = await runtime.openAttachmentQuestion!(attachmentQuestion()); assert.ok(opened.ok);
    const receiver = runtime.captureAttachmentReceiver!({ requestId: opened.handle.id, messageId: 101, operatorId: 42, botId: 99, profile: "default", target });
    const scope = receiver!.reserveSource!(Object.freeze({})); assert.ok(scope?.handoff);
    const lease = Object.freeze({ files: Object.freeze([Object.freeze({ path: "/private/input", metadata: Object.freeze({ messageId: 1, kind: "document" as const, fileId: "native-file" }), byteLength: 1, expiresAt })]),
      expiresAt, ended: new Promise<void>(() => {}) });
    let submitted = false; void opened.handle.result.then(result => { submitted = result.status === "submitted"; });
    assert.throws(() => scope.handoff!(() => { armed = true; return Object.freeze({ lease, dispose: async () => false }); }));
    await Promise.resolve(); assert.equal(submitted, false);
  } finally { runtime.shutdown(); }
});

for (const loss of ["deadline", "bot", "readiness", "profile", "target", "publisher", "abort"] as const)
test(`Attachment receiver observation does not settle and observed loss stays ended (${loss})`, async t => {
  t.mock.timers.enable({ apis: ["Date"] }); let bot: number | undefined = 99, profile = "default", allowed = true, notifications = 0;
  const controller = new AbortController(), { runtime, events, deps } = attachmentHarness({ getAttachmentReceiverBotId: () => bot,
    getConfirmationAuthority: () => ({ profile, operatorId: 42 }), isExplicitTargetAuthorized: () => allowed,
    captureDrain: () => () => { notifications++; } });
  try {
    const opened = await runtime.openAttachmentQuestion!(attachmentQuestion(controller.signal)); assert.ok(opened.ok); await flushConfirmationEffects();
    const identity = { requestId: opened.handle.id, messageId: 101, operatorId: 42, botId: 99, profile: "default", target };
    const guard = runtime.captureAttachmentReceiver!(identity); assert.ok(guard);
    const reservationOwner = Object.freeze({}), reservation = guard.reserveSource!(reservationOwner); assert.ok(reservation);
    let settled = false; void opened.handle.result.then(() => { settled = true; }); const before = { events: events.length, notifications };
    const originalPublisher = deps.publishAttachmentQuestion;
    if (loss === "deadline") t.mock.timers.setTime(Date.now() + 60_001);
    if (loss === "bot") bot = 100; if (loss === "readiness") bot = undefined;
    if (loss === "profile") profile = "other"; if (loss === "target") allowed = false;
    if (loss === "publisher") deps.publishAttachmentQuestion = async () => 101;
    if (loss === "abort") controller.abort();
    assert.throws(guard.assertCurrent); assert.throws(reservation.assertCurrent); assert.equal(runtime.captureAttachmentReceiver!(identity), undefined); await Promise.resolve();
    if (loss !== "abort") { assert.equal(settled, false); assert.deepEqual({ events: events.length, notifications }, before); }
    bot = 99; profile = "default"; allowed = true; deps.publishAttachmentQuestion = originalPublisher;
    assert.throws(guard.assertCurrent); assert.throws(reservation.assertCurrent);
    const restored = runtime.captureAttachmentReceiver!(identity);
    if (restored) { assert.equal(restored.reserveSource!(Object.freeze({})), undefined); assert.throws(() => restored.reserveSource!(reservationOwner)); }
  } finally { runtime.shutdown(); }
});
test("Attachment decline caught reentry keeps the poisoned reservation held rather than guessing retirement", async () => {
  let armed = false, scope: ReturnType<NonNullable<TelegramAttachmentReceiverGuard["reserveSource"]>>;
  const { runtime, events } = attachmentHarness({ getConfirmationAuthority() {
    if (armed) { armed = false; try { scope!.decline(); } catch { /* Caught reentry must not clear the actual slot. */ } }
    return { profile: "default", operatorId: 42 };
  } });
  try {
    const opened = await runtime.openAttachmentQuestion!(attachmentQuestion()); assert.ok(opened.ok);
    const identity = { requestId: opened.handle.id, messageId: 101, operatorId: 42, botId: 99, profile: "default", target };
    const guard = runtime.captureAttachmentReceiver!(identity); assert.ok(guard?.reserveSource); scope = guard.reserveSource(Object.freeze({})); assert.ok(scope);
    const count = events.length; armed = true; assert.throws(scope.decline); assert.throws(scope.assertCurrent);
    const fresh = runtime.captureAttachmentReceiver!(identity); assert.ok(fresh?.reserveSource); assert.equal(fresh.reserveSource(Object.freeze({})), undefined);
    assert.equal(events.length, count);
  } finally { runtime.shutdown(); }
});
test("Attachment source reservation consumes the question before caught native authority reentry", async () => {
  let armed = false, guard: TelegramAttachmentReceiverGuard | undefined;
  const owner = Object.freeze({}), { runtime, events } = attachmentHarness({ getConfirmationAuthority() {
    if (armed) { armed = false; try { guard!.reserveSource!(owner); } catch { /* Caught native reentry still poisons the reservation. */ } }
    return { profile: "default", operatorId: 42 };
  } });
  try {
    const opened = await runtime.openAttachmentQuestion!(attachmentQuestion()); assert.ok(opened.ok);
    const identity = { requestId: opened.handle.id, messageId: 101, operatorId: 42, botId: 99, profile: "default", target };
    guard = runtime.captureAttachmentReceiver!(identity); assert.ok(guard); const count = events.length;
    let settled = false; void opened.handle.result.then(() => { settled = true; });
    armed = true; assert.throws(() => guard!.reserveSource!(owner));
    const fresh = runtime.captureAttachmentReceiver!(identity); assert.ok(fresh);
    assert.equal(fresh.reserveSource!(Object.freeze({})), undefined); assert.throws(() => fresh.reserveSource!(owner));
    await Promise.resolve(); assert.equal(settled, false); assert.equal(events.length, count);
  } finally { runtime.shutdown(); }
});
test("Attachment receiver cannot use an opening or ambiguous Text/Attachment publication", async () => {
  const gate = Promise.withResolvers<number>(); let id = "";
  const { runtime } = attachmentHarness({ getTextInputReceiverBotId: () => 99,
    publishAttachmentQuestion: async (_target, _chunk, options) => { id = /^tgattach:([a-f0-9]{32}):cancel$/u.exec(options.replyMarkup!.inline_keyboard[0]![0]!.callback_data!)![1]!; return gate.promise; } });
  try {
    const opening = runtime.openAttachmentQuestion!(attachmentQuestion()); await flushConfirmationEffects();
    const identity = () => ({ requestId: id, messageId: 101, operatorId: 42, botId: 99, profile: "default", target });
    assert.equal(runtime.captureAttachmentReceiver!(identity()), undefined);
    gate.resolve(101); assert.ok((await opening).ok); const guard = runtime.captureAttachmentReceiver!(identity()); assert.ok(guard);
    const text = await runtime.openTextInput!(textRequest()); assert.ok(text.ok);
    assert.equal(runtime.captureAttachmentReceiver!(identity()), undefined); assert.throws(guard.assertCurrent);
    assert.equal(runtime.captureTextInputReceiver!({ ...identity(), requestId: text.handle.id }), undefined);
  } finally { gate.resolve(101); runtime.shutdown(); }
});
test("Attachment question unknown publication never returns a receiver or guesses cleanup", async () => {
  let id = "";
  const { runtime, events } = attachmentHarness({ publishAttachmentQuestion: async (_target, _chunk, options) => {
    id = /^tgattach:([a-f0-9]{32}):cancel$/u.exec(options.replyMarkup!.inline_keyboard[0]![0]!.callback_data!)![1]!;
    throw new TelegramApiCommitUnknownError("sendMessage", new Error("lost receipt")); } });
  try {
    const opened = await runtime.openAttachmentQuestion!(attachmentQuestion()); assert.ok(!opened.ok); assert.equal(opened.reason, "commit-unknown");
    assert.equal(runtime.captureAttachmentReceiver!({ requestId: id, messageId: 101, operatorId: 42, botId: 99, profile: "default", target }), undefined);
    await flushConfirmationEffects(); assert.deepEqual(events, []);
  } finally { runtime.shutdown(); }
});
test("Attachment question validates bounds and snapshots metadata before publisher callouts", async () => {
  const { runtime } = attachmentHarness();
  try {
    for (const bad of [{ maxFiles: 0 }, { maxFiles: 11 }, { maxBytes: 0 }, { maxBytes: 20_971_521 }, { accept: [".pdf"] },
      { accept: ["IMAGE/*", "image/*"] }, { accept: new Array<string>(1) }, { question: "\ud800" }, { maxFiles: null }])
      assert.throws(() => runtime.openAttachmentQuestion!({ ...attachmentQuestion(), ...bad } as TelegramAttachmentQuestionRequest), TypeError);
    const filters = [" IMAGE/* "], request = { ...attachmentQuestion(), accept: filters };
    const opened = await runtime.openAttachmentQuestion!(request); assert.ok(opened.ok); filters[0] = "bad";
  } finally { runtime.shutdown(); }
});
test("Attachment question readiness cannot retarget a mutable original authority snapshot", async () => {
  const authority = { profile: "default", operatorId: 42 }; let published = 0;
  const { runtime } = attachmentHarness({ getConfirmationAuthority: () => authority,
    getAttachmentReceiverBotId() { authority.profile = "other"; return 99; },
    publishAttachmentQuestion: async () => { published++; return 101; } });
  try {
    const opened = await runtime.openAttachmentQuestion!(attachmentQuestion());
    assert.ok(!opened.ok); assert.equal(published, 0);
  } finally { runtime.shutdown(); }
});

test("Attachment question shares the pending pool and reserves unbound controls", async () => {
  const { runtime } = attachmentHarness();
  try {
    for (let i = 0; i < 255; i++) assert.ok((await runtime.openConfirmation!(confirmationRequest())).ok);
    const opened = await runtime.openAttachmentQuestion!(attachmentQuestion()); assert.ok(opened.ok);
    const full = await runtime.openChoice!(choiceRequest()); assert.ok(!full.ok); assert.equal(full.reason, "capacity-exceeded");
    runtime.acceptAttachmentCancel!({ ...confirmationCallback(opened.handle.id), data: `tgattach:${opened.handle.id}:cancel` });
    assert.ok((await runtime.openChoice!(choiceRequest())).ok);
  } finally { runtime.shutdown(); }
  clearTelegramDeliveryRuntime();
  for (const data of ["tgattach:malformed", `tgattach:${"a".repeat(32)}:cancel`])
    assert.deepEqual(acceptTelegramAttachmentQuestionCallback({ data }), { handled: true, accepted: false });
});

function textRequest(signal = new AbortController().signal): TelegramTextInputRequest {
  return { owner: "@test/text", scope: { kind: "instance" }, question: "Report <title>?",
    cancelLabel: "❌ Cancel", timeoutMs: 1_000, signal, maxLength: 120, multiline: false };
}

test("Input source selection snapshots the exact local waiting Input without settlement or publication identity", async () => {
  const { runtime, events } = confirmationHarness({ getTextInputReceiverBotId: () => 99 });
  try {
    assert.equal(runtime.captureTextInputSource!(target), undefined);
    const opened = await runtime.openTextInput!(textRequest()); assert.ok(opened.ok);
    let settled = false; void opened.handle.result.then(() => { settled = true; });
    const before = events.length, input = { ...target }, selected = runtime.captureTextInputSource!(input); assert.ok(selected);
    input.threadId++;
    assert.ok(Object.isFrozen(selected) && Object.isFrozen(selected.target));
    assert.equal(selected.requestId, opened.handle.id); assert.equal(selected.generation, opened.handle.generation);
    assert.equal(selected.profile, "default"); assert.equal(selected.operatorId, 42); assert.equal(selected.botId, 99);
    assert.deepEqual(selected.target, target); assert.equal("messageId" in selected, false);
    selected.assertCurrent(); await Promise.resolve();
    assert.equal(events.length, before); assert.equal(settled, false);
    assert.equal(runtime.captureTextInputSource!({ ...target, threadId: 8 }), undefined);
    assert.equal(runtime.captureTextInputSource!({ chatId: 100, threadId: 7 }), undefined);
  } finally { runtime.shutdown(); }
});

test("Input source selection reads only exact target data without invoking target getters", async () => {
  const { runtime } = confirmationHarness({ getTextInputReceiverBotId: () => 99 }); let getters = 0;
  try {
    assert.ok((await runtime.openTextInput!(textRequest())).ok);
    const unsafe = { get chatId() { getters++; return target.chatId; }, threadId: target.threadId };
    assert.equal(runtime.captureTextInputSource!(unsafe), undefined); assert.equal(getters, 0);
    assert.equal(runtime.captureTextInputSource!({ ...target, extra: true } as TelegramDeliveryTarget), undefined);
    assert.equal(runtime.captureTextInputSource!({ ...target, chatId: 0 }), undefined);
    assert.ok(runtime.captureTextInputSource!(target));
  } finally { runtime.shutdown(); }
});

test("Input source selection is available before ACK and survives only the same opening-to-waiting Input", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<number>();
  const { runtime } = confirmationHarness({ getTextInputReceiverBotId: () => 99,
    async sendChunk() { entered.resolve(); return release.promise; } });
  const abort = new AbortController(), opening = runtime.openTextInput!(textRequest(abort.signal));
  try {
    await entered.promise;
    const source = runtime.captureTextInputSource!(target); assert.ok(source); source.assertCurrent();
    assert.equal(runtime.captureTextInputReceiver!({ requestId: source.requestId, messageId: 101, operatorId: 42, botId: 99,
      profile: "default", target }), undefined, "Pre-ACK source observation never fabricates an exact Reply publication");
    release.resolve(101); const opened = await opening; assert.ok(opened.ok);
    assert.equal(source.requestId, opened.handle.id); source.assertCurrent();
    abort.abort(); assert.deepEqual(await opened.handle.result, { status: "aborted" });
    assert.throws(source.assertCurrent); assert.equal(runtime.captureTextInputSource!(target), undefined);
  } finally { abort.abort(); release.resolve(101); await opening; runtime.shutdown(); }
});

test("Input source selection never promotes replaced history or borrows a successor", async () => {
  const { runtime } = confirmationHarness({ getTextInputReceiverBotId: () => 99 });
  try {
    const a = await runtime.openTextInput!(textRequest()); assert.ok(a.ok);
    const source = runtime.captureTextInputSource!(target); assert.ok(source);
    const b = await runtime.openTextInput!({ ...textRequest(), owner: "other-producer" }); assert.ok(b.ok);
    assert.deepEqual(await a.handle.result, { status: "replaced" }); assert.throws(source.assertCurrent);
    const successor = runtime.captureTextInputSource!(target); assert.ok(successor); successor.assertCurrent();
    assert.equal(successor.requestId, b.handle.id); assert.notEqual(successor.requestId, source.requestId);
    assert.throws(source.assertCurrent);
  } finally { runtime.shutdown(); }
});

for (const loss of ["profile", "operator", "bot", "target", "throw"] as const)
test(`Input source selection observes sticky ${loss} loss without settling the SDK result`, async () => {
  let lost = false;
  const { runtime, events } = confirmationHarness({
    getConfirmationAuthority: () => { if (lost && loss === "throw") throw new Error("private fixture detail");
      return { profile: lost && loss === "profile" ? "other" : "default", operatorId: lost && loss === "operator" ? 8 : 42 }; },
    getTextInputReceiverBotId: () => lost && loss === "bot" ? 98 : 99,
    getInstanceTarget: () => lost && loss === "target" ? { ...target, threadId: 8 } : target });
  try {
    const opened = await runtime.openTextInput!(textRequest()); assert.ok(opened.ok);
    const source = runtime.captureTextInputSource!(target); assert.ok(source);
    let settled = false; void opened.handle.result.then(() => { settled = true; }); const before = events.length;
    lost = true; assert.throws(source.assertCurrent, error => error instanceof Error && !error.message.includes("private fixture detail"));
    lost = false; assert.throws(source.assertCurrent); await Promise.resolve();
    assert.equal(settled, false); assert.equal(events.length, before);
  } finally { runtime.shutdown(); }
});

for (const port of ["getConfirmationAuthority", "isExplicitTargetAuthorized", "getTextInputReceiverBotId", "getInstanceTarget", "generation"] as const)
test(`Input source selection rejects ${port} renewal even after equal restoration`, async () => {
  const { runtime, deps } = confirmationHarness({ getTextInputReceiverBotId: () => 99 });
  try {
    const opened = await runtime.openTextInput!(textRequest()); assert.ok(opened.ok);
    const source = runtime.captureTextInputSource!(target); assert.ok(source);
    const original = deps[port];
    Object.assign(deps, { [port]: typeof original === "string" ? "generation-renewed" : original!.bind(deps) });
    assert.throws(source.assertCurrent); Object.assign(deps, { [port]: original }); assert.throws(source.assertCurrent);
  } finally { runtime.shutdown(); }
});

test("Input source selection poisons caught observation reentry while preserving the question", async () => {
  let reenter = false; let runtime: TelegramDeliveryRuntime;
  ({ runtime } = confirmationHarness({ getTextInputReceiverBotId: () => 99, getConfirmationAuthority: () => {
    if (reenter) { reenter = false; assert.equal(runtime.captureTextInputSource!(target), undefined); }
    return { profile: "default", operatorId: 42 };
  } }));
  try {
    const opened = await runtime.openTextInput!(textRequest()); assert.ok(opened.ok);
    const source = runtime.captureTextInputSource!(target); assert.ok(source);
    let settled = false; void opened.handle.result.then(() => { settled = true; });
    reenter = true; assert.throws(source.assertCurrent); assert.throws(source.assertCurrent);
    reenter = true; assert.equal(runtime.captureTextInputSource!(target), undefined);
    await Promise.resolve(); assert.equal(settled, false);
  } finally { runtime.shutdown(); }
});

test("Input source selection rechecks original target after its final authority observation", async () => {
  let armed = false, observations = 0, receiverTarget = target;
  const { runtime } = confirmationHarness({ getTextInputReceiverBotId: () => 99, getInstanceTarget: () => receiverTarget,
    getConfirmationAuthority: () => { if (armed && ++observations === 2) receiverTarget = { ...target, threadId: 8 };
      return { profile: "default", operatorId: 42 }; } });
  try {
    const opened = await runtime.openTextInput!(textRequest()); assert.ok(opened.ok);
    const source = runtime.captureTextInputSource!(target); assert.ok(source);
    armed = true; assert.throws(source.assertCurrent); armed = false; receiverTarget = target;
    assert.throws(source.assertCurrent); assert.equal(runtime.captureTextInputSource!(target), undefined);
  } finally { runtime.shutdown(); }
});

test("Input source selection refuses expired, shut down, non-Text and missing native-bot observations", async t => {
  const h = confirmationHarness({ getTextInputReceiverBotId: () => 99 });
  try {
    const other = await h.runtime.openConfirmation!(confirmationRequest()); assert.ok(other.ok);
    assert.equal(h.runtime.captureTextInputSource!(target), undefined);
    const opened = await h.runtime.openTextInput!(textRequest()); assert.ok(opened.ok);
    const source = h.runtime.captureTextInputSource!(target); assert.ok(source);
    let settled = false; void opened.handle.result.then(() => { settled = true; });
    const now = Date.now; t.mock.method(Date, "now", () => now() + 2000);
    assert.throws(source.assertCurrent); await Promise.resolve(); assert.equal(settled, false);
    t.mock.restoreAll(); h.runtime.shutdown(); assert.equal(h.runtime.captureTextInputSource!(target), undefined);
  } finally { h.runtime.shutdown(); }
  const old = confirmationHarness();
  try { assert.ok((await old.runtime.openTextInput!(textRequest())).ok); assert.equal(old.runtime.captureTextInputSource!(target), undefined); }
  finally { old.runtime.shutdown(); }
});

for (const ending of ["aborted", "cancelled", "expired", "submitted", "replaced"] as const)
test(`Original Input binding protects ${ending} history without restoring answer eligibility`, async t => {
  const { runtime, events } = confirmationHarness({ getTextInputReceiverBotId: () => 99 });
  const controller = new AbortController();
  try {
    const opened = await runtime.openTextInput!(textRequest(controller.signal)); assert.ok(opened.ok);
    const source = runtime.captureTextInputSource!(target); assert.ok(source); source.assertOriginalBinding();
    if (ending === "aborted") controller.abort();
    if (ending === "cancelled") runtime.acceptTextInputCancel!({ ...confirmationCallback(opened.handle.id), data: `tginput:${opened.handle.id}:cancel` });
    if (ending === "expired") { const now = Date.now; t.mock.method(Date, "now", () => now() + 2000); runtime.acceptTextInput!(textReply()); }
    if (ending === "submitted") runtime.acceptTextInput!(textReply());
    if (ending === "replaced") assert.ok((await runtime.openTextInput!({ ...textRequest(), owner: "successor" })).ok);
    const decision = await opened.handle.result; assert.equal(decision.status, ending);
    assert.throws(source.assertCurrent); assert.doesNotThrow(source.assertOriginalBinding); assert.throws(source.assertCurrent);
    await flushConfirmationEffects(); const count = events.length;
    source.assertOriginalBinding(); await Promise.resolve(); assert.equal(events.length, count);
    const current = runtime.captureTextInputSource!(target);
    if (ending === "replaced") { assert.ok(current); assert.notEqual(current.requestId, source.requestId); }
    else assert.equal(current, undefined, "No witness can be minted from retired history");
    runtime.shutdown(); assert.throws(source.assertOriginalBinding);
  } finally { t.mock.restoreAll(); runtime.shutdown(); }
});

for (const ending of ["cancelled", "expired", "aborted", "replaced", "submitted", "clock-only"] as const)
test(`Source non-use capture observes the actual original Input end, never a result getter (${ending})`, async t => {
  const h = confirmationHarness({ getTextInputReceiverBotId: () => 99 }), abort = new AbortController();
  try {
    const a = await h.runtime.openTextInput!(textRequest(abort.signal)); assert.ok(a.ok);
    const source = h.runtime.captureTextInputSource!(target); assert.ok(source);
    assert.equal(source.captureNonUse(), undefined);
    if (ending === "aborted") abort.abort();
    if (ending === "cancelled") h.runtime.acceptTextInputCancel!({ ...confirmationCallback(a.handle.id), data: `tginput:${a.handle.id}:cancel` });
    if (ending === "replaced") assert.ok((await h.runtime.openTextInput!({ ...textRequest(), owner: "B" })).ok);
    if (ending === "submitted") h.runtime.acceptTextInput!(textReply());
    if (ending === "expired" || ending === "clock-only") { const now = Date.now; t.mock.method(Date, "now", () => now() + 2000); }
    if (ending === "expired") h.runtime.acceptTextInput!(textReply());
    await flushConfirmationEffects();
    const before = h.events.length, fact = source.captureNonUse();
    if (ending === "submitted" || ending === "clock-only") assert.equal(fact, undefined);
    else {
      assert.ok(fact); assert.equal(fact.reason, ending); assert.ok(Object.isFrozen(fact));
      assert.deepEqual(Object.keys(fact).sort(), ["assertCurrent", "reason"]);
      fact.assertCurrent(); assert.equal(source.captureNonUse(), fact);
      assert.equal((await a.handle.result).status, ending);
    }
    assert.equal(h.events.length, before, "Capturing native non-use performs no question settlement or output");
    source.assertOriginalBinding();
    t.mock.restoreAll(); h.runtime.shutdown();
    assert.throws(source.captureNonUse); if (fact) assert.throws(fact.assertCurrent);
  } finally { t.mock.restoreAll(); h.runtime.shutdown(); }
});

test("Source non-use never relabels an invalidated original opening as cancelled or aborted", async () => {
  const entered = Promise.withResolvers<void>(), ack = Promise.withResolvers<number>();
  const h = confirmationHarness({ getTextInputReceiverBotId: () => 99, async sendChunk() { entered.resolve(); return ack.promise; } });
  const opening = h.runtime.openTextInput!(textRequest());
  try {
    await entered.promise;
    const source = h.runtime.captureTextInputSource!(target); assert.ok(source); assert.equal(source.captureNonUse(), undefined);
    ack.reject(new Error("Controlled publication failure")); const ended = await opening; assert.ok(!ended.ok);
    source.assertOriginalBinding(); assert.equal(source.captureNonUse(), undefined);
  } finally { ack.resolve(101); h.runtime.shutdown(); await opening; }
});

for (const loss of ["bot", "target", "authority", "renewal", "reentry"] as const)
test(`Source non-use native observation retains sticky ${loss} loss without reviving A`, async () => {
  let bot = 99, localTarget: typeof target | undefined = target, live = true, reenter = false;
  let fact: Readonly<TelegramTextInputNonUseObservation> | undefined;
  const h = confirmationHarness({ getTextInputReceiverBotId: () => bot, getInstanceTarget: () => localTarget,
    getConfirmationAuthority: () => { if (reenter) { try { fact!.assertCurrent(); } catch {} } return live ? { profile: "default", operatorId: 42 } : undefined; } });
  const abort = new AbortController();
  try {
    const a = await h.runtime.openTextInput!(textRequest(abort.signal)); assert.ok(a.ok);
    const source = h.runtime.captureTextInputSource!(target); assert.ok(source); abort.abort();
    fact = source.captureNonUse(); assert.ok(fact); fact.assertCurrent();
    const original = h.deps.getTextInputReceiverBotId;
    if (loss === "bot") bot = 100;
    if (loss === "target") localTarget = undefined;
    if (loss === "authority") live = false;
    if (loss === "renewal") h.deps.getTextInputReceiverBotId = () => 99;
    if (loss === "reentry") reenter = true;
    assert.throws(fact.assertCurrent); bot = 99; localTarget = target; live = true; reenter = false; h.deps.getTextInputReceiverBotId = original;
    assert.throws(fact.assertCurrent); assert.throws(source.captureNonUse);
    if (loss === "reentry") source.assertOriginalBinding();
    assert.equal((await a.handle.result).status, "aborted");
  } finally { h.runtime.shutdown(); }
});

test("Original Input binding is not reobserved merely to reject an already-terminal answer guard", async () => {
  let reads = 0;
  const { runtime } = confirmationHarness({ getTextInputReceiverBotId: () => 99, getConfirmationAuthority: () => {
    reads++; return { profile: "default", operatorId: 42 };
  } });
  const abort = new AbortController();
  try {
    const opened = await runtime.openTextInput!(textRequest(abort.signal)); assert.ok(opened.ok);
    const source = runtime.captureTextInputSource!(target); assert.ok(source); abort.abort(); await opened.handle.result;
    await flushConfirmationEffects(); const before = reads;
    assert.throws(source.assertCurrent); assert.equal(reads, before);
    source.assertOriginalBinding(); assert.ok(reads > before);
  } finally { runtime.shutdown(); }
});

for (const loss of ["profile", "operator", "bot", "target", "authorization", "throw"] as const)
test(`Original Input binding retains sticky ${loss} loss after terminalization`, async () => {
  let lost = false;
  const { runtime } = confirmationHarness({
    getConfirmationAuthority: () => { if (lost && loss === "throw") throw new Error("hidden binding detail");
      return { profile: lost && loss === "profile" ? "other" : "default", operatorId: lost && loss === "operator" ? 8 : 42 }; },
    getTextInputReceiverBotId: () => lost && loss === "bot" ? 98 : 99,
    getInstanceTarget: () => lost && loss === "target" ? { ...target, threadId: 8 } : target,
    isExplicitTargetAuthorized: () => !(lost && loss === "authorization") });
  const abort = new AbortController();
  try {
    const opened = await runtime.openTextInput!(textRequest(abort.signal)); assert.ok(opened.ok);
    const source = runtime.captureTextInputSource!(target); assert.ok(source);
    abort.abort(); await opened.handle.result; source.assertOriginalBinding();
    lost = true; assert.throws(source.assertOriginalBinding, error => error instanceof Error && !error.message.includes("hidden binding detail"));
    lost = false; assert.throws(source.assertOriginalBinding); assert.throws(source.assertCurrent);
  } finally { runtime.shutdown(); }
});

test("Original Input binding poisons caught negative-observation reentry after replacement", async () => {
  let source: ReturnType<NonNullable<TelegramDeliveryRuntime["captureTextInputSource"]>>, reenter = false;
  const { runtime } = confirmationHarness({ getTextInputReceiverBotId: () => 99, getConfirmationAuthority: () => {
    if (reenter) { reenter = false; try { source!.assertOriginalBinding(); } catch { /* original attempt remains poisoned */ } }
    return { profile: "default", operatorId: 42 };
  } });
  try {
    assert.ok((await runtime.openTextInput!(textRequest())).ok); source = runtime.captureTextInputSource!(target); assert.ok(source);
    assert.ok((await runtime.openTextInput!(textRequest())).ok);
    reenter = true; assert.throws(source.assertOriginalBinding); assert.throws(source.assertOriginalBinding);
  } finally { runtime.shutdown(); }
});

test("Original Input binding rechecks original target after final observation even outside the question map", async () => {
  let armed = false, observations = 0, receiverTarget = target;
  const { runtime } = confirmationHarness({ getTextInputReceiverBotId: () => 99, getInstanceTarget: () => receiverTarget,
    getConfirmationAuthority: () => { if (armed && ++observations === 2) receiverTarget = { ...target, threadId: 8 };
      return { profile: "default", operatorId: 42 }; } });
  const abort = new AbortController();
  try {
    const opened = await runtime.openTextInput!(textRequest(abort.signal)); assert.ok(opened.ok);
    const source = runtime.captureTextInputSource!(target); assert.ok(source); abort.abort(); await opened.handle.result;
    armed = true; assert.throws(source.assertOriginalBinding); armed = false; receiverTarget = target;
    assert.throws(source.assertOriginalBinding);
  } finally { runtime.shutdown(); }
});

type HeadTailQuestionKind = "confirmation" | "choice" | "text";
function openHeadTailQuestion(runtime: TelegramDeliveryRuntime, kind: HeadTailQuestionKind,
  signal = new AbortController().signal, timeoutMs?: number, scope: TelegramConfirmRequest["scope"] = { kind: "instance" }) {
  if (kind === "confirmation") {
    const request = confirmationRequest(signal); request.scope = scope;
    if (timeoutMs === undefined) delete request.timeoutMs; else request.timeoutMs = timeoutMs;
    return runtime.openConfirmation!(request);
  }
  if (kind === "choice") {
    const request = choiceRequest(signal); request.scope = scope;
    if (timeoutMs === undefined) delete request.timeoutMs; else request.timeoutMs = timeoutMs;
    return runtime.openChoice!(request);
  }
  const request = textRequest(signal); request.scope = scope;
  if (timeoutMs === undefined) delete request.timeoutMs; else request.timeoutMs = timeoutMs;
  return runtime.openTextInput!(request);
}

function originalQuestionProviderHarness(threaded = true, follower = false, overrides: Partial<TelegramDeliveryRuntimeDeps> = {}) {
  const destination = threaded ? target : { chatId: 42 }, state = { session: 1, token: "a", profile: "default", operator: 42, direct: !follower, epoch: 1, generation: 1, registered: true, target: { ...destination } };
  let captures = 0, guards = 0, onGuard: (() => void) | undefined, onAuthorize: (() => void) | undefined;
  const capture = createTelegramButtonSelectionAuthorityCapture({ captureSession() { const original = state.session; return () => state.session === original; },
    getTransportStamp: () => `${state.profile}/${state.token}`, isTransportStampActive: stamp => stamp === `${state.profile}/${state.token}`, getAllowedUserId: () => state.operator,
    ownsDirect: () => state.direct, getLeaderEpoch: () => state.epoch, getFollowerGeneration: () => state.generation, isFollowerRegistered: () => state.registered,
    getLeaderTarget: () => state.target, getFollowerTarget: () => state.target });
  const h = confirmationHarness({ questionHeadTail: true, getInstanceTarget: () => destination,
    captureQuestionAuthority() { captures++; const original = capture(); return original && (() => { guards++; const cb = onGuard; onGuard = undefined; cb?.(); original(); }); },
    isExplicitTargetAuthorized() { const cb = onAuthorize; onAuthorize = undefined; cb?.(); return true; }, ...overrides });
  return { ...h, state, captures: () => captures, guards: () => guards, setGuard(cb: () => void) { onGuard = cb; }, setAuthorize(cb: () => void) { onAuthorize = cb; } };
}

for (const threaded of [false, true]) for (const loss of ["session", "token", "profile", "operator", "role", "epoch", "generation", "registration", "target"] as const)
for (const phase of ["before", "metadata", "final-observed"] as const)
test(`Private original question provider retains native history (${loss}/${phase}/Thread=${threaded})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 }); clearTelegramDeliveryRuntime();
  const h = originalQuestionProviderHarness(threaded, loss === "generation" || loss === "registration"), saved = structuredClone(h.state);
  try {
    bindTelegramDeliveryRuntime(h.runtime); const opened = await openHeadTailQuestion(h.runtime, "confirmation"); assert.ok(opened.ok); let ended = false; void opened.handle.result.then(() => { ended = true; });
    const owner = captureTelegramQuestionLifetimeOwner()!, peer = captureTelegramQuestionLifetimeOwner()!, observer = h.runtime.captureQuestionLifetimeOwner!()!; assert.ok(owner && peer && observer); let barrier = 0;
    const lose = () => { if (loss === "session") h.state.session++; if (loss === "token") h.state.token = "b"; if (loss === "profile") h.state.profile = "other";
      if (loss === "operator") h.state.operator++; if (loss === "role") h.state.direct = !h.state.direct; if (loss === "epoch") h.state.epoch++;
      if (loss === "generation") h.state.generation++; if (loss === "registration") h.state.registered = false; if (loss === "target") h.state.target = { chatId: 43 }; };
    const apply = owner.captureTail({ scopes: [peer.scope], assertCurrent() { if (++barrier === 2 && phase === "final-observed") { lose(); assert.throws(observer.assertCurrent, /unavailable/u); } } });
    if (phase === "before") lose(); if (phase === "metadata") h.setAuthorize(lose);
    assert.throws(apply, /unavailable/u); Object.assign(h.state, saved); assert.throws(owner.assertCurrent, /unavailable/u); assert.throws(peer.assertCurrent, /unavailable/u);
    assert.equal(captureTelegramQuestionLifetimeOwner(), undefined); assert.equal(h.runtime.captureQuestionLifetimeOwner!(), undefined); assert.equal(h.captures(), 1, "One original guard is shared, never renewed per owner/peer or restored field");
    assert.equal((await openHeadTailQuestion(h.runtime, "confirmation")).ok, false, "Lost runtime provider cannot admit a new question");
    t.mock.timers.tick(3_600_000); await Promise.resolve(); assert.equal(ended, false, "A refused lifetime shortening does not imply SDK question completion");
  } finally { h.runtime.shutdown(); clearTelegramDeliveryRuntime(); }
});

for (const kind of ["confirmation", "choice", "text"] as const)
for (const lossAt of ["before", "callback"] as const)
test(`Private original question provider fences SDK acceptance (${kind}/${lossAt})`, async () => {
  const h = originalQuestionProviderHarness();
  try {
    const opened = await openHeadTailQuestion(h.runtime, kind); assert.ok(opened.ok); let callbackCalls = 0; const callback = () => { if (++callbackCalls === 2) h.state.session++; };
    if (lossAt === "before") h.state.session++; let accepted: boolean;
    if (kind === "confirmation") { const answer = h.runtime.acceptConfirmation!({ ...confirmationCallback(opened.handle.id) }, lossAt === "callback" ? callback : undefined); accepted = answer.handled && answer.accepted; }
    else if (kind === "choice") { const answer = h.runtime.acceptChoice!({ ...confirmationCallback(opened.handle.id), data: `tgchoice:${opened.handle.id}:0` }, lossAt === "callback" ? callback : undefined); accepted = answer.handled && answer.accepted; }
    else { const answer = h.runtime.acceptTextInput!(textReply(), lossAt === "callback" ? callback : undefined); accepted = answer.handled && answer.accepted; }
    assert.equal(accepted, false); assert.deepEqual(await opened.handle.result, { status: "invalidated" }); assert.equal(h.captures(), 1);
  } finally { h.runtime.shutdown(); }
});

for (const malformed of ["absent", "capture-async", "guard-async", "guard-value"] as const)
test(`Private original question provider refuses uncertainty once without awaiting (${malformed})`, async () => {
  let captures = 0, guards = 0;
  const h = confirmationHarness({ questionHeadTail: true, captureQuestionAuthority: (() => { captures++;
    if (malformed === "absent") return undefined; if (malformed === "capture-async") return Promise.reject(Error("capture"));
    return () => { guards++; return malformed === "guard-async" ? Promise.reject(Error("guard")) : true; };
  }) as TelegramDeliveryRuntimeDeps["captureQuestionAuthority"] });
  try { assert.equal(h.runtime.captureQuestionLifetimeOwner!(), undefined); assert.equal(h.runtime.captureQuestionLifetimeOwner!(), undefined); assert.equal((await openHeadTailQuestion(h.runtime, "confirmation")).ok, false);
    assert.equal(captures, 1); assert.equal(guards, malformed.startsWith("guard") ? 1 : 0); await Promise.resolve();
  } finally { h.runtime.shutdown(); }
});

test("Private original question provider pins the constructor factory and ends callbacks before the final data barrier", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 }); const h = originalQuestionProviderHarness(); let renewal = 0, atBarrier = 0;
  try {
    h.deps.captureQuestionAuthority = () => { renewal++; return () => {}; };
    const opened = await openHeadTailQuestion(h.runtime, "confirmation"); assert.ok(opened.ok); let ended = false; void opened.handle.result.then(() => { ended = true; });
    const owner = h.runtime.captureQuestionLifetimeOwner!()!, peer = h.runtime.captureQuestionLifetimeOwner!()!; assert.ok(owner && peer);
    const apply = owner.captureTail({ scopes: [peer.scope], assertCurrent() { atBarrier = h.guards(); } }); apply(); assert.equal(h.guards(), atBarrier, "No provider callbacks after a successful final-use data barrier");
    assert.equal(renewal, 0); assert.equal(h.captures(), 1); t.mock.timers.tick(3_600_000); await Promise.resolve(); assert.equal(ended, true);
  } finally { h.runtime.shutdown(); }
});

for (const kind of ["confirmation", "choice", "text"] as const) for (const at of ["before", "metadata"] as const)
test(`Private original question provider retains terminal acceptance authority (${kind}/${at})`, async () => {
  const h = originalQuestionProviderHarness();
  try {
    const opened = await openHeadTailQuestion(h.runtime, kind); assert.ok(opened.ok);
    const accepted = kind === "confirmation" ? h.runtime.acceptConfirmation!(confirmationCallback(opened.handle.id)) : kind === "choice" ?
      h.runtime.acceptChoice!({ ...confirmationCallback(opened.handle.id), data: `tgchoice:${opened.handle.id}:0` }) : h.runtime.acceptTextInput!(textReply());
    assert.ok(accepted.handled && accepted.accepted); accepted.assertCurrent();
    if (at === "before") h.state.session++; else h.setAuthorize(() => { h.state.session++; });
    assert.throws(accepted.assertCurrent); h.state.session = 1; assert.throws(accepted.assertCurrent); assert.equal(h.captures(), 1);
  } finally { h.runtime.shutdown(); }
});

for (const ending of ["waiting", "submitted"] as const)
test(`Private original question provider retains terminal-safe Text source binding (${ending})`, async () => {
  const h = originalQuestionProviderHarness(true, false, { getTextInputReceiverBotId: () => 99 });
  try {
    const opened = await openHeadTailQuestion(h.runtime, "text"); assert.ok(opened.ok); const source = h.runtime.captureTextInputSource!(target); assert.ok(source); source.assertOriginalBinding();
    if (ending === "submitted") { const accepted = h.runtime.acceptTextInput!(textReply()); assert.ok(accepted.handled && accepted.accepted); source.assertOriginalBinding(); }
    h.state.session++; assert.throws(source.assertOriginalBinding); h.state.session = 1; assert.throws(source.assertOriginalBinding); assert.equal(h.captures(), 1);
  } finally { h.runtime.shutdown(); }
});

for (const kind of ["confirmation", "choice", "text"] as const)
test(`Private original question provider loss does not release issued SDK work (${kind})`, async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<number>(); let calls = 0;
  const h = originalQuestionProviderHarness(true, false, { async sendChunk() { calls++; entered.resolve(); return release.promise; } });
  try {
    const opening = openHeadTailQuestion(h.runtime, kind); await entered.promise; const owner = h.runtime.captureQuestionLifetimeOwner!()!; assert.ok(owner);
    h.state.session++; assert.throws(owner.assertCurrent); h.runtime.shutdown(); assert.equal(h.runtime.hasPendingTarget!(target), true, "Logical loss/shutdown cannot release the actual issued target lane");
    assert.equal((await openHeadTailQuestion(h.runtime, kind)).ok, false); assert.equal(calls, 1); release.resolve(101); assert.equal((await opening).ok, false);
    await flushConfirmationEffects(); assert.equal(h.runtime.hasPendingTarget!(target), false); assert.equal(h.captures(), 1);
  } finally { release.resolve(101); h.runtime.shutdown(); }
});

test("Private original question provider remains omitted by default and validates only the opted-in port", async () => {
  let reads = 0; const base = confirmationHarness();
  Object.defineProperty(base.deps, "captureQuestionAuthority", { get() { reads++; throw Error("Unwired"); }, configurable: true });
  const off = createConcreteDeliveryRuntime(base.deps);
  try { assert.ok((await openHeadTailQuestion(off, "confirmation")).ok); assert.equal(reads, 0); }
  finally { base.runtime.shutdown(); off.shutdown(); }
  for (const value of [false, null, 1, "capture"]) assert.throws(() => confirmationHarness({ questionHeadTail: true, captureQuestionAuthority: value as unknown as TelegramDeliveryRuntimeDeps["captureQuestionAuthority"] }), /capture must be a function/u);
});

for (const reenter of ["capture", "guard"] as const)
test(`Private original question provider capture and guard reentry refuse without renewal (${reenter})`, () => {
  let runtime: TelegramDeliveryRuntime | undefined, captures = 0, guards = 0;
  const h = confirmationHarness({ questionHeadTail: true, captureQuestionAuthority() { captures++; if (reenter === "capture") assert.equal(runtime!.captureQuestionLifetimeOwner!(), undefined);
    return () => { guards++; if (reenter === "guard") assert.equal(runtime!.captureQuestionLifetimeOwner!(), undefined); };
  } }); runtime = h.runtime;
  try { assert.equal(runtime.captureQuestionLifetimeOwner!(), undefined); assert.equal(captures, 1); assert.ok(guards >= 1); }
  finally { runtime.shutdown(); }
});

for (const kind of ["task", "attachment"] as const)
test(`Private original question provider excludes other owners before and after refusal (${kind})`, async () => {
  let captures = 0; const h = attachmentHarness({ questionHeadTail: true, captureQuestionAuthority() { captures++; return undefined; } });
  const open = () => kind === "task" ? h.runtime.openTaskView!(taskRequest()) : h.runtime.openAttachmentQuestion!(attachmentQuestion());
  try { assert.ok((await open()).ok); assert.equal(captures, 0); assert.equal(h.runtime.captureQuestionLifetimeOwner!(), undefined); assert.equal(captures, 1); assert.ok((await open()).ok); assert.equal(captures, 1); }
  finally { h.runtime.shutdown(); }
});

for (const change of ["shutdown", "rebind"] as const)
test(`Private original question provider closes native flags after the last guard callback (${change})`, () => {
  clearTelegramDeliveryRuntime(); const h = originalQuestionProviderHarness();
  try {
    bindTelegramDeliveryRuntime(h.runtime); const owner = captureTelegramQuestionLifetimeOwner()!; assert.ok(owner);
    h.setAuthorize(() => { h.setGuard(() => { if (change === "shutdown") h.runtime.shutdown(); else bindTelegramDeliveryRuntime(h.runtime); }); });
    assert.throws(owner.assertCurrent, /unavailable/u, "The last original provider callback cannot invalidate native flags after their check"); assert.equal(h.captures(), 1);
  } finally { h.runtime.shutdown(); clearTelegramDeliveryRuntime(); }
});

for (const queued of [false, true])
test(`Private original question provider fences terminal cleanup on its original lane (queued=${queued})`, async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<number>(); let blocked = false, edits = 0;
  const h = originalQuestionProviderHarness(true, false, { async sendChunk() { if (blocked) { entered.resolve(); return release.promise; } return 101; }, async editChunk() { edits++; } });
  try {
    const opened = await openHeadTailQuestion(h.runtime, "confirmation"); assert.ok(opened.ok); let blocker: Promise<unknown> | undefined;
    if (queued) { blocked = true; blocker = h.runtime.sendView({ text: "blocker" }, { scope: { kind: "instance" } }); await entered.promise; }
    if (!queued) h.state.session++;
    const accepted = h.runtime.acceptConfirmation!(confirmationCallback(opened.handle.id)); assert.equal(accepted.handled && accepted.accepted, queued);
    if (queued) { h.state.session++; assert.equal(h.runtime.hasPendingTarget!(target), true); release.resolve(102); await blocker; }
    await flushConfirmationEffects(); assert.equal(edits, 0, "Logical retirement cannot edit under a replacement provider"); assert.equal(h.captures(), 1);
  } finally { release.resolve(102); h.runtime.shutdown(); }
});

type BridgeQuestionDeps = Parameters<typeof createTelegramBridgeDeliveryRuntime>[0];
type BridgeQuestionLifecycleDeps = BridgeQuestionDeps & Pick<Parameters<typeof createTelegramBridgeDeliveryLifecycleHooks>[0], "captureRuntimeAuthority" | "onTransportRefreshFailure" | "coordinateQuestionsWhenAuthorized">;
async function bridgeQuestionHarness(lifecycle = false, threaded = true, configure?: (deps: BridgeQuestionLifecycleDeps) => void) {
  const destination = threaded ? target : { chatId: 42 }, state = { session: 1, token: "a", epoch: 1, generation: 1, registered: true, direct: true, target: { ...destination }, stamp: 1 };
  const stats = { captures: 0, admissions: 0, sends: 0, ownership: 0 }; let onAdmission: ((value: TelegramQuestionAdmission) => unknown) | undefined, onSend: (() => Promise<void>) | undefined;
  const capture = createTelegramButtonSelectionAuthorityCapture({ captureSession() { const original = state.session; return () => state.session === original; },
    getTransportStamp: () => state.token, isTransportStampActive: stamp => stamp === state.token, getAllowedUserId: () => 42, ownsDirect: () => state.direct,
    getLeaderEpoch: () => state.epoch, getFollowerGeneration: () => state.generation, isFollowerRegistered: () => state.registered,
    getLeaderTarget: () => state.target, getFollowerTarget: () => state.target });
  const deps: BridgeQuestionLifecycleDeps & { generationSeed: string; getTransportStamp: () => number; isTransportStampActive: (stamp: number) => boolean } = {
    generationSeed: "bridge-policy", getTransportStamp: () => state.stamp, isTransportStampActive: stamp => stamp === state.stamp,
    generation: "bridge-question", questionHeadTail: true, captureQuestionAuthority() { assert.equal(this, deps); stats.captures++; return capture(); },
    onQuestionAdmission(a) { assert.equal(this, deps); stats.admissions++; return onAdmission?.(a); },
    getProfileName: () => "default", getTargetPolicyView: () => ({ canDeliver: true, ownsDirect: true, allowedChatId: 42, leaderTarget: destination }), getActiveTurnTarget: () => destination,
    api: { async sendMessage() { stats.sends++; await onSend?.(); return { message_id: 100 + stats.sends }; }, async editMessageText() { return "edited"; }, async deleteMessage() {}, async sendChatAction() { return true; } },
    recordOwnership() { stats.ownership++; } };
  configure?.(deps);
  const hooks = lifecycle ? createTelegramBridgeDeliveryLifecycleHooks(deps) : undefined;
  // Use the caller's exact option receiver, including getters, for both constructors.
  const direct = lifecycle ? undefined : createTelegramBridgeDeliveryRuntime(deps);
  if (hooks) await hooks.onSessionStart(); else bindTelegramDeliveryRuntime(direct!);
  const runtime = () => Object.getOwnPropertyDescriptor(globalThis, "__piTelegramDeliveryRuntime__")!.value.runtime as TelegramDeliveryRuntime;
  return { deps, state, stats, runtime, hooks, destination, setAdmission(fn: (a: TelegramQuestionAdmission) => unknown) { onAdmission = fn; }, setSend(fn: () => Promise<void>) { onSend = fn; },
    async stop() { if (hooks) await hooks.onSessionShutdown(); else direct!.shutdown(); clearTelegramDeliveryRuntime(); } };
}

test("Production question coordination retains independent UI until an original publisher exists and never borrows a successor", async () => {
  clearTelegramDeliveryRuntime(); let publisher: object | undefined, captures = 0;
  const h = await bridgeQuestionHarness(true, false, deps => {
    deps.coordinateQuestionsWhenAuthorized = true;
    deps.captureRuntimeAuthority = () => () => {};
    deps.captureQuestionAuthority = () => {
      captures++; const original = publisher;
      return original ? () => { if (publisher !== original) throw new Error("Original publisher ended"); } : undefined;
    };
  });
  try {
    const original = h.runtime(), independent = await openHeadTailQuestion(original, "confirmation"); assert.ok(independent.ok);
    assert.equal(original.captureQuestionLifetimeOwner!(), undefined); assert.equal(h.stats.admissions, 0);
    await h.hooks!.onTransportChanged(); assert.equal(h.runtime(), original);
    publisher = {}; await h.hooks!.onTransportChanged(); assert.notEqual(h.runtime(), original);
    assert.deepEqual(await independent.handle.result, { status: "invalidated" });
    const coordinated = h.runtime(), head = await openHeadTailQuestion(coordinated, "confirmation"); assert.ok(head.ok);
    assert.ok(coordinated.captureQuestionLifetimeOwner!()); assert.equal(h.stats.admissions, 1);
    const before = captures; await h.hooks!.onTransportChanged(); assert.equal(captures, before); assert.equal(h.runtime(), coordinated);
    publisher = {}; assert.equal((await openHeadTailQuestion(coordinated, "choice")).ok, false);
    assert.equal(captures, before, "A question cannot capture a newer provider from its old runtime");
    await h.hooks!.onTransportChanged(); assert.notEqual(h.runtime(), coordinated);
    assert.deepEqual(await head.handle.result, { status: "invalidated" });
    const next = await openHeadTailQuestion(h.runtime(), "choice"); assert.ok(next.ok); assert.equal(h.stats.admissions, 2);
    publisher = undefined; await h.hooks!.onTransportChanged();
    assert.deepEqual(await next.handle.result, { status: "invalidated" });
    assert.ok((await openHeadTailQuestion(h.runtime(), "confirmation")).ok); assert.equal(h.stats.admissions, 2);
  } finally { await h.stop(); }
});

for (const incarnation of [true, false]) for (const change of ["same-registration", "stopped", "target"] as const)
test(`Delivery transport reconciliation replaces only ended native registration scopes (incarnation=${incarnation}/${change})`, async () => {
  clearTelegramDeliveryRuntime();
  const registration = createTelegramBusFollowerRegistrationState(), destination = { chatId: 42, threadId: 7 };
  const metadata = { generation: "same-generation", sessionId: "session", ...(incarnation ? { registrationIncarnation: "a".repeat(48) } : {}) };
  registration.setRegistered(true, destination, metadata);
  let captures = 0;
  const capture = createTelegramButtonSelectionAuthorityCapture({
    captureSession: () => () => true, getTransportStamp: () => 1, isTransportStampActive: () => true,
    getAllowedUserId: () => 42, ownsDirect: () => false, getLeaderEpoch: () => undefined,
    getFollowerGeneration: registration.getGeneration, isFollowerRegistered: registration.isRegistered,
    getLeaderTarget: () => undefined, getFollowerTarget: registration.getTarget,
    captureFollowerRegistration: registration.capturePublicationRegistration!,
  });
  const h = await bridgeQuestionHarness(true, true, deps => {
    delete deps.questionHeadTail; delete deps.onQuestionAdmission; delete deps.captureQuestionAuthority;
    deps.captureRuntimeAuthority = () => { captures++; return capture(); };
  });
  try {
    const original = h.runtime(), opened = await openHeadTailQuestion(original, "confirmation"); assert.ok(opened.ok);
    assert.equal(captures, 1); await h.hooks!.onTransportChanged();
    assert.equal(h.runtime(), original); assert.equal(captures, 1, "Same native lifetime does not reset questions or recapture");
    if (change === "stopped") registration.setRegistered(false);
    else registration.setRegistered(true, change === "target" ? { ...destination, threadId: 8 } : destination, metadata);
    await h.hooks!.onTransportChanged();
    assert.notEqual(h.runtime(), original); assert.equal(captures, 2);
    assert.deepEqual(await opened.handle.result, { status: "invalidated" });
    assert.ok((await openHeadTailQuestion(h.runtime(), "confirmation")).ok, "Independent UI remains available under its ordinary target policy");
    if (!incarnation) assert.equal(registration.captureArtifactRegistration!(), undefined, "A local legacy registration never acquires Artifact authority");
    await h.hooks!.onSessionShutdown();
    registration.setRegistered(true, destination, metadata); await h.hooks!.onTransportChanged();
    assert.equal((await openTelegramConfirm(confirmationRequest())).ok, false, "A late transport notification cannot resurrect a stopped session");
  } finally { await h.stop(); }
});

for (const ending of ["transport", "shutdown"] as const)
test(`Delivery transport replacement retains actual old I/O without publishing stale ownership (${ending})`, async () => {
  clearTelegramDeliveryRuntime(); let owner = {};
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const h = await bridgeQuestionHarness(true, false, deps => {
    delete deps.questionHeadTail; delete deps.onQuestionAdmission; delete deps.captureQuestionAuthority;
    deps.captureRuntimeAuthority = () => { const captured = owner; return () => { if (captured !== owner) throw new Error("Ended owner"); }; };
  });
  h.setSend(async () => { entered.resolve(); await release.promise; });
  const original = h.runtime(); let pending: Promise<unknown> | undefined;
  try {
    pending = openHeadTailQuestion(original, "confirmation"); await entered.promise;
    owner = {};
    if (ending === "transport") await h.hooks!.onTransportChanged(); else await h.hooks!.onSessionShutdown();
    assert.equal((await pending as { ok: boolean }).ok, false, "Logical invalidation does not wait for the old send");
    assert.equal(original.hasPendingTarget?.(h.destination), true, "Original native work keeps its target until actual settlement");
    release.resolve(); await flushConfirmationEffects();
    assert.equal(h.stats.ownership, 0, "A late old send cannot record ownership into the current runtime");
    assert.equal(original.hasPendingTarget?.(h.destination), false);
  } finally { release.resolve(); await pending; await h.stop(); }
});

test("Delivery transport capture failure retires the ended runtime before any later recovery", async () => {
  clearTelegramDeliveryRuntime(); let owner = {}, fail = false;
  const h = await bridgeQuestionHarness(true, false, deps => {
    delete deps.questionHeadTail; delete deps.onQuestionAdmission; delete deps.captureQuestionAuthority;
    deps.captureRuntimeAuthority = () => {
      if (fail) throw new Error("Uncertain native capture");
      const captured = owner; return () => { if (owner !== captured) throw new Error("Ended owner"); };
    };
  });
  try {
    const opened = await openHeadTailQuestion(h.runtime(), "confirmation"); assert.ok(opened.ok);
    owner = {}; fail = true;
    await assert.rejects(h.hooks!.onTransportChanged(), /Uncertain native capture/u);
    assert.deepEqual(await opened.handle.result, { status: "invalidated" });
    assert.equal((await openTelegramConfirm(confirmationRequest())).ok, false);
    fail = false; await h.hooks!.onTransportChanged();
    assert.ok((await openHeadTailQuestion(h.runtime(), "confirmation")).ok, "Fresh native evidence may construct a new runtime, never restore the old one");
  } finally { await h.stop(); }
});

for (const diagnostic of ["throw", "async"] as const)
test(`Detached Delivery transport refresh records failure without rejecting the native notification (${diagnostic})`, async () => {
  clearTelegramDeliveryRuntime(); let owner = {}, fail = false, recorded = 0;
  const h = await bridgeQuestionHarness(true, false, deps => {
    delete deps.questionHeadTail; delete deps.onQuestionAdmission; delete deps.captureQuestionAuthority;
    deps.captureRuntimeAuthority = () => {
      if (fail) throw new Error("Original native capture failure");
      const captured = owner; return () => { if (owner !== captured) throw new Error("Ended owner"); };
    };
    deps.onTransportRefreshFailure = error => {
      recorded++; assert.match(String(error), /Original native capture failure/u);
      if (diagnostic === "throw") throw new Error("Diagnostic sink failed");
      return Promise.reject(new Error("Async diagnostic sink failed"));
    };
  });
  try {
    const opened = await openHeadTailQuestion(h.runtime(), "confirmation"); assert.ok(opened.ok);
    owner = {}; fail = true;
    assert.equal(h.hooks!.requestTransportRefresh(), undefined);
    await flushConfirmationEffects(); assert.equal(recorded, 1);
    assert.deepEqual(await opened.handle.result, { status: "invalidated" });
    fail = false; h.hooks!.requestTransportRefresh(); await flushConfirmationEffects();
    assert.ok((await openHeadTailQuestion(h.runtime(), "confirmation")).ok);
  } finally { await h.stop(); }
});

test("Delivery transport reconciliation upgrades an unavailable initial owner without changing ordinary UI defaults", async () => {
  clearTelegramDeliveryRuntime(); let owner: object | undefined;
  const h = await bridgeQuestionHarness(true, false, deps => {
    delete deps.questionHeadTail; delete deps.onQuestionAdmission; delete deps.captureQuestionAuthority;
    deps.captureRuntimeAuthority = () => { const captured = owner; return captured ? () => { if (owner !== captured) throw new Error("Ended native owner"); } : undefined; };
  });
  try {
    const original = h.runtime(), question = await openHeadTailQuestion(original, "choice"); assert.ok(question.ok);
    await h.hooks!.onTransportChanged(); assert.equal(h.runtime(), original);
    owner = {}; await h.hooks!.onTransportChanged(); assert.notEqual(h.runtime(), original);
    assert.deepEqual(await question.handle.result, { status: "invalidated" });
    const current = h.runtime(); await h.hooks!.onTransportChanged(); assert.equal(h.runtime(), current);
    owner = undefined; await h.hooks!.onTransportChanged(); assert.notEqual(h.runtime(), current);
    const offline = h.runtime(); await h.hooks!.onTransportChanged(); assert.equal(h.runtime(), offline);
  } finally { await h.stop(); }
});

for (const lifecycle of [false, true]) for (const threaded of [false, true]) for (const kind of ["confirmation", "choice"] as const)
test(`Private Bridge question policy forwards native admission and SDK tail (${lifecycle}/${threaded}/${kind})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 }); clearTelegramDeliveryRuntime();
  const h = await bridgeQuestionHarness(lifecycle, threaded);
  try {
    const owner = captureTelegramQuestionLifetimeOwner(); assert.ok(owner); const admissions: TelegramQuestionAdmission[] = [];
    h.setAdmission(a => { assert.equal(owner.assertAdmission(a), 1000); admissions.push(a); });
    const first = await openHeadTailQuestion(h.runtime(), kind), last = await openHeadTailQuestion(h.runtime(), kind); assert.ok(first.ok && last.ok);
    assert.equal(h.stats.admissions, 2); assert.equal(admissions.length, 2); assert.equal(h.stats.captures, 1); assert.throws(() => owner.assertAdmission(admissions[0]), /unavailable/u);
    let ended = false; void last.handle.result.then(() => { ended = true; }); t.mock.timers.tick(3_600_000); await Promise.resolve();
    assert.deepEqual(await first.handle.result, { status: "expired" }); assert.equal(ended, false); assert.deepEqual(owner.target, h.destination);
  } finally { await h.stop(); }
});

for (const lifecycle of [false, true]) for (const malformed of ["missing", "unavailable", "capture-async", "guard-async"] as const)
test(`Private Bridge question policy holds absent or uncertain original providers (${lifecycle}/${malformed})`, async () => {
  let calls = 0; clearTelegramDeliveryRuntime(); const h = await bridgeQuestionHarness(lifecycle, true, deps => {
    if (malformed === "missing") delete deps.captureQuestionAuthority;
    else deps.captureQuestionAuthority = (() => { calls++; if (malformed === "unavailable") return undefined; if (malformed === "capture-async") return Promise.reject(Error("capture")); return () => Promise.reject(Error("guard")); }) as BridgeQuestionDeps["captureQuestionAuthority"];
  });
  try { assert.equal(captureTelegramQuestionLifetimeOwner(), undefined); assert.equal(captureTelegramQuestionLifetimeOwner(), undefined);
    assert.equal((await openHeadTailQuestion(h.runtime(), "confirmation")).ok, false); assert.equal(h.stats.sends, 0); assert.equal(h.stats.admissions, 0);
    assert.equal(calls, malformed === "missing" ? 0 : 1); assert.equal((await h.runtime().sendView({ text: "ordinary" }, { scope: { kind: "instance" } })).ok, true); await Promise.resolve();
  } finally { await h.stop(); }
});

for (const lifecycle of [false, true]) for (const threaded of [false, true]) for (const loss of ["session", "token", "epoch", "role", "generation", "registration"] as const)
test(`Private Bridge question policy retains original provider despite equal output policy (${lifecycle}/${threaded}/${loss})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 }); clearTelegramDeliveryRuntime();
  const h = await bridgeQuestionHarness(lifecycle, threaded); if (loss === "generation" || loss === "registration") h.state.direct = false;
  const saved = structuredClone(h.state);
  try { const opened = await openHeadTailQuestion(h.runtime(), "confirmation"); assert.ok(opened.ok); let ended = false; void opened.handle.result.then(() => { ended = true; });
    const owner = captureTelegramQuestionLifetimeOwner(); assert.ok(owner); const apply = owner.captureTail();
    if (loss === "session") h.state.session++; if (loss === "token") h.state.token = "b"; if (loss === "epoch") h.state.epoch++;
    if (loss === "role") h.state.direct = false; if (loss === "generation") h.state.generation++; if (loss === "registration") h.state.registered = false;
    assert.throws(apply, /unavailable/u); Object.assign(h.state, saved); assert.throws(owner.assertCurrent, /unavailable/u); assert.equal(captureTelegramQuestionLifetimeOwner(), undefined);
    assert.equal((await openHeadTailQuestion(h.runtime(), "confirmation")).ok, false); assert.equal(h.stats.captures, 1); assert.equal(h.stats.admissions, 1);
    t.mock.timers.tick(3_600_000); await Promise.resolve(); assert.equal(ended, false, "Refusal is not SDK completion or a tail grant");
  } finally { await h.stop(); }
});

for (const lifecycle of [false, true]) for (const enabled of [false, true])
test(`Private Bridge question policy pins private getters once and preserves omission (${lifecycle}/${enabled})`, async () => {
  clearTelegramDeliveryRuntime(); const reads = { policy: 0, capture: 0, observer: 0 }; let replacements = 0;
  const h = await bridgeQuestionHarness(lifecycle, true, deps => { const original = deps.captureQuestionAuthority, observer = deps.onQuestionAdmission;
    Object.defineProperties(deps, { questionHeadTail: { configurable: true, enumerable: true, get() { reads.policy++; return enabled ? true : undefined; } },
      captureQuestionAuthority: { configurable: true, enumerable: true, get() { reads.capture++; return reads.capture === 1 ? original : () => { replacements++; return () => {}; }; } },
      onQuestionAdmission: { configurable: true, enumerable: true, get() { reads.observer++; return reads.observer === 1 ? observer : () => { replacements++; }; } } });
  });
  try { const first = await openHeadTailQuestion(h.runtime(), "confirmation"); assert.ok(first.ok); assert.equal(!!captureTelegramQuestionLifetimeOwner(), enabled);
    if (h.hooks) { h.state.session++; await h.hooks.onSessionStart(); assert.ok((await openHeadTailQuestion(h.runtime(), "confirmation")).ok); }
    assert.deepEqual(reads, { policy: 1, capture: enabled ? 1 : 0, observer: enabled ? 1 : 0 }); assert.equal(replacements, 0);
  } finally { await h.stop(); }
});

for (const threaded of [false, true])
test(`Private Bridge question lifecycle ends original runtime and cannot shorten successor (${threaded})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 }); clearTelegramDeliveryRuntime(); const h = await bridgeQuestionHarness(true, threaded);
  try { const first = await openHeadTailQuestion(h.runtime(), "confirmation"); assert.ok(first.ok); const original = captureTelegramQuestionLifetimeOwner(); assert.ok(original); const apply = original.captureTail();
    const generation = h.runtime().generation; h.state.session++; await h.hooks!.onSessionStart(); assert.notEqual(h.runtime().generation, generation);
    assert.deepEqual(await first.handle.result, { status: "invalidated" }); const successor = captureTelegramQuestionLifetimeOwner(); assert.ok(successor);
    const last = await openHeadTailQuestion(h.runtime(), "confirmation"); assert.ok(last.ok); let ended = false; void last.handle.result.then(() => { ended = true; });
    assert.throws(apply, /unavailable/u); assert.throws(() => original.assertScope(successor.scope), /unavailable/u); assert.throws(() => successor.assertScope(original.scope), /unavailable/u);
    t.mock.timers.tick(3_600_000); await Promise.resolve(); assert.equal(ended, false); assert.equal(h.stats.captures, 2);
    successor.captureTail()(); t.mock.timers.tick(3_600_000); await Promise.resolve(); assert.deepEqual(await last.handle.result, { status: "expired" });
    await h.hooks!.onSessionShutdown(); assert.equal(captureTelegramQuestionLifetimeOwner(), undefined); assert.throws(successor.assertCurrent, /unavailable/u);
  } finally { await h.stop(); }
});

for (const lifecycle of [false, true])
test(`Private Bridge question policy guards ownership after issued native work drains (${lifecycle})`, async () => {
  clearTelegramDeliveryRuntime(); const h = await bridgeQuestionHarness(lifecycle), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const runtime = h.runtime(); h.setSend(async () => { entered.resolve(); await release.promise; });
  try { const opening = openHeadTailQuestion(runtime, "confirmation"); await entered.promise; assert.equal(runtime.hasPendingTarget!(target), true); h.state.session++;
    const owner = runtime.captureQuestionLifetimeOwner!(); assert.equal(owner, undefined); assert.equal(runtime.hasPendingTarget!(target), true); release.resolve();
    assert.equal((await opening).ok, false); assert.equal(runtime.hasPendingTarget!(target), false); assert.equal(h.stats.ownership, 0, "Late ACK cannot record an original question under replacement context");
  } finally { release.resolve(); await h.stop(); }
});

for (const lifecycle of [false, true]) for (const field of ["policy", "observer", "capture"] as const)
test(`Private Bridge question policy validates opt-in fields at construction (${lifecycle}/${field})`, async () => {
  clearTelegramDeliveryRuntime(); await assert.rejects(bridgeQuestionHarness(lifecycle, true, deps => {
    if (field === "policy") (deps as { questionHeadTail?: unknown }).questionHeadTail = false;
    if (field === "observer") (deps as { onQuestionAdmission?: unknown }).onQuestionAdmission = {};
    if (field === "capture") (deps as { captureQuestionAuthority?: unknown }).captureQuestionAuthority = 1;
  }), TypeError); assert.equal(captureTelegramQuestionLifetimeOwner(), undefined);
});

for (const lifecycle of [false, true])
test(`Private Bridge question policy preserves synchronous admission closure and observes rejected observer values (${lifecycle})`, async () => {
  clearTelegramDeliveryRuntime(); const h = await bridgeQuestionHarness(lifecycle); let captured: TelegramQuestionAdmission | undefined;
  try { const owner = captureTelegramQuestionLifetimeOwner(); assert.ok(owner); h.setAdmission(a => { owner.assertAdmission(a); captured = a; return Promise.reject(Error("observer")); });
    const opened = await openHeadTailQuestion(h.runtime(), "confirmation"); assert.ok(opened.ok); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.stats.admissions, 1); assert.ok(captured); assert.throws(() => owner.assertAdmission(captured), /unavailable/u);
  } finally { await h.stop(); }
});

for (const lifecycle of [false, true]) for (const receiver of [false, true])
test(`Private Bridge question policy does not substitute lifetime authority for Text receiver readiness (${lifecycle}/${receiver})`, async () => {
  clearTelegramDeliveryRuntime(); const h = await bridgeQuestionHarness(lifecycle, true, deps => { if (receiver) {
    deps.getTextInputReceiverBotId = () => 99; deps.captureInputPublication = destination => messageId => deps.recordOwnership({ chatId: destination.chatId, messageId, target: destination });
  } });
  try { const opened = await openHeadTailQuestion(h.runtime(), "text"); assert.equal(opened.ok, receiver); assert.equal(h.stats.admissions, receiver ? 1 : 0); assert.equal(h.stats.sends, receiver ? 1 : 0);
    assert.equal(h.stats.captures, 1); assert.ok(captureTelegramQuestionLifetimeOwner());
    if (opened.ok) { const source = h.runtime().captureTextInputSource!(target); assert.ok(source); h.state.session++; assert.throws(source.assertOriginalBinding, /transport generation/u); }
  } finally { await h.stop(); }
});

for (const enabled of [false, true])
test(`Private Bridge question lifecycle preserves ordinary spread receiver and getter ordering (${enabled})`, async () => {
  clearTelegramDeliveryRuntime(); let receiver: unknown, owned = 0;
  const h = await bridgeQuestionHarness(true, true, deps => { if (!enabled) delete deps.questionHeadTail; const api = deps.api;
    Object.defineProperty(deps, "api", { enumerable: true, configurable: true, get() { receiver = this; deps.recordOwnership = () => { owned++; }; return api; } });
  });
  try { assert.equal(receiver, h.deps, "Ordinary getters keep their original option receiver");
    assert.equal((await h.runtime().sendView({ text: "ordinary" }, { scope: { kind: "instance" } })).ok, true);
    assert.equal(owned, 1, "A prior getter's ordinary dependency update is read at the original spread position"); assert.equal(h.stats.ownership, 0);
  } finally { await h.stop(); }
});

for (const threaded of [false, true]) for (const change of ["rebind", "unbind", "replace", "clear", "shutdown", "registry-copy", "registry-accessor", "capture-accessor"] as const) for (const phase of ["before", "provider", "final-data"] as const)
test(`Native bound question certificate retains original binding (${change}/${phase}/Thread=${threaded})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 }); clearTelegramDeliveryRuntime();
  let trigger: (() => void) | undefined, getterCalls = 0;
  const h = confirmationHarness({ questionHeadTail: true, getInstanceTarget: () => threaded ? target : { chatId: 42 }, getConfirmationAuthority() {
    const cb = trigger; trigger = undefined; cb?.(); return { profile: "default", operatorId: 42 };
  } });
  const b = confirmationHarness({ questionHeadTail: true, getInstanceTarget: () => threaded ? target : { chatId: 42 } });
  const unbind = bindTelegramDeliveryRuntime(h.runtime), globals = globalThis as Record<string, unknown>, registry = globals.__piTelegramDeliveryRuntime__;
  const originalCapture = h.runtime.captureQuestionLifetimeOwner;
  try {
    const first = await openHeadTailQuestion(h.runtime, "confirmation"); assert.ok(first.ok); let originalEnded = false; void first.handle.result.then(() => { originalEnded = true; });
    const owner = captureTelegramQuestionLifetimeOwner(), peer = captureTelegramQuestionLifetimeOwner(); assert.ok(owner && peer);
    owner.assertScope(peer.scope); let barrier = 0, successorEnded = false;
    const changeBinding = () => {
      if (change === "rebind") bindTelegramDeliveryRuntime(h.runtime);
      if (change === "unbind") unbind();
      if (change === "replace") bindTelegramDeliveryRuntime(b.runtime);
      if (change === "clear") clearTelegramDeliveryRuntime();
      if (change === "shutdown") h.runtime.shutdown();
      if (change === "registry-copy") globals.__piTelegramDeliveryRuntime__ = { ...(registry as object) };
      if (change === "registry-accessor") Object.defineProperty(globalThis, "__piTelegramDeliveryRuntime__", { configurable: true, get() { getterCalls++; return registry; } });
      if (change === "capture-accessor") Object.defineProperty(h.runtime, "captureQuestionLifetimeOwner", { configurable: true, get() { getterCalls++; return originalCapture; } });
    };
    const apply = owner.captureTail({ scopes: [peer.scope], assertCurrent() { if (++barrier === 2 && phase === "final-data") changeBinding(); } });
    if (phase === "before") changeBinding(); if (phase === "provider") trigger = changeBinding;
    assert.throws(apply, /unavailable/u, "A late loss cannot cross the native final-use barrier");
    if (change === "replace") { const next = await openHeadTailQuestion(b.runtime, "confirmation"); assert.ok(next.ok); void next.handle.result.then(() => { successorEnded = true; }); }
    assert.equal(getterCalls, 0, "Binding data barriers must not invoke dependency accessors");
    Object.defineProperty(globalThis, "__piTelegramDeliveryRuntime__", { value: registry, writable: true, configurable: true }); Object.defineProperty(h.runtime, "captureQuestionLifetimeOwner", { value: originalCapture, writable: true, configurable: true, enumerable: true });
    assert.throws(owner.assertCurrent, /unavailable/u); assert.throws(() => owner.assertScope(peer.scope), /unavailable/u); assert.throws(apply, /unavailable/u);
    t.mock.timers.tick(3_600_000); await Promise.resolve();
    assert.equal(originalEnded, ["replace", "clear", "shutdown"].includes(change), "Refused shortening is not logical completion; shutdown is"); assert.equal(successorEnded, false);
  } finally { trigger = undefined; Object.defineProperty(globalThis, "__piTelegramDeliveryRuntime__", { value: registry, writable: true, configurable: true }); Object.defineProperty(h.runtime, "captureQuestionLifetimeOwner", { value: originalCapture, writable: true, configurable: true, enumerable: true }); h.runtime.shutdown(); b.runtime.shutdown(); clearTelegramDeliveryRuntime(); }
});

for (const threaded of [false, true])
test(`Native bound question certificate matches peers and admission without changing pure embedding (Thread=${threaded})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 }); clearTelegramDeliveryRuntime(); let owner: Readonly<TelegramQuestionLifetimeOwner> | undefined, admissions = 0;
  const h = confirmationHarness({ questionHeadTail: true, getInstanceTarget: () => threaded ? target : { chatId: 42 }, onQuestionAdmission(admission) {
    if (owner) { assert.equal(owner.assertAdmission(admission), 1000); const reader = Object.getPrototypeOf(admission).constructor as { read(value: object): { binding: object } };
      const binding = reader.read(admission).binding; assert.equal(Object.isFrozen(binding), true); assert.equal(Object.hasOwn(binding, "active"), false); }
    admissions++;
  } });
  try {
    assert.equal(captureTelegramQuestionLifetimeOwner(), undefined); const pure = h.runtime.captureQuestionLifetimeOwner!()!; assert.ok(pure);
    const oldUnbind = bindTelegramDeliveryRuntime(h.runtime); owner = captureTelegramQuestionLifetimeOwner(); const peer = captureTelegramQuestionLifetimeOwner(); assert.ok(owner && peer);
    assert.throws(() => owner!.assertScope(pure.scope), /unavailable/u); assert.throws(() => pure.assertScope(owner!.scope), /unavailable/u);
    assert.throws(() => owner!.captureTail({ scopes: [pure.scope], assertCurrent() {} }), /unavailable/u);
    const bound = captureTelegramQuestionLifetimeOwner()!; bound.assertScope(peer.scope);
    const first = await openHeadTailQuestion(h.runtime, "confirmation"); assert.ok(first.ok); let ended = false; void first.handle.result.then(() => { ended = true; });
    const apply = bound.captureTail({ scopes: [peer.scope], assertCurrent() {} }); apply(); t.mock.timers.tick(3_600_000); await Promise.resolve(); assert.equal(ended, true); assert.equal(admissions, 1);
    const latestUnbind = bindTelegramDeliveryRuntime(h.runtime); oldUnbind(); const current = captureTelegramQuestionLifetimeOwner(); assert.ok(current); current.assertCurrent();
    assert.throws(peer.assertCurrent, /unavailable/u); latestUnbind(); assert.equal(captureTelegramQuestionLifetimeOwner(), undefined); pure.assertCurrent();
  } finally { h.runtime.shutdown(); clearTelegramDeliveryRuntime(); }
});

test("Native bound question capture refuses fake binding tokens and original-capture reentry without acquiring a successor", () => {
  clearTelegramDeliveryRuntime(); let enter: (() => void) | undefined;
  const h = confirmationHarness({ questionHeadTail: true, getConfirmationAuthority() { const cb = enter; enter = undefined; cb?.(); return { profile: "default", operatorId: 42 }; } });
  try {
    bindTelegramDeliveryRuntime(h.runtime); const globals = globalThis as Record<string, unknown>, registry = globals.__piTelegramDeliveryRuntime__ as { binding: object };
    const token = registry.binding, constructor = Object.getPrototypeOf(token).constructor as { new(...args: unknown[]): object; read: (...args: unknown[]) => unknown }, reader = constructor.read;
    assert.throws(() => reader(token), /unavailable/u); assert.throws(() => reader(Symbol("native question runtime binding"), token), /unavailable/u);
    const bound = captureTelegramQuestionLifetimeOwner()!, scopeReader = Object.getPrototypeOf(bound.scope).constructor as { read(value: object): { binding: object } };
    assert.equal(scopeReader.read(bound.scope).binding, token); assert.equal(Object.isFrozen(token), true); assert.equal(Object.hasOwn(token, "active"), false);
    try { constructor.read = () => ({ active: true, runtime: h.runtime });
      for (const fake of [{}, { ...token }, Object.create(Object.getPrototypeOf(token)), new Proxy(token, {})]) assert.equal(h.runtime.captureQuestionLifetimeOwner!(fake), undefined);
      assert.throws(() => new constructor(Symbol("native question runtime binding"), registry, h.runtime), /unavailable/u);
      assert.ok(captureTelegramQuestionLifetimeOwner());
    } finally { constructor.read = reader; }
    enter = () => { bindTelegramDeliveryRuntime(h.runtime); }; assert.equal(captureTelegramQuestionLifetimeOwner(), undefined); assert.ok(captureTelegramQuestionLifetimeOwner());
    enter = () => { assert.equal(captureTelegramQuestionLifetimeOwner(), undefined); }; assert.equal(captureTelegramQuestionLifetimeOwner(), undefined);
  } finally { h.runtime.shutdown(); clearTelegramDeliveryRuntime(); }
});

test("Native bound question capture holds absent or legacy registries without probing a foreign callable", () => {
  clearTelegramDeliveryRuntime(); const globals = globalThis as Record<string, unknown>, registry = globals.__piTelegramDeliveryRuntime__; let calls = 0;
  try {
    delete globals.__piTelegramDeliveryRuntime__; assert.equal(captureTelegramQuestionLifetimeOwner(), undefined); assert.equal(Object.hasOwn(globals, "__piTelegramDeliveryRuntime__"), false);
    globals.__piTelegramDeliveryRuntime__ = { runtime: { captureQuestionLifetimeOwner() { calls++; throw Error("Foreign callable"); } }, binding: {} };
    assert.equal(captureTelegramQuestionLifetimeOwner(), undefined); assert.equal(calls, 0);
    const h = confirmationHarness({ questionHeadTail: true });
    try { globals.__piTelegramDeliveryRuntime__ = { runtime: h.runtime, binding: {} }; bindTelegramDeliveryRuntime(h.runtime);
      assert.equal(captureTelegramQuestionLifetimeOwner(), undefined, "Legacy global shapes cannot manufacture native binding provenance"); assert.ok(h.runtime.captureQuestionLifetimeOwner!());
    } finally { h.runtime.shutdown(); }
  } finally { globals.__piTelegramDeliveryRuntime__ = registry; clearTelegramDeliveryRuntime(); }
});

for (const point of ["before-reader", "inside-provider"] as const)
test(`Native bound question admission cannot borrow a replacement same-runtime binding (${point})`, async () => {
  clearTelegramDeliveryRuntime(); let owner: Readonly<TelegramQuestionLifetimeOwner>, tested = false, trigger: (() => void) | undefined;
  const h = confirmationHarness({ questionHeadTail: true, getConfirmationAuthority() { const cb = trigger; trigger = undefined; cb?.(); return { profile: "default", operatorId: 42 }; }, onQuestionAdmission(admission) {
    if (point === "before-reader") { bindTelegramDeliveryRuntime(h.runtime); const current = captureTelegramQuestionLifetimeOwner()!;
      assert.throws(() => current.assertAdmission(admission), /unavailable/u); assert.throws(() => owner.assertAdmission(admission), /unavailable/u);
    } else { trigger = () => { bindTelegramDeliveryRuntime(h.runtime); }; assert.throws(() => owner.assertAdmission(admission), /unavailable/u); }
    tested = true;
  } });
  try { bindTelegramDeliveryRuntime(h.runtime); owner = captureTelegramQuestionLifetimeOwner()!; assert.ok(owner);
    const opened = await openHeadTailQuestion(h.runtime, "confirmation"); assert.ok(opened.ok); assert.equal(tested, true); assert.throws(owner.assertCurrent, /unavailable/u);
  } finally { h.runtime.shutdown(); clearTelegramDeliveryRuntime(); }
});

for (const threaded of [false, true])
test(`Native lifetime scope matches same-runtime aliases without creating a SDK question (Thread=${threaded})`, () => {
  let admissions = 0;
  const { runtime, events } = confirmationHarness({ questionHeadTail: true, getInstanceTarget: () => threaded ? target : { chatId: 42 }, onQuestionAdmission: () => { admissions++; } });
  try {
    const a = runtime.captureQuestionLifetimeOwner!()!, b = runtime.captureQuestionLifetimeOwner!()!; assert.ok(a && b);
    assert.ok(Object.isFrozen(a.scope)); assert.notEqual(a.scope, b.scope);
    a.assertScope(b.scope); b.assertScope(a.scope); ({ ...a }).assertScope(({ ...b }).scope); a.assertScope(a.scope);
    assert.throws(() => a.assertAdmission(b.scope), /unavailable/u); assert.equal(admissions, 0); assert.equal(events.length, 0);
  } finally { runtime.shutdown(); }
});

test("Native lifetime scope refuses distinct live runtimes even with identical captured fields", () => {
  const a = confirmationHarness({ questionHeadTail: true }), b = confirmationHarness({ questionHeadTail: true });
  try {
    const original = a.runtime.captureQuestionLifetimeOwner!()!, foreign = b.runtime.captureQuestionLifetimeOwner!()!;
    assert.throws(() => original.assertScope(foreign.scope), /unavailable/u); assert.throws(() => foreign.assertScope(original.scope), /unavailable/u);
    original.assertCurrent(); foreign.assertCurrent(); original.assertScope(original.scope);
  } finally { a.runtime.shutdown(); b.runtime.shutdown(); }
});

test("Native lifetime scope rejects copies, proxies, prototypes, constructor and static-reader substitution", () => {
  let reads = 0;
  const { runtime } = confirmationHarness({ questionHeadTail: true, getConfirmationAuthority: () => { reads++; return { profile: "default", operatorId: 42 }; } });
  try {
    const a = runtime.captureQuestionLifetimeOwner!()!, b = runtime.captureQuestionLifetimeOwner!()!;
    const before = reads, constructor = Object.getPrototypeOf(b.scope).constructor as { new(...args: unknown[]): object; read: (...args: unknown[]) => unknown };
    for (const fake of [{ ...b.scope }, Object.create(Object.getPrototypeOf(b.scope)), new Proxy(b.scope, {}), { target }])
      assert.throws(() => a.assertScope(fake), /unavailable/u);
    assert.equal(reads, before); assert.throws(() => new constructor(Symbol("native question lifetime scope"), {}), /unavailable/u);
    const saved = constructor.read;
    try { constructor.read = () => ({ runtime: {}, profile: "default", operatorId: 42, target, assertAvailable() {} });
      assert.throws(() => a.assertScope({}), /unavailable/u); assert.doesNotThrow(() => a.assertScope(b.scope));
    } finally { constructor.read = saved; }
  } finally { runtime.shutdown(); }
});

for (const loss of ["profile", "operator", "target", "generation", "authority-port", "target-port", "authorization-port", "authorization"] as const)
test(`Native lifetime scope matching cannot revive a peer's observed original loss (${loss})`, () => {
  let profile = "default", operatorId = 42, authorized = true, receiver = { ...target };
  const { runtime, deps } = confirmationHarness({ questionHeadTail: true, getConfirmationAuthority: () => ({ profile, operatorId }),
    getInstanceTarget: () => receiver, isExplicitTargetAuthorized: () => authorized });
  const original = { generation: deps.generation, getConfirmationAuthority: deps.getConfirmationAuthority, getInstanceTarget: deps.getInstanceTarget,
    isExplicitTargetAuthorized: deps.isExplicitTargetAuthorized };
  try {
    const peer = runtime.captureQuestionLifetimeOwner!()!;
    if (loss === "profile") profile = "other"; if (loss === "operator") operatorId = 43; if (loss === "target") receiver = { ...target, threadId: 8 };
    if (loss === "generation") deps.generation = "new"; if (loss === "authority-port") deps.getConfirmationAuthority = () => ({ profile, operatorId });
    if (loss === "target-port") deps.getInstanceTarget = () => receiver; if (loss === "authorization-port") deps.isExplicitTargetAuthorized = () => true;
    if (loss === "authorization") authorized = false;
    assert.throws(peer.assertCurrent, /unavailable/u);
    profile = "default"; operatorId = 42; receiver = { ...target }; authorized = true; Object.assign(deps, original);
    const head = runtime.captureQuestionLifetimeOwner!()!; assert.ok(head);
    assert.throws(() => head.assertScope(peer.scope), /unavailable/u); head.assertScope(head.scope);
  } finally { runtime.shutdown(); }
});

test("Native lifetime scope can read matching peer history while its independent SDK guard is active", () => {
  let onRead: (() => void) | undefined;
  const { runtime } = confirmationHarness({ questionHeadTail: true, getConfirmationAuthority() {
    const callback = onRead; onRead = undefined; callback?.(); return { profile: "default", operatorId: 42 };
  } });
  try {
    const peer = runtime.captureQuestionLifetimeOwner!()!, head = runtime.captureQuestionLifetimeOwner!()!;
    onRead = () => head.assertScope(peer.scope); assert.doesNotThrow(peer.assertCurrent); head.assertCurrent(); peer.assertScope(head.scope);
  } finally { runtime.shutdown(); }
});

test("Native lifetime scope refuses caught invalid-token reentry into its own active SDK guard", () => {
  let onRead: (() => void) | undefined;
  const { runtime } = confirmationHarness({ questionHeadTail: true, getConfirmationAuthority() {
    const callback = onRead; onRead = undefined; callback?.(); return { profile: "default", operatorId: 42 };
  } });
  try {
    const owner = runtime.captureQuestionLifetimeOwner!()!;
    onRead = () => { assert.throws(() => owner.assertScope({}), /unavailable/u); };
    assert.throws(owner.assertCurrent, /unavailable/u); assert.throws(owner.assertCurrent, /unavailable/u);
  } finally { runtime.shutdown(); }
});

test("Native lifetime scope rechecks peer history after the final current-scope callback", () => {
  let remaining = 0, profile = "default", onRead: (() => void) | undefined;
  const { runtime } = confirmationHarness({ questionHeadTail: true, getConfirmationAuthority() {
    if (remaining > 0 && --remaining === 0) { const callback = onRead; onRead = undefined; callback?.(); }
    return { profile, operatorId: 42 };
  } });
  try {
    const peer = runtime.captureQuestionLifetimeOwner!()!, head = runtime.captureQuestionLifetimeOwner!()!;
    remaining = 4; onRead = () => { profile = "other"; assert.throws(peer.assertCurrent, /unavailable/u); profile = "default"; };
    assert.throws(() => head.assertScope(peer.scope), /unavailable/u); head.assertCurrent();
  } finally { runtime.shutdown(); }
});

for (const copied of [false, true])
test(`Native lifetime scope caught matching reentry poisons that owner without poisoning its peer (copy=${copied})`, () => {
  let onRead: (() => void) | undefined;
  const { runtime } = confirmationHarness({ questionHeadTail: true, getConfirmationAuthority() {
    const callback = onRead; onRead = undefined; callback?.(); return { profile: "default", operatorId: 42 };
  } });
  try {
    const peer = runtime.captureQuestionLifetimeOwner!()!, head = runtime.captureQuestionLifetimeOwner!()!;
    onRead = () => { assert.throws(() => head.assertScope(copied ? { ...peer.scope } : peer.scope), /unavailable/u); };
    assert.throws(() => head.assertScope(peer.scope), /unavailable/u); assert.throws(head.assertCurrent, /unavailable/u);
    peer.assertCurrent(); assert.throws(() => peer.assertScope(head.scope), /unavailable/u);
  } finally { runtime.shutdown(); }
});

for (const changed of ["profile", "operator", "target"] as const)
test(`Native lifetime scope rejects different historical tuples without spending the current owner (${changed})`, () => {
  let profile = "default", operatorId = 42, receiver = { ...target };
  const { runtime } = confirmationHarness({ questionHeadTail: true, getConfirmationAuthority: () => ({ profile, operatorId }), getInstanceTarget: () => receiver });
  try {
    const a = runtime.captureQuestionLifetimeOwner!()!;
    if (changed === "profile") profile = "other"; if (changed === "operator") operatorId = 43; if (changed === "target") receiver = { ...target, threadId: 8 };
    const b = runtime.captureQuestionLifetimeOwner!()!; assert.ok(b); profile = "default"; operatorId = 42; receiver = { ...target };
    assert.throws(() => a.assertScope(b.scope), /unavailable/u); a.assertCurrent(); a.assertScope(a.scope);
  } finally { runtime.shutdown(); }
});

function questionAdmissionHarness(handler: (admission: Readonly<TelegramQuestionAdmission>) => void,
  overrides: Partial<TelegramDeliveryRuntimeDeps> = {}) {
  let failure: unknown, calls = 0;
  const harness = confirmationHarness({ questionHeadTail: true, ...overrides, onQuestionAdmission(admission) {
    calls++; try { handler(admission); } catch (error) { failure = error; }
  } });
  return { ...harness, check(expected = 1) { assert.equal(failure, undefined, "Observer assertions must not be swallowed by the native fail-held boundary"); assert.equal(calls, expected); } };
}


for (const kind of ["confirmation", "choice", "text"] as const) for (const threaded of [false, true])
for (const terminal of ["live", "abort", "deadline"] as const)
test(`Finite SDK admission event retains the original clock without renewing its question (${kind}/${threaded}/${terminal})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const controller = new AbortController(), destination = threaded ? target : { chatId: 42 };
  let owner: Readonly<TelegramQuestionLifetimeOwner>, retained: unknown;
  const h = questionAdmissionHarness(admission => {
    retained = admission;
    if (terminal === "abort") controller.abort();
    t.mock.timers.setTime(terminal === "deadline" ? 1100 : 1010);
    if (terminal === "live") assert.equal(owner.assertAdmission(admission), 1000);
    else assert.throws(() => owner.assertAdmission(admission), /unavailable/u);
    assert.equal(owner.assertAdmissionEvent!(admission), 1000);
    assert.equal(owner.assertAdmissionEvent!(admission), 1000);
    if (terminal !== "live") assert.throws(() => owner.assertAdmission(admission), /unavailable/u);
  }, { getInstanceTarget: () => destination });
  try {
    owner = h.runtime.captureQuestionLifetimeOwner!()!; assert.ok(owner.assertAdmissionEvent);
    const opened = await openHeadTailQuestion(h.runtime, kind, controller.signal, 100); h.check();
    assert.equal(opened.ok, terminal === "live");
    assert.throws(() => owner.assertAdmissionEvent!(retained), /unavailable/u); owner.assertCurrent();
    if (opened.ok) {
      let ended = false; void opened.handle.result.then(() => { ended = true; }); await Promise.resolve();
      assert.equal(ended, false); t.mock.timers.tick(100); assert.equal((await opened.handle.result).status, "expired");
    }
  } finally { h.runtime.shutdown(); }
});

test("Finite SDK admission event authenticates native identity without probing copies or proxies", async () => {
  let owner: Readonly<TelegramQuestionLifetimeOwner>, reads = 0;
  const h = questionAdmissionHarness(admission => {
    const proxy = new Proxy(admission, { get() { reads++; throw Error("getter"); } });
    for (const fake of [{ ...admission }, Object.create(Object.getPrototypeOf(admission)), proxy, {}])
      assert.throws(() => owner.assertAdmissionEvent!(fake), /unavailable/u);
    const constructor = Object.getPrototypeOf(admission).constructor as { read(value: object): unknown };
    const read = constructor.read, facts = read(admission);
    try {
      constructor.read = () => facts;
      assert.throws(() => owner.assertAdmissionEvent!(Object.create(Object.getPrototypeOf(admission))), /unavailable/u);
    } finally { constructor.read = read; }
    assert.equal(reads, 0); owner.assertCurrent();
    assert.equal(owner.assertAdmissionEvent!(admission), admission.at);
  });
  try { owner = h.runtime.captureQuestionLifetimeOwner!()!; assert.ok((await openHeadTailQuestion(h.runtime, "confirmation")).ok); h.check(); }
  finally { h.runtime.shutdown(); }
});

test("Finite SDK admission event refuses a genuine foreign runtime without spending the original owner", async () => {
  const a = confirmationHarness({ questionHeadTail: true }), owner = a.runtime.captureQuestionLifetimeOwner!()!;
  let peer: Readonly<TelegramQuestionLifetimeOwner>;
  const b = questionAdmissionHarness(admission => {
    assert.throws(() => owner.assertAdmissionEvent!(admission), /unavailable/u); owner.assertCurrent();
    assert.equal(peer.assertAdmissionEvent!(admission), admission.at);
  });
  try { peer = b.runtime.captureQuestionLifetimeOwner!()!; assert.ok((await openHeadTailQuestion(b.runtime, "choice")).ok); b.check(); }
  finally { a.runtime.shutdown(); b.runtime.shutdown(); }
});

for (const loss of ["profile", "operator", "generation", "authority-port", "authorization-port", "receiver-port", "shutdown"] as const)
test(`Finite SDK admission event keeps original authority loss sticky (${loss})`, async () => {
  let profile = "default", operatorId = 42, owner: Readonly<TelegramQuestionLifetimeOwner>;
  const h = questionAdmissionHarness(admission => {
    const original = { generation: h.deps.generation, getConfirmationAuthority: h.deps.getConfirmationAuthority,
      isExplicitTargetAuthorized: h.deps.isExplicitTargetAuthorized, getInstanceTarget: h.deps.getInstanceTarget };
    if (loss === "profile") profile = "other"; if (loss === "operator") operatorId = 43;
    if (loss === "generation") h.deps.generation = "other";
    if (loss === "authority-port") h.deps.getConfirmationAuthority = () => ({ profile, operatorId });
    if (loss === "authorization-port") h.deps.isExplicitTargetAuthorized = () => true;
    if (loss === "receiver-port") h.deps.getInstanceTarget = () => target;
    if (loss === "shutdown") h.runtime.shutdown();
    assert.throws(() => owner.assertAdmissionEvent!(admission), /unavailable/u);
    profile = "default"; operatorId = 42; Object.assign(h.deps, original);
    assert.throws(() => owner.assertAdmissionEvent!(admission), /unavailable/u);
    assert.throws(owner.assertCurrent, /unavailable/u);
  }, { getConfirmationAuthority: () => ({ profile, operatorId }) });
  try { owner = h.runtime.captureQuestionLifetimeOwner!()!; await openHeadTailQuestion(h.runtime, "confirmation"); h.check(); }
  finally { h.runtime.shutdown(); }
});

for (const finite of [false, true])
test(`Finite SDK admission event preserves shared native guard reentry loss (finite=${finite})`, async () => {
  let remaining = 0, reenter: (() => void) | undefined;
  let a: Readonly<TelegramQuestionLifetimeOwner>, b: Readonly<TelegramQuestionLifetimeOwner>;
  const h = questionAdmissionHarness(admission => {
    reenter = () => { assert.throws(() => finite ? b.assertAdmissionEvent!(admission) : b.assertAdmission(admission), /unavailable/u); };
    remaining = 3;
    assert.throws(() => a.assertAdmissionEvent!(admission), /unavailable/u);
    a.assertCurrent(); b.assertCurrent();
    assert.throws(() => b.assertAdmissionEvent!(admission), /unavailable/u);
  }, { getConfirmationAuthority() {
    if (remaining > 0 && --remaining === 0) { const cb = reenter; reenter = undefined; cb?.(); }
    return { profile: "default", operatorId: 42 };
  } });
  try { a = h.runtime.captureQuestionLifetimeOwner!()!; b = h.runtime.captureQuestionLifetimeOwner!()!;
    assert.ok((await openHeadTailQuestion(h.runtime, "confirmation")).ok); h.check(); }
  finally { h.runtime.shutdown(); }
});

for (const finite of [false, true])
test(`Finite SDK admission event rejects shared authority loss observed by either guard (finite=${finite})`, async () => {
  let remaining = 0, profile = "default", a: Readonly<TelegramQuestionLifetimeOwner>, b: Readonly<TelegramQuestionLifetimeOwner>;
  const h = questionAdmissionHarness(admission => {
    remaining = 3; assert.throws(() => finite ? a.assertAdmissionEvent!(admission) : a.assertAdmission(admission), /unavailable/u);
    profile = "default"; a.assertCurrent(); b.assertCurrent();
    assert.throws(() => b.assertAdmissionEvent!(admission), /unavailable/u);
    assert.throws(() => b.assertAdmission(admission), /unavailable/u);
  }, { getConfirmationAuthority() {
    if (remaining > 0 && --remaining === 0) profile = "other";
    return { profile, operatorId: 42 };
  } });
  try { a = h.runtime.captureQuestionLifetimeOwner!()!; b = h.runtime.captureQuestionLifetimeOwner!()!;
    assert.ok((await openHeadTailQuestion(h.runtime, "confirmation")).ok); h.check(); }
  finally { h.runtime.shutdown(); }
});

for (const kind of ["confirmation", "text"] as const)
test(`Finite SDK admission event closes before pending actual native publication drain (${kind})`, async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<number>(); let retained: unknown;
  const h = questionAdmissionHarness(admission => { retained = admission; }, { sendChunk: async () => { entered.resolve(); return release.promise; } });
  const owner = h.runtime.captureQuestionLifetimeOwner!()!;
  try {
    const opening = openHeadTailQuestion(h.runtime, kind); await entered.promise; h.check();
    assert.throws(() => owner.assertAdmissionEvent!(retained), /unavailable/u); owner.assertCurrent();
    h.runtime.shutdown(); assert.equal(h.runtime.hasPendingTarget!(target), true);
    release.resolve(501); await opening; await flushConfirmationEffects(); assert.equal(h.runtime.hasPendingTarget!(target), false);
  } finally { release.resolve(501); h.runtime.shutdown(); }
});

test("Finite SDK admission event checks native binding flags after the final SDK provider callback", async () => {
  clearTelegramDeliveryRuntime(); let reads = 0, trigger = 0, owner: Readonly<TelegramQuestionLifetimeOwner>;
  const h = questionAdmissionHarness(admission => {
    reads = 0; trigger = 5;
    assert.throws(() => owner.assertAdmissionEvent!(admission), /unavailable/u);
    assert.throws(() => owner.assertAdmissionEvent!(admission), /unavailable/u);
  }, { getConfirmationAuthority() {
    if (trigger && ++reads === trigger) clearTelegramDeliveryRuntime();
    return { profile: "default", operatorId: 42 };
  } });
  try {
    bindTelegramDeliveryRuntime(h.runtime); owner = captureTelegramQuestionLifetimeOwner()!; assert.ok(owner);
    await openHeadTailQuestion(h.runtime, "confirmation"); h.check();
  } finally { clearTelegramDeliveryRuntime(); h.runtime.shutdown(); }
});

test("Finite SDK admission event rechecks shared data-only event history after the final SDK callback", async () => {
  let reads = 0, trigger = 0, profile = "default", invalidate: (() => void) | undefined;
  let owner: Readonly<TelegramQuestionLifetimeOwner>;
  const h = questionAdmissionHarness(admission => {
    const reader = Object.getPrototypeOf(admission).constructor as { read(value: object): { assertCurrent(): void } };
    const native = reader.read(admission);
    invalidate = () => { profile = "other"; assert.throws(native.assertCurrent, /unavailable/u); profile = "default"; };
    reads = 0; trigger = 5;
    assert.throws(() => owner.assertAdmissionEvent!(admission), /unavailable/u); owner.assertCurrent();
    assert.throws(() => owner.assertAdmissionEvent!(admission), /unavailable/u);
  }, { getConfirmationAuthority() {
    if (trigger && ++reads === trigger) { trigger = 0; invalidate!(); }
    return { profile, operatorId: 42 };
  } });
  try { owner = h.runtime.captureQuestionLifetimeOwner!()!;
    await openHeadTailQuestion(h.runtime, "confirmation"); h.check(); }
  finally { h.runtime.shutdown(); }
});


test("Finite SDK admission event rejects a different native target without poisoning the original owner", async () => {
  let owner: Readonly<TelegramQuestionLifetimeOwner>;
  const h = questionAdmissionHarness(admission => {
    assert.throws(() => owner.assertAdmissionEvent!(admission), /unavailable/u); owner.assertCurrent();
  });
  try { owner = h.runtime.captureQuestionLifetimeOwner!()!;
    assert.ok((await openHeadTailQuestion(h.runtime, "choice", undefined, undefined,
      { kind: "target", target: { ...target, threadId: 8 } })).ok); h.check(); }
  finally { h.runtime.shutdown(); }
});

for (const changed of ["profile", "operator"] as const)
test(`Finite SDK admission event refuses changed birth tuples after cancellation (${changed})`, async () => {
  const abort = new AbortController(); let profile = "default", operatorId = 42, owner: Readonly<TelegramQuestionLifetimeOwner>;
  const h = questionAdmissionHarness(admission => {
    abort.abort(); assert.throws(() => owner.assertAdmissionEvent!(admission), /unavailable/u);
    profile = "default"; operatorId = 42; assert.throws(owner.assertCurrent, /unavailable/u);
    assert.throws(() => owner.assertAdmissionEvent!(admission), /unavailable/u);
  }, { getConfirmationAuthority: () => ({ profile, operatorId }) });
  try {
    owner = h.runtime.captureQuestionLifetimeOwner!()!;
    if (changed === "profile") profile = "other"; else operatorId = 43;
    await openHeadTailQuestion(h.runtime, "confirmation", abort.signal); h.check();
  } finally { h.runtime.shutdown(); }
});

test("Finite SDK admission event refuses an invalid original demotion clock", async t => {
  const timers = t.mock.method(globalThis, "setTimeout");
  const clock = Date.now; let injected = false, owner: Readonly<TelegramQuestionLifetimeOwner>;
  const h = questionAdmissionHarness(admission => {
    Date.now = clock; assert.equal(Number.isNaN(admission.at), true);
    assert.throws(() => owner.assertAdmissionEvent!(admission), /unavailable/u); owner.assertCurrent();
  });
  try {
    owner = h.runtime.captureQuestionLifetimeOwner!()!;
    // Fault only the first clock read after expiry is armed, not birth or timer delay.
    Date.now = () => {
      if (!injected && timers.mock.callCount() > 0) { injected = true; return NaN; }
      return clock();
    };
    const opened = await openHeadTailQuestion(h.runtime, "confirmation"); h.check();
    assert.equal(opened.ok, true); assert.equal(injected, true);
    assert.equal(timers.mock.callCount(), 1);
    assert.ok(Number.isFinite(timers.mock.calls[0]!.arguments[1]), "The demotion fault must not poison the scheduled question deadline"); }
  finally { Date.now = clock; h.runtime.shutdown(); }
});


for (const threaded of [false, true])
test(`Native SDK event match keeps SDK callbacks before native authority and trusted data (${threaded})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const destination = threaded ? target : { chatId: 42 }, trace: string[] = [];
  const abort = new AbortController(); let owner: Readonly<TelegramQuestionLifetimeOwner>, retained: unknown;
  const h = questionAdmissionHarness(admission => {
    retained = admission; abort.abort(); trace.length = 0;
    assert.throws(() => owner.assertAdmission(admission), /unavailable/u);
    assert.equal(owner.matchAdmissionEvent!(admission, {
      assertAuthority() { trace.push("app"); }, assertCurrent() { trace.push("data"); },
    }), 1000);
    assert.deepEqual(trace.slice(-2), ["app", "data"]); assert.ok(trace.indexOf("app") > trace.lastIndexOf("sdk"));
    assert.equal(owner.assertAdmissionEvent!(admission), 1000);
  }, { getInstanceTarget: () => destination, getConfirmationAuthority() { trace.push("sdk"); return { profile: "default", operatorId: 42 }; } });
  try { owner = h.runtime.captureQuestionLifetimeOwner!()!;
    await openHeadTailQuestion(h.runtime, "confirmation", abort.signal); h.check();
    assert.throws(() => owner.matchAdmissionEvent!(retained), /unavailable/u); owner.assertCurrent(); }
  finally { h.runtime.shutdown(); }
});

for (const kind of ["copy", "proxy", "target"] as const)
test(`Native SDK event match returns a definitive non-match without probing guards (${kind})`, async () => {
  let owner: Readonly<TelegramQuestionLifetimeOwner>, gets = 0, callbacks = 0, sdkReads = 0;
  const h = questionAdmissionHarness(admission => {
    const value = kind === "copy" ? { ...admission } : kind === "proxy" ? new Proxy(admission, { get() { gets++; throw Error("proxy getter"); } }) : admission;
    const finalUse = { get assertCurrent(): () => void { callbacks++; throw Error("No guard getter on non-match"); } };
    sdkReads = 0; assert.equal(owner.matchAdmissionEvent!(value, finalUse), undefined); assert.equal(sdkReads, 0);
    assert.equal(gets, 0); assert.equal(callbacks, 0); owner.assertCurrent();
    assert.throws(() => owner.assertAdmissionEvent!(value), /unavailable/u);
  }, { getConfirmationAuthority() { sdkReads++; return { profile: "default", operatorId: 42 }; } });
  try { owner = h.runtime.captureQuestionLifetimeOwner!()!;
    await openHeadTailQuestion(h.runtime, "confirmation", undefined, undefined,
      kind === "target" ? { kind: "target", target: { ...target, threadId: 8 } } : { kind: "instance" }); h.check(); }
  finally { h.runtime.shutdown(); }
});

test("Native SDK event match excludes a genuine foreign runtime without SDK or cohort callbacks", async () => {
  let callbacks = 0, reads = 0;
  const a = confirmationHarness({ questionHeadTail: true, getConfirmationAuthority() { reads++; return { profile: "default", operatorId: 42 }; } });
  const owner = a.runtime.captureQuestionLifetimeOwner!()!;
  const b = questionAdmissionHarness(admission => {
    reads = 0;
    assert.equal(owner.matchAdmissionEvent!(admission, { assertAuthority() { callbacks++; }, assertCurrent() { callbacks++; } }), undefined);
    assert.equal(reads, 0); assert.equal(callbacks, 0); owner.assertCurrent();
  });
  try { await openHeadTailQuestion(b.runtime, "confirmation"); b.check(); }
  finally { a.runtime.shutdown(); b.runtime.shutdown(); }
});

test("Native SDK event match cannot renew a different native binding", async () => {
  clearTelegramDeliveryRuntime(); let owner: Readonly<TelegramQuestionLifetimeOwner>, callbacks = 0;
  const h = questionAdmissionHarness(admission => {
    assert.equal(owner.matchAdmissionEvent!(admission, { assertCurrent() { callbacks++; } }), undefined);
    assert.equal(callbacks, 0); assert.throws(owner.assertObservedCurrent!, /unavailable/u);
  });
  try { bindTelegramDeliveryRuntime(h.runtime); owner = captureTelegramQuestionLifetimeOwner()!;
    bindTelegramDeliveryRuntime(h.runtime); await openHeadTailQuestion(h.runtime, "confirmation"); h.check(); }
  finally { clearTelegramDeliveryRuntime(); h.runtime.shutdown(); }
});

test("Native SDK event match does not turn observed matching-event loss into a non-match", async () => {
  let owner: Readonly<TelegramQuestionLifetimeOwner>, peer: Readonly<TelegramQuestionLifetimeOwner>, profile = "default", reads = 0, trigger = 0;
  const h = questionAdmissionHarness(admission => {
    trigger = 3; reads = 0; assert.throws(() => owner.assertAdmissionEvent!(admission), /unavailable/u);
    profile = "default"; owner.assertCurrent(); peer.assertCurrent();
    assert.throws(() => peer.matchAdmissionEvent!(admission), /unavailable/u);
  }, { getConfirmationAuthority() { if (trigger && ++reads === trigger) { trigger = 0; profile = "other"; } return { profile, operatorId: 42 }; } });
  try { owner = h.runtime.captureQuestionLifetimeOwner!()!; peer = h.runtime.captureQuestionLifetimeOwner!()!;
    await openHeadTailQuestion(h.runtime, "confirmation"); h.check(); }
  finally { h.runtime.shutdown(); }
});

for (const phase of ["authority", "data"] as const) for (const result of ["promise", "number"] as const)
test(`Native SDK event match refuses non-void or asynchronous guards (${phase}/${result})`, async () => {
  let owner: Readonly<TelegramQuestionLifetimeOwner>, reached = false;
  const h = questionAdmissionHarness(admission => {
    const guard = () => { reached = true; return result === "promise" ? Promise.reject(Error("guard")) : 1; };
    assert.throws(() => owner.matchAdmissionEvent!(admission, {
      ...(phase === "authority" ? { assertAuthority: guard } : {}), assertCurrent: phase === "data" ? guard : () => {},
    }), /unavailable/u); assert.equal(reached, true);
  });
  try { owner = h.runtime.captureQuestionLifetimeOwner!()!;
    await openHeadTailQuestion(h.runtime, "confirmation"); h.check(); await flushConfirmationEffects(); }
  finally { h.runtime.shutdown(); }
});

test("Native SDK event match snapshots native authority/data functions before SDK callbacks", async () => {
  let owner: Readonly<TelegramQuestionLifetimeOwner>, onRead: (() => void) | undefined, replacements = 0;
  const h = questionAdmissionHarness(admission => {
    const trace: string[] = [], guards = { assertAuthority: () => { trace.push("app"); }, assertCurrent: () => { trace.push("data"); } };
    onRead = () => { guards.assertAuthority = () => { replacements++; }; guards.assertCurrent = () => { replacements++; }; };
    assert.equal(owner.matchAdmissionEvent!(admission, guards), admission.at);
    assert.deepEqual(trace, ["app", "data"]); assert.equal(replacements, 0);
  }, { getConfirmationAuthority() { const read = onRead; onRead = undefined; read?.(); return { profile: "default", operatorId: 42 }; } });
  try { owner = h.runtime.captureQuestionLifetimeOwner!()!; await openHeadTailQuestion(h.runtime, "confirmation"); h.check(); }
  finally { h.runtime.shutdown(); }
});

for (const phase of ["authority", "data"] as const)
test(`Native SDK event match keeps caught SDK reentry sticky in the original owner (${phase})`, async () => {
  let owner: Readonly<TelegramQuestionLifetimeOwner>;
  const h = questionAdmissionHarness(admission => {
    const reenter = () => { assert.throws(() => owner.matchAdmissionEvent!(admission), /unavailable/u); };
    assert.throws(() => owner.matchAdmissionEvent!(admission, {
      ...(phase === "authority" ? { assertAuthority: reenter } : {}), assertCurrent: phase === "data" ? reenter : () => {},
    }), /unavailable/u); assert.throws(owner.assertCurrent, /unavailable/u);
  });
  try { owner = h.runtime.captureQuestionLifetimeOwner!()!;
    await openHeadTailQuestion(h.runtime, "confirmation"); h.check(); }
  finally { h.runtime.shutdown(); }
});

test("Native SDK event match refuses native binding loss before the source data guard", async () => {
  clearTelegramDeliveryRuntime(); let owner: Readonly<TelegramQuestionLifetimeOwner>, data = 0;
  const h = questionAdmissionHarness(admission => {
    assert.throws(() => owner.matchAdmissionEvent!(admission, { assertAuthority: clearTelegramDeliveryRuntime, assertCurrent() { data++; } }), /unavailable/u);
    assert.equal(data, 0);
  });
  try { bindTelegramDeliveryRuntime(h.runtime); owner = captureTelegramQuestionLifetimeOwner()!;
    await openHeadTailQuestion(h.runtime, "confirmation"); h.check(); }
  finally { clearTelegramDeliveryRuntime(); h.runtime.shutdown(); }
});

test("Native SDK event match closes native shared-history loss after authority without provider rereads", async () => {
  let profile = "default", owner: Readonly<TelegramQuestionLifetimeOwner>, data = 0;
  const h = questionAdmissionHarness(admission => {
    const reader = Object.getPrototypeOf(admission).constructor as { read(value: object): { assertCurrent(): void } }, native = reader.read(admission);
    assert.throws(() => owner.matchAdmissionEvent!(admission, { assertAuthority() {
      profile = "other"; assert.throws(native.assertCurrent, /unavailable/u); profile = "default";
    }, assertCurrent() { data++; } }), /unavailable/u);
    assert.equal(data, 0); owner.assertCurrent();
    assert.throws(() => owner.matchAdmissionEvent!(admission), /unavailable/u);
  }, { getConfirmationAuthority: () => ({ profile, operatorId: 42 }) });
  try { owner = h.runtime.captureQuestionLifetimeOwner!()!;
    await openHeadTailQuestion(h.runtime, "confirmation"); h.check(); }
  finally { h.runtime.shutdown(); }
});

test("Native SDK event match keeps source failure distinct from SDK event authority", async () => {
  let owner: Readonly<TelegramQuestionLifetimeOwner>;
  const h = questionAdmissionHarness(admission => {
    assert.throws(() => owner.matchAdmissionEvent!(admission, { assertAuthority() {}, assertCurrent() { throw Error("Original source lost"); } }), /Original source lost/u);
    owner.assertCurrent(); assert.equal(owner.assertAdmissionEvent!(admission), admission.at);
  });
  try { owner = h.runtime.captureQuestionLifetimeOwner!()!; await openHeadTailQuestion(h.runtime, "confirmation"); h.check(); }
  finally { h.runtime.shutdown(); }
});

for (const bad of [null, {}, { assertCurrent: 1 }, { assertCurrent() {}, assertAuthority: 1 }])
test(`Native SDK event match refuses malformed matched final-use guards (${JSON.stringify(bad)})`, async () => {
  let owner: Readonly<TelegramQuestionLifetimeOwner>;
  const h = questionAdmissionHarness(admission => {
    assert.throws(() => owner.matchAdmissionEvent!(admission, bad as never), /unavailable/u);
    owner.assertCurrent(); assert.equal(owner.assertAdmissionEvent!(admission), admission.at);
  });
  try { owner = h.runtime.captureQuestionLifetimeOwner!()!; await openHeadTailQuestion(h.runtime, "confirmation"); h.check(); }
  finally { h.runtime.shutdown(); }
});


test("Native SDK event match rejects late native binding loss after the final source data guard", async () => {
  clearTelegramDeliveryRuntime(); let owner: Readonly<TelegramQuestionLifetimeOwner>, data = 0;
  const h = questionAdmissionHarness(admission => {
    assert.throws(() => owner.matchAdmissionEvent!(admission, { assertAuthority() {}, assertCurrent() { data++; clearTelegramDeliveryRuntime(); } }), /unavailable/u);
    assert.equal(data, 1);
  });
  try { bindTelegramDeliveryRuntime(h.runtime); owner = captureTelegramQuestionLifetimeOwner()!;
    await openHeadTailQuestion(h.runtime, "confirmation"); h.check(); }
  finally { clearTelegramDeliveryRuntime(); h.runtime.shutdown(); }
});

for (const kind of ["confirmation", "choice", "text"] as const) for (const threaded of [false, true])
test(`Native question admission retains its actual original runtime, target and clock (${kind}, Thread=${threaded})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const destination = threaded ? target : { chatId: 42 }; let owner: Readonly<TelegramQuestionLifetimeOwner>, retained: unknown;
  const h = questionAdmissionHarness(admission => {
    retained = admission; assert.ok(Object.isFrozen(admission) && Object.isFrozen(admission.target));
    assert.deepEqual(admission.target, destination); t.mock.timers.setTime(1010);
    assert.equal(owner.assertAdmission(admission), 1000); assert.equal(owner.assertAdmission(admission), 1000);
  }, { getInstanceTarget: () => destination });
  try {
    owner = h.runtime.captureQuestionLifetimeOwner!()!; assert.ok(owner);
    const opened = await openHeadTailQuestion(h.runtime, kind); assert.ok(opened.ok); h.check();
    assert.throws(() => owner.assertAdmission(retained), /unavailable/u); owner.assertCurrent();
    let ended = false; void opened.handle.result.then(() => { ended = true; }); t.mock.timers.tick(3_600_000); await Promise.resolve();
    assert.equal(ended, false, "Validation alone does not shorten or settle the SDK head");
  } finally { h.runtime.shutdown(); }
});

test("Native question admission refuses an equal-field different live runtime without poisoning the original owner", async () => {
  const a = confirmationHarness({ questionHeadTail: true }); let ownerB: Readonly<TelegramQuestionLifetimeOwner>;
  const ownerA = a.runtime.captureQuestionLifetimeOwner!()!; assert.ok(ownerA);
  const b = questionAdmissionHarness(admission => { assert.throws(() => ownerA.assertAdmission(admission), /unavailable/u);
    ownerA.assertCurrent(); assert.equal(typeof ownerB.assertAdmission(admission), "number"); });
  try { ownerB = b.runtime.captureQuestionLifetimeOwner!()!; assert.ok((await openHeadTailQuestion(b.runtime, "choice")).ok); b.check(); }
  finally { a.runtime.shutdown(); b.runtime.shutdown(); }
});

for (const wrong of ["target", "profile", "operator"] as const)
test(`Native question admission refuses changed original scope without equal-field restoration (${wrong})`, async () => {
  let profile = "default", operatorId = 42, owner: Readonly<TelegramQuestionLifetimeOwner>;
  const h = questionAdmissionHarness(admission => {
    assert.throws(() => owner.assertAdmission(admission), /unavailable/u);
    profile = "default"; operatorId = 42;
    assert.throws(() => owner.assertAdmission(admission), /unavailable/u);
    if (wrong === "target") owner.assertCurrent(); else assert.throws(owner.assertCurrent, /unavailable/u);
  }, { getConfirmationAuthority: () => ({ profile, operatorId }) });
  try {
    owner = h.runtime.captureQuestionLifetimeOwner!()!;
    if (wrong === "profile") profile = "other"; if (wrong === "operator") operatorId = 43;
    const opened = await openHeadTailQuestion(h.runtime, "confirmation", undefined, undefined,
      wrong === "target" ? { kind: "target", target: { ...target, threadId: 8 } } : { kind: "instance" });
    assert.equal(opened.ok, wrong === "target"); h.check();
  } finally { h.runtime.shutdown(); }
});

test("Native question admission rejects DTOs, copies, proxies and constructor/static-reader substitutions", async () => {
  let owner: Readonly<TelegramQuestionLifetimeOwner>;
  const h = questionAdmissionHarness(admission => {
    const constructor = Object.getPrototypeOf(admission).constructor as { new(...args: unknown[]): object; read: (...args: unknown[]) => unknown };
    for (const fake of [{ ...admission }, Object.create(Object.getPrototypeOf(admission)), new Proxy(admission, {}), {}])
      assert.throws(() => owner.assertAdmission(fake), /unavailable/u);
    assert.throws(() => new constructor(Symbol("native question admission"), target, admission.at, {}), /unavailable/u);
    const original = constructor.read;
    try { constructor.read = () => ({ runtime: {}, target, at: admission.at });
      assert.throws(() => owner.assertAdmission({ ...admission }), /unavailable/u);
      assert.equal(owner.assertAdmission(admission), admission.at);
    } finally { constructor.read = original; }
    owner.assertCurrent();
  });
  try { owner = h.runtime.captureQuestionLifetimeOwner!()!; assert.ok((await openHeadTailQuestion(h.runtime, "confirmation")).ok); h.check(); }
  finally { h.runtime.shutdown(); }
});

for (const loss of ["deadline", "abort", "generation", "authority-port", "authorization-port", "shutdown"] as const)
test(`Native question admission keeps observed entry/scope loss sticky (${loss})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const abort = new AbortController(); let owner: Readonly<TelegramQuestionLifetimeOwner>;
  const h = questionAdmissionHarness(admission => {
    const original = { generation: h.deps.generation, getConfirmationAuthority: h.deps.getConfirmationAuthority, isExplicitTargetAuthorized: h.deps.isExplicitTargetAuthorized };
    if (loss === "deadline") t.mock.timers.setTime(1100); if (loss === "abort") abort.abort();
    if (loss === "generation") h.deps.generation = "other";
    if (loss === "authority-port") h.deps.getConfirmationAuthority = () => ({ profile: "default", operatorId: 42 });
    if (loss === "authorization-port") h.deps.isExplicitTargetAuthorized = () => true;
    if (loss === "shutdown") h.runtime.shutdown();
    assert.throws(() => owner.assertAdmission(admission), /unavailable/u);
    t.mock.timers.setTime(1000); Object.assign(h.deps, original);
    assert.throws(() => owner.assertAdmission(admission), /unavailable/u);
  });
  try { owner = h.runtime.captureQuestionLifetimeOwner!()!; await openHeadTailQuestion(h.runtime, "confirmation", abort.signal, 100); h.check(); }
  finally { h.runtime.shutdown(); }
});

test("Native question admission rechecks its entry deadline after original authority callbacks", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  let remaining = 0, owner: Readonly<TelegramQuestionLifetimeOwner>;
  const h = questionAdmissionHarness(admission => {
    remaining = 3; assert.throws(() => owner.assertAdmission(admission), /unavailable/u);
    t.mock.timers.setTime(1000); assert.throws(() => owner.assertAdmission(admission), /unavailable/u);
  }, { getConfirmationAuthority() { if (remaining > 0 && --remaining === 0) t.mock.timers.setTime(1100); return { profile: "default", operatorId: 42 }; } });
  try { owner = h.runtime.captureQuestionLifetimeOwner!()!; await openHeadTailQuestion(h.runtime, "confirmation", undefined, 100); h.check(); }
  finally { h.runtime.shutdown(); }
});

test("Native question admission denies caught validation reentry and retains original owner loss", async () => {
  let remaining = 0, onRead: (() => void) | undefined, owner: Readonly<TelegramQuestionLifetimeOwner>;
  const h = questionAdmissionHarness(admission => {
    remaining = 3; onRead = () => { assert.throws(() => owner.assertAdmission(admission), /unavailable/u); };
    assert.throws(() => owner.assertAdmission(admission), /unavailable/u); assert.throws(owner.assertCurrent, /unavailable/u);
  }, { getConfirmationAuthority() { if (remaining > 0 && --remaining === 0) { const callback = onRead; onRead = undefined; callback?.(); }
    return { profile: "default", operatorId: 42 }; } });
  try { owner = h.runtime.captureQuestionLifetimeOwner!()!; assert.ok((await openHeadTailQuestion(h.runtime, "confirmation")).ok); h.check(); }
  finally { h.runtime.shutdown(); }
});

test("Native question admission observed guard reentry cannot be revived through another original owner", async () => {
  let remaining = 0, reenter: (() => void) | undefined, a: Readonly<TelegramQuestionLifetimeOwner>, b: Readonly<TelegramQuestionLifetimeOwner>;
  const h = questionAdmissionHarness(admission => {
    reenter = () => { assert.throws(() => b.assertAdmission(admission), /unavailable/u); };
    remaining = 3;
    assert.throws(() => a.assertAdmission(admission), /unavailable/u);
    a.assertCurrent(); b.assertCurrent();
    assert.throws(() => b.assertAdmission(admission), /unavailable/u);
  }, { getConfirmationAuthority() { if (remaining > 0 && --remaining === 0) { const callback = reenter; reenter = undefined; callback?.(); }
    return { profile: "default", operatorId: 42 }; } });
  try { a = h.runtime.captureQuestionLifetimeOwner!()!; b = h.runtime.captureQuestionLifetimeOwner!()!;
    assert.ok((await openHeadTailQuestion(h.runtime, "confirmation")).ok); h.check(); }
  finally { h.runtime.shutdown(); }
});

test("Native question admission closes before actual publication I/O and retains its real lane", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<number>(); let retained: unknown;
  const h = questionAdmissionHarness(admission => { retained = admission; }, { sendChunk: async () => { entered.resolve(); return release.promise; } });
  const owner = h.runtime.captureQuestionLifetimeOwner!()!;
  try {
    const opening = openHeadTailQuestion(h.runtime, "text"); await entered.promise; h.check();
    assert.throws(() => owner.assertAdmission(retained), /unavailable/u); h.runtime.shutdown();
    assert.equal(h.runtime.hasPendingTarget!(target), true); release.resolve(501); await opening; await flushConfirmationEffects();
    assert.equal(h.runtime.hasPendingTarget!(target), false);
  } finally { release.resolve(501); h.runtime.shutdown(); }
});

test("Native question admission consumes no async scope and cannot replay failed publication", async () => {
  let owner: Readonly<TelegramQuestionLifetimeOwner>, retained: unknown, calls = 0, lateDenied = false;
  const { runtime } = confirmationHarness({ questionHeadTail: true,
    async onQuestionAdmission(admission) { calls++; retained = admission; assert.equal(typeof owner.assertAdmission(admission), "number");
      await Promise.resolve(); try { owner.assertAdmission(admission); } catch { lateDenied = true; } throw new Error("observer"); },
    sendChunk: async () => { throw new Error("unknown publication"); } });
  try { owner = runtime.captureQuestionLifetimeOwner!()!; assert.equal((await openHeadTailQuestion(runtime, "confirmation")).ok, false);
    await flushConfirmationEffects(); assert.equal(calls, 1); assert.equal(lateDenied, true); assert.throws(() => owner.assertAdmission(retained), /unavailable/u);
  } finally { runtime.shutdown(); }
});

test("Native question admission captures its opt-in observer once and excludes rejected/Attachment/Task work", async () => {
  const base = confirmationHarness({ getAttachmentReceiverBotId: () => 99, publishAttachmentQuestion: async () => 777 });
  base.runtime.shutdown(); let reads = 0, calls = 0;
  Object.defineProperty(base.deps, "onQuestionAdmission", { get() { reads++; return () => { calls++; }; }, configurable: true });
  const off = createConcreteDeliveryRuntime(base.deps); assert.equal(reads, 0); off.shutdown();
  base.deps.questionHeadTail = true; const runtime = createConcreteDeliveryRuntime(base.deps); assert.equal(reads, 1);
  Object.defineProperty(base.deps, "onQuestionAdmission", { get() { throw new Error("renewed callback"); } });
  try {
    const rejected = confirmationRequest(); rejected.question = ""; await assert.rejects(runtime.openConfirmation!(rejected));
    assert.ok((await runtime.openTaskView!(taskRequest())).ok);
    assert.ok((await runtime.openAttachmentQuestion!({ owner: "test", scope: { kind: "instance" }, question: "File", cancelLabel: "Cancel", timeoutMs: 1000,
      signal: new AbortController().signal, accept: ["*/*"], maxFiles: 1, maxBytes: 100 })).ok);
    assert.equal(calls, 0); assert.ok((await openHeadTailQuestion(runtime, "choice")).ok); assert.equal(calls, 1); assert.equal(reads, 1);
  } finally { runtime.shutdown(); }
});

test("Private ordinary SDK history reads no provider, port getter or filesystem", () => {
  let calls = 0;
  const h = confirmationHarness({ questionHeadTail: true, getConfirmationAuthority() { calls++; return { profile: "default", operatorId: 42 }; } });
  try {
    const owner = h.runtime.captureQuestionLifetimeOwner!()!; assert.equal(typeof owner.assertObservedCurrent, "function");
    const original = h.deps.isExplicitTargetAuthorized; let getters = 0;
    Object.defineProperty(h.deps, "isExplicitTargetAuthorized", { configurable: true, get() { getters++; return original; } });
    const before = calls; owner.assertObservedCurrent!(); owner.assertObservedCurrent!(); assert.equal(calls, before); assert.equal(getters, 0);
  } finally { h.runtime.shutdown(); }
});

for (const loss of ["local", "shutdown", "binding", "callable", "provider"] as const)
test(`Private ordinary SDK history retains its original observed loss (${loss})`, () => {
  clearTelegramDeliveryRuntime(); let authorized = true, provider = true, getterCalls = 0;
  const h = confirmationHarness({ questionHeadTail: true, isExplicitTargetAuthorized: () => authorized,
    captureQuestionAuthority: () => () => { if (!provider) throw new Error("Original provider is unavailable"); } });
  const unbind = bindTelegramDeliveryRuntime(h.runtime);
  try {
    const owner = captureTelegramQuestionLifetimeOwner()!; assert.ok(owner); assert.equal(typeof owner.assertObservedCurrent, "function"); owner.assertObservedCurrent!();
    const original = Object.getOwnPropertyDescriptor(h.runtime, "captureQuestionLifetimeOwner")!;
    if (loss === "local") { authorized = false; assert.throws(owner.assertCurrent, /unavailable/u); authorized = true; }
    if (loss === "shutdown") h.runtime.shutdown();
    if (loss === "binding") { unbind(); bindTelegramDeliveryRuntime(h.runtime); }
    if (loss === "callable") Object.defineProperty(h.runtime, "captureQuestionLifetimeOwner", { configurable: true, get() { getterCalls++; return original.value; } });
    if (loss === "provider") { provider = false; assert.throws(owner.assertCurrent, /unavailable/u); provider = true; }
    assert.throws(owner.assertObservedCurrent!, /unavailable/u);
    Object.defineProperty(h.runtime, "captureQuestionLifetimeOwner", original); assert.equal(getterCalls, 0);
    assert.throws(owner.assertObservedCurrent!, /unavailable/u);
  } finally { unbind(); clearTelegramDeliveryRuntime(); h.runtime.shutdown(); }
});

for (const threaded of [false, true])
test(`Private SDK original roster authority pins its phase, clock and data barrier (Thread=${threaded})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let onMetadata: (() => void) | undefined;
  const h = confirmationHarness({ questionHeadTail: true, getInstanceTarget: () => threaded ? target : { chatId: 42 },
    getConfirmationAuthority() { onMetadata?.(); return { profile: "default", operatorId: 42 }; } });
  try {
    const opened = await openHeadTailQuestion(h.runtime, "confirmation"); assert.ok(opened.ok);
    let ended = false, reads = 0, calls = 0, dataChecks = 0, barrier = false, afterBarrier = 0;
    void opened.handle.result.then(() => { ended = true; });
    const owner = h.runtime.captureQuestionLifetimeOwner!()!, peer = h.runtime.captureQuestionLifetimeOwner!()!;
    const original = h.deps.isExplicitTargetAuthorized;
    Object.defineProperty(h.deps, "isExplicitTargetAuthorized", { configurable: true, get() { if (barrier) afterBarrier++; return original; } });
    onMetadata = () => { assert.equal(barrier, false); };
    const cohort = { scopes: [peer.scope], get assertAuthority() { reads++; return () => { assert.equal(barrier, false); calls++; }; },
      assertCurrent() { assert.equal(calls, ++dataChecks); barrier = true; } };
    const apply = owner.captureTail(cohort); assert.equal(reads, 1); assert.equal(calls, 1); assert.equal(afterBarrier, 0);
    Object.defineProperty(cohort, "assertAuthority", { get() { throw new Error("Do not renew original roster authority"); } });
    cohort.scopes.length = 0; t.mock.timers.tick(1_800_000); barrier = false; apply();
    assert.equal(reads, 1); assert.equal(calls, 2); assert.equal(dataChecks, 2); assert.equal(afterBarrier, 0); assert.throws(apply, /unavailable/u);
    onMetadata = undefined; barrier = false;
    t.mock.timers.tick(1_799_999); await Promise.resolve(); assert.equal(ended, false);
    t.mock.timers.tick(1); await Promise.resolve(); assert.equal(ended, true);
  } finally { h.runtime.shutdown(); }
});

for (const phase of ["capture", "apply"] as const)
test(`Private SDK original roster authority observes last-provider loss before the data barrier (${phase})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let onMetadata: (() => void) | undefined, remaining = 0, live = true, observedLoss = false, authorityCalls = 0, dataChecks = 0;
  const { runtime } = confirmationHarness({ questionHeadTail: true,
    captureQuestionAuthority: () => () => { if (onMetadata && --remaining === 0) { const fn = onMetadata; onMetadata = undefined; fn(); } } });
  try {
    const opened = await openHeadTailQuestion(runtime, "confirmation"); assert.ok(opened.ok);
    let ended = false; void opened.handle.result.then(() => { ended = true; });
    const owner = runtime.captureQuestionLifetimeOwner!()!, cohort = { scopes: [owner.scope],
      assertAuthority() { authorityCalls++; observedLoss ||= !live; if (observedLoss) throw new Error("Original roster authority is unavailable"); },
      assertCurrent() { dataChecks++; if (observedLoss) throw new Error("Original roster history is unavailable"); } };
    cohort.assertAuthority(); // A wrapper-only precheck passes, but cannot cover the next metadata callback.
    if (phase === "capture") { remaining = 2; onMetadata = () => { live = false; }; assert.throws(() => owner.captureTail(cohort), /unavailable/u); }
    else { const apply = owner.captureTail(cohort); remaining = 2; onMetadata = () => { live = false; }; assert.throws(apply, /unavailable/u); assert.throws(apply, /unavailable/u); }
    assert.equal(observedLoss, true); assert.equal(authorityCalls, phase === "capture" ? 2 : 3); assert.equal(dataChecks, phase === "capture" ? 0 : 1);
    live = true; assert.throws(cohort.assertAuthority, /unavailable/u); assert.throws(owner.captureTail, /unavailable/u);
    t.mock.timers.tick(3_600_000); await Promise.resolve(); assert.equal(ended, false);
  } finally { runtime.shutdown(); }
});

for (const phase of ["capture", "apply"] as const) for (const boundary of ["throw", "value", "resolve", "reject", "pending", "peer", "own", "alias", "shutdown"] as const)
test(`Private SDK original roster authority refuses without a data prefix or retry (${phase}/${boundary})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let authorized = true, calls = 0, dataChecks = 0, observed = 0;
  const { runtime } = confirmationHarness({ questionHeadTail: true, isExplicitTargetAuthorized: () => authorized });
  try {
    const opened = await openHeadTailQuestion(runtime, "confirmation"); assert.ok(opened.ok);
    let ended = false; void opened.handle.result.then(() => { ended = true; });
    const owner = runtime.captureQuestionLifetimeOwner!()!, peer = runtime.captureQuestionLifetimeOwner!()!;
    const returned = boundary === "reject" ? Promise.reject(new Error("Original roster refused")) : boundary === "pending" ? new Promise<void>(() => {}) : Promise.resolve();
    const then = returned.then.bind(returned);
    Object.defineProperty(returned, "then", { value(onFulfilled: unknown, onRejected: (reason: unknown) => unknown) {
      if (typeof onRejected === "function") observed++;
      return then(onFulfilled as (value: void) => never, onRejected);
    } });
    let apply: (() => void) | undefined;
    const cohort = { scopes: [peer.scope], assertAuthority(): unknown {
      if (++calls !== (phase === "capture" ? 1 : 2)) return;
      if (boundary === "throw") throw new Error("Original roster is unavailable");
      if (boundary === "value") return false;
      if (boundary === "resolve" || boundary === "reject" || boundary === "pending") return returned;
      if (boundary === "peer") { authorized = false; assert.throws(peer.assertCurrent, /unavailable/u); authorized = true; }
      if (boundary === "own") assert.throws(() => owner.assertScope({}), /unavailable/u);
      if (boundary === "alias") { if (apply) assert.throws(apply, /unavailable/u); else assert.throws(owner.captureTail, /unavailable/u); }
      if (boundary === "shutdown") runtime.shutdown();
    }, assertCurrent() { dataChecks++; } };
    try {
      const typed = cohort as unknown as Parameters<TelegramQuestionLifetimeOwner["captureTail"]>[0];
      if (phase === "capture") assert.throws(() => owner.captureTail(typed), /unavailable/u);
      else { apply = owner.captureTail(typed); assert.throws(apply, /unavailable/u); assert.throws(apply, /unavailable/u); }
      assert.equal(calls, phase === "capture" ? 1 : 2); assert.equal(dataChecks, phase === "capture" ? 0 : 1);
      if (["resolve", "reject", "pending"].includes(boundary)) assert.ok(observed > 0, "Refused returns are inertly observed without awaiting");
      assert.throws(owner.captureTail, /unavailable/u); t.mock.timers.tick(3_600_000); await Promise.resolve();
      if (boundary !== "shutdown") assert.equal(ended, false);
    } finally { void then(undefined, () => {}); }
  } finally { runtime.shutdown(); }
});

for (const boundary of [null, false, 1, {}, "callback"])
test(`Private SDK original roster authority refuses a malformed phase (${JSON.stringify(boundary)})`, async () => {
  const { runtime } = confirmationHarness({ questionHeadTail: true });
  try {
    const owner = runtime.captureQuestionLifetimeOwner!()!; let dataChecks = 0;
    assert.throws(() => owner.captureTail({ scopes: [owner.scope], assertCurrent() { dataChecks++; }, assertAuthority: boundary } as unknown as Parameters<TelegramQuestionLifetimeOwner["captureTail"]>[0]), /unavailable/u);
    assert.equal(dataChecks, 0); assert.throws(owner.captureTail, /unavailable/u);
  } finally { runtime.shutdown(); }
});

for (const phase of ["options", "capture", "apply"] as const)
test(`Private SDK original roster authority never recaptures callback-created newer SDK questions (${phase})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const { runtime } = confirmationHarness({ questionHeadTail: true });
  try {
    assert.ok((await openHeadTailQuestion(runtime, "confirmation")).ok);
    const owner = runtime.captureQuestionLifetimeOwner!()!, peer = runtime.captureQuestionLifetimeOwner!()!;
    let next: ReturnType<typeof openHeadTailQuestion> | undefined, calls = 0, reads = 0;
    const admit = () => { next = openHeadTailQuestion(runtime, "choice"); };
    const cohort = { scopes: [peer.scope], get assertAuthority() { reads++; if (phase === "options") admit(); return () => { if (++calls === (phase === "apply" ? 2 : 1) && phase !== "options") admit(); }; }, assertCurrent() {} };
    const apply = owner.captureTail(cohort); apply(); assert.equal(reads, 1); assert.equal(calls, 2); assert.ok(next);
    const newer = await next; assert.ok(newer.ok); let ended = false; void newer.handle.result.then(() => { ended = true; });
    t.mock.timers.tick(3_600_000); await Promise.resolve(); assert.equal(ended, false);
  } finally { runtime.shutdown(); }
});

for (const boundary of ["getter", "guard"] as const)
test(`Private SDK original roster authority poisons caught own capture reentry (${boundary})`, async () => {
  const { runtime } = confirmationHarness({ questionHeadTail: true });
  try {
    const owner = runtime.captureQuestionLifetimeOwner!()!;
    const reenter = () => { assert.throws(() => owner.assertScope({}), /unavailable/u); };
    const cohort = { scopes: [owner.scope], get assertAuthority() { if (boundary === "getter") reenter(); return () => { if (boundary === "guard") reenter(); }; }, assertCurrent() {} };
    assert.throws(() => owner.captureTail(cohort), /unavailable/u); assert.throws(owner.assertCurrent, /unavailable/u);
  } finally { runtime.shutdown(); }
});

for (const phase of ["capture", "apply"] as const)
test(`Private SDK original roster authority retains data-guard veto after authority success (${phase})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const { runtime } = confirmationHarness({ questionHeadTail: true });
  try {
    const opened = await openHeadTailQuestion(runtime, "confirmation"); assert.ok(opened.ok);
    let ended = false, dataChecks = 0, authorityCalls = 0; void opened.handle.result.then(() => { ended = true; });
    const owner = runtime.captureQuestionLifetimeOwner!()!, cohort = { scopes: [owner.scope], assertAuthority() { authorityCalls++; },
      assertCurrent() { if (++dataChecks === (phase === "capture" ? 1 : 2)) throw new Error("Original roster data is unavailable"); } };
    if (phase === "capture") assert.throws(() => owner.captureTail(cohort), /unavailable/u);
    else { const apply = owner.captureTail(cohort); assert.throws(apply, /unavailable/u); }
    assert.equal(authorityCalls, phase === "capture" ? 1 : 2); assert.throws(owner.captureTail, /unavailable/u);
    t.mock.timers.tick(3_600_000); await Promise.resolve(); assert.equal(ended, false);
  } finally { runtime.shutdown(); }
});

for (const phase of ["options", "capture", "apply"] as const)
test(`Private SDK cohort gate poisons invalid-token reentry in its own active guard (${phase})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const { runtime } = confirmationHarness({ questionHeadTail: true });
  try {
    const opened = await openHeadTailQuestion(runtime, "confirmation"); assert.ok(opened.ok);
    let ended = false, calls = 0; void opened.handle.result.then(() => { ended = true; });
    const owner = runtime.captureQuestionLifetimeOwner!()!;
    const reenter = () => { assert.throws(() => owner.assertScope({}), /unavailable/u); };
    const cohort = { get scopes() { if (phase === "options") reenter(); return [owner.scope]; },
      assertCurrent() { if (++calls === (phase === "apply" ? 2 : 1) && phase !== "options") reenter(); } };
    if (phase === "apply") { const apply = owner.captureTail(cohort); assert.throws(apply, /unavailable/u); }
    else assert.throws(() => owner.captureTail(cohort), /unavailable/u);
    assert.throws(owner.assertCurrent, /unavailable/u); t.mock.timers.tick(3_600_000); await Promise.resolve(); assert.equal(ended, false);
  } finally { runtime.shutdown(); }
});

test("Private SDK cohort gate poisons a caught application-alias reentry", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const { runtime } = confirmationHarness({ questionHeadTail: true });
  try {
    const opened = await openHeadTailQuestion(runtime, "confirmation"); assert.ok(opened.ok);
    let ended = false, calls = 0; void opened.handle.result.then(() => { ended = true; });
    const owner = runtime.captureQuestionLifetimeOwner!()!;
    const apply = owner.captureTail({ scopes: [owner.scope], assertCurrent() { if (++calls === 2) assert.throws(apply, /unavailable/u); } });
    assert.throws(apply, /unavailable/u); assert.throws(owner.assertCurrent, /unavailable/u);
    t.mock.timers.tick(3_600_000); await Promise.resolve(); assert.equal(ended, false);
  } finally { runtime.shutdown(); }
});

test("Private SDK cohort gate performs no provider-port reads after the local data barrier", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const h = confirmationHarness({ questionHeadTail: true });
  try {
    const opened = await openHeadTailQuestion(h.runtime, "confirmation"); assert.ok(opened.ok);
    const owner = h.runtime.captureQuestionLifetimeOwner!()!, original = h.deps.isExplicitTargetAuthorized;
    let afterGuard = false, lateReads = 0, calls = 0;
    Object.defineProperty(h.deps, "isExplicitTargetAuthorized", { configurable: true, get() { if (afterGuard) lateReads++; return original; } });
    const apply = owner.captureTail({ scopes: [owner.scope], assertCurrent() { calls++; afterGuard = true; } });
    assert.equal(calls, 1); assert.equal(lateReads, 0); afterGuard = false;
    apply(); assert.equal(calls, 2); assert.equal(lateReads, 0, "A getter must not clear the head after its last check");
  } finally { h.runtime.shutdown(); }
});

for (const threaded of [false, true])
test(`Private SDK cohort gate retains original clock, peers and head guard (Thread=${threaded})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const { runtime } = confirmationHarness({ questionHeadTail: true, getInstanceTarget: () => threaded ? target : { chatId: 42 } });
  try {
    const opened = await openHeadTailQuestion(runtime, "confirmation"); assert.ok(opened.ok);
    let ended = false, checks = 0; void opened.handle.result.then(() => { ended = true; });
    const owner = runtime.captureQuestionLifetimeOwner!()!, peer = runtime.captureQuestionLifetimeOwner!()!;
    const scopes = [owner.scope, peer.scope], cohort = { scopes, assertCurrent: () => { checks++; } };
    const apply = owner.captureTail(cohort); assert.equal(checks, 1);
    cohort.assertCurrent = () => { checks += 1000; }; scopes.length = 0;
    t.mock.timers.tick(1_800_000); apply(); assert.equal(checks, 2); assert.throws(apply, /unavailable/u);
    t.mock.timers.tick(1_799_999); await Promise.resolve(); assert.equal(ended, false);
    t.mock.timers.tick(1); await Promise.resolve(); assert.equal(ended, true);
  } finally { runtime.shutdown(); }
});

for (const boundary of ["foreign", "copied", "prototype", "target", "empty", "missing-guard", "async-guard"] as const)
test(`Private SDK cohort gate refuses unowned or malformed original vectors (${boundary})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let receiver = target;
  const { runtime } = confirmationHarness({ questionHeadTail: true, getInstanceTarget: () => receiver });
  const foreign = confirmationHarness({ questionHeadTail: true }).runtime;
  try {
    const opened = await openHeadTailQuestion(runtime, "confirmation"); assert.ok(opened.ok);
    let ended = false; void opened.handle.result.then(() => { ended = true; });
    const owner = runtime.captureQuestionLifetimeOwner!()!;
    receiver = { ...target, threadId: 8 }; const otherTarget = runtime.captureQuestionLifetimeOwner!()!; receiver = target;
    const scope = boundary === "foreign" ? foreign.captureQuestionLifetimeOwner!()!.scope : boundary === "copied" ? { ...owner.scope } :
      boundary === "prototype" ? Object.create(owner.scope) as object : boundary === "target" ? otherTarget.scope : owner.scope;
    const cohort = { scopes: boundary === "empty" ? [] : [scope], assertCurrent: boundary === "async-guard" ? async () => {} : () => {} };
    if (boundary === "missing-guard") Reflect.deleteProperty(cohort, "assertCurrent");
    assert.throws(() => owner.captureTail(cohort), /unavailable/u); assert.throws(owner.captureTail, /unavailable/u);
    t.mock.timers.tick(3_600_000); await Promise.resolve(); assert.equal(ended, false);
  } finally { runtime.shutdown(); foreign.shutdown(); }
});

for (const phase of ["capture", "apply"] as const) for (const loss of ["peer", "head"] as const)
test(`Private SDK cohort gate rechecks after the final native provider callback (${phase}/${loss})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let onRead: (() => void) | undefined, authorized = true, live = true, checks = 0;
  const { runtime } = confirmationHarness({ questionHeadTail: true, isExplicitTargetAuthorized: () => authorized,
    getConfirmationAuthority() { const callback = onRead; onRead = undefined; callback?.(); return { profile: "default", operatorId: 42 }; } });
  try {
    const opened = await openHeadTailQuestion(runtime, "confirmation"); assert.ok(opened.ok);
    let ended = false; void opened.handle.result.then(() => { ended = true; });
    const owner = runtime.captureQuestionLifetimeOwner!()!, peer = runtime.captureQuestionLifetimeOwner!()!;
    const lose = () => { if (loss === "head") live = false; else { authorized = false; assert.throws(peer.assertCurrent, /unavailable/u); authorized = true; } };
    const cohort = { scopes: [peer.scope], assertCurrent() { checks++; if (!live) throw new Error("Original head is unavailable"); } };
    if (phase === "capture") { onRead = lose; assert.throws(() => owner.captureTail(cohort), /unavailable/u); }
    else { const apply = owner.captureTail(cohort); onRead = lose; assert.throws(apply, /unavailable/u); assert.throws(apply, /unavailable/u); }
    assert.equal(checks, (phase === "capture" ? 0 : 1) + (loss === "head" ? 1 : 0), "An unavailable peer refuses the local guard before calling it");
    owner.assertCurrent(); assert.throws(owner.captureTail, /unavailable/u);
    t.mock.timers.tick(3_600_000); await Promise.resolve(); assert.equal(ended, false, "No peer loss or cleared head can shorten SDK questions");
  } finally { runtime.shutdown(); }
});

test("Private SDK cohort gate keeps original peer histories after caller array replacement", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let authorized = true;
  const { runtime } = confirmationHarness({ questionHeadTail: true, isExplicitTargetAuthorized: () => authorized });
  try {
    const opened = await openHeadTailQuestion(runtime, "confirmation"); assert.ok(opened.ok);
    let ended = false; void opened.handle.result.then(() => { ended = true; });
    const owner = runtime.captureQuestionLifetimeOwner!()!, peer = runtime.captureQuestionLifetimeOwner!()!;
    const scopes = [peer.scope], apply = owner.captureTail({ scopes, assertCurrent() {} });
    scopes[0] = runtime.captureQuestionLifetimeOwner!()!.scope;
    authorized = false; assert.throws(peer.assertCurrent, /unavailable/u); authorized = true;
    assert.throws(apply, /unavailable/u); t.mock.timers.tick(3_600_000); await Promise.resolve(); assert.equal(ended, false);
  } finally { runtime.shutdown(); }
});

test("Private SDK cohort gate checks peer history again after the local head guard", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let authorized = true, calls = 0;
  const { runtime } = confirmationHarness({ questionHeadTail: true, isExplicitTargetAuthorized: () => authorized });
  try {
    const opened = await openHeadTailQuestion(runtime, "confirmation"); assert.ok(opened.ok);
    let ended = false; void opened.handle.result.then(() => { ended = true; });
    const owner = runtime.captureQuestionLifetimeOwner!()!, peer = runtime.captureQuestionLifetimeOwner!()!;
    const apply = owner.captureTail({ scopes: [peer.scope], assertCurrent() { if (++calls === 2) {
      authorized = false; assert.throws(peer.assertCurrent, /unavailable/u); authorized = true;
    } } });
    assert.throws(apply, /unavailable/u); t.mock.timers.tick(3_600_000); await Promise.resolve(); assert.equal(ended, false);
  } finally { runtime.shutdown(); }
});

for (const phase of ["capture", "apply", "options"] as const)
test(`Private SDK cohort gate never snapshots a callback-created newer question (${phase})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let onRead: (() => void) | undefined, next: ReturnType<typeof openHeadTailQuestion> | undefined;
  const { runtime } = confirmationHarness({ questionHeadTail: true,
    getConfirmationAuthority() { const callback = onRead; onRead = undefined; callback?.(); return { profile: "default", operatorId: 42 }; } });
  try {
    assert.ok((await openHeadTailQuestion(runtime, "confirmation")).ok);
    const owner = runtime.captureQuestionLifetimeOwner!()!, peer = runtime.captureQuestionLifetimeOwner!()!;
    let reads = 0; const admit = () => { next = openHeadTailQuestion(runtime, "choice"); };
    const cohort = { get scopes() { reads++; if (phase === "options") admit(); return [peer.scope]; }, assertCurrent() {} };
    if (phase === "capture") onRead = admit;
    const apply = owner.captureTail(cohort); if (phase === "apply") onRead = admit; apply(); assert.equal(reads, 1); assert.ok(next);
    const newer = await next; assert.ok(newer.ok); let ended = false; void newer.handle.result.then(() => { ended = true; });
    t.mock.timers.tick(3_600_000); await Promise.resolve(); assert.equal(ended, false);
  } finally { runtime.shutdown(); }
});

test("Private SDK cohort gate refuses an async application guard without awaiting or retry", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 }); let calls = 0;
  const { runtime } = confirmationHarness({ questionHeadTail: true });
  try {
    const opened = await openHeadTailQuestion(runtime, "confirmation"); assert.ok(opened.ok);
    let ended = false; void opened.handle.result.then(() => { ended = true; });
    const owner = runtime.captureQuestionLifetimeOwner!()!;
    const apply = owner.captureTail({ scopes: [owner.scope], assertCurrent() { if (++calls === 2) return Promise.resolve(); } });
    assert.throws(apply, /unavailable/u); assert.throws(apply, /unavailable/u);
    t.mock.timers.tick(3_600_000); await Promise.resolve(); assert.equal(ended, false);
  } finally { runtime.shutdown(); }
});

for (const phase of ["capture", "apply"] as const)
test(`Private SDK cohort gate observes a refused rejected return without waiting (${phase})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const { runtime } = confirmationHarness({ questionHeadTail: true });
  try {
    const opened = await openHeadTailQuestion(runtime, "confirmation"); assert.ok(opened.ok);
    let ended = false, calls = 0, observed = 0; void opened.handle.result.then(() => { ended = true; });
    const owner = runtime.captureQuestionLifetimeOwner!()!, rejected = Promise.reject(new Error("Refused private guard"));
    const then = rejected.then.bind(rejected);
    Object.defineProperty(rejected, "then", { value(onFulfilled: unknown, onRejected: (reason: unknown) => unknown) {
      if (typeof onRejected === "function") observed++;
      return then(onFulfilled as (value: never) => never, onRejected);
    } });
    try {
      const cohort = { scopes: [owner.scope], assertCurrent() { if (++calls === (phase === "capture" ? 1 : 2)) return rejected; } };
      if (phase === "capture") assert.throws(() => owner.captureTail(cohort), /unavailable/u);
      else { const apply = owner.captureTail(cohort); assert.throws(apply, /unavailable/u); assert.throws(apply, /unavailable/u); }
      assert.ok(observed > 0, "Refused async returns need an inert rejection observer, not an unhandled process failure");
    } finally { await then(undefined, () => {}); }
    t.mock.timers.tick(3_600_000); await Promise.resolve(); assert.equal(ended, false);
  } finally { runtime.shutdown(); }
});

test("Private question lifetime owner requires opt-in and an exact current instance scope", () => {
  let reads = 0;
  const off = confirmationHarness({ getConfirmationAuthority: () => { reads++; return { profile: "default", operatorId: 42 }; } });
  try { assert.equal(off.runtime.captureQuestionLifetimeOwner!(), undefined); assert.equal(reads, 0); }
  finally { off.runtime.shutdown(); }
  for (const overrides of [
    { getConfirmationAuthority: () => undefined }, { getConfirmationAuthority: () => ({ profile: "", operatorId: 42 }) },
    { getConfirmationAuthority: () => ({ profile: "default", operatorId: 0 }) }, { getInstanceTarget: () => undefined },
    { getInstanceTarget: () => ({ chatId: -42 }) }, { getInstanceTarget: () => ({ chatId: 42, threadId: 0 }) },
    { isExplicitTargetAuthorized: () => false },
  ]) {
    const { runtime } = confirmationHarness({ questionHeadTail: true, ...overrides });
    try { assert.equal(runtime.captureQuestionLifetimeOwner!(), undefined); } finally { runtime.shutdown(); }
  }
});

for (const threaded of [false, true])
test(`Private question lifetime owner retains its original clock and one snapshot/application (Thread=${threaded})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const destination = threaded ? target : { chatId: 42 };
  const { runtime } = confirmationHarness({ questionHeadTail: true, getInstanceTarget: () => destination });
  try {
    const owner = runtime.captureQuestionLifetimeOwner!(); assert.ok(owner && Object.isFrozen(owner) && Object.isFrozen(owner.target));
    assert.deepEqual(owner.target, destination); assert.throws(() => { (owner.target as { threadId: number }).threadId = 8; }, TypeError);
    t.mock.timers.tick(2 * 3_600_000);
    const a = await openHeadTailQuestion(runtime, "confirmation"); assert.ok(a.ok);
    let ended = false; void a.handle.result.then(() => { ended = true; });
    const apply = owner.captureTail(); assert.ok(Object.isFrozen(apply));
    const alias = { ...owner }; assert.throws(alias.captureTail, /unavailable/u);
    t.mock.timers.tick(1_800_000); apply(); assert.throws(apply, /unavailable/u);
    t.mock.timers.tick(1_800_000 - 1); await Promise.resolve(); assert.equal(ended, false);
    t.mock.timers.tick(1); await Promise.resolve(); assert.equal(ended, true);
    assert.deepEqual(await a.handle.result, { status: "expired" });
  } finally { runtime.shutdown(); }
});

test("Private question lifetime empty snapshot never borrows a later SDK head", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const { runtime } = confirmationHarness({ questionHeadTail: true });
  try {
    const owner = runtime.captureQuestionLifetimeOwner!(); assert.ok(owner);
    const apply = owner.captureTail();
    const a = await openHeadTailQuestion(runtime, "confirmation"); assert.ok(a.ok);
    let ended = false; void a.handle.result.then(() => { ended = true; });
    apply(); t.mock.timers.tick(3_600_000); await Promise.resolve(); assert.equal(ended, false);
  } finally { runtime.shutdown(); }
});

for (const boundary of ["profile", "operator", "target", "generation", "authority-port", "target-port", "authorization-port", "authorization"] as const)
test(`Private question lifetime observed original owner loss cannot revive (${boundary})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  let profile = "default", operatorId = 42, authorized = true;
  const receiver = { ...target }, authority = { profile, operatorId };
  const { runtime, deps } = confirmationHarness({ questionHeadTail: true, getConfirmationAuthority: () => Object.assign(authority, { profile, operatorId }),
    getInstanceTarget: () => receiver, isExplicitTargetAuthorized: () => authorized });
  const original = { generation: deps.generation, getConfirmationAuthority: deps.getConfirmationAuthority,
    getInstanceTarget: deps.getInstanceTarget, isExplicitTargetAuthorized: deps.isExplicitTargetAuthorized };
  try {
    const a = await openHeadTailQuestion(runtime, "confirmation"); assert.ok(a.ok);
    let ended = false; void a.handle.result.then(() => { ended = true; });
    const owner = runtime.captureQuestionLifetimeOwner!(); assert.ok(owner); const apply = owner.captureTail();
    if (boundary === "profile") profile = "other";
    if (boundary === "operator") operatorId = 43;
    if (boundary === "target") receiver.threadId = 8;
    if (boundary === "generation") deps.generation = "successor";
    if (boundary === "authority-port") deps.getConfirmationAuthority = () => ({ profile, operatorId });
    if (boundary === "target-port") deps.getInstanceTarget = () => receiver;
    if (boundary === "authorization-port") deps.isExplicitTargetAuthorized = () => true;
    if (boundary === "authorization") authorized = false;
    assert.throws(owner.assertCurrent, /unavailable/u);
    profile = "default"; operatorId = 42; receiver.threadId = target.threadId; authorized = true; Object.assign(deps, original);
    assert.throws(owner.assertCurrent, /unavailable/u); assert.throws(apply, /unavailable/u);
    assert.throws(owner.captureTail, /unavailable/u);
    t.mock.timers.tick(3_600_000); await Promise.resolve(); assert.equal(ended, false, "Failed original-owner guards cannot cap the retained SDK question");
  } finally { runtime.shutdown(); }
});

test("Private question lifetime cannot select a replacement runtime with equal scope fields", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const a = confirmationHarness({ questionHeadTail: true }).runtime, b = confirmationHarness({ questionHeadTail: true }).runtime;
  try {
    bindTelegramDeliveryRuntime(a); const owner = a.captureQuestionLifetimeOwner!(); assert.ok(owner); const apply = owner.captureTail();
    bindTelegramDeliveryRuntime(b); const current = await openHeadTailQuestion(b, "confirmation"); assert.ok(current.ok);
    let ended = false; void current.handle.result.then(() => { ended = true; });
    assert.throws(owner.assertCurrent, /unavailable/u); assert.throws(apply, /unavailable/u);
    t.mock.timers.tick(3_600_000); await Promise.resolve(); assert.equal(ended, false);
  } finally { a.shutdown(); b.shutdown(); clearTelegramDeliveryRuntime(); }
});

for (const phase of ["capture", "apply"] as const)
test(`Private question lifetime snapshot excludes questions admitted inside guard callbacks (${phase})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  let onRead: (() => void) | undefined, next: ReturnType<typeof openHeadTailQuestion> | undefined;
  const { runtime } = confirmationHarness({ questionHeadTail: true,
    getConfirmationAuthority() { const callback = onRead; onRead = undefined; callback?.(); return { profile: "default", operatorId: 42 }; } });
  try {
    const a = await openHeadTailQuestion(runtime, "confirmation"); assert.ok(a.ok);
    const owner = runtime.captureQuestionLifetimeOwner!(); assert.ok(owner);
    const reenter = () => { next = openHeadTailQuestion(runtime, "choice"); };
    if (phase === "capture") onRead = reenter;
    const apply = owner.captureTail();
    if (phase === "apply") onRead = reenter;
    apply(); assert.ok(next); const b = await next; assert.ok(b.ok);
    let ended = false; void b.handle.result.then(() => { ended = true; });
    t.mock.timers.tick(3_600_000); await Promise.resolve(); assert.equal(ended, false);
    assert.deepEqual(await a.handle.result, { status: "expired" });
  } finally { runtime.shutdown(); }
});

test("Private question lifetime caught guard reentry poisons the original owner", () => {
  let onRead: (() => void) | undefined;
  const { runtime } = confirmationHarness({ questionHeadTail: true,
    getConfirmationAuthority() { const callback = onRead; onRead = undefined; callback?.(); return { profile: "default", operatorId: 42 }; } });
  try {
    const owner = runtime.captureQuestionLifetimeOwner!(); assert.ok(owner);
    onRead = () => { assert.throws(owner.assertCurrent, /unavailable/u); };
    assert.throws(owner.assertCurrent, /unavailable/u); assert.throws(owner.captureTail, /unavailable/u);
  } finally { runtime.shutdown(); }
});

for (const duringRead of [1, 2, 3])
test(`Private question lifetime caught owner-acquisition reentry refuses the outer capture (read=${duringRead})`, () => {
  let reads = 0;
  const { runtime } = confirmationHarness({ questionHeadTail: true, getConfirmationAuthority() {
    if (++reads === duringRead) assert.equal(runtime.captureQuestionLifetimeOwner!(), undefined);
    return { profile: "default", operatorId: 42 };
  } });
  try { assert.equal(runtime.captureQuestionLifetimeOwner!(), undefined); }
  finally { runtime.shutdown(); }
});

test("Private question lifetime excludes foreign output targets and Attachment", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const { runtime } = attachmentHarness({ questionHeadTail: true });
  try {
    const foreign = await openHeadTailQuestion(runtime, "confirmation", undefined, undefined, { kind: "target", target: { chatId: 42, threadId: 8 } }); assert.ok(foreign.ok);
    const attachment = await runtime.openAttachmentQuestion!({ ...attachmentQuestion(), timeoutMs: 2 * 3_600_000 }); assert.ok(attachment.ok);
    const owner = runtime.captureQuestionLifetimeOwner!(); assert.ok(owner);
    let foreignEnded = false, attachmentEnded = false;
    void foreign.handle.result.then(() => { foreignEnded = true; }); void attachment.handle.result.then(() => { attachmentEnded = true; });
    owner.captureTail()(); t.mock.timers.tick(3_600_000); await Promise.resolve();
    assert.equal(foreignEnded, false); assert.equal(attachmentEnded, false);
  } finally { runtime.shutdown(); }
});

test("Private question lifetime receiver observation preserves existing sticky Text source loss", async () => {
  const receiver = { ...target };
  const { runtime } = confirmationHarness({ questionHeadTail: true, getTextInputReceiverBotId: () => 99, getInstanceTarget: () => receiver });
  try {
    const a = await openHeadTailQuestion(runtime, "text"); assert.ok(a.ok);
    const source = runtime.captureTextInputSource!(target), owner = runtime.captureQuestionLifetimeOwner!(); assert.ok(source && owner);
    receiver.threadId = 8; assert.throws(owner.assertCurrent, /unavailable/u);
    receiver.threadId = target.threadId; assert.throws(source.assertCurrent); assert.throws(source.assertOriginalBinding);
  } finally { runtime.shutdown(); }
});

test("Private question lifetime tail expiry retains original Text publication I/O", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let sends = 0;
  const { runtime } = confirmationHarness({ questionHeadTail: true, getTextInputReceiverBotId: () => 99,
    async sendChunk() { if (++sends === 1) { entered.resolve(); await release.promise; } return 100 + sends; } });
  try {
    const owner = runtime.captureQuestionLifetimeOwner!(); assert.ok(owner);
    const opening = openHeadTailQuestion(runtime, "text"); await entered.promise;
    owner.captureTail()(); let nextEnded = false;
    const next = openHeadTailQuestion(runtime, "confirmation"); void next.then(() => { nextEnded = true; });
    t.mock.timers.tick(3_600_000); const expired = await opening; assert.ok(!expired.ok); assert.equal(expired.reason, "expired");
    assert.equal(nextEnded, false); assert.equal(sends, 1);
    release.resolve(); const b = await next; assert.ok(b.ok); assert.equal(sends, 2);
  } finally { release.resolve(); runtime.shutdown(); }
});

for (const firstKind of ["confirmation", "choice", "text"] as const)
for (const nextKind of ["confirmation", "choice", "text"] as const) {
  if (firstKind === "text" && nextKind === "text") continue;
  test(`Private SDK head/tail demotes once from admission without history promotion (${firstKind}/${nextKind})`, async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
    const { runtime } = confirmationHarness({ questionHeadTail: true, getTextInputReceiverBotId: () => 99 });
    try {
      const a = await openHeadTailQuestion(runtime, firstKind); assert.ok(a.ok);
      let aEnded = false; void a.handle.result.then(() => { aEnded = true; });
      t.mock.timers.tick(2 * 3_600_000); await Promise.resolve(); assert.equal(aEnded, false);
      const controller = new AbortController(), b = await openHeadTailQuestion(runtime, nextKind, controller.signal); assert.ok(b.ok);
      t.mock.timers.tick(3_600_000 - 1); await Promise.resolve(); assert.equal(aEnded, false, "Tail starts at demotion, not first admission");
      controller.abort(); assert.deepEqual(await b.handle.result, { status: "aborted" });
      const c = await openHeadTailQuestion(runtime, "confirmation"); assert.ok(c.ok);
      let cEnded = false; void c.handle.result.then(() => { cEnded = true; });
      t.mock.timers.tick(1); await Promise.resolve(); assert.equal(aEnded, true);
      assert.deepEqual(await a.handle.result, { status: "expired" }); assert.equal(cEnded, false);
      const late = runtime.acceptConfirmation!(confirmationCallback(a.handle.id));
      assert.ok(late.handled && !late.accepted, "Historical controls are acknowledged without borrowing the new head");
    } finally { runtime.shutdown(); }
  });
}

for (const timeoutMs of [2 * 3_600_000 + 1000, 2_147_483_647])
test(`Private SDK head/tail never extends producer deadlines and caps the live head (${timeoutMs})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const { runtime } = confirmationHarness({ questionHeadTail: true });
  try {
    const a = await openHeadTailQuestion(runtime, "confirmation", undefined, timeoutMs); assert.ok(a.ok);
    let ended = false; void a.handle.result.then(() => { ended = true; });
    if (timeoutMs === 2_147_483_647) {
      t.mock.timers.tick(86_400_000); await Promise.resolve(); assert.equal(ended, true);
      assert.deepEqual(await a.handle.result, { status: "expired" });
    } else {
      t.mock.timers.tick(2 * 3_600_000);
      const b = await openHeadTailQuestion(runtime, "choice"); assert.ok(b.ok);
      t.mock.timers.tick(1000); await Promise.resolve(); assert.equal(ended, true);
      assert.deepEqual(await a.handle.result, { status: "expired" });
    }
  } finally { runtime.shutdown(); }
});

for (const boundary of ["target", "profile", "operator"] as const)
test(`Private SDK head/tail does not demote another original scope (${boundary})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  let profile = "first", operatorId = 42;
  const { runtime } = confirmationHarness({ questionHeadTail: true, getConfirmationAuthority: () => ({ profile, operatorId }) });
  try {
    const a = await openHeadTailQuestion(runtime, "confirmation"); assert.ok(a.ok);
    let ended = false; void a.handle.result.then(() => { ended = true; });
    if (boundary === "profile") profile = "second";
    if (boundary === "operator") operatorId = 43;
    const b = await openHeadTailQuestion(runtime, "choice", undefined, undefined,
      boundary === "target" ? { kind: "target", target: { chatId: 42, threadId: 8 } } : undefined); assert.ok(b.ok);
    t.mock.timers.tick(3_600_000 + 1); await Promise.resolve(); assert.equal(ended, false);
  } finally { runtime.shutdown(); }
});

test("Private SDK head/tail leaves rejected admission and Attachment lifetimes outside demotion", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const { runtime } = attachmentHarness({ questionHeadTail: true });
  try {
    const a = await openHeadTailQuestion(runtime, "confirmation"); assert.ok(a.ok);
    let ended = false; void a.handle.result.then(() => { ended = true; });
    const controller = new AbortController(); controller.abort();
    const rejected = await openHeadTailQuestion(runtime, "choice", controller.signal); assert.ok(!rejected.ok);
    const attachment = await runtime.openAttachmentQuestion!(attachmentQuestion()); assert.ok(attachment.ok);
    t.mock.timers.tick(3_600_000 + 1); await Promise.resolve(); assert.equal(ended, false);
    assert.deepEqual(await attachment.handle.result, { status: "expired" });
  } finally { runtime.shutdown(); }
});

test("Private SDK head/tail never gives a replaced Input a tail or releases its publication I/O", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let sends = 0;
  const { runtime } = confirmationHarness({ questionHeadTail: true, getTextInputReceiverBotId: () => 99,
    async sendChunk() { if (++sends === 1) { entered.resolve(); await release.promise; } return 100 + sends; } });
  try {
    const opening = openHeadTailQuestion(runtime, "text"); await entered.promise;
    let successorEnded = false;
    const successor = openHeadTailQuestion(runtime, "text"); void successor.then(() => { successorEnded = true; });
    const old = await opening; assert.ok(!old.ok); assert.equal(old.reason, "replaced");
    t.mock.timers.tick(3_600_000 + 1); await Promise.resolve(); assert.equal(successorEnded, false); assert.equal(sends, 1);
    release.resolve(); const b = await successor; assert.ok(b.ok); assert.equal(sends, 2);
  } finally { release.resolve(); runtime.shutdown(); }
});

test("Private SDK head/tail expires a demoted opening without releasing actual publication work", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let sends = 0;
  const { runtime } = confirmationHarness({ questionHeadTail: true, getTextInputReceiverBotId: () => 99,
    async sendChunk() { if (++sends === 1) { entered.resolve(); await release.promise; } return 100 + sends; } });
  try {
    const opening = openHeadTailQuestion(runtime, "text"); await entered.promise;
    let nextEnded = false;
    const next = openHeadTailQuestion(runtime, "confirmation"); void next.then(() => { nextEnded = true; });
    t.mock.timers.tick(3_600_000); const old = await opening; assert.ok(!old.ok); assert.equal(old.reason, "expired");
    assert.equal(nextEnded, false); assert.equal(sends, 1, "Logical tail expiry does not release the original I/O lane");
    release.resolve(); const head = await next; assert.ok(head.ok); assert.equal(sends, 2);
  } finally { release.resolve(); runtime.shutdown(); }
});

for (const rejection of ["abort", "render"] as const)
test(`Private SDK head/tail keeps its head when final preflight rejects (${rejection})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const controller = new AbortController();
  const { runtime, events } = confirmationHarness({ questionHeadTail: true,
    renderView(view) {
      if (view.text.includes("Reject")) {
        if (rejection === "abort") controller.abort();
        else return [{ text: "one", parseMode: "plain" }, { text: "two", parseMode: "plain" }];
      }
      return [{ text: view.text, parseMode: "html" }];
    } });
  try {
    const a = await openHeadTailQuestion(runtime, "confirmation"); assert.ok(a.ok);
    let ended = false; void a.handle.result.then(() => { ended = true; });
    t.mock.timers.tick(2 * 3_600_000);
    const rejected = await runtime.openChoice!({ ...choiceRequest(controller.signal), question: "Reject", timeoutMs: undefined });
    assert.ok(!rejected.ok); t.mock.timers.tick(3_600_000 + 1); await Promise.resolve();
    assert.equal(ended, false); assert.equal(events.filter(event => event.type === "send").length, 1);
  } finally { runtime.shutdown(); }
});

test("Private SDK head/tail fences an already-dequeued old expiry callback after demotion", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const timers = t.mock.method(globalThis, "setTimeout");
  const { runtime } = confirmationHarness({ questionHeadTail: true });
  try {
    const a = await openHeadTailQuestion(runtime, "confirmation"); assert.ok(a.ok);
    const stale = timers.mock.calls[0]!.arguments[0] as () => void;
    let ended = false; void a.handle.result.then(() => { ended = true; });
    const b = await openHeadTailQuestion(runtime, "choice"); assert.ok(b.ok);
    stale(); await Promise.resolve(); assert.equal(ended, false);
    t.mock.timers.tick(3_600_000); assert.deepEqual(await a.handle.result, { status: "expired" });
  } finally { runtime.shutdown(); }
});

test("Private SDK head/tail preserves the finite question capacity and does not demote on refusal", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const { runtime } = confirmationHarness({ questionHeadTail: true });
  try {
    let head: Awaited<ReturnType<typeof openHeadTailQuestion>> | undefined;
    for (let index = 0; index < 256; index++) { head = await openHeadTailQuestion(runtime, "confirmation"); assert.ok(head.ok); }
    const rejected = await openHeadTailQuestion(runtime, "choice"); assert.ok(!rejected.ok); assert.equal(rejected.reason, "capacity-exceeded");
    assert.ok(head?.ok); let ended = false; void head.handle.result.then(() => { ended = true; });
    t.mock.timers.tick(3_600_000); await Promise.resolve(); assert.equal(ended, false);
  } finally { runtime.shutdown(); }
});

test("Private SDK head/tail refuses invalid opt-in values without changing default policy", () => {
  for (const value of [false, null, "true", 1]) assert.throws(() => confirmationHarness({ questionHeadTail: value as true }), /policy must be true or omitted/u);
});

for (const enabled of [false, true])
test(`Private SDK head/tail captures opt-in once without runtime toggles (enabled=${enabled})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const { runtime, deps } = confirmationHarness(enabled ? { questionHeadTail: true } : {});
  deps.questionHeadTail = enabled ? undefined : true;
  try {
    const a = await openHeadTailQuestion(runtime, "confirmation"); assert.ok(a.ok);
    let ended = false; void a.handle.result.then(() => { ended = true; });
    const b = await openHeadTailQuestion(runtime, "choice"); assert.ok(b.ok);
    t.mock.timers.tick(3_600_000 + 1); await Promise.resolve(); assert.equal(ended, enabled);
  } finally { runtime.shutdown(); }
});

test("Private SDK head/tail never demotes a reentrant newer head from an older admission", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  let reenter = false, newest: ReturnType<typeof openHeadTailQuestion> | undefined;
  const { runtime } = confirmationHarness({ questionHeadTail: true, getTextInputReceiverBotId: () => 99,
    captureDrain: () => () => { if (reenter) { reenter = false; newest = openHeadTailQuestion(runtime, "choice"); } } });
  try {
    const a = await openHeadTailQuestion(runtime, "text"); assert.ok(a.ok);
    reenter = true; const b = await openHeadTailQuestion(runtime, "text"); assert.ok(b.ok && newest);
    const c = await newest; assert.ok(c.ok);
    assert.deepEqual(await a.handle.result, { status: "replaced" });
    let cEnded = false; void c.handle.result.then(() => { cEnded = true; });
    t.mock.timers.tick(3_600_000); assert.deepEqual(await b.handle.result, { status: "expired" });
    await Promise.resolve(); assert.equal(cEnded, false);
  } finally { runtime.shutdown(); }
});

for (const kind of ["confirmation", "choice", "text"] as const) {
  const open = (runtime: TelegramDeliveryRuntime, timeoutMs?: number) => {
    if (kind === "confirmation") {
      const request = confirmationRequest();
      if (timeoutMs === undefined) delete request.timeoutMs; else request.timeoutMs = timeoutMs;
      return openTelegramConfirm(request);
    }
    if (kind === "choice") {
      const request = choiceRequest();
      if (timeoutMs === undefined) delete request.timeoutMs; else request.timeoutMs = timeoutMs;
      return openTelegramChoice(request);
    }
    const request = textRequest();
    if (timeoutMs === undefined) delete request.timeoutMs; else request.timeoutMs = timeoutMs;
    return runtime.openTextInput!(request);
  };
  for (const explicit of [false, true])
  test(`SDK question lifetime keeps ${explicit ? "an explicit short deadline" : "the omitted 24-hour default"} (${kind})`, async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    const { runtime } = confirmationHarness();
    bindTelegramDeliveryRuntime(runtime);
    try {
      const opened = await open(runtime, explicit ? 25 : undefined);
      assert.ok(opened.ok);
      let settled = false;
      void opened.handle.result.then(() => { settled = true; });
      t.mock.timers.tick((explicit ? 25 : 86_400_000) - 1);
      await Promise.resolve();
      assert.equal(settled, false, "The original question stays open until its actual deadline");
      t.mock.timers.tick(1);
      assert.deepEqual(await opened.handle.result, { status: "expired" });
    } finally { runtime.shutdown(); clearTelegramDeliveryRuntime(); }
  });
  test(`SDK question lifetime refuses invalid explicit values rather than defaulting (${kind})`, async () => {
    const { runtime, events } = confirmationHarness();
    bindTelegramDeliveryRuntime(runtime);
    try {
      for (const timeoutMs of [null, 0, NaN, 2_147_483_648])
        await assert.rejects(open(runtime, timeoutMs as number), /timeoutMs must be an integer/);
      assert.equal(events.some(event => event.type === "send"), false);
    } finally { runtime.shutdown(); clearTelegramDeliveryRuntime(); }
  });
}

test("SDK question lifetime does not make Attachment timeout optional", () => {
  const { runtime, events } = attachmentHarness();
  const { timeoutMs, ...request } = attachmentQuestion();
  try {
    assert.equal(timeoutMs, 60_000);
    assert.throws(() => {
      // @ts-expect-error Attachment still requires its own explicit timeout.
      runtime.openAttachmentQuestion!(request);
    }, /Invalid Attachment question declaration/);
    assert.equal(events.some(event => event.type === "send"), false);
  } finally { runtime.shutdown(); }
});

function textReply(text = "Title", replyTo = 101): TelegramTextInputMessage {
  return { message_id: 202, from: { id: 42 }, chat: { id: 42 }, message_thread_id: 7, text,
    reply_to_message: { message_id: replyTo } };
}

function inputReplyEnvelope(requestId: string, replyMarkup: unknown = { inline_keyboard: [[{ text: "Cancel", callback_data: `tginput:${requestId}:cancel` }]] }) {
  return { ...textReply("private value"), reply_to_message: { message_id: 101, chat: { id: 42, type: "private" },
    message_thread_id: 7, from: { id: 99, is_bot: true }, reply_markup: replyMarkup } };
}

for (const threaded of [false, true]) for (const sameOwner of [false, true])
test(`Input replacement spends the original receiver and controls (Thread=${threaded}, sameOwner=${sameOwner})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const destination: TelegramTextInputReceiverIdentity["target"] = threaded ? target : { chatId: 42 };
  const controller = new AbortController();
  const { runtime, events } = confirmationHarness({ getInstanceTarget: () => destination, getTextInputReceiverBotId: () => 99 });
  try {
    const first = await runtime.openTextInput!(textRequest(controller.signal)); assert.ok(first.ok);
    const identity = { requestId: first.handle.id, messageId: 101, operatorId: 42, botId: 99, profile: "default", target: destination };
    const original = runtime.captureTextInputReceiver!(identity); assert.ok(original);
    let prior: unknown;
    void first.handle.result.then(result => { prior = result; });
    const second = await runtime.openTextInput!({ ...textRequest(), owner: sameOwner ? "@test/text" : "@other/input" });
    assert.ok(second.ok); await Promise.resolve();
    assert.deepEqual(prior, { status: "replaced" }); assert.ok(Object.isFrozen(prior));
    assert.throws(original.assertCurrent);
    assert.equal(runtime.captureTextInputReceiver!(identity), undefined);
    const oldReply = { ...textReply(), message_thread_id: destination.threadId };
    assert.deepEqual(runtime.acceptTextInputReply!(oldReply, first.handle.id), { handled: true, accepted: false, reason: "unavailable" });
    assert.deepEqual(runtime.acceptTextInputCancel!({ ...confirmationCallback(first.handle.id),
      message: { chat: { id: 42 }, message_thread_id: destination.threadId, message_id: 101 }, data: `tginput:${first.handle.id}:cancel` }),
    { handled: true, accepted: false, reason: "unavailable" });
    controller.abort();
    const fresh = { ...textReply("Fresh", 102), message_thread_id: destination.threadId };
    assert.deepEqual(runtime.acceptTextInputReply!(fresh, first.handle.id), { handled: true, accepted: false, reason: "invalid-source" });
    const accepted = runtime.acceptTextInputReply!(fresh, second.handle.id); assert.ok(accepted.handled && accepted.accepted);
    assert.deepEqual(await second.handle.result, { status: "submitted", text: "Fresh" });
    assert.throws(original.assertCurrent);
    await flushConfirmationEffects();
    assert.ok(events.some(event => event.type === "edit" && (event.chunk as { text: string }).text === "<b>ℹ️ Text input replaced.</b>"));
  } finally { runtime.shutdown(); }
});

test("Input replacement is target-confined and does not replace other question families", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const destination = { chatId: 42, threadId: 8 };
  let nextMessageId = 100;
  const sendChunk = async () => ++nextMessageId;
  const firstRuntime = confirmationHarness({ getTextInputReceiverBotId: () => 99, sendChunk }).runtime;
  const { runtime } = attachmentHarness({ getInstanceTarget: () => destination, getTextInputReceiverBotId: () => 99, sendChunk,
    publishAttachmentQuestion: async (_target, _chunk, options) => { options.assertAuthority?.(); return ++nextMessageId; } });
  try {
    const first = await firstRuntime.openTextInput!(textRequest()); assert.ok(first.ok);
    let firstEnded = false; void first.handle.result.then(() => { firstEnded = true; });
    const other = await runtime.openTextInput!(textRequest()); assert.ok(other.ok);
    let otherEnded = false; void other.handle.result.then(() => { otherEnded = true; });
    const confirm = await runtime.openConfirmation!(confirmationRequest()), choice = await runtime.openChoice!(choiceRequest());
    const attachment = await runtime.openAttachmentQuestion!(attachmentQuestion());
    assert.ok(confirm.ok && choice.ok && attachment.ok);
    const successor = await runtime.openTextInput!(textRequest()); assert.ok(successor.ok);
    await Promise.resolve(); assert.equal(firstEnded, false); assert.equal(otherEnded, true);
    assert.deepEqual(await other.handle.result, { status: "replaced" });
    const a = firstRuntime.acceptTextInputReply!(textReply("A"), first.handle.id); assert.ok(a.handled && a.accepted);
    const c = runtime.acceptConfirmation!({ ...confirmationCallback(confirm.handle.id, "yes", 103), message: { chat: { id: 42 }, message_thread_id: 8, message_id: 103 } });
    assert.ok(c.handled && c.accepted, "Opening Input does not replace Confirm");
    const pick = runtime.acceptChoice!({ ...choiceCallback(choice.handle.id, "0", 104), message: { chat: { id: 42 }, message_thread_id: 8, message_id: 104 } });
    assert.ok(pick.handled && pick.accepted, "Opening Input does not replace Choice");
    const cancel = runtime.acceptAttachmentCancel!({ from: { id: 42 }, message: { chat: { id: 42 }, message_thread_id: 8, message_id: 105 }, data: `tgattach:${attachment.handle.id}:cancel` });
    assert.ok(cancel.handled && cancel.accepted, "Opening Input does not replace Attachment");
  } finally { firstRuntime.shutdown(); runtime.shutdown(); }
});

test("Input replacement does not spend a predecessor on failed preflight", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let validRender = true;
  const { runtime } = confirmationHarness({ renderView: view => validRender ? [{ text: view.text, parseMode: "plain" }] : [] });
  try {
    const first = await runtime.openTextInput!(textRequest()); assert.ok(first.ok);
    let ended = false; void first.handle.result.then(() => { ended = true; });
    await assert.rejects(runtime.openTextInput!({ ...textRequest(), maxLength: 0 }), TypeError);
    const abort = new AbortController(); abort.abort();
    const aborted = await runtime.openTextInput!(textRequest(abort.signal)); assert.ok(!aborted.ok && aborted.reason === "aborted");
    validRender = false;
    const invalid = await runtime.openTextInput!(textRequest()); assert.ok(!invalid.ok && invalid.reason === "invalid-view");
    const denied = await runtime.openTextInput!({ ...textRequest(), scope: { kind: "target", target: { chatId: 43 } } });
    assert.ok(!denied.ok && denied.reason === "target-unauthorized");
    await Promise.resolve(); assert.equal(ended, false);
    validRender = true;
    const accepted = runtime.acceptTextInput!(textReply()); assert.ok(accepted.handled && accepted.accepted);
  } finally { runtime.shutdown(); }
});

test("Input replacement can reuse a waiting slot at full question capacity", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const { runtime } = confirmationHarness();
  try {
    const first = await runtime.openTextInput!(textRequest()); assert.ok(first.ok);
    for (let i = 0; i < 255; i++) assert.ok((await runtime.openConfirmation!(confirmationRequest())).ok);
    const second = await runtime.openTextInput!(textRequest()); assert.ok(second.ok);
    assert.deepEqual(await first.handle.result, { status: "replaced" });
    const excess = await runtime.openChoice!(choiceRequest());
    assert.ok(!excess.ok && excess.reason === "capacity-exceeded");
    const accepted = runtime.acceptTextInputReply!(textReply("Second", 357), second.handle.id);
    assert.ok(accepted.handled && accepted.accepted);
  } finally { runtime.shutdown(); }
});

for (const queued of [false, true])
test(`Input replacement ends an opening consumer without releasing actual publication work (queued=${queued})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const bodies: string[] = [];
  const { runtime } = confirmationHarness({ async sendChunk(_target, chunk) {
    bodies.push(chunk.text); if (bodies.length === 1) { entered.resolve(); await release.promise; }
    return 100 + bodies.length;
  } });
  const blocker = queued ? runtime.sendView({ text: "blocker" }, { scope: { kind: "instance" } }) : undefined;
  if (blocker) await entered.promise;
  const first = runtime.openTextInput!({ ...textRequest(), question: "First" });
  if (!queued) await entered.promise;
  let firstResult: unknown; void first.then(result => { firstResult = result; });
  const next = runtime.openTextInput!({ ...textRequest(), question: "Next" });
  try {
    await flushConfirmationEffects();
    assert.deepEqual(firstResult, { ok: false, reason: "replaced", message: "Question ended before opening completed." });
    assert.equal(runtime.hasPendingTarget!(target), true);
    assert.equal(bodies.length, 1, "Supersession cannot release the actual issued I/O lane");
    release.resolve(); await blocker;
    const second = await next; assert.ok(second.ok); await first;
    assert.deepEqual(bodies, queued ? ["blocker", "<b>Next</b>"] : ["<b>First</b>", "<b>Next</b>"]);
    if (!queued) assert.deepEqual(runtime.acceptTextInput!(textReply("Late", 101)), { handled: true, accepted: false, reason: "unavailable" });
    const accepted = runtime.acceptTextInputReply!(textReply("Next", 102), second.handle.id); assert.ok(accepted.handled && accepted.accepted);
    await flushConfirmationEffects(); assert.equal(runtime.hasPendingTarget!(target), false);
  } finally { release.resolve(); await blocker; runtime.shutdown(); }
});

test("Input replacement bounds superseded opening work until its actual queue drains", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let sends = 0;
  const { runtime } = confirmationHarness({ async sendChunk() { const id = 100 + ++sends; if (sends === 1) { entered.resolve(); await release.promise; } return id; } });
  const blocker = runtime.sendView({ text: "blocker" }, { scope: { kind: "instance" } }); await entered.promise;
  const openings: Array<ReturnType<NonNullable<TelegramDeliveryRuntime["openTextInput"]>>> = [];
  const results: unknown[] = [];
  try {
    for (let i = 0; i < 256; i++) {
      const opening = runtime.openTextInput!({ ...textRequest(), question: `Input ${i}` });
      openings.push(opening); void opening.then(result => { results[i] = result; });
    }
    await flushConfirmationEffects();
    assert.ok(results[0] && (results[0] as { reason: string }).reason === "replaced");
    const excessOpening = runtime.openTextInput!(textRequest());
    let excess: unknown; void excessOpening.then(result => { excess = result; });
    await flushConfirmationEffects();
    assert.deepEqual(excess, { ok: false, reason: "capacity-exceeded", message: "Too many questions are pending." });
    assert.equal(results[255], undefined, "A rejected successor does not replace the current opening Input");
    assert.equal(sends, 1);
    release.resolve(); await blocker;
    const settled = await Promise.all(openings), last = settled.at(-1)!; assert.ok(last.ok);
    assert.ok(settled.slice(0, -1).every(result => !result.ok && result.reason === "replaced"));
    assert.equal(sends, 2, "Unissued replaced questions cannot publish when the queue resumes");
    const accepted = runtime.acceptTextInputReply!(textReply("Latest", 102), last.handle.id); assert.ok(accepted.handled && accepted.accepted);
    await flushConfirmationEffects(); assert.equal(runtime.hasPendingTarget!(target), false);
    assert.ok((await runtime.openTextInput!(textRequest())).ok, "Actual drain releases the original capacity");
  } finally { release.resolve(); await blocker; runtime.shutdown(); }
});

test("Input replacement cannot revive an outer opening during drain-observer reentry", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const controller = new AbortController(), listener = t.mock.method(controller.signal, "addEventListener");
  let replaceOnDrain = false, inner: ReturnType<NonNullable<TelegramDeliveryRuntime["openTextInput"]>> | undefined;
  const { runtime, events } = confirmationHarness({ captureDrain: () => () => {
    if (replaceOnDrain) { replaceOnDrain = false; inner = runtime.openTextInput!({ ...textRequest(), question: "Inner" }); }
  } });
  try {
    const first = await runtime.openTextInput!(textRequest()); assert.ok(first.ok);
    replaceOnDrain = true;
    const outer = runtime.openTextInput!({ ...textRequest(controller.signal), question: "Outer" });
    assert.ok(inner);
    const result = await outer; assert.ok(!result.ok && result.reason === "replaced");
    const latest = await inner; assert.ok(latest.ok);
    assert.deepEqual(await first.handle.result, { status: "replaced" });
    assert.equal(listener.mock.calls.length, 0, "A spent outer request never attaches an abort listener after reentry");
    assert.equal(events.filter(event => event.type === "send").length, 2);
    const accepted = runtime.acceptTextInputReply!(textReply("Inner", 102), latest.handle.id); assert.ok(accepted.handled && accepted.accepted);
  } finally { runtime.shutdown(); }
});

for (const unknown of [false, true])
test(`Input replacement never restores a predecessor after failed successor publication (unknown=${unknown})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let sends = 0;
  const { runtime } = confirmationHarness({ async sendChunk() {
    if (++sends === 2) throw unknown ? new TelegramApiCommitUnknownError("uncertain", "sendMessage") : new Error("refused");
    return 100 + sends;
  } });
  try {
    const first = await runtime.openTextInput!(textRequest()); assert.ok(first.ok);
    let prior: unknown; void first.handle.result.then(result => { prior = result; });
    const failed = await runtime.openTextInput!(textRequest()); assert.ok(!failed.ok);
    assert.equal(failed.reason, unknown ? "commit-unknown" : "transport-failed");
    await Promise.resolve(); assert.deepEqual(prior, { status: "replaced" });
    assert.deepEqual(runtime.acceptTextInputReply!(textReply(), first.handle.id), { handled: true, accepted: false, reason: "unavailable" });
    await flushConfirmationEffects(); assert.equal(runtime.hasPendingTarget!(target), false);
    const fresh = await runtime.openTextInput!(textRequest()); assert.ok(fresh.ok);
    assert.deepEqual(runtime.acceptTextInputReply!(textReply("Old association", 103), first.handle.id), { handled: true, accepted: false, reason: "invalid-source" });
  } finally { runtime.shutdown(); }
});

test("Text Input receiver scope rejects foreign live targets without restricting ordinary output", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const other = { chatId: 42, threadId: 8 };
  const ownership = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => "default", listFollowers: () => [] });
  let sends = 0, ordinary = 0;
  const runtime = createTelegramBridgeDeliveryRuntime({ generation: "receiver-scope", getProfileName: () => "default",
    getTextInputReceiverBotId: () => 99, getActiveTurnTarget: () => other,
    getTargetPolicyView: () => ({ canDeliver: true, ownsDirect: true, threaded: true, allowedChatId: 42, leaderTarget: target, liveTargets: [target, other] }),
    captureInputPublication: ownership.captureLocalPublication, recordOwnership() { ordinary++; },
    api: { async sendMessage(_body, options) { options?.assertAuthority?.(); return { message_id: 100 + ++sends }; },
      async editMessageText() { return "edited"; }, async deleteMessage() {}, async sendChatAction() { return true; } },
  });
  try {
    assert.ok((await runtime.sendView({ text: "Ordinary output" }, { scope: { kind: "target", target: other } })).ok);
    assert.equal(ordinary, 1);
    for (const scope of [{ kind: "target" as const, target: other }, { kind: "active-turn" as const }]) {
      const opened = await runtime.openTextInput!({ ...textRequest(), scope });
      assert.ok(!opened.ok && opened.reason === "target-unauthorized", "Output authorization is not Input receiver authority");
    }
    assert.equal(sends, 1, "Neither explicit nor active-turn scope may publish an unowned Input");
    const own = await runtime.openTextInput!({ ...textRequest(), scope: { kind: "target", target } }); assert.ok(own.ok);
    assert.deepEqual(own.handle.target, target); assert.equal(sends, 2); assert.equal(ordinary, 1);
    assert.equal(ownership.store.getOriginal(42, 102)!.record.instanceId, "leader");
    assert.ok(runtime.captureTextInputReceiver!({ requestId: own.handle.id, messageId: 102, operatorId: 42, botId: 99, profile: "default", target }));
  } finally { runtime.shutdown(); }
});

for (const point of ["render", "drain"] as const)
test(`Text Input receiver scope rechecks after ${point} observation before spending its predecessor`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let current = { ...target }, interfere = false, sends = 0;
  const lose = () => { if (interfere) current = { chatId: 42, threadId: 8 }; };
  const { runtime } = confirmationHarness({ getInstanceTarget: () => current,
    renderView: view => { if (point === "render") lose(); return [{ text: view.text, parseMode: "html" }]; },
    captureDrain() { if (point === "drain") lose(); return () => {}; }, sendChunk: async () => 100 + ++sends });
  try {
    const first = await runtime.openTextInput!(textRequest()); assert.ok(first.ok);
    let prior: unknown; void first.handle.result.then(value => { prior = value; });
    interfere = true;
    const next = await runtime.openTextInput!(textRequest()); assert.ok(!next.ok && next.reason === "invalidated");
    await Promise.resolve(); assert.equal(prior, undefined, "Failed final preflight cannot spend its predecessor as replaced"); assert.equal(sends, 1);
    current = { ...target }; interfere = false;
    assert.deepEqual(runtime.acceptTextInputReply!(textReply(), first.handle.id), { handled: true, accepted: false, reason: "unavailable" });
    assert.deepEqual(await first.handle.result, { status: "invalidated" });
  } finally { runtime.shutdown(); }
});

for (const end of ["aborted", "expired", "aborted-in-observation", "expired-in-observation"] as const)
test(`Text Input receiver scope final preflight cannot replace a valid predecessor after ${end}`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const controller = new AbortController(); let interfere = false, finishInObservation = false, sends = 0;
  const terminate = () => { if (end.startsWith("aborted")) controller.abort(); else t.mock.timers.tick(2); };
  const { runtime } = confirmationHarness({ getConfirmationAuthority() {
    if (finishInObservation) { finishInObservation = false; terminate(); }
    return { profile: "default", operatorId: 42 };
  }, renderView: view => {
    if (interfere) { if (end.endsWith("-in-observation")) finishInObservation = true; else terminate(); }
    return [{ text: view.text, parseMode: "html" }];
  }, sendChunk: async () => 100 + ++sends });
  try {
    const first = await runtime.openTextInput!({ ...textRequest(), timeoutMs: 10_000 }); assert.ok(first.ok);
    interfere = true;
    const next = await runtime.openTextInput!({ ...textRequest(controller.signal), timeoutMs: 1 });
    assert.ok(!next.ok && next.reason === (end.startsWith("aborted") ? "aborted" : "expired"));
    assert.equal(sends, 1); interfere = false;
    const answer = runtime.acceptTextInputReply!(textReply(), first.handle.id); assert.ok(answer.handled && answer.accepted);
    assert.deepEqual(await first.handle.result, { status: "submitted", text: "Title" });
  } finally { runtime.shutdown(); }
});

for (const fault of ["missing", "throw", "callable"] as const)
test(`Text Input receiver scope refuses unproven instance authority (${fault})`, async () => {
  const read = () => { if (fault === "throw") throw new Error("private receiver details"); return fault === "missing" ? undefined : target; };
  const { runtime, deps, events } = confirmationHarness({ getInstanceTarget: read });
  if (fault === "callable") deps.getInstanceTarget = () => ({ ...target });
  try {
    const opened = await runtime.openTextInput!({ ...textRequest(), scope: { kind: "target", target } });
    assert.ok(!opened.ok && opened.reason === "target-unavailable");
    assert.doesNotMatch(opened.message, /private receiver details/);
    assert.equal(events.length, 0);
  } finally { runtime.shutdown(); }
});

for (const loss of ["move", "missing", "throw", "callable", "reentry"] as const)
test(`Text Input receiver scope loss is non-settling and cannot revive after restoration (${loss})`, async () => {
  let current: TelegramTextInputReceiverIdentity["target"] | undefined = { ...target }, throwing = false, nestedRefused = false, reenter: (() => void) | undefined;
  const read = () => { const nested = reenter; reenter = undefined; nested?.(); if (throwing) throw new Error("private receiver details"); return current; };
  const { runtime, deps } = confirmationHarness({ getInstanceTarget: read, getTextInputReceiverBotId: () => 99 });
  try {
    const opened = await runtime.openTextInput!(textRequest()); assert.ok(opened.ok);
    const guard = runtime.captureTextInputReceiver!({ requestId: opened.handle.id, messageId: 101, operatorId: 42, botId: 99, profile: "default", target });
    assert.ok(guard);
    let settled = false; void opened.handle.result.then(() => { settled = true; });
    if (loss === "move") current = { chatId: 42, threadId: 8 };
    if (loss === "missing") current = undefined;
    if (loss === "throw") throwing = true;
    if (loss === "callable") deps.getInstanceTarget = () => ({ ...target });
    if (loss === "reentry") reenter = () => { try { guard.assertCurrent(); } catch { nestedRefused = true; } };
    assert.throws(guard.assertCurrent);
    if (loss === "reentry") assert.equal(nestedRefused, true, "Caught nested receiver observation still poisons the outer scope");
    current = { ...target }; throwing = false; deps.getInstanceTarget = read;
    assert.throws(guard.assertCurrent);
    await Promise.resolve(); assert.equal(settled, false, "A receiving-side observation does not settle the SDK");
    assert.deepEqual(runtime.acceptTextInput!(textReply()), { handled: true, accepted: false, reason: "unavailable" });
    assert.deepEqual(await opened.handle.result, { status: "invalidated" });
  } finally { runtime.shutdown(); }
});

test("Text Input receiver scope does not restore an older question after a new target admission", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let current = { ...target };
  const { runtime } = confirmationHarness({ getInstanceTarget: () => current, getTextInputReceiverBotId: () => 99 });
  try {
    const first = await runtime.openTextInput!(textRequest()); assert.ok(first.ok);
    let prior: unknown; void first.handle.result.then(value => { prior = value; });
    current = { chatId: 42, threadId: 8 };
    const next = await runtime.openTextInput!(textRequest()); assert.ok(next.ok);
    await Promise.resolve(); assert.deepEqual(prior, { status: "invalidated" });
    current = { ...target };
    assert.deepEqual(runtime.acceptTextInputReply!(textReply(), first.handle.id), { handled: true, accepted: false, reason: "unavailable" });
  } finally { runtime.shutdown(); }
});

test("Text Input receiver scope keeps a known late publication inert after ownership movement", async () => {
  let current = { ...target };
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<number>();
  const { runtime } = confirmationHarness({ getInstanceTarget: () => current, async sendChunk() { entered.resolve(); return release.promise; } });
  const opening = runtime.openTextInput!(textRequest());
  try {
    await entered.promise; current = { chatId: 42, threadId: 8 }; release.resolve(101);
    const result = await opening; assert.ok(!result.ok && result.reason === "invalidated");
    current = { ...target };
    assert.deepEqual(runtime.acceptTextInput!(textReply()), { handled: true, accepted: false, reason: "unavailable" });
  } finally { release.resolve(101); await opening; runtime.shutdown(); }
});

for (const threaded of [false, true])
test(`Receiver capture observes exact live Text Input without reserving answers (Thread=${threaded})`, async () => {
  const receiverTarget = threaded ? target : { chatId: 42 };
  const { runtime, events } = confirmationHarness({ getInstanceTarget: () => receiverTarget, getTextInputReceiverBotId: () => 99 });
  try {
    const opened = await runtime.openTextInput!(textRequest());
    assert.ok(opened.ok);
    const identity: TelegramTextInputReceiverIdentity = { requestId: opened.handle.id, messageId: 101,
      operatorId: 42, botId: 99, profile: "default", target: { ...receiverTarget } };
    const first = runtime.captureTextInputReceiver!(identity), second = runtime.captureTextInputReceiver!(identity);
    assert.ok(first && second); assert.ok(Object.isFrozen(first));
    let settled = false;
    void opened.handle.result.then(() => { settled = true; });
    const before = events.length;
    for (const changed of [{ requestId: "f".repeat(32) }, { messageId: 102 }, { operatorId: 43 }, { botId: 98 },
      { profile: "other" }, { target: { chatId: 43 } }, { target: { chatId: 42, threadId: threaded ? 8 : 7 } }]) {
      assert.equal(runtime.captureTextInputReceiver!({ ...identity, ...changed }), undefined);
    }
    identity.requestId = "changed"; identity.target = { chatId: 999 };
    first.assertCurrent(); second.assertCurrent();
    await Promise.resolve();
    assert.equal(settled, false); assert.equal(events.length, before);
    const reply = { ...textReply(), message_thread_id: threaded ? 7 : undefined };
    assert.equal(runtime.acceptTextInputReply!({ ...reply, text: "\n" }, opened.handle.id).handled, true);
    first.assertCurrent();
    const accepted = runtime.acceptTextInputReply!(reply, opened.handle.id);
    assert.ok(accepted.handled && accepted.accepted);
    assert.deepEqual(await opened.handle.result, { status: "submitted", text: "Title" });
    assert.throws(first.assertCurrent); assert.throws(second.assertCurrent);
    accepted.assertCurrent(); // Feedback authority intentionally survives answer settlement.
    const duplicate = runtime.acceptTextInputReply!(reply, opened.handle.id);
    assert.ok(duplicate.handled && !duplicate.accepted);
    assert.equal(runtime.captureTextInputReceiver!({ ...identity, requestId: opened.handle.id, target: receiverTarget }), undefined);
  } finally { runtime.shutdown(); }
});

test("Receiver capture refuses missing bot proof, non-text kinds, opening and ambiguous publications", async () => {
  const legacy = confirmationHarness();
  const openedLegacy = await legacy.runtime.openTextInput!(textRequest());
  assert.ok(openedLegacy.ok);
  const identity = { requestId: openedLegacy.handle.id, messageId: 101, operatorId: 42, botId: 99, profile: "default", target };
  assert.equal(legacy.runtime.captureTextInputReceiver!(identity), undefined);
  assert.ok(legacy.runtime.acceptTextInput!(textReply()).handled, "Transportless legacy collector remains supported");
  legacy.runtime.shutdown();
  const gate = Promise.withResolvers<number>();
  let pendingId = "";
  const opening = confirmationHarness({ getTextInputReceiverBotId: () => 99, sendChunk: async (_target, _chunk, options) => {
    pendingId = options.replyMarkup!.inline_keyboard[0]![0]!.callback_data!.split(":")[1]!;
    return gate.promise;
  } });
  const pending = opening.runtime.openTextInput!(textRequest());
  await Promise.resolve(); await Promise.resolve();
  assert.ok(pendingId);
  assert.equal(opening.runtime.captureTextInputReceiver!({ ...identity, requestId: pendingId }), undefined);
  gate.resolve(101); assert.ok((await pending).ok); opening.runtime.shutdown();
  const { runtime } = attachmentHarness({ getTextInputReceiverBotId: () => 99, sendChunk: async () => 101 });
  try {
    const confirm = await runtime.openConfirmation!(confirmationRequest());
    const choice = await runtime.openChoice!(choiceRequest());
    assert.ok(confirm.ok && choice.ok);
    for (const handle of [confirm.handle, choice.handle]) assert.equal(runtime.captureTextInputReceiver!({ ...identity, requestId: handle.id }), undefined);
    const a = await runtime.openTextInput!(textRequest()), b = await runtime.openAttachmentQuestion!(attachmentQuestion());
    assert.ok(a.ok && b.ok);
    assert.equal(runtime.captureTextInputReceiver!({ ...identity, requestId: a.handle.id }), undefined);
    assert.equal(runtime.captureAttachmentReceiver!({ ...identity, requestId: b.handle.id }), undefined);
  } finally { runtime.shutdown(); }
});

for (const loss of ["deadline", "profile", "operator", "target", "bot", "readiness", "callable", "abort", "submit", "cancel", "shutdown"] as const)
test(`Receiver capture is non-settling and observed failure cannot revive (${loss})`, async t => {
  t.mock.timers.enable({ apis: ["Date"] });
  let profile = "default", operatorId = 42, authorized = true, bot: number | undefined = 99, drains = 0;
  const { runtime, events } = confirmationHarness({
    getConfirmationAuthority: () => ({ profile, operatorId }), isExplicitTargetAuthorized: () => authorized,
    getTextInputReceiverBotId: () => bot, captureDrain: () => () => { drains++; },
    renderView(view) { return [{ text: view.text, parseMode: "plain" }]; },
  });
  // A separate kernel below exercises replacement of the actual dependency object's callable.
  const controller = new AbortController();
  const opened = await runtime.openTextInput!(textRequest(controller.signal));
  assert.ok(opened.ok); await flushConfirmationEffects();
  const identity = { requestId: opened.handle.id, messageId: 101, operatorId: 42, botId: 99, profile: "default", target };
  const guard = runtime.captureTextInputReceiver!(identity); assert.ok(guard);
  let settled = false; void opened.handle.result.then(() => { settled = true; });
  const baseline = { events: events.length, drains };
  if (loss === "deadline") t.mock.timers.setTime(Date.now() + 1_001);
  if (loss === "profile") profile = "other";
  if (loss === "operator") operatorId = 43;
  if (loss === "target") authorized = false;
  if (loss === "bot") bot = 98;
  if (loss === "readiness") bot = undefined;
  if (loss === "abort") controller.abort();
  if (loss === "submit") runtime.acceptTextInput!(textReply());
  if (loss === "cancel") runtime.acceptTextInputCancel!({ ...confirmationCallback(opened.handle.id), data: `tginput:${opened.handle.id}:cancel` });
  if (loss === "shutdown") runtime.shutdown();
  if (loss === "callable") {
    const deps: TelegramDeliveryRuntimeDeps = { generation: "same", getActiveTurnTarget: () => target, getInstanceTarget: () => target,
      getAggregateTarget: () => target, isExplicitTargetAuthorized: () => true,
      getConfirmationAuthority: () => ({ profile: "default", operatorId: 42 }), getTextInputReceiverBotId: () => 99,
      renderView: view => [{ text: view.text, parseMode: "plain" }], sendChunk: async () => 101,
      editChunk: async () => {}, deleteMessage: async () => {}, sendChatAction: async () => {} };
    const other = createConcreteDeliveryRuntime(deps), request = await other.openTextInput!(textRequest()); assert.ok(request.ok);
    const captured = other.captureTextInputReceiver!({ ...identity, requestId: request.handle.id }); assert.ok(captured);
    const original = deps.getTextInputReceiverBotId;
    deps.getTextInputReceiverBotId = () => 99;
    assert.throws(captured.assertCurrent); deps.getTextInputReceiverBotId = original; assert.throws(captured.assertCurrent);
    other.shutdown(); runtime.shutdown(); return;
  }
  assert.throws(guard.assertCurrent);
  if (["deadline", "profile", "operator", "target", "bot", "readiness"].includes(loss)) {
    assert.equal(runtime.captureTextInputReceiver!(identity), undefined);
    await flushConfirmationEffects();
    assert.equal(settled, false); assert.equal(events.length, baseline.events); assert.equal(drains, baseline.drains);
    assert.equal(runtime.hasPendingTarget!(target), true, "Observation must retain the question and capacity");
    // No retirement was manufactured: after restoring observations the actual collector still owns settlement.
    if (loss === "deadline") t.mock.timers.setTime(Date.now() - 1_001);
    profile = "default"; operatorId = 42; authorized = true; bot = 99;
    assert.throws(guard.assertCurrent);
    const fresh = runtime.captureTextInputReceiver!(identity); assert.ok(fresh); fresh.assertCurrent();
    assert.ok(runtime.acceptTextInput!(textReply()).handled);
    assert.deepEqual(await opened.handle.result, { status: "submitted", text: "Title" });
  }
  runtime.shutdown();
});

test("Receiver capture and assertions never install or dispose timers/listeners, even past deadline", async t => {
  t.mock.timers.enable({ apis: ["Date"] });
  const controller = new AbortController();
  const { runtime, events } = confirmationHarness({ getTextInputReceiverBotId: () => 99 });
  const opened = await runtime.openTextInput!(textRequest(controller.signal)); assert.ok(opened.ok);
  await flushConfirmationEffects();
  const identity = { requestId: opened.handle.id, messageId: 101, operatorId: 42, botId: 99, profile: "default", target };
  const mocks = [t.mock.method(globalThis, "setTimeout"), t.mock.method(globalThis, "setInterval"),
    t.mock.method(globalThis, "clearTimeout"), t.mock.method(controller.signal, "addEventListener"),
    t.mock.method(controller.signal, "removeEventListener")];
  const before = events.length;
  const guard = runtime.captureTextInputReceiver!(identity); assert.ok(guard); guard.assertCurrent();
  t.mock.timers.setTime(Date.now() + 1_001);
  assert.throws(guard.assertCurrent); assert.equal(runtime.captureTextInputReceiver!(identity), undefined);
  await Promise.resolve();
  for (const mock of mocks) { assert.equal(mock.mock.callCount(), 0); mock.mock.restore(); }
  assert.equal(events.length, before); assert.equal(runtime.hasPendingTarget!(target), true);
  runtime.shutdown();
});

for (const observation of ["authority", "target", "bot"] as const)
test(`Receiver capture rechecks scope changes during ${observation} observation`, async () => {
  let armed = false, authorized = true, profile = "default";
  const { runtime, events } = confirmationHarness({
    getConfirmationAuthority() { if (armed && observation === "authority") authorized = false; return { profile, operatorId: 42 }; },
    isExplicitTargetAuthorized() { if (armed && observation === "target") profile = "other"; return authorized; },
    getTextInputReceiverBotId() { if (armed && observation === "bot") profile = "other"; return 99; },
  });
  const opened = await runtime.openTextInput!(textRequest()); assert.ok(opened.ok);
  const identity = { requestId: opened.handle.id, messageId: 101, operatorId: 42, botId: 99, profile: "default", target };
  const guard = runtime.captureTextInputReceiver!(identity); assert.ok(guard);
  let settled = false; void opened.handle.result.then(() => { settled = true; });
  const before = events.length;
  armed = true;
  assert.equal(runtime.captureTextInputReceiver!(identity), undefined); assert.throws(guard.assertCurrent);
  await Promise.resolve(); assert.equal(settled, false); assert.equal(events.length, before);
  armed = false; authorized = true; profile = "default";
  assert.throws(guard.assertCurrent); assert.ok(runtime.captureTextInputReceiver!(identity));
  runtime.shutdown();
});

test("Receiver capture snapshots caller identity before observing scope", async () => {
  let mutate = () => {};
  const { runtime } = confirmationHarness({ getTextInputReceiverBotId: () => { mutate(); return 99; } });
  const opened = await runtime.openTextInput!(textRequest()); assert.ok(opened.ok);
  const identity = { requestId: opened.handle.id, messageId: 101, operatorId: 42, botId: 99, profile: "default", target: { ...target } };
  mutate = () => { identity.requestId = "f".repeat(32); identity.messageId = 999; identity.target.chatId = 999; };
  const guard = runtime.captureTextInputReceiver!(identity); assert.ok(guard); guard.assertCurrent();
  assert.deepEqual(Object.keys(guard), ["assertCurrent"]);
  runtime.shutdown();
});

test("Attachment reply provenance minimizes own-bot hints and refuses cross-kind ambiguity without granting custody", () => {
  const id = "b".repeat(32), base = inputReplyEnvelope(id), message = { ...base, text: undefined, caption: "private file caption",
    document: { file_id: "private-file", file_name: "secret.txt" }, reply_to_message: { ...base.reply_to_message,
      reply_markup: { inline_keyboard: [[{ text: "Cancel", callback_data: `tgattach:${id}:cancel` }]] } } };
  const source = readTelegramAttachmentReplySource(message, 99);
  assert.deepEqual(source, { kind: "attachment", requestId: id, messageId: 101, target });
  assert.ok(source && Object.isFrozen(source) && source.kind === "attachment" && Object.isFrozen(source.target));
  assert.equal(JSON.stringify(source).includes("private"), false); assert.equal(JSON.stringify(source).includes("secret"), false);
  assert.equal(readTelegramTextInputReplySource(message, 99), undefined);
  for (const bot of [undefined, 0, 98, NaN]) assert.equal(readTelegramAttachmentReplySource(message, bot), undefined);
  assert.equal(readTelegramAttachmentReplySource({ ...message, reply_to_message: { ...message.reply_to_message, from: { id: 99, is_bot: false } } }, 99), undefined);
  for (const reply of [{ ...message.reply_to_message, message_id: 0 }, { ...message.reply_to_message, business_connection_id: "x" },
    { ...message.reply_to_message, reply_markup: { inline_keyboard: [[{ callback_data: "tgattach:malformed" }]] } },
    { ...message.reply_to_message, reply_markup: { inline_keyboard: [[{ callback_data: `tgattach:${id}:cancel` }, { callback_data: `tginput:${id}:cancel` }]] } }])
    assert.deepEqual(readTelegramAttachmentReplySource({ ...message, reply_to_message: reply }, 99), { kind: "unavailable" });
  const mixed = { ...message, reply_to_message: { ...message.reply_to_message, reply_markup: { inline_keyboard: [[
    { callback_data: `tgattach:${id}:cancel` }, { callback_data: `tginput:${id}:cancel` } ]] } } };
  assert.deepEqual(readTelegramTextInputReplySource(mixed, 99), { kind: "unavailable" });
  assert.equal(readTelegramAttachmentReplySource(inputReplyEnvelope(id), 99), undefined);
});

test("SDK reply provenance is a bounded own-bot hint, never a restored receiver", async () => {
  const id = "a".repeat(32), message = inputReplyEnvelope(id);
  const hint = readTelegramTextInputReplySource(message, 99);
  assert.deepEqual(hint, { kind: "text", requestId: id, messageId: 101, target });
  assert.ok(Object.isFrozen(hint)); assert.ok(hint?.kind === "text" && Object.isFrozen(hint.target));
  const { runtime } = confirmationHarness();
  assert.deepEqual(runtime.acceptTextInput!(message), { handled: false }, "A marker alone cannot revive a receiver");
  runtime.shutdown();
  for (const bot of [undefined, 98, NaN, 0]) assert.equal(readTelegramTextInputReplySource(message, bot), undefined);
  for (const value of [null, [], {}, { ...message, reply_to_message: { ...message.reply_to_message, from: { id: 99, is_bot: false } } },
    { ...message, reply_to_message: { ...message.reply_to_message, from: { id: 98, is_bot: true } } },
    inputReplyEnvelope(id, { inline_keyboard: [[{ text: "Other", callback_data: "other:value" }]] })]) {
    assert.equal(readTelegramTextInputReplySource(value, 99), undefined);
  }
  assert.equal(JSON.stringify(hint).includes("private value"), false);
  assert.deepEqual(readTelegramTextInputReplySource({ ...message, business_connection_id: "other" }, 99), { kind: "unavailable" });
});

test("Malformed, ambiguous and foreign-namespace own-bot input markers remain unavailable", () => {
  const id = "a".repeat(32), message = inputReplyEnvelope(id);
  for (const reply of [
    { ...message.reply_to_message, message_id: 0 },
    { ...message.reply_to_message, message_thread_id: -1 },
    { ...message.reply_to_message, chat: { id: 42, type: "supergroup" } },
    { ...message.reply_to_message, business_connection_id: "other" },
    { ...message.reply_to_message, guest_query_id: "guest" },
    { ...message.reply_to_message, ephemeral_message_id: 1 },
    { ...message.reply_to_message, reply_markup: { inline_keyboard: [[{ callback_data: "tginput:malformed" }]] } },
    { ...message.reply_to_message, reply_markup: { inline_keyboard: [[{ callback_data: `tginput:${id}:cancel` }, { callback_data: `tginput:${id}:cancel` }]] } },
  ]) assert.deepEqual(readTelegramTextInputReplySource({ ...message, reply_to_message: reply }, 99), { kind: "unavailable" });
});

test("Text Input terminal cleanup retains a status control across retirement expiry and reload", async t => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { runtime, events } = confirmationHarness(), opened = await runtime.openTextInput!(textRequest());
  assert.ok(opened.ok);
  runtime.acceptTextInput!(textReply());
  assert.deepEqual(await opened.handle.result, { status: "submitted", text: "Title" });
  await flushConfirmationEffects();
  const edit = events.find(event => event.type === "edit")!;
  const replyMarkup = (edit.options as { replyMarkup: TelegramInlineKeyboardMarkup }).replyMarkup;
  assert.equal(replyMarkup.inline_keyboard[0]![0]!.text, "ℹ️ Request status");
  const message = inputReplyEnvelope(opened.handle.id, replyMarkup);
  t.mock.timers.setTime(Date.now() + 3_600_001);
  assert.deepEqual(runtime.acceptTextInput!(message), { handled: false }, "Retirement is explicitly bounded");
  assert.equal(readTelegramTextInputReplySource(message, 99)?.kind, "text");
  runtime.shutdown();
  const replacement = confirmationHarness().runtime;
  assert.deepEqual(replacement.acceptTextInput!(message), { handled: false });
  assert.equal(readTelegramTextInputReplySource(message, 99)?.kind, "text", "Closed provenance is independent of the old kernel");
  replacement.shutdown();
});

test("Text Input marker survives retirement-capacity eviction without retaining answer text", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const { runtime } = confirmationHarness();
  let firstId = "";
  for (let i = 0; i < 513; i++) {
    const opened = await runtime.openTextInput!(textRequest());
    assert.ok(opened.ok);
    if (!i) firstId = opened.handle.id;
    runtime.acceptTextInput!(textReply("value", 101 + i));
    assert.deepEqual(await opened.handle.result, { status: "submitted", text: "value" });
  }
  const message = inputReplyEnvelope(firstId);
  assert.deepEqual(runtime.acceptTextInput!(message), { handled: false });
  assert.equal(readTelegramTextInputReplySource(message, 99)?.kind, "text");
  runtime.shutdown();
});

test("Private Text Input snapshots limits and returns exact text without interpreting commands", async () => {
  const { runtime, events } = confirmationHarness(), request = textRequest();
  const opened = await runtime.openTextInput!(request);
  assert.ok(opened.ok);
  request.maxLength = 1; request.multiline = true; request.question = "changed";
  assert.ok(Object.isFrozen(opened.handle)); assert.ok(Object.isFrozen(opened.handle.target));
  const send = events.find(event => event.type === "send")!;
  assert.equal((send.chunk as { text: string }).text, "<b>Report &lt;title&gt;?</b>");
  const keyboard = (send.options as { replyMarkup: TelegramInlineKeyboardMarkup }).replyMarkup;
  assert.equal(keyboard.inline_keyboard[0]![0]!.callback_data, `tginput:${opened.handle.id}:cancel`);
  const accepted = runtime.acceptTextInput!(textReply("  /quit  "));
  assert.ok(accepted.handled && accepted.accepted);
  if (accepted.handled && accepted.accepted) {
    assert.equal("callbackData" in accepted, false); accepted.assertCurrent();
  }
  const value = await opened.handle.result;
  assert.deepEqual(value, { status: "submitted", text: "  /quit  " }); assert.ok(Object.isFrozen(value));
  assert.deepEqual(runtime.acceptTextInput!(textReply("Again")), { handled: true, accepted: false, reason: "unavailable" });
  assert.throws(() => runtime.acceptTextInput!(textReply(), () => { throw new Error("Retired source ended"); }), /Retired source ended/);
  assert.deepEqual(runtime.acceptTextInputCancel!({ ...confirmationCallback(opened.handle.id), data: `tginput:${opened.handle.id}:cancel` }),
    { handled: true, accepted: false, reason: "unavailable" });
  runtime.shutdown();
});

test("Private Text Input captures limits before renderer and authority observations", async () => {
  const request = textRequest();
  const { runtime } = confirmationHarness({ renderView(view) {
    request.maxLength = 1; request.multiline = true;
    return [{ text: view.text, parseMode: "html" }];
  } });
  const opened = await runtime.openTextInput!(request);
  assert.ok(opened.ok);
  assert.deepEqual(runtime.acceptTextInput!(textReply("a\nb")), { handled: true, accepted: false, reason: "invalid-answer" });
  runtime.acceptTextInput!(textReply("Title"));
  assert.deepEqual(await opened.handle.result, { status: "submitted", text: "Title" });
  runtime.shutdown();
});

test("Private Text Input only matches an exact published reply, actor and Thread", async () => {
  const { runtime } = confirmationHarness(), opened = await runtime.openTextInput!(textRequest());
  assert.ok(opened.ok);
  assert.deepEqual(runtime.acceptTextInput!({ ...textReply(), reply_to_message: undefined }), { handled: false });
  assert.deepEqual(runtime.acceptTextInput!(textReply("Other", 999)), { handled: false });
  assert.deepEqual(runtime.acceptTextInput!({ ...textReply(), chat: { id: 43 } }), { handled: false });
  for (const message of [{ ...textReply(), from: { id: 43 } }, { ...textReply(), message_thread_id: 8 },
    { ...textReply(), message_id: 0 }, { ...textReply(), from: undefined },
    { ...textReply(), business_connection_id: "business" }, { ...textReply(), guest_query_id: "guest" },
    { ...textReply(), ephemeral_message_id: 1 }]) {
    assert.deepEqual(runtime.acceptTextInput!(message), { handled: true, accepted: false, reason: "invalid-source" });
  }
  assert.throws(() => runtime.acceptTextInput!(textReply(), () => { throw new Error("Source ended"); }), /Source ended/);
  assert.ok(runtime.acceptTextInput!(textReply()).handled);
  assert.deepEqual(await opened.handle.result, { status: "submitted", text: "Title" });
  runtime.shutdown();
});

test("Private Text Input refuses invalid/edited/media answers without consuming the question", async () => {
  const { runtime } = confirmationHarness(), opened = await runtime.openTextInput!({ ...textRequest(), maxLength: 3 });
  assert.ok(opened.ok);
  for (const message of [textReply(""), textReply("  "), textReply("long"), textReply("a\nb"), textReply("\ud800"),
    textReply("a\u0000"), { ...textReply("ok"), edit_date: 123 }, { ...textReply("ok"), caption: "secret" },
    { ...textReply("ok"), document: {} }, { ...textReply("ok"), photo: [] }, { ...textReply("ok"), media_group_id: "album" }]) {
    assert.deepEqual(runtime.acceptTextInput!(message), { handled: true, accepted: false, reason: "invalid-answer" });
  }
  assert.deepEqual(runtime.acceptTextInput!(textReply("ok"), undefined, true),
    { handled: true, accepted: false, reason: "invalid-answer" });
  runtime.acceptTextInput!(textReply("yes"));
  assert.deepEqual(await opened.handle.result, { status: "submitted", text: "yes" });
  runtime.shutdown();
});

test("Private multiline Text Input preserves whitespace and inclusive maximum", async () => {
  const { runtime } = confirmationHarness();
  const opened = await runtime.openTextInput!({ ...textRequest(), maxLength: 16_384, multiline: true });
  assert.ok(opened.ok);
  const text = " \t\n" + "x".repeat(16_381);
  assert.equal(runtime.acceptTextInput!(textReply(text + "x")).handled, true);
  assert.ok(runtime.acceptTextInput!(textReply(text)).handled);
  assert.deepEqual(await opened.handle.result, { status: "submitted", text });
  runtime.shutdown();
});

test("Text Input cancellation is exact and cannot consume a different question kind", async () => {
  const { runtime } = confirmationHarness();
  const choice = await runtime.openChoice!(choiceRequest()), input = await runtime.openTextInput!(textRequest());
  assert.ok(choice.ok && input.ok);
  assert.deepEqual(runtime.acceptTextInputCancel!({ ...confirmationCallback(choice.handle.id), data: `tginput:${choice.handle.id}:cancel` }),
    { handled: true, accepted: false, reason: "unavailable" });
  assert.deepEqual(runtime.acceptTextInputCancel!({ ...confirmationCallback(input.handle.id), data: `tginput:${input.handle.id}:yes` }),
    { handled: true, accepted: false, reason: "unavailable" });
  assert.deepEqual(runtime.acceptTextInputCancel!({ data: "other" }), { handled: false });
  const query = { ...confirmationCallback(input.handle.id, "", 102), data: `tginput:${input.handle.id}:cancel` };
  const decision = runtime.acceptTextInputCancel!(query);
  assert.ok(decision.handled && decision.accepted);
  assert.deepEqual(await input.handle.result, { status: "cancelled" });
  runtime.acceptChoice!(choiceCallback(choice.handle.id));
  assert.deepEqual(await choice.handle.result, { status: "selected", choiceId: "json" });
  runtime.shutdown();
});

for (const ending of ["abort", "expiry", "shutdown", "profile", "operator", "target"] as const) {
test(`Private Text Input invalidates waiting and retires its reply identity (${ending})`, async t => {
  t.mock.timers.enable({ apis: ["Date"] });
  let current = true;
  const controller = new AbortController(), { runtime } = confirmationHarness({
    getConfirmationAuthority: () => ({ profile: ending === "profile" && !current ? "other" : "default",
      operatorId: ending === "operator" && !current ? 43 : 42 }),
    isExplicitTargetAuthorized: () => ending !== "target" || current,
  });
  const opened = await runtime.openTextInput!(textRequest(controller.signal));
  assert.ok(opened.ok);
  if (ending === "abort") controller.abort();
  else if (ending === "expiry") t.mock.timers.setTime(Date.now() + 1000);
  else if (ending === "shutdown") runtime.shutdown();
  else current = false;
  const result = runtime.acceptTextInput!(textReply());
  assert.ok(result.handled && !result.accepted);
  assert.deepEqual(await opened.handle.result, { status: ending === "abort" ? "aborted" : ending === "expiry" ? "expired" : "invalidated" });
  assert.deepEqual(runtime.acceptTextInput!(textReply()), { handled: true, accepted: false, reason: "unavailable" });
  runtime.shutdown();
});
}

for (const ending of ["abort-queued", "expire-queued", "abort-issued", "unknown-send", "cleanup-fails"] as const) {
test(`Private Text Input shares queue and inert publication semantics (${ending})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), controller = new AbortController();
  let sends = 0, edits = 0;
  const { runtime } = confirmationHarness({
    async sendChunk() { sends++; entered.resolve();
      if (ending === "unknown-send") throw new TelegramApiCommitUnknownError("uncertain", "sendMessage");
      if (ending !== "cleanup-fails") await release.promise;
      return 101; },
    async editChunk() { edits++; if (ending === "cleanup-fails") throw new Error("cleanup refused"); },
  });
  const blocker = ending.endsWith("queued") ? runtime.sendView({ text: "blocker" }, { scope: { kind: "instance" } }) : undefined;
  if (blocker) await entered.promise;
  const opening = runtime.openTextInput!(textRequest(controller.signal));
  if (ending === "abort-issued") await entered.promise;
  if (ending.startsWith("abort")) controller.abort();
  if (ending === "expire-queued") t.mock.timers.tick(1000);
  const opened = await opening;
  if (ending === "cleanup-fails") {
    assert.ok(opened.ok); runtime.acceptTextInput!(textReply());
    assert.deepEqual(await opened.handle.result, { status: "submitted", text: "Title" });
  } else {
    assert.equal(opened.ok, false);
    if (!opened.ok) assert.equal(opened.reason, ending === "unknown-send" ? "commit-unknown" : ending === "expire-queued" ? "expired" : "aborted");
  }
  release.resolve(); await blocker; await flushConfirmationEffects();
  assert.equal(sends, 1, "Unknown or blocked publication never replays");
  if (ending === "abort-issued" || ending === "cleanup-fails") {
    assert.equal(edits, 1); assert.deepEqual(runtime.acceptTextInput!(textReply()), { handled: true, accepted: false, reason: "unavailable" });
  }
  runtime.shutdown();
});
}

test("Input replacement cannot borrow a retired publication identity or edit its controls", async () => {
  const { runtime, events } = confirmationHarness({ async sendChunk() { return 101; } });
  try {
    const first = await runtime.openTextInput!(textRequest()); assert.ok(first.ok);
    const second = await runtime.openTextInput!({ ...textRequest(), owner: "@other" });
    assert.ok(!second.ok && second.reason === "invalidated");
    assert.deepEqual(await first.handle.result, { status: "replaced" });
    assert.deepEqual(runtime.acceptTextInput!(textReply()), { handled: true, accepted: false, reason: "unavailable" });
    await flushConfirmationEffects();
    const edits = events.filter(event => event.type === "edit"); assert.equal(edits.length, 1);
    const markup = (edits[0]!.options as { replyMarkup: TelegramInlineKeyboardMarkup }).replyMarkup;
    assert.equal(markup.inline_keyboard[0]![0]!.callback_data, `tginput:${first.handle.id}:cancel`);
  } finally { runtime.shutdown(); }
});

test("Private Text Input rechecks owner loss inside source validation without exposing an answer", async () => {
  let profile = "default";
  const { runtime } = confirmationHarness({ getConfirmationAuthority: () => ({ profile, operatorId: 42 }) });
  const opened = await runtime.openTextInput!(textRequest());
  assert.ok(opened.ok);
  const result = runtime.acceptTextInput!(textReply(), () => { profile = "replacement"; });
  assert.ok(result.handled && !result.accepted);
  assert.deepEqual(await opened.handle.result, { status: "invalidated" });
  runtime.shutdown();
});

test("Private Text Input cannot accept before publication and retires a known late message", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), controller = new AbortController();
  let data = "";
  const { runtime } = confirmationHarness({ async sendChunk(_target, _chunk, options) {
    data = options.replyMarkup!.inline_keyboard[0]![0]!.callback_data!;
    entered.resolve(); await release.promise; return 101;
  } });
  const opening = runtime.openTextInput!(textRequest(controller.signal));
  await entered.promise;
  assert.deepEqual(runtime.acceptTextInput!(textReply()), { handled: false });
  assert.deepEqual(runtime.acceptTextInputCancel!({ ...confirmationCallback(""), data }),
    { handled: true, accepted: false, reason: "unavailable" });
  controller.abort();
  assert.ok(!(await opening).ok);
  release.resolve(); await flushConfirmationEffects();
  assert.deepEqual(runtime.acceptTextInput!(textReply()), { handled: true, accepted: false, reason: "unavailable" });
  runtime.shutdown();
});

function inputReadinessHarness(direct = true, threaded = false, missing = false) {
  const target = { chatId: 42, ...(threaded ? { threadId: 7 } : {}) };
  const state = { botId: 777 as unknown, sends: 0, pins: 0, edits: 0, queries: 0,
    onApi: undefined as (() => void) | undefined, afterApi: undefined as (() => void) | undefined };
  const deps: Parameters<typeof createTelegramBridgeDeliveryRuntime>[0] = {
    generation: "input-readiness", getProfileName: () => "default",
    ...(missing ? {} : { getTextInputReceiverBotId(candidate: Readonly<typeof target>) {
      state.queries++; assert.ok(Object.isFrozen(candidate)); assert.deepEqual(candidate, target); return state.botId as number | undefined;
    } }),
    getTargetPolicyView: () => ({ canDeliver: true, ownsDirect: direct, allowedChatId: 42,
      ...(threaded ? direct ? { leaderTarget: target } : { followerTarget: target } : {}) }),
    getActiveTurnTarget: () => undefined, recordOwnership() {}, captureInputPublication: () => () => { state.pins++; },
    api: { async sendMessage(_body, options) { state.onApi?.(); (options?.assertAuthority ?? options?.assertLocalAuthority)?.();
      state.sends++; state.afterApi?.(); return { message_id: 101 }; },
    async editMessageText(_body, options) { (options?.assertAuthority ?? options?.assertLocalAuthority)?.(); state.edits++; return "edited"; },
    async deleteMessage() {}, async sendChatAction() { return true; } },
  };
  return { deps, state, runtime: createTelegramBridgeDeliveryRuntime(deps) };
}

for (const direct of [false, true]) for (const threaded of [false, true]) for (const readiness of ["ready", "missing", "unavailable"] as const) {
test(`Text Input requires a configured ready receiver before publication (direct=${direct}, Thread=${threaded}, ${readiness})`, async () => {
  const { runtime, state } = inputReadinessHarness(direct, threaded, readiness === "missing");
  if (readiness === "unavailable") state.botId = undefined;
  try {
    const opened = await runtime.openTextInput!(textRequest());
    assert.equal(opened.ok, readiness === "ready");
    if (!opened.ok) assert.equal(opened.reason, "runtime-unavailable");
    assert.equal(state.sends, readiness === "ready" ? 1 : 0);
    assert.equal(state.pins, readiness === "ready" ? 1 : 0);
  } finally { runtime.shutdown(); }
});
}

test("Text Input receiver identity rejects invalid IDs and unavailable observations without API calls", async () => {
  for (const botId of [null, "777", true, 0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    const { runtime, state } = inputReadinessHarness(); state.botId = botId;
    try { const result = await runtime.openTextInput!(textRequest()); assert.ok(!result.ok); assert.equal(state.sends, 0); }
    finally { runtime.shutdown(); }
  }
  const { deps, runtime } = inputReadinessHarness(); runtime.shutdown();
  deps.getTextInputReceiverBotId = () => { throw new Error("observer details"); };
  const failed = createTelegramBridgeDeliveryRuntime(deps);
  try { const result = await failed.openTextInput!(textRequest()); assert.ok(!result.ok); assert.doesNotMatch(result.message, /observer details/); }
  finally { failed.shutdown(); }
});

for (const phase of ["before", "after", "waiting"] as const) for (const changed of [undefined, 778]) {
test(`Text Input retains receiver bot identity across publication and answers (${phase}, bot=${changed})`, async () => {
  const { runtime, state } = inputReadinessHarness(true, true);
  if (phase === "before") state.onApi = () => { state.botId = changed; };
  if (phase === "after") state.afterApi = () => { state.botId = changed; };
  try {
    const result = await runtime.openTextInput!(textRequest());
    if (phase === "waiting") {
      assert.ok(result.ok); state.botId = changed;
      const accepted = runtime.acceptTextInput!(textReply()); assert.ok(accepted.handled && !accepted.accepted);
      assert.deepEqual(await result.handle.result, { status: "invalidated" });
      state.botId = 777; const late = runtime.acceptTextInput!(textReply()); assert.ok(late.handled && !late.accepted);
      await flushConfirmationEffects();
    } else {
      assert.ok(!result.ok); assert.equal(result.reason, phase === "before" ? "runtime-unavailable" : "commit-unknown");
      assert.equal(state.pins, 0);
    }
    assert.equal(state.sends, phase === "before" ? 0 : 1); assert.equal(state.edits, 0);
  } finally { runtime.shutdown(); }
});
}

test("Text Input keeps captured query identity and cannot borrow replacement readiness", async () => {
  const { deps, runtime, state } = inputReadinessHarness(); state.botId = undefined;
  deps.getTextInputReceiverBotId = () => 777;
  try { const result = await runtime.openTextInput!(textRequest()); assert.ok(!result.ok); assert.equal(state.sends, 0); }
  finally { runtime.shutdown(); }
});

test("Reserved SDK markup cannot bypass the Bridge receiver readiness gate", async () => {
  const { runtime, state } = inputReadinessHarness(true, false, true);
  try {
    const result = await runtime.sendView({ text: "Question?", replyMarkup: { inline_keyboard: [[
      { text: "Cancel", callback_data: `tginput:${"a".repeat(32)}:cancel` },
    ]] } }, { scope: { kind: "instance" } });
    assert.ok(!result.ok); assert.equal(state.sends, 0); assert.equal(state.pins, 0);
  } finally { runtime.shutdown(); }
});

for (const kind of ["confirmation", "choice", "view"] as const) {
test(`Private receiver readiness does not gate existing ${kind}`, async () => {
  const { runtime, state } = inputReadinessHarness(true, false, true);
  try {
    const opened = kind === "confirmation" ? await runtime.openConfirmation!(confirmationRequest()) :
      kind === "choice" ? await runtime.openChoice!(choiceRequest()) : await runtime.sendView({ text: "ordinary" }, { scope: { kind: "instance" } });
    assert.ok(opened.ok); assert.equal(state.sends, 1); assert.equal(state.queries, 0); assert.equal(state.pins, 0);
  } finally { runtime.shutdown(); }
});
}

for (const sdk of [false, true]) for (const phase of ["before", "returned", "issued"] as const) {
test(`Input-only publication uncertainty preserves issuance provenance (SDK=${sdk}, ${phase})`, async () => {
  let active = true, issued = 0;
  const ownership = createTelegramBusMessageOwnershipRuntime({ instanceId: "local", getProfileKey: () => "default", listFollowers: () => [] });
  const runtime = createTelegramBridgeDeliveryRuntime({ generation: "uncertainty", getProfileName: () => "default", getTextInputReceiverBotId: () => 777, isTransportActive: () => active,
    getTargetPolicyView: () => ({ canDeliver: true, ownsDirect: true, allowedChatId: 42 }), getActiveTurnTarget: () => undefined,
    recordOwnership() {}, captureInputPublication: ownership.captureLocalPublication,
    api: { async sendMessage() {
      if (phase === "before") throw new TelegramApiAuthorityError(false);
      issued++;
      if (phase === "issued") throw new TelegramApiAuthorityError(true);
      active = false; return { message_id: 501 };
    }, async editMessageText() { return "edited"; }, async deleteMessage() {}, async sendChatAction() { return true; } },
  });
  const result = sdk ? await runtime.openTextInput!(textRequest()) : await runtime.sendView({ text: "ordinary" }, { scope: { kind: "instance" } });
  assert.ok(!result.ok);
  assert.equal(result.reason, sdk && phase !== "before" ? "commit-unknown" : phase === "returned" ? "runtime-unavailable" : "transport-failed");
  assert.equal(issued, phase === "before" ? 0 : 1);
  assert.equal(ownership.store.getOriginal(42, 501), undefined);
  runtime.shutdown();
});
}

for (const threaded of [false, true])
for (const outcome of ["known", "missing-hook", "origin-profile-lost", "native-profile-lost", "bot-lost", "mode-lost", "callable-lost", "duplicate", "unknown-send", "rejected", "pre-issue-refused", "bad-receipt", "follower"] as const)
test(`Attachment direct publication owns native receipt before receiver opening (Thread=${threaded}, ${outcome})`, async () => {
  const destination = { chatId: 42, ...(threaded ? { threadId: 7 } : {}) };
  let profile = "default", originProfile = "default", bot: number | undefined = 777, requests = 0, direct = outcome !== "follower";
  const ownership = createTelegramBusMessageOwnershipRuntime({ instanceId: "attachment-local", getProfileKey: () => originProfile, listFollowers: () => [] });
  if (outcome === "duplicate") ownership.recordLocal({ chatId: 42, messageId: 501, target: destination });
  const previousFetch = globalThis.fetch, bodies: Record<string, unknown>[] = [];
  let changeCallable = () => {};
  globalThis.fetch = async (_url, init) => {
    requests++; bodies.push(JSON.parse(String(init?.body)));
    if (outcome === "unknown-send") throw new Error("Connection lost after issuance");
    if (outcome === "rejected") return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: fixture rejected" }), { status: 400 });
    if (outcome === "origin-profile-lost") originProfile = "other";
    if (outcome === "native-profile-lost") profile = "other";
    if (outcome === "bot-lost") bot = 778;
    if (outcome === "mode-lost") direct = false;
    if (outcome === "callable-lost") changeCallable();
    return new Response(JSON.stringify({ ok: true, result: { message_id: outcome === "bad-receipt" ? 0 : 501 } }));
  };
  const restoreHttps = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
  const native = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:attachment-publication"), tempDir: "/tmp",
    maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
  const api = createTelegramBusAwareApiRuntime({ directRuntime: native, ownsDirect: () => true,
    async callFollowerApi() { assert.fail("Attachment publication cannot silently use follower IPC"); } });
  const send = api.sendMessage;
  if (outcome === "pre-issue-refused") api.sendMessage = (body, options) => { bot = undefined; return send.call(api, body, options); };
  const deps = { generation: "attachment-publication", getProfileName: () => profile, getAttachmentReceiverBotId: () => bot,
    getTargetPolicyView: () => ({ canDeliver: true, ownsDirect: direct, allowedChatId: 42,
      ...(!direct ? { followerTarget: destination } : threaded ? { leaderTarget: destination } : {}) }),
    getActiveTurnTarget: () => undefined, api, recordOwnership() { assert.fail("Attachment publication cannot upgrade ordinary ownership"); },
    ...(outcome !== "missing-hook" ? { captureInputPublication: ownership.captureLocalPublication } : {}) };
  changeCallable = () => { deps.getAttachmentReceiverBotId = () => 777; };
  const runtime = createTelegramBridgeDeliveryRuntime(deps);
  try {
    const result = await runtime.openAttachmentQuestion!(attachmentQuestion());
    if (outcome === "known") {
      assert.ok(result.ok); const original = ownership.store.getOriginal(42, 501)!;
      assert.equal(original.record.instanceId, "attachment-local"); assert.equal(original.record.profileKey, "default");
      assert.deepEqual(original.record.target, destination); assert.ok(Object.isFrozen(original.record));
      const guard = runtime.captureAttachmentReceiver!({ requestId: result.handle.id, messageId: 501, operatorId: 42,
        botId: 777, profile: "default", target: destination }); assert.ok(guard); guard.assertCurrent();
      assert.equal((bodies[0]!.reply_markup as TelegramInlineKeyboardMarkup).inline_keyboard[0]![0]!.callback_data, `tgattach:${result.handle.id}:cancel`);
      assert.equal(bodies[0]!.message_thread_id, destination.threadId);
    } else {
      assert.ok(!result.ok);
      assert.equal(result.reason, outcome === "missing-hook" || outcome === "rejected" || outcome === "pre-issue-refused" ? "transport-failed"
        : outcome === "follower" ? "runtime-unavailable" : "commit-unknown");
      assert.equal(ownership.store.getOriginal(42, 501), undefined);
    }
    assert.equal(requests, outcome === "missing-hook" || outcome === "follower" || outcome === "pre-issue-refused" ? 0 : 1, "Unknown native issuance never retries");
  } finally { runtime.shutdown(); restoreHttps(); globalThis.fetch = previousFetch; }
});

for (const kind of ["confirmation", "choice", "text"] as const)
test(`Non-Attachment question rejects an Attachment publication-shaped transport result (${kind})`, async () => {
  const { runtime } = confirmationHarness({ async sendChunk() { return { messageId: 501, assertCurrent() {} } as unknown as number; } });
  try {
    const result = kind === "confirmation" ? await runtime.openConfirmation!(confirmationRequest()) : kind === "choice" ? await runtime.openChoice!(choiceRequest()) : await runtime.openTextInput!(textRequest());
    assert.ok(!result.ok); assert.equal(result.reason, "transport-failed");
  } finally { runtime.shutdown(); }
});

for (const threaded of [false, true])
for (const fault of ["known", "known-long-endpoint", "missing-transport", "missing-pinner", "bare-pinner", "origin-lost", "scope-lost", "bot-mismatch", "unknown", "ordinary-ack", "duplicate", "capture-lost", "waiting-stop", "waiting-rebind", "waiting-reentry"] as const)
test(`Attachment consumer pins native follower publication before exposing exact receiver (Thread=${threaded}, ${fault})`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pt-attach-consumer-")), socketPath = join(dir, ...(fault === "known-long-endpoint" ? ["long-context-".repeat(12)] : []), "bus.sock"), destination = { chatId: 42, ...(threaded ? { threadId: 7 } : {}) };
  const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "consumer", capabilities: [TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION, TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION] });
  const registry = createTelegramBusFollowerRegistry(), state = createTelegramBusFollowerRegistrationState(); let sequence = 0, sends = 0, originProfile = "default", bot = 777, nonce = "", pins = 0;
  const leaderOwnership = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => "default", listFollowers: registry.list });
  const consumerOwnership = createTelegramBusMessageOwnershipRuntime({ instanceId: "consumer", getProfileKey: () => originProfile, listFollowers: () => [] });
  if (fault === "duplicate") consumerOwnership.recordLocal({ chatId: 42, messageId: 501, target: destination });
  const registration = createTelegramBusFollowerRegistrationRuntime({ instanceId: "consumer", registrationState: state, protocolIdentity: protocol,
    createRequestId: () => `registration:${++sequence}`, getProfileKey: () => "manual:attachment", getSessionId: () => "session", getSessionGeneration: () => 1,
    getPid: () => 101, getProcessBirthId: () => "birth", followerBusSocketPath: join(dir, "receiver.sock"), getLeaderAuthSecret: () => "secret", heartbeatMs: 60_000 });
  const previousFetch = globalThis.fetch;
  let loseCapture = () => {}, reenter = false, receiverReentry = () => {};
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)); assert.equal(body.chat_id, 42); assert.equal(body.message_thread_id, destination.threadId); sends++;
    nonce = body.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
    if (fault === "unknown") throw new Error("lost HTTP receipt");
    if (fault === "origin-lost") originProfile = "replacement";
    if (fault === "scope-lost") registration.stop();
    if (fault === "bot-mismatch") bot = 778;
    if (fault === "capture-lost") loseCapture();
    return new Response(JSON.stringify({ ok: true, result: { message_id: 501 } }));
  };
  const restore = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
  const native = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:consumer"), tempDir: dir, maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
  const proxy = createTelegramBusLeaderApiProxy({ call: native.call, callMultipart: native.callMultipart, downloadFile: native.downloadFile });
  const handler = createTelegramBusLeaderEnvelopeHandler({ followerRegistry: registry, protocolIdentity: protocol, authSecret: "secret", getCurrentLeaderEpoch: () => 1,
    getTelegramProfile: () => "default", getAllowedUserId: () => 42, provisionFollowerTarget: () => ({ ...destination, ...(threaded ? { slot: "A" } : {}) }),
    authorizeFollowerApiCall: createTelegramFollowerApiCallAuthorizer({ isMessageOwned: leaderOwnership.isOwnedByFollower }),
    getAttachmentReceiverBotId: () => 777, captureInputPublication: leaderOwnership.captureFollowerPublication,
    callApi: proxy, recordFollowerMessageOwnership() { assert.fail("Protected origin cannot use ordinary ownership"); } });
  const server = createTelegramBusLocalServer({ socketPath, async handleEnvelope(envelope) {
    const response = await handler(envelope);
    if (fault === "ordinary-ack" && envelope.kind === "follower.callApi" && response?.kind === "bus.ack" && response.result)
      delete (response.result as Record<string, unknown>)[TELEGRAM_BUS_ATTACHMENT_PUBLICATION_RECEIPT];
    return response;
  } });
  const caller = createTelegramBusFollowerApiCaller({ socketPath, instanceId: "consumer", createRequestId: () => `api:${++sequence}`,
    getAuthSecret: () => "secret", getRegistrationGeneration: state.getGeneration, getLocalProtocol: () => protocol, getLeaderProtocol: state.getLeaderProtocol,
    captureAttachmentPublicationRegistration: registration.captureAttachmentPublicationRegistration });
  const busDeps = { directRuntime: native, ownsDirect: () => false, callFollowerApi: caller,
    ...(fault === "missing-transport" ? {} : { captureAttachmentPublicationRegistration: registration.captureAttachmentPublicationRegistration }) };
  const api = createTelegramBusAwareApiRuntime(busDeps);
  const capture = api.captureAttachmentPublication!;
  let publication: ReturnType<typeof capture>;
  api.captureAttachmentPublication = target => { publication = capture.call(api, target); return publication; };
  // Cleanup projection is outside this publication proof; it never issues a second HTTP operation.
  api.editMessageText = async () => "edited"; api.deleteMessage = async () => {};
  api.sendMessage = async () => { assert.fail("Follower Attachment cannot fall back to generic sendMessage"); };
  loseCapture = () => { busDeps.captureAttachmentPublicationRegistration = () => registration.captureAttachmentPublicationRegistration?.(); };
  const runtime = createTelegramBridgeDeliveryRuntime({ generation: "consumer", getProfileName: () => "default", getAttachmentReceiverBotId: () => {
    if (reenter) { try { receiverReentry(); } catch {} } return bot; },
    getTargetPolicyView: () => ({ canDeliver: true, ownsDirect: false, allowedChatId: 42, followerTarget: destination }), getActiveTurnTarget: () => undefined,
    api, recordOwnership() { assert.fail("Consumer cannot upgrade ordinary provenance"); },
    ...(fault === "missing-pinner" ? {} : { captureInputPublication: fault === "bare-pinner" ? () => (_id: number) => assert.fail("Bare origin is not a scope") : (target: typeof destination) => {
      const native = consumerOwnership.captureLocalPublication(target);
      return Object.freeze(Object.assign((messageId: number) => {
        const identity = { requestId: nonce, messageId, operatorId: 42, botId: 777, profile: "default", target: destination };
        assert.equal(runtime.captureAttachmentReceiver!(identity), undefined, "No receiver before native consumer pin");
        native(messageId); pins++;
        assert.equal(runtime.captureAttachmentReceiver!(identity), undefined, "Pin is not itself receiver exposure");
      }, { assertCurrent: native.assertCurrent }));
    } }) });
  try {
    await server.start(); assert.equal(await registration.registerWithLeader({ cwd: "/repo" }, { busSocketPath: socketPath }), true);
    const result = await runtime.openAttachmentQuestion!(attachmentQuestion());
    if (["known", "known-long-endpoint", "waiting-stop", "waiting-rebind", "waiting-reentry"].includes(fault)) {
      assert.ok(result.ok); assert.ok(leaderOwnership.store.getOriginal(42, 501)); assert.ok(consumerOwnership.store.getOriginal(42, 501));
      assert.equal(consumerOwnership.store.getOriginal(42, 501)!.record.instanceId, "consumer"); assert.equal(pins, 1);
      const identity = { requestId: result.handle.id, messageId: 501, operatorId: 42, botId: 777, profile: "default", target: destination };
      const receiver = runtime.captureAttachmentReceiver!(identity); assert.ok(receiver); receiver.assertCurrent();
      if (fault === "known" || fault === "known-long-endpoint") await assert.rejects(publication!.publish({ chat_id: 42, text: "Repeat", ...((threaded) ? { message_thread_id: 7 } : {}),
        reply_markup: { inline_keyboard: [[{ text: "Cancel", callback_data: `tgattach:${nonce}:cancel` }]] } }, () => {}),
        error => error instanceof TelegramApiAuthorityError && !error.requestIssued);
      if (fault !== "known" && fault !== "known-long-endpoint") {
        let settled = false; void result.handle.result.then(() => { settled = true; });
        if (fault === "waiting-reentry") { receiverReentry = receiver.assertCurrent; reenter = true; }
        else if (fault === "waiting-stop") registration.stop();
        else state.setRegistered(true, destination, { generation: state.getGeneration(), sessionId: "session", leaderProtocol: protocol, ...(threaded ? { slot: "A" } : {}) });
        assert.throws(receiver.assertCurrent); assert.equal(runtime.captureAttachmentReceiver!(identity), undefined);
        await Promise.resolve(); assert.equal(settled, false, "Receiver scope observation does not settle the question");
      }
    } else { assert.ok(!result.ok); assert.equal(consumerOwnership.store.getOriginal(42, 501), undefined); assert.equal(pins, 0);
      assert.equal(result.reason, fault === "missing-transport" ? "runtime-unavailable" : ["missing-pinner", "bare-pinner"].includes(fault) ? "transport-failed" : "commit-unknown"); }
    assert.equal(sends, ["missing-transport", "missing-pinner", "bare-pinner"].includes(fault) ? 0 : 1);
  } finally { runtime.shutdown(); registration.stop(); await server.stop(); restore(); globalThis.fetch = previousFetch; await rm(dir, { recursive: true, force: true }); }
});

test("Attachment direct publisher remains closed in production-shaped defaults and cannot use generic sendView", async () => {
  let requests = 0;
  const runtime = createTelegramBridgeDeliveryRuntime({ generation: "attachment-closed", getProfileName: () => "default",
    getTargetPolicyView: () => ({ canDeliver: true, ownsDirect: true, allowedChatId: 42 }), getActiveTurnTarget: () => undefined,
    recordOwnership() {}, api: { async sendMessage() { requests++; return { message_id: 501 }; }, async editMessageText() { return "edited"; }, async deleteMessage() {}, async sendChatAction() { return true; } } });
  try {
    const opened = await runtime.openAttachmentQuestion!(attachmentQuestion()); assert.ok(!opened.ok); assert.equal(opened.reason, "runtime-unavailable");
    const sent = await runtime.sendView({ text: "Unowned question", replyMarkup: { inline_keyboard: [[{ text: "Cancel", callback_data: `tgattach:${"a".repeat(32)}:cancel` }]] } }, { scope: { kind: "instance" } });
    assert.ok(!sent.ok); assert.equal(requests, 0);
  } finally { runtime.shutdown(); }
});

for (const direct of [false, true]) for (const threaded of [false, true]) for (const loss of ["transport", "receiver", "bot"] as const) {
test(`Native post-issued UI authority loss stays unknown without a receiver (direct=${direct}, Thread=${threaded}, ${loss})`, async () => {
  let active = true, requests = 0, inputBot: number | undefined = 777;
  const target = { chatId: 42, ...(threaded ? { threadId: 7 } : {}) }, errors: unknown[] = [];
  const ownership = createTelegramBusMessageOwnershipRuntime({ instanceId: "local", getProfileKey: () => "default", listFollowers: () => [] });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { requests++; if (loss === "transport") active = false; else inputBot = loss === "receiver" ? undefined : 778;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 501 } })); };
  const restoreHttps = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
  const native = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:uncertainty-fixture"), tempDir: "/tmp",
    maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
  const proxy = createTelegramBusLeaderApiProxy({ call: native.call, callMultipart: native.callMultipart, downloadFile: native.downloadFile });
  const api = createTelegramBusAwareApiRuntime({ directRuntime: native, ownsDirect: () => direct,
    callFollowerApi: (method, args) => proxy(method, structuredClone(args)) });
  const runtime = createTelegramBridgeDeliveryRuntime({ generation: "native-uncertainty", getProfileName: () => "default", getTextInputReceiverBotId: () => inputBot, isTransportActive: () => active,
    getTargetPolicyView: () => ({ canDeliver: true, ownsDirect: direct, allowedChatId: 42,
      ...(threaded ? direct ? { leaderTarget: target } : { followerTarget: target } : {}) }),
    getActiveTurnTarget: () => undefined, api, recordOwnership() {}, captureInputPublication: ownership.captureLocalPublication,
    recordFailure(_operation, error) { errors.push(error); } });
  try {
    const result = await runtime.openTextInput!(textRequest());
    assert.ok(!result.ok); assert.equal(result.reason, "commit-unknown"); assert.equal(requests, 1);
    assert.equal(ownership.store.getOriginal(42, 501), undefined);
    const error = errors.find(error => error instanceof TelegramApiCommitUnknownError);
    assert.ok(error instanceof TelegramApiCommitUnknownError && error.cause instanceof TelegramApiAuthorityError && error.cause.requestIssued);
    assert.equal(error.method, "sendMessage");
  } finally { runtime.shutdown(); restoreHttps(); globalThis.fetch = previousFetch; }
});
}

for (const direct of [false, true]) for (const threaded of [false, true]) {
test(`Private Input publication uses native API and pins both broker/consumer receipts (direct=${direct}, Thread=${threaded})`, async () => {
  const target = { chatId: 42, ...(threaded ? { threadId: 7 } : {}) };
  const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION] });
  const registry = createTelegramBusFollowerRegistry();
  registry.register({ instanceId: "follower", registrationGeneration: "g1", connectedAtMs: 1, profileKey: "manual:recipient",
    sessionId: "session", sessionGeneration: 1, pid: 101, processBirthId: "birth", cwd: "/repo", busSocketPath: "/endpoint",
    protocol, ...(threaded ? { target } : {}) });
  const parent = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => "default", listFollowers: registry.list });
  const consumer = createTelegramBusMessageOwnershipRuntime({ instanceId: direct ? "leader" : "follower", getProfileKey: () => "default", listFollowers: () => [] });
  const previousFetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response(JSON.stringify({ ok: true, result: { message_id: 501 } })); };
  const restoreHttps = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
  const native = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:input-fixture"),
    tempDir: "/tmp", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
  const proxy = createTelegramBusLeaderApiProxy({ call: native.call, callMultipart: native.callMultipart, downloadFile: native.downloadFile });
  const handle = createTelegramBusLeaderEnvelopeHandler({ followerRegistry: registry, protocolIdentity: protocol, callApi: proxy,
    captureInputPublication: parent.captureFollowerPublication, getTextInputReceiverBotId: () => 777 });
  const api = createTelegramBusAwareApiRuntime({ directRuntime: native, ownsDirect: () => direct,
    async callFollowerApi(method, args, localOptions) {
      localOptions?.assertAuthority?.();
      const ack = await handle({ kind: "follower.callApi", instanceId: "follower", registrationGeneration: "g1", requestId: "input",
        method, args: structuredClone(args), sentAtMs: Date.now() });
      assert.ok(ack.kind === "bus.ack" && ack.ok);
      assert.equal(parent.store.getOriginal(42, 501)!.record.ownerGeneration, "g1", "Parent pin precedes the caller ACK");
      localOptions?.assertAuthority?.();
      return ack.result;
    },
  });
  const runtime = createTelegramBridgeDeliveryRuntime({ generation: "native-input", getProfileName: () => "default", getTextInputReceiverBotId: () => 777,
    getTargetPolicyView: () => ({ canDeliver: true, ownsDirect: direct, allowedChatId: 42,
      ...(threaded ? direct ? { leaderTarget: target } : { followerTarget: target } : {}) }),
    getActiveTurnTarget: () => undefined, api, recordOwnership() { assert.fail("SDK pin is not an ordinary projection"); },
    captureInputPublication: consumer.captureLocalPublication });
  try {
    const opened = await runtime.openTextInput!(textRequest()); assert.ok(opened.ok);
    assert.equal(consumer.store.getOriginal(42, 501)!.record.instanceId, direct ? "leader" : "follower");
    assert.deepEqual(consumer.store.getOriginal(42, 501)!.record.target, target);
    assert.equal(requests, 1);
  } finally { runtime.shutdown(); restoreHttps(); globalThis.fetch = previousFetch; }
});
}

for (const threaded of [false, true]) for (const outcome of ["known", "missing-hook", "profile-lost", "duplicate", "unknown-send", "bad-receipt"] as const) {
test(`Text Input bridge pins its first known publication before opening (Thread=${threaded}, ${outcome})`, async () => {
  let profile = "default", sends = 0;
  const target = { chatId: 42, ...(threaded ? { threadId: 7 } : {}) };
  const ownership = createTelegramBusMessageOwnershipRuntime({ instanceId: "instance", getProfileKey: () => profile, listFollowers: () => [] });
  if (outcome === "duplicate") ownership.recordLocal({ chatId: 42, messageId: 501, target });
  const runtime = createTelegramBridgeDeliveryRuntime({ generation: "input-publication", getProfileName: () => "default", getTextInputReceiverBotId: () => 777,
    getTargetPolicyView: () => ({ canDeliver: true, ownsDirect: true, allowedChatId: 42, ...(threaded ? { leaderTarget: target } : {}) }),
    getActiveTurnTarget: () => undefined, recordOwnership() { assert.fail("Input publication must not use ordinary recording"); },
    ...(outcome !== "missing-hook" ? { captureInputPublication: ownership.captureLocalPublication } : {}),
    api: { async sendMessage(_body, options) {
      options?.assertAuthority?.(); sends++;
      if (outcome === "unknown-send") throw new TelegramApiCommitUnknownError("sendMessage", new Error("uncertain"));
      if (outcome === "profile-lost") profile = "other";
      return { message_id: outcome === "bad-receipt" ? 0 : 501 };
    }, async editMessageText() { return "edited"; }, async deleteMessage() {}, async sendChatAction() { return true; } },
  });
  const opened = await runtime.openTextInput!(textRequest());
  if (outcome === "known") {
    assert.ok(opened.ok);
    assert.equal(ownership.store.getOriginal(42, 501)!.record.instanceId, "instance");
    assert.deepEqual(ownership.store.getOriginal(42, 501)!.record.target, target);
  } else {
    assert.ok(!opened.ok);
    assert.equal(opened.reason, outcome === "missing-hook" ? "transport-failed" : "commit-unknown");
    if (outcome === "profile-lost") profile = "default";
    assert.equal(ownership.store.getOriginal(42, 501), undefined);
  }
  assert.equal(sends, outcome === "missing-hook" ? 0 : 1, "Publication is never blindly replayed");
  runtime.shutdown();
});
}

for (const direct of [false, true]) for (const threaded of [false, true]) for (const replace of [false, true]) {
test(`Bridge private Text Input keeps concrete target and transport lifetime (direct=${direct}, Thread=${threaded}, replace=${replace})`, async () => {
  const target = { chatId: 42, ...(threaded ? { threadId: 7 } : {}) };
  let current = true, writes = 0;
  const runtime = createTelegramBridgeDeliveryRuntime({
    generation: "text-bridge", getProfileName: () => "default", getTextInputReceiverBotId: () => 777, isTransportActive: () => current,
    captureInputPublication: () => () => {},
    getTargetPolicyView: () => ({ canDeliver: true, ownsDirect: direct, allowedChatId: 42,
      ...(threaded ? direct ? { leaderTarget: target } : { followerTarget: target } : {}) }),
    getActiveTurnTarget: () => undefined, recordOwnership() {},
    api: {
      async sendMessage(body, options) {
        assert.equal(typeof (direct ? options?.assertAuthority : options?.assertLocalAuthority), "function");
        (options?.assertAuthority ?? options?.assertLocalAuthority)?.();
        assert.equal(body.chat_id, 42); assert.equal(body.message_thread_id, target.threadId);
        writes++; return { message_id: 101 };
      },
      async editMessageText(_body, options) { (options?.assertAuthority ?? options?.assertLocalAuthority)?.(); writes++; return "edited"; },
      async deleteMessage() {}, async sendChatAction() { return true; },
    },
  });
  const opened = await runtime.openTextInput!(textRequest());
  assert.ok(opened.ok); assert.deepEqual(opened.handle.target, target);
  if (replace) current = false;
  const accepted = runtime.acceptTextInput!({ ...textReply(), message_thread_id: target.threadId });
  assert.equal(accepted.handled && accepted.accepted, !replace);
  assert.deepEqual(await opened.handle.result, replace ? { status: "invalidated" } : { status: "submitted", text: "Title" });
  await flushConfirmationEffects();
  assert.equal(writes, replace ? 1 : 2);
  runtime.shutdown();
});
}

test("Private Text Input validates before transport and shares the bounded pending pool", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const { runtime, events } = confirmationHarness(), base = textRequest();
  for (const request of [{ ...base, maxLength: 0 }, { ...base, maxLength: 16_385 }, { ...base, maxLength: 1.5 },
    { ...base, maxLength: null }, { ...base, multiline: null },
    { ...base, multiline: "yes" }, { ...base, scope: { kind: "aggregate" } }]) {
    await assert.rejects(() => runtime.openTextInput!(request as TelegramTextInputRequest), TypeError);
  }
  assert.equal(events.length, 0);
  const pending = await runtime.openTextInput!({ ...base, maxLength: 1 });
  assert.ok(pending.ok);
  for (let i = 0; i < 255; i++) assert.ok((await runtime.openConfirmation!(confirmationRequest())).ok);
  const excess = await runtime.openChoice!(choiceRequest());
  assert.ok(!excess.ok && excess.reason === "capacity-exceeded");
  runtime.shutdown();
  assert.deepEqual(await pending.handle.result, { status: "invalidated" });
});

function choiceRequest(signal = new AbortController().signal): TelegramChoiceRequest {
  return { owner: "@test/formats", scope: { kind: "instance" }, question: "Choose <format> & destination?",
    choices: [{ id: "json", label: "JSON", style: "primary" }, { id: "csv", label: "CSV", disabled: true }],
    cancelLabel: "❌ Cancel", timeoutMs: 1_000, signal };
}

function choiceCallback(id: string, value = "0", messageId = 101): TelegramDeliveryConfirmationCallback {
  return { ...confirmationCallback(id, "", messageId), data: `tgchoice:${id}:${value}` };
}

test("Delivery Choice snapshots declared values, shares the lifecycle and never borrows native mapping", async () => {
  const { runtime, events } = confirmationHarness();
  const request = { ...choiceRequest(), confirmedData: "quit:confirm", cancelledData: "new:confirm" };
  const choices = [{ id: "new:confirm", label: "Start-looking value", style: "success" as const },
    { id: "disabled", label: "Unavailable", disabled: true }];
  request.choices = choices;
  const opened = await runtime.openChoice!(request);
  assert.ok(opened.ok);
  choices[0]!.id = "changed"; choices[0]!.label = "changed"; choices[1]!.disabled = false;
  request.cancelLabel = "changed"; request.question = "changed"; request.signal = new AbortController().signal;
  assert.equal(Object.isFrozen(opened.handle), true);
  assert.equal(Object.isFrozen(opened.handle.target), true);
  assert.equal(runtime.hasPendingTarget!(target), true);
  const sent = events.find(event => event.type === "send")!;
  assert.equal((sent.chunk as { text: string }).text, "<b>Choose &lt;format&gt; &amp; destination?</b>");
  const keyboard = (sent.options as { replyMarkup: TelegramInlineKeyboardMarkup }).replyMarkup.inline_keyboard;
  assert.deepEqual(keyboard.map(row => row.map(button => button.text)), [["Start-looking value"], ["Unavailable"], ["❌ Cancel"]]);
  assert.deepEqual(keyboard[1]![0]!.disabled, {});
  assert.equal(keyboard[1]![0]!.callback_data, undefined);
  for (const row of keyboard) for (const button of row)
    if (button.callback_data) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  assert.deepEqual(runtime.acceptChoice!(choiceCallback(opened.handle.id, "1")), { handled: true, accepted: false });
  assert.deepEqual(runtime.acceptConfirmation!(confirmationCallback(opened.handle.id)), { handled: true, accepted: false });
  const accepted = runtime.acceptChoice!(choiceCallback(opened.handle.id));
  assert.equal(accepted.handled && accepted.accepted, true);
  assert.equal("callbackData" in accepted, false);
  assert.deepEqual(await opened.handle.result, { status: "selected", choiceId: "new:confirm" });
  assert.equal(Object.isFrozen(await opened.handle.result), true);
  assert.deepEqual(runtime.acceptChoice!(choiceCallback(opened.handle.id)), { handled: true, accepted: false });
  await flushConfirmationEffects();
  assert.equal(runtime.hasPendingTarget!(target), false);
  assert.equal(events.filter(event => event.type === "edit").length, 1);
  runtime.shutdown();
});

test("Delivery Choice rejects actor/target/message/source and malformed or disabled controls without consuming a valid choice", async () => {
  const { runtime } = confirmationHarness(), opened = await runtime.openChoice!(choiceRequest());
  assert.ok(opened.ok);
  const query = choiceCallback(opened.handle.id);
  for (const value of [
    { ...query, from: { id: 43 } },
    { ...query, message: { ...query.message, chat: { id: 43 } } },
    { ...query, message: { ...query.message, message_thread_id: 8 } },
    { ...query, message: { ...query.message, message_thread_id: undefined } },
    { ...query, message: { ...query.message, message_id: 102 } },
    ...["01", "-1", "64", "1", "0:extra", "yes"].map(value => choiceCallback(opened.handle.id, value)),
  ]) assert.deepEqual(runtime.acceptChoice!(value), { handled: true, accepted: false });
  assert.throws(() => runtime.acceptChoice!(query, () => { throw new Error("Stale source"); }), /Stale source/u);
  const confirmation = await runtime.openConfirmation!(confirmationRequest());
  assert.ok(confirmation.ok);
  assert.deepEqual(runtime.acceptChoice!(choiceCallback(confirmation.handle.id)), { handled: true, accepted: false });
  runtime.acceptChoice!(choiceCallback(opened.handle.id, "cancel"));
  assert.deepEqual(await opened.handle.result, { status: "cancelled" });
  runtime.shutdown();
});

for (const ending of ["abort", "expiry", "shutdown", "profile", "operator", "target"] as const) {
test(`Delivery Choice settles one terminal outcome on ${ending}`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let current = true;
  const controller = new AbortController();
  const { runtime } = confirmationHarness({
    getConfirmationAuthority: () => ({ profile: ending === "profile" && !current ? "other" : "default",
      operatorId: ending === "operator" && !current ? 43 : 42 }),
    isExplicitTargetAuthorized: () => ending !== "target" || current,
  });
  const opened = await runtime.openChoice!(choiceRequest(controller.signal));
  assert.ok(opened.ok);
  if (ending === "abort") controller.abort();
  else if (ending === "expiry") t.mock.timers.setTime(Date.now() + 1_000);
  else if (ending === "shutdown") runtime.shutdown();
  else current = false;
  assert.deepEqual(runtime.acceptChoice!(choiceCallback(opened.handle.id)), { handled: true, accepted: false });
  const expected = ending === "abort" ? "aborted" : ending === "expiry" ? "expired" : "invalidated";
  assert.deepEqual(await opened.handle.result, { status: expected });
  runtime.shutdown();
});
}

for (const ending of ["abort-queued", "expire-queued", "abort-issued", "unknown-send", "cleanup-fails"] as const) {
test(`Delivery Choice preserves queue/late-publication/no-replay semantics (${ending})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const controller = new AbortController();
  let sends = 0, edits = 0;
  const { runtime } = confirmationHarness({
    async sendChunk() {
      sends++; entered.resolve();
      if (ending === "unknown-send") throw new TelegramApiCommitUnknownError("uncertain", "sendMessage");
      if (ending !== "cleanup-fails") await release.promise;
      return 101;
    },
    async editChunk() { edits++; if (ending === "cleanup-fails") throw new Error("cleanup"); },
  });
  const blocker = ending.endsWith("queued") ? runtime.sendView({ text: "blocker" }, { scope: { kind: "instance" } }) : undefined;
  if (blocker) await entered.promise;
  const opening = runtime.openChoice!(choiceRequest(controller.signal));
  if (ending === "abort-issued") await entered.promise;
  if (ending.startsWith("abort")) controller.abort();
  if (ending === "expire-queued") t.mock.timers.tick(1_000);
  const opened = await opening;
  if (ending === "cleanup-fails") {
    assert.ok(opened.ok);
    runtime.acceptChoice!(choiceCallback(opened.handle.id));
    assert.deepEqual(await opened.handle.result, { status: "selected", choiceId: "json" });
  } else {
    assert.equal(opened.ok, false);
    if (!opened.ok) assert.equal(opened.reason, ending === "unknown-send" ? "commit-unknown" : ending === "expire-queued" ? "expired" : "aborted");
  }
  release.resolve(); await blocker; await flushConfirmationEffects();
  assert.equal(sends, 1, "Queued or uncertain publication never replays");
  if (ending === "cleanup-fails" || ending === "abort-issued") assert.equal(edits, 1);
  runtime.shutdown();
});
}

test("Choice cannot consume a callback before its message publication is known", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let data = "";
  const { runtime } = confirmationHarness({
    async sendChunk(_target, _chunk, options) {
      data = options.replyMarkup!.inline_keyboard[0]![0]!.callback_data!;
      entered.resolve(); await release.promise; return 101;
    },
  });
  const opening = runtime.openChoice!(choiceRequest());
  await entered.promise;
  const query = { ...choiceCallback(""), data };
  assert.deepEqual(runtime.acceptChoice!(query), { handled: true, accepted: false });
  release.resolve();
  const opened = await opening;
  assert.ok(opened.ok);
  runtime.acceptChoice!(query);
  assert.deepEqual(await opened.handle.result, { status: "selected", choiceId: "json" });
  runtime.shutdown();
});

test("Delivery Choice validates declarations before transport and shares Confirm pending capacity", async () => {
  const { runtime, events } = confirmationHarness();
  const request = choiceRequest();
  const malformed: TelegramChoiceRequest[] = [
    { ...request, choices: [] }, { ...request, choices: Array.from({ length: 65 }, (_, i) => ({ id: String(i), label: String(i) })) },
    { ...request, choices: [{ id: "same", label: "A" }, { id: "same", label: "B" }] },
    { ...request, choices: [{ id: "", label: "A" }] }, { ...request, choices: [{ id: "a", label: " " }] },
    { ...request, choices: [{ id: "a", label: "A", disabled: "false" as unknown as boolean }] },
    { ...request, choices: [{ id: "a", label: "A", style: { toString: () => "primary" } as unknown as "primary" }] },
    { ...request, timeoutMs: 0 }, { ...request, timeoutMs: 2_147_483_648 }, { ...request, question: "" },
    { ...request, signal: undefined as unknown as AbortSignal },
    { ...request, scope: { kind: "aggregate" } as unknown as TelegramChoiceRequest["scope"] },
  ];
  for (const value of malformed) await assert.rejects(runtime.openChoice!(value), TypeError);
  assert.equal(events.length, 0);
  assert.equal((await runtime.openChoice!({ ...request, question: "one|two" })).ok, false);
  for (let i = 0; i < 256; i++) {
    const opened = i % 2 ? await runtime.openConfirmation!(confirmationRequest()) : await runtime.openChoice!(request);
    assert.equal(opened.ok, true);
  }
  const full = await runtime.openChoice!(request);
  assert.equal(full.ok, false);
  if (!full.ok) assert.equal(full.reason, "capacity-exceeded");
  runtime.shutdown();
});

test("Choice accepts the inclusive 64-option boundary and resolves the last declared ID", async () => {
  const { runtime, events } = confirmationHarness();
  const opened = await runtime.openChoice!({ ...choiceRequest(),
    choices: Array.from({ length: 64 }, (_, index) => ({ id: `format-${index}`, label: `Format ${index}` })) });
  assert.ok(opened.ok);
  const keyboard = (events.find(event => event.type === "send")!.options as { replyMarkup: TelegramInlineKeyboardMarkup }).replyMarkup.inline_keyboard;
  assert.equal(keyboard.length, 65, "64 choices plus one explicit Cancel");
  assert.match(keyboard[63]![0]!.callback_data!, /:63$/u);
  assert.equal(runtime.acceptChoice!(choiceCallback(opened.handle.id, "63")).handled, true);
  assert.deepEqual(await opened.handle.result, { status: "selected", choiceId: "format-63" });
  runtime.shutdown();
});

test("Public Choice uses the existing binding, invalidates replacement and fails softly on older bindings", async () => {
  const first = confirmationHarness(), second = confirmationHarness();
  const unbindFirst = bindTelegramDeliveryRuntime(first.runtime);
  const opened = await openTelegramChoice(choiceRequest());
  assert.ok(opened.ok);
  const unbindSecond = bindTelegramDeliveryRuntime(second.runtime);
  assert.deepEqual(await opened.handle.result, { status: "invalidated" });
  unbindFirst();
  assert.equal((await openTelegramChoice(choiceRequest())).ok, true);
  unbindSecond();
  const unavailable = await openTelegramChoice(choiceRequest());
  assert.equal(unavailable.ok, false);
  const old = bindTelegramDeliveryRuntime(createRuntime("old"));
  try {
    const unsupported = await openTelegramChoice(choiceRequest());
    assert.equal(unsupported.ok, false);
    if (!unsupported.ok) assert.equal(unsupported.reason, "runtime-unavailable");
  } finally { old(); clearTelegramDeliveryRuntime(); }
});

test("Delivery confirmation shares generation, target queue and one-shot exact-message acceptance", async () => {
  const { runtime, events } = confirmationHarness();
  const opened = await runtime.openConfirmation!(confirmationRequest());
  assert.ok(opened.ok);
  assert.deepEqual(opened.handle.target, target);
  assert.equal(opened.handle.generation, runtime.generation);
  const sent = events.find(event => event.type === "send")!;
  assert.equal((sent.chunk as { text: string }).text, "<b>Clear &lt;cache&gt; &amp; history?</b>");
  const options = sent.options as { assertAuthority: () => void; replyMarkup: TelegramInlineKeyboardMarkup };
  assert.equal(typeof options.assertAuthority, "function");
  assert.ok(options.replyMarkup.inline_keyboard[0]!.every(button => Buffer.byteLength(button.callback_data!) <= 64));
  assert.equal(runtime.hasPendingTarget!(target), true);
  assert.equal(runtime.acceptConfirmation!(confirmationCallback(opened.handle.id)).handled, true);
  assert.deepEqual(await opened.handle.result, { status: "confirmed" });
  assert.deepEqual(runtime.acceptConfirmation!(confirmationCallback(opened.handle.id)), { handled: true, accepted: false });
  await flushConfirmationEffects();
  const edits = events.filter(event => event.type === "edit");
  assert.equal(edits.length, 1);
  assert.deepEqual((edits[0]!.options as { replyMarkup: unknown }).replyMarkup, { inline_keyboard: [] });
  assert.equal(runtime.hasPendingTarget!(target), false);
  runtime.shutdown();
});

test("Delivery confirmation cannot consume a different actor, target, message or stale source", async () => {
  const { runtime } = confirmationHarness();
  const opened = await runtime.openConfirmation!(confirmationRequest());
  assert.ok(opened.ok);
  const query = confirmationCallback(opened.handle.id, "no");
  for (const changed of [
    { ...query, from: { id: 43 } },
    { ...query, message: { ...query.message, chat: { id: 43 } } },
    { ...query, message: { ...query.message, message_thread_id: 8 } },
    { ...query, message: { ...query.message, message_thread_id: undefined } },
    { ...query, message: { ...query.message, message_id: 102 } },
  ]) assert.deepEqual(runtime.acceptConfirmation!(changed), { handled: true, accepted: false });
  assert.throws(() => runtime.acceptConfirmation!(query, () => { throw new Error("Stale update"); }), /Stale update/u);
  assert.equal(runtime.hasPendingTarget!(target), true);
  runtime.acceptConfirmation!(query, () => {});
  assert.deepEqual(await opened.handle.result, { status: "cancelled" });
  runtime.shutdown();
});

test("Delivery confirmation abort while queued returns promptly and never issues its send", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let sends = 0;
  const { runtime } = confirmationHarness({
    async sendChunk() { sends++; entered.resolve(); await release.promise; return 101; },
  });
  const blocking = runtime.sendView({ text: "block" }, { scope: { kind: "instance" } });
  await entered.promise;
  const controller = new AbortController();
  const opening = runtime.openConfirmation!(confirmationRequest(controller.signal));
  controller.abort();
  const aborted = await opening;
  assert.equal(aborted.ok, false);
  if (!aborted.ok) assert.equal(aborted.reason, "aborted");
  release.resolve();
  await blocking;
  await flushConfirmationEffects();
  assert.equal(sends, 1);
  runtime.shutdown();
});

test("Delivery confirmation deadline includes HTTP wait and a late known response stays inert", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const entered = Promise.withResolvers<void>(), response = Promise.withResolvers<number>();
  const { runtime, events } = confirmationHarness({
    async sendChunk() { entered.resolve(); return response.promise; },
  });
  const opening = runtime.openConfirmation!(confirmationRequest());
  await entered.promise;
  t.mock.timers.tick(1_000);
  const expired = await opening;
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.reason, "expired");
  response.resolve(101);
  await flushConfirmationEffects();
  assert.equal(events.filter(event => event.type === "edit").length, 1);
  assert.equal(runtime.hasPendingTarget!(target), false);
  runtime.shutdown();
});

for (const change of ["profile", "operator", "target", "shutdown"] as const)
test(`Delivery confirmation refuses lost ${change} authority`, async () => {
  let profile = "default", operatorId = 42, authorized = true;
  const { runtime } = confirmationHarness({
    getConfirmationAuthority: () => ({ profile, operatorId }),
    isExplicitTargetAuthorized: () => authorized,
  });
  const opened = await runtime.openConfirmation!(confirmationRequest());
  assert.ok(opened.ok);
  if (change === "profile") profile = "replacement";
  if (change === "operator") operatorId = 43;
  if (change === "target") authorized = false;
  if (change === "shutdown") runtime.shutdown();
  assert.deepEqual(runtime.acceptConfirmation!(confirmationCallback(opened.handle.id)), { handled: true, accepted: false });
  assert.deepEqual(await opened.handle.result, { status: "invalidated" });
  runtime.shutdown();
});

test("Delivery confirmation unknown send cannot replay or become an accepted decision", async () => {
  let sends = 0;
  const diagnostics: unknown[] = [];
  const unknown = new TelegramApiCommitUnknownError("sendMessage", new TypeError("fetch failed"));
  const { runtime } = confirmationHarness({
    async sendChunk() { sends++; throw unknown; },
    recordFailure(_operation, error) { diagnostics.push(error); },
  });
  const opened = await runtime.openConfirmation!(confirmationRequest());
  assert.equal(opened.ok, false);
  if (!opened.ok) assert.equal(opened.reason, "commit-unknown");
  assert.equal(sends, 1);
  assert.deepEqual(diagnostics, [unknown]);
  assert.deepEqual(runtime.acceptConfirmation!({ data: "tgconfirm:malformed:yes" }), { handled: true, accepted: false });
  assert.deepEqual(runtime.acceptConfirmation!({ data: "other:yes" }), { handled: false });
  runtime.shutdown();
});

test("Delivery confirmation keeps consent after cleanup failure and records a real late HTTP failure", async () => {
  const diagnostics: unknown[] = [];
  const { runtime } = confirmationHarness({
    async editChunk() { throw new Error("edit failed"); },
    recordFailure(_operation, error) { diagnostics.push(error); },
  });
  const opened = await runtime.openConfirmation!(confirmationRequest());
  assert.ok(opened.ok);
  runtime.acceptConfirmation!(confirmationCallback(opened.handle.id));
  assert.deepEqual(await opened.handle.result, { status: "confirmed" });
  await flushConfirmationEffects();
  assert.equal(diagnostics.length, 1);
  runtime.shutdown();
  const entered = Promise.withResolvers<void>(), response = Promise.withResolvers<number>();
  const late = confirmationHarness({
    async sendChunk() { entered.resolve(); return response.promise; },
    recordFailure(_operation, error) { diagnostics.push(error); },
  });
  const controller = new AbortController();
  const opening = late.runtime.openConfirmation!(confirmationRequest(controller.signal));
  await entered.promise;
  controller.abort();
  assert.equal((await opening).ok, false);
  const httpError = new Error("HTTP 500");
  response.reject(httpError);
  await flushConfirmationEffects();
  assert.equal(diagnostics.at(-1), httpError);
  late.runtime.shutdown();
});

test("Delivery confirmation validates before transport and bounds retained pending answers", async () => {
  const { runtime, events } = confirmationHarness();
  for (const timeoutMs of [0, -1, 1.5, Infinity, 2_147_483_648])
    await assert.rejects(runtime.openConfirmation!({ ...confirmationRequest(), timeoutMs }), TypeError);
  const oversized = await runtime.openConfirmation!({ ...confirmationRequest(), question: "one|two" });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.reason, "invalid-view");
  assert.equal(events.length, 0);
  for (let index = 0; index < 256; index++) assert.equal((await runtime.openConfirmation!(confirmationRequest())).ok, true);
  const full = await runtime.openConfirmation!(confirmationRequest());
  assert.equal(full.ok, false);
  if (!full.ok) assert.equal(full.reason, "capacity-exceeded");
  runtime.shutdown();
  await flushConfirmationEffects();
});

test("Public Delivery confirmation API uses the existing binding and invalidates replaced generations", async () => {
  const first = confirmationHarness(), second = confirmationHarness();
  bindTelegramDeliveryRuntime(first.runtime);
  const opened = await openTelegramConfirm(confirmationRequest());
  assert.ok(opened.ok);
  bindTelegramDeliveryRuntime(second.runtime);
  assert.deepEqual(await opened.handle.result, { status: "invalidated" });
  assert.equal((await openTelegramConfirm(confirmationRequest())).ok, true);
  clearTelegramDeliveryRuntime();
  const unavailable = await openTelegramConfirm(confirmationRequest());
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.reason, "runtime-unavailable");
});

for (const end of ["abort", "profile"] as const)
test(`Bridge confirmation rechecks ${end} authority after API admission wait`, async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const controller = new AbortController();
  let profile = "default", issued = 0;
  const runtime = createTelegramBridgeDeliveryRuntime({
    generation: "admission",
    getProfileName: () => profile,
    getTargetPolicyView: () => ({ canDeliver: true, ownsDirect: true, allowedChatId: 42, leaderTarget: target }),
    getActiveTurnTarget: () => target,
    api: {
      async sendMessage(_body, options) {
        entered.resolve(); await release.promise; options?.assertAuthority?.(); issued++; return { message_id: 101 };
      },
      async editMessageText(_body, options) { options?.assertAuthority?.(); return "edited"; },
      async deleteMessage() {},
      async sendChatAction() { return true; },
    },
    recordOwnership() {},
  });
  const opening = runtime.openConfirmation!(confirmationRequest(controller.signal));
  await entered.promise;
  if (end === "abort") controller.abort();
  else profile = "replacement";
  release.resolve();
  const opened = await opening;
  assert.equal(opened.ok, false);
  if (!opened.ok) assert.equal(opened.reason, end === "abort" ? "aborted" : "invalidated");
  assert.equal(issued, 0);
  runtime.shutdown();
});

for (const kind of ["choice", "confirmation"] as const) {
test(`Bridge ${kind} refuses a replaced transport owner even when operator and target stay unchanged`, async () => {
  let current = true;
  const runtime = createTelegramBridgeDeliveryRuntime({
    generation: "old-owner", isTransportActive: () => current, getProfileName: () => "default",
    getTargetPolicyView: () => ({ canDeliver: true, ownsDirect: true, allowedChatId: 42, leaderTarget: { chatId: 42, threadId: 7 } }),
    getActiveTurnTarget: () => undefined,
    api: { async sendMessage() { return { message_id: 101 }; }, async editMessageText() { return "edited"; },
      async deleteMessage() {}, async sendChatAction() { return true; } }, recordOwnership() {},
  });
  const opened = kind === "choice" ? await runtime.openChoice!(choiceRequest()) : await runtime.openConfirmation!(confirmationRequest());
  assert.ok(opened.ok);
  current = false;
  const accepted = kind === "choice" ? runtime.acceptChoice!(choiceCallback(opened.handle.id)) : runtime.acceptConfirmation!(confirmationCallback(opened.handle.id));
  assert.deepEqual(accepted, { handled: true, accepted: false });
  assert.deepEqual(await opened.handle.result, { status: "invalidated" });
  runtime.shutdown();
});
}

test("Delivery confirmation diagnostics cannot replace a structured transport outcome", async () => {
  const { runtime } = confirmationHarness({
    async sendChunk() { throw new Error("transport"); },
    recordFailure() { throw new Error("diagnostics"); },
  });
  try {
    const opened = await runtime.openConfirmation!(confirmationRequest());
    assert.equal(opened.ok, false);
    if (!opened.ok) assert.equal(opened.reason, "transport-failed");
  } finally { runtime.shutdown(); }
});