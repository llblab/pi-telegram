/**
 * Telegram settings menu UI helpers
 * Zones: telegram ui, settings controls, menu composition
 * Owns hidden settings-menu rendering, settings callbacks, and persisted toggle wiring
 */

import type {
  TelegramActivityVerbosity,
  TelegramAssistantRenderingMode,
  TelegramTimeMode,
  TelegramThreadDisplayMode,
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
  getThreadDisplayMode?: () => TelegramThreadDisplayMode | undefined;
  areDraftPreviewsEnabled: () => boolean;
  getAssistantRenderingMode: () => TelegramAssistantRenderingMode;
  getActivityVerbosity: () => TelegramActivityVerbosity;
  getTimeInjectionMode: () => TelegramTimeMode;
  getVoiceReplyMode: () => TelegramVoiceReplyMode;
  isVoiceReplyModeConfigured: () => boolean;
  isAutomaticThreadCleanupEnabled: () => boolean;
}

export interface TelegramSettingsMutationDeps extends TelegramSettingsStateDeps {
  setThreadDisplayMode?: (mode: TelegramThreadDisplayMode) => Promise<void>;
  setDraftPreviewsEnabled: (enabled: boolean) => Promise<void>;
  setAssistantRenderingMode: (
    mode: TelegramAssistantRenderingMode,
  ) => Promise<void>;
  setActivityVerbosity: (
    verbosity: TelegramActivityVerbosity,
  ) => Promise<void>;
  setVoiceReplyMode: (
    mode: TelegramVoiceReplyMode | undefined,
  ) => Promise<void>;
  setTimeInjectionMode: (mode: TelegramTimeMode) => Promise<void>;
  setAutomaticThreadCleanupEnabled: (enabled: boolean) => Promise<void>;
  reviewInactiveThreads?: () => Promise<{ count: number; operationId?: string }>;
  cleanInactiveThreads?: (operationId: string) => Promise<{
    deleted: number; outcomeUnknown: number; blocked?: number;
    recovery?: "commit-ready" | "deletion-outcome-unknown" | "authority-blocked";
  }>;
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
  "<b>🧹 Thread cleanup:</b>";
export const INACTIVE_THREAD_REVIEW_TITLE = "<b>🔎 Inactive tabs review:</b>";
export const DRAFT_PREVIEWS_SETTINGS_TITLE = "<b>📝 Draft previews:</b>";
export const ASSISTANT_RENDERING_SETTINGS_TITLE =
  "<b>🧾 Assistant rendering:</b>";
export const ACTIVITY_VERBOSITY_SETTINGS_TITLE =
  "<b>🔬 Activity:</b>";
export const TIME_INJECTION_MODE_SETTINGS_TITLE =
  "<b>🕒 Time injection mode:</b>";
export const VOICE_REPLY_MODE_SETTINGS_TITLE = "<b>👄 Voice reply mode:</b>";
export const THREAD_DISPLAY_SETTINGS_TITLE = "<b>🧵 Thread display:</b>";

function getVoiceReplyModeLabel(mode: TelegramVoiceReplyMode): string {
  return mode;
}

function getTelegramSettingsStateValueLabel(value: string): string {
  return value.toLowerCase();
}

function getVoiceReplyModeSetting(
  mode: TelegramVoiceReplyMode,
  configured: boolean,
): TelegramVoiceReplyMode {
  return configured ? mode : "manual";
}

export function buildTelegramSettingsMenuText(): string {
  return SETTINGS_MENU_TITLE;
}

export function buildThreadDisplaySettingsText(mode: TelegramThreadDisplayMode): string {
  return [
    `${THREAD_DISPLAY_SETTINGS_TITLE} <code>${mode}</code>`,
    "",
    "Choose how this bot profile labels Telegram tabs and Pi terminal status. Each slot is unique across this bot profile.",
    "",
    "<code>-</code> <code>letters</code> (default): show the unique slot, such as <b><i>A</i></b> or <b><i>B</i></b>.",
    "<code>-</code> <code>names</code>: show the generated dictionary name for the slot, such as <b><i>Anchor</i></b> or <b><i>Briar</i></b>.",
    "<code>-</code> <code>directories</code>: show the directory, such as <b><i>extensions</i></b>; shared Workspaces keep slot suffixes, such as <b><i>extensions_a</i></b> and <b><i>extensions_c</i></b>.",
    "A manual <code>/name Name</code> overrides this Thread display name until reset.",
  ].join("\n");
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
    "<code>-</code> <code>off</code>: preserve the tab as a restart hint; manual <code>/telegram-disconnect</code> still confirms and deletes it.",
    "",
    "Review inactive tabs checks current owner and work evidence. Review never deletes tabs.",
  ].join("\n");
}

export function buildInactiveThreadReviewText(count: number): string {
  return [INACTIVE_THREAD_REVIEW_TITLE, "",
    `${count} proven inactive tab${count === 1 ? "" : "s"}.`,
    "No tabs were deleted.",
    "Deletion requires a separate confirmed Clean action.",
  ].join("\n");
}

export function buildInactiveThreadReviewReplyMarkup(
  operationId?: string,
  canCleanInactiveThreads = false,
): TelegramSettingsMenuReplyMarkup {
  const validOperationId = typeof operationId === "string" &&
    /^thread-cleanup:[a-f0-9]{32}$/u.test(operationId);
  return { inline_keyboard: [
    [{ text: "⬆️ Back to Thread cleanup",
      callback_data: "settings:open:automatic-thread-cleanup" }],
    ...(canCleanInactiveThreads && validOperationId ? [[{
      text: "🧹 Clean inactive tabs",
      callback_data: `settings:clean:${operationId}`,
    }]] : []),
  ] };
}

export function buildDraftPreviewsSettingsText(enabled: boolean): string {
  return [
    `${DRAFT_PREVIEWS_SETTINGS_TITLE} <code>${enabled ? "on" : "off"}</code>`,
    "",
    "Show live answer drafts while the model is answering.",
    "",
    "<code>-</code> <code>on</code> (default): stream safe Telegram Rich Draft frames before the final answer.",
    "<code>-</code> <code>off</code>: show native active status, then send one final answer.",
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

export function buildActivityVerbositySettingsText(
  verbosity: TelegramActivityVerbosity,
): string {
  return [
    `${ACTIVITY_VERBOSITY_SETTINGS_TITLE} <code>${verbosity}</code>`,
    "",
    "Choose how much technical model activity Telegram shows.",
    "",
    "<code>-</code> <code>quiet</code>: show no thinking or tool traffic.",
    "<code>-</code> <code>thinking</code>: show persistent collapsed thinking.",
    "<code>-</code> <code>tools</code>: show persistent Rich tool details.",
    "<code>-</code> <code>verbose</code> (default): show both thinking and tools.",
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
    "<code>-</code> <code>manual</code> (default): add no automatic voice context; explicit 'telegram_voice' actions still work.",
    "<code>-</code> <code>mirror</code>: voice input activates automatic voice delivery; text input follows 'manual' behavior.",
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
    "<code>-</code> <code>hidden</code>: no time line is added to prompt context.",
    "<code>-</code> <code>always</code>: add time to every Telegram turn.",
    "<code>-</code> <code>interval</code> (default): add time at most once per chat interval (1 hour unless configured).",
  ].join("\n");
}

export function buildTelegramSettingsMenuReplyMarkup(
  draftPreviewsEnabled: boolean,
  assistantRenderingModeOrVoiceReplyMode:
    TelegramAssistantRenderingMode | TelegramVoiceReplyMode,
  voiceReplyModeOrTimeInjectionMode: TelegramVoiceReplyMode | TelegramTimeMode,
  timeInjectionModeOrSectionRegistry?:
    TelegramTimeMode | TelegramSectionRegistry,
  sectionRegistryOrVoiceReplyModeConfigured?: TelegramSectionRegistry | boolean,
  voiceReplyModeConfigured = true,
  automaticThreadCleanupEnabled = true,
  activityVerbosity: TelegramActivityVerbosity = "quiet",
  threadDisplayMode?: TelegramThreadDisplayMode,
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
  const settingsButtons: Array<{ text: string; callback_data: string }> = [
    {
      text: `📝 Draft previews: ${draftPreviewsEnabled ? "on" : "off"}`,
      callback_data: "settings:open:draft-previews",
    },
    {
      text: `🧾 Rendering: ${assistantRenderingMode}`,
      callback_data: "settings:open:assistant-rendering",
    },
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
    {
      text: `🔬 Activity: ${activityVerbosity}`,
      callback_data: "settings:open:activity-verbosity",
    },
    {
      text: `🕒 Time injection: ${getTelegramSettingsStateValueLabel(timeInjectionMode)}`,
      callback_data: "settings:open:time-injection",
    },
    {
      text: `🧹 Thread cleanup: ${automaticThreadCleanupEnabled ? "on" : "off"}`,
      callback_data: "settings:open:automatic-thread-cleanup",
    },
  ];
  if (threadDisplayMode) settingsButtons.push({
    text: `🧵 Thread display: ${threadDisplayMode}`,
    callback_data: "settings:open:thread-display",
  });
  if (sectionRegistry) {
    const extensionRows = getTelegramExtensionSettingsRows(sectionRegistry);
    settingsButtons.push(
      ...extensionRows.map((row) => ({
        text: row.label,
        callback_data: row.callback_data,
      })),
    );
  }
  rows.push(...settingsButtons.map((button) => [button]));
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
      deps.areDraftPreviewsEnabled(),
      deps.getAssistantRenderingMode(),
      deps.getVoiceReplyMode(),
      deps.getTimeInjectionMode(),
      sectionRegistry,
      deps.isVoiceReplyModeConfigured(),
      deps.isAutomaticThreadCleanupEnabled(),
      deps.getActivityVerbosity(),
      deps.getThreadDisplayMode?.(),
    ),
  );
  if (messageId === undefined) return;
  state.messageId = messageId;
  state.mode = "settings";
  deps.storeModelMenuState(state);
}

export function buildThreadDisplaySettingsReplyMarkup(mode: TelegramThreadDisplayMode): TelegramSettingsMenuReplyMarkup {
  return { inline_keyboard: [
    [{ text: "⬆️ Back", callback_data: "settings:list" }],
    ...(["letters", "names", "directories"] as const).map((value) => [{
      text: `${mode === value ? "🟢 " : ""}${value}`,
      callback_data: `settings:set:thread-display:${value}`,
    }]),
  ] };
}

export function buildAutomaticThreadCleanupSettingsReplyMarkup(
  enabled: boolean,
  canReviewInactiveThreads = false,
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
      ...(canReviewInactiveThreads ? [[{
        text: "🔎 Review inactive tabs",
        callback_data: "settings:review:inactive-threads",
      }]] : []),
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

export function buildActivityVerbositySettingsReplyMarkup(
  verbosity: TelegramActivityVerbosity,
): TelegramSettingsMenuReplyMarkup {
  const button = (value: TelegramActivityVerbosity) => ({
    text: `${value === verbosity ? "🟢 " : ""}${value}`,
    callback_data: `settings:set:activity-verbosity:${value}`,
  });
  return {
    inline_keyboard: [
      [{ text: "⬆️ Back", callback_data: "settings:list" }],
      [button("quiet")],
      [button("thinking"), button("tools")],
      [button("verbose")],
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
  const modes: TelegramVoiceReplyMode[] = ["manual", "mirror", "always"];
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
      deps.areDraftPreviewsEnabled(),
      deps.getAssistantRenderingMode(),
      deps.getVoiceReplyMode(),
      deps.getTimeInjectionMode(),
      sectionRegistry,
      deps.isVoiceReplyModeConfigured(),
      deps.isAutomaticThreadCleanupEnabled(),
      deps.getActivityVerbosity(),
      deps.getThreadDisplayMode?.(),
    ),
  );
}

export async function updateAutomaticThreadCleanupSettingsMessage(
  deps: TelegramSettingsMenuCallbackDeps,
): Promise<void> {
  const enabled = deps.isAutomaticThreadCleanupEnabled();
  await deps.updateSettingsMessage(
    buildAutomaticThreadCleanupSettingsText(enabled),
    buildAutomaticThreadCleanupSettingsReplyMarkup(enabled, !!deps.reviewInactiveThreads),
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

export async function updateActivityVerbositySettingsMessage(
  deps: TelegramSettingsMenuCallbackDeps,
): Promise<void> {
  const verbosity = deps.getActivityVerbosity();
  await deps.updateSettingsMessage(
    buildActivityVerbositySettingsText(verbosity),
    buildActivityVerbositySettingsReplyMarkup(verbosity),
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
  if (data === "settings:open:thread-display" || data.startsWith("settings:set:thread-display:")) {
    if (!deps.getThreadDisplayMode?.() || !deps.setThreadDisplayMode) {
      await deps.answerCallbackQuery(callbackQueryId, "Thread display requires Threaded Mode and a connected instance.");
      return true;
    }
    if (data.startsWith("settings:set:thread-display:")) {
      const mode = data.slice("settings:set:thread-display:".length);
      if (mode !== "letters" && mode !== "names" && mode !== "directories") {
        await deps.answerCallbackQuery(callbackQueryId, "Unknown Thread display mode.");
        return true;
      }
      try {
        await deps.setThreadDisplayMode(mode);
      } catch {
        await deps.answerCallbackQuery(callbackQueryId, "Thread display was not fully applied. The preference may be saved; retry after checking the leader.");
        return true;
      }
    }
    const mode = deps.getThreadDisplayMode();
    if (!mode) {
      await deps.answerCallbackQuery(callbackQueryId, "Threaded Mode is no longer available.");
      return true;
    }
    await deps.updateSettingsMessage(
      buildThreadDisplaySettingsText(mode),
      buildThreadDisplaySettingsReplyMarkup(mode),
    );
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
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
  if (
    data === "settings:open:proactive" ||
    data === "settings:set:proactive:on" ||
    data === "settings:set:proactive:off"
  ) {
    await updateTelegramSettingsMenuMessage(deps, deps.sectionRegistry);
    await deps.answerCallbackQuery(
      callbackQueryId,
      "Public assistant output is always delivered while Telegram is connected.",
    );
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
  if (data === "settings:open:activity-verbosity") {
    await updateActivityVerbositySettingsMessage(deps);
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
      mode === "manual" ||
      mode === "hidden" ||
      mode === "mirror" ||
      mode === "always"
    ) {
      const normalizedMode = mode === "hidden" ? "manual" : mode;
      await deps.setVoiceReplyMode(normalizedMode);
      await updateVoiceReplyModeSettingsMessage(deps);
      await deps.answerCallbackQuery(
        callbackQueryId,
        `Voice reply mode: ${normalizedMode}`,
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
  if (data.startsWith("settings:set:activity-verbosity:")) {
    const verbosity = data.slice("settings:set:activity-verbosity:".length);
    if (
      verbosity === "quiet" ||
      verbosity === "thinking" ||
      verbosity === "tools" ||
      verbosity === "verbose"
    ) {
      await deps.setActivityVerbosity(verbosity);
      await updateActivityVerbositySettingsMessage(deps);
      await deps.answerCallbackQuery(
        callbackQueryId,
        `Activity: ${verbosity}`,
      );
      return true;
    }
  }
  if (data === "settings:review:inactive-threads") {
    if (!deps.reviewInactiveThreads) {
      await deps.answerCallbackQuery(callbackQueryId, "Inactive tab review is unavailable.");
      return true;
    }
    try {
      const review = await deps.reviewInactiveThreads();
      if (review.count === 0) {
        await deps.answerCallbackQuery(callbackQueryId, "No proven inactive tabs.");
      } else {
        await deps.updateSettingsMessage(buildInactiveThreadReviewText(review.count),
          buildInactiveThreadReviewReplyMarkup(review.operationId, !!deps.cleanInactiveThreads));
        await deps.answerCallbackQuery(callbackQueryId, "Review prepared. No tabs were deleted.");
      }
    } catch {
      await deps.answerCallbackQuery(callbackQueryId, "Could not safely review inactive tabs.");
    }
    return true;
  }
  if (data.startsWith("settings:clean:")) {
    const operationId = data.slice("settings:clean:".length);
    if (!/^thread-cleanup:[a-f0-9]{32}$/u.test(operationId) || !deps.cleanInactiveThreads) {
      await deps.answerCallbackQuery(callbackQueryId, "Cleanup confirmation is unavailable or stale.");
      return true;
    }
    try {
      const result = await deps.cleanInactiveThreads(operationId);
      await deps.answerCallbackQuery(callbackQueryId,
        `Deleted: ${result.deleted}. Outcome unknown: ${result.outcomeUnknown}.` +
      (result.blocked ? ` Blocked: ${result.blocked}.` : "") +
      (result.recovery === "commit-ready" ? " Recovery: safe local commit pending." :
        result.recovery === "deletion-outcome-unknown" ? " Recovery: deletion outcome unknown; no retry." :
        result.recovery === "authority-blocked" ? " Recovery: cleanup authority unavailable." : ""));
    } catch {
      await deps.answerCallbackQuery(callbackQueryId, "Cleanup could not be safely completed.");
    }
    return true;
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
      `Thread cleanup ${enabled ? "enabled" : "disabled"}`,
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
          areDraftPreviewsEnabled: deps.areDraftPreviewsEnabled,
          getAssistantRenderingMode: deps.getAssistantRenderingMode,
          getActivityVerbosity: deps.getActivityVerbosity,
          getVoiceReplyMode: deps.getVoiceReplyMode,
          isVoiceReplyModeConfigured: deps.isVoiceReplyModeConfigured,
          getTimeInjectionMode: deps.getTimeInjectionMode,
          isAutomaticThreadCleanupEnabled: deps.isAutomaticThreadCleanupEnabled,
          getThreadDisplayMode: deps.getThreadDisplayMode,
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
          areDraftPreviewsEnabled: deps.areDraftPreviewsEnabled,
          getAssistantRenderingMode: deps.getAssistantRenderingMode,
          getActivityVerbosity: deps.getActivityVerbosity,
          getVoiceReplyMode: deps.getVoiceReplyMode,
          isVoiceReplyModeConfigured: deps.isVoiceReplyModeConfigured,
          getTimeInjectionMode: deps.getTimeInjectionMode,
          isAutomaticThreadCleanupEnabled: deps.isAutomaticThreadCleanupEnabled,
          getThreadDisplayMode: deps.getThreadDisplayMode,
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
        areDraftPreviewsEnabled: deps.areDraftPreviewsEnabled,
        getAssistantRenderingMode: deps.getAssistantRenderingMode,
        getActivityVerbosity: deps.getActivityVerbosity,
        getVoiceReplyMode: deps.getVoiceReplyMode,
        isVoiceReplyModeConfigured: deps.isVoiceReplyModeConfigured,
        getTimeInjectionMode: deps.getTimeInjectionMode,
        isAutomaticThreadCleanupEnabled: deps.isAutomaticThreadCleanupEnabled,
        getThreadDisplayMode: deps.getThreadDisplayMode,
        setThreadDisplayMode: deps.setThreadDisplayMode,
        setDraftPreviewsEnabled: deps.setDraftPreviewsEnabled,
        setAssistantRenderingMode: deps.setAssistantRenderingMode,
        setActivityVerbosity: deps.setActivityVerbosity,
        setVoiceReplyMode: deps.setVoiceReplyMode,
        setTimeInjectionMode: deps.setTimeInjectionMode,
        setAutomaticThreadCleanupEnabled: deps.setAutomaticThreadCleanupEnabled,
        ...(deps.reviewInactiveThreads ? { reviewInactiveThreads: deps.reviewInactiveThreads } : {}),
        ...(deps.cleanInactiveThreads ? { cleanInactiveThreads: deps.cleanInactiveThreads } : {}),
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
