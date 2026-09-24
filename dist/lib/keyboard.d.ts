/**
 * Telegram inline-keyboard structural contracts
 * Zones: telegram ui, shared structure
 * Owns the shared Bot API reply-markup shape while feature domains own their button semantics
 */
export type TelegramInlineKeyboardButtonStyle = "danger" | "success" | "primary";
export type TelegramInlineKeyboardButton = {
    text: string;
    style?: TelegramInlineKeyboardButtonStyle;
} & ({
    callback_data: string;
    disabled?: never;
} | {
    disabled: Record<string, never>;
    callback_data?: never;
});
export interface TelegramInlineKeyboardMarkup {
    inline_keyboard: TelegramInlineKeyboardButton[][];
}
export declare const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;
export declare function getTelegramCallbackDataByteLength(value: string): number;
export declare function assertTelegramCallbackData(callbackData: string, context?: string): string;
export declare function assertTelegramInlineKeyboardCallbackData(replyMarkup: unknown, context?: string): void;
