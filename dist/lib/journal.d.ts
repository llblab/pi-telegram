/**
 * Telegram durable inbound update journal
 * Zones: telegram inbound, filesystem authority, crash recovery
 * Owns profile/bot-scoped raw updates, schema validation, deduplication,
 * bounded atomic publication, durable queue-receipt/failure state, and compaction.
 * It does not own polling, update execution, queue admission, or follower routing.
 */
import { type TelegramProcessLiveness } from "./bus.ts";
import { type TelegramWorkspaceAdmissionLedger, type TelegramWorkspaceAdmissionScope } from "./workspace-admission.ts";
export declare const TELEGRAM_UPDATE_JOURNAL_VERSION: 1;
export declare const TELEGRAM_UPDATE_JOURNAL_EXCLUSION_VERSION: 2;
export declare const TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION: 3;
export declare const TELEGRAM_UPDATE_JOURNAL_MAX_ENTRIES = 10000;
export declare const TELEGRAM_UPDATE_JOURNAL_MAX_BYTES: number;
export declare const TELEGRAM_UPDATE_JOURNAL_FAILURE_ID_MAX_LENGTH = 128;
export declare const TELEGRAM_UPDATE_JOURNAL_QUEUE_OWNER_ID_MAX_LENGTH = 256;
export declare const TELEGRAM_UPDATE_JOURNAL_INPUT_BINDING_MAX_LENGTH = 256;
export declare const TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_ID_MAX_LENGTH = 128;
export declare const TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_TOKEN_MIN_LENGTH = 32;
export declare const TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_TOKEN_MAX_LENGTH = 256;
export declare const TELEGRAM_UPDATE_JOURNAL_FAILURE_CLASS_MAX_LENGTH = 128;
export declare const TELEGRAM_UPDATE_JOURNAL_FAILURE_SUMMARY_MAX_LENGTH = 512;
export interface TelegramFollowerJournalDiscovery {
    paths: string[];
    complete: boolean;
}
/** Read-only discovery for canonical follower journal snapshots and segment roots. */
export declare function discoverTelegramFollowerJournalPaths(input: {
    directory: string;
    profileName?: string;
}): TelegramFollowerJournalDiscovery;
export declare const TELEGRAM_UPDATE_JOURNAL_TERMINAL_REASON_MAX_LENGTH = 256;
export declare const TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT = 256;
export declare const TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_BYTES: number;
export type TelegramUpdateJournalErrorCode = "capacity" | "conflict" | "identity-mismatch" | "invalid" | "io" | "unsupported-version" | "pairing-evidence" | "sender-denied";
export declare class TelegramUpdateJournalError extends Error {
    readonly code: TelegramUpdateJournalErrorCode;
    readonly path: string;
    constructor(code: TelegramUpdateJournalErrorCode, path: string, message: string, options?: ErrorOptions);
}
export interface TelegramUpdateJournalBotIdentity {
    botId?: number;
    tokenSha256: string;
}
export interface TelegramUpdateJournalInput {
    update_id: number;
}
export type TelegramJournaledUpdate = TelegramUpdateJournalInput & Record<string, unknown>;
export declare function getTelegramUpdateJournalAdmissionScopes(updates: readonly (TelegramUpdateJournalInput & Record<string, unknown>)[]): TelegramWorkspaceAdmissionScope[];
export type TelegramUpdateJournalEntryState = "pending" | "retry-wait" | "queued" | "failed";
export type TelegramUpdateJournalQueueKind = "prompt" | "control";
export interface TelegramUpdateJournalQueueProcessIdentity {
    processId: number;
    processBirthId: string;
}
export interface TelegramUpdateJournalQueueRuntimeIdentity extends TelegramUpdateJournalQueueProcessIdentity {
    instanceId: string;
}
export interface TelegramUpdateJournalQueueOwnerIdentity extends TelegramUpdateJournalQueueRuntimeIdentity {
    sessionGeneration: number;
}
export interface TelegramUpdateJournalQueueOwner extends TelegramUpdateJournalQueueOwnerIdentity {
    acquisitionId: string;
    acquiredAtMs: number;
    handoffId?: string;
}
export interface TelegramUpdateJournalQueueHandoff {
    handoffId: string;
    offeredAtMs: number;
    recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
}
export type TelegramUpdateJournalInputHandoff = TelegramUpdateJournalQueueHandoff;
/** V3 evidence; decoding it grants neither live execution nor Pi queue authority. */
export interface TelegramUpdateJournalInputClaim {
    phase: "ready" | "running";
    owner: TelegramUpdateJournalQueueOwner;
    recipientBindingKey: string;
    /** Present freezes ready donor execution until exact acceptance or cancellation. */
    handoff?: TelegramUpdateJournalInputHandoff;
    /** Absent means the original update; present preserves an exact routed projection. */
    executionUpdate?: TelegramJournaledUpdate;
}
/** Immutable transition evidence, never concurrent raw-input execution authority. */
export interface TelegramUpdateJournalInputProvenance {
    owner: TelegramUpdateJournalQueueOwner;
    recipientBindingKey: string;
    executionUpdate?: TelegramJournaledUpdate;
}
export interface TelegramUpdateJournalFailure {
    attemptCount: number;
    failedAtMs: number;
    failureClass: string;
    summary: string;
}
export type TelegramUpdateJournalOperatorDispositionAction = "retry" | "discard";
export interface TelegramUpdateJournalLegacyCustodyEvidence {
    updateId: number;
    state: "retry-wait" | "failed";
    attemptCount: number;
    failedAtMs: number;
    failureClass: string;
    summary: string;
    nextRetryAtMs?: number;
    terminalAtMs?: number;
    terminalReason?: string;
    terminalFailureId?: string;
    evidenceSha256: string;
}
export interface TelegramUpdateJournalLegacyCustodyCandidate {
    updateId: number;
    state: "retry-wait" | "failed";
    attemptCount: number;
    failureClass: string;
    evidenceSha256: string;
}
export declare function listTelegramUpdateJournalLegacyCustodyCandidates(snapshot: Pick<TelegramUpdateJournalSnapshot, "entries">): TelegramUpdateJournalLegacyCustodyCandidate[];
export interface TelegramUpdateJournalLegacyCustodyDispositionAuthority {
    version: 1;
    dispositionId: string;
    updateId: number;
    evidenceSha256: string;
    action: "requeue-v3" | "discard";
    operatorAuthorityId: string;
    authorizedAtMs: number;
}
export declare function createTelegramUpdateJournalLegacyCustodyEvidence(entry: TelegramUpdateJournalEntry): TelegramUpdateJournalLegacyCustodyEvidence | undefined;
export declare function normalizeTelegramUpdateJournalLegacyCustodyDispositionAuthority(value: unknown, expected: TelegramUpdateJournalLegacyCustodyEvidence): TelegramUpdateJournalLegacyCustodyDispositionAuthority | undefined;
export interface TelegramUpdateJournalTerminalOperatorDisposition {
    failureId: string;
    updateId: number;
    action: TelegramUpdateJournalOperatorDispositionAction;
    committedAtMs: number;
    attemptCount: number;
    failureClass: string;
    terminalAtMs: number;
    terminalReason: string;
}
export interface TelegramUpdateJournalLegacyCustodyDisposition {
    dispositionKind: "legacy-custody";
    failureId: string;
    updateId: number;
    action: "requeue-v3" | "discard";
    committedAtMs: number;
    evidenceSha256: string;
    operatorAuthorityId: string;
    authorizedAtMs: number;
}
export type TelegramUpdateJournalOperatorDisposition = TelegramUpdateJournalTerminalOperatorDisposition | TelegramUpdateJournalLegacyCustodyDisposition;
export interface TelegramUpdateJournalEntry {
    updateId: number;
    update: TelegramJournaledUpdate;
    /** Mandatory in v2/v3; immutable veto, never sender authorization. Absent only in legacy v1. */
    preApprovalExcluded?: boolean;
    admittedAtMs: number;
    state: TelegramUpdateJournalEntryState;
    queueKind?: TelegramUpdateJournalQueueKind;
    queueReceiptId?: string;
    queueOwner?: TelegramUpdateJournalQueueOwner;
    queueHandoff?: TelegramUpdateJournalQueueHandoff;
    inputClaim?: TelegramUpdateJournalInputClaim;
    inputProvenance?: TelegramUpdateJournalInputProvenance;
    failure?: TelegramUpdateJournalFailure;
    nextRetryAtMs?: number;
    terminalAtMs?: number;
    terminalReason?: string;
    terminalFailureId?: string;
}
export interface TelegramUpdateJournalFile {
    version: typeof TELEGRAM_UPDATE_JOURNAL_VERSION | typeof TELEGRAM_UPDATE_JOURNAL_EXCLUSION_VERSION | typeof TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION;
    revision?: number;
    acceptedThroughUpdateId?: number;
    profile: string;
    botIdentity: TelegramUpdateJournalBotIdentity;
    entries: TelegramUpdateJournalEntry[];
    operatorDispositions?: TelegramUpdateJournalOperatorDisposition[];
}
export interface TelegramUpdateJournalSnapshot extends TelegramUpdateJournalFile {
    exists: boolean;
    serializedBytes: number;
}
export interface TelegramUpdateJournalAppendResult {
    /** Retained batch sources without the immutable veto; not sender authorization. */
    nonExcludedUpdateIds: number[];
    addedUpdateIds: number[];
    duplicateUpdateIds: number[];
    entryCount: number;
    serializedBytes: number;
}
export interface TelegramUpdateJournalRemoveResult {
    removedUpdateIds: number[];
    entryCount: number;
    serializedBytes: number;
}
export interface TelegramUpdateJournalQueueReceipt {
    queueKind: TelegramUpdateJournalQueueKind;
    receiptId: string;
    sourceUpdateIds: readonly number[];
    owner: TelegramUpdateJournalQueueOwnerIdentity;
}
export interface TelegramUpdateJournalQueueResult {
    queuedUpdateIds: number[];
    duplicateUpdateIds: number[];
    queueOwner?: TelegramUpdateJournalQueueOwner;
    entryCount: number;
    serializedBytes: number;
}
export interface TelegramUpdateJournalQueuedCompletion {
    queueKind: TelegramUpdateJournalQueueKind;
    receiptId: string;
    sourceUpdateIds: readonly number[];
    queueOwner: TelegramUpdateJournalQueueOwner;
}
export interface TelegramUpdateJournalQueueHandoffInput {
    queueKind: TelegramUpdateJournalQueueKind;
    receiptId: string;
    sourceUpdateIds: readonly number[];
    expectedOwner: TelegramUpdateJournalQueueOwner;
    recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
    handoffToken: string;
}
export interface TelegramUpdateJournalQueueHandoffOfferResult {
    handoff: TelegramUpdateJournalQueueHandoff;
    previousOwner: TelegramUpdateJournalQueueOwner;
    offeredUpdateIds: number[];
    duplicate: boolean;
    entryCount: number;
    serializedBytes: number;
}
export interface TelegramUpdateJournalQueueHandoffAcceptResult {
    handoffId: string;
    previousOwner?: TelegramUpdateJournalQueueOwner;
    queueOwner: TelegramUpdateJournalQueueOwner;
    acceptedUpdateIds: number[];
    duplicate: boolean;
    entryCount: number;
    serializedBytes: number;
}
export interface TelegramUpdateJournalQueueHandoffCancelResult {
    handoffId: string;
    previousOwner: TelegramUpdateJournalQueueOwner;
    cancelledUpdateIds: number[];
    entryCount: number;
    serializedBytes: number;
}
export interface TelegramUpdateJournalQueueDiscardInput {
    queueKind: TelegramUpdateJournalQueueKind;
    receiptId: string;
    sourceUpdateIds: readonly number[];
    expectedOwner: TelegramUpdateJournalQueueOwner;
}
export interface TelegramUpdateJournalQueueDiscardResult {
    previousOwner: TelegramUpdateJournalQueueOwner;
    removedUpdateIds: number[];
    entryCount: number;
    serializedBytes: number;
}
export interface TelegramUpdateJournalDeadQueueOwnerRecoveryInput {
    queueKind: TelegramUpdateJournalQueueKind;
    receiptId: string;
    sourceUpdateIds: readonly number[];
    deadOwner: TelegramUpdateJournalQueueOwner;
    recoveryOwner: TelegramUpdateJournalQueueOwnerIdentity;
}
export type TelegramUpdateJournalDeadQueueOwnerRecoveryResult = {
    status: "owner-alive" | "owner-unverifiable";
    previousOwner: TelegramUpdateJournalQueueOwner;
    recoveredUpdateIds: [];
    entryCount: number;
    serializedBytes: number;
} | {
    status: "recovered";
    previousOwner: TelegramUpdateJournalQueueOwner;
    recoveredUpdateIds: number[];
    entryCount: number;
    serializedBytes: number;
};
export interface TelegramUpdateJournalFailureInput {
    updateId: number;
    expectedAttemptCount: number;
    failedAtMs: number;
    failureClass: string;
    summary: string;
    disposition: "retry-wait" | "failed";
    nextRetryAtMs?: number;
    terminalReason?: string;
}
export interface TelegramUpdateJournalFailureResult {
    entry: TelegramUpdateJournalEntry;
    entryCount: number;
    serializedBytes: number;
}
export interface TelegramUpdateJournalOperatorDispositionInput {
    updateId: number;
    failureId: string;
    action: TelegramUpdateJournalOperatorDispositionAction;
}
export interface TelegramUpdateJournalLegacyCustodyDispositionResult {
    disposition: TelegramUpdateJournalLegacyCustodyDisposition;
    duplicate: boolean;
    entryCount: number;
    serializedBytes: number;
}
export interface TelegramUpdateJournalOperatorDispositionResult {
    disposition: TelegramUpdateJournalTerminalOperatorDisposition;
    duplicate: boolean;
    entryCount: number;
    serializedBytes: number;
}
export interface TelegramUpdateJournalStore {
    read(): TelegramUpdateJournalSnapshot;
    appendBatch<TUpdate extends TelegramUpdateJournalInput>(updates: readonly TUpdate[], acceptedThroughUpdateId?: number): TelegramUpdateJournalAppendResult;
    markQueued(receipt: TelegramUpdateJournalQueueReceipt): TelegramUpdateJournalQueueResult;
    markExecutionFailure(input: TelegramUpdateJournalFailureInput): TelegramUpdateJournalFailureResult;
    applyOperatorDisposition(input: TelegramUpdateJournalOperatorDispositionInput): TelegramUpdateJournalOperatorDispositionResult;
    applyLegacyCustodyDisposition(authority: TelegramUpdateJournalLegacyCustodyDispositionAuthority): TelegramUpdateJournalLegacyCustodyDispositionResult;
    offerQueuedHandoff(input: TelegramUpdateJournalQueueHandoffInput): TelegramUpdateJournalQueueHandoffOfferResult;
    acceptQueuedHandoff(input: TelegramUpdateJournalQueueHandoffInput): TelegramUpdateJournalQueueHandoffAcceptResult;
    cancelQueuedHandoff(input: TelegramUpdateJournalQueueHandoffInput): TelegramUpdateJournalQueueHandoffCancelResult;
    completeQueued(receipts: readonly TelegramUpdateJournalQueuedCompletion[]): TelegramUpdateJournalRemoveResult;
    discardQueued(input: TelegramUpdateJournalQueueDiscardInput): TelegramUpdateJournalQueueDiscardResult;
    recoverDeadQueueOwner(input: TelegramUpdateJournalDeadQueueOwnerRecoveryInput): TelegramUpdateJournalDeadQueueOwnerRecoveryResult;
    removeCompleted(updateIds: readonly number[]): TelegramUpdateJournalRemoveResult;
}
export type TelegramUpdateJournalPublicationBoundary = "before-write" | "after-write-before-rename";
export interface TelegramUpdateJournalRecoveryEvent {
    kind: "repaired" | "reset";
    path: string;
    revision?: number;
    quarantinePath?: string;
    reason: string;
}
export interface TelegramUpdateJournalStoreOptions {
    path: string;
    profileName?: string;
    botIdentity: TelegramUpdateJournalBotIdentity;
    maxEntries?: number;
    maxBytes?: number;
    getNowMs?: () => number;
    onRecovery?: (event: TelegramUpdateJournalRecoveryEvent) => void;
    queueRuntimeIdentity?: TelegramUpdateJournalQueueRuntimeIdentity;
    getQueueProcessLiveness?: (owner: TelegramUpdateJournalQueueProcessIdentity) => TelegramProcessLiveness;
    /** Optional outer writer fence. Must authorize before source serialization/journal locking and must not perform journal I/O. */
    withWriterAdmission?: <T>(operation: () => T) => T;
    /** Explicit operator authority for quarantined legacy retry/failure disposition. Production omission disables mutation. */
    authorizeLegacyCustodyDisposition?: (authority: TelegramUpdateJournalLegacyCustodyDispositionAuthority) => boolean;
    /** Lock-only synchronous serialization, not source authorization or schema selection. Use the same config resource as admission hooks. */
    withSourceSerialization?: <T>(operation: () => T) => T;
    /** Opt-in strict consumption. Caller binds all gates to the same config resource and excludes other writers. */
    sourceAccess?: {
        directory: string;
        limits: {
            maxFiles: number;
            maxBytes: number;
            maxEntries: number;
            maxWork: number;
        };
    };
    /** Opt-in v2 for cursor-ordered polling admission only. Must hold config authority through synchronous publish. */
    withPairingAdmission?: <T>(publish: (preApprovalExcluded: boolean) => T) => T;
    /** Paired-only v1 gate over canonical inputs. Runs inside Workspace admission, before journal locking. */
    withPairedAdmission?: <T>(updates: readonly TelegramJournaledUpdate[], publish: () => T) => {
        admitted: false;
    } | {
        admitted: true;
        value: T;
    };
    workspaceAdmission?: Pick<TelegramWorkspaceAdmissionLedger, "acquireAdmission" | "releaseAdmission">;
    onPublicationBoundary?: (boundary: TelegramUpdateJournalPublicationBoundary, publicationPath: string) => void;
}
export interface TelegramInputJournalSourceReference {
    journalBindingKey: string;
    tokenSha256: string;
    updateId: number;
}
export interface TelegramInputJournalReceipt extends TelegramInputJournalSourceReference {
    owner: TelegramUpdateJournalQueueOwner;
}
export interface TelegramInputJournalReleaseResult {
    released: boolean;
    entryCount: number;
    serializedBytes: number;
}
export interface TelegramInputJournalRecoveryInput {
    receipt: TelegramInputJournalReceipt;
    recoveryOwner: TelegramUpdateJournalQueueOwnerIdentity;
}
export interface TelegramInputJournalRecoveryResult {
    status: "owner-alive" | "owner-unverifiable" | "unclaimed" | "recovered";
    entryCount: number;
    serializedBytes: number;
}
export interface TelegramInputJournalHandoffOfferInput {
    receipt: TelegramInputJournalReceipt;
    recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
    handoffToken: string;
}
export interface TelegramInputJournalHandoffAcceptInput {
    source: TelegramInputJournalSourceReference;
    recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
    handoffId: string;
}
export interface TelegramInputJournalHandoffCancelInput {
    receipt: TelegramInputJournalReceipt;
    recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
    handoffId: string;
}
export interface TelegramInputJournalQueueInput {
    queueKind: TelegramUpdateJournalQueueKind;
    receiptId: string;
    receipts: readonly TelegramInputJournalReceipt[];
}
export interface TelegramInputJournalQueueResult {
    queued: boolean;
    queueReceipt: TelegramUpdateJournalQueuedCompletion;
    entryCount: number;
    serializedBytes: number;
}
export interface TelegramInputJournalHandoffOfferResult {
    source: TelegramInputJournalSourceReference;
    handoff: TelegramUpdateJournalInputHandoff;
    previousOwner: TelegramUpdateJournalQueueOwner;
    duplicate: boolean;
    entryCount: number;
    serializedBytes: number;
}
export interface TelegramInputJournalHandoffAcceptResult {
    handoffId: string;
    previousOwner?: TelegramUpdateJournalQueueOwner;
    receipt: TelegramInputJournalReceipt;
    duplicate: boolean;
    entryCount: number;
    serializedBytes: number;
}
export interface TelegramInputJournalHandoffCancelResult {
    handoffId: string;
    previousOwner: TelegramUpdateJournalQueueOwner;
    cancelled: boolean;
    entryCount: number;
    serializedBytes: number;
}
export interface TelegramInputJournalStore {
    read: TelegramUpdateJournalStore["read"];
    appendBatch: TelegramUpdateJournalStore["appendBatch"];
    listLegacyCustodyCandidates(): TelegramUpdateJournalLegacyCustodyCandidate[];
    applyLegacyCustodyDisposition: TelegramUpdateJournalStore["applyLegacyCustodyDisposition"];
    /** Removes vetoed input only; an absent ID inside the retained cursor is a no-op, not completion evidence. */
    removeExcluded(updateIds: readonly number[]): TelegramUpdateJournalRemoveResult;
    acquireInput(input: {
        updateId: number;
        recipientBindingKey: string;
        executionUpdate?: TelegramJournaledUpdate;
    }): {
        acquired: boolean;
        receipt: TelegramInputJournalReceipt;
    };
    /** Returns this process's exact ready authority to the same unclaimed input. */
    releaseInput(receipt: TelegramInputJournalReceipt): TelegramInputJournalReleaseResult;
    /** Releases exact ready authority only after process-birth liveness proves its owner dead. */
    recoverReadyInput(input: TelegramInputJournalRecoveryInput): TelegramInputJournalRecoveryResult;
    /** Freezes exact ready donor authority around one persisted recipient offer. */
    offerInputHandoff(input: TelegramInputJournalHandoffOfferInput): TelegramInputJournalHandoffOfferResult;
    /** Replaces the offered donor with one exact ready recipient acquisition. */
    acceptInputHandoff(input: TelegramInputJournalHandoffAcceptInput): TelegramInputJournalHandoffAcceptResult;
    /** Unfreezes only the exact unaccepted donor offer. */
    cancelInputHandoff(input: TelegramInputJournalHandoffCancelInput): TelegramInputJournalHandoffCancelResult;
    /** Atomically replaces exact running raw acquisitions with one grouped Pi queue receipt. */
    queueInputs(input: TelegramInputJournalQueueInput): TelegramInputJournalQueueResult;
    completeQueued: TelegramUpdateJournalStore["completeQueued"];
    discardQueued: TelegramUpdateJournalStore["discardQueued"];
    recoverDeadQueueOwner: TelegramUpdateJournalStore["recoverDeadQueueOwner"];
    offerQueuedHandoff: TelegramUpdateJournalStore["offerQueuedHandoff"];
    acceptQueuedHandoff: TelegramUpdateJournalStore["acceptQueuedHandoff"];
    cancelQueuedHandoff: TelegramUpdateJournalStore["cancelQueuedHandoff"];
    /** One durable start transition, not proof that an external effect ran. Publication errors may be commit-unknown. */
    startInput(receipt: TelegramInputJournalReceipt): {
        started: false;
    } | {
        started: true;
        update: TelegramJournaledUpdate;
    };
    completeInput(receipt: TelegramInputJournalReceipt): TelegramUpdateJournalRemoveResult;
}
export interface TelegramInputJournalContext {
    owner: TelegramUpdateJournalQueueOwnerIdentity;
    recipientBindingKey: string;
}
export type TelegramInputJournalStoreOptions = Omit<TelegramUpdateJournalStoreOptions, "withPairedAdmission"> & Required<Pick<TelegramUpdateJournalStoreOptions, "sourceAccess" | "withSourceSerialization" | "withPairingAdmission" | "queueRuntimeIdentity">> & {
    /** Bound originating profile/token/session/recipient context, not transport role; undefined revokes acquisition/start/transfer. */
    getInputContext: () => TelegramInputJournalContext | undefined;
};
export interface TelegramUpdateJournalSegment {
    version: TelegramUpdateJournalFile["version"];
    revision: number;
    previousRevision: number;
    acceptedThroughUpdateId?: number;
    profile: string;
    botIdentity: TelegramUpdateJournalBotIdentity;
    upsertedEntries: TelegramUpdateJournalEntry[];
    removedUpdateIds: number[];
    operatorDispositions?: TelegramUpdateJournalOperatorDisposition[];
}
export interface TelegramUpdateJournalSegmentPublicationResult {
    path: string;
    revision: number;
    serializedBytes: number;
}
export declare function parseTelegramUpdateJournalQueueOwner(value: unknown): TelegramUpdateJournalQueueOwner | undefined;
export declare function isTelegramUpdateJournalQueueOwnerProcess(owner: TelegramUpdateJournalQueueOwner, identity: TelegramUpdateJournalQueueOwnerIdentity): boolean;
export declare function areTelegramUpdateJournalQueueOwnersEqual(left: TelegramUpdateJournalQueueOwner, right: TelegramUpdateJournalQueueOwner): boolean;
/**
 * Isolated evidence only: caller must serialize/quiesce writers before inspection
 * and consumption. Metadata checks detect observable changes, not hostile same-user
 * swaps or whole-profile completeness. No locks, recovery, or publication occurs.
 * maxFiles counts snapshot + every enumerated segment entry (one overflow witness).
 * maxBytes aggregates all retained bytes. maxEntries bounds each raw collection and
 * reconstructed collection; maxWork charges each raw/revalidated collection element.
 * JSON allocation is bounded by maxBytes before decoding; collections before codecs.
 */
export declare function inspectTelegramInputCustodySourceStatus(input: Parameters<typeof inspectTelegramUpdateJournalFamily>[0]): "absent" | "v3" | "legacy" | "unsupported" | "ambiguous";
export declare function inspectTelegramUpdateJournalFamily(input: {
    directory: string;
    path: string;
    profile: string;
    botIdentity: TelegramUpdateJournalBotIdentity;
    limits: {
        maxFiles: number;
        maxBytes: number;
        maxEntries: number;
        maxWork: number;
    };
}): {
    kind: "absent";
} | {
    kind: "present";
    file: TelegramUpdateJournalFile;
    /** Validation constraint includes the caller's input, not only observed IDs. */
    knownBotId?: number;
    accounting: {
        files: number;
        bytes: number;
        work: number;
    };
};
/**
 * Read-only source evidence for cooperating writers serialized by the caller through
 * consumption; never readiness, recovery, or permission to publish. Ancestors retain
 * canonical directory type and endpoint dev/ino/mode/uid/gid, tolerating sibling churn.
 * This deliberately loses ancestor size/nlink/mtime/ctime witnesses: no transient
 * namespace/permission/ACL continuity, inode-ABA resistance, or hostile-same-user
 * protection. Manual relocation/restore/security manipulation is outside the protocol.
 * Files and the segment directory retain full inspection checks and bounded census.
 * Identity is never enriched; accounting is physical inspection work, not store capacity.
 */
export declare function readTelegramUpdateJournalSource(input: Parameters<typeof inspectTelegramUpdateJournalFamily>[0] & {
    version: TelegramUpdateJournalFile["version"];
}): ReturnType<typeof inspectTelegramUpdateJournalFamily>;
/**
 * Canonical namespace evidence only, never source readiness or authorization.
 * Caller-proven serialization/quiescence is mandatory through consumption.
 * Recensus detects observable changes, not hostile same-user path swaps; arbitrary
 * consumer references and archive consumption require separate audits.
 */
export declare function inspectTelegramProfileJournalNamespace(input: {
    directory: string;
    profile: string;
    botIdentity: TelegramUpdateJournalBotIdentity;
    limits: {
        maxDirectoryEntries: number;
        maxFiles: number;
        maxBytes: number;
        maxEntries: number;
        maxWork: number;
    };
}): {
    sources: {
        role: "polling" | "follower";
        path: string;
        evidence: ReturnType<typeof inspectTelegramUpdateJournalFamily>;
    }[];
    accounting: {
        directoryEntries: number;
        files: number;
        bytes: number;
        work: number;
    };
    knownBotId?: number;
};
export declare function publishTelegramUpdateJournalSegment(path: string, segment: TelegramUpdateJournalSegment): TelegramUpdateJournalSegmentPublicationResult;
export declare function createTelegramUpdateQueueHandoffToken(): string;
export declare function createTelegramUpdateJournalBotIdentity(input: {
    botToken: string;
    botId?: number;
}): TelegramUpdateJournalBotIdentity;
export declare function createTelegramUpdateJournalReceiptScope(input: {
    profileName?: string;
    botIdentity: TelegramUpdateJournalBotIdentity;
}): string;
export declare function createTelegramUpdateJournalBindingKey(input: {
    path: string;
    profileName?: string;
    botIdentity: TelegramUpdateJournalBotIdentity;
}): string;
export declare function getTelegramUpdateJournalBindingPath(journalBindingKey: string): string | undefined;
export declare function createTelegramUpdateJournalReceiptScopeResolver(deps: {
    getProfileName: () => string | undefined;
    getBotToken: () => string | undefined;
    getBotId: () => number | undefined;
}): () => string | undefined;
export interface TelegramUpdateJournalRuntimeBinding {
    runtimeKey: string;
    recoveryKey: string;
    journal: TelegramUpdateJournalStore;
    readForProtection?: () => {
        entries: readonly TelegramUpdateJournalEntry[];
    };
}
export interface TelegramUpdateJournalRuntimeBindingResolverDeps {
    getProfileName: () => string | undefined;
    getBotToken: () => string | undefined;
    getBotId: () => number | undefined;
    getJournalPath: (profileName?: string) => string;
    getQueueRuntimeIdentity?: () => TelegramUpdateJournalQueueRuntimeIdentity;
    withWriterAdmission?: <T>(operation: () => T) => T;
    getWorkspaceAdmission?: () => Pick<TelegramWorkspaceAdmissionLedger, "acquireAdmission" | "releaseAdmission"> | undefined;
    onRecovery?: (event: TelegramUpdateJournalRecoveryEvent) => void;
}
export declare function createTelegramUpdateJournalRuntimeBindingResolver(deps: TelegramUpdateJournalRuntimeBindingResolverDeps): () => TelegramUpdateJournalRuntimeBinding | undefined;
export type TelegramUpdateJournalReferenceClass = "leader-lifecycle" | "follower-lifecycle" | "polling-cursor" | "polling-bootstrap" | "workspace-retirement" | "operator-disposition";
export declare function createTelegramUpdateJournalReferenceRegistry(input?: {
    maxActive?: number;
}): {
    acquire(reference: {
        referenceClass: TelegramUpdateJournalReferenceClass;
        recoveryKey: string;
    }): () => void;
    list: () => {
        referenceClass: TelegramUpdateJournalReferenceClass;
        recoveryKey: string;
    }[];
    withReference<T>(reference: {
        referenceClass: TelegramUpdateJournalReferenceClass;
        recoveryKey: string;
    }, operation: () => T): T;
};
export declare function withTelegramResolvedUpdateJournalReference<T>(input: {
    registry: ReturnType<typeof createTelegramUpdateJournalReferenceRegistry>;
    resolveBinding(): TelegramUpdateJournalRuntimeBinding | undefined;
    referenceClass: TelegramUpdateJournalReferenceClass;
    operation(binding: TelegramUpdateJournalRuntimeBinding): T;
}): T | undefined;
export interface TelegramUpdateJournalBindingRuntime {
    resolveLeader: () => TelegramUpdateJournalRuntimeBinding | undefined;
    resolveFollower: () => TelegramUpdateJournalRuntimeBinding | undefined;
    resolveActive: () => TelegramUpdateJournalRuntimeBinding | undefined;
    getActiveRecoveryKey: () => string | undefined;
    createRecipientResolver: (recipientBindingKey: string) => () => TelegramUpdateJournalRuntimeBinding | undefined;
    createPathResolver: (path: string) => () => TelegramUpdateJournalRuntimeBinding | undefined;
}
export declare function createTelegramUpdateJournalBindingRuntime(deps: {
    base: Omit<TelegramUpdateJournalRuntimeBindingResolverDeps, "getJournalPath">;
    getLeaderJournalPath: (profileName?: string) => string;
    getFollowerJournalPath: (bindingKey: string, profileName?: string) => string;
    getActiveFollowerBindingKey: () => string;
    isFollowerRegistered: () => boolean;
}): TelegramUpdateJournalBindingRuntime;
export declare function createTelegramUpdateJournalStore(options: TelegramUpdateJournalStoreOptions): TelegramUpdateJournalStore;
/** Opt-in v3 only; does not migrate old files or expose legacy unowned mutation ports. */
export declare function createTelegramInputJournalStore(options: TelegramInputJournalStoreOptions): TelegramInputJournalStore;
