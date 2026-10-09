/**
 * Telegram singleton lock helpers
 * Zones: telegram ownership, filesystem, transport authority
 * Owns filesystem authority, atomic runtime-section publication and Telegram bridge ownership semantics
 */
import { renameSync } from "node:fs";
export declare const TELEGRAM_LOCK_KEY = "default";
export declare const TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS = 8000;
export declare const TELEGRAM_OWNERSHIP_CHECK_MS = 1000;
export declare const TELEGRAM_OWNERSHIP_REFRESH_MS = 2000;
/** Consecutive unverified ownership checks tolerated before standing down; a concurrent shared-state replacement must not stop an owned transport. */
export declare const TELEGRAM_OWNERSHIP_CHECK_FAILURE_TOLERANCE = 2;
/**
 * Resolve the extension-local owner slot for the active Telegram profile.
 * Default profile → default
 * Named profile → the validated profile name
 */
export declare function resolveTelegramLockKey(activeProfile?: string): string;
interface TelegramActiveProfileGetter {
    getActiveProfileName: () => string | undefined;
}
export declare function createTelegramLockKeyResolver(activeProfile: TelegramActiveProfileGetter): () => string;
/** Structural session view; Locks never imports the lifecycle owner. */
interface TelegramOwnedStateSessionPort<TContext extends TelegramLockContext> {
    get: () => TContext | undefined;
    getGeneration: () => number;
    isCurrent: (ctx: TContext, generation?: number) => boolean;
}
/**
 * Captures exact context, session generation and owned leader epoch before awaits.
 * Session replacement, release or re-election revokes the grant; a successor never renews it.
 */
export declare function createTelegramOwnedStateAuthorityCapture<TContext extends TelegramLockContext>(lock: Pick<TelegramLockRuntime<TContext>, "owns" | "getOwnedLeaderEpoch">, session: TelegramOwnedStateSessionPort<TContext>): () => (() => boolean) | undefined;
export interface TelegramLockEntry {
    pid: number;
    cwd?: string;
    instanceId?: string;
    heartbeatMs?: number;
    leaderEpoch?: number | string;
    runtimeGeneration?: number;
    busSocketPath?: string;
    busSecret?: string;
    /** Polling journal custody; inherited by every successor and kept after release. */
    journalPath?: string;
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
interface TelegramLockAcquireOptions {
    force?: boolean;
    expectedOwner?: TelegramLockEntry;
    election?: boolean;
    /** Bus-proven unresponsive owner: treated as stale only while it is still exactly the current owner. */
    unresponsiveOwner?: TelegramLockEntry;
}
type TelegramLockAcquireResult = {
    ok: true;
    lock: TelegramLockEntry;
    replacedStale: boolean;
} | {
    ok: false;
    lock: TelegramLockEntry;
};
export type TelegramOwnedStatePublicationResult<T> = {
    committed: false;
} | {
    committed: true;
    result: T;
};
export interface TelegramLockRuntime<TContext extends TelegramLockContext> {
    acquire: (ctx: TContext, options?: TelegramLockAcquireOptions) => TelegramLockAcquireResult;
    release: () => TelegramLockState;
    getState: () => TelegramLockState;
    getStatusLabel: () => string;
    getOwnedLeaderEpoch: () => number | string | undefined;
    owns: (ctx?: TelegramLockContext) => boolean;
    commitIfOwned: (commit: () => void) => boolean;
    /** Consolidated-store publication; domain reducers retain their own exact payload/CAS rules. */
    publishStateSectionIfOwned?: <T>(section: "workspace" | "runtime", mutate: TelegramRuntimeStateSectionReducer<T>, options: TelegramOwnedStatePublicationOptions) => TelegramOwnedStatePublicationResult<T>;
    refresh: (ctx?: TelegramLockContext) => boolean;
    /** The polling journal named by owners.json for this key, owned or not. */
    getJournalPath: () => string | undefined;
}
interface TelegramLockOwnershipGuard<TContext extends TelegramLockContext> {
    ownsContext: (ctx: TContext) => boolean;
}
interface TelegramLockContextStore<TContext extends TelegramLockContext> {
    get: () => TContext | undefined;
}
interface TelegramLockRuntimeOptions {
    key?: string | (() => string | undefined);
    locksPath?: string;
    /** Consolidated version-2 state envelope; exclusive with `locksPath`. */
    statePath?: string;
    statePublication?: Pick<TelegramRuntimeStatePublicationOptions, "onPublicationBoundary" | "publishRename">;
    /** Read-only ownership file of releases that used another directory; a live fresh owner there blocks acquisition. */
    legacyLocksPath?: string;
    pid?: number;
    isProcessAlive?: (pid: number) => boolean;
    instanceId?: string;
    busSocketPath?: string;
    busSecret?: string;
    getNowMs?: () => number;
    mintLeaderEpoch?: () => number | string;
    runtimeGeneration?: number;
    staleHeartbeatMs?: number;
    /** First leader without an inherited pointer names the polling journal it creates. */
    createJournalPath?: (ctx: TelegramLockContext) => string | undefined;
}
/**
 * Leader polling journal: the path owners.json names, else the session that would host it on acquisition.
 * Without a session identity, the flat root `inbox` remains the compatibility fallback.
 */
export declare function createTelegramLeaderJournalPathResolver(deps: {
    getNamedJournalPath: () => string | undefined;
    getSessionId: () => string | undefined;
    getProfileName: () => string | undefined;
}): {
    createJournalPath: () => string | undefined;
    resolve(profileName?: string): string;
};
/** A released key keeps only `{ journalPath }`: no owner, but the successor's polling custody. */
export declare function readTelegramLockJournalPath(value: unknown): string | undefined;
export declare function readLocks(path?: string): Record<string, unknown>;
interface TelegramRenameRetryOptions {
    rename?: typeof renameSync;
    attempts?: number;
    retryDelayMs?: number;
}
export type TelegramPrivateFileFailure = "capacity" | "unsafe" | "changed";
/** Typed private-file refusal; owners map the failure into their own error vocabulary. */
export declare class TelegramPrivateFileError extends Error {
    readonly failure: TelegramPrivateFileFailure;
    constructor(failure: TelegramPrivateFileFailure, message: string);
}
/**
 * Read flags for private runtime files. Where the platform offers them, no-follow and non-blocking opens refuse a
 * swapped link or FIFO at open time. Windows has neither flag and no FIFOs in the file namespace; there the
 * lstat-before/fstat-after identity binding every strict reader performs is the guard, so a link swapped in after
 * inspection opens a different file and is refused as changed.
 */
export declare const TELEGRAM_STRICT_READ_FLAGS: number;
/** POSIX owner and permission bits; Windows has no uid, so its ACL-protected agent directory carries privacy. */
export declare function isTelegramOwnerPrivate(stat: {
    uid: bigint;
    mode: bigint;
}): boolean;
/**
 * Read one owner-private, single-link, bounded regular file without following links. Absence returns undefined;
 * an inode or metadata change between inspection and open refuses as `changed`.
 */
export declare function readTelegramPrivateFile(path: string, maxBytes: number): string | undefined;
/** Atomically publish owner-private contents through a unique staging file; the rename consumes staging. */
export declare function publishTelegramPrivateFile(path: string, temporaryBasePath: string, contents: string, label: string, onBoundary?: (boundary: "after-write-before-rename" | "after-rename") => void): void;
/** Rename one Telegram runtime artifact with bounded Windows sharing retries. */
export declare function renameTelegramPathWithRetry(sourcePath: string, destinationPath: string, options?: TelegramRenameRetryOptions): boolean;
export interface TelegramFileTransactionOptions {
    recoveryRename?: typeof renameSync;
    publishRename?: typeof renameSync;
    attempts?: number;
    retryDelayMs?: number;
}
export declare function withTelegramFileTransaction<T>(transactionPath: string, operation: () => T, options?: TelegramFileTransactionOptions): T;
export type TelegramRuntimeStateSection = "transport" | "workspace" | "admission" | "runtime";
type TelegramRuntimeStateProfile = Partial<Record<TelegramRuntimeStateSection, unknown>>;
interface TelegramRuntimeStateFile {
    version: 2;
    profiles: Record<string, TelegramRuntimeStateProfile>;
}
export declare class TelegramRuntimeStateError extends Error {
    readonly code: "invalid" | "authority-changed" | "publication-unknown";
    constructor(code: TelegramRuntimeStateError["code"], message: string, options?: ErrorOptions);
}
/** Strict, observational envelope read; section owners validate their own payloads. Legacy state is never adopted here. */
export declare function readTelegramRuntimeState(path: string): TelegramRuntimeStateFile;
/**
 * Operator-approved optimistic recovery before leader acquisition: when the shared envelope, any transport section or a
 * caller-validated section is damaged, publish a fresh empty envelope instead of refusing. All profiles lose runtime
 * continuity. Filesystem access errors are not damage and still throw. Returns whether a reset was published.
 */
export declare function resetDamagedTelegramRuntimeState(path: string, validateProfile?: (profile: string, sections: Readonly<TelegramRuntimeStateProfile>) => void): boolean;
/** Pure section reducer: receives the stored section and its profile, returns the next section and result. */
export type TelegramRuntimeStateSectionReducer<T> = (current: unknown, observed: Readonly<TelegramRuntimeStateProfile>) => TelegramRuntimeStateMutation<T>;
export interface TelegramRuntimeStateMutation<T> {
    value: unknown;
    result: T;
}
interface TelegramRuntimeStatePublicationOptions {
    /** Exact domain authority, recaptured by the caller before invoking this synchronous transaction. */
    isCurrent: () => boolean;
    onPublicationBoundary?: (boundary: "before-write" | "after-write-before-rename" | "after-rename") => void;
    publishRename?: typeof renameSync;
}
export interface TelegramOwnedStatePublicationOptions extends TelegramRuntimeStatePublicationOptions {
    /** Optional caller-bound physical/logical identity; a mismatch cannot redirect an owner grant. */
    expectedScope?: {
        path: string;
        profile: string;
    };
}
/**
 * One physical read/check/write transaction for one named section. The caller supplies domain policy; copies expose
 * current sibling facts without granting writes to them. No await, nested transaction, repair or legacy import.
 */
export declare function mutateTelegramRuntimeStateSection<T>(path: string, profile: string, section: TelegramRuntimeStateSection, mutate: TelegramRuntimeStateSectionReducer<T>, options: TelegramRuntimeStatePublicationOptions): T;
export declare function writeLocks(path: string, locks: Record<string, unknown>): void;
export declare function parseTelegramLockEntry(value: unknown): TelegramLockEntry | undefined;
/** Exact owner identity (pid, cwd, instance, leader epoch, runtime generation); absent entries never match. */
export declare function isSameTelegramLockOwner(current: TelegramLockEntry | undefined, expected: TelegramLockEntry | undefined): boolean;
export declare function createTelegramLockRuntime<TContext extends TelegramLockContext>(options?: TelegramLockRuntimeOptions): TelegramLockRuntime<TContext>;
export declare function createTelegramLockOwnershipGuard<TContext extends TelegramLockContext>(lock: TelegramLockRuntime<TContext>): TelegramLockOwnershipGuard<TContext>;
export declare function createTelegramDirectDeliveryOwnershipChecker<TContext extends TelegramLockContext>(deps: {
    lock: TelegramLockRuntime<TContext>;
    contextStore: TelegramLockContextStore<TContext>;
}): () => boolean;
interface TelegramLockedPollingStartOptions {
    force?: boolean;
    forceFreshLeaderThread?: boolean;
    requestedThreadName?: string;
    election?: {
        expectedOwner?: TelegramLockEntry;
        unresponsive?: boolean;
    };
    onAcquired?: () => Promise<void> | void;
}
type TelegramLockedPollingStartResult = {
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
    /** Capture one disconnect attempt before cleanup awaits; a newer start revokes it. */
    captureStop: () => {
        isCurrent: () => boolean;
        stop: () => Promise<string>;
    };
    suspend: () => Promise<void>;
    isSuspended: () => boolean;
    /** Fence one owned polling generation; suspension, restart, conflict or lock loss revokes it. */
    captureTransportAuthority: (ctx: TContext) => (() => boolean) | undefined;
    onPersistentConflict: (ctx: TContext, count: number) => Promise<void>;
    onSessionStart: (_event: unknown, ctx: TContext) => Promise<void>;
    registerFollowerWithOwner?: (ctx: TContext, owner: TelegramLockEntry) => boolean | undefined | Promise<boolean | undefined>;
    restoreFollowerWithOwner?: (ctx: TContext, owner: TelegramLockEntry) => boolean | undefined | Promise<boolean | undefined>;
    stopFollowerRegistration?: () => void;
}
interface TelegramLockedPollingRuntimeDeps<TContext extends TelegramLockContext> {
    lock: TelegramLockRuntime<TContext>;
    /** Optimistically replaces a damaged shared runtime state before a non-election acquisition. */
    resetDamagedState?: () => boolean;
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
    /** Threaded Mode takeover evidence after failed follower registration; replaces the retired file heartbeat. */
    proveOwnerUnresponsive?: (owner: TelegramLockEntry) => Promise<boolean>;
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
export {};
