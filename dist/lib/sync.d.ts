/**
 * Telegram synchronization helpers
 * Zones: Telegram bot reality mirror, demand-driven reconciliation, status diagnostics
 * Owns pure contracts for deciding when local Telegram mirror state should be refreshed without querying Telegram on every action
 */
import { type TelegramTarget } from "./target.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
import { type TelegramWorkspaceAdmissionLedger } from "./workspace-admission.ts";
import { type TelegramOwnTopicProvisionResult, type TelegramTopicTargetStore, type TelegramWorkspaceDisplayBinding, type TelegramWorkspaceThreadBinding } from "./threads.ts";
export interface TelegramTopicLifecycleSyncUpdate<TMessage = unknown> {
    kind: "created" | "closed" | "reopened";
    target: TelegramTarget & {
        threadId: number;
    };
    message: TMessage;
}
export type TelegramSyncWorkspaceOperationRunner = <T>(input: {
    operationId: string;
    operationKind: string;
    scopes: readonly [{
        kind: "profile";
    }];
}, operation: () => Promise<T>) => Promise<T>;
export interface TelegramLeaderThreadSyncDeps {
    getAllowedUserId: () => number | undefined;
    instanceId: string;
    cwd?: string;
    sessionId?: string;
    telegramProfile?: string;
    forceFreshUnnamed?: boolean;
    requestedThreadName?: string;
    resolveInitialWorkspaceDisplayTitle?: (binding: TelegramWorkspaceDisplayBinding) => string | undefined;
    getNowMs?: () => number;
    getRandom?: () => number;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    getThreadReconciliationMachineState?: () => ThreadReconciler.ThreadReconciliationMachineState | undefined;
    recordThreadReconciliationPlan?: (plan: ThreadReconciler.ThreadReconciliationPlan) => void;
    topicTargetStore: TelegramTopicTargetStore;
    callApi: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
    probeWorkspaceBinding?: (binding: TelegramWorkspaceThreadBinding) => Promise<void>;
    recordEvent: (category: string, message: unknown, details?: Record<string, unknown>) => void;
}
export interface TelegramTopicLifecycleSyncDeps {
    topicTargetStore: Pick<TelegramTopicTargetStore, "load" | "list" | "listReservations" | "listPendingProvisions" | "markStaleByTarget" | "markActiveByTarget" | "removePendingProvision" | "persist">;
    isBusEnabled: () => boolean;
    callApi: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
    isTopicProvisioningActive?: () => boolean;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    getThreadReconciliationMachineState?: () => ThreadReconciler.ThreadReconciliationMachineState | undefined;
    recordThreadReconciliationPlan?: (plan: ThreadReconciler.ThreadReconciliationPlan) => void;
    assertExecutionCurrent?: (message: unknown) => void;
    recordEvent?: (category: string, message: unknown, details?: Record<string, unknown>) => void;
}
export type TelegramTopicLifecycleSyncHandler<TMessage = unknown> = (lifecycle: TelegramTopicLifecycleSyncUpdate<TMessage>) => Promise<void>;
export interface TelegramObservedTopicLifecycleSyncDeps<TSyncState> extends TelegramTopicLifecycleSyncDeps {
    runWorkspaceOperation: TelegramSyncWorkspaceOperationRunner;
    getSyncState: () => TSyncState;
    setSyncState: (state: TSyncState) => void;
    getNowMs?: () => number;
}
export interface TelegramLeaderHealthRuntimeDeps<TSyncState> {
    getNowMs?: () => number;
    intervalMs?: number;
    callGetMe: () => Promise<unknown>;
    getSyncState: () => TSyncState;
    setSyncState: (state: TSyncState) => void;
    recordEvent: (category: string, message: unknown, details?: Record<string, unknown>) => void;
}
export interface TelegramLeaderHealthRuntime {
    start: () => void;
    stop: () => void;
}
export interface TelegramManualThreadDisconnectDeps<TSyncState> {
    instanceId: string;
    getCurrentThreadRecord: () => {
        target: TelegramTarget;
        instanceId?: string;
        profileKey?: string;
        owner?: {
            kind?: string;
        };
    } | undefined;
    topicTargetStore: Pick<TelegramTopicTargetStore, "list" | "markStaleByTarget" | "persist" | "upsertPendingCleanup" | "removePendingCleanup">;
    callApi: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
    getLeaderTarget: () => TelegramTarget | undefined;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    clearLeaderTarget: () => void;
    disconnectFollowerThread?: () => Promise<boolean>;
    getSyncState: () => TSyncState;
    setSyncState: (state: TSyncState) => void;
    stopPolling: () => Promise<string>;
    recordRuntimeEvent: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    runWorkspaceOperation: TelegramSyncWorkspaceOperationRunner;
    workspaceOperationKind?: string;
    getNowMs?: () => number;
}
export declare function markTelegramConfigSyncChange<TSyncState extends TelegramSyncState>(state: TSyncState, action: string, options?: {
    nowMs?: number;
}): TSyncState;
export declare function createTelegramPreservedLeaderQuitHandler(deps: {
    instanceId: string;
    topicTargetStore: Pick<TelegramTopicTargetStore, "load" | "list" | "listPendingCleanups" | "detachTargetOwner">;
    getCurrentLeaderEpoch: () => number | string | undefined;
    getProfileName: () => string | undefined;
    isPollingSuspended: () => boolean;
    resolveAutomaticThreadCleanupEnabled: () => boolean | Promise<boolean>;
    runWorkspaceOperation: TelegramSyncWorkspaceOperationRunner;
}): (isSessionCurrent: () => boolean) => (() => Promise<void>) | undefined;
export interface TelegramSessionRestartThreadCleanupDeps<TSyncState extends TelegramSyncState> extends Omit<TelegramManualThreadDisconnectDeps<TSyncState>, "stopPolling"> {
    suspendPolling: () => Promise<void>;
}
export declare function createTelegramSessionRestartThreadCleanupHandler<TSyncState extends TelegramSyncState>(deps: TelegramSessionRestartThreadCleanupDeps<TSyncState>): () => Promise<string>;
export interface TelegramThreadDisconnectAssembly {
    disconnect: () => Promise<string>;
    cleanupForSessionRestart: () => Promise<string>;
}
export declare function createTelegramThreadDisconnectAssembly<TSyncState extends TelegramSyncState>(deps: Omit<TelegramManualThreadDisconnectDeps<TSyncState>, "stopPolling"> & {
    stopPolling: () => Promise<string>;
    suspendPolling: () => Promise<void>;
}): TelegramThreadDisconnectAssembly;
export declare function createTelegramManualThreadDisconnectHandler<TSyncState extends TelegramSyncState>(deps: TelegramManualThreadDisconnectDeps<TSyncState>): () => Promise<string>;
export declare function createTelegramLeaderHealthRuntime<TSyncState extends TelegramSyncState>(deps: TelegramLeaderHealthRuntimeDeps<TSyncState>): TelegramLeaderHealthRuntime;
export interface TelegramStaleTopicApiErrorRecoveryDeps<TSyncState> {
    topicTargetStore: Pick<TelegramTopicTargetStore, "load" | "markStaleByTarget" | "persist"> & Partial<Pick<TelegramTopicTargetStore, "invalidateTarget">>;
    getSyncState: () => TSyncState;
    setSyncState: (state: TSyncState) => void;
    recordEvent: (category: string, message: unknown, details?: Record<string, unknown>) => void;
    getNowMs?: () => number;
    isCurrent?: () => boolean;
    isAuthorityCurrent?: () => boolean;
    getWorkspaceAdmission?: () => Pick<TelegramWorkspaceAdmissionLedger, "acquireAdmission" | "releaseAdmission"> | undefined;
}
export declare function captureTelegramStaleTargetRequestRecovery<TSyncState extends TelegramSyncState>(body: Record<string, unknown>, deps: TelegramStaleTopicApiErrorRecoveryDeps<TSyncState> & {
    topicTargetStore: Pick<TelegramTopicTargetStore, "load" | "list" | "markStaleByTarget" | "persist" | "invalidateTarget">;
    getCurrentLeaderEpoch: () => number | string | undefined;
    getSessionGeneration: () => number;
    getProfileName: () => string | undefined;
    onRecovered: () => void;
}): ((error: unknown) => Promise<void>) | undefined;
export declare function createTelegramStaleTopicApiErrorRecoveryRuntime<TSyncState extends TelegramSyncState>(deps: TelegramStaleTopicApiErrorRecoveryDeps<TSyncState>): (apiBody: unknown, error: unknown) => Promise<boolean>;
export declare function settleStaleTelegramTopicExecutionFailure<TSyncState extends TelegramSyncState>(error: unknown, deps: TelegramStaleTopicApiErrorRecoveryDeps<TSyncState>): Promise<boolean>;
export declare function recoverStaleTelegramTopicApiError<TSyncState extends TelegramSyncState>(apiBody: unknown, error: unknown, deps: TelegramStaleTopicApiErrorRecoveryDeps<TSyncState>): Promise<boolean>;
export declare function ensureTelegramLeaderThreadBinding(deps: TelegramLeaderThreadSyncDeps): Promise<TelegramOwnTopicProvisionResult | undefined>;
export declare const TELEGRAM_SYNC_SLICE_TARGET_BINDINGS = "target-bindings";
export declare const TELEGRAM_SYNC_SLICES: readonly ["bot-identity", "bot-capabilities", "pairing", "allowed-user", "topic-capability", "topic-state", "target-bindings", "reservations", "transport-health"];
export type TelegramSyncSlice = (typeof TELEGRAM_SYNC_SLICES)[number];
export type TelegramSyncTrigger = "startup" | "reload" | "topic-lifecycle" | "stale-api-error" | "setup-change" | "pairing-change" | "follower-register" | "follower-prune" | "status-request" | "leader-health-tick" | "ordinary-message" | "ordinary-send";
export interface TelegramSyncSliceState {
    status: "fresh" | "suspect" | "unknown";
    updatedAtMs?: number;
    suspectAtMs?: number;
    reason?: string;
    lastReconcileAction?: string;
}
export type TelegramSyncState = Partial<Record<TelegramSyncSlice, TelegramSyncSliceState>>;
export declare function createUnknownTelegramSyncState(): TelegramSyncState;
export interface TelegramSyncStateRuntime {
    getState(): TelegramSyncState;
    setState(state: TelegramSyncState): void;
    markConfigChange(action: string): void;
    markSliceFresh(slice: TelegramSyncSlice, options: {
        nowMs: number;
        action: string;
    }): void;
}
export declare function createTelegramConfigSyncPersister<TConfig>(deps: {
    persist: (config?: TConfig) => Promise<void>;
    markConfigChange: (action: string) => void;
}): (config?: TConfig) => Promise<void>;
export declare function createTelegramSyncStateRuntime(initialState?: Partial<Record<"reservations" | "bot-identity" | "bot-capabilities" | "pairing" | "allowed-user" | "topic-capability" | "topic-state" | "target-bindings" | "transport-health", TelegramSyncSliceState>>): TelegramSyncStateRuntime;
export interface TelegramProvisioningActivityRuntime {
    isActive(): boolean;
    start(): void;
    end(): void;
}
export declare function createTelegramProvisioningActivityRuntime(): TelegramProvisioningActivityRuntime;
export declare function shouldReconcileTelegramSync(trigger: TelegramSyncTrigger): boolean;
export declare function markTelegramSyncSliceSuspect(state: TelegramSyncState, slice: TelegramSyncSlice, input: {
    reason: string;
    nowMs: number;
    action?: string;
}): TelegramSyncState;
export declare function markTelegramSyncSliceFresh(state: TelegramSyncState, slice: TelegramSyncSlice, input: {
    nowMs: number;
    action: string;
}): TelegramSyncState;
export declare function createTelegramObservedTopicLifecycleSyncHandler<TMessage = unknown, TSyncState extends TelegramSyncState = TelegramSyncState>(deps: TelegramObservedTopicLifecycleSyncDeps<TSyncState>): TelegramTopicLifecycleSyncHandler<TMessage>;
export declare function createTelegramTopicLifecycleSyncHandler<TMessage = unknown>(deps: TelegramTopicLifecycleSyncDeps): TelegramTopicLifecycleSyncHandler<TMessage>;
