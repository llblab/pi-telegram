/**
 * Telegram model menu UI helpers
 * Zones: telegram ui, model controls, menu composition
 * Owns model-menu state, scoped model pages, model callback planning, and model-menu message rendering
 */

import type { TelegramInlineKeyboardMarkup } from "./keyboard.ts";
import {
  type MenuModel,
  modelsMatch,
  parseTelegramCliScopedModelPatterns,
  resolveScopedModelPatterns,
  type ScopedTelegramModel,
  sortScopedModels,
  type ThinkingLevel,
} from "./model.ts";

const TELEGRAM_MODEL_MENU_CACHE_TTL_MS = 5000;
const TELEGRAM_MODEL_MENU_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_STORED_TELEGRAM_MODEL_MENUS = 50;

export type TelegramModelScope = "all" | "scoped";

export interface TelegramModelMenuState<TModel extends MenuModel = MenuModel> {
  chatId: number;
  messageId: number;
  page: number;
  scope: TelegramModelScope;
  scopedModels: ScopedTelegramModel<TModel>[];
  allModels: ScopedTelegramModel<TModel>[];
  note?: string;
  mode: "status" | "model" | "model-pages" | "thinking" | "queue";
}

export interface StoredTelegramModelMenuState<
  TModel extends MenuModel = MenuModel,
> {
  state: TelegramModelMenuState<TModel>;
  updatedAt: number;
}

export interface TelegramModelMenuStoreOptions {
  maxAgeMs: number;
  maxStoredMenus: number;
  now?: number;
}

export interface CachedTelegramModelMenuInputs<
  TModel extends MenuModel = MenuModel,
> {
  expiresAt: number;
  availableModels: TModel[];
  configuredScopedModelPatterns: string[];
  cliScopedModelPatterns?: string[];
}

export interface TelegramModelMenuInputCacheDeps<
  TModel extends MenuModel = MenuModel,
> {
  cacheTtlMs: number;
  now?: number;
  reloadSettings: () => Promise<void>;
  refreshAvailableModels: () => TModel[];
  getConfiguredScopedModelPatterns: () => string[] | undefined;
  getCliScopedModelPatterns: () => string[] | undefined;
}

export interface TelegramModelMenuRuntimeContext<
  TModel extends MenuModel = MenuModel,
> {
  modelRegistry: {
    refresh: () => void;
    getAvailable: () => TModel[];
  };
}

export interface TelegramModelMenuRuntimeOptions<
  TContext extends TelegramModelMenuRuntimeContext<TModel>,
  TModel extends MenuModel = MenuModel,
> {
  chatId: number;
  activeModel: TModel | undefined;
  cachedInputs: CachedTelegramModelMenuInputs<TModel> | undefined;
  cacheTtlMs: number;
  ctx: TContext;
  reloadSettings: () => Promise<void>;
  getConfiguredScopedModelPatterns: () => string[] | undefined;
  getCliScopedModelPatterns?: () => string[] | undefined;
}

export interface MenuSettingsManager {
  reload: () => Promise<void>;
  getEnabledModels: () => string[] | undefined;
}

export type TelegramModelMenuStateBuilderContext<
  TModel extends MenuModel = MenuModel,
> = TelegramModelMenuRuntimeContext<TModel> & { cwd: string };

export interface TelegramModelMenuStateBuilderDeps<
  TModel extends MenuModel = MenuModel,
  TContext extends TelegramModelMenuStateBuilderContext<TModel> =
    TelegramModelMenuStateBuilderContext<TModel>,
> {
  runtime: TelegramModelMenuRuntime<TModel>;
  createSettingsManager: (cwd: string) => MenuSettingsManager;
  getActiveModel: (ctx: TContext) => TModel | undefined;
}

export type TelegramReplyMarkup = TelegramInlineKeyboardMarkup;

export interface TelegramMenuMessageRuntimeDeps {
  editInteractiveMessage: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "html" | "plain",
    replyMarkup: TelegramReplyMarkup,
  ) => Promise<void>;
  sendInteractiveMessage: (
    chatId: number,
    text: string,
    mode: "html" | "plain",
    replyMarkup: TelegramReplyMarkup,
  ) => Promise<number | undefined>;
}

export type TelegramModelMenuCallbackDeps<
  TModel extends MenuModel = MenuModel,
> = {
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  updateModelMenuMessage: () => Promise<void>;
  updateStatusMessage: () => Promise<void>;
  setModel: (model: TModel) => Promise<boolean>;
  setCurrentModel: (model: TModel) => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
  stagePendingModelSwitch: (selection: ScopedTelegramModel<TModel>) => void;
  restartInterruptedTelegramTurn: (
    selection: ScopedTelegramModel<TModel>,
  ) => Promise<boolean> | boolean;
};

export interface TelegramModelMenuOpenDeps<
  TModel extends MenuModel = MenuModel,
> {
  isIdle: () => boolean;
  canOfferInFlightModelSwitch: () => boolean;
  sendBusyMessage: () => Promise<void>;
  sendNoModelsMessage: () => Promise<void>;
  getModelMenuState: () => Promise<TelegramModelMenuState<TModel>>;
  getActiveModel: () => TModel | undefined;
  sendModelMenu: (
    state: TelegramModelMenuState<TModel>,
    activeModel: TModel | undefined,
  ) => Promise<number | undefined>;
  storeModelMenuState: (state: TelegramModelMenuState<TModel>) => void;
}

export interface BuildTelegramModelMenuStateParams<
  TModel extends MenuModel = MenuModel,
> {
  chatId: number;
  activeModel: TModel | undefined;
  availableModels: TModel[];
  configuredScopedModelPatterns: string[];
  cliScopedModelPatterns?: string[];
}

export type TelegramMenuMutationResult = "invalid" | "unchanged" | "changed";
export type TelegramMenuSelectionResult<TModel extends MenuModel = MenuModel> =
  | { kind: "invalid" }
  | { kind: "missing" }
  | { kind: "selected"; selection: ScopedTelegramModel<TModel> };

export interface TelegramModelMenuPage<TModel extends MenuModel = MenuModel> {
  page: number;
  pageCount: number;
  start: number;
  items: ScopedTelegramModel<TModel>[];
}

export interface TelegramMenuRenderPayload {
  nextMode: TelegramModelMenuState["mode"];
  text: string;
  mode: "html" | "plain";
  replyMarkup: TelegramReplyMarkup;
}

export type TelegramModelCallbackPlan<TModel extends MenuModel = MenuModel> =
  | { kind: "ignore" }
  | { kind: "answer"; text?: string }
  | { kind: "update-menu"; text?: string }
  | {
      kind: "refresh-status";
      selection: ScopedTelegramModel<TModel>;
      callbackText: string;
      shouldApplyThinkingLevel: boolean;
    }
  | {
      kind: "switch-model";
      selection: ScopedTelegramModel<TModel>;
      mode: "idle" | "restart-now" | "restart-after-tool";
      callbackText: string;
    };

export interface BuildTelegramModelCallbackPlanParams<
  TModel extends MenuModel = MenuModel,
> {
  data: string | undefined;
  state: TelegramModelMenuState<TModel>;
  activeModel: TModel | undefined;
  currentThinkingLevel: ThinkingLevel;
  isIdle: boolean;
  canRestartBusyRun: boolean;
  hasActiveToolExecutions: boolean;
}

export interface TelegramModelMenuRuntime<
  TModel extends MenuModel = MenuModel,
> {
  storeState: (state: TelegramModelMenuState<TModel>) => void;
  getState: (
    messageId: number | undefined,
  ) => TelegramModelMenuState<TModel> | undefined;
  clear: () => void;
  buildState: <TContext extends TelegramModelMenuRuntimeContext<TModel>>(
    options: Omit<
      TelegramModelMenuRuntimeOptions<TContext, TModel>,
      "cachedInputs" | "cacheTtlMs"
    >,
  ) => Promise<TelegramModelMenuState<TModel>>;
}

export const TELEGRAM_MODEL_PAGE_SIZE = 6;
const TELEGRAM_MODEL_PAGE_PICKER_ROW_SIZE = 4;
export const MODEL_MENU_TITLE = "<b>🤖 Choose a model:</b>";
export const MODEL_PAGE_MENU_TITLE = "<b>Choose a page:</b>";

function truncateTelegramButtonLabel(label: string, maxLength = 56): string {
  return label.length <= maxLength
    ? label
    : `${label.slice(0, maxLength - 1)}…`;
}

function getTelegramCliScopedModelPatterns(): string[] | undefined {
  return parseTelegramCliScopedModelPatterns(process.argv.slice(2));
}

function parseTelegramModelMenuCallbackAction(
  data: string | undefined,
):
  | { action: "noop" | "scope" | "page" | "pages" | "pick"; value?: string }
  | undefined {
  if (!data?.startsWith("model:")) return undefined;
  const [, action, value] = data.split(":");
  if (
    action === "noop" ||
    action === "scope" ||
    action === "page" ||
    action === "pages" ||
    action === "pick"
  ) {
    return { action, value };
  }
  return undefined;
}

function applyTelegramMenuRenderPayload(
  state: TelegramModelMenuState,
  payload: TelegramMenuRenderPayload,
): TelegramMenuRenderPayload {
  state.mode = payload.nextMode;
  return payload;
}

async function editTelegramMenuMessage(
  state: TelegramModelMenuState,
  payload: TelegramMenuRenderPayload,
  deps: TelegramMenuMessageRuntimeDeps,
): Promise<void> {
  const appliedPayload = applyTelegramMenuRenderPayload(state, payload);
  await deps.editInteractiveMessage(
    state.chatId,
    state.messageId,
    appliedPayload.text,
    appliedPayload.mode,
    appliedPayload.replyMarkup,
  );
}

function sendTelegramMenuMessage(
  state: TelegramModelMenuState,
  payload: TelegramMenuRenderPayload,
  deps: TelegramMenuMessageRuntimeDeps,
): Promise<number | undefined> {
  const appliedPayload = applyTelegramMenuRenderPayload(state, payload);
  return deps.sendInteractiveMessage(
    state.chatId,
    appliedPayload.text,
    appliedPayload.mode,
    appliedPayload.replyMarkup,
  );
}

export function formatScopedModelButtonText<
  TModel extends MenuModel = MenuModel,
>(
  entry: ScopedTelegramModel<TModel>,
  currentModel: TModel | undefined,
): string {
  let label = `${modelsMatch(entry.model, currentModel) ? "✅ " : ""}${entry.model.id} [${entry.model.provider}]`;
  if (entry.thinkingLevel) {
    label += ` · ${entry.thinkingLevel}`;
  }
  return truncateTelegramButtonLabel(label);
}

export function formatStatusButtonLabel(label: string, value: string): string {
  return truncateTelegramButtonLabel(`${label}: ${value}`, 64);
}

export function getModelMenuItems<TModel extends MenuModel = MenuModel>(
  state: TelegramModelMenuState<TModel>,
): ScopedTelegramModel<TModel>[] {
  return state.scope === "scoped" && state.scopedModels.length > 0
    ? state.scopedModels
    : state.allModels;
}

export function pruneStoredTelegramModelMenus<
  TModel extends MenuModel = MenuModel,
>(
  menus: Map<number, StoredTelegramModelMenuState<TModel>>,
  options: TelegramModelMenuStoreOptions,
): void {
  const now = options.now ?? Date.now();
  for (const [messageId, entry] of menus.entries()) {
    if (now - entry.updatedAt <= options.maxAgeMs) continue;
    menus.delete(messageId);
  }
  while (menus.size > options.maxStoredMenus) {
    const oldestMessageId = menus.keys().next().value as number | undefined;
    if (oldestMessageId === undefined) return;
    menus.delete(oldestMessageId);
  }
}

export function storeTelegramModelMenuState<
  TModel extends MenuModel = MenuModel,
>(
  menus: Map<number, StoredTelegramModelMenuState<TModel>>,
  state: TelegramModelMenuState<TModel>,
  options: TelegramModelMenuStoreOptions,
): void {
  const now = options.now ?? Date.now();
  pruneStoredTelegramModelMenus(menus, { ...options, now });
  menus.set(state.messageId, { state, updatedAt: now });
  pruneStoredTelegramModelMenus(menus, { ...options, now });
}

export function getStoredTelegramModelMenuState<
  TModel extends MenuModel = MenuModel,
>(
  menus: Map<number, StoredTelegramModelMenuState<TModel>>,
  messageId: number | undefined,
  options: TelegramModelMenuStoreOptions,
): TelegramModelMenuState<TModel> | undefined {
  if (messageId === undefined) return undefined;
  const now = options.now ?? Date.now();
  pruneStoredTelegramModelMenus(menus, { ...options, now });
  const entry = menus.get(messageId);
  if (!entry) return undefined;
  menus.delete(messageId);
  entry.updatedAt = now;
  menus.set(messageId, entry);
  return entry.state;
}

export function createTelegramModelMenuRuntime<
  TModel extends MenuModel = MenuModel,
>(
  options: Partial<TelegramModelMenuStoreOptions> = {},
): TelegramModelMenuRuntime<TModel> {
  const menus = new Map<number, StoredTelegramModelMenuState<TModel>>();
  let cachedInputs: CachedTelegramModelMenuInputs<TModel> | undefined;
  const getStoreOptions = (): TelegramModelMenuStoreOptions => ({
    maxAgeMs: options.maxAgeMs ?? TELEGRAM_MODEL_MENU_STATE_TTL_MS,
    maxStoredMenus: options.maxStoredMenus ?? MAX_STORED_TELEGRAM_MODEL_MENUS,
    now: options.now,
  });
  return {
    storeState: (state) => {
      storeTelegramModelMenuState(menus, state, getStoreOptions());
    },
    getState: (messageId) =>
      getStoredTelegramModelMenuState(menus, messageId, getStoreOptions()),
    clear: () => {
      menus.clear();
      cachedInputs = undefined;
    },
    buildState: async (stateOptions) => {
      const result = await buildTelegramModelMenuStateRuntime({
        ...stateOptions,
        cachedInputs,
        cacheTtlMs: TELEGRAM_MODEL_MENU_CACHE_TTL_MS,
      });
      cachedInputs = result.cachedInputs;
      return result.state;
    },
  };
}

export function createTelegramModelMenuStateBuilder<
  TModel extends MenuModel = MenuModel,
  TContext extends TelegramModelMenuStateBuilderContext<TModel> =
    TelegramModelMenuStateBuilderContext<TModel>,
>(
  deps: TelegramModelMenuStateBuilderDeps<TModel, TContext>,
): (chatId: number, ctx: TContext) => Promise<TelegramModelMenuState<TModel>> {
  return async (chatId, ctx) => {
    const settingsManager = deps.createSettingsManager(ctx.cwd);
    return deps.runtime.buildState({
      chatId,
      activeModel: deps.getActiveModel(ctx),
      ctx,
      reloadSettings: () => settingsManager.reload(),
      getConfiguredScopedModelPatterns: () =>
        settingsManager.getEnabledModels(),
    });
  };
}

export async function resolveCachedTelegramModelMenuInputs<
  TModel extends MenuModel = MenuModel,
>(
  cachedInputs: CachedTelegramModelMenuInputs<TModel> | undefined,
  deps: TelegramModelMenuInputCacheDeps<TModel>,
): Promise<CachedTelegramModelMenuInputs<TModel>> {
  const now = deps.now ?? Date.now();
  if (cachedInputs && cachedInputs.expiresAt > now) return cachedInputs;
  await deps.reloadSettings();
  const availableModels = deps.refreshAvailableModels();
  const cliScopedModelPatterns = deps.getCliScopedModelPatterns();
  const configuredScopedModelPatterns =
    cliScopedModelPatterns ?? deps.getConfiguredScopedModelPatterns() ?? [];
  return {
    expiresAt: now + deps.cacheTtlMs,
    availableModels,
    configuredScopedModelPatterns,
    cliScopedModelPatterns,
  };
}

export function buildTelegramModelMenuState<
  TModel extends MenuModel = MenuModel,
>(
  params: BuildTelegramModelMenuStateParams<TModel>,
): TelegramModelMenuState<TModel> {
  const allModels = sortScopedModels(
    params.availableModels.map((model) => ({ model })),
    params.activeModel,
  );
  const scopedModels =
    params.configuredScopedModelPatterns.length > 0
      ? sortScopedModels(
          resolveScopedModelPatterns(
            params.configuredScopedModelPatterns,
            params.availableModels,
          ),
          params.activeModel,
        )
      : [];
  let note: string | undefined;
  if (
    params.configuredScopedModelPatterns.length > 0 &&
    scopedModels.length === 0
  ) {
    note = params.cliScopedModelPatterns
      ? "No CLI scoped models matched the current auth configuration. Showing all available models."
      : "No scoped models matched the current auth configuration. Showing all available models.";
  }
  return {
    chatId: params.chatId,
    messageId: 0,
    page: 0,
    scope: scopedModels.length > 0 ? "scoped" : "all",
    scopedModels,
    allModels,
    note,
    mode: "status",
  };
}

export async function buildTelegramModelMenuStateRuntime<
  TContext extends TelegramModelMenuRuntimeContext<TModel>,
  TModel extends MenuModel = MenuModel,
>(
  options: TelegramModelMenuRuntimeOptions<TContext, TModel>,
): Promise<{
  state: TelegramModelMenuState<TModel>;
  cachedInputs: CachedTelegramModelMenuInputs<TModel>;
}> {
  const cachedInputs = await resolveCachedTelegramModelMenuInputs(
    options.cachedInputs,
    {
      cacheTtlMs: options.cacheTtlMs,
      reloadSettings: options.reloadSettings,
      refreshAvailableModels: () => {
        options.ctx.modelRegistry.refresh();
        return options.ctx.modelRegistry.getAvailable();
      },
      getConfiguredScopedModelPatterns:
        options.getConfiguredScopedModelPatterns,
      getCliScopedModelPatterns:
        options.getCliScopedModelPatterns ?? getTelegramCliScopedModelPatterns,
    },
  );
  return {
    cachedInputs,
    state: buildTelegramModelMenuState({
      chatId: options.chatId,
      activeModel: options.activeModel,
      availableModels: cachedInputs.availableModels,
      configuredScopedModelPatterns: cachedInputs.configuredScopedModelPatterns,
      cliScopedModelPatterns: cachedInputs.cliScopedModelPatterns,
    }),
  };
}

export function applyTelegramModelScopeSelection(
  state: TelegramModelMenuState,
  value: string | undefined,
): TelegramMenuMutationResult {
  if (value !== "all" && value !== "scoped") return "invalid";
  if (value === state.scope) return "unchanged";
  state.scope = value;
  state.page = 0;
  return "changed";
}

export function applyTelegramModelPageSelection(
  state: TelegramModelMenuState,
  value: string | undefined,
): TelegramMenuMutationResult {
  const page = Number(value);
  if (!Number.isFinite(page)) return "invalid";
  if (page === state.page) return "unchanged";
  state.page = page;
  return "changed";
}

export function getTelegramModelSelection<TModel extends MenuModel = MenuModel>(
  state: TelegramModelMenuState<TModel>,
  value: string | undefined,
): TelegramMenuSelectionResult<TModel> {
  const index = Number(value);
  if (!Number.isFinite(index)) return { kind: "invalid" };
  const selection = getModelMenuItems(state)[index];
  if (!selection) return { kind: "missing" };
  return { kind: "selected", selection };
}

export function buildTelegramModelCallbackPlan<
  TModel extends MenuModel = MenuModel,
>(
  params: BuildTelegramModelCallbackPlanParams<TModel>,
): TelegramModelCallbackPlan<TModel> {
  const action = parseTelegramModelMenuCallbackAction(params.data);
  if (!action) return { kind: "ignore" };
  if (action.action === "noop") return { kind: "answer" };
  if (action.action === "scope") {
    const scopeResult = applyTelegramModelScopeSelection(
      params.state,
      action.value,
    );
    if (scopeResult === "invalid") {
      return { kind: "answer", text: "Unknown model scope." };
    }
    if (scopeResult === "unchanged") {
      return { kind: "answer" };
    }
    return {
      kind: "update-menu",
      text: params.state.scope === "scoped" ? "Scoped models" : "All models",
    };
  }
  if (action.action === "pages") {
    if (action.value === "back") {
      params.state.mode = "model";
      return { kind: "update-menu" };
    }
    params.state.mode = "model-pages";
    return { kind: "update-menu" };
  }
  if (action.action === "page") {
    const pageResult = applyTelegramModelPageSelection(
      params.state,
      action.value,
    );
    if (pageResult === "invalid") {
      return { kind: "answer", text: "Invalid page." };
    }
    params.state.mode = "model";
    if (pageResult === "unchanged") {
      return { kind: "update-menu" };
    }
    return { kind: "update-menu" };
  }
  if (action.action !== "pick") {
    return { kind: "answer" };
  }
  const selectionResult = getTelegramModelSelection(params.state, action.value);
  if (selectionResult.kind === "invalid") {
    return { kind: "answer", text: "Invalid model selection." };
  }
  if (selectionResult.kind === "missing") {
    return { kind: "answer", text: "Selected model is no longer available." };
  }
  const selection = selectionResult.selection;
  if (modelsMatch(selection.model, params.activeModel)) {
    return {
      kind: "refresh-status",
      selection,
      callbackText: `Model: ${selection.model.id}`,
      shouldApplyThinkingLevel:
        !!selection.thinkingLevel &&
        selection.thinkingLevel !== params.currentThinkingLevel,
    };
  }
  if (!params.isIdle) {
    if (!params.canRestartBusyRun) {
      return {
        kind: "answer",
        text: "π is busy. Send /abort, /next, or /stop.",
      };
    }
    return {
      kind: "switch-model",
      selection,
      mode: params.hasActiveToolExecutions
        ? "restart-after-tool"
        : "restart-now",
      callbackText: params.hasActiveToolExecutions
        ? `Switched to ${selection.model.id}. Restarting after the current tool finishes…`
        : `Switching to ${selection.model.id} and continuing…`,
    };
  }
  return {
    kind: "switch-model",
    selection,
    mode: "idle",
    callbackText: `Switched to ${selection.model.id}`,
  };
}

export async function openTelegramModelMenu<
  TModel extends MenuModel = MenuModel,
>(deps: TelegramModelMenuOpenDeps<TModel>): Promise<void> {
  if (!deps.isIdle() && !deps.canOfferInFlightModelSwitch()) {
    await deps.sendBusyMessage();
    return;
  }
  const state = await deps.getModelMenuState();
  if (state.allModels.length === 0) {
    await deps.sendNoModelsMessage();
    return;
  }
  const messageId = await deps.sendModelMenu(state, deps.getActiveModel());
  if (messageId === undefined) return;
  state.messageId = messageId;
  state.mode = "model";
  deps.storeModelMenuState(state);
}

export async function handleTelegramModelMenuCallbackAction<
  TModel extends MenuModel = MenuModel,
>(
  callbackQueryId: string,
  params: BuildTelegramModelCallbackPlanParams<TModel>,
  deps: TelegramModelMenuCallbackDeps<TModel>,
): Promise<boolean> {
  const plan = buildTelegramModelCallbackPlan(params);
  if (plan.kind === "ignore") return false;
  if (plan.kind === "answer") {
    await deps.answerCallbackQuery(callbackQueryId, plan.text);
    return true;
  }
  if (plan.kind === "update-menu") {
    await deps.updateModelMenuMessage();
    await deps.answerCallbackQuery(callbackQueryId, plan.text);
    return true;
  }
  if (plan.kind === "refresh-status") {
    if (plan.shouldApplyThinkingLevel && plan.selection.thinkingLevel) {
      deps.setThinkingLevel(plan.selection.thinkingLevel);
    }
    await deps.updateStatusMessage();
    await deps.answerCallbackQuery(callbackQueryId, plan.callbackText);
    return true;
  }
  const changed = await deps.setModel(plan.selection.model);
  if (changed === false) {
    await deps.answerCallbackQuery(callbackQueryId, "Model is not available.");
    return true;
  }
  deps.setCurrentModel(plan.selection.model);
  if (plan.selection.thinkingLevel) {
    deps.setThinkingLevel(plan.selection.thinkingLevel);
  }
  await deps.updateStatusMessage();
  if (plan.mode === "restart-after-tool") {
    deps.stagePendingModelSwitch(plan.selection);
    await deps.answerCallbackQuery(callbackQueryId, plan.callbackText);
    return true;
  }
  if (plan.mode === "restart-now") {
    const restarted = await deps.restartInterruptedTelegramTurn(plan.selection);
    if (!restarted) {
      await deps.answerCallbackQuery(
        callbackQueryId,
        "π is busy. Send /abort, /next, or /stop.",
      );
      return true;
    }
  }
  await deps.answerCallbackQuery(callbackQueryId, plan.callbackText);
  return true;
}

export function getTelegramModelMenuPage(
  state: TelegramModelMenuState,
  pageSize: number,
): TelegramModelMenuPage {
  const items = getModelMenuItems(state);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.max(0, Math.min(state.page, pageCount - 1));
  const start = page * pageSize;
  return {
    page,
    pageCount,
    start,
    items: items.slice(start, start + pageSize),
  };
}

export function buildModelMenuReplyMarkup(
  state: TelegramModelMenuState,
  currentModel: MenuModel | undefined,
  pageSize: number,
): TelegramReplyMarkup {
  const menuPage = getTelegramModelMenuPage(state, pageSize);
  const rows = [[{ text: "⬆️ Main menu", callback_data: "menu:back" }]];
  if (state.scopedModels.length > 0) {
    rows.push([
      {
        text: state.scope === "scoped" ? "✅ Scoped" : "Scoped",
        callback_data: "model:scope:scoped",
      },
      {
        text: state.scope === "all" ? "✅ All" : "All",
        callback_data: "model:scope:all",
      },
    ]);
  }
  const previousPage =
    menuPage.page === 0 ? menuPage.pageCount - 1 : menuPage.page - 1;
  const nextPage =
    menuPage.page === menuPage.pageCount - 1 ? 0 : menuPage.page + 1;
  rows.push(
    menuPage.pageCount > 1
      ? [
          { text: "⬅️", callback_data: `model:page:${previousPage}` },
          {
            text: `${menuPage.page + 1}/${menuPage.pageCount}`,
            callback_data: "model:pages",
          },
          { text: "➡️", callback_data: `model:page:${nextPage}` },
        ]
      : [
          {
            text: `${menuPage.page + 1}/${menuPage.pageCount}`,
            callback_data: "model:pages",
          },
        ],
  );
  rows.push(
    ...menuPage.items.map((entry, index) => [
      {
        text: formatScopedModelButtonText(entry, currentModel),
        callback_data: `model:pick:${menuPage.start + index}`,
      },
    ]),
  );
  return { inline_keyboard: rows };
}

export function buildModelPageMenuReplyMarkup(
  state: TelegramModelMenuState,
  pageSize: number,
): TelegramReplyMarkup {
  const menuPage = getTelegramModelMenuPage(state, pageSize);
  const rows = [[{ text: "⬆️ Back", callback_data: "model:pages:back" }]];
  for (
    let page = 0;
    page < menuPage.pageCount;
    page += TELEGRAM_MODEL_PAGE_PICKER_ROW_SIZE
  ) {
    rows.push(
      Array.from(
        {
          length: Math.min(
            TELEGRAM_MODEL_PAGE_PICKER_ROW_SIZE,
            menuPage.pageCount - page,
          ),
        },
        (_unused, offset) => ({
          text: String(page + offset + 1),
          callback_data: `model:page:${page + offset}`,
        }),
      ),
    );
  }
  return { inline_keyboard: rows };
}

export function buildTelegramModelPageMenuRenderPayload(
  state: TelegramModelMenuState,
): TelegramMenuRenderPayload {
  return {
    nextMode: "model-pages",
    text: MODEL_PAGE_MENU_TITLE,
    mode: "html",
    replyMarkup: buildModelPageMenuReplyMarkup(state, TELEGRAM_MODEL_PAGE_SIZE),
  };
}

export function buildTelegramModelMenuRenderPayload(
  state: TelegramModelMenuState,
  activeModel: MenuModel | undefined,
): TelegramMenuRenderPayload {
  if (state.mode === "model-pages") {
    return buildTelegramModelPageMenuRenderPayload(state);
  }
  return {
    nextMode: "model",
    text: MODEL_MENU_TITLE,
    mode: "html",
    replyMarkup: buildModelMenuReplyMarkup(
      state,
      activeModel,
      TELEGRAM_MODEL_PAGE_SIZE,
    ),
  };
}

export async function updateTelegramModelMenuMessage(
  state: TelegramModelMenuState,
  activeModel: MenuModel | undefined,
  deps: TelegramMenuMessageRuntimeDeps,
): Promise<void> {
  await editTelegramMenuMessage(
    state,
    buildTelegramModelMenuRenderPayload(state, activeModel),
    deps,
  );
}

export function sendTelegramModelMenuMessage(
  state: TelegramModelMenuState,
  activeModel: MenuModel | undefined,
  deps: TelegramMenuMessageRuntimeDeps,
): Promise<number | undefined> {
  return sendTelegramMenuMessage(
    state,
    buildTelegramModelMenuRenderPayload(state, activeModel),
    deps,
  );
}
