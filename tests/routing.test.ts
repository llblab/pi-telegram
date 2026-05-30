/**
 * Regression tests for inbound Telegram route composition
 * Covers route-level wiring from paired updates into prompt queueing
 */

import assert from "node:assert/strict";
import test from "node:test";

import * as Media from "../lib/media.ts";
import * as Menu from "../lib/menu.ts";
import * as Model from "../lib/model.ts";
import * as Queue from "../lib/queue.ts";
import * as Routing from "../lib/routing.ts";
import * as Runtime from "../lib/runtime.ts";
import * as TextGroups from "../lib/text-groups.ts";
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
    answerCallbackQuery: async (callbackQueryId) => {
      events.push(`answer:${callbackQueryId}`);
    },
    answerGuestQuery: async () => {},
    sendTextReply: async () => undefined,
    setMyCommands: async () => undefined,
    getCommands: () => [],
    downloadFile: async (_fileId, fileName) => `/tmp/${fileName}`,
    getThinkingLevel: () => "high",
    setThinkingLevel: () => undefined,
    setModel: async () => true,
    sendUserMessage: (message) => {
      events.push(`user:${message}`);
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    compact: () => undefined,
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
  assert.deepEqual(events, ["status", "dispatch"]);
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
  assert.equal(events.includes("user:[callback] vividfish:approve:123"), true);
  assert.equal(events.includes("answer:cb-custom"), true);
  for (const data of ownedCallbackData) {
    assert.equal(
      events.some((event) => event === `user:[callback] ${data}`),
      false,
    );
  }
});
