/**
 * Telegram updates domain helpers
 * Zones: telegram inbound, authorization, routing plans
 * Owns update extraction, authorization, execution planning, generation-fenced journal draining, and the public update-handler registry
 */
import { type TelegramTarget } from "./target.ts";
import type { TelegramBusEnvelope, TelegramBusFollowerView, TelegramBusForwardOwnership, TelegramBusForeignUpdateSettlement, TelegramProcessLiveness } from "./bus.ts";
import type { TelegramMessageOwnershipStore } from "./ownership.ts";
import { TELEGRAM_UPDATE_JOURNAL_VERSION, TELEGRAM_UPDATE_JOURNAL_EXCLUSION_VERSION, TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION, type TelegramInputJournalReceipt, type TelegramInputJournalSourceReference, type TelegramInputJournalStore, type TelegramJournaledUpdate, type TelegramUpdateJournalDeadQueueOwnerRecoveryResult, type TelegramUpdateJournalAppendResult, type TelegramUpdateJournalInputClaim, type TelegramUpdateJournalOperatorDispositionInput, type TelegramUpdateJournalOperatorDispositionResult, type TelegramUpdateJournalQueueDiscardResult, type TelegramUpdateJournalQueueHandoffAcceptResult, type TelegramUpdateJournalQueueHandoffCancelResult, type TelegramUpdateJournalQueueHandoffInput, type TelegramUpdateJournalQueueHandoffOfferResult, type TelegramUpdateJournalQueueOwner, type TelegramUpdateJournalQueueOwnerIdentity } from "./journal.ts";
import { type PendingTelegramControlItem, type TelegramControlQueueHandoffPayload, type TelegramQueueAdmissionReceipt, type TelegramQueueHandoffPayload, type TelegramQueueHandoffStageResult, type TelegramQueueReactionDisposition, type TelegramQueueHandoffStagingRuntime, type TelegramQueueItem } from "./queue.ts";
import { type TelegramAuthorizationState, type TelegramUserPairingRuntimeDeps } from "./config.ts";
export interface TelegramReactionTypeEmoji {
    type: "emoji";
    emoji: string;
}
export interface TelegramReactionTypeNonEmoji {
    type: string;
}
export type TelegramReactionType = TelegramReactionTypeEmoji | TelegramReactionTypeNonEmoji;
export declare const TELEGRAM_PRIORITY_REACTIONS: readonly [{
    readonly id: 10;
    readonly name: "like";
    readonly emoji: "👍";
}, {
    readonly id: 11;
    readonly name: "lightning";
    readonly emoji: "⚡";
}, {
    readonly id: 12;
    readonly name: "heart";
    readonly emoji: "❤";
}, {
    readonly id: 13;
    readonly name: "dove";
    readonly emoji: "🕊";
}, {
    readonly id: 14;
    readonly name: "fire";
    readonly emoji: "🔥";
}];
export declare const TELEGRAM_REMOVAL_REACTIONS: readonly [{
    readonly id: 20;
    readonly name: "dislike";
    readonly emoji: "👎";
}, {
    readonly id: 21;
    readonly name: "ghost";
    readonly emoji: "👻";
}, {
    readonly id: 22;
    readonly name: "broken-heart";
    readonly emoji: "💔";
}, {
    readonly id: 23;
    readonly name: "poop";
    readonly emoji: "💩";
}, {
    readonly id: 24;
    readonly name: "wastebasket";
    readonly emoji: "🗑";
}];
export declare const TELEGRAM_PRIORITY_REACTION_EMOJIS: ("👍" | "⚡" | "❤" | "🕊" | "🔥")[];
export declare const TELEGRAM_REMOVAL_REACTION_EMOJIS: ("👎" | "👻" | "💔" | "💩" | "🗑")[];
export interface TelegramUpdateDeletion {
    deleted_business_messages?: {
        message_ids?: unknown;
    };
}
export declare function normalizeTelegramReactionEmoji(emoji: string): string;
export declare function collectTelegramReactionEmojis(reactions: TelegramReactionType[]): Set<string>;
export declare function getTelegramQueueReactionDisposition(reactions: TelegramReactionType[]): TelegramQueueReactionDisposition;
export declare function extractDeletedTelegramMessageIds(update: TelegramUpdateDeletion): number[];
export interface TelegramUser {
    id: number;
    is_bot: boolean;
}
export interface TelegramChat {
    id?: number;
    type: string;
}
export interface TelegramUpdateMessage {
    chat: TelegramChat;
    from?: TelegramUser;
    message_id?: number;
    message_thread_id?: number;
    pi_telegram_agent_source_thread?: string;
    forum_topic_created?: unknown;
    forum_topic_closed?: unknown;
    forum_topic_reopened?: unknown;
}
export type TelegramTopicLifecycleKind = "created" | "closed" | "reopened";
export interface TelegramTopicLifecycleUpdate<TMessage = TelegramUpdateMessage> {
    kind: TelegramTopicLifecycleKind;
    message: TMessage;
    target: TelegramTarget & {
        threadId: number;
    };
}
export declare function getTelegramTopicLifecycleUpdate<TMessage extends TelegramUpdateMessage>(message: TMessage | undefined): TelegramTopicLifecycleUpdate<TMessage> | undefined;
export interface TelegramCallbackQuery {
    id?: string;
    from: TelegramUser;
    message?: TelegramUpdateMessage;
}
export interface TelegramGuestMessage {
    guest_query_id: string;
    chat: TelegramChat;
    from?: TelegramUser;
    message_id?: number;
    text?: string;
    reply_to_message?: TelegramUpdateMessage;
}
export declare function getTelegramMessageTarget(message: TelegramUpdateMessage): TelegramTarget | undefined;
export interface TelegramUpdateRouting {
    message?: TelegramUpdateMessage;
    edited_message?: TelegramUpdateMessage;
    callback_query?: TelegramCallbackQuery;
    guest_message?: TelegramGuestMessage;
}
export declare function getAuthorizedTelegramCallbackQuery(update: TelegramUpdateRouting, allowedUserId?: number): TelegramCallbackQuery | undefined;
export declare function getAuthorizedTelegramMessage(update: TelegramUpdateRouting, allowedUserId?: number): TelegramUpdateMessage | undefined;
export declare function getAuthorizedTelegramEditedMessage(update: TelegramUpdateRouting, allowedUserId?: number): TelegramUpdateMessage | undefined;
export declare function getAuthorizedTelegramGuestMessage(update: TelegramUpdateRouting): TelegramGuestMessage | undefined;
export type TelegramMessageOwnershipView = TelegramBusForwardOwnership;
export type TelegramMessageOwnershipLookup = (chatId: number, messageId: number) => TelegramMessageOwnershipView | undefined;
export type TelegramTargetOwnershipView = TelegramBusForwardOwnership;
export type TelegramTargetOwnershipLookup = (target: TelegramTarget) => TelegramTargetOwnershipView | undefined;
export interface TelegramForeignOwnedUpdateForwarder<TContext, TReactionUpdate extends TelegramMessageReactionUpdated = TelegramMessageReactionUpdated, TCallbackQuery extends TelegramCallbackQuery = TelegramCallbackQuery, TMessage extends TelegramUpdateMessage = TelegramUpdateMessage> {
    forwardCallback?: (input: {
        query: TCallbackQuery;
        ownership: TelegramMessageOwnershipView;
        ctx: TContext;
    }) => Promise<TelegramBusForeignUpdateSettlement> | TelegramBusForeignUpdateSettlement;
    forwardReaction?: (input: {
        reactionUpdate: TReactionUpdate;
        ownership: TelegramMessageOwnershipView;
        ctx: TContext;
    }) => Promise<TelegramBusForeignUpdateSettlement> | TelegramBusForeignUpdateSettlement;
    forwardMessage?: (input: {
        message: TMessage;
        ownership: TelegramTargetOwnershipView;
        ctx: TContext;
    }) => Promise<TelegramBusForeignUpdateSettlement> | TelegramBusForeignUpdateSettlement;
    forwardEditedMessage?: (input: {
        message: TMessage;
        ownership: TelegramTargetOwnershipView;
        ctx: TContext;
    }) => Promise<TelegramBusForeignUpdateSettlement> | TelegramBusForeignUpdateSettlement;
}
type TelegramForeignUpdateSettlementFailure = Exclude<TelegramBusForeignUpdateSettlement, {
    status: "accepted";
}> | {
    status: "terminal-rejected";
    failureClass: "forwarder-unavailable";
    message: string;
    sourceUpdateId?: number;
};
export declare class TelegramForeignUpdateSettlementError extends Error {
    readonly settlement: TelegramForeignUpdateSettlementFailure;
    constructor(operation: string, settlement: TelegramForeignUpdateSettlementFailure);
}
export interface TelegramMessageReactionUpdated {
    chat: {
        id?: number;
        type: string;
    };
    user?: TelegramUser;
    actor_chat?: unknown;
    message_id: number;
    old_reaction: TelegramReactionType[];
    new_reaction: TelegramReactionType[];
}
export declare const TELEGRAM_INTERNAL_AGENT_MESSAGE: unique symbol;
export interface TelegramUpdateFlow extends TelegramUpdateRouting, TelegramUpdateDeletion {
    message_reaction?: TelegramMessageReactionUpdated;
    [TELEGRAM_INTERNAL_AGENT_MESSAGE]?: true;
}
export type TelegramUpdateAdmissionOutcome = {
    kind: "complete";
} | {
    kind: "deferred";
} | {
    kind: "queued";
    queueKind: "prompt" | "control";
    receiptId: string;
    sourceUpdateIds: readonly number[];
};
interface TelegramUpdateAdmissionBinding {
    sourceUpdateId: number;
    report: (outcome: TelegramUpdateAdmissionOutcome) => void;
}
export type TelegramQueueAdmissionReceiptLike = TelegramQueueAdmissionReceipt;
export declare function bindTelegramUpdateAdmissionSource<TUpdate extends TelegramUpdateFlow & {
    update_id: number;
}>(update: TUpdate, report: TelegramUpdateAdmissionBinding["report"]): TUpdate;
export declare function collectTelegramAdmissionSourceUpdateIds(values: readonly unknown[]): number[];
/** Report source completion; true means reported, not a durable settlement acknowledgement. */
export declare function reportTelegramUpdateCompleted(value: unknown): boolean;
export declare function reportTelegramUpdateDeferred(value: unknown): boolean;
export declare function reportTelegramQueueAdmission(values: readonly unknown[], receipts: readonly TelegramQueueAdmissionReceiptLike[]): boolean;
export type TelegramUpdateFlowAction<TReactionUpdate extends TelegramMessageReactionUpdated = TelegramMessageReactionUpdated, TCallbackQuery extends TelegramCallbackQuery = TelegramCallbackQuery, TMessage extends TelegramUpdateMessage = TelegramUpdateMessage, TGuestMessage extends TelegramGuestMessage = TelegramGuestMessage> = {
    kind: "ignore";
} | {
    kind: "deleted";
    messageIds: number[];
} | {
    kind: "reaction";
    reactionUpdate: TReactionUpdate;
} | {
    kind: "topic-lifecycle";
    lifecycle: TelegramTopicLifecycleUpdate<TMessage>;
} | {
    kind: "callback";
    query: TCallbackQuery;
    authorization: TelegramAuthorizationState;
} | {
    kind: "message";
    message: TMessage & {
        from: TelegramUser;
    };
    authorization: TelegramAuthorizationState;
} | {
    kind: "edited-message";
    message: TMessage & {
        from: TelegramUser;
    };
    authorization: TelegramAuthorizationState;
} | {
    kind: "guest";
    guestMessage: TGuestMessage & {
        from: TelegramUser;
    };
    authorization: TelegramAuthorizationState;
};
export declare function buildTelegramUpdateFlowAction<TUpdate extends TelegramUpdateFlow>(update: TUpdate, allowedUserId?: number): TelegramUpdateFlowAction<NonNullable<TUpdate["message_reaction"]>, NonNullable<TUpdate["callback_query"]>, NonNullable<TUpdate["message"] | TUpdate["edited_message"]>, NonNullable<TUpdate["guest_message"]>>;
export type TelegramUpdateExecutionPlan<TReactionUpdate extends TelegramMessageReactionUpdated = TelegramMessageReactionUpdated, TCallbackQuery extends TelegramCallbackQuery = TelegramCallbackQuery, TMessage extends TelegramUpdateMessage = TelegramUpdateMessage, TGuestMessage extends TelegramGuestMessage = TelegramGuestMessage> = {
    kind: "ignore";
} | {
    kind: "deleted";
    messageIds: number[];
} | {
    kind: "reaction";
    reactionUpdate: TReactionUpdate;
} | {
    kind: "topic-lifecycle";
    lifecycle: TelegramTopicLifecycleUpdate<TMessage>;
} | {
    kind: "callback";
    query: TCallbackQuery;
    shouldPair: boolean;
    shouldDeny: boolean;
} | {
    kind: "message";
    message: TMessage & {
        from: TelegramUser;
    };
    shouldPair: boolean;
    shouldNotifyPaired: boolean;
    shouldDeny: boolean;
} | {
    kind: "edited-message";
    message: TMessage & {
        from: TelegramUser;
    };
    shouldPair: boolean;
    shouldDeny: boolean;
} | {
    kind: "guest";
    guestMessage: TGuestMessage & {
        from: TelegramUser;
    };
    shouldDeny: boolean;
};
export declare function buildTelegramUpdateExecutionPlan<TReactionUpdate extends TelegramMessageReactionUpdated, TCallbackQuery extends TelegramCallbackQuery, TMessage extends TelegramUpdateMessage, TGuestMessage extends TelegramGuestMessage>(action: TelegramUpdateFlowAction<TReactionUpdate, TCallbackQuery, TMessage, TGuestMessage>): TelegramUpdateExecutionPlan<TReactionUpdate, TCallbackQuery, TMessage, TGuestMessage>;
export declare function buildTelegramUpdateExecutionPlanFromUpdate<TUpdate extends TelegramUpdateFlow>(update: TUpdate, allowedUserId?: number): TelegramUpdateExecutionPlan<NonNullable<TUpdate["message_reaction"]>, NonNullable<TUpdate["callback_query"]>, NonNullable<TUpdate["message"] | TUpdate["edited_message"]>>;
export type TelegramMessageOwnershipRecorderInput = Parameters<TelegramMessageOwnershipStore["record"]>[0];
export type TelegramMessageOwnershipRecorder = (input: TelegramMessageOwnershipRecorderInput) => void;
interface TelegramUnauthorizedReplyOptions {
    parseMode?: "HTML";
    target?: {
        chatId: number;
        threadId?: number;
    };
}
export interface TelegramUpdateRuntimeDeps<TContext = unknown, TReactionUpdate extends TelegramMessageReactionUpdated = TelegramMessageReactionUpdated, TCallbackQuery extends TelegramCallbackQuery = TelegramCallbackQuery, TMessage extends TelegramUpdateMessage = TelegramUpdateMessage> {
    ctx: TContext;
    execution?: TelegramUpdateExecutionFence;
    getCurrentInstanceId?: () => string | undefined;
    getMessageOwnership?: TelegramMessageOwnershipLookup;
    getTargetOwnership?: TelegramTargetOwnershipLookup;
    recordMessageOwnership?: TelegramMessageOwnershipRecorder;
    foreignOwnedUpdateForwarder?: TelegramForeignOwnedUpdateForwarder<TContext, TReactionUpdate, TCallbackQuery, TMessage>;
    removePendingMediaGroupMessages: (messageIds: number[]) => void;
    removeQueuedTelegramTurnsByMessageIds: (messageIds: number[], ctx: TContext) => number;
    handleAuthorizedTelegramReactionUpdate: (reactionUpdate: TReactionUpdate, ctx: TContext) => Promise<void>;
    handleTelegramTopicLifecycleUpdate?: (lifecycle: TelegramTopicLifecycleUpdate<TMessage>, ctx: TContext) => Promise<void> | void;
    pairTelegramUserIfNeeded: (userId: number, ctx: TContext, assertExecutionCurrent?: () => void) => Promise<boolean>;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    answerGuestQuery: (guestQueryId: string, text?: string, options?: Pick<TelegramUnauthorizedReplyOptions, "parseMode">) => Promise<void>;
    handleAuthorizedTelegramCallbackQuery: (query: TCallbackQuery, ctx: TContext) => Promise<void>;
    sendTextReply: (chatId: number, replyToMessageId: number, text: string, options?: TelegramUnauthorizedReplyOptions) => Promise<number | undefined>;
    handleAuthorizedTelegramMessage: (message: TMessage, ctx: TContext) => Promise<void>;
    handleAuthorizedTelegramEditedMessage: (message: TMessage, ctx: TContext) => unknown;
    handleAuthorizedTelegramGuestMessage?: (guestMessage: TelegramGuestMessage & {
        from: TelegramUser;
    }, ctx: TContext) => Promise<void>;
    /** Called when the owner writes in an unbound thread no live instance owns. */
    handleUnboundTelegramTopicMessage?: (message: TMessage & {
        from: TelegramUser;
    }, ctx: TContext) => Promise<void>;
}
export interface TelegramUpdateRuntimeControllerDeps<TContext = unknown, TCallbackQuery extends TelegramCallbackQuery = TelegramCallbackQuery, TMessage extends TelegramUpdateMessage = TelegramUpdateMessage> {
    getAllowedUserId: () => number | undefined;
    getCurrentInstanceId?: () => string | undefined;
    getMessageOwnership?: TelegramMessageOwnershipLookup;
    getTargetOwnership?: TelegramTargetOwnershipLookup;
    recordMessageOwnership?: TelegramMessageOwnershipRecorder;
    foreignOwnedUpdateForwarder?: TelegramForeignOwnedUpdateForwarder<TContext, TelegramMessageReactionUpdated, TCallbackQuery, TMessage>;
    removePendingMediaGroupMessages: (messageIds: number[]) => void;
    flushPendingMediaGroupMessage?: (messageId: number) => Promise<boolean>;
    flushPendingTextGroupMessage?: (messageId: number) => Promise<boolean>;
    removeQueuedTelegramTurnsByMessageIds: (messageIds: number[], ctx: TContext, scope?: {
        chatId?: number;
        threadId?: number;
    }) => number;
    applyQueuedTelegramTurnReactionByMessageId: (messageId: number, disposition: TelegramQueueReactionDisposition, ctx: TContext, scope?: {
        chatId?: number;
        threadId?: number;
    }) => boolean;
    pairTelegramUserIfNeeded: (userId: number, ctx: TContext, assertExecutionCurrent?: () => void) => Promise<boolean>;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    answerGuestQuery: (guestQueryId: string, text?: string, options?: Pick<TelegramUnauthorizedReplyOptions, "parseMode">) => Promise<void>;
    handleAuthorizedTelegramCallbackQuery: (query: TCallbackQuery, ctx: TContext) => Promise<void>;
    sendTextReply: (chatId: number, replyToMessageId: number, text: string, options?: TelegramUnauthorizedReplyOptions) => Promise<number | undefined>;
    handleAuthorizedTelegramMessage: (message: TMessage, ctx: TContext) => Promise<void>;
    handleAuthorizedTelegramEditedMessage: (message: TMessage, ctx: TContext) => unknown;
    handleAuthorizedTelegramGuestMessage?: (guestMessage: TelegramGuestMessage & {
        from: TelegramUser;
    }, ctx: TContext) => Promise<void>;
    handleTelegramTopicLifecycleUpdate?: (lifecycle: TelegramTopicLifecycleUpdate<TMessage>, ctx: TContext) => Promise<void> | void;
    /** Called when the owner writes in an unbound thread no live instance owns. */
    handleUnboundTelegramTopicMessage?: (message: TMessage & {
        from: TelegramUser;
    }, ctx: TContext) => Promise<void>;
}
export interface TelegramUpdateRuntimeController<TContext = unknown, TUpdate extends TelegramUpdateFlow = TelegramUpdateFlow> {
    handleAuthorizedReactionUpdate: (reactionUpdate: NonNullable<TUpdate["message_reaction"]>, ctx: TContext) => Promise<void>;
    handleUpdate: (update: TUpdate, ctx: TContext, execution?: TelegramUpdateExecutionFence) => Promise<void>;
}
export declare function executeTelegramUpdate<TUpdate extends TelegramUpdateFlow, TContext = unknown>(update: TUpdate, allowedUserId: number | undefined, deps: TelegramUpdateRuntimeDeps<TContext, NonNullable<TUpdate["message_reaction"]>, NonNullable<TUpdate["callback_query"]>, NonNullable<TUpdate["message"] | TUpdate["edited_message"]>>): Promise<void>;
export type TelegramPairedUpdateRuntimeControllerDeps<TContext = unknown, TUpdate extends TelegramUpdateFlow = TelegramUpdateFlow> = Omit<TelegramUpdateRuntimeControllerDeps<TContext, NonNullable<TUpdate["callback_query"]>, NonNullable<TUpdate["message"] | TUpdate["edited_message"]>>, "pairTelegramUserIfNeeded"> & TelegramUserPairingRuntimeDeps<TContext>;
export declare function createTelegramPairedUpdateRuntime<TContext = unknown, TUpdate extends TelegramUpdateFlow = TelegramUpdateFlow>(deps: TelegramPairedUpdateRuntimeControllerDeps<TContext, TUpdate>): TelegramUpdateRuntimeController<TContext, TUpdate>;
export declare function createTelegramUpdateRuntime<TContext = unknown, TUpdate extends TelegramUpdateFlow = TelegramUpdateFlow>(deps: TelegramUpdateRuntimeControllerDeps<TContext, NonNullable<TUpdate["callback_query"]>, NonNullable<TUpdate["message"] | TUpdate["edited_message"]>>): TelegramUpdateRuntimeController<TContext, TUpdate>;
export interface AuthorizedTelegramReactionUpdateDeps<TContext> {
    allowedUserId?: number;
    ctx: TContext;
    getCurrentInstanceId?: () => string | undefined;
    getMessageOwnership?: TelegramMessageOwnershipLookup;
    foreignOwnedUpdateForwarder?: TelegramForeignOwnedUpdateForwarder<TContext>;
    assertExecutionCurrent?: () => void;
    flushPendingMediaGroupMessage?: (messageId: number) => Promise<boolean>;
    flushPendingTextGroupMessage?: (messageId: number) => Promise<boolean>;
    applyQueuedTelegramTurnReactionByMessageId: (messageId: number, disposition: TelegramQueueReactionDisposition, ctx: TContext, scope?: {
        chatId?: number;
        threadId?: number;
    }) => boolean;
}
export declare function handleAuthorizedTelegramReactionUpdate<TContext>(reactionUpdate: TelegramMessageReactionUpdated, deps: AuthorizedTelegramReactionUpdateDeps<TContext>): Promise<void>;
export declare function executeTelegramUpdatePlan<TContext = unknown, TReactionUpdate extends TelegramMessageReactionUpdated = TelegramMessageReactionUpdated, TCallbackQuery extends TelegramCallbackQuery = TelegramCallbackQuery, TMessage extends TelegramUpdateMessage = TelegramUpdateMessage>(plan: TelegramUpdateExecutionPlan<TReactionUpdate, TCallbackQuery, TMessage>, deps: TelegramUpdateRuntimeDeps<TContext, TReactionUpdate, TCallbackQuery, TMessage>): Promise<void>;
export declare const TELEGRAM_UPDATE_RETRY_BASE_DELAY_MS = 1000;
export declare const TELEGRAM_UPDATE_RETRY_MAX_DELAY_MS = 60000;
export declare const TELEGRAM_UPDATE_WORKER_BATCH_SIZE = 64;
export type TelegramUpdateWorkerPhase = "stopped" | "idle" | "executing" | "retry-wait" | "failed" | "deferred" | "queued" | "blocked";
export type TelegramUpdateWorkerBlockedReason = "authority-lost" | "authority-check" | "journal-read" | "journal-write" | "execution" | "input-custody" | "prior-generation-executing" | "invalid-outcome";
export interface TelegramUpdateWorkerStateSnapshot {
    phase: TelegramUpdateWorkerPhase;
    generation: number;
    phaseStartedAtMs?: number;
    currentUpdateId?: number;
    blockedReason?: TelegramUpdateWorkerBlockedReason;
    blockedInputCustody?: {
        updateId: number;
        kind: "running-outcome-unknown" | "foreign-ready" | "handoff-frozen" | "legacy-retry-state";
    };
    journalEntryCount: number;
    journalSerializedBytes: number;
    oldestAdmittedAtMs?: number;
    deferredClaimCount: number;
    queuedClaimCount: number;
    foreignQueuedCount: number;
    foreignQueuedOwner?: TelegramUpdateJournalQueueOwner;
    foreignQueuedOwnerLiveness?: TelegramProcessLiveness;
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
export interface TelegramUpdateWorkerJournalSnapshot {
    version: typeof TELEGRAM_UPDATE_JOURNAL_VERSION | typeof TELEGRAM_UPDATE_JOURNAL_EXCLUSION_VERSION | typeof TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION;
    acceptedThroughUpdateId?: number;
    entries: readonly {
        updateId: number;
        update: TelegramJournaledUpdate;
        readonly preApprovalExcluded?: boolean;
        admittedAtMs: number;
        state: "pending" | "retry-wait" | "queued" | "failed";
        inputClaim?: TelegramUpdateJournalInputClaim;
        queueKind?: "prompt" | "control";
        queueReceiptId?: string;
        queueOwner?: TelegramUpdateJournalQueueOwner;
        queueHandoff?: {
            handoffId: string;
            offeredAtMs: number;
            recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
        };
        failure?: {
            attemptCount: number;
            failedAtMs: number;
            failureClass: string;
            summary: string;
        };
        nextRetryAtMs?: number;
        terminalAtMs?: number;
        terminalReason?: string;
        terminalFailureId?: string;
    }[];
    serializedBytes: number;
}
export interface TelegramUpdateWorkerJournalPort {
    read: () => TelegramUpdateWorkerJournalSnapshot;
    /** Optional strict observation; it must not recover, repair or grant new receipt authority. */
    isQueueReceiptCurrent?: (receipt: TelegramQueueAdmissionReceiptLike, owner: TelegramUpdateJournalQueueOwner) => boolean;
    markQueued: (receipt: {
        queueKind: "prompt" | "control";
        receiptId: string;
        sourceUpdateIds: readonly number[];
        owner: TelegramUpdateJournalQueueOwnerIdentity;
    }) => {
        queuedUpdateIds: readonly number[];
        duplicateUpdateIds: readonly number[];
        queueOwner?: TelegramUpdateJournalQueueOwner;
    };
    completeQueued: (receipts: readonly {
        queueKind: "prompt" | "control";
        receiptId: string;
        sourceUpdateIds: readonly number[];
        queueOwner: TelegramUpdateJournalQueueOwner;
    }[]) => {
        removedUpdateIds: readonly number[];
    };
    markExecutionFailure: (input: {
        updateId: number;
        expectedAttemptCount: number;
        failedAtMs: number;
        failureClass: string;
        summary: string;
        disposition: "retry-wait" | "failed";
        nextRetryAtMs?: number;
        terminalReason?: string;
    }) => {
        entry: TelegramUpdateWorkerJournalSnapshot["entries"][number];
    };
    removeCompleted: (updateIds: readonly number[]) => {
        removedUpdateIds: readonly number[];
    };
}
export interface TelegramUpdateRetryPolicy {
    baseDelayMs: number;
    maxDelayMs: number;
}
export interface TelegramUpdateExecutionFailureClassification {
    disposition: "retryable" | "terminal";
    failureClass: string;
    summary: string;
}
export interface TelegramUpdateWorkerRuntimeDeps<TContext> {
    journal: TelegramUpdateWorkerJournalPort;
    executeUpdate: (update: TelegramJournaledUpdate, ctx: TContext, signal: AbortSignal) => Promise<TelegramUpdateAdmissionOutcome> | TelegramUpdateAdmissionOutcome;
    executeCustodiedUpdate?: (update: TelegramJournaledUpdate, ctx: TContext, signal: AbortSignal) => Promise<TelegramCustodiedExecutionResult>;
    hasAuthority: (ctx: TContext) => boolean;
    getJournalBindingKey?: () => string | undefined;
    getRecipientBindingKey?: () => string | undefined;
    getQueueOwnerIdentity?: (ctx: TContext) => TelegramUpdateJournalQueueOwnerIdentity;
    isContextCurrent?: (ctx: TContext) => boolean;
    createAbortController?: () => AbortController;
    getNowMs?: () => number;
    retryPolicy?: Partial<TelegramUpdateRetryPolicy>;
    classifyExecutionFailure?: (error: unknown) => TelegramUpdateExecutionFailureClassification;
    settleTerminalExecutionFailure?: (error: unknown) => Promise<boolean>;
    scheduleRetry?: (callback: () => void, delayMs: number) => unknown;
    cancelRetry?: (handle: unknown) => void;
    batchSize?: number;
    yieldToEventLoop?: () => Promise<void>;
    onStateChange?: (state: TelegramUpdateWorkerStateSnapshot) => void;
    onQueueReceiptCommitted?: (receipt: TelegramQueueAdmissionReceiptLike, ctx: TContext) => void;
    onUpdateCompleted?: (updateId: number, ctx: TContext) => void;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export type TelegramQueueReceiptCompletionReason = "prompt-handoff" | "control-settlement" | "discard";
export interface TelegramUpdateWorkerRuntime<TContext> {
    start: (ctx: TContext) => void;
    signal: () => void;
    settleDeferred: (input: {
        updateId: number;
        outcome: TelegramUpdateAdmissionOutcome;
        signal: AbortSignal;
    }) => void;
    settleCustodied: (input: {
        updateId: number;
        result: TelegramCustodiedExecutionResult;
        signal: AbortSignal;
    }) => void;
    isQueueReceiptCommitted: (receipt: TelegramQueueAdmissionReceiptLike) => boolean;
    getQueueReceiptOwner: (receipt: TelegramQueueAdmissionReceiptLike) => TelegramUpdateJournalQueueOwner | undefined;
    completeQueueReceipts: (input: {
        receipts: readonly TelegramQueueAdmissionReceiptLike[];
        ctx: TContext;
        reason: TelegramQueueReceiptCompletionReason;
    }) => boolean;
    stop: () => Promise<void>;
    waitForDrain: () => Promise<void>;
    getState: () => TelegramUpdateWorkerStateSnapshot;
}
export declare class TelegramUpdateAdmissionOutcomeError extends Error {
    constructor(message: string);
}
export declare function createTelegramUpdateWorkerRuntime<TContext>(deps: TelegramUpdateWorkerRuntimeDeps<TContext>): TelegramUpdateWorkerRuntime<TContext>;
/**
 * Verdict returned by a public Telegram update handler.
 *
 * - `"consume"` — the handler processed this update; pi-telegram skips default routing.
 * - `"pass"` (or `void`/`undefined`) — pi-telegram routes the update normally.
 */
export type TelegramUpdateHandlerVerdict = "consume" | "pass";
export interface TelegramUpdateExecutionFence {
    readonly generation: number;
    readonly updateId: number;
    readonly signal: AbortSignal;
    isCurrent: () => boolean;
    assertCurrent: () => void;
}
export declare function getTelegramUpdateExecutionFence(update: unknown): TelegramUpdateExecutionFence | undefined;
export declare function assertTelegramUpdateExecutionCurrent(update: unknown): void;
export declare function createTelegramUpdateExecutionFenceGuard(update: unknown): () => void;
export declare function carryTelegramUpdateExecutionFence<TTarget extends object>(source: unknown, target: TTarget): TTarget;
export type TelegramUpdateHandler = (update: unknown, execution?: TelegramUpdateExecutionFence) => TelegramUpdateHandlerVerdict | void | Promise<TelegramUpdateHandlerVerdict | void>;
export interface TelegramUpdateHandlerRegistry {
    /** Schema version of this registry shape. */
    readonly version: 1;
    /**
     * Register an update handler. Returns a disposer that removes it.
     *
     * Handlers are invoked in registration order on every Telegram update,
     * before pi-telegram's own routing. The first handler that returns
     * `"consume"` wins and stops the chain for that update.
     */
    add: (handler: TelegramUpdateHandler) => () => void;
    /**
     * Run all registered handlers against an update.
     *
     * Used by pi-telegram's polling runtime; extension consumers should call
     * {@link registerTelegramUpdateHandler} or `add` instead of dispatching directly.
     */
    dispatch: (update: unknown, execution?: TelegramUpdateExecutionFence) => Promise<TelegramUpdateHandlerVerdict>;
}
/**
 * Called by pi-telegram's own runtime to obtain the registry it dispatches
 * through. Extension consumers should not call this; use
 * {@link registerTelegramUpdateHandler} instead.
 */
export declare function getTelegramUpdateHandlerRegistry(): TelegramUpdateHandlerRegistry;
export interface TelegramUpdateHandlerWrapDeps<TUpdate, TContext> {
    defaultHandle: (update: TUpdate, ctx: TContext) => Promise<void>;
    registry?: TelegramUpdateHandlerRegistry;
}
/**
 * Wrap a default polling `handleUpdate` with the public update handler registry.
 */
export declare function createTelegramUpdateHandle<TUpdate, TContext>(deps: TelegramUpdateHandlerWrapDeps<TUpdate, TContext>): (update: TUpdate, ctx: TContext) => Promise<void>;
export interface TelegramUpdateAdmissionHandleDeps<TUpdate extends TelegramUpdateFlow & {
    update_id: number;
}, TContext> {
    defaultHandle: (update: TUpdate, ctx: TContext, execution?: TelegramUpdateExecutionFence) => Promise<void>;
    registry?: TelegramUpdateHandlerRegistry;
    onLateOutcome?: (outcome: TelegramUpdateAdmissionOutcome, details: {
        updateId: number;
        ctx: TContext;
        signal: AbortSignal;
    }) => void | Promise<void>;
    onLateOutcomeError?: (error: unknown, updateId: number) => void;
}
export type TelegramCustodiedExecutionResult = {
    status: "completed";
} | {
    status: "deferred";
    receipt: TelegramInputJournalReceipt;
} | {
    status: "queued";
    queueReceipt: ReturnType<TelegramInputJournalStore["queueInputs"]>["queueReceipt"];
} | {
    status: "outcome-unknown";
    receipt: TelegramInputJournalReceipt;
};
type TelegramCustodyExecutionJournal = Pick<TelegramInputJournalStore, "acquireInput" | "startInput" | "completeInput" | "queueInputs">;
export declare function createTelegramInputCustodyWorkerJournalPort(store: TelegramInputJournalStore): TelegramUpdateWorkerJournalPort & {
    inputCustody: TelegramCustodyExecutionJournal;
};
export declare function createTelegramInputCustodyLegacyDispositionRuntime(deps: {
    withBindingReference<T>(recoveryKey: string, operation: (binding: {
        recoveryKey: string;
        journal: Pick<TelegramInputJournalStore, "listLegacyCustodyCandidates" | "applyLegacyCustodyDisposition">;
    }) => T): T;
}): {
    list(recoveryKey: string): import("./journal.ts").TelegramUpdateJournalLegacyCustodyCandidate[];
    apply(recoveryKey: string, authority: Parameters<TelegramInputJournalStore["applyLegacyCustodyDisposition"]>[0]): import("./journal.ts").TelegramUpdateJournalLegacyCustodyDispositionResult;
};
export declare function createTelegramInputCustodyHandoffClient(deps: {
    journal: Pick<TelegramInputJournalStore, "offerInputHandoff">;
    resolveAcceptedReference?: (input: {
        sourceUpdateId: number;
        recipientBindingKey: string;
    }) => {
        sourceRecoveryKey: string;
        source: {
            updateId: number;
            owner: {
                acquisitionId: string;
                handoffId: string;
            };
        };
    } | undefined;
    sendEnvelope(envelope: Extract<TelegramBusEnvelope, {
        kind: "leader.offerInputCustodyHandoff";
    }>): Promise<TelegramBusEnvelope | undefined>;
}): {
    transfer(input: {
        requestId: string;
        receipt: TelegramInputJournalReceipt;
        recipientInstanceId: string;
        recipientRegistrationGeneration: string;
        recipientBindingKey: string;
        recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
        handoffToken: string;
        sentAtMs: number;
        auth?: string;
    }): Promise<{
        sourceRecoveryKey: string;
        source: {
            updateId: number;
            owner: {
                acquisitionId: string;
                handoffId: string;
            };
        };
        duplicate: boolean;
    }>;
};
export interface TelegramInputCustodyHandoffAcceptanceInput {
    sourceRecoveryKey: string;
    recipientBindingKey: string;
    source: TelegramInputJournalSourceReference;
    handoffId: string;
}
export declare function createTelegramInputCustodyHandoffAcceptanceRuntime<TContext>(deps: {
    resolveBinding(recoveryKey: string): {
        recoveryKey: string;
        recipientBindingKey: string;
        recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
        journal: Pick<TelegramInputJournalStore, "acceptInputHandoff">;
        signalWorker(ctx: TContext): void;
    } | undefined;
}): {
    accept(input: TelegramInputCustodyHandoffAcceptanceInput, ctx: TContext): {
        sourceRecoveryKey: string;
        source: {
            updateId: number;
            owner: {
                acquisitionId: string;
                handoffId: string;
            };
        };
        duplicate: boolean;
    };
};
export declare function createTelegramInputCustodyForwardReferenceResolver(deps: {
    recoveryKey: string;
    recipientBindingKey: string;
    recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
    journal: Pick<TelegramInputJournalStore, "read">;
}): (input: {
    sourceUpdateId: number;
    recipientBindingKey: string;
}) => {
    sourceRecoveryKey: string;
    source: {
        updateId: number;
        owner: {
            acquisitionId: string;
            handoffId: string;
        };
    };
} | undefined;
export interface TelegramCustodiedSourceReferenceWakeInput {
    deliveryId: string;
    sourceUpdateId: number;
    recipientBindingKey: string;
    sourceRecoveryKey: string;
    sourceClaim: {
        acquisitionId: string;
        handoffId: string;
    };
}
export declare function createTelegramInputCustodySourceReferenceWakeRuntime<TContext>(deps: {
    resolveBinding(recoveryKey: string): {
        recoveryKey: string;
        recipientBindingKey: string;
        recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
        journal: Pick<TelegramInputJournalStore, "read">;
        signalWorker(ctx: TContext): void;
    } | undefined;
}): {
    wakeSource(input: TelegramCustodiedSourceReferenceWakeInput, ctx: TContext): void;
};
export interface TelegramInputCustodyBusBindingRuntime<TContext> {
    acceptHandoff(input: TelegramInputCustodyHandoffAcceptanceInput, ctx: TContext): {
        sourceRecoveryKey: string;
        source: {
            updateId: number;
            owner: {
                acquisitionId: string;
                handoffId: string;
            };
        };
        duplicate: boolean;
    };
    wakeSource(input: TelegramCustodiedSourceReferenceWakeInput, ctx: TContext): void;
    resolveForwardReference(input: {
        sourceUpdateId: number;
        recipientBindingKey: string;
    }): {
        sourceRecoveryKey: string;
        source: {
            updateId: number;
            owner: {
                acquisitionId: string;
                handoffId: string;
            };
        };
    } | undefined;
}
export declare function createTelegramInputCustodyBusBindingRuntime<TContext>(deps: {
    getForwardRecoveryKey(): string | undefined;
    resolveBinding(recoveryKey: string): {
        recoveryKey: string;
        recipientBindingKey: string;
        recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
        journal: Pick<TelegramInputJournalStore, "read" | "acceptInputHandoff">;
        signalWorker(ctx: TContext): void;
    } | undefined;
}): TelegramInputCustodyBusBindingRuntime<TContext>;
export type TelegramInputCustodyActivationBlocker = "disabled" | "source-unready" | "legacy-writers-present" | "migration-incomplete" | "peer-capability-mismatch";
export declare function evaluateTelegramInputCustodyActivationReadiness(input: {
    requested: boolean;
    sourceStatus: "absent" | "v3" | "legacy" | "unsupported" | "ambiguous";
    legacyWritersExcluded: boolean;
    historicalMigrationComplete: boolean;
    peerReadiness: readonly ("ready" | "legacy" | "unknown")[];
}): {
    enabled: true;
} | {
    enabled: false;
    blocker: TelegramInputCustodyActivationBlocker;
};
export interface TelegramInputCustodyReadinessEvidenceSnapshot {
    version: 1;
    revision: number;
    writerExclusion?: TelegramInputCustodyWriterExclusionEvidence;
    migration?: TelegramInputCustodyMigrationEvidence;
    startupExclusion?: TelegramInputCustodyStartupExclusionAuthority;
    migrationCompletion?: TelegramInputCustodyMigrationCompletionAuthority;
}
export declare function createTelegramInputCustodyReadinessEvidenceStore(deps: {
    readRetained(): string | undefined;
    publishRetained(serialized: string): void;
    withSerialization<T>(operation: () => T): T;
    authorizePublication(kind: "writer-exclusion" | "migration" | "startup-exclusion" | "migration-completion", evidence: TelegramInputCustodyWriterExclusionEvidence | TelegramInputCustodyMigrationEvidence | TelegramInputCustodyStartupExclusionAuthority | TelegramInputCustodyMigrationCompletionAuthority): boolean;
}): {
    read: () => TelegramInputCustodyReadinessEvidenceSnapshot;
    publish: (input: {
        expectedRevision: number;
    } & ({
        kind: "writer-exclusion";
        evidence: TelegramInputCustodyWriterExclusionEvidence;
    } | {
        kind: "migration";
        evidence: TelegramInputCustodyMigrationEvidence;
    } | {
        kind: "startup-exclusion";
        evidence: TelegramInputCustodyStartupExclusionAuthority;
    } | {
        kind: "migration-completion";
        evidence: TelegramInputCustodyMigrationCompletionAuthority;
    })) => TelegramInputCustodyReadinessEvidenceSnapshot;
};
export interface TelegramInputCustodyActivationEvidenceIdentity {
    profileKey: string;
    recoveryKey: string;
}
export interface TelegramInputCustodyStartupExclusionAuthority extends TelegramInputCustodyActivationEvidenceIdentity {
    version: 1;
    status: "enforced" | "revoked";
    authorityId: string;
    closureOperationId: string;
    writerInventorySha256: string;
    allowedWriterProtocol: "custody-v3";
    authorizedAtMs: number;
}
export declare function normalizeTelegramInputCustodyStartupExclusionAuthority(value: unknown, expected: TelegramInputCustodyActivationEvidenceIdentity): TelegramInputCustodyStartupExclusionAuthority | undefined;
export interface TelegramInputCustodyWriterExclusionEvidence extends TelegramInputCustodyActivationEvidenceIdentity {
    version: 1;
    status: "excluded" | "present" | "unknown";
    startupAuthorityId?: string;
    closureOperationId?: string;
    writerInventorySha256?: string;
}
export interface TelegramInputCustodyWriterInventory extends TelegramInputCustodyActivationEvidenceIdentity {
    complete: boolean;
    writerInventorySha256: string;
    writers: readonly {
        processId: number;
        processBirthId: string;
    }[];
}
export declare function evaluateTelegramInputCustodyWriterExclusionEvidence(input: {
    expected: TelegramInputCustodyActivationEvidenceIdentity;
    inventory: TelegramInputCustodyWriterInventory;
    startupAuthority: TelegramInputCustodyStartupExclusionAuthority | undefined;
    getProcessLiveness(writer: {
        processId: number;
        processBirthId: string;
    }): TelegramProcessLiveness;
}): TelegramInputCustodyWriterExclusionEvidence;
export interface TelegramInputCustodyMigrationCompletionAuthority extends TelegramInputCustodyActivationEvidenceIdentity {
    version: 1;
    status: "authorized" | "revoked";
    authorityId: string;
    startupAuthorityId: string;
    closureOperationId: string;
    migrationInventorySha256: string;
    resultingSourceFamily: "absent" | "v3";
    authorizedAtMs: number;
}
export declare function normalizeTelegramInputCustodyMigrationCompletionAuthority(value: unknown, expected: TelegramInputCustodyActivationEvidenceIdentity): TelegramInputCustodyMigrationCompletionAuthority | undefined;
export interface TelegramInputCustodyMigrationEvidence extends TelegramInputCustodyActivationEvidenceIdentity {
    version: 1;
    status: "complete" | "incomplete" | "unknown";
    migrationAuthorityId?: string;
    startupAuthorityId?: string;
    closureOperationId?: string;
    migrationInventorySha256?: string;
    resultingSourceFamily?: "absent" | "v3";
}
export type TelegramInputCustodyWriterCutoverResult<TMode> = {
    kind: "blocked";
    blocker: "startup-authority" | "writer-inventory";
    evidence?: TelegramInputCustodyWriterExclusionEvidence;
} | {
    kind: "completed";
    mode: TMode;
    evidence: TelegramInputCustodyWriterExclusionEvidence;
    resumed: boolean;
};
export declare function executeTelegramInputCustodyWriterCutover<TClosure extends {
    operationId: string;
    profileKey: string;
    recoveryKey: string;
}, TMode extends TelegramInputCustodyWriterProtocolModeEvidence>(input: {
    expected: TelegramInputCustodyActivationEvidenceIdentity;
    closure: TClosure;
    startupAuthority: TelegramInputCustodyStartupExclusionAuthority;
    inventory: TelegramInputCustodyWriterInventory;
    getProcessLiveness(writer: {
        processId: number;
        processBirthId: string;
    }): TelegramProcessLiveness;
    installProtocolMode(closure: TClosure, authority: {
        startupAuthorityId: string;
        writerInventorySha256: string;
    }): {
        mode: TMode;
        resumed: boolean;
    };
    evidenceStore: {
        read(): TelegramInputCustodyReadinessEvidenceSnapshot;
        publish(input: {
            expectedRevision: number;
            kind: "writer-exclusion";
            evidence: TelegramInputCustodyWriterExclusionEvidence;
        }): TelegramInputCustodyReadinessEvidenceSnapshot;
    };
}): TelegramInputCustodyWriterCutoverResult<TMode>;
export type TelegramInputCustodyMigrationCompletionResult = {
    kind: "blocked";
    blocker: "migration-authority" | "source-drift" | "inventory-drift";
} | {
    kind: "completed";
    evidence: TelegramInputCustodyMigrationEvidence;
    resumed: boolean;
};
export declare function executeTelegramInputCustodyMigrationCompletion(input: {
    expected: TelegramInputCustodyActivationEvidenceIdentity;
    authority: TelegramInputCustodyMigrationCompletionAuthority;
    migrationInventorySha256: string;
    inspectSource(): "absent" | "v3" | "legacy" | "unsupported" | "ambiguous";
    evidenceStore: {
        read(): TelegramInputCustodyReadinessEvidenceSnapshot;
        publish(input: {
            expectedRevision: number;
            kind: "migration";
            evidence: TelegramInputCustodyMigrationEvidence;
        }): TelegramInputCustodyReadinessEvidenceSnapshot;
    };
}): TelegramInputCustodyMigrationCompletionResult;
export interface TelegramInputCustodyWriterProtocolModeEvidence extends TelegramInputCustodyActivationEvidenceIdentity {
    protocol: "custody-v3";
    startupAuthorityId: string;
    closureOperationId: string;
    writerInventorySha256: string;
}
export declare function createTelegramInputCustodyProvenReadinessResolver(deps: {
    isRequested(): boolean;
    expectedIdentity(): TelegramInputCustodyActivationEvidenceIdentity;
    inspectSource(): "absent" | "v3" | "legacy" | "unsupported" | "ambiguous";
    readWriterExclusionEvidence(): TelegramInputCustodyWriterExclusionEvidence | undefined;
    readStartupExclusionAuthority(): TelegramInputCustodyStartupExclusionAuthority | undefined;
    readWriterProtocolMode(): TelegramInputCustodyWriterProtocolModeEvidence | undefined;
    readMigrationCompletionAuthority(): TelegramInputCustodyMigrationCompletionAuthority | undefined;
    readMigrationEvidence(): TelegramInputCustodyMigrationEvidence | undefined;
    listPeerReadiness(): readonly ("ready" | "legacy" | "unknown")[];
}): () => ReturnType<typeof evaluateTelegramInputCustodyActivationReadiness>;
export declare function createTelegramInputCustodyActivationReadinessResolver(deps: {
    isRequested(): boolean;
    inspectSource(): "absent" | "v3" | "legacy" | "unsupported" | "ambiguous";
    areLegacyWritersExcluded(): boolean;
    isHistoricalMigrationComplete(): boolean;
    listPeerReadiness(): readonly ("ready" | "legacy" | "unknown")[];
}): () => ReturnType<typeof evaluateTelegramInputCustodyActivationReadiness>;
export declare function createTelegramInputCustodyLifecycleBindingResolver(deps: {
    isEnabled(): boolean;
    resolveInputJournal(): {
        runtimeKey: string;
        recoveryKey: string;
        journal: TelegramInputJournalStore;
    } | undefined;
    getRecipientBindingKey(): string | undefined;
}): () => TelegramUpdateAdmissionLifecycleJournalBinding | undefined;
export declare function createTelegramCustodiedExecutionSession(input: {
    journal: TelegramCustodyExecutionJournal;
    recipientBindingKey: string;
}): {
    execute(update: TelegramJournaledUpdate, handler: (update: TelegramJournaledUpdate) => Promise<TelegramUpdateAdmissionOutcome>): Promise<TelegramCustodiedExecutionResult>;
    settle(updateId: number, outcome: TelegramUpdateAdmissionOutcome): Promise<TelegramCustodiedExecutionResult>;
};
export declare function executeTelegramCustodiedInput(input: {
    journal: TelegramCustodyExecutionJournal;
    update: TelegramJournaledUpdate;
    recipientBindingKey: string;
    execute(update: TelegramJournaledUpdate): Promise<TelegramUpdateAdmissionOutcome>;
}): Promise<TelegramCustodiedExecutionResult>;
/**
 * Compose the stable public handler registry with source-bound semantic
 * admission. Production polling switches to this only with the journal worker.
 */
export declare function createTelegramUpdateAdmissionHandle<TUpdate extends TelegramUpdateFlow & {
    update_id: number;
}, TContext>(deps: TelegramUpdateAdmissionHandleDeps<TUpdate, TContext>): (update: TUpdate, ctx: TContext, signal: AbortSignal) => Promise<TelegramUpdateAdmissionOutcome>;
export declare function createTelegramCustodiedUpdateAdmissionHandle<TUpdate extends TelegramJournaledUpdate & TelegramUpdateFlow, TContext>(deps: Omit<TelegramUpdateAdmissionHandleDeps<TUpdate, TContext>, "onLateOutcome" | "onLateOutcomeError"> & {
    journal: TelegramCustodyExecutionJournal;
    recipientBindingKey: string;
    onLateOutcomeError(error: unknown, updateId: number): void;
    onCustodiedLateSettlement?: (result: TelegramCustodiedExecutionResult, details: {
        updateId: number;
        signal: AbortSignal;
    }) => void;
}): (update: TUpdate, ctx: TContext, signal: AbortSignal) => Promise<TelegramCustodiedExecutionResult>;
export interface TelegramQueueAdmissionItemLike {
    admissionReceipts?: readonly TelegramQueueAdmissionReceiptLike[];
}
export interface TelegramQueueAdmissionSettlementRuntime<TContext> {
    isItemReady: (item: TelegramQueueAdmissionItemLike) => boolean;
    getQueueReceiptOwner: (receipt: TelegramQueueAdmissionReceiptLike) => TelegramUpdateJournalQueueOwner | undefined;
    onPromptHandedOff: (item: TelegramQueueAdmissionItemLike, ctx: TContext) => boolean;
    onControlSettled: (item: TelegramQueueAdmissionItemLike, ctx: TContext) => boolean;
    onItemsDiscarded: (items: readonly TelegramQueueAdmissionItemLike[], ctx: TContext) => boolean;
}
export declare function createTelegramQueueAdmissionSettlementMuxRuntime<TContext>(runtimes: readonly TelegramQueueAdmissionSettlementRuntime<TContext>[]): TelegramQueueAdmissionSettlementRuntime<TContext>;
export declare function createTelegramQueueAdmissionSettlementRuntime<TContext>(worker: TelegramUpdateWorkerRuntime<TContext>): TelegramQueueAdmissionSettlementRuntime<TContext>;
export interface TelegramUpdateAdmissionLifecycleJournalBinding {
    runtimeKey: string;
    recoveryKey: string;
    recipientBindingKey?: string;
    journal: TelegramUpdateWorkerJournalPort & {
        inputCustody?: TelegramCustodyExecutionJournal;
        appendBatch: (updates: readonly TelegramJournaledUpdate[], acceptedThroughUpdateId?: number) => Pick<TelegramUpdateJournalAppendResult, "nonExcludedUpdateIds">;
        applyOperatorDisposition?: (input: TelegramUpdateJournalOperatorDispositionInput) => TelegramUpdateJournalOperatorDispositionResult;
        discardQueued?: (input: {
            queueKind: "prompt" | "control";
            receiptId: string;
            sourceUpdateIds: readonly number[];
            expectedOwner: TelegramUpdateJournalQueueOwner;
        }) => TelegramUpdateJournalQueueDiscardResult;
        offerQueuedHandoff?: (input: TelegramUpdateJournalQueueHandoffInput) => TelegramUpdateJournalQueueHandoffOfferResult;
        acceptQueuedHandoff?: (input: TelegramUpdateJournalQueueHandoffInput) => TelegramUpdateJournalQueueHandoffAcceptResult;
        cancelQueuedHandoff?: (input: TelegramUpdateJournalQueueHandoffInput) => TelegramUpdateJournalQueueHandoffCancelResult;
        recoverDeadQueueOwner?: (input: {
            queueKind: "prompt" | "control";
            receiptId: string;
            sourceUpdateIds: readonly number[];
            deadOwner: TelegramUpdateJournalQueueOwner;
            recoveryOwner: TelegramUpdateJournalQueueOwnerIdentity;
        }) => TelegramUpdateJournalDeadQueueOwnerRecoveryResult;
    };
    hasAuthority?: () => boolean;
}
export interface TelegramQueueHandoffControlExecutionDeps<TContext> {
    isContextCurrent: (ctx: TContext) => boolean;
    showStatus: (chatId: number, replyToMessageId: number, ctx: TContext, threadId?: number) => Promise<void>;
    openModelMenu: (chatId: number, replyToMessageId: number, ctx: TContext, threadId?: number) => Promise<void>;
}
export declare function createTelegramQueueHandoffControlExecutionFactory<TContext>(deps: TelegramQueueHandoffControlExecutionDeps<TContext>): (payload: TelegramControlQueueHandoffPayload) => PendingTelegramControlItem<TContext>["execute"];
export interface TelegramQueueHandoffCoordinatorInput<TContext> {
    item: TelegramQueueItem<TContext>;
    expectedOwner: TelegramUpdateJournalQueueOwner;
    recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
    handoffToken: string;
    stageRemote: (input: {
        handoffToken: string;
        expectedOwner: TelegramUpdateJournalQueueOwner;
        recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
        payload: TelegramQueueHandoffPayload;
    }) => Promise<TelegramQueueHandoffStageResult>;
    lifecycle: Pick<TelegramUpdateAdmissionLifecycleRuntime<TContext>, "offerQueueReceiptHandoff" | "acceptQueueReceiptHandoff" | "cancelQueueReceiptHandoff">;
    removeDonorItem: (receipt: TelegramQueueAdmissionReceipt) => boolean;
}
export type TelegramQueueHandoffCoordinatorResult = {
    status: "transferred";
    receipt: TelegramQueueAdmissionReceipt;
    queueOwner: TelegramUpdateJournalQueueOwner;
} | {
    status: "retained";
    receipt: TelegramQueueAdmissionReceipt;
    error: unknown;
    cancelled: boolean;
};
export declare function coordinateTelegramQueueHandoff<TContext>(input: TelegramQueueHandoffCoordinatorInput<TContext>): Promise<TelegramQueueHandoffCoordinatorResult>;
export interface TelegramQueueHandoffReconciliationBinding<TContext> {
    request: (ctx: TContext) => void;
    set: (reconcile: (ctx: TContext) => Promise<void>) => void;
}
export declare function createTelegramQueueHandoffReconciliationBinding<TContext>(recordFailure?: (error: unknown) => void): TelegramQueueHandoffReconciliationBinding<TContext>;
export interface TelegramQueueHandoffRecipientRuntimeDeps<TContext> {
    staging: TelegramQueueHandoffStagingRuntime;
    getRecipientOwner: () => TelegramUpdateJournalQueueOwnerIdentity;
    getLifecycleForBinding: (journalBindingKey: string) => TelegramUpdateAdmissionLifecycleRuntime<TContext> | undefined;
    isTransportStampActive?: (stamp: TelegramQueueHandoffPayload["transportStamp"]) => boolean;
    dispatchNext: (ctx: TContext) => void;
}
export declare function createTelegramQueueHandoffRecipientRuntime<TContext>(deps: TelegramQueueHandoffRecipientRuntimeDeps<TContext>): (envelope: Extract<TelegramBusEnvelope, {
    kind: "leader.offerQueueHandoff";
}>, ctx: TContext) => Promise<TelegramQueueHandoffStageResult>;
export interface TelegramQueueHandoffReconcilerDeps<TContext> {
    ownsDirect: () => boolean;
    isFollowerRegistered: () => boolean;
    isBusEnabled: () => boolean;
    canHandoffWithLeader?: () => boolean;
    listFollowers: () => readonly TelegramBusFollowerView[];
    createRecipientJournalBindingKey: (recipient: TelegramBusFollowerView) => string | undefined;
    getQueuedItems: () => readonly TelegramQueueItem<TContext>[];
    getReceiptOwner: (receipt: TelegramQueueAdmissionReceipt) => TelegramUpdateJournalQueueOwner | undefined;
    getLifecycleForReceipt: (receipt: TelegramQueueAdmissionReceipt) => TelegramUpdateAdmissionLifecycleRuntime<TContext> | undefined;
    createHandoffToken: () => string;
    createRequestId: () => string;
    donorInstanceId: string;
    authSecret?: string;
    stageThroughFollower: (input: {
        recipient: TelegramBusFollowerView;
        expectedOwner: TelegramUpdateJournalQueueOwner;
        handoffToken: string;
        payload: TelegramQueueHandoffPayload;
    }) => Promise<TelegramQueueHandoffStageResult>;
    routeThroughLeader: (input: {
        requestId: string;
        auth?: string;
        recipientInstanceId: string;
        recipientRegistrationGeneration: string;
        donorInstanceId: string;
        donorProcessId: number;
        donorProcessBirthId: string;
        donorSessionGeneration: number;
        donorAcquisitionId: string;
        donorAcquiredAtMs: number;
        handoffToken: string;
        payload: TelegramQueueHandoffPayload;
        sentAtMs: number;
    }) => Promise<TelegramBusEnvelope>;
    removeDonorItem: (receipt: TelegramQueueAdmissionReceipt, ctx: TContext) => boolean;
    recordFailure?: (error: unknown, details: Record<string, unknown>) => void;
}
export interface TelegramQueueHandoffReconciliationRuntimeAssemblyDeps<TContext> {
    ownsDirect: () => boolean;
    isFollowerRegistered: () => boolean;
    isBusEnabled: () => boolean;
    canHandoffWithLeader?: () => boolean;
    listFollowers: () => readonly TelegramBusFollowerView[];
    createRecipientJournalResolver: (profileKey: string) => (() => {
        recoveryKey: string;
    } | undefined);
    queueStore: {
        getQueuedItems: () => TelegramQueueItem<TContext>[];
        setQueuedItems: (items: TelegramQueueItem<TContext>[]) => void;
    };
    admission: Pick<TelegramUpdateAdmissionRuntimeBinding<TContext>, "getSettlement" | "getLifecycleForJournalBinding">;
    createHandoffToken: () => string;
    createRequestId: () => string;
    donorInstanceId: string;
    authSecret?: string;
    stageThroughFollower: (input: {
        recipientInstanceId: string;
        recipientRegistrationGeneration: string;
        donorProcessId: number;
        donorProcessBirthId: string;
        donorSessionGeneration: number;
        donorAcquisitionId: string;
        donorAcquiredAtMs: number;
        handoffToken: string;
        payload: TelegramQueueHandoffPayload;
    }) => Promise<TelegramQueueHandoffStageResult>;
    routeThroughLeader: TelegramQueueHandoffReconcilerDeps<TContext>["routeThroughLeader"];
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
/** Own queue-handoff projections over journals, admission, IPC, and live queue state. */
export declare function createTelegramQueueHandoffReconciliationRuntimeAssembly<TContext>(deps: TelegramQueueHandoffReconciliationRuntimeAssemblyDeps<TContext>): (ctx: TContext) => Promise<void>;
export declare function createTelegramQueueHandoffReconciler<TContext>(deps: TelegramQueueHandoffReconcilerDeps<TContext>): (ctx: TContext) => Promise<void>;
export interface TelegramQueueMutationDependencyItem {
    chatId: number;
    target?: {
        chatId: number;
    };
    replyToMessageId: number;
    sourceMessageIds?: readonly number[];
}
export interface TelegramUpdateAdmissionLifecycleRuntimeDeps<TContext> {
    resolveBinding: () => TelegramUpdateAdmissionLifecycleJournalBinding | undefined;
    getQueueOwnerIdentity?: (ctx: TContext) => TelegramUpdateJournalQueueOwnerIdentity;
    createWorker: (journal: TelegramUpdateWorkerJournalPort, binding: TelegramUpdateAdmissionLifecycleJournalBinding) => TelegramUpdateWorkerRuntime<TContext>;
    acquireSourceReference?: (binding: TelegramUpdateAdmissionLifecycleJournalBinding) => () => void;
    recordRuntimeEvent?: TelegramUpdateWorkerRuntimeDeps<TContext>["recordRuntimeEvent"];
}
export interface TelegramUpdateAdmissionLifecycleRuntime<TContext> extends TelegramQueueAdmissionSettlementRuntime<TContext> {
    onSessionStart: (ctx: TContext) => Promise<void>;
    onSessionShutdown: () => Promise<void>;
    onTransportChanged: (ctx?: TContext) => Promise<void>;
    appendBatch: (updates: readonly TelegramJournaledUpdate[], acceptedThroughUpdateId?: number) => Pick<TelegramUpdateJournalAppendResult, "nonExcludedUpdateIds">;
    discardQueueReceipt: (input: {
        queueKind: "prompt" | "control";
        receiptId: string;
        sourceUpdateIds: readonly number[];
        expectedOwner: TelegramUpdateJournalQueueOwner;
    }) => TelegramUpdateJournalQueueDiscardResult;
    recoverDeadQueueReceipt: (input: {
        queueKind: "prompt" | "control";
        receiptId: string;
        sourceUpdateIds: readonly number[];
        deadOwner: TelegramUpdateJournalQueueOwner;
        recoveryOwner: TelegramUpdateJournalQueueOwnerIdentity;
    }) => TelegramUpdateJournalDeadQueueOwnerRecoveryResult;
    offerQueueReceiptHandoff: (input: TelegramUpdateJournalQueueHandoffInput) => TelegramUpdateJournalQueueHandoffOfferResult;
    acceptQueueReceiptHandoff: (input: TelegramUpdateJournalQueueHandoffInput) => TelegramUpdateJournalQueueHandoffAcceptResult;
    cancelQueueReceiptHandoff: (input: TelegramUpdateJournalQueueHandoffInput) => TelegramUpdateJournalQueueHandoffCancelResult;
    publishAcceptedQueueReceipt: (input: {
        receipt: TelegramQueueAdmissionReceiptLike;
        queueOwner: TelegramUpdateJournalQueueOwner;
        ctx: TContext;
    }) => Promise<void>;
    getQueueReceiptOwner: (receipt: TelegramQueueAdmissionReceiptLike) => TelegramUpdateJournalQueueOwner | undefined;
    getJournalBindingKey: () => string | undefined;
    getJournalPath: () => string | undefined;
    ownsJournalBinding: (journalBindingKey: string) => boolean;
    getJournalEntryCount: () => number;
    getForeignQueueOwnerLiveness: () => TelegramProcessLiveness | undefined;
    hasPendingQueueMutationForItem: (item: TelegramQueueMutationDependencyItem) => boolean;
    signal: () => void;
    getState: () => TelegramUpdateWorkerStateSnapshot | undefined;
}
export interface TelegramUpdateWorkerOwnerRuntime<TContext> {
    getQueueOwnerIdentity: () => TelegramUpdateJournalQueueOwnerIdentity;
    onQueueReceiptCommitted: (receipt: unknown, ctx: TContext) => void;
    onUpdateCompleted: (updateId: number, ctx: TContext) => void;
}
export interface TelegramUpdateWorkerOwnerRuntimeDeps<TContext> {
    instanceId: string;
    processId: number;
    processBirthId: string;
    getSessionGeneration: () => number;
    isContextCurrent: (ctx: TContext) => boolean;
    dispatchNext: (ctx: TContext) => void;
    requestQueueHandoffReconciliation: (ctx: TContext) => void;
    afterUpdateCompleted?: (updateId: number) => void;
}
export declare function createTelegramUpdateWorkerOwnerRuntime<TContext>(deps: TelegramUpdateWorkerOwnerRuntimeDeps<TContext>): TelegramUpdateWorkerOwnerRuntime<TContext>;
export interface TelegramUpdateAdmissionRuntimeBinding<TContext> {
    bind: (input: {
        leader: TelegramUpdateAdmissionLifecycleRuntime<TContext>;
        follower: TelegramUpdateAdmissionLifecycleRuntime<TContext>;
        inputCustodyBus?: TelegramInputCustodyBusBindingRuntime<TContext>;
    }) => void;
    getLeader: () => TelegramUpdateAdmissionLifecycleRuntime<TContext> | undefined;
    getFollower: () => TelegramUpdateAdmissionLifecycleRuntime<TContext> | undefined;
    getActive: () => TelegramUpdateAdmissionLifecycleRuntime<TContext> | undefined;
    getSettlement: () => TelegramQueueAdmissionSettlementRuntime<TContext> | undefined;
    getInputCustodyBus: () => TelegramInputCustodyBusBindingRuntime<TContext> | undefined;
    getLifecycleForJournalBinding: (journalBindingKey: string) => TelegramUpdateAdmissionLifecycleRuntime<TContext> | undefined;
    hasPendingQueueMutationForItem: (item: TelegramQueueMutationDependencyItem) => boolean;
    onSessionShutdown: () => Promise<void>;
}
export declare function createTelegramUpdateAdmissionRuntimeBinding<TContext>(deps: {
    isFollowerRegistered: () => boolean;
}): TelegramUpdateAdmissionRuntimeBinding<TContext>;
/** Own one worker per active transport identity without assuming queued-owner death. */
export declare function createTelegramUpdateAdmissionLifecycleRuntime<TContext>(deps: TelegramUpdateAdmissionLifecycleRuntimeDeps<TContext>): TelegramUpdateAdmissionLifecycleRuntime<TContext>;
export interface TelegramUpdateAdmissionLifecycleAssembly<TContext> {
    leader: TelegramUpdateAdmissionLifecycleRuntime<TContext>;
    follower: TelegramUpdateAdmissionLifecycleRuntime<TContext>;
}
export interface TelegramUpdateAdmissionLifecycleAssemblyDeps<TUpdate extends TelegramJournaledUpdate & TelegramUpdateFlow, TContext> {
    runtimeBinding: TelegramUpdateAdmissionRuntimeBinding<TContext>;
    inputCustodyBus?: TelegramInputCustodyBusBindingRuntime<TContext>;
    acquireSourceReference?: (role: "leader" | "follower", binding: TelegramUpdateAdmissionLifecycleJournalBinding) => () => void;
    worker: Omit<TelegramUpdateAdmissionWorkerRuntimeDeps<TUpdate, TContext>, "journal" | "getJournalBindingKey" | "getRecipientBindingKey" | "hasAuthority" | "prepareUpdateForExecution">;
    leader: {
        resolveBinding: () => TelegramUpdateAdmissionLifecycleJournalBinding | undefined;
        hasAuthority: (ctx: TContext) => boolean;
    };
    follower: {
        resolveBinding: () => TelegramUpdateAdmissionLifecycleJournalBinding | undefined;
        isRegistered: () => boolean;
        getGeneration: () => string | undefined;
        prepareUpdateForExecution: (update: TUpdate) => TUpdate;
    };
    recordRuntimeEvent?: TelegramUpdateWorkerRuntimeDeps<TContext>["recordRuntimeEvent"];
}
export type TelegramUpdateAdmissionWorkerRuntimeDeps<TUpdate extends TelegramJournaledUpdate & TelegramUpdateFlow, TContext> = Omit<TelegramUpdateWorkerRuntimeDeps<TContext>, "executeUpdate" | "executeCustodiedUpdate"> & {
    inputCustody?: TelegramCustodyExecutionJournal;
    defaultHandle: (update: TUpdate, ctx: TContext, execution?: TelegramUpdateExecutionFence) => Promise<void>;
    prepareUpdateForExecution?: (update: TUpdate) => TUpdate;
    registry?: TelegramUpdateHandlerRegistry;
};
/** Compose source-bound routing and late grouped settlement under one worker. */
export declare function createTelegramUpdateAdmissionWorkerRuntime<TUpdate extends TelegramJournaledUpdate & TelegramUpdateFlow, TContext>(deps: TelegramUpdateAdmissionWorkerRuntimeDeps<TUpdate, TContext>): TelegramUpdateWorkerRuntime<TContext>;
/** Own leader/follower journal lifecycle construction and generation fencing. */
export declare function createTelegramUpdateAdmissionLifecycleAssembly<TUpdate extends TelegramJournaledUpdate & TelegramUpdateFlow, TContext>(deps: TelegramUpdateAdmissionLifecycleAssemblyDeps<TUpdate, TContext>): TelegramUpdateAdmissionLifecycleAssembly<TContext>;
export interface TelegramUpdateAdmissionRuntimeAssembly<TContext> extends TelegramUpdateAdmissionLifecycleAssembly<TContext> {
    owner: TelegramUpdateWorkerOwnerRuntime<TContext>;
}
export type TelegramUpdateAdmissionRuntimeAssemblyDeps<TUpdate extends TelegramJournaledUpdate & TelegramUpdateFlow, TContext> = Omit<TelegramUpdateAdmissionLifecycleAssemblyDeps<TUpdate, TContext>, "worker" | "recordRuntimeEvent"> & {
    owner: TelegramUpdateWorkerOwnerRuntimeDeps<TContext>;
    worker: Omit<TelegramUpdateAdmissionLifecycleAssemblyDeps<TUpdate, TContext>["worker"], keyof TelegramUpdateWorkerOwnerRuntime<TContext> | "isContextCurrent" | "recordRuntimeEvent">;
    recordRuntimeEvent?: TelegramUpdateWorkerRuntimeDeps<TContext>["recordRuntimeEvent"];
};
/** Own queue-owner projection and shared leader/follower worker composition. */
export declare function createTelegramUpdateAdmissionRuntimeAssembly<TUpdate extends TelegramJournaledUpdate & TelegramUpdateFlow, TContext>(deps: TelegramUpdateAdmissionRuntimeAssemblyDeps<TUpdate, TContext>): TelegramUpdateAdmissionRuntimeAssembly<TContext>;
/**
 * Register a handler that runs before pi-telegram routes a Telegram update
 * through its built-in handlers.
 *
 * This is the low-level public surface for extensions that share the same bot
 * and Pi process with pi-telegram.
 */
export declare function registerTelegramUpdateHandler(handler: TelegramUpdateHandler): () => void;
export {};
