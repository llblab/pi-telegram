/**
 * Telegram status rendering helpers
 * Zones: telegram ui, pi agent diagnostics, tui
 * Builds usage, cost, and context summaries for the interactive Telegram status view
 */
export type TelegramStatusQueueLane = "control" | "priority" | "default";
export interface TelegramUsageStats {
    totalInput: number;
    totalOutput: number;
    totalCacheRead: number;
    totalCacheWrite: number;
    totalCost: number;
    latestCacheHitRate?: number;
}
interface TelegramUsageMessage {
    role: string;
    usage?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cost: {
            total: number;
        };
    };
}
interface TelegramStatusSessionEntry {
    type: string;
    message?: TelegramUsageMessage;
}
interface TelegramContextUsage {
    contextWindow?: number;
    percent: number | null;
}
export interface TelegramStatusActiveModel {
    provider?: string;
    id?: string;
    contextWindow?: number;
}
export interface TelegramStatusLineProviderContext {
    activeModel: TelegramStatusActiveModel | undefined;
}
export interface TelegramStatusLineProviderResult {
    label: string;
    value: string;
}
export type TelegramStatusLineProvider = (ctx: TelegramStatusLineProviderContext) => TelegramStatusLineProviderResult | undefined;
export interface TelegramStatusContext {
    sessionManager: {
        getEntries(): TelegramStatusSessionEntry[];
    };
    getContextUsage(): TelegramContextUsage | undefined;
    isIdle?: () => boolean;
    hasPendingMessages?: () => boolean;
    isCompactionInProgress?: () => boolean;
    modelRegistry: {
        isUsingOAuth(model: TelegramStatusActiveModel): boolean;
    };
}
export type TelegramRuntimeEventDetailValue = string | number | boolean | null;
export interface TelegramRuntimeEvent {
    at: number;
    category: string;
    message: string;
    details?: Record<string, TelegramRuntimeEventDetailValue>;
}
export interface TelegramRuntimeEventInput {
    category: string;
    error?: unknown;
    message?: string;
    details?: Record<string, unknown>;
}
export interface TelegramRuntimeEventRecorder {
    record: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    getEvents: () => TelegramRuntimeEvent[];
    clear: () => void;
}
export interface TelegramRuntimeEventRecorderOptions {
    getBotToken: () => string | undefined;
    maxEvents?: number;
    now?: () => number;
}
export interface TelegramBridgeStatusBusFollower {
    instanceId: string;
    cwd?: string;
    lastHeartbeatMs: number;
    target?: {
        chatId: number;
        threadId?: number;
    };
    protocol?: {
        protocolVersion: number;
        runtimeBuild: string;
        capabilities: string[];
    };
    slot?: string;
    threadName?: string;
    status?: string;
}
export interface TelegramBridgeStatusLocalBus {
    leaderSocketPath?: string;
    leaderTransport?: "pipe" | "socket";
    followerSocketPath?: string;
    followerTransport?: "pipe" | "socket";
    followerRegistered?: boolean;
    followerTarget?: {
        chatId: number;
        threadId?: number;
    };
    followerSlot?: string;
    followerThreadName?: string;
    leaderProtocol?: {
        protocolVersion: number;
        runtimeBuild: string;
        capabilities: string[];
    };
}
export interface TelegramBridgeStatusTopicTarget {
    instanceId?: string;
    status?: string;
    target?: {
        chatId: number;
        threadId?: number;
    };
    slot?: string;
    threadName?: string;
    syncStatus?: string;
    lastSyncObservedAtMs?: number;
    lastSyncProbeAtMs?: number;
    lastSyncError?: string;
    lastReconcileAction?: string;
}
export interface TelegramBridgeStatusThreadReservation {
    target?: {
        chatId: number;
        threadId?: number;
    };
    slot?: string;
    reason?: string;
    instanceId?: string;
    expiresAtMs?: number;
    lastReconcileAction?: string;
}
export interface TelegramBridgeStatusSyncObservation {
    target?: {
        chatId: number;
        threadId?: number;
    };
    syncStatus: string;
    observedAtMs: number;
    instanceId?: string;
    slot?: string;
    lastSyncError?: string;
    lastReconcileAction?: string;
}
export interface TelegramBridgeStatusSyncSlice {
    status: string;
    updatedAtMs?: number;
    suspectAtMs?: number;
    reason?: string;
    lastReconcileAction?: string;
}
export interface TelegramBridgeThreadReconciliationState {
    phase: string;
    event: string;
    atMs: number;
    leaderEpoch?: number | string;
    pendingProvisionCount: number;
    syncActionCount: number;
    cleanupActionCount: number;
}
export type TelegramBridgeBusRole = "leader" | "follower";
export type TelegramBridgeBusLifecyclePhase = "electing";
export interface TelegramBridgePollingState {
    phase: string;
    phaseStartedAtMs?: number;
    currentUpdateId?: number;
    startedAtMs?: number;
    stoppedAtMs?: number;
    lastSuccessfulResponseAtMs?: number;
    lastSuccessfulResponseUpdateCount?: number;
    stopReason?: string;
}
export interface TelegramBridgeInboundWorkerState {
    phase: string;
    generation: number;
    phaseStartedAtMs?: number;
    currentUpdateId?: number;
    blockedReason?: string;
    blockedInputCustody?: {
        updateId: number;
        kind: string;
    };
    journalEntryCount: number;
    journalSerializedBytes: number;
    oldestAdmittedAtMs?: number;
    deferredClaimCount: number;
    queuedClaimCount: number;
    foreignQueuedCount: number;
    foreignQueuedOwnerLiveness?: "alive" | "dead" | "unverifiable";
    foreignQueuedOwner?: {
        instanceId: string;
        processId: number;
        processBirthId: string;
        sessionGeneration: number;
        acquisitionId: string;
        acquiredAtMs: number;
    };
    retryWaitCount: number;
    failedCount: number;
    nextRetryUpdateId?: number;
    nextRetryAtMs?: number;
    nextRetryAttemptCount?: number;
    nextRetryFailureClass?: string;
    failedUpdateId?: number;
    failedFailureId?: string;
    failedAttemptCount?: number;
    failedClass?: string;
    failedSummary?: string;
    terminalFailureAtMs?: number;
    unsettledExecutionCount: number;
    lastCompletedUpdateId?: number;
    lastCompletedAtMs?: number;
    lastFailureAtMs?: number;
    lastFailurePhase?: string;
}
export interface TelegramBridgeStatusLineState {
    hasBotToken?: boolean;
    botUsername?: string;
    /** Redacted named-variable diagnostic when the stored token reference cannot resolve. */
    botTokenDiagnostic?: string;
    activeProfileName?: string;
    diagnosticPaths?: {
        state: string;
        logs: string;
    };
    allowedUserId?: number;
    botThreadMode?: "unknown" | "enabled" | "disabled";
    botThreadModeUpdatedAtMs?: number;
    botThreadModeAction?: string;
    busRole?: TelegramBridgeBusRole;
    busProtocol?: {
        protocolVersion: number;
        runtimeBuild: string;
        capabilities: string[];
    };
    busLifecyclePhase?: TelegramBridgeBusLifecyclePhase;
    instanceSlot?: string;
    instanceThreadName?: string;
    lockState?: string;
    pollingActive: boolean;
    polling?: TelegramBridgePollingState;
    inboundWorker?: TelegramBridgeInboundWorkerState;
    lastUpdateId?: number;
    activeSourceMessageIds?: number[];
    pendingDispatch: boolean;
    compactionInProgress: boolean;
    activeToolExecutions: number;
    pendingModelSwitch: boolean;
    queuedItems: Array<{
        queueLane: TelegramStatusQueueLane;
    }>;
    busFollowers?: TelegramBridgeStatusBusFollower[];
    localBus?: TelegramBridgeStatusLocalBus;
    topicTargets?: TelegramBridgeStatusTopicTarget[];
    threadReservations?: TelegramBridgeStatusThreadReservation[];
    topicSyncObservations?: TelegramBridgeStatusSyncObservation[];
    syncState?: Record<string, TelegramBridgeStatusSyncSlice | undefined>;
    threadReconciliation?: TelegramBridgeThreadReconciliationState;
    busNowMs?: number;
    recentRuntimeEvents: TelegramRuntimeEvent[];
}
export interface TelegramStatusBarTheme {
    fg: (token: "accent" | "dim" | "error" | "muted" | "warning" | "success", text: string) => string;
}
export interface TelegramStatusBarState {
    hasBotToken: boolean;
    pollingActive: boolean;
    pollingStopReason?: string;
    paired: boolean;
    busRole?: TelegramBridgeBusRole;
    followerRegistered?: boolean;
    busLifecyclePhase?: TelegramBridgeBusLifecyclePhase;
    instanceSlot?: string;
    instanceThreadName?: string;
    compactionInProgress: boolean;
    processing: boolean;
    processingStatus?: string;
    queuedStatus: string;
    error?: string;
}
export interface TelegramStatusRuntimeContext {
    ui: {
        theme: TelegramStatusBarTheme;
        setStatus: (key: string, text: string) => void;
    };
}
export interface TelegramStatusRuntimeDeps<TContext extends TelegramStatusRuntimeContext> {
    statusKey?: string;
    getStatusBarState: (ctx: TContext, error?: string) => TelegramStatusBarState;
    getBridgeStatusLineState: () => TelegramBridgeStatusLineState;
}
export interface TelegramBridgeStatusConfig {
    botToken?: string;
    /** Caller-resolved token availability; falls back to raw presence. */
    botHasToken?: boolean;
    /** Caller-supplied redacted diagnostic for an unresolved token reference. */
    botTokenDiagnostic?: string;
    botUsername?: string;
    allowedUserId?: number;
}
/** Narrow config-store view used to project resolved bot-token availability. */
export interface TelegramBridgeStatusConfigSource {
    get: () => TelegramBridgeStatusConfig;
    hasBotToken?: () => boolean;
    getBotTokenDiagnostic?: () => string | undefined;
}
/**
 * Project a config store into the status view without moving token-reference
 * resolution into this structural leaf domain.
 */
export declare function createTelegramBridgeStatusConfigGetter(source: TelegramBridgeStatusConfigSource): () => TelegramBridgeStatusConfig;
export interface TelegramBridgeStatusRuntimeDeps<TQueueItem extends {
    queueLane: TelegramStatusQueueLane;
}> {
    statusKey?: string;
    getConfig: () => TelegramBridgeStatusConfig;
    getActiveProfileName?: () => string | undefined;
    getDiagnosticPaths?: (profileName?: string) => {
        state: string;
        logs: string;
    };
    isPollingActive: () => boolean;
    getPollingState?: () => TelegramBridgePollingState;
    getInboundWorkerState?: () => TelegramBridgeInboundWorkerState | undefined;
    getAcceptedThroughUpdateId?: () => number | undefined;
    getActiveSourceMessageIds: () => number[] | undefined;
    hasActiveTurn: () => boolean;
    hasDispatchPending: () => boolean;
    isCompactionInProgress: () => boolean;
    getActiveToolExecutions: () => number;
    hasPendingModelSwitch: () => boolean;
    getQueuedItems: () => TQueueItem[];
    getQueuedItemCount?: (items: TQueueItem[]) => number;
    formatQueuedStatus: (items: TQueueItem[]) => string;
    getRecentRuntimeEvents: () => TelegramRuntimeEvent[];
    getRuntimeLockState?: () => string;
    getBusRole?: () => TelegramBridgeBusRole | undefined;
    getBusProtocol?: () => {
        protocolVersion: number;
        runtimeBuild: string;
        capabilities: string[];
    };
    getBusLifecyclePhase?: () => TelegramBridgeBusLifecyclePhase | undefined;
    getBotThreadMode?: () => {
        threadMode: "unknown" | "enabled" | "disabled";
        updatedAtMs?: number;
        lastReconcileAction?: string;
    } | undefined;
    getBusFollowers?: () => TelegramBridgeStatusBusFollower[];
    getLocalBus?: () => TelegramBridgeStatusLocalBus | undefined;
    getTopicTargets?: () => TelegramBridgeStatusTopicTarget[];
    getThreadReservations?: () => TelegramBridgeStatusThreadReservation[];
    getTopicSyncObservations?: () => TelegramBridgeStatusSyncObservation[];
    getSyncState?: () => Record<string, TelegramBridgeStatusSyncSlice | undefined>;
    getThreadReconciliationState?: () => TelegramBridgeThreadReconciliationState | undefined;
    getInstanceSlot?: () => string | undefined;
    getInstanceThreadName?: () => string | undefined;
    getNowMs?: () => number;
}
export interface TelegramBridgeStatusLineOptions {
    verbose?: boolean;
}
export interface TelegramStatusRuntime<TContext extends TelegramStatusRuntimeContext> {
    updateStatus: (ctx: TContext, error?: string) => void;
    getStatusLines: (options?: TelegramBridgeStatusLineOptions) => string[];
    getStatusState: () => TelegramBridgeStatusLineState;
}
export declare function redactTelegramRuntimeMessage(message: string, botToken: string | undefined): string;
export declare function recordStructuredTelegramRuntimeEvent(events: TelegramRuntimeEvent[], input: TelegramRuntimeEventInput, options: {
    botToken?: string;
    maxEvents: number;
    now?: number;
}): void;
/**
 * Register a compact extension-provided line for the Telegram status menu.
 *
 * Providers are synchronous and should return undefined when their line is not
 * relevant for the active model. Errors are isolated so optional extension
 * status cannot break the core Telegram menu.
 */
export declare function registerTelegramStatusLineProvider(provider: TelegramStatusLineProvider, options: {
    id: string;
}): () => void;
export declare function getTelegramStatusLineProviderResults(ctx: TelegramStatusLineProviderContext): TelegramStatusLineProviderResult[];
export declare function clearTelegramStatusLineProviders(): void;
export declare function createTelegramRuntimeEventRecorder(options: TelegramRuntimeEventRecorderOptions): TelegramRuntimeEventRecorder;
export declare function buildTelegramRuntimeEventLines(events: TelegramRuntimeEvent[]): string[];
export declare function createTelegramStatusHtmlBuilder<TContext>(deps: {
    getActiveModel: (ctx: TContext) => TelegramStatusActiveModel | undefined;
    isCompactionInProgress?: () => boolean;
    getBridgeStatusLineState?: () => TelegramBridgeStatusLineState;
}): (ctx: TContext & TelegramStatusContext) => string;
export declare function createTelegramStatusRuntime<TContext extends TelegramStatusRuntimeContext>(deps: TelegramStatusRuntimeDeps<TContext>): TelegramStatusRuntime<TContext>;
export declare function createTelegramBridgeStatusRuntime<TContext extends TelegramStatusRuntimeContext, TQueueItem extends {
    queueLane: TelegramStatusQueueLane;
}>(deps: TelegramBridgeStatusRuntimeDeps<TQueueItem>): TelegramStatusRuntime<TContext>;
export interface TelegramRuntimeLogScope extends Record<string, unknown> {
    instanceId: string;
    role: string;
    slot?: string;
    threadName?: string;
    lockState?: string;
}
export declare function createTelegramRuntimeLogScope(input: {
    state: TelegramBridgeStatusLineState;
    instanceId: string;
}): TelegramRuntimeLogScope;
export declare function createTelegramStatusSnapshot(state: TelegramBridgeStatusLineState): {
    runtime: Record<string, unknown>;
    liveRoster: Record<string, unknown>;
    diagnostics: Record<string, unknown>;
};
export declare function createTelegramRuntimeDiagnosticsSnapshotScheduler(deps: {
    persistSnapshot: () => Promise<void>;
    recordError: (error: unknown) => void;
    setTimer?: (callback: () => void, ms: number) => {
        unref?: () => void;
    };
}): () => void;
export declare function getTelegramStatusBarProcessingStatus(state: {
    hasActiveTurn: boolean;
    hasPendingDispatch: boolean;
    hasPendingModelSwitch: boolean;
    activeToolExecutions: number;
    queuedItems: number;
}): string | undefined;
export declare function buildTelegramStatusBarText(theme: TelegramStatusBarTheme, state: TelegramStatusBarState): string;
export declare function buildTelegramBridgeStatusLines(state: TelegramBridgeStatusLineState, options?: TelegramBridgeStatusLineOptions): string[];
export declare function buildTelegramBridgeDiagnosticStatusLines(state: TelegramBridgeStatusLineState): string[];
export declare function buildStatusHtml(ctx: TelegramStatusContext, activeModel: TelegramStatusActiveModel | undefined, bridgeStatus?: TelegramBridgeStatusLineState): string;
export {};
