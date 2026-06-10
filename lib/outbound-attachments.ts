/**
 * Telegram outbound attachment helpers
 * Zones: telegram outbound, pi agent tool, filesystem
 * Owns telegram_attach registration, outbound attachment queueing, and delivery so Telegram file output stays in one domain module
 */

import { stat } from "node:fs/promises";
import { basename } from "node:path";

import { Type } from "@sinclair/typebox";

import type { ExtensionAPI } from "./pi.ts";
import { buildTelegramMultipartReplyParameters } from "./replies.ts";

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
  canSendDirect: () => boolean;
  planMessage: (markdown: string) => TelegramOutboundMessagePlan;
  sendMarkdownMessage: (
    chatId: number,
    markdown: string,
    options?: { replyMarkup?: unknown },
  ) => Promise<number | undefined>;
}

export interface TelegramQueuedOutboundAttachmentView {
  path: string;
  fileName: string;
}

export interface TelegramOutboundAttachmentQueueTargetView {
  queuedAttachments: TelegramQueuedOutboundAttachmentView[];
}

export interface TelegramQueuedOutboundAttachmentTurnView extends TelegramOutboundAttachmentQueueTargetView {
  chatId: number;
  replyToMessageId: number;
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
  // Pi's compact tool rows need an empty first line to visually separate header and result
  const verb = mode === "queued" ? "Queued" : "Sent";
  return ["", `${verb} ${count} Telegram attachment(s).`].join("\n");
}

function formatTelegramOutboundMessageToolResultText(chatId: number): string {
  return ["", `Sent Telegram message to ${chatId}.`].join("\n");
}

function assertTelegramDirectDeliveryAllowed(
  canSendDirect: (() => boolean) | undefined,
): void {
  if (canSendDirect?.()) return;
  throw new Error(
    "Telegram direct delivery requires this π instance to own /telegram-connect",
  );
}

function resolveTelegramOutboundChatId(options: {
  chatId?: number;
  getDefaultChatId?: () => number | undefined;
}): number {
  const chatId = options.chatId ?? options.getDefaultChatId?.();
  if (chatId === undefined) {
    throw new Error(
      "Telegram chat_id is required when no paired/default Telegram chat is available",
    );
  }
  return chatId;
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
    promptSnippet:
      "Queue files for the active Telegram reply; outside Telegram turns, send files directly to Telegram.",
    promptGuidelines: [
      "When handling a [telegram] message and the user asked for a file or generated artifact, call telegram_attach with the local path instead of only mentioning the path in text.",
      "When a local/TUI user explicitly asks to send a generated file to Telegram, telegram_attach can deliver it to the paired/default Telegram chat even without an active Telegram turn.",
    ],
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
          caption: params.caption,
          maxAttachmentsPerTurn,
          maxAttachmentSizeBytes,
          sendMultipart: deps.sendMultipart,
          getDefaultChatId: deps.getDefaultChatId,
          canSendDirect: deps.canSendDirect,
          statPath: deps.statPath,
        });
      } catch (error) {
        deps.recordRuntimeEvent?.("attachment", error, {
          phase: "queue",
          count: params.paths.length,
        });
        throw error;
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
      "Send a Markdown text message directly to the paired/default Telegram chat or an explicit chat_id. Hidden telegram_button comments in the text become attached inline prompt buttons.",
    promptSnippet:
      "Send direct Telegram Markdown text when the user explicitly asks for Telegram delivery outside the normal reply flow.",
    promptGuidelines: [
      "Use telegram_message only when the user explicitly asks to send a message to Telegram from the local/TUI side, or names a concrete Telegram delivery target.",
      "Add buttons by embedding the same top-level telegram_button HTML comments used in normal Telegram replies; Telegram does not support standalone buttons.",
      "Do not use this tool for ordinary Telegram-originated replies; answer normally so the bridge can deliver the active turn reply.",
    ],
    parameters: Type.Object({
      text: Type.String({ description: "Message text to send" }),
      chat_id: Type.Optional(
        Type.Number({ description: "Optional Telegram chat id" }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        return await sendTelegramOutboundMessage({
          text: params.text,
          chatId: params.chat_id,
          getDefaultChatId: deps.getDefaultChatId,
          canSendDirect: deps.canSendDirect,
          planMessage: deps.planMessage,
          sendMarkdownMessage: deps.sendMarkdownMessage,
        });
      } catch (error) {
        deps.recordRuntimeEvent?.("message", error, { phase: "direct" });
        throw error;
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
  ) => Promise<unknown>;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  statPath?: (path: string) => Promise<{ size: number }>;
  maxAttachmentSizeBytes?: number;
}

export async function queueTelegramOutboundAttachments(options: {
  activeTurn: TelegramOutboundAttachmentQueueTargetView | undefined;
  paths: string[];
  chatId?: number;
  caption?: string;
  maxAttachmentsPerTurn: number;
  maxAttachmentSizeBytes?: number;
  sendMultipart?: TelegramQueuedOutboundAttachmentDeliveryDeps["sendMultipart"];
  getDefaultChatId?: () => number | undefined;
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
      caption: options.caption,
      maxAttachmentsPerTurn: options.maxAttachmentsPerTurn,
      maxAttachmentSizeBytes: options.maxAttachmentSizeBytes,
      sendMultipart: options.sendMultipart,
      getDefaultChatId: options.getDefaultChatId,
      canSendDirect: options.canSendDirect,
      statPath: options.statPath,
    });
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

export async function sendTelegramOutboundMessage(options: {
  text: string;
  chatId?: number;
  getDefaultChatId?: () => number | undefined;
  canSendDirect: () => boolean;
  planMessage: (markdown: string) => TelegramOutboundMessagePlan;
  sendMarkdownMessage: (
    chatId: number,
    markdown: string,
    options?: { replyMarkup?: unknown },
  ) => Promise<number | undefined>;
}): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: { chatId: number; messageId?: number };
}> {
  assertTelegramDirectDeliveryAllowed(options.canSendDirect);
  const chatId = resolveTelegramOutboundChatId({
    chatId: options.chatId,
    getDefaultChatId: options.getDefaultChatId,
  });
  const plan = options.planMessage(options.text);
  const messageId = await options.sendMarkdownMessage(chatId, plan.markdown, {
    replyMarkup: plan.replyMarkup,
  });
  return {
    content: [{ type: "text", text: formatTelegramOutboundMessageToolResultText(chatId) }],
    details: { chatId, messageId },
  };
}

export async function sendTelegramOutboundFiles(options: {
  paths: string[];
  chatId?: number;
  caption?: string;
  maxAttachmentsPerTurn: number;
  maxAttachmentSizeBytes?: number;
  sendMultipart: TelegramQueuedOutboundAttachmentDeliveryDeps["sendMultipart"];
  getDefaultChatId?: () => number | undefined;
  canSendDirect?: () => boolean;
  statPath?: (path: string) => Promise<{ isFile(): boolean; size?: number }>;
}): Promise<TelegramOutboundAttachmentToolResult & { details: { paths: string[]; chatId: number } }> {
  assertTelegramDirectDeliveryAllowed(options.canSendDirect);
  if (options.paths.length > options.maxAttachmentsPerTurn) {
    throw new Error(
      `Attachment limit reached (${options.maxAttachmentsPerTurn})`,
    );
  }
  const chatId = resolveTelegramOutboundChatId({
    chatId: options.chatId,
    getDefaultChatId: options.getDefaultChatId,
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
        text: formatTelegramOutboundAttachmentToolResultText(added.length, "sent"),
      },
    ],
    details: { paths: added, chatId },
  };
}

export function createTelegramQueuedOutboundAttachmentSender(
  deps: TelegramQueuedOutboundAttachmentDeliveryDeps,
) {
  return async function sendQueuedAttachments(
    turn: TelegramQueuedOutboundAttachmentTurnView,
  ): Promise<void> {
    await sendQueuedTelegramOutboundAttachments(turn, {
      ...deps,
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
    try {
      if (deps.maxAttachmentSizeBytes !== undefined) {
        const stats = await (deps.statPath ?? stat)(attachment.path);
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
      const replyParameters = buildTelegramMultipartReplyParameters(
        turn.chatId,
        turn.replyToMessageId,
      );
      await deps.sendMultipart(
        method,
        {
          chat_id: String(turn.chatId),
          ...(replyParameters ? { reply_parameters: replyParameters } : {}),
        },
        fieldName,
        attachment.path,
        attachment.fileName,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.recordRuntimeEvent?.("attachment", error, {
        fileName: attachment.fileName,
      });
      await deps.sendTextReply(
        turn.chatId,
        turn.replyToMessageId,
        `Failed to send attachment ${attachment.fileName}: ${message}`,
      );
    }
  }
}
