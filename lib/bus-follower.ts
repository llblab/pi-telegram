/**
 * Telegram bus follower runtime
 * Zones: multi-instance bus, follower lifecycle, manual registration
 * Owns this Pi instance's follower-side bus behavior: manual registration,
 * heartbeat, forwarded-update receiving, and follower-routed API calls.
 * It must not spawn Pi processes or create hidden Telegram-originated instances.
 */

import { basename } from "node:path";

import * as Sync from "./sync.ts";
import * as Threads from "./threads.ts";
import type { TelegramLockState } from "./locks.ts";
import type { TelegramTarget } from "./target.ts";
import {
  createTelegramBusLocalServer,
  createUnauthorizedBusAck,
  getTelegramBusSocketPath,
  resolveTelegramBusSocketPath,
  sendTelegramBusLocalEnvelope,
  type TelegramBusEnvelope,
  type TelegramBusSocketPathSource,
} from "./bus.ts";
import {
  getTelegramBusTransportRetryPolicy,
  TELEGRAM_BUS_REGISTRATION_RETRY,
} from "./bus-transport.ts";

export const TELEGRAM_BUS_FOLLOWER_PROMOTION_GRACE_MS = 2_500;
export const TELEGRAM_FOLLOWER_SESSION_HANDOFF_TTL_MS = 30_000;
export const TELEGRAM_BUS_FOLLOWER_REGISTRATION_RETRY_ATTEMPTS =
  TELEGRAM_BUS_REGISTRATION_RETRY.attempts;
export const TELEGRAM_BUS_FOLLOWER_REGISTRATION_RETRY_DELAY_MS =
  TELEGRAM_BUS_REGISTRATION_RETRY.delayMs;

const TELEGRAM_FOLLOWER_SESSION_HANDOFF_KEY =
  "__piTelegramFollowerSessionHandoff";

export interface TelegramFollowerSessionHandoff {
  pid: number;
  instanceId: string;
  createdAtMs: number;
}

export function getTelegramFollowerSessionHandoff():
  | TelegramFollowerSessionHandoff
  | undefined {
  const value = (globalThis as Record<string, unknown>)[
    TELEGRAM_FOLLOWER_SESSION_HANDOFF_KEY
  ];
  if (!value || typeof value !== "object") return undefined;
  const handoff = value as Partial<TelegramFollowerSessionHandoff>;
  if (
    typeof handoff.pid !== "number" ||
    typeof handoff.instanceId !== "string" ||
    typeof handoff.createdAtMs !== "number"
  ) {
    return undefined;
  }
  return handoff as TelegramFollowerSessionHandoff;
}

export function setTelegramFollowerSessionHandoff(
  handoff: TelegramFollowerSessionHandoff | undefined,
): void {
  const store = globalThis as Record<string, unknown>;
  if (!handoff) delete store[TELEGRAM_FOLLOWER_SESSION_HANDOFF_KEY];
  else store[TELEGRAM_FOLLOWER_SESSION_HANDOFF_KEY] = handoff;
}

export function isTelegramFollowerSessionHandoffFresh(
  handoff: TelegramFollowerSessionHandoff | undefined,
  options: { pid?: number; nowMs?: number; ttlMs?: number } = {},
): handoff is TelegramFollowerSessionHandoff {
  if (!handoff) return false;
  const pid = options.pid ?? process.pid;
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? TELEGRAM_FOLLOWER_SESSION_HANDOFF_TTL_MS;
  return handoff.pid === pid && nowMs - handoff.createdAtMs <= ttlMs;
}

export interface TelegramBusFollowerRegistrationRuntime<TContext> {
  registerWithLeader: (
    ctx: TContext,
    leader: { busSocketPath?: string; busSecret?: string },
  ) => Promise<boolean>;
  setContext: (ctx: TContext) => void;
  stop: () => void;
}

export interface TelegramBusFollowerSessionReplacementSuspenderDeps {
  registrationState: Pick<TelegramBusFollowerRegistrationState, "isRegistered">;
  instanceId: string;
  suspendPolling: () => Promise<void>;
  onFollowerSessionDisconnect?: () => Promise<void> | void;
  recordRuntimeEvent: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  getNowMs?: () => number;
  getPid?: () => number;
}

export interface TelegramBusFollowerSessionRefreshHookDeps<TContext> {
  registrationState: Pick<TelegramBusFollowerRegistrationState, "isRegistered">;
  registrationRuntime: Pick<
    TelegramBusFollowerRegistrationRuntime<TContext>,
    "registerWithLeader" | "setContext"
  >;
  getLeaderState: () => TelegramLockState;
  updateStatus: (ctx: TContext) => void;
  recordRuntimeEvent: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramBusFollowerRegistrationState {
  isRegistered: () => boolean;
  getTarget: () => TelegramTarget | undefined;
  getSlot: () => string | undefined;
  getThreadName: () => string | undefined;
  setRegistered: (
    registered: boolean,
    target?: TelegramTarget,
    metadata?: { slot?: string; threadName?: string },
  ) => void;
}

export interface TelegramBusForwardedUpdateReceiverRuntime {
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface TelegramBusFollowerApiCallerDeps {
  socketPath: TelegramBusSocketPathSource;
  instanceId: string;
  createRequestId: () => string;
  getAuthSecret?: () => string | undefined;
  getNowMs?: () => number;
  timeoutMs?: number;
}

export interface TelegramBusFollowerRegistrationRuntimeDeps<
  TContext extends { cwd?: string },
> {
  instanceId: string;
  createRequestId: () => string;
  getLeaderAuthSecret?: (leader: { busSecret?: string }) => string | undefined;
  setActiveAuthSecret?: (secret: string | undefined) => void;
  followerBusSocketPath?: string;
  getFollowerBusSocketPath?: () => string;
  getLeaderSocketPath?: () => string;
  startReceiving?: () => Promise<void>;
  stopReceiving?: () => Promise<void> | void;
  registrationState?: TelegramBusFollowerRegistrationState;
  getProfileKey?: (ctx: TContext) => string | undefined;
  getThreadName?: (ctx: TContext) => string | undefined;
  getNowMs?: () => number;
  getPid?: () => number;
  timeoutMs?: number;
  registrationTimeoutMs?: number;
  registrationRetryAttempts?: number;
  registrationRetryDelayMs?: number;
  heartbeatMs?: number;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  onHeartbeatFailure?: (error: unknown, ctx: TContext) => Promise<void> | void;
}

export function createTelegramManualFollowerProfileKeyResolver(input: {
  getActiveProfileName: () => string | undefined;
  manualFollowerOwnerId: string;
}): () => string {
  return () =>
    Threads.getTelegramThreadOwnerKey({
      kind: "manual-follower",
      instanceId: input.manualFollowerOwnerId,
      telegramProfile: input.getActiveProfileName(),
    });
}

export type TelegramBusFollowerPromotionHandler<TContext> = (
  ctx: TContext,
  binding: TelegramBusFollowerPromotedBinding,
) => Promise<void>;

export function createTelegramBusFollowerPromotionHandler<
  TContext extends { cwd: string },
>(input: {
  topicTargetStore: Threads.TelegramTopicTargetStore;
  instanceId: string;
  getActiveProfileName: () => string | undefined;
  startLeader: (ctx: TContext) => Promise<unknown> | unknown;
  recordRuntimeEvent: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}): TelegramBusFollowerPromotionHandler<TContext> {
  return async (ctx, binding) => {
    const promotedRecord = await Threads.promoteTelegramFollowerBindingToLeader({
      store: input.topicTargetStore,
      instanceId: input.instanceId,
      cwd: ctx.cwd,
      telegramProfile: input.getActiveProfileName(),
      target: binding.target,
      slot: binding.slot,
      threadName: binding.threadName,
    });
    if (promotedRecord) {
      input.recordRuntimeEvent(
        "bus",
        "Follower thread binding promoted to leader",
        {
          phase: "follower-promoted-binding",
          chatId: promotedRecord.target.chatId,
          threadId: promotedRecord.target.threadId,
          slot: promotedRecord.slot,
          threadName: promotedRecord.threadName,
        },
      );
    }
    await input.startLeader(ctx);
  };
}

export interface TelegramBusFollowerTargetReplacementHandlerDeps<TContext> {
  topicTargetStore: Pick<
    Threads.TelegramTopicTargetStore,
    "load" | "list" | "markStaleByTarget" | "upsert" | "persist"
  >;
  registrationState: Pick<
    TelegramBusFollowerRegistrationState,
    "getTarget" | "setRegistered"
  >;
  instanceId: string;
  getManualFollowerProfileKey: () => string;
  manualFollowerOwnerId: string;
  getSyncState: () => Sync.TelegramSyncState;
  setSyncState: (state: Sync.TelegramSyncState) => void;
  getNowMs?: () => number;
  updateStatus: (ctx: TContext) => void;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export type TelegramBusFollowerLeaderState =
  | { kind: "inactive" }
  | { kind: "active-here"; lock: TelegramBusFollowerLeaderLock }
  | { kind: "active-elsewhere"; lock: TelegramBusFollowerLeaderLock }
  | { kind: "stale"; lock: TelegramBusFollowerLeaderLock };

export interface TelegramBusFollowerLeaderLock {
  busSocketPath?: string;
  busSecret?: string;
}

export interface TelegramBusFollowerPromotedBinding {
  target?: TelegramTarget;
  slot?: string;
  threadName?: string;
}

export interface TelegramBusFollowerHeartbeatRecoveryHandlerDeps<TContext> {
  registrationState: Pick<
    TelegramBusFollowerRegistrationState,
    "getTarget" | "getSlot" | "getThreadName" | "setRegistered"
  >;
  getRegistrationRuntime: () => TelegramBusFollowerRegistrationRuntime<TContext>;
  getLeaderState: () => TelegramBusFollowerLeaderState;
  setLifecyclePhase: (phase: "electing" | undefined) => void;
  updateStatus: (ctx: TContext) => void;
  promoteToLeader: (
    ctx: TContext,
    binding: TelegramBusFollowerPromotedBinding,
  ) => Promise<void> | void;
  sleep: (ms: number) => Promise<void>;
  promotionGraceMs: number;
  recordRuntimeEvent: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramBusForwardedUpdateReceiverRuntimeDeps<
  TContext,
  TReactionUpdate,
  TCallbackQuery,
  TMessage = unknown,
> {
  socketPath: TelegramBusSocketPathSource;
  instanceId: string;
  getAuthSecret?: () => string | undefined;
  getContext: () => TContext | undefined;
  handleForwardedCallback: (
    query: TCallbackQuery,
    ctx: TContext,
  ) => Promise<void> | void;
  handleForwardedReaction: (
    reactionUpdate: TReactionUpdate,
    ctx: TContext,
  ) => Promise<void> | void;
  handleForwardedMessage?: (
    message: TMessage,
    ctx: TContext,
  ) => Promise<void> | void;
  handleForwardedEditedMessage?: (
    message: TMessage,
    ctx: TContext,
  ) => Promise<void> | void;
  handleReplaceTarget?: (
    input: {
      target: TelegramTarget & { threadId: number };
      oldTarget?: TelegramTarget & { threadId: number };
      reason: "thread-restore";
    },
    ctx: TContext,
  ) => Promise<void> | void;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramBusFollowerRuntimeAssemblyDeps<
  TContext extends { cwd?: string },
  TReactionUpdate,
  TCallbackQuery,
  TMessage = unknown,
> {
  receiver: Omit<
    TelegramBusForwardedUpdateReceiverRuntimeDeps<
      TContext,
      TReactionUpdate,
      TCallbackQuery,
      TMessage
    >,
    "handleReplaceTarget"
  >;
  targetReplacement: TelegramBusFollowerTargetReplacementHandlerDeps<TContext>;
  recovery: Omit<
    TelegramBusFollowerHeartbeatRecoveryHandlerDeps<TContext>,
    "getRegistrationRuntime"
  >;
  registration: Omit<
    TelegramBusFollowerRegistrationRuntimeDeps<TContext>,
    "startReceiving" | "stopReceiving" | "onHeartbeatFailure"
  >;
}

export interface TelegramBusFollowerRuntimeAssembly<TContext> {
  receiver: TelegramBusForwardedUpdateReceiverRuntime;
  registration: TelegramBusFollowerRegistrationRuntime<TContext>;
}

export function createTelegramBusFollowerRuntimeAssembly<
  TContext extends { cwd?: string },
  TReactionUpdate,
  TCallbackQuery,
  TMessage = unknown,
>(
  deps: TelegramBusFollowerRuntimeAssemblyDeps<
    TContext,
    TReactionUpdate,
    TCallbackQuery,
    TMessage
  >,
): TelegramBusFollowerRuntimeAssembly<TContext> {
  const receiver = createTelegramBusForwardedUpdateReceiverRuntime({
    ...deps.receiver,
    handleReplaceTarget:
      createTelegramBusFollowerTargetReplacementHandler(
        deps.targetReplacement,
      ),
  });
  let registration: TelegramBusFollowerRegistrationRuntime<TContext>;
  const recovery = createTelegramBusFollowerHeartbeatRecoveryHandler({
    ...deps.recovery,
    getRegistrationRuntime: () => registration,
  });
  registration = createTelegramBusFollowerRegistrationRuntime({
    ...deps.registration,
    startReceiving: receiver.start,
    stopReceiving: receiver.stop,
    onHeartbeatFailure: recovery,
  });
  return { receiver, registration };
}

export function createTelegramBusFollowerTargetReplacementHandler<TContext>(
  deps: TelegramBusFollowerTargetReplacementHandlerDeps<TContext>,
): NonNullable<
  TelegramBusForwardedUpdateReceiverRuntimeDeps<
    TContext,
    unknown,
    unknown
  >["handleReplaceTarget"]
> {
  const getNowMs = deps.getNowMs ?? Date.now;
  return async (input, ctx) => {
    await deps.topicTargetStore.load();
    const nowMs = getNowMs();
    const currentRecord = Threads.findCurrentTelegramInstanceThreadRecord({
      records: deps.topicTargetStore.list(),
      instanceId: deps.instanceId,
      preferredTarget: input.oldTarget ?? deps.registrationState.getTarget(),
    });
    if (input.oldTarget) {
      deps.topicTargetStore.markStaleByTarget(
        input.oldTarget,
        "deleted",
        "Follower thread was replaced by thread restore.",
      );
    } else if (currentRecord) {
      deps.topicTargetStore.markStaleByTarget(
        currentRecord.target,
        "deleted",
        "Follower thread was replaced by thread restore.",
      );
    }
    const profileKey =
      currentRecord?.profileKey ?? deps.getManualFollowerProfileKey();
    deps.topicTargetStore.upsert({
      profileKey,
      owner: {
        kind: "manual-follower",
        instanceId: deps.manualFollowerOwnerId,
      },
      target: input.target,
      status: "active",
      syncStatus: "open",
      createdAtMs: currentRecord?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
      lastSyncObservedAtMs: nowMs,
      lastReconcileAction: "follower-thread-restore",
      instanceId: deps.instanceId,
      slot: currentRecord?.slot,
      threadName: currentRecord?.threadName,
      rerouteConfirmedAtMs: nowMs,
    });
    deps.registrationState.setRegistered(true, input.target);
    deps.setSyncState(
      Sync.markTelegramSyncSliceFresh(deps.getSyncState(), "target-bindings", {
        nowMs,
        action: "follower-thread-restore",
      }),
    );
    await deps.topicTargetStore.persist();
    deps.updateStatus(ctx);
    deps.recordRuntimeEvent?.(
      "bus",
      "Telegram follower thread target replaced",
      {
        phase: "follower-thread-restore",
        chatId: input.target.chatId,
        threadId: input.target.threadId,
        oldThreadId:
          input.oldTarget?.threadId ?? currentRecord?.target.threadId,
        slot: currentRecord?.slot,
      },
    );
  };
}

export function createTelegramBusFollowerApiCaller(
  deps: TelegramBusFollowerApiCallerDeps,
): (method: string, args: unknown[]) => Promise<unknown> {
  const getNowMs = deps.getNowMs ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 30000;
  return async (method, args) => {
    const socketPath = resolveTelegramBusSocketPath(deps.socketPath);
    const response = await sendTelegramBusLocalEnvelope({
      socketPath,
      timeoutMs,
      retry: getTelegramBusTransportRetryPolicy({
        endpoint: socketPath,
        operation: "operation",
      }),
      envelope: {
        kind: "follower.callApi",
        requestId: deps.createRequestId(),
        auth: deps.getAuthSecret?.(),
        instanceId: deps.instanceId,
        method,
        args,
        sentAtMs: getNowMs(),
      },
    });
    if (response?.kind === "bus.ack" && response.ok) return response.result;
    const message =
      response?.kind === "bus.ack"
        ? response.message
        : "Telegram bus API call did not return an acknowledgement.";
    throw new Error(message ?? "Telegram bus API call failed.");
  };
}

function isTelegramStaleContextError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("stale after session") ||
      error.message.includes("stale ctx"))
  );
}

export async function markTelegramFollowerThreadStaleForSessionDisconnect(input: {
  topicTargetStore: Threads.TelegramTopicTargetStore;
  target: TelegramTarget;
}): Promise<void> {
  await input.topicTargetStore.load();
  const record = input.topicTargetStore.list().find(
    (candidate) =>
      candidate.target.chatId === input.target.chatId &&
      candidate.target.threadId === input.target.threadId,
  );
  const marked = input.topicTargetStore.markStaleByTarget(
    input.target,
    "unknown",
    "Follower session reloaded before reconnect.",
  );
  const forgotIdentity = record?.profileKey
    ? input.topicTargetStore.forgetIdentityByProfileKey(record.profileKey)
    : false;
  if (marked || forgotIdentity) await input.topicTargetStore.persist();
}

export function createTelegramBusFollowerSessionReplacementSuspender(
  deps: TelegramBusFollowerSessionReplacementSuspenderDeps,
): () => Promise<void> {
  return async () => {
    if (deps.registrationState.isRegistered()) {
      setTelegramFollowerSessionHandoff(undefined);
      await deps.onFollowerSessionDisconnect?.();
      deps.recordRuntimeEvent(
        "bus",
        "Telegram follower registration stopped for session replacement",
        {
          phase: "follower-session-disconnect",
          instanceId: deps.instanceId,
        },
      );
    }
    await deps.suspendPolling();
  };
}

export function createTelegramBusFollowerSessionRefreshHook<TContext>(
  deps: TelegramBusFollowerSessionRefreshHookDeps<TContext>,
): (_event: unknown, ctx: TContext) => Promise<void> {
  return async (_event, ctx) => {
    if (!deps.registrationState.isRegistered()) {
      const handoff = getTelegramFollowerSessionHandoff();
      const lockState = deps.getLeaderState();
      const handoffIsFresh = isTelegramFollowerSessionHandoffFresh(handoff);
      if (handoffIsFresh && lockState.kind === "active-elsewhere") {
        try {
          const restored = await deps.registrationRuntime.registerWithLeader(
            ctx,
            lockState.lock,
          );
          if (restored) {
            setTelegramFollowerSessionHandoff(undefined);
            deps.updateStatus(ctx);
            deps.recordRuntimeEvent(
              "bus",
              "Telegram follower registration restored after session replacement",
              {
                phase: "follower-session-restore",
                previousInstanceId: handoff.instanceId,
              },
            );
          }
        } catch (error) {
          deps.recordRuntimeEvent("bus", error, {
            phase: "follower-session-restore",
            previousInstanceId: handoff?.instanceId,
          });
        }
      } else if (handoff) {
        setTelegramFollowerSessionHandoff(undefined);
      }
    }
    if (!deps.registrationState.isRegistered()) return;
    deps.registrationRuntime.setContext(ctx);
    deps.updateStatus(ctx);
    deps.recordRuntimeEvent(
      "bus",
      "Telegram follower session context refreshed",
      { phase: "follower-session-refresh" },
    );
  };
}

export function createTelegramBusFollowerRegistrationState(): TelegramBusFollowerRegistrationState {
  let registered = false;
  let target: TelegramTarget | undefined;
  let slot: string | undefined;
  let threadName: string | undefined;
  return {
    isRegistered: () => registered,
    getTarget: () => (target ? { ...target } : undefined),
    getSlot: () => slot,
    getThreadName: () => threadName,
    setRegistered: (next, nextTarget, metadata) => {
      registered = next;
      target = next ? (nextTarget ? { ...nextTarget } : undefined) : undefined;
      slot = next ? metadata?.slot : undefined;
      threadName = next ? metadata?.threadName : undefined;
    },
  };
}

export function createTelegramBusFollowerHeartbeatRecoveryHandler<TContext>(
  deps: TelegramBusFollowerHeartbeatRecoveryHandlerDeps<TContext>,
): (error: unknown, ctx: TContext) => Promise<void> {
  let promotionPending = false;
  const safeUpdateStatus = (ctx: TContext) => {
    try {
      deps.updateStatus(ctx);
    } catch (error) {
      if (!isTelegramStaleContextError(error)) throw error;
      deps.recordRuntimeEvent("bus", error, {
        phase: "follower-stale-context-status",
      });
    }
  };
  const clearRegisteredState = (ctx: TContext) => {
    deps.registrationState.setRegistered(false);
    safeUpdateStatus(ctx);
  };
  const tryRegisterWithLeader = async (
    ctx: TContext,
    leader: TelegramBusFollowerLeaderLock,
    phase: string,
  ) => {
    try {
      const restored = await deps
        .getRegistrationRuntime()
        .registerWithLeader(ctx, leader);
      if (!restored) return false;
      deps.setLifecyclePhase(undefined);
      safeUpdateStatus(ctx);
      deps.recordRuntimeEvent(
        "bus",
        "Telegram follower registration restored",
        {
          phase,
        },
      );
      return true;
    } catch (error) {
      clearRegisteredState(ctx);
      deps.recordRuntimeEvent("bus", error, { phase });
      return false;
    }
  };
  const snapshotBinding = (): TelegramBusFollowerPromotedBinding => ({
    target: deps.registrationState.getTarget(),
    slot: deps.registrationState.getSlot(),
    threadName: deps.registrationState.getThreadName(),
  });
  const promoteToLeader = async (
    reason: unknown,
    ctx: TContext,
    binding = snapshotBinding(),
  ) => {
    deps.setLifecyclePhase("electing");
    safeUpdateStatus(ctx);
    deps.recordRuntimeEvent("bus", reason, {
      phase: "follower-promotion-electing",
    });
    deps.getRegistrationRuntime().stop();
    deps.setLifecyclePhase("electing");
    safeUpdateStatus(ctx);
    deps.recordRuntimeEvent("bus", "Telegram follower elected for promotion", {
      phase: "follower-promotion-electing",
    });
    await deps.promoteToLeader(ctx, binding);
    deps.setLifecyclePhase(undefined);
    safeUpdateStatus(ctx);
    deps.recordRuntimeEvent("bus", "Telegram follower promotion completed", {
      phase: "follower-promotion-complete",
    });
  };
  return async (error, ctx) => {
    if (promotionPending) return;
    promotionPending = true;
    try {
      const initialBinding = snapshotBinding();
      const state = deps.getLeaderState();
      if (state.kind === "active-elsewhere") {
        clearRegisteredState(ctx);
        if (
          await tryRegisterWithLeader(
            ctx,
            state.lock,
            "follower-register-restore",
          )
        ) {
          return;
        }
        deps.setLifecyclePhase("electing");
        safeUpdateStatus(ctx);
        deps.recordRuntimeEvent(
          "bus",
          "Telegram follower waiting for leader reload recovery",
          { phase: "follower-promotion-grace" },
        );
        await deps.sleep(deps.promotionGraceMs);
        const graceState = deps.getLeaderState();
        if (graceState.kind === "active-elsewhere") {
          if (
            await tryRegisterWithLeader(
              ctx,
              graceState.lock,
              "follower-register-restore-grace",
            )
          ) {
            return;
          }
          await promoteToLeader(error, ctx, initialBinding);
          return;
        }
        if (graceState.kind === "stale" || graceState.kind === "inactive") {
          await promoteToLeader(error, ctx, initialBinding);
        }
        return;
      }
      if (state.kind === "stale" || state.kind === "inactive") {
        await promoteToLeader(error, ctx, initialBinding);
      }
    } catch (promotionError) {
      deps.setLifecyclePhase(undefined);
      safeUpdateStatus(ctx);
      if (isTelegramStaleContextError(promotionError)) {
        deps.recordRuntimeEvent("bus", promotionError, {
          phase: "follower-heartbeat-stale-context",
        });
        return;
      }
      throw promotionError;
    } finally {
      promotionPending = false;
    }
  };
}

export function createTelegramBusFollowerRegistrationRuntime<
  TContext extends { cwd?: string },
>(
  deps: TelegramBusFollowerRegistrationRuntimeDeps<TContext>,
): TelegramBusFollowerRegistrationRuntime<TContext> {
  const getNowMs = deps.getNowMs ?? Date.now;
  const getPid = deps.getPid ?? (() => process.pid);
  const heartbeatMs = deps.heartbeatMs ?? 1000;
  const registrationTimeoutMs =
    deps.registrationTimeoutMs ?? deps.timeoutMs ?? 30000;
  const registrationRetryAttempts =
    deps.registrationRetryAttempts ??
    TELEGRAM_BUS_FOLLOWER_REGISTRATION_RETRY_ATTEMPTS;
  const registrationRetryDelayMs =
    deps.registrationRetryDelayMs ??
    TELEGRAM_BUS_FOLLOWER_REGISTRATION_RETRY_DELAY_MS;
  let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  let activeLeaderSocketPath: string | undefined;
  let activeAuthSecret: string | undefined;
  let activeContext: TContext | undefined;
  let lastKnownTarget: TelegramTarget | undefined;
  const stopHeartbeat = () => {
    if (!heartbeatInterval) return;
    clearInterval(heartbeatInterval);
    heartbeatInterval = undefined;
  };
  const stop = () => {
    stopHeartbeat();
    activeAuthSecret = undefined;
    deps.setActiveAuthSecret?.(undefined);
    deps.registrationState?.setRegistered(false);
    lastKnownTarget = undefined;
    activeContext = undefined;
    void deps.stopReceiving?.();
  };
  const sendHeartbeat = async () => {
    if (!activeLeaderSocketPath) return;
    try {
      const response = await sendTelegramBusLocalEnvelope({
        socketPath: activeLeaderSocketPath,
        timeoutMs: deps.timeoutMs,
        retry: getTelegramBusTransportRetryPolicy({
          endpoint: activeLeaderSocketPath,
          operation: "operation",
        }),
        envelope: {
          kind: "follower.heartbeat",
          requestId: deps.createRequestId(),
          auth: activeAuthSecret,
          instanceId: deps.instanceId,
          sentAtMs: getNowMs(),
        },
      });
      if (response?.kind === "bus.ack" && !response.ok) {
        throw new Error(
          response.message ?? "Telegram bus follower heartbeat was rejected.",
        );
      }
    } catch (error) {
      deps.recordRuntimeEvent?.("bus", error, { phase: "follower-heartbeat" });
      if (activeContext) await deps.onHeartbeatFailure?.(error, activeContext);
    }
  };
  const startHeartbeat = (socketPath: string) => {
    stopHeartbeat();
    activeLeaderSocketPath = socketPath;
    heartbeatInterval = setInterval(() => {
      void sendHeartbeat();
    }, heartbeatMs);
    heartbeatInterval.unref?.();
  };
  return {
    registerWithLeader: async (ctx, leader) => {
      const leaderSocketPath =
        leader.busSocketPath ??
        deps.getLeaderSocketPath?.() ??
        getTelegramBusSocketPath();
      await deps.startReceiving?.();
      activeAuthSecret = deps.getLeaderAuthSecret?.(leader);
      deps.setActiveAuthSecret?.(activeAuthSecret);
      const createRegistrationEnvelope = (): Extract<
        TelegramBusEnvelope,
        { kind: "follower.register" }
      > => ({
        kind: "follower.register",
        requestId: deps.createRequestId(),
        auth: activeAuthSecret,
        registration: {
          instanceId: deps.instanceId,
          profileKey:
            deps.getProfileKey?.(ctx) ??
            (ctx.cwd ? `cwd:${ctx.cwd}` : undefined),
          threadName:
            deps.getThreadName?.(ctx) ??
            (ctx.cwd ? basename(ctx.cwd) : undefined),
          cwd: ctx.cwd,
          pid: getPid(),
          target: deps.registrationState?.getTarget() ?? lastKnownTarget,
          busSocketPath:
            deps.getFollowerBusSocketPath?.() ?? deps.followerBusSocketPath,
          connectedAtMs: getNowMs(),
        },
      });
      let response: TelegramBusEnvelope | undefined;
      try {
        response = await sendTelegramBusLocalEnvelope({
          socketPath: leaderSocketPath,
          timeoutMs: registrationTimeoutMs,
          envelope: createRegistrationEnvelope(),
          retry: getTelegramBusTransportRetryPolicy({
            endpoint: leaderSocketPath,
            operation: "registration",
            overrides: {
              attempts: registrationRetryAttempts,
              delayMs: registrationRetryDelayMs,
            },
          }),
          recordTransportEvent(phase, details) {
            deps.recordRuntimeEvent?.("bus", `Telegram bus ${phase}`, {
              phase: `follower-register-${phase}`,
              ...details,
            });
          },
        });
      } catch (error) {
        stopHeartbeat();
        activeLeaderSocketPath = undefined;
        activeAuthSecret = undefined;
        deps.registrationState?.setRegistered(false);
        deps.setActiveAuthSecret?.(undefined);
        await deps.stopReceiving?.();
        throw error;
      }
      if (response?.kind === "bus.ack" && !response.ok) {
        stopHeartbeat();
        activeLeaderSocketPath = undefined;
        activeAuthSecret = undefined;
        deps.registrationState?.setRegistered(false);
        deps.setActiveAuthSecret?.(undefined);
        await deps.stopReceiving?.();
        throw new Error(
          response.message ??
            "Telegram bus follower registration was rejected.",
        );
      }
      if (response?.kind === "bus.ack" && response.ok) {
        const registrationResult = parseRegistrationResult(response.result);
        deps.registrationState?.setRegistered(
          true,
          registrationResult.target,
          registrationResult,
        );
        lastKnownTarget = registrationResult.target;
        activeLeaderSocketPath = leaderSocketPath;
        activeContext = ctx;
        await sendHeartbeat();
        startHeartbeat(leaderSocketPath);
        return true;
      }
      stopHeartbeat();
      activeLeaderSocketPath = undefined;
      activeAuthSecret = undefined;
      deps.registrationState?.setRegistered(false);
      deps.setActiveAuthSecret?.(undefined);
      await deps.stopReceiving?.();
      return false;
    },
    setContext(ctx) {
      activeContext = ctx;
    },
    stop,
  };
}

export function createTelegramBusForwardedUpdateReceiverRuntime<
  TContext,
  TReactionUpdate,
  TCallbackQuery,
  TMessage = unknown,
>(
  deps: TelegramBusForwardedUpdateReceiverRuntimeDeps<
    TContext,
    TReactionUpdate,
    TCallbackQuery,
    TMessage
  >,
): TelegramBusForwardedUpdateReceiverRuntime {
  const server = createTelegramBusLocalServer({
    socketPath: deps.socketPath,
    recordTransportEvent(phase, details) {
      deps.recordRuntimeEvent?.("bus", `Telegram bus ${phase}`, {
        phase: `follower-receiver-${phase}`,
        ...details,
      });
    },
    async handleEnvelope(envelope) {
      const authSecret = deps.getAuthSecret?.();
      if (deps.getAuthSecret && (!authSecret || envelope.auth !== authSecret)) {
        return createUnauthorizedBusAck(envelope.requestId);
      }
      if (
        (envelope.kind !== "leader.forwardCallback" &&
          envelope.kind !== "leader.forwardReaction" &&
          envelope.kind !== "leader.forwardMessage" &&
          envelope.kind !== "leader.forwardEditedMessage" &&
          envelope.kind !== "leader.replaceFollowerTarget") ||
        envelope.recipientInstanceId !== deps.instanceId
      ) {
        return {
          kind: "bus.ack",
          requestId: envelope.requestId,
          ok: false,
          message: "Telegram bus receiver cannot handle this envelope.",
        };
      }
      const ctx = deps.getContext();
      if (!ctx) {
        return {
          kind: "bus.ack",
          requestId: envelope.requestId,
          ok: false,
          message: "Telegram bus follower has no active context.",
        };
      }
      try {
        if (envelope.kind === "leader.forwardCallback") {
          await deps.handleForwardedCallback(
            envelope.query as TCallbackQuery,
            ctx,
          );
        } else if (envelope.kind === "leader.forwardReaction") {
          await deps.handleForwardedReaction(
            envelope.reactionUpdate as TReactionUpdate,
            ctx,
          );
        } else if (envelope.kind === "leader.forwardMessage") {
          if (!deps.handleForwardedMessage) {
            throw new Error(
              "Telegram bus receiver cannot handle this envelope.",
            );
          }
          await deps.handleForwardedMessage(envelope.message as TMessage, ctx);
        } else if (envelope.kind === "leader.forwardEditedMessage") {
          if (!deps.handleForwardedEditedMessage) {
            throw new Error(
              "Telegram bus receiver cannot handle this envelope.",
            );
          }
          await deps.handleForwardedEditedMessage(
            envelope.message as TMessage,
            ctx,
          );
        } else {
          if (!deps.handleReplaceTarget) {
            throw new Error(
              "Telegram bus receiver cannot replace follower target.",
            );
          }
          await deps.handleReplaceTarget(
            {
              target: envelope.target,
              ...(envelope.oldTarget ? { oldTarget: envelope.oldTarget } : {}),
              reason: envelope.reason,
            },
            ctx,
          );
        }
        return { kind: "bus.ack", requestId: envelope.requestId, ok: true };
      } catch (error) {
        deps.recordRuntimeEvent?.("bus", error, { phase: "follower-forward" });
        return {
          kind: "bus.ack",
          requestId: envelope.requestId,
          ok: false,
          message:
            error instanceof Error
              ? error.message
              : "Telegram bus follower dispatch failed.",
        };
      }
    },
  });
  return server;
}

function parseRegistrationResult(value: unknown): {
  target?: TelegramTarget;
  slot?: string;
  threadName?: string;
} {
  if (!isRecord(value)) return {};
  const target = parseTarget(isRecord(value.target) ? value.target : value);
  return {
    ...(target ? { target } : {}),
    ...(typeof value.slot === "string" ? { slot: value.slot } : {}),
    ...(typeof value.threadName === "string"
      ? { threadName: value.threadName }
      : {}),
  };
}

function parseTarget(value: unknown): TelegramTarget | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.chatId !== "number") return undefined;
  const target: TelegramTarget = { chatId: value.chatId };
  if (typeof value.threadId === "number") target.threadId = value.threadId;
  return target;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
