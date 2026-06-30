/**
 * Regression tests for Telegram status menu helpers
 * Exercises status-menu reply markup, callback routing, and message render/update helpers
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStatusReplyMarkup,
  buildTelegramStatusMenuRenderPayload,
  handleTelegramStatusMenuCallbackAction,
  openTelegramStatusMenu,
  sendTelegramStatusMessage,
  updateTelegramStatusMessage,
} from "../lib/menu-status.ts";

const reasoningModel = {
  provider: "openai",
  id: "gpt-5",
  reasoning: true,
};

test("Status menu reply markup exposes model, thinking, queue, and settings rows", () => {
  const markup = buildStatusReplyMarkup(reasoningModel, "medium", 2);

  assert.deepEqual(
    markup.inline_keyboard.map((row) => row[0]?.callback_data),
    ["menu:model", "menu:thinking", "menu:queue", "menu:settings"],
  );
  assert.equal(
    markup.inline_keyboard[0]?.[0]?.text.startsWith("🤖 Model"),
    true,
  );
  assert.equal(
    markup.inline_keyboard[1]?.[0]?.text.startsWith("🧠 Thinking"),
    true,
  );
  assert.equal(markup.inline_keyboard[2]?.[0]?.text, "⏳ Queue: 2");
});

test("Status menu hides thinking row for non-reasoning and voice-active states", () => {
  assert.deepEqual(
    buildStatusReplyMarkup(
      { provider: "x", id: "plain" },
      "off",
      0,
    ).inline_keyboard.map((row) => row[0]?.callback_data),
    ["menu:model", "menu:queue", "menu:settings"],
  );
  assert.deepEqual(
    buildStatusReplyMarkup(
      reasoningModel,
      "medium",
      0,
      undefined,
      true,
    ).inline_keyboard.map((row) => row[0]?.callback_data),
    ["menu:model", "menu:queue", "menu:settings"],
  );
});

test("Status callback routing updates target menus and guards thinking controls", async () => {
  const calls: string[] = [];
  const deps = {
    updateModelMenuMessage: async () => {
      calls.push("model");
    },
    updateThinkingMenuMessage: async () => {
      calls.push("thinking");
    },
    updateSettingsMenuMessage: async () => {
      calls.push("settings");
    },
    answerCallbackQuery: async (_id: string, text?: string) => {
      calls.push(text ?? "answered");
    },
  };

  assert.equal(
    await handleTelegramStatusMenuCallbackAction(
      "q1",
      "status:model",
      reasoningModel,
      deps,
    ),
    true,
  );
  assert.equal(
    await handleTelegramStatusMenuCallbackAction(
      "q2",
      "menu:thinking",
      reasoningModel,
      deps,
    ),
    true,
  );
  assert.equal(
    await handleTelegramStatusMenuCallbackAction(
      "q3",
      "menu:settings",
      reasoningModel,
      deps,
    ),
    true,
  );
  assert.equal(
    await handleTelegramStatusMenuCallbackAction(
      "q4",
      "menu:unknown",
      reasoningModel,
      deps,
    ),
    false,
  );

  assert.deepEqual(calls, [
    "model",
    "answered",
    "thinking",
    "answered",
    "settings",
    "answered",
  ]);

  const voiceCalls: string[] = [];
  assert.equal(
    await handleTelegramStatusMenuCallbackAction(
      "q5",
      "menu:thinking",
      reasoningModel,
      {
        ...deps,
        isVoiceReplyActive: () => true,
        answerCallbackQuery: async (_id, text) => {
          voiceCalls.push(text ?? "");
        },
      },
    ),
    true,
  );
  assert.deepEqual(voiceCalls, [
    "Thinking controls are disabled during voice replies.",
  ]);
});

test("Status menu open, send, and update helpers apply status mode", async () => {
  const state: any = {
    chatId: 1,
    threadId: 42,
    messageId: 2,
    mode: "model" as const,
    page: 0,
    scope: "all",
    scopedModels: [],
    allModels: [],
  };
  const stored: unknown[] = [];
  await openTelegramStatusMenu({
    isIdle: () => true,
    sendBusyMessage: async () => {},
    getModelMenuState: async () => state,
    buildStatusHtml: () => "<b>Status</b>",
    getActiveModel: () => reasoningModel,
    getThinkingLevel: () => "medium",
    getQueueItemCount: () => 1,
    sendStatusMenu: async (_state, html, _model, thinking, queueCount) => {
      stored.push({ html, thinking, queueCount });
      return 99;
    },
    storeModelMenuState: (nextState) => stored.push(nextState),
  });

  assert.equal(state.messageId, 99);
  assert.equal(state.mode, "status");

  const payload = buildTelegramStatusMenuRenderPayload(
    "status html",
    reasoningModel,
    "medium",
    1,
  );
  assert.equal(payload.nextMode, "status");
  assert.equal(payload.mode, "html");

  const messages: unknown[] = [];
  const deps = {
    editInteractiveMessage: async (...args: unknown[]) => {
      messages.push(["edit", ...args]);
    },
    sendInteractiveMessage: async (...args: unknown[]) => {
      messages.push(["send", ...args]);
      return 123;
    },
  };

  await updateTelegramStatusMessage(
    state,
    "updated",
    reasoningModel,
    "medium",
    deps,
    0,
  );
  const sentId = await sendTelegramStatusMessage(
    state,
    "sent",
    reasoningModel,
    "medium",
    deps,
    0,
  );

  assert.equal(sentId, 123);
  assert.equal(state.mode, "status");
  assert.equal(messages.length, 2);
  const sentMessage = messages[1] as unknown[];
  assert.equal(sentMessage[0], "send");
  assert.equal(sentMessage[1], 1);
  assert.equal(sentMessage[3], "html");
  assert.deepEqual(sentMessage[5], { target: { chatId: 1, threadId: 42 } });
});
