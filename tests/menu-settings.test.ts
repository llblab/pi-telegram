/**
 * Regression tests for Telegram settings menu helpers
 * Exercises settings text/markup, callback mutations, stale-message fallback, and runtime wiring
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProactivePushSettingsReplyMarkup,
  buildProactivePushSettingsText,
  buildRichDraftPreviewsSettingsReplyMarkup,
  buildRichDraftPreviewsSettingsText,
  buildTelegramSettingsMenuReplyMarkup,
  buildTelegramSettingsMenuText,
  buildTimeInjectionModeSettingsReplyMarkup,
  buildVoiceReplyModeSettingsReplyMarkup,
  createTelegramSettingsMenuRuntime,
  handleTelegramSettingsMenuCallbackAction,
} from "../lib/menu-settings.ts";

test("Settings menu text and reply markup expose built-in controls", () => {
  assert.equal(buildTelegramSettingsMenuText(), "<b>⚙️ Settings:</b>");

  const markup = buildTelegramSettingsMenuReplyMarkup(
    true,
    false,
    "manual",
    "hidden",
    undefined,
    false,
  );

  assert.deepEqual(
    markup.inline_keyboard.map((row) => row[0]?.callback_data),
    [
      "menu:back",
      "settings:open:voice-reply",
      "settings:open:time-injection",
      "settings:open:rich-drafts",
      "settings:open:proactive",
    ],
  );
  assert.equal(markup.inline_keyboard[1]?.[0]?.text, "👄 Voice reply: hidden");
  assert.equal(
    markup.inline_keyboard[2]?.[0]?.text,
    "🕒 Time injection: hidden",
  );
  assert.equal(markup.inline_keyboard[3]?.[0]?.text, "📝 Rich drafts: off");
  assert.equal(markup.inline_keyboard[4]?.[0]?.text, "📌 Proactive push: on");
});

test("Settings detail markups show active values", () => {
  assert.match(buildProactivePushSettingsText(true), /<code>on<\/code>/);
  assert.match(buildRichDraftPreviewsSettingsText(false), /<code>off<\/code>/);
  assert.equal(
    buildRichDraftPreviewsSettingsReplyMarkup(true).inline_keyboard[1]?.[0]?.text,
    "🟢 On",
  );
  assert.equal(
    buildProactivePushSettingsReplyMarkup(false).inline_keyboard[1]?.[1]?.text,
    "🟡 Off",
  );
  assert.equal(
    buildTimeInjectionModeSettingsReplyMarkup("interval")
      .inline_keyboard[3]?.[0]?.text,
    "🟢 interval",
  );
  assert.equal(
    buildVoiceReplyModeSettingsReplyMarkup("mirror", true)
      .inline_keyboard[3]?.[0]?.text,
    "🟢 mirror",
  );
  assert.equal(
    buildVoiceReplyModeSettingsReplyMarkup("manual", false)
      .inline_keyboard[1]?.[0]?.text,
    "🟢 hidden",
  );
});

test("Settings callback action mutates voice, time, and proactive settings", async () => {
  const calls: string[] = [];
  const deps = {
    isProactivePushEnabled: () => false,
    getVoiceReplyMode: () => "manual" as const,
    isVoiceReplyModeConfigured: () => true,
    getTimeInjectionMode: () => "hidden" as const,
    areRichDraftPreviewsEnabled: () => false,
    setProactivePushEnabled: async (enabled: boolean) => {
      calls.push(`proactive:${enabled}`);
    },
    setRichDraftPreviewsEnabled: async (enabled: boolean) => {
      calls.push(`rich-drafts:${enabled}`);
    },
    setVoiceReplyMode: async (
      mode: "manual" | "mirror" | "always" | undefined,
    ) => {
      calls.push(`voice:${mode ?? "hidden"}`);
    },
    setTimeInjectionMode: async (mode: "hidden" | "always" | "interval") => {
      calls.push(`time:${mode}`);
    },
    updateSettingsMessage: async (text: string) => {
      calls.push(`update:${text.split("\n")[0]}`);
    },
    answerCallbackQuery: async (_id: string, text?: string) => {
      calls.push(`answer:${text ?? ""}`);
    },
  };

  assert.equal(
    await handleTelegramSettingsMenuCallbackAction(
      "q1",
      "settings:set:voice-reply:hidden",
      deps,
    ),
    true,
  );
  assert.equal(
    await handleTelegramSettingsMenuCallbackAction(
      "q2",
      "settings:set:time:off",
      deps,
    ),
    true,
  );
  assert.equal(
    await handleTelegramSettingsMenuCallbackAction(
      "q3",
      "settings:set:rich-drafts:on",
      deps,
    ),
    true,
  );
  assert.equal(
    await handleTelegramSettingsMenuCallbackAction(
      "q4",
      "settings:set:proactive:on",
      deps,
    ),
    true,
  );
  assert.equal(
    await handleTelegramSettingsMenuCallbackAction("q5", "other", deps),
    false,
  );

  assert.deepEqual(calls, [
    "voice:hidden",
    "update:<b>👄 Voice reply mode:</b> <code>manual</code>",
    "answer:Voice reply mode: hidden",
    "time:hidden",
    "update:<b>🕒 Time injection mode:</b> <code>hidden</code>",
    "answer:Time injection: hidden",
    "rich-drafts:true",
    "update:<b>📝 Rich draft previews:</b> <code>off</code>",
    "answer:Rich draft previews enabled",
    "proactive:true",
    "update:<b>📌 Proactive push:</b> <code>off</code>",
    "answer:Proactive push enabled",
  ]);
});

test("Settings runtime opens menus and applies stale-message fallback toggles", async () => {
  const state: any = {
    chatId: 1,
    messageId: 2,
    mode: "status",
    page: 0,
    scope: "all",
    scopedModels: [],
    allModels: [],
  };
  const calls: string[] = [];
  const runtime = createTelegramSettingsMenuRuntime({
    isProactivePushEnabled: () => true,
    getVoiceReplyMode: () => "manual",
    isVoiceReplyModeConfigured: () => true,
    getTimeInjectionMode: () => "hidden",
    areRichDraftPreviewsEnabled: () => false,
    setProactivePushEnabled: async (enabled) => {
      calls.push(`proactive:${enabled}`);
    },
    setRichDraftPreviewsEnabled: async (enabled) => {
      calls.push(`rich-drafts:${enabled}`);
    },
    setVoiceReplyMode: async (mode) => {
      calls.push(`voice:${mode ?? "hidden"}`);
    },
    setTimeInjectionMode: async (mode) => {
      calls.push(`time:${mode}`);
    },
    getModelMenuState: async () => state,
    getStoredModelMenuState: () => undefined,
    storeModelMenuState: (nextState) => calls.push(`store:${nextState.mode}`),
    editInteractiveMessage: async () => {
      calls.push("edit");
    },
    sendInteractiveMessage: async (_chatId, _text, mode) => {
      calls.push(`send:${mode}`);
      return 99;
    },
    answerCallbackQuery: async (_id, text) => {
      calls.push(`answer:${text ?? ""}`);
    },
  });

  await runtime.openSettingsMenu(1, 2, "ctx");
  assert.equal(state.messageId, 99);
  assert.equal(state.mode, "settings");

  assert.equal(
    await runtime.handleCallbackQuery(
      { id: "q1", data: "settings:set:voice-reply:always" },
      "ctx",
    ),
    true,
  );
  assert.equal(
    await runtime.handleCallbackQuery(
      { id: "q2", data: "settings:set:time:off" },
      "ctx",
    ),
    true,
  );
  assert.deepEqual(calls, [
    "send:html",
    "store:settings",
    "voice:always",
    "answer:Voice reply mode: always",
    "time:hidden",
    "answer:Time injection: hidden",
  ]);
});
