/**
 * Telegram media and text extraction helpers
 * Zones: telegram inbound, media groups, filesystem paths
 * Normalizes inbound Telegram messages into reusable file, text, id, history, and media-group metadata
 */

import { basename, dirname } from "node:path";

const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 1200;
const TELEGRAM_REPLY_CONTEXT_MAX_LENGTH = 1000;

export interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
}

export type TelegramVideo = TelegramDocument;
export type TelegramAudio = TelegramDocument;
export type TelegramAnimation = TelegramDocument;

export interface TelegramVoice {
  file_id: string;
  mime_type?: string;
}

export interface TelegramRichMessage {
  blocks?: unknown[];
}

export interface TelegramMessageUser {
  id?: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramMessageForwardOrigin {
  type?: string;
  sender_user?: TelegramMessageUser;
  sender_user_name?: string;
  sender_chat?: { title?: string; username?: string; id?: number };
  chat?: { title?: string; username?: string; id?: number };
  author_signature?: string;
}

export interface TelegramReplyToMessage {
  message_id?: number;
  from?: TelegramMessageUser;
  text?: string;
  caption?: string;
  rich_message?: TelegramRichMessage;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  video?: TelegramVideo;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  animation?: TelegramAnimation;
  sticker?: TelegramSticker;
}

export interface TelegramSticker {
  file_id: string;
}

export interface TelegramMediaMessage {
  message_id: number;
  from?: TelegramMessageUser;
  forward_origin?: TelegramMessageForwardOrigin;
  forward_from?: TelegramMessageUser;
  forward_sender_name?: string;
  text?: string;
  caption?: string;
  rich_message?: TelegramRichMessage;
  reply_to_message?: TelegramReplyToMessage;
  media_group_id?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  video?: TelegramVideo;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  animation?: TelegramAnimation;
  sticker?: TelegramSticker;
}

export interface TelegramMediaGroupMessage {
  message_id: number;
  chat: { id: number };
  message_thread_id?: number;
  media_group_id?: string;
}

export interface TelegramMediaGroupState<TMessage, TContext = unknown> {
  messages: TMessage[];
  context?: TContext;
  flushTimer?: ReturnType<typeof setTimeout>;
  dispatching?: boolean;
  suspended?: boolean;
  reschedule?: () => void;
}

export interface TelegramMediaGroupController<
  TMessage extends TelegramMediaGroupMessage,
  TContext = unknown,
> {
  queueMessage: (options: {
    message: TMessage;
    context?: TContext;
    dispatchMessages: (
      messages: TMessage[],
      ctx?: TContext,
    ) => unknown | Promise<unknown>;
  }) => boolean;
  removeMessages: (messageIds: number[]) => number;
  suspend: () => void;
  resume: (context: TContext) => void;
  clear: () => void;
}

export interface TelegramMediaGroupDispatchRuntimeDeps<
  TMessage extends TelegramMediaGroupMessage,
  TContext,
> {
  mediaGroups: TelegramMediaGroupController<TMessage, TContext>;
  dispatchMessages: (messages: TMessage[], ctx: TContext) => Promise<void>;
}

export interface TelegramMediaGroupDispatchRuntime<
  TMessage extends TelegramMediaGroupMessage,
  TContext,
> {
  handleMessage: (message: TMessage, ctx: TContext) => Promise<void>;
}

export interface TelegramMediaGroupControllerOptions {
  debounceMs?: number;
  setTimer?: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export type TelegramAttachmentKind =
  "photo" | "document" | "video" | "audio" | "voice" | "animation" | "sticker";

export interface TelegramFileInfo {
  file_id: string;
  fileName: string;
  mimeType?: string;
  kind: TelegramAttachmentKind;
  isImage: boolean;
}

export interface DownloadedTelegramFile {
  path: string;
  fileName?: string;
  isImage?: boolean;
  mimeType?: string;
  kind?: TelegramAttachmentKind;
}

export interface DownloadedTelegramMessageFile {
  path: string;
  fileName: string;
  isImage: boolean;
  mimeType?: string;
  kind?: TelegramAttachmentKind;
}

export interface DownloadTelegramMessageFilesDeps {
  downloadFile: (fileId: string, fileName: string) => Promise<string>;
}

export function guessExtensionFromMime(
  mimeType: string | undefined,
  fallback: string,
): string {
  if (!mimeType) return fallback;
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/png") return ".png";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "audio/ogg") return ".ogg";
  if (normalized === "audio/mpeg") return ".mp3";
  if (normalized === "audio/wav") return ".wav";
  if (normalized === "video/mp4") return ".mp4";
  if (normalized === "application/pdf") return ".pdf";
  return fallback;
}

export function guessMediaType(path: string): string | undefined {
  const normalized = path.toLowerCase();
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (normalized.endsWith(".png")) return "image/png";
  if (normalized.endsWith(".webp")) return "image/webp";
  if (normalized.endsWith(".gif")) return "image/gif";
  return undefined;
}

function isImageMimeType(mimeType: string | undefined): boolean {
  return mimeType?.toLowerCase().startsWith("image/") ?? false;
}

function getObjectField(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null || !(field in value)) {
    return undefined;
  }
  return Reflect.get(value, field);
}

function joinRichTextParts(parts: string[], separator = ""): string {
  return parts.filter(Boolean).join(separator).trim();
}

function extractTelegramRichText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return joinRichTextParts(value.map(extractTelegramRichText));
  }
  if (typeof value !== "object" || value === null) return "";
  const text = getObjectField(value, "text");
  if (text !== undefined) return extractTelegramRichText(text);
  const expression = getObjectField(value, "expression");
  if (typeof expression === "string") return expression;
  const alternativeText = getObjectField(value, "alternative_text");
  if (typeof alternativeText === "string") return alternativeText;
  return "";
}

function extractTelegramRichBlockText(block: unknown): string {
  if (typeof block !== "object" || block === null) return "";
  const directText = extractTelegramRichText(getObjectField(block, "text"));
  if (directText) return directText;
  const summary = extractTelegramRichText(getObjectField(block, "summary"));
  const nestedBlocks = extractTelegramRichMessageBlocksText(
    getObjectField(block, "blocks"),
  );
  const items = getObjectField(block, "items");
  const itemText = Array.isArray(items)
    ? items
        .map((item) => {
          const label = getObjectField(item, "label");
          const body = extractTelegramRichMessageBlocksText(
            getObjectField(item, "blocks"),
          );
          return typeof label === "string" && body ? `${label} ${body}` : body;
        })
        .filter(Boolean)
        .join("\n")
    : "";
  const cells = getObjectField(block, "cells");
  const cellText = Array.isArray(cells)
    ? cells
        .map((row) =>
          Array.isArray(row)
            ? row
                .map((cell) =>
                  extractTelegramRichText(getObjectField(cell, "text")),
                )
                .filter(Boolean)
                .join(" | ")
            : "",
        )
        .filter(Boolean)
        .join("\n")
    : "";
  const caption = extractTelegramRichText(getObjectField(block, "caption"));
  return joinRichTextParts(
    [summary, nestedBlocks, itemText, cellText, caption],
    "\n",
  );
}

function extractTelegramRichMessageBlocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return joinRichTextParts(blocks.map(extractTelegramRichBlockText), "\n\n");
}

function extractTelegramRichMessageText(
  richMessage: TelegramRichMessage | undefined,
): string {
  return extractTelegramRichMessageBlocksText(richMessage?.blocks);
}

export function extractTelegramMessageText(
  message: TelegramMediaMessage,
): string {
  return (
    extractTelegramRichMessageText(message.rich_message) ||
    message.text ||
    message.caption ||
    ""
  ).trim();
}

function truncateTelegramReplyContextText(text: string): string {
  if (text.length <= TELEGRAM_REPLY_CONTEXT_MAX_LENGTH) return text;
  return `${text.slice(0, TELEGRAM_REPLY_CONTEXT_MAX_LENGTH).trimEnd()}…`;
}

function formatTelegramUser(
  user: TelegramMessageUser | undefined,
): string | undefined {
  if (!user) return undefined;
  if (user.username) return user.username;
  if (typeof user.id === "number") return String(user.id);
  const name = [user.first_name, user.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || undefined;
}

function formatTelegramForwardOriginIdentifier(
  message: TelegramMediaMessage,
): string | undefined {
  const origin = message.forward_origin;
  const user = origin?.sender_user ?? message.forward_from;
  if (user?.username) return user.username;
  if (typeof user?.id === "number") return String(user.id);
  const chat = origin?.sender_chat ?? origin?.chat;
  if (chat?.username) return chat.username;
  if (typeof chat?.id === "number") return String(chat.id);
  return origin?.sender_user_name ?? message.forward_sender_name;
}

export function extractTelegramForwardContextText(
  message: TelegramMediaMessage,
  allowedUserId?: number,
): string {
  const originUser =
    message.forward_origin?.sender_user ?? message.forward_from;
  const isOwnerOrigin =
    typeof allowedUserId === "number" && originUser?.id === allowedUserId;
  const origin = formatTelegramForwardOriginIdentifier(message);
  if (!origin || isOwnerOrigin) return "";
  return `from: ${origin}`;
}

export function extractTelegramReplyContextText(
  message: TelegramMediaMessage,
): string {
  const quoted = (
    extractTelegramRichMessageText(message.reply_to_message?.rich_message) ||
    message.reply_to_message?.text ||
    message.reply_to_message?.caption ||
    ""
  ).trim();
  return quoted ? truncateTelegramReplyContextText(quoted) : "";
}

export function buildTelegramReplyContextBlock(
  message: TelegramMediaMessage,
  replyFiles: Pick<DownloadedTelegramFile, "path">[] = [],
): string {
  const from = formatTelegramUser(message.reply_to_message?.from);
  const header = from ? `[reply|from:${from}]` : "[reply]";
  const text = extractTelegramReplyContextText(message);
  const dirs = [...new Set(replyFiles.map((file) => dirname(file.path)))];
  const sameDir = dirs.length === 1;
  const attachmentHeader = sameDir
    ? `[attachments${from ? `|from:${from}` : ""}] ${dirs[0]}`
    : `[attachments${from ? `|from:${from}` : ""}]`;
  const fileLines = sameDir
    ? replyFiles.map((file) => `- /${basename(file.path)}`)
    : replyFiles.map((file) => `- ${file.path}`);
  const replyBlock = text ? `${header} ${text}` : header;
  if (fileLines.length > 0) {
    return `${replyBlock}\n\n${attachmentHeader}\n${fileLines.join("\n")}`;
  }
  if (text) return replyBlock;
  return "";
}

export function appendTelegramReplyContext(
  text: string,
  replyContext: string,
): string {
  if (!replyContext) return text;
  return text ? `${text}\n\n${replyContext}` : `_\n\n${replyContext}`;
}

export function extractTelegramMessagePromptText(
  message: TelegramMediaMessage,
): string {
  return appendTelegramReplyContext(
    extractTelegramMessageText(message),
    buildTelegramReplyContextBlock(message),
  );
}

export function extractTelegramMessagesText(
  messages: TelegramMediaMessage[],
): string {
  return messages.map(extractTelegramMessageText).filter(Boolean).join("\n\n");
}

export function extractTelegramMessagesPromptText(
  messages: TelegramMediaMessage[],
): string {
  const text = extractTelegramMessagesText(messages);
  const firstMessage = messages[0];
  if (!firstMessage) return text;
  return appendTelegramReplyContext(
    text,
    buildTelegramReplyContextBlock(firstMessage),
  );
}

export function extractFirstTelegramMessageText(
  messages: TelegramMediaMessage[],
): string {
  return messages.map(extractTelegramMessageText).find(Boolean) ?? "";
}

export function hasTelegramMessagePromptContent(
  message: TelegramMediaMessage,
): boolean {
  return (
    !!extractTelegramMessageText(message) ||
    (Array.isArray(message.photo) && message.photo.length > 0) ||
    !!message.document ||
    !!message.video ||
    !!message.audio ||
    !!message.voice ||
    !!message.animation ||
    !!message.sticker
  );
}

export function hasTelegramMessagesPromptContent(
  messages: TelegramMediaMessage[],
): boolean {
  return messages.some(hasTelegramMessagePromptContent);
}

export function collectTelegramMessageIds(
  messages: TelegramMediaMessage[],
): number[] {
  return [...new Set(messages.map((message) => message.message_id))];
}

export function getTelegramMediaGroupKey(
  message: TelegramMediaGroupMessage,
): string | undefined {
  if (!message.media_group_id) return undefined;
  const threadKey =
    typeof message.message_thread_id === "number"
      ? `thread:${message.message_thread_id}`
      : "private";
  return `${message.chat.id}:${threadKey}:${message.media_group_id}`;
}

export function removePendingTelegramMediaGroupMessages<
  TMessage extends TelegramMediaGroupMessage,
>(
  groups: Map<string, TelegramMediaGroupState<TMessage, unknown>>,
  messageIds: number[],
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void,
): number {
  if (messageIds.length === 0 || groups.size === 0) return 0;
  const deletedMessageIds = new Set(messageIds);
  let removedGroups = 0;
  for (const [key, state] of groups.entries()) {
    if (
      !state.messages.some((message) =>
        deletedMessageIds.has(message.message_id),
      )
    ) {
      continue;
    }
    if (state.flushTimer) clearTimer(state.flushTimer);
    groups.delete(key);
    removedGroups += 1;
  }
  return removedGroups;
}

export function queueTelegramMediaGroupMessage<
  TMessage extends TelegramMediaGroupMessage,
  TContext = unknown,
>(options: {
  message: TMessage;
  context?: TContext;
  groups: Map<string, TelegramMediaGroupState<TMessage, TContext>>;
  debounceMs: number;
  setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  dispatchMessages: (
    messages: TMessage[],
    ctx?: TContext,
  ) => unknown | Promise<unknown>;
}): boolean {
  const key = getTelegramMediaGroupKey(options.message);
  if (!key) return false;
  const existing = options.groups.get(key) ?? { messages: [] };
  existing.messages.push(options.message);
  existing.context = options.context;
  const scheduleDispatch = (): void => {
    if (existing.suspended) return;
    existing.flushTimer = options.setTimer(() => {
      existing.flushTimer = undefined;
      const state = options.groups.get(key);
      if (!state) return;
      if (state.dispatching) {
        scheduleDispatch();
        return;
      }
      const dispatchedMessages = [...state.messages];
      const dispatchedIds = new Set(
        dispatchedMessages.map((message) => message.message_id),
      );
      state.dispatching = true;
      void Promise.resolve(
        options.dispatchMessages(dispatchedMessages, state.context),
      ).then(
        () => {
          if (options.groups.get(key) !== state) return;
          state.messages = state.messages.filter(
            (message) => !dispatchedIds.has(message.message_id),
          );
          state.dispatching = false;
          if (state.messages.length === 0) options.groups.delete(key);
          else if (!state.flushTimer) scheduleDispatch();
        },
        () => {
          if (options.groups.get(key) !== state) return;
          state.dispatching = false;
          if (!state.flushTimer) scheduleDispatch();
        },
      );
    }, options.debounceMs);
    existing.flushTimer.unref?.();
  };
  existing.reschedule = scheduleDispatch;
  if (existing.flushTimer) options.clearTimer(existing.flushTimer);
  scheduleDispatch();
  options.groups.set(key, existing);
  return true;
}

export function createTelegramMediaGroupController<
  TMessage extends TelegramMediaGroupMessage,
  TContext = unknown,
>(
  options: TelegramMediaGroupControllerOptions = {},
): TelegramMediaGroupController<TMessage, TContext> {
  const groups = new Map<string, TelegramMediaGroupState<TMessage, TContext>>();
  const debounceMs = options.debounceMs ?? TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS;
  const setTimer =
    options.setTimer ??
    ((callback: () => void, ms: number): ReturnType<typeof setTimeout> =>
      setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? clearTimeout;
  return {
    queueMessage: ({ message, context, dispatchMessages }) =>
      queueTelegramMediaGroupMessage({
        message,
        context,
        groups,
        debounceMs,
        setTimer,
        clearTimer,
        dispatchMessages,
      }),
    removeMessages: (messageIds) =>
      removePendingTelegramMediaGroupMessages(groups, messageIds, clearTimer),
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
    },
  };
}

export function createTelegramMediaGroupDispatchRuntime<
  TMessage extends TelegramMediaGroupMessage,
  TContext,
>(
  deps: TelegramMediaGroupDispatchRuntimeDeps<TMessage, TContext>,
): TelegramMediaGroupDispatchRuntime<TMessage, TContext> {
  return {
    handleMessage: async (message, ctx) => {
      const queuedMediaGroup = deps.mediaGroups.queueMessage({
        message,
        context: ctx,
        dispatchMessages: (messages, queuedCtx) =>
          queuedCtx === undefined
            ? Promise.resolve()
            : deps.dispatchMessages(messages, queuedCtx),
      });
      if (queuedMediaGroup) return;
      await deps.dispatchMessages([message], ctx);
    },
  };
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
  files: Pick<DownloadedTelegramFile, "path">[],
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

export function formatTelegramHistoryText(
  rawText: string,
  files: DownloadedTelegramFile[],
  handlerOutputs: string[] = [],
): string {
  let summary = rawText.length > 0 ? rawText : "(no text)";
  summary = appendTelegramAttachmentSection(summary, files);
  summary = appendTelegramListSection(summary, "outputs", handlerOutputs);
  return summary;
}

export async function downloadTelegramMessageFiles(
  messages: TelegramMediaMessage[],
  deps: DownloadTelegramMessageFilesDeps,
): Promise<DownloadedTelegramMessageFile[]> {
  const downloaded: DownloadedTelegramMessageFile[] = [];
  for (const file of collectTelegramFileInfos(messages)) {
    downloaded.push({
      path: await deps.downloadFile(file.file_id, file.fileName),
      fileName: file.fileName,
      isImage: file.isImage,
      mimeType: file.mimeType,
      kind: file.kind,
    });
  }
  return downloaded;
}

function collectTelegramRichBlockFileInfos(
  blocks: unknown,
  messageId: number,
): TelegramFileInfo[] {
  if (!Array.isArray(blocks)) return [];
  const files: TelegramFileInfo[] = [];
  let mediaIndex = 0;
  const visit = (entries: unknown): void => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const type = getObjectField(entry, "type");
      if (
        type === "photo" ||
        type === "animation" ||
        type === "audio" ||
        type === "video" ||
        type === "voice_note"
      ) {
        mediaIndex += 1;
      }
      if (type === "photo") {
        const photos = getObjectField(entry, "photo");
        if (Array.isArray(photos)) {
          const photo = photos
            .filter(
              (value): value is TelegramPhotoSize =>
                typeof value === "object" &&
                value !== null &&
                typeof getObjectField(value, "file_id") === "string",
            )
            .sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0))
            .at(-1);
          if (photo) {
            files.push({
              file_id: photo.file_id,
              fileName: `photo-${messageId}-${mediaIndex}.jpg`,
              mimeType: "image/jpeg",
              kind: "photo",
              isImage: true,
            });
          }
        }
      }
      const fileField =
        type === "animation"
          ? "animation"
          : type === "audio"
            ? "audio"
            : type === "video"
              ? "video"
              : type === "voice_note"
                ? "voice_note"
                : undefined;
      if (fileField) {
        const media = getObjectField(entry, fileField);
        const fileId = getObjectField(media, "file_id");
        const mimeType = getObjectField(media, "mime_type");
        const fileName = getObjectField(media, "file_name");
        if (typeof fileId === "string") {
          const kind =
            type === "voice_note" ? "voice" : (type as TelegramAttachmentKind);
          const fallbackExtension =
            kind === "voice" ? ".ogg" : kind === "audio" ? ".mp3" : ".mp4";
          files.push({
            file_id: fileId,
            fileName:
              typeof fileName === "string"
                ? fileName
                : `${kind}-${messageId}-${mediaIndex}${guessExtensionFromMime(
                    typeof mimeType === "string" ? mimeType : undefined,
                    fallbackExtension,
                  )}`,
            mimeType: typeof mimeType === "string" ? mimeType : undefined,
            kind,
            isImage: false,
          });
        }
      }
      visit(getObjectField(entry, "blocks"));
      const items = getObjectField(entry, "items");
      if (Array.isArray(items)) {
        for (const item of items) visit(getObjectField(item, "blocks"));
      }
    }
  };
  visit(blocks);
  return files;
}

export function collectTelegramFileInfos(
  messages: TelegramMediaMessage[],
): TelegramFileInfo[] {
  const files: TelegramFileInfo[] = [];
  for (const message of messages) {
    files.push(
      ...collectTelegramRichBlockFileInfos(
        message.rich_message?.blocks,
        message.message_id,
      ),
    );
    if (Array.isArray(message.photo) && message.photo.length > 0) {
      const photo = [...message.photo]
        .sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0))
        .pop();
      if (photo) {
        files.push({
          file_id: photo.file_id,
          fileName: `photo-${message.message_id}.jpg`,
          mimeType: "image/jpeg",
          kind: "photo",
          isImage: true,
        });
      }
    }
    if (message.document) {
      const fileName =
        message.document.file_name ||
        `document-${message.message_id}${guessExtensionFromMime(
          message.document.mime_type,
          "",
        )}`;
      files.push({
        file_id: message.document.file_id,
        fileName,
        mimeType: message.document.mime_type,
        kind: "document",
        isImage: isImageMimeType(message.document.mime_type),
      });
    }
    if (message.video) {
      const fileName =
        message.video.file_name ||
        `video-${message.message_id}${guessExtensionFromMime(
          message.video.mime_type,
          ".mp4",
        )}`;
      files.push({
        file_id: message.video.file_id,
        fileName,
        mimeType: message.video.mime_type,
        kind: "video",
        isImage: false,
      });
    }
    // Generic audio files (e.g. MP3 uploads) — can also trigger voice replies in "mirror" mode
    if (message.audio) {
      const fileName =
        message.audio.file_name ||
        `audio-${message.message_id}${guessExtensionFromMime(
          message.audio.mime_type,
          ".mp3",
        )}`;
      files.push({
        file_id: message.audio.file_id,
        fileName,
        mimeType: message.audio.mime_type,
        kind: "audio",
        isImage: false,
      });
    }

    // Voice messages (recorded via microphone) — primary trigger for "mirror" voice reply mode
    if (message.voice) {
      files.push({
        file_id: message.voice.file_id,
        fileName: `voice-${message.message_id}${guessExtensionFromMime(
          message.voice.mime_type,
          ".ogg",
        )}`,
        mimeType: message.voice.mime_type,
        kind: "voice",
        isImage: false,
      });
    }
    if (message.animation) {
      const fileName =
        message.animation.file_name ||
        `animation-${message.message_id}${guessExtensionFromMime(
          message.animation.mime_type,
          ".mp4",
        )}`;
      files.push({
        file_id: message.animation.file_id,
        fileName,
        mimeType: message.animation.mime_type,
        kind: "animation",
        isImage: false,
      });
    }
    if (message.sticker) {
      files.push({
        file_id: message.sticker.file_id,
        fileName: `sticker-${message.message_id}.webp`,
        mimeType: "image/webp",
        kind: "sticker",
        isImage: true,
      });
    }
  }
  const seenFileIds = new Set<string>();
  return files.filter((file) => {
    if (seenFileIds.has(file.file_id)) return false;
    seenFileIds.add(file.file_id);
    return true;
  });
}
