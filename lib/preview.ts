/**
 * Telegram preview streaming helpers
 * Zones: telegram outbound, streaming preview, rendering
 * Owns preview transport selection, runtime updates, and preview finalization
 */

import type {
  TelegramEditMessageTextBody,
  TelegramReplyParameters,
  TelegramSendMessageBody,
  TelegramSentMessage,
} from "./api.ts";
import {
  buildTelegramPreviewSnapshot,
  MAX_MESSAGE_LENGTH,
  renderMarkdownPreviewText,
  renderTelegramMessage,
  type TelegramPreviewRenderStrategy,
  type TelegramPreviewSnapshot,
  type TelegramRenderedChunk,
  type TelegramRenderMode,
} from "./rendering.ts";
import { buildTelegramReplyParameters } from "./replies.ts";
import { stripTelegramCommentMarkupForPreview } from "./outbound-handlers.ts";

const TELEGRAM_PREVIEW_THROTTLE_MS = 750;
const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;

export type TelegramDraftSupport = "unknown" | "supported" | "unsupported";

export interface TelegramPreviewState {
  mode: "draft" | "message";
  draftId?: number;
  messageId?: number;
  pendingText: string;
  lastSentText: string;
  lastSentParseMode?: "HTML";
  lastSentStrategy?: TelegramPreviewRenderStrategy;
}

export interface TelegramPreviewRuntimeState extends TelegramPreviewState {
  flushTimer?: ReturnType<typeof setTimeout>;
  flushPromise?: Promise<void>;
  flushRequested?: boolean;
}

export type TelegramSentPreviewMessage = TelegramSentMessage;
export type TelegramPreviewReplyMarkup = unknown;

export interface TelegramPreviewRuntimeDeps<
  TReplyMarkup = TelegramPreviewReplyMarkup,
> {
  getState: () => TelegramPreviewRuntimeState | undefined;
  setState: (state: TelegramPreviewRuntimeState | undefined) => void;
  clearScheduledFlush: (state: TelegramPreviewRuntimeState) => void;
  maxMessageLength: number;
  renderPreviewText: (markdown: string) => string;
  getDraftSupport: () => TelegramDraftSupport;
  setDraftSupport: (support: TelegramDraftSupport) => void;
  allocateDraftId: () => number;
  sendDraft: (
    chatId: number,
    draftId: number,
    text: string,
  ) => Promise<unknown>;
  sendMessage: (
    chatId: number,
    text: string,
    options?: { parseMode?: "HTML" },
  ) => Promise<TelegramSentPreviewMessage>;
  editMessageText: (
    chatId: number,
    messageId: number,
    text: string,
    options?: { parseMode?: "HTML" },
  ) => Promise<unknown>;
  renderTelegramMessage: (
    text: string,
    options?: { mode?: TelegramRenderMode },
  ) => TelegramRenderedChunk[];
  sendRenderedChunks: (
    chatId: number,
    chunks: TelegramRenderedChunk[],
    options?: { replyMarkup?: TReplyMarkup },
  ) => Promise<number | undefined>;
  editRenderedMessage: (
    chatId: number,
    messageId: number,
    chunks: TelegramRenderedChunk[],
    options?: { replyMarkup?: TReplyMarkup },
  ) => Promise<number | undefined>;
  canSend?: () => boolean;
}

export interface TelegramPreviewActiveTurn {
  chatId: number;
}

export interface TelegramAssistantMessagePreviewStartDeps<
  TMessage,
  TReplyMarkup = TelegramPreviewReplyMarkup,
> {
  getActiveTurn: () => TelegramPreviewActiveTurn | undefined;
  isAssistantMessage: (message: TMessage) => boolean;
  getState: () => TelegramPreviewRuntimeState | undefined;
  setState: (state: TelegramPreviewRuntimeState | undefined) => void;
  createPreviewState: () => TelegramPreviewRuntimeState;
  finalizePreview: (chatId: number) => Promise<boolean>;
  finalizeMarkdownPreview: (
    chatId: number,
    markdown: string,
    replyToMessageId?: number,
    options?: { replyMarkup?: TReplyMarkup },
  ) => Promise<boolean>;
}

export interface TelegramAssistantMessagePreviewUpdateDeps<TMessage> {
  getActiveTurn: () => TelegramPreviewActiveTurn | undefined;
  isAssistantMessage: (message: TMessage) => boolean;
  getState: () => TelegramPreviewRuntimeState | undefined;
  setState: (state: TelegramPreviewRuntimeState | undefined) => void;
  createPreviewState: () => TelegramPreviewRuntimeState;
  getMessageText: (message: TMessage) => string;
  schedulePreviewFlush: (chatId: number) => void;
}

export type TelegramAssistantMessagePreviewHookDeps<
  TMessage,
  TReplyMarkup = TelegramPreviewReplyMarkup,
> = TelegramAssistantMessagePreviewStartDeps<TMessage, TReplyMarkup> &
  TelegramAssistantMessagePreviewUpdateDeps<TMessage>;

export interface TelegramAssistantMessagePreviewHookEvent<TMessage> {
  message: TMessage;
}

export interface TelegramAssistantMessagePreviewHooks<TMessage> {
  onMessageStart: (
    event: TelegramAssistantMessagePreviewHookEvent<TMessage>,
  ) => Promise<void>;
  onMessageUpdate: (
    event: TelegramAssistantMessagePreviewHookEvent<TMessage>,
  ) => Promise<void>;
}

export interface TelegramPreviewControllerDeps<
  TReplyMarkup = TelegramPreviewReplyMarkup,
> {
  getDefaultReplyToMessageId?: () => number | undefined;
  maxMessageLength?: number;
  renderPreviewText?: (markdown: string) => string;
  initialDraftSupport?: TelegramDraftSupport;
  sendDraft: (
    chatId: number,
    draftId: number,
    text: string,
  ) => Promise<unknown>;
  sendMessage: (
    chatId: number,
    text: string,
    options: { parseMode?: "HTML" } | undefined,
    replyToMessageId: number | undefined,
  ) => Promise<TelegramSentPreviewMessage>;
  editMessageText: (
    chatId: number,
    messageId: number,
    text: string,
    options?: { parseMode?: "HTML" },
  ) => Promise<unknown>;
  renderTelegramMessage?: (
    text: string,
    options?: { mode?: TelegramRenderMode },
  ) => TelegramRenderedChunk[];
  sendRenderedChunks: (
    chatId: number,
    chunks: TelegramRenderedChunk[],
    replyToMessageId: number | undefined,
    options?: { replyMarkup?: TReplyMarkup },
  ) => Promise<number | undefined>;
  editRenderedMessage: (
    chatId: number,
    messageId: number,
    chunks: TelegramRenderedChunk[],
    options?: { replyMarkup?: TReplyMarkup },
  ) => Promise<number | undefined>;
  canSend?: () => boolean;
  throttleMs?: number;
  maxDraftId?: number;
  setTimer?: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface TelegramPreviewController<
  TReplyMarkup = TelegramPreviewReplyMarkup,
> {
  getState: () => TelegramPreviewRuntimeState | undefined;
  setState: (state: TelegramPreviewRuntimeState | undefined) => void;
  setPendingText: (text: string) => void;
  createState: () => TelegramPreviewRuntimeState;
  resetState: () => void;
  clear: (chatId: number) => Promise<void>;
  flush: (chatId: number) => Promise<void>;
  scheduleFlush: (chatId: number) => void;
  finalize: (chatId: number, replyToMessageId?: number) => Promise<boolean>;
  finalizeMarkdown: (
    chatId: number,
    markdown: string,
    replyToMessageId?: number,
    options?: { replyMarkup?: TReplyMarkup },
  ) => Promise<boolean>;
}

export interface TelegramPreviewMessageTransportDeps {
  sendMessage: (body: TelegramSendMessageBody) => Promise<TelegramSentMessage>;
  editMessageText: (body: TelegramEditMessageTextBody) => Promise<unknown>;
  buildReplyParameters?: (
    replyToMessageId: number | undefined,
  ) => TelegramReplyParameters | undefined;
}

export function createTelegramPreviewMessageTransport(
  deps: TelegramPreviewMessageTransportDeps,
): Pick<TelegramPreviewControllerDeps, "sendMessage" | "editMessageText"> {
  const getReplyParameters =
    deps.buildReplyParameters ?? buildTelegramReplyParameters;
  return {
    sendMessage: (chatId, text, options, replyToMessageId) => {
      const replyParameters = getReplyParameters(replyToMessageId);
      return deps.sendMessage({
        chat_id: chatId,
        text,
        parse_mode: options?.parseMode,
        ...(replyParameters ? { reply_parameters: replyParameters } : {}),
      });
    },
    editMessageText: (chatId, messageId, text, options) =>
      deps.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: options?.parseMode,
      }),
  };
}

export interface TelegramPreviewRenderedChunkTransportDeps<
  TReplyMarkup = TelegramPreviewReplyMarkup,
> {
  sendRenderedChunks: (
    chatId: number,
    chunks: TelegramRenderedChunk[],
    options?: {
      replyToMessageId?: number;
      replyMarkup?: TReplyMarkup;
    },
  ) => Promise<number | undefined>;
  editRenderedMessage: (
    chatId: number,
    messageId: number,
    chunks: TelegramRenderedChunk[],
    options?: { replyMarkup?: TReplyMarkup },
  ) => Promise<number | undefined>;
}

export function createTelegramPreviewRenderedChunkTransport<
  TReplyMarkup = TelegramPreviewReplyMarkup,
>(
  deps: TelegramPreviewRenderedChunkTransportDeps<TReplyMarkup>,
): Pick<
  TelegramPreviewControllerDeps<TReplyMarkup>,
  "sendRenderedChunks" | "editRenderedMessage"
> {
  return {
    sendRenderedChunks: (chatId, chunks, replyToMessageId, options) =>
      deps.sendRenderedChunks(chatId, chunks, {
        replyToMessageId,
        ...(options?.replyMarkup ? { replyMarkup: options.replyMarkup } : {}),
      }),
    editRenderedMessage: (chatId, messageId, chunks, options) =>
      deps.editRenderedMessage(chatId, messageId, chunks, options),
  };
}

export type TelegramPreviewControllerRuntimeDeps<
  TReplyMarkup = TelegramPreviewReplyMarkup,
> = Omit<
  TelegramPreviewControllerDeps<TReplyMarkup>,
  | "sendMessage"
  | "editMessageText"
  | "sendRenderedChunks"
  | "editRenderedMessage"
> &
  TelegramPreviewMessageTransportDeps &
  TelegramPreviewRenderedChunkTransportDeps<TReplyMarkup>;

export function createTelegramPreviewControllerRuntime<
  TReplyMarkup = TelegramPreviewReplyMarkup,
>(
  deps: TelegramPreviewControllerRuntimeDeps<TReplyMarkup>,
): TelegramPreviewController<TReplyMarkup> {
  return createTelegramPreviewController({
    getDefaultReplyToMessageId: deps.getDefaultReplyToMessageId,
    maxMessageLength: deps.maxMessageLength,
    renderPreviewText: deps.renderPreviewText,
    initialDraftSupport: deps.initialDraftSupport,
    sendDraft: deps.sendDraft,
    ...createTelegramPreviewMessageTransport({
      sendMessage: deps.sendMessage,
      editMessageText: deps.editMessageText,
      buildReplyParameters: deps.buildReplyParameters,
    }),
    renderTelegramMessage: deps.renderTelegramMessage,
    ...createTelegramPreviewRenderedChunkTransport({
      sendRenderedChunks: deps.sendRenderedChunks,
      editRenderedMessage: deps.editRenderedMessage,
    }),
    throttleMs: deps.throttleMs,
    maxDraftId: deps.maxDraftId,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
  });
}

export interface TelegramAssistantPreviewRuntimeDeps<
  TMessage,
  TReplyMarkup = TelegramPreviewReplyMarkup,
> extends TelegramPreviewControllerRuntimeDeps<TReplyMarkup> {
  getActiveTurn: () => TelegramPreviewActiveTurn | undefined;
  isAssistantMessage: (message: TMessage) => boolean;
  getMessageText: (message: TMessage) => string;
}

export type TelegramAssistantPreviewRuntime<
  TMessage,
  TReplyMarkup = TelegramPreviewReplyMarkup,
> = TelegramPreviewController<TReplyMarkup> &
  TelegramAssistantMessagePreviewHooks<TMessage>;

export function createTelegramAssistantPreviewRuntime<
  TMessage,
  TReplyMarkup = TelegramPreviewReplyMarkup,
>(
  deps: TelegramAssistantPreviewRuntimeDeps<TMessage, TReplyMarkup>,
): TelegramAssistantPreviewRuntime<TMessage, TReplyMarkup> {
  const controller = createTelegramPreviewControllerRuntime(deps);
  return {
    ...controller,
    ...createTelegramAssistantMessagePreviewHooks({
      getActiveTurn: deps.getActiveTurn,
      isAssistantMessage: deps.isAssistantMessage,
      getState: controller.getState,
      setState: controller.setState,
      createPreviewState: controller.createState,
      finalizePreview: controller.finalize,
      finalizeMarkdownPreview: controller.finalizeMarkdown,
      getMessageText: deps.getMessageText,
      schedulePreviewFlush: controller.scheduleFlush,
    }),
  };
}

export function createTelegramPreviewController<
  TReplyMarkup = TelegramPreviewReplyMarkup,
>(
  deps: TelegramPreviewControllerDeps<TReplyMarkup>,
): TelegramPreviewController<TReplyMarkup> {
  let state: TelegramPreviewRuntimeState | undefined;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, ms: number): ReturnType<typeof setTimeout> =>
      setTimeout(callback, ms));
  const throttleMs = deps.throttleMs ?? TELEGRAM_PREVIEW_THROTTLE_MS;
  const maxDraftId = deps.maxDraftId ?? TELEGRAM_DRAFT_ID_MAX;
  const maxMessageLength = deps.maxMessageLength ?? MAX_MESSAGE_LENGTH;
  const renderPreview = deps.renderPreviewText ?? renderMarkdownPreviewText;
  const renderMessage = deps.renderTelegramMessage ?? renderTelegramMessage;
  let draftSupport = deps.initialDraftSupport ?? "unknown";
  let nextDraftId = 0;
  const getRuntimeDeps = (
    replyToMessageId?: number,
  ): TelegramPreviewRuntimeDeps<TReplyMarkup> => ({
    getState: () => state,
    setState: (nextState) => {
      state = nextState;
    },
    clearScheduledFlush: (nextState) => {
      if (!nextState.flushTimer) return;
      clearTimer(nextState.flushTimer);
      nextState.flushTimer = undefined;
    },
    maxMessageLength,
    renderPreviewText: renderPreview,
    getDraftSupport: () => draftSupport,
    setDraftSupport: (support) => {
      draftSupport = support;
    },
    allocateDraftId: () => {
      nextDraftId = allocateTelegramDraftId(nextDraftId, maxDraftId);
      return nextDraftId;
    },
    sendDraft: deps.sendDraft,
    sendMessage: (chatId, text, options) =>
      deps.sendMessage(
        chatId,
        text,
        options,
        replyToMessageId ?? deps.getDefaultReplyToMessageId?.(),
      ),
    editMessageText: deps.editMessageText,
    renderTelegramMessage: renderMessage,
    sendRenderedChunks: (chatId, chunks, options) =>
      deps.sendRenderedChunks(
        chatId,
        chunks,
        replyToMessageId ?? deps.getDefaultReplyToMessageId?.(),
        options,
      ),
    editRenderedMessage: deps.editRenderedMessage,
    canSend: deps.canSend,
  });
  return {
    getState: () => state,
    setState: (nextState) => {
      state = nextState;
    },
    setPendingText: (text) => {
      if (state) state.pendingText = text;
    },
    createState: () => createTelegramPreviewRuntimeState(draftSupport),
    resetState: () => {
      state = createTelegramPreviewRuntimeState(draftSupport);
    },
    clear: (chatId) => clearTelegramPreview(chatId, getRuntimeDeps()),
    flush: (chatId) => flushTelegramPreview(chatId, getRuntimeDeps()),
    scheduleFlush: (chatId) => {
      if (!state || state.flushTimer) return;
      state.flushTimer = setTimer(() => {
        void flushTelegramPreview(chatId, getRuntimeDeps());
      }, throttleMs);
    },
    finalize: (chatId, replyToMessageId) =>
      finalizeTelegramPreview(chatId, getRuntimeDeps(replyToMessageId)),
    finalizeMarkdown: (chatId, markdown, replyToMessageId, options) =>
      finalizeTelegramMarkdownPreview(
        chatId,
        markdown,
        getRuntimeDeps(replyToMessageId),
        options,
      ),
  };
}

export function createTelegramAssistantMessagePreviewHooks<
  TMessage,
  TReplyMarkup = TelegramPreviewReplyMarkup,
>(
  deps: TelegramAssistantMessagePreviewHookDeps<TMessage, TReplyMarkup>,
): TelegramAssistantMessagePreviewHooks<TMessage> {
  return {
    onMessageStart: async (
      event: TelegramAssistantMessagePreviewHookEvent<TMessage>,
    ): Promise<void> => {
      await handleTelegramAssistantMessagePreviewStart(event.message, deps);
    },
    onMessageUpdate: async (
      event: TelegramAssistantMessagePreviewHookEvent<TMessage>,
    ): Promise<void> => {
      await handleTelegramAssistantMessagePreviewUpdate(event.message, deps);
    },
  };
}

export async function handleTelegramAssistantMessagePreviewStart<
  TMessage,
  TReplyMarkup = TelegramPreviewReplyMarkup,
>(
  message: TMessage,
  deps: TelegramAssistantMessagePreviewStartDeps<TMessage, TReplyMarkup>,
): Promise<void> {
  const turn = deps.getActiveTurn();
  if (!turn || !deps.isAssistantMessage(message)) return;
  const state = deps.getState();
  if (
    state &&
    (state.pendingText.trim().length > 0 ||
      state.lastSentText.trim().length > 0)
  ) {
    const previousText = state.pendingText.trim();
    if (previousText.length > 0) {
      await deps.finalizeMarkdownPreview(turn.chatId, previousText);
    } else {
      await deps.finalizePreview(turn.chatId);
    }
  }
  deps.setState(deps.createPreviewState());
}

export async function handleTelegramAssistantMessagePreviewUpdate<TMessage>(
  message: TMessage,
  deps: TelegramAssistantMessagePreviewUpdateDeps<TMessage>,
): Promise<void> {
  const turn = deps.getActiveTurn();
  if (!turn || !deps.isAssistantMessage(message)) return;
  let state = deps.getState();
  if (!state) {
    state = deps.createPreviewState();
    deps.setState(state);
  }
  state.pendingText = stripTelegramCommentMarkupForPreview(
    deps.getMessageText(message),
  );
  deps.schedulePreviewFlush(turn.chatId);
}

export function buildTelegramPreviewFinalText(
  state: TelegramPreviewState,
): string | undefined {
  const finalText = state.pendingText.trim();
  if (finalText) return finalText;
  if (
    state.lastSentStrategy === "rich-stable-blocks" ||
    state.lastSentParseMode === "HTML"
  ) {
    return undefined;
  }
  return state.lastSentText.trim() || undefined;
}

export function createTelegramPreviewRuntimeState(
  draftSupport: TelegramDraftSupport,
): TelegramPreviewRuntimeState {
  return {
    mode: draftSupport === "unsupported" ? "message" : "draft",
    pendingText: "",
    lastSentText: "",
  };
}

export function allocateTelegramDraftId(
  currentDraftId: number,
  maxDraftId: number,
): number {
  return currentDraftId >= maxDraftId ? 1 : currentDraftId + 1;
}

export function shouldUseTelegramDraftPreview(options: {
  draftSupport: TelegramDraftSupport;
  snapshot?: TelegramPreviewSnapshot;
}): boolean {
  return (
    options.draftSupport !== "unsupported" &&
    (options.snapshot === undefined || options.snapshot.strategy === "plain")
  );
}

export async function clearTelegramPreview<
  TReplyMarkup = TelegramPreviewReplyMarkup,
>(
  chatId: number,
  deps: TelegramPreviewRuntimeDeps<TReplyMarkup>,
): Promise<void> {
  void chatId;
  const state = deps.getState();
  if (!state) return;
  deps.clearScheduledFlush(state);
  deps.setState(undefined);
}

async function performTelegramPreviewFlush<
  TReplyMarkup = TelegramPreviewReplyMarkup,
>(
  chatId: number,
  state: TelegramPreviewRuntimeState,
  deps: TelegramPreviewRuntimeDeps<TReplyMarkup>,
): Promise<void> {
  if (deps.canSend && !deps.canSend()) {
    await clearTelegramPreview(chatId, deps);
    return;
  }
  const snapshot = buildTelegramPreviewSnapshot({
    state,
    maxMessageLength: deps.maxMessageLength,
    renderPreviewText: deps.renderPreviewText,
    renderTelegramMessage: deps.renderTelegramMessage,
  });
  if (!snapshot) return;
  if (
    shouldUseTelegramDraftPreview({
      draftSupport: deps.getDraftSupport(),
      snapshot,
    })
  ) {
    const draftId = state.draftId ?? deps.allocateDraftId();
    state.draftId = draftId;
    try {
      await deps.sendDraft(chatId, draftId, snapshot.text);
      deps.setDraftSupport("supported");
      state.mode = "draft";
      state.lastSentText = snapshot.text;
      state.lastSentParseMode = snapshot.parseMode;
      state.lastSentStrategy = snapshot.strategy;
      return;
    } catch {
      deps.setDraftSupport("unsupported");
    }
  }
  if (state.messageId === undefined) {
    const sent = await deps.sendMessage(chatId, snapshot.text, {
      parseMode: snapshot.parseMode,
    });
    state.messageId = sent.message_id;
    state.mode = "message";
    state.lastSentText = snapshot.text;
    state.lastSentParseMode = snapshot.parseMode;
    state.lastSentStrategy = snapshot.strategy;
    return;
  }
  await deps.editMessageText(chatId, state.messageId, snapshot.text, {
    parseMode: snapshot.parseMode,
  });
  state.mode = "message";
  state.lastSentText = snapshot.text;
  state.lastSentParseMode = snapshot.parseMode;
  state.lastSentStrategy = snapshot.strategy;
}

export async function flushTelegramPreview<
  TReplyMarkup = TelegramPreviewReplyMarkup,
>(
  chatId: number,
  deps: TelegramPreviewRuntimeDeps<TReplyMarkup>,
): Promise<void> {
  const state = deps.getState();
  if (!state) return;
  if (state.flushPromise) {
    state.flushRequested = true;
    await state.flushPromise;
    return;
  }
  state.flushTimer = undefined;
  state.flushPromise = (async () => {
    do {
      state.flushRequested = false;
      await performTelegramPreviewFlush(chatId, state, deps);
    } while (deps.getState() === state && state.flushRequested);
  })();
  try {
    await state.flushPromise;
  } finally {
    if (deps.getState() === state) {
      state.flushPromise = undefined;
    }
  }
}

export async function finalizeTelegramPreview<
  TReplyMarkup = TelegramPreviewReplyMarkup,
>(
  chatId: number,
  deps: TelegramPreviewRuntimeDeps<TReplyMarkup>,
): Promise<boolean> {
  const state = deps.getState();
  if (!state) return false;
  if (deps.canSend && !deps.canSend()) {
    await clearTelegramPreview(chatId, deps);
    return false;
  }
  await flushTelegramPreview(chatId, deps);
  const finalText = buildTelegramPreviewFinalText(state);
  if (!finalText) {
    await clearTelegramPreview(chatId, deps);
    return false;
  }
  if (state.mode === "draft") {
    await deps.sendMessage(chatId, finalText);
    await clearTelegramPreview(chatId, deps);
    return true;
  }
  deps.setState(undefined);
  return state.messageId !== undefined;
}

export async function finalizeTelegramMarkdownPreview<
  TReplyMarkup = TelegramPreviewReplyMarkup,
>(
  chatId: number,
  markdown: string,
  deps: TelegramPreviewRuntimeDeps<TReplyMarkup>,
  options?: { replyMarkup?: TReplyMarkup },
): Promise<boolean> {
  const state = deps.getState();
  if (!state) return false;
  if (deps.canSend && !deps.canSend()) {
    await clearTelegramPreview(chatId, deps);
    return false;
  }
  await flushTelegramPreview(chatId, deps);
  const chunks = deps.renderTelegramMessage(markdown, { mode: "markdown" });
  if (chunks.length === 0) {
    await clearTelegramPreview(chatId, deps);
    return false;
  }
  if (state.mode === "draft") {
    await deps.sendRenderedChunks(chatId, chunks, options);
    await clearTelegramPreview(chatId, deps);
    return true;
  }
  if (state.messageId === undefined) return false;
  await deps.editRenderedMessage(chatId, state.messageId, chunks, options);
  deps.setState(undefined);
  return true;
}
