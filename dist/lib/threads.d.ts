/**
 * Telegram thread binding helpers
 * Zones: multi-instance bus, Telegram UI threads, volatile extension state
 * Owns current live instance-binding to Telegram UI thread mappings backed by Bot API ForumTopic/message_thread_id transport
 */
import { type TelegramApiCallOptions } from "./telegram-api.ts";
import type { TelegramTarget } from "./target.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
import { type TelegramWorkspaceSlotOccupancy } from "./workspace-slots.ts";
export interface TelegramThreadNameInput {
    seed: string;
    cwd?: string;
    role?: "leader" | "follower";
    peers?: readonly string[];
    slot?: string;
}
export interface TelegramWorkspaceBindingIdentity {
    cwd: string;
    workspaceKey: string;
    /** Exact durable Pi session identity; absent only on legacy cwd-only bindings. */
    sessionId?: string;
    /** Full SHA-256 index component for session-qualified bindings. */
    sessionKey?: string;
    /** Immutable legacy binding-key component, not the displayed global letter. */
    instanceSlot: string;
    bindingKey: string;
    /** Profile-wide letter reserved by the transient claim. */
    slot?: string;
}
export declare function normalizeTelegramSessionId(sessionId: string): string | undefined;
export declare function createTelegramSessionKey(sessionId: string): string | undefined;
export declare function normalizeTelegramWorkspacePath(cwd: string): string | undefined;
export declare function createTelegramWorkspaceDirectoryKey(cwd: string): string | undefined;
export declare function createTelegramWorkspaceBindingIdentity(cwd: string, ordinal?: number, sessionId?: string): TelegramWorkspaceBindingIdentity | undefined;
export type TelegramTopicTargetStatus = "active" | "offline" | "stale" | "pending" | "starting" | "probe-required" | "failed";
export type TelegramTopicSyncStatus = "open" | "closed" | "deleted" | "unknown";
export type TelegramThreadOwner = {
    kind: "leader";
    cwd?: string;
    instanceId?: string;
    telegramProfile?: string;
} | {
    kind: "manual-follower";
    instanceId: string;
    telegramProfile?: string;
} | {
    kind: "pending-topic";
    chatId: number;
    threadId: number;
} | {
    kind: "legacy";
    key: string;
};
export interface TelegramThreadReservation {
    target: TelegramTarget & {
        threadId: number;
    };
    slot: string;
    reason: string;
    createdAtMs: number;
    updatedAtMs: number;
    expiresAtMs?: number;
    instanceId?: string;
    lastReconcileAction?: string;
}
export interface TelegramThreadPendingProvision {
    id: string;
    owner: "leader" | "manual-follower";
    instanceId: string;
    profileKey?: string;
    status?: "in-flight" | "ambiguous";
    threadName?: string;
    displayTitle?: string;
    slot?: string;
    target?: TelegramTarget & {
        threadId: number;
    };
    startedAtMs: number;
    expiresAtMs?: number;
    leaderEpoch?: number | string;
}
export type TelegramThreadCleanupIntent = ThreadReconciler.TelegramThreadCleanupIntent;
export interface TelegramTopicSyncObservation {
    target: TelegramTarget & {
        threadId: number;
    };
    syncStatus: TelegramTopicSyncStatus;
    observedAtMs: number;
    instanceId?: string;
    slot?: string;
    lastSyncError?: string;
    lastReconcileAction?: string;
}
export interface TelegramTopicTargetRecord {
    /** Legacy string key derived from `owner`; always present in memory, never persisted. */
    profileKey: string;
    owner?: TelegramThreadOwner;
    target: TelegramTarget & {
        threadId: number;
    };
    status: TelegramTopicTargetStatus;
    createdAtMs: number;
    updatedAtMs: number;
    threadName?: string;
    /** Explicit per-Workspace display override set by the operator. */
    manualThreadName?: string;
    instanceId?: string;
    slot?: string;
    lastError?: string;
    syncStatus?: TelegramTopicSyncStatus;
    lastSyncObservedAtMs?: number;
    lastSyncProbeAtMs?: number;
    lastSyncError?: string;
    lastReconcileAction?: string;
    rerouteConfirmedAtMs?: number;
}
export interface TelegramThreadIdentityRecord {
    profileKey: string;
    threadName?: string;
    slot?: string;
    updatedAtMs: number;
}
export interface TelegramWorkspaceThreadBinding {
    cwd: string;
    workspaceKey: string;
    /** Exact durable Pi session identity; absent only on legacy cwd-only bindings. */
    sessionId?: string;
    /** Full SHA-256 index component for session-qualified bindings. */
    sessionKey?: string;
    instanceSlot: string;
    bindingKey: string;
    target: TelegramTarget & {
        threadId: number;
    };
    /** Stable generated identity retained for compatibility and recovery. */
    threadName?: string;
    /** Explicit display override; absence selects the profile's automatic mode. */
    manualThreadName?: string;
    slot?: string;
    /** Last title acknowledged by Telegram; never replaces the stable name. */
    displayTitle?: string;
    /** Historical follower-journal routing keys that may retain accepted work. */
    journalBindingKeys?: string[];
    /** True only when the historical journal-key set is proven complete. */
    journalBindingsComplete?: true;
    /** Sticky once this directory has multiple retained bindings. */
    showSlotSuffix?: boolean;
    /** First continuously proven no-owner transition; absent means active or unproven. */
    inactiveSinceMs?: number;
    updatedAtMs: number;
}
export type TelegramWorkspaceDisplayBinding = Pick<TelegramWorkspaceThreadBinding, "bindingKey" | "cwd" | "slot" | "threadName" | "manualThreadName" | "showSlotSuffix">;
export interface TelegramWorkspaceRetirementIntent {
    id: string;
    reason: "pressure";
    profileKey: string;
    binding: TelegramWorkspaceThreadBinding;
    leaderEpoch: number | string;
    requestedAtMs: number;
}
export type TelegramWorkspaceProtectionState = "clear" | "protected" | "unknown";
export interface TelegramWorkspaceExternalProtectionEvidence {
    liveOwner: TelegramWorkspaceProtectionState;
    acceptedWork: TelegramWorkspaceProtectionState;
    deliveryAuthority: TelegramWorkspaceProtectionState;
}
export interface TelegramWorkspaceSlotOccupancySnapshot {
    bindings: TelegramWorkspaceSlotOccupancy[];
    reservedSlots: string[];
}
export type TelegramBotThreadMode = "unknown" | "enabled" | "disabled";
export interface TelegramBotStateSnapshot {
    threadMode: TelegramBotThreadMode;
    updatedAtMs?: number;
    lastSlot?: string;
    lastReconcileAction?: string;
}
export interface TelegramSessionReplacementIntent {
    continuity: "workspace-thread" | "classic-chat";
    cwd: string;
    profileName: string;
    sourceSessionId: string;
    sourceUpdateId: number;
    target: TelegramTarget;
    messageId: number;
    slot?: string;
    threadName?: string;
    createdAtMs: number;
    expiresAtMs: number;
}
export interface TelegramTopicTargetFile {
    version: 1;
    source: "snapshot";
    writtenAtMs: number;
    bot: TelegramBotStateSnapshot;
    runtime?: Record<string, unknown>;
    liveRoster?: Record<string, unknown>;
    diagnostics?: Record<string, unknown>;
    threads: TelegramTopicTargetRecord[];
    identities?: TelegramThreadIdentityRecord[];
    workspaceBindings?: TelegramWorkspaceThreadBinding[];
    workspaceRetirements?: TelegramWorkspaceRetirementIntent[];
    sessionReplacement?: TelegramSessionReplacementIntent;
    reservations?: TelegramThreadReservation[];
    pendingProvisions?: TelegramThreadPendingProvision[];
    pendingCleanups?: TelegramThreadCleanupIntent[];
    syncObservations?: TelegramTopicSyncObservation[];
}
export interface TelegramTopicTargetStore {
    load: () => Promise<void>;
    /** Discard process-local projections and reload owner-published state. */
    refresh?: () => Promise<void>;
    persist: () => Promise<void>;
    invalidateTarget: (target: TelegramTarget, isCurrent: () => boolean, lastSyncError: string) => Promise<boolean>;
    /** Caller proves owner detachment; this does not assert Telegram Thread absence. */
    detachTargetOwner: (expected: TelegramTopicTargetRecord, isCurrent: () => boolean) => Promise<boolean>;
    list: () => TelegramTopicTargetRecord[];
    getFollowerRecoveryHintByTarget?: (target: TelegramTarget) => {
        slot?: string;
        threadName?: string;
    } | undefined;
    listReservations: () => TelegramThreadReservation[];
    listPendingProvisions: () => TelegramThreadPendingProvision[];
    listPendingCleanups: () => TelegramThreadCleanupIntent[];
    listSyncObservations: () => TelegramTopicSyncObservation[];
    reserveThread: (reservation: TelegramThreadReservation) => void;
    upsertPendingProvision: (provision: TelegramThreadPendingProvision) => void;
    recordPendingProvisionTargetRecovery: (provision: TelegramThreadPendingProvision, target: TelegramTarget & {
        threadId: number;
    }) => Promise<boolean>;
    removePendingProvision: (id: string) => boolean;
    upsertPendingCleanup: (intent: TelegramThreadCleanupIntent) => void;
    removePendingCleanup: (id: string) => boolean;
    getBotState: () => TelegramBotStateSnapshot;
    setBotState: (state: Partial<TelegramBotStateSnapshot>) => void;
    setStatusSnapshot: (snapshot: {
        runtime?: Record<string, unknown>;
        liveRoster?: Record<string, unknown>;
        diagnostics?: Record<string, unknown>;
    }) => void;
    getByProfileKey: (profileKey: string) => TelegramTopicTargetRecord | undefined;
    getActiveByInstanceId: (instanceId: string) => TelegramTopicTargetRecord | undefined;
    getIdentityByProfileKey: (profileKey: string) => TelegramThreadIdentityRecord | undefined;
    forgetIdentityByProfileKey: (profileKey: string) => boolean;
    listWorkspaceBindings: () => TelegramWorkspaceThreadBinding[];
    getWorkspaceBindingByTarget: (target: TelegramTarget, sessionId?: string) => TelegramWorkspaceThreadBinding | undefined;
    getSessionReplacementIntent: () => TelegramSessionReplacementIntent | undefined;
    commitSessionReplacementIntent: (intent: TelegramSessionReplacementIntent, isCurrent: () => boolean) => Promise<boolean>;
    removeSessionReplacementIntent: (expected: TelegramSessionReplacementIntent, isCurrent: () => boolean) => Promise<boolean>;
    listWorkspaceRetirementIntents: () => TelegramWorkspaceRetirementIntent[];
    commitWorkspaceJournalEvidence: (expected: TelegramWorkspaceThreadBinding, journalBindingKeys: readonly string[], complete: boolean) => TelegramWorkspaceThreadBinding | undefined;
    upsertWorkspaceRetirementIntent: (intent: TelegramWorkspaceRetirementIntent) => boolean;
    removeWorkspaceRetirementIntent: (expected: TelegramWorkspaceRetirementIntent) => boolean;
    replaceWorkspaceRetirementIntent: (expected: TelegramWorkspaceRetirementIntent, replacement: TelegramWorkspaceRetirementIntent, isCurrent: () => boolean) => Promise<boolean>;
    commitWorkspaceRetirement: (expected: TelegramWorkspaceRetirementIntent, isCurrent: () => boolean) => Promise<boolean>;
    commitInactiveWorkspaceCleanup: (expected: TelegramWorkspaceThreadBinding | {
        cwd: string;
        workspaceKey: string;
        sessionId?: string;
        sessionKey?: string;
        instanceSlot: string;
        slot: string;
        bindingKey: string;
        target: {
            chatId: number;
            threadId: number;
        };
        inactiveSinceMs: number;
        bindingUpdatedAtMs: number;
    }, isCurrent: () => boolean) => Promise<boolean>;
    /** Caller must separately prove no external live owner, accepted work, or delivery authority. */
    captureWorkspaceSlotOccupancy: (getExternalProtection: (binding: TelegramWorkspaceThreadBinding) => TelegramWorkspaceExternalProtectionEvidence, options?: {
        expectedRetirement?: TelegramWorkspaceRetirementIntent;
    }) => TelegramWorkspaceSlotOccupancySnapshot;
    hasWorkspaceBinding: (cwd: string, sessionId?: string) => boolean;
    setWorkspaceDisplayTitle: (expected: TelegramWorkspaceThreadBinding, title: string) => boolean;
    markWorkspaceBindingInactiveByTarget: (target: TelegramTarget, inactiveSinceMs?: number) => boolean;
    markWorkspaceBindingActiveByTarget: (target: TelegramTarget) => boolean;
    getWorkspaceBinding: (cwd: string, instanceSlot?: string, sessionId?: string) => TelegramWorkspaceThreadBinding | undefined;
    claimWorkspaceIdentity: (cwd: string, instanceId: string, previousInstanceId?: string, options?: {
        existingBindingOnly?: boolean;
        sessionId?: string;
        onCapacityUnavailable?: () => void;
    }) => TelegramWorkspaceBindingIdentity | undefined;
    releaseWorkspaceClaim: (instanceId: string) => boolean;
    upsertWorkspaceBinding: (binding: TelegramWorkspaceThreadBinding, claimInstanceId?: string) => TelegramWorkspaceThreadBinding | undefined;
    upsert: (record: TelegramTopicTargetRecord) => TelegramTopicTargetRecord;
    markOfflineByInstanceId: (instanceId: string) => number;
    markStaleByTarget: (target: TelegramTarget, syncStatus?: TelegramTopicSyncStatus, lastSyncError?: string) => boolean;
    markActiveByTarget: (target: TelegramTarget) => boolean;
    renameByTarget: (target: TelegramTarget, threadName: string, options?: {
        updateDisplayTitle: boolean;
    }) => TelegramTopicTargetRecord | undefined;
    clearManualNameByTarget: (target: TelegramTarget, automaticTitle: string) => TelegramTopicTargetRecord | undefined;
    allocateSlot: (profileKey: string, preferredSlot?: string, workspaceBindingKey?: string, options?: {
        excludeCurrentRecord?: boolean;
    }) => string | undefined;
    /** Claim the first reusable inactive thread for an instance, linking it to instanceId. */
    claimReusableTarget: (instanceId: string, threadName?: string) => TelegramTopicTargetRecord | undefined;
}
export declare function reconcileTelegramFreshAllocationCursor(store: Pick<TelegramTopicTargetStore, "getBotState" | "list" | "setBotState">, nowMs?: number): boolean;
export declare function createTelegramCleanupTargetProtection(store: Pick<TelegramTopicTargetStore, "list"> & Partial<Pick<TelegramTopicTargetStore, "listReservations" | "listPendingProvisions" | "listPendingCleanups">>, departingRecord?: TelegramTopicTargetRecord): NonNullable<ThreadReconciler.ThreadReconciliationApplyPorts["isCleanupTargetProtected"]>;
export interface TelegramTopicTargetStoreOptions {
    path: string | (() => string);
    telegramProfile?: string | (() => string | undefined);
    getNowMs?: () => number;
    canPersist?: () => boolean;
    commitPersist?: (commit: () => void) => boolean;
    getExternalReservedSlots?: () => readonly string[];
}
export interface TelegramTopicTargetProvisionerDeps {
    topicChatId: number;
    store: Pick<TelegramTopicTargetStore, "list" | "getByProfileKey" | "getActiveByInstanceId" | "getIdentityByProfileKey" | "forgetIdentityByProfileKey" | "upsert" | "markStaleByTarget" | "allocateSlot" | "claimReusableTarget" | "listWorkspaceBindings" | "listPendingProvisions" | "upsertPendingProvision" | "recordPendingProvisionTargetRecovery" | "removePendingProvision" | "listSyncObservations" | "listPendingCleanups" | "persist">;
    callApi: <TResponse>(method: string, body: Record<string, unknown>, options?: TelegramApiCallOptions) => Promise<TResponse>;
    topicNameTemplate?: string;
    resolveInitialWorkspaceDisplayTitle?: (binding: TelegramWorkspaceDisplayBinding) => string | undefined;
    getNowMs?: () => number;
    getRandom?: () => number;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    claimPendingTargets?: boolean;
}
export interface TelegramTopicTargetRenamerDeps {
    store: Pick<TelegramTopicTargetStore, "renameByTarget" | "list" | "listWorkspaceBindings" | "listPendingProvisions">;
    callApi: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
    assertAuthority?: () => void;
    shouldRenameDisplayedTitle?: () => boolean;
    topicNameTemplate?: string;
}
export interface TelegramTopicTargetProvisionRequest {
    instanceId: string;
    owner?: TelegramThreadOwner;
    /** Legacy string key derived from `owner`; always present in memory. */
    profileKey: string;
    threadName?: string;
    preferredSlot?: string;
    workspaceBindingKey?: string;
    workspaceCwd?: string;
}
/** Pending creation evidence cannot bypass an exact target's unresolved cleanup or closure. */
export declare function assertTelegramPendingTopicRecoveryAllowed(store: Pick<TelegramTopicTargetStore, "listPendingProvisions" | "listPendingCleanups" | "listSyncObservations">, target: TelegramTarget): void;
/** Settle creation-title evidence with the exact Workspace claim; caller fences and persists. */
export declare function commitTelegramWorkspaceProvisionBinding(input: {
    store: Pick<TelegramTopicTargetStore, "upsertWorkspaceBinding" | "setWorkspaceDisplayTitle" | "listPendingProvisions" | "removePendingProvision" | "listPendingCleanups" | "listSyncObservations">;
    binding: TelegramWorkspaceThreadBinding;
    instanceId: string;
    profileKey: string;
    displayTitle?: string;
}): TelegramWorkspaceThreadBinding;
export interface TelegramTopicTargetRenameRequest {
    target: TelegramTarget & {
        threadId: number;
    };
    threadName: string;
    slot?: string;
}
export interface TelegramTopicTargetProvisionResult {
    target: TelegramTarget & {
        threadId: number;
    };
    reused: boolean;
    record: TelegramTopicTargetRecord;
    displayTitle?: string;
}
export declare function createTelegramThreadName(input: TelegramThreadNameInput): string;
export declare function getTelegramStatePath(agentDir?: string, profileName?: string): string;
export declare function getTelegramTopicTargetsPath(agentDir?: string, profileName?: string): string;
export declare const TELEGRAM_LEADER_SESSION_HANDOFF_TTL_MS = 30000;
export interface TelegramLeaderSessionHandoff {
    pid: number;
    instanceId: string;
    createdAtMs: number;
    profileKey: string;
    target: TelegramTarget & {
        threadId: number;
    };
    slot?: string;
    threadName?: string;
}
export declare function getTelegramLeaderSessionHandoff(): TelegramLeaderSessionHandoff | undefined;
export declare function setTelegramLeaderSessionHandoff(handoff: TelegramLeaderSessionHandoff | undefined): void;
export declare function isTelegramLeaderSessionHandoffFresh(handoff: TelegramLeaderSessionHandoff | undefined, options?: {
    pid?: number;
    nowMs?: number;
    ttlMs?: number;
}): handoff is TelegramLeaderSessionHandoff;
export declare function getTelegramThreadOwnerKey(owner: TelegramThreadOwner): string;
export declare function getTelegramThreadOwnerFromProfileKey(profileKey: string): TelegramThreadOwner;
export declare function isSameTelegramProcessInstance(left: string | undefined, right: string | undefined): boolean;
export declare function createTelegramTopicTargetStore(options: TelegramTopicTargetStoreOptions): TelegramTopicTargetStore;
export declare function normalizeTelegramTopicTargetThreadName(threadName: string): string;
export declare function getTelegramTopicIdentityName(threadName: string): string;
export declare function listOccupiedTelegramThreadIdentities(input: {
    records: readonly TelegramTopicTargetRecord[];
    workspaceBindings?: readonly TelegramWorkspaceThreadBinding[];
    pendingProvisions?: readonly TelegramThreadPendingProvision[];
    exceptTarget?: TelegramTarget;
    exceptWorkspaceBindingKey?: string;
}): string[];
export declare function chooseTelegramThreadName(input: {
    slot: string | undefined;
    entropy?: number | string;
    getRandom?: () => number;
    occupied?: readonly string[];
}): string | undefined;
export declare function getTelegramTopicThreadNameValidationError(threadName: string, _slot: string | undefined): string | undefined;
export declare function getTelegramManualThreadDisplayNameValidationError(threadName: string): string | undefined;
export declare function isTelegramTopicThreadNameValidForSlot(threadName: string, slot: string | undefined): boolean;
export declare function getTelegramTopicName(request: TelegramTopicTargetProvisionRequest, template?: string, slot?: string): string;
export interface TelegramPromoteFollowerBindingToLeaderDeps {
    store: TelegramTopicTargetStore;
    instanceId: string;
    cwd?: string;
    sessionId?: string;
    telegramProfile?: string;
    target?: TelegramTarget;
    slot?: string;
    threadName?: string;
    nowMs?: number;
}
export declare function promoteTelegramFollowerBindingToLeader(deps: TelegramPromoteFollowerBindingToLeaderDeps): Promise<TelegramTopicTargetRecord | undefined>;
export interface TelegramOwnTopicProvisionDeps {
    getAllowedUserId: () => number | undefined;
    instanceId: string;
    cwd?: string;
    telegramProfile?: string;
    requestedThreadName?: string;
    preferredSlot?: string;
    workspaceBindingKey?: string;
    resolveInitialWorkspaceDisplayTitle?: (binding: TelegramWorkspaceDisplayBinding) => string | undefined;
    getNowMs?: () => number;
    getRandom?: () => number;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    getThreadReconciliationMachineState?: () => ThreadReconciler.ThreadReconciliationMachineState | undefined;
    recordThreadReconciliationPlan?: (plan: ThreadReconciler.ThreadReconciliationPlan) => void;
    store: TelegramTopicTargetStore;
    callApi: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
    recordEvent: (category: string, message: string, details?: Record<string, unknown>) => void;
}
export interface TelegramOwnTopicProvisionResult {
    target: TelegramTarget & {
        threadId: number;
    };
    slot: string;
    threadName?: string;
    displayTitle?: string;
    reused: boolean;
}
/**
 * Provision a topic for the bus leader's own use (slot A).
 * This is a thread-binding primitive; sync policy decides when startup/connect
 * should call it to ensure the leader has a visible working thread.
 */
export declare function provisionOwnBusTopic(deps: TelegramOwnTopicProvisionDeps): Promise<TelegramOwnTopicProvisionResult | undefined>;
export interface TelegramInstanceThreadIdentityCandidate {
    target?: TelegramTarget;
    slot?: string;
    threadName?: string;
}
export declare function resolveTelegramInstanceThreadIdentity(options: {
    target?: TelegramTarget;
    follower?: TelegramInstanceThreadIdentityCandidate;
    leader?: TelegramInstanceThreadIdentityCandidate;
    record?: TelegramTopicTargetRecord;
}): TelegramInstanceThreadIdentityCandidate;
export interface TelegramLeaderThreadStateRuntime {
    getTarget(): TelegramTarget | undefined;
    getIdentity(): TelegramInstanceThreadIdentityCandidate | undefined;
    set(input: TelegramInstanceThreadIdentityCandidate & {
        target: TelegramTarget;
    }): void;
    clear(): void;
}
export declare function createTelegramLeaderThreadStateRuntime(): TelegramLeaderThreadStateRuntime;
export interface TelegramCurrentInstanceThreadRuntime {
    findRecord(): TelegramTopicTargetRecord | undefined;
    getRecord(): TelegramTopicTargetRecord | undefined;
    getIdentity(target?: TelegramTarget): TelegramInstanceThreadIdentityCandidate;
    getRestorationIdentity(): TelegramInstanceThreadIdentityCandidate;
}
export interface TelegramCurrentInstanceThreadRuntimeDeps {
    instanceId: string;
    listRecords(): readonly TelegramTopicTargetRecord[];
    getPreferredTarget(): TelegramTarget | undefined;
    getFollower(): (TelegramInstanceThreadIdentityCandidate & {
        registered: boolean;
    }) | undefined;
    getLeader(): TelegramInstanceThreadIdentityCandidate | undefined;
}
export declare function createTelegramCurrentInstanceThreadRuntime(deps: TelegramCurrentInstanceThreadRuntimeDeps): TelegramCurrentInstanceThreadRuntime;
export declare function findCurrentTelegramInstanceThreadRecord(options: {
    records: readonly TelegramTopicTargetRecord[];
    instanceId: string;
    preferredTarget?: TelegramTarget;
}): TelegramTopicTargetRecord | undefined;
export declare function resolveTelegramInstanceThreadTarget(options: {
    followerTarget?: TelegramTarget;
    leaderTarget?: TelegramTarget;
    currentRecord?: TelegramTopicTargetRecord;
}): (TelegramTarget & {
    threadId: number;
}) | undefined;
export interface TelegramThreadStatusProjectionRuntime {
    getBusRole(): "leader" | "follower" | undefined;
    getBusFollowers(): ReturnType<typeof listTelegramThreadStatusFollowers>;
    getLocalBus(): {
        leaderSocketPath: string;
        leaderTransport: "socket" | "pipe";
        followerSocketPath: string;
        followerTransport: "socket" | "pipe";
        followerRegistered: boolean;
        followerTarget?: TelegramTarget;
        followerSlot?: string;
        followerThreadName?: string;
        leaderProtocol?: {
            protocolVersion: number;
            runtimeBuild: string;
            capabilities: string[];
        };
    };
    getTopicTargets(): ReturnType<typeof listTelegramThreadStatusTargets>;
    getThreadReservations(): ReturnType<typeof listTelegramThreadStatusReservations>;
    getTopicSyncObservations(): ReturnType<typeof listTelegramThreadStatusObservations>;
    getInstanceSlot(): string | undefined;
    getInstanceThreadName(): string | undefined;
}
export interface TelegramThreadStatusProjectionRuntimeDeps {
    getThreadMode(): "unknown" | "enabled" | "disabled";
    isBusPollingStarted(): boolean;
    isFollowerRegistered(): boolean;
    listFollowers(): readonly TelegramThreadStatusFollowerView[];
    listRecords(): readonly TelegramTopicTargetRecord[];
    listReservations(): readonly TelegramThreadReservation[];
    listSyncObservations(): readonly TelegramTopicSyncObservation[];
    getLeaderSocketPath(): string;
    getFollowerSocketPath(): string;
    getTransportKind(path: string): "socket" | "pipe";
    getFollowerTarget(): TelegramTarget | undefined;
    getFollowerSlot(): string | undefined;
    getFollowerThreadName(): string | undefined;
    getLeaderProtocol?(): {
        protocolVersion: number;
        runtimeBuild: string;
        capabilities: string[];
    } | undefined;
    getCurrentIdentity(): TelegramInstanceThreadIdentityCandidate;
    getDisplayTitle?: (target: TelegramTarget) => string | undefined;
}
export declare function createTelegramThreadStatusProjectionRuntime(deps: TelegramThreadStatusProjectionRuntimeDeps): TelegramThreadStatusProjectionRuntime;
export interface TelegramCurrentThreadAssemblyDeps {
    instanceId: string;
    listRecords: TelegramCurrentInstanceThreadRuntimeDeps["listRecords"];
    listWorkspaceBindings?: () => readonly TelegramWorkspaceThreadBinding[];
    getFollowerDisplayTitle?: () => string | undefined;
    getActiveTurnTarget(): TelegramTarget | undefined;
    getFollowerTarget(): TelegramTarget | undefined;
    isFollowerRegistered(): boolean;
    getFollowerSlot(): string | undefined;
    getFollowerThreadName(): string | undefined;
    getLeaderIdentity(): TelegramInstanceThreadIdentityCandidate | undefined;
    getLeaderTarget(): TelegramTarget | undefined;
    getLeaderProtocol?: TelegramThreadStatusProjectionRuntimeDeps["getLeaderProtocol"];
    status: Pick<TelegramThreadStatusProjectionRuntimeDeps, "getThreadMode" | "isBusPollingStarted" | "listFollowers" | "listReservations" | "listSyncObservations" | "getLeaderSocketPath" | "getFollowerSocketPath" | "getTransportKind">;
}
export interface TelegramCurrentThreadAssembly {
    getDisplayTitle: (target: TelegramTarget) => string | undefined;
    current: TelegramCurrentInstanceThreadRuntime;
    status: TelegramThreadStatusProjectionRuntime;
}
/** Own current-thread preference and its matching status projection. */
export declare function createTelegramCurrentThreadAssembly(deps: TelegramCurrentThreadAssemblyDeps): TelegramCurrentThreadAssembly;
export interface TelegramThreadStatusFollowerView {
    instanceId: string;
    cwd?: string;
    lastHeartbeatMs: number;
    target?: TelegramTarget;
    protocol?: {
        protocolVersion: number;
        runtimeBuild: string;
        capabilities: string[];
    };
}
export declare function listTelegramThreadStatusFollowers(options: {
    followers: readonly TelegramThreadStatusFollowerView[];
    records: readonly TelegramTopicTargetRecord[];
}): Array<{
    instanceId: string;
    cwd?: string;
    lastHeartbeatMs: number;
    target?: TelegramTarget;
    protocol?: {
        protocolVersion: number;
        runtimeBuild: string;
        capabilities: string[];
    };
    slot?: string;
    threadName?: string;
    status?: string;
}>;
export declare function listTelegramThreadStatusTargets(records: readonly TelegramTopicTargetRecord[]): Array<{
    instanceId?: string;
    status: TelegramTopicTargetStatus;
    target: TelegramTarget & {
        threadId: number;
    };
    slot?: string;
    threadName?: string;
    syncStatus?: TelegramTopicSyncStatus;
    lastSyncObservedAtMs?: number;
    lastSyncProbeAtMs?: number;
    lastSyncError?: string;
    lastReconcileAction?: string;
}>;
export declare function listTelegramThreadStatusReservations(reservations: readonly TelegramThreadReservation[]): Array<{
    target: TelegramTarget & {
        threadId: number;
    };
    slot: string;
    reason: string;
    instanceId?: string;
    expiresAtMs?: number;
    lastReconcileAction?: string;
}>;
export declare function listTelegramThreadStatusObservations(observations: readonly TelegramTopicSyncObservation[]): Array<{
    target: TelegramTarget & {
        threadId: number;
    };
    syncStatus: TelegramTopicSyncStatus;
    observedAtMs: number;
    instanceId?: string;
    slot?: string;
    lastSyncError?: string;
    lastReconcileAction?: string;
}>;
export declare function getTelegramTargetFromApiBody(body: unknown): (TelegramTarget & {
    threadId: number;
}) | undefined;
export declare function isTelegramTopicTargetStaleError(error: unknown): boolean;
export declare function isTelegramTopicModeUnavailableError(error: unknown): boolean;
export declare function getTelegramTopicTitleForThreadName(threadName: string, slot: string, template?: string): string;
export declare function createTelegramTopicTargetRenamer(deps: TelegramTopicTargetRenamerDeps): (request: TelegramTopicTargetRenameRequest) => Promise<TelegramTopicTargetRecord | undefined>;
export declare function createTelegramTopicTargetProvisioner(deps: TelegramTopicTargetProvisionerDeps): (request: TelegramTopicTargetProvisionRequest) => Promise<TelegramTopicTargetProvisionResult>;
