/**
 * Regression tests for the Telegram extension runtime
 * Exercises polling, queue/lifecycle integration, previews, reactions, compaction, and in-flight model switching
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import testRoot, { mock, type TestContext } from "node:test";

import * as Runtime from "../lib/runtime.ts";

type RuntimeTestHandler = (context: TestContext) => void | Promise<void>;
type RuntimeTelegramExtension = (typeof import("../index.ts"))["default"];

function test(name: string, fn: RuntimeTestHandler): void {
  void testRoot(name, { concurrency: false, timeout: 5000 }, fn);
}

let runtimeTelegramExtension: RuntimeTelegramExtension | undefined;
let runtimeAgentDir: string | undefined;

async function ensureRuntimeAgentDir(): Promise<string> {
  if (!runtimeAgentDir) {
    runtimeAgentDir = await mkdtemp(
      join(tmpdir(), "pi-telegram-runtime-agent-"),
    );
    process.env.PI_CODING_AGENT_DIR = runtimeAgentDir;
  }
  return runtimeAgentDir;
}

async function getRuntimeTelegramExtension(): Promise<RuntimeTelegramExtension> {
  if (runtimeTelegramExtension) return runtimeTelegramExtension;
  await ensureRuntimeAgentDir();
  runtimeTelegramExtension = (await import("../index.ts")).default;
  return runtimeTelegramExtension;
}

async function flushMicrotasks(iterations = 10): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

async function waitForEventLoopCondition(
  predicate: () => boolean,
  iterations = 100,
): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for event-loop condition");
}

function parseJsonRequestBody(
  init: RequestInit | undefined,
): Record<string, unknown> | undefined {
  if (typeof init?.body !== "string") return undefined;
  return JSON.parse(init.body) as Record<string, unknown>;
}

function getRuntimeTelegramApiMethod(input: string | URL | Request): string {
  const url = typeof input === "string" ? input : input.toString();
  return url.split("/").at(-1) ?? "";
}

function setRuntimeTestFetch(fetchImpl: typeof fetch): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function createRuntimeTelegramConfigFixture() {
  const agentDir = await ensureRuntimeAgentDir();
  const configPath = join(agentDir, "telegram.json");
  const previousConfig = await readFile(configPath, "utf8").catch(
    () => undefined,
  );
  const isolated = process.env.PI_CODING_AGENT_DIR === agentDir;
  return {
    write: async (config: Record<string, unknown>) => {
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify(config, null, "\t") + "\n",
        "utf8",
      );
    },
    restore: async () => {
      if (isolated) return;
      if (previousConfig === undefined) {
        await rm(configPath, { force: true });
        return;
      }
      await writeFile(configPath, previousConfig, "utf8");
    },
  };
}

async function writeRuntimeTelegramLocks(
  locks: Record<string, unknown>,
): Promise<void> {
  const agentDir = await ensureRuntimeAgentDir();
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "locks.json"),
    JSON.stringify(locks, null, "\t") + "\n",
    "utf8",
  );
}

function createRuntimeDeferredResponse() {
  let resolve: (value: Response) => void = () => {};
  const promise = new Promise<Response>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createRuntimeTelegramApiResponse(result: unknown): Response {
  return { json: async () => ({ ok: true, result }) } as Response;
}

function createRuntimeTelegramApiErrorResponse(
  status: number,
  description: string,
): Response {
  return {
    ok: false,
    status,
    headers: new Headers({ "retry-after": "0" }),
    text: async () => JSON.stringify({ ok: false, description }),
  } as Response;
}

function createRuntimeExtensionContext(
  overrides: Record<string, unknown> = {},
) {
  return {
    hasUI: true,
    model: undefined,
    signal: undefined,
    ui: {
      theme: {
        fg: (_token: string, text: string) => text,
      },
      setStatus: () => {},
      notify: () => {},
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => {},
    ...overrides,
  };
}

type RuntimeModelFixture = {
  provider: string;
  id: string;
  reasoning?: boolean;
};

function createRuntimeModel(
  provider: string,
  id: string,
  reasoning?: boolean,
): RuntimeModelFixture {
  return reasoning === undefined
    ? { provider, id }
    : { provider, id, reasoning };
}

type RuntimeModelContextOptions = {
  model?: RuntimeModelFixture;
  availableModels: RuntimeModelFixture[];
  isIdle?: () => boolean;
  abort?: () => void;
  setStatus?: (slot: string, text: string) => void;
};

function createRuntimeModelContext(options: RuntimeModelContextOptions) {
  return createRuntimeExtensionContext({
    cwd: process.cwd(),
    model: options.model,
    ui: {
      theme: {
        fg: (_token: string, text: string) => text,
      },
      setStatus: options.setStatus ?? (() => {}),
      notify: () => {},
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      refresh: () => {},
      getAvailable: () => options.availableModels,
      isUsingOAuth: () => false,
    },
    getContextUsage: () => undefined,
    isIdle: options.isIdle ?? (() => true),
    abort: options.abort ?? (() => {}),
  });
}

type RuntimeHarnessTextBlock = { type: string; text?: string };
type RuntimeHarnessMessage = string | RuntimeHarnessTextBlock[];

function getRuntimeHarnessTextBlock(
  content: RuntimeHarnessMessage | undefined,
): RuntimeHarnessTextBlock {
  assert.equal(Array.isArray(content), true);
  if (!Array.isArray(content)) throw new Error("Expected text-block message");
  return content[0] ?? { type: "" };
}

function getRuntimeHarnessMessageText(content: RuntimeHarnessMessage): string {
  if (typeof content === "string") return content;
  return getRuntimeHarnessTextBlock(content).text ?? "";
}

function recordRuntimeDispatchEvent(
  events: string[],
  content: RuntimeHarnessMessage,
): void {
  events.push(`dispatch:${getRuntimeHarnessMessageText(content)}`);
}

type RuntimeHarnessHandler = (event: unknown, ctx: unknown) => Promise<unknown>;
type RuntimeHarnessCommand = {
  handler: (args: string, ctx: unknown) => Promise<void>;
};
type RuntimePiHarnessOptions = {
  sendUserMessage?: (content: RuntimeHarnessMessage) => void;
  getThinkingLevel?: () => string;
  setModel?: (model: { provider: string; id: string }) => Promise<boolean>;
  setThinkingLevel?: (level: string) => void;
  getCommands?: () => unknown[];
};

function createRuntimePiHarness(options: RuntimePiHarnessOptions = {}) {
  const handlers = new Map<string, RuntimeHarnessHandler>();
  const commands = new Map<string, RuntimeHarnessCommand>();
  const pi = {
    on: (event: string, handler: RuntimeHarnessHandler) => {
      handlers.set(event, handler);
    },
    registerCommand: (name: string, definition: RuntimeHarnessCommand) => {
      commands.set(name, definition);
    },
    registerTool: () => {},
    sendUserMessage: options.sendUserMessage ?? (() => {}),
    getCommands: options.getCommands ?? (() => []),
    getThinkingLevel: options.getThinkingLevel ?? (() => "medium"),
    ...(options.setModel ? { setModel: options.setModel } : {}),
    ...(options.setThinkingLevel
      ? { setThinkingLevel: options.setThinkingLevel }
      : {}),
  };
  return { handlers, commands, pi: pi as never };
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
    false,
  );
  assert.deepEqual(typingActions, [42]);
  assert.equal(Runtime.stopTelegramTypingLoop(state), true);
  assert.equal(Runtime.stopTelegramTypingLoop(state), false);
});

test("Typing loop idle wait is bounded for slow in-flight chat actions", async () => {
  const state = Runtime.createTelegramBridgeRuntimeState();
  state.typingInFlight = new Promise(() => {});
  const startedAt = Date.now();

  await Runtime.waitForTelegramTypingLoopIdle(state, 1);

  assert.ok(Date.now() - startedAt < 100);
});

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

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

test("Extension runtime polls, pairs, and dispatches an inbound Telegram turn into pi", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const sentMessages: RuntimeHarnessMessage[] = [];
  let resolveDispatch: ((value: RuntimeHarnessMessage) => void) | undefined;
  const dispatched = new Promise<RuntimeHarnessMessage>((resolve) => {
    resolveDispatch = resolve;
  });
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      sentMessages.push(content);
      resolveDispatch?.(content);
    },
  });
  let getUpdatesCalls = 0;
  let sendMessageCalls = 0;
  const apiCalls: string[] = [];
  const restoreFetch = setRuntimeTestFetch(async (input) => {
    const method = getRuntimeTelegramApiMethod(input);
    apiCalls.push(method);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 42,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "hello from telegram",
            },
          },
        ]);
      }
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage") {
      sendMessageCalls += 1;
      if (sendMessageCalls === 1) {
        return createRuntimeTelegramApiErrorResponse(500, "temporary send failure");
      }
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({ botToken: "123:abc", lastUpdateId: 0 });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext();
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    const dispatchedContent = await dispatched;
    assert.equal(sentMessages.length, 1);
    assert.equal(Array.isArray(dispatchedContent), true);
    assert.equal(apiCalls.includes("sendMessage"), true);
    assert.equal(sendMessageCalls, 2);
    assert.equal(apiCalls.includes("sendChatAction"), true);
    const promptBlock = getRuntimeHarnessTextBlock(dispatchedContent);
    assert.equal(promptBlock.type, "text");
    assert.match(promptBlock.text ?? "", /^\[telegram\] hello from telegram$/);
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime finalizes queued turn after polling ownership moves away", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  let resolveDispatch: (() => void) | undefined;
  const dispatched = new Promise<void>((resolve) => {
    resolveDispatch = resolve;
  });
  const draftTexts: string[] = [];
  const sentTexts: string[] = [];
  const sentBodies: Array<Record<string, unknown>> = [];
  const editedTexts: string[] = [];
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: () => {
      resolveDispatch?.();
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 7,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "please answer",
            },
          },
        ]);
      }
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessageDraft") {
      draftTexts.push(String(body?.text ?? ""));
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "sendMessage") {
      sentTexts.push(String(body?.text ?? ""));
      sentBodies.push(body ?? {});
      return createRuntimeTelegramApiResponse({
        message_id: 100 + sentTexts.length,
      });
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "editMessageText") {
      editedTexts.push(String(body?.text ?? ""));
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    mock.timers.enable({ apis: ["setTimeout"] });
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext();
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await dispatched;
    await handlers.get("agent_start")?.({}, ctx);
    await writeFile(
      join(await ensureRuntimeAgentDir(), "locks.json"),
      JSON.stringify(
        {
          "@llblab/pi-telegram": {
            pid: process.pid + 1_000_000,
            cwd: "/tmp/other-pi-instance",
          },
        },
        null,
        "\t",
      ) + "\n",
      "utf8",
    );
    mock.timers.tick(1100);
    await flushMicrotasks(20);
    await handlers.get("message_update")?.(
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Draft **preview**" }],
        },
      },
      ctx,
    );
    mock.timers.tick(850);
    await flushMicrotasks(50);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Final **answer**" }],
          },
        ],
      },
      ctx,
    );
    assert.deepEqual(draftTexts, ["Draft preview", "Final answer"]);
    assert.equal(sentTexts.length, 1);
    assert.match(sentTexts[0] ?? "", /Final <b>answer<\/b>/);
    assert.deepEqual(sentBodies[0]?.reply_parameters, {
      message_id: 7,
      allow_sending_without_reply: true,
    });
    assert.deepEqual(editedTexts, []);
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    mock.timers.reset();
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime dispatches accepted queued work after polling ownership moves away", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const sentMessages: RuntimeHarnessMessage[] = [];
  const sentBodies: Array<Record<string, unknown>> = [];
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      sentMessages.push(content);
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 7,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "first accepted",
            },
          },
          {
            _: "other",
            update_id: 2,
            message: {
              message_id: 8,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "second queued",
            },
          },
        ]);
      }
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage") {
      sentBodies.push(body ?? {});
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    await writeRuntimeTelegramLocks({});
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext({
      cwd: "/repo/queue-owner-a",
    });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForEventLoopCondition(() => sentMessages.length === 1);
    assert.match(
      getRuntimeHarnessMessageText(sentMessages[0] as RuntimeHarnessMessage),
      /^\[telegram\] first accepted$/,
    );
    await handlers.get("agent_start")?.({}, ctx);
    await writeRuntimeTelegramLocks({
      "@llblab/pi-telegram": {
        pid: process.pid + 1_000_000,
        cwd: "/repo/queue-owner-b",
      },
    });
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "First **final**" }],
          },
        ],
      },
      ctx,
    );
    // Follow-up dispatch is intentionally routed through the session-bound
    // deferred queue timer; wait on real time instead of setImmediate turns.
    await waitForCondition(() => sentMessages.length === 2);
    assert.match(String(sentBodies[0]?.text ?? ""), /First final/);
    assert.match(
      getRuntimeHarnessMessageText(sentMessages[1] as RuntimeHarnessMessage),
      /^\[telegram\] second queued$/,
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime keeps proactive local result disabled even with Telegram lock ownership", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const sentBodies: Array<Record<string, unknown>> = [];
  const { handlers, commands, pi } = createRuntimePiHarness();
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage") {
      sentBodies.push(parseJsonRequestBody(init) ?? {});
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
      proactivePush: false,
    });
    await writeRuntimeTelegramLocks({});
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext({
      cwd: "/repo/proactive-disabled-owner",
    });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await flushMicrotasks(20);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Local **done**" }],
          },
        ],
      },
      ctx,
    );
    assert.deepEqual(sentBodies, []);
    await commands.get("telegram-disconnect")?.handler("", ctx);
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime resolves stale same-cwd lock before proactive local result", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const sentBodies: Array<Record<string, unknown>> = [];
  const { handlers, pi } = createRuntimePiHarness();
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage") {
      sentBodies.push(parseJsonRequestBody(init) ?? {});
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    const cwd = "/repo/proactive-stale-owner";
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
      proactivePush: true,
    });
    await writeRuntimeTelegramLocks({
      "@llblab/pi-telegram": {
        pid: process.pid + 1_000_000,
        cwd,
      },
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext({ cwd });
    await handlers.get("session_start")?.({}, ctx);
    await flushMicrotasks(20);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Local **done**" }],
          },
        ],
      },
      ctx,
    );
    assert.equal(sentBodies.length, 1);
    assert.equal(sentBodies[0]?.chat_id, 77);
    assert.match(String(sentBodies[0]?.text ?? ""), /Local <b>done<\/b>/);
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime sends proactive local result only while owning Telegram lock", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const sentBodies: Array<Record<string, unknown>> = [];
  const { handlers, commands, pi } = createRuntimePiHarness();
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage") {
      sentBodies.push(parseJsonRequestBody(init) ?? {});
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
      proactivePush: true,
    });
    await writeRuntimeTelegramLocks({});
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext({
      cwd: "/repo/proactive-owner",
    });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await flushMicrotasks(20);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Local **done**" }],
          },
        ],
      },
      ctx,
    );
    assert.equal(sentBodies.length, 1);
    assert.equal(sentBodies[0]?.chat_id, 77);
    assert.match(String(sentBodies[0]?.text ?? ""), /Local <b>done<\/b>/);
    await commands.get("telegram-disconnect")?.handler("", ctx);
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime skips proactive local result without Telegram lock ownership", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const sentBodies: Array<Record<string, unknown>> = [];
  const { handlers, pi } = createRuntimePiHarness();
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "sendMessage") {
      sentBodies.push(parseJsonRequestBody(init) ?? {});
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
      proactivePush: true,
    });
    await writeRuntimeTelegramLocks({
      "@llblab/pi-telegram": {
        pid: process.pid + 1_000_000,
        cwd: "/repo/another-instance",
      },
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext({
      cwd: "/repo/proactive-non-owner",
    });
    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Local **done**" }],
          },
        ],
      },
      ctx,
    );
    assert.deepEqual(sentBodies, []);
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime clears queued follow-ups after a Telegram stop", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const sentMessages: RuntimeHarnessMessage[] = [];
  let firstDispatchResolved = false;
  const secondUpdates = createRuntimeDeferredResponse();
  const thirdUpdates = createRuntimeDeferredResponse();
  const fourthUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      sentMessages.push(content);
      firstDispatchResolved = true;
    },
  });
  let getUpdatesCalls = 0;
  const sendTexts: string[] = [];
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 10,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "first request",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      if (getUpdatesCalls === 3) return thirdUpdates.promise;
      if (getUpdatesCalls === 4) return fourthUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage") {
      sendTexts.push(String(body?.text ?? ""));
      return createRuntimeTelegramApiResponse({
        message_id: 100 + sendTexts.length,
      });
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const idleCtx = createRuntimeExtensionContext();
    let aborted = false;
    const activeCtx = createRuntimeExtensionContext({
      isIdle: () => false,
      abort: () => {
        aborted = true;
      },
    });
    await handlers.get("session_start")?.({}, idleCtx);
    await commands.get("telegram-connect")?.handler("", idleCtx);
    await waitForCondition(() => firstDispatchResolved);
    await handlers.get("agent_start")?.({}, activeCtx);
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 11,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "follow up",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 3);
    thirdUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          message: {
            message_id: 12,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "/stop",
          },
        },
      ]),
    );
    await waitForCondition(() => aborted);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "aborted",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      idleCtx,
    );
    const dispatchCountBeforeNextTurn = sentMessages.length;
    fourthUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 4,
          message: {
            message_id: 13,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "new request",
          },
        },
      ]),
    );
    await waitForCondition(
      () => sentMessages.length === dispatchCountBeforeNextTurn + 1,
    );
    const promptText =
      getRuntimeHarnessTextBlock(sentMessages.at(-1)).text ?? "";
    assert.equal(promptText, "[telegram] new request");
    assert.equal(promptText.includes("follow up"), false);
    assert.equal(
      sendTexts.includes("Aborted current turn. Cleared 1 queued turn."),
      true,
    );
    await handlers.get("session_shutdown")?.({}, idleCtx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime handles immediate status before queued prompt after agent end", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  let firstDispatchResolved = false;
  let shutdownCtx: unknown;
  const secondUpdates = createRuntimeDeferredResponse();
  const thirdUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
      firstDispatchResolved = true;
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook")
      return createRuntimeTelegramApiResponse(true);
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 20,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "first request",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      if (getUpdatesCalls === 3) return thirdUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage") {
      runtimeEvents.push(`send:${String(body?.text ?? "")}`);
      return createRuntimeTelegramApiResponse({
        message_id: 100 + runtimeEvents.length,
      });
    }
    if (method === "sendChatAction")
      return createRuntimeTelegramApiResponse(true);
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const baseCtx = createRuntimeExtensionContext({
      cwd: process.cwd(),
      sessionManager: {
        getEntries: () => [],
      },
      modelRegistry: {
        refresh: () => {},
        getAvailable: () => [],
        isUsingOAuth: () => false,
      },
      getContextUsage: () => undefined,
    });
    const idleCtx = {
      ...baseCtx,
      isIdle: () => true,
    };
    const activeCtx = {
      ...baseCtx,
      isIdle: () => false,
    };
    shutdownCtx = idleCtx;
    await handlers.get("session_start")?.({}, idleCtx);
    await commands.get("telegram-connect")?.handler("", idleCtx);
    await waitForCondition(() => firstDispatchResolved);
    await handlers.get("agent_start")?.({}, activeCtx);
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 21,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "/status",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 3);
    thirdUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          message: {
            message_id: 22,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "follow up after status",
          },
        },
      ]),
    );
    await waitForCondition(() => runtimeEvents.length >= 1);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      idleCtx,
    );
    await waitForCondition(() => runtimeEvents.length >= 3);
    assert.equal(runtimeEvents[0], "dispatch:[telegram] first request");
    assert.match(runtimeEvents[1] ?? "", /^send:<b>π Telegram<\/b>/);
    assert.equal(
      runtimeEvents[2],
      "dispatch:[telegram] follow up after status",
    );
  } finally {
    if (shutdownCtx) await handlers.get("session_shutdown")?.({}, shutdownCtx);
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime opens immediate model menu before queued prompt after agent end", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const modelA = createRuntimeModel("openai", "gpt-a", true);
  const modelB = createRuntimeModel("anthropic", "claude-b", false);
  let firstDispatchResolved = false;
  const secondUpdates = createRuntimeDeferredResponse();
  const thirdUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
      firstDispatchResolved = true;
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 23,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "first request",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      if (getUpdatesCalls === 3) return thirdUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage") {
      runtimeEvents.push(`send:${String(body?.text ?? "")}`);
      return createRuntimeTelegramApiResponse({
        message_id: 100 + runtimeEvents.length,
      });
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const baseCtx = createRuntimeExtensionContext({
      cwd: process.cwd(),
      model: modelA,
      sessionManager: {
        getEntries: () => [],
      },
      modelRegistry: {
        refresh: () => {},
        getAvailable: () => [modelA, modelB],
        isUsingOAuth: () => false,
      },
      getContextUsage: () => undefined,
    });
    const idleCtx = {
      ...baseCtx,
      isIdle: () => true,
    };
    const activeCtx = {
      ...baseCtx,
      isIdle: () => false,
    };
    await handlers.get("session_start")?.({}, idleCtx);
    await commands.get("telegram-connect")?.handler("", idleCtx);
    await waitForCondition(() => firstDispatchResolved);
    await handlers.get("agent_start")?.({}, activeCtx);
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 24,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "/model",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 3);
    thirdUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          message: {
            message_id: 25,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "follow up after model",
          },
        },
      ]),
    );
    await waitForCondition(() => runtimeEvents.length >= 1);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      idleCtx,
    );
    await waitForCondition(() => runtimeEvents.length >= 3);
    assert.equal(runtimeEvents[0], "dispatch:[telegram] first request");
    assert.equal(runtimeEvents[1], "send:<b>🤖 Choose a model:</b>");
    assert.equal(runtimeEvents[2], "dispatch:[telegram] follow up after model");
    await handlers.get("session_shutdown")?.({}, idleCtx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime keeps queued turns blocked until compaction completes", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  let compactHooks:
    | {
        onComplete: () => void;
        onError: (error: unknown) => void;
      }
    | undefined;
  const secondUpdates = createRuntimeDeferredResponse();
  const thirdUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 30,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "/compact",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) {
        return secondUpdates.promise;
      }
      if (getUpdatesCalls === 3) {
        return thirdUpdates.promise;
      }
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage") {
      runtimeEvents.push(`send:${String(body?.text ?? "")}`);
      return createRuntimeTelegramApiResponse({
        message_id: 100 + runtimeEvents.length,
      });
    }
    if (method === "sendChatAction") {
      runtimeEvents.push(
        `typing:${String(body?.chat_id ?? "")}:${String(body?.action ?? "")}`,
      );
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "editMessageText") {
      runtimeEvents.push(`edit:${String(body?.text ?? "")}`);
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "answerCallbackQuery") {
      runtimeEvents.push(`answer:${String(body?.callback_query_id ?? "")}`);
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext({
      compact: (hooks: {
        onComplete: () => void;
        onError: (error: unknown) => void;
      }) => {
        compactHooks = hooks;
        runtimeEvents.push("compact:start");
      },
    });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForCondition(() =>
      runtimeEvents.includes("send:<b>Compact session?</b>"),
    );
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          callback_query: {
            id: "confirm-compact",
            from: { id: 77, is_bot: false, first_name: "Test" },
            message: {
              message_id: 101,
              chat: { id: 99, type: "private" },
            },
            data: "compact:confirm",
          },
        },
      ]),
    );
    await waitForCondition(() => runtimeEvents.includes("compact:start"));
    await waitForCondition(
      () =>
        runtimeEvents.includes("edit:Compaction started.") &&
        runtimeEvents.includes("typing:99:typing"),
    );
    assert.equal(
      runtimeEvents.indexOf("edit:Compaction started.") <
        runtimeEvents.indexOf("typing:99:typing"),
      true,
    );
    thirdUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          message: {
            message_id: 31,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "follow up after compaction",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 3);
    assert.equal(
      runtimeEvents.some(
        (event) => event === "dispatch:[telegram] follow up after compaction",
      ),
      false,
    );
    compactHooks?.onComplete();
    await waitForCondition(() =>
      runtimeEvents.includes("dispatch:[telegram] follow up after compaction"),
    );
    await waitForCondition(() =>
      runtimeEvents.includes("send:Compaction completed."),
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime blocks queued dispatch during observed auto-compaction", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  let firstDispatchResolve: (() => void) | undefined;
  const firstDispatched = new Promise<void>((resolve) => {
    firstDispatchResolve = resolve;
  });
  const secondUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
      firstDispatchResolve?.();
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook")
      return createRuntimeTelegramApiResponse(true);
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 41,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "first telegram turn",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage") {
      runtimeEvents.push(`send:${String(body?.text ?? "")}`);
      return createRuntimeTelegramApiResponse({
        message_id: 100 + runtimeEvents.length,
      });
    }
    if (
      method === "sendMessageDraft" ||
      method === "sendChatAction" ||
      method === "editMessageText"
    ) {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext();
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await firstDispatched;
    await handlers.get("agent_start")?.({}, ctx);
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 42,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "queued during active turn",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 3);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        ],
      },
      ctx,
    );
    await handlers.get("session_before_compact")?.(
      { signal: new AbortController().signal },
      ctx,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(
      runtimeEvents.includes("dispatch:[telegram] queued during active turn"),
      false,
    );
    await handlers.get("session_compact")?.({}, ctx);
    await waitForCondition(() =>
      runtimeEvents.includes("dispatch:[telegram] queued during active turn"),
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime coalesces media-group updates into one delayed dispatch", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 40,
              media_group_id: "album-1",
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              caption: "first caption",
            },
          },
          {
            _: "other",
            update_id: 2,
            message: {
              message_id: 41,
              media_group_id: "album-1",
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              caption: "second caption",
            },
          },
        ]);
      }
      throw new DOMException("stop", "AbortError");
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext();
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForEventLoopCondition(() => getUpdatesCalls >= 2, 5000);
    assert.equal(runtimeEvents.length, 0);
    await waitForCondition(() => runtimeEvents.length === 1, 3000);
    assert.equal(
      runtimeEvents[0],
      "dispatch:[telegram] first caption\n\nsecond caption",
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime coalesces likely split long text updates into one dispatch", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 50,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "x".repeat(3600),
            },
          },
          {
            _: "other",
            update_id: 2,
            message: {
              message_id: 51,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "tail",
            },
          },
        ]);
      }
      throw new DOMException("stop", "AbortError");
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext();
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForEventLoopCondition(() => getUpdatesCalls >= 1, 5000);
    await flushMicrotasks();
    assert.equal(runtimeEvents.length, 0);
    await waitForCondition(() => runtimeEvents.length === 1, 3000);
    assert.equal(
      runtimeEvents[0],
      `dispatch:[telegram] ${"x".repeat(3600)}\n\ntail`,
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime clears pending split-text dispatch on shutdown", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 60,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "x".repeat(3600),
            },
          },
        ]);
      }
      throw new DOMException("stop", "AbortError");
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext();
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForEventLoopCondition(() => getUpdatesCalls >= 2, 5000);
    await handlers.get("session_shutdown")?.({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.deepEqual(runtimeEvents, []);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime clears pending media-group dispatch on shutdown", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 61,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              media_group_id: "album-1",
              text: "album item",
            },
          },
        ]);
      }
      throw new DOMException("stop", "AbortError");
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext();
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForEventLoopCondition(() => getUpdatesCalls >= 2, 5000);
    await handlers.get("session_shutdown")?.({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.deepEqual(runtimeEvents, []);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime applies reaction priority and removal before the next dispatch", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  let firstDispatchResolved = false;
  const secondUpdates = createRuntimeDeferredResponse();
  const thirdUpdates = createRuntimeDeferredResponse();
  const fourthUpdates = createRuntimeDeferredResponse();
  const fifthUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
      firstDispatchResolved = true;
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 30,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "first request",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      if (getUpdatesCalls === 3) return thirdUpdates.promise;
      if (getUpdatesCalls === 4) return fourthUpdates.promise;
      if (getUpdatesCalls === 5) return fifthUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const idleCtx = createRuntimeExtensionContext();
    const activeCtx = createRuntimeExtensionContext({
      isIdle: () => false,
    });
    await handlers.get("session_start")?.({}, idleCtx);
    await commands.get("telegram-connect")?.handler("", idleCtx);
    await waitForCondition(() => firstDispatchResolved);
    await handlers.get("agent_start")?.({}, activeCtx);
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 31,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "older waiting",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 3);
    thirdUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          message: {
            message_id: 32,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "newer waiting",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 4);
    fourthUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 4,
          message_reaction: {
            chat: { id: 99, type: "private" },
            message_id: 32,
            user: { id: 77, is_bot: false, first_name: "Test" },
            old_reaction: [],
            new_reaction: [{ type: "emoji", emoji: "👍" }],
            date: 1,
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 5);
    fifthUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 5,
          message_reaction: {
            chat: { id: 99, type: "private" },
            message_id: 31,
            user: { id: 77, is_bot: false, first_name: "Test" },
            old_reaction: [],
            new_reaction: [{ type: "emoji", emoji: "👎" }],
            date: 2,
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 6);
    await flushMicrotasks(50);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      idleCtx,
    );
    await waitForCondition(() => runtimeEvents.length === 2);
    assert.equal(runtimeEvents[0], "dispatch:[telegram] first request");
    assert.equal(runtimeEvents[1], "dispatch:[telegram] newer waiting");
    await handlers.get("agent_start")?.({}, activeCtx);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      idleCtx,
    );
    await flushMicrotasks();
    assert.deepEqual(runtimeEvents, [
      "dispatch:[telegram] first request",
      "dispatch:[telegram] newer waiting",
    ]);
    await handlers.get("session_shutdown")?.({}, idleCtx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime applies idle model picks immediately and refreshes status", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const previousArgv = [...process.argv];
  const runtimeEvents: string[] = [];
  const statusEvents: string[] = [];
  const modelA = createRuntimeModel("openai", "gpt-a", true);
  const modelB = createRuntimeModel("anthropic", "claude-b", true);
  const setModels: Array<string> = [];
  const thinkingLevels: Array<string> = [];
  let shutdownCtx: unknown;
  const secondUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    getThinkingLevel: () => thinkingLevels.at(-1) ?? "medium",
    setModel: async (model) => {
      setModels.push(`${model.provider}/${model.id}`);
      return true;
    },
    setThinkingLevel: (level) => {
      thinkingLevels.push(level);
    },
  });
  let getUpdatesCalls = 0;
  let nextMessageId = 100;
  const callbackAnswers: string[] = [];
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook")
      return createRuntimeTelegramApiResponse(true);
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 60,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "/model",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage") {
      runtimeEvents.push(`send:${String(body?.text ?? "")}`);
      return createRuntimeTelegramApiResponse({ message_id: nextMessageId++ });
    }
    if (method === "editMessageText") {
      runtimeEvents.push(`edit:${String(body?.text ?? "")}`);
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "answerCallbackQuery") {
      callbackAnswers.push(String(body?.text ?? ""));
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "sendChatAction")
      return createRuntimeTelegramApiResponse(true);
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    process.argv = [
      previousArgv[0] ?? "node",
      previousArgv[1] ?? "index.ts",
      "--models=anthropic/claude-b:high",
    ];
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeModelContext({
      model: modelA,
      availableModels: [modelA, modelB],
      setStatus: (_slot, text) => {
        statusEvents.push(text);
      },
    });
    shutdownCtx = ctx;
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForCondition(() =>
      runtimeEvents.some((event) => event === "send:<b>🤖 Choose a model:</b>"),
    );
    const statusCountBeforePick = statusEvents.length;
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          callback_query: {
            id: "cb-idle-1",
            from: { id: 77, is_bot: false, first_name: "Test" },
            data: "model:pick:0",
            message: {
              message_id: 100,
              chat: { id: 99, type: "private" },
            },
          },
        },
      ]),
    );
    await waitForCondition(() => setModels.length === 1);
    assert.deepEqual(setModels, ["anthropic/claude-b"]);
    assert.deepEqual(thinkingLevels, ["high"]);
    assert.equal(callbackAnswers.includes("Switched to claude-b"), true);
    assert.equal(statusEvents.length > statusCountBeforePick, true);
    assert.equal(
      runtimeEvents.some(
        (event) =>
          event.startsWith("edit:<b>π Telegram</b>") ||
          event.startsWith("edit:<b>🤖 Choose a model:</b>"),
      ),
      true,
    );
  } finally {
    if (shutdownCtx) await handlers.get("session_shutdown")?.({}, shutdownCtx);
    process.argv = previousArgv;
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime switches model in flight and dispatches a continuation turn after abort", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const modelA = createRuntimeModel("openai", "gpt-a", true);
  const modelB = createRuntimeModel("anthropic", "claude-b", false);
  let idle = true;
  let aborted = false;
  const setModels: Array<string> = [];
  const secondUpdates = createRuntimeDeferredResponse();
  const thirdUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
    setModel: async (model) => {
      setModels.push(`${model.provider}/${model.id}`);
      return true;
    },
    setThinkingLevel: () => {},
  });
  let getUpdatesCalls = 0;
  let nextMessageId = 100;
  const callbackAnswers: string[] = [];
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 40,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "/model",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      if (getUpdatesCalls === 3) return thirdUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage") {
      runtimeEvents.push(`send:${String(body?.text ?? "")}`);
      return createRuntimeTelegramApiResponse({ message_id: nextMessageId++ });
    }
    if (method === "editMessageText") {
      runtimeEvents.push(`edit:${String(body?.text ?? "")}`);
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "answerCallbackQuery") {
      callbackAnswers.push(String(body?.text ?? ""));
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeModelContext({
      model: modelA,
      availableModels: [modelA, modelB],
      isIdle: () => idle,
      abort: () => {
        aborted = true;
      },
    });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForCondition(() =>
      runtimeEvents.some((event) => event === "send:<b>🤖 Choose a model:</b>"),
    );
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 41,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "first request",
          },
        },
      ]),
    );
    await waitForCondition(() =>
      runtimeEvents.some(
        (event) => event === "dispatch:[telegram] first request",
      ),
    );
    idle = false;
    await handlers.get("agent_start")?.({}, ctx);
    thirdUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          callback_query: {
            id: "cb-1",
            from: { id: 77, is_bot: false, first_name: "Test" },
            data: "model:pick:1",
            message: {
              message_id: 100,
              chat: { id: 99, type: "private" },
            },
          },
        },
      ]),
    );
    await waitForCondition(() => aborted);
    assert.deepEqual(setModels, ["anthropic/claude-b"]);
    assert.equal(
      callbackAnswers.includes("Switching to claude-b and continuing…"),
      true,
    );
    idle = true;
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "aborted",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      ctx,
    );
    await waitForCondition(() =>
      runtimeEvents.some((event) =>
        event.includes(
          "Continue the interrupted previous Telegram request using the newly selected model (anthropic/claude-b)",
        ),
      ),
    );
    assert.equal(
      runtimeEvents.includes("dispatch:[telegram] first request"),
      true,
    );
    assert.equal(
      runtimeEvents.some((event) =>
        event.includes(
          "dispatch:[telegram] Continue the interrupted previous Telegram request using the newly selected model (anthropic/claude-b)",
        ),
      ),
      true,
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime preserves long-session queue through abort, next, and model switch", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const modelA = createRuntimeModel("openai", "gpt-a", true);
  const modelB = createRuntimeModel("anthropic", "claude-b", false);
  let idle = true;
  let abortCount = 0;
  const setModels: Array<string> = [];
  const updates = Array.from({ length: 5 }, () =>
    createRuntimeDeferredResponse(),
  );
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
    setModel: async (model) => {
      setModels.push(`${model.provider}/${model.id}`);
      return true;
    },
    setThinkingLevel: () => {},
  });
  let getUpdatesCalls = 0;
  let nextMessageId = 100;
  const callbackAnswers: string[] = [];
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook")
      return createRuntimeTelegramApiResponse(true);
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 70,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "/model",
            },
          },
        ]);
      }
      const update = updates[getUpdatesCalls - 2];
      if (update) return update.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage") {
      runtimeEvents.push(`send:${String(body?.text ?? "")}`);
      return createRuntimeTelegramApiResponse({ message_id: nextMessageId++ });
    }
    if (method === "editMessageText") {
      runtimeEvents.push(`edit:${String(body?.text ?? "")}`);
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "answerCallbackQuery") {
      callbackAnswers.push(String(body?.text ?? ""));
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "sendChatAction")
      return createRuntimeTelegramApiResponse(true);
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeModelContext({
      model: modelA,
      availableModels: [modelA, modelB],
      isIdle: () => idle,
      abort: () => {
        abortCount += 1;
      },
    });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForCondition(() =>
      runtimeEvents.includes("send:<b>🤖 Choose a model:</b>"),
    );
    updates[0].resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 71,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "first long-session request",
          },
        },
      ]),
    );
    await waitForCondition(() =>
      runtimeEvents.includes("dispatch:[telegram] first long-session request"),
    );
    idle = false;
    await handlers.get("agent_start")?.({}, ctx);
    updates[1].resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          message: {
            message_id: 72,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "queued after abort",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 4);
    assert.equal(
      runtimeEvents.includes("dispatch:[telegram] queued after abort"),
      false,
    );
    updates[2].resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 4,
          message: {
            message_id: 73,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "/abort",
          },
        },
      ]),
    );
    await waitForCondition(() => abortCount === 1);
    idle = true;
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "aborted",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      ctx,
    );
    assert.equal(
      runtimeEvents.includes("dispatch:[telegram] queued after abort"),
      false,
    );
    updates[3].resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 5,
          message: {
            message_id: 74,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "/next",
          },
        },
      ]),
    );
    await waitForCondition(() =>
      runtimeEvents.includes("dispatch:[telegram] queued after abort"),
    );
    idle = false;
    await handlers.get("agent_start")?.({}, ctx);
    updates[4].resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 6,
          callback_query: {
            id: "cb-long-session",
            from: { id: 77, is_bot: false, first_name: "Test" },
            data: "model:pick:1",
            message: {
              message_id: 100,
              chat: { id: 99, type: "private" },
            },
          },
        },
      ]),
    );
    await waitForCondition(() => abortCount === 2);
    assert.deepEqual(setModels, ["anthropic/claude-b"]);
    assert.equal(
      callbackAnswers.includes("Switching to claude-b and continuing…"),
      true,
    );
    idle = true;
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "aborted",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      ctx,
    );
    assert.equal(
      runtimeEvents.includes("dispatch:[telegram] queued after abort"),
      true,
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime delays model-switch abort until the active tool finishes", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const modelA = createRuntimeModel("openai", "gpt-a", true);
  const modelB = createRuntimeModel("anthropic", "claude-b", false);
  let idle = true;
  let aborted = false;
  const setModels: Array<string> = [];
  const secondUpdates = createRuntimeDeferredResponse();
  const thirdUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
    setModel: async (model) => {
      setModels.push(`${model.provider}/${model.id}`);
      return true;
    },
    setThinkingLevel: () => {},
  });
  let getUpdatesCalls = 0;
  let nextMessageId = 100;
  const callbackAnswers: string[] = [];
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 50,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "/model",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      if (getUpdatesCalls === 3) return thirdUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage") {
      runtimeEvents.push(`send:${String(body?.text ?? "")}`);
      return createRuntimeTelegramApiResponse({ message_id: nextMessageId++ });
    }
    if (method === "editMessageText") {
      runtimeEvents.push(`edit:${String(body?.text ?? "")}`);
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "answerCallbackQuery") {
      callbackAnswers.push(String(body?.text ?? ""));
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeModelContext({
      model: modelA,
      availableModels: [modelA, modelB],
      isIdle: () => idle,
      abort: () => {
        aborted = true;
      },
    });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForCondition(() =>
      runtimeEvents.some((event) => event === "send:<b>🤖 Choose a model:</b>"),
    );
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 51,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "first request",
          },
        },
      ]),
    );
    await waitForCondition(() =>
      runtimeEvents.some(
        (event) => event === "dispatch:[telegram] first request",
      ),
    );
    idle = false;
    await handlers.get("agent_start")?.({}, ctx);
    await handlers.get("tool_execution_start")?.({}, ctx);
    thirdUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          callback_query: {
            id: "cb-2",
            from: { id: 77, is_bot: false, first_name: "Test" },
            data: "model:pick:1",
            message: {
              message_id: 100,
              chat: { id: 99, type: "private" },
            },
          },
        },
      ]),
    );
    await waitForCondition(() =>
      callbackAnswers.includes(
        "Switched to claude-b. Restarting after the current tool finishes…",
      ),
    );
    assert.deepEqual(setModels, ["anthropic/claude-b"]);
    assert.equal(aborted, false);
    await handlers.get("tool_execution_end")?.({}, ctx);
    await waitForCondition(() => aborted);
    idle = true;
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "aborted",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      ctx,
    );
    await waitForCondition(() =>
      runtimeEvents.some((event) =>
        event.includes(
          "dispatch:[telegram] Continue the interrupted previous Telegram request using the newly selected model (anthropic/claude-b)",
        ),
      ),
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});
