/**
 * Telegram lifecycle hook registration helpers
 * Zones: pi agent lifecycle, telegram session
 * Binds prepared Telegram lifecycle runtimes to pi extension lifecycle events
 */

import type {
  AgentEndEvent,
  AgentStartEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
} from "./pi.ts";

let resetTransportReplyDedupFn: (() => void) | undefined;

export function setResetTransportReplyDedup(fn: () => void): void {
  resetTransportReplyDedupFn = fn;
}

export function createAgentStartDedupHook(
  inner: (event: AgentStartEvent, ctx: ExtensionContext) => Promise<void>,
): (event: AgentStartEvent, ctx: ExtensionContext) => Promise<void> {
  return async function onAgentStartDedup(event, ctx) {
    if (resetTransportReplyDedupFn) resetTransportReplyDedupFn();
    return inner(event, ctx);
  };
}

export interface TelegramBeforeAgentStartResult {
  systemPrompt?: string;
}

type TelegramBeforeAgentStartReturn =
  | Promise<TelegramBeforeAgentStartResult | undefined>
  | TelegramBeforeAgentStartResult
  | undefined;

type TelegramLifecycleModel = ExtensionContext["model"];
type TelegramLifecycleMessage = AgentEndEvent["messages"][number];

export interface TelegramLifecycleRegistrationDeps {
  onSessionStart: (
    event: SessionStartEvent,
    ctx: ExtensionContext,
  ) => Promise<void>;
  onSessionShutdown: (
    event: SessionShutdownEvent,
    ctx: ExtensionContext,
  ) => Promise<void>;
  onSessionBeforeCompact?: (
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ) => Promise<void> | void;
  onSessionCompact?: (
    event: SessionCompactEvent,
    ctx: ExtensionContext,
  ) => Promise<void> | void;
  onBeforeAgentStart: (
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext,
  ) => TelegramBeforeAgentStartReturn;
  onModelSelect: (
    event: { model: TelegramLifecycleModel },
    ctx: ExtensionContext,
  ) => Promise<void> | void;
  onAgentStart: (
    event: AgentStartEvent,
    ctx: ExtensionContext,
  ) => Promise<void>;
  onToolExecutionStart: (
    event: unknown,
    ctx: ExtensionContext,
  ) => Promise<void> | void;
  onToolExecutionEnd: (
    event: unknown,
    ctx: ExtensionContext,
  ) => Promise<void> | void;
  onMessageStart: (
    event: { message: TelegramLifecycleMessage },
    ctx: ExtensionContext,
  ) => Promise<void>;
  onMessageUpdate: (
    event: { message: TelegramLifecycleMessage },
    ctx: ExtensionContext,
  ) => Promise<void>;
  onAgentEnd: (event: AgentEndEvent, ctx: ExtensionContext) => Promise<void>;
}

export interface TelegramSessionLifecycleHooks {
  onSessionStart: (
    event: SessionStartEvent,
    ctx: ExtensionContext,
  ) => Promise<void>;
  onSessionShutdown: (
    event: SessionShutdownEvent,
    ctx: ExtensionContext,
  ) => Promise<void>;
}

export interface TelegramSessionContextStore<TContext> {
  get: () => TContext | undefined;
  set: (ctx: TContext) => void;
  clear: () => void;
}

export function createTelegramSessionContextStore<
  TContext,
>(): TelegramSessionContextStore<TContext> {
  let currentContext: TContext | undefined;
  return {
    get: () => currentContext,
    set: (ctx) => {
      currentContext = ctx;
    },
    clear: () => {
      currentContext = undefined;
    },
  };
}

export function createTelegramSessionContextTracker(
  store: Pick<TelegramSessionContextStore<ExtensionContext>, "set" | "clear">,
): TelegramSessionLifecycleHooks {
  return {
    onSessionStart: async (_event, ctx) => {
      store.set(ctx);
    },
    onSessionShutdown: async () => {
      store.clear();
    },
  };
}

type TelegramLifecycleTimer = number | ReturnType<typeof setTimeout>;

function unrefTelegramLifecycleTimer(timer: TelegramLifecycleTimer): void {
  if (!timer || typeof timer !== "object") return;
  if (typeof timer.unref === "function") timer.unref();
}

export interface TelegramCompactionObserverRuntimeDeps<TContext> {
  setCompactionInProgress: (inProgress: boolean) => void;
  updateStatus: (ctx: TContext) => void;
  startTypingLoop?: (ctx: TContext) => void;
  stopTypingLoop?: () => void;
  requestDeferredDispatchNextQueuedTelegramTurn: (
    dispatch: (ctx: TContext) => void,
  ) => void;
  dispatchNextQueuedTelegramTurn: (ctx: TContext) => void;
  recordRuntimeEvent?: (category: string, error: unknown) => void;
  timeoutMs?: number;
  setTimer?: (callback: () => void, ms: number) => TelegramLifecycleTimer;
  clearTimer?: (timer: TelegramLifecycleTimer) => void;
}

export interface TelegramCompactionObserverRuntime<TContext> {
  onSessionBeforeCompact: (
    event: SessionBeforeCompactEvent,
    ctx: TContext,
  ) => void;
  onSessionCompact: (event: SessionCompactEvent, ctx: TContext) => void;
  onSessionShutdown: () => void;
}

export function createTelegramCompactionObserverRuntime<TContext>(
  deps: TelegramCompactionObserverRuntimeDeps<TContext>,
): TelegramCompactionObserverRuntime<TContext> {
  const timeoutMs = deps.timeoutMs ?? 300_000;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  let fallbackTimer: TelegramLifecycleTimer | undefined;
  const clearFallbackTimer = (): void => {
    if (!fallbackTimer) return;
    clearTimer(fallbackTimer);
    fallbackTimer = undefined;
  };
  const requestDispatch = (): void => {
    deps.requestDeferredDispatchNextQueuedTelegramTurn(
      deps.dispatchNextQueuedTelegramTurn,
    );
  };
  return {
    onSessionBeforeCompact: (_event, ctx) => {
      deps.setCompactionInProgress(true);
      deps.startTypingLoop?.(ctx);
      deps.updateStatus(ctx);
      clearFallbackTimer();
      fallbackTimer = setTimer(() => {
        fallbackTimer = undefined;
        deps.setCompactionInProgress(false);
        deps.stopTypingLoop?.();
        deps.updateStatus(ctx);
        deps.recordRuntimeEvent?.(
          "compact",
          new Error("Compaction observer timed out"),
        );
        requestDispatch();
      }, timeoutMs);
      unrefTelegramLifecycleTimer(fallbackTimer);
    },
    onSessionCompact: (_event, ctx) => {
      clearFallbackTimer();
      deps.setCompactionInProgress(false);
      deps.stopTypingLoop?.();
      deps.updateStatus(ctx);
      requestDispatch();
    },
    onSessionShutdown: () => {
      clearFallbackTimer();
      deps.stopTypingLoop?.();
    },
  };
}

export interface TelegramMessageActivityTypingDeps<TContext> {
  hasActiveTurn: () => boolean;
  startTypingLoop: (ctx: TContext) => void;
  onMessageStart: TelegramLifecycleRegistrationDeps["onMessageStart"];
  onMessageUpdate: TelegramLifecycleRegistrationDeps["onMessageUpdate"];
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export function createTelegramMessageActivityTypingHooks<
  TContext extends ExtensionContext,
>(
  deps: TelegramMessageActivityTypingDeps<TContext>,
): Pick<
  TelegramLifecycleRegistrationDeps,
  "onMessageStart" | "onMessageUpdate"
> {
  const ensureTyping = (ctx: TContext): void => {
    if (deps.hasActiveTurn()) deps.startTypingLoop(ctx);
  };
  const handleMessageActivity = async (
    phase: "start" | "update",
    event: Parameters<TelegramLifecycleRegistrationDeps["onMessageStart"]>[0],
    ctx: ExtensionContext,
    inner: TelegramLifecycleRegistrationDeps["onMessageStart"],
  ): Promise<void> => {
    const typedCtx = ctx as TContext;
    ensureTyping(typedCtx);
    try {
      await inner(event, ctx);
    } catch (error) {
      deps.recordRuntimeEvent?.("message-activity", error, { phase });
    } finally {
      ensureTyping(typedCtx);
    }
  };
  return {
    onMessageStart: (event, ctx) =>
      handleMessageActivity("start", event, ctx, deps.onMessageStart),
    onMessageUpdate: (event, ctx) =>
      handleMessageActivity("update", event, ctx, deps.onMessageUpdate),
  };
}

export function createDedupAgentStartHook(
  dedup: { reset(): void },
  inner: (event: AgentStartEvent, ctx: ExtensionContext) => Promise<void>,
): (event: AgentStartEvent, ctx: ExtensionContext) => Promise<void> {
  return async (event, ctx) => {
    dedup.reset();
    await inner(event, ctx);
  };
}

export interface TelegramExtraLifecycleHooks {
  onSessionStart?: (
    event: SessionStartEvent,
    ctx: ExtensionContext,
  ) => Promise<void>;
  onSessionShutdown?: (
    event: SessionShutdownEvent,
    ctx: ExtensionContext,
  ) => Promise<void>;
}

export function appendTelegramLifecycleHooks(
  base: TelegramSessionLifecycleHooks,
  extra: TelegramExtraLifecycleHooks,
): TelegramSessionLifecycleHooks {
  return {
    onSessionStart: async (event, ctx) => {
      await base.onSessionStart(event, ctx);
      await extra.onSessionStart?.(event, ctx);
    },
    onSessionShutdown: async (event, ctx) => {
      await base.onSessionShutdown(event, ctx);
      await extra.onSessionShutdown?.(event, ctx);
    },
  };
}

export function registerTelegramLifecycleHooks(
  pi: ExtensionAPI,
  deps: TelegramLifecycleRegistrationDeps,
): void {
  pi.on("session_start", async (event, ctx) => {
    await deps.onSessionStart(event, ctx);
  });
  pi.on("session_shutdown", async (event, ctx) => {
    await deps.onSessionShutdown(event, ctx);
  });
  pi.on("session_before_compact", async (event, ctx) => {
    await deps.onSessionBeforeCompact?.(event, ctx);
  });
  pi.on("session_compact", async (event, ctx) => {
    await deps.onSessionCompact?.(event, ctx);
  });
  pi.on("before_agent_start", async (event, ctx) => {
    return deps.onBeforeAgentStart(event, ctx);
  });
  pi.on("model_select", async (event, ctx) => {
    await deps.onModelSelect(event, ctx);
  });
  pi.on("agent_start", async (event, ctx) => {
    await deps.onAgentStart(event, ctx);
  });
  pi.on("tool_execution_start", async (event, ctx) => {
    await deps.onToolExecutionStart(event, ctx);
  });
  pi.on("tool_execution_end", async (event, ctx) => {
    await deps.onToolExecutionEnd(event, ctx);
  });
  pi.on("message_start", async (event, ctx) => {
    await deps.onMessageStart(event, ctx);
  });
  pi.on("message_update", async (event, ctx) => {
    await deps.onMessageUpdate(event, ctx);
  });
  pi.on("agent_end", async (event, ctx) => {
    await deps.onAgentEnd(event, ctx);
  });
}
