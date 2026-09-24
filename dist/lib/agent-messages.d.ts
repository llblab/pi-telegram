/**
 * Cross-instance Telegram agent message resolution and turn injection
 * Zones: multi-instance bus, inbound routing, operational delivery
 * Owns live target resolution, source attribution, same-target fencing, and synthetic turn construction; excludes Bot API delivery and bus transport.
 */
import type { TelegramBusAgentMessage, TelegramBusAgentTargetSelector, TelegramBusFollowerRegistry } from "./bus.ts";
import type { TelegramTarget } from "./target.ts";
export interface TelegramAgentMessageRuntimeDeps<TContext, TUpdate> {
    instanceId: string;
    getAllowedChatId: () => number | undefined;
    getLeaderTarget: () => TelegramTarget | undefined;
    getLeaderThreadName: () => string | undefined;
    getDisplayTitle?: (target: TelegramTarget) => string | undefined;
    followerRegistry: TelegramBusFollowerRegistry;
    getContext: () => TContext | undefined;
    handleUpdate: (update: TUpdate, ctx: TContext) => Promise<void>;
    getNowMs?: () => number;
}
export declare function createTelegramAgentMessageRuntime<TContext, TUpdate>(deps: TelegramAgentMessageRuntimeDeps<TContext, TUpdate>): {
    resolveTarget: (selector: TelegramBusAgentTargetSelector, sourceTarget?: TelegramTarget) => (TelegramTarget & {
        threadId: number;
    }) | undefined;
    route(input: {
        sourceTarget?: TelegramTarget;
        sourceThreadName?: string;
        message: TelegramBusAgentMessage;
    }): Promise<void>;
};
