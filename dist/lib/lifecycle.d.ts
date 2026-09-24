/**
 * Telegram lifecycle hook registration helpers
 * Zones: pi agent lifecycle, telegram session
 * Binds prepared Telegram lifecycle runtimes to pi extension lifecycle events
 */
import * as BusFollower from "./bus-follower.ts";
import * as Queue from "./queue.ts";
import type { AgentEndEvent, AgentSettledEvent, AgentStartEvent, AssistantMessageEvent, BeforeAgentStartEvent, ExtensionAPI, ExtensionContext, InputEvent, MessageEndEvent, SessionBeforeCompactEvent, SessionCompactEvent, SessionCompactFailedEvent, SessionShutdownEvent, SessionStartEvent, ToolExecutionEndEvent, ToolExecutionStartEvent, ToolExecutionUpdateEvent, UIPromptEndEvent, UIPromptStartEvent } from "./pi.ts";
export declare function setResetTransportReplyDedup(fn: () => void): void;
export declare function createAgentStartDedupHook(inner: (event: AgentStartEvent, ctx: ExtensionContext) => Promise<void>, schedulePublication?: (task: () => Promise<void>) => void): (event: AgentStartEvent, ctx: ExtensionContext) => Promise<void>;
type TelegramBeforeAgentStartEvent = Omit<BeforeAgentStartEvent, "systemPrompt"> & {
    systemPrompt: string | string[];
};
export interface TelegramBeforeAgentStartResult {
    systemPrompt?: string | string[];
}
type TelegramBeforeAgentStartReturn = Promise<TelegramBeforeAgentStartResult | undefined> | TelegramBeforeAgentStartResult | undefined;
type TelegramLifecycleModel = ExtensionContext["model"];
type TelegramLifecycleMessage = AgentEndEvent["messages"][number];
export interface TelegramLifecycleRegistrationDeps {
    isSessionActive?: (ctx: ExtensionContext) => boolean;
    onInput?: (event: InputEvent, ctx: ExtensionContext) => Promise<void> | void;
    onSessionStart: (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;
    onSessionShutdown: (event: SessionShutdownEvent, ctx: ExtensionContext) => Promise<void>;
    onSessionBeforeCompact?: (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => Promise<void> | void;
    onSessionCompact?: (event: SessionCompactEvent, ctx: ExtensionContext) => Promise<void> | void;
    onSessionCompactFailed?: (event: SessionCompactFailedEvent, ctx: ExtensionContext) => Promise<void> | void;
    onBeforeAgentStart: (event: TelegramBeforeAgentStartEvent, ctx: ExtensionContext) => TelegramBeforeAgentStartReturn;
    onModelSelect: (event: {
        model: TelegramLifecycleModel;
    }, ctx: ExtensionContext) => Promise<void> | void;
    onAgentStart: (event: AgentStartEvent, ctx: ExtensionContext) => Promise<void>;
    onToolExecutionStart: (event: ToolExecutionStartEvent, ctx: ExtensionContext) => Promise<void> | void;
    onToolExecutionUpdate?: (event: ToolExecutionUpdateEvent, ctx: ExtensionContext) => Promise<void> | void;
    onToolExecutionEnd: (event: ToolExecutionEndEvent, ctx: ExtensionContext) => Promise<void> | void;
    onMessageStart: (event: {
        message: TelegramLifecycleMessage;
    }, ctx: ExtensionContext) => Promise<void>;
    onMessageUpdate: (event: {
        message: TelegramLifecycleMessage;
        assistantMessageEvent?: AssistantMessageEvent;
    }, ctx: ExtensionContext) => Promise<void>;
    onMessageEnd?: (event: MessageEndEvent, ctx: ExtensionContext) => Promise<void> | void;
    onUiPromptStart?: (event: UIPromptStartEvent, ctx: ExtensionContext) => Promise<void> | void;
    onUiPromptEnd?: (event: UIPromptEndEvent, ctx: ExtensionContext) => Promise<void> | void;
    onAgentEnd: (event: AgentEndEvent, ctx: ExtensionContext) => Promise<void>;
    onAgentSettled?: (event: AgentSettledEvent, ctx: ExtensionContext) => Promise<void> | void;
}
export interface TelegramSessionLifecycleHooks {
    onSessionStart: (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;
    onSessionShutdown: (event: SessionShutdownEvent, ctx: ExtensionContext) => Promise<void>;
}
export interface TelegramSessionContextStore<TContext> {
    get: () => TContext | undefined;
    getGeneration: () => number;
    isCurrent: (ctx: TContext, generation?: number) => boolean;
    set: (ctx: TContext) => number;
    clear: (ctx?: TContext) => boolean;
}
export declare function createTelegramSessionContextStore<TContext>(options?: {
    getIdentity?: (ctx: TContext) => unknown;
}): TelegramSessionContextStore<TContext>;
export declare function createTelegramSessionGenerationFence(store: TelegramSessionContextStore<ExtensionContext>, hooks: TelegramSessionLifecycleHooks): TelegramSessionLifecycleHooks;
export interface TelegramBridgeSessionServiceRuntime {
    resumeGroupedInput(ctx: ExtensionContext): void;
    suspendGroupedInput(): void;
    delivery: {
        onSessionStart(): Promise<void>;
        onSessionShutdown(): Promise<void>;
    };
    polling: {
        onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void>;
    };
    inboundWorker: {
        onSessionShutdown(): Promise<void>;
    };
    capabilityMonitor: {
        start(ctx: ExtensionContext): void;
        stop(): void;
    };
    queueWatchdog: {
        start(ctx: ExtensionContext): void;
        stop(): void;
    };
    guestPlaceholder?: {
        stopAll(): void;
    };
    prepareThreadPreservationOnQuit?: (isSessionCurrent: () => boolean) => (() => Promise<void>) | undefined;
}
export interface TelegramBridgeSessionLifecycleAssemblyDeps<TQueueItem, TModel = unknown> {
    contextStore: TelegramSessionContextStore<ExtensionContext>;
    queue: Omit<Queue.TelegramSessionLifecycleRuntimeDeps<ExtensionContext, TQueueItem, TModel>, "isSessionActive" | "stopPolling" | "clearPendingMediaGroups">;
    follower: Omit<BusFollower.TelegramBusFollowerSessionRefreshHookDeps<ExtensionContext>, "isSessionActive"> & BusFollower.TelegramBusFollowerSessionReplacementSuspenderDeps;
    services: TelegramBridgeSessionServiceRuntime;
}
export interface TelegramBridgeSessionLifecyclePorts<TQueueItem, TModel = unknown> {
    contextStore: TelegramSessionContextStore<ExtensionContext>;
    queue: Omit<Queue.TelegramSessionLifecycleRuntimeDeps<ExtensionContext, TQueueItem, TModel>, "isSessionActive" | "stopPolling" | "clearPendingMediaGroups">;
    follower: Omit<BusFollower.TelegramBusFollowerSessionRefreshHookDeps<ExtensionContext>, "isSessionActive"> & BusFollower.TelegramBusFollowerSessionReplacementSuspenderDeps;
    services: {
        mediaGroup: {
            resume(ctx: ExtensionContext): void;
            suspend(): void;
        };
        textGroup: {
            resume(ctx: ExtensionContext): void;
            suspend(): void;
        };
        delivery: TelegramBridgeSessionServiceRuntime["delivery"];
        polling: TelegramBridgeSessionServiceRuntime["polling"];
        inboundWorker: TelegramBridgeSessionServiceRuntime["inboundWorker"];
        capabilityMonitor: TelegramBridgeSessionServiceRuntime["capabilityMonitor"];
        queueWatchdog: TelegramBridgeSessionServiceRuntime["queueWatchdog"];
        guestPlaceholder?: TelegramBridgeSessionServiceRuntime["guestPlaceholder"];
        prepareThreadPreservationOnQuit?: TelegramBridgeSessionServiceRuntime["prepareThreadPreservationOnQuit"];
    };
}
export declare function createTelegramBridgeSessionLifecycleDeps<TQueueItem, TModel = unknown>(ports: TelegramBridgeSessionLifecyclePorts<TQueueItem, TModel>): TelegramBridgeSessionLifecycleAssemblyDeps<TQueueItem, TModel>;
export declare function createTelegramBridgeSessionLifecycleAssembly<TQueueItem, TModel = unknown>(deps: TelegramBridgeSessionLifecycleAssemblyDeps<TQueueItem, TModel>): TelegramSessionLifecycleHooks;
type TelegramLifecycleTimer = number | ReturnType<typeof setTimeout>;
export interface TelegramCompactionObserverRuntimeDeps<TContext> {
    isContextActive?: (ctx: TContext) => boolean;
    setCompactionInProgress: (inProgress: boolean) => void;
    updateStatus: (ctx: TContext) => void;
    startTypingLoop?: (ctx: TContext) => boolean | void;
    stopTypingLoop?: () => void;
    requestDeferredDispatchNextQueuedTelegramTurn: (dispatch: (ctx: TContext) => void) => void;
    dispatchNextQueuedTelegramTurn: (ctx: TContext) => void;
    recordRuntimeEvent?: (category: string, error: unknown) => void;
    onCompactionAbandoned?: () => void;
    timeoutMs?: number;
    setTimer?: (callback: () => void, ms: number) => TelegramLifecycleTimer;
    clearTimer?: (timer: TelegramLifecycleTimer) => void;
}
export interface TelegramCompactionObserverRuntime<TContext> {
    onSessionBeforeCompact: (event: SessionBeforeCompactEvent, ctx: TContext) => void;
    onSessionCompact: (event: SessionCompactEvent, ctx: TContext) => void;
    onSessionCompactFailed: (event: SessionCompactFailedEvent, ctx: TContext) => void;
    onSessionShutdown: () => void;
}
export declare function createTelegramCompactionObserverRuntime<TContext>(deps: TelegramCompactionObserverRuntimeDeps<TContext>): TelegramCompactionObserverRuntime<TContext>;
export interface TelegramMessageActivityTypingDeps<TContext> {
    hasActiveTurn: () => boolean;
    startTypingLoop: (ctx: TContext) => void;
    onMessageStart: TelegramLifecycleRegistrationDeps["onMessageStart"];
    onMessageUpdate: TelegramLifecycleRegistrationDeps["onMessageUpdate"];
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export declare function createTelegramMessageActivityTypingHooks<TContext extends ExtensionContext>(deps: TelegramMessageActivityTypingDeps<TContext>): Pick<TelegramLifecycleRegistrationDeps, "onMessageStart" | "onMessageUpdate">;
export declare function createDedupAgentStartHook(dedup: {
    reset(): void;
}, inner: (event: AgentStartEvent, ctx: ExtensionContext) => Promise<void>): (event: AgentStartEvent, ctx: ExtensionContext) => Promise<void>;
export interface TelegramExtraLifecycleHooks {
    onSessionStart?: (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;
    onSessionShutdown?: (event: SessionShutdownEvent, ctx: ExtensionContext) => Promise<void>;
}
export declare function appendTelegramLifecycleHooks(base: TelegramSessionLifecycleHooks, extra: TelegramExtraLifecycleHooks, isSessionActive?: (ctx: ExtensionContext) => boolean): TelegramSessionLifecycleHooks;
export declare function registerTelegramLifecycleHooks(pi: ExtensionAPI, deps: TelegramLifecycleRegistrationDeps): void;
export {};
