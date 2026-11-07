/**
 * Telegram updates domain helpers
 * Zones: telegram inbound, authorization, routing plans
 * Owns update extraction, authorization, execution planning, generation-fenced journal draining, and the public update-handler registry
 */
import type { TelegramBusEnvelope, TelegramBusFollowerView, TelegramBusForeignUpdateSettlement, TelegramBusFollowerQueueHandoffOffer, TelegramBusForwardOwnership, TelegramBusLeaderQueueHandoffOffer } from "./bus.ts";
import { type TelegramAuthorizationState, type TelegramUserPairingRuntimeDeps } from "./config.ts";
import { TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION, TELEGRAM_UPDATE_JOURNAL_EXCLUSION_VERSION, TELEGRAM_UPDATE_JOURNAL_VERSION, type TelegramOrdinaryV4InputCandidate, type TelegramJournalPrivateTextReplyDestination, type TelegramInputJournalReceipt, type TelegramInputJournalSourceReference, type TelegramInputJournalStore, type TelegramJournaledUpdate, type TelegramRoutingInputExpiryResult, type TelegramRoutingInputJournal, type TelegramUpdateJournalAppendResult, type TelegramUpdateJournalDeadQueueOwnerRecoveryResult, type TelegramUpdateJournalEntry, type TelegramUpdateJournalEntryDigest, type TelegramUpdateJournalInputClaim, type TelegramUpdateJournalOperatorDispositionInput, type TelegramUpdateJournalOperatorDispositionResult, type TelegramUpdateJournalPendingAbandonmentInput, type TelegramUpdateJournalPendingAbandonmentResult, type TelegramUpdateJournalPendingRetentionEvidence, type TelegramUpdateJournalQueueDiscardResult, type TelegramUpdateJournalQueueHandoffAcceptResult, type TelegramUpdateJournalQueueHandoffCancelResult, type TelegramUpdateJournalQueueHandoffInput, type TelegramUpdateJournalQueueHandoffOfferResult, type TelegramUpdateJournalQueueOwner, type TelegramUpdateJournalQueueOwnerIdentity, type TelegramUpdateJournalQueuedCompletion, type TelegramUpdateJournalQueuedReceiptEvidence, type TelegramUpdateJournalRoutingChooser, type TelegramUpdateJournalRoutingInput, type TelegramUpdateJournalSourceCompletion } from "./journal.ts";
import type { TelegramMessageOwnershipStore } from "./ownership.ts";
import type { TelegramProcessLiveness } from "./process-identity.ts";
import { type PendingTelegramControlItem, type TelegramControlQueueHandoffPayload, type TelegramQueueAdmissionReceipt, type TelegramQueueHandoffPayload, type TelegramQueueHandoffStageResult, type TelegramQueueHandoffStagingRuntime, type TelegramQueueItem, type TelegramQueueReactionDisposition } from "./queue.ts";
import { type TelegramTarget } from "./target.ts";
export type TelegramPrivateTextReplyClassification = {
    kind: "not-private" | "unavailable" | "foreign-unavailable";
} | {
    kind: "local";
    requestNonce: string;
    assertCurrent: () => void;
} | {
    kind: "foreign";
    botId: number;
    destination: Omit<TelegramJournalPrivateTextReplyDestination, "profile" | "botIdentity" | "operatorUserId">;
    assertCurrent: () => void;
};
export type TelegramPrivateTextReplyClassifier = (message: unknown, assertSource: () => void) => TelegramPrivateTextReplyClassification;
export type { TelegramPrivateTextReplyPreparationSource } from "./journal.ts";
export type { TelegramPrivateTextReplyAcceptanceCandidate, TelegramPrivateTextReplyReceiverSelector } from "./journal.ts";
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
}];
export declare const TELEGRAM_STEER_REACTIONS: readonly [{
    readonly id: 14;
    readonly name: "fire";
    readonly emoji: "🔥";
}];
export declare const TELEGRAM_REMOVAL_REACTIONS: readonly [{
    readonly id: 20;
    readonly name: "dislike";
    readonly emoji: "👎";
}];
export declare const TELEGRAM_PRIORITY_REACTION_EMOJIS: "👍"[];
export declare const TELEGRAM_REMOVAL_REACTION_EMOJIS: "👎"[];
export interface TelegramUpdateDeletion {
    deleted_business_messages?: {
        message_ids?: unknown;
    };
}
export declare function normalizeTelegramReactionEmoji(emoji: string): string;
export declare function collectTelegramReactionEmojis(reactions: TelegramReactionType[]): Set<string>;
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
    /** Text sent together with a photo, document or other media. */
    caption?: string;
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
        /** Local issuance/ACK fence; implementations must not serialize it into payloads. */
        assertAuthority?: () => void;
    }) => Promise<TelegramBusForeignUpdateSettlement> | TelegramBusForeignUpdateSettlement;
    forwardEditedMessage?: (input: {
        message: TMessage;
        ownership: TelegramTargetOwnershipView;
        ctx: TContext;
    }) => Promise<TelegramBusForeignUpdateSettlement> | TelegramBusForeignUpdateSettlement;
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
    expectedSource?: TelegramDeferredSourceEvidence;
} | {
    kind: "deferred";
    routingReview?: true;
} | {
    kind: "queued";
    queueKind: "prompt" | "control";
    receiptId: string;
    sourceUpdateIds: readonly number[];
};
export type TelegramDeferredUpdateAbandonmentAuthority = Pick<TelegramUpdateJournalPendingAbandonmentInput, "operatorAuthorityId" | "isCurrent">;
export interface TelegramDeferredAbandonmentRecoveryRequest {
    journalBindingKey: string;
    afterUpdateId?: number;
    isCurrent: () => boolean;
}
/** A generation-owned post-drain hint for the new-world restart; never execution, completion or deletion authority by itself. */
export interface TelegramHeldSourcePreparation<TContext> {
    ctx: TContext;
    journalBindingKey: string;
    /** Exact prepared worker owner, context, key and authority; the consumer adds its own domain fences. */
    isCurrent: () => boolean;
    signal: AbortSignal;
    /** Chooser-clock sources that must survive cold spending until their fixed expiry. */
    routingSourceIds?: readonly number[];
}
export interface TelegramDeferredAbandonmentRecoveryPage {
    sources: {
        /** Detached original evidence, not proof of current eligibility or archive integrity. */
        original: TelegramUpdateJournalEntry;
        retry: (authority: TelegramDeferredUpdateAbandonmentAuthority) => TelegramUpdateJournalPendingAbandonmentResult | undefined;
    }[];
    nextAfterUpdateId?: number;
}
type TelegramHistoricalInputPredicate = (original: TelegramUpdateJournalEntry) => boolean;
/** Read-only exact-source observation by its live worker; not an acceptance or removal grant. */
export interface TelegramDeferredSourceEvidence extends TelegramUpdateJournalEntryDigest {
    journalBindingKey: string;
    /** Supplied only after caller-owned acceptance publication; requires a durable removal ACK. */
    completionSha256?: string;
}
/** Fresh source-owner projection; the payload is copied from the retained journal, never a routed carrier. */
export interface TelegramDeferredSourceSnapshot {
    source: TelegramDeferredSourceEvidence;
    update: TelegramJournaledUpdate;
}
/** Warm exact-removal ACK plus its issuing worker lifetime; never persisted or sent over IPC. */
interface TelegramDeferredSourceCompletion {
    source: TelegramDeferredSourceEvidence;
    isCurrent(): boolean;
}
interface TelegramUpdateAdmissionBinding {
    journalBindingKey?: string;
    sourceUpdateId: number;
    report: (outcome: TelegramUpdateAdmissionOutcome) => void;
    abandon?: (authority: TelegramDeferredUpdateAbandonmentAuthority) => TelegramUpdateJournalPendingAbandonmentResult | undefined;
    armRoutingInput?: (operatorUserId: number, sourceUpdateIds: readonly number[], chooser?: TelegramUpdateJournalRoutingChooser) => TelegramUpdateJournalRoutingInput | undefined;
    /** The source's saved routing clock, including where its chooser was published. */
    getRoutingInput?: () => TelegramUpdateJournalRoutingInput | undefined;
    acquireRouting?: (select?: boolean, sourceUpdateIds?: readonly number[]) => () => void;
    inspectSource?: () => TelegramDeferredSourceEvidence | undefined;
    inspectSourceSnapshot?: () => TelegramDeferredSourceSnapshot | undefined;
    inspectCompletion?: () => TelegramDeferredSourceEvidence | undefined;
    subscribeCompletion?: (notify: () => void) => () => void;
    isSourceUnsettled?: () => boolean;
    prepareLiveInput?: (sourceUpdateIds: readonly number[], isCurrent: () => boolean, onTransferred?: () => void) => TelegramLiveDeferredInputPreparation | undefined;
    /** Internal notification after the worker's exact donor-removal ACK; never issues completion itself. */
    acknowledgeTransferred?: () => void;
    prepareQueueAdmission?: () => TelegramDeferredQueueAdmissionPreparation | undefined;
    prepareSourceCompletion?: () => Pick<TelegramDeferredSourceCompletionPreparation, "source" | "isCurrent"> | undefined;
    supportsAbandonment?: (journalBindingKey: string) => boolean;
    inspectAbandoning?: (request: TelegramDeferredAbandonmentRecoveryRequest) => TelegramDeferredAbandonmentRecoveryPage | undefined;
    inspectHistorical?: (request: TelegramDeferredAbandonmentRecoveryRequest) => TelegramDeferredAbandonmentRecoveryPage | undefined;
    isHistorical?: (matchesOriginal?: TelegramHistoricalInputPredicate) => boolean;
    isHistoricalReviewHeld?: () => boolean;
}
export type TelegramQueueAdmissionReceiptLike = TelegramQueueAdmissionReceipt;
export declare function bindTelegramUpdateAdmissionSource<TUpdate extends TelegramUpdateFlow & {
    update_id: number;
}>(update: TUpdate, report: TelegramUpdateAdmissionBinding["report"], controls?: Pick<TelegramUpdateAdmissionBinding, "journalBindingKey" | "abandon" | "armRoutingInput" | "getRoutingInput" | "acquireRouting" | "inspectSource" | "inspectSourceSnapshot" | "inspectCompletion" | "subscribeCompletion" | "isSourceUnsettled" | "acknowledgeTransferred" | "prepareLiveInput" | "prepareQueueAdmission" | "prepareSourceCompletion" | "supportsAbandonment" | "inspectAbandoning" | "inspectHistorical" | "isHistorical" | "isHistoricalReviewHeld">): TUpdate;
/**
 * Conservative read-only census: any retained entry naming this Thread, in any nested Telegram object or state,
 * is unresolved custody, except a lone button tap, which carries no input (the in-flight Cancel itself).
 * It cannot see updates still in transit before journal append.
 */
export declare function collectTelegramJournalThreadUpdateIds(entries: readonly {
    updateId: number;
    update: unknown;
}[], target: {
    chatId: number;
    threadId: number;
}): number[];
export declare function collectTelegramAdmissionSourceUpdateIds(values: readonly unknown[]): number[];
/** Internal exact callback/source namespace correlation; never an acceptance or completion grant. */
export declare function getTelegramUpdateSourceJournalBinding(value: unknown): string | undefined;
/** Observe the original journal entry, never the mutable routed carrier, through current worker authority. */
export declare function inspectTelegramDeferredSource(value: unknown): TelegramDeferredSourceEvidence | undefined;
/** Read an exact current original for peer preparation without another payload authority. */
export declare function inspectTelegramDeferredSourceSnapshot(value: unknown): TelegramDeferredSourceSnapshot | undefined;
/** Exact warm removal ACK only; reporting, source absence and a replaced worker cannot supply it. */
export declare function inspectTelegramDeferredSourceCompletion(value: unknown): TelegramDeferredSourceEvidence | undefined;
/** Warm ACK notification only; subscribers must independently recheck exact completion and recipient authority. */
export declare function subscribeTelegramDeferredSourceCompletion(value: unknown, notify: () => void): (() => void) | undefined;
/** Reuse only live bound deferred originals; raw IDs or cold/adopted input cannot mint this carrier. */
export declare function prepareTelegramLiveDeferredInput(values: readonly unknown[], isCurrent: () => boolean): TelegramLiveDeferredInputPreparation | undefined;
/** A route-owned pre-disposition acceptance publisher; wraps only this carrier, never the shared worker binding. */
export declare function bindTelegramUpdateCompletionAcceptance<TValue>(value: TValue, publish: () => TelegramDeferredSourceEvidence): TValue;
/** Report source completion; true means reported, not a durable settlement acknowledgement. */
export declare function reportTelegramUpdateCompleted(value: unknown, expectedSource?: TelegramDeferredSourceEvidence): boolean;
export declare function reportTelegramUpdateDeferred(value: unknown): boolean;
/** Exact source-bound cancellation; undefined means no eligible attempt was made. */
export declare function abandonTelegramDeferredUpdate(value: unknown, authority: TelegramDeferredUpdateAbandonmentAuthority): TelegramUpdateJournalPendingAbandonmentResult | undefined;
/** Capability for chooser publication; the eventual action still requires exact deferred authority. */
export declare function supportsTelegramDeferredAbandonment(value: unknown, journalBindingKey: string): boolean;
/** Observe protected attempts through a current carrier; the UI still owns human authorization. */
export declare function inspectTelegramAbandoningUpdates(value: unknown, request: TelegramDeferredAbandonmentRecoveryRequest): TelegramDeferredAbandonmentRecoveryPage | undefined;
/** Historical inspection is not human confirmation or permission to stop delivery. */
export declare function inspectTelegramHistoricalInputs(value: unknown, request: TelegramDeferredAbandonmentRecoveryRequest): TelegramDeferredAbandonmentRecoveryPage | undefined;
export declare function isTelegramHistoricalInput(value: unknown, matchesOriginal?: TelegramHistoricalInputPredicate): boolean;
/** Routing's last-boundary hold when ownership changed after early classification. */
export declare function reportTelegramHistoricalRoutingReview(value: unknown): boolean;
/** Arm only a positively published chooser; the journal owns the immutable hour deadline. */
export declare function armTelegramRoutingInputs(values: readonly unknown[], operatorUserId: number, chooser?: TelegramUpdateJournalRoutingChooser): TelegramUpdateJournalRoutingInput | undefined;
/** A routed carrier's saved routing clock; a revived chooser reuses its recorded message. */
export declare function getTelegramUpdateRoutingInput(value: unknown): TelegramUpdateJournalRoutingInput | undefined;
/** Reserve source execution; an actual choice must also freeze its durable TTL before any effect. */
export declare function acquireTelegramUpdateRouting(value: unknown, select?: boolean, sourceUpdateIds?: readonly number[]): () => void;
/** Capture existing warm completion authority; only explicit reporting may dispose this exact original. */
export declare function prepareTelegramDeferredSourceCompletion(value: unknown): TelegramDeferredSourceCompletionPreparation | undefined;
/** Read-only warm owner availability; no source freeze, admission, report or receipt reconstruction. */
export declare function prepareTelegramDeferredQueueAdmission(value: unknown): TelegramDeferredQueueAdmissionPreparation | undefined;
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
/** Ownership lookups and authorized-update handlers shared by the per-update runtime and its controller. */
export interface TelegramUpdateHandlerPorts<TContext, TCallbackQuery extends TelegramCallbackQuery, TMessage extends TelegramUpdateMessage> {
    getCurrentInstanceId?: () => string | undefined;
    getMessageOwnership?: TelegramMessageOwnershipLookup;
    getTargetOwnership?: TelegramTargetOwnershipLookup;
    recordMessageOwnership?: TelegramMessageOwnershipRecorder;
    removePendingMediaGroupMessages: (messageIds: number[]) => void;
    pairTelegramUserIfNeeded: (userId: number, ctx: TContext, assertExecutionCurrent?: () => void) => Promise<boolean>;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    answerGuestQuery: (guestQueryId: string, text?: string, options?: Pick<TelegramUnauthorizedReplyOptions, "parseMode">) => Promise<void>;
    handleAuthorizedTelegramCallbackQuery: (query: TCallbackQuery, ctx: TContext) => Promise<void>;
    sendTextReply: (chatId: number, replyToMessageId: number, text: string, options?: TelegramUnauthorizedReplyOptions) => Promise<number | undefined>;
    /** Private Delivery replies run after sender admission and before any ordinary ownership/routing/input lane. */
    handleAuthorizedTelegramDeliveryReply?: (message: TMessage, ctx: TContext, edited: boolean) => Promise<boolean>;
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
export interface TelegramUpdateRuntimeDeps<TContext = unknown, TReactionUpdate extends TelegramMessageReactionUpdated = TelegramMessageReactionUpdated, TCallbackQuery extends TelegramCallbackQuery = TelegramCallbackQuery, TMessage extends TelegramUpdateMessage = TelegramUpdateMessage> extends TelegramUpdateHandlerPorts<TContext, TCallbackQuery, TMessage> {
    ctx: TContext;
    execution?: TelegramUpdateExecutionFence;
    foreignOwnedUpdateForwarder?: TelegramForeignOwnedUpdateForwarder<TContext, TReactionUpdate, TCallbackQuery, TMessage>;
    /** Test seam for the early spinner release of a slow forwarded callback; defaults to 1.5 s. */
    foreignCallbackReleaseMs?: number;
    removeQueuedTelegramTurnsByMessageIds: (messageIds: number[], ctx: TContext) => number;
    handleAuthorizedTelegramReactionUpdate: (reactionUpdate: TReactionUpdate, ctx: TContext) => Promise<void>;
}
export interface TelegramUpdateRuntimeControllerDeps<TContext = unknown, TCallbackQuery extends TelegramCallbackQuery = TelegramCallbackQuery, TMessage extends TelegramUpdateMessage = TelegramUpdateMessage> extends TelegramUpdateHandlerPorts<TContext, TCallbackQuery, TMessage> {
    getAllowedUserId: () => number | undefined;
    foreignOwnedUpdateForwarder?: TelegramForeignOwnedUpdateForwarder<TContext, TelegramMessageReactionUpdated, TCallbackQuery, TMessage>;
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
    /** Protected cancellation attempts, not proof of a committed discard. */
    abandoningClaimCount?: number;
    /** Historical sources held before routing, not evidence of prior non-delivery. */
    historicalClaimCount?: number;
    /** Fresh recipient inputs reserved before append; not executable prompt-queue work. */
    preparedInputCount?: number;
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
        routingInput?: TelegramUpdateJournalRoutingInput;
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
export interface TelegramRoutingInputExpirySource {
    original: TelegramUpdateJournalEntry;
    journalBindingKey: string;
    isCurrent(): boolean;
    expire(): TelegramRoutingInputExpiryResult | undefined;
}
export interface TelegramUpdateWorkerJournalPort {
    routingInputs?: TelegramRoutingInputJournal;
    read: () => TelegramUpdateWorkerJournalSnapshot;
    inspectPendingRetention?: (entry: TelegramUpdateJournalEntry) => TelegramUpdateJournalPendingRetentionEvidence | undefined;
    abandonPending?: (input: TelegramUpdateJournalPendingAbandonmentInput) => TelegramUpdateJournalPendingAbandonmentResult;
    /** Optional strict observation; it must not recover, repair or grant new receipt authority. */
    isQueueReceiptCurrent?: (receipt: TelegramQueueAdmissionReceiptLike, owner: TelegramUpdateJournalQueueOwner) => boolean;
    /** Strict full-group origin observation for prepared partial scopes; no writer or readiness acquisition. */
    inspectQueuedReceipt?: (expected: TelegramUpdateJournalQueuedCompletion) => TelegramUpdateJournalQueuedReceiptEvidence | undefined;
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
    completeQueuedExact?: (receipts: readonly {
        queueKind: "prompt" | "control";
        receiptId: string;
        sourceUpdateIds: readonly number[];
        queueOwner: TelegramUpdateJournalQueueOwner;
    }[], completions: readonly TelegramUpdateJournalSourceCompletion[]) => {
        removedUpdateIds: readonly number[];
        sourceCompletions?: readonly TelegramUpdateJournalSourceCompletion[];
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
    /** No ID-only fallback is allowed for a guarded completion report. */
    removeCompletedExact?: (updateIds: readonly number[], expectedSources: readonly TelegramUpdateJournalEntryDigest[], completions?: readonly TelegramUpdateJournalSourceCompletion[], isCurrent?: () => boolean) => {
        removedUpdateIds: readonly number[];
        sourceCompletions?: readonly TelegramUpdateJournalSourceCompletion[];
    };
    inspectSourceCompletion?: (expected: TelegramUpdateJournalSourceCompletion) => TelegramUpdateJournalSourceCompletion | undefined;
}
export type TelegramQueueSourceCompletion = TelegramDeferredSourceEvidence & {
    completionSha256: string;
};
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
    executeUpdate: (update: TelegramJournaledUpdate, ctx: TContext, signal: AbortSignal, target?: TelegramTarget & {
        threadId: number;
    }) => Promise<TelegramUpdateAdmissionOutcome> | TelegramUpdateAdmissionOutcome;
    /** Native source-only binding, installed by the admission-worker assembly rather than ordinary dispatch. */
    admitPreparedLiveInput?: (update: TelegramJournaledUpdate, ctx: TContext, signal: AbortSignal) => Promise<{
        outcome: TelegramUpdateAdmissionOutcome;
        carrier: unknown;
    }>;
    executeCustodiedUpdate?: (update: TelegramJournaledUpdate, ctx: TContext, signal: AbortSignal) => Promise<TelegramCustodiedExecutionResult>;
    hasAuthority: (ctx: TContext) => boolean;
    getJournalBindingKey?: () => string | undefined;
    getRecipientBindingKey?: () => string | undefined;
    /**
     * True selects legacy historical review/spending; retain protects unsupported originals without disposition
     * authority; revive re-admits a still-waiting chooser source as this generation's live input.
     */
    shouldReviewHistoricalInput?: (entry: TelegramUpdateJournalEntry, ctx: TContext, signal: AbortSignal) => TelegramHistoricalReviewVerdict | Promise<TelegramHistoricalReviewVerdict>;
    /** New-world restart: spend unclocked classified routing input without delivery, copy or completion. Chooser clocks wait for expiry; interrupted private abandonment keeps exact recovery. */
    spendHistoricalInput?: boolean;
    /** Holds protected live or retry sources before execution; never cancels or disposes them. */
    shouldHoldPendingInput?: (entry: TelegramUpdateJournalEntry, ctx: TContext, signal: AbortSignal) => boolean | Promise<boolean>;
    getQueueOwnerIdentity?: (ctx: TContext) => TelegramUpdateJournalQueueOwnerIdentity;
    isContextCurrent?: (ctx: TContext) => boolean;
    createAbortController?: () => AbortController;
    getNowMs?: () => number;
    expireRoutingInput?: (source: TelegramRoutingInputExpirySource, ctx: TContext, signal: AbortSignal) => Promise<void> | void;
    retryPolicy?: Partial<TelegramUpdateRetryPolicy>;
    classifyExecutionFailure?: (error: unknown) => TelegramUpdateExecutionFailureClassification;
    settleTerminalExecutionFailure?: (error: unknown) => Promise<boolean>;
    scheduleRetry?: (callback: () => void, delayMs: number) => unknown;
    cancelRetry?: (handle: unknown) => void;
    batchSize?: number;
    yieldToEventLoop?: () => Promise<void>;
    onStateChange?: (state: TelegramUpdateWorkerStateSnapshot) => void;
    /** One nonblocking hint after a quiescent validated startup projection, never execution or deletion authority. */
    onHeldSourcesPrepared?: (input: TelegramHeldSourcePreparation<TContext>) => Promise<void> | void;
    /** Prepared readiness barrier after durable queue admission; never authorizes replay or source removal. */
    beforeQueueReceiptPublished?: (receipt: TelegramQueueAdmissionReceiptLike, queueOwner: TelegramUpdateJournalQueueOwner, ctx: TContext, isCurrent: () => boolean) => Promise<void | readonly TelegramQueueSourceCompletion[]> | void | readonly TelegramQueueSourceCompletion[];
    /** Post-ACK hint only; it must not request Pi dispatch or inherit a Workspace admission lease. */
    onQueueReceiptCompleted?: (receipt: TelegramQueueAdmissionReceiptLike, ctx: TContext) => void;
    onQueueReceiptCommitted?: (receipt: TelegramQueueAdmissionReceiptLike, ctx: TContext) => void;
    onUpdateCompleted?: (updateId: number, ctx: TContext, journalBindingKey?: string) => void;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export type TelegramQueueReceiptCompletionReason = "prompt-handoff" | "control-settlement" | "discard";
/** Read-only singleton hold projection; only the exact warm post-release admission carrier may supply completion. */
export interface TelegramLiveSourceCompletionReadiness {
    readonly snapshot: TelegramDeferredSourceSnapshot;
    /** Captured issuing owner/ports only; not a source disposition or canonical-release grant. */
    isCurrent(): boolean;
    bindCarrier(value: unknown): TelegramDeferredSourceCompletionPreparation | undefined;
}
/** Process-local gate for fresh recipient input; never durable replay/custody or a binding grant. */
export interface TelegramLiveInputPreparation {
    readonly sourceUpdateIds: readonly number[];
    /** Authority-only observation: no nested journal transaction under a Workspace snapshot. */
    isCurrent(): boolean;
    /** Same captured worker/source lifetime, including a finished warm preparation. */
    isOwnerCurrent(): boolean;
    confirmSaved(): boolean;
    /** Read/copy completion-owner availability after save, without claiming/admitting/dispatching the held input. */
    prepareSourceCompletion?(): TelegramLiveSourceCompletionReadiness | undefined;
    /** Captures one same-source status continuation without activating future recipient authority. */
    prepareStatusConsumption?(input: TelegramLiveStatusConsumption): boolean;
    /** Native owner availability before recipient append; not admission or future target activation. */
    canPrepareStatusConsumption?(): boolean;
    release(canRelease: () => boolean, target?: TelegramTarget & {
        threadId: number;
    }): boolean;
    /** Ends a failed pre-append attempt only when no selected input was saved. */
    cancelEmpty(): boolean;
    /** One fenced removal of this never-dispatched recipient copy; unknown issuance cannot be retried. */
    discardSaved(canDiscard: () => boolean): "discarded" | "protected" | "unknown";
}
/** Routing owns continuation or positively released peer transfer; preparation never appends or reexecutes originals. */
export interface TelegramLiveDeferredInputPreparation extends Pick<TelegramLiveInputPreparation, "sourceUpdateIds" | "isCurrent" | "isOwnerCurrent" | "confirmSaved"> {
    beginRelease(canRelease: () => boolean): boolean;
    /** One exact donor-group removal after routing confirms peer release; unknown issuance never retries. */
    settleTransferred(canSettle: () => boolean): "settled" | "protected" | "unknown";
    cancel(): boolean;
}
export interface TelegramDeferredSourceCompletionPreparation {
    readonly source: TelegramDeferredSourceEvidence;
    /** Issuer lifetime remains observable after reporting/removal; never a settled/source-absence inference. */
    isCurrent(): boolean;
    /** One exact report after required command semantics; true is report acceptance, not a removal ACK. */
    reportCompleted(): boolean;
    /** Existing warm worker ACK only, read-only and without journal I/O or another report/removal. */
    inspectCompletion(): TelegramDeferredSourceEvidence | undefined;
}
export interface TelegramDeferredQueueAdmissionPreparation {
    /** Worker/session/journal/acquiring-owner lifetime, independent of the source's later queued report. */
    isCurrent(): boolean;
    /** Only the existing warm committed receipt owner can certify the same original; absence never permits replay. */
    inspectReceipt(receipt: TelegramQueueAdmissionReceiptLike): {
        source: TelegramDeferredSourceEvidence;
        receipt: TelegramUpdateJournalQueuedCompletion;
    } | undefined;
    /** Read-only original/queued-owner CAS scope for the existing pre-publication boundary; never readiness or disposal. */
    prepareCompletionScope(receipt: TelegramQueueAdmissionReceiptLike, queueOwner: TelegramUpdateJournalQueueOwner, completionSha256: string): TelegramQueueSourceCompletion | undefined;
    /** Exact previously observed receipt object's native whole-removal ACK; never admission, absence or another disposal. */
    inspectCompletion(receipt: TelegramQueueAdmissionReceiptLike): TelegramDeferredSourceEvidence | undefined;
}
export interface TelegramUpdateWorkerRuntime<TContext> {
    start: (ctx: TContext) => void;
    /** Reserve absent IDs before recipient append; existing leader deferred sources use their original carrier. */
    prepareLiveInput?: (ctx: TContext, sourceUpdateIds: readonly number[], isCurrent?: () => boolean) => TelegramLiveInputPreparation | undefined;
    prepareDeferredLiveInput?: (input: {
        updateId: number;
        sourceUpdateIds: readonly number[];
        signal: AbortSignal;
        isCurrent(): boolean;
        onTransferred?(): void;
    }) => TelegramLiveDeferredInputPreparation | undefined;
    prepareDeferredQueueAdmission?: (input: {
        updateId: number;
        signal: AbortSignal;
    }) => TelegramDeferredQueueAdmissionPreparation | undefined;
    prepareDeferredSourceCompletion?: (input: {
        updateId: number;
        signal: AbortSignal;
    }) => Pick<TelegramDeferredSourceCompletionPreparation, "source" | "isCurrent"> | undefined;
    signal: () => void;
    settleDeferred: (input: {
        updateId: number;
        outcome: TelegramUpdateAdmissionOutcome;
        signal: AbortSignal;
    }) => void | TelegramDeferredSourceCompletion | Promise<void | TelegramDeferredSourceCompletion>;
    armRoutingInput?: (input: {
        updateId: number;
        signal: AbortSignal;
        operatorUserId: number;
        sourceUpdateIds: readonly number[];
        chooser?: TelegramUpdateJournalRoutingChooser;
    }) => TelegramUpdateJournalRoutingInput | undefined;
    selectRoutingInput?: (input: {
        updateId: number;
        signal: AbortSignal;
        operatorUserId: number;
        sourceUpdateIds: readonly number[];
    }) => boolean;
    isRoutingInputCurrent?: (input: {
        updateId: number;
        signal: AbortSignal;
    }) => boolean;
    getRoutingInput?: (input: {
        updateId: number;
        signal: AbortSignal;
    }) => TelegramUpdateJournalRoutingInput | undefined;
    supportsDeferredAbandonment?: (input: {
        updateId: number;
        signal: AbortSignal;
        journalBindingKey: string;
    }) => boolean;
    inspectAbandoning?: (input: TelegramDeferredAbandonmentRecoveryRequest & {
        signal: AbortSignal;
    }) => TelegramDeferredAbandonmentRecoveryPage | undefined;
    inspectHistorical?: (input: TelegramDeferredAbandonmentRecoveryRequest & {
        signal: AbortSignal;
    }) => TelegramDeferredAbandonmentRecoveryPage | undefined;
    inspectDeferredSource?: (input: {
        updateId: number;
        signal: AbortSignal;
    }) => TelegramDeferredSourceEvidence | undefined;
    inspectDeferredSourceSnapshot?: (input: {
        updateId: number;
        signal: AbortSignal;
    }) => TelegramDeferredSourceSnapshot | undefined;
    isHistoricalSource?: (input: {
        updateId: number;
        signal: AbortSignal;
        matchesOriginal?: TelegramHistoricalInputPredicate;
    }) => boolean;
    abandonDeferred?: (input: TelegramDeferredUpdateAbandonmentAuthority & {
        updateId: number;
        signal: AbortSignal;
    }) => TelegramUpdateJournalPendingAbandonmentResult | undefined;
    settleCustodied: (input: {
        updateId: number;
        result: TelegramCustodiedExecutionResult;
        signal: AbortSignal;
    }) => void;
    isQueueReceiptCommitted: (receipt: TelegramQueueAdmissionReceiptLike) => boolean;
    getQueueReceiptOwner: (receipt: TelegramQueueAdmissionReceiptLike) => TelegramUpdateJournalQueueOwner | undefined;
    /** Completion-only owner observation; issued attempts are never dispatch readiness. */
    getQueueReceiptSettlementOwner?: (receipt: TelegramQueueAdmissionReceiptLike, ctx: TContext, reason: TelegramQueueReceiptCompletionReason) => TelegramUpdateJournalQueueOwner | undefined;
    completeQueueReceipts: (input: {
        receipts: readonly TelegramQueueAdmissionReceiptLike[];
        ctx: TContext;
        reason: TelegramQueueReceiptCompletionReason;
        /** Prepared immutable scopes for every source; the exact receipt owner still authorizes disposal. */
        sourceCompletions?: readonly TelegramQueueSourceCompletion[];
    }) => boolean;
    stop: () => Promise<void>;
    waitForDrain: () => Promise<void>;
    getState: () => TelegramUpdateWorkerStateSnapshot;
}
export interface TelegramLiveStatusConsumption {
    readonly source: TelegramDeferredSourceEvidence;
    assertCurrent(): void;
    bindCarrier(value: unknown): boolean;
    execute(): Promise<boolean>;
}
export type TelegramHistoricalReviewVerdict = boolean | "retain" | "revive";
/** A saved chooser clock that proves an untouched, unexpired choice whose chooser message can be revived. */
export declare function isRevivableTelegramRoutingInput(entry: Pick<TelegramUpdateJournalEntry, "state" | "routingInput">, nowMs: number): boolean;
type TelegramOrdinaryV4Purpose = "continue" | "text-prompt";
declare class OrdinaryV4Execution {
    #private;
    constructor(key: symbol, purpose: TelegramOrdinaryV4Purpose, candidate: TelegramOrdinaryV4InputCandidate, message: object, assertCurrent: () => void);
    read(candidate: TelegramOrdinaryV4InputCandidate, purpose?: TelegramOrdinaryV4Purpose): object;
}
export type TelegramOrdinaryV4Execution = OrdinaryV4Execution;
export declare function readTelegramOrdinaryV4Execution(execution: TelegramOrdinaryV4Execution, candidate: TelegramOrdinaryV4InputCandidate): object;
export declare function readTelegramOrdinaryV4TextExecution(execution: TelegramOrdinaryV4Execution, candidate: TelegramOrdinaryV4InputCandidate): object;
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
export interface TelegramUpdateAdmissionHandleDeps<TUpdate extends TelegramUpdateFlow & {
    update_id: number;
}, TContext> {
    defaultHandle: (update: TUpdate, ctx: TContext, execution?: TelegramUpdateExecutionFence) => Promise<void>;
    registry?: TelegramUpdateHandlerRegistry;
    getJournalBindingKey?: () => string | undefined;
    onLateOutcome?: (outcome: TelegramUpdateAdmissionOutcome, details: {
        updateId: number;
        ctx: TContext;
        signal: AbortSignal;
    }) => void | TelegramDeferredSourceCompletion | Promise<void | TelegramDeferredSourceCompletion>;
    onLateOutcomeError?: (error: unknown, updateId: number) => void;
    abandonDeferred?: TelegramUpdateWorkerRuntime<TContext>["abandonDeferred"];
    armRoutingInput?: TelegramUpdateWorkerRuntime<TContext>["armRoutingInput"];
    selectRoutingInput?: TelegramUpdateWorkerRuntime<TContext>["selectRoutingInput"];
    isRoutingInputCurrent?: TelegramUpdateWorkerRuntime<TContext>["isRoutingInputCurrent"];
    getRoutingInput?: TelegramUpdateWorkerRuntime<TContext>["getRoutingInput"];
    supportsDeferredAbandonment?: TelegramUpdateWorkerRuntime<TContext>["supportsDeferredAbandonment"];
    inspectAbandoning?: TelegramUpdateWorkerRuntime<TContext>["inspectAbandoning"];
    inspectHistorical?: TelegramUpdateWorkerRuntime<TContext>["inspectHistorical"];
    inspectDeferredSource?: TelegramUpdateWorkerRuntime<TContext>["inspectDeferredSource"];
    inspectDeferredSourceSnapshot?: TelegramUpdateWorkerRuntime<TContext>["inspectDeferredSourceSnapshot"];
    prepareDeferredLiveInput?: TelegramUpdateWorkerRuntime<TContext>["prepareDeferredLiveInput"];
    prepareDeferredQueueAdmission?: TelegramUpdateWorkerRuntime<TContext>["prepareDeferredQueueAdmission"];
    prepareDeferredSourceCompletion?: TelegramUpdateWorkerRuntime<TContext>["prepareDeferredSourceCompletion"];
    isHistoricalSource?: TelegramUpdateWorkerRuntime<TContext>["isHistoricalSource"];
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
export interface TelegramInputCustodyHandoffAcceptanceInput {
    sourceRecoveryKey: string;
    recipientBindingKey: string;
    source: TelegramInputJournalSourceReference;
    handoffId: string;
}
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
export declare function createTelegramCustodiedExecutionSession(input: {
    journal: TelegramCustodyExecutionJournal;
    recipientBindingKey: string;
}): {
    execute(update: TelegramJournaledUpdate, handler: (update: TelegramJournaledUpdate) => Promise<TelegramUpdateAdmissionOutcome>): Promise<TelegramCustodiedExecutionResult>;
    settle(updateId: number, outcome: TelegramUpdateAdmissionOutcome): Promise<TelegramCustodiedExecutionResult>;
};
/**
 * Compose the stable public handler registry with source-bound semantic
 * admission. Production polling switches to this only with the journal worker.
 */
export declare function createTelegramUpdateAdmissionHandle<TUpdate extends TelegramUpdateFlow & {
    update_id: number;
}, TContext>(deps: TelegramUpdateAdmissionHandleDeps<TUpdate, TContext>): (update: TUpdate, ctx: TContext, signal: AbortSignal) => Promise<TelegramUpdateAdmissionOutcome>;
export declare function createTelegramCustodiedUpdateAdmissionHandle<TUpdate extends TelegramJournaledUpdate & TelegramUpdateFlow, TContext>(deps: Omit<TelegramUpdateAdmissionHandleDeps<TUpdate, TContext>, "onLateOutcome" | "onLateOutcomeError" | "abandonDeferred" | "armRoutingInput" | "getRoutingInput" | "selectRoutingInput" | "isRoutingInputCurrent" | "supportsDeferredAbandonment" | "inspectAbandoning" | "inspectHistorical" | "inspectDeferredSource" | "inspectDeferredSourceSnapshot" | "prepareDeferredLiveInput" | "prepareDeferredQueueAdmission" | "prepareDeferredSourceCompletion" | "isHistoricalSource"> & {
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
    getQueueReceiptSettlementOwner?: (receipt: TelegramQueueAdmissionReceiptLike, ctx: TContext, reason: TelegramQueueReceiptCompletionReason) => TelegramUpdateJournalQueueOwner | undefined;
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
    steerSupported?: boolean;
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
    canHandoffSteerWithRecipient?: (recipient: TelegramBusFollowerView) => boolean;
    hasPendingDispatch?: () => boolean;
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
    routeThroughLeader: (input: TelegramBusLeaderQueueHandoffOffer) => Promise<TelegramBusEnvelope>;
    removeDonorItem: (receipt: TelegramQueueAdmissionReceipt, ctx: TContext) => boolean;
    recordFailure?: (error: unknown, details: Record<string, unknown>) => void;
}
export interface TelegramQueueHandoffReconciliationRuntimeAssemblyDeps<TContext> {
    canHandoffSteerWithRecipient?: (recipient: TelegramBusFollowerView) => boolean;
    hasPendingDispatch?: () => boolean;
    ownsDirect: () => boolean;
    isFollowerRegistered: () => boolean;
    isBusEnabled: () => boolean;
    canHandoffWithLeader?: () => boolean;
    listFollowers: () => readonly TelegramBusFollowerView[];
    createRecipientJournalResolver: (profileKey: string, sessionId: string) => () => {
        recoveryKey: string;
    } | undefined;
    queueStore: {
        getQueuedItems: () => TelegramQueueItem<TContext>[];
        setQueuedItems: (items: TelegramQueueItem<TContext>[]) => void;
    };
    admission: Pick<TelegramUpdateAdmissionRuntimeBinding<TContext>, "getSettlement" | "getLifecycleForJournalBinding">;
    createHandoffToken: () => string;
    createRequestId: () => string;
    donorInstanceId: string;
    authSecret?: string;
    stageThroughFollower: (input: TelegramBusFollowerQueueHandoffOffer) => Promise<TelegramQueueHandoffStageResult>;
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
    /** Runs after the previous worker stopped and before the replacement worker exists; throwing refuses binding. */
    prepareBinding?: (binding: TelegramUpdateAdmissionLifecycleJournalBinding) => void;
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
    /** Fresh recipient input only; the leader's existing deferred original keeps its original carrier. */
    prepareLiveInput?: TelegramUpdateWorkerRuntime<TContext>["prepareLiveInput"];
    getState: () => TelegramUpdateWorkerStateSnapshot | undefined;
}
export interface TelegramUpdateWorkerOwnerRuntime<TContext> {
    getQueueOwnerIdentity: () => TelegramUpdateJournalQueueOwnerIdentity;
    onQueueReceiptCommitted: (receipt: TelegramQueueAdmissionReceiptLike, ctx: TContext) => void;
    onUpdateCompleted: (updateId: number, ctx: TContext, journalBindingKey?: string) => void;
}
export interface TelegramUpdateWorkerOwnerRuntimeDeps<TContext> {
    instanceId: string;
    processId: number;
    processBirthId: string;
    getSessionGeneration: () => number;
    isContextCurrent: (ctx: TContext) => boolean;
    dispatchNext: (ctx: TContext) => void;
    requestQueueHandoffReconciliation: (ctx: TContext) => void;
    afterQueueReceiptCommitted?: (receipt: TelegramQueueAdmissionReceiptLike, ctx: TContext) => void;
    afterUpdateCompleted?: (updateId: number, ctx: TContext, journalBindingKey?: string) => void;
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
        /** Session succession before worker creation, under the exact generation-fenced binding. */
        prepareBinding?: (binding: TelegramUpdateAdmissionLifecycleJournalBinding & {
            hasAuthority?: () => boolean;
        }) => void;
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
