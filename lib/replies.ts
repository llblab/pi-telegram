/**
 * Telegram reply delivery helpers
 * Zones: telegram outbound, native rich markdown, UI/compat rendering transport
 * Owns native assistant replies, rendered UI delivery, reply transport wiring, and plain text replies
 */

import { assertTelegramInlineKeyboardCallbackData } from "./keyboard.ts";
import {
  getTelegramTargetThreadParams,
  type TelegramTarget,
} from "./target.ts";
import type {
  TelegramInputRichMessage,
  TelegramReplyParameters,
  TelegramSendRichMessageBody,
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

export const TELEGRAM_RICH_MESSAGE_MAX_CHARS = 32768;
export const TELEGRAM_RICH_MESSAGE_MAX_BLOCKS = 500;

// --- Reply Dedup ---

/** Non-persistent reply deduplication for a single agent turn.
 *  First reply to a prompt gets `reply_parameters.message_id`;
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

const lastRepliedToMessageIdByTarget = new Map<string, number>();

function getReplyDedupTargetKey(
  chatId: number,
  target?: TelegramTarget,
): string {
  const threadId = target?.threadId;
  return typeof threadId === "number"
    ? `${chatId}:thread:${threadId}`
    : `${chatId}:private`;
}

export function resetTransportReplyDedup(): void {
  lastRepliedToMessageIdByTarget.clear();
}

export function buildTelegramReplyParameters(
  chatId: number,
  messageId: number | undefined,
  target?: TelegramTarget,
): TelegramReplyParameters | undefined {
  if (messageId === undefined || messageId <= 0) return undefined;
  const key = getReplyDedupTargetKey(chatId, target);
  if (lastRepliedToMessageIdByTarget.get(key) === messageId) {
    return undefined;
  }
  lastRepliedToMessageIdByTarget.set(key, messageId);
  return {
    message_id: messageId,
    allow_sending_without_reply: true,
  };
}

export function buildTelegramMultipartReplyParameters(
  chatId: number,
  messageId: number | undefined,
  target?: TelegramTarget,
): string | undefined {
  const parameters = buildTelegramReplyParameters(chatId, messageId, target);
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

export interface TelegramReplyOwnershipRecorder {
  record: (input: {
    chatId: number;
    messageId: number;
    target?: TelegramTarget;
  }) => void;
}

export interface TelegramReplyDeliveryDeps<TReplyMarkup> {
  recordOwnership?: TelegramReplyOwnershipRecorder["record"];
  sendMessage: (body: {
    chat_id: number;
    text: string;
    parse_mode?: "HTML";
    reply_markup?: TReplyMarkup;
    reply_parameters?: TelegramReplyParameters;
    reply_to_message_id?: number;
    message_thread_id?: number;
  }) => Promise<TelegramSentMessage>;
  editMessage: (body: {
    chat_id: number;
    message_id: number;
    text?: string;
    rich_message?: TelegramInputRichMessage;
    parse_mode?: "HTML";
    reply_markup?: TReplyMarkup;
    message_thread_id?: number;
  }) => Promise<unknown>;
}

export interface TelegramReplyTargetOptions {
  target?: TelegramTarget;
  replyToMessageId?: number;
}

export interface TelegramReplyTransport<TReplyMarkup> {
  sendRenderedChunks: (
    chatId: number,
    chunks: TelegramRenderedChunk[],
    options?: TelegramReplyTargetOptions & {
      replyMarkup?: TReplyMarkup;
    },
  ) => Promise<number | undefined>;
  editRenderedMessage: (
    chatId: number,
    messageId: number,
    chunks: TelegramRenderedChunk[],
    options?: TelegramReplyTargetOptions & { replyMarkup?: TReplyMarkup },
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
  options?: TelegramReplyTargetOptions & {
    replyMarkup?: TReplyMarkup;
  },
): Promise<number | undefined> {
  assertTelegramInlineKeyboardCallbackData(options?.replyMarkup);
  let lastMessageId: number | undefined;
  for (const [index, chunk] of chunks.entries()) {
    const replyParameters =
      index === 0
        ? buildTelegramReplyParameters(
            chatId,
            options?.replyToMessageId,
            options?.target,
          )
        : undefined;
    const body = {
      chat_id: chatId,
      text: chunk.text,
      parse_mode: chunk.parseMode,
      reply_markup:
        index === chunks.length - 1 ? options?.replyMarkup : undefined,
      ...(replyParameters ? { reply_parameters: replyParameters } : {}),
      ...(options?.target ? getTelegramTargetThreadParams(options.target) : {}),
    };
    const sent = await deps.sendMessage(body);
    lastMessageId = sent.message_id;
    deps.recordOwnership?.({
      chatId,
      messageId: sent.message_id,
      target: options?.target,
    });
  }
  return lastMessageId;
}

export async function editTelegramRenderedMessage<TReplyMarkup>(
  chatId: number,
  messageId: number,
  chunks: TelegramRenderedChunk[],
  deps: TelegramReplyDeliveryDeps<TReplyMarkup>,
  options?: TelegramReplyTargetOptions & { replyMarkup?: TReplyMarkup },
): Promise<number | undefined> {
  assertTelegramInlineKeyboardCallbackData(options?.replyMarkup);
  if (chunks.length === 0) return messageId;
  const [firstChunk, ...remainingChunks] = chunks;
  deps.recordOwnership?.({ chatId, messageId, target: options?.target });
  await deps.editMessage({
    chat_id: chatId,
    message_id: messageId,
    text: firstChunk.text,
    parse_mode: firstChunk.parseMode,
    reply_markup:
      remainingChunks.length === 0 ? options?.replyMarkup : undefined,
    ...(options?.target ? getTelegramTargetThreadParams(options.target) : {}),
  });
  if (remainingChunks.length > 0) {
    return sendTelegramRenderedChunks(chatId, remainingChunks, deps, {
      replyMarkup: options?.replyMarkup,
      target: options?.target,
    });
  }
  return messageId;
}

export interface TelegramTextReplyOptions extends TelegramReplyTargetOptions {
  parseMode?: "HTML";
}

export interface TelegramReplyRuntimeDeps<TReplyMarkup = unknown> {
  renderTelegramMessage: (
    text: string,
    options?: { mode?: TelegramRenderMode },
  ) => TelegramRenderedChunk[];
  sendRenderedChunks: (
    chunks: TelegramRenderedChunk[],
    options?: { replyMarkup?: TReplyMarkup } & TelegramReplyTargetOptions,
  ) => Promise<number | undefined>;
}

export async function sendTelegramPlainReply(
  text: string,
  deps: TelegramReplyRuntimeDeps,
  options?: TelegramTextReplyOptions,
): Promise<number | undefined> {
  const chunks = deps.renderTelegramMessage(text, {
    mode: options?.parseMode === "HTML" ? "html" : "plain",
  });
  return deps.sendRenderedChunks(chunks, {
    target: options?.target,
    replyToMessageId: options?.replyToMessageId,
  });
}

function normalizeIndentedTelegramNativeMarkdownList(line: string): string {
  return line.replace(
    /^( +|\t+)([-*+] |\d+\. )/,
    (_match, indent: string, marker: string) => {
      const visibleIndent = indent
        .replace(/ /g, "\u00A0")
        .replace(/\t/g, "\u00A0\u00A0");
      return `${visibleIndent}${marker}`;
    },
  );
}

function normalizeTelegramNativeMarkdownLine(line: string): string {
  let result = normalizeIndentedTelegramNativeMarkdownList(
    line.replace(/^( {0,3}>)[ \t]/, "$1"),
  );
  const codeSpans: string[] = [];
  result = result.replace(/`+[^`]*`+/g, (code) => {
    const token = `\u0000${codeSpans.length}\u0000`;
    codeSpans.push(code);
    return token;
  });
  result = result.replace(
    /(^|[^\\$])\$([A-Z][A-Z0-9]{1,})(?!\$)(?=\b|[.,;:)/-])/g,
    (_match, prefix: string, ticker: string) => `${prefix}\\$${ticker}`,
  );
  return result.replace(
    /\u0000(\d+)\u0000/g,
    (_match, index) => codeSpans[Number(index)] ?? "",
  );
}

function hasClosingDisplayMathDelimiter(
  lines: readonly string[],
  startIndex: number,
): boolean {
  let fence: { marker: "`" | "~"; length: number } | undefined;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence && line.trim() === "$$") return true;
    if (!fence && fenceMatch) {
      const markerText = fenceMatch[1] ?? "```";
      fence = { marker: markerText[0] as "`" | "~", length: markerText.length };
      continue;
    }
    if (
      fence &&
      new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`).test(line)
    ) {
      fence = undefined;
    }
  }
  return false;
}

export function normalizeTelegramNativeMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let fence: { marker: "`" | "~"; length: number } | undefined;
  let displayMath = false;
  return lines
    .map((line, index) => {
      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
      const inFence = fence !== undefined;
      if (!inFence && line.trim() === "$$") {
        if (displayMath) {
          displayMath = false;
          return "```";
        }
        if (hasClosingDisplayMathDelimiter(lines, index)) {
          displayMath = true;
          return "```math";
        }
      }
      if (displayMath) return line;
      if (!inFence && fenceMatch) {
        const markerText = fenceMatch[1] ?? "```";
        fence = {
          marker: markerText[0] as "`" | "~",
          length: markerText.length,
        };
        return line;
      }
      if (
        inFence &&
        new RegExp(`^ {0,3}${fence?.marker}{${fence?.length},}\\s*$`).test(line)
      ) {
        fence = undefined;
        return line;
      }
      if (!inFence) return normalizeTelegramNativeMarkdownLine(line);
      return line;
    })
    .join("\n");
}

export function splitTelegramNativeMarkdown(markdown: string): string[] {
  const normalizedMarkdown = normalizeTelegramNativeMarkdown(markdown);
  if (
    normalizedMarkdown.length <= TELEGRAM_RICH_MESSAGE_MAX_CHARS &&
    countTelegramNativeMarkdownBlocks(normalizedMarkdown) <=
      TELEGRAM_RICH_MESSAGE_MAX_BLOCKS
  ) {
    return [normalizedMarkdown];
  }
  const chunks: string[] = [];
  let current = "";
  let currentBlockCount = 0;
  for (const rawBlock of splitTelegramNativeMarkdownBlocks(
    normalizedMarkdown,
  )) {
    for (const block of splitTelegramNativeMarkdownCountedBlocks(rawBlock)) {
      const blockCount = countTelegramNativeMarkdownBlocks(block);
      const candidate = current ? `${current}\n\n${block}` : block;
      const exceedsChars = candidate.length > TELEGRAM_RICH_MESSAGE_MAX_CHARS;
      const exceedsBlocks =
        currentBlockCount + blockCount > TELEGRAM_RICH_MESSAGE_MAX_BLOCKS;
      if (!exceedsChars && !exceedsBlocks) {
        current = candidate;
        currentBlockCount += blockCount;
        continue;
      }
      if (current) chunks.push(current.trimEnd());
      if (
        block.length <= TELEGRAM_RICH_MESSAGE_MAX_CHARS &&
        blockCount <= TELEGRAM_RICH_MESSAGE_MAX_BLOCKS
      ) {
        current = block;
        currentBlockCount = blockCount;
        continue;
      }
      chunks.push(...splitTelegramNativeMarkdownLongBlock(block));
      current = "";
      currentBlockCount = 0;
    }
  }
  if (current) chunks.push(current.trimEnd());
  return chunks;
}

function splitTelegramNativeMarkdownBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const current: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | undefined;
  const flush = (): void => {
    if (current.length === 0) return;
    blocks.push(current.join("\n"));
    current.length = 0;
  };
  for (const line of markdown.split("\n")) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence && line.trim().length === 0) {
      flush();
      continue;
    }
    current.push(line);
    if (!fence && fenceMatch) {
      const markerText = fenceMatch[1] ?? "```";
      fence = { marker: markerText[0] as "`" | "~", length: markerText.length };
      continue;
    }
    if (
      fence &&
      new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`).test(line)
    ) {
      fence = undefined;
    }
  }
  flush();
  return blocks;
}

function splitTelegramNativeMarkdownCountedBlocks(block: string): string[] {
  if (
    countTelegramNativeMarkdownBlocks(block) <= TELEGRAM_RICH_MESSAGE_MAX_BLOCKS
  ) {
    return [block];
  }
  const chunks: string[] = [];
  let current: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | undefined;
  for (const line of block.split("\n")) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence && current.length >= TELEGRAM_RICH_MESSAGE_MAX_BLOCKS) {
      chunks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
    if (!fence && fenceMatch) {
      const markerText = fenceMatch[1] ?? "```";
      fence = { marker: markerText[0] as "`" | "~", length: markerText.length };
      continue;
    }
    if (
      fence &&
      new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`).test(line)
    ) {
      fence = undefined;
    }
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks;
}

function countTelegramNativeMarkdownBlocks(block: string): number {
  if (/^ {0,3}(`{3,}|~{3,})/.test(block)) return 1;
  const lines = block.split("\n").filter((line) => line.trim().length > 0);
  if (lines.some((line) => /^\s*([-*+] |\d+\. |>|\|)/.test(line))) {
    return Math.max(1, lines.length);
  }
  return 1;
}

function splitTelegramNativeMarkdownLongBlock(block: string): string[] {
  return (
    splitTelegramNativeMarkdownLongFenceBlock(block) ??
    splitTelegramNativeMarkdownLongWrappedInlineBlock(block) ??
    splitTelegramNativeMarkdownLongPlainBlock(block)
  );
}

function splitTelegramNativeMarkdownLongPlainBlock(block: string): string[] {
  const chunks: string[] = [];
  let remaining = block;
  while (remaining.length > TELEGRAM_RICH_MESSAGE_MAX_CHARS) {
    const window = remaining.slice(0, TELEGRAM_RICH_MESSAGE_MAX_CHARS + 1);
    const splitIndex = findTelegramNativeMarkdownSplitIndex(window);
    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function splitTelegramNativeMarkdownLongFenceBlock(
  block: string,
): string[] | undefined {
  const lines = block.split("\n");
  const opening = lines[0] ?? "";
  const closing = lines[lines.length - 1] ?? "";
  const openingMatch = opening?.match(/^ {0,3}(`{3,}|~{3,})/);
  if (!openingMatch || !closing || lines.length < 2) return undefined;
  const markerText = openingMatch[1] ?? "```";
  const marker = markerText[0] as "`" | "~";
  if (
    !new RegExp(`^ {0,3}${marker}{${markerText.length},}\\s*$`).test(closing)
  ) {
    return undefined;
  }
  const maxContentLength =
    TELEGRAM_RICH_MESSAGE_MAX_CHARS - opening.length - closing.length - 2;
  if (maxContentLength <= 0) return undefined;
  const content = lines.slice(1, -1).join("\n");
  return splitTelegramNativeMarkdownWrappedContent(
    content,
    maxContentLength,
    (chunk) =>
      `${opening}\n${chunk}${chunk.endsWith("\n") ? "" : "\n"}${closing}`,
  );
}

function splitTelegramNativeMarkdownLongWrappedInlineBlock(
  block: string,
): string[] | undefined {
  const delimiter = ["**", "__", "~~", "`", "*", "_"].find(
    (candidate) =>
      block.startsWith(candidate) &&
      block.endsWith(candidate) &&
      block.length > candidate.length * 2,
  );
  if (!delimiter) return undefined;
  const maxContentLength =
    TELEGRAM_RICH_MESSAGE_MAX_CHARS - delimiter.length * 2;
  if (maxContentLength <= 0) return undefined;
  return splitTelegramNativeMarkdownWrappedContent(
    block.slice(delimiter.length, -delimiter.length),
    maxContentLength,
    (chunk) => `${delimiter}${chunk}${delimiter}`,
  );
}

function splitTelegramNativeMarkdownWrappedContent(
  content: string,
  maxContentLength: number,
  wrap: (chunk: string) => string,
): string[] {
  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > maxContentLength) {
    const window = remaining.slice(0, maxContentLength + 1);
    const splitIndex = findTelegramNativeMarkdownSplitIndex(
      window,
      maxContentLength,
    );
    chunks.push(wrap(remaining.slice(0, splitIndex)));
    remaining = remaining.slice(splitIndex);
  }
  if (remaining.length > 0) chunks.push(wrap(remaining));
  return chunks;
}

function findTelegramNativeMarkdownSplitIndex(
  text: string,
  hardLimit = TELEGRAM_RICH_MESSAGE_MAX_CHARS,
): number {
  const paragraphIndex = text.lastIndexOf("\n\n", hardLimit);
  if (paragraphIndex > 0) return paragraphIndex + 2;
  const lineIndex = text.lastIndexOf("\n", hardLimit);
  if (lineIndex > 0) return lineIndex + 1;
  const spaceIndex = text.lastIndexOf(" ", hardLimit);
  if (spaceIndex > 0) return spaceIndex + 1;
  return hardLimit;
}

export async function sendTelegramNativeMarkdownReply<TReplyMarkup = unknown>(
  chatId: number,
  replyToMessageId: number | undefined,
  markdown: string,
  deps: {
    recordOwnership?: TelegramReplyOwnershipRecorder["record"];
    sendRichMessage: (
      body: TelegramSendRichMessageBody,
    ) => Promise<TelegramSentMessage>;
  },
  options?: TelegramReplyTargetOptions & { replyMarkup?: TReplyMarkup },
): Promise<number | undefined> {
  assertTelegramInlineKeyboardCallbackData(options?.replyMarkup);
  let lastMessageId: number | undefined;
  const chunks = splitTelegramNativeMarkdown(markdown);
  for (const [index, chunk] of chunks.entries()) {
    const replyParameters =
      index === 0
        ? buildTelegramReplyParameters(
            chatId,
            replyToMessageId,
            options?.target,
          )
        : undefined;
    const sent = await deps.sendRichMessage({
      chat_id: chatId,
      rich_message: { markdown: chunk, skip_entity_detection: true },
      reply_markup:
        index === chunks.length - 1 ? options?.replyMarkup : undefined,
      ...(replyParameters ? { reply_parameters: replyParameters } : {}),
      ...(options?.target ? getTelegramTargetThreadParams(options.target) : {}),
    });
    lastMessageId = sent.message_id;
    deps.recordOwnership?.({
      chatId,
      messageId: sent.message_id,
      target: options?.target,
    });
  }
  return lastMessageId;
}

// UI/compat regular-message runtime for bridge-owned text and interactive
// surfaces. Assistant and guest Markdown delivery bypass this path and use
// native Rich Message helpers above.
export type TelegramAssistantRenderingMode = "rich" | "html";

export interface TelegramRenderedMessageRuntimeDeps<TReplyMarkup> {
  renderTelegramMessage: (
    text: string,
    options?: { mode?: TelegramRenderMode },
  ) => TelegramRenderedChunk[];
  replyTransport: TelegramReplyTransport<TReplyMarkup>;
  recordOwnership?: TelegramReplyOwnershipRecorder["record"];
  getAssistantRenderingMode?: () => TelegramAssistantRenderingMode;
  sendRichMessage: (
    body: TelegramSendRichMessageBody,
  ) => Promise<TelegramSentMessage>;
}

export interface TelegramRenderedMessageRuntime<TReplyMarkup> {
  sendTextReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    text: string,
    options?: TelegramTextReplyOptions,
  ) => Promise<number | undefined>;
  sendMarkdownReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    markdown: string,
    options?: TelegramReplyTargetOptions & { replyMarkup?: TReplyMarkup },
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
    options?: TelegramReplyTargetOptions,
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
  getAssistantRenderingMode?: () => TelegramAssistantRenderingMode;
  sendRichMessage: (
    body: TelegramSendRichMessageBody,
  ) => Promise<TelegramSentMessage>;
}

export function createTelegramRenderedMessageDeliveryRuntime<TReplyMarkup>(
  deps: TelegramRenderedMessageDeliveryRuntimeDeps<TReplyMarkup>,
): TelegramRenderedMessageDeliveryRuntime<TReplyMarkup> {
  const replyTransport = buildTelegramReplyTransport({
    recordOwnership: deps.recordOwnership,
    sendMessage: deps.sendMessage,
    editMessage: deps.editMessage,
  });
  return {
    replyTransport,
    ...createTelegramRenderedMessageRuntime({
      renderTelegramMessage:
        deps.renderTelegramMessage ?? renderTelegramMessage,
      replyTransport,
      recordOwnership: deps.recordOwnership,
      getAssistantRenderingMode: deps.getAssistantRenderingMode,
      sendRichMessage: deps.sendRichMessage,
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
          sendRenderedChunks: (chunks, chunkOptions) =>
            deps.replyTransport.sendRenderedChunks(chatId, chunks, {
              target: chunkOptions?.target,
              replyToMessageId:
                chunkOptions?.replyToMessageId ?? replyToMessageId,
            }),
        },
        options,
      );
    },
    sendMarkdownReply: async (chatId, replyToMessageId, markdown, options) => {
      const renderingMode = deps.getAssistantRenderingMode?.() ?? "rich";
      if (
        renderingMode === "html" ||
        (typeof options?.target?.threadId === "number" &&
          replyToMessageId !== undefined &&
          replyToMessageId > 0)
      ) {
        return deps.replyTransport.sendRenderedChunks(
          chatId,
          deps.renderTelegramMessage(markdown, { mode: "markdown" }),
          {
            replyMarkup: options?.replyMarkup,
            target: options?.target,
            replyToMessageId,
          },
        );
      }
      return sendTelegramNativeMarkdownReply(
        chatId,
        replyToMessageId,
        markdown,
        {
          recordOwnership: deps.recordOwnership,
          sendRichMessage: deps.sendRichMessage,
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
    sendInteractiveMessage: async (
      chatId,
      text,
      mode,
      replyMarkup,
      options,
    ) => {
      return deps.replyTransport.sendRenderedChunks(
        chatId,
        deps.renderTelegramMessage(text, { mode }),
        {
          replyMarkup,
          target: options?.target,
          replyToMessageId: options?.replyToMessageId,
        },
      );
    },
  };
}

// --- Dedup-wrapped Reply Wrappers ---

/** Wrap a sendTextReply with reply dedup so only the first message
 *  in a turn carries reply metadata. */
export function dedupSendTextReply(
  dedup: ReplyDedupRuntime,
  inner: (
    chatId: number,
    replyToMessageId: number | undefined,
    text: string,
    options?: TelegramTextReplyOptions,
  ) => Promise<number | undefined>,
): (
  chatId: number,
  replyToMessageId: number,
  text: string,
  options?: TelegramTextReplyOptions,
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
 * Guest reply sender: answers guest queries with native Rich Markdown content.
 * Guest queries use InlineQueryResult input_message_content rather than chat
 * sendRichMessage, so this stays as a dedicated guest transport adapter.
 */
export function createGuestMarkdownReplySender(deps: {
  answerGuestQuery: (
    guestQueryId: string,
    text?: string,
    options?: { parseMode?: string; richMessage?: TelegramInputRichMessage },
  ) => Promise<void>;
}) {
  return async (guestQueryId: string, markdown: string) => {
    const [richMarkdown = markdown] = splitTelegramNativeMarkdown(markdown);
    await deps.answerGuestQuery(guestQueryId, undefined, {
      richMessage: { markdown: richMarkdown, skip_entity_detection: true },
    });
  };
}
