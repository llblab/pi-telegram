/**
 * Telegram UI/compat rendering helpers
 * Zones: telegram rendering, shared text utils
 * Converts bridge-owned UI/status/menu/interactive text into Telegram-safe plain text and HTML chunks with chunk-boundary handling
 */
export declare const MAX_MESSAGE_LENGTH = 4096;
export declare function escapeHtml(text: string): string;
export declare function escapeHtmlAttribute(text: string): string;
export declare function chunkHtmlPreservingTags(html: string, maxLength: number): string[];
export declare function renderTelegramInlineMarkdownHtml(text: string, options?: {
    allowLinks?: boolean;
}): string;
export type TelegramRenderMode = "plain" | "markdown" | "html";
export interface TelegramRenderedChunk {
    text: string;
    parseMode?: "HTML";
}
export declare function renderTelegramMessage(text: string, options?: {
    mode?: TelegramRenderMode;
}): TelegramRenderedChunk[];
