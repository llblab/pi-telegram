/**
 * Telegram thread lifecycle reconciler
 * Zones: telegram, multi-instance bus, synchronization control plane
 * Owns pure planning for Telegram thread/tab lifecycle reconciliation and destructive topic cleanup authority
 * Excludes live Telegram API calls, inbound routing, menu rendering, and direct thread-store persistence
 */
import type { TelegramTarget } from "./target.ts";
type ThreadTarget = TelegramTarget & {
    threadId: number;
};
type ThreadRecordStatus = "active" | "offline" | "stale" | "pending" | "starting" | "probe-required" | "failed";
export interface ThreadReconciliationRecord {
    target: ThreadTarget;
    status: ThreadRecordStatus;
    instanceId?: string;
    profileKey?: string;
    ownerKind?: "leader" | "manual-follower" | "pending-topic" | "legacy";
}
export interface ThreadReconciliationReservation {
    target: ThreadTarget;
    expiresAtMs?: number;
}
export interface ThreadReconciliationObservation {
    target: ThreadTarget;
    syncStatus: "open" | "closed" | "deleted" | "unknown";
    observedAtMs: number;
}
export interface TelegramThreadPendingProvision {
    id: string;
    owner: "leader" | "manual-follower";
    instanceId: string;
    slot?: string;
    target?: TelegramTarget & {
        threadId: number;
    };
    startedAtMs: number;
    expiresAtMs?: number;
    leaderEpoch?: number | string;
}
export interface TelegramThreadCleanupIntent {
    id: string;
    owner: "leader" | "manual-follower";
    instanceId: string;
    runtimeGeneration: string;
    profileKey?: string;
    target: ThreadTarget;
    requestedAtMs: number;
}
export interface TelegramUnboundThreadMessageObservation {
    target: TelegramTarget & {
        threadId: number;
    };
    observedAtMs: number;
    messageId?: number;
    leaderEpoch?: number | string;
}
export interface TelegramReservedThreadMessageObservation {
    target: TelegramTarget & {
        threadId: number;
    };
    observedAtMs: number;
    messageId?: number;
    leaderEpoch?: number | string;
}
export interface ReplacedInstanceBindingInput {
    instanceId: string;
    replacementTarget: ThreadTarget;
}
export interface PreviousLeaderCleanupInput {
    currentInstanceId: string;
}
export type ThreadReconciliationAction = {
    kind: "mark-topic-active";
    target: TelegramTarget & {
        threadId: number;
    };
    reason: "observed-open";
} | {
    kind: "mark-topic-stale";
    target: TelegramTarget & {
        threadId: number;
    };
    syncStatus: "closed" | "deleted";
    reason: "observed-closed" | "observed-deleted";
} | {
    kind: "close-delete-unbound-topic";
    target: TelegramTarget & {
        threadId: number;
    };
    observedAtMs: number;
    messageId?: number;
    reason: "unbound-user-message";
    leaderEpoch?: number | string;
} | {
    kind: "close-delete-reserved-topic";
    target: TelegramTarget & {
        threadId: number;
    };
    observedAtMs: number;
    messageId?: number;
    reason: "reserved-user-message" | "startup-reservation";
    leaderEpoch?: number | string;
} | {
    kind: "close-stale-replaced-topic";
    target: TelegramTarget & {
        threadId: number;
    };
    reason: "replaced-instance-binding";
    instanceId?: string;
    leaderEpoch?: number | string;
} | {
    kind: "close-delete-replaced-follower-topic";
    target: TelegramTarget & {
        threadId: number;
    };
    reason: "replaced-follower";
    instanceId?: string;
    messageId?: number;
    leaderEpoch?: number | string;
} | {
    kind: "close-delete-previous-leader-topic";
    target: TelegramTarget & {
        threadId: number;
    };
    reason: "previous-leader";
    instanceId?: string;
    messageId?: number;
    leaderEpoch?: number | string;
} | {
    kind: "close-delete-disconnected-instance-topic";
    target: TelegramTarget & {
        threadId: number;
    };
    reason: "manual-disconnect";
    instanceId?: string;
    messageId?: number;
    leaderEpoch?: number | string;
} | {
    kind: "close-delete-graceful-shutdown-topic";
    target: TelegramTarget & {
        threadId: number;
    };
    reason: "graceful-shutdown";
    cleanupIntentId: string;
    instanceId: string;
    runtimeGeneration: string;
    leaderEpoch?: number | string;
} | {
    kind: "cancel-superseded-graceful-shutdown-cleanup";
    target: TelegramTarget & {
        threadId: number;
    };
    reason: "replacement-registration";
    cleanupIntentId: string;
    instanceId: string;
    runtimeGeneration: string;
    leaderEpoch?: number | string;
} | {
    kind: "close-delete-expired-pending-provision-topic";
    target: TelegramTarget & {
        threadId: number;
    };
    reason: "expired-pending-provision";
    pendingProvisionId: string;
    instanceId?: string;
    leaderEpoch?: number | string;
};
export type ThreadReconciliationPhase = "stable" | "provisioning" | "sync-required" | "cleanup-required";
export type ThreadReconciliationEvent = "settled" | "pending-provision" | "sync-required" | "cleanup-required";
export interface ThreadReconciliationMachineState {
    phase: ThreadReconciliationPhase;
    event: ThreadReconciliationEvent;
    atMs: number;
    leaderEpoch?: number | string;
    pendingProvisionCount: number;
    syncActionCount: number;
    cleanupActionCount: number;
}
export interface ThreadReconciliationTransition {
    from: ThreadReconciliationPhase;
    to: ThreadReconciliationPhase;
    event: ThreadReconciliationEvent;
    atMs: number;
}
export interface ThreadReconciliationPlan {
    actions: ThreadReconciliationAction[];
    state?: ThreadReconciliationMachineState;
    transition?: ThreadReconciliationTransition;
}
export interface ThreadReconciliationApplyResult {
    changed: boolean;
    incompleteActions?: ThreadReconciliationAction[];
}
export interface ThreadReconciliationApplyPorts {
    isCleanupTargetProtected?: (target: ThreadTarget, action: ThreadReconciliationAction) => boolean;
    callApi?: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
    markActiveByTarget?: (target: ThreadTarget) => boolean;
    markStaleByTarget?: (target: ThreadTarget, syncStatus?: "closed" | "deleted", lastSyncError?: string) => boolean;
    persist?: () => Promise<void>;
    removePendingProvisionById?: (id: string) => boolean;
    removeCleanupIntentById?: (id: string) => boolean;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface ThreadReconciliationInput {
    nowMs: number;
    currentLeaderEpoch?: number | string;
    records: readonly ThreadReconciliationRecord[];
    reservations?: readonly ThreadReconciliationReservation[];
    observations?: readonly ThreadReconciliationObservation[];
    pendingProvisions?: readonly TelegramThreadPendingProvision[];
    pendingCleanups?: readonly TelegramThreadCleanupIntent[];
    unboundMessages?: readonly TelegramUnboundThreadMessageObservation[];
    reservedMessages?: readonly TelegramReservedThreadMessageObservation[];
    proactiveReservationCleanup?: boolean;
    replacedBindings?: readonly ReplacedInstanceBindingInput[];
    previousLeaderCleanup?: PreviousLeaderCleanupInput;
    previousState?: ThreadReconciliationMachineState;
    freshCreationGraceMs?: number;
}
export interface ThreadReconciliationRuntime {
    getState: () => ThreadReconciliationMachineState | undefined;
    recordPlan: (plan: ThreadReconciliationPlan) => void;
    plan: (input: Omit<ThreadReconciliationInput, "previousState">) => ThreadReconciliationPlan;
}
export declare function createThreadReconciliationRuntime(deps: {
    recordRuntimeEvent: (category: string, message: unknown, details?: Record<string, unknown>) => void;
    scheduleSnapshotPersist: () => void;
}): ThreadReconciliationRuntime;
export declare function planDisconnectedInstanceThreadCleanup(input: {
    target: TelegramTarget & {
        threadId: number;
    };
    instanceId?: string;
    leaderEpoch?: number | string;
}): ThreadReconciliationPlan;
export declare function applyThreadReconciliationPlan(plan: ThreadReconciliationPlan, ports: ThreadReconciliationApplyPorts): Promise<ThreadReconciliationApplyResult>;
export declare function planThreadReconciliation(input: ThreadReconciliationInput): ThreadReconciliationPlan;
export {};
