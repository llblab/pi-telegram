/**
 * Regression tests for Telegram binding composition
 * Covers lifecycle binding delegation across composed runtimes
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  registerTelegramCommandsAndTools,
  registerTelegramLifecycleRuntimeHooks,
} from "../lib/bindings.ts";
import * as Runtime from "../lib/runtime.ts";
import type { ExtensionAPI, ExtensionContext } from "../lib/pi.ts";

type RegisteredBindingHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => Promise<unknown> | unknown;

type RegisteredBindingTool = {
  name?: string;
  execute: (
    toolCallId: string,
    params: Record<string, string>,
  ) => Promise<unknown>;
};

function createBindingApiHarness() {
  const handlers = new Map<string, RegisteredBindingHandler>();
  const tools = new Map<string, RegisteredBindingTool>();
  const commands = new Map<string, unknown>();
  const api = {
    on: (event: string, handler: RegisteredBindingHandler) => {
      handlers.set(event, handler);
    },
    registerTool: (definition: RegisteredBindingTool) => {
      if (definition.name) tools.set(definition.name, definition);
    },
    registerCommand: (name: string, definition: unknown) => {
      commands.set(name, definition);
    },
  } as unknown as ExtensionAPI;
  return { api, handlers, tools, commands };
}

function getRequiredBindingHandler(
  handlers: Map<string, RegisteredBindingHandler>,
  name: string,
): RegisteredBindingHandler {
  const handler = handlers.get(name);
  assert.ok(handler, `Expected binding handler ${name}`);
  return handler;
}

test("Command binding does not expose a thread rename tool", () => {
  const harness = createBindingApiHarness();
  registerTelegramCommandsAndTools({
    pi: harness.api,
    configStore: {
      get: () => ({}),
      getAllowedUserId: () => 840585,
      getOutboundHandlers: () => [],
      hasBotToken: () => true,
      load: async () => {},
      persist: async () => {},
      set: () => {},
    },
    setup: { start: () => true, finish: () => {} },
    activeTurnRuntime: { get: () => undefined },
    lockedPollingRuntime: {
      start: async () => ({ ok: true }),
      stop: async () => undefined,
    },
    getStatusLines: () => [],
    buttonActionStore: { register: () => "button-action" },
    sendMarkdownReply: async () => 1,
    callMultipart: async () => ({ ok: true }),
    getDefaultChatId: () => 840585,
    canSendDirect: () => true,
    updateStatus: () => {},
    recordRuntimeEvent: () => {},
  } as unknown as Parameters<typeof registerTelegramCommandsAndTools>[0]);
  assert.equal(harness.tools.has("telegram_rename_thread"), false);
});

test("Command binding rejects a missing profile without stopping active polling", async () => {
  const harness = createBindingApiHarness();
  const events: string[] = [];
  let activeProfileName: string | undefined = "active";
  registerTelegramCommandsAndTools({
    pi: harness.api,
    configStore: {
      get: () => ({ botToken: "active-token" }),
      getStoredConfig: () => ({
        profiles: { active: { botToken: "active-token" } },
      }),
      getActiveProfileName: () => activeProfileName,
      activateProfile: (profileName?: string) => {
        events.push(`activate:${profileName ?? "default"}`);
        activeProfileName = profileName;
        return true;
      },
      getAllowedUserId: () => 840585,
      getOutboundHandlers: () => [],
      hasBotToken: () => true,
      load: async () => {
        events.push("load");
      },
      persist: async () => {},
      set: () => {},
    },
    setup: { start: () => true, finish: () => {} },
    activeTurnRuntime: { get: () => undefined },
    lockedPollingRuntime: {
      start: async () => {
        events.push("start");
        return { ok: true };
      },
      stop: async () => {
        events.push("stop");
      },
    },
    getStatusLines: () => [],
    buttonActionStore: { register: () => "button-action" },
    sendMarkdownReply: async () => 1,
    callMultipart: async () => ({ ok: true }),
    getDefaultChatId: () => 840585,
    canSendDirect: () => true,
    updateStatus: () => {
      events.push("status");
    },
    recordRuntimeEvent: () => {},
  } as unknown as Parameters<typeof registerTelegramCommandsAndTools>[0]);
  const connect = harness.commands.get("telegram-connect") as {
    handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  };
  const notifications: string[] = [];
  await connect.handler("missing", {
    cwd: "/repo",
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext);
  assert.equal(activeProfileName, "active");
  assert.deepEqual(events, ["load", "status"]);
  assert.deepEqual(notifications, ['Profile "missing" not found.']);
});

test("Named profile setup cancellation preserves the active runtime", async () => {
  const harness = createBindingApiHarness();
  const events: string[] = [];
  let activeProfileName: string | undefined = "active";
  registerTelegramCommandsAndTools({
    pi: harness.api,
    configStore: {
      get: () => ({ botToken: "active-token" }),
      getStoredConfig: () => ({
        profiles: { active: { botToken: "active-token" } },
      }),
      getActiveProfileName: () => activeProfileName,
      activateProfile: (profileName?: string) => {
        events.push(`activate:${profileName ?? "default"}`);
        activeProfileName = profileName;
        return true;
      },
      getAllowedUserId: () => 840585,
      getOutboundHandlers: () => [],
      hasBotToken: () => true,
      load: async () => undefined,
      persist: async () => {
        events.push("persist");
      },
      set: () => {
        events.push("set");
      },
    },
    setup: {
      start: () => {
        events.push("guard-start");
        return true;
      },
      finish: () => {
        events.push("guard-finish");
      },
    },
    activeTurnRuntime: { get: () => undefined },
    lockedPollingRuntime: {
      start: async () => {
        events.push("start");
        return { ok: true };
      },
      stop: async () => {
        events.push("stop");
      },
    },
    getStatusLines: () => [],
    buttonActionStore: { register: () => "button-action" },
    sendMarkdownReply: async () => 1,
    callMultipart: async () => ({ ok: true }),
    getDefaultChatId: () => 840585,
    canSendDirect: () => true,
    updateStatus: () => {
      events.push("status");
    },
    recordRuntimeEvent: () => {},
  } as unknown as Parameters<typeof registerTelegramCommandsAndTools>[0]);
  const setupCommand = harness.commands.get("telegram-setup") as {
    handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  };
  const notifications: string[] = [];
  await setupCommand.handler("new-profile", {
    cwd: "/repo",
    hasUI: true,
    ui: {
      input: async () => undefined,
      editor: async () => undefined,
      notify: (message: string) => {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext);
  assert.equal(activeProfileName, "active");
  assert.deepEqual(events, ["guard-start", "guard-finish"]);
  assert.deepEqual(notifications, []);
});

test("Lifecycle binding delegates shutdown to composed session runtime", async () => {
  const events: string[] = [];
  const harness = createBindingApiHarness();
  const deps = {
    pi: harness.api,
    sessionLifecycleRuntime: {
      onSessionStart: async () => {
        events.push("session-start");
      },
      onSessionShutdown: async () => {
        events.push("composed-shutdown");
      },
      onModelSelect: () => {
        events.push("model-select");
      },
    },
    configStore: { get: () => ({}), getOutboundHandlers: () => [] },
    abort: { setHandler: () => {}, clearHandler: () => {} },
    typing: { stop: () => {}, waitForIdle: async () => {} },
    progress: {
      start: () => ({ active: true, chatId: 1, text: "", updatedAtMs: 0 }),
      update: () => undefined,
      stop: () => undefined,
      get: () => undefined,
    },
    lifecycle: {
      resetActiveToolExecutions: () => {},
      clearDispatchPending: () => {},
      hasDispatchPending: () => false,
      setFoldQueuedPromptsIntoHistory: () => {},
      shouldFoldQueuedPromptsIntoHistory: () => false,
      getActiveToolExecutions: () => 0,
      setActiveToolExecutions: () => {},
      setCompactionInProgress: () => {},
    },
    activeTurnRuntime: {
      clear: () => {},
      has: () => false,
      set: () => {},
      get: () => undefined,
    },
    telegramQueueStore: {
      getQueuedItems: () => [],
      setQueuedItems: () => {},
    },
    modelSwitchController: {
      clearPendingSwitch: () => {},
      triggerPendingAbort: () => {},
    },
    previewRuntime: {
      resetState: () => undefined,
      clear: () => {},
      setPendingText: () => {},
      onMessageStart: async () => {},
      onMessageUpdate: async () => {},
    },
    promptDispatchRuntime: {
      startTypingLoop: () => events.push("typing:start"),
    },
    deferredQueueDispatchRuntime: { request: () => {} },
    lockOwnershipGuard: { ownsContext: () => false },
    buttonActionStore: { register: () => "button-action" },
    callMultipart: async () => ({ ok: true }),
    sendChatAction: async () => ({ ok: true }),
    sendRecordVoiceAction: async () => ({ ok: true }),
    sendMarkdownReply: async () => ({ ok: true }),
    sendTextReply: async () => ({ ok: true }),
    editInteractiveMessage: async () => undefined,
    deleteMessage: async () => undefined,
    dispatchNextQueuedTelegramTurn: () => {},
    answerGuestQuery: async () => ({ ok: true }),
    sendGuestReply: async () => ({ ok: true }),
    finalizeMarkdownPreview: async () => undefined,
    proactivePushChatIdGetter: () => undefined,
    isProactivePushEnabled: () => false,
    updateStatus: () => {},
    recordRuntimeEvent: () => {},
  } as unknown as Parameters<typeof registerTelegramLifecycleRuntimeHooks>[0];

  registerTelegramLifecycleRuntimeHooks(deps);
  await getRequiredBindingHandler(harness.handlers, "session_before_compact")(
    { type: "session_before_compact" },
    {} as ExtensionContext,
  );
  await getRequiredBindingHandler(harness.handlers, "session_shutdown")(
    {},
    {} as ExtensionContext,
  );

  assert.deepEqual(events, ["composed-shutdown"]);
});

test("Lifecycle binding uses native typing and assistant previews without activity documents", async () => {
  const events: string[] = [];
  const harness = createBindingApiHarness();
  const runtime = Runtime.createTelegramBridgeRuntime();
  const deps = {
    pi: harness.api,
    sessionLifecycleRuntime: {
      onSessionStart: async () => {},
      onSessionShutdown: async () => {},
      onModelSelect: () => {},
    },
    configStore: {
      get: () => ({}),
      getOutboundHandlers: () => [],
      hasBotToken: () => true,
    },
    abort: runtime.abort,
    typing: runtime.typing,
    lifecycle: runtime.lifecycle,
    activeTurnRuntime: {
      clear: () => {},
      has: () => true,
      set: () => {},
      get: () => ({ chatId: 42, target: { chatId: 42, threadId: 9 } }),
    },
    telegramQueueStore: { getQueuedItems: () => [], setQueuedItems: () => {} },
    modelSwitchController: {
      clearPendingSwitch: () => {},
      triggerPendingAbort: () => {},
    },
    previewRuntime: {
      resetState: () => undefined,
      clear: () => {},
      setPendingText: () => {},
      onMessageStart: async () => events.push("preview:start"),
      onMessageUpdate: async () => events.push("preview:update"),
    },
    promptDispatchRuntime: {
      startTypingLoop: (
        _ctx: ExtensionContext,
        chatId?: number,
        options?: { target?: { threadId?: number } },
      ) =>
        events.push(
          `typing:${chatId ?? "none"}:${options?.target?.threadId ?? "all"}`,
        ),
    },
    deferredQueueDispatchRuntime: { request: () => {} },
    lockOwnershipGuard: { ownsContext: () => false },
    buttonActionStore: { register: () => "button-action" },
    callMultipart: async () => ({ ok: true }),
    sendChatAction: async () => ({ ok: true }),
    sendRecordVoiceAction: async () => ({ ok: true }),
    sendMarkdownReply: async (
      _chatId: number,
      _replyTo: number | undefined,
      text: string,
    ) => {
      events.push(`send:${text}`);
      return 77;
    },
    sendTextReply: async () => ({ ok: true }),
    editInteractiveMessage: async () => events.push("edit"),
    deleteMessage: async () => undefined,
    dispatchNextQueuedTelegramTurn: () => {},
    answerGuestQuery: async () => ({ ok: true }),
    sendGuestReply: async () => ({ ok: true }),
    finalizeMarkdownPreview: async () => undefined,
    proactivePushChatIdGetter: () => undefined,
    isProactivePushEnabled: () => false,
    updateStatus: () => {},
    recordRuntimeEvent: () => {},
  } as unknown as Parameters<typeof registerTelegramLifecycleRuntimeHooks>[0];
  registerTelegramLifecycleRuntimeHooks(deps);

  await getRequiredBindingHandler(harness.handlers, "message_start")(
    { message: {} },
    {} as ExtensionContext,
  );
  await getRequiredBindingHandler(harness.handlers, "message_update")(
    {
      message: {},
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "ponder <edge>",
      },
    },
    {} as ExtensionContext,
  );
  await getRequiredBindingHandler(harness.handlers, "tool_execution_start")(
    {
      type: "tool_execution_start",
      toolCallId: "1",
      toolName: "read",
      args: { path: "README.md" },
    },
    {} as ExtensionContext,
  );
  await getRequiredBindingHandler(harness.handlers, "session_before_compact")(
    { type: "session_before_compact" },
    {} as ExtensionContext,
  );

  assert.deepEqual(events, [
    "typing:42:9",
    "preview:start",
    "typing:42:9",
    "typing:42:9",
    "preview:update",
    "typing:42:9",
    "typing:42:9",
  ]);
});
