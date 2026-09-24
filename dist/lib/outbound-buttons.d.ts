/**
 * Telegram outbound button helpers
 * Zones: telegram outbound, assistant markup, callback routing
 * Owns assistant-authored telegram_button extraction, button action storage, callback handling, and prompt-turn construction
 */
import type { TelegramInlineKeyboardButtonStyle, TelegramInlineKeyboardMarkup } from "./keyboard.ts";
import { type PendingTelegramTurn, type TelegramQueueTarget } from "./queue.ts";
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
    resolve: (callbackData: string | undefined) => TelegramOutboundButtonAction | undefined;
}
export interface TelegramButtonCallbackQuery {
    id: string;
    data?: string;
    message?: {
        message_id?: number;
        message_thread_id?: number;
        chat?: {
            id?: number;
        };
        reply_markup?: TelegramOutboundButtonMarkup;
    };
}
export interface TelegramButtonCallbackHandlerDeps<TContext = unknown> {
    resolveAction: (callbackData: string | undefined) => TelegramOutboundButtonAction | undefined;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    enqueueButtonPrompt: (query: TelegramButtonCallbackQuery, action: TelegramOutboundButtonAction, ctx: TContext) => boolean | void;
    invokeBoundAction?: (query: TelegramButtonCallbackQuery, action: TelegramOutboundButtonAction, ctx: TContext) => Promise<false | "new" | "edit">;
    editMessageReplyMarkup?: (chatId: number, messageId: number, replyMarkup: TelegramOutboundButtonMarkup) => Promise<void>;
}
export declare function createTelegramButtonActionStore(options?: {
    ttlMs?: number;
}): TelegramButtonActionStore;
export declare function planTelegramButtonReply(markdown: string, deps: {
    registerAction: (action: TelegramOutboundButtonAction) => string;
    binding?: TelegramOutboundButtonBinding;
    rendering?: "rich" | "html";
}): TelegramButtonReplyPlan;
export declare function createTelegramButtonReplyPlanner(store: Pick<TelegramButtonActionStore, "register">): (markdown: string) => TelegramButtonReplyPlan;
export declare function createTelegramButtonPromptTurn(options: {
    chatId: number;
    replyToMessageId: number;
    queueOrder: number;
    action: TelegramOutboundButtonAction;
    target?: TelegramQueueTarget;
    telegramPrefix?: string;
}): PendingTelegramTurn;
export declare function markTelegramButtonSelected(replyMarkup: TelegramOutboundButtonMarkup, callbackData: string, selectedStyle?: TelegramInlineKeyboardButtonStyle): TelegramOutboundButtonMarkup | undefined;
export declare function handleTelegramButtonCallbackQuery<TContext = unknown>(query: TelegramButtonCallbackQuery, ctx: TContext, deps: TelegramButtonCallbackHandlerDeps<TContext>): Promise<boolean>;
