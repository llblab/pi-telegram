/**
 * Regression tests for inbound Telegram route composition
 * Covers route-level wiring from paired updates into prompt queueing
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import * as Commands from "../lib/commands.ts";
import * as Media from "../lib/media.ts";
import * as Menu from "../lib/menu.ts";
import * as Model from "../lib/model.ts";
import * as Outbound from "../lib/outbound.ts";
import * as Queue from "../lib/queue.ts";
import * as Routing from "../lib/routing.ts";
import * as Runtime from "../lib/runtime.ts";
import * as TextGroups from "../lib/text-groups.ts";
import * as Threads from "../lib/threads.ts";
import type * as Updates from "../lib/updates.ts";

interface TestContext {
  cwd: string;
}

interface TestModel extends Model.MenuModel {
  provider: "test";
  id: "model";
}

interface TestUser extends Updates.TelegramUser {}

interface TestMessage extends Routing.TelegramRoutedMessage {
  chat: { id: number; type: "private" };
  from?: TestUser;
  message_id: number;
  message_thread_id?: number;
  media_group_id?: string;
  photo?: Array<{
    file_id: string;
    file_unique_id: string;
    width: number;
    height: number;
  }>;
  caption?: string;
  text?: string;
}

interface TestCallbackQuery extends Routing.TelegramRoutedCallbackQuery {
  id: string;
  from: TestUser;
  message?: TestMessage;
  data?: string;
}

interface TestUpdate extends Updates.TelegramUpdateFlow {
  message?: TestMessage;
  edited_message?: TestMessage;
  callback_query?: TestCallbackQuery;
}

test("Inbound bus projection owns target authority and local labels", () => {
  const follower = {
    instanceId: "follower-a",
    connectedAtMs: 1,
    lastHeartbeatMs: 2,
    target: { chatId: 7, threadId: 11 },
  };
  const runtime = Routing.createTelegramInboundBusProjectionRuntime({
    instanceId: "leader",
    listFollowers: () => [follower],
    listThreadRecords: () => [],
    getLeaderTarget: () => ({ chatId: 7, threadId: 10 }),
    isFollowerRegistered: () => true,
    getFollowerTarget: () => ({ chatId: 7, threadId: 11 }),
    getCurrentIdentity: (target) => ({
      target,
      slot: "C",
      threadName: "Cedar",
    }),
  });

  assert.equal(
    runtime.getTargetOwnership({ chatId: 7, threadId: 11 })?.instanceId,
    "follower-a",
  );
  assert.deepEqual(runtime.getLiveThreadTargets(), [
    { chatId: 7, threadId: 10 },
    { chatId: 7, threadId: 11 },
  ]);
  assert.equal(
    runtime.getLocalThreadLabelForTarget({ chatId: 7, threadId: 11 }),
    "Cedar",
  );
  assert.equal(
    runtime.getLocalThreadLabelForTarget({ chatId: 7, threadId: 99 }),
    undefined,
  );
});

test("Routing runtime forwards authorized text messages into prompt queueing", async () => {
  const events: string[] = [];
  const model: TestModel = { provider: "test", id: "model" };
  const bridgeRuntime = Runtime.createTelegramBridgeRuntime();
  const activeTurnRuntime = Queue.createTelegramActiveTurnStore();
  const telegramQueueStore = Queue.createTelegramQueueStore<TestContext>();
  const queueMutationRuntime = Queue.createTelegramQueueMutationController({
    ...telegramQueueStore,
    updateStatus: () => events.push("status"),
  });
  const pendingModelSwitchStore =
    Model.createPendingModelSwitchStore<Model.ScopedTelegramModel<TestModel>>();
  const currentModelRuntime = Model.createCurrentModelRuntime<
    TestContext,
    TestModel
  >({
    getContextModel: () => model,
    updateStatus: () => events.push("status"),
  });
  const modelSwitchController =
    Model.createTelegramModelSwitchControllerRuntime<
      TestContext,
      Model.ScopedTelegramModel<TestModel>
    >({
      isIdle: () => true,
      getPendingModelSwitch: pendingModelSwitchStore.get,
      setPendingModelSwitch: pendingModelSwitchStore.set,
      getActiveTurn: activeTurnRuntime.get,
      getAbortHandler: bridgeRuntime.abort.getHandler,
      hasAbortHandler: bridgeRuntime.abort.hasHandler,
      getActiveToolExecutions: bridgeRuntime.lifecycle.getActiveToolExecutions,
      allocateItemOrder: bridgeRuntime.queue.allocateItemOrder,
      allocateControlOrder: bridgeRuntime.queue.allocateControlOrder,
      appendQueuedItem: queueMutationRuntime.append,
      updateStatus: () => events.push("status"),
    });
  const menuActions: Menu.TelegramMenuActionRuntime<TestContext, TestModel> = {
    updateModelMenuMessage: async () => undefined,
    updateThinkingMenuMessage: async () => undefined,
    updateStatusMessage: async () => undefined,
    sendStatusMessage: async () => {
      events.push("status-menu");
    },
    openModelMenu: async () => {
      events.push("model-menu");
    },
    openThinkingMenu: async () => {
      events.push("thinking-menu");
    },
  };
  const routeRuntime = Routing.createTelegramInboundRouteRuntime<
    TestUpdate,
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >({
    configStore: {
      get: () => ({}),
      getAllowedUserId: () => 7,
      setAllowedUserId: () => undefined,
      persist: async () => undefined,
    },
    bridgeRuntime,
    activeTurnRuntime,
    mediaGroupRuntime: Media.createTelegramMediaGroupController<
      TestMessage,
      TestContext
    >(),
    textGroupRuntime: TextGroups.createTelegramTextGroupController<
      TestMessage,
      TestContext
    >(),
    telegramQueueStore,
    queueMutationRuntime,
    modelMenuRuntime: Menu.createTelegramModelMenuRuntime<TestModel>(),
    currentModelRuntime,
    modelSwitchController,
    menuActions,
    openQueueMenu: async () => undefined,
    queueMenuCallbackHandler: async () => false,
    inboundHandlerRuntime: {
      process: async (files, rawText) => ({
        rawText,
        promptFiles: files,
        handlerOutputs: [],
        handledFiles: [],
      }),
    },
    updateStatus: () => events.push("status"),
    dispatchNextQueuedTelegramTurn: () => events.push("dispatch"),
    requestDeferredDispatchNextQueuedTelegramTurn: (dispatch) => {
      events.push("deferred-dispatch");
      dispatch({ cwd: "/deferred" });
    },
    answerCallbackQuery: async (callbackQueryId) => {
      events.push(`answer:${callbackQueryId}`);
    },
    answerGuestQuery: async () => {},
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      events.push(`reply:${text}`);
      return undefined;
    },
    setMyCommands: async () => undefined,
    getCommands: () => [],
    downloadFile: async (_fileId, fileName) => `/tmp/${fileName}`,
    getThinkingLevel: () => "high",
    setThinkingLevel: () => undefined,
    setModel: async () => true,
    sendUserMessage: (message, options) => {
      events.push(`user:${message}:${options?.deliverAs ?? "default"}`);
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    compact: () => undefined,
    recordRuntimeEvent: (category, error) => {
      events.push(
        `event:${category}:${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
  await routeRuntime.handleUpdate(
    {
      message: {
        message_id: 11,
        chat: { id: 100, type: "private" },
        from: { id: 7, is_bot: false },
        text: "hello from telegram",
      },
    },
    { cwd: "/repo" },
  );
  const [queued] = telegramQueueStore.getQueuedItems();
  assert.equal(queued?.kind, "prompt");
  assert.equal(queued?.statusSummary, "hello from telegram");
  assert.equal(
    queued?.content[0]?.type === "text" ? queued.content[0].text : "",
    "[telegram] hello from telegram",
  );
  assert.deepEqual(events, [
    "status",
    "dispatch",
    "deferred-dispatch",
    "dispatch",
  ]);
  bridgeRuntime.lifecycle.setFoldQueuedPromptsIntoHistory(true);
  await routeRuntime.handleUpdate(
    {
      message: {
        message_id: 12,
        chat: { id: 100, type: "private" },
        from: { id: 7, is_bot: false },
        text: "/continue",
      },
    },
    { cwd: "/repo" },
  );
  const queuedAfterContinue = telegramQueueStore.getQueuedItems();
  const [continueTurn, originalTurn] = queuedAfterContinue;
  assert.equal(queuedAfterContinue.length, 2);
  assert.equal(continueTurn?.kind, "prompt");
  assert.equal(continueTurn?.queueLane, "control");
  assert.equal(continueTurn?.statusSummary, "continue");
  assert.equal(
    continueTurn?.content[0]?.type === "text"
      ? continueTurn.content[0].text
      : "",
    "[telegram] continue",
  );
  assert.equal(continueTurn?.historyText, "continue");
  assert.equal(originalTurn?.kind, "prompt");
  assert.equal(originalTurn?.statusSummary, "hello from telegram");
  assert.equal(
    originalTurn?.kind === "prompt" && originalTurn.content[0]?.type === "text"
      ? originalTurn.content[0].text
      : "",
    "[telegram] hello from telegram",
  );
  assert.equal(
    bridgeRuntime.lifecycle.shouldFoldQueuedPromptsIntoHistory(),
    false,
  );
  const disposeFailingCommand = Commands.registerTelegramCommand({
    name: "fail",
    handler: () => {
      throw new Error("boom");
    },
  });
  await routeRuntime.handleUpdate(
    {
      message: {
        message_id: 13,
        chat: { id: 100, type: "private" },
        from: { id: 7, is_bot: false },
        text: "/fail now",
      },
    },
    { cwd: "/repo" },
  );
  disposeFailingCommand();
  assert.equal(events.includes("event:telegram-command:boom"), true);
  assert.equal(events.includes("reply:Command failed."), true);
  assert.equal(telegramQueueStore.getQueuedItems().length, 2);
  await routeRuntime.handleUpdate(
    {
      callback_query: {
        id: "cb-custom",
        from: { id: 7, is_bot: false },
        data: "vividfish:approve:123",
        message: {
          message_id: 13,
          chat: { id: 100, type: "private" },
          from: { id: 7, is_bot: false },
        },
      },
    },
    { cwd: "/repo" },
  );
  const ownedCallbackData = [
    "tgbtn:expired",
    "menu:model",
    "model:pick:0",
    "thinking:set:high",
    "status:model",
    "queue:list",
    "allmenu:start:7",
    "reroute:missing:7",
  ];
  for (const [index, data] of ownedCallbackData.entries()) {
    await routeRuntime.handleUpdate(
      {
        callback_query: {
          id: `cb-owned-${index}`,
          from: { id: 7, is_bot: false },
          data,
          message: {
            message_id: 14 + index,
            chat: { id: 100, type: "private" },
            from: { id: 7, is_bot: false },
          },
        },
      },
      { cwd: "/repo" },
    );
  }
  const callbackTurn = telegramQueueStore
    .getQueuedItems()
    .find((item) => item.statusSummary === "vividfish:approve:123");
  assert.equal(callbackTurn?.kind, "prompt");
  assert.equal(callbackTurn?.queueLane, "priority");
  assert.deepEqual(
    callbackTurn?.kind === "prompt" ? callbackTurn.content : undefined,
    [{ type: "text", text: "[callback] vividfish:approve:123" }],
  );
  assert.equal(events.includes("answer:cb-custom"), true);
  for (const data of ownedCallbackData) {
    assert.equal(
      events.some((event) => event.startsWith(`user:[callback] ${data}:`)),
      false,
    );
  }
});

interface RouteHarnessOptions {
  config?: unknown;
  threadStore?: Threads.TelegramTopicTargetStore;
  callApi?: Routing.TelegramInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["callApi"];
  replaceFollowerThreadTarget?: Routing.TelegramInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["replaceFollowerThreadTarget"];
  foreignOwnedUpdateForwarder?: Routing.TelegramInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["foreignOwnedUpdateForwarder"];
  getCurrentLeaderEpoch?: () => number | string | undefined;
  getLiveThreadTargets?: () => Queue.TelegramQueueTarget[];
  getLocalThreadLabelForTarget?: (
    target: Queue.TelegramQueueTarget,
  ) => string | undefined;
  instanceId?: string;
  getCommands?: () => any[];
  mediaGroupRuntime?: Media.TelegramMediaGroupController<
    TestMessage,
    TestContext
  >;
}

function createRouteHarness(options: RouteHarnessOptions = {}) {
  const events: string[] = [];
  const model: TestModel = { provider: "test", id: "model" };
  const bridgeRuntime = Runtime.createTelegramBridgeRuntime();
  const activeTurnRuntime = Queue.createTelegramActiveTurnStore();
  const telegramQueueStore = Queue.createTelegramQueueStore<TestContext>();
  const buttonActionStore = Outbound.createTelegramButtonActionStore();
  const queueMutationRuntime = Queue.createTelegramQueueMutationController({
    ...telegramQueueStore,
    updateStatus: () => events.push("status"),
  });
  const pendingModelSwitchStore =
    Model.createPendingModelSwitchStore<Model.ScopedTelegramModel<TestModel>>();
  const currentModelRuntime = Model.createCurrentModelRuntime<
    TestContext,
    TestModel
  >({
    getContextModel: () => model,
    updateStatus: () => events.push("status"),
  });
  const modelSwitchController =
    Model.createTelegramModelSwitchControllerRuntime<
      TestContext,
      Model.ScopedTelegramModel<TestModel>
    >({
      isIdle: () => true,
      getPendingModelSwitch: pendingModelSwitchStore.get,
      setPendingModelSwitch: pendingModelSwitchStore.set,
      getActiveTurn: activeTurnRuntime.get,
      getAbortHandler: bridgeRuntime.abort.getHandler,
      hasAbortHandler: bridgeRuntime.abort.hasHandler,
      getActiveToolExecutions: bridgeRuntime.lifecycle.getActiveToolExecutions,
      allocateItemOrder: bridgeRuntime.queue.allocateItemOrder,
      allocateControlOrder: bridgeRuntime.queue.allocateControlOrder,
      appendQueuedItem: queueMutationRuntime.append,
      updateStatus: () => events.push("status"),
    });
  const menuActions: Menu.TelegramMenuActionRuntime<TestContext, TestModel> = {
    updateModelMenuMessage: async () => undefined,
    updateThinkingMenuMessage: async () => undefined,
    updateStatusMessage: async () => undefined,
    sendStatusMessage: async () => {
      events.push("status-menu");
    },
    openModelMenu: async () => undefined,
    openThinkingMenu: async () => undefined,
  };
  const routeRuntime = Routing.createTelegramInboundRouteRuntime<
    TestUpdate,
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >({
    configStore: {
      get: () => (options.config ?? {}) as never,
      getAllowedUserId: () => 7,
      setAllowedUserId: () => undefined,
      persist: async () => undefined,
    },
    callApi: options.callApi,
    replaceFollowerThreadTarget: options.replaceFollowerThreadTarget,
    foreignOwnedUpdateForwarder: options.foreignOwnedUpdateForwarder,
    getCurrentInstanceId: () => options.instanceId ?? "leader-a",
    getLiveThreadTargets: options.getLiveThreadTargets,
    getLocalThreadLabelForTarget: options.getLocalThreadLabelForTarget,
    getCurrentLeaderEpoch: options.getCurrentLeaderEpoch,
    bridgeRuntime,
    activeTurnRuntime,
    mediaGroupRuntime:
      options.mediaGroupRuntime ??
      Media.createTelegramMediaGroupController<TestMessage, TestContext>(),
    textGroupRuntime: TextGroups.createTelegramTextGroupController<
      TestMessage,
      TestContext
    >(),
    telegramQueueStore,
    queueMutationRuntime,
    modelMenuRuntime: Menu.createTelegramModelMenuRuntime<TestModel>(),
    currentModelRuntime,
    modelSwitchController,
    menuActions,
    openQueueMenu: async () => undefined,
    queueMenuCallbackHandler: async () => false,
    inboundHandlerRuntime: {
      process: async (files, rawText) => ({
        rawText,
        promptFiles: files,
        handlerOutputs: [],
        handledFiles: [],
      }),
    },
    threadStore: options.threadStore,
    buttonActionStore,
    updateStatus: () => events.push("status"),
    dispatchNextQueuedTelegramTurn: () => events.push("dispatch"),
    answerCallbackQuery: async (_id, text) => {
      if (text) events.push(`answer:${text}`);
    },
    answerGuestQuery: async () => undefined,
    sendInteractiveMessage: async (_chatId, text, mode, replyMarkup, options) => {
      events.push(`interactive:${mode}:${text}`);
      events.push(`markup:${JSON.stringify(replyMarkup)}`);
      events.push(`interactive-options:${JSON.stringify(options ?? {})}`);
      return 99;
    },
    sendTextReply: async (_chatId, _replyToMessageId, text, options) => {
      events.push(`reply:${text}`);
      if (typeof options?.target?.threadId === "number") {
        events.push(`reply-target:${options.target.chatId}:${options.target.threadId}`);
      }
      return undefined;
    },
    deleteMessage: async (chatId, messageId) => {
      events.push(`delete-message:${chatId}:${messageId}`);
    },
    setMyCommands: async () => undefined,
    getCommands: options.getCommands ?? (() => []),
    downloadFile: async (_fileId, fileName) => `/tmp/${fileName}`,
    getThinkingLevel: () => "high",
    setThinkingLevel: () => undefined,
    setModel: async () => true,
    sendUserMessage: (message, opts) => {
      events.push(`user:${message}:${opts?.deliverAs ?? "default"}`);
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    compact: () => undefined,
    recordRuntimeEvent: (category, error) => {
      events.push(`event:${category}:${String(error)}`);
    },
  });
  return { buttonActionStore, events, routeRuntime, telegramQueueStore };
}

async function withTopicStore<T>(
  run: (store: Threads.TelegramTopicTargetStore) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-routing-"));
  try {
    const store = Threads.createTelegramTopicTargetStore({
      path: join(dir, "telegram-targets.json"),
      getNowMs: () => 2000,
    });
    return await run(store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function unboundTopicUpdate(text = "hello"): TestUpdate {
  return {
    message: {
      message_id: 11,
      message_thread_id: 42,
      chat: { id: 100, type: "private" },
      from: { id: 7, is_bot: false },
      text,
    },
  };
}

test("Routing runtime binds the first unbound thread to the leader without visible rename when leader has no active thread", async () => {
  await withTopicStore(async (threadStore) => {
    const apiCalls: unknown[] = [];
    const nowMs = Date.now();
    threadStore.upsert({
      profileKey: "cwd:/repo",
      owner: { kind: "leader", cwd: "/repo", instanceId: "old-leader" },
      target: { chatId: 100, threadId: 9 },
      status: "starting",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      slot: "A",
      threadName: "Axial",
    });
    await threadStore.persist();
    const { routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
      callApi: async (method, body) => {
        apiCalls.push({ method, body });
        return {} as never;
      },
    });

    await routeRuntime.handleUpdate(unboundTopicUpdate("test"), {
      cwd: "/repo",
    });

    const record = threadStore.getByProfileKey("cwd:/repo");
    assert.equal(record?.status, "active");
    assert.equal(record?.instanceId, "leader-a");
    assert.equal(record?.slot, "A");
    assert.equal(record?.threadName, "Axial");
    assert.deepEqual(record?.target, { chatId: 100, threadId: 42 });
    assert.deepEqual(apiCalls, []);
    assert.equal(telegramQueueStore.getQueuedItems().length, 1);
  });
});

test("Routing runtime assigns internal baked name without visibly renaming unnamed leader startup topic", async () => {
  await withTopicStore(async (threadStore) => {
    const apiCalls: unknown[] = [];
    threadStore.upsert({
      profileKey: "cwd:/repo",
      owner: { kind: "leader", cwd: "/repo", instanceId: "old-leader" },
      target: { chatId: 100, threadId: 9 },
      status: "starting",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      slot: "A",
    });
    await threadStore.persist();
    const { routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
      callApi: async (method, body) => {
        apiCalls.push({ method, body });
        return {} as never;
      },
    });

    await routeRuntime.handleUpdate(unboundTopicUpdate("test"), {
      cwd: "/repo",
    });

    const record = threadStore.getByProfileKey("cwd:/repo");
    assert.equal(record?.status, "active");
    assert.equal(record?.slot, "A");
    assert.equal(record?.threadName, "Anchor");
    assert.deepEqual(apiCalls, []);
    const queued = telegramQueueStore.getQueuedItems()[0];
    assert.equal(
      queued?.kind === "prompt" && queued.content[0]?.type === "text"
        ? queued.content[0].text
        : "",
      "[telegram|thread:Anchor] test",
    );
  });
});

test("Routing runtime restores stale leader thread identity internally without visible rename", async () => {
  await withTopicStore(async (threadStore) => {
    const apiCalls: unknown[] = [];
    threadStore.upsert({
      profileKey: "cwd:/repo",
      owner: { kind: "leader", cwd: "/repo", instanceId: "old-leader" },
      target: { chatId: 100, threadId: 9 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "old-leader",
      slot: "A",
      threadName: "Axial",
    });
    threadStore.markStaleByTarget(
      { chatId: 100, threadId: 9 },
      "deleted",
      "manual close",
    );
    await threadStore.persist();
    const { routeRuntime } = createRouteHarness({
      threadStore,
      callApi: async (method, body) => {
        apiCalls.push({ method, body });
        return {} as never;
      },
    });

    await routeRuntime.handleUpdate(unboundTopicUpdate("test"), {
      cwd: "/repo",
    });

    const record = threadStore.getByProfileKey("cwd:/repo");
    assert.equal(record?.slot, "A");
    assert.equal(record?.threadName, "Axial");
    assert.deepEqual(record?.target, { chatId: 100, threadId: 42 });
    assert.deepEqual(apiCalls, []);
  });
});

test("Routing runtime assigns internal baked name when restoring unnamed stale prior leader", async () => {
  await withTopicStore(async (threadStore) => {
    const apiCalls: unknown[] = [];
    threadStore.upsert({
      profileKey: "cwd:/repo",
      owner: { kind: "leader", cwd: "/repo", instanceId: "old-leader" },
      target: { chatId: 100, threadId: 9 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "old-leader",
      slot: "A",
    });
    threadStore.markStaleByTarget(
      { chatId: 100, threadId: 9 },
      "deleted",
      "manual close",
    );
    await threadStore.persist();
    const { routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
      callApi: async (method, body) => {
        apiCalls.push({ method, body });
        return {} as never;
      },
    });

    await routeRuntime.handleUpdate(unboundTopicUpdate("test"), {
      cwd: "/repo",
    });

    const record = threadStore.getByProfileKey("cwd:/repo");
    assert.equal(record?.slot, "A");
    assert.equal(record?.threadName, "Anchor");
    assert.deepEqual(record?.target, { chatId: 100, threadId: 42 });
    assert.deepEqual(apiCalls, []);
    const queued = telegramQueueStore.getQueuedItems()[0];
    assert.equal(
      queued?.kind === "prompt" && queued.content[0]?.type === "text"
        ? queued.content[0].text
        : "",
      "[telegram|thread:Anchor] test",
    );
  });
});

test("Routing runtime serves an active leader topic locally", async () => {
  await withTopicStore(async (threadStore) => {
    const apiCalls: unknown[] = [];
    threadStore.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 100, threadId: 42 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
      threadName: "Axial",
    });
    await threadStore.persist();
    const { routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
      callApi: async (method, body) => {
        apiCalls.push({ method, body });
        return {} as never;
      },
    });

    await routeRuntime.handleUpdate(unboundTopicUpdate("second"), {
      cwd: "/repo",
    });

    assert.deepEqual(apiCalls, []);
    const record = threadStore.getByProfileKey("cwd:/repo");
    assert.equal(typeof record?.rerouteConfirmedAtMs, "number");
    const queued = telegramQueueStore.getQueuedItems()[0];
    assert.equal(queued?.kind, "prompt");
    assert.equal(
      queued?.kind === "prompt" && queued.content[0]?.type === "text"
        ? queued.content[0].text
        : "",
      "[telegram|thread:Axial] second",
    );
  });
});

test("Routing runtime falls back to baked name for non-identity topic thread names", async () => {
  await withTopicStore(async (threadStore) => {
    threadStore.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 100, threadId: 42 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "O",
      threadName: "Follower",
    });
    await threadStore.persist();
    const { routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
    });

    await routeRuntime.handleUpdate(unboundTopicUpdate("fallback"), {
      cwd: "/repo",
    });

    const queued = telegramQueueStore.getQueuedItems()[0];
    assert.equal(queued?.kind, "prompt");
    assert.equal(
      queued?.kind === "prompt" && queued.content[0]?.type === "text"
        ? queued.content[0].text
        : "",
      "[telegram|thread:Orbit] fallback",
    );
  });
});

test("Routing runtime preserves active follower topics when the follower is not connected", async () => {
  await withTopicStore(async (threadStore) => {
    const apiCalls: unknown[] = [];
    threadStore.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 100, threadId: 7 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
    });
    threadStore.upsert({
      profileKey: "manual:follower-b",
      owner: { kind: "manual-follower", instanceId: "follower-b" },
      target: { chatId: 100, threadId: 42 },
      status: "active",
      createdAtMs: 1100,
      updatedAtMs: 1100,
      instanceId: "follower-b",
      slot: "B",
      threadName: "Beacon",
    });
    const { events, routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
      callApi: async (method, body) => {
        apiCalls.push({ method, body });
        return {} as never;
      },
    });

    await routeRuntime.handleUpdate(unboundTopicUpdate("for follower"), {
      cwd: "/repo",
    });

    assert.equal(
      threadStore.getByProfileKey("manual:follower-b")?.status,
      "active",
    );
    assert.deepEqual(apiCalls, []);
    assert.deepEqual(telegramQueueStore.getQueuedItems(), []);
    assert.equal(
      events.includes(
        "reply:Instance Beacon is not connected to the Telegram bus yet. Run /telegram-connect in that Pi instance; keeping this thread.",
      ),
      true,
    );
  });
});

test("Routing runtime does not claim an unknown unbound thread while another thread is live", async () => {
  await withTopicStore(async (threadStore) => {
    threadStore.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 100, threadId: 7 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "D",
      threadName: "Dune",
    });
    await threadStore.persist();
    const { events, routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
      getLiveThreadTargets: () => [{ chatId: 100, threadId: 7 }],
    });

    await routeRuntime.handleUpdate(unboundTopicUpdate("stray follower text"), {
      cwd: "/repo",
    });

    assert.deepEqual(
      threadStore.getByProfileKey("cwd:/repo")?.target,
      { chatId: 100, threadId: 7 },
    );
    assert.deepEqual(telegramQueueStore.getQueuedItems(), []);
    assert.equal(events.some((event) => event.startsWith("interactive:")), true);
  });
});

test("Routing runtime prefers local thread label over stale shared store binding", async () => {
  await withTopicStore(async (threadStore) => {
    threadStore.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 100, threadId: 42 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "D",
      threadName: "Dune",
    });
    await threadStore.persist();
    const { routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
      instanceId: "follower-b",
      getLocalThreadLabelForTarget: (target) =>
        target.chatId === 100 && target.threadId === 42 ? "Juno" : undefined,
    });

    await routeRuntime.handleUpdate(unboundTopicUpdate("for follower"), {
      cwd: "/repo",
    });

    const queued = telegramQueueStore.getQueuedItems()[0];
    assert.equal(
      queued?.kind === "prompt" && queued.content[0]?.type === "text"
        ? queued.content[0].text
        : "",
      "[telegram|thread:Juno] for follower",
    );
  });
});

test("Routing runtime refuses threadless prompts in multi-instance thread mode", async () => {
  await withTopicStore(async (threadStore) => {
    threadStore.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 100, threadId: 42 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
    });
    await threadStore.persist();
    const { events, routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
    });

    await routeRuntime.handleUpdate(
      {
        message: {
          message_id: 12,
          chat: { id: 100, type: "private" },
          from: { id: 7, is_bot: false },
          text: "threadless prompt",
        },
      },
      { cwd: "/repo" },
    );

    assert.deepEqual(telegramQueueStore.getQueuedItems(), []);
    assert.equal(
      events.includes(
        "reply:This bot is in threaded multi-instance mode. Send prompts in a bound Pi thread tab so they route to the right instance.",
      ),
      true,
    );
  });
});

test("Routing runtime degrades threadless prompts to classic when topic targets are stale", async () => {
  await withTopicStore(async (threadStore) => {
    const apiCalls: unknown[] = [];
    threadStore.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 100, threadId: 42 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
    });
    await threadStore.persist();
    const { routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
      callApi: async (method, body) => {
        apiCalls.push({ method, body });
        throw new Error(
          "Telegram API sendChatAction failed: Bad Request: message thread not found",
        );
      },
    });

    await routeRuntime.handleUpdate(
      {
        message: {
          message_id: 12,
          chat: { id: 100, type: "private" },
          from: { id: 7, is_bot: false },
          text: "classic prompt",
        },
      },
      { cwd: "/repo" },
    );

    assert.deepEqual(apiCalls, [
      {
        method: "sendChatAction",
        body: { chat_id: 100, message_thread_id: 42, action: "typing" },
      },
    ]);
    assert.equal(threadStore.getBotState().threadMode, "disabled");
    const queued = telegramQueueStore.getQueuedItems()[0];
    assert.equal(queued?.kind, "prompt");
    assert.deepEqual(queued?.target, { chatId: 100 });
  });
});

test("Routing runtime assigns guest-mode prompts to the current transport leader", async () => {
  const { routeRuntime, telegramQueueStore } = createRouteHarness({
  });

  await routeRuntime.handleUpdate(
    {
      guest_message: {
        guest_query_id: "guest-1",
        chat: { type: "supergroup", title: "Guest Room" } as never,
        from: { id: 7, is_bot: false, username: "guest" } as TestUser & {
          username: string;
        },
        text: "guest question",
      },
    },
    { cwd: "/repo" },
  );

  const queued = telegramQueueStore.getQueuedItems()[0];
  assert.equal(queued?.kind, "prompt");
  assert.equal(
    queued?.kind === "prompt" ? queued.guestQueryId : undefined,
    "guest-1",
  );
  assert.equal(queued?.kind === "prompt" ? queued.chatId : undefined, 0);
  assert.equal(
    queued?.kind === "prompt" ? queued.target : undefined,
    undefined,
  );
  assert.match(
    queued?.kind === "prompt" && queued.content[0]?.type === "text"
      ? queued.content[0].text
      : "",
    /^\[telegram\|guest:Guest Room\] guest question$/,
  );
});

test("Routing runtime labels private guest-mode prompts with dm metadata", async () => {
  const { routeRuntime, telegramQueueStore } = createRouteHarness({});

  await routeRuntime.handleUpdate(
    {
      guest_message: {
        guest_query_id: "guest-dm-1",
        chat: { id: 99, type: "private", username: "guest" } as never,
        from: { id: 7, is_bot: false, username: "llblab" } as TestUser & {
          username: string;
        },
        text: "private guest question",
      },
    },
    { cwd: "/repo" },
  );

  const queued = telegramQueueStore.getQueuedItems()[0];
  assert.equal(
    queued?.kind === "prompt" && queued.content[0]?.type === "text"
      ? queued.content[0].text
      : "",
    "[telegram|guest:guest] private guest question",
  );
});

test("Routing runtime labels owner-authored private guest turns with the remote chat peer", async () => {
  const { routeRuntime, telegramQueueStore } = createRouteHarness({});

  await routeRuntime.handleUpdate(
    {
      guest_message: {
        guest_query_id: "guest-dm-owner-1",
        chat: {
          id: 99,
          type: "private",
          username: "counterparty",
          first_name: "Remote",
        } as never,
        from: { id: 7, is_bot: false, username: "llblab" } as TestUser & {
          username: string;
        },
        text: "@k1awbot attach something",
      },
    },
    { cwd: "/repo" },
  );

  const queued = telegramQueueStore.getQueuedItems()[0];
  assert.equal(
    queued?.kind === "prompt" && queued.content[0]?.type === "text"
      ? queued.content[0].text
      : "",
    "[telegram|guest:counterparty] @k1awbot attach something",
  );
});

test("Guest peer resolver never labels the paired owner and uses stable fallbacks", () => {
  assert.equal(
    Routing.resolveTelegramGuestPromptPeer({
      chatType: "private",
      from: { id: 99, username: "remote" },
      ownerUserId: 7,
    }),
    "remote",
  );
  assert.equal(
    Routing.resolveTelegramGuestPromptPeer({
      chatType: "private",
      chat: { id: 99, username: "renamedremote" },
      from: { id: 840585, username: "profileowner" },
      ownerUserId: 840585,
    }),
    "renamedremote",
  );
  assert.equal(
    Routing.resolveTelegramGuestPromptPeer({
      chatType: "private",
      chat: { id: 99, first_name: "Maria", last_name: "Example" },
      from: { id: 7, username: "llblab" },
      ownerUserId: 7,
    }),
    "Maria Example",
  );
  assert.equal(
    Routing.resolveTelegramGuestPromptPeer({
      chatType: "private",
      chat: { id: 99 },
      from: { id: 7, username: "llblab" },
      ownerUserId: 7,
    }),
    "99",
  );
  assert.equal(
    Routing.resolveTelegramGuestPromptPeer({
      chatType: "private",
      chat: { id: 99, username: "remote" },
      from: { id: 7, username: "llblab" },
      ownerUserId: 7,
    }),
    "remote",
  );
  assert.equal(
    Routing.resolveTelegramGuestPromptPeer({
      chatType: "private",
      from: { id: 7, username: "llblab" },
      replyFrom: { id: 99, is_bot: false, username: "remote" },
      ownerUserId: 7,
    }),
    "remote",
  );
  assert.equal(
    Routing.resolveTelegramGuestPromptPeer({
      chatType: "private",
      chat: { id: 7, username: "llblab" },
      from: { id: 7, username: "llblab" },
      replyFrom: { id: 123, is_bot: true, username: "k1awbot" },
      ownerUserId: 7,
    }),
    undefined,
  );
});

test("Routing runtime separates private guest identity from replied peer metadata", async () => {
  const { routeRuntime, telegramQueueStore } = createRouteHarness({});

  await routeRuntime.handleUpdate(
    {
      guest_message: {
        guest_query_id: "guest-dm-reply-1",
        chat: {
          id: 98,
          type: "private",
          username: "counterparty",
        } as never,
        from: { id: 7, is_bot: false, username: "llblab" } as TestUser & {
          username: string;
        },
        text: "@k1awbot test",
        reply_to_message: {
          message_id: 22,
          chat: { id: 7, type: "private" },
          from: {
            id: 99,
            is_bot: false,
            username: "quotedparty",
          } as TestUser & {
            username: string;
          },
          photo: [{ file_id: "photo", file_unique_id: "photo-u", width: 1, height: 1 }],
        } as TestMessage,
      },
    },
    { cwd: "/repo" },
  );

  const queued = telegramQueueStore.getQueuedItems()[0];
  assert.equal(
    queued?.kind === "prompt" && queued.content[0]?.type === "text"
      ? queued.content[0].text
      : "",
    [
      "[telegram|guest:counterparty] @k1awbot test",
      "",
      "[reply|from:quotedparty]",
      "",
      "[attachments|from:quotedparty] /tmp",
      "- /photo-22.jpg",
    ].join("\n"),
  );
});

test("Routing runtime keeps private guest identity when replying to the bot", async () => {
  const { routeRuntime, telegramQueueStore } = createRouteHarness({});

  await routeRuntime.handleUpdate(
    {
      guest_message: {
        guest_query_id: "guest-dm-bot-reply-1",
        chat: {
          id: 99,
          type: "private",
          username: "counterparty",
        } as never,
        from: { id: 7, is_bot: false, username: "llblab" } as TestUser & {
          username: string;
        },
        text: "@k1awbot follow up",
        reply_to_message: {
          message_id: 23,
          chat: { id: 99, type: "private" },
          from: { id: 123, is_bot: true, username: "k1awbot" } as TestUser & {
            username: string;
          },
          text: "Bot answer",
        } as TestMessage,
      },
    },
    { cwd: "/repo" },
  );

  const queued = telegramQueueStore.getQueuedItems()[0];
  assert.equal(
    queued?.kind === "prompt" && queued.content[0]?.type === "text"
      ? queued.content[0].text
      : "",
    [
      "[telegram|guest:counterparty] @k1awbot follow up",
      "",
      "[reply|from:k1awbot] Bot answer",
    ].join("\n"),
  );
});

test("Routing runtime preserves follower thread target for generated button callbacks", async () => {
  const { buttonActionStore, events, routeRuntime, telegramQueueStore } =
    createRouteHarness({
    });
  const callbackData = buttonActionStore.register({
    text: "Continue",
    prompt: "Continue from button",
  });

  await routeRuntime.handleUpdate(
    {
      callback_query: {
        id: "callback-1",
        from: { id: 7, is_bot: false },
        data: callbackData,
        message: {
          message_id: 44,
          message_thread_id: 55,
          chat: { id: 100, type: "private" },
          from: { id: 7, is_bot: false },
        },
      },
    },
    { cwd: "/repo" },
  );

  const queued = telegramQueueStore.getQueuedItems()[0];
  assert.equal(queued?.kind, "prompt");
  assert.deepEqual(queued?.kind === "prompt" ? queued.target : undefined, {
    chatId: 100,
    threadId: 55,
  });
  assert.equal(
    queued?.kind === "prompt" ? queued.replyToMessageId : undefined,
    44,
  );
  assert.equal(events.includes("dispatch"), true);
});

test("Routing runtime treats All menu commands as threaded target chooser", async () => {
  await withTopicStore(async (threadStore) => {
    threadStore.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 100, threadId: 42 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
      threadName: "Axial",
    });
    threadStore.upsert({
      profileKey: "manual:follower-b",
      owner: { kind: "manual-follower", instanceId: "follower-b" },
      target: { chatId: 100, threadId: 43 },
      status: "starting",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "follower-b",
      slot: "B",
    });
    threadStore.upsert({
      profileKey: "manual:follower-c",
      owner: { kind: "manual-follower", instanceId: "follower-c" },
      target: { chatId: 100, threadId: 44 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "follower-c",
      slot: "C",
    });
    await threadStore.persist();
    const { events, routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
    });

    for (const [index, text] of ["/start", "/status"].entries()) {
      await routeRuntime.handleUpdate(
        {
          message: {
            message_id: 12 + index,
            chat: { id: 100, type: "private" },
            from: { id: 7, is_bot: false },
            text,
          },
        },
        { cwd: "/repo" },
      );
    }

    assert.deepEqual(telegramQueueStore.getQueuedItems(), []);
    assert.equal(events.includes("status-menu"), false);
    const chooserMessages = events.filter((event) =>
      event.startsWith("interactive:html:"),
    );
    assert.equal(chooserMessages.length, 2);
    for (const chooser of chooserMessages) {
      assert.match(chooser, /<b>🧵 Choose target thread<\/b>/);
      assert.match(chooser, /You used <code>\/(?:start|status)<\/code> from the <b>All<\/b> tab\./);
      assert.match(chooser, /Select the Pi thread that should handle it:/);
      assert.doesNotMatch(chooser, /<code>active<\/code>/);
      assert.doesNotMatch(chooser, /<code>starting<\/code>/);
    }
    const markups = events.filter((event) => event.startsWith("markup:"));
    assert.equal(markups.length, 2);
    assert.match(markups[0] ?? "", /"text":"↪️ Axial"/);
    assert.match(markups[0] ?? "", /"text":"↪️ Coral"/);
    assert.doesNotMatch(markups[0] ?? "", /"text":"A Axial"/);
    assert.match(markups[0] ?? "", /allmenu:start:42/);
    assert.match(markups[0] ?? "", /allmenu:start:44/);
    assert.match(markups[1] ?? "", /allmenu:status:42/);
    assert.doesNotMatch(markups.join("\n"), /allmenu:start:43/);
    const options = events.filter((event) =>
      event.startsWith("interactive-options:"),
    );
    assert.deepEqual(options, [
      'interactive-options:{"replyToMessageId":12}',
      'interactive-options:{"replyToMessageId":13}',
    ]);
  });
});

test("Routing runtime filters All chooser buttons to live routable thread targets", async () => {
  await withTopicStore(async (threadStore) => {
    for (const record of [
      {
        profileKey: "leader:/repo",
        target: { chatId: 100, threadId: 42 },
        instanceId: "leader-a",
        slot: "A",
        threadName: "Axial",
      },
      {
        profileKey: "manual:follower-old",
        target: { chatId: 100, threadId: 99 },
        instanceId: "follower-old",
        slot: "Z",
        threadName: "Zombie",
      },
    ]) {
      threadStore.upsert({
        ...record,
        status: "active",
        createdAtMs: 1000,
        updatedAtMs: 1000,
      });
    }
    await threadStore.persist();
    const { events, routeRuntime } = createRouteHarness({
      threadStore,
      getLiveThreadTargets: () => [{ chatId: 100, threadId: 42 }],
    });

    await routeRuntime.handleUpdate(
      {
        message: {
          message_id: 20,
          chat: { id: 100, type: "private" },
          from: { id: 7, is_bot: false },
          text: "/start",
        },
      },
      { cwd: "/repo" },
    );
    const markup = events.find((event) => event.startsWith("markup:"));
    assert.match(markup ?? "", /allmenu:start:42/);
    assert.doesNotMatch(markup ?? "", /allmenu:start:99/);
    assert.doesNotMatch(markup ?? "", /Zombie/);

    await routeRuntime.handleUpdate(
      {
        callback_query: {
          id: "stale-cb",
          from: { id: 7, is_bot: false },
          message: {
            message_id: 99,
            chat: { id: 100, type: "private" },
          },
          data: "allmenu:start:99",
        },
      },
      { cwd: "/repo" },
    );
    assert.equal(events.includes("status-menu"), false);
    assert.equal(events.includes("answer:Thread is not active yet."), true);
  });
});

test("Routing runtime treats extension and prompt-template commands as All chooser commands", async () => {
  await withTopicStore(async (threadStore) => {
    threadStore.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 100, threadId: 42 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
      threadName: "Axial",
    });
    await threadStore.persist();
    const dispose = Commands.registerTelegramCommand({
      name: "review",
      handler: async () => undefined,
    });
    try {
      const { events, routeRuntime, telegramQueueStore } = createRouteHarness({
        threadStore,
        getCommands: () => [
          {
            name: "fix-tests",
            source: "prompt",
            sourceInfo: { path: "/tmp/fix-tests.md" },
          },
        ],
      });

      for (const [index, text] of ["/review", "/fix_tests"].entries()) {
        await routeRuntime.handleUpdate(
          {
            message: {
              message_id: 20 + index,
              chat: { id: 100, type: "private" },
              from: { id: 7, is_bot: false },
              text,
            },
          },
          { cwd: "/repo" },
        );
      }

      assert.deepEqual(telegramQueueStore.getQueuedItems(), []);
      const chooserMessages = events.filter((event) =>
        event.startsWith("interactive:html:"),
      );
      assert.equal(chooserMessages.length, 2);
      assert.match(chooserMessages[0] ?? "", /You used <code>\/review<\/code>/);
      assert.match(
        chooserMessages[1] ?? "",
        /You used <code>\/fix_tests<\/code>/,
      );
      const markups = events.filter((event) => event.startsWith("markup:"));
      assert.match(markups[0] ?? "", /allmenu:review:42/);
      assert.match(markups[1] ?? "", /allmenu:fix_tests:42/);
    } finally {
      dispose();
    }
  });
});

test("Routing runtime keeps extension command replies in the invoking thread", async () => {
  await withTopicStore(async (threadStore) => {
    threadStore.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 100, threadId: 42 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
    });
    await threadStore.persist();
    const successDispose = Commands.registerTelegramCommand({
      name: "pingx",
      handler: async ({ reply }) => reply("pong"),
    });
    const failureDispose = Commands.registerTelegramCommand({
      name: "failx",
      handler: async () => {
        throw new Error("boom");
      },
    });
    try {
      const { events, routeRuntime } = createRouteHarness({
        threadStore,
      });

      for (const [index, text] of ["/pingx", "/failx"].entries()) {
        await routeRuntime.handleUpdate(
          {
            message: {
              message_id: 30 + index,
              chat: { id: 100, type: "private" },
              from: { id: 7, is_bot: false },
              message_thread_id: 42,
              text,
            },
          },
          { cwd: "/repo" },
        );
      }

      assert.equal(events.includes("reply:pong"), true);
      assert.equal(events.includes("reply:Command failed."), true);
      assert.equal(
        events.filter((event) => event === "reply-target:100:42").length,
        2,
      );
    } finally {
      successDispose();
      failureDispose();
    }
  });
});

test("Routing runtime opens selected All menu command in the target thread", async () => {
  await withTopicStore(async (threadStore) => {
    threadStore.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 100, threadId: 42 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
      threadName: "Axial",
    });
    await threadStore.persist();
    const { events, routeRuntime } = createRouteHarness({
      threadStore,
    });

    await routeRuntime.handleUpdate(
      {
        message: {
          message_id: 12,
          chat: { id: 100, type: "private" },
          from: { id: 7, is_bot: false },
          text: "/start",
        },
      },
      { cwd: "/repo" },
    );
    await routeRuntime.handleUpdate(
      {
        callback_query: {
          id: "cb1",
          from: { id: 7, is_bot: false },
          message: {
            message_id: 99,
            chat: { id: 100, type: "private" },
          },
          data: "allmenu:start:42",
        },
      },
      { cwd: "/repo" },
    );

    assert.equal(events.includes("status-menu"), true);
  });
});

test("Routing runtime preserves later unbound threads and offers reroute", async () => {
  await withTopicStore(async (threadStore) => {
    const apiCalls: unknown[] = [];
    threadStore.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 100, threadId: 7 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
    });
    await threadStore.persist();
    const { events, routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
      callApi: async (method, body) => {
        apiCalls.push({ method, body });
        return {} as never;
      },
    });

    await routeRuntime.handleUpdate(unboundTopicUpdate(), { cwd: "/repo" });

    assert.equal(threadStore.getByProfileKey("topic:100:42"), undefined);
    assert.deepEqual(apiCalls, [
      {
        method: "sendChatAction",
        body: { chat_id: 100, message_thread_id: 7, action: "typing" },
      },
    ]);
    assert.deepEqual(telegramQueueStore.getQueuedItems(), []);
    const chooser = events.find((event) => event.startsWith("interactive:"));
    assert.match(chooser ?? "", /New thread is not a Pi instance/);
    assert.match(chooser ?? "", /To create a bound Telegram tab:/);
    assert.match(chooser ?? "", /Your message is still in this Telegram thread\./);
    assert.match(chooser ?? "", /Select the Pi thread that should handle it:/);
    const markup = events.find((event) => event.startsWith("markup:"));
    assert.match(markup ?? "", /"callback_data":"reroute:1:7"/);
    assert.match(markup ?? "", /"callback_data":"rerouterestore:1"/);

    await routeRuntime.handleUpdate(
      {
        callback_query: {
          id: "reroute-cb",
          from: { id: 7, is_bot: false },
          message: {
            message_id: 99,
            message_thread_id: 42,
            chat: { id: 100, type: "private" },
          },
          data: "reroute:1:7",
        },
      },
      { cwd: "/repo" },
    );

    const record = threadStore.getByProfileKey("cwd:/repo");
    assert.deepEqual(record?.target, { chatId: 100, threadId: 42 });
    const queued = telegramQueueStore.getQueuedItems()[0];
    assert.equal(queued?.kind, "prompt");
    assert.equal(
      queued?.kind === "prompt" && queued.content[0]?.type === "text"
        ? queued.content[0].text
        : "",
      "[telegram|thread:Anchor] hello",
    );
    assert.equal(events.includes("delete-message:100:99"), true);
    assert.deepEqual(apiCalls, [
      {
        method: "sendChatAction",
        body: { chat_id: 100, message_thread_id: 7, action: "typing" },
      },
      {
        method: "editForumTopic",
        body: { chat_id: 100, message_thread_id: 42, name: "Anchor" },
      },
    ]);
  });
});

test("Routing runtime answers expired reroute callbacks without queueing", async () => {
  const { events, routeRuntime, telegramQueueStore } = createRouteHarness({
  });

  await routeRuntime.handleUpdate(
    {
      callback_query: {
        id: "reroute-expired",
        from: { id: 7, is_bot: false },
        message: {
          message_id: 99,
          message_thread_id: 42,
          chat: { id: 100, type: "private" },
        },
        data: "reroute:missing:7",
      },
    },
    { cwd: "/repo" },
  );

  assert.equal(events.includes("answer:Message route expired."), true);
  assert.deepEqual(telegramQueueStore.getQueuedItems(), []);
});

test("Routing runtime answers stale reroute target callbacks gracefully", async () => {
  await withTopicStore(async (threadStore) => {
    threadStore.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 100, threadId: 7 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
    });
    await threadStore.persist();
    const { events, routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
      callApi: async () => ({}) as never,
    });

    await routeRuntime.handleUpdate(unboundTopicUpdate(), { cwd: "/repo" });
    threadStore.markStaleByTarget(
      { chatId: 100, threadId: 7 },
      "deleted",
      "target deleted before callback",
    );
    await threadStore.persist();

    await routeRuntime.handleUpdate(
      {
        callback_query: {
          id: "reroute-stale-target",
          from: { id: 7, is_bot: false },
          message: {
            message_id: 99,
            message_thread_id: 42,
            chat: { id: 100, type: "private" },
          },
          data: "reroute:1:7",
        },
      },
      { cwd: "/repo" },
    );

    assert.equal(events.includes("answer:Thread is not active yet."), true);
    assert.deepEqual(telegramQueueStore.getQueuedItems(), []);
  });
});

test("Routing runtime forwards media-group reroutes to foreign follower targets", async () => {
  await withTopicStore(async (threadStore) => {
    const forwardedMessages: TestMessage[] = [];
    const apiCalls: unknown[] = [];
    threadStore.upsert({
      profileKey: "cwd:/repo",
      owner: { kind: "leader", cwd: "/repo", instanceId: "leader-a" },
      target: { chatId: 100, threadId: 7 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
      rerouteConfirmedAtMs: 1500,
    });
    threadStore.upsert({
      profileKey: "follower:beta",
      owner: { kind: "manual-follower", instanceId: "follower-b" },
      target: { chatId: 100, threadId: 8 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "follower-b",
      slot: "B",
      threadName: "Beta",
    });
    await threadStore.persist();
    const { events, routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
      callApi: async (method, body) => {
        apiCalls.push({ method, body });
        return {} as never;
      },
      getLiveThreadTargets: () => [
        { chatId: 100, threadId: 7 },
        { chatId: 100, threadId: 8 },
      ],
      foreignOwnedUpdateForwarder: {
        forwardMessage: ({ message }) => {
          forwardedMessages.push(message);
          return true;
        },
      },
    });

    await routeRuntime.handleUpdate(
      {
        message: {
          message_id: 11,
          message_thread_id: 42,
          media_group_id: "album-1",
          chat: { id: 100, type: "private" },
          from: { id: 7, is_bot: false },
          photo: [
            {
              file_id: "photo-a",
              file_unique_id: "photo-a",
              width: 320,
              height: 240,
            },
          ],
          caption: "first",
        },
      },
      { cwd: "/repo" },
    );
    await routeRuntime.handleUpdate(
      {
        message: {
          message_id: 12,
          message_thread_id: 42,
          media_group_id: "album-1",
          chat: { id: 100, type: "private" },
          from: { id: 7, is_bot: false },
          photo: [
            {
              file_id: "photo-b",
              file_unique_id: "photo-b",
              width: 320,
              height: 240,
            },
          ],
        },
      },
      { cwd: "/repo" },
    );
    await new Promise((resolve) => setTimeout(resolve, 1250));

    const markup = events.find((event) => event.startsWith("markup:"));
    assert.match(markup ?? "", /"callback_data":"reroute:1:8"/);
    await routeRuntime.handleUpdate(
      {
        callback_query: {
          id: "reroute-cb",
          from: { id: 7, is_bot: false },
          message: {
            message_id: 99,
            message_thread_id: 42,
            chat: { id: 100, type: "private" },
          },
          data: "reroute:1:8",
        },
      },
      { cwd: "/repo" },
    );

    assert.equal(telegramQueueStore.getQueuedItems().length, 0);
    assert.deepEqual(
      forwardedMessages.map((message) => ({
        messageId: message.message_id,
        threadId: message.message_thread_id,
        photoId: message.photo?.[0]?.file_id,
      })),
      [
        { messageId: 0, threadId: 8, photoId: "photo-a" },
        { messageId: 0, threadId: 8, photoId: "photo-b" },
      ],
    );
    assert.equal(events.includes("delete-message:100:99"), true);
    assert.deepEqual(apiCalls.at(-2), {
      method: "closeForumTopic",
      body: { chat_id: 100, message_thread_id: 42 },
    });
    assert.deepEqual(apiCalls.at(-1), {
      method: "deleteForumTopic",
      body: { chat_id: 100, message_thread_id: 42 },
    });
  });
});

test("Routing runtime routes reroute source to confirmed current leader thread", async () => {
  await withTopicStore(async (threadStore) => {
    const apiCalls: unknown[] = [];
    threadStore.upsert({
      profileKey: "cwd:/repo",
      owner: { kind: "leader", cwd: "/repo", instanceId: "leader-a" },
      target: { chatId: 100, threadId: 7 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
      lastReconcileAction: "leader-startup-probe",
      rerouteConfirmedAtMs: 1500,
    });
    await threadStore.persist();
    const { events, routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
      callApi: async (method, body) => {
        apiCalls.push({ method, body });
        return {} as never;
      },
    });

    await routeRuntime.handleUpdate(unboundTopicUpdate(), { cwd: "/repo" });
    const markup = events.find((event) => event.startsWith("markup:"));
    assert.match(markup ?? "", /"callback_data":"rerouterestore:1"/);
    assert.match(markup ?? "", /"text":"🔁 Replace\/restore thread…"/);
    assert.match(markup ?? "", /"callback_data":"reroute:1:7"/);
    assert.doesNotMatch(markup ?? "", /"callback_data":"reroutenew:1:7"/);
    await routeRuntime.handleUpdate(
      {
        callback_query: {
          id: "reroute-cb",
          from: { id: 7, is_bot: false },
          message: {
            message_id: 99,
            message_thread_id: 42,
            chat: { id: 100, type: "private" },
          },
          data: "reroute:1:7",
        },
      },
      { cwd: "/repo" },
    );

    const record = threadStore.getByProfileKey("cwd:/repo");
    assert.deepEqual(record?.target, { chatId: 100, threadId: 7 });
    const queued = telegramQueueStore.getQueuedItems()[0];
    assert.equal(queued?.kind, "prompt");
    assert.deepEqual(queued?.target, { chatId: 100, threadId: 7 });
    assert.deepEqual(apiCalls, [
      {
        method: "sendChatAction",
        body: { chat_id: 100, message_thread_id: 7, action: "typing" },
      },
      {
        method: "closeForumTopic",
        body: { chat_id: 100, message_thread_id: 42 },
      },
      {
        method: "deleteForumTopic",
        body: { chat_id: 100, message_thread_id: 42 },
      },
    ]);
  });
});

test("Routing runtime assigns a new slot when user explicitly chooses source thread", async () => {
  await withTopicStore(async (threadStore) => {
    const apiCalls: unknown[] = [];
    threadStore.upsert({
      profileKey: "cwd:/repo",
      owner: { kind: "leader", cwd: "/repo", instanceId: "leader-a" },
      target: { chatId: 100, threadId: 7 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
      threadName: "Coral",
      rerouteConfirmedAtMs: 1500,
    });
    await threadStore.persist();
    const { events, routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
      callApi: async (method, body) => {
        apiCalls.push({ method, body });
        return {} as never;
      },
    });

    await routeRuntime.handleUpdate(unboundTopicUpdate(), { cwd: "/repo" });
    const markup = events.find((event) => event.startsWith("markup:"));
    assert.match(markup ?? "", /"callback_data":"rerouterestore:1"/);
    await routeRuntime.handleUpdate(
      {
        callback_query: {
          id: "restore-menu-cb",
          from: { id: 7, is_bot: false },
          message: {
            message_id: 99,
            message_thread_id: 42,
            chat: { id: 100, type: "private" },
          },
          data: "rerouterestore:1",
        },
      },
      { cwd: "/repo" },
    );
    const restoreMarkup = events.filter((event) => event.startsWith("markup:")).at(-1);
    assert.match(restoreMarkup ?? "", /"callback_data":"reroutenew:1:7"/);
    await routeRuntime.handleUpdate(
      {
        callback_query: {
          id: "reroute-cb",
          from: { id: 7, is_bot: false },
          message: {
            message_id: 99,
            message_thread_id: 42,
            chat: { id: 100, type: "private" },
          },
          data: "reroutenew:1:7",
        },
      },
      { cwd: "/repo" },
    );

    const record = threadStore.getByProfileKey("cwd:/repo");
    assert.deepEqual(record?.target, { chatId: 100, threadId: 42 });
    assert.equal(record?.slot, "B");
    assert.equal(record?.threadName, "Coral");
    assert.equal(typeof record?.rerouteConfirmedAtMs, "number");
    const queued = telegramQueueStore.getQueuedItems()[0];
    assert.equal(queued?.kind, "prompt");
    assert.deepEqual(queued?.target, { chatId: 100, threadId: 42 });
    assert.deepEqual(apiCalls, [
      {
        method: "sendChatAction",
        body: { chat_id: 100, message_thread_id: 7, action: "typing" },
      },
      {
        method: "editForumTopic",
        body: { chat_id: 100, message_thread_id: 42, name: "Coral" },
      },
      {
        method: "closeForumTopic",
        body: { chat_id: 100, message_thread_id: 7 },
      },
      {
        method: "deleteForumTopic",
        body: { chat_id: 100, message_thread_id: 7 },
      },
    ]);
  });
});

test("Routing runtime blocks follower thread restore until bus replacement exists", async () => {
  await withTopicStore(async (threadStore) => {
    threadStore.upsert({
      profileKey: "cwd:/repo",
      owner: { kind: "leader", cwd: "/repo", instanceId: "leader-a" },
      target: { chatId: 100, threadId: 7 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
      rerouteConfirmedAtMs: 1500,
    });
    threadStore.upsert({
      profileKey: "manual:follower-b",
      owner: { kind: "manual-follower", instanceId: "follower-b" },
      target: { chatId: 100, threadId: 8 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "follower-b",
      slot: "B",
      threadName: "Beta",
    });
    await threadStore.persist();
    const { events, routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
      getLiveThreadTargets: () => [
        { chatId: 100, threadId: 7 },
        { chatId: 100, threadId: 8 },
      ],
    });

    await routeRuntime.handleUpdate(unboundTopicUpdate(), { cwd: "/repo" });
    await routeRuntime.handleUpdate(
      {
        callback_query: {
          id: "restore-menu-cb",
          from: { id: 7, is_bot: false },
          message: {
            message_id: 99,
            message_thread_id: 42,
            chat: { id: 100, type: "private" },
          },
          data: "rerouterestore:1",
        },
      },
      { cwd: "/repo" },
    );
    const restoreMarkup = events.filter((event) => event.startsWith("markup:")).at(-1);
    assert.match(restoreMarkup ?? "", /"text":"➡️ Anchor"/);
    assert.match(restoreMarkup ?? "", /"callback_data":"reroutenew:1:7"/);
    assert.match(restoreMarkup ?? "", /"text":"➡️ Beta"/);
    assert.match(restoreMarkup ?? "", /"callback_data":"reroutenew:1:8"/);

    await routeRuntime.handleUpdate(
      {
        callback_query: {
          id: "restore-follower-cb",
          from: { id: 7, is_bot: false },
          message: {
            message_id: 99,
            message_thread_id: 42,
            chat: { id: 100, type: "private" },
          },
          data: "reroutenew:1:8",
        },
      },
      { cwd: "/repo" },
    );

    assert.equal(telegramQueueStore.getQueuedItems().length, 0);
    assert.equal(threadStore.getByProfileKey("manual:follower-b")?.target.threadId, 8);
    assert.match(
      events.join("\n"),
      /answer:Follower thread restore is not available yet\./,
    );
  });
});

test("Routing runtime restores follower thread through bus replacement", async () => {
  await withTopicStore(async (threadStore) => {
    const apiCalls: unknown[] = [];
    const replacements: unknown[] = [];
    const forwardedMessages: TestMessage[] = [];
    threadStore.upsert({
      profileKey: "cwd:/repo",
      owner: { kind: "leader", cwd: "/repo", instanceId: "leader-a" },
      target: { chatId: 100, threadId: 7 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
      rerouteConfirmedAtMs: 1500,
    });
    threadStore.upsert({
      profileKey: "manual:follower-b",
      owner: { kind: "manual-follower", instanceId: "follower-b" },
      target: { chatId: 100, threadId: 8 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "follower-b",
      slot: "B",
      threadName: "Beta",
    });
    await threadStore.persist();
    const { events, routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
      getLiveThreadTargets: () => [
        { chatId: 100, threadId: 7 },
        { chatId: 100, threadId: 8 },
      ],
      callApi: async (method, body) => {
        apiCalls.push({ method, body });
        return {} as never;
      },
      replaceFollowerThreadTarget: async (input) => {
        replacements.push(input);
        return true;
      },
      foreignOwnedUpdateForwarder: {
        forwardMessage: ({ message }) => {
          forwardedMessages.push(message);
          return true;
        },
      },
    });

    await routeRuntime.handleUpdate(unboundTopicUpdate(), { cwd: "/repo" });
    await routeRuntime.handleUpdate(
      {
        callback_query: {
          id: "restore-menu-cb",
          from: { id: 7, is_bot: false },
          message: {
            message_id: 99,
            message_thread_id: 42,
            chat: { id: 100, type: "private" },
          },
          data: "rerouterestore:1",
        },
      },
      { cwd: "/repo" },
    );
    await routeRuntime.handleUpdate(
      {
        callback_query: {
          id: "restore-follower-cb",
          from: { id: 7, is_bot: false },
          message: {
            message_id: 99,
            message_thread_id: 42,
            chat: { id: 100, type: "private" },
          },
          data: "reroutenew:1:8",
        },
      },
      { cwd: "/repo" },
    );

    assert.deepEqual(replacements, [
      {
        record: {
          profileKey: "manual:follower-b",
          owner: { kind: "manual-follower", instanceId: "follower-b" },
          target: { chatId: 100, threadId: 8 },
          status: "active",
          createdAtMs: 1000,
          updatedAtMs: 1000,
          instanceId: "follower-b",
          slot: "B",
          threadName: "Beta",
        },
        target: { chatId: 100, threadId: 42 },
        oldTarget: { chatId: 100, threadId: 8 },
      },
    ]);
    const record = threadStore.getByProfileKey("manual:follower-b");
    assert.deepEqual(record?.target, { chatId: 100, threadId: 42 });
    assert.equal(record?.slot, "B");
    assert.equal(record?.threadName, "Beta");
    assert.equal(telegramQueueStore.getQueuedItems().length, 0);
    assert.deepEqual(
      forwardedMessages.map((message) => ({
        threadId: message.message_thread_id,
        text: message.text,
      })),
      [{ threadId: 42, text: "hello" }],
    );
    assert.deepEqual(apiCalls, [
      {
        method: "sendChatAction",
        body: { chat_id: 100, message_thread_id: 7, action: "typing" },
      },
      {
        method: "editForumTopic",
        body: { chat_id: 100, message_thread_id: 42, name: "Beta" },
      },
      {
        method: "closeForumTopic",
        body: { chat_id: 100, message_thread_id: 8 },
      },
      {
        method: "deleteForumTopic",
        body: { chat_id: 100, message_thread_id: 8 },
      },
    ]);
    assert.match(events.join("\n"), /answer:Message routed\./);
  });
});

test("Routing runtime reclaims unbound prompt without visible rename when current leader target is stale", async () => {
  await withTopicStore(async (threadStore) => {
    const apiCalls: unknown[] = [];
    threadStore.upsert({
      profileKey: "cwd:/repo",
      owner: { kind: "leader", cwd: "/repo", instanceId: "leader-a" },
      target: { chatId: 100, threadId: 7 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
      threadName: "Axial",
    });
    await threadStore.persist();
    const { events, routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
      callApi: async (method, body) => {
        apiCalls.push({ method, body });
        if (method === "sendChatAction") {
          throw new Error("Telegram API sendChatAction failed: HTTP 400: Bad Request: message thread not found");
        }
        return {} as never;
      },
    });

    await routeRuntime.handleUpdate(unboundTopicUpdate(), { cwd: "/repo" });

    const record = threadStore.getByProfileKey("cwd:/repo");
    assert.deepEqual(record?.target, { chatId: 100, threadId: 42 });
    assert.equal(record?.threadName, "Axial");
    const queued = telegramQueueStore.getQueuedItems()[0];
    assert.equal(queued?.kind, "prompt");
    assert.deepEqual(queued?.target, { chatId: 100, threadId: 42 });
    assert.equal(
      queued?.kind === "prompt" && queued.content[0]?.type === "text"
        ? queued.content[0].text
        : "",
      "[telegram|thread:Axial] hello",
    );
    assert.deepEqual(apiCalls, [
      {
        method: "sendChatAction",
        body: { chat_id: 100, message_thread_id: 7, action: "typing" },
      },
    ]);
    assert.equal(events.some((event) => event.startsWith("interactive:")), false);
    assert.equal(events.some((event) => event.includes("closeForumTopic")), false);
    assert.equal(events.some((event) => event.includes("deleteForumTopic")), false);
  });
});

test("Routing runtime assigns internal baked name when reclaiming unnamed stale current leader target", async () => {
  await withTopicStore(async (threadStore) => {
    const apiCalls: unknown[] = [];
    threadStore.upsert({
      profileKey: "cwd:/repo",
      owner: { kind: "leader", cwd: "/repo", instanceId: "leader-a" },
      target: { chatId: 100, threadId: 7 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
    });
    await threadStore.persist();
    const { routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
      callApi: async (method, body) => {
        apiCalls.push({ method, body });
        if (method === "sendChatAction") {
          throw new Error("Telegram API sendChatAction failed: HTTP 400: Bad Request: message thread not found");
        }
        return {} as never;
      },
    });

    await routeRuntime.handleUpdate(unboundTopicUpdate(), { cwd: "/repo" });

    const record = threadStore.getByProfileKey("cwd:/repo");
    assert.deepEqual(record?.target, { chatId: 100, threadId: 42 });
    assert.equal(record?.threadName, "Anchor");
    const queued = telegramQueueStore.getQueuedItems()[0];
    assert.equal(
      queued?.kind === "prompt" && queued.content[0]?.type === "text"
        ? queued.content[0].text
        : "",
      "[telegram|thread:Anchor] hello",
    );
    assert.deepEqual(apiCalls, [
      {
        method: "sendChatAction",
        body: { chat_id: 100, message_thread_id: 7, action: "typing" },
      },
    ]);
  });
});

test("Routing runtime reclaims reroute source when selected stale leader target has prior instance id", async () => {
  await withTopicStore(async (threadStore) => {
    const apiCalls: unknown[] = [];
    threadStore.upsert({
      profileKey: "cwd:/repo",
      owner: { kind: "leader", cwd: "/repo", instanceId: "old-leader" },
      target: { chatId: 100, threadId: 7 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "old-leader",
      slot: "A",
      threadName: "Axial",
    });
    await threadStore.persist();
    let chatActionCalls = 0;
    const { events, routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
      callApi: async (method, body) => {
        apiCalls.push({ method, body });
        if (method === "sendChatAction") {
          chatActionCalls += 1;
          if (chatActionCalls > 1) {
            throw new Error("Telegram API sendChatAction failed: HTTP 400: Bad Request: message thread not found");
          }
        }
        return {} as never;
      },
    });

    await routeRuntime.handleUpdate(unboundTopicUpdate(), { cwd: "/repo" });
    await routeRuntime.handleUpdate(
      {
        callback_query: {
          id: "reroute-cb",
          from: { id: 7, is_bot: false },
          message: {
            message_id: 99,
            message_thread_id: 42,
            chat: { id: 100, type: "private" },
          },
          data: "reroute:1:7",
        },
      },
      { cwd: "/repo" },
    );

    const record = threadStore.getByProfileKey("cwd:/repo");
    assert.deepEqual(record?.target, { chatId: 100, threadId: 42 });
    assert.equal(record?.threadName, "Axial");
    const queued = telegramQueueStore.getQueuedItems()[0];
    assert.equal(queued?.kind, "prompt");
    assert.deepEqual(queued?.target, { chatId: 100, threadId: 42 });
    assert.equal(
      queued?.kind === "prompt" && queued.content[0]?.type === "text"
        ? queued.content[0].text
        : "",
      "[telegram|thread:Axial] hello",
    );
    assert.deepEqual(apiCalls, [
      {
        method: "sendChatAction",
        body: { chat_id: 100, message_thread_id: 7, action: "typing" },
      },
      {
        method: "editForumTopic",
        body: { chat_id: 100, message_thread_id: 42, name: "Axial" },
      },
    ]);
    assert.equal(events.some((event) => event.includes("closeForumTopic")), false);
    assert.equal(events.some((event) => event.includes("deleteForumTopic")), false);
  });
});

test("Routing runtime defers unbound guidance until user content in created topics", async () => {
  await withTopicStore(async (threadStore) => {
    const apiCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
    threadStore.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 100, threadId: 7 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
    });
    await threadStore.persist();
    const { events, routeRuntime } = createRouteHarness({
      threadStore,
      callApi: async (method, body) => {
        apiCalls.push({ method, body });
        return {} as never;
      },
    });

    await routeRuntime.handleUpdate(
      {
        message: {
          message_id: 10,
          message_thread_id: 42,
          chat: { id: 100, type: "private" },
          from: { id: 7, is_bot: false },
          forum_topic_created: {},
        },
      },
      { cwd: "/repo" },
    );

    assert.deepEqual(apiCalls, []);

    await routeRuntime.handleUpdate(unboundTopicUpdate("reroute me"), {
      cwd: "/repo",
    });

    const chooser = events.find((event) => event.startsWith("interactive:"));
    assert.match(chooser ?? "", /New thread is not a Pi instance/);
    assert.match(chooser ?? "", /Your message is still in this Telegram thread\./);
    assert.match(chooser ?? "", /Select the Pi thread that should handle it:/);
    assert.doesNotMatch(chooser ?? "", /<code>active<\/code>/);
  });
});

test("Routing runtime keeps known-command unbound threads open with chooser", async () => {
  await withTopicStore(async (threadStore) => {
    const apiCalls: unknown[] = [];
    threadStore.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 100, threadId: 7 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
      threadName: "Axial",
    });
    await threadStore.persist();
    const { events, routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
      callApi: async (method, body) => {
        apiCalls.push({ method, body });
        return {} as never;
      },
    });

    await routeRuntime.handleUpdate(unboundTopicUpdate("/status"), {
      cwd: "/repo",
    });

    assert.deepEqual(telegramQueueStore.getQueuedItems(), []);
    const chooser = events.find((event) => event.startsWith("interactive:"));
    assert.match(chooser ?? "", /<b>🧵 Choose target thread<\/b>/);
    assert.match(chooser ?? "", /You used <code>\/status<\/code> from the <b>All<\/b> tab\./);
    assert.doesNotMatch(chooser ?? "", /New thread is not a Pi instance/);
    const options = events.find((event) => event.startsWith("interactive-options:"));
    assert.equal(
      options,
      'interactive-options:{"target":{"chatId":100,"threadId":42},"replyToMessageId":11}',
    );
    const markup = events.find((event) => event.startsWith("markup:"));
    assert.match(markup ?? "", /"text":"↪️ Axial"/);
    assert.match(markup ?? "", /allmenu:status:7/);
    assert.deepEqual(apiCalls, []);
  });
});

test("Routing runtime skips stale-epoch unbound thread deletion", async () => {
  await withTopicStore(async (threadStore) => {
    const apiCalls: unknown[] = [];
    let epochReads = 0;
    threadStore.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 100, threadId: 7 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
    });
    await threadStore.persist();
    const { routeRuntime } = createRouteHarness({
      threadStore,
      getCurrentLeaderEpoch: () => {
        epochReads += 1;
        return epochReads === 1 ? 1 : 2;
      },
      callApi: async (method, body) => {
        apiCalls.push({ method, body });
        return {} as never;
      },
    });

    await routeRuntime.handleUpdate(unboundTopicUpdate(), { cwd: "/repo" });

    assert.deepEqual(apiCalls, [
      {
        method: "sendChatAction",
        body: { chat_id: 100, message_thread_id: 7, action: "typing" },
      },
    ]);
  });
});

test("Routing runtime deletes reserved old leader topics through reconciler", async () => {
  await withTopicStore(async (threadStore) => {
    const apiCalls: unknown[] = [];
    threadStore.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 100, threadId: 7 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
    });
    threadStore.reserveThread({
      target: { chatId: 100, threadId: 42 },
      slot: "B",
      reason: "previous-leader",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      expiresAtMs: Date.now() + 60_000,
    });
    await threadStore.persist();
    const { events, routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
      callApi: async (method, body) => {
        apiCalls.push({ method, body });
        return {} as never;
      },
    });

    await routeRuntime.handleUpdate(unboundTopicUpdate(), { cwd: "/repo" });

    assert.deepEqual(apiCalls, [
      {
        method: "closeForumTopic",
        body: { chat_id: 100, message_thread_id: 42 },
      },
      {
        method: "deleteForumTopic",
        body: { chat_id: 100, message_thread_id: 42 },
      },
    ]);
    assert.deepEqual(telegramQueueStore.getQueuedItems(), []);
    assert.equal(
      events.some((event) => event.includes("Previous leader thread")),
      true,
    );
  });
});

test("Routing runtime treats pruned failed topic history as unbound", async () => {
  await withTopicStore(async (threadStore) => {
    threadStore.upsert({
      profileKey: "topic:100:42",
      target: { chatId: 100, threadId: 42 },
      status: "failed",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      slot: "C",
      lastError: "previous failure",
    });
    await threadStore.persist();
    const { events, routeRuntime, telegramQueueStore } = createRouteHarness({
      threadStore,
      callApi: async () => ({}) as never,
    });

    await routeRuntime.handleUpdate(unboundTopicUpdate("again"), {
      cwd: "/repo",
    });

    assert.equal(threadStore.getByProfileKey("topic:100:42"), undefined);
    const leaderRecord = threadStore.getByProfileKey("cwd:/repo");
    assert.equal(leaderRecord?.status, "active");
    assert.equal(leaderRecord?.instanceId, "leader-a");
    assert.equal(telegramQueueStore.getQueuedItems().length, 1);
    assert.equal(events.includes("reply:Starting agent in topic C…"), false);
  });
});
