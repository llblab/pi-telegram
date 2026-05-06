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
  statPath?: (path: string) => Promise<{ isFile(): boolean; size?: number }>;
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

function formatTelegramOutboundAttachmentToolResultText(count: number): string {
  // Pi's compact tool rows need an empty first line to visually separate header and result
  return ["", `Queued ${count} Telegram attachment(s).`].join("\n");
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
      "Queue one or more local files to be sent with the next Telegram reply.",
    promptSnippet: "Queue local files to be sent with the next Telegram reply.",
    promptGuidelines: [
      "When handling a [telegram] message and the user asked for a file or generated artifact, call telegram_attach with the local path instead of only mentioning the path in text.",
    ],
    parameters: Type.Object({
      paths: Type.Array(
        Type.String({ description: "Local file path to attach" }),
        { minItems: 1, maxItems: maxAttachmentsPerTurn },
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        return await queueTelegramOutboundAttachments({
          activeTurn: deps.getActiveTurn(),
          paths: params.paths,
          maxAttachmentsPerTurn,
          maxAttachmentSizeBytes,
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
  maxAttachmentsPerTurn: number;
  maxAttachmentSizeBytes?: number;
  statPath?: (path: string) => Promise<{ isFile(): boolean; size?: number }>;
}): Promise<TelegramOutboundAttachmentToolResult> {
  if (!options.activeTurn) {
    throw new Error(
      "telegram_attach can only be used while replying to an active Telegram turn",
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
