/**
 * Telegram API transport helpers
 * Zones: telegram transport, filesystem, runtime diagnostics
 *
 * Wraps bot API calls, file uploads/downloads (including voice messages),
 * multipart sending, runtime transport binding, and Telegram temp-file lifecycle.
 */
import { type TelegramAttachmentRequestCandidate, type TelegramAttachmentSource } from "./media.ts";
export declare const TELEGRAM_FILE_MAX_BYTES: number;
/** First positive safe-integer byte limit among ordered env names, else the caller's default. */
export declare function getTelegramByteLimitFromEnv(env: NodeJS.ProcessEnv, names: readonly string[], defaultValue: number): number;
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
/** Process-local resource ownership only; never an execution/transport grant. */
export interface TelegramArtifactReservation {
    release: () => void;
}
export interface TelegramApiCallOptions {
    artifactReservation?: TelegramArtifactReservation;
    /** Local per-call effect authority; independent of source completion and transport ownership. */
    assertAuthority?: () => void;
    signal?: AbortSignal;
    /** Origin-local observation at the actual HTTP boundary; never transported as authority. */
    onRequestIssued?: () => void;
    /** Private origin-local positive identity observation before late authority checks. */
    onArtifactMessageId?: (messageId: number) => void;
    maxAttempts?: number;
    retryRateLimit?: boolean;
    retrySafety?: "safe" | "non-idempotent";
    retryBaseDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Observability hook fired before a 429 retry wait, never for 5xx waits. */
    onRetryWait?: (wait: TelegramApiRetryWait) => void;
    /** Caller-owned expected failure: still thrown, but the caller records the outcome instead of the API log. */
    isExpectedError?: (error: unknown) => boolean;
}
export declare class TelegramApiAuthorityError extends Error {
    readonly requestIssued: boolean;
    constructor(requestIssued: boolean, options?: ErrorOptions);
}
/** Recheck caller authority, classifying refusal by whether a Bot API request was already issued. */
export declare function assertTelegramApiCallAuthority(assertAuthority: (() => void) | undefined, requestIssued: boolean, errorOptions?: ErrorOptions): void;
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
    /** Cached media only: inline edits cannot upload a new local file. */
    media?: {
        type: "photo" | "document" | "audio";
        media: string;
        caption?: string;
    };
    text?: string;
    richMessage?: TelegramInputRichMessage;
    parseMode?: "HTML";
}
export interface TelegramAnswerCallbackQueryOptions extends Pick<TelegramApiCallOptions, "assertAuthority"> {
    recordRuntimeEvent?: (kind: "api", error: unknown, details?: Record<string, unknown>) => void;
}
export interface TelegramApiClient {
    reserveArtifact?: () => TelegramArtifactReservation | undefined;
    call: <TResponse>(method: string, body: Record<string, unknown>, options?: TelegramApiCallOptions) => Promise<TResponse>;
    callArtifactBytes?: <TResponse>(fields: Record<string, string>, bytes: Uint8Array, fileName: string, options: TelegramApiCallOptions) => Promise<TResponse>;
    callMultipart: <TResponse>(method: string, fields: Record<string, string>, fileField: string, filePath: string, fileName: string, options?: TelegramApiCallOptions) => Promise<TResponse>;
    downloadFile: (fileId: string, suggestedName: string, tempDir: string, options?: TelegramFileDownloadOptions) => Promise<string>;
    answerCallbackQuery: (callbackQueryId: string, text?: string, options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<void>;
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
export declare function createTelegramApiTargetActivityRuntime(deps?: {
    captureDrain?: () => (() => void) | undefined;
}): TelegramApiTargetActivityRuntime;
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
    /** Bot `@username` (or numeric id) naming private-chat attachments. */
    getBotScope?: () => string | undefined;
    recordRuntimeEvent: (kind: "api" | "multipart" | "download", error: unknown, details?: Record<string, unknown>) => void;
    now?: () => number;
    chatActionMinIntervalMs?: number;
    chatActionMaxGates?: number;
}
/** UI caller-lifetime checks may fence IPC issuance/ACK; they are never remote execution grants. */
export type TelegramApiUiAuthorityOptions = ({
    assertAuthority?: TelegramApiCallOptions["assertAuthority"];
    assertLocalAuthority?: never;
} | {
    assertAuthority?: never;
    assertLocalAuthority: NonNullable<TelegramApiCallOptions["assertAuthority"]>;
}) & {
    /** @internal Data from this original native edit only, never a publication or execution grant. */
    onNativeEditResult?: (result: unknown) => void;
};
/** @internal Capture callable identity before ownership observations or asynchronous work. */
export declare function captureTelegramUiAuthorityOptions(options?: TelegramApiUiAuthorityOptions): TelegramApiUiAuthorityOptions | undefined;
/** The single caller-lifetime fence of a captured UI authority scope, whichever kind it carries. */
export declare function getTelegramUiAuthorityAssertion(options?: TelegramApiUiAuthorityOptions): (() => void) | undefined;
/** Typing issuance guard is local authority, never Bot API body or IPC data. */
export interface TelegramTypingActionOptions extends Pick<TelegramApiCallOptions, "assertAuthority"> {
    message_thread_id?: number;
    /** Diagnostic observation only: an ended loop does not grant issuance, success or retry. */
    isCancelled?: () => boolean;
}
export interface TelegramArtifactTransport {
    isCurrent: () => boolean;
    send: (input: {
        bytes: Uint8Array;
        fileName: string;
        caption?: string;
        expiresAt: number;
        signal: AbortSignal;
        assertAuthority: () => void;
    }) => Promise<{
        effect: "sent" | "not-issued" | "rejected" | "unknown";
        reason: string;
        messageId?: number;
    }>;
}
export interface TelegramAttachmentPublicationTransport {
    readonly assertCurrent: () => void;
    readonly publish: (body: TelegramSendMessageBody, assertAuthority: () => void) => Promise<Readonly<{
        messageId: number;
        botId: number;
    }>>;
}
export interface TelegramBridgeApiRuntime extends Pick<TelegramApiClient, "call" | "callMultipart" | "callArtifactBytes" | "reserveArtifact"> {
    /** Original local direct publisher; unavailable follower provenance never enables common question coordination. */
    captureQuestionAuthority?: () => (() => void) | undefined;
    captureArtifactTransport?: (target: {
        chatId: number;
        threadId?: number;
    }) => TelegramArtifactTransport | undefined;
    /** Private follower question publication only; production composition leaves this unavailable. */
    captureAttachmentPublication?: (target: {
        chatId: number;
        threadId?: number;
    }) => TelegramAttachmentPublicationTransport | undefined;
    downloadFile: (fileId: string, suggestedName: string, source?: TelegramAttachmentSource) => Promise<string>;
    deleteWebhook: (signal?: AbortSignal) => Promise<boolean>;
    getUpdates: (body: Record<string, unknown>, signal?: AbortSignal) => Promise<TelegramUpdate[]>;
    setMyCommands: (commands: readonly {
        command: string;
        description: string;
    }[], options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<boolean>;
    sendChatAction: (chatId: number, action: string, options?: {
        message_thread_id?: number;
    }) => Promise<boolean>;
    sendTypingAction: (chatId: number, options?: TelegramTypingActionOptions) => Promise<unknown>;
    sendRecordVoiceAction: (chatId: number, options?: {
        message_thread_id?: number;
    }) => Promise<unknown>;
    sendMessageDraft: (chatId: number, draftId: number, text?: string, options?: {
        parse_mode?: string;
        entities?: unknown[];
        message_thread_id?: number;
    }) => Promise<boolean>;
    sendMessage: (body: TelegramSendMessageBody, options?: TelegramApiUiAuthorityOptions) => Promise<TelegramSentMessage>;
    sendRichMessage: (body: TelegramSendRichMessageBody, options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<TelegramSentMessage>;
    sendRichMessageDraft: (body: TelegramSendRichMessageDraftBody) => Promise<boolean>;
    editMessageText: (body: TelegramEditMessageTextBody, options?: TelegramApiUiAuthorityOptions) => Promise<"edited" | "unchanged">;
    editMessageReplyMarkup: (chatId: number, messageId: number, replyMarkup: unknown, options?: TelegramApiUiAuthorityOptions) => Promise<void | "edited">;
    answerCallbackQuery: (callbackQueryId: string, text?: string, options?: TelegramApiUiAuthorityOptions) => Promise<void>;
    answerGuestQuery: (guestQueryId: string, text?: string, options?: TelegramAnswerGuestQueryOptions) => Promise<void>;
    /**
     * Answers the guest query and retains the sent inline message id for final
     * text or cached-media replacement. Requires direct transport ownership;
     * actual guest-media rendering remains live-client gated.
     */
    answerGuestQueryForInlineMessage: (guestQueryId: string, text?: string, options?: TelegramAnswerGuestQueryOptions) => Promise<string | undefined>;
    editGuestInlineMessage: (inlineMessageId: string, content: TelegramEditGuestInlineMessageContent, options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<void>;
    deleteMessage: (chatId: number, messageId: number, options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<void>;
    prepareTempDir: () => Promise<number>;
}
/** Names follow `<kind>-<scope>-<messageId>[-<index>][-<name>|.<ext>]`. */
/**
 * `scope` is the bot `@username` (id fallback) in a private chat and the public chat `@username` (id fallback) elsewhere.
 * A negative chat id loses its sign, so the name never contains two adjacent dashes.
 */
export declare function createTelegramAttachmentFileName(source: TelegramAttachmentSource, generatedName: string, botScope?: string): string;
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
/** A follower API refusal; legacy text alone does not prove the request was rejected before execution. */
export declare class TelegramApiFollowerNotAllowedError extends Error {
    readonly requestTarget: {
        chatId: number;
        threadId: number;
    } | undefined;
    /** Present only after a structured pre-execution refusal matches the requested API method. */
    readonly rejectedRequestMethod: string | undefined;
    constructor(message: string, requestTarget?: {
        chatId: number;
        threadId: number;
    }, rejectedRequestMethod?: string);
}
export declare function getTelegramApiErrorRequestTarget(error: unknown): {
    chatId: number;
    threadId: number;
} | undefined;
export declare function isTelegramStaleTargetHttpError(error: unknown): boolean;
/** Only a parsed Telegram rejection of this method proves a request had no effect. */
export declare function isTelegramApiRequestRejected(error: unknown, method: string): boolean;
export declare function isTelegramMessageNotModifiedError(error: unknown): boolean;
/** Telegram refused the answer because the tap is too old or its ID is unknown; the toast can never be shown. */
export declare function isTelegramCallbackQueryExpiredError(error: unknown): boolean;
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
/** @internal */
export interface TelegramAttachmentCapturedFile {
    readonly metadata: Readonly<TelegramAttachmentRequestCandidate>;
    readonly path: string;
    readonly byteLength: number;
}
/** @internal Native lease accounting only; no producer/source execution or settlement grant. */
export interface TelegramAttachmentConsumerLease {
    readonly files: readonly (TelegramAttachmentCapturedFile & {
        readonly expiresAt: number;
    })[];
    readonly expiresAt: number;
    /** Consumer lifetime ended, not evidence that source pins cleared or files were deleted. */
    readonly ended: Promise<void>;
}
export declare function downloadTelegramFile(botToken: string | undefined, fileId: string, suggestedName: string, tempDir: string, options?: TelegramFileDownloadOptions): Promise<string>;
export declare function answerTelegramCallbackQuery(botToken: string | undefined, callbackQueryId: string, text?: string, options?: TelegramAnswerCallbackQueryOptions): Promise<void>;
export declare function createTelegramChatActionSender<TAction extends string>(sendChatAction: (chatId: number, action: TAction, options?: TelegramTypingActionOptions) => Promise<unknown>, action: TAction): (chatId: number, options?: TelegramTypingActionOptions) => Promise<unknown>;
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
    getBotScope?: () => string | undefined;
    isThreadedMode?: () => boolean;
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
    isThreadedMode?: () => boolean;
}): TelegramApiClient;
export {};
