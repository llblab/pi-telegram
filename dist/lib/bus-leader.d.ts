/**
 * Telegram bus leader orchestration
 * Zones: multi-instance bus, leader polling/server lifecycle, follower routing
 * Owns leader-only runtime orchestration: follower registration envelopes, follower API proxying,
 * leader activation hot-switching, local bus server startup, and stale follower pruning.
 */
import { type TelegramBusEnvelope, type TelegramBusLeaderQueueHandoffOffer, type TelegramBusFollowerRegistry, type TelegramBusFollowerView, type TelegramBusInstanceRegistration, type TelegramBusProtocolIdentity, type TelegramBusSelectedMenuDelivery, type TelegramBusSocketPathSource } from "./bus.ts";
import type { TelegramThreadDisplayMode } from "./config.ts";
import type { TelegramAttachmentSource } from "./media.ts";
import * as Sync from "./sync.ts";
import { type TelegramTarget } from "./target.ts";
import { type TelegramApiCallOptions, type TelegramBridgeApiRuntime } from "./telegram-api.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
import * as Threads from "./threads.ts";
import { type TelegramWorkspaceAdmissionLedger } from "./workspace-admission.ts";
import { type TelegramWorkspaceCapacityRunner, type TelegramWorkspaceOperationRunner, type TelegramWorkspaceSlotRotationPorts } from "./workspace-retirement.ts";
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
    routeQueueHandoff: (input: TelegramBusLeaderQueueHandoffOffer) => Promise<TelegramBusEnvelope>;
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
    getLiveFollowers?: () => readonly TelegramBusFollowerView[];
    isFollowerProcessAlive?: (pid: number) => boolean;
    topicTargetStore: Threads.TelegramTopicTargetStore;
    callApi: <TResponse>(method: string, body: Record<string, unknown>, options?: TelegramApiCallOptions) => Promise<TResponse>;
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
    downloadFile: (fileId: string, suggestedName: string, source?: TelegramAttachmentSource) => Promise<unknown>;
    recoverStaleTargetError?: (apiBody: unknown, error: unknown) => Promise<unknown> | unknown;
}
export interface TelegramBusLeaderRuntimeAssemblyDeps<TContext> {
    getThreadDisplayMode?: () => TelegramThreadDisplayMode;
    persistThreadDisplayMode?: (mode: TelegramThreadDisplayMode, isCurrent: () => boolean) => Promise<void>;
    onThreadDisplayChanged?: () => void;
    runtime: Omit<TelegramBusLeaderRuntimeDeps<TContext>, "callApi" | "onFollowerDisconnected" | "onFollowerConfirmedDead" | "onFollowerConfirmedDeadPreserved" | "getTelegramProfile" | "getAllowedUserId" | "provisionFollowerTarget" | "commitFollowerRegistration" | "provisionLeaderTarget" | "recordRuntimeEvent">;
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
export type TelegramBusFollowerSessionReplacementOperation = (follower: TelegramBusFollowerView, intent: Threads.TelegramSessionReplacementIntent, isCurrent: () => boolean) => Promise<boolean>;
export declare function createTelegramBusFollowerSessionReplacementAuthority(deps: {
    store: Pick<Threads.TelegramTopicTargetStore, "load" | "getWorkspaceBindingByTarget" | "getSessionReplacementIntent" | "commitSessionReplacementIntent" | "removeSessionReplacementIntent">;
    getTelegramProfile?: () => string | undefined;
    getNowMs?: () => number;
    ttlMs?: number;
}): {
    publish: TelegramBusFollowerSessionReplacementOperation;
    settle: TelegramBusFollowerSessionReplacementOperation;
};
export declare function createTelegramBusLeaderRuntimeAssembly<TContext>(deps: TelegramBusLeaderRuntimeAssemblyDeps<TContext>): TelegramBusLeaderRuntime<TContext> & {
    renameLeaderThreadAdmitted: (threadName: string, expectedTarget?: Threads.TelegramTopicTargetRecord["target"], assertRecipientAuthority?: () => void) => Promise<Threads.TelegramTopicTargetRecord>;
    resetLeaderThreadName: (expectedTarget: Threads.TelegramTopicTargetRecord["target"], assertRecipientAuthority?: () => void) => Promise<{
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
export type TelegramBusFollowerRegistrationCommitter = (input: {
    registration: TelegramBusInstanceRegistration;
    target?: TelegramTarget;
    slot?: string;
}, publish: () => void) => Promise<void> | void;
export interface TelegramBusLeaderRuntimeDeps<TContext> extends Omit<TelegramBusLeaderEnvelopeHandlerDeps, "runFollowerMutation" | "getWorkspaceRestoreObservationGeneration"> {
    socketPath: TelegramBusSocketPathSource;
    commitEndpointPublication?: (commit: () => void) => boolean;
    startPolling: (ctx: TContext) => void | Promise<void>;
    stopPolling: () => void | Promise<void>;
    provisionLeaderTarget?: (ctx: TContext) => Promise<void> | void;
    followerPruneIntervalMs?: number;
    /** Leader housekeeping after each current prune pass; throttling is the callee's concern. */
    afterFollowerPrune?: () => void;
    followerStaleAfterMs?: number;
    isFollowerProcessAlive?: (pid: number) => boolean;
    shouldCleanupConfirmedDeadFollower?: () => Promise<boolean> | boolean;
    onFollowerConfirmedDead?: (follower: TelegramBusFollowerView) => Promise<void> | void;
    /** True settles this observation; false needs fresh proof before another attempt. */
    onFollowerConfirmedDeadPreserved?: (follower: TelegramBusFollowerView, isDetached: () => boolean, operationId: string) => Promise<boolean> | boolean;
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
    recoverConnection?: boolean;
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
/** One delegated text effect through existing Workspace/API owners; no closure transport, ordinary proxy or replay loop. */
export declare function createTelegramBusSelectedMenuDeliveryHandler(deps: {
    followerRegistry: TelegramBusFollowerRegistry;
    protocolIdentity: TelegramBusProtocolIdentity;
    workspace: {
        /** Exact active bot/profile namespace, independently captured by the leader; never follower-supplied. */
        getScopeKey(): string | undefined;
        captureAuthority(): Threads.TelegramWorkspaceRestoreAuthority | undefined;
        getStore(): Threads.TelegramWorkspaceRestore | undefined;
        threadStore: Pick<Threads.TelegramTopicTargetStore, "withWorkspaceLiveRebindSnapshot">;
        getJournalBindingKey(follower: TelegramBusFollowerView): string | undefined;
        run: TelegramBusWorkspaceAdmissionRunner;
    };
    api: {
        runtime: Pick<TelegramBridgeApiRuntime, "call">;
        authorize(input: {
            follower: TelegramBusFollowerView;
            method: string;
            args: unknown[];
        }): boolean;
        /** Synchronous publication acceptance through the existing ownership owner, never delivery/cleanup permission. */
        record(record: TelegramBusFollowerMessageOwnershipRecord, assertCurrent: () => void): boolean;
    };
}): (input: TelegramBusSelectedMenuDelivery, isCallerCurrent: () => boolean) => Promise<TelegramBusEnvelope>;
export interface TelegramBusLeaderEnvelopeHandlerDeps {
    /** Ordinary locally guarded API wire authority only; not remote question membership. */
    captureApiTransport?: () => (() => boolean) | undefined;
    captureArtifactTransport?: () => (() => boolean) | undefined;
    artifactApi?: Pick<TelegramBridgeApiRuntime, "callArtifactBytes" | "reserveArtifact">;
    artifactMaxBytes?: number;
    followerRegistry: TelegramBusFollowerRegistry;
    authSecret?: string;
    protocolIdentity: TelegramBusProtocolIdentity;
    getNowMs?: () => number;
    timeoutMs?: number;
    selectedMenuDelivery?: ReturnType<typeof createTelegramBusSelectedMenuDeliveryHandler>;
    callApi?: (method: string, args: unknown[]) => Promise<unknown> | unknown;
    authorizeFollowerApiCall?: (input: {
        follower: TelegramBusFollowerView;
        method: string;
        args: unknown[];
    }) => boolean;
    recordFollowerMessageOwnership?: TelegramBusFollowerMessageOwnershipRecorder;
    captureInputPublication?: (follower: TelegramBusFollowerView, target: TelegramTarget) => (messageId: number) => void;
    getTextInputReceiverBotId?: (follower: Readonly<TelegramBusFollowerView>, target: Readonly<TelegramTarget>) => number | undefined;
    /** Private broker opt-in only; no production readiness or peer capability is advertised. */
    getAttachmentReceiverBotId?: (follower: Readonly<TelegramBusFollowerView>, target: Readonly<TelegramTarget>) => number | undefined;
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
        recoverConnection?: boolean;
    }) => Promise<(TelegramTarget & {
        slot?: string;
        threadName?: string;
    }) | undefined> | (TelegramTarget & {
        slot?: string;
        threadName?: string;
    }) | undefined;
    commitFollowerRegistration?: TelegramBusFollowerRegistrationCommitter;
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
    publishFollowerSessionReplacement?: TelegramBusFollowerSessionReplacementOperation;
    settleFollowerSessionReplacement?: TelegramBusFollowerSessionReplacementOperation;
    getFollowerDisplayTitle?: (follower: TelegramBusFollowerView) => string | undefined;
    /** The leader's own Thread capability, relayed on heartbeats so followers need not probe Telegram themselves. */
    getThreadCapability?: () => boolean | undefined;
    onFollowerRegistered?: () => void;
    /** Observation only: reacquire admission and inspect work, never infer completion.
     * Listener settlement ends its currentness fence; return asynchronous work to retain that fence. */
    onWorkspaceRestoreRecipientObserved?: (follower: TelegramBusFollowerView, isCurrent: () => boolean) => Promise<void> | void;
    getWorkspaceRestoreObservationGeneration?: () => number | undefined;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    applyThreadDisplayMode?: (mode: TelegramThreadDisplayMode, isCurrent: () => boolean) => Promise<void>;
    getThreadDisplayMode?: () => TelegramThreadDisplayMode;
    /** Fresh state-derived codec requirements, rechecked before provisioning and registration publication. */
    getRequiredWorkspaceReaderCapabilities?: () => readonly string[];
    getCurrentLeaderEpoch?: () => number | string | undefined;
    getTelegramProfile?: () => string | undefined;
    getAllowedUserId?: () => number | undefined;
    runFollowerMutation?: TelegramBusFollowerMutationRunner;
    runWorkspaceAdmission?: TelegramBusWorkspaceAdmissionRunner;
    runWithWorkspaceCapacity?: TelegramWorkspaceCapacityRunner;
}
export declare function createTelegramBusArtifactAuthorityCapture(deps: TelegramBusLeaderEnvelopeHandlerDeps): (envelope: Extract<TelegramBusEnvelope, {
    kind: "follower.callApi";
}>) => (() => boolean) | undefined;
export declare function createTelegramBusLeaderEnvelopeHandler(deps: TelegramBusLeaderEnvelopeHandlerDeps): (envelope: TelegramBusEnvelope) => Promise<TelegramBusEnvelope> | TelegramBusEnvelope;
export declare function createTelegramBusLeaderRuntime<TContext>(deps: TelegramBusLeaderRuntimeDeps<TContext>): TelegramBusLeaderRuntime<TContext>;
export {};
