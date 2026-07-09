/**
 * Telegram turn-building helpers
 * Zones: telegram inbound, pi agent prompt content, queue
 * Owns prompt-turn summary and content construction so queued Telegram turns are assembled consistently
 */

import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  buildTelegramReplyContextBlock,
  collectTelegramMessageIds,
  downloadTelegramMessageFiles,
  extractTelegramForwardContextText,
  extractTelegramMessagesPromptText,
  extractTelegramMessagesText,
  formatTelegramHistoryText,
  guessMediaType,
  type DownloadedTelegramMessageFile,
  type DownloadTelegramMessageFilesDeps,
  type TelegramMediaMessage,
} from "./media.ts";
import type {
  PendingTelegramTurn,
  TelegramPromptContent,
  TelegramQueueItem,
  TelegramQueueStore,
} from "./queue.ts";

import {
  computeVoicePromptContribution,
  computeVoiceTurnFlags,
  getTelegramVoiceReplyMode,
  TELEGRAM_VOICE_REPLY_MODES,
  type TelegramVoiceReplyMode,
} from "./voice.ts";

// Re-export for backward compatibility with existing namespace imports (e.g. Turns.getTelegramVoiceReplyMode in routing.ts)
export {
  getTelegramVoiceReplyMode,
  TELEGRAM_VOICE_REPLY_MODES,
  type TelegramVoiceReplyMode,
};

export const TELEGRAM_PREFIX = "[telegram]";

export interface TelegramTurnTarget {
  chatId: number;
  threadId?: number;
}

export interface TelegramTurnMessage {
  message_id: number;
  message_thread_id?: number;
  chat: { id: number; type?: string };
}

export type DownloadedTelegramTurnFile = DownloadedTelegramMessageFile;

function getTelegramTurnTarget(message: TelegramTurnMessage): TelegramTurnTarget {
  return Number.isInteger(message.message_thread_id)
    ? { chatId: message.chat.id, threadId: message.message_thread_id }
    : { chatId: message.chat.id };
}

function formatTelegramPrefixAttributeValue(value: string): string {
  return value.replace(/[\]\n\r|]+/g, " ").replace(/\s+/g, " ").trim();
}

export function createTelegramTurnPrefix(
  attributes: Record<string, string | undefined> = {},
): string {
  const parts = [TELEGRAM_PREFIX.slice(1, -1)];
  for (const [key, value] of Object.entries(attributes)) {
    const normalized = value ? formatTelegramPrefixAttributeValue(value) : "";
    if (normalized) parts.push(`${key}:${normalized}`);
  }
  return `[${parts.join("|")}]`;
}

export function formatTelegramTurnPrefix(
  _message: TelegramTurnMessage,
  basePrefix = TELEGRAM_PREFIX,
): string {
  return basePrefix;
}

import { truncateTelegramQueueSummary } from "./queue.ts";
export { truncateTelegramQueueSummary };

export function formatTelegramTurnStatusSummary(
  rawText: string,
  files: DownloadedTelegramTurnFile[],
  handlerOutputs: string[] = [],
): string {
  const textSummary = truncateTelegramQueueSummary(rawText);
  if (textSummary) return textSummary;
  const handlerSummary = truncateTelegramQueueSummary(handlerOutputs.join(" "));
  if (handlerSummary) return handlerSummary;
  if (files.length === 1) {
    const fileName = basename(
      files[0]?.fileName || files[0]?.path || "attachment",
    );
    return `📎 ${truncateTelegramQueueSummary(fileName, 4, 32) || "attachment"}`;
  }
  if (files.length > 1) return `📎 ${files.length} attachments`;
  return "(empty message)";
}

function appendTelegramListSection(
  text: string,
  title: string,
  items: string[],
): string {
  if (items.length === 0) return text;
  const prefix = text.length > 0 ? `${text}\n\n` : "";
  return `${prefix}[${title}]\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function appendTelegramAttachmentSection(
  text: string,
  files: Pick<DownloadedTelegramTurnFile, "path">[],
): string {
  if (files.length === 0) return text;
  const dirs = [...new Set(files.map((file) => dirname(file.path)))];
  const sameDir = dirs.length === 1;
  const header = sameDir ? `[attachments] ${dirs[0]}` : "[attachments]";
  const items = sameDir
    ? files.map((file) => `/${basename(file.path)}`)
    : files.map((file) => file.path);
  const prefix = text.length > 0 ? `${text}\n\n` : "";
  return `${prefix}${header}\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function appendTelegramSourceContext(text: string, sourceContext: string | undefined): string {
  if (!sourceContext) return text;
  return text ? `${text}\n\n${sourceContext}` : sourceContext;
}

function appendTelegramPromptText(prompt: string, rawText: string): string {
  if (!rawText) return prompt;
  if (rawText.startsWith("\n")) return `${prompt}${rawText}`;
  return `${prompt} ${rawText}`;
}

function appendTelegramVoiceContext(
  prompt: string,
  entries: Record<string, string>,
): string {
  const prefix = prompt.length > 0 ? `${prompt}\n\n` : "";
  const pairs = Object.entries(entries);
  if (pairs.length === 1) {
    const [key, value] = pairs[0];
    return `${prefix}[voice] ${key}: ${value}`;
  }
  return `${prefix}[voice]\n${pairs
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n")}`;
}

// --- Voice Policy And Tagging ---

export function buildTelegramTurnPrompt(options: {
  telegramPrefix: string;
  rawText: string;
  files: DownloadedTelegramTurnFile[];
  promptFiles?: DownloadedTelegramTurnFile[];
  handlerOutputs?: string[];
  sourceContext?: string;
  historyTurns?: Pick<PendingTelegramTurn, "historyText">[];
  timeLine?: string | null;
  voiceContext?: Record<string, string>;
}): string {
  let prompt = options.telegramPrefix;
  if ((options.historyTurns?.length ?? 0) > 0) {
    prompt +=
      "\n\nEarlier Telegram messages arrived after an aborted turn. Treat them as prior user messages, in order:";
    for (const [index, turn] of (options.historyTurns ?? []).entries()) {
      prompt += `\n\n${index + 1}. ${turn.historyText}`;
    }
    prompt += "\n\nCurrent Telegram message:";
  }
  if (options.rawText.length > 0) {
    prompt =
      (options.historyTurns?.length ?? 0) > 0
        ? `${prompt}\n${options.rawText}`
        : appendTelegramPromptText(prompt, options.rawText);
  }
  const promptFiles = options.promptFiles ?? options.files;
  prompt = appendTelegramAttachmentSection(prompt, promptFiles);
  prompt = appendTelegramSourceContext(prompt, options.sourceContext);
  prompt = appendTelegramListSection(
    prompt,
    "outputs",
    options.handlerOutputs ?? [],
  );
  if (options.voiceContext) {
    prompt = appendTelegramVoiceContext(prompt, options.voiceContext);
  }
  if (options.timeLine) {
    prompt = `${prompt}\n\n[time] ${options.timeLine}`;
  }
  return prompt;
}

function splitTelegramPromptAttachmentSuffix(prompt: string): {
  promptWithoutAttachments: string;
  attachmentSuffix: string;
  attachmentFiles: DownloadedTelegramTurnFile[];
} {
  const marker = "\n\n[attachments]";
  const markerIndex = prompt.indexOf(marker);
  if (markerIndex === -1) {
    return {
      promptWithoutAttachments: prompt,
      attachmentSuffix: "",
      attachmentFiles: [],
    };
  }
  const promptWithoutAttachments = prompt.slice(0, markerIndex);
  const attachmentSuffix = prompt.slice(markerIndex);
  const attachmentLines: string[] = [];
  let readingAttachments = false;
  let attachmentDir: string | undefined;
  for (const line of attachmentSuffix.split("\n")) {
    const trimmed = line.trim();
    const attachmentMatch = trimmed.match(/^\[attachments\](?:\s+(.+))?$/);
    if (attachmentMatch) {
      readingAttachments = true;
      attachmentDir = attachmentMatch[1]?.trim();
      continue;
    }
    if (readingAttachments && /^\[[^\]]+\](?:\s+.*)?$/.test(trimmed)) break;
    if (readingAttachments) attachmentLines.push(line);
  }
  const attachmentFiles = attachmentLines
    .map((line) => line.match(/^- (.+)$/)?.[1]?.trim())
    .filter((path): path is string => !!path)
    .map((path) =>
      attachmentDir ? join(attachmentDir, path.replace(/^\/+/, "")) : path,
    )
    .map((path) => ({
      path,
      fileName: basename(path),
      isImage: false,
      kind: "document" as const,
    }));
  return { promptWithoutAttachments, attachmentSuffix, attachmentFiles };
}

function buildEditedTelegramPromptText(options: {
  existingPrompt: string;
  telegramPrefix: string;
  rawText: string;
}): { text: string; attachmentFiles: DownloadedTelegramTurnFile[] } {
  const { promptWithoutAttachments, attachmentSuffix, attachmentFiles } =
    splitTelegramPromptAttachmentSuffix(options.existingPrompt);
  const currentMessageMarker = "Current Telegram message:";
  const currentMessageIndex =
    promptWithoutAttachments.lastIndexOf(currentMessageMarker);
  if (currentMessageIndex !== -1) {
    const prefix = promptWithoutAttachments.slice(
      0,
      currentMessageIndex + currentMessageMarker.length,
    );
    const separator = options.rawText.length > 0 ? "\n" : "";
    return {
      text: `${prefix}${separator}${options.rawText}${attachmentSuffix}`,
      attachmentFiles,
    };
  }
  return {
    text: `${appendTelegramPromptText(
      options.telegramPrefix,
      options.rawText,
    )}${attachmentSuffix}`,
    attachmentFiles,
  };
}

export function updateTelegramPromptTurnText(options: {
  turn: PendingTelegramTurn;
  telegramPrefix: string;
  rawText: string;
  statusText?: string;
}): PendingTelegramTurn {
  let attachmentFiles: DownloadedTelegramTurnFile[] = [];
  const nextContent = options.turn.content.map((block, index) => {
    if (index !== 0 || block.type !== "text") return block;
    const updated = buildEditedTelegramPromptText({
      existingPrompt: block.text,
      telegramPrefix: options.telegramPrefix,
      rawText: options.rawText,
    });
    attachmentFiles = updated.attachmentFiles;
    return {
      ...block,
      text: updated.text,
    };
  });
  return {
    ...options.turn,
    content: nextContent,
    historyText: formatTelegramHistoryText(options.rawText, attachmentFiles),
    statusSummary: formatTelegramTurnStatusSummary(
      options.statusText ?? options.rawText,
      attachmentFiles,
    ),
  };
}

export function updateQueuedTelegramPromptTurnText<
  TContext = unknown,
>(options: {
  items: TelegramQueueItem<TContext>[];
  sourceMessageId: number | undefined;
  telegramPrefix: string;
  rawText: string;
  statusText?: string;
}): { items: TelegramQueueItem<TContext>[]; changed: boolean } {
  if (options.sourceMessageId === undefined) {
    return { items: options.items, changed: false };
  }
  let changed = false;
  const items = options.items.map((item) => {
    if (
      item.kind !== "prompt" ||
      !item.sourceMessageIds.includes(options.sourceMessageId as number)
    ) {
      return item;
    }
    changed = true;
    return updateTelegramPromptTurnText({
      turn: item,
      telegramPrefix: options.telegramPrefix,
      rawText: options.rawText,
      statusText: options.statusText,
    });
  });
  return { items, changed };
}

export interface TelegramQueuedPromptEditRuntimeDeps<
  TContext = unknown,
> extends TelegramQueueStore<TContext> {
  updateStatus: (ctx: TContext) => void;
}

export function createTelegramQueuedPromptEditRuntime<
  TMessage extends TelegramMediaMessage,
  TContext = unknown,
>(deps: TelegramQueuedPromptEditRuntimeDeps<TContext>) {
  return {
    updateFromEditedMessage: (message: TMessage, ctx: TContext): boolean => {
      const { changed, items } = updateQueuedTelegramPromptTurnText({
        items: deps.getQueuedItems(),
        sourceMessageId: message.message_id,
        telegramPrefix: TELEGRAM_PREFIX,
        rawText: extractTelegramMessagesPromptText([message]),
        statusText: extractTelegramMessagesText([message]),
      });
      deps.setQueuedItems(items);
      if (changed) deps.updateStatus(ctx);
      return changed;
    },
  };
}

export interface BuildTelegramPromptTurnOptions {
  telegramPrefix: string;
  messages: TelegramTurnMessage[];
  historyTurns?: PendingTelegramTurn[];
  queueOrder: number;
  rawText: string;
  statusText?: string;
  files: DownloadedTelegramTurnFile[];
  promptFiles?: DownloadedTelegramTurnFile[];
  handlerOutputs?: string[];
  sourceContext?: string;
  timeLine?: string | null;
  readBinaryFile: (path: string) => Promise<Uint8Array>;
  inferImageMimeType: (path: string) => string | undefined;
  voiceReplyMode?: TelegramVoiceReplyMode;
  voiceReplyModeConfigured?: boolean;
  voicePromptContribution?: string;
}

export type BuildTelegramPromptTurnRuntimeOptions = Omit<
  BuildTelegramPromptTurnOptions,
  "readBinaryFile"
>;

export interface TelegramPromptTurnRuntimeBuilderDeps<
  TContext = unknown,
> extends DownloadTelegramMessageFilesDeps {
  allocateQueueOrder: () => number;
  processAttachments?: (
    files: DownloadedTelegramTurnFile[],
    rawText: string,
    ctx: TContext,
  ) => Promise<{
    rawText: string;
    promptFiles?: DownloadedTelegramTurnFile[];
    handlerOutputs?: string[];
  }>;
  resolveTimeLine?: (chatId: number) => string | null;
  getVoiceReplyMode?: () => TelegramVoiceReplyMode;
  isVoiceReplyModeConfigured?: () => boolean;
  /** Returns the visible thread label for a message target, used to add thread context to the prompt prefix. */
  getTelegramThreadLabel?: (message: { chat: { id: number }; message_thread_id?: number }) => string | undefined;
  getAllowedUserId?: () => number | undefined;
}

export function createTelegramPromptTurnRuntimeBuilder<
  TMessage extends TelegramTurnMessage & TelegramMediaMessage,
  TContext = unknown,
>(
  deps: TelegramPromptTurnRuntimeBuilderDeps<TContext>,
): (
  messages: TMessage[],
  historyTurns?: PendingTelegramTurn[],
  ctx?: TContext,
) => Promise<PendingTelegramTurn> {
  return async (messages, historyTurns = [], ctx) => {
    const rawText = extractTelegramMessagesText(messages);
    const firstMessage = messages[0];
    const replyFiles = firstMessage?.reply_to_message
      ? await downloadTelegramMessageFiles(
          [firstMessage.reply_to_message as typeof firstMessage],
          { downloadFile: deps.downloadFile },
        )
      : [];
    const replyContext = firstMessage
      ? buildTelegramReplyContextBlock(firstMessage, replyFiles)
      : "";
    const forwardContext = firstMessage
      ? extractTelegramForwardContextText(firstMessage, deps.getAllowedUserId?.())
      : "";
    const files = await downloadTelegramMessageFiles(messages, {
      downloadFile: deps.downloadFile,
    });
    const processed = deps.processAttachments
      ? await deps.processAttachments(files, rawText, ctx as TContext)
      : { rawText, promptFiles: files };
    const sourceBlocks: string[] = [];
    let promptRawText = processed.rawText;
    if (forwardContext) {
      sourceBlocks.push(
        `[forward|${forwardContext.replace(/:\s+/g, ":")}]${
          processed.rawText ? ` ${processed.rawText}` : ""
        }`,
      );
      promptRawText = "";
    }
    if (replyContext) sourceBlocks.push(replyContext);
    const sourceContext = sourceBlocks.join("\n\n");
    // Compute voice mode once and pass it to both the turn builder and the prompt contribution helper
    const voiceReplyMode = deps.getVoiceReplyMode?.();
    const chatId = messages[0]?.chat.id;
    const timeLine =
      deps.resolveTimeLine && chatId !== undefined
        ? deps.resolveTimeLine(chatId)
        : null;
    const threadLabel = firstMessage
      ? deps.getTelegramThreadLabel?.(firstMessage)
      : undefined;
    const telegramPrefix = createTelegramTurnPrefix({ thread: threadLabel });
    return buildTelegramPromptTurnRuntime({
      telegramPrefix,
      messages,
      historyTurns,
      queueOrder: deps.allocateQueueOrder(),
      rawText: promptRawText,
      sourceContext,
      statusText: processed.rawText,
      files,
      promptFiles: processed.promptFiles,
      handlerOutputs: processed.handlerOutputs,
      timeLine,
      inferImageMimeType: guessMediaType,
      voiceReplyMode,
      voiceReplyModeConfigured: deps.isVoiceReplyModeConfigured?.(),
      voicePromptContribution: computeVoicePromptContribution(
        voiceReplyMode,
        files,
        rawText,
      ),
    });
  };
}

function getTelegramVoicePromptContext(
  voiceReplyMode: TelegramVoiceReplyMode,
  hasVoiceFile: boolean,
): Record<string, string> | undefined {
  if (voiceReplyMode === "always") return { "reply mode": "always" };
  if (!hasVoiceFile) return undefined;
  return { "reply mode": voiceReplyMode };
}

export async function buildTelegramPromptTurn(
  options: BuildTelegramPromptTurnOptions,
): Promise<PendingTelegramTurn> {
  const firstMessage = options.messages[0];
  if (!firstMessage) {
    throw new Error("Missing Telegram message for turn creation");
  }
  const hasVoiceFile = options.files.some(
    (f) => f.kind === "voice" || f.kind === "audio",
  );
  const voiceReplyMode = options.voiceReplyMode ?? getTelegramVoiceReplyMode();
  const showVoiceContext =
    options.voiceReplyModeConfigured ?? options.voiceReplyMode !== undefined;
  const content: TelegramPromptContent[] = [
    {
      type: "text",
      text: buildTelegramTurnPrompt({
        telegramPrefix: formatTelegramTurnPrefix(
          firstMessage,
          options.telegramPrefix,
        ),
        rawText: options.rawText,
        files: options.files,
        promptFiles: options.promptFiles,
        handlerOutputs: options.handlerOutputs,
        sourceContext: options.sourceContext,
        historyTurns: options.historyTurns,
        timeLine: options.timeLine,
        voiceContext: showVoiceContext
          ? getTelegramVoicePromptContext(voiceReplyMode, hasVoiceFile)
          : undefined,
      }),
    },
  ];
  for (const file of options.files) {
    if (!file.isImage) continue;
    const mediaType = file.mimeType || options.inferImageMimeType(file.path);
    if (!mediaType) continue;
    const buffer = await options.readBinaryFile(file.path);
    content.push({
      type: "image",
      data: Buffer.from(buffer).toString("base64"),
      mimeType: mediaType,
    });
  }
  if (options.voicePromptContribution?.trim()) {
    const textItem = content.find((c) => c.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    if (textItem) {
      textItem.text = `${textItem.text}\n\n${options.voicePromptContribution.trim()}`;
    }
  }

  return {
    kind: "prompt",
    chatId: firstMessage.chat.id,
    target: getTelegramTurnTarget(firstMessage),
    replyToMessageId: firstMessage.message_id,
    sourceMessageIds: collectTelegramMessageIds(options.messages),
    queueOrder: options.queueOrder,
    queueLane: "default",
    laneOrder: options.queueOrder,
    queuedAttachments: [],
    content,
    historyText: appendTelegramSourceContext(
      formatTelegramHistoryText(
        options.rawText,
        options.promptFiles ?? options.files,
        options.handlerOutputs,
      ),
      options.sourceContext,
    ),
    statusSummary: formatTelegramTurnStatusSummary(
      options.statusText ?? options.rawText,
      options.promptFiles ?? options.files,
      options.handlerOutputs,
    ),
    // Voice tagging (used for preview suppression and prompt guidance)
    ...computeVoiceTurnFlags(voiceReplyMode, hasVoiceFile),
  };
}

export async function buildTelegramPromptTurnRuntime(
  options: BuildTelegramPromptTurnRuntimeOptions,
): Promise<PendingTelegramTurn> {
  return buildTelegramPromptTurn({
    ...options,
    readBinaryFile: readFile,
  });
}
