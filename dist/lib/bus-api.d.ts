/**
 * Telegram bus-aware API runtime
 * Zones: multi-instance bus, telegram api transport, live instance routing
 * Wraps the direct Telegram Bot API runtime so follower instances can route outbound calls through the bus leader
 */
import type { TelegramBridgeApiRuntime } from "./telegram-api.ts";
export type TelegramBusApiCall = (method: string, args: unknown[]) => Promise<unknown>;
export interface TelegramBusAwareApiRuntimeDeps {
    directRuntime: TelegramBridgeApiRuntime;
    ownsDirect: () => boolean;
    callFollowerApi: TelegramBusApiCall;
    getDefaultTarget?: () => {
        chatId: number;
        threadId?: number;
    } | undefined;
}
export declare function createTelegramBusAwareApiRuntime(deps: TelegramBusAwareApiRuntimeDeps): TelegramBridgeApiRuntime;
