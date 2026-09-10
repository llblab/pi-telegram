/**
 * Telegram polling runtime domain helpers
 * Zones: telegram transport, polling runtime
 * Owns polling request builders, stop conditions, and the long-poll loop runtime for Telegram updates
 */

type MaybePromise<T> = T | Promise<T>;

export interface TelegramPollingConfig {
  botToken?: string;
}

export interface TelegramUpdate {
  update_id: number;
}

const TELEGRAM_INITIAL_SYNC_OFFSET = -1;
const TELEGRAM_INITIAL_SYNC_LIMIT = 1;
const TELEGRAM_INITIAL_SYNC_TIMEOUT_SECONDS = 0;
const TELEGRAM_LONG_POLL_LIMIT = 10;
const TELEGRAM_LONG_POLL_TIMEOUT_SECONDS = 30;
const TELEGRAM_THREAD_CAPABILITY_MONITOR_INTERVAL_MS = 2_500;
const TELEGRAM_THREAD_CAPABILITY_DISABLED_CONFIRMATION_PROBES = 2;
export const TELEGRAM_GET_UPDATES_CONFLICT_STOP_LIMIT = 10;
const TELEGRAM_GET_UPDATES_CONFLICT_FAST_RETRY_LIMIT = 3;
const TELEGRAM_GET_UPDATES_CONFLICT_FAST_RETRY_MS = 1_000;
const TELEGRAM_GET_UPDATES_CONFLICT_SLOW_RETRY_MS = 3_000;
const TELEGRAM_POLLING_RETRY_MS = 3_000;
export const TELEGRAM_GET_UPDATES_GRACE_MS = 10_000;

// Standard Telegram DM polling does not expose ordinary message-deletion events,
// so queue removal stays reaction-driven while delete-like business updates remain defensive-only.
export const TELEGRAM_ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "callback_query",
  "message_reaction",
  "guest_message",
] as const;

export function buildTelegramInitialSyncRequest(): {
  offset: number;
  limit: number;
  timeout: number;
} {
  return {
    offset: TELEGRAM_INITIAL_SYNC_OFFSET,
    limit: TELEGRAM_INITIAL_SYNC_LIMIT,
    timeout: TELEGRAM_INITIAL_SYNC_TIMEOUT_SECONDS,
  };
}

export function buildTelegramLongPollRequest(lastUpdateId?: number): {
  offset?: number;
  limit: number;
  timeout: number;
  allowed_updates: readonly string[];
} {
  return {
    offset: lastUpdateId !== undefined ? lastUpdateId + 1 : undefined,
    limit: TELEGRAM_LONG_POLL_LIMIT,
    timeout: TELEGRAM_LONG_POLL_TIMEOUT_SECONDS,
    allowed_updates: TELEGRAM_ALLOWED_UPDATES,
  };
}

export function getLatestTelegramUpdateId(
  updates: readonly TelegramUpdate[],
): number | undefined {
  return updates.at(-1)?.update_id;
}

export class TelegramPersistentGetUpdatesConflictError extends Error {
  readonly count: number;
  constructor(count: number) {
    super(`Telegram polling stopped after ${count} consecutive getUpdates conflicts.`);
    this.name = "TelegramPersistentGetUpdatesConflictError";
    this.count = count;
  }
}

export class TelegramGetUpdatesTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Telegram getUpdates timed out after ${timeoutMs} ms.`);
    this.name = "TelegramGetUpdatesTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function getTelegramGetUpdatesRequestBudgetMs(
  body: Record<string, unknown>,
  graceMs = TELEGRAM_GET_UPDATES_GRACE_MS,
): number {
  const timeoutSeconds =
    typeof body.timeout === "number" &&
    Number.isFinite(body.timeout) &&
    body.timeout >= 0
      ? body.timeout
      : 0;
  const normalizedGraceMs =
    Number.isFinite(graceMs) && graceMs > 0
      ? Math.floor(graceMs)
      : TELEGRAM_GET_UPDATES_GRACE_MS;
  return Math.floor(timeoutSeconds * 1_000) + normalizedGraceMs;
}

export function shouldStopTelegramPolling(
  signalAborted: boolean,
  error: unknown,
): boolean {
  return (
    signalAborted ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

export interface TelegramPollingStartState {
  hasBotToken: boolean;
  hasPollingPromise: boolean;
}

export type TelegramPollingWorkPhase =
  | "long-poll"
  | "persisting-journal"
  | "persisting-offset"
  | "retrying";

export type TelegramPollingPhase =
  | "stopped"
  | "starting"
  | TelegramPollingWorkPhase;

export type TelegramPollingStopReason =
  | "not-started"
  | "requested"
  | "completed"
  | "failed"
  | "persistent-conflict";

export interface TelegramPollingStateSnapshot {
  phase: TelegramPollingPhase;
  phaseStartedAtMs?: number;
  currentUpdateId?: number;
  startedAtMs?: number;
  stoppedAtMs?: number;
  lastSuccessfulResponseAtMs?: number;
  lastSuccessfulResponseUpdateCount?: number;
  stopReason?: TelegramPollingStopReason;
}

export interface TelegramPollingControllerState
  extends TelegramPollingStateSnapshot {
  pollingPromise?: Promise<void>;
  pollingController?: AbortController;
}

export function createTelegramPollingControllerState(): TelegramPollingControllerState {
  return {
    phase: "stopped",
    stopReason: "not-started",
  };
}

export function getTelegramPollingStateSnapshot(
  state: TelegramPollingControllerState,
): TelegramPollingStateSnapshot {
  return {
    phase: state.phase,
    phaseStartedAtMs: state.phaseStartedAtMs,
    currentUpdateId: state.currentUpdateId,
    startedAtMs: state.startedAtMs,
    stoppedAtMs: state.stoppedAtMs,
    lastSuccessfulResponseAtMs: state.lastSuccessfulResponseAtMs,
    lastSuccessfulResponseUpdateCount:
      state.lastSuccessfulResponseUpdateCount,
    stopReason: state.stopReason,
  };
}

export function createTelegramPollingStateReader(
  state: TelegramPollingControllerState,
): () => TelegramPollingStateSnapshot {
  return () => getTelegramPollingStateSnapshot(state);
}

export function isTelegramPollingControllerActive(
  state: TelegramPollingControllerState,
): boolean {
  return !!state.pollingPromise;
}

export function createTelegramPollingActivityReader(
  state: TelegramPollingControllerState,
): () => boolean {
  return () => isTelegramPollingControllerActive(state);
}

export interface TelegramPollingRuntimeDeps<
  TContext,
> extends TelegramRuntimeEventRecorderPort {
  hasBotToken: () => boolean;
  getPollingPromise: () => Promise<void> | undefined;
  setPollingPromise: (promise: Promise<void> | undefined) => void;
  getPollingController: () => AbortController | undefined;
  setPollingController: (controller: AbortController | undefined) => void;
  stopTypingLoop: () => unknown;
  runPollLoop: (ctx: TContext, signal: AbortSignal) => Promise<void>;
  updateStatus: (ctx: TContext, message?: string) => void;
  createAbortController?: () => AbortController;
  getNowMs?: () => number;
  onPollingStateChange?: () => void;
  onPersistentConflict?: (ctx: TContext, count: number) => MaybePromise<void>;
  onPollingStarted?: () => void;
  onPollingStopped?: (reason: TelegramPollingStopReason) => void;
}

export type TelegramPollingControllerDeps<TContext> = Omit<
  TelegramPollingRuntimeDeps<TContext>,
  | "getPollingPromise"
  | "setPollingPromise"
  | "getPollingController"
  | "setPollingController"
> & { state?: TelegramPollingControllerState };

export interface TelegramPollingController<TContext> {
  isActive: () => boolean;
  start: (ctx: TContext) => void;
  stop: () => Promise<void>;
}

export interface TelegramPollingAdmissionRuntime<TContext> {
  isActive: () => boolean;
  start: (ctx: TContext) => Promise<void>;
  stop: () => Promise<void>;
}

export function createTelegramPollingAdmissionRuntime<TContext>(deps: {
  polling: TelegramPollingController<TContext>;
  prepareStart?: () => MaybePromise<void>;
  canStart?: (ctx: TContext) => boolean;
  validateStart?: () => void;
  worker: {
    onSessionStart: (ctx: TContext) => Promise<void>;
  };
}): TelegramPollingAdmissionRuntime<TContext> {
  let generation = 0;
  return {
    isActive: deps.polling.isActive,
    async start(ctx) {
      if (!(deps.canStart?.(ctx) ?? true)) return;
      const expectedGeneration = ++generation;
      const isCurrent = () => expectedGeneration === generation && (deps.canStart?.(ctx) ?? true);
      if (!isCurrent()) return;
      await deps.prepareStart?.();
      if (!isCurrent()) return;
      deps.validateStart?.();
      await deps.worker.onSessionStart(ctx);
      if (!isCurrent()) return;
      deps.polling.start(ctx);
    },
    async stop() {
      generation += 1;
      await deps.polling.stop();
    },
  };
}

export interface TelegramDurablePollingRuntimeAssembly<TContext> {
  controller: TelegramPollingController<TContext>;
  admission: TelegramPollingAdmissionRuntime<TContext>;
}

export type TelegramDurablePollingRuntimeAssemblyDeps<
  TUpdate extends TelegramUpdate,
  TContext,
> = Omit<
  TelegramPollingControllerRuntimeDeps<TUpdate, TContext>,
  "appendUpdateBatch" | "getJournalEntryCount" | "signalUpdateWorker"
> & {
  canStart?: (ctx: TContext) => boolean;
  prepareUpdateBatch?: (updates: readonly TUpdate[]) => void;
  journal: {
    appendBatch: (
      updates: readonly TUpdate[],
      acceptedThroughUpdateId?: number,
    ) => { nonExcludedUpdateIds: readonly number[] };
    getAcceptedThroughUpdateId: () => number | undefined;
    prepareCursorCutover?: () => MaybePromise<void>;
    getEntryCount: () => number;
    signalWorker: () => void;
    getBootstrapEntryCount: () => number;
    onSessionStart: (ctx: TContext) => Promise<void>;
  };
};

/** Own journal-first polling assembly and cursor bootstrap validation. */
export function createTelegramDurablePollingRuntimeAssembly<
  TUpdate extends TelegramUpdate,
  TContext,
>(
  deps: TelegramDurablePollingRuntimeAssemblyDeps<TUpdate, TContext>,
): TelegramDurablePollingRuntimeAssembly<TContext> {
  const controller = createTelegramPollingControllerRuntime({
    ...deps,
    appendUpdateBatch(updates, cursor) {
      const result = deps.journal.appendBatch(updates, cursor);
      if (!deps.prepareUpdateBatch) return result;
      // No await: an already-draining worker must not observe the new batch before preparation.
      try {
        const included = new Set(result.nonExcludedUpdateIds);
        let batch: TUpdate[] = [];
        for (const update of updates) {
          if (included.has(update.update_id)) batch.push(update);
          else if (batch.length > 0) {
            deps.prepareUpdateBatch(batch);
            batch = [];
          }
        }
        if (batch.length > 0) deps.prepareUpdateBatch(batch);
      } catch (error) {
        try {
          deps.recordRuntimeEvent?.("polling", error, { phase: "batch-preparation", updateCount: updates.length });
        } catch {
          // Already-published input must still reach the worker if diagnostics fail.
        }
      }
      return result;
    },
    getAcceptedThroughUpdateId: deps.journal.getAcceptedThroughUpdateId,
    getJournalEntryCount: deps.journal.getEntryCount,
    signalUpdateWorker: deps.journal.signalWorker,
  });
  const admission = createTelegramPollingAdmissionRuntime({
    polling: controller,
    prepareStart: deps.journal.prepareCursorCutover,
    canStart: deps.canStart,
    validateStart() {
      if (deps.journal.getAcceptedThroughUpdateId() !== undefined) return;
      if (deps.journal.getBootstrapEntryCount() === 0) return;
      throw new TelegramPollingCursorBootstrapError(
        "Telegram polling cursor is missing while the durable update journal is non-empty.",
      );
    },
    worker: deps.journal,
  });
  return { controller, admission };
}

export type TelegramPollingControllerRuntimeDeps<
  TUpdate extends TelegramUpdate,
  TContext = unknown,
> = Omit<
  TelegramPollLoopRunnerDeps<TUpdate, TContext>,
  "onPhaseChange" | "onSuccessfulResponse"
> & {
  state?: TelegramPollingControllerState;
  hasBotToken: () => boolean;
  stopTypingLoop: () => unknown;
  createAbortController?: () => AbortController;
  getNowMs?: () => number;
  onPollingStateChange?: () => void;
  onPersistentConflict?: (ctx: TContext, count: number) => MaybePromise<void>;
};

function notifyTelegramPollingStateChange(
  deps: Pick<
    TelegramPollingRuntimeDeps<unknown>,
    "onPollingStateChange" | "recordRuntimeEvent"
  >,
): void {
  try {
    deps.onPollingStateChange?.();
  } catch (error) {
    deps.recordRuntimeEvent?.("polling", error, {
      phase: "state-observer",
    });
  }
}

function transitionTelegramPollingState(
  state: TelegramPollingControllerState,
  phase: TelegramPollingPhase,
  nowMs: number,
  currentUpdateId?: number,
): void {
  state.phase = phase;
  state.phaseStartedAtMs = nowMs;
  state.currentUpdateId = currentUpdateId;
}

export function createTelegramPollingControllerRuntime<
  TUpdate extends TelegramUpdate,
  TContext = unknown,
>(
  deps: TelegramPollingControllerRuntimeDeps<TUpdate, TContext>,
): TelegramPollingController<TContext> {
  const state = deps.state ?? createTelegramPollingControllerState();
  const getNowMs = deps.getNowMs ?? Date.now;
  const notifyStateChange = () =>
    notifyTelegramPollingStateChange({
      onPollingStateChange: deps.onPollingStateChange,
      recordRuntimeEvent: deps.recordRuntimeEvent,
    });
  return createTelegramPollingController({
    state,
    hasBotToken: deps.hasBotToken,
    stopTypingLoop: deps.stopTypingLoop,
    runPollLoop: createTelegramPollLoopRunner<TUpdate, TContext>({
      getConfig: deps.getConfig,
      deleteWebhook: deps.deleteWebhook,
      getUpdates: deps.getUpdates,
      getUpdatesRequestBudgetMs: deps.getUpdatesRequestBudgetMs,
      persistConfig: deps.persistConfig,
      appendUpdateBatch: deps.appendUpdateBatch,
      getAcceptedThroughUpdateId: deps.getAcceptedThroughUpdateId,
      getJournalEntryCount: deps.getJournalEntryCount,
      signalUpdateWorker: deps.signalUpdateWorker,
      updateStatus: deps.updateStatus,
      sleep: deps.sleep,
      onPhaseChange(phase, currentUpdateId) {
        transitionTelegramPollingState(
          state,
          phase,
          getNowMs(),
          currentUpdateId,
        );
        notifyStateChange();
      },
      onSuccessfulResponse(updateCount) {
        state.lastSuccessfulResponseAtMs = getNowMs();
        state.lastSuccessfulResponseUpdateCount = updateCount;
        notifyStateChange();
      },
      recordRuntimeEvent: deps.recordRuntimeEvent,
    }),
    updateStatus: deps.updateStatus,
    createAbortController: deps.createAbortController,
    getNowMs,
    onPollingStateChange: deps.onPollingStateChange,
    onPersistentConflict: deps.onPersistentConflict,
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
}

export function createTelegramPollingController<TContext>(
  deps: TelegramPollingControllerDeps<TContext>,
): TelegramPollingController<TContext> {
  const state = deps.state ?? createTelegramPollingControllerState();
  const getNowMs = deps.getNowMs ?? Date.now;
  const notifyStateChange = () =>
    notifyTelegramPollingStateChange({
      onPollingStateChange: deps.onPollingStateChange,
      recordRuntimeEvent: deps.recordRuntimeEvent,
    });
  const runtimeDeps: TelegramPollingRuntimeDeps<TContext> = {
    ...deps,
    getPollingPromise: () => state.pollingPromise,
    setPollingPromise: (promise) => {
      state.pollingPromise = promise;
    },
    getPollingController: () => state.pollingController,
    setPollingController: (controller) => {
      state.pollingController = controller;
    },
    onPollingStarted: () => {
      const nowMs = getNowMs();
      transitionTelegramPollingState(state, "starting", nowMs);
      state.startedAtMs = nowMs;
      state.stoppedAtMs = undefined;
      state.lastSuccessfulResponseAtMs = undefined;
      state.lastSuccessfulResponseUpdateCount = undefined;
      state.stopReason = undefined;
      notifyStateChange();
      deps.onPollingStarted?.();
    },
    onPollingStopped: (reason) => {
      const nowMs = getNowMs();
      transitionTelegramPollingState(state, "stopped", nowMs);
      state.stoppedAtMs = nowMs;
      state.stopReason = reason;
      notifyStateChange();
      deps.onPollingStopped?.(reason);
    },
  };
  return {
    isActive: () => isTelegramPollingControllerActive(state),
    start: (ctx) => startTelegramPollingRuntime(ctx, runtimeDeps),
    stop: () => stopTelegramPollingRuntime(runtimeDeps),
  };
}

export function shouldStartTelegramPolling(
  state: TelegramPollingStartState,
): boolean {
  return state.hasBotToken && !state.hasPollingPromise;
}

export async function stopTelegramPollingRuntime<TContext>(
  deps: TelegramPollingRuntimeDeps<TContext>,
): Promise<void> {
  const pollingPromise = deps.getPollingPromise();
  const pollingController = deps.getPollingController();
  try {
    deps.stopTypingLoop();
  } catch (error) {
    deps.recordRuntimeEvent?.("polling", error, { phase: "typing-stop" });
  }
  pollingController?.abort();
  await pollingPromise?.catch(() => undefined);
  let cleared = false;
  if (deps.getPollingPromise() === pollingPromise) {
    deps.setPollingPromise(undefined);
    cleared = pollingPromise !== undefined;
  }
  if (deps.getPollingController() === pollingController) {
    deps.setPollingController(undefined);
    cleared = cleared || pollingController !== undefined;
  }
  if (cleared) deps.onPollingStopped?.("requested");
}

function updateTelegramPollingStatusSafely<TContext>(
  updateStatus: (ctx: TContext, message?: string) => void,
  ctx: TContext,
  options: {
    message?: string;
    recordRuntimeEvent?: TelegramRuntimeEventRecorderPort["recordRuntimeEvent"];
  } = {},
): void {
  try {
    updateStatus(ctx, options.message);
  } catch (error) {
    // The polling loop can outlive the session context it captured.
    options.recordRuntimeEvent?.("polling", error, { phase: "status-update" });
  }
}

export function startTelegramPollingRuntime<TContext>(
  ctx: TContext,
  deps: TelegramPollingRuntimeDeps<TContext>,
): void {
  if (
    !shouldStartTelegramPolling({
      hasBotToken: deps.hasBotToken(),
      hasPollingPromise: !!deps.getPollingPromise(),
    })
  ) {
    return;
  }
  const controller = deps.createAbortController?.() ?? new AbortController();
  deps.setPollingController(controller);
  deps.onPollingStarted?.();
  let failed = false;
  let persistentConflict: TelegramPersistentGetUpdatesConflictError | undefined;
  let runPromise: Promise<void>;
  try {
    runPromise = deps.runPollLoop(ctx, controller.signal);
  } catch (error) {
    runPromise = Promise.reject(error);
  }
  let promise: Promise<void>;
  promise = runPromise
    .catch((error) => {
      if (shouldStopTelegramPolling(controller.signal.aborted, error)) return;
      if (error instanceof TelegramPersistentGetUpdatesConflictError) {
        persistentConflict = error;
        return;
      }
      failed = true;
      deps.recordRuntimeEvent?.("polling", error, {
        phase: "controller",
      });
    })
    .finally(async () => {
      const ownsPromise = deps.getPollingPromise() === promise;
      const ownsController = deps.getPollingController() === controller;
      if (ownsPromise) deps.setPollingPromise(undefined);
      if (ownsController) deps.setPollingController(undefined);
      if (!ownsPromise && !ownsController) return;
      deps.onPollingStopped?.(
        controller.signal.aborted ? "requested" : persistentConflict
          ? "persistent-conflict" : failed ? "failed" : "completed",
      );
      // Detach the inner promise before outer teardown calls polling.stop().
      if (persistentConflict && !controller.signal.aborted) {
        try {
          if (deps.onPersistentConflict) {
            await deps.onPersistentConflict(ctx, persistentConflict.count);
          } else {
            deps.stopTypingLoop();
            deps.recordRuntimeEvent?.("polling", persistentConflict, {
              phase: "persistent-conflict", count: persistentConflict.count,
            });
          }
        } catch (error) {
          deps.recordRuntimeEvent?.("polling", error, { phase: "conflict-stand-down" });
        }
        if (deps.getPollingController() || deps.getPollingPromise()) return;
      }
      updateTelegramPollingStatusSafely(deps.updateStatus, ctx, {
        recordRuntimeEvent: deps.recordRuntimeEvent,
      });
    });
  deps.setPollingPromise(promise);
  updateTelegramPollingStatusSafely(deps.updateStatus, ctx, {
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
}

export interface TelegramRuntimeEventRecorderPort {
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export type TelegramThreadCapabilityMode = "enabled" | "disabled" | "unknown";

export interface TelegramThreadCapabilityState {
  threadMode?: TelegramThreadCapabilityMode;
  updatedAtMs?: number;
  lastSlot?: string;
  lastReconcileAction?: string;
}

export interface TelegramThreadCapabilityRecordView {
  status?: string;
  target?: { chatId?: number; threadId?: number };
}

export interface TelegramThreadCapabilityStore {
  load: () => Promise<void>;
  refresh?: () => Promise<void>;
  persist: () => Promise<void>;
  getBotState: () => TelegramThreadCapabilityState;
  setBotState: (state: TelegramThreadCapabilityState) => void;
  list?: () => TelegramThreadCapabilityRecordView[];
}

export interface TelegramThreadCapabilityReaderDeps {
  getAllowedUserId: () => number | undefined;
  callApi: <TResponse>(
    method: string,
    body: Record<string, unknown>,
  ) => Promise<TResponse>;
}

interface TelegramThreadCapabilityLifecycle {
  capture: () => () => boolean;
  invalidate: () => void;
}

export interface TelegramStartupThreadCapabilityProbeDeps extends TelegramThreadCapabilityReaderDeps {
  topicTargetStore: TelegramThreadCapabilityStore;
  recordEvent: (
    category: string,
    message: unknown,
    details?: Record<string, unknown>,
  ) => void;
  setTopicModeUnavailable: (unavailable: boolean) => void;
  getNowMs?: () => number;
}

export interface TelegramThreadCapabilityRuntimeDeps<
  TContext,
> extends TelegramThreadCapabilityReaderDeps {
  lifecycle?: TelegramThreadCapabilityLifecycle;
  topicTargetStore: TelegramThreadCapabilityStore;
  ownsLock: (ctx: TContext) => boolean;
  isFollowerRegistered?: () => boolean;
  getPollingStartedWithTelegramBus: () => boolean;
  setPollingStartedWithTelegramBus: (started: boolean) => void;
  setTopicModeUnavailable: (unavailable: boolean) => void;
  suspendLiveThreadTarget?: () => void;
  stopFollowerRegistration: () => void;
  startClassicPolling: (ctx: TContext) => MaybePromise<void>;
  stopClassicPolling: () => MaybePromise<void>;
  startBusPolling: (ctx: TContext) => MaybePromise<void>;
  stopBusPolling: () => MaybePromise<void>;
  startLeaderHealth: () => void;
  stopLeaderHealth: () => void;
  isTopicModeUnavailableError?: (error: unknown) => boolean;
  updateStatus: (ctx: TContext) => void;
  recordEvent: (
    category: string,
    message: unknown,
    details?: Record<string, unknown>,
  ) => void;
  getNowMs?: () => number;
  intervalMs?: number;
}

export interface TelegramThreadCapabilityMonitor<TContext> {
  start: (ctx: TContext) => void;
  stop: () => void;
}

export interface TelegramThreadCapabilityStateRuntime {
  isBusPollingStarted(): boolean;
  setBusPollingStarted(started: boolean): void;
  isTopicModeUnavailable(): boolean;
  setTopicModeUnavailable(unavailable: boolean): void;
  isBusRuntimeEnabled(): boolean;
  shouldForceFreshLeaderThread(): boolean;
  setForceFreshLeaderThread(forceFresh: boolean): void;
  getRequestedThreadName(): string | undefined;
  setRequestedThreadName(threadName: string | undefined): void;
}

export type TelegramThreadTargetObservationHandler<TContext> = (
  ctx: TContext,
) => Promise<void>;

export interface TelegramThreadTargetObservationBinding<TContext> {
  handle: TelegramThreadTargetObservationHandler<TContext>;
  set(handler: TelegramThreadTargetObservationHandler<TContext>): void;
}

export function createTelegramThreadTargetObservationBinding<TContext>(): TelegramThreadTargetObservationBinding<TContext> {
  let handler: TelegramThreadTargetObservationHandler<TContext> | undefined;
  return {
    async handle(ctx) {
      await handler?.(ctx);
    },
    set(nextHandler) {
      handler = nextHandler;
    },
  };
}

export interface TelegramThreadAwarePollingPorts<TContext, TOwner> {
  startPolling: (
    ctx: TContext,
    options?: { forceFreshLeaderThread?: boolean },
  ) => Promise<void>;
  stopPolling: () => Promise<void>;
  registerFollowerWithOwner: (
    ctx: TContext,
    owner: TOwner,
  ) => Promise<boolean | undefined>;
  restoreFollowerWithOwner: (
    ctx: TContext,
    owner: TOwner,
  ) => Promise<boolean | undefined>;
  stopFollowerRegistration: () => void;
}

export interface TelegramThreadAwarePollingDeps<
  TContext,
  TOwner,
> extends TelegramStartupThreadCapabilityProbeDeps {
  lifecycle?: TelegramThreadCapabilityLifecycle;
  isBusRuntimeEnabled: () => boolean;
  isTopicModeUnavailableError: (error: unknown) => boolean;
  getPollingStartedWithTelegramBus: () => boolean;
  setPollingStartedWithTelegramBus: (started: boolean) => void;
  setForceFreshLeaderThreadOnNextStart: (forceFresh: boolean) => void;
  startClassicPolling: (ctx: TContext) => MaybePromise<void>;
  stopClassicPolling: () => Promise<void>;
  startBusLeaderPolling: (ctx: TContext) => Promise<void>;
  stopBusLeaderPolling: () => Promise<void>;
  startLeaderHealth: () => void;
  stopLeaderHealth: () => void;
  registerFollowerWithLeader: (
    ctx: TContext,
    owner: TOwner,
  ) => Promise<boolean | undefined>;
  restoreFollowerWithLeader?: (
    ctx: TContext,
    owner: TOwner,
  ) => Promise<boolean | undefined>;
  hasRememberedWorkspaceBinding?: (ctx: TContext) => boolean;
  stopFollowerRegistration: () => void;
}

export interface TelegramThreadCapabilityOrchestrationDeps<
  TContext,
  TOwner,
> extends TelegramThreadCapabilityReaderDeps {
  state: TelegramThreadCapabilityStateRuntime;
  topicTargetStore: TelegramThreadCapabilityStore;
  isBusRuntimeEnabled: () => boolean;
  ownsLock: (ctx: TContext) => boolean;
  isFollowerRegistered?: () => boolean;
  startClassicPolling: (ctx: TContext) => MaybePromise<void>;
  stopClassicPolling: () => Promise<void>;
  startBusLeaderPolling: (ctx: TContext) => Promise<void>;
  stopBusLeaderPolling: () => Promise<void>;
  startLeaderHealth: () => void;
  stopLeaderHealth: () => void;
  registerFollowerWithLeader: (
    ctx: TContext,
    owner: TOwner,
  ) => Promise<boolean | undefined>;
  restoreFollowerWithLeader?: (
    ctx: TContext,
    owner: TOwner,
  ) => Promise<boolean | undefined>;
  hasRememberedWorkspaceBinding?: (ctx: TContext) => boolean;
  suspendLiveThreadTarget?: () => void;
  stopFollowerRegistration: () => void;
  isTopicModeUnavailableError: (error: unknown) => boolean;
  updateStatus: (ctx: TContext) => void;
  recordEvent: (
    category: string,
    message: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramThreadCapabilityOrchestration<TContext, TOwner> {
  monitor: TelegramThreadCapabilityMonitor<TContext>;
  observeTarget: TelegramThreadTargetObservationHandler<TContext>;
  pollingPorts: TelegramThreadAwarePollingPorts<TContext, TOwner>;
}

export function createTelegramThreadCapabilityStateRuntime(): TelegramThreadCapabilityStateRuntime {
  let busPollingStarted = false;
  let topicModeUnavailable = false;
  let forceFreshLeaderThread = false;
  let requestedThreadName: string | undefined;
  return {
    isBusPollingStarted: () => busPollingStarted,
    setBusPollingStarted(started) {
      busPollingStarted = started;
    },
    isTopicModeUnavailable: () => topicModeUnavailable,
    setTopicModeUnavailable(unavailable) {
      topicModeUnavailable = unavailable;
    },
    isBusRuntimeEnabled: () => !topicModeUnavailable,
    shouldForceFreshLeaderThread: () => forceFreshLeaderThread,
    setForceFreshLeaderThread(forceFresh) {
      forceFreshLeaderThread = forceFresh;
    },
    getRequestedThreadName: () => requestedThreadName,
    setRequestedThreadName(threadName) {
      requestedThreadName = threadName;
    },
  };
}

export function createTelegramThreadCapabilityOrchestration<TContext, TOwner>(
  deps: TelegramThreadCapabilityOrchestrationDeps<TContext, TOwner>,
): TelegramThreadCapabilityOrchestration<TContext, TOwner> {
  let generation = 0;
  const lifecycle: TelegramThreadCapabilityLifecycle = {
    capture() {
      const expected = generation;
      return () => expected === generation;
    },
    invalidate() { generation++; },
  };
  const capabilityDeps: TelegramThreadCapabilityRuntimeDeps<TContext> = {
    lifecycle,
    getAllowedUserId: deps.getAllowedUserId,
    callApi: deps.callApi,
    topicTargetStore: deps.topicTargetStore,
    ownsLock: deps.ownsLock,
    isFollowerRegistered: deps.isFollowerRegistered,
    getPollingStartedWithTelegramBus: deps.state.isBusPollingStarted,
    setPollingStartedWithTelegramBus: deps.state.setBusPollingStarted,
    setTopicModeUnavailable: deps.state.setTopicModeUnavailable,
    suspendLiveThreadTarget: deps.suspendLiveThreadTarget,
    stopFollowerRegistration: deps.stopFollowerRegistration,
    startClassicPolling: deps.startClassicPolling,
    stopClassicPolling: deps.stopClassicPolling,
    startBusPolling: deps.startBusLeaderPolling,
    stopBusPolling: deps.stopBusLeaderPolling,
    startLeaderHealth: deps.startLeaderHealth,
    stopLeaderHealth: deps.stopLeaderHealth,
    isTopicModeUnavailableError: deps.isTopicModeUnavailableError,
    updateStatus: deps.updateStatus,
    recordEvent: deps.recordEvent,
  };
  return {
    monitor: createTelegramThreadCapabilityMonitor(capabilityDeps),
    observeTarget: createTelegramThreadTargetObservationHandler(capabilityDeps),
    pollingPorts: createTelegramThreadAwarePollingPorts({
      lifecycle,
      getAllowedUserId: deps.getAllowedUserId,
      callApi: deps.callApi,
      topicTargetStore: deps.topicTargetStore,
      isBusRuntimeEnabled: deps.isBusRuntimeEnabled,
      isTopicModeUnavailableError: deps.isTopicModeUnavailableError,
      getPollingStartedWithTelegramBus: deps.state.isBusPollingStarted,
      setPollingStartedWithTelegramBus: deps.state.setBusPollingStarted,
      setForceFreshLeaderThreadOnNextStart:
        deps.state.setForceFreshLeaderThread,
      startClassicPolling: deps.startClassicPolling,
      stopClassicPolling: deps.stopClassicPolling,
      startBusLeaderPolling: deps.startBusLeaderPolling,
      stopBusLeaderPolling: deps.stopBusLeaderPolling,
      startLeaderHealth: deps.startLeaderHealth,
      stopLeaderHealth: deps.stopLeaderHealth,
      registerFollowerWithLeader: deps.registerFollowerWithLeader,
      restoreFollowerWithLeader: deps.restoreFollowerWithLeader,
      hasRememberedWorkspaceBinding: deps.hasRememberedWorkspaceBinding,
      stopFollowerRegistration: deps.stopFollowerRegistration,
      recordEvent: deps.recordEvent,
      setTopicModeUnavailable: deps.state.setTopicModeUnavailable,
    }),
  };
}

export async function readTelegramThreadCapability(
  deps: TelegramThreadCapabilityReaderDeps,
): Promise<boolean | undefined> {
  const bot = await deps.callApi<{ has_topics_enabled?: boolean }>("getMe", {});
  if (bot.has_topics_enabled === true) return true;
  if (bot.has_topics_enabled === false) return false;
  return undefined;
}

export async function probeTelegramStartupThreadCapability(
  deps: TelegramStartupThreadCapabilityProbeDeps,
  isCurrent: () => boolean = () => true,
): Promise<boolean | undefined> {
  if (!isCurrent()) return;
  const threadModeEnabled = await readTelegramThreadCapability(deps);
  if (!isCurrent()) return;
  const nowMs = (deps.getNowMs ?? Date.now)();
  if (threadModeEnabled === false) {
    deps.topicTargetStore.setBotState({
      threadMode: "disabled",
      updatedAtMs: nowMs,
      lastReconcileAction: "startup-bot-topics-disabled",
    });
    await deps.topicTargetStore.persist();
    if (!isCurrent()) return;
    deps.recordEvent("bus", "Telegram Threaded Mode unavailable on startup", {
      phase: "startup-bot-topics-disabled",
    });
    deps.setTopicModeUnavailable(true);
    return threadModeEnabled;
  }
  if (threadModeEnabled === true) {
    deps.topicTargetStore.setBotState({
      ...deps.topicTargetStore.getBotState(),
      threadMode: "enabled",
      updatedAtMs: nowMs,
      lastReconcileAction: "startup-bot-topics-enabled",
    });
    await deps.topicTargetStore.persist();
    if (!isCurrent()) return;
    deps.setTopicModeUnavailable(false);
  }
  return threadModeEnabled;
}

function hasTelegramClassicRestoreFailure(
  state: TelegramThreadCapabilityState,
): boolean {
  return (
    state.lastReconcileAction?.endsWith("-classic-restore-failed") ?? false
  );
}

function hasTelegramThreadCapabilityBindings(
  store: TelegramThreadCapabilityStore,
): boolean {
  return (
    store.list?.().some((record) => {
      return (
        typeof record.target?.chatId === "number" &&
        typeof record.target.threadId === "number" &&
        record.status !== "deleted" &&
        record.status !== "offline" &&
        record.status !== "stale"
      );
    }) ?? false
  );
}

export async function applyTelegramThreadCapability<TContext>(
  ctx: TContext,
  threadModeEnabled: boolean,
  phase: string,
  deps: TelegramThreadCapabilityRuntimeDeps<TContext>,
  isCurrent: () => boolean = deps.lifecycle?.capture() ?? (() => true),
): Promise<void> {
  if (!isCurrent()) return;
  await deps.topicTargetStore.load();
  if (!isCurrent()) return;
  const nowMs = (deps.getNowMs ?? Date.now)();
  const previousBotState = deps.topicTargetStore.getBotState();
  if (!threadModeEnabled) {
    if (
      hasTelegramThreadCapabilityBindings(deps.topicTargetStore) &&
      !phase.endsWith("-confirmed")
    ) {
      deps.recordEvent("bus", "Telegram Threaded Mode probe deferred", {
        phase,
        reason: "active-thread-bindings-present",
      });
      return;
    }
    deps.topicTargetStore.setBotState({
      threadMode: "disabled",
      updatedAtMs: nowMs,
      lastReconcileAction: phase,
    });
    await deps.topicTargetStore.persist();
    if (!isCurrent()) return;
    deps.setTopicModeUnavailable(true);
    deps.stopFollowerRegistration();
    const hadLiveThreadTransport = deps.getPollingStartedWithTelegramBus();
    if (
      hadLiveThreadTransport ||
      hasTelegramClassicRestoreFailure(previousBotState)
    ) {
      deps.stopLeaderHealth();
      await deps.stopBusPolling();
      if (!isCurrent()) return;
      deps.setPollingStartedWithTelegramBus(false);
      if (hadLiveThreadTransport) deps.suspendLiveThreadTarget?.();
      try {
        await deps.startClassicPolling(ctx);
        if (!isCurrent()) return;
      } catch (classicError) {
        if (!isCurrent()) return;
        deps.topicTargetStore.setBotState({
          threadMode: "disabled",
          updatedAtMs: (deps.getNowMs ?? Date.now)(),
          lastReconcileAction: `${phase}-classic-restore-failed`,
        });
        await deps.topicTargetStore.persist();
        if (!isCurrent()) return;
        deps.recordEvent("bus", classicError, {
          phase: `${phase}-classic-restore`,
        });
      }
    }
    deps.updateStatus(ctx);
    return;
  }
  deps.topicTargetStore.setBotState({
    ...deps.topicTargetStore.getBotState(),
    threadMode: "enabled",
    updatedAtMs: nowMs,
    lastReconcileAction: phase,
  });
  await deps.topicTargetStore.persist();
  if (!isCurrent()) return;
  deps.setTopicModeUnavailable(false);
  if (!deps.getPollingStartedWithTelegramBus() && deps.ownsLock(ctx)) {
    await deps.stopClassicPolling();
    if (!isCurrent()) return;
    deps.setPollingStartedWithTelegramBus(true);
    try {
      await deps.startBusPolling(ctx);
      if (!isCurrent()) return;
      deps.startLeaderHealth();
    } catch (error) {
      if (!isCurrent()) return;
      deps.setPollingStartedWithTelegramBus(false);
      const threadModeUnavailable =
        deps.isTopicModeUnavailableError?.(error) === true;
      if (threadModeUnavailable) {
        deps.topicTargetStore.setBotState({
          threadMode: "disabled",
          updatedAtMs: nowMs,
          lastReconcileAction: `${phase}-unavailable`,
        });
        await deps.topicTargetStore.persist();
        if (!isCurrent()) return;
        deps.setTopicModeUnavailable(true);
      }
      try {
        await deps.startClassicPolling(ctx);
        if (!isCurrent()) return;
      } catch (classicError) {
        if (!isCurrent()) return;
        deps.topicTargetStore.setBotState({
          threadMode: "disabled",
          updatedAtMs: (deps.getNowMs ?? Date.now)(),
          lastReconcileAction: `${phase}-classic-restore-failed`,
        });
        await deps.topicTargetStore.persist();
        if (!isCurrent()) return;
        deps.recordEvent("bus", classicError, {
          phase: `${phase}-classic-restore`,
        });
      }
      deps.updateStatus(ctx);
      if (threadModeUnavailable) return;
      throw error;
    }
  }
  deps.updateStatus(ctx);
}

export function createTelegramThreadAwarePollingPorts<TContext, TOwner>(
  deps: TelegramThreadAwarePollingDeps<TContext, TOwner>,
): TelegramThreadAwarePollingPorts<TContext, TOwner> {
  let generation = 0;
  const startPolling = async (
    ctx: TContext,
    options?: { forceFreshLeaderThread?: boolean },
  ): Promise<void> => {
    const expectedGeneration = ++generation;
    deps.lifecycle?.invalidate();
    const isLifecycleCurrent = deps.lifecycle?.capture() ?? (() => true);
    const isCurrent = () => expectedGeneration === generation && isLifecycleCurrent();
    await deps.topicTargetStore.load();
    if (!isCurrent()) return;
    let startupThreadCapability: boolean | undefined;
    try {
      startupThreadCapability = await probeTelegramStartupThreadCapability(deps, isCurrent);
    } catch (error) {
      if (!isCurrent()) return;
      deps.recordEvent("bus", error, { phase: "startup-thread-mode-probe" });
    }
    if (!isCurrent()) return;
    deps.setTopicModeUnavailable(startupThreadCapability !== true);
    if (deps.isBusRuntimeEnabled()) {
      deps.setTopicModeUnavailable(false);
      try {
        deps.setPollingStartedWithTelegramBus(true);
        deps.setForceFreshLeaderThreadOnNextStart(
          !!options?.forceFreshLeaderThread,
        );
        await deps.startBusLeaderPolling(ctx);
        if (!isCurrent()) return;
        deps.startLeaderHealth();
        return;
      } catch (error) {
        if (!isCurrent()) return;
        deps.setPollingStartedWithTelegramBus(false);
        if (!deps.isTopicModeUnavailableError(error)) throw error;
        deps.setTopicModeUnavailable(true);
        await deps.topicTargetStore.load();
        if (!isCurrent()) return;
        deps.topicTargetStore.setBotState({
          threadMode: "disabled",
          updatedAtMs: Date.now(),
          lastReconcileAction: "thread-mode-unavailable",
        });
        await deps.topicTargetStore.persist();
        if (!isCurrent()) return;
        deps.recordEvent("bus", error, { phase: "thread-mode-unavailable" });
      } finally {
        if (isCurrent()) deps.setForceFreshLeaderThreadOnNextStart(false);
      }
    }
    deps.setPollingStartedWithTelegramBus(false);
    await deps.startClassicPolling(ctx);
  };
  const stopPolling = async (): Promise<void> => {
    const expectedGeneration = ++generation;
    deps.lifecycle?.invalidate();
    deps.setForceFreshLeaderThreadOnNextStart(false);
    deps.stopLeaderHealth();
    if (deps.getPollingStartedWithTelegramBus()) {
      await deps.stopBusLeaderPolling();
      if (expectedGeneration === generation) deps.setPollingStartedWithTelegramBus(false);
      return;
    }
    await deps.stopClassicPolling();
  };
  const refreshFollowerState = async (): Promise<boolean> => {
    if (deps.topicTargetStore.refresh) {
      await deps.topicTargetStore.refresh();
    } else {
      await deps.topicTargetStore.load();
    }
    return deps.topicTargetStore.getBotState().threadMode === "enabled";
  };
  const registerFollowerWithOwner = async (
    ctx: TContext,
    owner: TOwner,
  ): Promise<boolean | undefined> => {
    if (!(await refreshFollowerState())) return undefined;
    return deps.registerFollowerWithLeader(ctx, owner);
  };
  const restoreFollowerWithOwner = async (
    ctx: TContext,
    owner: TOwner,
  ): Promise<boolean | undefined> => {
    if (!(await refreshFollowerState())) return undefined;
    if (!deps.hasRememberedWorkspaceBinding?.(ctx)) return undefined;
    return deps.restoreFollowerWithLeader?.(ctx, owner);
  };
  return {
    startPolling,
    stopPolling,
    registerFollowerWithOwner,
    restoreFollowerWithOwner,
    stopFollowerRegistration: deps.stopFollowerRegistration,
  };
}

export function createTelegramThreadTargetObservationHandler<TContext>(
  deps: TelegramThreadCapabilityRuntimeDeps<TContext>,
): TelegramThreadTargetObservationHandler<TContext> {
  let transitionPending = false;
  return async (ctx) => {
    if (transitionPending) return;
    if (deps.topicTargetStore.getBotState().threadMode === "enabled") return;
    transitionPending = true;
    const isCurrent = deps.lifecycle?.capture() ?? (() => true);
    try {
      await applyTelegramThreadCapability(
        ctx,
        true,
        "thread-target-observed",
        deps,
        isCurrent,
      );
    } catch (error) {
      if (!isCurrent()) return;
      deps.recordEvent("bus", error, { phase: "thread-target-observed" });
    } finally {
      transitionPending = false;
    }
  };
}

export function canProbeTelegramThreadCapability<TContext>(
  ctx: TContext,
  deps: Pick<
    TelegramThreadCapabilityRuntimeDeps<TContext>,
    "ownsLock" | "isFollowerRegistered"
  >,
): boolean {
  return deps.ownsLock(ctx) || deps.isFollowerRegistered?.() === true;
}

export function createTelegramThreadCapabilityMonitor<TContext>(
  deps: TelegramThreadCapabilityRuntimeDeps<TContext>,
): TelegramThreadCapabilityMonitor<TContext> {
  const intervalMs =
    deps.intervalMs ?? TELEGRAM_THREAD_CAPABILITY_MONITOR_INTERVAL_MS;
  let interval: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  let transitionPromise: Promise<void> | undefined;
  let consecutiveDisabledProbes = 0;
  const stop = (): void => {
    generation += 1;
    if (interval) clearInterval(interval);
    interval = undefined;
    deps.lifecycle?.invalidate();
  };
  const check = (ctx: TContext): void => {
    if (transitionPromise || !canProbeTelegramThreadCapability(ctx, deps)) {
      return;
    }
    const expectedGeneration = generation;
    const isLifecycleCurrent = deps.lifecycle?.capture() ?? (() => true);
    const isCurrent = (): boolean => generation === expectedGeneration && isLifecycleCurrent();
    let tracked: Promise<void>;
    tracked = readTelegramThreadCapability(deps)
      .then(async (threadModeEnabled) => {
        if (!isCurrent()) return;
        if (threadModeEnabled === undefined) {
          if (
            deps.topicTargetStore.getBotState().threadMode !== "enabled" &&
            !deps.getPollingStartedWithTelegramBus() &&
            deps.ownsLock(ctx)
          ) {
            await applyTelegramThreadCapability(
              ctx,
              true,
              "capability-monitor-retry",
              deps,
              isCurrent,
            );
          }
          return;
        }
        if (threadModeEnabled) consecutiveDisabledProbes = 0;
        const botState = deps.topicTargetStore.getBotState();
        const current = botState.threadMode;
        if (threadModeEnabled && current === "enabled") return;
        if (!threadModeEnabled && current === "disabled") {
          if (
            !deps.ownsLock(ctx) ||
            !hasTelegramClassicRestoreFailure(botState)
          ) {
            return;
          }
          await applyTelegramThreadCapability(
            ctx,
            false,
            "capability-monitor-disabled-confirmed",
            deps,
            isCurrent,
          );
          return;
        }
        if (
          !threadModeEnabled &&
          hasTelegramThreadCapabilityBindings(deps.topicTargetStore)
        ) {
          consecutiveDisabledProbes += 1;
          if (
            consecutiveDisabledProbes <
            TELEGRAM_THREAD_CAPABILITY_DISABLED_CONFIRMATION_PROBES
          ) {
            deps.recordEvent("bus", "Telegram Threaded Mode probe deferred", {
              phase: "capability-monitor-disabled",
              reason: "active-thread-bindings-present",
              consecutiveDisabledProbes,
            });
            return;
          }
        }
        await applyTelegramThreadCapability(
          ctx,
          threadModeEnabled,
          threadModeEnabled
            ? "capability-monitor-enabled"
            : consecutiveDisabledProbes >=
                TELEGRAM_THREAD_CAPABILITY_DISABLED_CONFIRMATION_PROBES
              ? "capability-monitor-disabled-confirmed"
              : "capability-monitor-disabled",
          deps,
          isCurrent,
        );
      })
      .catch((error) => {
        if (!isCurrent()) return;
        try {
          deps.recordEvent("bus", error, { phase: "capability-monitor" });
        } catch {
          // Monitor diagnostics cannot create an unhandled interval rejection.
        }
      })
      .finally(() => {
        if (transitionPromise === tracked) transitionPromise = undefined;
      });
    transitionPromise = tracked;
  };
  return {
    start(ctx) {
      stop();
      const expectedGeneration = generation;
      interval = setInterval(() => {
        if (generation !== expectedGeneration) return;
        try {
          check(ctx);
        } catch (error) {
          try { stop(); } catch { /* Timer shutdown must not escape the callback. */ }
          try {
            deps.recordEvent("bus", error, { phase: "capability-monitor" });
          } catch {
            // Monitor diagnostics cannot create an uncaught interval exception.
          }
        }
      }, intervalMs);
      interval.unref?.();
    },
    stop,
  };
}

export class TelegramPollingBatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramPollingBatchValidationError";
  }
}

export class TelegramPollingCursorBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramPollingCursorBootstrapError";
  }
}

export interface TelegramPollingCursorCutoverDeps {
  getLegacyCursor: () => number | undefined;
  readJournal: () => {
    acceptedThroughUpdateId?: number;
    entries: readonly { updateId: number }[];
  };
  publishJournalCursor: (acceptedThroughUpdateId: number) => MaybePromise<void>;
  removeLegacyCursor: () => MaybePromise<void>;
}

/** Transfer one legacy config cursor into journal authority before deleting it. */
export async function cutOverTelegramPollingCursor(
  deps: TelegramPollingCursorCutoverDeps,
): Promise<void> {
  const legacyCursor = deps.getLegacyCursor();
  if (legacyCursor === undefined) return;
  const snapshot = deps.readJournal();
  if (snapshot.acceptedThroughUpdateId === undefined) {
    const provenEntryCursor = snapshot.entries.at(-1)?.updateId;
    await deps.publishJournalCursor(
      Math.max(legacyCursor, provenEntryCursor ?? legacyCursor),
    );
  }
  await deps.removeLegacyCursor();
}

export interface TelegramPollingBatchAdmissionResult {
  updateCount: number;
  latestUpdateId?: number;
}

export interface TelegramPollingBatchAdmissionDeps<
  TUpdate extends TelegramUpdate,
> extends TelegramRuntimeEventRecorderPort {
  updates: readonly TUpdate[];
  config: TelegramPollingConfig;
  appendBatch: (
    updates: readonly TUpdate[],
    acceptedThroughUpdateId?: number,
  ) => MaybePromise<unknown>;
  getAcceptedThroughUpdateId?: () => number | undefined;
  persistConfig: (config: TelegramPollingConfig) => Promise<void>;
  signalWorker: () => void;
  onPhaseChange?: (
    phase: TelegramPollingWorkPhase,
    currentUpdateId?: number,
  ) => void;
}

function validateTelegramPollingBatch(
  updates: readonly TelegramUpdate[],
  lastUpdateId?: number,
): void {
  let previousUpdateId = lastUpdateId;
  for (const update of updates) {
    if (
      !Number.isSafeInteger(update.update_id) ||
      update.update_id < 0 ||
      (previousUpdateId !== undefined && update.update_id <= previousUpdateId)
    ) {
      throw new TelegramPollingBatchValidationError(
        `Telegram getUpdates returned non-monotonic update id ${String(update.update_id)} after ${String(previousUpdateId)}`,
      );
    }
    previousUpdateId = update.update_id;
  }
}

export async function admitTelegramPollingUpdateBatch<
  TUpdate extends TelegramUpdate,
>(
  deps: TelegramPollingBatchAdmissionDeps<TUpdate>,
): Promise<TelegramPollingBatchAdmissionResult> {
  if (deps.updates.length === 0) return { updateCount: 0 };
  const acceptedThroughUpdateId = deps.getAcceptedThroughUpdateId?.();
  validateTelegramPollingBatch(deps.updates, acceptedThroughUpdateId);
  const latestUpdateId = getLatestTelegramUpdateId(deps.updates);
  if (latestUpdateId === undefined) return { updateCount: 0 };
  reportTelegramPollingPhase(
    deps,
    "persisting-journal",
    deps.updates[0]?.update_id,
  );
  await deps.appendBatch(deps.updates, latestUpdateId);
  try {
    deps.signalWorker();
  } catch (error) {
    deps.recordRuntimeEvent?.("polling", error, {
      phase: "worker-signal",
      updateCount: deps.updates.length,
      latestUpdateId,
    });
  }
  return { updateCount: deps.updates.length, latestUpdateId };
}

export interface TelegramPollLoopDeps<
  TUpdate extends TelegramUpdate,
  TContext = unknown,
> extends TelegramRuntimeEventRecorderPort {
  ctx: TContext;
  signal: AbortSignal;
  config: TelegramPollingConfig;
  deleteWebhook: (signal: AbortSignal) => Promise<unknown>;
  getUpdates: (
    body: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<TUpdate[]>;
  getUpdatesRequestBudgetMs?: (body: Record<string, unknown>) => number;
  persistConfig: (config: TelegramPollingConfig) => Promise<void>;
  appendUpdateBatch: (
    updates: readonly TUpdate[],
    acceptedThroughUpdateId?: number,
  ) => MaybePromise<unknown>;
  getAcceptedThroughUpdateId?: () => number | undefined;
  getJournalEntryCount: () => number;
  signalUpdateWorker: () => void;
  onErrorStatus: (message: string) => void;
  onStatusReset: () => void;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  onPhaseChange?: (
    phase: TelegramPollingWorkPhase,
    currentUpdateId?: number,
  ) => void;
  onSuccessfulResponse?: (updateCount: number) => void;
}

export interface TelegramPollLoopRunnerDeps<
  TUpdate extends TelegramUpdate,
  TContext = unknown,
> extends TelegramRuntimeEventRecorderPort {
  getConfig: () => TelegramPollingConfig;
  deleteWebhook: (signal: AbortSignal) => Promise<unknown>;
  getUpdates: (
    body: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<TUpdate[]>;
  getUpdatesRequestBudgetMs?: (body: Record<string, unknown>) => number;
  persistConfig: (config: TelegramPollingConfig) => Promise<void>;
  appendUpdateBatch: (
    updates: readonly TUpdate[],
    acceptedThroughUpdateId?: number,
  ) => MaybePromise<unknown>;
  getAcceptedThroughUpdateId?: () => number | undefined;
  getJournalEntryCount: () => number;
  signalUpdateWorker: () => void;
  updateStatus: (ctx: TContext, message?: string) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onPhaseChange?: (
    phase: TelegramPollingWorkPhase,
    currentUpdateId?: number,
  ) => void;
  onSuccessfulResponse?: (updateCount: number) => void;
}

export function sleepTelegramPollingRetry(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      finish();
    };
    timer = setTimeout(finish, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function createTelegramPollLoopRunner<
  TUpdate extends TelegramUpdate,
  TContext = unknown,
>(
  deps: TelegramPollLoopRunnerDeps<TUpdate, TContext>,
): (ctx: TContext, signal: AbortSignal) => Promise<void> {
  const sleep = deps.sleep ?? sleepTelegramPollingRetry;
  return (ctx, signal) =>
    runTelegramPollLoop({
      ctx,
      signal,
      config: deps.getConfig(),
      deleteWebhook: deps.deleteWebhook,
      getUpdates: deps.getUpdates,
      getUpdatesRequestBudgetMs: deps.getUpdatesRequestBudgetMs,
      persistConfig: deps.persistConfig,
      appendUpdateBatch: deps.appendUpdateBatch,
      getAcceptedThroughUpdateId: deps.getAcceptedThroughUpdateId,
      getJournalEntryCount: deps.getJournalEntryCount,
      signalUpdateWorker: deps.signalUpdateWorker,
      onErrorStatus: (message) => {
        updateTelegramPollingStatusSafely(deps.updateStatus, ctx, {
          message,
          recordRuntimeEvent: deps.recordRuntimeEvent,
        });
      },
      onStatusReset: () => {
        updateTelegramPollingStatusSafely(deps.updateStatus, ctx, {
          recordRuntimeEvent: deps.recordRuntimeEvent,
        });
      },
      sleep,
      onPhaseChange: deps.onPhaseChange,
      onSuccessfulResponse: deps.onSuccessfulResponse,
      recordRuntimeEvent: deps.recordRuntimeEvent,
    });
}

function getTelegramPollingErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isTelegramGetUpdatesConflictError(error: unknown): boolean {
  return getTelegramPollingErrorMessage(error).includes(
    "Conflict: terminated by other getUpdates request",
  );
}

function reportTelegramPollingPhase(
  deps: TelegramRuntimeEventRecorderPort & {
    onPhaseChange?: (
      phase: TelegramPollingWorkPhase,
      currentUpdateId?: number,
    ) => void;
  },
  phase: TelegramPollingWorkPhase,
  currentUpdateId?: number,
): void {
  try {
    deps.onPhaseChange?.(phase, currentUpdateId);
  } catch (error) {
    deps.recordRuntimeEvent?.("polling", error, {
      phase: "phase-observer",
    });
  }
}

function reportTelegramPollingResponse<
  TUpdate extends TelegramUpdate,
  TContext,
>(
  deps: TelegramPollLoopDeps<TUpdate, TContext>,
  updateCount: number,
): void {
  try {
    deps.onSuccessfulResponse?.(updateCount);
  } catch (error) {
    deps.recordRuntimeEvent?.("polling", error, {
      phase: "response-observer",
    });
  }
}

function getTelegramPollingAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

async function requestTelegramUpdatesWithinBudget<
  TUpdate extends TelegramUpdate,
  TContext,
>(
  deps: TelegramPollLoopDeps<TUpdate, TContext>,
  body: Record<string, unknown>,
): Promise<TUpdate[]> {
  if (deps.signal.aborted) throw getTelegramPollingAbortReason(deps.signal);
  const configuredBudgetMs = deps.getUpdatesRequestBudgetMs?.(body);
  const timeoutMs =
    typeof configuredBudgetMs === "number" &&
    Number.isFinite(configuredBudgetMs) &&
    configuredBudgetMs > 0
      ? Math.floor(configuredBudgetMs)
      : getTelegramGetUpdatesRequestBudgetMs(body);
  const controller = new AbortController();
  const abortFromOwner = () => {
    controller.abort(getTelegramPollingAbortReason(deps.signal));
  };
  deps.signal.addEventListener("abort", abortFromOwner, { once: true });
  if (deps.signal.aborted) abortFromOwner();
  const timeout = setTimeout(() => {
    controller.abort(new TelegramGetUpdatesTimeoutError(timeoutMs));
  }, timeoutMs);
  let onRequestAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onRequestAbort = () =>
      reject(getTelegramPollingAbortReason(controller.signal));
    controller.signal.addEventListener("abort", onRequestAbort, {
      once: true,
    });
    if (controller.signal.aborted) onRequestAbort();
  });
  const operation = Promise.resolve()
    .then(() => {
      if (controller.signal.aborted) {
        throw getTelegramPollingAbortReason(controller.signal);
      }
      return deps.getUpdates(body, controller.signal);
    })
    .catch((error) => {
      if (controller.signal.aborted) {
        throw getTelegramPollingAbortReason(controller.signal);
      }
      throw error;
    });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    clearTimeout(timeout);
    deps.signal.removeEventListener("abort", abortFromOwner);
    if (onRequestAbort) {
      controller.signal.removeEventListener("abort", onRequestAbort);
    }
  }
}

export async function runTelegramPollLoop<
  TUpdate extends TelegramUpdate,
  TContext = unknown,
>(deps: TelegramPollLoopDeps<TUpdate, TContext>): Promise<void> {
  if (!deps.config.botToken) return;
  let consecutiveGetUpdatesConflicts = 0;
  const retryConflict = async () => {
    consecutiveGetUpdatesConflicts += 1;
    if (consecutiveGetUpdatesConflicts >= TELEGRAM_GET_UPDATES_CONFLICT_STOP_LIMIT) {
      throw new TelegramPersistentGetUpdatesConflictError(consecutiveGetUpdatesConflicts);
    }
    await deps.sleep(
      consecutiveGetUpdatesConflicts < TELEGRAM_GET_UPDATES_CONFLICT_FAST_RETRY_LIMIT
        ? TELEGRAM_GET_UPDATES_CONFLICT_FAST_RETRY_MS
        : TELEGRAM_GET_UPDATES_CONFLICT_SLOW_RETRY_MS,
      deps.signal,
    );
  };
  try {
    await deps.deleteWebhook(deps.signal);
  } catch {
    // ignore
  }
  if (
    deps.getAcceptedThroughUpdateId?.() === undefined &&
    deps.getJournalEntryCount() > 0
  ) {
    throw new TelegramPollingCursorBootstrapError(
      "Telegram polling cursor is missing while the durable update journal is non-empty.",
    );
  }
  if (
    deps.getAcceptedThroughUpdateId?.() === undefined
  ) {
    try {
      const request = buildTelegramInitialSyncRequest();
      reportTelegramPollingPhase(deps, "long-poll");
      const updates = await requestTelegramUpdatesWithinBudget(deps, request);
      reportTelegramPollingResponse(deps, updates.length);
      const lastUpdateId = getLatestTelegramUpdateId(updates);
      if (lastUpdateId !== undefined) {
        reportTelegramPollingPhase(
          deps,
          "persisting-offset",
          lastUpdateId,
        );
        await deps.appendUpdateBatch([], lastUpdateId);
        deps.recordRuntimeEvent?.(
          "polling",
          new Error("Initialized Telegram cursor without executing history."),
          { phase: "cursor-bootstrap", lastUpdateId },
        );
      }
    } catch (error) {
      if (shouldStopTelegramPolling(deps.signal.aborted, error)) return;
      reportTelegramPollingPhase(deps, "retrying");
      if (isTelegramGetUpdatesConflictError(error)) {
        await retryConflict();
      } else deps.recordRuntimeEvent?.("polling", error, {
        phase: "initial-sync",
        ...(error instanceof TelegramGetUpdatesTimeoutError
          ? { timeoutMs: error.timeoutMs }
          : {}),
      });
    }
  }
  let currentUpdateId: number | undefined;
  while (!deps.signal.aborted) {
    try {
      currentUpdateId = undefined;
      const request = buildTelegramLongPollRequest(
        deps.getAcceptedThroughUpdateId?.(),
      );
      reportTelegramPollingPhase(deps, "long-poll");
      const updates = await requestTelegramUpdatesWithinBudget(deps, request);
      reportTelegramPollingResponse(deps, updates.length);
      consecutiveGetUpdatesConflicts = 0;
      currentUpdateId = updates[0]?.update_id;
      await admitTelegramPollingUpdateBatch({
        updates,
        config: deps.config,
        appendBatch: deps.appendUpdateBatch,
        getAcceptedThroughUpdateId: deps.getAcceptedThroughUpdateId,
        persistConfig: deps.persistConfig,
        signalWorker: deps.signalUpdateWorker,
        onPhaseChange: deps.onPhaseChange,
        recordRuntimeEvent: deps.recordRuntimeEvent,
      });
      currentUpdateId = undefined;
    } catch (error) {
      if (shouldStopTelegramPolling(deps.signal.aborted, error)) return;
      reportTelegramPollingPhase(deps, "retrying", currentUpdateId);
      if (isTelegramGetUpdatesConflictError(error)) {
        await retryConflict();
        continue;
      }
      deps.recordRuntimeEvent?.("polling", error, {
        phase:
          error instanceof TelegramGetUpdatesTimeoutError
            ? "long-poll"
            : "loop",
        ...(error instanceof TelegramGetUpdatesTimeoutError
          ? { timeoutMs: error.timeoutMs }
          : {}),
      });
      consecutiveGetUpdatesConflicts = 0;
      deps.onErrorStatus(getTelegramPollingErrorMessage(error));
      await deps.sleep(TELEGRAM_POLLING_RETRY_MS, deps.signal);
      if (deps.signal.aborted) return;
      deps.onStatusReset();
    }
  }
}
