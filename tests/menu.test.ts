/**
 * Regression tests for Telegram menu helpers
 * Covers inline model/status/thinking menu state, callbacks, and transport payloads
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createTelegramQueueMenuRuntime } from "../lib/menu-queue.ts";
import {
  applyTelegramModelPageSelection,
  applyTelegramModelScopeSelection,
  buildModelMenuReplyMarkup,
  buildModelPageMenuReplyMarkup,
  buildStatusReplyMarkup,
  buildTelegramModelCallbackPlan,
  buildTelegramModelMenuRenderPayload,
  buildTelegramModelMenuState,
  buildTelegramModelMenuStateRuntime,
  buildTelegramModelPageMenuRenderPayload,
  buildTelegramStatusMenuRenderPayload,
  buildTelegramThinkingMenuRenderPayload,
  buildThinkingMenuReplyMarkup,
  buildThinkingMenuText,
  createTelegramMenuActionRuntime,
  createTelegramMenuActionRuntimeWithStateBuilder,
  createTelegramMenuCallbackHandler,
  createTelegramMenuCallbackHandlerForContext,
  createTelegramModelMenuRuntime,
  createTelegramModelMenuStateBuilder,
  formatScopedModelButtonText,
  getModelMenuItems,
  getStoredTelegramModelMenuState,
  getTelegramModelMenuPage,
  getTelegramModelSelection,
  handleStoredTelegramMenuCallback,
  handleTelegramMenuCallbackEntry,
  handleTelegramMenuCallbackRuntime,
  handleTelegramModelMenuCallbackAction,
  handleTelegramStatusMenuCallbackAction,
  handleTelegramThinkingMenuCallbackAction,
  MODEL_MENU_TITLE,
  MODEL_PAGE_MENU_TITLE,
  openTelegramModelMenu,
  openTelegramStatusMenu,
  parseTelegramMenuCallbackAction,
  resolveCachedTelegramModelMenuInputs,
  sendTelegramModelMenuMessage,
  sendTelegramStatusMessage,
  storeTelegramModelMenuState,
  TELEGRAM_MODEL_PAGE_SIZE,
  type TelegramModelMenuState,
  updateTelegramModelMenuMessage,
  updateTelegramStatusMessage,
  updateTelegramThinkingMenuMessage,
} from "../lib/menu.ts";
import type { MenuModel } from "../lib/model.ts";
import type { TelegramQueueItem } from "../lib/queue.ts";

function createMenuState<TModel extends MenuModel = MenuModel>(
  messageId: number,
  overrides: Partial<TelegramModelMenuState<TModel>> = {},
): TelegramModelMenuState<TModel> {
  return {
    chatId: 1,
    messageId,
    page: 0,
    scope: "scoped",
    scopedModels: [],
    allModels: [],
    mode: "model",
    ...overrides,
  };
}

function createMenuModel(
  provider: string,
  id: string,
  reasoning?: boolean,
): MenuModel {
  return reasoning === undefined
    ? { provider, id }
    : { provider, id, reasoning };
}

test("Menu helpers store, refresh, prune, and bound model menu state", () => {
  const menus = new Map();
  storeTelegramModelMenuState(menus, createMenuState(1), {
    maxAgeMs: 100,
    maxStoredMenus: 2,
    now: 1000,
  });
  storeTelegramModelMenuState(menus, createMenuState(2), {
    maxAgeMs: 100,
    maxStoredMenus: 2,
    now: 1010,
  });
  assert.equal(
    getStoredTelegramModelMenuState(menus, 1, {
      maxAgeMs: 100,
      maxStoredMenus: 2,
      now: 1020,
    })?.messageId,
    1,
  );
  storeTelegramModelMenuState(menus, createMenuState(3), {
    maxAgeMs: 100,
    maxStoredMenus: 2,
    now: 1030,
  });
  assert.equal(menus.has(2), false);
  assert.equal(menus.has(1), true);
  assert.equal(menus.has(3), true);
  assert.equal(
    getStoredTelegramModelMenuState(menus, 1, {
      maxAgeMs: 10,
      maxStoredMenus: 2,
      now: 1050,
    }),
    undefined,
  );
});

test("Menu helpers resolve and reuse cached model menu inputs", async () => {
  const model = { provider: "test", id: "alpha" };
  let reloadCount = 0;
  const resolved = await resolveCachedTelegramModelMenuInputs(undefined, {
    cacheTtlMs: 100,
    now: 1000,
    reloadSettings: async () => {
      reloadCount += 1;
    },
    refreshAvailableModels: () => [model],
    getConfiguredScopedModelPatterns: () => ["configured"],
    getCliScopedModelPatterns: () => ["cli"],
  });
  assert.deepEqual(resolved, {
    expiresAt: 1100,
    availableModels: [model],
    configuredScopedModelPatterns: ["cli"],
    cliScopedModelPatterns: ["cli"],
  });
  assert.equal(reloadCount, 1);
  assert.equal(
    await resolveCachedTelegramModelMenuInputs(resolved, {
      cacheTtlMs: 100,
      now: 1099,
      reloadSettings: async () => {
        reloadCount += 1;
      },
      refreshAvailableModels: () => [],
      getConfiguredScopedModelPatterns: () => [],
      getCliScopedModelPatterns: () => undefined,
    }),
    resolved,
  );
  assert.equal(reloadCount, 1);
});

test("Menu runtime controller owns stored state and cached inputs", async () => {
  let reloadCount = 0;
  let refreshCount = 0;
  const model = createMenuModel("openai", "gpt-5");
  const runtime = createTelegramModelMenuRuntime({
    maxAgeMs: 100,
    maxStoredMenus: 2,
  });
  runtime.storeState(createMenuState(11));
  assert.equal(runtime.getState(11)?.messageId, 11);
  const firstState = await runtime.buildState({
    chatId: 42,
    activeModel: model,
    ctx: {
      modelRegistry: {
        refresh: () => {
          refreshCount += 1;
        },
        getAvailable: () => [model],
      },
    },
    reloadSettings: async () => {
      reloadCount += 1;
    },
    getConfiguredScopedModelPatterns: () => ["openai/gpt-5"],
  });
  const secondState = await runtime.buildState({
    chatId: 42,
    activeModel: model,
    ctx: {
      modelRegistry: {
        refresh: () => {
          refreshCount += 1;
        },
        getAvailable: () => [model],
      },
    },
    reloadSettings: async () => {
      reloadCount += 1;
    },
    getConfiguredScopedModelPatterns: () => ["openai/gpt-5"],
  });
  assert.equal(firstState.chatId, 42);
  assert.equal(secondState.chatId, 42);
  assert.equal(reloadCount, 1);
  assert.equal(refreshCount, 1);
  runtime.clear();
  assert.equal(runtime.getState(11), undefined);
});

test("Menu state builder wires runtime to settings and model-registry ports", async () => {
  let createdForCwd = "";
  let reloadCount = 0;
  let refreshCount = 0;
  const model = createMenuModel("openai", "gpt-5");
  const runtime = createTelegramModelMenuRuntime<typeof model>();
  const getModelMenuState = createTelegramModelMenuStateBuilder({
    runtime,
    createSettingsManager: (cwd) => {
      createdForCwd = cwd;
      return {
        reload: async () => {
          reloadCount += 1;
        },
        getEnabledModels: () => ["openai/gpt-5"],
      };
    },
    getActiveModel: () => model,
  });
  const state = await getModelMenuState(42, {
    cwd: "/tmp/project",
    modelRegistry: {
      refresh: () => {
        refreshCount += 1;
      },
      getAvailable: () => [model],
    },
  });
  assert.equal(createdForCwd, "/tmp/project");
  assert.equal(reloadCount, 1);
  assert.equal(refreshCount, 1);
  assert.equal(state.chatId, 42);
  assert.deepEqual(
    state.scopedModels.map((entry) => entry.model.id),
    ["gpt-5"],
  );
});

test("Menu runtime builds menu state from settings and model-registry ports", async () => {
  let reloadCount = 0;
  let refreshCount = 0;
  const model = createMenuModel("openai", "gpt-5");
  const result = await buildTelegramModelMenuStateRuntime({
    chatId: 42,
    activeModel: model,
    cachedInputs: undefined,
    cacheTtlMs: 5_000,
    ctx: {
      modelRegistry: {
        refresh: () => {
          refreshCount += 1;
        },
        getAvailable: () => [model],
      },
    },
    reloadSettings: async () => {
      reloadCount += 1;
    },
    getConfiguredScopedModelPatterns: () => ["configured"],
    getCliScopedModelPatterns: () => ["openai/gpt-5"],
  });
  assert.equal(reloadCount, 1);
  assert.equal(refreshCount, 1);
  assert.equal(result.state.chatId, 42);
  assert.deepEqual(
    result.state.allModels.map((entry) => entry.model.id),
    ["gpt-5"],
  );
  assert.deepEqual(result.cachedInputs.availableModels, [model]);
});

test("Menu helpers expose UI constants", () => {
  assert.equal(MODEL_MENU_TITLE, "<b>🤖 Choose a model:</b>");
  assert.equal(MODEL_PAGE_MENU_TITLE, "<b>Choose a page:</b>");
  assert.equal(TELEGRAM_MODEL_PAGE_SIZE, 6);
});

test("Menu helpers build model menu state and parse callback actions", () => {
  const modelA = createMenuModel("openai", "gpt-5", true);
  const modelB = createMenuModel("anthropic", "claude-3", false);
  const state = buildTelegramModelMenuState({
    chatId: 1,
    activeModel: modelA,
    availableModels: [modelA, modelB],
    configuredScopedModelPatterns: ["missing-model"],
    cliScopedModelPatterns: ["missing-model"],
  });
  assert.equal(state.chatId, 1);
  assert.equal(state.scope, "all");
  assert.match(state.note ?? "", /No CLI scoped models matched/);
  assert.deepEqual(parseTelegramMenuCallbackAction("menu:model"), {
    kind: "status",
    action: "model",
  });
  assert.deepEqual(parseTelegramMenuCallbackAction("status:model"), {
    kind: "status",
    action: "model",
  });
  assert.deepEqual(parseTelegramMenuCallbackAction("menu:queue"), {
    kind: "status",
    action: "queue",
  });
  assert.deepEqual(parseTelegramMenuCallbackAction("status:queue"), {
    kind: "status",
    action: "queue",
  });
  assert.deepEqual(parseTelegramMenuCallbackAction("thinking:set:high"), {
    kind: "thinking:set",
    level: "high",
  });
  assert.deepEqual(parseTelegramMenuCallbackAction("model:pick:2"), {
    kind: "model",
    action: "pick",
    value: "2",
  });
  assert.deepEqual(parseTelegramMenuCallbackAction("model:pages"), {
    kind: "model",
    action: "pages",
    value: undefined,
  });
  assert.deepEqual(parseTelegramMenuCallbackAction("unknown"), {
    kind: "ignore",
  });
});

test("Menu helpers apply menu mutations and resolve model selections", () => {
  const modelA = createMenuModel("openai", "gpt-5", true);
  const state = createMenuState(2, {
    scope: "all",
    scopedModels: [{ model: modelA, thinkingLevel: "high" }],
    allModels: [{ model: modelA }],
    mode: "status",
  });
  assert.equal(applyTelegramModelScopeSelection(state, "scoped"), "changed");
  assert.equal(state.scope, "scoped");
  assert.equal(applyTelegramModelScopeSelection(state, "scoped"), "unchanged");
  assert.equal(applyTelegramModelScopeSelection(state, "bad"), "invalid");
  assert.equal(applyTelegramModelPageSelection(state, "2"), "changed");
  assert.equal(state.page, 2);
  assert.equal(applyTelegramModelPageSelection(state, "2"), "unchanged");
  assert.equal(applyTelegramModelPageSelection(state, "bad"), "invalid");
  assert.deepEqual(getTelegramModelSelection(state, "bad"), {
    kind: "invalid",
  });
  assert.deepEqual(getTelegramModelSelection(state, "9"), { kind: "missing" });
  assert.equal(getTelegramModelSelection(state, "0").kind, "selected");
});

test("Menu helpers derive normalized menu pages without mutating state", () => {
  const modelA = createMenuModel("openai", "gpt-5");
  const modelB = createMenuModel("anthropic", "claude-3");
  const state = createMenuState<MenuModel>(2, {
    page: 99,
    scope: "all",
    allModels: [{ model: modelA }, { model: modelB }],
  });
  const menuPage = getTelegramModelMenuPage(state, 1);
  assert.equal(menuPage.page, 1);
  assert.equal(menuPage.pageCount, 2);
  assert.equal(menuPage.start, 1);
  assert.deepEqual(menuPage.items, [{ model: modelB }]);
  assert.equal(state.page, 99);
  const markup = buildModelMenuReplyMarkup(state, modelA, 1);
  assert.equal(markup.inline_keyboard[0]?.[0]?.text, "⬆️ Main menu");
  assert.equal(markup.inline_keyboard[0]?.[0]?.callback_data, "menu:back");
  assert.equal(markup.inline_keyboard[1]?.[1]?.text, "2/2");
  assert.equal(markup.inline_keyboard[1]?.[1]?.callback_data, "model:pages");
  assert.equal(state.page, 99);
});

test("Menu helpers build model page selector markup and payloads", () => {
  const models = Array.from({ length: 31 }, (_unused, index) =>
    createMenuModel("test", `model-${index + 1}`),
  );
  const state = createMenuState<MenuModel>(2, {
    page: 1,
    scope: "all",
    allModels: models.map((model) => ({ model })),
    mode: "model-pages",
  });
  const markup = buildModelPageMenuReplyMarkup(state, TELEGRAM_MODEL_PAGE_SIZE);
  const payload = buildTelegramModelPageMenuRenderPayload(state);
  assert.equal(markup.inline_keyboard[0]?.[0]?.text, "⬆️ Back");
  assert.equal(
    markup.inline_keyboard[0]?.[0]?.callback_data,
    "model:pages:back",
  );
  assert.deepEqual(
    markup.inline_keyboard[1]?.map((button) => button.text),
    ["1", "2", "3", "4"],
  );
  assert.deepEqual(
    markup.inline_keyboard[2]?.map((button) => button.text),
    ["5", "6"],
  );
  assert.equal(payload.nextMode, "model-pages");
  assert.equal(payload.text, "<b>Choose a page:</b>");
  assert.equal(payload.mode, "html");
});

test("Menu helpers build model callback plans for paging, page menu, selection, and restart modes", () => {
  const modelA = createMenuModel("openai", "gpt-5", true);
  const modelB = createMenuModel("anthropic", "claude-3", false);
  const state = createMenuState<MenuModel>(2, {
    scope: "all",
    scopedModels: [{ model: modelA, thinkingLevel: "high" }],
    allModels: [{ model: modelA }, { model: modelB }],
  });
  assert.deepEqual(
    buildTelegramModelCallbackPlan({
      data: "model:pages",
      state,
      activeModel: modelA,
      currentThinkingLevel: "medium",
      isIdle: true,
      canRestartBusyRun: false,
      hasActiveToolExecutions: false,
    }),
    { kind: "update-menu" },
  );
  assert.equal(state.mode, "model-pages");
  assert.deepEqual(
    buildTelegramModelCallbackPlan({
      data: "model:pages:back",
      state,
      activeModel: modelA,
      currentThinkingLevel: "medium",
      isIdle: true,
      canRestartBusyRun: false,
      hasActiveToolExecutions: false,
    }),
    { kind: "update-menu" },
  );
  assert.equal(state.mode, "model");
  assert.deepEqual(
    buildTelegramModelCallbackPlan({
      data: "model:page:1",
      state,
      activeModel: modelA,
      currentThinkingLevel: "medium",
      isIdle: true,
      canRestartBusyRun: false,
      hasActiveToolExecutions: false,
    }),
    { kind: "update-menu" },
  );
  assert.deepEqual(
    buildTelegramModelCallbackPlan({
      data: "model:pick:0",
      state,
      activeModel: modelA,
      currentThinkingLevel: "medium",
      isIdle: true,
      canRestartBusyRun: false,
      hasActiveToolExecutions: false,
    }),
    {
      kind: "refresh-status",
      selection: state.allModels[0],
      callbackText: "Model: gpt-5",
      shouldApplyThinkingLevel: false,
    },
  );
  assert.deepEqual(
    buildTelegramModelCallbackPlan({
      data: "model:pick:1",
      state,
      activeModel: modelA,
      currentThinkingLevel: "medium",
      isIdle: false,
      canRestartBusyRun: true,
      hasActiveToolExecutions: true,
    }),
    {
      kind: "switch-model",
      selection: state.allModels[1],
      mode: "restart-after-tool",
      callbackText:
        "Switched to claude-3. Restarting after the current tool finishes…",
    },
  );
  assert.deepEqual(
    buildTelegramModelCallbackPlan({
      data: "model:pick:1",
      state,
      activeModel: modelA,
      currentThinkingLevel: "medium",
      isIdle: false,
      canRestartBusyRun: false,
      hasActiveToolExecutions: false,
    }),
    { kind: "answer", text: "π is busy. Send /abort, /next, or /stop." },
  );
});

test("Menu helpers open status and model menus through runtime ports", async () => {
  const events: string[] = [];
  const model = { provider: "test", id: "alpha", reasoning: true };
  const statusState = createMenuState(0);
  await openTelegramStatusMenu({
    isIdle: () => true,
    sendBusyMessage: async () => {
      events.push("unexpected:busy-status");
    },
    getModelMenuState: async () => statusState,
    buildStatusHtml: () => "status-html",
    getActiveModel: () => model,
    getThinkingLevel: () => "medium",
    sendStatusMenu: async (state, html, activeModel, level) => {
      events.push(`status:${state.chatId}:${html}:${activeModel?.id}:${level}`);
      return 11;
    },
    storeModelMenuState: (state) => {
      events.push(`store:${state.messageId}:${state.mode}`);
    },
  });
  const modelState = createMenuState(0);
  modelState.allModels = [{ model }];
  await openTelegramModelMenu({
    isIdle: () => false,
    canOfferInFlightModelSwitch: () => true,
    sendBusyMessage: async () => {
      events.push("unexpected:busy-model");
    },
    sendNoModelsMessage: async () => {
      events.push("unexpected:no-models");
    },
    getModelMenuState: async () => modelState,
    getActiveModel: () => model,
    sendModelMenu: async (state, activeModel) => {
      events.push(`model:${state.chatId}:${activeModel?.id}`);
      return 12;
    },
    storeModelMenuState: (state) => {
      events.push(`store:${state.messageId}:${state.mode}`);
    },
  });
  assert.deepEqual(events, [
    "status:1:status-html:alpha:medium",
    "store:11:status",
    "model:1:alpha",
    "store:12:model",
  ]);
});

test("Menu helpers report model-menu busy and no-model paths", async () => {
  const events: string[] = [];
  await openTelegramStatusMenu({
    isIdle: () => false,
    sendBusyMessage: async () => {
      events.push("unexpected:busy-status");
    },
    getModelMenuState: async () => createMenuState(0),
    buildStatusHtml: () => "status",
    getActiveModel: () => undefined,
    getThinkingLevel: () => "off",
    sendStatusMenu: async () => {
      events.push("status");
      return 1;
    },
    storeModelMenuState: () => {
      events.push("store-status");
    },
  });
  await openTelegramModelMenu({
    isIdle: () => true,
    canOfferInFlightModelSwitch: () => false,
    sendBusyMessage: async () => {
      events.push("unexpected:busy-model");
    },
    sendNoModelsMessage: async () => {
      events.push("no-models");
    },
    getModelMenuState: async () => createMenuState(0),
    getActiveModel: () => undefined,
    sendModelMenu: async () => 1,
    storeModelMenuState: () => {},
  });
  await openTelegramModelMenu({
    isIdle: () => false,
    canOfferInFlightModelSwitch: () => false,
    sendBusyMessage: async () => {
      events.push("busy-model");
    },
    sendNoModelsMessage: async () => {
      events.push("unexpected:no-models");
    },
    getModelMenuState: async () => createMenuState(0),
    getActiveModel: () => undefined,
    sendModelMenu: async () => 1,
    storeModelMenuState: () => {},
  });
  assert.deepEqual(events, [
    "status",
    "store-status",
    "no-models",
    "busy-model",
  ]);
});

test("Menu helpers route callback entry states before action handlers", async () => {
  const events: string[] = [];
  await handleTelegramMenuCallbackEntry("callback-1", undefined, undefined, {
    handleStatusAction: async () => false,
    handleThinkingAction: async () => false,
    handleModelAction: async () => false,
    answerCallbackQuery: async (_id, text) => {
      events.push(`answer:${text ?? ""}`);
    },
  });
  await handleTelegramMenuCallbackEntry("callback-2", "menu:model", undefined, {
    handleStatusAction: async () => false,
    handleThinkingAction: async () => false,
    handleModelAction: async () => false,
    answerCallbackQuery: async (_id, text) => {
      events.push(`answer:${text ?? ""}`);
    },
  });
  await handleTelegramMenuCallbackEntry(
    "callback-3",
    "menu:model",
    {
      chatId: 1,
      messageId: 2,
      page: 0,
      scope: "all",
      scopedModels: [],
      allModels: [],
      mode: "status",
    },
    {
      handleStatusAction: async () => {
        events.push("status");
        return true;
      },
      handleThinkingAction: async () => false,
      handleModelAction: async () => false,
      answerCallbackQuery: async (_id, text) => {
        events.push(`answer:${text ?? ""}`);
      },
    },
  );
  assert.deepEqual(events, [
    "answer:",
    "answer:Interactive message expired.",
    "status",
  ]);
});

test("Menu helpers route stored callback queries through matching action handlers", async () => {
  const events: string[] = [];
  const state = createMenuState(2);
  await handleStoredTelegramMenuCallback(
    { id: "callback-1", data: "menu:model", message: { message_id: 2 } },
    {
      getStoredModelMenuState: (messageId) => {
        events.push(`get:${messageId}`);
        return state;
      },
      handleStatusAction: async (nextState) => {
        events.push(`status:${nextState.messageId}`);
        return true;
      },
      handleThinkingAction: async () => {
        events.push("unexpected:thinking");
        return false;
      },
      handleModelAction: async () => {
        events.push("unexpected:model");
        return false;
      },
      answerCallbackQuery: async (_id, text) => {
        events.push(`answer:${text ?? ""}`);
      },
    },
  );
  await handleStoredTelegramMenuCallback(
    { id: "callback-2", data: "menu:model" },
    {
      getStoredModelMenuState: (messageId) => {
        events.push(`get:${messageId ?? "none"}`);
        return undefined;
      },
      handleStatusAction: async () => false,
      handleThinkingAction: async () => false,
      handleModelAction: async () => false,
      answerCallbackQuery: async (_id, text) => {
        events.push(`answer:${text ?? ""}`);
      },
    },
  );
  assert.deepEqual(events, [
    "get:2",
    "status:2",
    "get:none",
    "answer:Interactive message expired.",
  ]);
});

test("Menu runtime routes stored callback queries through callback action ports", async () => {
  const events: string[] = [];
  const model = createMenuModel("openai", "gpt-5", true);
  const state: TelegramModelMenuState<typeof model> = {
    ...createMenuState<typeof model>(2),
    allModels: [{ model, thinkingLevel: "high" }],
    mode: "status",
  };
  let thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" =
    "medium";
  await handleTelegramMenuCallbackRuntime(
    { id: "callback-1", data: "menu:thinking", message: { message_id: 2 } },
    { idle: true },
    {
      getStoredModelMenuState: (messageId) => {
        events.push(`get:${messageId}`);
        return state;
      },
      getActiveModel: () => model,
      getThinkingLevel: () => thinkingLevel,
      setThinkingLevel: (level) => {
        thinkingLevel = level;
        events.push(`thinking:${level}`);
      },
      updateStatus: () => {
        events.push("status");
      },
      updateModelMenuMessage: async () => {
        events.push("model-menu");
      },
      updateThinkingMenuMessage: async () => {
        events.push("thinking-menu");
      },
      updateStatusMessage: async () => {
        events.push("status-menu");
      },
      answerCallbackQuery: async (_id, text) => {
        events.push(`answer:${text ?? ""}`);
      },
      isIdle: (ctx) => ctx.idle,
      hasActiveTelegramTurn: () => true,
      hasAbortHandler: () => true,
      hasActiveToolExecutions: () => false,
      setModel: async (nextModel) => {
        events.push(`set-model:${nextModel.id}`);
        return true;
      },
      setCurrentModel: (nextModel) => {
        events.push(`current:${nextModel.id}`);
      },
      stagePendingModelSwitch: (selection) => {
        events.push(`pending:${selection.model.id}`);
      },
      restartInterruptedTelegramTurn: (selection) => {
        events.push(`restart:${selection.model.id}`);
        return true;
      },
    },
  );
  await handleTelegramMenuCallbackRuntime(
    { id: "callback-2", data: "thinking:set:high", message: { message_id: 2 } },
    { idle: true },
    {
      getStoredModelMenuState: () => state,
      getActiveModel: () => model,
      getThinkingLevel: () => thinkingLevel,
      setThinkingLevel: (level) => {
        thinkingLevel = level;
        events.push(`thinking:${level}`);
      },
      updateStatus: () => {
        events.push("status");
      },
      updateModelMenuMessage: async () => {
        events.push("unexpected:model-menu");
      },
      updateThinkingMenuMessage: async () => {
        events.push("unexpected:thinking-menu");
      },
      updateStatusMessage: async () => {
        events.push("status-menu");
      },
      answerCallbackQuery: async (_id, text) => {
        events.push(`answer:${text ?? ""}`);
      },
      isIdle: (ctx) => ctx.idle,
      hasActiveTelegramTurn: () => true,
      hasAbortHandler: () => true,
      hasActiveToolExecutions: () => false,
      setModel: async () => true,
      setCurrentModel: () => {},
      stagePendingModelSwitch: () => {},
      restartInterruptedTelegramTurn: () => true,
    },
  );
  await handleTelegramMenuCallbackRuntime(
    { id: "callback-3", data: "model:pick:0", message: { message_id: 2 } },
    { idle: false },
    {
      getStoredModelMenuState: () => state,
      getActiveModel: () => createMenuModel("anthropic", "claude-3", true),
      getThinkingLevel: () => thinkingLevel,
      setThinkingLevel: (level) => {
        thinkingLevel = level;
        events.push(`thinking:${level}`);
      },
      updateStatus: () => {
        events.push("status");
      },
      updateModelMenuMessage: async () => {
        events.push("unexpected:model-menu");
      },
      updateThinkingMenuMessage: async () => {
        events.push("unexpected:thinking-menu");
      },
      updateStatusMessage: async () => {
        events.push("status-menu");
      },
      answerCallbackQuery: async (_id, text) => {
        events.push(`answer:${text ?? ""}`);
      },
      isIdle: (ctx) => ctx.idle,
      hasActiveTelegramTurn: () => true,
      hasAbortHandler: () => true,
      hasActiveToolExecutions: () => false,
      setModel: async (nextModel) => {
        events.push(`set-model:${nextModel.id}`);
        return true;
      },
      setCurrentModel: (nextModel) => {
        events.push(`current:${nextModel.id}`);
      },
      stagePendingModelSwitch: (selection) => {
        events.push(`pending:${selection.model.id}`);
      },
      restartInterruptedTelegramTurn: (selection) => {
        events.push(`restart:${selection.model.id}`);
        return true;
      },
    },
  );
  assert.deepEqual(events, [
    "get:2",
    "thinking-menu",
    "answer:",
    "thinking:high",
    "status",
    "status-menu",
    "answer:Thinking: high",
    "set-model:gpt-5",
    "current:gpt-5",
    "thinking:high",
    "status",
    "status-menu",
    "restart:gpt-5",
    "answer:Switching to gpt-5 and continuing…",
  ]);
});

test("Menu callback handler captures runtime ports", async () => {
  const events: string[] = [];
  const state: TelegramModelMenuState = createMenuState(2);
  const handleCallback = createTelegramMenuCallbackHandler<
    { id: string; data?: string; message?: { message_id?: number } },
    { idle: boolean }
  >({
    getStoredModelMenuState: () => state,
    getActiveModel: () => createMenuModel("openai", "gpt-5"),
    getThinkingLevel: () => "medium",
    setThinkingLevel: (level) => {
      events.push(`thinking:${level}`);
    },
    updateStatus: () => {
      events.push("status");
    },
    updateModelMenuMessage: async () => {
      events.push("model-menu");
    },
    updateThinkingMenuMessage: async () => {
      events.push("thinking-menu");
    },
    updateStatusMessage: async () => {
      events.push("status-menu");
    },
    answerCallbackQuery: async (_id, text) => {
      events.push(`answer:${text ?? ""}`);
    },
    isIdle: (ctx) => ctx.idle,
    hasActiveTelegramTurn: () => false,
    hasAbortHandler: () => false,
    hasActiveToolExecutions: () => false,
    setModel: async () => true,
    setCurrentModel: () => {},
    stagePendingModelSwitch: () => {},
    restartInterruptedTelegramTurn: () => false,
  });
  await handleCallback(
    { id: "callback", data: "menu:model", message: { message_id: 2 } },
    { idle: true },
  );
  assert.deepEqual(events, ["model-menu", "answer:"]);
});

test("Menu callback adapter converts active tool count into runtime booleans", async () => {
  const events: string[] = [];
  let activeToolExecutions = 1;
  const getActiveToolExecutions = () => activeToolExecutions;
  const state: TelegramModelMenuState = {
    ...createMenuState(2),
    allModels: [
      { model: createMenuModel("openai", "gpt-5", true) },
      { model: createMenuModel("anthropic", "claude-3", false) },
    ],
  };
  const handleCallback = createTelegramMenuCallbackHandlerForContext<
    { id: string; data?: string; message?: { message_id?: number } },
    { idle: boolean }
  >({
    getStoredModelMenuState: () => state,
    getActiveModel: () => createMenuModel("openai", "gpt-5"),
    getThinkingLevel: () => "medium",
    setThinkingLevel: () => {},
    updateStatus: () => {},
    updateModelMenuMessage: async () => {
      events.push("model-menu");
    },
    updateThinkingMenuMessage: async () => {},
    updateStatusMessage: async () => {},
    answerCallbackQuery: async (_id, text) => {
      events.push(`answer:${text ?? ""}`);
    },
    isIdle: () => false,
    hasActiveTelegramTurn: () => true,
    hasAbortHandler: () => true,
    getActiveToolExecutions,
    setModel: async () => true,
    setCurrentModel: (nextModel) => {
      events.push(`current:${nextModel.id}`);
    },
    stagePendingModelSwitch: (selection) => {
      events.push(`pending:${selection.model.id}`);
    },
    restartInterruptedTelegramTurn: () => {
      events.push("restart");
      return true;
    },
  });
  await handleCallback(
    { id: "callback", data: "model:pick:1", message: { message_id: 2 } },
    { idle: false },
  );
  activeToolExecutions = 0;
  await handleCallback(
    { id: "callback", data: "model:pick:1", message: { message_id: 2 } },
    { idle: false },
  );
  assert.deepEqual(events, [
    "current:claude-3",
    "pending:claude-3",
    "answer:Switched to claude-3. Restarting after the current tool finishes…",
    "current:claude-3",
    "restart",
    "answer:Switching to claude-3 and continuing…",
  ]);
});

test("Menu helpers execute model callback actions across update, switch, and restart paths", async () => {
  const events: string[] = [];
  const modelA = createMenuModel("openai", "gpt-5", true);
  const modelB = createMenuModel("anthropic", "claude-3", false);
  const state = createMenuState<MenuModel>(2, {
    scope: "all",
    allModels: [{ model: modelA }, { model: modelB }],
  });
  assert.equal(
    await handleTelegramModelMenuCallbackAction(
      "callback-1",
      {
        data: "model:page:1",
        state,
        activeModel: modelA,
        currentThinkingLevel: "medium",
        isIdle: true,
        canRestartBusyRun: false,
        hasActiveToolExecutions: false,
      },
      {
        updateModelMenuMessage: async () => {
          events.push("update-menu");
        },
        updateStatusMessage: async () => {
          events.push("status");
        },
        answerCallbackQuery: async (_id, text) => {
          events.push(`answer:${text ?? ""}`);
        },
        setModel: async () => true,
        setCurrentModel: (model) => {
          events.push(`current:${model.id}`);
        },
        setThinkingLevel: (level) => {
          events.push(`thinking:${level}`);
        },
        stagePendingModelSwitch: (selection) => {
          events.push(`pending:${selection.model.id}`);
        },
        restartInterruptedTelegramTurn: (selection) => {
          events.push(`restart:${selection.model.id}`);
          return true;
        },
      },
    ),
    true,
  );
  assert.equal(
    await handleTelegramModelMenuCallbackAction(
      "callback-2",
      {
        data: "model:pick:1",
        state,
        activeModel: modelA,
        currentThinkingLevel: "medium",
        isIdle: false,
        canRestartBusyRun: true,
        hasActiveToolExecutions: true,
      },
      {
        updateModelMenuMessage: async () => {
          events.push("unexpected:update");
        },
        updateStatusMessage: async () => {
          events.push("status");
        },
        answerCallbackQuery: async (_id, text) => {
          events.push(`answer:${text ?? ""}`);
        },
        setModel: async () => true,
        setCurrentModel: (model) => {
          events.push(`current:${model.id}`);
        },
        setThinkingLevel: (level) => {
          events.push(`thinking:${level}`);
        },
        stagePendingModelSwitch: (selection) => {
          events.push(`pending:${selection.model.id}`);
        },
        restartInterruptedTelegramTurn: (selection) => {
          events.push(`restart:${selection.model.id}`);
          return true;
        },
      },
    ),
    true,
  );
  assert.equal(
    await handleTelegramModelMenuCallbackAction(
      "callback-3",
      {
        data: "model:pick:1",
        state,
        activeModel: modelA,
        currentThinkingLevel: "medium",
        isIdle: false,
        canRestartBusyRun: true,
        hasActiveToolExecutions: false,
      },
      {
        updateModelMenuMessage: async () => {
          events.push("unexpected:update");
        },
        updateStatusMessage: async () => {
          events.push("status");
        },
        answerCallbackQuery: async (_id, text) => {
          events.push(`answer:${text ?? ""}`);
        },
        setModel: async () => true,
        setCurrentModel: (model) => {
          events.push(`current:${model.id}`);
        },
        setThinkingLevel: (level) => {
          events.push(`thinking:${level}`);
        },
        stagePendingModelSwitch: (selection) => {
          events.push(`pending:${selection.model.id}`);
        },
        restartInterruptedTelegramTurn: (selection) => {
          events.push(`restart:${selection.model.id}`);
          return true;
        },
      },
    ),
    true,
  );
  assert.equal(events[0], "update-menu");
  assert.equal(events[1], "answer:");
  assert.equal(events[2], "current:claude-3");
  assert.equal(events[3], "status");
  assert.equal(events[4], "pending:claude-3");
  assert.equal(
    events[5],
    "answer:Switched to claude-3. Restarting after the current tool finishes…",
  );
  assert.equal(events[6], "current:claude-3");
  assert.equal(events[7], "status");
  assert.equal(events[8], "restart:claude-3");
  assert.equal(events[9], "answer:Switching to claude-3 and continuing…");
});

test("Menu helpers handle status and thinking callback actions", async () => {
  const events: string[] = [];
  const reasoningModel = createMenuModel("openai", "gpt-5", true);
  const plainModel = createMenuModel("openai", "gpt-4o", false);
  assert.equal(
    await handleTelegramStatusMenuCallbackAction(
      "callback-1",
      "menu:model",
      reasoningModel,
      {
        updateModelMenuMessage: async () => {
          events.push("menu:model");
        },
        updateThinkingMenuMessage: async () => {
          events.push("menu:thinking");
        },
        answerCallbackQuery: async (_id, text) => {
          events.push(`answer:${text ?? ""}`);
        },
      },
    ),
    true,
  );
  assert.equal(
    await handleTelegramThinkingMenuCallbackAction(
      "callback-2",
      "thinking:set:high",
      reasoningModel,
      {
        setThinkingLevel: (level) => {
          events.push(`set:${level}`);
        },
        getCurrentThinkingLevel: () => "high",
        updateStatusMessage: async () => {
          events.push("status:update");
        },
        answerCallbackQuery: async (_id, text) => {
          events.push(`answer:${text ?? ""}`);
        },
      },
    ),
    true,
  );
  assert.equal(
    await handleTelegramStatusMenuCallbackAction(
      "callback-3",
      "menu:thinking",
      plainModel,
      {
        updateModelMenuMessage: async () => {
          events.push("unexpected:model");
        },
        updateThinkingMenuMessage: async () => {
          events.push("unexpected:thinking");
        },
        answerCallbackQuery: async (_id, text) => {
          events.push(`answer:${text ?? ""}`);
        },
      },
    ),
    true,
  );
  assert.equal(events[0], "menu:model");
  assert.equal(events[1], "answer:");
  assert.equal(events[2], "set:high");
  assert.equal(events[3], "status:update");
  assert.equal(events[4], "answer:Thinking: high");
  assert.equal(events[5], "answer:This model has no reasoning controls.");
});

test("Menu helpers build pure render payloads before transport", () => {
  const modelA = createMenuModel("openai", "gpt-5", true);
  const state = createMenuState(2, {
    scope: "all",
    allModels: [{ model: modelA }],
    mode: "status",
  });
  const modelPayload = buildTelegramModelMenuRenderPayload(state, modelA);
  const thinkingPayload = buildTelegramThinkingMenuRenderPayload(
    modelA,
    "medium",
  );
  const statusPayload = buildTelegramStatusMenuRenderPayload(
    "<b>Status</b>",
    modelA,
    "medium",
  );
  assert.equal(modelPayload.nextMode, "model");
  assert.equal(modelPayload.text, "<b>🤖 Choose a model:</b>");
  assert.equal(modelPayload.mode, "html");
  const pageState = createMenuState(3, {
    scope: "all",
    allModels: [{ model: modelA }],
    mode: "model-pages",
  });
  const pagePayload = buildTelegramModelMenuRenderPayload(pageState, modelA);
  assert.equal(pagePayload.nextMode, "model-pages");
  assert.equal(pagePayload.text, "<b>Choose a page:</b>");
  assert.equal(pagePayload.mode, "html");
  assert.equal(thinkingPayload.nextMode, "thinking");
  assert.equal(thinkingPayload.text, "<b>🧠 Choose a thinking level:</b>");
  assert.equal(thinkingPayload.mode, "html");
  assert.equal(statusPayload.nextMode, "status");
  assert.equal(statusPayload.text, "<b>Status</b>");
  assert.equal(statusPayload.mode, "html");
  assert.equal(state.mode, "status");
});

test("Menu action runtime opens and updates interactive menu messages", async () => {
  const events: string[] = [];
  const modelA = createMenuModel("openai", "gpt-5", true);
  const state = createMenuState<typeof modelA>(2, {
    scope: "all",
    allModels: [{ model: modelA }],
    mode: "status",
  });
  const runtime = createTelegramMenuActionRuntime<string, typeof modelA>({
    getModelMenuState: async () => state,
    getActiveModel: () => modelA,
    getThinkingLevel: () => "medium",
    buildStatusHtml: (ctx) => `<b>Status ${ctx}</b>`,
    storeModelMenuState: (nextState) => {
      events.push(`store:${nextState.messageId}`);
    },
    isIdle: () => true,
    canOfferInFlightModelSwitch: () => false,
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      events.push(`text:${text}`);
    },
    editInteractiveMessage: async (chatId, messageId, text, mode) => {
      events.push(`edit:${chatId}:${messageId}:${mode}:${text}`);
    },
    sendInteractiveMessage: async (chatId, text, mode) => {
      events.push(`send:${chatId}:${mode}:${text}`);
      return 99;
    },
  });
  await runtime.updateModelMenuMessage(state, "ctx");
  await runtime.updateThinkingMenuMessage(state, "ctx");
  await runtime.updateStatusMessage(state, "ctx");
  await runtime.sendStatusMessage(1, 2, "ctx");
  await runtime.openModelMenu(1, 2, "ctx");
  assert.equal(events[0], "edit:1:2:html:<b>🤖 Choose a model:</b>");
  assert.equal(events[1], "edit:1:2:html:<b>🧠 Choose a thinking level:</b>");
  assert.equal(events[2], "edit:1:2:html:<b>Status ctx</b>");
  assert.equal(events[3], "send:1:html:<b>Status ctx</b>");
  assert.equal(events[4], "store:99");
  assert.equal(events[5], "send:1:html:<b>🤖 Choose a model:</b>");
  assert.equal(events[6], "store:99");
});

test("Menu action runtime with state builder opens menus from settings runtime", async () => {
  const events: string[] = [];
  const modelA = createMenuModel("openai", "gpt-5");
  const state = createMenuState<typeof modelA>(2, {
    scope: "all",
    allModels: [{ model: modelA }],
  });
  const runtime = createTelegramMenuActionRuntimeWithStateBuilder<
    typeof modelA,
    {
      cwd: string;
      modelRegistry: {
        refresh: () => void;
        getAvailable: () => [typeof modelA];
      };
    }
  >({
    runtime: {
      storeState: () => {},
      getState: () => undefined,
      clear: () => {},
      buildState: async (options) => {
        await options.reloadSettings();
        events.push(
          `patterns:${options.getConfiguredScopedModelPatterns()?.length}`,
        );
        return state;
      },
    },
    createSettingsManager: (cwd) => ({
      reload: async () => {
        events.push(`reload:${cwd}`);
      },
      getEnabledModels: () => ["openai/*"],
    }),
    getActiveModel: () => modelA,
    getThinkingLevel: () => "medium",
    buildStatusHtml: () => "status",
    storeModelMenuState: (nextState) => {
      events.push(`store:${nextState.messageId}`);
    },
    isIdle: () => true,
    canOfferInFlightModelSwitch: () => false,
    sendTextReply: async () => {},
    editInteractiveMessage: async () => {},
    sendInteractiveMessage: async (_chatId, text) => {
      events.push(`send:${text}`);
      return 99;
    },
  });
  await runtime.openModelMenu(1, 2, {
    cwd: "/repo",
    modelRegistry: { refresh: () => {}, getAvailable: () => [modelA] },
  });
  assert.deepEqual(events, [
    "reload:/repo",
    "patterns:1",
    "send:<b>🤖 Choose a model:</b>",
    "store:99",
  ]);
});

test("Menu helpers update and send interactive menu messages", async () => {
  const events: string[] = [];
  const modelA = createMenuModel("openai", "gpt-5", true);
  const state = createMenuState(2, {
    scope: "all",
    allModels: [{ model: modelA }],
    mode: "status",
  });
  const deps = {
    editInteractiveMessage: async (
      chatId: number,
      messageId: number,
      text: string,
      mode: "html" | "plain",
    ) => {
      events.push(`edit:${chatId}:${messageId}:${mode}:${text}`);
    },
    sendInteractiveMessage: async (
      chatId: number,
      text: string,
      mode: "html" | "plain",
    ) => {
      events.push(`send:${chatId}:${mode}:${text}`);
      return 99;
    },
  };
  await updateTelegramModelMenuMessage(state, modelA, deps);
  await updateTelegramThinkingMenuMessage(state, modelA, "medium", deps);
  await updateTelegramStatusMessage(
    state,
    "<b>Status</b>",
    modelA,
    "medium",
    deps,
  );
  const sentStatusId = await sendTelegramStatusMessage(
    state,
    "<b>Status</b>",
    modelA,
    "medium",
    deps,
  );
  const sentModelId = await sendTelegramModelMenuMessage(state, modelA, deps);
  assert.equal(sentStatusId, 99);
  assert.equal(sentModelId, 99);
  assert.equal(events[0], "edit:1:2:html:<b>🤖 Choose a model:</b>");
  assert.equal(events[1], "edit:1:2:html:<b>🧠 Choose a thinking level:</b>");
  assert.equal(events[2], "edit:1:2:html:<b>Status</b>");
  assert.equal(events[3], "send:1:html:<b>Status</b>");
  assert.equal(events[4], "send:1:html:<b>🤖 Choose a model:</b>");
});

test("Queue menu keeps main-menu navigation on top", async () => {
  const state = createMenuState(2);
  const queuedItems: TelegramQueueItem<string>[] = [
    {
      kind: "prompt",
      chatId: 1,
      replyToMessageId: 10,
      queueOrder: 1,
      queueLane: "priority",
      laneOrder: 1,
      priorityEmoji: "🕊",
      statusSummary: "queued <prompt>",
      sourceMessageIds: [10],
      queuedAttachments: [],
      content: [
        { type: "text", text: "[telegram] queued <prompt>\n\nfull body" },
      ],
      historyText: "",
    },
  ];
  const texts: string[] = [];
  const modes: string[] = [];
  const markups: Array<{
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  }> = [];
  const runtime = createTelegramQueueMenuRuntime<string>({
    telegramQueueStore: {
      getQueuedItems: () => queuedItems,
      setQueuedItems: () => {},
      hasQueuedItems: () => queuedItems.length > 0,
    },
    queueMutationRuntime: {
      append: () => {},
      reorder: () => {},
      clear: () => 0,
      removeByMessageIds: () => 0,
      clearPriorityByMessageId: () => false,
      prioritizeByMessageId: () => false,
    },
    sendInteractiveMessage: async (_chatId, text, mode, replyMarkup) => {
      texts.push(text);
      modes.push(mode);
      markups.push(replyMarkup);
      return 99;
    },
    editInteractiveMessage: async (
      _chatId,
      _messageId,
      text,
      mode,
      replyMarkup,
    ) => {
      texts.push(text);
      modes.push(mode);
      markups.push(replyMarkup);
    },
    answerCallbackQuery: async () => {},
    getModelMenuState: async () => state,
    getStoredModelMenuState: () => state,
    storeModelMenuState: () => {},
    updateStatusMessage: async () => {},
    updateStatus: () => {},
  });
  await runtime.openQueueMenu(1, 2, "ctx");
  await runtime.handleCallbackQuery(
    {
      id: "callback",
      data: "menu:queue",
      message: { chat: { id: 1 }, message_id: 2 },
    },
    "ctx",
  );
  await runtime.handleCallbackQuery(
    {
      id: "callback",
      data: "queue:pick:1:10",
      message: { chat: { id: 1 }, message_id: 2 },
    },
    "ctx",
  );
  queuedItems.length = 0;
  await runtime.openQueueMenu(1, 2, "ctx");
  assert.equal(markups[0]?.inline_keyboard[0]?.[0]?.callback_data, "menu:back");
  assert.equal(markups[1]?.inline_keyboard[0]?.[0]?.callback_data, "menu:back");
  assert.equal(
    markups[0]?.inline_keyboard[1]?.[0]?.text,
    "1. 🕊 queued <prompt>",
  );
  assert.deepEqual(markups[2]?.inline_keyboard[1], [
    { text: "🐢 Deprioritize 🕊", callback_data: "queue:prio:1:10" },
  ]);
  assert.deepEqual(markups[2]?.inline_keyboard[2], [
    { text: "🗑 Delete", callback_data: "queue:delete:1:10" },
  ]);
  assert.deepEqual(markups[3]?.inline_keyboard, [
    [{ text: "⬆️ Main menu", callback_data: "menu:back" }],
  ]);
  assert.equal(texts[0], "<b>⏳ Queue:</b>");
  assert.equal(
    texts[2],
    "<pre>[telegram] queued &lt;prompt&gt;\n\nfull body</pre>",
  );
  assert.equal(texts[3], "<b>⏳ Queue is empty.</b>");
  assert.deepEqual(modes, ["html", "html", "html", "html"]);
});

test("Queue item detail renders prompt as raw preformatted HTML", async () => {
  const state = createMenuState(2);
  const longPathPrompt =
    `[telegram]\n[attachments] /home/user/.pi/agent/tmp/telegram\n` +
    `- /home/user/.pi/agent/tmp/telegram/file.txt\n${"&<>".repeat(2000)}`;
  const texts: string[] = [];
  const runtime = createTelegramQueueMenuRuntime<string>({
    telegramQueueStore: {
      getQueuedItems: () => [
        {
          kind: "prompt",
          chatId: 1,
          replyToMessageId: 10,
          queueOrder: 1,
          queueLane: "default",
          laneOrder: 1,
          statusSummary: "file prompt",
          sourceMessageIds: [10],
          queuedAttachments: [],
          content: [{ type: "text", text: longPathPrompt }],
          historyText: "",
        },
      ],
      setQueuedItems: () => {},
      hasQueuedItems: () => true,
    },
    queueMutationRuntime: {
      append: () => {},
      reorder: () => {},
      clear: () => 0,
      removeByMessageIds: () => 0,
      clearPriorityByMessageId: () => false,
      prioritizeByMessageId: () => false,
    },
    sendInteractiveMessage: async () => 99,
    editInteractiveMessage: async (_chatId, _messageId, text) => {
      texts.push(text);
    },
    answerCallbackQuery: async () => {},
    getModelMenuState: async () => state,
    getStoredModelMenuState: () => state,
    storeModelMenuState: () => {},
    updateStatusMessage: async () => {},
    updateStatus: () => {},
  });
  await runtime.handleCallbackQuery(
    {
      id: "callback",
      data: "queue:pick:1:10",
      message: { chat: { id: 1 }, message_id: 2 },
    },
    "ctx",
  );
  assert.match(texts[0] ?? "", /^<pre>\[telegram\]/);
  assert.match(texts[0] ?? "", /\/home\/user\/\.pi\/agent\/tmp\/telegram/);
  assert.match(texts[0] ?? "", /&amp;&lt;&gt;/);
  assert.match(texts[0] ?? "", /… \[truncated\]<\/pre>$/);
  assert.ok((texts[0] ?? "").length < 4096);
});

test("Queue item delete requires confirmation", async () => {
  const state = createMenuState(2);
  const queuedItems: TelegramQueueItem<string>[] = [
    {
      kind: "prompt",
      chatId: 1,
      replyToMessageId: 10,
      queueOrder: 1,
      queueLane: "default",
      laneOrder: 1,
      statusSummary: "delete me",
      sourceMessageIds: [10],
      queuedAttachments: [],
      content: [{ type: "text", text: "[telegram] delete me" }],
      historyText: "",
    },
  ];
  const texts: string[] = [];
  const notices: Array<string | undefined> = [];
  const markups: Array<{
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  }> = [];
  const runtime = createTelegramQueueMenuRuntime<string>({
    telegramQueueStore: {
      getQueuedItems: () => queuedItems,
      setQueuedItems: () => {},
      hasQueuedItems: () => queuedItems.length > 0,
    },
    queueMutationRuntime: {
      append: () => {},
      reorder: () => {},
      clear: () => 0,
      removeByMessageIds: (messageIds) => {
        const index = queuedItems.findIndex((item) =>
          messageIds.includes(item.replyToMessageId),
        );
        if (index === -1) return 0;
        queuedItems.splice(index, 1);
        return 1;
      },
      clearPriorityByMessageId: () => false,
      prioritizeByMessageId: () => false,
    },
    sendInteractiveMessage: async () => 99,
    editInteractiveMessage: async (
      _chatId,
      _messageId,
      text,
      _mode,
      replyMarkup,
    ) => {
      texts.push(text);
      markups.push(replyMarkup);
    },
    answerCallbackQuery: async (_id, text) => {
      notices.push(text);
    },
    getModelMenuState: async () => state,
    getStoredModelMenuState: () => state,
    storeModelMenuState: () => {},
    updateStatusMessage: async () => {},
    updateStatus: () => {},
  });
  await runtime.handleCallbackQuery(
    {
      id: "delete",
      data: "queue:delete:1:10",
      message: { chat: { id: 1 }, message_id: 2 },
    },
    "ctx",
  );
  assert.equal(queuedItems.length, 1);
  assert.equal(texts[0], "<b>Delete this queued prompt?</b>");
  assert.deepEqual(markups[0]?.inline_keyboard, [
    [{ text: "🗑 Yes, delete", callback_data: "queue:confirm-delete:1:10" }],
    [{ text: "❌ No", callback_data: "queue:keep:1:10" }],
  ]);
  await runtime.handleCallbackQuery(
    {
      id: "legacy-cancel",
      data: "queue:cancel:1:10",
      message: { chat: { id: 1 }, message_id: 2 },
    },
    "ctx",
  );
  assert.equal(queuedItems.length, 1);
  assert.equal(texts[1], "<b>Delete this queued prompt?</b>");
  await runtime.handleCallbackQuery(
    {
      id: "keep",
      data: "queue:keep:1:10",
      message: { chat: { id: 1 }, message_id: 2 },
    },
    "ctx",
  );
  assert.equal(queuedItems.length, 1);
  assert.equal(texts[2], "<pre>[telegram] delete me</pre>");
  assert.equal(notices[2], "Kept in queue.");
  await runtime.handleCallbackQuery(
    {
      id: "confirm",
      data: "queue:confirm-delete:1:10",
      message: { chat: { id: 1 }, message_id: 2 },
    },
    "ctx",
  );
  assert.equal(queuedItems.length, 0);
  assert.equal(texts[3], "<b>⏳ Queue is empty.</b>");
  assert.equal(notices[3], "Deleted from queue.");
});

test("Menu helpers build model, thinking, and status UI payloads", () => {
  const modelA = createMenuModel("openai", "gpt-5", true);
  const modelB = createMenuModel("anthropic", "claude-3", false);
  const state = createMenuState<MenuModel>(2, {
    scopedModels: [{ model: modelA, thinkingLevel: "high" }],
    allModels: [{ model: modelB }],
  });
  assert.deepEqual(getModelMenuItems(state), state.scopedModels);
  assert.match(
    formatScopedModelButtonText(state.scopedModels[0], modelA),
    /^✅ /,
  );
  const modelMarkup = buildModelMenuReplyMarkup(state, modelA, 6);
  assert.equal(modelMarkup.inline_keyboard[0]?.[0]?.callback_data, "menu:back");
  assert.equal(
    modelMarkup.inline_keyboard[1]?.[0]?.callback_data,
    "model:scope:scoped",
  );
  assert.equal(
    modelMarkup.inline_keyboard[1]?.[1]?.callback_data,
    "model:scope:all",
  );
  assert.equal(
    modelMarkup.inline_keyboard[2]?.[0]?.callback_data,
    "model:pages",
  );
  assert.equal(
    modelMarkup.inline_keyboard[3]?.[0]?.callback_data,
    "model:pick:0",
  );
  const thinkingText = buildThinkingMenuText();
  assert.equal(thinkingText, "<b>🧠 Choose a thinking level:</b>");
  const thinkingMarkup = buildThinkingMenuReplyMarkup("medium");
  assert.equal(thinkingMarkup.inline_keyboard[0]?.[0]?.text, "⬆️ Main menu");
  assert.equal(
    thinkingMarkup.inline_keyboard[0]?.[0]?.callback_data,
    "menu:back",
  );
  assert.equal(
    thinkingMarkup.inline_keyboard.some((row) => row[0]?.text === "✅ medium"),
    true,
  );
  const statusMarkup = buildStatusReplyMarkup(modelA, "medium", 3);
  const statusCallbackData = statusMarkup.inline_keyboard.flatMap((row) =>
    row.map((button) => button.callback_data),
  );
  assert.equal(statusMarkup.inline_keyboard.length, 3);
  assert.equal(
    statusMarkup.inline_keyboard[0]?.[0]?.text.startsWith("🤖 Model"),
    true,
  );
  assert.equal(
    statusMarkup.inline_keyboard[1]?.[0]?.text.startsWith("🧠 Thinking"),
    true,
  );
  assert.equal(statusMarkup.inline_keyboard.at(-1)?.[0]?.text, "⏳ Queue: 3");
  assert.deepEqual(statusCallbackData, [
    "menu:model",
    "menu:thinking",
    "menu:queue",
  ]);
  assert.equal(
    statusCallbackData.some((callbackData) =>
      callbackData.startsWith("status:"),
    ),
    false,
  );
  const noReasoningMarkup = buildStatusReplyMarkup(modelB, "medium");
  assert.equal(noReasoningMarkup.inline_keyboard.length, 2);
});
