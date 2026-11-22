/**
 * Telegram message ownership helpers
 * Zones: telegram routing, multi-instance bus, in-memory coordination
 * Owns message-id ownership, ordinary live forwarding projections, and opt-in immutable original-receiver provenance; observations never restore input/execution authority
 */
import { type TelegramBusInstanceRegistration, type TelegramBusFollowerView, type TelegramBusForwardOwnership } from "./bus.ts";
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
/** First-recorded provenance only, never a restored routing/execution grant. */
export interface TelegramMessageOwnershipOrigin {
    readonly record: Readonly<Omit<TelegramMessageOwnershipRecord, "target"> & {
        target: Readonly<TelegramTarget>;
    }>;
    readonly recipient?: Readonly<TelegramBusInstanceRegistration>;
}
/** Process-local provenance fence; compose with source/Delivery authority, never serialize the callable. */
export interface TelegramOriginalForwardOwnership {
    readonly ownership: Readonly<TelegramBusForwardOwnership & TelegramMessageOwnershipOrigin["record"]>;
    readonly recipient?: Readonly<TelegramBusInstanceRegistration>;
    readonly assertCurrent: () => void;
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
        recipient?: TelegramBusInstanceRegistration;
        /** Pin only at the first known publication; absent provenance cannot be upgraded by a later refresh. */
        retainOriginal?: boolean;
        requireFirst?: boolean;
        now?: number;
    }) => TelegramMessageOwnershipRecord;
    get: (chatId: number, messageId: number) => TelegramMessageOwnershipRecord | undefined;
    getOriginal: (chatId: number, messageId: number) => TelegramMessageOwnershipOrigin | undefined;
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
export type TelegramFollowerOwnershipView = Pick<TelegramBusFollowerView, keyof TelegramBusInstanceRegistration>;
/** Native publication scope, not a receiver/submission grant; keep callables local. */
export type TelegramOriginalPublicationWriter = ((messageId: number) => void) & {
    readonly assertCurrent: () => void;
};
export interface TelegramBusMessageOwnershipRuntime {
    store: TelegramMessageOwnershipStore;
    getForwardOwnership(chatId: number, messageId: number): TelegramBusForwardOwnership | undefined;
    /** Read-only candidate for a retained original receiver. Recheck at RPC issue/ACK; generic generation validation is insufficient. */
    getOriginalForwardOwnership(chatId: number, messageId: number): (TelegramBusForwardOwnership & TelegramMessageOwnershipOrigin["record"]) | undefined;
    /** Captures the exact retained origin; rechecks full foreign identity and row continuity at each local RPC boundary. */
    captureOriginalForwardOwnership(chatId: number, messageId: number): TelegramOriginalForwardOwnership | undefined;
    /** Captured publication writers pin known receipts only in their original profile/target/recipient scope. */
    captureLocalPublication(target: TelegramTarget): TelegramOriginalPublicationWriter;
    captureFollowerPublication(follower: TelegramFollowerOwnershipView, target: TelegramTarget): TelegramOriginalPublicationWriter;
    recordLocal(input: {
        chatId: number;
        messageId: number;
        target?: TelegramTarget;
        retainOriginal?: boolean;
    }): TelegramMessageOwnershipRecord;
    recordRouted(input: {
        chatId: number;
        messageId: number;
        target?: TelegramTarget;
        instanceId: string;
        retainOriginal?: boolean;
    }): TelegramMessageOwnershipRecord;
    recordFollower(input: {
        chatId: number;
        messageId: number;
        target?: TelegramTarget;
        follower: TelegramFollowerOwnershipView;
        retainOriginal?: boolean;
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
