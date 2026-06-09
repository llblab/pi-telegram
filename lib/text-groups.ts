/**
 * Telegram text-group coalescing helpers
 * Zones: telegram inbound, queue admission, split-message recovery
 * Owns conservative delayed grouping for Telegram text messages that look like automatic long-message splits
 */

const TELEGRAM_TEXT_GROUP_DEBOUNCE_MS = 1000;
const TELEGRAM_TEXT_GROUP_MIN_SPLIT_LENGTH = 3600;
const TELEGRAM_TEXT_GROUP_MAX_MESSAGE_ID_GAP = 12;

export interface TelegramTextGroupMessage {
  message_id: number;
  media_group_id?: string;
  chat: { id: number };
  from?: { id: number; is_bot?: boolean };
  text?: string;
  caption?: string;
}

export interface TelegramTextGroupState<TMessage, TContext = unknown> {
  messages: TMessage[];
  context?: TContext;
  flushTimer?: ReturnType<typeof setTimeout>;
}

export interface TelegramTextGroupController<TMessage, TContext = unknown> {
  queueMessage: (options: {
    message: TMessage;
    context: TContext;
    dispatchMessages: (messages: TMessage[], ctx: TContext) => void;
  }) => boolean;
  clear: () => void;
}

export interface TelegramTextGroupControllerOptions {
  debounceMs?: number;
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
  return typeof message.text === "string" ? message.text : "";
}

function isTelegramTextGroupCommand(text: string): boolean {
  return text.trimStart().startsWith("/");
}

function getTelegramTextGroupKey(
  message: TelegramTextGroupMessage,
): string | undefined {
  if (message.media_group_id) return undefined;
  if (!message.from || message.from.is_bot) return undefined;
  if (typeof message.text !== "string") return undefined;
  return `${message.chat.id}:${message.from.id}`;
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
  dispatchMessages: (messages: TMessage[], ctx: TContext) => void;
}): boolean {
  const key = getTelegramTextGroupKey(options.message);
  if (!key) return false;
  const existing = options.groups.get(key);
  if (
    !existing &&
    !canStartTelegramTextGroup(options.message, options.minSplitLength)
  )
    return false;
  if (existing && !canAppendTelegramTextGroupMessage(existing, options.message))
    return false;
  const state = existing ?? { messages: [] };
  state.messages.push(options.message);
  state.context = options.context;
  if (state.flushTimer) options.clearTimer(state.flushTimer);
  state.flushTimer = options.setTimer(() => {
    const queued = options.groups.get(key);
    options.groups.delete(key);
    if (!queued || queued.context === undefined) return;
    options.dispatchMessages(queued.messages, queued.context);
  }, options.debounceMs);
  state.flushTimer.unref?.();
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
  const debounceMs = options.debounceMs ?? TELEGRAM_TEXT_GROUP_DEBOUNCE_MS;
  const minSplitLength =
    options.minSplitLength ?? TELEGRAM_TEXT_GROUP_MIN_SPLIT_LENGTH;
  const setTimer =
    options.setTimer ??
    ((callback: () => void, ms: number): ReturnType<typeof setTimeout> =>
      setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? clearTimeout;
  return {
    queueMessage: ({ message, context, dispatchMessages }) =>
      queueTelegramTextGroupMessage({
        message,
        context,
        groups,
        debounceMs,
        minSplitLength,
        setTimer,
        clearTimer,
        dispatchMessages,
      }),
    clear: () => {
      for (const state of groups.values()) {
        if (state.flushTimer) clearTimer(state.flushTimer);
      }
      groups.clear();
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
        dispatchMessages: (messages, queuedCtx) => {
          void deps.dispatchMessages(messages, queuedCtx);
        },
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
