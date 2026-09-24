/**
 * Telegram per-chat time injection runtime
 * Zones: telegram inbound, prompt content
 * Owns the formatted `[time]` line and the per-chat interval bookkeeping that decides when to emit it
 */
import type { ResolvedTelegramTimeConfig } from "./config.ts";
export interface TimeInjectionRuntime {
    resolveLine: (chatId: number, now?: Date) => string | null;
}
export interface TimeInjectionRuntimeDeps {
    getConfig: () => ResolvedTelegramTimeConfig;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export declare function formatTelegramTimeInjectionLine(now: Date, timezone: string): string;
export declare function createTimeInjectionRuntime(deps: TimeInjectionRuntimeDeps): TimeInjectionRuntime;
