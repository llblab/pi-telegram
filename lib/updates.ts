/**
 * Telegram updates domain helpers
 * Zones: telegram inbound, authorization, routing plans
 * Owns update extraction, authorization, execution planning, generation-fenced journal draining, and the public update-handler registry
 */

import { randomUUID } from "node:crypto";

import {
  createTelegramPrivateTarget,
  createTelegramThreadTarget,
  type TelegramTarget,
} from "./target.ts";
import type {
  TelegramBusEnvelope,
  TelegramBusFollowerView,
  TelegramBusForeignUpdateSettlement,
  TelegramProcessLiveness,
} from "./bus.ts";
import type { TelegramMessageOwnershipStore } from "./ownership.ts";
import {
  TELEGRAM_UPDATE_JOURNAL_VERSION,
  TELEGRAM_UPDATE_JOURNAL_EXCLUSION_VERSION,
  TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION,
  TELEGRAM_UPDATE_JOURNAL_FAILURE_CLASS_MAX_LENGTH,
  TELEGRAM_UPDATE_JOURNAL_FAILURE_SUMMARY_MAX_LENGTH,
  TELEGRAM_UPDATE_JOURNAL_QUEUE_OWNER_ID_MAX_LENGTH,
  areTelegramUpdateJournalQueueOwnersEqual,
  getTelegramUpdateJournalBindingPath,
  isTelegramUpdateJournalQueueOwnerProcess,
  parseTelegramUpdateJournalQueueOwner,
  type TelegramInputJournalReceipt,
  type TelegramInputJournalSourceReference,
  type TelegramInputJournalStore,
  type TelegramJournaledUpdate,
  type TelegramUpdateJournalDeadQueueOwnerRecoveryResult,
  type TelegramUpdateJournalAppendResult,
  type TelegramUpdateJournalInputClaim,
  type TelegramUpdateJournalOperatorDispositionInput,
  type TelegramUpdateJournalOperatorDispositionResult,
  type TelegramUpdateJournalQueueDiscardResult,
  type TelegramUpdateJournalQueueHandoffAcceptResult,
  type TelegramUpdateJournalQueueHandoffCancelResult,
  type TelegramUpdateJournalQueueHandoffInput,
  type TelegramUpdateJournalQueueHandoffOfferResult,
  type TelegramUpdateJournalQueueOwner,
  type TelegramUpdateJournalQueueOwnerIdentity,
} from "./journal.ts";
import {
  areTelegramQueueAdmissionReceiptsEqual,
  createTelegramQueueHandoff,
  removeTelegramQueueItemByReceipt,
  type PendingTelegramControlItem,
  type TelegramControlQueueHandoffPayload,
  type TelegramQueueAdmissionReceipt,
  type TelegramQueueHandoffPayload,
  type TelegramQueueHandoffStageResult,
  type TelegramQueueReactionDisposition,
  type TelegramQueueHandoffStagingRuntime,
  type TelegramQueueItem,
} from "./queue.ts";
import {
  createTelegramUserPairingRuntime,
  getTelegramAuthorizationState,
  type TelegramAuthorizationState,
  type TelegramUserPairingRuntimeDeps,
} from "./config.ts";

// --- Extraction ---

export interface TelegramReactionTypeEmoji {
  type: "emoji";
  emoji: string;
}

export interface TelegramReactionTypeNonEmoji {
  type: string;
}

export type TelegramReactionType =
  | TelegramReactionTypeEmoji
  | TelegramReactionTypeNonEmoji;

export const TELEGRAM_PRIORITY_REACTIONS = [
  { id: 10, name: "like", emoji: "👍" },
  { id: 11, name: "lightning", emoji: "⚡" },
  { id: 12, name: "heart", emoji: "❤" },
  { id: 13, name: "dove", emoji: "🕊" },
  { id: 14, name: "fire", emoji: "🔥" },
] as const;
export const TELEGRAM_REMOVAL_REACTIONS = [
  { id: 20, name: "dislike", emoji: "👎" },
  { id: 21, name: "ghost", emoji: "👻" },
  { id: 22, name: "broken-heart", emoji: "💔" },
  { id: 23, name: "poop", emoji: "💩" },
  { id: 24, name: "wastebasket", emoji: "🗑" },
] as const;
export const TELEGRAM_PRIORITY_REACTION_EMOJIS =
  TELEGRAM_PRIORITY_REACTIONS.map((reaction) => reaction.emoji);
export const TELEGRAM_REMOVAL_REACTION_EMOJIS = TELEGRAM_REMOVAL_REACTIONS.map(
  (reaction) => reaction.emoji,
);

export interface TelegramUpdateDeletion {
  deleted_business_messages?: { message_ids?: unknown };
}

function isTelegramMessageIdList(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => Number.isInteger(item));
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

export function getTelegramQueueReactionDisposition(
  reactions: TelegramReactionType[],
): TelegramQueueReactionDisposition {
  const emojis = collectTelegramReactionEmojis(reactions);
  const suppressionEmoji = getTelegramReactionEmoji(
    emojis,
    TELEGRAM_REMOVAL_REACTION_EMOJIS,
  );
  const priorityEmoji = getTelegramReactionEmoji(
    emojis,
    TELEGRAM_PRIORITY_REACTION_EMOJIS,
  );
  if (suppressionEmoji && priorityEmoji) {
    return {
      kind: "priority-suppressed",
      priorityEmoji,
      suppressionEmoji,
    };
  }
  if (suppressionEmoji) return { kind: "suppressed", emoji: suppressionEmoji };
  if (priorityEmoji) return { kind: "priority", emoji: priorityEmoji };
  return { kind: "default" };
}

function getTelegramQueueReactionTransition(
  oldReactions: TelegramReactionType[],
  newReactions: TelegramReactionType[],
): TelegramQueueReactionDisposition | undefined {
  const oldEmojis = collectTelegramReactionEmojis(oldReactions);
  const newEmojis = collectTelegramReactionEmojis(newReactions);
  const oldPriorityEmoji = getTelegramReactionEmoji(
    oldEmojis,
    TELEGRAM_PRIORITY_REACTION_EMOJIS,
  );
  const newPriorityEmoji = getTelegramReactionEmoji(
    newEmojis,
    TELEGRAM_PRIORITY_REACTION_EMOJIS,
  );
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
  }
  if (oldSuppressionEmoji !== newSuppressionEmoji) {
    transition.suppressionEmoji = newSuppressionEmoji ?? null;
  }
  return transition;
}

export function extractDeletedTelegramMessageIds(
  update: TelegramUpdateDeletion,
): number[] {
  const deletedBusinessMessageIds =
    update.deleted_business_messages?.message_ids;
  if (isTelegramMessageIdList(deletedBusinessMessageIds)) {
    return deletedBusinessMessageIds;
  }
  return [];
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

export function getAuthorizedTelegramMessage(
  update: TelegramUpdateRouting,
  allowedUserId?: number,
): TelegramUpdateMessage | undefined {
  const message = update.message;
  if (!message || !message.from || message.from.is_bot) return undefined;
  if (message.chat.type === "private") return message;
  return message.from.id === allowedUserId ? message : undefined;
}

export function getAuthorizedTelegramEditedMessage(
  update: TelegramUpdateRouting,
  allowedUserId?: number,
): TelegramUpdateMessage | undefined {
  const message = update.edited_message;
  if (!message || !message.from || message.from.is_bot) return undefined;
  if (message.chat.type === "private") return message;
  return message.from.id === allowedUserId ? message : undefined;
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

export interface TelegramMessageOwnershipView {
  instanceId: string;
  ownerGeneration?: string;
  recipientBindingKey?: string;
}

export type TelegramMessageOwnershipLookup = (
  chatId: number,
  messageId: number,
) => TelegramMessageOwnershipView | undefined;

export interface TelegramTargetOwnershipView {
  instanceId: string;
  ownerGeneration?: string;
  recipientBindingKey?: string;
}

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

export class TelegramForeignUpdateSettlementError extends Error {
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
  | { kind: "complete" }
  | { kind: "deferred" }
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

interface TelegramUpdateAdmissionBinding {
  sourceUpdateId: number;
  report: (outcome: TelegramUpdateAdmissionOutcome) => void;
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
    | TelegramUpdateAdmissionBinding
    | undefined;
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
): TUpdate {
  if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) {
    throw new TelegramUpdateAdmissionOutcomeError(
      "Telegram update admission requires a safe update_id.",
    );
  }
  const binding: TelegramUpdateAdmissionBinding = {
    sourceUpdateId: update.update_id,
    report,
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

/** Report source completion; true means reported, not a durable settlement acknowledgement. */
export function reportTelegramUpdateCompleted(value: unknown): boolean {
  const binding = getTelegramUpdateAdmissionBinding(value);
  if (!binding) return false;
  const execution = getTelegramUpdateExecutionFence(value);
  if (execution && !execution.isCurrent()) return false;
  binding.report({ kind: "complete" });
  return true;
}

export function reportTelegramUpdateDeferred(value: unknown): boolean {
  const binding = getTelegramUpdateAdmissionBinding(value);
  if (!binding) return false;
  binding.report({ kind: "deferred" });
  return true;
}

export function reportTelegramQueueAdmission(
  values: readonly unknown[],
  receipts: readonly TelegramQueueAdmissionReceiptLike[],
): boolean {
  const bindings = new Map<number, TelegramUpdateAdmissionBinding>();
  for (const value of values) {
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
  const deletedMessageIds = extractDeletedTelegramMessageIds(update);
  if (deletedMessageIds.length > 0) {
    return { kind: "deleted", messageIds: deletedMessageIds };
  }
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

const TELEGRAM_UNAUTHORIZED_DENIAL_COPY = "Access denied.";

function formatTelegramUnauthorizedDenial(format: "plain" | "html"): string {
  return format === "html"
    ? `<b>🚫 ${TELEGRAM_UNAUTHORIZED_DENIAL_COPY}</b>`
    : `🚫 ${TELEGRAM_UNAUTHORIZED_DENIAL_COPY}`;
}

export interface TelegramUpdateRuntimeDeps<
  TContext = unknown,
  TReactionUpdate extends TelegramMessageReactionUpdated =
    TelegramMessageReactionUpdated,
  TCallbackQuery extends TelegramCallbackQuery = TelegramCallbackQuery,
  TMessage extends TelegramUpdateMessage = TelegramUpdateMessage,
> {
  ctx: TContext;
  execution?: TelegramUpdateExecutionFence;
  getCurrentInstanceId?: () => string | undefined;
  getMessageOwnership?: TelegramMessageOwnershipLookup;
  getTargetOwnership?: TelegramTargetOwnershipLookup;
  recordMessageOwnership?: TelegramMessageOwnershipRecorder;
  foreignOwnedUpdateForwarder?: TelegramForeignOwnedUpdateForwarder<
    TContext,
    TReactionUpdate,
    TCallbackQuery,
    TMessage
  >;
  removePendingMediaGroupMessages: (messageIds: number[]) => void;
  removeQueuedTelegramTurnsByMessageIds: (
    messageIds: number[],
    ctx: TContext,
  ) => number;
  handleAuthorizedTelegramReactionUpdate: (
    reactionUpdate: TReactionUpdate,
    ctx: TContext,
  ) => Promise<void>;
  handleTelegramTopicLifecycleUpdate?: (
    lifecycle: TelegramTopicLifecycleUpdate<TMessage>,
    ctx: TContext,
  ) => Promise<void> | void;
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
  /** Called when the owner writes in an unbound thread no live instance owns. */
  handleUnboundTelegramTopicMessage?: (
    message: TMessage & { from: TelegramUser },
    ctx: TContext,
  ) => Promise<void>;
}

export interface TelegramUpdateRuntimeControllerDeps<
  TContext = unknown,
  TCallbackQuery extends TelegramCallbackQuery = TelegramCallbackQuery,
  TMessage extends TelegramUpdateMessage = TelegramUpdateMessage,
> {
  getAllowedUserId: () => number | undefined;
  getCurrentInstanceId?: () => string | undefined;
  getMessageOwnership?: TelegramMessageOwnershipLookup;
  getTargetOwnership?: TelegramTargetOwnershipLookup;
  recordMessageOwnership?: TelegramMessageOwnershipRecorder;
  foreignOwnedUpdateForwarder?: TelegramForeignOwnedUpdateForwarder<
    TContext,
    TelegramMessageReactionUpdated,
    TCallbackQuery,
    TMessage
  >;
  removePendingMediaGroupMessages: (messageIds: number[]) => void;
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
  const messageOwnership = getForeignTelegramMessageOwnership(
    getTelegramCallbackMessageTarget(query),
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
    ? { ...deps, getMessageOwnership: undefined }
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
      assertExecutionCurrent: createTelegramUpdateExecutionFenceGuard(
        reactionUpdate,
      ),
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
    allowedUserId === undefined || !Number.isSafeInteger(allowedUserId) || allowedUserId <= 0 ||
    !reactionUser || reactionUser.is_bot || reactionUser.id !== allowedUserId ||
    reactionUpdate.actor_chat !== undefined
  ) return;
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

function isTelegramStaleContextError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("stale after session") ||
      error.message.includes("stale ctx"))
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
    const assertExecutionCurrent = (): void =>
      deps.execution?.assertCurrent();
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
            formatTelegramUnauthorizedDenial("plain"),
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
        const settlement =
          await deps.foreignOwnedUpdateForwarder?.forwardCallback?.({
            query: plan.query,
            ownership: foreignOwnership,
            ctx: deps.ctx,
          });
        if (settlement?.status !== "accepted") {
          const callbackQueryId = getTelegramCallbackQueryId(plan.query);
          try {
            if (callbackQueryId) {
              assertExecutionCurrent();
              await deps.answerCallbackQuery(
                callbackQueryId,
                "This Telegram message belongs to another Pi instance.",
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
          formatTelegramUnauthorizedDenial("html"),
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
          formatTelegramUnauthorizedDenial("html"),
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
    if (!isTelegramStaleContextError(error)) throw error;
  }
}

// --- Durable update worker ---

export const TELEGRAM_UPDATE_RETRY_BASE_DELAY_MS = 1_000;
export const TELEGRAM_UPDATE_RETRY_MAX_DELAY_MS = 60_000;
export const TELEGRAM_UPDATE_WORKER_BATCH_SIZE = 64;

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
    kind: "running-outcome-unknown" | "foreign-ready" | "handoff-frozen" |
      "legacy-retry-state";
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
  version: typeof TELEGRAM_UPDATE_JOURNAL_VERSION |
    typeof TELEGRAM_UPDATE_JOURNAL_EXCLUSION_VERSION |
    typeof TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION;
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
  executeUpdate: (
    update: TelegramJournaledUpdate,
    ctx: TContext,
    signal: AbortSignal,
  ) => Promise<TelegramUpdateAdmissionOutcome> | TelegramUpdateAdmissionOutcome;
  executeCustodiedUpdate?: (
    update: TelegramJournaledUpdate,
    ctx: TContext,
    signal: AbortSignal,
  ) => Promise<TelegramCustodiedExecutionResult>;
  hasAuthority: (ctx: TContext) => boolean;
  getJournalBindingKey?: () => string | undefined;
  getRecipientBindingKey?: () => string | undefined;
  getQueueOwnerIdentity?: (
    ctx: TContext,
  ) => TelegramUpdateJournalQueueOwnerIdentity;
  isContextCurrent?: (ctx: TContext) => boolean;
  createAbortController?: () => AbortController;
  getNowMs?: () => number;
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
  onQueueReceiptCommitted?: (
    receipt: TelegramQueueAdmissionReceiptLike,
    ctx: TContext,
  ) => void;
  onUpdateCompleted?: (updateId: number, ctx: TContext) => void;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export type TelegramQueueReceiptCompletionReason =
  | "prompt-handoff"
  | "control-settlement"
  | "discard";

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
  isQueueReceiptCommitted: (
    receipt: TelegramQueueAdmissionReceiptLike,
  ) => boolean;
  getQueueReceiptOwner: (
    receipt: TelegramQueueAdmissionReceiptLike,
  ) => TelegramUpdateJournalQueueOwner | undefined;
  completeQueueReceipts: (input: {
    receipts: readonly TelegramQueueAdmissionReceiptLike[];
    ctx: TContext;
    reason: TelegramQueueReceiptCompletionReason;
  }) => void;
  stop: () => Promise<void>;
  waitForDrain: () => Promise<void>;
  getState: () => TelegramUpdateWorkerStateSnapshot;
}

export class TelegramUpdateAdmissionOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramUpdateAdmissionOutcomeError";
  }
}

interface TelegramUpdateWorkerOwner<TContext> {
  generation: number;
  ctx: TContext;
  controller: AbortController;
  queueOwnerIdentity: TelegramUpdateJournalQueueOwnerIdentity;
}

type TelegramUpdateWorkerClaim = "deferred" | "queued";
type TelegramUpdateWorkerDrainResult = "idle" | "blocked" | "aborted";
type TelegramUpdateWorkerExecutionSettlement =
  | { ok: true; outcome: TelegramUpdateAdmissionOutcome; custodied?: false }
  | { ok: true; outcome: TelegramCustodiedExecutionResult; custodied: true }
  | { ok: false; error: unknown };

const TELEGRAM_UPDATE_WORKER_EXECUTION_ABORTED = Symbol(
  "telegram.update-worker.execution-aborted",
);

function getTelegramUpdateWorkerStateSnapshot(
  state: TelegramUpdateWorkerStateSnapshot,
): TelegramUpdateWorkerStateSnapshot {
  return { ...state };
}

function isTelegramUpdateAdmissionRecord(
  value: unknown,
): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTelegramUpdateAdmissionString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
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
  if (value.kind === "complete") return { kind: "complete" };
  if (value.kind === "deferred") return { kind: "deferred" };
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
      summary: normalizeTelegramUpdateFailureSummary(
        error.settlement.message,
      ),
    };
  }
  const errorName =
    error instanceof Error && error.name ? error.name : "UnknownError";
  return {
    disposition: "retryable",
    failureClass: normalizeTelegramUpdateFailureClass(
      `execution-${errorName}`,
    ),
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

export function createTelegramUpdateWorkerRuntime<TContext>(
  deps: TelegramUpdateWorkerRuntimeDeps<TContext>,
): TelegramUpdateWorkerRuntime<TContext> {
  if (
    (deps.scheduleRetry === undefined) !==
    (deps.cancelRetry === undefined)
  ) {
    throw new Error(
      "Telegram update retry scheduling requires matching schedule and cancel ports.",
    );
  }
  const getNowMs = deps.getNowMs ?? Date.now;
  const batchSize = deps.batchSize ?? TELEGRAM_UPDATE_WORKER_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new Error("Telegram update worker batch size must be positive.");
  }
  const yieldToEventLoop = deps.yieldToEventLoop ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
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
  const unsettledExecutionsByUpdateId = new Map<
    number,
    Set<Promise<TelegramUpdateWorkerExecutionSettlement>>
  >();
  const committedQueueReceipts = new Map<
    string,
    {
      receipt: TelegramQueueAdmissionReceiptLike;
      queueOwner: TelegramUpdateJournalQueueOwner;
    }
  >();
  const unsettledExecutions =
    new Set<Promise<TelegramUpdateWorkerExecutionSettlement>>();
  let owner: TelegramUpdateWorkerOwner<TContext> | undefined;
  let drainPromise: Promise<void> | undefined;
  let pendingSignal = false;
  let blocked = false;
  let nextGeneration = 0;
  let retryTimer: unknown;
  let retryTimerAtMs: number | undefined;
  let retryTimerToken: object | undefined;
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

  const updateClaimCounts = (): void => {
    let deferredClaimCount = 0;
    let queuedClaimCount = 0;
    for (const claim of claims.values()) {
      if (claim === "queued") queuedClaimCount += 1;
      else deferredClaimCount += 1;
    }
    state.deferredClaimCount = deferredClaimCount;
    state.queuedClaimCount = queuedClaimCount;
  };

  const releaseDeferredClaims = (updateIds: readonly number[]): void => {
    let changed = false;
    for (const updateId of updateIds) {
      if (claims.get(updateId) !== "deferred") continue;
      claims.delete(updateId);
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

  const publishCommittedQueueReceipt = (
    receipt: TelegramQueueAdmissionReceiptLike,
    queueOwner: TelegramUpdateJournalQueueOwner,
    ctx: TContext,
  ): boolean => {
    const normalized = bindQueueReceiptToJournal(receipt);
    const existing = committedQueueReceipts.get(receipt.receiptId);
    if (existing) {
      if (
        !areTelegramQueueAdmissionReceiptsEqual(
          existing.receipt,
          normalized,
        ) ||
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
    committedQueueReceipts.set(receipt.receiptId, {
      receipt: normalized,
      queueOwner: { ...queueOwner },
    });
    try {
      deps.onQueueReceiptCommitted?.(normalized, ctx);
    } catch (error) {
      recordRuntimeEvent(error, {
        phase: "queue-receipt-observer",
        receiptId: normalized.receiptId,
      });
    }
    return true;
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
    retryTimer = scheduleRetry(() => {
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
    }, Math.max(0, nextRetryAtMs - getNowMs()));
  };

  const refreshJournalState = (
    snapshot: TelegramUpdateWorkerJournalSnapshot,
    expectedOwner: TelegramUpdateWorkerOwner<TContext>,
  ): number | undefined => {
    // Validate the whole snapshot before reconstructing any queue authority.
    if ((snapshot.version !== TELEGRAM_UPDATE_JOURNAL_VERSION &&
        snapshot.version !== TELEGRAM_UPDATE_JOURNAL_EXCLUSION_VERSION &&
        snapshot.version !== TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION) ||
        (snapshot.version === TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION &&
          !deps.executeCustodiedUpdate) ||
        snapshot.entries.some((entry) =>
          ((snapshot.version === TELEGRAM_UPDATE_JOURNAL_EXCLUSION_VERSION || entry.preApprovalExcluded !== undefined) &&
            typeof entry.preApprovalExcluded !== "boolean") ||
          (entry.preApprovalExcluded === true && entry.state === "queued"))) {
      throw new TelegramUpdateAdmissionOutcomeError("Telegram journal snapshot has invalid pairing exclusion evidence.");
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
    let nextRetry: TelegramUpdateWorkerJournalSnapshot["entries"][number] | undefined;
    let failedCount = 0;
    let latestFailure: TelegramUpdateWorkerJournalSnapshot["entries"][number] | undefined;
    for (const entry of snapshot.entries) {
      availableUpdateIds.add(entry.updateId);
      oldestAdmittedAtMs =
        oldestAdmittedAtMs === undefined
          ? entry.admittedAtMs
          : Math.min(oldestAdmittedAtMs, entry.admittedAtMs);
      if (entry.state === "retry-wait" && entry.nextRetryAtMs !== undefined) {
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
    for (const [updateId, claim] of claims) {
      if (
        !availableUpdateIds.has(updateId) ||
        (claim === "queued" && !locallyOwnedQueuedUpdateIds.has(updateId))
      ) {
        claims.delete(updateId);
      }
    }
    for (const [receiptId, receipt] of queuedReceiptEntries) {
      publishCommittedQueueReceipt(
        {
          queueKind: receipt.queueKind,
          receiptId,
          sourceUpdateIds: receipt.sourceUpdateIds,
        },
        receipt.queueOwner,
        expectedOwner.ctx,
      );
    }
    for (const [receiptId] of committedQueueReceipts) {
      if (!queuedReceiptEntries.has(receiptId)) {
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
  ):
    | Exclude<TelegramUpdateWorkerDrainResult, "idle">
    | undefined => {
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
  ): Promise<
    | TelegramUpdateWorkerExecutionSettlement
    | typeof TELEGRAM_UPDATE_WORKER_EXECUTION_ABORTED
  > => {
    if (expectedOwner.controller.signal.aborted) {
      return TELEGRAM_UPDATE_WORKER_EXECUTION_ABORTED;
    }
    const custodied = deps.executeCustodiedUpdate !== undefined;
    const execution = Promise.resolve().then(async (): Promise<
      TelegramUpdateAdmissionOutcome | TelegramCustodiedExecutionResult
    > => deps.executeCustodiedUpdate
      ? deps.executeCustodiedUpdate(update, expectedOwner.ctx, expectedOwner.controller.signal)
      : deps.executeUpdate(update, expectedOwner.ctx, expectedOwner.controller.signal));
    const settlement: Promise<TelegramUpdateWorkerExecutionSettlement> =
      execution.then(
        (outcome) => custodied
          ? ({ ok: true, outcome: outcome as unknown as TelegramCustodiedExecutionResult, custodied: true })
          : ({ ok: true, outcome: outcome as TelegramUpdateAdmissionOutcome }),
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
    const aborted = new Promise<typeof TELEGRAM_UPDATE_WORKER_EXECUTION_ABORTED>(
      (resolve) => {
        const onAbort = () => resolve(TELEGRAM_UPDATE_WORKER_EXECUTION_ABORTED);
        removeAbortListener = () =>
          expectedOwner.controller.signal.removeEventListener(
            "abort",
            onAbort,
          );
        expectedOwner.controller.signal.addEventListener("abort", onAbort, {
          once: true,
        });
        if (expectedOwner.controller.signal.aborted) onAbort();
      },
    );
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
    | Exclude<TelegramUpdateWorkerDrainResult, "idle"> => {
    const normalized = normalizeQueueReceipt(outcome);
    const existing = committedQueueReceipts.get(normalized.receiptId);
    if (existing) {
      if (
        !areTelegramQueueAdmissionReceiptsEqual(
          existing.receipt,
          normalized,
        ) ||
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
    try {
      publishCommittedQueueReceipt(
        normalized,
        queueOwner,
        expectedOwner.ctx,
      );
    } catch (error) {
      return blockWithFailure(
        "invalid-outcome",
        "queue-receipt-publish",
        error,
        currentUpdateId,
      );
    }
    return "committed";
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
        throw new Error("Telegram update failure classifier returned invalid data.");
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
    updateIds: readonly number[],
  ): Exclude<TelegramUpdateWorkerDrainResult, "idle"> | undefined => {
    if (updateIds.length === 0) return undefined;
    const commitAuthority = checkAuthority(
      expectedOwner,
      updateIds[updateIds.length - 1],
    );
    if (commitAuthority) return commitAuthority;
    try {
      const removed = deps.journal.removeCompleted(updateIds);
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
    for (const updateId of updateIds) {
      claims.delete(updateId);
      state.lastCompletedUpdateId = updateId;
      state.lastCompletedAtMs = completedAtMs;
      try {
        deps.onUpdateCompleted?.(updateId, expectedOwner.ctx);
      } catch (error) {
        recordRuntimeEvent(error, {
          phase: "update-completion-observer",
          updateId,
        });
      }
    }
    return undefined;
  };

  const drain = async (
    expectedOwner: TelegramUpdateWorkerOwner<TContext>,
  ): Promise<TelegramUpdateWorkerDrainResult> => {
    while (owner === expectedOwner && !expectedOwner.controller.signal.aborted) {
      const authorityResult = checkAuthority(expectedOwner);
      if (authorityResult) return authorityResult;
      let snapshot: TelegramUpdateWorkerJournalSnapshot;
      let scheduledRetryAtMs: number | undefined;
      try {
        snapshot = deps.journal.read();
        scheduledRetryAtMs = refreshJournalState(snapshot, expectedOwner);
      } catch (error) {
        return blockWithFailure("journal-read", "journal-read", error);
      }
      const nowMs = getNowMs();
      const entries: TelegramUpdateWorkerJournalSnapshot["entries"][number][] =
        [];
      let hasMoreEntries = false;
      let hasOutcomeUnknownInput = false;
      let hasUnavailableInputCustody = false;
      let blockedInputCustody: TelegramUpdateWorkerStateSnapshot["blockedInputCustody"];
      delete state.blockedInputCustody;
      for (const candidate of snapshot.entries) {
        if (snapshot.version === TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION &&
            (candidate.state === "retry-wait" || candidate.state === "failed")) {
          hasUnavailableInputCustody = true;
          blockedInputCustody ??= { updateId: candidate.updateId, kind: "legacy-retry-state" };
          continue;
        }
        if (snapshot.version === TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION && candidate.inputClaim) {
          if (candidate.inputClaim.phase === "running") {
            hasOutcomeUnknownInput = true;
            if (!blockedInputCustody || blockedInputCustody.kind !== "running-outcome-unknown")
              blockedInputCustody = { updateId: candidate.updateId,
                kind: "running-outcome-unknown" };
            continue;
          }
          if (candidate.inputClaim.handoff || !isTelegramUpdateJournalQueueOwnerProcess(
            candidate.inputClaim.owner, expectedOwner.queueOwnerIdentity)) {
            hasUnavailableInputCustody = true;
            blockedInputCustody ??= { updateId: candidate.updateId,
              kind: candidate.inputClaim.handoff ? "handoff-frozen" : "foreign-ready" };
            continue;
          }
        }
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
          if (blockedInputCustody) state.blockedInputCustody = blockedInputCustody;
          transition("blocked", blockedInputCustody?.updateId,
            hasOutcomeUnknownInput ? "execution" : "input-custody");
          return "blocked";
        }
        transition("idle");
        return "idle";
      }
      const completedUpdateIds: number[] = [];
      let snapshotInvalidated = false;
      for (const entry of entries) {
        const priorExecutions = unsettledExecutionsByUpdateId.get(entry.updateId);
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
          completedUpdateIds.push(entry.updateId);
          continue;
        }
        clearRetryTimer();
        transition("executing", entry.updateId);
        const execution = await executeWithinOwner(expectedOwner, entry.update);
        if (execution === TELEGRAM_UPDATE_WORKER_EXECUTION_ABORTED) {
          return "aborted";
        }
        if (!execution.ok) {
          if (deps.executeCustodiedUpdate) {
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
            if (!isTelegramUpdateJournalQueueOwnerProcess(
              outcome.queueReceipt.queueOwner, expectedOwner.queueOwnerIdentity)) {
              return blockWithFailure("invalid-outcome", "custody-queue-owner",
                new Error("Telegram custodied queue receipt belongs to another process."),
                entry.updateId);
            }
            for (const sourceUpdateId of receipt.sourceUpdateIds) claims.set(sourceUpdateId, "queued");
            try {
              publishCommittedQueueReceipt(receipt, outcome.queueReceipt.queueOwner, expectedOwner.ctx);
            } catch (error) {
              return blockWithFailure("invalid-outcome", "queue-receipt-publish", error,
                entry.updateId);
            }
            transition("queued", entry.updateId);
          }
          snapshotInvalidated = true;
          break;
        }
        const postExecutionAuthority = checkAuthority(
          expectedOwner,
          entry.updateId,
        );
        if (postExecutionAuthority) return postExecutionAuthority;
        const claimableUpdateIds = new Set<number>([
          entry.updateId,
          ...claims.keys(),
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
          claims.set(entry.updateId, "deferred");
          transition("deferred", entry.updateId);
          continue;
        }
        if (outcome.kind === "queued") {
          const completionResult = commitCompletedBatch(
            expectedOwner,
            completedUpdateIds,
          );
          if (completionResult) return completionResult;
          const queuedResult = commitQueuedOutcome(
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
        completedUpdateIds.push(entry.updateId);
      }
      const completionResult = commitCompletedBatch(
        expectedOwner,
        completedUpdateIds,
      );
      if (completionResult) return completionResult;
      if (!snapshotInvalidated && !hasMoreEntries) continue;
      await yieldToEventLoop();
      if (
        owner !== expectedOwner ||
        expectedOwner.controller.signal.aborted
      ) {
        return "aborted";
      }
    }
    return "aborted";
  };

  launchDrain = (): void => {
    const expectedOwner = owner;
    if (!expectedOwner || drainPromise) return;
    const run = async (): Promise<void> => {
      while (
        pendingSignal &&
        owner === expectedOwner &&
        !expectedOwner.controller.signal.aborted
      ) {
        pendingSignal = false;
        const result = await drain(expectedOwner);
        if (result !== "idle") {
          pendingSignal = false;
          return;
        }
      }
    };
    const operation = run();
    let tracked: Promise<void>;
    const finish = (): void => {
      if (owner === expectedOwner && drainPromise === tracked) {
        drainPromise = undefined;
        if (pendingSignal && !expectedOwner.controller.signal.aborted) {
          launchDrain();
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
      const nowMs = getNowMs();
      const generation = ++nextGeneration;
      const queueOwnerIdentity = resolveQueueOwnerIdentity(ctx, generation);
      owner = {
        generation,
        ctx,
        controller: createAbortController(),
        queueOwnerIdentity,
      };
      claims.clear();
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
      state.deferredClaimCount = 0;
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
      state.unsettledExecutionCount = unsettledExecutions.size;
      state.lastCompletedUpdateId = undefined;
      state.lastCompletedAtMs = undefined;
      state.lastFailureAtMs = undefined;
      state.lastFailurePhase = undefined;
      notifyStateChange();
      launchDrain();
    },
    signal() {
      if (!owner || owner.controller.signal.aborted) return;
      blocked = false;
      pendingSignal = true;
      launchDrain();
    },
    settleDeferred(input) {
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
      if (input.outcome.kind === "complete") {
        // Expiry may retire only a still-deferred source, never accepted queue work.
        if (claim !== "deferred") return;
        const result = commitCompletedBatch(expectedOwner, [input.updateId]);
        if (!result) transition("idle", input.updateId);
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
          new Set([input.updateId, ...claims.keys()]),
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
      const result = commitQueuedOutcome(
        expectedOwner,
        input.updateId,
        outcome,
      );
      if (result === "blocked") {
        releaseDeferredClaims(outcome.sourceUpdateIds);
        return;
      }
      if (result === "aborted") return;
      transition("queued", input.updateId);
    },
    settleCustodied(input) {
      const expectedOwner = owner;
      if (!expectedOwner || expectedOwner.controller.signal !== input.signal || input.signal.aborted)
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
      if (existing && areTelegramQueueAdmissionReceiptsEqual(existing.receipt, receipt) &&
          areTelegramUpdateJournalQueueOwnersEqual(
            existing.queueOwner, input.result.queueReceipt.queueOwner)) return;
      if (existing) {
        blockWithFailure("invalid-outcome", "queue-receipt-conflict",
          new TelegramUpdateAdmissionOutcomeError(
            `Telegram queue receipt ${receipt.receiptId} conflicts with custodied authority.`),
          input.updateId);
        return;
      }
      if (!receipt.sourceUpdateIds.includes(input.updateId) ||
          receipt.sourceUpdateIds.some(updateId => claims.get(updateId) !== "deferred")) {
        blockWithFailure("invalid-outcome", "late-custody-unclaimed",
          new TelegramUpdateAdmissionOutcomeError(
            `Telegram update ${input.updateId} reported custodied queue without exact deferred claims.`),
          input.updateId);
        return;
      }
      if (!isTelegramUpdateJournalQueueOwnerProcess(
        input.result.queueReceipt.queueOwner, expectedOwner.queueOwnerIdentity)) {
        blockWithFailure("invalid-outcome", "custody-queue-owner",
          new Error("Telegram custodied queue receipt belongs to another process."), input.updateId);
        return;
      }
      for (const sourceUpdateId of receipt.sourceUpdateIds) claims.set(sourceUpdateId, "queued");
      try {
        publishCommittedQueueReceipt(receipt, input.result.queueReceipt.queueOwner, expectedOwner.ctx);
      } catch (error) {
        blockWithFailure("invalid-outcome", "queue-receipt-publish", error, input.updateId);
        return;
      }
      transition("queued", input.updateId);
    },
    isQueueReceiptCommitted(receipt) {
      const committed = committedQueueReceipts.get(receipt.receiptId);
      return (
        committed !== undefined &&
        areTelegramQueueAdmissionReceiptsEqual(
          committed.receipt,
          normalizeQueueReceipt(receipt),
        )
      );
    },
    getQueueReceiptOwner(receipt) {
      const committed = committedQueueReceipts.get(receipt.receiptId);
      return committed &&
        areTelegramQueueAdmissionReceiptsEqual(
          committed.receipt,
          normalizeQueueReceipt(receipt),
        )
        ? { ...committed.queueOwner }
        : undefined;
    },
    completeQueueReceipts(input) {
      const expectedOwner = owner;
      if (
        !expectedOwner ||
        expectedOwner.controller.signal.aborted ||
        !(deps.isContextCurrent?.(input.ctx) ?? expectedOwner.ctx === input.ctx)
      ) {
        return;
      }
      if (input.receipts.length === 0) return;
      const normalizedReceipts = input.receipts.map(normalizeQueueReceipt);
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
        if (!committed) continue;
        if (
          receiptIds.has(receipt.receiptId) ||
          !areTelegramQueueAdmissionReceiptsEqual(
            committed.receipt,
            receipt,
          ) ||
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
          return;
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
      if (receiptIds.size === 0) return;
      let removedUpdateIds: readonly number[];
      try {
        removedUpdateIds = deps.journal.completeQueued(
          queuedCompletions,
        ).removedUpdateIds;
      } catch (error) {
        blockWithFailure(
          "journal-write",
          "queue-receipt-completion",
          error,
        );
        return;
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
        return;
      }
      for (const updateId of sourceUpdateIds) claims.delete(updateId);
      for (const receiptId of receiptIds) {
        committedQueueReceipts.delete(receiptId);
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
      pendingSignal = true;
      launchDrain();
    },
    async stop() {
      const expectedOwner = owner;
      if (!expectedOwner) return;
      pendingSignal = false;
      clearRetryTimer();
      expectedOwner.controller.abort();
      await drainPromise?.catch(() => undefined);
      if (owner !== expectedOwner) return;
      owner = undefined;
      drainPromise = undefined;
      claims.clear();
      committedQueueReceipts.clear();
      blocked = false;
      state.phase = "stopped";
      state.phaseStartedAtMs = getNowMs();
      state.currentUpdateId = undefined;
      state.blockedReason = undefined;
      state.deferredClaimCount = 0;
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
      state.unsettledExecutionCount = unsettledExecutions.size;
      notifyStateChange();
    },
    waitForDrain() {
      return drainPromise ?? Promise.resolve();
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
>(
  update: TUpdate,
  execution: TelegramUpdateExecutionFence,
): TUpdate {
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

export interface TelegramUpdateHandlerWrapDeps<TUpdate, TContext> {
  defaultHandle: (update: TUpdate, ctx: TContext) => Promise<void>;
  registry?: TelegramUpdateHandlerRegistry;
}

/**
 * Wrap a default polling `handleUpdate` with the public update handler registry.
 */
export function createTelegramUpdateHandle<TUpdate, TContext>(
  deps: TelegramUpdateHandlerWrapDeps<TUpdate, TContext>,
): (update: TUpdate, ctx: TContext) => Promise<void> {
  const registry = deps.registry ?? getOrCreateUpdateHandlerRegistry();
  const { defaultHandle } = deps;
  return async (update, ctx) => {
    const verdict = await registry.dispatch(update);
    if (verdict === "consume") return;
    await defaultHandle(update, ctx);
  };
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
  onLateOutcome?: (
    outcome: TelegramUpdateAdmissionOutcome,
    details: {
      updateId: number;
      ctx: TContext;
      signal: AbortSignal;
    },
  ) => void | Promise<void>;
  onLateOutcomeError?: (error: unknown, updateId: number) => void;
}

function mergeTelegramReportedAdmissionOutcome(
  current: TelegramUpdateAdmissionOutcome | undefined,
  next: TelegramUpdateAdmissionOutcome,
  updateId: number,
): TelegramUpdateAdmissionOutcome {
  if (!current || current.kind === "deferred") return next;
  if (next.kind === "deferred") return current;
  if (current.kind === "complete" && next.kind === "complete") return current;
  if (current.kind === "queued" && next.kind === "queued" &&
      areTelegramQueueAdmissionReceiptsEqual(current, next)) return current;
  throw new TelegramUpdateAdmissionOutcomeError(
    `Telegram update ${updateId} reported conflicting queue outcomes.`,
  );
}

export type TelegramCustodiedExecutionResult =
  | { status: "completed" }
  | { status: "deferred"; receipt: TelegramInputJournalReceipt }
  | { status: "queued"; queueReceipt: ReturnType<TelegramInputJournalStore["queueInputs"]>["queueReceipt"] }
  | { status: "outcome-unknown"; receipt: TelegramInputJournalReceipt };

type TelegramCustodyExecutionJournal = Pick<TelegramInputJournalStore,
  "acquireInput" | "startInput" | "completeInput" | "queueInputs">;

export function createTelegramInputCustodyWorkerJournalPort(
  store: TelegramInputJournalStore,
): TelegramUpdateWorkerJournalPort & { inputCustody: TelegramCustodyExecutionJournal } {
  const legacyMutation = (): never => {
    throw new TelegramUpdateAdmissionOutcomeError(
      "Telegram v3 custody forbids legacy raw worker settlement.",
    );
  };
  return {
    read: () => store.read() as unknown as TelegramUpdateWorkerJournalSnapshot,
    markQueued: legacyMutation,
    markExecutionFailure: legacyMutation,
    removeCompleted: legacyMutation,
    completeQueued: receipts => store.completeQueued(receipts),
    inputCustody: {
      acquireInput: store.acquireInput,
      startInput: store.startInput,
      completeInput: store.completeInput,
      queueInputs: store.queueInputs,
    },
  };
}

export function createTelegramInputCustodyLegacyDispositionRuntime(deps: {
  withBindingReference<T>(recoveryKey: string, operation: (binding: {
    recoveryKey: string; journal: Pick<TelegramInputJournalStore,
      "listLegacyCustodyCandidates" | "applyLegacyCustodyDisposition">;
  }) => T): T;
}) {
  const withBinding = <T>(recoveryKey: string, operation: (journal: Pick<
    TelegramInputJournalStore, "listLegacyCustodyCandidates" |
      "applyLegacyCustodyDisposition">) => T): T => {
    if (!recoveryKey) throw new TelegramUpdateAdmissionOutcomeError(
      "Telegram legacy custody disposition binding is unavailable.");
    return deps.withBindingReference(recoveryKey, binding => {
      if (binding.recoveryKey !== recoveryKey)
        throw new TelegramUpdateAdmissionOutcomeError(
          "Telegram legacy custody disposition binding is unavailable.");
      return operation(binding.journal);
    });
  };
  return {
    list(recoveryKey: string) {
      return withBinding(recoveryKey, journal => journal.listLegacyCustodyCandidates());
    },
    apply(recoveryKey: string,
      authority: Parameters<TelegramInputJournalStore["applyLegacyCustodyDisposition"]>[0]) {
      return withBinding(recoveryKey,
        journal => journal.applyLegacyCustodyDisposition(authority));
    },
  };
}

export function createTelegramInputCustodyHandoffClient(deps: {
  journal: Pick<TelegramInputJournalStore, "offerInputHandoff">;
  resolveAcceptedReference?: (input: {
    sourceUpdateId: number; recipientBindingKey: string;
  }) => { sourceRecoveryKey: string; source: { updateId: number; owner: {
    acquisitionId: string; handoffId: string } } } | undefined;
  sendEnvelope(envelope: Extract<TelegramBusEnvelope,
    { kind: "leader.offerInputCustodyHandoff" }>): Promise<TelegramBusEnvelope | undefined>;
}): { transfer(input: {
  requestId: string;
  receipt: TelegramInputJournalReceipt;
  recipientInstanceId: string;
  recipientRegistrationGeneration: string;
  recipientBindingKey: string;
  recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
  handoffToken: string;
  sentAtMs: number;
  auth?: string;
}): Promise<{ sourceRecoveryKey: string; source: { updateId: number; owner: {
  acquisitionId: string; handoffId: string } }; duplicate: boolean }> } {
  return {
    async transfer(input) {
      const reconciled = deps.resolveAcceptedReference?.({
        sourceUpdateId: input.receipt.updateId,
        recipientBindingKey: input.recipientBindingKey });
      if (reconciled) return { ...reconciled, duplicate: true };
      const offered = deps.journal.offerInputHandoff({ receipt: input.receipt,
        recipientOwner: input.recipientOwner, handoffToken: input.handoffToken });
      const envelope: Extract<TelegramBusEnvelope,
        { kind: "leader.offerInputCustodyHandoff" }> = {
          kind: "leader.offerInputCustodyHandoff", requestId: input.requestId,
          recipientInstanceId: input.recipientInstanceId,
          recipientRegistrationGeneration: input.recipientRegistrationGeneration,
          recipientBindingKey: input.recipientBindingKey,
          sourceRecoveryKey: offered.source.journalBindingKey,
          source: offered.source, handoffId: offered.handoff.handoffId,
          sentAtMs: input.sentAtMs, ...(input.auth ? { auth: input.auth } : {}),
        };
      const response = await deps.sendEnvelope(envelope);
      if (response?.kind !== "bus.ack" || response.requestId !== input.requestId ||
          !response.ok || !response.result || typeof response.result !== "object" ||
          Array.isArray(response.result)) throw new Error(
        "Telegram input custody handoff acknowledgement is missing or rejected.",
      );
      const result = response.result as Record<string, unknown>;
      const source = result.source;
      if (result.sourceRecoveryKey !== offered.source.journalBindingKey ||
          !source || typeof source !== "object" || Array.isArray(source) ||
          (source as Record<string, unknown>).updateId !== offered.source.updateId ||
          !(source as Record<string, unknown>).owner ||
          typeof (source as Record<string, unknown>).owner !== "object" ||
          Array.isArray((source as Record<string, unknown>).owner) ||
          typeof ((source as Record<string, unknown>).owner as Record<string, unknown>).acquisitionId !== "string" ||
          ((source as Record<string, unknown>).owner as Record<string, unknown>).handoffId !== offered.handoff.handoffId ||
          typeof result.duplicate !== "boolean") throw new Error(
        "Telegram input custody handoff acknowledgement returned mismatched authority.",
      );
      return { sourceRecoveryKey: result.sourceRecoveryKey as string,
        source: { updateId: (source as Record<string, unknown>).updateId as number, owner: {
          acquisitionId: ((source as Record<string, unknown>).owner as Record<string, unknown>).acquisitionId as string,
          handoffId: ((source as Record<string, unknown>).owner as Record<string, unknown>).handoffId as string } },
        duplicate: result.duplicate as boolean };
    },
  };
}

export interface TelegramInputCustodyHandoffAcceptanceInput {
  sourceRecoveryKey: string;
  recipientBindingKey: string;
  source: TelegramInputJournalSourceReference;
  handoffId: string;
}

export function createTelegramInputCustodyHandoffAcceptanceRuntime<TContext>(deps: {
  resolveBinding(recoveryKey: string): {
    recoveryKey: string;
    recipientBindingKey: string;
    recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
    journal: Pick<TelegramInputJournalStore, "acceptInputHandoff">;
    signalWorker(ctx: TContext): void;
  } | undefined;
}): { accept(input: TelegramInputCustodyHandoffAcceptanceInput, ctx: TContext): {
  sourceRecoveryKey: string;
  source: { updateId: number; owner: { acquisitionId: string; handoffId: string } };
  duplicate: boolean;
} } {
  return {
    accept(input, ctx) {
      const binding = deps.resolveBinding(input.sourceRecoveryKey);
      if (!binding || binding.recoveryKey !== input.sourceRecoveryKey ||
          binding.recipientBindingKey !== input.recipientBindingKey ||
          input.source.journalBindingKey !== input.sourceRecoveryKey) throw new Error(
        "Telegram input custody handoff binding is unavailable or changed.",
      );
      const accepted = binding.journal.acceptInputHandoff({ source: input.source,
        recipientOwner: binding.recipientOwner, handoffId: input.handoffId });
      const acceptedHandoffId = accepted.receipt.owner.handoffId;
      if (!acceptedHandoffId || acceptedHandoffId !== input.handoffId) throw new Error(
        "Telegram input custody handoff acceptance returned mismatched authority.",
      );
      binding.signalWorker(ctx);
      return { sourceRecoveryKey: binding.recoveryKey,
        source: { updateId: accepted.receipt.updateId,
          owner: { acquisitionId: accepted.receipt.owner.acquisitionId,
            handoffId: acceptedHandoffId } }, duplicate: accepted.duplicate };
    },
  };
}

export function createTelegramInputCustodyForwardReferenceResolver(deps: {
  recoveryKey: string;
  recipientBindingKey: string;
  recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
  journal: Pick<TelegramInputJournalStore, "read">;
}): (input: { sourceUpdateId: number; recipientBindingKey: string }) => {
  sourceRecoveryKey: string;
  source: { updateId: number; owner: {
    acquisitionId: string; handoffId: string;
  } };
} | undefined {
  return input => {
    if (input.recipientBindingKey !== deps.recipientBindingKey) return undefined;
    const entry = deps.journal.read().entries.find(
      candidate => candidate.updateId === input.sourceUpdateId);
    const claim = entry?.inputClaim;
    if (!entry || entry.state !== "pending" || entry.preApprovalExcluded !== false ||
        !claim || claim.phase !== "ready" || claim.handoff ||
        claim.recipientBindingKey !== deps.recipientBindingKey ||
        !claim.owner.handoffId ||
        claim.owner.sessionGeneration !== deps.recipientOwner.sessionGeneration ||
        !isTelegramUpdateJournalQueueOwnerProcess(claim.owner, deps.recipientOwner)) return undefined;
    return { sourceRecoveryKey: deps.recoveryKey, source: { updateId: entry.updateId,
      owner: { acquisitionId: claim.owner.acquisitionId,
        handoffId: claim.owner.handoffId } } };
  };
}

export interface TelegramCustodiedSourceReferenceWakeInput {
  deliveryId: string;
  sourceUpdateId: number;
  recipientBindingKey: string;
  sourceRecoveryKey: string;
  sourceClaim: { acquisitionId: string; handoffId: string };
}

export function createTelegramInputCustodySourceReferenceWakeRuntime<TContext>(deps: {
  resolveBinding(recoveryKey: string): {
    recoveryKey: string;
    recipientBindingKey: string;
    recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
    journal: Pick<TelegramInputJournalStore, "read">;
    signalWorker(ctx: TContext): void;
  } | undefined;
}): { wakeSource(input: TelegramCustodiedSourceReferenceWakeInput, ctx: TContext): void } {
  return {
    wakeSource(input, ctx) {
      const binding = deps.resolveBinding(input.sourceRecoveryKey);
      if (!binding || binding.recoveryKey !== input.sourceRecoveryKey ||
          binding.recipientBindingKey !== input.recipientBindingKey) throw new Error(
        "Telegram follower source-reference binding is unavailable or changed.",
      );
      const entry = binding.journal.read().entries.find(
        candidate => candidate.updateId === input.sourceUpdateId);
      const claim = entry?.inputClaim;
      if (!entry || entry.state !== "pending" || entry.preApprovalExcluded !== false ||
          !claim || claim.phase !== "ready" || claim.handoff ||
          claim.recipientBindingKey !== input.recipientBindingKey ||
          claim.owner.acquisitionId !== input.sourceClaim.acquisitionId ||
          claim.owner.handoffId !== input.sourceClaim.handoffId ||
          claim.owner.sessionGeneration !== binding.recipientOwner.sessionGeneration ||
          !isTelegramUpdateJournalQueueOwnerProcess(claim.owner, binding.recipientOwner)) throw new Error(
        "Telegram follower source-reference claim is unavailable or changed.",
      );
      binding.signalWorker(ctx);
    },
  };
}

export interface TelegramInputCustodyBusBindingRuntime<TContext> {
  acceptHandoff(input: TelegramInputCustodyHandoffAcceptanceInput, ctx: TContext): {
    sourceRecoveryKey: string; source: { updateId: number; owner: {
      acquisitionId: string; handoffId: string } }; duplicate: boolean };
  wakeSource(input: TelegramCustodiedSourceReferenceWakeInput, ctx: TContext): void;
  resolveForwardReference(input: { sourceUpdateId: number; recipientBindingKey: string }): {
    sourceRecoveryKey: string; source: { updateId: number; owner: {
      acquisitionId: string; handoffId: string } } } | undefined;
}

export function createTelegramInputCustodyBusBindingRuntime<TContext>(deps: {
  getForwardRecoveryKey(): string | undefined;
  resolveBinding(recoveryKey: string): {
    recoveryKey: string;
    recipientBindingKey: string;
    recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
    journal: Pick<TelegramInputJournalStore,
      "read" | "acceptInputHandoff">;
    signalWorker(ctx: TContext): void;
  } | undefined;
}): TelegramInputCustodyBusBindingRuntime<TContext> {
  const acceptance = createTelegramInputCustodyHandoffAcceptanceRuntime<TContext>({
    resolveBinding: deps.resolveBinding });
  const wake = createTelegramInputCustodySourceReferenceWakeRuntime<TContext>({
    resolveBinding: deps.resolveBinding });
  return {
    acceptHandoff: acceptance.accept,
    wakeSource: wake.wakeSource,
    resolveForwardReference(input: {
      sourceUpdateId: number; recipientBindingKey: string;
    }) {
      const recoveryKey = deps.getForwardRecoveryKey();
      if (!recoveryKey) return undefined;
      const binding = deps.resolveBinding(recoveryKey);
      if (!binding || binding.recoveryKey !== recoveryKey) return undefined;
      return createTelegramInputCustodyForwardReferenceResolver({
        recoveryKey: binding.recoveryKey,
        recipientBindingKey: binding.recipientBindingKey,
        recipientOwner: binding.recipientOwner,
        journal: binding.journal,
      })(input);
    },
  };
}

export type TelegramInputCustodyActivationBlocker =
  | "disabled"
  | "source-unready"
  | "legacy-writers-present"
  | "migration-incomplete"
  | "peer-capability-mismatch";

export function evaluateTelegramInputCustodyActivationReadiness(input: {
  requested: boolean;
  sourceStatus: "absent" | "v3" | "legacy" | "unsupported" | "ambiguous";
  legacyWritersExcluded: boolean;
  historicalMigrationComplete: boolean;
  peerReadiness: readonly ("ready" | "legacy" | "unknown")[];
}): { enabled: true } | { enabled: false; blocker: TelegramInputCustodyActivationBlocker } {
  if (!input.requested) return { enabled: false, blocker: "disabled" };
  if (!input.legacyWritersExcluded) return { enabled: false, blocker: "legacy-writers-present" };
  if (!input.historicalMigrationComplete) return { enabled: false, blocker: "migration-incomplete" };
  if (input.sourceStatus !== "absent" && input.sourceStatus !== "v3")
    return { enabled: false, blocker: "source-unready" };
  if (input.peerReadiness.some(readiness => readiness !== "ready"))
    return { enabled: false, blocker: "peer-capability-mismatch" };
  return { enabled: true };
}

export interface TelegramInputCustodyReadinessEvidenceSnapshot {
  version: 1;
  revision: number;
  writerExclusion?: TelegramInputCustodyWriterExclusionEvidence;
  migration?: TelegramInputCustodyMigrationEvidence;
  startupExclusion?: TelegramInputCustodyStartupExclusionAuthority;
  migrationCompletion?: TelegramInputCustodyMigrationCompletionAuthority;
}

export function createTelegramInputCustodyReadinessEvidenceStore(deps: {
  readRetained(): string | undefined;
  publishRetained(serialized: string): void;
  withSerialization<T>(operation: () => T): T;
  authorizePublication(kind: "writer-exclusion" | "migration" | "startup-exclusion" |
    "migration-completion", evidence: TelegramInputCustodyWriterExclusionEvidence |
      TelegramInputCustodyMigrationEvidence | TelegramInputCustodyStartupExclusionAuthority |
      TelegramInputCustodyMigrationCompletionAuthority): boolean;
}) {
  const decode = (serialized: string | undefined): TelegramInputCustodyReadinessEvidenceSnapshot => {
    if (serialized === undefined) return { version: 1, revision: 0 };
    if (serialized.length > 16_384) throw new Error("Telegram custody readiness evidence exceeds capacity.");
    let value: unknown;
    try { value = JSON.parse(serialized); } catch { throw new Error("Telegram custody readiness evidence is malformed."); }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Telegram custody readiness evidence is malformed.");
    const snapshot = value as Record<string, unknown>;
    if (snapshot.version !== 1 || !Number.isSafeInteger(snapshot.revision) ||
      (snapshot.revision as number) < 0 || Object.keys(snapshot).some(
        key => !["version", "revision", "writerExclusion", "migration", "startupExclusion",
          "migrationCompletion"].includes(key)))
      throw new Error("Telegram custody readiness evidence is malformed.");
    const validate = (evidence: unknown, kind: "writer" | "migration") => {
      if (evidence === undefined) return undefined;
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence))
        throw new Error("Telegram custody readiness evidence is malformed.");
      const record = evidence as Record<string, unknown>;
      const statuses = kind === "writer" ? ["excluded", "present", "unknown"]
        : ["complete", "incomplete", "unknown"];
      const writerKeys = ["startupAuthorityId", "closureOperationId", "writerInventorySha256"];
      const migrationKeys = ["migrationAuthorityId", "startupAuthorityId", "closureOperationId",
        "migrationInventorySha256", "resultingSourceFamily"];
      const linkedKeys = kind === "writer" ? writerKeys : migrationKeys;
      const suppliedLinkedKeys = linkedKeys.filter(key => record[key] !== undefined);
      const linkedMalformed = suppliedLinkedKeys.length === linkedKeys.length && (
        typeof record.startupAuthorityId !== "string" || !record.startupAuthorityId ||
        typeof record.closureOperationId !== "string" || !record.closureOperationId ||
        (kind === "writer"
          ? typeof record.writerInventorySha256 !== "string" ||
            !/^[a-f0-9]{64}$/u.test(record.writerInventorySha256)
          : typeof record.migrationAuthorityId !== "string" || !record.migrationAuthorityId ||
            typeof record.migrationInventorySha256 !== "string" ||
            !/^[a-f0-9]{64}$/u.test(record.migrationInventorySha256) ||
            (record.resultingSourceFamily !== "absent" && record.resultingSourceFamily !== "v3")));
      if (record.version !== 1 || typeof record.profileKey !== "string" || !record.profileKey ||
        typeof record.recoveryKey !== "string" || !record.recoveryKey ||
        !statuses.includes(record.status as string) || Object.keys(record).some(
          key => !["version", "profileKey", "recoveryKey", "status", ...linkedKeys].includes(key)) ||
        (suppliedLinkedKeys.length !== 0 && suppliedLinkedKeys.length !== linkedKeys.length) ||
        linkedMalformed) throw new Error("Telegram custody readiness evidence is malformed.");
      return { version: 1 as const, profileKey: record.profileKey,
        recoveryKey: record.recoveryKey, status: record.status,
        ...(suppliedLinkedKeys.length === linkedKeys.length ? kind === "writer" ? {
          startupAuthorityId: record.startupAuthorityId,
          closureOperationId: record.closureOperationId,
          writerInventorySha256: record.writerInventorySha256,
        } : {
          migrationAuthorityId: record.migrationAuthorityId,
          startupAuthorityId: record.startupAuthorityId,
          closureOperationId: record.closureOperationId,
          migrationInventorySha256: record.migrationInventorySha256,
          resultingSourceFamily: record.resultingSourceFamily,
        } : {}) };
    };
    const writerExclusion = validate(snapshot.writerExclusion, "writer") as
      TelegramInputCustodyWriterExclusionEvidence | undefined;
    const migration = validate(snapshot.migration, "migration") as
      TelegramInputCustodyMigrationEvidence | undefined;
    let startupExclusion: TelegramInputCustodyStartupExclusionAuthority | undefined;
    if (snapshot.startupExclusion !== undefined) {
      const candidate = snapshot.startupExclusion as Record<string, unknown>;
      if (!candidate || typeof candidate.profileKey !== "string" ||
        typeof candidate.recoveryKey !== "string")
        throw new Error("Telegram custody readiness evidence is malformed.");
      startupExclusion = normalizeTelegramInputCustodyStartupExclusionAuthority(candidate,
        { profileKey: candidate.profileKey, recoveryKey: candidate.recoveryKey });
      if (!startupExclusion) throw new Error("Telegram custody readiness evidence is malformed.");
    }
    let migrationCompletion: TelegramInputCustodyMigrationCompletionAuthority | undefined;
    if (snapshot.migrationCompletion !== undefined) {
      const candidate = snapshot.migrationCompletion as Record<string, unknown>;
      if (!candidate || typeof candidate.profileKey !== "string" ||
        typeof candidate.recoveryKey !== "string")
        throw new Error("Telegram custody readiness evidence is malformed.");
      migrationCompletion = normalizeTelegramInputCustodyMigrationCompletionAuthority(candidate,
        { profileKey: candidate.profileKey, recoveryKey: candidate.recoveryKey });
      if (!migrationCompletion)
        throw new Error("Telegram custody readiness evidence is malformed.");
    }
    const identities: TelegramInputCustodyActivationEvidenceIdentity[] = [];
    if (writerExclusion) identities.push(writerExclusion);
    if (migration) identities.push(migration);
    if (startupExclusion) identities.push(startupExclusion);
    if (migrationCompletion) identities.push(migrationCompletion);
    if (identities.some(evidence => evidence.profileKey !== identities[0]?.profileKey ||
      evidence.recoveryKey !== identities[0]?.recoveryKey)) throw new Error(
      "Telegram custody readiness evidence has conflicting identities.",
    );
    if (writerExclusion?.startupAuthorityId && startupExclusion &&
      (writerExclusion.startupAuthorityId !== startupExclusion.authorityId ||
       writerExclusion.closureOperationId !== startupExclusion.closureOperationId ||
       writerExclusion.writerInventorySha256 !== startupExclusion.writerInventorySha256))
      throw new Error("Telegram custody readiness evidence has conflicting authorities.");
    if (migration?.migrationAuthorityId && migrationCompletion &&
      (migration.migrationAuthorityId !== migrationCompletion.authorityId ||
       migration.startupAuthorityId !== migrationCompletion.startupAuthorityId ||
       migration.closureOperationId !== migrationCompletion.closureOperationId ||
       migration.migrationInventorySha256 !== migrationCompletion.migrationInventorySha256 ||
       migration.resultingSourceFamily !== migrationCompletion.resultingSourceFamily))
      throw new Error("Telegram custody readiness evidence has conflicting migration authorities.");
    if (migrationCompletion && startupExclusion &&
      (migrationCompletion.startupAuthorityId !== startupExclusion.authorityId ||
       migrationCompletion.closureOperationId !== startupExclusion.closureOperationId))
      throw new Error("Telegram custody readiness evidence has conflicting cutover authorities.");
    return { version: 1, revision: snapshot.revision as number,
      ...(writerExclusion ? { writerExclusion } : {}),
      ...(migration ? { migration } : {}),
      ...(startupExclusion ? { startupExclusion } : {}),
      ...(migrationCompletion ? { migrationCompletion } : {}) };
  };
  const read = () => decode(deps.readRetained());
  const publish = (input: { expectedRevision: number } & (
    | { kind: "writer-exclusion"; evidence: TelegramInputCustodyWriterExclusionEvidence }
    | { kind: "migration"; evidence: TelegramInputCustodyMigrationEvidence }
    | { kind: "startup-exclusion"; evidence: TelegramInputCustodyStartupExclusionAuthority }
    | { kind: "migration-completion"; evidence: TelegramInputCustodyMigrationCompletionAuthority }
  )) => deps.withSerialization(() => {
    const current = read();
    if (current.revision !== input.expectedRevision) throw new Error(
      "Telegram custody readiness evidence revision changed.",
    );
    const next = { ...current, revision: current.revision + 1,
      ...(input.kind === "writer-exclusion" ? { writerExclusion: input.evidence } :
        input.kind === "migration" ? { migration: input.evidence } :
          input.kind === "startup-exclusion" ? { startupExclusion: input.evidence } :
            { migrationCompletion: input.evidence }) };
    const serialized = `${JSON.stringify(next)}\n`;
    const validated = decode(serialized);
    const normalizedEvidence = input.kind === "writer-exclusion"
      ? validated.writerExclusion : input.kind === "migration"
        ? validated.migration : input.kind === "startup-exclusion"
          ? validated.startupExclusion : validated.migrationCompletion;
    if (!normalizedEvidence || !deps.authorizePublication(input.kind, normalizedEvidence))
      throw new Error("Telegram custody readiness evidence publication is unauthorized.");
    deps.publishRetained(serialized);
    return validated;
  });
  return { read, publish };
}

export interface TelegramInputCustodyActivationEvidenceIdentity {
  profileKey: string;
  recoveryKey: string;
}

export interface TelegramInputCustodyStartupExclusionAuthority
  extends TelegramInputCustodyActivationEvidenceIdentity {
  version: 1;
  status: "enforced" | "revoked";
  authorityId: string;
  closureOperationId: string;
  writerInventorySha256: string;
  allowedWriterProtocol: "custody-v3";
  authorizedAtMs: number;
}

export function normalizeTelegramInputCustodyStartupExclusionAuthority(
  value: unknown,
  expected: TelegramInputCustodyActivationEvidenceIdentity,
): TelegramInputCustodyStartupExclusionAuthority | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = ["version", "status", "authorityId", "closureOperationId", "profileKey",
    "recoveryKey", "writerInventorySha256", "allowedWriterProtocol", "authorizedAtMs"];
  if (Object.keys(record).some(key => !keys.includes(key)) || record.version !== 1 ||
    (record.status !== "enforced" && record.status !== "revoked") ||
    record.profileKey !== expected.profileKey || record.recoveryKey !== expected.recoveryKey ||
    typeof record.authorityId !== "string" || !record.authorityId || record.authorityId.length > 512 ||
    typeof record.closureOperationId !== "string" || !record.closureOperationId ||
    record.closureOperationId.length > 512 ||
    typeof record.writerInventorySha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.writerInventorySha256) ||
    record.allowedWriterProtocol !== "custody-v3" ||
    !Number.isSafeInteger(record.authorizedAtMs) || (record.authorizedAtMs as number) < 0)
    return undefined;
  return { version: 1, status: record.status, authorityId: record.authorityId,
    closureOperationId: record.closureOperationId, profileKey: expected.profileKey,
    recoveryKey: expected.recoveryKey, writerInventorySha256: record.writerInventorySha256,
    allowedWriterProtocol: "custody-v3", authorizedAtMs: record.authorizedAtMs as number };
}

export interface TelegramInputCustodyWriterExclusionEvidence
  extends TelegramInputCustodyActivationEvidenceIdentity {
  version: 1;
  status: "excluded" | "present" | "unknown";
  startupAuthorityId?: string;
  closureOperationId?: string;
  writerInventorySha256?: string;
}

export interface TelegramInputCustodyWriterInventory
  extends TelegramInputCustodyActivationEvidenceIdentity {
  complete: boolean;
  writerInventorySha256: string;
  writers: readonly { processId: number; processBirthId: string }[];
}

export function evaluateTelegramInputCustodyWriterExclusionEvidence(input: {
  expected: TelegramInputCustodyActivationEvidenceIdentity;
  inventory: TelegramInputCustodyWriterInventory;
  startupAuthority: TelegramInputCustodyStartupExclusionAuthority | undefined;
  getProcessLiveness(writer: {
    processId: number; processBirthId: string;
  }): TelegramProcessLiveness;
}): TelegramInputCustodyWriterExclusionEvidence {
  const identity = { ...input.expected };
  const authority = input.startupAuthority;
  if (!input.inventory.complete ||
      input.inventory.profileKey !== input.expected.profileKey ||
      input.inventory.recoveryKey !== input.expected.recoveryKey ||
      !/^[a-f0-9]{64}$/u.test(input.inventory.writerInventorySha256) ||
      !authority || authority.status !== "enforced" ||
      authority.profileKey !== input.expected.profileKey ||
      authority.recoveryKey !== input.expected.recoveryKey ||
      authority.writerInventorySha256 !== input.inventory.writerInventorySha256)
    return { version: 1, status: "unknown", ...identity };
  const authorityBinding = { startupAuthorityId: authority.authorityId,
    closureOperationId: authority.closureOperationId,
    writerInventorySha256: authority.writerInventorySha256 };
  let unknown = false;
  for (const writer of input.inventory.writers) {
       let liveness: TelegramProcessLiveness;
    try { liveness = input.getProcessLiveness(writer); } catch { liveness = "unverifiable"; }
    if (liveness === "alive") return { version: 1, status: "present", ...identity,
      ...authorityBinding };
    if (liveness !== "dead") unknown = true;
  }
  return { version: 1, status: unknown ? "unknown" : "excluded", ...identity,
    ...authorityBinding };
}

export interface TelegramInputCustodyMigrationCompletionAuthority
  extends TelegramInputCustodyActivationEvidenceIdentity {
  version: 1;
  status: "authorized" | "revoked";
  authorityId: string;
  startupAuthorityId: string;
  closureOperationId: string;
  migrationInventorySha256: string;
  resultingSourceFamily: "absent" | "v3";
  authorizedAtMs: number;
}

export function normalizeTelegramInputCustodyMigrationCompletionAuthority(
  value: unknown,
  expected: TelegramInputCustodyActivationEvidenceIdentity,
): TelegramInputCustodyMigrationCompletionAuthority | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = ["version", "status", "authorityId", "startupAuthorityId",
    "closureOperationId", "profileKey", "recoveryKey", "migrationInventorySha256",
    "resultingSourceFamily", "authorizedAtMs"];
  if (Object.keys(record).some(key => !keys.includes(key)) || record.version !== 1 ||
    (record.status !== "authorized" && record.status !== "revoked") ||
    record.profileKey !== expected.profileKey || record.recoveryKey !== expected.recoveryKey ||
    typeof record.authorityId !== "string" || !record.authorityId || record.authorityId.length > 512 ||
    typeof record.startupAuthorityId !== "string" || !record.startupAuthorityId ||
    record.startupAuthorityId.length > 512 ||
    typeof record.closureOperationId !== "string" || !record.closureOperationId ||
    record.closureOperationId.length > 512 ||
    typeof record.migrationInventorySha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.migrationInventorySha256) ||
    (record.resultingSourceFamily !== "absent" && record.resultingSourceFamily !== "v3") ||
    !Number.isSafeInteger(record.authorizedAtMs) || (record.authorizedAtMs as number) < 0)
    return undefined;
  return { version: 1, status: record.status, authorityId: record.authorityId,
    startupAuthorityId: record.startupAuthorityId,
    closureOperationId: record.closureOperationId, profileKey: expected.profileKey,
    recoveryKey: expected.recoveryKey,
    migrationInventorySha256: record.migrationInventorySha256,
    resultingSourceFamily: record.resultingSourceFamily,
    authorizedAtMs: record.authorizedAtMs as number };
}

export interface TelegramInputCustodyMigrationEvidence
  extends TelegramInputCustodyActivationEvidenceIdentity {
  version: 1;
  status: "complete" | "incomplete" | "unknown";
  migrationAuthorityId?: string;
  startupAuthorityId?: string;
  closureOperationId?: string;
  migrationInventorySha256?: string;
  resultingSourceFamily?: "absent" | "v3";
}

export type TelegramInputCustodyWriterCutoverResult<TMode> =
  | { kind: "blocked"; blocker: "startup-authority" | "writer-inventory";
      evidence?: TelegramInputCustodyWriterExclusionEvidence }
  | { kind: "completed"; mode: TMode; evidence: TelegramInputCustodyWriterExclusionEvidence;
      resumed: boolean };

export function executeTelegramInputCustodyWriterCutover<TClosure extends {
  operationId: string; profileKey: string; recoveryKey: string;
}, TMode extends TelegramInputCustodyWriterProtocolModeEvidence>(input: {
  expected: TelegramInputCustodyActivationEvidenceIdentity;
  closure: TClosure;
  startupAuthority: TelegramInputCustodyStartupExclusionAuthority;
  inventory: TelegramInputCustodyWriterInventory;
  getProcessLiveness(writer: { processId: number; processBirthId: string }): TelegramProcessLiveness;
  installProtocolMode(closure: TClosure, authority: {
    startupAuthorityId: string; writerInventorySha256: string;
  }): { mode: TMode; resumed: boolean };
  evidenceStore: {
    read(): TelegramInputCustodyReadinessEvidenceSnapshot;
    publish(input: { expectedRevision: number; kind: "writer-exclusion";
      evidence: TelegramInputCustodyWriterExclusionEvidence }):
        TelegramInputCustodyReadinessEvidenceSnapshot;
  };
}): TelegramInputCustodyWriterCutoverResult<TMode> {
  const matchesAuthority = (candidate: TelegramInputCustodyStartupExclusionAuthority | undefined) =>
    Boolean(candidate && candidate.status === "enforced" && candidate.version === 1 &&
      candidate.profileKey === input.expected.profileKey &&
      candidate.recoveryKey === input.expected.recoveryKey &&
      candidate.authorityId === input.startupAuthority.authorityId &&
      candidate.closureOperationId === input.closure.operationId &&
      candidate.writerInventorySha256 === input.startupAuthority.writerInventorySha256 &&
      candidate.allowedWriterProtocol === "custody-v3" &&
      candidate.authorizedAtMs === input.startupAuthority.authorizedAtMs);
  if (input.closure.profileKey !== input.expected.profileKey ||
      input.closure.recoveryKey !== input.expected.recoveryKey ||
      !matchesAuthority(input.evidenceStore.read().startupExclusion))
    return { kind: "blocked", blocker: "startup-authority" };
  const evidence = evaluateTelegramInputCustodyWriterExclusionEvidence({
    expected: input.expected, inventory: input.inventory,
    startupAuthority: input.startupAuthority, getProcessLiveness: input.getProcessLiveness });
  if (evidence.status !== "excluded")
    return { kind: "blocked", blocker: "writer-inventory", evidence };
  const installed = input.installProtocolMode(input.closure, {
    startupAuthorityId: input.startupAuthority.authorityId,
    writerInventorySha256: input.startupAuthority.writerInventorySha256,
  });
  if (installed.mode.protocol !== "custody-v3" ||
      installed.mode.profileKey !== input.expected.profileKey ||
      installed.mode.recoveryKey !== input.expected.recoveryKey ||
      installed.mode.startupAuthorityId !== evidence.startupAuthorityId ||
      installed.mode.closureOperationId !== evidence.closureOperationId ||
      installed.mode.writerInventorySha256 !== evidence.writerInventorySha256)
    throw new Error("Telegram custody writer protocol installation returned mismatched authority.");
  const current = input.evidenceStore.read();
  if (!matchesAuthority(current.startupExclusion))
    return { kind: "blocked", blocker: "startup-authority", evidence };
  const existing = current.writerExclusion;
  if (existing?.status === "excluded" && existing.profileKey === evidence.profileKey &&
      existing.recoveryKey === evidence.recoveryKey &&
      existing.startupAuthorityId === evidence.startupAuthorityId &&
      existing.closureOperationId === evidence.closureOperationId &&
      existing.writerInventorySha256 === evidence.writerInventorySha256)
    return { kind: "completed", mode: installed.mode, evidence: existing,
      resumed: installed.resumed };
  input.evidenceStore.publish({ expectedRevision: current.revision,
    kind: "writer-exclusion", evidence });
  return { kind: "completed", mode: installed.mode, evidence, resumed: false };
}

function matchesTelegramInputCustodyActivationEvidence(
  evidence: TelegramInputCustodyActivationEvidenceIdentity | undefined,
  expected: TelegramInputCustodyActivationEvidenceIdentity,
): boolean {
  return Boolean(evidence && evidence.profileKey === expected.profileKey &&
    evidence.recoveryKey === expected.recoveryKey);
}

export type TelegramInputCustodyMigrationCompletionResult =
  | { kind: "blocked"; blocker: "migration-authority" | "source-drift" |
      "inventory-drift" }
  | { kind: "completed"; evidence: TelegramInputCustodyMigrationEvidence;
      resumed: boolean };

export function executeTelegramInputCustodyMigrationCompletion(input: {
  expected: TelegramInputCustodyActivationEvidenceIdentity;
  authority: TelegramInputCustodyMigrationCompletionAuthority;
  migrationInventorySha256: string;
  inspectSource(): "absent" | "v3" | "legacy" | "unsupported" | "ambiguous";
  evidenceStore: {
    read(): TelegramInputCustodyReadinessEvidenceSnapshot;
    publish(input: { expectedRevision: number; kind: "migration";
      evidence: TelegramInputCustodyMigrationEvidence }):
        TelegramInputCustodyReadinessEvidenceSnapshot;
  };
}): TelegramInputCustodyMigrationCompletionResult {
  const matchesAuthority = (candidate: TelegramInputCustodyMigrationCompletionAuthority |
    undefined) => Boolean(candidate && candidate.version === 1 && candidate.status === "authorized" &&
      candidate.profileKey === input.expected.profileKey &&
      candidate.recoveryKey === input.expected.recoveryKey &&
      candidate.authorityId === input.authority.authorityId &&
      candidate.startupAuthorityId === input.authority.startupAuthorityId &&
      candidate.closureOperationId === input.authority.closureOperationId &&
      candidate.migrationInventorySha256 === input.authority.migrationInventorySha256 &&
      candidate.resultingSourceFamily === input.authority.resultingSourceFamily &&
      candidate.authorizedAtMs === input.authority.authorizedAtMs);
  const current = input.evidenceStore.read();
  if (!matchesAuthority(current.migrationCompletion))
    return { kind: "blocked", blocker: "migration-authority" };
  if (input.migrationInventorySha256 !== input.authority.migrationInventorySha256)
    return { kind: "blocked", blocker: "inventory-drift" };
  let source: ReturnType<typeof input.inspectSource>;
  try { source = input.inspectSource(); } catch { source = "ambiguous"; }
  if (source !== input.authority.resultingSourceFamily)
    return { kind: "blocked", blocker: "source-drift" };
  const evidence: TelegramInputCustodyMigrationEvidence = { version: 1,
    status: "complete", ...input.expected,
    migrationAuthorityId: input.authority.authorityId,
    startupAuthorityId: input.authority.startupAuthorityId,
    closureOperationId: input.authority.closureOperationId,
    migrationInventorySha256: input.authority.migrationInventorySha256,
    resultingSourceFamily: input.authority.resultingSourceFamily };
  const existing = current.migration;
  if (existing?.status === "complete" && existing.profileKey === evidence.profileKey &&
      existing.recoveryKey === evidence.recoveryKey &&
      existing.migrationAuthorityId === evidence.migrationAuthorityId &&
      existing.startupAuthorityId === evidence.startupAuthorityId &&
      existing.closureOperationId === evidence.closureOperationId &&
      existing.migrationInventorySha256 === evidence.migrationInventorySha256 &&
      existing.resultingSourceFamily === evidence.resultingSourceFamily)
    return { kind: "completed", evidence: existing, resumed: true };
  input.evidenceStore.publish({ expectedRevision: current.revision, kind: "migration", evidence });
  return { kind: "completed", evidence, resumed: false };
}

export interface TelegramInputCustodyWriterProtocolModeEvidence
  extends TelegramInputCustodyActivationEvidenceIdentity {
  protocol: "custody-v3";
  startupAuthorityId: string;
  closureOperationId: string;
  writerInventorySha256: string;
}

export function createTelegramInputCustodyProvenReadinessResolver(deps: {
  isRequested(): boolean;
  expectedIdentity(): TelegramInputCustodyActivationEvidenceIdentity;
  inspectSource(): "absent" | "v3" | "legacy" | "unsupported" | "ambiguous";
  readWriterExclusionEvidence(): TelegramInputCustodyWriterExclusionEvidence | undefined;
  readStartupExclusionAuthority(): TelegramInputCustodyStartupExclusionAuthority | undefined;
  readWriterProtocolMode(): TelegramInputCustodyWriterProtocolModeEvidence | undefined;
  readMigrationCompletionAuthority(): TelegramInputCustodyMigrationCompletionAuthority | undefined;
  readMigrationEvidence(): TelegramInputCustodyMigrationEvidence | undefined;
  listPeerReadiness(): readonly ("ready" | "legacy" | "unknown")[];
}): () => ReturnType<typeof evaluateTelegramInputCustodyActivationReadiness> {
  return createTelegramInputCustodyActivationReadinessResolver({
    isRequested: deps.isRequested,
    inspectSource() {
      let source: "absent" | "v3" | "legacy" | "unsupported" | "ambiguous";
      try { source = deps.inspectSource(); } catch { return "ambiguous"; }
      const expected = deps.expectedIdentity();
      const authority = deps.readMigrationCompletionAuthority();
      return matchesTelegramInputCustodyActivationEvidence(authority, expected) &&
        authority?.status === "authorized" && authority.resultingSourceFamily === source
        ? source : "ambiguous";
    },
    areLegacyWritersExcluded() {
      const expected = deps.expectedIdentity();
      const evidence = deps.readWriterExclusionEvidence();
      const authority = deps.readStartupExclusionAuthority();
      const mode = deps.readWriterProtocolMode();
      return matchesTelegramInputCustodyActivationEvidence(evidence, expected) &&
        matchesTelegramInputCustodyActivationEvidence(authority, expected) &&
        matchesTelegramInputCustodyActivationEvidence(mode, expected) &&
        evidence?.version === 1 && evidence.status === "excluded" &&
        authority?.version === 1 && authority.status === "enforced" &&
        mode?.protocol === "custody-v3" &&
        evidence.startupAuthorityId === authority.authorityId &&
        evidence.startupAuthorityId === mode.startupAuthorityId &&
        evidence.closureOperationId === authority.closureOperationId &&
        evidence.closureOperationId === mode.closureOperationId &&
        evidence.writerInventorySha256 === authority.writerInventorySha256 &&
        evidence.writerInventorySha256 === mode.writerInventorySha256;
    },
    isHistoricalMigrationComplete() {
      const expected = deps.expectedIdentity();
      const evidence = deps.readMigrationEvidence();
      const authority = deps.readMigrationCompletionAuthority();
      const startup = deps.readStartupExclusionAuthority();
      const mode = deps.readWriterProtocolMode();
      let source: "absent" | "v3" | "legacy" | "unsupported" | "ambiguous";
      try { source = deps.inspectSource(); } catch { source = "ambiguous"; }
      return matchesTelegramInputCustodyActivationEvidence(evidence, expected) &&
        matchesTelegramInputCustodyActivationEvidence(authority, expected) &&
        evidence?.version === 1 && evidence.status === "complete" &&
        authority?.version === 1 && authority.status === "authorized" &&
        authority.resultingSourceFamily === source &&
        evidence.migrationAuthorityId === authority.authorityId &&
        evidence.startupAuthorityId === authority.startupAuthorityId &&
        evidence.startupAuthorityId === startup?.authorityId &&
        evidence.startupAuthorityId === mode?.startupAuthorityId &&
        evidence.closureOperationId === authority.closureOperationId &&
        evidence.closureOperationId === mode?.closureOperationId &&
        evidence.migrationInventorySha256 === authority.migrationInventorySha256 &&
        evidence.resultingSourceFamily === authority.resultingSourceFamily;
    },
    listPeerReadiness: deps.listPeerReadiness,
  });
}

export function createTelegramInputCustodyActivationReadinessResolver(deps: {
  isRequested(): boolean;
  inspectSource(): "absent" | "v3" | "legacy" | "unsupported" | "ambiguous";
  areLegacyWritersExcluded(): boolean;
  isHistoricalMigrationComplete(): boolean;
  listPeerReadiness(): readonly ("ready" | "legacy" | "unknown")[];
}): () => ReturnType<typeof evaluateTelegramInputCustodyActivationReadiness> {
  return () => {
    const requested = deps.isRequested();
    if (!requested) return { enabled: false, blocker: "disabled" };
    let legacyWritersExcluded = false;
    try { legacyWritersExcluded = deps.areLegacyWritersExcluded(); } catch { /* blocked */ }
    if (!legacyWritersExcluded) return { enabled: false, blocker: "legacy-writers-present" };
    let historicalMigrationComplete = false;
    try { historicalMigrationComplete = deps.isHistoricalMigrationComplete(); } catch { /* blocked */ }
    if (!historicalMigrationComplete) return { enabled: false, blocker: "migration-incomplete" };
    let sourceStatus: "absent" | "v3" | "legacy" | "unsupported" | "ambiguous";
    try { sourceStatus = deps.inspectSource(); } catch { sourceStatus = "ambiguous"; }
    if (sourceStatus !== "absent" && sourceStatus !== "v3")
      return { enabled: false, blocker: "source-unready" };
    let peerReadiness: readonly ("ready" | "legacy" | "unknown")[];
    try { peerReadiness = deps.listPeerReadiness(); } catch { peerReadiness = ["unknown"]; }
    return evaluateTelegramInputCustodyActivationReadiness({ requested,
      sourceStatus, legacyWritersExcluded, historicalMigrationComplete, peerReadiness });
  };
}

export function createTelegramInputCustodyLifecycleBindingResolver(deps: {
  isEnabled(): boolean;
  resolveInputJournal(): { runtimeKey: string; recoveryKey: string;
    journal: TelegramInputJournalStore } | undefined;
  getRecipientBindingKey(): string | undefined;
}): () => TelegramUpdateAdmissionLifecycleJournalBinding | undefined {
  return () => {
    if (!deps.isEnabled()) return undefined;
    const source = deps.resolveInputJournal();
    const recipientBindingKey = deps.getRecipientBindingKey()?.trim();
    if (!source || !source.runtimeKey || !source.recoveryKey || !recipientBindingKey)
      return undefined;
    const port = createTelegramInputCustodyWorkerJournalPort(source.journal);
    return { runtimeKey: JSON.stringify({ source: source.runtimeKey, recipientBindingKey }),
      recoveryKey: source.recoveryKey,
      recipientBindingKey, journal: { ...port, appendBatch: source.journal.appendBatch,
        discardQueued: source.journal.discardQueued,
        recoverDeadQueueOwner: source.journal.recoverDeadQueueOwner,
        offerQueuedHandoff: source.journal.offerQueuedHandoff,
        acceptQueuedHandoff: source.journal.acceptQueuedHandoff,
        cancelQueuedHandoff: source.journal.cancelQueuedHandoff } };
  };
}

export function createTelegramCustodiedExecutionSession(input: {
  journal: TelegramCustodyExecutionJournal;
  recipientBindingKey: string;
}): {
  execute(update: TelegramJournaledUpdate,
    handler: (update: TelegramJournaledUpdate) => Promise<TelegramUpdateAdmissionOutcome>):
    Promise<TelegramCustodiedExecutionResult>;
  settle(updateId: number, outcome: TelegramUpdateAdmissionOutcome):
    Promise<TelegramCustodiedExecutionResult>;
} {
  const receipts = new Map<number, TelegramInputJournalReceipt>();
  const settledQueues = new Map<number, Extract<TelegramCustodiedExecutionResult,
    { status: "queued" }>>();
  const settle = async (updateId: number, outcome: TelegramUpdateAdmissionOutcome):
    Promise<TelegramCustodiedExecutionResult> => {
    const receipt = receipts.get(updateId);
    if (!receipt) {
      const duplicate = settledQueues.get(updateId);
      if (duplicate && outcome.kind === "queued" &&
          duplicate.queueReceipt.queueKind === outcome.queueKind &&
          duplicate.queueReceipt.receiptId === outcome.receiptId &&
          duplicate.queueReceipt.sourceUpdateIds.length === outcome.sourceUpdateIds.length &&
          duplicate.queueReceipt.sourceUpdateIds.every((id, index) => id === outcome.sourceUpdateIds[index]))
        { settledQueues.delete(updateId); return duplicate; }
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
      const grouped = outcome.sourceUpdateIds.map(sourceUpdateId => receipts.get(sourceUpdateId));
      if (grouped.some(candidate => !candidate)) throw new TelegramUpdateAdmissionOutcomeError(
        "Telegram grouped queue custody omitted an exact running source receipt.",
      );
      const queued = input.journal.queueInputs({ queueKind: outcome.queueKind,
        receiptId: outcome.receiptId, receipts: grouped as TelegramInputJournalReceipt[] });
      const result = { status: "queued" as const, queueReceipt: queued.queueReceipt };
      for (const sourceUpdateId of outcome.sourceUpdateIds) {
        receipts.delete(sourceUpdateId);
        if (sourceUpdateId !== updateId) settledQueues.set(sourceUpdateId, result);
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
      const acquired = input.journal.acquireInput({ updateId: update.update_id,
        recipientBindingKey: input.recipientBindingKey, executionUpdate: update });
      const started = input.journal.startInput(acquired.receipt);
      if (!started.started) return { status: "outcome-unknown", receipt: acquired.receipt };
      receipts.set(update.update_id, acquired.receipt);
      let outcome: TelegramUpdateAdmissionOutcome;
      try { outcome = await handler(started.update); }
      catch (error) { receipts.delete(update.update_id); throw error; }
      return settle(update.update_id, outcome);
    },
  };
}

export async function executeTelegramCustodiedInput(input: {
  journal: TelegramCustodyExecutionJournal;
  update: TelegramJournaledUpdate;
  recipientBindingKey: string;
  execute(update: TelegramJournaledUpdate): Promise<TelegramUpdateAdmissionOutcome>;
}): Promise<TelegramCustodiedExecutionResult> {
  return createTelegramCustodiedExecutionSession(input).execute(input.update, input.execute);
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
  const registry = deps.registry ?? getOrCreateUpdateHandlerRegistry();
  let nextExecutionGeneration = 0;
  return async (update, ctx, signal) => {
    const generation = ++nextExecutionGeneration;
    const execution: TelegramUpdateExecutionFence = {
      generation,
      updateId: update.update_id,
      signal,
      isCurrent: () => !signal.aborted,
      assertCurrent() {
        if (signal.aborted) {
          throw signal.reason ?? new DOMException("Aborted", "AbortError");
        }
      },
    };
    execution.assertCurrent();
    const verdict = await registry.dispatch(update, execution);
    execution.assertCurrent();
    if (verdict === "consume") return { kind: "complete" };
    let immediate = true;
    let outcome: TelegramUpdateAdmissionOutcome | undefined;
    const boundUpdate = bindTelegramUpdateExecutionFence(
      bindTelegramUpdateAdmissionSource(update, (next) => {
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
        void Promise.resolve()
          .then(() =>
            deps.onLateOutcome!(next, {
              updateId: update.update_id,
              ctx,
              signal,
            }),
          )
          .catch((error) => {
            try {
              deps.onLateOutcomeError?.(error, update.update_id);
            } catch {
              // Diagnostic sinks must not create an unhandled late Promise.
            }
          });
      }),
      execution,
    );
    try {
      execution.assertCurrent();
      await deps.defaultHandle(boundUpdate, ctx, execution);
    } finally {
      immediate = false;
    }
    return outcome ?? { kind: "complete" };
  };
}

export function createTelegramCustodiedUpdateAdmissionHandle<
  TUpdate extends TelegramJournaledUpdate & TelegramUpdateFlow,
  TContext,
>(deps: Omit<TelegramUpdateAdmissionHandleDeps<TUpdate, TContext>,
  "onLateOutcome" | "onLateOutcomeError"> & {
  journal: TelegramCustodyExecutionJournal;
  recipientBindingKey: string;
  onLateOutcomeError(error: unknown, updateId: number): void;
  onCustodiedLateSettlement?: (result: TelegramCustodiedExecutionResult,
    details: { updateId: number; signal: AbortSignal }) => void;
}): (update: TUpdate, ctx: TContext, signal: AbortSignal) =>
  Promise<TelegramCustodiedExecutionResult> {
  const session = createTelegramCustodiedExecutionSession({ journal: deps.journal,
    recipientBindingKey: deps.recipientBindingKey });
  const admission = createTelegramUpdateAdmissionHandle({
    defaultHandle: deps.defaultHandle,
    registry: deps.registry,
    async onLateOutcome(outcome, details) {
      const result = await session.settle(details.updateId, outcome);
      deps.onCustodiedLateSettlement?.(result,
        { updateId: details.updateId, signal: details.signal });
    },
    onLateOutcomeError: deps.onLateOutcomeError,
  });
  return (update, ctx, signal) => session.execute(update,
    started => admission(started as TUpdate, ctx, signal));
}

export interface TelegramQueueAdmissionItemLike {
  admissionReceipts?: readonly TelegramQueueAdmissionReceiptLike[];
}

export interface TelegramQueueAdmissionSettlementRuntime<TContext> {
  isItemReady: (item: TelegramQueueAdmissionItemLike) => boolean;
  getQueueReceiptOwner: (
    receipt: TelegramQueueAdmissionReceiptLike,
  ) => TelegramUpdateJournalQueueOwner | undefined;
  onPromptHandedOff: (
    item: TelegramQueueAdmissionItemLike,
    ctx: TContext,
  ) => void;
  onControlSettled: (
    item: TelegramQueueAdmissionItemLike,
    ctx: TContext,
  ) => void;
  onItemsDiscarded: (
    items: readonly TelegramQueueAdmissionItemLike[],
    ctx: TContext,
  ) => void;
}

export function createTelegramQueueAdmissionSettlementMuxRuntime<TContext>(
  runtimes: readonly TelegramQueueAdmissionSettlementRuntime<TContext>[],
): TelegramQueueAdmissionSettlementRuntime<TContext> {
  const settle = (
    operation: (
      runtime: TelegramQueueAdmissionSettlementRuntime<TContext>,
    ) => void,
  ): void => {
    for (const runtime of runtimes) operation(runtime);
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
    onPromptHandedOff: (item, ctx) =>
      settle((runtime) => runtime.onPromptHandedOff(item, ctx)),
    onControlSettled: (item, ctx) =>
      settle((runtime) => runtime.onControlSettled(item, ctx)),
    onItemsDiscarded: (items, ctx) =>
      settle((runtime) => runtime.onItemsDiscarded(items, ctx)),
  };
}

export function createTelegramQueueAdmissionSettlementRuntime<TContext>(
  worker: TelegramUpdateWorkerRuntime<TContext>,
): TelegramQueueAdmissionSettlementRuntime<TContext> {
  const complete = (
    items: readonly TelegramQueueAdmissionItemLike[],
    ctx: TContext,
    reason: TelegramQueueReceiptCompletionReason,
  ): void => {
    const receipts: TelegramQueueAdmissionReceiptLike[] = [];
    for (const item of items) {
      if (item.admissionReceipts) receipts.push(...item.admissionReceipts);
    }
    worker.completeQueueReceipts({ receipts, ctx, reason });
  };
  return {
    isItemReady: (item) =>
      (item.admissionReceipts ?? []).every(
        worker.isQueueReceiptCommitted,
      ),
    getQueueReceiptOwner: worker.getQueueReceiptOwner,
    onPromptHandedOff: (item, ctx) =>
      complete([item], ctx, "prompt-handoff"),
    onControlSettled: (item, ctx) =>
      complete([item], ctx, "control-settlement"),
    onItemsDiscarded: (items, ctx) =>
      complete(items, ctx, "discard"),
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
  envelope: Extract<
    TelegramBusEnvelope,
    { kind: "leader.offerQueueHandoff" }
  >,
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
      throw new Error(
        "Telegram queue handoff journal binding is not active.",
      );
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
  removeDonorItem: (
    receipt: TelegramQueueAdmissionReceipt,
    ctx: TContext,
  ) => boolean;
  recordFailure?: (
    error: unknown,
    details: Record<string, unknown>,
  ) => void;
}

export interface TelegramQueueHandoffReconciliationRuntimeAssemblyDeps<
  TContext,
> {
  ownsDirect: () => boolean;
  isFollowerRegistered: () => boolean;
  isBusEnabled: () => boolean;
  canHandoffWithLeader?: () => boolean;
  listFollowers: () => readonly TelegramBusFollowerView[];
  createRecipientJournalResolver: (
    profileKey: string,
  ) => (() => { recoveryKey: string } | undefined);
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
    ownsDirect: deps.ownsDirect,
    isFollowerRegistered: deps.isFollowerRegistered,
    isBusEnabled: deps.isBusEnabled,
    canHandoffWithLeader: deps.canHandoffWithLeader,
    listFollowers: deps.listFollowers,
    createRecipientJournalBindingKey(recipient) {
      if (!recipient.profileKey) return undefined;
      return deps.createRecipientJournalResolver(recipient.profileKey)()
        ?.recoveryKey;
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
    const followers = deps.listFollowers().filter(
      (follower) => follower.instanceId !== deps.donorInstanceId,
    );
    if (followers.length === 0) return;
    for (const item of [...deps.getQueuedItems()]) {
      const target = item.target;
      const recipient = target
        ? followers.find(
            (candidate) =>
              candidate.target?.chatId === target.chatId &&
              candidate.target?.threadId === target.threadId,
          )
        : undefined;
      if (!recipient) continue;
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
      const recipientItem = structuredClone(item);
      recipientItem.admissionReceipts = [
        { ...receipt, journalBindingKey: recipientJournalBindingKey },
      ];
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
        expectedOwner,
        recipientOwner: {
          instanceId: recipient.instanceId,
          processId: recipient.pid,
          processBirthId: recipient.processBirthId,
          sessionGeneration: recipient.sessionGeneration,
        },
        handoffToken,
        lifecycle,
        stageRemote: async () => {
          const payload = createTelegramQueueHandoff({
            handoffToken,
            item: recipientItem,
          }).payload;
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
            recipientRegistrationGeneration:
              recipient.registrationGeneration!,
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
                ? response.message ?? "Telegram queue handoff was rejected."
                : "Telegram queue handoff returned no acknowledgement.",
            );
          }
          return {
            ...(response.result as Omit<TelegramQueueHandoffStageResult, "queueOwner">),
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
    | TelegramUpdateAdmissionLifecycleJournalBinding
    | undefined;
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
  recordRuntimeEvent?: TelegramUpdateWorkerRuntimeDeps<TContext>["recordRuntimeEvent"];
}

export interface TelegramUpdateAdmissionLifecycleRuntime<TContext>
  extends TelegramQueueAdmissionSettlementRuntime<TContext> {
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
    onQueueReceiptCommitted(_receipt, ctx) {
      if (!deps.isContextCurrent(ctx)) return;
      deps.dispatchNext(ctx);
      deps.requestQueueHandoffReconciliation(ctx);
    },
    onUpdateCompleted(_updateId, ctx) {
      if (deps.isContextCurrent(ctx)) deps.dispatchNext(ctx);
    },
  };
}

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
  let inputCustodyBus: TelegramInputCustodyBusBindingRuntime<TContext> | undefined;
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
    getActive: () => (deps.isFollowerRegistered() ? follower : leader),
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
  let journal: TelegramUpdateAdmissionLifecycleJournalBinding["journal"] | undefined;
  let worker: TelegramUpdateWorkerRuntime<TContext> | undefined;
  let settlement: TelegramQueueAdmissionSettlementRuntime<TContext> | undefined;
  let journalBindingKey: string | undefined;
  let operation: Promise<void> = Promise.resolve();
  let foreignQueueOwnerLiveness: TelegramProcessLiveness | undefined;
  let releaseSourceReference: (() => void) | undefined;

  const stopCurrent = async (forget: boolean): Promise<void> => {
    await worker?.stop();
    const release = releaseSourceReference;
    releaseSourceReference = undefined;
    try { release?.(); } catch (error) {
      deps.recordRuntimeEvent?.("inbound-worker", error,
        { phase: "source-reference-release" });
    }
    if (!forget) return;
    journal = undefined;
    worker = undefined;
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
    if (replace || !worker || activeRuntimeKey !== binding.runtimeKey) {
      const { runtimeKey, recoveryKey } = binding;
      await stopCurrent(true);
      binding = deps.resolveBinding();
      if (!binding || binding.runtimeKey !== runtimeKey ||
          binding.recoveryKey !== recoveryKey) {
        throw new Error("Telegram update source binding changed during startup.");
      }
      const release = deps.acquireSourceReference?.(binding);
      try {
        journal = binding.journal;
        worker = deps.createWorker(binding.journal, binding);
        settlement = createTelegramQueueAdmissionSettlementRuntime(worker);
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
      const result = journal.cancelQueuedHandoff(input);
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
    getJournalEntryCount() {
      if (!journal || !worker) {
        throw new Error("Telegram update admission worker is not active.");
      }
      return journal.read().entries.length;
    },
    hasPendingQueueMutationForItem(item) {
      return Boolean(
        journal &&
          worker &&
          journal
            .read()
            .entries.some(
              (entry) =>
                entry.state !== "queued" &&
                isTelegramReactionDependencyForQueueItem(
                  entry.update,
                  item,
                ),
            ),
      );
    },
    signal: () => worker?.signal(),
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
      settlement?.onPromptHandedOff(item, ctx),
    onControlSettled: (item, ctx) =>
      settlement?.onControlSettled(item, ctx),
    onItemsDiscarded: (items, ctx) =>
      settlement?.onItemsDiscarded(items, ctx),
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
  acquireSourceReference?: (role: "leader" | "follower",
    binding: TelegramUpdateAdmissionLifecycleJournalBinding) => () => void;
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
      | TelegramUpdateAdmissionLifecycleJournalBinding
      | undefined;
    hasAuthority: (ctx: TContext) => boolean;
  };
  follower: {
    resolveBinding: () =>
      | TelegramUpdateAdmissionLifecycleJournalBinding
      | undefined;
    isRegistered: () => boolean;
    getGeneration: () => string | undefined;
    prepareUpdateForExecution: (update: TUpdate) => TUpdate;
  };
  recordRuntimeEvent?: TelegramUpdateWorkerRuntimeDeps<TContext>["recordRuntimeEvent"];
}

export type TelegramUpdateAdmissionWorkerRuntimeDeps<
  TUpdate extends TelegramJournaledUpdate & TelegramUpdateFlow,
  TContext,
> = Omit<TelegramUpdateWorkerRuntimeDeps<TContext>,
  "executeUpdate" | "executeCustodiedUpdate"> & {
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
  const executeUpdate = createTelegramUpdateAdmissionHandle<TUpdate, TContext>({
    defaultHandle: deps.defaultHandle,
    registry: deps.registry,
    onLateOutcome(outcome, details) {
      worker?.settleDeferred({
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
  });
  const custodyBindingKey = deps.inputCustody ? deps.getRecipientBindingKey?.() : undefined;
  if (deps.inputCustody && !custodyBindingKey) throw new Error(
    "Telegram custodied admission worker requires one recipient binding key.",
  );
  const executeCustodiedUpdate = deps.inputCustody && custodyBindingKey
    ? createTelegramCustodiedUpdateAdmissionHandle<TUpdate, TContext>({
      journal: deps.inputCustody, recipientBindingKey: custodyBindingKey,
      defaultHandle: deps.defaultHandle, registry: deps.registry,
      onLateOutcomeError(error, updateId) {
        deps.recordRuntimeEvent?.("inbound-worker", error,
          { phase: "late-custodied-admission-handler", updateId });
      },
      onCustodiedLateSettlement(result, details) {
        worker?.settleCustodied({ updateId: details.updateId, result, signal: details.signal });
      },
    }) : undefined;
  worker = createTelegramUpdateWorkerRuntime({
    ...deps,
    ...(executeCustodiedUpdate ? { executeCustodiedUpdate: async (update: TelegramJournaledUpdate,
      ctx: TContext, signal: AbortSignal) => executeCustodiedUpdate(
        deps.prepareUpdateForExecution?.(update as TUpdate) ?? update as TUpdate, ctx, signal) } : {}),
    async executeUpdate(update, ctx, signal) {
      const typedUpdate = update as TUpdate;
      try {
        return await executeUpdate(
          deps.prepareUpdateForExecution?.(typedUpdate) ?? typedUpdate,
          ctx,
          signal,
        );
      } catch (error) {
        if (await deps.settleTerminalExecutionFailure?.(error)) {
          return { kind: "complete" };
        }
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
    ...(deps.acquireSourceReference ? { acquireSourceReference: binding =>
      deps.acquireSourceReference!("leader", binding) } : {}),
    getQueueOwnerIdentity: deps.worker.getQueueOwnerIdentity,
    createWorker(journal, binding) {
      return createTelegramUpdateAdmissionWorkerRuntime({
        ...deps.worker,
        journal,
        ...(binding.journal.inputCustody ? { inputCustody: binding.journal.inputCustody } : {}),
        getJournalBindingKey: () => binding.recoveryKey,
        getRecipientBindingKey: () => binding.recipientBindingKey,
        hasAuthority: deps.leader.hasAuthority,
      });
    },
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
  const follower = createTelegramUpdateAdmissionLifecycleRuntime({
    getQueueOwnerIdentity: deps.worker.getQueueOwnerIdentity,
    ...(deps.acquireSourceReference ? { acquireSourceReference: binding =>
      deps.acquireSourceReference!("follower", binding) } : {}),
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
        ...(binding.journal.inputCustody ? { inputCustody: binding.journal.inputCustody } : {}),
        getJournalBindingKey: () => binding.recoveryKey,
        getRecipientBindingKey: () => binding.recipientBindingKey,
        hasAuthority: () => binding.hasAuthority?.() ?? false,
        prepareUpdateForExecution: deps.follower.prepareUpdateForExecution,
      });
    },
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
  deps.runtimeBinding.bind({ leader, follower,
    ...(deps.inputCustodyBus ? { inputCustodyBus: deps.inputCustodyBus } : {}) });
  return { leader, follower };
}

export interface TelegramUpdateAdmissionRuntimeAssembly<TContext>
  extends TelegramUpdateAdmissionLifecycleAssembly<TContext> {
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
