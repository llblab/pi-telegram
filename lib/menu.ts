/**
 * Telegram menu and inline-keyboard rendering helpers
 * Zones: telegram ui, controls, status menu
 * Owns app-menu/status state, inline UI text, and callback composition while model/thinking/queue menu details live in dedicated domains
 */

import {
  createTelegramModelMenuStateBuilder,
  handleTelegramModelMenuCallbackAction,
  openTelegramModelMenu,
  sendTelegramModelMenuMessage,
  updateTelegramModelMenuMessage,
  type TelegramMenuMessageRuntimeDeps,
  type TelegramModelMenuState,
  type TelegramModelMenuStateBuilderContext,
  type TelegramModelMenuStateBuilderDeps,
  type TelegramReplyMarkup,
} from "./menu-model.ts";
import {
  handleTelegramStatusMenuCallbackAction,
  openTelegramStatusMenu,
  sendTelegramStatusMessage,
  updateTelegramStatusMessage,
} from "./menu-status.ts";
import {
  handleTelegramThinkingMenuCallbackAction,
  openTelegramThinkingMenu,
  updateTelegramThinkingMenuMessage,
} from "./menu-thinking.ts";
import {
  type MenuModel,
  type ScopedTelegramModel,
  type ThinkingLevel,
} from "./model.ts";
import {
  handleTelegramSectionCallback,
  handleTelegramSectionOpen,
  handleTelegramSectionSettingsOpen,
  parseTelegramSectionCallback,
  type TelegramSectionRegistry,
} from "./sections.ts";

export {
  applyTelegramModelPageSelection,
  applyTelegramModelScopeSelection,
  buildModelMenuReplyMarkup,
  buildModelPageMenuReplyMarkup,
  buildTelegramModelCallbackPlan,
  buildTelegramModelMenuRenderPayload,
  buildTelegramModelMenuState,
  buildTelegramModelMenuStateRuntime,
  buildTelegramModelPageMenuRenderPayload,
  createTelegramModelMenuRuntime,
  createTelegramModelMenuStateBuilder,
  formatScopedModelButtonText,
  getModelMenuItems,
  getStoredTelegramModelMenuState,
  getTelegramModelMenuPage,
  getTelegramModelSelection,
  handleTelegramModelMenuCallbackAction,
  MODEL_MENU_TITLE,
  MODEL_PAGE_MENU_TITLE,
  openTelegramModelMenu,
  pruneStoredTelegramModelMenus,
  resolveCachedTelegramModelMenuInputs,
  sendTelegramModelMenuMessage,
  storeTelegramModelMenuState,
  TELEGRAM_MODEL_PAGE_SIZE,
  updateTelegramModelMenuMessage,
} from "./menu-model.ts";
export type {
  BuildTelegramModelCallbackPlanParams,
  BuildTelegramModelMenuStateParams,
  CachedTelegramModelMenuInputs,
  MenuSettingsManager,
  StoredTelegramModelMenuState,
  TelegramMenuMessageRuntimeDeps,
  TelegramMenuMutationResult,
  TelegramMenuRenderPayload,
  TelegramMenuSelectionResult,
  TelegramModelCallbackPlan,
  TelegramModelMenuCallbackDeps,
  TelegramModelMenuInputCacheDeps,
  TelegramModelMenuOpenDeps,
  TelegramModelMenuPage,
  TelegramModelMenuRuntime,
  TelegramModelMenuRuntimeContext,
  TelegramModelMenuRuntimeOptions,
  TelegramModelMenuState,
  TelegramModelMenuStateBuilderContext,
  TelegramModelMenuStateBuilderDeps,
  TelegramModelMenuStoreOptions,
  TelegramModelScope,
  TelegramReplyMarkup,
} from "./menu-model.ts";
export {
  buildStatusReplyMarkup,
  buildTelegramStatusMenuRenderPayload,
  handleTelegramStatusMenuCallbackAction,
  openTelegramStatusMenu,
  sendTelegramStatusMessage,
  updateTelegramStatusMessage,
} from "./menu-status.ts";
export type {
  TelegramStatusMenuCallbackDeps,
  TelegramStatusMenuOpenDeps,
} from "./menu-status.ts";
export {
  buildTelegramThinkingMenuRenderPayload,
  buildThinkingMenuReplyMarkup,
  buildThinkingMenuText,
  handleTelegramThinkingMenuCallbackAction,
  openTelegramThinkingMenu,
  updateTelegramThinkingMenuMessage,
} from "./menu-thinking.ts";
export type {
  TelegramThinkingMenuCallbackDeps,
  TelegramThinkingMenuOpenDeps,
} from "./menu-thinking.ts";

export interface TelegramMenuEffectPort<TModel extends MenuModel = MenuModel> {
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  updateModelMenuMessage: () => Promise<void>;
  updateThinkingMenuMessage: () => Promise<void>;
  updateStatusMessage: () => Promise<void>;
  persistScopedModelPatterns?: (patterns: string[]) => Promise<void>;
  setModel: (model: TModel) => Promise<boolean>;
  setCurrentModel: (model: TModel) => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
  getCurrentThinkingLevel: () => ThinkingLevel;
  stagePendingModelSwitch: (selection: ScopedTelegramModel<TModel>) => void;
  restartInterruptedTelegramTurn: (
    selection: ScopedTelegramModel<TModel>,
  ) => Promise<boolean> | boolean;
}

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
  message?: {
    message_id?: number;
    message_thread_id?: number;
    chat?: { id?: number };
  };
}

export interface StoredTelegramMenuCallbackDeps<
  TModel extends MenuModel = MenuModel,
> {
  getStoredModelMenuState: (
    messageId: number | undefined,
    chatId?: number,
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
    chatId?: number,
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
  updateSettingsMenuMessage?: (
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
  persistScopedModelPatterns?: (
    patterns: string[],
    ctx: TContext,
  ) => Promise<void>;
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
  sectionRegistry?: TelegramSectionRegistry;
  editInteractiveMessage?: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "markdown" | "html" | "plain",
    replyMarkup: TelegramReplyMarkup,
  ) => Promise<void>;
  sendInteractiveMessage?: (
    chatId: number,
    text: string,
    mode: "markdown" | "html" | "plain",
    replyMarkup: TelegramReplyMarkup,
    options?: { target?: { chatId: number; threadId?: number } },
  ) => Promise<number | undefined>;
  enqueueSectionPrompt?: (
    prompt: string,
    ctx: TContext,
    target?: { chatId: number; threadId?: number },
  ) => Promise<void>;
  deleteMessage?: (chatId: number, messageId: number) => Promise<void>;
  isVoiceReplyActive?: () => boolean;
}

export interface TelegramMenuActionRuntimeDeps<
  TContext,
  TModel extends MenuModel = MenuModel,
> extends TelegramMenuMessageRuntimeDeps {
  getModelMenuState: (
    chatId: number,
    ctx: TContext,
    threadId?: number,
  ) => Promise<TelegramModelMenuState<TModel>>;
  getActiveModel: (ctx: TContext) => TModel | undefined;
  getThinkingLevel: () => ThinkingLevel;
  getQueueItemCount?: () => number;
  buildStatusHtml: (ctx: TContext) => string;
  storeModelMenuState: (state: TelegramModelMenuState<TModel>) => void;
  isIdle: (ctx: TContext) => boolean;
  canOfferInFlightModelSwitch: (ctx: TContext) => boolean;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number,
    text: string,
    options?: { target?: { chatId: number; threadId?: number } },
  ) => Promise<unknown>;
  sectionRegistry?: TelegramSectionRegistry;
  isVoiceReplyActive?: () => boolean;
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
    threadId?: number,
  ) => Promise<void>;
  openModelMenu: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
    threadId?: number,
  ) => Promise<void>;
  openThinkingMenu: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<void>;
}

export type TelegramMenuCallbackAction =
  | { kind: "ignore" }
  | { kind: "status"; action: "model" | "thinking" | "queue" | "settings" }
  | { kind: "thinking:set"; level: string }
  | {
      kind: "model";
      action:
        | "noop"
        | "scope"
        | "page"
        | "pages"
        | "open"
        | "pick"
        | "pick-selected"
        | "scope-enable"
        | "scope-disable"
        | "scope-toggle";
      value?: string;
    };

export function parseTelegramMenuCallbackAction(
  data: string | undefined,
): TelegramMenuCallbackAction {
  if (data === "menu:model" || data === "status:model") {
    return { kind: "status", action: "model" };
  }
  if (data === "menu:thinking" || data === "status:thinking") {
    return { kind: "status", action: "thinking" };
  }
  if (data === "menu:queue" || data === "status:queue") {
    return { kind: "status", action: "queue" };
  }
  if (data === "menu:settings" || data === "status:settings") {
    return { kind: "status", action: "settings" };
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
      action === "pages" ||
      action === "open" ||
      action === "pick" ||
      action === "pick-selected" ||
      action === "scope-enable" ||
      action === "scope-disable" ||
      action === "scope-toggle"
    ) {
      return { kind: "model", action, value };
    }
  }
  return { kind: "ignore" };
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
  const state = deps.getStoredModelMenuState(
    query.message?.message_id,
    query.message?.chat?.id,
  );
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
    chatId?: number,
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
  updateSettingsMenuMessage?: (
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
  persistScopedModelPatterns?: (
    patterns: string[],
    ctx: TContext,
  ) => Promise<void>;
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
  sectionRegistry?: TelegramSectionRegistry;
  editInteractiveMessage?: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "markdown" | "html" | "plain",
    replyMarkup: TelegramReplyMarkup,
  ) => Promise<void>;
  sendInteractiveMessage?: (
    chatId: number,
    text: string,
    mode: "markdown" | "html" | "plain",
    replyMarkup: TelegramReplyMarkup,
    options?: { target?: { chatId: number; threadId?: number } },
  ) => Promise<number | undefined>;
  enqueueSectionPrompt?: (
    prompt: string,
    ctx: TContext,
    target?: { chatId: number; threadId?: number },
  ) => Promise<void>;
  deleteMessage?: (chatId: number, messageId: number) => Promise<void>;
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
    updateSettingsMenuMessage: deps.updateSettingsMenuMessage,
    answerCallbackQuery: deps.answerCallbackQuery,
    isIdle: deps.isIdle,
    hasActiveTelegramTurn: deps.hasActiveTelegramTurn,
    hasAbortHandler: deps.hasAbortHandler,
    hasActiveToolExecutions: () => deps.getActiveToolExecutions() > 0,
    persistScopedModelPatterns: deps.persistScopedModelPatterns,
    setModel: deps.setModel,
    setCurrentModel: deps.setCurrentModel,
    stagePendingModelSwitch: deps.stagePendingModelSwitch,
    restartInterruptedTelegramTurn: deps.restartInterruptedTelegramTurn,
    sectionRegistry: deps.sectionRegistry,
    editInteractiveMessage: deps.editInteractiveMessage,
    sendInteractiveMessage: deps.sendInteractiveMessage,
    enqueueSectionPrompt: deps.enqueueSectionPrompt,
    deleteMessage: deps.deleteMessage,
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
  if (query.data === "menu:back") {
    const state = deps.getStoredModelMenuState(
      query.message?.message_id,
      query.message?.chat?.id,
    );
    if (!state) {
      await deps.answerCallbackQuery(query.id, "Interactive message expired.");
      return;
    }
    await deps.updateStatusMessage(state, ctx);
    await deps.answerCallbackQuery(query.id);
    return;
  }
  // Section callbacks: dispatch before built-in menu handling
  if (deps.sectionRegistry && query.data?.startsWith("section:")) {
    const parsed = parseTelegramSectionCallback(query.data);
    if (parsed) {
      const message = query.message;
      const chatId = message?.chat?.id;
      const messageId = message?.message_id;
      const target =
        typeof chatId === "number"
          ? typeof message?.message_thread_id === "number"
            ? { chatId, threadId: message.message_thread_id }
            : { chatId }
          : undefined;
      if (typeof chatId === "number" && typeof messageId === "number") {
        const { token, action, payload } = parsed;
        if (action === "open") {
          const state = deps.getStoredModelMenuState(messageId, chatId);
          if (!state) {
            await deps.answerCallbackQuery(
              query.id,
              "Interactive message expired.",
            );
            return;
          }
          const handled = await handleTelegramSectionOpen(
            deps.sectionRegistry,
            token,
            chatId,
            messageId,
            query.id,
            {
              answerCallbackQuery: deps.answerCallbackQuery,
              target,
              editInteractiveMessage:
                deps.editInteractiveMessage ?? (async () => {}),
              sendInteractiveMessage:
                deps.sendInteractiveMessage ?? (async () => undefined),
              enqueuePrompt: deps.enqueueSectionPrompt
                ? (prompt: string) =>
                    deps.enqueueSectionPrompt!(prompt, ctx, target)
                : async () => {},
              deleteMessage: deps.deleteMessage ?? (async () => {}),
            },
          );
          if (handled) return;
        } else if (action === "settings") {
          if (typeof chatId === "number" && typeof messageId === "number") {
            const handled = await handleTelegramSectionSettingsOpen(
              deps.sectionRegistry,
              token,
              chatId,
              messageId,
              query.id,
              {
                answerCallbackQuery: deps.answerCallbackQuery,
                target,
                editInteractiveMessage:
                  deps.editInteractiveMessage ?? (async () => {}),
                sendInteractiveMessage:
                  deps.sendInteractiveMessage ?? (async () => undefined),
                enqueuePrompt: deps.enqueueSectionPrompt
                  ? (prompt: string) =>
                      deps.enqueueSectionPrompt!(prompt, ctx, target)
                  : async () => {},
                deleteMessage: deps.deleteMessage ?? (async () => {}),
              },
            );
            if (handled) return;
          }
        } else {
          const handled = await handleTelegramSectionCallback(
            deps.sectionRegistry,
            token,
            action,
            payload,
            chatId,
            messageId,
            query.id,
            {
              answerCallbackQuery: deps.answerCallbackQuery,
              target,
              editInteractiveMessage:
                deps.editInteractiveMessage ?? (async () => {}),
              sendInteractiveMessage:
                deps.sendInteractiveMessage ?? (async () => undefined),
              enqueuePrompt: deps.enqueueSectionPrompt
                ? (prompt: string) =>
                    deps.enqueueSectionPrompt!(prompt, ctx, target)
                : async () => {},
              deleteMessage: deps.deleteMessage ?? (async () => {}),
            },
          );
          if (handled) return;
        }
      }
    }
  }
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
          updateSettingsMenuMessage: () =>
            deps.updateSettingsMenuMessage?.(state, ctx) ?? Promise.resolve(),
          answerCallbackQuery: deps.answerCallbackQuery,
          isVoiceReplyActive: deps.isVoiceReplyActive,
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
          isVoiceReplyActive: deps.isVoiceReplyActive,
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
            persistScopedModelPatterns: deps.persistScopedModelPatterns
              ? (patterns) => deps.persistScopedModelPatterns!(patterns, ctx)
              : undefined,
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

export interface TelegramMenuActionRuntimeWithStateBuilderDeps<
  TModel extends MenuModel = MenuModel,
  TContext extends TelegramModelMenuStateBuilderContext<TModel> =
    TelegramModelMenuStateBuilderContext<TModel>,
>
  extends
    Omit<TelegramMenuActionRuntimeDeps<TContext, TModel>, "getModelMenuState">,
    TelegramModelMenuStateBuilderDeps<TModel, TContext> {
  isVoiceReplyActive?: () => boolean;
}

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
    getQueueItemCount: deps.getQueueItemCount,
    buildStatusHtml: deps.buildStatusHtml,
    storeModelMenuState: deps.storeModelMenuState,
    isIdle: deps.isIdle,
    canOfferInFlightModelSwitch: deps.canOfferInFlightModelSwitch,
    sendTextReply: deps.sendTextReply,
    editInteractiveMessage: deps.editInteractiveMessage,
    sendInteractiveMessage: deps.sendInteractiveMessage,
    sectionRegistry: deps.sectionRegistry,
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
        deps.getQueueItemCount?.() ?? 0,
        deps.sectionRegistry,
        deps.isVoiceReplyActive?.(),
      ),
    sendStatusMessage: (chatId, replyToMessageId, ctx, threadId) =>
      openTelegramStatusMenu({
        isIdle: () => deps.isIdle(ctx),
        sendBusyMessage: async () => {
          await deps.sendTextReply(
            chatId,
            replyToMessageId,
            "Cannot open status while Pi is busy. Send /abort, /next, or /stop.",
            { target: { chatId, threadId } },
          );
        },
        getModelMenuState: () => deps.getModelMenuState(chatId, ctx, threadId),
        buildStatusHtml: () => deps.buildStatusHtml(ctx),
        getActiveModel: () => deps.getActiveModel(ctx),
        getThinkingLevel: deps.getThinkingLevel,
        getQueueItemCount: deps.getQueueItemCount,
        sendStatusMenu: (
          state,
          statusHtml,
          activeModel,
          thinkingLevel,
          queueItemCount,
        ) =>
          sendTelegramStatusMessage(
            state,
            statusHtml,
            activeModel,
            thinkingLevel,
            deps,
            queueItemCount,
            deps.sectionRegistry,
            deps.isVoiceReplyActive?.(),
          ),
        storeModelMenuState: deps.storeModelMenuState,
      }),
    openModelMenu: (chatId, replyToMessageId, ctx, threadId) =>
      openTelegramModelMenu({
        isIdle: () => deps.isIdle(ctx),
        canOfferInFlightModelSwitch: () =>
          deps.canOfferInFlightModelSwitch(ctx),
        sendBusyMessage: async () => {
          await deps.sendTextReply(
            chatId,
            replyToMessageId,
            "Cannot switch model while Pi is busy. Send /abort, /next, or /stop.",
            { target: { chatId, threadId } },
          );
        },
        sendNoModelsMessage: async () => {
          await deps.sendTextReply(
            chatId,
            replyToMessageId,
            "No available models with configured auth.",
            { target: { chatId, threadId } },
          );
        },
        getModelMenuState: () => deps.getModelMenuState(chatId, ctx, threadId),
        getActiveModel: () => deps.getActiveModel(ctx),
        sendModelMenu: (state, activeModel) =>
          sendTelegramModelMenuMessage(state, activeModel, deps),
        storeModelMenuState: deps.storeModelMenuState,
      }),
    openThinkingMenu: (chatId, _replyToMessageId, ctx) =>
      openTelegramThinkingMenu({
        getModelMenuState: () => deps.getModelMenuState(chatId, ctx),
        getActiveModel: () => deps.getActiveModel(ctx),
        getThinkingLevel: deps.getThinkingLevel,
        storeModelMenuState: deps.storeModelMenuState,
        editInteractiveMessage: deps.editInteractiveMessage,
        sendInteractiveMessage: deps.sendInteractiveMessage,
        isVoiceReplyActive: deps.isVoiceReplyActive,
      }),
  };
}
