/**
 * Telegram target-aware operational delivery and logical message lifecycle
 * Zones: telegram delivery, extension API, runtime binding
 * Owns the public extension delivery contract, authorized scope resolution, operational rendering adapter, per-target serialization, chunk reconciliation, generation-fenced logical handles, and process-local runtime membrane; composes the established reply renderer with bus-aware Telegram API ports and excludes bot clients, Pi contexts, and consumer-extension policy
 */
import { type TelegramInlineKeyboardMarkup } from "./keyboard.ts";
import { type TelegramTarget } from "./target.ts";
import { type TelegramBridgeApiRuntime } from "./telegram-api.ts";
export type TelegramDeliveryParseMode = "plain" | "html" | "markdown";
export interface TelegramDeliveryView {
    text: string;
    parseMode?: TelegramDeliveryParseMode;
    replyMarkup?: TelegramInlineKeyboardMarkup;
}
export type TelegramDeliveryTarget = TelegramTarget;
export type TelegramDeliveryScope = {
    kind: "active-turn";
} | {
    kind: "instance";
} | {
    kind: "aggregate";
} | {
    kind: "target";
    target: TelegramDeliveryTarget;
};
export interface TelegramDeliveryHandle {
    readonly target: TelegramDeliveryTarget;
    readonly messageIds: readonly number[];
    readonly generation: string;
}
export type TelegramDeliveryFailureReason = "runtime-unavailable" | "target-unavailable" | "target-unauthorized" | "stale-handle" | "invalid-view" | "commit-unknown" | "message-unavailable" | "rate-limited" | "transport-retryable" | "transport-failed";
export type TelegramDeliveryResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    reason: TelegramDeliveryFailureReason;
    message: string;
    /** Exact Telegram flood-control delay when supplied by the API. */
    retryAfterMs?: number;
    /** Successfully materialized state that callers may edit or delete to recover. */
    partial?: T;
};
export interface SendTelegramViewOptions {
    scope: TelegramDeliveryScope;
    replyToMessageId?: number;
}
export type TelegramDeliveryChatAction = "typing" | "upload_document" | "upload_photo" | "record_voice";
/** @internal */
export interface TelegramDeliveryRuntime {
    readonly generation: string;
    shutdown: () => void;
    sendView: (view: TelegramDeliveryView, options: SendTelegramViewOptions) => Promise<TelegramDeliveryResult<TelegramDeliveryHandle>>;
    editView: (handle: TelegramDeliveryHandle, view: TelegramDeliveryView) => Promise<TelegramDeliveryResult<TelegramDeliveryHandle>>;
    deleteView: (handle: TelegramDeliveryHandle) => Promise<TelegramDeliveryResult<void>>;
    sendChatAction: (action: TelegramDeliveryChatAction, scope: TelegramDeliveryScope) => Promise<TelegramDeliveryResult<void>>;
}
/** @internal */
export interface TelegramDeliveryTargetResolverDeps {
    getActiveTurnTarget: () => TelegramDeliveryTarget | undefined;
    getInstanceTarget: () => TelegramDeliveryTarget | undefined;
    getAggregateTarget: () => TelegramDeliveryTarget | undefined;
    isExplicitTargetAuthorized: (target: TelegramDeliveryTarget) => boolean;
}
/** @internal */
export interface TelegramDeliveryRenderedChunk {
    text: string;
    parseMode: TelegramDeliveryParseMode;
}
/** @internal */
export interface TelegramDeliveryTransportOptions {
    replyToMessageId?: number;
    replyMarkup?: TelegramInlineKeyboardMarkup | null;
}
/** @internal */
export interface TelegramDeliveryRuntimeDeps extends TelegramDeliveryTargetResolverDeps {
    generation: string;
    renderView: (view: TelegramDeliveryView) => readonly TelegramDeliveryRenderedChunk[];
    sendChunk: (target: TelegramDeliveryTarget, chunk: TelegramDeliveryRenderedChunk, options: TelegramDeliveryTransportOptions) => Promise<number>;
    editChunk: (target: TelegramDeliveryTarget, messageId: number, chunk: TelegramDeliveryRenderedChunk, options: TelegramDeliveryTransportOptions) => Promise<void>;
    deleteMessage: (target: TelegramDeliveryTarget, messageId: number) => Promise<void>;
    sendChatAction: (target: TelegramDeliveryTarget, action: TelegramDeliveryChatAction) => Promise<void>;
    recordFailure?: (operation: "send" | "edit" | "delete" | "chat-action", error: unknown, target?: TelegramDeliveryTarget) => void;
}
/** @internal */
export interface TelegramBridgeDeliveryRuntimeDeps {
    generation: string;
    getTargetPolicyView: () => TelegramDeliveryTargetPolicyView;
    getActiveTurnTarget: () => TelegramDeliveryTarget | undefined;
    isTransportActive?: () => boolean;
    api: Pick<TelegramBridgeApiRuntime, "sendMessage" | "editMessageText" | "deleteMessage" | "sendChatAction">;
    recordOwnership: (input: {
        chatId: number;
        messageId: number;
        target: TelegramDeliveryTarget;
    }) => void;
    recordFailure?: TelegramDeliveryRuntimeDeps["recordFailure"];
}
/** @internal */
export declare function createTelegramDeliveryLifecycleHooks(createRuntime: () => TelegramDeliveryRuntime): {
    onSessionStart: () => Promise<void>;
    onSessionShutdown: () => Promise<void>;
};
export declare function createTelegramDeliveryGenerationSeed(instanceId: string): string;
/** @internal */
export declare function createTelegramBridgeDeliveryLifecycleHooks<TTransportStamp>(deps: Omit<TelegramBridgeDeliveryRuntimeDeps, "generation" | "isTransportActive"> & {
    generationSeed: string;
    getTransportStamp?: () => TTransportStamp;
    isTransportStampActive?: (stamp: TTransportStamp) => boolean;
}): ReturnType<typeof createTelegramDeliveryLifecycleHooks>;
export declare function classifyTelegramDeliveryTransportError(error: unknown): {
    reason: Extract<TelegramDeliveryFailureReason, "commit-unknown" | "message-unavailable" | "rate-limited" | "transport-retryable" | "transport-failed">;
    retryAfterMs?: number;
};
/** @internal */
export interface TelegramDeliveryTargetPolicyView {
    canDeliver: boolean;
    ownsDirect: boolean;
    allowedChatId?: number;
    followerTarget?: TelegramDeliveryTarget;
    leaderTarget?: TelegramDeliveryTarget;
    liveTargets?: readonly TelegramDeliveryTarget[];
}
/** @internal */
export interface TelegramDeliveryTargetPolicyRuntime {
    getTargetPolicyView(): TelegramDeliveryTargetPolicyView;
    getActiveTurnTarget(): TelegramDeliveryTarget | undefined;
}
/** @internal */
export declare function createTelegramDeliveryTargetPolicyRuntime(deps: {
    ownsDirect(): boolean;
    isFollowerRegistered(): boolean;
    getAllowedChatId(): number | undefined;
    getFollowerTarget(): TelegramDeliveryTarget | undefined;
    getLeaderTarget(): TelegramDeliveryTarget | undefined;
    listThreadRecords(): readonly {
        target: TelegramDeliveryTarget;
    }[];
    getActiveTurnTarget(): TelegramDeliveryTarget | undefined;
    getActiveGuestQueryId(): string | undefined;
}): TelegramDeliveryTargetPolicyRuntime;
/** @internal */
export declare function resolveTelegramDeliveryInstanceTarget(view: TelegramDeliveryTargetPolicyView): TelegramDeliveryTarget | undefined;
/** @internal */
export declare function resolveTelegramDeliveryAggregateTarget(view: TelegramDeliveryTargetPolicyView): TelegramDeliveryTarget | undefined;
/** @internal */
export declare function isTelegramDeliveryExplicitTargetAuthorized(candidate: TelegramDeliveryTarget, view: TelegramDeliveryTargetPolicyView): boolean;
/** @internal */
export declare function createTelegramDeliveryRuntime(deps: TelegramDeliveryRuntimeDeps): TelegramDeliveryRuntime;
/** @internal */
export declare function createTelegramBridgeDeliveryRuntime(deps: TelegramBridgeDeliveryRuntimeDeps): TelegramDeliveryRuntime;
/** @internal */
export declare function bindTelegramDeliveryRuntime(runtime: TelegramDeliveryRuntime): () => void;
/** @internal */
export declare function clearTelegramDeliveryRuntime(): void;
/** @internal */
export declare function isTelegramDeliveryHandleCurrent(handle: TelegramDeliveryHandle): boolean;
export declare function sendTelegramView(view: TelegramDeliveryView, options: SendTelegramViewOptions): Promise<TelegramDeliveryResult<TelegramDeliveryHandle>>;
/** @internal Edit an exact Telegram message through the currently bound runtime generation. */
export declare function editTelegramTargetView(target: TelegramDeliveryTarget, messageId: number, view: TelegramDeliveryView): Promise<TelegramDeliveryResult<TelegramDeliveryHandle>>;
export declare function editTelegramView(handle: TelegramDeliveryHandle, view: TelegramDeliveryView): Promise<TelegramDeliveryResult<TelegramDeliveryHandle>>;
export declare function deleteTelegramView(handle: TelegramDeliveryHandle): Promise<TelegramDeliveryResult<void>>;
export declare function sendTelegramChatAction(action: TelegramDeliveryChatAction, options: {
    scope: TelegramDeliveryScope;
}): Promise<TelegramDeliveryResult<void>>;
