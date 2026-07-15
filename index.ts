/**
 * Telegram bridge extension entrypoint and orchestration layer
 * Zones: telegram, pi agent, orchestration
 * Keeps the runtime wiring in one place while delegating reusable domain logic to /lib modules
 */

import * as Activity from "./lib/activity.ts";
import * as Bindings from "./lib/bindings.ts";
import * as BusApi from "./lib/bus-api.ts";
import * as Bus from "./lib/bus.ts";
import * as BusFollower from "./lib/bus-follower.ts";
import * as BusLeader from "./lib/bus-leader.ts";
import * as BusTransport from "./lib/bus-transport.ts";
import * as CommandTemplates from "./lib/command-templates.ts";
import * as Commands from "./lib/commands.ts";
import * as Config from "./lib/config.ts";
import * as Delivery from "./lib/delivery.ts";
import * as Threads from "./lib/threads.ts";
import * as Inbound from "./lib/inbound.ts";
import * as Lifecycle from "./lib/lifecycle.ts";
import * as Locks from "./lib/locks.ts";
import * as Media from "./lib/media.ts";
import * as MenuQueue from "./lib/menu-queue.ts";
import * as MenuSettings from "./lib/menu-settings.ts";
import * as Menu from "./lib/menu.ts";
import * as Model from "./lib/model.ts";
import * as Outbound from "./lib/outbound.ts";
import * as Ownership from "./lib/ownership.ts";
import * as Paths from "./lib/paths.ts";
import * as Pi from "./lib/pi.ts";
import * as Polling from "./lib/polling.ts";
import * as Preview from "./lib/preview.ts";
import * as PromptTemplates from "./lib/prompt-templates.ts";
import * as Queue from "./lib/queue.ts";
import * as Replies from "./lib/replies.ts";
import * as Routing from "./lib/routing.ts";
import * as Runtime from "./lib/runtime.ts";
import * as Logs from "./lib/logs.ts";
import * as Sections from "./lib/sections.ts";
import * as Status from "./lib/status.ts";
import * as Sync from "./lib/sync.ts";
import * as TelegramApi from "./lib/telegram-api.ts";
import * as TextGroups from "./lib/text-groups.ts";
import * as ThreadReconciler from "./lib/thread-reconciler.ts";
import * as TimeInjection from "./lib/time-injection.ts";
import * as Updates from "./lib/updates.ts";
import * as Voice from "./lib/voice.ts";

type ActivePiModel = NonNullable<Pi.ExtensionContext["model"]>;

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
  const getActiveTelegramThreadProfile = function (): string | undefined {
    return configStore.getActiveProfileName();
  };
  const busProcessRuntime = Bus.createTelegramBusProcessRuntime({
    getActiveProfileName: getActiveTelegramThreadProfile,
    pid: process.pid,
    parentPid: process.ppid,
    createdAtMs: Date.now(),
  });
  const {
    instanceId: telegramInstanceId,
    manualFollowerOwnerId: telegramManualFollowerOwnerId,
    getLeaderSocketPath: getTelegramBusSocketPath,
    getFollowerSocketPath: getTelegramBusFollowerSocketPath,
  } = busProcessRuntime;
  const getTelegramManualFollowerProfileKey =
    BusFollower.createTelegramManualFollowerProfileKeyResolver({
      getActiveProfileName: getActiveTelegramThreadProfile,
      manualFollowerOwnerId: telegramManualFollowerOwnerId,
    });
  const telegramBusAuthSecret = Bus.createTelegramBusAuthSecret();
  let telegramActiveBusAuthSecret: string | undefined;
  let telegramBusLifecycleOverridePhase:
    Status.TelegramBridgeBusLifecyclePhase | undefined;
  const telegramBusFollowerRegistry = Bus.createTelegramBusFollowerRegistry();
  const telegramBusFollowerRegistrationState =
    BusFollower.createTelegramBusFollowerRegistrationState();
  const telegramBusLeaderState =
    Threads.createTelegramLeaderThreadStateRuntime();
  const telegramThreadCapabilityState =
    Polling.createTelegramThreadCapabilityStateRuntime();
  const telegramProvisioningActivity =
    Sync.createTelegramProvisioningActivityRuntime();
  const messageOwnershipRuntime =
    Ownership.createTelegramBusMessageOwnershipRuntime({
      instanceId: telegramInstanceId,
      getProfileKey() {
        return getActiveTelegramThreadProfile() ?? "default";
      },
      listFollowers: telegramBusFollowerRegistry.list,
    });
  const { abort, lifecycle, queue, setup, typing } = bridgeRuntime;
  const runtimeDiagnostics =
    Logs.createTelegramRuntimeDiagnosticsRuntime<Pi.ExtensionContext>();
  const runtimeEvents = runtimeDiagnostics.events;
  const recordRuntimeEvent = runtimeDiagnostics.recordRuntimeEvent;
  const configStore = Config.createTelegramConfigStore({ recordRuntimeEvent });
  const isTelegramBusConfigured = function (): boolean {
    return true;
  };
  const isTelegramBusRuntimeEnabled = function (): boolean {
    return (
      isTelegramBusConfigured() &&
      !telegramThreadCapabilityState.isTopicModeUnavailable()
    );
  };
  Config.bindGlobalTelegramConfigRuntime(configStore);
  const configControls = Config.createTelegramConfigControls(configStore);
  const lockRuntime = Locks.createTelegramLockRuntime<Pi.ExtensionContext>({
    key: Locks.createTelegramLockKeyResolver(configStore),
    instanceId: telegramInstanceId,
    busSecret: telegramBusAuthSecret,
    staleHeartbeatMs: Locks.TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS,
  });
  const threadStore = Threads.createTelegramTopicTargetStore({
    path: function () {
      return Threads.getTelegramTopicTargetsPath(
        undefined,
        configStore.getActiveProfileName(),
      );
    },
    canPersist: lockRuntime.owns,
    commitPersist: lockRuntime.commitIfOwned,
  });
  runtimeDiagnostics.bindStorage({
    getBotToken: configStore.getBotToken,
    getProfileName: configStore.getActiveProfileName,
    canReset: lockRuntime.owns,
    commitReset: lockRuntime.commitIfOwned,
  });
  const lockOwnershipGuard =
    Locks.createTelegramLockOwnershipGuard(lockRuntime);
  const getCurrentLeaderEpoch = lockRuntime.getOwnedLeaderEpoch;
  const telegramSessionContextStore =
    Lifecycle.createTelegramSessionContextStore<Pi.ExtensionContext>({
      getIdentity(ctx) {
        return ctx.sessionManager ?? ctx.cwd;
      },
    });
  const ownsTelegramDirectDelivery =
    Locks.createTelegramDirectDeliveryOwnershipChecker({
      lock: lockRuntime,
      contextStore: telegramSessionContextStore,
    });
  const activeTurnRuntime = Queue.createTelegramActiveTurnStore();
  const proactivePushChatIdGetter =
    Config.createTelegramProactivePushChatIdGetter({
      getActiveTurnChatId: activeTurnRuntime.getChatId,
      getAllowedUserId: configStore.getAllowedUserId,
    });
  const proactivePushTargetGetter =
    Config.createTelegramProactivePushTargetGetter({
      getActiveTurnTarget: activeTurnRuntime.getTarget,
      getAssignedTarget() {
        return (
          telegramBusFollowerRegistrationState.getTarget() ??
          telegramBusLeaderState.getTarget()
        );
      },
      getAllowedUserId: configStore.getAllowedUserId,
    });
  const buttonActionStore = Outbound.createTelegramButtonActionStore();
  const pendingModelSwitchStore =
    Model.createPendingModelSwitchStore<
      Model.ScopedTelegramModel<ActivePiModel>
    >();
  const modelMenuRuntime = Menu.createTelegramModelMenuRuntime<ActivePiModel>();
  const sectionRegistry = Sections.createAndBindTelegramSectionRegistry();

  const timeInjectionRuntime = TimeInjection.createTimeInjectionRuntime({
    getConfig: Config.createTelegramTimeConfigGetter(configStore),
    recordRuntimeEvent,
  });
  Outbound.bindTelegramRuntimeEventRecorder(recordRuntimeEvent);
  const getContextModel = Pi.getExtensionContextModel;
  const isIdle = Pi.isExtensionContextIdle;
  const hasPendingMessages = Pi.hasExtensionContextPendingMessages;
  const compact = Pi.compactExtensionContext;
  const mediaGroupRuntime = Media.createTelegramMediaGroupController<
    TelegramApi.TelegramMessage,
    Pi.ExtensionContext
  >();
  const textGroupRuntime = TextGroups.createTelegramTextGroupController<
    TelegramApi.TelegramMessage,
    Pi.ExtensionContext
  >();
  const rawTelegramQueueStore =
    Queue.createTelegramQueueStore<Pi.ExtensionContext>();
  const telegramTransportStampRuntime =
    Queue.createTelegramTransportStampRuntime({
      getProfileName: configStore.getActiveProfileName,
      getBotToken: configStore.getBotToken,
    });
  const telegramQueueStore = Queue.createTelegramTransportStampedQueueStore(
    rawTelegramQueueStore,
    telegramTransportStampRuntime.getStamp,
  );
  const deferredQueueDispatchRuntime =
    Queue.createTelegramDeferredQueueDispatchRuntime<Pi.ExtensionContext>({
      delayMs: 50,
      recordRuntimeEvent,
    });
  const pollingControllerState = Polling.createTelegramPollingControllerState();
  const telegramSyncStateRuntime = Sync.createTelegramSyncStateRuntime();
  const threadReconciliationRuntime =
    ThreadReconciler.createThreadReconciliationRuntime({
      recordRuntimeEvent,
      scheduleSnapshotPersist: runtimeDiagnostics.scheduleSnapshotPersist,
    });
  const recordThreadReconciliationPlan = threadReconciliationRuntime.recordPlan;
  const persistTelegramConfigWithSync =
    Sync.createTelegramConfigSyncPersister<Config.TelegramConfig>({
      persist: configStore.persist,
      markConfigChange: telegramSyncStateRuntime.markConfigChange,
    });
  const currentInstanceThreadRuntime =
    Threads.createTelegramCurrentInstanceThreadRuntime({
      instanceId: telegramInstanceId,
      listRecords: threadStore.list,
      getPreferredTarget() {
        return (
          activeTurnRuntime.getTarget() ??
          telegramBusFollowerRegistrationState.getTarget() ??
          telegramBusLeaderState.getTarget()
        );
      },
      getFollower() {
        const target = telegramBusFollowerRegistrationState.getTarget();
        if (!target) return undefined;
        return {
          registered: telegramBusFollowerRegistrationState.isRegistered(),
          target,
          slot: telegramBusFollowerRegistrationState.getSlot(),
          threadName: telegramBusFollowerRegistrationState.getThreadName(),
        };
      },
      getLeader: telegramBusLeaderState.getIdentity,
    });
  const findCurrentThreadRecord = currentInstanceThreadRuntime.findRecord;
  const getCurrentInstanceThreadIdentity =
    currentInstanceThreadRuntime.getIdentity;
  const threadStatusProjectionRuntime =
    Threads.createTelegramThreadStatusProjectionRuntime({
      getThreadMode: function () {
        return threadStore.getBotState().threadMode;
      },
      isBusPollingStarted: telegramThreadCapabilityState.isBusPollingStarted,
      isFollowerRegistered: telegramBusFollowerRegistrationState.isRegistered,
      listFollowers: telegramBusFollowerRegistry.list,
      listRecords: threadStore.list,
      listReservations: threadStore.listReservations,
      listSyncObservations: threadStore.listSyncObservations,
      getLeaderSocketPath: getTelegramBusSocketPath,
      getFollowerSocketPath: getTelegramBusFollowerSocketPath,
      getTransportKind: BusTransport.getTelegramBusTransportKind,
      getFollowerTarget: telegramBusFollowerRegistrationState.getTarget,
      getFollowerSlot: telegramBusFollowerRegistrationState.getSlot,
      getFollowerThreadName: telegramBusFollowerRegistrationState.getThreadName,
      getCurrentIdentity: currentInstanceThreadRuntime.getRestorationIdentity,
    });
  const statusRuntime = Status.createTelegramBridgeStatusRuntime<
    Pi.ExtensionContext,
    Queue.TelegramQueueItem<Pi.ExtensionContext>
  >({
    getConfig: configStore.get,
    getActiveProfileName: configStore.getActiveProfileName,
    getDiagnosticPaths: Paths.getTelegramDiagnosticsDisplayPaths,
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
    ...threadStatusProjectionRuntime,
    getBusLifecyclePhase() {
      return telegramBusLifecycleOverridePhase;
    },
    getBotThreadMode() {
      return threadStore.getBotState();
    },
    getSyncState: telegramSyncStateRuntime.getState,
    getThreadReconciliationState() {
      return threadReconciliationRuntime.getState();
    },
  });
  runtimeDiagnostics.bindStatus({
    instanceId: telegramInstanceId,
    updateStatus: statusRuntime.updateStatus,
    getStatusState: statusRuntime.getStatusState,
    async persistSnapshot(snapshot) {
      threadStore.setStatusSnapshot(snapshot);
      await threadStore.persist();
    },
  });
  const updateStatus = runtimeDiagnostics.updateStatus;
  const getStatusLines = runtimeDiagnostics.getStatusLines;
  const inboundHandlerRuntime = Inbound.createTelegramInboundHandlerRuntime({
    getHandlers: configStore.getInboundHandlers,
    execCommand: CommandTemplates.execCommandTemplate,
    getCwd: Pi.getExtensionContextCwd,
    recordRuntimeEvent,
  });

  // --- Telegram API ---

  const directTelegramApiRuntime =
    TelegramApi.createDefaultTelegramBridgeApiRuntime({
      getBotToken: configStore.getBotToken,
      recordRuntimeEvent,
    });
  const telegramBusFollowerClients =
    BusFollower.createTelegramBusFollowerClientRuntime<
      Pi.ExtensionContext,
      Updates.TelegramMessageReactionUpdated,
      Routing.TelegramRoutedCallbackQuery,
      Routing.TelegramRoutedMessage
    >({
      socketPath: getTelegramBusSocketPath,
      instanceId: telegramInstanceId,
      getApiAuthSecret() {
        return telegramActiveBusAuthSecret;
      },
      getForwardingAuthSecret() {
        return telegramBusAuthSecret;
      },
      getRegistrationGeneration:
        telegramBusFollowerRegistrationState.getGeneration,
      getForwardCommentBatchPosition:
        textGroupRuntime.getPreparedForwardingPosition,
      recordRuntimeEvent,
      timeoutMs: 30_000,
    });
  const telegramApiRuntime = BusApi.createTelegramBusAwareApiRuntime({
    directRuntime: directTelegramApiRuntime,
    ownsDirect() {
      return lockRuntime.owns();
    },
    getDefaultTarget: proactivePushTargetGetter,
    callFollowerApi: telegramBusFollowerClients.callApi,
  });
  const {
    call: callTelegramApi,
    callMultipart,
    deleteWebhook,
    getUpdates,
    setMyCommands,
    sendTypingAction,
    sendChatAction,
    sendRecordVoiceAction,
    sendMessageDraft,
    sendMessage,
    sendRichMessage,
    sendRichMessageDraft,
    downloadFile: downloadTelegramBridgeFile,
    editMessageText: editTelegramMessageText,
    answerCallbackQuery,
    answerGuestQuery,
    deleteMessage: deleteTelegramMessage,
    prepareTempDir,
  } = telegramApiRuntime;

  // --- Message Delivery ---

  const sendGuestReply = Replies.createGuestMarkdownReplySender({
    answerGuestQuery,
  });

  const promptDispatchRuntime = Runtime.createTelegramPromptDispatchRuntime({
    lifecycle,
    typing,
    getDefaultChatId: proactivePushChatIdGetter,
    sendTypingAction,
    sendAggregateTypingAction:
      BusApi.createTelegramAggregateTypingActionSender(telegramApiRuntime),
    updateStatus,
    recordRuntimeEvent,
  });
  const currentModelRuntime = Model.createCurrentModelRuntime({
    getContextModel,
    updateStatus,
  });
  const queueMutationRuntime = Queue.createTelegramQueueMutationController({
    ...telegramQueueStore,
    getNextPriorityReactionOrder: queue.getNextPriorityReactionOrder,
    incrementNextPriorityReactionOrder:
      queue.incrementNextPriorityReactionOrder,
    updateStatus,
  });

  // --- Reply Runtime & Preview ---

  const replyRuntime = Replies.createTelegramRenderedMessageDeliveryRuntime({
    recordOwnership: messageOwnershipRuntime.recordLocal,
    sendMessage,
    sendRichMessage,
    getAssistantRenderingMode: configControls.getAssistantRenderingMode,
    editMessage: editTelegramMessageText,
  });
  const { replyTransport, editInteractiveMessage, sendInteractiveMessage } =
    replyRuntime;
  const deliveryTargetPolicyRuntime =
    Delivery.createTelegramDeliveryTargetPolicyRuntime({
      ownsDirect: lockRuntime.owns,
      isFollowerRegistered: telegramBusFollowerRegistrationState.isRegistered,
      getAllowedChatId: configStore.getAllowedUserId,
      getFollowerTarget: telegramBusFollowerRegistrationState.getTarget,
      getLeaderTarget: telegramBusLeaderState.getTarget,
      listThreadRecords: threadStore.list,
      getActiveTurnTarget: activeTurnRuntime.getTarget,
      getActiveGuestQueryId: activeTurnRuntime.getGuestQueryId,
    });
  const deliveryGenerationSeed = `${telegramInstanceId}:${Date.now()}`;
  const deliveryLifecycleRuntime =
    Delivery.createTelegramBridgeDeliveryLifecycleHooks({
      generationSeed: deliveryGenerationSeed,
      getTargetPolicyView: deliveryTargetPolicyRuntime.getTargetPolicyView,
      getTransportStamp: telegramTransportStampRuntime.getStamp,
      isTransportStampActive: telegramTransportStampRuntime.isActive,
      getActiveTurnTarget: deliveryTargetPolicyRuntime.getActiveTurnTarget,
      api: telegramApiRuntime,
      recordOwnership: messageOwnershipRuntime.recordLocal,
      recordFailure(operation, error, target) {
        recordRuntimeEvent("delivery", error, {
          operation,
          scope: target?.threadId === undefined ? "aggregate" : "thread",
        });
      },
    });
  const { sendTextReply, sendMarkdownReply } =
    Outbound.createTelegramOutboundTextReplyRuntime({
      sendTextReply: replyRuntime.sendTextReply,
      sendMarkdownReply: replyRuntime.sendMarkdownReply,
      execCommand: CommandTemplates.execCommandTemplate,
      getHandlers: configStore.getOutboundHandlers,
      recordRuntimeEvent,
    });
  const assistantOutputBindingRuntime =
    Bindings.createTelegramAssistantOutputBindingRuntime({
      isEnabled: configControls.isProactivePushEnabled,
      authority: {
        getPreferredTarget: proactivePushTargetGetter,
        getFallbackChatId: proactivePushChatIdGetter,
        getTransportStamp: telegramTransportStampRuntime.getStamp,
        isTransportStampActive: telegramTransportStampRuntime.isActive,
        ownsDirect: lockRuntime.owns,
        getDirectEpoch: lockRuntime.getOwnedLeaderEpoch,
        isFollowerRegistered:
          telegramBusFollowerRegistrationState.isRegistered,
        getFollowerGeneration:
          telegramBusFollowerRegistrationState.getGeneration,
      },
      sender: {
        recordOwnership: messageOwnershipRuntime.recordLocal,
        sendMessage,
        sendRichMessage,
        editMessage: editTelegramMessageText,
        getAssistantRenderingMode: configControls.getAssistantRenderingMode,
        execCommand: CommandTemplates.execCommandTemplate,
        getHandlers: configStore.getOutboundHandlers,
        recordRuntimeEvent,
      },
      recordRuntimeEvent,
    });
  const assistantOutputRuntime = assistantOutputBindingRuntime.runtime;
  const activityRuntime = Activity.createTelegramActivityBridgeRuntime({
    generation: deliveryGenerationSeed,
    observeEvent: assistantOutputBindingRuntime.observeEvent,
    recordFailure(handlerId, event, error) {
      recordRuntimeEvent("activity", error, {
        handlerId,
        eventType: event.type,
        activityId: event.activityId,
      });
    },
  });
  const dispatchNextQueuedTelegramTurn =
    Queue.createTelegramQueueDispatchRuntime({
      ...telegramQueueStore,
      isCompactionInProgress: lifecycle.isCompactionInProgress,
      hasActiveTurn: activeTurnRuntime.has,
      hasDispatchPending: lifecycle.hasDispatchPending,
      isIdle,
      hasPendingMessages,
      hasDispatchContext: deferredQueueDispatchRuntime.isBound,
      isQueueItemTransportActive(item) {
        return telegramTransportStampRuntime.isActive(item.transportStamp);
      },
      updateStatus,
      sendTextReply,
      recordRuntimeEvent,
      ...promptDispatchRuntime,
      sendUserMessage,
    }).dispatchNext;
  const queueDispatchWatchdogRuntime =
    Queue.createTelegramQueueDispatchWatchdogRuntime({
      hasQueuedItems: telegramQueueStore.hasQueuedItems,
      dispatchNextQueuedTelegramTurn,
      recordRuntimeEvent,
    });
  const nativeMarkdownDraftSender =
    TelegramApi.createTelegramAssistantDraftSender({
      getAssistantRenderingMode: configControls.getAssistantRenderingMode,
      renderMarkdownToHtmlDraft: Replies.renderTelegramMarkdownToHtmlDraft,
      sendMessageDraft,
      sendRichMessageDraft,
    });
  const previewRuntime = Preview.createTelegramAssistantPreviewRuntime({
    getActiveTurn: activeTurnRuntime.get,
    isAssistantMessage: Replies.isAssistantAgentMessage,
    getMessageText: Replies.getAgentMessageText,
    getDefaultReplyToMessageId: activeTurnRuntime.getReplyToMessageId,
    sendDraft: nativeMarkdownDraftSender,
    canSend: configControls.areDraftPreviewsEnabled,
    sendMarkdownReply,
    recordRuntimeEvent,
    ...replyTransport,
  });
  const { finalizeMarkdownPreview } =
    Outbound.createTelegramOutboundTextPreviewRuntime({
      finalizeMarkdownPreview: previewRuntime.finalizeMarkdown,
      execCommand: CommandTemplates.execCommandTemplate,
      getHandlers: configStore.getOutboundHandlers,
      recordRuntimeEvent,
    });

  // --- Model And Menu Setup ---

  const modelSwitchController =
    Model.createTelegramModelSwitchControllerRuntime({
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
      getReservedCommandNames: Commands.getTelegramReservedCommandNames,
    });
  const menuActions = Menu.createTelegramMenuActionRuntimeWithStateBuilder({
    runtime: modelMenuRuntime,
    createSettingsManager: Pi.createSettingsManager,
    getActiveModel: currentModelRuntime.get,
    getThinkingLevel,
    getQueueItemCount,
    buildStatusHtml: Commands.createTelegramAppMenuHtmlBuilder({
      buildStatusHtml: Status.createTelegramStatusHtmlBuilder({
        getActiveModel: currentModelRuntime.get,
        isCompactionInProgress: lifecycle.isCompactionInProgress,
        getBridgeStatusLineState: statusRuntime.getStatusState,
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

    // Menu/status UI uses this to reflect whether the active Telegram turn expects voice delivery.
    isVoiceReplyActive: function () {
      const turn = activeTurnRuntime.get();
      return Voice.isVoiceTurn(turn);
    },
  });

  // --- Queue And Settings Menus ---

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
      ...configControls,
    },
    sectionRegistry,
  );

  // --- Polling ---

  const foreignOwnedUpdateForwarder =
    telegramBusFollowerClients.foreignOwnedUpdateForwarder;
  const followerTargetController = telegramBusFollowerClients.targetController;
  const restoreFollowerThreadTarget =
    Bus.createTelegramBusFollowerThreadRestoreHandler({
      followerRegistry: telegramBusFollowerRegistry,
      followerTargetController,
      onRestored() {
        telegramSyncStateRuntime.markSliceFresh("target-bindings", {
          nowMs: Date.now(),
          action: "follower-thread-restore",
        });
      },
    });
  const observedThreadTargetBinding =
    Polling.createTelegramThreadTargetObservationBinding<Pi.ExtensionContext>();
  const topicLifecycleSync =
    Sync.createTelegramObservedTopicLifecycleSyncHandler({
      topicTargetStore: threadStore,
      isBusEnabled: isTelegramBusRuntimeEnabled,
      callApi: callTelegramApi,
      isTopicProvisioningActive: telegramProvisioningActivity.isActive,
      getCurrentLeaderEpoch,
      getThreadReconciliationMachineState: threadReconciliationRuntime.getState,
      recordThreadReconciliationPlan,
      getSyncState: telegramSyncStateRuntime.getState,
      setSyncState: telegramSyncStateRuntime.setState,
      recordEvent: recordRuntimeEvent,
    });
  const inboundBusProjectionRuntime =
    Routing.createTelegramInboundBusProjectionRuntime({
      instanceId: telegramInstanceId,
      listFollowers: telegramBusFollowerRegistry.list,
      listThreadRecords: threadStore.list,
      getLeaderTarget: telegramBusLeaderState.getTarget,
      isFollowerRegistered: telegramBusFollowerRegistrationState.isRegistered,
      getFollowerTarget: telegramBusFollowerRegistrationState.getTarget,
      getCurrentIdentity: getCurrentInstanceThreadIdentity,
    });
  const inboundRouteRuntime = Routing.createTelegramInboundRouteRuntime({
    configStore,
    callApi: callTelegramApi,
    getCurrentInstanceId() {
      return telegramInstanceId;
    },
    getMessageOwnership: messageOwnershipRuntime.store.get,
    recordMessageOwnership: messageOwnershipRuntime.recordRouted,
    ...inboundBusProjectionRuntime,
    getCurrentLeaderEpoch,
    getThreadReconciliationMachineState: threadReconciliationRuntime.getState,
    recordThreadReconciliationPlan,
    handleTelegramTopicLifecycleUpdate: topicLifecycleSync,
    handleTelegramThreadTargetObserved(_target, ctx) {
      return observedThreadTargetBinding.handle(ctx);
    },
    foreignOwnedUpdateForwarder,
    replaceFollowerThreadTarget: restoreFollowerThreadTarget,
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
    threadStore,
    updateStatus,
    dispatchNextQueuedTelegramTurn,
    requestDeferredDispatchNextQueuedTelegramTurn:
      deferredQueueDispatchRuntime.request,
    hasDeferredDispatchContext: deferredQueueDispatchRuntime.isBound,
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
    resolveTimeLine: timeInjectionRuntime.resolveLine,
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
  const promoteTelegramBusFollowerToLeader: BusFollower.TelegramBusFollowerPromotionHandler<Pi.ExtensionContext> =
    BusFollower.createTelegramBusFollowerPromotionHandler<Pi.ExtensionContext>({
      topicTargetStore: threadStore,
      instanceId: telegramInstanceId,
      getActiveProfileName: getActiveTelegramThreadProfile,
      async startLeader(ctx, election, onAcquired): Promise<boolean> {
        const result = await lockedPollingRuntime.start(ctx, {
          election,
          onAcquired,
        });
        return result.ok;
      },
      recordRuntimeEvent,
    });
  const forwardedRouteHandlers =
    BusFollower.createTelegramBusForwardedRouteHandlers<
      Pi.ExtensionContext,
      Updates.TelegramMessageReactionUpdated,
      Routing.TelegramRoutedCallbackQuery,
      Routing.TelegramRoutedMessage
    >({
      handleUpdate: inboundRouteRuntime.handleUpdate,
      handleAuthorizedReactionUpdate:
        inboundRouteRuntime.handleAuthorizedReactionUpdate,
    });
  const telegramBusFollowerAssembly: BusFollower.TelegramBusFollowerRuntimeAssembly<Pi.ExtensionContext> =
    BusFollower.createTelegramBusFollowerRuntimeAssembly<
      Pi.ExtensionContext,
      Updates.TelegramMessageReactionUpdated,
      Routing.TelegramRoutedCallbackQuery,
      Routing.TelegramRoutedMessage
    >({
      receiver: {
        socketPath: getTelegramBusFollowerSocketPath,
        instanceId: telegramInstanceId,
        getContext: telegramSessionContextStore.get,
        getAuthSecret() {
          return telegramActiveBusAuthSecret;
        },
        ...forwardedRouteHandlers,
        prepareForwardedMessage:
          textGroupRuntime.prepareForwardedMessage,
        recordRuntimeEvent,
      },
      targetReplacement: {
        topicTargetStore: threadStore,
        registrationState: telegramBusFollowerRegistrationState,
        instanceId: telegramInstanceId,
        getManualFollowerProfileKey: getTelegramManualFollowerProfileKey,
        manualFollowerOwnerId: telegramManualFollowerOwnerId,
        getSyncState: telegramSyncStateRuntime.getState,
        setSyncState: telegramSyncStateRuntime.setState,
        updateStatus,
        recordRuntimeEvent,
      },
      recovery: {
        registrationState: telegramBusFollowerRegistrationState,
        getLeaderState: lockRuntime.getState,
        setLifecyclePhase(phase) {
          telegramBusLifecycleOverridePhase = phase;
        },
        updateStatus,
        promoteToLeader: promoteTelegramBusFollowerToLeader,
        getActiveContext: telegramSessionContextStore.get,
        recordRuntimeEvent,
      },
      registration: {
        instanceId: telegramInstanceId,
        getFollowerBusSocketPath: getTelegramBusFollowerSocketPath,
        getLeaderSocketPath: getTelegramBusSocketPath,
        registrationState: telegramBusFollowerRegistrationState,
        isContextActive: telegramSessionContextStore.isCurrent,
        createRequestId: telegramBusFollowerClients.createRequestId,
        getLeaderAuthSecret(owner) {
          return owner.busSecret;
        },
        setActiveAuthSecret(secret) {
          telegramActiveBusAuthSecret = secret;
        },
        getProfileKey: getTelegramManualFollowerProfileKey,
        recordRuntimeEvent,
      },
    });
  const telegramBusFollowerRegistration =
    telegramBusFollowerAssembly.registration;
  const pollingRuntime = Polling.createTelegramPollingControllerRuntime({
    state: pollingControllerState,
    getConfig: configStore.get,
    hasBotToken: configStore.hasBotToken,
    deleteWebhook,
    getUpdates,
    persistConfig: persistTelegramConfigWithSync,
    prepareUpdateBatch: textGroupRuntime.prepareUpdateBatch,
    handleUpdate: Updates.createTelegramUpdateHandle({
      defaultHandle: inboundRouteRuntime.handleUpdate,
    }),
    stopTypingLoop: typing.stop,
    updateStatus,
    recordRuntimeEvent,
  });
  const recoverStaleTelegramTopicApiError =
    Sync.createTelegramStaleTopicApiErrorRecoveryRuntime({
      topicTargetStore: threadStore,
      getSyncState: telegramSyncStateRuntime.getState,
      setSyncState: telegramSyncStateRuntime.setState,
      recordEvent: recordRuntimeEvent,
    });
  const authorizeFollowerApiCall = Bus.createTelegramFollowerApiCallAuthorizer({
    isMessageOwned: messageOwnershipRuntime.isOwnedByFollower,
  });
  const telegramBusLeaderRuntime =
    BusLeader.createTelegramBusLeaderRuntimeAssembly<Pi.ExtensionContext>({
      runtime: {
        socketPath: getTelegramBusSocketPath,
        commitEndpointPublication(commit) {
          return lockRuntime.commitIfOwned(commit);
        },
        followerRegistry: telegramBusFollowerRegistry,
        authSecret: telegramBusAuthSecret,
        startPolling: pollingRuntime.start,
        stopPolling: pollingRuntime.stop,
        authorizeFollowerApiCall,
        recordFollowerMessageOwnership(record) {
          messageOwnershipRuntime.recordFollower(record);
        },
      },
      getAllowedUserId: configStore.getAllowedUserId,
      instanceId: telegramInstanceId,
      getCwd: Pi.getExtensionContextCwd,
      getTelegramProfile: getActiveTelegramThreadProfile,
      shouldForceFreshUnnamed:
        telegramThreadCapabilityState.shouldForceFreshLeaderThread,
      topicTargetStore: threadStore,
      callApi(method, body) {
        return directTelegramApiRuntime.call(method, body);
      },
      callMultipart: directTelegramApiRuntime.callMultipart,
      downloadFile: directTelegramApiRuntime.downloadFile,
      recoverStaleTargetError: recoverStaleTelegramTopicApiError,
      getCurrentLeaderEpoch,
      getThreadReconciliationMachineState: threadReconciliationRuntime.getState,
      recordThreadReconciliationPlan,
      getSyncState: telegramSyncStateRuntime.getState,
      setSyncState: telegramSyncStateRuntime.setState,
      setLeaderTarget: telegramBusLeaderState.set,
      onProvisioningStart: telegramProvisioningActivity.start,
      onProvisioningEnd: telegramProvisioningActivity.end,
      recordRuntimeEvent,
    });
  const telegramLeaderHealthRuntime = Sync.createTelegramLeaderHealthRuntime({
    callGetMe() {
      return directTelegramApiRuntime.call("getMe", {});
    },
    getSyncState: telegramSyncStateRuntime.getState,
    setSyncState: telegramSyncStateRuntime.setState,
    recordEvent: recordRuntimeEvent,
  });
  const telegramThreadCapabilityRuntime =
    Polling.createTelegramThreadCapabilityOrchestration<
      Pi.ExtensionContext,
      Locks.TelegramLockEntry
    >({
      state: telegramThreadCapabilityState,
      getAllowedUserId: configStore.getAllowedUserId,
      callApi: callTelegramApi,
      topicTargetStore: threadStore,
      isBusConfigured: isTelegramBusConfigured,
      isBusRuntimeEnabled: isTelegramBusRuntimeEnabled,
      ownsLock: lockRuntime.owns,
      startClassicPolling: pollingRuntime.start,
      stopClassicPolling: pollingRuntime.stop,
      startBusLeaderPolling: telegramBusLeaderRuntime.startPolling,
      stopBusLeaderPolling: telegramBusLeaderRuntime.stopPolling,
      startLeaderHealth: telegramLeaderHealthRuntime.start,
      stopLeaderHealth: telegramLeaderHealthRuntime.stop,
      registerFollowerWithLeader:
        telegramBusFollowerRegistration.registerWithLeader,
      stopFollowerRegistration: telegramBusFollowerRegistration.stop,
      isTopicModeUnavailableError: Threads.isTelegramTopicModeUnavailableError,
      updateStatus,
      recordEvent: recordRuntimeEvent,
    });
  const telegramThreadCapabilityMonitor =
    telegramThreadCapabilityRuntime.monitor;
  observedThreadTargetBinding.set(
    telegramThreadCapabilityRuntime.observeTarget,
  );
  const threadAwarePollingPorts = telegramThreadCapabilityRuntime.pollingPorts;
  const lockedPollingRuntime = Locks.createTelegramLockedPollingRuntime({
    lock: lockRuntime,
    hasBotToken: configStore.hasBotToken,
    canStartPolling: Pi.canStartPollingInExtensionContext,
    formatStartBlockedMessage: Pi.formatPollingStartBlockedByRunMode,
    startPolling: threadAwarePollingPorts.startPolling,
    stopPolling: threadAwarePollingPorts.stopPolling,
    registerFollowerWithOwner:
      threadAwarePollingPorts.registerFollowerWithOwner,
    stopFollowerRegistration: threadAwarePollingPorts.stopFollowerRegistration,
    updateStatus,
    recordRuntimeEvent,
  });
  const disconnectTelegramAndDeleteCurrentThread =
    Sync.createTelegramManualThreadDisconnectHandler({
      instanceId: telegramInstanceId,
      getCurrentThreadRecord: findCurrentThreadRecord,
      topicTargetStore: threadStore,
      callApi: callTelegramApi,
      getCurrentLeaderEpoch,
      getLeaderTarget: telegramBusLeaderState.getTarget,
      clearLeaderTarget: telegramBusLeaderState.clear,
      disconnectFollowerThread:
        telegramBusFollowerRegistration.disconnectFromLeader,
      getSyncState: telegramSyncStateRuntime.getState,
      setSyncState: telegramSyncStateRuntime.setState,
      stopPolling: lockedPollingRuntime.stop,
      recordRuntimeEvent,
    });
  const sessionLifecycleRuntime =
    Lifecycle.createTelegramBridgeSessionLifecycleAssembly({
      contextStore: telegramSessionContextStore,
      queue: {
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
        clearModelMenuState: modelMenuRuntime.clear,
        getActiveTurnChatId: activeTurnRuntime.getChatId,
        getActiveTurnTarget: activeTurnRuntime.getTarget,
        clearPreview: previewRuntime.clear,
        clearActiveTurn: activeTurnRuntime.clear,
        clearAbort: abort.clearHandler,
        recordRuntimeEvent,
      },
      follower: {
        registrationState: telegramBusFollowerRegistrationState,
        registrationRuntime: telegramBusFollowerRegistration,
        instanceId: telegramInstanceId,
        suspendPolling: lockedPollingRuntime.suspend,
        isLeader: lockRuntime.owns,
        getLeaderBinding: currentInstanceThreadRuntime.getRestorationIdentity,
        getActiveContext: telegramSessionContextStore.get,
        getActiveProfileName: getActiveTelegramThreadProfile,
        getLeaderState: lockRuntime.getState,
        updateStatus,
        recordRuntimeEvent,
      },
      services: {
        resumeGroupedInput(ctx) {
          mediaGroupRuntime.resume(ctx);
          textGroupRuntime.resume(ctx);
        },
        suspendGroupedInput: TextGroups.createTelegramGroupedInputClearer({
          clearMediaGroups: mediaGroupRuntime.suspend,
          clearTextGroups: textGroupRuntime.suspend,
        }),
        delivery: deliveryLifecycleRuntime,
        polling: lockedPollingRuntime,
        capabilityMonitor: telegramThreadCapabilityMonitor,
        queueWatchdog: queueDispatchWatchdogRuntime,
      },
    });

  // --- Extension API Bindings ---

  Bindings.registerTelegramCommandsAndTools({
    pi,
    configStore,
    persistConfig: persistTelegramConfigWithSync,
    setup,
    activeTurnRuntime,
    lockedPollingRuntime,
    stopPolling: disconnectTelegramAndDeleteCurrentThread,
    getDisconnectThreadName() {
      const record = findCurrentThreadRecord();
      if (!record?.target.threadId) return undefined;
      return record.threadName ?? "current Telegram thread";
    },
    onTransportChanged: deliveryLifecycleRuntime.onSessionStart,
    getStatusLines,
    buttonActionStore,
    sendMarkdownReply,
    callMultipart,
    getDefaultChatId: proactivePushChatIdGetter,
    getDefaultTarget: proactivePushTargetGetter,
    canSendDirect() {
      return (
        ownsTelegramDirectDelivery() ||
        telegramBusFollowerRegistrationState.isRegistered()
      );
    },
    updateStatus,
    recordRuntimeEvent,
  });

  // --- Lifecycle Hooks ---

  Bindings.registerTelegramLifecycleRuntimeHooks({
    pi,
    sessionLifecycleRuntime: {
      ...sessionLifecycleRuntime,
      onModelSelect: currentModelRuntime.onModelSelect,
    },
    activityRuntime,
    assistantOutputRuntime,
    configStore,
    abort,
    typing,
    lifecycle,
    activeTurnRuntime,
    telegramQueueStore,
    modelSwitchController,
    previewRuntime,
    promptDispatchRuntime,
    deferredQueueDispatchRuntime,
    lockOwnershipGuard,
    buttonActionStore,
    callMultipart,
    sendChatAction,
    sendRecordVoiceAction,
    sendMarkdownReply,
    sendTextReply,
    dispatchNextQueuedTelegramTurn,
    answerGuestQuery,
    deleteMessage: deleteTelegramMessage,
    sendGuestReply,
    finalizeMarkdownPreview,
    proactivePushChatIdGetter,
    proactivePushTargetGetter,
    isProactivePushEnabled: configControls.isProactivePushEnabled,
    getAssistantRenderingMode: configControls.getAssistantRenderingMode,
    recordMessageOwnership: messageOwnershipRuntime.recordLocal,
    canSendAgentActivity(ctx) {
      return (
        lockOwnershipGuard.ownsContext(ctx) ||
        telegramBusFollowerRegistrationState.isRegistered()
      );
    },
    isSessionContextActive(ctx) {
      return telegramSessionContextStore.isCurrent(ctx);
    },
    isTurnTransportActive(turn) {
      return telegramTransportStampRuntime.isActive(turn.transportStamp);
    },
    updateStatus,
    recordRuntimeEvent,
  });
}
