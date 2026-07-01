/**
 * Telegram polling runtime domain helpers
 * Zones: telegram transport, polling runtime
 * Owns polling request builders, stop conditions, and the long-poll loop runtime for Telegram updates
 */

type MaybePromise<T> = T | Promise<T>;

export interface TelegramPollingConfig {
  botToken?: string;
  lastUpdateId?: number;
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
const TELEGRAM_POLLING_DEFAULT_MAX_UPDATE_FAILURES = 3;
const TELEGRAM_GET_UPDATES_CONFLICT_FAST_RETRY_LIMIT = 3;
const TELEGRAM_GET_UPDATES_CONFLICT_FAST_RETRY_MS = 1_000;
const TELEGRAM_GET_UPDATES_CONFLICT_SLOW_RETRY_MS = 3_000;
const TELEGRAM_POLLING_RETRY_MS = 3_000;

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
  updates: TelegramUpdate[],
): number | undefined {
  return updates.at(-1)?.update_id;
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

export interface TelegramPollingControllerState {
  pollingPromise?: Promise<void>;
  pollingController?: AbortController;
}

export function createTelegramPollingControllerState(): TelegramPollingControllerState {
  return {};
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

export interface TelegramPollingControllerRuntimeDeps<
  TUpdate extends TelegramUpdate,
  TContext = unknown,
> extends TelegramPollLoopRunnerDeps<TUpdate, TContext> {
  state?: TelegramPollingControllerState;
  hasBotToken: () => boolean;
  stopTypingLoop: () => unknown;
  createAbortController?: () => AbortController;
}

export function createTelegramPollingControllerRuntime<
  TUpdate extends TelegramUpdate,
  TContext = unknown,
>(
  deps: TelegramPollingControllerRuntimeDeps<TUpdate, TContext>,
): TelegramPollingController<TContext> {
  return createTelegramPollingController({
    state: deps.state,
    hasBotToken: deps.hasBotToken,
    stopTypingLoop: deps.stopTypingLoop,
    runPollLoop: createTelegramPollLoopRunner<TUpdate, TContext>({
      getConfig: deps.getConfig,
      deleteWebhook: deps.deleteWebhook,
      getUpdates: deps.getUpdates,
      persistConfig: deps.persistConfig,
      handleUpdate: deps.handleUpdate,
      updateStatus: deps.updateStatus,
      sleep: deps.sleep,
      maxUpdateFailures: deps.maxUpdateFailures,
      recordRuntimeEvent: deps.recordRuntimeEvent,
    }),
    updateStatus: deps.updateStatus,
    createAbortController: deps.createAbortController,
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
}

export function createTelegramPollingController<TContext>(
  deps: TelegramPollingControllerDeps<TContext>,
): TelegramPollingController<TContext> {
  const state = deps.state ?? createTelegramPollingControllerState();
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
  if (deps.getPollingPromise() === pollingPromise) {
    deps.setPollingPromise(undefined);
  }
  if (deps.getPollingController() === pollingController) {
    deps.setPollingController(undefined);
  }
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
  let promise: Promise<void>;
  promise = deps.runPollLoop(ctx, controller.signal).finally(() => {
    if (deps.getPollingPromise() === promise) deps.setPollingPromise(undefined);
    if (deps.getPollingController() === controller) {
      deps.setPollingController(undefined);
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
  isBusConfigured: () => boolean;
  ownsLock: (ctx: TContext) => boolean;
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

export type TelegramThreadTargetObservationHandler<TContext> = (
  ctx: TContext,
) => Promise<void>;

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
  stopFollowerRegistration: () => void;
}

export interface TelegramThreadAwarePollingDeps<
  TContext,
  TOwner,
> extends TelegramStartupThreadCapabilityProbeDeps {
  isBusConfigured: () => boolean;
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
  stopFollowerRegistration: () => void;
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
  return state.lastReconcileAction?.endsWith("-classic-restore-failed") ?? false;
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
  if (!deps.isBusConfigured()) return;
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
    options?: { forceFreshLeaderThread?: boolean },
  ): Promise<void> => {
    if (deps.isBusConfigured()) {
      await deps.topicTargetStore.load();
      let startupThreadCapability: boolean | undefined;
      try {
        startupThreadCapability =
          await probeTelegramStartupThreadCapability(deps);
      } catch (error) {
        deps.recordEvent("bus", error, { phase: "startup-thread-mode-probe" });
      }
      deps.setTopicModeUnavailable(startupThreadCapability !== true);
    }
    if (deps.isBusRuntimeEnabled()) {
      deps.setTopicModeUnavailable(false);
      try {
        deps.setPollingStartedWithTelegramBus(true);
        deps.setForceFreshLeaderThreadOnNextStart(
          !!options?.forceFreshLeaderThread,
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
    await deps.topicTargetStore.load();
    if (deps.topicTargetStore.getBotState().threadMode !== "enabled") {
      if (hasTelegramThreadCapabilityBindings(deps.topicTargetStore)) {
        deps.recordEvent(
          "bus",
          "Telegram Threaded Mode disabled; follower takeover blocked",
          {
            phase: "follower-register-thread-mode-disabled",
            reason: "active-thread-bindings-present",
          },
        );
        throw new Error(
          "Telegram Threaded Mode is disabled; the current leader remains the classic polling owner.",
        );
      }
      return undefined;
    }
    if (!deps.isBusRuntimeEnabled()) return undefined;
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

export function createTelegramThreadCapabilityMonitor<TContext>(
  deps: TelegramThreadCapabilityRuntimeDeps<TContext>,
): TelegramThreadCapabilityMonitor<TContext> {
  const intervalMs =
    deps.intervalMs ?? TELEGRAM_THREAD_CAPABILITY_MONITOR_INTERVAL_MS;
  let interval: ReturnType<typeof setInterval> | undefined;
  let transitionPending = false;
  let consecutiveDisabledProbes = 0;
  const stop = (): void => {
    if (!interval) return;
    clearInterval(interval);
    interval = undefined;
  };
  const check = (ctx: TContext): void => {
    if (transitionPending) return;
    transitionPending = true;
    void readTelegramThreadCapability(deps)
      .then(async (threadModeEnabled) => {
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
          if (!deps.ownsLock(ctx) || !hasTelegramClassicRestoreFailure(botState)) {
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
        deps.recordEvent("bus", error, { phase: "capability-monitor" });
      })
      .finally(() => {
        transitionPending = false;
      });
  };
  return {
    start(ctx) {
      stop();
      if (!deps.isBusConfigured()) return;
      interval = setInterval(() => {
        check(ctx);
      }, intervalMs);
      interval.unref?.();
    },
    stop,
  };
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
  persistConfig: () => Promise<void>;
  handleUpdate: (update: TUpdate, ctx: TContext) => Promise<void>;
  onErrorStatus: (message: string) => void;
  onStatusReset: () => void;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxUpdateFailures?: number;
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
  persistConfig: () => Promise<void>;
  handleUpdate: (update: TUpdate, ctx: TContext) => Promise<void>;
  updateStatus: (ctx: TContext, message?: string) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxUpdateFailures?: number;
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
      persistConfig: deps.persistConfig,
      handleUpdate: deps.handleUpdate,
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
      maxUpdateFailures: deps.maxUpdateFailures,
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
  if (deps.config.lastUpdateId === undefined) {
    try {
      const updates = await deps.getUpdates(
        buildTelegramInitialSyncRequest(),
        deps.signal,
      );
      const lastUpdateId = getLatestTelegramUpdateId(updates);
      if (lastUpdateId !== undefined) {
        deps.config.lastUpdateId = lastUpdateId;
        await deps.persistConfig();
      }
    } catch {
      // ignore
    }
  }
  const maxUpdateFailures = Math.max(
    1,
    deps.maxUpdateFailures ?? TELEGRAM_POLLING_DEFAULT_MAX_UPDATE_FAILURES,
  );
  const updateFailures = new Map<number, number>();
  let handledUpdateFailureRethrown = false;
  let consecutiveGetUpdatesConflicts = 0;
  while (!deps.signal.aborted) {
    try {
      const updates = await deps.getUpdates(
        buildTelegramLongPollRequest(deps.config.lastUpdateId),
        deps.signal,
      );
      consecutiveGetUpdatesConflicts = 0;
      for (const update of updates) {
        try {
          await deps.handleUpdate(update, deps.ctx);
          deps.config.lastUpdateId = update.update_id;
          updateFailures.delete(update.update_id);
          await deps.persistConfig();
        } catch (error) {
          const failureCount = (updateFailures.get(update.update_id) ?? 0) + 1;
          updateFailures.set(update.update_id, failureCount);
          deps.recordRuntimeEvent?.("polling", error, {
            phase: "handleUpdate",
            updateId: update.update_id,
            failureCount,
          });
          if (failureCount < maxUpdateFailures) {
            handledUpdateFailureRethrown = true;
            throw error;
          }
          const message = getTelegramPollingErrorMessage(error);
          deps.onErrorStatus(
            `skipping Telegram update ${update.update_id} after ${failureCount} failures: ${message}`,
          );
          deps.config.lastUpdateId = update.update_id;
          updateFailures.delete(update.update_id);
          await deps.persistConfig();
        }
      }
    } catch (error) {
      if (shouldStopTelegramPolling(deps.signal.aborted, error)) return;
      if (handledUpdateFailureRethrown) {
        handledUpdateFailureRethrown = false;
      } else {
        deps.recordRuntimeEvent?.("polling", error, { phase: "loop" });
      }
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
