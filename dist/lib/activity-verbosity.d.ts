/**
 * Bridge-owned Telegram activity verbosity projection
 * Zones: telegram activity, rich rendering, operational delivery
 * Owns persistent bounded thinking and tool disclosures; excludes activity normalization, assistant answer rendering, and transport authority policy
 */
import type { TelegramActivityEvent, TelegramActivityPublicationRuntime } from "./activity.ts";
import { type TelegramTarget } from "./target.ts";
import type { TelegramEditMessageTextBody, TelegramInputRichMessage, TelegramSendMessageBody, TelegramSendRichMessageBody, TelegramSentMessage } from "./telegram-api.ts";
export declare const TELEGRAM_ACTIVITY_MESSAGE_MAX_TOOLS = 6;
export declare const TELEGRAM_REASONING_BUFFER_MAX_CHARS = 1200;
export declare const TELEGRAM_TOOL_UPDATE_MAX_ENTRIES = 4;
interface StreamToolLine {
    id: string;
    name: string;
    argsLine: string;
    status: "running" | "done" | "failed";
}
interface ToolActivity {
    id: string;
    name: string;
    args: string;
    updates: string[];
    droppedUpdates: number;
    result?: string;
    isError?: boolean;
    complete: boolean;
}
/** One compact `key: first-line value` for a tool's arguments. */
export declare function buildTelegramStreamArgsLine(args: unknown): string;
export declare function buildTelegramStreamToolLineHtml(tool: StreamToolLine): string;
/**
 * Pure composition of the single stream message: quoted thinking, one quoted
 * block of compact tool lines, then the live answer tail as inline HTML.
 */
export declare function buildTelegramStreamMessageHtml(input: {
    thinking: string;
    tools: readonly StreamToolLine[];
    droppedTools: number;
    answer: string;
}): string;
export declare function renderTelegramToolActivityHtml(tools: readonly ToolActivity[]): string;
export declare function renderTelegramToolActivityRichMessage(tools: readonly ToolActivity[]): TelegramInputRichMessage;
export declare function renderTelegramThinkingActivityHtml(text: string): string;
export interface TelegramActivityVerbosityRuntime {
    accept: (event: TelegramActivityEvent) => void;
    reset: () => void;
    stop: () => void;
    waitForIdle: () => Promise<void>;
    /** Delete the live stream-mode message and drop its state; safe with no message. */
    clearStreamMessage: () => Promise<void>;
    /** Message id of the live stream-mode message, for diagnostics and tests. */
    getStreamMessageId: () => number | undefined;
}
export declare function createTelegramActivityVerbosityRuntime<TAuthority>(deps: {
    enqueue?: TelegramActivityPublicationRuntime["enqueue"];
    getActivityMode: () => "quiet" | "thinking" | "tools" | "verbose" | "stream";
    refreshActivityMode?: () => Promise<void>;
    getNowMs?: () => number;
    setReasoningTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearReasoningTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
    resolveTarget: (event: TelegramActivityEvent) => TelegramTarget | undefined;
    captureAuthority: () => TAuthority;
    isAuthorityActive: (authority: TAuthority) => boolean;
    sendMessage: (body: TelegramSendMessageBody) => Promise<TelegramSentMessage>;
    sendRichMessage: (body: TelegramSendRichMessageBody) => Promise<TelegramSentMessage>;
    editMessageText: (body: TelegramEditMessageTextBody) => Promise<"edited" | "unchanged">;
    deleteMessage?: (chatId: number, messageId: number) => Promise<void>;
    recordFailure?: (operation: "config-refresh" | "reasoning-send" | "reasoning-edit" | "tool-send" | "tool-edit" | "stream-send" | "stream-edit" | "stream-delete", event: TelegramActivityEvent, error: unknown) => void;
}): TelegramActivityVerbosityRuntime;
export {};
