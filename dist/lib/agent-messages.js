/**
 * Cross-instance Telegram agent message resolution and turn injection
 * Zones: multi-instance bus, inbound routing, operational delivery
 * Owns live target resolution, source attribution, same-target fencing, and synthetic turn construction; excludes Bot API delivery and bus transport.
 */
import { TELEGRAM_INTERNAL_AGENT_MESSAGE } from "./updates.js";
export function createTelegramAgentMessageRuntime(deps) {
    const getNowMs = deps.getNowMs ?? Date.now;
    const sameTarget = (left, right) => left?.chatId === right?.chatId && left?.threadId === right?.threadId;
    const listLiveTargets = () => {
        const targets = [];
        const leaderTarget = deps.getLeaderTarget();
        if (leaderTarget?.threadId) {
            targets.push({
                target: { chatId: leaderTarget.chatId, threadId: leaderTarget.threadId },
                threadName: deps.getDisplayTitle?.(leaderTarget) ?? deps.getLeaderThreadName(),
            });
        }
        for (const follower of deps.followerRegistry.list()) {
            if (!follower.target?.threadId)
                continue;
            targets.push({
                target: {
                    chatId: follower.target.chatId,
                    threadId: follower.target.threadId,
                },
                threadName: deps.getDisplayTitle?.(follower.target) ?? follower.threadName,
            });
        }
        return targets;
    };
    const resolveTarget = (selector, sourceTarget) => {
        const allowedChatId = deps.getAllowedChatId();
        const chatId = selector.chatId ?? allowedChatId;
        if (chatId === undefined || chatId !== allowedChatId)
            return undefined;
        const matches = listLiveTargets().filter((candidate) => {
            if (candidate.target.chatId !== chatId)
                return false;
            if (selector.threadId !== undefined) {
                return candidate.target.threadId === selector.threadId;
            }
            const requestedName = selector.threadName?.trim().toLocaleLowerCase();
            return (requestedName !== undefined &&
                requestedName.length > 0 &&
                candidate.threadName?.trim().toLocaleLowerCase() === requestedName);
        });
        if (matches.length !== 1)
            return undefined;
        return sameTarget(matches[0].target, sourceTarget)
            ? undefined
            : matches[0].target;
    };
    return {
        resolveTarget,
        async route(input) {
            const target = resolveTarget({
                chatId: input.message.target.chatId,
                threadId: input.message.target.threadId,
            }, input.sourceTarget);
            if (!target)
                throw new Error("Telegram agent target is no longer live.");
            const allowedChatId = deps.getAllowedChatId();
            const ctx = deps.getContext();
            if (allowedChatId === undefined || !ctx) {
                throw new Error("Telegram agent turn routing is unavailable.");
            }
            const sourceTitle = (input.sourceTarget ? deps.getDisplayTitle?.(input.sourceTarget) : undefined)
                ?? input.sourceThreadName;
            const sourceLabel = sourceTitle
                ?.replace(/[\r\n\[\]]+/g, " ")
                .trim()
                .slice(0, 64) || "Pi";
            const message = {
                message_id: input.message.messageId,
                date: Math.floor(getNowMs() / 1000),
                chat: { id: target.chatId, type: "private" },
                from: { id: allowedChatId, is_bot: false, first_name: "Pi Agent" },
                message_thread_id: target.threadId,
                pi_telegram_agent_source_thread: sourceLabel,
                text: input.message.text,
            };
            await deps.handleUpdate({ message, [TELEGRAM_INTERNAL_AGENT_MESSAGE]: true }, ctx);
        },
    };
}
