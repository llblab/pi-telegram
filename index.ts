/**
 * Telegram bridge extension entrypoint and orchestration layer
 * Zones: telegram, pi agent, orchestration
 * Keeps the runtime wiring in one place while delegating reusable domain logic to /lib modules
 */

import * as Bindings from "./lib/bindings.ts";
import * as BusApi from "./lib/bus-api.ts";
import * as Bus from "./lib/bus.ts";
import * as BusFollower from "./lib/bus-follower.ts";
import * as BusLeader from "./lib/bus-leader.ts";
import * as BusTransport from "./lib/bus-transport.ts";
import * as CommandTemplates from "./lib/command-templates.ts";
import * as Commands from "./lib/commands.ts";
import * as Config from "./lib/config.ts";
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
    | Status.TelegramBridgeBusLifecyclePhase
    | undefined;
  let telegramBusRequestSequence = 0;
  const telegramBusFollowerRegistry = Bus.createTelegramBusFollowerRegistry();
  const telegramBusFollowerRegistrationState =
    BusFollower.createTelegramBusFollowerRegistrationState();
  let telegramBusLeaderTarget: Config.TelegramProactivePushTarget | undefined;
  let telegramBusLeaderSlot: string | undefined;
  let telegramBusLeaderThreadName: string | undefined;
  let telegramTopicModeUnavailable = false;
  let telegramTopicProvisioningCount = 0;
  const messageOwnershipStore = Ownership.createTelegramMessageOwnershipStore();
  const { abort, lifecycle, queue, setup, typing } = bridgeRuntime;
  let configStoreForRedaction: Config.TelegramConfigStore | undefined;
  const runtimeEvents = Status.createTelegramRuntimeEventRecorder({
    getBotToken() {
      return configStoreForRedaction?.getBotToken();
    },
  });
  let getRuntimeLogProfileName = function (): string | undefined {
    return undefined;
  };
  const runtimeJsonlLog = Logs.createTelegramRuntimeJsonlLog({
    path: function () {
      return Logs.getTelegramRuntimeLogPath(
        undefined,
        getRuntimeLogProfileName(),
      );
    },
    previousPath: function () {
      return Logs.getTelegramPreviousRuntimeLogPath(
        undefined,
        getRuntimeLogProfileName(),
      );
    },
  });
  runtimeJsonlLog.reset("extension-start", {
    instanceId: telegramInstanceId,
    pid: process.pid,
  });
  let scheduleRuntimeDiagnosticsSnapshotPersist = function () {};
  const recordRuntimeEvent = function (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) {
    runtimeEvents.record(category, error, details);
    const latestEvent = runtimeEvents.getEvents().at(-1);
    if (latestEvent) runtimeJsonlLog.record(latestEvent);
    scheduleRuntimeDiagnosticsSnapshotPersist();
  };
  const configStore = Config.createTelegramConfigStore({ recordRuntimeEvent });
  configStoreForRedaction = configStore;
  getRuntimeLogProfileName = configStore.getActiveProfileName;
  const isTelegramBusConfigured = function (): boolean {
    return true;
  };
  const isTelegramBusRuntimeEnabled = function (): boolean {
    return isTelegramBusConfigured() && !telegramTopicModeUnavailable;
  };
  Config.bindGlobalTelegramConfigRuntime(configStore);
  const configControls = Config.createTelegramConfigControls(configStore);
  const threadStore = Threads.createTelegramTopicTargetStore({
    path: function () {
      return Threads.getTelegramTopicTargetsPath(
        undefined,
        configStore.getActiveProfileName(),
      );
    },
  });
  const lockRuntime = Locks.createTelegramLockRuntime<Pi.ExtensionContext>({
    key: Locks.createTelegramLockKeyResolver(configStore),
    instanceId: telegramInstanceId,
    busSecret: telegramBusAuthSecret,
    staleHeartbeatMs: Locks.TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS,
  });
  const lockOwnershipGuard =
    Locks.createTelegramLockOwnershipGuard(lockRuntime);
  const getCurrentLeaderEpoch = function (): number | undefined {
    const state = lockRuntime.getState();
    return state.kind === "active-here" ? state.lock.leaderEpoch : undefined;
  };
  const telegramSessionContextStore =
    Lifecycle.createTelegramSessionContextStore<Pi.ExtensionContext>();
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
          telegramBusLeaderTarget
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
  const telegramQueueStore =
    Queue.createTelegramQueueStore<Pi.ExtensionContext>();
  const deferredQueueDispatchRuntime =
    Queue.createTelegramDeferredQueueDispatchRuntime<Pi.ExtensionContext>({
      delayMs: 50,
      recordRuntimeEvent,
    });
  const pollingControllerState = Polling.createTelegramPollingControllerState();
  let telegramSyncState = Sync.createUnknownTelegramSyncState();
  const threadReconciliationRuntime =
    ThreadReconciler.createThreadReconciliationRuntime({
      recordRuntimeEvent,
      scheduleSnapshotPersist() {
        scheduleRuntimeDiagnosticsSnapshotPersist();
      },
    });
  const recordThreadReconciliationPlan = threadReconciliationRuntime.recordPlan;
  const markTelegramConfigSyncChange = function (action: string) {
    telegramSyncState = Sync.markTelegramConfigSyncChange(
      telegramSyncState,
      action,
    );
  };
  const persistTelegramConfigWithSync = async function () {
    await configStore.persist();
    markTelegramConfigSyncChange("config-persist");
  };
  const findCurrentThreadRecord = function ():
    | Threads.TelegramTopicTargetRecord
    | undefined {
    return Threads.findCurrentTelegramInstanceThreadRecord({
      records: threadStore.list(),
      instanceId: telegramInstanceId,
      preferredTarget:
        activeTurnRuntime.getTarget() ??
        telegramBusFollowerRegistrationState.getTarget() ??
        telegramBusLeaderTarget,
    });
  };
  const getCurrentThreadRecord = function ():
    | Threads.TelegramTopicTargetRecord
    | undefined {
    const record = findCurrentThreadRecord();
    if (
      record?.owner?.kind === "manual-follower" &&
      !telegramBusFollowerRegistrationState.isRegistered()
    ) {
      return undefined;
    }
    return record;
  };
  const statusRuntime = Status.createTelegramBridgeStatusRuntime<
    Pi.ExtensionContext,
    Queue.TelegramQueueItem<Pi.ExtensionContext>
  >({
    getConfig: configStore.get,
    getActiveProfileName: configStore.getActiveProfileName,
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
    getBusRole() {
      if (threadStore.getBotState().threadMode === "disabled") return undefined;
      if (pollingStartedWithTelegramBus) return "leader";
      if (telegramBusFollowerRegistrationState.isRegistered())
        return "follower";
      return undefined;
    },
    getBusLifecyclePhase() {
      return telegramBusLifecycleOverridePhase;
    },
    getBotThreadMode() {
      return threadStore.getBotState();
    },
    getBusFollowers() {
      return Threads.listTelegramThreadStatusFollowers({
        followers: telegramBusFollowerRegistry.list(),
        records: threadStore.list(),
      });
    },
    getLocalBus() {
      return {
        leaderSocketPath: getTelegramBusSocketPath(),
        leaderTransport: BusTransport.getTelegramBusTransportKind(
          getTelegramBusSocketPath(),
        ),
        followerSocketPath: getTelegramBusFollowerSocketPath(),
        followerTransport: BusTransport.getTelegramBusTransportKind(
          getTelegramBusFollowerSocketPath(),
        ),
        followerRegistered: telegramBusFollowerRegistrationState.isRegistered(),
        followerTarget: telegramBusFollowerRegistrationState.getTarget(),
        followerSlot: telegramBusFollowerRegistrationState.getSlot(),
        followerThreadName: telegramBusFollowerRegistrationState.getThreadName(),
      };
    },
    getTopicTargets() {
      return Threads.listTelegramThreadStatusTargets(threadStore.list());
    },
    getThreadReservations() {
      return Threads.listTelegramThreadStatusReservations(
        threadStore.listReservations(),
      );
    },
    getTopicSyncObservations() {
      return Threads.listTelegramThreadStatusObservations(
        threadStore.listSyncObservations(),
      );
    },
    getSyncState() {
      return telegramSyncState;
    },
    getThreadReconciliationState() {
      return threadReconciliationRuntime.getState();
    },
    getInstanceSlot() {
      if (threadStore.getBotState().threadMode === "disabled") return undefined;
      return (
        getCurrentThreadRecord()?.slot ??
        telegramBusFollowerRegistrationState.getSlot() ??
        telegramBusLeaderSlot
      );
    },
    getInstanceThreadName() {
      if (threadStore.getBotState().threadMode === "disabled") return undefined;
      return (
        getCurrentThreadRecord()?.threadName ??
        telegramBusFollowerRegistrationState.getThreadName() ??
        telegramBusLeaderThreadName
      );
    },
  });
  const { updateStatus: updateStatusLine } = statusRuntime;
  const updateRuntimeLogScope = function (reason: string) {
    const scope = Status.createTelegramRuntimeLogScope({
      state: statusRuntime.getStatusState(),
      instanceId: telegramInstanceId,
    });
    const scopeKey = JSON.stringify(scope);
    runtimeJsonlLog.resetIfScopeChanged(scopeKey, reason, scope);
  };
  const updateStatus = function (ctx: Pi.ExtensionContext) {
    updateStatusLine(ctx);
    updateRuntimeLogScope("status-scope-change");
  };
  const persistCurrentStatusSnapshot = function () {
    threadStore.setStatusSnapshot(
      Status.createTelegramStatusSnapshot(statusRuntime.getStatusState()),
    );
    return threadStore.persist();
  };
  scheduleRuntimeDiagnosticsSnapshotPersist =
    Status.createTelegramRuntimeDiagnosticsSnapshotScheduler({
      persistSnapshot: persistCurrentStatusSnapshot,
      recordError(error) {
        runtimeEvents.record("telegram", error, {
          phase: "runtime-diagnostics-snapshot-persist",
        });
      },
    });
  const getStatusLines = function (
    options?: Status.TelegramBridgeStatusLineOptions,
  ): string[] {
    const state = statusRuntime.getStatusState();
    void persistCurrentStatusSnapshot().catch(function (error) {
      recordRuntimeEvent("telegram", error, {
        phase: "status-snapshot-persist",
      });
    });
    return Status.buildTelegramBridgeStatusLines(state, options);
  };
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
  const telegramApiRuntime = BusApi.createTelegramBusAwareApiRuntime({
    directRuntime: directTelegramApiRuntime,
    ownsDirect() {
      return (
        lockRuntime.owns() ||
        !telegramBusFollowerRegistrationState.isRegistered()
      );
    },
    getDefaultTarget: proactivePushTargetGetter,
    callFollowerApi: BusFollower.createTelegramBusFollowerApiCaller({
      socketPath: getTelegramBusSocketPath,
      instanceId: telegramInstanceId,
      createRequestId() {
        telegramBusRequestSequence += 1;
        return Bus.createTelegramBusRequestId({
          instanceId: telegramInstanceId,
          sequence: telegramBusRequestSequence,
        });
      },
      getAuthSecret() {
        return telegramActiveBusAuthSecret;
      },
    }),
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
    recordOwnership(input) {
      messageOwnershipStore.record({
        chatId: input.chatId,
        messageId: input.messageId,
        target: input.target,
        instanceId: telegramInstanceId,
      });
    },
    sendMessage,
    sendRichMessage,
    getAssistantRenderingMode: configControls.getAssistantRenderingMode,
    editMessage: editTelegramMessageText,
  });
  const { replyTransport, editInteractiveMessage, sendInteractiveMessage } =
    replyRuntime;
  const { sendTextReply, sendMarkdownReply } =
    Outbound.createTelegramOutboundTextReplyRuntime({
      sendTextReply: replyRuntime.sendTextReply,
      sendMarkdownReply: replyRuntime.sendMarkdownReply,
      execCommand: CommandTemplates.execCommandTemplate,
      getHandlers: configStore.getOutboundHandlers,
      recordRuntimeEvent,
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
    Bus.createTelegramBusForeignOwnedUpdateForwarder<
      Pi.ExtensionContext,
      Updates.TelegramMessageReactionUpdated,
      Routing.TelegramRoutedCallbackQuery,
      Routing.TelegramRoutedMessage
    >({
      socketPath: getTelegramBusSocketPath,
      createRequestId() {
        telegramBusRequestSequence += 1;
        return Bus.createTelegramBusRequestId({
          instanceId: telegramInstanceId,
          sequence: telegramBusRequestSequence,
        });
      },
      getAuthSecret() {
        return telegramBusAuthSecret;
      },
      timeoutMs: 30_000,
    });
  const followerTargetController =
    Bus.createTelegramBusFollowerTargetController({
      socketPath: getTelegramBusSocketPath,
      createRequestId() {
        telegramBusRequestSequence += 1;
        return Bus.createTelegramBusRequestId({
          instanceId: telegramInstanceId,
          sequence: telegramBusRequestSequence,
        });
      },
      getAuthSecret() {
        return telegramBusAuthSecret;
      },
      timeoutMs: 30_000,
    });
  const restoreFollowerThreadTarget =
    Bus.createTelegramBusFollowerThreadRestoreHandler({
      followerRegistry: telegramBusFollowerRegistry,
      followerTargetController,
      onRestored() {
        telegramSyncState = Sync.markTelegramSyncSliceFresh(
          telegramSyncState,
          "target-bindings",
          { nowMs: Date.now(), action: "follower-thread-restore" },
        );
      },
    });
  let observeTelegramThreadTarget: Polling.TelegramThreadTargetObservationHandler<
    Pi.ExtensionContext
  > = async function noopTelegramThreadTargetObservation() {};
  const topicLifecycleSync = Sync.createTelegramObservedTopicLifecycleSyncHandler({
    topicTargetStore: threadStore,
    isBusEnabled: isTelegramBusRuntimeEnabled,
    callApi: callTelegramApi,
    isTopicProvisioningActive() {
      return telegramTopicProvisioningCount > 0;
    },
    getCurrentLeaderEpoch,
    getThreadReconciliationMachineState() {
      return threadReconciliationRuntime.getState();
    },
    recordThreadReconciliationPlan,
    getSyncState() {
      return telegramSyncState;
    },
    setSyncState(state) {
      telegramSyncState = state;
    },
    recordEvent: recordRuntimeEvent,
  });
  const inboundRouteRuntime = Routing.createTelegramInboundRouteRuntime({
    configStore,
    callApi: callTelegramApi,
    getCurrentInstanceId() {
      return telegramInstanceId;
    },
    getMessageOwnership: messageOwnershipStore.get,
    recordMessageOwnership(input) {
      messageOwnershipStore.record(input);
    },
    getTargetOwnership(target) {
      return Bus.getTelegramFollowerTargetOwnership({
        target,
        followers: telegramBusFollowerRegistry.list(),
        activeThreadRecords: threadStore.list(),
        currentInstanceId: telegramInstanceId,
      });
    },
    getLiveThreadTargets() {
      return Bus.listTelegramBusLiveThreadTargets({
        leaderTarget: telegramBusLeaderTarget,
        followers: telegramBusFollowerRegistry.list(),
      });
    },
    getLocalThreadLabelForTarget(target) {
      const followerTarget = telegramBusFollowerRegistrationState.getTarget();
      if (
        followerTarget?.chatId === target.chatId &&
        followerTarget.threadId === target.threadId
      ) {
        return telegramBusFollowerRegistrationState.getThreadName();
      }
      if (
        telegramBusLeaderTarget?.chatId === target.chatId &&
        telegramBusLeaderTarget.threadId === target.threadId
      ) {
        return telegramBusLeaderThreadName;
      }
      return undefined;
    },
    getCurrentLeaderEpoch,
    getThreadReconciliationMachineState() {
      return threadReconciliationRuntime.getState();
    },
    recordThreadReconciliationPlan,
    handleTelegramTopicLifecycleUpdate: topicLifecycleSync,
    handleTelegramThreadTargetObserved(_target, ctx) {
      return observeTelegramThreadTarget(ctx);
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
      async startLeader(ctx): Promise<void> {
        await lockedPollingRuntime.start(ctx, { force: true });
      },
      recordRuntimeEvent,
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
        getContext() {
          return telegramSessionContextStore.get();
        },
        getAuthSecret() {
          return telegramActiveBusAuthSecret;
        },
        handleForwardedCallback(query, ctx) {
          return inboundRouteRuntime.handleUpdate({ callback_query: query }, ctx);
        },
        handleForwardedReaction(reactionUpdate, ctx) {
          return inboundRouteRuntime.handleAuthorizedReactionUpdate(
            reactionUpdate,
            ctx,
          );
        },
        handleForwardedMessage(message, ctx) {
          return inboundRouteRuntime.handleUpdate(
            { message: message as never },
            ctx,
          );
        },
        async handleForwardedEditedMessage(message, ctx) {
          return inboundRouteRuntime.handleUpdate(
            { edited_message: message as never },
            ctx,
          );
        },
        recordRuntimeEvent,
      },
      targetReplacement: {
        topicTargetStore: threadStore,
        registrationState: telegramBusFollowerRegistrationState,
        instanceId: telegramInstanceId,
        getManualFollowerProfileKey: getTelegramManualFollowerProfileKey,
        manualFollowerOwnerId: telegramManualFollowerOwnerId,
        getSyncState() {
          return telegramSyncState;
        },
        setSyncState(state) {
          telegramSyncState = state;
        },
        updateStatus,
        recordRuntimeEvent,
      },
      recovery: {
        registrationState: telegramBusFollowerRegistrationState,
        getLeaderState() {
          return lockRuntime.getState();
        },
        setLifecyclePhase(phase) {
          telegramBusLifecycleOverridePhase = phase;
        },
        updateStatus,
        promoteToLeader: promoteTelegramBusFollowerToLeader,
        sleep(ms) {
          return Polling.sleepTelegramPollingRetry(ms);
        },
        promotionGraceMs: BusFollower.TELEGRAM_BUS_FOLLOWER_PROMOTION_GRACE_MS,
        recordRuntimeEvent,
      },
      registration: {
        instanceId: telegramInstanceId,
        getFollowerBusSocketPath: getTelegramBusFollowerSocketPath,
        getLeaderSocketPath: getTelegramBusSocketPath,
        registrationState: telegramBusFollowerRegistrationState,
        createRequestId() {
          telegramBusRequestSequence += 1;
          return Bus.createTelegramBusRequestId({
            instanceId: telegramInstanceId,
            sequence: telegramBusRequestSequence,
          });
        },
        getLeaderAuthSecret(owner) {
          return owner.busSecret;
        },
        setActiveAuthSecret(secret) {
          telegramActiveBusAuthSecret = secret;
        },
        getThreadName() {
          return undefined;
        },
        getProfileKey() {
          return getTelegramManualFollowerProfileKey();
        },
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
    handleUpdate: Updates.createTelegramUpdateHandle({
      defaultHandle: inboundRouteRuntime.handleUpdate,
    }),
    stopTypingLoop: typing.stop,
    updateStatus,
    recordRuntimeEvent,
  });
  const recoverStaleTelegramTopicApiError = function (
    apiBody: unknown,
    error: unknown,
  ) {
    return Sync.recoverStaleTelegramTopicApiError(apiBody, error, {
      topicTargetStore: threadStore,
      getSyncState() {
        return telegramSyncState;
      },
      setSyncState(state) {
        telegramSyncState = state;
      },
      recordEvent: recordRuntimeEvent,
    });
  };
  const telegramBusLeaderRuntime =
    BusLeader.createTelegramBusLeaderRuntimeAssembly<Pi.ExtensionContext>({
      runtime: {
        socketPath: getTelegramBusSocketPath,
        followerRegistry: telegramBusFollowerRegistry,
        authSecret: telegramBusAuthSecret,
        startPolling: pollingRuntime.start,
        stopPolling: pollingRuntime.stop,
        authorizeFollowerApiCall: Bus.isTelegramFollowerApiCallAllowed,
        recordFollowerMessageOwnership(record) {
          messageOwnershipStore.record({
            chatId: record.chatId,
            messageId: record.messageId,
            target: record.target,
            instanceId: record.follower.instanceId,
          });
        },
      },
      getAllowedUserId: configStore.getAllowedUserId,
      instanceId: telegramInstanceId,
      getCwd(ctx) {
        return typeof ctx.cwd === "string" ? ctx.cwd : undefined;
      },
      getTelegramProfile: getActiveTelegramThreadProfile,
      shouldForceFreshUnnamed() {
        return forceFreshLeaderThreadOnNextStart;
      },
      topicTargetStore: threadStore,
      callApi(method, body) {
        return directTelegramApiRuntime.call(method, body);
      },
      callMultipart: directTelegramApiRuntime.callMultipart,
      downloadFile: directTelegramApiRuntime.downloadFile,
      recoverStaleTargetError: recoverStaleTelegramTopicApiError,
      getCurrentLeaderEpoch,
      getThreadReconciliationMachineState() {
        return threadReconciliationRuntime.getState();
      },
      recordThreadReconciliationPlan,
      getSyncState() {
        return telegramSyncState;
      },
      setSyncState(state) {
        telegramSyncState = state;
      },
      setLeaderTarget(input) {
        telegramBusLeaderTarget = input.target;
        telegramBusLeaderSlot = input.slot;
        telegramBusLeaderThreadName = input.threadName;
      },
      onProvisioningStart() {
        telegramTopicProvisioningCount += 1;
      },
      onProvisioningEnd() {
        telegramTopicProvisioningCount = Math.max(
          0,
          telegramTopicProvisioningCount - 1,
        );
      },
      recordRuntimeEvent,
    });
  let pollingStartedWithTelegramBus = false;
  let forceFreshLeaderThreadOnNextStart = false;
  const telegramLeaderHealthRuntime = Sync.createTelegramLeaderHealthRuntime({
    callGetMe() {
      return directTelegramApiRuntime.call("getMe", {});
    },
    getSyncState() {
      return telegramSyncState;
    },
    setSyncState(state) {
      telegramSyncState = state;
    },
    recordEvent: recordRuntimeEvent,
  });
  const telegramThreadCapabilityMonitor =
    Polling.createTelegramThreadCapabilityMonitor<Pi.ExtensionContext>({
      getAllowedUserId: configStore.getAllowedUserId,
      callApi: callTelegramApi,
      topicTargetStore: threadStore,
      isBusConfigured: isTelegramBusConfigured,
      ownsLock(ctx) {
        return lockRuntime.owns(ctx);
      },
      getPollingStartedWithTelegramBus() {
        return pollingStartedWithTelegramBus;
      },
      setPollingStartedWithTelegramBus(started) {
        pollingStartedWithTelegramBus = started;
      },
      setTopicModeUnavailable(unavailable) {
        telegramTopicModeUnavailable = unavailable;
      },
      stopFollowerRegistration: telegramBusFollowerRegistration.stop,
      startClassicPolling(ctx) {
        return pollingRuntime.start(ctx);
      },
      stopClassicPolling() {
        return pollingRuntime.stop();
      },
      startBusPolling(ctx) {
        return telegramBusLeaderRuntime.startPolling(ctx);
      },
      stopBusPolling() {
        return telegramBusLeaderRuntime.stopPolling();
      },
      startLeaderHealth: telegramLeaderHealthRuntime.start,
      stopLeaderHealth: telegramLeaderHealthRuntime.stop,
      isTopicModeUnavailableError: Threads.isTelegramTopicModeUnavailableError,
      updateStatus,
      recordEvent: recordRuntimeEvent,
    });
  observeTelegramThreadTarget = Polling.createTelegramThreadTargetObservationHandler({
    getAllowedUserId: configStore.getAllowedUserId,
    callApi: callTelegramApi,
    topicTargetStore: threadStore,
    isBusConfigured: isTelegramBusConfigured,
    ownsLock(ctx) {
      return lockRuntime.owns(ctx);
    },
    getPollingStartedWithTelegramBus() {
      return pollingStartedWithTelegramBus;
    },
    setPollingStartedWithTelegramBus(started) {
      pollingStartedWithTelegramBus = started;
    },
    setTopicModeUnavailable(unavailable) {
      telegramTopicModeUnavailable = unavailable;
    },
    stopFollowerRegistration: telegramBusFollowerRegistration.stop,
    startClassicPolling(ctx) {
      return pollingRuntime.start(ctx);
    },
    stopClassicPolling() {
      return pollingRuntime.stop();
    },
    startBusPolling(ctx) {
      return telegramBusLeaderRuntime.startPolling(ctx);
    },
    stopBusPolling() {
      return telegramBusLeaderRuntime.stopPolling();
    },
    startLeaderHealth: telegramLeaderHealthRuntime.start,
    stopLeaderHealth: telegramLeaderHealthRuntime.stop,
    isTopicModeUnavailableError: Threads.isTelegramTopicModeUnavailableError,
    updateStatus,
    recordEvent: recordRuntimeEvent,
  });
  const threadAwarePollingPorts =
    Polling.createTelegramThreadAwarePollingPorts<
      Pi.ExtensionContext,
      Locks.TelegramLockEntry
    >({
      getAllowedUserId: configStore.getAllowedUserId,
      callApi: callTelegramApi,
      topicTargetStore: threadStore,
      isBusConfigured: isTelegramBusConfigured,
      isBusRuntimeEnabled: isTelegramBusRuntimeEnabled,
      isTopicModeUnavailableError: Threads.isTelegramTopicModeUnavailableError,
      getPollingStartedWithTelegramBus() {
        return pollingStartedWithTelegramBus;
      },
      setPollingStartedWithTelegramBus(started) {
        pollingStartedWithTelegramBus = started;
      },
      setForceFreshLeaderThreadOnNextStart(forceFresh) {
        forceFreshLeaderThreadOnNextStart = forceFresh;
      },
      setTopicModeUnavailable(unavailable) {
        telegramTopicModeUnavailable = unavailable;
      },
      startClassicPolling(ctx) {
        return pollingRuntime.start(ctx);
      },
      stopClassicPolling() {
        return pollingRuntime.stop();
      },
      startBusLeaderPolling(ctx) {
        return telegramBusLeaderRuntime.startPolling(ctx);
      },
      stopBusLeaderPolling() {
        return telegramBusLeaderRuntime.stopPolling();
      },
      startLeaderHealth: telegramLeaderHealthRuntime.start,
      stopLeaderHealth: telegramLeaderHealthRuntime.stop,
      registerFollowerWithLeader(ctx, owner) {
        return telegramBusFollowerRegistration.registerWithLeader(ctx, owner);
      },
      stopFollowerRegistration: telegramBusFollowerRegistration.stop,
      recordEvent: recordRuntimeEvent,
    });
  const lockedPollingRuntime = Locks.createTelegramLockedPollingRuntime({
    lock: lockRuntime,
    hasBotToken: configStore.hasBotToken,
    canStartPolling: Pi.canStartPollingInExtensionContext,
    formatStartBlockedMessage: Pi.formatPollingStartBlockedByRunMode,
    startPolling: threadAwarePollingPorts.startPolling,
    stopPolling: threadAwarePollingPorts.stopPolling,
    registerFollowerWithOwner: threadAwarePollingPorts.registerFollowerWithOwner,
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
      getLeaderTarget() {
        return telegramBusLeaderTarget;
      },
      clearLeaderTarget() {
        telegramBusLeaderTarget = undefined;
        telegramBusLeaderSlot = undefined;
        telegramBusLeaderThreadName = undefined;
      },
      getSyncState() {
        return telegramSyncState;
      },
      setSyncState(state) {
        telegramSyncState = state;
      },
      stopPolling: lockedPollingRuntime.stop,
      recordRuntimeEvent,
    });
  const suspendTelegramForSessionReplacement =
    BusFollower.createTelegramBusFollowerSessionReplacementSuspender({
      registrationState: telegramBusFollowerRegistrationState,
      instanceId: telegramInstanceId,
      suspendPolling: lockedPollingRuntime.suspend,
      onFollowerSessionDisconnect() {
        const target = telegramBusFollowerRegistrationState.getTarget();
        if (!target) return undefined;
        return BusFollower.markTelegramFollowerThreadStaleForSessionDisconnect({
          topicTargetStore: threadStore,
          target,
        });
      },
      recordRuntimeEvent,
    });
  const queueSessionLifecycle = Queue.createTelegramSessionLifecycleRuntime({
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
    getActiveTurnTarget: activeTurnRuntime.getTarget,
    clearPreview: previewRuntime.clear,
    clearActiveTurn: activeTurnRuntime.clear,
    clearAbort: abort.clearHandler,
    stopPolling: suspendTelegramForSessionReplacement,
    recordRuntimeEvent,
  });
  const baseSessionLifecycleRuntime = Lifecycle.appendTelegramLifecycleHooks(
    queueSessionLifecycle,
    {
      async onSessionStart(event, ctx) {
        await lockedPollingRuntime.onSessionStart(event, ctx);
        telegramThreadCapabilityMonitor.start(ctx);
        queueDispatchWatchdogRuntime.start(ctx);
      },
      async onSessionShutdown() {
        queueDispatchWatchdogRuntime.stop();
        telegramThreadCapabilityMonitor.stop();
      },
    },
  );
  const sessionLifecycleWithContext = Lifecycle.appendTelegramLifecycleHooks(
    baseSessionLifecycleRuntime,
    Lifecycle.createTelegramSessionContextTracker(telegramSessionContextStore),
  );
  const sessionLifecycleRuntime = Lifecycle.appendTelegramLifecycleHooks(
    sessionLifecycleWithContext,
    {
      onSessionStart: BusFollower.createTelegramBusFollowerSessionRefreshHook({
        registrationState: telegramBusFollowerRegistrationState,
        registrationRuntime: telegramBusFollowerRegistration,
        getLeaderState() {
          return lockRuntime.getState();
        },
        updateStatus,
        recordRuntimeEvent,
      }),
    },
  );

  // --- Extension API Bindings ---

  Bindings.registerTelegramCommandsAndTools({
    pi,
    configStore,
    persistConfig: persistTelegramConfigWithSync,
    setup,
    activeTurnRuntime,
    lockedPollingRuntime,
    stopPolling: disconnectTelegramAndDeleteCurrentThread,
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
    sendGuestReply,
    finalizeMarkdownPreview,
    proactivePushChatIdGetter,
    proactivePushTargetGetter,
    isProactivePushEnabled: configControls.isProactivePushEnabled,
    canSendProactivePush(ctx) {
      return (
        lockOwnershipGuard.ownsContext(ctx) ||
        telegramBusFollowerRegistrationState.isRegistered()
      );
    },
    updateStatus,
    recordRuntimeEvent,
  });
}
