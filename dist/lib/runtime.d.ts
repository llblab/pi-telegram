/**
 * Telegram bridge runtime-state helpers
 * Zones: pi agent runtime state, telegram session, shared coordination
 * Owns small session-local runtime primitives that are shared by orchestration but are not specific to queueing, rendering, polling, or Telegram transport
 */
export interface TelegramRuntimeQueueCounters {
    nextQueuedTelegramItemOrder: number;
    nextQueuedTelegramControlOrder: number;
}
export interface TelegramRuntimeLifecycleFlags {
    activeTelegramToolExecutions: number;
    telegramTurnDispatchPending: boolean;
    compactionInProgress: boolean;
    foldQueuedPromptsIntoHistory: boolean;
    setupInProgress: boolean;
}
export interface TelegramBridgeRuntimeState extends TelegramRuntimeQueueCounters, TelegramRuntimeLifecycleFlags {
    abortHandler?: () => void;
    typingInterval?: ReturnType<typeof setInterval>;
    typingInFlight?: Promise<void>;
    typingLoopDeps?: TelegramTypingLoopDeps;
    typingLoopKey?: string;
}
export interface TelegramRuntimeQueuePort {
    syncCounters: (counters: Partial<TelegramRuntimeQueueCounters>) => void;
    allocateItemOrder: () => number;
    allocateControlOrder: () => number;
}
export interface TelegramRuntimeLifecyclePort {
    syncFlags: (flags: Partial<TelegramRuntimeLifecycleFlags>) => void;
    getActiveToolExecutions: () => number;
    setActiveToolExecutions: (count: number) => void;
    resetActiveToolExecutions: () => void;
    hasDispatchPending: () => boolean;
    setDispatchPending: (pending: boolean) => void;
    clearDispatchPending: () => void;
    isCompactionInProgress: () => boolean;
    setCompactionInProgress: (inProgress: boolean) => void;
    shouldFoldQueuedPromptsIntoHistory: () => boolean;
    setFoldQueuedPromptsIntoHistory: (fold: boolean) => void;
}
export interface TelegramRuntimeSetupPort {
    isInProgress: () => boolean;
    start: () => boolean;
    finish: () => void;
}
export interface TelegramRuntimeAbortPort {
    hasHandler: () => boolean;
    setHandler: (abortHandler: () => void) => void;
    clearHandler: () => void;
    getHandler: () => (() => void) | undefined;
    abortTurn: () => boolean;
}
export interface TelegramRuntimeTypingPort {
    start: (deps: TelegramTypingLoopDeps) => boolean;
    stop: () => boolean;
    waitForIdle: () => Promise<void>;
}
export interface TelegramBridgeRuntime {
    state: TelegramBridgeRuntimeState;
    queue: TelegramRuntimeQueuePort;
    lifecycle: TelegramRuntimeLifecyclePort;
    setup: TelegramRuntimeSetupPort;
    abort: TelegramRuntimeAbortPort;
    typing: TelegramRuntimeTypingPort;
}
export declare function createTelegramBridgeRuntimeState(): TelegramBridgeRuntimeState;
export declare function createTelegramBridgeRuntime(state?: TelegramBridgeRuntimeState): TelegramBridgeRuntime;
export declare function syncTelegramQueueRuntimeCounters(state: TelegramBridgeRuntimeState, counters: Partial<TelegramRuntimeQueueCounters>): void;
export declare function allocateTelegramQueueItemOrder(state: TelegramBridgeRuntimeState): number;
export declare function allocateTelegramQueueControlOrder(state: TelegramBridgeRuntimeState): number;
export declare function syncTelegramLifecycleRuntimeFlags(state: TelegramBridgeRuntimeState, flags: Partial<TelegramRuntimeLifecycleFlags>): void;
export declare function getActiveTelegramToolExecutions(state: TelegramBridgeRuntimeState): number;
export declare function setActiveTelegramToolExecutions(state: TelegramBridgeRuntimeState, count: number): void;
export declare function resetActiveTelegramToolExecutions(state: TelegramBridgeRuntimeState): void;
export declare function hasTelegramDispatchPending(state: TelegramBridgeRuntimeState): boolean;
export declare function clearTelegramDispatchPending(state: TelegramBridgeRuntimeState): void;
export declare function isTelegramCompactionInProgress(state: TelegramBridgeRuntimeState): boolean;
export declare function setTelegramCompactionInProgress(state: TelegramBridgeRuntimeState, inProgress: boolean): void;
export declare function shouldFoldQueuedPromptsIntoHistory(state: TelegramBridgeRuntimeState): boolean;
export declare function setFoldQueuedPromptsIntoHistory(state: TelegramBridgeRuntimeState, fold: boolean): void;
export declare function isTelegramSetupInProgress(state: TelegramBridgeRuntimeState): boolean;
export declare function startTelegramSetup(state: TelegramBridgeRuntimeState): boolean;
export declare function finishTelegramSetup(state: TelegramBridgeRuntimeState): void;
export declare function hasTelegramAbortHandler(state: TelegramBridgeRuntimeState): boolean;
export declare function setTelegramAbortHandler(state: TelegramBridgeRuntimeState, abortHandler: () => void): void;
export declare function clearTelegramAbortHandler(state: TelegramBridgeRuntimeState): void;
export declare function getTelegramAbortHandler(state: TelegramBridgeRuntimeState): (() => void) | undefined;
export declare function abortTelegramTurn(state: TelegramBridgeRuntimeState): boolean;
export interface TelegramTypingLoopTarget {
    chatId: number;
    threadId?: number;
}
export interface TelegramTypingLoopDeps {
    chatId: number | undefined;
    target?: TelegramTypingLoopTarget;
    intervalMs: number;
    sendTypingAction: (chatId: number, options?: {
        message_thread_id?: number;
    }) => Promise<unknown>;
    shouldContinue?: () => boolean;
    onStopped?: () => void;
}
export interface TelegramRuntimeEventRecorderPort {
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface TelegramTypingLoopStarterDeps<TContext> extends TelegramRuntimeEventRecorderPort {
    typing: TelegramRuntimeTypingPort;
    getDefaultChatId: () => number | undefined;
    sendTypingAction: (chatId: number, options?: {
        message_thread_id?: number;
    }) => Promise<unknown>;
    updateStatus: (ctx: TContext, error?: string) => void;
    isContextActive?: (ctx: TContext) => boolean;
    isTransportAvailable?: () => boolean;
    getTransportAuthority?: () => string | number | undefined;
    intervalMs?: number;
}
export declare function createTelegramTypingLoopStarter<TContext>(deps: TelegramTypingLoopStarterDeps<TContext>): (ctx: TContext, chatId?: number, options?: {
    target?: TelegramTypingLoopTarget;
}) => boolean;
export declare function startTelegramTypingLoop(state: TelegramBridgeRuntimeState, deps: TelegramTypingLoopDeps): boolean;
export declare function stopTelegramTypingLoop(state: TelegramBridgeRuntimeState): boolean;
export declare function waitForTelegramTypingLoopIdle(state: TelegramBridgeRuntimeState, timeoutMs?: number): Promise<void>;
export declare function createTelegramContextAbortHandlerSetter<TContext extends {
    abort: () => void;
}>(abort: Pick<TelegramRuntimeAbortPort, "setHandler">): (ctx: TContext) => void;
export interface TelegramAgentEndResetDeps {
    abort: Pick<TelegramRuntimeAbortPort, "clearHandler">;
    typing: Pick<TelegramRuntimeTypingPort, "stop">;
    clearActiveTurn: () => void;
    resetToolExecutions: () => void;
    clearPendingModelSwitch: () => void;
    clearDispatchPending: () => void;
}
export declare function createTelegramAgentEndResetter(deps: TelegramAgentEndResetDeps): () => void;
export interface TelegramPromptDispatchLifecycleDeps<TContext> extends TelegramRuntimeEventRecorderPort {
    lifecycle: Pick<TelegramRuntimeLifecyclePort, "setDispatchPending" | "clearDispatchPending">;
    typing: Pick<TelegramRuntimeTypingPort, "stop">;
    startTypingLoop: (ctx: TContext, chatId?: number, options?: {
        target?: TelegramTypingLoopTarget;
    }) => boolean | void;
    updateStatus: (ctx: TContext, error?: string) => void;
}
export interface TelegramPromptDispatchRuntimeDeps<TContext> extends TelegramRuntimeEventRecorderPort {
    lifecycle: TelegramPromptDispatchLifecycleDeps<TContext>["lifecycle"];
    typing: TelegramRuntimeTypingPort;
    getDefaultChatId: () => number | undefined;
    sendTypingAction: (chatId: number, options?: {
        message_thread_id?: number;
    }) => Promise<unknown>;
    updateStatus: (ctx: TContext, error?: string) => void;
    isContextActive?: (ctx: TContext) => boolean;
    isTransportAvailable?: () => boolean;
    getTransportAuthority?: () => string | number | undefined;
    intervalMs?: number;
}
export interface TelegramPromptDispatchRuntime<TContext> {
    startTypingLoop: (ctx: TContext, chatId?: number, options?: {
        target?: TelegramTypingLoopTarget;
    }) => boolean | void;
    onPromptDispatchStart: (ctx: TContext, chatId?: number) => void;
    onPromptDispatchFailure: (ctx: TContext, message: string) => void;
}
export declare function createTelegramPromptDispatchRuntime<TContext>(deps: TelegramPromptDispatchRuntimeDeps<TContext>): TelegramPromptDispatchRuntime<TContext>;
export declare function createTelegramPromptDispatchLifecycle<TContext>(deps: TelegramPromptDispatchLifecycleDeps<TContext>): {
    onPromptDispatchStart: (ctx: TContext, chatId?: number) => void;
    onPromptDispatchFailure: (ctx: TContext, message: string) => void;
};
