/**
 * Durable journal for Telegram channel posts authored by this agent path
 * Zones: telegram outbound, filesystem authority
 * Owns publication intent, outcome-unknown fencing, confirmed post identity, and bounded local listing
 */
import type { ExtensionAPI } from "./pi.ts";
export type TelegramChannelPostMediaKind = "photo" | "video";
export interface TelegramChannelPostMediaIntent {
    kind: TelegramChannelPostMediaKind;
    fileName: string;
    sizeBytes: number;
    sha256: string;
}
export declare const TELEGRAM_CHANNEL_POST_MEDIA_MAX_BYTES: Record<TelegramChannelPostMediaKind, number>;
export declare const TELEGRAM_CHANNEL_POST_CAPTION_MAX_LENGTH = 1024;
export declare const TELEGRAM_CHANNEL_POST_MEDIA_FILE_NAME_MAX_LENGTH = 255;
/** Safe, content-free local validation failure for channel media publication intent. */
export declare class TelegramChannelPostValidationError extends Error {
    constructor(message: string);
}
export declare function isTelegramChannelPostValidationError(error: unknown): error is TelegramChannelPostValidationError;
export declare function resolveTelegramChannelPostMediaKind(path: string): TelegramChannelPostMediaKind | undefined;
export declare function assertTelegramChannelPostMediaSize(kind: TelegramChannelPostMediaKind, sizeBytes: number): void;
export declare function inspectTelegramChannelPostMedia(path: string): Promise<TelegramChannelPostMediaIntent>;
export declare function getTelegramChannelPostCaptionLength(caption: string): number;
export declare function assertTelegramChannelPostCaptionWithinLimit(caption: string): void;
type ChannelPostJournalCode = "invalid" | "conflict" | "capacity" | "io";
export declare class TelegramChannelPostJournalError extends Error {
    readonly code: ChannelPostJournalCode;
    constructor(code: ChannelPostJournalCode, message: string, cause?: unknown);
}
export type TelegramChannelPostAddress = number | `@${string}`;
interface TelegramChannelPostRecordBase {
    operationId: string;
    requestedChannel: TelegramChannelPostAddress;
    markdown: string;
    media?: TelegramChannelPostMediaIntent;
    createdAtMs: number;
    updatedAtMs: number;
}
interface TelegramPublishedChannelPostIdentity {
    issuedAtMs: number;
    publishedAtMs: number;
    channelId: number;
    messageId: number;
    channelUsername?: `@${string}`;
    channelTitle?: string;
    lastMutationId?: string;
}
export type TelegramChannelPostRecord = TelegramChannelPostRecordBase & ({
    state: "prepared";
} | {
    state: "outcome-unknown";
    issuedAtMs: number;
} | ({
    state: "published";
} & TelegramPublishedChannelPostIdentity) | ({
    state: "edit-outcome-unknown";
    mutationId: string;
    attemptedMarkdown: string;
    mutationIssuedAtMs: number;
} & TelegramPublishedChannelPostIdentity) | ({
    state: "delete-outcome-unknown";
    mutationId: string;
    mutationIssuedAtMs: number;
} & TelegramPublishedChannelPostIdentity) | ({
    state: "deleted";
    mutationId: string;
    deletedAtMs: number;
} & TelegramPublishedChannelPostIdentity));
export interface TelegramChannelPostJournalStoreOptions {
    path: string;
    profileName: string;
    tokenSha256: string;
    maxRecords?: number;
    maxBytes?: number;
    getNowMs?: () => number;
}
export interface TelegramChannelPostJournalStore {
    prepare(input: {
        operationId: string;
        channel: TelegramChannelPostAddress;
        markdown: string;
        media?: TelegramChannelPostMediaIntent;
    }): {
        prepared: boolean;
        record: TelegramChannelPostRecord;
    };
    get(operationId: string): TelegramChannelPostRecord | undefined;
    beginPublication(operationId: string): {
        began: boolean;
        record: TelegramChannelPostRecord;
    };
    confirmPublished(input: {
        operationId: string;
        channelId: number;
        messageId: number;
        channelUsername?: `@${string}`;
        channelTitle?: string;
    }): {
        confirmed: boolean;
        record: TelegramChannelPostRecord;
    };
    beginEdit(input: {
        operationId: string;
        mutationId: string;
        markdown: string;
    }): {
        began: boolean;
        record: TelegramChannelPostRecord;
    };
    confirmEdited(input: {
        operationId: string;
        mutationId: string;
    }): {
        confirmed: boolean;
        record: TelegramChannelPostRecord;
    };
    beginDelete(input: {
        operationId: string;
        mutationId: string;
    }): {
        began: boolean;
        record: TelegramChannelPostRecord;
    };
    confirmDeleted(input: {
        operationId: string;
        mutationId: string;
    }): {
        confirmed: boolean;
        record: TelegramChannelPostRecord;
    };
    list(input?: {
        channel?: TelegramChannelPostAddress;
        limit?: number;
    }): TelegramChannelPostRecord[];
}
export declare function publishTelegramChannelPost(input: {
    store: TelegramChannelPostJournalStore;
    operationId: string;
    channel: TelegramChannelPostAddress;
    markdown: string;
    media?: TelegramChannelPostMediaIntent;
    observeChannel(channel: TelegramChannelPostAddress): Promise<{
        id: number;
        type: string;
        username?: string;
        title?: string;
    }>;
    send(channel: TelegramChannelPostAddress, markdown: string): Promise<{
        messageId: number;
        chat: {
            id: number;
            type: string;
        };
    }>;
}): Promise<TelegramChannelPostRecord>;
export declare function registerTelegramChannelPostMutationTool(pi: ExtensionAPI, deps: {
    mutate(input: {
        action: "edit" | "delete";
        operationId: string;
        mutationId: string;
        markdown?: string;
    }): Promise<TelegramChannelPostRecord>;
}): void;
export declare function registerTelegramChannelPostListTool(pi: ExtensionAPI, deps: {
    list: TelegramChannelPostJournalStore["list"];
}): void;
export declare function createTelegramChannelPostJournalStore(options: TelegramChannelPostJournalStoreOptions): TelegramChannelPostJournalStore;
export {};
