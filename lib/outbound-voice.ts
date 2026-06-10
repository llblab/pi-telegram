/**
 * Telegram outbound voice delivery helpers
 * Zones: telegram outbound, voice delivery
 * Owns native Telegram voice upload orchestration across configured voice handlers, programmatic outbound voice handlers, and registered synthesis providers
 */

import { unlink } from "node:fs/promises";
import { basename, extname } from "node:path";

import { assertTelegramInlineKeyboardCallbackData } from "./keyboard.ts";
import { getTelegramVoiceSynthesisProviders } from "./voice.ts";

export interface TelegramVoiceReplyTurnView {
  chatId: number;
  replyToMessageId: number;
}

export interface TelegramVoiceReplySenderDeps {
  execCommand: (
    command: string,
    args: string[],
    options?: {
      cwd?: string;
      timeout?: number;
      signal?: AbortSignal;
      stdin?: string;
      retry?: number;
    },
  ) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
  sendMultipart: (
    method: string,
    fields: Record<string, string>,
    fileField: string,
    filePath: string,
    fileName: string,
  ) => Promise<unknown>;
  sendChatAction?: (chatId: number, action: string) => Promise<unknown>;
  sendRecordVoiceAction?: (chatId: number) => Promise<unknown>;
  getHandlers?: () => unknown[] | undefined;
  cwd?: string;
  tempDir?: string;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export type TelegramOutboundProgrammaticVoiceHandler = (
  text: string,
  options?: { lang?: string; rate?: string },
) => Promise<string>;

export interface TelegramVoiceReplySenderPorts<THandler = unknown> {
  findVoiceHandlers?: (handlers: unknown[] | undefined) => THandler[];
  generateVoiceFile?: (
    text: string,
    options: {
      lang?: string;
      rate?: string;
      handler: THandler;
      tempDir?: string;
      cwd?: string;
      execCommand: TelegramVoiceReplySenderDeps["execCommand"];
    },
  ) => Promise<string | undefined>;
  getProgrammaticVoiceHandlers?: () => TelegramOutboundProgrammaticVoiceHandler[];
}

function buildVoiceReplyParameters(
  replyToPrompt: boolean | undefined,
  replyToMessageId: number | undefined,
): string | undefined {
  if (replyToPrompt === false || replyToMessageId === undefined)
    return undefined;
  return JSON.stringify({
    message_id: replyToMessageId,
    allow_sending_without_reply: true,
  });
}

async function ensureTelegramVoiceFileFormat(
  filePath: string,
): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".opus" || ext === ".ogg") return filePath;
  throw new Error(
    `Voice synthesis provider must return .ogg or .opus files, got ${ext}. ` +
      `Providers should handle format conversion internally.`,
  );
}

function extractVoiceResult(result: any): {
  filePath: string;
  transcriptText?: string;
} {
  if (typeof result === "string") return { filePath: result };
  return {
    filePath: result.audioPath,
    transcriptText: result.transcriptText,
  };
}

async function sendVoiceChatAction(
  deps: TelegramVoiceReplySenderDeps,
  chatId: number,
) {
  if (deps.sendRecordVoiceAction) {
    await deps.sendRecordVoiceAction(chatId).catch(() => {});
  } else {
    await deps.sendChatAction?.(chatId, "record_voice").catch(() => {});
  }
}

export function createTelegramVoiceReplySender<THandler = unknown>(
  deps: TelegramVoiceReplySenderDeps,
  ports: TelegramVoiceReplySenderPorts<THandler> = {},
) {
  async function uploadVoiceFile(
    turn: TelegramVoiceReplyTurnView,
    filePath: string,
    options?: {
      replyToPrompt?: boolean;
      replyMarkup?: unknown;
      transcriptText?: string;
    },
  ): Promise<void> {
    const voiceFilePath = await ensureTelegramVoiceFileFormat(filePath);
    assertTelegramInlineKeyboardCallbackData(options?.replyMarkup);
    await sendVoiceChatAction(deps, turn.chatId);
    const replyParameters = buildVoiceReplyParameters(
      options?.replyToPrompt,
      turn.replyToMessageId,
    );
    await deps.sendMultipart(
      "sendVoice",
      {
        chat_id: String(turn.chatId),
        ...(options?.transcriptText ? { caption: options.transcriptText } : {}),
        ...(replyParameters ? { reply_parameters: replyParameters } : {}),
        ...(options?.replyMarkup !== undefined && options.replyMarkup !== null
          ? {
              reply_markup:
                typeof options.replyMarkup === "string"
                  ? options.replyMarkup
                  : JSON.stringify(options.replyMarkup),
            }
          : {}),
      },
      "voice",
      voiceFilePath,
      basename(voiceFilePath),
    );
  }

  return async function sendVoiceReply(
    turn: TelegramVoiceReplyTurnView,
    text: string,
    options?: {
      lang?: string;
      rate?: string;
      replyToPrompt?: boolean;
      replyMarkup?: unknown;
    },
  ): Promise<void> {
    for (const handler of ports.findVoiceHandlers?.(deps.getHandlers?.()) ?? []) {
      try {
        const filePath = await ports.generateVoiceFile?.(text, {
          lang: options?.lang,
          rate: options?.rate,
          handler,
          tempDir: deps.tempDir,
          cwd: deps.cwd,
          execCommand: deps.execCommand,
        });
        if (!filePath) continue;
        await uploadVoiceFile(turn, filePath, {
          replyToPrompt: options?.replyToPrompt,
          replyMarkup: options?.replyMarkup,
        });
        return;
      } catch (error) {
        deps.recordRuntimeEvent?.("voice", error, {
          phase: "template-handler-send",
        });
      }
    }

    for (const handler of ports.getProgrammaticVoiceHandlers?.() ?? []) {
      try {
        const filePath = await handler(text, {
          lang: options?.lang,
          rate: options?.rate,
        });
        if (!filePath) continue;
        await uploadVoiceFile(turn, filePath, {
          replyToPrompt: options?.replyToPrompt,
          replyMarkup: options?.replyMarkup,
        });
        return;
      } catch (error) {
        deps.recordRuntimeEvent?.("voice", error, {
          phase: "programmatic-handler-send",
        });
      }
    }

    const providers = getTelegramVoiceSynthesisProviders();

    for (const provider of providers) {
      let voiceFilePath: string | undefined;
      let originalFilePath: string | undefined;

      try {
        if (typeof provider !== "function") {
          deps.recordRuntimeEvent?.(
            "voice",
            new Error(
              "Registered voice synthesis provider is not callable (policy-only object?)",
            ),
            { phase: "voice-provider-skip" },
          );
          continue;
        }

        const providerResult = await provider(text, {
          lang: options?.lang,
          rate: options?.rate,
        });

        if (!providerResult) {
          deps.recordRuntimeEvent?.(
            "voice",
            new Error("Voice synthesis provider returned empty path"),
            { phase: "voice-provider-skip" },
          );
          continue;
        }

        const { filePath, transcriptText } = extractVoiceResult(providerResult);
        voiceFilePath = filePath;
        originalFilePath = filePath;
        await uploadVoiceFile(turn, filePath, {
          replyToPrompt: options?.replyToPrompt,
          replyMarkup: options?.replyMarkup,
          transcriptText,
        });
        return;
      } catch (error) {
        deps.recordRuntimeEvent?.("voice", error, { phase: "send" });
      } finally {
        if (voiceFilePath && voiceFilePath !== originalFilePath) {
          await unlink(voiceFilePath).catch(() => {});
        }
      }
    }

    const errorMessage =
      "Failed to send voice reply: every voice synthesis provider and outbound voice handler failed.";
    deps.recordRuntimeEvent?.("voice", new Error(errorMessage), {
      phase: "send",
    });
    throw new Error(errorMessage);
  };
}
