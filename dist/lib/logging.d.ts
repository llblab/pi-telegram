/**
 * Telegram diagnostics logs
 * Zones: telegram diagnostics, filesystem, session observability
 * Owns bounded JSONL runtime evidence files, previous-log preservation, and profile-aware log paths without becoming routing state
 */
import * as Status from "./status.ts";
export type TelegramLogPathInput = string | (() => string);
export interface TelegramRuntimeJsonlEvent {
    at: number;
    category: string;
    message: string;
    details?: Record<string, unknown>;
}
export interface TelegramRuntimeJsonlLogOptions {
    path?: TelegramLogPathInput;
    previousPath?: TelegramLogPathInput;
    maxBytes?: number;
    getNowMs?: () => number;
    canReset?: () => boolean;
    commitReset?: (commit: () => void) => boolean;
}
export interface TelegramRuntimeJsonlLog {
    getPath: () => string;
    reset: (reason: string, scope?: Record<string, unknown>) => void;
    resetIfScopeChanged: (scopeKey: string, reason: string, scope?: Record<string, unknown>) => void;
    record: (event: TelegramRuntimeJsonlEvent) => void;
}
export declare function getTelegramRuntimeLogPath(agentDir?: string, profileName?: string): string;
export declare function getTelegramPreviousRuntimeLogPath(agentDir?: string, profileName?: string): string;
export declare function createTelegramRuntimeJsonlLog(options?: TelegramRuntimeJsonlLogOptions): TelegramRuntimeJsonlLog;
export interface TelegramRuntimeDiagnosticsRuntime<TContext> {
    events: Status.TelegramRuntimeEventRecorder;
    recordRuntimeEvent(category: string, error: unknown, details?: Record<string, unknown>): void;
    bindStorage(ports: {
        getBotToken(): string | undefined;
        getProfileName(): string | undefined;
        canReset(): boolean;
        commitReset(commit: () => void): boolean;
    }): void;
    bindStatus(ports: {
        instanceId: string;
        updateStatus(ctx: TContext, error?: string): void;
        getStatusState(): Status.TelegramBridgeStatusLineState;
        persistSnapshot(snapshot: ReturnType<typeof Status.createTelegramStatusSnapshot>): Promise<void>;
    }): void;
    updateStatus(ctx: TContext, error?: string): void;
    getStatusLines(options?: Status.TelegramBridgeStatusLineOptions): string[];
    scheduleSnapshotPersist(): void;
}
export declare function createTelegramRuntimeDiagnosticsRuntime<TContext>(): TelegramRuntimeDiagnosticsRuntime<TContext>;
