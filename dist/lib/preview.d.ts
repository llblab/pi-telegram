/**
 * Telegram preview streaming helpers
 * Zones: telegram outbound, native rich markdown drafts
 * Owns safe draft preview selection, runtime updates, and preview finalization
 * The streaming state machine is a pure transition function driven by one imperative shell per runtime.
 */
import type { TelegramAssistantOutputPreparation } from "./activity.ts";
import { type TelegramTarget } from "./target.ts";
export interface TelegramPreviewState {
    mode: "draft";
    draftId?: number;
    pendingText: string;
    lastSentText: string;
}
/** One immutable preview segment; a replacement segment gets a new id, so late results for an old one are dropped. */
export interface TelegramPreviewSegment extends Readonly<TelegramPreviewState> {
    readonly id: number;
    readonly sealed: boolean;
}
export type TelegramPreviewReplyMarkup = unknown;
type TelegramDraftSender = (chatId: number, draftId: number, text?: string, options?: {
    parse_mode?: string;
    entities?: unknown[];
    message_thread_id?: number;
}) => Promise<unknown>;
type TelegramPreviewEventRecorder = (category: string, error: unknown, details?: Record<string, unknown>) => void;
export interface TelegramPreviewActiveTurn {
    chatId: number;
    replyToMessageId?: number;
    target?: TelegramTarget;
    voiceReplyPreferred?: boolean;
    voiceReplyRequired?: boolean;
    guestQueryId?: string;
}
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
    sendDraft: TelegramDraftSender;
    canSend?: () => boolean;
    maxDraftId?: number;
    /** Throttle between draft frames; defaults to the native draft cadence. */
    minDraftIntervalMs?: number;
    recordRuntimeEvent?: TelegramPreviewEventRecorder;
}
export type TelegramPreviewTargetOptions = {
    target?: TelegramTarget;
};
export interface TelegramPreviewController {
    /** Read-only view of the current segment; it never grants mutation. */
    getState: () => TelegramPreviewSegment | undefined;
    /** True while a draft request is in flight or a pending request waits behind a publication. */
    isFlushing: () => boolean;
    seal: () => void;
    preparePublication: () => TelegramAssistantOutputPreparation | undefined;
    prepareClear: (chatId: number, options?: TelegramPreviewTargetOptions & {
        isDeliveryActive?: () => boolean;
    }) => () => Promise<void>;
    setPendingText: (text: string) => void;
    resetState: () => void;
    invalidate: () => void;
    clear: (chatId: number, options?: TelegramPreviewTargetOptions & {
        awaitFlush?: boolean;
    }) => Promise<void>;
    flush: (chatId: number, options?: TelegramPreviewTargetOptions) => Promise<void>;
    scheduleFlush: (chatId: number, options?: TelegramPreviewTargetOptions) => void;
    finalize: (chatId: number, replyToMessageId?: number, options?: TelegramPreviewTargetOptions) => Promise<boolean>;
}
export interface TelegramAssistantPreviewRuntimeDeps<TMessage, TReplyMarkup = TelegramPreviewReplyMarkup> extends TelegramPreviewControllerDeps {
    getActiveTurn: () => TelegramPreviewActiveTurn | undefined;
    isAssistantMessage: (message: TMessage) => boolean;
    getMessageText: (message: TMessage) => string;
    sendMarkdownReply: (chatId: number, replyToMessageId: number | undefined, markdown: string, options?: {
        replyMarkup?: TReplyMarkup;
        target?: TelegramTarget;
    }) => Promise<number | undefined>;
}
type TelegramMarkdownFinalizer<TReplyMarkup> = (chatId: number, markdown: string, replyToMessageId?: number, options?: {
    replyMarkup?: TReplyMarkup;
    target?: TelegramTarget;
}) => Promise<boolean>;
export interface TelegramPreparedPreviewDelivery<TReplyMarkup = unknown> {
    clearPreview: TelegramPreviewController["clear"];
    setPreviewPendingText: TelegramPreviewController["setPendingText"];
    finalizeMarkdownPreview: TelegramMarkdownFinalizer<TReplyMarkup>;
}
export type TelegramAssistantPreviewRuntime<TMessage, TReplyMarkup = TelegramPreviewReplyMarkup> = TelegramPreviewController & TelegramAssistantMessagePreviewHooks<TMessage> & {
    prepareDelivery: (isDeliveryActive: () => boolean) => TelegramPreparedPreviewDelivery<TReplyMarkup>;
    finalizeMarkdown: TelegramMarkdownFinalizer<TReplyMarkup>;
};
interface TelegramPreviewFlushRequest {
    chatId: number;
    target?: TelegramTarget;
}
interface TelegramPreviewMachineConfig {
    maxDraftId: number;
    maxMessageLength: number;
    minDraftIntervalMs: number;
}
/** The whole preview state; only `transitionTelegramPreview` produces a new one. */
export interface TelegramPreviewMachineState {
    readonly segment: TelegramPreviewSegment | null;
    /** Bumped by reset and invalidation; a result issued under an older generation is inert. */
    readonly generation: number;
    readonly nextSegmentId: number;
    readonly nextDraftId: number;
    readonly nextDraftAt: number;
    /** Segment that owns the current generation's issued draft; old-generation requests do not block it. */
    readonly inFlight: number | null;
    /** The one coalesced flush request waiting behind an in-flight draft or an open publication. */
    readonly pending: TelegramPreviewFlushRequest | null;
    readonly publications: readonly number[];
    /** The segment the throttle timer is armed for; the timer belongs to that segment alone. */
    readonly timerSegmentId: number | null;
}
/** Impure inputs the runner samples at dispatch time, so transitions stay pure. */
interface TelegramPreviewClock {
    now: number;
    canSend: boolean;
}
export type TelegramPreviewEvent = {
    type: "reset";
} | {
    type: "invalidated";
} | {
    type: "segmentStarted";
} | {
    type: "segmentEnsured";
} | {
    type: "sealed";
} | {
    type: "discarded";
} | {
    type: "textSet";
    text: string;
} | {
    type: "draftWindowOpened";
    at: number;
} | ({
    type: "flushRequested";
    request: TelegramPreviewFlushRequest;
} & TelegramPreviewClock) | ({
    type: "timerFired";
    request: TelegramPreviewFlushRequest;
    segmentId: number;
} & TelegramPreviewClock) | ({
    type: "draftSettled";
    segmentId: number;
    generation: number;
    /** Present only when Telegram accepted the draft. */
    text?: string;
} & TelegramPreviewClock) | {
    type: "publicationOpened";
    id: number;
} | ({
    type: "publicationSettled";
    id: number;
} & TelegramPreviewClock);
export type TelegramPreviewEffect = {
    type: "sendDraft";
    request: TelegramPreviewFlushRequest;
    draftId: number;
    text: string;
    segmentId: number;
    generation: number;
} | {
    type: "armTimer";
    delay: number;
    request: TelegramPreviewFlushRequest;
    segmentId: number;
} | {
    type: "cancelTimer";
} | {
    type: "clearClosedGate";
    request: TelegramPreviewFlushRequest;
};
export interface TelegramPreviewStep {
    state: TelegramPreviewMachineState;
    effects: readonly TelegramPreviewEffect[];
}
export declare function createTelegramPreviewMachineState(): TelegramPreviewMachineState;
export declare function transitionTelegramPreview(state: TelegramPreviewMachineState, event: TelegramPreviewEvent, config: TelegramPreviewMachineConfig): TelegramPreviewStep;
/** True while a draft request is in flight, or, when publications block, a pending request waits behind one. */
export declare function isTelegramPreviewBusy(state: TelegramPreviewMachineState, blockedByPublication?: boolean): boolean;
export declare function createTelegramPreviewController(deps: TelegramPreviewControllerDeps): TelegramPreviewController;
/**
 * Returns true when the active turn is a Telegram Guest Mode query. A guest
 * query allows exactly one answer within a limited Telegram response window,
 * so it must never emit streaming draft previews.
 */
export declare function shouldSuppressPreviewForGuestTurn(turn: {
    guestQueryId?: string;
} | null | undefined): boolean;
export declare function createTelegramAssistantPreviewRuntime<TMessage, TReplyMarkup = TelegramPreviewReplyMarkup>(deps: TelegramAssistantPreviewRuntimeDeps<TMessage, TReplyMarkup>): TelegramAssistantPreviewRuntime<TMessage, TReplyMarkup>;
export declare function buildTelegramPreviewFinalText(state: TelegramPreviewState): string | undefined;
export declare function allocateTelegramDraftId(currentDraftId: number, maxDraftId: number): number;
export declare function getSafeTelegramRichMarkdownDraftPrefix(markdown: string, maxMessageLength: number): string | undefined;
export {};
