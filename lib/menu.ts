/**
 * Telegram menu and inline-keyboard rendering helpers
 * Owns menu state, inline UI text, and reply-markup generation for status, model, and thinking controls
 */

import {
  getCanonicalModelId,
  isThinkingLevel,
  type MenuModel,
  modelsMatch,
  parseTelegramCliScopedModelPatterns,
  resolveScopedModelPatterns,
  type ScopedTelegramModel,
  sortScopedModels,
  THINKING_LEVELS,
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
  mode: "status" | "model" | "thinking";
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

export type TelegramReplyMarkup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

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

export interface TelegramMenuEffectPort<TModel extends MenuModel = MenuModel> {
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  updateModelMenuMessage: () => Promise<void>;
  updateThinkingMenuMessage: () => Promise<void>;
  updateStatusMessage: () => Promise<void>;
  setModel: (model: TModel) => Promise<boolean>;
  setCurrentModel: (model: TModel) => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
  getCurrentThinkingLevel: () => ThinkingLevel;
  stagePendingModelSwitch: (selection: ScopedTelegramModel<TModel>) => void;
  restartInterruptedTelegramTurn: (
    selection: ScopedTelegramModel<TModel>,
  ) => Promise<boolean> | boolean;
}

export type TelegramStatusMenuCallbackDeps<
  TModel extends MenuModel = MenuModel,
> = Pick<
  TelegramMenuEffectPort<TModel>,
  "updateModelMenuMessage" | "updateThinkingMenuMessage" | "answerCallbackQuery"
>;

export type TelegramThinkingMenuCallbackDeps<
  TModel extends MenuModel = MenuModel,
> = Pick<
  TelegramMenuEffectPort<TModel>,
  | "setThinkingLevel"
  | "getCurrentThinkingLevel"
  | "updateStatusMessage"
  | "answerCallbackQuery"
>;

export type TelegramModelMenuCallbackDeps<
  TModel extends MenuModel = MenuModel,
> = Pick<
  TelegramMenuEffectPort<TModel>,
  | "updateModelMenuMessage"
  | "updateStatusMessage"
  | "answerCallbackQuery"
  | "setModel"
  | "setCurrentModel"
  | "setThinkingLevel"
  | "stagePendingModelSwitch"
  | "restartInterruptedTelegramTurn"
>;

export interface TelegramMenuCallbackEntryDeps {
  handleStatusAction: () => Promise<boolean>;
  handleThinkingAction: () => Promise<boolean>;
  handleModelAction: () => Promise<boolean>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
}

export interface MenuCallbackQuery {
  id: string;
  data?: string;
  message?: { message_id?: number };
}

export interface StoredTelegramMenuCallbackDeps<
  TModel extends MenuModel = MenuModel,
> {
  getStoredModelMenuState: (
    messageId: number | undefined,
  ) => TelegramModelMenuState<TModel> | undefined;
  handleStatusAction: (
    state: TelegramModelMenuState<TModel>,
  ) => Promise<boolean>;
  handleThinkingAction: (
    state: TelegramModelMenuState<TModel>,
  ) => Promise<boolean>;
  handleModelAction: (
    state: TelegramModelMenuState<TModel>,
  ) => Promise<boolean>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
}

export interface TelegramMenuCallbackRuntimeDeps<
  TContext,
  TModel extends MenuModel = MenuModel,
> {
  getStoredModelMenuState: (
    messageId: number | undefined,
  ) => TelegramModelMenuState<TModel> | undefined;
  getActiveModel: (ctx: TContext) => TModel | undefined;
  getThinkingLevel: () => ThinkingLevel;
  setThinkingLevel: (level: ThinkingLevel) => void;
  updateStatus: (ctx: TContext) => void;
  updateModelMenuMessage: (
    state: TelegramModelMenuState<TModel>,
    ctx: TContext,
  ) => Promise<void>;
  updateThinkingMenuMessage: (
    state: TelegramModelMenuState<TModel>,
    ctx: TContext,
  ) => Promise<void>;
  updateStatusMessage: (
    state: TelegramModelMenuState<TModel>,
    ctx: TContext,
  ) => Promise<void>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  isIdle: (ctx: TContext) => boolean;
  hasActiveTelegramTurn: () => boolean;
  hasAbortHandler: () => boolean;
  hasActiveToolExecutions: () => boolean;
  setModel: (model: TModel) => Promise<boolean>;
  setCurrentModel: (model: TModel, ctx: TContext) => void;
  stagePendingModelSwitch: (
    selection: ScopedTelegramModel<TModel>,
    ctx: TContext,
  ) => void;
  restartInterruptedTelegramTurn: (
    selection: ScopedTelegramModel<TModel>,
    ctx: TContext,
  ) => Promise<boolean> | boolean;
}

export interface TelegramStatusMenuOpenDeps<
  TModel extends MenuModel = MenuModel,
> {
  isIdle: () => boolean;
  sendBusyMessage: () => Promise<void>;
  getModelMenuState: () => Promise<TelegramModelMenuState<TModel>>;
  buildStatusHtml: () => string;
  getActiveModel: () => TModel | undefined;
  getThinkingLevel: () => ThinkingLevel;
  sendStatusMenu: (
    state: TelegramModelMenuState<TModel>,
    statusHtml: string,
    activeModel: TModel | undefined,
    thinkingLevel: ThinkingLevel,
  ) => Promise<number | undefined>;
  storeModelMenuState: (state: TelegramModelMenuState<TModel>) => void;
}

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

export interface TelegramMenuActionRuntimeDeps<
  TContext,
  TModel extends MenuModel = MenuModel,
> extends TelegramMenuMessageRuntimeDeps {
  getModelMenuState: (
    chatId: number,
    ctx: TContext,
  ) => Promise<TelegramModelMenuState<TModel>>;
  getActiveModel: (ctx: TContext) => TModel | undefined;
  getThinkingLevel: () => ThinkingLevel;
  buildStatusHtml: (ctx: TContext) => string;
  storeModelMenuState: (state: TelegramModelMenuState<TModel>) => void;
  isIdle: (ctx: TContext) => boolean;
  canOfferInFlightModelSwitch: (ctx: TContext) => boolean;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number,
    text: string,
  ) => Promise<unknown>;
}

export interface TelegramMenuActionRuntime<
  TContext,
  TModel extends MenuModel = MenuModel,
> {
  updateModelMenuMessage: (
    state: TelegramModelMenuState<TModel>,
    ctx: TContext,
  ) => Promise<void>;
  updateThinkingMenuMessage: (
    state: TelegramModelMenuState<TModel>,
    ctx: TContext,
  ) => Promise<void>;
  updateStatusMessage: (
    state: TelegramModelMenuState<TModel>,
    ctx: TContext,
  ) => Promise<void>;
  sendStatusMessage: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<void>;
  openModelMenu: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<void>;
}

export const TELEGRAM_MODEL_PAGE_SIZE = 6;

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

function getTelegramCliScopedModelPatterns(): string[] | undefined {
  return parseTelegramCliScopedModelPatterns(process.argv.slice(2));
}

export const MODEL_MENU_TITLE = "<b>Choose a model:</b>";

export interface BuildTelegramModelMenuStateParams<
  TModel extends MenuModel = MenuModel,
> {
  chatId: number;
  activeModel: TModel | undefined;
  availableModels: TModel[];
  configuredScopedModelPatterns: string[];
  cliScopedModelPatterns?: string[];
}

export type TelegramMenuCallbackAction =
  | { kind: "ignore" }
  | { kind: "status"; action: "model" | "thinking" | "restart" }
  | { kind: "thinking:set"; level: string }
  | {
      kind: "model";
      action: "noop" | "scope" | "page" | "pick";
      value?: string;
    };

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

function truncateTelegramButtonLabel(label: string, maxLength = 56): string {
  return label.length <= maxLength
    ? label
    : `${label.slice(0, maxLength - 1)}…`;
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

export function parseTelegramMenuCallbackAction(
  data: string | undefined,
): TelegramMenuCallbackAction {
  if (data === "status:model") return { kind: "status", action: "model" };
  if (data === "status:thinking") {
    return { kind: "status", action: "thinking" };
  }
  if (data === "status:restart") {
    return { kind: "status", action: "restart" };
  }
  if (data?.startsWith("thinking:set:")) {
    return {
      kind: "thinking:set",
      level: data.slice("thinking:set:".length),
    };
  }
  if (data?.startsWith("model:")) {
    const [, action, value] = data.split(":");
    if (
      action === "noop" ||
      action === "scope" ||
      action === "page" ||
      action === "pick"
    ) {
      return { kind: "model", action, value };
    }
  }
  return { kind: "ignore" };
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
  const action = parseTelegramMenuCallbackAction(params.data);
  if (action.kind !== "model") return { kind: "ignore" };
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
  if (action.action === "page") {
    const pageResult = applyTelegramModelPageSelection(
      params.state,
      action.value,
    );
    if (pageResult === "invalid") {
      return { kind: "answer", text: "Invalid page." };
    }
    if (pageResult === "unchanged") {
      return { kind: "answer" };
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
      return { kind: "answer", text: "Pi is busy. Send /stop first." };
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

export async function openTelegramStatusMenu<
  TModel extends MenuModel = MenuModel,
>(deps: TelegramStatusMenuOpenDeps<TModel>): Promise<void> {
  const state = await deps.getModelMenuState();
  const messageId = await deps.sendStatusMenu(
    state,
    deps.buildStatusHtml(),
    deps.getActiveModel(),
    deps.getThinkingLevel(),
  );
  if (messageId === undefined) return;
  state.messageId = messageId;
  state.mode = "status";
  deps.storeModelMenuState(state);
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

export async function handleTelegramMenuCallbackEntry(
  callbackQueryId: string,
  data: string | undefined,
  state: TelegramModelMenuState | undefined,
  deps: TelegramMenuCallbackEntryDeps,
): Promise<void> {
  if (!data) {
    await deps.answerCallbackQuery(callbackQueryId);
    return;
  }
  if (!state) {
    await deps.answerCallbackQuery(
      callbackQueryId,
      "Interactive message expired.",
    );
    return;
  }
  const handled =
    (await deps.handleStatusAction()) ||
    (await deps.handleThinkingAction()) ||
    (await deps.handleModelAction());
  if (!handled) {
    await deps.answerCallbackQuery(callbackQueryId);
  }
}

export async function handleStoredTelegramMenuCallback<
  TModel extends MenuModel = MenuModel,
>(
  query: MenuCallbackQuery,
  deps: StoredTelegramMenuCallbackDeps<TModel>,
): Promise<void> {
  const state = deps.getStoredModelMenuState(query.message?.message_id);
  await handleTelegramMenuCallbackEntry(query.id, query.data, state, {
    handleStatusAction: async () => {
      if (!state) return false;
      return deps.handleStatusAction(state);
    },
    handleThinkingAction: async () => {
      if (!state) return false;
      return deps.handleThinkingAction(state);
    },
    handleModelAction: async () => {
      if (!state) return false;
      return deps.handleModelAction(state);
    },
    answerCallbackQuery: deps.answerCallbackQuery,
  });
}

export interface TelegramMenuCallbackRuntimeAdapterDeps<
  TContext,
  TModel extends MenuModel = MenuModel,
> {
  getStoredModelMenuState: (
    messageId: number | undefined,
  ) => TelegramModelMenuState<TModel> | undefined;
  getActiveModel: (ctx: TContext) => TModel | undefined;
  getThinkingLevel: () => ThinkingLevel;
  setThinkingLevel: (level: ThinkingLevel) => void;
  updateStatus: (ctx: TContext, error?: string) => void;
  updateModelMenuMessage: (
    state: TelegramModelMenuState<TModel>,
    ctx: TContext,
  ) => Promise<void>;
  updateThinkingMenuMessage: (
    state: TelegramModelMenuState<TModel>,
    ctx: TContext,
  ) => Promise<void>;
  updateStatusMessage: (
    state: TelegramModelMenuState<TModel>,
    ctx: TContext,
  ) => Promise<void>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  isIdle: (ctx: TContext) => boolean;
  hasActiveTelegramTurn: () => boolean;
  hasAbortHandler: () => boolean;
  getActiveToolExecutions: () => number;
  setModel: (model: TModel) => Promise<boolean>;
  setCurrentModel: (model: TModel, ctx: TContext) => void;
  stagePendingModelSwitch: (
    selection: ScopedTelegramModel<TModel>,
    ctx: TContext,
  ) => void;
  restartInterruptedTelegramTurn: (
    selection: ScopedTelegramModel<TModel>,
    ctx: TContext,
  ) => Promise<boolean> | boolean;
}

export function createTelegramMenuCallbackHandler<
  TQuery extends MenuCallbackQuery,
  TContext,
  TModel extends MenuModel = MenuModel,
>(
  deps: TelegramMenuCallbackRuntimeDeps<TContext, TModel>,
): (query: TQuery, ctx: TContext) => Promise<void> {
  return (query, ctx) => handleTelegramMenuCallbackRuntime(query, ctx, deps);
}

export function createTelegramMenuCallbackHandlerForContext<
  TQuery extends MenuCallbackQuery,
  TContext,
  TModel extends MenuModel = MenuModel,
>(
  deps: TelegramMenuCallbackRuntimeAdapterDeps<TContext, TModel>,
): (query: TQuery, ctx: TContext) => Promise<void> {
  return createTelegramMenuCallbackHandler<TQuery, TContext, TModel>({
    getStoredModelMenuState: deps.getStoredModelMenuState,
    getActiveModel: deps.getActiveModel,
    getThinkingLevel: deps.getThinkingLevel,
    setThinkingLevel: deps.setThinkingLevel,
    updateStatus: deps.updateStatus,
    updateModelMenuMessage: deps.updateModelMenuMessage,
    updateThinkingMenuMessage: deps.updateThinkingMenuMessage,
    updateStatusMessage: deps.updateStatusMessage,
    answerCallbackQuery: deps.answerCallbackQuery,
    isIdle: deps.isIdle,
    hasActiveTelegramTurn: deps.hasActiveTelegramTurn,
    hasAbortHandler: deps.hasAbortHandler,
    hasActiveToolExecutions: () => deps.getActiveToolExecutions() > 0,
    setModel: deps.setModel,
    setCurrentModel: deps.setCurrentModel,
    stagePendingModelSwitch: deps.stagePendingModelSwitch,
    restartInterruptedTelegramTurn: deps.restartInterruptedTelegramTurn,
  });
}

export async function handleTelegramMenuCallbackRuntime<
  TQuery extends MenuCallbackQuery,
  TContext,
  TModel extends MenuModel = MenuModel,
>(
  query: TQuery,
  ctx: TContext,
  deps: TelegramMenuCallbackRuntimeDeps<TContext, TModel>,
): Promise<void> {
  await handleStoredTelegramMenuCallback(query, {
    getStoredModelMenuState: deps.getStoredModelMenuState,
    handleStatusAction: async (state) =>
      handleTelegramStatusMenuCallbackAction(
        query.id,
        query.data,
        deps.getActiveModel(ctx),
        {
          updateModelMenuMessage: () => deps.updateModelMenuMessage(state, ctx),
          updateThinkingMenuMessage: () =>
            deps.updateThinkingMenuMessage(state, ctx),
          answerCallbackQuery: deps.answerCallbackQuery,
        },
      ),
    handleThinkingAction: async (state) =>
      handleTelegramThinkingMenuCallbackAction(
        query.id,
        query.data,
        deps.getActiveModel(ctx),
        {
          setThinkingLevel: (level) => {
            deps.setThinkingLevel(level);
            deps.updateStatus(ctx);
          },
          getCurrentThinkingLevel: deps.getThinkingLevel,
          updateStatusMessage: () => deps.updateStatusMessage(state, ctx),
          answerCallbackQuery: deps.answerCallbackQuery,
        },
      ),
    handleModelAction: async (state) => {
      try {
        return await handleTelegramModelMenuCallbackAction(
          query.id,
          {
            data: query.data,
            state,
            activeModel: deps.getActiveModel(ctx),
            currentThinkingLevel: deps.getThinkingLevel(),
            isIdle: deps.isIdle(ctx),
            canRestartBusyRun:
              deps.hasActiveTelegramTurn() && deps.hasAbortHandler(),
            hasActiveToolExecutions: deps.hasActiveToolExecutions(),
          },
          {
            updateModelMenuMessage: () =>
              deps.updateModelMenuMessage(state, ctx),
            updateStatusMessage: () => deps.updateStatusMessage(state, ctx),
            answerCallbackQuery: deps.answerCallbackQuery,
            setModel: deps.setModel,
            setCurrentModel: (model) => deps.setCurrentModel(model, ctx),
            setThinkingLevel: (level) => {
              deps.setThinkingLevel(level);
              deps.updateStatus(ctx);
            },
            stagePendingModelSwitch: (selection) => {
              deps.stagePendingModelSwitch(selection, ctx);
            },
            restartInterruptedTelegramTurn: (selection) =>
              deps.restartInterruptedTelegramTurn(selection, ctx),
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await deps.answerCallbackQuery(query.id, message);
        return true;
      }
    },
    answerCallbackQuery: deps.answerCallbackQuery,
  });
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
        "Pi is busy. Send /stop first.",
      );
      return true;
    }
  }
  await deps.answerCallbackQuery(callbackQueryId, plan.callbackText);
  return true;
}

export async function handleTelegramStatusMenuCallbackAction(
  callbackQueryId: string,
  data: string | undefined,
  activeModel: MenuModel | undefined,
  deps: TelegramStatusMenuCallbackDeps,
): Promise<boolean> {
  const action = parseTelegramMenuCallbackAction(data);
  if (action.kind === "status" && action.action === "model") {
    await deps.updateModelMenuMessage();
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (action.kind === "status" && action.action === "restart") {
    await deps.answerCallbackQuery(
      callbackQueryId,
      "Restarting Telegram bridge...",
    );
    return true;
  }
  if (!(action.kind === "status" && action.action === "thinking")) {
    return false;
  }
  if (!activeModel?.reasoning) {
    await deps.answerCallbackQuery(
      callbackQueryId,
      "This model has no reasoning controls.",
    );
    return true;
  }
  await deps.updateThinkingMenuMessage();
  await deps.answerCallbackQuery(callbackQueryId);
  return true;
}

export async function handleTelegramThinkingMenuCallbackAction(
  callbackQueryId: string,
  data: string | undefined,
  activeModel: MenuModel | undefined,
  deps: TelegramThinkingMenuCallbackDeps,
): Promise<boolean> {
  const action = parseTelegramMenuCallbackAction(data);
  if (action.kind !== "thinking:set") return false;
  if (!isThinkingLevel(action.level)) {
    await deps.answerCallbackQuery(callbackQueryId, "Invalid thinking level.");
    return true;
  }
  if (!activeModel?.reasoning) {
    await deps.answerCallbackQuery(
      callbackQueryId,
      "This model has no reasoning controls.",
    );
    return true;
  }
  deps.setThinkingLevel(action.level);
  await deps.updateStatusMessage();
  await deps.answerCallbackQuery(
    callbackQueryId,
    `Thinking: ${deps.getCurrentThinkingLevel()}`,
  );
  return true;
}

export function buildThinkingMenuText(
  activeModel: MenuModel | undefined,
  currentThinkingLevel: ThinkingLevel,
): string {
  const lines = ["Choose a thinking level"];
  if (activeModel) {
    lines.push(`Model: ${getCanonicalModelId(activeModel)}`);
  }
  lines.push(`Current: ${currentThinkingLevel}`);
  return lines.join("\n");
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
  const rows = menuPage.items.map((entry, index) => [
    {
      text: formatScopedModelButtonText(entry, currentModel),
      callback_data: `model:pick:${menuPage.start + index}`,
    },
  ]);
  if (menuPage.pageCount > 1) {
    const previousPage =
      menuPage.page === 0 ? menuPage.pageCount - 1 : menuPage.page - 1;
    const nextPage =
      menuPage.page === menuPage.pageCount - 1 ? 0 : menuPage.page + 1;
    rows.push([
      { text: "⬅️", callback_data: `model:page:${previousPage}` },
      {
        text: `${menuPage.page + 1}/${menuPage.pageCount}`,
        callback_data: "model:noop",
      },
      { text: "➡️", callback_data: `model:page:${nextPage}` },
    ]);
  }
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
  return { inline_keyboard: rows };
}

export function buildThinkingMenuReplyMarkup(
  currentThinkingLevel: ThinkingLevel,
): TelegramReplyMarkup {
  return {
    inline_keyboard: THINKING_LEVELS.map((level) => [
      {
        text: level === currentThinkingLevel ? `✅ ${level}` : level,
        callback_data: `thinking:set:${level}`,
      },
    ]),
  };
}

export function buildStatusReplyMarkup(
  activeModel: MenuModel | undefined,
  currentThinkingLevel: ThinkingLevel,
): TelegramReplyMarkup {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  rows.push([
    {
      text: formatStatusButtonLabel(
        "Model",
        activeModel ? getCanonicalModelId(activeModel) : "unknown",
      ),
      callback_data: "status:model",
    },
  ]);
  if (activeModel?.reasoning) {
    rows.push([
      {
        text: formatStatusButtonLabel("Thinking", currentThinkingLevel),
        callback_data: "status:thinking",
      },
    ]);
  }
  // Restart button (hidden upstream, enable via PI_ENABLE_RESTART env)
  if (process.env["PI_ENABLE_RESTART"]) {
    rows.push([
      {
        text: "🔄 Restart",
        callback_data: "status:restart",
      },
    ]);
  }
  return { inline_keyboard: rows };
}

export function buildTelegramModelMenuRenderPayload(
  state: TelegramModelMenuState,
  activeModel: MenuModel | undefined,
): TelegramMenuRenderPayload {
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

export function buildTelegramThinkingMenuRenderPayload(
  activeModel: MenuModel | undefined,
  currentThinkingLevel: ThinkingLevel,
): TelegramMenuRenderPayload {
  return {
    nextMode: "thinking",
    text: buildThinkingMenuText(activeModel, currentThinkingLevel),
    mode: "plain",
    replyMarkup: buildThinkingMenuReplyMarkup(currentThinkingLevel),
  };
}

export function buildTelegramStatusMenuRenderPayload(
  statusText: string,
  activeModel: MenuModel | undefined,
  currentThinkingLevel: ThinkingLevel,
): TelegramMenuRenderPayload {
  return {
    nextMode: "status",
    text: statusText,
    mode: "html",
    replyMarkup: buildStatusReplyMarkup(activeModel, currentThinkingLevel),
  };
}

export interface TelegramMenuActionRuntimeWithStateBuilderDeps<
  TModel extends MenuModel = MenuModel,
  TContext extends TelegramModelMenuStateBuilderContext<TModel> =
    TelegramModelMenuStateBuilderContext<TModel>,
>
  extends
    Omit<TelegramMenuActionRuntimeDeps<TContext, TModel>, "getModelMenuState">,
    TelegramModelMenuStateBuilderDeps<TModel, TContext> {}

export function createTelegramMenuActionRuntimeWithStateBuilder<
  TModel extends MenuModel = MenuModel,
  TContext extends TelegramModelMenuStateBuilderContext<TModel> =
    TelegramModelMenuStateBuilderContext<TModel>,
>(
  deps: TelegramMenuActionRuntimeWithStateBuilderDeps<TModel, TContext>,
): TelegramMenuActionRuntime<TContext, TModel> {
  return createTelegramMenuActionRuntime({
    getModelMenuState: createTelegramModelMenuStateBuilder({
      runtime: deps.runtime,
      createSettingsManager: deps.createSettingsManager,
      getActiveModel: deps.getActiveModel,
    }),
    getActiveModel: deps.getActiveModel,
    getThinkingLevel: deps.getThinkingLevel,
    buildStatusHtml: deps.buildStatusHtml,
    storeModelMenuState: deps.storeModelMenuState,
    isIdle: deps.isIdle,
    canOfferInFlightModelSwitch: deps.canOfferInFlightModelSwitch,
    sendTextReply: deps.sendTextReply,
    editInteractiveMessage: deps.editInteractiveMessage,
    sendInteractiveMessage: deps.sendInteractiveMessage,
  });
}

export function createTelegramMenuActionRuntime<
  TContext,
  TModel extends MenuModel = MenuModel,
>(
  deps: TelegramMenuActionRuntimeDeps<TContext, TModel>,
): TelegramMenuActionRuntime<TContext, TModel> {
  return {
    updateModelMenuMessage: (state, ctx) =>
      updateTelegramModelMenuMessage(state, deps.getActiveModel(ctx), deps),
    updateThinkingMenuMessage: (state, ctx) =>
      updateTelegramThinkingMenuMessage(
        state,
        deps.getActiveModel(ctx),
        deps.getThinkingLevel(),
        deps,
      ),
    updateStatusMessage: (state, ctx) =>
      updateTelegramStatusMessage(
        state,
        deps.buildStatusHtml(ctx),
        deps.getActiveModel(ctx),
        deps.getThinkingLevel(),
        deps,
      ),
    sendStatusMessage: (chatId, replyToMessageId, ctx) =>
      openTelegramStatusMenu({
        isIdle: () => deps.isIdle(ctx),
        sendBusyMessage: async () => {
          await deps.sendTextReply(
            chatId,
            replyToMessageId,
            "Cannot open status while pi is busy. Send /stop first.",
          );
        },
        getModelMenuState: () => deps.getModelMenuState(chatId, ctx),
        buildStatusHtml: () => deps.buildStatusHtml(ctx),
        getActiveModel: () => deps.getActiveModel(ctx),
        getThinkingLevel: deps.getThinkingLevel,
        sendStatusMenu: (state, statusHtml, activeModel, thinkingLevel) =>
          sendTelegramStatusMessage(
            state,
            statusHtml,
            activeModel,
            thinkingLevel,
            deps,
          ),
        storeModelMenuState: deps.storeModelMenuState,
      }),
    openModelMenu: (chatId, replyToMessageId, ctx) =>
      openTelegramModelMenu({
        isIdle: () => deps.isIdle(ctx),
        canOfferInFlightModelSwitch: () =>
          deps.canOfferInFlightModelSwitch(ctx),
        sendBusyMessage: async () => {
          await deps.sendTextReply(
            chatId,
            replyToMessageId,
            "Cannot switch model while pi is busy. Send /stop first.",
          );
        },
        sendNoModelsMessage: async () => {
          await deps.sendTextReply(
            chatId,
            replyToMessageId,
            "No available models with configured auth.",
          );
        },
        getModelMenuState: () => deps.getModelMenuState(chatId, ctx),
        getActiveModel: () => deps.getActiveModel(ctx),
        sendModelMenu: (state, activeModel) =>
          sendTelegramModelMenuMessage(state, activeModel, deps),
        storeModelMenuState: deps.storeModelMenuState,
      }),
  };
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

export async function updateTelegramThinkingMenuMessage(
  state: TelegramModelMenuState,
  activeModel: MenuModel | undefined,
  currentThinkingLevel: ThinkingLevel,
  deps: TelegramMenuMessageRuntimeDeps,
): Promise<void> {
  await editTelegramMenuMessage(
    state,
    buildTelegramThinkingMenuRenderPayload(activeModel, currentThinkingLevel),
    deps,
  );
}

export async function updateTelegramStatusMessage(
  state: TelegramModelMenuState,
  statusText: string,
  activeModel: MenuModel | undefined,
  currentThinkingLevel: ThinkingLevel,
  deps: TelegramMenuMessageRuntimeDeps,
): Promise<void> {
  await editTelegramMenuMessage(
    state,
    buildTelegramStatusMenuRenderPayload(
      statusText,
      activeModel,
      currentThinkingLevel,
    ),
    deps,
  );
}

export function sendTelegramStatusMessage(
  state: TelegramModelMenuState,
  statusText: string,
  activeModel: MenuModel | undefined,
  currentThinkingLevel: ThinkingLevel,
  deps: TelegramMenuMessageRuntimeDeps,
): Promise<number | undefined> {
  return sendTelegramMenuMessage(
    state,
    buildTelegramStatusMenuRenderPayload(
      statusText,
      activeModel,
      currentThinkingLevel,
    ),
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
