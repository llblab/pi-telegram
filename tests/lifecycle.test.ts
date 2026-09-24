/**
 * Regression tests for Telegram lifecycle hook helpers
 * Covers pi lifecycle hook registration and hook composition ordering
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  appendTelegramLifecycleHooks,
  createTelegramBridgeSessionLifecycleAssembly,
  createTelegramCompactionObserverRuntime,
  createTelegramSessionContextStore,
  createTelegramSessionGenerationFence,
  createTelegramMessageActivityTypingHooks,
  registerTelegramLifecycleHooks,
} from "../lib/lifecycle.ts";
import type { ExtensionAPI, ExtensionContext } from "../lib/pi.ts";
import {
  createTelegramBridgeRuntime,
  createTelegramTypingLoopStarter,
} from "../lib/runtime.ts";

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
    "activity:compact-abandoned",
    "dispatch:request",
    "compact:true",
    "typing:start",
    "status",
    "typing:stop",
  ]);
});

test("Superseded compaction timeout cannot abandon the current observation", () => {
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
  assert.deepEqual(effects, ["active:true", "active:true", "active:false", "abandoned", "dispatch"]);
  timers[1]!();
  assert.equal(effects.length, 5);
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
  registerTelegramLifecycleHooks(harness.api, {
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
      return { systemPrompt: event.systemPrompt };
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
});
