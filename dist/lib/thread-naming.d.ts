/**
 * Telegram Thread manual-name dialog state
 * Zones: telegram, thread identity, runtime controls
 * Owns one expiring exact-target interaction per session scope.
 * Excludes Telegram transport, durable Workspace mutation, and name validation.
 */
import type { TelegramTarget } from "./target.ts";
export declare const TELEGRAM_THREAD_NAME_DIALOG_TTL_MS: number;
export type TelegramThreadNameDialogAction = "reset" | "cancel";
export interface TelegramThreadNameDialogCandidate {
    scope: string;
    target: TelegramTarget;
    dialogMessageId: number;
    phase: "input";
    expiresAtMs: number;
}
export declare function createTelegramThreadNameDialogRuntime(options?: {
    ttlMs?: number;
    nowMs?: () => number;
}): {
    open(input: {
        scope: string;
        target: TelegramTarget;
        dialogMessageId: number;
    }): TelegramThreadNameDialogCandidate;
    select(input: {
        scope: string;
        target: TelegramTarget;
        dialogMessageId: number;
        action: TelegramThreadNameDialogAction;
    }): {
        kind: "reset" | "cancel" | "expired";
    };
    consumeName(input: {
        scope: string;
        target: TelegramTarget;
        text: string;
    }): {
        kind: "name";
        name: string;
    } | {
        kind: "none" | "empty";
    };
    clearScope(scope: string): void;
    inspect(target: TelegramTarget): TelegramThreadNameDialogCandidate | undefined;
};
