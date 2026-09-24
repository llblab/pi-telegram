/**
 * Bridge-owned Telegram activity verbosity projection
 * Zones: telegram activity, rich rendering, operational delivery
 * Owns persistent bounded thinking and tool disclosures; excludes activity normalization, assistant answer rendering, and transport authority policy
 */
import type { TelegramActivityEvent, TelegramActivityPublicationRuntime } from "./activity.ts";
import type { TelegramEditMessageTextBody, TelegramInputRichMessage, TelegramSendMessageBody, TelegramSendRichMessageBody, TelegramSentMessage } from "./telegram-api.ts";
import type { TelegramTarget } from "./target.ts";
export declare const TELEGRAM_ACTIVITY_DETAIL_MAX_CHARS = 1200;
export declare const TELEGRAM_ACTIVITY_MESSAGE_MAX_CHARS = 3900;
export declare const TELEGRAM_ACTIVITY_MESSAGE_MAX_TOOLS = 6;
export declare const TELEGRAM_REASONING_MESSAGE_MAX_FRAMES = 24;
export declare const TELEGRAM_REASONING_BUFFER_MAX_CHARS = 1200;
export declare const TELEGRAM_REASONING_MIN_INTERVAL_MS = 2000;
export declare const TELEGRAM_TOOL_UPDATE_MAX_ENTRIES = 4;
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
export declare function renderTelegramToolActivityHtml(tools: readonly ToolActivity[]): string;
export declare function renderTelegramToolActivityRichMessage(tools: readonly ToolActivity[]): TelegramInputRichMessage;
export declare function renderTelegramThinkingActivityHtml(text: string): string;
export interface TelegramActivityVerbosityRuntime {
    accept: (event: TelegramActivityEvent) => void;
    reset: () => void;
    stop: () => void;
    waitForIdle: () => Promise<void>;
}
export interface TelegramActivityVerbosityBinding extends TelegramActivityVerbosityRuntime {
    bind: (runtime: TelegramActivityVerbosityRuntime) => void;
}
export declare function createTelegramActivityVerbosityBinding(): TelegramActivityVerbosityBinding;
export declare function createTelegramActivityVerbosityRuntime<TAuthority>(deps: {
    enqueue?: TelegramActivityPublicationRuntime["enqueue"];
    getActivityMode: () => "quiet" | "thinking" | "tools" | "verbose";
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
    recordFailure?: (operation: "config-refresh" | "reasoning-send" | "reasoning-edit" | "tool-send" | "tool-edit", event: TelegramActivityEvent, error: unknown) => void;
}): TelegramActivityVerbosityRuntime;
export {};
