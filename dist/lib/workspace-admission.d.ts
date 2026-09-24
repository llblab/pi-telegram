/**
 * Durable Telegram Workspace admission and retirement fencing
 * Zones: telegram workspace identity, filesystem authority, process recovery
 * Owns profile-scoped admission leases, destructive fences, and deletion permits
 * Excludes journal/API operations, retirement policy, and binding persistence
 */
import { type PathLike } from "node:fs";
import { type TelegramProcessLiveness } from "./bus.ts";
import type { TelegramTarget } from "./target.ts";
export interface TelegramWorkspaceAdmissionOwner {
    processId: number;
    processBirthId: string;
}
export type TelegramWorkspaceAdmissionScope = {
    kind: "target";
    target: TelegramTarget & {
        threadId: number;
    };
} | {
    kind: "chat";
    chatId: number;
} | {
    kind: "profile";
};
export interface TelegramWorkspaceAdmissionLease {
    operationId: string;
    operationKind: string;
    profileKey: string;
    scope: TelegramWorkspaceAdmissionScope;
    owner: TelegramWorkspaceAdmissionOwner;
    acquiredAtMs: number;
}
export type TelegramWorkspaceDestructiveFenceKind = "pressure-retirement" | "manual-thread-cleanup" | "journal-writer-closure";
export type TelegramWorkspaceDeletionFenceKind = Exclude<TelegramWorkspaceDestructiveFenceKind, "journal-writer-closure">;
export interface TelegramWorkspaceJournalWriterClosureFence {
    destructiveKind: "journal-writer-closure";
    phase: "fenced";
    operationId: string;
    profileKey: string;
    recoveryKey: string;
    owner: TelegramWorkspaceAdmissionOwner;
    requestedAtMs: number;
    acquiredAtMs: number;
}
export declare function normalizeTelegramWorkspaceJournalWriterClosureFence(value: unknown, profileKey: string): TelegramWorkspaceJournalWriterClosureFence | undefined;
export interface TelegramWorkspaceJournalWriterProtocolMode {
    version: 1;
    protocol: "custody-v3";
    profileKey: string;
    recoveryKey: string;
    startupAuthorityId: string;
    closureOperationId: string;
    writerInventorySha256: string;
    installedBy: TelegramWorkspaceAdmissionOwner;
    installedAtMs: number;
}
export declare function normalizeTelegramWorkspaceJournalWriterProtocolMode(value: unknown, profileKey: string): TelegramWorkspaceJournalWriterProtocolMode | undefined;
interface TelegramWorkspaceRetirementFenceBase {
    destructiveKind?: TelegramWorkspaceDeletionFenceKind;
    operationId: string;
    retirementIntentId: string;
    profileKey: string;
    bindingKey: string;
    slot: string;
    target: TelegramTarget & {
        threadId: number;
    };
    leaderEpoch: number | string;
    retirementRequestedAtMs: number;
    owner: TelegramWorkspaceAdmissionOwner;
    acquiredAtMs: number;
}
export type TelegramWorkspaceRetirementFence = (TelegramWorkspaceRetirementFenceBase & {
    phase: "fenced";
}) | (TelegramWorkspaceRetirementFenceBase & {
    phase: "deletion-issued";
    deletionIssuedAtMs: number;
}) | (TelegramWorkspaceRetirementFenceBase & {
    destructiveKind?: "pressure-retirement";
    phase: "deletion-rejected";
    deletionIssuedAtMs: number;
    rejectionConfirmedAtMs: number;
}) | (TelegramWorkspaceRetirementFenceBase & {
    phase: "commit-ready";
    absenceConfirmedAtMs: number;
    deletionIssuedAtMs?: number;
});
export type TelegramWorkspaceDestructiveFence = TelegramWorkspaceRetirementFence | TelegramWorkspaceJournalWriterClosureFence;
export declare function isTelegramWorkspaceRetirementFence(fence: TelegramWorkspaceDestructiveFence): fence is TelegramWorkspaceRetirementFence;
export interface TelegramWorkspaceDeletionPermit {
    readonly destructiveKind?: TelegramWorkspaceDeletionFenceKind;
    readonly operationId: string;
    readonly retirementIntentId: string;
    readonly profileKey: string;
    readonly bindingKey: string;
    readonly slot: string;
    readonly target: TelegramTarget & {
        threadId: number;
    };
    readonly leaderEpoch: number | string;
    readonly issuedAtMs: number;
}
export type TelegramWorkspaceAdmissionBlockReason = "retirement-fenced" | "admission-active" | "retirement-active";
export type TelegramWorkspaceAdmissionAcquireResult = {
    kind: "acquired";
    lease: TelegramWorkspaceAdmissionLease;
    resumed: boolean;
} | {
    kind: "blocked";
    reason: "retirement-fenced";
};
export type TelegramWorkspaceRetirementFenceAcquireResult = {
    kind: "acquired";
    fence: TelegramWorkspaceRetirementFence;
    resumed: boolean;
} | {
    kind: "blocked";
    reason: "admission-active" | "retirement-active";
};
export type TelegramWorkspaceJournalWriterProtocolInstallResult = {
    mode: TelegramWorkspaceJournalWriterProtocolMode;
    resumed: boolean;
};
export type TelegramWorkspaceJournalWriterClosureAcquireResult = {
    kind: "acquired";
    fence: TelegramWorkspaceJournalWriterClosureFence;
    resumed: boolean;
} | {
    kind: "blocked";
    reason: "admission-active" | "retirement-active";
};
export type TelegramWorkspaceDeletionPermitResult = {
    kind: "issued";
    fence: TelegramWorkspaceRetirementFence;
    permit: TelegramWorkspaceDeletionPermit;
} | {
    kind: "already-issued";
    fence: TelegramWorkspaceRetirementFence;
};
export interface TelegramWorkspaceAdmissionLedgerSnapshot {
    profileKey: string;
    leases: TelegramWorkspaceAdmissionLease[];
    fence?: TelegramWorkspaceDestructiveFence;
    writerProtocolMode?: TelegramWorkspaceJournalWriterProtocolMode;
}
export type TelegramWorkspaceAdmissionPublicationBoundary = "before-write" | "after-write-before-rename";
export interface TelegramWorkspaceAdmissionLedgerOptions {
    path: string;
    profileKey: string;
    owner: TelegramWorkspaceAdmissionOwner;
    getNowMs?: () => number;
    getProcessLiveness?: (owner: TelegramWorkspaceAdmissionOwner) => TelegramProcessLiveness;
    publishRename?: (sourcePath: PathLike, destinationPath: PathLike) => void;
    onPublicationBoundary?: (boundary: TelegramWorkspaceAdmissionPublicationBoundary, path: string) => void;
    authorizeJournalWriterProtocolClosure?: (input: {
        mode: TelegramWorkspaceJournalWriterProtocolMode;
        closure: TelegramWorkspaceJournalWriterClosureFence;
    }) => boolean;
}
export declare class TelegramWorkspaceAdmissionError extends Error {
    readonly code: "invalid-input" | "invalid-state" | "state-unavailable" | "authority-changed" | "admission-blocked" | "publication-unknown";
    constructor(code: TelegramWorkspaceAdmissionError["code"], message: string, options?: ErrorOptions);
}
export interface TelegramWorkspaceAdmissionLedger {
    getProfileKey: () => string;
    getOwner: () => TelegramWorkspaceAdmissionOwner;
    listReservedSlots: () => string[];
    read: () => TelegramWorkspaceAdmissionLedgerSnapshot;
    acquireAdmission: (input: {
        operationId: string;
        operationKind: string;
        scope: TelegramWorkspaceAdmissionScope;
    }) => TelegramWorkspaceAdmissionAcquireResult;
    releaseAdmission: (expected: TelegramWorkspaceAdmissionLease) => boolean;
    acquireJournalWriterClosure: (input: {
        operationId: string;
        recoveryKey: string;
        requestedAtMs: number;
    }) => TelegramWorkspaceJournalWriterClosureAcquireResult;
    releaseJournalWriterClosure: (expected: TelegramWorkspaceJournalWriterClosureFence) => boolean;
    installJournalWriterProtocolMode: (expected: TelegramWorkspaceJournalWriterClosureFence, input: {
        startupAuthorityId: string;
        writerInventorySha256: string;
    }) => TelegramWorkspaceJournalWriterProtocolInstallResult;
    acquireJournalWriterAdmission: (input: {
        operationId: string;
        recoveryKey: string;
        startupAuthorityId: string;
        closureOperationId: string;
        writerInventorySha256: string;
    }) => TelegramWorkspaceAdmissionAcquireResult;
    acquireRetirementFence: (input: {
        operationId: string;
        retirementIntentId: string;
        bindingKey: string;
        slot: string;
        target: TelegramTarget & {
            threadId: number;
        };
        leaderEpoch: number | string;
        retirementRequestedAtMs: number;
    }) => TelegramWorkspaceRetirementFenceAcquireResult;
    acquireThreadCleanupFence: (input: {
        operationId: string;
        cleanupWorkSetId: string;
        bindingKey: string;
        slot: string;
        target: TelegramTarget & {
            threadId: number;
        };
        leaderEpoch: number | string;
        cleanupRequestedAtMs: number;
    }) => TelegramWorkspaceRetirementFenceAcquireResult;
    adoptRetirementFence: (expected: TelegramWorkspaceRetirementFence, replacement: {
        owner: TelegramWorkspaceAdmissionOwner;
        leaderEpoch: number | string;
    }) => TelegramWorkspaceRetirementFence;
    adoptThreadCleanupFence: TelegramWorkspaceAdmissionLedger["adoptRetirementFence"];
    issueDeletionPermit: (expected: TelegramWorkspaceRetirementFence) => TelegramWorkspaceDeletionPermitResult;
    issueThreadCleanupDeletionPermit: TelegramWorkspaceAdmissionLedger["issueDeletionPermit"];
    confirmRetirementAbsence: (expected: TelegramWorkspaceRetirementFence) => TelegramWorkspaceRetirementFence;
    confirmThreadCleanupAbsence: TelegramWorkspaceAdmissionLedger["confirmRetirementAbsence"];
    /** Caller must have exact transport proof of rejection, never merely target presence. */
    confirmRetirementRejection: (expected: TelegramWorkspaceRetirementFence) => TelegramWorkspaceRetirementFence;
    /** Caller must first durably withdraw the exact rejected intent, retaining its binding. */
    completeRejectedRetirementFence: (expected: TelegramWorkspaceRetirementFence) => boolean;
    releaseUnissuedRetirementFence: (expected: TelegramWorkspaceRetirementFence) => boolean;
    releaseUnissuedThreadCleanupFence: TelegramWorkspaceAdmissionLedger["releaseUnissuedRetirementFence"];
    completeRetirementFence: (expected: TelegramWorkspaceRetirementFence) => boolean;
    completeThreadCleanupFence: TelegramWorkspaceAdmissionLedger["completeRetirementFence"];
}
export declare function resolveTelegramWorkspaceDestructiveFenceKind(fence: {
    destructiveKind?: TelegramWorkspaceDestructiveFenceKind;
}): TelegramWorkspaceDestructiveFenceKind;
export declare function createTelegramWorkspaceAdmissionOperationId(): string;
export declare function createTelegramWorkspaceAdmissionProfileKey(input: {
    profileName?: string;
    botToken: string;
}): string;
export interface TelegramWorkspaceAdmissionRuntimeBinding {
    resolve: () => TelegramWorkspaceAdmissionLedger | undefined;
}
export declare function createTelegramWorkspaceAdmissionRuntimeBinding(input: {
    getProfileName: () => string | undefined;
    getBotToken: () => string | undefined;
    getPath: (profileName?: string) => string;
    owner: TelegramWorkspaceAdmissionOwner;
    getNowMs?: () => number;
    getProcessLiveness?: (owner: TelegramWorkspaceAdmissionOwner) => TelegramProcessLiveness;
}): TelegramWorkspaceAdmissionRuntimeBinding;
export declare function runWithTelegramWorkspaceAdmissions<T>(input: {
    ledger: Pick<TelegramWorkspaceAdmissionLedger, "acquireAdmission" | "releaseAdmission">;
    operationId: string;
    operationKind: string;
    scopes: readonly TelegramWorkspaceAdmissionScope[];
    operation: () => T;
}): T;
export declare function createTelegramWorkspaceJournalWriterAdmission(input: {
    ledger: Pick<TelegramWorkspaceAdmissionLedger, "acquireAdmission" | "acquireJournalWriterAdmission" | "releaseAdmission">;
    protocolAuthority?: Omit<Parameters<TelegramWorkspaceAdmissionLedger["acquireJournalWriterAdmission"]>[0], "operationId">;
    createOperationId?: () => string;
    onReleaseError?: (error: unknown) => void;
}): <T>(operation: () => T) => T;
export declare function runWithTelegramWorkspaceAdmissionsAsync<T>(input: {
    ledger: Pick<TelegramWorkspaceAdmissionLedger, "acquireAdmission" | "releaseAdmission">;
    operationId: string;
    operationKind: string;
    scopes: readonly TelegramWorkspaceAdmissionScope[];
    operation: () => Promise<T>;
    onReleaseError?: (error: unknown) => void;
}): Promise<T>;
export declare function createTelegramWorkspaceAdmissionLedger(options: TelegramWorkspaceAdmissionLedgerOptions): TelegramWorkspaceAdmissionLedger;
export {};
