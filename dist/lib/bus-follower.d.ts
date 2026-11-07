/**
 * Telegram bus follower runtime
 * Zones: multi-instance bus, follower lifecycle, manual registration
 * Owns this Pi instance's follower-side bus behavior: manual registration,
 * heartbeat, forwarded-update receiving, and follower-routed API calls.
 * It must not spawn Pi processes or create hidden Telegram-originated instances.
 */
import type { TelegramPreparedHeldCommand } from "./commands.ts";
import type { TelegramWorkspaceRestoreExecutor, TelegramWorkspaceRestoreIntent } from "./threads.ts";
import type { TelegramLiveSourceCompletionReadiness, TelegramUpdateAdmissionLifecycleRuntime } from "./updates.ts";
import { TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY, TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY, TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE, type TelegramBusAgentMessage, type TelegramBusAgentTargetSelector, type TelegramBusEnvelope, type TelegramBusFollowerQueueHandoffOffer, type TelegramBusForwardOwnership, type TelegramBusInstanceRegistration, type TelegramBusLiveRebindApplyObservation, type TelegramBusLiveRebindCommandObservation, type TelegramBusLiveRebindSaveObservation, type TelegramBusLiveRebindSettlementObservation, type TelegramBusLiveRebindWorkObservation, type TelegramBusLiveRebindWorkState, type TelegramBusProtocolIdentity, type TelegramBusSelectedMenuDeliveryObservation, type TelegramBusSelectedMenuTextEffect, type TelegramBusSocketPathSource, type TelegramBusWorkspaceRestoreObservation } from "./bus.ts";
import type { TelegramThreadDisplayMode } from "./config.ts";
import { type TelegramLockEntry, type TelegramLockState } from "./locks.ts";
import * as Machine from "./machine.ts";
import type { TelegramQueueHandoffStageResult } from "./queue.ts";
import { type TelegramTarget } from "./target.ts";
import { type TelegramApiCallOptions } from "./telegram-api.ts";
import * as Threads from "./threads.ts";
import { type TelegramWorkspaceAdmissionLedger } from "./workspace-admission.ts";
export declare const TELEGRAM_BUS_FOLLOWER_HEARTBEAT_TIMEOUT_MS = 8000;
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
export interface TelegramAttachmentPublicationRegistration {
    readonly registration: Readonly<TelegramBusInstanceRegistration>;
    readonly registrationIncarnation: string;
    readonly leaderSocketPath: string;
    readonly leaderProtocol: Readonly<TelegramBusProtocolIdentity>;
    readonly assertCurrent: () => void;
}
export interface TelegramBusFollowerRegistrationRuntime<TContext> {
    /** Private acknowledged registration evidence; not publication, receiver readiness or a source grant. */
    captureAttachmentPublicationRegistration?: () => TelegramAttachmentPublicationRegistration | undefined;
    registerWithLeader: (ctx: TContext, leader: {
        busSocketPath?: string;
        busSecret?: string;
    }, options?: {
        target?: TelegramTarget;
        previousInstanceId?: string;
        restoreWorkspace?: boolean;
        recoverConnection?: boolean;
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
    /** True only when the leader acknowledges the current registration generation right now; never changes registration state. */
    probeRegistration?: () => Promise<boolean>;
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
    /** Native acknowledged registration lifetime only; neither publication nor file/source authority. */
    capturePublicationRegistration?: () => {
        incarnation?: string;
        apiIncarnation?: string;
        isCurrent: () => boolean;
    } | undefined;
    captureArtifactRegistration?: () => {
        incarnation: string;
        isCurrent: () => boolean;
    } | undefined;
    /** Return the acknowledged session only when it matches the caller's current context. */
    getSessionId: (currentSessionId: string | undefined) => string | undefined;
    beginRecovery: () => number;
    cancelRecovery: () => void;
    waitForGeneration: (timeoutMs?: number) => Promise<string | undefined>;
    getLeaderProtocol: () => TelegramBusProtocolIdentity | undefined;
    getEligibleElectionSlots: () => readonly string[];
    setEligibleElectionSlots: (slots: readonly string[]) => void;
    /** Leader-relayed Thread capability, bound to the registration generation that received it. */
    setRelayedThreadCapability: (enabled: boolean | undefined, generation: string) => void;
    /** Fresh relayed capability of the current registration; undefined means the caller must probe itself. */
    getRelayedThreadCapability: () => boolean | undefined;
    setRegistered: (registered: boolean, target?: TelegramTarget, metadata?: {
        slot?: string;
        threadName?: string;
        displayTitle?: string;
        generation?: string;
        sessionId?: string;
        leaderProtocol?: TelegramBusProtocolIdentity;
        registrationIncarnation?: string;
        apiRegistrationIncarnation?: string;
    }) => void | {
        readonly isCurrent: () => boolean;
    };
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
    getLocalProtocol?: TelegramBusFollowerApiCallerDeps["getLocalProtocol"];
    getLeaderProtocol?: TelegramBusFollowerApiCallerDeps["getLeaderProtocol"];
    capturePublicationRegistration?: TelegramBusFollowerRegistrationState["capturePublicationRegistration"];
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
/** Structural port for run-collapsing diagnostics, implemented by the logging domain. */
export interface TelegramFailureRunLogPort {
    record: (error: unknown, details?: Record<string, unknown>) => boolean;
    settled: () => TelegramFailureRunSummaryPort | undefined;
    reset: () => void;
}
export interface TelegramFailureRunSummaryPort {
    signature: string;
    failedAttempts: number;
    suppressedFailures: number;
    failedForMs: number;
}
export interface TelegramBusFollowerApiCallerDeps {
    /** Local guarded wire admission only; neither remote publication nor Artifact authority. */
    capturePublicationRegistration?: TelegramBusFollowerRegistrationState["capturePublicationRegistration"];
    /** Private publication negotiation only; absent metadata cannot opt in an older peer. */
    getLocalProtocol?: () => TelegramBusProtocolIdentity | undefined;
    getLeaderProtocol?: () => TelegramBusProtocolIdentity | undefined;
    captureAttachmentPublicationRegistration?: () => TelegramAttachmentPublicationRegistration | undefined;
    socketPath: TelegramBusSocketPathSource;
    instanceId: string;
    createRequestId: () => string;
    getAuthSecret?: () => string | undefined;
    getRegistrationGeneration: () => string | undefined;
    waitForRegistrationGeneration?: (timeoutMs?: number) => Promise<string | undefined>;
    getNowMs?: () => number;
    timeoutMs?: number;
    /** Receives one diagnostic per call slower than `slowCallMs`; observation only. */
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    slowCallMs?: number;
}
export interface TelegramBusFollowerRegistrationRuntimeDeps<TContext extends {
    cwd?: string;
}> {
    /**
     * Collapses one sustained heartbeat failure run. Optional at this unit boundary, where an absent port records
     * every failure; the runtime assembly requires it so production always supplies the logging domain's owner.
     */
    failureLog?: TelegramFailureRunLogPort;
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
    /** The expected owner is bus-proven unresponsive; the lock CAS still requires it to be the current owner. */
    unresponsive?: boolean;
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
    /** A live acknowledged registration survives a missed heartbeat; absent means every failure re-registers. */
    probeRegistration?: () => Promise<boolean>;
    getLeaderState: () => TelegramBusFollowerLeaderState;
    setLifecyclePhase: (phase: "electing" | undefined) => void;
    updateStatus: (ctx: TContext) => void;
    promoteToLeader: (ctx: TContext, binding: TelegramBusFollowerPromotedBinding, election: TelegramBusFollowerElection) => Promise<boolean>;
    sleep?: (ms: number) => Promise<void>;
    scheduleRetry?: (retry: () => void, delayMs: number) => void;
    getActiveContext?: () => TContext | undefined;
    promotionGraceMs?: number;
    /** Bus liveness proof for a live-PID leader that no longer answers; replaces the retired file heartbeat. */
    proveLeaderUnresponsive?: (owner: TelegramLockEntry) => Promise<boolean>;
    /** Shared bot state says Threaded Mode is off: followers cannot exist, so recovery goes offline instead. */
    isThreadModeDisabled?: () => boolean | Promise<boolean>;
    recordRuntimeEvent: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface TelegramBusForwardedUpdateReceiverRuntimeDeps<TContext> {
    socketPath: TelegramBusSocketPathSource;
    instanceId: string;
    getAuthSecret?: () => string | undefined;
    getRegistrationGeneration: () => string | undefined;
    getRecipientBindingKey: () => string | undefined;
    /** Live preparation names the current journal, not the stable forwarding/profile identity. */
    getLiveRebindJournalBindingKey?: () => string | undefined;
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
    getSessionId?: () => string | undefined;
    getLeaderProtocol?: () => TelegramBusProtocolIdentity | undefined;
    getLocalProtocol?: () => TelegramBusProtocolIdentity | undefined;
    isLiveRebindSaveEnabled?: () => boolean;
    isLiveRebindApplyEnabled?: () => boolean;
    isLiveRebindSettleEnabled?: () => boolean;
    handleLiveRebindSettle?: (envelope: Extract<TelegramBusEnvelope, {
        kind: "leader.settleLiveRebind";
    }>, ctx: TContext, isCurrent: () => boolean) => Promise<TelegramBusLiveRebindSettlementObservation | TelegramBusLiveRebindWorkObservation | TelegramBusLiveRebindCommandObservation>;
    handleLiveRebindApply?: (envelope: Extract<TelegramBusEnvelope, {
        kind: "leader.applyLiveRebind";
    }>, ctx: TContext, isCurrent: () => boolean) => Promise<TelegramBusLiveRebindApplyObservation>;
    /** Availability only; never future recipient activation or a command execution grant. */
    isLiveRebindCommandSetEnabled?: () => boolean;
    handleLiveRebindSave?: (envelope: Extract<TelegramBusEnvelope, {
        kind: "leader.prepareLiveRebind";
    }>, ctx: TContext, isCurrent: () => boolean) => TelegramBusLiveRebindSaveObservation | Promise<TelegramBusLiveRebindSaveObservation>;
    isWorkspaceRestoreEnabled?: () => boolean;
    handleWorkspaceRestore?: (input: {
        operationId: string;
        registrationGeneration: string;
        mode: "apply" | "inspect";
    }, ctx: TContext) => Promise<TelegramBusWorkspaceRestoreObservation>;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface TelegramBusFollowerRuntimeAssembly<TContext> {
    receiver: TelegramBusForwardedUpdateReceiverRuntime;
    registration: TelegramBusFollowerRegistrationRuntime<TContext>;
    getReadySessionId: () => string | undefined;
}
export interface TelegramBusFollowerRuntimeAssemblyPorts<TContext extends {
    cwd?: string;
}> {
    instanceId: string;
    /** Collapses one sustained heartbeat failure run; the composition root supplies the logging domain's owner. */
    failureLog: TelegramFailureRunLogPort;
    registrationState: TelegramBusFollowerRegistrationState;
    recordRuntimeEvent: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    receiver: Omit<TelegramBusForwardedUpdateReceiverRuntimeDeps<TContext>, "instanceId" | "recordRuntimeEvent" | "getRegistrationGeneration">;
    recovery: Omit<TelegramBusFollowerHeartbeatRecoveryHandlerDeps<TContext>, "getRegistrationRuntime" | "registrationState" | "recordRuntimeEvent">;
    registration: Omit<TelegramBusFollowerRegistrationRuntimeDeps<TContext>, "startReceiving" | "stopReceiving" | "onHeartbeatFailure" | "instanceId" | "registrationState" | "recordRuntimeEvent" | "protocolIdentity"> & {
        protocolIdentity: TelegramBusProtocolIdentity;
    };
}
export declare function createTelegramBusFollowerRuntimeAssembly<TContext extends {
    cwd?: string;
}>(ports: TelegramBusFollowerRuntimeAssemblyPorts<TContext>): TelegramBusFollowerRuntimeAssembly<TContext>;
export interface TelegramBusFollowerRestoreContext {
    executor: TelegramWorkspaceRestoreExecutor;
    profileBindingKey: string;
    operatorUserId: number;
    cwd: string;
    sessionId: string;
    generation: string | number;
    leaderProtocol?: TelegramBusProtocolIdentity;
}
/** Binds Restore to real Pi lifetime and the current authenticated transport owner, not request fields. */
export declare function createTelegramBusFollowerRestoreContextGetter<TContext>(deps: {
    isContextCurrent: (ctx: TContext) => boolean;
    getSessionId: (ctx: TContext) => string | undefined;
    getCwd: (ctx: TContext) => string | undefined;
    getGeneration: () => number;
    getProfileBindingKey: () => string | undefined;
    getOperatorUserId: () => number | undefined;
    getLeaderState: () => TelegramLockState;
    getAuthenticatedSecret: () => string | undefined;
    getLeaderProtocol: () => TelegramBusProtocolIdentity | undefined;
    capability?: typeof TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE | typeof TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY | typeof TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY;
}): (ctx: TContext) => TelegramBusFollowerRestoreContext | undefined;
/** Shared canonical/local target owner and scoped live-carrier hooks; caller authenticates transport, no canonical writes or cleanup. */
export declare function createTelegramBusFollowerWorkspaceRestoreHandler<TContext>(deps: {
    instanceId: string;
    /** Captures actual Pi lifetime and authenticated leader/profile authority, never request-derived values. */
    getContextAuthority: (ctx: TContext) => TelegramBusFollowerRestoreContext | undefined;
    readRestoreIntent: (operationId: string, profileBindingKey: string) => TelegramWorkspaceRestoreIntent | undefined;
    readLiveRebindIntent?: (operationId: string, profileBindingKey: string) => Threads.TelegramWorkspaceLiveRebindIntent | undefined;
    topicTargetStore: Pick<Threads.TelegramTopicTargetStore, "load" | "withWorkspaceRestoreSnapshot"> & Partial<Pick<Threads.TelegramTopicTargetStore, "withWorkspaceLiveRebindSnapshot">>;
    registrationState: Pick<TelegramBusFollowerRegistrationState, "getTarget" | "getSlot" | "getGeneration" | "setRegistered" | "getLeaderProtocol">;
    getWorkspaceAdmission: NonNullable<TelegramBusFollowerWorkspaceAdmissionDeps["getWorkspaceAdmission"]>;
    recordRuntimeEvent?: TelegramBusFollowerWorkspaceAdmissionDeps["recordRuntimeEvent"];
}): ((input: {
    operationId: string;
    registrationGeneration: string;
    mode: "apply" | "inspect";
    liveRebind?: {
        sourceUpdateIds: readonly number[];
        isCurrent(): boolean;
        /** Captured prepared-branch target; equality must precede local apply or release grants. */
        expectedTarget?: TelegramTarget & {
            threadId: number;
        };
        release?: (canRelease: () => boolean, target: TelegramTarget & {
            threadId: number;
        }) => void;
        observeWork?: (oldTarget: TelegramTarget & {
            threadId: number;
        }) => void;
    };
}, ctx: TContext) => Promise<TelegramBusWorkspaceRestoreObservation>) & {
    /** Capture availability only; asserting current recipient requires canonical released/local-applied ownership. */
    prepareLiveCommandRecipient(input: {
        operationId: string;
        registrationGeneration: string;
        sessionId: string;
        sourceUpdateIds: readonly number[];
        target: TelegramTarget & {
            threadId: number;
        };
    }, ctx: TContext): Pick<TelegramBusFollowerCommandOwner<TContext>, "isCurrent" | "assertRecipientCurrent"> | undefined;
};
export declare function createTelegramBusFollowerClientRuntime<TContext, TReactionUpdate, TCallbackQuery, TMessage = unknown>(deps: TelegramBusFollowerClientRuntimeDeps<TMessage>): {
    createRequestId: () => string;
    callApi: TelegramBusFollowerApiCaller;
    captureApiAuthority: (scope?: "registration") => (() => void) | undefined;
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
            assertAuthority?: () => void;
        }) => Promise<import("./bus.ts").TelegramBusForeignUpdateSettlement>;
        forwardEditedMessage: (input: {
            message: TMessage;
            ownership: TelegramBusForwardOwnership;
            ctx: TContext;
        }) => Promise<import("./bus.ts").TelegramBusForeignUpdateSettlement>;
    };
    queueHandoff: (input: TelegramBusFollowerQueueHandoffOffer) => Promise<TelegramQueueHandoffStageResult>;
};
export declare function createTelegramBusFollowerQueueHandoffClient(deps: TelegramBusFollowerApiCallerDeps): (input: TelegramBusFollowerQueueHandoffOffer) => Promise<TelegramQueueHandoffStageResult>;
/** Private selected text-effect caller; not a guarded ordinary API adapter or follower command admission grant. */
export declare function createTelegramBusFollowerSelectedMenuCaller<TContext>(deps: {
    client: TelegramBusFollowerApiCallerDeps;
    protocolIdentity: TelegramBusProtocolIdentity;
    recipient: {
        getContextAuthority(ctx: TContext): TelegramBusFollowerRestoreContext | undefined;
        getJournalBindingKey(ctx: TContext): string | undefined;
        getProcessIdentity(): {
            processId: number;
            processBirthId: string;
        };
        registrationState: Pick<TelegramBusFollowerRegistrationState, "getTarget" | "getSlot" | "getGeneration" | "getLeaderProtocol">;
    };
}): (input: {
    ctx: TContext;
    operationId: string;
    registrationGeneration: string;
    effect: TelegramBusSelectedMenuTextEffect;
    assertAuthority: () => void;
}) => Promise<TelegramBusSelectedMenuDeliveryObservation>;
export type TelegramBusFollowerApiCaller = ((method: string, args: unknown[], localOptions?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<unknown>) & {
    /** Captures one already-ready negotiated native owner; never waits or grants publication/membership. */
    captureAuthority: (scope?: "registration") => (() => void) | undefined;
};
export declare function createTelegramBusFollowerApiCaller(deps: TelegramBusFollowerApiCallerDeps): TelegramBusFollowerApiCaller;
export declare function createTelegramBusFollowerSessionReplacementSuspender(deps: TelegramBusFollowerSessionReplacementSuspenderDeps): (preserveTarget?: boolean) => Promise<void>;
export declare function createTelegramBusFollowerSessionRefreshHook<TContext>(deps: TelegramBusFollowerSessionRefreshHookDeps<TContext>): (_event: unknown, ctx: TContext) => Promise<void>;
export declare function createTelegramBusFollowerControlState(): TelegramBusFollowerControlState;
export declare function createTelegramBusFollowerRegistrationState(options?: {
    onAvailabilityChanged?: () => void;
    onRegistrationChanged?: () => void;
}): TelegramBusFollowerRegistrationState;
/** Heartbeat-failure recovery that a deliberate local stop halts until the next deliberate registration. */
export type TelegramBusFollowerHeartbeatRecoveryHandler<TContext> = ((error: unknown, ctx: TContext) => Promise<void>) & {
    halt: () => void;
    resume: () => void;
};
/** The whole recovery lifecycle state; only `transitionTelegramBusFollowerRecovery` produces a new one. */
export interface TelegramBusFollowerRecoveryState {
    /** Bumped by halt and resume, so a recovery or retry from before an operator stop or connect is inert. */
    readonly epoch: number;
    readonly halted: boolean;
    /** One recovery runs at a time; it belongs to the epoch it started in. */
    readonly recovering: boolean;
    readonly retryId: number | null;
    readonly nextRetryId: number;
}
export type TelegramBusFollowerRecoveryEvent = {
    type: "recoverRequested";
} | {
    type: "recoverySettled";
    epoch: number;
} | {
    type: "retryRequested";
    epoch: number;
} | {
    type: "retryFired";
    retryId: number;
} | {
    type: "halted";
} | {
    type: "resumed";
};
export type TelegramBusFollowerRecoveryEffect = {
    type: "runRecovery";
    epoch: number;
} | {
    type: "armRetry";
    retryId: number;
} | {
    type: "cancelRetry";
    retryId: number;
};
export declare function createTelegramBusFollowerRecoveryState(): TelegramBusFollowerRecoveryState;
/**
 * Pure follower-recovery lifecycle. An operator stop halts it and a connect resumes it, each in a new epoch: work
 * from the old epoch, a recovery still awaiting or a retry still armed, can no longer register or promote.
 */
export declare function transitionTelegramBusFollowerRecovery(state: TelegramBusFollowerRecoveryState, event: TelegramBusFollowerRecoveryEvent): Machine.TelegramMachineStep<TelegramBusFollowerRecoveryState, TelegramBusFollowerRecoveryEffect>;
export declare function createTelegramBusFollowerHeartbeatRecoveryHandler<TContext>(deps: TelegramBusFollowerHeartbeatRecoveryHandlerDeps<TContext>): TelegramBusFollowerHeartbeatRecoveryHandler<TContext>;
export declare function createTelegramBusFollowerRegistrationRuntime<TContext extends {
    cwd?: string;
}>(deps: TelegramBusFollowerRegistrationRuntimeDeps<TContext>): TelegramBusFollowerRegistrationRuntime<TContext>;
export declare function prepareTelegramBusFollowerJournaledUpdateForExecution<TUpdate extends {
    message?: unknown;
} & Record<string, unknown>>(update: TUpdate, prepareForwardedMessage: (message: NonNullable<TUpdate["message"]>, position: "comment" | "forward") => void): TUpdate;
/** Existing Commands/menu assembly preflights the copied input and captures independent recipient/transport owners. */
export interface TelegramBusFollowerCommandOwner<TContext> {
    isCurrent(): boolean;
    assertRecipientCurrent(): void;
    prepare(readiness: TelegramLiveSourceCompletionReadiness, ctx: TContext, input: {
        target: TelegramTarget & {
            threadId: number;
        };
        assertSourceCurrent(): void;
        assertRecipientCurrent(): void;
    }): TelegramPreparedHeldCommand | undefined;
}
/** One current warm preparation, not a prompt queue or restart recovery record. */
export declare function createTelegramBusFollowerLiveRebindRuntime<TContext>(deps: {
    getAdmission(ctx: TContext): Pick<TelegramUpdateAdmissionLifecycleRuntime<TContext>, "prepareLiveInput" | "appendBatch" | "getJournalBindingKey"> | undefined;
    applyTarget?: (...args: Parameters<ReturnType<typeof createTelegramBusFollowerWorkspaceRestoreHandler<TContext>>>) => ReturnType<ReturnType<typeof createTelegramBusFollowerWorkspaceRestoreHandler<TContext>>>;
    observeWork?: (oldTarget: TelegramTarget & {
        threadId: number;
    }, ctx: TContext) => TelegramBusLiveRebindWorkState;
    /** Pure preflight: undefined refuses before hold/append; this port never activates future recipient authority. */
    getCommandOwner?: (input: Readonly<Omit<Extract<TelegramBusEnvelope, {
        kind: "leader.prepareLiveRebind";
    }>, "kind" | "auth" | "requestId" | "sentAtMs">>, ctx: TContext) => TelegramBusFollowerCommandOwner<TContext> | undefined;
}): {
    save(envelope: Extract<TelegramBusEnvelope, {
        kind: "leader.prepareLiveRebind";
    }>, ctx: TContext, isCurrent: () => boolean): TelegramBusLiveRebindSaveObservation;
    apply(envelope: Extract<TelegramBusEnvelope, {
        kind: "leader.applyLiveRebind";
    }>, ctx: TContext, isCurrent: () => boolean): Promise<TelegramBusLiveRebindApplyObservation>;
    settle(envelope: Extract<TelegramBusEnvelope, {
        kind: "leader.settleLiveRebind";
    }>, ctx: TContext, isCurrent: () => boolean): Promise<TelegramBusLiveRebindSettlementObservation | TelegramBusLiveRebindWorkObservation | TelegramBusLiveRebindCommandObservation>;
};
export declare function createTelegramBusFollowerDurableAdmissionRuntime<TContext>(deps: {
    journal: {
        appendBatch(updates: readonly ({
            update_id: number;
        } & Record<string, unknown>)[]): unknown;
    };
    signalWorker: (ctx: TContext) => void;
    getNowMs?: () => number;
    /** Bounded process-local replay window; omit for the production 24 h / 4,096-delivery defaults. */
    recentDeliveryLimit?: {
        maxAgeMs: number;
        maxEntries: number;
    };
}): TelegramBusFollowerDurableAdmissionPort<TContext>;
export declare function createTelegramBusForwardedUpdateReceiverRuntime<TContext>(deps: TelegramBusForwardedUpdateReceiverRuntimeDeps<TContext>): TelegramBusForwardedUpdateReceiverRuntime;
export {};
