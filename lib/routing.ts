/**
 * Telegram inbound routing composition
 * Wires authorized updates into menus, commands, media grouping, and prompt queueing
 */

import * as OutboundHandlers from "./outbound-handlers.ts";
import * as Commands from "./commands.ts";
import type { TelegramConfigStore } from "./config.ts";
import type { TelegramAttachmentHandlerRuntime } from "./attachment-handlers.ts";
import * as Media from "./media.ts";
import * as Menu from "./menu.ts";
import * as Model from "./model.ts";
import type { PiExtensionApiRuntimePorts } from "./pi.ts";
import * as Queue from "./queue.ts";
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
  TUpdate extends Updates.TelegramUpdateFlow & {
    message?: TMessage;
    edited_message?: TMessage;
    callback_query?: TCallbackQuery;
  },
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
  downloadFile: Media.DownloadTelegramMessageFilesDeps["downloadFile"];
  getThinkingLevel: () => Model.ThinkingLevel;
  setThinkingLevel: (level: Model.ThinkingLevel) => void;
  setModel: (model: TModel) => Promise<boolean>;
  sendUserMessage?: PiExtensionApiRuntimePorts["sendUserMessage"];
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

/**
 * Prefixes of callback_data values handled by pi-telegram's built-in
 * model/thinking/status menus. Anything else falls through to the
 * button-action store, and finally (if still unmatched) is forwarded
 * to the agent via sendUserMessage so other extensions can react to
 * inline-button presses they registered themselves.
 */
const TELEGRAM_MENU_CALLBACK_PREFIXES = [
  "model:",
  "thinking:",
  "status:",
] as const;

function isTelegramMenuCallbackData(data: string | undefined): boolean {
  if (!data) return false;
  return TELEGRAM_MENU_CALLBACK_PREFIXES.some((prefix) =>
    data.startsWith(prefix),
  );
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
    TUpdate,
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
    // Forward unknown (non-menu, non-button-store) callback queries to other
    // extensions via sendUserMessage. Lets extensions register their own
    // inline buttons with arbitrary callback_data and react to user clicks.
    const data = query.data;
    if (
      deps.sendUserMessage &&
      typeof data === "string" &&
      data.length > 0 &&
      !isTelegramMenuCallbackData(data)
    ) {
      deps.sendUserMessage(`[callback] ${data}`);
      const callbackQueryId = query.id;
      if (typeof callbackQueryId === "string") {
        await deps.answerCallbackQuery(callbackQueryId);
      }
      return;
    }
    await menuCallbackHandler(query, ctx);
  };
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
    compact: deps.compact,
    allocateItemOrder: deps.bridgeRuntime.queue.allocateItemOrder,
    allocateControlOrder: deps.bridgeRuntime.queue.allocateControlOrder,
    appendControlItem: deps.queueMutationRuntime.append,
    showStatus: deps.menuActions.sendStatusMessage,
    openModelMenu: deps.menuActions.openModelMenu,
    getAllowedUserId: deps.configStore.getAllowedUserId,
    setAllowedUserId: deps.configStore.setAllowedUserId,
    setMyCommands: deps.setMyCommands,
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
    createTurn: Turns.createTelegramPromptTurnRuntimeBuilder<
      TMessage,
      TContext
    >({
      allocateQueueOrder: deps.bridgeRuntime.queue.allocateItemOrder,
      downloadFile: deps.downloadFile,
      processAttachments: deps.attachmentHandlerRuntime.process,
    }),
    updateStatus: deps.updateStatus,
    dispatchNextQueuedTelegramTurn: deps.dispatchNextQueuedTelegramTurn,
  }).enqueue;
  const commandOrPrompt = Commands.createTelegramCommandOrPromptRuntime<
    TMessage,
    TContext
  >({
    extractRawText: Media.extractFirstTelegramMessageText,
    handleCommand: commandHandler,
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
