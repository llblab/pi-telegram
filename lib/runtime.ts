/**
 * Telegram bridge runtime-state helpers
 * Zones: pi agent runtime state, telegram session, shared coordination
 * Owns small session-local runtime primitives that are shared by orchestration but are not specific to queueing, rendering, polling, or Telegram transport
 */

import * as Machine from "./machine.ts";

/**
 * Structural port for run-collapsing diagnostics: a repeated identical failure extends its run instead of logging
 * again, and the closing success records one outcome. The composition root owns the collapsed implementation.
 */
export interface TelegramRepeatedFailureLogPort {
  record: (error: unknown, details?: Record<string, unknown>) => void;
  settled: () => void;
  reset: () => void;
}

/** A faulty diagnostics port must not break its owning loop, probe, interval callback or completed outcome. */
function guardTelegramRepeatedFailureLog(
  port: TelegramRepeatedFailureLogPort,
): TelegramRepeatedFailureLogPort {
  const guarded = <A extends unknown[]>(call: (...args: A) => void) =>
    (...args: A): void => {
      try {
        call(...args);
      } catch {
        // Diagnostics are best-effort.
      }
    };
  return {
    record: guarded((error, details) => port.record(error, details)),
    settled: guarded(() => port.settled()),
    reset: guarded(() => port.reset()),
  };
}

const TELEGRAM_TYPING_ACTION_INTERVAL_MS = 3_000;
const TELEGRAM_TYPING_IDLE_DRAIN_MAX_MS = 250;

export interface TelegramRuntimeQueueCounters {
  nextQueuedTelegramItemOrder: number;
  nextQueuedTelegramControlOrder: number;
}

export interface TelegramRuntimeLifecycleFlags {
  activeTelegramToolExecutions: number;
  telegramTurnDispatchPending: boolean;
  compactionInProgress: boolean;
  foldQueuedPromptsIntoHistory: boolean;
  setupInProgress: boolean;
}

export interface TelegramBridgeRuntimeState
  extends TelegramRuntimeQueueCounters, TelegramRuntimeLifecycleFlags {
  abortHandler?: () => void;
}

export interface TelegramRuntimeQueuePort {
  syncCounters: (counters: Partial<TelegramRuntimeQueueCounters>) => void;
  allocateItemOrder: () => number;
  allocateControlOrder: () => number;
}

export interface TelegramRuntimeLifecyclePort {
  syncFlags: (flags: Partial<TelegramRuntimeLifecycleFlags>) => void;
  getActiveToolExecutions: () => number;
  setActiveToolExecutions: (count: number) => void;
  resetActiveToolExecutions: () => void;
  hasDispatchPending: () => boolean;
  setDispatchPending: (pending: boolean) => void;
  clearDispatchPending: () => void;
  isCompactionInProgress: () => boolean;
  setCompactionInProgress: (inProgress: boolean) => void;
  shouldFoldQueuedPromptsIntoHistory: () => boolean;
  setFoldQueuedPromptsIntoHistory: (fold: boolean) => void;
}

export interface TelegramRuntimeSetupPort {
  isInProgress: () => boolean;
  start: () => boolean;
  finish: () => void;
}

export interface TelegramRuntimeAbortPort {
  hasHandler: () => boolean;
  setHandler: (abortHandler: () => void) => void;
  clearHandler: () => void;
  getHandler: () => (() => void) | undefined;
  abortTurn: () => boolean;
}

export interface TelegramRuntimeTypingPort {
  start: (deps: TelegramTypingLoopDeps) => boolean;
  stop: () => boolean;
  /** Waits for the in-flight action, bounded so a never-settling request cannot hold shutdown. */
  waitForIdle: (timeoutMs?: number) => Promise<void>;
}

export interface TelegramBridgeRuntime {
  state: TelegramBridgeRuntimeState;
  queue: TelegramRuntimeQueuePort;
  lifecycle: TelegramRuntimeLifecyclePort;
  setup: TelegramRuntimeSetupPort;
  abort: TelegramRuntimeAbortPort;
  typing: TelegramRuntimeTypingPort;
}

export function createTelegramBridgeRuntimeState(): TelegramBridgeRuntimeState {
  return {
    nextQueuedTelegramItemOrder: 0,
    nextQueuedTelegramControlOrder: 0,
    activeTelegramToolExecutions: 0,
    telegramTurnDispatchPending: false,
    compactionInProgress: false,
    foldQueuedPromptsIntoHistory: false,
    setupInProgress: false,
  };
}

export function createTelegramBridgeRuntime(
  state = createTelegramBridgeRuntimeState(),
  typing = createTelegramTypingLoop(),
): TelegramBridgeRuntime {
  return {
    state,
    queue: {
      syncCounters: (counters) =>
        syncTelegramQueueRuntimeCounters(state, counters),
      allocateItemOrder: () => allocateTelegramQueueItemOrder(state),
      allocateControlOrder: () => allocateTelegramQueueControlOrder(state),
    },
    lifecycle: {
      syncFlags: (flags) => syncTelegramLifecycleRuntimeFlags(state, flags),
      getActiveToolExecutions: () => getActiveTelegramToolExecutions(state),
      setActiveToolExecutions: (count) =>
        setActiveTelegramToolExecutions(state, count),
      resetActiveToolExecutions: () => resetActiveTelegramToolExecutions(state),
      hasDispatchPending: () => hasTelegramDispatchPending(state),
      setDispatchPending: (pending) =>
        setTelegramDispatchPending(state, pending),
      clearDispatchPending: () => clearTelegramDispatchPending(state),
      isCompactionInProgress: () => isTelegramCompactionInProgress(state),
      setCompactionInProgress: (inProgress) =>
        setTelegramCompactionInProgress(state, inProgress),
      shouldFoldQueuedPromptsIntoHistory: () =>
        shouldFoldQueuedPromptsIntoHistory(state),
      setFoldQueuedPromptsIntoHistory: (fold) =>
        setFoldQueuedPromptsIntoHistory(state, fold),
    },
    setup: {
      isInProgress: () => isTelegramSetupInProgress(state),
      start: () => startTelegramSetup(state),
      finish: () => finishTelegramSetup(state),
    },
    abort: {
      hasHandler: () => hasTelegramAbortHandler(state),
      setHandler: (abortHandler) =>
        setTelegramAbortHandler(state, abortHandler),
      clearHandler: () => clearTelegramAbortHandler(state),
      getHandler: () => getTelegramAbortHandler(state),
      abortTurn: () => abortTelegramTurn(state),
    },
    typing,
  };
}

export function syncTelegramQueueRuntimeCounters(
  state: TelegramBridgeRuntimeState,
  counters: Partial<TelegramRuntimeQueueCounters>,
): void {
  if (counters.nextQueuedTelegramItemOrder !== undefined) {
    state.nextQueuedTelegramItemOrder = counters.nextQueuedTelegramItemOrder;
  }
  if (counters.nextQueuedTelegramControlOrder !== undefined) {
    state.nextQueuedTelegramControlOrder =
      counters.nextQueuedTelegramControlOrder;
  }
}

export function allocateTelegramQueueItemOrder(
  state: TelegramBridgeRuntimeState,
): number {
  return state.nextQueuedTelegramItemOrder++;
}

export function allocateTelegramQueueControlOrder(
  state: TelegramBridgeRuntimeState,
): number {
  return state.nextQueuedTelegramControlOrder++;
}

export function syncTelegramLifecycleRuntimeFlags(
  state: TelegramBridgeRuntimeState,
  flags: Partial<TelegramRuntimeLifecycleFlags>,
): void {
  if (flags.activeTelegramToolExecutions !== undefined) {
    state.activeTelegramToolExecutions = flags.activeTelegramToolExecutions;
  }
  if (flags.telegramTurnDispatchPending !== undefined) {
    state.telegramTurnDispatchPending = flags.telegramTurnDispatchPending;
  }
  if (flags.compactionInProgress !== undefined) {
    state.compactionInProgress = flags.compactionInProgress;
  }
  if (flags.foldQueuedPromptsIntoHistory !== undefined) {
    state.foldQueuedPromptsIntoHistory = flags.foldQueuedPromptsIntoHistory;
  }
  if (flags.setupInProgress !== undefined) {
    state.setupInProgress = flags.setupInProgress;
  }
}

export function getActiveTelegramToolExecutions(
  state: TelegramBridgeRuntimeState,
): number {
  return state.activeTelegramToolExecutions;
}

export function setActiveTelegramToolExecutions(
  state: TelegramBridgeRuntimeState,
  count: number,
): void {
  state.activeTelegramToolExecutions = count;
}

export function resetActiveTelegramToolExecutions(
  state: TelegramBridgeRuntimeState,
): void {
  state.activeTelegramToolExecutions = 0;
}

export function hasTelegramDispatchPending(
  state: TelegramBridgeRuntimeState,
): boolean {
  return state.telegramTurnDispatchPending;
}

function setTelegramDispatchPending(
  state: TelegramBridgeRuntimeState,
  pending: boolean,
): void {
  state.telegramTurnDispatchPending = pending;
}

export function clearTelegramDispatchPending(
  state: TelegramBridgeRuntimeState,
): void {
  state.telegramTurnDispatchPending = false;
}

export function isTelegramCompactionInProgress(
  state: TelegramBridgeRuntimeState,
): boolean {
  return state.compactionInProgress;
}

export function setTelegramCompactionInProgress(
  state: TelegramBridgeRuntimeState,
  inProgress: boolean,
): void {
  state.compactionInProgress = inProgress;
}

export function shouldFoldQueuedPromptsIntoHistory(
  state: TelegramBridgeRuntimeState,
): boolean {
  return state.foldQueuedPromptsIntoHistory;
}

export function setFoldQueuedPromptsIntoHistory(
  state: TelegramBridgeRuntimeState,
  fold: boolean,
): void {
  state.foldQueuedPromptsIntoHistory = fold;
}

export function isTelegramSetupInProgress(
  state: TelegramBridgeRuntimeState,
): boolean {
  return state.setupInProgress;
}

export function startTelegramSetup(state: TelegramBridgeRuntimeState): boolean {
  if (state.setupInProgress) return false;
  state.setupInProgress = true;
  return true;
}

export function finishTelegramSetup(state: TelegramBridgeRuntimeState): void {
  state.setupInProgress = false;
}

export function hasTelegramAbortHandler(
  state: TelegramBridgeRuntimeState,
): boolean {
  return !!state.abortHandler;
}

export function setTelegramAbortHandler(
  state: TelegramBridgeRuntimeState,
  abortHandler: () => void,
): void {
  state.abortHandler = abortHandler;
}

export function clearTelegramAbortHandler(
  state: TelegramBridgeRuntimeState,
): void {
  state.abortHandler = undefined;
}

export function getTelegramAbortHandler(
  state: TelegramBridgeRuntimeState,
): (() => void) | undefined {
  return state.abortHandler;
}

export function abortTelegramTurn(state: TelegramBridgeRuntimeState): boolean {
  if (!state.abortHandler) return false;
  state.abortHandler();
  return true;
}

export interface TelegramTypingLoopTarget {
  chatId: number;
  threadId?: number;
}

export interface TelegramTypingLoopDeps {
  chatId: number | undefined;
  target?: TelegramTypingLoopTarget;
  intervalMs: number;
  sendTypingAction: (
    chatId: number,
    options?: { message_thread_id?: number },
  ) => Promise<unknown>;
  shouldContinue?: () => boolean;
  onStopped?: () => void;
}

export interface TelegramRuntimeEventRecorderPort {
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

function updateTelegramRuntimeStatusSafely<TContext>(
  updateStatus: (ctx: TContext, error?: string) => void,
  ctx: TContext,
  options: {
    error?: string;
    category: string;
    phase: string;
    recordRuntimeEvent?: TelegramRuntimeEventRecorderPort["recordRuntimeEvent"];
  },
): void {
  try {
    updateStatus(ctx, options.error);
  } catch (statusError) {
    try {
      options.recordRuntimeEvent?.(options.category, statusError, {
        phase: options.phase,
      });
    } catch {
      // Status diagnostics cannot escape an asynchronous runtime owner.
    }
  }
}

export interface TelegramTypingLoopStarterDeps<
  TContext,
> extends TelegramRuntimeEventRecorderPort {
  /** Collapses one sustained presence failure run; the caller supplies its owner. */
  failureLog: TelegramRepeatedFailureLogPort;
  typing: TelegramRuntimeTypingPort;
  getDefaultChatId: () => number | undefined;
  sendTypingAction: (
    chatId: number,
    options?: { message_thread_id?: number; assertAuthority?: () => void; isCancelled?: () => boolean },
  ) => Promise<unknown>;
  updateStatus: (ctx: TContext, error?: string) => void;
  isContextActive?: (ctx: TContext) => boolean;
  getSessionGeneration?: () => number;
  isTransportAvailable?: () => boolean;
  isThreadedMode?: () => boolean;
  getTransportAuthority?: () => string | number | undefined;
  intervalMs?: number;
}

export function createTelegramTypingLoopStarter<TContext>(
  deps: TelegramTypingLoopStarterDeps<TContext>,
): (
  ctx: TContext,
  chatId?: number,
  options?: { target?: TelegramTypingLoopTarget; ensure?: boolean },
) => boolean {
  let currentOwner: {
    ctx: TContext;
    sessionGeneration: number | undefined;
    transportAuthority: string | number | undefined;
    chatId: number;
    threadId: number | undefined;
    canContinue: () => boolean;
  } | undefined;
  // An unreachable transport repeats one identical presence failure every tick; the port collapses the run.
  const typingFailureLog = guardTelegramRepeatedFailureLog(deps.failureLog);
  return (ctx, chatId, options) => {
    const sessionGeneration = deps.getSessionGeneration?.();
    const transportAuthority = deps.getTransportAuthority?.();
    const isContextCurrent = (): boolean => deps.isContextActive?.(ctx) !== false &&
      (!deps.getSessionGeneration || Object.is(deps.getSessionGeneration(), sessionGeneration));
    const hasTransport = (): boolean =>
      deps.getTransportAuthority
        ? transportAuthority !== undefined &&
          Object.is(deps.getTransportAuthority(), transportAuthority)
        : deps.isTransportAvailable?.() !== false;
    const target = options?.target ? { ...options.target } : undefined;
    const canContinue = (): boolean => isContextCurrent() && hasTransport() &&
      (deps.isThreadedMode?.() !== true ||
        (target?.threadId !== undefined && Number.isSafeInteger(target.threadId) && target.threadId > 0));
    // Queue dispatch precedes agent_start: only an explicit destination permits Threaded presence, never chat fallback.
    if (!canContinue()) return false;
    const resolvedChatId = chatId ?? deps.getDefaultChatId();
    if (resolvedChatId === undefined || resolvedChatId === 0) return false;
    // Streaming updates ensure presence without revoking the same owner's pending HTTP/IPC action.
    // Explicit starts still replace the loop, including a new turn on the same session and Thread.
    if (options?.ensure && currentOwner?.canContinue() &&
      (deps.getSessionGeneration
        ? Object.is(currentOwner.sessionGeneration, sessionGeneration)
        : Object.is(currentOwner.ctx, ctx)) &&
      Object.is(currentOwner.transportAuthority, transportAuthority) &&
      currentOwner.chatId === resolvedChatId && currentOwner.threadId === target?.threadId) return false;
    const owner = { ctx, sessionGeneration, transportAuthority, chatId: resolvedChatId,
      threadId: target?.threadId, canContinue };
    currentOwner = owner;
    let active = true;
    return deps.typing.start({
      chatId: resolvedChatId,
      target,
      intervalMs: deps.intervalMs ?? TELEGRAM_TYPING_ACTION_INTERVAL_MS,
      sendTypingAction: async (targetChatId, actionOptions) => {
        if (!active) return;
        if (!canContinue()) {
          deps.typing.stop();
          return;
        }
        try {
          await deps.sendTypingAction(targetChatId, {
            ...actionOptions,
            isCancelled: () => !active,
            // This stays process-local; adapters recheck it before HTTP/IPC issuance, not just loop ticks.
            assertAuthority() {
              if (!active || !canContinue()) throw new Error("Typing context authority changed.");
            },
          });
          typingFailureLog.settled();
        } catch (error) {
          if (!active) return;
          if (!canContinue()) {
            deps.typing.stop();
            return;
          }
          typingFailureLog.record(error, { chatId: targetChatId });
        }
      },
      shouldContinue: canContinue,
      onStopped: () => {
        active = false;
        typingFailureLog.reset();
        if (currentOwner === owner) currentOwner = undefined;
      },
    });
  };
}

function getTelegramTypingLoopKey(deps: TelegramTypingLoopDeps): string {
  const threadId = deps.target?.threadId;
  return `${deps.chatId ?? 0}:${Number.isInteger(threadId) ? threadId : "all"}`;
}

/** The whole typing-loop state; only `transitionTelegramTypingLoop` produces a new one. */
export interface TelegramTypingMachineState {
  /** The loop the interval serves; its callbacks live in the shell under `id`. A loop exists exactly while ticking. */
  readonly loop: {
    readonly id: number;
    readonly key: string;
    readonly chatId: number;
    readonly threadParams?: { readonly message_thread_id: number };
  } | null;
  /** The action in flight; a tick waits for it, and replacing or stopping the loop forgets it. */
  readonly inFlight: number | null;
  readonly nextSendId: number;
}

export type TelegramTypingEvent =
  | {
      type: "started";
      /** Shell-assigned, so the shell can hold the caller's callbacks before effects run. */
      loopId: number;
      chatId: number | undefined;
      key: string;
      threadParams?: { message_thread_id: number };
      intervalMs: number;
      /** The caller's `shouldContinue`, sampled at dispatch. */
      continues: boolean;
    }
  | { type: "ticked"; continues: boolean }
  | { type: "sendSettled"; sendId: number }
  | { type: "stopRequested" };

export type TelegramTypingEffect =
  | {
      type: "send";
      loopId: number;
      sendId: number;
      chatId: number;
      threadParams?: { message_thread_id: number };
    }
  | { type: "armInterval"; intervalMs: number }
  | { type: "cancelInterval" }
  | { type: "loopEnded"; loopId: number };

export interface TelegramTypingStep extends Machine.TelegramMachineStep<
  TelegramTypingMachineState,
  TelegramTypingEffect
> {
  /** `start`: a loop began or moved to a new target. `stop`: a running loop ended. */
  result: boolean;
}

export function createTelegramTypingMachineState(): TelegramTypingMachineState {
  return { loop: null, inFlight: null, nextSendId: 0 };
}

const typingStep = (
  state: TelegramTypingMachineState,
  result: boolean,
  ...effects: TelegramTypingEffect[]
): TelegramTypingStep => ({ state, effects, result });

function stopTypingLoop(state: TelegramTypingMachineState): TelegramTypingStep {
  if (!state.loop) return typingStep(state, false);
  return typingStep(
    { ...state, loop: null, inFlight: null },
    true,
    { type: "cancelInterval" },
    { type: "loopEnded", loopId: state.loop.id },
  );
}

/** One action per tick, never two at once; a caller that stops continuing ends the loop instead. */
function sendTypingAction(
  state: TelegramTypingMachineState,
  continues: boolean,
): TelegramTypingStep {
  const loop = state.loop;
  if (!loop) return typingStep(state, false);
  if (!continues) return stopTypingLoop(state);
  if (state.inFlight !== null) return typingStep(state, false);
  const sendId = state.nextSendId + 1;
  return typingStep({ ...state, inFlight: sendId, nextSendId: sendId }, false, {
    type: "send",
    loopId: loop.id,
    sendId,
    chatId: loop.chatId,
    ...(loop.threadParams ? { threadParams: loop.threadParams } : {}),
  });
}

/**
 * Pure typing-loop transition. Every start replaces the caller's callbacks, even on the same target, and forgets the
 * old in-flight action; only a new target sends at once on a running loop, whose interval keeps its phase.
 */
export function transitionTelegramTypingLoop(
  state: TelegramTypingMachineState,
  event: TelegramTypingEvent,
): TelegramTypingStep {
  switch (event.type) {
    case "started": {
      if (event.chatId === undefined || event.chatId === 0)
        return typingStep(state, false);
      const previous = state.loop;
      const replaced: TelegramTypingEffect[] = previous
        ? [{ type: "loopEnded", loopId: previous.id }]
        : [];
      const next: TelegramTypingMachineState = {
        ...state,
        inFlight: previous ? null : state.inFlight,
        loop: {
          id: event.loopId,
          key: event.key,
          chatId: event.chatId,
          ...(event.threadParams ? { threadParams: event.threadParams } : {}),
        },
      };
      if (previous?.key === event.key)
        return typingStep(next, false, ...replaced);
      if (previous) {
        const sent = sendTypingAction(next, event.continues);
        return typingStep(sent.state, true, ...replaced, ...sent.effects);
      }
      // A fresh loop always arms its interval; a caller that already stopped continuing ends it on the first tick.
      const sent = event.continues
        ? sendTypingAction(next, true)
        : typingStep(next, false);
      return typingStep(sent.state, true, ...sent.effects, {
        type: "armInterval",
        intervalMs: event.intervalMs,
      });
    }
    case "ticked":
      return sendTypingAction(state, event.continues);
    case "sendSettled":
      return typingStep(
        state.inFlight === event.sendId ? { ...state, inFlight: null } : state,
        false,
      );
    case "stopRequested":
      return stopTypingLoop(state);
  }
}

/**
 * The shell around `transitionTelegramTypingLoop`: it holds each loop's callbacks, samples `shouldContinue` into
 * events, owns the interval and turns every action outcome into `sendSettled`.
 */
export function createTelegramTypingLoop(): TelegramRuntimeTypingPort {
  const callbacks = new Map<number, TelegramTypingLoopDeps>();
  let interval: ReturnType<typeof setInterval> | undefined;
  let loopIds = 0;
  const continues = (loopId: number | undefined): boolean =>
    loopId === undefined
      ? false
      : callbacks.get(loopId)?.shouldContinue?.() !== false;
  const machine = Machine.createTelegramMachineRunner<
    TelegramTypingMachineState,
    TelegramTypingEvent,
    TelegramTypingEffect,
    TelegramTypingStep
  >({
    initial: createTelegramTypingMachineState(),
    transition: transitionTelegramTypingLoop,
    run(effect) {
      switch (effect.type) {
        case "send": {
          const send = callbacks.get(effect.loopId)?.sendTypingAction;
          // Failures belong to the caller's action; the loop only needs to know the action is over.
          void Promise.resolve()
            .then(() => send?.(effect.chatId, effect.threadParams))
            .then(
              () => undefined,
              () => undefined,
            )
            .then(() =>
              machine.dispatch({ type: "sendSettled", sendId: effect.sendId }),
            );
          return;
        }
        case "armInterval":
          interval = setInterval(
            () =>
              machine.dispatch({
                type: "ticked",
                continues: continues(machine.state.loop?.id),
              }),
            effect.intervalMs,
          );
          interval.unref?.();
          return;
        case "cancelInterval":
          clearInterval(interval);
          interval = undefined;
          return;
        case "loopEnded": {
          const ended = callbacks.get(effect.loopId);
          callbacks.delete(effect.loopId);
          ended?.onStopped?.();
          return;
        }
      }
    },
  });
  return {
    start(deps) {
      const loopId = ++loopIds;
      callbacks.set(loopId, deps);
      const threadId = deps.target?.threadId;
      const started = machine.dispatch({
        type: "started",
        loopId,
        chatId: deps.chatId,
        key: getTelegramTypingLoopKey(deps),
        ...(Number.isInteger(threadId)
          ? { threadParams: { message_thread_id: threadId! } }
          : {}),
        intervalMs: deps.intervalMs,
        continues: continues(loopId),
      });
      if (machine.state.loop?.id !== loopId) callbacks.delete(loopId);
      return started.result;
    },
    stop: () => machine.dispatch({ type: "stopRequested" }).result,
    async waitForIdle(timeoutMs = TELEGRAM_TYPING_IDLE_DRAIN_MAX_MS) {
      if (machine.state.inFlight === null) return;
      const idle = machine.waitFor((state) => state.inFlight === null);
      await Promise.race([
        idle,
        timeoutMs <= 0
          ? Promise.resolve()
          : new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    },
  };
}

export function createTelegramContextAbortHandlerSetter<
  TContext extends { abort: () => void },
>(
  abort: Pick<TelegramRuntimeAbortPort, "setHandler">,
): (ctx: TContext) => void {
  return (ctx) => {
    abort.setHandler(() => ctx.abort());
  };
}

export interface TelegramAgentEndResetDeps {
  abort: Pick<TelegramRuntimeAbortPort, "clearHandler">;
  typing: Pick<TelegramRuntimeTypingPort, "stop">;
  clearActiveTurn: () => void;
  resetToolExecutions: () => void;
  clearPendingModelSwitch: () => void;
  clearDispatchPending: () => void;
}

export function createTelegramAgentEndResetter(
  deps: TelegramAgentEndResetDeps,
): () => void {
  return () => {
    deps.abort.clearHandler();
    deps.typing.stop();
    deps.clearActiveTurn();
    deps.resetToolExecutions();
    deps.clearPendingModelSwitch();
    deps.clearDispatchPending();
  };
}

export interface TelegramPromptDispatchLifecycleDeps<
  TContext,
> extends TelegramRuntimeEventRecorderPort {
  lifecycle: Pick<
    TelegramRuntimeLifecyclePort,
    "setDispatchPending" | "clearDispatchPending"
  >;
  typing: Pick<TelegramRuntimeTypingPort, "stop">;
  startTypingLoop: (
    ctx: TContext,
    chatId?: number,
    options?: { target?: TelegramTypingLoopTarget },
  ) => boolean | void;
  updateStatus: (ctx: TContext, error?: string) => void;
}

export interface TelegramPromptDispatchRuntimeDeps<
  TContext,
> extends TelegramTypingLoopStarterDeps<TContext> {
  lifecycle: TelegramPromptDispatchLifecycleDeps<TContext>["lifecycle"];
}

export interface TelegramPromptDispatchRuntime<TContext> {
  startTypingLoop: (
    ctx: TContext,
    chatId?: number,
    options?: { target?: TelegramTypingLoopTarget; ensure?: boolean },
  ) => boolean | void;
  onPromptDispatchStart: (ctx: TContext, chatId?: number, target?: TelegramTypingLoopTarget) => void;
  onPromptDispatchFailure: (ctx: TContext, message: string) => void;
}

export function createTelegramPromptDispatchRuntime<TContext>(
  deps: TelegramPromptDispatchRuntimeDeps<TContext>,
): TelegramPromptDispatchRuntime<TContext> {
  const startTypingLoop = createTelegramTypingLoopStarter(deps);
  return {
    startTypingLoop,
    ...createTelegramPromptDispatchLifecycle({
      lifecycle: deps.lifecycle,
      typing: deps.typing,
      startTypingLoop,
      updateStatus: deps.updateStatus,
      recordRuntimeEvent: deps.recordRuntimeEvent,
    }),
  };
}

export function createTelegramPromptDispatchLifecycle<TContext>(
  deps: TelegramPromptDispatchLifecycleDeps<TContext>,
) {
  return {
    onPromptDispatchStart: (ctx: TContext, chatId?: number, target?: TelegramTypingLoopTarget): void => {
      deps.lifecycle.setDispatchPending(true);
      deps.startTypingLoop(ctx, chatId, { target });
      updateTelegramRuntimeStatusSafely(deps.updateStatus, ctx, {
        category: "dispatch",
        phase: "status-update",
        recordRuntimeEvent: deps.recordRuntimeEvent,
      });
    },
    onPromptDispatchFailure: (ctx: TContext, message: string): void => {
      deps.lifecycle.clearDispatchPending();
      deps.typing.stop();
      deps.recordRuntimeEvent?.("dispatch", new Error(message));
      updateTelegramRuntimeStatusSafely(deps.updateStatus, ctx, {
        error: `dispatch failed: ${message}`,
        category: "dispatch",
        phase: "status-update",
        recordRuntimeEvent: deps.recordRuntimeEvent,
      });
    },
  };
}
