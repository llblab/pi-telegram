/**
 * Telegram turn-building helpers
 * Zones: telegram inbound, pi agent prompt content, queue
 * Owns prompt-turn summary and content construction so queued Telegram turns are assembled consistently
 */
import { type DownloadedTelegramMessageFile, type DownloadTelegramMessageFilesDeps, type TelegramMediaMessage } from "./media.ts";
import { truncateTelegramQueueSummary, type PendingTelegramTurn, type TelegramPreparedPromptTurn, type TelegramQueueItem, type TelegramQueueStore } from "./queue.ts";
import { type TelegramVoiceReplyMode } from "./voice.ts";
export declare const TELEGRAM_PREFIX = "[telegram]";
export declare const TELEGRAM_GUEST_TURN_NOTE = "[guest] delivery: answer quickly with one concise, self-contained reply";
export interface TelegramTurnTarget {
    chatId: number;
    threadId?: number;
}
export interface TelegramTurnMessage {
    message_id: number;
    message_thread_id?: number;
    pi_telegram_agent_source_thread?: string;
    pi_telegram_source_update_id?: number;
    chat: {
        id: number;
        type?: string;
    };
}
export type DownloadedTelegramTurnFile = DownloadedTelegramMessageFile;
export declare function createTelegramTurnPrefix(attributes?: Record<string, string | undefined>): string;
export declare function formatTelegramTurnPrefix(_message: TelegramTurnMessage, basePrefix?: string): string;
export { truncateTelegramQueueSummary };
export declare function formatTelegramTurnStatusSummary(rawText: string, files: DownloadedTelegramTurnFile[], handlerOutputs?: string[]): string;
export declare function buildTelegramTurnPrompt(options: {
    telegramPrefix: string;
    rawText: string;
    files: DownloadedTelegramTurnFile[];
    promptFiles?: DownloadedTelegramTurnFile[];
    displayFiles?: DownloadedTelegramTurnFile[];
    handlerOutputs?: string[];
    sourceContext?: string;
    historyTurns?: Pick<PendingTelegramTurn, "historyText">[];
    timeLine?: string | null;
    voiceContext?: Record<string, string>;
    guestTurn?: boolean;
}): string;
export declare function updateTelegramPromptTurnText(options: {
    turn: PendingTelegramTurn;
    telegramPrefix: string;
    rawText: string;
    statusText?: string;
}): PendingTelegramTurn;
export declare function updateQueuedTelegramPromptTurnText<TContext = unknown>(options: {
    items: TelegramQueueItem<TContext>[];
    sourceMessageId: number | undefined;
    telegramPrefix: string;
    rawText: string;
    statusText?: string;
}): {
    items: TelegramQueueItem<TContext>[];
    changed: boolean;
};
export interface TelegramQueuedPromptEditRuntimeDeps<TContext = unknown> extends TelegramQueueStore<TContext> {
    updateStatus: (ctx: TContext) => void;
}
export declare function createTelegramQueuedPromptEditRuntime<TMessage extends TelegramMediaMessage, TContext = unknown>(deps: TelegramQueuedPromptEditRuntimeDeps<TContext>): {
    updateFromEditedMessage: (message: TMessage, ctx: TContext) => boolean;
};
export interface BuildTelegramPromptTurnOptions {
    telegramPrefix: string;
    messages: TelegramTurnMessage[];
    historyTurns?: PendingTelegramTurn[];
    queueOrder: number;
    rawText: string;
    statusText?: string;
    files: DownloadedTelegramTurnFile[];
    promptFiles?: DownloadedTelegramTurnFile[];
    displayFiles?: DownloadedTelegramTurnFile[];
    handlerOutputs?: string[];
    sourceContext?: string;
    timeLine?: string | null;
    readBinaryFile: (path: string) => Promise<Uint8Array>;
    inferImageMimeType: (path: string) => string | undefined;
    voiceReplyMode?: TelegramVoiceReplyMode;
    voicePromptContribution?: string;
    admissionScope?: string;
    admissionJournalBinding?: string;
}
export type BuildTelegramPromptTurnRuntimeOptions = Omit<BuildTelegramPromptTurnOptions, "readBinaryFile">;
export interface TelegramPromptTurnRuntimeBuilderDeps<TContext = unknown> extends DownloadTelegramMessageFilesDeps {
    allocateQueueOrder: () => number;
    processAttachments?: (files: DownloadedTelegramTurnFile[], rawText: string, ctx: TContext) => Promise<{
        rawText: string;
        promptFiles?: DownloadedTelegramTurnFile[];
        handlerOutputs?: string[];
    }>;
    resolveTimeLine?: (chatId: number) => string | null;
    getVoiceReplyMode?: () => TelegramVoiceReplyMode;
    /** Returns the visible thread label for a message target, used to add thread context to the prompt prefix. */
    getTelegramThreadLabel?: (message: {
        chat: {
            id: number;
        };
        message_thread_id?: number;
    }) => string | undefined;
    getAllowedUserId?: () => number | undefined;
    getAdmissionScope?: () => string | undefined;
    getAdmissionJournalBinding?: () => string | undefined;
    assertExecutionCurrent?: (message: TelegramTurnMessage) => void;
}
export declare function createTelegramPromptTurnRuntimePreparer<TMessage extends TelegramTurnMessage & TelegramMediaMessage, TContext = unknown>(deps: TelegramPromptTurnRuntimeBuilderDeps<TContext>): (messages: TMessage[], ctx?: TContext) => Promise<TelegramPreparedPromptTurn>;
export declare function buildTelegramPromptTurn(options: BuildTelegramPromptTurnOptions): Promise<PendingTelegramTurn>;
export declare function buildTelegramPromptTurnRuntime(options: BuildTelegramPromptTurnRuntimeOptions): Promise<PendingTelegramTurn>;
