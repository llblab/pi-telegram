/**
 * Telegram reply delivery helpers
 * Zones: telegram outbound, rendering transport
 * Owns rendered-message delivery, reply transport wiring, and plain or markdown final replies
 */

import { assertTelegramInlineKeyboardCallbackData } from "./keyboard.ts";
import type {
  TelegramReplyParameters,
  TelegramSentMessage,
} from "./telegram-api.ts";
import {
  renderTelegramMessage,
  type TelegramRenderedChunk,
  type TelegramRenderMode,
} from "./rendering.ts";

export {
  renderTelegramMessage,
  type TelegramRenderedChunk,
  type TelegramRenderMode,
};

// --- Reply Dedup ---

/** Non-persistent reply deduplication for a single agent turn.
 *  First reply to a prompt gets `reply_parameters.reply_to_message_id`;
 *  subsequent replies in the same turn skip it to avoid stacking
 *  duplicate reply headers in the chat viewport. */
export interface ReplyDedupRuntime {
  /** Returns true if this is the first reply for the given prompt
   *  message id in the current turn. Side-effect: marks it replied. */
  shouldReply(promptMessageId: number): boolean;
  /** Reset the tracker when a new prompt enters the queue. */
  reset(): void;
}

export function createReplyDedupRuntime(): ReplyDedupRuntime {
  const replied = new Map<number, boolean>();
  return {
    shouldReply(promptMessageId: number): boolean {
      if (replied.has(promptMessageId)) return false;
      replied.set(promptMessageId, true);
      return true;
    },
    reset(): void {
      replied.clear();
    },
  };
}

// --- Transport-level dedup ---

const lastRepliedToMessageIdByChat = new Map<number, number>();

export function resetTransportReplyDedup(): void {
  lastRepliedToMessageIdByChat.clear();
}

export function buildTelegramReplyParameters(
  chatId: number,
  messageId: number | undefined,
): TelegramReplyParameters | undefined {
  if (messageId === undefined) return undefined;
  if (lastRepliedToMessageIdByChat.get(chatId) === messageId) {
    return undefined;
  }
  lastRepliedToMessageIdByChat.set(chatId, messageId);
  return { message_id: messageId, allow_sending_without_reply: true };
}

export function buildTelegramMultipartReplyParameters(
  chatId: number,
  messageId: number | undefined,
): string | undefined {
  const parameters = buildTelegramReplyParameters(chatId, messageId);
  return parameters ? JSON.stringify(parameters) : undefined;
}

function getAgentMessageField(message: unknown, field: string): unknown {
  if (typeof message !== "object" || message === null || !(field in message)) {
    return undefined;
  }
  return Reflect.get(message, field);
}

export function isAssistantAgentMessage(message: unknown): boolean {
  return getAgentMessageField(message, "role") === "assistant";
}

function extractAgentTextContent(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [];
  return blocks
    .filter(
      (block): block is { type: string; text?: string } =>
        typeof block === "object" && block !== null && "type" in block,
    )
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
    .trim();
}

export function getAgentMessageText(message: unknown): string {
  return extractAgentTextContent(getAgentMessageField(message, "content"));
}

export function extractLatestAssistantMessageText(
  messages: readonly unknown[],
): {
  text?: string;
  stopReason?: string;
  errorMessage?: string;
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || !isAssistantAgentMessage(message)) continue;
    const rawStopReason = getAgentMessageField(message, "stopReason");
    const rawErrorMessage = getAgentMessageField(message, "errorMessage");
    const stopReason =
      typeof rawStopReason === "string" ? rawStopReason : undefined;
    const errorMessage =
      typeof rawErrorMessage === "string" ? rawErrorMessage : undefined;
    const text = getAgentMessageText(message);
    return { text: text || undefined, stopReason, errorMessage };
  }
  return {};
}

export interface TelegramReplyDeliveryDeps<TReplyMarkup> {
  sendMessage: (body: {
    chat_id: number;
    text: string;
    parse_mode?: "HTML";
    reply_markup?: TReplyMarkup;
    reply_parameters?: TelegramReplyParameters;
  }) => Promise<TelegramSentMessage>;
  editMessage: (body: {
    chat_id: number;
    message_id: number;
    text: string;
    parse_mode?: "HTML";
    reply_markup?: TReplyMarkup;
  }) => Promise<unknown>;
}

export interface TelegramReplyTransport<TReplyMarkup> {
  sendRenderedChunks: (
    chatId: number,
    chunks: TelegramRenderedChunk[],
    options?: { replyMarkup?: TReplyMarkup; replyToMessageId?: number },
  ) => Promise<number | undefined>;
  editRenderedMessage: (
    chatId: number,
    messageId: number,
    chunks: TelegramRenderedChunk[],
    options?: { replyMarkup?: TReplyMarkup },
  ) => Promise<number | undefined>;
}

export function buildTelegramReplyTransport<TReplyMarkup>(
  deps: TelegramReplyDeliveryDeps<TReplyMarkup>,
): TelegramReplyTransport<TReplyMarkup> {
  return {
    sendRenderedChunks: async (chatId, chunks, options) => {
      return sendTelegramRenderedChunks(chatId, chunks, deps, options);
    },
    editRenderedMessage: async (chatId, messageId, chunks, options) => {
      return editTelegramRenderedMessage(
        chatId,
        messageId,
        chunks,
        deps,
        options,
      );
    },
  };
}

export async function sendTelegramRenderedChunks<TReplyMarkup>(
  chatId: number,
  chunks: TelegramRenderedChunk[],
  deps: TelegramReplyDeliveryDeps<TReplyMarkup>,
  options?: { replyMarkup?: TReplyMarkup; replyToMessageId?: number },
): Promise<number | undefined> {
  assertTelegramInlineKeyboardCallbackData(options?.replyMarkup);
  let lastMessageId: number | undefined;
  for (const [index, chunk] of chunks.entries()) {
    const replyParameters =
      index === 0
        ? buildTelegramReplyParameters(chatId, options?.replyToMessageId)
        : undefined;
    const sent = await deps.sendMessage({
      chat_id: chatId,
      text: chunk.text,
      parse_mode: chunk.parseMode,
      reply_markup:
        index === chunks.length - 1 ? options?.replyMarkup : undefined,
      ...(replyParameters ? { reply_parameters: replyParameters } : {}),
    });
    lastMessageId = sent.message_id;
  }
  return lastMessageId;
}

export async function editTelegramRenderedMessage<TReplyMarkup>(
  chatId: number,
  messageId: number,
  chunks: TelegramRenderedChunk[],
  deps: TelegramReplyDeliveryDeps<TReplyMarkup>,
  options?: { replyMarkup?: TReplyMarkup },
): Promise<number | undefined> {
  assertTelegramInlineKeyboardCallbackData(options?.replyMarkup);
  if (chunks.length === 0) return messageId;
  const [firstChunk, ...remainingChunks] = chunks;
  await deps.editMessage({
    chat_id: chatId,
    message_id: messageId,
    text: firstChunk.text,
    parse_mode: firstChunk.parseMode,
    reply_markup:
      remainingChunks.length === 0 ? options?.replyMarkup : undefined,
  });
  if (remainingChunks.length > 0) {
    return sendTelegramRenderedChunks(chatId, remainingChunks, deps, {
      replyMarkup: options?.replyMarkup,
    });
  }
  return messageId;
}

export interface TelegramReplyRuntimeDeps<TReplyMarkup = unknown> {
  renderTelegramMessage: (
    text: string,
    options?: { mode?: TelegramRenderMode },
  ) => TelegramRenderedChunk[];
  sendRenderedChunks: (
    chunks: TelegramRenderedChunk[],
    options?: { replyMarkup?: TReplyMarkup },
  ) => Promise<number | undefined>;
}

export async function sendTelegramPlainReply(
  text: string,
  deps: TelegramReplyRuntimeDeps,
  options?: { parseMode?: "HTML" },
): Promise<number | undefined> {
  const chunks = deps.renderTelegramMessage(text, {
    mode: options?.parseMode === "HTML" ? "html" : "plain",
  });
  return deps.sendRenderedChunks(chunks);
}

export async function sendTelegramMarkdownReply<TReplyMarkup = unknown>(
  markdown: string,
  deps: TelegramReplyRuntimeDeps,
  options?: { replyMarkup?: TReplyMarkup },
): Promise<number | undefined> {
  const chunks = deps.renderTelegramMessage(markdown, { mode: "markdown" });
  if (chunks.length === 0) {
    return sendTelegramPlainReply(markdown, deps);
  }
  return deps.sendRenderedChunks(chunks, options);
}

export interface TelegramRenderedMessageRuntimeDeps<TReplyMarkup> {
  renderTelegramMessage: (
    text: string,
    options?: { mode?: TelegramRenderMode },
  ) => TelegramRenderedChunk[];
  replyTransport: TelegramReplyTransport<TReplyMarkup>;
}

export interface TelegramRenderedMessageRuntime<TReplyMarkup> {
  sendTextReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    text: string,
    options?: { parseMode?: "HTML" },
  ) => Promise<number | undefined>;
  sendMarkdownReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    markdown: string,
    options?: { replyMarkup?: unknown },
  ) => Promise<number | undefined>;
  editInteractiveMessage: (
    chatId: number,
    messageId: number,
    text: string,
    mode: TelegramRenderMode,
    replyMarkup: TReplyMarkup,
  ) => Promise<void>;
  sendInteractiveMessage: (
    chatId: number,
    text: string,
    mode: TelegramRenderMode,
    replyMarkup: TReplyMarkup,
  ) => Promise<number | undefined>;
}

export interface TelegramRenderedMessageDeliveryRuntime<
  TReplyMarkup,
> extends TelegramRenderedMessageRuntime<TReplyMarkup> {
  replyTransport: TelegramReplyTransport<TReplyMarkup>;
}

export interface TelegramRenderedMessageDeliveryRuntimeDeps<
  TReplyMarkup,
> extends TelegramReplyDeliveryDeps<TReplyMarkup> {
  renderTelegramMessage?: (
    text: string,
    options?: { mode?: TelegramRenderMode },
  ) => TelegramRenderedChunk[];
}

export function createTelegramRenderedMessageDeliveryRuntime<TReplyMarkup>(
  deps: TelegramRenderedMessageDeliveryRuntimeDeps<TReplyMarkup>,
): TelegramRenderedMessageDeliveryRuntime<TReplyMarkup> {
  const replyTransport = buildTelegramReplyTransport({
    sendMessage: deps.sendMessage,
    editMessage: deps.editMessage,
  });
  return {
    replyTransport,
    ...createTelegramRenderedMessageRuntime({
      renderTelegramMessage:
        deps.renderTelegramMessage ?? renderTelegramMessage,
      replyTransport,
    }),
  };
}

export function createTelegramRenderedMessageRuntime<TReplyMarkup>(
  deps: TelegramRenderedMessageRuntimeDeps<TReplyMarkup>,
): TelegramRenderedMessageRuntime<TReplyMarkup> {
  return {
    sendTextReply: async (chatId, replyToMessageId, text, options) => {
      return sendTelegramPlainReply(
        text,
        {
          renderTelegramMessage: deps.renderTelegramMessage,
          sendRenderedChunks: (chunks) =>
            deps.replyTransport.sendRenderedChunks(chatId, chunks, {
              replyToMessageId,
            }),
        },
        options,
      );
    },
    sendMarkdownReply: async (chatId, replyToMessageId, markdown, options) => {
      return sendTelegramMarkdownReply(
        markdown,
        {
          renderTelegramMessage: deps.renderTelegramMessage,
          sendRenderedChunks: (chunks, chunkOptions) =>
            deps.replyTransport.sendRenderedChunks(chatId, chunks, {
              replyToMessageId,
              replyMarkup: chunkOptions?.replyMarkup as
                | TReplyMarkup
                | undefined,
            }),
        },
        options,
      );
    },
    editInteractiveMessage: async (
      chatId,
      messageId,
      text,
      mode,
      replyMarkup,
    ) => {
      await deps.replyTransport.editRenderedMessage(
        chatId,
        messageId,
        deps.renderTelegramMessage(text, { mode }),
        { replyMarkup },
      );
    },
    sendInteractiveMessage: async (chatId, text, mode, replyMarkup) => {
      return deps.replyTransport.sendRenderedChunks(
        chatId,
        deps.renderTelegramMessage(text, { mode }),
        { replyMarkup },
      );
    },
  };
}

// --- Dedup-wrapped Reply Wrappers ---

/** Wrap a sendTextReply with reply dedup so only the first message
 *  in a turn carries `reply_to_message_id`. */
export function dedupSendTextReply(
  dedup: ReplyDedupRuntime,
  inner: (
    chatId: number,
    replyToMessageId: number | undefined,
    text: string,
    options?: { parseMode?: "HTML" },
  ) => Promise<number | undefined>,
): (
  chatId: number,
  replyToMessageId: number,
  text: string,
  options?: { parseMode?: "HTML" },
) => Promise<number | undefined> {
  return async (chatId, replyToMessageId, text, options) => {
    const effectiveReplyTo = dedup.shouldReply(replyToMessageId)
      ? replyToMessageId
      : undefined;
    return inner(chatId, effectiveReplyTo, text, options);
  };
}

/** Wrap a sendMarkdownReply with reply dedup. */
export function dedupSendMarkdownReply<TReplyMarkup = unknown>(
  dedup: ReplyDedupRuntime,
  inner: (
    chatId: number,
    replyToMessageId: number | undefined,
    markdown: string,
    options?: { replyMarkup?: TReplyMarkup },
  ) => Promise<number | undefined>,
): (
  chatId: number,
  replyToMessageId: number,
  markdown: string,
  options?: { replyMarkup?: TReplyMarkup },
) => Promise<number | undefined> {
  return async (chatId, replyToMessageId, markdown, options) => {
    const effectiveReplyTo = dedup.shouldReply(replyToMessageId)
      ? replyToMessageId
      : undefined;
    return inner(chatId, effectiveReplyTo, markdown, options);
  };
}

/**
 * Guest reply sender: renders Markdown → HTML, sends via answerGuestQuery.
 * Keeps guest rendering inside the replies domain so the orchestration layer
 * (index.ts) does not import from rendering.ts directly. */
export function createGuestMarkdownReplySender(deps: {
  renderTelegramMessage: (
    text: string,
    options?: { mode?: TelegramRenderMode },
  ) => TelegramRenderedChunk[];
  answerGuestQuery: (
    guestQueryId: string,
    text?: string,
    options?: { parseMode?: string },
  ) => Promise<void>;
}) {
  return async (guestQueryId: string, markdown: string) => {
    const chunks = deps.renderTelegramMessage(markdown, { mode: "markdown" });
    const html = chunks.length > 0 ? chunks[0].text : markdown;
    await deps.answerGuestQuery(guestQueryId, html, { parseMode: "HTML" });
  };
}
