/**
 * Telegram bridge extension entrypoint and orchestration layer
 * Zones: telegram, pi agent, orchestration
 * Keeps the runtime wiring in one place while delegating reusable domain logic to /lib modules
 */

import * as Api from "./lib/api.ts";
import * as CommandTemplates from "./lib/command-templates.ts";
import * as Commands from "./lib/commands.ts";
import * as Config from "./lib/config.ts";
import {
  createTelegramExtensionSectionRegistry,
  setGlobalTelegramSectionRegistry,
  type TelegramSectionRegistry,
} from "./lib/extension-sections.ts";
import { createTelegramExternalHandleUpdate } from "./lib/external-handlers.ts";
import * as InboundHandlers from "./lib/inbound-handlers.ts";
import * as Keyboard from "./lib/keyboard.ts";
import * as Lifecycle from "./lib/lifecycle.ts";
import * as Locks from "./lib/locks.ts";
import * as Media from "./lib/media.ts";
import * as MenuQueue from "./lib/menu-queue.ts";
import * as MenuSettings from "./lib/menu-settings.ts";
import * as Menu from "./lib/menu.ts";
import * as Model from "./lib/model.ts";
import * as OutboundAttachments from "./lib/outbound-attachments.ts";
import * as OutboundHandlers from "./lib/outbound-handlers.ts";
import * as Pi from "./lib/pi.ts";
import * as Polling from "./lib/polling.ts";
import * as Preview from "./lib/preview.ts";
import * as PromptTemplates from "./lib/prompt-templates.ts";
import * as Prompts from "./lib/prompts.ts";
import * as Queue from "./lib/queue.ts";
import * as Replies from "./lib/replies.ts";
import * as Routing from "./lib/routing.ts";
import * as Runtime from "./lib/runtime.ts";
import * as Setup from "./lib/setup.ts";
import * as Status from "./lib/status.ts";
import * as TextGroups from "./lib/text-groups.ts";

type ActivePiModel = NonNullable<Pi.ExtensionContext["model"]>;
type RuntimeTelegramQueueItem = Queue.TelegramQueueItem<Pi.ExtensionContext>;

// --- Extension Runtime ---

export default function (pi: Pi.ExtensionAPI) {
  const piRuntime = Pi.createExtensionApiRuntimePorts(pi);
  const {
    getCommands,
    getThinkingLevel,
    sendUserMessage,
    setModel,
    setThinkingLevel,
  } = piRuntime;
  const bridgeRuntime = Runtime.createTelegramBridgeRuntime();
  const { abort, lifecycle, queue, setup, typing } = bridgeRuntime;
  const configStore = Config.createTelegramConfigStore();
  const isProactivePushEnabled =
    Config.createTelegramProactivePushChecker(configStore);
  const setProactivePushEnabled =
    Config.createTelegramProactivePushSetter(configStore);
  const lockRuntime = Locks.createTelegramLockRuntime<Pi.ExtensionContext>();
  const lockOwnershipGuard =
    Locks.createTelegramLockOwnershipGuard(lockRuntime);
  const activeTurnRuntime = Queue.createTelegramActiveTurnStore();
  const proactivePushChatIdGetter =
    Config.createTelegramProactivePushChatIdGetter({
      getActiveTurnChatId: activeTurnRuntime.getChatId,
      getAllowedUserId: configStore.getAllowedUserId,
    });
  const buttonActionStore = OutboundHandlers.createTelegramButtonActionStore();
  const pendingModelSwitchStore =
    Model.createPendingModelSwitchStore<
      Model.ScopedTelegramModel<ActivePiModel>
    >();
  const modelMenuRuntime = Menu.createTelegramModelMenuRuntime<ActivePiModel>();
  const sectionRegistry: TelegramSectionRegistry =
    createTelegramExtensionSectionRegistry();
  setGlobalTelegramSectionRegistry(sectionRegistry);
  const runtimeEvents = Status.createTelegramRuntimeEventRecorder({
    getBotToken: configStore.getBotToken,
  });
  const recordRuntimeEvent = runtimeEvents.record;
  const getContextModel = Pi.getExtensionContextModel;
  const isIdle = Pi.isExtensionContextIdle;
  const hasPendingMessages = Pi.hasExtensionContextPendingMessages;
  const compact = Pi.compactExtensionContext;
  const mediaGroupRuntime = Media.createTelegramMediaGroupController<
    Api.TelegramMessage,
    Pi.ExtensionContext
  >();
  const textGroupRuntime = TextGroups.createTelegramTextGroupController<
    Api.TelegramMessage,
    Pi.ExtensionContext
  >();
  const telegramQueueStore =
    Queue.createTelegramQueueStore<Pi.ExtensionContext>();
  const deferredQueueDispatchRuntime =
    Queue.createTelegramDeferredQueueDispatchRuntime<Pi.ExtensionContext>({
      recordRuntimeEvent,
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
      hasDispatchPending: lifecycle.hasDispatchPending,
      isCompactionInProgress: lifecycle.isCompactionInProgress,
      getActiveToolExecutions: lifecycle.getActiveToolExecutions,
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
    getContextModel,
    updateStatus,
  });
  const queueMutationRuntime =
    Queue.createTelegramQueueMutationController<Pi.ExtensionContext>({
      ...telegramQueueStore,
      getNextPriorityReactionOrder: queue.getNextPriorityReactionOrder,
      incrementNextPriorityReactionOrder:
        queue.incrementNextPriorityReactionOrder,
      updateStatus,
    });
  const inboundHandlerRuntime =
    InboundHandlers.createTelegramInboundHandlerRuntime<Pi.ExtensionContext>({
      getHandlers: configStore.getInboundHandlers,
      execCommand: CommandTemplates.execCommandTemplate,
      getCwd: Pi.getExtensionContextCwd,
      recordRuntimeEvent,
    });

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
    answerGuestQuery,
    deleteMessage: deleteTelegramMessage,
    prepareTempDir,
  } = Api.createDefaultTelegramBridgeApiRuntime({
    getBotToken: configStore.getBotToken,
    recordRuntimeEvent,
  });

  // --- Message Delivery & Preview ---

  const sendGuestReply = Replies.createGuestMarkdownReplySender({
    renderTelegramMessage: Replies.renderTelegramMessage,
    answerGuestQuery,
  });

  const promptDispatchRuntime =
    Runtime.createTelegramPromptDispatchRuntime<Pi.ExtensionContext>({
      lifecycle,
      typing,
      getDefaultChatId: activeTurnRuntime.getChatId,
      sendTypingAction,
      updateStatus,
      recordRuntimeEvent,
    });

  // --- Reply Runtime Wiring ---

  const replyRuntime =
    Replies.createTelegramRenderedMessageDeliveryRuntime<Keyboard.TelegramInlineKeyboardMarkup>(
      {
        sendMessage,
        editMessage: editTelegramMessageText,
      },
    );
  const { replyTransport, editInteractiveMessage, sendInteractiveMessage } =
    replyRuntime;
  const { sendTextReply, sendMarkdownReply } =
    OutboundHandlers.createTelegramOutboundTextReplyRuntime({
      sendTextReply: replyRuntime.sendTextReply,
      sendMarkdownReply: replyRuntime.sendMarkdownReply,
      execCommand: CommandTemplates.execCommandTemplate,
      getHandlers: configStore.getOutboundHandlers,
      recordRuntimeEvent,
    });
  const dispatchNextQueuedTelegramTurn =
    Queue.createTelegramQueueDispatchRuntime<Pi.ExtensionContext>({
      ...telegramQueueStore,
      isCompactionInProgress: lifecycle.isCompactionInProgress,
      hasActiveTurn: activeTurnRuntime.has,
      hasDispatchPending: lifecycle.hasDispatchPending,
      isIdle,
      hasPendingMessages,
      hasDispatchContext: deferredQueueDispatchRuntime.isBound,
      updateStatus,
      sendTextReply,
      recordRuntimeEvent,
      ...promptDispatchRuntime,
      sendUserMessage,
    }).dispatchNext;
  const previewRuntime = Preview.createTelegramAssistantPreviewRuntime<
    unknown,
    Keyboard.TelegramInlineKeyboardMarkup
  >({
    getActiveTurn: activeTurnRuntime.get,
    isAssistantMessage: Replies.isAssistantAgentMessage,
    getMessageText: Replies.getAgentMessageText,
    getDefaultReplyToMessageId: activeTurnRuntime.getReplyToMessageId,
    sendDraft: sendMessageDraft,
    sendMessage,
    editMessageText: editTelegramMessageText,
    canSend: lockOwnershipGuard.ownsCurrentProcess,
    recordRuntimeEvent,
    ...replyTransport,
  });
  const { finalizeMarkdownPreview } =
    OutboundHandlers.createTelegramOutboundTextPreviewRuntime({
      finalizeMarkdownPreview: previewRuntime.finalizeMarkdown,
      execCommand: CommandTemplates.execCommandTemplate,
      getHandlers: configStore.getOutboundHandlers,
      recordRuntimeEvent,
    });

  // --- Bridge Setup ---

  const modelSwitchController =
    Model.createTelegramModelSwitchControllerRuntime<
      Pi.ExtensionContext,
      Model.ScopedTelegramModel<ActivePiModel>
    >({
      isIdle,
      getPendingModelSwitch: pendingModelSwitchStore.get,
      setPendingModelSwitch: pendingModelSwitchStore.set,
      getActiveTurn: activeTurnRuntime.get,
      getAbortHandler: abort.getHandler,
      hasAbortHandler: abort.hasHandler,
      getActiveToolExecutions: lifecycle.getActiveToolExecutions,
      allocateItemOrder: queue.allocateItemOrder,
      allocateControlOrder: queue.allocateControlOrder,
      appendQueuedItem: queueMutationRuntime.append,
      updateStatus,
    });
  const getQueueItemCount =
    Queue.createTelegramQueueItemCountGetter(telegramQueueStore);
  const getPromptTemplateCommands =
    PromptTemplates.createTelegramPromptTemplateCommandGetter({
      getCommands,
      reservedCommandNames: Commands.TELEGRAM_RESERVED_COMMAND_NAMES,
    });
  const menuActions = Menu.createTelegramMenuActionRuntimeWithStateBuilder<
    ActivePiModel,
    Pi.ExtensionContext
  >({
    runtime: modelMenuRuntime,
    createSettingsManager: Pi.createSettingsManager,
    getActiveModel: currentModelRuntime.get,
    getThinkingLevel,
    getQueueItemCount,
    buildStatusHtml: Commands.createTelegramAppMenuHtmlBuilder({
      buildStatusHtml: Status.createTelegramStatusHtmlBuilder({
        getActiveModel: currentModelRuntime.get,
        isCompactionInProgress: lifecycle.isCompactionInProgress,
      }),
      getPromptTemplateCommands,
    }),
    storeModelMenuState: modelMenuRuntime.storeState,
    isIdle,
    canOfferInFlightModelSwitch: modelSwitchController.canOfferInFlightSwitch,
    sendTextReply,
    editInteractiveMessage,
    sendInteractiveMessage,
    sectionRegistry,
  });

  // --- Queue Menu ---

  const getQueueMenuState = Menu.createTelegramModelMenuStateBuilder({
    runtime: modelMenuRuntime,
    createSettingsManager: Pi.createSettingsManager,
    getActiveModel: currentModelRuntime.get,
  });
  const queueMenuRuntime = MenuQueue.createTelegramQueueMenuRuntime({
    telegramQueueStore,
    queueMutationRuntime,
    sendInteractiveMessage,
    editInteractiveMessage,
    answerCallbackQuery,
    getModelMenuState: getQueueMenuState,
    getStoredModelMenuState: modelMenuRuntime.getState,
    storeModelMenuState: modelMenuRuntime.storeState,
    updateStatusMessage: menuActions.updateStatusMessage,
    updateStatus,
  });
  const settingsMenuRuntime = MenuSettings.createTelegramSettingsMenuRuntime(
    {
      getModelMenuState: getQueueMenuState,
      getStoredModelMenuState: modelMenuRuntime.getState,
      storeModelMenuState: modelMenuRuntime.storeState,
      editInteractiveMessage,
      sendInteractiveMessage,
      answerCallbackQuery,
      isProactivePushEnabled,
      setProactivePushEnabled,
    },
    sectionRegistry,
  );

  // --- Polling ---

  const inboundRouteRuntime = Routing.createTelegramInboundRouteRuntime<
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
    textGroupRuntime,
    telegramQueueStore,
    queueMutationRuntime,
    modelMenuRuntime,
    currentModelRuntime,
    modelSwitchController,
    menuActions,
    updateSettingsMenuMessage: settingsMenuRuntime.updateSettingsMenuMessage,
    openQueueMenu: queueMenuRuntime.openQueueMenu,
    queueMenuCallbackHandler: queueMenuRuntime.handleCallbackQuery,
    openSettingsMenu: settingsMenuRuntime.openSettingsMenu,
    settingsMenuCallbackHandler: settingsMenuRuntime.handleCallbackQuery,
    sectionRegistry,
    buttonActionStore,
    inboundHandlerRuntime,
    updateStatus,
    dispatchNextQueuedTelegramTurn,
    requestDeferredDispatchNextQueuedTelegramTurn:
      deferredQueueDispatchRuntime.request,
    startTypingLoop: promptDispatchRuntime.startTypingLoop,
    stopTypingLoop: typing.stop,
    answerCallbackQuery,
    editInteractiveMessage,
    sendInteractiveMessage,
    deleteMessage: deleteTelegramMessage,
    answerGuestQuery,
    sendTextReply,
    setMyCommands,
    getCommands,
    downloadFile: downloadTelegramBridgeFile,
    getThinkingLevel,
    setThinkingLevel,
    persistScopedModelPatterns: Pi.createScopedModelPatternPersister({
      createSettingsManager: Pi.createSettingsManager,
      clearCachedModelMenuInputs: modelMenuRuntime.clearCachedInputs,
    }),
    setModel,
    sendUserMessage,
    isIdle,
    hasPendingMessages,
    compact,
    recordRuntimeEvent,
  });
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
    handleUpdate: createTelegramExternalHandleUpdate({
      defaultHandle: inboundRouteRuntime.handleUpdate,
    }),
    stopTypingLoop: typing.stop,
    updateStatus,
    recordRuntimeEvent,
  });
  const lockedPollingRuntime = Locks.createTelegramLockedPollingRuntime({
    lock: lockRuntime,
    hasBotToken: configStore.hasBotToken,
    startPolling: pollingRuntime.start,
    stopPolling: pollingRuntime.stop,
    updateStatus,
    recordRuntimeEvent,
  });
  const queueSessionLifecycle = Queue.createTelegramSessionLifecycleRuntime<
    Pi.ExtensionContext,
    RuntimeTelegramQueueItem,
    ActivePiModel
  >({
    getCurrentModel: getContextModel,
    loadConfig: configStore.load,
    setQueuedItems: telegramQueueStore.setQueuedItems,
    setCurrentModel: currentModelRuntime.set,
    setPendingModelSwitch: pendingModelSwitchStore.set,
    syncCounters: queue.syncCounters,
    syncFlags: lifecycle.syncFlags,
    bindDeferredDispatchContext: deferredQueueDispatchRuntime.bind,
    prepareTempDir,
    updateStatus,
    unbindDeferredDispatchContext: deferredQueueDispatchRuntime.unbind,
    clearPendingMediaGroups: TextGroups.createTelegramGroupedInputClearer({
      clearMediaGroups: mediaGroupRuntime.clear,
      clearTextGroups: textGroupRuntime.clear,
    }),
    clearModelMenuState: modelMenuRuntime.clear,
    getActiveTurnChatId: activeTurnRuntime.getChatId,
    clearPreview: previewRuntime.clear,
    clearActiveTurn: activeTurnRuntime.clear,
    clearAbort: abort.clearHandler,
    stopPolling: lockedPollingRuntime.suspend,
    recordRuntimeEvent,
  });
  const sessionLifecycleRuntime = Lifecycle.appendTelegramLifecycleHooks(
    queueSessionLifecycle,
    { onSessionStart: lockedPollingRuntime.onSessionStart },
  );

  // --- Extension API Bindings ---

  OutboundAttachments.registerTelegramOutboundAttachmentTool(pi, {
    getActiveTurn: activeTurnRuntime.get,
    recordRuntimeEvent,
  });

  Commands.registerTelegramBridgeCommands(pi, {
    promptForConfig: Setup.createTelegramSetupPromptRuntime({
      getConfig: configStore.get,
      setConfig: configStore.set,
      setupGuard: setup,
      getMe: Api.fetchTelegramBotIdentity,
      persistConfig: configStore.persist,
      startPolling: lockedPollingRuntime.start,
      updateStatus,
      recordRuntimeEvent,
    }),
    getStatusLines,
    reloadConfig: configStore.load,
    hasBotToken: configStore.hasBotToken,
    startPolling: lockedPollingRuntime.start,
    stopPolling: lockedPollingRuntime.stop,
    updateStatus,
  });

  // --- Lifecycle Hooks ---

  const agentEndResetter = Runtime.createTelegramAgentEndResetter({
    abort,
    typing,
    clearActiveTurn: activeTurnRuntime.clear,
    resetToolExecutions: lifecycle.resetActiveToolExecutions,
    clearPendingModelSwitch: modelSwitchController.clearPendingSwitch,
    clearDispatchPending: lifecycle.clearDispatchPending,
  });
  const queuedAttachmentSender =
    OutboundAttachments.createTelegramQueuedOutboundAttachmentSender({
      sendMultipart: callMultipart,
      sendTextReply,
      recordRuntimeEvent,
    });
  const outboundReplyPlanner =
    OutboundHandlers.createTelegramOutboundReplyPlanner(buttonActionStore);
  const outboundReplyArtifactSender =
    OutboundHandlers.createTelegramOutboundReplyArtifactSender({
      execCommand: CommandTemplates.execCommandTemplate,
      sendMultipart: callMultipart,
      sendTextReply,
      getHandlers: configStore.getOutboundHandlers,
      recordRuntimeEvent,
    });
  const agentLifecycleHooks = Queue.createTelegramAgentLifecycleHooks<
    Queue.PendingTelegramTurn,
    Pi.ExtensionContext,
    unknown,
    Keyboard.TelegramInlineKeyboardMarkup
  >({
    setAbortHandler: Runtime.createTelegramContextAbortHandlerSetter(abort),
    getQueuedItems: telegramQueueStore.getQueuedItems,
    hasPendingDispatch: lifecycle.hasDispatchPending,
    hasActiveTurn: activeTurnRuntime.has,
    resetToolExecutions: lifecycle.resetActiveToolExecutions,
    resetPendingModelSwitch: modelSwitchController.clearPendingSwitch,
    setQueuedItems: telegramQueueStore.setQueuedItems,
    clearDispatchPending: lifecycle.clearDispatchPending,
    setActiveTurn: activeTurnRuntime.set,
    createPreviewState: previewRuntime.resetState,
    startTypingLoop: promptDispatchRuntime.startTypingLoop,
    updateStatus,
    getActiveTurn: activeTurnRuntime.get,
    extractAssistant: Replies.extractLatestAssistantMessageText,
    getPreserveQueuedTurnsAsHistory:
      lifecycle.shouldPreserveQueuedTurnsAsHistory,
    resetRuntimeState: agentEndResetter,
    dispatchNextQueuedTelegramTurn,
    requestDeferredDispatchNextQueuedTelegramTurn:
      deferredQueueDispatchRuntime.request,
    clearPreview: previewRuntime.clear,
    setPreviewPendingText: previewRuntime.setPendingText,
    finalizeMarkdownPreview,
    sendMarkdownReply,
    sendTextReply,
    sendQueuedAttachments: queuedAttachmentSender,
    answerGuestQuery,
    sendGuestReply,
    planOutboundReply: outboundReplyPlanner,
    sendOutboundReplyArtifacts: outboundReplyArtifactSender,
    isCurrentOwner: lockOwnershipGuard.ownsContext,
    getDefaultChatId: proactivePushChatIdGetter,
    isProactivePushEnabled,
    recordRuntimeEvent,
    getActiveToolExecutions: lifecycle.getActiveToolExecutions,
    setActiveToolExecutions: lifecycle.setActiveToolExecutions,
    triggerPendingModelSwitchAbort: modelSwitchController.triggerPendingAbort,
  });
  // Wire transport-level reply dedup reset via lifecycle
  Lifecycle.setResetTransportReplyDedup(Replies.resetTransportReplyDedup);
  const agentStartWithDedupReset = Lifecycle.createAgentStartDedupHook(
    agentLifecycleHooks.onAgentStart,
  );
  Lifecycle.registerTelegramLifecycleHooks(pi, {
    ...sessionLifecycleRuntime,
    ...agentLifecycleHooks,
    onAgentStart: agentStartWithDedupReset,
    onBeforeAgentStart: Prompts.createTelegramProactiveBeforeAgentStartHook({
      isProactivePushEnabled,
      isCurrentOwner: lockOwnershipGuard.ownsContext,
    }),
    onModelSelect: currentModelRuntime.onModelSelect,
    onMessageStart: previewRuntime.onMessageStart,
    onMessageUpdate: previewRuntime.onMessageUpdate,
  });
}
