/**
 * Telegram bus leader orchestration
 * Zones: multi-instance bus, leader polling/server lifecycle, follower routing
 * Owns leader-only runtime orchestration: follower registration envelopes, follower API proxying,
 * leader activation hot-switching, local bus server startup, and stale follower pruning.
 */

import * as Sync from "./sync.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
import {
  isTelegramApiCommitUnknownError,
  type TelegramApiCallOptions,
} from "./telegram-api.ts";
import type { TelegramTarget } from "./target.ts";
import * as Threads from "./threads.ts";
import {
  createTelegramBusLocalServer,
  createUnauthorizedBusAck,
  isTelegramBusEnvelopeAuthorized,
  getTelegramBusFollowerSocketPath,
  sendTelegramBusLocalEnvelope,
  stripTelegramBusApiMetadata,
  type TelegramBusEnvelope,
  type TelegramBusFollowerRegistry,
  type TelegramBusFollowerView,
  type TelegramBusInstanceRegistration,
  type TelegramBusSocketPathSource,
} from "./bus.ts";
import { getTelegramBusTransportRetryPolicy } from "./bus-transport.ts";

export interface TelegramBusLeaderRuntime<TContext> {
  startPolling: (ctx: TContext) => Promise<void>;
  stopPolling: () => Promise<void>;
}

export interface TelegramBusFollowerLifecycleAnnouncement {
  target: TelegramTarget & { threadId: number };
  text: string;
  parseMode: "HTML";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatTelegramBusInstanceLabel(input: {
  threadName?: string;
  slot?: string;
}): string {
  const threadName = input.threadName?.trim();
  if (threadName) return escapeHtml(threadName);
  return input.slot && /^[A-Z]$/.test(input.slot) ? input.slot : "?";
}

export interface TelegramBusLeaderTargetProvisionerDeps<TContext> {
  getAllowedUserId: () => number | undefined;
  instanceId: string;
  getCwd?: (ctx: TContext) => string | undefined;
  getTelegramProfile?: () => string | undefined;
  shouldForceFreshUnnamed?: () => boolean;
  topicTargetStore: Threads.TelegramTopicTargetStore;
  callApi: <TResponse>(
    method: string,
    body: Record<string, unknown>,
  ) => Promise<TResponse>;
  getCurrentLeaderEpoch?: () => number | string | undefined;
  getThreadReconciliationMachineState?: () =>
    ThreadReconciler.ThreadReconciliationMachineState | undefined;
  recordThreadReconciliationPlan?: (
    plan: ThreadReconciler.ThreadReconciliationPlan,
  ) => void;
  getSyncState: () => Sync.TelegramSyncState;
  setSyncState: (state: Sync.TelegramSyncState) => void;
  setLeaderTarget: (input: {
    target: TelegramTarget;
    slot?: string;
    threadName?: string;
  }) => void;
  onProvisioningStart?: () => void;
  onProvisioningEnd?: () => void;
  recordRuntimeEvent: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  getNowMs?: () => number;
}

export interface TelegramBusFollowerTargetProvisionerDeps {
  getAllowedUserId: () => number | undefined;
  topicTargetStore: Threads.TelegramTopicTargetStore;
  callApi: <TResponse>(
    method: string,
    body: Record<string, unknown>,
  ) => Promise<TResponse>;
  getCurrentLeaderEpoch?: () => number | string | undefined;
  getSyncState: () => Sync.TelegramSyncState;
  setSyncState: (state: Sync.TelegramSyncState) => void;
  onProvisioningStart?: () => void;
  onProvisioningEnd?: () => void;
  getNowMs?: () => number;
  recordRuntimeEvent: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramBusFollowerPruneHandlerDeps {
  topicTargetStore: Pick<
    Threads.TelegramTopicTargetStore,
    | "load"
    | "getActiveByInstanceId"
    | "list"
    | "listPendingProvisions"
    | "markStaleByTarget"
    | "markOfflineByInstanceId"
    | "persist"
    | "removePendingProvision"
  >;
  callApi: <TResponse>(
    method: string,
    body: Record<string, unknown>,
  ) => Promise<TResponse>;
  getCurrentLeaderEpoch?: () => number | string | undefined;
  getSyncState: () => Sync.TelegramSyncState;
  setSyncState: (state: Sync.TelegramSyncState) => void;
  getNowMs?: () => number;
  recordRuntimeEvent: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramBusLeaderApiProxyDeps {
  call: (
    method: string,
    body: Record<string, unknown>,
    options?: TelegramApiCallOptions,
  ) => Promise<unknown>;
  callMultipart: (
    method: string,
    fields: Record<string, string>,
    fieldName: string,
    filePath: string,
    fileName: string,
    options?: TelegramApiCallOptions,
  ) => Promise<unknown>;
  downloadFile: (fileId: string, destinationDir: string) => Promise<unknown>;
  recoverStaleTargetError?: (
    apiBody: unknown,
    error: unknown,
  ) => Promise<unknown> | unknown;
}

export interface TelegramBusLeaderRuntimeAssemblyDeps<TContext> {
  runtime: Omit<
    TelegramBusLeaderRuntimeDeps<TContext>,
    | "callApi"
    | "onFollowerPruned"
    | "onFollowerDisconnected"
    | "provisionFollowerTarget"
    | "provisionLeaderTarget"
    | "reconcileFollowerBindings"
    | "recordRuntimeEvent"
  >;
  getAllowedUserId: () => number | undefined;
  instanceId: string;
  getCwd?: (ctx: TContext) => string | undefined;
  getTelegramProfile?: () => string | undefined;
  shouldForceFreshUnnamed?: () => boolean;
  topicTargetStore: Threads.TelegramTopicTargetStore;
  callApi: TelegramBusLeaderTargetProvisionerDeps<TContext>["callApi"];
  callMultipart: TelegramBusLeaderApiProxyDeps["callMultipart"];
  downloadFile: TelegramBusLeaderApiProxyDeps["downloadFile"];
  recoverStaleTargetError?: TelegramBusLeaderApiProxyDeps["recoverStaleTargetError"];
  getCurrentLeaderEpoch?: () => number | string | undefined;
  getThreadReconciliationMachineState?: TelegramBusLeaderTargetProvisionerDeps<TContext>["getThreadReconciliationMachineState"];
  recordThreadReconciliationPlan?: TelegramBusLeaderTargetProvisionerDeps<TContext>["recordThreadReconciliationPlan"];
  getSyncState: () => Sync.TelegramSyncState;
  setSyncState: (state: Sync.TelegramSyncState) => void;
  setLeaderTarget: TelegramBusLeaderTargetProvisionerDeps<TContext>["setLeaderTarget"];
  onProvisioningStart?: () => void;
  onProvisioningEnd?: () => void;
  recordRuntimeEvent: NonNullable<
    TelegramBusLeaderRuntimeDeps<TContext>["recordRuntimeEvent"]
  >;
}

export function createTelegramBusLeaderRuntimeAssembly<TContext>(
  deps: TelegramBusLeaderRuntimeAssemblyDeps<TContext>,
): TelegramBusLeaderRuntime<TContext> {
  const provisionerPorts = {
    getAllowedUserId: deps.getAllowedUserId,
    topicTargetStore: deps.topicTargetStore,
    callApi: deps.callApi,
    getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
    getSyncState: deps.getSyncState,
    setSyncState: deps.setSyncState,
    onProvisioningStart: deps.onProvisioningStart,
    onProvisioningEnd: deps.onProvisioningEnd,
    recordRuntimeEvent: deps.recordRuntimeEvent,
  };
  return createTelegramBusLeaderRuntime({
    ...deps.runtime,
    provisionLeaderTarget: createTelegramBusLeaderTargetProvisioner({
      ...provisionerPorts,
      instanceId: deps.instanceId,
      getCwd: deps.getCwd,
      getTelegramProfile: deps.getTelegramProfile,
      shouldForceFreshUnnamed: deps.shouldForceFreshUnnamed,
      getThreadReconciliationMachineState:
        deps.getThreadReconciliationMachineState,
      recordThreadReconciliationPlan: deps.recordThreadReconciliationPlan,
      setLeaderTarget: deps.setLeaderTarget,
    }),
    onFollowerPruned: createTelegramBusFollowerPruneHandler({
      ...provisionerPorts,
    }),
    onFollowerDisconnected: createTelegramBusFollowerDisconnectHandler({
      ...provisionerPorts,
    }),
    provisionFollowerTarget: createTelegramBusFollowerTargetProvisioner({
      ...provisionerPorts,
    }),
    getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
    reconcileFollowerBindings:
      createTelegramBusFollowerBindingRealityReconciler({
        topicTargetStore: deps.topicTargetStore,
        followerRegistry: deps.runtime.followerRegistry,
        recordRuntimeEvent: deps.recordRuntimeEvent,
      }),
    callApi: createTelegramBusLeaderApiProxy({
      call: deps.callApi,
      callMultipart: deps.callMultipart,
      downloadFile: deps.downloadFile,
      recoverStaleTargetError: deps.recoverStaleTargetError,
    }),
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
}

export const TELEGRAM_BUS_RECENT_FOLLOWER_BINDING_GRACE_MS = 10_000;

export interface TelegramBusFollowerBindingRealityDeps {
  topicTargetStore: Pick<
    Threads.TelegramTopicTargetStore,
    | "load"
    | "list"
    | "markOfflineByInstanceId"
    | "forgetIdentityByProfileKey"
    | "getBotState"
    | "persist"
    | "setBotState"
  >;
  followerRegistry: Pick<TelegramBusFollowerRegistry, "list">;
  getNowMs?: () => number;
  recentBindingGraceMs?: number;
  recordRuntimeEvent: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramBusFollowerMessageOwnershipRecord {
  follower: TelegramBusFollowerView;
  chatId: number;
  messageId: number;
  target?: TelegramTarget;
}

export type TelegramBusFollowerMessageOwnershipRecorder = (
  record: TelegramBusFollowerMessageOwnershipRecord,
) => void;

export interface TelegramBusLeaderRuntimeDeps<TContext> {
  socketPath: TelegramBusSocketPathSource;
  commitEndpointPublication?: (commit: () => void) => boolean;
  followerRegistry: TelegramBusFollowerRegistry;
  authSecret?: string;
  startPolling: (ctx: TContext) => void | Promise<void>;
  stopPolling: () => void | Promise<void>;
  callApi?: (method: string, args: unknown[]) => Promise<unknown> | unknown;
  authorizeFollowerApiCall?: (input: {
    follower: TelegramBusFollowerView;
    method: string;
    args: unknown[];
  }) => boolean;
  recordFollowerMessageOwnership?: TelegramBusFollowerMessageOwnershipRecorder;
  provisionFollowerTarget?: (
    registration: TelegramBusInstanceRegistration,
  ) => Promise<TelegramTarget | undefined> | TelegramTarget | undefined;
  getCurrentLeaderEpoch?: () => number | string | undefined;
  reconcileFollowerBindings?: () => Promise<unknown> | unknown;
  provisionLeaderTarget?: (ctx: TContext) => Promise<void> | void;
  getNowMs?: () => number;
  followerPruneIntervalMs?: number;
  followerStaleAfterMs?: number;
  followerRecoveryGraceMs?: number;
  onFollowerPruned?: (
    follower: TelegramBusFollowerView,
  ) => Promise<void> | void;
  onFollowerDisconnected?: (
    follower: TelegramBusFollowerView,
  ) => Promise<void> | void;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export function createTelegramBusFollowerBindingRealityReconciler(
  deps: TelegramBusFollowerBindingRealityDeps,
): () => Promise<number> {
  return async () => {
    await deps.topicTargetStore.load();
    // A missing live registration proves only that the follower process is
    // currently absent. Keep its durable owner/target binding so a replacement
    // process with the same manual profile can reclaim the existing thread.
    return 0;
  };
}

export function createTelegramBusInstanceLifecycleAnnouncement(input: {
  target: TelegramTarget & { threadId: number };
  threadName?: string;
  slot?: string;
  state: "connected" | "disconnected";
}): TelegramBusFollowerLifecycleAnnouncement {
  return {
    target: { ...input.target },
    text: `📡 Instance <b>${formatTelegramBusInstanceLabel(input)}</b> ${input.state}.`,
    parseMode: "HTML",
  };
}

export function createTelegramBusFollowerDisconnectedAnnouncement(input: {
  follower: TelegramBusFollowerView;
  threadName?: string;
  slot?: string;
}): TelegramBusFollowerLifecycleAnnouncement | undefined {
  if (!input.follower.target?.threadId) return undefined;
  return createTelegramBusInstanceLifecycleAnnouncement({
    target: {
      chatId: input.follower.target.chatId,
      threadId: input.follower.target.threadId,
    },
    threadName: input.threadName,
    slot: input.slot,
    state: "disconnected",
  });
}

const TELEGRAM_BUS_SLOW_FOLLOWER_REGISTRATION_MS = 1000;

function scheduleTelegramBusLeaderBackgroundTask(
  task: () => Promise<void>,
): void {
  const timer = setTimeout(() => {
    void task();
  }, 0);
  timer.unref?.();
}

function recordSlowTelegramBusFollowerRegistrationStep(
  deps: Pick<TelegramBusFollowerTargetProvisionerDeps, "recordRuntimeEvent">,
  input: {
    phase: string;
    elapsedMs: number;
    instanceId: string;
    target?: TelegramTarget;
    reused?: boolean;
  },
): void {
  if (input.elapsedMs < TELEGRAM_BUS_SLOW_FOLLOWER_REGISTRATION_MS) return;
  deps.recordRuntimeEvent(
    "bus",
    `Telegram bus follower registration step was slow (${input.elapsedMs}ms).`,
    {
      phase: input.phase,
      elapsedMs: input.elapsedMs,
      instanceId: input.instanceId,
      reused: input.reused,
      chatId: input.target?.chatId,
      threadId: input.target?.threadId,
    },
  );
}

export function createTelegramBusFollowerTargetProvisioner(
  deps: TelegramBusFollowerTargetProvisionerDeps,
): (
  registration: TelegramBusInstanceRegistration,
) => Promise<
  (TelegramTarget & { slot?: string; threadName?: string }) | undefined
> {
  const getNowMs = deps.getNowMs ?? Date.now;
  const pendingRegistrations = new Map<
    string,
    Promise<
      (TelegramTarget & { slot?: string; threadName?: string }) | undefined
    >
  >();
  return async (registration) => {
    const registrationStartedAtMs = Date.now();
    const chatId = deps.getAllowedUserId();
    if (typeof chatId !== "number") return registration.target;
    await deps.topicTargetStore.load();
    const provision = Threads.createTelegramTopicTargetProvisioner({
      topicChatId: chatId,
      store: deps.topicTargetStore,
      getNowMs,
      getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
      callApi: deps.callApi,
      // Manual follower registration should create a visible fresh topic unless
      // the same profile key already has a known live/reusable binding. Do not
      // silently claim old offline/failed tabs: they may be closed/deleted in
      // Telegram and therefore invisible to the operator.
      claimPendingTargets: false,
    });
    const recordsBeforeProvision = deps.topicTargetStore.list();
    const followerProfileKey =
      registration.profileKey ?? `manual:${registration.instanceId}`;
    const requestedTarget = registration.target;
    const reconnectRecord = recordsBeforeProvision.find((record) => {
      return (
        record.owner?.kind === "manual-follower" &&
        (record.instanceId === registration.instanceId ||
          record.profileKey === followerProfileKey) &&
        (!requestedTarget ||
          (record.target.chatId === requestedTarget.chatId &&
            record.target.threadId === requestedTarget.threadId))
      );
    });
    const followerOwner =
      Threads.getTelegramThreadOwnerFromProfileKey(followerProfileKey);
    const recoverableTarget =
      !reconnectRecord &&
      requestedTarget?.chatId === chatId &&
      requestedTarget.threadId !== undefined &&
      !recordsBeforeProvision.some(
        (record) =>
          record.target.chatId === requestedTarget.chatId &&
          record.target.threadId === requestedTarget.threadId,
      )
        ? requestedTarget
        : undefined;
    const recoveryHint = recoverableTarget
      ? deps.topicTargetStore.getFollowerRecoveryHintByTarget?.(
          recoverableTarget,
        )
      : undefined;
    const registrationKey = followerProfileKey || registration.instanceId;
    const pendingRegistration = pendingRegistrations.get(registrationKey);
    if (pendingRegistration) return pendingRegistration;
    const provisionTarget = async () => {
      deps.onProvisioningStart?.();
      try {
        return await provision({
          instanceId: registration.instanceId,
          owner:
            followerOwner.kind === "manual-follower"
              ? followerOwner
              : {
                  kind: "manual-follower",
                  instanceId: registration.instanceId,
                },
          profileKey: followerProfileKey,
          threadName: registration.threadName,
        });
      } finally {
        deps.onProvisioningEnd?.();
      }
    };
    const recoverRequestedTarget = async () => {
      const nowMs = getNowMs();
      const carriedThreadName = registration.threadName;
      const requestedThreadName =
        carriedThreadName &&
        Threads.isTelegramTopicThreadNameValidForSlot(
          carriedThreadName,
          registration.slot,
        )
          ? carriedThreadName
          : recoveryHint?.threadName &&
              Threads.isTelegramTopicThreadNameValidForSlot(
                recoveryHint.threadName,
                recoveryHint.slot,
              )
            ? recoveryHint.threadName
            : undefined;
      let recoveredRecord: Threads.TelegramTopicTargetRecord = {
        profileKey: followerProfileKey,
        owner:
          followerOwner.kind === "manual-follower"
            ? followerOwner
            : {
                kind: "manual-follower",
                instanceId: registration.instanceId,
              },
        target: {
          chatId: recoverableTarget!.chatId,
          threadId: recoverableTarget!.threadId!,
        },
        status: "active",
        createdAtMs: registration.connectedAtMs || nowMs,
        updatedAtMs: nowMs,
        instanceId: registration.instanceId,
        ...(requestedThreadName ? { threadName: requestedThreadName } : {}),
        lastSyncObservedAtMs: nowMs,
        lastReconcileAction: "follower-live-target-recovery",
      };
      const requestedSlot = registration.slot ?? recoveryHint?.slot;
      const requestedSlotAvailable =
        !!requestedSlot &&
        /^[A-Z]$/.test(requestedSlot) &&
        !recordsBeforeProvision.some((record) => record.slot === requestedSlot);
      if (requestedSlotAvailable) {
        recoveredRecord = { ...recoveredRecord, slot: requestedSlot };
      }
      return {
        target: recoveredRecord.target,
        reused: true,
        record: recoveredRecord,
      };
    };
    const runRegistration = async (): Promise<
      (TelegramTarget & { slot?: string; threadName?: string }) | undefined
    > => {
      let result = reconnectRecord
        ? {
            target: reconnectRecord.target,
            reused: true,
            record: reconnectRecord,
          }
        : recoverableTarget
          ? await recoverRequestedTarget()
          : await provisionTarget();
      const crossSessionReuse =
        !!reconnectRecord &&
        reconnectRecord.instanceId !== registration.instanceId;
      if (reconnectRecord && !crossSessionReuse) {
        const nowMs = getNowMs();
        const refreshedRecord = deps.topicTargetStore.upsert({
          ...reconnectRecord,
          instanceId: registration.instanceId,
          updatedAtMs: nowMs,
          lastSyncObservedAtMs: nowMs,
          lastReconcileAction: "follower-register-reuse",
        });
        await deps.topicTargetStore.persist();
        result = {
          target: refreshedRecord.target,
          reused: true,
          record: refreshedRecord,
        };
      }
      const probeRequiredRecord =
        reconnectRecord?.status === "probe-required";
      const requiresVisibilityProbe =
        crossSessionReuse ||
        probeRequiredRecord ||
        recoverableTarget !== undefined;
      let connectedAnnouncement =
        !result.reused || requiresVisibilityProbe
          ? createTelegramBusInstanceLifecycleAnnouncement({
              target: result.target,
              threadName: result.record.threadName,
              slot: result.record.slot,
              state: "connected",
            })
          : undefined;
      if (requiresVisibilityProbe && connectedAnnouncement) {
        try {
          await deps.callApi("sendMessage", {
            chat_id: connectedAnnouncement.target.chatId,
            message_thread_id: connectedAnnouncement.target.threadId,
            text: connectedAnnouncement.text,
            parse_mode: connectedAnnouncement.parseMode,
          });
          if (recoverableTarget || probeRequiredRecord) {
            const activatedRecord = deps.topicTargetStore.upsert({
              ...result.record,
              status: "active",
              updatedAtMs: getNowMs(),
              lastSyncObservedAtMs: getNowMs(),
              lastReconcileAction: "follower-live-target-recovery",
            });
            await deps.topicTargetStore.persist();
            result = {
              target: activatedRecord.target,
              reused: true,
              record: activatedRecord,
            };
          } else if (crossSessionReuse && reconnectRecord) {
            const nowMs = getNowMs();
            const transferredRecord = deps.topicTargetStore.upsert({
              ...reconnectRecord,
              instanceId: registration.instanceId,
              updatedAtMs: nowMs,
              lastSyncObservedAtMs: nowMs,
              lastReconcileAction: "follower-session-handoff",
            });
            await deps.topicTargetStore.persist();
            result = {
              target: transferredRecord.target,
              reused: true,
              record: transferredRecord,
            };
          }
          connectedAnnouncement = undefined;
        } catch (error) {
          if (Threads.isTelegramTopicTargetStaleError(error)) {
            deps.topicTargetStore.markStaleByTarget(
              result.target,
              "deleted",
              error instanceof Error ? error.message : String(error),
            );
            await deps.topicTargetStore.persist();
            result = await provisionTarget();
            connectedAnnouncement =
              createTelegramBusInstanceLifecycleAnnouncement({
                target: result.target,
                threadName: result.record.threadName,
                slot: result.record.slot,
                state: "connected",
              });
          } else {
            deps.recordRuntimeEvent("telegram", error, {
              phase: "follower-topic-reuse-probe",
              instanceId: registration.instanceId,
              chatId: result.target.chatId,
              threadId: result.target.threadId,
            });
            if (recoverableTarget) {
              deps.topicTargetStore.upsert({
                ...result.record,
                status: "probe-required",
                updatedAtMs: getNowMs(),
                lastSyncError:
                  error instanceof Error ? error.message : String(error),
                lastReconcileAction: "follower-visibility-probe-required",
              });
              await deps.topicTargetStore.persist();
            }
            throw error;
          }
        }
      }
      deps.setSyncState(
        Sync.markTelegramSyncSliceFresh(
          deps.getSyncState(),
          "target-bindings",
          {
            nowMs: getNowMs(),
            action: "follower-register",
          },
        ),
      );
      recordSlowTelegramBusFollowerRegistrationStep(deps, {
        phase: "follower-register-critical",
        elapsedMs: Date.now() - registrationStartedAtMs,
        instanceId: registration.instanceId,
        target: result.target,
        reused: result.reused,
      });
      scheduleTelegramBusLeaderBackgroundTask(async () => {
        const backgroundStartedAtMs = Date.now();
        if (connectedAnnouncement) {
          try {
            await deps.callApi("sendMessage", {
              chat_id: connectedAnnouncement.target.chatId,
              message_thread_id: connectedAnnouncement.target.threadId,
              text: connectedAnnouncement.text,
              parse_mode: connectedAnnouncement.parseMode,
            });
          } catch (error) {
            deps.recordRuntimeEvent("telegram", error, {
              phase: "follower-topic-announce",
              instanceId: registration.instanceId,
              chatId: result.target.chatId,
              threadId: result.target.threadId,
            });
          }
        }
        try {
          await ThreadReconciler.applyThreadReconciliationPlan(
            ThreadReconciler.planThreadReconciliation({
              nowMs: getNowMs(),
              currentLeaderEpoch: deps.getCurrentLeaderEpoch?.(),
              records: recordsBeforeProvision,
              pendingProvisions: deps.topicTargetStore.listPendingProvisions(),
              replacedBindings: [
                {
                  instanceId: registration.instanceId,
                  replacementTarget: result.target,
                },
              ],
            }),
            {
              callApi: deps.callApi,
              markStaleByTarget(target, syncStatus, lastSyncError) {
                return deps.topicTargetStore.markStaleByTarget(
                  target,
                  syncStatus,
                  lastSyncError,
                );
              },
              persist() {
                return deps.topicTargetStore.persist();
              },
              removePendingProvisionById(id) {
                return deps.topicTargetStore.removePendingProvision(id);
              },
              getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
              recordRuntimeEvent: deps.recordRuntimeEvent,
            },
          );
          await deps.topicTargetStore.persist();
        } catch (error) {
          deps.recordRuntimeEvent("telegram", error, {
            phase: "follower-register-background-reconcile",
            instanceId: registration.instanceId,
            chatId: result.target.chatId,
            threadId: result.target.threadId,
          });
        }
        recordSlowTelegramBusFollowerRegistrationStep(deps, {
          phase: "follower-register-background",
          elapsedMs: Date.now() - backgroundStartedAtMs,
          instanceId: registration.instanceId,
          target: result.target,
          reused: result.reused,
        });
      });
      return {
        ...result.target,
        slot: result.record.slot,
        threadName: result.record.threadName,
      };
    };
    const registrationPromise = runRegistration().finally(() => {
      pendingRegistrations.delete(registrationKey);
    });
    pendingRegistrations.set(registrationKey, registrationPromise);
    return registrationPromise;
  };
}

export function createTelegramBusFollowerPruneHandler(
  deps: TelegramBusFollowerPruneHandlerDeps,
): (follower: TelegramBusFollowerView) => Promise<void> {
  return async (follower) => {
    deps.recordRuntimeEvent(
      "bus",
      "Telegram bus follower heartbeat stale; preserving thread binding",
      {
        phase: "follower-pruned",
        instanceId: follower.instanceId,
      },
    );
  };
}

export function createTelegramBusFollowerDisconnectHandler(
  deps: TelegramBusFollowerPruneHandlerDeps,
): (follower: TelegramBusFollowerView) => Promise<void> {
  return async (follower) => {
    const target = follower.target;
    if (!target?.threadId) return;
    const leaderEpoch = deps.getCurrentLeaderEpoch?.();
    if (deps.getCurrentLeaderEpoch && leaderEpoch === undefined) {
      throw new Error("Follower disconnect cleanup requires leader ownership.");
    }
    const cleanup = await ThreadReconciler.applyThreadReconciliationPlan(
      ThreadReconciler.planDisconnectedInstanceThreadCleanup({
        target: { chatId: target.chatId, threadId: target.threadId },
        instanceId: follower.instanceId,
        leaderEpoch,
      }),
      {
        callApi: deps.callApi,
        persist: deps.topicTargetStore.persist,
        getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
        recordRuntimeEvent: deps.recordRuntimeEvent,
      },
    );
    if (cleanup.incompleteActions?.length) {
      throw new Error(
        "Telegram follower thread deletion was not confirmed; reconnect the leader and retry /telegram-disconnect.",
      );
    }
    if (
      deps.getCurrentLeaderEpoch &&
      deps.getCurrentLeaderEpoch() !== leaderEpoch
    ) {
      throw new Error("Follower disconnect cleanup lost leader ownership.");
    }
    const changed =
      deps.topicTargetStore.markOfflineByInstanceId(follower.instanceId) > 0;
    if (changed) await deps.topicTargetStore.persist();
    deps.setSyncState(
      Sync.markTelegramSyncSliceFresh(deps.getSyncState(), "target-bindings", {
        nowMs: (deps.getNowMs ?? Date.now)(),
        action: "manual-follower-disconnect",
      }),
    );
    deps.recordRuntimeEvent("bus", "Telegram bus follower disconnected", {
      phase: "follower-disconnect",
      instanceId: follower.instanceId,
      chatId: target.chatId,
      threadId: target.threadId,
    });
  };
}

export function createTelegramBusLeaderTargetProvisioner<TContext>(
  deps: TelegramBusLeaderTargetProvisionerDeps<TContext>,
): (ctx: TContext) => Promise<void> {
  const getNowMs = deps.getNowMs ?? Date.now;
  return async (ctx) => {
    const leaderEpoch = deps.getCurrentLeaderEpoch?.();
    if (deps.getCurrentLeaderEpoch && leaderEpoch === undefined) {
      throw new Error(
        "Telegram leader target provisioning requires ownership.",
      );
    }
    deps.onProvisioningStart?.();
    let ownTarget: Threads.TelegramOwnTopicProvisionResult | undefined;
    try {
      ownTarget = await Sync.ensureTelegramLeaderThreadBinding({
        getAllowedUserId: deps.getAllowedUserId,
        instanceId: deps.instanceId,
        cwd: deps.getCwd?.(ctx),
        telegramProfile: deps.getTelegramProfile?.(),
        forceFreshUnnamed: deps.shouldForceFreshUnnamed?.(),
        getNowMs,
        getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
        getThreadReconciliationMachineState:
          deps.getThreadReconciliationMachineState,
        recordThreadReconciliationPlan: deps.recordThreadReconciliationPlan,
        topicTargetStore: deps.topicTargetStore,
        callApi: deps.callApi,
        recordEvent: deps.recordRuntimeEvent,
      });
    } finally {
      deps.onProvisioningEnd?.();
    }
    if (
      deps.getCurrentLeaderEpoch &&
      deps.getCurrentLeaderEpoch() !== leaderEpoch
    ) {
      throw new Error("Telegram leader target provisioning lost ownership.");
    }
    if (!ownTarget) return;
    deps.setLeaderTarget({
      target: ownTarget.target,
      slot: ownTarget.slot,
      threadName: ownTarget.threadName,
    });
    const nowMs = getNowMs();
    let syncState = deps.getSyncState();
    syncState = Sync.markTelegramSyncSliceFresh(syncState, "target-bindings", {
      nowMs,
      action: "leader-startup",
    });
    syncState = Sync.markTelegramSyncSliceFresh(syncState, "reservations", {
      nowMs,
      action: "leader-startup",
    });
    syncState = Sync.markTelegramSyncSliceFresh(syncState, "topic-capability", {
      nowMs,
      action: "leader-startup",
    });
    deps.setSyncState(syncState);
    if (ownTarget.reused) return;
    const connectedAnnouncement =
      createTelegramBusInstanceLifecycleAnnouncement({
        target: ownTarget.target,
        threadName: ownTarget.threadName,
        slot: ownTarget.slot,
        state: "connected",
      });
    try {
      await deps.callApi("sendMessage", {
        chat_id: connectedAnnouncement.target.chatId,
        message_thread_id: connectedAnnouncement.target.threadId,
        text: connectedAnnouncement.text,
        parse_mode: connectedAnnouncement.parseMode,
      });
    } catch (error) {
      deps.recordRuntimeEvent("telegram", error, {
        phase: "leader-topic-announce",
        instanceId: deps.instanceId,
        chatId: ownTarget.target.chatId,
        threadId: ownTarget.target.threadId,
        slot: ownTarget.slot,
      });
    }
  };
}

export function createTelegramBusLeaderApiProxy(
  deps: TelegramBusLeaderApiProxyDeps,
): (method: string, args: unknown[]) => Promise<unknown> {
  return async (method, args) => {
    if (method === "call") {
      const body = stripTelegramBusApiMetadata(
        args[1] as Record<string, unknown>,
      );
      try {
        return await deps.call(
          args[0] as string,
          body,
          args[2] as TelegramApiCallOptions | undefined,
        );
      } catch (error) {
        await deps.recoverStaleTargetError?.(body, error);
        throw error;
      }
    }
    if (method === "callMultipart") {
      const fields = args[1] as Record<string, string>;
      try {
        return await deps.callMultipart(
          args[0] as string,
          fields,
          args[2] as string,
          args[3] as string,
          args[4] as string,
          args[5] as TelegramApiCallOptions | undefined,
        );
      } catch (error) {
        await deps.recoverStaleTargetError?.(fields, error);
        throw error;
      }
    }
    if (method === "downloadFile") {
      return deps.downloadFile(args[0] as string, args[1] as string);
    }
    throw new Error(`Unsupported Telegram bus API method: ${method}`);
  };
}

export function createTelegramBusLeaderEnvelopeHandler(deps: {
  followerRegistry: TelegramBusFollowerRegistry;
  authSecret?: string;
  getNowMs?: () => number;
  timeoutMs?: number;
  callApi?: (method: string, args: unknown[]) => Promise<unknown> | unknown;
  authorizeFollowerApiCall?: (input: {
    follower: TelegramBusFollowerView;
    method: string;
    args: unknown[];
  }) => boolean;
  recordFollowerMessageOwnership?: TelegramBusFollowerMessageOwnershipRecorder;
  provisionFollowerTarget?: (
    registration: TelegramBusInstanceRegistration,
  ) =>
    | Promise<
        | (TelegramTarget & { slot?: string; threadName?: string })
        | undefined
      >
    | (TelegramTarget & { slot?: string; threadName?: string })
    | undefined;
  onFollowerDisconnected?: (
    follower: TelegramBusFollowerView,
  ) => Promise<void> | void;
  getCurrentLeaderEpoch?: () => number | string | undefined;
}): (
  envelope: TelegramBusEnvelope,
) => Promise<TelegramBusEnvelope> | TelegramBusEnvelope {
  const getNowMs = deps.getNowMs ?? Date.now;
  const followerMutationTails = new Map<string, Promise<void>>();
  const getFollowerMutationKey = (follower: {
    instanceId: string;
    profileKey?: string;
  }): string =>
    follower.profileKey
      ? `profile:${follower.profileKey}`
      : `instance:${follower.instanceId}`;
  const runFollowerMutation = async <T>(
    mutationKey: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const previous = followerMutationTails.get(mutationKey);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    followerMutationTails.set(mutationKey, current);
    if (previous) await previous;
    try {
      return await operation();
    } finally {
      release();
      if (followerMutationTails.get(mutationKey) === current) {
        followerMutationTails.delete(mutationKey);
      }
    }
  };
  const forwardToFollower = async (
    envelope: Extract<
      TelegramBusEnvelope,
      {
        kind:
          | "leader.forwardCallback"
          | "leader.forwardReaction"
          | "leader.forwardMessage"
          | "leader.forwardEditedMessage";
      }
    >,
  ): Promise<TelegramBusEnvelope> => {
    const follower = deps.followerRegistry.get(envelope.recipientInstanceId);
    const followerSocketPath =
      follower?.busSocketPath ??
      getTelegramBusFollowerSocketPath(envelope.recipientInstanceId);
    if (follower)
      deps.followerRegistry.heartbeat(follower.instanceId, getNowMs());
    try {
      const response = await sendTelegramBusLocalEnvelope({
        socketPath: followerSocketPath,
        envelope,
        timeoutMs: deps.timeoutMs,
        retry: getTelegramBusTransportRetryPolicy({
          endpoint: followerSocketPath,
          operation: "operation",
        }),
      });
      if (response?.kind === "bus.ack" && response.ok) {
        if (follower)
          deps.followerRegistry.heartbeat(follower.instanceId, getNowMs());
        return { kind: "bus.ack", requestId: envelope.requestId, ok: true };
      }
      const message =
        response?.kind === "bus.ack" ? response.message : undefined;
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: false,
        message: message ?? "Telegram bus follower rejected forwarded update.",
      };
    } catch (error) {
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "Telegram bus follower forwarding failed.",
      };
    }
  };
  return async (envelope) => {
    if (
      envelope.kind !== "bus.ack" &&
      !isTelegramBusEnvelopeAuthorized(envelope, deps.authSecret)
    ) {
      return createUnauthorizedBusAck(envelope.requestId);
    }
    switch (envelope.kind) {
      case "follower.register": {
        return runFollowerMutation(
          getFollowerMutationKey(envelope.registration),
          async () => {
          try {
            if (!envelope.registration.registrationGeneration) {
              throw new Error(
                "Telegram follower registration requires an exact generation.",
              );
            }
            const leaderEpoch = deps.getCurrentLeaderEpoch?.();
            if (deps.getCurrentLeaderEpoch && leaderEpoch === undefined) {
              throw new Error(
                "Telegram follower registration requires leader ownership.",
              );
            }
            const target = await deps.provisionFollowerTarget?.(
              envelope.registration,
            );
            if (
              deps.getCurrentLeaderEpoch &&
              deps.getCurrentLeaderEpoch() !== leaderEpoch
            ) {
              throw new Error(
                "Telegram follower registration lost leader ownership.",
              );
            }
            const registeredTarget = target ?? envelope.registration.target;
            deps.followerRegistry.register({
              ...envelope.registration,
              connectedAtMs: getNowMs(),
              target: registeredTarget,
              ...((target?.slot ?? envelope.registration.slot)
                ? { slot: target?.slot ?? envelope.registration.slot }
                : {}),
              ...((target?.threadName ?? envelope.registration.threadName)
                ? {
                    threadName:
                      target?.threadName ?? envelope.registration.threadName,
                  }
                : {}),
            });
            return {
              kind: "bus.ack" as const,
              requestId: envelope.requestId,
              ok: true,
              ...(registeredTarget ? { result: registeredTarget } : {}),
            };
          } catch (error) {
            return {
              kind: "bus.ack" as const,
              requestId: envelope.requestId,
              ok: false,
              message:
                error instanceof Error
                  ? error.message
                  : "Telegram bus follower target provisioning failed.",
            };
          }
          },
        );
      }
      case "follower.disconnect": {
        const registeredFollower = deps.followerRegistry.get(envelope.instanceId);
        return runFollowerMutation(
          getFollowerMutationKey(
            registeredFollower ?? { instanceId: envelope.instanceId },
          ),
          async () => {
          const follower = deps.followerRegistry.get(envelope.instanceId);
          if (!follower) {
            return {
              kind: "bus.ack" as const,
              requestId: envelope.requestId,
              ok: false,
              message: "Unknown Telegram bus follower instance.",
            };
          }
          if (
            !follower.registrationGeneration ||
            !envelope.registrationGeneration ||
            envelope.registrationGeneration !== follower.registrationGeneration
          ) {
            return {
              kind: "bus.ack" as const,
              requestId: envelope.requestId,
              ok: false,
              message: "Stale Telegram bus follower registration generation.",
            };
          }
          await deps.onFollowerDisconnected?.(follower);
          const current = deps.followerRegistry.get(follower.instanceId);
          if (
            current?.registrationGeneration !== follower.registrationGeneration
          ) {
            return {
              kind: "bus.ack" as const,
              requestId: envelope.requestId,
              ok: false,
              message: "Stale Telegram bus follower registration generation.",
            };
          }
          deps.followerRegistry.remove(follower.instanceId);
          return {
            kind: "bus.ack" as const,
            requestId: envelope.requestId,
            ok: true,
          };
          },
        );
      }
      case "follower.heartbeat": {
        const current = deps.followerRegistry.get(envelope.instanceId);
        if (
          current?.registrationGeneration &&
          envelope.registrationGeneration !== current.registrationGeneration
        ) {
          return {
            kind: "bus.ack",
            requestId: envelope.requestId,
            ok: false,
            message: "Stale Telegram bus follower registration generation.",
          };
        }
        const follower = deps.followerRegistry.heartbeat(
          envelope.instanceId,
          getNowMs(),
        );
        return follower
          ? {
              kind: "bus.ack",
              requestId: envelope.requestId,
              ok: true,
              result: {
                eligibleElectionSlots: deps.followerRegistry
                  .list()
                  .map((candidate) => candidate.slot)
                  .filter((slot): slot is string =>
                    typeof slot === "string" && /^[A-Z]$/.test(slot),
                  )
                  .sort(),
              },
            }
          : {
              kind: "bus.ack",
              requestId: envelope.requestId,
              ok: false,
              message: "Unknown Telegram bus follower instance.",
            };
      }
      case "leader.forwardCallback":
      case "leader.forwardReaction":
      case "leader.forwardMessage":
      case "leader.forwardEditedMessage":
        return forwardToFollower(envelope);
      case "follower.callApi":
        return handleFollowerApiCall(envelope, { ...deps, getNowMs });
      default:
        return {
          kind: "bus.ack",
          requestId: envelope.requestId,
          ok: false,
          message: "Telegram bus envelope is not handled by this leader.",
        };
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function getFollowerApiMethodAndBody(
  envelope: Extract<TelegramBusEnvelope, { kind: "follower.callApi" }>,
): {
  apiMethod: string;
  body?: Record<string, unknown>;
} {
  if (envelope.method === "call" || envelope.method === "callMultipart") {
    return {
      apiMethod: typeof envelope.args[0] === "string" ? envelope.args[0] : "",
      body: asRecord(envelope.args[1]),
    };
  }
  return { apiMethod: envelope.method, body: asRecord(envelope.args[0]) };
}

function getSentMessageIds(result: unknown): number[] {
  const values = Array.isArray(result) ? result : [result];
  return values
    .map((value) => asInteger(asRecord(value)?.message_id))
    .filter((messageId): messageId is number => messageId !== undefined);
}

function recordFollowerApiMessageOwnership(input: {
  envelope: Extract<TelegramBusEnvelope, { kind: "follower.callApi" }>;
  follower: TelegramBusFollowerView;
  result: unknown;
  record?: TelegramBusFollowerMessageOwnershipRecorder;
}): void {
  if (!input.record) return;
  const { apiMethod, body } = getFollowerApiMethodAndBody(input.envelope);
  if (
    apiMethod !== "sendMessage" &&
    apiMethod !== "sendRichMessage" &&
    apiMethod !== "sendPhoto" &&
    apiMethod !== "sendDocument" &&
    apiMethod !== "sendVoice" &&
    apiMethod !== "sendMediaGroup"
  ) {
    return;
  }
  const chatId = asInteger(body?.chat_id) ?? input.follower.target?.chatId;
  if (chatId === undefined) return;
  const threadId =
    asInteger(body?.message_thread_id) ?? input.follower.target?.threadId;
  const target = threadId !== undefined ? { chatId, threadId } : { chatId };
  for (const messageId of getSentMessageIds(input.result)) {
    input.record({
      follower: input.follower,
      chatId,
      messageId,
      target,
    });
  }
}

async function handleFollowerApiCall(
  envelope: Extract<TelegramBusEnvelope, { kind: "follower.callApi" }>,
  deps: {
    followerRegistry: TelegramBusFollowerRegistry;
    getNowMs: () => number;
    callApi?: (method: string, args: unknown[]) => Promise<unknown> | unknown;
    authorizeFollowerApiCall?: (input: {
      follower: TelegramBusFollowerView;
      method: string;
      args: unknown[];
    }) => boolean;
    recordFollowerMessageOwnership?: TelegramBusFollowerMessageOwnershipRecorder;
  },
): Promise<TelegramBusEnvelope> {
  const follower = deps.followerRegistry.get(envelope.instanceId);
  if (!follower) {
    return {
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: false,
      message: "Unknown Telegram bus follower instance.",
    };
  }
  if (
    follower.registrationGeneration &&
    envelope.registrationGeneration !== follower.registrationGeneration
  ) {
    return {
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: false,
      message: "Stale Telegram bus follower registration generation.",
    };
  }
  deps.followerRegistry.heartbeat(envelope.instanceId, deps.getNowMs());
  if (
    deps.authorizeFollowerApiCall &&
    !deps.authorizeFollowerApiCall({
      follower,
      method: envelope.method,
      args: envelope.args,
    })
  ) {
    return {
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: false,
      message: "Telegram bus API call is not allowed for this follower.",
    };
  }
  if (!deps.callApi) {
    return {
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: false,
      message: "Telegram bus leader does not expose API calling.",
    };
  }
  try {
    const result = await deps.callApi(envelope.method, envelope.args);
    recordFollowerApiMessageOwnership({
      envelope,
      follower,
      result,
      record: deps.recordFollowerMessageOwnership,
    });
    return {
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: true,
      result,
    };
  } catch (error) {
    return {
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Telegram bus API call failed.",
      ...(isTelegramApiCommitUnknownError(error)
        ? {
            error: {
              code: "commit-unknown" as const,
              method: error.method,
            },
          }
        : {}),
    };
  }
}

export interface TelegramBusLeaderActivationSchedulerDeps<TContext> {
  isBusEnabled: () => boolean;
  ownsPolling: (ctx: TContext) => boolean;
  isBusPollingStarted: () => boolean;
  setBusPollingStarted: (started: boolean) => void;
  stopClassicPolling: () => Promise<void>;
  startClassicPolling: (ctx: TContext) => void | Promise<void>;
  startBusLeaderPolling: (ctx: TContext) => Promise<void>;
  updateStatus: (ctx: TContext) => void;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export function createTelegramBusLeaderActivationScheduler<TContext>(
  deps: TelegramBusLeaderActivationSchedulerDeps<TContext>,
): (ctx: TContext) => void {
  let pending = false;
  return (ctx) => {
    if (deps.isBusPollingStarted() || pending) return;
    if (!deps.isBusEnabled()) return;
    if (!deps.ownsPolling(ctx)) return;
    pending = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          if (deps.isBusPollingStarted()) return;
          if (!deps.isBusEnabled()) return;
          if (!deps.ownsPolling(ctx)) return;
          await deps.stopClassicPolling();
          try {
            await deps.startBusLeaderPolling(ctx);
            deps.setBusPollingStarted(true);
            deps.updateStatus(ctx);
            deps.recordRuntimeEvent?.(
              "bus",
              "Telegram bus leader mode activated",
              { phase: "leader-hot-switch" },
            );
          } catch (error) {
            deps.recordRuntimeEvent?.("bus", error, {
              phase: "leader-hot-switch",
            });
            deps.setBusPollingStarted(false);
            await deps.startClassicPolling(ctx);
          }
        } finally {
          pending = false;
        }
      })();
    }, 0);
    timer.unref?.();
  };
}

export function createTelegramBusLeaderRuntime<TContext>(
  deps: TelegramBusLeaderRuntimeDeps<TContext>,
): TelegramBusLeaderRuntime<TContext> {
  const getNowMs = deps.getNowMs ?? Date.now;
  const followerPruneIntervalMs = deps.followerPruneIntervalMs ?? 1000;
  const followerStaleAfterMs = deps.followerStaleAfterMs ?? 5000;
  const followerRecoveryGraceMs = deps.followerRecoveryGraceMs ?? 5000;
  let pruneInterval: ReturnType<typeof setInterval> | undefined;
  let followerRealityTimer: ReturnType<typeof setTimeout> | undefined;
  const stopPruning = () => {
    if (!pruneInterval) return;
    clearInterval(pruneInterval);
    pruneInterval = undefined;
  };
  const stopFollowerRealityTimer = () => {
    if (!followerRealityTimer) return;
    clearTimeout(followerRealityTimer);
    followerRealityTimer = undefined;
  };
  const scheduleFollowerBindingReality = () => {
    stopFollowerRealityTimer();
    if (!deps.reconcileFollowerBindings) return;
    followerRealityTimer = setTimeout(() => {
      followerRealityTimer = undefined;
      void Promise.resolve(deps.reconcileFollowerBindings?.()).catch((error) =>
        deps.recordRuntimeEvent?.("bus", error, {
          phase: "follower-binding-reality",
        }),
      );
    }, followerRecoveryGraceMs);
    followerRealityTimer.unref?.();
  };
  const pruneFollowers = async () => {
    try {
      await localServer.ensureEndpoint();
    } catch (error) {
      deps.recordRuntimeEvent?.("bus", error, {
        phase: "leader-endpoint-recovery",
      });
    }
    const removed = deps.followerRegistry.pruneStale(
      getNowMs(),
      followerStaleAfterMs,
    );
    for (const follower of removed) {
      try {
        await deps.onFollowerPruned?.(follower);
      } catch (error) {
        deps.recordRuntimeEvent?.("bus", error, {
          phase: "follower-prune-offline",
          instanceId: follower.instanceId,
        });
      }
      deps.recordRuntimeEvent?.("bus", "Telegram bus follower timed out", {
        phase: "follower-prune",
        instanceId: follower.instanceId,
      });
    }
  };
  const startPruning = () => {
    stopPruning();
    pruneInterval = setInterval(() => {
      void pruneFollowers();
    }, followerPruneIntervalMs);
    pruneInterval.unref?.();
  };
  const localServer = createTelegramBusLocalServer({
    socketPath: deps.socketPath,
    commitEndpointPublication: deps.commitEndpointPublication,
    recordTransportEvent(phase, details) {
      deps.recordRuntimeEvent?.("bus", `Telegram bus ${phase}`, {
        phase: `leader-${phase}`,
        ...details,
      });
    },
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: deps.followerRegistry,
      authSecret: deps.authSecret,
      getNowMs,
      callApi: deps.callApi,
      authorizeFollowerApiCall: deps.authorizeFollowerApiCall,
      recordFollowerMessageOwnership: deps.recordFollowerMessageOwnership,
      provisionFollowerTarget: deps.provisionFollowerTarget,
      onFollowerDisconnected: deps.onFollowerDisconnected,
      getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
    }),
  });
  return {
    startPolling: async (ctx) => {
      await localServer.start();
      scheduleFollowerBindingReality();
      startPruning();
      try {
        await deps.provisionLeaderTarget?.(ctx);
        await deps.startPolling(ctx);
      } catch (error) {
        stopPruning();
        stopFollowerRealityTimer();
        await localServer.stop();
        throw error;
      }
    },
    stopPolling: async () => {
      stopPruning();
      stopFollowerRealityTimer();
      try {
        await deps.stopPolling();
      } finally {
        await localServer
          .stop()
          .catch((error) =>
            deps.recordRuntimeEvent?.("bus", error, { phase: "stop" }),
          );
        deps.followerRegistry.clear();
      }
    },
  };
}
