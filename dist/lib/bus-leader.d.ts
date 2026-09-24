/**
 * Telegram bus leader orchestration
 * Zones: multi-instance bus, leader polling/server lifecycle, follower routing
 * Owns leader-only runtime orchestration: follower registration envelopes, follower API proxying,
 * leader activation hot-switching, local bus server startup, and stale follower pruning.
 */
import * as Sync from "./sync.ts";
import type { TelegramThreadDisplayMode } from "./config.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
import { type TelegramApiCallOptions } from "./telegram-api.ts";
import type { TelegramTarget } from "./target.ts";
import * as Threads from "./threads.ts";
import { type TelegramBusEnvelope, type TelegramBusFollowerRegistry, type TelegramBusFollowerView, type TelegramBusInstanceRegistration, type TelegramBusProtocolIdentity, type TelegramBusSocketPathSource } from "./bus.ts";
import type { TelegramQueueHandoffPayload } from "./queue.ts";
import { type TelegramWorkspaceCapacityRunner, type TelegramWorkspaceSlotRotationPorts, type TelegramWorkspaceOperationRunner } from "./workspace-retirement.ts";
import { type TelegramWorkspaceAdmissionLedger } from "./workspace-admission.ts";
export declare const TELEGRAM_BUS_FOLLOWER_STALE_AFTER_MS = 15000;
export type TelegramBusWorkspaceAdmissionRunner = TelegramWorkspaceOperationRunner;
export interface TelegramBusLeaderRuntime<TContext> {
    runWorkspaceOperation?: TelegramBusWorkspaceAdmissionRunner;
    captureWorkspaceExternalProtection?: (binding: Threads.TelegramWorkspaceThreadBinding) => Threads.TelegramWorkspaceExternalProtectionEvidence;
    reconcileThreadDisplay?: () => Promise<{
        changed: number;
    }>;
    setThreadDisplayMode?: (mode: TelegramThreadDisplayMode) => Promise<void>;
    renameLeaderThread?: (threadName: string) => Promise<Threads.TelegramTopicTargetRecord>;
    startPolling: (ctx: TContext) => Promise<void>;
    stopPolling: () => Promise<void>;
    routeQueueHandoff: (input: {
        requestId: string;
        auth?: string;
        recipientInstanceId: string;
        recipientRegistrationGeneration: string;
        donorInstanceId: string;
        donorProcessId: number;
        donorProcessBirthId: string;
        donorSessionGeneration: number;
        donorAcquisitionId: string;
        donorAcquiredAtMs: number;
        handoffToken: string;
        payload: TelegramQueueHandoffPayload;
        sentAtMs: number;
    }) => Promise<TelegramBusEnvelope>;
}
export interface TelegramBusFollowerLifecycleAnnouncement {
    target: TelegramTarget & {
        threadId: number;
    };
    text: string;
    parseMode: "HTML";
}
export interface TelegramBusLeaderTargetProvisionerDeps<TContext> {
    getAllowedUserId: () => number | undefined;
    instanceId: string;
    getCwd?: (ctx: TContext) => string | undefined;
    getSessionId?: (ctx: TContext) => string | undefined;
    getTelegramProfile?: () => string | undefined;
    shouldForceFreshUnnamed?: () => boolean;
    getRequestedThreadName?: () => string | undefined;
    resolveInitialWorkspaceDisplayTitle?: (binding: Threads.TelegramWorkspaceDisplayBinding) => string | undefined;
    topicTargetStore: Threads.TelegramTopicTargetStore;
    callApi: <TResponse>(method: string, body: Record<string, unknown>, options?: TelegramApiCallOptions) => Promise<TResponse>;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    getThreadReconciliationMachineState?: () => ThreadReconciler.ThreadReconciliationMachineState | undefined;
    recordThreadReconciliationPlan?: (plan: ThreadReconciler.ThreadReconciliationPlan) => void;
    getSyncState: () => Sync.TelegramSyncState;
    setSyncState: (state: Sync.TelegramSyncState) => void;
    setLeaderTarget: (input: {
        target: TelegramTarget;
        slot?: string;
        threadName?: string;
    }) => void;
    onProvisioningStart?: () => void;
    onProvisioningEnd?: () => void;
    recordRuntimeEvent: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    getNowMs?: () => number;
}
export interface TelegramBusFollowerTargetProvisionerDeps {
    getAllowedUserId: () => number | undefined;
    topicTargetStore: Threads.TelegramTopicTargetStore;
    callApi: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    getSyncState: () => Sync.TelegramSyncState;
    setSyncState: (state: Sync.TelegramSyncState) => void;
    onProvisioningStart?: () => void;
    onProvisioningEnd?: () => void;
    resolveInitialWorkspaceDisplayTitle?: (binding: Threads.TelegramWorkspaceDisplayBinding) => string | undefined;
    runWorkspaceOperation?: TelegramBusWorkspaceAdmissionRunner;
    getNowMs?: () => number;
    recordRuntimeEvent: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface TelegramBusFollowerDisconnectHandlerDeps {
    topicTargetStore: Pick<Threads.TelegramTopicTargetStore, "list" | "markStaleByTarget" | "persist" | "upsertPendingCleanup" | "removePendingCleanup">;
    callApi: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    getSyncState: () => Sync.TelegramSyncState;
    setSyncState: (state: Sync.TelegramSyncState) => void;
    getNowMs?: () => number;
    recordRuntimeEvent: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface TelegramBusLeaderApiProxyDeps {
    call: (method: string, body: Record<string, unknown>, options?: TelegramApiCallOptions) => Promise<unknown>;
    callMultipart: (method: string, fields: Record<string, string>, fieldName: string, filePath: string, fileName: string, options?: TelegramApiCallOptions) => Promise<unknown>;
    downloadFile: (fileId: string, destinationDir: string) => Promise<unknown>;
    recoverStaleTargetError?: (apiBody: unknown, error: unknown) => Promise<unknown> | unknown;
}
export interface TelegramBusLeaderRuntimeAssemblyDeps<TContext> {
    getThreadDisplayMode?: () => TelegramThreadDisplayMode;
    persistThreadDisplayMode?: (mode: TelegramThreadDisplayMode, isCurrent: () => boolean) => Promise<void>;
    onThreadDisplayChanged?: () => void;
    runtime: Omit<TelegramBusLeaderRuntimeDeps<TContext>, "callApi" | "onFollowerDisconnected" | "onFollowerConfirmedDead" | "onFollowerConfirmedDeadPreserved" | "getTelegramProfile" | "provisionFollowerTarget" | "provisionLeaderTarget" | "recordRuntimeEvent">;
    getAllowedUserId: () => number | undefined;
    instanceId: string;
    getCwd?: (ctx: TContext) => string | undefined;
    getSessionId?: (ctx: TContext) => string | undefined;
    getTelegramProfile?: () => string | undefined;
    shouldForceFreshUnnamed?: () => boolean;
    getRequestedThreadName?: () => string | undefined;
    topicTargetStore: Threads.TelegramTopicTargetStore;
    callApi: TelegramBusLeaderTargetProvisionerDeps<TContext>["callApi"];
    callMultipart: TelegramBusLeaderApiProxyDeps["callMultipart"];
    downloadFile: TelegramBusLeaderApiProxyDeps["downloadFile"];
    recoverStaleTargetError?: TelegramBusLeaderApiProxyDeps["recoverStaleTargetError"];
    getCurrentLeaderEpoch?: () => number | string | undefined;
    getThreadReconciliationMachineState?: TelegramBusLeaderTargetProvisionerDeps<TContext>["getThreadReconciliationMachineState"];
    recordThreadReconciliationPlan?: TelegramBusLeaderTargetProvisionerDeps<TContext>["recordThreadReconciliationPlan"];
    getSyncState: () => Sync.TelegramSyncState;
    setSyncState: (state: Sync.TelegramSyncState) => void;
    setLeaderTarget: TelegramBusLeaderTargetProvisionerDeps<TContext>["setLeaderTarget"];
    onProvisioningStart?: () => void;
    onProvisioningEnd?: () => void;
    recordRuntimeEvent: NonNullable<TelegramBusLeaderRuntimeDeps<TContext>["recordRuntimeEvent"]>;
    captureWorkspaceExternalProtection?: (binding: Threads.TelegramWorkspaceThreadBinding) => Threads.TelegramWorkspaceExternalProtectionEvidence;
    getWorkspaceAdmission?: () => Pick<TelegramWorkspaceAdmissionLedger, "acquireAdmission" | "releaseAdmission"> | undefined;
    runWorkspaceOperation?: TelegramBusWorkspaceAdmissionRunner;
    workspaceRotation?: TelegramWorkspaceSlotRotationPorts;
}
export declare function createTelegramBusLeaderRuntimeAssembly<TContext>(deps: TelegramBusLeaderRuntimeAssemblyDeps<TContext>): TelegramBusLeaderRuntime<TContext> & {
    renameLeaderThreadAdmitted: (threadName: string, expectedTarget?: Threads.TelegramTopicTargetRecord["target"]) => Promise<Threads.TelegramTopicTargetRecord>;
    resetLeaderThreadName: (expectedTarget: Threads.TelegramTopicTargetRecord["target"]) => Promise<{
        threadName: string;
    }>;
    resetThreadNameAdmitted: (target: Threads.TelegramTopicTargetRecord["target"]) => Promise<{
        threadName: string;
    }>;
};
export interface TelegramBusFollowerMessageOwnershipRecord {
    follower: TelegramBusFollowerView;
    chatId: number;
    messageId: number;
    target?: TelegramTarget;
}
export type TelegramBusFollowerMessageOwnershipRecorder = (record: TelegramBusFollowerMessageOwnershipRecord) => void;
export interface TelegramBusLeaderRuntimeDeps<TContext> {
    socketPath: TelegramBusSocketPathSource;
    commitEndpointPublication?: (commit: () => void) => boolean;
    followerRegistry: TelegramBusFollowerRegistry;
    authSecret?: string;
    protocolIdentity: TelegramBusProtocolIdentity;
    startPolling: (ctx: TContext) => void | Promise<void>;
    stopPolling: () => void | Promise<void>;
    callApi?: (method: string, args: unknown[]) => Promise<unknown> | unknown;
    authorizeFollowerApiCall?: (input: {
        follower: TelegramBusFollowerView;
        method: string;
        args: unknown[];
    }) => boolean;
    recordFollowerMessageOwnership?: TelegramBusFollowerMessageOwnershipRecorder;
    resolveAgentTarget?: (follower: TelegramBusFollowerView, selector: Extract<TelegramBusEnvelope, {
        kind: "follower.resolveAgentTarget";
    }>["selector"]) => Promise<TelegramTarget | undefined> | TelegramTarget | undefined;
    routeAgentMessage?: (follower: TelegramBusFollowerView, message: Extract<TelegramBusEnvelope, {
        kind: "follower.routeAgentMessage";
    }>["message"]) => Promise<void> | void;
    routeQueueHandoff?: (follower: TelegramBusFollowerView, envelope: Extract<TelegramBusEnvelope, {
        kind: "follower.offerQueueHandoff";
    }>) => Promise<unknown> | unknown;
    provisionFollowerTarget?: (registration: TelegramBusInstanceRegistration, options?: {
        existingWorkspaceBindingOnly?: boolean;
    }) => Promise<TelegramTarget | undefined> | TelegramTarget | undefined;
    renameFollowerThread?: (follower: TelegramBusFollowerView, threadName: string) => Promise<{
        threadName: string;
    }> | {
        threadName: string;
    };
    resetFollowerThreadName?: (follower: TelegramBusFollowerView) => Promise<{
        threadName: string;
    }> | {
        threadName: string;
    };
    getFollowerDisplayTitle?: (follower: TelegramBusFollowerView) => string | undefined;
    onFollowerRegistered?: () => void;
    applyThreadDisplayMode?: (mode: TelegramThreadDisplayMode, isCurrent: () => boolean) => Promise<void>;
    getThreadDisplayMode?: () => TelegramThreadDisplayMode;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    getTelegramProfile?: () => string | undefined;
    provisionLeaderTarget?: (ctx: TContext) => Promise<void> | void;
    runWorkspaceAdmission?: TelegramBusWorkspaceAdmissionRunner;
    runWithWorkspaceCapacity?: TelegramWorkspaceCapacityRunner;
    getNowMs?: () => number;
    timeoutMs?: number;
    followerPruneIntervalMs?: number;
    followerStaleAfterMs?: number;
    isFollowerProcessAlive?: (pid: number) => boolean;
    shouldCleanupConfirmedDeadFollower?: () => Promise<boolean> | boolean;
    onFollowerDisconnected?: (follower: TelegramBusFollowerView) => Promise<void> | void;
    onFollowerConfirmedDead?: (follower: TelegramBusFollowerView) => Promise<void> | void;
    /** True settles this observation; false needs fresh proof before another attempt. */
    onFollowerConfirmedDeadPreserved?: (follower: TelegramBusFollowerView, isDetached: () => boolean, operationId: string) => Promise<boolean> | boolean;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export declare function createTelegramBusInstanceLifecycleAnnouncement(input: {
    target: TelegramTarget & {
        threadId: number;
    };
    threadName?: string;
    slot?: string;
    state: "connected";
}): TelegramBusFollowerLifecycleAnnouncement;
export declare function createTelegramBusFollowerTargetProvisioner(deps: TelegramBusFollowerTargetProvisionerDeps): (registration: TelegramBusInstanceRegistration, options?: {
    existingWorkspaceBindingOnly?: boolean;
}) => Promise<(TelegramTarget & {
    slot?: string;
    threadName?: string;
}) | undefined>;
export declare function createTelegramBusFollowerDisconnectHandler(deps: TelegramBusFollowerDisconnectHandlerDeps): (follower: TelegramBusFollowerView) => Promise<void>;
export declare function createTelegramBusFollowerConfirmedDeadHandler(deps: TelegramBusFollowerDisconnectHandlerDeps): (follower: TelegramBusFollowerView) => Promise<void>;
export declare function createTelegramBusLeaderTargetProvisioner<TContext>(deps: TelegramBusLeaderTargetProvisionerDeps<TContext>): (ctx: TContext) => Promise<void>;
export declare function createTelegramBusLeaderApiProxy(deps: TelegramBusLeaderApiProxyDeps): (method: string, args: unknown[]) => Promise<unknown>;
type TelegramBusFollowerMutationRunner = <T>(follower: {
    instanceId: string;
    profileKey?: string;
}, operation: () => Promise<T>) => Promise<T>;
export declare function createTelegramBusLeaderEnvelopeHandler(deps: {
    followerRegistry: TelegramBusFollowerRegistry;
    authSecret?: string;
    protocolIdentity: TelegramBusProtocolIdentity;
    getNowMs?: () => number;
    timeoutMs?: number;
    callApi?: (method: string, args: unknown[]) => Promise<unknown> | unknown;
    authorizeFollowerApiCall?: (input: {
        follower: TelegramBusFollowerView;
        method: string;
        args: unknown[];
    }) => boolean;
    recordFollowerMessageOwnership?: TelegramBusFollowerMessageOwnershipRecorder;
    resolveAgentTarget?: (follower: TelegramBusFollowerView, selector: Extract<TelegramBusEnvelope, {
        kind: "follower.resolveAgentTarget";
    }>["selector"]) => Promise<TelegramTarget | undefined> | TelegramTarget | undefined;
    routeAgentMessage?: (follower: TelegramBusFollowerView, message: Extract<TelegramBusEnvelope, {
        kind: "follower.routeAgentMessage";
    }>["message"]) => Promise<void> | void;
    routeQueueHandoff?: (follower: TelegramBusFollowerView, envelope: Extract<TelegramBusEnvelope, {
        kind: "follower.offerQueueHandoff";
    }>) => Promise<unknown> | unknown;
    provisionFollowerTarget?: (registration: TelegramBusInstanceRegistration, options?: {
        existingWorkspaceBindingOnly?: boolean;
    }) => Promise<(TelegramTarget & {
        slot?: string;
        threadName?: string;
    }) | undefined> | (TelegramTarget & {
        slot?: string;
        threadName?: string;
    }) | undefined;
    onFollowerDisconnected?: (follower: TelegramBusFollowerView) => Promise<void> | void;
    renameFollowerThread?: (follower: TelegramBusFollowerView, threadName: string) => Promise<{
        threadName: string;
    }> | {
        threadName: string;
    };
    resetFollowerThreadName?: (follower: TelegramBusFollowerView) => Promise<{
        threadName: string;
    }> | {
        threadName: string;
    };
    getFollowerDisplayTitle?: (follower: TelegramBusFollowerView) => string | undefined;
    onFollowerRegistered?: () => void;
    applyThreadDisplayMode?: (mode: TelegramThreadDisplayMode, isCurrent: () => boolean) => Promise<void>;
    getThreadDisplayMode?: () => TelegramThreadDisplayMode;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    runFollowerMutation?: TelegramBusFollowerMutationRunner;
    runWorkspaceAdmission?: TelegramBusWorkspaceAdmissionRunner;
    runWithWorkspaceCapacity?: TelegramWorkspaceCapacityRunner;
}): (envelope: TelegramBusEnvelope) => Promise<TelegramBusEnvelope> | TelegramBusEnvelope;
export interface TelegramBusLeaderActivationSchedulerDeps<TContext> {
    isBusEnabled: () => boolean;
    ownsPolling: (ctx: TContext) => boolean;
    isBusPollingStarted: () => boolean;
    setBusPollingStarted: (started: boolean) => void;
    stopClassicPolling: () => Promise<void>;
    startClassicPolling: (ctx: TContext) => void | Promise<void>;
    startBusLeaderPolling: (ctx: TContext) => Promise<void>;
    updateStatus: (ctx: TContext) => void;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export declare function createTelegramBusLeaderActivationScheduler<TContext>(deps: TelegramBusLeaderActivationSchedulerDeps<TContext>): (ctx: TContext) => void;
export declare function createTelegramBusLeaderRuntime<TContext>(deps: TelegramBusLeaderRuntimeDeps<TContext>): TelegramBusLeaderRuntime<TContext>;
export {};
