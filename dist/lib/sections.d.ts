/**
 * Telegram Extension Sections registry and callback routing
 * Zones: telegram ui, extension platform, callback routing
 * Owns section registration, global registry binding, token mapping, main-menu/settings row injection, and section callback dispatch
 */
import { type TelegramInlineKeyboardMarkup } from "./keyboard.ts";
import type { TelegramInputRichMessage } from "./telegram-api.ts";
/** @internal */
export type TelegramSectionId = string;
/** @internal */
export type TelegramSectionToken = string;
/** @internal */
export type TelegramSectionCallbackResult = "handled" | "pass";
export interface TelegramSectionView {
    text: string;
    /**
     * Source format for extension-provided section content.
     * Defaults to "html" for explicit Telegram UI markup; use "markdown"
     * when a section naturally owns Markdown content, or "plain" for text.
     */
    parseMode?: "markdown" | "html" | "plain";
    replyMarkup?: TelegramInlineKeyboardMarkup;
}
export interface TelegramSectionSettingsRegistration {
    label: string;
    order?: number;
    getLabel?: () => string;
    open: (ctx: TelegramSectionContext) => TelegramSectionView | Promise<TelegramSectionView>;
    handleCallback?: (ctx: TelegramSectionCallbackContext) => TelegramSectionCallbackResult | Promise<TelegramSectionCallbackResult>;
}
export interface TelegramSectionRegistration {
    id: TelegramSectionId;
    label: string;
    order?: number;
    getLabel?: () => string;
    render: (ctx: TelegramSectionContext) => TelegramSectionView | Promise<TelegramSectionView>;
    handleCallback?: (ctx: TelegramSectionCallbackContext) => TelegramSectionCallbackResult | Promise<TelegramSectionCallbackResult>;
    settings?: TelegramSectionSettingsRegistration;
}
export interface TelegramSectionContext {
    sectionId: string;
    chatId: number;
    messageId?: number;
    answerCallback(text?: string): Promise<void>;
    edit(view: TelegramSectionView): Promise<void>;
    open(view: TelegramSectionView): Promise<void>;
    openRich(message: TelegramInputRichMessage): Promise<void>;
    enqueuePrompt(prompt: string): Promise<void>;
    callbackData(action: string, payload?: string): string;
    /** Delete the message that triggered this callback (dialog cleanup) */
    deleteMessage(): Promise<void>;
}
export interface TelegramSectionCallbackContext {
    sectionId: string;
    chatId: number;
    messageId?: number;
    action: string;
    payload: string;
    answerCallback(text?: string): Promise<void>;
    edit(view: TelegramSectionView): Promise<void>;
    open(view: TelegramSectionView): Promise<void>;
    openRich(message: TelegramInputRichMessage): Promise<void>;
    enqueuePrompt(prompt: string): Promise<void>;
    callbackData(action: string, payload?: string): string;
    /** Delete the message that triggered this callback (dialog cleanup) */
    deleteMessage(): Promise<void>;
}
/** @internal */
export interface RegisteredTelegramSection {
    id: TelegramSectionId;
    token: TelegramSectionToken;
    label: string;
    order: number;
    registration: TelegramSectionRegistration;
}
/** @internal */
export interface TelegramSectionDiagnostic {
    id: TelegramSectionId;
    token: TelegramSectionToken;
    label: string;
    status: "active" | "error";
    lastError?: string;
}
/** @internal */
export interface TelegramSectionRegistry {
    register(section: TelegramSectionRegistration): () => void;
    getSections(): RegisteredTelegramSection[];
    getByToken(token: TelegramSectionToken): RegisteredTelegramSection | undefined;
    getDiagnostics(): TelegramSectionDiagnostic[];
    recordError(token: TelegramSectionToken, message: string, source?: string): void;
    clearError(token: TelegramSectionToken, source?: string): void;
    clear(): void;
}
/** @internal */
export interface TelegramSectionMainMenuRow {
    text: string;
    callback_data: string;
}
/** @internal */
export interface TelegramSectionSettingsRow {
    label: string;
    callback_data: string;
}
/** @internal */
export interface TelegramSectionTarget {
    chatId: number;
    threadId?: number;
}
/** @internal */
export interface TelegramSectionRuntimeDeps {
    answerCallbackQuery: (id: string, text?: string) => Promise<void>;
    target?: TelegramSectionTarget;
    editInteractiveMessage: (chatId: number, messageId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: TelegramInlineKeyboardMarkup) => Promise<void>;
    sendInteractiveMessage: (chatId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: TelegramInlineKeyboardMarkup, options?: {
        target?: TelegramSectionTarget;
    }) => Promise<number | undefined>;
    sendRichMessage: (chatId: number, message: TelegramInputRichMessage, options?: {
        target?: TelegramSectionTarget;
    }) => Promise<number | undefined>;
    enqueuePrompt: (prompt: string) => Promise<void>;
    deleteMessage: (chatId: number, messageId: number) => Promise<void>;
}
/** @internal */
export declare function setGlobalTelegramSectionRegistry(registry: TelegramSectionRegistry): void;
/** @internal */
export declare function createAndBindTelegramSectionRegistry(): TelegramSectionRegistry;
/**
 * Register a Telegram Extension Section from any pi extension.
 * Returns a disposer. Throws if no section registry is active.
 */
export declare function registerTelegramSection(section: TelegramSectionRegistration): () => void;
/**
 * Get current section diagnostics. Returns empty array when registry is absent.
 * @internal
 */
export declare function getTelegramSectionDiagnostics(): TelegramSectionDiagnostic[];
/** @internal */
export declare function createTelegramExtensionSectionRegistry(): TelegramSectionRegistry;
/** @internal */
export declare function getTelegramExtensionSettingsRows(registry: TelegramSectionRegistry): TelegramSectionSettingsRow[];
/** @internal */
export declare function getTelegramSectionMainMenuRows(registry: TelegramSectionRegistry): TelegramSectionMainMenuRow[];
/** @internal */
export declare function parseTelegramSectionCallback(data: string): {
    token: string;
    action: string;
    payload: string;
} | undefined;
/** @internal */
export interface TelegramSectionCallbackHandlerDeps {
    answerCallbackQuery: (id: string, text?: string) => Promise<void>;
    target?: TelegramSectionTarget;
    editInteractiveMessage: (chatId: number, messageId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: TelegramInlineKeyboardMarkup) => Promise<void>;
    sendInteractiveMessage: (chatId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: TelegramInlineKeyboardMarkup, options?: {
        target?: TelegramSectionTarget;
    }) => Promise<number | undefined>;
    sendRichMessage: (chatId: number, message: TelegramInputRichMessage, options?: {
        target?: TelegramSectionTarget;
    }) => Promise<number | undefined>;
    enqueuePrompt: (prompt: string) => Promise<void>;
    deleteMessage: (chatId: number, messageId: number) => Promise<void>;
}
export declare function handleTelegramSectionOpen(registry: TelegramSectionRegistry, token: TelegramSectionToken, chatId: number, messageId: number, callbackQueryId: string, deps: TelegramSectionCallbackHandlerDeps): Promise<boolean>;
export declare function handleTelegramSectionCallback(registry: TelegramSectionRegistry, token: TelegramSectionToken, action: string, payload: string, chatId: number, messageId: number, callbackQueryId: string, deps: TelegramSectionCallbackHandlerDeps): Promise<boolean>;
export declare function handleTelegramSectionSettingsOpen(registry: TelegramSectionRegistry, token: TelegramSectionToken, chatId: number, messageId: number, callbackQueryId: string, deps: TelegramSectionCallbackHandlerDeps): Promise<boolean>;
