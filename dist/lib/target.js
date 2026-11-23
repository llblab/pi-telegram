/**
 * Telegram transport destination value helpers
 * Zones: Bot API transport, routing, replies/previews, ownership, multi-instance bus
 * Owns the minimal `{ chatId, threadId? }` address shape and exact group/topic address checks,
 * plus the shared assigned-target and Threaded Mode projections over the bus roles.
 */
import { isWireRecord } from "./wire.js";
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
/** Pure wire parser for `{ chatId, threadId? }`; unknown fields are dropped and malformed shapes refuse. */
export function parseTelegramTarget(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    const { chatId, threadId } = value;
    if (typeof chatId !== "number")
        return undefined;
    return typeof threadId === "number" ? { chatId, threadId } : { chatId };
}
/** Parse an exact group address; a malformed topic must never become a chat-only target. */
export function parseTelegramGroupTarget(value) {
    if (!isWireRecord(value))
        return undefined;
    const { chatId, threadId } = value;
    if (typeof chatId !== "number" || !Number.isSafeInteger(chatId) || chatId >= 0 ||
        threadId !== undefined && (typeof threadId !== "number" || !Number.isSafeInteger(threadId) || threadId <= 0))
        return undefined;
    return threadId === undefined ? { chatId } : { chatId, threadId };
}
/** Check exact Bot API chat identity and forum shape, not topic existence or write permission. */
export function matchesTelegramGroupChat(chat, target) {
    if (!isWireRecord(chat) || chat.id !== target.chatId)
        return false;
    if (chat.type === "supergroup" && chat.is_forum === true)
        return target.threadId !== undefined;
    return (chat.type === "group" || chat.type === "supergroup") &&
        (chat.is_forum === undefined || chat.is_forum === false) && target.threadId === undefined;
}
/** Pure Bot API integer id parser accepting integer numbers or non-blank integer strings. */
export function parseTelegramIntegerId(value) {
    if (typeof value === "number" && Number.isInteger(value))
        return value;
    if (typeof value !== "string" || value.trim() === "")
        return undefined;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : undefined;
}
/** The registered follower's target wins over the leader's own Thread. */
export function createTelegramAssignedTargetGetter(sources) {
    return function getAssignedTarget() {
        return sources.follower.getTarget() ?? sources.leader.getTarget();
    };
}
/** Threaded Mode holds when persisted state enables it or either bus role owns a Thread target. */
export function createTelegramThreadedModeReader(sources) {
    return function isThreadedMode() {
        return (sources.botState.getBotState().threadMode === "enabled" ||
            sources.follower.getTarget()?.threadId !== undefined ||
            sources.leader.getTarget()?.threadId !== undefined);
    };
}
