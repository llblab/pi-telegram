/**
 * Public Telegram delivery API
 * Zones: package boundary, telegram delivery, extension interop
 * Exposes target-aware operational view delivery while keeping transport and runtime binding internals package-private
 */
export { deleteTelegramView, editTelegramView, sendTelegramChatAction, sendTelegramView, type SendTelegramViewOptions, type TelegramDeliveryChatAction, type TelegramDeliveryFailureReason, type TelegramDeliveryHandle, type TelegramDeliveryParseMode, type TelegramDeliveryResult, type TelegramDeliveryScope, type TelegramDeliveryTarget, type TelegramDeliveryView, } from "../lib/delivery.ts";
