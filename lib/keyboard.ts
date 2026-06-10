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

export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

export function getTelegramCallbackDataByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function assertTelegramCallbackData(
  callbackData: string,
  context = "Telegram callback_data",
): string {
  const byteLength = getTelegramCallbackDataByteLength(callbackData);
  if (byteLength > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    throw new Error(
      `${context} exceeds ${TELEGRAM_CALLBACK_DATA_MAX_BYTES} bytes (${byteLength}). Use a shorter action/payload or store state behind a compact key.`,
    );
  }
  return callbackData;
}

export function assertTelegramInlineKeyboardCallbackData(
  replyMarkup: unknown,
  context = "Telegram inline keyboard callback_data",
): void {
  if (!replyMarkup || typeof replyMarkup !== "object") return;
  const keyboard = (replyMarkup as { inline_keyboard?: unknown })
    .inline_keyboard;
  if (!Array.isArray(keyboard)) return;
  for (const row of keyboard) {
    if (!Array.isArray(row)) continue;
    for (const button of row) {
      if (!button || typeof button !== "object") continue;
      const callbackData = (button as { callback_data?: unknown })
        .callback_data;
      if (typeof callbackData !== "string") continue;
      assertTelegramCallbackData(callbackData, context);
    }
  }
}
