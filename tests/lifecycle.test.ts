/**
 * Regression tests for Telegram lifecycle hook helpers
 * Covers context generations, bounded resume intent, and lifecycle hook composition ordering
 * Zones: pi agent lifecycle, telegram session
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as Queue from "../lib/queue.ts";
import { createTelegramQueueBindingRuntime } from "../lib/bindings.ts";

import {
  appendTelegramLifecycleHooks,
  createTelegramBridgeSessionLifecycleAssembly,
  createTelegramCompactionObserverRuntime,
  createTelegramCompactionObserverState,
  transitionTelegramCompactionObserver,
  type TelegramCompactionObserverEvent,
  createTelegramConnectionIntentRuntime,
  createTelegramConnectionLifecycle,
  type TelegramConnectionHandoffStore,
  createTelegramSessionContextStore,
  createTelegramArtifactSessionCapture,
  createTelegramSessionDrainObserver,
  createTelegramSessionGenerationFence,
  createTelegramMessageActivityTypingHooks,
  registerTelegramLifecycleHooks,
} from "../lib/lifecycle.ts";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent, SessionShutdownEvent } from "../lib/pi.ts";
import {
  createTelegramBridgeRuntime,
  createTelegramTypingLoopStarter,
} from "../lib/runtime.ts";
import { createPassthroughFailureLog } from "./fixtures/failure-log.ts";

for (const change of ["none", "fresh-context", "clear", "same-identity-generation", "session-id"] as const)
test(`Artifact session capture binds exact generation and session ID with sticky loss (${change})`, () => {
  const manager = { id: "session" }, ctx = { manager };
  const context = createTelegramSessionContextStore<typeof ctx>({ getIdentity: value => value.manager });
  const capture = createTelegramArtifactSessionCapture({ context, getSessionId: value => value?.manager.id });
  assert.equal(capture(), undefined);
  context.set(ctx);
  const current = capture()!;
  assert.equal(current(), true);
  if (change === "fresh-context") assert.equal(context.isCurrent({ manager }), true);
  if (change === "clear") context.clear();
  if (change === "same-identity-generation") context.set({ manager });
  if (change === "session-id") manager.id = "other";
  assert.equal(current(), change === "none" || change === "fresh-context");
  manager.id = "session";
  assert.equal(current(), change === "none" || change === "fresh-context", "Restored identity cannot renew observed loss");
  manager.id = "";
  assert.equal(capture(), undefined);
});

for (const change of ["none", "clear", "reused-context", "authority", "queued-clear", "sink-fails"] as const)
test(`Session drain observer cannot borrow replacement authority (${change})`, async () => {
  const context = createTelegramSessionContextStore<object>(), ctx = {};
  let authority = 1, notifications = 0;
  context.set(ctx);
  const capture = createTelegramSessionDrainObserver({
    context, captureAuthority: () => authority, isAuthorityActive: value => value === authority,
    onDrained(value) { assert.equal(value, ctx); if (change === "sink-fails") throw new Error("observer"); notifications++; },
  });
  const notify = capture()!;
  if (change === "clear") context.clear();
  if (change === "reused-context") context.set(ctx);
  if (change === "authority") authority++;
  notify();
  if (change === "queued-clear") context.clear();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(notifications, change === "none" ? 1 : 0);
});

for (const change of ["distinct-context", "reused-context", "clear"] as const) {
  test(`Message activity typing preserves exact session lifetime with unchanged transport (${change})`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const context = createTelegramSessionContextStore<ExtensionContext>(), old = createLifecycleContext(), next = change === "reused-context" ? old : createLifecycleContext();
    const runtime = createTelegramBridgeRuntime(), calls: number[] = [];
    context.set(old);
    const start = createTelegramTypingLoopStarter({
   failureLog: createPassthroughFailureLog(),
   typing: runtime.typing, getDefaultChatId: () => 7,
      isContextActive: context.isCurrent, getSessionGeneration: context.getGeneration, getTransportAuthority: () => "same-epoch", isThreadedMode: () => true,
      sendTypingAction: async (_chat, options) => { calls.push(options?.message_thread_id ?? 0); }, updateStatus() {} });
    const hooks = createTelegramMessageActivityTypingHooks({ hasActiveTurn: () => true,
      startTypingLoop: value => { start(value, 7, { target: { chatId: 7, threadId: 42 } }); },
      async onMessageStart() {}, async onMessageUpdate() {} });
    try {
      await hooks.onMessageStart({ message: { role: "user", content: "message", timestamp: 0 } }, old); await new Promise<void>(resolve => setImmediate(resolve)); assert.deepEqual(calls, [42]);
      if (change === "clear") context.clear(old); else context.set(next);
      t.mock.timers.tick(3000); await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(calls, [42]); assert.equal(runtime.typing.stop(), false);
      if (change === "distinct-context") {
        await hooks.onMessageUpdate({ message: { role: "user", content: "message", timestamp: 0 } }, old); await new Promise<void>(resolve => setImmediate(resolve)); assert.deepEqual(calls, [42]);
      }
      if (change !== "clear") {
        await hooks.onMessageUpdate({ message: { role: "user", content: "message", timestamp: 0 } }, next); await new Promise<void>(resolve => setImmediate(resolve)); assert.deepEqual(calls, [42, 42]);
      }
    } finally { runtime.typing.stop(); }
  });
}

test("Held message activity cannot re-arm typing after the same context object enters a new generation", async () => {
  const context = createTelegramSessionContextStore<ExtensionContext>(), ctx = createLifecycleContext(), runtime = createTelegramBridgeRuntime();
  context.set(ctx); const calls: number[] = [];
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const start = createTelegramTypingLoopStarter({
   failureLog: createPassthroughFailureLog(),
   typing: runtime.typing, getDefaultChatId: () => 7,
    isContextActive: context.isCurrent, getSessionGeneration: context.getGeneration, getTransportAuthority: () => "same-epoch",
    sendTypingAction: async (_chat, options) => { calls.push(options?.message_thread_id ?? 0); }, updateStatus() {} });
  const hooks = createTelegramMessageActivityTypingHooks({ hasActiveTurn: () => true,
    isContextActive: context.isCurrent, getSessionGeneration: context.getGeneration,
    startTypingLoop: value => { start(value, 7, { target: { chatId: 7, threadId: 41 } }); },
    async onMessageStart() { await held; }, async onMessageUpdate() {} });
  try {
    const activity = hooks.onMessageStart({ message: { role: "user", content: "old message", timestamp: 0 } }, ctx);
    await new Promise<void>(resolve => setImmediate(resolve)); assert.deepEqual(calls, [41]);
    context.set(ctx); runtime.typing.stop(); finish(); await activity;
    await new Promise<void>(resolve => setImmediate(resolve)); assert.deepEqual(calls, [41]);
    assert.equal(runtime.typing.stop(), false, "An old hook's finally cannot claim the successor's generation");
  } finally { finish(); runtime.typing.stop(); }
});

const resume = { reason: "resume", cwd: "/repo", sessionFile: "/sessions/destination.jsonl" };
const shutdown = { reason: "resume", cwd: "/repo", targetSessionFile: resume.sessionFile, connected: false };

test("Connection handoff carries plain selected-profile intent once, never old completion", () => {
  const store: TelegramConnectionHandoffStore = {};
  const source = createTelegramConnectionIntentRuntime({ store, pid: 42, now: () => 1000 });
  const token = source.begin("/repo", "work");
  source.suspend(shutdown);
  source.finish(token);
  const successor = createTelegramConnectionIntentRuntime({ store, pid: 42, now: () => 2000 });
  const intent = successor.resume(resume)!;
  assert.equal(intent.profileName, "work");
  assert.equal(intent.cwd, "/repo");
  assert.notEqual(intent.id, token);
  assert.equal(store.pending, undefined);
  source.finish(token);
  successor.suspend({ ...shutdown, targetSessionFile: "/sessions/third.jsonl" });
  const third = createTelegramConnectionIntentRuntime({ store, pid: 42, now: () => 3000 });
  assert.equal(third.resume({ ...resume, sessionFile: "/sessions/third.jsonl" })?.profileName, "work");
  assert.equal(third.resume(resume), undefined);
});

test("Connection handoff refuses unrelated startup, process, directory, file, expiry and explicit cancellation", () => {
  for (const scenario of ["startup", "reload", "new", "fork", "pid", "cwd", "file", "expired", "cancel"] as const) {
    const store: TelegramConnectionHandoffStore = {};
    const source = createTelegramConnectionIntentRuntime({ store, pid: 42, now: () => 1000 });
    source.begin("/repo", "work");
    source.suspend(shutdown);
    if (scenario === "cancel") source.cancel();
    const successor = createTelegramConnectionIntentRuntime({ store,
      pid: scenario === "pid" ? 43 : 42, now: () => scenario === "expired" ? 31_000 : 2000 });
    assert.equal(successor.resume({ ...resume,
      reason: ["startup", "reload", "new", "fork"].includes(scenario) ? scenario : "resume",
      cwd: scenario === "cwd" ? "/other" : "/repo",
      sessionFile: scenario === "file" ? "/other.jsonl" : resume.sessionFile }), undefined, scenario);
  }
  for (const reason of ["quit", "reload", "new", "fork"]) {
    const store: TelegramConnectionHandoffStore = {};
    const source = createTelegramConnectionIntentRuntime({ store });
    source.begin("/repo");
    source.suspend({ ...shutdown, reason });
    assert.equal(store.pending, undefined);
  }
});

test("Connected transport carries intent on resume; disconnected startup never grants it", () => {
  for (const connected of [false, true]) {
    const store: TelegramConnectionHandoffStore = {};
    const source = createTelegramConnectionIntentRuntime({ store });
    source.suspend({ ...shutdown, connected, profileName: "work" });
    const successor = createTelegramConnectionIntentRuntime({ store });
    assert.equal(successor.resume(resume)?.profileName, connected ? "work" : undefined);
  }
});

test("Disconnect and newer connect supersede a delayed resumed startup", async () => {
  for (const supersede of [false, true]) {
    const store: TelegramConnectionHandoffStore = {};
    const intent = createTelegramConnectionIntentRuntime({ store });
    intent.begin("/repo", "selected");
    intent.suspend(shutdown);
    let starts = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const lifecycle = createTelegramConnectionLifecycle({ intent, getGeneration: () => 1,
      isCurrent: () => true, isConnected: () => false, getProfileName: () => undefined,
      activateProfile: async (profile) => { assert.equal(profile, "selected"); await pending; return true; },
      start: async () => { starts += 1; return { ok: true }; }, recordError() {},
    });
    const ctx = { cwd: "/repo", sessionManager: { getSessionFile: () => resume.sessionFile } } as ExtensionContext;
    lifecycle.prepare({ reason: "resume" } as SessionStartEvent, ctx)!();
    const newer = supersede ? intent.begin("/repo", "other") : undefined;
    if (!supersede) intent.cancel();
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(starts, 0);
    if (newer) assert.equal(intent.isActive(newer), true, "Older finally must not clear newer intent");
  }
});

test("Resume connection failures retain detailed diagnostics without leaking them into notices", async () => {
  for (const rejection of [false, true]) {
    const intent = createTelegramConnectionIntentRuntime({ store: {} });
    intent.begin("/repo");
    intent.suspend(shutdown);
    const notices: string[] = [];
    const errors: unknown[] = [];
    const detail = "Owner epoch changed during destination claim";
    const lifecycle = createTelegramConnectionLifecycle({ intent, getGeneration: () => 1,
      isCurrent: () => true, isConnected: () => false, getProfileName: () => undefined,
      activateProfile: async () => true,
      async start() {
        if (rejection) throw new Error(detail);
        return { ok: false, message: detail };
      }, recordError(error) { errors.push(error); },
    });
    const ctx = { cwd: "/repo", sessionManager: { getSessionFile: () => resume.sessionFile },
      ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionContext;
    lifecycle.prepare({ reason: "resume" } as SessionStartEvent, ctx)!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), new RegExp(detail));
    assert.equal(notices.length, 1);
    assert.ok(!notices[0]!.includes(detail));
    assert.match(notices[0]!, /telegram-status --debug/);
    intent.suspend(shutdown);
    assert.equal(intent.resume(resume), undefined, "Failed startup never leaves reconnect authority");
  }
});

test("Resumed startup drops late work before reading invalid Pi getters", async () => {
  const store: TelegramConnectionHandoffStore = {};
  const intent = createTelegramConnectionIntentRuntime({ store });
  intent.begin("/repo");
  intent.suspend(shutdown);
  let generation = 1;
  let starts = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const ctx = { cwd: "/repo", sessionManager: { getSessionFile: () => resume.sessionFile } } as ExtensionContext;
  const lifecycle = createTelegramConnectionLifecycle({ intent, getGeneration: () => generation,
    isCurrent: () => { assert.equal(generation, 1); return true; },
    isConnected: () => false, getProfileName: () => undefined,
    activateProfile: async () => { await pending; return true; },
    start: async () => { starts += 1; return { ok: true }; }, recordError() {},
  });
  lifecycle.prepare({ reason: "resume" } as SessionStartEvent, ctx)!();
  lifecycle.onSessionShutdown({ reason: "resume", targetSessionFile: "/sessions/third.jsonl" } as SessionShutdownEvent, ctx);
  generation += 1;
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(starts, 0);
  assert.equal(store.pending?.targetSessionFile, "/sessions/third.jsonl");
});

type RegisteredLifecycleHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => Promise<unknown> | unknown;

function createLifecycleApiHarness() {
  const handlers = new Map<string, RegisteredLifecycleHandler>();
  const api = {
    on: (event: string, handler: RegisteredLifecycleHandler) => {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  return { api, handlers };
}

function getRequiredLifecycleHandler(
  handlers: Map<string, RegisteredLifecycleHandler>,
  name: string,
): RegisteredLifecycleHandler {
  const handler = handlers.get(name);
  assert.ok(handler, `Expected lifecycle handler ${name}`);
  return handler;
}

function createLifecycleContext(): ExtensionContext {
  return {} as ExtensionContext;
}

test("Session generation fence ignores delayed shutdown from a replaced context", async () => {
  const store = createTelegramSessionContextStore<ExtensionContext>();
  const shutdowns: ExtensionContext[] = [];
  const runtime = createTelegramSessionGenerationFence(store, {
    onSessionStart: async () => undefined,
    onSessionShutdown: async (_event, ctx) => {
      shutdowns.push(ctx);
    },
  });
  const oldContext = { cwd: "/old" } as ExtensionContext;
  const newContext = { cwd: "/new" } as ExtensionContext;

  await runtime.onSessionStart({} as never, oldContext);
  await runtime.onSessionStart({} as never, newContext);
  await runtime.onSessionShutdown({} as never, oldContext);

  assert.equal(store.get(), newContext);
  assert.deepEqual(shutdowns, []);
  await runtime.onSessionShutdown({} as never, newContext);
  assert.equal(store.get(), undefined);
  assert.deepEqual(shutdowns, [newContext]);
});

test("Resume connection claims before queue startup and replaces ordinary auto-restore", async () => {
  for (const resumeIntent of [false, true]) {
    const contexts = createTelegramSessionContextStore<ExtensionContext>();
    const events: string[] = [];
    const runtime = createTelegramBridgeSessionLifecycleAssembly({
      contextStore: contexts,
      queue: {
        getCurrentModel: () => undefined, loadConfig: async () => { events.push("config"); },
        setQueuedItems() {}, setCurrentModel() {}, setPendingModelSwitch() {}, syncCounters() {}, syncFlags() {},
        bindDeferredDispatchContext() {}, prepareTempDir: async () => {}, updateStatus() {},
      },
      follower: {
        registrationState: { getTarget: () => undefined, isRegistered: () => false },
        registrationRuntime: {}, instanceId: "leader", getLeaderState: () => ({ kind: "unlocked" }),
        suspendPolling: async () => {}, updateStatus() {}, recordRuntimeEvent() {},
      },
      services: {
        connection: {
          prepare() {
            events.push("claim-intent");
            return resumeIntent ? () => { events.push("resume-connect"); } : undefined;
          }, onSessionShutdown() {},
        },
        resumeGroupedInput() {}, suspendGroupedInput() {},
        delivery: { onSessionStart: async () => { events.push("delivery"); }, onSessionShutdown: async () => {} },
        polling: { onSessionStart: async () => { events.push("auto-restore"); } },
        inboundWorker: { onSessionShutdown: async () => {} },
        capabilityMonitor: { start() {}, stop() {} }, queueWatchdog: { start() {}, stop() {} },
      },
    } as unknown as Parameters<typeof createTelegramBridgeSessionLifecycleAssembly>[0]);
    await runtime.onSessionStart({ type: "session_start", reason: "resume" }, createLifecycleContext());
    assert.deepEqual(events, ["claim-intent", "config", "delivery", resumeIntent ? "resume-connect" : "auto-restore"]);
  }
});

test("Bridge Queue startup and services fence reused-context replacement at every awaited boundary", async () => {
  for (const phase of ["config", "temp", "delivery", "polling", "refresh"] as const) {
    const contexts = createTelegramSessionContextStore<ExtensionContext>(), ctx = createLifecycleContext();
    const events: string[] = [], successor = ["successor"];
    let items = ["predecessor"];
    const replaceAt = async (point: typeof phase) => {
      events.push(point); await Promise.resolve();
      if (point === phase) { contexts.set(ctx); items = successor; }
    };
    const runtime = createTelegramBridgeSessionLifecycleAssembly<string>({ contextStore: contexts,
      queue: { getCurrentModel: () => undefined, loadConfig: () => replaceAt("config"),
        setQueuedItems(value) { events.push("state"); items = value; }, setCurrentModel() {}, setPendingModelSwitch() {},
        syncCounters() {}, syncFlags() {}, bindDeferredDispatchContext() { events.push("bind"); },
        prepareTempDir: () => replaceAt("temp"), updateStatus() { events.push("status"); },
        clearModelMenuState() {}, getActiveTurnChatId: () => undefined, clearPreview: async () => {}, clearActiveTurn() {},
        clearAbort() {}, },
      follower: { registrationState: { getTarget: () => undefined, getSlot: () => undefined, getThreadName: () => undefined,
        isRegistered: () => true }, registrationRuntime: { setContext: () => replaceAt("refresh"), registerWithLeader: async () => false },
        instanceId: "follower", getLeaderState: () => ({ kind: "inactive" }), suspendPolling: async () => {},
        updateStatus() { events.push("follower-status"); }, recordRuntimeEvent() { events.push("follower-notice"); } },
      services: { resumeGroupedInput() { events.push("grouped"); }, suspendGroupedInput() {},
        delivery: { onSessionStart: () => replaceAt("delivery"), onSessionShutdown: async () => {} },
        polling: { onSessionStart: () => replaceAt("polling") }, inboundWorker: { onSessionShutdown: async () => {} },
        capabilityMonitor: { start() { events.push("monitor"); }, stop() {} }, queueWatchdog: { start() { events.push("watchdog"); }, stop() {} } },
    });
    await runtime.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
    assert.equal(items, successor, `${phase}: predecessor startup cannot reset successor Queue state`);
    assert.equal(contexts.get(), ctx);
    const forbidden = phase === "config" ? ["state", "bind", "temp", "status", "grouped", "delivery", "polling", "monitor", "watchdog"] :
      phase === "temp" ? ["status", "grouped", "delivery", "polling", "monitor", "watchdog"] :
      phase === "delivery" ? ["polling", "monitor", "watchdog"] : phase === "polling" ? ["monitor", "watchdog"] : [];
    forbidden.push("follower-status", "follower-notice");
    if (phase !== "refresh") forbidden.push("refresh");
    assert.ok(forbidden.every(effect => !events.includes(effect)), `${phase}: obsolete services must remain inert (${events.join(", ")})`);
  }
});

test("Bridge Queue teardown fences receipt-bearing Steer across reused-context replacement", async () => {
  for (const shape of ["waiting", "frozen", "pending"] as const) for (const outcome of ["settled", "refused", "replaced"] as const) {
    const contexts = createTelegramSessionContextStore<ExtensionContext>(), ctx = createLifecycleContext();
    contexts.set(ctx);
    const events: string[] = [];
    const store = Queue.createTelegramQueueStore<ExtensionContext>();
    const deferred = Queue.createTelegramDeferredQueueDispatchRuntime<ExtensionContext>(); deferred.bind(ctx);
    const originals: Queue.PendingTelegramTurn[] = [1, 2].map(id => ({ kind: "prompt", chatId: 7,
      target: { chatId: 7, threadId: 42 }, replyToMessageId: id, queueOrder: id, queueLane: "steer", laneOrder: id,
      statusSummary: "steer", content: [{ type: "text", text: `input-${id}` }], sourceMessageIds: [id],
      queuedAttachments: [], historyText: "steer", admissionReceipts: [Queue.createTelegramQueueAdmissionReceipt({
        queueKind: "prompt", scope: `shutdown-${id}`, sourceUpdateIds: id === 1 ? [1, 3] : [2] })!],
      ...(shape === "waiting" ? {} : { steerAttempted: true }) }));
    if (shape === "pending") originals[0]!.steerPacketTail = [originals[1]!];
    store.setQueuedItems(originals);
    const replacement = [{ ...originals[0]!, queueOrder: 99 }];
    let discarded: readonly Queue.TelegramQueueItem<ExtensionContext>[] | undefined;
    const binding = createTelegramQueueBindingRuntime({ store, deferredDispatch: deferred,
      queue: { allocateItemOrder: () => 3 }, lifecycle: { isCompactionInProgress: () => false, hasDispatchPending: () => shape === "pending" },
      activeTurn: { has: () => false }, transportStamp: { isActive: () => true },
      admission: { getSettlement: () => ({ isItemReady: () => true, onControlSettled() {}, onItemsDiscarded(items) {
        events.push("discard"); discarded = items; return outcome !== "refused";
      } }), hasPendingQueueMutationForItem: () => false },
      isIdle: () => true, hasPendingMessages: () => false, isContextCurrent: contexts.isCurrent, isContextAborted: () => false,
      promptDispatch: { startTypingLoop() {}, onPromptDispatchStart() {}, onPromptDispatchFailure() {} },
      updateStatus() {}, sendTextReply: async () => undefined, sendUserMessage: () => assert.fail("Teardown cannot replay a packet") });
    const runtime = createTelegramBridgeSessionLifecycleAssembly<Queue.TelegramQueueItem<ExtensionContext>>({
      contextStore: contexts,
      queue: { getCurrentModel: () => undefined, loadConfig: async () => {},
        setQueuedItems(items) { events.push("state"); store.setQueuedItems(items); }, setCurrentModel() {}, setPendingModelSwitch() {},
        syncCounters() {}, syncFlags() {}, bindDeferredDispatchContext: deferred.bind, prepareTempDir: async () => {}, updateStatus() {},
        unbindDeferredDispatchContext: deferred.unbind, discardQueuedItems: binding.mutation.clear,
        clearModelMenuState() { events.push("menus"); }, getActiveTurnChatId: () => undefined, clearPreview: async () => {},
        clearActiveTurn() { events.push("turn"); }, clearAbort() { events.push("abort"); } },
      follower: { registrationState: { getTarget: () => undefined, getSlot: () => undefined, getThreadName: () => undefined,
        isRegistered: () => false }, registrationRuntime: { setContext() {}, registerWithLeader: async () => false },
        instanceId: "leader", getLeaderState: () => ({ kind: "inactive" }), updateStatus() {}, recordRuntimeEvent() {},
        async suspendPolling() {
          events.push("polling"); await Promise.resolve();
          if (outcome === "replaced") { contexts.set(ctx); store.setQueuedItems(replacement); deferred.bind(ctx); }
        } },
      services: { resumeGroupedInput() {}, suspendGroupedInput() { events.push("media"); },
        delivery: { onSessionStart: async () => {}, onSessionShutdown: async () => {} }, polling: { onSessionStart: async () => {} },
        inboundWorker: { async onSessionShutdown() { events.push("worker"); } },
        capabilityMonitor: { start() {}, stop() {} }, queueWatchdog: { start() {}, stop() {} } },
    });
    const shutdown = runtime.onSessionShutdown({ type: "session_shutdown", reason: "reload" }, ctx);
    if (outcome === "refused") {
      await assert.rejects(shutdown, /could not be discarded durably/);
      assert.equal(store.getQueuedItems(), originals); assert.deepEqual(discarded, originals);
      assert.ok(discarded!.every((item, index) => item === originals[index]));
      assert.deepEqual(events, ["polling", "discard"]); assert.equal(contexts.get(), ctx);
    } else {
      await shutdown;
      if (outcome === "replaced") {
        assert.equal(discarded, undefined, `${shape}: obsolete teardown cannot borrow successor receipts`);
        assert.equal(store.getQueuedItems(), replacement); assert.equal(contexts.get(), ctx);
        assert.equal(deferred.isBound(), true); assert.deepEqual(events, ["polling"]);
      } else {
        assert.deepEqual(discarded, originals); assert.deepEqual(store.getQueuedItems(), []);
        assert.ok(discarded!.every((item, index) => item === originals[index]));
        assert.equal(contexts.get(), undefined); assert.equal(deferred.isBound(), false);
        assert.deepEqual(events, ["polling", "discard", "state", "media", "menus", "turn", "abort", "worker"]);
      }
    }
  }
});

test("Quit preservation runs only after quiescence and before the exact session context closes", async () => {
  for (const scenario of ["quit", "reload", "new", "resume", "fork", "late-delivery", "late-queue", "late-session", "worker-error", "prepare-error", "preservation-error"] as const) {
    const contexts = createTelegramSessionContextStore<ExtensionContext>();
    const ctx = createLifecycleContext();
    contexts.set(ctx);
    const events: string[] = [];
    let current: (() => boolean) | undefined;
    const runtime = createTelegramBridgeSessionLifecycleAssembly({
      contextStore: contexts,
      queue: {
        getCurrentModel: () => undefined, loadConfig: async () => {}, setQueuedItems() {},
        setCurrentModel() {}, setPendingModelSwitch() {}, syncCounters() {}, syncFlags() {},
        bindDeferredDispatchContext() {}, prepareTempDir: async () => {}, updateStatus() {},
        unbindDeferredDispatchContext() {}, discardQueuedItems() {}, clearModelMenuState() {},
        getActiveTurnChatId: () => undefined, clearPreview: async () => {}, clearActiveTurn() {}, clearAbort() {},
      },
      follower: {
        registrationState: { getTarget: () => undefined, isRegistered: () => false },
        registrationRuntime: {}, instanceId: "leader", getLeaderState: () => ({ kind: "unlocked" }),
        suspendPolling: async () => {
          events.push("polling");
          if (scenario === "late-queue") contexts.set(ctx);
        }, updateStatus() {},
        recordRuntimeEvent(_category: string, _error: unknown, details?: { phase?: string }) {
          events.push(String(details?.phase));
        },
      },
      services: {
        resumeGroupedInput() {}, suspendGroupedInput() {},
        delivery: { onSessionStart: async () => {}, onSessionShutdown: async () => {
          events.push("delivery");
          if (scenario === "late-delivery") contexts.set(ctx);
        } },
        polling: { onSessionStart: async () => {} },
        inboundWorker: { async onSessionShutdown() {
          events.push("worker");
          if (scenario === "worker-error") throw new Error("worker stop failed");
          if (scenario === "late-session") contexts.set(ctx);
        } },
        capabilityMonitor: { start() {}, stop() {} }, queueWatchdog: { start() {}, stop() {} },
        prepareThreadPreservationOnQuit(isCurrent: () => boolean) {
          events.push("prepare");
          if (scenario === "prepare-error") throw new Error("preparation unavailable");
          current = isCurrent;
          return async () => {
            assert.equal(isCurrent(), true);
            assert.deepEqual(events, ["prepare", "delivery", "polling", "worker"]);
            events.push("preserve");
            if (scenario === "preservation-error") throw new Error("publication failed");
          };
        },
      },
    } as unknown as Parameters<typeof createTelegramBridgeSessionLifecycleAssembly>[0]);
    const reason = ["reload", "new", "resume", "fork"].includes(scenario) ? scenario : "quit";
    const shutdown = runtime.onSessionShutdown({ type: "session_shutdown", reason } as never, ctx);
    if (scenario === "worker-error") await assert.rejects(shutdown, /worker stop failed/);
    else await shutdown;
    assert.equal(events.includes("preserve"), scenario === "quit" || scenario === "preservation-error", scenario);
    if (["reload", "new", "resume", "fork"].includes(scenario)) assert.equal(events.includes("prepare"), false);
    if (scenario === "prepare-error" || scenario === "preservation-error") {
      assert.ok(events.includes("preserve-thread-on-quit"));
    }
    if (scenario.startsWith("late-") || scenario === "worker-error") assert.equal(contexts.get(), ctx);
    else assert.equal(contexts.get(), undefined);
    if (scenario === "late-delivery") assert.equal(events.includes("polling"), false);
    if (scenario === "late-delivery" || scenario === "late-queue") assert.equal(events.includes("worker"), false);
    if (scenario !== "worker-error" && current) assert.equal(current(), false);
  }
});

test("Session context store accepts only the current explicit session identity", () => {
  type Context = { session: object };
  const store = createTelegramSessionContextStore<Context>({
    getIdentity: (ctx) => ctx.session,
  });
  const currentSession = {};
  const currentStart = { session: currentSession };
  const currentEvent = { session: currentSession };
  const unseenStaleEvent = { session: {} };

  const generation = store.set(currentStart);
  assert.equal(store.isCurrent(currentEvent, generation), true);
  assert.equal(store.isCurrent(unseenStaleEvent, generation), false);
  assert.equal(store.isCurrent(unseenStaleEvent), false);
  assert.equal(store.getGeneration(), generation);
});

test("Lifecycle composition skips old shutdown extras after replacement during await", async () => {
  let active = true;
  let releaseBase: (() => void) | undefined;
  const baseBlocked = new Promise<void>((resolve) => {
    releaseBase = resolve;
  });
  const events: string[] = [];
  const ctx = createLifecycleContext();
  const hooks = appendTelegramLifecycleHooks(
    {
      onSessionStart: async () => {},
      onSessionShutdown: async () => {
        events.push("base-start");
        await baseBlocked;
        events.push("base-end");
      },
    },
    {
      onSessionShutdown: async () => {
        events.push("extra-shutdown");
      },
    },
    () => active,
  );

  const shutdown = hooks.onSessionShutdown({} as never, ctx);
  await Promise.resolve();
  active = false;
  releaseBase?.();
  await shutdown;

  assert.deepEqual(events, ["base-start", "base-end"]);
});

test("Lifecycle helpers compose session hooks in order", async () => {
  const events: string[] = [];
  const hooks = appendTelegramLifecycleHooks(
    {
      onSessionStart: async () => {
        events.push("base-start");
      },
      onSessionShutdown: async () => {
        events.push("base-shutdown");
      },
    },
    {
      onSessionStart: async () => {
        events.push("extra-start");
      },
      onSessionShutdown: async () => {
        events.push("extra-shutdown");
      },
    },
  );
  await hooks.onSessionStart({} as never, createLifecycleContext());
  await hooks.onSessionShutdown({} as never, createLifecycleContext());
  assert.deepEqual(events, [
    "base-start",
    "extra-start",
    "base-shutdown",
    "extra-shutdown",
  ]);
});

test("Compaction observer mirrors active work with native typing", () => {
  const events: string[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const observer = createTelegramCompactionObserverRuntime({
    setCompactionInProgress(inProgress) {
      events.push(`compact:${String(inProgress)}`);
    },
    updateStatus() {
      events.push("status");
    },
    startTypingLoop() {
      events.push("typing:start");
    },
    stopTypingLoop() {
      events.push("typing:stop");
    },
    requestDeferredDispatchNextQueuedTelegramTurn(dispatch) {
      events.push("dispatch:request");
      dispatch(createLifecycleContext());
    },
    dispatchNextQueuedTelegramTurn() {
      events.push("dispatch");
    },
    recordRuntimeEvent(category, error) {
      events.push(`${category}:${(error as Error).message}`);
    },
    timeoutMs: 10,
    setTimer(callback) {
      nextTimer += 1;
      timers.set(nextTimer, callback);
      return nextTimer;
    },
    clearTimer(timer) {
      timers.delete(timer as number);
    },
  });
  observer.onSessionBeforeCompact({} as never, createLifecycleContext());
  observer.onSessionCompact({} as never, createLifecycleContext());
  assert.deepEqual(events, [
    "compact:true",
    "typing:start",
    "status",
    "compact:false",
    "typing:stop",
    "status",
    "dispatch:request",
    "dispatch",
  ]);
});

test("Compaction observer keeps native typing for non-turn compaction", () => {
  const events: string[] = [];
  let timerCallback: (() => void) | undefined;
  const observer = createTelegramCompactionObserverRuntime({
    setCompactionInProgress(inProgress) {
      events.push(`compact:${String(inProgress)}`);
    },
    updateStatus() {
      events.push("status");
    },
    startTypingLoop() {
      events.push("typing:start");
    },
    stopTypingLoop() {
      events.push("typing:stop");
    },
    requestDeferredDispatchNextQueuedTelegramTurn(dispatch) {
      events.push("dispatch:request");
      dispatch(createLifecycleContext());
    },
    dispatchNextQueuedTelegramTurn() {
      events.push("dispatch");
    },
    setTimer(callback) {
      timerCallback = callback;
      return 1;
    },
    clearTimer() {
      timerCallback = undefined;
    },
  });
  observer.onSessionBeforeCompact({} as never, createLifecycleContext());
  observer.onSessionCompact({} as never, createLifecycleContext());
  observer.onSessionBeforeCompact({} as never, createLifecycleContext());
  timerCallback?.();
  observer.onSessionShutdown();
  assert.deepEqual(events, [
    "compact:true",
    "typing:start",
    "status",
    "compact:false",
    "typing:stop",
    "status",
    "dispatch:request",
    "dispatch",
    "compact:true",
    "typing:start",
    "status",
    "compact:false",
    "typing:stop",
    "status",
    "dispatch:request",
    "dispatch",
  ]);
});

test("Compaction observer settles immediately on the native failure event", () => {
  const events: string[] = [];
  const observer = createTelegramCompactionObserverRuntime({
    setCompactionInProgress(inProgress) {
      events.push(`compact:${String(inProgress)}`);
    },
    updateStatus() {
      events.push("status");
    },
    startTypingLoop() {
      events.push("typing:start");
    },
    stopTypingLoop() {
      events.push("typing:stop");
    },
    requestDeferredDispatchNextQueuedTelegramTurn(dispatch) {
      events.push("dispatch:request");
      dispatch(createLifecycleContext());
    },
    dispatchNextQueuedTelegramTurn() {
      events.push("dispatch");
    },
    onCompactionAbandoned() {
      events.push("activity:compact-abandoned");
    },
  });
  const ctx = createLifecycleContext();
  observer.onSessionBeforeCompact({} as never, ctx);
  observer.onSessionCompactFailed(
    {
      type: "session_compact_failed",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      fromExtension: false,
      errorMessage: "Auto-compaction failed: boom",
    },
    ctx,
  );

  assert.deepEqual(events, [
    "compact:true",
    "typing:start",
    "status",
    "compact:false",
    "typing:stop",
    "status",
    "activity:compact-abandoned",
    "dispatch:request",
    "dispatch",
  ]);
});

test("Compaction observer sends native typing only to the resolved thread", async () => {
  const runtime = createTelegramBridgeRuntime();
  const actions: Array<string> = [];
  const startTyping = createTelegramTypingLoopStarter({
    failureLog: createPassthroughFailureLog(),
    typing: runtime.typing,
    getDefaultChatId: () => 77,
    sendTypingAction: async (chatId, options) => {
      actions.push(`thread:${chatId}:${options?.message_thread_id ?? "all"}`);
    },
    updateStatus: () => {},
    intervalMs: 60_000,
  });
  const observer = createTelegramCompactionObserverRuntime({
    setCompactionInProgress: runtime.lifecycle.setCompactionInProgress,
    updateStatus: () => {},
    startTypingLoop: (ctx) =>
      startTyping(ctx, 77, { target: { chatId: 77, threadId: 12 } }),
    stopTypingLoop: runtime.typing.stop,
    requestDeferredDispatchNextQueuedTelegramTurn: () => {},
    dispatchNextQueuedTelegramTurn: () => {},
  });

  observer.onSessionBeforeCompact({} as never, createLifecycleContext());
  await new Promise<void>((resolve) => setImmediate(resolve));
  observer.onSessionCompact({} as never, createLifecycleContext());
  await runtime.typing.waitForIdle();

  assert.deepEqual(actions, ["thread:77:12"]);
  assert.equal(runtime.lifecycle.isCompactionInProgress(), false);
});

test("Compaction observer preserves an existing agent typing loop", async () => {
  const runtime = createTelegramBridgeRuntime();
  const startTyping = createTelegramTypingLoopStarter({
    failureLog: createPassthroughFailureLog(),
    typing: runtime.typing,
    getDefaultChatId: () => 77,
    sendTypingAction: async () => {},
    updateStatus: () => {},
    intervalMs: 60_000,
  });
  const target = { chatId: 77, threadId: 12 };
  assert.equal(startTyping(createLifecycleContext(), 77, { target }), true);
  const observer = createTelegramCompactionObserverRuntime({
    setCompactionInProgress: runtime.lifecycle.setCompactionInProgress,
    updateStatus: () => {},
    startTypingLoop: (ctx) => startTyping(ctx, 77, { target }),
    stopTypingLoop: runtime.typing.stop,
    requestDeferredDispatchNextQueuedTelegramTurn: () => {},
    dispatchNextQueuedTelegramTurn: () => {},
  });

  observer.onSessionBeforeCompact({} as never, createLifecycleContext());
  observer.onSessionCompact({} as never, createLifecycleContext());

  assert.equal(runtime.typing.stop(), true);
  await runtime.typing.waitForIdle();
  assert.equal(runtime.lifecycle.isCompactionInProgress(), false);
});

test("Compaction observer keeps ownership of its own typing loop across a repeated start", async () => {
  const runtime = createTelegramBridgeRuntime();
  const startTyping = createTelegramTypingLoopStarter({
    failureLog: createPassthroughFailureLog(),
    typing: runtime.typing,
    getDefaultChatId: () => 77,
    sendTypingAction: async () => {},
    updateStatus: () => {},
    intervalMs: 60_000,
  });
  const target = { chatId: 77, threadId: 12 };
  const observer = createTelegramCompactionObserverRuntime({
    setCompactionInProgress: runtime.lifecycle.setCompactionInProgress,
    updateStatus: () => {},
    startTypingLoop: (ctx) => startTyping(ctx, 77, { target }),
    stopTypingLoop: runtime.typing.stop,
    requestDeferredDispatchNextQueuedTelegramTurn: () => {},
    dispatchNextQueuedTelegramTurn: () => {},
    setTimer: () => 1,
    clearTimer: () => {},
  });

  observer.onSessionBeforeCompact({} as never, createLifecycleContext());
  // The shared loop answers false for the observer's own running loop; that is not an agent's loop.
  observer.onSessionBeforeCompact({} as never, createLifecycleContext());
  observer.onSessionCompact({} as never, createLifecycleContext());

  assert.equal(runtime.typing.stop(), false, "Completion stopped the loop the observer started");
  await runtime.typing.waitForIdle();
});

function runCompactionObserver(events: TelegramCompactionObserverEvent[]) {
  let state = createTelegramCompactionObserverState();
  const effects: string[] = [];
  for (const event of events) {
    const next = transitionTelegramCompactionObserver(state, event);
    state = next.state;
    effects.push(...next.effects.map((effect) => effect.type === "setInProgress" ? `inProgress:${effect.inProgress}` : effect.type));
  }
  return { state, effects };
}

test("Compaction observer machine stops only a loop it owns and releases on every terminal path", () => {
  const owned = runCompactionObserver([{ type: "beforeCompact" }, { type: "typingStarted", started: true }, { type: "compacted" }]);
  assert.deepEqual(owned.effects, [
    "inProgress:true", "startTyping", "updateStatus", "armTimer",
    "cancelTimer", "inProgress:false", "stopTyping", "updateStatus", "requestDispatch",
  ]);
  const agentLoop = runCompactionObserver([{ type: "beforeCompact" }, { type: "typingStarted", started: false }, { type: "compactFailed" }]);
  assert.equal(agentLoop.effects.includes("stopTyping"), false, "An agent's loop survives compaction");
  assert.deepEqual(agentLoop.effects.slice(-2), ["abandoned", "requestDispatch"]);
  const sticky = runCompactionObserver([
    { type: "beforeCompact" }, { type: "typingStarted", started: true },
    { type: "beforeCompact" }, { type: "typingStarted", started: false },
  ]);
  assert.equal(sticky.state.typingOwned, true);
});

test("Compaction observer machine fences timers by observation and by context", () => {
  const stale = runCompactionObserver([
    { type: "beforeCompact" }, { type: "beforeCompact" },
    { type: "timerFired", observation: 1, contextActive: true },
  ]);
  assert.equal(stale.state.observation, 2, "A superseded timer cannot release the current observation");
  const replaced = runCompactionObserver([{ type: "beforeCompact" }, { type: "timerFired", observation: 1, contextActive: false }]);
  assert.equal(replaced.state.observation, null);
  assert.equal(replaced.effects.includes("inProgress:false"), false, "A replaced context's timer releases nothing");
  const timedOut = runCompactionObserver([{ type: "beforeCompact" }, { type: "timerFired", observation: 1, contextActive: true }]);
  assert.deepEqual(timedOut.effects.slice(-3), ["updateStatus", "recordTimeout", "requestDispatch"]);
});

test("Compaction observer unrefs fallback timers when supported", () => {
  const events: string[] = [];
  const observer = createTelegramCompactionObserverRuntime({
    setCompactionInProgress: () => {},
    updateStatus: () => {},
    requestDeferredDispatchNextQueuedTelegramTurn: () => {},
    dispatchNextQueuedTelegramTurn: () => {},
    setTimer(callback) {
      assert.equal(typeof callback, "function");
      return {
        unref() {
          events.push("unref");
        },
      } as ReturnType<typeof setTimeout>;
    },
    clearTimer() {},
  });
  observer.onSessionBeforeCompact({} as never, createLifecycleContext());
  assert.deepEqual(events, ["unref"]);
});

test("Compaction observer stops typing on timeout and shutdown", () => {
  const events: string[] = [];
  let timerCallback: (() => void) | undefined;
  const observer = createTelegramCompactionObserverRuntime({
    setCompactionInProgress(inProgress) {
      events.push(`compact:${String(inProgress)}`);
    },
    updateStatus() {
      events.push("status");
    },
    startTypingLoop() {
      events.push("typing:start");
    },
    stopTypingLoop() {
      events.push("typing:stop");
    },
    requestDeferredDispatchNextQueuedTelegramTurn() {
      events.push("dispatch:request");
    },
    dispatchNextQueuedTelegramTurn() {
      events.push("dispatch");
    },
    recordRuntimeEvent(category, error) {
      events.push(`${category}:${(error as Error).message}`);
    },
    onCompactionAbandoned() {
      events.push("activity:compact-abandoned");
    },
    setTimer(callback) {
      timerCallback = callback;
      return 1;
    },
    clearTimer() {
      timerCallback = undefined;
    },
  });
  observer.onSessionBeforeCompact({} as never, createLifecycleContext());
  timerCallback?.();
  observer.onSessionBeforeCompact({} as never, createLifecycleContext());
  observer.onSessionShutdown();
  assert.deepEqual(events, [
    "compact:true",
    "typing:start",
    "status",
    "compact:false",
    "typing:stop",
    "status",
    "compact:Compaction observer timed out",
    "dispatch:request",
    "compact:true",
    "typing:start",
    "status",
    "typing:stop",
  ]);
});

test("Superseded compaction timeout cannot release the current observation", () => {
  const timers: Array<() => void> = [];
  const effects: string[] = [];
  const observer = createTelegramCompactionObserverRuntime({
    setCompactionInProgress: (value) => { effects.push(`active:${value}`); },
    updateStatus: () => {},
    requestDeferredDispatchNextQueuedTelegramTurn: () => { effects.push("dispatch"); },
    dispatchNextQueuedTelegramTurn: () => {},
    onCompactionAbandoned: () => { effects.push("abandoned"); },
    setTimer: (callback) => { timers.push(callback); return timers.length; },
    clearTimer: () => {},
  });
  const ctx = createLifecycleContext();
  observer.onSessionBeforeCompact({} as never, ctx);
  observer.onSessionBeforeCompact({} as never, ctx);
  timers[0]!();
  assert.deepEqual(effects, ["active:true", "active:true"]);
  timers[1]!();
  assert.deepEqual(effects, ["active:true", "active:true", "active:false", "dispatch"]);
  timers[1]!();
  assert.equal(effects.length, 4);
  observer.onSessionCompactFailed({} as never, ctx);
  assert.deepEqual(effects.slice(4), ["active:false", "abandoned", "dispatch"]);
});

test("Stale compaction completion cannot cancel the replacement context timeout", () => {
  const oldContext = createLifecycleContext();
  const currentContext = createLifecycleContext();
  let current = oldContext;
  let timer: (() => void) | undefined;
  let abandoned = 0;
  const observer = createTelegramCompactionObserverRuntime({
    isContextActive: (ctx) => ctx === current,
    setCompactionInProgress: () => {},
    updateStatus: () => {},
    requestDeferredDispatchNextQueuedTelegramTurn: () => {},
    dispatchNextQueuedTelegramTurn: () => {},
    onCompactionAbandoned: () => { abandoned += 1; },
    setTimer: (callback) => { timer = callback; return 1; },
    clearTimer: () => { timer = undefined; },
  });
  observer.onSessionBeforeCompact({} as never, oldContext);
  current = currentContext;
  observer.onSessionBeforeCompact({} as never, currentContext);
  const replacementTimer = timer;
  observer.onSessionCompact({} as never, oldContext);
  observer.onSessionCompactFailed({} as never, oldContext);
  assert.equal(timer, replacementTimer);
  timer!();
  assert.equal(abandoned, 0);
  observer.onSessionCompactFailed({} as never, currentContext);
  assert.equal(abandoned, 1);
});

test("Message activity hooks re-arm typing for active Telegram turns", async () => {
  const events: string[] = [];
  let active = true;
  const hooks = createTelegramMessageActivityTypingHooks({
    hasActiveTurn() {
      return active;
    },
    startTypingLoop() {
      events.push("typing:start");
    },
    async onMessageStart() {
      events.push("message:start");
    },
    async onMessageUpdate() {
      events.push("message:update");
    },
  });
  await hooks.onMessageStart(
    { message: {} as never },
    createLifecycleContext(),
  );
  active = false;
  await hooks.onMessageUpdate(
    { message: {} as never, assistantMessageEvent: {} as never },
    createLifecycleContext(),
  );
  assert.deepEqual(events, [
    "typing:start",
    "message:start",
    "typing:start",
    "message:update",
  ]);
});

test("Message activity hooks preserve typing after transient preview errors", async () => {
  const events: string[] = [];
  const hooks = createTelegramMessageActivityTypingHooks({
    hasActiveTurn: () => true,
    startTypingLoop: () => {
      events.push("typing:start");
    },
    onMessageStart: async () => {
      events.push("message:start");
    },
    onMessageUpdate: async () => {
      events.push("message:update");
      throw new Error("websocket disconnected");
    },
    recordRuntimeEvent: (category, error, details) => {
      const message = error instanceof Error ? error.message : String(error);
      events.push(`${category}:${message}:${details?.phase}`);
    },
  });

  await hooks.onMessageUpdate(
    { message: {} as never, assistantMessageEvent: {} as never },
    createLifecycleContext(),
  );

  assert.deepEqual(events, [
    "typing:start",
    "message:update",
    "message-activity:websocket disconnected:update",
    "typing:start",
  ]);
});

test("Lifecycle helpers register pi hooks and delegate to handlers", async () => {
  const harness = createLifecycleApiHarness();
  const events: string[] = [];
  const turnMessage = { customType: "telegram-turn", content: "Fixture turn instructions", display: false };
  let active = true;
  registerTelegramLifecycleHooks(harness.api, {
    isSessionActive: () => active,
    onTurnEnd: () => {
      events.push("turn-end");
      return { entries: [], continue: true };
    },
    onSessionStart: async () => {
      events.push("session-start");
    },
    onSessionShutdown: async () => {
      events.push("session-shutdown");
    },
    onSessionBeforeCompact: () => {
      events.push("session-before-compact");
    },
    onSessionCompact: () => {
      events.push("session-compact");
    },
    onSessionCompactFailed: () => {
      events.push("session-compact-failed");
    },
    onBeforeAgentStart: (event) => {
      events.push("before-agent-start");
      return "prompt" in event && event.prompt === "[telegram] fixture" ? { message: turnMessage } : { systemPrompt: event.systemPrompt };
    },
    onModelSelect: () => {
      events.push("model-select");
    },
    onAgentStart: async () => {
      events.push("agent-start");
    },
    onToolExecutionStart: () => {
      events.push("tool-start");
    },
    onToolExecutionUpdate: () => {
      events.push("tool-update");
    },
    onToolExecutionEnd: () => {
      events.push("tool-end");
    },
    onMessageStart: async () => {
      events.push("message-start");
    },
    onMessageUpdate: async () => {
      events.push("message-update");
    },
    onMessageEnd: () => {
      events.push("message-end");
    },
    onUiPromptStart: () => {
      events.push("ui-prompt-start");
    },
    onUiPromptEnd: () => {
      events.push("ui-prompt-end");
    },
    onAgentEnd: async () => {
      events.push("agent-end");
    },
  });
  assert.deepEqual(
    [...harness.handlers.keys()],
    [
      "input",
      "session_start",
      "session_shutdown",
      "session_before_compact",
      "session_compact",
      "session_compact_failed",
      "before_agent_start",
      "model_select",
      "agent_start",
      "turn_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "message_start",
      "message_update",
      "message_end",
      "ui_prompt_start",
      "ui_prompt_end",
      "agent_end",
      "agent_settled",
    ],
  );
  const ctx = createLifecycleContext();
  await getRequiredLifecycleHandler(harness.handlers, "input")({}, ctx);
  await getRequiredLifecycleHandler(harness.handlers, "session_start")({}, ctx);
  await getRequiredLifecycleHandler(harness.handlers, "session_shutdown")(
    {},
    ctx,
  );
  await getRequiredLifecycleHandler(harness.handlers, "session_before_compact")(
    {},
    ctx,
  );
  await getRequiredLifecycleHandler(harness.handlers, "session_compact")(
    {},
    ctx,
  );
  await getRequiredLifecycleHandler(
    harness.handlers,
    "session_compact_failed",
  )({}, ctx);
  const beforeAgentStartResult = await getRequiredLifecycleHandler(
    harness.handlers,
    "before_agent_start",
  )({ systemPrompt: ["base", "project context"] }, ctx);
  await getRequiredLifecycleHandler(harness.handlers, "model_select")({}, ctx);
  await getRequiredLifecycleHandler(harness.handlers, "agent_start")({}, ctx);
  const step = await getRequiredLifecycleHandler(harness.handlers, "turn_end")({}, ctx);
  assert.deepEqual(step, { entries: [], continue: true });
  active = false;
  assert.equal(await getRequiredLifecycleHandler(harness.handlers, "turn_end")({}, ctx), undefined);
  active = true;
  await getRequiredLifecycleHandler(harness.handlers, "tool_execution_start")(
    {},
    ctx,
  );
  await getRequiredLifecycleHandler(harness.handlers, "tool_execution_update")(
    {},
    ctx,
  );
  await getRequiredLifecycleHandler(harness.handlers, "tool_execution_end")(
    {},
    ctx,
  );
  await getRequiredLifecycleHandler(harness.handlers, "message_start")({}, ctx);
  await getRequiredLifecycleHandler(harness.handlers, "message_update")(
    {},
    ctx,
  );
  await getRequiredLifecycleHandler(harness.handlers, "message_end")({}, ctx);
  await getRequiredLifecycleHandler(harness.handlers, "ui_prompt_start")(
    {},
    ctx,
  );
  await getRequiredLifecycleHandler(harness.handlers, "ui_prompt_end")({}, ctx);
  await getRequiredLifecycleHandler(harness.handlers, "agent_end")({}, ctx);
  await getRequiredLifecycleHandler(harness.handlers, "agent_settled")({}, ctx);
  assert.deepEqual(beforeAgentStartResult, {
    systemPrompt: ["base", "project context"],
  });
  assert.deepEqual(events, [
    "session-start",
    "session-shutdown",
    "session-before-compact",
    "session-compact",
    "session-compact-failed",
    "before-agent-start",
    "model-select",
    "agent-start",
    "turn-end",
    "tool-start",
    "tool-update",
    "tool-end",
    "message-start",
    "message-update",
    "message-end",
    "ui-prompt-start",
    "ui-prompt-end",
    "agent-end",
  ]);
  const messageOnlyResult = await getRequiredLifecycleHandler(harness.handlers, "before_agent_start")(
    { prompt: "[telegram] fixture", systemPrompt: "base" }, ctx,
  );
  assert.deepEqual(messageOnlyResult, { message: turnMessage });
});
