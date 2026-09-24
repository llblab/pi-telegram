/**
 * Telegram outbound attachment helpers
 * Zones: telegram outbound, pi agent tool, filesystem
 * Owns telegram_attach registration, outbound attachment queueing, and delivery so Telegram file output stays in one domain module
 */
import type { TelegramBusAgentMessage, TelegramBusAgentTargetSelector } from "./bus.ts";
import type { ExtensionAPI } from "./pi.ts";
import { type TelegramTarget } from "./target.ts";
export declare const TELEGRAM_OUTBOUND_ATTACHMENT_DEFAULT_MAX_BYTES: number;
export declare function getTelegramOutboundAttachmentByteLimitFromEnv(env: NodeJS.ProcessEnv, names: string[], defaultValue?: number): number;
export declare const TELEGRAM_OUTBOUND_ATTACHMENT_MAX_BYTES: number;
export interface TelegramOutboundAttachmentToolResult {
    content: Array<{
        type: "text";
        text: string;
    }>;
    details: {
        paths: string[];
    };
}
export interface TelegramOutboundAttachmentRuntimeEventRecorderPort {
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface TelegramOutboundAttachmentToolRegistrationDeps extends TelegramOutboundAttachmentRuntimeEventRecorderPort {
    maxAttachmentsPerTurn?: number;
    maxAttachmentSizeBytes?: number;
    getActiveTurn: () => TelegramOutboundAttachmentQueueTargetView | undefined;
    getDefaultChatId?: () => number | undefined;
    getDefaultTarget?: () => TelegramTarget | undefined;
    canSendDirect?: () => boolean;
    sendMultipart?: TelegramQueuedOutboundAttachmentDeliveryDeps["sendMultipart"];
    statPath?: (path: string) => Promise<{
        isFile(): boolean;
        size?: number;
    }>;
}
export interface TelegramOutboundMessagePlan {
    markdown: string;
    replyMarkup?: unknown;
}
export interface TelegramOutboundMessageToolRegistrationDeps extends TelegramOutboundAttachmentRuntimeEventRecorderPort {
    getDefaultChatId: () => number | undefined;
    getDefaultTarget?: () => TelegramTarget | undefined;
    getActiveTurn?: () => {
        chatId: number;
        target?: TelegramTarget;
    } | undefined;
    resolveAgentTarget?: (selector: TelegramBusAgentTargetSelector) => Promise<TelegramTarget & {
        threadId: number;
    }>;
    routeAgentMessage?: (message: TelegramBusAgentMessage) => Promise<void>;
    canSendDirect: () => boolean;
    planMessage: (markdown: string) => TelegramOutboundMessagePlan;
    sendMarkdownMessage: (chatId: number, markdown: string, options?: {
        replyMarkup?: unknown;
        target?: TelegramTarget;
    }) => Promise<number | undefined>;
    sendChannelMarkdownMessage?: (channel: number | string, markdown: string, options: {
        operationId: string;
        replyMarkup?: unknown;
    }) => Promise<number | undefined>;
    sendChannelMediaMessage?: (channel: number | string, mediaPath: string, markdown: string, options: {
        operationId: string;
        replyMarkup?: unknown;
    }) => Promise<number | undefined>;
}
export interface TelegramQueuedOutboundAttachmentView {
    path: string;
    fileName: string;
}
export interface TelegramOutboundAttachmentQueueTargetView {
    queuedAttachments: TelegramQueuedOutboundAttachmentView[];
    guestQueryId?: string;
}
export interface TelegramQueuedOutboundAttachmentTurnView extends TelegramOutboundAttachmentQueueTargetView {
    chatId: number;
    replyToMessageId: number;
    target?: TelegramTarget;
}
export interface TelegramRichOutboundAttachmentPlan {
    method: "sendRichMessage";
    fields: Record<string, string>;
    fileField: "rich_media_upload";
    filePath: string;
    fileName: string;
}
export interface TelegramRichOutboundAttachmentSenderDeps extends TelegramOutboundAttachmentRuntimeEventRecorderPort {
    sendMultipart: TelegramQueuedOutboundAttachmentDeliveryDeps["sendMultipart"];
    getRenderingMode: () => "rich" | "html";
    recordOwnership?: (input: {
        chatId: number;
        messageId: number;
        target?: TelegramTarget;
    }) => void;
}
export declare function planTelegramRichOutboundAttachment(options: {
    turn: TelegramQueuedOutboundAttachmentTurnView;
    markdown: string;
    renderingMode: "rich" | "html";
    replyMarkup?: unknown;
}): TelegramRichOutboundAttachmentPlan | undefined;
export declare function createTelegramRichOutboundAttachmentSender(deps: TelegramRichOutboundAttachmentSenderDeps): (turn: TelegramQueuedOutboundAttachmentTurnView, markdown: string, options?: {
    replyMarkup?: unknown;
    isDeliveryActive?: () => boolean;
}) => Promise<boolean>;
export type TelegramGuestCachedAttachmentResult = {
    type: "document";
    id: string;
    title: string;
    document_file_id: string;
    caption?: string;
} | {
    type: "photo";
    id: string;
    photo_file_id: string;
    caption?: string;
} | {
    type: "audio";
    id: string;
    audio_file_id: string;
    caption?: string;
} | {
    type: "voice";
    id: string;
    voice_file_id: string;
    title: string;
    caption?: string;
};
export declare function registerTelegramOutboundAttachmentTool(pi: ExtensionAPI, deps: TelegramOutboundAttachmentToolRegistrationDeps): void;
export declare function registerTelegramOutboundMessageTool(pi: ExtensionAPI, deps: TelegramOutboundMessageToolRegistrationDeps): void;
export interface TelegramQueuedOutboundAttachmentDeliveryDeps {
    sendMultipart: (method: string, fields: Record<string, string>, fileField: string, filePath: string, fileName: string) => Promise<unknown>;
    sendTextReply: (chatId: number, replyToMessageId: number, text: string, options?: {
        target?: TelegramTarget;
    }) => Promise<unknown>;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    statPath?: (path: string) => Promise<{
        size: number;
    }>;
    maxAttachmentSizeBytes?: number;
    isDeliveryActive?: () => boolean;
}
export declare function queueTelegramOutboundAttachments(options: {
    activeTurn: TelegramOutboundAttachmentQueueTargetView | undefined;
    paths: string[];
    chatId?: number;
    threadId?: number;
    caption?: string;
    maxAttachmentsPerTurn: number;
    maxAttachmentSizeBytes?: number;
    sendMultipart?: TelegramQueuedOutboundAttachmentDeliveryDeps["sendMultipart"];
    getDefaultChatId?: () => number | undefined;
    getDefaultTarget?: () => TelegramTarget | undefined;
    canSendDirect?: () => boolean;
    statPath?: (path: string) => Promise<{
        isFile(): boolean;
        size?: number;
    }>;
}): Promise<TelegramOutboundAttachmentToolResult>;
export declare function deliverTelegramGuestCachedAttachment(options: {
    guestQueryId: string;
    stagingChatId: number;
    stagingTarget?: TelegramTarget;
    attachment: TelegramQueuedOutboundAttachmentView;
    caption?: string;
    sendMultipart: TelegramQueuedOutboundAttachmentDeliveryDeps["sendMultipart"];
    answerGuestQuery: (guestQueryId: string, result: TelegramGuestCachedAttachmentResult) => Promise<void>;
    answerGuestText?: (guestQueryId: string, text: string) => Promise<void>;
    fallbackText?: string;
    deleteMessage: (chatId: number, messageId: number) => Promise<void>;
    recordRuntimeEvent?: TelegramOutboundAttachmentRuntimeEventRecorderPort["recordRuntimeEvent"];
}): Promise<void>;
export declare function sendTelegramOutboundMessage(options: {
    text: string;
    media?: string;
    operationId?: string;
    channel?: boolean;
    chatId?: number | string;
    threadId?: number;
    agentThread?: string | number;
    target?: TelegramTarget;
    getDefaultChatId?: () => number | undefined;
    getDefaultTarget?: () => TelegramTarget | undefined;
    getActiveTurn?: () => {
        chatId: number;
        target?: TelegramTarget;
    } | undefined;
    resolveAgentTarget?: (selector: TelegramBusAgentTargetSelector) => Promise<TelegramTarget & {
        threadId: number;
    }>;
    routeAgentMessage?: (message: TelegramBusAgentMessage) => Promise<void>;
    canSendDirect: () => boolean;
    planMessage: (markdown: string) => TelegramOutboundMessagePlan;
    sendMarkdownMessage: (chatId: number, markdown: string, options?: {
        replyMarkup?: unknown;
        target?: TelegramTarget;
    }) => Promise<number | undefined>;
    sendChannelMarkdownMessage?: (channel: number | string, markdown: string, options: {
        operationId: string;
        replyMarkup?: unknown;
    }) => Promise<number | undefined>;
    sendChannelMediaMessage?: (channel: number | string, mediaPath: string, markdown: string, options: {
        operationId: string;
        replyMarkup?: unknown;
    }) => Promise<number | undefined>;
}): Promise<{
    content: Array<{
        type: "text";
        text: string;
    }>;
    details: {
        chatId: number | string;
        messageId?: number;
    };
}>;
export declare function sendTelegramOutboundFiles(options: {
    paths: string[];
    chatId?: number;
    threadId?: number;
    target?: TelegramTarget;
    caption?: string;
    maxAttachmentsPerTurn: number;
    maxAttachmentSizeBytes?: number;
    sendMultipart: TelegramQueuedOutboundAttachmentDeliveryDeps["sendMultipart"];
    getDefaultChatId?: () => number | undefined;
    getDefaultTarget?: () => TelegramTarget | undefined;
    canSendDirect?: () => boolean;
    statPath?: (path: string) => Promise<{
        isFile(): boolean;
        size?: number;
    }>;
}): Promise<TelegramOutboundAttachmentToolResult & {
    details: {
        paths: string[];
        chatId: number;
    };
}>;
export declare function createTelegramQueuedOutboundAttachmentSender(deps: TelegramQueuedOutboundAttachmentDeliveryDeps): (turn: TelegramQueuedOutboundAttachmentTurnView, options?: {
    isDeliveryActive?: () => boolean;
}) => Promise<void>;
export declare function sendQueuedTelegramOutboundAttachments(turn: TelegramQueuedOutboundAttachmentTurnView, deps: TelegramQueuedOutboundAttachmentDeliveryDeps): Promise<void>;
