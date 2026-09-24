/**
 * Telegram reply delivery helpers
 * Zones: telegram outbound, native rich markdown, UI/compat rendering transport
 * Owns native assistant replies, rendered UI delivery, guest placeholder rotation, reply transport wiring, and plain text replies
 */
import { type TelegramTarget } from "./target.ts";
import type { TelegramInputRichMessage, TelegramReplyParameters, TelegramSendRichMessageBody, TelegramSentMessage } from "./telegram-api.ts";
import { renderTelegramMessage, type TelegramRenderedChunk, type TelegramRenderMode } from "./rendering.ts";
export { renderTelegramMessage, type TelegramRenderedChunk, type TelegramRenderMode, };
export declare function renderTelegramMarkdownToHtmlDraft(markdown: string): string;
export declare const TELEGRAM_RICH_MESSAGE_MAX_CHARS = 32768;
export declare const TELEGRAM_RICH_MESSAGE_MAX_BLOCKS = 500;
/** Non-persistent reply deduplication for a single agent turn.
 *  First reply to a prompt gets `reply_parameters.message_id`;
 *  subsequent replies in the same turn skip it to avoid stacking
 *  duplicate reply headers in the chat viewport. */
export interface ReplyDedupRuntime {
    /** Returns true if this is the first reply for the given prompt
     *  message id in the current turn. Side-effect: marks it replied. */
    shouldReply(promptMessageId: number): boolean;
    /** Reset the tracker when a new prompt enters the queue. */
    reset(): void;
}
export declare function createReplyDedupRuntime(): ReplyDedupRuntime;
export declare function resetTransportReplyDedup(): void;
/** Keeps a successfully published transition notice as the first reply of the
 * next agent turn. The following agent-start reset consumes this one-shot
 * preservation, so later messages in that turn do not repeat the reply header. */
export declare function preserveTransportReplyDedupOnNextReset(chatId: number, messageId: number, target?: TelegramTarget): void;
export declare function buildTelegramReplyParameters(chatId: number, messageId: number | undefined, target?: TelegramTarget): TelegramReplyParameters | undefined;
export declare function withTelegramReplyParameters<T>(chatId: number, messageId: number | undefined, target: TelegramTarget | undefined, send: (parameters: TelegramReplyParameters | undefined) => Promise<T>): Promise<T>;
export declare function isAssistantAgentMessage(message: unknown): boolean;
export declare function getAgentMessageText(message: unknown): string;
export declare function extractLatestAssistantMessageText(messages: readonly unknown[]): {
    text?: string;
    stopReason?: string;
    errorMessage?: string;
};
/**
 * Extract the run's answer without trusting an empty final assistant message.
 * A low-level run may end with a completed assistant message whose content was
 * suppressed (a companion extension preserving an earlier draft, for example
 * State Flow's fallback final:true patch turn). In that case the run's answer
 * is the latest earlier completed assistant message that carries text;
 * tool-use prefaces, errors, and aborts stay excluded.
 */
export declare function extractRunAssistantMessage(messages: readonly unknown[]): {
    text?: string;
    stopReason?: string;
    errorMessage?: string;
    recoveredFromEarlier?: boolean;
};
export interface TelegramReplyOwnershipRecorder {
    record: (input: {
        chatId: number;
        messageId: number;
        target?: TelegramTarget;
    }) => void;
}
export interface TelegramReplyDeliveryDeps<TReplyMarkup> {
    recordOwnership?: TelegramReplyOwnershipRecorder["record"];
    sendMessage: (body: {
        chat_id: number;
        text: string;
        parse_mode?: "HTML";
        reply_markup?: TReplyMarkup;
        reply_parameters?: TelegramReplyParameters;
        reply_to_message_id?: number;
        message_thread_id?: number;
    }) => Promise<TelegramSentMessage>;
    editMessage: (body: {
        chat_id: number;
        message_id: number;
        text?: string;
        rich_message?: TelegramInputRichMessage;
        parse_mode?: "HTML";
        reply_markup?: TReplyMarkup;
        message_thread_id?: number;
    }) => Promise<unknown>;
}
export interface TelegramReplyTargetOptions {
    target?: TelegramTarget;
    replyToMessageId?: number;
}
export interface TelegramReplyTransport<TReplyMarkup> {
    sendRenderedChunks: (chatId: number, chunks: TelegramRenderedChunk[], options?: TelegramReplyTargetOptions & {
        replyMarkup?: TReplyMarkup;
    }) => Promise<number | undefined>;
    editRenderedMessage: (chatId: number, messageId: number, chunks: TelegramRenderedChunk[], options?: TelegramReplyTargetOptions & {
        replyMarkup?: TReplyMarkup;
    }) => Promise<number | undefined>;
}
export declare function buildTelegramReplyTransport<TReplyMarkup>(deps: TelegramReplyDeliveryDeps<TReplyMarkup>): TelegramReplyTransport<TReplyMarkup>;
export declare function sendTelegramRenderedChunks<TReplyMarkup>(chatId: number, chunks: TelegramRenderedChunk[], deps: TelegramReplyDeliveryDeps<TReplyMarkup>, options?: TelegramReplyTargetOptions & {
    replyMarkup?: TReplyMarkup;
}): Promise<number | undefined>;
export declare function editTelegramRenderedMessage<TReplyMarkup>(chatId: number, messageId: number, chunks: TelegramRenderedChunk[], deps: TelegramReplyDeliveryDeps<TReplyMarkup>, options?: TelegramReplyTargetOptions & {
    replyMarkup?: TReplyMarkup;
}): Promise<number | undefined>;
export interface TelegramTextReplyOptions extends TelegramReplyTargetOptions {
    parseMode?: "HTML";
}
export interface TelegramReplyRuntimeDeps<TReplyMarkup = unknown> {
    renderTelegramMessage: (text: string, options?: {
        mode?: TelegramRenderMode;
    }) => TelegramRenderedChunk[];
    sendRenderedChunks: (chunks: TelegramRenderedChunk[], options?: {
        replyMarkup?: TReplyMarkup;
    } & TelegramReplyTargetOptions) => Promise<number | undefined>;
}
export declare function sendTelegramPlainReply(text: string, deps: TelegramReplyRuntimeDeps, options?: TelegramTextReplyOptions): Promise<number | undefined>;
export declare function normalizeTelegramNativeMarkdown(markdown: string): string;
export declare function splitTelegramNativeMarkdown(markdown: string): string[];
export declare function sendTelegramNativeMarkdownReply<TReplyMarkup = unknown>(chatId: number, replyToMessageId: number | undefined, markdown: string, deps: {
    recordOwnership?: TelegramReplyOwnershipRecorder["record"];
    sendRichMessage: (body: TelegramSendRichMessageBody) => Promise<TelegramSentMessage>;
}, options?: TelegramReplyTargetOptions & {
    replyMarkup?: TReplyMarkup;
}): Promise<number | undefined>;
export declare function sendTelegramNativeRichMessage(chatId: number, richMessage: TelegramInputRichMessage, deps: {
    recordOwnership?: TelegramReplyOwnershipRecorder["record"];
    sendRichMessage: (body: TelegramSendRichMessageBody) => Promise<TelegramSentMessage>;
}, options?: TelegramReplyTargetOptions): Promise<number>;
export type TelegramAssistantRenderingMode = "rich" | "html";
export interface TelegramRenderedMessageRuntimeDeps<TReplyMarkup> {
    renderTelegramMessage: (text: string, options?: {
        mode?: TelegramRenderMode;
    }) => TelegramRenderedChunk[];
    replyTransport: TelegramReplyTransport<TReplyMarkup>;
    recordOwnership?: TelegramReplyOwnershipRecorder["record"];
    getAssistantRenderingMode?: () => TelegramAssistantRenderingMode;
    sendRichMessage: (body: TelegramSendRichMessageBody) => Promise<TelegramSentMessage>;
}
export interface TelegramRenderedMessageRuntime<TReplyMarkup> {
    sendTextReply: (chatId: number, replyToMessageId: number | undefined, text: string, options?: TelegramTextReplyOptions) => Promise<number | undefined>;
    sendMarkdownReply: (chatId: number, replyToMessageId: number | undefined, markdown: string, options?: TelegramReplyTargetOptions & {
        replyMarkup?: TReplyMarkup;
    }) => Promise<number | undefined>;
    editInteractiveMessage: (chatId: number, messageId: number, text: string, mode: TelegramRenderMode, replyMarkup: TReplyMarkup) => Promise<void>;
    sendInteractiveMessage: (chatId: number, text: string, mode: TelegramRenderMode, replyMarkup: TReplyMarkup, options?: TelegramReplyTargetOptions) => Promise<number | undefined>;
    sendSectionRichMessage: (chatId: number, message: TelegramInputRichMessage, options?: TelegramReplyTargetOptions) => Promise<number>;
}
export interface TelegramRenderedMessageDeliveryRuntime<TReplyMarkup> extends TelegramRenderedMessageRuntime<TReplyMarkup> {
    replyTransport: TelegramReplyTransport<TReplyMarkup>;
}
export interface TelegramRenderedMessageDeliveryRuntimeDeps<TReplyMarkup> extends TelegramReplyDeliveryDeps<TReplyMarkup> {
    renderTelegramMessage?: (text: string, options?: {
        mode?: TelegramRenderMode;
    }) => TelegramRenderedChunk[];
    getAssistantRenderingMode?: () => TelegramAssistantRenderingMode;
    sendRichMessage: (body: TelegramSendRichMessageBody) => Promise<TelegramSentMessage>;
}
export declare function createTelegramRenderedMessageDeliveryRuntime<TReplyMarkup>(deps: TelegramRenderedMessageDeliveryRuntimeDeps<TReplyMarkup>): TelegramRenderedMessageDeliveryRuntime<TReplyMarkup>;
export declare function createTelegramRenderedMessageRuntime<TReplyMarkup>(deps: TelegramRenderedMessageRuntimeDeps<TReplyMarkup>): TelegramRenderedMessageRuntime<TReplyMarkup>;
/** Wrap a sendTextReply with reply dedup so only the first message
 *  in a turn carries reply metadata. */
export declare function dedupSendTextReply(dedup: ReplyDedupRuntime, inner: (chatId: number, replyToMessageId: number | undefined, text: string, options?: TelegramTextReplyOptions) => Promise<number | undefined>): (chatId: number, replyToMessageId: number, text: string, options?: TelegramTextReplyOptions) => Promise<number | undefined>;
/**
 * Guest reply sender: answers guest queries with native Rich Markdown content.
 * Guest queries use InlineQueryResult input_message_content rather than chat
 * sendRichMessage, so this stays as a dedicated guest transport adapter.
 */
export declare function createGuestMarkdownReplySender(deps: {
    answerGuestQuery: (guestQueryId: string, text?: string, options?: {
        parseMode?: string;
        richMessage?: TelegramInputRichMessage;
    }) => Promise<void>;
}): (guestQueryId: string, markdown: string) => Promise<void>;
/**
 * Guest reply editor: replaces the early Guest Mode placeholder ACK with
 * native Rich Markdown content addressed by `inline_message_id` instead of a
 * chat/message pair.
 */
export declare function createGuestMarkdownReplyEditor(deps: {
    editGuestInlineMessage: (inlineMessageId: string, content: {
        richMessage?: TelegramInputRichMessage;
        text?: string;
    }) => Promise<void>;
}): (inlineMessageId: string, markdown: string) => Promise<void>;
/**
 * Guest Mode placeholder rotation: the early ACK is the first placeholder
 * frame and the runtime steps the remaining frames once per interval, moving
 * the globe every second while the trailing dots grow once every two seconds.
 *
 * Rotation completes whole six-frame cycles and only stops once at least
 * `TELEGRAM_GUEST_PLACEHOLDER_MIN_MS` has elapsed, so a pending answer holds
 * the finished cycle's last frame (`🌏 Working on it...`) instead of whatever
 * step a hard time cap happens to cut. The `TELEGRAM_GUEST_PLACEHOLDER_MAX_MS`
 * safety bound keeps the edit stream clear of the first flood-control
 * rejections measured in live guest runs (+26.5 s at ~53 edits, +27.8 s at
 * ~28 edits): rotation caps at 23 edits and never starts a frame after 26 s.
 */
export declare const TELEGRAM_GUEST_PLACEHOLDER_FRAME_MS = 1000;
export declare const TELEGRAM_GUEST_PLACEHOLDER_MIN_MS = 20000;
export declare const TELEGRAM_GUEST_PLACEHOLDER_MAX_MS = 26000;
export declare const TELEGRAM_GUEST_PLACEHOLDER_FRAMES: readonly ["<b>🌎 Working on it.</b>", "<b>🌍 Working on it.</b>", "<b>🌏 Working on it..</b>", "<b>🌎 Working on it..</b>", "<b>🌍 Working on it...</b>", "<b>🌏 Working on it...</b>"];
export declare const TELEGRAM_DISMISSED_GUEST_PLACEHOLDER_TEXT = "\u2063";
export declare function buildTelegramGuestPlaceholderFrame(step: number): string;
export interface TelegramGuestPlaceholderRuntimeDeps {
    editGuestInlineMessage: (inlineMessageId: string, content: {
        text: string;
        parseMode: "HTML";
    }) => Promise<void>;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    intervalMs?: number;
    minMs?: number;
    maxMs?: number;
    now?: () => number;
    setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}
export interface TelegramGuestPlaceholderRuntime {
    /** Starts the frame loop on an answered guest inline message. */
    start: (inlineMessageId: string) => void;
    /** Cancels the loop and waits for any in-flight frame edit before returning. */
    stop: (inlineMessageId: string) => Promise<void>;
    /** Cancels every loop without waiting for in-flight edits (session shutdown). */
    stopAll: () => void;
    /** Stops rotation and visually clears the inline placeholder. */
    dismiss: (inlineMessageId: string) => Promise<void>;
}
export declare function createTelegramGuestPlaceholderRuntime(deps: TelegramGuestPlaceholderRuntimeDeps): TelegramGuestPlaceholderRuntime;
