/**
 * Regression tests for Telegram settings menu helpers
 * Exercises settings text/markup, callback mutations, stale-message fallback, and runtime wiring
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAssistantRenderingSettingsReplyMarkup,
  buildAssistantRenderingSettingsText,
  buildAutomaticThreadCleanupSettingsReplyMarkup,
  buildAutomaticThreadCleanupSettingsText,
  buildDraftPreviewsSettingsReplyMarkup,
  buildDraftPreviewsSettingsText,
  buildProactivePushSettingsReplyMarkup,
  buildProactivePushSettingsText,
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
    "hidden",
    "hidden",
    undefined,
    false,
  );

  assert.deepEqual(
    markup.inline_keyboard.map((row) => row[0]?.callback_data),
    [
      "menu:back",
      "settings:open:automatic-thread-cleanup",
      "settings:open:voice-reply",
      "settings:open:time-injection",
      "settings:open:draft-previews",
      "settings:open:assistant-rendering",
      "settings:open:proactive",
    ],
  );
  assert.equal(
    markup.inline_keyboard[1]?.[0]?.text,
    "🧹 Auto thread cleanup: on",
  );
  assert.equal(markup.inline_keyboard[2]?.[0]?.text, "👄 Voice reply: hidden");
  assert.equal(
    markup.inline_keyboard[3]?.[0]?.text,
    "🕒 Time injection: hidden",
  );
  assert.equal(markup.inline_keyboard[4]?.[0]?.text, "📝 Draft previews: off");
  assert.equal(markup.inline_keyboard[5]?.[0]?.text, "🧾 Rendering: rich");
  assert.equal(markup.inline_keyboard[6]?.[0]?.text, "📌 Proactive push: on");
});

test("Settings detail markups show active values", () => {
  const cleanupText = buildAutomaticThreadCleanupSettingsText(true);
  assert.match(cleanupText, /<code>on<\/code>/);
  assert.match(cleanupText, /manual \/telegram-disconnect still confirms/);
  assert.equal(
    buildAutomaticThreadCleanupSettingsReplyMarkup(false).inline_keyboard[1]?.[1]
      ?.text,
    "🟡 Off",
  );
  const proactiveText = buildProactivePushSettingsText(true);
  assert.match(proactiveText, /<code>on<\/code>/);
  assert.match(proactiveText, /<code>off<\/code>:/);
  assert.match(proactiveText, /<code>on<\/code> \(default\):/);
  assert.match(proactiveText, /visible checkpoints and the final answer/);
  assert.ok(
    proactiveText.indexOf("<code>on</code> (default):") <
      proactiveText.indexOf("<code>off</code>:"),
  );
  assert.match(buildDraftPreviewsSettingsText(false), /<code>off<\/code>/);
  assert.equal(
    buildDraftPreviewsSettingsReplyMarkup(true).inline_keyboard[1]?.[0]?.text,
    "🟢 On",
  );
  assert.match(
    buildAssistantRenderingSettingsText("html"),
    /<code>html<\/code>/,
  );
  assert.equal(
    buildAssistantRenderingSettingsReplyMarkup("rich").inline_keyboard[1]?.[0]
      ?.text,
    "🟢 rich",
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
      .inline_keyboard[2]?.[0]?.text,
    "🟢 mirror",
  );
  assert.equal(
    buildVoiceReplyModeSettingsReplyMarkup("hidden", false)
      .inline_keyboard[1]?.[0]?.text,
    "🟢 hidden",
  );
});

test("Settings callback action mutates voice, time, and proactive settings", async () => {
  const calls: string[] = [];
  const deps = {
    isProactivePushEnabled: () => false,
    getVoiceReplyMode: () => "hidden" as const,
    isVoiceReplyModeConfigured: () => true,
    getTimeInjectionMode: () => "hidden" as const,
    isAutomaticThreadCleanupEnabled: () => true,
    areDraftPreviewsEnabled: () => false,
    getAssistantRenderingMode: () => "rich" as const,
    setProactivePushEnabled: async (enabled: boolean) => {
      calls.push(`proactive:${enabled}`);
    },
    setDraftPreviewsEnabled: async (enabled: boolean) => {
      calls.push(`draft-previews:${enabled}`);
    },
    setAssistantRenderingMode: async (mode: "rich" | "html") => {
      calls.push(`rendering:${mode}`);
    },
    setVoiceReplyMode: async (
      mode: "hidden" | "mirror" | "always" | undefined,
    ) => {
      calls.push(`voice:${mode ?? "hidden"}`);
    },
    setTimeInjectionMode: async (mode: "hidden" | "always" | "interval") => {
      calls.push(`time:${mode}`);
    },
    setAutomaticThreadCleanupEnabled: async (enabled: boolean) => {
      calls.push(`automatic-thread-cleanup:${enabled}`);
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
      "settings:set:draft-previews:on",
      deps,
    ),
    true,
  );
  assert.equal(
    await handleTelegramSettingsMenuCallbackAction(
      "q4",
      "settings:set:assistant-rendering:html",
      deps,
    ),
    true,
  );
  assert.equal(
    await handleTelegramSettingsMenuCallbackAction(
      "q5",
      "settings:set:proactive:on",
      deps,
    ),
    true,
  );
  assert.equal(
    await handleTelegramSettingsMenuCallbackAction(
      "q6",
      "settings:set:automatic-thread-cleanup:off",
      deps,
    ),
    true,
  );
  assert.equal(
    await handleTelegramSettingsMenuCallbackAction("q7", "other", deps),
    false,
  );

  assert.deepEqual(calls, [
    "voice:hidden",
    "update:<b>👄 Voice reply mode:</b> <code>hidden</code>",
    "answer:Voice reply mode: hidden",
    "time:hidden",
    "update:<b>🕒 Time injection mode:</b> <code>hidden</code>",
    "answer:Time injection: hidden",
    "draft-previews:true",
    "update:<b>📝 Draft previews:</b> <code>off</code>",
    "answer:Draft previews enabled",
    "rendering:html",
    "update:<b>🧾 Assistant rendering:</b> <code>rich</code>",
    "answer:Rendering: html",
    "proactive:true",
    "update:<b>📌 Proactive push:</b> <code>off</code>",
    "answer:Proactive push enabled",
    "automatic-thread-cleanup:false",
    "update:<b>🧹 Automatic thread cleanup:</b> <code>on</code>",
    "answer:Automatic thread cleanup disabled",
  ]);
});

test("Settings runtime opens menus and rehydrates stale callback state", async () => {
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
  let storedState: typeof state | undefined;
  const runtime = createTelegramSettingsMenuRuntime({
    reloadConfig: async () => {
      calls.push("reload-config");
    },
    isProactivePushEnabled: () => true,
    getVoiceReplyMode: () => "hidden",
    isVoiceReplyModeConfigured: () => true,
    getTimeInjectionMode: () => "hidden",
    isAutomaticThreadCleanupEnabled: () => true,
    areDraftPreviewsEnabled: () => false,
    getAssistantRenderingMode: () => "rich",
    setProactivePushEnabled: async (enabled) => {
      calls.push(`proactive:${enabled}`);
    },
    setDraftPreviewsEnabled: async (enabled) => {
      calls.push(`draft-previews:${enabled}`);
    },
    setAssistantRenderingMode: async (mode) => {
      calls.push(`rendering:${mode}`);
    },
    setVoiceReplyMode: async (mode) => {
      calls.push(`voice:${mode ?? "hidden"}`);
    },
    setTimeInjectionMode: async (mode) => {
      calls.push(`time:${mode}`);
    },
    setAutomaticThreadCleanupEnabled: async (enabled) => {
      calls.push(`automatic-thread-cleanup:${enabled}`);
    },
    getModelMenuState: async (_chatId, _ctx, threadId) => {
      state.threadId = threadId;
      return state;
    },
    getStoredModelMenuState: () => storedState,
    storeModelMenuState: (nextState) => {
      storedState = nextState;
      calls.push(`store:${nextState.mode}`);
    },
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
  assert.deepEqual(calls, [
    "reload-config",
    "send:html",
    "store:settings",
  ]);

  calls.length = 0;
  await runtime.updateSettingsMenuMessage(state, "ctx");
  assert.deepEqual(calls, ["reload-config", "edit"]);

  storedState = undefined;
  calls.length = 0;
  assert.equal(
    await runtime.handleCallbackQuery(
      {
        id: "q1",
        data: "settings:set:voice-reply:always",
        message: { message_id: 99, message_thread_id: 7, chat: { id: 1 } },
      },
      "ctx",
    ),
    true,
  );
  assert.equal(storedState?.threadId, 7);
  assert.equal(
    await runtime.handleCallbackQuery(
      {
        id: "q2",
        data: "settings:set:time:off",
        message: { message_id: 99, chat: { id: 1 } },
      },
      "ctx",
    ),
    true,
  );
  assert.deepEqual(calls, [
    "reload-config",
    "store:settings",
    "voice:always",
    "edit",
    "answer:Voice reply mode: always",
    "reload-config",
    "time:hidden",
    "edit",
    "answer:Time injection: hidden",
  ]);
});
