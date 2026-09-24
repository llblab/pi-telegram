/**
 * Workspace slot rotation
 * Zones: telegram, workspace identity, lifecycle
 * Owns fail-closed protection, demand-driven pressure retirement, exact-intent admission,
 * successor recovery, and fenced one-shot deletion before durable slot reuse.
 */
import type { TelegramUpdateJournalDeadQueueOwnerRecoveryInput, TelegramUpdateJournalDeadQueueOwnerRecoveryResult, TelegramUpdateJournalEntry, TelegramUpdateJournalQueueOwnerIdentity } from "./journal.ts";
import type { TelegramTarget } from "./target.ts";
import { type TelegramWorkspaceThreadDeletionTransport } from "./telegram-api.ts";
import type { TelegramTopicTargetStore, TelegramWorkspaceExternalProtectionEvidence, TelegramWorkspaceRetirementIntent, TelegramWorkspaceProtectionState, TelegramWorkspaceThreadBinding } from "./threads.ts";
import { type TelegramWorkspaceAdmissionLedger, type TelegramWorkspaceAdmissionScope, type TelegramWorkspaceDeletionPermit } from "./workspace-admission.ts";
export interface TelegramWorkspaceOperationGate {
    runExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
}
export declare function createTelegramWorkspaceOperationGate(): TelegramWorkspaceOperationGate;
export type TelegramWorkspaceOperationRunner = <T>(input: {
    operationId: string;
    operationKind: string;
    scopes: readonly TelegramWorkspaceAdmissionScope[];
}, operation: () => Promise<T>) => Promise<T>;
export interface TelegramWorkspaceOperationRuntime extends TelegramWorkspaceOperationGate {
    run: TelegramWorkspaceOperationRunner;
}
export declare function createTelegramWorkspaceOperationRuntime(input?: {
    getWorkspaceAdmission?: () => Pick<TelegramWorkspaceAdmissionLedger, "acquireAdmission" | "releaseAdmission"> | undefined;
    onReleaseError?: (error: unknown, operationKind: string) => void;
}): TelegramWorkspaceOperationRuntime;
export interface TelegramWorkspaceJournalProtectionCapture {
    sources: TelegramWorkspaceJournalProtectionSource[];
    complete: boolean;
}
interface TelegramWorkspaceJournalReader {
    recoveryKey?: string;
    journal: {
        read: () => {
            entries: readonly {
                update: unknown;
            }[];
        };
    };
    readForProtection?: () => {
        entries: readonly {
            update: unknown;
        }[];
    };
}
export declare function captureTelegramWorkspaceJournalProtectionSources(input: {
    binding: TelegramWorkspaceThreadBinding;
    resolveLeader: () => TelegramWorkspaceJournalReader | undefined;
    createFollowerResolver: (journalBindingKey: string) => () => TelegramWorkspaceJournalReader | undefined;
    withJournalReference?: <T>(binding: TelegramWorkspaceJournalReader, operation: () => T) => T;
    discovery?: {
        paths: readonly string[];
        complete: boolean;
        createResolver: (path: string) => () => TelegramWorkspaceJournalReader | undefined;
    };
}): TelegramWorkspaceJournalProtectionCapture;
export type TelegramWorkspaceJournalProtectionSource = {
    kind: "available";
    scope: {
        kind: "shared";
    } | {
        kind: "binding";
        bindingKey: string;
        journalBindingKey: string;
    } | {
        kind: "discovered";
        path: string;
    };
    entries: readonly {
        update: unknown;
    }[];
} | {
    kind: "unknown";
    scope: {
        kind: "shared";
    } | {
        kind: "binding";
        bindingKey: string;
        journalBindingKey: string;
    } | {
        kind: "discovered";
        path: string;
    };
};
export declare function resolveTelegramWorkspaceAcceptedWorkProtection(input: {
    binding: TelegramWorkspaceThreadBinding;
    localAcceptedTargets: readonly {
        chatId: number;
        threadId?: number;
    }[];
    journalSources: readonly TelegramWorkspaceJournalProtectionSource[];
    sourcesComplete: boolean;
}): TelegramWorkspaceProtectionState;
export type TelegramWorkspaceJournalPruneResult = {
    kind: "committed";
    binding: TelegramWorkspaceThreadBinding;
    removedKeys: string[];
} | {
    kind: "blocked";
    reason: "incomplete-evidence" | "writer-not-quiescent" | "state-changed";
};
export declare function pruneTelegramWorkspaceJournalEvidence(input: {
    store: Pick<TelegramTopicTargetStore, "commitWorkspaceJournalEvidence" | "persist">;
    binding: TelegramWorkspaceThreadBinding;
    capture: TelegramWorkspaceJournalProtectionCapture;
    getJournalWriterProtection: (journalBindingKey: string) => TelegramWorkspaceProtectionState;
    getLeaderEpoch: () => number | string | undefined;
    getProfileKey: () => string;
    admission: Pick<TelegramWorkspaceAdmissionLedger, "acquireAdmission" | "releaseAdmission">;
    isCurrent?: () => boolean;
    onAdmissionReleaseError?: (error: unknown) => void;
}): Promise<TelegramWorkspaceJournalPruneResult>;
export declare function captureTelegramWorkspaceExternalProtection(input: {
    binding: TelegramWorkspaceThreadBinding;
    getLiveOwnerProtection: (binding: TelegramWorkspaceThreadBinding) => TelegramWorkspaceProtectionState;
    getLocalAcceptedTargets: (binding: TelegramWorkspaceThreadBinding) => {
        targets: readonly TelegramTarget[];
        complete: boolean;
    };
    captureJournalSources: (binding: TelegramWorkspaceThreadBinding) => TelegramWorkspaceJournalProtectionCapture;
    getDeliveryAuthorityProtection?: (binding: TelegramWorkspaceThreadBinding) => TelegramWorkspaceProtectionState;
}): TelegramWorkspaceExternalProtectionEvidence;
export declare function createTelegramWorkspaceExternalProtectionCapture(deps: {
    listFollowers: () => readonly {
        target?: TelegramTarget;
    }[];
    getActiveTurnTarget: () => TelegramTarget | undefined;
    getQueuedItems: () => readonly {
        chatId: number;
        target?: TelegramTarget;
    }[];
    resolveLeaderJournal: () => TelegramWorkspaceJournalReader | undefined;
    createFollowerJournalResolver: (journalBindingKey: string) => () => TelegramWorkspaceJournalReader | undefined;
    discoverFollowerJournals?: () => {
        paths: readonly string[];
        complete: boolean;
    };
    createJournalPathResolver?: (path: string) => () => TelegramWorkspaceJournalReader | undefined;
    withJournalReference?: <T>(binding: TelegramWorkspaceJournalReader, operation: () => T) => T;
    getJournalWriterProtection?: (journalBindingKey: string) => TelegramWorkspaceProtectionState;
    getDeliveryAuthorityProtection?: (binding: TelegramWorkspaceThreadBinding) => TelegramWorkspaceProtectionState;
}): (binding: TelegramWorkspaceThreadBinding) => TelegramWorkspaceExternalProtectionEvidence;
export declare function isCurrentTelegramWorkspaceBinding(store: Pick<TelegramTopicTargetStore, "listWorkspaceBindings">, expected: TelegramWorkspaceThreadBinding): boolean;
export interface TelegramWorkspaceDeadQueueJournalBinding {
    recoveryKey?: string;
    readForProtection?: () => {
        entries: readonly TelegramUpdateJournalEntry[];
    };
    journal: {
        recoverDeadQueueOwner: (input: TelegramUpdateJournalDeadQueueOwnerRecoveryInput) => TelegramUpdateJournalDeadQueueOwnerRecoveryResult;
    };
}
export type TelegramWorkspaceDeadQueueReclamation = {
    kind: "not-needed";
} | {
    kind: "recovered";
    receipts: number;
    updateIds: number[];
} | {
    kind: "blocked";
    reason: "authority-changed" | "live-owner" | "local-work" | "incomplete-source" | "unsupported-custody" | "owner-alive" | "owner-unverifiable" | "mutation-refused" | "protection-retained";
};
/**
 * Demand-only preparation for pressure retirement. Every removed group is still
 * owned by the journal's exact dead-owner CAS; this function never clears local
 * queue memory or turns unknown evidence into deletion authority.
 */
export declare function createTelegramWorkspaceDeadOwnerQueueReclaimer(deps: {
    getExternalProtection: (binding: TelegramWorkspaceThreadBinding) => TelegramWorkspaceExternalProtectionEvidence;
    getActiveTurnTarget: () => TelegramTarget | undefined;
    getQueuedItems: () => readonly {
        chatId: number;
        target?: TelegramTarget;
    }[];
    resolveLeaderJournal: () => TelegramWorkspaceDeadQueueJournalBinding | undefined;
    createFollowerJournalResolver: (journalBindingKey: string) => () => TelegramWorkspaceDeadQueueJournalBinding | undefined;
    discoverFollowerJournals?: () => {
        paths: readonly string[];
        complete: boolean;
    };
    createJournalPathResolver?: (path: string) => () => TelegramWorkspaceDeadQueueJournalBinding | undefined;
    withJournalReference?: <T>(binding: TelegramWorkspaceDeadQueueJournalBinding, operation: () => T) => T;
    getRecoveryOwner: () => TelegramUpdateJournalQueueOwnerIdentity;
    getQueueOwnerLiveness: (owner: {
        processId: number;
        processBirthId: string;
    }) => "alive" | "dead" | "unverifiable";
    isBindingCurrent: (binding: TelegramWorkspaceThreadBinding) => boolean;
    onMutationError?: (error: unknown) => void;
}): (binding: TelegramWorkspaceThreadBinding, isCurrent: () => boolean) => Promise<TelegramWorkspaceDeadQueueReclamation>;
export type TelegramWorkspaceRetirementAdoption = {
    kind: "adopted";
    intent: TelegramWorkspaceRetirementIntent;
} | {
    kind: "blocked";
    reason: "intent-conflict" | "profile-changed" | "binding-changed" | "protection-changed" | "commit-rejected";
};
export declare function adoptTelegramWorkspaceRetirementIntent(input: {
    store: Pick<TelegramTopicTargetStore, "captureWorkspaceSlotOccupancy" | "listWorkspaceBindings" | "listWorkspaceRetirementIntents" | "replaceWorkspaceRetirementIntent">;
    intent: TelegramWorkspaceRetirementIntent;
    getExternalProtection: (binding: TelegramWorkspaceThreadBinding) => TelegramWorkspaceExternalProtectionEvidence;
    getLeaderEpoch: () => number | string | undefined;
    getProfileKey: () => string;
    isCurrent?: () => boolean;
    runExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
}): Promise<TelegramWorkspaceRetirementAdoption>;
export type TelegramWorkspaceRetirementExecution = {
    kind: "retired";
    bindingKey: string;
    slot: string;
} | {
    kind: "cancelled";
    reason: "delete-rejected";
} | {
    kind: "retained";
    reason: "stale-intent" | "protection-changed" | "admission-active" | "fence-conflict" | "delete-unconfirmed" | "delete-rejected" | "authority-changed" | "commit-rejected" | "fence-release-unconfirmed";
};
export type TelegramWorkspaceRetirementAbsence = "absent" | "present" | "unknown";
export declare function executeTelegramWorkspaceRetirement(input: {
    store: Pick<TelegramTopicTargetStore, "captureWorkspaceSlotOccupancy" | "listWorkspaceBindings" | "listWorkspaceRetirementIntents" | "commitWorkspaceRetirement" | "removeWorkspaceRetirementIntent" | "persist">;
    admission: Pick<TelegramWorkspaceAdmissionLedger, "getOwner" | "read" | "acquireRetirementFence" | "adoptRetirementFence" | "issueDeletionPermit" | "confirmRetirementAbsence" | "confirmRetirementRejection" | "completeRejectedRetirementFence" | "releaseUnissuedRetirementFence" | "completeRetirementFence">;
    intent: TelegramWorkspaceRetirementIntent;
    getExternalProtection: (binding: TelegramWorkspaceThreadBinding) => TelegramWorkspaceExternalProtectionEvidence;
    getLeaderEpoch: () => number | string | undefined;
    getProfileKey: () => string;
    isCurrent?: () => boolean;
    runExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
    deleteForumTopic: (permit: TelegramWorkspaceDeletionPermit, body: {
        chat_id: number;
        message_thread_id: number;
    }, options: {
        maxAttempts: 1;
    }) => Promise<unknown>;
    confirmTargetAbsent?: (target: TelegramTarget & {
        threadId: number;
    }) => Promise<TelegramWorkspaceRetirementAbsence>;
}): Promise<TelegramWorkspaceRetirementExecution>;
export type TelegramWorkspaceRetirementPreparation = {
    kind: "ready";
    intent: TelegramWorkspaceRetirementIntent;
} | {
    kind: "not-needed";
    reason: "free-capacity";
} | {
    kind: "blocked";
    reason: "invalid-state" | "protected-capacity" | "state-changed" | "existing-intent-conflict" | "stale-intent";
};
export interface TelegramWorkspaceRetirementPreparationDeps {
    store: Pick<TelegramTopicTargetStore, "captureWorkspaceSlotOccupancy" | "listWorkspaceBindings" | "listWorkspaceRetirementIntents" | "upsertWorkspaceRetirementIntent" | "removeWorkspaceRetirementIntent" | "persist">;
    getExternalProtection: (binding: TelegramWorkspaceThreadBinding) => TelegramWorkspaceExternalProtectionEvidence;
    getLeaderEpoch: () => number | string | undefined;
    getProfileKey: () => string;
    isCurrent?: () => boolean;
    getNowMs?: () => number;
}
export declare function prepareTelegramWorkspaceRetirement(deps: TelegramWorkspaceRetirementPreparationDeps): Promise<TelegramWorkspaceRetirementPreparation>;
export type TelegramWorkspaceRetirementLifecycleResult = TelegramWorkspaceRetirementExecution | Extract<TelegramWorkspaceRetirementPreparation, {
    kind: "not-needed";
}> | {
    kind: "blocked";
    stage: "preparation" | "adoption";
    reason: string;
};
export declare function runTelegramWorkspaceRetirementLifecycle(input: {
    store: TelegramWorkspaceRetirementPreparationDeps["store"] & Pick<TelegramTopicTargetStore, "replaceWorkspaceRetirementIntent" | "commitWorkspaceRetirement">;
    getExternalProtection: (binding: TelegramWorkspaceThreadBinding) => TelegramWorkspaceExternalProtectionEvidence;
    getLeaderEpoch: () => number | string | undefined;
    getProfileKey: () => string;
    isCurrent?: () => boolean;
    getNowMs?: () => number;
    runExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
    admission: Parameters<typeof executeTelegramWorkspaceRetirement>[0]["admission"];
    deleteForumTopic: Parameters<typeof executeTelegramWorkspaceRetirement>[0]["deleteForumTopic"];
    confirmTargetAbsent?: Parameters<typeof executeTelegramWorkspaceRetirement>[0]["confirmTargetAbsent"];
}): Promise<TelegramWorkspaceRetirementLifecycleResult>;
export type TelegramWorkspaceCapacityRunner = <T>(operation: () => Promise<T>) => Promise<T>;
export interface TelegramWorkspaceSlotRotationPorts extends TelegramWorkspaceOperationGate {
    getAdmission: () => TelegramWorkspaceAdmissionLedger | undefined;
    deleteThread: TelegramWorkspaceThreadDeletionTransport;
    reclaimDeadOwnerQueuedWork?: (binding: TelegramWorkspaceThreadBinding, isCurrent: () => boolean) => Promise<TelegramWorkspaceDeadQueueReclamation>;
}
/** Retry allocation once, only after the failed operation released all ordinary leases. */
export declare function createTelegramWorkspaceSlotRotation(input: TelegramWorkspaceSlotRotationPorts & {
    store: TelegramTopicTargetStore;
    getLeaderEpoch: () => number | string | undefined;
    getExternalProtection: (binding: TelegramWorkspaceThreadBinding) => TelegramWorkspaceExternalProtectionEvidence;
    recordEvent: (message: string, details: Record<string, unknown>) => void;
}): TelegramWorkspaceCapacityRunner;
export {};
