/**
 * Telegram thread lifecycle reconciler
 * Zones: telegram, multi-instance bus, synchronization control plane
 * Owns pure planning for Telegram thread/tab lifecycle reconciliation and destructive topic cleanup authority
 * Excludes live Telegram API calls, inbound routing, menu rendering, and direct thread-store persistence
 */

import type { TelegramTarget } from "./target.ts";

type ThreadTarget = TelegramTarget & { threadId: number };

type ThreadRecordStatus =
  | "active"
  | "offline"
  | "stale"
  | "pending"
  | "starting"
  | "probe-required"
  | "failed";

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
  target?: TelegramTarget & { threadId: number };
  startedAtMs: number;
  expiresAtMs?: number;
  leaderEpoch?: number | string;
}

export interface TelegramUnboundThreadMessageObservation {
  target: TelegramTarget & { threadId: number };
  observedAtMs: number;
  messageId?: number;
  leaderEpoch?: number | string;
}

export interface TelegramReservedThreadMessageObservation {
  target: TelegramTarget & { threadId: number };
  observedAtMs: number;
  messageId?: number;
  leaderEpoch?: number | string;
}

export interface ThreadReservationProbeResult {
  target: ThreadTarget;
  stale: boolean;
}

export interface ReplacedInstanceBindingInput {
  instanceId: string;
  replacementTarget: ThreadTarget;
}

export interface PreviousLeaderCleanupInput {
  currentInstanceId: string;
}

export type ThreadReconciliationAction =
  | {
      kind: "mark-topic-active";
      target: TelegramTarget & { threadId: number };
      reason: "observed-open";
    }
  | {
      kind: "mark-topic-stale";
      target: TelegramTarget & { threadId: number };
      syncStatus: "closed" | "deleted";
      reason: "observed-closed" | "observed-deleted";
    }
  | {
      kind: "close-delete-unbound-topic";
      target: TelegramTarget & { threadId: number };
      observedAtMs: number;
      messageId?: number;
      reason: "unbound-user-message";
      leaderEpoch?: number | string;
    }
  | {
      kind: "close-delete-reserved-topic";
      target: TelegramTarget & { threadId: number };
      observedAtMs: number;
      messageId?: number;
      reason: "reserved-user-message" | "startup-reservation";
      leaderEpoch?: number | string;
    }
  | {
      kind: "close-stale-replaced-topic";
      target: TelegramTarget & { threadId: number };
      reason: "replaced-instance-binding";
      instanceId?: string;
      leaderEpoch?: number | string;
    }
  | {
      kind: "close-delete-pruned-follower-topic";
      target: TelegramTarget & { threadId: number };
      reason: "pruned-follower";
      instanceId?: string;
      messageId?: number;
      leaderEpoch?: number | string;
    }
  | {
      kind: "close-delete-replaced-follower-topic";
      target: TelegramTarget & { threadId: number };
      reason: "replaced-follower";
      instanceId?: string;
      messageId?: number;
      leaderEpoch?: number | string;
    }
  | {
      kind: "close-delete-previous-leader-topic";
      target: TelegramTarget & { threadId: number };
      reason: "previous-leader";
      instanceId?: string;
      messageId?: number;
      leaderEpoch?: number | string;
    }
  | {
      kind: "close-delete-disconnected-instance-topic";
      target: TelegramTarget & { threadId: number };
      reason: "manual-disconnect";
      instanceId?: string;
      messageId?: number;
      leaderEpoch?: number | string;
    }
  | {
      kind: "close-delete-expired-pending-provision-topic";
      target: TelegramTarget & { threadId: number };
      reason: "expired-pending-provision";
      pendingProvisionId: string;
      instanceId?: string;
      leaderEpoch?: number | string;
    }
  | {
      kind: "remove-reservation";
      target: TelegramTarget & { threadId: number };
      reason: "reservation-probe-stale";
    };

export type ThreadReconciliationPhase =
  "stable" | "provisioning" | "sync-required" | "cleanup-required";

export type ThreadReconciliationEvent =
  "settled" | "pending-provision" | "sync-required" | "cleanup-required";

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
  callApi?: <TResponse>(
    method: string,
    body: Record<string, unknown>,
  ) => Promise<TResponse>;
  markActiveByTarget?: (target: ThreadTarget) => boolean;
  markStaleByTarget?: (
    target: ThreadTarget,
    syncStatus?: "closed" | "deleted",
    lastSyncError?: string,
  ) => boolean;
  persist?: () => Promise<void>;
  removeReservationByTarget?: (target: ThreadTarget) => boolean;
  removePendingProvisionById?: (id: string) => boolean;
  getCurrentLeaderEpoch?: () => number | string | undefined;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface ThreadReconciliationInput {
  nowMs: number;
  currentLeaderEpoch?: number | string;
  records: readonly ThreadReconciliationRecord[];
  reservations?: readonly ThreadReconciliationReservation[];
  observations?: readonly ThreadReconciliationObservation[];
  pendingProvisions?: readonly TelegramThreadPendingProvision[];
  unboundMessages?: readonly TelegramUnboundThreadMessageObservation[];
  reservedMessages?: readonly TelegramReservedThreadMessageObservation[];
  proactiveReservationCleanup?: boolean;
  reservationProbeResults?: readonly ThreadReservationProbeResult[];
  prunedFollowerInstanceIds?: readonly string[];
  replacedBindings?: readonly ReplacedInstanceBindingInput[];
  previousLeaderCleanup?: PreviousLeaderCleanupInput;
  previousState?: ThreadReconciliationMachineState;
  freshCreationGraceMs?: number;
}

const DEFAULT_FRESH_CREATION_GRACE_MS = 30_000;

function targetKey(target: ThreadTarget): string {
  return `${target.chatId}:${target.threadId}`;
}

function isCurrentRecord(record: ThreadReconciliationRecord): boolean {
  return (
    record.status === "active" ||
    record.status === "starting" ||
    record.status === "pending"
  );
}

function isActiveOrStartingRecord(record: ThreadReconciliationRecord): boolean {
  return record.status === "active" || record.status === "starting";
}

function isPreviousLeaderRecord(record: ThreadReconciliationRecord): boolean {
  return (
    record.ownerKind === "leader" ||
    (!record.ownerKind &&
      (record.profileKey?.startsWith("cwd:") === true ||
        record.profileKey?.startsWith("leader:") === true))
  );
}

function isReservationAlive(
  reservation: ThreadReconciliationReservation,
  nowMs: number,
): boolean {
  return (
    reservation.expiresAtMs === undefined || reservation.expiresAtMs > nowMs
  );
}

function isPendingProvisionExpired(
  provision: TelegramThreadPendingProvision,
  nowMs: number,
): boolean {
  return provision.expiresAtMs !== undefined && provision.expiresAtMs <= nowMs;
}

function isPendingProvisionAlive(
  provision: TelegramThreadPendingProvision,
  nowMs: number,
  currentLeaderEpoch: number | string | undefined,
): boolean {
  if (isPendingProvisionExpired(provision, nowMs)) {
    return false;
  }
  if (
    currentLeaderEpoch !== undefined &&
    provision.leaderEpoch !== undefined &&
    provision.leaderEpoch !== currentLeaderEpoch
  ) {
    return false;
  }
  return true;
}

function isRecentOpenObservation(
  observation: ThreadReconciliationObservation,
  nowMs: number,
  graceMs: number,
): boolean {
  return (
    observation.syncStatus === "open" &&
    nowMs - observation.observedAtMs >= 0 &&
    nowMs - observation.observedAtMs <= graceMs
  );
}

function isCleanupAction(action: ThreadReconciliationAction): boolean {
  return (
    action.kind === "close-delete-unbound-topic" ||
    action.kind === "close-delete-reserved-topic" ||
    action.kind === "close-stale-replaced-topic" ||
    action.kind === "close-delete-pruned-follower-topic" ||
    action.kind === "close-delete-replaced-follower-topic" ||
    action.kind === "close-delete-previous-leader-topic" ||
    action.kind === "close-delete-disconnected-instance-topic" ||
    action.kind === "close-delete-expired-pending-provision-topic"
  );
}

function isSyncAction(action: ThreadReconciliationAction): boolean {
  return (
    action.kind === "mark-topic-active" ||
    action.kind === "mark-topic-stale" ||
    action.kind === "remove-reservation"
  );
}

function createThreadReconciliationMachineState(
  input: ThreadReconciliationInput,
  actions: readonly ThreadReconciliationAction[],
): ThreadReconciliationMachineState {
  const pendingProvisionCount = (input.pendingProvisions ?? []).filter(
    (provision) =>
      isPendingProvisionAlive(provision, input.nowMs, input.currentLeaderEpoch),
  ).length;
  const cleanupActionCount = actions.filter(isCleanupAction).length;
  const syncActionCount = actions.filter(isSyncAction).length;
  const phase: ThreadReconciliationPhase =
    cleanupActionCount > 0
      ? "cleanup-required"
      : pendingProvisionCount > 0
        ? "provisioning"
        : syncActionCount > 0
          ? "sync-required"
          : "stable";
  const event: ThreadReconciliationEvent =
    phase === "cleanup-required"
      ? "cleanup-required"
      : phase === "provisioning"
        ? "pending-provision"
        : phase === "sync-required"
          ? "sync-required"
          : "settled";
  return {
    phase,
    event,
    atMs: input.nowMs,
    ...(input.currentLeaderEpoch !== undefined
      ? { leaderEpoch: input.currentLeaderEpoch }
      : {}),
    pendingProvisionCount,
    syncActionCount,
    cleanupActionCount,
  };
}

function createThreadReconciliationTransition(
  previous: ThreadReconciliationMachineState | undefined,
  current: ThreadReconciliationMachineState,
): ThreadReconciliationTransition | undefined {
  if (!previous || previous.phase === current.phase) return undefined;
  return {
    from: previous.phase,
    to: current.phase,
    event: current.event,
    atMs: current.atMs,
  };
}

function getActionLeaderEpoch(
  action: ThreadReconciliationAction,
): number | string | undefined {
  return "leaderEpoch" in action ? action.leaderEpoch : undefined;
}

function isTelegramTopicTargetDeletedOrMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("topic_id_invalid") ||
    message.includes("message thread not found") ||
    message.includes("thread not found") ||
    message.includes("topic not found") ||
    message.includes("topic deleted")
  );
}

function isTelegramTopicTargetGoneError(error: unknown): boolean {
  if (isTelegramTopicTargetDeletedOrMissingError(error)) return true;
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("topic closed") ||
    message.includes("thread closed") ||
    message.includes("forum topic closed") ||
    message.includes("message thread closed")
  );
}

function shouldSkipForStaleLeaderEpoch(
  action: ThreadReconciliationAction,
  ports: ThreadReconciliationApplyPorts,
): boolean {
  const actionLeaderEpoch = getActionLeaderEpoch(action);
  const currentLeaderEpoch = ports.getCurrentLeaderEpoch?.();
  if (actionLeaderEpoch === undefined) {
    if (!ports.getCurrentLeaderEpoch) return false;
    ports.recordRuntimeEvent?.(
      "telegram",
      "Thread reconciliation destructive action has no leader epoch",
      {
        phase: "thread-reconciler-missing-leader-epoch",
        currentLeaderEpoch,
        action: action.kind,
        chatId: action.target.chatId,
        threadId: action.target.threadId,
      },
    );
    return true;
  }
  if (currentLeaderEpoch === actionLeaderEpoch) return false;
  ports.recordRuntimeEvent?.(
    "telegram",
    "Skipped stale-epoch thread reconciliation action",
    {
      phase: "thread-reconciler-stale-epoch-skip",
      action: action.kind,
      actionLeaderEpoch,
      currentLeaderEpoch,
      chatId: action.target.chatId,
      threadId: action.target.threadId,
    },
  );
  return true;
}

export interface ThreadReconciliationRuntime {
  getState: () => ThreadReconciliationMachineState | undefined;
  recordPlan: (plan: ThreadReconciliationPlan) => void;
  plan: (
    input: Omit<ThreadReconciliationInput, "previousState">,
  ) => ThreadReconciliationPlan;
}

export function createThreadReconciliationRuntime(deps: {
  recordRuntimeEvent: (
    category: string,
    message: unknown,
    details?: Record<string, unknown>,
  ) => void;
  scheduleSnapshotPersist: () => void;
}): ThreadReconciliationRuntime {
  let state: ThreadReconciliationMachineState | undefined;
  const recordPlan = (plan: ThreadReconciliationPlan): void => {
    if (!plan.state) return;
    state = plan.state;
    if (plan.transition) {
      deps.recordRuntimeEvent(
        "telegram",
        "Thread reconciliation phase changed",
        {
          phase: "thread-reconciliation-transition",
          from: plan.transition.from,
          to: plan.transition.to,
          event: plan.transition.event,
        },
      );
    }
    deps.scheduleSnapshotPersist();
  };
  return {
    getState: () => state,
    recordPlan,
    plan(input) {
      const plan = planThreadReconciliation({
        ...input,
        previousState: state,
      });
      recordPlan(plan);
      return plan;
    },
  };
}

export function planDisconnectedInstanceThreadCleanup(input: {
  target: TelegramTarget & { threadId: number };
  instanceId?: string;
  leaderEpoch?: number | string;
}): ThreadReconciliationPlan {
  return {
    actions: [
      {
        kind: "close-delete-disconnected-instance-topic",
        target: input.target,
        reason: "manual-disconnect",
        instanceId: input.instanceId,
        ...(input.leaderEpoch !== undefined
          ? { leaderEpoch: input.leaderEpoch }
          : {}),
      },
    ],
  };
}

export async function applyThreadReconciliationPlan(
  plan: ThreadReconciliationPlan,
  ports: ThreadReconciliationApplyPorts,
): Promise<ThreadReconciliationApplyResult> {
  let shouldPersist = false;
  const persistFences: ThreadReconciliationAction[] = [];
  const incompleteActions: ThreadReconciliationAction[] = [];
  for (const action of plan.actions) {
    if (action.kind === "remove-reservation") {
      shouldPersist =
        ports.removeReservationByTarget?.(action.target) || shouldPersist;
      continue;
    }
    if (action.kind === "mark-topic-active") {
      shouldPersist =
        ports.markActiveByTarget?.(action.target) || shouldPersist;
      continue;
    }
    if (action.kind === "mark-topic-stale") {
      shouldPersist =
        ports.markStaleByTarget?.(action.target, action.syncStatus) ||
        shouldPersist;
      continue;
    }
    if (action.kind === "close-stale-replaced-topic") {
      if (shouldSkipForStaleLeaderEpoch(action, ports)) {
        incompleteActions.push(action);
        continue;
      }
      if (!ports.callApi) {
        ports.recordRuntimeEvent?.(
          "telegram",
          "Skipped topic close without API port",
          {
            phase: "thread-reconciler-close-skip-no-api",
            reason: action.reason,
            chatId: action.target.chatId,
            threadId: action.target.threadId,
          },
        );
        incompleteActions.push(action);
        continue;
      }
      let closeConfirmed = false;
      try {
        await ports.callApi("closeForumTopic", {
          chat_id: action.target.chatId,
          message_thread_id: action.target.threadId,
        });
        closeConfirmed = true;
      } catch (error) {
        closeConfirmed = isTelegramTopicTargetGoneError(error);
        if (!closeConfirmed) {
          ports.recordRuntimeEvent?.("telegram", error, {
            phase: `thread-reconciler-${action.reason}-closeForumTopic`,
            instanceId: action.instanceId,
            chatId: action.target.chatId,
            threadId: action.target.threadId,
          });
        }
      }
      if (shouldSkipForStaleLeaderEpoch(action, ports) || !closeConfirmed) {
        incompleteActions.push(action);
        continue;
      }
      const changed =
        ports.markStaleByTarget?.(action.target, "closed") ?? false;
      if (changed) persistFences.push(action);
      shouldPersist = changed || shouldPersist;
      continue;
    }
    if (
      action.kind === "close-delete-unbound-topic" ||
      action.kind === "close-delete-reserved-topic" ||
      action.kind === "close-delete-pruned-follower-topic" ||
      action.kind === "close-delete-replaced-follower-topic" ||
      action.kind === "close-delete-previous-leader-topic" ||
      action.kind === "close-delete-disconnected-instance-topic" ||
      action.kind === "close-delete-expired-pending-provision-topic"
    ) {
      if (shouldSkipForStaleLeaderEpoch(action, ports)) {
        incompleteActions.push(action);
        continue;
      }
      if (!ports.callApi) {
        ports.recordRuntimeEvent?.(
          "telegram",
          "Skipped topic cleanup without API port",
          {
            phase: "thread-reconciler-cleanup-skip-no-api",
            reason: action.reason,
            chatId: action.target.chatId,
            threadId: action.target.threadId,
          },
        );
        incompleteActions.push(action);
        continue;
      }
      let deleteConfirmed = false;
      for (const method of ["closeForumTopic", "deleteForumTopic"]) {
        if (shouldSkipForStaleLeaderEpoch(action, ports)) break;
        try {
          await ports.callApi(method, {
            chat_id: action.target.chatId,
            message_thread_id: action.target.threadId,
          });
          if (method === "deleteForumTopic") deleteConfirmed = true;
        } catch (error) {
          const confirmsMethodOutcome =
            method === "deleteForumTopic"
              ? isTelegramTopicTargetDeletedOrMissingError(error)
              : isTelegramTopicTargetGoneError(error);
          if (confirmsMethodOutcome) {
            if (method === "deleteForumTopic") deleteConfirmed = true;
          } else {
            ports.recordRuntimeEvent?.("telegram", error, {
              phase: `thread-reconciler-${action.reason}-${method}`,
              chatId: action.target.chatId,
              threadId: action.target.threadId,
            });
          }
        }
      }
      if (shouldSkipForStaleLeaderEpoch(action, ports)) {
        incompleteActions.push(action);
        continue;
      }
      if (!deleteConfirmed) {
        ports.recordRuntimeEvent?.(
          "telegram",
          "Telegram topic cleanup incomplete",
          {
            phase: "thread-reconciler-cleanup-incomplete",
            action: action.kind,
            reason: action.reason,
            chatId: action.target.chatId,
            threadId: action.target.threadId,
            ...("messageId" in action ? { messageId: action.messageId } : {}),
          },
        );
        incompleteActions.push(action);
        continue;
      }
      if (shouldSkipForStaleLeaderEpoch(action, ports)) continue;
      if (
        action.kind !== "close-delete-previous-leader-topic" &&
        action.kind !== "close-delete-pruned-follower-topic" &&
        action.kind !== "close-delete-replaced-follower-topic" &&
        action.kind !== "close-delete-disconnected-instance-topic" &&
        action.kind !== "close-delete-expired-pending-provision-topic"
      ) {
        const changed =
          ports.markStaleByTarget?.(action.target, "deleted") ?? false;
        if (changed) persistFences.push(action);
        shouldPersist = changed || shouldPersist;
      }
      ports.recordRuntimeEvent?.(
        "telegram",
        action.kind === "close-delete-unbound-topic"
          ? "Unbound Telegram topic deleted"
          : action.kind === "close-delete-reserved-topic"
            ? "Reserved Telegram topic deleted"
            : action.kind === "close-delete-pruned-follower-topic"
              ? "Pruned follower Telegram topic deleted"
              : action.kind === "close-delete-replaced-follower-topic"
                ? "Replaced follower Telegram topic deleted"
                : action.kind === "close-delete-previous-leader-topic"
                  ? "Previous leader Telegram topic deleted"
                  : action.kind === "close-delete-disconnected-instance-topic"
                    ? "Disconnected instance Telegram topic deleted"
                    : "Expired pending provision Telegram topic deleted",
        {
          phase:
            action.kind === "close-delete-unbound-topic"
              ? "thread-reconciler-unbound-topic-delete"
              : action.kind === "close-delete-reserved-topic"
                ? "thread-reconciler-reserved-topic-delete"
                : action.kind === "close-delete-pruned-follower-topic"
                  ? "thread-reconciler-pruned-follower-topic-delete"
                  : action.kind === "close-delete-replaced-follower-topic"
                    ? "thread-reconciler-replaced-follower-topic-delete"
                    : action.kind === "close-delete-previous-leader-topic"
                      ? "thread-reconciler-previous-leader-topic-delete"
                      : action.kind ===
                          "close-delete-disconnected-instance-topic"
                        ? "thread-reconciler-disconnected-instance-topic-delete"
                        : "thread-reconciler-expired-pending-provision-topic-delete",
          chatId: action.target.chatId,
          threadId: action.target.threadId,
          ...("messageId" in action ? { messageId: action.messageId } : {}),
        },
      );
      if (
        action.kind === "close-delete-expired-pending-provision-topic" &&
        deleteConfirmed
      ) {
        if (shouldSkipForStaleLeaderEpoch(action, ports)) continue;
        const changed =
          ports.removePendingProvisionById?.(action.pendingProvisionId) ??
          false;
        if (changed) persistFences.push(action);
        shouldPersist = changed || shouldPersist;
      }
    }
  }
  if (shouldPersist) {
    for (const action of persistFences) {
      if (shouldSkipForStaleLeaderEpoch(action, ports)) {
        return {
          changed: true,
          ...(incompleteActions.length > 0 ? { incompleteActions } : {}),
        };
      }
    }
    await ports.persist?.();
  }
  return {
    changed: shouldPersist,
    ...(incompleteActions.length > 0 ? { incompleteActions } : {}),
  };
}

export function planThreadReconciliation(
  input: ThreadReconciliationInput,
): ThreadReconciliationPlan {
  const graceMs = input.freshCreationGraceMs ?? DEFAULT_FRESH_CREATION_GRACE_MS;
  const knownTargets = new Set(
    input.records.map((record) => targetKey(record.target)),
  );
  const currentTargets = new Set(
    input.records
      .filter(isCurrentRecord)
      .map((record) => targetKey(record.target)),
  );
  const allReservationTargets = new Set(
    (input.reservations ?? []).map((reservation) =>
      targetKey(reservation.target),
    ),
  );
  const reservedTargets = new Set(
    (input.reservations ?? [])
      .filter((reservation) => isReservationAlive(reservation, input.nowMs))
      .map((reservation) => targetKey(reservation.target)),
  );
  const pendingTargets = new Set(
    (input.pendingProvisions ?? [])
      .filter((provision) =>
        isPendingProvisionAlive(
          provision,
          input.nowMs,
          input.currentLeaderEpoch,
        ),
      )
      .flatMap((provision) =>
        provision.target ? [targetKey(provision.target)] : [],
      ),
  );
  const recentOpenTargets = new Set(
    (input.observations ?? [])
      .filter((observation) =>
        isRecentOpenObservation(observation, input.nowMs, graceMs),
      )
      .map((observation) => targetKey(observation.target)),
  );

  const actions: ThreadReconciliationAction[] = [];
  for (const provision of input.pendingProvisions ?? []) {
    if (!provision.target) continue;
    if (!isPendingProvisionExpired(provision, input.nowMs)) continue;
    const key = targetKey(provision.target);
    if (currentTargets.has(key)) continue;
    if (reservedTargets.has(key)) continue;
    if (recentOpenTargets.has(key)) continue;
    actions.push({
      kind: "close-delete-expired-pending-provision-topic",
      target: provision.target,
      reason: "expired-pending-provision",
      pendingProvisionId: provision.id,
      instanceId: provision.instanceId,
      ...(input.currentLeaderEpoch !== undefined
        ? { leaderEpoch: input.currentLeaderEpoch }
        : {}),
    });
  }

  for (const observation of input.observations ?? []) {
    if (observation.syncStatus === "open") {
      if (knownTargets.has(targetKey(observation.target))) {
        actions.push({
          kind: "mark-topic-active",
          target: observation.target,
          reason: "observed-open",
        });
      }
      continue;
    }
    if (
      observation.syncStatus === "closed" ||
      observation.syncStatus === "deleted"
    ) {
      if (currentTargets.has(targetKey(observation.target))) {
        actions.push({
          kind: "mark-topic-stale",
          target: observation.target,
          syncStatus: observation.syncStatus,
          reason:
            observation.syncStatus === "closed"
              ? "observed-closed"
              : "observed-deleted",
        });
      }
    }
  }

  for (const prunedInstanceId of input.prunedFollowerInstanceIds ?? []) {
    for (const record of input.records) {
      if (record.instanceId !== prunedInstanceId) continue;
      if (!isActiveOrStartingRecord(record)) continue;
      actions.push({
        kind: "close-delete-pruned-follower-topic",
        target: record.target,
        reason: "pruned-follower",
        instanceId: prunedInstanceId,
        ...(input.currentLeaderEpoch !== undefined
          ? { leaderEpoch: input.currentLeaderEpoch }
          : {}),
      });
    }
  }

  for (const replacement of input.replacedBindings ?? []) {
    for (const record of input.records) {
      if (record.instanceId !== replacement.instanceId) continue;
      if (!isActiveOrStartingRecord(record)) continue;
      if (
        targetKey(record.target) === targetKey(replacement.replacementTarget)
      ) {
        continue;
      }
      actions.push({
        kind: "close-stale-replaced-topic",
        target: record.target,
        reason: "replaced-instance-binding",
        instanceId: replacement.instanceId,
        ...(input.currentLeaderEpoch !== undefined
          ? { leaderEpoch: input.currentLeaderEpoch }
          : {}),
      });
    }
  }

  if (input.previousLeaderCleanup) {
    for (const record of input.records) {
      if (!record.instanceId) continue;
      if (record.instanceId === input.previousLeaderCleanup.currentInstanceId) {
        continue;
      }
      if (!isActiveOrStartingRecord(record)) continue;
      if (!isPreviousLeaderRecord(record)) continue;
      actions.push({
        kind: "close-delete-previous-leader-topic",
        target: record.target,
        reason: "previous-leader",
        instanceId: input.previousLeaderCleanup.currentInstanceId,
        ...(input.currentLeaderEpoch !== undefined
          ? { leaderEpoch: input.currentLeaderEpoch }
          : {}),
      });
    }
  }

  if (input.proactiveReservationCleanup) {
    for (const reservation of input.reservations ?? []) {
      const key = targetKey(reservation.target);
      if (currentTargets.has(key)) continue;
      if (pendingTargets.has(key)) continue;
      actions.push({
        kind: "close-delete-reserved-topic",
        target: reservation.target,
        observedAtMs: input.nowMs,
        reason: "startup-reservation",
        ...(input.currentLeaderEpoch !== undefined
          ? { leaderEpoch: input.currentLeaderEpoch }
          : {}),
      });
    }
  }

  for (const probe of input.reservationProbeResults ?? []) {
    if (!probe.stale) continue;
    if (!allReservationTargets.has(targetKey(probe.target))) continue;
    actions.push({
      kind: "remove-reservation",
      target: probe.target,
      reason: "reservation-probe-stale",
    });
  }

  for (const message of input.reservedMessages ?? []) {
    const key = targetKey(message.target);
    if (!reservedTargets.has(key)) continue;
    if (currentTargets.has(key)) continue;
    if (pendingTargets.has(key)) continue;
    if (
      input.currentLeaderEpoch !== undefined &&
      message.leaderEpoch !== undefined &&
      message.leaderEpoch !== input.currentLeaderEpoch
    ) {
      continue;
    }
    actions.push({
      kind: "close-delete-reserved-topic",
      target: message.target,
      observedAtMs: message.observedAtMs,
      messageId: message.messageId,
      reason: "reserved-user-message",
      ...(input.currentLeaderEpoch !== undefined
        ? { leaderEpoch: input.currentLeaderEpoch }
        : {}),
    });
  }

  for (const message of input.unboundMessages ?? []) {
    const key = targetKey(message.target);
    if (currentTargets.has(key)) continue;
    if (reservedTargets.has(key)) continue;
    if (pendingTargets.has(key)) continue;
    if (recentOpenTargets.has(key)) continue;
    if (
      input.currentLeaderEpoch !== undefined &&
      message.leaderEpoch !== undefined &&
      message.leaderEpoch !== input.currentLeaderEpoch
    ) {
      continue;
    }
    actions.push({
      kind: "close-delete-unbound-topic",
      target: message.target,
      observedAtMs: message.observedAtMs,
      messageId: message.messageId,
      reason: "unbound-user-message",
      ...(input.currentLeaderEpoch !== undefined
        ? { leaderEpoch: input.currentLeaderEpoch }
        : {}),
    });
  }

  const state = createThreadReconciliationMachineState(input, actions);
  const transition = createThreadReconciliationTransition(
    input.previousState,
    state,
  );
  return {
    actions,
    state,
    ...(transition ? { transition } : {}),
  };
}
