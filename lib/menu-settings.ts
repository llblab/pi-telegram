/**
 * Telegram settings menu UI helpers
 * Zones: telegram ui, settings controls, menu composition
 * Owns hidden settings-menu rendering, settings callbacks, and persisted toggle wiring
 */

import {
  getTelegramExtensionSettingsRows,
  type TelegramSectionRegistry,
} from "./sections.ts";
import type { TelegramTimeMode } from "./config.ts";
import type { TelegramInlineKeyboardMarkup } from "./keyboard.ts";
import type { TelegramModelMenuState } from "./menu-model.ts";
import type { MenuModel } from "./model.ts";
import type { TelegramVoiceReplyMode } from "./voice.ts";

export type TelegramSettingsMenuReplyMarkup = TelegramInlineKeyboardMarkup;

export interface TelegramSettingsStateDeps {
  isProactivePushEnabled: () => boolean;
  areRichDraftPreviewsEnabled: () => boolean;
  getTimeInjectionMode: () => TelegramTimeMode;
  getVoiceReplyMode: () => TelegramVoiceReplyMode;
  isVoiceReplyModeConfigured: () => boolean;
}

export interface TelegramSettingsMutationDeps extends TelegramSettingsStateDeps {
  setProactivePushEnabled: (enabled: boolean) => Promise<void>;
  setRichDraftPreviewsEnabled: (enabled: boolean) => Promise<void>;
  setVoiceReplyMode: (
    mode: TelegramVoiceReplyMode | undefined,
  ) => Promise<void>;
  setTimeInjectionMode: (mode: TelegramTimeMode) => Promise<void>;
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
      message?: { message_id?: number; chat?: { id?: number } };
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
  getModelMenuState: (
    chatId: number,
    ctx: TContext,
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
export const PROACTIVE_PUSH_SETTINGS_TITLE = "<b>📌 Proactive push:</b>";
export const RICH_DRAFT_PREVIEWS_SETTINGS_TITLE =
  "<b>📝 Rich draft previews:</b>";
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

export function buildProactivePushSettingsText(
  proactivePushEnabled: boolean,
): string {
  return [
    `${PROACTIVE_PUSH_SETTINGS_TITLE} <code>${proactivePushEnabled ? "on" : "off"}</code>`,
    "",
    "Send successful local Pi task results to Telegram when the bridge is connected.",
  ].join("\n");
}

export function buildRichDraftPreviewsSettingsText(enabled: boolean): string {
  return [
    `${RICH_DRAFT_PREVIEWS_SETTINGS_TITLE} <code>${enabled ? "on" : "off"}</code>`,
    "",
    "Show progressive Rich Markdown draft previews while the model is answering.",
    "",
    "<code>-</code> <code>off</code> (default): show native active status, then send the final Rich Markdown answer.",
    "<code>-</code> <code>on</code>: also stream safe Rich Markdown draft previews before the final answer.",
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
    "<code>-</code> <code>hidden</code> (default): same behavior as 'manual', but no voice policy is added to prompt context.",
    "<code>-</code> <code>manual</code>: agent decides; explicit 'telegram_voice' markup still works and reply mode is visible in prompt context.",
    "<code>-</code> <code>mirror</code>: voice input prefers a voice reply; text input gracefully follows 'manual' behavior.",
    "<code>-</code> <code>always</code>: every reply is converted to voice when delivery succeeds.",
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
  richDraftPreviewsEnabled: boolean,
  voiceReplyMode: TelegramVoiceReplyMode,
  timeInjectionMode: TelegramTimeMode,
  sectionRegistry?: TelegramSectionRegistry,
  voiceReplyModeConfigured = true,
): TelegramSettingsMenuReplyMarkup {
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
        text: `👄 Voice reply: ${getTelegramSettingsStateValueLabel(
          getVoiceReplyModeLabel(
            getVoiceReplyModeSetting(voiceReplyMode, voiceReplyModeConfigured),
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
        text: `📝 Rich drafts: ${richDraftPreviewsEnabled ? "on" : "off"}`,
        callback_data: "settings:open:rich-drafts",
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
      deps.areRichDraftPreviewsEnabled(),
      deps.getVoiceReplyMode(),
      deps.getTimeInjectionMode(),
      sectionRegistry,
      deps.isVoiceReplyModeConfigured(),
    ),
  );
  if (messageId === undefined) return;
  state.messageId = messageId;
  state.mode = "settings";
  deps.storeModelMenuState(state);
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

export function buildRichDraftPreviewsSettingsReplyMarkup(
  enabled: boolean,
): TelegramSettingsMenuReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "⬆️ Back", callback_data: "settings:list" }],
      [
        {
          text: enabled ? "🟢 On" : "⚫️ On",
          callback_data: "settings:set:rich-drafts:on",
        },
        {
          text: enabled ? "⚫️ Off" : "🟡 Off",
          callback_data: "settings:set:rich-drafts:off",
        },
      ],
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
  const modes: TelegramVoiceReplyModeSetting[] = [
    "hidden",
    "manual",
    "mirror",
    "always",
  ];
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
      deps.areRichDraftPreviewsEnabled(),
      deps.getVoiceReplyMode(),
      deps.getTimeInjectionMode(),
      sectionRegistry,
      deps.isVoiceReplyModeConfigured(),
    ),
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

export async function updateRichDraftPreviewsSettingsMessage(
  deps: TelegramSettingsMenuCallbackDeps,
): Promise<void> {
  const enabled = deps.areRichDraftPreviewsEnabled();
  await deps.updateSettingsMessage(
    buildRichDraftPreviewsSettingsText(enabled),
    buildRichDraftPreviewsSettingsReplyMarkup(enabled),
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
  if (data === "settings:open:proactive") {
    await updateProactivePushSettingsMessage(deps);
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (data === "settings:open:rich-drafts") {
    await updateRichDraftPreviewsSettingsMessage(deps);
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
    if (
      mode === "hidden" ||
      mode === "manual" ||
      mode === "mirror" ||
      mode === "always"
    ) {
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
    data === "settings:set:rich-drafts:on" ||
    data === "settings:set:rich-drafts:off"
  ) {
    const enabled = data.endsWith(":on");
    await deps.setRichDraftPreviewsEnabled(enabled);
    await updateRichDraftPreviewsSettingsMessage(deps);
    await deps.answerCallbackQuery(
      callbackQueryId,
      `Rich draft previews ${enabled ? "enabled" : "disabled"}`,
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
    openSettingsMenu: (chatId, _replyToMessageId, ctx) =>
      openTelegramSettingsMenu(
        {
          getModelMenuState: () => deps.getModelMenuState(chatId, ctx),
          isProactivePushEnabled: deps.isProactivePushEnabled,
          areRichDraftPreviewsEnabled: deps.areRichDraftPreviewsEnabled,
          getVoiceReplyMode: deps.getVoiceReplyMode,
          isVoiceReplyModeConfigured: deps.isVoiceReplyModeConfigured,
          getTimeInjectionMode: deps.getTimeInjectionMode,
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
      ),
    updateSettingsMenuMessage: (state) =>
      updateTelegramSettingsMenuMessage(
        {
          isProactivePushEnabled: deps.isProactivePushEnabled,
          areRichDraftPreviewsEnabled: deps.areRichDraftPreviewsEnabled,
          getVoiceReplyMode: deps.getVoiceReplyMode,
          isVoiceReplyModeConfigured: deps.isVoiceReplyModeConfigured,
          getTimeInjectionMode: deps.getTimeInjectionMode,
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
      ),
    handleCallbackQuery: async (query) => {
      if (!query.data?.startsWith("settings:")) return false;
      const state = deps.getStoredModelMenuState(
        query.message?.message_id,
        query.message?.chat?.id,
      );
      if (!state) {
        const voiceMode = query.data.slice("settings:set:voice-reply:".length);
        if (
          query.data.startsWith("settings:set:voice-reply:") &&
          (voiceMode === "hidden" ||
            voiceMode === "manual" ||
            voiceMode === "mirror" ||
            voiceMode === "always")
        ) {
          await deps.setVoiceReplyMode(
            voiceMode === "hidden" ? undefined : voiceMode,
          );
          await deps.answerCallbackQuery(
            query.id,
            `Voice reply mode: ${voiceMode}`,
          );
          return true;
        }
        if (
          query.data === "settings:set:rich-drafts:on" ||
          query.data === "settings:set:rich-drafts:off"
        ) {
          const enabled = query.data.endsWith(":on");
          await deps.setRichDraftPreviewsEnabled(enabled);
          await deps.answerCallbackQuery(
            query.id,
            `Rich draft previews ${enabled ? "enabled" : "disabled"}`,
          );
          return true;
        }
        const hasTimeInjectionPrefix = query.data.startsWith(
          "settings:set:time-injection:",
        );
        const timeMode = hasTimeInjectionPrefix
          ? query.data.slice("settings:set:time-injection:".length)
          : query.data.slice("settings:set:time:".length);
        if (
          (hasTimeInjectionPrefix ||
            query.data.startsWith("settings:set:time:")) &&
          (timeMode === "off" ||
            timeMode === "hidden" ||
            timeMode === "always" ||
            timeMode === "interval")
        ) {
          const normalizedMode = timeMode === "off" ? "hidden" : timeMode;
          await deps.setTimeInjectionMode(normalizedMode);
          await deps.answerCallbackQuery(
            query.id,
            `Time injection: ${normalizedMode}`,
          );
          return true;
        }
        await deps.answerCallbackQuery(
          query.id,
          "Interactive message expired.",
        );
        return true;
      }
      return handleTelegramSettingsMenuCallbackAction(query.id, query.data, {
        isProactivePushEnabled: deps.isProactivePushEnabled,
        areRichDraftPreviewsEnabled: deps.areRichDraftPreviewsEnabled,
        getVoiceReplyMode: deps.getVoiceReplyMode,
        isVoiceReplyModeConfigured: deps.isVoiceReplyModeConfigured,
        getTimeInjectionMode: deps.getTimeInjectionMode,
        setProactivePushEnabled: deps.setProactivePushEnabled,
        setRichDraftPreviewsEnabled: deps.setRichDraftPreviewsEnabled,
        setVoiceReplyMode: deps.setVoiceReplyMode,
        setTimeInjectionMode: deps.setTimeInjectionMode,
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
