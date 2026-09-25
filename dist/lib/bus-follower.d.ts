/**
 * Telegram bus follower runtime
 * Zones: multi-instance bus, follower lifecycle, manual registration
 * Owns this Pi instance's follower-side bus behavior: manual registration,
 * heartbeat, forwarded-update receiving, and follower-routed API calls.
 * It must not spawn Pi processes or create hidden Telegram-originated instances.
 */
import * as Sync from "./sync.ts";
import * as Threads from "./threads.ts";
import { type TelegramUpdateJournalStoreOptions } from "./journal.ts";
import { type TelegramLockEntry, type TelegramLockState } from "./locks.ts";
import type { TelegramQueueHandoffPayload, TelegramQueueHandoffStageResult } from "./queue.ts";
import type { TelegramTarget } from "./target.ts";
import { type TelegramBusAgentMessage, type TelegramBusAgentTargetSelector, type TelegramBusEnvelope, type TelegramBusForwardOwnership, type TelegramBusProtocolIdentity, type TelegramBusSocketPathSource } from "./bus.ts";
import type { TelegramConfigStore, TelegramThreadDisplayMode } from "./config.ts";
import { type TelegramWorkspaceAdmissionLedger } from "./workspace-admission.ts";
export declare const TELEGRAM_BUS_FOLLOWER_PROMOTION_GRACE_MS = 2500;
export declare const TELEGRAM_FOLLOWER_SESSION_HANDOFF_TTL_MS = 30000;
export declare const TELEGRAM_BUS_FOLLOWER_CLIENT_TIMEOUT_MS = 30000;
export declare const TELEGRAM_BUS_FOLLOWER_REGISTRATION_WAIT_MS = 30000;
export declare const TELEGRAM_BUS_FOLLOWER_HEARTBEAT_TIMEOUT_MS = 8000;
export declare const TELEGRAM_BUS_FOLLOWER_REGISTRATION_RETRY_ATTEMPTS: number;
export declare const TELEGRAM_BUS_FOLLOWER_REGISTRATION_RETRY_DELAY_MS: number;
export interface TelegramFollowerSessionHandoff {
    pid: number;
    instanceId: string;
    createdAtMs: number;
    target: TelegramTarget;
    slot?: string;
    threadName?: string;
}
export declare function getTelegramFollowerSessionHandoff(): TelegramFollowerSessionHandoff | undefined;
export declare function setTelegramFollowerSessionHandoff(handoff: TelegramFollowerSessionHandoff | undefined): void;
export declare function isTelegramFollowerSessionHandoffFresh(handoff: TelegramFollowerSessionHandoff | undefined, options?: {
    pid?: number;
    nowMs?: number;
    ttlMs?: number;
}): handoff is TelegramFollowerSessionHandoff;
export interface TelegramBusFollowerRegistrationRuntime<TContext> {
    registerWithLeader: (ctx: TContext, leader: {
        busSocketPath?: string;
        busSecret?: string;
    }, options?: {
        target?: TelegramTarget;
        previousInstanceId?: string;
        restoreWorkspace?: boolean;
    }) => Promise<boolean>;
    setContext: (ctx: TContext) => void | Promise<void>;
    disconnectFromLeader?: () => Promise<boolean>;
    renameThread?: (target: TelegramTarget & {
        threadId: number;
    }, threadName: string) => Promise<string>;
    resetThreadName?: (target: TelegramTarget & {
        threadId: number;
    }) => Promise<string>;
    setThreadDisplayMode?: (mode: TelegramThreadDisplayMode) => Promise<void>;
    /** Leader-mediated durable publication or successor claim; true only after exact commit. */
    requestSessionReplacement?: (operation: "publish" | "settle", intent: Threads.TelegramSessionReplacementIntent) => Promise<boolean>;
    stop: () => void;
}
export interface TelegramBusFollowerSessionReplacementSuspenderDeps {
    registrationState: Pick<TelegramBusFollowerRegistrationState, "isRegistered" | "getTarget" | "getSlot" | "getThreadName">;
    instanceId: string;
    suspendPolling: () => Promise<void>;
    isLeader?: () => boolean;
    getLeaderBinding?: () => TelegramBusFollowerPromotedBinding | undefined;
    getActiveContext?: () => {
        cwd?: string;
    } | undefined;
    getActiveProfileName?: () => string | undefined;
    recordRuntimeEvent: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    getNowMs?: () => number;
    getPid?: () => number;
}
export interface TelegramBusFollowerSessionRefreshHookDeps<TContext> {
    registrationState: Pick<TelegramBusFollowerRegistrationState, "isRegistered">;
    registrationRuntime: Pick<TelegramBusFollowerRegistrationRuntime<TContext>, "registerWithLeader" | "setContext">;
    getLeaderState: () => TelegramLockState;
    isSessionActive?: (ctx: TContext) => boolean;
    updateStatus: (ctx: TContext) => void;
    recordRuntimeEvent: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export type TelegramBusFollowerControlLifecyclePhase = "electing";
export interface TelegramBusFollowerControlState {
    getActiveAuthSecret: () => string | undefined;
    setActiveAuthSecret: (secret: string | undefined) => void;
    getLifecyclePhase: () => TelegramBusFollowerControlLifecyclePhase | undefined;
    setLifecyclePhase: (phase: TelegramBusFollowerControlLifecyclePhase | undefined) => void;
}
export interface TelegramBusFollowerRegistrationState {
    isRegistered: () => boolean;
    getTarget: () => TelegramTarget | undefined;
    getSlot: () => string | undefined;
    getThreadName: () => string | undefined;
    getDisplayTitle: () => string | undefined;
    setDisplayTitle: (title: string, generation: string) => boolean;
    getGeneration: () => string | undefined;
    beginRecovery: () => number;
    cancelRecovery: () => void;
    waitForGeneration: (timeoutMs?: number) => Promise<string | undefined>;
    getLeaderProtocol: () => TelegramBusProtocolIdentity | undefined;
    getEligibleElectionSlots: () => readonly string[];
    setEligibleElectionSlots: (slots: readonly string[]) => void;
    setRegistered: (registered: boolean, target?: TelegramTarget, metadata?: {
        slot?: string;
        threadName?: string;
        displayTitle?: string;
        generation?: string;
        leaderProtocol?: TelegramBusProtocolIdentity;
    }) => void;
}
export interface TelegramBusForwardedUpdateReceiverRuntime {
    start: () => Promise<void>;
    stop: () => Promise<void>;
}
export interface TelegramBusFollowerDurableAdmissionResult {
    deliveryId: string;
    sourceUpdateId: number;
}
export interface TelegramBusFollowerDurableAdmissionPort<TContext> {
    admit: (envelope: Extract<TelegramBusEnvelope, {
        kind: "leader.forwardCallback" | "leader.forwardReaction" | "leader.forwardMessage" | "leader.forwardEditedMessage" | "leader.wakeInputCustody";
    }>, ctx: TContext) => Promise<TelegramBusFollowerDurableAdmissionResult>;
}
export interface TelegramBusFollowerClientRuntimeDeps<TMessage = unknown> {
    socketPath: TelegramBusSocketPathSource;
    instanceId: string;
    getApiAuthSecret?: () => string | undefined;
    getForwardingAuthSecret?: () => string | undefined;
    getRegistrationGeneration: () => string | undefined;
    waitForRegistrationGeneration?: (timeoutMs?: number) => Promise<string | undefined>;
    getForwardCommentBatchPosition?: (message: TMessage) => "comment" | "forward" | undefined;
    validateForwardOwnership?: (ownership: TelegramBusForwardOwnership) => boolean;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    timeoutMs?: number;
}
export interface TelegramBusFollowerApiCallerDeps {
    socketPath: TelegramBusSocketPathSource;
    instanceId: string;
    createRequestId: () => string;
    getAuthSecret?: () => string | undefined;
    getRegistrationGeneration: () => string | undefined;
    waitForRegistrationGeneration?: (timeoutMs?: number) => Promise<string | undefined>;
    getNowMs?: () => number;
    timeoutMs?: number;
}
export interface TelegramBusFollowerRegistrationRuntimeDeps<TContext extends {
    cwd?: string;
}> {
    instanceId: string;
    createRequestId: () => string;
    protocolIdentity: TelegramBusProtocolIdentity;
    getLeaderAuthSecret?: (leader: {
        busSecret?: string;
    }) => string | undefined;
    setActiveAuthSecret?: (secret: string | undefined) => void;
    followerBusSocketPath?: string;
    getFollowerBusSocketPath?: () => string;
    getLeaderSocketPath?: () => string;
    startReceiving?: () => Promise<void>;
    stopReceiving?: () => Promise<void> | void;
    registrationState?: TelegramBusFollowerRegistrationState;
    isContextActive?: (ctx: TContext) => boolean;
    getProfileKey?: (ctx: TContext) => string | undefined;
    getThreadName?: (ctx: TContext) => string | undefined;
    getNowMs?: () => number;
    getPid?: () => number;
    getProcessBirthId?: () => string;
    getSessionId?: (ctx: TContext) => string | undefined;
    getSessionGeneration?: () => number;
    timeoutMs?: number;
    registrationTimeoutMs?: number;
    registrationRetryAttempts?: number;
    registrationRetryDelayMs?: number;
    heartbeatMs?: number;
    heartbeatTimeoutMs?: number;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    onHeartbeatFailure?: (error: unknown, ctx: TContext) => Promise<void> | void;
    onRegistered?: (ctx: TContext) => Promise<void> | void;
    onDisplayTitleChanged?: (ctx: TContext) => void;
}
export declare function createTelegramManualFollowerProfileKeyResolver(input: {
    getActiveProfileName: () => string | undefined;
    manualFollowerOwnerId: string;
}): () => string;
export interface TelegramBusFollowerElection {
    expectedOwner?: TelegramLockEntry;
}
export type TelegramBusFollowerPromotionHandler<TContext> = (ctx: TContext, binding: TelegramBusFollowerPromotedBinding, election: TelegramBusFollowerElection) => Promise<boolean>;
type TelegramBusFollowerWorkspaceAdmissionDeps = {
    getWorkspaceAdmission?: () => Pick<TelegramWorkspaceAdmissionLedger, "acquireAdmission" | "releaseAdmission"> | undefined;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
};
export declare function createTelegramBusFollowerPromotionHandler<TContext extends {
    cwd: string;
}>(input: {
    topicTargetStore: Threads.TelegramTopicTargetStore;
    instanceId: string;
    getActiveProfileName: () => string | undefined;
    getSessionId?: (ctx: TContext) => string | undefined;
    startLeader: (ctx: TContext, election: TelegramBusFollowerElection, onAcquired: () => Promise<void>) => Promise<boolean>;
    recordRuntimeEvent: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    getNowMs?: () => number;
    getPid?: () => number;
    getWorkspaceAdmission?: TelegramBusFollowerWorkspaceAdmissionDeps["getWorkspaceAdmission"];
}): TelegramBusFollowerPromotionHandler<TContext>;
export interface TelegramBusFollowerTargetReplacementHandlerDeps<TContext> {
    topicTargetStore: Pick<Threads.TelegramTopicTargetStore, "load" | "list" | "markStaleByTarget" | "upsert" | "persist">;
    registrationState: Pick<TelegramBusFollowerRegistrationState, "getTarget" | "getSlot" | "setRegistered" | "getGeneration">;
    instanceId: string;
    getManualFollowerProfileKey: () => string;
    manualFollowerOwnerId: string;
    getSyncState: () => Sync.TelegramSyncState;
    setSyncState: (state: Sync.TelegramSyncState) => void;
    getNowMs?: () => number;
    updateStatus: (ctx: TContext) => void;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    getWorkspaceAdmission?: TelegramBusFollowerWorkspaceAdmissionDeps["getWorkspaceAdmission"];
}
export type TelegramBusFollowerLeaderState = {
    kind: "inactive";
} | {
    kind: "active-here";
    lock: TelegramBusFollowerLeaderLock;
} | {
    kind: "active-elsewhere";
    lock: TelegramBusFollowerLeaderLock;
} | {
    kind: "stale";
    lock: TelegramBusFollowerLeaderLock;
};
export type TelegramBusFollowerLeaderLock = TelegramLockEntry;
export interface TelegramBusFollowerPromotedBinding {
    target?: TelegramTarget;
    slot?: string;
    threadName?: string;
}
export interface TelegramBusFollowerHeartbeatRecoveryHandlerDeps<TContext> {
    registrationState: Pick<TelegramBusFollowerRegistrationState, "getTarget" | "getSlot" | "getThreadName" | "getEligibleElectionSlots" | "beginRecovery" | "setRegistered">;
    getRegistrationRuntime: () => TelegramBusFollowerRegistrationRuntime<TContext>;
    getLeaderState: () => TelegramBusFollowerLeaderState;
    setLifecyclePhase: (phase: "electing" | undefined) => void;
    updateStatus: (ctx: TContext) => void;
    promoteToLeader: (ctx: TContext, binding: TelegramBusFollowerPromotedBinding, election: TelegramBusFollowerElection) => Promise<boolean>;
    sleep?: (ms: number) => Promise<void>;
    scheduleRetry?: (retry: () => void, delayMs: number) => void;
    getActiveContext?: () => TContext | undefined;
    promotionGraceMs?: number;
    recordRuntimeEvent: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface TelegramBusForwardedUpdateReceiverRuntimeDeps<TContext> {
    socketPath: TelegramBusSocketPathSource;
    instanceId: string;
    getAuthSecret?: () => string | undefined;
    getRegistrationGeneration: () => string | undefined;
    getRecipientBindingKey: () => string | undefined;
    durableAdmission: TelegramBusFollowerDurableAdmissionPort<TContext>;
    sourceReferenceAdmission?: TelegramBusFollowerDurableAdmissionPort<TContext>;
    isSourceReferenceAdmissionEnabled?: () => boolean;
    hasAuthenticatedSourceReferenceTransport?: () => boolean;
    getContext: () => TContext | undefined;
    handleInputCustodyHandoff?: (envelope: Extract<TelegramBusEnvelope, {
        kind: "leader.offerInputCustodyHandoff";
    }>, ctx: TContext) => Promise<unknown> | unknown;
    handleQueueHandoff?: (envelope: Extract<TelegramBusEnvelope, {
        kind: "leader.offerQueueHandoff";
    }>, ctx: TContext) => Promise<TelegramQueueHandoffStageResult> | TelegramQueueHandoffStageResult;
    handleReplaceTarget?: (input: {
        target: TelegramTarget & {
            threadId: number;
        };
        oldTarget?: TelegramTarget & {
            threadId: number;
        };
        reason: "thread-restore";
        registrationGeneration: string;
    }, ctx: TContext) => Promise<void> | void;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface TelegramBusFollowerRuntimeAssembly<TContext> {
    receiver: TelegramBusForwardedUpdateReceiverRuntime;
    registration: TelegramBusFollowerRegistrationRuntime<TContext>;
}
export interface TelegramBusFollowerRuntimeAssemblyPorts<TContext extends {
    cwd?: string;
}> {
    instanceId: string;
    registrationState: TelegramBusFollowerRegistrationState;
    recordRuntimeEvent: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    receiver: Omit<TelegramBusForwardedUpdateReceiverRuntimeDeps<TContext>, "handleReplaceTarget" | "instanceId" | "recordRuntimeEvent" | "getRegistrationGeneration">;
    targetReplacement: Omit<TelegramBusFollowerTargetReplacementHandlerDeps<TContext>, "registrationState" | "instanceId" | "recordRuntimeEvent">;
    recovery: Omit<TelegramBusFollowerHeartbeatRecoveryHandlerDeps<TContext>, "getRegistrationRuntime" | "registrationState" | "recordRuntimeEvent">;
    registration: Omit<TelegramBusFollowerRegistrationRuntimeDeps<TContext>, "startReceiving" | "stopReceiving" | "onHeartbeatFailure" | "instanceId" | "registrationState" | "recordRuntimeEvent" | "protocolIdentity"> & {
        protocolIdentity: TelegramBusProtocolIdentity;
    };
}
export declare function createTelegramBusFollowerRuntimeAssembly<TContext extends {
    cwd?: string;
}>(ports: TelegramBusFollowerRuntimeAssemblyPorts<TContext>): TelegramBusFollowerRuntimeAssembly<TContext>;
export declare function createTelegramBusFollowerTargetReplacementHandler<TContext>(deps: TelegramBusFollowerTargetReplacementHandlerDeps<TContext>): NonNullable<TelegramBusForwardedUpdateReceiverRuntimeDeps<TContext>["handleReplaceTarget"]>;
export declare function createTelegramBusFollowerClientRuntime<TContext, TReactionUpdate, TCallbackQuery, TMessage = unknown>(deps: TelegramBusFollowerClientRuntimeDeps<TMessage>): {
    createRequestId: () => string;
    callApi: (method: string, args: unknown[]) => Promise<unknown>;
    agentMessages: {
        resolveTarget: (selector: TelegramBusAgentTargetSelector) => Promise<TelegramTarget & {
            threadId: number;
        }>;
        routeMessage: (message: TelegramBusAgentMessage) => Promise<void>;
    };
    foreignOwnedUpdateForwarder: {
        forwardCallback: (input: {
            query: TCallbackQuery;
            ownership: TelegramBusForwardOwnership;
            ctx: TContext;
        }) => Promise<import("./bus.ts").TelegramBusForeignUpdateSettlement>;
        forwardReaction: (input: {
            reactionUpdate: TReactionUpdate;
            ownership: TelegramBusForwardOwnership;
            ctx: TContext;
        }) => Promise<import("./bus.ts").TelegramBusForeignUpdateSettlement>;
        forwardMessage: (input: {
            message: TMessage;
            ownership: TelegramBusForwardOwnership;
            ctx: TContext;
        }) => Promise<import("./bus.ts").TelegramBusForeignUpdateSettlement>;
        forwardEditedMessage: (input: {
            message: TMessage;
            ownership: TelegramBusForwardOwnership;
            ctx: TContext;
        }) => Promise<import("./bus.ts").TelegramBusForeignUpdateSettlement>;
    };
    queueHandoff: (input: {
        recipientInstanceId: string;
        recipientRegistrationGeneration: string;
        donorProcessId: number;
        donorProcessBirthId: string;
        donorSessionGeneration: number;
        donorAcquisitionId: string;
        donorAcquiredAtMs: number;
        handoffToken: string;
        payload: TelegramQueueHandoffPayload;
    }) => Promise<TelegramQueueHandoffStageResult>;
    targetController: {
        replaceTarget: (input: {
            follower: import("./bus.ts").TelegramBusFollowerView;
            target: TelegramTarget & {
                threadId: number;
            };
            oldTarget?: TelegramTarget & {
                threadId: number;
            };
            reason: "thread-restore";
        }) => Promise<boolean>;
    };
};
export declare function createTelegramBusFollowerQueueHandoffClient(deps: TelegramBusFollowerApiCallerDeps): (input: {
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    donorProcessId: number;
    donorProcessBirthId: string;
    donorSessionGeneration: number;
    donorAcquisitionId: string;
    donorAcquiredAtMs: number;
    handoffToken: string;
    payload: TelegramQueueHandoffPayload;
}) => Promise<TelegramQueueHandoffStageResult>;
export declare function createTelegramBusAgentMessageClient(deps: TelegramBusFollowerApiCallerDeps): {
    resolveTarget: (selector: TelegramBusAgentTargetSelector) => Promise<TelegramTarget & {
        threadId: number;
    }>;
    routeMessage: (message: TelegramBusAgentMessage) => Promise<void>;
};
export declare function createTelegramBusFollowerApiCaller(deps: TelegramBusFollowerApiCallerDeps): (method: string, args: unknown[]) => Promise<unknown>;
export declare function createTelegramBusFollowerSessionReplacementSuspender(deps: TelegramBusFollowerSessionReplacementSuspenderDeps): () => Promise<void>;
export declare function createTelegramBusFollowerSessionRefreshHook<TContext>(deps: TelegramBusFollowerSessionRefreshHookDeps<TContext>): (_event: unknown, ctx: TContext) => Promise<void>;
export declare function createTelegramBusFollowerControlState(): TelegramBusFollowerControlState;
export declare function createTelegramBusFollowerRegistrationState(options?: {
    onAvailabilityChanged?: () => void;
}): TelegramBusFollowerRegistrationState;
export declare function createTelegramBusFollowerHeartbeatRecoveryHandler<TContext>(deps: TelegramBusFollowerHeartbeatRecoveryHandlerDeps<TContext>): (error: unknown, ctx: TContext) => Promise<void>;
export declare function createTelegramBusFollowerRegistrationRuntime<TContext extends {
    cwd?: string;
}>(deps: TelegramBusFollowerRegistrationRuntimeDeps<TContext>): TelegramBusFollowerRegistrationRuntime<TContext>;
/** Bind source-owned sender checks to the journal's already-admitted synchronous v1 hook. */
export declare function createTelegramBusFollowerPairedAdmission(deps: {
    profileName: string;
    tokenSha256: string;
    configStore: Pick<TelegramConfigStore, "withPairedUserAdmission">;
    assertExecutionCurrent: () => void;
}): NonNullable<TelegramUpdateJournalStoreOptions["withPairedAdmission"]>;
export declare function prepareTelegramBusFollowerJournaledUpdateForExecution<TUpdate extends {
    message?: unknown;
} & Record<string, unknown>>(update: TUpdate, prepareForwardedMessage: (message: NonNullable<TUpdate["message"]>, position: "comment" | "forward") => void): TUpdate;
export declare function createTelegramBusFollowerDurableAdmissionRuntime<TContext>(deps: {
    journal: {
        appendBatch(updates: readonly ({
            update_id: number;
        } & Record<string, unknown>)[]): unknown;
    };
    signalWorker: (ctx: TContext) => void;
}): TelegramBusFollowerDurableAdmissionPort<TContext>;
export interface TelegramBusFollowerInputCustodyBundle<TContext> {
    acceptHandoff(input: {
        sourceRecoveryKey: string;
        recipientBindingKey: string;
        source: {
            journalBindingKey: string;
            tokenSha256: string;
            updateId: number;
        };
        handoffId: string;
    }, ctx: TContext): unknown;
    wakeSource(input: TelegramBusFollowerDurableAdmissionResult & {
        recipientBindingKey: string;
        sourceRecoveryKey: string;
        sourceClaim: {
            acquisitionId: string;
            handoffId: string;
        };
    }, ctx: TContext): void;
    resolveForwardReference(input: {
        sourceUpdateId: number;
        recipientBindingKey: string;
    }): {
        sourceRecoveryKey: string;
        source: {
            updateId: number;
            owner: {
                acquisitionId: string;
                handoffId: string;
            };
        };
    } | undefined;
}
export declare function createTelegramBusFollowerInputCustodyPorts<TContext>(deps: {
    getInputCustodyBus(): TelegramBusFollowerInputCustodyBundle<TContext> | undefined;
}): {
    isSourceReferenceAdmissionEnabled: () => boolean;
    handleInputCustodyHandoff(envelope: Extract<TelegramBusEnvelope, {
        kind: "leader.offerInputCustodyHandoff";
    }>, ctx: TContext): unknown;
    sourceReferenceAdmission: TelegramBusFollowerDurableAdmissionPort<TContext>;
    resolveInputCustodyReference(input: {
        sourceUpdateId: number;
        recipientBindingKey: string;
    }): {
        sourceRecoveryKey: string;
        source: {
            updateId: number;
            owner: {
                acquisitionId: string;
                handoffId: string;
            };
        };
    } | undefined;
};
export declare function createTelegramBusFollowerSourceReferenceAdmissionRuntime<TContext>(deps: {
    wakeSource: (input: TelegramBusFollowerDurableAdmissionResult & {
        recipientBindingKey: string;
        sourceRecoveryKey: string;
        sourceClaim: {
            acquisitionId: string;
            handoffId: string;
        };
    }, ctx: TContext) => Promise<void> | void;
}): TelegramBusFollowerDurableAdmissionPort<TContext>;
export declare function createTelegramBusForwardedUpdateReceiverRuntime<TContext>(deps: TelegramBusForwardedUpdateReceiverRuntimeDeps<TContext>): TelegramBusForwardedUpdateReceiverRuntime;
export {};
