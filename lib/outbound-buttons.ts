/**
 * Telegram outbound button helpers
 * Zones: telegram outbound, assistant markup, callback routing
 * Owns assistant-authored telegram_button extraction, button action storage, callback handling, and prompt-turn construction
 */

import { randomUUID } from "node:crypto";

import type {
  TelegramInlineKeyboardButtonStyle,
  TelegramInlineKeyboardMarkup,
} from "./keyboard.ts";
import {
  parseTelegramActionPayloadRows,
  parseTelegramButtonPayloadRows,
  replaceTelegramButtonFences,
  replaceTopLevelHtmlComments,
} from "./outbound-markup.ts";
import {
  type PendingTelegramTurn,
  type TelegramQueueTarget,
  truncateTelegramQueueSummary,
} from "./queue.ts";

const TELEGRAM_BUTTON_CALLBACK_PREFIX = "tgbtn";
const TELEGRAM_BUTTON_ACTION_TTL_MS = 24 * 60 * 60 * 1000;

export interface TelegramOutboundButtonBinding {
  generation: string;
  app: string;
  revision: number;
}

export interface TelegramOutboundButtonAction {
  text: string;
  prompt: string;
  binding?: TelegramOutboundButtonBinding;
  selectedStyle?: TelegramInlineKeyboardButtonStyle;
  disabled?: true;
}

export interface TelegramOutboundButtonStoredAction extends TelegramOutboundButtonAction {
  createdAt: number;
}

export type TelegramOutboundButtonMarkup = TelegramInlineKeyboardMarkup;

export interface TelegramButtonReplyPlan {
  markdown: string;
  replyMarkup?: TelegramOutboundButtonMarkup;
}

export interface TelegramButtonActionStore {
  register: (action: TelegramOutboundButtonAction) => string;
  resolve: (
    callbackData: string | undefined,
  ) => TelegramOutboundButtonAction | undefined;
}

export interface TelegramButtonCallbackQuery {
  id: string;
  data?: string;
  message?: {
    message_id?: number;
    message_thread_id?: number;
    chat?: { id?: number };
    reply_markup?: TelegramOutboundButtonMarkup;
  };
}

export interface TelegramButtonCallbackHandlerDeps<TContext = unknown> {
  resolveAction: (
    callbackData: string | undefined,
  ) => TelegramOutboundButtonAction | undefined;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  enqueueButtonPrompt: (
    query: TelegramButtonCallbackQuery,
    action: TelegramOutboundButtonAction,
    ctx: TContext,
  ) => boolean | void;
  invokeBoundAction?: (
    query: TelegramButtonCallbackQuery,
    action: TelegramOutboundButtonAction,
    ctx: TContext,
  ) => Promise<false | "new" | "edit">;
  editMessageReplyMarkup?: (
    chatId: number,
    messageId: number,
    replyMarkup: TelegramOutboundButtonMarkup,
  ) => Promise<void>;
}

function nowMs(): number {
  return Date.now();
}

function normalizeMarkdownAfterButtonExtraction(markdown: string): string {
  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}

function getTelegramButtonString(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseTelegramButtonAction(
  payload: Record<string, unknown>,
): TelegramOutboundButtonAction | undefined {
  const value = getTelegramButtonString(payload, "value");
  const explicitLabel = getTelegramButtonString(payload, "label");
  const explicitPrompt = getTelegramButtonString(payload, "prompt");
  const label = explicitLabel ?? value ?? explicitPrompt;
  if (payload.disabled !== undefined && typeof payload.disabled !== "boolean") {
    return undefined;
  }
  if (payload.disabled === true) {
    return { text: label ?? "", prompt: "", disabled: true };
  }
  const prompt = explicitPrompt ?? value ?? explicitLabel;
  if (!label || !prompt) return undefined;
  const selectedStyle = payload.selected_style;
  return {
    text: label,
    prompt,
    ...(selectedStyle === "success" ||
    selectedStyle === "danger" ||
    selectedStyle === "primary"
      ? { selectedStyle }
      : {}),
  };
}

export function createTelegramButtonActionStore(
  options: { ttlMs?: number } = {},
): TelegramButtonActionStore {
  const ttlMs = options.ttlMs ?? TELEGRAM_BUTTON_ACTION_TTL_MS;
  const actions = new Map<string, TelegramOutboundButtonStoredAction>();
  const cleanup = (currentTime: number): void => {
    for (const [key, action] of actions) {
      if (currentTime - action.createdAt > ttlMs) actions.delete(key);
    }
  };
  return {
    register: (action) => {
      const currentTime = nowMs();
      cleanup(currentTime);
      const key = `${TELEGRAM_BUTTON_CALLBACK_PREFIX}:${randomUUID().slice(0, 8)}`;
      actions.set(key, { ...action, createdAt: currentTime });
      return key;
    },
    resolve: (callbackData) => {
      if (!callbackData?.startsWith(`${TELEGRAM_BUTTON_CALLBACK_PREFIX}:`)) {
        return undefined;
      }
      const currentTime = nowMs();
      cleanup(currentTime);
      const action = actions.get(callbackData);
      if (!action) return undefined;
      actions.delete(callbackData);
      return {
        text: action.text,
        prompt: action.prompt,
        ...(action.disabled ? { disabled: true as const } : {}),
        ...(action.binding ? { binding: action.binding } : {}),
        ...(action.selectedStyle
          ? { selectedStyle: action.selectedStyle }
          : {}),
      };
    },
  };
}

const DEFAULT_TELEGRAM_BUTTON_REPLY_MARKDOWN =
  "☑️ **Choose an option:**";

function escapeTelegramRichButtonText(text: string): string {
  return text.replace(/[&<>"'`\\*_\[\]{}$~\r\n]/g, (character) =>
    `&#${character.charCodeAt(0)};`,
  );
}

function renderTelegramRichButtonRow(
  row: TelegramOutboundButtonMarkup["inline_keyboard"][number],
): string {
  return `<tg-button-row>${row.map((button) => {
    const attributes = button.disabled
      ? 'type="disabled"'
      : `type="callback_data" data="${escapeTelegramRichButtonText(button.callback_data)}"`;
    return `<tg-button ${attributes}>${escapeTelegramRichButtonText(button.text)}</tg-button>`;
  }).join("")}</tg-button-row>`;
}

export function planTelegramButtonReply(
  markdown: string,
  deps: {
    registerAction: (action: TelegramOutboundButtonAction) => string;
    binding?: TelegramOutboundButtonBinding;
    rendering?: "rich" | "html";
  },
): TelegramButtonReplyPlan {
  const keyboard: TelegramOutboundButtonMarkup["inline_keyboard"] = [];
  const buildRows = (
    payloadRows: Record<string, unknown>[][],
    rich: boolean,
  ): TelegramOutboundButtonMarkup["inline_keyboard"] | undefined => {
    const actions = payloadRows.map((row) => row.map(parseTelegramButtonAction));
    if (actions.some((row) => row.some((action) => !action))) return undefined;
    if (rich && actions.some((row) => {
      const projected = row.map((action) => action!.disabled
        ? { text: action!.text || "\u00a0", disabled: {} }
        : { text: action!.text, callback_data: "x".repeat(64) });
      return row.length > 8 || renderTelegramRichButtonRow(projected).length > 32768;
    })) return undefined;
    return actions.map((row) => row.map((action) => action!.disabled
      ? { text: action!.text || "\u00a0", disabled: {} }
      : {
          text: action!.text,
          callback_data: deps.registerAction({
            ...action!,
            ...(deps.binding ? { binding: deps.binding } : {}),
          }),
        }));
  };
  const withRichButtons = replaceTelegramButtonFences(markdown, (payload, closed) => {
    if (!closed) return "";
    const payloadRows = parseTelegramButtonPayloadRows(payload);
    if (!payloadRows) return "";
    const rich = deps.rendering !== "html";
    const rows = buildRows(payloadRows, rich);
    if (!rows) return "";
    if (!rich) {
      keyboard.push(...rows);
      return "";
    }
    return `\n${rows.map(renderTelegramRichButtonRow).join("\n\n")}\n`;
  });
  const stripped = replaceTopLevelHtmlComments(withRichButtons, (comment) => {
    const command = "telegram_button";
    const normalizedContent = comment.content.replace(/^\s+/, "").replace(/^!/, "");
    if (!normalizedContent.startsWith(command)) return comment.raw;
    const payloadRows = parseTelegramActionPayloadRows(comment, command);
    if (!payloadRows) return "";
    const rows = buildRows(payloadRows, false);
    if (rows) keyboard.push(...rows);
    return "";
  });
  const visibleMarkdown = normalizeMarkdownAfterButtonExtraction(stripped);
  return {
    markdown:
      keyboard.length > 0 && !visibleMarkdown
        ? DEFAULT_TELEGRAM_BUTTON_REPLY_MARKDOWN
        : visibleMarkdown,
    ...(keyboard.length > 0
      ? { replyMarkup: { inline_keyboard: keyboard } }
      : {}),
  };
}

export function createTelegramButtonReplyPlanner(
  store: Pick<TelegramButtonActionStore, "register">,
): (markdown: string) => TelegramButtonReplyPlan {
  return (markdown) =>
    planTelegramButtonReply(markdown, { registerAction: store.register });
}

export function createTelegramButtonPromptTurn(options: {
  chatId: number;
  replyToMessageId: number;
  queueOrder: number;
  action: TelegramOutboundButtonAction;
  target?: TelegramQueueTarget;
  telegramPrefix?: string;
}): PendingTelegramTurn {
  const prompt = `${options.telegramPrefix ?? "[telegram]"} ${options.action.prompt}`;
  return {
    kind: "prompt",
    chatId: options.chatId,
    ...(options.target ? { target: options.target } : {}),
    replyToMessageId: options.replyToMessageId,
    sourceMessageIds: [options.replyToMessageId],
    queueOrder: options.queueOrder,
    queueLane: "priority",
    laneOrder: options.queueOrder,
    queuedAttachments: [],
    content: [{ type: "text", text: prompt }],
    historyText: options.action.prompt,
    statusSummary: truncateTelegramQueueSummary(
      options.action.text || options.action.prompt,
    ),
  };
}

export function markTelegramButtonSelected(
  replyMarkup: TelegramOutboundButtonMarkup,
  callbackData: string,
  selectedStyle: TelegramInlineKeyboardButtonStyle = "primary",
): TelegramOutboundButtonMarkup | undefined {
  let matched = false;
  const inlineKeyboard = replyMarkup.inline_keyboard.map((row) =>
    row.map((button) => {
      if (button.disabled || button.callback_data !== callbackData) return { ...button };
      matched = true;
      return { ...button, style: selectedStyle };
    }),
  );
  return matched ? { inline_keyboard: inlineKeyboard } : undefined;
}

export async function handleTelegramButtonCallbackQuery<TContext = unknown>(
  query: TelegramButtonCallbackQuery,
  ctx: TContext,
  deps: TelegramButtonCallbackHandlerDeps<TContext>,
): Promise<boolean> {
  const action = deps.resolveAction(query.data);

  if (!action) {
    if (query.data?.startsWith(`${TELEGRAM_BUTTON_CALLBACK_PREFIX}:`)) {
      await deps.answerCallbackQuery(query.id, "Button action expired.");
      return true;
    }
    return false;
  }

  if (action.disabled) {
    await deps.answerCallbackQuery(query.id, "Button action unavailable.");
    return true;
  }

  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  if (typeof chatId !== "number" || typeof messageId !== "number") {
    await deps.answerCallbackQuery(query.id, "Button action expired.");
    return true;
  }

  if (deps.invokeBoundAction) {
    try {
      const viewMode = await deps.invokeBoundAction(query, action, ctx);
      if (viewMode) {
        if (viewMode === "new" && query.data && query.message?.reply_markup) {
          const selectedMarkup = markTelegramButtonSelected(
            query.message.reply_markup,
            query.data,
            action.selectedStyle,
          );
          if (selectedMarkup && deps.editMessageReplyMarkup) {
            try {
              await deps.editMessageReplyMarkup(chatId, messageId, selectedMarkup);
            } catch {
              // The action already succeeded; old-surface styling is best-effort.
            }
          }
        }
        await deps.answerCallbackQuery(query.id, "Done.");
        return true;
      }
    } catch (error) {
      await deps.answerCallbackQuery(query.id, "Generative App action failed.");
      throw error;
    }
  }

  const enqueued = deps.enqueueButtonPrompt(query, action, ctx);
  if (enqueued === false) {
    await deps.answerCallbackQuery(query.id, "Already queued.");
    return true;
  }
  const selectedMarkup =
    query.data && query.message?.reply_markup
      ? markTelegramButtonSelected(
          query.message.reply_markup,
          query.data,
          action.selectedStyle,
        )
      : undefined;
  if (selectedMarkup && deps.editMessageReplyMarkup) {
    await deps.editMessageReplyMarkup(chatId, messageId, selectedMarkup);
  }
  await deps.answerCallbackQuery(query.id, "Queued.");
  return true;
}
