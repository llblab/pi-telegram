/**
 * Telegram bridge extension entrypoint and orchestration layer
 * Zones: telegram, pi agent, orchestration
 * Keeps the runtime wiring in one place while delegating reusable domain logic to /lib modules
 */

import * as AgentMessages from "./lib/agent-messages.ts";
import * as Bindings from "./lib/bindings.ts";
import * as BusApi from "./lib/bus-api.ts";
import * as BusFollower from "./lib/bus-follower.ts";
import * as BusLeader from "./lib/bus-leader.ts";
import * as BusTransport from "./lib/bus-transport.ts";
import * as Bus from "./lib/bus.ts";
import * as CommandTemplates from "./lib/command-templates.ts";
import * as Commands from "./lib/commands.ts";
import * as Config from "./lib/config.ts";
import * as Delivery from "./lib/delivery.ts";
import * as Inbound from "./lib/inbound.ts";
import * as Journal from "./lib/journal.ts";
import * as Lifecycle from "./lib/lifecycle.ts";
import * as Locks from "./lib/locks.ts";
import * as Logs from "./lib/logs.ts";
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
import * as Prompts from "./lib/prompts.ts";
import * as Queue from "./lib/queue.ts";
import * as Recovery from "./lib/recovery.ts";
import * as Replies from "./lib/replies.ts";
import * as Routing from "./lib/routing.ts";
import * as Runtime from "./lib/runtime.ts";
import * as Sections from "./lib/sections.ts";
import * as Skills from "./lib/skills.ts";
import * as Status from "./lib/status.ts";
import * as Sync from "./lib/sync.ts";
import * as TelegramApi from "./lib/telegram-api.ts";
import * as TextGroups from "./lib/text-groups.ts";
import * as ThreadReconciler from "./lib/thread-reconciler.ts";
import * as Threads from "./lib/threads.ts";
import * as TimeInjection from "./lib/time-injection.ts";
import * as Updates from "./lib/updates.ts";
import * as Voice from "./lib/voice.ts";

type ActivePiModel = NonNullable<Pi.ExtensionContext["model"]>;

const telegramBusProtocolIdentity =
  Bus.createTelegramCurrentBusProtocolIdentity([
    Bus.TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
    Bus.TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF,
  ]);

// --- Extension Runtime ---

export default function (pi: Pi.ExtensionAPI) {
  Skills.registerTelegramSkillDiscovery(pi);
  const piRuntime = Pi.createExtensionApiRuntimePorts(pi);
  const {
    getActiveTools,
    getCommands,
    getThinkingLevel,
    sendUserMessage,
    setActiveTools,
    setModel,
    setThinkingLevel,
  } = piRuntime;
  const bridgeRuntime = Runtime.createTelegramBridgeRuntime();
  const runtimeDiagnostics =
    Logs.createTelegramRuntimeDiagnosticsRuntime<Pi.ExtensionContext>();
  const runtimeEvents = runtimeDiagnostics.events;
  const recordRuntimeEvent = runtimeDiagnostics.recordRuntimeEvent;
  const configStore = Config.createTelegramConfigStore({ recordRuntimeEvent });
  const busProcessRuntime = Bus.createCurrentTelegramBusProcessRuntime({
    getActiveProfileName: configStore.getActiveProfileName,
  });
  const {
    instanceId: telegramInstanceId,
    processId: telegramProcessId,
    processBirthId: telegramQueueProcessBirthId,
    manualFollowerOwnerId: telegramManualFollowerOwnerId,
    getLeaderSocketPath: getTelegramBusSocketPath,
    getFollowerSocketPath: getTelegramBusFollowerSocketPath,
  } = busProcessRuntime;
  const getTelegramBotId = Config.createTelegramConfigBotIdGetter(configStore);
  const getTelegramActiveProfileKey =
    Config.createTelegramActiveProfileKeyGetter(configStore);
  const getTelegramManualFollowerProfileKey =
    BusFollower.createTelegramManualFollowerProfileKeyResolver({
      getActiveProfileName: configStore.getActiveProfileName,
      manualFollowerOwnerId: telegramManualFollowerOwnerId,
    });
  const telegramBusAuthSecret = Bus.createTelegramBusAuthSecret();
  const telegramBusFollowerControlState =
    BusFollower.createTelegramBusFollowerControlState();
  const telegramBusFollowerRegistry = Bus.createTelegramBusFollowerRegistry();
  const modelContextAvailabilityBinding =
    Prompts.createTelegramModelContextAvailabilityBinding();
  const telegramBusFollowerRegistrationState =
    BusFollower.createTelegramBusFollowerRegistrationState({
      onAvailabilityChanged: modelContextAvailabilityBinding.reconcile,
    });
  const telegramBusLeaderState =
    Threads.createTelegramLeaderThreadStateRuntime();
  const telegramThreadCapabilityState =
    Polling.createTelegramThreadCapabilityStateRuntime();
  const telegramProvisioningActivity =
    Sync.createTelegramProvisioningActivityRuntime();
  const messageOwnershipRuntime =
    Ownership.createTelegramBusMessageOwnershipRuntime({
      instanceId: telegramInstanceId,
      getProfileKey: getTelegramActiveProfileKey,
      listFollowers: telegramBusFollowerRegistry.list,
    });
  const { abort, lifecycle, queue, setup, typing } = bridgeRuntime;
  const getTelegramUpdateAdmissionScope =
    Journal.createTelegramUpdateJournalReceiptScopeResolver({
      getProfileName: configStore.getActiveProfileName,
      getBotToken: configStore.getBotToken,
      getBotId: getTelegramBotId,
    });
  const telegramJournalBindingRuntime =
    Journal.createTelegramUpdateJournalBindingRuntime({
      base: {
        getProfileName: configStore.getActiveProfileName,
        getBotToken: configStore.getBotToken,
        getBotId: getTelegramBotId,
        onRecovery(event) {
          recordRuntimeEvent(
            "recovery",
            event.kind === "repaired"
              ? "Telegram update journal was repaired automatically."
              : "Telegram update journal was reset after its damaged files were quarantined.",
            {
              phase: "journal-auto-recovery",
              recoveryKind: event.kind,
              journalPath: event.path,
              revision: event.revision,
              quarantinePath: event.quarantinePath,
              reason: event.reason,
            },
          );
        },
        getQueueRuntimeIdentity() {
          return {
            instanceId: telegramInstanceId,
            processId: telegramProcessId,
            processBirthId: telegramQueueProcessBirthId,
          };
        },
      },
      getLeaderJournalPath: Paths.resolveTelegramUpdateJournalPath,
      getFollowerJournalPath(bindingKey, profileName) {
        return Paths.resolveTelegramFollowerJournalPath(
          bindingKey,
          undefined,
          profileName,
        );
      },
      getActiveFollowerBindingKey: getTelegramManualFollowerProfileKey,
      isFollowerRegistered: telegramBusFollowerRegistrationState.isRegistered,
    });
  const resolveTelegramUpdateJournalBinding =
    telegramJournalBindingRuntime.resolveLeader;
  const resolveTelegramFollowerJournalBinding =
    telegramJournalBindingRuntime.resolveFollower;
  const getTelegramQueueJournalBinding =
    telegramJournalBindingRuntime.getActiveRecoveryKey;
  const isTelegramBusRuntimeEnabled =
    telegramThreadCapabilityState.isBusRuntimeEnabled;
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
  const modelContextAvailabilityRuntime =
    Prompts.createTelegramModelContextAvailabilityRuntime({
      getActiveTools,
      setActiveTools,
      isAvailable() {
        return (
          ownsTelegramDirectDelivery() ||
          telegramBusFollowerRegistrationState.isRegistered()
        );
      },
      canReconcile() {
        const ctx = telegramSessionContextStore.get();
        return !ctx || Pi.isExtensionContextIdle(ctx);
      },
    });
  modelContextAvailabilityBinding.bind(modelContextAvailabilityRuntime);
  const activeTurnRuntime = Queue.createTelegramActiveTurnStore();
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
  const proactivePushChatIdGetter =
    Config.createTelegramProactivePushChatIdGetter(proactivePushTargetGetter);
  const buttonActionStore = Outbound.createTelegramButtonActionStore();
  const planGenerativeAppOutput =
    Outbound.createTelegramOutboundReplyPlanner(buttonActionStore);
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
  const updateAdmissionRuntimeBinding =
    Updates.createTelegramUpdateAdmissionRuntimeBinding<Pi.ExtensionContext>({
      isFollowerRegistered: telegramBusFollowerRegistrationState.isRegistered,
    });
  const deferredQueueDispatchRuntime =
    Queue.createTelegramDeferredQueueDispatchRuntime<Pi.ExtensionContext>({
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
  const {
    current: currentInstanceThreadRuntime,
    status: threadStatusProjectionRuntime,
  } = Threads.createTelegramCurrentThreadAssembly({
    instanceId: telegramInstanceId,
    listRecords: threadStore.list,
    getActiveTurnTarget: activeTurnRuntime.getTarget,
    getFollowerTarget: telegramBusFollowerRegistrationState.getTarget,
    isFollowerRegistered: telegramBusFollowerRegistrationState.isRegistered,
    getFollowerSlot: telegramBusFollowerRegistrationState.getSlot,
    getFollowerThreadName: telegramBusFollowerRegistrationState.getThreadName,
    getLeaderIdentity: telegramBusLeaderState.getIdentity,
    getLeaderTarget: telegramBusLeaderState.getTarget,
    getLeaderProtocol: telegramBusFollowerRegistrationState.getLeaderProtocol,
    status: {
      getThreadMode: function () {
        return threadStore.getBotState().threadMode;
      },
      isBusPollingStarted: telegramThreadCapabilityState.isBusPollingStarted,
      listFollowers: telegramBusFollowerRegistry.list,
      listReservations: threadStore.listReservations,
      listSyncObservations: threadStore.listSyncObservations,
      getLeaderSocketPath: getTelegramBusSocketPath,
      getFollowerSocketPath: getTelegramBusFollowerSocketPath,
      getTransportKind: BusTransport.getTelegramBusTransportKind,
    },
  });
  const findCurrentThreadRecord = currentInstanceThreadRuntime.findRecord;
  const getCurrentInstanceThreadIdentity =
    currentInstanceThreadRuntime.getIdentity;
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
    getPollingState: Polling.createTelegramPollingStateReader(
      pollingControllerState,
    ),
    getInboundWorkerState() {
      return updateAdmissionRuntimeBinding.getActive()?.getState();
    },
    getAcceptedThroughUpdateId() {
      return resolveTelegramUpdateJournalBinding()?.journal.read()
        .acceptedThroughUpdateId;
    },
    getActiveSourceMessageIds: activeTurnRuntime.getSourceMessageIds,
    hasActiveTurn: activeTurnRuntime.has,
    hasDispatchPending: lifecycle.hasDispatchPending,
    isCompactionInProgress: lifecycle.isCompactionInProgress,
    getActiveToolExecutions: lifecycle.getActiveToolExecutions,
    hasPendingModelSwitch: pendingModelSwitchStore.has,
    getQueuedItems: telegramQueueStore.getQueuedItems,
    getQueuedItemCount: Queue.countExecutableTelegramQueueItems,
    formatQueuedStatus: Queue.formatQueuedTelegramItemsStatus,
    getRecentRuntimeEvents: runtimeEvents.getEvents,
    getRuntimeLockState: lockRuntime.getStatusLabel,
    ...threadStatusProjectionRuntime,
    getBusProtocol() {
      return telegramBusProtocolIdentity;
    },
    getBusLifecyclePhase: telegramBusFollowerControlState.getLifecyclePhase,
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
      getApiAuthSecret: telegramBusFollowerControlState.getActiveAuthSecret,
      getForwardingAuthSecret() {
        return telegramBusAuthSecret;
      },
      getRegistrationGeneration:
        telegramBusFollowerRegistrationState.getGeneration,
      waitForRegistrationGeneration:
        telegramBusFollowerRegistrationState.waitForGeneration,
      getForwardCommentBatchPosition:
        textGroupRuntime.getPreparedForwardingPosition,
      recordRuntimeEvent,
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
    editMessageReplyMarkup: editTelegramMessageReplyMarkup,
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
    isContextActive: telegramSessionContextStore.isCurrent,
    getTransportAuthority() {
      if (ownsTelegramDirectDelivery()) {
        const epoch = getCurrentLeaderEpoch();
        return epoch === undefined ? undefined : `direct:${epoch}`;
      }
      if (!telegramBusFollowerRegistrationState.isRegistered()) return undefined;
      const generation = telegramBusFollowerRegistrationState.getGeneration();
      return generation ? `follower:${generation}` : undefined;
    },
    recordRuntimeEvent,
  });
  const currentModelRuntime = Model.createCurrentModelRuntime({
    getContextModel,
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
  const deliveryGenerationSeed =
    Delivery.createTelegramDeliveryGenerationSeed(telegramInstanceId);
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
  const invokeGenerativeAppBoundButtonAction =
    Bindings.createTelegramGenerativeAppBoundButtonActionInvoker({
      agentDir: Paths.resolveAgentDir(),
      assertExecutionCurrent: Updates.assertTelegramUpdateExecutionCurrent,
      getExecutionFence: Updates.getTelegramUpdateExecutionFence,
      planOutput: planGenerativeAppOutput,
      sendMarkdownReply,
      editInteractiveMessage,
      recordRuntimeEvent,
    });
  const {
    activityRuntime,
    activityVerbosityRuntime,
    assistantOutputRuntime,
  } = Bindings.createTelegramActivityBindingRuntime({
    generation: deliveryGenerationSeed,
    assistantOutput: {
      authority: {
        getPreferredTarget: proactivePushTargetGetter,
        getFallbackChatId: proactivePushChatIdGetter,
        getTransportStamp: telegramTransportStampRuntime.getStamp,
        isTransportStampActive: telegramTransportStampRuntime.isActive,
        ownsDirect: lockRuntime.owns,
        getDirectEpoch: lockRuntime.getOwnedLeaderEpoch,
        isFollowerRegistered: telegramBusFollowerRegistrationState.isRegistered,
        getFollowerGeneration:
          telegramBusFollowerRegistrationState.getGeneration,
      },
      sender: {
        recordOwnership: messageOwnershipRuntime.recordLocal,
        sendMessage,
        sendRichMessage,
        editMessage: editTelegramMessageText,
        getAssistantRenderingMode: configControls.getAssistantRenderingMode,
        planButtonReply:
          Outbound.createTelegramButtonReplyPlanner(buttonActionStore),
        execCommand: CommandTemplates.execCommandTemplate,
        getHandlers: configStore.getOutboundHandlers,
        recordRuntimeEvent,
      },
      recordRuntimeEvent,
    },
    activityVerbosity: {
      getActivityMode: configControls.getActivityVerbosity,
      refreshActivityMode: configControls.refreshActivityVerbosity,
      resolveTarget(event) {
        return event.target ?? proactivePushTargetGetter();
      },
      sendMessage,
      sendRichMessage,
      editMessageText: editTelegramMessageText,
    },
  });
  const {
    mutation: queueMutationRuntime,
    dispatchNext: dispatchNextQueuedTelegramTurn,
    watchdog: queueDispatchWatchdogRuntime,
  } = Bindings.createTelegramQueueBindingRuntime({
    store: telegramQueueStore,
    queue,
    lifecycle,
    activeTurn: activeTurnRuntime,
    admission: updateAdmissionRuntimeBinding,
    transportStamp: telegramTransportStampRuntime,
    deferredDispatch: deferredQueueDispatchRuntime,
    promptDispatch: promptDispatchRuntime,
    isIdle,
    hasPendingMessages,
    updateStatus,
    sendTextReply,
    sendUserMessage,
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
      reloadConfig: configStore.load,
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
        telegramSyncStateRuntime.markSliceFresh(
          Sync.TELEGRAM_SYNC_SLICE_TARGET_BINDINGS,
          {
            nowMs: Date.now(),
            action: "follower-thread-restore",
          },
        );
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
      assertExecutionCurrent(message) {
        Updates.assertTelegramUpdateExecutionCurrent(message);
      },
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
    getAdmissionScope: getTelegramUpdateAdmissionScope,
    getAdmissionJournalBinding: getTelegramQueueJournalBinding,
    getMessageOwnership: messageOwnershipRuntime.store.get,
    recordMessageOwnership: messageOwnershipRuntime.recordRouted,
    ...inboundBusProjectionRuntime,
    getCurrentLeaderEpoch,
    setCurrentLeaderIdentity: telegramBusLeaderState.set,
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
    invokeBoundButtonAction: invokeGenerativeAppBoundButtonAction,
    inboundHandlerRuntime,
    threadStore,
    updateStatus,
    isContextActive: telegramSessionContextStore.isCurrent,
    dispatchNextQueuedTelegramTurn,
    requestDeferredDispatchNextQueuedTelegramTurn:
      deferredQueueDispatchRuntime.request,
    hasDeferredDispatchContext: deferredQueueDispatchRuntime.isBound,
    startTypingLoop: promptDispatchRuntime.startTypingLoop,
    stopTypingLoop: typing.stop,
    answerCallbackQuery,
    editInteractiveMessage,
    editMessageReplyMarkup: editTelegramMessageReplyMarkup,
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
  const queueHandoffReconciliationBinding =
    Updates.createTelegramQueueHandoffReconciliationBinding<Pi.ExtensionContext>(
      function (error) {
        recordRuntimeEvent("inbound-worker", error, {
          phase: "queue-handoff-reconcile",
        });
      },
    );
  const staleTopicApiErrorRecoveryDeps = {
    topicTargetStore: threadStore,
    getSyncState: telegramSyncStateRuntime.getState,
    setSyncState: telegramSyncStateRuntime.setState,
    recordEvent: recordRuntimeEvent,
  };
  const recoverStaleTelegramTopicApiError =
    Sync.createTelegramStaleTopicApiErrorRecoveryRuntime(
      staleTopicApiErrorRecoveryDeps,
    );
  const {
    owner: updateWorkerOwnerRuntime,
    leader: updateAdmissionLifecycleRuntime,
    follower: followerAdmissionLifecycleRuntime,
  } = Updates.createTelegramUpdateAdmissionRuntimeAssembly<
    Parameters<typeof inboundRouteRuntime.handleUpdate>[0] &
      Journal.TelegramJournaledUpdate,
    Pi.ExtensionContext
  >({
    runtimeBinding: updateAdmissionRuntimeBinding,
    owner: {
      instanceId: telegramInstanceId,
      processId: telegramProcessId,
      processBirthId: telegramQueueProcessBirthId,
      getSessionGeneration: telegramSessionContextStore.getGeneration,
      isContextCurrent: telegramSessionContextStore.isCurrent,
      dispatchNext: dispatchNextQueuedTelegramTurn,
      requestQueueHandoffReconciliation:
        queueHandoffReconciliationBinding.request,
    },
    worker: {
      defaultHandle: inboundRouteRuntime.handleUpdate,
      onStateChange: runtimeDiagnostics.scheduleSnapshotPersist,
      settleTerminalExecutionFailure(error) {
        return Sync.settleStaleTelegramTopicExecutionFailure(
          error,
          staleTopicApiErrorRecoveryDeps,
        );
      },
    },
    leader: {
      resolveBinding: resolveTelegramUpdateJournalBinding,
      hasAuthority: lockRuntime.owns,
    },
    follower: {
      resolveBinding: resolveTelegramFollowerJournalBinding,
      isRegistered: telegramBusFollowerRegistrationState.isRegistered,
      getGeneration: telegramBusFollowerRegistrationState.getGeneration,
      prepareUpdateForExecution(update) {
        return BusFollower.prepareTelegramBusFollowerJournaledUpdateForExecution(
          update,
          textGroupRuntime.prepareForwardedMessage,
        );
      },
    },
    recordRuntimeEvent,
  });
  const queueHandoffStagingRuntime =
    Queue.createTelegramQueueHandoffStagingRuntime({
      liveStore: telegramQueueStore,
      createControlExecution:
        Updates.createTelegramQueueHandoffControlExecutionFactory({
          isContextCurrent: telegramSessionContextStore.isCurrent,
          showStatus: menuActions.sendStatusMessage,
          openModelMenu: menuActions.openModelMenu,
        }),
    });
  const acceptStagedQueueHandoff =
    Updates.createTelegramQueueHandoffRecipientRuntime({
      staging: queueHandoffStagingRuntime,
      getRecipientOwner: updateWorkerOwnerRuntime.getQueueOwnerIdentity,
      getLifecycleForBinding:
        updateAdmissionRuntimeBinding.getLifecycleForJournalBinding,
      isTransportStampActive: telegramTransportStampRuntime.isActive,
      dispatchNext: dispatchNextQueuedTelegramTurn,
    });
  const followerDurableAdmissionRuntime =
    BusFollower.createTelegramBusFollowerDurableAdmissionRuntime({
      journal: {
        appendBatch(updates) {
          return followerAdmissionLifecycleRuntime.appendBatch(updates);
        },
      },
      signalWorker() {
        followerAdmissionLifecycleRuntime.signal();
      },
    });
  const promoteTelegramBusFollowerToLeader: BusFollower.TelegramBusFollowerPromotionHandler<Pi.ExtensionContext> =
    BusFollower.createTelegramBusFollowerPromotionHandler<Pi.ExtensionContext>({
      topicTargetStore: threadStore,
      instanceId: telegramInstanceId,
      getActiveProfileName: configStore.getActiveProfileName,
      async startLeader(ctx, election, onAcquired): Promise<boolean> {
        const result = await lockedPollingRuntime.start(ctx, {
          election,
          onAcquired,
        });
        return result.ok;
      },
      recordRuntimeEvent,
    });
  const agentMessageRuntime = AgentMessages.createTelegramAgentMessageRuntime({
    instanceId: telegramInstanceId,
    getAllowedChatId: configStore.getAllowedUserId,
    getLeaderTarget: telegramBusLeaderState.getTarget,
    getLeaderThreadName() {
      return findCurrentThreadRecord()?.threadName;
    },
    followerRegistry: telegramBusFollowerRegistry,
    getContext: telegramSessionContextStore.get,
    handleUpdate: inboundRouteRuntime.handleUpdate,
  });
  const agentMessageToolRoutingRuntime =
    Bindings.createTelegramAgentMessageToolRoutingRuntime({
      ownsLeader: lockRuntime.owns,
      ownsDirectDelivery: ownsTelegramDirectDelivery,
      isFollowerRegistered: telegramBusFollowerRegistrationState.isRegistered,
      getSourceTarget: proactivePushTargetGetter,
      getSourceThreadName() {
        return findCurrentThreadRecord()?.threadName;
      },
      local: agentMessageRuntime,
      follower: telegramBusFollowerClients.agentMessages,
    });
  const telegramBusFollowerAssembly: BusFollower.TelegramBusFollowerRuntimeAssembly<Pi.ExtensionContext> =
    BusFollower.createTelegramBusFollowerRuntimeAssembly<Pi.ExtensionContext>({
      instanceId: telegramInstanceId,
      registrationState: telegramBusFollowerRegistrationState,
      recordRuntimeEvent,
      receiver: {
        socketPath: getTelegramBusFollowerSocketPath,
        getContext: telegramSessionContextStore.get,
        getAuthSecret: telegramBusFollowerControlState.getActiveAuthSecret,
        getRecipientBindingKey: getTelegramManualFollowerProfileKey,
        durableAdmission: followerDurableAdmissionRuntime,
        handleQueueHandoff: acceptStagedQueueHandoff,
      },
      targetReplacement: {
        topicTargetStore: threadStore,
        getManualFollowerProfileKey: getTelegramManualFollowerProfileKey,
        manualFollowerOwnerId: telegramManualFollowerOwnerId,
        getSyncState: telegramSyncStateRuntime.getState,
        setSyncState: telegramSyncStateRuntime.setState,
        updateStatus,
      },
      recovery: {
        getLeaderState: lockRuntime.getState,
        setLifecyclePhase: telegramBusFollowerControlState.setLifecyclePhase,
        updateStatus,
        promoteToLeader: promoteTelegramBusFollowerToLeader,
        getActiveContext: telegramSessionContextStore.get,
      },
      registration: {
        protocolIdentity: telegramBusProtocolIdentity,
        getFollowerBusSocketPath: getTelegramBusFollowerSocketPath,
        getLeaderSocketPath: getTelegramBusSocketPath,
        isContextActive: telegramSessionContextStore.isCurrent,
        createRequestId: telegramBusFollowerClients.createRequestId,
        setActiveAuthSecret:
          telegramBusFollowerControlState.setActiveAuthSecret,
        getProfileKey: getTelegramManualFollowerProfileKey,
        getThreadName() {
          return telegramThreadCapabilityState.getRequestedThreadName();
        },
        getProcessBirthId() {
          return telegramQueueProcessBirthId;
        },
        getSessionGeneration: telegramSessionContextStore.getGeneration,
        async onRegistered(ctx) {
          await followerAdmissionLifecycleRuntime.onTransportChanged(ctx);
          queueHandoffReconciliationBinding.request(ctx);
        },
      },
    });
  const telegramBusFollowerRegistration =
    telegramBusFollowerAssembly.registration;
  const { admission: pollingAdmissionRuntime } =
    Polling.createTelegramDurablePollingRuntimeAssembly<
      TelegramApi.TelegramUpdate,
      Pi.ExtensionContext
    >({
      state: pollingControllerState,
      getConfig: configStore.get,
      hasBotToken: configStore.hasBotToken,
      deleteWebhook,
      getUpdates,
      persistConfig: persistTelegramConfigWithSync,
      prepareUpdateBatch: textGroupRuntime.prepareUpdateBatch,
      journal: {
        appendBatch(updates, acceptedThroughUpdateId) {
          return updateAdmissionLifecycleRuntime.appendBatch(
            updates as Journal.TelegramJournaledUpdate[],
            acceptedThroughUpdateId,
          );
        },
        getAcceptedThroughUpdateId() {
          return resolveTelegramUpdateJournalBinding()?.journal.read()
            .acceptedThroughUpdateId;
        },
        async prepareCursorCutover() {
          const binding = resolveTelegramUpdateJournalBinding();
          if (!binding) {
            throw new Error("Telegram update journal binding is unavailable.");
          }
          await Polling.cutOverTelegramPollingCursor({
            getLegacyCursor: configStore.getLegacyPollingCursor,
            readJournal: binding.journal.read,
            publishJournalCursor(acceptedThroughUpdateId) {
              binding.journal.appendBatch([], acceptedThroughUpdateId);
            },
            async removeLegacyCursor() {
              configStore.removeLegacyPollingCursor();
              await persistTelegramConfigWithSync();
            },
          });
        },
        getEntryCount: updateAdmissionLifecycleRuntime.getJournalEntryCount,
        signalWorker: updateAdmissionLifecycleRuntime.signal,
        getBootstrapEntryCount() {
          return (
            resolveTelegramUpdateJournalBinding()?.journal.read().entries
              .length ?? 0
          );
        },
        onSessionStart: updateAdmissionLifecycleRuntime.onSessionStart,
      },
      stopTypingLoop: typing.stop,
      updateStatus,
      onPollingStateChange: runtimeDiagnostics.scheduleSnapshotPersist,
      recordRuntimeEvent,
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
        protocolIdentity: telegramBusProtocolIdentity,
        startPolling: pollingAdmissionRuntime.start,
        stopPolling: pollingAdmissionRuntime.stop,
        authorizeFollowerApiCall,
        resolveAgentTarget(follower, selector) {
          return agentMessageRuntime.resolveTarget(selector, follower.target);
        },
        routeAgentMessage(follower, message) {
          return agentMessageRuntime.route({
            sourceTarget: follower.target,
            sourceThreadName: follower.threadName,
            message,
          });
        },
        isFollowerProcessAlive: Locks.isProcessAlive,
        shouldCleanupConfirmedDeadFollower:
          configControls.resolveAutomaticThreadCleanupEnabled,
        recordFollowerMessageOwnership(record) {
          messageOwnershipRuntime.recordFollower(record);
        },
      },
      getAllowedUserId: configStore.getAllowedUserId,
      instanceId: telegramInstanceId,
      getCwd: Pi.getExtensionContextCwd,
      getTelegramProfile: configStore.getActiveProfileName,
      shouldForceFreshUnnamed:
        telegramThreadCapabilityState.shouldForceFreshLeaderThread,
      getRequestedThreadName:
        telegramThreadCapabilityState.getRequestedThreadName,
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
  queueHandoffReconciliationBinding.set(
    Updates.createTelegramQueueHandoffReconciliationRuntimeAssembly({
      ownsDirect: lockRuntime.owns,
      isFollowerRegistered: telegramBusFollowerRegistrationState.isRegistered,
      isBusEnabled: isTelegramBusRuntimeEnabled,
      canHandoffWithLeader() {
        return Bus.hasTelegramBusCapability(
          telegramBusFollowerRegistrationState.getLeaderProtocol(),
          Bus.TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF,
        );
      },
      listFollowers: telegramBusFollowerRegistry.list,
      createRecipientJournalResolver:
        telegramJournalBindingRuntime.createRecipientResolver,
      queueStore: telegramQueueStore,
      admission: updateAdmissionRuntimeBinding,
      createHandoffToken: Journal.createTelegramUpdateQueueHandoffToken,
      createRequestId: telegramBusFollowerClients.createRequestId,
      donorInstanceId: telegramInstanceId,
      authSecret: telegramBusAuthSecret,
      stageThroughFollower: telegramBusFollowerClients.queueHandoff,
      routeThroughLeader: telegramBusLeaderRuntime.routeQueueHandoff,
      recordRuntimeEvent,
    }),
  );
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
      isBusRuntimeEnabled: isTelegramBusRuntimeEnabled,
      ownsLock: lockRuntime.owns,
      isFollowerRegistered: telegramBusFollowerRegistrationState.isRegistered,
      startClassicPolling: pollingAdmissionRuntime.start,
      stopClassicPolling: pollingAdmissionRuntime.stop,
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
    onTransportAvailabilityChanged() {
      modelContextAvailabilityRuntime.reconcile();
      const ctx = telegramSessionContextStore.get();
      if (ctx) queueHandoffReconciliationBinding.request(ctx);
    },
    updateStatus,
    recordRuntimeEvent,
  });
  const {
    disconnect: disconnectTelegramAndDeleteCurrentThread,
    cleanupForSessionRestart: cleanupTelegramThreadForSessionRestart,
  } = Sync.createTelegramThreadDisconnectAssembly({
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
    suspendPolling: lockedPollingRuntime.suspend,
    recordRuntimeEvent,
  });
  const telegramBridgeSessionLifecycleDeps =
    Lifecycle.createTelegramBridgeSessionLifecycleDeps({
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
        discardQueuedItems: queueMutationRuntime.clear,
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
        getActiveProfileName: configStore.getActiveProfileName,
        getLeaderState: lockRuntime.getState,
        updateStatus,
        recordRuntimeEvent,
      },
      services: {
        mediaGroup: {
          resume: mediaGroupRuntime.resume,
          suspend: mediaGroupRuntime.suspend,
        },
        textGroup: {
          resume: textGroupRuntime.resume,
          suspend: textGroupRuntime.suspend,
        },
        delivery: deliveryLifecycleRuntime,
        polling: lockedPollingRuntime,
        inboundWorker: {
          onSessionShutdown: updateAdmissionRuntimeBinding.onSessionShutdown,
        },
        capabilityMonitor: telegramThreadCapabilityMonitor,
        queueWatchdog: queueDispatchWatchdogRuntime,
      },
    });
  const sessionLifecycleRuntime =
    Lifecycle.createTelegramBridgeSessionLifecycleAssembly(
      telegramBridgeSessionLifecycleDeps,
    );

  // --- Extension API Bindings ---

  Bindings.registerTelegramCommandsAndTools({
    pi,
    agentDir: Paths.resolveAgentDir(),
    configStore,
    persistConfig: persistTelegramConfigWithSync,
    setup,
    activeTurnRuntime,
    lockedPollingRuntime,
    stopPolling: disconnectTelegramAndDeleteCurrentThread,
    recoverPollingStart: Recovery.createTelegramPollingStartRecoveryHandler({
      getOwnersPath: Paths.resolveTelegramOwnersPath,
      getStatePaths() {
        return [
          Threads.getTelegramTopicTargetsPath(
            undefined,
            configStore.getActiveProfileName(),
          ),
        ];
      },
      suspendPolling: lockedPollingRuntime.suspend,
      releaseOwnership: lockRuntime.release,
      recordRuntimeEvent,
    }),
    getDisconnectThreadName() {
      const record = findCurrentThreadRecord();
      if (!record?.target.threadId) return undefined;
      return record.threadName ?? "current Telegram thread";
    },
    async renameCurrentThread(threadName) {
      const record = findCurrentThreadRecord();
      if (!record?.target.threadId) {
        return {
          ok: false,
          message: "No Threaded Mode tab is bound to this Pi instance.",
        };
      }
      const rename = Threads.createTelegramTopicTargetRenamer({
        store: threadStore,
        callApi: callTelegramApi,
      });
      const renamed = await rename({
        target: {
          chatId: record.target.chatId,
          threadId: record.target.threadId,
        },
        threadName,
        slot: record.slot,
      });
      if (!renamed) {
        return {
          ok: false,
          message:
            "Could not rename this tab. Use one unique capitalized Latin word that is not already used by a live tab.",
        };
      }
      await threadStore.persist();
      if (telegramBusFollowerRegistrationState.isRegistered()) {
        telegramBusFollowerRegistrationState.setRegistered(
          true,
          renamed.target,
          {
            slot: renamed.slot,
            threadName: renamed.threadName,
            generation: telegramBusFollowerRegistrationState.getGeneration(),
            leaderProtocol:
              telegramBusFollowerRegistrationState.getLeaderProtocol(),
          },
        );
      } else {
        telegramBusLeaderState.set({
          target: renamed.target,
          slot: renamed.slot,
          threadName: renamed.threadName,
        });
      }
      return {
        ok: true,
        threadName: renamed.threadName,
        message: `Telegram thread renamed to ${renamed.threadName}.`,
      };
    },
    onTransportChanged() {
      deliveryLifecycleRuntime.onSessionStart();
      activityVerbosityRuntime.reset();
      modelContextAvailabilityRuntime.reconcile();
    },
    getStatusLines,
    buttonActionStore,
    sendMarkdownReply,
    callMultipart,
    getDefaultChatId: proactivePushChatIdGetter,
    getDefaultTarget: proactivePushTargetGetter,
    ...agentMessageToolRoutingRuntime,
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
    activityVerbosityRuntime,
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
    modelContextAvailabilityRuntime,
    disconnectOnQuit: cleanupTelegramThreadForSessionRestart,
    resolveAutomaticThreadCleanupEnabled:
      configControls.resolveAutomaticThreadCleanupEnabled,
    buttonActionStore,
    callMultipart,
    sendChatAction,
    sendRecordVoiceAction,
    sendMarkdownReply,
    sendTextReply,
    dispatchNextQueuedTelegramTurn,
    onPromptHandedOff(turn, ctx) {
      updateAdmissionRuntimeBinding
        .getSettlement()
        ?.onPromptHandedOff(turn, ctx);
    },
    answerGuestQuery,
    deleteMessage: deleteTelegramMessage,
    sendGuestReply,
    finalizeMarkdownPreview,
    proactivePushTargetGetter,
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
