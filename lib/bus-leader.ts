/**
 * Telegram bus leader orchestration
 * Zones: multi-instance bus, leader polling/server lifecycle, follower routing
 * Owns leader-only runtime orchestration: follower registration envelopes, follower API proxying,
 * leader activation hot-switching, local bus server startup, and stale follower pruning.
 */

import * as Sync from "./sync.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
import type { TelegramApiCallOptions } from "./telegram-api.ts";
import type { TelegramTarget } from "./target.ts";
import * as Threads from "./threads.ts";
import {
  createTelegramBusLocalServer,
  createUnauthorizedBusAck,
  isTelegramBusEnvelopeAuthorized,
  getTelegramBusFollowerSocketPath,
  sendTelegramBusLocalEnvelope,
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
    | ThreadReconciler.ThreadReconciliationMachineState
    | undefined;
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
    provisionFollowerTarget: createTelegramBusFollowerTargetProvisioner({
      ...provisionerPorts,
    }),
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
  reconcileFollowerBindings?: () => Promise<unknown> | unknown;
  provisionLeaderTarget?: (ctx: TContext) => Promise<void> | void;
  getNowMs?: () => number;
  followerPruneIntervalMs?: number;
  followerStaleAfterMs?: number;
  followerRecoveryGraceMs?: number;
  onFollowerPruned?: (
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
    const liveInstanceIds = new Set(
      deps.followerRegistry.list().map((follower) => follower.instanceId),
    );
    const staleRecords = deps.topicTargetStore.list().filter((record) => {
      return (
        record.owner?.kind === "manual-follower" &&
        !!record.instanceId &&
        !liveInstanceIds.has(record.instanceId)
      );
    });
    const staleInstanceIds = new Set(
      staleRecords.flatMap((record) =>
        record.instanceId ? [record.instanceId] : [],
      ),
    );
    let removed = 0;
    for (const instanceId of staleInstanceIds) {
      removed += deps.topicTargetStore.markOfflineByInstanceId(instanceId);
    }
    for (const record of staleRecords) {
      const profileKey =
        record.profileKey ??
        (record.owner
          ? Threads.getTelegramThreadOwnerKey(record.owner)
          : undefined);
      if (profileKey) deps.topicTargetStore.forgetIdentityByProfileKey(profileKey);
    }
    if (removed === 0) return 0;
    const cursorRealigned =
      Threads.reconcileTelegramFreshAllocationCursor(deps.topicTargetStore);
    await deps.topicTargetStore.persist();
    deps.recordRuntimeEvent(
      "bus",
      "Historical follower bindings removed from live state",
      {
        phase: "follower-binding-reality",
        removed,
      },
    );
    if (cursorRealigned) {
      deps.recordRuntimeEvent(
        "bus",
        "Fresh allocation cursor realigned after live-state compaction",
        {
          phase: "follower-binding-reality-cursor",
          lastSlot: deps.topicTargetStore.getBotState().lastSlot,
        },
      );
    }
    return removed;
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
    Promise<(TelegramTarget & { slot?: string; threadName?: string }) | undefined>
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
    const reconnectRecord = registration.target
      ? recordsBeforeProvision.find((record) => {
          return (
            record.owner?.kind === "manual-follower" &&
            record.instanceId === registration.instanceId &&
            record.target.chatId === registration.target?.chatId &&
            record.target.threadId === registration.target.threadId
          );
        })
      : undefined;
    const followerProfileKey =
      registration.profileKey ?? `manual:${registration.instanceId}`;
    const followerOwner =
      Threads.getTelegramThreadOwnerFromProfileKey(followerProfileKey);
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
    const runRegistration = async (): Promise<
      (TelegramTarget & { slot?: string; threadName?: string }) | undefined
    > => {
    let result = reconnectRecord
      ? { target: reconnectRecord.target, reused: true, record: reconnectRecord }
      : await provisionTarget();
    deps.setSyncState(
      Sync.markTelegramSyncSliceFresh(deps.getSyncState(), "target-bindings", {
        nowMs: getNowMs(),
        action: "follower-register",
      }),
    );
    const connectedAnnouncement = result.reused
      ? undefined
      : createTelegramBusInstanceLifecycleAnnouncement({
          target: result.target,
          threadName: result.record.threadName,
          slot: result.record.slot,
          state: "connected",
        });
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

export function createTelegramBusLeaderTargetProvisioner<TContext>(
  deps: TelegramBusLeaderTargetProvisionerDeps<TContext>,
): (ctx: TContext) => Promise<void> {
  const getNowMs = deps.getNowMs ?? Date.now;
  return async (ctx) => {
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
      const body = args[1] as Record<string, unknown>;
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
  ) => Promise<TelegramTarget | undefined> | TelegramTarget | undefined;
}): (
  envelope: TelegramBusEnvelope,
) => Promise<TelegramBusEnvelope> | TelegramBusEnvelope {
  const getNowMs = deps.getNowMs ?? Date.now;
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
    if (follower) deps.followerRegistry.heartbeat(follower.instanceId, getNowMs());
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
        if (follower) deps.followerRegistry.heartbeat(follower.instanceId, getNowMs());
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
        try {
          const target = await deps.provisionFollowerTarget?.(
            envelope.registration,
          );
          const registeredTarget = target ?? envelope.registration.target;
          deps.followerRegistry.register({
            ...envelope.registration,
            connectedAtMs: getNowMs(),
            target: registeredTarget,
          });
          return {
            kind: "bus.ack",
            requestId: envelope.requestId,
            ok: true,
            ...(registeredTarget ? { result: registeredTarget } : {}),
          };
        } catch (error) {
          return {
            kind: "bus.ack",
            requestId: envelope.requestId,
            ok: false,
            message:
              error instanceof Error
                ? error.message
                : "Telegram bus follower target provisioning failed.",
          };
        }
      }
      case "follower.heartbeat": {
        const follower = deps.followerRegistry.heartbeat(
          envelope.instanceId,
          getNowMs(),
        );
        return follower
          ? { kind: "bus.ack", requestId: envelope.requestId, ok: true }
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

function getFollowerApiMethodAndBody(envelope: Extract<TelegramBusEnvelope, { kind: "follower.callApi" }>): {
  apiMethod: string;
  body?: Record<string, unknown>;
} {
  if (envelope.method === "call" || envelope.method === "callMultipart") {
    return {
      apiMethod:
        typeof envelope.args[0] === "string" ? envelope.args[0] : "",
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
  const threadId = asInteger(body?.message_thread_id) ?? input.follower.target?.threadId;
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
