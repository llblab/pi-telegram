/**
 * Telegram settings menu UI helpers
 * Zones: telegram ui, settings controls, menu composition
 * Owns hidden settings-menu rendering, settings callbacks, and persisted toggle wiring
 */

import type {
  TelegramAssistantRenderingMode,
  TelegramTimeMode,
} from "./config.ts";
import type { TelegramInlineKeyboardMarkup } from "./keyboard.ts";
import type { TelegramModelMenuState } from "./menu-model.ts";
import type { MenuModel } from "./model.ts";
import {
  getTelegramExtensionSettingsRows,
  type TelegramSectionRegistry,
} from "./sections.ts";
import type { TelegramVoiceReplyMode } from "./voice.ts";

export type TelegramSettingsMenuReplyMarkup = TelegramInlineKeyboardMarkup;

export interface TelegramSettingsStateDeps {
  isProactivePushEnabled: () => boolean;
  areDraftPreviewsEnabled: () => boolean;
  getAssistantRenderingMode: () => TelegramAssistantRenderingMode;
  getTimeInjectionMode: () => TelegramTimeMode;
  getVoiceReplyMode: () => TelegramVoiceReplyMode;
  isVoiceReplyModeConfigured: () => boolean;
  isAutomaticThreadCleanupEnabled: () => boolean;
}

export interface TelegramSettingsMutationDeps extends TelegramSettingsStateDeps {
  setProactivePushEnabled: (enabled: boolean) => Promise<void>;
  setDraftPreviewsEnabled: (enabled: boolean) => Promise<void>;
  setAssistantRenderingMode: (
    mode: TelegramAssistantRenderingMode,
  ) => Promise<void>;
  setVoiceReplyMode: (
    mode: TelegramVoiceReplyMode | undefined,
  ) => Promise<void>;
  setTimeInjectionMode: (mode: TelegramTimeMode) => Promise<void>;
  setAutomaticThreadCleanupEnabled: (enabled: boolean) => Promise<void>;
}

export interface TelegramSettingsMenuOpenDeps<
  TModel extends MenuModel = MenuModel,
> extends TelegramSettingsStateDeps {
  getModelMenuState: () => Promise<TelegramModelMenuState<TModel>>;
  sendSettingsMenu: (
    state: TelegramModelMenuState<TModel>,
    text: string,
    replyMarkup: TelegramSettingsMenuReplyMarkup,
  ) => Promise<number | undefined>;
  storeModelMenuState: (state: TelegramModelMenuState<TModel>) => void;
}

export interface TelegramSettingsMenuCallbackDeps extends TelegramSettingsMutationDeps {
  updateSettingsMessage: (
    text: string,
    replyMarkup: TelegramSettingsMenuReplyMarkup,
  ) => Promise<void>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  sectionRegistry?: TelegramSectionRegistry;
}

export interface TelegramSettingsMenuRuntime<TContext> {
  openSettingsMenu: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<void>;
  handleCallbackQuery: (
    query: {
      id: string;
      data?: string;
      message?: {
        message_id?: number;
        message_thread_id?: number;
        chat?: { id?: number };
      };
    },
    ctx: TContext,
  ) => Promise<boolean>;
  updateSettingsMenuMessage: (
    state: TelegramModelMenuState,
    ctx: TContext,
  ) => Promise<void>;
}

export interface TelegramSettingsMenuMessageUpdateDeps extends TelegramSettingsStateDeps {
  updateSettingsMessage: (
    text: string,
    replyMarkup: TelegramSettingsMenuReplyMarkup,
  ) => Promise<void>;
}

export interface TelegramSettingsMenuRuntimeDeps<
  TContext,
  TModel extends MenuModel = MenuModel,
> extends TelegramSettingsMutationDeps {
  reloadConfig?: () => Promise<void>;
  getModelMenuState: (
    chatId: number,
    ctx: TContext,
    threadId?: number,
  ) => Promise<TelegramModelMenuState<TModel>>;
  getStoredModelMenuState: (
    messageId: number | undefined,
    chatId?: number,
  ) => TelegramModelMenuState<TModel> | undefined;
  storeModelMenuState: (state: TelegramModelMenuState<TModel>) => void;
  editInteractiveMessage: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "markdown" | "html" | "plain",
    replyMarkup: TelegramSettingsMenuReplyMarkup,
  ) => Promise<void>;
  sendInteractiveMessage: (
    chatId: number,
    text: string,
    mode: "markdown" | "html" | "plain",
    replyMarkup: TelegramSettingsMenuReplyMarkup,
  ) => Promise<number | undefined>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
}

export const SETTINGS_MENU_TITLE = "<b>⚙️ Settings:</b>";
export const AUTOMATIC_THREAD_CLEANUP_SETTINGS_TITLE =
  "<b>🧹 Automatic thread cleanup:</b>";
export const PROACTIVE_PUSH_SETTINGS_TITLE = "<b>📌 Proactive push:</b>";
export const DRAFT_PREVIEWS_SETTINGS_TITLE = "<b>📝 Draft previews:</b>";
export const ASSISTANT_RENDERING_SETTINGS_TITLE =
  "<b>🧾 Assistant rendering:</b>";
export const TIME_INJECTION_MODE_SETTINGS_TITLE =
  "<b>🕒 Time injection mode:</b>";
export const VOICE_REPLY_MODE_SETTINGS_TITLE = "<b>👄 Voice reply mode:</b>";

type TelegramVoiceReplyModeSetting = TelegramVoiceReplyMode | "hidden";

function getVoiceReplyModeLabel(mode: TelegramVoiceReplyModeSetting): string {
  return mode;
}

function getTelegramSettingsStateValueLabel(value: string): string {
  return value.toLowerCase();
}

function getVoiceReplyModeSetting(
  mode: TelegramVoiceReplyMode,
  configured: boolean,
): TelegramVoiceReplyModeSetting {
  return configured ? mode : "hidden";
}

export function buildTelegramSettingsMenuText(): string {
  return SETTINGS_MENU_TITLE;
}

export function buildAutomaticThreadCleanupSettingsText(
  enabled: boolean,
): string {
  return [
    `${AUTOMATIC_THREAD_CLEANUP_SETTINGS_TITLE} <code>${enabled ? "on" : "off"}</code>`,
    "",
    "Delete this Pi instance's Telegram tab when Pi quits normally.",
    "",
    "<code>-</code> <code>on</code> (default): delete the bound thread and release Telegram authority on graceful quit.",
    "<code>-</code> <code>off</code>: preserve the tab as a restart hint; manual /telegram-disconnect still confirms and deletes it.",
  ].join("\n");
}

export function buildProactivePushSettingsText(
  proactivePushEnabled: boolean,
): string {
  return [
    `${PROACTIVE_PUSH_SETTINGS_TITLE} <code>${proactivePushEnabled ? "on" : "off"}</code>`,
    "",
    "Control whether public assistant output from local/autonomous work is projected to Telegram.",
    "",
    "<code>-</code> <code>on</code> (default): send each completed public block, including visible checkpoints and the final answer, while connected.",
    "<code>-</code> <code>off</code>: keep local/autonomous assistant blocks in Pi; Telegram-originated replies still use their normal delivery path.",
  ].join("\n");
}

export function buildDraftPreviewsSettingsText(enabled: boolean): string {
  return [
    `${DRAFT_PREVIEWS_SETTINGS_TITLE} <code>${enabled ? "on" : "off"}</code>`,
    "",
    "Show live answer drafts while the model is answering.",
    "",
    "<code>-</code> <code>off</code> (default): show native active status, then send one final answer.",
    "<code>-</code> <code>on</code>: stream safe Telegram Rich Draft frames before the final answer.",
  ].join("\n");
}

export function buildAssistantRenderingSettingsText(
  mode: TelegramAssistantRenderingMode,
): string {
  return [
    `${ASSISTANT_RENDERING_SETTINGS_TITLE} <code>${mode}</code>`,
    "",
    "Choose how final assistant Markdown answers are delivered.",
    "",
    "<code>-</code> <code>rich</code> (default): use Telegram Native Rich Markdown.",
    "<code>-</code> <code>html</code>: use the legacy Markdown-to-HTML renderer.",
  ].join("\n");
}

export function buildVoiceReplyModeSettingsText(
  mode: TelegramVoiceReplyMode,
  configured = true,
): string {
  return [
    `${VOICE_REPLY_MODE_SETTINGS_TITLE} <code>${getVoiceReplyModeLabel(
      getVoiceReplyModeSetting(mode, configured),
    )}</code>`,
    "",
    "Controls when pi-telegram converts assistant text replies into Telegram voice messages.",
    "",
    "<code>-</code> <code>hidden</code> (default): add no automatic voice context; explicit 'telegram_voice' actions still work.",
    "<code>-</code> <code>mirror</code>: voice input activates automatic voice delivery; text input follows 'hidden' behavior.",
    "<code>-</code> <code>always</code>: activate automatic voice delivery for every reply.",
  ].join("\n");
}

export function buildTimeInjectionModeSettingsText(
  mode: TelegramTimeMode,
): string {
  return [
    `${TIME_INJECTION_MODE_SETTINGS_TITLE} <code>${mode}</code>`,
    "",
    "Controls whether Telegram-originated prompts include a compact wall-clock [time] line.",
    "",
    "<code>-</code> <code>hidden</code> (default): no time line is added to prompt context.",
    "<code>-</code> <code>always</code>: add time to every Telegram turn.",
    "<code>-</code> <code>interval</code>: add time at most once per chat interval (default: 1 hour).",
  ].join("\n");
}

export function buildTelegramSettingsMenuReplyMarkup(
  proactivePushEnabled: boolean,
  draftPreviewsEnabled: boolean,
  assistantRenderingModeOrVoiceReplyMode:
    TelegramAssistantRenderingMode | TelegramVoiceReplyMode,
  voiceReplyModeOrTimeInjectionMode: TelegramVoiceReplyMode | TelegramTimeMode,
  timeInjectionModeOrSectionRegistry?:
    TelegramTimeMode | TelegramSectionRegistry,
  sectionRegistryOrVoiceReplyModeConfigured?: TelegramSectionRegistry | boolean,
  voiceReplyModeConfigured = true,
  automaticThreadCleanupEnabled = true,
): TelegramSettingsMenuReplyMarkup {
  const hasRenderingMode =
    assistantRenderingModeOrVoiceReplyMode === "rich" ||
    assistantRenderingModeOrVoiceReplyMode === "html";
  const assistantRenderingMode: TelegramAssistantRenderingMode =
    hasRenderingMode ? assistantRenderingModeOrVoiceReplyMode : "rich";
  const voiceReplyMode = hasRenderingMode
    ? (voiceReplyModeOrTimeInjectionMode as TelegramVoiceReplyMode)
    : (assistantRenderingModeOrVoiceReplyMode as TelegramVoiceReplyMode);
  const timeInjectionMode = hasRenderingMode
    ? (timeInjectionModeOrSectionRegistry as TelegramTimeMode)
    : (voiceReplyModeOrTimeInjectionMode as TelegramTimeMode);
  const sectionRegistry = hasRenderingMode
    ? (sectionRegistryOrVoiceReplyModeConfigured as
        TelegramSectionRegistry | undefined)
    : (timeInjectionModeOrSectionRegistry as
        TelegramSectionRegistry | undefined);
  const effectiveVoiceReplyModeConfigured = hasRenderingMode
    ? voiceReplyModeConfigured
    : typeof sectionRegistryOrVoiceReplyModeConfigured === "boolean"
      ? sectionRegistryOrVoiceReplyModeConfigured
      : true;
  const rows: Array<Array<{ text: string; callback_data: string }>> = [
    [{ text: "⬆️ Main menu", callback_data: "menu:back" }],
  ];
  // Extension settings rows before built-in controls
  if (sectionRegistry) {
    const settingsRows = getTelegramExtensionSettingsRows(sectionRegistry);
    for (const row of settingsRows) {
      rows.push([{ text: row.label, callback_data: row.callback_data }]);
    }
  }
  rows.push(
    [
      {
        text: `🧹 Auto thread cleanup: ${automaticThreadCleanupEnabled ? "on" : "off"}`,
        callback_data: "settings:open:automatic-thread-cleanup",
      },
    ],
    [
      {
        text: `👄 Voice reply: ${getTelegramSettingsStateValueLabel(
          getVoiceReplyModeLabel(
            getVoiceReplyModeSetting(
              voiceReplyMode,
              effectiveVoiceReplyModeConfigured,
            ),
          ),
        )}`,
        callback_data: "settings:open:voice-reply",
      },
    ],
    [
      {
        text: `🕒 Time injection: ${getTelegramSettingsStateValueLabel(timeInjectionMode)}`,
        callback_data: "settings:open:time-injection",
      },
    ],
    [
      {
        text: `📝 Draft previews: ${draftPreviewsEnabled ? "on" : "off"}`,
        callback_data: "settings:open:draft-previews",
      },
    ],
    [
      {
        text: `🧾 Rendering: ${assistantRenderingMode}`,
        callback_data: "settings:open:assistant-rendering",
      },
    ],
    [
      {
        text: `📌 Proactive push: ${proactivePushEnabled ? "on" : "off"}`,
        callback_data: "settings:open:proactive",
      },
    ],
  );
  return { inline_keyboard: rows };
}

export async function openTelegramSettingsMenu<
  TModel extends MenuModel = MenuModel,
>(
  deps: TelegramSettingsMenuOpenDeps<TModel>,
  sectionRegistry?: TelegramSectionRegistry,
): Promise<void> {
  const state = await deps.getModelMenuState();
  const messageId = await deps.sendSettingsMenu(
    state,
    buildTelegramSettingsMenuText(),
    buildTelegramSettingsMenuReplyMarkup(
      deps.isProactivePushEnabled(),
      deps.areDraftPreviewsEnabled(),
      deps.getAssistantRenderingMode(),
      deps.getVoiceReplyMode(),
      deps.getTimeInjectionMode(),
      sectionRegistry,
      deps.isVoiceReplyModeConfigured(),
      deps.isAutomaticThreadCleanupEnabled(),
    ),
  );
  if (messageId === undefined) return;
  state.messageId = messageId;
  state.mode = "settings";
  deps.storeModelMenuState(state);
}

export function buildAutomaticThreadCleanupSettingsReplyMarkup(
  enabled: boolean,
): TelegramSettingsMenuReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "⬆️ Back", callback_data: "settings:list" }],
      [
        {
          text: enabled ? "🟢 On" : "⚫️ On",
          callback_data: "settings:set:automatic-thread-cleanup:on",
        },
        {
          text: enabled ? "⚫️ Off" : "🟡 Off",
          callback_data: "settings:set:automatic-thread-cleanup:off",
        },
      ],
    ],
  };
}

export function buildProactivePushSettingsReplyMarkup(
  proactivePushEnabled: boolean,
): TelegramSettingsMenuReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "⬆️ Back", callback_data: "settings:list" }],
      [
        {
          text: proactivePushEnabled ? "🟢 On" : "⚫️ On",
          callback_data: "settings:set:proactive:on",
        },
        {
          text: proactivePushEnabled ? "⚫️ Off" : "🟡 Off",
          callback_data: "settings:set:proactive:off",
        },
      ],
    ],
  };
}

export function buildDraftPreviewsSettingsReplyMarkup(
  enabled: boolean,
): TelegramSettingsMenuReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "⬆️ Back", callback_data: "settings:list" }],
      [
        {
          text: enabled ? "🟢 On" : "⚫️ On",
          callback_data: "settings:set:draft-previews:on",
        },
        {
          text: enabled ? "⚫️ Off" : "🟡 Off",
          callback_data: "settings:set:draft-previews:off",
        },
      ],
    ],
  };
}

export function buildAssistantRenderingSettingsReplyMarkup(
  mode: TelegramAssistantRenderingMode,
): TelegramSettingsMenuReplyMarkup {
  const modes: TelegramAssistantRenderingMode[] = ["rich", "html"];
  return {
    inline_keyboard: [
      [{ text: "⬆️ Back", callback_data: "settings:list" }],
      ...modes.map((value) => [
        {
          text: `${value === mode ? "🟢 " : ""}${value}`,
          callback_data: `settings:set:assistant-rendering:${value}`,
        },
      ]),
    ],
  };
}

export function buildTimeInjectionModeSettingsReplyMarkup(
  mode: TelegramTimeMode,
): TelegramSettingsMenuReplyMarkup {
  const modes: TelegramTimeMode[] = ["hidden", "always", "interval"];
  return {
    inline_keyboard: [
      [{ text: "⬆️ Back", callback_data: "settings:list" }],
      ...modes.map((value) => [
        {
          text: `${value === mode ? "🟢 " : ""}${value}`,
          callback_data: `settings:set:time-injection:${value}`,
        },
      ]),
    ],
  };
}

export function buildVoiceReplyModeSettingsReplyMarkup(
  mode: TelegramVoiceReplyMode,
  configured = true,
): TelegramSettingsMenuReplyMarkup {
  const activeMode = getVoiceReplyModeSetting(mode, configured);
  const modes: TelegramVoiceReplyModeSetting[] = ["hidden", "mirror", "always"];
  return {
    inline_keyboard: [
      [{ text: "⬆️ Back", callback_data: "settings:list" }],
      ...modes.map((value) => [
        {
          text: `${value === activeMode ? "🟢 " : ""}${getVoiceReplyModeLabel(value)}`,
          callback_data: `settings:set:voice-reply:${value}`,
        },
      ]),
    ],
  };
}

export async function updateTelegramSettingsMenuMessage(
  deps: TelegramSettingsMenuMessageUpdateDeps,
  sectionRegistry?: TelegramSectionRegistry,
): Promise<void> {
  await deps.updateSettingsMessage(
    buildTelegramSettingsMenuText(),
    buildTelegramSettingsMenuReplyMarkup(
      deps.isProactivePushEnabled(),
      deps.areDraftPreviewsEnabled(),
      deps.getAssistantRenderingMode(),
      deps.getVoiceReplyMode(),
      deps.getTimeInjectionMode(),
      sectionRegistry,
      deps.isVoiceReplyModeConfigured(),
      deps.isAutomaticThreadCleanupEnabled(),
    ),
  );
}

export async function updateAutomaticThreadCleanupSettingsMessage(
  deps: TelegramSettingsMenuCallbackDeps,
): Promise<void> {
  const enabled = deps.isAutomaticThreadCleanupEnabled();
  await deps.updateSettingsMessage(
    buildAutomaticThreadCleanupSettingsText(enabled),
    buildAutomaticThreadCleanupSettingsReplyMarkup(enabled),
  );
}

export async function updateProactivePushSettingsMessage(
  deps: TelegramSettingsMenuCallbackDeps,
): Promise<void> {
  const proactivePushEnabled = deps.isProactivePushEnabled();
  await deps.updateSettingsMessage(
    buildProactivePushSettingsText(proactivePushEnabled),
    buildProactivePushSettingsReplyMarkup(proactivePushEnabled),
  );
}

export async function updateDraftPreviewsSettingsMessage(
  deps: TelegramSettingsMenuCallbackDeps,
): Promise<void> {
  const enabled = deps.areDraftPreviewsEnabled();
  await deps.updateSettingsMessage(
    buildDraftPreviewsSettingsText(enabled),
    buildDraftPreviewsSettingsReplyMarkup(enabled),
  );
}

export async function updateAssistantRenderingSettingsMessage(
  deps: TelegramSettingsMenuCallbackDeps,
): Promise<void> {
  const mode = deps.getAssistantRenderingMode();
  await deps.updateSettingsMessage(
    buildAssistantRenderingSettingsText(mode),
    buildAssistantRenderingSettingsReplyMarkup(mode),
  );
}

export async function updateTimeInjectionModeSettingsMessage(
  deps: TelegramSettingsMenuCallbackDeps,
): Promise<void> {
  const mode = deps.getTimeInjectionMode();
  await deps.updateSettingsMessage(
    buildTimeInjectionModeSettingsText(mode),
    buildTimeInjectionModeSettingsReplyMarkup(mode),
  );
}

export async function updateVoiceReplyModeSettingsMessage(
  deps: TelegramSettingsMenuCallbackDeps,
): Promise<void> {
  const mode = deps.getVoiceReplyMode();
  const configured = deps.isVoiceReplyModeConfigured();
  await deps.updateSettingsMessage(
    buildVoiceReplyModeSettingsText(mode, configured),
    buildVoiceReplyModeSettingsReplyMarkup(mode, configured),
  );
}

export async function handleTelegramSettingsMenuCallbackAction(
  callbackQueryId: string,
  data: string | undefined,
  deps: TelegramSettingsMenuCallbackDeps,
): Promise<boolean> {
  if (!data?.startsWith("settings:")) return false;
  if (data === "settings:list") {
    await updateTelegramSettingsMenuMessage(deps, deps.sectionRegistry);
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (data === "settings:open:automatic-thread-cleanup") {
    await updateAutomaticThreadCleanupSettingsMessage(deps);
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (data === "settings:open:proactive") {
    await updateProactivePushSettingsMessage(deps);
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (
    data === "settings:open:draft-previews" ||
    data === "settings:open:rich-drafts"
  ) {
    await updateDraftPreviewsSettingsMessage(deps);
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (data === "settings:open:assistant-rendering") {
    await updateAssistantRenderingSettingsMessage(deps);
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (data === "settings:open:voice-reply") {
    await updateVoiceReplyModeSettingsMessage(deps);
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (
    data === "settings:open:time-injection" ||
    data === "settings:open:time"
  ) {
    await updateTimeInjectionModeSettingsMessage(deps);
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (data.startsWith("settings:set:voice-reply:")) {
    const mode = data.slice("settings:set:voice-reply:".length);
    if (mode === "hidden" || mode === "mirror" || mode === "always") {
      await deps.setVoiceReplyMode(mode === "hidden" ? undefined : mode);
      await updateVoiceReplyModeSettingsMessage(deps);
      await deps.answerCallbackQuery(
        callbackQueryId,
        `Voice reply mode: ${mode}`,
      );
      return true;
    }
  }
  if (
    data.startsWith("settings:set:time-injection:") ||
    data.startsWith("settings:set:time:")
  ) {
    const mode = data.startsWith("settings:set:time-injection:")
      ? data.slice("settings:set:time-injection:".length)
      : data.slice("settings:set:time:".length);
    const normalizedMode = mode === "off" ? "hidden" : mode;
    if (
      normalizedMode === "hidden" ||
      normalizedMode === "always" ||
      normalizedMode === "interval"
    ) {
      await deps.setTimeInjectionMode(normalizedMode);
      await updateTimeInjectionModeSettingsMessage(deps);
      await deps.answerCallbackQuery(
        callbackQueryId,
        `Time injection: ${normalizedMode}`,
      );
      return true;
    }
  }
  if (
    data === "settings:set:draft-previews:on" ||
    data === "settings:set:draft-previews:off" ||
    data === "settings:set:rich-drafts:on" ||
    data === "settings:set:rich-drafts:off"
  ) {
    const enabled = data.endsWith(":on");
    await deps.setDraftPreviewsEnabled(enabled);
    await updateDraftPreviewsSettingsMessage(deps);
    await deps.answerCallbackQuery(
      callbackQueryId,
      `Draft previews ${enabled ? "enabled" : "disabled"}`,
    );
    return true;
  }
  if (data.startsWith("settings:set:assistant-rendering:")) {
    const mode = data.slice("settings:set:assistant-rendering:".length);
    if (mode === "rich" || mode === "html") {
      await deps.setAssistantRenderingMode(mode);
      await updateAssistantRenderingSettingsMessage(deps);
      await deps.answerCallbackQuery(callbackQueryId, `Rendering: ${mode}`);
      return true;
    }
  }
  if (
    data === "settings:set:automatic-thread-cleanup:on" ||
    data === "settings:set:automatic-thread-cleanup:off"
  ) {
    const enabled = data.endsWith(":on");
    await deps.setAutomaticThreadCleanupEnabled(enabled);
    await updateAutomaticThreadCleanupSettingsMessage(deps);
    await deps.answerCallbackQuery(
      callbackQueryId,
      `Automatic thread cleanup ${enabled ? "enabled" : "disabled"}`,
    );
    return true;
  }
  if (
    data === "settings:set:proactive:on" ||
    data === "settings:set:proactive:off"
  ) {
    const enabled = data.endsWith(":on");
    await deps.setProactivePushEnabled(enabled);
    await updateProactivePushSettingsMessage(deps);
    await deps.answerCallbackQuery(
      callbackQueryId,
      `Proactive push ${enabled ? "enabled" : "disabled"}`,
    );
    return true;
  }
  await deps.answerCallbackQuery(callbackQueryId);
  return true;
}

export function createTelegramSettingsMenuRuntime<
  TContext,
  TModel extends MenuModel = MenuModel,
>(
  deps: TelegramSettingsMenuRuntimeDeps<TContext, TModel>,
  sectionRegistry?: TelegramSectionRegistry,
): TelegramSettingsMenuRuntime<TContext> {
  return {
    openSettingsMenu: async (chatId, _replyToMessageId, ctx) => {
      await deps.reloadConfig?.();
      return openTelegramSettingsMenu(
        {
          getModelMenuState: () => deps.getModelMenuState(chatId, ctx),
          isProactivePushEnabled: deps.isProactivePushEnabled,
          areDraftPreviewsEnabled: deps.areDraftPreviewsEnabled,
          getAssistantRenderingMode: deps.getAssistantRenderingMode,
          getVoiceReplyMode: deps.getVoiceReplyMode,
          isVoiceReplyModeConfigured: deps.isVoiceReplyModeConfigured,
          getTimeInjectionMode: deps.getTimeInjectionMode,
          isAutomaticThreadCleanupEnabled:
            deps.isAutomaticThreadCleanupEnabled,
          sendSettingsMenu: (state, text, replyMarkup) =>
            deps.sendInteractiveMessage(
              state.chatId,
              text,
              "html",
              replyMarkup,
            ),
          storeModelMenuState: deps.storeModelMenuState,
        },
        sectionRegistry,
      );
    },
    updateSettingsMenuMessage: async (state) => {
      await deps.reloadConfig?.();
      return updateTelegramSettingsMenuMessage(
        {
          isProactivePushEnabled: deps.isProactivePushEnabled,
          areDraftPreviewsEnabled: deps.areDraftPreviewsEnabled,
          getAssistantRenderingMode: deps.getAssistantRenderingMode,
          getVoiceReplyMode: deps.getVoiceReplyMode,
          isVoiceReplyModeConfigured: deps.isVoiceReplyModeConfigured,
          getTimeInjectionMode: deps.getTimeInjectionMode,
          isAutomaticThreadCleanupEnabled:
            deps.isAutomaticThreadCleanupEnabled,
          updateSettingsMessage: (text, replyMarkup) =>
            deps.editInteractiveMessage(
              state.chatId,
              state.messageId,
              text,
              "html",
              replyMarkup,
            ),
        },
        sectionRegistry,
      );
    },
    handleCallbackQuery: async (query, ctx) => {
      if (!query.data?.startsWith("settings:")) return false;
      await deps.reloadConfig?.();
      const messageId = query.message?.message_id;
      const chatId = query.message?.chat?.id;
      let state = deps.getStoredModelMenuState(messageId, chatId);
      if (!state) {
        if (typeof messageId !== "number" || typeof chatId !== "number") {
          await deps.answerCallbackQuery(
            query.id,
            "Interactive message expired.",
          );
          return true;
        }
        state = await deps.getModelMenuState(
          chatId,
          ctx,
          query.message?.message_thread_id,
        );
        state.messageId = messageId;
        state.mode = "settings";
        deps.storeModelMenuState(state);
      }
      return handleTelegramSettingsMenuCallbackAction(query.id, query.data, {
        isProactivePushEnabled: deps.isProactivePushEnabled,
        areDraftPreviewsEnabled: deps.areDraftPreviewsEnabled,
        getAssistantRenderingMode: deps.getAssistantRenderingMode,
        getVoiceReplyMode: deps.getVoiceReplyMode,
        isVoiceReplyModeConfigured: deps.isVoiceReplyModeConfigured,
        getTimeInjectionMode: deps.getTimeInjectionMode,
        isAutomaticThreadCleanupEnabled:
          deps.isAutomaticThreadCleanupEnabled,
        setProactivePushEnabled: deps.setProactivePushEnabled,
        setDraftPreviewsEnabled: deps.setDraftPreviewsEnabled,
        setAssistantRenderingMode: deps.setAssistantRenderingMode,
        setVoiceReplyMode: deps.setVoiceReplyMode,
        setTimeInjectionMode: deps.setTimeInjectionMode,
        setAutomaticThreadCleanupEnabled:
          deps.setAutomaticThreadCleanupEnabled,
        updateSettingsMessage: (text, replyMarkup) =>
          deps.editInteractiveMessage(
            state.chatId,
            state.messageId,
            text,
            "html",
            replyMarkup,
          ),
        answerCallbackQuery: deps.answerCallbackQuery,
        sectionRegistry,
      });
    },
  };
}
