/**
 * Telegram activity lifecycle normalization and extension dispatch
 * Zones: pi agent lifecycle, extension API, operational delivery
 * Owns stable handler registration, evidence-based activity/source identity, assistant segment and reasoning normalization, ordered public-output projection, executed-tool and compaction events, isolated non-blocking queues, shutdown fencing, diagnostics, and fresh delivery contexts; excludes Pi hook wiring, Telegram rendering implementation, raw transport clients, and consumer-extension behavior
 */
import { type TelegramDeliveryChatAction, type TelegramDeliveryHandle, type TelegramDeliveryResult, type TelegramDeliveryScope, type TelegramDeliveryTarget, type TelegramDeliveryView } from "./delivery.ts";
export type TelegramActivitySource = "telegram" | "local" | "autonomous" | "unknown";
export type TelegramActivityTarget = Readonly<TelegramDeliveryTarget>;
export interface TelegramActivityEnvelope {
    activityId: string;
    sequence: number;
    source: TelegramActivitySource;
    target?: TelegramActivityTarget;
    replyToMessageId?: number;
    timestamp: number;
}
export type TelegramActivityPayload = {
    type: "agent-start";
} | {
    type: "assistant-text-delta";
    contentIndex: number;
    delta: string;
} | {
    type: "assistant-segment";
    contentIndex: number;
    text: string;
    placement: "intermediate" | "final" | "terminal-partial";
} | {
    type: "reasoning-delta";
    contentIndex: number;
    delta: string;
} | {
    type: "reasoning-end";
    contentIndex: number;
    text: string;
} | {
    type: "tool-start";
    toolCallId: string;
    toolName: string;
    args: unknown;
} | {
    type: "tool-update";
    toolCallId: string;
    toolName: string;
    update: unknown;
} | {
    type: "tool-end";
    toolCallId: string;
    toolName: string;
    result: unknown;
    isError: boolean;
} | {
    type: "compaction-start";
    reason: "manual" | "threshold" | "overflow" | "unknown";
} | {
    type: "compaction-end";
    reason: "manual" | "threshold" | "overflow" | "unknown";
} | {
    type: "ui-prompt-start";
    kind: "select" | "confirm" | "input" | "editor" | "custom";
    title?: string;
} | {
    type: "ui-prompt-end";
} | {
    type: "agent-end";
} | {
    type: "agent-settled";
};
export type TelegramActivityEvent = TelegramActivityEnvelope & TelegramActivityPayload;
export type TelegramAssistantSegmentEvent = TelegramActivityEnvelope & Extract<TelegramActivityPayload, {
    type: "assistant-segment";
}>;
export interface TelegramActivityContext {
    activityId: string;
    sequence: number;
    source: TelegramActivitySource;
    defaultScope: TelegramDeliveryScope;
    send: (view: TelegramDeliveryView, options?: {
        scope?: TelegramDeliveryScope;
        replyToMessageId?: number;
    }) => Promise<TelegramDeliveryResult<TelegramDeliveryHandle>>;
    edit: (handle: TelegramDeliveryHandle, view: TelegramDeliveryView) => Promise<TelegramDeliveryResult<TelegramDeliveryHandle>>;
    delete: (handle: TelegramDeliveryHandle) => Promise<TelegramDeliveryResult<void>>;
    chatAction: (action: TelegramDeliveryChatAction, options?: {
        scope?: TelegramDeliveryScope;
    }) => Promise<TelegramDeliveryResult<void>>;
}
export interface TelegramActivityHandlerRegistration {
    id: string;
    order?: number;
    handle: (event: TelegramActivityEvent, ctx: TelegramActivityContext) => void | Promise<void>;
}
export declare function registerTelegramActivityHandler(registration: TelegramActivityHandlerRegistration): () => void;
/** @internal */
export declare function clearTelegramActivityHandlers(): void;
/** @internal */
export interface TelegramActivityDispatcher {
    dispatch: (event: TelegramActivityEvent) => void;
    stop: () => void;
}
/** @internal */
export declare function createTelegramActivityDispatcher(deps?: {
    recordFailure?: (handlerId: string, event: TelegramActivityEvent, error: unknown) => void;
}): TelegramActivityDispatcher;
/** @internal */
export declare function createTelegramActivityBridgeRuntime(deps: {
    generation: string;
    observeEvent?: (event: TelegramActivityEvent) => void;
    recordFailure?: (handlerId: string, event: TelegramActivityEvent, error: unknown) => void;
    now?: () => number;
}): TelegramActivityRuntime;
export type TelegramActivityInputSource = "interactive" | "rpc" | "extension" | "unknown";
export type TelegramAssistantStreamEvent = {
    type: "start";
} | {
    type: "text_start";
    contentIndex: number;
} | {
    type: "text_delta";
    contentIndex: number;
    delta: string;
} | {
    type: "text_end";
    contentIndex: number;
    content: string;
} | {
    type: "thinking_delta";
    contentIndex: number;
    delta: string;
} | {
    type: "thinking_end";
    contentIndex: number;
    content: string;
} | {
    type: "thinking_start";
    contentIndex: number;
} | {
    type: "toolcall_start";
    contentIndex: number;
} | {
    type: "toolcall_delta";
    contentIndex: number;
    delta: string;
} | {
    type: "toolcall_end";
    contentIndex: number;
} | {
    type: "done";
} | {
    type: "error";
};
/** @internal */
export interface TelegramActivityRuntime {
    onSessionStart?: () => void;
    recordInputSource: (source: TelegramActivityInputSource) => void;
    onAgentStart: (activeTelegramTarget?: TelegramActivityTarget, replyToMessageId?: number) => void;
    onAssistantEvent: (event: TelegramAssistantStreamEvent) => void;
    onAssistantMessageEnd: (stopReason?: string) => void;
    onToolStart: (event: {
        toolCallId: string;
        toolName: string;
        args: unknown;
    }) => void;
    onToolUpdate: (event: {
        toolCallId: string;
        toolName: string;
        update: unknown;
    }) => void;
    onToolEnd: (event: {
        toolCallId: string;
        toolName: string;
        result: unknown;
        isError: boolean;
    }) => void;
    onCompactionStart: (reason: "manual" | "threshold" | "overflow" | "unknown") => void;
    onCompactionEnd: (reason: "manual" | "threshold" | "overflow" | "unknown") => void;
    onCompactionAbandoned: () => void;
    onUiPromptStart: (kind: "select" | "confirm" | "input" | "editor" | "custom", title?: string) => void;
    onUiPromptEnd: () => void;
    onAgentEnd: () => void;
    onAgentSettled: () => void;
    onSessionShutdown: () => void;
}
/** @internal */
export declare function createTelegramActivityRuntime(deps: {
    generation: string;
    dispatcher: TelegramActivityDispatcher;
    observeEvent?: (event: TelegramActivityEvent) => void;
    recordObserverFailure?: (event: TelegramActivityEvent, error: unknown) => void;
    now?: () => number;
}): TelegramActivityRuntime;
export interface TelegramActivityPublicationReservation {
    publish: (task: () => Promise<void>) => Promise<void>;
    cancel: () => void;
}
export interface TelegramActivityPublicationRuntime {
    enqueue: (task: () => Promise<void>) => Promise<void>;
    reserve: () => TelegramActivityPublicationReservation;
    reset: () => void;
}
export declare function createTelegramActivityPublicationRuntime(): TelegramActivityPublicationRuntime;
export interface TelegramAssistantOutputRuntime {
    start: () => void;
    beginTurn: () => void;
    accept: (event: TelegramAssistantSegmentEvent) => void;
    hasAdmittedTelegramIntermediate: (text: string) => boolean;
    waitForIdle: () => Promise<void>;
    stop: () => void;
}
export interface TelegramAssistantOutputPreparation {
    wait: () => Promise<void>;
    settle: () => void;
}
export declare function createTelegramAssistantOutputRuntime<TAuthority = undefined>(deps: {
    prepareSend?: (event: TelegramAssistantSegmentEvent) => TelegramAssistantOutputPreparation | undefined;
    enqueue?: TelegramActivityPublicationRuntime["enqueue"];
    captureAuthority?: () => TAuthority;
    isAuthorityActive?: (authority: TAuthority) => boolean;
    canDeliver: (event: TelegramAssistantSegmentEvent) => boolean;
    send: (event: TelegramAssistantSegmentEvent, authority: TAuthority, isAuthorityActive: () => boolean) => Promise<void>;
    recordFailure?: (event: TelegramAssistantSegmentEvent, error: unknown) => void;
}): TelegramAssistantOutputRuntime;
