/**
 * Telegram session lifecycle coordination and hook registration
 * Zones: pi agent lifecycle, telegram session
 * Owns context generations, bounded connect intent across resume, and session sequencing.
 * Transport authority, durable bindings, and queue custody remain with their owners.
 */
import * as BusFollower from "./bus-follower.ts";
import type { AgentEndEvent, AgentSettledEvent, AgentStartEvent, AssistantMessageEvent, BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionAPI, ExtensionContext, InputEvent, MessageEndEvent, SessionBeforeCompactEvent, SessionCompactEvent, SessionCompactFailedEvent, SessionShutdownEvent, SessionStartEvent, ToolExecutionEndEvent, ToolExecutionStartEvent, ToolExecutionUpdateEvent, TurnEndEvent, TurnEndEventResult, UIPromptEndEvent, UIPromptStartEvent } from "./pi.ts";
import * as Machine from "./machine.ts";
import * as Queue from "./queue.ts";
export declare function createAgentStartDedupHook(inner: (event: AgentStartEvent, ctx: ExtensionContext) => Promise<void>, resetReplyDedup: () => void, schedulePublication?: (task: () => Promise<void>) => void): (event: AgentStartEvent, ctx: ExtensionContext) => Promise<void>;
type TelegramBeforeAgentStartEvent = Omit<BeforeAgentStartEvent, "systemPrompt"> & {
    systemPrompt: string | string[];
};
export interface TelegramBeforeAgentStartResult {
    systemPrompt?: string | string[];
    message?: BeforeAgentStartEventResult["message"];
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
    onTurnEnd?: (event: TurnEndEvent, ctx: ExtensionContext) => TurnEndEventResult | undefined;
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
export interface TelegramConnectionIntent {
    id: string;
    cwd: string;
    profileName?: string;
}
interface TelegramConnectionHandoff extends TelegramConnectionIntent {
    pid: number;
    targetSessionFile: string;
    expiresAtMs: number;
}
export interface TelegramConnectionHandoffStore {
    pending?: TelegramConnectionHandoff;
}
export interface TelegramConnectionLifecycle {
    prepare(event: SessionStartEvent, ctx: ExtensionContext): (() => void) | undefined;
    onSessionShutdown(event: SessionShutdownEvent, ctx: ExtensionContext): void;
}
export declare function createTelegramConnectionLifecycle(deps: {
    intent: ReturnType<typeof createTelegramConnectionIntentRuntime>;
    getGeneration(): number;
    isCurrent(ctx: ExtensionContext): boolean;
    getProfileName(): string | undefined;
    isConnected(): boolean;
    activateProfile(profileName: string | undefined, isCurrent: () => boolean): Promise<boolean>;
    start(ctx: ExtensionContext): Promise<{
        ok: boolean;
        message?: string;
    }>;
    recordError(error: unknown): void;
}): TelegramConnectionLifecycle;
export declare function createTelegramConnectionIntentRuntime(options?: {
    store?: TelegramConnectionHandoffStore;
    now?: () => number;
    pid?: number;
}): {
    begin(cwd: string, profileName?: string): string;
    isActive(id: string): boolean;
    finish(id: string): void;
    cancel(): void;
    suspend(input: {
        reason: string;
        cwd: string;
        targetSessionFile?: string;
        connected: boolean;
        profileName?: string;
    }): void;
    resume(input: {
        reason: string;
        cwd: string;
        sessionFile?: string;
    }): TelegramConnectionIntent | undefined;
};
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
/** Artifact disclosure stays bound to the captured session generation and ID, even with reused managers. */
export declare function createTelegramArtifactSessionCapture<TContext>(deps: {
    context: Pick<TelegramSessionContextStore<TContext>, "get" | "getGeneration" | "isCurrent">;
    getSessionId(ctx: TContext | undefined): string | undefined;
}): () => (() => boolean) | undefined;
/** Capture drain hints at work admission; late completion never borrows a replacement session or transport. */
export declare function createTelegramSessionDrainObserver<TContext, TAuthority>(deps: {
    context: Pick<TelegramSessionContextStore<TContext>, "get" | "getGeneration" | "isCurrent">;
    captureAuthority: () => TAuthority | undefined;
    isAuthorityActive: (authority: TAuthority) => boolean;
    onDrained: (ctx: TContext) => void;
}): () => (() => void) | undefined;
export declare function createTelegramSessionGenerationFence(store: TelegramSessionContextStore<ExtensionContext>, hooks: TelegramSessionLifecycleHooks): TelegramSessionLifecycleHooks;
export interface TelegramBridgeSessionServiceRuntime {
    connection?: TelegramConnectionLifecycle;
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
        connection?: TelegramBridgeSessionServiceRuntime["connection"];
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
/** The whole compaction-observer state; only `transitionTelegramCompactionObserver` produces a new one. */
export interface TelegramCompactionObserverState {
    /** The fallback timer's observation; a timer from any other one is inert. */
    readonly observation: number | null;
    /** The typing loop is the observer's to stop; a loop the agent already ran is never stopped by compaction. */
    readonly typingOwned: boolean;
    readonly nextObservation: number;
}
export type TelegramCompactionObserverEvent = {
    type: "beforeCompact";
}
/** The outcome of the observer's own typing start, reported back by the shell. */
 | {
    type: "typingStarted";
    started: boolean;
} | {
    type: "compacted";
} | {
    type: "compactFailed";
} | {
    type: "timerFired";
    observation: number;
    contextActive: boolean;
} | {
    type: "shutdown";
};
export type TelegramCompactionObserverEffect = {
    type: "setInProgress";
    inProgress: boolean;
} | {
    type: "startTyping";
} | {
    type: "stopTyping";
} | {
    type: "updateStatus";
} | {
    type: "armTimer";
    observation: number;
} | {
    type: "cancelTimer";
} | {
    type: "recordTimeout";
} | {
    type: "abandoned";
} | {
    type: "requestDispatch";
};
export declare function createTelegramCompactionObserverState(): TelegramCompactionObserverState;
/**
 * Pure compaction-observer transition. A completion or failure always releases presence; the timeout releases only its
 * own observation. Typing ownership is sticky: a repeated start while the observer's own loop runs reports `false`
 * from the shared loop, and must not hand that loop to nobody.
 */
export declare function transitionTelegramCompactionObserver(state: TelegramCompactionObserverState, event: TelegramCompactionObserverEvent): Machine.TelegramMachineStep<TelegramCompactionObserverState, TelegramCompactionObserverEffect>;
/**
 * The shell around `transitionTelegramCompactionObserver`: it fences inactive contexts, runs effects with the calling
 * context, reports the typing start back and owns the fallback timer, which keeps the context it was armed under.
 */
export declare function createTelegramCompactionObserverRuntime<TContext>(deps: TelegramCompactionObserverRuntimeDeps<TContext>): TelegramCompactionObserverRuntime<TContext>;
export interface TelegramMessageActivityTypingDeps<TContext> {
    hasActiveTurn: () => boolean;
    isContextActive?: (ctx: TContext) => boolean;
    getSessionGeneration?: () => number;
    startTypingLoop: (ctx: TContext) => void;
    onMessageStart: TelegramLifecycleRegistrationDeps["onMessageStart"];
    onMessageUpdate: TelegramLifecycleRegistrationDeps["onMessageUpdate"];
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export declare function createTelegramMessageActivityTypingHooks<TContext extends ExtensionContext>(deps: TelegramMessageActivityTypingDeps<TContext>): Pick<TelegramLifecycleRegistrationDeps, "onMessageStart" | "onMessageUpdate">;
export interface TelegramExtraLifecycleHooks {
    onSessionStart?: (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;
    onSessionShutdown?: (event: SessionShutdownEvent, ctx: ExtensionContext) => Promise<void>;
}
export declare function appendTelegramLifecycleHooks(base: TelegramSessionLifecycleHooks, extra: TelegramExtraLifecycleHooks, isSessionActive?: (ctx: ExtensionContext) => boolean): TelegramSessionLifecycleHooks;
export declare function registerTelegramLifecycleHooks(pi: ExtensionAPI, deps: TelegramLifecycleRegistrationDeps): void;
export {};
