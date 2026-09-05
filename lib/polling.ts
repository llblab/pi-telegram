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
  | "failed";

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
  validateStart?: () => void;
  worker: {
    onSessionStart: (ctx: TContext) => Promise<void>;
  };
}): TelegramPollingAdmissionRuntime<TContext> {
  return {
    isActive: deps.polling.isActive,
    async start(ctx) {
      await deps.prepareStart?.();
      deps.validateStart?.();
      await deps.worker.onSessionStart(ctx);
      await deps.polling.start(ctx);
    },
    stop: deps.polling.stop,
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
  journal: {
    appendBatch: (
      updates: readonly TUpdate[],
      acceptedThroughUpdateId?: number,
    ) => MaybePromise<unknown>;
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
    appendUpdateBatch: deps.journal.appendBatch,
    getAcceptedThroughUpdateId: deps.journal.getAcceptedThroughUpdateId,
    getJournalEntryCount: deps.journal.getEntryCount,
    signalUpdateWorker: deps.journal.signalWorker,
  });
  const admission = createTelegramPollingAdmissionRuntime({
    polling: controller,
    prepareStart: deps.journal.prepareCursorCutover,
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
      prepareUpdateBatch: deps.prepareUpdateBatch,
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
      failed = true;
      deps.recordRuntimeEvent?.("polling", error, {
        phase: "controller",
      });
    })
    .finally(() => {
      const ownsPromise = deps.getPollingPromise() === promise;
      const ownsController = deps.getPollingController() === controller;
      if (ownsPromise) deps.setPollingPromise(undefined);
      if (ownsController) deps.setPollingController(undefined);
      if (ownsPromise || ownsController) {
        deps.onPollingStopped?.(
          failed
            ? "failed"
            : controller.signal.aborted
              ? "requested"
              : "completed",
        );
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
  topicTargetStore: TelegramThreadCapabilityStore;
  ownsLock: (ctx: TContext) => boolean;
  isFollowerRegistered?: () => boolean;
  getPollingStartedWithTelegramBus: () => boolean;
  setPollingStartedWithTelegramBus: (started: boolean) => void;
  setTopicModeUnavailable: (unavailable: boolean) => void;
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
    options?: {
      forceFreshLeaderThread?: boolean;
      requestedThreadName?: string;
    },
  ) => Promise<void>;
  stopPolling: () => Promise<void>;
  registerFollowerWithOwner: (
    ctx: TContext,
    owner: TOwner,
  ) => Promise<boolean | undefined>;
  stopFollowerRegistration: () => void;
}

export interface TelegramThreadAwarePollingDeps<
  TContext,
  TOwner,
> extends TelegramStartupThreadCapabilityProbeDeps {
  isBusRuntimeEnabled: () => boolean;
  isTopicModeUnavailableError: (error: unknown) => boolean;
  getPollingStartedWithTelegramBus: () => boolean;
  setPollingStartedWithTelegramBus: (started: boolean) => void;
  setForceFreshLeaderThreadOnNextStart: (forceFresh: boolean) => void;
  setRequestedThreadNameOnNextStart?: (threadName: string | undefined) => void;
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
  const capabilityDeps: TelegramThreadCapabilityRuntimeDeps<TContext> = {
    getAllowedUserId: deps.getAllowedUserId,
    callApi: deps.callApi,
    topicTargetStore: deps.topicTargetStore,
    ownsLock: deps.ownsLock,
    isFollowerRegistered: deps.isFollowerRegistered,
    getPollingStartedWithTelegramBus: deps.state.isBusPollingStarted,
    setPollingStartedWithTelegramBus: deps.state.setBusPollingStarted,
    setTopicModeUnavailable: deps.state.setTopicModeUnavailable,
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
      getAllowedUserId: deps.getAllowedUserId,
      callApi: deps.callApi,
      topicTargetStore: deps.topicTargetStore,
      isBusRuntimeEnabled: deps.isBusRuntimeEnabled,
      isTopicModeUnavailableError: deps.isTopicModeUnavailableError,
      getPollingStartedWithTelegramBus: deps.state.isBusPollingStarted,
      setPollingStartedWithTelegramBus: deps.state.setBusPollingStarted,
      setForceFreshLeaderThreadOnNextStart:
        deps.state.setForceFreshLeaderThread,
      setRequestedThreadNameOnNextStart: deps.state.setRequestedThreadName,
      startClassicPolling: deps.startClassicPolling,
      stopClassicPolling: deps.stopClassicPolling,
      startBusLeaderPolling: deps.startBusLeaderPolling,
      stopBusLeaderPolling: deps.stopBusLeaderPolling,
      startLeaderHealth: deps.startLeaderHealth,
      stopLeaderHealth: deps.stopLeaderHealth,
      registerFollowerWithLeader: deps.registerFollowerWithLeader,
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
): Promise<boolean | undefined> {
  const threadModeEnabled = await readTelegramThreadCapability(deps);
  const nowMs = (deps.getNowMs ?? Date.now)();
  if (threadModeEnabled === false) {
    deps.topicTargetStore.setBotState({
      threadMode: "disabled",
      updatedAtMs: nowMs,
      lastReconcileAction: "startup-bot-topics-disabled",
    });
    await deps.topicTargetStore.persist();
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
): Promise<void> {
  await deps.topicTargetStore.load();
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
    deps.setTopicModeUnavailable(true);
    deps.stopFollowerRegistration();
    if (
      deps.getPollingStartedWithTelegramBus() ||
      hasTelegramClassicRestoreFailure(previousBotState)
    ) {
      deps.stopLeaderHealth();
      await deps.stopBusPolling();
      deps.setPollingStartedWithTelegramBus(false);
      try {
        await deps.startClassicPolling(ctx);
      } catch (classicError) {
        deps.topicTargetStore.setBotState({
          threadMode: "disabled",
          updatedAtMs: (deps.getNowMs ?? Date.now)(),
          lastReconcileAction: `${phase}-classic-restore-failed`,
        });
        await deps.topicTargetStore.persist();
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
  deps.setTopicModeUnavailable(false);
  if (!deps.getPollingStartedWithTelegramBus() && deps.ownsLock(ctx)) {
    await deps.stopClassicPolling();
    deps.setPollingStartedWithTelegramBus(true);
    try {
      await deps.startBusPolling(ctx);
      deps.startLeaderHealth();
    } catch (error) {
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
        deps.setTopicModeUnavailable(true);
      }
      try {
        await deps.startClassicPolling(ctx);
      } catch (classicError) {
        deps.topicTargetStore.setBotState({
          threadMode: "disabled",
          updatedAtMs: (deps.getNowMs ?? Date.now)(),
          lastReconcileAction: `${phase}-classic-restore-failed`,
        });
        await deps.topicTargetStore.persist();
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
  const startPolling = async (
    ctx: TContext,
    options?: {
      forceFreshLeaderThread?: boolean;
      requestedThreadName?: string;
    },
  ): Promise<void> => {
    await deps.topicTargetStore.load();
    let startupThreadCapability: boolean | undefined;
    try {
      startupThreadCapability = await probeTelegramStartupThreadCapability(deps);
    } catch (error) {
      deps.recordEvent("bus", error, { phase: "startup-thread-mode-probe" });
    }
    deps.setTopicModeUnavailable(startupThreadCapability !== true);
    if (deps.isBusRuntimeEnabled()) {
      deps.setTopicModeUnavailable(false);
      try {
        deps.setPollingStartedWithTelegramBus(true);
        deps.setForceFreshLeaderThreadOnNextStart(
          !!options?.forceFreshLeaderThread,
        );
        deps.setRequestedThreadNameOnNextStart?.(
          options?.requestedThreadName,
        );
        await deps.startBusLeaderPolling(ctx);
        deps.startLeaderHealth();
        return;
      } catch (error) {
        deps.setPollingStartedWithTelegramBus(false);
        if (!deps.isTopicModeUnavailableError(error)) throw error;
        deps.setTopicModeUnavailable(true);
        await deps.topicTargetStore.load();
        deps.topicTargetStore.setBotState({
          threadMode: "disabled",
          updatedAtMs: Date.now(),
          lastReconcileAction: "thread-mode-unavailable",
        });
        await deps.topicTargetStore.persist();
        deps.recordEvent("bus", error, { phase: "thread-mode-unavailable" });
      } finally {
        deps.setForceFreshLeaderThreadOnNextStart(false);
      }
    }
    deps.setPollingStartedWithTelegramBus(false);
    await deps.startClassicPolling(ctx);
  };
  const stopPolling = async (): Promise<void> => {
    if (deps.getPollingStartedWithTelegramBus()) {
      deps.stopLeaderHealth();
      await deps.stopBusLeaderPolling();
      deps.setPollingStartedWithTelegramBus(false);
      return;
    }
    await deps.stopClassicPolling();
  };
  const registerFollowerWithOwner = async (
    ctx: TContext,
    owner: TOwner,
  ): Promise<boolean | undefined> => {
    if (deps.topicTargetStore.refresh) {
      await deps.topicTargetStore.refresh();
    } else {
      await deps.topicTargetStore.load();
    }
    if (deps.topicTargetStore.getBotState().threadMode !== "enabled") {
      return undefined;
    }
    return deps.registerFollowerWithLeader(ctx, owner);
  };
  return {
    startPolling,
    stopPolling,
    registerFollowerWithOwner,
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
    try {
      await applyTelegramThreadCapability(
        ctx,
        true,
        "thread-target-observed",
        deps,
      );
    } catch (error) {
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
  };
  const check = (ctx: TContext): void => {
    if (transitionPromise || !canProbeTelegramThreadCapability(ctx, deps)) {
      return;
    }
    const expectedGeneration = generation;
    const isCurrent = (): boolean => generation === expectedGeneration;
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
      interval = setInterval(() => {
        check(ctx);
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
  prepareUpdateBatch?: (updates: readonly TUpdate[]) => void;
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
  prepareUpdateBatch?: (updates: readonly TUpdate[]) => void;
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
      prepareUpdateBatch: deps.prepareUpdateBatch,
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
      deps.recordRuntimeEvent?.("polling", error, {
        phase: "initial-sync",
        ...(error instanceof TelegramGetUpdatesTimeoutError
          ? { timeoutMs: error.timeoutMs }
          : {}),
      });
    }
  }
  let consecutiveGetUpdatesConflicts = 0;
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
      deps.prepareUpdateBatch?.(updates);
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
      deps.recordRuntimeEvent?.("polling", error, {
        phase:
          error instanceof TelegramGetUpdatesTimeoutError
            ? "long-poll"
            : "loop",
        ...(error instanceof TelegramGetUpdatesTimeoutError
          ? { timeoutMs: error.timeoutMs }
          : {}),
      });
      if (isTelegramGetUpdatesConflictError(error)) {
        consecutiveGetUpdatesConflicts += 1;
        await deps.sleep(
          consecutiveGetUpdatesConflicts <
            TELEGRAM_GET_UPDATES_CONFLICT_FAST_RETRY_LIMIT
            ? TELEGRAM_GET_UPDATES_CONFLICT_FAST_RETRY_MS
            : TELEGRAM_GET_UPDATES_CONFLICT_SLOW_RETRY_MS,
          deps.signal,
        );
        continue;
      }
      consecutiveGetUpdatesConflicts = 0;
      deps.onErrorStatus(getTelegramPollingErrorMessage(error));
      await deps.sleep(TELEGRAM_POLLING_RETRY_MS, deps.signal);
      if (deps.signal.aborted) return;
      deps.onStatusReset();
    }
  }
}
