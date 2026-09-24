/**
 * Telegram queue menu UI helpers
 * Zones: telegram ui, queue controls, menu composition
 * Owns queue-menu rendering, queue item callbacks, and queue-menu runtime adapters while core queue mechanics stay in queue
 */
import type { TelegramInlineKeyboardMarkup } from "./keyboard.ts";
import type { TelegramModelMenuState } from "./menu.ts";
import type { MenuModel } from "./model.ts";
import * as Queue from "./queue.ts";
type TelegramQueueMenuReplyMarkup = TelegramInlineKeyboardMarkup;
interface TelegramQueueMenuCallbackQuery {
    id: string;
    data?: string;
    message?: {
        chat?: {
            id?: number;
        };
        message_id?: number;
    };
}
interface TelegramQueueMenuRuntime<Context> {
    openQueueMenu: (chatId: number, replyToMessageId: number, ctx: Context) => Promise<void>;
    handleCallbackQuery: (query: TelegramQueueMenuCallbackQuery, ctx: Context) => Promise<boolean>;
}
export declare function createTelegramQueueMenuRuntime<Context, TModel extends MenuModel = MenuModel>(deps: {
    telegramQueueStore: Queue.TelegramQueueStateStore<Context>;
    queueMutationRuntime: Queue.TelegramQueueMutationController<Context>;
    sendInteractiveMessage: (chatId: number, text: string, mode: "html", replyMarkup: TelegramQueueMenuReplyMarkup) => Promise<number | undefined>;
    editInteractiveMessage: (chatId: number, messageId: number, text: string, mode: "html", replyMarkup: TelegramQueueMenuReplyMarkup) => Promise<void>;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    getModelMenuState: (chatId: number, ctx: Context) => Promise<TelegramModelMenuState<TModel>>;
    getStoredModelMenuState: (messageId: number | undefined, chatId?: number) => TelegramModelMenuState<TModel> | undefined;
    storeModelMenuState: (state: TelegramModelMenuState<TModel>) => void;
    updateStatusMessage: (state: TelegramModelMenuState<TModel>, ctx: Context) => Promise<void>;
    updateStatus: (ctx: Context) => void;
    dismissGuestPlaceholder?: (inlineMessageId: string) => Promise<void>;
}): TelegramQueueMenuRuntime<Context>;
export {};
