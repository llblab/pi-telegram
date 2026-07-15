/**
 * Telegram synchronization helpers
 * Zones: Telegram bot reality mirror, demand-driven reconciliation, status diagnostics
 * Owns pure contracts for deciding when local Telegram mirror state should be refreshed without querying Telegram on every action
 */

import type { TelegramTarget } from "./target.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
import {
  getTelegramTargetFromApiBody,
  isTelegramTopicTargetStaleError,
  provisionOwnBusTopic,
  type TelegramOwnTopicProvisionResult,
  type TelegramTopicTargetStore,
} from "./threads.ts";

export interface TelegramTopicLifecycleSyncUpdate<TMessage = unknown> {
  kind: "created" | "closed" | "reopened";
  target: TelegramTarget & { threadId: number };
  message: TMessage;
}

export interface TelegramLeaderThreadSyncDeps {
  getAllowedUserId: () => number | undefined;
  instanceId: string;
  cwd?: string;
  telegramProfile?: string;
  forceFreshUnnamed?: boolean;
  getNowMs?: () => number;
  getRandom?: () => number;
  getCurrentLeaderEpoch?: () => number | string | undefined;
  getThreadReconciliationMachineState?: () =>
    ThreadReconciler.ThreadReconciliationMachineState | undefined;
  recordThreadReconciliationPlan?: (
    plan: ThreadReconciler.ThreadReconciliationPlan,
  ) => void;
  topicTargetStore: TelegramTopicTargetStore;
  callApi: <TResponse>(
    method: string,
    body: Record<string, unknown>,
  ) => Promise<TResponse>;
  recordEvent: (
    category: string,
    message: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramTopicLifecycleSyncDeps {
  topicTargetStore: Pick<
    TelegramTopicTargetStore,
    | "load"
    | "list"
    | "listReservations"
    | "listPendingProvisions"
    | "markStaleByTarget"
    | "markActiveByTarget"
    | "removePendingProvision"
    | "persist"
  >;
  isBusEnabled: () => boolean;
  callApi: <TResponse>(
    method: string,
    body: Record<string, unknown>,
  ) => Promise<TResponse>;
  isTopicProvisioningActive?: () => boolean;
  getCurrentLeaderEpoch?: () => number | string | undefined;
  getThreadReconciliationMachineState?: () =>
    ThreadReconciler.ThreadReconciliationMachineState | undefined;
  recordThreadReconciliationPlan?: (
    plan: ThreadReconciler.ThreadReconciliationPlan,
  ) => void;
  recordEvent?: (
    category: string,
    message: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export type TelegramTopicLifecycleSyncHandler<TMessage = unknown> = (
  lifecycle: TelegramTopicLifecycleSyncUpdate<TMessage>,
) => Promise<void>;

export interface TelegramObservedTopicLifecycleSyncDeps<
  TSyncState,
> extends TelegramTopicLifecycleSyncDeps {
  getSyncState: () => TSyncState;
  setSyncState: (state: TSyncState) => void;
  getNowMs?: () => number;
}

export interface TelegramLeaderHealthRuntimeDeps<TSyncState> {
  getNowMs?: () => number;
  intervalMs?: number;
  callGetMe: () => Promise<unknown>;
  getSyncState: () => TSyncState;
  setSyncState: (state: TSyncState) => void;
  recordEvent: (
    category: string,
    message: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramLeaderHealthRuntime {
  start: () => void;
  stop: () => void;
}

export interface TelegramManualThreadDisconnectDeps<TSyncState> {
  instanceId: string;
  getCurrentThreadRecord: () =>
    | { target: TelegramTarget; instanceId?: string; owner?: { kind?: string } }
    | undefined;
  topicTargetStore: Pick<
    TelegramTopicTargetStore,
    "markOfflineByInstanceId" | "persist"
  >;
  callApi: <TResponse>(
    method: string,
    body: Record<string, unknown>,
  ) => Promise<TResponse>;
  getLeaderTarget: () => TelegramTarget | undefined;
  getCurrentLeaderEpoch?: () => number | string | undefined;
  clearLeaderTarget: () => void;
  disconnectFollowerThread?: () => Promise<boolean>;
  getSyncState: () => TSyncState;
  setSyncState: (state: TSyncState) => void;
  stopPolling: () => Promise<string>;
  recordRuntimeEvent: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  getNowMs?: () => number;
}

export function markTelegramConfigSyncChange<
  TSyncState extends TelegramSyncState,
>(state: TSyncState, action: string, options?: { nowMs?: number }): TSyncState {
  const nowMs = options?.nowMs ?? Date.now();
  let nextState = markTelegramSyncSliceFresh(state, "pairing", {
    nowMs,
    action,
  }) as TSyncState;
  nextState = markTelegramSyncSliceFresh(nextState, "allowed-user", {
    nowMs,
    action,
  }) as TSyncState;
  nextState = markTelegramSyncSliceFresh(nextState, "bot-identity", {
    nowMs,
    action,
  }) as TSyncState;
  return nextState;
}

export function createTelegramManualThreadDisconnectHandler<
  TSyncState extends TelegramSyncState,
>(deps: TelegramManualThreadDisconnectDeps<TSyncState>): () => Promise<string> {
  return async () => {
    const currentRecord = deps.getCurrentThreadRecord();
    if (currentRecord?.target.threadId) {
      const isManualFollower = currentRecord.owner?.kind === "manual-follower";
      const leaderEpoch = deps.getCurrentLeaderEpoch?.();
      const ownsLeader = deps.getCurrentLeaderEpoch
        ? leaderEpoch !== undefined
        : !isManualFollower;
      if (isManualFollower && !ownsLeader) {
        if (deps.disconnectFollowerThread) {
          const disconnected = await deps.disconnectFollowerThread();
          if (!disconnected) {
            throw new Error(
              "Telegram follower thread deletion requires a live leader registration.",
            );
          }
        }
      } else {
        const stillOwnsLeaderEpoch = () =>
          !deps.getCurrentLeaderEpoch ||
          (leaderEpoch !== undefined &&
            deps.getCurrentLeaderEpoch() === leaderEpoch);
        const cleanup = await ThreadReconciler.applyThreadReconciliationPlan(
          ThreadReconciler.planDisconnectedInstanceThreadCleanup({
            target: currentRecord.target as TelegramTarget & {
              threadId: number;
            },
            instanceId: deps.instanceId,
            leaderEpoch,
          }),
          {
            callApi(method, body) {
              return deps.callApi(method, body);
            },
            persist() {
              return deps.topicTargetStore.persist();
            },
            getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
            recordRuntimeEvent: deps.recordRuntimeEvent,
          },
        );
        if (cleanup.incompleteActions?.length) {
          throw new Error(
            "Telegram thread deletion was not confirmed; inspect /telegram-status --debug and retry /telegram-disconnect.",
          );
        }
        if (!stillOwnsLeaderEpoch()) return deps.stopPolling();
        const offlineChanged =
          deps.topicTargetStore.markOfflineByInstanceId(deps.instanceId) > 0;
        if (!stillOwnsLeaderEpoch()) return deps.stopPolling();
        if (offlineChanged) {
          await deps.topicTargetStore.persist();
          if (!stillOwnsLeaderEpoch()) return deps.stopPolling();
        }
      }
      const leaderTarget = deps.getLeaderTarget();
      if (
        leaderTarget?.chatId === currentRecord.target.chatId &&
        leaderTarget.threadId === currentRecord.target.threadId
      ) {
        deps.clearLeaderTarget();
      }
      deps.setSyncState(
        markTelegramSyncSliceFresh(deps.getSyncState(), "target-bindings", {
          nowMs: (deps.getNowMs ?? Date.now)(),
          action: "manual-disconnect",
        }) as TSyncState,
      );
    }
    return deps.stopPolling();
  };
}

export function createTelegramLeaderHealthRuntime<
  TSyncState extends TelegramSyncState,
>(
  deps: TelegramLeaderHealthRuntimeDeps<TSyncState>,
): TelegramLeaderHealthRuntime {
  const intervalMs = deps.intervalMs ?? 60_000;
  const getNowMs = deps.getNowMs ?? Date.now;
  let interval: ReturnType<typeof setInterval> | undefined;

  const markFresh = (): void => {
    let state = markTelegramSyncSliceFresh(
      deps.getSyncState(),
      "transport-health",
      { nowMs: getNowMs(), action: "leader-health-tick" },
    ) as TSyncState;
    state = markTelegramSyncSliceFresh(state, "bot-identity", {
      nowMs: getNowMs(),
      action: "leader-health-tick",
    }) as TSyncState;
    deps.setSyncState(state);
  };

  const markSuspect = (error: unknown): void => {
    deps.setSyncState(
      markTelegramSyncSliceSuspect(deps.getSyncState(), "transport-health", {
        nowMs: getNowMs(),
        reason: String(error),
        action: "leader-health-tick",
      }) as TSyncState,
    );
    deps.recordEvent("telegram", error, { phase: "leader-health-tick" });
  };

  const stop = (): void => {
    if (!interval) return;
    clearInterval(interval);
    interval = undefined;
  };

  return {
    start() {
      stop();
      interval = setInterval(() => {
        void deps.callGetMe().then(markFresh).catch(markSuspect);
      }, intervalMs);
      interval.unref?.();
    },
    stop,
  };
}

export interface TelegramStaleTopicApiErrorRecoveryDeps<TSyncState> {
  topicTargetStore: Pick<
    TelegramTopicTargetStore,
    "load" | "markStaleByTarget" | "persist"
  >;
  getSyncState: () => TSyncState;
  setSyncState: (state: TSyncState) => void;
  recordEvent: (
    category: string,
    message: unknown,
    details?: Record<string, unknown>,
  ) => void;
  getNowMs?: () => number;
}

export function createTelegramStaleTopicApiErrorRecoveryRuntime<
  TSyncState extends TelegramSyncState,
>(
  deps: TelegramStaleTopicApiErrorRecoveryDeps<TSyncState>,
): (apiBody: unknown, error: unknown) => Promise<boolean> {
  return (apiBody, error) =>
    recoverStaleTelegramTopicApiError(apiBody, error, deps);
}

export async function recoverStaleTelegramTopicApiError<
  TSyncState extends TelegramSyncState,
>(
  apiBody: unknown,
  error: unknown,
  deps: TelegramStaleTopicApiErrorRecoveryDeps<TSyncState>,
): Promise<boolean> {
  const target = getTelegramTargetFromApiBody(apiBody);
  if (!target || !isTelegramTopicTargetStaleError(error)) return false;
  await deps.topicTargetStore.load();
  if (
    !deps.topicTargetStore.markStaleByTarget(target, "deleted", String(error))
  ) {
    return false;
  }
  const nowMs = (deps.getNowMs ?? Date.now)();
  let state = markTelegramSyncSliceSuspect(deps.getSyncState(), "topic-state", {
    nowMs,
    reason: "stale-api-error",
    action: "topic-target-stale",
  }) as TSyncState;
  state = markTelegramSyncSliceSuspect(state, "transport-health", {
    nowMs,
    reason: "stale-api-error",
    action: "topic-target-stale",
  }) as TSyncState;
  deps.setSyncState(state);
  await deps.topicTargetStore.persist();
  deps.recordEvent("bus", error, {
    phase: "topic-target-stale",
    chatId: target.chatId,
    threadId: target.threadId,
  });
  return true;
}

export async function ensureTelegramLeaderThreadBinding(
  deps: TelegramLeaderThreadSyncDeps,
): Promise<TelegramOwnTopicProvisionResult | undefined> {
  const leaderEpoch = deps.getCurrentLeaderEpoch?.();
  const assertLeaderEpoch = (phase: string): void => {
    if (
      deps.getCurrentLeaderEpoch &&
      (leaderEpoch === undefined ||
        deps.getCurrentLeaderEpoch() !== leaderEpoch)
    ) {
      throw new Error(
        `Telegram leader thread binding lost ownership (${phase}).`,
      );
    }
  };
  assertLeaderEpoch("start");
  await deps.topicTargetStore.load();
  assertLeaderEpoch("after-load");
  const priorTargets = deps.topicTargetStore.list().filter((record) => {
    return (
      record.instanceId === deps.instanceId &&
      (record.status === "active" || record.status === "starting")
    );
  });
  // Short-circuit: when the instance already has an active thread and we are not
  // force-freshing, reuse it without re-provisioning. A thread belongs to the
  // live instance binding, not to one transient Pi session lifecycle.
  if (!deps.forceFreshUnnamed && priorTargets.length > 0) {
    const record = priorTargets[0];
    deps.recordEvent(
      "telegram",
      "Leader thread preserved after session lifecycle change",
      {
        phase: "leader-thread-reused",
        instanceId: deps.instanceId,
        chatId: record.target.chatId,
        threadId: record.target.threadId,
        slot: record.slot,
      },
    );
    assertLeaderEpoch("before-reuse");
    return {
      target: record.target,
      slot: record.slot ?? "A",
      ...(record.threadName ? { threadName: record.threadName } : {}),
      reused: true,
    };
  }
  let forcedUnnamedStale = false;
  if (deps.forceFreshUnnamed) {
    for (const record of priorTargets) {
      const isLeaderOwned =
        record.owner?.kind === "leader" ||
        (!record.owner &&
          (record.profileKey.startsWith("cwd:") ||
            record.profileKey.startsWith("leader:")));
      if (!isLeaderOwned) continue;
      if (record.threadName) continue;
      forcedUnnamedStale =
        deps.topicTargetStore.markStaleByTarget(record.target) ||
        forcedUnnamedStale;
      deps.recordEvent("telegram", "Unnamed leader thread binding refreshed", {
        phase: "leader-thread-force-fresh-unnamed",
        instanceId: deps.instanceId,
        chatId: record.target.chatId,
        threadId: record.target.threadId,
        slot: record.slot,
      });
    }
    if (forcedUnnamedStale) await deps.topicTargetStore.persist();
  }
  assertLeaderEpoch("before-provision");
  const ownTarget = await provisionOwnBusTopic({
    getAllowedUserId: deps.getAllowedUserId,
    instanceId: deps.instanceId,
    cwd: deps.cwd,
    telegramProfile: deps.telegramProfile,
    getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
    getThreadReconciliationMachineState:
      deps.getThreadReconciliationMachineState,
    recordThreadReconciliationPlan: deps.recordThreadReconciliationPlan,
    store: deps.topicTargetStore,
    callApi: deps.callApi,
    getNowMs: deps.getNowMs,
    getRandom: deps.getRandom,
    recordEvent: deps.recordEvent,
  });
  assertLeaderEpoch("after-provision");
  if (!ownTarget) return undefined;
  const replacementPlan = ThreadReconciler.planThreadReconciliation({
    nowMs: Date.now(),
    currentLeaderEpoch: deps.getCurrentLeaderEpoch?.(),
    previousState: deps.getThreadReconciliationMachineState?.(),
    records: priorTargets,
    pendingProvisions: deps.topicTargetStore.listPendingProvisions(),
    replacedBindings: [
      {
        instanceId: deps.instanceId,
        replacementTarget: ownTarget.target,
      },
    ],
  });
  deps.recordThreadReconciliationPlan?.(replacementPlan);
  await ThreadReconciler.applyThreadReconciliationPlan(replacementPlan, {
    callApi: deps.callApi,
    markStaleByTarget: (target, syncStatus, lastSyncError) =>
      deps.topicTargetStore.markStaleByTarget(
        target,
        syncStatus,
        lastSyncError,
      ),
    persist: () => deps.topicTargetStore.persist(),
    removePendingProvisionById: (id) =>
      deps.topicTargetStore.removePendingProvision(id),
    getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
    recordRuntimeEvent: deps.recordEvent,
  });
  assertLeaderEpoch("before-final-persist");
  await deps.topicTargetStore.persist();
  assertLeaderEpoch("after-final-persist");
  return ownTarget;
}

export const TELEGRAM_SYNC_SLICES = [
  "bot-identity",
  "bot-capabilities",
  "pairing",
  "allowed-user",
  "topic-capability",
  "topic-state",
  "target-bindings",
  "reservations",
  "transport-health",
] as const;

export type TelegramSyncSlice = (typeof TELEGRAM_SYNC_SLICES)[number];

export type TelegramSyncTrigger =
  | "startup"
  | "reload"
  | "topic-lifecycle"
  | "stale-api-error"
  | "setup-change"
  | "pairing-change"
  | "follower-register"
  | "follower-prune"
  | "status-request"
  | "leader-health-tick"
  | "ordinary-message"
  | "ordinary-send";

export interface TelegramSyncSliceState {
  status: "fresh" | "suspect" | "unknown";
  updatedAtMs?: number;
  suspectAtMs?: number;
  reason?: string;
  lastReconcileAction?: string;
}

export type TelegramSyncState = Partial<
  Record<TelegramSyncSlice, TelegramSyncSliceState>
>;

export function createUnknownTelegramSyncState(): TelegramSyncState {
  return Object.fromEntries(
    TELEGRAM_SYNC_SLICES.map((slice) => [slice, { status: "unknown" }]),
  ) as TelegramSyncState;
}

export interface TelegramSyncStateRuntime {
  getState(): TelegramSyncState;
  setState(state: TelegramSyncState): void;
  markConfigChange(action: string): void;
  markSliceFresh(
    slice: TelegramSyncSlice,
    options: { nowMs: number; action: string },
  ): void;
}

export function createTelegramConfigSyncPersister<TConfig>(deps: {
  persist: (config?: TConfig) => Promise<void>;
  markConfigChange: (action: string) => void;
}): (config?: TConfig) => Promise<void> {
  return async (config) => {
    await deps.persist(config);
    deps.markConfigChange("config-persist");
  };
}

export function createTelegramSyncStateRuntime(
  initialState = createUnknownTelegramSyncState(),
): TelegramSyncStateRuntime {
  let state = initialState;
  return {
    getState: () => state,
    setState(nextState) {
      state = nextState;
    },
    markConfigChange(action) {
      state = markTelegramConfigSyncChange(state, action);
    },
    markSliceFresh(slice, options) {
      state = markTelegramSyncSliceFresh(state, slice, options);
    },
  };
}

export interface TelegramProvisioningActivityRuntime {
  isActive(): boolean;
  start(): void;
  end(): void;
}

export function createTelegramProvisioningActivityRuntime(): TelegramProvisioningActivityRuntime {
  let activeCount = 0;
  return {
    isActive: () => activeCount > 0,
    start() {
      activeCount += 1;
    },
    end() {
      activeCount = Math.max(0, activeCount - 1);
    },
  };
}

const RECONCILE_TRIGGERS = new Set<TelegramSyncTrigger>([
  "startup",
  "reload",
  "topic-lifecycle",
  "stale-api-error",
  "setup-change",
  "pairing-change",
  "follower-register",
  "follower-prune",
  "status-request",
  "leader-health-tick",
]);

export function shouldReconcileTelegramSync(
  trigger: TelegramSyncTrigger,
): boolean {
  return RECONCILE_TRIGGERS.has(trigger);
}

export function markTelegramSyncSliceSuspect(
  state: TelegramSyncState,
  slice: TelegramSyncSlice,
  input: {
    reason: string;
    nowMs: number;
    action?: string;
  },
): TelegramSyncState {
  return {
    ...state,
    [slice]: {
      ...(state[slice] ?? { status: "unknown" }),
      status: "suspect",
      suspectAtMs: input.nowMs,
      reason: input.reason,
      lastReconcileAction: input.action,
    },
  };
}

export function markTelegramSyncSliceFresh(
  state: TelegramSyncState,
  slice: TelegramSyncSlice,
  input: {
    nowMs: number;
    action: string;
  },
): TelegramSyncState {
  return {
    ...state,
    [slice]: {
      status: "fresh",
      updatedAtMs: input.nowMs,
      lastReconcileAction: input.action,
    },
  };
}

export function createTelegramObservedTopicLifecycleSyncHandler<
  TMessage = unknown,
  TSyncState extends TelegramSyncState = TelegramSyncState,
>(
  deps: TelegramObservedTopicLifecycleSyncDeps<TSyncState>,
): TelegramTopicLifecycleSyncHandler<TMessage> {
  const syncTopicLifecycle =
    createTelegramTopicLifecycleSyncHandler<TMessage>(deps);
  return async (lifecycle) => {
    const nowMs = deps.getNowMs ?? Date.now;
    deps.setSyncState(
      markTelegramSyncSliceSuspect(deps.getSyncState(), "topic-state", {
        nowMs: nowMs(),
        reason: `topic-${lifecycle.kind}`,
        action: "topic-lifecycle",
      }) as TSyncState,
    );
    await syncTopicLifecycle(lifecycle);
    deps.setSyncState(
      markTelegramSyncSliceFresh(deps.getSyncState(), "topic-state", {
        nowMs: nowMs(),
        action: "topic-lifecycle",
      }) as TSyncState,
    );
  };
}

export function createTelegramTopicLifecycleSyncHandler<TMessage = unknown>(
  deps: TelegramTopicLifecycleSyncDeps,
): TelegramTopicLifecycleSyncHandler<TMessage> {
  return async (lifecycle) => {
    await deps.topicTargetStore.load();
    const nowMs = Date.now();
    const plan = ThreadReconciler.planThreadReconciliation({
      nowMs,
      currentLeaderEpoch: deps.getCurrentLeaderEpoch?.(),
      previousState: deps.getThreadReconciliationMachineState?.(),
      records: deps.topicTargetStore.list(),
      reservations: deps.topicTargetStore.listReservations(),
      pendingProvisions: deps.topicTargetStore.listPendingProvisions(),
      observations: [
        {
          target: lifecycle.target,
          syncStatus: lifecycle.kind === "closed" ? "closed" : "open",
          observedAtMs: nowMs,
        },
      ],
    });
    deps.recordThreadReconciliationPlan?.(plan);
    const result = await ThreadReconciler.applyThreadReconciliationPlan(plan, {
      markActiveByTarget: (target) =>
        deps.topicTargetStore.markActiveByTarget(target),
      markStaleByTarget: (target, syncStatus, lastSyncError) =>
        deps.topicTargetStore.markStaleByTarget(
          target,
          syncStatus,
          lastSyncError,
        ),
      persist: () => deps.topicTargetStore.persist(),
      removePendingProvisionById: (id) =>
        deps.topicTargetStore.removePendingProvision(id),
      getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
      recordRuntimeEvent: deps.recordEvent,
    });
    const changed = result.changed;
    if (lifecycle.kind === "created" && deps.isBusEnabled()) {
      const target = lifecycle.target;
      const isKnownInRecords = deps.topicTargetStore.list().some((record) => {
        return (
          record.target.chatId === target.chatId &&
          record.target.threadId === target.threadId
        );
      });
      const isKnownInReservations = deps.topicTargetStore
        .listReservations()
        .some((reservation) => {
          return (
            reservation.target.chatId === target.chatId &&
            reservation.target.threadId === target.threadId
          );
        });
      if (!isKnownInRecords && !isKnownInReservations) {
        deps.recordEvent?.(
          "telegram",
          deps.isTopicProvisioningActive?.()
            ? "Telegram unknown topic creation observed during provisioning"
            : "Telegram unknown topic creation observed",
          {
            phase: deps.isTopicProvisioningActive?.()
              ? "topic-lifecycle-provisioning-skip"
              : "topic-lifecycle-unknown-created-observed",
            chatId: target.chatId,
            threadId: target.threadId,
          },
        );
      }
    }
    deps.recordEvent?.("telegram", "Telegram topic lifecycle update", {
      phase: "topic-lifecycle",
      lifecycle: lifecycle.kind,
      chatId: lifecycle.target.chatId,
      threadId: lifecycle.target.threadId,
      changed,
    });
  };
}
