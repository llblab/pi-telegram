/**
 * Telegram bridge extension composition and orchestration layer
 * Zones: telegram, pi agent, orchestration
 * Keeps runtime wiring in one place while the package entrypoint remains a thin re-export
 */
import * as AgentMessages from "./agent-messages.js";
import * as Bindings from "./bindings.js";
import * as BusApi from "./bus-api.js";
import * as BusFollower from "./bus-follower.js";
import * as BusLeader from "./bus-leader.js";
import * as BusTransport from "./bus-transport.js";
import * as Bus from "./bus.js";
import * as ChannelPosts from "./channel-posts.js";
import * as CommandTemplates from "./command-templates.js";
import * as Commands from "./commands.js";
import * as Config from "./config.js";
import * as Delivery from "./delivery.js";
import * as Inbound from "./inbound.js";
import * as Journal from "./journal.js";
import * as Lifecycle from "./lifecycle.js";
import * as Locks from "./locks.js";
import * as Logging from "./logging.js";
import * as Media from "./media.js";
import * as MenuQueue from "./menu-queue.js";
import * as MenuSettings from "./menu-settings.js";
import * as Menu from "./menu.js";
import * as Model from "./model.js";
import * as Outbound from "./outbound.js";
import * as Ownership from "./ownership.js";
import * as Paths from "./paths.js";
import * as Pi from "./pi.js";
import * as Polling from "./polling.js";
import * as Preview from "./preview.js";
import * as ProcessIdentity from "./process-identity.js";
import * as PromptTemplates from "./prompt-templates.js";
import * as Prompts from "./prompts.js";
import * as Queue from "./queue.js";
import * as Recovery from "./recovery.js";
import * as Replies from "./replies.js";
import * as Routing from "./routing.js";
import * as Runtime from "./runtime.js";
import * as Sections from "./sections.js";
import * as Skills from "./skills.js";
import * as Status from "./status.js";
import * as Sync from "./sync.js";
import * as Targets from "./target.js";
import * as TelegramApi from "./telegram-api.js";
import * as TextGroups from "./text-groups.js";
import * as ThreadCleanupManager from "./thread-cleanup-manager.js";
import * as ThreadDisplay from "./thread-display.js";
import * as ThreadNaming from "./thread-naming.js";
import * as ThreadReconciler from "./thread-reconciler.js";
import * as Threads from "./threads.js";
import * as TimeInjection from "./time-injection.js";
import * as Updates from "./updates.js";
import * as Voice from "./voice.js";
import * as WorkspaceAdmission from "./workspace-admission.js";
import * as WorkspaceRetirement from "./workspace-retirement.js";
const telegramBusProtocolIdentity = Bus.createTelegramCurrentBusProtocolIdentity([
    Bus.TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
    Bus.TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF,
    Bus.TELEGRAM_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT,
    Bus.TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME,
    Bus.TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE,
    Bus.TELEGRAM_BUS_CAPABILITY_DIRECTORY_DISPLAY_FORMAT,
    Bus.TELEGRAM_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT,
    Bus.TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE,
    Bus.TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SAVE,
    Bus.TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY,
    Bus.TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SETTLE,
    Bus.TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_COMMAND_SET,
    Bus.TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY,
]);
// --- Extension Runtime ---
export default function (pi) {
    Skills.registerTelegramSkillDiscovery(pi);
    const piRuntime = Pi.createExtensionApiRuntimePorts(pi);
    const { getActiveTools, getCommands, getThinkingLevel, sendUserMessage, registerCommand, setActiveTools, setModel, setThinkingLevel, } = piRuntime;
    const bridgeRuntime = Runtime.createTelegramBridgeRuntime();
    const runtimeDiagnostics = Logging.createTelegramRuntimeDiagnosticsRuntime({
        sharedFile: true,
    });
    const runtimeEvents = runtimeDiagnostics.events;
    const recordRuntimeEvent = runtimeDiagnostics.recordRuntimeEvent;
    const configStore = Config.createTelegramConfigStore({ recordRuntimeEvent });
    const busProcessRuntime = Bus.createCurrentTelegramBusProcessRuntime({
        getActiveProfileName: configStore.getActiveProfileName,
        endpointLayout: "consolidated",
    });
    const { instanceId: telegramInstanceId, processId: telegramProcessId, processBirthId: telegramQueueProcessBirthId, manualFollowerOwnerId: telegramManualFollowerOwnerId, getLeaderSocketPath: getTelegramBusSocketPath, getFollowerSocketPath: getTelegramBusFollowerSocketPath, } = busProcessRuntime;
    const getTelegramBotId = Config.createTelegramConfigBotIdGetter(configStore);
    const workspaceAdmissionRuntime = WorkspaceAdmission.createTelegramWorkspaceAdmissionRuntimeBinding({
        getProfileName: configStore.getActiveProfileName,
        getBotToken: configStore.getBotToken,
        getStatePath: Paths.resolveTelegramStatePath,
        owner: {
            processId: telegramProcessId,
            processBirthId: telegramQueueProcessBirthId,
        },
    });
    const telegramWorkspaceOperationRuntime = WorkspaceRetirement.createTelegramWorkspaceOperationRuntime({
        getWorkspaceAdmission: workspaceAdmissionRuntime.resolve,
        onReleaseError(error, operationKind) {
            recordRuntimeEvent("bus", error, {
                phase: "workspace-admission-release",
                operationKind,
            });
        },
    });
    const getTelegramActiveProfileKey = Config.createTelegramActiveProfileKeyGetter(configStore);
    const getTelegramManualFollowerProfileKey = BusFollower.createTelegramManualFollowerProfileKeyResolver({
        getActiveProfileName: configStore.getActiveProfileName,
        manualFollowerOwnerId: telegramManualFollowerOwnerId,
    });
    const telegramBusAuthSecret = Bus.createTelegramBusAuthSecret();
    const telegramBusFollowerControlState = BusFollower.createTelegramBusFollowerControlState();
    const telegramBusFollowerRegistry = Bus.createTelegramBusFollowerRegistry();
    const modelContextAvailabilityBinding = Prompts.createTelegramModelContextAvailabilityBinding();
    const telegramBusFollowerRegistrationState = BusFollower.createTelegramBusFollowerRegistrationState({
        onAvailabilityChanged: modelContextAvailabilityBinding.reconcile,
    });
    const telegramBusLeaderState = Threads.createTelegramLeaderThreadStateRuntime();
    const telegramThreadCapabilityState = Polling.createTelegramThreadCapabilityStateRuntime();
    const telegramProvisioningActivity = Sync.createTelegramProvisioningActivityRuntime();
    const messageOwnershipRuntime = Ownership.createTelegramBusMessageOwnershipRuntime({
        instanceId: telegramInstanceId,
        getProfileKey: getTelegramActiveProfileKey,
        listFollowers: telegramBusFollowerRegistry.list,
    });
    const { abort, lifecycle, queue, setup, typing } = bridgeRuntime;
    const getTelegramUpdateAdmissionScope = Journal.createTelegramUpdateJournalReceiptScopeResolver({
        getProfileName: configStore.getActiveProfileName,
        getBotToken: configStore.getBotToken,
        getBotId: getTelegramBotId,
    });
    const telegramLeaderJournalPath = Locks.createTelegramLeaderJournalPathResolver({
        getNamedJournalPath() {
            return lockRuntime.getJournalPath();
        },
        getSessionId() {
            return Pi.getExtensionContextSessionId(telegramSessionContextStore.get());
        },
        getProfileName: configStore.getActiveProfileName,
    });
    const withTelegramJournalSourceSerialization = Journal.createTelegramJournalSourceSerialization();
    const telegramJournalBindingRuntime = Journal.createTelegramUpdateJournalBindingRuntime({
        base: {
            getProfileName: configStore.getActiveProfileName,
            getBotToken: configStore.getBotToken,
            getBotId: getTelegramBotId,
            withSourceSerialization: withTelegramJournalSourceSerialization,
            onRecovery(event) {
                recordRuntimeEvent("recovery", event.kind === "repaired"
                    ? "Telegram update journal was repaired automatically."
                    : "Telegram update journal was reset after its damaged files were deleted.", {
                    phase: "journal-auto-recovery",
                    recoveryKind: event.kind,
                    journalPath: event.path,
                    revision: event.revision,
                    deletedPaths: event.deletedPaths,
                    reason: event.reason,
                });
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
        getLeaderJournalPath: telegramLeaderJournalPath.resolve,
        getRuntimeDir: Paths.resolveTelegramTempDir,
        getFollowerJournalPath(bindingKey, profileName, sessionId) {
            if (sessionId !== undefined)
                return Paths.resolveTelegramSessionJournalPath(sessionId, bindingKey, undefined, profileName);
            return Paths.resolveTelegramFollowerJournalPath(bindingKey, undefined, profileName);
        },
        getActiveFollowerBindingKey: getTelegramManualFollowerProfileKey,
        getActiveFollowerSessionId() {
            return telegramBusFollowerRegistrationState.getSessionId(Pi.getExtensionContextSessionId(telegramSessionContextStore.get()));
        },
        isFollowerRegistered: telegramBusFollowerRegistrationState.isRegistered,
    });
    const telegramJournalReferenceRegistry = Journal.createTelegramUpdateJournalReferenceRegistry();
    const resolveTelegramUpdateJournalBinding = telegramJournalBindingRuntime.resolveLeader;
    const resolveTelegramFollowerJournalBinding = telegramJournalBindingRuntime.resolveFollower;
    const getTelegramQueueJournalBinding = telegramJournalBindingRuntime.getActiveRecoveryKey;
    const isTelegramBusRuntimeEnabled = telegramThreadCapabilityState.isBusRuntimeEnabled;
    const configControls = Config.createTelegramConfigControls(configStore);
    const lockRuntime = Locks.createTelegramLockRuntime({
        key: Locks.createTelegramLockKeyResolver(configStore),
        statePath: Paths.resolveTelegramStatePath(),
        instanceId: telegramInstanceId,
        busSecret: telegramBusAuthSecret,
        staleHeartbeatMs: Locks.TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS,
        legacyLocksPath: Paths.resolveLegacyTelegramOwnersPath(),
        createJournalPath() {
            return telegramLeaderJournalPath.createJournalPath();
        },
    });
    const proveTelegramLeaderUnresponsive = Bus.createTelegramBusLeaderUnresponsivenessProof({
        getLeaderState: lockRuntime.getState,
        getLeaderSocketPath: getTelegramBusSocketPath,
    });
    const telegramSessionContextStore = Lifecycle.createTelegramSessionContextStore({
        getIdentity(ctx) {
            return ctx.sessionManager ?? ctx.cwd;
        },
    });
    const captureTelegramStateAuthority = Locks.createTelegramOwnedStateAuthorityCapture(lockRuntime, telegramSessionContextStore);
    const threadStore = Threads.createTelegramTopicTargetStore({
        path: Paths.resolveTelegramStatePath,
        telegramProfile: function () {
            return configStore.getActiveProfileName();
        },
        canPersist: lockRuntime.owns,
        consolidated: {
            captureAuthority: captureTelegramStateAuthority,
            publishIfOwned: lockRuntime.publishStateSectionIfOwned,
        },
        getExternalReservedSlots: function () {
            return workspaceAdmissionRuntime.resolve()?.listReservedSlots() ?? [];
        },
    });
    const resolveWorkspaceRestoreStore = Threads.createTelegramWorkspaceRestoreResolver({
        getProfileName: configStore.getActiveProfileName,
        getBotToken: configStore.getBotToken,
        threadStore,
    });
    runtimeDiagnostics.bindStorage({
        getBotToken: configStore.getBotToken,
        getProfileName: configStore.getActiveProfileName,
        canReset: lockRuntime.owns,
        commitReset: lockRuntime.commitIfOwned,
        captureAuthority: captureTelegramStateAuthority,
    });
    const sessionActionAssembly = Commands.createTelegramSessionActionAssembly({
        registerCommand,
        sendUserMessage,
        store: threadStore,
        getProfileName: configStore.getActiveProfileName,
        ownsPersistence: lockRuntime.owns,
        follower: {
            instanceId: telegramInstanceId,
            isRegisteredFor(target) {
                const registered = telegramBusFollowerRegistrationState.getTarget();
                return (telegramBusFollowerRegistrationState.isRegistered() &&
                    registered?.chatId === target.chatId &&
                    registered.threadId === target.threadId);
            },
            async requestSessionReplacement(operation, intent) {
                const request = telegramBusFollowerRegistration.requestSessionReplacement;
                if (!request)
                    return false;
                return await request(operation, intent);
            },
        },
        async sendResult(target, html) {
            const delivery = await Delivery.sendTelegramView({ text: html, parseMode: "html", replyMarkup: { inline_keyboard: [] } }, { scope: { kind: "target", target } });
            return delivery.ok
                ? { ok: true }
                : {
                    ok: false,
                    retryable: delivery.reason === "runtime-unavailable" ||
                        delivery.reason === "target-unavailable" ||
                        delivery.reason === "transport-retryable",
                };
        },
        handoffTtlMs: Threads.TELEGRAM_LEADER_SESSION_HANDOFF_TTL_MS,
        recordRuntimeEvent,
    });
    const sessionActionsRuntime = sessionActionAssembly.action;
    const lockOwnershipGuard = Locks.createTelegramLockOwnershipGuard(lockRuntime);
    const getCurrentLeaderEpoch = lockRuntime.getOwnedLeaderEpoch;
    const ownsTelegramDirectDelivery = Locks.createTelegramDirectDeliveryOwnershipChecker({
        lock: lockRuntime,
        contextStore: telegramSessionContextStore,
    });
    const modelContextAvailabilityRuntime = Prompts.createTelegramModelContextAvailabilityRuntime({
        getActiveTools,
        setActiveTools,
        isAvailable() {
            return (ownsTelegramDirectDelivery() ||
                telegramBusFollowerRegistrationState.isRegistered());
        },
        canReconcile() {
            const ctx = telegramSessionContextStore.get();
            return !ctx || Pi.isExtensionContextIdle(ctx);
        },
    });
    modelContextAvailabilityBinding.bind(modelContextAvailabilityRuntime);
    const activeTurnRuntime = Queue.createTelegramActiveTurnStore();
    const proactivePushTargetGetter = Config.createTelegramProactivePushTargetGetter({
        getActiveTurnTarget: activeTurnRuntime.getTarget,
        getAssignedTarget() {
            return (telegramBusFollowerRegistrationState.getTarget() ??
                telegramBusLeaderState.getTarget());
        },
        getAllowedUserId: configStore.getAllowedUserId,
    });
    const proactivePushChatIdGetter = Config.createTelegramProactivePushChatIdGetter(proactivePushTargetGetter);
    const buttonActionStore = Outbound.createTelegramButtonActionStore();
    const planGenerativeAppOutput = Outbound.createTelegramOutboundReplyPlanner(buttonActionStore, configControls.getAssistantRenderingMode);
    const pendingModelSwitchStore = Model.createPendingModelSwitchStore();
    const modelMenuRuntime = Menu.createTelegramModelMenuRuntime();
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
    const mediaGroupRuntime = Media.createTelegramMediaGroupController();
    const textGroupRuntime = TextGroups.createTelegramTextGroupController();
    const rawTelegramQueueStore = Queue.createTelegramQueueStore();
    const telegramTransportStampRuntime = Queue.createTelegramTransportStampRuntime({
        getProfileName: configStore.getActiveProfileName,
        getBotToken: configStore.getBotToken,
    });
    const telegramQueueStore = Queue.createTelegramTransportStampedQueueStore(rawTelegramQueueStore, telegramTransportStampRuntime.getStamp);
    const telegramApiTargetActivityRuntime = TelegramApi.createTelegramApiTargetActivityRuntime();
    // Retirement protection and dead-owner reclamation must inspect the same journal sources.
    const workspaceRetirementJournalPorts = {
        getActiveTurnTarget: activeTurnRuntime.getTarget,
        getQueuedItems: telegramQueueStore.getQueuedItems,
        resolveLeaderJournal: resolveTelegramUpdateJournalBinding,
        createFollowerJournalResolver: telegramJournalBindingRuntime.createLegacyRecipientResolver,
        createSessionJournalResolver: telegramJournalBindingRuntime.createRecipientResolver,
        createJournalPathResolver: telegramJournalBindingRuntime.createPathResolver,
        discoverFollowerJournals() {
            return Journal.discoverTelegramRecipientJournalPaths({
                directory: Paths.resolveTelegramTempDir(),
                profileName: configStore.getActiveProfileName(),
            });
        },
    };
    const workspaceProtectionObserver = WorkspaceRetirement.createTelegramWorkspaceProtectionObserver({
        listFollowers: telegramBusFollowerRegistry.list,
        ...workspaceRetirementJournalPorts,
        withJournalReference(binding, operation) {
            if (!binding.recoveryKey)
                throw new Error("Telegram workspace journal reference identity is unavailable.");
            return telegramJournalReferenceRegistry.withReference({
                referenceClass: "workspace-retirement",
                recoveryKey: binding.recoveryKey,
            }, operation);
        },
        inspectJournalNamespace() {
            const botToken = configStore.getBotToken();
            if (!botToken)
                throw new Error("Telegram namespace inspection requires current bot identity.");
            return Journal.inspectTelegramSessionJournalNamespace({
                directory: Paths.resolveTelegramTempDir(),
                profile: configStore.getActiveProfileName() ?? "default",
                pollingPath: telegramLeaderJournalPath.resolve(configStore.getActiveProfileName()),
                botIdentity: Journal.createTelegramUpdateJournalBotIdentity({
                    botToken,
                    botId: getTelegramBotId(),
                }),
                limits: {
                    maxDirectoryEntries: 10_000,
                    maxFiles: 4096,
                    maxBytes: 64 * 1024 * 1024,
                    maxEntries: 10_000,
                    maxWork: 100_000,
                },
            });
        },
        getJournalWriterProtection(journalBindingKey) {
            const owner = Threads.getTelegramThreadOwnerFromProfileKey(journalBindingKey);
            if (owner.kind !== "manual-follower")
                return "unknown";
            const liveness = ProcessIdentity.getTelegramProcessBirthIdentityLiveness(owner.instanceId);
            return liveness === "alive"
                ? "protected"
                : liveness === "dead"
                    ? "clear"
                    : "unknown";
        },
        getDeliveryAuthorityProtection(binding) {
            const retainedRestore = resolveWorkspaceRestoreStore()
                ?.list()
                .some(function (intent) {
                return (intent.request.binding.bindingKey === binding.bindingKey ||
                    Targets.areTelegramTargetsEqual(intent.request.binding.target, binding.target) ||
                    Targets.areTelegramTargetsEqual(intent.request.target, binding.target));
            });
            return retainedRestore ||
                telegramApiTargetActivityRuntime.hasPendingTarget(binding.target)
                ? "protected"
                : "clear";
        },
    });
    const captureWorkspaceExternalProtection = workspaceProtectionObserver.capture;
    const pruneWorkspaceJournalEvidence = WorkspaceRetirement.createTelegramWorkspaceJournalEvidencePruner({
        store: threadStore,
        getAdmission: workspaceAdmissionRuntime.resolve,
        getLeaderEpoch: getCurrentLeaderEpoch,
        runExclusive: telegramWorkspaceOperationRuntime.runExclusive,
        protection: workspaceProtectionObserver,
    });
    const reclaimTelegramWorkspaceDeadOwnerQueue = WorkspaceRetirement.createTelegramWorkspaceDeadOwnerQueueReclaimer({
        getExternalProtection: captureWorkspaceExternalProtection,
        ...workspaceRetirementJournalPorts,
        withJournalReference(binding, operation) {
            if (!binding.recoveryKey)
                throw new Error("Telegram workspace journal reference identity is unavailable.");
            return telegramJournalReferenceRegistry.withReference({
                referenceClass: "workspace-retirement",
                recoveryKey: binding.recoveryKey,
            }, operation);
        },
        getRecoveryOwner() {
            return {
                instanceId: telegramInstanceId,
                processId: telegramProcessId,
                processBirthId: telegramQueueProcessBirthId,
                sessionGeneration: telegramSessionContextStore.getGeneration(),
            };
        },
        getQueueOwnerLiveness: ProcessIdentity.getTelegramProcessLiveness,
        onMutationError(error) {
            recordRuntimeEvent("Telegram dead-owner queue reclamation was refused.", {
                error: error instanceof Error ? error.message : String(error),
            });
        },
        isBindingCurrent(binding) {
            return WorkspaceRetirement.isCurrentTelegramWorkspaceBinding(threadStore, binding);
        },
    });
    const inactiveThreadCleanupReviewRuntime = ThreadCleanupManager.createTelegramInactiveThreadCleanupReviewRuntime({
        getProfileName() {
            return configStore.getActiveProfileName() ?? "default";
        },
        listBindings: threadStore.listWorkspaceBindings,
        getProtection: captureWorkspaceExternalProtection,
        listReservations: threadStore.listReservations,
        listPendingProvisions: threadStore.listPendingProvisions,
        listPendingCleanups: threadStore.listPendingCleanups,
        getWorkStore() {
            const profileName = configStore.getActiveProfileName() ?? "default";
            const botToken = configStore.getBotToken();
            if (!botToken)
                throw new Error("Telegram Thread cleanup review requires an active bot token.");
            return ThreadCleanupManager.createTelegramThreadCleanupWorkStore({
                ...Paths.resolveTelegramServiceJournalStorage("thread-cleanup", undefined, profileName),
                profileName,
                tokenSha256: Journal.createTelegramUpdateJournalBotIdentity({
                    botToken,
                }).tokenSha256,
            });
        },
        runWorkspaceOperation: telegramWorkspaceOperationRuntime.run,
    });
    const updateAdmissionRuntimeBinding = Updates.createTelegramUpdateAdmissionRuntimeBinding({
        isFollowerRegistered: telegramBusFollowerRegistrationState.isRegistered,
    });
    const deferredQueueDispatchRuntime = Queue.createTelegramDeferredQueueDispatchRuntime({
        recordRuntimeEvent,
    });
    const pollingControllerState = Polling.createTelegramPollingControllerState();
    const telegramSyncStateRuntime = Sync.createTelegramSyncStateRuntime();
    const threadReconciliationRuntime = ThreadReconciler.createThreadReconciliationRuntime({
        recordRuntimeEvent,
        scheduleSnapshotPersist: runtimeDiagnostics.scheduleSnapshotPersist,
    });
    const recordThreadReconciliationPlan = threadReconciliationRuntime.recordPlan;
    const persistTelegramConfigWithSync = Sync.createTelegramConfigSyncPersister({
        persist: configStore.persist,
        markConfigChange: telegramSyncStateRuntime.markConfigChange,
    });
    const { current: currentInstanceThreadRuntime, status: threadStatusProjectionRuntime, getDisplayTitle: getThreadDisplayTitle, } = Threads.createTelegramCurrentThreadAssembly({
        instanceId: telegramInstanceId,
        listRecords: threadStore.list,
        listWorkspaceBindings: threadStore.listWorkspaceBindings,
        resolveAutomaticDisplayTitle(binding) {
            return ThreadDisplay.resolveTelegramInitialWorkspaceDisplayName({
                bindings: threadStore.listWorkspaceBindings(),
                binding,
                mode: Config.resolveTelegramThreadDisplayMode(configStore.get()),
            });
        },
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
    const getCurrentInstanceThreadIdentity = currentInstanceThreadRuntime.getIdentity;
    const statusRuntime = Status.createTelegramBridgeStatusRuntime({
        getConfig: Status.createTelegramBridgeStatusConfigGetter(configStore),
        getActiveProfileName: configStore.getActiveProfileName,
        getDiagnosticPaths: Paths.getTelegramDiagnosticsDisplayPaths,
        isPollingActive: Polling.createTelegramPollingActivityReader(pollingControllerState),
        getPollingState: Polling.createTelegramPollingStateReader(pollingControllerState),
        getInboundWorkerState() {
            return updateAdmissionRuntimeBinding.getActive()?.getState();
        },
        getAcceptedThroughUpdateId() {
            return Journal.withTelegramResolvedUpdateJournalReference({
                registry: telegramJournalReferenceRegistry,
                resolveBinding: resolveTelegramUpdateJournalBinding,
                referenceClass: "polling-cursor",
                operation(binding) {
                    return binding.journal.read().acceptedThroughUpdateId;
                },
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
        session: telegramSessionContextStore,
        async persistSnapshot(snapshot) {
            threadStore.setStatusSnapshot(snapshot);
            await threadStore.persistStatus();
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
    const directTelegramApiRuntime = TelegramApi.createDefaultTelegramBridgeApiRuntime({
        getBotToken: configStore.getBotToken,
        getBotScope() {
            const config = configStore.get();
            return (config.botUsername ??
                (config.botId === undefined ? undefined : String(config.botId)));
        },
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
    const telegramBusFollowerClients = BusFollower.createTelegramBusFollowerClientRuntime({
        socketPath: getTelegramBusSocketPath,
        instanceId: telegramInstanceId,
        getApiAuthSecret: telegramBusFollowerControlState.getActiveAuthSecret,
        getForwardingAuthSecret() {
            return telegramBusAuthSecret;
        },
        getRegistrationGeneration: telegramBusFollowerRegistrationState.getGeneration,
        waitForRegistrationGeneration: telegramBusFollowerRegistrationState.waitForGeneration,
        getForwardCommentBatchPosition: textGroupRuntime.getPreparedForwardingPosition,
        validateForwardOwnership: Bus.createTelegramBusForwardOwnershipValidator(telegramBusFollowerRegistry),
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
    const { call: callTelegramApi, callMultipart, deleteWebhook, getUpdates, setMyCommands, sendTypingAction, sendChatAction, sendRecordVoiceAction, sendMessageDraft, sendMessage, sendRichMessage, sendRichMessageDraft, downloadFile: downloadTelegramBridgeFile, editMessageText: editTelegramMessageText, editMessageReplyMarkup: editTelegramMessageReplyMarkup, answerCallbackQuery, answerGuestQuery, deleteMessage: deleteTelegramMessage, prepareTempDir, } = telegramApiRuntime;
    // --- Message Delivery ---
    const sendGuestReply = Replies.createGuestMarkdownReplySender({
        answerGuestQuery,
    });
    // Answer guest queries immediately and replace the ACK with the final text.
    const answerGuestQueryForInlineMessage = telegramApiRuntime.answerGuestQueryForInlineMessage;
    const editGuestReply = Replies.createGuestMarkdownReplyEditor({
        editGuestInlineMessage: telegramApiRuntime.editGuestInlineMessage,
    });
    // Rotate the guest placeholder frames until the final replacement stops them.
    const guestPlaceholderRuntime = Replies.createTelegramGuestPlaceholderRuntime({
        editGuestInlineMessage: telegramApiRuntime.editGuestInlineMessage,
        recordRuntimeEvent,
    });
    const promptDispatchRuntime = Runtime.createTelegramPromptDispatchRuntime({
        lifecycle,
        typing,
        getDefaultChatId: proactivePushChatIdGetter,
        sendTypingAction,
        updateStatus,
        isContextActive: telegramSessionContextStore.isCurrent,
        getTransportAuthority() {
            if (ownsTelegramDirectDelivery()) {
                const epoch = getCurrentLeaderEpoch();
                return epoch === undefined ? undefined : `direct:${epoch}`;
            }
            if (!telegramBusFollowerRegistrationState.isRegistered())
                return undefined;
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
    const { replyTransport, editInteractiveMessage, sendInteractiveMessage, sendSectionRichMessage, } = replyRuntime;
    const deliveryTargetPolicyRuntime = Delivery.createTelegramDeliveryTargetPolicyRuntime({
        ownsDirect: lockRuntime.owns,
        isFollowerRegistered: telegramBusFollowerRegistrationState.isRegistered,
        getAllowedChatId: configStore.getAllowedUserId,
        getFollowerTarget: telegramBusFollowerRegistrationState.getTarget,
        getLeaderTarget: telegramBusLeaderState.getTarget,
        listThreadRecords: threadStore.list,
        getActiveTurnTarget: activeTurnRuntime.getTarget,
        getActiveGuestQueryId: activeTurnRuntime.getGuestQueryId,
    });
    const deliveryGenerationSeed = Delivery.createTelegramDeliveryGenerationSeed(telegramInstanceId);
    const deliveryLifecycleRuntime = Delivery.createTelegramBridgeDeliveryLifecycleHooks({
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
    const { sendTextReply, sendMarkdownReply } = Outbound.createTelegramOutboundTextReplyRuntime({
        sendTextReply: replyRuntime.sendTextReply,
        sendMarkdownReply: replyRuntime.sendMarkdownReply,
        execCommand: CommandTemplates.execCommandTemplate,
        getHandlers: configStore.getOutboundHandlers,
        recordRuntimeEvent,
    });
    const generativeAppLiveSurfaceBinding = Bindings.createTelegramGenerativeAppLiveSurfaceBinding();
    const invokeGenerativeAppBoundButtonAction = Bindings.createTelegramGenerativeAppBoundButtonActionInvoker({
        agentDir: Paths.resolveAgentDir(),
        assertExecutionCurrent: Updates.assertTelegramUpdateExecutionCurrent,
        getExecutionFence: Updates.getTelegramUpdateExecutionFence,
        getActiveProfileName: configStore.getActiveProfileName,
        getLiveSurfaceRuntime: generativeAppLiveSurfaceBinding.get,
        planOutput: planGenerativeAppOutput,
        sendMarkdownReply,
        editInteractiveMessage,
        recordRuntimeEvent,
    });
    const nativeMarkdownDraftSender = TelegramApi.createTelegramAssistantDraftSender({
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
    const { activityRuntime, activityVerbosityRuntime, assistantOutputRuntime, publicationRuntime, } = Bindings.createTelegramActivityBindingRuntime({
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
                getFollowerGeneration: telegramBusFollowerRegistrationState.getGeneration,
            },
            sender: {
                recordOwnership: messageOwnershipRuntime.recordLocal,
                sendMessage,
                sendRichMessage,
                editMessage: editTelegramMessageText,
                getAssistantRenderingMode: configControls.getAssistantRenderingMode,
                planButtonReply: Outbound.createTelegramButtonReplyPlanner(buttonActionStore),
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
    const { mutation: queueMutationRuntime, dispatchNext: dispatchNextQueuedTelegramTurn, requestNextDispatchAnnouncement, cancelNextDispatchAnnouncement, watchdog: queueDispatchWatchdogRuntime, } = Bindings.createTelegramQueueBindingRuntime({
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
        reconcileNextDispatchAnnouncementReplyOwnership(item) {
            Replies.preserveTransportReplyDedupOnNextReset(item.chatId, item.replyToMessageId, item.target);
        },
        recordRuntimeEvent,
    });
    const { finalizeMarkdownPreview, preparePreviewDelivery } = Outbound.createTelegramOutboundTextPreviewRuntime({
        finalizeMarkdownPreview: previewRuntime.finalizeMarkdown,
        preparePreviewDelivery: previewRuntime.prepareDelivery,
        execCommand: CommandTemplates.execCommandTemplate,
        getHandlers: configStore.getOutboundHandlers,
        recordRuntimeEvent,
    });
    // --- Model And Menu Setup ---
    const modelSwitchController = Model.createTelegramModelSwitchControllerRuntime({
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
    const getQueueItemCount = Queue.createTelegramQueueItemCountGetter(telegramQueueStore);
    const getPromptTemplateCommands = PromptTemplates.createTelegramPromptTemplateCommandGetter({
        getCommands,
        getReservedCommandNames: Commands.getTelegramReservedCommandNames,
    });
    const getQueueMenuState = Menu.createTelegramModelMenuStateBuilder({
        runtime: modelMenuRuntime,
        createSettingsManager: Pi.createSettingsManager,
        getActiveModel: currentModelRuntime.get,
    });
    const menuActionPorts = {
        getModelMenuState: getQueueMenuState,
        getActiveModel: currentModelRuntime.get,
        getThinkingLevel,
        getQueueItemCount,
        getPendingCancellationCount() {
            return getCurrentLeaderEpoch() === undefined
                ? 0
                : (updateAdmissionRuntimeBinding.getActive()?.getState()
                    ?.abandoningClaimCount ?? 0);
        },
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
        sectionRegistry,
        // Menu/status UI uses this to reflect whether the active Telegram turn expects voice delivery.
        isVoiceReplyActive: function () {
            const turn = activeTurnRuntime.get();
            return Voice.isVoiceTurn(turn);
        },
    };
    const menuActions = Menu.createTelegramMenuActionRuntime({
        ...menuActionPorts,
        sendTextReply,
        editInteractiveMessage,
        sendInteractiveMessage,
    });
    // --- Queue And Settings Menus ---
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
        dismissGuestPlaceholder: guestPlaceholderRuntime.dismiss,
    });
    const threadDisplaySettingsRuntime = ThreadDisplay.createTelegramThreadDisplaySettingsRuntime({
        getTarget() {
            return (telegramBusFollowerRegistrationState.getTarget() ??
                telegramBusLeaderState.getTarget());
        },
        getBinding(target) {
            return threadStore.getWorkspaceBindingByTarget(target);
        },
        apply(mode) {
            return ThreadDisplay.applyTelegramThreadDisplaySetting(mode, {
                getProfileKey: configStore.getActiveProfileName,
                ownsLeader() {
                    return getCurrentLeaderEpoch() !== undefined;
                },
                getLeaderSetter() {
                    return telegramBusLeaderRuntime.setThreadDisplayMode;
                },
                getFollowerSetter() {
                    return telegramBusFollowerRegistration.setThreadDisplayMode;
                },
                reloadConfig: configStore.load,
            });
        },
        reset(target) {
            return telegramThreadDisplayNameResetBinding.reset(target);
        },
    });
    const settingsMenuRuntime = MenuSettings.createTelegramSettingsMenuRuntime({
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
                ? Config.resolveTelegramThreadDisplayMode(configStore.get())
                : undefined;
        },
        isThreadDisplayCustom: threadDisplaySettingsRuntime.isCustom,
        async setThreadDisplayMode(mode) {
            try {
                await threadDisplaySettingsRuntime.setMode(mode);
            }
            catch (error) {
                recordRuntimeEvent("bus", error, { phase: "thread-display-setting" });
                throw error;
            }
        },
    }, sectionRegistry);
    // --- Polling ---
    const foreignOwnedUpdateForwarder = telegramBusFollowerClients.foreignOwnedUpdateForwarder;
    const workspaceRestoreFollowerController = Bus.createTelegramBusWorkspaceRestoreController({
        getFollower: telegramBusFollowerRegistry.get,
        localProtocolIdentity: telegramBusProtocolIdentity,
        createRequestId: telegramBusFollowerClients.createRequestId,
        getAuthSecret() {
            return telegramBusAuthSecret;
        },
    });
    const liveRebindFollowerController = Bus.createTelegramBusLiveRebindController({
        getFollower: telegramBusFollowerRegistry.get,
        localProtocolIdentity: telegramBusProtocolIdentity,
        createRequestId: telegramBusFollowerClients.createRequestId,
        getAuthSecret() {
            return telegramBusAuthSecret;
        },
    });
    const liveFollowerPorts = {
        getJournalBindingKey(follower) {
            if (!follower.profileKey || !follower.sessionId)
                return undefined;
            return telegramJournalBindingRuntime.createRecipientResolver(follower.profileKey, follower.sessionId)()?.recoveryKey;
        },
        isSelectedCommandAvailable(follower, name) {
            return (Bus.hasTelegramBusSharedCapabilities(telegramBusProtocolIdentity, follower.protocol, [
                ...Bus.TELEGRAM_BUS_LIVE_REBIND_CAPABILITIES,
                ...Bus.TELEGRAM_BUS_HELD_COMMAND_CAPABILITIES,
            ]) &&
                typeof selectedMenuDelivery === "function" &&
                typeof inboundRouteRuntime.prepareHeldCommand === "function" &&
                typeof inboundRouteRuntime.canPrepareHeldCommand === "function" &&
                inboundRouteRuntime.canPrepareHeldCommand(name, {
                    showStatus: menuActions.sendStatusMessage,
                    sendTextReply,
                }) &&
                !!captureTelegramStateAuthority() &&
                !!workspaceAdmissionRuntime.resolve() &&
                !!resolveWorkspaceRestoreStore());
        },
        run: liveRebindFollowerController,
    };
    const observedThreadTargetBinding = Polling.createTelegramThreadTargetObservationBinding();
    const topicLifecycleSync = Sync.createTelegramObservedTopicLifecycleSyncHandler({
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
    const inboundBusProjectionRuntime = Routing.createTelegramInboundBusProjectionRuntime({
        instanceId: telegramInstanceId,
        listFollowers: telegramBusFollowerRegistry.list,
        listThreadRecords: threadStore.list,
        getLeaderTarget: telegramBusLeaderState.getTarget,
        isFollowerRegistered: telegramBusFollowerRegistrationState.isRegistered,
        getFollowerTarget: telegramBusFollowerRegistrationState.getTarget,
        getCurrentIdentity: getCurrentInstanceThreadIdentity,
    });
    const telegramThreadDisplayNameRenameBinding = Commands.createTelegramThreadDisplayNameRenameBinding();
    const telegramThreadDisplayNameResetBinding = Commands.createTelegramThreadDisplayNameResetBinding();
    const observeLiveTargetWork = Bindings.createTelegramLiveTargetWorkObserver({
        queue: telegramQueueStore,
        activeTurn: activeTurnRuntime,
        lifecycle: bridgeRuntime.lifecycle,
        isIdle,
        hasPendingMessages,
        hasPendingControl: pendingModelSwitchStore.has,
        publication: publicationRuntime,
        activity: activityRuntime,
        delivery: deliveryLifecycleRuntime,
        api: telegramApiTargetActivityRuntime,
    });
    const inboundRouteRuntime = Routing.createTelegramInboundRouteRuntime({
        configStore,
        callApi: callTelegramApi,
        getCurrentInstanceId() {
            return telegramInstanceId;
        },
        getAdmissionScope: getTelegramUpdateAdmissionScope,
        getAdmissionJournalBinding: getTelegramQueueJournalBinding,
        beginCommandEffectWork: publicationRuntime.beginWork,
        getMessageOwnership: messageOwnershipRuntime.getForwardOwnership,
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
        workspaceRestoreRecipient: {
            getSessionId: Pi.getExtensionContextSessionId,
            getCwd: Pi.getExtensionContextCwd,
            getLeaderIdentity: telegramBusLeaderState.getIdentity,
            observeLeaderWork: observeLiveTargetWork,
            followerRegistry: telegramBusFollowerRegistry,
            runFollower: workspaceRestoreFollowerController,
            liveFollower: liveFollowerPorts,
        },
        getWorkspaceRestoreStore: resolveWorkspaceRestoreStore,
        captureWorkspaceExternalProtection,
        inspectRestoreSourceCompletion(expected) {
            return telegramJournalReferenceRegistry.withReference({
                referenceClass: "operator-disposition",
                recoveryKey: expected.journalBindingKey,
            }, function () {
                const observed = telegramJournalBindingRuntime.inspectSourceCompletion(expected.journalBindingKey, {
                    updateId: expected.updateId,
                    sourceSha256: expected.sourceSha256,
                    completionSha256: expected.completionSha256,
                });
                return (observed && {
                    journalBindingKey: expected.journalBindingKey,
                    ...observed,
                });
            });
        },
        inspectRestoreQueuedReceipt(expected) {
            return telegramJournalReferenceRegistry.withReference({
                referenceClass: "operator-disposition",
                recoveryKey: expected.journalBindingKey,
            }, function () {
                return telegramJournalBindingRuntime.inspectQueuedReceipt(expected.journalBindingKey, {
                    queueKind: expected.queueKind,
                    receiptId: expected.receiptId,
                    sourceUpdateIds: [...expected.sourceUpdateIds],
                    queueOwner: { ...expected.queueOwner },
                });
            });
        },
        inspectRestoreSourceAbandonment(updateId, journalBindingKey) {
            return telegramJournalReferenceRegistry.withReference({
                referenceClass: "operator-disposition",
                recoveryKey: journalBindingKey,
            }, function () {
                return telegramJournalBindingRuntime.inspectSourceAbandonment(journalBindingKey, updateId);
            });
        },
        inspectRoutingInputGroupExpiry(input) {
            return telegramJournalReferenceRegistry.withReference({
                referenceClass: "operator-disposition",
                recoveryKey: input.journalBindingKey,
            }, function () {
                return telegramJournalBindingRuntime.inspectSourceGroupExpiry(input.journalBindingKey, input.updateIds);
            });
        },
        inspectTemporaryThreadSources(target, requiredJournalBindingKeys, ownInputs) {
            const binding = resolveTelegramUpdateJournalBinding();
            const botToken = configStore.getBotToken();
            if (!binding || !botToken)
                return undefined;
            const profile = configStore.getActiveProfileName() ?? "default";
            const botIdentity = Journal.createTelegramUpdateJournalBotIdentity({
                botToken,
                botId: getTelegramBotId(),
            });
            return withTelegramJournalSourceSerialization(function () {
                return Journal.isTelegramThreadCleanupJournalNamespaceClear({
                    directory: Paths.resolveTelegramTempDir(),
                    profile,
                    botIdentity,
                    pollingPath: telegramLeaderJournalPath.resolve(configStore.getActiveProfileName()),
                    requiredJournalBindingKeys: [
                        binding.recoveryKey,
                        ...requiredJournalBindingKeys,
                    ],
                    ...(target.threadId !== undefined && ownInputs
                        ? {
                            cleanup: {
                                target: { chatId: target.chatId, threadId: target.threadId },
                                ownInputs,
                            },
                        }
                        : {}),
                    limits: {
                        maxDirectoryEntries: 10_000,
                        maxFiles: 4096,
                        maxBytes: 64 * 1024 * 1024,
                        maxEntries: 10_000,
                        maxWork: 100_000,
                    },
                    withSourceReference(path, operation) {
                        return telegramJournalReferenceRegistry.withReference({
                            referenceClass: "operator-disposition",
                            recoveryKey: Journal.createTelegramUpdateJournalBindingKey({
                                path,
                                profileName: profile,
                                botIdentity,
                            }),
                        }, operation);
                    },
                })
                    ? []
                    : undefined;
            });
        },
        hasWorkspaceRestoreAuthority() {
            return (lockRuntime.owns() &&
                Bus.hasTelegramBusCapability(telegramBusProtocolIdentity, Bus.TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE));
        },
        hasWorkspaceLiveRebindAuthority() {
            return (lockRuntime.owns() &&
                Bus.hasTelegramBusCapability(telegramBusProtocolIdentity, Bus.TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SAVE) &&
                Bus.hasTelegramBusCapability(telegramBusProtocolIdentity, Bus.TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY) &&
                Bus.hasTelegramBusCapability(telegramBusProtocolIdentity, Bus.TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SETTLE));
        },
        getSessionGeneration: telegramSessionContextStore.getGeneration,
        bridgeRuntime,
        requestNewSession(source) {
            const updateId = Updates.getTelegramUpdateExecutionFence(source)?.updateId;
            if (updateId === undefined) {
                throw new Error("Telegram session replacement requires durable update authority.");
            }
            const callbackMessage = source && typeof source === "object" && "message" in source
                ? source.message
                : source;
            const messageTarget = callbackMessage;
            const target = typeof messageTarget?.chat?.id === "number" &&
                typeof messageTarget.message_id === "number"
                ? {
                    chatId: messageTarget.chat.id,
                    messageId: messageTarget.message_id,
                    ...(typeof messageTarget.message_thread_id === "number"
                        ? { threadId: messageTarget.message_thread_id }
                        : {}),
                }
                : undefined;
            if (!target) {
                throw new Error("Telegram session replacement target is unavailable.");
            }
            if (!sessionActionsRuntime.scheduleAfterUpdate(updateId, target)) {
                throw new Error("A Telegram session replacement is already pending.");
            }
        },
        activeTurnRuntime,
        mediaGroupRuntime,
        textGroupRuntime,
        telegramQueueStore,
        queueMutationRuntime,
        modelMenuRuntime,
        currentModelRuntime,
        modelSwitchController,
        menuActions,
        isVoiceReplyActive: menuActionPorts.isVoiceReplyActive,
        updateSettingsMenuMessage: settingsMenuRuntime.updateSettingsMenuMessage,
        openQueueMenu: queueMenuRuntime.openQueueMenu,
        queueMenuCallbackHandler: queueMenuRuntime.handleCallbackQuery,
        openSettingsMenu: settingsMenuRuntime.openSettingsMenu,
        settingsMenuCallbackHandler: settingsMenuRuntime.handleCallbackQuery,
        sectionRegistry,
        sendSectionRichMessage,
        buttonActionStore,
        invokeBoundButtonAction: invokeGenerativeAppBoundButtonAction,
        inboundHandlerRuntime,
        threadStore,
        runWorkspaceOperation: telegramWorkspaceOperationRuntime.run,
        liveRebindCleanupSchedule: Routing.TELEGRAM_LIVE_REBIND_CLEANUP_SCHEDULE,
        updateStatus,
        isContextActive: telegramSessionContextStore.isCurrent,
        dispatchNextQueuedTelegramTurn,
        requestNextDispatchAnnouncement,
        cancelNextDispatchAnnouncement,
        requestDeferredDispatchNextQueuedTelegramTurn: deferredQueueDispatchRuntime.request,
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
        startGuestPlaceholder: guestPlaceholderRuntime.start,
        sendTextReply,
        setMyCommands,
        captureThreadNameRecipientAuthority(target, ctx) {
            // Ordinary follower/classic dialogs keep their unguarded policy; closures are leader-local only.
            if (telegramBusFollowerRegistrationState.isRegistered() ||
                target.threadId === undefined)
                return undefined;
            return Threads.createTelegramWorkspaceThreadRenameRecipient({
                store: threadStore,
                instanceId: telegramInstanceId,
                target,
                assertAuthority() {
                    if (telegramSessionContextStore.get() !== ctx)
                        throw new Error("Telegram Thread name dialog lost Pi context.");
                },
                getAuthority: threadNameRecipientAuthority.getAuthority,
            }).assertAuthority;
        },
        validateThreadName(threadName) {
            return ThreadNaming.getTelegramManualThreadDisplayNameValidationError(threadName);
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
    const queueHandoffReconciliationBinding = Updates.createTelegramQueueHandoffReconciliationBinding(function (error) {
        recordRuntimeEvent("inbound-worker", error, {
            phase: "queue-handoff-reconcile",
        });
    });
    const staleTopicApiErrorRecoveryDeps = {
        topicTargetStore: threadStore,
        getSyncState: telegramSyncStateRuntime.getState,
        setSyncState: telegramSyncStateRuntime.setState,
        recordEvent: recordRuntimeEvent,
        getWorkspaceAdmission: workspaceAdmissionRuntime.resolve,
    };
    const recoverStaleTelegramTopicApiError = Sync.createTelegramStaleTopicApiErrorRecoveryRuntime(staleTopicApiErrorRecoveryDeps);
    const { owner: updateWorkerOwnerRuntime, leader: updateAdmissionLifecycleRuntime, follower: followerAdmissionLifecycleRuntime, } = Updates.createTelegramUpdateAdmissionRuntimeAssembly({
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
            requestQueueHandoffReconciliation: queueHandoffReconciliationBinding.request,
            afterQueueReceiptCommitted: inboundRouteRuntime.onQueueReceiptCommitted,
            afterUpdateCompleted(updateId, ctx, journalBindingKey) {
                sessionActionsRuntime.onUpdateCompleted(updateId);
                inboundRouteRuntime.onUpdateCompleted(updateId, ctx, journalBindingKey);
            },
        },
        worker: {
            expireRoutingInput: inboundRouteRuntime.expireRoutingInput,
            beforeQueueReceiptPublished: inboundRouteRuntime.beforeQueueReceiptPublished,
            onQueueReceiptCompleted: inboundRouteRuntime.onQueueReceiptCompleted,
            defaultHandle: inboundRouteRuntime.handleUpdate,
            async shouldReviewHistoricalInput(entry, ctx, signal) {
                if (signal.aborted || !telegramSessionContextStore.isCurrent(ctx)) {
                    throw new Error("Workspace Restore source generation ended.");
                }
                const verdict = await inboundRouteRuntime.shouldReviewHistoricalInput(entry, ctx, signal);
                if (signal.aborted || !telegramSessionContextStore.isCurrent(ctx)) {
                    throw new Error("Workspace Restore source generation ended.");
                }
                if (verdict === "retain")
                    return verdict;
                const journalBindingKey = getTelegramQueueJournalBinding();
                if (journalBindingKey &&
                    resolveWorkspaceRestoreStore()
                        ?.list()
                        .some(function (intent) {
                        return (intent.request.source.journalBindingKey === journalBindingKey &&
                            intent.request.source.updateIds.includes(entry.updateId));
                    }))
                    return true;
                return verdict;
            },
            spendHistoricalInput: true,
            onHeldSourcesPrepared(input) {
                return inboundRouteRuntime
                    .forgetPreviousWorld(input, lockedPollingRuntime.captureTransportAuthority)
                    .then(function () { });
            },
            async shouldHoldPendingInput(entry, ctx, signal) {
                if (signal.aborted || !telegramSessionContextStore.isCurrent(ctx)) {
                    throw new Error("Temporary Thread source generation ended.");
                }
                return inboundRouteRuntime.shouldHoldPendingInput(entry, ctx, signal);
            },
            onStateChange: runtimeDiagnostics.scheduleSnapshotPersist,
            settleTerminalExecutionFailure(error) {
                return Sync.settleStaleTelegramTopicExecutionFailure(error, staleTopicApiErrorRecoveryDeps);
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
            prepareBinding(binding) {
                telegramJournalBindingRuntime.prepareActiveFollowerSuccession(function () {
                    return binding.hasAuthority?.() === true;
                });
            },
            prepareUpdateForExecution(update) {
                return BusFollower.prepareTelegramBusFollowerJournaledUpdateForExecution(update, textGroupRuntime.prepareForwardedMessage);
            },
        },
        recordRuntimeEvent,
    });
    const queueHandoffStagingRuntime = Queue.createTelegramQueueHandoffStagingRuntime({
        liveStore: telegramQueueStore,
        createControlExecution: Updates.createTelegramQueueHandoffControlExecutionFactory({
            isContextCurrent: telegramSessionContextStore.isCurrent,
            showStatus: menuActions.sendStatusMessage,
            openModelMenu: menuActions.openModelMenu,
        }),
    });
    const acceptStagedQueueHandoff = Updates.createTelegramQueueHandoffRecipientRuntime({
        staging: queueHandoffStagingRuntime,
        getRecipientOwner: updateWorkerOwnerRuntime.getQueueOwnerIdentity,
        getLifecycleForBinding: updateAdmissionRuntimeBinding.getLifecycleForJournalBinding,
        isTransportStampActive: telegramTransportStampRuntime.isActive,
        dispatchNext: dispatchNextQueuedTelegramTurn,
    });
    const followerDurableAdmissionRuntime = BusFollower.createTelegramBusFollowerDurableAdmissionRuntime({
        journal: {
            appendBatch(updates) {
                return followerAdmissionLifecycleRuntime.appendBatch(updates);
            },
        },
        signalWorker() {
            followerAdmissionLifecycleRuntime.signal();
        },
    });
    const promoteTelegramBusFollowerToLeader = BusFollower.createTelegramBusFollowerPromotionHandler({
        topicTargetStore: threadStore,
        instanceId: telegramInstanceId,
        getActiveProfileName: configStore.getActiveProfileName,
        getSessionId: Pi.getExtensionContextSessionId,
        getWorkspaceAdmission: workspaceAdmissionRuntime.resolve,
        async startLeader(ctx, election, onAcquired) {
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
    const agentMessageToolRoutingRuntime = Bindings.createTelegramAgentMessageToolRoutingRuntime({
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
    const followerWorkspaceTargetContextPorts = {
        isContextCurrent: telegramSessionContextStore.isCurrent,
        getSessionId: Pi.getExtensionContextSessionId,
        getCwd: Pi.getExtensionContextCwd,
        getGeneration: telegramSessionContextStore.getGeneration,
        getProfileBindingKey() {
            return workspaceAdmissionRuntime.resolve()?.getProfileKey();
        },
        getOperatorUserId: configStore.getAllowedUserId,
        getLeaderState: lockRuntime.getState,
        getAuthenticatedSecret: telegramBusFollowerControlState.getActiveAuthSecret,
        getLeaderProtocol: telegramBusFollowerRegistrationState.getLeaderProtocol,
    };
    const followerWorkspaceTargetOwnerPorts = {
        instanceId: telegramInstanceId,
        readRestoreIntent(operationId, profileBindingKey) {
            if (profileBindingKey !==
                workspaceAdmissionRuntime.resolve()?.getProfileKey())
                return undefined;
            return resolveWorkspaceRestoreStore()
                ?.list()
                .find(function (intent) {
                return intent.request.operationId === operationId;
            });
        },
        readLiveRebindIntent(operationId, profileBindingKey) {
            if (profileBindingKey !==
                workspaceAdmissionRuntime.resolve()?.getProfileKey())
                return undefined;
            return resolveWorkspaceRestoreStore()
                ?.listLiveRebindings()
                .find(function (intent) {
                return intent.request.operationId === operationId;
            });
        },
        topicTargetStore: threadStore,
        registrationState: telegramBusFollowerRegistrationState,
        getWorkspaceAdmission: workspaceAdmissionRuntime.resolve,
        recordRuntimeEvent,
    };
    const followerWorkspaceRestore = BusFollower.createTelegramBusFollowerWorkspaceRestoreHandler({
        ...followerWorkspaceTargetOwnerPorts,
        getContextAuthority: BusFollower.createTelegramBusFollowerRestoreContextGetter(followerWorkspaceTargetContextPorts),
    });
    const followerLiveRebindTarget = BusFollower.createTelegramBusFollowerWorkspaceRestoreHandler({
        ...followerWorkspaceTargetOwnerPorts,
        getContextAuthority: BusFollower.createTelegramBusFollowerRestoreContextGetter({
            ...followerWorkspaceTargetContextPorts,
            capability: Bus.TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY,
        }),
    });
    const selectedMenuCaller = BusFollower.createTelegramBusFollowerSelectedMenuCaller({
        client: {
            socketPath: getTelegramBusSocketPath,
            instanceId: telegramInstanceId,
            createRequestId: telegramBusFollowerClients.createRequestId,
            getAuthSecret: telegramBusFollowerControlState.getActiveAuthSecret,
            getRegistrationGeneration: telegramBusFollowerRegistrationState.getGeneration,
        },
        protocolIdentity: telegramBusProtocolIdentity,
        recipient: {
            getContextAuthority: BusFollower.createTelegramBusFollowerRestoreContextGetter({
                ...followerWorkspaceTargetContextPorts,
                // Wire recipient identity is the registered profile key, not the admission namespace.
                getProfileBindingKey: getTelegramManualFollowerProfileKey,
                capability: Bus.TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY,
            }),
            getJournalBindingKey: followerAdmissionLifecycleRuntime.getJournalBindingKey,
            getProcessIdentity() {
                return {
                    processId: telegramProcessId,
                    processBirthId: telegramQueueProcessBirthId,
                };
            },
            registrationState: telegramBusFollowerRegistrationState,
        },
    });
    const followerLiveRebindRuntime = BusFollower.createTelegramBusFollowerLiveRebindRuntime({
        getAdmission(ctx) {
            return telegramSessionContextStore.isCurrent(ctx)
                ? followerAdmissionLifecycleRuntime
                : undefined;
        },
        applyTarget: followerLiveRebindTarget,
        getCommandOwner(input, ctx) {
            if (!Bus.hasTelegramBusCapability(telegramBusProtocolIdentity, Bus.TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_COMMAND_SET) ||
                !Bus.hasTelegramBusCapability(telegramBusProtocolIdentity, Bus.TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY) ||
                !input.selectedCommand ||
                !telegramSessionContextStore.isCurrent(ctx) ||
                followerAdmissionLifecycleRuntime.getJournalBindingKey() !==
                    input.recipientBindingKey)
                return undefined;
            const recipient = followerLiveRebindTarget.prepareLiveCommandRecipient({
                operationId: input.operationId,
                registrationGeneration: input.recipientRegistrationGeneration,
                sessionId: input.recipientSessionId,
                sourceUpdateIds: input.updates.map(function sourceUpdateId(update) {
                    return update.update_id;
                }),
                target: input.selectedCommand.target,
            }, ctx);
            return (recipient &&
                Bindings.createTelegramFollowerSelectedCommandBinding({
                    ctx,
                    operationId: input.operationId,
                    registrationGeneration: input.recipientRegistrationGeneration,
                    name: input.selectedCommand.name,
                    target: input.selectedCommand.target,
                    recipient,
                    command: inboundRouteRuntime,
                    menu: menuActionPorts,
                    recordOwnership: messageOwnershipRuntime.recordLocal,
                    deliver(effect, assertAuthority) {
                        return selectedMenuCaller({
                            ctx,
                            operationId: input.operationId,
                            registrationGeneration: input.recipientRegistrationGeneration,
                            effect,
                            assertAuthority,
                        });
                    },
                }));
        },
        observeWork: observeLiveTargetWork,
    });
    const telegramBusFollowerAssembly = BusFollower.createTelegramBusFollowerRuntimeAssembly({
        instanceId: telegramInstanceId,
        registrationState: telegramBusFollowerRegistrationState,
        recordRuntimeEvent,
        receiver: {
            socketPath: getTelegramBusFollowerSocketPath,
            getContext: telegramSessionContextStore.get,
            getAuthSecret: telegramBusFollowerControlState.getActiveAuthSecret,
            getRecipientBindingKey: getTelegramManualFollowerProfileKey,
            getLiveRebindJournalBindingKey: followerAdmissionLifecycleRuntime.getJournalBindingKey,
            getSessionId() {
                return telegramBusFollowerAssembly.getReadySessionId();
            },
            getLeaderProtocol: telegramBusFollowerRegistrationState.getLeaderProtocol,
            getLocalProtocol() {
                return telegramBusProtocolIdentity;
            },
            isLiveRebindSaveEnabled() {
                return Bus.hasTelegramBusCapability(telegramBusProtocolIdentity, Bus.TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SAVE);
            },
            isLiveRebindApplyEnabled() {
                return Bus.hasTelegramBusCapability(telegramBusProtocolIdentity, Bus.TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY);
            },
            isLiveRebindSettleEnabled() {
                return Bus.hasTelegramBusCapability(telegramBusProtocolIdentity, Bus.TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SETTLE);
            },
            isLiveRebindCommandSetEnabled() {
                return (Bus.hasTelegramBusCapability(telegramBusProtocolIdentity, Bus.TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_COMMAND_SET) &&
                    Bus.hasTelegramBusCapability(telegramBusProtocolIdentity, Bus.TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY));
            },
            handleLiveRebindSave: followerLiveRebindRuntime.save,
            handleLiveRebindApply: followerLiveRebindRuntime.apply,
            handleLiveRebindSettle: followerLiveRebindRuntime.settle,
            durableAdmission: followerDurableAdmissionRuntime,
            handleQueueHandoff: acceptStagedQueueHandoff,
            handleWorkspaceRestore: followerWorkspaceRestore,
            isWorkspaceRestoreEnabled() {
                return (Bus.hasTelegramBusCapability(telegramBusProtocolIdentity, Bus.TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE) &&
                    Bus.hasTelegramBusCapability(telegramBusFollowerRegistrationState.getLeaderProtocol(), Bus.TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE));
            },
        },
        recovery: {
            getLeaderState: lockRuntime.getState,
            proveLeaderUnresponsive: proveTelegramLeaderUnresponsive,
            async isThreadModeDisabled() {
                await threadStore.refresh?.();
                return threadStore.getBotState().threadMode === "disabled";
            },
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
            setActiveAuthSecret: telegramBusFollowerControlState.setActiveAuthSecret,
            getProfileKey: getTelegramManualFollowerProfileKey,
            getThreadName() {
                return telegramThreadCapabilityState.getRequestedThreadName();
            },
            getProcessBirthId() {
                return telegramQueueProcessBirthId;
            },
            getSessionId: Pi.getExtensionContextSessionId,
            getSessionGeneration: telegramSessionContextStore.getGeneration,
            async onRegistered(ctx) {
                await followerAdmissionLifecycleRuntime.onTransportChanged(ctx);
                queueHandoffReconciliationBinding.request(ctx);
            },
            onDisplayTitleChanged: updateStatus,
        },
    });
    const telegramBusFollowerRegistration = telegramBusFollowerAssembly.registration;
    const { admission: pollingAdmissionRuntime } = Polling.createTelegramDurablePollingRuntimeAssembly({
        state: pollingControllerState,
        canStart(ctx) {
            return (telegramSessionContextStore.isCurrent(ctx) && lockRuntime.owns(ctx));
        },
        onPersistentConflict(ctx, count) {
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
                return updateAdmissionLifecycleRuntime.appendBatch(updates, acceptedThroughUpdateId);
            },
            getAcceptedThroughUpdateId() {
                return Journal.withTelegramResolvedUpdateJournalReference({
                    registry: telegramJournalReferenceRegistry,
                    resolveBinding: resolveTelegramUpdateJournalBinding,
                    referenceClass: "polling-cursor",
                    operation(binding) {
                        return binding.journal.read().acceptedThroughUpdateId;
                    },
                });
            },
            async prepareCursorCutover() {
                const cutover = Journal.withTelegramResolvedUpdateJournalReference({
                    registry: telegramJournalReferenceRegistry,
                    resolveBinding: resolveTelegramUpdateJournalBinding,
                    referenceClass: "polling-cursor",
                    operation(binding) {
                        return Polling.cutOverTelegramPollingCursor({
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
                });
                if (!cutover)
                    throw new Error("Telegram update journal binding is unavailable.");
                await cutover;
            },
            getEntryCount: updateAdmissionLifecycleRuntime.getJournalEntryCount,
            signalWorker: updateAdmissionLifecycleRuntime.signal,
            getBootstrapEntryCount() {
                return (Journal.withTelegramResolvedUpdateJournalReference({
                    registry: telegramJournalReferenceRegistry,
                    resolveBinding: resolveTelegramUpdateJournalBinding,
                    referenceClass: "polling-bootstrap",
                    operation(binding) {
                        return binding.journal.read().entries.length;
                    },
                }) ?? 0);
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
    const selectedMenuDelivery = BusLeader.createTelegramBusSelectedMenuDeliveryHandler({
        followerRegistry: telegramBusFollowerRegistry,
        protocolIdentity: telegramBusProtocolIdentity,
        workspace: {
            getScopeKey() {
                return workspaceAdmissionRuntime.resolve()?.getProfileKey();
            },
            captureAuthority() {
                const isCurrent = captureTelegramStateAuthority(), epoch = lockRuntime.getOwnedLeaderEpoch(), operatorUserId = configStore.getAllowedUserId();
                return isCurrent &&
                    epoch !== undefined &&
                    operatorUserId !== undefined
                    ? {
                        executor: {
                            instanceId: telegramInstanceId,
                            leaderEpoch: String(epoch),
                        },
                        operatorUserId,
                        isCurrent,
                    }
                    : undefined;
            },
            getStore: resolveWorkspaceRestoreStore,
            threadStore,
            getJournalBindingKey: liveFollowerPorts.getJournalBindingKey,
            run: telegramWorkspaceOperationRuntime.run,
        },
        api: {
            runtime: directTelegramApiRuntime,
            authorize: authorizeFollowerApiCall,
            record(record, assertCurrent) {
                assertCurrent();
                messageOwnershipRuntime.recordFollower(record);
                assertCurrent();
                return messageOwnershipRuntime.isOwnedByFollower(record);
            },
        },
    });
    const telegramSessionFolderSweeper = Recovery.createTelegramSessionFolderSweeper({
        getSessionsDir: Paths.resolveTelegramSessionsDir,
        getProfileName: configStore.getActiveProfileName,
        getKeptSessionIds() {
            return [
                ...threadStore
                    .listWorkspaceBindings()
                    .map(function bindingSession(binding) {
                    return binding.sessionId;
                }),
                ...telegramBusFollowerRegistry
                    .list()
                    .map(function followerSession(follower) {
                    return follower.sessionId;
                }),
                Pi.getExtensionContextSessionId(telegramSessionContextStore.get()),
            ];
        },
    });
    const telegramBusLeaderRuntime = BusLeader.createTelegramBusLeaderRuntimeAssembly({
        runtime: {
            socketPath: getTelegramBusSocketPath,
            commitEndpointPublication(commit) {
                return lockRuntime.commitIfOwned(commit);
            },
            followerRegistry: telegramBusFollowerRegistry,
            authSecret: telegramBusAuthSecret,
            protocolIdentity: telegramBusProtocolIdentity,
            selectedMenuDelivery,
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
            isFollowerProcessAlive: ProcessIdentity.isProcessAlive,
            afterFollowerPrune() {
                telegramSessionFolderSweeper.sweep();
            },
            shouldCleanupConfirmedDeadFollower: configControls.resolveAutomaticThreadCleanupEnabled,
            recordFollowerMessageOwnership(record) {
                messageOwnershipRuntime.recordFollower(record);
            },
            onWorkspaceRestoreRecipientObserved(follower, isCurrent) {
                return inboundRouteRuntime.onWorkspaceRestoreRecipientObserved(follower, isCurrent, telegramSessionContextStore.get());
            },
        },
        getAllowedUserId: configStore.getAllowedUserId,
        instanceId: telegramInstanceId,
        getCwd: Pi.getExtensionContextCwd,
        getSessionId: Pi.getExtensionContextSessionId,
        getTelegramProfile: configStore.getActiveProfileName,
        getThreadDisplayMode() {
            return Config.resolveTelegramThreadDisplayMode(configStore.get());
        },
        persistThreadDisplayMode(mode, isCurrent) {
            return Config.setTelegramThreadDisplayMode(configStore, mode, isCurrent);
        },
        onThreadDisplayChanged() {
            const ctx = telegramSessionContextStore.get();
            if (ctx)
                updateStatus(ctx);
        },
        shouldForceFreshUnnamed: telegramThreadCapabilityState.shouldForceFreshLeaderThread,
        getRequestedThreadName: telegramThreadCapabilityState.getRequestedThreadName,
        topicTargetStore: threadStore,
        getWorkspaceAdmission: workspaceAdmissionRuntime.resolve,
        runWorkspaceOperation: telegramWorkspaceOperationRuntime.run,
        captureWorkspaceExternalProtection,
        workspaceRotation: {
            getAdmission: workspaceAdmissionRuntime.resolve,
            runExclusive: telegramWorkspaceOperationRuntime.runExclusive,
            deleteThread: directTelegramApiRuntime.deleteWorkspaceThread,
            pruneJournalEvidence: pruneWorkspaceJournalEvidence,
            reclaimDeadOwnerQueuedWork(binding, isCurrent) {
                return telegramWorkspaceOperationRuntime.run({
                    operationId: WorkspaceAdmission.createTelegramWorkspaceAdmissionOperationId(),
                    operationKind: "workspace.reclaim-dead-owner-queue",
                    scopes: [{ kind: "target", target: binding.target }],
                }, reclaimTelegramWorkspaceDeadOwnerQueue.bind(undefined, binding, isCurrent));
            },
        },
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
    queueHandoffReconciliationBinding.set(Updates.createTelegramQueueHandoffReconciliationRuntimeAssembly({
        ownsDirect: lockRuntime.owns,
        isFollowerRegistered: telegramBusFollowerRegistrationState.isRegistered,
        isBusEnabled: isTelegramBusRuntimeEnabled,
        canHandoffWithLeader() {
            return Bus.hasTelegramBusCapability(telegramBusFollowerRegistrationState.getLeaderProtocol(), Bus.TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF);
        },
        listFollowers: telegramBusFollowerRegistry.list,
        createRecipientJournalResolver: telegramJournalBindingRuntime.createRecipientResolver,
        queueStore: telegramQueueStore,
        admission: updateAdmissionRuntimeBinding,
        createHandoffToken: Journal.createTelegramUpdateQueueHandoffToken,
        createRequestId: telegramBusFollowerClients.createRequestId,
        donorInstanceId: telegramInstanceId,
        authSecret: telegramBusAuthSecret,
        stageThroughFollower: telegramBusFollowerClients.queueHandoff,
        routeThroughLeader: telegramBusLeaderRuntime.routeQueueHandoff,
        recordRuntimeEvent,
    }));
    const telegramLeaderHealthRuntime = Sync.createTelegramLeaderHealthRuntime({
        callGetMe() {
            return directTelegramApiRuntime.call("getMe", {});
        },
        getSyncState: telegramSyncStateRuntime.getState,
        setSyncState: telegramSyncStateRuntime.setState,
        recordEvent: recordRuntimeEvent,
    });
    const telegramThreadCapabilityRuntime = Polling.createTelegramThreadCapabilityOrchestration({
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
        registerFollowerWithLeader: telegramBusFollowerRegistration.registerWithLeader,
        restoreFollowerWithLeader(ctx, owner) {
            return telegramBusFollowerRegistration.registerWithLeader(ctx, owner, {
                restoreWorkspace: true,
            });
        },
        hasRememberedWorkspaceBinding(ctx) {
            return threadStore.hasWorkspaceBinding(Pi.getExtensionContextCwd(ctx), Pi.getExtensionContextSessionId(ctx));
        },
        suspendLiveThreadTarget: telegramBusLeaderState.clear,
        stopFollowerRegistration: telegramBusFollowerRegistration.stop,
        isTopicModeUnavailableError: Threads.isTelegramTopicModeUnavailableError,
        updateStatus,
        recordEvent: recordRuntimeEvent,
    });
    const telegramThreadCapabilityMonitor = telegramThreadCapabilityRuntime.monitor;
    observedThreadTargetBinding.set(telegramThreadCapabilityRuntime.observeTarget);
    const threadAwarePollingPorts = telegramThreadCapabilityRuntime.pollingPorts;
    const lockedPollingRuntime = Locks.createTelegramLockedPollingRuntime({
        lock: lockRuntime,
        proveOwnerUnresponsive: proveTelegramLeaderUnresponsive,
        resetDamagedState() {
            return Locks.resetDamagedTelegramRuntimeState(Paths.resolveTelegramStatePath(), function (profile, sections) {
                Threads.parseTelegramWorkspaceStateSection(sections.workspace, profile);
                WorkspaceAdmission.assertTelegramConsolidatedAdmissionSection(sections.admission, profile);
            });
        },
        transportMonitor: telegramThreadCapabilityMonitor,
        hasBotToken: configStore.hasBotToken,
        getBotTokenDiagnostic: configStore.getBotTokenDiagnostic,
        canStartPolling: Pi.canStartPollingInExtensionContext,
        isContextCurrent: telegramSessionContextStore.isCurrent,
        formatStartBlockedMessage: Pi.formatPollingStartBlockedByRunMode,
        startPolling: threadAwarePollingPorts.startPolling,
        stopPolling: threadAwarePollingPorts.stopPolling,
        registerFollowerWithOwner: threadAwarePollingPorts.registerFollowerWithOwner,
        restoreFollowerWithOwner: threadAwarePollingPorts.restoreFollowerWithOwner,
        stopFollowerRegistration: threadAwarePollingPorts.stopFollowerRegistration,
        onTransportAvailabilityChanged() {
            modelContextAvailabilityRuntime.reconcile();
            const ctx = telegramSessionContextStore.get();
            if (ctx)
                queueHandoffReconciliationBinding.request(ctx);
        },
        updateStatus,
        recordRuntimeEvent,
    });
    const { disconnect: disconnectTelegramAndDeleteCurrentThread, cleanupForSessionRestart: cleanupTelegramThreadForSessionRestart, } = Sync.createTelegramThreadDisconnectAssembly({
        instanceId: telegramInstanceId,
        getCurrentThreadRecord: findCurrentThreadRecord,
        topicTargetStore: threadStore,
        callApi: callTelegramApi,
        getCurrentLeaderEpoch,
        getLeaderTarget: telegramBusLeaderState.getTarget,
        clearLeaderTarget: telegramBusLeaderState.clear,
        disconnectFollowerThread: telegramBusFollowerRegistration.disconnectFromLeader,
        getSyncState: telegramSyncStateRuntime.getState,
        setSyncState: telegramSyncStateRuntime.setState,
        stopPolling: lockedPollingRuntime.stop,
        captureStopPolling: lockedPollingRuntime.captureStop,
        suspendPolling: lockedPollingRuntime.suspend,
        recordRuntimeEvent,
        runWorkspaceOperation: telegramWorkspaceOperationRuntime.run,
    });
    const prepareThreadPreservationOnQuit = Sync.createTelegramPreservedLeaderQuitHandler({
        instanceId: telegramInstanceId,
        topicTargetStore: threadStore,
        getCurrentLeaderEpoch,
        getProfileName: configStore.getActiveProfileName,
        isPollingSuspended: lockedPollingRuntime.isSuspended,
        resolveAutomaticThreadCleanupEnabled: configControls.resolveAutomaticThreadCleanupEnabled,
        runWorkspaceOperation: telegramWorkspaceOperationRuntime.run,
    });
    const connectionIntent = Lifecycle.createTelegramConnectionIntentRuntime();
    const connectionLifecycle = Lifecycle.createTelegramConnectionLifecycle({
        intent: connectionIntent,
        getGeneration: telegramSessionContextStore.getGeneration,
        isCurrent: telegramSessionContextStore.isCurrent,
        getProfileName: configStore.getActiveProfileName,
        isConnected() {
            return (lockRuntime.owns() ||
                telegramBusFollowerRegistrationState.isRegistered());
        },
        async activateProfile(profileName, isCurrent) {
            await configStore.load();
            if (!isCurrent())
                return false;
            return (configStore.activateProfile(profileName) && configStore.hasBotToken());
        },
        start(ctx) {
            return lockedPollingRuntime.start(ctx);
        },
        recordError(error) {
            recordRuntimeEvent("connection", error, { phase: "resume-connect" });
        },
    });
    const telegramBridgeSessionLifecycleDeps = Lifecycle.createTelegramBridgeSessionLifecycleDeps({
        contextStore: telegramSessionContextStore,
        queue: {
            getCurrentModel: getContextModel,
            loadConfig: configStore.load,
            setQueuedItems: telegramQueueStore.setQueuedItems,
            setCurrentModel: currentModelRuntime.set,
            setPendingModelSwitch: modelSwitchController.clearPendingSwitch,
            syncCounters: queue.syncCounters,
            syncFlags: lifecycle.syncFlags,
            bindDeferredDispatchContext: deferredQueueDispatchRuntime.bind,
            prepareTempDir() {
                Recovery.removeTelegramLegacyRecoveryStorage(Paths.resolveTelegramTempDir());
                return prepareTempDir();
            },
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
            connection: connectionLifecycle,
            inboundWorker: {
                onSessionShutdown: updateAdmissionRuntimeBinding.onSessionShutdown,
            },
            capabilityMonitor: telegramThreadCapabilityMonitor,
            queueWatchdog: queueDispatchWatchdogRuntime,
            guestPlaceholder: { stopAll: guestPlaceholderRuntime.stopAll },
            prepareThreadPreservationOnQuit,
        },
    });
    const sessionLifecycleRuntime = Lifecycle.createTelegramBridgeSessionLifecycleAssembly(telegramBridgeSessionLifecycleDeps);
    // --- Extension API Bindings ---
    const threadNameRecipientAuthority = {
        getAuthority() {
            const ctx = telegramSessionContextStore.get();
            return {
                context: ctx,
                sessionId: Pi.getExtensionContextSessionId(ctx),
                sessionGeneration: telegramSessionContextStore.getGeneration(),
                cwd: ctx && Pi.getExtensionContextCwd(ctx),
                profileName: configStore.getActiveProfileName(),
                botToken: configStore.getBotToken(),
                operatorUserId: configStore.getAllowedUserId(),
                leaderEpoch: getCurrentLeaderEpoch(),
                ownsDirectDelivery: ownsTelegramDirectDelivery(),
                followerRegistered: telegramBusFollowerRegistrationState.isRegistered(),
                localTarget: telegramBusLeaderState.getTarget(),
                localSlot: telegramBusLeaderState.getIdentity()?.slot,
            };
        },
    };
    telegramThreadDisplayNameRenameBinding.bind({
        async rename(expectedTarget, threadName, options) {
            try {
                const assertCaller = options?.assertAuthority;
                assertCaller?.();
                if (telegramBusFollowerRegistrationState.isRegistered()) {
                    if (assertCaller)
                        return {
                            ok: false,
                            message: "Guarded follower Workspace Thread rename is unavailable.",
                        };
                    if (typeof expectedTarget.threadId !== "number") {
                        return {
                            ok: false,
                            message: "Telegram Workspace Thread target is unavailable.",
                        };
                    }
                    const renamedThreadName = await telegramBusFollowerRegistration.renameThread?.({
                        chatId: expectedTarget.chatId,
                        threadId: expectedTarget.threadId,
                    }, threadName);
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
                    return {
                        ok: false,
                        message: "Telegram Workspace Thread target is unavailable.",
                    };
                }
                const target = {
                    chatId: expectedTarget.chatId,
                    threadId: expectedTarget.threadId,
                };
                const recipient = assertCaller
                    ? Threads.createTelegramWorkspaceThreadRenameRecipient({
                        store: threadStore,
                        instanceId: telegramInstanceId,
                        target,
                        assertAuthority: assertCaller,
                        getAuthority: threadNameRecipientAuthority.getAuthority,
                    })
                    : undefined;
                const renamed = await telegramBusLeaderRuntime.renameLeaderThreadAdmitted(threadName, target, recipient?.assertAuthority);
                recipient?.assertResult(renamed);
                telegramBusLeaderState.set({
                    target: renamed.target,
                    slot: renamed.slot,
                    threadName: renamed.manualThreadName ?? renamed.threadName,
                });
                recipient?.assertResult(renamed);
                return {
                    ok: true,
                    threadName: renamed.manualThreadName,
                };
            }
            catch (error) {
                return {
                    ok: false,
                    message: error instanceof Error
                        ? error.message
                        : "Telegram Workspace Thread rename failed.",
                };
            }
        },
    }.rename);
    telegramThreadDisplayNameResetBinding.bind({
        async reset(expectedTarget, options) {
            try {
                const assertCaller = options?.assertAuthority;
                assertCaller?.();
                const wasFollower = telegramBusFollowerRegistrationState.isRegistered();
                if (wasFollower && assertCaller)
                    return {
                        ok: false,
                        message: "Guarded follower Workspace Thread reset is unavailable.",
                    };
                if (typeof expectedTarget.threadId !== "number") {
                    return {
                        ok: false,
                        message: "Telegram Workspace Thread target is unavailable.",
                    };
                }
                const target = {
                    chatId: expectedTarget.chatId,
                    threadId: expectedTarget.threadId,
                };
                const recipient = assertCaller
                    ? Threads.createTelegramWorkspaceThreadResetRecipient({
                        store: threadStore,
                        instanceId: telegramInstanceId,
                        target,
                        assertAuthority: assertCaller,
                        getAuthority: threadNameRecipientAuthority.getAuthority,
                    })
                    : undefined;
                const result = wasFollower
                    ? await telegramBusFollowerRegistration.resetThreadName?.(target)
                    : (await (recipient
                        ? telegramBusLeaderRuntime.resetLeaderThreadName(target, recipient.assertAuthority)
                        : telegramBusLeaderRuntime.resetLeaderThreadName(target))).threadName;
                if (!result) {
                    return {
                        ok: false,
                        message: "Thread display name reset is unavailable.",
                    };
                }
                recipient?.assertResult(result);
                const leaderTarget = telegramBusLeaderState.getTarget();
                if (!wasFollower && leaderTarget) {
                    telegramBusLeaderState.set({
                        target: leaderTarget,
                        threadName: result,
                        ...(recipient
                            ? { slot: telegramBusLeaderState.getIdentity()?.slot }
                            : {}),
                    });
                }
                recipient?.assertResult(result);
                return {
                    ok: true,
                    threadName: result,
                };
            }
            catch (error) {
                return {
                    ok: false,
                    message: error instanceof Error
                        ? error.message
                        : "Thread display name reset failed.",
                };
            }
        },
    }.reset);
    sessionActionsRuntime.register();
    Bindings.registerTelegramCommandsAndTools({
        pi,
        agentDir: Paths.resolveAgentDir(),
        configStore,
        persistConfig: persistTelegramConfigWithSync,
        setup,
        activeTurnRuntime,
        lockedPollingRuntime,
        stopPolling: disconnectTelegramAndDeleteCurrentThread,
        // Consolidated envelope failures remain protective; legacy whole-file recovery cannot reset sibling authority.
        getDisconnectThreadName() {
            const record = findCurrentThreadRecord();
            if (!record?.target.threadId)
                return undefined;
            return record.threadName ?? "current Telegram thread";
        },
        onTransportChanged() {
            deliveryLifecycleRuntime.onSessionStart();
            activityVerbosityRuntime.reset();
            modelContextAvailabilityRuntime.reconcile();
        },
        getStatusLines,
        isContextCurrent: telegramSessionContextStore.isCurrent,
        getSessionGeneration: telegramSessionContextStore.getGeneration,
        connectionIntent,
        buttonActionStore,
        sendMarkdownReply,
        async sendChannelMarkdownMessage(channel, markdown, options) {
            if (!lockRuntime.owns()) {
                throw new Error("Telegram channel delivery requires direct leader transport ownership.");
            }
            const profileName = configStore.getActiveProfileName() ?? "default";
            const botToken = configStore.getBotToken();
            if (!botToken)
                throw new Error("Telegram channel delivery requires an active bot token.");
            const store = ChannelPosts.openTelegramChannelPostJournalStore({
                profileName,
                botToken,
            });
            const record = await ChannelPosts.publishTelegramChannelPost({
                store,
                operationId: options.operationId,
                channel: channel,
                markdown,
                async observeChannel(channelAddress) {
                    return telegramApiRuntime.call("getChat", {
                        chat_id: channelAddress,
                    });
                },
                async send(channelAddress, body) {
                    const sent = await telegramApiRuntime.call("sendRichMessage", {
                        chat_id: channelAddress,
                        rich_message: { markdown: body },
                        ...(options.replyMarkup
                            ? { reply_markup: options.replyMarkup }
                            : {}),
                    });
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
            if (!botToken)
                throw new Error("Telegram channel media delivery requires an active bot token.");
            const media = await ChannelPosts.inspectTelegramChannelPostMedia(mediaPath);
            const caption = Replies.renderTelegramMarkdownToHtmlDraft(markdown);
            ChannelPosts.assertTelegramChannelPostCaptionWithinLimit(caption);
            const store = ChannelPosts.openTelegramChannelPostJournalStore({
                profileName,
                botToken,
            });
            const record = await ChannelPosts.publishTelegramChannelPost({
                store,
                operationId: options.operationId,
                channel: channel,
                markdown,
                media,
                async observeChannel(channelAddress) {
                    return telegramApiRuntime.call("getChat", {
                        chat_id: channelAddress,
                    });
                },
                async send(channelAddress) {
                    const sent = await telegramApiRuntime.callMultipart(media.kind === "photo" ? "sendPhoto" : "sendVideo", {
                        chat_id: String(channelAddress),
                        caption,
                        parse_mode: "HTML",
                        ...(options.replyMarkup
                            ? { reply_markup: JSON.stringify(options.replyMarkup) }
                            : {}),
                    }, media.kind === "photo" ? "photo" : "video", mediaPath, media.fileName);
                    return { messageId: sent.message_id, chat: sent.chat };
                },
            });
            return record.state === "published" ? record.messageId : undefined;
        },
        listChannelPosts(input) {
            const profileName = configStore.getActiveProfileName() ?? "default";
            const botToken = configStore.getBotToken();
            if (!botToken)
                throw new Error("Telegram channel posts require an active bot token.");
            return ChannelPosts.openTelegramChannelPostJournalStore({
                profileName,
                botToken,
            }).list(input);
        },
        async mutateChannelPost(input) {
            if (!lockRuntime.owns())
                throw new Error("Telegram channel post mutation requires direct leader ownership.");
            const profileName = configStore.getActiveProfileName() ?? "default";
            const botToken = configStore.getBotToken();
            if (!botToken)
                throw new Error("Telegram channel post mutation requires an active bot token.");
            const store = ChannelPosts.openTelegramChannelPostJournalStore({
                profileName,
                botToken,
            });
            if (input.action === "edit") {
                if (!input.markdown)
                    throw new Error("Telegram channel post edit requires markdown.");
                const current = store.get(input.operationId);
                const caption = current?.media
                    ? Replies.renderTelegramMarkdownToHtmlDraft(input.markdown)
                    : undefined;
                if (caption !== undefined) {
                    ChannelPosts.assertTelegramChannelPostCaptionWithinLimit(caption);
                }
                const begun = store.beginEdit({
                    operationId: input.operationId,
                    mutationId: input.mutationId,
                    markdown: input.markdown,
                });
                if (!begun.began) {
                    if (begun.record.state === "published" &&
                        begun.record.lastMutationId === input.mutationId)
                        return begun.record;
                    throw new Error("Telegram channel post edit outcome is unknown; refusing automatic replay.");
                }
                if (begun.record.state !== "edit-outcome-unknown")
                    throw new Error("Telegram channel post edit authority is invalid.");
                if (begun.record.media) {
                    if (caption === undefined) {
                        throw new Error("Telegram channel post media caption edit requires retained media identity.");
                    }
                    await telegramApiRuntime.call("editMessageCaption", {
                        chat_id: begun.record.channelId,
                        message_id: begun.record.messageId,
                        caption,
                        parse_mode: "HTML",
                    });
                }
                else {
                    await telegramApiRuntime.call("editMessageText", {
                        chat_id: begun.record.channelId,
                        message_id: begun.record.messageId,
                        text: Replies.renderTelegramMarkdownToHtmlDraft(input.markdown),
                        parse_mode: "HTML",
                    });
                }
                return store.confirmEdited({
                    operationId: input.operationId,
                    mutationId: input.mutationId,
                }).record;
            }
            if (input.markdown !== undefined)
                throw new Error("Telegram channel post deletion does not accept markdown.");
            const begun = store.beginDelete({
                operationId: input.operationId,
                mutationId: input.mutationId,
            });
            if (!begun.began) {
                if (begun.record.state === "deleted" &&
                    begun.record.mutationId === input.mutationId)
                    return begun.record;
                throw new Error("Telegram channel post deletion outcome is unknown; refusing automatic replay.");
            }
            if (begun.record.state !== "delete-outcome-unknown")
                throw new Error("Telegram channel post deletion authority is invalid.");
            await telegramApiRuntime.call("deleteMessage", {
                chat_id: begun.record.channelId,
                message_id: begun.record.messageId,
            });
            return store.confirmDeleted({
                operationId: input.operationId,
                mutationId: input.mutationId,
            }).record;
        },
        callMultipart,
        getDefaultChatId: proactivePushChatIdGetter,
        getDefaultTarget: proactivePushTargetGetter,
        ...agentMessageToolRoutingRuntime,
        setGenerativeAppLiveSurfaceRuntime: generativeAppLiveSurfaceBinding.set,
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
        diagnostics: runtimeDiagnostics,
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
        shutdownGenerativeAppLiveSurfaces: generativeAppLiveSurfaceBinding.shutdown,
        resolveAutomaticThreadCleanupEnabled: configControls.resolveAutomaticThreadCleanupEnabled,
        onSessionStarted(_event, ctx) {
            sessionActionAssembly.settlement.onSessionStart(ctx);
        },
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
        stopGuestPlaceholder: guestPlaceholderRuntime.stop,
        finalizeMarkdownPreview,
        preparePreviewDelivery,
        proactivePushTargetGetter,
        getAssistantRenderingMode: configControls.getAssistantRenderingMode,
        recordMessageOwnership: messageOwnershipRuntime.recordLocal,
        canSendAgentActivity(ctx) {
            return (lockOwnershipGuard.ownsContext(ctx) ||
                telegramBusFollowerRegistrationState.isRegistered());
        },
        isSessionContextActive(ctx) {
            return telegramSessionContextStore.isCurrent(ctx);
        },
        isTurnTransportActive(turn) {
            return telegramTransportStampRuntime.isActive(turn.transportStamp);
        },
        updateStatus,
        recordRuntimeEvent,
        onSessionSettled: inboundRouteRuntime.onSessionSettled,
    });
}
