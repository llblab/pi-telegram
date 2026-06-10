/**
 * Telegram outbound button helpers
 * Zones: telegram outbound, assistant markup, callback routing
 * Owns assistant-authored telegram_button extraction, button action storage, callback handling, and prompt-turn construction
 */

import { randomUUID } from "node:crypto";

import type { TelegramInlineKeyboardMarkup } from "./keyboard.ts";
import {
  parseTelegramCommentAttributes,
  parseTopLevelTelegramComment,
  replaceTopLevelHtmlComments,
} from "./outbound-markup.ts";
import {
  type PendingTelegramTurn,
  truncateTelegramQueueSummary,
} from "./queue.ts";

const TELEGRAM_BUTTON_CALLBACK_PREFIX = "tgbtn";
const TELEGRAM_BUTTON_ACTION_TTL_MS = 24 * 60 * 60 * 1000;

export interface TelegramOutboundButtonAction {
  text: string;
  prompt: string;
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
    chat?: { id?: number };
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
  ) => void;
}

function nowMs(): number {
  return Date.now();
}

function normalizeMarkdownAfterButtonExtraction(markdown: string): string {
  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}

function parseButtonsCommentAttributes(input: string): {
  label?: string;
  prompt?: string;
} {
  const attributes = parseTelegramCommentAttributes(input);
  return {
    ...(attributes.label ? { label: attributes.label } : {}),
    ...(attributes.prompt ? { prompt: attributes.prompt } : {}),
  };
}

function parseButtonsCommentRows(
  head: string,
  body: string | undefined,
): TelegramOutboundButtonAction[][] {
  const trimmedHead = head.trim();

  if (body === undefined) {
    if (trimmedHead.startsWith(":")) {
      const label = trimmedHead.slice(1).trim();
      return label ? [[{ text: label, prompt: label }]] : [];
    }
    const attributes = parseButtonsCommentAttributes(head);
    return attributes.label && attributes.prompt
      ? [[{ text: attributes.label, prompt: attributes.prompt }]]
      : [];
  }

  const label = parseButtonsCommentAttributes(head).label;
  const prompt = body.trim();
  if (!label || !prompt) return [];
  return [[{ text: label, prompt }]];
}

export function createTelegramButtonActionStore(
  options: { ttlMs?: number } = {},
): TelegramButtonActionStore {
  const ttlMs = options.ttlMs ?? TELEGRAM_BUTTON_ACTION_TTL_MS;
  const actions = new Map<string, TelegramOutboundButtonStoredAction>();
  function cleanup(currentTime: number): void {
    for (const [key, action] of actions) {
      if (currentTime - action.createdAt > ttlMs) actions.delete(key);
    }
  }
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
      return { text: action.text, prompt: action.prompt };
    },
  };
}

export function planTelegramButtonReply(
  markdown: string,
  deps: { registerAction: (action: TelegramOutboundButtonAction) => string },
): TelegramButtonReplyPlan {
  const keyboard: TelegramOutboundButtonMarkup["inline_keyboard"] = [];
  const stripped = replaceTopLevelHtmlComments(markdown, (comment) => {
    const command = parseTopLevelTelegramComment(comment, "telegram_button");
    if (!command) return comment.raw;
    const rows = parseButtonsCommentRows(command.head, command.body);
    for (const row of rows) {
      keyboard.push(
        row.map((button) => ({
          text: button.text,
          callback_data: deps.registerAction(button),
        })),
      );
    }
    return "";
  });
  return {
    markdown: normalizeMarkdownAfterButtonExtraction(stripped),
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
}): PendingTelegramTurn {
  const prompt = `[telegram] ${options.action.prompt}`;
  return {
    kind: "prompt",
    chatId: options.chatId,
    replyToMessageId: options.replyToMessageId,
    sourceMessageIds: [options.replyToMessageId],
    queueOrder: options.queueOrder,
    queueLane: "default",
    laneOrder: options.queueOrder,
    queuedAttachments: [],
    content: [{ type: "text", text: prompt }],
    historyText: options.action.prompt,
    statusSummary: truncateTelegramQueueSummary(
      options.action.text || options.action.prompt,
    ),
  };
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

  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  if (typeof chatId !== "number" || typeof messageId !== "number") {
    await deps.answerCallbackQuery(query.id, "Button action expired.");
    return true;
  }

  deps.enqueueButtonPrompt(query, action, ctx);
  await deps.answerCallbackQuery(query.id, "Queued.");
  return true;
}
