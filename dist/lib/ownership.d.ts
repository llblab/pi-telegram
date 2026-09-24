/**
 * Telegram message ownership helpers
 * Zones: telegram routing, multi-instance bus, in-memory coordination
 * Owns message-id ownership and live forwarding projections so inbound updates resolve back to the instance/target that owns them
 */
import { type TelegramBusFollowerView, type TelegramBusForwardOwnership } from "./bus.ts";
import { type TelegramTarget } from "./target.ts";
export interface TelegramMessageOwnershipRecord {
    chatId: number;
    messageId: number;
    target: TelegramTarget;
    instanceId: string;
    profileKey?: string;
    ownerGeneration?: string;
    recipientBindingKey?: string;
    createdAt: number;
    updatedAt: number;
}
export interface TelegramMessageOwnershipStore {
    record: (input: {
        chatId: number;
        messageId: number;
        target?: TelegramTarget;
        instanceId: string;
        profileKey?: string;
        ownerGeneration?: string;
        recipientBindingKey?: string;
        now?: number;
    }) => TelegramMessageOwnershipRecord;
    get: (chatId: number, messageId: number) => TelegramMessageOwnershipRecord | undefined;
    forget: (chatId: number, messageId: number) => boolean;
    forgetTarget: (target: TelegramTarget) => number;
    prune: (options: {
        now: number;
        maxAgeMs?: number;
        maxRecords?: number;
    }) => number;
    entries: () => TelegramMessageOwnershipRecord[];
    clear: () => void;
}
export type TelegramFollowerOwnershipView = Pick<TelegramBusFollowerView, "instanceId" | "connectedAtMs" | "profileKey" | "registrationGeneration" | "protocol">;
export interface TelegramBusMessageOwnershipRuntime {
    store: TelegramMessageOwnershipStore;
    getForwardOwnership(chatId: number, messageId: number): TelegramBusForwardOwnership | undefined;
    recordLocal(input: {
        chatId: number;
        messageId: number;
        target?: TelegramTarget;
    }): TelegramMessageOwnershipRecord;
    recordRouted(input: {
        chatId: number;
        messageId: number;
        target?: TelegramTarget;
        instanceId: string;
    }): TelegramMessageOwnershipRecord;
    recordFollower(input: {
        chatId: number;
        messageId: number;
        target?: TelegramTarget;
        follower: TelegramFollowerOwnershipView;
    }): TelegramMessageOwnershipRecord;
    isOwnedByFollower(input: {
        chatId: number;
        messageId: number;
        follower: TelegramFollowerOwnershipView;
    }): boolean;
}
export declare function createTelegramBusMessageOwnershipRuntime(deps: {
    instanceId: string;
    getProfileKey(): string;
    listFollowers(): readonly TelegramFollowerOwnershipView[];
}): TelegramBusMessageOwnershipRuntime;
export declare function createTelegramMessageOwnershipStore(options?: {
    getProfileKey?: () => string | undefined;
    isOwnerGenerationLive?: (record: TelegramMessageOwnershipRecord) => boolean;
    resolveOwnerReplacement?: (record: TelegramMessageOwnershipRecord) => Pick<TelegramMessageOwnershipRecord, "instanceId" | "ownerGeneration" | "recipientBindingKey"> | undefined;
}): TelegramMessageOwnershipStore;
