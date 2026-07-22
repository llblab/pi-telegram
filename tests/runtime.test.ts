/**
 * Regression tests for the runtime domain
 * Covers lib/runtime.ts state helpers, controllers, lifecycle hooks, typing, and progress primitives
 */

import assert from "node:assert/strict";
import testRoot, { type TestContext } from "node:test";

import * as Runtime from "../lib/runtime.ts";
import { createTelegramThreadTarget } from "../lib/target.ts";

type RuntimeTestHandler = (context: TestContext) => void | Promise<void>;
function test(name: string, fn: RuntimeTestHandler): void {
  void testRoot(name, { concurrency: false, timeout: 5000 }, fn);
}

async function flushMicrotasks(iterations = 10): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

test("Runtime facade binds grouped operations to one bridge state", () => {
  const state = Runtime.createTelegramBridgeRuntimeState();
  const runtime = Runtime.createTelegramBridgeRuntime(state);
  assert.equal(runtime.state, state);
  assert.equal(runtime.queue.allocateItemOrder(), 0);
  assert.equal(runtime.queue.allocateControlOrder(), 0);
  runtime.queue.syncCounters({ nextPriorityReactionOrder: 5 });
  assert.equal(runtime.queue.getNextPriorityReactionOrder(), 5);
  runtime.queue.incrementNextPriorityReactionOrder();
  assert.equal(runtime.queue.getNextPriorityReactionOrder(), 6);
  runtime.lifecycle.setDispatchPending(true);
  runtime.lifecycle.setCompactionInProgress(true);
  runtime.lifecycle.setActiveToolExecutions(3);
  runtime.lifecycle.setFoldQueuedPromptsIntoHistory(true);
  assert.equal(runtime.lifecycle.hasDispatchPending(), true);
  assert.equal(runtime.lifecycle.isCompactionInProgress(), true);
  assert.equal(runtime.lifecycle.getActiveToolExecutions(), 3);
  runtime.lifecycle.clearDispatchPending();
  runtime.lifecycle.resetActiveToolExecutions();
  assert.equal(runtime.lifecycle.hasDispatchPending(), false);
  assert.equal(runtime.lifecycle.getActiveToolExecutions(), 0);
  assert.equal(runtime.lifecycle.shouldFoldQueuedPromptsIntoHistory(), true);
  assert.equal(runtime.setup.start(), true);
  assert.equal(runtime.setup.isInProgress(), true);
  runtime.setup.finish();
  assert.equal(runtime.setup.isInProgress(), false);
  let abortCount = 0;
  runtime.abort.setHandler(() => {
    abortCount += 1;
  });
  assert.equal(runtime.abort.hasHandler(), true);
  assert.equal(runtime.abort.abortTurn(), true);
  assert.equal(abortCount, 1);
  runtime.abort.clearHandler();
  assert.equal(runtime.abort.hasHandler(), false);
});

test("Runtime state helpers allocate queue order and manage typing loops", async () => {
  const state = Runtime.createTelegramBridgeRuntimeState();
  assert.equal(Runtime.allocateTelegramQueueItemOrder(state), 0);
  assert.equal(Runtime.allocateTelegramQueueItemOrder(state), 1);
  assert.equal(Runtime.allocateTelegramQueueControlOrder(state), 0);
  assert.equal(Runtime.getNextTelegramPriorityReactionOrder(state), 0);
  Runtime.incrementNextTelegramPriorityReactionOrder(state);
  assert.equal(Runtime.getNextTelegramPriorityReactionOrder(state), 1);
  Runtime.syncTelegramQueueRuntimeCounters(state, {
    nextQueuedTelegramItemOrder: 10,
    nextQueuedTelegramControlOrder: 20,
    nextPriorityReactionOrder: 30,
  });
  assert.equal(Runtime.allocateTelegramQueueItemOrder(state), 10);
  assert.equal(Runtime.allocateTelegramQueueControlOrder(state), 20);
  assert.equal(Runtime.getNextTelegramPriorityReactionOrder(state), 30);
  assert.equal(Runtime.hasTelegramDispatchPending(state), false);
  assert.equal(Runtime.isTelegramCompactionInProgress(state), false);
  assert.equal(Runtime.getActiveTelegramToolExecutions(state), 0);
  assert.equal(Runtime.shouldFoldQueuedPromptsIntoHistory(state), false);
  Runtime.syncTelegramLifecycleRuntimeFlags(state, {
    activeTelegramToolExecutions: 2,
    telegramTurnDispatchPending: true,
    compactionInProgress: true,
    foldQueuedPromptsIntoHistory: true,
  });
  assert.equal(Runtime.hasTelegramDispatchPending(state), true);
  assert.equal(Runtime.isTelegramCompactionInProgress(state), true);
  assert.equal(Runtime.getActiveTelegramToolExecutions(state), 2);
  assert.equal(Runtime.shouldFoldQueuedPromptsIntoHistory(state), true);
  Runtime.clearTelegramDispatchPending(state);
  Runtime.setTelegramCompactionInProgress(state, false);
  Runtime.resetActiveTelegramToolExecutions(state);
  assert.equal(Runtime.hasTelegramDispatchPending(state), false);
  assert.equal(Runtime.getActiveTelegramToolExecutions(state), 0);
  Runtime.setActiveTelegramToolExecutions(state, 1);
  Runtime.setFoldQueuedPromptsIntoHistory(state, false);
  assert.equal(Runtime.startTelegramSetup(state), true);
  assert.equal(Runtime.startTelegramSetup(state), false);
  assert.equal(Runtime.isTelegramSetupInProgress(state), true);
  Runtime.finishTelegramSetup(state);
  assert.equal(Runtime.isTelegramSetupInProgress(state), false);
  let abortCount = 0;
  assert.equal(Runtime.hasTelegramAbortHandler(state), false);
  assert.equal(Runtime.abortTelegramTurn(state), false);
  Runtime.setTelegramAbortHandler(state, () => {
    abortCount += 1;
  });
  assert.equal(Runtime.hasTelegramAbortHandler(state), true);
  assert.equal(Runtime.abortTelegramTurn(state), true);
  assert.equal(abortCount, 1);
  assert.equal(typeof Runtime.getTelegramAbortHandler(state), "function");
  Runtime.clearTelegramAbortHandler(state);
  assert.equal(Runtime.hasTelegramAbortHandler(state), false);
  assert.equal(Runtime.hasTelegramDispatchPending(state), false);
  assert.equal(Runtime.isTelegramCompactionInProgress(state), false);
  assert.equal(Runtime.getActiveTelegramToolExecutions(state), 1);
  assert.equal(Runtime.shouldFoldQueuedPromptsIntoHistory(state), false);
  const typingActions: number[] = [];
  assert.equal(
    Runtime.startTelegramTypingLoop(state, {
      chatId: undefined,
      intervalMs: 1000,
      sendTypingAction: async (chatId) => {
        typingActions.push(chatId);
      },
    }),
    false,
  );
  assert.equal(
    Runtime.startTelegramTypingLoop(state, {
      chatId: 42,
      intervalMs: 1000,
      sendTypingAction: async (chatId) => {
        typingActions.push(chatId);
      },
    }),
    true,
  );
  await flushMicrotasks();
  assert.deepEqual(typingActions, [42]);
  assert.equal(
    Runtime.startTelegramTypingLoop(state, {
      chatId: 43,
      intervalMs: 1000,
      sendTypingAction: async (chatId) => {
        typingActions.push(chatId);
      },
    }),
    true,
  );
  await flushMicrotasks();
  assert.deepEqual(typingActions, [42, 43]);
  assert.equal(Runtime.stopTelegramTypingLoop(state), true);
  assert.equal(Runtime.stopTelegramTypingLoop(state), false);
});

test("Typing loop retargets chat-level activity into the active thread", async () => {
  const state = Runtime.createTelegramBridgeRuntimeState();
  const typingActions: Array<{
    chatId: number;
    threadId?: number;
    aggregate?: boolean;
  }> = [];
  const recordTypingAction = (
    chatId: number,
    options?: { message_thread_id?: number },
  ): void => {
    typingActions.push({
      chatId,
      ...(typeof options?.message_thread_id === "number"
        ? { threadId: options.message_thread_id }
        : {}),
    });
  };
  assert.equal(
    Runtime.startTelegramTypingLoop(state, {
      chatId: 42,
      intervalMs: 1000,
      sendTypingAction: async (chatId, options) => {
        recordTypingAction(chatId, options);
      },
      sendAggregateTypingAction: async (chatId) => {
        typingActions.push({ chatId, aggregate: true });
      },
    }),
    true,
  );
  await flushMicrotasks();
  assert.deepEqual(typingActions, [{ chatId: 42 }]);
  assert.equal(
    Runtime.startTelegramTypingLoop(state, {
      chatId: 42,
      target: createTelegramThreadTarget(42, 99),
      intervalMs: 1000,
      sendTypingAction: async (chatId, options) => {
        recordTypingAction(chatId, options);
      },
      sendAggregateTypingAction: async (chatId) => {
        typingActions.push({ chatId, aggregate: true });
      },
    }),
    true,
  );
  await flushMicrotasks();
  assert.deepEqual(typingActions, [
    { chatId: 42 },
    { chatId: 42, threadId: 99 },
    { chatId: 42, aggregate: true },
  ]);
  assert.equal(Runtime.stopTelegramTypingLoop(state), true);
});

test("Typing loop sends chat actions into thread target and aggregate surface", async () => {
  const state = Runtime.createTelegramBridgeRuntimeState();
  const typingActions: Array<{
    chatId: number;
    threadId?: number;
    aggregate?: boolean;
  }> = [];
  assert.equal(
    Runtime.startTelegramTypingLoop(state, {
      chatId: 42,
      target: createTelegramThreadTarget(42, 99),
      intervalMs: 1000,
      sendTypingAction: async (chatId, options) => {
        typingActions.push({
          chatId,
          threadId: options?.message_thread_id,
        });
      },
      sendAggregateTypingAction: async (chatId) => {
        typingActions.push({ chatId, aggregate: true });
      },
    }),
    true,
  );
  await flushMicrotasks();
  assert.deepEqual(typingActions, [
    { chatId: 42, threadId: 99 },
    { chatId: 42, aggregate: true },
  ]);
  assert.equal(Runtime.stopTelegramTypingLoop(state), true);
});

test("Typing loop idle wait is bounded for slow in-flight chat actions", async () => {
  const state = Runtime.createTelegramBridgeRuntimeState();
  state.typingInFlight = new Promise(() => {});
  const startedAt = Date.now();

  await Runtime.waitForTelegramTypingLoopIdle(state, 1);

  assert.ok(Date.now() - startedAt < 100);
});

test("Abort handler setter and agent-end resetter bind runtime cleanup", () => {
  const runtime = Runtime.createTelegramBridgeRuntime();
  const events: string[] = [];
  const setAbortHandler = Runtime.createTelegramContextAbortHandlerSetter(
    runtime.abort,
  );
  setAbortHandler({
    abort: () => {
      events.push("abort");
    },
  });
  assert.equal(runtime.abort.abortTurn(), true);
  const reset = Runtime.createTelegramAgentEndResetter({
    abort: runtime.abort,
    typing: runtime.typing,
    clearActiveTurn: () => {
      events.push("active");
    },
    resetToolExecutions: () => {
      events.push("tools");
    },
    clearPendingModelSwitch: () => {
      events.push("switch");
    },
    clearDispatchPending: runtime.lifecycle.clearDispatchPending,
  });
  runtime.lifecycle.setDispatchPending(true);
  reset();
  assert.equal(runtime.abort.hasHandler(), false);
  assert.equal(runtime.lifecycle.hasDispatchPending(), false);
  assert.deepEqual(events, ["abort", "active", "tools", "switch"]);
});

test("Prompt dispatch lifecycle owns dispatch flags, typing, and status", () => {
  const runtime = Runtime.createTelegramBridgeRuntime();
  const events: string[] = [];
  const lifecycle = Runtime.createTelegramPromptDispatchLifecycle<{
    id: string;
  }>({
    lifecycle: runtime.lifecycle,
    typing: runtime.typing,
    startTypingLoop: (ctx, chatId) => {
      events.push(`typing:${ctx.id}:${chatId ?? "default"}`);
    },
    updateStatus: (ctx, error) => {
      events.push(`status:${ctx.id}:${error ?? "ok"}`);
    },
    recordRuntimeEvent: (category, error) => {
      const message = error instanceof Error ? error.message : String(error);
      events.push(`event:${category}:${message}`);
    },
  });
  lifecycle.onPromptDispatchStart({ id: "ctx" }, 42);
  assert.equal(runtime.lifecycle.hasDispatchPending(), true);
  lifecycle.onPromptDispatchFailure({ id: "ctx" }, "boom");
  assert.equal(runtime.lifecycle.hasDispatchPending(), false);
  assert.deepEqual(events, [
    "typing:ctx:42",
    "status:ctx:ok",
    "event:dispatch:boom",
    "status:ctx:dispatch failed: boom",
  ]);
});

test("Prompt dispatch lifecycle records stale status failures", () => {
  const runtime = Runtime.createTelegramBridgeRuntime();
  const events: string[] = [];
  const lifecycle = Runtime.createTelegramPromptDispatchLifecycle<{
    id: string;
  }>({
    lifecycle: runtime.lifecycle,
    typing: runtime.typing,
    startTypingLoop: () => {
      events.push("typing");
    },
    updateStatus: () => {
      throw new Error("stale ctx");
    },
    recordRuntimeEvent: (category, error, details) => {
      const message = error instanceof Error ? error.message : String(error);
      events.push(`${category}:${message}:${details?.phase ?? "event"}`);
    },
  });

  assert.doesNotThrow(() => lifecycle.onPromptDispatchStart({ id: "ctx" }));
  assert.equal(runtime.lifecycle.hasDispatchPending(), true);
  assert.doesNotThrow(() =>
    lifecycle.onPromptDispatchFailure({ id: "ctx" }, "boom"),
  );
  assert.equal(runtime.lifecycle.hasDispatchPending(), false);
  assert.deepEqual(events, [
    "typing",
    "dispatch:stale ctx:status-update",
    "dispatch:boom:event",
    "dispatch:stale ctx:status-update",
  ]);
});

test("Prompt dispatch runtime binds typing starter and dispatch lifecycle", async () => {
  const runtime = Runtime.createTelegramBridgeRuntime();
  const sentChatIds: number[] = [];
  const statuses: string[] = [];
  const promptRuntime = Runtime.createTelegramPromptDispatchRuntime<{
    id: string;
  }>({
    lifecycle: runtime.lifecycle,
    typing: runtime.typing,
    getDefaultChatId: () => 7,
    sendTypingAction: async (chatId) => {
      sentChatIds.push(chatId);
    },
    updateStatus: (_ctx, error) => {
      statuses.push(error ?? "ok");
    },
    intervalMs: 1000,
  });
  promptRuntime.onPromptDispatchStart({ id: "ctx" }, 9);
  await flushMicrotasks();
  assert.equal(runtime.lifecycle.hasDispatchPending(), true);
  assert.deepEqual(sentChatIds, [9]);
  promptRuntime.onPromptDispatchFailure({ id: "ctx" }, "boom");
  assert.equal(runtime.lifecycle.hasDispatchPending(), false);
  assert.deepEqual(statuses, ["ok", "dispatch failed: boom"]);
});

test("Typing loop starter uses a conservative native keepalive interval", () => {
  let capturedIntervalMs = 0;
  const startTypingLoop = Runtime.createTelegramTypingLoopStarter<{
    id: string;
  }>({
    typing: {
      start: (deps) => {
        capturedIntervalMs = deps.intervalMs;
        return true;
      },
      stop: () => true,
      waitForIdle: async () => {},
    },
    getDefaultChatId: () => 7,
    sendTypingAction: async () => {},
    updateStatus: () => {},
  });

  startTypingLoop({ id: "ctx" });

  assert.equal(capturedIntervalMs, 2500);
});

test("Typing loop starter sends one thread action and one aggregate action", async () => {
  const state = Runtime.createTelegramBridgeRuntimeState();
  const runtime = Runtime.createTelegramBridgeRuntime(state);
  const actions: string[] = [];
  const startTypingLoop = Runtime.createTelegramTypingLoopStarter<{
    id: string;
  }>({
    typing: runtime.typing,
    getDefaultChatId: () => undefined,
    sendTypingAction: async (chatId, options) => {
      actions.push(`thread:${chatId}:${options?.message_thread_id ?? "all"}`);
    },
    sendAggregateTypingAction: async (chatId) => {
      actions.push(`aggregate:${chatId}`);
    },
    updateStatus: () => {},
    intervalMs: 1000,
  });

  startTypingLoop({ id: "ctx" }, 8, {
    target: createTelegramThreadTarget(8, 44),
  });
  await flushMicrotasks();

  assert.deepEqual(actions, ["thread:8:44", "aggregate:8"]);
  assert.equal(runtime.typing.stop(), true);
});

test("Typing loop skips interval ticks while the previous action is in flight", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setInterval"] });
  const state = Runtime.createTelegramBridgeRuntimeState();
  const runtime = Runtime.createTelegramBridgeRuntime(state);
  let releaseAction: () => void = () => {};
  const pendingAction = new Promise<void>((resolve) => {
    releaseAction = resolve;
  });
  let calls = 0;
  const startTypingLoop = Runtime.createTelegramTypingLoopStarter({
    typing: runtime.typing,
    getDefaultChatId: () => 7,
    sendTypingAction: async () => {
      calls += 1;
      await pendingAction;
    },
    updateStatus: () => {},
    intervalMs: 1000,
  });

  startTypingLoop({ id: "ctx" });
  await flushMicrotasks();
  assert.equal(calls, 1);
  ctx.mock.timers.tick(3000);
  await flushMicrotasks();
  assert.equal(calls, 1);

  releaseAction();
  await flushMicrotasks();
  ctx.mock.timers.tick(1000);
  await flushMicrotasks();
  assert.equal(calls, 2);
  assert.equal(runtime.typing.stop(), true);
  ctx.mock.timers.reset();
});

test("Typing loop starter binds default chat and reports failures", async () => {
  const state = Runtime.createTelegramBridgeRuntimeState();
  const runtime = Runtime.createTelegramBridgeRuntime(state);
  const sentChatIds: number[] = [];
  const statusErrors: string[] = [];
  const runtimeEvents: string[] = [];
  const startTypingLoop = Runtime.createTelegramTypingLoopStarter<{
    id: string;
  }>({
    typing: runtime.typing,
    getDefaultChatId: () => 7,
    sendTypingAction: async (chatId) => {
      sentChatIds.push(chatId);
    },
    updateStatus: (_ctx: { id: string }, error?: string) => {
      if (error) statusErrors.push(error);
    },
    recordRuntimeEvent: (category, error, details) => {
      const message = error instanceof Error ? error.message : String(error);
      runtimeEvents.push(`${category}:${message}:${details?.chatId}`);
    },
    intervalMs: 1000,
  });
  startTypingLoop({ id: "ctx" });
  await flushMicrotasks();
  assert.deepEqual(sentChatIds, [7]);
  assert.deepEqual(statusErrors, []);
  assert.equal(runtime.typing.stop(), true);
  const failingStatusErrors: string[] = [];
  const startFailingTypingLoop = Runtime.createTelegramTypingLoopStarter<{
    id: string;
  }>({
    typing: runtime.typing,
    getDefaultChatId: () => undefined,
    sendTypingAction: async () => {
      throw new Error("boom");
    },
    updateStatus: (_ctx: { id: string }, error?: string) => {
      if (error) failingStatusErrors.push(error);
    },
    recordRuntimeEvent: (category, error, details) => {
      const message = error instanceof Error ? error.message : String(error);
      runtimeEvents.push(`${category}:${message}:${details?.chatId}`);
    },
    intervalMs: 1000,
  });
  startFailingTypingLoop({ id: "ctx" }, 8);
  await flushMicrotasks();
  assert.deepEqual(failingStatusErrors, ["boom"]);
  assert.deepEqual(runtimeEvents, ["typing:boom:8"]);
  assert.equal(runtime.typing.stop(), true);
});

test("Typing loop starter records stale status failures", async () => {
  const state = Runtime.createTelegramBridgeRuntimeState();
  const runtime = Runtime.createTelegramBridgeRuntime(state);
  const runtimeEvents: string[] = [];
  const startTypingLoop = Runtime.createTelegramTypingLoopStarter<{
    id: string;
  }>({
    typing: runtime.typing,
    getDefaultChatId: () => undefined,
    sendTypingAction: async () => {
      throw new Error("typing failed");
    },
    updateStatus: () => {
      throw new Error("stale ctx");
    },
    recordRuntimeEvent: (category, error, details) => {
      const message = error instanceof Error ? error.message : String(error);
      runtimeEvents.push(
        `${category}:${message}:${details?.phase ?? details?.chatId}`,
      );
    },
    intervalMs: 1000,
  });

  startTypingLoop({ id: "ctx" }, 8);
  await flushMicrotasks();

  assert.deepEqual(runtimeEvents, [
    "typing:stale ctx:status-update",
    "typing:typing failed:8",
  ]);
  assert.equal(runtime.typing.stop(), true);
});
