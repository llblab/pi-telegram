/**
 * Telegram polling runtime domain helpers
 * Zones: telegram transport, polling runtime
 * Owns polling request builders, stop conditions, and the long-poll loop runtime for Telegram updates
 */
type MaybePromise<T> = T | Promise<T>;
export interface TelegramPollingConfig {
    botToken?: string;
}
export interface TelegramUpdate {
    update_id: number;
}
export declare const TELEGRAM_GET_UPDATES_CONFLICT_STOP_LIMIT = 10;
export declare const TELEGRAM_GET_UPDATES_GRACE_MS = 10000;
export declare const TELEGRAM_ALLOWED_UPDATES: readonly ["message", "edited_message", "callback_query", "message_reaction", "guest_message"];
export declare function buildTelegramInitialSyncRequest(): {
    offset: number;
    limit: number;
    timeout: number;
};
export declare function buildTelegramLongPollRequest(lastUpdateId?: number): {
    offset?: number;
    limit: number;
    timeout: number;
    allowed_updates: readonly string[];
};
export declare function getLatestTelegramUpdateId(updates: readonly TelegramUpdate[]): number | undefined;
export declare class TelegramPersistentGetUpdatesConflictError extends Error {
    readonly count: number;
    constructor(count: number);
}
export declare class TelegramGetUpdatesTimeoutError extends Error {
    readonly timeoutMs: number;
    constructor(timeoutMs: number);
}
export declare function getTelegramGetUpdatesRequestBudgetMs(body: Record<string, unknown>, graceMs?: number): number;
export declare function shouldStopTelegramPolling(signalAborted: boolean, error: unknown): boolean;
export interface TelegramPollingStartState {
    hasBotToken: boolean;
    hasPollingPromise: boolean;
}
export type TelegramPollingWorkPhase = "long-poll" | "persisting-journal" | "persisting-offset" | "retrying";
export type TelegramPollingPhase = "stopped" | "starting" | TelegramPollingWorkPhase;
export type TelegramPollingStopReason = "not-started" | "requested" | "completed" | "failed" | "persistent-conflict";
export interface TelegramPollingStateSnapshot {
    phase: TelegramPollingPhase;
    phaseStartedAtMs?: number;
    currentUpdateId?: number;
    startedAtMs?: number;
    stoppedAtMs?: number;
    lastSuccessfulResponseAtMs?: number;
    lastSuccessfulResponseUpdateCount?: number;
    stopReason?: TelegramPollingStopReason;
}
export interface TelegramPollingControllerState extends TelegramPollingStateSnapshot {
    pollingPromise?: Promise<void>;
    pollingController?: AbortController;
}
export declare function createTelegramPollingControllerState(): TelegramPollingControllerState;
export declare function getTelegramPollingStateSnapshot(state: TelegramPollingControllerState): TelegramPollingStateSnapshot;
export declare function createTelegramPollingStateReader(state: TelegramPollingControllerState): () => TelegramPollingStateSnapshot;
export declare function isTelegramPollingControllerActive(state: TelegramPollingControllerState): boolean;
export declare function createTelegramPollingActivityReader(state: TelegramPollingControllerState): () => boolean;
export interface TelegramPollingRuntimeDeps<TContext> extends TelegramRuntimeEventRecorderPort {
    hasBotToken: () => boolean;
    getPollingPromise: () => Promise<void> | undefined;
    setPollingPromise: (promise: Promise<void> | undefined) => void;
    getPollingController: () => AbortController | undefined;
    setPollingController: (controller: AbortController | undefined) => void;
    stopTypingLoop: () => unknown;
    runPollLoop: (ctx: TContext, signal: AbortSignal) => Promise<void>;
    updateStatus: (ctx: TContext, message?: string) => void;
    createAbortController?: () => AbortController;
    getNowMs?: () => number;
    onPollingStateChange?: () => void;
    onPersistentConflict?: (ctx: TContext, count: number) => MaybePromise<void>;
    onPollingStarted?: () => void;
    onPollingStopped?: (reason: TelegramPollingStopReason) => void;
}
export type TelegramPollingControllerDeps<TContext> = Omit<TelegramPollingRuntimeDeps<TContext>, "getPollingPromise" | "setPollingPromise" | "getPollingController" | "setPollingController"> & {
    state?: TelegramPollingControllerState;
};
export interface TelegramPollingController<TContext> {
    isActive: () => boolean;
    start: (ctx: TContext) => void;
    stop: () => Promise<void>;
}
export interface TelegramPollingAdmissionRuntime<TContext> {
    isActive: () => boolean;
    start: (ctx: TContext) => Promise<void>;
    stop: () => Promise<void>;
}
export declare function createTelegramPollingAdmissionRuntime<TContext>(deps: {
    polling: TelegramPollingController<TContext>;
    prepareStart?: () => MaybePromise<void>;
    canStart?: (ctx: TContext) => boolean;
    validateStart?: () => void;
    worker: {
        onSessionStart: (ctx: TContext) => Promise<void>;
    };
}): TelegramPollingAdmissionRuntime<TContext>;
export interface TelegramDurablePollingRuntimeAssembly<TContext> {
    controller: TelegramPollingController<TContext>;
    admission: TelegramPollingAdmissionRuntime<TContext>;
}
export type TelegramDurablePollingRuntimeAssemblyDeps<TUpdate extends TelegramUpdate, TContext> = Omit<TelegramPollingControllerRuntimeDeps<TUpdate, TContext>, "appendUpdateBatch" | "getJournalEntryCount" | "signalUpdateWorker"> & {
    canStart?: (ctx: TContext) => boolean;
    prepareUpdateBatch?: (updates: readonly TUpdate[]) => void;
    journal: {
        appendBatch: (updates: readonly TUpdate[], acceptedThroughUpdateId?: number) => {
            nonExcludedUpdateIds: readonly number[];
        };
        getAcceptedThroughUpdateId: () => number | undefined;
        prepareCursorCutover?: () => MaybePromise<void>;
        getEntryCount: () => number;
        signalWorker: () => void;
        getBootstrapEntryCount: () => number;
        onSessionStart: (ctx: TContext) => Promise<void>;
    };
};
/** Own journal-first polling assembly and cursor bootstrap validation. */
export declare function createTelegramDurablePollingRuntimeAssembly<TUpdate extends TelegramUpdate, TContext>(deps: TelegramDurablePollingRuntimeAssemblyDeps<TUpdate, TContext>): TelegramDurablePollingRuntimeAssembly<TContext>;
export type TelegramPollingControllerRuntimeDeps<TUpdate extends TelegramUpdate, TContext = unknown> = Omit<TelegramPollLoopRunnerDeps<TUpdate, TContext>, "onPhaseChange" | "onSuccessfulResponse"> & {
    state?: TelegramPollingControllerState;
    hasBotToken: () => boolean;
    stopTypingLoop: () => unknown;
    createAbortController?: () => AbortController;
    getNowMs?: () => number;
    onPollingStateChange?: () => void;
    onPersistentConflict?: (ctx: TContext, count: number) => MaybePromise<void>;
};
export declare function createTelegramPollingControllerRuntime<TUpdate extends TelegramUpdate, TContext = unknown>(deps: TelegramPollingControllerRuntimeDeps<TUpdate, TContext>): TelegramPollingController<TContext>;
export declare function createTelegramPollingController<TContext>(deps: TelegramPollingControllerDeps<TContext>): TelegramPollingController<TContext>;
export declare function shouldStartTelegramPolling(state: TelegramPollingStartState): boolean;
export declare function stopTelegramPollingRuntime<TContext>(deps: TelegramPollingRuntimeDeps<TContext>): Promise<void>;
export declare function startTelegramPollingRuntime<TContext>(ctx: TContext, deps: TelegramPollingRuntimeDeps<TContext>): void;
export interface TelegramRuntimeEventRecorderPort {
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export type TelegramThreadCapabilityMode = "enabled" | "disabled" | "unknown";
export interface TelegramThreadCapabilityState {
    threadMode?: TelegramThreadCapabilityMode;
    updatedAtMs?: number;
    lastSlot?: string;
    lastReconcileAction?: string;
}
export interface TelegramThreadCapabilityRecordView {
    status?: string;
    target?: {
        chatId?: number;
        threadId?: number;
    };
}
export interface TelegramThreadCapabilityStore {
    load: () => Promise<void>;
    refresh?: () => Promise<void>;
    persist: () => Promise<void>;
    getBotState: () => TelegramThreadCapabilityState;
    setBotState: (state: TelegramThreadCapabilityState) => void;
    list?: () => TelegramThreadCapabilityRecordView[];
}
export interface TelegramThreadCapabilityReaderDeps {
    getAllowedUserId: () => number | undefined;
    callApi: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
}
interface TelegramThreadCapabilityLifecycle {
    capture: () => () => boolean;
    invalidate: () => void;
}
export interface TelegramStartupThreadCapabilityProbeDeps extends TelegramThreadCapabilityReaderDeps {
    topicTargetStore: TelegramThreadCapabilityStore;
    recordEvent: (category: string, message: unknown, details?: Record<string, unknown>) => void;
    setTopicModeUnavailable: (unavailable: boolean) => void;
    getNowMs?: () => number;
}
export interface TelegramThreadCapabilityRuntimeDeps<TContext> extends TelegramThreadCapabilityReaderDeps {
    lifecycle?: TelegramThreadCapabilityLifecycle;
    topicTargetStore: TelegramThreadCapabilityStore;
    ownsLock: (ctx: TContext) => boolean;
    isFollowerRegistered?: () => boolean;
    getPollingStartedWithTelegramBus: () => boolean;
    setPollingStartedWithTelegramBus: (started: boolean) => void;
    setTopicModeUnavailable: (unavailable: boolean) => void;
    suspendLiveThreadTarget?: () => void;
    stopFollowerRegistration: () => void;
    startClassicPolling: (ctx: TContext) => MaybePromise<void>;
    stopClassicPolling: () => MaybePromise<void>;
    startBusPolling: (ctx: TContext) => MaybePromise<void>;
    stopBusPolling: () => MaybePromise<void>;
    startLeaderHealth: () => void;
    stopLeaderHealth: () => void;
    isTopicModeUnavailableError?: (error: unknown) => boolean;
    updateStatus: (ctx: TContext) => void;
    recordEvent: (category: string, message: unknown, details?: Record<string, unknown>) => void;
    getNowMs?: () => number;
    intervalMs?: number;
}
export interface TelegramThreadCapabilityMonitor<TContext> {
    start: (ctx: TContext) => void;
    stop: () => void;
}
export interface TelegramThreadCapabilityStateRuntime {
    isBusPollingStarted(): boolean;
    setBusPollingStarted(started: boolean): void;
    isTopicModeUnavailable(): boolean;
    setTopicModeUnavailable(unavailable: boolean): void;
    isBusRuntimeEnabled(): boolean;
    shouldForceFreshLeaderThread(): boolean;
    setForceFreshLeaderThread(forceFresh: boolean): void;
    getRequestedThreadName(): string | undefined;
    setRequestedThreadName(threadName: string | undefined): void;
}
export type TelegramThreadTargetObservationHandler<TContext> = (ctx: TContext) => Promise<void>;
export interface TelegramThreadTargetObservationBinding<TContext> {
    handle: TelegramThreadTargetObservationHandler<TContext>;
    set(handler: TelegramThreadTargetObservationHandler<TContext>): void;
}
export declare function createTelegramThreadTargetObservationBinding<TContext>(): TelegramThreadTargetObservationBinding<TContext>;
export interface TelegramThreadAwarePollingPorts<TContext, TOwner> {
    startPolling: (ctx: TContext, options?: {
        forceFreshLeaderThread?: boolean;
    }) => Promise<void>;
    stopPolling: () => Promise<void>;
    registerFollowerWithOwner: (ctx: TContext, owner: TOwner) => Promise<boolean | undefined>;
    restoreFollowerWithOwner: (ctx: TContext, owner: TOwner) => Promise<boolean | undefined>;
    stopFollowerRegistration: () => void;
}
export interface TelegramThreadAwarePollingDeps<TContext, TOwner> extends TelegramStartupThreadCapabilityProbeDeps {
    lifecycle?: TelegramThreadCapabilityLifecycle;
    isBusRuntimeEnabled: () => boolean;
    isTopicModeUnavailableError: (error: unknown) => boolean;
    getPollingStartedWithTelegramBus: () => boolean;
    setPollingStartedWithTelegramBus: (started: boolean) => void;
    setForceFreshLeaderThreadOnNextStart: (forceFresh: boolean) => void;
    startClassicPolling: (ctx: TContext) => MaybePromise<void>;
    stopClassicPolling: () => Promise<void>;
    startBusLeaderPolling: (ctx: TContext) => Promise<void>;
    stopBusLeaderPolling: () => Promise<void>;
    startLeaderHealth: () => void;
    stopLeaderHealth: () => void;
    registerFollowerWithLeader: (ctx: TContext, owner: TOwner) => Promise<boolean | undefined>;
    restoreFollowerWithLeader?: (ctx: TContext, owner: TOwner) => Promise<boolean | undefined>;
    hasRememberedWorkspaceBinding?: (ctx: TContext) => boolean;
    stopFollowerRegistration: () => void;
}
export interface TelegramThreadCapabilityOrchestrationDeps<TContext, TOwner> extends TelegramThreadCapabilityReaderDeps {
    state: TelegramThreadCapabilityStateRuntime;
    topicTargetStore: TelegramThreadCapabilityStore;
    isBusRuntimeEnabled: () => boolean;
    ownsLock: (ctx: TContext) => boolean;
    isFollowerRegistered?: () => boolean;
    startClassicPolling: (ctx: TContext) => MaybePromise<void>;
    stopClassicPolling: () => Promise<void>;
    startBusLeaderPolling: (ctx: TContext) => Promise<void>;
    stopBusLeaderPolling: () => Promise<void>;
    startLeaderHealth: () => void;
    stopLeaderHealth: () => void;
    registerFollowerWithLeader: (ctx: TContext, owner: TOwner) => Promise<boolean | undefined>;
    restoreFollowerWithLeader?: (ctx: TContext, owner: TOwner) => Promise<boolean | undefined>;
    hasRememberedWorkspaceBinding?: (ctx: TContext) => boolean;
    suspendLiveThreadTarget?: () => void;
    stopFollowerRegistration: () => void;
    isTopicModeUnavailableError: (error: unknown) => boolean;
    updateStatus: (ctx: TContext) => void;
    recordEvent: (category: string, message: unknown, details?: Record<string, unknown>) => void;
}
export interface TelegramThreadCapabilityOrchestration<TContext, TOwner> {
    monitor: TelegramThreadCapabilityMonitor<TContext>;
    observeTarget: TelegramThreadTargetObservationHandler<TContext>;
    pollingPorts: TelegramThreadAwarePollingPorts<TContext, TOwner>;
}
export declare function createTelegramThreadCapabilityStateRuntime(): TelegramThreadCapabilityStateRuntime;
export declare function createTelegramThreadCapabilityOrchestration<TContext, TOwner>(deps: TelegramThreadCapabilityOrchestrationDeps<TContext, TOwner>): TelegramThreadCapabilityOrchestration<TContext, TOwner>;
export declare function readTelegramThreadCapability(deps: TelegramThreadCapabilityReaderDeps): Promise<boolean | undefined>;
export declare function probeTelegramStartupThreadCapability(deps: TelegramStartupThreadCapabilityProbeDeps, isCurrent?: () => boolean): Promise<boolean | undefined>;
export declare function applyTelegramThreadCapability<TContext>(ctx: TContext, threadModeEnabled: boolean, phase: string, deps: TelegramThreadCapabilityRuntimeDeps<TContext>, isCurrent?: () => boolean): Promise<void>;
export declare function createTelegramThreadAwarePollingPorts<TContext, TOwner>(deps: TelegramThreadAwarePollingDeps<TContext, TOwner>): TelegramThreadAwarePollingPorts<TContext, TOwner>;
export declare function createTelegramThreadTargetObservationHandler<TContext>(deps: TelegramThreadCapabilityRuntimeDeps<TContext>): TelegramThreadTargetObservationHandler<TContext>;
export declare function canProbeTelegramThreadCapability<TContext>(ctx: TContext, deps: Pick<TelegramThreadCapabilityRuntimeDeps<TContext>, "ownsLock" | "isFollowerRegistered">): boolean;
export declare function createTelegramThreadCapabilityMonitor<TContext>(deps: TelegramThreadCapabilityRuntimeDeps<TContext>): TelegramThreadCapabilityMonitor<TContext>;
export declare class TelegramPollingBatchValidationError extends Error {
    constructor(message: string);
}
export declare class TelegramPollingCursorBootstrapError extends Error {
    constructor(message: string);
}
export interface TelegramPollingCursorCutoverDeps {
    getLegacyCursor: () => number | undefined;
    readJournal: () => {
        acceptedThroughUpdateId?: number;
        entries: readonly {
            updateId: number;
        }[];
    };
    publishJournalCursor: (acceptedThroughUpdateId: number) => MaybePromise<void>;
    removeLegacyCursor: () => MaybePromise<void>;
}
/** Transfer one legacy config cursor into journal authority before deleting it. */
export declare function cutOverTelegramPollingCursor(deps: TelegramPollingCursorCutoverDeps): Promise<void>;
export interface TelegramPollingBatchAdmissionResult {
    updateCount: number;
    latestUpdateId?: number;
}
export interface TelegramPollingBatchAdmissionDeps<TUpdate extends TelegramUpdate> extends TelegramRuntimeEventRecorderPort {
    updates: readonly TUpdate[];
    config: TelegramPollingConfig;
    appendBatch: (updates: readonly TUpdate[], acceptedThroughUpdateId?: number) => MaybePromise<unknown>;
    getAcceptedThroughUpdateId?: () => number | undefined;
    persistConfig: (config: TelegramPollingConfig) => Promise<void>;
    signalWorker: () => void;
    onPhaseChange?: (phase: TelegramPollingWorkPhase, currentUpdateId?: number) => void;
}
export declare function admitTelegramPollingUpdateBatch<TUpdate extends TelegramUpdate>(deps: TelegramPollingBatchAdmissionDeps<TUpdate>): Promise<TelegramPollingBatchAdmissionResult>;
export interface TelegramPollLoopDeps<TUpdate extends TelegramUpdate, TContext = unknown> extends TelegramRuntimeEventRecorderPort {
    ctx: TContext;
    signal: AbortSignal;
    config: TelegramPollingConfig;
    deleteWebhook: (signal: AbortSignal) => Promise<unknown>;
    getUpdates: (body: Record<string, unknown>, signal: AbortSignal) => Promise<TUpdate[]>;
    getUpdatesRequestBudgetMs?: (body: Record<string, unknown>) => number;
    persistConfig: (config: TelegramPollingConfig) => Promise<void>;
    appendUpdateBatch: (updates: readonly TUpdate[], acceptedThroughUpdateId?: number) => MaybePromise<unknown>;
    getAcceptedThroughUpdateId?: () => number | undefined;
    getJournalEntryCount: () => number;
    signalUpdateWorker: () => void;
    onErrorStatus: (message: string) => void;
    onStatusReset: () => void;
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    onPhaseChange?: (phase: TelegramPollingWorkPhase, currentUpdateId?: number) => void;
    onSuccessfulResponse?: (updateCount: number) => void;
}
export interface TelegramPollLoopRunnerDeps<TUpdate extends TelegramUpdate, TContext = unknown> extends TelegramRuntimeEventRecorderPort {
    getConfig: () => TelegramPollingConfig;
    deleteWebhook: (signal: AbortSignal) => Promise<unknown>;
    getUpdates: (body: Record<string, unknown>, signal: AbortSignal) => Promise<TUpdate[]>;
    getUpdatesRequestBudgetMs?: (body: Record<string, unknown>) => number;
    persistConfig: (config: TelegramPollingConfig) => Promise<void>;
    appendUpdateBatch: (updates: readonly TUpdate[], acceptedThroughUpdateId?: number) => MaybePromise<unknown>;
    getAcceptedThroughUpdateId?: () => number | undefined;
    getJournalEntryCount: () => number;
    signalUpdateWorker: () => void;
    updateStatus: (ctx: TContext, message?: string) => void;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    onPhaseChange?: (phase: TelegramPollingWorkPhase, currentUpdateId?: number) => void;
    onSuccessfulResponse?: (updateCount: number) => void;
}
export declare function sleepTelegramPollingRetry(ms: number, signal?: AbortSignal): Promise<void>;
export declare function createTelegramPollLoopRunner<TUpdate extends TelegramUpdate, TContext = unknown>(deps: TelegramPollLoopRunnerDeps<TUpdate, TContext>): (ctx: TContext, signal: AbortSignal) => Promise<void>;
export declare function isTelegramGetUpdatesConflictError(error: unknown): boolean;
export declare function runTelegramPollLoop<TUpdate extends TelegramUpdate, TContext = unknown>(deps: TelegramPollLoopDeps<TUpdate, TContext>): Promise<void>;
export {};
