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
  buildInactiveThreadReviewReplyMarkup,
  buildTelegramSettingsMenuReplyMarkup,
  buildThreadDisplaySettingsReplyMarkup,
  buildThreadDisplaySettingsText,
  type TelegramSettingsMenuCallbackDeps,
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
  inline_keyboard: Array<Array<{ callback_data?: string }>>;
}): string[] {
  return markup.inline_keyboard
    .slice(1)
    .flat()
    .map((button) => {
      assert.ok(button.callback_data);
      return button.callback_data.split(":").at(-1)!;
    });
}

test("Thread display Settings offer the three automatic modes and gate mutation", async () => {
  const markup = buildThreadDisplaySettingsReplyMarkup("letters");
  const root = buildTelegramSettingsMenuReplyMarkup(true, "rich", "manual", "hidden", undefined, false, false, "verbose", "names");
  assert.ok(root.inline_keyboard.flat().some((button) => button.callback_data === "settings:open:thread-display"));
  const classic = buildTelegramSettingsMenuReplyMarkup(true, "rich", "manual", "hidden");
  assert.equal(classic.inline_keyboard.flat().some((button) => button.callback_data === "settings:open:thread-display"), false);
  assert.deepEqual(getSettingsControlOrder(markup), ["letters", "names", "directories"]);
  assert.equal(markup.inline_keyboard[1][0].text, "🟢 letters");
  const calls: string[] = [];
  let currentMode: "letters" | "names" | "directories" = "names";
  let renderedText = "";
  let fail = false;
  const deps: TelegramSettingsMenuCallbackDeps = {
    getThreadDisplayMode: () => currentMode,
    async setThreadDisplayMode(mode) {
      calls.push(`set:${mode}`);
      if (fail) throw new Error("partial failure");
      currentMode = mode;
    },
    areDraftPreviewsEnabled: () => true,
    getAssistantRenderingMode: () => "rich", getActivityVerbosity: () => "verbose",
    getTimeInjectionMode: () => "hidden", getVoiceReplyMode: () => "manual",
    isVoiceReplyModeConfigured: () => false, isAutomaticThreadCleanupEnabled: () => false,
    async setDraftPreviewsEnabled() {}, async setAssistantRenderingMode() {},
    async setActivityVerbosity() {}, async setVoiceReplyMode() {},
    async setTimeInjectionMode() {}, async setAutomaticThreadCleanupEnabled() {},
    async updateSettingsMessage(text) { renderedText = text; calls.push("update"); },
    async answerCallbackQuery(_id, text) { calls.push(text ?? "ack"); },
  };
  await handleTelegramSettingsMenuCallbackAction("q", "settings:open:thread-display", deps);
  assert.deepEqual(calls, ["update", "ack"]);
  assert.equal(renderedText, buildThreadDisplaySettingsText("names"));
  calls.length = 0;
  await handleTelegramSettingsMenuCallbackAction("q", "settings:set:thread-display:directories", deps);
  assert.deepEqual(calls, ["set:directories", "update", "ack"]);
  assert.equal(renderedText, buildThreadDisplaySettingsText("directories"));
  calls.length = 0;
  await handleTelegramSettingsMenuCallbackAction("q", "settings:set:thread-display:names", deps);
  assert.deepEqual(calls, ["set:names", "update", "ack"]);
  assert.equal(renderedText, buildThreadDisplaySettingsText("names"));
  calls.length = 0;
  fail = true;
  await handleTelegramSettingsMenuCallbackAction("q", "settings:set:thread-display:letters", deps);
  assert.equal(calls.includes("update"), false);
  assert.match(calls.at(-1)!, /not fully applied/);
  calls.length = 0;
  await handleTelegramSettingsMenuCallbackAction("q", "settings:set:thread-display:invalid", deps);
  assert.deepEqual(calls, ["Unknown Thread display mode."]);
  calls.length = 0;
  await handleTelegramSettingsMenuCallbackAction("q", "settings:set:thread-display:letters", {
    ...deps, getThreadDisplayMode: () => undefined,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /requires Threaded Mode/);
});

test("Settings descriptions follow visible control order", () => {
  const surfaces = [
    [
      buildAutomaticThreadCleanupSettingsText(true),
      buildAutomaticThreadCleanupSettingsReplyMarkup(true),
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
      buildVoiceReplyModeSettingsText("manual"),
      buildVoiceReplyModeSettingsReplyMarkup("manual"),
    ],
    [
      buildTimeInjectionModeSettingsText("interval"),
      buildTimeInjectionModeSettingsReplyMarkup("interval"),
    ],
    [
      buildThreadDisplaySettingsText("names"),
      buildThreadDisplaySettingsReplyMarkup("names"),
    ],
  ] as const;

  for (const [text, markup] of surfaces) {
    assert.deepEqual(
      getSettingsDescriptionOrder(text),
      getSettingsControlOrder(markup),
    );
  }
});

test("Thread display detail follows the setting-card style and marks only the current option", () => {
  const values = ["letters", "names", "directories"] as const;
  for (const mode of values) {
    const text = buildThreadDisplaySettingsText(mode);
    assert.ok(text.startsWith(`<b>🧵 Thread display:</b> <code>${mode}</code>\n`));
    assert.deepEqual(getSettingsDescriptionOrder(text), values);
    assert.equal((text.match(/\(default\)/gu) ?? []).length, 1);
    assert.match(text, /Choose how this bot profile labels Telegram tabs and Pi terminal status\. Each slot is unique across this bot profile\./u);
    assert.match(text, /<code>letters<\/code> \(default\):/u);
    assert.match(text, /manual <code>\/name Name<\/code> overrides/u);
    for (const example of ["A", "B", "Anchor", "Briar", "extensions", "extensions_a", "extensions_c"]) {
      assert.match(text, new RegExp(`<b><i>${example}</i></b>`, "u"));
    }
    assert.doesNotMatch(text, /Switching changes labels only/u);
    assert.ok(text.endsWith("until reset."));
    const rows = buildThreadDisplaySettingsReplyMarkup(mode).inline_keyboard;
    assert.deepEqual(rows[0], [{ text: "⬆️ Back", callback_data: "settings:list" }]);
    assert.deepEqual(rows.slice(1).map((row) => row[0].text),
      values.map((value) => `${mode === value ? "🟢 " : ""}${value}`));
    assert.ok(rows.every((row) => row.length === 1));
  }
});

test("Draft preview settings identify on as the default without changing the current state label", () => {
  for (const enabled of [false, true]) {
    const text = buildDraftPreviewsSettingsText(enabled);
    assert.match(text, new RegExp(`<code>${enabled ? "on" : "off"}</code>$`, "m"));
    assert.match(text, /<code>on<\/code> \(default\):/);
    assert.doesNotMatch(text, /<code>off<\/code> \(default\):/);
  }
});

test("Settings menu text and reply markup expose built-in controls", () => {
  assert.equal(buildTelegramSettingsMenuText(), "<b>⚙️ Settings:</b>");

  const markup = buildTelegramSettingsMenuReplyMarkup(
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
      "settings:open:draft-previews",
      "settings:open:assistant-rendering",
      "settings:open:voice-reply",
      "settings:open:activity-verbosity",
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
    "👄 Voice reply: manual",
  );
  assert.equal(markup.inline_keyboard[4]?.[0]?.text, "🔬 Activity: quiet");
  assert.equal(markup.inline_keyboard[5]?.[0]?.text, "🕒 Time injection: hidden");
  assert.equal(markup.inline_keyboard[6]?.[0]?.text, "🧹 Thread cleanup: on");
});

test("Settings detail markups show active values", () => {
  const cleanupText = buildAutomaticThreadCleanupSettingsText(true);
  assert.match(cleanupText, /<code>on<\/code>/);
  assert.match(
    cleanupText,
    /manual <code>\/telegram-disconnect<\/code> still confirms/,
  );
  assert.match(cleanupText, /Review never deletes tabs\./);
  assert.equal(
    buildAutomaticThreadCleanupSettingsReplyMarkup(false).inline_keyboard[1]?.[1]
      ?.text,
    "🟡 Off",
  );
  assert.equal(buildAutomaticThreadCleanupSettingsReplyMarkup(false).inline_keyboard.length, 2);
  assert.equal(buildAutomaticThreadCleanupSettingsReplyMarkup(false, true).inline_keyboard[2]?.[0]?.text,
    "🔎 Review inactive tabs");
  const operationId = `thread-cleanup:${"a".repeat(32)}`;
  const confirmation = buildInactiveThreadReviewReplyMarkup(operationId, true);
  assert.equal(confirmation.inline_keyboard[1]?.[0]?.text, "🧹 Clean inactive tabs");
  assert.equal(confirmation.inline_keyboard[1]?.[0]?.callback_data?.length, 62);
  assert.equal(buildInactiveThreadReviewReplyMarkup("thread-cleanup:bad", true).inline_keyboard.length, 1);
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
    buildVoiceReplyModeSettingsReplyMarkup("manual", false)
      .inline_keyboard[1]?.[0]?.text,
    "🟢 manual",
  );
});

test("Activity settings expose quiet, thinking, tools, and verbose", () => {
  const text = buildActivityVerbositySettingsText("thinking");
  assert.match(text, /<code>thinking<\/code>/);
  assert.match(text, /persistent collapsed thinking/);
  const rows = buildActivityVerbositySettingsReplyMarkup("tools").inline_keyboard;
  const labels = rows.flat().map((button) => button.text);
  assert.deepEqual(labels, [
    "⬆️ Back",
    "quiet",
    "thinking",
    "🟢 tools",
    "verbose",
  ]);
  assert.deepEqual(rows.map((row) => row.map((button) => button.text)), [
    ["⬆️ Back"],
    ["quiet"],
    ["thinking", "🟢 tools"],
    ["verbose"],
  ]);
});

test("Settings callback action mutates live settings and retires stale proactive controls", async () => {
  const calls: string[] = [];
  const deps = {
    getVoiceReplyMode: () => "manual" as const,
    isVoiceReplyModeConfigured: () => true,
    getTimeInjectionMode: () => "hidden" as const,
    isAutomaticThreadCleanupEnabled: () => true,
    areDraftPreviewsEnabled: () => false,
    getAssistantRenderingMode: () => "rich" as const,
    getActivityVerbosity: () => "quiet" as const,
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
      mode: "manual" | "mirror" | "always" | undefined,
    ) => {
      calls.push(`voice:${mode ?? "manual"}`);
    },
    setTimeInjectionMode: async (mode: "hidden" | "always" | "interval") => {
      calls.push(`time:${mode}`);
    },
    setAutomaticThreadCleanupEnabled: async (enabled: boolean) => {
      calls.push(`automatic-thread-cleanup:${enabled}`);
    },
    reviewInactiveThreads: async () => ({ count: 2,
      operationId: `thread-cleanup:${"a".repeat(32)}` }),
    cleanInactiveThreads: async (operationId: string) => {
      calls.push(`clean:${operationId}`);
      return { deleted: 2, outcomeUnknown: 0, blocked: 1,
        recovery: "authority-blocked" as const };
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
      "settings:set:voice-reply:manual",
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
  assert.equal(await handleTelegramSettingsMenuCallbackAction(
    "q8", "settings:review:inactive-threads", deps), true);
  assert.equal(await handleTelegramSettingsMenuCallbackAction("q9",
    `settings:clean:thread-cleanup:${"a".repeat(32)}`, deps), true);
  assert.equal(
    await handleTelegramSettingsMenuCallbackAction("q10", "other", deps),
    false,
  );

  assert.deepEqual(calls, [
    "voice:manual",
    "update:<b>👄 Voice reply mode:</b> <code>manual</code>",
    "answer:Voice reply mode: manual",
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
    "update:<b>⚙️ Settings:</b>",
    "answer:Public assistant output is always delivered while Telegram is connected.",
    "automatic-thread-cleanup:false",
    "update:<b>🧹 Thread cleanup:</b> <code>on</code>",
    "answer:Thread cleanup disabled",
    "update:<b>🔎 Inactive tabs review:</b>",
    "answer:Review prepared. No tabs were deleted.",
    `clean:thread-cleanup:${"a".repeat(32)}`,
    "answer:Deleted: 2. Outcome unknown: 0. Blocked: 1. Recovery: cleanup authority unavailable.",
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
    getVoiceReplyMode: () => "manual",
    isVoiceReplyModeConfigured: () => true,
    getTimeInjectionMode: () => "hidden",
    isAutomaticThreadCleanupEnabled: () => true,
    areDraftPreviewsEnabled: () => false,
    getAssistantRenderingMode: () => "rich",
    getActivityVerbosity: () => "verbose",
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
