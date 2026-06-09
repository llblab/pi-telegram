/**
 * Regression tests for Telegram binding composition
 * Covers lifecycle binding delegation across composed runtimes
 */

import assert from "node:assert/strict";
import test from "node:test";

import { registerTelegramLifecycleRuntimeHooks } from "../lib/bindings.ts";
import type { ExtensionAPI, ExtensionContext } from "../lib/pi.ts";

type RegisteredBindingHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => Promise<unknown> | unknown;

function createBindingApiHarness() {
  const handlers = new Map<string, RegisteredBindingHandler>();
  const api = {
    on: (event: string, handler: RegisteredBindingHandler) => {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  return { api, handlers };
}

function getRequiredBindingHandler(
  handlers: Map<string, RegisteredBindingHandler>,
  name: string,
): RegisteredBindingHandler {
  const handler = handlers.get(name);
  assert.ok(handler, `Expected binding handler ${name}`);
  return handler;
}

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
    configStore: { getOutboundHandlers: () => [] },
    abort: { setHandler: () => {}, clearHandler: () => {} },
    typing: { stop: () => {}, waitForIdle: async () => {} },
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
    promptDispatchRuntime: { startTypingLoop: () => {} },
    deferredQueueDispatchRuntime: { request: () => {} },
    lockOwnershipGuard: { ownsContext: () => false },
    buttonActionStore: { register: () => "button-action" },
    callMultipart: async () => ({ ok: true }),
    sendChatAction: async () => ({ ok: true }),
    sendRecordVoiceAction: async () => ({ ok: true }),
    sendMarkdownReply: async () => ({ ok: true }),
    sendTextReply: async () => ({ ok: true }),
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
  await getRequiredBindingHandler(harness.handlers, "session_shutdown")(
    {},
    {} as ExtensionContext,
  );

  assert.deepEqual(events, ["composed-shutdown"]);
});
