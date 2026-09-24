/**
 * Telegram singleton lock helpers
 * Zones: telegram ownership, filesystem, transport authority
 * Owns extension-local owners.json access and Telegram bridge ownership semantics
 */
import { renameSync } from "node:fs";
export declare const TELEGRAM_LOCK_KEY = "default";
export declare const TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS = 8000;
export declare const TELEGRAM_OWNERSHIP_CHECK_MS = 1000;
export declare const TELEGRAM_OWNERSHIP_REFRESH_MS = 2000;
/**
 * Resolve the extension-local owner slot for the active Telegram profile.
 * Default profile → default
 * Named profile → the validated profile name
 */
export declare function resolveTelegramLockKey(activeProfile?: string): string;
export interface TelegramActiveProfileGetter {
    getActiveProfileName: () => string | undefined;
}
export declare function createTelegramLockKeyResolver(activeProfile: TelegramActiveProfileGetter): () => string;
export interface TelegramLockEntry {
    pid: number;
    cwd?: string;
    instanceId?: string;
    heartbeatMs?: number;
    leaderEpoch?: number | string;
    runtimeGeneration?: number;
    busSocketPath?: string;
    busSecret?: string;
}
export interface TelegramLockContext {
    cwd: string;
}
export type TelegramLockState = {
    kind: "inactive";
} | {
    kind: "active-here";
    lock: TelegramLockEntry;
} | {
    kind: "active-elsewhere";
    lock: TelegramLockEntry;
} | {
    kind: "stale";
    lock: TelegramLockEntry;
};
export interface TelegramLockAcquireOptions {
    force?: boolean;
    expectedOwner?: TelegramLockEntry;
    election?: boolean;
}
export type TelegramLockAcquireResult = {
    ok: true;
    lock: TelegramLockEntry;
    replacedStale: boolean;
} | {
    ok: false;
    lock: TelegramLockEntry;
};
export interface TelegramLockRuntime<TContext extends TelegramLockContext> {
    acquire: (ctx: TContext, options?: TelegramLockAcquireOptions) => TelegramLockAcquireResult;
    release: () => TelegramLockState;
    getState: () => TelegramLockState;
    getStatusLabel: () => string;
    getOwnedLeaderEpoch: () => number | string | undefined;
    owns: (ctx?: TelegramLockContext) => boolean;
    commitIfOwned: (commit: () => void) => boolean;
    refresh: (ctx?: TelegramLockContext) => boolean;
}
export interface TelegramLockOwnershipGuard<TContext extends TelegramLockContext> {
    ownsContext: (ctx: TContext) => boolean;
}
export interface TelegramLockContextStore<TContext extends TelegramLockContext> {
    get: () => TContext | undefined;
}
export interface TelegramLockRuntimeOptions {
    key?: string | (() => string | undefined);
    locksPath?: string;
    pid?: number;
    isProcessAlive?: (pid: number) => boolean;
    instanceId?: string;
    busSocketPath?: string;
    busSecret?: string;
    getNowMs?: () => number;
    mintLeaderEpoch?: () => number | string;
    runtimeGeneration?: number;
    staleHeartbeatMs?: number;
}
export declare function readLocks(path?: string): Record<string, unknown>;
export interface TelegramRenameRetryOptions {
    rename?: typeof renameSync;
    attempts?: number;
    retryDelayMs?: number;
}
/** Rename one Telegram runtime artifact with bounded Windows sharing retries. */
export declare function renameTelegramPathWithRetry(sourcePath: string, destinationPath: string, options?: TelegramRenameRetryOptions): boolean;
export interface TelegramFileTransactionOptions {
    recoveryRename?: typeof renameSync;
    publishRename?: typeof renameSync;
    attempts?: number;
    retryDelayMs?: number;
}
export declare function withTelegramFileTransaction<T>(transactionPath: string, operation: () => T, options?: TelegramFileTransactionOptions): T;
export declare function writeLocks(path: string, locks: Record<string, unknown>): void;
export declare function parseTelegramLockEntry(value: unknown): TelegramLockEntry | undefined;
export declare function isProcessAlive(pid: number): boolean;
export declare function formatTelegramLockEntry(lock: TelegramLockEntry): string;
export declare function createTelegramLockRuntime<TContext extends TelegramLockContext>(options?: TelegramLockRuntimeOptions): TelegramLockRuntime<TContext>;
export declare function createTelegramLockOwnershipGuard<TContext extends TelegramLockContext>(lock: TelegramLockRuntime<TContext>): TelegramLockOwnershipGuard<TContext>;
export declare function createTelegramDirectDeliveryOwnershipChecker<TContext extends TelegramLockContext>(deps: {
    lock: TelegramLockRuntime<TContext>;
    contextStore: TelegramLockContextStore<TContext>;
}): () => boolean;
export interface TelegramLockedPollingStartOptions {
    force?: boolean;
    forceFreshLeaderThread?: boolean;
    requestedThreadName?: string;
    election?: {
        expectedOwner?: TelegramLockEntry;
    };
    onAcquired?: () => Promise<void> | void;
}
export type TelegramLockedPollingStartResult = {
    ok: true;
    message?: string;
    canTakeover?: false;
} | {
    ok: false;
    message: string;
    canTakeover?: boolean;
    owner?: string;
};
export interface TelegramLockedPollingRuntime<TContext extends TelegramLockContext> {
    start: (ctx: TContext, options?: TelegramLockedPollingStartOptions) => Promise<TelegramLockedPollingStartResult>;
    stop: () => Promise<string>;
    suspend: () => Promise<void>;
    isSuspended: () => boolean;
    onPersistentConflict: (ctx: TContext, count: number) => Promise<void>;
    onSessionStart: (_event: unknown, ctx: TContext) => Promise<void>;
    registerFollowerWithOwner?: (ctx: TContext, owner: TelegramLockEntry) => boolean | undefined | Promise<boolean | undefined>;
    restoreFollowerWithOwner?: (ctx: TContext, owner: TelegramLockEntry) => boolean | undefined | Promise<boolean | undefined>;
    stopFollowerRegistration?: () => void;
}
export interface TelegramLockedPollingRuntimeDeps<TContext extends TelegramLockContext> {
    lock: TelegramLockRuntime<TContext>;
    hasBotToken: () => boolean;
    getBotTokenDiagnostic?: () => string | undefined;
    canStartPolling?: (ctx: TContext) => boolean;
    isContextCurrent?: (ctx: TContext) => boolean;
    formatStartBlockedMessage?: (ctx: TContext) => string;
    startPolling: (ctx: TContext, options?: TelegramLockedPollingStartOptions) => void | Promise<void>;
    stopPolling: () => Promise<void>;
    registerFollowerWithOwner?: (ctx: TContext, owner: TelegramLockEntry) => boolean | undefined | Promise<boolean | undefined>;
    restoreFollowerWithOwner?: (ctx: TContext, owner: TelegramLockEntry) => boolean | undefined | Promise<boolean | undefined>;
    stopFollowerRegistration?: () => void;
    onTransportAvailabilityChanged?: () => void;
    transportMonitor?: {
        start: (ctx: TContext) => void;
        stop: () => void;
    };
    updateStatus: (ctx: TContext) => void;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    ownershipCheckMs?: number;
    ownershipRefreshMs?: number;
}
export declare function createTelegramLockedPollingRuntime<TContext extends TelegramLockContext>(deps: TelegramLockedPollingRuntimeDeps<TContext>): TelegramLockedPollingRuntime<TContext>;
