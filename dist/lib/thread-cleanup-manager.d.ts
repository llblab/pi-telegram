/**
 * Proof-only candidate planning for inactive Telegram Workspace Thread cleanup
 * Zones: telegram threads, workspace lifecycle
 * Owns fail-closed cleanup eligibility projection without persistence or Bot API effects
 */
import type { TelegramWorkspaceDeletionPermit, TelegramWorkspaceDestructiveFence, TelegramWorkspaceRetirementFence } from "./workspace-admission.ts";
export interface TelegramThreadCleanupBindingSnapshot {
    cwd: string;
    workspaceKey: string;
    sessionId?: string;
    sessionKey?: string;
    instanceSlot: string;
    slot?: string;
    bindingKey: string;
    target: {
        chatId: number;
        threadId: number;
    };
    inactiveSinceMs?: number;
    updatedAtMs: number;
}
export type TelegramThreadCleanupProtectionState = "clear" | "protected" | "unknown";
export interface TelegramThreadCleanupProtectionEvidence {
    bindingKey: string;
    target: {
        chatId: number;
        threadId: number;
    };
    liveOwner: TelegramThreadCleanupProtectionState;
    acceptedWork: TelegramThreadCleanupProtectionState;
    deliveryAuthority: TelegramThreadCleanupProtectionState;
}
export interface TelegramThreadCleanupCandidate {
    profileName: string;
    bindingKey: string;
    cwd: string;
    workspaceKey: string;
    sessionId?: string;
    sessionKey?: string;
    instanceSlot: string;
    slot: string;
    target: {
        chatId: number;
        threadId: number;
    };
    inactiveSinceMs: number;
    bindingUpdatedAtMs: number;
}
/** Returns no candidates when any identity/evidence ambiguity exists. */
export declare function planTelegramInactiveThreadCleanup(input: {
    profileName: string;
    bindings: readonly TelegramThreadCleanupBindingSnapshot[];
    protection: readonly TelegramThreadCleanupProtectionEvidence[];
    reservedTargets?: readonly {
        chatId: number;
        threadId: number;
    }[];
    provisioningTargets?: readonly {
        chatId: number;
        threadId: number;
    }[];
    cleanupTargets?: readonly {
        chatId: number;
        threadId: number;
    }[];
}): TelegramThreadCleanupCandidate[];
export declare function captureTelegramInactiveThreadCleanupEvidence<TBinding extends TelegramThreadCleanupBindingSnapshot>(input: {
    profileName: string;
    listBindings(): readonly TBinding[];
    getProtection(binding: TBinding): {
        liveOwner: TelegramThreadCleanupProtectionState;
        acceptedWork: TelegramThreadCleanupProtectionState;
        deliveryAuthority: TelegramThreadCleanupProtectionState;
    };
    listReservations(): readonly {
        target: {
            chatId: number;
            threadId: number;
        };
    }[];
    listPendingProvisions(): readonly {
        target?: {
            chatId: number;
            threadId: number;
        };
    }[];
    listPendingCleanups(): readonly {
        target: {
            chatId: number;
            threadId: number;
        };
    }[];
}): Parameters<typeof planTelegramInactiveThreadCleanup>[0];
export declare function createTelegramInactiveThreadCleanupReviewRuntime<TBinding extends TelegramThreadCleanupBindingSnapshot>(deps: {
    getProfileName(): string;
    listBindings(): readonly TBinding[];
    getProtection(binding: TBinding): {
        liveOwner: TelegramThreadCleanupProtectionState;
        acceptedWork: TelegramThreadCleanupProtectionState;
        deliveryAuthority: TelegramThreadCleanupProtectionState;
    };
    listReservations(): readonly {
        target: {
            chatId: number;
            threadId: number;
        };
    }[];
    listPendingProvisions(): readonly {
        target?: {
            chatId: number;
            threadId: number;
        };
    }[];
    listPendingCleanups(): readonly {
        target: {
            chatId: number;
            threadId: number;
        };
    }[];
    getWorkStore(): TelegramThreadCleanupWorkStore;
    runWorkspaceOperation<T>(input: {
        operationId: string;
        operationKind: string;
        scopes: readonly [{
            kind: "profile";
        }];
    }, operation: () => Promise<T>): Promise<T>;
}): {
    review(): Promise<{
        count: number;
        operationId?: string;
    }>;
};
export type TelegramThreadCleanupWorkState = "prepared" | "outcome-unknown" | "deleted";
export type TelegramThreadCleanupWorkEntry = TelegramThreadCleanupCandidate & {
    state: TelegramThreadCleanupWorkState;
    updatedAtMs: number;
    issuedAtMs?: number;
    permitOperationId?: string;
    permitIntentId?: string;
    permitLeaderEpoch?: number | string;
    deletedAtMs?: number;
};
export interface TelegramThreadCleanupWorkSet {
    operationId: string;
    createdAtMs: number;
    entries: TelegramThreadCleanupWorkEntry[];
}
export type TelegramThreadCleanupDeletionPermit = TelegramWorkspaceDeletionPermit;
export type TelegramThreadCleanupFence = TelegramWorkspaceRetirementFence;
export interface TelegramThreadCleanupWorkStore {
    prepare(operationId: string, candidates: readonly TelegramThreadCleanupCandidate[]): {
        prepared: boolean;
        workSet: TelegramThreadCleanupWorkSet;
    };
    recordDeletionIssued(input: {
        operationId: string;
        bindingKey: string;
        bindingUpdatedAtMs: number;
        permit: TelegramThreadCleanupDeletionPermit;
    }): {
        recorded: boolean;
        entry: TelegramThreadCleanupWorkEntry;
    };
    confirmDeleted(input: {
        operationId: string;
        bindingKey: string;
    }): {
        confirmed: boolean;
        entry: TelegramThreadCleanupWorkEntry;
    };
    list(): TelegramThreadCleanupWorkSet[];
}
export declare function createTelegramThreadCleanupWorkStore(options: {
    path: string;
    profileName: string;
    tokenSha256: string;
    maxWorkSets?: number;
    maxBytes?: number;
    getNowMs?: () => number;
    onPublicationBoundary?: (boundary: "after-write-before-rename" | "after-rename") => void;
}): TelegramThreadCleanupWorkStore;
export declare function commitTelegramInactiveThreadCleanup(input: {
    store: TelegramThreadCleanupWorkStore;
    operationId: string;
    bindingKey: string;
    commitBinding(): Promise<boolean>;
}): Promise<boolean>;
export declare function executeTelegramInactiveThreadCleanup(input: {
    store: TelegramThreadCleanupWorkStore;
    operationId: string;
    bindingKey: string;
    withWorkspaceDeletionBoundary<T>(operation: () => Promise<T>): Promise<T>;
    loadFreshEvidence(): Promise<Parameters<typeof planTelegramInactiveThreadCleanup>[0]>;
    acquireDeletionPermit(candidate: TelegramThreadCleanupCandidate): Promise<{
        kind: "issued";
        permit: TelegramThreadCleanupDeletionPermit;
    } | {
        kind: "blocked" | "already-issued";
    }>;
    deleteWithPermit(permit: TelegramThreadCleanupDeletionPermit, candidate: TelegramThreadCleanupCandidate): Promise<void>;
}): Promise<{
    status: "deleted" | "blocked" | "outcome-unknown";
    entry?: TelegramThreadCleanupWorkEntry;
}>;
export declare function createTelegramThreadCleanupPermitRuntime(deps: {
    ledger: {
        read(): {
            fence?: TelegramWorkspaceDestructiveFence;
        };
        acquireThreadCleanupFence(input: {
            operationId: string;
            cleanupWorkSetId: string;
            bindingKey: string;
            slot: string;
            target: {
                chatId: number;
                threadId: number;
            };
            leaderEpoch: number | string;
            cleanupRequestedAtMs: number;
        }): {
            kind: "acquired";
            fence: TelegramThreadCleanupFence;
            resumed: boolean;
        } | {
            kind: "blocked";
            reason: string;
        };
        adoptThreadCleanupFence(fence: TelegramThreadCleanupFence, replacement: {
            owner: {
                processId: number;
                processBirthId: string;
            };
            leaderEpoch: number | string;
        }): TelegramThreadCleanupFence;
        issueThreadCleanupDeletionPermit(fence: TelegramThreadCleanupFence): {
            kind: "issued";
            fence: TelegramThreadCleanupFence;
            permit: TelegramThreadCleanupDeletionPermit;
        } | {
            kind: "already-issued";
            fence: TelegramThreadCleanupFence;
        };
        confirmThreadCleanupAbsence(fence: TelegramThreadCleanupFence): TelegramThreadCleanupFence;
        releaseUnissuedThreadCleanupFence(fence: TelegramThreadCleanupFence): boolean;
        completeThreadCleanupFence(fence: TelegramThreadCleanupFence): boolean;
    };
    getLeaderEpoch(): number | string | undefined;
    getProfileName(): string;
    getOwner(): {
        processId: number;
        processBirthId: string;
    };
    canAdoptFence(fence: TelegramThreadCleanupFence): boolean;
    revalidateUnderFence(candidate: TelegramThreadCleanupCandidate): Promise<boolean>;
    getNowMs?: () => number;
}): {
    acquire(candidate: TelegramThreadCleanupCandidate, workSetId: string): Promise<{
        kind: "issued";
        fence: TelegramThreadCleanupFence;
        permit: TelegramThreadCleanupDeletionPermit;
    } | {
        kind: "blocked";
    } | {
        kind: "already-issued";
    }>;
    diagnoseRecovery(candidate: TelegramThreadCleanupCandidate, workSetId: string): "none" | "fenced" | "deletion-issued" | "commit-ready" | "authority-blocked";
    findCommitReady(candidate: TelegramThreadCleanupCandidate, workSetId: string): TelegramThreadCleanupFence | undefined;
    settleDeleted(fence: TelegramThreadCleanupFence, commit: () => Promise<boolean>): Promise<"completed" | "commit-pending">;
};
export interface TelegramInactiveThreadCleanupCoordinatorDeps<TBinding> {
    store: TelegramThreadCleanupWorkStore;
    permitRuntime: ReturnType<typeof createTelegramThreadCleanupPermitRuntime>;
    resolveFullBinding(candidate: TelegramThreadCleanupCandidate): Promise<TBinding | undefined>;
    deleteWithPermit(permit: TelegramThreadCleanupDeletionPermit, candidate: TelegramThreadCleanupCandidate): Promise<void>;
    commitBinding(candidate: TelegramThreadCleanupCandidate, currentBinding?: TBinding): Promise<boolean>;
}
export declare function createTelegramInactiveThreadCleanupSettingsPort<TBinding>(deps: TelegramInactiveThreadCleanupCoordinatorDeps<TBinding>): (operationId: string) => Promise<TelegramInactiveThreadCleanupResult>;
export interface TelegramInactiveThreadCleanupResult {
    deleted: number;
    outcomeUnknown: number;
    blocked: number;
    recovery?: "commit-ready" | "deletion-outcome-unknown" | "authority-blocked";
}
export declare function cleanReviewedInactiveThreads<TBinding>(input: {
    operationId: string;
} & TelegramInactiveThreadCleanupCoordinatorDeps<TBinding>): Promise<TelegramInactiveThreadCleanupResult>;
