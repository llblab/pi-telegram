/**
 * Telegram media and text extraction helpers
 * Zones: telegram inbound, media groups, filesystem paths
 * Normalizes inbound Telegram messages into reusable file, text, id, history, and media-group metadata
 */
import * as Machine from "./machine.ts";
export interface TelegramPhotoSize {
    file_id: string;
    file_size?: number;
}
export interface TelegramDocument {
    file_id: string;
    file_name?: string;
    mime_type?: string;
}
export type TelegramVideo = TelegramDocument;
export type TelegramAudio = TelegramDocument;
export type TelegramAnimation = TelegramDocument;
export interface TelegramVoice {
    file_id: string;
    mime_type?: string;
}
export interface TelegramRichMessage {
    blocks?: unknown[];
}
export interface TelegramMessageUser {
    id?: number;
    is_bot?: boolean;
    first_name?: string;
    last_name?: string;
    username?: string;
}
export interface TelegramMessageForwardOrigin {
    type?: string;
    sender_user?: TelegramMessageUser;
    sender_user_name?: string;
    sender_chat?: {
        title?: string;
        username?: string;
        id?: number;
    };
    chat?: {
        title?: string;
        username?: string;
        id?: number;
    };
    author_signature?: string;
}
export interface TelegramReplyToMessage {
    message_id?: number;
    from?: TelegramMessageUser;
    text?: string;
    caption?: string;
    rich_message?: TelegramRichMessage;
    photo?: TelegramPhotoSize[];
    document?: TelegramDocument;
    video?: TelegramVideo;
    audio?: TelegramAudio;
    voice?: TelegramVoice;
    animation?: TelegramAnimation;
    sticker?: TelegramSticker;
}
export interface TelegramSticker {
    file_id: string;
    is_video?: boolean;
    is_animated?: boolean;
}
export interface TelegramMediaMessage {
    message_id: number;
    chat?: {
        id: number;
        type?: string;
        username?: string;
    };
    from?: TelegramMessageUser;
    forward_origin?: TelegramMessageForwardOrigin;
    forward_from?: TelegramMessageUser;
    forward_sender_name?: string;
    text?: string;
    caption?: string;
    rich_message?: TelegramRichMessage;
    reply_to_message?: TelegramReplyToMessage;
    media_group_id?: string;
    photo?: TelegramPhotoSize[];
    document?: TelegramDocument;
    video?: TelegramVideo;
    audio?: TelegramAudio;
    voice?: TelegramVoice;
    animation?: TelegramAnimation;
    sticker?: TelegramSticker;
}
export interface TelegramMediaGroupMessage {
    message_id: number;
    chat: {
        id: number;
    };
    message_thread_id?: number;
    media_group_id?: string;
}
export interface TelegramMediaGroupController<TMessage extends TelegramMediaGroupMessage, TContext = unknown> {
    queueMessage: (options: {
        message: TMessage;
        context?: TContext;
        dispatchMessages: (messages: TMessage[], ctx?: TContext) => unknown | Promise<unknown>;
    }) => boolean;
    removeMessages: (messageIds: number[]) => number;
    flushMessage: (messageId: number) => Promise<boolean>;
    suspend: () => void;
    resume: (context: TContext) => void;
    clear: () => void;
}
export interface TelegramMediaGroupDispatchRuntimeDeps<TMessage extends TelegramMediaGroupMessage, TContext> {
    mediaGroups: TelegramMediaGroupController<TMessage, TContext>;
    dispatchMessages: (messages: TMessage[], ctx: TContext) => Promise<void>;
    onDeferredMessage?: (message: TMessage) => void;
}
export interface TelegramMediaGroupDispatchRuntime<TMessage extends TelegramMediaGroupMessage, TContext> {
    handleMessage: (message: TMessage, ctx: TContext) => Promise<void>;
}
export interface TelegramMediaGroupControllerOptions {
    debounceMs?: number;
    setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}
export type TelegramAttachmentKind = "photo" | "document" | "video" | "audio" | "voice" | "animation" | "sticker";
/** @internal Metadata only: no receiver, source-custody, actual-byte or download grant. */
export interface TelegramAttachmentRequestCandidate {
    readonly messageId: number;
    readonly kind: TelegramAttachmentKind;
    readonly fileId: string;
    readonly fileName?: string;
    readonly mimeType?: string;
    readonly reportedBytes?: number;
}
/** @internal Shared bounded producer metadata; never a receiver, actual-byte or file-use grant. */
export declare function normalizeTelegramAttachmentRequestConstraints(constraints: {
    readonly accept: readonly string[];
    readonly maxBytes: number;
}): {
    readonly accept: readonly string[];
    readonly maxBytes: number;
};
/** Where an inbound attachment came from; the download layer turns it into a scoped file name. */
export interface TelegramAttachmentSource {
    kind: string;
    messageId: number;
    index?: number;
    /** Sender-chosen file name, kept as a trailing readable segment. */
    userFileName?: string;
    chat?: {
        id: number;
        type?: string;
        username?: string;
    };
    /** Explicit source scope, e.g. a Guest Mode peer whose message IDs are not the bot chat's. */
    scope?: string;
}
export interface TelegramFileInfo {
    file_id: string;
    fileName: string;
    /** Present only when the sender chose the name. */
    userFileName?: string;
    /** Position inside a rich message. */
    index?: number;
    source?: TelegramAttachmentSource;
    mimeType?: string;
    kind: TelegramAttachmentKind;
    isImage: boolean;
}
export interface DownloadedTelegramFile {
    path: string;
    fileName?: string;
    isImage?: boolean;
    mimeType?: string;
    kind?: TelegramAttachmentKind;
}
export interface DownloadedTelegramMessageFile {
    path: string;
    fileName: string;
    isImage: boolean;
    mimeType?: string;
    kind?: TelegramAttachmentKind;
}
export interface DownloadTelegramMessageFilesDeps {
    downloadFile: (fileId: string, fileName: string, source?: TelegramAttachmentSource) => Promise<string>;
}
export declare function guessMediaType(path: string): string | undefined;
export declare function extractTelegramMessageText(message: TelegramMediaMessage): string;
export declare function extractTelegramForwardContextText(message: TelegramMediaMessage, allowedUserId?: number): string;
export declare function buildTelegramReplyContextBlock(message: TelegramMediaMessage, replyFiles?: Pick<DownloadedTelegramFile, "path">[], replyOutputs?: readonly string[]): string;
export declare function extractTelegramMessagesText(messages: TelegramMediaMessage[]): string;
export declare function extractTelegramMessagesPromptText(messages: TelegramMediaMessage[]): string;
export declare function extractFirstTelegramMessageText(messages: TelegramMediaMessage[]): string;
export declare function hasTelegramMessagesPromptContent(messages: TelegramMediaMessage[]): boolean;
export declare function collectTelegramMessageIds(messages: TelegramMediaMessage[]): number[];
export declare function getTelegramMediaGroupKey(message: TelegramMediaGroupMessage): string | undefined;
/** One pending input group; only `transitionTelegramPendingGroups` produces a new one. */
export interface TelegramPendingGroup<TMessage, TContext, TMeta = undefined> {
    readonly messages: readonly TMessage[];
    readonly context?: TContext;
    /** Domain data carried with the group, such as a text group's forward-comment pairing side. */
    readonly meta?: TMeta;
    readonly timerId: number | null;
    /** The batch in flight; its messages leave the group only once that exact dispatch succeeds. */
    readonly dispatch: {
        readonly id: number;
        readonly messageIds: readonly number[];
    } | null;
    readonly suspended: boolean;
    /** The next batch ends at this message, so later messages wait for the batch after it, whatever is in flight. */
    readonly boundaryId?: number;
}
export interface TelegramPendingGroupsState<TMessage, TContext, TMeta> {
    readonly groups: ReadonlyMap<string, TelegramPendingGroup<TMessage, TContext, TMeta>>;
    readonly nextTimerId: number;
    readonly nextDispatchId: number;
}
export interface TelegramPendingGroupsConfig {
    debounceMs: number;
    /** A group without a context waits (text) instead of dispatching without one (media). */
    requireContext: boolean;
}
export type TelegramPendingGroupsEvent<TMessage, TContext, TMeta> = {
    type: "queued";
    key: string;
    message: TMessage;
    context?: TContext;
    meta?: TMeta;
    delayMs: number;
    /** `always` restarts the debounce; `ifIdle` arms it only when no timer, dispatch or suspension holds it. */
    rearm: "always" | "ifIdle";
}
/** Ends the next batch at the group's current last message; later messages wait for the batch after it. */
 | {
    type: "batchClosed";
    key: string;
} | {
    type: "timerFired";
    key: string;
    timerId: number;
} | {
    type: "dispatchSettled";
    key: string;
    dispatchId: number;
    ok: boolean;
} | {
    type: "flushRequested";
    key: string;
} | {
    type: "suspended";
} | {
    type: "resumed";
    context: TContext;
} | {
    type: "removed";
    messageIds: readonly number[];
} | {
    type: "keyCleared";
    key: string;
} | {
    type: "cleared";
};
export type TelegramPendingGroupsEffect<TMessage, TContext> = {
    type: "armTimer";
    key: string;
    timerId: number;
    delayMs: number;
} | {
    type: "cancelTimer";
    timerId: number;
} | {
    type: "dispatch";
    key: string;
    dispatchId: number;
    messages: TMessage[];
    context?: TContext;
};
export interface TelegramPendingGroupsStep<TMessage, TContext, TMeta> extends Machine.TelegramMachineStep<TelegramPendingGroupsState<TMessage, TContext, TMeta>, TelegramPendingGroupsEffect<TMessage, TContext>> {
    /** `removed`: how many groups were dropped. */
    result: number;
}
export declare function createTelegramPendingGroupsState<TMessage, TContext, TMeta = undefined>(): TelegramPendingGroupsState<TMessage, TContext, TMeta>;
/**
 * Pure transition for delayed input groups shared by media albums and split text. A group dispatches one batch at a
 * time; messages that arrive meanwhile wait for the next batch, a failure keeps the batch for a retry, and suspension
 * keeps every admitted message for the replacement context.
 */
export declare function transitionTelegramPendingGroups<TMessage extends {
    message_id: number;
}, TContext, TMeta>(state: TelegramPendingGroupsState<TMessage, TContext, TMeta>, event: TelegramPendingGroupsEvent<TMessage, TContext, TMeta>, config: TelegramPendingGroupsConfig): TelegramPendingGroupsStep<TMessage, TContext, TMeta>;
export interface TelegramPendingGroups<TMessage, TContext, TMeta> {
    /** Read-only view of one group; it never grants mutation. */
    get: (key: string) => TelegramPendingGroup<TMessage, TContext, TMeta> | undefined;
    queue: (event: Omit<Extract<TelegramPendingGroupsEvent<TMessage, TContext, TMeta>, {
        type: "queued";
    }>, "type"> & {
        dispatchMessages: (messages: TMessage[], ctx?: TContext) => unknown | Promise<unknown>;
    }) => void;
    clearKey: (key: string) => void;
    closeBatch: (key: string) => void;
    removeMessages: (messageIds: number[]) => number;
    /** Dispatches the group holding this message now; resolves once its batch settles, rejecting if it failed. */
    flushMessage: (messageId: number) => Promise<boolean>;
    suspend: () => void;
    resume: (context: TContext) => void;
    clear: () => void;
}
/**
 * The shell around `transitionTelegramPendingGroups`: it owns timer handles and each key's latest dispatcher, turns
 * every dispatch outcome, including a synchronous throw, into `dispatchSettled`, and keeps each batch's promise for
 * flush callers.
 */
export declare function createTelegramPendingGroups<TMessage extends {
    message_id: number;
}, TContext, TMeta = undefined>(options: {
    debounceMs: number;
    requireContext: boolean;
    setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}): TelegramPendingGroups<TMessage, TContext, TMeta>;
export declare function createTelegramMediaGroupController<TMessage extends TelegramMediaGroupMessage, TContext = unknown>(options?: TelegramMediaGroupControllerOptions): TelegramMediaGroupController<TMessage, TContext>;
export declare function createTelegramMediaGroupDispatchRuntime<TMessage extends TelegramMediaGroupMessage, TContext>(deps: TelegramMediaGroupDispatchRuntimeDeps<TMessage, TContext>): TelegramMediaGroupDispatchRuntime<TMessage, TContext>;
/** Pure `[title]` bullet section appended after a blank line; empty items leave text unchanged. */
export declare function appendTelegramListSection(text: string, title: string, items: string[]): string;
export declare function appendTelegramAttachmentSection(text: string, files: Pick<DownloadedTelegramFile, "path">[]): string;
export declare function formatTelegramHistoryText(rawText: string, files: DownloadedTelegramFile[], handlerOutputs?: string[]): string;
export declare function downloadTelegramMessageFiles(messages: TelegramMediaMessage[], deps: DownloadTelegramMessageFilesDeps): Promise<DownloadedTelegramMessageFile[]>;
export declare function collectTelegramFileInfos(messages: TelegramMediaMessage[]): TelegramFileInfo[];
