/**
 * Telegram outbound markup parsing helpers
 * Zones: telegram outbound, assistant markup
 * Owns assistant action comment/fence parsing, declarative UI wire validation, and markup stripping shared by voice and outbound delivery
 */
import type { TelegramInlineKeyboardButtonStyle } from "./keyboard.ts";
export interface TelegramHtmlComment {
    raw: string;
    content: string;
    start: number;
    end: number;
}
export declare function collectTelegramHtmlComments(markdown: string): {
    comments: TelegramHtmlComment[];
    openCommentStart?: number;
};
export declare function replaceTelegramButtonFences(markdown: string, replace: (payload: string, closed: boolean, element: string) => string, elements?: readonly string[]): string;
export declare function replaceTelegramHtmlComments(markdown: string, replacer: (comment: TelegramHtmlComment) => string): string;
export declare function parseTelegramButtonPayloadRows(source: string): Record<string, unknown>[][] | undefined;
export declare function parseTelegramActionPayloadRows(comment: TelegramHtmlComment, command: string): Record<string, unknown>[][] | undefined;
export interface TelegramUiQuestion {
    readonly id?: string;
    readonly question: string;
    readonly timeoutMs: number;
    readonly cancelLabel: string;
}
export interface TelegramUiChoiceCell {
    readonly label: string;
    readonly value: string;
    readonly style?: TelegramInlineKeyboardButtonStyle;
    readonly disabled: boolean;
}
export type TelegramUiChoiceRows = readonly (readonly TelegramUiChoiceCell[])[];
export interface TelegramUiChoiceQuestion extends TelegramUiQuestion {
    readonly rows: TelegramUiChoiceRows;
    /** Exact number of choices required; omitted means one. */
    readonly select?: number;
}
export type TelegramUiDeclaration = {
    readonly kind: "choice";
    readonly batched: boolean;
    readonly questions: readonly TelegramUiChoiceQuestion[];
    readonly timeoutMs: number;
} | (TelegramUiQuestion & {
    readonly kind: "confirm";
    readonly confirmLabel: string;
    readonly confirmStyle?: TelegramInlineKeyboardButtonStyle;
}) | (TelegramUiQuestion & {
    readonly kind: "text_input";
    readonly maxLength: number;
    readonly multiline: boolean;
}) | (TelegramUiQuestion & {
    readonly kind: "attachment";
    readonly accept: readonly string[];
    readonly maxFiles: number;
    readonly maxBytes: number;
});
export type TelegramUiDeclarationParseResult = {
    readonly ok: true;
    readonly declaration: TelegramUiDeclaration;
} | {
    readonly ok: false;
    readonly reason: "unsupported-element" | "invalid-declaration";
    readonly message: string;
};
/** Representation only. Private opt-in changes omitted Confirm/Choice defaults, not explicit bounds or runtime authority. */
export declare function parseTelegramUiDeclaration(element: string, source: string, questionHeadTail?: true): TelegramUiDeclarationParseResult;
/** Emit canonical matrix syntax; conversion preserves semantics, not original spelling. */
export declare function formatTelegramUiChoiceRows(rows: TelegramUiChoiceRows, format: "json" | "cml"): string;
export declare function stripTelegramCommentMarkupForPreview(markdown: string): string;
export declare function stripTelegramCommentMarkupForDelivery(markdown: string): string;
export interface TelegramVoiceReplyItem {
    text: string;
    lang?: string;
    rate?: string;
}
export interface TelegramVoiceReplyPlan {
    markdown: string;
    voiceText?: string;
    voiceReplies?: TelegramVoiceReplyItem[];
    lang?: string;
    rate?: string;
}
export declare function getTelegramActionString(payload: Record<string, unknown>, key: string): string | undefined;
export declare function planTelegramVoiceReply(markdown: string): TelegramVoiceReplyPlan;
