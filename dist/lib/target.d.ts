/**
 * Telegram transport destination value helpers
 * Zones: Bot API transport, routing, replies/previews, ownership, multi-instance bus
 * Owns the minimal `{ chatId, threadId? }` address shape and exact group/topic address checks,
 * plus the shared assigned-target and Threaded Mode projections over the bus roles.
 */
export interface TelegramTarget {
    chatId: number;
    threadId?: number;
}
export declare function createTelegramPrivateTarget(chatId: number): TelegramTarget;
export declare function createTelegramThreadTarget(chatId: number, threadId: number): TelegramTarget;
export declare function getTelegramTargetKey(target: TelegramTarget): string;
export declare function isTelegramThreadTarget(target: TelegramTarget): target is TelegramTarget & {
    threadId: number;
};
export declare function areTelegramTargetsEqual(left: TelegramTarget, right: TelegramTarget): boolean;
export declare function getTelegramTargetThreadParams(target: TelegramTarget): {
    message_thread_id?: number;
};
/** Pure wire parser for `{ chatId, threadId? }`; unknown fields are dropped and malformed shapes refuse. */
export declare function parseTelegramTarget(value: unknown): TelegramTarget | undefined;
/** Parse an exact group address; a malformed topic must never become a chat-only target. */
export declare function parseTelegramGroupTarget(value: unknown): TelegramTarget | undefined;
/** Check exact Bot API chat identity and forum shape, not topic existence or write permission. */
export declare function matchesTelegramGroupChat(chat: unknown, target: TelegramTarget): boolean;
/** Pure Bot API integer id parser accepting integer numbers or non-blank integer strings. */
export declare function parseTelegramIntegerId(value: unknown): number | undefined;
/** Registered follower and own leader Thread sources; each reports its acknowledged target, if any. */
interface TelegramAssignedTargetSources {
    follower: {
        getTarget: () => TelegramTarget | undefined;
    };
    leader: {
        getTarget: () => TelegramTarget | undefined;
    };
}
/** The registered follower's target wins over the leader's own Thread. */
export declare function createTelegramAssignedTargetGetter(sources: TelegramAssignedTargetSources): () => TelegramTarget | undefined;
/** Threaded Mode holds when persisted state enables it or either bus role owns a Thread target. */
export declare function createTelegramThreadedModeReader(sources: TelegramAssignedTargetSources & {
    botState: {
        getBotState: () => {
            threadMode?: string;
        };
    };
}): () => boolean;
export {};
