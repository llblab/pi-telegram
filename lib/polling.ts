/**
 * Telegram polling runtime domain helpers
 * Zones: telegram transport, polling runtime
 * Owns polling request builders, stop conditions, and the long-poll loop runtime for Telegram updates
 */

export interface TelegramPollingConfig {
  botToken?: string;
  lastUpdateId?: number;
}

export interface TelegramUpdate {
  update_id: number;
}

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
    offset: -1,
    limit: 1,
    timeout: 0,
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
    limit: 10,
    timeout: 30,
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
  deps.stopTypingLoop();
  deps.getPollingController()?.abort();
  deps.setPollingController(undefined);
  await deps.getPollingPromise()?.catch(() => undefined);
  deps.setPollingPromise(undefined);
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
  const promise = deps.runPollLoop(ctx, controller.signal).finally(() => {
    deps.setPollingPromise(undefined);
    deps.setPollingController(undefined);
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
  const maxUpdateFailures = Math.max(1, deps.maxUpdateFailures ?? 3);
  const updateFailures = new Map<number, number>();
  let handledUpdateFailureRethrown = false;
  while (!deps.signal.aborted) {
    try {
      const updates = await deps.getUpdates(
        buildTelegramLongPollRequest(deps.config.lastUpdateId),
        deps.signal,
      );
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
      deps.onErrorStatus(getTelegramPollingErrorMessage(error));
      await deps.sleep(3000, deps.signal);
      if (deps.signal.aborted) return;
      deps.onStatusReset();
    }
  }
}
