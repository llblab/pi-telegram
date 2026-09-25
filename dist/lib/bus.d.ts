/**
 * Telegram multi-instance bus protocol and IPC helpers
 * Zones: multi-instance bus, local IPC contract, live instance routing
 * Owns serializable bus envelopes, socket/auth helpers, local IPC client/server primitives,
 * cross-instance forwarding helpers, and the live follower registry model.
 */
import { type TelegramBusTransportEventRecorder, type TelegramBusTransportRetryPolicy } from "./bus-transport.ts";
import { type TelegramQueueHandoffPayload } from "./queue.ts";
import type { TelegramTarget } from "./target.ts";
import type { TelegramThreadDisplayMode } from "./config.ts";
import { type TelegramSessionReplacementIntent } from "./threads.ts";
export interface TelegramBusProcessRuntime {
    instanceId: string;
    processId: number;
    processBirthId: string;
    manualFollowerOwnerId: string;
    getLeaderSocketPath: () => string;
    getFollowerSocketPath: () => string;
}
export interface TelegramProcessBirthIdentityOptions {
    platform?: NodeJS.Platform;
    readProcStat?: (pid: number) => string;
    readDarwinProcessStart?: (pid: number) => string;
}
export type TelegramProcessBirthProof = {
    status: "proven";
    identity: string;
} | {
    status: "unverifiable";
};
export type TelegramProcessLiveness = "alive" | "dead" | "unverifiable";
export interface TelegramProcessLivenessOptions extends TelegramProcessBirthIdentityOptions {
    isProcessAlive?: (pid: number) => boolean;
}
export declare function getTelegramProcessBirthProof(pid: number, options?: TelegramProcessBirthIdentityOptions): TelegramProcessBirthProof;
export declare function getTelegramProcessBirthIdentity(pid: number, fallbackGeneration: number | string, options?: TelegramProcessBirthIdentityOptions): string;
export declare function getTelegramProcessLiveness(owner: {
    processId: number;
    processBirthId: string;
}, options?: TelegramProcessLivenessOptions): TelegramProcessLiveness;
export declare function getTelegramProcessBirthIdentityLiveness(processBirthId: string, options?: TelegramProcessLivenessOptions): TelegramProcessLiveness;
export declare function createCurrentTelegramBusProcessRuntime(input: {
    getActiveProfileName: () => string | undefined;
    pid?: number;
    parentPid?: number;
    createdAtMs?: number;
}): TelegramBusProcessRuntime;
export declare function createTelegramBusProcessRuntime(input: {
    getActiveProfileName: () => string | undefined;
    pid: number;
    parentPid: number;
    parentProcessIdentity?: string;
    createdAtMs: number;
}): TelegramBusProcessRuntime;
export declare function createTelegramBusAuthSecret(): string;
export declare const TELEGRAM_BUS_PROTOCOL_VERSION: 2;
export declare const TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION: "durable-follower-admission-v1";
export declare const TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF: "queue-handoff-v1";
export declare const TELEGRAM_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE: "input-custody-reference-v1";
export declare const TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME: "workspace-thread-rename-v1";
export declare const TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE: "thread-display-mode-v1";
export declare const TELEGRAM_BUS_CAPABILITY_DIRECTORY_DISPLAY_FORMAT: "directory-display-format-v1";
export declare const TELEGRAM_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT: "workspace-follower-auto-connect-v1";
export declare const TELEGRAM_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT: "session-replacement-intent-v1";
export interface TelegramBusProtocolIdentity {
    protocolVersion: number;
    runtimeBuild: string;
    capabilities: string[];
}
export interface TelegramBusProtocolCompatibility {
    compatible: boolean;
    reason?: "missing-identity" | "version-mismatch" | "missing-capability";
    missingCapabilities: string[];
}
export declare function createTelegramBusProtocolIdentity(input: {
    runtimeBuild: string;
    capabilities?: readonly string[];
}): TelegramBusProtocolIdentity;
export declare function createTelegramCurrentBusProtocolIdentity(capabilities?: readonly string[]): TelegramBusProtocolIdentity;
export declare function hasTelegramBusCapability(identity: TelegramBusProtocolIdentity | undefined, capability: string): boolean;
export declare function getTelegramInputCustodyPeerReadiness(followers: readonly Pick<TelegramBusFollowerView, "registrationGeneration" | "protocol">[]): ("ready" | "legacy" | "unknown")[];
export declare function getTelegramBusProtocolCompatibility(input: {
    local: TelegramBusProtocolIdentity;
    remote?: TelegramBusProtocolIdentity;
}): TelegramBusProtocolCompatibility;
export declare function getTelegramBusSocketPath(agentDir?: string, platform?: NodeJS.Platform, profileName?: string): string;
export declare function getTelegramBusFollowerSocketPath(instanceId: string, agentDir?: string, platform?: NodeJS.Platform, profileName?: string): string;
export interface TelegramBusInstanceRegistration {
    instanceId: string;
    previousInstanceId?: string;
    profileKey?: string;
    threadName?: string;
    slot?: string;
    cwd?: string;
    sessionId?: string;
    pid?: number;
    target?: TelegramTarget;
    busSocketPath?: string;
    registrationGeneration?: string;
    protocol?: TelegramBusProtocolIdentity;
    sessionGeneration?: number;
    processBirthId?: string;
    connectedAtMs: number;
}
export interface TelegramBusFollowerView extends TelegramBusInstanceRegistration {
    lastHeartbeatMs: number;
}
export declare function getTelegramFollowerTargetOwnership(input: {
    target: TelegramTarget;
    followers: readonly TelegramBusFollowerView[];
    activeThreadRecords?: readonly {
        status?: string;
        instanceId?: string;
        profileKey?: string;
        owner?: {
            kind?: string;
        };
        target: TelegramTarget;
    }[];
    currentInstanceId?: string;
}): {
    instanceId: string;
    ownerGeneration: string;
    recipientBindingKey: string;
    protocolIdentity: TelegramBusProtocolIdentity;
} | undefined;
export declare function markTelegramBusAggregateDelivery<T extends Record<string, unknown>>(body: T): T;
export declare function isTelegramBusAggregateDelivery(body: unknown): boolean;
export declare function markTelegramBusCrossTargetDelivery<T extends Record<string, unknown>>(body: T): T;
export declare function isTelegramBusCrossTargetDelivery(body: unknown): boolean;
export declare function stripTelegramBusApiMetadata<T extends Record<string, unknown>>(body: T): T;
export declare function isTelegramFollowerApiCallAllowed(input: {
    follower: TelegramBusFollowerView;
    method: string;
    args: unknown[];
    isMessageOwned?: (chatId: number, messageId: number) => boolean;
}): boolean;
export interface TelegramFollowerApiCallAuthorizationInput {
    follower: TelegramBusFollowerView;
    method: string;
    args: unknown[];
}
export declare function createTelegramFollowerApiCallAuthorizer(deps: {
    isMessageOwned(input: {
        chatId: number;
        messageId: number;
        follower: TelegramBusFollowerView;
    }): boolean;
}): (input: TelegramFollowerApiCallAuthorizationInput) => boolean;
export interface TelegramBusAgentTargetSelector {
    chatId?: number;
    threadId?: number;
    threadName?: string;
}
export interface TelegramBusAgentMessage {
    target: TelegramTarget & {
        threadId: number;
    };
    messageId: number;
    text: string;
}
export interface TelegramBusFollowerDeliveryIdentity {
    deliveryId: string;
    sourceUpdateId: number;
    recipientBindingKey: string;
    sourceRecoveryKey?: string;
    sourceClaim?: {
        acquisitionId: string;
        handoffId: string;
    };
}
export type TelegramBusForeignUpdateFailureClass = "source-update-identity-missing" | "recipient-binding-missing" | "recipient-generation-missing" | "source-reference-missing" | "recipient-ownership-stale" | "transport-failed" | "acknowledgement-missing" | "acknowledgement-rejected" | "acknowledgement-mismatched" | "durable-receipt-missing" | "durable-receipt-mismatched";
export type TelegramBusForeignUpdateSettlement = {
    status: "accepted";
    delivery: TelegramBusFollowerDeliveryIdentity;
} | {
    status: "retryable" | "terminal-rejected";
    failureClass: TelegramBusForeignUpdateFailureClass;
    message: string;
    delivery?: TelegramBusFollowerDeliveryIdentity;
    sourceUpdateId?: number;
};
export declare function createTelegramBusFollowerDeliveryIdentity(input: {
    kind: "leader.forwardCallback" | "leader.forwardReaction" | "leader.forwardMessage" | "leader.forwardEditedMessage" | "leader.wakeInputCustody";
    recipientBindingKey: string;
    sourceUpdateId: number;
    sourceRecoveryKey?: string;
    sourceClaim?: {
        acquisitionId: string;
        handoffId: string;
    };
}): TelegramBusFollowerDeliveryIdentity;
export declare function canUseTelegramBusInputCustodyReference(input: {
    local?: TelegramBusProtocolIdentity;
    remote?: TelegramBusProtocolIdentity;
}): boolean;
export declare function createTelegramBusFollowerSourceReferenceDeliveryIdentity(input: {
    kind: "leader.forwardCallback" | "leader.forwardReaction" | "leader.forwardMessage" | "leader.forwardEditedMessage" | "leader.wakeInputCustody";
    recipientBindingKey: string;
    sourceRecoveryKey: string;
    source: {
        updateId: number;
        owner: {
            acquisitionId: string;
            handoffId?: string;
        };
    };
}): TelegramBusFollowerDeliveryIdentity;
export type TelegramBusEnvelope = ({
    kind: "follower.register";
    requestId: string;
    registration: TelegramBusInstanceRegistration;
} | {
    kind: "follower.restoreWorkspace";
    requestId: string;
    registration: TelegramBusInstanceRegistration;
} | {
    kind: "follower.heartbeat";
    requestId: string;
    instanceId: string;
    registrationGeneration?: string;
    sentAtMs: number;
} | {
    kind: "follower.disconnect";
    requestId: string;
    instanceId: string;
    registrationGeneration?: string;
    sentAtMs: number;
} | {
    kind: "follower.setThreadDisplayMode";
    requestId: string;
    instanceId: string;
    registrationGeneration: string;
    mode: TelegramThreadDisplayMode;
} | {
    kind: "follower.renameThread";
    requestId: string;
    instanceId: string;
    registrationGeneration: string;
    target: TelegramTarget & {
        threadId: number;
    };
    threadName: string;
    sentAtMs: number;
} | {
    kind: "follower.resetThreadName";
    requestId: string;
    instanceId: string;
    registrationGeneration: string;
    target: TelegramTarget & {
        threadId: number;
    };
    sentAtMs: number;
} | {
    kind: "follower.publishSessionReplacement" | "follower.settleSessionReplacement";
    requestId: string;
    instanceId: string;
    registrationGeneration: string;
    intent: TelegramSessionReplacementIntent;
    sentAtMs: number;
} | {
    kind: "leader.forwardCallback";
    requestId: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    delivery: TelegramBusFollowerDeliveryIdentity;
    query: unknown;
    sentAtMs: number;
} | {
    kind: "leader.forwardReaction";
    requestId: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    delivery: TelegramBusFollowerDeliveryIdentity;
    reactionUpdate: unknown;
    sentAtMs: number;
} | {
    kind: "leader.forwardMessage";
    requestId: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    delivery: TelegramBusFollowerDeliveryIdentity;
    message: unknown;
    forwardCommentBatchPosition?: "comment" | "forward";
    sentAtMs: number;
} | {
    kind: "leader.forwardEditedMessage";
    requestId: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    delivery: TelegramBusFollowerDeliveryIdentity;
    message: unknown;
    sentAtMs: number;
} | {
    kind: "leader.offerInputCustodyHandoff";
    requestId: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    recipientBindingKey: string;
    sourceRecoveryKey: string;
    source: {
        journalBindingKey: string;
        tokenSha256: string;
        updateId: number;
    };
    handoffId: string;
    sentAtMs: number;
} | {
    kind: "leader.wakeInputCustody";
    requestId: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    delivery: TelegramBusFollowerDeliveryIdentity;
    sentAtMs: number;
} | {
    kind: "leader.replaceFollowerTarget";
    requestId: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration?: string;
    target: TelegramTarget & {
        threadId: number;
    };
    oldTarget?: TelegramTarget & {
        threadId: number;
    };
    reason: "thread-restore";
    sentAtMs: number;
} | {
    kind: "leader.offerQueueHandoff";
    requestId: string;
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
} | {
    kind: "follower.offerQueueHandoff";
    requestId: string;
    instanceId: string;
    registrationGeneration: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    donorProcessId: number;
    donorProcessBirthId: string;
    donorSessionGeneration: number;
    donorAcquisitionId: string;
    donorAcquiredAtMs: number;
    handoffToken: string;
    payload: TelegramQueueHandoffPayload;
    sentAtMs: number;
} | {
    kind: "follower.resolveAgentTarget";
    requestId: string;
    instanceId: string;
    registrationGeneration?: string;
    selector: TelegramBusAgentTargetSelector;
    sentAtMs: number;
} | {
    kind: "follower.routeAgentMessage";
    requestId: string;
    instanceId: string;
    registrationGeneration?: string;
    message: TelegramBusAgentMessage;
    sentAtMs: number;
} | {
    kind: "follower.callApi";
    requestId: string;
    instanceId: string;
    registrationGeneration?: string;
    method: string;
    args: unknown[];
    sentAtMs: number;
} | {
    kind: "bus.ack";
    requestId: string;
    ok: boolean;
    message?: string;
    result?: unknown;
    protocol?: TelegramBusProtocolIdentity;
    error?: {
        code: "commit-unknown" | "request-id-collision" | "ledger-overloaded" | "incompatible-protocol" | "stale-target" | "workspace-binding-unavailable";
        method?: string;
        chatId?: number;
        threadId?: number;
    };
}) & {
    auth?: string;
};
export type TelegramBusEnvelopeTrafficClass = "bootstrap" | "generation-fenced" | "response";
export declare function getTelegramBusEnvelopeTrafficClass(envelope: TelegramBusEnvelope): TelegramBusEnvelopeTrafficClass;
export declare function createTelegramBusRequestId(input: {
    instanceId: string;
    sequence: number;
}): string;
export declare function createTelegramBusRequestIdFactory(instanceId: string): () => string;
export declare function encodeTelegramBusEnvelope(envelope: TelegramBusEnvelope): string;
export declare function parseTelegramBusEnvelope(line: string): TelegramBusEnvelope | undefined;
export interface TelegramBusLocalServer {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    ensureEndpoint: () => Promise<boolean>;
}
export type TelegramBusSocketPathSource = string | (() => string);
export declare function resolveTelegramBusSocketPath(source: TelegramBusSocketPathSource, platform?: NodeJS.Platform | string): string;
export interface TelegramBusLocalServerDeps {
    socketPath: TelegramBusSocketPathSource;
    handleEnvelope: (envelope: TelegramBusEnvelope) => Promise<TelegramBusEnvelope | undefined> | TelegramBusEnvelope | undefined;
    recordTransportEvent?: TelegramBusTransportEventRecorder;
    beforeEndpointPublication?: () => Promise<void> | void;
    commitEndpointPublication?: (commit: () => void) => boolean;
    requestLedgerMaxEntries?: number;
    shouldDropResponse?: (request: TelegramBusEnvelope, response: TelegramBusEnvelope) => boolean;
}
export interface TelegramBusLocalClientOptions {
    socketPath: string;
    envelope: TelegramBusEnvelope;
    timeoutMs?: number;
    retry?: TelegramBusTransportRetryPolicy;
    recordTransportEvent?: TelegramBusTransportEventRecorder;
}
export interface TelegramBusForeignOwnedForwarderDeps<TMessage = unknown> {
    socketPath: TelegramBusSocketPathSource;
    createRequestId: () => string;
    getNowMs?: () => number;
    timeoutMs?: number;
    getAuthSecret?: () => string | undefined;
    getForwardCommentBatchPosition?: (message: TMessage) => "comment" | "forward" | undefined;
    localProtocolIdentity?: TelegramBusProtocolIdentity;
    validateForwardOwnership?: (ownership: TelegramBusForwardOwnership) => boolean;
    resolveInputCustodyReference?: (input: {
        sourceUpdateId: number;
        recipientBindingKey: string;
    }) => {
        sourceRecoveryKey: string;
        source: {
            updateId: number;
            owner: {
                acquisitionId: string;
                handoffId?: string;
            };
        };
    } | undefined;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface TelegramBusForwardOwnership {
    instanceId: string;
    ownerGeneration?: string;
    recipientBindingKey?: string;
    protocolIdentity?: TelegramBusProtocolIdentity;
}
export declare function isTelegramBusForwardOwnershipCurrent(expected: TelegramBusForwardOwnership, current: TelegramBusForwardOwnership | undefined): boolean;
export declare function createTelegramBusForeignOwnedUpdateForwarder<TContext, TReactionUpdate, TCallbackQuery, TMessage = unknown>(deps: TelegramBusForeignOwnedForwarderDeps<TMessage>): {
    forwardCallback: (input: {
        query: TCallbackQuery;
        ownership: TelegramBusForwardOwnership;
        ctx: TContext;
    }) => Promise<TelegramBusForeignUpdateSettlement>;
    forwardReaction: (input: {
        reactionUpdate: TReactionUpdate;
        ownership: TelegramBusForwardOwnership;
        ctx: TContext;
    }) => Promise<TelegramBusForeignUpdateSettlement>;
    forwardMessage: (input: {
        message: TMessage;
        ownership: TelegramBusForwardOwnership;
        ctx: TContext;
    }) => Promise<TelegramBusForeignUpdateSettlement>;
    forwardEditedMessage: (input: {
        message: TMessage;
        ownership: TelegramBusForwardOwnership;
        ctx: TContext;
    }) => Promise<TelegramBusForeignUpdateSettlement>;
};
export interface TelegramBusFollowerThreadRestoreHandlerDeps {
    followerRegistry: Pick<TelegramBusFollowerRegistry, "get" | "register">;
    followerTargetController: ReturnType<typeof createTelegramBusFollowerTargetController>;
    onRestored?: () => void;
}
export declare function listTelegramBusLiveThreadTargets(input: {
    leaderTarget?: TelegramTarget;
    followers: readonly TelegramBusFollowerView[];
}): TelegramTarget[];
export declare function createTelegramBusFollowerTargetController(deps: TelegramBusForeignOwnedForwarderDeps): {
    replaceTarget: (input: {
        follower: TelegramBusFollowerView;
        target: TelegramTarget & {
            threadId: number;
        };
        oldTarget?: TelegramTarget & {
            threadId: number;
        };
        reason: "thread-restore";
    }) => Promise<boolean>;
};
export declare function createTelegramBusFollowerThreadRestoreHandler(deps: TelegramBusFollowerThreadRestoreHandlerDeps): (input: {
    record: {
        instanceId?: string;
    };
    target: TelegramTarget & {
        threadId: number;
    };
    oldTarget?: TelegramTarget & {
        threadId: number;
    };
}) => Promise<boolean>;
export declare function isTelegramBusEnvelopeAuthorized(envelope: TelegramBusEnvelope, secret: string | undefined): boolean;
export declare function createUnauthorizedBusAck(requestId: string): TelegramBusEnvelope;
export declare function createTelegramBusLocalServer(deps: TelegramBusLocalServerDeps): TelegramBusLocalServer;
export declare function sendTelegramBusLocalEnvelope(options: TelegramBusLocalClientOptions): Promise<TelegramBusEnvelope | undefined>;
export interface TelegramBusFollowerRegistry {
    register: (registration: TelegramBusInstanceRegistration) => TelegramBusFollowerView;
    heartbeat: (instanceId: string, nowMs: number) => TelegramBusFollowerView | undefined;
    get: (instanceId: string) => TelegramBusFollowerView | undefined;
    getByTarget: (target: TelegramTarget) => TelegramBusFollowerView | undefined;
    list: () => TelegramBusFollowerView[];
    remove: (instanceId: string) => boolean;
    clear: () => void;
    observeUnregistered: (follower: TelegramBusFollowerView) => {
        isCurrent: () => boolean;
        release: () => void;
    };
    pruneStale: (nowMs: number, staleAfterMs: number) => TelegramBusFollowerView[];
}
export declare function createTelegramBusForwardOwnershipValidator(registry: Pick<TelegramBusFollowerRegistry, "get">): (ownership: TelegramBusForwardOwnership) => boolean;
export declare function createTelegramBusFollowerRegistry(): TelegramBusFollowerRegistry;
