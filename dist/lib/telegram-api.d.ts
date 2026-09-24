/**
 * Telegram API transport helpers
 * Zones: telegram transport, filesystem, runtime diagnostics
 *
 * Wraps bot API calls, file uploads/downloads (including voice messages),
 * multipart sending, runtime transport binding, and Telegram temp-file lifecycle.
 */
export declare const TELEGRAM_API_BASE = "https://api.telegram.org";
export declare const TELEGRAM_FILE_MAX_BYTES: number;
export declare function getTelegramInboundFileByteLimitFromEnv(env: NodeJS.ProcessEnv, names: string[], defaultValue?: number): number;
export type TelegramNetworkFamilyPolicy = "auto" | "ipv4" | "ipv6" | "ipv4-fallback";
type TelegramNetworkFamily = 4 | 6;
export interface TelegramUser {
    id: number;
    is_bot: boolean;
    first_name: string;
    username?: string;
}
export interface TelegramChat {
    id: number;
    type: string;
}
export interface TelegramPhotoSize {
    file_id: string;
    file_size?: number;
}
export interface TelegramDocument {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
}
export interface TelegramVideo {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
}
export interface TelegramAudio {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
}
export interface TelegramVoice {
    file_id: string;
    mime_type?: string;
    file_size?: number;
}
export interface TelegramAnimation {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
}
export interface TelegramSticker {
    file_id: string;
    emoji?: string;
}
export interface TelegramRichMessage {
    blocks?: unknown[];
    is_rtl?: boolean;
}
export interface TelegramMessage {
    message_id: number;
    chat: TelegramChat;
    from?: TelegramUser;
    text?: string;
    caption?: string;
    rich_message?: TelegramRichMessage;
    media_group_id?: string;
    photo?: TelegramPhotoSize[];
    document?: TelegramDocument;
    video?: TelegramVideo;
    audio?: TelegramAudio;
    voice?: TelegramVoice;
    animation?: TelegramAnimation;
    sticker?: TelegramSticker;
}
export interface TelegramCallbackQuery {
    id: string;
    from: TelegramUser;
    message?: TelegramMessage;
    data?: string;
}
export interface TelegramReactionTypeEmoji {
    type: "emoji";
    emoji: string;
}
export interface TelegramReactionTypeCustomEmoji {
    type: "custom_emoji";
    custom_emoji_id: string;
}
export interface TelegramReactionTypePaid {
    type: "paid";
}
export type TelegramReactionType = TelegramReactionTypeEmoji | TelegramReactionTypeCustomEmoji | TelegramReactionTypePaid;
export interface TelegramMessageReactionUpdated {
    chat: TelegramChat;
    message_id: number;
    user?: TelegramUser;
    actor_chat?: TelegramChat;
    old_reaction: TelegramReactionType[];
    new_reaction: TelegramReactionType[];
    date: number;
}
export interface TelegramGuestMessage {
    message_id: number;
    from?: TelegramUser;
    chat: TelegramChat;
    date: number;
    text?: string;
    caption?: string;
    rich_message?: TelegramRichMessage;
    guest_query_id: string;
    guest_bot_caller_user?: TelegramUser;
    guest_bot_caller_chat?: TelegramChat;
    reply_to_message?: TelegramMessage;
}
export interface TelegramUpdate {
    update_id: number;
    message?: TelegramMessage;
    edited_message?: TelegramMessage;
    callback_query?: TelegramCallbackQuery;
    message_reaction?: TelegramMessageReactionUpdated;
    guest_message?: TelegramGuestMessage;
    deleted_business_messages?: {
        message_ids?: unknown;
    };
}
export interface TelegramSentMessage {
    message_id: number;
}
export interface TelegramSentGuestMessage {
    inline_message_id?: string;
}
export interface TelegramReplyParameters {
    message_id: number;
    allow_sending_without_reply?: boolean;
    chat_id?: number;
    message_thread_id?: number;
}
export interface TelegramLinkPreviewOptions {
    is_disabled?: boolean;
}
export type TelegramSendMessageBody = Record<string, unknown> & {
    chat_id: number;
    text: string;
    parse_mode?: "HTML";
    link_preview_options?: TelegramLinkPreviewOptions;
    reply_markup?: unknown;
    reply_parameters?: TelegramReplyParameters;
};
export interface TelegramInputMediaPhoto extends Record<string, unknown> {
    type: "photo";
    media: string;
    has_spoiler?: boolean;
}
export interface TelegramInputMediaVideo extends Record<string, unknown> {
    type: "video";
    media: string;
    thumbnail?: string;
    width?: number;
    height?: number;
    duration?: number;
    supports_streaming?: boolean;
    has_spoiler?: boolean;
}
export interface TelegramInputMediaAnimation extends Record<string, unknown> {
    type: "animation";
    media: string;
    thumbnail?: string;
    width?: number;
    height?: number;
    duration?: number;
    has_spoiler?: boolean;
}
export interface TelegramInputMediaAudio extends Record<string, unknown> {
    type: "audio";
    media: string;
    thumbnail?: string;
    duration?: number;
    performer?: string;
    title?: string;
}
export interface TelegramInputMediaVoiceNote extends Record<string, unknown> {
    type: "voice_note";
    media: string;
    caption?: string;
    parse_mode?: string;
    caption_entities?: unknown[];
    duration?: number;
}
export type TelegramInputRichMessageMediaValue = TelegramInputMediaAnimation | TelegramInputMediaAudio | TelegramInputMediaPhoto | TelegramInputMediaVideo | TelegramInputMediaVoiceNote;
export interface TelegramInputRichMessageMedia {
    id: string;
    media: TelegramInputRichMessageMediaValue;
}
type TelegramInputRichMessageCommon = {
    is_rtl?: boolean;
    skip_entity_detection?: boolean;
};
export type TelegramRichText = string | TelegramRichText[] | {
    type: "bold" | "code";
    text: TelegramRichText;
};
export type TelegramInputRichBlock = {
    type: "heading";
    text: TelegramRichText;
    size?: 1 | 2 | 3;
} | {
    type: "pre";
    text: TelegramRichText;
    language?: string;
} | {
    type: "details";
    summary: TelegramRichText;
    blocks: TelegramInputRichBlock[];
    is_open?: true;
};
export type TelegramInputRichDraftBlock = TelegramInputRichBlock | {
    type: "thinking";
    text: TelegramRichText;
};
export type TelegramInputRichMessage = TelegramInputRichMessageCommon & ({
    markdown: string;
    html?: never;
    blocks?: never;
    media?: TelegramInputRichMessageMedia[];
} | {
    html: string;
    markdown?: never;
    blocks?: never;
    media?: TelegramInputRichMessageMedia[];
} | {
    blocks: TelegramInputRichBlock[];
    markdown?: never;
    html?: never;
    media?: never;
});
export type TelegramSendRichMessageBody = Record<string, unknown> & {
    chat_id: number;
    rich_message: TelegramInputRichMessage;
    reply_markup?: unknown;
    reply_parameters?: TelegramReplyParameters;
};
export type TelegramEditMessageTextBody = Record<string, unknown> & {
    chat_id: number;
    message_id: number;
    text?: string;
    rich_message?: TelegramInputRichMessage;
    parse_mode?: "HTML";
    link_preview_options?: TelegramLinkPreviewOptions;
    reply_markup?: unknown;
};
export type TelegramSendMessageDraftBody = Record<string, unknown> & {
    chat_id: number;
    draft_id: number;
    text?: string;
    parse_mode?: string;
    entities?: unknown[];
    message_thread_id?: number;
};
export type TelegramSendRichMessageDraftBody = Record<string, unknown> & {
    chat_id: number;
    draft_id: number;
    rich_message: TelegramInputRichMessage | (TelegramInputRichMessageCommon & {
        blocks: TelegramInputRichDraftBlock[];
        markdown?: never;
        html?: never;
        media?: never;
    });
    message_thread_id?: number;
};
interface TelegramApiResponse<T> {
    ok: boolean;
    result?: T;
    description?: string;
    error_code?: number;
    parameters?: {
        retry_after?: number;
    };
}
export interface TelegramApiRetryWait {
    method: string;
    delayMs: number;
    attempt: number;
    retryAfterSeconds?: number;
}
export interface TelegramApiCallOptions {
    signal?: AbortSignal;
    maxAttempts?: number;
    retryRateLimit?: boolean;
    retrySafety?: "safe" | "non-idempotent";
    retryBaseDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Observability hook fired before a 429 retry wait, never for 5xx waits. */
    onRetryWait?: (wait: TelegramApiRetryWait) => void;
}
export interface TelegramFileDownloadOptions {
    signal?: AbortSignal;
    maxFileSizeBytes?: number;
}
export type TelegramGuestCachedMediaResult = {
    type: "document";
    id: string;
    title: string;
    document_file_id: string;
    caption?: string;
    parse_mode?: string;
} | {
    type: "photo";
    id: string;
    photo_file_id: string;
    caption?: string;
    parse_mode?: string;
} | {
    type: "audio";
    id: string;
    audio_file_id: string;
    caption?: string;
    parse_mode?: string;
} | {
    type: "voice";
    id: string;
    voice_file_id: string;
    title: string;
    caption?: string;
    parse_mode?: string;
};
export interface TelegramAnswerGuestQueryOptions {
    parseMode?: string;
    richMessage?: TelegramInputRichMessage;
    result?: TelegramGuestCachedMediaResult;
}
export interface TelegramEditGuestInlineMessageContent {
    text?: string;
    richMessage?: TelegramInputRichMessage;
    parseMode?: "HTML";
}
export interface TelegramAnswerCallbackQueryOptions {
    recordRuntimeEvent?: (kind: "api", error: unknown, details?: Record<string, unknown>) => void;
}
export interface TelegramApiClient {
    call: <TResponse>(method: string, body: Record<string, unknown>, options?: TelegramApiCallOptions) => Promise<TResponse>;
    callMultipart: <TResponse>(method: string, fields: Record<string, string>, fileField: string, filePath: string, fileName: string, options?: TelegramApiCallOptions) => Promise<TResponse>;
    downloadFile: (fileId: string, suggestedName: string, tempDir: string, options?: TelegramFileDownloadOptions) => Promise<string>;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    answerGuestQuery?: (guestQueryId: string, text?: string, options?: TelegramAnswerGuestQueryOptions) => Promise<void>;
}
export interface TelegramApiTargetActivityRuntime {
    begin: (method: string, body: Record<string, unknown>) => () => void;
    hasPendingTarget: (target: {
        chatId: number;
        threadId?: number;
    }) => boolean;
    listPendingTargets: () => {
        chatId: number;
        threadId: number;
    }[];
    listPendingChats: () => number[];
}
export declare function createTelegramApiTargetActivityRuntime(): TelegramApiTargetActivityRuntime;
export declare function createTelegramApiTargetTrackingClient(client: TelegramApiClient, activity: TelegramApiTargetActivityRuntime): TelegramApiClient;
export type TelegramApiWorkspaceAdmissionScopeLike = {
    kind: "target";
    target: {
        chatId: number;
        threadId: number;
    };
} | {
    kind: "chat";
    chatId: number;
} | {
    kind: "profile";
};
export interface TelegramApiWorkspaceAdmissionLeaseLike {
    operationId: string;
    operationKind: string;
    profileKey: string;
    scope: TelegramApiWorkspaceAdmissionScopeLike;
    owner: {
        processId: number;
        processBirthId: string;
    };
    acquiredAtMs: number;
}
export interface TelegramApiWorkspaceAdmissionPort {
    acquireAdmission: (input: {
        operationId: string;
        operationKind: string;
        scope: TelegramApiWorkspaceAdmissionScopeLike;
    }) => {
        kind: "acquired";
        lease: TelegramApiWorkspaceAdmissionLeaseLike;
        resumed: boolean;
    } | {
        kind: "blocked";
        reason: "retirement-fenced";
    };
    releaseAdmission: (expected: TelegramApiWorkspaceAdmissionLeaseLike) => boolean;
}
export declare class TelegramApiWorkspaceAdmissionError extends Error {
    readonly code: "blocked" | "unavailable" | "release-lost" | "duplicate-operation";
    constructor(code: TelegramApiWorkspaceAdmissionError["code"], message: string);
}
export declare function getTelegramApiWorkspaceAdmissionScope(body: Record<string, unknown>): TelegramApiWorkspaceAdmissionScopeLike | undefined;
export declare function createTelegramApiWorkspaceAdmissionClient(client: TelegramApiClient, admission: TelegramApiWorkspaceAdmissionPort | (() => TelegramApiWorkspaceAdmissionPort | undefined), options?: {
    onReleaseError?: (error: unknown, method: string) => void;
    createOperationId?: () => string;
}): TelegramApiClient;
export interface TelegramBridgeApiRuntimeDeps {
    captureRequestErrorHandler?: (body: Record<string, unknown>) => ((error: unknown) => Promise<void>) | undefined;
    client: TelegramApiClient;
    tempDir: string;
    maxFileSizeBytes: number;
    tempFileMaxAgeMs: number;
    recordRuntimeEvent: (kind: "api" | "multipart" | "download", error: unknown, details?: Record<string, unknown>) => void;
    now?: () => number;
    chatActionMinIntervalMs?: number;
    chatActionMaxGates?: number;
}
export interface TelegramBridgeApiRuntime {
    call: <TResponse>(method: string, body: Record<string, unknown>, options?: TelegramApiCallOptions) => Promise<TResponse>;
    callMultipart: <TResponse>(method: string, fields: Record<string, string>, fileField: string, filePath: string, fileName: string, options?: TelegramApiCallOptions) => Promise<TResponse>;
    downloadFile: (fileId: string, suggestedName: string) => Promise<string>;
    deleteWebhook: (signal?: AbortSignal) => Promise<boolean>;
    getUpdates: (body: Record<string, unknown>, signal?: AbortSignal) => Promise<TelegramUpdate[]>;
    setMyCommands: (commands: readonly {
        command: string;
        description: string;
    }[]) => Promise<boolean>;
    sendChatAction: (chatId: number, action: string, options?: {
        message_thread_id?: number;
    }) => Promise<boolean>;
    sendTypingAction: (chatId: number, options?: {
        message_thread_id?: number;
    }) => Promise<unknown>;
    sendRecordVoiceAction: (chatId: number, options?: {
        message_thread_id?: number;
    }) => Promise<unknown>;
    sendMessageDraft: (chatId: number, draftId: number, text?: string, options?: {
        parse_mode?: string;
        entities?: unknown[];
        message_thread_id?: number;
    }) => Promise<boolean>;
    sendMessage: (body: TelegramSendMessageBody) => Promise<TelegramSentMessage>;
    sendRichMessage: (body: TelegramSendRichMessageBody) => Promise<TelegramSentMessage>;
    sendRichMessageDraft: (body: TelegramSendRichMessageDraftBody) => Promise<boolean>;
    editMessageText: (body: TelegramEditMessageTextBody) => Promise<"edited" | "unchanged">;
    editMessageReplyMarkup: (chatId: number, messageId: number, replyMarkup: unknown) => Promise<void>;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    answerGuestQuery: (guestQueryId: string, text?: string, options?: TelegramAnswerGuestQueryOptions) => Promise<void>;
    /**
     * Temporary Guest Mode ACK experiment: answers the guest query and returns
     * the sent inline message id so the final answer can edit that early reply.
     * Requires direct transport ownership; Telegram does not document editing
     * guest answers, so this exists only to falsify that behavior live.
     */
    answerGuestQueryForInlineMessage: (guestQueryId: string, text?: string, options?: TelegramAnswerGuestQueryOptions) => Promise<string | undefined>;
    editGuestInlineMessage: (inlineMessageId: string, content: TelegramEditGuestInlineMessageContent) => Promise<void>;
    deleteMessage: (chatId: number, messageId: number) => Promise<void>;
    prepareTempDir: () => Promise<number>;
}
export declare class TelegramApiCommitUnknownError extends Error {
    readonly kind: "commit-unknown";
    readonly method: string;
    readonly cause: unknown;
    constructor(method: string, cause: unknown);
}
export declare function isTelegramApiCommitUnknownError(error: unknown): error is TelegramApiCommitUnknownError;
export declare class TelegramApiStaleTargetError extends Error {
    readonly requestTarget: {
        chatId: number;
        threadId: number;
    };
    constructor(message: string, requestTarget: {
        chatId: number;
        threadId: number;
    });
}
export declare function getTelegramApiErrorRequestTarget(error: unknown): {
    chatId: number;
    threadId: number;
} | undefined;
export declare function isTelegramStaleTargetHttpError(error: unknown): boolean;
/** Only a parsed Telegram rejection of this method proves a request had no effect. */
export declare function isTelegramApiRequestRejected(error: unknown, method: string): boolean;
export declare function isTelegramMessageNotModifiedError(error: unknown): boolean;
export declare function isTelegramApiMethodRetrySafe(method: string): boolean;
export declare function isRetryableTelegramApiError(error: unknown): boolean;
export declare function getTelegramApiRetryAfterMs(error: unknown): number | undefined;
export declare function isTelegramMessageUnavailableError(error: unknown): boolean;
declare function telegramHttpsFetch(input: string | URL | Request, init: RequestInit, family: TelegramNetworkFamily): Promise<Response>;
export declare function setTelegramApiHttpsFetchForTesting(fetchImpl: typeof telegramHttpsFetch | undefined): () => void;
export declare function cleanupTelegramTempFiles(tempDir: string, maxAgeMs: number, now?: number): Promise<number>;
export declare function prepareTelegramTempDir(tempDir: string, maxAgeMs: number): Promise<number>;
export declare function callTelegram<TResponse>(botToken: string | undefined, method: string, body: Record<string, unknown>, options?: TelegramApiCallOptions): Promise<TResponse>;
export type TelegramBotIdentityResponse = Pick<TelegramApiResponse<TelegramUser>, "ok" | "result" | "description">;
export declare function fetchTelegramBotIdentity(botToken: string, fetchImpl?: typeof fetch): Promise<TelegramBotIdentityResponse>;
/**
 * Low-level helper to send a multipart/form-data request to the Telegram Bot API.
 * This is the core implementation used for uploading voice messages, photos,
 * documents, animations, etc. It handles FormData construction, retry logic
 * (via callTelegramWithRetry), and error recording under the "multipart" category.
 */
export declare function callTelegramMultipart<TResponse>(botToken: string | undefined, method: string, fields: Record<string, string>, fileField: string, filePath: string, fileName: string, options?: TelegramApiCallOptions): Promise<TResponse>;
export declare function downloadTelegramFile(botToken: string | undefined, fileId: string, suggestedName: string, tempDir: string, options?: TelegramFileDownloadOptions): Promise<string>;
export declare function answerTelegramCallbackQuery(botToken: string | undefined, callbackQueryId: string, text?: string, options?: TelegramAnswerCallbackQueryOptions): Promise<void>;
export declare function deleteTelegramMessage(botToken: string | undefined, chatId: number, messageId: number): Promise<void>;
export declare function createTelegramChatActionSender<TAction extends string>(sendChatAction: (chatId: number, action: TAction, options?: {
    message_thread_id?: number;
}) => Promise<unknown>, action: TAction): (chatId: number, options?: {
    message_thread_id?: number;
}) => Promise<unknown>;
export declare function createTelegramNativeMarkdownDraftSender(deps: {
    sendMessageDraft: TelegramBridgeApiRuntime["sendMessageDraft"];
    sendRichMessageDraft: TelegramBridgeApiRuntime["sendRichMessageDraft"];
}): TelegramBridgeApiRuntime["sendMessageDraft"];
export declare function createTelegramAssistantDraftSender(deps: {
    getAssistantRenderingMode: () => "rich" | "html";
    renderMarkdownToHtmlDraft: (markdown: string) => string;
    sendMessageDraft: TelegramBridgeApiRuntime["sendMessageDraft"];
    sendRichMessageDraft: TelegramBridgeApiRuntime["sendRichMessageDraft"];
}): TelegramBridgeApiRuntime["sendMessageDraft"];
export declare function buildTelegramAnswerGuestQueryBody(guestQueryId: string, text?: string, options?: TelegramAnswerGuestQueryOptions): Record<string, unknown>;
export type TelegramWorkspaceThreadDeletionTransport = (authorize: () => {
    chatId: number;
    threadId: number;
}) => Promise<void>;
export declare function createDefaultTelegramBridgeApiRuntime(deps: {
    getBotToken: () => string | undefined;
    recordRuntimeEvent: TelegramBridgeApiRuntimeDeps["recordRuntimeEvent"];
    captureRequestErrorHandler?: TelegramBridgeApiRuntimeDeps["captureRequestErrorHandler"];
    targetActivity?: TelegramApiTargetActivityRuntime;
    workspaceAdmission?: TelegramApiWorkspaceAdmissionPort | (() => TelegramApiWorkspaceAdmissionPort | undefined);
}): TelegramBridgeApiRuntime & {
    deleteWorkspaceThread: TelegramWorkspaceThreadDeletionTransport;
};
export declare function createTelegramBridgeApiRuntime(deps: TelegramBridgeApiRuntimeDeps): TelegramBridgeApiRuntime;
/**
 * Creates a low-level Telegram Bot API client.
 * This is the main entry point for all direct Bot API communication
 * (both JSON calls and multipart uploads for files/voice).
 */
export declare function createTelegramApiClient(getBotToken: () => string | undefined, options?: TelegramAnswerCallbackQueryOptions & {
    now?: () => number;
}): TelegramApiClient;
export {};
