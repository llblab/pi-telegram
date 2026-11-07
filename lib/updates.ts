/**
 * Telegram updates domain helpers
 * Zones: telegram inbound, authorization, routing plans
 * Owns update extraction, authorization, execution planning, generation-fenced journal draining, and the public update-handler registry
 */

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { withoutTelegramTurnReplyAnchor } from "./turns.ts";

import type {
  TelegramBusEnvelope,
  TelegramBusFollowerView,
  TelegramBusForeignUpdateSettlement,
  TelegramBusFollowerQueueHandoffOffer,
  TelegramBusForwardOwnership,
  TelegramBusLeaderQueueHandoffOffer,
} from "./bus.ts";
import {
  createTelegramUserPairingRuntime,
  getTelegramAuthorizationState,
  type TelegramAuthorizationState,
  type TelegramUserPairingRuntimeDeps,
} from "./config.ts";
import {
  TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION,
  TELEGRAM_UPDATE_JOURNAL_EXCLUSION_VERSION,
  TELEGRAM_UPDATE_JOURNAL_FAILURE_CLASS_MAX_LENGTH,
  TELEGRAM_UPDATE_JOURNAL_FAILURE_SUMMARY_MAX_LENGTH,
  TELEGRAM_UPDATE_JOURNAL_QUEUE_OWNER_ID_MAX_LENGTH,
  TELEGRAM_UPDATE_JOURNAL_VERSION,
  areTelegramUpdateJournalQueueOwnersEqual,
  createTelegramUpdateJournalEntryDigest,
  type TelegramOrdinaryV4InputCandidate,
  doesTelegramJournalUpdateNameThread,
  isTelegramJournalLoneCallbackUpdate,
  getTelegramUpdateJournalBindingPath,
  isTelegramUpdateJournalLegacyFamilyVersion,
  isTelegramUpdateJournalQueueOwnerProcess,
  parseTelegramUpdateJournalQueueOwner,
  type TelegramJournalPrivateTextReplyDestination,
  type TelegramInputJournalReceipt,
  type TelegramInputJournalSourceReference,
  type TelegramInputJournalStore,
  type TelegramJournaledUpdate,
  type TelegramRoutingInputExpiryResult,
  type TelegramRoutingInputJournal,
  type TelegramUpdateJournalAppendResult,
  type TelegramUpdateJournalDeadQueueOwnerRecoveryResult,
  type TelegramUpdateJournalEntry,
  type TelegramUpdateJournalEntryDigest,
  type TelegramUpdateJournalInputClaim,
  type TelegramUpdateJournalOperatorDispositionInput,
  type TelegramUpdateJournalOperatorDispositionResult,
  type TelegramUpdateJournalPendingAbandonmentInput,
  type TelegramUpdateJournalPendingAbandonmentResult,
  type TelegramUpdateJournalPendingRetentionEvidence,
  type TelegramUpdateJournalQueueDiscardResult,
  type TelegramUpdateJournalQueueHandoffAcceptResult,
  type TelegramUpdateJournalQueueHandoffCancelResult,
  type TelegramUpdateJournalQueueHandoffInput,
  type TelegramUpdateJournalQueueHandoffOfferResult,
  type TelegramUpdateJournalQueueOwner,
  type TelegramUpdateJournalQueueOwnerIdentity,
  type TelegramUpdateJournalQueuedCompletion,
  type TelegramUpdateJournalQueuedReceiptEvidence,
  type TelegramUpdateJournalRoutingChooser,
  type TelegramUpdateJournalRoutingInput,
  type TelegramUpdateJournalSourceCompletion,
  type TelegramUpdateJournalSnapshot,
} from "./journal.ts";
import type { TelegramMessageOwnershipStore } from "./ownership.ts";
import { isPiStaleContextError } from "./pi.ts";
import type { TelegramProcessLiveness } from "./process-identity.ts";
import {
  areTelegramQueueAdmissionReceiptsEqual,
  createTelegramQueueHandoff,
  removeTelegramQueueItemByReceipt,
  type PendingTelegramControlItem,
  type TelegramControlQueueHandoffPayload,
  type TelegramQueueAdmissionReceipt,
  type TelegramQueueHandoffPayload,
  type TelegramQueueHandoffStageResult,
  type TelegramQueueHandoffStagingRuntime,
  type TelegramQueueItem,
  type TelegramQueueReactionDisposition,
} from "./queue.ts";
import {
  createTelegramPrivateTarget,
  createTelegramThreadTarget,
  type TelegramTarget,
} from "./target.ts";
import {
  isWireRecord as isTelegramUpdateAdmissionRecord,
  isNonEmptyWireString as isTelegramUpdateAdmissionString,
} from "./wire.ts";

// --- Private single-attempt Text source ingress ---

// --- Disconnected private reply preparation ---

export type TelegramPrivateTextReplyClassification =
  | { kind: "not-private" | "unavailable" | "foreign-unavailable" }
  | { kind: "local"; requestNonce: string; assertCurrent: () => void }
  | { kind: "foreign"; botId: number;
      destination: Omit<TelegramJournalPrivateTextReplyDestination, "profile" | "botIdentity" | "operatorUserId">;
      assertCurrent: () => void };

export type TelegramPrivateTextReplyClassifier = (
  message: unknown, assertSource: () => void,
) => TelegramPrivateTextReplyClassification;

export type { TelegramPrivateTextReplyPreparationSource } from "./journal.ts";

export type { TelegramPrivateTextReplyAcceptanceCandidate, TelegramPrivateTextReplyReceiverSelector } from "./journal.ts";

// --- Extraction ---

export interface TelegramReactionTypeEmoji {
  type: "emoji";
  emoji: string;
}

export interface TelegramReactionTypeNonEmoji {
  type: string;
}

export type TelegramReactionType =
  TelegramReactionTypeEmoji | TelegramReactionTypeNonEmoji;

export const TELEGRAM_PRIORITY_REACTIONS = [
  { id: 10, name: "like", emoji: "👍" },
] as const;
export const TELEGRAM_STEER_REACTIONS = [{ id: 14, name: "fire", emoji: "🔥" }] as const;
export const TELEGRAM_REMOVAL_REACTIONS = [
  { id: 20, name: "dislike", emoji: "👎" },
] as const;
export const TELEGRAM_PRIORITY_REACTION_EMOJIS =
  TELEGRAM_PRIORITY_REACTIONS.map((reaction) => reaction.emoji);
export const TELEGRAM_REMOVAL_REACTION_EMOJIS = TELEGRAM_REMOVAL_REACTIONS.map(
  (reaction) => reaction.emoji,
);

export interface TelegramUpdateDeletion {
  deleted_business_messages?: { message_ids?: unknown };
}

export function normalizeTelegramReactionEmoji(emoji: string): string {
  return emoji.replace(/\uFE0F/g, "");
}

export function collectTelegramReactionEmojis(
  reactions: TelegramReactionType[],
): Set<string> {
  const emojis = new Set<string>();
  for (const reaction of reactions) {
    if (reaction.type === "emoji") {
      const emojiReaction = reaction as TelegramReactionTypeEmoji;
      emojis.add(normalizeTelegramReactionEmoji(emojiReaction.emoji));
    }
  }
  return emojis;
}

function getTelegramReactionEmoji(
  emojis: Set<string>,
  candidates: readonly string[],
): string | undefined {
  return candidates.find((emoji) => emojis.has(emoji));
}

function getTelegramQueueReactionTransition(
  oldReactions: TelegramReactionType[],
  newReactions: TelegramReactionType[],
): TelegramQueueReactionDisposition | undefined {
  const oldEmojis = collectTelegramReactionEmojis(oldReactions);
  const newEmojis = collectTelegramReactionEmojis(newReactions);
  // Fire selects Steer; thumbs-up beneath it does not reorder the lane. Other emoji carry no queue intent.
  const steerEmoji = TELEGRAM_STEER_REACTIONS[0].emoji;
  const oldPriorityEmoji = oldEmojis.has(steerEmoji) ? steerEmoji : getTelegramReactionEmoji(oldEmojis, TELEGRAM_PRIORITY_REACTION_EMOJIS);
  const newPriorityEmoji = newEmojis.has(steerEmoji) ? steerEmoji : getTelegramReactionEmoji(newEmojis, TELEGRAM_PRIORITY_REACTION_EMOJIS);
  const oldSuppressionEmoji = getTelegramReactionEmoji(
    oldEmojis,
    TELEGRAM_REMOVAL_REACTION_EMOJIS,
  );
  const newSuppressionEmoji = getTelegramReactionEmoji(
    newEmojis,
    TELEGRAM_REMOVAL_REACTION_EMOJIS,
  );
  if (
    oldPriorityEmoji === newPriorityEmoji &&
    oldSuppressionEmoji === newSuppressionEmoji
  ) {
    return undefined;
  }
  const transition: Extract<
    TelegramQueueReactionDisposition,
    { kind: "reaction-transition" }
  > = { kind: "reaction-transition" };
  if (oldPriorityEmoji !== newPriorityEmoji) {
    transition.priorityEmoji = newPriorityEmoji ?? null;
    if (newPriorityEmoji === steerEmoji) transition.promptLane = "steer";
  }
  if (oldSuppressionEmoji !== newSuppressionEmoji) {
    transition.suppressionEmoji = newSuppressionEmoji ?? null;
  }
  return transition;
}

// --- Routing ---

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

export interface TelegramTopicLifecycleUpdate<
  TMessage = TelegramUpdateMessage,
> {
  kind: TelegramTopicLifecycleKind;
  message: TMessage;
  target: TelegramTarget & { threadId: number };
}

export function getTelegramTopicLifecycleUpdate<
  TMessage extends TelegramUpdateMessage,
>(
  message: TMessage | undefined,
): TelegramTopicLifecycleUpdate<TMessage> | undefined {
  if (
    !message ||
    typeof message.chat.id !== "number" ||
    typeof message.message_thread_id !== "number"
  ) {
    return undefined;
  }
  const target: TelegramTarget & { threadId: number } = {
    ...createTelegramThreadTarget(message.chat.id, message.message_thread_id),
    threadId: message.message_thread_id,
  };
  if (message.forum_topic_created !== undefined) {
    return { kind: "created", message, target };
  }
  if (message.forum_topic_closed !== undefined) {
    return { kind: "closed", message, target };
  }
  if (message.forum_topic_reopened !== undefined) {
    return { kind: "reopened", message, target };
  }
  return undefined;
}

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

export function getTelegramMessageTarget(
  message: TelegramUpdateMessage,
): TelegramTarget | undefined {
  if (typeof message.chat.id !== "number") return undefined;
  return typeof message.message_thread_id === "number"
    ? createTelegramThreadTarget(message.chat.id, message.message_thread_id)
    : createTelegramPrivateTarget(message.chat.id);
}

export interface TelegramUpdateRouting {
  message?: TelegramUpdateMessage;
  edited_message?: TelegramUpdateMessage;
  callback_query?: TelegramCallbackQuery;
  guest_message?: TelegramGuestMessage;
}

export function getAuthorizedTelegramCallbackQuery(
  update: TelegramUpdateRouting,
  allowedUserId?: number,
): TelegramCallbackQuery | undefined {
  const query = update.callback_query;
  if (!query || query.from.is_bot) return undefined;
  const message = query.message;
  if (!message) return undefined;
  if (message.chat.type === "private") return query;
  return query.from.id === allowedUserId ? query : undefined;
}

function authorizeTelegramHumanMessage(
  message: TelegramUpdateMessage | undefined,
  allowedUserId: number | undefined,
): TelegramUpdateMessage | undefined {
  if (!message || !message.from || message.from.is_bot) return undefined;
  if (message.chat.type === "private") return message;
  return message.from.id === allowedUserId ? message : undefined;
}

export function getAuthorizedTelegramMessage(
  update: TelegramUpdateRouting,
  allowedUserId?: number,
): TelegramUpdateMessage | undefined {
  return authorizeTelegramHumanMessage(update.message, allowedUserId);
}

export function getAuthorizedTelegramEditedMessage(
  update: TelegramUpdateRouting,
  allowedUserId?: number,
): TelegramUpdateMessage | undefined {
  return authorizeTelegramHumanMessage(update.edited_message, allowedUserId);
}

export function getAuthorizedTelegramGuestMessage(
  update: TelegramUpdateRouting,
): TelegramGuestMessage | undefined {
  const guestMessage = update.guest_message;
  if (!guestMessage || !guestMessage.from || guestMessage.from.is_bot) {
    return undefined;
  }
  return guestMessage;
}

// --- Flow ---

export type TelegramMessageOwnershipView = TelegramBusForwardOwnership;

export type TelegramMessageOwnershipLookup = (
  chatId: number,
  messageId: number,
) => TelegramMessageOwnershipView | undefined;

export type TelegramTargetOwnershipView = TelegramBusForwardOwnership;

export type TelegramTargetOwnershipLookup = (
  target: TelegramTarget,
) => TelegramTargetOwnershipView | undefined;

export interface TelegramForeignOwnedUpdateForwarder<
  TContext,
  TReactionUpdate extends TelegramMessageReactionUpdated =
    TelegramMessageReactionUpdated,
  TCallbackQuery extends TelegramCallbackQuery = TelegramCallbackQuery,
  TMessage extends TelegramUpdateMessage = TelegramUpdateMessage,
> {
  forwardCallback?: (input: {
    query: TCallbackQuery;
    ownership: TelegramMessageOwnershipView;
    ctx: TContext;
  }) =>
    | Promise<TelegramBusForeignUpdateSettlement>
    | TelegramBusForeignUpdateSettlement;
  forwardReaction?: (input: {
    reactionUpdate: TReactionUpdate;
    ownership: TelegramMessageOwnershipView;
    ctx: TContext;
  }) =>
    | Promise<TelegramBusForeignUpdateSettlement>
    | TelegramBusForeignUpdateSettlement;
  forwardMessage?: (input: {
    message: TMessage;
    ownership: TelegramTargetOwnershipView;
    ctx: TContext;
    /** Local issuance/ACK fence; implementations must not serialize it into payloads. */
    assertAuthority?: () => void;
  }) =>
    | Promise<TelegramBusForeignUpdateSettlement>
    | TelegramBusForeignUpdateSettlement;
  forwardEditedMessage?: (input: {
    message: TMessage;
    ownership: TelegramTargetOwnershipView;
    ctx: TContext;
  }) =>
    | Promise<TelegramBusForeignUpdateSettlement>
    | TelegramBusForeignUpdateSettlement;
}

type TelegramForeignUpdateSettlementFailure =
  | Exclude<TelegramBusForeignUpdateSettlement, { status: "accepted" }>
  | {
      status: "terminal-rejected";
      failureClass: "forwarder-unavailable";
      message: string;
      sourceUpdateId?: number;
    };

class TelegramForeignUpdateSettlementError extends Error {
  readonly settlement: TelegramForeignUpdateSettlementFailure;

  constructor(
    operation: string,
    settlement: TelegramForeignUpdateSettlementFailure,
  ) {
    super(
      `Telegram ${operation} forwarding did not settle: ${settlement.failureClass}.`,
    );
    this.name = "TelegramForeignUpdateSettlementError";
    this.settlement = settlement;
  }
}

function rejectTelegramForeignUpdateSettlement(
  settlement: TelegramBusForeignUpdateSettlement | undefined,
  operation: string,
  source: unknown,
): never {
  const sourceUpdateId =
    source && typeof source === "object"
      ? Reflect.get(source, "pi_telegram_source_update_id")
      : undefined;
  const failure: TelegramForeignUpdateSettlementFailure =
    settlement && settlement.status !== "accepted"
      ? settlement
      : {
          status: "terminal-rejected",
          failureClass: "forwarder-unavailable",
          message: `Telegram ${operation} forwarding is unavailable.`,
          ...(Number.isSafeInteger(sourceUpdateId) && sourceUpdateId >= 0
            ? { sourceUpdateId }
            : {}),
        };
  throw new TelegramForeignUpdateSettlementError(operation, failure);
}

export interface TelegramMessageReactionUpdated {
  chat: { id?: number; type: string };
  user?: TelegramUser;
  actor_chat?: unknown;
  message_id: number;
  old_reaction: TelegramReactionType[];
  new_reaction: TelegramReactionType[];
}

export const TELEGRAM_INTERNAL_AGENT_MESSAGE = Symbol(
  "telegram.internalAgentMessage",
);

export interface TelegramUpdateFlow
  extends TelegramUpdateRouting, TelegramUpdateDeletion {
  message_reaction?: TelegramMessageReactionUpdated;
  [TELEGRAM_INTERNAL_AGENT_MESSAGE]?: true;
}

export type TelegramUpdateAdmissionOutcome =
  | { kind: "complete"; expectedSource?: TelegramDeferredSourceEvidence }
  | { kind: "deferred"; routingReview?: true }
  | {
      kind: "queued";
      queueKind: "prompt" | "control";
      receiptId: string;
      sourceUpdateIds: readonly number[];
    };

type TelegramQueuedUpdateAdmissionOutcome = Extract<
  TelegramUpdateAdmissionOutcome,
  { kind: "queued" }
>;

const TELEGRAM_UPDATE_ADMISSION_BINDING = Symbol(
  "telegram.update-admission.binding",
);

export type TelegramDeferredUpdateAbandonmentAuthority = Pick<
  TelegramUpdateJournalPendingAbandonmentInput,
  "operatorAuthorityId" | "isCurrent"
>;

export interface TelegramDeferredAbandonmentRecoveryRequest {
  journalBindingKey: string;
  afterUpdateId?: number;
  isCurrent: () => boolean;
}

const TELEGRAM_HELD_SOURCE_INSPECTION_LIMIT = 20;

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
    retry: (
      authority: TelegramDeferredUpdateAbandonmentAuthority,
    ) => TelegramUpdateJournalPendingAbandonmentResult | undefined;
  }[];
  nextAfterUpdateId?: number;
}

type TelegramHistoricalInputPredicate = (
  original: TelegramUpdateJournalEntry,
) => boolean;

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
  abandon?: (
    authority: TelegramDeferredUpdateAbandonmentAuthority,
  ) => TelegramUpdateJournalPendingAbandonmentResult | undefined;
  armRoutingInput?: (
    operatorUserId: number,
    sourceUpdateIds: readonly number[],
    chooser?: TelegramUpdateJournalRoutingChooser,
  ) => TelegramUpdateJournalRoutingInput | undefined;
  /** The source's saved routing clock, including where its chooser was published. */
  getRoutingInput?: () => TelegramUpdateJournalRoutingInput | undefined;
  acquireRouting?: (
    select?: boolean,
    sourceUpdateIds?: readonly number[],
  ) => () => void;
  inspectSource?: () => TelegramDeferredSourceEvidence | undefined;
  inspectSourceSnapshot?: () => TelegramDeferredSourceSnapshot | undefined;
  inspectCompletion?: () => TelegramDeferredSourceEvidence | undefined;
  subscribeCompletion?: (notify: () => void) => () => void;
  isSourceUnsettled?: () => boolean;
  prepareLiveInput?: (
    sourceUpdateIds: readonly number[],
    isCurrent: () => boolean,
    onTransferred?: () => void,
  ) => TelegramLiveDeferredInputPreparation | undefined;
  /** Internal notification after the worker's exact donor-removal ACK; never issues completion itself. */
  acknowledgeTransferred?: () => void;
  prepareQueueAdmission?: () =>
    TelegramDeferredQueueAdmissionPreparation | undefined;
  prepareSourceCompletion?: () =>
    | Pick<TelegramDeferredSourceCompletionPreparation, "source" | "isCurrent">
    | undefined;
  supportsAbandonment?: (journalBindingKey: string) => boolean;
  inspectAbandoning?: (
    request: TelegramDeferredAbandonmentRecoveryRequest,
  ) => TelegramDeferredAbandonmentRecoveryPage | undefined;
  inspectHistorical?: (
    request: TelegramDeferredAbandonmentRecoveryRequest,
  ) => TelegramDeferredAbandonmentRecoveryPage | undefined;
  isHistorical?: (
    matchesOriginal?: TelegramHistoricalInputPredicate,
  ) => boolean;
  isHistoricalReviewHeld?: () => boolean;
}

export type TelegramQueueAdmissionReceiptLike = TelegramQueueAdmissionReceipt;

function bindTelegramUpdateAdmissionCarrier<TValue>(
  value: TValue | undefined,
  binding: TelegramUpdateAdmissionBinding,
): TValue | undefined {
  if (!value || typeof value !== "object") return value;
  return {
    ...(value as Record<PropertyKey, unknown>),
    pi_telegram_source_update_id: binding.sourceUpdateId,
    [TELEGRAM_UPDATE_ADMISSION_BINDING]: binding,
  } as TValue;
}

function getTelegramUpdateAdmissionBinding(
  value: unknown,
): TelegramUpdateAdmissionBinding | undefined {
  if (!value || typeof value !== "object") return undefined;
  const binding = Reflect.get(value, TELEGRAM_UPDATE_ADMISSION_BINDING) as
    TelegramUpdateAdmissionBinding | undefined;
  return binding &&
    Number.isSafeInteger(binding.sourceUpdateId) &&
    binding.sourceUpdateId >= 0 &&
    typeof binding.report === "function"
    ? binding
    : undefined;
}

export function bindTelegramUpdateAdmissionSource<
  TUpdate extends TelegramUpdateFlow & { update_id: number },
>(
  update: TUpdate,
  report: TelegramUpdateAdmissionBinding["report"],
  controls?: Pick<
    TelegramUpdateAdmissionBinding,
    | "journalBindingKey"
    | "abandon"
    | "armRoutingInput"
    | "getRoutingInput"
    | "acquireRouting"
    | "inspectSource"
    | "inspectSourceSnapshot"
    | "inspectCompletion"
    | "subscribeCompletion"
    | "isSourceUnsettled"
    | "acknowledgeTransferred"
    | "prepareLiveInput"
    | "prepareQueueAdmission"
    | "prepareSourceCompletion"
    | "supportsAbandonment"
    | "inspectAbandoning"
    | "inspectHistorical"
    | "isHistorical"
    | "isHistoricalReviewHeld"
  >,
): TUpdate {
  if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) {
    throw new TelegramUpdateAdmissionOutcomeError(
      "Telegram update admission requires a safe update_id.",
    );
  }
  const binding: TelegramUpdateAdmissionBinding = {
    sourceUpdateId: update.update_id,
    report,
    ...controls,
  };
  const callbackQuery = update.callback_query
    ? bindTelegramUpdateAdmissionCarrier(
        {
          ...update.callback_query,
          message: bindTelegramUpdateAdmissionCarrier(
            update.callback_query.message,
            binding,
          ),
        },
        binding,
      )
    : undefined;
  return {
    ...update,
    ...(update.message
      ? { message: bindTelegramUpdateAdmissionCarrier(update.message, binding) }
      : {}),
    ...(update.edited_message
      ? {
          edited_message: bindTelegramUpdateAdmissionCarrier(
            update.edited_message,
            binding,
          ),
        }
      : {}),
    ...(callbackQuery ? { callback_query: callbackQuery } : {}),
    ...(update.guest_message
      ? {
          guest_message: bindTelegramUpdateAdmissionCarrier(
            update.guest_message,
            binding,
          ),
        }
      : {}),
    ...(update.message_reaction
      ? {
          message_reaction: bindTelegramUpdateAdmissionCarrier(
            update.message_reaction,
            binding,
          ),
        }
      : {}),
  } as TUpdate;
}

/**
 * Conservative read-only census: any retained entry naming this Thread, in any nested Telegram object or state,
 * is unresolved custody, except a lone button tap, which carries no input (the in-flight Cancel itself).
 * It cannot see updates still in transit before journal append.
 */
export function collectTelegramJournalThreadUpdateIds(
  entries: readonly { updateId: number; update: unknown }[],
  target: { chatId: number; threadId: number },
): number[] {
  return entries
    .filter(
      (entry) =>
        doesTelegramJournalUpdateNameThread(entry.update, target) &&
        !isTelegramJournalLoneCallbackUpdate(entry.update),
    )
    .map((entry) => entry.updateId)
    .sort((left, right) => left - right);
}

export function collectTelegramAdmissionSourceUpdateIds(
  values: readonly unknown[],
): number[] {
  const sourceUpdateIds = new Set<number>();
  for (const value of values) {
    const binding = getTelegramUpdateAdmissionBinding(value);
    if (binding) sourceUpdateIds.add(binding.sourceUpdateId);
  }
  return [...sourceUpdateIds].sort((left, right) => left - right);
}

/** Internal exact callback/source namespace correlation; never an acceptance or completion grant. */
export function getTelegramUpdateSourceJournalBinding(value: unknown): string | undefined {
  return getTelegramUpdateExecutionFence(value)?.isCurrent() === true
    ? getTelegramUpdateAdmissionBinding(value)?.journalBindingKey : undefined;
}

/** Observe the original journal entry, never the mutable routed carrier, through current worker authority. */
export function inspectTelegramDeferredSource(
  value: unknown,
): TelegramDeferredSourceEvidence | undefined {
  const execution = getTelegramUpdateExecutionFence(value);
  if (execution?.isCurrent() !== true) return undefined;
  return getTelegramUpdateAdmissionBinding(value)?.inspectSource?.();
}

/** Read an exact current original for peer preparation without another payload authority. */
export function inspectTelegramDeferredSourceSnapshot(
  value: unknown,
): TelegramDeferredSourceSnapshot | undefined {
  const execution = getTelegramUpdateExecutionFence(value);
  if (execution?.isCurrent() !== true) return undefined;
  const snapshot =
    getTelegramUpdateAdmissionBinding(value)?.inspectSourceSnapshot?.();
  return execution.isCurrent() ? snapshot : undefined;
}

/** Exact warm removal ACK only; reporting, source absence and a replaced worker cannot supply it. */
export function inspectTelegramDeferredSourceCompletion(
  value: unknown,
): TelegramDeferredSourceEvidence | undefined {
  const execution = getTelegramUpdateExecutionFence(value);
  if (execution?.isCurrent() !== true) return undefined;
  const source =
    getTelegramUpdateAdmissionBinding(value)?.inspectCompletion?.();
  return execution.isCurrent() && source ? { ...source } : undefined;
}

/** Warm ACK notification only; subscribers must independently recheck exact completion and recipient authority. */
export function subscribeTelegramDeferredSourceCompletion(value: unknown, notify: () => void): (() => void) | undefined {
  const execution = getTelegramUpdateExecutionFence(value);
  if (execution?.isCurrent() !== true) return undefined;
  return getTelegramUpdateAdmissionBinding(value)?.subscribeCompletion?.(() => {
    if (execution.isCurrent()) notify();
  });
}

/** Reuse only live bound deferred originals; raw IDs or cold/adopted input cannot mint this carrier. */
export function prepareTelegramLiveDeferredInput(
  values: readonly unknown[],
  isCurrent: () => boolean,
): TelegramLiveDeferredInputPreparation | undefined {
  const carriers = [...values],
    first = carriers[0],
    execution = getTelegramUpdateExecutionFence(first);
  const ids = collectTelegramAdmissionSourceUpdateIds(carriers);
  if (
    !execution ||
    ids.length !== carriers.length ||
    !ids.length ||
    !isCurrent() ||
    carriers.some(
      (value) =>
        getTelegramUpdateExecutionFence(value)?.signal !== execution.signal ||
        getTelegramUpdateExecutionFence(value)?.isCurrent() !== true,
    )
  )
    return undefined;
  const bindings = carriers.map(getTelegramUpdateAdmissionBinding);
  const acknowledgers = bindings.map(binding => binding?.acknowledgeTransferred);
  const bindingsCurrent = () => carriers.every((value, index) =>
    getTelegramUpdateAdmissionBinding(value) === bindings[index] && bindings[index]?.acknowledgeTransferred === acknowledgers[index]);
  const unsettled = () => bindingsCurrent() && bindings.every(binding => binding?.isSourceUnsettled?.() === true);
  if (!unsettled()) return undefined;
  let transferred = false;
  const prepared = getTelegramUpdateAdmissionBinding(first)?.prepareLiveInput?.(
    ids,
    () =>
      bindingsCurrent() && isCurrent() &&
      carriers.every(
        (value) => getTelegramUpdateExecutionFence(value)?.isCurrent() === true,
      ),
    () => {
      transferred = true;
      for (let index = 0; index < bindings.length; index++) acknowledgers[index]?.call(bindings[index]);
    },
  );
  return (
    prepared && {
      ...prepared,
      isCurrent: () => unsettled() && prepared.isCurrent(),
      confirmSaved: () => unsettled() && prepared.confirmSaved(),
      beginRelease: (canRelease) =>
        unsettled() && prepared.beginRelease(() => unsettled() && canRelease()),
      settleTransferred: (canSettle) =>
        unsettled()
          ? prepared.settleTransferred(() => (transferred || unsettled()) && canSettle())
          : "protected",
      cancel: () => unsettled() && prepared.cancel(),
    }
  );
}

/** A route-owned pre-disposition acceptance publisher; wraps only this carrier, never the shared worker binding. */
export function bindTelegramUpdateCompletionAcceptance<TValue>(
  value: TValue,
  publish: () => TelegramDeferredSourceEvidence,
): TValue {
  const binding = getTelegramUpdateAdmissionBinding(value);
  if (
    !binding ||
    getTelegramUpdateExecutionFence(value)?.isCurrent() !== true
  ) {
    throw new TelegramUpdateAdmissionOutcomeError(
      "Telegram completion acceptance requires a live source carrier.",
    );
  }
  let retained: TelegramDeferredSourceEvidence | undefined;
  let queued = false;
  const scoped: TelegramUpdateAdmissionBinding = {
    ...binding,
    report(outcome) {
      if (outcome.kind !== "complete") {
        if (outcome.kind === "queued") queued = true;
        binding.report(outcome);
        return;
      }
      assertTelegramUpdateExecutionCurrent(value);
      // A command's trailing implicit completion cannot dispose receipt-owned or uncertain queued work.
      if (queued) {
        if (outcome.expectedSource)
          throw new TelegramUpdateAdmissionOutcomeError(
            "Telegram completion acceptance cannot dispose a queued source.",
          );
        return;
      }
      if (!retained) {
        const published = validateTelegramUpdateAdmissionOutcome(
          { kind: "complete", expectedSource: publish() },
          binding.sourceUpdateId,
          new Set([binding.sourceUpdateId]),
        );
        if (
          published.kind !== "complete" ||
          !published.expectedSource?.completionSha256
        ) {
          throw new TelegramUpdateAdmissionOutcomeError(
            "Telegram completion acceptance lacks its scoped journal proof.",
          );
        }
        retained = published.expectedSource;
      }
      assertTelegramUpdateExecutionCurrent(value);
      if (
        outcome.expectedSource &&
        (outcome.expectedSource.updateId !== retained.updateId ||
          outcome.expectedSource.journalBindingKey !==
            retained.journalBindingKey ||
          outcome.expectedSource.sourceSha256 !== retained.sourceSha256 ||
          (outcome.expectedSource.completionSha256 !== undefined &&
            outcome.expectedSource.completionSha256 !==
              retained.completionSha256))
      ) {
        throw new TelegramUpdateAdmissionOutcomeError(
          "Telegram completion acceptance conflicts with its reported source.",
        );
      }
      binding.report({ kind: "complete", expectedSource: { ...retained } });
    },
  };
  return carryTelegramUpdateExecutionFence(
    value,
    bindTelegramUpdateAdmissionCarrier(value, scoped)!,
  );
}

/** Report source completion; true means reported, not a durable settlement acknowledgement. */
export function reportTelegramUpdateCompleted(
  value: unknown,
  expectedSource?: TelegramDeferredSourceEvidence,
): boolean {
  const binding = getTelegramUpdateAdmissionBinding(value);
  if (!binding) return false;
  const execution = getTelegramUpdateExecutionFence(value);
  if (execution && !execution.isCurrent()) return false;
  binding.report(
    validateTelegramUpdateAdmissionOutcome(
      {
        kind: "complete",
        ...(expectedSource !== undefined ? { expectedSource } : {}),
      },
      binding.sourceUpdateId,
      new Set([binding.sourceUpdateId]),
    ),
  );
  return true;
}

export function reportTelegramUpdateDeferred(value: unknown): boolean {
  const binding = getTelegramUpdateAdmissionBinding(value);
  if (!binding) return false;
  const execution = getTelegramUpdateExecutionFence(value);
  if (execution && !execution.isCurrent()) return false;
  binding.report({ kind: "deferred" });
  return true;
}

/** Exact source-bound cancellation; undefined means no eligible attempt was made. */
export function abandonTelegramDeferredUpdate(
  value: unknown,
  authority: TelegramDeferredUpdateAbandonmentAuthority,
): TelegramUpdateJournalPendingAbandonmentResult | undefined {
  return getTelegramUpdateAdmissionBinding(value)?.abandon?.(authority);
}

/** Capability for chooser publication; the eventual action still requires exact deferred authority. */
export function supportsTelegramDeferredAbandonment(
  value: unknown,
  journalBindingKey: string,
): boolean {
  return (
    getTelegramUpdateAdmissionBinding(value)?.supportsAbandonment?.(
      journalBindingKey,
    ) === true
  );
}

/** Observe protected attempts through a current carrier; the UI still owns human authorization. */
export function inspectTelegramAbandoningUpdates(
  value: unknown,
  request: TelegramDeferredAbandonmentRecoveryRequest,
): TelegramDeferredAbandonmentRecoveryPage | undefined {
  return getTelegramUpdateAdmissionBinding(value)?.inspectAbandoning?.(request);
}

/** Historical inspection is not human confirmation or permission to stop delivery. */
export function inspectTelegramHistoricalInputs(
  value: unknown,
  request: TelegramDeferredAbandonmentRecoveryRequest,
): TelegramDeferredAbandonmentRecoveryPage | undefined {
  return getTelegramUpdateAdmissionBinding(value)?.inspectHistorical?.(request);
}

export function isTelegramHistoricalInput(
  value: unknown,
  matchesOriginal?: TelegramHistoricalInputPredicate,
): boolean {
  return (
    getTelegramUpdateAdmissionBinding(value)?.isHistorical?.(
      matchesOriginal,
    ) === true
  );
}

/** Routing's last-boundary hold when ownership changed after early classification. */
export function reportTelegramHistoricalRoutingReview(value: unknown): boolean {
  if (
    !isTelegramHistoricalInput(value) ||
    getTelegramUpdateExecutionFence(value)?.isCurrent() !== true
  )
    return false;
  getTelegramUpdateAdmissionBinding(value)!.report({
    kind: "deferred",
    routingReview: true,
  });
  return true;
}

/** Arm only a positively published chooser; the journal owns the immutable hour deadline. */
export function armTelegramRoutingInputs(
  values: readonly unknown[],
  operatorUserId: number,
  chooser?: TelegramUpdateJournalRoutingChooser,
): TelegramUpdateJournalRoutingInput | undefined {
  const first = values[0],
    execution = getTelegramUpdateExecutionFence(first);
  if (
    !execution ||
    values.some(
      (value) =>
        getTelegramUpdateExecutionFence(value)?.signal !== execution.signal,
    )
  )
    return undefined;
  for (const value of values) assertTelegramUpdateExecutionCurrent(value);
  const ids = collectTelegramAdmissionSourceUpdateIds(values);
  if (!ids.length) return undefined;
  return getTelegramUpdateAdmissionBinding(first)?.armRoutingInput?.(
    operatorUserId,
    ids,
    chooser,
  );
}

/** A routed carrier's saved routing clock; a revived chooser reuses its recorded message. */
export function getTelegramUpdateRoutingInput(
  value: unknown,
): TelegramUpdateJournalRoutingInput | undefined {
  return getTelegramUpdateAdmissionBinding(value)?.getRoutingInput?.();
}

/** Reserve source execution; an actual choice must also freeze its durable TTL before any effect. */
export function acquireTelegramUpdateRouting(
  value: unknown,
  select = false,
  sourceUpdateIds?: readonly number[],
): () => void {
  assertTelegramUpdateExecutionCurrent(value);
  return (
    getTelegramUpdateAdmissionBinding(value)?.acquireRouting?.(
      select,
      sourceUpdateIds,
    ) ?? (() => {})
  );
}

/** Capture existing warm completion authority; only explicit reporting may dispose this exact original. */
export function prepareTelegramDeferredSourceCompletion(
  value: unknown,
): TelegramDeferredSourceCompletionPreparation | undefined {
  const execution = getTelegramUpdateExecutionFence(value),
    binding = getTelegramUpdateAdmissionBinding(value);
  if (
    !execution ||
    execution.isCurrent() !== true ||
    !binding?.prepareSourceCompletion ||
    !binding.inspectCompletion ||
    !binding.inspectSource
  )
    return undefined;
  const prepare = binding.prepareSourceCompletion,
    inspect = binding.inspectCompletion,
    readSource = binding.inspectSource,
    report = binding.report;
  const available = prepare(),
    source = available && { ...available.source };
  const current = () =>
    !!available &&
    available.isCurrent() &&
    execution.isCurrent() &&
    getTelegramUpdateExecutionFence(value) === execution &&
    getTelegramUpdateAdmissionBinding(value) === binding &&
    binding.prepareSourceCompletion === prepare &&
    binding.inspectCompletion === inspect &&
    binding.inspectSource === readSource &&
    binding.report === report;
  if (
    !source ||
    !current() ||
    !isDeepStrictEqual(readSource(), source) ||
    !current()
  )
    return undefined;
  let attempted = false,
    reported = false;
  return {
    get source() {
      return { ...source };
    },
    isCurrent: current,
    reportCompleted() {
      if (attempted) return false;
      attempted = true;
      if (!current() || !isDeepStrictEqual(readSource(), source) || !current())
        return false;
      reported = true;
      // Acceptance remains separate from the asynchronously issued worker removal ACK, including after a lost report.
      return reportTelegramUpdateCompleted(value, { ...source });
    },
    inspectCompletion() {
      if (!reported || !current()) return undefined;
      const completed = inspect();
      return current() && isDeepStrictEqual(completed, source)
        ? { ...source }
        : undefined;
    },
  };
}

/** Read-only warm owner availability; no source freeze, admission, report or receipt reconstruction. */
export function prepareTelegramDeferredQueueAdmission(
  value: unknown,
): TelegramDeferredQueueAdmissionPreparation | undefined {
  if (getTelegramUpdateExecutionFence(value)?.isCurrent() !== true)
    return undefined;
  return getTelegramUpdateAdmissionBinding(value)?.prepareQueueAdmission?.();
}

export function reportTelegramQueueAdmission(
  values: readonly unknown[],
  receipts: readonly TelegramQueueAdmissionReceiptLike[],
): boolean {
  const bindings = new Map<number, TelegramUpdateAdmissionBinding>();
  for (const value of values) {
    const execution = getTelegramUpdateExecutionFence(value);
    if (execution && !execution.isCurrent()) return false;
    const binding = getTelegramUpdateAdmissionBinding(value);
    if (!binding) continue;
    const existing = bindings.get(binding.sourceUpdateId);
    if (existing && existing !== binding) {
      throw new TelegramUpdateAdmissionOutcomeError(
        `Telegram update ${binding.sourceUpdateId} has conflicting admission bindings.`,
      );
    }
    bindings.set(binding.sourceUpdateId, binding);
  }
  if (bindings.size === 0) return false;
  const receiptsByUpdateId = new Map<
    number,
    { receipt: TelegramQueueAdmissionReceiptLike; count: number }
  >();
  for (const receipt of receipts) {
    for (const sourceUpdateId of new Set(receipt.sourceUpdateIds)) {
      const existing = receiptsByUpdateId.get(sourceUpdateId);
      if (existing) existing.count += 1;
      else receiptsByUpdateId.set(sourceUpdateId, { receipt, count: 1 });
    }
  }
  const reports = [...bindings].map(([sourceUpdateId, binding]) => {
    const match = receiptsByUpdateId.get(sourceUpdateId);
    if (!match || match.count !== 1) {
      throw new TelegramUpdateAdmissionOutcomeError(
        `Telegram update ${sourceUpdateId} requires one exact queue receipt.`,
      );
    }
    return {
      binding,
      outcome: {
        kind: "queued" as const,
        queueKind: match.receipt.queueKind,
        receiptId: match.receipt.receiptId,
        sourceUpdateIds: [...match.receipt.sourceUpdateIds],
      },
    };
  });
  for (const report of reports) report.binding.report(report.outcome);
  return true;
}

export type TelegramUpdateFlowAction<
  TReactionUpdate extends TelegramMessageReactionUpdated =
    TelegramMessageReactionUpdated,
  TCallbackQuery extends TelegramCallbackQuery = TelegramCallbackQuery,
  TMessage extends TelegramUpdateMessage = TelegramUpdateMessage,
  TGuestMessage extends TelegramGuestMessage = TelegramGuestMessage,
> =
  | { kind: "ignore" }
  | { kind: "deleted"; messageIds: number[] }
  | { kind: "reaction"; reactionUpdate: TReactionUpdate }
  | {
      kind: "topic-lifecycle";
      lifecycle: TelegramTopicLifecycleUpdate<TMessage>;
    }
  | {
      kind: "callback";
      query: TCallbackQuery;
      authorization: TelegramAuthorizationState;
    }
  | {
      kind: "message";
      message: TMessage & { from: TelegramUser };
      authorization: TelegramAuthorizationState;
    }
  | {
      kind: "edited-message";
      message: TMessage & { from: TelegramUser };
      authorization: TelegramAuthorizationState;
    }
  | {
      kind: "guest";
      guestMessage: TGuestMessage & { from: TelegramUser };
      authorization: TelegramAuthorizationState;
    };

export function buildTelegramUpdateFlowAction<
  TUpdate extends TelegramUpdateFlow,
>(
  update: TUpdate,
  allowedUserId?: number,
): TelegramUpdateFlowAction<
  NonNullable<TUpdate["message_reaction"]>,
  NonNullable<TUpdate["callback_query"]>,
  NonNullable<TUpdate["message"] | TUpdate["edited_message"]>,
  NonNullable<TUpdate["guest_message"]>
> {
  // Business chats are independent from bot chats even when chat/message IDs coincide.
  // Raw handlers may own that namespace; the default DM runtime has no deletion authority.
  if (update.deleted_business_messages !== undefined) return { kind: "ignore" };
  if (update.message_reaction) {
    return { kind: "reaction", reactionUpdate: update.message_reaction };
  }
  const topicLifecycle = getTelegramTopicLifecycleUpdate(update.message);
  if (topicLifecycle) {
    return { kind: "topic-lifecycle", lifecycle: topicLifecycle };
  }
  const query = getAuthorizedTelegramCallbackQuery(update, allowedUserId);
  if (query) {
    return {
      kind: "callback",
      query: query as NonNullable<TUpdate["callback_query"]>,
      authorization: getTelegramAuthorizationState(
        query.from.id,
        allowedUserId,
      ),
    };
  }
  const message = getAuthorizedTelegramMessage(update, allowedUserId);
  if (message?.from) {
    return {
      kind: "message",
      message: message as NonNullable<
        TUpdate["message"] | TUpdate["edited_message"]
      > & { from: TelegramUser },
      authorization: getTelegramAuthorizationState(
        message.from.id,
        allowedUserId,
      ),
    };
  }
  const editedMessage = getAuthorizedTelegramEditedMessage(
    update,
    allowedUserId,
  );
  if (editedMessage?.from) {
    return {
      kind: "edited-message",
      message: editedMessage as NonNullable<
        TUpdate["message"] | TUpdate["edited_message"]
      > & { from: TelegramUser },
      authorization: getTelegramAuthorizationState(
        editedMessage.from.id,
        allowedUserId,
      ),
    };
  }
  const guestMessage = getAuthorizedTelegramGuestMessage(update);
  if (guestMessage?.from) {
    return {
      kind: "guest",
      guestMessage: guestMessage as NonNullable<TUpdate["guest_message"]> & {
        from: TelegramUser;
      },
      authorization: getTelegramAuthorizationState(
        guestMessage.from.id,
        allowedUserId,
      ),
    };
  }
  return { kind: "ignore" };
}

// --- Execution Planning ---

export type TelegramUpdateExecutionPlan<
  TReactionUpdate extends TelegramMessageReactionUpdated =
    TelegramMessageReactionUpdated,
  TCallbackQuery extends TelegramCallbackQuery = TelegramCallbackQuery,
  TMessage extends TelegramUpdateMessage = TelegramUpdateMessage,
  TGuestMessage extends TelegramGuestMessage = TelegramGuestMessage,
> =
  | { kind: "ignore" }
  | { kind: "deleted"; messageIds: number[] }
  | {
      kind: "reaction";
      reactionUpdate: TReactionUpdate;
    }
  | {
      kind: "topic-lifecycle";
      lifecycle: TelegramTopicLifecycleUpdate<TMessage>;
    }
  | {
      kind: "callback";
      query: TCallbackQuery;
      shouldPair: boolean;
      shouldDeny: boolean;
    }
  | {
      kind: "message";
      message: TMessage & { from: TelegramUser };
      shouldPair: boolean;
      shouldNotifyPaired: boolean;
      shouldDeny: boolean;
    }
  | {
      kind: "edited-message";
      message: TMessage & { from: TelegramUser };
      shouldPair: boolean;
      shouldDeny: boolean;
    }
  | {
      kind: "guest";
      guestMessage: TGuestMessage & { from: TelegramUser };
      shouldDeny: boolean;
    };

export function buildTelegramUpdateExecutionPlan<
  TReactionUpdate extends TelegramMessageReactionUpdated,
  TCallbackQuery extends TelegramCallbackQuery,
  TMessage extends TelegramUpdateMessage,
  TGuestMessage extends TelegramGuestMessage,
>(
  action: TelegramUpdateFlowAction<
    TReactionUpdate,
    TCallbackQuery,
    TMessage,
    TGuestMessage
  >,
): TelegramUpdateExecutionPlan<
  TReactionUpdate,
  TCallbackQuery,
  TMessage,
  TGuestMessage
> {
  switch (action.kind) {
    case "ignore":
      return { kind: "ignore" };
    case "deleted":
      return { kind: "deleted", messageIds: action.messageIds };
    case "reaction":
      return { kind: "reaction", reactionUpdate: action.reactionUpdate };
    case "topic-lifecycle":
      return { kind: "topic-lifecycle", lifecycle: action.lifecycle };
    case "callback":
      return {
        kind: "callback",
        query: action.query,
        shouldPair: action.authorization.kind === "pair",
        shouldDeny: action.authorization.kind === "deny",
      };
    case "message":
      return {
        kind: "message",
        message: action.message,
        shouldPair: action.authorization.kind === "pair",
        shouldNotifyPaired: action.authorization.kind === "pair",
        shouldDeny: action.authorization.kind === "deny",
      };
    case "edited-message":
      return {
        kind: "edited-message",
        message: action.message,
        shouldPair: action.authorization.kind === "pair",
        shouldDeny: action.authorization.kind === "deny",
      };
    case "guest":
      return {
        kind: "guest",
        guestMessage: action.guestMessage,
        // Guest mode is an extension of an already paired bridge, not a pairing surface.
        shouldDeny: action.authorization.kind !== "allow",
      };
  }
}

export function buildTelegramUpdateExecutionPlanFromUpdate<
  TUpdate extends TelegramUpdateFlow,
>(
  update: TUpdate,
  allowedUserId?: number,
): TelegramUpdateExecutionPlan<
  NonNullable<TUpdate["message_reaction"]>,
  NonNullable<TUpdate["callback_query"]>,
  NonNullable<TUpdate["message"] | TUpdate["edited_message"]>
> {
  return buildTelegramUpdateExecutionPlan(
    buildTelegramUpdateFlowAction(update, allowedUserId),
  );
}

// --- Runtime ---

export type TelegramMessageOwnershipRecorderInput = Parameters<
  TelegramMessageOwnershipStore["record"]
>[0];

export type TelegramMessageOwnershipRecorder = (
  input: TelegramMessageOwnershipRecorderInput,
) => void;

interface TelegramUnauthorizedReplyOptions {
  parseMode?: "HTML";
  target?: { chatId: number; threadId?: number };
}

/** The fleeting toast and the in-chat notice are separate copy, each written in its own form. */
const TELEGRAM_UNAUTHORIZED_DENIAL_TOAST = "Access denied";
/** A forwarded tap still unsettled after this long gets a neutral answer so the client spinner stops. */
const TELEGRAM_FOREIGN_CALLBACK_RELEASE_MS = 1_500;
const TELEGRAM_UNAUTHORIZED_DENIAL_NOTICE = "<b>🚫 Access denied.</b>";

/** Ownership lookups and authorized-update handlers shared by the per-update runtime and its controller. */
export interface TelegramUpdateHandlerPorts<
  TContext,
  TCallbackQuery extends TelegramCallbackQuery,
  TMessage extends TelegramUpdateMessage,
> {
  getCurrentInstanceId?: () => string | undefined;
  getMessageOwnership?: TelegramMessageOwnershipLookup;
  getTargetOwnership?: TelegramTargetOwnershipLookup;
  recordMessageOwnership?: TelegramMessageOwnershipRecorder;
  removePendingMediaGroupMessages: (messageIds: number[]) => void;
  pairTelegramUserIfNeeded: (
    userId: number,
    ctx: TContext,
    assertExecutionCurrent?: () => void,
  ) => Promise<boolean>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  answerGuestQuery: (
    guestQueryId: string,
    text?: string,
    options?: Pick<TelegramUnauthorizedReplyOptions, "parseMode">,
  ) => Promise<void>;
  handleAuthorizedTelegramCallbackQuery: (
    query: TCallbackQuery,
    ctx: TContext,
  ) => Promise<void>;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number,
    text: string,
    options?: TelegramUnauthorizedReplyOptions,
  ) => Promise<number | undefined>;
  /** Private Delivery replies run after sender admission and before any ordinary ownership/routing/input lane. */
  handleAuthorizedTelegramDeliveryReply?: (
    message: TMessage,
    ctx: TContext,
    edited: boolean,
  ) => Promise<boolean>;
  handleAuthorizedTelegramMessage: (
    message: TMessage,
    ctx: TContext,
  ) => Promise<void>;
  handleAuthorizedTelegramEditedMessage: (
    message: TMessage,
    ctx: TContext,
  ) => unknown;
  handleAuthorizedTelegramGuestMessage?: (
    guestMessage: TelegramGuestMessage & { from: TelegramUser },
    ctx: TContext,
  ) => Promise<void>;
  handleTelegramTopicLifecycleUpdate?: (
    lifecycle: TelegramTopicLifecycleUpdate<TMessage>,
    ctx: TContext,
  ) => Promise<void> | void;
  /** Called when the owner writes in an unbound thread no live instance owns. */
  handleUnboundTelegramTopicMessage?: (
    message: TMessage & { from: TelegramUser },
    ctx: TContext,
  ) => Promise<void>;
}

export interface TelegramUpdateRuntimeDeps<
  TContext = unknown,
  TReactionUpdate extends TelegramMessageReactionUpdated =
    TelegramMessageReactionUpdated,
  TCallbackQuery extends TelegramCallbackQuery = TelegramCallbackQuery,
  TMessage extends TelegramUpdateMessage = TelegramUpdateMessage,
> extends TelegramUpdateHandlerPorts<TContext, TCallbackQuery, TMessage> {
  ctx: TContext;
  execution?: TelegramUpdateExecutionFence;
  foreignOwnedUpdateForwarder?: TelegramForeignOwnedUpdateForwarder<
    TContext,
    TReactionUpdate,
    TCallbackQuery,
    TMessage
  >;
  /** Test seam for the early spinner release of a slow forwarded callback; defaults to 1.5 s. */
  foreignCallbackReleaseMs?: number;
  removeQueuedTelegramTurnsByMessageIds: (
    messageIds: number[],
    ctx: TContext,
  ) => number;
  handleAuthorizedTelegramReactionUpdate: (
    reactionUpdate: TReactionUpdate,
    ctx: TContext,
  ) => Promise<void>;
}

export interface TelegramUpdateRuntimeControllerDeps<
  TContext = unknown,
  TCallbackQuery extends TelegramCallbackQuery = TelegramCallbackQuery,
  TMessage extends TelegramUpdateMessage = TelegramUpdateMessage,
> extends TelegramUpdateHandlerPorts<TContext, TCallbackQuery, TMessage> {
  getAllowedUserId: () => number | undefined;
  foreignOwnedUpdateForwarder?: TelegramForeignOwnedUpdateForwarder<
    TContext,
    TelegramMessageReactionUpdated,
    TCallbackQuery,
    TMessage
  >;
  flushPendingMediaGroupMessage?: (messageId: number) => Promise<boolean>;
  flushPendingTextGroupMessage?: (messageId: number) => Promise<boolean>;
  removeQueuedTelegramTurnsByMessageIds: (
    messageIds: number[],
    ctx: TContext,
    scope?: { chatId?: number; threadId?: number },
  ) => number;
  applyQueuedTelegramTurnReactionByMessageId: (
    messageId: number,
    disposition: TelegramQueueReactionDisposition,
    ctx: TContext,
    scope?: { chatId?: number; threadId?: number },
  ) => boolean;
}

export interface TelegramUpdateRuntimeController<
  TContext = unknown,
  TUpdate extends TelegramUpdateFlow = TelegramUpdateFlow,
> {
  handleAuthorizedReactionUpdate: (
    reactionUpdate: NonNullable<TUpdate["message_reaction"]>,
    ctx: TContext,
  ) => Promise<void>;
  handleUpdate: (
    update: TUpdate,
    ctx: TContext,
    execution?: TelegramUpdateExecutionFence,
  ) => Promise<void>;
}

function getTelegramCallbackQueryId(
  query: TelegramCallbackQuery,
): string | undefined {
  return typeof query.id === "string" ? query.id : undefined;
}

function getTelegramMessageReplyTarget(
  message: TelegramUpdateMessage,
): { chatId: number; messageId: number; threadId?: number } | undefined {
  if (
    typeof message.chat.id !== "number" ||
    typeof message.message_id !== "number"
  ) {
    return undefined;
  }
  return {
    chatId: message.chat.id,
    messageId: message.message_id,
    ...(typeof message.message_thread_id === "number"
      ? { threadId: message.message_thread_id }
      : {}),
  };
}

function getForeignTelegramMessageOwnership(
  target: { chatId: number; messageId: number } | undefined,
  deps: {
    getCurrentInstanceId?: () => string | undefined;
    getMessageOwnership?: TelegramMessageOwnershipLookup;
  },
): TelegramMessageOwnershipView | undefined {
  if (!target || !deps.getMessageOwnership || !deps.getCurrentInstanceId) {
    return undefined;
  }
  const currentInstanceId = deps.getCurrentInstanceId();
  if (!currentInstanceId) return undefined;
  const ownership = deps.getMessageOwnership(target.chatId, target.messageId);
  return ownership && ownership.instanceId !== currentInstanceId
    ? ownership
    : undefined;
}

function getForeignTelegramCallbackOwnership(
  query: TelegramCallbackQuery,
  deps: {
    getCurrentInstanceId?: () => string | undefined;
    getMessageOwnership?: TelegramMessageOwnershipLookup;
    getTargetOwnership?: TelegramTargetOwnershipLookup;
  },
): TelegramMessageOwnershipView | undefined {
  const messageTarget = getTelegramCallbackMessageTarget(query);
  const currentInstanceId = deps.getCurrentInstanceId?.();
  const knownOwner =
    messageTarget &&
    deps.getMessageOwnership?.(messageTarget.chatId, messageTarget.messageId);
  // A locally published chooser stays local when Restore moves its Thread to a follower.
  if (currentInstanceId && knownOwner?.instanceId === currentInstanceId)
    return undefined;
  const messageOwnership = getForeignTelegramMessageOwnership(
    messageTarget,
    deps,
  );
  const targetOwnership = getForeignTelegramTargetOwnership(
    query.message ? getTelegramMessageTarget(query.message) : undefined,
    deps,
  );
  if (!messageOwnership) return targetOwnership;
  if (
    targetOwnership &&
    messageOwnership.recipientBindingKey &&
    messageOwnership.recipientBindingKey === targetOwnership.recipientBindingKey
  ) {
    return targetOwnership;
  }
  return messageOwnership;
}

function getTelegramCallbackMessageTarget(
  query: TelegramCallbackQuery,
): { chatId: number; messageId: number } | undefined {
  return query.message
    ? getTelegramMessageReplyTarget(query.message)
    : undefined;
}

function getTelegramReactionMessageTarget(
  reactionUpdate: TelegramMessageReactionUpdated,
): { chatId: number; messageId: number } | undefined {
  return typeof reactionUpdate.chat.id === "number"
    ? { chatId: reactionUpdate.chat.id, messageId: reactionUpdate.message_id }
    : undefined;
}

function getForeignTelegramTargetOwnership(
  target: TelegramTarget | undefined,
  deps: {
    getCurrentInstanceId?: () => string | undefined;
    getTargetOwnership?: TelegramTargetOwnershipLookup;
  },
): TelegramTargetOwnershipView | undefined {
  if (!target || !deps.getTargetOwnership || !deps.getCurrentInstanceId) {
    return undefined;
  }
  const currentInstanceId = deps.getCurrentInstanceId();
  if (!currentInstanceId) return undefined;
  const ownership = deps.getTargetOwnership(target);
  return ownership && ownership.instanceId !== currentInstanceId
    ? ownership
    : undefined;
}

export async function executeTelegramUpdate<
  TUpdate extends TelegramUpdateFlow,
  TContext = unknown,
>(
  update: TUpdate,
  allowedUserId: number | undefined,
  deps: TelegramUpdateRuntimeDeps<
    TContext,
    NonNullable<TUpdate["message_reaction"]>,
    NonNullable<TUpdate["callback_query"]>,
    NonNullable<TUpdate["message"] | TUpdate["edited_message"]>
  >,
): Promise<void> {
  const runtimeDeps = update[TELEGRAM_INTERNAL_AGENT_MESSAGE]
    ? { ...deps, getMessageOwnership: undefined, handleAuthorizedTelegramDeliveryReply: undefined }
    : deps;
  await executeTelegramUpdatePlan(
    buildTelegramUpdateExecutionPlanFromUpdate(update, allowedUserId),
    runtimeDeps,
  );
}

export type TelegramPairedUpdateRuntimeControllerDeps<
  TContext = unknown,
  TUpdate extends TelegramUpdateFlow = TelegramUpdateFlow,
> = Omit<
  TelegramUpdateRuntimeControllerDeps<
    TContext,
    NonNullable<TUpdate["callback_query"]>,
    NonNullable<TUpdate["message"] | TUpdate["edited_message"]>
  >,
  "pairTelegramUserIfNeeded"
> &
  TelegramUserPairingRuntimeDeps<TContext>;

export function createTelegramPairedUpdateRuntime<
  TContext = unknown,
  TUpdate extends TelegramUpdateFlow = TelegramUpdateFlow,
>(
  deps: TelegramPairedUpdateRuntimeControllerDeps<TContext, TUpdate>,
): TelegramUpdateRuntimeController<TContext, TUpdate> {
  return createTelegramUpdateRuntime({
    getAllowedUserId: deps.getAllowedUserId,
    getCurrentInstanceId: deps.getCurrentInstanceId,
    getMessageOwnership: deps.getMessageOwnership,
    getTargetOwnership: deps.getTargetOwnership,
    recordMessageOwnership: deps.recordMessageOwnership,
    handleTelegramTopicLifecycleUpdate: deps.handleTelegramTopicLifecycleUpdate,
    foreignOwnedUpdateForwarder: deps.foreignOwnedUpdateForwarder,
    removePendingMediaGroupMessages: deps.removePendingMediaGroupMessages,
    flushPendingMediaGroupMessage: deps.flushPendingMediaGroupMessage,
    flushPendingTextGroupMessage: deps.flushPendingTextGroupMessage,
    removeQueuedTelegramTurnsByMessageIds:
      deps.removeQueuedTelegramTurnsByMessageIds,
    applyQueuedTelegramTurnReactionByMessageId:
      deps.applyQueuedTelegramTurnReactionByMessageId,
    pairTelegramUserIfNeeded: (userId, ctx, assertExecutionCurrent) =>
      createTelegramUserPairingRuntime({
        getAllowedUserId: deps.getAllowedUserId,
        persistAllowedUserId: deps.persistAllowedUserId,
        updateStatus: deps.updateStatus,
      }).pairIfNeeded(userId, ctx, assertExecutionCurrent),
    answerCallbackQuery: deps.answerCallbackQuery,
    answerGuestQuery: deps.answerGuestQuery,
    handleAuthorizedTelegramCallbackQuery:
      deps.handleAuthorizedTelegramCallbackQuery,
    sendTextReply: deps.sendTextReply,
    handleAuthorizedTelegramDeliveryReply: deps.handleAuthorizedTelegramDeliveryReply,
    handleAuthorizedTelegramMessage: deps.handleAuthorizedTelegramMessage,
    handleAuthorizedTelegramEditedMessage:
      deps.handleAuthorizedTelegramEditedMessage,
    handleAuthorizedTelegramGuestMessage:
      deps.handleAuthorizedTelegramGuestMessage,
    handleUnboundTelegramTopicMessage: deps.handleUnboundTelegramTopicMessage,
  });
}

export function createTelegramUpdateRuntime<
  TContext = unknown,
  TUpdate extends TelegramUpdateFlow = TelegramUpdateFlow,
>(
  deps: TelegramUpdateRuntimeControllerDeps<
    TContext,
    NonNullable<TUpdate["callback_query"]>,
    NonNullable<TUpdate["message"] | TUpdate["edited_message"]>
  >,
): TelegramUpdateRuntimeController<TContext, TUpdate> {
  const handleAuthorizedReactionUpdate = async (
    reactionUpdate: NonNullable<TUpdate["message_reaction"]>,
    ctx: TContext,
  ): Promise<void> => {
    await handleAuthorizedTelegramReactionUpdate(reactionUpdate, {
      allowedUserId: deps.getAllowedUserId(),
      ctx,
      flushPendingMediaGroupMessage: deps.flushPendingMediaGroupMessage,
      flushPendingTextGroupMessage: deps.flushPendingTextGroupMessage,
      getCurrentInstanceId: deps.getCurrentInstanceId,
      getMessageOwnership: deps.getMessageOwnership,
      foreignOwnedUpdateForwarder: deps.foreignOwnedUpdateForwarder,
      assertExecutionCurrent:
        createTelegramUpdateExecutionFenceGuard(reactionUpdate),
      applyQueuedTelegramTurnReactionByMessageId:
        deps.applyQueuedTelegramTurnReactionByMessageId,
    });
  };
  return {
    handleAuthorizedReactionUpdate,
    handleUpdate: (update, ctx, execution) =>
      executeTelegramUpdate(update, deps.getAllowedUserId(), {
        ctx,
        execution,
        getCurrentInstanceId: deps.getCurrentInstanceId,
        getMessageOwnership: deps.getMessageOwnership,
        getTargetOwnership: deps.getTargetOwnership,
        recordMessageOwnership: deps.recordMessageOwnership,
        foreignOwnedUpdateForwarder: deps.foreignOwnedUpdateForwarder,
        removePendingMediaGroupMessages: deps.removePendingMediaGroupMessages,
        removeQueuedTelegramTurnsByMessageIds:
          deps.removeQueuedTelegramTurnsByMessageIds,
        handleAuthorizedTelegramReactionUpdate: handleAuthorizedReactionUpdate,
        handleTelegramTopicLifecycleUpdate:
          deps.handleTelegramTopicLifecycleUpdate,
        pairTelegramUserIfNeeded: deps.pairTelegramUserIfNeeded,
        answerCallbackQuery: deps.answerCallbackQuery,
        answerGuestQuery: deps.answerGuestQuery,
        handleAuthorizedTelegramCallbackQuery:
          deps.handleAuthorizedTelegramCallbackQuery,
        sendTextReply: deps.sendTextReply,
        handleAuthorizedTelegramDeliveryReply: deps.handleAuthorizedTelegramDeliveryReply,
        handleAuthorizedTelegramMessage: deps.handleAuthorizedTelegramMessage,
        handleAuthorizedTelegramEditedMessage:
          deps.handleAuthorizedTelegramEditedMessage,
        handleAuthorizedTelegramGuestMessage:
          deps.handleAuthorizedTelegramGuestMessage,
        handleUnboundTelegramTopicMessage:
          deps.handleUnboundTelegramTopicMessage,
      }),
  };
}

export interface AuthorizedTelegramReactionUpdateDeps<TContext> {
  allowedUserId?: number;
  ctx: TContext;
  getCurrentInstanceId?: () => string | undefined;
  getMessageOwnership?: TelegramMessageOwnershipLookup;
  foreignOwnedUpdateForwarder?: TelegramForeignOwnedUpdateForwarder<TContext>;
  assertExecutionCurrent?: () => void;
  flushPendingMediaGroupMessage?: (messageId: number) => Promise<boolean>;
  flushPendingTextGroupMessage?: (messageId: number) => Promise<boolean>;
  applyQueuedTelegramTurnReactionByMessageId: (
    messageId: number,
    disposition: TelegramQueueReactionDisposition,
    ctx: TContext,
    scope?: { chatId?: number; threadId?: number },
  ) => boolean;
}

export async function handleAuthorizedTelegramReactionUpdate<TContext>(
  reactionUpdate: TelegramMessageReactionUpdated,
  deps: AuthorizedTelegramReactionUpdateDeps<TContext>,
): Promise<void> {
  const reactionUser = reactionUpdate.user;
  const allowedUserId = deps.allowedUserId;
  if (
    allowedUserId === undefined ||
    !Number.isSafeInteger(allowedUserId) ||
    allowedUserId <= 0 ||
    !reactionUser ||
    reactionUser.is_bot ||
    reactionUser.id !== allowedUserId ||
    reactionUpdate.actor_chat !== undefined
  )
    return;
  const foreignOwnership = getForeignTelegramMessageOwnership(
    getTelegramReactionMessageTarget(reactionUpdate),
    deps,
  );
  if (foreignOwnership) {
    deps.assertExecutionCurrent?.();
    const settlement =
      await deps.foreignOwnedUpdateForwarder?.forwardReaction?.({
        reactionUpdate,
        ownership: foreignOwnership,
        ctx: deps.ctx,
      });
    deps.assertExecutionCurrent?.();
    if (settlement?.status !== "accepted") {
      rejectTelegramForeignUpdateSettlement(
        settlement,
        "reaction",
        reactionUpdate,
      );
    }
    return;
  }
  const reactionScope =
    typeof reactionUpdate.chat.id === "number"
      ? { chatId: reactionUpdate.chat.id }
      : undefined;
  const reactionTransition = getTelegramQueueReactionTransition(
    reactionUpdate.old_reaction,
    reactionUpdate.new_reaction,
  );
  if (!reactionTransition) return;
  deps.assertExecutionCurrent?.();
  await deps.flushPendingMediaGroupMessage?.(reactionUpdate.message_id);
  deps.assertExecutionCurrent?.();
  await deps.flushPendingTextGroupMessage?.(reactionUpdate.message_id);
  deps.assertExecutionCurrent?.();
  deps.applyQueuedTelegramTurnReactionByMessageId(
    reactionUpdate.message_id,
    reactionTransition,
    deps.ctx,
    reactionScope,
  );
}

export async function executeTelegramUpdatePlan<
  TContext = unknown,
  TReactionUpdate extends TelegramMessageReactionUpdated =
    TelegramMessageReactionUpdated,
  TCallbackQuery extends TelegramCallbackQuery = TelegramCallbackQuery,
  TMessage extends TelegramUpdateMessage = TelegramUpdateMessage,
>(
  plan: TelegramUpdateExecutionPlan<TReactionUpdate, TCallbackQuery, TMessage>,
  deps: TelegramUpdateRuntimeDeps<
    TContext,
    TReactionUpdate,
    TCallbackQuery,
    TMessage
  >,
): Promise<void> {
  try {
    const assertExecutionCurrent = (): void => deps.execution?.assertCurrent();
    if (plan.kind === "ignore") return;
    if (plan.kind === "deleted") {
      assertExecutionCurrent();
      deps.removePendingMediaGroupMessages(plan.messageIds);
      deps.removeQueuedTelegramTurnsByMessageIds(plan.messageIds, deps.ctx);
      return;
    }
    if (plan.kind === "reaction") {
      assertExecutionCurrent();
      await deps.handleAuthorizedTelegramReactionUpdate(
        plan.reactionUpdate,
        deps.ctx,
      );
      assertExecutionCurrent();
      return;
    }
    if (plan.kind === "topic-lifecycle") {
      assertExecutionCurrent();
      await deps.handleTelegramTopicLifecycleUpdate?.(plan.lifecycle, deps.ctx);
      return;
    }
    if (plan.kind === "callback") {
      let pairingAllowed = true;
      if (plan.shouldPair) {
        assertExecutionCurrent();
        pairingAllowed = await deps.pairTelegramUserIfNeeded(
          plan.query.from.id,
          deps.ctx,
          assertExecutionCurrent,
        );
      }
      if (plan.shouldDeny || !pairingAllowed) {
        const callbackQueryId = getTelegramCallbackQueryId(plan.query);
        if (callbackQueryId) {
          assertExecutionCurrent();
          await deps.answerCallbackQuery(
            callbackQueryId,
            TELEGRAM_UNAUTHORIZED_DENIAL_TOAST,
          );
        }
        return;
      }
      const foreignOwnership = getForeignTelegramCallbackOwnership(
        plan.query,
        deps,
      );
      if (foreignOwnership) {
        assertExecutionCurrent();
        const callbackQueryId = getTelegramCallbackQueryId(plan.query);
        const forwarding = Promise.resolve(
          deps.foreignOwnedUpdateForwarder?.forwardCallback?.({
            query: plan.query,
            ownership: foreignOwnership,
            ctx: deps.ctx,
          }),
        );
        void forwarding.catch(() => undefined);
        // A slow recipient must not leave the tap spinning until Telegram's answer window closes. The neutral answer
        // is final for this query: the recipient's own toast then fails harmlessly as already answered.
        let released = false;
        let releaseTimer: ReturnType<typeof setTimeout> | undefined;
        if (callbackQueryId) {
          const releaseDelay = new Promise<"slow">((resolve) => {
            releaseTimer = setTimeout(
              () => resolve("slow"),
              deps.foreignCallbackReleaseMs ?? TELEGRAM_FOREIGN_CALLBACK_RELEASE_MS,
            );
            releaseTimer.unref?.();
          });
          try {
            if ((await Promise.race([forwarding, releaseDelay])) === "slow") {
              assertExecutionCurrent();
              released = true;
              await deps.answerCallbackQuery(callbackQueryId);
            }
          } finally {
            clearTimeout(releaseTimer);
          }
        }
        const settlement = await forwarding;
        if (settlement?.status !== "accepted") {
          try {
            if (callbackQueryId && !released) {
              assertExecutionCurrent();
              // A retryable settlement keeps the tap journaled for retry; it is not a foreign-ownership verdict.
              await deps.answerCallbackQuery(
                callbackQueryId,
                settlement?.status === "retryable"
                  ? "Pi instance is busy, retrying"
                  : "This Telegram message belongs to another Pi instance",
              );
            }
          } finally {
            rejectTelegramForeignUpdateSettlement(
              settlement,
              "callback",
              plan.query,
            );
          }
        }
        assertExecutionCurrent();
        return;
      }
      assertExecutionCurrent();
      await deps.handleAuthorizedTelegramCallbackQuery(plan.query, deps.ctx);
      assertExecutionCurrent();
      return;
    }
    if (plan.kind === "guest") {
      if (plan.shouldDeny) {
        assertExecutionCurrent();
        await deps.answerGuestQuery(
          plan.guestMessage.guest_query_id,
          TELEGRAM_UNAUTHORIZED_DENIAL_NOTICE,
          { parseMode: "HTML" },
        );
        return;
      }
      if (deps.handleAuthorizedTelegramGuestMessage) {
        assertExecutionCurrent();
        await deps.handleAuthorizedTelegramGuestMessage(
          plan.guestMessage,
          deps.ctx,
        );
        assertExecutionCurrent();
      }
      return;
    }
    if (plan.shouldPair) assertExecutionCurrent();
    const pairedNow = plan.shouldPair
      ? await deps.pairTelegramUserIfNeeded(
          plan.message.from.id,
          deps.ctx,
          assertExecutionCurrent,
        )
      : false;
    const replyTarget = getTelegramMessageReplyTarget(plan.message);
    if (plan.shouldDeny || (plan.shouldPair && !pairedNow)) {
      if (replyTarget) {
        assertExecutionCurrent();
        await deps.sendTextReply(
          replyTarget.chatId,
          replyTarget.messageId,
          TELEGRAM_UNAUTHORIZED_DENIAL_NOTICE,
          { parseMode: "HTML", target: replyTarget },
        );
      }
      return;
    }
    if (
      plan.kind === "message" &&
      pairedNow &&
      plan.shouldNotifyPaired &&
      replyTarget
    ) {
      assertExecutionCurrent();
      await deps.sendTextReply(
        replyTarget.chatId,
        replyTarget.messageId,
        "Telegram bridge paired with this account.",
        { target: replyTarget },
      );
      assertExecutionCurrent();
    }
    if (deps.handleAuthorizedTelegramDeliveryReply) {
      assertExecutionCurrent();
      const handled = await deps.handleAuthorizedTelegramDeliveryReply(plan.message, deps.ctx, plan.kind === "edited-message");
      assertExecutionCurrent();
      if (typeof handled !== "boolean") throw new Error("Private Delivery reply disposition is unavailable.");
      if (handled) return;
    }
    const foreignMessageOwnership = getForeignTelegramMessageOwnership(
      replyTarget,
      deps,
    );
    if (foreignMessageOwnership) {
      assertExecutionCurrent();
      const settlement =
        plan.kind === "edited-message"
          ? await deps.foreignOwnedUpdateForwarder?.forwardEditedMessage?.({
              message: plan.message,
              ownership: foreignMessageOwnership,
              ctx: deps.ctx,
            })
          : await deps.foreignOwnedUpdateForwarder?.forwardMessage?.({
              message: plan.message,
              ownership: foreignMessageOwnership,
              ctx: deps.ctx,
            });
      if (settlement?.status !== "accepted") {
        rejectTelegramForeignUpdateSettlement(
          settlement,
          plan.kind,
          plan.message,
        );
      }
      assertExecutionCurrent();
      return;
    }
    const messageTarget = getTelegramMessageTarget(plan.message);
    const foreignTargetOwnership = getForeignTelegramTargetOwnership(
      messageTarget,
      deps,
    );
    if (foreignTargetOwnership) {
      if (typeof plan.message.message_id === "number") {
        assertExecutionCurrent();
        deps.recordMessageOwnership?.({
          chatId: messageTarget!.chatId,
          messageId: plan.message.message_id,
          target: messageTarget,
          instanceId: foreignTargetOwnership.instanceId,
        });
      }
      assertExecutionCurrent();
      const settlement =
        plan.kind === "edited-message"
          ? await deps.foreignOwnedUpdateForwarder?.forwardEditedMessage?.({
              message: plan.message,
              ownership: foreignTargetOwnership,
              ctx: deps.ctx,
            })
          : await deps.foreignOwnedUpdateForwarder?.forwardMessage?.({
              message: plan.message,
              ownership: foreignTargetOwnership,
              ctx: deps.ctx,
            });
      if (settlement?.status !== "accepted") {
        rejectTelegramForeignUpdateSettlement(
          settlement,
          plan.kind,
          plan.message,
        );
      }
      assertExecutionCurrent();
      return;
    }
    if (
      plan.kind === "message" &&
      messageTarget?.threadId != null &&
      deps.handleUnboundTelegramTopicMessage
    ) {
      assertExecutionCurrent();
      await deps.handleUnboundTelegramTopicMessage(plan.message, deps.ctx);
      // A terminal historical hold intentionally suspends this exact carrier.
      // Do not turn its acknowledged deferral into a retryable execution failure.
      if (
        getTelegramUpdateExecutionFence(plan.message) !== deps.execution ||
        getTelegramUpdateAdmissionBinding(
          plan.message,
        )?.isHistoricalReviewHeld?.() !== true
      )
        assertExecutionCurrent();
      return;
    }
    if (plan.kind === "edited-message") {
      assertExecutionCurrent();
      await deps.handleAuthorizedTelegramEditedMessage(plan.message, deps.ctx);
      assertExecutionCurrent();
      return;
    }
    assertExecutionCurrent();
    await deps.handleAuthorizedTelegramMessage(plan.message, deps.ctx);
    assertExecutionCurrent();
  } catch (error) {
    if (!isPiStaleContextError(error)) throw error;
  }
}

// --- Durable update worker ---

const TELEGRAM_UPDATE_RETRY_BASE_DELAY_MS = 1_000;
const TELEGRAM_UPDATE_RETRY_MAX_DELAY_MS = 60_000;
const TELEGRAM_UPDATE_WORKER_BATCH_SIZE = 64;

export type TelegramUpdateWorkerPhase =
  | "stopped"
  | "idle"
  | "executing"
  | "retry-wait"
  | "failed"
  | "deferred"
  | "queued"
  | "blocked";

export type TelegramUpdateWorkerBlockedReason =
  | "authority-lost"
  | "authority-check"
  | "journal-read"
  | "journal-write"
  | "execution"
  | "input-custody"
  | "prior-generation-executing"
  | "invalid-outcome";

export interface TelegramUpdateWorkerStateSnapshot {
  phase: TelegramUpdateWorkerPhase;
  generation: number;
  phaseStartedAtMs?: number;
  currentUpdateId?: number;
  blockedReason?: TelegramUpdateWorkerBlockedReason;
  blockedInputCustody?: {
    updateId: number;
    kind:
      | "running-outcome-unknown"
      | "foreign-ready"
      | "handoff-frozen"
      | "legacy-retry-state";
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
  version:
    | typeof TELEGRAM_UPDATE_JOURNAL_VERSION
    | typeof TELEGRAM_UPDATE_JOURNAL_EXCLUSION_VERSION
    | typeof TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION;
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
  inspectPendingRetention?: (
    entry: TelegramUpdateJournalEntry,
  ) => TelegramUpdateJournalPendingRetentionEvidence | undefined;
  abandonPending?: (
    input: TelegramUpdateJournalPendingAbandonmentInput,
  ) => TelegramUpdateJournalPendingAbandonmentResult;
  /** Optional strict observation; it must not recover, repair or grant new receipt authority. */
  isQueueReceiptCurrent?: (
    receipt: TelegramQueueAdmissionReceiptLike,
    owner: TelegramUpdateJournalQueueOwner,
  ) => boolean;
  /** Strict full-group origin observation for prepared partial scopes; no writer or readiness acquisition. */
  inspectQueuedReceipt?: (
    expected: TelegramUpdateJournalQueuedCompletion,
  ) => TelegramUpdateJournalQueuedReceiptEvidence | undefined;
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
  completeQueued: (
    receipts: readonly {
      queueKind: "prompt" | "control";
      receiptId: string;
      sourceUpdateIds: readonly number[];
      queueOwner: TelegramUpdateJournalQueueOwner;
    }[],
  ) => {
    removedUpdateIds: readonly number[];
  };
  completeQueuedExact?: (
    receipts: readonly {
      queueKind: "prompt" | "control";
      receiptId: string;
      sourceUpdateIds: readonly number[];
      queueOwner: TelegramUpdateJournalQueueOwner;
    }[],
    completions: readonly TelegramUpdateJournalSourceCompletion[],
  ) => {
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
  removeCompletedExact?: (
    updateIds: readonly number[],
    expectedSources: readonly TelegramUpdateJournalEntryDigest[],
    completions?: readonly TelegramUpdateJournalSourceCompletion[],
    isCurrent?: () => boolean,
  ) => {
    removedUpdateIds: readonly number[];
    sourceCompletions?: readonly TelegramUpdateJournalSourceCompletion[];
  };
  inspectSourceCompletion?: (
    expected: TelegramUpdateJournalSourceCompletion,
  ) => TelegramUpdateJournalSourceCompletion | undefined;
}

export type TelegramQueueSourceCompletion = TelegramDeferredSourceEvidence & {
  completionSha256: string;
};

function normalizeTelegramQueueSourceCompletions(
  value: unknown,
  sourceUpdateIds: ReadonlySet<number>,
  journalBindingKey: string,
  full = true,
): TelegramQueueSourceCompletion[] {
  if (
    !Array.isArray(value) ||
    (full
      ? value.length !== sourceUpdateIds.size
      : value.length > sourceUpdateIds.size) ||
    value.length === 0
  )
    throw new Error(
      "Telegram scoped queue completion requires full source coverage.",
    );
  const seen = new Set<number>(),
    scopes = new Set<string>();
  return value
    .map((source) => {
      if (
        !Number.isSafeInteger(source?.updateId) ||
        !sourceUpdateIds.has(source.updateId) ||
        seen.has(source.updateId)
      ) {
        throw new Error(
          "Telegram scoped queue completion has invalid source membership.",
        );
      }
      const normalized = validateTelegramUpdateAdmissionOutcome(
        { kind: "complete", expectedSource: source },
        source.updateId,
        sourceUpdateIds,
      );
      if (
        normalized.kind !== "complete" ||
        !normalized.expectedSource?.completionSha256 ||
        normalized.expectedSource.journalBindingKey !== journalBindingKey ||
        scopes.has(normalized.expectedSource.completionSha256)
      ) {
        throw new Error(
          "Telegram scoped queue completion has invalid source scope.",
        );
      }
      seen.add(source.updateId);
      scopes.add(normalized.expectedSource.completionSha256);
      return {
        ...normalized.expectedSource,
        completionSha256: normalized.expectedSource.completionSha256,
      };
    })
    .sort((a, b) => a.updateId - b.updateId);
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
  executeUpdate: (
    update: TelegramJournaledUpdate,
    ctx: TContext,
    signal: AbortSignal,
    target?: TelegramTarget & { threadId: number },
  ) => Promise<TelegramUpdateAdmissionOutcome> | TelegramUpdateAdmissionOutcome;
  /** Native source-only binding, installed by the admission-worker assembly rather than ordinary dispatch. */
  admitPreparedLiveInput?: (
    update: TelegramJournaledUpdate,
    ctx: TContext,
    signal: AbortSignal,
  ) => Promise<{ outcome: TelegramUpdateAdmissionOutcome; carrier: unknown }>;
  executeCustodiedUpdate?: (
    update: TelegramJournaledUpdate,
    ctx: TContext,
    signal: AbortSignal,
  ) => Promise<TelegramCustodiedExecutionResult>;
  hasAuthority: (ctx: TContext) => boolean;
  getJournalBindingKey?: () => string | undefined;
  getRecipientBindingKey?: () => string | undefined;
  /**
   * True selects legacy historical review/spending; retain protects unsupported originals without disposition
   * authority; revive re-admits a still-waiting chooser source as this generation's live input.
   */
  shouldReviewHistoricalInput?: (
    entry: TelegramUpdateJournalEntry,
    ctx: TContext,
    signal: AbortSignal,
  ) =>
    TelegramHistoricalReviewVerdict | Promise<TelegramHistoricalReviewVerdict>;
  /** New-world restart: spend unclocked classified routing input without delivery, copy or completion. Chooser clocks wait for expiry; interrupted private abandonment keeps exact recovery. */
  spendHistoricalInput?: boolean;
  /** Holds protected live or retry sources before execution; never cancels or disposes them. */
  shouldHoldPendingInput?: (
    entry: TelegramUpdateJournalEntry,
    ctx: TContext,
    signal: AbortSignal,
  ) => boolean | Promise<boolean>;
  getQueueOwnerIdentity?: (
    ctx: TContext,
  ) => TelegramUpdateJournalQueueOwnerIdentity;
  isContextCurrent?: (ctx: TContext) => boolean;
  createAbortController?: () => AbortController;
  getNowMs?: () => number;
  expireRoutingInput?: (
    source: TelegramRoutingInputExpirySource,
    ctx: TContext,
    signal: AbortSignal,
  ) => Promise<void> | void;
  retryPolicy?: Partial<TelegramUpdateRetryPolicy>;
  classifyExecutionFailure?: (
    error: unknown,
  ) => TelegramUpdateExecutionFailureClassification;
  settleTerminalExecutionFailure?: (error: unknown) => Promise<boolean>;
  scheduleRetry?: (callback: () => void, delayMs: number) => unknown;
  cancelRetry?: (handle: unknown) => void;
  batchSize?: number;
  yieldToEventLoop?: () => Promise<void>;
  onStateChange?: (state: TelegramUpdateWorkerStateSnapshot) => void;
  /** One nonblocking hint after a quiescent validated startup projection, never execution or deletion authority. */
  onHeldSourcesPrepared?: (
    input: TelegramHeldSourcePreparation<TContext>,
  ) => Promise<void> | void;
  /** Prepared readiness barrier after durable queue admission; never authorizes replay or source removal. */
  beforeQueueReceiptPublished?: (
    receipt: TelegramQueueAdmissionReceiptLike,
    queueOwner: TelegramUpdateJournalQueueOwner,
    ctx: TContext,
    isCurrent: () => boolean,
  ) =>
    | Promise<void | readonly TelegramQueueSourceCompletion[]>
    | void
    | readonly TelegramQueueSourceCompletion[];
  /** Post-ACK hint only; it must not request Pi dispatch or inherit a Workspace admission lease. */
  onQueueReceiptCompleted?: (
    receipt: TelegramQueueAdmissionReceiptLike,
    ctx: TContext,
  ) => void;
  onQueueReceiptCommitted?: (
    receipt: TelegramQueueAdmissionReceiptLike,
    ctx: TContext,
  ) => void;
  onUpdateCompleted?: (
    updateId: number,
    ctx: TContext,
    journalBindingKey?: string,
  ) => void;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export type TelegramQueueReceiptCompletionReason =
  "prompt-handoff" | "control-settlement" | "discard";

/** Read-only singleton hold projection; only the exact warm post-release admission carrier may supply completion. */
export interface TelegramLiveSourceCompletionReadiness {
  readonly snapshot: TelegramDeferredSourceSnapshot;
  /** Captured issuing owner/ports only; not a source disposition or canonical-release grant. */
  isCurrent(): boolean;
  bindCarrier(
    value: unknown,
  ): TelegramDeferredSourceCompletionPreparation | undefined;
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
  release(canRelease: () => boolean, target?: TelegramTarget & { threadId: number }): boolean;
  /** Ends a failed pre-append attempt only when no selected input was saved. */
  cancelEmpty(): boolean;
  /** One fenced removal of this never-dispatched recipient copy; unknown issuance cannot be retried. */
  discardSaved(
    canDiscard: () => boolean,
  ): "discarded" | "protected" | "unknown";
}
/** Routing owns continuation or positively released peer transfer; preparation never appends or reexecutes originals. */
export interface TelegramLiveDeferredInputPreparation extends Pick<
  TelegramLiveInputPreparation,
  "sourceUpdateIds" | "isCurrent" | "isOwnerCurrent" | "confirmSaved"
> {
  beginRelease(canRelease: () => boolean): boolean;
  /** One exact donor-group removal after routing confirms peer release; unknown issuance never retries. */
  settleTransferred(
    canSettle: () => boolean,
  ): "settled" | "protected" | "unknown";
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
  inspectReceipt(receipt: TelegramQueueAdmissionReceiptLike):
    | {
        source: TelegramDeferredSourceEvidence;
        receipt: TelegramUpdateJournalQueuedCompletion;
      }
    | undefined;
  /** Read-only original/queued-owner CAS scope for the existing pre-publication boundary; never readiness or disposal. */
  prepareCompletionScope(
    receipt: TelegramQueueAdmissionReceiptLike,
    queueOwner: TelegramUpdateJournalQueueOwner,
    completionSha256: string,
  ): TelegramQueueSourceCompletion | undefined;
  /** Exact previously observed receipt object's native whole-removal ACK; never admission, absence or another disposal. */
  inspectCompletion(
    receipt: TelegramQueueAdmissionReceiptLike,
  ): TelegramDeferredSourceEvidence | undefined;
}

export interface TelegramUpdateWorkerRuntime<TContext> {
  start: (ctx: TContext) => void;
  /** Reserve absent IDs before recipient append; existing leader deferred sources use their original carrier. */
  prepareLiveInput?: (
    ctx: TContext,
    sourceUpdateIds: readonly number[],
    isCurrent?: () => boolean,
  ) => TelegramLiveInputPreparation | undefined;
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
  }) =>
    | Pick<TelegramDeferredSourceCompletionPreparation, "source" | "isCurrent">
    | undefined;
  signal: () => void;
  settleDeferred: (input: {
    updateId: number;
    outcome: TelegramUpdateAdmissionOutcome;
    signal: AbortSignal;
  }) =>
    | void
    | TelegramDeferredSourceCompletion
    | Promise<void | TelegramDeferredSourceCompletion>;
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
  inspectAbandoning?: (
    input: TelegramDeferredAbandonmentRecoveryRequest & { signal: AbortSignal },
  ) => TelegramDeferredAbandonmentRecoveryPage | undefined;
  inspectHistorical?: (
    input: TelegramDeferredAbandonmentRecoveryRequest & { signal: AbortSignal },
  ) => TelegramDeferredAbandonmentRecoveryPage | undefined;
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
  abandonDeferred?: (
    input: TelegramDeferredUpdateAbandonmentAuthority & {
      updateId: number;
      signal: AbortSignal;
    },
  ) => TelegramUpdateJournalPendingAbandonmentResult | undefined;
  settleCustodied: (input: {
    updateId: number;
    result: TelegramCustodiedExecutionResult;
    signal: AbortSignal;
  }) => void;
  isQueueReceiptCommitted: (
    receipt: TelegramQueueAdmissionReceiptLike,
  ) => boolean;
  getQueueReceiptOwner: (
    receipt: TelegramQueueAdmissionReceiptLike,
  ) => TelegramUpdateJournalQueueOwner | undefined;
  /** Completion-only owner observation; issued attempts are never dispatch readiness. */
  getQueueReceiptSettlementOwner?: (
    receipt: TelegramQueueAdmissionReceiptLike,
    ctx: TContext,
    reason: TelegramQueueReceiptCompletionReason,
  ) => TelegramUpdateJournalQueueOwner | undefined;
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

class TelegramUpdateAdmissionOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramUpdateAdmissionOutcomeError";
  }
}

export interface TelegramLiveStatusConsumption {
  readonly source: TelegramDeferredSourceEvidence;
  assertCurrent(): void;
  bindCarrier(value: unknown): boolean;
  execute(): Promise<boolean>;
}

interface TelegramLiveInputPreparationState<TContext> {
  version: number;
  ids: ReadonlySet<number>;
  saved?: TelegramUpdateWorkerJournalSnapshot["entries"][number][];
  discardIssued?: true;
  released?: true;
  target?: TelegramTarget & { threadId: number };
  status?: {
    current(): boolean;
    assertCurrent(): void;
    bindCarrier(value: unknown): boolean;
    execute(): Promise<boolean>;
    admit: NonNullable<
      TelegramUpdateWorkerRuntimeDeps<TContext>["admitPreparedLiveInput"]
    >;
    issued?: true;
    carrier?: unknown;
  };
}
interface TelegramUpdateWorkerOwner<TContext> {
  generation: number;
  ctx: TContext;
  controller: AbortController;
  queueOwnerIdentity: TelegramUpdateJournalQueueOwnerIdentity;
  startupUpdateIds?: ReadonlySet<number>;
  heldSourcesPreparedIssued?: true;
}

type TelegramUpdateWorkerClaim =
  "deferred" | "queued" | "abandoning" | "historical" | "retained";
type TelegramUpdateWorkerDrainResult = "idle" | "blocked" | "aborted";
type TelegramUpdateWorkerExecutionSettlement =
  | { ok: true; outcome: TelegramUpdateAdmissionOutcome; custodied?: false }
  | { ok: true; outcome: TelegramCustodiedExecutionResult; custodied: true }
  | { ok: false; error: unknown };

const TELEGRAM_UPDATE_WORKER_EXECUTION_ABORTED = Symbol(
  "telegram.update-worker.execution-aborted",
);

/** The receipt's only journal entry when it is exactly this prompt update, queued unchanged under this owner. */
function findExactQueuedPromptEntry(
  snapshot: TelegramWorkerCoreSnapshot,
  receiptId: string,
  updateId: number,
  queueOwner: TelegramUpdateJournalQueueOwner,
  update: unknown,
): TelegramUpdateWorkerJournalSnapshot["entries"][number] | undefined {
  if (!isTelegramUpdateJournalLegacyFamilyVersion(snapshot.version))
    return undefined;
  const entries = snapshot.entries.filter(
    (entry) => entry.queueReceiptId === receiptId,
  );
  const entry = entries[0];
  return entries.length === 1 &&
    entry?.updateId === updateId &&
    entry.state === "queued" &&
    entry.queueKind === "prompt" &&
    !entry.queueHandoff &&
    isDeepStrictEqual(entry.queueOwner, queueOwner) &&
    isDeepStrictEqual(entry.update, update)
    ? entry
    : undefined;
}

export type TelegramHistoricalReviewVerdict = boolean | "retain" | "revive";

/** A saved chooser clock that proves an untouched, unexpired choice whose chooser message can be revived. */
export function isRevivableTelegramRoutingInput(
  entry: Pick<TelegramUpdateJournalEntry, "state" | "routingInput">,
  nowMs: number,
): boolean {
  const lifetime = entry.routingInput;
  return (
    entry.state === "pending" &&
    lifetime?.phase === "waiting" &&
    lifetime.chooser !== undefined &&
    nowMs < lifetime.expiresAtMs
  );
}

function getTelegramUpdateWorkerStateSnapshot(
  state: TelegramUpdateWorkerStateSnapshot,
): TelegramUpdateWorkerStateSnapshot {
  return { ...state };
}

function validateTelegramUpdateAdmissionOutcome(
  value: unknown,
  currentUpdateId: number,
  claimableUpdateIds: ReadonlySet<number>,
): TelegramUpdateAdmissionOutcome {
  if (!isTelegramUpdateAdmissionRecord(value)) {
    throw new TelegramUpdateAdmissionOutcomeError(
      `Telegram update ${currentUpdateId} returned no admission outcome.`,
    );
  }
  if (value.kind === "complete") {
    if (value.expectedSource === undefined) return { kind: "complete" };
    const source = value.expectedSource;
    if (
      !isTelegramUpdateAdmissionRecord(source) ||
      Object.keys(source).some(
        (key) =>
          ![
            "journalBindingKey",
            "updateId",
            "sourceSha256",
            "completionSha256",
          ].includes(key),
      ) ||
      source.updateId !== currentUpdateId ||
      !isTelegramUpdateAdmissionString(source.journalBindingKey) ||
      typeof source.sourceSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(source.sourceSha256) ||
      (source.completionSha256 !== undefined &&
        (typeof source.completionSha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(source.completionSha256)))
    ) {
      throw new TelegramUpdateAdmissionOutcomeError(
        `Telegram update ${currentUpdateId} returned an invalid completion source.`,
      );
    }
    return {
      kind: "complete",
      expectedSource: {
        journalBindingKey: source.journalBindingKey,
        updateId: currentUpdateId,
        sourceSha256: source.sourceSha256,
        ...(source.completionSha256 !== undefined
          ? { completionSha256: source.completionSha256 }
          : {}),
      },
    };
  }
  if (value.kind === "deferred") {
    if (value.routingReview !== undefined && value.routingReview !== true)
      throw new TelegramUpdateAdmissionOutcomeError(
        "Invalid historical review outcome.",
      );
    return {
      kind: "deferred",
      ...(value.routingReview === true ? { routingReview: true } : {}),
    };
  }
  if (value.kind === "queued") {
    if (
      (value.queueKind !== "prompt" && value.queueKind !== "control") ||
      !isTelegramUpdateAdmissionString(value.receiptId) ||
      !Array.isArray(value.sourceUpdateIds) ||
      value.sourceUpdateIds.length === 0 ||
      !value.sourceUpdateIds.every(
        (updateId) =>
          Number.isSafeInteger(updateId) &&
          (updateId as number) >= 0 &&
          claimableUpdateIds.has(updateId as number),
      )
    ) {
      throw new TelegramUpdateAdmissionOutcomeError(
        `Telegram update ${currentUpdateId} returned an invalid queue receipt.`,
      );
    }
    const sourceUpdateIds = [...new Set(value.sourceUpdateIds as number[])];
    if (
      sourceUpdateIds.length !== value.sourceUpdateIds.length ||
      !sourceUpdateIds.includes(currentUpdateId)
    ) {
      throw new TelegramUpdateAdmissionOutcomeError(
        `Telegram update ${currentUpdateId} returned a mismatched queue receipt.`,
      );
    }
    return {
      kind: "queued",
      queueKind: value.queueKind,
      receiptId: value.receiptId,
      sourceUpdateIds,
    };
  }
  throw new TelegramUpdateAdmissionOutcomeError(
    `Telegram update ${currentUpdateId} returned an unknown admission outcome.`,
  );
}

function normalizeTelegramUpdateRetryPolicy(
  input: Partial<TelegramUpdateRetryPolicy> | undefined,
): TelegramUpdateRetryPolicy {
  const policy = {
    baseDelayMs: input?.baseDelayMs ?? TELEGRAM_UPDATE_RETRY_BASE_DELAY_MS,
    maxDelayMs: input?.maxDelayMs ?? TELEGRAM_UPDATE_RETRY_MAX_DELAY_MS,
  };
  if (
    !Number.isSafeInteger(policy.baseDelayMs) ||
    policy.baseDelayMs <= 0 ||
    !Number.isSafeInteger(policy.maxDelayMs) ||
    policy.maxDelayMs < policy.baseDelayMs
  ) {
    throw new Error("Telegram update retry policy is invalid.");
  }
  return policy;
}

function normalizeTelegramUpdateFailureClass(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, TELEGRAM_UPDATE_JOURNAL_FAILURE_CLASS_MAX_LENGTH);
  return normalized || "execution-error";
}

function normalizeTelegramUpdateFailureSummary(value: string): string {
  const normalized = value
    .trim()
    .slice(0, TELEGRAM_UPDATE_JOURNAL_FAILURE_SUMMARY_MAX_LENGTH);
  return normalized || "Telegram update execution failed.";
}

function classifyTelegramUpdateExecutionFailure(
  error: unknown,
): TelegramUpdateExecutionFailureClassification {
  if (error instanceof TelegramForeignUpdateSettlementError) {
    return {
      disposition:
        error.settlement.status === "retryable" ? "retryable" : "terminal",
      failureClass: normalizeTelegramUpdateFailureClass(
        error.settlement.failureClass,
      ),
      summary: normalizeTelegramUpdateFailureSummary(error.settlement.message),
    };
  }
  const errorName =
    error instanceof Error && error.name ? error.name : "UnknownError";
  return {
    disposition: "retryable",
    failureClass: normalizeTelegramUpdateFailureClass(`execution-${errorName}`),
    summary: normalizeTelegramUpdateFailureSummary(
      `${errorName}: Telegram update execution failed.`,
    ),
  };
}

function getTelegramUpdateRetryDelayMs(
  attemptCount: number,
  policy: TelegramUpdateRetryPolicy,
): number {
  const multiplier = 2 ** Math.max(0, attemptCount - 1);
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * multiplier);
}

function scheduleTelegramUpdateRetry(
  callback: () => void,
  delayMs: number,
): ReturnType<typeof setTimeout> {
  const handle = setTimeout(callback, delayMs);
  handle.unref?.();
  return handle;
}

function normalizeTelegramUpdateQueueOwnerIdentity(
  value: TelegramUpdateJournalQueueOwnerIdentity,
): TelegramUpdateJournalQueueOwnerIdentity {
  if (
    typeof value.instanceId !== "string" ||
    value.instanceId.length === 0 ||
    value.instanceId.length >
      TELEGRAM_UPDATE_JOURNAL_QUEUE_OWNER_ID_MAX_LENGTH ||
    !Number.isSafeInteger(value.processId) ||
    value.processId <= 0 ||
    typeof value.processBirthId !== "string" ||
    value.processBirthId.length === 0 ||
    value.processBirthId.length >
      TELEGRAM_UPDATE_JOURNAL_QUEUE_OWNER_ID_MAX_LENGTH ||
    !Number.isSafeInteger(value.sessionGeneration) ||
    value.sessionGeneration <= 0
  ) {
    throw new Error("Telegram update queue owner identity is invalid.");
  }
  return { ...value };
}

/** Clear claim, retry and failure projections after the worker forgets its local claims. */
function clearTelegramUpdateWorkerClaimState(
  state: TelegramUpdateWorkerStateSnapshot,
  unsettledExecutionCount: number,
): void {
  state.deferredClaimCount = 0;
  delete state.abandoningClaimCount;
  delete state.historicalClaimCount;
  state.queuedClaimCount = 0;
  state.foreignQueuedCount = 0;
  delete state.foreignQueuedOwner;
  state.retryWaitCount = 0;
  state.failedCount = 0;
  state.nextRetryUpdateId = undefined;
  state.nextRetryAtMs = undefined;
  state.nextRetryAttemptCount = undefined;
  state.nextRetryFailureClass = undefined;
  state.failedUpdateId = undefined;
  state.failedFailureId = undefined;
  state.failedAttemptCount = undefined;
  state.failedClass = undefined;
  state.failedSummary = undefined;
  state.terminalFailureAtMs = undefined;
  state.unsettledExecutionCount = unsettledExecutionCount;
}

const ORDINARY_V4_EXECUTION_KEY = Symbol("ordinary-v4-execution");
type TelegramOrdinaryV4Purpose = "continue" | "text-prompt";
class OrdinaryV4Execution {
  #candidate: TelegramOrdinaryV4InputCandidate;
  #message: object;
  #assertCurrent: () => void;
  #binding: TelegramUpdateAdmissionBinding;
  #fence: TelegramUpdateExecutionFence;
  #invalid = false;
  #purpose: TelegramOrdinaryV4Purpose;
  #content?: object;
  constructor(key: symbol, purpose: TelegramOrdinaryV4Purpose, candidate: TelegramOrdinaryV4InputCandidate, message: object, assertCurrent: () => void) {
    if (key !== ORDINARY_V4_EXECUTION_KEY) throw new Error("Ordinary execution requires its native owner.");
    const binding = getTelegramUpdateAdmissionBinding(message), fence = getTelegramUpdateExecutionFence(message);
    if (!binding || !fence || binding.sourceUpdateId !== candidate.source.updateId ||
      binding.journalBindingKey !== candidate.source.journalBindingKey) throw new Error("Ordinary execution has no native carrier.");
    this.#purpose = purpose; this.#candidate = candidate; this.#message = message; this.#assertCurrent = assertCurrent;
    this.#binding = binding; this.#fence = fence;
    if (purpose === "text-prompt") this.#content = structuredClone(message);
    Object.freeze(this);
  }
  #contentCurrent(): boolean {
    return this.#purpose !== "text-prompt" || isDeepStrictEqual(structuredClone(this.#message), this.#content);
  }
  read(candidate: TelegramOrdinaryV4InputCandidate, purpose: TelegramOrdinaryV4Purpose = "continue"): object {
    try {
      if (this.#invalid || purpose !== this.#purpose || candidate !== this.#candidate || getTelegramUpdateAdmissionBinding(this.#message) !== this.#binding ||
        getTelegramUpdateExecutionFence(this.#message) !== this.#fence || !this.#contentCurrent()) throw new Error("Ordinary execution association changed.");
      this.#assertCurrent(); this.#fence.assertCurrent();
      if (this.#invalid || getTelegramUpdateAdmissionBinding(this.#message) !== this.#binding ||
        getTelegramUpdateExecutionFence(this.#message) !== this.#fence || !this.#contentCurrent()) throw new Error("Ordinary execution carrier changed.");
      return this.#message;
    } catch (error) { this.#invalid = true; throw error; }
  }
}
export type TelegramOrdinaryV4Execution = OrdinaryV4Execution;
export function readTelegramOrdinaryV4Execution(execution: TelegramOrdinaryV4Execution, candidate: TelegramOrdinaryV4InputCandidate): object {
  return OrdinaryV4Execution.prototype.read.call(execution, candidate, "continue");
}
export function readTelegramOrdinaryV4TextExecution(execution: TelegramOrdinaryV4Execution, candidate: TelegramOrdinaryV4InputCandidate): object {
  return OrdinaryV4Execution.prototype.read.call(execution, candidate, "text-prompt");
}
type TelegramWorkerCoreSnapshot = TelegramUpdateWorkerJournalSnapshot | TelegramUpdateJournalSnapshot<4>;
type TelegramWorkerCoreJournal = Omit<TelegramUpdateWorkerJournalPort, "read"> & { read(): TelegramWorkerCoreSnapshot };
type TelegramWorkerCoreDeps<TContext> = Omit<TelegramUpdateWorkerRuntimeDeps<TContext>, "journal"> & { journal: TelegramWorkerCoreJournal };
interface TelegramOrdinaryV4WorkerPolicy {
  getAdmissibleIds(): ReadonlySet<number>;
  canReconstruct(receipt: TelegramUpdateJournalQueuedCompletion): boolean;
}

export function createTelegramUpdateWorkerRuntime<TContext>(
  deps: TelegramUpdateWorkerRuntimeDeps<TContext>,
): TelegramUpdateWorkerRuntime<TContext> {
  return createTelegramUpdateWorkerCore(deps);
}

function createTelegramUpdateWorkerCore<TContext>(
  deps: TelegramWorkerCoreDeps<TContext>, ordinaryV4?: TelegramOrdinaryV4WorkerPolicy,
): TelegramUpdateWorkerRuntime<TContext> {
  if ((deps.scheduleRetry === undefined) !== (deps.cancelRetry === undefined)) {
    throw new Error(
      "Telegram update retry scheduling requires matching schedule and cancel ports.",
    );
  }
  const getNowMs = deps.getNowMs ?? Date.now;
  const onHeldSourcesPrepared = deps.onHeldSourcesPrepared;
  const spendHistorical = deps.spendHistoricalInput === true;
  const routingJournal = deps.journal.routingInputs;
  const armRouting = routingJournal?.arm.bind(routingJournal);
  const selectRouting = routingJournal?.select.bind(routingJournal);
  const expireRouting = routingJournal?.expire.bind(routingJournal);
  const expireRoutingObserver = deps.expireRoutingInput;
  const batchSize = deps.batchSize ?? TELEGRAM_UPDATE_WORKER_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new Error("Telegram update worker batch size must be positive.");
  }
  const yieldToEventLoop =
    deps.yieldToEventLoop ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const queueCompletionPort = deps.journal.completeQueuedExact;
  const completionReaderPort = deps.journal.inspectSourceCompletion;
  const completeQueuedExact = queueCompletionPort?.bind(deps.journal);
  const completeExact = deps.journal.removeCompletedExact?.bind(deps.journal);
  const inspectCompletion = completionReaderPort?.bind(deps.journal);
  const observeQueuedCompletion = deps.onQueueReceiptCompleted;
  const fallbackQueueOwnerInstanceId = `worker-${randomUUID()}`;
  const fallbackQueueOwnerProcessId = process.pid > 0 ? process.pid : 1;
  const createAbortController =
    deps.createAbortController ?? (() => new AbortController());
  const retryPolicy = normalizeTelegramUpdateRetryPolicy(deps.retryPolicy);
  const scheduleRetry = deps.scheduleRetry ?? scheduleTelegramUpdateRetry;
  const cancelRetry =
    deps.cancelRetry ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  const resolveQueueOwnerIdentity = (
    ctx: TContext,
    generation: number,
  ): TelegramUpdateJournalQueueOwnerIdentity =>
    normalizeTelegramUpdateQueueOwnerIdentity(
      deps.getQueueOwnerIdentity?.(ctx) ?? {
        instanceId: fallbackQueueOwnerInstanceId,
        processId: fallbackQueueOwnerProcessId,
        processBirthId: `${fallbackQueueOwnerProcessId}:${fallbackQueueOwnerInstanceId}`,
        sessionGeneration: generation,
      },
    );
  const isQueueOwnerIdentityCurrent = (
    expected: TelegramUpdateWorkerOwner<TContext>,
  ): boolean => {
    if (!deps.getQueueOwnerIdentity) return true;
    const live = deps.getQueueOwnerIdentity(expected.ctx),
      captured = expected.queueOwnerIdentity;
    return (
      !!live &&
      live.instanceId === captured.instanceId &&
      live.processId === captured.processId &&
      live.processBirthId === captured.processBirthId &&
      live.sessionGeneration === captured.sessionGeneration
    );
  };
  const state: TelegramUpdateWorkerStateSnapshot = {
    phase: "stopped",
    generation: 0,
    journalEntryCount: 0,
    journalSerializedBytes: 0,
    deferredClaimCount: 0,
    queuedClaimCount: 0,
    foreignQueuedCount: 0,
    retryWaitCount: 0,
    failedCount: 0,
    unsettledExecutionCount: 0,
  };
  const claims = new Map<number, TelegramUpdateWorkerClaim>();
  const deferredSources = new Map<
    number,
    {
      entry: TelegramUpdateWorkerJournalSnapshot["entries"][number];
      journalBindingKey: string;
      historical?: true;
      liveReleaseIssued?: true;
    }
  >();
  const unsettledExecutionsByUpdateId = new Map<
    number,
    Set<Promise<TelegramUpdateWorkerExecutionSettlement>>
  >();
  const committedQueueReceipts = new Map<
    string,
    {
      receipt: TelegramQueueAdmissionReceiptLike;
      queueOwner: TelegramUpdateJournalQueueOwner;
      sourceCompletions?: TelegramQueueSourceCompletion[];
    }
  >();
  const requiredScopedQueueReceipts = new Set<string>();
  const scopedQueueCompletionAttempts = new Map<
    string,
    {
      owner: TelegramUpdateWorkerOwner<TContext>;
      journalBindingKey: string;
      reason: TelegramQueueReceiptCompletionReason;
      receipts: {
        queueKind: "prompt" | "control";
        receiptId: string;
        sourceUpdateIds: readonly number[];
        queueOwner: TelegramUpdateJournalQueueOwner;
      }[];
      completions: TelegramUpdateJournalSourceCompletion[];
    }
  >();
  const unsettledExecutions = new Set<
    Promise<TelegramUpdateWorkerExecutionSettlement>
  >();
  let owner: TelegramUpdateWorkerOwner<TContext> | undefined;
  let livePreparation: TelegramLiveInputPreparationState<TContext> | undefined;
  let drainPromise: Promise<void> | undefined;
  let pendingSignal = false;
  let blocked = false;
  let nextGeneration = 0;
  let retryTimer: unknown;
  let retryTimerAtMs: number | undefined;
  let retryTimerToken: object | undefined;
  let routingTimer: unknown;
  let routingTimerToken: object | undefined;
  let launchDrain: () => void = () => {};

  const recordRuntimeEvent = (
    error: unknown,
    details: Record<string, unknown>,
  ): void => {
    try {
      deps.recordRuntimeEvent?.("inbound-worker", error, details);
    } catch {
      // Diagnostics cannot own or terminate worker progress.
    }
  };

  const notifyStateChange = (): void => {
    try {
      deps.onStateChange?.(getTelegramUpdateWorkerStateSnapshot(state));
    } catch (error) {
      recordRuntimeEvent(error, { phase: "state-observer" });
    }
  };

  /** Fresh live input this generation admitted itself: not startup history, no live release issued, not executing. */
  const isFreshLiveSource = (
    sourceOwner: TelegramUpdateWorkerOwner<TContext>,
    updateId: number,
  ): boolean => {
    const source = deferredSources.get(updateId);
    return (
      !sourceOwner.startupUpdateIds?.has(updateId) &&
      !source?.historical &&
      !source?.liveReleaseIssued &&
      !unsettledExecutionsByUpdateId.has(updateId)
    );
  };
  const updateClaimCounts = (): void => {
    let deferredClaimCount = 0;
    let queuedClaimCount = 0;
    let abandoningClaimCount = 0;
    let historicalClaimCount = 0;
    for (const claim of claims.values()) {
      if (claim === "queued") queuedClaimCount += 1;
      else deferredClaimCount += 1;
      if (claim === "abandoning") abandoningClaimCount += 1;
      if (claim === "historical" || claim === "retained")
        historicalClaimCount += 1;
    }
    state.deferredClaimCount = deferredClaimCount;
    state.queuedClaimCount = queuedClaimCount;
    if (abandoningClaimCount > 0)
      state.abandoningClaimCount = abandoningClaimCount;
    else delete state.abandoningClaimCount;
    if (historicalClaimCount > 0)
      state.historicalClaimCount = historicalClaimCount;
    else delete state.historicalClaimCount;
    if (livePreparation && !livePreparation.released)
      state.preparedInputCount = livePreparation.ids.size;
    else delete state.preparedInputCount;
  };

  const releaseDeferredClaims = (updateIds: readonly number[]): void => {
    let changed = false;
    for (const updateId of updateIds) {
      if (claims.get(updateId) !== "deferred") continue;
      claims.delete(updateId);
      deferredSources.delete(updateId);
      changed = true;
    }
    if (!changed) return;
    updateClaimCounts();
    notifyStateChange();
  };

  const transition = (
    phase: TelegramUpdateWorkerPhase,
    currentUpdateId?: number,
    blockedReason?: TelegramUpdateWorkerBlockedReason,
  ): void => {
    state.phase = phase;
    state.phaseStartedAtMs = getNowMs();
    state.currentUpdateId = currentUpdateId;
    state.blockedReason = phase === "blocked" ? blockedReason : undefined;
    state.unsettledExecutionCount = unsettledExecutions.size;
    updateClaimCounts();
    notifyStateChange();
  };

  const blockWithFailure = (
    blockedReason: Exclude<TelegramUpdateWorkerBlockedReason, "authority-lost">,
    failurePhase: string,
    error: unknown,
    currentUpdateId?: number,
    extraDetails?: Record<string, unknown>,
  ): "blocked" => {
    blocked = true;
    state.lastFailureAtMs = getNowMs();
    state.lastFailurePhase = failurePhase;
    recordRuntimeEvent(error, {
      phase: failurePhase,
      generation: owner?.generation,
      ...(currentUpdateId !== undefined ? { updateId: currentUpdateId } : {}),
      ...extraDetails,
    });
    transition("blocked", currentUpdateId, blockedReason);
    return "blocked";
  };

  const normalizeQueueReceipt = (
    receipt: TelegramQueueAdmissionReceiptLike,
  ): TelegramQueueAdmissionReceiptLike => ({
    queueKind: receipt.queueKind,
    receiptId: receipt.receiptId,
    sourceUpdateIds: [...receipt.sourceUpdateIds].sort(
      (left, right) => left - right,
    ),
    ...(receipt.journalBindingKey
      ? { journalBindingKey: receipt.journalBindingKey }
      : {}),
  });
  const bindQueueReceiptToJournal = (
    receipt: TelegramQueueAdmissionReceiptLike,
  ): TelegramQueueAdmissionReceiptLike => ({
    ...normalizeQueueReceipt(receipt),
    ...(deps.getJournalBindingKey?.()
      ? { journalBindingKey: deps.getJournalBindingKey() }
      : {}),
  });

  const queueAdmissionJournal = deps.journal;
  const queueAdmissionRead = queueAdmissionJournal.read,
    queueAdmissionCommit = queueAdmissionJournal.markQueued;
  const queueAdmissionInspect = deps.journal.isQueueReceiptCurrent;
  const inspectQueueReceipt = queueAdmissionInspect?.bind(deps.journal);
  const inspectQueuedSources = deps.journal.inspectQueuedReceipt?.bind(
    deps.journal,
  );
  const prepareQueueReceipt = deps.beforeQueueReceiptPublished;
  const pendingQueuePublications = new Map<
    string,
    {
      receipt: TelegramQueueAdmissionReceiptLike;
      queueOwner: TelegramUpdateJournalQueueOwner;
      owner: TelegramUpdateWorkerOwner<TContext>;
      task: Promise<void>;
    }
  >();
  const publishCommittedQueueReceipt = async (
    receipt: TelegramQueueAdmissionReceiptLike,
    queueOwner: TelegramUpdateJournalQueueOwner,
    expectedOwner: TelegramUpdateWorkerOwner<TContext>,
  ): Promise<boolean> => {
    const ctx = expectedOwner.ctx;
    if (ordinaryV4 && !prepareQueueReceipt) throw new Error("Ordinary v4 requires complete prepared queue scopes.");
    let sourceCompletions: TelegramQueueSourceCompletion[] | undefined;
    const normalized = bindQueueReceiptToJournal(receipt);
    const existing = committedQueueReceipts.get(receipt.receiptId);
    if (existing) {
      if (
        !areTelegramQueueAdmissionReceiptsEqual(existing.receipt, normalized) ||
        !areTelegramUpdateJournalQueueOwnersEqual(
          existing.queueOwner,
          queueOwner,
        )
      ) {
        throw new TelegramUpdateAdmissionOutcomeError(
          `Telegram queue receipt ${receipt.receiptId} has conflicting committed authority.`,
        );
      }
      return false;
    }
    if (prepareQueueReceipt) {
      const pending = pendingQueuePublications.get(normalized.receiptId);
      if (pending) {
        if (
          pending.owner !== expectedOwner ||
          !areTelegramQueueAdmissionReceiptsEqual(
            pending.receipt,
            normalized,
          ) ||
          !areTelegramUpdateJournalQueueOwnersEqual(
            pending.queueOwner,
            queueOwner,
          )
        ) {
          throw new TelegramUpdateAdmissionOutcomeError(
            "Telegram queue publication has conflicting in-flight authority.",
          );
        }
        await pending.task;
        return false;
      }
      const journalBindingKey = deps.getJournalBindingKey?.();
      const current = (): boolean =>
        owner === expectedOwner &&
        !expectedOwner.controller.signal.aborted &&
        deps.hasAuthority(ctx) &&
        deps.isContextCurrent?.(ctx) !== false &&
        isQueueOwnerIdentityCurrent(expectedOwner) &&
        deps.getJournalBindingKey?.() === journalBindingKey &&
        (!ordinaryV4 || ordinaryV4.canReconstruct({ queueKind: normalized.queueKind, receiptId: normalized.receiptId,
          sourceUpdateIds: [...normalized.sourceUpdateIds], queueOwner: { ...queueOwner } }));
      if (
        !journalBindingKey ||
        !current() ||
        !inspectQueueReceipt ||
        inspectQueueReceipt(normalizeQueueReceipt(normalized), {
          ...queueOwner,
        }) !== true ||
        !current()
      ) {
        throw new TelegramUpdateAdmissionOutcomeError(
          "Telegram queue publication requires exact current receipt inspection.",
        );
      }
      const task = Promise.resolve()
        .then(async () => {
          if (!current())
            throw new TelegramUpdateAdmissionOutcomeError(
              "Telegram queue publication authority ended before acceptance.",
            );
          const prepared = await prepareQueueReceipt(
            normalizeQueueReceipt(normalized),
            { ...queueOwner },
            ctx,
            current,
          );
          if (ordinaryV4 && prepared === undefined) throw new Error("Ordinary v4 queue scope preparation was not acknowledged.");
          if (prepared !== undefined) {
            sourceCompletions = normalizeTelegramQueueSourceCompletions(
              prepared,
              new Set(normalized.sourceUpdateIds),
              journalBindingKey,
              ordinaryV4 !== undefined,
            );
            if (!completeQueuedExact || !inspectCompletion)
              throw new Error(
                "Telegram scoped queue terminal capabilities are unavailable.",
              );
            if (
              sourceCompletions.length !== normalized.sourceUpdateIds.length
            ) {
              if (!current() || !inspectQueuedSources)
                throw new Error(
                  "Telegram partial queue scopes require strict current whole-receipt origin inspection.",
                );
              const expected = {
                queueKind: normalized.queueKind,
                receiptId: normalized.receiptId,
                sourceUpdateIds: [...normalized.sourceUpdateIds],
                queueOwner: { ...queueOwner },
              };
              const proof = inspectQueuedSources(structuredClone(expected));
              if (
                !current() ||
                !proof ||
                !isDeepStrictEqual(proof.receipt, expected) ||
                !Array.isArray(proof.sources) ||
                proof.sources.length !== expected.sourceUpdateIds.length ||
                proof.sources.some(
                  (source, index) =>
                    source.updateId !== expected.sourceUpdateIds[index] ||
                    typeof source.sourceSha256 !== "string" ||
                    !/^[a-f0-9]{64}$/u.test(source.sourceSha256),
                ) ||
                sourceCompletions.some(
                  (scope) =>
                    proof.sources.find(
                      (source) => source.updateId === scope.updateId,
                    )?.sourceSha256 !== scope.sourceSha256,
                )
              ) {
                throw new Error(
                  "Telegram partial queue scope origin was not confirmed under whole-receipt authority.",
                );
              }
            }
            for (const {
              journalBindingKey: _binding,
              ...completion
            } of sourceCompletions) {
              if (
                !current() ||
                inspectCompletion({ ...completion }) !== undefined ||
                !current()
              ) {
                throw new Error(
                  "Telegram queued source completion authority is contradictory.",
                );
              }
            }
          }
          if (
            !current() ||
            inspectQueueReceipt(normalizeQueueReceipt(normalized), {
              ...queueOwner,
            }) !== true ||
            !current()
          ) {
            throw new TelegramUpdateAdmissionOutcomeError(
              "Telegram queue publication authority changed after acceptance.",
            );
          }
          publishReady();
        })
        .finally(() => {
          if (pendingQueuePublications.get(normalized.receiptId)?.task === task)
            pendingQueuePublications.delete(normalized.receiptId);
        });
      pendingQueuePublications.set(normalized.receiptId, {
        receipt: normalizeQueueReceipt(normalized),
        queueOwner: { ...queueOwner },
        owner: expectedOwner,
        task,
      });
      await task;
      return true;
    }
    publishReady();
    return true;

    function publishReady(): void {
      committedQueueReceipts.set(receipt.receiptId, {
        receipt: normalized,
        queueOwner: { ...queueOwner },
        ...(sourceCompletions
          ? {
              sourceCompletions: sourceCompletions.map((value) => ({
                ...value,
              })),
            }
          : {}),
      });
      if (sourceCompletions) requiredScopedQueueReceipts.add(receipt.receiptId);
      try {
        deps.onQueueReceiptCommitted?.(normalizeQueueReceipt(normalized), ctx);
      } catch (error) {
        recordRuntimeEvent(error, {
          phase: "queue-receipt-observer",
          receiptId: normalized.receiptId,
        });
      }
    }
  };

  const getCurrentQueueReceipt = (
    receipt: TelegramQueueAdmissionReceiptLike,
  ) => {
    if (scopedQueueCompletionAttempts.has(receipt.receiptId)) return undefined;
    const committed = committedQueueReceipts.get(receipt.receiptId);
    if (
      !committed ||
      !areTelegramQueueAdmissionReceiptsEqual(
        committed.receipt,
        normalizeQueueReceipt(receipt),
      )
    )
      return undefined;
    try {
      if (
        inspectQueueReceipt &&
        inspectQueueReceipt(normalizeQueueReceipt(committed.receipt), {
          ...committed.queueOwner,
        }) !== true
      ) {
        return undefined;
      }
    } catch (error) {
      recordRuntimeEvent(error, { phase: "queue-receipt-observation" });
      return undefined;
    }
    return committed;
  };

  const clearRetryTimer = (): void => {
    if (retryTimer !== undefined) cancelRetry(retryTimer);
    retryTimer = undefined;
    retryTimerAtMs = undefined;
    retryTimerToken = undefined;
  };

  const scheduleNextRetry = (
    nextRetryAtMs: number | undefined,
    expectedOwner: TelegramUpdateWorkerOwner<TContext>,
  ): void => {
    if (nextRetryAtMs === undefined) {
      clearRetryTimer();
      return;
    }
    if (retryTimer !== undefined && retryTimerAtMs === nextRetryAtMs) {
      return;
    }
    clearRetryTimer();
    const token = {};
    retryTimerAtMs = nextRetryAtMs;
    retryTimerToken = token;
    retryTimer = scheduleRetry(
      () => {
        if (retryTimerToken !== token) return;
        retryTimer = undefined;
        retryTimerAtMs = undefined;
        retryTimerToken = undefined;
        if (
          owner !== expectedOwner ||
          expectedOwner.controller.signal.aborted
        ) {
          return;
        }
        pendingSignal = true;
        launchDrain();
      },
      Math.max(0, nextRetryAtMs - getNowMs()),
    );
  };

  const refreshJournalState = async (
    snapshot: TelegramWorkerCoreSnapshot,
    expectedOwner: TelegramUpdateWorkerOwner<TContext>,
  ): Promise<number | undefined> => {
    // Validate the whole snapshot before reconstructing any queue authority.
    if (
      (snapshot.version === 4 ? !ordinaryV4 :
        snapshot.version !== TELEGRAM_UPDATE_JOURNAL_VERSION &&
        snapshot.version !== TELEGRAM_UPDATE_JOURNAL_EXCLUSION_VERSION &&
        snapshot.version !== TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION) ||
      ((snapshot.version === TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION || snapshot.version === 4) &&
        !deps.executeCustodiedUpdate) ||
      snapshot.entries.some(
        (entry) =>
          ((snapshot.version === TELEGRAM_UPDATE_JOURNAL_EXCLUSION_VERSION ||
            entry.preApprovalExcluded !== undefined) &&
            typeof entry.preApprovalExcluded !== "boolean") ||
          (entry.preApprovalExcluded === true && entry.state === "queued"),
      )
    ) {
      throw new TelegramUpdateAdmissionOutcomeError(
        "Telegram journal snapshot has invalid pairing exclusion evidence.",
      );
    }
    const ordinaryQueuedIds = new Set<number>();
    if (ordinaryV4) {
      const groups = new Map<string, TelegramUpdateJournalQueuedCompletion>();
      for (const entry of snapshot.entries) {
        if (entry.state !== "queued" || !entry.queueReceiptId || !entry.queueKind || !entry.queueOwner) continue;
        const group = groups.get(entry.queueReceiptId);
        if (group) group.sourceUpdateIds = [...group.sourceUpdateIds, entry.updateId];
        else groups.set(entry.queueReceiptId, { queueKind: entry.queueKind, receiptId: entry.queueReceiptId,
          sourceUpdateIds: [entry.updateId], queueOwner: { ...entry.queueOwner } });
      }
      for (const group of groups.values()) if (ordinaryV4.canReconstruct(group))
        for (const id of group.sourceUpdateIds) ordinaryQueuedIds.add(id);
    }
    const availableUpdateIds = new Set<number>();
    const queuedReceiptEntries = new Map<
      string,
      {
        queueKind: "prompt" | "control";
        sourceUpdateIds: number[];
        queueOwner: TelegramUpdateJournalQueueOwner;
      }
    >();
    const locallyOwnedQueuedUpdateIds = new Set<number>();
    let foreignQueuedCount = 0;
    let foreignQueuedOwner: TelegramUpdateJournalQueueOwner | undefined;
    let oldestAdmittedAtMs: number | undefined;
    let retryWaitCount = 0;
    let scheduledRetryAtMs: number | undefined;
    let nextRetry:
      TelegramUpdateWorkerJournalSnapshot["entries"][number] | undefined;
    let failedCount = 0;
    let latestFailure:
      TelegramUpdateWorkerJournalSnapshot["entries"][number] | undefined;
    for (const entry of snapshot.entries) {
      availableUpdateIds.add(entry.updateId);
      oldestAdmittedAtMs =
        oldestAdmittedAtMs === undefined
          ? entry.admittedAtMs
          : Math.min(oldestAdmittedAtMs, entry.admittedAtMs);
      if (
        !ordinaryV4 && entry.state === "retry-wait" &&
        entry.nextRetryAtMs !== undefined &&
        !claims.has(entry.updateId)
      ) {
        scheduledRetryAtMs =
          scheduledRetryAtMs === undefined
            ? entry.nextRetryAtMs
            : Math.min(scheduledRetryAtMs, entry.nextRetryAtMs);
      }
      if (
        entry.state === "retry-wait" &&
        entry.failure !== undefined &&
        entry.nextRetryAtMs !== undefined
      ) {
        retryWaitCount += 1;
        if (
          !nextRetry ||
          nextRetry.nextRetryAtMs === undefined ||
          entry.nextRetryAtMs < nextRetry.nextRetryAtMs ||
          (entry.nextRetryAtMs === nextRetry.nextRetryAtMs &&
            entry.updateId < nextRetry.updateId)
        ) {
          nextRetry = entry;
        }
      }
      if (
        entry.state === "failed" &&
        entry.failure !== undefined &&
        entry.terminalAtMs !== undefined
      ) {
        failedCount += 1;
        if (
          !latestFailure ||
          latestFailure.terminalAtMs === undefined ||
          entry.terminalAtMs > latestFailure.terminalAtMs ||
          (entry.terminalAtMs === latestFailure.terminalAtMs &&
            entry.updateId > latestFailure.updateId)
        ) {
          latestFailure = entry;
        }
      }
      if (entry.state !== "queued") continue;
      if (!entry.queueKind || !entry.queueReceiptId) {
        throw new TelegramUpdateAdmissionOutcomeError(
          `Telegram queued update ${entry.updateId} has no receipt metadata.`,
        );
      }
      if (
        entry.queueHandoff ||
        !entry.queueOwner ||
        (ordinaryV4 !== undefined && !ordinaryQueuedIds.has(entry.updateId)) ||
        !isTelegramUpdateJournalQueueOwnerProcess(
          entry.queueOwner,
          expectedOwner.queueOwnerIdentity,
        )
      ) {
        foreignQueuedCount += 1;
        foreignQueuedOwner ??= entry.queueOwner;
        continue;
      }
      locallyOwnedQueuedUpdateIds.add(entry.updateId);
      claims.set(entry.updateId, "queued");
      const receipt = queuedReceiptEntries.get(entry.queueReceiptId);
      if (
        receipt &&
        (receipt.queueKind !== entry.queueKind ||
          !areTelegramUpdateJournalQueueOwnersEqual(
            receipt.queueOwner,
            entry.queueOwner,
          ))
      ) {
        throw new TelegramUpdateAdmissionOutcomeError(
          `Telegram queue receipt ${entry.queueReceiptId} has conflicting authority.`,
        );
      }
      if (receipt) receipt.sourceUpdateIds.push(entry.updateId);
      else {
        queuedReceiptEntries.set(entry.queueReceiptId, {
          queueKind: entry.queueKind,
          sourceUpdateIds: [entry.updateId],
          queueOwner: { ...entry.queueOwner },
        });
      }
    }
    // Snapshot absence is not an ACK. Keep the live issuer's whole attempt frozen until exact reconciliation.
    const frozenQueuedUpdateIds = new Set(
      [...new Set(scopedQueueCompletionAttempts.values())]
        .filter((attempt) => attempt.owner === expectedOwner)
        .flatMap((attempt) =>
          attempt.receipts.flatMap((receipt) => receipt.sourceUpdateIds),
        ),
    );
    for (const [updateId, claim] of claims) {
      if (frozenQueuedUpdateIds.has(updateId)) continue;
      if (
        (claim !== "abandoning" && !availableUpdateIds.has(updateId)) ||
        (claim === "queued" && !locallyOwnedQueuedUpdateIds.has(updateId))
      ) {
        claims.delete(updateId);
      }
    }
    for (const updateId of deferredSources.keys()) {
      const claim = claims.get(updateId);
      if (
        claim !== "deferred" &&
        claim !== "abandoning" &&
        claim !== "historical" &&
        claim !== "retained"
      )
        deferredSources.delete(updateId);
    }
    for (const [receiptId, receipt] of queuedReceiptEntries) {
      if (scopedQueueCompletionAttempts.has(receiptId)) continue;
      if (receipt.sourceUpdateIds.some((id) => livePreparation?.ids.has(id)))
        continue;
      await publishCommittedQueueReceipt(
        {
          queueKind: receipt.queueKind,
          receiptId,
          sourceUpdateIds: receipt.sourceUpdateIds,
        },
        receipt.queueOwner,
        expectedOwner,
      );
    }
    for (const [receiptId] of committedQueueReceipts) {
      if (
        !queuedReceiptEntries.has(receiptId) &&
        scopedQueueCompletionAttempts.get(receiptId)?.owner !== expectedOwner
      ) {
        committedQueueReceipts.delete(receiptId);
      }
    }
    state.foreignQueuedCount = foreignQueuedCount;
    if (foreignQueuedOwner) state.foreignQueuedOwner = foreignQueuedOwner;
    else delete state.foreignQueuedOwner;
    state.journalEntryCount = snapshot.entries.length;
    state.journalSerializedBytes = snapshot.serializedBytes;
    state.oldestAdmittedAtMs = oldestAdmittedAtMs;
    state.retryWaitCount = retryWaitCount;
    state.nextRetryUpdateId = nextRetry?.updateId;
    state.nextRetryAtMs = nextRetry?.nextRetryAtMs;
    state.nextRetryAttemptCount = nextRetry?.failure?.attemptCount;
    state.nextRetryFailureClass = nextRetry?.failure?.failureClass;
    state.failedCount = failedCount;
    state.failedUpdateId = latestFailure?.updateId;
    state.failedFailureId = latestFailure?.terminalFailureId;
    state.failedAttemptCount = latestFailure?.failure?.attemptCount;
    state.failedClass = latestFailure?.failure?.failureClass;
    state.failedSummary = latestFailure?.failure?.summary;
    state.terminalFailureAtMs = latestFailure?.terminalAtMs;
    state.unsettledExecutionCount = unsettledExecutions.size;
    updateClaimCounts();
    return scheduledRetryAtMs;
  };

  const checkAuthority = (
    expectedOwner: TelegramUpdateWorkerOwner<TContext>,
    currentUpdateId?: number,
  ): Exclude<TelegramUpdateWorkerDrainResult, "idle"> | undefined => {
    if (blocked) return "blocked";
    if (owner !== expectedOwner || expectedOwner.controller.signal.aborted) {
      return "aborted";
    }
    try {
      if (deps.hasAuthority(expectedOwner.ctx)) return undefined;
    } catch (error) {
      return blockWithFailure(
        "authority-check",
        "authority-check",
        error,
        currentUpdateId,
      );
    }
    transition("blocked", currentUpdateId, "authority-lost");
    return "blocked";
  };

  const executeWithinOwner = async (
    expectedOwner: TelegramUpdateWorkerOwner<TContext>,
    update: TelegramJournaledUpdate,
    preparedExecute?: TelegramUpdateWorkerRuntimeDeps<TContext>["executeUpdate"],
    target?: TelegramTarget & { threadId: number },
  ): Promise<
    | TelegramUpdateWorkerExecutionSettlement
    | typeof TELEGRAM_UPDATE_WORKER_EXECUTION_ABORTED
  > => {
    if (expectedOwner.controller.signal.aborted) {
      return TELEGRAM_UPDATE_WORKER_EXECUTION_ABORTED;
    }
    const custodied = deps.executeCustodiedUpdate !== undefined;
    const execution = Promise.resolve().then(
      async (): Promise<
        TelegramUpdateAdmissionOutcome | TelegramCustodiedExecutionResult
      > =>
        preparedExecute
          ? preparedExecute(
              update,
              expectedOwner.ctx,
              expectedOwner.controller.signal,
            )
          : deps.executeCustodiedUpdate
            ? deps.executeCustodiedUpdate(
                update,
                expectedOwner.ctx,
                expectedOwner.controller.signal,
              )
            : deps.executeUpdate(
                update,
                expectedOwner.ctx,
                expectedOwner.controller.signal,
                target,
              ),
    );
    const settlement: Promise<TelegramUpdateWorkerExecutionSettlement> =
      execution.then(
        (outcome) =>
          custodied
            ? {
                ok: true,
                outcome: outcome as unknown as TelegramCustodiedExecutionResult,
                custodied: true,
              }
            : { ok: true, outcome: outcome as TelegramUpdateAdmissionOutcome },
        (error: unknown) => ({ ok: false, error }),
      );
    unsettledExecutions.add(settlement);
    const updateExecutions =
      unsettledExecutionsByUpdateId.get(update.update_id) ?? new Set();
    updateExecutions.add(settlement);
    unsettledExecutionsByUpdateId.set(update.update_id, updateExecutions);
    state.unsettledExecutionCount = unsettledExecutions.size;
    notifyStateChange();
    void settlement.then((result) => {
      unsettledExecutions.delete(settlement);
      const currentExecutions = unsettledExecutionsByUpdateId.get(
        update.update_id,
      );
      currentExecutions?.delete(settlement);
      if (currentExecutions?.size === 0) {
        unsettledExecutionsByUpdateId.delete(update.update_id);
      }
      state.unsettledExecutionCount = unsettledExecutions.size;
      if (owner !== expectedOwner || expectedOwner.controller.signal.aborted) {
        recordRuntimeEvent(
          result.ok
            ? "Superseded Telegram update execution settled successfully."
            : result.error,
          {
            phase: result.ok ? "late-execution-success" : "late-execution",
            generation: expectedOwner.generation,
            updateId: update.update_id,
          },
        );
      }
      notifyStateChange();
    });
    let removeAbortListener = (): void => {};
    const aborted = new Promise<
      typeof TELEGRAM_UPDATE_WORKER_EXECUTION_ABORTED
    >((resolve) => {
      const onAbort = () => resolve(TELEGRAM_UPDATE_WORKER_EXECUTION_ABORTED);
      removeAbortListener = () =>
        expectedOwner.controller.signal.removeEventListener("abort", onAbort);
      expectedOwner.controller.signal.addEventListener("abort", onAbort, {
        once: true,
      });
      if (expectedOwner.controller.signal.aborted) onAbort();
    });
    try {
      return await Promise.race([settlement, aborted]);
    } finally {
      removeAbortListener();
    }
  };

  const commitQueuedOutcome = (
    expectedOwner: TelegramUpdateWorkerOwner<TContext>,
    currentUpdateId: number,
    outcome: TelegramQueuedUpdateAdmissionOutcome,
  ):
    | "committed"
    | "duplicate"
    | Exclude<TelegramUpdateWorkerDrainResult, "idle">
    | Promise<
        | "committed"
        | "duplicate"
        | Exclude<TelegramUpdateWorkerDrainResult, "idle">
      > => {
    const normalized = normalizeQueueReceipt(outcome);
    const existing = committedQueueReceipts.get(normalized.receiptId);
    if (existing) {
      if (
        !areTelegramQueueAdmissionReceiptsEqual(existing.receipt, normalized) ||
        !isTelegramUpdateJournalQueueOwnerProcess(
          existing.queueOwner,
          expectedOwner.queueOwnerIdentity,
        )
      ) {
        return blockWithFailure(
          "invalid-outcome",
          "queue-receipt-conflict",
          new TelegramUpdateAdmissionOutcomeError(
            `Telegram queue receipt ${normalized.receiptId} conflicts with committed authority.`,
          ),
          currentUpdateId,
          {
            receiptId: normalized.receiptId,
            sourceUpdateIds: normalized.sourceUpdateIds,
          },
        );
      }
      return "duplicate";
    }
    const commitAuthority = checkAuthority(expectedOwner, currentUpdateId);
    if (commitAuthority) return commitAuthority;
    let queueOwner: TelegramUpdateJournalQueueOwner;
    try {
      const committed = deps.journal.markQueued({
        ...normalized,
        owner: expectedOwner.queueOwnerIdentity,
      });
      const committedUpdateIds = new Set([
        ...committed.queuedUpdateIds,
        ...committed.duplicateUpdateIds,
      ]);
      if (
        normalized.sourceUpdateIds.some(
          (updateId) => !committedUpdateIds.has(updateId),
        )
      ) {
        throw new Error(
          `Telegram queue receipt ${normalized.receiptId} did not commit every source update.`,
        );
      }
      if (
        !committed.queueOwner ||
        !isTelegramUpdateJournalQueueOwnerProcess(
          committed.queueOwner,
          expectedOwner.queueOwnerIdentity,
        )
      ) {
        throw new Error(
          `Telegram queue receipt ${normalized.receiptId} belongs to another live process.`,
        );
      }
      queueOwner = committed.queueOwner;
    } catch (error) {
      return blockWithFailure(
        "journal-write",
        "queue-receipt-commit",
        error,
        currentUpdateId,
      );
    }
    for (const sourceUpdateId of normalized.sourceUpdateIds) {
      claims.set(sourceUpdateId, "queued");
    }
    return publishCommittedQueueReceipt(
      normalized,
      queueOwner,
      expectedOwner,
    ).then(
      () => "committed" as const,
      (error) =>
        blockWithFailure(
          "invalid-outcome",
          "queue-receipt-publish",
          error,
          currentUpdateId,
        ),
    );
  };

  const persistExecutionFailure = (
    expectedOwner: TelegramUpdateWorkerOwner<TContext>,
    entry: TelegramUpdateWorkerJournalSnapshot["entries"][number],
    error: unknown,
  ):
    | "retry-wait"
    | "failed"
    | Exclude<TelegramUpdateWorkerDrainResult, "idle"> => {
    const authorityResult = checkAuthority(expectedOwner, entry.updateId);
    if (authorityResult) return authorityResult;
    let rawClassification: TelegramUpdateExecutionFailureClassification;
    try {
      rawClassification = deps.classifyExecutionFailure
        ? deps.classifyExecutionFailure(error)
        : classifyTelegramUpdateExecutionFailure(error);
      if (
        (rawClassification.disposition !== "retryable" &&
          rawClassification.disposition !== "terminal") ||
        typeof rawClassification.failureClass !== "string" ||
        typeof rawClassification.summary !== "string"
      ) {
        throw new Error(
          "Telegram update failure classifier returned invalid data.",
        );
      }
    } catch (classificationError) {
      return blockWithFailure(
        "execution",
        "failure-classification",
        classificationError,
        entry.updateId,
      );
    }
    const failureClass = normalizeTelegramUpdateFailureClass(
      rawClassification.failureClass,
    );
    const summary = normalizeTelegramUpdateFailureSummary(
      rawClassification.summary,
    );
    const expectedAttemptCount = entry.failure?.attemptCount ?? 0;
    const attemptCount = expectedAttemptCount + 1;
    const failedAtMs = getNowMs();
    const disposition = "retry-wait" as const;
    const nextRetryAtMs =
      failedAtMs + getTelegramUpdateRetryDelayMs(attemptCount, retryPolicy);
    try {
      const result = deps.journal.markExecutionFailure({
        updateId: entry.updateId,
        expectedAttemptCount,
        failedAtMs,
        failureClass,
        summary,
        disposition,
        nextRetryAtMs,
      });
      if (result.entry.state !== disposition) {
        throw new Error(
          `Telegram update ${entry.updateId} failure disposition did not persist.`,
        );
      }
    } catch (journalError) {
      return blockWithFailure(
        "journal-write",
        "execution-failure-commit",
        journalError,
        entry.updateId,
      );
    }
    state.lastFailureAtMs = failedAtMs;
    state.lastFailurePhase = "execute";
    recordRuntimeEvent(error, {
      phase: "execute",
      generation: expectedOwner.generation,
      updateId: entry.updateId,
      failureClass,
      attemptCount,
      disposition,
      nextRetryAtMs,
    });
    transition(disposition, entry.updateId);
    return disposition;
  };

  const commitCompletedBatch = (
    expectedOwner: TelegramUpdateWorkerOwner<TContext>,
    completions: readonly {
      updateId: number;
      expectedSource?: TelegramDeferredSourceEvidence;
      spent?: true;
    }[],
    isCurrent?: () => boolean,
  ): Exclude<TelegramUpdateWorkerDrainResult, "idle"> | undefined => {
    const updateIds = completions.map((value) => value.updateId);
    if (updateIds.length === 0) return undefined;
    const commitAuthority = checkAuthority(
      expectedOwner,
      updateIds[updateIds.length - 1],
    );
    if (commitAuthority) return commitAuthority;
    const journalBindingKey = deps.getJournalBindingKey?.();
    try {
      if (isCurrent?.() === false)
        throw new Error("Telegram exact completion authority changed.");
      const expectedSources = completions.flatMap((value) =>
        value.expectedSource ? [value.expectedSource] : [],
      );
      if (
        expectedSources.some(
          (value) => value.journalBindingKey !== journalBindingKey,
        ) ||
        (expectedSources.length > 0 &&
          (deps.isContextCurrent?.(expectedOwner.ctx) === false ||
            !isQueueOwnerIdentityCurrent(expectedOwner)))
      ) {
        throw new Error(
          "Telegram guarded completion source authority changed.",
        );
      }
      const scoped = expectedSources
        .flatMap(({ updateId, sourceSha256, completionSha256 }) =>
          completionSha256 !== undefined
            ? [{ updateId, sourceSha256, completionSha256 }]
            : [],
        )
        .sort((a, b) => a.updateId - b.updateId);
      if (scoped.length > 0 && !inspectCompletion)
        throw new Error(
          "Telegram source completion inspection is unavailable.",
        );
      let removed: {
        removedUpdateIds: readonly number[];
        sourceCompletions?: readonly TelegramUpdateJournalSourceCompletion[];
      };
      if (expectedSources.length > 0) {
        if (!completeExact)
          throw new Error("Telegram exact source completion is unavailable.");
        removed = completeExact(
          updateIds,
          expectedSources.map(({ updateId, sourceSha256 }) => ({
            updateId,
            sourceSha256,
          })),
          scoped.length > 0
            ? scoped.map((completion) => ({ ...completion }))
            : undefined,
          isCurrent,
        );
      } else removed = deps.journal.removeCompleted(updateIds);
      if (isCurrent?.() === false)
        throw new Error("Telegram exact completion ACK authority changed.");
      if (scoped.length > 0) {
        const afterCommit = checkAuthority(expectedOwner, updateIds.at(-1));
        if (afterCommit) return afterCommit;
        if (
          deps.isContextCurrent?.(expectedOwner.ctx) === false ||
          !isQueueOwnerIdentityCurrent(expectedOwner) ||
          deps.getJournalBindingKey?.() !== journalBindingKey
        )
          throw new Error("Telegram source completion ACK authority changed.");
        if (!isDeepStrictEqual(removed.sourceCompletions, scoped))
          throw new Error("Telegram source completion ACK was not confirmed.");
        for (const completion of scoped) {
          if (
            !isDeepStrictEqual(
              inspectCompletion!({ ...completion }),
              completion,
            )
          )
            throw new Error("Telegram source completion ACK was not retained.");
          const afterRead = checkAuthority(expectedOwner, completion.updateId);
          if (afterRead) return afterRead;
          if (
            deps.isContextCurrent?.(expectedOwner.ctx) === false ||
            !isQueueOwnerIdentityCurrent(expectedOwner) ||
            deps.getJournalBindingKey?.() !== journalBindingKey
          )
            throw new Error(
              "Telegram source completion ACK authority changed.",
            );
        }
      }
      const removedIds = new Set(removed.removedUpdateIds);
      if (updateIds.some((updateId) => !removedIds.has(updateId))) {
        throw new Error(
          "Telegram update batch changed before completion commit.",
        );
      }
    } catch (error) {
      return blockWithFailure(
        "journal-write",
        "completion-commit",
        error,
        updateIds[updateIds.length - 1],
      );
    }
    const completedAtMs = getNowMs();
    for (const { updateId, spent } of completions) {
      claims.delete(updateId);
      deferredSources.delete(updateId);
      // Spending is disposition, not completion: no task, cleanup or session observer runs.
      if (spent) continue;
      state.lastCompletedUpdateId = updateId;
      state.lastCompletedAtMs = completedAtMs;
      try {
        deps.onUpdateCompleted?.(
          updateId,
          expectedOwner.ctx,
          journalBindingKey,
        );
      } catch (error) {
        recordRuntimeEvent(error, {
          phase: "update-completion-observer",
          updateId,
        });
      }
    }
    return undefined;
  };

  const clearRoutingTimer = (): void => {
    if (routingTimer !== undefined) cancelRetry(routingTimer);
    routingTimer = undefined;
    routingTimerToken = undefined;
  };
  const reconcileRoutingInputs = async (
    snapshot: TelegramWorkerCoreSnapshot,
    expectedOwner: TelegramUpdateWorkerOwner<TContext>,
  ): Promise<boolean> => {
    clearRoutingTimer();
    if (
      !isTelegramUpdateJournalLegacyFamilyVersion(snapshot.version) ||
      !expireRouting ||
      !expireRoutingObserver
    )
      return false;
    let nextAtMs: number | undefined,
      changed = false;
    const binding = deps.getJournalBindingKey?.(),
      snapshotIds = new Set(snapshot.entries.map((entry) => entry.updateId));
    // Lost expiry ACKs reconcile the exact held original against its body-free discard tombstone.
    const candidates = [
      ...snapshot.entries,
      ...[...deferredSources.values()]
        .filter(
          (source) =>
            source.journalBindingKey === binding &&
            !snapshotIds.has(source.entry.updateId),
        )
        .map((source) => source.entry),
    ];
    for (const entry of candidates) {
      const lifetime = entry.routingInput;
      if (
        !lifetime ||
        entry.state !== "pending" ||
        !binding ||
        claims.get(entry.updateId) === "queued" ||
        unsettledExecutionsByUpdateId.get(entry.updateId)?.size
      )
        continue;
      // Classify the first startup snapshot before constructing any historical expiry carrier.
      if (
        expectedOwner.startupUpdateIds?.has(entry.updateId) &&
        !claims.has(entry.updateId) &&
        deps.shouldReviewHistoricalInput
      ) {
        nextAtMs = Math.min(
          nextAtMs ?? Infinity,
          Math.max(getNowMs() + 1, lifetime.expiresAtMs),
        );
        continue;
      }
      if (getNowMs() < lifetime.expiresAtMs) {
        nextAtMs = Math.min(nextAtMs ?? Infinity, lifetime.expiresAtMs);
        continue;
      }
      const existing = deferredSources.get(entry.updateId);
      if (existing && !isDeepStrictEqual(existing.entry, entry)) {
        // Lost clock/selection ACKs may leave only this immutable metadata behind its exact source; reconciliation grants expiry, never another dispatch.
        const previous = existing.entry.routingInput;
        if (
          !isDeepStrictEqual(
            { ...existing.entry, routingInput: lifetime },
            entry,
          ) ||
          (previous &&
            (!isDeepStrictEqual(
              { ...previous, phase: lifetime.phase },
              lifetime,
            ) ||
              (previous.phase === "selected" && lifetime.phase !== "selected")))
        )
          continue;
        existing.entry = structuredClone(entry);
      }
      const source = existing ?? {
        entry: structuredClone(entry),
        journalBindingKey: binding,
        historical: true as const,
      };
      deferredSources.set(entry.updateId, source);
      if (!claims.has(entry.updateId)) claims.set(entry.updateId, "historical");
      const current = () =>
        owner === expectedOwner &&
        !expectedOwner.controller.signal.aborted &&
        deps.isContextCurrent?.(expectedOwner.ctx) !== false &&
        deps.getJournalBindingKey?.() === binding &&
        deps.hasAuthority(expectedOwner.ctx) &&
        isQueueOwnerIdentityCurrent(expectedOwner) &&
        deferredSources.get(entry.updateId) === source &&
        isDeepStrictEqual(source.entry, entry) &&
        claims.get(entry.updateId) !== "queued";
      let committed: TelegramRoutingInputExpiryResult | undefined;
      try {
        if (current())
          await expireRoutingObserver(
            {
              original: structuredClone(entry),
              journalBindingKey: binding,
              isCurrent: current,
              expire() {
                if (!current()) return undefined;
                if (committed) return { ...committed, duplicate: true };
                claims.set(entry.updateId, "abandoning");
                committed = expireRouting!({
                  entry: source.entry,
                  journalBindingKey: binding,
                  operatorUserId: lifetime.operatorUserId,
                  isCurrent: current,
                });
                // Source expiry is terminal before chooser/cleanup awaits; later failures must not retain a deferred/retry source.
                claims.delete(entry.updateId);
                deferredSources.delete(entry.updateId);
                state.journalEntryCount = committed.entryCount;
                state.journalSerializedBytes = committed.serializedBytes;
                updateClaimCounts();
                notifyStateChange();
                changed ||= !committed.duplicate;
                return committed;
              },
            },
            expectedOwner.ctx,
            expectedOwner.controller.signal,
          );
      } catch (error) {
        recordRuntimeEvent(error, {
          phase: "routing-input-expiry",
          updateId: entry.updateId,
        });
      }
      if (!committed)
        nextAtMs = Math.min(nextAtMs ?? Infinity, getNowMs() + 60_000);
    }
    if (
      nextAtMs !== undefined &&
      owner === expectedOwner &&
      !expectedOwner.controller.signal.aborted
    ) {
      const token = {};
      routingTimerToken = token;
      routingTimer = scheduleRetry(
        () => {
          if (
            routingTimerToken !== token ||
            owner !== expectedOwner ||
            expectedOwner.controller.signal.aborted
          )
            return;
          routingTimer = undefined;
          routingTimerToken = undefined;
          pendingSignal = true;
          launchDrain();
        },
        Math.max(1, nextAtMs - getNowMs()),
      );
    }
    return changed;
  };
  const mutateRoutingSource = (
    input: {
      updateId: number;
      signal: AbortSignal;
      operatorUserId: number;
      sourceUpdateIds: readonly number[];
      chooser?: TelegramUpdateJournalRoutingChooser;
    },
    select: boolean,
  ) => {
    const expectedOwner = owner,
      ids = [...input.sourceUpdateIds];
    if (
      !ids.length ||
      !ids.includes(input.updateId) ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !Number.isSafeInteger(id) || id < 0)
    )
      return undefined;
    const sources = ids.map((id) => deferredSources.get(id)),
      binding = sources[0]?.journalBindingKey;
    const current = () =>
      !!expectedOwner &&
      owner === expectedOwner &&
      expectedOwner.controller.signal === input.signal &&
      !input.signal.aborted &&
      !!binding &&
      sources.every(
        (source, index) =>
          !!source &&
          deferredSources.get(ids[index]!) === source &&
          !source.historical &&
          source.journalBindingKey === binding &&
          claims.get(ids[index]!) !== "queued" &&
          claims.get(ids[index]!) !== "abandoning",
      ) &&
      deps.getJournalBindingKey?.() === binding &&
      deps.isContextCurrent?.(expectedOwner.ctx) !== false &&
      deps.hasAuthority(expectedOwner.ctx) &&
      isQueueOwnerIdentityCurrent(expectedOwner);
    if (!current() || !armRouting || !selectRouting || !expireRoutingObserver)
      return undefined;
    const authority = {
      journalBindingKey: binding!,
      entries: sources.map((source) => structuredClone(source!.entry)),
      operatorUserId: input.operatorUserId,
      isCurrent: current,
    };
    const result = select
      ? selectRouting(authority)
      : {
          issued: false,
          entries: armRouting({
            ...authority,
            publishedAtMs: getNowMs(),
            ...(input.chooser ? { chooser: input.chooser } : {}),
          }),
        };
    if (
      result.entries.length !== ids.length ||
      result.entries.some(
        (entry, index) => entry.updateId !== ids[index] || !entry.routingInput,
      ) ||
      !current()
    ) {
      throw new Error("Telegram routing input lifetime ACK was not confirmed.");
    }
    const retained = deps.journal.read().entries;
    if (
      result.entries.some(
        (entry) =>
          !isDeepStrictEqual(
            retained.find((value) => value.updateId === entry.updateId),
            entry,
          ),
      ) ||
      !current()
    ) {
      throw new Error("Telegram routing input lifetime ACK was not retained.");
    }
    // Retain the decoder's exact source representation, not the mutation result's property ordering.
    result.entries.forEach((entry, index) => {
      sources[index]!.entry = structuredClone(
        retained.find((value) => value.updateId === entry.updateId)!,
      );
    });
    pendingSignal = true;
    launchDrain();
    return {
      issued: result.issued,
      lifetime: { ...result.entries[0]!.routingInput! },
    };
  };
  const drain = async (
    expectedOwner: TelegramUpdateWorkerOwner<TContext>,
  ): Promise<TelegramUpdateWorkerDrainResult> => {
    while (
      owner === expectedOwner &&
      !expectedOwner.controller.signal.aborted
    ) {
      const authorityResult = checkAuthority(expectedOwner);
      if (authorityResult) return authorityResult;
      let snapshot: TelegramWorkerCoreSnapshot;
      let scheduledRetryAtMs: number | undefined;
      try {
        snapshot = deps.journal.read();
        scheduledRetryAtMs = await refreshJournalState(snapshot, expectedOwner);
        // One complete validated baseline per generation, before batching or execution.
        // Replayed v1 entries do not prove that a prior process never forwarded them.
        expectedOwner.startupUpdateIds ??= new Set(
          snapshot.entries.map((entry) => entry.updateId),
        );
      } catch (error) {
        return blockWithFailure("journal-read", "journal-read", error);
      }
      if (await reconcileRoutingInputs(snapshot, expectedOwner)) continue;
      if (owner !== expectedOwner || expectedOwner.controller.signal.aborted)
        return "aborted";
      const nowMs = getNowMs();
      const entries: TelegramUpdateWorkerJournalSnapshot["entries"][number][] =
        [];
      const ordinaryIds = ordinaryV4?.getAdmissibleIds();
      let hasMoreEntries = false;
      let hasOutcomeUnknownInput = false;
      let hasUnavailableInputCustody = false;
      let blockedInputCustody: TelegramUpdateWorkerStateSnapshot["blockedInputCustody"];
      delete state.blockedInputCustody;
      for (const candidate of snapshot.entries) {
        if (
          livePreparation?.ids.has(candidate.updateId) &&
          (!livePreparation.released || livePreparation.status?.issued)
        )
          continue;
        if (
          (snapshot.version === TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION || snapshot.version === 4) &&
          (candidate.state === "retry-wait" || candidate.state === "failed")
        ) {
          hasUnavailableInputCustody = true;
          blockedInputCustody ??= {
            updateId: candidate.updateId,
            kind: "legacy-retry-state",
          };
          continue;
        }
        if (
          (snapshot.version === TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION || snapshot.version === 4) &&
          candidate.inputClaim
        ) {
          if (candidate.inputClaim.phase === "running") {
            hasOutcomeUnknownInput = true;
            if (
              !blockedInputCustody ||
              blockedInputCustody.kind !== "running-outcome-unknown"
            )
              blockedInputCustody = {
                updateId: candidate.updateId,
                kind: "running-outcome-unknown",
              };
            continue;
          }
          if (
            candidate.inputClaim.handoff ||
            !isTelegramUpdateJournalQueueOwnerProcess(
              candidate.inputClaim.owner,
              expectedOwner.queueOwnerIdentity,
            )
          ) {
            hasUnavailableInputCustody = true;
            blockedInputCustody ??= {
              updateId: candidate.updateId,
              kind: candidate.inputClaim.handoff
                ? "handoff-frozen"
                : "foreign-ready",
            };
            continue;
          }
        }
        if (ordinaryIds && (candidate.preApprovalExcluded !== false || !ordinaryIds.has(candidate.updateId))) continue;
        if (
          !claims.has(candidate.updateId) &&
          (candidate.state === "pending" ||
            (candidate.state === "retry-wait" &&
              candidate.nextRetryAtMs !== undefined &&
              candidate.nextRetryAtMs <= nowMs))
        ) {
          if (entries.length === batchSize) {
            hasMoreEntries = true;
            break;
          }
          entries.push(candidate);
        }
      }
      if (entries.length === 0) {
        scheduleNextRetry(scheduledRetryAtMs, expectedOwner);
        if (hasOutcomeUnknownInput || hasUnavailableInputCustody) {
          if (blockedInputCustody)
            state.blockedInputCustody = blockedInputCustody;
          transition(
            "blocked",
            blockedInputCustody?.updateId,
            hasOutcomeUnknownInput ? "execution" : "input-custody",
          );
          return "blocked";
        }
        transition("idle");
        return "idle";
      }
      const completedUpdateIds: {
        updateId: number;
        expectedSource?: TelegramDeferredSourceEvidence;
        spent?: true;
      }[] = [];
      let snapshotInvalidated = false;
      for (const entry of entries) {
        if (
          livePreparation?.ids.has(entry.updateId) &&
          (!livePreparation.released || livePreparation.status?.issued)
        )
          continue;
        const priorExecutions = unsettledExecutionsByUpdateId.get(
          entry.updateId,
        );
        if (priorExecutions?.size) {
          const completionResult = commitCompletedBatch(
            expectedOwner,
            completedUpdateIds,
          );
          if (completionResult) return completionResult;
          transition("blocked", entry.updateId, "prior-generation-executing");
          await Promise.allSettled([...priorExecutions]);
          if (
            owner !== expectedOwner ||
            expectedOwner.controller.signal.aborted
          ) {
            return "aborted";
          }
          snapshotInvalidated = true;
          break;
        }
        if (entry.preApprovalExcluded === true) {
          completedUpdateIds.push({ updateId: entry.updateId });
          continue;
        }
        if (
          isTelegramUpdateJournalLegacyFamilyVersion(snapshot.version) &&
          entry.state === "pending" &&
          deps.journal.inspectPendingRetention
        ) {
          const authorityResult = checkAuthority(expectedOwner, entry.updateId);
          if (authorityResult) return authorityResult;
          let retained:
            TelegramUpdateJournalPendingRetentionEvidence | undefined;
          let unverifiable = false;
          try {
            retained = deps.journal.inspectPendingRetention(entry);
          } catch (error) {
            unverifiable = true;
            recordRuntimeEvent(error, {
              phase: "pending-retention-inspection",
              updateId: entry.updateId,
            });
          }
          if (retained || unverifiable) {
            // A copy is protection evidence only. A fresh owner must explicitly retry
            // cancellation; neither startup nor a malformed copy may dispatch the source.
            claims.set(entry.updateId, "abandoning");
            const journalBindingKey =
              retained?.journalBindingKey ?? deps.getJournalBindingKey?.();
            if (journalBindingKey)
              deferredSources.set(entry.updateId, { entry, journalBindingKey });
            transition("deferred", entry.updateId);
            continue;
          }
        }
        if (
          isTelegramUpdateJournalLegacyFamilyVersion(snapshot.version) &&
          (entry.state === "pending" || entry.state === "retry-wait")
        ) {
          const historical = expectedOwner.startupUpdateIds.has(entry.updateId);
          let revived = false;
          const journalBindingKey = deps.getJournalBindingKey?.();
          // Classifiers and handler projections receive no mutable alias to CAS evidence.
          if (journalBindingKey)
            deferredSources.set(entry.updateId, {
              entry: structuredClone(entry),
              journalBindingKey,
              ...(historical ? { historical: true } : {}),
            });
          const classifyPending =
            historical && entry.state === "pending"
              ? deps.shouldReviewHistoricalInput
              : deps.shouldHoldPendingInput;
          if (classifyPending) {
            const checkHistoricalAuthority = ():
              TelegramUpdateWorkerDrainResult | undefined => {
              if (
                owner !== expectedOwner ||
                expectedOwner.controller.signal.aborted
              )
                return "aborted";
              if (
                deps.getJournalBindingKey?.() !== journalBindingKey ||
                deps.isContextCurrent?.(expectedOwner.ctx) === false
              ) {
                transition("blocked", entry.updateId, "authority-lost");
                return "blocked";
              }
              return checkAuthority(expectedOwner, entry.updateId);
            };
            const beforeClassification = checkHistoricalAuthority();
            if (beforeClassification) return beforeClassification;
            let review: TelegramHistoricalReviewVerdict;
            try {
              review = await classifyPending(
                structuredClone(entry),
                expectedOwner.ctx,
                expectedOwner.controller.signal,
              );
            } catch (error) {
              const authorityResult = checkHistoricalAuthority();
              if (authorityResult) return authorityResult;
              return blockWithFailure(
                "execution",
                "historical-review-classification",
                error,
                entry.updateId,
              );
            }
            const authorityResult = checkHistoricalAuthority();
            if (authorityResult) return authorityResult;
            if (
              typeof review !== "boolean" &&
              !(
                historical &&
                entry.state === "pending" &&
                (review === "retain" ||
                  (review === "revive" &&
                    isRevivableTelegramRoutingInput(entry, getNowMs())))
              )
            )
              return blockWithFailure(
                "execution",
                "historical-review-classification",
                new TelegramUpdateAdmissionOutcomeError(
                  "Historical classification must return a boolean or retain verdict.",
                ),
                entry.updateId,
              );
            // Classification may await a domain read; accepted/changed source evidence wins.
            try {
              const current = deps.journal.read();
              if (
                current.version !== snapshot.version ||
                JSON.stringify(
                  current.entries.find(
                    (candidate) => candidate.updateId === entry.updateId,
                  ),
                ) !== JSON.stringify(entry)
              ) {
                snapshotInvalidated = true;
                break;
              }
            } catch (error) {
              return blockWithFailure(
                "journal-read",
                "historical-source-recheck",
                error,
                entry.updateId,
              );
            }
            if (review === "revive") {
              // A still-waiting saved clock proves no selection ran, so this generation owns the source as live input.
              revived = true;
              const source = deferredSources.get(entry.updateId);
              if (source) delete source.historical;
              expectedOwner.startupUpdateIds = new Set(
                [...expectedOwner.startupUpdateIds].filter(
                  (id) => id !== entry.updateId,
                ),
              );
            } else if (review === "retain") {
              claims.set(entry.updateId, "retained");
              transition("deferred", entry.updateId);
              continue;
            }
            if (
              review &&
              historical &&
              spendHistorical &&
              !entry.routingInput &&
              classifyPending === deps.shouldReviewHistoricalInput
            ) {
              completedUpdateIds.push({
                updateId: entry.updateId,
                spent: true,
              });
              continue;
            }
            if (review === true) {
              claims.set(entry.updateId, "historical");
              transition("deferred", entry.updateId);
              continue;
            }
          }
          if (!revived && entry.state === "pending" && entry.routingInput) {
            claims.set(entry.updateId, "historical");
            transition("deferred", entry.updateId);
            continue;
          }
        }
        if (
          livePreparation?.ids.has(entry.updateId) &&
          (!livePreparation.released || livePreparation.status?.issued)
        )
          continue;
        const prepared =
          livePreparation?.released && livePreparation.ids.has(entry.updateId)
            ? livePreparation
            : undefined;
        const status = prepared?.status;
        if (status) {
          status.issued = true;
          try {
            if (
              !status.current() ||
              !isDeepStrictEqual(prepared!.saved?.[0], entry)
            )
              throw new Error("Prepared status original changed.");
            status.assertCurrent();
            if (!status.current())
              throw new Error("Prepared status owner changed after assertion.");
          } catch (error) {
            claims.set(entry.updateId, "retained");
            recordRuntimeEvent(error, {
              phase: "prepared-status-authority",
              updateId: entry.updateId,
            });
            continue;
          }
        }
        clearRetryTimer();
        transition("executing", entry.updateId);
        const execution = await executeWithinOwner(
          expectedOwner,
          entry.update,
          status
            ? async (update, ctx, signal) => {
                const admitted = await status.admit(update, ctx, signal);
                status.carrier = admitted.carrier;
                if (
                  !status.current() ||
                  admitted.outcome.kind !== "deferred" ||
                  !isDeepStrictEqual(
                    deps.journal
                      .read()
                      .entries.find(
                        (value) => value.updateId === entry.updateId,
                      ),
                    entry,
                  ) ||
                  !status.current()
                )
                  throw new Error("Prepared status admission is unconfirmed.");
                return admitted.outcome;
              }
            : undefined,
          prepared?.target,
        );
        if (execution === TELEGRAM_UPDATE_WORKER_EXECUTION_ABORTED) {
          return "aborted";
        }
        if (!execution.ok) {
          if (status) {
            claims.set(entry.updateId, "retained");
            recordRuntimeEvent(execution.error, {
              phase: "prepared-status-admission",
              updateId: entry.updateId,
            });
            continue;
          }
          if (deps.executeCustodiedUpdate) {
            if (ordinaryV4) recordRuntimeEvent(execution.error, { phase: "ordinary-custody-execution", updateId: entry.updateId });
            transition("blocked", entry.updateId, "execution");
            return "blocked";
          }
          const completionResult = commitCompletedBatch(
            expectedOwner,
            completedUpdateIds,
          );
          if (completionResult) return completionResult;
          const failureResult = persistExecutionFailure(
            expectedOwner,
            entry,
            execution.error,
          );
          if (failureResult === "blocked" || failureResult === "aborted") {
            return failureResult;
          }
          snapshotInvalidated = true;
          break;
        }
        if (execution.custodied) {
          const outcome = execution.outcome;
          if (outcome.status === "outcome-unknown") {
            transition("blocked", entry.updateId, "execution");
            return "blocked";
          }
          if (outcome.status === "deferred") {
            claims.set(entry.updateId, "deferred");
            transition("deferred", entry.updateId);
            continue;
          }
          if (outcome.status === "queued") {
            const receipt = normalizeQueueReceipt(outcome.queueReceipt);
            if (
              !isTelegramUpdateJournalQueueOwnerProcess(
                outcome.queueReceipt.queueOwner,
                expectedOwner.queueOwnerIdentity,
              )
            ) {
              return blockWithFailure(
                "invalid-outcome",
                "custody-queue-owner",
                new Error(
                  "Telegram custodied queue receipt belongs to another process.",
                ),
                entry.updateId,
              );
            }
            for (const sourceUpdateId of receipt.sourceUpdateIds)
              claims.set(sourceUpdateId, "queued");
            try {
              await publishCommittedQueueReceipt(
                receipt,
                outcome.queueReceipt.queueOwner,
                expectedOwner,
              );
            } catch (error) {
              return blockWithFailure(
                "invalid-outcome",
                "queue-receipt-publish",
                error,
                entry.updateId,
              );
            }
            transition("queued", entry.updateId);
          }
          snapshotInvalidated = true;
          break;
        }
        if (prepared?.target) {
          prepared.ids = new Set([...prepared.ids].filter(id => id !== entry.updateId));
          if (!prepared.ids.size && livePreparation === prepared) livePreparation = undefined;
          updateClaimCounts();
        }
        const postExecutionAuthority = checkAuthority(
          expectedOwner,
          entry.updateId,
        );
        if (postExecutionAuthority) return postExecutionAuthority;
        const claimableUpdateIds = new Set<number>([
          entry.updateId,
          ...[...claims]
            .filter(
              ([id, claim]) =>
                !livePreparation?.ids.has(id) &&
                claim !== "abandoning" &&
                claim !== "historical" &&
                claim !== "retained",
            )
            .map(([id]) => id),
        ]);
        let outcome: TelegramUpdateAdmissionOutcome;
        try {
          outcome = validateTelegramUpdateAdmissionOutcome(
            execution.outcome,
            entry.updateId,
            claimableUpdateIds,
          );
        } catch (error) {
          return blockWithFailure(
            "invalid-outcome",
            "invalid-outcome",
            error,
            entry.updateId,
          );
        }
        if (outcome.kind === "deferred") {
          if (
            outcome.routingReview &&
            !deferredSources.get(entry.updateId)?.historical
          ) {
            return blockWithFailure(
              "invalid-outcome",
              "historical-review-source",
              new TelegramUpdateAdmissionOutcomeError(
                "Historical review needs an exact startup source.",
              ),
              entry.updateId,
            );
          }
          claims.set(
            entry.updateId,
            outcome.routingReview ? "historical" : "deferred",
          );
          transition("deferred", entry.updateId);
          if (status) {
            // Native warm deferral precedes consumption; late reports retain the existing ACK owner.
            if (livePreparation === prepared) livePreparation = undefined;
            updateClaimCounts();
            try {
              if (!status.current())
                throw new Error("Prepared status consumer owner changed.");
              status.assertCurrent();
              if (!status.bindCarrier(status.carrier) || !status.current())
                throw new Error("Prepared status carrier binding refused.");
              status.assertCurrent();
              if (!status.current())
                throw new Error(
                  "Prepared status owner changed before consumption.",
                );
              await status.execute();
              if (!status.current())
                throw new Error(
                  "Prepared status consumption result is unconfirmed.",
                );
            } catch (error) {
              recordRuntimeEvent(error, {
                phase: "prepared-status-consume",
                updateId: entry.updateId,
              });
            }
          }
          continue;
        }
        if (outcome.kind === "queued") {
          const completionResult = commitCompletedBatch(
            expectedOwner,
            completedUpdateIds,
          );
          if (completionResult) return completionResult;
          const queuedResult = await commitQueuedOutcome(
            expectedOwner,
            entry.updateId,
            outcome,
          );
          if (queuedResult === "blocked" || queuedResult === "aborted") {
            return queuedResult;
          }
          transition("queued", entry.updateId);
          snapshotInvalidated = true;
          break;
        }
        completedUpdateIds.push({
          updateId: entry.updateId,
          ...(outcome.expectedSource
            ? { expectedSource: outcome.expectedSource }
            : {}),
        });
      }
      const completionResult = commitCompletedBatch(
        expectedOwner,
        completedUpdateIds,
      );
      if (completionResult) return completionResult;
      if (!snapshotInvalidated && !hasMoreEntries) continue;
      await yieldToEventLoop();
      if (owner !== expectedOwner || expectedOwner.controller.signal.aborted) {
        return "aborted";
      }
    }
    return "aborted";
  };

  launchDrain = (): void => {
    const expectedOwner = owner;
    if (!expectedOwner || drainPromise) return;
    let startupKey: string | undefined;
    if (onHeldSourcesPrepared) {
      try {
        startupKey = deps.getJournalBindingKey?.();
      } catch {
        /* Missing startup identity grants no notification. */
      }
    }
    let lastResult: TelegramUpdateWorkerDrainResult | undefined;
    const run = async (): Promise<void> => {
      while (
        pendingSignal &&
        owner === expectedOwner &&
        !expectedOwner.controller.signal.aborted
      ) {
        pendingSignal = false;
        // Keep newer wakes in this run so waitForDrain also covers them. A failure
        // observed after signal() still keeps its latch; this loop never clears it.
        lastResult = await drain(expectedOwner);
      }
    };
    const operation = run();
    let tracked: Promise<void>;
    const finish = (): void => {
      if (owner === expectedOwner && drainPromise === tracked) {
        drainPromise = undefined;
        if (pendingSignal && !expectedOwner.controller.signal.aborted) {
          launchDrain();
        } else if (
          lastResult === "idle" &&
          startupKey &&
          onHeldSourcesPrepared &&
          !expectedOwner.heldSourcesPreparedIssued
        ) {
          try {
            const ctx = expectedOwner.ctx,
              key = startupKey;
            const isCurrent = () =>
              owner === expectedOwner &&
              !blocked &&
              !expectedOwner.controller.signal.aborted &&
              deps.getJournalBindingKey?.() === key &&
              deps.isContextCurrent?.(ctx) !== false &&
              deps.hasAuthority(ctx);
            if (!isCurrent()) return;
            expectedOwner.heldSourcesPreparedIssued = true;
            // Do not couple lifecycle/stop or the worker drain to a held controller/API reply.
            void Promise.resolve()
              .then(() =>
                isCurrent()
                  ? onHeldSourcesPrepared({
                      ctx,
                      journalBindingKey: key,
                      signal: expectedOwner.controller.signal,
                      isCurrent,
                      routingSourceIds: [...deferredSources]
                        .filter(
                          ([, source]) =>
                            source.journalBindingKey === key &&
                            !!source.entry.routingInput,
                        )
                        .map(([id]) => id),
                    })
                  : undefined,
              )
              .catch((error) => {
                try {
                  deps.recordRuntimeEvent?.("inbound-worker", error, {
                    phase: "held-source-preparation",
                  });
                } catch {
                  /* Diagnostic only. */
                }
              });
          } catch (error) {
            try {
              deps.recordRuntimeEvent?.("inbound-worker", error, {
                phase: "held-source-preparation",
              });
            } catch {
              /* Diagnostic only. */
            }
          }
        }
      }
    };
    tracked = operation.then(
      () => finish(),
      (error: unknown) => {
        pendingSignal = false;
        if (owner === expectedOwner) {
          blockWithFailure("execution", "worker-loop", error);
        }
        finish();
      },
    );
    drainPromise = tracked;
  };

  const abandonSource = (
    input: Parameters<
      NonNullable<TelegramUpdateWorkerRuntime<TContext>["abandonDeferred"]>
    >[0],
    historicalSource?: ReturnType<typeof deferredSources.get>,
  ): TelegramUpdateJournalPendingAbandonmentResult | undefined => {
    const expectedOwner = owner;
    const source = deferredSources.get(input.updateId);
    const abandonPending = deps.journal.abandonPending;
    const isCurrent = () => {
      if (
        !expectedOwner ||
        owner !== expectedOwner ||
        input.signal.aborted ||
        expectedOwner.controller.signal !== input.signal ||
        !source ||
        source.entry.routingInput?.phase === "selected" ||
        (source.historical && historicalSource !== source) ||
        (claims.get(input.updateId) !== "deferred" &&
          claims.get(input.updateId) !== "abandoning" &&
          !(
            claims.get(input.updateId) === "historical" &&
            historicalSource === source
          ))
      )
        return false;
      return (
        input.isCurrent() &&
        deps.isContextCurrent?.(expectedOwner.ctx) !== false &&
        deps.getJournalBindingKey?.() === source.journalBindingKey &&
        deps.hasAuthority(expectedOwner.ctx)
      );
    };
    if (!source || !abandonPending || !isCurrent()) return undefined;
    // Retain this claim on failure, including unknown commit: never reopen dispatch.
    claims.set(input.updateId, "abandoning");
    try {
      const result = abandonPending({
        ...input,
        entry: source.entry,
        journalBindingKey: source.journalBindingKey,
        isCurrent,
      });
      claims.delete(input.updateId);
      deferredSources.delete(input.updateId);
      state.journalEntryCount = result.entryCount;
      state.journalSerializedBytes = result.serializedBytes;
      transition("idle");
      pendingSignal = true;
      launchDrain();
      return result;
    } catch (error) {
      recordRuntimeEvent(error, {
        phase: "pending-abandonment",
        updateId: input.updateId,
      });
      updateClaimCounts();
      notifyStateChange();
      throw error;
    }
  };

  const inspectRecovery = (
    input: TelegramDeferredAbandonmentRecoveryRequest & { signal: AbortSignal },
    kind: "abandoning" | "historical",
  ): TelegramDeferredAbandonmentRecoveryPage | undefined => {
    const expectedOwner = owner;
    if (!expectedOwner) return undefined;
    const {
      signal,
      journalBindingKey,
      isCurrent: callerIsCurrent,
      afterUpdateId,
    } = input;
    const isOwnerCurrent = () =>
      owner === expectedOwner &&
      expectedOwner.controller.signal === signal &&
      !signal.aborted;
    const isCurrent = () =>
      isOwnerCurrent() &&
      callerIsCurrent() &&
      deps.isContextCurrent?.(expectedOwner.ctx) !== false &&
      deps.getJournalBindingKey?.() === journalBindingKey &&
      deps.hasAuthority(expectedOwner.ctx);
    if (
      !isCurrent() ||
      !deps.journal.abandonPending ||
      !deps.journal.inspectPendingRetention ||
      (afterUpdateId !== undefined &&
        (!Number.isSafeInteger(afterUpdateId) || afterUpdateId < 0))
    )
      return undefined;
    const matches = [...deferredSources]
      .filter(
        ([id, source]) =>
          claims.get(id) === kind &&
          source.journalBindingKey === journalBindingKey &&
          (afterUpdateId === undefined || id > afterUpdateId),
      )
      .sort(([a], [b]) => a - b);
    const sources = matches
      .slice(0, TELEGRAM_HELD_SOURCE_INSPECTION_LIMIT)
      .map(([updateId, source]) => {
        let committed:
          TelegramUpdateJournalPendingAbandonmentResult | undefined;
        return {
          original: structuredClone(source.entry),
          retry(authority: TelegramDeferredUpdateAbandonmentAuthority) {
            const authorized = () =>
              isOwnerCurrent() && authority.isCurrent() && isCurrent();
            if (!authorized()) return undefined;
            if (committed) return { ...committed, duplicate: true };
            const stillProtected = () =>
              authorized() &&
              (claims.get(updateId) === kind ||
                claims.get(updateId) === "abandoning") &&
              deferredSources.get(updateId) === source;
            if (!stillProtected()) return undefined;
            committed = abandonSource(
              { ...authority, updateId, signal, isCurrent: stillProtected },
              source,
            );
            return committed;
          },
        };
      });
    return isCurrent()
      ? {
          sources,
          ...(matches.length > TELEGRAM_HELD_SOURCE_INSPECTION_LIMIT
            ? {
                nextAfterUpdateId:
                  matches[TELEGRAM_HELD_SOURCE_INSPECTION_LIMIT - 1]![0],
              }
            : {}),
        }
      : undefined;
  };

  const inspectDeferredOriginal = (input: {
    updateId: number;
    signal: AbortSignal;
  }) => {
    const expectedOwner = owner;
    const source = deferredSources.get(input.updateId);
    const current = (): boolean => {
      if (
        !expectedOwner ||
        owner !== expectedOwner ||
        input.signal.aborted ||
        expectedOwner.controller.signal !== input.signal ||
        !source ||
        deferredSources.get(input.updateId) !== source ||
        claims.get(input.updateId) !== "deferred" ||
        deps.getJournalBindingKey?.() !== source.journalBindingKey ||
        deps.isContextCurrent?.(expectedOwner.ctx) === false ||
        !deps.hasAuthority(expectedOwner.ctx)
      )
        return false;
      return isQueueOwnerIdentityCurrent(expectedOwner);
    };
    if (!current()) return undefined;
    const snapshot = deps.journal.read();
    const entry = snapshot.entries.find(
      (value) => value.updateId === input.updateId,
    );
    if (
      !isTelegramUpdateJournalLegacyFamilyVersion(snapshot.version) ||
      !entry ||
      JSON.stringify(entry) !== JSON.stringify(source!.entry) ||
      !current()
    )
      return undefined;
    return {
      source: {
        journalBindingKey: source!.journalBindingKey,
        ...createTelegramUpdateJournalEntryDigest(entry),
      },
      entry,
    };
  };

  return {
    start(ctx) {
      if (owner) {
        if (!owner.controller.signal.aborted) {
          pendingSignal = true;
          launchDrain();
        }
        return;
      }
      clearRetryTimer();
      clearRoutingTimer();
      const nowMs = getNowMs();
      const generation = ++nextGeneration;
      const queueOwnerIdentity = resolveQueueOwnerIdentity(ctx, generation);
      owner = {
        generation,
        ctx,
        controller: createAbortController(),
        queueOwnerIdentity,
      };
      livePreparation = undefined;
      delete state.preparedInputCount;
      claims.clear();
      deferredSources.clear();
      committedQueueReceipts.clear();
      blocked = false;
      pendingSignal = true;
      state.phase = "idle";
      state.generation = generation;
      state.phaseStartedAtMs = nowMs;
      state.currentUpdateId = undefined;
      state.blockedReason = undefined;
      state.journalEntryCount = 0;
      state.journalSerializedBytes = 0;
      state.oldestAdmittedAtMs = undefined;
      clearTelegramUpdateWorkerClaimState(state, unsettledExecutions.size);
      state.lastCompletedUpdateId = undefined;
      state.lastCompletedAtMs = undefined;
      state.lastFailureAtMs = undefined;
      state.lastFailurePhase = undefined;
      notifyStateChange();
      launchDrain();
    },
    prepareDeferredLiveInput(input) {
      const expectedOwner = owner,
        binding = deps.getJournalBindingKey?.(),
        onTransferred = input.onTransferred,
        ids = [...input.sourceUpdateIds];
      const sources = ids.map((id) => deferredSources.get(id));
      const ownerCurrent = () =>
        !!expectedOwner &&
        owner === expectedOwner &&
        expectedOwner.controller.signal === input.signal &&
        !input.signal.aborted &&
        !!binding &&
        deps.getJournalBindingKey?.() === binding &&
        deps.hasAuthority(expectedOwner.ctx) &&
        deps.isContextCurrent?.(expectedOwner.ctx) !== false &&
        isQueueOwnerIdentityCurrent(expectedOwner) &&
        input.onTransferred === onTransferred && input.isCurrent();
      const sourcesCurrent = () =>
        ownerCurrent() &&
        sources.every(
          (source, index) =>
            !!source &&
            deferredSources.get(ids[index]!) === source &&
            source.journalBindingKey === binding &&
            claims.get(ids[index]!) === "deferred" &&
            isFreshLiveSource(expectedOwner!, ids[index]!),
        );
      if (
        !ownerCurrent() ||
        !ids.length ||
        !ids.includes(input.updateId) ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !Number.isSafeInteger(id) || id < 0) ||
        livePreparation ||
        deps.executeCustodiedUpdate ||
        !sourcesCurrent()
      )
        return undefined;
      const confirm = () => {
        if (!sourcesCurrent()) return false;
        try {
          const snapshot = deps.journal.read();
          return (
            isTelegramUpdateJournalLegacyFamilyVersion(snapshot.version) &&
            sourcesCurrent() &&
            sources.every(
              (source, index) =>
                snapshot.entries.filter(
                  (entry) => entry.updateId === ids[index],
                ).length === 1 &&
                source?.entry.state === "pending" &&
                !source.entry.queueOwner &&
                !source.entry.queueReceiptId &&
                !source.entry.preApprovalExcluded &&
                isDeepStrictEqual(
                  snapshot.entries.find(
                    (entry) => entry.updateId === ids[index],
                  ),
                  source.entry,
                ),
            )
          );
        } catch (error) {
          recordRuntimeEvent(error, { phase: "live-deferred-observe" });
          return false;
        }
      };
      if (!confirm()) return undefined;
      const held: TelegramLiveInputPreparationState<TContext> = {
        version: 1,
        ids: new Set(ids),
      };
      livePreparation = held;
      const current = () => livePreparation === held && sourcesCurrent();
      const available = () => current() && !held.discardIssued;
      const finish = () => {
        livePreparation = undefined;
        updateClaimCounts();
        notifyStateChange();
      };
      updateClaimCounts();
      notifyStateChange();
      return {
        sourceUpdateIds: Object.freeze(ids),
        isCurrent: available,
        isOwnerCurrent: ownerCurrent,
        confirmSaved: () => available() && confirm(),
        beginRelease(canRelease) {
          if (
            !available() ||
            !canRelease() ||
            !confirm() ||
            !canRelease() ||
            !available()
          )
            return false;
          for (const source of sources) source!.liveReleaseIssued = true;
          finish();
          return true;
        },
        settleTransferred(canSettle) {
          if (!current() || !canSettle() || !completeExact) return "protected";
          if (held.discardIssued) return "unknown";
          if (!confirm() || !canSettle() || !available()) return "protected";
          const expected = sources.map((source) =>
            createTelegramUpdateJournalEntryDigest(source!.entry),
          );
          held.discardIssued = true;
          try {
            const result = completeExact(
              ids,
              expected,
              undefined,
              () => current() && canSettle(),
            );
            if (result.removedUpdateIds.length !== ids.length || !ids.every(id => result.removedUpdateIds.includes(id)))
              return "unknown";
            // A consumed routing clock is expected only after this exact ACK, never after uncertain removal.
            onTransferred?.call(input);
            if (!current() || !canSettle()) return "unknown";
          } catch (error) {
            recordRuntimeEvent(error, {
              phase: "live-deferred-transfer-settlement",
            });
            return "unknown";
          }
          for (const id of ids) {
            claims.delete(id);
            deferredSources.delete(id);
          }
          finish();
          for (const id of ids) {
            if (!ownerCurrent() || !canSettle()) return "unknown";
            state.lastCompletedUpdateId = id;
            state.lastCompletedAtMs = getNowMs();
            try {
              deps.onUpdateCompleted?.(id, expectedOwner!.ctx, binding);
            } catch (error) {
              recordRuntimeEvent(error, {
                phase: "update-completion-observer",
                updateId: id,
              });
            }
          }
          return ownerCurrent() && canSettle() ? "settled" : "unknown";
        },
        cancel() {
          if (!available()) return false;
          finish();
          return true;
        },
      };
    },
    prepareLiveInput(ctx, sourceUpdateIds, isCurrent) {
      const expectedOwner = owner,
        binding = deps.getJournalBindingKey?.();
      const ids = [...sourceUpdateIds];
      const currentOwner = () =>
        !!expectedOwner &&
        owner === expectedOwner &&
        expectedOwner.ctx === ctx &&
        !expectedOwner.controller.signal.aborted &&
        !!binding &&
        deps.getJournalBindingKey?.() === binding &&
        deps.isContextCurrent?.(ctx) !== false &&
        deps.hasAuthority(ctx) &&
        isQueueOwnerIdentityCurrent(expectedOwner) &&
        isCurrent?.() !== false;
      if (
        !currentOwner() ||
        !expectedOwner?.startupUpdateIds ||
        livePreparation ||
        deps.executeCustodiedUpdate ||
        !completeExact ||
        !ids.length ||
        new Set(ids).size !== ids.length ||
        ids.some(
          (id) =>
            !Number.isSafeInteger(id) ||
            id < 0 ||
            claims.has(id) ||
            unsettledExecutionsByUpdateId.has(id) ||
            (state.phase === "executing" && state.currentUpdateId === id),
        )
      )
        return undefined;
      let before: TelegramWorkerCoreSnapshot;
      try {
        before = deps.journal.read();
      } catch (error) {
        recordRuntimeEvent(error, { phase: "live-input-prepare" });
        return undefined;
      }
      if (
        !currentOwner() ||
        !isTelegramUpdateJournalLegacyFamilyVersion(before.version) ||
        before.entries.some((entry) => ids.includes(entry.updateId))
      )
        return undefined;
      const held: TelegramLiveInputPreparationState<TContext> = {
        version: before.version,
        ids: new Set(ids),
      };
      let released = false,
        completionReadiness: TelegramLiveSourceCompletionReadiness | undefined;
      livePreparation = held;
      const current = () =>
        livePreparation === held && !held.released && currentOwner();
      const readPending = (full = true) => {
        if (!current()) return undefined;
        try {
          const snapshot = deps.journal.read();
          const entries = snapshot.entries.filter((entry) =>
            held.ids.has(entry.updateId),
          );
          if (
            !current() ||
            snapshot.version !== held.version ||
            (full && entries.length !== ids.length) ||
            entries.some(
              (entry) =>
                entry.state !== "pending" ||
                entry.preApprovalExcluded === true ||
                entry.inputClaim ||
                entry.routingInput ||
                entry.failure ||
                entry.queueOwner ||
                entry.queueReceiptId ||
                entry.queueKind ||
                entry.queueHandoff ||
                "inputProvenance" in entry ||
                claims.has(entry.updateId) ||
                unsettledExecutionsByUpdateId.has(entry.updateId),
            )
          )
            return undefined;
          return entries as TelegramUpdateWorkerJournalSnapshot["entries"][number][];
        } catch (error) {
          recordRuntimeEvent(error, { phase: "live-input-observe" });
          return undefined;
        }
      };
      const finish = () => {
        if (!held.released || !held.status && !held.target) livePreparation = undefined;
        updateClaimCounts();
        notifyStateChange();
        blocked = false;
        pendingSignal = true;
        launchDrain();
      };
      updateClaimCounts();
      notifyStateChange();
      return {
        sourceUpdateIds: Object.freeze([...ids]),
        isCurrent: () => current() && !held.discardIssued,
        isOwnerCurrent: currentOwner,
        confirmSaved() {
          const entries = readPending();
          if (
            held.discardIssued ||
            !entries ||
            (held.saved && !isDeepStrictEqual(held.saved, entries))
          )
            return false;
          held.saved ??= structuredClone(entries);
          return true;
        },
        prepareSourceCompletion() {
          if (
            !current() ||
            held.discardIssued ||
            !held.saved ||
            ids.length !== 1 ||
            !deps.getQueueOwnerIdentity
          )
            return undefined;
          if (completionReadiness)
            return completionReadiness.isCurrent()
              ? completionReadiness
              : undefined;
          const entries = readPending(),
            entry = entries?.[0],
            journal = deps.journal,
            read = journal.read,
            remove = journal.removeCompletedExact;
          if (
            !entry ||
            !isDeepStrictEqual(entries, held.saved) ||
            typeof remove !== "function" ||
            !completeExact ||
            !current()
          )
            return undefined;
          const snapshot: TelegramDeferredSourceSnapshot = {
            source: {
              journalBindingKey: binding!,
              ...createTelegramUpdateJournalEntryDigest(entry),
            },
            update: structuredClone(entry.update),
          };
          const ownerCurrent = () =>
            !held.discardIssued &&
            currentOwner() &&
            deps.journal === journal &&
            journal.read === read &&
            journal.removeCompletedExact === remove;
          let retained:
            | {
                carrier: unknown;
                completion: TelegramDeferredSourceCompletionPreparation;
              }
            | undefined;
          completionReadiness = {
            get snapshot() {
              return structuredClone(snapshot);
            },
            isCurrent: ownerCurrent,
            bindCarrier(value) {
              if (
                !released ||
                !ownerCurrent() ||
                getTelegramUpdateExecutionFence(value)?.signal !==
                  expectedOwner.controller.signal
              )
                return undefined;
              if (retained)
                return value === retained.carrier &&
                  retained.completion.isCurrent()
                  ? retained.completion
                  : undefined;
              const completion = prepareTelegramDeferredSourceCompletion(value);
              if (
                !completion ||
                !isDeepStrictEqual(completion.source, snapshot.source) ||
                !ownerCurrent() ||
                !completion.isCurrent()
              )
                return undefined;
              retained = { carrier: value, completion };
              return completion;
            },
          };
          return ownerCurrent() ? completionReadiness : undefined;
        },
        canPrepareStatusConsumption() {
          return (
            current() &&
            !held.discardIssued &&
            typeof deps.admitPreparedLiveInput === "function" &&
            !!deps.getQueueOwnerIdentity
          );
        },
        prepareStatusConsumption(input) {
          const admit = deps.admitPreparedLiveInput,
            ports = {
              assertCurrent: input.assertCurrent,
              bindCarrier: input.bindCarrier,
              execute: input.execute,
            };
          if (
            !current() ||
            held.status ||
            typeof admit !== "function" ||
            !completionReadiness ||
            !completionReadiness.isCurrent() ||
            Object.values(ports).some((port) => typeof port !== "function") ||
            !isDeepStrictEqual(
              input.source,
              completionReadiness.snapshot.source,
            )
          )
            return false;
          const readiness = completionReadiness,
            readyCurrent = readiness.isCurrent;
          held.status = {
            current: () =>
              currentOwner() &&
              !held.discardIssued &&
              readiness.isCurrent === readyCurrent &&
              readyCurrent.call(readiness) &&
              deps.admitPreparedLiveInput === admit &&
              Object.entries(ports).every(
                ([key, value]) => Reflect.get(input, key) === value,
              ),
            assertCurrent: ports.assertCurrent.bind(input),
            bindCarrier: ports.bindCarrier.bind(input),
            execute: ports.execute.bind(input),
            admit,
          };
          return held.status.current();
        },
        release(canRelease, target) {
          if (
            !current() ||
            held.discardIssued ||
            !held.saved ||
            !canRelease() ||
            held.status?.current() === false
          )
            return false;
          const entries = readPending();
          if (
            !entries ||
            !isDeepStrictEqual(entries, held.saved) ||
            !canRelease() ||
            !current()
          )
            return false;
          if (target) {
            if (!Number.isSafeInteger(target.chatId) || target.chatId === 0 || !Number.isSafeInteger(target.threadId) || target.threadId <= 0 ||
              entries.some(entry => {
                const message = (entry.update.message ?? entry.update.edited_message) as { chat?: { id?: number } } | undefined;
                return message?.chat?.id !== target.chatId;
              })) return false;
            if (!held.status) held.target = { ...target };
          }
          released = true;
          held.released = true;
          finish();
          return true;
        },
        cancelEmpty() {
          if (!current() || held.discardIssued || held.saved) return false;
          try {
            const snapshot = deps.journal.read();
            if (
              !current() ||
              snapshot.version !== held.version ||
              snapshot.entries.some((entry) => held.ids.has(entry.updateId))
            )
              return false;
          } catch (error) {
            recordRuntimeEvent(error, { phase: "live-input-cancel-empty" });
            return false;
          }
          finish();
          return true;
        },
        discardSaved(canDiscard) {
          if (!current() || !canDiscard() || !completeExact) return "protected";
          if (held.discardIssued) return "unknown";
          const entries = readPending(false);
          if (
            !entries ||
            (held.saved && !isDeepStrictEqual(held.saved, entries)) ||
            !current() ||
            !canDiscard()
          )
            return "protected";
          if (!entries.length) {
            finish();
            return "discarded";
          }
          const updateIds = entries.map((entry) => entry.updateId);
          const expected = entries.map((entry) =>
            createTelegramUpdateJournalEntryDigest(entry),
          );
          held.discardIssued = true;
          try {
            const result = completeExact(
              updateIds,
              expected,
              undefined,
              () => current() && canDiscard(),
            );
            if (
              !current() ||
              !canDiscard() ||
              result.removedUpdateIds.length !== updateIds.length ||
              !updateIds.every((id) => result.removedUpdateIds.includes(id))
            )
              return "unknown";
          } catch (error) {
            recordRuntimeEvent(error, { phase: "live-input-discard" });
            return "unknown";
          }
          finish();
          return "discarded";
        },
      };
    },
    signal() {
      if (!owner || owner.controller.signal.aborted) return;
      blocked = false;
      pendingSignal = true;
      launchDrain();
    },
    armRoutingInput(input) {
      return mutateRoutingSource(input, false)?.lifetime;
    },
    selectRoutingInput(input) {
      return mutateRoutingSource(input, true)?.issued === true;
    },
    isRoutingInputCurrent(input) {
      return (
        owner?.controller.signal === input.signal &&
        !input.signal.aborted &&
        deferredSources.has(input.updateId) &&
        claims.get(input.updateId) !== "abandoning"
      );
    },
    prepareDeferredSourceCompletion(input) {
      const expectedOwner = owner,
        binding = deps.getJournalBindingKey?.(),
        journal = deps.journal,
        read = journal.read,
        remove = journal.removeCompletedExact;
      const current = () =>
        !!expectedOwner &&
        owner === expectedOwner &&
        expectedOwner.controller.signal === input.signal &&
        !input.signal.aborted &&
        !!binding &&
        deps.getJournalBindingKey?.() === binding &&
        deps.isContextCurrent?.(expectedOwner.ctx) !== false &&
        deps.hasAuthority(expectedOwner.ctx) &&
        isQueueOwnerIdentityCurrent(expectedOwner) &&
        deps.journal === journal &&
        journal.read === read &&
        journal.removeCompletedExact === remove;
      if (
        !deps.getQueueOwnerIdentity ||
        !expectedOwner?.startupUpdateIds ||
        typeof remove !== "function" ||
        !completeExact ||
        !current() ||
        deps.executeCustodiedUpdate
      )
        return undefined;
      let original: ReturnType<typeof inspectDeferredOriginal>;
      try {
        original = inspectDeferredOriginal(input);
      } catch (error) {
        recordRuntimeEvent(error, {
          phase: "source-completion-prepare",
          updateId: input.updateId,
        });
        return undefined;
      }
      if (
        !original ||
        !current() ||
        !isFreshLiveSource(expectedOwner!, input.updateId) ||
        original.entry.state !== "pending" ||
        original.entry.preApprovalExcluded ||
        original.entry.inputClaim ||
        original.entry.queueOwner ||
        original.entry.queueKind ||
        original.entry.queueReceiptId ||
        original.entry.queueHandoff ||
        original.entry.failure ||
        "inputProvenance" in original.entry
      )
        return undefined;
      const source = { ...original.source };
      return {
        get source() {
          return { ...source };
        },
        isCurrent: current,
      };
    },
    prepareDeferredQueueAdmission(input) {
      const expectedOwner = owner,
        binding = deps.getJournalBindingKey?.();
      const read = queueAdmissionRead,
        commit = queueAdmissionCommit,
        inspect = queueAdmissionInspect;
      const current = () =>
        !!expectedOwner &&
        owner === expectedOwner &&
        expectedOwner.controller.signal === input.signal &&
        !input.signal.aborted &&
        !!binding &&
        deps.getJournalBindingKey?.() === binding &&
        deps.hasAuthority(expectedOwner.ctx) &&
        deps.isContextCurrent?.(expectedOwner.ctx) !== false &&
        isQueueOwnerIdentityCurrent(expectedOwner) &&
        deps.journal === queueAdmissionJournal &&
        deps.journal.read === read &&
        deps.journal.markQueued === commit &&
        deps.journal.isQueueReceiptCurrent === inspect;
      if (
        !deps.getQueueOwnerIdentity ||
        typeof commit !== "function" ||
        !inspect ||
        !current()
      )
        return undefined;
      let original: ReturnType<typeof inspectDeferredOriginal>;
      try {
        original = inspectDeferredOriginal(input);
      } catch (error) {
        recordRuntimeEvent(error, {
          phase: "queue-admission-prepare",
          updateId: input.updateId,
        });
        return undefined;
      }
      if (
        !original ||
        !current() ||
        !isFreshLiveSource(expectedOwner!, input.updateId) ||
        original.entry.state !== "pending" ||
        original.entry.queueOwner ||
        original.entry.queueReceiptId ||
        original.entry.preApprovalExcluded
      )
        return undefined;
      const source = { ...original.source },
        update = structuredClone(original.entry.update);
      const complete = queueAdmissionJournal.completeQueued,
        completeScoped = queueAdmissionJournal.completeQueuedExact;
      const readCompletion = queueAdmissionJournal.inspectSourceCompletion;
      const completionCurrent = () =>
        current() &&
        queueAdmissionJournal.completeQueued === complete &&
        completeScoped === queueCompletionPort &&
        queueAdmissionJournal.completeQueuedExact === completeScoped &&
        readCompletion === completionReaderPort &&
        queueAdmissionJournal.inspectSourceCompletion === readCompletion;
      const inspectedReceipts = new WeakMap<
        TelegramQueueAdmissionReceiptLike,
        {
          receipt: TelegramQueueAdmissionReceiptLike;
          completion: TelegramUpdateJournalSourceCompletion;
        }
      >();
      return {
        isCurrent: current,
        inspectReceipt(receipt) {
          if (
            !current() ||
            receipt.journalBindingKey !== binding ||
            receipt.queueKind !== "prompt" ||
            !isDeepStrictEqual(receipt.sourceUpdateIds, [input.updateId])
          )
            return undefined;
          try {
            // The warm owner requires its actual publication ACK, not merely queued bytes or the report hint.
            const committed = getCurrentQueueReceipt(receipt);
            if (
              !committed ||
              !current() ||
              !isTelegramUpdateJournalQueueOwnerProcess(
                committed.queueOwner,
                expectedOwner!.queueOwnerIdentity,
              )
            )
              return undefined;
            const entry = findExactQueuedPromptEntry(
              read.call(queueAdmissionJournal),
              receipt.receiptId,
              input.updateId,
              committed.queueOwner,
              update,
            );
            if (
              !entry ||
              !current() ||
              !getCurrentQueueReceipt(receipt) ||
              !current()
            )
              return undefined;
            const scope = committed.sourceCompletions?.find(
              (scope) => scope.updateId === input.updateId,
            );
            if (
              scope?.sourceSha256 ===
              createTelegramUpdateJournalEntryDigest(entry).sourceSha256
            ) {
              inspectedReceipts.set(receipt, {
                receipt: normalizeQueueReceipt(committed.receipt),
                completion: {
                  updateId: scope.updateId,
                  sourceSha256: scope.sourceSha256,
                  completionSha256: scope.completionSha256,
                },
              });
            }
            return {
              source: { ...source },
              receipt: {
                queueKind: "prompt",
                receiptId: committed.receipt.receiptId,
                sourceUpdateIds: [...committed.receipt.sourceUpdateIds],
                queueOwner: { ...committed.queueOwner },
              },
            };
          } catch (error) {
            recordRuntimeEvent(error, {
              phase: "queue-admission-observe",
              updateId: input.updateId,
            });
            return undefined;
          }
        },
        prepareCompletionScope(receipt, queueOwner, completionSha256) {
          if (
            !completionCurrent() ||
            !queueCompletionPort ||
            !completionReaderPort ||
            !/^[a-f0-9]{64}$/u.test(completionSha256) ||
            receipt.journalBindingKey !== binding ||
            receipt.queueKind !== "prompt" ||
            !isDeepStrictEqual(receipt.sourceUpdateIds, [input.updateId]) ||
            !isTelegramUpdateJournalQueueOwnerProcess(
              queueOwner,
              expectedOwner!.queueOwnerIdentity,
            )
          )
            return undefined;
          try {
            if (!current()) return undefined;
            const entry = findExactQueuedPromptEntry(
              read.call(queueAdmissionJournal),
              receipt.receiptId,
              input.updateId,
              queueOwner,
              update,
            );
            if (
              !entry ||
              inspect.call(
                queueAdmissionJournal,
                normalizeQueueReceipt(receipt),
                { ...queueOwner },
              ) !== true ||
              !completionCurrent()
            )
              return undefined;
            const completion = {
              ...createTelegramUpdateJournalEntryDigest(entry),
              completionSha256,
            };
            inspectedReceipts.set(receipt, {
              receipt: normalizeQueueReceipt(receipt),
              completion: { ...completion },
            });
            return { ...completion, journalBindingKey: binding! };
          } catch (error) {
            recordRuntimeEvent(error, {
              phase: "queue-completion-scope",
              updateId: input.updateId,
            });
            return undefined;
          }
        },
        inspectCompletion(receipt) {
          const inspected = inspectedReceipts.get(receipt);
          // The native ACK belongs to this exact object and whole receipt, not an equivalent reconstructed query.
          if (
            !completionCurrent() ||
            !readCompletion ||
            !inspected ||
            !areTelegramQueueAdmissionReceiptsEqual(
              inspected.receipt,
              receipt,
            ) ||
            !isQueueReceiptCompletionAcknowledged(receipt) ||
            !completionCurrent()
          )
            return undefined;
          try {
            const acknowledged = readCompletion.call(queueAdmissionJournal, {
              ...inspected.completion,
            });
            return completionCurrent() &&
              isDeepStrictEqual(acknowledged, inspected.completion)
              ? { ...source }
              : undefined;
          } catch (error) {
            recordRuntimeEvent(error, {
              phase: "queue-completion-observe",
              updateId: input.updateId,
            });
            return undefined;
          }
        },
      };
    },
    inspectDeferredSource(input) {
      return inspectDeferredOriginal(input)?.source;
    },
    inspectDeferredSourceSnapshot(input) {
      const original = inspectDeferredOriginal(input);
      return (
        original && {
          source: original.source,
          update: structuredClone(original.entry.update),
        }
      );
    },
    isHistoricalSource(input) {
      const source = deferredSources.get(input.updateId);
      const isCurrent = () =>
        owner?.controller.signal === input.signal &&
        !input.signal.aborted &&
        source?.historical === true &&
        deferredSources.get(input.updateId) === source;
      if (!isCurrent()) return false;
      // Domain eligibility observes original evidence, never mutable handler projections.
      return (
        (!input.matchesOriginal ||
          input.matchesOriginal(structuredClone(source!.entry)) === true) &&
        isCurrent()
      );
    },
    getRoutingInput(input) {
      const lifetime = deferredSources.get(input.updateId)?.entry.routingInput;
      return owner?.controller.signal === input.signal &&
        !input.signal.aborted &&
        lifetime
        ? structuredClone(lifetime)
        : undefined;
    },
    supportsDeferredAbandonment(input) {
      const expectedOwner = owner;
      const source = deferredSources.get(input.updateId);
      if (
        !expectedOwner ||
        input.signal.aborted ||
        expectedOwner.controller.signal !== input.signal ||
        !source ||
        source.historical ||
        input.journalBindingKey !== source.journalBindingKey ||
        !deps.journal.abandonPending ||
        !deps.journal.inspectPendingRetention ||
        claims.get(input.updateId) === "queued"
      )
        return false;
      return (
        deps.isContextCurrent?.(expectedOwner.ctx) !== false &&
        deps.getJournalBindingKey?.() === source.journalBindingKey &&
        deps.hasAuthority(expectedOwner.ctx)
      );
    },
    abandonDeferred(input) {
      return abandonSource(input);
    },
    inspectAbandoning(input) {
      return inspectRecovery(input, "abandoning");
    },
    inspectHistorical(input) {
      return inspectRecovery(input, "historical");
    },
    async settleDeferred(input) {
      const expectedOwner = owner;
      if (
        !expectedOwner ||
        expectedOwner.controller.signal !== input.signal ||
        input.signal.aborted
      ) {
        return;
      }
      const authorityResult = checkAuthority(expectedOwner, input.updateId);
      if (authorityResult) {
        if (authorityResult === "blocked") {
          releaseDeferredClaims(
            input.outcome.kind === "queued"
              ? input.outcome.sourceUpdateIds
              : [input.updateId],
          );
        }
        return;
      }
      const claim = claims.get(input.updateId);
      if (livePreparation?.ids.has(input.updateId)) return;
      if (
        claim === "abandoning" ||
        claim === "historical" ||
        claim === "retained" ||
        (!claim && routingJournal?.inspectExpiry(input.updateId))
      )
        return;
      if (input.outcome.kind === "complete") {
        // Expiry may retire only a still-deferred source, never accepted queue work.
        if (claim !== "deferred") return;
        let completion: TelegramUpdateAdmissionOutcome;
        try {
          completion = validateTelegramUpdateAdmissionOutcome(
            input.outcome,
            input.updateId,
            new Set([input.updateId]),
          );
        } catch (error) {
          blockWithFailure(
            "invalid-outcome",
            "late-invalid-completion",
            error,
            input.updateId,
          );
          return;
        }
        if (completion.kind !== "complete") return;
        const source = completion.expectedSource && {
          ...completion.expectedSource,
        };
        const journalBindingKey = deps.getJournalBindingKey?.();
        const isCurrent = () =>
          owner === expectedOwner &&
          !input.signal.aborted &&
          deps.isContextCurrent?.(expectedOwner.ctx) !== false &&
          deps.hasAuthority(expectedOwner.ctx) &&
          isQueueOwnerIdentityCurrent(expectedOwner) &&
          deps.getJournalBindingKey?.() === journalBindingKey;
        const result = commitCompletedBatch(
          expectedOwner,
          [
            {
              updateId: input.updateId,
              ...(source ? { expectedSource: source } : {}),
            },
          ],
          source ? isCurrent : undefined,
        );
        if (!result) {
          transition("idle", input.updateId);
          if (source && isCurrent()) return { source, isCurrent };
        }
        return;
      }
      if (input.outcome.kind === "deferred") {
        if (claim === "queued") return;
        if (claim !== "deferred") {
          blockWithFailure(
            "invalid-outcome",
            "late-outcome-unclaimed",
            new TelegramUpdateAdmissionOutcomeError(
              `Telegram update ${input.updateId} reported a late deferred outcome without a live claim.`,
            ),
            input.updateId,
          );
          return;
        }
        transition("deferred", input.updateId);
        return;
      }
      let outcome: TelegramUpdateAdmissionOutcome;
      try {
        outcome = validateTelegramUpdateAdmissionOutcome(
          input.outcome,
          input.updateId,
          new Set([
            input.updateId,
            ...[...claims]
              .filter(
                ([, claim]) =>
                  claim !== "abandoning" &&
                  claim !== "historical" &&
                  claim !== "retained",
              )
              .map(([id]) => id),
          ]),
        );
      } catch (error) {
        blockWithFailure(
          "invalid-outcome",
          "late-invalid-outcome",
          error,
          input.updateId,
        );
        releaseDeferredClaims(input.outcome.sourceUpdateIds);
        return;
      }
      if (outcome.kind !== "queued") {
        blockWithFailure(
          "invalid-outcome",
          "late-invalid-outcome",
          new TelegramUpdateAdmissionOutcomeError(
            `Telegram update ${input.updateId} reported a non-queue late outcome.`,
          ),
          input.updateId,
        );
        return;
      }
      if (claim !== "deferred" && claim !== "queued") {
        blockWithFailure(
          "invalid-outcome",
          "late-outcome-unclaimed",
          new TelegramUpdateAdmissionOutcomeError(
            `Telegram update ${input.updateId} reported a late queue outcome without a live claim.`,
          ),
          input.updateId,
        );
        releaseDeferredClaims(outcome.sourceUpdateIds);
        return;
      }
      const publication = commitQueuedOutcome(
        expectedOwner,
        input.updateId,
        outcome,
      );
      const result =
        typeof publication === "string" ? publication : await publication;
      if (result === "blocked") {
        releaseDeferredClaims(outcome.sourceUpdateIds);
        return;
      }
      if (result === "aborted") return;
      transition("queued", input.updateId);
    },
    async settleCustodied(input) {
      const expectedOwner = owner;
      if (
        !expectedOwner ||
        expectedOwner.controller.signal !== input.signal ||
        input.signal.aborted
      )
        return;
      if (checkAuthority(expectedOwner, input.updateId)) return;
      const claim = claims.get(input.updateId);
      if (claim !== "deferred" && claim !== "queued") return;
      if (input.result.status === "deferred") return;
      if (input.result.status === "outcome-unknown") {
        transition("blocked", input.updateId, "execution");
        return;
      }
      if (input.result.status === "completed") {
        if (claim !== "deferred") return;
        claims.delete(input.updateId);
        transition("idle", input.updateId);
        pendingSignal = true;
        launchDrain();
        return;
      }
      const receipt = normalizeQueueReceipt(input.result.queueReceipt);
      const existing = committedQueueReceipts.get(receipt.receiptId);
      if (
        existing &&
        areTelegramQueueAdmissionReceiptsEqual(existing.receipt, receipt) &&
        areTelegramUpdateJournalQueueOwnersEqual(
          existing.queueOwner,
          input.result.queueReceipt.queueOwner,
        )
      )
        return;
      if (existing) {
        blockWithFailure(
          "invalid-outcome",
          "queue-receipt-conflict",
          new TelegramUpdateAdmissionOutcomeError(
            `Telegram queue receipt ${receipt.receiptId} conflicts with custodied authority.`,
          ),
          input.updateId,
        );
        return;
      }
      if (
        !receipt.sourceUpdateIds.includes(input.updateId) ||
        receipt.sourceUpdateIds.some(
          (updateId) => claims.get(updateId) !== "deferred",
        )
      ) {
        blockWithFailure(
          "invalid-outcome",
          "late-custody-unclaimed",
          new TelegramUpdateAdmissionOutcomeError(
            `Telegram update ${input.updateId} reported custodied queue without exact deferred claims.`,
          ),
          input.updateId,
        );
        return;
      }
      if (
        !isTelegramUpdateJournalQueueOwnerProcess(
          input.result.queueReceipt.queueOwner,
          expectedOwner.queueOwnerIdentity,
        )
      ) {
        blockWithFailure(
          "invalid-outcome",
          "custody-queue-owner",
          new Error(
            "Telegram custodied queue receipt belongs to another process.",
          ),
          input.updateId,
        );
        return;
      }
      for (const sourceUpdateId of receipt.sourceUpdateIds)
        claims.set(sourceUpdateId, "queued");
      try {
        await publishCommittedQueueReceipt(
          receipt,
          input.result.queueReceipt.queueOwner,
          expectedOwner,
        );
      } catch (error) {
        blockWithFailure(
          "invalid-outcome",
          "queue-receipt-publish",
          error,
          input.updateId,
        );
        return;
      }
      transition("queued", input.updateId);
    },
    isQueueReceiptCommitted: (receipt) =>
      getCurrentQueueReceipt(receipt) !== undefined,
    getQueueReceiptOwner(receipt) {
      const committed = getCurrentQueueReceipt(receipt);
      return committed ? { ...committed.queueOwner } : undefined;
    },
    getQueueReceiptSettlementOwner(receipt, ctx, reason) {
      const expectedOwner = owner,
        committed = committedQueueReceipts.get(receipt.receiptId);
      if (
        !expectedOwner ||
        expectedOwner.controller.signal.aborted ||
        !(deps.isContextCurrent?.(ctx) ?? expectedOwner.ctx === ctx) ||
        !isQueueOwnerIdentityCurrent(expectedOwner) ||
        !committed ||
        !areTelegramQueueAdmissionReceiptsEqual(
          committed.receipt,
          normalizeQueueReceipt(receipt),
        ) ||
        (deps.getJournalBindingKey &&
          committed.receipt.journalBindingKey !==
            deps.getJournalBindingKey()) ||
        !isTelegramUpdateJournalQueueOwnerProcess(
          committed.queueOwner,
          expectedOwner.queueOwnerIdentity,
        )
      )
        return undefined;
      const attempt = scopedQueueCompletionAttempts.get(receipt.receiptId);
      if (
        attempt
          ? attempt.owner !== expectedOwner ||
            attempt.reason !== reason ||
            attempt.journalBindingKey !== deps.getJournalBindingKey?.()
          : !getCurrentQueueReceipt(receipt)
      )
        return undefined;
      return { ...committed.queueOwner };
    },
    completeQueueReceipts: function completeQueueReceipts(input): boolean {
      const expectedOwner = owner;
      if (
        !expectedOwner ||
        expectedOwner.controller.signal.aborted ||
        !(deps.isContextCurrent?.(input.ctx) ?? expectedOwner.ctx === input.ctx)
      ) {
        return false;
      }
      // An ACK permits only local completion reconciliation, never execution readiness.
      const receipts =
        input.sourceCompletions === undefined
          ? input.receipts.filter(
              (receipt) => !isQueueReceiptCompletionAcknowledged(receipt),
            )
          : input.receipts;
      if (receipts.length === 0) return input.sourceCompletions === undefined;
      const normalizedReceipts = receipts.map(normalizeQueueReceipt);
      const receiptIds = new Set<string>();
      const sourceUpdateIds = new Set<number>();
      const queuedCompletions: Array<{
        queueKind: "prompt" | "control";
        receiptId: string;
        sourceUpdateIds: readonly number[];
        queueOwner: TelegramUpdateJournalQueueOwner;
      }> = [];
      for (const receipt of normalizedReceipts) {
        const committed = committedQueueReceipts.get(receipt.receiptId);
        if (!committed) return false;
        if (
          receiptIds.has(receipt.receiptId) ||
          !areTelegramQueueAdmissionReceiptsEqual(committed.receipt, receipt) ||
          !isTelegramUpdateJournalQueueOwnerProcess(
            committed.queueOwner,
            expectedOwner.queueOwnerIdentity,
          ) ||
          receipt.sourceUpdateIds.some((updateId) =>
            sourceUpdateIds.has(updateId),
          )
        ) {
          blockWithFailure(
            "invalid-outcome",
            "queue-receipt-completion-invalid",
            new TelegramUpdateAdmissionOutcomeError(
              `Telegram ${input.reason} requested invalid queue receipt ${receipt.receiptId}.`,
            ),
          );
          return false;
        }
        receiptIds.add(receipt.receiptId);
        queuedCompletions.push({
          ...receipt,
          queueOwner: { ...committed.queueOwner },
        });
        for (const updateId of receipt.sourceUpdateIds) {
          sourceUpdateIds.add(updateId);
        }
      }
      const completionBinding = deps.getJournalBindingKey?.();
      const ordinaryObserverBound = normalizedReceipts.every(
        (receipt) =>
          committedQueueReceipts.get(receipt.receiptId)!.receipt
            .journalBindingKey === completionBinding,
      );
      const ordinaryCompletionCurrent = (): boolean =>
        ordinaryObserverBound &&
        owner === expectedOwner &&
        !expectedOwner.controller.signal.aborted &&
        (deps.isContextCurrent?.(input.ctx) ??
          expectedOwner.ctx === input.ctx) &&
        isQueueOwnerIdentityCurrent(expectedOwner) &&
        deps.getJournalBindingKey?.() === completionBinding;
      let removedUpdateIds: readonly number[];
      let scopedCompletionCurrent: (() => boolean) | undefined;
      try {
        const prepared = normalizedReceipts.flatMap(
          (receipt) =>
            committedQueueReceipts.get(receipt.receiptId)!.sourceCompletions ??
            [],
        );
        const sourceCompletions =
          input.sourceCompletions === undefined
            ? prepared.length
              ? prepared
              : undefined
            : input.sourceCompletions;
        if (
          input.sourceCompletions !== undefined &&
          prepared.some(
            (expected) =>
              !input.sourceCompletions!.some((value) =>
                isDeepStrictEqual(value, expected),
              ),
          )
        ) {
          throw new Error(
            "Telegram queued completion conflicts with its prepared source scopes.",
          );
        }
        if (
          input.sourceCompletions === undefined &&
          prepared.length &&
          receipts.some(
            (receipt) => !requiredScopedQueueReceipts.has(receipt.receiptId),
          )
        ) {
          const scoped = receipts.filter((receipt) =>
            requiredScopedQueueReceipts.has(receipt.receiptId),
          );
          const ordinary = receipts.filter(
            (receipt) => !requiredScopedQueueReceipts.has(receipt.receiptId),
          );
          if (!scoped.length || !ordinary.length)
            throw new Error(
              "Telegram mixed queue completion has incomplete scoped authority.",
            );
          const binding = deps.getJournalBindingKey?.();
          const current = (): boolean =>
            owner === expectedOwner &&
            !expectedOwner.controller.signal.aborted &&
            (deps.isContextCurrent?.(input.ctx) ??
              expectedOwner.ctx === input.ctx) &&
            isQueueOwnerIdentityCurrent(expectedOwner) &&
            !!binding &&
            deps.getJournalBindingKey?.() === binding;
          // Independent whole receipts need independent ACKs. Ordinary siblings must not acquire invented scopes.
          if (
            !current() ||
            !completeQueueReceipts({
              receipts: scoped,
              ctx: input.ctx,
              reason: input.reason,
            }) ||
            !current()
          )
            return false;
          return completeQueueReceipts({
            receipts: ordinary,
            ctx: input.ctx,
            reason: input.reason,
          });
        }
        if (sourceCompletions === undefined) {
          if (
            queuedCompletions.some((receipt) =>
              requiredScopedQueueReceipts.has(receipt.receiptId),
            )
          ) {
            throw new Error(
              "Telegram scoped queue completion cannot downgrade required source scopes.",
            );
          }
          removedUpdateIds =
            deps.journal.completeQueued(queuedCompletions).removedUpdateIds;
        } else {
          for (const receipt of queuedCompletions)
            requiredScopedQueueReceipts.add(receipt.receiptId);
          queuedCompletions.sort((a, b) =>
            a.receiptId < b.receiptId ? -1 : a.receiptId > b.receiptId ? 1 : 0,
          );
          const journalBindingKey = deps.getJournalBindingKey?.();
          const current = (): boolean =>
            owner === expectedOwner &&
            !expectedOwner.controller.signal.aborted &&
            (deps.isContextCurrent?.(input.ctx) ??
              expectedOwner.ctx === input.ctx) &&
            isQueueOwnerIdentityCurrent(expectedOwner) &&
            deps.getJournalBindingKey?.() === journalBindingKey;
          if (
            !journalBindingKey ||
            !current() ||
            !completeQueuedExact ||
            !inspectCompletion ||
            !Array.isArray(sourceCompletions) ||
            (input.sourceCompletions !== undefined &&
              sourceCompletions.length !== sourceUpdateIds.size)
          ) {
            throw new Error(
              "Telegram scoped queue completion requires full current source authority.",
            );
          }
          scopedCompletionCurrent = current;
          const completions = normalizeTelegramQueueSourceCompletions(
            sourceCompletions,
            sourceUpdateIds,
            journalBindingKey,
            input.sourceCompletions !== undefined,
          ).map(({ journalBindingKey: _binding, ...completion }) => completion);
          if (
            queuedCompletions.some(
              (receipt) =>
                !completions.some((scope) =>
                  receipt.sourceUpdateIds.includes(scope.updateId),
                ),
            )
          ) {
            throw new Error(
              "Telegram scoped queue completion requires a proven origin for every whole receipt.",
            );
          }
          const previous = queuedCompletions.map((receipt) =>
            scopedQueueCompletionAttempts.get(receipt.receiptId),
          );
          const retained = previous.find((attempt) => attempt !== undefined);
          if (
            retained &&
            (previous.some((attempt) => attempt !== retained) ||
              retained.owner !== expectedOwner ||
              retained.journalBindingKey !== journalBindingKey ||
              retained.reason !== input.reason ||
              !isDeepStrictEqual(retained.receipts, queuedCompletions) ||
              !isDeepStrictEqual(retained.completions, completions))
          ) {
            throw new Error(
              "Telegram scoped queue completion has conflicting issued authority.",
            );
          }
          if (!retained) {
            const attempt = {
              owner: expectedOwner,
              journalBindingKey,
              reason: input.reason,
              receipts: queuedCompletions.map((receipt) => ({
                ...receipt,
                sourceUpdateIds: [...receipt.sourceUpdateIds],
                queueOwner: { ...receipt.queueOwner },
              })),
              completions: completions.map((completion) => ({ ...completion })),
            };
            if (!current())
              throw new Error(
                "Telegram scoped queue completion authority changed before disposal.",
              );
            // Mark before issuance: an exception may follow a committed rename, and cannot license another disposal.
            for (const receipt of queuedCompletions)
              scopedQueueCompletionAttempts.set(receipt.receiptId, attempt);
            const result = completeQueuedExact(
              queuedCompletions.map((receipt) => ({
                ...receipt,
                sourceUpdateIds: [...receipt.sourceUpdateIds],
                queueOwner: { ...receipt.queueOwner },
              })),
              completions.map((completion) => ({ ...completion })),
            );
            if (
              !current() ||
              !isDeepStrictEqual(result.sourceCompletions, completions)
            ) {
              throw new Error(
                "Telegram scoped queue completion ACK was not confirmed.",
              );
            }
            const removed = new Set(result.removedUpdateIds);
            if (
              removed.size !== sourceUpdateIds.size ||
              [...sourceUpdateIds].some((id) => !removed.has(id))
            ) {
              throw new Error(
                "Telegram scoped queue completion did not remove every source.",
              );
            }
          }
          for (const completion of completions) {
            if (
              !current() ||
              !isDeepStrictEqual(
                inspectCompletion({ ...completion }),
                completion,
              ) ||
              !current()
            ) {
              throw new Error(
                "Telegram scoped queue completion ACK was not retained under current authority.",
              );
            }
          }
          // Every immutable whole receipt has a scoped queued-origin witness; native queued ACK continuity proves its complete removal.
          // Unscoped siblings receive only receipt acknowledgement, never a source marker or absence-based proof.
          removedUpdateIds = [...sourceUpdateIds];
        }
      } catch (error) {
        blockWithFailure("journal-write", "queue-receipt-completion", error);
        return false;
      }
      const removed = new Set(removedUpdateIds);
      if (
        removed.size !== sourceUpdateIds.size ||
        [...sourceUpdateIds].some((updateId) => !removed.has(updateId))
      ) {
        blockWithFailure(
          "journal-write",
          "queue-receipt-completion",
          new Error(
            `Telegram ${input.reason} did not complete every receipt source.`,
          ),
        );
        return false;
      }
      receipts.forEach((receipt, index) => {
        acknowledgedQueueReceiptCompletions.set(
          receipt,
          normalizedReceipts[index]!,
        );
      });
      for (const updateId of sourceUpdateIds) claims.delete(updateId);
      for (const receiptId of receiptIds) {
        committedQueueReceipts.delete(receiptId);
        requiredScopedQueueReceipts.delete(receiptId);
        scopedQueueCompletionAttempts.delete(receiptId);
      }
      const completedUpdateIds = [...sourceUpdateIds];
      state.lastCompletedUpdateId = Math.max(
        state.lastCompletedUpdateId ?? -1,
        ...completedUpdateIds,
      );
      state.lastCompletedAtMs = getNowMs();
      state.journalEntryCount = Math.max(
        0,
        state.journalEntryCount - completedUpdateIds.length,
      );
      updateClaimCounts();
      notifyStateChange();
      if (scopedCompletionCurrent)
        for (const receipt of normalizedReceipts) {
          if (!scopedCompletionCurrent()) break;
          try {
            observeQueuedCompletion?.(
              normalizeQueueReceipt(receipt),
              input.ctx,
            );
          } catch (error) {
            recordRuntimeEvent(error, {
              phase: "queue-receipt-completion-observer",
              receiptId: receipt.receiptId,
            });
          }
        }
      // Ordinary queued disposal is source completion too; notify only after a whole positive ACK and fresh origin authority.
      if (!scopedCompletionCurrent)
        for (const updateId of completedUpdateIds) {
          try {
            if (!ordinaryCompletionCurrent()) break;
            deps.onUpdateCompleted?.(updateId, input.ctx, completionBinding);
          } catch (error) {
            recordRuntimeEvent(error, {
              phase: "queue-source-completion-observer",
              updateId,
            });
          }
        }
      if (!scopedCompletionCurrent || scopedCompletionCurrent()) {
        pendingSignal = true;
        launchDrain();
      }
      return true;
    },
    async stop() {
      const expectedOwner = owner;
      if (!expectedOwner) return;
      pendingSignal = false;
      clearRetryTimer();
      clearRoutingTimer();
      expectedOwner.controller.abort();
      await drainPromise?.catch(() => undefined);
      if (owner !== expectedOwner) return;
      owner = undefined;
      livePreparation = undefined;
      delete state.preparedInputCount;
      drainPromise = undefined;
      claims.clear();
      deferredSources.clear();
      committedQueueReceipts.clear();
      blocked = false;
      state.phase = "stopped";
      state.phaseStartedAtMs = getNowMs();
      state.currentUpdateId = undefined;
      state.blockedReason = undefined;
      clearTelegramUpdateWorkerClaimState(state, unsettledExecutions.size);
      notifyStateChange();
    },
    async waitForDrain() {
      await (drainPromise ?? Promise.resolve());
      await Promise.allSettled(
        [...pendingQueuePublications.values()].map((value) => value.task),
      );
    },
    getState() {
      return getTelegramUpdateWorkerStateSnapshot(state);
    },
  };
}

// --- Public update handler registry ---

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

const TELEGRAM_UPDATE_EXECUTION_FENCE = Symbol(
  "pi-telegram.update-execution-fence",
);

type TelegramExecutionFencedUpdate = {
  [TELEGRAM_UPDATE_EXECUTION_FENCE]?: TelegramUpdateExecutionFence;
};

export function getTelegramUpdateExecutionFence(
  update: unknown,
): TelegramUpdateExecutionFence | undefined {
  if (!update || typeof update !== "object") return undefined;
  return (update as TelegramExecutionFencedUpdate)[
    TELEGRAM_UPDATE_EXECUTION_FENCE
  ];
}

function bindTelegramUpdateExecutionFenceCarrier<TValue>(
  value: TValue | undefined,
  execution: TelegramUpdateExecutionFence,
): TValue | undefined {
  if (!value || typeof value !== "object") return value;
  Object.defineProperty(value, TELEGRAM_UPDATE_EXECUTION_FENCE, {
    configurable: true,
    enumerable: false,
    value: execution,
  });
  return value;
}

function bindTelegramUpdateExecutionFence<
  TUpdate extends TelegramUpdateFlow & object,
>(update: TUpdate, execution: TelegramUpdateExecutionFence): TUpdate {
  bindTelegramUpdateExecutionFenceCarrier(update, execution);
  bindTelegramUpdateExecutionFenceCarrier(update.message, execution);
  bindTelegramUpdateExecutionFenceCarrier(update.edited_message, execution);
  bindTelegramUpdateExecutionFenceCarrier(update.callback_query, execution);
  bindTelegramUpdateExecutionFenceCarrier(
    update.callback_query?.message,
    execution,
  );
  bindTelegramUpdateExecutionFenceCarrier(update.guest_message, execution);
  bindTelegramUpdateExecutionFenceCarrier(update.message_reaction, execution);
  return update;
}

export function assertTelegramUpdateExecutionCurrent(update: unknown): void {
  getTelegramUpdateExecutionFence(update)?.assertCurrent();
}

export function createTelegramUpdateExecutionFenceGuard(
  update: unknown,
): () => void {
  const execution = getTelegramUpdateExecutionFence(update);
  return (): void => execution?.assertCurrent();
}

export function carryTelegramUpdateExecutionFence<TTarget extends object>(
  source: unknown,
  target: TTarget,
): TTarget {
  const execution = getTelegramUpdateExecutionFence(source);
  return execution
    ? bindTelegramUpdateExecutionFenceCarrier(target, execution)!
    : target;
}

export type TelegramUpdateHandler = (
  update: unknown,
  execution?: TelegramUpdateExecutionFence,
) =>
  | TelegramUpdateHandlerVerdict
  | void
  | Promise<TelegramUpdateHandlerVerdict | void>;

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
  dispatch: (
    update: unknown,
    execution?: TelegramUpdateExecutionFence,
  ) => Promise<TelegramUpdateHandlerVerdict>;
}

const UPDATE_HANDLER_REGISTRY_KEY = "__piTelegramUpdateHandlerRegistry__";

function isValidV1UpdateHandlerRegistry(
  candidate: unknown,
): candidate is TelegramUpdateHandlerRegistry {
  if (!candidate || typeof candidate !== "object") return false;
  const r = candidate as Partial<TelegramUpdateHandlerRegistry>;
  return (
    r.version === 1 &&
    typeof r.add === "function" &&
    typeof r.dispatch === "function"
  );
}

function getOrCreateUpdateHandlerRegistry(): TelegramUpdateHandlerRegistry {
  const g = globalThis as Record<string, unknown>;
  const existing = g[UPDATE_HANDLER_REGISTRY_KEY];
  if (isValidV1UpdateHandlerRegistry(existing)) return existing;
  const handlers = new Set<TelegramUpdateHandler>();
  const registry: TelegramUpdateHandlerRegistry = {
    version: 1,
    add(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async dispatch(update, execution) {
      for (const handler of handlers) {
        execution?.assertCurrent();
        try {
          const result = await handler(update, execution);
          if (result === "consume") return "consume";
        } catch {
          // Update handler errors must not break polling.
        }
      }
      return "pass";
    },
  };
  g[UPDATE_HANDLER_REGISTRY_KEY] = registry;
  return registry;
}

/**
 * Called by pi-telegram's own runtime to obtain the registry it dispatches
 * through. Extension consumers should not call this; use
 * {@link registerTelegramUpdateHandler} instead.
 */
export function getTelegramUpdateHandlerRegistry(): TelegramUpdateHandlerRegistry {
  return getOrCreateUpdateHandlerRegistry();
}

export interface TelegramUpdateAdmissionHandleDeps<
  TUpdate extends TelegramUpdateFlow & { update_id: number },
  TContext,
> {
  defaultHandle: (
    update: TUpdate,
    ctx: TContext,
    execution?: TelegramUpdateExecutionFence,
  ) => Promise<void>;
  registry?: TelegramUpdateHandlerRegistry;
  getJournalBindingKey?: () => string | undefined;
  onLateOutcome?: (
    outcome: TelegramUpdateAdmissionOutcome,
    details: {
      updateId: number;
      ctx: TContext;
      signal: AbortSignal;
    },
  ) =>
    | void
    | TelegramDeferredSourceCompletion
    | Promise<void | TelegramDeferredSourceCompletion>;
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

function mergeTelegramReportedAdmissionOutcome(
  current: TelegramUpdateAdmissionOutcome | undefined,
  next: TelegramUpdateAdmissionOutcome,
  updateId: number,
): TelegramUpdateAdmissionOutcome {
  if (!current || current.kind === "deferred") return next;
  if (next.kind === "deferred") return current;
  if (current.kind === "complete" && next.kind === "complete") {
    if (!current.expectedSource) return next;
    if (!next.expectedSource) return current;
    if (
      current.expectedSource.updateId === next.expectedSource.updateId &&
      current.expectedSource.journalBindingKey ===
        next.expectedSource.journalBindingKey &&
      current.expectedSource.sourceSha256 === next.expectedSource.sourceSha256
    ) {
      if (!current.expectedSource.completionSha256) return next;
      if (
        !next.expectedSource.completionSha256 ||
        current.expectedSource.completionSha256 ===
          next.expectedSource.completionSha256
      )
        return current;
    }
    throw new TelegramUpdateAdmissionOutcomeError(
      `Telegram update ${updateId} reported conflicting completion sources.`,
    );
  }
  if (
    current.kind === "queued" &&
    next.kind === "queued" &&
    areTelegramQueueAdmissionReceiptsEqual(current, next)
  )
    return current;
  throw new TelegramUpdateAdmissionOutcomeError(
    `Telegram update ${updateId} reported conflicting queue outcomes.`,
  );
}

export type TelegramCustodiedExecutionResult =
  | { status: "completed" }
  | { status: "deferred"; receipt: TelegramInputJournalReceipt }
  | {
      status: "queued";
      queueReceipt: ReturnType<
        TelegramInputJournalStore["queueInputs"]
      >["queueReceipt"];
    }
  | { status: "outcome-unknown"; receipt: TelegramInputJournalReceipt };

type TelegramCustodyExecutionJournal = Pick<
  TelegramInputJournalStore,
  "acquireInput" | "startInput" | "completeInput" | "queueInputs"
>;

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
  sourceClaim: { acquisitionId: string; handoffId: string };
}

export interface TelegramInputCustodyBusBindingRuntime<TContext> {
  acceptHandoff(
    input: TelegramInputCustodyHandoffAcceptanceInput,
    ctx: TContext,
  ): {
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
  wakeSource(
    input: TelegramCustodiedSourceReferenceWakeInput,
    ctx: TContext,
  ): void;
  resolveForwardReference(input: {
    sourceUpdateId: number;
    recipientBindingKey: string;
  }):
    | {
        sourceRecoveryKey: string;
        source: {
          updateId: number;
          owner: {
            acquisitionId: string;
            handoffId: string;
          };
        };
      }
    | undefined;
}

export function createTelegramCustodiedExecutionSession(input: {
  journal: TelegramCustodyExecutionJournal;
  recipientBindingKey: string;
}): {
  execute(
    update: TelegramJournaledUpdate,
    handler: (
      update: TelegramJournaledUpdate,
    ) => Promise<TelegramUpdateAdmissionOutcome>,
  ): Promise<TelegramCustodiedExecutionResult>;
  settle(
    updateId: number,
    outcome: TelegramUpdateAdmissionOutcome,
  ): Promise<TelegramCustodiedExecutionResult>;
} {
  const receipts = new Map<number, TelegramInputJournalReceipt>();
  const settledQueues = new Map<
    number,
    Extract<TelegramCustodiedExecutionResult, { status: "queued" }>
  >();
  const settle = async (
    updateId: number,
    outcome: TelegramUpdateAdmissionOutcome,
  ): Promise<TelegramCustodiedExecutionResult> => {
    const receipt = receipts.get(updateId);
    if (!receipt) {
      const duplicate = settledQueues.get(updateId);
      if (
        duplicate &&
        outcome.kind === "queued" &&
        duplicate.queueReceipt.queueKind === outcome.queueKind &&
        duplicate.queueReceipt.receiptId === outcome.receiptId &&
        duplicate.queueReceipt.sourceUpdateIds.length ===
          outcome.sourceUpdateIds.length &&
        duplicate.queueReceipt.sourceUpdateIds.every(
          (id, index) => id === outcome.sourceUpdateIds[index],
        )
      ) {
        settledQueues.delete(updateId);
        return duplicate;
      }
      throw new TelegramUpdateAdmissionOutcomeError(
        `Telegram deferred custody ${updateId} has no exact running receipt.`,
      );
    }
    if (outcome.kind === "deferred") return { status: "deferred", receipt };
    if (outcome.kind === "queued") {
      if (!outcome.sourceUpdateIds.includes(updateId))
        throw new TelegramUpdateAdmissionOutcomeError(
          "Telegram grouped queue custody omitted the settling input.",
        );
      const grouped = outcome.sourceUpdateIds.map((sourceUpdateId) =>
        receipts.get(sourceUpdateId),
      );
      if (grouped.some((candidate) => !candidate))
        throw new TelegramUpdateAdmissionOutcomeError(
          "Telegram grouped queue custody omitted an exact running source receipt.",
        );
      const queued = input.journal.queueInputs({
        queueKind: outcome.queueKind,
        receiptId: outcome.receiptId,
        receipts: grouped as TelegramInputJournalReceipt[],
      });
      const result = {
        status: "queued" as const,
        queueReceipt: queued.queueReceipt,
      };
      for (const sourceUpdateId of outcome.sourceUpdateIds) {
        receipts.delete(sourceUpdateId);
        if (sourceUpdateId !== updateId)
          settledQueues.set(sourceUpdateId, result);
      }
      return result;
    }
    input.journal.completeInput(receipt);
    receipts.delete(updateId);
    return { status: "completed" };
  };
  return {
    settle,
    async execute(update, handler) {
      const acquired = input.journal.acquireInput({
        updateId: update.update_id,
        recipientBindingKey: input.recipientBindingKey,
        executionUpdate: update,
      });
      const started = input.journal.startInput(acquired.receipt);
      if (!started.started)
        return { status: "outcome-unknown", receipt: acquired.receipt };
      receipts.set(update.update_id, acquired.receipt);
      let outcome: TelegramUpdateAdmissionOutcome;
      try {
        outcome = await handler(started.update);
      } catch (error) {
        receipts.delete(update.update_id);
        throw error;
      }
      return settle(update.update_id, outcome);
    },
  };
}

/**
 * Compose the stable public handler registry with source-bound semantic
 * admission. Production polling switches to this only with the journal worker.
 */
export function createTelegramUpdateAdmissionHandle<
  TUpdate extends TelegramUpdateFlow & { update_id: number },
  TContext,
>(
  deps: TelegramUpdateAdmissionHandleDeps<TUpdate, TContext>,
): (
  update: TUpdate,
  ctx: TContext,
  signal: AbortSignal,
) => Promise<TelegramUpdateAdmissionOutcome> {
  if (deps.onLateOutcome && !deps.onLateOutcomeError) {
    throw new Error(
      "Telegram late admission outcomes require a diagnostic error sink.",
    );
  }
  return createTelegramUpdateSourceAdmissionHandle(deps);
}

/** Same native source/fence/late-ACK owner, with an internal binding-only callback instead of registry/ordinary dispatch. */
function createTelegramUpdateSourceAdmissionHandle<
  TUpdate extends TelegramUpdateFlow & { update_id: number },
  TContext,
>(
  deps: TelegramUpdateAdmissionHandleDeps<TUpdate, TContext>,
  capture?: (update: TUpdate) => void,
): (
  update: TUpdate,
  ctx: TContext,
  signal: AbortSignal,
) => Promise<TelegramUpdateAdmissionOutcome> {
  const registry = deps.registry ?? getOrCreateUpdateHandlerRegistry();
  let nextExecutionGeneration = 0;
  return async (update, ctx, signal) => {
    const generation = ++nextExecutionGeneration;
    const journalBindingKey = deps.getJournalBindingKey?.();
    let suspended = false;
    let routingClaims = 0;
    let abandoned: TelegramUpdateJournalPendingAbandonmentResult | undefined;
    let routingLifetime: TelegramUpdateJournalRoutingInput | undefined;
    let routingSourceIds: readonly number[] | undefined;
    let routingClockUnknown = false;
    let routingSelectionAttempted = false;
    let routingSelectionConfirmed = false;
    const execution: TelegramUpdateExecutionFence = {
      generation,
      updateId: update.update_id,
      signal,
      isCurrent: () =>
        !signal.aborted &&
        !suspended &&
        ((!routingLifetime && !routingClockUnknown) ||
          immediate ||
          settlementReported ||
          deps.isRoutingInputCurrent?.({
            updateId: update.update_id,
            signal,
          }) !== false),
      assertCurrent() {
        if (!execution.isCurrent()) {
          throw signal.reason ?? new DOMException("Aborted", "AbortError");
        }
      },
    };
    execution.assertCurrent();
    if (!capture) {
      const verdict = await registry.dispatch(update, execution);
      execution.assertCurrent();
      if (verdict === "consume") return { kind: "complete" };
    }
    let immediate = true;
    let settlementReported = false;
    let outcome: TelegramUpdateAdmissionOutcome | undefined;
    let completionAttempted = false;
    let completedSource: TelegramDeferredSourceCompletion | undefined;
    const completionObservers = new Set<() => void>();
    const boundUpdate = bindTelegramUpdateExecutionFence(
      bindTelegramUpdateAdmissionSource(
        update,
        (next) => {
          if (!execution.isCurrent()) return;
          if (next.kind === "deferred" && next.routingReview) {
            if (
              !immediate ||
              settlementReported ||
              routingClaims > 0 ||
              !deps.isHistoricalSource?.({ updateId: update.update_id, signal })
            ) {
              throw new TelegramUpdateAdmissionOutcomeError(
                "Historical review cannot override accepted or selected work.",
              );
            }
            suspended = true;
          }
          if (next.kind !== "deferred") settlementReported = true;
          if (immediate) {
            outcome = mergeTelegramReportedAdmissionOutcome(
              outcome,
              next,
              update.update_id,
            );
            return;
          }
          if (!deps.onLateOutcome) {
            throw new TelegramUpdateAdmissionOutcomeError(
              `Telegram update ${update.update_id} reported a late outcome without an owner.`,
            );
          }
          const expectedSource =
            next.kind === "complete" &&
            next.expectedSource &&
            !completionAttempted
              ? { ...next.expectedSource }
              : undefined;
          if (expectedSource) completionAttempted = true;
          const reported = expectedSource
            ? { ...next, expectedSource: { ...expectedSource } }
            : next;
          void Promise.resolve()
            .then(async () => {
              if (!execution.isCurrent()) return;
              const completion = await deps.onLateOutcome!(reported, {
                updateId: update.update_id,
                ctx,
                signal,
              });
              if (
                expectedSource &&
                completion &&
                execution.isCurrent() &&
                completion.isCurrent() &&
                isDeepStrictEqual(completion.source, expectedSource)
              ) {
                completedSource = { ...completion, source: { ...expectedSource } };
                for (const notify of completionObservers) {
                  try { notify(); } catch { /* Observation cannot invalidate an exact removal ACK. */ }
                }
              }
            })
            .catch((error) => {
              try {
                deps.onLateOutcomeError?.(error, update.update_id);
              } catch {
                // Diagnostic sinks must not create an unhandled late Promise.
              }
            });
        },
        {
          journalBindingKey,
          abandon: (authority) => {
            const isCurrent = () =>
              !signal.aborted &&
              routingClaims === 0 &&
              !settlementReported &&
              authority.isCurrent();
            if (
              immediate ||
              outcome?.kind !== "deferred" ||
              !deps.abandonDeferred ||
              !isCurrent()
            )
              return undefined;
            if (abandoned) return { ...abandoned, duplicate: true };
            const wasSuspended = suspended;
            suspended = true;
            // Failed/unknown publication keeps dispatch suspended for exact cancellation retry.
            // An ineligible request that attempted no publication remains inert.
            const result = deps.abandonDeferred({
              ...authority,
              updateId: update.update_id,
              signal,
              isCurrent,
            });
            if (result) abandoned = result;
            else suspended = wasSuspended;
            return result;
          },
          inspectAbandoning: (request) =>
            execution.isCurrent()
              ? deps.inspectAbandoning?.({ ...request, signal })
              : undefined,
          inspectHistorical: (request) =>
            execution.isCurrent()
              ? deps.inspectHistorical?.({ ...request, signal })
              : undefined,
          inspectSource: () =>
            execution.isCurrent() && !immediate && !settlementReported
              ? deps.inspectDeferredSource?.({
                  updateId: update.update_id,
                  signal,
                })
              : undefined,
          inspectSourceSnapshot: () =>
            execution.isCurrent() && !immediate && !settlementReported
              ? deps.inspectDeferredSourceSnapshot?.({
                  updateId: update.update_id,
                  signal,
                })
              : undefined,
          subscribeCompletion: (notify) => {
            completionObservers.add(notify);
            return () => { completionObservers.delete(notify); };
          },
          inspectCompletion: () =>
            execution.isCurrent() && completedSource?.isCurrent()
              ? { ...completedSource.source }
              : undefined,
          isSourceUnsettled: () =>
            execution.isCurrent() &&
            !immediate &&
            !settlementReported &&
            !suspended,
          prepareQueueAdmission: () =>
            execution.isCurrent() &&
            !immediate &&
            !settlementReported &&
            !suspended
              ? deps.prepareDeferredQueueAdmission?.({
                  updateId: update.update_id,
                  signal,
                })
              : undefined,
          prepareSourceCompletion: () =>
            execution.isCurrent() &&
            !immediate &&
            !settlementReported &&
            !suspended
              ? deps.prepareDeferredSourceCompletion?.({
                  updateId: update.update_id,
                  signal,
                })
              : undefined,
          acknowledgeTransferred: () => { settlementReported = true; },
          prepareLiveInput: (sourceUpdateIds, isCurrent, onTransferred) =>
            execution.isCurrent() &&
            !immediate &&
            !settlementReported &&
            !suspended
              ? deps.prepareDeferredLiveInput?.({
                  updateId: update.update_id,
                  sourceUpdateIds,
                  signal,
                  isCurrent: () => execution.isCurrent() && isCurrent(),
                  onTransferred,
                })
              : undefined,
          isHistorical: (matchesOriginal) =>
            !signal.aborted &&
            deps.isHistoricalSource?.({
              updateId: update.update_id,
              signal,
              ...(matchesOriginal ? { matchesOriginal } : {}),
            }) === true,
          isHistoricalReviewHeld: () =>
            !signal.aborted &&
            suspended &&
            outcome?.kind === "deferred" &&
            outcome.routingReview === true,
          supportsAbandonment: (journalBindingKey) =>
            !signal.aborted &&
            !settlementReported &&
            deps.supportsDeferredAbandonment?.({
              updateId: update.update_id,
              signal,
              journalBindingKey,
            }) === true,
          getRoutingInput: () =>
            deps.getRoutingInput?.({ updateId: update.update_id, signal }),
          armRoutingInput: (operatorUserId, sourceUpdateIds, chooser) => {
            execution.assertCurrent();
            if (settlementReported || routingClaims || suspended)
              return undefined;
            if (routingClockUnknown)
              throw new TelegramUpdateAdmissionOutcomeError(
                "Telegram routing input clock publication is unconfirmed.",
              );
            const ids = [...sourceUpdateIds];
            if (routingSourceIds && !isDeepStrictEqual(ids, routingSourceIds))
              throw new TelegramUpdateAdmissionOutcomeError(
                "Telegram routing input source membership changed.",
              );
            try {
              routingLifetime = deps.armRoutingInput?.({
                updateId: update.update_id,
                signal,
                operatorUserId,
                sourceUpdateIds: ids,
                ...(chooser ? { chooser } : {}),
              });
            } catch (error) {
              routingClockUnknown = true;
              throw error;
            }
            if (routingLifetime) routingSourceIds = ids;
            return routingLifetime ? { ...routingLifetime } : undefined;
          },
          acquireRouting: (select = false, sourceUpdateIds) => {
            execution.assertCurrent();
            if (select && routingClockUnknown)
              throw new TelegramUpdateAdmissionOutcomeError(
                "Telegram routing input clock publication is unconfirmed; selection is protected.",
              );
            if (select && routingLifetime && !routingSelectionConfirmed) {
              if (routingSelectionAttempted)
                throw new TelegramUpdateAdmissionOutcomeError(
                  "Telegram routing selection is unconfirmed; no replay is permitted.",
                );
              if (
                !isDeepStrictEqual(
                  sourceUpdateIds ?? [update.update_id],
                  routingSourceIds,
                )
              )
                throw new TelegramUpdateAdmissionOutcomeError(
                  "Telegram routing input selection changed its source membership.",
                );
              routingSelectionAttempted = true;
              routingSelectionConfirmed =
                deps.selectRoutingInput?.({
                  updateId: update.update_id,
                  signal,
                  operatorUserId: routingLifetime.operatorUserId,
                  sourceUpdateIds: routingSourceIds!,
                }) === true;
              if (!routingSelectionConfirmed)
                throw new TelegramUpdateAdmissionOutcomeError(
                  "Telegram routing input choice is expired or unavailable.",
                );
            }
            routingClaims += 1;
            let released = false;
            return () => {
              if (released) return;
              released = true;
              routingClaims -= 1;
            };
          },
        },
      ),
      execution,
    );
    try {
      execution.assertCurrent();
      if (capture) {
        capture(boundUpdate);
        reportTelegramUpdateDeferred(boundUpdate.message);
      } else await deps.defaultHandle(boundUpdate, ctx, execution);
      if (
        outcome?.kind !== "deferred" ||
        !outcome.routingReview ||
        signal.aborted
      )
        execution.assertCurrent();
    } finally {
      immediate = false;
    }
    return outcome ?? { kind: "complete" };
  };
}

export function createTelegramCustodiedUpdateAdmissionHandle<
  TUpdate extends TelegramJournaledUpdate & TelegramUpdateFlow,
  TContext,
>(
  deps: Omit<
    TelegramUpdateAdmissionHandleDeps<TUpdate, TContext>,
    | "onLateOutcome"
    | "onLateOutcomeError"
    | "abandonDeferred"
    | "armRoutingInput"
    | "getRoutingInput"
    | "selectRoutingInput"
    | "isRoutingInputCurrent"
    | "supportsDeferredAbandonment"
    | "inspectAbandoning"
    | "inspectHistorical"
    | "inspectDeferredSource"
    | "inspectDeferredSourceSnapshot"
    | "prepareDeferredLiveInput"
    | "prepareDeferredQueueAdmission"
    | "prepareDeferredSourceCompletion"
    | "isHistoricalSource"
  > & {
    journal: TelegramCustodyExecutionJournal;
    recipientBindingKey: string;
    onLateOutcomeError(error: unknown, updateId: number): void;
    onCustodiedLateSettlement?: (
      result: TelegramCustodiedExecutionResult,
      details: { updateId: number; signal: AbortSignal },
    ) => void;
  },
): (
  update: TUpdate,
  ctx: TContext,
  signal: AbortSignal,
) => Promise<TelegramCustodiedExecutionResult> {
  const session = createTelegramCustodiedExecutionSession({
    journal: deps.journal,
    recipientBindingKey: deps.recipientBindingKey,
  });
  const admission = createTelegramUpdateAdmissionHandle({
    defaultHandle: deps.defaultHandle,
    registry: deps.registry,
    getJournalBindingKey: () => deps.recipientBindingKey,
    async onLateOutcome(outcome, details) {
      const result = await session.settle(details.updateId, outcome);
      deps.onCustodiedLateSettlement?.(result, {
        updateId: details.updateId,
        signal: details.signal,
      });
    },
    onLateOutcomeError: deps.onLateOutcomeError,
  });
  return (update, ctx, signal) =>
    session.execute(update, (started) =>
      admission(started as TUpdate, ctx, signal),
    );
}

export interface TelegramQueueAdmissionItemLike {
  admissionReceipts?: readonly TelegramQueueAdmissionReceiptLike[];
}

// A dispatched prompt can remain in memory until agent_start. Remember only acknowledged
// removal of these exact receipt objects for later local discard, never for dispatch/replay.
const acknowledgedQueueReceiptCompletions = new WeakMap<
  TelegramQueueAdmissionReceiptLike,
  TelegramQueueAdmissionReceiptLike
>();
const isQueueReceiptCompletionAcknowledged = (
  receipt: TelegramQueueAdmissionReceiptLike,
): boolean => {
  const acknowledged = acknowledgedQueueReceiptCompletions.get(receipt);
  return (
    acknowledged !== undefined &&
    areTelegramQueueAdmissionReceiptsEqual(acknowledged, receipt)
  );
};

export interface TelegramQueueAdmissionSettlementRuntime<TContext> {
  isItemReady: (item: TelegramQueueAdmissionItemLike) => boolean;
  getQueueReceiptSettlementOwner?: (
    receipt: TelegramQueueAdmissionReceiptLike,
    ctx: TContext,
    reason: TelegramQueueReceiptCompletionReason,
  ) => TelegramUpdateJournalQueueOwner | undefined;
  getQueueReceiptOwner: (
    receipt: TelegramQueueAdmissionReceiptLike,
  ) => TelegramUpdateJournalQueueOwner | undefined;
  onPromptHandedOff: (
    item: TelegramQueueAdmissionItemLike,
    ctx: TContext,
  ) => boolean;
  onControlSettled: (
    item: TelegramQueueAdmissionItemLike,
    ctx: TContext,
  ) => boolean;
  onItemsDiscarded: (
    items: readonly TelegramQueueAdmissionItemLike[],
    ctx: TContext,
  ) => boolean;
}

export function createTelegramQueueAdmissionSettlementMuxRuntime<TContext>(
  runtimes: readonly TelegramQueueAdmissionSettlementRuntime<TContext>[],
): TelegramQueueAdmissionSettlementRuntime<TContext> {
  // Plan the whole request before mutation; unready is not an acknowledgement of completion.
  const complete = (
    items: readonly TelegramQueueAdmissionItemLike[],
    ctx: TContext,
    kind: "prompt" | "control" | "discard",
  ): boolean => {
    const plan = new Map<
      TelegramQueueAdmissionSettlementRuntime<TContext>,
      TelegramQueueAdmissionReceiptLike[]
    >();
    const reason =
      kind === "prompt"
        ? "prompt-handoff"
        : kind === "control"
          ? "control-settlement"
          : "discard";
    const settlementOwner = (
      runtime: TelegramQueueAdmissionSettlementRuntime<TContext>,
      receipt: TelegramQueueAdmissionReceiptLike,
    ) =>
      runtime.getQueueReceiptSettlementOwner
        ? runtime.getQueueReceiptSettlementOwner(receipt, ctx, reason)
        : runtime.isItemReady({ admissionReceipts: [receipt] })
          ? runtime.getQueueReceiptOwner(receipt)
          : undefined;
    for (const receipt of items.flatMap(
      (item) => item.admissionReceipts ?? [],
    )) {
      if (isQueueReceiptCompletionAcknowledged(receipt)) continue;
      const candidates = runtimes.filter((runtime) =>
        runtime.getQueueReceiptSettlementOwner
          ? !!settlementOwner(runtime, receipt)
          : runtime.isItemReady({ admissionReceipts: [receipt] }),
      );
      const selected = candidates[0];
      if (!selected) return false;
      if (candidates.length > 1) {
        const owner = settlementOwner(selected, receipt);
        if (
          !owner ||
          candidates.some((runtime) => {
            const candidate = settlementOwner(runtime, receipt);
            return (
              !candidate ||
              !areTelegramUpdateJournalQueueOwnersEqual(owner, candidate)
            );
          })
        )
          return false;
      }
      const receipts = plan.get(selected) ?? [];
      receipts.push(receipt);
      plan.set(selected, receipts);
    }
    for (const [runtime, receipts] of plan) {
      const item = { admissionReceipts: receipts };
      const completed =
        kind === "discard"
          ? runtime.onItemsDiscarded([item], ctx)
          : kind === "prompt"
            ? runtime.onPromptHandedOff(item, ctx)
            : runtime.onControlSettled(item, ctx);
      if (completed !== true) return false;
    }
    return true;
  };
  return {
    isItemReady: (item) =>
      (item.admissionReceipts ?? []).every((receipt) =>
        runtimes.some((runtime) =>
          runtime.isItemReady({ admissionReceipts: [receipt] }),
        ),
      ),
    getQueueReceiptOwner(receipt) {
      let owner: TelegramUpdateJournalQueueOwner | undefined;
      for (const runtime of runtimes) {
        const candidate = runtime.getQueueReceiptOwner(receipt);
        if (!candidate) continue;
        if (
          owner &&
          !areTelegramUpdateJournalQueueOwnersEqual(owner, candidate)
        ) {
          throw new TelegramUpdateAdmissionOutcomeError(
            `Telegram queue receipt ${receipt.receiptId} has multiple live owners.`,
          );
        }
        owner = candidate;
      }
      return owner ? { ...owner } : undefined;
    },
    onPromptHandedOff: (item, ctx) => complete([item], ctx, "prompt"),
    onControlSettled: (item, ctx) => complete([item], ctx, "control"),
    onItemsDiscarded: (items, ctx) => complete(items, ctx, "discard"),
  };
}

export function createTelegramQueueAdmissionSettlementRuntime<TContext>(
  worker: TelegramUpdateWorkerRuntime<TContext>,
): TelegramQueueAdmissionSettlementRuntime<TContext> {
  const complete = (
    items: readonly TelegramQueueAdmissionItemLike[],
    ctx: TContext,
    reason: TelegramQueueReceiptCompletionReason,
  ): boolean => {
    const receipts: TelegramQueueAdmissionReceiptLike[] = [];
    for (const item of items) {
      for (const receipt of item.admissionReceipts ?? []) {
        if (!isQueueReceiptCompletionAcknowledged(receipt))
          receipts.push(receipt);
      }
    }
    return (
      receipts.length === 0 ||
      worker.completeQueueReceipts({ receipts, ctx, reason })
    );
  };
  return {
    isItemReady: (item) =>
      (item.admissionReceipts ?? []).every(worker.isQueueReceiptCommitted),
    getQueueReceiptOwner: worker.getQueueReceiptOwner,
    ...(worker.getQueueReceiptSettlementOwner
      ? {
          getQueueReceiptSettlementOwner: worker.getQueueReceiptSettlementOwner,
        }
      : {}),
    onPromptHandedOff: (item, ctx) => complete([item], ctx, "prompt-handoff"),
    onControlSettled: (item, ctx) =>
      complete([item], ctx, "control-settlement"),
    onItemsDiscarded: (items, ctx) => complete(items, ctx, "discard"),
  };
}

export interface TelegramUpdateAdmissionLifecycleJournalBinding {
  runtimeKey: string;
  recoveryKey: string;
  recipientBindingKey?: string;
  journal: TelegramUpdateWorkerJournalPort & {
    inputCustody?: TelegramCustodyExecutionJournal;
    appendBatch: (
      updates: readonly TelegramJournaledUpdate[],
      acceptedThroughUpdateId?: number,
    ) => Pick<TelegramUpdateJournalAppendResult, "nonExcludedUpdateIds">;
    applyOperatorDisposition?: (
      input: TelegramUpdateJournalOperatorDispositionInput,
    ) => TelegramUpdateJournalOperatorDispositionResult;
    discardQueued?: (input: {
      queueKind: "prompt" | "control";
      receiptId: string;
      sourceUpdateIds: readonly number[];
      expectedOwner: TelegramUpdateJournalQueueOwner;
    }) => TelegramUpdateJournalQueueDiscardResult;
    offerQueuedHandoff?: (
      input: TelegramUpdateJournalQueueHandoffInput,
    ) => TelegramUpdateJournalQueueHandoffOfferResult;
    acceptQueuedHandoff?: (
      input: TelegramUpdateJournalQueueHandoffInput,
    ) => TelegramUpdateJournalQueueHandoffAcceptResult;
    cancelQueuedHandoff?: (
      input: TelegramUpdateJournalQueueHandoffInput,
    ) => TelegramUpdateJournalQueueHandoffCancelResult;
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
  showStatus: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
    threadId?: number,
  ) => Promise<void>;
  openModelMenu: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
    threadId?: number,
  ) => Promise<void>;
}

export function createTelegramQueueHandoffControlExecutionFactory<TContext>(
  deps: TelegramQueueHandoffControlExecutionDeps<TContext>,
): (
  payload: TelegramControlQueueHandoffPayload,
) => PendingTelegramControlItem<TContext>["execute"] {
  return (payload) => async (ctx) => {
    if (!deps.isContextCurrent(ctx)) return;
    if (payload.controlType === "status") {
      await deps.showStatus(
        payload.chatId,
        payload.replyToMessageId,
        ctx,
        payload.target?.threadId,
      );
      return;
    }
    await deps.openModelMenu(
      payload.chatId,
      payload.replyToMessageId,
      ctx,
      payload.target?.threadId,
    );
  };
}

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
  lifecycle: Pick<
    TelegramUpdateAdmissionLifecycleRuntime<TContext>,
    | "offerQueueReceiptHandoff"
    | "acceptQueueReceiptHandoff"
    | "cancelQueueReceiptHandoff"
  >;
  removeDonorItem: (receipt: TelegramQueueAdmissionReceipt) => boolean;
}

export type TelegramQueueHandoffCoordinatorResult =
  | {
      status: "transferred";
      receipt: TelegramQueueAdmissionReceipt;
      queueOwner: TelegramUpdateJournalQueueOwner;
    }
  | {
      status: "retained";
      receipt: TelegramQueueAdmissionReceipt;
      error: unknown;
      cancelled: boolean;
    };

function assertTelegramQueueHandoffStageMatches(
  stage: TelegramQueueHandoffStageResult,
  receipt: TelegramQueueAdmissionReceipt,
): void {
  if (
    stage.status !== "staged" ||
    stage.receiptId !== receipt.receiptId ||
    stage.sourceUpdateIds.length !== receipt.sourceUpdateIds.length ||
    stage.sourceUpdateIds.some(
      (updateId, index) => updateId !== receipt.sourceUpdateIds[index],
    )
  ) {
    throw new Error(
      "Telegram queue handoff staging returned a mismatched receipt.",
    );
  }
}

export async function coordinateTelegramQueueHandoff<TContext>(
  input: TelegramQueueHandoffCoordinatorInput<TContext>,
): Promise<TelegramQueueHandoffCoordinatorResult> {
  const handoff = createTelegramQueueHandoff({
    handoffToken: input.handoffToken,
    item: input.item,
    steerSupported: input.steerSupported,
  });
  const receipt = handoff.payload.admissionReceipts[0];
  if (!receipt || handoff.payload.admissionReceipts.length !== 1) {
    throw new Error(
      "Telegram queue handoff requires exactly one complete receipt.",
    );
  }
  const handoffInput: TelegramUpdateJournalQueueHandoffInput = {
    queueKind: receipt.queueKind,
    receiptId: receipt.receiptId,
    sourceUpdateIds: receipt.sourceUpdateIds,
    expectedOwner: input.expectedOwner,
    recipientOwner: input.recipientOwner,
    handoffToken: input.handoffToken,
  };
  input.lifecycle.offerQueueReceiptHandoff(handoffInput);
  let stage: TelegramQueueHandoffStageResult;
  try {
    stage = await input.stageRemote({
      handoffToken: input.handoffToken,
      expectedOwner: input.expectedOwner,
      recipientOwner: input.recipientOwner,
      payload: handoff.payload,
    });
    assertTelegramQueueHandoffStageMatches(stage, receipt);
  } catch (error) {
    let cancelled = false;
    try {
      input.lifecycle.cancelQueueReceiptHandoff(handoffInput);
      cancelled = true;
    } catch {
      return {
        status: "retained",
        receipt: { ...receipt, sourceUpdateIds: [...receipt.sourceUpdateIds] },
        error,
        cancelled: false,
      };
    }
    return {
      status: "retained",
      receipt: { ...receipt, sourceUpdateIds: [...receipt.sourceUpdateIds] },
      error,
      cancelled,
    };
  }
  let donorRemoved = false;
  try {
    donorRemoved = input.removeDonorItem(receipt);
  } catch (error) {
    throw new Error(
      `Telegram queue handoff donor removal failed after acceptance: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!donorRemoved) {
    throw new Error(
      `Telegram queue handoff donor item ${receipt.receiptId} disappeared after acceptance.`,
    );
  }
  return {
    status: "transferred",
    receipt: { ...receipt, sourceUpdateIds: [...receipt.sourceUpdateIds] },
    queueOwner: { ...stage.queueOwner },
  };
}

export interface TelegramQueueHandoffReconciliationBinding<TContext> {
  request: (ctx: TContext) => void;
  set: (reconcile: (ctx: TContext) => Promise<void>) => void;
}

export function createTelegramQueueHandoffReconciliationBinding<TContext>(
  recordFailure?: (error: unknown) => void,
): TelegramQueueHandoffReconciliationBinding<TContext> {
  let reconcile: ((ctx: TContext) => Promise<void>) | undefined;
  return {
    request(ctx) {
      void reconcile?.(ctx).catch((error) => recordFailure?.(error));
    },
    set(next) {
      reconcile = next;
    },
  };
}

export interface TelegramQueueHandoffRecipientRuntimeDeps<TContext> {
  staging: TelegramQueueHandoffStagingRuntime;
  getRecipientOwner: () => TelegramUpdateJournalQueueOwnerIdentity;
  getLifecycleForBinding: (
    journalBindingKey: string,
  ) => TelegramUpdateAdmissionLifecycleRuntime<TContext> | undefined;
  isTransportStampActive?: (
    stamp: TelegramQueueHandoffPayload["transportStamp"],
  ) => boolean;
  dispatchNext: (ctx: TContext) => void;
}

export function createTelegramQueueHandoffRecipientRuntime<TContext>(
  deps: TelegramQueueHandoffRecipientRuntimeDeps<TContext>,
): (
  envelope: Extract<TelegramBusEnvelope, { kind: "leader.offerQueueHandoff" }>,
  ctx: TContext,
) => Promise<TelegramQueueHandoffStageResult> {
  return async (envelope, ctx) => {
    const stage = deps.staging.stage(envelope.payload);
    const receipt = envelope.payload.admissionReceipts[0];
    if (!receipt || envelope.payload.admissionReceipts.length !== 1) {
      deps.staging.cancel(
        receipt ?? {
          queueKind: envelope.payload.kind,
          receiptId: stage.receiptId,
          sourceUpdateIds: stage.sourceUpdateIds,
        },
      );
      throw new Error(
        "Telegram queue handoff requires exactly one complete receipt.",
      );
    }
    const journalBindingKey = receipt.journalBindingKey;
    if (!journalBindingKey) {
      deps.staging.cancel(receipt);
      throw new Error(
        "Telegram queue handoff receipt omitted its journal binding.",
      );
    }
    if (
      deps.isTransportStampActive &&
      !deps.isTransportStampActive(envelope.payload.transportStamp)
    ) {
      deps.staging.cancel(receipt);
      throw new Error(
        "Telegram queue handoff payload belongs to an inactive transport generation.",
      );
    }
    const lifecycle = deps.getLifecycleForBinding(journalBindingKey);
    if (!lifecycle) {
      deps.staging.cancel(receipt);
      throw new Error("Telegram queue handoff journal binding is not active.");
    }
    const donorOwner: TelegramUpdateJournalQueueOwner = {
      instanceId: envelope.donorInstanceId,
      processId: envelope.donorProcessId,
      processBirthId: envelope.donorProcessBirthId,
      sessionGeneration: envelope.donorSessionGeneration,
      acquisitionId: envelope.donorAcquisitionId,
      acquiredAtMs: envelope.donorAcquiredAtMs,
    };
    let accepted: TelegramUpdateJournalQueueHandoffAcceptResult;
    try {
      accepted = lifecycle.acceptQueueReceiptHandoff({
        queueKind: receipt.queueKind,
        receiptId: receipt.receiptId,
        sourceUpdateIds: receipt.sourceUpdateIds,
        expectedOwner: donorOwner,
        recipientOwner: deps.getRecipientOwner(),
        handoffToken: envelope.handoffToken,
      });
      await lifecycle.publishAcceptedQueueReceipt({
        receipt,
        queueOwner: accepted.queueOwner,
        ctx,
      });
      if (!deps.staging.accept(receipt)) {
        throw new Error(
          "Telegram queue handoff payload disappeared before readiness publication.",
        );
      }
    } catch (error) {
      deps.staging.cancel(receipt);
      throw error;
    }
    deps.dispatchNext(ctx);
    return { ...stage, queueOwner: { ...accepted.queueOwner } };
  };
}

export interface TelegramQueueHandoffReconcilerDeps<TContext> {
  canHandoffSteerWithRecipient?: (recipient: TelegramBusFollowerView) => boolean;
  hasPendingDispatch?: () => boolean;
  ownsDirect: () => boolean;
  isFollowerRegistered: () => boolean;
  isBusEnabled: () => boolean;
  canHandoffWithLeader?: () => boolean;
  listFollowers: () => readonly TelegramBusFollowerView[];
  createRecipientJournalBindingKey: (
    recipient: TelegramBusFollowerView,
  ) => string | undefined;
  getQueuedItems: () => readonly TelegramQueueItem<TContext>[];
  getReceiptOwner: (
    receipt: TelegramQueueAdmissionReceipt,
  ) => TelegramUpdateJournalQueueOwner | undefined;
  getLifecycleForReceipt: (
    receipt: TelegramQueueAdmissionReceipt,
  ) => TelegramUpdateAdmissionLifecycleRuntime<TContext> | undefined;
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
  routeThroughLeader: (
    input: TelegramBusLeaderQueueHandoffOffer,
  ) => Promise<TelegramBusEnvelope>;
  removeDonorItem: (
    receipt: TelegramQueueAdmissionReceipt,
    ctx: TContext,
  ) => boolean;
  recordFailure?: (error: unknown, details: Record<string, unknown>) => void;
}

export interface TelegramQueueHandoffReconciliationRuntimeAssemblyDeps<
  TContext,
> {
  canHandoffSteerWithRecipient?: (recipient: TelegramBusFollowerView) => boolean;
  hasPendingDispatch?: () => boolean;
  ownsDirect: () => boolean;
  isFollowerRegistered: () => boolean;
  isBusEnabled: () => boolean;
  canHandoffWithLeader?: () => boolean;
  listFollowers: () => readonly TelegramBusFollowerView[];
  createRecipientJournalResolver: (
    profileKey: string,
    sessionId: string,
  ) => () => { recoveryKey: string } | undefined;
  queueStore: {
    getQueuedItems: () => TelegramQueueItem<TContext>[];
    setQueuedItems: (items: TelegramQueueItem<TContext>[]) => void;
  };
  admission: Pick<
    TelegramUpdateAdmissionRuntimeBinding<TContext>,
    "getSettlement" | "getLifecycleForJournalBinding"
  >;
  createHandoffToken: () => string;
  createRequestId: () => string;
  donorInstanceId: string;
  authSecret?: string;
  stageThroughFollower: (
    input: TelegramBusFollowerQueueHandoffOffer,
  ) => Promise<TelegramQueueHandoffStageResult>;
  routeThroughLeader: TelegramQueueHandoffReconcilerDeps<TContext>["routeThroughLeader"];
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

/** Own queue-handoff projections over journals, admission, IPC, and live queue state. */
export function createTelegramQueueHandoffReconciliationRuntimeAssembly<
  TContext,
>(
  deps: TelegramQueueHandoffReconciliationRuntimeAssemblyDeps<TContext>,
): (ctx: TContext) => Promise<void> {
  return createTelegramQueueHandoffReconciler({
    canHandoffSteerWithRecipient: deps.canHandoffSteerWithRecipient,
    hasPendingDispatch: deps.hasPendingDispatch,
    ownsDirect: deps.ownsDirect,
    isFollowerRegistered: deps.isFollowerRegistered,
    isBusEnabled: deps.isBusEnabled,
    canHandoffWithLeader: deps.canHandoffWithLeader,
    listFollowers: deps.listFollowers,
    createRecipientJournalBindingKey(recipient) {
      if (!recipient.profileKey || !recipient.sessionId) return undefined;
      return deps.createRecipientJournalResolver(
        recipient.profileKey,
        recipient.sessionId,
      )()?.recoveryKey;
    },
    getQueuedItems: deps.queueStore.getQueuedItems,
    getReceiptOwner(receipt) {
      return deps.admission.getSettlement()?.getQueueReceiptOwner(receipt);
    },
    getLifecycleForReceipt(receipt) {
      const bindingKey = receipt.journalBindingKey;
      return bindingKey
        ? deps.admission.getLifecycleForJournalBinding(bindingKey)
        : undefined;
    },
    createHandoffToken: deps.createHandoffToken,
    createRequestId: deps.createRequestId,
    donorInstanceId: deps.donorInstanceId,
    authSecret: deps.authSecret,
    stageThroughFollower(input) {
      const registrationGeneration = input.recipient.registrationGeneration;
      if (!registrationGeneration) {
        throw new Error(
          "Telegram queue handoff recipient registration generation is unavailable.",
        );
      }
      return deps.stageThroughFollower({
        recipientInstanceId: input.recipient.instanceId,
        recipientRegistrationGeneration: registrationGeneration,
        donorProcessId: input.expectedOwner.processId,
        donorProcessBirthId: input.expectedOwner.processBirthId,
        donorSessionGeneration: input.expectedOwner.sessionGeneration,
        donorAcquisitionId: input.expectedOwner.acquisitionId,
        donorAcquiredAtMs: input.expectedOwner.acquiredAtMs,
        handoffToken: input.handoffToken,
        payload: input.payload,
      });
    },
    routeThroughLeader: deps.routeThroughLeader,
    removeDonorItem(receipt) {
      return removeTelegramQueueItemByReceipt({
        receipt,
        store: deps.queueStore,
      });
    },
    recordFailure(error, details) {
      deps.recordRuntimeEvent?.("inbound-worker", error, details);
    },
  });
}

export function createTelegramQueueHandoffReconciler<TContext>(
  deps: TelegramQueueHandoffReconcilerDeps<TContext>,
): (ctx: TContext) => Promise<void> {
  let operation: Promise<void> | undefined;
  const reconcile = async (ctx: TContext): Promise<void> => {
    const followerRegistered = deps.isFollowerRegistered();
    if (
      (!deps.ownsDirect() && !followerRegistered) ||
      !deps.isBusEnabled() ||
      (followerRegistered && deps.canHandoffWithLeader?.() === false)
    ) {
      return;
    }
    const followers = deps
      .listFollowers()
      .filter((follower) => follower.instanceId !== deps.donorInstanceId);
    if (followers.length === 0) return;
    for (const item of [...deps.getQueuedItems()]) {
      if ((deps.hasPendingDispatch?.() && deps.getQueuedItems()[0] === item) ||
          (item.kind === "prompt" && (item.steerAttempted || item.steerPacketTail !== undefined || item.steerPacketSourceOrders !== undefined))) continue;
      const target = item.target;
      const recipient = target
        ? followers.find(
            (candidate) =>
              candidate.target?.chatId === target.chatId &&
              candidate.target?.threadId === target.threadId,
          )
        : undefined;
      if (!recipient) continue;
      const steerSupported = item.queueLane === "steer" && deps.canHandoffSteerWithRecipient?.(recipient) === true;
      if (item.queueLane === "steer" && !steerSupported) continue;
      const receipt = item.admissionReceipts?.[0];
      if (!receipt || item.admissionReceipts?.length !== 1) continue;
      if (
        !receipt.journalBindingKey ||
        !getTelegramUpdateJournalBindingPath(receipt.journalBindingKey)
      ) {
        continue;
      }
      const recipientJournalBindingKey =
        deps.createRecipientJournalBindingKey(recipient);
      if (!recipientJournalBindingKey) continue;
      const expectedOwner = deps.getReceiptOwner(receipt);
      const lifecycle = deps.getLifecycleForReceipt(receipt);
      if (
        !expectedOwner ||
        !lifecycle ||
        !recipient.registrationGeneration ||
        !recipient.pid ||
        !recipient.processBirthId ||
        !recipient.sessionGeneration
      ) {
        continue;
      }
      const handoffToken = deps.createHandoffToken();
      const result = await coordinateTelegramQueueHandoff({
        item,
        steerSupported,
        expectedOwner,
        recipientOwner: {
          instanceId: recipient.instanceId,
          processId: recipient.pid,
          processBirthId: recipient.processBirthId,
          sessionGeneration: recipient.sessionGeneration,
        },
        handoffToken,
        lifecycle,
        stageRemote: async ({ payload: sourcePayload }) => {
          if (sourcePayload.queueLane === "steer" && deps.canHandoffSteerWithRecipient?.(recipient) !== true) {
            throw new Error("Steer queue handoff capability changed before staging.");
          }
          const payload = {
            ...sourcePayload,
            admissionReceipts: [
              {
                ...sourcePayload.admissionReceipts[0]!,
                journalBindingKey: recipientJournalBindingKey,
              },
            ],
          };
          if (followerRegistered) {
            return deps.stageThroughFollower({
              recipient,
              expectedOwner,
              handoffToken,
              payload,
            });
          }
          const response = await deps.routeThroughLeader({
            requestId: deps.createRequestId(),
            auth: deps.authSecret,
            recipientInstanceId: recipient.instanceId,
            recipientRegistrationGeneration: recipient.registrationGeneration!,
            donorInstanceId: deps.donorInstanceId,
            donorProcessId: expectedOwner.processId,
            donorProcessBirthId: expectedOwner.processBirthId,
            donorSessionGeneration: expectedOwner.sessionGeneration,
            donorAcquisitionId: expectedOwner.acquisitionId,
            donorAcquiredAtMs: expectedOwner.acquiredAtMs,
            handoffToken,
            payload,
            sentAtMs: Date.now(),
          });
          const queueOwner =
            response.kind === "bus.ack" &&
            response.result &&
            typeof response.result === "object"
              ? parseTelegramUpdateJournalQueueOwner(
                  (response.result as Record<string, unknown>).queueOwner,
                )
              : undefined;
          if (
            response.kind !== "bus.ack" ||
            !response.ok ||
            !response.result ||
            typeof response.result !== "object" ||
            !queueOwner
          ) {
            throw new Error(
              response.kind === "bus.ack"
                ? (response.message ?? "Telegram queue handoff was rejected.")
                : "Telegram queue handoff returned no acknowledgement.",
            );
          }
          return {
            ...(response.result as Omit<
              TelegramQueueHandoffStageResult,
              "queueOwner"
            >),
            queueOwner,
          };
        },
        removeDonorItem: (exactReceipt) =>
          deps.removeDonorItem(exactReceipt, ctx),
      });
      if (result.status === "retained") {
        deps.recordFailure?.(result.error, {
          phase: "queue-handoff-retained",
          receiptId: result.receipt.receiptId,
          recipientInstanceId: recipient.instanceId,
          cancelled: result.cancelled,
        });
      }
    }
  };
  return (ctx) => {
    if (operation) return operation;
    const current = reconcile(ctx).finally(() => {
      if (operation === current) operation = undefined;
    });
    operation = current;
    return current;
  };
}

export interface TelegramQueueMutationDependencyItem {
  chatId: number;
  target?: { chatId: number };
  replyToMessageId: number;
  sourceMessageIds?: readonly number[];
}

export interface TelegramUpdateAdmissionLifecycleRuntimeDeps<TContext> {
  resolveBinding: () =>
    TelegramUpdateAdmissionLifecycleJournalBinding | undefined;
  getQueueOwnerIdentity?: (
    ctx: TContext,
  ) => TelegramUpdateJournalQueueOwnerIdentity;
  createWorker: (
    journal: TelegramUpdateWorkerJournalPort,
    binding: TelegramUpdateAdmissionLifecycleJournalBinding,
  ) => TelegramUpdateWorkerRuntime<TContext>;
  acquireSourceReference?: (
    binding: TelegramUpdateAdmissionLifecycleJournalBinding,
  ) => () => void;
  /** Runs after the previous worker stopped and before the replacement worker exists; throwing refuses binding. */
  prepareBinding?: (
    binding: TelegramUpdateAdmissionLifecycleJournalBinding,
  ) => void;
  recordRuntimeEvent?: TelegramUpdateWorkerRuntimeDeps<TContext>["recordRuntimeEvent"];
}

export interface TelegramUpdateAdmissionLifecycleRuntime<
  TContext,
> extends TelegramQueueAdmissionSettlementRuntime<TContext> {
  onSessionStart: (ctx: TContext) => Promise<void>;
  onSessionShutdown: () => Promise<void>;
  onTransportChanged: (ctx?: TContext) => Promise<void>;
  appendBatch: (
    updates: readonly TelegramJournaledUpdate[],
    acceptedThroughUpdateId?: number,
  ) => Pick<TelegramUpdateJournalAppendResult, "nonExcludedUpdateIds">;
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
  offerQueueReceiptHandoff: (
    input: TelegramUpdateJournalQueueHandoffInput,
  ) => TelegramUpdateJournalQueueHandoffOfferResult;
  acceptQueueReceiptHandoff: (
    input: TelegramUpdateJournalQueueHandoffInput,
  ) => TelegramUpdateJournalQueueHandoffAcceptResult;
  cancelQueueReceiptHandoff: (
    input: TelegramUpdateJournalQueueHandoffInput,
  ) => TelegramUpdateJournalQueueHandoffCancelResult;
  publishAcceptedQueueReceipt: (input: {
    receipt: TelegramQueueAdmissionReceiptLike;
    queueOwner: TelegramUpdateJournalQueueOwner;
    ctx: TContext;
  }) => Promise<void>;
  getQueueReceiptOwner: (
    receipt: TelegramQueueAdmissionReceiptLike,
  ) => TelegramUpdateJournalQueueOwner | undefined;
  getJournalBindingKey: () => string | undefined;
  getJournalPath: () => string | undefined;
  ownsJournalBinding: (journalBindingKey: string) => boolean;
  getJournalEntryCount: () => number;
  getForeignQueueOwnerLiveness: () => TelegramProcessLiveness | undefined;
  hasPendingQueueMutationForItem: (
    item: TelegramQueueMutationDependencyItem,
  ) => boolean;
  signal: () => void;
  /** Fresh recipient input only; the leader's existing deferred original keeps its original carrier. */
  prepareLiveInput?: TelegramUpdateWorkerRuntime<TContext>["prepareLiveInput"];
  getState: () => TelegramUpdateWorkerStateSnapshot | undefined;
}

export interface TelegramUpdateWorkerOwnerRuntime<TContext> {
  getQueueOwnerIdentity: () => TelegramUpdateJournalQueueOwnerIdentity;
  onQueueReceiptCommitted: (
    receipt: TelegramQueueAdmissionReceiptLike,
    ctx: TContext,
  ) => void;
  onUpdateCompleted: (
    updateId: number,
    ctx: TContext,
    journalBindingKey?: string,
  ) => void;
}

export interface TelegramUpdateWorkerOwnerRuntimeDeps<TContext> {
  instanceId: string;
  processId: number;
  processBirthId: string;
  getSessionGeneration: () => number;
  isContextCurrent: (ctx: TContext) => boolean;
  dispatchNext: (ctx: TContext) => void;
  requestQueueHandoffReconciliation: (ctx: TContext) => void;
  afterQueueReceiptCommitted?: (
    receipt: TelegramQueueAdmissionReceiptLike,
    ctx: TContext,
  ) => void;
  afterUpdateCompleted?: (
    updateId: number,
    ctx: TContext,
    journalBindingKey?: string,
  ) => void;
}

export function createTelegramUpdateWorkerOwnerRuntime<TContext>(
  deps: TelegramUpdateWorkerOwnerRuntimeDeps<TContext>,
): TelegramUpdateWorkerOwnerRuntime<TContext> {
  return {
    getQueueOwnerIdentity() {
      return {
        instanceId: deps.instanceId,
        processId: deps.processId,
        processBirthId: deps.processBirthId,
        sessionGeneration: deps.getSessionGeneration(),
      };
    },
    onQueueReceiptCommitted(receipt, ctx) {
      if (!deps.isContextCurrent(ctx)) return;
      deps.afterQueueReceiptCommitted?.(receipt, ctx);
      deps.dispatchNext(ctx);
      deps.requestQueueHandoffReconciliation(ctx);
    },
    onUpdateCompleted(updateId, ctx, journalBindingKey) {
      if (!deps.isContextCurrent(ctx)) return;
      deps.dispatchNext(ctx);
      deps.afterUpdateCompleted?.(updateId, ctx, journalBindingKey);
    },
  };
}

export interface TelegramUpdateAdmissionRuntimeBinding<TContext> {
  bind: (input: {
    leader: TelegramUpdateAdmissionLifecycleRuntime<TContext>;
    follower: TelegramUpdateAdmissionLifecycleRuntime<TContext>;
    inputCustodyBus?: TelegramInputCustodyBusBindingRuntime<TContext>;
  }) => void;
  getLeader: () =>
    TelegramUpdateAdmissionLifecycleRuntime<TContext> | undefined;
  getFollower: () =>
    TelegramUpdateAdmissionLifecycleRuntime<TContext> | undefined;
  getActive: () =>
    TelegramUpdateAdmissionLifecycleRuntime<TContext> | undefined;
  getSettlement: () =>
    TelegramQueueAdmissionSettlementRuntime<TContext> | undefined;
  getInputCustodyBus: () =>
    TelegramInputCustodyBusBindingRuntime<TContext> | undefined;
  getLifecycleForJournalBinding: (
    journalBindingKey: string,
  ) => TelegramUpdateAdmissionLifecycleRuntime<TContext> | undefined;
  hasPendingQueueMutationForItem: (
    item: TelegramQueueMutationDependencyItem,
  ) => boolean;
  onSessionShutdown: () => Promise<void>;
}

export function createTelegramUpdateAdmissionRuntimeBinding<TContext>(deps: {
  isFollowerRegistered: () => boolean;
}): TelegramUpdateAdmissionRuntimeBinding<TContext> {
  let leader: TelegramUpdateAdmissionLifecycleRuntime<TContext> | undefined;
  let follower: TelegramUpdateAdmissionLifecycleRuntime<TContext> | undefined;
  let settlement: TelegramQueueAdmissionSettlementRuntime<TContext> | undefined;
  let inputCustodyBus:
    TelegramInputCustodyBusBindingRuntime<TContext> | undefined;
  const getActive = () => (deps.isFollowerRegistered() ? follower : leader);
  return {
    bind(input) {
      leader = input.leader;
      follower = input.follower;
      settlement = createTelegramQueueAdmissionSettlementMuxRuntime([
        leader,
        follower,
      ]);
      inputCustodyBus = input.inputCustodyBus;
    },
    getLeader: () => leader,
    getFollower: () => follower,
    getActive,
    getSettlement: () => settlement,
    getInputCustodyBus: () => inputCustodyBus,
    getLifecycleForJournalBinding(journalBindingKey) {
      if (follower?.ownsJournalBinding(journalBindingKey)) return follower;
      return leader?.ownsJournalBinding(journalBindingKey) ? leader : undefined;
    },
    hasPendingQueueMutationForItem(item) {
      return Boolean(
        leader?.hasPendingQueueMutationForItem(item) ||
        follower?.hasPendingQueueMutationForItem(item),
      );
    },
    async onSessionShutdown() {
      await Promise.all([
        leader?.onSessionShutdown(),
        follower?.onSessionShutdown(),
      ]);
    },
  };
}

function isTelegramReactionDependencyForQueueItem(
  update: TelegramJournaledUpdate,
  item: TelegramQueueMutationDependencyItem,
): boolean {
  const reaction = update.message_reaction;
  if (!isTelegramUpdateAdmissionRecord(reaction)) return false;
  const chat = reaction.chat;
  if (
    !isTelegramUpdateAdmissionRecord(chat) ||
    !Number.isSafeInteger(chat.id) ||
    !Number.isSafeInteger(reaction.message_id)
  ) {
    return false;
  }
  const itemMessageIds = new Set([
    item.replyToMessageId,
    ...(item.sourceMessageIds ?? []),
  ]);
  return (
    chat.id === (item.target?.chatId ?? item.chatId) &&
    itemMessageIds.has(reaction.message_id as number)
  );
}

/** Own one worker per active transport identity without assuming queued-owner death. */
export function createTelegramUpdateAdmissionLifecycleRuntime<TContext>(
  deps: TelegramUpdateAdmissionLifecycleRuntimeDeps<TContext>,
): TelegramUpdateAdmissionLifecycleRuntime<TContext> {
  let activeRuntimeKey: string | undefined;
  let journal:
    TelegramUpdateAdmissionLifecycleJournalBinding["journal"] | undefined;
  let worker: TelegramUpdateWorkerRuntime<TContext> | undefined;
  let workerInputCustody: TelegramCustodyExecutionJournal | undefined;
  let settlement: TelegramQueueAdmissionSettlementRuntime<TContext> | undefined;
  let journalBindingKey: string | undefined;
  let operation: Promise<void> = Promise.resolve();
  let foreignQueueOwnerLiveness: TelegramProcessLiveness | undefined;
  let releaseSourceReference: (() => void) | undefined;
  let sourceReferenceBinding:
    TelegramUpdateAdmissionLifecycleJournalBinding | undefined;
  let activeContext: TContext | undefined;

  const withRetainedSourceReference = <T>(
    operation: (
      source: TelegramUpdateAdmissionLifecycleJournalBinding["journal"],
    ) => T,
  ): T => {
    if (!journal || !worker)
      throw new Error("Telegram update admission worker is not active.");
    // Synchronous retained-source access needs a reference, not renewed execution authority.
    const release =
      !releaseSourceReference && sourceReferenceBinding
        ? deps.acquireSourceReference?.(sourceReferenceBinding)
        : undefined;
    try {
      return operation(journal);
    } finally {
      release?.();
    }
  };
  const readObservedJournal = (): TelegramUpdateWorkerJournalSnapshot =>
    withRetainedSourceReference((source) => source.read());

  const stopCurrent = async (forget: boolean): Promise<void> => {
    activeContext = undefined;
    await worker?.stop();
    const release = releaseSourceReference;
    releaseSourceReference = undefined;
    try {
      release?.();
    } catch (error) {
      deps.recordRuntimeEvent?.("inbound-worker", error, {
        phase: "source-reference-release",
      });
    }
    if (!forget) return;
    sourceReferenceBinding = undefined;
    journal = undefined;
    worker = undefined;
    workerInputCustody = undefined;
    settlement = undefined;
    journalBindingKey = undefined;
    activeRuntimeKey = undefined;
    foreignQueueOwnerLiveness = undefined;
  };
  const bind = async (ctx: TContext, replace = false): Promise<void> => {
    let binding = deps.resolveBinding();
    if (!binding) {
      await stopCurrent(true);
      return;
    }
    if (
      replace ||
      !worker ||
      activeRuntimeKey !== binding.runtimeKey ||
      workerInputCustody !== binding.journal.inputCustody
    ) {
      const { runtimeKey, recoveryKey } = binding;
      await stopCurrent(true);
      binding = deps.resolveBinding();
      if (
        !binding ||
        binding.runtimeKey !== runtimeKey ||
        binding.recoveryKey !== recoveryKey
      ) {
        throw new Error(
          "Telegram update source binding changed during startup.",
        );
      }
      deps.prepareBinding?.(binding);
      const release = deps.acquireSourceReference?.(binding);
      const inputCustody = binding.journal.inputCustody;
      try {
        journal = binding.journal;
        worker = deps.createWorker(binding.journal, binding);
        workerInputCustody = inputCustody;
        settlement = createTelegramQueueAdmissionSettlementRuntime(worker);
        sourceReferenceBinding = { ...binding, journal };
        releaseSourceReference = release;
      } catch (error) {
        release?.();
        throw error;
      }
      journalBindingKey = binding.recoveryKey;
      activeRuntimeKey = binding.runtimeKey;
    }
    if (!releaseSourceReference && deps.acquireSourceReference)
      releaseSourceReference = deps.acquireSourceReference(binding);
    if (binding.journal.applyOperatorDisposition) {
      for (const entry of binding.journal.read().entries) {
        if (entry.state !== "failed" || !entry.terminalFailureId) continue;
        const result = binding.journal.applyOperatorDisposition({
          action: "retry",
          updateId: entry.updateId,
          failureId: entry.terminalFailureId,
        });
        if (result.duplicate) continue;
        try {
          deps.recordRuntimeEvent?.(
            "inbound-worker",
            "Resumed legacy terminal update under automatic retry policy.",
            {
              phase: "automatic-terminal-retry",
              updateId: entry.updateId,
              attemptCount: result.disposition.attemptCount,
            },
          );
        } catch {
          // Diagnostics cannot revoke the committed retry.
        }
      }
    }
    if (deps.getQueueOwnerIdentity && binding.journal.recoverDeadQueueOwner) {
      const recoveryOwner = deps.getQueueOwnerIdentity(ctx);
      const foreignReceipts = new Map<
        string,
        {
          queueKind: "prompt" | "control";
          sourceUpdateIds: number[];
          deadOwner: TelegramUpdateJournalQueueOwner;
        }
      >();
      for (const entry of binding.journal.read().entries) {
        if (
          entry.state !== "queued" ||
          !entry.queueKind ||
          !entry.queueReceiptId ||
          !entry.queueOwner ||
          entry.queueHandoff ||
          isTelegramUpdateJournalQueueOwnerProcess(
            entry.queueOwner,
            recoveryOwner,
          )
        ) {
          continue;
        }
        const receipt = foreignReceipts.get(entry.queueReceiptId);
        if (receipt) receipt.sourceUpdateIds.push(entry.updateId);
        else {
          foreignReceipts.set(entry.queueReceiptId, {
            queueKind: entry.queueKind,
            sourceUpdateIds: [entry.updateId],
            deadOwner: { ...entry.queueOwner },
          });
        }
      }
      for (const [receiptId, receipt] of foreignReceipts) {
        const result = binding.journal.recoverDeadQueueOwner({
          queueKind: receipt.queueKind,
          receiptId,
          sourceUpdateIds: receipt.sourceUpdateIds,
          deadOwner: receipt.deadOwner,
          recoveryOwner,
        });
        foreignQueueOwnerLiveness =
          result.status === "recovered"
            ? "dead"
            : result.status === "owner-alive"
              ? "alive"
              : "unverifiable";
        if (result.status !== "recovered") continue;
        try {
          deps.recordRuntimeEvent?.(
            "inbound-worker",
            "Discarded session-owned queue authority from a confirmed-dead process.",
            {
              phase: "dead-queue-owner-cleanup",
              receiptId,
              removedUpdateCount: result.recoveredUpdateIds.length,
            },
          );
        } catch {
          // Diagnostics cannot revoke the committed recovery.
        }
      }
    }
    worker.start(ctx);
    activeContext = ctx;
  };
  const runExclusive = (task: () => Promise<void>): Promise<void> => {
    const next = operation.then(task, task);
    operation = next.catch(() => undefined);
    return next;
  };
  return {
    onSessionStart: (ctx) => runExclusive(() => bind(ctx)),
    onSessionShutdown: () => runExclusive(() => stopCurrent(false)),
    onTransportChanged: (ctx) =>
      runExclusive(async () => {
        if (ctx !== undefined) await bind(ctx, true);
        else await stopCurrent(true);
      }),
    appendBatch(updates, acceptedThroughUpdateId) {
      if (!journal || !worker) {
        throw new Error("Telegram update admission worker is not active.");
      }
      return journal.appendBatch(updates, acceptedThroughUpdateId);
    },
    discardQueueReceipt(input) {
      if (!journal || !worker || !journal.discardQueued) {
        throw new Error(
          "Telegram update journal queue discard is not available.",
        );
      }
      const result = journal.discardQueued(input);
      worker.signal();
      return result;
    },
    recoverDeadQueueReceipt(input) {
      if (!journal || !worker || !journal.recoverDeadQueueOwner) {
        throw new Error(
          "Telegram update journal dead-owner recovery is not available.",
        );
      }
      const result = journal.recoverDeadQueueOwner(input);
      worker.signal();
      return result;
    },
    offerQueueReceiptHandoff(input) {
      if (!journal || !worker || !journal.offerQueuedHandoff) {
        throw new Error(
          "Telegram update journal queue handoff offer is not available.",
        );
      }
      const result = journal.offerQueuedHandoff(input);
      worker.signal();
      return result;
    },
    acceptQueueReceiptHandoff(input) {
      if (!journal || !worker || !journal.acceptQueuedHandoff) {
        throw new Error(
          "Telegram update journal queue handoff acceptance is not available.",
        );
      }
      const result = journal.acceptQueuedHandoff(input);
      worker.signal();
      return result;
    },
    cancelQueueReceiptHandoff(input) {
      if (!journal || !worker || !journal.cancelQueuedHandoff) {
        throw new Error(
          "Telegram update journal queue handoff cancellation is not available.",
        );
      }
      const result = withRetainedSourceReference((source) =>
        source.cancelQueuedHandoff!(input),
      );
      worker.signal();
      return result;
    },
    async publishAcceptedQueueReceipt(input) {
      if (!worker || !journal) {
        throw new Error("Telegram update admission worker is not active.");
      }
      const entry = journal
        .read()
        .entries.find(
          (candidate) =>
            candidate.state === "queued" &&
            candidate.queueReceiptId === input.receipt.receiptId &&
            candidate.queueOwner?.acquisitionId ===
              input.queueOwner.acquisitionId,
        );
      if (!entry) {
        throw new Error(
          `Telegram queue handoff receipt ${input.receipt.receiptId} is not owned by this journal.`,
        );
      }
      worker.signal();
      await worker.waitForDrain();
      const currentOwner = worker.getQueueReceiptOwner(input.receipt);
      if (
        !currentOwner ||
        !areTelegramUpdateJournalQueueOwnersEqual(
          currentOwner,
          input.queueOwner,
        )
      ) {
        throw new Error(
          `Telegram queue handoff receipt ${input.receipt.receiptId} is not owned by this runtime.`,
        );
      }
    },
    getQueueReceiptOwner(receipt) {
      if (
        !journalBindingKey ||
        receipt.journalBindingKey !== journalBindingKey
      ) {
        return undefined;
      }
      return worker?.getQueueReceiptOwner(receipt);
    },
    getJournalBindingKey: () => journalBindingKey,
    getJournalPath: () =>
      journalBindingKey
        ? getTelegramUpdateJournalBindingPath(journalBindingKey)
        : undefined,
    ownsJournalBinding: (candidate) =>
      journalBindingKey !== undefined && journalBindingKey === candidate,
    getForeignQueueOwnerLiveness: () => foreignQueueOwnerLiveness,
    getJournalEntryCount: () => readObservedJournal().entries.length,
    hasPendingQueueMutationForItem(item) {
      return Boolean(
        journal &&
        worker &&
        readObservedJournal().entries.some(
          (entry) =>
            entry.state !== "queued" &&
            entry.preApprovalExcluded !== true &&
            isTelegramReactionDependencyForQueueItem(entry.update, item),
        ),
      );
    },
    signal: () => worker?.signal(),
    prepareLiveInput(ctx, sourceUpdateIds, isCurrent) {
      const expectedWorker = worker,
        expectedBinding = sourceReferenceBinding,
        reference = releaseSourceReference;
      if (
        !expectedWorker?.prepareLiveInput ||
        !expectedBinding ||
        (deps.acquireSourceReference && !reference)
      )
        return undefined;
      const current = () => {
        if (
          activeContext !== ctx ||
          worker !== expectedWorker ||
          sourceReferenceBinding !== expectedBinding ||
          releaseSourceReference !== reference ||
          expectedWorker.getState().phase === "stopped" ||
          isCurrent?.() === false
        )
          return false;
        const binding = deps.resolveBinding();
        return (
          binding?.runtimeKey === expectedBinding.runtimeKey &&
          binding.recoveryKey === expectedBinding.recoveryKey &&
          binding.journal.inputCustody ===
            expectedBinding.journal.inputCustody &&
          binding.hasAuthority?.() !== false
        );
      };
      if (!current()) return undefined;
      return expectedWorker.prepareLiveInput(ctx, sourceUpdateIds, current);
    },
    getState: () => {
      const state = worker?.getState();
      if (!state) return undefined;
      return {
        ...state,
        ...(state.foreignQueuedOwner && foreignQueueOwnerLiveness
          ? { foreignQueuedOwnerLiveness: foreignQueueOwnerLiveness }
          : {}),
      };
    },
    isItemReady: (item) =>
      settlement?.isItemReady(item) ??
      (item.admissionReceipts?.length ?? 0) === 0,
    onPromptHandedOff: (item, ctx) =>
      settlement?.onPromptHandedOff(item, ctx) ?? false,
    onControlSettled: (item, ctx) =>
      settlement?.onControlSettled(item, ctx) ?? false,
    onItemsDiscarded: (items, ctx) =>
      settlement?.onItemsDiscarded(items, ctx) ?? false,
  };
}

export interface TelegramUpdateAdmissionLifecycleAssembly<TContext> {
  leader: TelegramUpdateAdmissionLifecycleRuntime<TContext>;
  follower: TelegramUpdateAdmissionLifecycleRuntime<TContext>;
}

export interface TelegramUpdateAdmissionLifecycleAssemblyDeps<
  TUpdate extends TelegramJournaledUpdate & TelegramUpdateFlow,
  TContext,
> {
  runtimeBinding: TelegramUpdateAdmissionRuntimeBinding<TContext>;
  inputCustodyBus?: TelegramInputCustodyBusBindingRuntime<TContext>;
  acquireSourceReference?: (
    role: "leader" | "follower",
    binding: TelegramUpdateAdmissionLifecycleJournalBinding,
  ) => () => void;
  worker: Omit<
    TelegramUpdateAdmissionWorkerRuntimeDeps<TUpdate, TContext>,
    | "journal"
    | "getJournalBindingKey"
    | "getRecipientBindingKey"
    | "hasAuthority"
    | "prepareUpdateForExecution"
  >;
  leader: {
    resolveBinding: () =>
      TelegramUpdateAdmissionLifecycleJournalBinding | undefined;
    hasAuthority: (ctx: TContext) => boolean;
  };
  follower: {
    resolveBinding: () =>
      TelegramUpdateAdmissionLifecycleJournalBinding | undefined;
    isRegistered: () => boolean;
    getGeneration: () => string | undefined;
    prepareUpdateForExecution: (update: TUpdate) => TUpdate;
    /** Session succession before worker creation, under the exact generation-fenced binding. */
    prepareBinding?: (
      binding: TelegramUpdateAdmissionLifecycleJournalBinding & {
        hasAuthority?: () => boolean;
      },
    ) => void;
  };
  recordRuntimeEvent?: TelegramUpdateWorkerRuntimeDeps<TContext>["recordRuntimeEvent"];
}

export type TelegramUpdateAdmissionWorkerRuntimeDeps<
  TUpdate extends TelegramJournaledUpdate & TelegramUpdateFlow,
  TContext,
> = Omit<
  TelegramUpdateWorkerRuntimeDeps<TContext>,
  "executeUpdate" | "executeCustodiedUpdate"
> & {
  inputCustody?: TelegramCustodyExecutionJournal;
  defaultHandle: (
    update: TUpdate,
    ctx: TContext,
    execution?: TelegramUpdateExecutionFence,
  ) => Promise<void>;
  prepareUpdateForExecution?: (update: TUpdate) => TUpdate;
  registry?: TelegramUpdateHandlerRegistry;
};

/** Compose source-bound routing and late grouped settlement under one worker. */
export function createTelegramUpdateAdmissionWorkerRuntime<
  TUpdate extends TelegramJournaledUpdate & TelegramUpdateFlow,
  TContext,
>(
  deps: TelegramUpdateAdmissionWorkerRuntimeDeps<TUpdate, TContext>,
): TelegramUpdateWorkerRuntime<TContext> {
  let worker: TelegramUpdateWorkerRuntime<TContext> | undefined;
  const admissionDeps: TelegramUpdateAdmissionHandleDeps<TUpdate, TContext> = {
    defaultHandle: deps.defaultHandle,
    registry: deps.registry,
    getJournalBindingKey: deps.getJournalBindingKey,
    abandonDeferred: (input) => worker?.abandonDeferred?.(input),
    armRoutingInput: (input) => worker?.armRoutingInput?.(input),
    selectRoutingInput: (input) => worker?.selectRoutingInput?.(input) === true,
    isRoutingInputCurrent: (input) =>
      worker?.isRoutingInputCurrent?.(input) !== false,
    getRoutingInput: (input) => worker?.getRoutingInput?.(input),
    supportsDeferredAbandonment: (input) =>
      worker?.supportsDeferredAbandonment?.(input) === true,
    inspectAbandoning: (input) => worker?.inspectAbandoning?.(input),
    inspectHistorical: (input) => worker?.inspectHistorical?.(input),
    inspectDeferredSource: (input) => worker?.inspectDeferredSource?.(input),
    inspectDeferredSourceSnapshot: (input) =>
      worker?.inspectDeferredSourceSnapshot?.(input),
    prepareDeferredLiveInput: (input) =>
      worker?.prepareDeferredLiveInput?.(input),
    prepareDeferredQueueAdmission: (input) =>
      worker?.prepareDeferredQueueAdmission?.(input),
    prepareDeferredSourceCompletion: (input) =>
      worker?.prepareDeferredSourceCompletion?.(input),
    isHistoricalSource: (input) => worker?.isHistoricalSource?.(input) === true,
    onLateOutcome(outcome, details) {
      return worker?.settleDeferred({
        updateId: details.updateId,
        outcome,
        signal: details.signal,
      });
    },
    onLateOutcomeError(error, updateId) {
      deps.recordRuntimeEvent?.("inbound-worker", error, {
        phase: "late-admission-handler",
        updateId,
      });
    },
  };
  const executeUpdate = createTelegramUpdateAdmissionHandle<TUpdate, TContext>(
    admissionDeps,
  );
  const admitPreparedLiveInput = async (
    update: TelegramJournaledUpdate,
    ctx: TContext,
    signal: AbortSignal,
  ) => {
    let carrier: unknown;
    const admit = createTelegramUpdateSourceAdmissionHandle(
      admissionDeps,
      (value) => {
        if (!value.message || typeof value.message !== "object")
          throw new Error(
            "Prepared live input needs one native message carrier.",
          );
        carrier = value.message;
      },
    );
    const outcome = await admit(
      deps.prepareUpdateForExecution?.(update as TUpdate) ??
        (update as TUpdate),
      ctx,
      signal,
    );
    return { outcome, carrier };
  };
  const custodyBindingKey = deps.inputCustody
    ? deps.getRecipientBindingKey?.()
    : undefined;
  if (deps.inputCustody && !custodyBindingKey)
    throw new Error(
      "Telegram custodied admission worker requires one recipient binding key.",
    );
  const executeCustodiedUpdate =
    deps.inputCustody && custodyBindingKey
      ? createTelegramCustodiedUpdateAdmissionHandle<TUpdate, TContext>({
          journal: deps.inputCustody,
          recipientBindingKey: custodyBindingKey,
          defaultHandle: deps.defaultHandle,
          registry: deps.registry,
          onLateOutcomeError(error, updateId) {
            deps.recordRuntimeEvent?.("inbound-worker", error, {
              phase: "late-custodied-admission-handler",
              updateId,
            });
          },
          onCustodiedLateSettlement(result, details) {
            worker?.settleCustodied({
              updateId: details.updateId,
              result,
              signal: details.signal,
            });
          },
        })
      : undefined;
  worker = createTelegramUpdateWorkerRuntime({
    ...deps,
    admitPreparedLiveInput,
    ...(executeCustodiedUpdate
      ? {
          executeCustodiedUpdate: async (
            update: TelegramJournaledUpdate,
            ctx: TContext,
            signal: AbortSignal,
          ) =>
            executeCustodiedUpdate(
              deps.prepareUpdateForExecution?.(update as TUpdate) ??
                (update as TUpdate),
              ctx,
              signal,
            ),
        }
      : {}),
    async executeUpdate(update, ctx, signal, target) {
      const typedUpdate = update as TUpdate;
      const prepared = deps.prepareUpdateForExecution?.(typedUpdate) ?? typedUpdate;
      // Journal/source evidence remains the original; only the warm released handler projection changes destination.
      const projectTo = (destination: TelegramTarget & { threadId: number }): TUpdate => ({ ...prepared,
        ...(prepared.message ? { message: prepared.message.message_thread_id === destination.threadId ? { ...prepared.message }
          : withoutTelegramTurnReplyAnchor({ ...prepared.message, message_thread_id: destination.threadId, reply_to_message: undefined }) } : {}),
        ...(prepared.edited_message ? { edited_message: prepared.edited_message.message_thread_id === destination.threadId ? { ...prepared.edited_message }
          : withoutTelegramTurnReplyAnchor({ ...prepared.edited_message, message_thread_id: destination.threadId, reply_to_message: undefined }) } : {}),
      } as TUpdate);
      const routed = target ? projectTo(target) : prepared;
      try {
        return await executeUpdate(
          routed,
          ctx,
          signal,
        );
      } catch (error) {
        if (await deps.settleTerminalExecutionFailure?.(error)) {
          return { kind: "complete" };
        }
        // A refused reply proves only that send was not issued, not that the handler made no prior effects.
        // Leave failure settlement to the worker's retry policy; never re-enter the handler to recover delivery here.
        throw error;
      }
    },
  });
  return worker;
}

/** Own leader/follower journal lifecycle construction and generation fencing. */
export function createTelegramUpdateAdmissionLifecycleAssembly<
  TUpdate extends TelegramJournaledUpdate & TelegramUpdateFlow,
  TContext,
>(
  deps: TelegramUpdateAdmissionLifecycleAssemblyDeps<TUpdate, TContext>,
): TelegramUpdateAdmissionLifecycleAssembly<TContext> {
  const leader = createTelegramUpdateAdmissionLifecycleRuntime({
    resolveBinding: deps.leader.resolveBinding,
    ...(deps.acquireSourceReference
      ? {
          acquireSourceReference: (binding) =>
            deps.acquireSourceReference!("leader", binding),
        }
      : {}),
    getQueueOwnerIdentity: deps.worker.getQueueOwnerIdentity,
    createWorker(journal, binding) {
      return createTelegramUpdateAdmissionWorkerRuntime({
        ...deps.worker,
        journal,
        ...(binding.journal.inputCustody
          ? { inputCustody: binding.journal.inputCustody }
          : {}),
        getJournalBindingKey: () => binding.recoveryKey,
        getRecipientBindingKey: () => binding.recipientBindingKey,
        hasAuthority: deps.leader.hasAuthority,
      });
    },
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
  const follower = createTelegramUpdateAdmissionLifecycleRuntime({
    getQueueOwnerIdentity: deps.worker.getQueueOwnerIdentity,
    ...(deps.acquireSourceReference
      ? {
          acquireSourceReference: (binding) =>
            deps.acquireSourceReference!("follower", binding),
        }
      : {}),
    ...(deps.follower.prepareBinding
      ? { prepareBinding: deps.follower.prepareBinding }
      : {}),
    resolveBinding() {
      const generation = deps.follower.getGeneration();
      if (!deps.follower.isRegistered() || !generation) return undefined;
      const binding = deps.follower.resolveBinding();
      if (!binding) return undefined;
      return {
        ...binding,
        runtimeKey: `${binding.runtimeKey}\u0000${generation}`,
        hasAuthority() {
          return (
            deps.follower.isRegistered() &&
            deps.follower.getGeneration() === generation
          );
        },
      };
    },
    createWorker(journal, binding) {
      return createTelegramUpdateAdmissionWorkerRuntime({
        ...deps.worker,
        journal,
        ...(binding.journal.inputCustody
          ? { inputCustody: binding.journal.inputCustody }
          : {}),
        getJournalBindingKey: () => binding.recoveryKey,
        getRecipientBindingKey: () => binding.recipientBindingKey,
        hasAuthority: () => binding.hasAuthority?.() ?? false,
        // Recipient custody is not an orphaned direct-bot source.
        shouldReviewHistoricalInput: undefined,
        shouldHoldPendingInput: undefined,
        spendHistoricalInput: undefined,
        onHeldSourcesPrepared: undefined,
        prepareUpdateForExecution: deps.follower.prepareUpdateForExecution,
      });
    },
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
  deps.runtimeBinding.bind({
    leader,
    follower,
    ...(deps.inputCustodyBus ? { inputCustodyBus: deps.inputCustodyBus } : {}),
  });
  return { leader, follower };
}

export interface TelegramUpdateAdmissionRuntimeAssembly<
  TContext,
> extends TelegramUpdateAdmissionLifecycleAssembly<TContext> {
  owner: TelegramUpdateWorkerOwnerRuntime<TContext>;
}

export type TelegramUpdateAdmissionRuntimeAssemblyDeps<
  TUpdate extends TelegramJournaledUpdate & TelegramUpdateFlow,
  TContext,
> = Omit<
  TelegramUpdateAdmissionLifecycleAssemblyDeps<TUpdate, TContext>,
  "worker" | "recordRuntimeEvent"
> & {
  owner: TelegramUpdateWorkerOwnerRuntimeDeps<TContext>;
  worker: Omit<
    TelegramUpdateAdmissionLifecycleAssemblyDeps<TUpdate, TContext>["worker"],
    | keyof TelegramUpdateWorkerOwnerRuntime<TContext>
    | "isContextCurrent"
    | "recordRuntimeEvent"
  >;
  recordRuntimeEvent?: TelegramUpdateWorkerRuntimeDeps<TContext>["recordRuntimeEvent"];
};

/** Own queue-owner projection and shared leader/follower worker composition. */
export function createTelegramUpdateAdmissionRuntimeAssembly<
  TUpdate extends TelegramJournaledUpdate & TelegramUpdateFlow,
  TContext,
>(
  deps: TelegramUpdateAdmissionRuntimeAssemblyDeps<TUpdate, TContext>,
): TelegramUpdateAdmissionRuntimeAssembly<TContext> {
  const owner = createTelegramUpdateWorkerOwnerRuntime(deps.owner);
  const lifecycle = createTelegramUpdateAdmissionLifecycleAssembly({
    runtimeBinding: deps.runtimeBinding,
    worker: {
      ...deps.worker,
      ...owner,
      isContextCurrent: deps.owner.isContextCurrent,
      recordRuntimeEvent: deps.recordRuntimeEvent,
    },
    leader: deps.leader,
    follower: deps.follower,
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
  return { owner, ...lifecycle };
}

/**
 * Register a handler that runs before pi-telegram routes a Telegram update
 * through its built-in handlers.
 *
 * This is the low-level public surface for extensions that share the same bot
 * and Pi process with pi-telegram.
 */
export function registerTelegramUpdateHandler(
  handler: TelegramUpdateHandler,
): () => void {
  return getOrCreateUpdateHandlerRegistry().add(handler);
}
