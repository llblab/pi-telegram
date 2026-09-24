/**
 * Telegram outbound voice delivery helpers
 * Zones: telegram outbound, voice delivery
 * Owns native Telegram voice upload orchestration across configured voice handlers, programmatic outbound voice handlers, and registered synthesis providers
 */
import { unlink } from "node:fs/promises";
import { basename, extname } from "node:path";
import { assertTelegramInlineKeyboardCallbackData } from "./keyboard.js";
import { withTelegramReplyParameters } from "./replies.js";
import { getTelegramTargetThreadParams, } from "./target.js";
import { getTelegramVoiceSynthesisProviders } from "./voice.js";
import { isTelegramApiCommitUnknownError } from "./telegram-api.js";
async function ensureTelegramVoiceFileFormat(filePath) {
    const ext = extname(filePath).toLowerCase();
    if (ext === ".opus" || ext === ".ogg")
        return filePath;
    throw new Error(`Voice synthesis provider must return .ogg or .opus files, got ${ext}. ` +
        `Providers should handle format conversion internally.`);
}
async function sendVoiceChatAction(deps, chatId) {
    if (deps.sendRecordVoiceAction) {
        await deps.sendRecordVoiceAction(chatId).catch(() => { });
    }
    else {
        await deps.sendChatAction?.(chatId, "record_voice").catch(() => { });
    }
}
export function createTelegramVoiceReplySender(deps, ports = {}) {
    const uploadVoiceFile = async (turn, filePath, options) => {
        if (deps.isDeliveryActive?.() === false)
            return;
        const voiceFilePath = await ensureTelegramVoiceFileFormat(filePath);
        assertTelegramInlineKeyboardCallbackData(options?.replyMarkup);
        if (deps.isDeliveryActive?.() === false)
            return;
        await sendVoiceChatAction(deps, turn.chatId);
        if (deps.isDeliveryActive?.() === false)
            return;
        await withTelegramReplyParameters(turn.chatId, options?.replyToPrompt === false ? undefined : turn.replyToMessageId, turn.target, (replyParameters) => deps.sendMultipart("sendVoice", {
            chat_id: String(turn.chatId),
            ...(replyParameters ? { reply_parameters: JSON.stringify(replyParameters) } : {}),
            ...(turn.target
                ? Object.fromEntries(Object.entries(getTelegramTargetThreadParams(turn.target)).map(([key, value]) => [key, String(value)]))
                : {}),
            ...(options?.replyMarkup !== undefined && options.replyMarkup !== null
                ? {
                    reply_markup: typeof options.replyMarkup === "string"
                        ? options.replyMarkup
                        : JSON.stringify(options.replyMarkup),
                }
                : {}),
        }, "voice", voiceFilePath, basename(voiceFilePath)));
    };
    return async (turn, text, options) => {
        for (const handler of ports.findVoiceHandlers?.(deps.getHandlers?.()) ??
            []) {
            if (deps.isDeliveryActive?.() === false)
                return;
            try {
                const filePath = await ports.generateVoiceFile?.(text, {
                    lang: options?.lang,
                    rate: options?.rate,
                    handler,
                    tempDir: deps.tempDir,
                    cwd: deps.cwd,
                    execCommand: deps.execCommand,
                });
                if (!filePath)
                    continue;
                await uploadVoiceFile(turn, filePath, {
                    replyToPrompt: options?.replyToPrompt,
                    replyMarkup: options?.replyMarkup,
                });
                return;
            }
            catch (error) {
                if (isTelegramApiCommitUnknownError(error))
                    throw error;
                deps.recordRuntimeEvent?.("voice", error, {
                    phase: "template-handler-send",
                });
            }
        }
        for (const handler of ports.getProgrammaticVoiceHandlers?.() ?? []) {
            if (deps.isDeliveryActive?.() === false)
                return;
            try {
                const filePath = await handler(text, {
                    lang: options?.lang,
                    rate: options?.rate,
                });
                if (!filePath)
                    continue;
                await uploadVoiceFile(turn, filePath, {
                    replyToPrompt: options?.replyToPrompt,
                    replyMarkup: options?.replyMarkup,
                });
                return;
            }
            catch (error) {
                if (isTelegramApiCommitUnknownError(error))
                    throw error;
                deps.recordRuntimeEvent?.("voice", error, {
                    phase: "programmatic-handler-send",
                });
            }
        }
        const providers = getTelegramVoiceSynthesisProviders();
        for (const provider of providers) {
            if (deps.isDeliveryActive?.() === false)
                return;
            let voiceFilePath;
            let originalFilePath;
            try {
                if (typeof provider !== "function") {
                    deps.recordRuntimeEvent?.("voice", new Error("Registered voice synthesis provider is not callable (policy-only object?)"), { phase: "voice-provider-skip" });
                    continue;
                }
                const providerResult = await provider(text, {
                    lang: options?.lang,
                    rate: options?.rate,
                });
                if (!providerResult) {
                    deps.recordRuntimeEvent?.("voice", new Error("Voice synthesis provider returned empty path"), { phase: "voice-provider-skip" });
                    continue;
                }
                voiceFilePath = providerResult;
                originalFilePath = providerResult;
                await uploadVoiceFile(turn, providerResult, {
                    replyToPrompt: options?.replyToPrompt,
                    replyMarkup: options?.replyMarkup,
                });
                return;
            }
            catch (error) {
                if (isTelegramApiCommitUnknownError(error))
                    throw error;
                deps.recordRuntimeEvent?.("voice", error, { phase: "send" });
            }
            finally {
                if (voiceFilePath && voiceFilePath !== originalFilePath) {
                    await unlink(voiceFilePath).catch(() => { });
                }
            }
        }
        const errorMessage = "Failed to send voice reply: every voice synthesis provider and outbound voice handler failed.";
        deps.recordRuntimeEvent?.("voice", new Error(errorMessage), {
            phase: "send",
        });
        throw new Error(errorMessage);
    };
}
