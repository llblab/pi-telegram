/**
 * Telegram outbound attachment helpers
 * Zones: telegram outbound, pi agent tool, filesystem
 * Owns telegram_attach registration, outbound attachment queueing, and delivery so Telegram file output stays in one domain module
 */

import { stat } from "node:fs/promises";
import { basename } from "node:path";

import { Type } from "@sinclair/typebox";

import type {
  TelegramBusAgentMessage,
  TelegramBusAgentTargetSelector,
} from "./bus.ts";
import type { ExtensionAPI } from "./pi.ts";
import {
  TELEGRAM_ATTACH_PROMPT_GUIDELINES,
  TELEGRAM_ATTACH_PROMPT_SNIPPET,
  TELEGRAM_MESSAGE_PROMPT_GUIDELINES,
  TELEGRAM_MESSAGE_PROMPT_SNIPPET,
} from "./prompts.ts";
import {
  withTelegramReplyParameters,
  normalizeTelegramNativeMarkdown,
} from "./replies.ts";
import {
  getTelegramTargetThreadParams,
  type TelegramTarget,
} from "./target.ts";

const MAX_ATTACHMENTS_PER_TURN = 10;

export const TELEGRAM_OUTBOUND_ATTACHMENT_DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export function getTelegramOutboundAttachmentByteLimitFromEnv(
  env: NodeJS.ProcessEnv,
  names: string[],
  defaultValue = TELEGRAM_OUTBOUND_ATTACHMENT_DEFAULT_MAX_BYTES,
): number {
  for (const name of names) {
    const rawValue = env[name]?.trim();
    if (!rawValue) continue;
    const parsed = Number(rawValue);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return defaultValue;
}

export const TELEGRAM_OUTBOUND_ATTACHMENT_MAX_BYTES =
  getTelegramOutboundAttachmentByteLimitFromEnv(process.env, [
    "PI_TELEGRAM_OUTBOUND_ATTACHMENT_MAX_BYTES",
    "TELEGRAM_MAX_ATTACHMENT_SIZE_BYTES",
  ]);

export interface TelegramOutboundAttachmentToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: { paths: string[] };
}

export interface TelegramOutboundAttachmentRuntimeEventRecorderPort {
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramOutboundAttachmentToolRegistrationDeps extends TelegramOutboundAttachmentRuntimeEventRecorderPort {
  maxAttachmentsPerTurn?: number;
  maxAttachmentSizeBytes?: number;
  getActiveTurn: () => TelegramOutboundAttachmentQueueTargetView | undefined;
  getDefaultChatId?: () => number | undefined;
  getDefaultTarget?: () => TelegramTarget | undefined;
  canSendDirect?: () => boolean;
  sendMultipart?: TelegramQueuedOutboundAttachmentDeliveryDeps["sendMultipart"];
  statPath?: (path: string) => Promise<{ isFile(): boolean; size?: number }>;
}

export interface TelegramOutboundMessagePlan {
  markdown: string;
  replyMarkup?: unknown;
}

export interface TelegramOutboundMessageToolRegistrationDeps extends TelegramOutboundAttachmentRuntimeEventRecorderPort {
  getDefaultChatId: () => number | undefined;
  getDefaultTarget?: () => TelegramTarget | undefined;
  getActiveTurn?: () =>
    | { chatId: number; target?: TelegramTarget }
    | undefined;
  resolveAgentTarget?: (
    selector: TelegramBusAgentTargetSelector,
  ) => Promise<TelegramTarget & { threadId: number }>;
  routeAgentMessage?: (message: TelegramBusAgentMessage) => Promise<void>;
  canSendDirect: () => boolean;
  planMessage: (markdown: string) => TelegramOutboundMessagePlan;
  sendMarkdownMessage: (
    chatId: number,
    markdown: string,
    options?: { replyMarkup?: unknown; target?: TelegramTarget },
  ) => Promise<number | undefined>;
  sendChannelMarkdownMessage?: (
    channel: number | string,
    markdown: string,
    options: { operationId: string; replyMarkup?: unknown },
  ) => Promise<number | undefined>;
}

export interface TelegramQueuedOutboundAttachmentView {
  path: string;
  fileName: string;
}

export interface TelegramOutboundAttachmentQueueTargetView {
  queuedAttachments: TelegramQueuedOutboundAttachmentView[];
  guestQueryId?: string;
}

export interface TelegramQueuedOutboundAttachmentTurnView extends TelegramOutboundAttachmentQueueTargetView {
  chatId: number;
  replyToMessageId: number;
  target?: TelegramTarget;
}

class TelegramRichAttachmentCommitUnknownError extends Error {
  readonly kind = "commit-unknown" as const;

  constructor(cause: unknown) {
    super("Telegram Rich media upload may have committed without a message id.");
    this.name = "TelegramRichAttachmentCommitUnknownError";
    this.cause = cause;
  }
}

function isTelegramRichAttachmentCommitUnknownError(error: unknown): boolean {
  return (
    error instanceof TelegramRichAttachmentCommitUnknownError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { kind?: unknown }).kind === "commit-unknown")
  );
}

export interface TelegramRichOutboundAttachmentPlan {
  method: "sendRichMessage";
  fields: Record<string, string>;
  fileField: "rich_media_upload";
  filePath: string;
  fileName: string;
}

export interface TelegramRichOutboundAttachmentSenderDeps extends TelegramOutboundAttachmentRuntimeEventRecorderPort {
  sendMultipart: TelegramQueuedOutboundAttachmentDeliveryDeps["sendMultipart"];
  getRenderingMode: () => "rich" | "html";
  recordOwnership?: (input: {
    chatId: number;
    messageId: number;
    target?: TelegramTarget;
  }) => void;
}

export function planTelegramRichOutboundAttachment(options: {
  turn: TelegramQueuedOutboundAttachmentTurnView;
  markdown: string;
  renderingMode: "rich" | "html";
  replyMarkup?: unknown;
}): TelegramRichOutboundAttachmentPlan | undefined {
  if (options.renderingMode !== "rich") return undefined;
  if (!options.markdown.trim()) return undefined;
  if (options.turn.queuedAttachments.length !== 1) return undefined;
  const attachment = options.turn.queuedAttachments[0]!;
  const normalizedPath = attachment.path.toLowerCase();
  const mediaType = normalizedPath.endsWith(".jpg") ||
      normalizedPath.endsWith(".jpeg") ||
      normalizedPath.endsWith(".png")
    ? "photo"
    : normalizedPath.endsWith(".mp4")
      ? "video"
      : normalizedPath.endsWith(".mp3")
        ? "audio"
        : undefined;
  if (!mediaType) return undefined;
  const mediaId = "artifact";
  const richMessage = {
    markdown: `![](tg://${mediaType}?id=${mediaId})\n\n${normalizeTelegramNativeMarkdown(options.markdown)}`,
    media: [
      {
        id: mediaId,
        media: {
          type: mediaType,
          media: "attach://rich_media_upload",
        },
      },
    ],
  };
  return {
    method: "sendRichMessage",
    fields: {
      chat_id: String(options.turn.chatId),
      ...getTelegramMultipartTargetFields(options.turn.target),
      rich_message: JSON.stringify(richMessage),
      ...(options.replyMarkup
        ? { reply_markup: JSON.stringify(options.replyMarkup) }
        : {}),
    },
    fileField: "rich_media_upload",
    filePath: attachment.path,
    fileName: attachment.fileName,
  };
}

export function createTelegramRichOutboundAttachmentSender(
  deps: TelegramRichOutboundAttachmentSenderDeps,
) {
  return async (
    turn: TelegramQueuedOutboundAttachmentTurnView,
    markdown: string,
    options?: { replyMarkup?: unknown; isDeliveryActive?: () => boolean },
  ): Promise<boolean> => {
    if (options?.isDeliveryActive?.() === false) return false;
    const plan = planTelegramRichOutboundAttachment({
      turn,
      markdown,
      renderingMode: deps.getRenderingMode(),
      replyMarkup: options?.replyMarkup,
    });
    if (!plan) return false;
    try {
      const result = await withTelegramReplyParameters(
        turn.chatId, turn.replyToMessageId, turn.target,
        (replyParameters) => deps.sendMultipart(
          plan.method,
          { ...plan.fields, ...(replyParameters ? { reply_parameters: JSON.stringify(replyParameters) } : {}) },
          plan.fileField,
          plan.filePath,
          plan.fileName,
        ),
      );
      const messageId =
        result && typeof result === "object" &&
          Number.isInteger((result as { message_id?: unknown }).message_id)
          ? (result as { message_id: number }).message_id
          : undefined;
      if (messageId === undefined) {
        throw new TelegramRichAttachmentCommitUnknownError(
          new Error("Successful Rich media upload omitted message_id."),
        );
      }
      if (options?.isDeliveryActive?.() !== false) {
        deps.recordOwnership?.({
          chatId: turn.chatId,
          messageId,
          target: turn.target,
        });
      }
      return true;
    } catch (error) {
      if (isTelegramRichAttachmentCommitUnknownError(error)) throw error;
      deps.recordRuntimeEvent?.("attachment", error, {
        phase: "rich-media-known-failure",
        fileName: plan.fileName,
      });
      return false;
    }
  };
}

export type TelegramGuestCachedAttachmentResult =
  | {
      type: "document";
      id: string;
      title: string;
      document_file_id: string;
      caption?: string;
    }
  | {
      type: "photo";
      id: string;
      photo_file_id: string;
      caption?: string;
    }
  | {
      type: "audio";
      id: string;
      audio_file_id: string;
      caption?: string;
    }
  | {
      type: "voice";
      id: string;
      voice_file_id: string;
      title: string;
      caption?: string;
    };

interface TelegramGuestStagingMessage {
  message_id?: number;
  document?: { file_id?: string };
  photo?: Array<{ file_id?: string; file_size?: number }>;
  audio?: { file_id?: string };
  voice?: { file_id?: string };
}

function isTelegramOutboundPhotoAttachmentPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return (
    normalized.endsWith(".jpg") ||
    normalized.endsWith(".jpeg") ||
    normalized.endsWith(".png") ||
    normalized.endsWith(".webp") ||
    normalized.endsWith(".gif")
  );
}

function getTelegramGuestAttachmentTransport(path: string): {
  method: "sendDocument" | "sendPhoto" | "sendAudio" | "sendVoice";
  fileField: "document" | "photo" | "audio" | "voice";
} {
  const normalized = path.toLowerCase();
  if (
    normalized.endsWith(".jpg") ||
    normalized.endsWith(".jpeg") ||
    normalized.endsWith(".png")
  ) {
    return { method: "sendPhoto", fileField: "photo" };
  }
  if (normalized.endsWith(".ogg") || normalized.endsWith(".opus")) {
    return { method: "sendVoice", fileField: "voice" };
  }
  if (normalized.endsWith(".mp3")) {
    return { method: "sendAudio", fileField: "audio" };
  }
  return { method: "sendDocument", fileField: "document" };
}

function formatTelegramOutboundAttachmentSizeLimitError(
  size: number,
  maxSize: number,
  path?: string,
): string {
  const message = `Attachment exceeds size limit (${size} bytes > ${maxSize} bytes)`;
  return path ? `${message}: ${path}` : message;
}

function formatTelegramOutboundAttachmentToolResultText(
  count: number,
  mode: "queued" | "sent" = "queued",
): string {
  // Pi's compact tool rows need one leading newline to visually separate header and result.
  const verb = mode === "queued" ? "Queued" : "Sent";
  return ["", `${verb} ${count} Telegram attachment(s).`].join("\n");
}

function formatTelegramOutboundMessageToolResultText(chatId: number | string): string {
  return ["", `Sent Telegram message to ${chatId}.`].join("\n");
}

function getTelegramMultipartTargetFields(
  target: TelegramTarget | undefined,
): Record<string, string> {
  if (!target) return {};
  return Object.fromEntries(
    Object.entries(getTelegramTargetThreadParams(target)).map(
      ([key, value]) => [key, String(value)],
    ),
  );
}

function assertTelegramDirectDeliveryAllowed(
  canSendDirect: (() => boolean) | undefined,
): void {
  if (canSendDirect?.()) return;
  throw new Error(
    "Telegram direct delivery requires this Pi instance to own /telegram-connect or be registered with the Telegram multi-instance bus",
  );
}

function resolveTelegramOutboundTarget(options: {
  chatId?: number;
  threadId?: number;
  target?: TelegramTarget;
  getDefaultChatId?: () => number | undefined;
  getDefaultTarget?: () => TelegramTarget | undefined;
}): { chatId: number; target?: TelegramTarget } {
  if (options.target)
    return { chatId: options.target.chatId, target: options.target };
  if (options.chatId !== undefined) {
    return {
      chatId: options.chatId,
      target:
        options.threadId !== undefined
          ? { chatId: options.chatId, threadId: options.threadId }
          : undefined,
    };
  }
  const defaultTarget = options.getDefaultTarget?.();
  if (defaultTarget) {
    return { chatId: defaultTarget.chatId, target: defaultTarget };
  }
  const defaultChatId = options.getDefaultChatId?.();
  if (defaultChatId === undefined) {
    throw new Error(
      "Telegram chat_id is required when no paired/default Telegram chat is available",
    );
  }
  return { chatId: defaultChatId };
}

async function buildTelegramOutboundAttachmentViews(options: {
  paths: string[];
  maxAttachmentSizeBytes?: number;
  statPath?: (path: string) => Promise<{ isFile(): boolean; size?: number }>;
}): Promise<TelegramQueuedOutboundAttachmentView[]> {
  const pendingAttachments: TelegramQueuedOutboundAttachmentView[] = [];
  for (const inputPath of options.paths) {
    const stats = await (options.statPath ?? stat)(inputPath);
    if (!stats.isFile()) {
      throw new Error(`Not a file: ${inputPath}`);
    }
    if (
      options.maxAttachmentSizeBytes !== undefined &&
      stats.size !== undefined &&
      stats.size > options.maxAttachmentSizeBytes
    ) {
      throw new Error(
        formatTelegramOutboundAttachmentSizeLimitError(
          stats.size,
          options.maxAttachmentSizeBytes,
          inputPath,
        ),
      );
    }
    pendingAttachments.push({
      path: inputPath,
      fileName: basename(inputPath),
    });
  }
  return pendingAttachments;
}

function formatTelegramOutboundToolError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`\n${message.replace(/^\n+/u, "") || "Telegram outbound operation failed."}`);
}

export function registerTelegramOutboundAttachmentTool(
  pi: ExtensionAPI,
  deps: TelegramOutboundAttachmentToolRegistrationDeps,
): void {
  const maxAttachmentsPerTurn =
    deps.maxAttachmentsPerTurn ?? MAX_ATTACHMENTS_PER_TURN;
  const maxAttachmentSizeBytes =
    deps.maxAttachmentSizeBytes ?? TELEGRAM_OUTBOUND_ATTACHMENT_MAX_BYTES;
  pi.registerTool({
    name: "telegram_attach",
    label: "Telegram Attach",
    description:
      "Queue one or more local files for the active Telegram reply, or send them immediately to Telegram when no Telegram turn is active.",
    promptSnippet: TELEGRAM_ATTACH_PROMPT_SNIPPET,
    promptGuidelines: [...TELEGRAM_ATTACH_PROMPT_GUIDELINES],
    parameters: Type.Object({
      paths: Type.Array(
        Type.String({ description: "Local file path to attach" }),
        { minItems: 1, maxItems: maxAttachmentsPerTurn },
      ),
      chat_id: Type.Optional(
        Type.Number({
          description:
            "Optional Telegram chat id for immediate delivery when no Telegram turn is active",
        }),
      ),
      thread_id: Type.Optional(
        Type.Number({
          description:
            "Optional Telegram topic thread id for immediate delivery with chat_id",
        }),
      ),
      caption: Type.Optional(
        Type.String({
          description:
            "Optional caption for immediate delivery; ignored when queued for an active turn",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        return await queueTelegramOutboundAttachments({
          activeTurn: deps.getActiveTurn(),
          paths: params.paths,
          chatId: params.chat_id,
          threadId: params.thread_id,
          caption: params.caption,
          maxAttachmentsPerTurn,
          maxAttachmentSizeBytes,
          sendMultipart: deps.sendMultipart,
          getDefaultChatId: deps.getDefaultChatId,
          getDefaultTarget: deps.getDefaultTarget,
          canSendDirect: deps.canSendDirect,
          statPath: deps.statPath,
        });
      } catch (error) {
        deps.recordRuntimeEvent?.("attachment", error, {
          phase: "queue",
          count: params.paths.length,
        });
        throw formatTelegramOutboundToolError(error);
      }
    },
  });
}

export function registerTelegramOutboundMessageTool(
  pi: ExtensionAPI,
  deps: TelegramOutboundMessageToolRegistrationDeps,
): void {
  pi.registerTool({
    name: "telegram_message",
    label: "Telegram Message",
    description:
      "Send Markdown text directly to the paired/default Telegram chat, an exact channel chat_id, or an explicit live target. Channel posting requires Telegram-granted bot permission. Hidden telegram_button comments become inline prompt buttons.",
    promptSnippet: TELEGRAM_MESSAGE_PROMPT_SNIPPET,
    promptGuidelines: [...TELEGRAM_MESSAGE_PROMPT_GUIDELINES],
    parameters: Type.Object({
      text: Type.String({ description: "Message text to send" }),
      chat_id: Type.Optional(
        Type.Union([
          Type.Number(),
          Type.String({ pattern: "^@[A-Za-z0-9_]{5,32}$" }),
        ], { description: "Optional exact Telegram chat id or public channel @username" }),
      ),
      thread_id: Type.Optional(
        Type.Number({
          description: "Optional Telegram topic thread id with chat_id",
        }),
      ),
      channel: Type.Optional(Type.Boolean({
        description: "Set true only when a numeric chat_id is explicitly intended as a channel",
      })),
      thread: Type.Optional(
        Type.Union([Type.String(), Type.Number()], {
          description:
            "Optional live Pi thread name or numeric id for visible delivery plus a target-agent turn",
        }),
      ),
    }),
    async execute(toolCallId, params) {
      try {
        return await sendTelegramOutboundMessage({
          text: params.text,
          operationId: toolCallId,
          channel: params.channel,
          chatId: params.chat_id,
          threadId: params.thread_id,
          agentThread: params.thread,
          getDefaultChatId: deps.getDefaultChatId,
          getDefaultTarget: deps.getDefaultTarget,
          getActiveTurn: deps.getActiveTurn,
          resolveAgentTarget: deps.resolveAgentTarget,
          routeAgentMessage: deps.routeAgentMessage,
          canSendDirect: deps.canSendDirect,
          planMessage: deps.planMessage,
          sendMarkdownMessage: deps.sendMarkdownMessage,
          sendChannelMarkdownMessage: deps.sendChannelMarkdownMessage,
        });
      } catch (error) {
        const reportableError = typeof params.chat_id === "string" || params.channel === true
          ? new Error("Telegram channel publication failed; inspect the retained local record before retrying.")
          : error;
        deps.recordRuntimeEvent?.("message", reportableError, { phase: "direct" });
        throw formatTelegramOutboundToolError(reportableError);
      }
    },
  });
}

export interface TelegramQueuedOutboundAttachmentDeliveryDeps {
  sendMultipart: (
    method: string,
    fields: Record<string, string>,
    fileField: string,
    filePath: string,
    fileName: string,
  ) => Promise<unknown>;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number,
    text: string,
    options?: { target?: TelegramTarget },
  ) => Promise<unknown>;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  statPath?: (path: string) => Promise<{ size: number }>;
  maxAttachmentSizeBytes?: number;
  isDeliveryActive?: () => boolean;
}

export async function queueTelegramOutboundAttachments(options: {
  activeTurn: TelegramOutboundAttachmentQueueTargetView | undefined;
  paths: string[];
  chatId?: number;
  threadId?: number;
  caption?: string;
  maxAttachmentsPerTurn: number;
  maxAttachmentSizeBytes?: number;
  sendMultipart?: TelegramQueuedOutboundAttachmentDeliveryDeps["sendMultipart"];
  getDefaultChatId?: () => number | undefined;
  getDefaultTarget?: () => TelegramTarget | undefined;
  canSendDirect?: () => boolean;
  statPath?: (path: string) => Promise<{ isFile(): boolean; size?: number }>;
}): Promise<TelegramOutboundAttachmentToolResult> {
  if (!options.activeTurn) {
    if (!options.sendMultipart) {
      throw new Error(
        "telegram_attach can only queue files while replying to an active Telegram turn; provide Telegram send ports for immediate delivery",
      );
    }
    return sendTelegramOutboundFiles({
      paths: options.paths,
      chatId: options.chatId,
      threadId: options.threadId,
      caption: options.caption,
      maxAttachmentsPerTurn: options.maxAttachmentsPerTurn,
      maxAttachmentSizeBytes: options.maxAttachmentSizeBytes,
      sendMultipart: options.sendMultipart,
      getDefaultChatId: options.getDefaultChatId,
      getDefaultTarget: options.getDefaultTarget,
      canSendDirect: options.canSendDirect,
      statPath: options.statPath,
    });
  }
  if (
    options.activeTurn.guestQueryId &&
    options.activeTurn.queuedAttachments.length + options.paths.length > 1
  ) {
    throw new Error(
      "Telegram Guest Mode supports one attachment per reply; no attachment was queued",
    );
  }
  if (
    options.activeTurn.queuedAttachments.length + options.paths.length >
    options.maxAttachmentsPerTurn
  ) {
    throw new Error(
      `Attachment limit reached (${options.maxAttachmentsPerTurn})`,
    );
  }
  const pendingAttachments = await buildTelegramOutboundAttachmentViews({
    paths: options.paths,
    maxAttachmentSizeBytes: options.maxAttachmentSizeBytes,
    statPath: options.statPath,
  });
  options.activeTurn.queuedAttachments.push(...pendingAttachments);
  const added = pendingAttachments.map((attachment) => attachment.path);
  return {
    content: [
      {
        type: "text",
        text: formatTelegramOutboundAttachmentToolResultText(added.length),
      },
    ],
    details: { paths: added },
  };
}

export async function deliverTelegramGuestCachedAttachment(options: {
  guestQueryId: string;
  stagingChatId: number;
  stagingTarget?: TelegramTarget;
  attachment: TelegramQueuedOutboundAttachmentView;
  caption?: string;
  sendMultipart: TelegramQueuedOutboundAttachmentDeliveryDeps["sendMultipart"];
  answerGuestQuery: (
    guestQueryId: string,
    result: TelegramGuestCachedAttachmentResult,
  ) => Promise<void>;
  answerGuestText?: (guestQueryId: string, text: string) => Promise<void>;
  fallbackText?: string;
  deleteMessage: (chatId: number, messageId: number) => Promise<void>;
  recordRuntimeEvent?: TelegramOutboundAttachmentRuntimeEventRecorderPort["recordRuntimeEvent"];
}): Promise<void> {
  const transport = getTelegramGuestAttachmentTransport(options.attachment.path);
  let stagingMessageId: number | undefined;
  let answerAttempted = false;
  try {
    const message = (await options.sendMultipart(
      transport.method,
      {
        chat_id: String(options.stagingChatId),
        ...getTelegramMultipartTargetFields(options.stagingTarget),
      },
      transport.fileField,
      options.attachment.path,
      options.attachment.fileName,
    )) as TelegramGuestStagingMessage;
    stagingMessageId = message.message_id;
    const caption = options.caption
      ? Array.from(options.caption).slice(0, 1024).join("")
      : undefined;
    let result: TelegramGuestCachedAttachmentResult;
    if (transport.fileField === "photo") {
      const photo = [...(message.photo ?? [])]
        .sort((left, right) => (left.file_size ?? 0) - (right.file_size ?? 0))
        .at(-1);
      if (!photo?.file_id) throw new Error("Guest staging upload returned no photo file_id");
      result = {
        type: "photo",
        id: "attachment-1",
        photo_file_id: photo.file_id,
        ...(caption ? { caption } : {}),
      };
    } else if (transport.fileField === "audio") {
      if (!message.audio?.file_id)
        throw new Error("Guest staging upload returned no audio file_id");
      result = {
        type: "audio",
        id: "attachment-1",
        audio_file_id: message.audio.file_id,
        ...(caption ? { caption } : {}),
      };
    } else if (transport.fileField === "voice") {
      if (!message.voice?.file_id)
        throw new Error("Guest staging upload returned no voice file_id");
      result = {
        type: "voice",
        id: "attachment-1",
        voice_file_id: message.voice.file_id,
        title: options.attachment.fileName,
        ...(caption ? { caption } : {}),
      };
    } else {
      if (!message.document?.file_id)
        throw new Error("Guest staging upload returned no document file_id");
      result = {
        type: "document",
        id: "attachment-1",
        title: options.attachment.fileName,
        document_file_id: message.document.file_id,
        ...(caption ? { caption } : {}),
      };
    }
    answerAttempted = true;
    await options.answerGuestQuery(options.guestQueryId, result);
  } catch (error) {
    if (
      !answerAttempted &&
      options.answerGuestText &&
      options.fallbackText
    ) {
      answerAttempted = true;
      await options.answerGuestText(options.guestQueryId, options.fallbackText);
    } else {
      throw error;
    }
  } finally {
    if (stagingMessageId !== undefined) {
      try {
        await options.deleteMessage(options.stagingChatId, stagingMessageId);
      } catch (error) {
        options.recordRuntimeEvent?.("attachment", error, {
          phase: "guest-staging-cleanup",
          chatId: options.stagingChatId,
          messageId: stagingMessageId,
        });
      }
    }
  }
}

export async function sendTelegramOutboundMessage(options: {
  text: string;
  operationId?: string;
  channel?: boolean;
  chatId?: number | string;
  threadId?: number;
  agentThread?: string | number;
  target?: TelegramTarget;
  getDefaultChatId?: () => number | undefined;
  getDefaultTarget?: () => TelegramTarget | undefined;
  getActiveTurn?: () =>
    | { chatId: number; target?: TelegramTarget }
    | undefined;
  resolveAgentTarget?: (
    selector: TelegramBusAgentTargetSelector,
  ) => Promise<TelegramTarget & { threadId: number }>;
  routeAgentMessage?: (message: TelegramBusAgentMessage) => Promise<void>;
  canSendDirect: () => boolean;
  planMessage: (markdown: string) => TelegramOutboundMessagePlan;
  sendMarkdownMessage: (
    chatId: number,
    markdown: string,
    options?: { replyMarkup?: unknown; target?: TelegramTarget },
  ) => Promise<number | undefined>;
  sendChannelMarkdownMessage?: (
    channel: number | string,
    markdown: string,
    options: { operationId: string; replyMarkup?: unknown },
  ) => Promise<number | undefined>;
}): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: { chatId: number | string; messageId?: number };
}> {
  assertTelegramDirectDeliveryAllowed(options.canSendDirect);
  const activeTurn = options.getActiveTurn?.();
  if (typeof options.chatId === "string" || options.channel === true) {
    if (!((typeof options.chatId === "string" && /^@[A-Za-z0-9_]{5,32}$/u.test(options.chatId)) ||
        (typeof options.chatId === "number" && Number.isSafeInteger(options.chatId) && options.chatId < 0)) ||
        options.threadId !== undefined ||
        options.target !== undefined || options.agentThread !== undefined) {
      throw new Error("Telegram channel delivery requires one exact @username or negative numeric channel ID without a thread target.");
    }
    if (!options.sendChannelMarkdownMessage || !options.operationId) {
      throw new Error("Telegram channel delivery requires direct leader transport ownership and operation identity.");
    }
    const plan = options.planMessage(options.text);
    const messageId = await options.sendChannelMarkdownMessage(
      options.chatId, plan.markdown, { operationId: options.operationId,
        replyMarkup: plan.replyMarkup });
    return { content: [{ type: "text",
      text: formatTelegramOutboundMessageToolResultText(options.chatId) }],
    details: { chatId: options.chatId, messageId } };
  }
  const requestedAgentSelector: TelegramBusAgentTargetSelector | undefined =
    options.agentThread !== undefined
      ? typeof options.agentThread === "number"
        ? { chatId: options.chatId, threadId: options.agentThread }
        : { chatId: options.chatId, threadName: options.agentThread }
      : activeTurn &&
          options.resolveAgentTarget &&
          options.routeAgentMessage &&
          ((options.target?.threadId !== undefined) ||
            (options.chatId !== undefined && options.threadId !== undefined))
        ? {
            chatId: options.target?.chatId ?? options.chatId,
            threadId: options.target?.threadId ?? options.threadId,
          }
        : undefined;
  let agentTarget: (TelegramTarget & { threadId: number }) | undefined;
  if (requestedAgentSelector) {
    if (!options.resolveAgentTarget || !options.routeAgentMessage) {
      throw new Error("Telegram agent turn routing is unavailable.");
    }
    agentTarget = await options.resolveAgentTarget(requestedAgentSelector);
  }
  const { chatId, target } = resolveTelegramOutboundTarget({
    chatId: agentTarget?.chatId ?? options.chatId,
    threadId: agentTarget?.threadId ?? options.threadId,
    target: agentTarget ?? options.target,
    getDefaultChatId: options.getDefaultChatId,
    getDefaultTarget: options.getDefaultTarget,
  });
  if (activeTurn) {
    const hasExplicitTarget =
      options.chatId !== undefined ||
      options.target !== undefined ||
      options.agentThread !== undefined;
    const activeTarget = activeTurn.target ?? { chatId: activeTurn.chatId };
    const requestedTarget = target ?? { chatId };
    const targetsMatch =
      activeTarget.chatId === requestedTarget.chatId &&
      activeTarget.threadId === requestedTarget.threadId;
    if (!hasExplicitTarget || targetsMatch) {
      throw new Error(
        "telegram_message cannot send directly to the active Telegram turn target; return the text normally so the bridge can deliver it once",
      );
    }
  }
  const plan = options.planMessage(options.text);
  const messageId = await options.sendMarkdownMessage(chatId, plan.markdown, {
    replyMarkup: plan.replyMarkup,
    target,
  });
  if (agentTarget) {
    if (messageId === undefined) {
      throw new Error(
        "Telegram message was sent but no message id was returned for agent routing.",
      );
    }
    await options.routeAgentMessage!({
      target: agentTarget,
      messageId,
      text: options.text,
    });
  }
  return {
    content: [
      {
        type: "text",
        text: formatTelegramOutboundMessageToolResultText(chatId),
      },
    ],
    details: { chatId, messageId },
  };
}

export async function sendTelegramOutboundFiles(options: {
  paths: string[];
  chatId?: number;
  threadId?: number;
  target?: TelegramTarget;
  caption?: string;
  maxAttachmentsPerTurn: number;
  maxAttachmentSizeBytes?: number;
  sendMultipart: TelegramQueuedOutboundAttachmentDeliveryDeps["sendMultipart"];
  getDefaultChatId?: () => number | undefined;
  getDefaultTarget?: () => TelegramTarget | undefined;
  canSendDirect?: () => boolean;
  statPath?: (path: string) => Promise<{ isFile(): boolean; size?: number }>;
}): Promise<
  TelegramOutboundAttachmentToolResult & {
    details: { paths: string[]; chatId: number };
  }
> {
  assertTelegramDirectDeliveryAllowed(options.canSendDirect);
  if (options.paths.length > options.maxAttachmentsPerTurn) {
    throw new Error(
      `Attachment limit reached (${options.maxAttachmentsPerTurn})`,
    );
  }
  const { chatId, target } = resolveTelegramOutboundTarget({
    chatId: options.chatId,
    threadId: options.threadId,
    target: options.target,
    getDefaultChatId: options.getDefaultChatId,
    getDefaultTarget: options.getDefaultTarget,
  });
  const pendingAttachments = await buildTelegramOutboundAttachmentViews({
    paths: options.paths,
    maxAttachmentSizeBytes: options.maxAttachmentSizeBytes,
    statPath: options.statPath,
  });
  for (const [index, attachment] of pendingAttachments.entries()) {
    const isPhoto = isTelegramOutboundPhotoAttachmentPath(attachment.path);
    const method = isPhoto ? "sendPhoto" : "sendDocument";
    const fieldName = isPhoto ? "photo" : "document";
    await options.sendMultipart(
      method,
      {
        chat_id: String(chatId),
        ...(options.caption && index === 0 ? { caption: options.caption } : {}),
        ...getTelegramMultipartTargetFields(target),
      },
      fieldName,
      attachment.path,
      attachment.fileName,
    );
  }
  const added = pendingAttachments.map((attachment) => attachment.path);
  return {
    content: [
      {
        type: "text",
        text: formatTelegramOutboundAttachmentToolResultText(
          added.length,
          "sent",
        ),
      },
    ],
    details: { paths: added, chatId },
  };
}

export function createTelegramQueuedOutboundAttachmentSender(
  deps: TelegramQueuedOutboundAttachmentDeliveryDeps,
) {
  return async (
    turn: TelegramQueuedOutboundAttachmentTurnView,
    options?: { isDeliveryActive?: () => boolean },
  ): Promise<void> => {
    await sendQueuedTelegramOutboundAttachments(turn, {
      ...deps,
      isDeliveryActive: () => deps.isDeliveryActive?.() !== false && options?.isDeliveryActive?.() !== false,
      maxAttachmentSizeBytes:
        deps.maxAttachmentSizeBytes ?? TELEGRAM_OUTBOUND_ATTACHMENT_MAX_BYTES,
    });
  };
}

export async function sendQueuedTelegramOutboundAttachments(
  turn: TelegramQueuedOutboundAttachmentTurnView,
  deps: TelegramQueuedOutboundAttachmentDeliveryDeps,
): Promise<void> {
  for (const attachment of turn.queuedAttachments) {
    if (deps.isDeliveryActive?.() === false) return;
    try {
      if (deps.maxAttachmentSizeBytes !== undefined) {
        const stats = await (deps.statPath ?? stat)(attachment.path);
        if (deps.isDeliveryActive?.() === false) return;
        if (stats.size > deps.maxAttachmentSizeBytes) {
          throw new Error(
            formatTelegramOutboundAttachmentSizeLimitError(
              stats.size,
              deps.maxAttachmentSizeBytes,
            ),
          );
        }
      }
      const isPhoto = isTelegramOutboundPhotoAttachmentPath(attachment.path);
      const method = isPhoto ? "sendPhoto" : "sendDocument";
      const fieldName = isPhoto ? "photo" : "document";
      await withTelegramReplyParameters(
        turn.chatId, turn.replyToMessageId, turn.target,
        (replyParameters) => deps.sendMultipart(
          method,
          {
            chat_id: String(turn.chatId),
            ...(replyParameters ? { reply_parameters: JSON.stringify(replyParameters) } : {}),
            ...getTelegramMultipartTargetFields(turn.target),
          },
          fieldName,
          attachment.path,
          attachment.fileName,
        ),
      );
    } catch (error) {
      if (deps.isDeliveryActive?.() === false) return;
      const message = error instanceof Error ? error.message : String(error);
      deps.recordRuntimeEvent?.("attachment", error, {
        fileName: attachment.fileName,
      });
      await deps.sendTextReply(
        turn.chatId,
        turn.replyToMessageId,
        `Failed to send attachment ${attachment.fileName}: ${message}`,
        { target: turn.target },
      );
    }
  }
}
