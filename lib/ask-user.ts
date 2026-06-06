/**
 * Telegram ask_user fallback helpers
 * Zones: telegram outbound, pi agent tools
 * Owns forwarding pi-ask-user prompts to Telegram when an active Telegram turn would otherwise open hidden local UI
 */

import type { PendingTelegramTurn } from "./queue.ts";

export interface TelegramAskUserQuestionOption {
  title: string;
  description?: string;
}

export interface TelegramAskUserToolInput {
  question?: unknown;
  context?: unknown;
  options?: unknown;
  allowMultiple?: unknown;
  allowFreeform?: unknown;
  allowComment?: unknown;
}

export interface TelegramAskUserToolCallEvent {
  toolName?: string;
  input?: TelegramAskUserToolInput;
}

export interface TelegramAskUserToolCallResult {
  block: true;
  reason: string;
}

export interface TelegramAskUserReplyMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface TelegramAskUserReplyPlan {
  markdown: string;
  replyMarkup?: TelegramAskUserReplyMarkup;
}

export interface TelegramAskUserButtonAction {
  text: string;
  prompt: string;
}

export interface TelegramAskUserToolCallGuardDeps<TContext = unknown> {
  getActiveTurn: () => PendingTelegramTurn | undefined;
  registerButtonAction: (action: TelegramAskUserButtonAction) => string;
  sendMarkdownReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    markdown: string,
    options?: { replyMarkup?: TelegramAskUserReplyMarkup },
  ) => Promise<unknown>;
  sendGuestReply?: (guestQueryId: string, markdown: string) => Promise<void>;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

const ASK_USER_FORWARDED_REASON =
  "ask_user was forwarded to Telegram for this active turn; wait for the user's Telegram reply instead of opening a hidden local UI prompt.";

const ASK_USER_FORWARD_FAILED_REASON =
  "ask_user could not be forwarded to Telegram. Ask the question in your final Telegram reply instead, using visible text and telegram_button comments when useful.";

function normalizeAskUserOption(input: unknown): TelegramAskUserQuestionOption | undefined {
  if (typeof input === "string") {
    const title = input.trim();
    return title ? { title } : undefined;
  }
  if (!input || typeof input !== "object") return undefined;
  const candidate = input as { title?: unknown; description?: unknown };
  if (typeof candidate.title !== "string") return undefined;
  const title = candidate.title.trim();
  if (!title) return undefined;
  const description =
    typeof candidate.description === "string" && candidate.description.trim()
      ? candidate.description.trim()
      : undefined;
  return description ? { title, description } : { title };
}

function normalizeAskUserOptions(input: unknown): TelegramAskUserQuestionOption[] {
  if (!Array.isArray(input)) return [];
  return input
    .map(normalizeAskUserOption)
    .filter((option): option is TelegramAskUserQuestionOption => !!option);
}

function normalizeOptionalString(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  return trimmed || undefined;
}

function buildTelegramAskUserSelectionPrompt(options: {
  question: string;
  context?: string;
  option: TelegramAskUserQuestionOption;
}): string {
  const lines = [
    `User selected "${options.option.title}" for the ask_user question.`,
    "",
    "Question:",
    options.question,
  ];
  if (options.context) {
    lines.push("", "Context:", options.context);
  }
  lines.push("", "Selected option:", options.option.title);
  if (options.option.description) {
    lines.push("", "Option details:", options.option.description);
  }
  return lines.join("\n");
}

export function buildTelegramAskUserFallbackMarkdown(
  input: TelegramAskUserToolInput,
): string {
  const question = normalizeOptionalString(input.question) ?? "Please answer this question.";
  const context = normalizeOptionalString(input.context);
  const options = normalizeAskUserOptions(input.options);
  const allowMultiple = input.allowMultiple === true;
  const allowFreeform = input.allowFreeform !== false;
  const allowComment = input.allowComment === true;
  const lines = ["**Question**", question];

  if (context) {
    lines.push("", "**Context**", context);
  }

  if (options.length > 0) {
    lines.push("", "**Options**");
    for (const [index, option] of options.entries()) {
      const description = option.description ? ` — ${option.description}` : "";
      lines.push(`${index + 1}. ${option.title}${description}`);
    }
  }

  if (allowMultiple) {
    lines.push("", "Reply with one or more selections.");
  } else if (options.length > 0 && allowFreeform) {
    lines.push("", "Choose an option or reply with your own answer.");
  } else if (options.length > 0) {
    lines.push("", "Choose one option.");
  } else {
    lines.push("", "Reply with your answer.");
  }

  if (allowComment) {
    lines.push("Add any extra context in your reply if needed.");
  }

  return lines.join("\n").trim();
}

export function planTelegramAskUserFallbackReply(
  input: TelegramAskUserToolInput,
  deps: { registerButtonAction: (action: TelegramAskUserButtonAction) => string },
): TelegramAskUserReplyPlan {
  const question = normalizeOptionalString(input.question) ?? "Please answer this question.";
  const context = normalizeOptionalString(input.context);
  const options = normalizeAskUserOptions(input.options);
  const allowMultiple = input.allowMultiple === true;
  const markdown = buildTelegramAskUserFallbackMarkdown(input);
  const keyboard: TelegramAskUserReplyMarkup["inline_keyboard"] = [];

  if (!allowMultiple) {
    for (const option of options) {
      const callbackData = deps.registerButtonAction({
        text: option.title,
        prompt: buildTelegramAskUserSelectionPrompt({ question, context, option }),
      });
      keyboard.push([{ text: option.title, callback_data: callbackData }]);
    }
  }

  return {
    markdown,
    ...(keyboard.length > 0 ? { replyMarkup: { inline_keyboard: keyboard } } : {}),
  };
}

function getAskUserToolInput(event: unknown): TelegramAskUserToolInput | undefined {
  if (!event || typeof event !== "object") return undefined;
  const candidate = event as TelegramAskUserToolCallEvent;
  if (candidate.toolName !== "ask_user") return undefined;
  if (!candidate.input || typeof candidate.input !== "object") return {};
  return candidate.input;
}

export function createTelegramAskUserToolCallGuard<TContext = unknown>(
  deps: TelegramAskUserToolCallGuardDeps<TContext>,
) {
  return async function onAskUserToolCall(
    event: unknown,
    _ctx: TContext,
  ): Promise<TelegramAskUserToolCallResult | undefined> {
    const input = getAskUserToolInput(event);
    if (!input) return undefined;
    const activeTurn = deps.getActiveTurn();
    if (!activeTurn) return undefined;
    try {
      if (activeTurn.guestQueryId) {
        if (!deps.sendGuestReply) {
          throw new Error("Telegram guest ask_user forwarding is unavailable");
        }
        await deps.sendGuestReply(
          activeTurn.guestQueryId,
          buildTelegramAskUserFallbackMarkdown(input),
        );
      } else {
        const plan = planTelegramAskUserFallbackReply(input, {
          registerButtonAction: deps.registerButtonAction,
        });
        await deps.sendMarkdownReply(
          activeTurn.chatId,
          activeTurn.replyToMessageId,
          plan.markdown,
          plan.replyMarkup ? { replyMarkup: plan.replyMarkup } : undefined,
        );
      }
      return { block: true, reason: ASK_USER_FORWARDED_REASON };
    } catch (error) {
      deps.recordRuntimeEvent?.("ask-user", error, {
        phase: "forward-telegram-question",
      });
      return { block: true, reason: ASK_USER_FORWARD_FAILED_REASON };
    }
  };
}
