/**
 * Telegram status menu UI helpers
 * Zones: telegram ui, status controls, menu composition
 * Owns status-menu payloads, status callback handling, and status-menu message rendering
 */

import { formatTelegramCommandEmojiPrefix } from "./commands.ts";
import {
  formatStatusButtonLabel,
  type TelegramMenuMessageRuntimeDeps,
  type TelegramMenuRenderPayload,
  type TelegramModelMenuState,
  type TelegramReplyMarkup,
} from "./menu-model.ts";
import {
  getCanonicalModelId,
  type MenuModel,
  type ThinkingLevel,
} from "./model.ts";

export interface TelegramStatusMenuCallbackDeps {
  updateModelMenuMessage: () => Promise<void>;
  updateThinkingMenuMessage: () => Promise<void>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
}

export interface TelegramStatusMenuOpenDeps<
  TModel extends MenuModel = MenuModel,
> {
  isIdle: () => boolean;
  sendBusyMessage: () => Promise<void>;
  getModelMenuState: () => Promise<TelegramModelMenuState<TModel>>;
  buildStatusHtml: () => string;
  getActiveModel: () => TModel | undefined;
  getThinkingLevel: () => ThinkingLevel;
  getQueueItemCount?: () => number;
  sendStatusMenu: (
    state: TelegramModelMenuState<TModel>,
    statusHtml: string,
    activeModel: TModel | undefined,
    thinkingLevel: ThinkingLevel,
    queueItemCount: number,
  ) => Promise<number | undefined>;
  storeModelMenuState: (state: TelegramModelMenuState<TModel>) => void;
}

function isTelegramStatusMenuCallbackAction(
  data: string | undefined,
  action: "model" | "thinking",
): boolean {
  return data === `status:${action}`;
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

export async function openTelegramStatusMenu<
  TModel extends MenuModel = MenuModel,
>(deps: TelegramStatusMenuOpenDeps<TModel>): Promise<void> {
  const state = await deps.getModelMenuState();
  const messageId = await deps.sendStatusMenu(
    state,
    deps.buildStatusHtml(),
    deps.getActiveModel(),
    deps.getThinkingLevel(),
    deps.getQueueItemCount?.() ?? 0,
  );
  if (messageId === undefined) return;
  state.messageId = messageId;
  state.mode = "status";
  deps.storeModelMenuState(state);
}

export async function handleTelegramStatusMenuCallbackAction(
  callbackQueryId: string,
  data: string | undefined,
  activeModel: MenuModel | undefined,
  deps: TelegramStatusMenuCallbackDeps,
): Promise<boolean> {
  if (isTelegramStatusMenuCallbackAction(data, "model")) {
    await deps.updateModelMenuMessage();
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (!isTelegramStatusMenuCallbackAction(data, "thinking")) return false;
  if (!activeModel?.reasoning) {
    await deps.answerCallbackQuery(
      callbackQueryId,
      "This model has no reasoning controls.",
    );
    return true;
  }
  await deps.updateThinkingMenuMessage();
  await deps.answerCallbackQuery(callbackQueryId);
  return true;
}

export function buildStatusReplyMarkup(
  activeModel: MenuModel | undefined,
  currentThinkingLevel: ThinkingLevel,
  queueItemCount = 0,
): TelegramReplyMarkup {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  rows.push([
    {
      text: formatStatusButtonLabel(
        `${formatTelegramCommandEmojiPrefix("model")}Model`,
        activeModel ? getCanonicalModelId(activeModel) : "unknown",
      ),
      callback_data: "status:model",
    },
  ]);
  if (activeModel?.reasoning) {
    rows.push([
      {
        text: formatStatusButtonLabel(
          `${formatTelegramCommandEmojiPrefix("thinking")}Thinking`,
          currentThinkingLevel,
        ),
        callback_data: "status:thinking",
      },
    ]);
  }
  rows.push([
    {
      text: `🔢 Queue: ${queueItemCount}`,
      callback_data: "status:queue",
    },
  ]);
  return { inline_keyboard: rows };
}

export function buildTelegramStatusMenuRenderPayload(
  statusText: string,
  activeModel: MenuModel | undefined,
  currentThinkingLevel: ThinkingLevel,
  queueItemCount = 0,
): TelegramMenuRenderPayload {
  return {
    nextMode: "status",
    text: statusText,
    mode: "html",
    replyMarkup: buildStatusReplyMarkup(
      activeModel,
      currentThinkingLevel,
      queueItemCount,
    ),
  };
}

export async function updateTelegramStatusMessage(
  state: TelegramModelMenuState,
  statusText: string,
  activeModel: MenuModel | undefined,
  currentThinkingLevel: ThinkingLevel,
  deps: TelegramMenuMessageRuntimeDeps,
  queueItemCount = 0,
): Promise<void> {
  await editTelegramMenuMessage(
    state,
    buildTelegramStatusMenuRenderPayload(
      statusText,
      activeModel,
      currentThinkingLevel,
      queueItemCount,
    ),
    deps,
  );
}

export function sendTelegramStatusMessage(
  state: TelegramModelMenuState,
  statusText: string,
  activeModel: MenuModel | undefined,
  currentThinkingLevel: ThinkingLevel,
  deps: TelegramMenuMessageRuntimeDeps,
  queueItemCount = 0,
): Promise<number | undefined> {
  return sendTelegramMenuMessage(
    state,
    buildTelegramStatusMenuRenderPayload(
      statusText,
      activeModel,
      currentThinkingLevel,
      queueItemCount,
    ),
    deps,
  );
}
