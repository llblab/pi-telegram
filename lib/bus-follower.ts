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
import type { TelegramLockEntry, TelegramLockState } from "./locks.ts";
import type { TelegramTarget } from "./target.ts";
import {
  isTelegramApiMethodRetrySafe,
  TelegramApiCommitUnknownError,
} from "./telegram-api.ts";
import {
  createTelegramBusFollowerTargetController,
  createTelegramBusForeignOwnedUpdateForwarder,
  createTelegramBusLocalServer,
  createTelegramBusRequestIdFactory,
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
  target: TelegramTarget;
  slot?: string;
  threadName?: string;
}

export function getTelegramFollowerSessionHandoff():
  TelegramFollowerSessionHandoff | undefined {
  const value = (globalThis as Record<string, unknown>)[
    TELEGRAM_FOLLOWER_SESSION_HANDOFF_KEY
  ];
  if (!value || typeof value !== "object") return undefined;
  const handoff = value as Partial<TelegramFollowerSessionHandoff>;
  if (
    typeof handoff.pid !== "number" ||
    typeof handoff.instanceId !== "string" ||
    typeof handoff.createdAtMs !== "number" ||
    !handoff.target ||
    typeof handoff.target !== "object" ||
    typeof handoff.target.chatId !== "number"
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
    options?: { target?: TelegramTarget },
  ) => Promise<boolean>;
  setContext: (ctx: TContext) => void;
  stop: () => void;
}

export interface TelegramBusFollowerSessionReplacementSuspenderDeps {
  registrationState: Pick<
    TelegramBusFollowerRegistrationState,
    "isRegistered" | "getTarget" | "getSlot" | "getThreadName"
  >;
  instanceId: string;
  suspendPolling: () => Promise<void>;
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
  isSessionActive?: (ctx: TContext) => boolean;
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
  getGeneration: () => string | undefined;
  setRegistered: (
    registered: boolean,
    target?: TelegramTarget,
    metadata?: { slot?: string; threadName?: string; generation?: string },
  ) => void;
}

export interface TelegramBusForwardedUpdateReceiverRuntime {
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface TelegramBusFollowerClientRuntimeDeps {
  socketPath: TelegramBusSocketPathSource;
  instanceId: string;
  getApiAuthSecret?: () => string | undefined;
  getForwardingAuthSecret?: () => string | undefined;
  getRegistrationGeneration?: () => string | undefined;
  timeoutMs?: number;
}

export interface TelegramBusFollowerApiCallerDeps {
  socketPath: TelegramBusSocketPathSource;
  instanceId: string;
  createRequestId: () => string;
  getAuthSecret?: () => string | undefined;
  getRegistrationGeneration?: () => string | undefined;
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
  isContextActive?: (ctx: TContext) => boolean;
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

export interface TelegramBusFollowerElection {
  expectedOwner?: TelegramLockEntry;
}

export type TelegramBusFollowerPromotionHandler<TContext> = (
  ctx: TContext,
  binding: TelegramBusFollowerPromotedBinding,
  election: TelegramBusFollowerElection,
) => Promise<boolean>;

export function createTelegramBusFollowerPromotionHandler<
  TContext extends { cwd: string },
>(input: {
  topicTargetStore: Threads.TelegramTopicTargetStore;
  instanceId: string;
  getActiveProfileName: () => string | undefined;
  startLeader: (
    ctx: TContext,
    election: TelegramBusFollowerElection,
    onAcquired: () => Promise<void>,
  ) => Promise<boolean>;
  recordRuntimeEvent: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}): TelegramBusFollowerPromotionHandler<TContext> {
  return async (ctx, binding, election) =>
    input.startLeader(ctx, election, async () => {
      const promotedRecord =
        await Threads.promoteTelegramFollowerBindingToLeader({
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
    });
}

export interface TelegramBusFollowerTargetReplacementHandlerDeps<TContext> {
  topicTargetStore: Pick<
    Threads.TelegramTopicTargetStore,
    "load" | "list" | "markStaleByTarget" | "upsert" | "persist"
  >;
  registrationState: Pick<
    TelegramBusFollowerRegistrationState,
    "getTarget" | "setRegistered"
  > &
    Partial<Pick<TelegramBusFollowerRegistrationState, "getGeneration">>;
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

export type TelegramBusFollowerLeaderLock = TelegramLockEntry;

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
    election: TelegramBusFollowerElection,
  ) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  scheduleRetry?: (retry: () => void, delayMs: number) => void;
  getActiveContext?: () => TContext | undefined;
  promotionGraceMs?: number;
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
  getRegistrationGeneration?: () => string | undefined;
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

export function createTelegramBusForwardedRouteHandlers<
  TContext,
  TReactionUpdate,
  TCallbackQuery,
  TMessage,
>(route: {
  handleUpdate(
    update: {
      callback_query?: TCallbackQuery;
      message?: TMessage;
      edited_message?: TMessage;
    },
    ctx: TContext,
  ): Promise<void> | void;
  handleAuthorizedReactionUpdate(
    reactionUpdate: TReactionUpdate,
    ctx: TContext,
  ): Promise<void> | void;
}): Pick<
  TelegramBusForwardedUpdateReceiverRuntimeDeps<
    TContext,
    TReactionUpdate,
    TCallbackQuery,
    TMessage
  >,
  | "handleForwardedCallback"
  | "handleForwardedReaction"
  | "handleForwardedMessage"
  | "handleForwardedEditedMessage"
> {
  return {
    handleForwardedCallback: (query, ctx) =>
      route.handleUpdate({ callback_query: query }, ctx),
    handleForwardedReaction: route.handleAuthorizedReactionUpdate,
    handleForwardedMessage: (message, ctx) =>
      route.handleUpdate({ message }, ctx),
    handleForwardedEditedMessage: (message, ctx) =>
      route.handleUpdate({ edited_message: message }, ctx),
  };
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
    getRegistrationGeneration:
      deps.targetReplacement.registrationState.getGeneration,
    handleReplaceTarget: createTelegramBusFollowerTargetReplacementHandler(
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
    deps.registrationState.setRegistered(true, input.target, {
      slot: currentRecord?.slot,
      threadName: currentRecord?.threadName,
      generation: deps.registrationState.getGeneration?.(),
    });
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

export function createTelegramBusFollowerClientRuntime<
  TContext,
  TReactionUpdate,
  TCallbackQuery,
  TMessage = unknown,
>(deps: TelegramBusFollowerClientRuntimeDeps) {
  const createRequestId = createTelegramBusRequestIdFactory(deps.instanceId);
  const sharedClientDeps = {
    socketPath: deps.socketPath,
    createRequestId,
    timeoutMs: deps.timeoutMs,
  };
  return {
    createRequestId,
    callApi: createTelegramBusFollowerApiCaller({
      ...sharedClientDeps,
      instanceId: deps.instanceId,
      getAuthSecret: deps.getApiAuthSecret,
      getRegistrationGeneration: deps.getRegistrationGeneration,
    }),
    foreignOwnedUpdateForwarder: createTelegramBusForeignOwnedUpdateForwarder<
      TContext,
      TReactionUpdate,
      TCallbackQuery,
      TMessage
    >({
      ...sharedClientDeps,
      getAuthSecret: deps.getForwardingAuthSecret,
    }),
    targetController: createTelegramBusFollowerTargetController({
      ...sharedClientDeps,
      getAuthSecret: deps.getForwardingAuthSecret,
    }),
  };
}

export function createTelegramBusFollowerApiCaller(
  deps: TelegramBusFollowerApiCallerDeps,
): (method: string, args: unknown[]) => Promise<unknown> {
  const getNowMs = deps.getNowMs ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 30000;
  return async (method, args) => {
    const socketPath = resolveTelegramBusSocketPath(deps.socketPath);
    let response: TelegramBusEnvelope | undefined;
    try {
      response = await sendTelegramBusLocalEnvelope({
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
          ...(deps.getRegistrationGeneration?.()
            ? {
                registrationGeneration: deps.getRegistrationGeneration?.(),
              }
            : {}),
          method,
          args,
          sentAtMs: getNowMs(),
        },
      });
    } catch (error) {
      const apiMethod =
        (method === "call" || method === "callMultipart") &&
        typeof args[0] === "string"
          ? args[0]
          : method;
      if (!isTelegramApiMethodRetrySafe(apiMethod)) {
        throw new TelegramApiCommitUnknownError(apiMethod, error);
      }
      throw error;
    }
    if (response?.kind === "bus.ack" && response.ok) return response.result;
    const message =
      response?.kind === "bus.ack"
        ? response.message
        : "Telegram bus API call did not return an acknowledgement.";
    if (
      response?.kind === "bus.ack" &&
      response.error?.code === "commit-unknown"
    ) {
      throw new TelegramApiCommitUnknownError(
        response.error.method ?? method,
        new Error(message ?? "Telegram bus API call result is ambiguous."),
      );
    }
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

export function createTelegramBusFollowerSessionReplacementSuspender(
  deps: TelegramBusFollowerSessionReplacementSuspenderDeps,
): () => Promise<void> {
  const getNowMs = deps.getNowMs ?? Date.now;
  const getPid = deps.getPid ?? (() => process.pid);
  return async () => {
    const target = deps.registrationState.getTarget();
    if (deps.registrationState.isRegistered() && target) {
      setTelegramFollowerSessionHandoff({
        pid: getPid(),
        instanceId: deps.instanceId,
        createdAtMs: getNowMs(),
        target,
        slot: deps.registrationState.getSlot(),
        threadName: deps.registrationState.getThreadName(),
      });
      deps.recordRuntimeEvent(
        "bus",
        "Telegram follower registration suspended for session replacement",
        {
          phase: "follower-session-handoff",
          instanceId: deps.instanceId,
          chatId: target.chatId,
          threadId: target.threadId,
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
    if (deps.isSessionActive && !deps.isSessionActive(ctx)) return;
    if (!deps.registrationState.isRegistered()) {
      const handoff = getTelegramFollowerSessionHandoff();
      const lockState = deps.getLeaderState();
      const handoffIsFresh = isTelegramFollowerSessionHandoffFresh(handoff);
      if (handoffIsFresh && lockState.kind === "active-elsewhere") {
        try {
          const restored = await deps.registrationRuntime.registerWithLeader(
            ctx,
            lockState.lock,
            { target: handoff.target },
          );
          if (deps.isSessionActive && !deps.isSessionActive(ctx)) return;
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
    if (deps.isSessionActive && !deps.isSessionActive(ctx)) return;
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
  let generation: string | undefined;
  return {
    isRegistered: () => registered,
    getTarget: () => (target ? { ...target } : undefined),
    getSlot: () => slot,
    getThreadName: () => threadName,
    getGeneration: () => generation,
    setRegistered: (next, nextTarget, metadata) => {
      registered = next;
      target = next ? (nextTarget ? { ...nextTarget } : undefined) : undefined;
      slot = next ? metadata?.slot : undefined;
      threadName = next ? metadata?.threadName : undefined;
      generation = next ? metadata?.generation : undefined;
    },
  };
}

export function createTelegramBusFollowerHeartbeatRecoveryHandler<TContext>(
  deps: TelegramBusFollowerHeartbeatRecoveryHandlerDeps<TContext>,
): (error: unknown, ctx: TContext) => Promise<void> {
  const promotionGraceMs =
    deps.promotionGraceMs ?? TELEGRAM_BUS_FOLLOWER_PROMOTION_GRACE_MS;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const scheduleRetry =
    deps.scheduleRetry ??
    ((retry: () => void, delayMs: number) => {
      const timer = setTimeout(retry, delayMs);
      timer.unref?.();
    });
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
    binding?: TelegramBusFollowerPromotedBinding,
  ) => {
    try {
      const restored = await deps
        .getRegistrationRuntime()
        .registerWithLeader(
          ctx,
          leader,
          binding?.target ? { target: binding.target } : undefined,
        );
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
  const scheduleRecovery = (
    reason: unknown,
    fallbackCtx: TContext,
    binding: TelegramBusFollowerPromotedBinding,
  ) => {
    const retry = () => {
      const activeCtx = deps.getActiveContext
        ? deps.getActiveContext()
        : fallbackCtx;
      if (!activeCtx) {
        scheduleRetry(retry, promotionGraceMs);
        return;
      }
      void recover(reason, activeCtx, binding);
    };
    scheduleRetry(retry, promotionGraceMs);
  };
  const promoteToLeader = async (
    reason: unknown,
    ctx: TContext,
    binding: TelegramBusFollowerPromotedBinding,
    election: TelegramBusFollowerElection,
  ) => {
    const activeCtx = deps.getActiveContext?.();
    if (deps.getActiveContext && activeCtx !== ctx) {
      scheduleRecovery(reason, ctx, binding);
      return;
    }
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
    const promoted = await deps.promoteToLeader(ctx, binding, election);
    deps.setLifecyclePhase(undefined);
    safeUpdateStatus(ctx);
    deps.recordRuntimeEvent(
      "bus",
      promoted
        ? "Telegram follower promotion completed"
        : "Telegram follower promotion lost election",
      {
        phase: promoted
          ? "follower-promotion-complete"
          : "follower-promotion-lost",
      },
    );
    if (!promoted) scheduleRecovery(reason, ctx, binding);
  };
  const recover = async (
    error: unknown,
    ctx: TContext,
    carriedBinding?: TelegramBusFollowerPromotedBinding,
  ): Promise<void> => {
    if (promotionPending) return;
    promotionPending = true;
    try {
      const initialBinding = carriedBinding ?? snapshotBinding();
      const state = deps.getLeaderState();
      if (state.kind === "active-elsewhere") {
        clearRegisteredState(ctx);
        if (
          await tryRegisterWithLeader(
            ctx,
            state.lock,
            "follower-register-restore",
            initialBinding,
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
        await sleep(promotionGraceMs);
        const graceState = deps.getLeaderState();
        if (graceState.kind === "active-elsewhere") {
          if (
            await tryRegisterWithLeader(
              ctx,
              graceState.lock,
              "follower-register-restore-grace",
              initialBinding,
            )
          ) {
            return;
          }
          deps.setLifecyclePhase(undefined);
          safeUpdateStatus(ctx);
          deps.recordRuntimeEvent(
            "bus",
            "Telegram follower promotion blocked by live leader lease",
            {
              phase: "follower-promotion-live-owner",
              leaderInstanceId: graceState.lock.instanceId,
              leaderEpoch: graceState.lock.leaderEpoch,
            },
          );
          scheduleRecovery(error, ctx, initialBinding);
          return;
        }
        if (graceState.kind === "stale" || graceState.kind === "inactive") {
          await promoteToLeader(error, ctx, initialBinding, {
            expectedOwner:
              graceState.kind === "stale" ? graceState.lock : undefined,
          });
        }
        return;
      }
      if (state.kind === "stale" || state.kind === "inactive") {
        await promoteToLeader(error, ctx, initialBinding, {
          expectedOwner: state.kind === "stale" ? state.lock : undefined,
        });
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
  return recover;
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
  let activeRegistrationGeneration: string | undefined;
  let activeContext: TContext | undefined;
  let lastKnownTarget: TelegramTarget | undefined;
  let lastKnownSlot: string | undefined;
  let lastKnownThreadName: string | undefined;
  const stopHeartbeat = () => {
    if (!heartbeatInterval) return;
    clearInterval(heartbeatInterval);
    heartbeatInterval = undefined;
  };
  const stop = () => {
    stopHeartbeat();
    activeAuthSecret = undefined;
    activeRegistrationGeneration = undefined;
    deps.setActiveAuthSecret?.(undefined);
    deps.registrationState?.setRegistered(false);
    lastKnownTarget = undefined;
    lastKnownSlot = undefined;
    lastKnownThreadName = undefined;
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
          ...(activeRegistrationGeneration
            ? { registrationGeneration: activeRegistrationGeneration }
            : {}),
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
    registerWithLeader: async (ctx, leader, options) => {
      const leaderSocketPath =
        leader.busSocketPath ??
        deps.getLeaderSocketPath?.() ??
        getTelegramBusSocketPath();
      await deps.startReceiving?.();
      activeAuthSecret = deps.getLeaderAuthSecret?.(leader);
      deps.setActiveAuthSecret?.(activeAuthSecret);
      const registrationGeneration = deps.createRequestId();
      const registrationEnvelope: Extract<
        TelegramBusEnvelope,
        { kind: "follower.register" }
      > = {
        kind: "follower.register",
        requestId: registrationGeneration,
        auth: activeAuthSecret,
        registration: {
          instanceId: deps.instanceId,
          profileKey:
            deps.getProfileKey?.(ctx) ??
            (ctx.cwd ? `cwd:${ctx.cwd}` : undefined),
          threadName:
            deps.registrationState?.getThreadName() ??
            lastKnownThreadName ??
            deps.getThreadName?.(ctx) ??
            (ctx.cwd ? basename(ctx.cwd) : undefined),
          ...((deps.registrationState?.getSlot() ?? lastKnownSlot)
            ? { slot: deps.registrationState?.getSlot() ?? lastKnownSlot }
            : {}),
          cwd: ctx.cwd,
          pid: getPid(),
          target:
            options?.target ??
            deps.registrationState?.getTarget() ??
            lastKnownTarget,
          busSocketPath:
            deps.getFollowerBusSocketPath?.() ?? deps.followerBusSocketPath,
          registrationGeneration,
          connectedAtMs: getNowMs(),
        },
      };
      let response: TelegramBusEnvelope | undefined;
      try {
        response = await sendTelegramBusLocalEnvelope({
          socketPath: leaderSocketPath,
          timeoutMs: registrationTimeoutMs,
          envelope: registrationEnvelope,
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
      if (deps.isContextActive && !deps.isContextActive(ctx)) {
        stopHeartbeat();
        activeLeaderSocketPath = undefined;
        activeAuthSecret = undefined;
        deps.setActiveAuthSecret?.(undefined);
        await deps.stopReceiving?.();
        return false;
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
        deps.registrationState?.setRegistered(true, registrationResult.target, {
          ...registrationResult,
          generation: registrationGeneration,
        });
        lastKnownTarget = registrationResult.target;
        lastKnownSlot = registrationResult.slot;
        lastKnownThreadName = registrationResult.threadName;
        activeLeaderSocketPath = leaderSocketPath;
        activeRegistrationGeneration = registrationGeneration;
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
      const registrationGeneration = deps.getRegistrationGeneration?.();
      if (
        registrationGeneration &&
        envelope.recipientRegistrationGeneration !== registrationGeneration
      ) {
        return {
          kind: "bus.ack",
          requestId: envelope.requestId,
          ok: false,
          message: "Stale Telegram bus follower registration generation.",
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
