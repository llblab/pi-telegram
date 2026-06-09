/**
 * Telegram bridge runtime-state helpers
 * Zones: pi agent runtime state, telegram session, shared coordination
 * Owns small session-local runtime primitives that are shared by orchestration but are not specific to queueing, rendering, polling, or Telegram transport
 */

const TELEGRAM_TYPING_ACTION_INTERVAL_MS = 2500;
const TELEGRAM_TYPING_IDLE_DRAIN_MAX_MS = 250;

export interface TelegramRuntimeQueueCounters {
  nextQueuedTelegramItemOrder: number;
  nextQueuedTelegramControlOrder: number;
  nextPriorityReactionOrder: number;
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
  typingInterval?: ReturnType<typeof setInterval>;
  typingInFlight?: Promise<void>;
}

export interface TelegramRuntimeQueuePort {
  syncCounters: (counters: Partial<TelegramRuntimeQueueCounters>) => void;
  allocateItemOrder: () => number;
  allocateControlOrder: () => number;
  getNextPriorityReactionOrder: () => number;
  incrementNextPriorityReactionOrder: () => void;
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
  waitForIdle: () => Promise<void>;
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
    nextPriorityReactionOrder: 0,
    activeTelegramToolExecutions: 0,
    telegramTurnDispatchPending: false,
    compactionInProgress: false,
    foldQueuedPromptsIntoHistory: false,
    setupInProgress: false,
  };
}

export function createTelegramBridgeRuntime(
  state = createTelegramBridgeRuntimeState(),
): TelegramBridgeRuntime {
  return {
    state,
    queue: {
      syncCounters: (counters) =>
        syncTelegramQueueRuntimeCounters(state, counters),
      allocateItemOrder: () => allocateTelegramQueueItemOrder(state),
      allocateControlOrder: () => allocateTelegramQueueControlOrder(state),
      getNextPriorityReactionOrder: () =>
        getNextTelegramPriorityReactionOrder(state),
      incrementNextPriorityReactionOrder: () =>
        incrementNextTelegramPriorityReactionOrder(state),
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
    typing: {
      start: (deps) => startTelegramTypingLoop(state, deps),
      stop: () => stopTelegramTypingLoop(state),
      waitForIdle: () => waitForTelegramTypingLoopIdle(state),
    },
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
  if (counters.nextPriorityReactionOrder !== undefined) {
    state.nextPriorityReactionOrder = counters.nextPriorityReactionOrder;
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

export function getNextTelegramPriorityReactionOrder(
  state: TelegramBridgeRuntimeState,
): number {
  return state.nextPriorityReactionOrder;
}

export function incrementNextTelegramPriorityReactionOrder(
  state: TelegramBridgeRuntimeState,
): void {
  state.nextPriorityReactionOrder += 1;
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

export interface TelegramTypingLoopDeps {
  chatId: number | undefined;
  intervalMs: number;
  sendTypingAction: (chatId: number) => Promise<unknown>;
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
    options.recordRuntimeEvent?.(options.category, statusError, {
      phase: options.phase,
    });
  }
}

export interface TelegramTypingLoopStarterDeps<
  TContext,
> extends TelegramRuntimeEventRecorderPort {
  typing: TelegramRuntimeTypingPort;
  getDefaultChatId: () => number | undefined;
  sendTypingAction: (chatId: number) => Promise<unknown>;
  updateStatus: (ctx: TContext, error?: string) => void;
  intervalMs?: number;
}

export function createTelegramTypingLoopStarter<TContext>(
  deps: TelegramTypingLoopStarterDeps<TContext>,
): (ctx: TContext, chatId?: number) => void {
  return (ctx, chatId) => {
    deps.typing.start({
      chatId: chatId ?? deps.getDefaultChatId(),
      intervalMs: deps.intervalMs ?? TELEGRAM_TYPING_ACTION_INTERVAL_MS,
      sendTypingAction: async (targetChatId) => {
        try {
          await deps.sendTypingAction(targetChatId);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          updateTelegramRuntimeStatusSafely(deps.updateStatus, ctx, {
            error: message,
            category: "typing",
            phase: "status-update",
            recordRuntimeEvent: deps.recordRuntimeEvent,
          });
          deps.recordRuntimeEvent?.("typing", error, {
            chatId: targetChatId,
          });
        }
      },
    });
  };
}

export function startTelegramTypingLoop(
  state: TelegramBridgeRuntimeState,
  deps: TelegramTypingLoopDeps,
): boolean {
  if (state.typingInterval || deps.chatId === undefined || deps.chatId === 0)
    return false;
  const sendTyping = (): void => {
    const typing = Promise.resolve(deps.sendTypingAction(deps.chatId as number))
      .then(() => undefined)
      .catch(() => undefined);
    state.typingInFlight = typing;
    void typing.finally(() => {
      if (state.typingInFlight === typing) state.typingInFlight = undefined;
    });
  };
  sendTyping();
  state.typingInterval = setInterval(sendTyping, deps.intervalMs);
  state.typingInterval.unref?.();
  return true;
}

export function stopTelegramTypingLoop(
  state: TelegramBridgeRuntimeState,
): boolean {
  if (!state.typingInterval) return false;
  clearInterval(state.typingInterval);
  state.typingInterval = undefined;
  return true;
}

export async function waitForTelegramTypingLoopIdle(
  state: TelegramBridgeRuntimeState,
  timeoutMs = TELEGRAM_TYPING_IDLE_DRAIN_MAX_MS,
): Promise<void> {
  const inFlight = state.typingInFlight;
  if (!inFlight) return;
  if (timeoutMs <= 0) {
    await Promise.race([inFlight, Promise.resolve()]);
    return;
  }
  await Promise.race([
    inFlight,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
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
  startTypingLoop: (ctx: TContext, chatId?: number) => void;
  updateStatus: (ctx: TContext, error?: string) => void;
}

export interface TelegramPromptDispatchRuntimeDeps<
  TContext,
> extends TelegramRuntimeEventRecorderPort {
  lifecycle: TelegramPromptDispatchLifecycleDeps<TContext>["lifecycle"];
  typing: TelegramRuntimeTypingPort;
  getDefaultChatId: () => number | undefined;
  sendTypingAction: (chatId: number) => Promise<unknown>;
  updateStatus: (ctx: TContext, error?: string) => void;
  intervalMs?: number;
}

export interface TelegramPromptDispatchRuntime<TContext> {
  startTypingLoop: (ctx: TContext, chatId?: number) => void;
  onPromptDispatchStart: (ctx: TContext, chatId?: number) => void;
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
    onPromptDispatchStart: (ctx: TContext, chatId?: number): void => {
      deps.lifecycle.setDispatchPending(true);
      deps.startTypingLoop(ctx, chatId);
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
