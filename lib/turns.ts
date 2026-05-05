/**
 * Telegram turn-building helpers
 * Zones: telegram inbound, pi agent prompt content, queue
 * Owns prompt-turn summary and content construction so queued Telegram turns are assembled consistently
 */

import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  collectTelegramMessageIds,
  type DownloadedTelegramMessageFile,
  type DownloadTelegramMessageFilesDeps,
  downloadTelegramMessageFiles,
  extractTelegramMessagesPromptText,
  extractTelegramMessagesText,
  appendTelegramReplyContext,
  extractTelegramReplyContextText,
  formatTelegramHistoryText,
  guessMediaType,
  type TelegramMediaMessage,
} from "./media.ts";
import type {
  PendingTelegramTurn,
  TelegramPromptContent,
  TelegramQueueItem,
  TelegramQueueStore,
} from "./queue.ts";

export const TELEGRAM_PREFIX = "[telegram]";

export interface TelegramTurnMessage {
  message_id: number;
  chat: { id: number };
}

export type DownloadedTelegramTurnFile = DownloadedTelegramMessageFile;

export function truncateTelegramQueueSummary(
  text: string,
  maxWords = 5,
  maxLength = 40,
): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const words = normalized.split(" ");
  let summary = words.slice(0, maxWords).join(" ");
  if (summary.length === 0) summary = normalized;
  if (summary.length > maxLength) {
    summary = summary.slice(0, maxLength).trimEnd();
  }
  return summary.length < normalized.length || words.length > maxWords
    ? `${summary}…`
    : summary;
}

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

function appendTelegramPromptText(prompt: string, rawText: string): string {
  if (!rawText) return prompt;
  return `${prompt} ${rawText}`;
}

export function buildTelegramTurnPrompt(options: {
  telegramPrefix: string;
  rawText: string;
  files: DownloadedTelegramTurnFile[];
  promptFiles?: DownloadedTelegramTurnFile[];
  handlerOutputs?: string[];
  historyTurns?: Pick<PendingTelegramTurn, "historyText">[];
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
  prompt = appendTelegramListSection(
    prompt,
    "outputs",
    options.handlerOutputs ?? [],
  );
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
  readBinaryFile: (path: string) => Promise<Uint8Array>;
  inferImageMimeType: (path: string) => string | undefined;
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
    const replyContext = messages[0]
      ? extractTelegramReplyContextText(messages[0])
      : "";
    const files = await downloadTelegramMessageFiles(messages, {
      downloadFile: deps.downloadFile,
    });
    const processed = deps.processAttachments
      ? await deps.processAttachments(files, rawText, ctx as TContext)
      : { rawText, promptFiles: files };
    const promptText = appendTelegramReplyContext(
      processed.rawText,
      replyContext,
    );
    return buildTelegramPromptTurnRuntime({
      telegramPrefix: TELEGRAM_PREFIX,
      messages,
      historyTurns,
      queueOrder: deps.allocateQueueOrder(),
      rawText: promptText,
      statusText: processed.rawText,
      files,
      promptFiles: processed.promptFiles,
      handlerOutputs: processed.handlerOutputs,
      inferImageMimeType: guessMediaType,
    });
  };
}

export async function buildTelegramPromptTurn(
  options: BuildTelegramPromptTurnOptions,
): Promise<PendingTelegramTurn> {
  const firstMessage = options.messages[0];
  if (!firstMessage) {
    throw new Error("Missing Telegram message for turn creation");
  }
  const content: TelegramPromptContent[] = [
    {
      type: "text",
      text: buildTelegramTurnPrompt({
        telegramPrefix: options.telegramPrefix,
        rawText: options.rawText,
        files: options.files,
        promptFiles: options.promptFiles,
        handlerOutputs: options.handlerOutputs,
        historyTurns: options.historyTurns,
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
  return {
    kind: "prompt",
    chatId: firstMessage.chat.id,
    replyToMessageId: firstMessage.message_id,
    sourceMessageIds: collectTelegramMessageIds(options.messages),
    queueOrder: options.queueOrder,
    queueLane: "default",
    laneOrder: options.queueOrder,
    queuedAttachments: [],
    content,
    historyText: formatTelegramHistoryText(
      options.rawText,
      options.promptFiles ?? options.files,
      options.handlerOutputs,
    ),
    statusSummary: formatTelegramTurnStatusSummary(
      options.statusText ?? options.rawText,
      options.promptFiles ?? options.files,
      options.handlerOutputs,
    ),
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
