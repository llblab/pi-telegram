/**
 * Telegram text-group coalescing helpers
 * Zones: telegram inbound, queue admission, split-message recovery
 * Owns conservative delayed grouping for Telegram text messages that look like automatic long-message splits
 */
import { setTimeout as waitForTimeout } from "node:timers/promises";
import { extractTelegramMessageText, } from "./media.js";
const TELEGRAM_TEXT_GROUP_DEBOUNCE_MS = 1000;
const TELEGRAM_TEXT_GROUP_MIN_SPLIT_LENGTH = 3600;
const TELEGRAM_TEXT_GROUP_MAX_MESSAGE_ID_GAP = 12;
function extractTelegramTextGroupText(message) {
    return extractTelegramMessageText(message);
}
function isTelegramForwardedMessage(message) {
    return (message.forward_origin !== undefined ||
        message.forward_from !== undefined ||
        typeof message.forward_sender_name === "string");
}
function isTelegramTextGroupCommand(text) {
    return text.trimStart().startsWith("/");
}
function isTelegramTextGroupClearingCommand(text) {
    const command = text.trimStart().split(/\s+/, 1)[0]?.split("@", 1)[0];
    return command === "/stop";
}
function getTelegramTextGroupMessageIdentity(message) {
    const threadKey = typeof message.message_thread_id === "number"
        ? `thread:${message.message_thread_id}`
        : "private";
    return `${message.chat.id}:${threadKey}:${message.message_id}`;
}
function getTelegramTextGroupKey(message) {
    if (message.media_group_id)
        return undefined;
    if (!message.from || message.from.is_bot)
        return undefined;
    if (!extractTelegramTextGroupText(message) &&
        !isTelegramForwardedMessage(message)) {
        return undefined;
    }
    const threadKey = typeof message.message_thread_id === "number"
        ? `thread:${message.message_thread_id}`
        : "private";
    return `${message.chat.id}:${threadKey}:${message.from.id}`;
}
function canStartTelegramTextGroup(message, minSplitLength) {
    const text = extractTelegramTextGroupText(message);
    return text.length >= minSplitLength && !isTelegramTextGroupCommand(text);
}
function canAppendTelegramTextGroupMessage(state, message) {
    const text = extractTelegramTextGroupText(message);
    const previous = state.messages.at(-1);
    return (!!previous &&
        message.message_id > previous.message_id &&
        message.message_id <=
            previous.message_id + TELEGRAM_TEXT_GROUP_MAX_MESSAGE_ID_GAP &&
        (text.length > 0 || isTelegramForwardedMessage(message)) &&
        !isTelegramTextGroupCommand(text));
}
export function queueTelegramTextGroupMessage(options) {
    const key = getTelegramTextGroupKey(options.message);
    if (!key)
        return false;
    const existing = options.groups.get(key);
    const duplicateIndex = existing?.messages.findIndex((message) => message.message_id === options.message.message_id);
    if (existing && duplicateIndex !== undefined && duplicateIndex >= 0) {
        existing.messages[duplicateIndex] = options.message;
        existing.context = options.context;
        existing.forwardPairCandidate = options.forwardPairCandidate;
        if (!existing.suspended && !existing.dispatching && !existing.flushTimer) {
            existing.reschedule?.();
        }
        return true;
    }
    if (!existing &&
        !options.forceStart &&
        !canStartTelegramTextGroup(options.message, options.minSplitLength))
        return false;
    if (existing && !canAppendTelegramTextGroupMessage(existing, options.message))
        return false;
    const state = existing ?? { messages: [] };
    state.messages.push(options.message);
    state.context = options.context;
    state.forwardPairCandidate = options.forwardPairCandidate;
    const dispatchQueued = () => {
        state.flushTimer = undefined;
        const queued = options.groups.get(key);
        if (!queued || queued.context === undefined)
            return Promise.resolve();
        if (queued.dispatching)
            return queued.dispatchPromise ?? Promise.resolve();
        const dispatchCount = queued.dispatchLimit ?? queued.messages.length;
        queued.dispatchLimit = undefined;
        const dispatchedMessages = queued.messages.slice(0, dispatchCount);
        const dispatchedIds = new Set(dispatchedMessages.map((message) => message.message_id));
        queued.dispatching = true;
        const operation = Promise.resolve(options.dispatchMessages(dispatchedMessages, queued.context)).then(() => {
            if (options.groups.get(key) !== queued)
                return;
            queued.messages = queued.messages.filter((message) => !dispatchedIds.has(message.message_id));
            queued.dispatching = false;
            queued.dispatchPromise = undefined;
            if (queued.messages.length === 0)
                options.groups.delete(key);
            else if (!queued.flushTimer)
                scheduleDispatch();
        }, (error) => {
            if (options.groups.get(key) === queued) {
                queued.dispatching = false;
                queued.dispatchPromise = undefined;
                if (!queued.flushTimer)
                    scheduleDispatch();
            }
            throw error;
        });
        queued.dispatchPromise = operation;
        return operation;
    };
    const scheduleDispatch = (delayMs = options.debounceMs) => {
        if (state.suspended)
            return;
        state.flushTimer = options.setTimer(() => {
            void dispatchQueued().catch(() => undefined);
        }, delayMs);
        state.flushTimer.unref?.();
    };
    state.reschedule = scheduleDispatch;
    state.dispatchNow = dispatchQueued;
    if (state.flushTimer)
        options.clearTimer(state.flushTimer);
    scheduleDispatch(options.dispatchImmediately ? 0 : (options.delayMs ?? options.debounceMs));
    options.groups.set(key, state);
    return true;
}
export function createTelegramTextGroupController(options = {}) {
    const groups = new Map();
    const plannedForwardCommentStarts = new Set();
    const plannedForwardCommentEnds = new Set();
    const debounceMs = options.debounceMs ?? TELEGRAM_TEXT_GROUP_DEBOUNCE_MS;
    const minSplitLength = options.minSplitLength ?? TELEGRAM_TEXT_GROUP_MIN_SPLIT_LENGTH;
    const forwardCommentWaitMs = options.forwardCommentWaitMs === undefined
        ? debounceMs
        : options.forwardCommentWaitMs;
    const setTimer = options.setTimer ??
        ((callback, ms) => {
            const controller = new AbortController();
            void waitForTimeout(ms, undefined, {
                signal: controller.signal,
            }).then(callback, () => undefined);
            return controller;
        });
    const clearTimer = options.clearTimer ??
        (options.setTimer
            ? clearTimeout
            : (timer) => {
                timer.abort();
            });
    return {
        prepareUpdateBatch(updates) {
            for (let index = 0; index + 1 < updates.length; index += 1) {
                const comment = updates[index]?.message;
                const forwarded = updates[index + 1]?.message;
                if (!comment || !forwarded)
                    continue;
                const commentText = extractTelegramTextGroupText(comment);
                const commentKey = getTelegramTextGroupKey(comment);
                const forwardedKey = getTelegramTextGroupKey(forwarded);
                if (!commentKey ||
                    commentKey !== forwardedKey ||
                    !commentText ||
                    isTelegramTextGroupCommand(commentText) ||
                    isTelegramForwardedMessage(comment) ||
                    !isTelegramForwardedMessage(forwarded) ||
                    forwarded.message_id <= comment.message_id ||
                    forwarded.message_id >
                        comment.message_id + TELEGRAM_TEXT_GROUP_MAX_MESSAGE_ID_GAP) {
                    continue;
                }
                plannedForwardCommentStarts.add(getTelegramTextGroupMessageIdentity(comment));
                plannedForwardCommentEnds.add(getTelegramTextGroupMessageIdentity(forwarded));
            }
        },
        getPreparedForwardingPosition(message) {
            const identity = getTelegramTextGroupMessageIdentity(message);
            if (plannedForwardCommentStarts.has(identity))
                return "comment";
            if (plannedForwardCommentEnds.has(identity))
                return "forward";
            return undefined;
        },
        prepareForwardedMessage(message, position) {
            const identity = getTelegramTextGroupMessageIdentity(message);
            if (position === "comment")
                plannedForwardCommentStarts.add(identity);
            else
                plannedForwardCommentEnds.add(identity);
        },
        queueMessage: ({ message, context, dispatchMessages }) => {
            const identity = getTelegramTextGroupMessageIdentity(message);
            const key = getTelegramTextGroupKey(message);
            const plannedStart = plannedForwardCommentStarts.delete(identity);
            const forwarded = isTelegramForwardedMessage(message);
            const existing = key ? groups.get(key) : undefined;
            const text = extractTelegramTextGroupText(message);
            if (existing && isTelegramTextGroupClearingCommand(text)) {
                if (existing.flushTimer)
                    clearTimer(existing.flushTimer);
                groups.delete(key);
            }
            const candidatePosition = forwarded
                ? "forward"
                : "comment";
            const existingCandidate = existing?.forwardPairCandidate;
            const pairCompleted = existingCandidate !== undefined &&
                existingCandidate !== candidatePosition;
            const separateFromCandidate = existingCandidate === candidatePosition &&
                !isTelegramTextGroupCommand(text);
            if (separateFromCandidate && existing) {
                existing.dispatchLimit = existing.messages.length;
            }
            const forceStart = plannedStart ||
                (forwardCommentWaitMs !== false &&
                    !!key &&
                    (forwarded ||
                        (typeof message.text === "string" &&
                            !isTelegramTextGroupCommand(extractTelegramTextGroupText(message)))));
            const dispatchImmediately = pairCompleted ||
                separateFromCandidate ||
                plannedForwardCommentEnds.delete(identity) ||
                (forwarded && !!key && groups.has(key));
            return queueTelegramTextGroupMessage({
                message,
                context,
                groups,
                debounceMs,
                minSplitLength,
                setTimer,
                clearTimer,
                dispatchMessages,
                forceStart,
                dispatchImmediately,
                forwardPairCandidate: forceStart && !canStartTelegramTextGroup(message, minSplitLength)
                    ? candidatePosition
                    : undefined,
                delayMs: forceStart && !canStartTelegramTextGroup(message, minSplitLength)
                    ? forwardCommentWaitMs === false
                        ? undefined
                        : forwardCommentWaitMs
                    : undefined,
            });
        },
        async flushMessage(messageId) {
            for (const state of groups.values()) {
                if (!state.messages.some((message) => message.message_id === messageId)) {
                    continue;
                }
                if (state.flushTimer)
                    clearTimer(state.flushTimer);
                state.flushTimer = undefined;
                await state.dispatchNow?.();
                if (state.messages.some((message) => message.message_id === messageId) &&
                    !state.dispatching) {
                    await state.dispatchNow?.();
                }
                return true;
            }
            return false;
        },
        suspend: () => {
            for (const state of groups.values()) {
                state.suspended = true;
                if (state.flushTimer)
                    clearTimer(state.flushTimer);
                state.flushTimer = undefined;
            }
        },
        resume: (context) => {
            for (const state of groups.values()) {
                state.context = context;
                state.suspended = false;
                if (!state.dispatching && !state.flushTimer)
                    state.reschedule?.();
            }
        },
        clear: () => {
            for (const state of groups.values()) {
                if (state.flushTimer)
                    clearTimer(state.flushTimer);
            }
            groups.clear();
            plannedForwardCommentStarts.clear();
            plannedForwardCommentEnds.clear();
        },
    };
}
export function createTelegramTextGroupDispatchRuntime(deps) {
    return {
        handleMessage: async (message, ctx) => {
            const queuedTextGroup = deps.textGroups.queueMessage({
                message,
                context: ctx,
                dispatchMessages: (messages, queuedCtx) => deps.dispatchMessages(messages, queuedCtx),
            });
            if (queuedTextGroup) {
                deps.onDeferredMessage?.(message);
                return;
            }
            await deps.dispatchSingleMessage(message, ctx);
        },
    };
}
export function createTelegramGroupedInputClearer(deps) {
    return () => {
        deps.clearMediaGroups();
        deps.clearTextGroups();
    };
}
