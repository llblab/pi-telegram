/**
 * Telegram thinking menu UI helpers
 * Zones: telegram ui, thinking controls, menu composition
 * Owns thinking-menu text, reply markup, callback handling, and thinking-menu message rendering
 */

import type {
  TelegramMenuMessageRuntimeDeps,
  TelegramMenuRenderPayload,
  TelegramModelMenuState,
  TelegramReplyMarkup,
} from "./menu-model.ts";
import {
  isThinkingLevel,
  type MenuModel,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "./model.ts";

export interface TelegramThinkingMenuCallbackDeps {
  setThinkingLevel: (level: ThinkingLevel) => void;
  getCurrentThinkingLevel: () => ThinkingLevel;
  updateStatusMessage: () => Promise<void>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
}

export interface TelegramThinkingMenuOpenDeps<
  TModel extends MenuModel = MenuModel,
> extends TelegramMenuMessageRuntimeDeps {
  getModelMenuState: () => Promise<TelegramModelMenuState<TModel>>;
  getActiveModel: () => TModel | undefined;
  getThinkingLevel: () => ThinkingLevel;
  storeModelMenuState: (state: TelegramModelMenuState<TModel>) => void;
}

function parseTelegramThinkingMenuCallbackAction(
  data: string | undefined,
): { kind: "thinking:set"; level: string } | undefined {
  if (!data?.startsWith("thinking:set:")) return undefined;
  return { kind: "thinking:set", level: data.slice("thinking:set:".length) };
}

function applyTelegramMenuRenderPayload(
  state: TelegramModelMenuState,
  payload: TelegramMenuRenderPayload,
): TelegramMenuRenderPayload {
  state.mode = payload.nextMode;
  return payload;
}

async function editTelegramMenuMessage(
  state: TelegramModelMenuState,
  payload: TelegramMenuRenderPayload,
  deps: TelegramMenuMessageRuntimeDeps,
): Promise<void> {
  const appliedPayload = applyTelegramMenuRenderPayload(state, payload);
  await deps.editInteractiveMessage(
    state.chatId,
    state.messageId,
    appliedPayload.text,
    appliedPayload.mode,
    appliedPayload.replyMarkup,
  );
}

function sendTelegramMenuMessage(
  state: TelegramModelMenuState,
  payload: TelegramMenuRenderPayload,
  deps: TelegramMenuMessageRuntimeDeps,
): Promise<number | undefined> {
  const appliedPayload = applyTelegramMenuRenderPayload(state, payload);
  return deps.sendInteractiveMessage(
    state.chatId,
    appliedPayload.text,
    appliedPayload.mode,
    appliedPayload.replyMarkup,
  );
}

export async function handleTelegramThinkingMenuCallbackAction(
  callbackQueryId: string,
  data: string | undefined,
  activeModel: MenuModel | undefined,
  deps: TelegramThinkingMenuCallbackDeps,
): Promise<boolean> {
  const action = parseTelegramThinkingMenuCallbackAction(data);
  if (!action) return false;
  if (!isThinkingLevel(action.level)) {
    await deps.answerCallbackQuery(callbackQueryId, "Invalid thinking level.");
    return true;
  }
  if (!activeModel?.reasoning) {
    await deps.answerCallbackQuery(
      callbackQueryId,
      "This model has no reasoning controls.",
    );
    return true;
  }
  deps.setThinkingLevel(action.level);
  await deps.updateStatusMessage();
  await deps.answerCallbackQuery(
    callbackQueryId,
    `Thinking: ${deps.getCurrentThinkingLevel()}`,
  );
  return true;
}

export function buildThinkingMenuText(): string {
  return "<b>🧠 Choose a thinking level:</b>";
}

export function buildThinkingMenuReplyMarkup(
  currentThinkingLevel: ThinkingLevel,
): TelegramReplyMarkup {
  const rows = [[{ text: "⬆️ Main menu", callback_data: "menu:back" }]];
  rows.push(
    ...THINKING_LEVELS.map((level) => [
      {
        text: level === currentThinkingLevel ? `✅ ${level}` : level,
        callback_data: `thinking:set:${level}`,
      },
    ]),
  );
  return { inline_keyboard: rows };
}

export function buildTelegramThinkingMenuRenderPayload(
  _activeModel: MenuModel | undefined,
  currentThinkingLevel: ThinkingLevel,
): TelegramMenuRenderPayload {
  return {
    nextMode: "thinking",
    text: buildThinkingMenuText(),
    mode: "html",
    replyMarkup: buildThinkingMenuReplyMarkup(currentThinkingLevel),
  };
}

export async function openTelegramThinkingMenu<
  TModel extends MenuModel = MenuModel,
>(deps: TelegramThinkingMenuOpenDeps<TModel>): Promise<void> {
  const state = await deps.getModelMenuState();
  const messageId = await sendTelegramMenuMessage(
    state,
    buildTelegramThinkingMenuRenderPayload(
      deps.getActiveModel(),
      deps.getThinkingLevel(),
    ),
    deps,
  );
  if (messageId === undefined) return;
  state.messageId = messageId;
  state.mode = "thinking";
  deps.storeModelMenuState(state);
}

export async function updateTelegramThinkingMenuMessage(
  state: TelegramModelMenuState,
  activeModel: MenuModel | undefined,
  currentThinkingLevel: ThinkingLevel,
  deps: TelegramMenuMessageRuntimeDeps,
): Promise<void> {
  await editTelegramMenuMessage(
    state,
    buildTelegramThinkingMenuRenderPayload(activeModel, currentThinkingLevel),
    deps,
  );
}
