/**
 * Telegram bridge extension entrypoint and orchestration layer
 * Keeps the runtime wiring in one place while delegating reusable domain logic to /lib modules
 */

import * as Api from "./lib/api.ts";
import * as AttachmentHandlers from "./lib/attachment-handlers.ts";
import * as Attachments from "./lib/attachments.ts";
import * as Commands from "./lib/commands.ts";
import * as CommandTemplates from "./lib/command-templates.ts";
import * as Config from "./lib/config.ts";
import * as Lifecycle from "./lib/lifecycle.ts";
import * as Locks from "./lib/locks.ts";
import * as Media from "./lib/media.ts";
import * as Menu from "./lib/menu.ts";
import * as Model from "./lib/model.ts";
import * as Pi from "./lib/pi.ts";
import * as Polling from "./lib/polling.ts";
import * as Preview from "./lib/preview.ts";
import * as Prompts from "./lib/prompts.ts";
import * as Queue from "./lib/queue.ts";
import * as Replies from "./lib/replies.ts";
import * as Runtime from "./lib/runtime.ts";
import * as Routing from "./lib/routing.ts";
import * as Setup from "./lib/setup.ts";
import * as OutboundHandlers from "./lib/outbound-handlers.ts";
import * as Status from "./lib/status.ts";

type ActivePiModel = NonNullable<Pi.ExtensionContext["model"]>;
type RuntimeTelegramQueueItem = Queue.TelegramQueueItem<Pi.ExtensionContext>;

// --- Extension Runtime ---

export default function (pi: Pi.ExtensionAPI) {
  const piRuntime = Pi.createExtensionApiRuntimePorts(pi);
  const bridgeRuntime = Runtime.createTelegramBridgeRuntime();
  const configStore = Config.createTelegramConfigStore();
  const lockRuntime = Locks.createTelegramLockRuntime<Pi.ExtensionContext>();
  const activeTurnRuntime = Queue.createTelegramActiveTurnStore();
  const buttonActionStore = OutboundHandlers.createTelegramButtonActionStore();
  const pendingModelSwitchStore =
    Model.createPendingModelSwitchStore<
      Model.ScopedTelegramModel<ActivePiModel>
    >();
  const modelMenuRuntime = Menu.createTelegramModelMenuRuntime<ActivePiModel>();
  const runtimeEvents = Status.createTelegramRuntimeEventRecorder({
    getBotToken: configStore.getBotToken,
  });
  const mediaGroupRuntime = Media.createTelegramMediaGroupController<
    Api.TelegramMessage,
    Pi.ExtensionContext
  >();
  const telegramQueueStore =
    Queue.createTelegramQueueStore<Pi.ExtensionContext>();
  const deferredQueueDispatchRuntime =
    Queue.createTelegramDeferredQueueDispatchRuntime<Pi.ExtensionContext>({
      recordRuntimeEvent: runtimeEvents.record,
    });
  const pollingControllerState = Polling.createTelegramPollingControllerState();
  const { getStatusLines, updateStatus } =
    Status.createTelegramBridgeStatusRuntime<
      Pi.ExtensionContext,
      RuntimeTelegramQueueItem
    >({
      getConfig: configStore.get,
      isPollingActive: Polling.createTelegramPollingActivityReader(
        pollingControllerState,
      ),
      getActiveSourceMessageIds: activeTurnRuntime.getSourceMessageIds,
      hasActiveTurn: activeTurnRuntime.has,
      hasDispatchPending: bridgeRuntime.lifecycle.hasDispatchPending,
      isCompactionInProgress: bridgeRuntime.lifecycle.isCompactionInProgress,
      getActiveToolExecutions: bridgeRuntime.lifecycle.getActiveToolExecutions,
      hasPendingModelSwitch: pendingModelSwitchStore.has,
      getQueuedItems: telegramQueueStore.getQueuedItems,
      formatQueuedStatus: Queue.formatQueuedTelegramItemsStatus,
      getRecentRuntimeEvents: runtimeEvents.getEvents,
      getRuntimeLockState: lockRuntime.getStatusLabel,
    });
  const currentModelRuntime = Model.createCurrentModelRuntime<
    Pi.ExtensionContext,
    ActivePiModel
  >({
    getContextModel: Pi.getExtensionContextModel,
    updateStatus,
  });
  const queueMutationRuntime =
    Queue.createTelegramQueueMutationController<Pi.ExtensionContext>({
      ...telegramQueueStore,
      getNextPriorityReactionOrder:
        bridgeRuntime.queue.getNextPriorityReactionOrder,
      incrementNextPriorityReactionOrder:
        bridgeRuntime.queue.incrementNextPriorityReactionOrder,
      updateStatus,
    });
  const attachmentHandlerRuntime =
    AttachmentHandlers.createTelegramAttachmentHandlerRuntime<Pi.ExtensionContext>(
      {
        getHandlers: configStore.getAttachmentHandlers,
        execCommand: CommandTemplates.execCommandTemplate,
        getCwd: Pi.getExtensionContextCwd,
        recordRuntimeEvent: runtimeEvents.record,
      },
    );

  // --- Telegram API ---

  const {
    callMultipart,
    deleteWebhook,
    getUpdates,
    setMyCommands,
    sendTypingAction,
    sendMessageDraft,
    sendMessage,
    downloadFile: downloadTelegramBridgeFile,
    editMessageText: editTelegramMessageText,
    answerCallbackQuery,
    prepareTempDir,
  } = Api.createDefaultTelegramBridgeApiRuntime({
    getBotToken: configStore.getBotToken,
    recordRuntimeEvent: runtimeEvents.record,
  });

  // --- Message Delivery & Preview ---

  const promptDispatchRuntime =
    Runtime.createTelegramPromptDispatchRuntime<Pi.ExtensionContext>({
      lifecycle: bridgeRuntime.lifecycle,
      typing: bridgeRuntime.typing,
      getDefaultChatId: activeTurnRuntime.getChatId,
      sendTypingAction,
      updateStatus,
      recordRuntimeEvent: runtimeEvents.record,
    });

  // --- Reply Runtime Wiring ---

  const {
    replyTransport,
    sendTextReply,
    sendMarkdownReply,
    editInteractiveMessage,
    sendInteractiveMessage,
  } =
    Replies.createTelegramRenderedMessageDeliveryRuntime<Menu.TelegramReplyMarkup>(
      {
        sendMessage,
        editMessage: editTelegramMessageText,
      },
    );
  const dispatchNextQueuedTelegramTurn =
    Queue.createTelegramQueueDispatchRuntime<Pi.ExtensionContext>({
      ...telegramQueueStore,
      isCompactionInProgress: bridgeRuntime.lifecycle.isCompactionInProgress,
      hasActiveTurn: activeTurnRuntime.has,
      hasDispatchPending: bridgeRuntime.lifecycle.hasDispatchPending,
      isIdle: Pi.isExtensionContextIdle,
      hasPendingMessages: Pi.hasExtensionContextPendingMessages,
      hasDispatchContext: deferredQueueDispatchRuntime.isBound,
      updateStatus,
      sendTextReply,
      recordRuntimeEvent: runtimeEvents.record,
      ...promptDispatchRuntime,
      sendUserMessage: piRuntime.sendUserMessage,
    }).dispatchNext;
  const previewRuntime = Preview.createTelegramAssistantPreviewRuntime({
    getActiveTurn: activeTurnRuntime.get,
    isAssistantMessage: Replies.isAssistantAgentMessage,
    getMessageText: Replies.getAgentMessageText,
    getDefaultReplyToMessageId: activeTurnRuntime.getReplyToMessageId,
    sendDraft: sendMessageDraft,
    sendMessage,
    editMessageText: editTelegramMessageText,
    ...replyTransport,
  });

  // --- Bridge Setup ---

  const modelSwitchController =
    Model.createTelegramModelSwitchControllerRuntime<
      Pi.ExtensionContext,
      Model.ScopedTelegramModel<ActivePiModel>
    >({
      isIdle: Pi.isExtensionContextIdle,
      getPendingModelSwitch: pendingModelSwitchStore.get,
      setPendingModelSwitch: pendingModelSwitchStore.set,
      getActiveTurn: activeTurnRuntime.get,
      getAbortHandler: bridgeRuntime.abort.getHandler,
      hasAbortHandler: bridgeRuntime.abort.hasHandler,
      getActiveToolExecutions: bridgeRuntime.lifecycle.getActiveToolExecutions,
      allocateItemOrder: bridgeRuntime.queue.allocateItemOrder,
      allocateControlOrder: bridgeRuntime.queue.allocateControlOrder,
      appendQueuedItem: queueMutationRuntime.append,
      updateStatus,
    });
  const menuActions = Menu.createTelegramMenuActionRuntimeWithStateBuilder<
    ActivePiModel,
    Pi.ExtensionContext
  >({
    runtime: modelMenuRuntime,
    createSettingsManager: Pi.createSettingsManager,
    getActiveModel: currentModelRuntime.get,
    getThinkingLevel: piRuntime.getThinkingLevel,
    buildStatusHtml: Status.createTelegramStatusHtmlBuilder({
      getActiveModel: currentModelRuntime.get,
    }),
    storeModelMenuState: modelMenuRuntime.storeState,
    isIdle: Pi.isExtensionContextIdle,
    canOfferInFlightModelSwitch: modelSwitchController.canOfferInFlightSwitch,
    sendTextReply,
    editInteractiveMessage,
    sendInteractiveMessage,
  });

  // --- Polling ---

  const pollingRuntime = Polling.createTelegramPollingControllerRuntime<
    Api.TelegramUpdate,
    Pi.ExtensionContext
  >({
    state: pollingControllerState,
    getConfig: configStore.get,
    hasBotToken: configStore.hasBotToken,
    deleteWebhook,
    getUpdates,
    persistConfig: configStore.persist,
    handleUpdate: Routing.createTelegramInboundRouteRuntime<
      Api.TelegramUpdate,
      Api.TelegramMessage,
      Api.TelegramCallbackQuery,
      Pi.ExtensionContext,
      ActivePiModel
    >({
      configStore,
      bridgeRuntime,
      activeTurnRuntime,
      mediaGroupRuntime,
      telegramQueueStore,
      queueMutationRuntime,
      modelMenuRuntime,
      currentModelRuntime,
      modelSwitchController,
      menuActions,
      buttonActionStore,
      attachmentHandlerRuntime,
      updateStatus,
      dispatchNextQueuedTelegramTurn,
      answerCallbackQuery,
      sendTextReply,
      setMyCommands,
      downloadFile: downloadTelegramBridgeFile,
      getThinkingLevel: piRuntime.getThinkingLevel,
      setThinkingLevel: piRuntime.setThinkingLevel,
      setModel: piRuntime.setModel,
      isIdle: Pi.isExtensionContextIdle,
      hasPendingMessages: Pi.hasExtensionContextPendingMessages,
      compact: Pi.compactExtensionContext,
      recordRuntimeEvent: runtimeEvents.record,
    }).handleUpdate,
    stopTypingLoop: bridgeRuntime.typing.stop,
    updateStatus,
    recordRuntimeEvent: runtimeEvents.record,
  });
  const lockedPollingRuntime = Locks.createTelegramLockedPollingRuntime({
    lock: lockRuntime,
    hasBotToken: configStore.hasBotToken,
    startPolling: pollingRuntime.start,
    stopPolling: pollingRuntime.stop,
    updateStatus,
    recordRuntimeEvent: runtimeEvents.record,
  });
  const sessionLifecycleRuntime = Lifecycle.appendTelegramLifecycleHooks(
    Queue.createTelegramSessionLifecycleRuntime<
      Pi.ExtensionContext,
      RuntimeTelegramQueueItem,
      ActivePiModel
    >({
      getCurrentModel: Pi.getExtensionContextModel,
      loadConfig: configStore.load,
      setQueuedItems: telegramQueueStore.setQueuedItems,
      setCurrentModel: currentModelRuntime.set,
      setPendingModelSwitch: pendingModelSwitchStore.set,
      syncCounters: bridgeRuntime.queue.syncCounters,
      syncFlags: bridgeRuntime.lifecycle.syncFlags,
      bindDeferredDispatchContext: deferredQueueDispatchRuntime.bind,
      prepareTempDir,
      updateStatus,
      unbindDeferredDispatchContext: deferredQueueDispatchRuntime.unbind,
      clearPendingMediaGroups: mediaGroupRuntime.clear,
      clearModelMenuState: modelMenuRuntime.clear,
      getActiveTurnChatId: activeTurnRuntime.getChatId,
      clearPreview: previewRuntime.clear,
      clearActiveTurn: activeTurnRuntime.clear,
      clearAbort: bridgeRuntime.abort.clearHandler,
      stopPolling: lockedPollingRuntime.suspend,
      recordRuntimeEvent: runtimeEvents.record,
    }),
    { onSessionStart: lockedPollingRuntime.onSessionStart },
  );

  // --- Extension API Bindings ---

  Attachments.registerTelegramAttachmentTool(pi, {
    getActiveTurn: activeTurnRuntime.get,
    recordRuntimeEvent: runtimeEvents.record,
  });

  Commands.registerTelegramBridgeCommands(pi, {
    promptForConfig: Setup.createTelegramSetupPromptRuntime({
      getConfig: configStore.get,
      setConfig: configStore.set,
      setupGuard: bridgeRuntime.setup,
      getMe: Api.fetchTelegramBotIdentity,
      persistConfig: configStore.persist,
      startPolling: lockedPollingRuntime.start,
      updateStatus,
      recordRuntimeEvent: runtimeEvents.record,
    }),
    getStatusLines,
    reloadConfig: configStore.load,
    hasBotToken: configStore.hasBotToken,
    startPolling: lockedPollingRuntime.start,
    stopPolling: lockedPollingRuntime.stop,
    updateStatus,
  });

  // --- Lifecycle Hooks ---

  Lifecycle.registerTelegramLifecycleHooks(pi, {
    ...sessionLifecycleRuntime,
    onBeforeAgentStart: Prompts.createTelegramBeforeAgentStartHook(),
    onModelSelect: currentModelRuntime.onModelSelect,
    ...Queue.createTelegramAgentLifecycleHooks<
      Queue.PendingTelegramTurn,
      Pi.ExtensionContext,
      unknown
    >({
      setAbortHandler: Runtime.createTelegramContextAbortHandlerSetter(
        bridgeRuntime.abort,
      ),
      getQueuedItems: telegramQueueStore.getQueuedItems,
      hasPendingDispatch: bridgeRuntime.lifecycle.hasDispatchPending,
      hasActiveTurn: activeTurnRuntime.has,
      resetToolExecutions: bridgeRuntime.lifecycle.resetActiveToolExecutions,
      resetPendingModelSwitch: modelSwitchController.clearPendingSwitch,
      setQueuedItems: telegramQueueStore.setQueuedItems,
      clearDispatchPending: bridgeRuntime.lifecycle.clearDispatchPending,
      setActiveTurn: activeTurnRuntime.set,
      createPreviewState: previewRuntime.resetState,
      startTypingLoop: promptDispatchRuntime.startTypingLoop,
      updateStatus,
      getActiveTurn: activeTurnRuntime.get,
      extractAssistant: Replies.extractLatestAssistantMessageText,
      getPreserveQueuedTurnsAsHistory:
        bridgeRuntime.lifecycle.shouldPreserveQueuedTurnsAsHistory,
      resetRuntimeState: Runtime.createTelegramAgentEndResetter({
        abort: bridgeRuntime.abort,
        typing: bridgeRuntime.typing,
        clearActiveTurn: activeTurnRuntime.clear,
        resetToolExecutions: bridgeRuntime.lifecycle.resetActiveToolExecutions,
        clearPendingModelSwitch: modelSwitchController.clearPendingSwitch,
        clearDispatchPending: bridgeRuntime.lifecycle.clearDispatchPending,
      }),
      dispatchNextQueuedTelegramTurn,
      requestDeferredDispatchNextQueuedTelegramTurn:
        deferredQueueDispatchRuntime.request,
      clearPreview: previewRuntime.clear,
      setPreviewPendingText: previewRuntime.setPendingText,
      finalizeMarkdownPreview: previewRuntime.finalizeMarkdown,
      sendMarkdownReply,
      sendTextReply,
      sendQueuedAttachments: Attachments.createTelegramQueuedAttachmentSender({
        sendMultipart: callMultipart,
        sendTextReply,
        recordRuntimeEvent: runtimeEvents.record,
      }),
      planOutboundReply:
        OutboundHandlers.createTelegramOutboundReplyPlanner(buttonActionStore),
      sendOutboundReplyArtifacts:
        OutboundHandlers.createTelegramOutboundReplyArtifactSender({
          execCommand: CommandTemplates.execCommandTemplate,
          sendMultipart: callMultipart,
          sendTextReply,
          getHandlers: configStore.getOutboundHandlers,
          recordRuntimeEvent: runtimeEvents.record,
        }),
      getActiveToolExecutions: bridgeRuntime.lifecycle.getActiveToolExecutions,
      setActiveToolExecutions: bridgeRuntime.lifecycle.setActiveToolExecutions,
      triggerPendingModelSwitchAbort: modelSwitchController.triggerPendingAbort,
    }),
    onMessageStart: previewRuntime.onMessageStart,
    onMessageUpdate: previewRuntime.onMessageUpdate,
  });
}
