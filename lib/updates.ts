/**
 * Telegram updates domain helpers
 * Zones: telegram inbound, authorization, routing plans
 * Owns update extraction, authorization, classification, execution planning, and runtime execution for Telegram updates
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

export const TELEGRAM_PRIORITY_REACTION_EMOJIS = ["👍", "⚡", "❤", "🕊"] as const;
export const TELEGRAM_REMOVAL_REACTION_EMOJIS = ["👎", "👻", "💔", "💩"] as const;

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

function hasAddedTelegramReactionEmoji(
  oldEmojis: Set<string>,
  newEmojis: Set<string>,
  candidates: readonly string[],
): boolean {
  return candidates.some((emoji) => !oldEmojis.has(emoji) && newEmojis.has(emoji));
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

export interface TelegramUpdateRouting {
  message?: TelegramUpdateMessage;
  edited_message?: TelegramUpdateMessage;
  callback_query?: TelegramCallbackQuery;
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
    };

export function buildTelegramUpdateFlowAction<
  TUpdate extends TelegramUpdateFlow,
>(
  update: TUpdate,
  allowedUserId?: number,
): TelegramUpdateFlowAction<
  NonNullable<TUpdate["message_reaction"]>,
  NonNullable<TUpdate["callback_query"]>,
  NonNullable<TUpdate["message"] | TUpdate["edited_message"]>
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
  return { kind: "ignore" };
}

// --- Execution Planning ---

export type TelegramUpdateExecutionPlan<
  TReactionUpdate extends TelegramMessageReactionUpdated =
    TelegramMessageReactionUpdated,
  TCallbackQuery extends TelegramCallbackQuery = TelegramCallbackQuery,
  TMessage extends TelegramUpdateMessage = TelegramUpdateMessage,
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
    };

export function buildTelegramUpdateExecutionPlan<
  TReactionUpdate extends TelegramMessageReactionUpdated,
  TCallbackQuery extends TelegramCallbackQuery,
  TMessage extends TelegramUpdateMessage,
>(
  action: TelegramUpdateFlowAction<TReactionUpdate, TCallbackQuery, TMessage>,
): TelegramUpdateExecutionPlan<TReactionUpdate, TCallbackQuery, TMessage> {
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
  ) => boolean;
  pairTelegramUserIfNeeded: (userId: number, ctx: TContext) => Promise<boolean>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
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
    handleAuthorizedTelegramCallbackQuery:
      deps.handleAuthorizedTelegramCallbackQuery,
    sendTextReply: deps.sendTextReply,
    handleAuthorizedTelegramMessage: deps.handleAuthorizedTelegramMessage,
    handleAuthorizedTelegramEditedMessage:
      deps.handleAuthorizedTelegramEditedMessage,
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
        handleAuthorizedTelegramCallbackQuery:
          deps.handleAuthorizedTelegramCallbackQuery,
        sendTextReply: deps.sendTextReply,
        handleAuthorizedTelegramMessage: deps.handleAuthorizedTelegramMessage,
        handleAuthorizedTelegramEditedMessage:
          deps.handleAuthorizedTelegramEditedMessage,
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
  if (!hasAddedTelegramReactionEmoji(oldEmojis, newEmojis, TELEGRAM_PRIORITY_REACTION_EMOJIS)) return;
  deps.prioritizeQueuedTelegramTurnByMessageId(
    reactionUpdate.message_id,
    deps.ctx,
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
}
