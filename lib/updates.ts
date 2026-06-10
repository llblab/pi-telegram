/**
 * Telegram updates domain helpers
 * Zones: telegram inbound, authorization, routing plans
 * Owns update extraction, authorization, classification, execution planning, runtime execution, and the public update-handler registry
 */

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
  return new Set(
    reactions
      .filter(
        (reaction): reaction is TelegramReactionTypeEmoji =>
          reaction.type === "emoji",
      )
      .map((reaction) => normalizeTelegramReactionEmoji(reaction.emoji)),
  );
}

function hasAnyTelegramReactionEmoji(
  emojis: Set<string>,
  candidates: readonly string[],
): boolean {
  return candidates.some((emoji) => emojis.has(emoji));
}

function getAddedTelegramReactionEmoji(
  oldEmojis: Set<string>,
  newEmojis: Set<string>,
  candidates: readonly string[],
): string | undefined {
  return candidates.find(
    (emoji) => !oldEmojis.has(emoji) && newEmojis.has(emoji),
  );
}
function hasAddedTelegramReactionEmoji(
  oldEmojis: Set<string>,
  newEmojis: Set<string>,
  candidates: readonly string[],
): boolean {
  return !!getAddedTelegramReactionEmoji(oldEmojis, newEmojis, candidates);
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

export interface TelegramUpdateRouting {
  message?: TelegramUpdateMessage;
  edited_message?: TelegramUpdateMessage;
  callback_query?: TelegramCallbackQuery;
  guest_message?: TelegramGuestMessage;
}

export function getAuthorizedTelegramCallbackQuery(
  update: TelegramUpdateRouting,
): TelegramCallbackQuery | undefined {
  const query = update.callback_query;
  if (!query) return undefined;
  const message = query.message;
  if (!message || message.chat.type !== "private" || query.from.is_bot) {
    return undefined;
  }
  return query;
}

export function getAuthorizedTelegramMessage(
  update: TelegramUpdateRouting,
): TelegramUpdateMessage | undefined {
  const message = update.message;
  if (
    !message ||
    message.chat.type !== "private" ||
    !message.from ||
    message.from.is_bot
  ) {
    return undefined;
  }
  return message;
}

export function getAuthorizedTelegramEditedMessage(
  update: TelegramUpdateRouting,
): TelegramUpdateMessage | undefined {
  const message = update.edited_message;
  if (
    !message ||
    message.chat.type !== "private" ||
    !message.from ||
    message.from.is_bot
  ) {
    return undefined;
  }
  return message;
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

export interface TelegramMessageReactionUpdated {
  chat: { type: string };
  user?: TelegramUser;
  message_id: number;
  old_reaction: TelegramReactionType[];
  new_reaction: TelegramReactionType[];
}

export interface TelegramUpdateFlow
  extends TelegramUpdateRouting, TelegramUpdateDeletion {
  message_reaction?: TelegramMessageReactionUpdated;
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
  const query = getAuthorizedTelegramCallbackQuery(update);
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
  const message = getAuthorizedTelegramMessage(update);
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
  const editedMessage = getAuthorizedTelegramEditedMessage(update);
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

export interface TelegramUpdateRuntimeDeps<
  TContext = unknown,
  TReactionUpdate extends TelegramMessageReactionUpdated =
    TelegramMessageReactionUpdated,
  TCallbackQuery extends TelegramCallbackQuery = TelegramCallbackQuery,
  TMessage extends TelegramUpdateMessage = TelegramUpdateMessage,
> {
  ctx: TContext;
  removePendingMediaGroupMessages: (messageIds: number[]) => void;
  removeQueuedTelegramTurnsByMessageIds: (
    messageIds: number[],
    ctx: TContext,
  ) => number;
  handleAuthorizedTelegramReactionUpdate: (
    reactionUpdate: TReactionUpdate,
    ctx: TContext,
  ) => Promise<void>;
  pairTelegramUserIfNeeded: (userId: number, ctx: TContext) => Promise<boolean>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  answerGuestQuery: (guestQueryId: string, text?: string) => Promise<void>;
  handleAuthorizedTelegramCallbackQuery: (
    query: TCallbackQuery,
    ctx: TContext,
  ) => Promise<void>;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number,
    text: string,
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
}

export interface TelegramUpdateRuntimeControllerDeps<
  TContext = unknown,
  TCallbackQuery extends TelegramCallbackQuery = TelegramCallbackQuery,
  TMessage extends TelegramUpdateMessage = TelegramUpdateMessage,
> {
  getAllowedUserId: () => number | undefined;
  removePendingMediaGroupMessages: (messageIds: number[]) => void;
  removeQueuedTelegramTurnsByMessageIds: (
    messageIds: number[],
    ctx: TContext,
  ) => number;
  clearQueuedTelegramTurnPriorityByMessageId: (
    messageId: number,
    ctx: TContext,
  ) => boolean;
  prioritizeQueuedTelegramTurnByMessageId: (
    messageId: number,
    ctx: TContext,
    priorityEmoji?: string,
  ) => boolean;
  pairTelegramUserIfNeeded: (userId: number, ctx: TContext) => Promise<boolean>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  answerGuestQuery: (guestQueryId: string, text?: string) => Promise<void>;
  handleAuthorizedTelegramCallbackQuery: (
    query: TCallbackQuery,
    ctx: TContext,
  ) => Promise<void>;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number,
    text: string,
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
}

export interface TelegramUpdateRuntimeController<
  TContext = unknown,
  TUpdate extends TelegramUpdateFlow = TelegramUpdateFlow,
> {
  handleAuthorizedReactionUpdate: (
    reactionUpdate: NonNullable<TUpdate["message_reaction"]>,
    ctx: TContext,
  ) => Promise<void>;
  handleUpdate: (update: TUpdate, ctx: TContext) => Promise<void>;
}

function getTelegramCallbackQueryId(
  query: TelegramCallbackQuery,
): string | undefined {
  return typeof query.id === "string" ? query.id : undefined;
}

function getTelegramMessageReplyTarget(
  message: TelegramUpdateMessage,
): { chatId: number; messageId: number } | undefined {
  if (
    typeof message.chat.id !== "number" ||
    typeof message.message_id !== "number"
  ) {
    return undefined;
  }
  return {
    chatId: message.chat.id,
    messageId: message.message_id,
  };
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
  await executeTelegramUpdatePlan(
    buildTelegramUpdateExecutionPlanFromUpdate(update, allowedUserId),
    deps,
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
    removePendingMediaGroupMessages: deps.removePendingMediaGroupMessages,
    removeQueuedTelegramTurnsByMessageIds:
      deps.removeQueuedTelegramTurnsByMessageIds,
    clearQueuedTelegramTurnPriorityByMessageId:
      deps.clearQueuedTelegramTurnPriorityByMessageId,
    prioritizeQueuedTelegramTurnByMessageId:
      deps.prioritizeQueuedTelegramTurnByMessageId,
    pairTelegramUserIfNeeded: createTelegramUserPairingRuntime({
      getAllowedUserId: deps.getAllowedUserId,
      setAllowedUserId: deps.setAllowedUserId,
      persistConfig: deps.persistConfig,
      updateStatus: deps.updateStatus,
    }).pairIfNeeded,
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
      removePendingMediaGroupMessages: deps.removePendingMediaGroupMessages,
      removeQueuedTelegramTurnsByMessageIds:
        deps.removeQueuedTelegramTurnsByMessageIds,
      clearQueuedTelegramTurnPriorityByMessageId:
        deps.clearQueuedTelegramTurnPriorityByMessageId,
      prioritizeQueuedTelegramTurnByMessageId:
        deps.prioritizeQueuedTelegramTurnByMessageId,
    });
  };
  return {
    handleAuthorizedReactionUpdate,
    handleUpdate: (update, ctx) =>
      executeTelegramUpdate(update, deps.getAllowedUserId(), {
        ctx,
        removePendingMediaGroupMessages: deps.removePendingMediaGroupMessages,
        removeQueuedTelegramTurnsByMessageIds:
          deps.removeQueuedTelegramTurnsByMessageIds,
        handleAuthorizedTelegramReactionUpdate: handleAuthorizedReactionUpdate,
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
      }),
  };
}

export interface AuthorizedTelegramReactionUpdateDeps<TContext> {
  allowedUserId?: number;
  ctx: TContext;
  removePendingMediaGroupMessages: (messageIds: number[]) => void;
  removeQueuedTelegramTurnsByMessageIds: (
    messageIds: number[],
    ctx: TContext,
  ) => number;
  clearQueuedTelegramTurnPriorityByMessageId: (
    messageId: number,
    ctx: TContext,
  ) => boolean;
  prioritizeQueuedTelegramTurnByMessageId: (
    messageId: number,
    ctx: TContext,
    priorityEmoji?: string,
  ) => boolean;
}

export async function handleAuthorizedTelegramReactionUpdate<TContext>(
  reactionUpdate: TelegramMessageReactionUpdated,
  deps: AuthorizedTelegramReactionUpdateDeps<TContext>,
): Promise<void> {
  const reactionUser = reactionUpdate.user;
  if (
    reactionUpdate.chat.type !== "private" ||
    !reactionUser ||
    reactionUser.is_bot ||
    reactionUser.id !== deps.allowedUserId
  ) {
    return;
  }
  const oldEmojis = collectTelegramReactionEmojis(reactionUpdate.old_reaction);
  const newEmojis = collectTelegramReactionEmojis(reactionUpdate.new_reaction);
  if (
    hasAddedTelegramReactionEmoji(
      oldEmojis,
      newEmojis,
      TELEGRAM_REMOVAL_REACTION_EMOJIS,
    )
  ) {
    deps.removePendingMediaGroupMessages([reactionUpdate.message_id]);
    deps.removeQueuedTelegramTurnsByMessageIds(
      [reactionUpdate.message_id],
      deps.ctx,
    );
    return;
  }
  const hadPriorityReaction = hasAnyTelegramReactionEmoji(
    oldEmojis,
    TELEGRAM_PRIORITY_REACTION_EMOJIS,
  );
  const hasPriorityReaction = hasAnyTelegramReactionEmoji(
    newEmojis,
    TELEGRAM_PRIORITY_REACTION_EMOJIS,
  );
  if (hadPriorityReaction && !hasPriorityReaction) {
    deps.clearQueuedTelegramTurnPriorityByMessageId(
      reactionUpdate.message_id,
      deps.ctx,
    );
  }
  const addedPriorityEmoji = getAddedTelegramReactionEmoji(
    oldEmojis,
    newEmojis,
    TELEGRAM_PRIORITY_REACTION_EMOJIS,
  );
  if (!addedPriorityEmoji) return;
  deps.prioritizeQueuedTelegramTurnByMessageId(
    reactionUpdate.message_id,
    deps.ctx,
    addedPriorityEmoji,
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
    if (plan.kind === "ignore") return;
    if (plan.kind === "deleted") {
      deps.removePendingMediaGroupMessages(plan.messageIds);
      deps.removeQueuedTelegramTurnsByMessageIds(plan.messageIds, deps.ctx);
      return;
    }
    if (plan.kind === "reaction") {
      await deps.handleAuthorizedTelegramReactionUpdate(
        plan.reactionUpdate,
        deps.ctx,
      );
      return;
    }
    if (plan.kind === "callback") {
      if (plan.shouldPair) {
        await deps.pairTelegramUserIfNeeded(plan.query.from.id, deps.ctx);
      }
      if (plan.shouldDeny) {
        const callbackQueryId = getTelegramCallbackQueryId(plan.query);
        if (callbackQueryId) {
          await deps.answerCallbackQuery(
            callbackQueryId,
            "This bot is not authorized for your account.",
          );
        }
        return;
      }
      await deps.handleAuthorizedTelegramCallbackQuery(plan.query, deps.ctx);
      return;
    }
    if (plan.kind === "guest") {
      if (plan.shouldDeny) {
        await deps.answerGuestQuery(
          plan.guestMessage.guest_query_id,
          "Access denied.",
        );
        return;
      }
      if (deps.handleAuthorizedTelegramGuestMessage) {
        await deps.handleAuthorizedTelegramGuestMessage(
          plan.guestMessage,
          deps.ctx,
        );
      }
      return;
    }
    const pairedNow = plan.shouldPair
      ? await deps.pairTelegramUserIfNeeded(plan.message.from.id, deps.ctx)
      : false;
    const replyTarget = getTelegramMessageReplyTarget(plan.message);
    if (
      plan.kind === "message" &&
      pairedNow &&
      plan.shouldNotifyPaired &&
      replyTarget
    ) {
      await deps.sendTextReply(
        replyTarget.chatId,
        replyTarget.messageId,
        "Telegram bridge paired with this account.",
      );
    }
    if (plan.shouldDeny) {
      if (replyTarget) {
        await deps.sendTextReply(
          replyTarget.chatId,
          replyTarget.messageId,
          "This bot is not authorized for your account.",
        );
      }
      return;
    }
    if (plan.kind === "edited-message") {
      await deps.handleAuthorizedTelegramEditedMessage(plan.message, deps.ctx);
      return;
    }
    await deps.handleAuthorizedTelegramMessage(plan.message, deps.ctx);
  } catch (error) {
    if (!isTelegramStaleContextError(error)) throw error;
  }
}

// --- Public update handler registry ---

/**
 * Verdict returned by a public Telegram update handler.
 *
 * - `"consume"` — the handler processed this update; pi-telegram skips default routing.
 * - `"pass"` (or `void`/`undefined`) — pi-telegram routes the update normally.
 */
export type TelegramUpdateHandlerVerdict = "consume" | "pass";

export type TelegramUpdateHandler = (
  update: unknown,
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
   * Used by pi-telegram's polling runtime; companion extensions should call
   * {@link registerTelegramUpdateHandler} or `add` instead of dispatching directly.
   */
  dispatch: (update: unknown) => Promise<TelegramUpdateHandlerVerdict>;
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
    async dispatch(update) {
      for (const handler of handlers) {
        try {
          const result = await handler(update);
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
 * through. Companion extensions should not call this; use
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
  return async function handleTelegramUpdate(update, ctx) {
    const verdict = await registry.dispatch(update);
    if (verdict === "consume") return;
    await defaultHandle(update, ctx);
  };
}

/**
 * Register a handler that runs before pi-telegram routes a Telegram update
 * through its built-in handlers.
 *
 * This is the low-level public surface for companion extensions that share
 * the same bot and pi process with pi-telegram.
 */
export function registerTelegramUpdateHandler(
  handler: TelegramUpdateHandler,
): () => void {
  return getOrCreateUpdateHandlerRegistry().add(handler);
}
