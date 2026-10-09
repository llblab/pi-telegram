/**
 * Telegram thread binding helpers
 * Zones: multi-instance bus, Telegram UI threads, durable Workspace state
 * Owns live mappings, Workspace bindings and guarded Restore transitions; routing and transport effects stay outside.
 */
import { type TelegramTarget } from "./target.ts";
import { type TelegramApiCallOptions } from "./telegram-api.ts";
import { type TelegramLockContext, type TelegramLockRuntime, type TelegramOwnedStatePublicationOptions, type TelegramOwnedStatePublicationResult, type TelegramRuntimeStateMutation } from "./locks.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
import { type TelegramWorkspaceBindingIdentity } from "./workspace-identity.ts";
import { type TelegramWorkspaceSlotOccupancy } from "./workspace-slots.ts";
export { createTelegramWorkspaceBindingIdentity, createTelegramWorkspaceDirectoryKey, normalizeTelegramSessionId, normalizeTelegramWorkspacePath, type TelegramWorkspaceBindingIdentity, } from "./workspace-identity.ts";
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
    workspaceBindingKey?: string;
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
export type TelegramProvisionRecoveryFile = Record<string, {
    instanceId: string;
    profileKey?: string;
    leaderEpoch?: number | string;
    target: TelegramTarget & {
        threadId: number;
    };
}>;
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
export interface TelegramWorkspaceJournalSource {
    sessionId: string;
    recipientBindingKey: string;
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
    /** Exact session-qualified journal addresses; retained across session re-key. */
    journalSources?: TelegramWorkspaceJournalSource[];
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
export interface TelegramWorkspaceRelocationRequest {
    operationId: string;
    binding: TelegramWorkspaceThreadBinding;
    owner: TelegramTopicTargetRecord;
    target: TelegramTarget & {
        threadId: number;
    };
}
export interface TelegramWorkspaceRestoreRequest extends TelegramWorkspaceRelocationRequest {
    source: {
        journalBindingKey: string;
        updateIds: number[];
    };
}
export interface TelegramWorkspaceRestoreExecutor {
    instanceId: string;
    leaderEpoch: string;
}
export interface TelegramWorkspaceRestoreAuthority {
    executor: TelegramWorkspaceRestoreExecutor;
    operatorUserId: number;
    /** Exact profile, transport, session, source and Workspace-admission authority. */
    isCurrent: () => boolean;
}
export type TelegramWorkspaceRestoreRecipient = {
    kind: "leader" | "follower";
    instanceId: string;
    sessionId: string;
    generation: string;
};
/** Retained queue admission is nonterminal; queue-completed requires positive journal-owner disposition. */
export type TelegramWorkspaceRestoreSourceSettlement = {
    journalBindingKey: string;
    updateIds: number[];
} & ({
    kind: "completed";
} | {
    kind: "queued" | "queue-completed";
    receiptId: string;
    queueKind: "prompt" | "control";
});
/** Positive execution/recipient acceptance, retained before source disposition; never a source-removal ACK. */
export type TelegramWorkspaceRestoreSourceAcceptance = {
    journalBindingKey: string;
    updateId: number;
    /** SHA-256 of the exact journal entry captured by its worker owner, not a routed message projection. */
    sourceSha256: string;
    recipient: TelegramWorkspaceRestoreRecipient;
} & ({
    kind: "completed";
} | {
    kind: "forwarded";
    deliveryId: string;
    recipientBindingKey: string;
} | {
    kind: "queued";
    receiptId: string;
    queueKind: "prompt" | "control";
    queueOwnerSha256: string;
});
export interface TelegramWorkspaceRestoreIntent {
    request: TelegramWorkspaceRestoreRequest;
    operatorUserId: number;
    executor: TelegramWorkspaceRestoreExecutor;
    revision: number;
    createdAtMs: number;
    updatedAtMs: number;
    phase: "relocated" | "recipient-issued" | "ready";
    committedAtMs: number;
    recipient?: TelegramWorkspaceRestoreRecipient;
    readyRecipient?: TelegramWorkspaceRestoreRecipient;
    routing?: {
        acceptances?: TelegramWorkspaceRestoreSourceAcceptance[];
        settlements: TelegramWorkspaceRestoreSourceSettlement[];
        cleanup?: "issued" | "completed" | "not-issued";
    };
}
/** Live same-session metadata, never a legacy scoped ACK or permission to dispatch/delete. */
export type TelegramWorkspaceLiveRebindIntent = Pick<TelegramWorkspaceRestoreIntent, "request" | "operatorUserId" | "executor" | "revision" | "createdAtMs" | "updatedAtMs"> & {
    kind: "live-rebind";
    recipient: TelegramWorkspaceRestoreRecipient;
} & ({
    phase: "rebound";
    cleanup?: never;
} | {
    phase: "released";
    cleanup?: "issued";
} | {
    phase: "finished";
    cleanup: "confirmed" | "failed" | "unknown" | "not-issued";
});
/** Immutable source membership, not readiness, cancellation, or proof of complete Thread coverage. */
export interface TelegramTemporaryThreadInput {
    journalBindingKey: string;
    updateIds: number[];
}
/** Journal-owned donor discard evidence: retained manual cancellation or body-free chooser expiry, never recipient cancellation. */
export interface TelegramTemporaryThreadCancellationEvidence {
    journalBindingKey: string;
    updateId: number;
    operatorAuthorityId: string;
}
/** A bot-created routing tab with an exact creation source; it owns no Pi binding or slot. */
export interface TelegramTemporaryThreadEntry {
    source: {
        journalBindingKey: string;
        updateId: number;
    };
    /** Append-only known source groups. Missing legacy metadata never proves that the creation source was alone. */
    inputs?: TelegramTemporaryThreadInput[];
    /** Whole known groups with positively observed donor cancellation or expiry; never recipient cancellation or deletion authority. */
    cancelledInputs?: TelegramTemporaryThreadInput[];
    /** Whole known groups whose Forward was positively completed by the journal owner; never deletion authority alone. */
    completedInputs?: TelegramTemporaryThreadInput[];
    /** Whole known groups whose Forward was durably issued before local handling/queueing or follower RPC; never delivery proof or a retry grant. */
    forwardedInputs?: TelegramTemporaryThreadInput[];
    /** Published at creation only: every subsequent Forward path must record issuance; missing legacy coverage stays unknown. */
    forwardProtocol?: "one-shot-v1";
    /** Published before the sole cleanup attempt; uncertainty survives executor adoption and restart. */
    cleanupIssued?: true;
    operatorUserId: number;
    executor: TelegramWorkspaceRestoreExecutor;
    /** Unique title token; the only identity an unacknowledged creation may later be matched by. */
    token: string;
    /** `creating` is published before the one creation request, so after a crash its outcome is unknown. */
    phase: "creating" | "created";
    target?: TelegramTarget & {
        threadId: number;
    };
    revision: number;
    createdAtMs: number;
    updatedAtMs: number;
}
/** Canonical target classification only; a bound target still needs live same-session readiness proof. */
export type TelegramTemporaryThreadTargetObservation = {
    kind: "bound";
    binding: TelegramWorkspaceThreadBinding;
} | {
    kind: "temporary";
} | {
    kind: "unknown";
};
interface TelegramWorkspaceRestoreSnapshot {
    version: 1;
    profileName: string;
    tokenSha256: string;
    revision: number;
    operations: TelegramWorkspaceRestoreIntent[];
    liveRebindings?: TelegramWorkspaceLiveRebindIntent[];
    temporaryThreads?: TelegramTemporaryThreadEntry[];
}
/** Scope-bound Workspace operations; raw snapshot mutation is private to the store. */
export interface TelegramWorkspaceRestore {
    list(): TelegramWorkspaceRestoreIntent[];
    listLiveRebindings(): TelegramWorkspaceLiveRebindIntent[];
    /** Caller has saved and held the selected input; this publishes the binding, not dispatch readiness. */
    commitLiveRebind(request: TelegramWorkspaceRestoreRequest, recipient: TelegramWorkspaceRestoreRecipient, authority: TelegramWorkspaceRestoreAuthority): Promise<TelegramWorkspaceLiveRebindIntent | undefined>;
    /** Caller proves local apply for release or current live clearance for cleanup; unknown issuance never repeats. */
    advanceLiveRebind(expected: TelegramWorkspaceLiveRebindIntent, step: "release" | "issue-cleanup" | Extract<TelegramWorkspaceLiveRebindIntent, {
        phase: "finished";
    }>["cleanup"], authority: TelegramWorkspaceRestoreAuthority): TelegramWorkspaceLiveRebindIntent | undefined;
    commit(request: TelegramWorkspaceRestoreRequest, authority: TelegramWorkspaceRestoreAuthority): Promise<TelegramWorkspaceRestoreIntent | undefined>;
    adopt(expected: TelegramWorkspaceRestoreIntent, authority: TelegramWorkspaceRestoreAuthority): TelegramWorkspaceRestoreIntent | undefined;
    issueRecipient(expected: TelegramWorkspaceRestoreIntent, recipient: TelegramWorkspaceRestoreRecipient, authority: TelegramWorkspaceRestoreAuthority): {
        issued: true;
        intent: TelegramWorkspaceRestoreIntent;
    } | undefined;
    confirmReady(expected: TelegramWorkspaceRestoreIntent, acknowledged: TelegramWorkspaceRestoreRecipient, authority: TelegramWorkspaceRestoreAuthority): TelegramWorkspaceRestoreIntent | undefined;
    confirmInspectedReady(expected: TelegramWorkspaceRestoreIntent, observed: TelegramWorkspaceRestoreRecipient, authority: TelegramWorkspaceRestoreAuthority): TelegramWorkspaceRestoreIntent | undefined;
    issueRouting(expected: TelegramWorkspaceRestoreIntent, authority: TelegramWorkspaceRestoreAuthority): {
        issued: true;
        intent: TelegramWorkspaceRestoreIntent;
    } | undefined;
    recordSourceAcceptance(expected: TelegramWorkspaceRestoreIntent, evidence: TelegramWorkspaceRestoreSourceAcceptance, authority: TelegramWorkspaceRestoreAuthority): TelegramWorkspaceRestoreIntent | undefined;
    recordSourceSettlement(expected: TelegramWorkspaceRestoreIntent, evidence: TelegramWorkspaceRestoreSourceSettlement, authority: TelegramWorkspaceRestoreAuthority): TelegramWorkspaceRestoreIntent | undefined;
    issueCleanup(expected: TelegramWorkspaceRestoreIntent, authority: TelegramWorkspaceRestoreAuthority): {
        issued: true;
        intent: TelegramWorkspaceRestoreIntent;
    } | undefined;
    recordCleanup(expected: TelegramWorkspaceRestoreIntent, result: {
        target: TelegramWorkspaceRestoreRequest["target"];
        kind: "completed" | "not-issued";
    }, authority: TelegramWorkspaceRestoreAuthority): TelegramWorkspaceRestoreIntent | undefined;
    retire(expected: TelegramWorkspaceRestoreIntent, authority: TelegramWorkspaceRestoreAuthority): TelegramWorkspaceRestoreIntent | undefined;
    /** Caller proves exact operator abandonment of every original; no dispatch grant may exist. */
    retireAbandoned(expected: TelegramWorkspaceRestoreIntent, abandonedUpdateIds: readonly number[], authority: TelegramWorkspaceRestoreAuthority): TelegramWorkspaceRestoreIntent | undefined;
    listTemporaryThreads(): TelegramTemporaryThreadEntry[];
    /** Caller holds admission for effectful use. Fresh exact read grants no adoption, routing, disposition or deletion. */
    inspectTemporaryThreadTarget(expected: TelegramTemporaryThreadEntry, authority: TelegramWorkspaceRestoreAuthority): TelegramTemporaryThreadTargetObservation | undefined;
    /** Read-only veto for an already-granted in-flight attempt; never another grant, disposable classification or deletion ACK. */
    isTemporaryThreadCleanupCurrent(expected: TelegramTemporaryThreadEntry, authority: TelegramWorkspaceRestoreAuthority): boolean;
    /** Publishes `creating` before the caller's single creation request; an existing source entry is returned, never recreated. */
    reserveTemporaryThread(source: TelegramTemporaryThreadEntry["source"], token: string, authority: TelegramWorkspaceRestoreAuthority): {
        reserved: boolean;
        entry: TelegramTemporaryThreadEntry;
    } | undefined;
    /** Caller proves a fresh owner-authenticated implicit Telegram creation and exact live source under profile admission.
     * Registers that observed unbound target without issuing or fabricating a Bot API creation. */
    registerImplicitTemporaryThread(input: TelegramTemporaryThreadInput, target: TelegramTarget & {
        threadId: number;
    }, token: string, authority: TelegramWorkspaceRestoreAuthority): TelegramTemporaryThreadEntry | undefined;
    /** Records the exact acknowledged creation target; it never reopens a created entry. */
    acknowledgeTemporaryThread(expected: TelegramTemporaryThreadEntry, target: TelegramTarget & {
        threadId: number;
    }, authority: TelegramWorkspaceRestoreAuthority): TelegramTemporaryThreadEntry | undefined;
    adoptTemporaryThread(expected: TelegramTemporaryThreadEntry, authority: TelegramWorkspaceRestoreAuthority): TelegramTemporaryThreadEntry | undefined;
    /** Caller supplies exact live source/group authority; duplicate membership is read-only, never a new dispatch grant. */
    recordTemporaryThreadInput(expected: TelegramTemporaryThreadEntry, input: TelegramTemporaryThreadInput, authority: TelegramWorkspaceRestoreAuthority): TelegramTemporaryThreadEntry | undefined;
    /** Records a positively completed Forward group; the caller proves every source of the group completed. */
    /** Publishes the one-time Forward issuance fact before any RPC; a duplicate, cancelled, completed or Restore-owned group is refused. */
    recordTemporaryThreadForwardIssued(expected: TelegramTemporaryThreadEntry, input: TelegramTemporaryThreadInput, authority: TelegramWorkspaceRestoreAuthority): TelegramTemporaryThreadEntry | undefined;
    recordTemporaryThreadInputCompletion(expected: TelegramTemporaryThreadEntry, input: TelegramTemporaryThreadInput, authority: TelegramWorkspaceRestoreAuthority): TelegramTemporaryThreadEntry | undefined;
    recordTemporaryThreadInputCancellation(expected: TelegramTemporaryThreadEntry, input: TelegramTemporaryThreadInput, authority: TelegramWorkspaceRestoreAuthority, inspect: (updateId: number) => TelegramTemporaryThreadCancellationEvidence | undefined): TelegramTemporaryThreadEntry | undefined;
    /** Body-free chooser expiry may terminate an uncertain donor Forward/Restore, never accepted recipient work or a bound target. */
    recordTemporaryThreadInputExpiry(expected: TelegramTemporaryThreadEntry, input: TelegramTemporaryThreadInput, authority: TelegramWorkspaceRestoreAuthority, inspect: (updateId: number) => TelegramTemporaryThreadCancellationEvidence | undefined): TelegramTemporaryThreadEntry | undefined;
    /** Caller holds profile admission and proves fresh source/protection clearance; publication grants one attempt, never retry. */
    issueTemporaryThreadCleanup(expected: TelegramTemporaryThreadEntry, authority: TelegramWorkspaceRestoreAuthority): {
        issued: true;
        entry: TelegramTemporaryThreadEntry;
    } | undefined;
    /** Caller proves source settlement or cancellation and target disposition; this releases protection only. */
    /** `completed` names one newly completed group; every other known group must already be cancelled or completed. */
    retireTemporaryThread(expected: TelegramTemporaryThreadEntry, authority: TelegramWorkspaceRestoreAuthority, completed?: TelegramTemporaryThreadInput): TelegramTemporaryThreadEntry | undefined;
    /** New-world restart: atomically forgets this operator's Restore intents and temporary entries from previous runtime instances.
     * Caller may preserve exact unbound temporary tokens for clock-bearing sources. Committed bindings stay; nothing is rolled back, replayed or deleted here. */
    forgetPreviousWorld(authority: TelegramWorkspaceRestoreAuthority, preserveTemporaryTokens?: readonly string[]): {
        operations: TelegramWorkspaceRestoreIntent[];
        temporaryThreads: TelegramTemporaryThreadEntry[];
        liveRebindings?: TelegramWorkspaceLiveRebindIntent[];
    } | undefined;
}
export interface TelegramWorkspaceRestoreOptions {
    profileName: string;
    tokenSha256: string;
    isCurrentScope?: () => boolean;
    maxBytes?: number;
    getNowMs?: () => number;
    legacyPath?: string;
    onPublicationBoundary?: (boundary: "after-write-before-rename" | "after-rename") => void;
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
    /**
     * Present only when the leader published the intent for a registered
     * follower. Successor re-key and settlement must come from this exact
     * follower runtime or its authenticated same-process session handoff.
     */
    sourceInstanceId?: string;
}
export interface TelegramTopicTargetFile {
    version: 1;
    source: "snapshot";
    writtenAtMs: number;
    bot: TelegramBotStateSnapshot;
    threads: TelegramTopicTargetRecord[];
    identities?: TelegramThreadIdentityRecord[];
    workspaceBindings?: TelegramWorkspaceThreadBinding[];
    workspaceRetirements?: TelegramWorkspaceRetirementIntent[];
    workspaceRestore?: TelegramWorkspaceRestoreSnapshot;
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
    /** Optional caller fence supplements, never replaces, captured publication authority. */
    persist: (isCurrent?: () => boolean) => Promise<void>;
    invalidateTarget: (target: TelegramTarget, isCurrent: () => boolean, lastSyncError: string) => Promise<boolean>;
    /** Caller proves owner detachment; this does not assert Telegram Thread absence. */
    detachTargetOwner: (expected: TelegramTopicTargetRecord, isCurrent: () => boolean) => Promise<boolean>;
    /** Caller holds Workspace admission; publication uses this store's exact transport-owner fence. */
    workspaceRestore: (options: TelegramWorkspaceRestoreOptions) => TelegramWorkspaceRestore;
    /** Read-only precondition under caller-owned admission; not registration or transport authority. */
    assertWorkspaceRestoreRegistration: (candidate: {
        target: TelegramTarget;
        bindingKey?: string;
        slot?: string;
    }) => void;
    /** Runs synchronous live publication under the same evidence transaction; caller retains authentication/admission. */
    commitWorkspaceRestoreRegistration: (candidate: Parameters<TelegramTopicTargetStore["assertWorkspaceRestoreRegistration"]>[0], publish: () => void) => void;
    /** Read-only canonical observation; the callback must finish synchronously under the snapshot transaction. */
    withWorkspaceRestoreSnapshot: (expected: TelegramWorkspaceRestoreIntent | TelegramWorkspaceLiveRebindIntent, observe: (snapshot: Readonly<Pick<TelegramTopicTargetFile, "threads" | "workspaceBindings">>) => undefined) => void;
    /** Exact synchronous live-operation snapshot, including a current publication frame; no mutation, lock or authority grant. */
    withWorkspaceLiveRebindSnapshot: (expected: TelegramWorkspaceLiveRebindIntent, observe: (snapshot: Readonly<Pick<TelegramTopicTargetFile, "threads" | "workspaceBindings">>) => undefined) => void;
    /** Current live-origin ownership veto; effect callers still require Workspace admission. False is not work/recipient/deletion authority. */
    isWorkspaceLiveRebindCleanupTargetProtected: (expected: TelegramWorkspaceLiveRebindIntent) => boolean;
    /** Read-only captured identity with an optional exact manual-name result fence; no transport/session/admission grant or lock. */
    captureWorkspaceThreadRenameObservation: (binding: TelegramWorkspaceThreadBinding, owner: TelegramTopicTargetRecord) => (expectedManualThreadName?: string) => boolean;
    /** Captured read-only identity and exact absent-manual-name/automatic-title result fences; no authority grant or lock. */
    captureWorkspaceThreadResetObservation: (binding: TelegramWorkspaceThreadBinding, owner: TelegramTopicTargetRecord) => {
        isCurrent: () => boolean;
        isResultCurrent: (automaticTitle: string) => boolean;
    };
    /** Fresh strict disk read of acknowledged temporary-tab targets; throws rather than guessing absence. */
    listTemporaryThreadTargets: () => TelegramTarget[];
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
    /** Writes the non-canonical status projection to its own file; it never touches canonical state or grants authority. */
    persistStatus: () => Promise<void>;
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
    /** Metadata subset CAS only: callers prove exact-source/writer evidence; independent snapshot roots are untouched. */
    commitWorkspaceJournalEvidence: (expected: TelegramWorkspaceThreadBinding, journalBindingKeys: readonly string[], complete: boolean, journalSources?: readonly TelegramWorkspaceJournalSource[]) => TelegramWorkspaceThreadBinding | undefined;
    /** Acknowledge publication of the exact current metadata frame; never roll it back after an uncertain write. */
    persistWorkspaceJournalEvidence: (expected: TelegramWorkspaceThreadBinding, isCurrent: () => boolean) => Promise<boolean>;
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
    /** Publish a manual-name candidate without first retaining it in the dirty local projection. */
    renameByTargetAndPersist: (target: TelegramTarget, threadName: string, options: {
        updateDisplayTitle: boolean;
    }, isCurrent: () => boolean) => Promise<TelegramTopicTargetRecord | undefined>;
    clearManualNameByTarget: (target: TelegramTarget, automaticTitle: string) => TelegramTopicTargetRecord | undefined;
    /** Stage exact manual-name removal and automatic display metadata in the existing publication candidate. */
    clearManualNameByTargetAndPersist: (target: TelegramTarget, automaticTitle: string, isCurrent: () => boolean) => Promise<TelegramTopicTargetRecord | undefined>;
    allocateSlot: (profileKey: string, preferredSlot?: string, workspaceBindingKey?: string, options?: {
        excludeCurrentRecord?: boolean;
    }) => string | undefined;
    /** Claim the first reusable inactive thread for an instance, linking it to instanceId. */
    claimReusableTarget: (instanceId: string, threadName?: string) => TelegramTopicTargetRecord | undefined;
}
export declare function createTelegramCleanupTargetProtection(store: Pick<TelegramTopicTargetStore, "list"> & Partial<Pick<TelegramTopicTargetStore, "listReservations" | "listPendingProvisions" | "listPendingCleanups" | "listTemporaryThreadTargets">>, departingRecord?: TelegramTopicTargetRecord): NonNullable<ThreadReconciler.ThreadReconciliationApplyPorts["isCleanupTargetProtected"]>;
export interface TelegramTopicTargetStoreOptions {
    path: string | (() => string);
    telegramProfile?: string | (() => string | undefined);
    getNowMs?: () => number;
    canPersist?: () => boolean;
    commitPersist?: (commit: () => void) => boolean;
    consolidated?: Pick<TelegramConsolidatedWorkspaceStorageOptions, "captureAuthority" | "publishIfOwned">;
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
    store: Pick<TelegramTopicTargetStore, "list" | "listWorkspaceBindings" | "listPendingProvisions"> & {
        renameByTarget: (...args: Parameters<TelegramTopicTargetStore["renameByTarget"]>) => ReturnType<TelegramTopicTargetStore["renameByTarget"]> | Promise<ReturnType<TelegramTopicTargetStore["renameByTarget"]>>;
    };
    callApi: <TResponse>(method: string, body: Record<string, unknown>, options?: TelegramApiCallOptions) => Promise<TResponse>;
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
export declare function getTelegramThreadOwnerKey(owner: TelegramThreadOwner): string;
export declare function getTelegramThreadOwnerFromProfileKey(profileKey: string): TelegramThreadOwner;
export declare function normalizeTelegramSessionReplacementIntent(value: unknown): TelegramSessionReplacementIntent | undefined;
export declare const isTelegramWorkspaceRestoreRecipient: (value: unknown) => value is TelegramWorkspaceRestoreRecipient;
export declare function isTelegramWorkspaceRestoreRequest(value: unknown): value is TelegramWorkspaceRestoreRequest;
/** Stable acceptance scope, not a removal ACK; adoption and mutable progress cannot change it. */
export declare function getTelegramWorkspaceRestoreSourceCompletionSha256(operation: TelegramWorkspaceRestoreIntent, acceptance: TelegramWorkspaceRestoreSourceAcceptance): string;
export declare function getTelegramTemporaryThreadInputs(entry: TelegramTemporaryThreadEntry): TelegramTemporaryThreadInput[];
/** Every known group is durably cancelled or Forward-completed; still not deletion authority by itself. */
export declare function isTelegramTemporaryThreadFullyResolved(entry: TelegramTemporaryThreadEntry): boolean;
/** The unified section accepts only lossless current-format Workspace evidence, never tolerant legacy repair. */
export declare function parseTelegramWorkspaceStateSection(value: unknown, profile: string): TelegramTopicTargetFile | undefined;
export declare function resolveTelegramWorkspaceProvisionRecoveryPath(statePath: string, profileName?: string, layout?: "consolidated"): string;
export interface TelegramConsolidatedWorkspaceStorageOptions {
    getPath: () => string;
    getProfile: () => string | undefined;
    /** Exact owner/context/session grant captured before the caller's first await. */
    captureAuthority: () => (() => boolean) | undefined;
    publishIfOwned: NonNullable<TelegramLockRuntime<TelegramLockContext>["publishStateSectionIfOwned"]>;
}
export type TelegramWorkspaceStatePublication = <T>(mutate: (current: unknown) => TelegramRuntimeStateMutation<T>, publication?: Partial<Pick<TelegramOwnedStatePublicationOptions, "onPublicationBoundary" | "publishRename" | "isCurrent">>) => TelegramOwnedStatePublicationResult<T>;
/** Prepared Workspace IO adapter; transition/CAS policy remains with the existing Threads owner. */
export declare function createTelegramConsolidatedWorkspaceStorage(options: TelegramConsolidatedWorkspaceStorageOptions): {
    readRaw: () => unknown;
    read: () => TelegramTopicTargetFile | undefined;
    capturePublication(): TelegramWorkspaceStatePublication | undefined;
};
export declare function isSameTelegramProcessInstance(left: string | undefined, right: string | undefined): boolean;
/** Resolving selects a scope-bound view of the existing Workspace owner; it creates no files. */
export declare function createTelegramWorkspaceRestoreResolver(deps: {
    getProfileName: () => string | undefined;
    getBotToken: () => string | undefined;
    threadStore: Pick<TelegramTopicTargetStore, "workspaceRestore">;
    agentDir?: string;
}): () => TelegramWorkspaceRestore | undefined;
export declare function createTelegramTopicTargetStore(options: TelegramTopicTargetStoreOptions): TelegramTopicTargetStore;
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
export interface TelegramWorkspaceThreadRenameAuthority {
    context: unknown;
    sessionId?: string;
    sessionGeneration: number;
    cwd?: string;
    profileName?: string;
    botToken?: string;
    operatorUserId?: number;
    leaderEpoch?: string | number;
    ownsDirectDelivery: boolean;
    followerRegistered: boolean;
    localTarget?: TelegramTarget;
    localSlot?: string;
}
interface TelegramWorkspaceThreadNameRecipientDeps {
    store: TelegramTopicTargetStore;
    instanceId: string;
    target: TelegramTarget;
    assertAuthority: () => void;
    getAuthority: () => TelegramWorkspaceThreadRenameAuthority;
}
/** Prepared recipient identity/result fences; callers retain Workspace admission and transport effects. */
export declare function createTelegramWorkspaceThreadRenameRecipient(deps: TelegramWorkspaceThreadNameRecipientDeps): {
    assertAuthority: () => void;
    assertResult: (result: TelegramTopicTargetRecord) => void;
};
/** Exact automatic-title/absent-name result fences, separate from recipient identity and issued effects. */
export declare function createTelegramWorkspaceThreadResetRecipient(deps: TelegramWorkspaceThreadNameRecipientDeps): {
    assertAuthority: () => void;
    assertResult: (automaticTitle: string) => void;
};
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
    /** Display-mode title for a binding whose tab has no acknowledged title yet (fresh, moved or reclaimed). */
    resolveAutomaticDisplayTitle?: (binding: TelegramWorkspaceThreadBinding) => string | undefined;
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
export declare function createTelegramTopicTargetRenamer(deps: TelegramTopicTargetRenamerDeps): (request: TelegramTopicTargetRenameRequest) => Promise<TelegramTopicTargetRecord | undefined>;
export declare function createTelegramTopicTargetProvisioner(deps: TelegramTopicTargetProvisionerDeps): (request: TelegramTopicTargetProvisionRequest) => Promise<TelegramTopicTargetProvisionResult>;
