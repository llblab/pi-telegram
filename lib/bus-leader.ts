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

export interface TelegramBusFollowerRegistryRestoreDeps {
  topicTargetStore: Pick<Threads.TelegramTopicTargetStore, "load" | "list">;
  followerRegistry: TelegramBusFollowerRegistry;
  recordRuntimeEvent: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  getNowMs?: () => number;
}

export interface TelegramBusLeaderRuntimeDeps<TContext> {
  socketPath: string;
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
  provisionFollowerTarget?: (
    registration: TelegramBusInstanceRegistration,
  ) => Promise<TelegramTarget | undefined> | TelegramTarget | undefined;
  restoreFollowerRegistry?: () => Promise<void> | void;
  provisionLeaderTarget?: (ctx: TContext) => Promise<void> | void;
  getNowMs?: () => number;
  followerPruneIntervalMs?: number;
  followerStaleAfterMs?: number;
  onFollowerPruned?: (
    follower: TelegramBusFollowerView,
  ) => Promise<void> | void;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export function createTelegramBusFollowerRegistryRestoreHandler(
  deps: TelegramBusFollowerRegistryRestoreDeps,
): () => Promise<void> {
  return async () => {
    await deps.topicTargetStore.load();
    const nowMs = (deps.getNowMs ?? Date.now)();
    let restored = 0;
    for (const record of deps.topicTargetStore.list()) {
      if (record.owner?.kind !== "manual-follower") continue;
      if (!record.instanceId) continue;
      if (
        record.status !== "active" &&
        record.status !== "starting" &&
        record.status !== "pending"
      ) {
        continue;
      }
      deps.followerRegistry.register({
        instanceId: record.instanceId,
        profileKey: record.profileKey,
        threadName: record.threadName,
        target: record.target,
        busSocketPath: getTelegramBusFollowerSocketPath(record.instanceId),
        connectedAtMs: nowMs,
      });
      restored += 1;
    }
    if (restored > 0) {
      deps.recordRuntimeEvent("bus", "Telegram follower registry restored", {
        phase: "follower-registry-restore",
        followers: restored,
      });
    }
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
    const followerOwner =
      Threads.getTelegramThreadOwnerFromProfileKey(followerProfileKey);
    deps.onProvisioningStart?.();
    let result: Threads.TelegramTopicTargetProvisionResult;
    try {
      result = await provision({
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
    deps.setSyncState(
      Sync.markTelegramSyncSliceFresh(deps.getSyncState(), "target-bindings", {
        nowMs: getNowMs(),
        action: "follower-register",
      }),
    );
    recordSlowTelegramBusFollowerRegistrationStep(deps, {
      phase: "follower-register-critical",
      elapsedMs: Date.now() - registrationStartedAtMs,
      instanceId: registration.instanceId,
      target: result.target,
      reused: result.reused,
    });
    const connectedAnnouncement =
      createTelegramBusInstanceLifecycleAnnouncement({
        target: result.target,
        threadName: result.record.threadName,
        slot: result.record.slot,
        state: "connected",
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
    return {
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: true,
      result: await deps.callApi(envelope.method, envelope.args),
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
  let pruneInterval: ReturnType<typeof setInterval> | undefined;
  const stopPruning = () => {
    if (!pruneInterval) return;
    clearInterval(pruneInterval);
    pruneInterval = undefined;
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
      provisionFollowerTarget: deps.provisionFollowerTarget,
    }),
  });
  return {
    startPolling: async (ctx) => {
      await localServer.start();
      try {
        await deps.restoreFollowerRegistry?.();
      } catch (error) {
        deps.recordRuntimeEvent?.("bus", error, {
          phase: "follower-registry-restore",
        });
      }
      startPruning();
      try {
        await deps.provisionLeaderTarget?.(ctx);
        await deps.startPolling(ctx);
      } catch (error) {
        stopPruning();
        await localServer.stop();
        throw error;
      }
    },
    stopPolling: async () => {
      stopPruning();
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
