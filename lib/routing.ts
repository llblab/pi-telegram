/**
 * Telegram inbound routing composition
 * Zones: telegram inbound, orchestration, queue/menu/command composition
 * Wires authorized updates into menus, commands, media grouping, and prompt queueing
 */

import * as OutboundHandlers from "./outbound-handlers.ts";
import * as Commands from "./commands.ts";
import type { TelegramConfigStore } from "./config.ts";
import type { TelegramAttachmentHandlerRuntime } from "./attachment-handlers.ts";
import * as Media from "./media.ts";
import * as Menu from "./menu.ts";
import * as Model from "./model.ts";
import * as Queue from "./queue.ts";
import * as PromptTemplates from "./prompt-templates.ts";
import type { TelegramBridgeRuntime } from "./runtime.ts";
import * as Turns from "./turns.ts";
import * as Updates from "./updates.ts";

export type TelegramRoutedMessage = Updates.TelegramUpdateMessage &
  Media.TelegramMediaMessage &
  Media.TelegramMediaGroupMessage &
  Commands.TelegramCommandRuntimeMessage &
  Turns.TelegramTurnMessage;

export type TelegramRoutedCallbackQuery = Updates.TelegramCallbackQuery &
  Menu.MenuCallbackQuery;

export interface TelegramInboundRouteRuntimeDeps<
  TMessage extends TelegramRoutedMessage,
  TCallbackQuery extends TelegramRoutedCallbackQuery,
  TContext,
  TModel extends Model.MenuModel,
> {
  configStore: Pick<
    TelegramConfigStore,
    "getAllowedUserId" | "setAllowedUserId" | "persist"
  >;
  bridgeRuntime: TelegramBridgeRuntime;
  activeTurnRuntime: Queue.TelegramActiveTurnStore;
  mediaGroupRuntime: Media.TelegramMediaGroupController<TMessage, TContext>;
  telegramQueueStore: Queue.TelegramQueueStateStore<TContext>;
  queueMutationRuntime: Queue.TelegramQueueMutationController<TContext>;
  modelMenuRuntime: Menu.TelegramModelMenuRuntime<TModel>;
  currentModelRuntime: Model.CurrentModelRuntime<TContext, TModel>;
  modelSwitchController: Model.TelegramModelSwitchController<
    TContext,
    Model.ScopedTelegramModel<TModel>
  >;
  menuActions: Menu.TelegramMenuActionRuntime<TContext, TModel>;
  openQueueMenu: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<void>;
  queueMenuCallbackHandler: (
    query: TCallbackQuery,
    ctx: TContext,
  ) => Promise<boolean>;
  buttonActionStore?: OutboundHandlers.TelegramButtonActionStore;
  attachmentHandlerRuntime: TelegramAttachmentHandlerRuntime<TContext>;
  updateStatus: (ctx: TContext, error?: string) => void;
  dispatchNextQueuedTelegramTurn: (ctx: TContext) => void;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number,
    text: string,
  ) => Promise<number | undefined>;
  setMyCommands: Commands.TelegramBotCommandRegistrationDeps["setMyCommands"];
  getCommands: () => Parameters<typeof PromptTemplates.getTelegramPromptTemplateCommands>[0];
  downloadFile: Media.DownloadTelegramMessageFilesDeps["downloadFile"];
  getThinkingLevel: () => Model.ThinkingLevel;
  setThinkingLevel: (level: Model.ThinkingLevel) => void;
  setModel: (model: TModel) => Promise<boolean>;
  isIdle: (ctx: TContext) => boolean;
  hasPendingMessages: (ctx: TContext) => boolean;
  compact: (
    ctx: TContext,
    callbacks: { onComplete: () => void; onError: (error: unknown) => void },
  ) => void;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export function createTelegramInboundRouteRuntime<
  TUpdate extends Updates.TelegramUpdateFlow & {
    message?: TMessage;
    edited_message?: TMessage;
    callback_query?: TCallbackQuery;
  },
  TMessage extends TelegramRoutedMessage,
  TCallbackQuery extends TelegramRoutedCallbackQuery,
  TContext,
  TModel extends Model.MenuModel,
>(
  deps: TelegramInboundRouteRuntimeDeps<
    TMessage,
    TCallbackQuery,
    TContext,
    TModel
  >,
): Updates.TelegramUpdateRuntimeController<TContext, TUpdate> {
  const menuCallbackHandler = Menu.createTelegramMenuCallbackHandlerForContext<
    TCallbackQuery,
    TContext,
    TModel
  >({
    getStoredModelMenuState: deps.modelMenuRuntime.getState,
    getActiveModel: deps.currentModelRuntime.get,
    getThinkingLevel: deps.getThinkingLevel,
    setThinkingLevel: deps.setThinkingLevel,
    updateStatus: deps.updateStatus,
    updateModelMenuMessage: deps.menuActions.updateModelMenuMessage,
    updateThinkingMenuMessage: deps.menuActions.updateThinkingMenuMessage,
    updateStatusMessage: deps.menuActions.updateStatusMessage,
    answerCallbackQuery: deps.answerCallbackQuery,
    isIdle: deps.isIdle,
    hasActiveTelegramTurn: deps.activeTurnRuntime.has,
    hasAbortHandler: deps.bridgeRuntime.abort.hasHandler,
    getActiveToolExecutions:
      deps.bridgeRuntime.lifecycle.getActiveToolExecutions,
    setModel: deps.setModel,
    setCurrentModel: deps.currentModelRuntime.setCurrentModel,
    stagePendingModelSwitch: deps.modelSwitchController.stagePendingSwitch,
    restartInterruptedTelegramTurn:
      deps.modelSwitchController.restartInterruptedTurn,
  });
  const callbackHandler = async (
    query: TCallbackQuery,
    ctx: TContext,
  ): Promise<void> => {
    if (deps.buttonActionStore) {
      const handled = await OutboundHandlers.handleTelegramButtonCallbackQuery(
        query,
        ctx,
        {
          resolveAction: deps.buttonActionStore.resolve,
          answerCallbackQuery: deps.answerCallbackQuery,
          enqueueButtonPrompt: (buttonQuery, action, context) => {
            const chatId = buttonQuery.message?.chat?.id;
            const messageId = buttonQuery.message?.message_id;
            if (typeof chatId !== "number" || typeof messageId !== "number")
              return;
            const queueOrder = deps.bridgeRuntime.queue.allocateItemOrder();
            deps.queueMutationRuntime.append(
              OutboundHandlers.createTelegramButtonPromptTurn({
                chatId,
                replyToMessageId: messageId,
                queueOrder,
                action,
              }),
              context,
            );
            deps.updateStatus(context);
            deps.dispatchNextQueuedTelegramTurn(context);
          },
        },
      );
      if (handled) return;
    }
    const handledByQueue = await deps.queueMenuCallbackHandler(query, ctx);
    if (handledByQueue) return;
    await menuCallbackHandler(query, ctx);
  };
  const promptTurnBuilder = Turns.createTelegramPromptTurnRuntimeBuilder<
    TMessage,
    TContext
  >({
    allocateQueueOrder: deps.bridgeRuntime.queue.allocateItemOrder,
    downloadFile: deps.downloadFile,
    processAttachments: deps.attachmentHandlerRuntime.process,
  });
  const enqueueContinueTurn = async (
    message: TMessage,
    ctx: TContext,
  ): Promise<void> => {
    const enqueuePlan = Queue.planTelegramPromptEnqueue(
      deps.telegramQueueStore.getQueuedItems(),
      deps.bridgeRuntime.lifecycle.shouldPreserveQueuedTurnsAsHistory(),
    );
    deps.bridgeRuntime.lifecycle.setPreserveQueuedTurnsAsHistory(false);
    const continueMessage = {
      ...message,
      text: "continue",
      caption: undefined,
    } as TMessage;
    const turn = await promptTurnBuilder(
      [continueMessage],
      enqueuePlan.historyTurns,
      ctx,
    );
    const continueTurn = {
      ...turn,
      queueLane: "priority" as const,
      laneOrder: Number.MIN_SAFE_INTEGER + turn.queueOrder,
      statusSummary: "continue",
    };
    deps.telegramQueueStore.setQueuedItems(enqueuePlan.remainingItems);
    deps.queueMutationRuntime.append(continueTurn, ctx);
    deps.dispatchNextQueuedTelegramTurn(ctx);
  };
  const reservedCommandNames = new Set(Commands.TELEGRAM_RESERVED_COMMAND_NAMES);
  const getPromptTemplateCommands = () =>
    PromptTemplates.getTelegramPromptTemplateCommands(
      deps.getCommands(),
      reservedCommandNames,
    );
  const commandHandler = Commands.createTelegramCommandHandlerTargetRuntime<
    TMessage,
    TContext
  >({
    hasAbortHandler: deps.bridgeRuntime.abort.hasHandler,
    clearPendingModelSwitch: deps.modelSwitchController.clearPendingSwitch,
    hasQueuedTelegramItems: deps.telegramQueueStore.hasQueuedItems,
    clearQueuedTelegramItems: deps.queueMutationRuntime.clear,
    setPreserveQueuedTurnsAsHistory:
      deps.bridgeRuntime.lifecycle.setPreserveQueuedTurnsAsHistory,
    abortCurrentTurn: deps.bridgeRuntime.abort.abortTurn,
    isIdle: deps.isIdle,
    hasPendingMessages: deps.hasPendingMessages,
    hasActiveTelegramTurn: deps.activeTurnRuntime.has,
    hasDispatchPending: deps.bridgeRuntime.lifecycle.hasDispatchPending,
    isCompactionInProgress: deps.bridgeRuntime.lifecycle.isCompactionInProgress,
    setCompactionInProgress:
      deps.bridgeRuntime.lifecycle.setCompactionInProgress,
    updateStatus: deps.updateStatus,
    dispatchNextQueuedTelegramTurn: deps.dispatchNextQueuedTelegramTurn,
    enqueueContinueTurn,
    compact: deps.compact,
    allocateItemOrder: deps.bridgeRuntime.queue.allocateItemOrder,
    allocateControlOrder: deps.bridgeRuntime.queue.allocateControlOrder,
    appendControlItem: deps.queueMutationRuntime.append,
    showStatus: deps.menuActions.sendStatusMessage,
    openModelMenu: deps.menuActions.openModelMenu,
    openThinkingMenu: (message, ctx) => {
      const chatId = (message as { chat: { id: number } }).chat.id;
      return deps.menuActions.openThinkingMenu(chatId, message.message_id, ctx);
    },
    openQueueMenu: (message, ctx) => {
      const chatId = (message as { chat: { id: number } }).chat.id;
      return deps.openQueueMenu(chatId, message.message_id, ctx);
    },
    getAllowedUserId: deps.configStore.getAllowedUserId,
    setAllowedUserId: deps.configStore.setAllowedUserId,
    setMyCommands: deps.setMyCommands,
    getPromptTemplateCommands,
    persistConfig: deps.configStore.persist,
    sendTextReply: deps.sendTextReply,
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
  const promptEnqueue = Queue.createTelegramPromptEnqueueController<
    TMessage,
    TContext
  >({
    ...deps.telegramQueueStore,
    getPreserveQueuedTurnsAsHistory:
      deps.bridgeRuntime.lifecycle.shouldPreserveQueuedTurnsAsHistory,
    setPreserveQueuedTurnsAsHistory:
      deps.bridgeRuntime.lifecycle.setPreserveQueuedTurnsAsHistory,
    createTurn: promptTurnBuilder,
    updateStatus: deps.updateStatus,
    dispatchNextQueuedTelegramTurn: deps.dispatchNextQueuedTelegramTurn,
  }).enqueue;
  const commandOrPrompt = Commands.createTelegramCommandOrPromptRuntime<
    TMessage,
    TContext
  >({
    extractRawText: Media.extractFirstTelegramMessageText,
    handleCommand: commandHandler,
    expandPromptTemplateCommand: (commandName, args) =>
      PromptTemplates.expandTelegramPromptTemplateCommand(
        commandName,
        args,
        getPromptTemplateCommands(),
      ),
    replaceMessageText: (message, text) =>
      ({ ...message, text, caption: undefined }) as TMessage,
    enqueueTurn: promptEnqueue,
  });
  const mediaDispatch = Media.createTelegramMediaGroupDispatchRuntime<
    TMessage,
    TContext
  >({
    mediaGroups: deps.mediaGroupRuntime,
    dispatchMessages: commandOrPrompt.dispatchMessages,
  });
  const editRuntime = Turns.createTelegramQueuedPromptEditRuntime<
    TMessage,
    TContext
  >({
    ...deps.telegramQueueStore,
    updateStatus: deps.updateStatus,
  });
  return Updates.createTelegramPairedUpdateRuntime<TContext, TUpdate>({
    getAllowedUserId: deps.configStore.getAllowedUserId,
    setAllowedUserId: deps.configStore.setAllowedUserId,
    persistConfig: deps.configStore.persist,
    updateStatus: deps.updateStatus,
    removePendingMediaGroupMessages: deps.mediaGroupRuntime.removeMessages,
    removeQueuedTelegramTurnsByMessageIds:
      deps.queueMutationRuntime.removeByMessageIds,
    clearQueuedTelegramTurnPriorityByMessageId:
      deps.queueMutationRuntime.clearPriorityByMessageId,
    prioritizeQueuedTelegramTurnByMessageId:
      deps.queueMutationRuntime.prioritizeByMessageId,
    answerCallbackQuery: deps.answerCallbackQuery,
    handleAuthorizedTelegramCallbackQuery: callbackHandler,
    sendTextReply: deps.sendTextReply,
    handleAuthorizedTelegramMessage: mediaDispatch.handleMessage,
    handleAuthorizedTelegramEditedMessage: editRuntime.updateFromEditedMessage,
  });
}
