/**
 * Regression tests for Telegram lifecycle hook helpers
 * Covers pi lifecycle hook registration and hook composition ordering
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  appendTelegramLifecycleHooks,
  createTelegramCompactionObserverRuntime,
  createTelegramMessageActivityTypingHooks,
  registerTelegramLifecycleHooks,
} from "../lib/lifecycle.ts";
import type { ExtensionAPI, ExtensionContext } from "../lib/pi.ts";

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
    { message: {} as never },
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
    { message: {} as never },
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
    onBeforeAgentStart: () => {
      events.push("before-agent-start");
      return { systemPrompt: "prompt" };
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
    onToolExecutionEnd: () => {
      events.push("tool-end");
    },
    onMessageStart: async () => {
      events.push("message-start");
    },
    onMessageUpdate: async () => {
      events.push("message-update");
    },
    onAgentEnd: async () => {
      events.push("agent-end");
    },
  });
  assert.deepEqual(
    [...harness.handlers.keys()],
    [
      "session_start",
      "session_shutdown",
      "session_before_compact",
      "session_compact",
      "before_agent_start",
      "model_select",
      "agent_start",
      "tool_execution_start",
      "tool_execution_end",
      "message_start",
      "message_update",
      "agent_end",
    ],
  );
  const ctx = createLifecycleContext();
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
  const beforeAgentStartResult = await getRequiredLifecycleHandler(
    harness.handlers,
    "before_agent_start",
  )({}, ctx);
  await getRequiredLifecycleHandler(harness.handlers, "model_select")({}, ctx);
  await getRequiredLifecycleHandler(harness.handlers, "agent_start")({}, ctx);
  await getRequiredLifecycleHandler(harness.handlers, "tool_execution_start")(
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
  await getRequiredLifecycleHandler(harness.handlers, "agent_end")({}, ctx);
  assert.deepEqual(beforeAgentStartResult, { systemPrompt: "prompt" });
  assert.deepEqual(events, [
    "session-start",
    "session-shutdown",
    "session-before-compact",
    "session-compact",
    "before-agent-start",
    "model-select",
    "agent-start",
    "tool-start",
    "tool-end",
    "message-start",
    "message-update",
    "agent-end",
  ]);
});
