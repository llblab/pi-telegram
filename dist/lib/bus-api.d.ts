/**
 * Telegram bus-aware API runtime
 * Zones: multi-instance bus, telegram api transport, live instance routing
 * Wraps the direct Telegram Bot API runtime so follower instances can route outbound calls through the bus leader
 */
import { type TelegramBusProtocolIdentity, type TelegramBusSelectedMenuDeliveryObservation, type TelegramBusSelectedMenuTextEffect } from "./bus.ts";
import type { TelegramButtonPublicationObserver, TelegramButtonPublicationEditor } from "./outbound-buttons.ts";
import type { TelegramAttachmentPublicationRegistration } from "./bus-follower.ts";
import type { TelegramApiCallOptions, TelegramBridgeApiRuntime } from "./telegram-api.ts";
export type TelegramBusApiCall = (method: string, args: unknown[], localOptions?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<unknown>;
export interface TelegramBusAwareApiRuntimeDeps {
    directRuntime: TelegramBridgeApiRuntime;
    beginButtonPublication?: TelegramButtonPublicationObserver;
    captureQuestionAuthority?: () => (() => void) | undefined;
    /** Original native API registration, not Artifact or a current SDK lookup. */
    captureFollowerApiRegistration?: () => (() => void) | undefined;
    getQuestionBotId?: () => number | undefined;
    ownsDirect: () => boolean;
    callFollowerApi: TelegramBusApiCall;
    getDefaultTarget?: () => {
        chatId: number;
        threadId?: number;
    } | undefined;
    captureDirectArtifactAuthority?: () => (() => boolean) | undefined;
    captureFollowerArtifactRegistration?: () => {
        incarnation: string;
        isCurrent: () => boolean;
    } | undefined;
    getFollowerProtocol?: () => TelegramBusProtocolIdentity | undefined;
    artifactProtocol?: TelegramBusProtocolIdentity;
    /** Private native registration owner, deliberately unbound by production assembly. */
    captureAttachmentPublicationRegistration?: () => TelegramAttachmentPublicationRegistration | undefined;
}
/** Capture the original session and direct/follower identity for one agent selection view. */
export declare function createTelegramButtonSelectionAuthorityCapture<TStamp>(deps: Readonly<{
    captureSession: () => (() => boolean) | undefined;
    getTransportStamp: () => TStamp;
    isTransportStampActive: (stamp: TStamp) => boolean;
    getAllowedUserId: () => number | undefined;
    ownsDirect: () => boolean;
    getLeaderEpoch: () => number | string | undefined;
    getFollowerGeneration: () => number | string | undefined;
    isFollowerRegistered: () => boolean;
    getLeaderTarget: () => Readonly<{
        chatId: number;
        threadId?: number;
    }> | undefined;
    getFollowerTarget: () => Readonly<{
        chatId: number;
        threadId?: number;
    }> | undefined;
    captureFollowerRegistration?: () => {
        readonly isCurrent: () => boolean;
    } | undefined;
}>): () => (() => void) | undefined;
/** Original local question provider; remote publication/receiver evidence remains a separate boundary. */
export declare function createTelegramQuestionAuthorityCapture<TStamp>(deps: Parameters<typeof createTelegramButtonSelectionAuthorityCapture<TStamp>>[0] & Readonly<{
    getBotId: () => number | undefined;
    captureFollowerRegistration: () => {
        readonly incarnation?: string;
        readonly isCurrent: () => boolean;
    } | undefined;
}>): () => (() => void) | undefined;
/** Capture Locks and Queue authority only at operation admission, never during root assembly. */
export declare function createTelegramArtifactTransportAuthorityCapture<TStamp>(transport: {
    captureCurrentTransportAuthority(): (() => boolean) | undefined;
}, stamps: {
    getStamp(): TStamp;
    isActive(stamp: TStamp): boolean;
}): () => (() => boolean) | undefined;
/** Bound selected-menu projection only; no ordinary/raw API fallback and no activation during preparation. */
export declare function createTelegramSelectedMenuTextApi(deps: {
    operationId: string;
    registrationGeneration: string;
    target: {
        chatId: number;
        threadId: number;
    };
    assertAuthority: () => void;
    deliver(effect: TelegramBusSelectedMenuTextEffect, assertAuthority: () => void): Promise<TelegramBusSelectedMenuDeliveryObservation>;
}): Pick<TelegramBridgeApiRuntime, "sendMessage" | "editMessageText">;
/** Only an acknowledged message location plus its original local authority may be retired. */
export declare function createTelegramButtonPublicationEditor(api: Pick<TelegramBridgeApiRuntime, "editMessageReplyMarkup" | "editMessageText">): TelegramButtonPublicationEditor;
export declare function createTelegramBusAwareApiRuntime(deps: TelegramBusAwareApiRuntimeDeps): Omit<TelegramBridgeApiRuntime, "editMessageReplyMarkup"> & {
    editMessageReplyMarkup: (...args: Parameters<TelegramBridgeApiRuntime["editMessageReplyMarkup"]>) => Promise<void>;
};
