/**
 * Telegram multi-instance bus protocol and IPC helpers
 * Zones: multi-instance bus, local IPC contract, live instance routing
 * Owns serializable bus envelopes, socket/auth helpers, local IPC client/server primitives,
 * cross-instance forwarding helpers, and the live follower registry model.
 */
import { type TelegramBusEndpointLayout, type TelegramBusTransportEventRecorder, type TelegramBusTransportRetryPolicy } from "./bus-transport.ts";
import type { TelegramThreadDisplayMode } from "./config.ts";
import { type TelegramLockEntry, type TelegramLockState } from "./locks.ts";
import { type TelegramQueueHandoffPayload } from "./queue.ts";
import { type TelegramTarget } from "./target.ts";
import { type TelegramSessionReplacementIntent } from "./threads.ts";
interface TelegramBusProcessRuntime {
    instanceId: string;
    processId: number;
    processBirthId: string;
    manualFollowerOwnerId: string;
    getLeaderSocketPath: () => string;
    getFollowerSocketPath: () => string;
}
export declare function createCurrentTelegramBusProcessRuntime(input: {
    getActiveProfileName: () => string | undefined;
    endpointLayout?: TelegramBusEndpointLayout;
    pid?: number;
    parentPid?: number;
    createdAtMs?: number;
}): TelegramBusProcessRuntime;
export declare function createTelegramBusProcessRuntime(input: {
    getActiveProfileName: () => string | undefined;
    endpointLayout?: TelegramBusEndpointLayout;
    pid: number;
    parentPid: number;
    parentProcessIdentity?: string;
    createdAtMs: number;
}): TelegramBusProcessRuntime;
export declare function createTelegramBusAuthSecret(): string;
export declare const TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION: "durable-follower-admission-v1";
export declare const TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF: "queue-handoff-v1";
/** Unspent Steer lane codec; independent from baseline receipt handoff support. */
export declare const TELEGRAM_BUS_CAPABILITY_QUEUE_STEER: "queue-steer-v1";
export declare const TELEGRAM_BUS_CAPABILITY_CONNECT_RECOVERY: "explicit-connect-recovery-v1";
export declare const TELEGRAM_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE: "input-custody-reference-v1";
export declare const TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME: "workspace-thread-rename-v1";
export declare const TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE: "thread-display-mode-v1";
export declare const TELEGRAM_BUS_CAPABILITY_DIRECTORY_DISPLAY_FORMAT: "directory-display-format-v1";
export declare const TELEGRAM_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT: "workspace-follower-auto-connect-v1";
export declare const TELEGRAM_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT: "session-replacement-intent-v1";
export declare const TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE: "workspace-restore-v1";
/** Shared Workspace readers understand independent pre-dispatch input/cleanup state. */
export declare const TELEGRAM_BUS_CAPABILITY_PRE_DISPATCH_REBIND: "live-rebind-pre-dispatch-reader-v2";
/** Shared Workspace decoder understands non-creating, unissued cancelled-orphan intents; no execution/deletion grant. */
export declare const TELEGRAM_BUS_CAPABILITY_ORPHAN_INTENT_READER: "workspace-orphan-intent-reader-v1";
/** Adds the irreversible issued marker and its original-scope/current-executor codec; independent of execution authority. */
export declare const TELEGRAM_BUS_CAPABILITY_ORPHAN_CLEANUP_READER: "workspace-orphan-intent-reader-v2";
export declare const TELEGRAM_BUS_CAPABILITY_PRE_DISPATCH_REBIND_EXECUTION: "live-rebind-pre-dispatch-v1";
export declare const TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SAVE: "live-thread-rebind-save-v1";
export declare const TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY: "live-thread-rebind-apply-v1";
export declare const TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SETTLE: "live-thread-rebind-settle-v1";
/** Restricted recipient text/menu delivery; negotiated identity and captured effect authority remain required. */
export declare const TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY: "selected-menu-delivery-v1";
/** Versioned held-command set; syntax is shared, while the captured recipient Commands registry owns supported plans. */
export declare const TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_COMMAND_SET: "live-thread-rebind-command-set-v1";
/** Every live rebinding needs the save/apply/settle trio; held command selections additionally need these two. */
export declare const TELEGRAM_BUS_LIVE_REBIND_CAPABILITIES: readonly ["live-thread-rebind-save-v1", "live-thread-rebind-apply-v1", "live-thread-rebind-settle-v1"];
export declare const TELEGRAM_BUS_HELD_COMMAND_CAPABILITIES: readonly ["live-thread-rebind-command-set-v1", "selected-menu-delivery-v1"];
/** Start/help are restricted menu aliases, negotiated separately from the original held-command set. */
export declare const TELEGRAM_BUS_CAPABILITY_HELD_MENU_ALIASES: "held-menu-aliases-v1";
export declare function getTelegramBusHeldCommandCapabilities(name: string): readonly string[];
export interface TelegramBusSelectedCommandInput {
    name: string;
    target: TelegramTarget & {
        threadId: number;
    };
}
export type TelegramBusSelectedMenuTextEffect = {
    text: string;
    parseMode?: "HTML";
    replyMarkup?: {
        inline_keyboard: {
            text: string;
            callback_data: string;
        }[][];
    };
} & ({
    kind: "send-text";
    replyToMessageId?: number;
} | {
    kind: "edit-text";
    messageId: number;
});
/** Serializable identity/effect description, never a process-local callback or standalone delivery grant. */
export interface TelegramBusSelectedMenuDelivery {
    kind: "follower.deliverSelectedMenu";
    requestId: string;
    instanceId: string;
    registrationGeneration: string;
    operationId: string;
    recipient: {
        sessionId: string;
        sessionGeneration: number;
        processId: number;
        processBirthId: string;
        profileKey: string;
        journalBindingKey: string;
        target: TelegramTarget & {
            threadId: number;
        };
    };
    executor: {
        instanceId: string;
        leaderEpoch: string;
    };
    operatorUserId: number;
    effect: TelegramBusSelectedMenuTextEffect;
    sentAtMs: number;
}
export interface TelegramBusSelectedMenuDeliveryObservation {
    operationId: string;
    recipient: TelegramBusSelectedMenuDelivery["recipient"];
    registrationGeneration: string;
    effect: TelegramBusSelectedMenuTextEffect["kind"];
    messageId: number;
}
/** Closed wire projection of prepared recipient source; independent of journal implementation and never a removal grant. */
export interface TelegramBusPreparedCommandSource {
    journalBindingKey: string;
    updateId: number;
    sourceSha256: string;
}
export interface TelegramBusLiveRebindSaveObservation {
    operationId: string;
    recipient: {
        instanceId: string;
        sessionId: string;
        generation: string;
        bindingKey: string;
    };
    sourceUpdateIds: number[];
    selectedCommand?: TelegramBusSelectedCommandInput;
    preparedSource?: TelegramBusPreparedCommandSource;
    status: "saved";
}
/** Read-only warm observation; semantic completion and exact source ACK are distinct from detached delivery. */
export interface TelegramBusLiveRebindCommandObservation extends Omit<TelegramBusLiveRebindSaveObservation, "status" | "preparedSource" | "selectedCommand"> {
    status: "command-observed";
    selectedCommand: TelegramBusSelectedCommandInput;
    preparedSource: TelegramBusPreparedCommandSource;
    command: "completed" | "unknown" | "not-issued";
    sourceAck?: TelegramBusPreparedCommandSource;
}
export interface TelegramBusLiveRebindWorkState {
    sessionBusy: boolean;
    targetWork: boolean;
    deliveryPending: boolean;
    unknown: boolean;
}
export interface TelegramBusLiveRebindWorkObservation extends Omit<TelegramBusLiveRebindSaveObservation, "status"> {
    status: "observed";
    oldTarget: TelegramTarget & {
        threadId: number;
    };
    work: TelegramBusLiveRebindWorkState;
}
export interface TelegramBusLiveRebindSettlementObservation extends Omit<TelegramBusLiveRebindSaveObservation, "status"> {
    action: "release" | "discard";
    status: "released" | "discarded" | "protected" | "unknown";
}
export interface TelegramBusLiveRebindApplyObservation extends Omit<TelegramBusLiveRebindSaveObservation, "status"> {
    status: "saved" | "applied";
    target: TelegramTarget & {
        threadId: number;
    };
    slot: string;
}
export interface TelegramBusWorkspaceRestoreObservation {
    operationId: string;
    recipient: {
        kind: "follower";
        instanceId: string;
        sessionId: string;
        generation: string;
    };
    target: TelegramTarget & {
        threadId: number;
    };
    slot: string;
    ready: boolean;
}
export interface TelegramBusProtocolIdentity {
    protocolVersion: number;
    runtimeBuild: string;
    capabilities: string[];
}
interface TelegramBusProtocolCompatibility {
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
export declare function hasTelegramBusSteerQueueHandoffCapability(identity: TelegramBusProtocolIdentity | undefined): boolean;
/** Both peers advertise every required capability over a compatible protocol; reads only the two identities. */
export declare function hasTelegramBusSharedCapabilities(local: TelegramBusProtocolIdentity, remote: TelegramBusProtocolIdentity | undefined, required: readonly string[]): boolean;
export declare function getTelegramBusProtocolCompatibility(input: {
    local: TelegramBusProtocolIdentity;
    remote?: TelegramBusProtocolIdentity;
}): TelegramBusProtocolCompatibility;
export declare function getTelegramBusSocketPath(agentDir?: string, platform?: NodeJS.Platform, profileName?: string, layout?: TelegramBusEndpointLayout): string;
export declare function getTelegramBusFollowerSocketPath(instanceId: string, agentDir?: string, platform?: NodeJS.Platform, profileName?: string, layout?: TelegramBusEndpointLayout): string;
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
    /** Leader-owned identity; never accepted from a registering peer. */
    registrationIncarnation?: string;
    lastHeartbeatMs: number;
}
/** Whether a live follower is still exactly the captured registration: identity, process, session, endpoint and negotiated protocol. */
export declare function isSameTelegramBusFollowerRegistration(live: TelegramBusInstanceRegistration, captured: TelegramBusInstanceRegistration): boolean;
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
export declare function markTelegramBusCrossTargetDelivery<T extends Record<string, unknown>>(body: T): T;
export declare function stripTelegramBusApiMetadata<T extends Record<string, unknown>>(body: T): T;
export declare function isTelegramFollowerApiCallAllowed(input: {
    follower: TelegramBusFollowerView;
    method: string;
    args: unknown[];
    isMessageOwned?: (chatId: number, messageId: number) => boolean;
}): boolean;
interface TelegramFollowerApiCallAuthorizationInput {
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
type TelegramBusForeignUpdateFailureClass = "source-update-identity-missing" | "recipient-binding-missing" | "recipient-generation-missing" | "source-reference-missing" | "recipient-ownership-stale" | "transport-failed" | "acknowledgement-missing" | "acknowledgement-rejected" | "acknowledgement-mismatched" | "durable-receipt-missing" | "durable-receipt-mismatched";
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
    recoverConnection?: true;
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
    kind: "leader.prepareLiveRebind";
    requestId: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    recipientSessionId: string;
    recipientBindingKey: string;
    operationId: string;
    updates: ({
        update_id: number;
    } & Record<string, unknown>)[];
    selectedCommand?: TelegramBusSelectedCommandInput;
    sentAtMs: number;
} | {
    kind: "leader.applyLiveRebind";
    requestId: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    recipientSessionId: string;
    recipientBindingKey: string;
    operationId: string;
    sourceUpdateIds: number[];
    mode: "apply" | "inspect";
    preparedSource?: TelegramBusPreparedCommandSource;
    selectedCommand?: TelegramBusSelectedCommandInput;
    sentAtMs: number;
} | {
    kind: "leader.settleLiveRebind";
    requestId: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    recipientSessionId: string;
    recipientBindingKey: string;
    operationId: string;
    sourceUpdateIds: number[];
    mode: "release" | "discard" | "observe" | "observe-held" | "observe-command";
    oldTarget?: TelegramTarget & {
        threadId: number;
    };
    preparedSource?: TelegramBusPreparedCommandSource;
    selectedCommand?: TelegramBusSelectedCommandInput;
    sentAtMs: number;
} | {
    kind: "leader.workspaceRestore";
    requestId: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    operationId: string;
    mode: "apply" | "inspect";
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
} | TelegramBusSelectedMenuDelivery | {
    kind: "follower.callApi";
    requestId: string;
    instanceId: string;
    registrationGeneration?: string;
    /** Ordinary API binding identity from the original acknowledged registry row. */
    apiRegistrationIncarnation?: string;
    /** Private Attachment publication; fences the acknowledged recipient before HTTP. */
    attachmentRegistrationIncarnation?: string;
    method: string;
    args: unknown[];
    sentAtMs: number;
} | {
    /** Side-effect-free leader liveness probe; any acknowledgement proves a responsive event loop. */
    kind: "bus.probe";
    requestId: string;
} | {
    kind: "bus.ack";
    requestId: string;
    ok: boolean;
    message?: string;
    result?: unknown;
    protocol?: TelegramBusProtocolIdentity;
    error?: {
        code: "commit-unknown" | "request-id-collision" | "ledger-overloaded" | "incompatible-protocol" | "stale-target" | "follower-api-not-allowed" | "workspace-binding-unavailable";
        method?: string;
        chatId?: number;
        threadId?: number;
    };
}) & {
    auth?: string;
};
/** Follower-staged queue handoff offer before the follower adds its own request and registration framing. */
export type TelegramBusFollowerQueueHandoffOffer = Omit<Extract<TelegramBusEnvelope, {
    kind: "follower.offerQueueHandoff";
}>, "kind" | "requestId" | "instanceId" | "registrationGeneration" | "sentAtMs" | "auth">;
/** Leader-routed queue handoff offer as donors and leaders exchange it before envelope framing. */
export type TelegramBusLeaderQueueHandoffOffer = Omit<Extract<TelegramBusEnvelope, {
    kind: "leader.offerQueueHandoff";
}>, "kind">;
type TelegramBusEnvelopeTrafficClass = "bootstrap" | "generation-fenced" | "response";
export declare function getTelegramBusEnvelopeTrafficClass(envelope: TelegramBusEnvelope): TelegramBusEnvelopeTrafficClass;
export declare function createTelegramBusRequestId(input: {
    instanceId: string;
    sequence: number;
}): string;
export declare function createTelegramBusRequestIdFactory(instanceId: string): () => string;
export declare function encodeTelegramBusEnvelope(envelope: TelegramBusEnvelope): string;
export declare function parseTelegramBusEnvelope(line: string): TelegramBusEnvelope | undefined;
/**
 * One leader liveness observation. `silent` (connected or connecting, no answer within the window) and
 * `unreachable` (an endpoint that refuses connections: nobody listens) can support a takeover. A missing endpoint is
 * `unknown`: a live classic-mode leader has no socket at all. Any bytes or an orderly close prove the peer's event
 * loop handled the connection, so even an older leader rejecting the unknown kind is `responsive`.
 */
export type TelegramBusLeaderProbeResult = "responsive" | "silent" | "unreachable" | "unknown";
export declare function probeTelegramBusLeader(input: {
    socketPath: TelegramBusSocketPathSource;
    secret?: string;
    timeoutMs?: number;
}): Promise<TelegramBusLeaderProbeResult>;
/**
 * Takeover evidence replacing the retired file heartbeat: a full silent window, or an unreachable endpoint
 * confirmed again after one more window (a just-started leader binds its socket well within it). The owner must
 * stay the same throughout; the lock acquisition then CAS-checks that exact owner.
 */
export declare function proveTelegramBusLeaderUnresponsive(input: {
    probe: () => Promise<TelegramBusLeaderProbeResult>;
    isSameOwner: () => boolean;
    sleep: (ms: number) => Promise<void>;
    windowMs?: number;
}): Promise<boolean>;
/** Composition-ready takeover proof for one profile's leader lock and endpoint. */
export declare function createTelegramBusLeaderUnresponsivenessProof(deps: {
    getLeaderState: () => TelegramLockState;
    getLeaderSocketPath: () => string;
    probe?: typeof probeTelegramBusLeader;
    sleep?: (ms: number) => Promise<void>;
}): (owner: TelegramLockEntry) => Promise<boolean>;
interface TelegramBusLocalServer {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    ensureEndpoint: () => Promise<boolean>;
}
export type TelegramBusSocketPathSource = string | (() => string);
export declare function resolveTelegramBusSocketPath(source: TelegramBusSocketPathSource, platform?: NodeJS.Platform | string): string;
interface TelegramBusLocalServerDeps {
    socketPath: TelegramBusSocketPathSource;
    handleEnvelope: (envelope: TelegramBusEnvelope) => Promise<TelegramBusEnvelope | undefined> | TelegramBusEnvelope | undefined;
    recordTransportEvent?: TelegramBusTransportEventRecorder;
    beforeEndpointPublication?: () => Promise<void> | void;
    commitEndpointPublication?: (commit: () => void) => boolean;
    requestLedgerMaxEntries?: number;
    /** Artifact-only gate, called before every lookup and again before releasing an ACK. */
    captureArtifactAuthority?: (envelope: Extract<TelegramBusEnvelope, {
        kind: "follower.callApi";
    }>) => (() => boolean) | undefined;
    shouldDropResponse?: (request: TelegramBusEnvelope, response: TelegramBusEnvelope) => boolean;
}
/** Local IPC issuance proof only: this callback/error never enters the envelope or certifies a remote API effect. */
export declare class TelegramBusLocalAuthorityError extends Error {
    readonly requestIssued: boolean;
    constructor(requestIssued: boolean, reason?: string);
}
/** Origin-local proof only; never serialized as a remote execution grant. */
export declare class TelegramBusArtifactIpcError extends Error {
    readonly requestIssued: boolean;
    constructor(requestIssued: boolean, cause: unknown);
}
interface TelegramBusLocalClientOptions {
    assertAuthority?: () => void;
    onRequestIssued?: () => void;
    socketPath: string;
    envelope: TelegramBusEnvelope;
    timeoutMs?: number;
    retry?: TelegramBusTransportRetryPolicy;
    recordTransportEvent?: TelegramBusTransportEventRecorder;
}
interface TelegramBusForeignOwnedForwarderDeps<TMessage = unknown> {
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
        /** Process-local source/recipient lifetime; never part of the wire envelope. */
        assertAuthority?: () => void;
    }) => Promise<TelegramBusForeignUpdateSettlement>;
    forwardEditedMessage: (input: {
        message: TMessage;
        ownership: TelegramBusForwardOwnership;
        ctx: TContext;
    }) => Promise<TelegramBusForeignUpdateSettlement>;
};
export declare function listTelegramBusLiveThreadTargets(input: {
    leaderTarget?: TelegramTarget;
    followers: readonly TelegramBusFollowerView[];
}): TelegramTarget[];
/** Caller owns the durable one-shot apply grant. Inspections never grant another apply. */
export declare function createTelegramBusWorkspaceRestoreController(deps: {
    getFollower: (instanceId: string) => TelegramBusFollowerView | undefined;
    localProtocolIdentity: TelegramBusProtocolIdentity;
    createRequestId: () => string;
    getAuthSecret: () => string | undefined;
    timeoutMs?: number;
}): (input: {
    operationId: string;
    instanceId: string;
    sessionId: string;
    slot: string;
    target: TelegramTarget & {
        threadId: number;
    };
    oldTarget: TelegramTarget & {
        threadId: number;
    };
    mode: "apply" | "inspect";
    isCurrent: () => boolean;
}) => Promise<TelegramBusWorkspaceRestoreObservation | undefined>;
/** Each capability has its own effect boundary; transport retries never replay save/dispatch/disposal. */
export declare function createTelegramBusLiveRebindController(deps: {
    getFollower(instanceId: string): TelegramBusFollowerView | undefined;
    localProtocolIdentity: TelegramBusProtocolIdentity;
    createRequestId(): string;
    getAuthSecret(): string | undefined;
    timeoutMs?: number;
}): (input: {
    operationId: string;
    instanceId: string;
    sessionId: string;
    recipientBindingKey: string;
    isCurrent(): boolean;
    selectedCommand?: TelegramBusSelectedCommandInput;
    preparedSource?: TelegramBusPreparedCommandSource;
} & ({
    updates: ({
        update_id: number;
    } & Record<string, unknown>)[];
} | {
    mode: "apply" | "inspect" | "release" | "discard" | "observe" | "observe-held" | "observe-command";
    sourceUpdateIds: number[];
    slot: string;
    target: TelegramTarget & {
        threadId: number;
    };
    oldTarget: TelegramTarget & {
        threadId: number;
    };
})) => Promise<TelegramBusLiveRebindSaveObservation | TelegramBusLiveRebindApplyObservation | TelegramBusLiveRebindSettlementObservation | TelegramBusLiveRebindWorkObservation | TelegramBusLiveRebindCommandObservation | undefined>;
export declare function isTelegramBusEnvelopeAuthorized(envelope: TelegramBusEnvelope, secret: string | undefined): boolean;
/** Negative acknowledgement carrying only a diagnostic message. */
export declare const TELEGRAM_BUS_FOLLOWER_API_NOT_ALLOWED_MESSAGE = "Telegram bus API call is not allowed for this follower.";
export declare function rejectTelegramBusRequest(requestId: string, message: string): Extract<TelegramBusEnvelope, {
    kind: "bus.ack";
}>;
export declare function createUnauthorizedBusAck(requestId: string): TelegramBusEnvelope;
export declare function createTelegramBusLocalServer(deps: TelegramBusLocalServerDeps): TelegramBusLocalServer;
export declare function sendTelegramBusLocalEnvelope(options: TelegramBusLocalClientOptions): Promise<TelegramBusEnvelope | undefined>;
/** Ordinary guarded call authority only; neither question membership nor Input receiver readiness. */
export declare const TELEGRAM_BUS_CAPABILITY_GUARDED_API_AUTHORITY: "guarded-api-authority-v1";
/** Existing registry incarnation, acknowledged independently of Artifact and matched by guarded API calls. */
export declare const TELEGRAM_BUS_CAPABILITY_API_REGISTRATION_AUTHORITY: "api-registration-authority-v1";
/** Private publication contract only; never add to production advertisement before input privacy readiness. */
export declare const TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION: "attachment-original-publication-v1";
export declare const TELEGRAM_BUS_ATTACHMENT_PUBLICATION_RECEIPT: "__piTelegramAttachmentPublication";
export interface TelegramBusAttachmentPublicationReceipt {
    readonly version: 1;
    readonly requestId: string;
    readonly nonce: string;
    readonly instanceId: string;
    readonly registrationGeneration: string;
    readonly registrationIncarnation: string;
    readonly botId: number;
    readonly messageId: number;
    readonly target: Readonly<TelegramTarget>;
}
/** Private decoded-data evidence, not a receiver, source submission or business grant. */
export declare function parseTelegramBusAttachmentPublicationReceipt(raw: unknown): Readonly<TelegramBusAttachmentPublicationReceipt> | undefined;
export declare const TELEGRAM_BUS_CAPABILITY_ARTIFACT_DOCUMENT: "artifact-document-v1";
export interface TelegramBusArtifactDocument {
    version: 1;
    registrationIncarnation: string;
    target: TelegramTarget;
    fileName: string;
    byteLength: number;
    bytesBase64: string;
    caption?: string;
    expiresAt: number;
}
/** Strict bounded wire validation does not decode bytes or grant source/business authority. */
export declare function parseTelegramBusArtifactDocument(args: unknown[]): TelegramBusArtifactDocument | undefined;
export interface TelegramBusFollowerRegistry {
    register: (registration: TelegramBusInstanceRegistration) => TelegramBusFollowerView;
    /** Native registry lifetime only; not Artifact, publication or source custody authority. */
    captureRegistration?: (instanceId: string, generation: string) => (() => boolean) | undefined;
    captureArtifactRegistration?: (instanceId: string, incarnation: string) => (() => boolean) | undefined;
    /** Native whole-roster codec compatibility; membership churn spends the capture, heartbeat alone does not. Not a write grant. */
    captureOrphanIntentReaderCompatibility?: (local: TelegramBusProtocolIdentity, mode?: "intent" | "cleanup") => (() => boolean) | undefined;
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
/** Shared closed text-effect codec; parsing alone supplies no recipient or issuance authority. */
export declare function parseTelegramBusSelectedMenuTextEffect(effect: unknown): TelegramBusSelectedMenuTextEffect | undefined;
export {};
