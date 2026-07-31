/**
 * Regression tests for Telegram settings menu helpers
 * Exercises settings text/markup, callback mutations, stale-message fallback, and runtime wiring
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildActivityVerbositySettingsReplyMarkup,
  buildActivityVerbositySettingsText,
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
  buildTimeInjectionModeSettingsText,
  buildVoiceReplyModeSettingsReplyMarkup,
  buildVoiceReplyModeSettingsText,
  createTelegramSettingsMenuRuntime,
  handleTelegramSettingsMenuCallbackAction,
} from "../lib/menu-settings.ts";

function getSettingsDescriptionOrder(text: string): string[] {
  return Array.from(
    text.matchAll(/<code>-<\/code> <code>([^<]+)<\/code>/gu),
    (match) => match[1]!,
  );
}

function getSettingsControlOrder(markup: {
  inline_keyboard: Array<Array<{ callback_data: string }>>;
}): string[] {
  return markup.inline_keyboard
    .slice(1)
    .flat()
    .map((button) => button.callback_data.split(":").at(-1)!);
}

test("Settings descriptions follow visible control order", () => {
  const surfaces = [
    [
      buildAutomaticThreadCleanupSettingsText(true),
      buildAutomaticThreadCleanupSettingsReplyMarkup(true),
    ],
    [
      buildProactivePushSettingsText(true),
      buildProactivePushSettingsReplyMarkup(true),
    ],
    [
      buildDraftPreviewsSettingsText(false),
      buildDraftPreviewsSettingsReplyMarkup(false),
    ],
    [
      buildAssistantRenderingSettingsText("rich"),
      buildAssistantRenderingSettingsReplyMarkup("rich"),
    ],
    [
      buildActivityVerbositySettingsText("verbose"),
      buildActivityVerbositySettingsReplyMarkup("verbose"),
    ],
    [
      buildVoiceReplyModeSettingsText("hidden"),
      buildVoiceReplyModeSettingsReplyMarkup("hidden"),
    ],
    [
      buildTimeInjectionModeSettingsText("interval"),
      buildTimeInjectionModeSettingsReplyMarkup("interval"),
    ],
  ] as const;

  for (const [text, markup] of surfaces) {
    assert.deepEqual(
      getSettingsDescriptionOrder(text),
      getSettingsControlOrder(markup),
    );
  }
});

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
      "settings:open:draft-previews",
      "settings:open:assistant-rendering",
      "settings:open:voice-reply",
      "settings:open:activity-verbosity",
      "settings:open:proactive",
      "settings:open:time-injection",
      "settings:open:automatic-thread-cleanup",
    ],
  );
  assert.equal(
    markup.inline_keyboard[1]?.[0]?.text,
    "📝 Draft previews: off",
  );
  assert.equal(markup.inline_keyboard[2]?.[0]?.text, "🧾 Rendering: rich");
  assert.equal(
    markup.inline_keyboard[3]?.[0]?.text,
    "👄 Voice reply: hidden",
  );
  assert.equal(markup.inline_keyboard[4]?.[0]?.text, "🔬 Activity: quiet");
  assert.equal(markup.inline_keyboard[5]?.[0]?.text, "📌 Proactive push: on");
  assert.equal(markup.inline_keyboard[6]?.[0]?.text, "🕒 Time injection: hidden");
  assert.equal(markup.inline_keyboard[7]?.[0]?.text, "🧹 Thread cleanup: on");
});

test("Settings detail markups show active values", () => {
  const cleanupText = buildAutomaticThreadCleanupSettingsText(true);
  assert.match(cleanupText, /<code>on<\/code>/);
  assert.match(
    cleanupText,
    /manual <code>\/telegram-disconnect<\/code> still confirms/,
  );
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

test("Activity settings expose quiet, thinking, tools, and verbose", () => {
  const text = buildActivityVerbositySettingsText("thinking");
  assert.match(text, /<code>thinking<\/code>/);
  assert.match(text, /persistent collapsed thinking/);
  const labels = buildActivityVerbositySettingsReplyMarkup("tools")
    .inline_keyboard.flat()
    .map((button) => button.text);
  assert.deepEqual(labels, [
    "⬆️ Back",
    "quiet",
    "thinking",
    "🟢 tools",
    "verbose",
  ]);
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
    getActivityVerbosity: () => "quiet" as const,
    setProactivePushEnabled: async (enabled: boolean) => {
      calls.push(`proactive:${enabled}`);
    },
    setDraftPreviewsEnabled: async (enabled: boolean) => {
      calls.push(`draft-previews:${enabled}`);
    },
    setAssistantRenderingMode: async (mode: "rich" | "html") => {
      calls.push(`rendering:${mode}`);
    },
    setActivityVerbosity: async (
      verbosity: "quiet" | "thinking" | "tools" | "verbose",
    ) => {
      calls.push(`activity:${verbosity}`);
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
      "settings:set:activity-verbosity:verbose",
      deps,
    ),
    true,
  );
  assert.equal(
    await handleTelegramSettingsMenuCallbackAction(
      "q6",
      "settings:set:proactive:on",
      deps,
    ),
    true,
  );
  assert.equal(
    await handleTelegramSettingsMenuCallbackAction(
      "q7",
      "settings:set:automatic-thread-cleanup:off",
      deps,
    ),
    true,
  );
  assert.equal(
    await handleTelegramSettingsMenuCallbackAction("q8", "other", deps),
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
    "activity:verbose",
    "update:<b>🔬 Activity:</b> <code>quiet</code>",
    "answer:Activity: verbose",
    "proactive:true",
    "update:<b>📌 Proactive push:</b> <code>off</code>",
    "answer:Proactive push enabled",
    "automatic-thread-cleanup:false",
    "update:<b>🧹 Thread cleanup:</b> <code>on</code>",
    "answer:Thread cleanup disabled",
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
  let editedActivityLabel = "";
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
    getActivityVerbosity: () => "verbose",
    setProactivePushEnabled: async (enabled) => {
      calls.push(`proactive:${enabled}`);
    },
    setDraftPreviewsEnabled: async (enabled) => {
      calls.push(`draft-previews:${enabled}`);
    },
    setAssistantRenderingMode: async (mode) => {
      calls.push(`rendering:${mode}`);
    },
    setActivityVerbosity: async (activity) => {
      calls.push(`activity:${activity}`);
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
    editInteractiveMessage: async (
      _chatId,
      _messageId,
      _text,
      _mode,
      markup,
    ) => {
      editedActivityLabel =
        markup.inline_keyboard
          .flat()
          .find(
            (button) =>
              button.callback_data === "settings:open:activity-verbosity",
          )?.text ?? "";
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
  assert.equal(editedActivityLabel, "🔬 Activity: verbose");

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
