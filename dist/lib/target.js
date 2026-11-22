/**
 * Telegram transport destination value helpers
 * Zones: Bot API transport, routing, replies/previews, ownership, multi-instance bus
 * Owns the minimal `{ chatId, threadId? }` address shape shared by classic private chats
 * and Telegram UI threads mapped through Bot API `message_thread_id`, plus the shared assigned-target and
 * Threaded Mode projections over the bus roles.
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
/** Pure wire parser for `{ chatId, threadId? }`; unknown fields are dropped and malformed shapes refuse. */
export function parseTelegramTarget(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    const { chatId, threadId } = value;
    if (typeof chatId !== "number")
        return undefined;
    return typeof threadId === "number" ? { chatId, threadId } : { chatId };
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
