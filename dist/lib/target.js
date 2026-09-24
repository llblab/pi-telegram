/**
 * Telegram transport destination value helpers
 * Zones: Bot API transport, routing, replies/previews, ownership, multi-instance bus
 * Owns the minimal `{ chatId, threadId? }` address shape shared by classic private chats
 * and Telegram UI threads mapped through Bot API `message_thread_id`.
 */
const PRIVATE_TARGET_THREAD_KEY = "private";
export function createTelegramPrivateTarget(chatId) {
    return { chatId };
}
export function createTelegramThreadTarget(chatId, threadId) {
    return { chatId, threadId };
}
export function getTelegramTargetKey(target) {
    return `${target.chatId}:${target.threadId ?? PRIVATE_TARGET_THREAD_KEY}`;
}
export function isTelegramThreadTarget(target) {
    return Number.isInteger(target.threadId);
}
export function areTelegramTargetsEqual(left, right) {
    return left.chatId === right.chatId && left.threadId === right.threadId;
}
export function getTelegramTargetThreadParams(target) {
    return isTelegramThreadTarget(target)
        ? { message_thread_id: target.threadId }
        : {};
}
