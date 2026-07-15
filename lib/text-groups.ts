/**
 * Telegram text-group coalescing helpers
 * Zones: telegram inbound, queue admission, split-message recovery
 * Owns conservative delayed grouping for Telegram text messages that look like automatic long-message splits
 */

import { setTimeout as waitForTimeout } from "node:timers/promises";

import {
  extractTelegramMessageText,
  type TelegramMessageForwardOrigin,
  type TelegramMessageUser,
  type TelegramRichMessage,
} from "./media.ts";

const TELEGRAM_TEXT_GROUP_DEBOUNCE_MS = 1000;
const TELEGRAM_TEXT_GROUP_MIN_SPLIT_LENGTH = 3600;
const TELEGRAM_TEXT_GROUP_MAX_MESSAGE_ID_GAP = 12;

export interface TelegramTextGroupMessage {
  message_id: number;
  media_group_id?: string;
  chat: { id: number };
  message_thread_id?: number;
  from?: { id?: number; is_bot?: boolean };
  text?: string;
  caption?: string;
  rich_message?: TelegramRichMessage;
  forward_origin?: TelegramMessageForwardOrigin;
  forward_from?: TelegramMessageUser;
  forward_sender_name?: string;
}

export interface TelegramTextGroupState<TMessage, TContext = unknown> {
  messages: TMessage[];
  context?: TContext;
  flushTimer?: ReturnType<typeof setTimeout>;
  dispatching?: boolean;
  suspended?: boolean;
  reschedule?: (delayMs?: number) => void;
  dispatchLimit?: number;
  forwardCommentCandidate?: boolean;
}

export type TelegramForwardCommentBatchPosition = "comment" | "forward";

export interface TelegramTextGroupController<TMessage, TContext = unknown> {
  prepareUpdateBatch: (
    updates: readonly { message?: TMessage }[],
  ) => void;
  getPreparedForwardingPosition: (
    message: TelegramTextGroupMessage,
  ) => TelegramForwardCommentBatchPosition | undefined;
  prepareForwardedMessage: (
    message: TelegramTextGroupMessage,
    position: TelegramForwardCommentBatchPosition,
  ) => void;
  queueMessage: (options: {
    message: TMessage;
    context: TContext;
    dispatchMessages: (
      messages: TMessage[],
      ctx: TContext,
    ) => unknown | Promise<unknown>;
  }) => boolean;
  suspend: () => void;
  resume: (context: TContext) => void;
  clear: () => void;
}

export interface TelegramTextGroupControllerOptions {
  debounceMs?: number;
  forwardCommentWaitMs?: number | false;
  minSplitLength?: number;
  setTimer?: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface TelegramTextGroupDispatchRuntime<
  TMessage extends TelegramTextGroupMessage,
  TContext,
> {
  handleMessage: (message: TMessage, ctx: TContext) => Promise<void>;
}

export interface TelegramGroupedInputClearerDeps {
  clearMediaGroups: () => void;
  clearTextGroups: () => void;
}

function extractTelegramTextGroupText(
  message: TelegramTextGroupMessage,
): string {
  return extractTelegramMessageText(message);
}

function isTelegramForwardedMessage(
  message: TelegramTextGroupMessage,
): boolean {
  return (
    message.forward_origin !== undefined ||
    message.forward_from !== undefined ||
    typeof message.forward_sender_name === "string"
  );
}

function isTelegramTextGroupCommand(text: string): boolean {
  return text.trimStart().startsWith("/");
}

function isTelegramTextGroupClearingCommand(text: string): boolean {
  const command = text.trimStart().split(/\s+/, 1)[0]?.split("@", 1)[0];
  return command === "/stop";
}

function getTelegramTextGroupMessageIdentity(
  message: TelegramTextGroupMessage,
): string {
  const threadKey =
    typeof message.message_thread_id === "number"
      ? `thread:${message.message_thread_id}`
      : "private";
  return `${message.chat.id}:${threadKey}:${message.message_id}`;
}

function getTelegramTextGroupKey(
  message: TelegramTextGroupMessage,
): string | undefined {
  if (message.media_group_id) return undefined;
  if (!message.from || message.from.is_bot) return undefined;
  if (!extractTelegramTextGroupText(message)) return undefined;
  const threadKey =
    typeof message.message_thread_id === "number"
      ? `thread:${message.message_thread_id}`
      : "private";
  return `${message.chat.id}:${threadKey}:${message.from.id}`;
}

function canStartTelegramTextGroup(
  message: TelegramTextGroupMessage,
  minSplitLength: number,
): boolean {
  const text = extractTelegramTextGroupText(message);
  return text.length >= minSplitLength && !isTelegramTextGroupCommand(text);
}

function canAppendTelegramTextGroupMessage<
  TMessage extends TelegramTextGroupMessage,
>(
  state: TelegramTextGroupState<TMessage, unknown>,
  message: TMessage,
): boolean {
  const text = extractTelegramTextGroupText(message);
  const previous = state.messages.at(-1);
  return (
    !!previous &&
    message.message_id > previous.message_id &&
    message.message_id <=
      previous.message_id + TELEGRAM_TEXT_GROUP_MAX_MESSAGE_ID_GAP &&
    text.length > 0 &&
    !isTelegramTextGroupCommand(text)
  );
}

export function queueTelegramTextGroupMessage<
  TMessage extends TelegramTextGroupMessage,
  TContext = unknown,
>(options: {
  message: TMessage;
  context: TContext;
  groups: Map<string, TelegramTextGroupState<TMessage, TContext>>;
  debounceMs: number;
  minSplitLength: number;
  setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  dispatchMessages: (
    messages: TMessage[],
    ctx: TContext,
  ) => unknown | Promise<unknown>;
  forceStart?: boolean;
  dispatchImmediately?: boolean;
  forwardCommentCandidate?: boolean;
  delayMs?: number;
}): boolean {
  const key = getTelegramTextGroupKey(options.message);
  if (!key) return false;
  const existing = options.groups.get(key);
  if (existing?.messages.some(
    (message) => message.message_id === options.message.message_id,
  )) return true;
  if (
    !existing &&
    !options.forceStart &&
    !canStartTelegramTextGroup(options.message, options.minSplitLength)
  )
    return false;
  if (existing && !canAppendTelegramTextGroupMessage(existing, options.message))
    return false;
  const state = existing ?? { messages: [] };
  state.messages.push(options.message);
  state.context = options.context;
  state.forwardCommentCandidate = options.forwardCommentCandidate;
  const dispatchQueued = (): void => {
      state.flushTimer = undefined;
      const queued = options.groups.get(key);
      if (!queued || queued.context === undefined) return;
      if (queued.dispatching) {
        scheduleDispatch();
        return;
      }
      const dispatchCount = queued.dispatchLimit ?? queued.messages.length;
      queued.dispatchLimit = undefined;
      const dispatchedMessages = queued.messages.slice(0, dispatchCount);
      const dispatchedIds = new Set(
        dispatchedMessages.map((message) => message.message_id),
      );
      queued.dispatching = true;
      void Promise.resolve(
        options.dispatchMessages(dispatchedMessages, queued.context),
      ).then(
        () => {
          if (options.groups.get(key) !== queued) return;
          queued.messages = queued.messages.filter(
            (message) => !dispatchedIds.has(message.message_id),
          );
          queued.dispatching = false;
          if (queued.messages.length === 0) options.groups.delete(key);
          else if (!queued.flushTimer) scheduleDispatch();
        },
        () => {
          if (options.groups.get(key) !== queued) return;
          queued.dispatching = false;
          if (!queued.flushTimer) scheduleDispatch();
        },
      );
  };
  const scheduleDispatch = (delayMs = options.debounceMs): void => {
    if (state.suspended) return;
    state.flushTimer = options.setTimer(dispatchQueued, delayMs);
    state.flushTimer.unref?.();
  };
  state.reschedule = scheduleDispatch;
  if (state.flushTimer) options.clearTimer(state.flushTimer);
  scheduleDispatch(
    options.dispatchImmediately ? 0 : (options.delayMs ?? options.debounceMs),
  );
  options.groups.set(key, state);
  return true;
}

export function createTelegramTextGroupController<
  TMessage extends TelegramTextGroupMessage,
  TContext = unknown,
>(
  options: TelegramTextGroupControllerOptions = {},
): TelegramTextGroupController<TMessage, TContext> {
  const groups = new Map<string, TelegramTextGroupState<TMessage, TContext>>();
  const plannedForwardCommentStarts = new Set<string>();
  const plannedForwardCommentEnds = new Set<string>();
  const debounceMs = options.debounceMs ?? TELEGRAM_TEXT_GROUP_DEBOUNCE_MS;
  const minSplitLength =
    options.minSplitLength ?? TELEGRAM_TEXT_GROUP_MIN_SPLIT_LENGTH;
  const forwardCommentWaitMs =
    options.forwardCommentWaitMs === undefined
      ? debounceMs
      : options.forwardCommentWaitMs;
  const setTimer =
    options.setTimer ??
    ((callback: () => void, ms: number): ReturnType<typeof setTimeout> => {
      const controller = new AbortController();
      void waitForTimeout(ms, undefined, {
        signal: controller.signal,
      }).then(callback, () => undefined);
      return controller as unknown as ReturnType<typeof setTimeout>;
    });
  const clearTimer =
    options.clearTimer ??
    (options.setTimer
      ? clearTimeout
      : (timer: ReturnType<typeof setTimeout>): void => {
          (timer as unknown as AbortController).abort();
        });
  return {
    prepareUpdateBatch(updates) {
      for (let index = 0; index + 1 < updates.length; index += 1) {
        const comment = updates[index]?.message;
        const forwarded = updates[index + 1]?.message;
        if (!comment || !forwarded) continue;
        const commentText = extractTelegramTextGroupText(comment);
        const commentKey = getTelegramTextGroupKey(comment);
        const forwardedKey = getTelegramTextGroupKey(forwarded);
        if (
          !commentKey ||
          commentKey !== forwardedKey ||
          !commentText ||
          isTelegramTextGroupCommand(commentText) ||
          isTelegramForwardedMessage(comment) ||
          !isTelegramForwardedMessage(forwarded) ||
          forwarded.message_id <= comment.message_id ||
          forwarded.message_id >
            comment.message_id + TELEGRAM_TEXT_GROUP_MAX_MESSAGE_ID_GAP
        ) {
          continue;
        }
        plannedForwardCommentStarts.add(
          getTelegramTextGroupMessageIdentity(comment),
        );
        plannedForwardCommentEnds.add(
          getTelegramTextGroupMessageIdentity(forwarded),
        );
      }
    },
    getPreparedForwardingPosition(message) {
      const identity = getTelegramTextGroupMessageIdentity(message);
      if (plannedForwardCommentStarts.has(identity)) return "comment";
      if (plannedForwardCommentEnds.has(identity)) return "forward";
      return undefined;
    },
    prepareForwardedMessage(message, position) {
      const identity = getTelegramTextGroupMessageIdentity(message);
      if (position === "comment") plannedForwardCommentStarts.add(identity);
      else plannedForwardCommentEnds.add(identity);
    },
    queueMessage: ({ message, context, dispatchMessages }) => {
      const identity = getTelegramTextGroupMessageIdentity(message);
      const key = getTelegramTextGroupKey(message);
      const plannedStart = plannedForwardCommentStarts.delete(identity);
      const forwarded = isTelegramForwardedMessage(message);
      const existing = key ? groups.get(key) : undefined;
      const text = extractTelegramTextGroupText(message);
      if (existing && isTelegramTextGroupClearingCommand(text)) {
        if (existing.flushTimer) clearTimer(existing.flushTimer);
        groups.delete(key!);
      }
      const separateFromCandidate =
        !!existing?.forwardCommentCandidate &&
        !forwarded &&
        !isTelegramTextGroupCommand(text);
      if (separateFromCandidate) {
        existing.dispatchLimit = existing.messages.length;
      }
      const forceStart =
        plannedStart ||
        (forwardCommentWaitMs !== false &&
          !forwarded &&
          !!key &&
          typeof message.text === "string" &&
          !isTelegramTextGroupCommand(extractTelegramTextGroupText(message)));
      const dispatchImmediately =
        separateFromCandidate ||
        plannedForwardCommentEnds.delete(identity) ||
        (forwarded && !!key && groups.has(key));
      return queueTelegramTextGroupMessage({
        message,
        context,
        groups,
        debounceMs,
        minSplitLength,
        setTimer,
        clearTimer,
        dispatchMessages,
        forceStart,
        dispatchImmediately,
        forwardCommentCandidate:
          forceStart &&
          !forwarded &&
          !canStartTelegramTextGroup(message, minSplitLength),
        delayMs:
          forceStart && !canStartTelegramTextGroup(message, minSplitLength)
            ? forwardCommentWaitMs === false
              ? undefined
              : forwardCommentWaitMs
            : undefined,
      });
    },
    suspend: () => {
      for (const state of groups.values()) {
        state.suspended = true;
        if (state.flushTimer) clearTimer(state.flushTimer);
        state.flushTimer = undefined;
      }
    },
    resume: (context) => {
      for (const state of groups.values()) {
        state.context = context;
        state.suspended = false;
        if (!state.dispatching && !state.flushTimer) state.reschedule?.();
      }
    },
    clear: () => {
      for (const state of groups.values()) {
        if (state.flushTimer) clearTimer(state.flushTimer);
      }
      groups.clear();
      plannedForwardCommentStarts.clear();
      plannedForwardCommentEnds.clear();
    },
  };
}

export function createTelegramTextGroupDispatchRuntime<
  TMessage extends TelegramTextGroupMessage,
  TContext,
>(deps: {
  textGroups: TelegramTextGroupController<TMessage, TContext>;
  dispatchMessages: (messages: TMessage[], ctx: TContext) => Promise<void>;
  dispatchSingleMessage: (message: TMessage, ctx: TContext) => Promise<void>;
}): TelegramTextGroupDispatchRuntime<TMessage, TContext> {
  return {
    handleMessage: async (message, ctx) => {
      const queuedTextGroup = deps.textGroups.queueMessage({
        message,
        context: ctx,
        dispatchMessages: (messages, queuedCtx) =>
          deps.dispatchMessages(messages, queuedCtx),
      });
      if (queuedTextGroup) return;
      await deps.dispatchSingleMessage(message, ctx);
    },
  };
}

export function createTelegramGroupedInputClearer(
  deps: TelegramGroupedInputClearerDeps,
): () => void {
  return () => {
    deps.clearMediaGroups();
    deps.clearTextGroups();
  };
}
