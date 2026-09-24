/**
 * Telegram preview streaming helpers
 * Zones: telegram outbound, native rich markdown drafts
 * Owns safe draft preview selection, runtime updates, and preview finalization
 */
import type { TelegramAssistantOutputPreparation } from "./activity.ts";
import { type TelegramTarget } from "./target.ts";
export type TelegramDraftSupport = "unknown" | "supported";
export interface TelegramPreviewState {
    mode: "draft";
    draftId?: number;
    pendingText: string;
    lastSentText: string;
}
export interface TelegramPreviewRuntimeState extends TelegramPreviewState {
    flushPromise?: Promise<void>;
    flushRequested?: boolean;
    precedingFlush?: Promise<void>;
    publicationPromise?: Promise<void>;
    sealed?: boolean;
    nextDraftAt?: number;
    flushTimer?: ReturnType<typeof setTimeout>;
}
export type TelegramPreviewReplyMarkup = unknown;
export interface TelegramPreviewRuntimeDeps {
    getState: () => TelegramPreviewRuntimeState | undefined;
    setState: (state: TelegramPreviewRuntimeState | undefined) => void;
    maxMessageLength: number;
    minDraftIntervalMs?: number;
    getDraftSupport: () => TelegramDraftSupport;
    setDraftSupport: (support: TelegramDraftSupport) => void;
    allocateDraftId: () => number;
    sendDraft: (chatId: number, draftId: number, text?: string, options?: {
        parse_mode?: string;
        entities?: unknown[];
        message_thread_id?: number;
    }) => Promise<unknown>;
    canSend?: () => boolean;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface TelegramPreviewActiveTurn {
    chatId: number;
    replyToMessageId?: number;
    target?: TelegramTarget;
    voiceReplyPreferred?: boolean;
    voiceReplyRequired?: boolean;
    guestQueryId?: string;
}
export interface TelegramAssistantMessagePreviewStartDeps<TMessage> {
    getActiveTurn: () => TelegramPreviewActiveTurn | undefined;
    isAssistantMessage: (message: TMessage) => boolean;
    getState: () => TelegramPreviewRuntimeState | undefined;
    setState: (state: TelegramPreviewRuntimeState | undefined) => void;
    createPreviewState: () => TelegramPreviewRuntimeState;
    canSend?: () => boolean;
}
export interface TelegramAssistantMessagePreviewUpdateDeps<TMessage> {
    getActiveTurn: () => TelegramPreviewActiveTurn | undefined;
    isAssistantMessage: (message: TMessage) => boolean;
    getState: () => TelegramPreviewRuntimeState | undefined;
    setState: (state: TelegramPreviewRuntimeState | undefined) => void;
    createPreviewState: () => TelegramPreviewRuntimeState;
    canSend?: () => boolean;
    getMessageText: (message: TMessage) => string;
    minDraftIntervalMs?: number;
    schedulePreviewFlush: (chatId: number, options?: {
        target?: TelegramTarget;
    }) => void;
}
export type TelegramAssistantMessagePreviewHookDeps<TMessage> = TelegramAssistantMessagePreviewStartDeps<TMessage> & TelegramAssistantMessagePreviewUpdateDeps<TMessage>;
export interface TelegramAssistantMessagePreviewHookEvent<TMessage> {
    message: TMessage;
}
export interface TelegramAssistantMessagePreviewHooks<TMessage> {
    onMessageStart: (event: TelegramAssistantMessagePreviewHookEvent<TMessage>) => Promise<void>;
    onMessageUpdate: (event: TelegramAssistantMessagePreviewHookEvent<TMessage>) => Promise<void>;
}
export interface TelegramPreviewControllerDeps {
    getDefaultReplyToMessageId?: () => number | undefined;
    maxMessageLength?: number;
    initialDraftSupport?: TelegramDraftSupport;
    sendDraft: (chatId: number, draftId: number, text?: string, options?: {
        parse_mode?: string;
        entities?: unknown[];
        message_thread_id?: number;
    }) => Promise<unknown>;
    canSend?: () => boolean;
    maxDraftId?: number;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface TelegramPreviewController {
    seal: () => void;
    preparePublication: () => TelegramAssistantOutputPreparation | undefined;
    prepareClear: (chatId: number, options?: {
        target?: TelegramTarget;
        isDeliveryActive?: () => boolean;
    }) => () => Promise<void>;
    getState: () => TelegramPreviewRuntimeState | undefined;
    setState: (state: TelegramPreviewRuntimeState | undefined) => void;
    setPendingText: (text: string) => void;
    createState: () => TelegramPreviewRuntimeState;
    resetState: () => void;
    invalidate: () => void;
    clear: (chatId: number, options?: {
        awaitFlush?: boolean;
        target?: TelegramTarget;
    }) => Promise<void>;
    flush: (chatId: number, options?: {
        target?: TelegramTarget;
    }) => Promise<void>;
    scheduleFlush: (chatId: number, options?: {
        target?: TelegramTarget;
    }) => void;
    finalize: (chatId: number, replyToMessageId?: number, options?: {
        target?: TelegramTarget;
    }) => Promise<boolean>;
}
export type TelegramPreviewControllerRuntimeDeps = TelegramPreviewControllerDeps;
export declare function createTelegramPreviewControllerRuntime(deps: TelegramPreviewControllerRuntimeDeps): TelegramPreviewController;
export interface TelegramAssistantPreviewRuntimeDeps<TMessage, TReplyMarkup = TelegramPreviewReplyMarkup> extends TelegramPreviewControllerRuntimeDeps {
    getActiveTurn: () => TelegramPreviewActiveTurn | undefined;
    isAssistantMessage: (message: TMessage) => boolean;
    getMessageText: (message: TMessage) => string;
    sendMarkdownReply: (chatId: number, replyToMessageId: number | undefined, markdown: string, options?: {
        replyMarkup?: TReplyMarkup;
        target?: TelegramTarget;
    }) => Promise<number | undefined>;
}
export interface TelegramPreparedPreviewDelivery<TReplyMarkup = unknown> {
    clearPreview: TelegramPreviewController["clear"];
    setPreviewPendingText: TelegramPreviewController["setPendingText"];
    finalizeMarkdownPreview: ReturnType<typeof createTelegramNativeMarkdownPreviewFinalizer<TReplyMarkup>>;
}
export type TelegramAssistantPreviewRuntime<TMessage, TReplyMarkup = TelegramPreviewReplyMarkup> = TelegramPreviewController & TelegramAssistantMessagePreviewHooks<TMessage> & {
    prepareDelivery: (isDeliveryActive: () => boolean) => TelegramPreparedPreviewDelivery<TReplyMarkup>;
    finalizeMarkdown: (chatId: number, markdown: string, replyToMessageId?: number, options?: {
        replyMarkup?: TReplyMarkup;
        target?: TelegramTarget;
    }) => Promise<boolean>;
};
export declare function createTelegramNativeMarkdownPreviewFinalizer<TReplyMarkup>(deps: {
    getState: () => TelegramPreviewRuntimeState | undefined;
    clear: (chatId: number, options?: {
        awaitFlush?: boolean;
        target?: TelegramTarget;
    }) => Promise<void>;
    discard?: () => void;
    isDeliveryActive?: () => boolean;
    sendMarkdownReply: (chatId: number, replyToMessageId: number | undefined, markdown: string, options?: {
        replyMarkup?: TReplyMarkup;
        target?: TelegramTarget;
    }) => Promise<number | undefined>;
}): (chatId: number, markdown: string, replyToMessageId?: number, options?: {
    replyMarkup?: TReplyMarkup;
    target?: TelegramTarget;
}) => Promise<boolean>;
export declare function createTelegramAssistantPreviewRuntime<TMessage, TReplyMarkup = TelegramPreviewReplyMarkup>(deps: TelegramAssistantPreviewRuntimeDeps<TMessage, TReplyMarkup>): TelegramAssistantPreviewRuntime<TMessage, TReplyMarkup>;
export declare function createTelegramPreviewController(deps: TelegramPreviewControllerDeps): TelegramPreviewController;
export declare function createTelegramAssistantMessagePreviewHooks<TMessage>(deps: TelegramAssistantMessagePreviewHookDeps<TMessage>): TelegramAssistantMessagePreviewHooks<TMessage>;
/**
 * Returns true when the active turn is a Telegram Guest Mode query. A guest
 * query allows exactly one answer within a limited Telegram response window,
 * so it must never emit streaming draft previews.
 */
export declare function shouldSuppressPreviewForGuestTurn(turn: {
    guestQueryId?: string;
} | null | undefined): boolean;
export declare function handleTelegramAssistantMessagePreviewStart<TMessage>(message: TMessage, deps: TelegramAssistantMessagePreviewStartDeps<TMessage>): Promise<void>;
export declare function handleTelegramAssistantMessagePreviewUpdate<TMessage>(message: TMessage, deps: TelegramAssistantMessagePreviewUpdateDeps<TMessage>): Promise<void>;
export declare function buildTelegramPreviewFinalText(state: TelegramPreviewState): string | undefined;
export declare function createTelegramPreviewRuntimeState(): TelegramPreviewRuntimeState;
export declare function allocateTelegramDraftId(currentDraftId: number, maxDraftId: number): number;
interface TelegramNativeMarkdownPreviewSnapshot {
    text: string;
}
export declare function shouldUseTelegramDraftPreview(_options: {
    draftSupport: TelegramDraftSupport;
    snapshot?: TelegramNativeMarkdownPreviewSnapshot;
}): boolean;
export declare function clearTelegramPreview(chatId: number, deps: TelegramPreviewRuntimeDeps, options?: {
    awaitFlush?: boolean;
    target?: TelegramTarget;
    isDeliveryActive?: () => boolean;
}): Promise<void>;
export declare function getSafeTelegramRichMarkdownDraftPrefix(markdown: string, maxMessageLength: number): string | undefined;
export declare function flushTelegramPreview(chatId: number, deps: TelegramPreviewRuntimeDeps, options?: {
    target?: TelegramTarget;
}): Promise<void>;
export declare function finalizeTelegramPreview(chatId: number, deps: TelegramPreviewRuntimeDeps, options?: {
    target?: TelegramTarget;
}): Promise<boolean>;
export {};
