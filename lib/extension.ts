/**
 * Telegram bridge extension composition and orchestration layer
 * Zones: telegram, pi agent, orchestration
 * Keeps runtime wiring in one place while the package entrypoint remains a thin re-export
 */

import * as AgentMessages from "./agent-messages.ts";
import * as Bindings from "./bindings.ts";
import * as BusApi from "./bus-api.ts";
import * as BusFollower from "./bus-follower.ts";
import * as BusLeader from "./bus-leader.ts";
import * as BusTransport from "./bus-transport.ts";
import * as Bus from "./bus.ts";
import * as ChannelPosts from "./channel-posts.ts";
import * as ThreadCleanupManager from "./thread-cleanup-manager.ts";
import * as CommandTemplates from "./command-templates.ts";
import * as Commands from "./commands.ts";
import * as Config from "./config.ts";
import * as Delivery from "./delivery.ts";
import * as Inbound from "./inbound.ts";
import * as Journal from "./journal.ts";
import * as Lifecycle from "./lifecycle.ts";
import * as Locks from "./locks.ts";
import * as Logging from "./logging.ts";
import * as Media from "./media.ts";
import * as MenuQueue from "./menu-queue.ts";
import * as MenuSettings from "./menu-settings.ts";
import * as Menu from "./menu.ts";
import * as Model from "./model.ts";
import * as Outbound from "./outbound.ts";
import * as Ownership from "./ownership.ts";
import * as Paths from "./paths.ts";
import * as Pi from "./pi.ts";
import * as Polling from "./polling.ts";
import * as Preview from "./preview.ts";
import * as PromptTemplates from "./prompt-templates.ts";
import * as Prompts from "./prompts.ts";
import * as Queue from "./queue.ts";
import * as Recovery from "./recovery.ts";
import * as Replies from "./replies.ts";
import * as Routing from "./routing.ts";
import * as Runtime from "./runtime.ts";
import * as Sections from "./sections.ts";
import * as Skills from "./skills.ts";
import * as Status from "./status.ts";
import * as Sync from "./sync.ts";
import * as TelegramApi from "./telegram-api.ts";
import * as TextGroups from "./text-groups.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
import * as ThreadDisplay from "./thread-display.ts";
import * as Threads from "./threads.ts";
import * as TimeInjection from "./time-injection.ts";
import * as Updates from "./updates.ts";
import * as Voice from "./voice.ts";
import * as WorkspaceAdmission from "./workspace-admission.ts";
import * as WorkspaceRetirement from "./workspace-retirement.ts";

type ActivePiModel = NonNullable<Pi.ExtensionContext["model"]>;

const telegramBusProtocolIdentity =
  Bus.createTelegramCurrentBusProtocolIdentity([
    Bus.TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
    Bus.TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF,
    Bus.TELEGRAM_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT,
    Bus.TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME,
    Bus.TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE,
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
    Logging.createTelegramRuntimeDiagnosticsRuntime<Pi.ExtensionContext>();
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
  const workspaceAdmissionRuntime =
    WorkspaceAdmission.createTelegramWorkspaceAdmissionRuntimeBinding({
      getProfileName: configStore.getActiveProfileName,
      getBotToken: configStore.getBotToken,
      getPath: Paths.resolveTelegramWorkspaceAdmissionPath,
      owner: {
        processId: telegramProcessId,
        processBirthId: telegramQueueProcessBirthId,
      },
    });
  const telegramWorkspaceOperationRuntime =
    WorkspaceRetirement.createTelegramWorkspaceOperationRuntime({
      getWorkspaceAdmission: workspaceAdmissionRuntime.resolve,
      onReleaseError(error, operationKind) {
        recordRuntimeEvent("bus", error, {
          phase: "workspace-admission-release",
          operationKind,
        });
      },
    });
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
        getWorkspaceAdmission: workspaceAdmissionRuntime.resolve,
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
  const telegramJournalReferenceRegistry =
    Journal.createTelegramUpdateJournalReferenceRegistry();
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
    telegramProfile: function () {
      return configStore.getActiveProfileName();
    },
    canPersist: lockRuntime.owns,
    commitPersist: lockRuntime.commitIfOwned,
    getExternalReservedSlots: function () {
      return workspaceAdmissionRuntime.resolve()?.listReservedSlots() ?? [];
    },
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
    Outbound.createTelegramOutboundReplyPlanner(
      buttonActionStore,
      configControls.getAssistantRenderingMode,
    );
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
  const telegramApiTargetActivityRuntime =
    TelegramApi.createTelegramApiTargetActivityRuntime();
  const captureWorkspaceExternalProtection =
    WorkspaceRetirement.createTelegramWorkspaceExternalProtectionCapture({
      listFollowers: telegramBusFollowerRegistry.list,
      getActiveTurnTarget: activeTurnRuntime.getTarget,
      getQueuedItems: telegramQueueStore.getQueuedItems,
      resolveLeaderJournal: resolveTelegramUpdateJournalBinding,
      createFollowerJournalResolver:
        telegramJournalBindingRuntime.createRecipientResolver,
      withJournalReference(binding, operation) {
        if (!binding.recoveryKey) throw new Error(
          "Telegram workspace journal reference identity is unavailable.",
        );
        return telegramJournalReferenceRegistry.withReference({
          referenceClass: "workspace-retirement",
          recoveryKey: binding.recoveryKey,
        }, operation);
      },
      discoverFollowerJournals() {
        return Journal.discoverTelegramFollowerJournalPaths({
          directory: Paths.resolveTelegramTempDir(),
          profileName: configStore.getActiveProfileName(),
        });
      },
      createJournalPathResolver: telegramJournalBindingRuntime.createPathResolver,
      getJournalWriterProtection(journalBindingKey) {
        const owner = Threads.getTelegramThreadOwnerFromProfileKey(
          journalBindingKey,
        );
        if (owner.kind !== "manual-follower") return "unknown";
        const liveness = Bus.getTelegramProcessBirthIdentityLiveness(
          owner.instanceId,
        );
        return liveness === "alive"
          ? "protected"
          : liveness === "dead" ? "clear" : "unknown";
      },
      getDeliveryAuthorityProtection(binding) {
        return telegramApiTargetActivityRuntime.hasPendingTarget(binding.target)
          ? "protected"
          : "clear";
      },
    });
  const inactiveThreadCleanupReviewRuntime =
    ThreadCleanupManager.createTelegramInactiveThreadCleanupReviewRuntime({
      getProfileName() { return configStore.getActiveProfileName() ?? "default"; },
      listBindings: threadStore.listWorkspaceBindings,
      getProtection: captureWorkspaceExternalProtection,
      listReservations: threadStore.listReservations,
      listPendingProvisions: threadStore.listPendingProvisions,
      listPendingCleanups: threadStore.listPendingCleanups,
      getWorkStore() {
        const profileName = configStore.getActiveProfileName() ?? "default";
        const botToken = configStore.getBotToken();
        if (!botToken) throw new Error("Telegram Thread cleanup review requires an active bot token.");
        return ThreadCleanupManager.createTelegramThreadCleanupWorkStore({
          path: Paths.resolveTelegramThreadCleanupWorkPath(undefined, profileName),
          profileName,
          tokenSha256: Journal.createTelegramUpdateJournalBotIdentity({ botToken }).tokenSha256,
        });
      },
      runWorkspaceOperation: telegramWorkspaceOperationRuntime.run,
    });
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
    getDisplayTitle: getThreadDisplayTitle,
  } = Threads.createTelegramCurrentThreadAssembly({
    instanceId: telegramInstanceId,
    listRecords: threadStore.list,
    listWorkspaceBindings: threadStore.listWorkspaceBindings,
    getFollowerDisplayTitle: telegramBusFollowerRegistrationState.getDisplayTitle,
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
    getConfig: Status.createTelegramBridgeStatusConfigGetter(configStore),
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
      return Journal.withTelegramResolvedUpdateJournalReference({
        registry: telegramJournalReferenceRegistry,
        resolveBinding: resolveTelegramUpdateJournalBinding,
        referenceClass: "polling-cursor",
        operation(binding) { return binding.journal.read().acceptedThroughUpdateId; },
      });
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
      targetActivity: telegramApiTargetActivityRuntime,
      workspaceAdmission: workspaceAdmissionRuntime.resolve,
      captureRequestErrorHandler(body) {
        return Sync.captureTelegramStaleTargetRequestRecovery(body, {
          ...staleTopicApiErrorRecoveryDeps,
          getCurrentLeaderEpoch,
          getSessionGeneration: telegramSessionContextStore.getGeneration,
          getProfileName: configStore.getActiveProfileName,
          onRecovered: runtimeDiagnostics.scheduleSnapshotPersist,
        });
      },
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
      validateForwardOwnership:
        Bus.createTelegramBusForwardOwnershipValidator(telegramBusFollowerRegistry),
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

  // Answer guest queries immediately and replace the ACK with the final text.
  const answerGuestQueryForInlineMessage =
    telegramApiRuntime.answerGuestQueryForInlineMessage;
  const editGuestReply = Replies.createGuestMarkdownReplyEditor({
    editGuestInlineMessage: telegramApiRuntime.editGuestInlineMessage,
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
  const {
    activityRuntime,
    activityVerbosityRuntime,
    assistantOutputRuntime,
    publicationRuntime,
  } = Bindings.createTelegramActivityBindingRuntime({
    generation: deliveryGenerationSeed,
    assistantOutput: {
      prepareTelegramPreview: previewRuntime.preparePublication,
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
  const { finalizeMarkdownPreview, preparePreviewDelivery } =
    Outbound.createTelegramOutboundTextPreviewRuntime({
      finalizeMarkdownPreview: previewRuntime.finalizeMarkdown,
      preparePreviewDelivery: previewRuntime.prepareDelivery,
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
      reviewInactiveThreads: inactiveThreadCleanupReviewRuntime.review,
      getThreadDisplayMode() {
        return threadStore.getBotState().threadMode === "enabled"
          ? Config.resolveTelegramThreadDisplayMode(configStore.get()) : undefined;
      },
      async setThreadDisplayMode(mode) {
        try {
          await ThreadDisplay.applyTelegramThreadDisplaySetting(mode, {
            getProfileKey: configStore.getActiveProfileName,
            ownsLeader() { return getCurrentLeaderEpoch() !== undefined; },
            getLeaderSetter() { return telegramBusLeaderRuntime.setThreadDisplayMode; },
            getFollowerSetter() { return telegramBusFollowerRegistration.setThreadDisplayMode; },
            reloadConfig: configStore.load,
          });
        } catch (error) {
          recordRuntimeEvent("bus", error, { phase: "thread-display-setting" });
          throw error;
        }
      },
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
      runWorkspaceOperation: telegramWorkspaceOperationRuntime.run,
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
  const telegramThreadDisplayNameRenameBinding =
    Commands.createTelegramThreadDisplayNameRenameBinding();
  const telegramThreadDisplayNameResetBinding =
    Commands.createTelegramThreadDisplayNameResetBinding();
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
    getDisplayTitle: getThreadDisplayTitle,
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
    runWorkspaceOperation: telegramWorkspaceOperationRuntime.run,
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
    answerGuestQueryForInlineMessage,
    sendTextReply,
    setMyCommands,
    validateThreadName(threadName) {
      return Threads.getTelegramManualThreadDisplayNameValidationError(
        threadName,
      );
    },
    renameCurrentThread: telegramThreadDisplayNameRenameBinding.rename,
    resetCurrentThreadName: telegramThreadDisplayNameResetBinding.reset,
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
    getWorkspaceAdmission: workspaceAdmissionRuntime.resolve,
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
    acquireSourceReference(role, binding) {
      return telegramJournalReferenceRegistry.acquire({
        referenceClass: role === "leader" ? "leader-lifecycle" : "follower-lifecycle",
        recoveryKey: binding.recoveryKey,
      });
    },
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
      getWorkspaceAdmission: workspaceAdmissionRuntime.resolve,
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
    getDisplayTitle: getThreadDisplayTitle,
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
        getWorkspaceAdmission: workspaceAdmissionRuntime.resolve,
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
        onDisplayTitleChanged: updateStatus,
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
      canStart(ctx) {
        return telegramSessionContextStore.isCurrent(ctx) && lockRuntime.owns(ctx);
      },
      onPersistentConflict(ctx, count): Promise<void> {
        return lockedPollingRuntime.onPersistentConflict(ctx, count);
      },
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
          return Journal.withTelegramResolvedUpdateJournalReference({
            registry: telegramJournalReferenceRegistry,
            resolveBinding: resolveTelegramUpdateJournalBinding,
            referenceClass: "polling-cursor",
            operation(binding) { return binding.journal.read().acceptedThroughUpdateId; },
          });
        },
        async prepareCursorCutover() {
          const cutover = Journal.withTelegramResolvedUpdateJournalReference({
            registry: telegramJournalReferenceRegistry,
            resolveBinding: resolveTelegramUpdateJournalBinding,
            referenceClass: "polling-cursor",
            operation(binding) { return Polling.cutOverTelegramPollingCursor({
              getLegacyCursor: configStore.getLegacyPollingCursor,
              readJournal: binding.journal.read,
              publishJournalCursor(acceptedThroughUpdateId) {
                binding.journal.appendBatch([], acceptedThroughUpdateId);
              },
              async removeLegacyCursor() {
                configStore.removeLegacyPollingCursor();
                await persistTelegramConfigWithSync();
              },
            }); },
          });
          if (!cutover) throw new Error("Telegram update journal binding is unavailable.");
          await cutover;
        },
        getEntryCount: updateAdmissionLifecycleRuntime.getJournalEntryCount,
        signalWorker: updateAdmissionLifecycleRuntime.signal,
        getBootstrapEntryCount() {
          return Journal.withTelegramResolvedUpdateJournalReference({
            registry: telegramJournalReferenceRegistry,
            resolveBinding: resolveTelegramUpdateJournalBinding,
            referenceClass: "polling-bootstrap",
            operation(binding) { return binding.journal.read().entries.length; },
          }) ?? 0;
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
      getThreadDisplayMode() {
        return Config.resolveTelegramThreadDisplayMode(configStore.get());
      },
      persistThreadDisplayMode(mode, isCurrent) {
        return Config.setTelegramThreadDisplayMode(configStore, mode, isCurrent);
      },
      onThreadDisplayChanged() {
        const ctx = telegramSessionContextStore.get();
        if (ctx) updateStatus(ctx);
      },
      shouldForceFreshUnnamed:
        telegramThreadCapabilityState.shouldForceFreshLeaderThread,
      getRequestedThreadName:
        telegramThreadCapabilityState.getRequestedThreadName,
      topicTargetStore: threadStore,
      getWorkspaceAdmission: workspaceAdmissionRuntime.resolve,
      runWorkspaceOperation: telegramWorkspaceOperationRuntime.run,
      captureWorkspaceExternalProtection,
      callApi(method, body, options) {
        return directTelegramApiRuntime.call(method, body, options);
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
      restoreFollowerWithLeader(ctx, owner) {
        return telegramBusFollowerRegistration.registerWithLeader(ctx, owner, {
          restoreWorkspace: true,
        });
      },
      hasRememberedWorkspaceBinding(ctx) {
        return threadStore.hasWorkspaceBinding(Pi.getExtensionContextCwd(ctx));
      },
      suspendLiveThreadTarget: telegramBusLeaderState.clear,
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
    transportMonitor: telegramThreadCapabilityMonitor,
    hasBotToken: configStore.hasBotToken,
    getBotTokenDiagnostic: configStore.getBotTokenDiagnostic,
    canStartPolling: Pi.canStartPollingInExtensionContext,
    isContextCurrent: telegramSessionContextStore.isCurrent,
    formatStartBlockedMessage: Pi.formatPollingStartBlockedByRunMode,
    startPolling: threadAwarePollingPorts.startPolling,
    stopPolling: threadAwarePollingPorts.stopPolling,
    registerFollowerWithOwner:
      threadAwarePollingPorts.registerFollowerWithOwner,
    restoreFollowerWithOwner:
      threadAwarePollingPorts.restoreFollowerWithOwner,
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
    runWorkspaceOperation: telegramWorkspaceOperationRuntime.run,
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

  telegramThreadDisplayNameRenameBinding.bind({
    async rename(
      expectedTarget: Parameters<Commands.TelegramThreadDisplayNameRenamePort>[0],
      threadName: string,
    ) {
      try {
      if (telegramBusFollowerRegistrationState.isRegistered()) {
        if (typeof expectedTarget.threadId !== "number") {
          return { ok: false, message: "Telegram Workspace Thread target is unavailable." };
        }
        const renamedThreadName =
          await telegramBusFollowerRegistration.renameThread?.(
            { chatId: expectedTarget.chatId, threadId: expectedTarget.threadId },
            threadName,
          );
        if (!renamedThreadName) {
          return {
            ok: false,
            message: "Telegram follower Workspace Thread rename is unavailable.",
          };
        }
        return {
          ok: true,
          threadName: renamedThreadName,
        };
      }
      if (!ownsTelegramDirectDelivery()) {
        return {
          ok: false,
          message: "Telegram Workspace Thread rename requires an active leader or follower connection.",
        };
      }
      if (typeof expectedTarget.threadId !== "number") {
        return { ok: false, message: "Telegram Workspace Thread target is unavailable." };
      }
      const renamed = await telegramBusLeaderRuntime.renameLeaderThreadAdmitted(
        threadName,
        { chatId: expectedTarget.chatId, threadId: expectedTarget.threadId },
      );
      telegramBusLeaderState.set({
        target: renamed.target,
        slot: renamed.slot,
        threadName: renamed.manualThreadName ?? renamed.threadName,
      });
      return {
        ok: true,
        threadName: renamed.manualThreadName,
      };
      } catch (error) {
        return {
          ok: false,
          message:
            error instanceof Error
              ? error.message
              : "Telegram Workspace Thread rename failed.",
        };
      }
    },
  }.rename);
  telegramThreadDisplayNameResetBinding.bind({
    async reset(
      expectedTarget: Parameters<Commands.TelegramThreadDisplayNameResetPort>[0],
    ) {
      try {
        if (typeof expectedTarget.threadId !== "number") {
          return { ok: false, message: "Telegram Workspace Thread target is unavailable." };
        }
        const target = {
          chatId: expectedTarget.chatId,
          threadId: expectedTarget.threadId,
        };
        const wasFollower = telegramBusFollowerRegistrationState.isRegistered();
        const result = wasFollower
          ? await telegramBusFollowerRegistration.resetThreadName?.(target)
          : (await telegramBusLeaderRuntime.resetLeaderThreadName(target)).threadName;
        if (!result) {
          return { ok: false, message: "Thread display name reset is unavailable." };
        }
        const leaderTarget = telegramBusLeaderState.getTarget();
        if (!wasFollower && leaderTarget) {
          telegramBusLeaderState.set({ target: leaderTarget, threadName: result });
        }
        return {
          ok: true,
          threadName: result,
        };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error
            ? error.message : "Thread display name reset failed.",
        };
      }
    },
  }.reset);
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
    setRequestedThreadNameForPollingStart:
      telegramThreadCapabilityState.setRequestedThreadName,
    validateThreadName(threadName) {
      return Threads.getTelegramTopicThreadNameValidationError(
        threadName,
        undefined,
      );
    },
    onTransportChanged() {
      deliveryLifecycleRuntime.onSessionStart();
      activityVerbosityRuntime.reset();
      modelContextAvailabilityRuntime.reconcile();
    },
    getStatusLines,
    buttonActionStore,
    sendMarkdownReply,
    async sendChannelMarkdownMessage(channel, markdown, options) {
      if (!lockRuntime.owns()) {
        throw new Error("Telegram channel delivery requires direct leader transport ownership.");
      }
      const profileName = configStore.getActiveProfileName() ?? "default";
      const botToken = configStore.getBotToken();
      if (!botToken) throw new Error("Telegram channel delivery requires an active bot token.");
      const store = ChannelPosts.createTelegramChannelPostJournalStore({
        path: Paths.resolveTelegramChannelPostJournalPath(undefined, profileName),
        profileName,
        tokenSha256: Journal.createTelegramUpdateJournalBotIdentity({ botToken }).tokenSha256,
      });
      const record = await ChannelPosts.publishTelegramChannelPost({
        store, operationId: options.operationId,
        channel: channel as ChannelPosts.TelegramChannelPostAddress, markdown,
        async observeChannel(channelAddress) {
          return telegramApiRuntime.call("getChat", { chat_id: channelAddress });
        },
        async send(channelAddress, body) {
          const sent = await telegramApiRuntime.call<TelegramApi.TelegramSentMessage & {
            chat: { id: number; type: string };
          }>("sendRichMessage", { chat_id: channelAddress, rich_message: { markdown: body },
            ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}) });
          return { messageId: sent.message_id, chat: sent.chat };
        },
      });
      return record.state === "published" ? record.messageId : undefined;
    },
    async sendChannelMediaMessage(channel, mediaPath, markdown, options) {
      if (!lockRuntime.owns()) {
        throw new Error("Telegram channel media delivery requires direct leader transport ownership.");
      }
      const profileName = configStore.getActiveProfileName() ?? "default";
      const botToken = configStore.getBotToken();
      if (!botToken) throw new Error("Telegram channel media delivery requires an active bot token.");
      const media = await ChannelPosts.inspectTelegramChannelPostMedia(mediaPath);
      const caption = Replies.renderTelegramMarkdownToHtmlDraft(markdown);
      ChannelPosts.assertTelegramChannelPostCaptionWithinLimit(caption);
      const store = ChannelPosts.createTelegramChannelPostJournalStore({
        path: Paths.resolveTelegramChannelPostJournalPath(undefined, profileName),
        profileName,
        tokenSha256: Journal.createTelegramUpdateJournalBotIdentity({ botToken }).tokenSha256,
      });
      const record = await ChannelPosts.publishTelegramChannelPost({
        store, operationId: options.operationId,
        channel: channel as ChannelPosts.TelegramChannelPostAddress, markdown, media,
        async observeChannel(channelAddress) {
          return telegramApiRuntime.call("getChat", { chat_id: channelAddress });
        },
        async send(channelAddress) {
          const sent = await telegramApiRuntime.callMultipart<TelegramApi.TelegramSentMessage & {
            chat: { id: number; type: string };
          }>(media.kind === "photo" ? "sendPhoto" : "sendVideo", {
            chat_id: String(channelAddress),
            caption,
            parse_mode: "HTML",
            ...(options.replyMarkup ? { reply_markup: JSON.stringify(options.replyMarkup) } : {}),
          }, media.kind === "photo" ? "photo" : "video", mediaPath, media.fileName);
          return { messageId: sent.message_id, chat: sent.chat };
        },
      });
      return record.state === "published" ? record.messageId : undefined;
    },
    listChannelPosts(input) {
      const profileName = configStore.getActiveProfileName() ?? "default";
      const botToken = configStore.getBotToken();
      if (!botToken) throw new Error("Telegram channel posts require an active bot token.");
      return ChannelPosts.createTelegramChannelPostJournalStore({
        path: Paths.resolveTelegramChannelPostJournalPath(undefined, profileName),
        profileName,
        tokenSha256: Journal.createTelegramUpdateJournalBotIdentity({ botToken }).tokenSha256,
      }).list(input);
    },
    async mutateChannelPost(input) {
      if (!lockRuntime.owns()) throw new Error("Telegram channel post mutation requires direct leader ownership.");
      const profileName = configStore.getActiveProfileName() ?? "default";
      const botToken = configStore.getBotToken();
      if (!botToken) throw new Error("Telegram channel post mutation requires an active bot token.");
      const store = ChannelPosts.createTelegramChannelPostJournalStore({
        path: Paths.resolveTelegramChannelPostJournalPath(undefined, profileName), profileName,
        tokenSha256: Journal.createTelegramUpdateJournalBotIdentity({ botToken }).tokenSha256,
      });
      if (input.action === "edit") {
        if (!input.markdown) throw new Error("Telegram channel post edit requires markdown.");
        const current = store.get(input.operationId);
        const caption = current?.media
          ? Replies.renderTelegramMarkdownToHtmlDraft(input.markdown) : undefined;
        if (caption !== undefined) {
          ChannelPosts.assertTelegramChannelPostCaptionWithinLimit(caption);
        }
        const begun = store.beginEdit({ operationId: input.operationId,
          mutationId: input.mutationId, markdown: input.markdown });
        if (!begun.began) {
          if (begun.record.state === "published" && begun.record.lastMutationId === input.mutationId)
            return begun.record;
          throw new Error("Telegram channel post edit outcome is unknown; refusing automatic replay.");
        }
        if (begun.record.state !== "edit-outcome-unknown") throw new Error("Telegram channel post edit authority is invalid.");
        if (begun.record.media) {
          if (caption === undefined) {
            throw new Error("Telegram channel post media caption edit requires retained media identity.");
          }
          await telegramApiRuntime.call("editMessageCaption", { chat_id: begun.record.channelId,
            message_id: begun.record.messageId, caption, parse_mode: "HTML" });
        } else {
          await telegramApiRuntime.call("editMessageText", { chat_id: begun.record.channelId,
            message_id: begun.record.messageId,
            text: Replies.renderTelegramMarkdownToHtmlDraft(input.markdown), parse_mode: "HTML" });
        }
        return store.confirmEdited({ operationId: input.operationId, mutationId: input.mutationId }).record;
      }
      if (input.markdown !== undefined) throw new Error("Telegram channel post deletion does not accept markdown.");
      const begun = store.beginDelete({ operationId: input.operationId, mutationId: input.mutationId });
      if (!begun.began) {
        if (begun.record.state === "deleted" && begun.record.mutationId === input.mutationId) return begun.record;
        throw new Error("Telegram channel post deletion outcome is unknown; refusing automatic replay.");
      }
      if (begun.record.state !== "delete-outcome-unknown") throw new Error("Telegram channel post deletion authority is invalid.");
      await telegramApiRuntime.call("deleteMessage", { chat_id: begun.record.channelId,
        message_id: begun.record.messageId });
      return store.confirmDeleted({ operationId: input.operationId, mutationId: input.mutationId }).record;
    },
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
    publicationRuntime,
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
    editGuestReply,
    finalizeMarkdownPreview,
    preparePreviewDelivery,
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
