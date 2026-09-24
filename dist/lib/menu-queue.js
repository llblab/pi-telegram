/**
 * Telegram queue menu UI helpers
 * Zones: telegram ui, queue controls, menu composition
 * Owns queue-menu rendering, queue item callbacks, and queue-menu runtime adapters while core queue mechanics stay in queue
 */
// --- Queue Menu ---
const QUEUE_ITEM_PROMPT_HTML_LIMIT = 3600;
const QUEUE_ITEM_PROMPT_TRUNCATION_SUFFIX = "\n… [truncated]";
const EMPTY_QUEUE_REFRESH_TITLES = [
    "<b>⌛ Queue is still empty</b>",
    "<b>🫙 Still nothing in queue</b>",
    "<b>🍃 Queue remains empty</b>",
    "<b>🕳 Nothing queued yet</b>",
    "<b>🦗 Queue crickets continue</b>",
    "<b>🌙 Queue is peacefully idle</b>",
    "<b>🧘 Nothing waiting. Very zen</b>",
    "<b>🪐 Queue orbit is clear</b>",
    "<b>🧺 Basket is empty</b>",
    "<b>🔭 No prompts on the horizon</b>",
    "<b>🫧 Queue bubbles: none</b>",
    "<b>🛸 No queued signals detected</b>",
];
function getTelegramQueueItemPromptText(item) {
    if (item.kind !== "prompt")
        return item.statusSummary;
    return (item.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim() || item.statusSummary);
}
function toTelegramQueueMenuItems(items) {
    return items.map((item, index) => {
        return {
            chatId: item.chatId,
            replyToMessageId: item.replyToMessageId,
            queueOrder: item.queueOrder,
            isGuest: item.kind === "prompt" && item.guestQueryId !== undefined,
            queuePosition: index + 1,
            isPriority: item.queueLane === "priority",
            priorityEmoji: item.kind === "prompt" ? item.priorityEmoji : undefined,
            reactionSuppressionEmoji: item.kind === "prompt" ? item.reactionSuppressionEmoji : undefined,
            hasAttachments: item.kind === "prompt" && item.queuedAttachments.length > 0,
            statusSummary: item.statusSummary,
            promptText: getTelegramQueueItemPromptText(item),
        };
    });
}
function formatSkippedTelegramQueuePosition(position) {
    return Array.from(String(position), (char) => `${char}\u0335`).join("");
}
function buildTelegramQueueMenuReplyMarkup(items, emptyRefreshIndex = 0) {
    const backRow = [{ text: "⬆️ Main menu", callback_data: "menu:back" }];
    const nextEmptyRefreshIndex = (emptyRefreshIndex + 1) % EMPTY_QUEUE_REFRESH_TITLES.length;
    const refreshData = items.length === 0
        ? `queue:refresh:${nextEmptyRefreshIndex}`
        : "queue:refresh";
    const refreshRow = [{ text: "🔄 Refresh", callback_data: refreshData }];
    if (items.length === 0)
        return { inline_keyboard: [backRow, refreshRow] };
    const rows = items.map((item) => {
        const prefix = item.reactionSuppressionEmoji
            ? `${item.reactionSuppressionEmoji} `
            : item.isPriority
                ? `${item.priorityEmoji ?? "⚡"} `
                : item.hasAttachments
                    ? "📎 "
                    : "";
        const position = item.reactionSuppressionEmoji
            ? formatSkippedTelegramQueuePosition(item.queuePosition)
            : String(item.queuePosition);
        const ordinalSeparator = item.reactionSuppressionEmoji ? "\u200A" : "";
        const label = `${position}${ordinalSeparator}. ${prefix}${item.statusSummary}`;
        return [
            {
                text: label,
                callback_data: item.isGuest
                    ? `queue:guest-pick:${item.queueOrder}`
                    : `queue:pick:${item.chatId}:${item.replyToMessageId}`,
            },
        ];
    });
    return { inline_keyboard: [backRow, refreshRow, ...rows] };
}
function findTelegramQueueItem(items, chatId, replyToMessageId) {
    return items.find((item) => {
        return item.chatId === chatId && item.replyToMessageId === replyToMessageId;
    });
}
function findTelegramQueueMenuItem(items, chatId, replyToMessageId) {
    return items.find((item) => {
        return item.chatId === chatId && item.replyToMessageId === replyToMessageId;
    });
}
function escapeTelegramQueueMenuHtmlChar(char) {
    if (char === "&")
        return "&amp;";
    if (char === "<")
        return "&lt;";
    if (char === ">")
        return "&gt;";
    return char;
}
function escapeTelegramQueueMenuHtml(text) {
    return Array.from(text).map(escapeTelegramQueueMenuHtmlChar).join("");
}
function escapeTelegramQueueMenuHtmlPreview(text) {
    const suffix = escapeTelegramQueueMenuHtml(QUEUE_ITEM_PROMPT_TRUNCATION_SUFFIX);
    let escaped = "";
    let truncated = false;
    for (const char of text) {
        const next = escapeTelegramQueueMenuHtmlChar(char);
        if (escaped.length + next.length + suffix.length >
            QUEUE_ITEM_PROMPT_HTML_LIMIT) {
            truncated = true;
            break;
        }
        escaped += next;
    }
    return truncated ? escaped + suffix : escaped;
}
function getTelegramQueueMenuItemText(item) {
    const badge = item.reactionSuppressionEmoji
        ? ` ${item.reactionSuppressionEmoji}`
        : item.isPriority
            ? ` ${item.priorityEmoji ?? "⚡"}`
            : "";
    const position = item.reactionSuppressionEmoji
        ? `<s>${item.queuePosition}</s>.`
        : `<b>${item.queuePosition}.</b>`;
    const heading = `${position}${badge}`;
    const preview = `<pre>${escapeTelegramQueueMenuHtmlPreview(item.promptText)}</pre>`;
    return `${heading}\n${preview}`;
}
function buildTelegramGuestQueueItemSubmenuReplyMarkup(queueOrder) {
    return {
        inline_keyboard: [
            [{ text: "⬆️ Back", callback_data: "queue:list" }],
            [
                {
                    text: "🔴 Skip",
                    callback_data: `queue:guest-skip:${queueOrder}`,
                },
            ],
        ],
    };
}
function buildTelegramQueueItemSubmenuReplyMarkup(chatId, replyToMessageId, isPriority, isSkipped) {
    return {
        inline_keyboard: [
            [{ text: "⬆️ Back", callback_data: "queue:list" }],
            [
                {
                    text: isPriority ? "🟡 Priority" : "⚫️ Priority",
                    callback_data: `queue:prio-set:${chatId}:${replyToMessageId}:priority`,
                },
                {
                    text: isPriority ? "⚫️ Normal" : "🔵 Normal",
                    callback_data: `queue:prio-set:${chatId}:${replyToMessageId}:normal`,
                },
            ],
            [
                {
                    text: isSkipped ? "⚫️ Keep" : "🟢 Keep",
                    callback_data: `queue:skip-set:${chatId}:${replyToMessageId}:keep`,
                },
                {
                    text: isSkipped ? "🔴 Skip" : "⚫️ Skip",
                    callback_data: `queue:skip-set:${chatId}:${replyToMessageId}:skip`,
                },
            ],
        ],
    };
}
async function handleTelegramQueueMenuCallback(callbackQueryId, data, replyChatId, replyMessageId, ctx, deps) {
    if (!data.startsWith("queue:"))
        return false;
    if (data === "queue:noop") {
        await deps.answerCallbackQuery(callbackQueryId);
        return true;
    }
    if (data === "queue:list") {
        await updateTelegramQueueMenuList(callbackQueryId, replyChatId, replyMessageId, deps);
        return true;
    }
    const refreshMatch = data.match(/^queue:refresh(?::(\d+))?$/);
    if (refreshMatch) {
        await updateTelegramQueueMenuList(callbackQueryId, replyChatId, replyMessageId, deps, undefined, refreshMatch[1] === undefined ? 0 : Number(refreshMatch[1]));
        return true;
    }
    const guestPickMatch = data.match(/^queue:guest-pick:(\d+)$/);
    if (guestPickMatch) {
        await handleTelegramGuestQueueMenuPick(callbackQueryId, replyChatId, replyMessageId, Number(guestPickMatch[1]), deps);
        return true;
    }
    const guestSkipMatch = data.match(/^queue:guest-skip:(\d+)$/);
    if (guestSkipMatch) {
        const skipped = await deps.skipGuest(Number(guestSkipMatch[1]), ctx);
        if (!skipped) {
            await refreshStaleTelegramQueueMenuItem(callbackQueryId, replyChatId, replyMessageId, deps);
            return true;
        }
        await updateTelegramQueueMenuList(callbackQueryId, replyChatId, replyMessageId, deps, "Guest prompt skipped.");
        return true;
    }
    const pickMatch = data.match(/^queue:pick:(\d+):(\d+)$/);
    if (pickMatch) {
        await handleTelegramQueueMenuPick(callbackQueryId, replyChatId, replyMessageId, Number(pickMatch[1]), Number(pickMatch[2]), deps);
        return true;
    }
    const prioSetMatch = data.match(/^queue:prio-set:(\d+):(\d+):(priority|normal)$/);
    if (prioSetMatch) {
        await handleTelegramQueueMenuPrioritySet(callbackQueryId, replyChatId, replyMessageId, Number(prioSetMatch[1]), Number(prioSetMatch[2]), prioSetMatch[3] === "priority", ctx, deps);
        return true;
    }
    const prioMatch = data.match(/^queue:prio:(\d+):(\d+)$/);
    if (prioMatch) {
        await handleTelegramQueueMenuPriority(callbackQueryId, replyChatId, replyMessageId, Number(prioMatch[1]), Number(prioMatch[2]), ctx, deps);
        return true;
    }
    const skipSetMatch = data.match(/^queue:skip-set:(\d+):(\d+):(skip|keep)$/);
    if (skipSetMatch) {
        await handleTelegramQueueMenuSkipSet(callbackQueryId, replyChatId, replyMessageId, Number(skipSetMatch[1]), Number(skipSetMatch[2]), skipSetMatch[3] === "skip", ctx, deps);
        return true;
    }
    return false;
}
function getTelegramQueueMenuListText(items, emptyRefreshIndex) {
    if (items.length > 0)
        return "<b>⏳ Queue:</b>";
    if (emptyRefreshIndex === undefined)
        return "<b>⌛ Queue is empty</b>";
    return EMPTY_QUEUE_REFRESH_TITLES[emptyRefreshIndex % EMPTY_QUEUE_REFRESH_TITLES.length];
}
async function updateTelegramQueueMenuList(callbackQueryId, replyChatId, replyMessageId, deps, notice, emptyRefreshIndex) {
    const items = deps.getQueuedItems();
    await deps.updateQueueMessage(replyChatId, replyMessageId, getTelegramQueueMenuListText(items, emptyRefreshIndex), buildTelegramQueueMenuReplyMarkup(items, emptyRefreshIndex));
    await deps.answerCallbackQuery(callbackQueryId, notice);
}
async function refreshStaleTelegramQueueMenuItem(callbackQueryId, replyChatId, replyMessageId, deps) {
    await updateTelegramQueueMenuList(callbackQueryId, replyChatId, replyMessageId, deps, "Item no longer in queue.");
}
async function handleTelegramGuestQueueMenuPick(callbackQueryId, replyChatId, replyMessageId, queueOrder, deps) {
    const item = deps.findGuestItem(queueOrder);
    if (!item) {
        return refreshStaleTelegramQueueMenuItem(callbackQueryId, replyChatId, replyMessageId, deps);
    }
    await deps.updateQueueMessage(replyChatId, replyMessageId, getTelegramQueueMenuItemText(item), buildTelegramGuestQueueItemSubmenuReplyMarkup(queueOrder));
    await deps.answerCallbackQuery(callbackQueryId);
}
async function handleTelegramQueueMenuPick(callbackQueryId, replyChatId, replyMessageId, chatId, msgId, deps) {
    const item = deps.findItem(chatId, msgId);
    if (!item) {
        return refreshStaleTelegramQueueMenuItem(callbackQueryId, replyChatId, replyMessageId, deps);
    }
    await deps.updateQueueMessage(replyChatId, replyMessageId, getTelegramQueueMenuItemText(item), buildTelegramQueueItemSubmenuReplyMarkup(chatId, msgId, item.isPriority, item.reactionSuppressionEmoji !== undefined));
    await deps.answerCallbackQuery(callbackQueryId);
}
async function handleTelegramQueueMenuPriority(callbackQueryId, replyChatId, replyMessageId, chatId, msgId, ctx, deps) {
    const item = deps.findItem(chatId, msgId);
    if (!item) {
        return refreshStaleTelegramQueueMenuItem(callbackQueryId, replyChatId, replyMessageId, deps);
    }
    await updateTelegramQueueMenuPriority(callbackQueryId, replyChatId, replyMessageId, chatId, msgId, !item.isPriority, ctx, deps);
}
async function handleTelegramQueueMenuPrioritySet(callbackQueryId, replyChatId, replyMessageId, chatId, msgId, enabled, ctx, deps) {
    const item = deps.findItem(chatId, msgId);
    if (!item) {
        return refreshStaleTelegramQueueMenuItem(callbackQueryId, replyChatId, replyMessageId, deps);
    }
    await updateTelegramQueueMenuPriority(callbackQueryId, replyChatId, replyMessageId, chatId, msgId, enabled, ctx, deps);
}
async function updateTelegramQueueMenuPriority(callbackQueryId, replyChatId, replyMessageId, chatId, msgId, enabled, ctx, deps) {
    deps.setPriority(chatId, msgId, enabled);
    deps.updateStatus(ctx);
    const updated = deps.findItem(chatId, msgId);
    if (!updated) {
        return refreshStaleTelegramQueueMenuItem(callbackQueryId, replyChatId, replyMessageId, deps);
    }
    await deps.updateQueueMessage(replyChatId, replyMessageId, getTelegramQueueMenuItemText(updated), buildTelegramQueueItemSubmenuReplyMarkup(chatId, msgId, updated.isPriority, updated.reactionSuppressionEmoji !== undefined));
    await deps.answerCallbackQuery(callbackQueryId, updated.isPriority ? "Prioritized." : "Normal priority.");
}
async function handleTelegramQueueMenuSkipSet(callbackQueryId, replyChatId, replyMessageId, chatId, msgId, skipped, ctx, deps) {
    const item = deps.findItem(chatId, msgId);
    if (!item) {
        return refreshStaleTelegramQueueMenuItem(callbackQueryId, replyChatId, replyMessageId, deps);
    }
    deps.setSkipped(chatId, msgId, skipped);
    deps.updateStatus(ctx);
    const updated = deps.findItem(chatId, msgId);
    if (!updated) {
        return refreshStaleTelegramQueueMenuItem(callbackQueryId, replyChatId, replyMessageId, deps);
    }
    await deps.updateQueueMessage(replyChatId, replyMessageId, getTelegramQueueMenuItemText(updated), buildTelegramQueueItemSubmenuReplyMarkup(chatId, msgId, updated.isPriority, updated.reactionSuppressionEmoji !== undefined));
    await deps.answerCallbackQuery(callbackQueryId);
}
export function createTelegramQueueMenuRuntime(deps) {
    const sendQueueMenuMessage = createQueueMenuSendMessageAdapter(deps.sendInteractiveMessage);
    const editQueueMenuMessage = createQueueMenuEditMessageAdapter(deps.editInteractiveMessage);
    return {
        openQueueMenu: createOpenQueueMenu({
            getQueuedItems: deps.telegramQueueStore.getQueuedItems,
            getModelMenuState: deps.getModelMenuState,
            storeModelMenuState: deps.storeModelMenuState,
            sendInteractiveMessage: sendQueueMenuMessage,
        }),
        handleCallbackQuery: createQueueMenuCallbackHandler({
            telegramQueueStore: deps.telegramQueueStore,
            queueMutationRuntime: deps.queueMutationRuntime,
            editInteractiveMessage: editQueueMenuMessage,
            getStoredModelMenuState: deps.getStoredModelMenuState,
            updateStatusMessage: deps.updateStatusMessage,
            answerCallbackQuery: deps.answerCallbackQuery,
            updateStatus: deps.updateStatus,
            dismissGuestPlaceholder: deps.dismissGuestPlaceholder,
        }),
    };
}
function createOpenQueueMenu(deps) {
    return async (chatId, replyToMessageId, ctx) => {
        const state = await deps.getModelMenuState(chatId, ctx);
        const menuItems = toTelegramQueueMenuItems(deps.getQueuedItems());
        const text = getTelegramQueueMenuListText(menuItems);
        const messageId = await deps.sendInteractiveMessage(chatId, replyToMessageId, text, buildTelegramQueueMenuReplyMarkup(menuItems));
        if (messageId === undefined)
            return;
        state.messageId = messageId;
        state.mode = "queue";
        deps.storeModelMenuState(state);
    };
}
function createQueueMenuCallbackHandler(deps) {
    return async (query, ctx) => {
        const data = query.data;
        const chatId = query.message?.chat?.id;
        const messageId = query.message?.message_id;
        if (!data || typeof chatId !== "number" || typeof messageId !== "number")
            return false;
        if (data === "menu:queue" || data === "status:queue") {
            const state = deps.getStoredModelMenuState(messageId, chatId);
            if (!state) {
                await deps.answerCallbackQuery(query.id, "Interactive message expired.");
                return true;
            }
            const menuItems = toTelegramQueueMenuItems(deps.telegramQueueStore.getQueuedItems());
            await deps.editInteractiveMessage(chatId, messageId, getTelegramQueueMenuListText(menuItems), buildTelegramQueueMenuReplyMarkup(menuItems));
            state.mode = "queue";
            await deps.answerCallbackQuery(query.id);
            return true;
        }
        if (!data.startsWith("queue:"))
            return false;
        const getQueueSnapshot = () => {
            return deps.telegramQueueStore.getQueuedItems();
        };
        const toMenuItems = () => {
            return toTelegramQueueMenuItems(getQueueSnapshot());
        };
        const findItem = (cId, rId) => {
            return findTelegramQueueMenuItem(toMenuItems(), cId, rId);
        };
        const findGuestItem = (queueOrder) => {
            return toMenuItems().find((item) => {
                return item.isGuest && item.queueOrder === queueOrder;
            });
        };
        return handleTelegramQueueMenuCallback(query.id, data, chatId, messageId, ctx, {
            getQueuedItems: toMenuItems,
            findItem,
            findGuestItem,
            skipGuest: (queueOrder, callbackContext) => {
                return skipQueuedTelegramGuestPrompt(queueOrder, callbackContext, {
                    getQueueSnapshot,
                    queueMutationRuntime: deps.queueMutationRuntime,
                    dismissGuestPlaceholder: deps.dismissGuestPlaceholder,
                });
            },
            togglePriority: (cId, rId) => {
                return toggleQueuedTelegramPromptPriority(cId, rId, ctx, {
                    getQueueSnapshot,
                    queueMutationRuntime: deps.queueMutationRuntime,
                });
            },
            setPriority: (cId, rId, enabled) => {
                return setQueuedTelegramPromptPriority(cId, rId, enabled, ctx, {
                    getQueueSnapshot,
                    queueMutationRuntime: deps.queueMutationRuntime,
                });
            },
            setSkipped: (cId, rId, skipped) => {
                return setQueuedTelegramPromptSkipped(cId, rId, skipped, ctx, {
                    getQueueSnapshot,
                    queueMutationRuntime: deps.queueMutationRuntime,
                });
            },
            updateQueueMessage: deps.editInteractiveMessage,
            answerCallbackQuery: deps.answerCallbackQuery,
            updateStatus: deps.updateStatus,
        });
    };
}
async function skipQueuedTelegramGuestPrompt(queueOrder, ctx, deps) {
    const item = deps.getQueueSnapshot().find((candidate) => {
        return candidate.kind === "prompt" &&
            candidate.guestQueryId !== undefined &&
            candidate.queueOrder === queueOrder;
    });
    if (!item || !deps.queueMutationRuntime.removeGuestPromptByQueueOrder) {
        return false;
    }
    const removed = deps.queueMutationRuntime.removeGuestPromptByQueueOrder(queueOrder, ctx);
    if (!removed)
        return false;
    if (item.guestInlineMessageId && deps.dismissGuestPlaceholder) {
        await deps.dismissGuestPlaceholder(item.guestInlineMessageId);
    }
    return true;
}
function getQueueMenuReactionDisposition(item, priority, skipped) {
    if (priority && skipped) {
        return {
            kind: "priority-suppressed",
            priorityEmoji: item.kind === "prompt" ? item.priorityEmoji ?? "⚡" : "⚡",
            suppressionEmoji: item.kind === "prompt"
                ? item.reactionSuppressionEmoji ?? "👎"
                : "👎",
        };
    }
    if (priority) {
        return {
            kind: "priority",
            emoji: item.kind === "prompt" ? item.priorityEmoji ?? "⚡" : "⚡",
        };
    }
    if (skipped) {
        return {
            kind: "suppressed",
            emoji: item.kind === "prompt"
                ? item.reactionSuppressionEmoji ?? "👎"
                : "👎",
        };
    }
    return { kind: "default" };
}
function toggleQueuedTelegramPromptPriority(chatId, replyToMessageId, ctx, deps) {
    const item = findTelegramQueueItem(deps.getQueueSnapshot(), chatId, replyToMessageId);
    if (!item)
        return false;
    deps.queueMutationRuntime.applyReactionByMessageId(replyToMessageId, getQueueMenuReactionDisposition(item, item.queueLane !== "priority", item.kind === "prompt" &&
        item.reactionSuppressionEmoji !== undefined), ctx);
    return true;
}
function setQueuedTelegramPromptPriority(chatId, replyToMessageId, enabled, ctx, deps) {
    const item = findTelegramQueueItem(deps.getQueueSnapshot(), chatId, replyToMessageId);
    if (!item)
        return false;
    deps.queueMutationRuntime.applyReactionByMessageId(replyToMessageId, getQueueMenuReactionDisposition(item, enabled, item.kind === "prompt" &&
        item.reactionSuppressionEmoji !== undefined), ctx);
    return true;
}
function setQueuedTelegramPromptSkipped(chatId, replyToMessageId, skipped, ctx, deps) {
    const item = findTelegramQueueItem(deps.getQueueSnapshot(), chatId, replyToMessageId);
    if (!item || item.kind !== "prompt")
        return false;
    deps.queueMutationRuntime.applyReactionByMessageId(replyToMessageId, getQueueMenuReactionDisposition(item, item.queueLane === "priority", skipped), ctx);
    return true;
}
function createQueueMenuSendMessageAdapter(sendInteractiveMessage) {
    return (chatId, _replyToMessageId, text, replyMarkup) => {
        return sendInteractiveMessage(chatId, text, "html", replyMarkup);
    };
}
function createQueueMenuEditMessageAdapter(editInteractiveMessage) {
    return (chatId, messageId, text, replyMarkup) => {
        return editInteractiveMessage(chatId, messageId, text, "html", replyMarkup).then(() => {
            return undefined;
        });
    };
}
