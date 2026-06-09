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

export interface TelegramReplyToMessage {
  message_id?: number;
  text?: string;
  caption?: string;
}

export interface TelegramSticker {
  file_id: string;
}

export interface TelegramMediaMessage {
  message_id: number;
  text?: string;
  caption?: string;
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
  media_group_id?: string;
}

export interface TelegramMediaGroupState<TMessage, TContext = unknown> {
  messages: TMessage[];
  context?: TContext;
  flushTimer?: ReturnType<typeof setTimeout>;
}

export interface TelegramMediaGroupController<
  TMessage extends TelegramMediaGroupMessage,
  TContext = unknown,
> {
  queueMessage: (options: {
    message: TMessage;
    context?: TContext;
    dispatchMessages: (messages: TMessage[], ctx?: TContext) => void;
  }) => boolean;
  removeMessages: (messageIds: number[]) => number;
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
  | "photo"
  | "document"
  | "video"
  | "audio"
  | "voice"
  | "animation"
  | "sticker";

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

export function extractTelegramMessageText(
  message: TelegramMediaMessage,
): string {
  return (message.text || message.caption || "").trim();
}

function truncateTelegramReplyContextText(text: string): string {
  if (text.length <= TELEGRAM_REPLY_CONTEXT_MAX_LENGTH) return text;
  return `${text.slice(0, TELEGRAM_REPLY_CONTEXT_MAX_LENGTH).trimEnd()}…`;
}

export function extractTelegramReplyContextText(
  message: TelegramMediaMessage,
): string {
  const quoted = (
    message.reply_to_message?.text ||
    message.reply_to_message?.caption ||
    ""
  ).trim();
  return quoted ? truncateTelegramReplyContextText(quoted) : "";
}

export function appendTelegramReplyContext(
  text: string,
  replyContext: string,
): string {
  if (!replyContext) return text;
  const replyBlock = `[reply] ${replyContext}`;
  return text ? `${text}\n\n${replyBlock}` : `_\n\n${replyBlock}`;
}

export function extractTelegramMessagePromptText(
  message: TelegramMediaMessage,
): string {
  return appendTelegramReplyContext(
    extractTelegramMessageText(message),
    extractTelegramReplyContextText(message),
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
    extractTelegramReplyContextText(firstMessage),
  );
}

export function extractFirstTelegramMessageText(
  messages: TelegramMediaMessage[],
): string {
  return messages.map(extractTelegramMessageText).find(Boolean) ?? "";
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
  return `${message.chat.id}:${message.media_group_id}`;
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
  dispatchMessages: (messages: TMessage[], ctx?: TContext) => void;
}): boolean {
  const key = getTelegramMediaGroupKey(options.message);
  if (!key) return false;
  const existing = options.groups.get(key) ?? { messages: [] };
  existing.messages.push(options.message);
  existing.context = options.context;
  if (existing.flushTimer) options.clearTimer(existing.flushTimer);
  existing.flushTimer = options.setTimer(() => {
    const state = options.groups.get(key);
    options.groups.delete(key);
    if (!state) return;
    options.dispatchMessages(state.messages, state.context);
  }, options.debounceMs);
  existing.flushTimer.unref?.();
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
        dispatchMessages: (messages, queuedCtx) => {
          if (queuedCtx !== undefined) {
            void deps.dispatchMessages(messages, queuedCtx);
          }
        },
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

export function collectTelegramFileInfos(
  messages: TelegramMediaMessage[],
): TelegramFileInfo[] {
  const files: TelegramFileInfo[] = [];
  for (const message of messages) {
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
  return files;
}
