/**
 * Telegram synchronization helpers
 * Zones: Telegram bot reality mirror, demand-driven reconciliation, status diagnostics
 * Owns pure contracts for deciding when local Telegram mirror state should be refreshed without querying Telegram on every action
 */

import { getTelegramApiErrorRequestTarget, isTelegramStaleTargetHttpError } from "./telegram-api.ts";
import { getTelegramTargetKey, type TelegramTarget } from "./target.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
import {
  createTelegramWorkspaceAdmissionOperationId,
  runWithTelegramWorkspaceAdmissionsAsync,
  type TelegramWorkspaceAdmissionLedger,
} from "./workspace-admission.ts";
import {
  createTelegramCleanupTargetProtection,
  commitTelegramWorkspaceProvisionBinding,
  getTelegramTargetFromApiBody,
  getTelegramThreadOwnerKey,
  isSameTelegramProcessInstance,
  isTelegramTopicTargetStaleError,
  normalizeTelegramWorkspacePath,
  provisionOwnBusTopic,
  type TelegramOwnTopicProvisionResult,
  type TelegramTopicTargetStore,
  type TelegramWorkspaceDisplayBinding,
  type TelegramWorkspaceThreadBinding,
} from "./threads.ts";

export interface TelegramTopicLifecycleSyncUpdate<TMessage = unknown> {
  kind: "created" | "closed" | "reopened";
  target: TelegramTarget & { threadId: number };
  message: TMessage;
}

export type TelegramSyncWorkspaceOperationRunner = <T>(
  input: {
    operationId: string;
    operationKind: string;
    scopes: readonly [{ kind: "profile" }];
  },
  operation: () => Promise<T>,
) => Promise<T>;

export interface TelegramLeaderThreadSyncDeps {
  getAllowedUserId: () => number | undefined;
  instanceId: string;
  cwd?: string;
  telegramProfile?: string;
  forceFreshUnnamed?: boolean;
  requestedThreadName?: string;
  resolveInitialWorkspaceDisplayTitle?: (
    binding: TelegramWorkspaceDisplayBinding,
  ) => string | undefined;
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
  probeWorkspaceBinding?: (
    binding: TelegramWorkspaceThreadBinding,
  ) => Promise<void>;
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
  assertExecutionCurrent?: (message: unknown) => void;
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
  runWorkspaceOperation: TelegramSyncWorkspaceOperationRunner;
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
    | {
        target: TelegramTarget;
        instanceId?: string;
        profileKey?: string;
        owner?: { kind?: string };
      }
    | undefined;
  topicTargetStore: Pick<
    TelegramTopicTargetStore,
    | "list"
    | "markStaleByTarget"
    | "persist"
    | "upsertPendingCleanup"
    | "removePendingCleanup"
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
  runWorkspaceOperation: TelegramSyncWorkspaceOperationRunner;
  workspaceOperationKind?: string;
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

export interface TelegramSessionRestartThreadCleanupDeps<
  TSyncState extends TelegramSyncState,
> extends Omit<TelegramManualThreadDisconnectDeps<TSyncState>, "stopPolling"> {
  suspendPolling: () => Promise<void>;
}

export function createTelegramSessionRestartThreadCleanupHandler<
  TSyncState extends TelegramSyncState,
>(
  deps: TelegramSessionRestartThreadCleanupDeps<TSyncState>,
): () => Promise<string> {
  return createTelegramManualThreadDisconnectHandler({
    ...deps,
    workspaceOperationKind: "workspace.cleanup-session-restart",
    async stopPolling() {
      await deps.suspendPolling();
      return "Telegram bridge suspended for session restart.";
    },
  });
}

export interface TelegramThreadDisconnectAssembly {
  disconnect: () => Promise<string>;
  cleanupForSessionRestart: () => Promise<string>;
}

export function createTelegramThreadDisconnectAssembly<
  TSyncState extends TelegramSyncState,
>(
  deps: Omit<TelegramManualThreadDisconnectDeps<TSyncState>, "stopPolling"> & {
    stopPolling: () => Promise<string>;
    suspendPolling: () => Promise<void>;
  },
): TelegramThreadDisconnectAssembly {
  return {
    disconnect: createTelegramManualThreadDisconnectHandler({
      ...deps,
      workspaceOperationKind: "workspace.disconnect-thread",
      stopPolling: deps.stopPolling,
    }),
    cleanupForSessionRestart:
      createTelegramSessionRestartThreadCleanupHandler({
        ...deps,
        suspendPolling: deps.suspendPolling,
      }),
  };
}

export function createTelegramManualThreadDisconnectHandler<
  TSyncState extends TelegramSyncState,
>(deps: TelegramManualThreadDisconnectDeps<TSyncState>): () => Promise<string> {
  const operation = async (): Promise<string> => {
    const currentRecord = deps.getCurrentThreadRecord();
    let cleanupPending = false;
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
        const target = currentRecord.target as TelegramTarget & {
          threadId: number;
        };
        const runtimeGeneration = currentRecord.instanceId ?? deps.instanceId;
        const intent: ThreadReconciler.TelegramThreadCleanupIntent = {
          id: `cleanup:${deps.instanceId}:${runtimeGeneration}:${target.chatId}:${target.threadId}`,
          owner: isManualFollower ? "manual-follower" : "leader",
          instanceId: deps.instanceId,
          runtimeGeneration,
          ...(currentRecord.profileKey
            ? { profileKey: currentRecord.profileKey }
            : {}),
          target,
          requestedAtMs: (deps.getNowMs ?? Date.now)(),
        };
        const departingRecord = deps.topicTargetStore.list().find((record) => record.instanceId === currentRecord.instanceId &&
          record.target.chatId === target.chatId && record.target.threadId === target.threadId);
        const isCleanupTargetProtected = createTelegramCleanupTargetProtection(deps.topicTargetStore, departingRecord);
        deps.topicTargetStore.upsertPendingCleanup(intent);
        await deps.topicTargetStore.persist();
        const cleanupPlan = ThreadReconciler.planThreadReconciliation({
          nowMs: (deps.getNowMs ?? Date.now)(),
          currentLeaderEpoch: leaderEpoch,
          records: [],
          pendingCleanups: [intent],
        });
        const cleanup = await ThreadReconciler.applyThreadReconciliationPlan(
          cleanupPlan,
          {
            isCleanupTargetProtected,
            callApi(method, body) {
              return deps.callApi(method, body);
            },
            markStaleByTarget(targetToMark, syncStatus, lastSyncError) {
              return deps.topicTargetStore.markStaleByTarget(
                targetToMark,
                syncStatus,
                lastSyncError,
              );
            },
            removeCleanupIntentById(id) {
              return deps.topicTargetStore.removePendingCleanup(id);
            },
            persist() {
              return deps.topicTargetStore.persist();
            },
            getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
            recordRuntimeEvent: deps.recordRuntimeEvent,
          },
        );
        if (cleanupPlan.actions.some((action) => isCleanupTargetProtected(action.target, action))) {
          return "Thread disconnect superseded by a new binding.";
        }
        cleanupPending = Boolean(cleanup.incompleteActions?.length);
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
    const stopped = await deps.stopPolling();
    return cleanupPending
      ? `${stopped} Telegram thread cleanup remains pending for the next leader.`
      : stopped;
  };
  return () => deps.runWorkspaceOperation(
    {
      operationId: createTelegramWorkspaceAdmissionOperationId(),
      operationKind: deps.workspaceOperationKind ?? "workspace.disconnect-thread",
      scopes: [{ kind: "profile" }],
    },
    operation,
  );
}

export function createTelegramLeaderHealthRuntime<
  TSyncState extends TelegramSyncState,
>(
  deps: TelegramLeaderHealthRuntimeDeps<TSyncState>,
): TelegramLeaderHealthRuntime {
  const intervalMs = deps.intervalMs ?? 60_000;
  const getNowMs = deps.getNowMs ?? Date.now;
  let interval: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  let tickPromise: Promise<void> | undefined;

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
    try {
      deps.recordEvent("telegram", error, { phase: "leader-health-tick" });
    } catch {
      // Health diagnostics cannot create an unhandled timer rejection.
    }
  };

  const stop = (): void => {
    generation += 1;
    if (interval) clearInterval(interval);
    interval = undefined;
    tickPromise = undefined;
  };
  const requestTick = (): Promise<void> => {
    if (tickPromise) return tickPromise;
    const expectedGeneration = generation;
    let tracked: Promise<void>;
    tracked = Promise.resolve()
      .then(deps.callGetMe)
      .then(
        () => {
          if (generation !== expectedGeneration) return;
          try {
            markFresh();
          } catch (stateError) {
            try {
              deps.recordEvent("telegram", stateError, {
                phase: "leader-health-state",
              });
            } catch {
              // State and diagnostic failure remain contained by this owner.
            }
          }
        },
        (error) => {
          if (generation !== expectedGeneration) return;
          try {
            markSuspect(error);
          } catch (stateError) {
            try {
              deps.recordEvent("telegram", stateError, {
                phase: "leader-health-state",
              });
            } catch {
              // State and diagnostic failure remain contained by this owner.
            }
          }
        },
      )
      .finally(() => {
        if (tickPromise === tracked) tickPromise = undefined;
      });
    tickPromise = tracked;
    return tracked;
  };

  return {
    start() {
      stop();
      interval = setInterval(() => {
        void requestTick();
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
  > & Partial<Pick<TelegramTopicTargetStore, "invalidateTarget">>;
  getSyncState: () => TSyncState;
  setSyncState: (state: TSyncState) => void;
  recordEvent: (
    category: string,
    message: unknown,
    details?: Record<string, unknown>,
  ) => void;
  getNowMs?: () => number;
  isCurrent?: () => boolean;
  isAuthorityCurrent?: () => boolean;
  getWorkspaceAdmission?: () => Pick<
    TelegramWorkspaceAdmissionLedger,
    "acquireAdmission" | "releaseAdmission"
  > | undefined;
}

export function captureTelegramStaleTargetRequestRecovery<TSyncState extends TelegramSyncState>(
  body: Record<string, unknown>,
  deps: TelegramStaleTopicApiErrorRecoveryDeps<TSyncState> & {
    topicTargetStore: Pick<TelegramTopicTargetStore, "load" | "list" | "markStaleByTarget" | "persist" | "invalidateTarget">;
    getCurrentLeaderEpoch: () => number | string | undefined;
    getSessionGeneration: () => number;
    getProfileName: () => string | undefined;
    onRecovered: () => void;
  },
): ((error: unknown) => Promise<void>) | undefined {
  const target = getTelegramTargetFromApiBody(body);
  const epoch = deps.getCurrentLeaderEpoch();
  if (!target || epoch === undefined) return undefined;
  const key = getTelegramTargetKey(target);
  const record = deps.topicTargetStore.list().find((candidate) => getTelegramTargetKey(candidate.target) === key);
  if (!record) return undefined;
  const generation = deps.getSessionGeneration();
  const profile = deps.getProfileName();
  const isAuthorityCurrent = (): boolean => deps.getCurrentLeaderEpoch() === epoch &&
    deps.getSessionGeneration() === generation && deps.getProfileName() === profile;
  const isCurrent = (): boolean => {
    const current = deps.topicTargetStore.list().find((candidate) => getTelegramTargetKey(candidate.target) === key);
    return isAuthorityCurrent() &&
      current?.instanceId === record.instanceId && current?.profileKey === record.profileKey &&
      current?.updatedAtMs === record.updatedAtMs && current?.createdAtMs === record.createdAtMs;
  };
  return async (error) => {
    const requestTarget = getTelegramApiErrorRequestTarget(error);
    if (!isTelegramStaleTargetHttpError(error) || !requestTarget ||
      getTelegramTargetKey(requestTarget) !== key || !isCurrent()) return;
    if (await recoverStaleTelegramTopicApiError(
      { chat_id: target.chatId, message_thread_id: target.threadId }, error, { ...deps, isCurrent, isAuthorityCurrent },
    )) {
      deps.onRecovered();
    }
  };
}

export function createTelegramStaleTopicApiErrorRecoveryRuntime<
  TSyncState extends TelegramSyncState,
>(
  deps: TelegramStaleTopicApiErrorRecoveryDeps<TSyncState>,
): (apiBody: unknown, error: unknown) => Promise<boolean> {
  return (apiBody, error) =>
    recoverStaleTelegramTopicApiError(apiBody, error, deps);
}

export async function settleStaleTelegramTopicExecutionFailure<
  TSyncState extends TelegramSyncState,
>(
  error: unknown,
  deps: TelegramStaleTopicApiErrorRecoveryDeps<TSyncState>,
): Promise<boolean> {
  const target = getTelegramApiErrorRequestTarget(error);
  if (!target || !isTelegramTopicTargetStaleError(error)) return false;
  await recoverStaleTelegramTopicApiError(
    { chat_id: target.chatId, message_thread_id: target.threadId },
    error,
    deps,
  );
  return true;
}

export async function recoverStaleTelegramTopicApiError<
  TSyncState extends TelegramSyncState,
>(
  apiBody: unknown,
  error: unknown,
  deps: TelegramStaleTopicApiErrorRecoveryDeps<TSyncState>,
): Promise<boolean> {
  const target = getTelegramTargetFromApiBody(apiBody);
  if (
    !target ||
    !isTelegramTopicTargetStaleError(error) ||
    deps.isCurrent?.() === false
  ) return false;
  const recover = async (): Promise<boolean> => {
    if (deps.isCurrent) {
      if (
        !deps.topicTargetStore.invalidateTarget ||
        !await deps.topicTargetStore.invalidateTarget(
          target,
          deps.isCurrent,
          String(error),
        )
      ) return false;
      if (deps.isAuthorityCurrent?.() === false) return false;
    } else {
      await deps.topicTargetStore.load();
      if (
        !deps.topicTargetStore.markStaleByTarget(
          target,
          "deleted",
          String(error),
        )
      ) return false;
      await deps.topicTargetStore.persist();
    }
    const nowMs = (deps.getNowMs ?? Date.now)();
    let state = markTelegramSyncSliceSuspect(
      deps.getSyncState(),
      "topic-state",
      {
        nowMs,
        reason: "stale-api-error",
        action: "topic-target-stale",
      },
    ) as TSyncState;
    state = markTelegramSyncSliceSuspect(state, "transport-health", {
      nowMs,
      reason: "stale-api-error",
      action: "topic-target-stale",
    }) as TSyncState;
    state = markTelegramSyncSliceSuspect(state, "target-bindings", {
      nowMs,
      reason: "stale-api-error",
      action: "topic-target-stale",
    }) as TSyncState;
    deps.setSyncState(state);
    deps.recordEvent("bus", error, {
      phase: "topic-target-stale",
      chatId: target.chatId,
      threadId: target.threadId,
    });
    return true;
  };
  if (!deps.getWorkspaceAdmission) return recover();
  const admission = deps.getWorkspaceAdmission();
  if (!admission) {
    throw new Error("Telegram Workspace admission authority is unavailable.");
  }
  return runWithTelegramWorkspaceAdmissionsAsync({
    ledger: admission,
    operationId: createTelegramWorkspaceAdmissionOperationId(),
    operationKind: "workspace.recover-stale-target",
    scopes: [{ kind: "target", target }],
    operation: recover,
    onReleaseError(releaseError) {
      deps.recordEvent("bus", releaseError, {
        phase: "workspace-admission-release",
        operationKind: "workspace.recover-stale-target",
        chatId: target.chatId,
        threadId: target.threadId,
      });
    },
  });
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
  const normalizedLeaderCwd = deps.cwd
    ? normalizeTelegramWorkspacePath(deps.cwd)
    : undefined;
  const leaderOwner = {
    kind: "leader" as const,
    cwd: normalizedLeaderCwd,
    instanceId: deps.instanceId,
    ...(deps.telegramProfile ? { telegramProfile: deps.telegramProfile } : {}),
  };
  const leaderProfileKey = getTelegramThreadOwnerKey(leaderOwner);
  const legacyLeaderRecord =
    deps.topicTargetStore.getByProfileKey(leaderProfileKey);
  const workspaceIdentity = normalizedLeaderCwd
    ? deps.topicTargetStore.claimWorkspaceIdentity(
        normalizedLeaderCwd,
        deps.instanceId,
        legacyLeaderRecord?.instanceId,
      )
    : undefined;
  if (deps.cwd && !workspaceIdentity) {
    throw new Error("Telegram Workspace identity is already claimed.");
  }
  const commitWorkspaceBinding = async (
    result: TelegramOwnTopicProvisionResult,
  ): Promise<TelegramOwnTopicProvisionResult> => {
    if (!workspaceIdentity) return result;
    const committed = commitTelegramWorkspaceProvisionBinding({
      store: deps.topicTargetStore,
      instanceId: deps.instanceId,
      profileKey: leaderProfileKey,
      displayTitle: result.displayTitle,
      binding: {
        ...workspaceIdentity,
        target: { ...result.target },
        ...(result.threadName ? { threadName: result.threadName } : {}),
        ...(result.slot ? { slot: result.slot } : {}),
        journalBindingKeys: [],
        journalBindingsComplete: true,
        updatedAtMs: deps.getNowMs?.() ?? Date.now(),
      },
    });
    deps.topicTargetStore.markWorkspaceBindingActiveByTarget(result.target);
    assertLeaderEpoch("before-workspace-persist");
    await deps.topicTargetStore.persist();
    assertLeaderEpoch("after-workspace-persist");
    return { ...result, ...(committed.displayTitle ? { displayTitle: committed.displayTitle } : {}) };
  };
  try {
  const unavailableTargetKeys = new Set([
    ...deps.topicTargetStore
      .listSyncObservations()
      .filter((observation) => observation.syncStatus === "deleted")
      .map((observation) => getTelegramTargetKey(observation.target)),
    ...deps.topicTargetStore
      .listPendingCleanups()
      .map((intent) => getTelegramTargetKey(intent.target)),
  ]);
  let invalidatedUnavailableTarget = false;
  for (const record of deps.topicTargetStore.list()) {
    if (
      record.instanceId !== deps.instanceId ||
      !unavailableTargetKeys.has(getTelegramTargetKey(record.target))
    ) {
      continue;
    }
    invalidatedUnavailableTarget =
      deps.topicTargetStore.markStaleByTarget(record.target) ||
      invalidatedUnavailableTarget;
  }
  if (invalidatedUnavailableTarget) {
    assertLeaderEpoch("before-unavailable-persist");
    await deps.topicTargetStore.persist();
    assertLeaderEpoch("after-unavailable-persist");
  }
  const persistedWorkspaceBinding = workspaceIdentity
    ? deps.topicTargetStore.getWorkspaceBinding(
        workspaceIdentity.cwd,
        workspaceIdentity.instanceSlot,
      )
    : undefined;
  const legacyWorkspaceBinding =
    workspaceIdentity?.instanceSlot === "a" &&
    !persistedWorkspaceBinding &&
    typeof legacyLeaderRecord?.target.threadId === "number"
      ? {
          ...workspaceIdentity,
          target: { ...legacyLeaderRecord.target },
          ...(legacyLeaderRecord.threadName
            ? { threadName: legacyLeaderRecord.threadName }
            : {}),
          ...(legacyLeaderRecord.slot ? { slot: legacyLeaderRecord.slot } : {}),
          updatedAtMs: legacyLeaderRecord.updatedAtMs,
        }
      : undefined;
  const recoverableWorkspaceBinding =
    persistedWorkspaceBinding ?? legacyWorkspaceBinding;
  const recoverableTargetKey = recoverableWorkspaceBinding
    ? getTelegramTargetKey(recoverableWorkspaceBinding.target)
    : undefined;
  const recoverableRecord = recoverableWorkspaceBinding
    ? deps.topicTargetStore
        .list()
        .find(
          (record) =>
            getTelegramTargetKey(record.target) === recoverableTargetKey,
        )
    : undefined;
  const sameProcessWorkspaceBinding =
    !!recoverableRecord &&
    (recoverableRecord.instanceId === deps.instanceId ||
      isSameTelegramProcessInstance(
        recoverableRecord.instanceId,
        deps.instanceId,
      ));
  if (
    recoverableWorkspaceBinding &&
    !unavailableTargetKeys.has(recoverableTargetKey ?? "") &&
    (!deps.forceFreshUnnamed || recoverableWorkspaceBinding.threadName) &&
    (sameProcessWorkspaceBinding || deps.probeWorkspaceBinding)
  ) {
    let workspaceTargetVisible = sameProcessWorkspaceBinding;
    if (!workspaceTargetVisible && deps.probeWorkspaceBinding) {
      assertLeaderEpoch("before-workspace-probe");
      try {
        await deps.probeWorkspaceBinding(recoverableWorkspaceBinding);
        assertLeaderEpoch("after-workspace-probe");
        workspaceTargetVisible = true;
      } catch (error) {
        if (!isTelegramTopicTargetStaleError(error)) throw error;
        deps.topicTargetStore.markStaleByTarget(
          recoverableWorkspaceBinding.target,
          "deleted",
          error instanceof Error ? error.message : String(error),
        );
        await deps.topicTargetStore.persist();
        deps.recordEvent("bus", error, {
          phase: "leader-workspace-target-stale",
          chatId: recoverableWorkspaceBinding.target.chatId,
          threadId: recoverableWorkspaceBinding.target.threadId,
          instanceId: deps.instanceId,
        });
      }
    }
    if (workspaceTargetVisible) {
      const nowMs = deps.getNowMs?.() ?? Date.now();
      const slot = workspaceIdentity?.slot;
      if (!slot) {
        throw new Error("Telegram Thread slot authority is unavailable.");
      }
      const recovered = await commitWorkspaceBinding({
        target: { ...recoverableWorkspaceBinding.target },
        slot,
        ...(recoverableWorkspaceBinding.threadName
          ? { threadName: recoverableWorkspaceBinding.threadName }
          : {}),
        reused: true,
      });
      deps.topicTargetStore.upsert({
        profileKey: leaderProfileKey,
        owner: leaderOwner,
        target: { ...recovered.target },
        status: "active",
        createdAtMs: recoverableRecord?.createdAtMs ?? nowMs,
        updatedAtMs: nowMs,
        ...(recovered.threadName ? { threadName: recovered.threadName } : {}),
        instanceId: deps.instanceId,
        slot: recovered.slot,
        syncStatus: "open",
        lastSyncObservedAtMs: nowMs,
        lastReconcileAction: "leader-workspace-binding-recovered",
      });
      assertLeaderEpoch("before-recovered-record-persist");
      await deps.topicTargetStore.persist();
      assertLeaderEpoch("after-recovered-record-persist");
      deps.recordEvent(
        "telegram",
        "Leader thread preserved after Workspace recovery",
        {
          phase: "leader-thread-reused",
          instanceId: deps.instanceId,
          chatId: recovered.target.chatId,
          threadId: recovered.target.threadId,
          slot: recovered.slot,
        },
      );
      return recovered;
    }
  }
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
    if (!record.slot) {
      throw new Error("Telegram Thread slot authority is unavailable.");
    }
    return await commitWorkspaceBinding({
      target: record.target,
      slot: record.slot,
      ...(record.threadName ? { threadName: record.threadName } : {}),
      reused: true,
    });
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
    cwd: normalizedLeaderCwd,
    telegramProfile: deps.telegramProfile,
    getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
    getThreadReconciliationMachineState:
      deps.getThreadReconciliationMachineState,
    recordThreadReconciliationPlan: deps.recordThreadReconciliationPlan,
    store: deps.topicTargetStore,
    callApi: deps.callApi,
    getNowMs: deps.getNowMs,
    getRandom: deps.getRandom,
    requestedThreadName:
      recoverableWorkspaceBinding?.threadName ?? deps.requestedThreadName,
    workspaceBindingKey: workspaceIdentity?.bindingKey,
    preferredSlot: workspaceIdentity?.slot,
    resolveInitialWorkspaceDisplayTitle:
      deps.resolveInitialWorkspaceDisplayTitle,
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
    isCleanupTargetProtected: createTelegramCleanupTargetProtection(deps.topicTargetStore),
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
  return await commitWorkspaceBinding(ownTarget);
  } finally {
    deps.topicTargetStore.releaseWorkspaceClaim(deps.instanceId);
  }
}

export const TELEGRAM_SYNC_SLICE_TARGET_BINDINGS = "target-bindings";

export const TELEGRAM_SYNC_SLICES = [
  "bot-identity",
  "bot-capabilities",
  "pairing",
  "allowed-user",
  "topic-capability",
  "topic-state",
  TELEGRAM_SYNC_SLICE_TARGET_BINDINGS,
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
  const operation = async (
    lifecycle: TelegramTopicLifecycleSyncUpdate<TMessage>,
  ): Promise<void> => {
    const nowMs = deps.getNowMs ?? Date.now;
    deps.assertExecutionCurrent?.(lifecycle.message);
    deps.setSyncState(
      markTelegramSyncSliceSuspect(deps.getSyncState(), "topic-state", {
        nowMs: nowMs(),
        reason: `topic-${lifecycle.kind}`,
        action: "topic-lifecycle",
      }) as TSyncState,
    );
    await syncTopicLifecycle(lifecycle);
    deps.assertExecutionCurrent?.(lifecycle.message);
    deps.setSyncState(
      markTelegramSyncSliceFresh(deps.getSyncState(), "topic-state", {
        nowMs: nowMs(),
        action: "topic-lifecycle",
      }) as TSyncState,
    );
  };
  return (lifecycle) => deps.runWorkspaceOperation(
    {
      operationId: createTelegramWorkspaceAdmissionOperationId(),
      operationKind: "workspace.sync-topic-lifecycle",
      scopes: [{ kind: "profile" }],
    },
    () => operation(lifecycle),
  );
}

export function createTelegramTopicLifecycleSyncHandler<TMessage = unknown>(
  deps: TelegramTopicLifecycleSyncDeps,
): TelegramTopicLifecycleSyncHandler<TMessage> {
  return async (lifecycle) => {
    deps.assertExecutionCurrent?.(lifecycle.message);
    await deps.topicTargetStore.load();
    deps.assertExecutionCurrent?.(lifecycle.message);
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
