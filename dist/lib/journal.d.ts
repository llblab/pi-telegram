/**
 * Telegram durable inbound update journal
 * Zones: telegram inbound, filesystem authority, crash recovery
 * Owns profile/bot-scoped raw updates, schema validation, deduplication,
 * bounded atomic publication, durable queue-receipt/failure state, and compaction.
 * It does not own polling, update execution, queue admission, or follower routing.
 */
import { type TelegramProcessLiveness } from "./process-identity.ts";
import { type TelegramWorkspaceAdmissionLedger, type TelegramWorkspaceAdmissionScope } from "./workspace-admission.ts";
export declare const TELEGRAM_UPDATE_JOURNAL_VERSION: 1;
export declare const TELEGRAM_UPDATE_JOURNAL_EXCLUSION_VERSION: 2;
export declare const TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION: 3;
declare const TELEGRAM_UPDATE_JOURNAL_PRIVATE_TEXT_VERSION: 4;
export declare const TELEGRAM_UPDATE_JOURNAL_QUEUE_OWNER_ID_MAX_LENGTH = 256;
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
/** Bounded read-only session-family discovery, not writer closure or deletion authority. */
export declare function discoverTelegramSessionJournalPaths(input: {
    directory: string;
    profileName?: string;
    maxDirectoryEntries?: number;
}): TelegramFollowerJournalDiscovery;
/** Transitional discovery covers both retained flat recipients and session-owned families. */
export declare function discoverTelegramRecipientJournalPaths(input: {
    directory: string;
    profileName?: string;
}): TelegramFollowerJournalDiscovery;
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
export declare const TELEGRAM_ROUTING_INPUT_TTL_MS: number;
/** A source-only choice deadline, never a queue lease or a Thread deletion grant. */
/** Where a source's chooser was published, so a restarted owner can revive that exact message. */
export interface TelegramUpdateJournalRoutingChooser {
    chatId: number;
    threadId?: number;
    messageId: number;
}
export interface TelegramUpdateJournalRoutingInput {
    operatorUserId: number;
    publishedAtMs: number;
    expiresAtMs: number;
    phase: "waiting" | "selected";
    chooser?: TelegramUpdateJournalRoutingChooser;
}
export interface TelegramUpdateJournalEntry {
    updateId: number;
    update: TelegramJournaledUpdate;
    /** Mandatory in v2/v3; immutable veto, never sender authorization. Absent only in legacy v1. */
    preApprovalExcluded?: boolean;
    admittedAtMs: number;
    routingInput?: TelegramUpdateJournalRoutingInput;
    state: TelegramUpdateJournalEntryState;
    queueKind?: TelegramUpdateJournalQueueKind;
    queueReceiptId?: string;
    queueOwner?: TelegramUpdateJournalQueueOwner;
    queueHandoff?: TelegramUpdateJournalQueueHandoff;
    inputClaim?: TelegramUpdateJournalInputClaim;
    inputProvenance?: TelegramUpdateJournalInputProvenance;
    privateTextReply?: TelegramJournalPrivateTextReply;
    failure?: TelegramUpdateJournalFailure;
    nextRetryAtMs?: number;
    terminalAtMs?: number;
    terminalReason?: string;
    terminalFailureId?: string;
}
/** Bounded persisted evidence only; callers own semantic original-receiver verification. */
export interface TelegramJournalPrivateTextReplyDestination {
    profile: string;
    botIdentity: {
        botId: number;
        tokenSha256: string;
    };
    operatorUserId: number;
    sourceTarget: {
        chatId: number;
        threadId?: number;
    };
    sourceMessageId: number;
    publicationTarget: {
        chatId: number;
        threadId?: number;
    };
    publicationMessageId: number;
    requestNonce: string;
    receiver: {
        instanceId: string;
        profileKey: string;
        bindingKey: string;
        registrationGeneration: string;
        sessionId: string;
        sessionGeneration: number;
        pid: number;
        processBirthId: string;
        cwd: string;
        endpoint: string;
        slot?: string;
        target?: {
            chatId: number;
            threadId?: number;
        };
        protocol: {
            protocolVersion: number;
            runtimeBuild: string;
            capabilities: string[];
        };
    };
}
/** Opt-in v5 candidate data only; neither receiver liveness nor a submission/disposition receipt. */
export interface TelegramJournalTextInputAssociation {
    source: TelegramInputJournalSourceReference;
    expectedSource: TelegramUpdateJournalEntryDigest;
    requestNonce: string;
    operatorUserId: number;
    target: {
        chatId: number;
        threadId?: number;
    };
    receiver: TelegramUpdateJournalQueueOwnerIdentity & {
        sessionId: string;
        bindingKey: string;
        deliveryGeneration: string;
    };
}
export interface TelegramTextInputSourceJournalCandidate extends Omit<TelegramUpdateJournalFile, "version" | "entries"> {
    version: 5;
    entries: (TelegramUpdateJournalEntry & {
        privateTextInput?: TelegramJournalTextInputAssociation;
    })[];
}
export interface TelegramJournalPrivateTextReply {
    source: TelegramInputJournalSourceReference;
    expectedSource: TelegramUpdateJournalEntryDigest;
    destination: TelegramJournalPrivateTextReplyDestination;
}
/** Exact parsed journal entry identity, checked inside the source owner's mutation transaction. */
export interface TelegramUpdateJournalEntryDigest {
    updateId: number;
    sourceSha256: string;
}
/** Journal-owned removal ACK bound to an opaque, immutable caller acceptance scope. */
export interface TelegramUpdateJournalSourceCompletion extends TelegramUpdateJournalEntryDigest {
    completionSha256: string;
}
export declare function createTelegramUpdateJournalEntryDigest(entry: TelegramUpdateJournalEntry): TelegramUpdateJournalEntryDigest;
export interface TelegramUpdateJournalFile {
    version: typeof TELEGRAM_UPDATE_JOURNAL_VERSION | typeof TELEGRAM_UPDATE_JOURNAL_EXCLUSION_VERSION | typeof TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION | typeof TELEGRAM_UPDATE_JOURNAL_PRIVATE_TEXT_VERSION;
    revision?: number;
    acceptedThroughUpdateId?: number;
    profile: string;
    botIdentity: TelegramUpdateJournalBotIdentity;
    entries: TelegramUpdateJournalEntry[];
    operatorDispositions?: TelegramUpdateJournalOperatorDisposition[];
    sourceCompletions?: TelegramUpdateJournalSourceCompletion[];
}
export interface TelegramUpdateJournalSnapshot<V extends TelegramUpdateJournalFile["version"] = 1 | 2 | 3> extends Omit<TelegramUpdateJournalFile, "version"> {
    version: V;
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
    sourceCompletions?: TelegramUpdateJournalSourceCompletion[];
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
export interface TelegramUpdateJournalQueuedReceiptEvidence {
    receipt: TelegramUpdateJournalQueuedCompletion;
    sources: TelegramUpdateJournalEntryDigest[];
    queueOwnerSha256: string;
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
export interface TelegramUpdateJournalPendingAbandonmentInput {
    journalBindingKey: string;
    entry: TelegramUpdateJournalEntry;
    operatorAuthorityId: string;
    /** Caller proves owner authorization and excludes live chooser/worker dispatch through publication. */
    isCurrent: () => boolean;
}
export interface TelegramUpdateJournalPendingAbandonmentResult {
    disposition: TelegramUpdateJournalLegacyCustodyDisposition;
    retainedPath: string;
    duplicate: boolean;
    entryCount: number;
    serializedBytes: number;
}
/** Private evidence copy, not execution authority or proof that abandonment committed. */
export interface TelegramUpdateJournalRetainedInput {
    version: 1;
    kind: "pending-input-retention";
    journalBindingKey: string;
    entry: TelegramUpdateJournalEntry;
    requestedDisposition: TelegramUpdateJournalLegacyCustodyDisposition;
}
export interface TelegramUpdateJournalPendingRetentionEvidence {
    journalBindingKey: string;
    retainedPath: string;
    requestedDisposition: TelegramUpdateJournalLegacyCustodyDisposition;
}
/** Durable proof that an owner abandoned this exact pending source; never delivery or completion proof. */
export interface TelegramUpdateJournalAbandonedPendingEvidence {
    journalBindingKey: string;
    updateId: number;
    retainedPath: string;
    operatorAuthorityId: string;
    /** Read-only original bot-chat facts; never cancellation, execution or cleanup authority by themselves. */
    originalTarget?: Readonly<{
        chatId: number;
        threadId: number;
        messageId: number;
        sourceSha256: string;
    }>;
}
export interface TelegramRoutingInputAuthority {
    journalBindingKey: string;
    entries: readonly TelegramUpdateJournalEntry[];
    operatorUserId: number;
    isCurrent(): boolean;
}
/** Expiry drops a donor attempt without retaining its body or claiming recipient execution/cancellation. */
export type TelegramRoutingInputExpiryResult = Omit<TelegramUpdateJournalPendingAbandonmentResult, "retainedPath">;
export type TelegramRoutingInputExpiryEvidence = Omit<TelegramUpdateJournalAbandonedPendingEvidence, "retainedPath" | "originalTarget">;
/** Package-private v1 capability; raw input custody does not expose it. */
export interface TelegramRoutingInputJournal {
    arm(input: TelegramRoutingInputAuthority & {
        publishedAtMs: number;
        chooser?: TelegramUpdateJournalRoutingChooser;
    }): TelegramUpdateJournalEntry[];
    select(input: TelegramRoutingInputAuthority): {
        issued: boolean;
        entries: TelegramUpdateJournalEntry[];
    };
    expire(input: Omit<TelegramRoutingInputAuthority, "entries"> & {
        entry: TelegramUpdateJournalEntry;
    }): TelegramRoutingInputExpiryResult;
    inspectExpiry(updateId: number): TelegramRoutingInputExpiryEvidence | undefined;
    inspectGroupExpiry(updateIds: readonly number[]): TelegramRoutingInputExpiryEvidence[] | undefined;
}
export interface TelegramUpdateJournalStore<V extends TelegramUpdateJournalFile["version"] = 1 | 2 | 3> {
    routingInputs?: TelegramRoutingInputJournal;
    read(): TelegramUpdateJournalSnapshot<V>;
    /** Read-only: the committed abandonment tombstone plus its matching private retention, or undefined. */
    inspectAbandonedPending(updateId: number): TelegramUpdateJournalAbandonedPendingEvidence | undefined;
    /** Read-only protection evidence for this snapshot entry, never commit/execution authority. */
    inspectPendingRetention(entry: TelegramUpdateJournalEntry): TelegramUpdateJournalPendingRetentionEvidence | undefined;
    abandonPending(input: TelegramUpdateJournalPendingAbandonmentInput): TelegramUpdateJournalPendingAbandonmentResult;
    appendBatch<TUpdate extends TelegramUpdateJournalInput>(updates: readonly TUpdate[], acceptedThroughUpdateId?: number): TelegramUpdateJournalAppendResult;
    markQueued(receipt: TelegramUpdateJournalQueueReceipt): TelegramUpdateJournalQueueResult;
    markExecutionFailure(input: TelegramUpdateJournalFailureInput): TelegramUpdateJournalFailureResult;
    applyOperatorDisposition(input: TelegramUpdateJournalOperatorDispositionInput): TelegramUpdateJournalOperatorDispositionResult;
    /** Explicit operator-only exact v1 retry disposal; no execution, custody recovery or schema upgrade. */
    discardRetryWait(input: TelegramUpdateJournalPendingAbandonmentInput): TelegramUpdateJournalOperatorDispositionResult;
    applyLegacyCustodyDisposition(authority: TelegramUpdateJournalLegacyCustodyDispositionAuthority): TelegramUpdateJournalLegacyCustodyDispositionResult;
    offerQueuedHandoff(input: TelegramUpdateJournalQueueHandoffInput): TelegramUpdateJournalQueueHandoffOfferResult;
    acceptQueuedHandoff(input: TelegramUpdateJournalQueueHandoffInput): TelegramUpdateJournalQueueHandoffAcceptResult;
    cancelQueuedHandoff(input: TelegramUpdateJournalQueueHandoffInput): TelegramUpdateJournalQueueHandoffCancelResult;
    completeQueued(receipts: readonly TelegramUpdateJournalQueuedCompletion[]): TelegramUpdateJournalRemoveResult;
    /** Strict legacy/v4 whole-receipt disposal co-publishes caller-scoped ACKs; never a readiness grant. */
    completeQueuedExact(receipts: readonly TelegramUpdateJournalQueuedCompletion[], completions: readonly TelegramUpdateJournalSourceCompletion[]): TelegramUpdateJournalRemoveResult;
    discardQueued(input: TelegramUpdateJournalQueueDiscardInput): TelegramUpdateJournalQueueDiscardResult;
    recoverDeadQueueOwner(input: TelegramUpdateJournalDeadQueueOwnerRecoveryInput): TelegramUpdateJournalDeadQueueOwnerRecoveryResult;
    removeCompleted(updateIds: readonly number[]): TelegramUpdateJournalRemoveResult;
    /** Guarded completion; every supplied source must still match, and absence is a conflict, not an ACK. */
    removeCompletedExact(updateIds: readonly number[], expectedSources: readonly TelegramUpdateJournalEntryDigest[], completions?: readonly TelegramUpdateJournalSourceCompletion[], isCurrent?: () => boolean): TelegramUpdateJournalRemoveResult;
    /** Strict read-only observation; neither source absence nor a different scope is completion evidence. */
    inspectSourceCompletion(expected: TelegramUpdateJournalSourceCompletion): TelegramUpdateJournalSourceCompletion | undefined;
    /** Complete strict observation of a retained, unoffered v1 queue receipt; never acquires readiness. */
    inspectQueuedReceipt(expected: TelegramUpdateJournalQueuedCompletion): TelegramUpdateJournalQueuedReceiptEvidence | undefined;
    isQueueReceiptCurrent?: (receipt: Pick<TelegramUpdateJournalQueuedCompletion, "queueKind" | "receiptId" | "sourceUpdateIds"> & {
        journalBindingKey?: string;
    }, owner: TelegramUpdateJournalQueueOwner) => boolean;
}
export type TelegramUpdateJournalPublicationBoundary = "before-write" | "after-write-before-rename";
export interface TelegramUpdateJournalRecoveryEvent {
    kind: "repaired" | "reset";
    path: string;
    revision?: number;
    /** Damaged snapshot/segment paths deleted or atomically replaced; nothing is retained for recovery. */
    deletedPaths?: string[];
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
/** Native exact completion is exposed only by literal-v4 construction, never preparation/observation handles. */
export type TelegramInputJournalStore<V extends TelegramUpdateJournalFile["version"] = 1 | 2 | 3> = TelegramInputJournalStoreBase<V> & (V extends 4 ? Pick<TelegramUpdateJournalStore<V>, "completeQueuedExact" | "inspectSourceCompletion"> : {});
interface TelegramInputJournalStoreBase<V extends TelegramUpdateJournalFile["version"]> {
    /** V4-only immutable source evidence; every success requires current ready authority. */
    pinPrivateTextReplyDestination(input: {
        receipt: TelegramInputJournalReceipt;
        expectedSource: TelegramUpdateJournalEntryDigest;
        destination: TelegramJournalPrivateTextReplyDestination;
        assertAuthority: () => void;
    }): {
        pinned: boolean;
    };
    read: TelegramUpdateJournalStore<V>["read"];
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
    /** Explicit storage selection only; never migrates an existing family. */
    storageVersion?: 3;
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
    sourceCompletions?: TelegramUpdateJournalSourceCompletion[];
}
export interface TelegramUpdateJournalSegmentPublicationResult {
    path: string;
    revision: number;
    serializedBytes: number;
}
export declare function parseTelegramUpdateJournalQueueOwner(value: unknown): TelegramUpdateJournalQueueOwner | undefined;
export declare function isTelegramUpdateJournalQueueOwnerProcess(owner: TelegramUpdateJournalQueueOwner, identity: TelegramUpdateJournalQueueOwnerIdentity): boolean;
export declare function areTelegramUpdateJournalQueueOwnersEqual(left: TelegramUpdateJournalQueueOwner, right: TelegramUpdateJournalQueueOwner): boolean;
/** Only legacy v1 carries routing-lifetime, scoped-ACK and pairing-free queue-receipt semantics. */
export declare function isTelegramUpdateJournalLegacyFamilyVersion(version: unknown): boolean;
/** Explicit data codec only. Existing journal stores continue refusing v5, including recovery paths. */
export declare function decodeTelegramTextInputSourceJournalCandidate(serialized: string, path: string): TelegramTextInputSourceJournalCandidate;
/** Read-only warm publication data, never a source-use, SDK or removal receipt. */
export interface TelegramTextInputSourceCustodyObservation {
    readonly revision: number;
    readonly frameUpdateIds: readonly number[];
    readonly associations: readonly Readonly<Omit<TelegramJournalTextInputAssociation, "source" | "expectedSource" | "target" | "receiver"> & {
        readonly source: Readonly<TelegramJournalTextInputAssociation["source"]>;
        readonly expectedSource: Readonly<TelegramJournalTextInputAssociation["expectedSource"]>;
        readonly target: Readonly<TelegramJournalTextInputAssociation["target"]>;
        readonly receiver: Readonly<TelegramJournalTextInputAssociation["receiver"]>;
    }>[];
}
/** Private native payload issued only inside the original frame's synchronous use scope. */
export interface TelegramTextSourceUseInput {
    readonly association: TelegramTextInputSourceCustodyObservation["associations"][number];
    readonly profile: string;
    readonly botId: number;
    readonly revision: number;
    readonly messageId: number;
    readonly text: string;
}
/** Peek is immutable data only. Consume is one spent-before-probes native source barrier, never an SDK result. */
export declare function readTelegramNativeTextSourceUse(value: unknown, consume?: boolean): Readonly<TelegramTextSourceUseInput>;
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
export interface TelegramUpdateJournalRetentionInspection {
    evidence: ReturnType<typeof inspectTelegramUpdateJournalFamily>;
    retainedInputs: {
        path: string;
        journalBindingKey: string;
        failureId: string;
        updateId: number;
        state: "committed" | "uncommitted";
        originalTarget?: TelegramUpdateJournalAbandonedPendingEvidence["originalTarget"];
    }[];
}
/** Classifies private originals against exact discard tombstones; never replay or deletion authority. */
export declare function inspectTelegramUpdateJournalRetention(input: Parameters<typeof inspectTelegramUpdateJournalFamily>[0]): TelegramUpdateJournalRetentionInspection;
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
export interface TelegramJournalNamespaceInspectionInput {
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
    /** Leader polling journal named by owners.json; defaults to the flat root `inbox`. */
    pollingPath?: string;
    /** Hold a participating consumer reference during each physical family read. */
    withSourceReference?: <T>(path: string, operation: () => T) => T;
}
export interface TelegramJournalNamespaceInspection {
    /** Original preservation facts only, never replay/deletion grants. */
    retainedInputs?: (TelegramUpdateJournalRetentionInspection["retainedInputs"][number] & {
        journalPath: string;
    })[];
    sources: {
        role: "polling" | "follower" | "session";
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
}
export declare function inspectTelegramProfileJournalNamespace(input: TelegramJournalNamespaceInspectionInput): TelegramJournalNamespaceInspection;
/** Read-only evidence over polling, retained flat recipients and role-neutral session journals. */
export declare function inspectTelegramSessionJournalNamespace(input: TelegramJournalNamespaceInspectionInput): TelegramJournalNamespaceInspection;
/** Whether an update addresses this private-chat Thread anywhere in its payload (message, callback, reaction, …). */
export declare function doesTelegramJournalUpdateNameThread(update: unknown, target: {
    chatId: number;
    threadId: number;
}): boolean;
/** A button tap alone carries no input, so it never keeps a tab whose inputs are resolved (the in-flight Cancel itself). */
export declare function isTelegramJournalLoneCallbackUpdate(update: unknown): boolean;
/** Complete-empty protection only; caller holds source serialization through consumption. Never deletion authority. */
export declare function isTelegramThreadCleanupJournalNamespaceClear(input: TelegramJournalNamespaceInspectionInput & {
    requiredJournalBindingKeys: readonly string[];
    withSourceReference: NonNullable<TelegramJournalNamespaceInspectionInput["withSourceReference"]>;
    /**
     * The tab being cleaned and its own recorded inputs. When given, a plain pending input with no custody that
     * neither names this tab nor belongs to it cannot be delivered here and does not protect it, nor does a plain
     * button tap even in this tab; without it, every non-empty journal protects, as before.
     */
    cleanup?: {
        target: {
            chatId: number;
            threadId: number;
        };
        ownInputs: readonly {
            journalBindingKey: string;
            updateIds: readonly number[];
        }[];
    };
}): boolean;
/** Demand-driven recovery only; caller holds temporary-cleanup admission. Never a deletion grant. */
export declare function recoverTelegramThreadCleanupDeadQueueOwners(input: Parameters<typeof isTelegramThreadCleanupJournalNamespaceClear>[0] & {
    recoveryOwner: TelegramUpdateJournalQueueOwnerIdentity;
    isCurrent: () => boolean;
    withSourceSerialization: NonNullable<TelegramUpdateJournalStoreOptions["withSourceSerialization"]>;
    getQueueProcessLiveness?: TelegramUpdateJournalStoreOptions["getQueueProcessLiveness"];
}): number;
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
        exists: boolean;
    };
}
export interface TelegramUpdateJournalRuntimeBindingResolverDeps {
    getProfileName: () => string | undefined;
    getBotToken: () => string | undefined;
    getBotId: () => number | undefined;
    getJournalPath: (profileName?: string) => string;
    getQueueRuntimeIdentity?: () => TelegramUpdateJournalQueueRuntimeIdentity;
    withWriterAdmission?: <T>(operation: () => T) => T;
    withSourceSerialization?: TelegramUpdateJournalStoreOptions["withSourceSerialization"];
    getWorkspaceAdmission?: () => Pick<TelegramWorkspaceAdmissionLedger, "acquireAdmission" | "releaseAdmission"> | undefined;
    onRecovery?: (event: TelegramUpdateJournalRecoveryEvent) => void;
    /** Strict private source handles; on by default on every platform (see TELEGRAM_STRICT_READ_FLAGS). */
    strictSourceAccess?: boolean;
}
export declare function createTelegramUpdateJournalRuntimeBindingResolver(deps: TelegramUpdateJournalRuntimeBindingResolverDeps): () => TelegramUpdateJournalRuntimeBinding | undefined;
export type TelegramUpdateJournalReferenceClass = "leader-lifecycle" | "follower-lifecycle" | "polling-cursor" | "polling-bootstrap" | "workspace-retirement" | "operator-disposition" | "private-source-observation";
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
type PrivateReplyJournal = Pick<TelegramInputJournalStore<4>, "read" | "acquireInput" | "pinPrivateTextReplyDestination">;
interface PrivateTextReplySelection {
    purpose: "private-text-reply-first-ready";
    source: TelegramInputJournalSourceReference;
    expectedPendingSource: TelegramUpdateJournalEntryDigest;
    destination: TelegramJournalPrivateTextReplyDestination;
    assertOriginal: () => void;
}
interface PrivateTextReplyPreparationScope {
    readonly journal: PrivateReplyJournal;
    readonly sourceIdentity: Readonly<Omit<TelegramInputJournalSourceReference, "updateId">>;
    assertCurrent(): void;
    selectPrivateTextReplyContext(journal: PrivateReplyJournal, selection: PrivateTextReplySelection): {
        readonly context: TelegramInputJournalContext;
        assertCurrent(): void;
    };
}
export interface TelegramPrivateTextReplyPreparationSource {
    withScope<T>(updateId: number, operation: (scope: PrivateTextReplyPreparationScope) => T): T;
}
export interface TelegramPrivateTextReplyAcceptanceCandidate {
    destination: TelegramJournalPrivateTextReplyDestination;
    message: unknown;
}
export type TelegramPrivateTextReplyReceiverSelector = (candidate: TelegramPrivateTextReplyAcceptanceCandidate, assertSource: () => void) => Readonly<{
    assertCurrent(): void;
}> | undefined;
export interface TelegramV4InputCandidate {
    readonly profile: string;
    readonly botIdentity: Readonly<TelegramUpdateJournalBotIdentity>;
    readonly sessionId: string;
    readonly owner: Readonly<TelegramUpdateJournalQueueOwnerIdentity>;
    readonly source: Readonly<TelegramInputJournalSourceReference>;
    readonly expectedSource: Readonly<TelegramUpdateJournalEntryDigest>;
    readonly entry: TelegramUpdateJournalEntry;
}
export type TelegramOrdinaryV4InputCandidate = TelegramV4InputCandidate;
export type TelegramOrdinaryV4SelectionGuard = (candidate: TelegramOrdinaryV4InputCandidate) => void;
/** Operator-distinct authority: routing never treats it as an owner cancellation. */
export declare const TELEGRAM_SESSION_ADOPTION_AUTHORITY_PREFIX = "session-successor:";
export interface TelegramSessionPendingAdoptionInput {
    recipientBindingKey: string;
    predecessorSessionId: string;
    successorSessionId: string;
    /** Caller proves the successor registration is current and no predecessor worker runs. */
    isCurrent: () => boolean;
}
export interface TelegramSessionPendingAdoptionResult {
    adoptedUpdateIds: number[];
    /** Already committed away by an earlier attempt; never re-appended, the private original remains. */
    retainedUpdateIds: number[];
}
export interface TelegramUpdateJournalBindingRuntime {
    resolveLeader: () => TelegramUpdateJournalRuntimeBinding | undefined;
    resolveFollower: () => TelegramUpdateJournalRuntimeBinding | undefined;
    resolveActive: () => TelegramUpdateJournalRuntimeBinding | undefined;
    getActiveRecoveryKey: () => string | undefined;
    /** Exact historical proof lookup; no store, admission, execution, recovery or mutation port. */
    inspectSourceAbandonment: (journalBindingKey: string, updateId: number) => TelegramUpdateJournalAbandonedPendingEvidence | undefined;
    inspectSourceGroupExpiry: (journalBindingKey: string, updateIds: readonly number[]) => TelegramRoutingInputExpiryEvidence[] | undefined;
    inspectSourceCompletion: (journalBindingKey: string, expected: TelegramUpdateJournalSourceCompletion) => TelegramUpdateJournalSourceCompletion | undefined;
    inspectQueuedReceipt: (journalBindingKey: string, expected: TelegramUpdateJournalQueuedCompletion) => TelegramUpdateJournalQueuedReceiptEvidence | undefined;
    /** In-process `/new` succession: move unclaimed predecessor pending inputs into the successor session journal. */
    adoptPredecessorPending: (input: TelegramSessionPendingAdoptionInput) => TelegramSessionPendingAdoptionResult;
    /** Process-local: adopts from the previously prepared session of the same recipient key, then records the active one. */
    prepareActiveFollowerSuccession: (isCurrent: () => boolean) => TelegramSessionPendingAdoptionResult | undefined;
    createRecipientResolver: (recipientBindingKey: string, sessionId?: string) => () => TelegramUpdateJournalRuntimeBinding | undefined;
    createLegacyRecipientResolver: (recipientBindingKey: string) => () => TelegramUpdateJournalRuntimeBinding | undefined;
    createPathResolver: (path: string) => () => TelegramUpdateJournalRuntimeBinding | undefined;
}
export declare function createTelegramUpdateJournalBindingRuntime(deps: {
    base: Omit<TelegramUpdateJournalRuntimeBindingResolverDeps, "getJournalPath">;
    getLeaderJournalPath: (profileName?: string) => string;
    /** Runtime root; defaults to the leader journal's directory for flat layouts. */
    getRuntimeDir?: () => string;
    getFollowerJournalPath: (bindingKey: string, profileName?: string, sessionId?: string) => string;
    getActiveFollowerBindingKey: () => string;
    getActiveFollowerSessionId?: () => string | undefined;
    isFollowerRegistered: () => boolean;
}): TelegramUpdateJournalBindingRuntime;
/**
 * Journal-owned cross-family source serializer, lock-only and never authorization. Its guard lives
 * in the runtime service directory, so journal work never touches `telegram.json` or its
 * transaction. Acquire Workspace admission and any sender (config) admission first; never acquire
 * owners inside it. Callbacks must be synchronous: a returned promise is unprotected after its
 * synchronous prefix.
 */
export declare function createTelegramJournalSourceSerialization(getTransactionPath?: () => string): <T>(operation: () => T) => T;
export declare function createTelegramUpdateJournalStore(options: TelegramUpdateJournalStoreOptions): TelegramUpdateJournalStore;
export {};
