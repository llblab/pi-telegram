/**
 * Telegram lifecycle hook registration helpers
 * Zones: pi agent lifecycle, telegram session
 * Owns binding prepared Telegram lifecycle runtimes to pi extension lifecycle events
 */

import type {
  AgentEndEvent,
  AgentStartEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
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
