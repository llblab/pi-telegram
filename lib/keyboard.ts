/**
 * Telegram inline-keyboard structural contracts
 * Zones: telegram ui, shared structure
 * Owns the shared Bot API reply-markup shape while feature domains own their button semantics
 */

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}
