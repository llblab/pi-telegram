/**
 * Telegram queue core contracts and pure planning helpers
 * Zones: telegram queue, pi agent lifecycle, scheduling
 * Owns queue item contracts, lane admission, pure queue mutations, and dispatch planning
 */
import { createHash } from "node:crypto";
import { isVoiceTurn } from "./voice.js";
import { isTelegramApiCommitUnknownError } from "./telegram-api.js";
export const TELEGRAM_QUEUE_LANE_CONTRACTS = [
    // Control lane intentionally accepts both direct controls and resume prompts.
    // Model-switch continuations need prompt semantics but must run before queued user work.
    // Do not admit ordinary user prompts here without an explicit control-flow reason.
    {
        lane: "control",
        admissionMode: "control-queue",
        dispatchRank: 0,
        allowedKinds: ["control", "prompt"],
    },
    {
        lane: "priority",
        admissionMode: "priority-queue",
        dispatchRank: 1,
        allowedKinds: ["prompt"],
    },
    {
        lane: "default",
        admissionMode: "default-queue",
        dispatchRank: 2,
        allowedKinds: ["prompt"],
    },
];
export const TELEGRAM_QUEUE_HANDOFF_PAYLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const TELEGRAM_QUEUE_HANDOFF_MAX_RECEIPTS = 256;
export function createTelegramQueueAdmissionReceipt(options) {
    if (options.sourceUpdateIds.length === 0)
        return undefined;
    const scope = options.scope.trim();
    if (!scope) {
        throw new Error("Telegram queue admission receipt scope is required.");
    }
    if (options.queueKind !== "prompt" && options.queueKind !== "control") {
        throw new Error("Telegram queue admission receipt kind is invalid.");
    }
    const sourceUpdateIds = [...new Set(options.sourceUpdateIds)].sort((left, right) => left - right);
    if (sourceUpdateIds.some((updateId) => !Number.isSafeInteger(updateId) || updateId < 0)) {
        throw new Error("Telegram queue admission update ids must be safe integers.");
    }
    const digest = createHash("sha256")
        .update(JSON.stringify({
        scope,
        queueKind: options.queueKind,
        sourceUpdateIds,
    }))
        .digest("hex");
    return {
        queueKind: options.queueKind,
        receiptId: `telegram-${options.queueKind}-v1-${digest}`,
        sourceUpdateIds,
        journalBindingKey: scope,
    };
}
export function isTelegramQueueItemDurablyAdmitted(item, isReceiptCommitted) {
    assertTelegramQueueItemAdmissionValid(item);
    return (item.admissionReceipts ?? []).every(isReceiptCommitted);
}
export function getTelegramQueueLaneContract(lane) {
    const contract = TELEGRAM_QUEUE_LANE_CONTRACTS.find((entry) => entry.lane === lane);
    if (!contract)
        throw new Error(`Unknown Telegram queue lane: ${lane}`);
    return contract;
}
export function getTelegramQueueItemAdmissionMode(item) {
    return getTelegramQueueLaneContract(item.queueLane).admissionMode;
}
export function isTelegramQueueItemAdmissionValid(item) {
    return getTelegramQueueLaneContract(item.queueLane).allowedKinds.includes(item.kind);
}
export function assertTelegramQueueItemAdmissionValid(item) {
    if (!isTelegramQueueItemAdmissionValid(item)) {
        throw new Error(`Invalid Telegram queue admission: ${item.kind} item cannot use ${item.queueLane} lane`);
    }
    const receiptIds = new Set();
    for (const receipt of item.admissionReceipts ?? []) {
        const sourceUpdateIds = new Set(receipt.sourceUpdateIds);
        if (receipt.queueKind !== item.kind ||
            !receipt.receiptId ||
            receiptIds.has(receipt.receiptId) ||
            receipt.sourceUpdateIds.length === 0 ||
            (receipt.journalBindingKey !== undefined &&
                receipt.journalBindingKey.trim().length === 0) ||
            sourceUpdateIds.size !== receipt.sourceUpdateIds.length ||
            receipt.sourceUpdateIds.some((updateId, index) => !Number.isSafeInteger(updateId) ||
                updateId < 0 ||
                (index > 0 && updateId <= receipt.sourceUpdateIds[index - 1]))) {
            throw new Error(`Invalid Telegram queue receipt for ${item.kind} item`);
        }
        receiptIds.add(receipt.receiptId);
    }
}
function getTelegramQueueLaneRank(lane) {
    return getTelegramQueueLaneContract(lane).dispatchRank;
}
export function isPendingTelegramTurn(item) {
    return item.kind === "prompt";
}
export function createTelegramQueueStore(initialItems = []) {
    let queuedItems = initialItems;
    return {
        getQueuedItems: () => queuedItems,
        setQueuedItems: (items) => {
            queuedItems = items;
        },
        hasQueuedItems: () => queuedItems.length > 0,
    };
}
export function createTelegramTransportStampRuntime(deps) {
    let profile;
    let botToken;
    let generation = 0;
    const getStamp = function () {
        const nextProfile = deps.getProfileName() ?? "default";
        const nextBotToken = deps.getBotToken();
        if (nextProfile !== profile || nextBotToken !== botToken) {
            profile = nextProfile;
            botToken = nextBotToken;
            generation += 1;
        }
        return { profile: nextProfile, generation: String(generation) };
    };
    return {
        getStamp,
        isActive(stamp) {
            if (!stamp)
                return false;
            const current = getStamp();
            return (stamp.profile === current.profile &&
                stamp.generation === current.generation);
        },
    };
}
export function createTelegramTransportStampedQueueStore(store, getTransportStamp) {
    return {
        getQueuedItems: store.getQueuedItems,
        hasQueuedItems: store.hasQueuedItems,
        setQueuedItems(items) {
            const stamp = getTransportStamp();
            store.setQueuedItems(items.map((item) => item.transportStamp ? item : { ...item, transportStamp: stamp }));
        },
    };
}
export function isTelegramQueueItemSkipped(item) {
    return item.kind === "prompt" && Boolean(item.reactionSuppressionEmoji);
}
export function countExecutableTelegramQueueItems(items) {
    return items.filter((item) => !isTelegramQueueItemSkipped(item)).length;
}
export function createTelegramQueueItemCountGetter(store) {
    return () => countExecutableTelegramQueueItems(store.getQueuedItems());
}
export function createTelegramActiveTurnStore() {
    let activeTurn;
    return {
        get: () => activeTurn,
        has: () => !!activeTurn,
        set: (turn) => {
            activeTurn = { ...turn };
        },
        clear: () => {
            activeTurn = undefined;
        },
        markNextAbortAnnouncement: () => {
            if (!activeTurn)
                return false;
            activeTurn.announceNextAbortOnEnd = true;
            return true;
        },
        clearNextAbortAnnouncement: () => {
            if (!activeTurn?.announceNextAbortOnEnd)
                return false;
            delete activeTurn.announceNextAbortOnEnd;
            return true;
        },
        getChatId: () => activeTurn?.chatId,
        getTarget: () => activeTurn?.target ? { ...activeTurn.target } : undefined,
        getReplyToMessageId: () => activeTurn?.replyToMessageId,
        getGuestQueryId: () => activeTurn?.guestQueryId,
        getSourceMessageIds: () => activeTurn?.sourceMessageIds,
    };
}
// --- Queue Mutations ---
export function partitionTelegramQueueItemsForHistory(items) {
    const historyTurns = [];
    const remainingItems = [];
    for (const item of items) {
        if (isPendingTelegramTurn(item)) {
            historyTurns.push(item);
            continue;
        }
        remainingItems.push(item);
    }
    return { historyTurns, remainingItems };
}
export function planTelegramPromptEnqueue(items, foldQueuedPromptsIntoHistory) {
    if (!foldQueuedPromptsIntoHistory) {
        return { historyTurns: [], remainingItems: items };
    }
    return partitionTelegramQueueItemsForHistory(items);
}
export function areTelegramQueueAdmissionReceiptsEqual(left, right) {
    return (left.queueKind === right.queueKind &&
        left.receiptId === right.receiptId &&
        left.journalBindingKey === right.journalBindingKey &&
        left.sourceUpdateIds.length === right.sourceUpdateIds.length &&
        left.sourceUpdateIds.every((updateId, index) => updateId === right.sourceUpdateIds[index]));
}
function getTelegramQueueAdmissionReceiptKey(receipt) {
    return JSON.stringify([
        receipt.receiptId,
        receipt.journalBindingKey ?? null,
    ]);
}
function isDuplicateTelegramQueueAdmission(items, item) {
    const incomingReceipts = item.admissionReceipts ?? [];
    if (incomingReceipts.length === 0)
        return false;
    const queuedReceipts = new Map();
    for (const queuedItem of items) {
        for (const receipt of queuedItem.admissionReceipts ?? []) {
            const key = getTelegramQueueAdmissionReceiptKey(receipt);
            const existing = queuedReceipts.get(key);
            if (existing)
                existing.count += 1;
            else
                queuedReceipts.set(key, { receipt, count: 1 });
        }
    }
    let duplicateCount = 0;
    for (const incoming of incomingReceipts) {
        const match = queuedReceipts.get(getTelegramQueueAdmissionReceiptKey(incoming));
        if (!match)
            continue;
        if (match.count !== 1 ||
            !areTelegramQueueAdmissionReceiptsEqual(match.receipt, incoming)) {
            throw new Error(`Conflicting Telegram queue receipt: ${incoming.receiptId}`);
        }
        duplicateCount += 1;
    }
    if (duplicateCount === 0)
        return false;
    if (duplicateCount === incomingReceipts.length)
        return true;
    throw new Error("Telegram queue item overlaps an existing receipt.");
}
export function appendTelegramQueueItem(items, item) {
    assertTelegramQueueItemAdmissionValid(item);
    if (isDuplicateTelegramQueueAdmission(items, item))
        return items;
    return [...items, item];
}
export function createTelegramQueueHandoff(input) {
    if (!input.handoffToken) {
        throw new Error("Telegram queue handoff token is required.");
    }
    const handoff = {
        handoffToken: input.handoffToken,
        payload: createTelegramQueueHandoffPayload(input.item),
    };
    if (Buffer.byteLength(JSON.stringify(handoff)) > TELEGRAM_QUEUE_HANDOFF_PAYLOAD_MAX_BYTES) {
        throw new Error("Telegram queue handoff payload exceeds its byte limit.");
    }
    return handoff;
}
export function createTelegramQueueHandoffPayload(item) {
    assertTelegramQueueItemAdmissionValid(item);
    if (!item.admissionReceipts?.length) {
        throw new Error("Telegram queue handoff requires durable admission receipts.");
    }
    if (item.admissionReceipts.length > TELEGRAM_QUEUE_HANDOFF_MAX_RECEIPTS) {
        throw new Error("Telegram queue handoff has too many admission receipts.");
    }
    if (item.kind === "control") {
        return structuredClone({
            kind: item.kind,
            controlType: item.controlType,
            chatId: item.chatId,
            ...(item.target ? { target: item.target } : {}),
            ...(item.transportStamp ? { transportStamp: item.transportStamp } : {}),
            replyToMessageId: item.replyToMessageId,
            ...(item.guestQueryId ? { guestQueryId: item.guestQueryId } : {}),
            ...(item.guestInlineMessageId
                ? { guestInlineMessageId: item.guestInlineMessageId }
                : {}),
            queueOrder: item.queueOrder,
            queueLane: item.queueLane,
            laneOrder: item.laneOrder,
            statusSummary: item.statusSummary,
            admissionReceipts: item.admissionReceipts,
        });
    }
    return structuredClone({
        kind: item.kind,
        chatId: item.chatId,
        ...(item.target ? { target: item.target } : {}),
        ...(item.transportStamp ? { transportStamp: item.transportStamp } : {}),
        replyToMessageId: item.replyToMessageId,
        ...(item.guestQueryId ? { guestQueryId: item.guestQueryId } : {}),
        ...(item.guestInlineMessageId
            ? { guestInlineMessageId: item.guestInlineMessageId }
            : {}),
        queueOrder: item.queueOrder,
        queueLane: item.queueLane,
        laneOrder: item.laneOrder,
        statusSummary: item.statusSummary,
        admissionReceipts: item.admissionReceipts,
        sourceMessageIds: item.sourceMessageIds,
        queuedAttachments: item.queuedAttachments,
        content: item.content,
        historyText: item.historyText,
        ...(item.priorityEmoji ? { priorityEmoji: item.priorityEmoji } : {}),
        ...(item.reactionSuppressionEmoji
            ? { reactionSuppressionEmoji: item.reactionSuppressionEmoji }
            : {}),
        ...(item.voiceReplyPreferred !== undefined
            ? { voiceReplyPreferred: item.voiceReplyPreferred }
            : {}),
        ...(item.voiceReplyRequired !== undefined
            ? { voiceReplyRequired: item.voiceReplyRequired }
            : {}),
    });
}
export function restoreTelegramQueueHandoffPayload(payload, createControlExecution) {
    const item = payload.kind === "prompt"
        ? structuredClone(payload)
        : {
            ...structuredClone(payload),
            execute: createControlExecution(payload),
        };
    assertTelegramQueueItemAdmissionValid(item);
    return item;
}
function getTelegramQueueHandoffReceipt(payload) {
    const receipt = payload.admissionReceipts[0];
    if (!receipt || payload.admissionReceipts.length !== 1) {
        throw new Error("Telegram queue handoff requires exactly one complete receipt.");
    }
    return receipt;
}
function findTelegramQueueReceiptItem(items, receipt) {
    const receiptKey = getTelegramQueueAdmissionReceiptKey(receipt);
    let match;
    let matchedReceipt;
    for (const item of items) {
        for (const candidate of item.admissionReceipts ?? []) {
            if (getTelegramQueueAdmissionReceiptKey(candidate) !== receiptKey) {
                continue;
            }
            if (match) {
                throw new Error(`Conflicting Telegram queue receipt: ${receipt.receiptId}`);
            }
            match = item;
            matchedReceipt = candidate;
        }
    }
    if (!match)
        return undefined;
    if (!matchedReceipt ||
        !areTelegramQueueAdmissionReceiptsEqual(matchedReceipt, receipt)) {
        throw new Error(`Conflicting Telegram queue receipt: ${receipt.receiptId}`);
    }
    return match;
}
export function removeTelegramQueueItemByReceipt(input) {
    const current = input.store.getQueuedItems();
    const item = findTelegramQueueReceiptItem(current, input.receipt);
    if (!item)
        return false;
    input.store.setQueuedItems(current.filter((candidate) => candidate !== item));
    return true;
}
export function stageTelegramQueueHandoffPayload(input) {
    const receipt = getTelegramQueueHandoffReceipt(input.payload);
    const item = restoreTelegramQueueHandoffPayload(input.payload, input.createControlExecution);
    const current = input.store.getQueuedItems();
    const next = appendTelegramQueueItem(current, item);
    if (next !== current)
        input.store.setQueuedItems(next);
    return {
        status: "staged",
        receiptId: receipt.receiptId,
        sourceUpdateIds: [...receipt.sourceUpdateIds],
    };
}
export function createTelegramQueueHandoffStagingRuntime(input) {
    const stagedStore = createTelegramQueueStore();
    return {
        stage(payload) {
            const receipt = getTelegramQueueHandoffReceipt(payload);
            const liveItem = findTelegramQueueReceiptItem(input.liveStore.getQueuedItems(), receipt);
            if (liveItem) {
                throw new Error(`Telegram queue handoff receipt ${receipt.receiptId} is already live.`);
            }
            return stageTelegramQueueHandoffPayload({
                payload,
                store: stagedStore,
                createControlExecution: input.createControlExecution,
            });
        },
        accept(receipt) {
            const stagedItems = stagedStore.getQueuedItems();
            const stagedItem = findTelegramQueueReceiptItem(stagedItems, receipt);
            if (!stagedItem) {
                return Boolean(findTelegramQueueReceiptItem(input.liveStore.getQueuedItems(), receipt));
            }
            const current = input.liveStore.getQueuedItems();
            const next = appendTelegramQueueItem(current, stagedItem);
            if (next !== current)
                input.liveStore.setQueuedItems(next);
            stagedStore.setQueuedItems(stagedItems.filter((candidate) => candidate !== stagedItem));
            return true;
        },
        cancel(receipt) {
            const stagedItems = stagedStore.getQueuedItems();
            const stagedItem = findTelegramQueueReceiptItem(stagedItems, receipt);
            if (!stagedItem)
                return false;
            stagedStore.setQueuedItems(stagedItems.filter((candidate) => candidate !== stagedItem));
            return true;
        },
        hasStaged(receipt) {
            return Boolean(findTelegramQueueReceiptItem(stagedStore.getQueuedItems(), receipt));
        },
    };
}
function getTelegramPromptTextSignature(item) {
    return item.content
        .filter((entry) => entry.type === "text")
        .map((entry) => entry.text)
        .join("\n");
}
function isDuplicateTelegramPromptTurn(left, right) {
    return (left.chatId === right.chatId &&
        left.target?.threadId === right.target?.threadId &&
        left.replyToMessageId === right.replyToMessageId &&
        getTelegramPromptTextSignature(left) ===
            getTelegramPromptTextSignature(right));
}
export function appendTelegramPromptTurnOnce(items, turn) {
    assertTelegramQueueItemAdmissionValid(turn);
    if (isDuplicateTelegramQueueAdmission(items, turn)) {
        return { items, appended: false };
    }
    const hasAdmissionReceipts = (turn.admissionReceipts?.length ?? 0) > 0;
    const duplicate = !hasAdmissionReceipts &&
        items.some((item) => isPendingTelegramTurn(item) &&
            (item.admissionReceipts?.length ?? 0) === 0 &&
            isDuplicateTelegramPromptTurn(item, turn));
    if (duplicate)
        return { items, appended: false };
    return {
        items: [...items, turn].sort(compareTelegramQueueItems),
        appended: true,
    };
}
export function compareTelegramQueueItems(left, right) {
    assertTelegramQueueItemAdmissionValid(left);
    assertTelegramQueueItemAdmissionValid(right);
    const laneRankDelta = getTelegramQueueLaneRank(left.queueLane) -
        getTelegramQueueLaneRank(right.queueLane);
    if (laneRankDelta !== 0)
        return laneRankDelta;
    if (left.laneOrder !== right.laneOrder) {
        return left.laneOrder - right.laneOrder;
    }
    return left.queueOrder - right.queueOrder;
}
function isTelegramQueueItemInMessageScope(item, scope) {
    if (!scope)
        return true;
    if (typeof scope.chatId === "number" && item.chatId !== scope.chatId) {
        return false;
    }
    if (typeof scope.threadId === "number") {
        return item.target?.threadId === scope.threadId;
    }
    return true;
}
export function removeTelegramQueueItemsByMessageIds(items, messageIds, scope) {
    if (messageIds.length === 0 || items.length === 0) {
        return { items, removedItems: [], removedCount: 0 };
    }
    const deletedMessageIds = new Set(messageIds);
    const nextItems = [];
    const removedItems = [];
    for (const item of items) {
        const shouldRemove = isPendingTelegramTurn(item) &&
            isTelegramQueueItemInMessageScope(item, scope) &&
            item.sourceMessageIds.some((messageId) => deletedMessageIds.has(messageId));
        (shouldRemove ? removedItems : nextItems).push(item);
    }
    return {
        items: nextItems,
        removedItems,
        removedCount: removedItems.length,
    };
}
export function removeTelegramQueuedGuestPromptByOrder(items, queueOrder) {
    const index = items.findIndex((item) => {
        return isPendingTelegramTurn(item) &&
            item.guestQueryId !== undefined &&
            item.queueOrder === queueOrder;
    });
    if (index < 0)
        return { items, removedItems: [], removedCount: 0 };
    const removedItem = items[index];
    return {
        items: [...items.slice(0, index), ...items.slice(index + 1)],
        removedItems: [removedItem],
        removedCount: 1,
    };
}
export function applyTelegramQueuePromptReactionDisposition(items, messageId, disposition, destinationLaneOrder, scope) {
    let nextItems = items;
    for (const [index, item] of items.entries()) {
        if (!isPendingTelegramTurn(item) ||
            !isTelegramQueueItemInMessageScope(item, scope) ||
            !item.sourceMessageIds.includes(messageId)) {
            continue;
        }
        const isPriority = disposition.kind === "reaction-transition"
            ? disposition.priorityEmoji === undefined
                ? item.queueLane === "priority"
                : disposition.priorityEmoji !== null
            : disposition.kind === "priority" ||
                disposition.kind === "priority-suppressed";
        const queueLane = isPriority ? "priority" : "default";
        const laneOrder = item.queueLane === queueLane
            ? item.laneOrder
            : destinationLaneOrder;
        if (laneOrder === undefined) {
            throw new Error("Telegram destination lane order is unavailable.");
        }
        const priorityEmoji = disposition.kind === "reaction-transition"
            ? disposition.priorityEmoji === undefined
                ? item.priorityEmoji
                : disposition.priorityEmoji ?? undefined
            : disposition.kind === "priority"
                ? disposition.emoji
                : disposition.kind === "priority-suppressed"
                    ? disposition.priorityEmoji
                    : undefined;
        const reactionSuppressionEmoji = disposition.kind === "reaction-transition"
            ? disposition.suppressionEmoji === undefined
                ? item.reactionSuppressionEmoji
                : disposition.suppressionEmoji ?? undefined
            : disposition.kind === "suppressed"
                ? disposition.emoji
                : disposition.kind === "priority-suppressed"
                    ? disposition.suppressionEmoji
                    : undefined;
        if (item.queueLane === queueLane &&
            item.laneOrder === laneOrder &&
            item.priorityEmoji === priorityEmoji &&
            item.reactionSuppressionEmoji === reactionSuppressionEmoji) {
            continue;
        }
        if (nextItems === items)
            nextItems = [...items];
        nextItems[index] = {
            ...item,
            queueLane,
            laneOrder,
            priorityEmoji,
            reactionSuppressionEmoji,
        };
    }
    return { items: nextItems, changed: nextItems !== items };
}
export function consumeDispatchedTelegramPrompt(items, hasPendingDispatch) {
    if (!hasPendingDispatch) {
        return { activeTurn: undefined, remainingItems: items };
    }
    const nextItem = items[0];
    if (!nextItem || !isPendingTelegramTurn(nextItem)) {
        return { activeTurn: undefined, remainingItems: items };
    }
    return { activeTurn: nextItem, remainingItems: items.slice(1) };
}
export function formatQueuedTelegramItemsStatus(items) {
    const count = countExecutableTelegramQueueItems(items);
    return count === 0 ? "" : ` +${count}`;
}
export function truncateTelegramQueueSummary(text, maxWords = 5, maxLength = 40) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized)
        return "";
    const words = normalized.split(" ");
    let summary = words.slice(0, maxWords).join(" ");
    if (summary.length === 0)
        summary = normalized;
    if (summary.length > maxLength) {
        summary = summary.slice(0, maxLength).trimEnd();
    }
    return summary.length < normalized.length || words.length > maxWords
        ? `${summary}…`
        : summary;
}
export function canDispatchTelegramTurnState(state) {
    return (!state.compactionInProgress &&
        !state.hasActiveTelegramTurn &&
        !state.hasPendingTelegramDispatch &&
        state.isIdle &&
        !state.hasPendingMessages);
}
export function createTelegramDispatchReadinessChecker(deps) {
    return (ctx) => canDispatchTelegramTurnState({
        compactionInProgress: deps.isCompactionInProgress(),
        hasActiveTelegramTurn: deps.hasActiveTurn(),
        hasPendingTelegramDispatch: deps.hasDispatchPending(),
        isIdle: deps.isIdle(ctx),
        hasPendingMessages: deps.hasPendingMessages(ctx),
    });
}
export function buildPendingTelegramControlItem(options) {
    return {
        kind: "control",
        controlType: options.controlType,
        chatId: options.chatId,
        ...(options.target ? { target: options.target } : {}),
        replyToMessageId: options.replyToMessageId,
        queueOrder: options.queueOrder,
        queueLane: "control",
        laneOrder: options.laneOrder,
        statusSummary: options.statusSummary,
        ...(options.admissionReceipts?.length
            ? { admissionReceipts: structuredClone(options.admissionReceipts) }
            : {}),
        execute: options.execute,
    };
}
export function createTelegramControlItemBuilder(deps) {
    return (options) => buildPendingTelegramControlItem({
        ...options,
        queueOrder: deps.allocateItemOrder(),
        laneOrder: deps.allocateControlOrder(),
    });
}
export function planNextTelegramQueueAction(items, canDispatch) {
    if (!canDispatch || items.length === 0) {
        return { kind: "none", remainingItems: items };
    }
    const [firstItem, ...remainingItems] = items;
    if (!firstItem) {
        return { kind: "none", remainingItems: items };
    }
    assertTelegramQueueItemAdmissionValid(firstItem);
    if (isPendingTelegramTurn(firstItem)) {
        return { kind: "prompt", item: firstItem, remainingItems: items };
    }
    return { kind: "control", item: firstItem, remainingItems };
}
export function shouldDispatchAfterTelegramAgentEnd(options) {
    if (!options.hasTurn)
        return true;
    if (options.stopReason === "aborted") {
        return !options.foldQueuedPromptsIntoHistory;
    }
    return true;
}
export function buildTelegramAgentStartPlan(options) {
    if (options.hasActiveTurn || !options.hasPendingDispatch) {
        return {
            activeTurn: undefined,
            remainingItems: options.queuedItems,
            shouldResetPendingModelSwitch: true,
            shouldResetToolExecutions: true,
            shouldClearDispatchPending: options.hasPendingDispatch,
            shouldClearAbortHistory: !options.hasActiveTurn && !options.hasPendingDispatch,
        };
    }
    const nextDispatch = consumeDispatchedTelegramPrompt(options.queuedItems, options.hasPendingDispatch);
    return {
        activeTurn: nextDispatch.activeTurn,
        remainingItems: nextDispatch.remainingItems,
        shouldResetPendingModelSwitch: true,
        shouldResetToolExecutions: true,
        shouldClearDispatchPending: options.hasPendingDispatch,
        shouldClearAbortHistory: false,
    };
}
export function handleTelegramAgentStartRuntime(deps) {
    const startPlan = buildTelegramAgentStartPlan({
        queuedItems: deps.queuedItems,
        hasPendingDispatch: deps.hasPendingDispatch,
        hasActiveTurn: deps.hasActiveTurn,
    });
    if (startPlan.shouldResetToolExecutions)
        deps.resetToolExecutions();
    if (startPlan.shouldResetPendingModelSwitch)
        deps.resetPendingModelSwitch();
    if (startPlan.shouldClearAbortHistory) {
        deps.setFoldQueuedPromptsIntoHistory(false);
    }
    deps.setQueuedItems(startPlan.remainingItems);
    if (startPlan.shouldClearDispatchPending)
        deps.clearDispatchPending();
    if (startPlan.activeTurn) {
        const activeTurn = startPlan.activeTurn;
        deps.setActiveTurn(activeTurn);
        try {
            deps.onPromptHandedOff?.(activeTurn);
        }
        catch (error) {
            deps.recordRuntimeEvent?.("queue", error, {
                phase: "prompt-handoff-receipt-settlement",
            });
        }
        deps.createPreviewState();
        deps.startTypingLoop();
    }
    deps.updateStatus();
}
export function createTelegramAgentStartHook(deps) {
    return async (_event, ctx) => {
        deps.setAbortHandler(ctx);
        handleTelegramAgentStartRuntime({
            queuedItems: deps.getQueuedItems(),
            hasPendingDispatch: deps.hasPendingDispatch(),
            hasActiveTurn: deps.hasActiveTurn(),
            resetToolExecutions: deps.resetToolExecutions,
            resetPendingModelSwitch: deps.resetPendingModelSwitch,
            setQueuedItems: deps.setQueuedItems,
            clearDispatchPending: deps.clearDispatchPending,
            setFoldQueuedPromptsIntoHistory: deps.setFoldQueuedPromptsIntoHistory,
            setActiveTurn: deps.setActiveTurn,
            onPromptHandedOff: (turn) => deps.onPromptHandedOff?.(turn, ctx),
            createPreviewState: deps.createPreviewState,
            recordRuntimeEvent: deps.recordRuntimeEvent,
            startTypingLoop: () => deps.startTypingLoop(ctx),
            updateStatus: () => deps.updateStatus(ctx),
        });
    };
}
export function getNextTelegramToolExecutionCount(options) {
    if (options.event === "start") {
        return options.currentCount + 1;
    }
    return Math.max(0, options.currentCount - 1);
}
export function handleTelegramToolExecutionStartRuntime(deps) {
    deps.setActiveToolExecutions(getNextTelegramToolExecutionCount({
        currentCount: deps.getActiveToolExecutions(),
        event: "start",
    }));
}
export function handleTelegramToolExecutionEndRuntime(deps) {
    deps.setActiveToolExecutions(getNextTelegramToolExecutionCount({
        currentCount: deps.getActiveToolExecutions(),
        event: "end",
    }));
    deps.triggerPendingModelSwitchAbort();
}
export function createTelegramAgentLifecycleHooks(deps) {
    const onAgentStart = createTelegramAgentStartHook(deps);
    const deliverAgentEnd = createTelegramAgentEndHook(deps);
    let retainedErrorEvent;
    return {
        onAgentStart,
        async onAgentEnd(event, ctx) {
            const turn = deps.getActiveTurn();
            const assistant = turn ? deps.extractAssistant(event.messages) : {};
            if (turn && assistant.stopReason === "error") {
                retainedErrorEvent = event;
                deps.recordRuntimeEvent?.("provider-retry", new Error("Retained Telegram turn after retryable agent error"), { phase: "retained", hasFinalText: !!assistant.text?.trim() });
                return;
            }
            if (retainedErrorEvent) {
                retainedErrorEvent = undefined;
                deps.recordRuntimeEvent?.("provider-retry", new Error("Recovered retained Telegram turn after agent retry"), { phase: "recovered" });
            }
            await deliverAgentEnd(event, ctx, assistant);
        },
        async onAgentSettled(_event, ctx) {
            const event = retainedErrorEvent;
            if (!event)
                return;
            retainedErrorEvent = undefined;
            deps.recordRuntimeEvent?.("provider-retry", new Error("Finalized retained Telegram turn after agent settled"), { phase: "settled-failure" });
            await deliverAgentEnd(event, ctx);
        },
        clearRetainedAgentEnd() {
            retainedErrorEvent = undefined;
        },
        ...createTelegramToolExecutionHooks(deps),
    };
}
export function createTelegramToolExecutionHooks(deps) {
    return {
        onToolExecutionStart: () => {
            handleTelegramToolExecutionStartRuntime(deps);
        },
        onToolExecutionEnd: (_event, ctx) => {
            handleTelegramToolExecutionEndRuntime({
                getActiveToolExecutions: deps.getActiveToolExecutions,
                setActiveToolExecutions: deps.setActiveToolExecutions,
                triggerPendingModelSwitchAbort: () => {
                    deps.triggerPendingModelSwitchAbort(ctx);
                },
            });
        },
    };
}
export function buildTelegramAgentEndPlan(options) {
    const shouldDispatchNext = shouldDispatchAfterTelegramAgentEnd({
        hasTurn: options.hasTurn,
        stopReason: options.stopReason,
        foldQueuedPromptsIntoHistory: options.foldQueuedPromptsIntoHistory,
    });
    if (!options.hasTurn) {
        return {
            kind: "no-turn",
            shouldClearPreview: false,
            shouldDispatchNext,
            shouldSendAbortMessage: false,
            shouldSendErrorMessage: false,
            shouldSendAttachmentNotice: false,
        };
    }
    if (options.stopReason === "aborted") {
        return {
            kind: "aborted",
            shouldClearPreview: true,
            shouldDispatchNext,
            shouldSendAbortMessage: options.announceNextAbortOnEnd === true,
            shouldSendErrorMessage: false,
            shouldSendAttachmentNotice: false,
        };
    }
    if (options.stopReason === "error") {
        return {
            kind: "error",
            shouldClearPreview: true,
            shouldDispatchNext,
            shouldSendAbortMessage: false,
            shouldSendErrorMessage: true,
            shouldSendAttachmentNotice: false,
        };
    }
    if (options.hasFinalText) {
        return {
            kind: "text",
            shouldClearPreview: false,
            shouldDispatchNext,
            shouldSendAbortMessage: false,
            shouldSendErrorMessage: false,
            shouldSendAttachmentNotice: false,
        };
    }
    if (options.hasQueuedAttachments) {
        return {
            kind: "attachments-only",
            shouldClearPreview: true,
            shouldDispatchNext,
            shouldSendAbortMessage: false,
            shouldSendErrorMessage: false,
            shouldSendAttachmentNotice: true,
        };
    }
    return {
        kind: "empty",
        shouldClearPreview: true,
        shouldDispatchNext,
        shouldSendAbortMessage: false,
        shouldSendErrorMessage: false,
        shouldSendAttachmentNotice: false,
    };
}
export function createTelegramAgentEndHook(deps) {
    return async (event, ctx, assistantOverride) => {
        if (deps.isSessionActive?.(ctx) === false)
            return;
        const turn = deps.getActiveTurn();
        const extractedAssistant = assistantOverride ?? (turn ? deps.extractAssistant(event.messages) : {});
        const assistant = deps.isAssistantAlreadyPublished?.(extractedAssistant)
            ? { stopReason: extractedAssistant.stopReason }
            : extractedAssistant;
        const hasPublication = !!assistant.text || assistant.stopReason === "error" || !!turn?.queuedAttachments.length;
        const reservation = turn && !turn.guestQueryId && hasPublication ? deps.reserveActiveTurnDelivery?.() : undefined;
        const scheduleDelivery = reservation?.schedule ?? deps.scheduleActiveTurnDelivery;
        try {
            await deps.loadConfig?.();
            if (deps.isSessionActive?.(ctx) === false || deps.getActiveTurn() !== turn)
                return;
            await handleTelegramAgentEndRuntime({
                turn,
                assistant,
                foldQueuedPromptsIntoHistory: deps.getFoldQueuedPromptsIntoHistory(),
                resetRuntimeState: deps.resetRuntimeState,
                isSessionActive: () => deps.isSessionActive?.(ctx) ?? true,
                isTurnTransportActive: deps.isTurnTransportActive,
                waitForTypingIdle: deps.waitForTypingIdle,
                waitForActivityIdle: deps.waitForActivityIdle,
                updateStatus: () => deps.updateStatus(ctx),
                dispatchNextQueuedTelegramTurn: () => {
                    deps.requestDeferredDispatchNextQueuedTelegramTurn(deps.dispatchNextQueuedTelegramTurn);
                },
                scheduleActiveTurnDelivery: scheduleDelivery
                    ? (task) => scheduleDelivery(async () => {
                        if (deps.isSessionActive?.(ctx) === false)
                            return;
                        await task();
                    })
                    : undefined,
                preparePreviewDelivery: deps.preparePreviewDelivery,
                preparePreviewClear: deps.preparePreviewClear,
                clearPreview: deps.clearPreview,
                setPreviewPendingText: deps.setPreviewPendingText,
                finalizeMarkdownPreview: deps.finalizeMarkdownPreview,
                sendMarkdownReply: deps.sendMarkdownReply,
                sendTextReply: deps.sendTextReply,
                sendQueuedAttachments: deps.sendQueuedAttachments,
                sendRichAttachmentReply: deps.sendRichAttachmentReply,
                answerGuestQuery: deps.answerGuestQuery,
                sendGuestReply: deps.sendGuestReply,
                editGuestReply: deps.editGuestReply,
                stopGuestPlaceholder: deps.stopGuestPlaceholder,
                sendGuestAttachment: deps.sendGuestAttachment,
                sendGuestVoiceReply: deps.sendGuestVoiceReply,
                planOutboundReply: deps.planOutboundReply,
                sendOutboundReplyArtifacts: deps.sendOutboundReplyArtifacts,
                recordRuntimeEvent: deps.recordRuntimeEvent,
            });
        }
        finally {
            reservation?.cancel();
        }
    };
}
export async function handleTelegramAgentEndRuntime(deps) {
    const { turn, assistant } = deps;
    const rawFinalText = assistant.text;
    let outboundReply = rawFinalText
        ? deps.planOutboundReply?.(rawFinalText)
        : undefined;
    // Preserve the planned reply so voice-fallback can use stripped markdown + replyMarkup
    const plannedReply = outboundReply;
    // Transparent voice interception: when the turn is voice-tagged and the agent
    // did not explicitly use <!-- telegram_voice --> markup, we automatically
    // convert the whole response to voice.
    const voiceInterceptionGuard = turn &&
        isVoiceTurn(turn) &&
        rawFinalText?.trim() &&
        deps.planOutboundReply &&
        (!outboundReply ||
            (!outboundReply.voiceText && !outboundReply.voiceReplies?.length));
    if (voiceInterceptionGuard) {
        const voiceText = plannedReply !== undefined
            ? plannedReply.markdown?.trim() || ""
            : (rawFinalText ?? "");
        outboundReply = outboundReply
            ? { ...outboundReply, voiceText, markdown: "" }
            : { markdown: "", voiceText };
    }
    const finalText = outboundReply ? outboundReply.markdown : rawFinalText;
    const hasOutboundArtifacts = !!outboundReply?.voiceText || !!outboundReply?.voiceReplies?.length;
    const replyMarkup = outboundReply?.replyMarkup;
    const isDeliveryActive = () => deps.isSessionActive?.() !== false &&
        (!turn || deps.isTurnTransportActive?.(turn) !== false);
    const preview = turn && !turn.guestQueryId ? deps.preparePreviewDelivery?.(isDeliveryActive) : undefined;
    const setPreviewPendingText = preview?.setPreviewPendingText ?? deps.setPreviewPendingText;
    const finalizeMarkdownPreview = preview?.finalizeMarkdownPreview ?? deps.finalizeMarkdownPreview;
    const clearPreview = turn
        ? preview ? () => preview.clearPreview(turn.chatId, { target: turn.target })
            : deps.preparePreviewClear?.(turn.chatId, { target: turn.target, isDeliveryActive })
                ?? (() => deps.clearPreview(turn.chatId, { target: turn.target }))
        : undefined;
    const updateStatusIgnoringStaleContext = () => {
        try {
            deps.updateStatus();
        }
        catch (error) {
            if (!isTelegramStaleContextError(error))
                throw error;
        }
    };
    if (!isDeliveryActive()) {
        deps.resetRuntimeState();
        updateStatusIgnoringStaleContext();
        deps.dispatchNextQueuedTelegramTurn();
        return;
    }
    deps.resetRuntimeState();
    await deps.waitForTypingIdle?.();
    if (!isDeliveryActive()) {
        updateStatusIgnoringStaleContext();
        deps.dispatchNextQueuedTelegramTurn();
        return;
    }
    updateStatusIgnoringStaleContext();
    const endPlan = buildTelegramAgentEndPlan({
        hasTurn: !!turn,
        stopReason: assistant.stopReason,
        hasFinalText: !!finalText || hasOutboundArtifacts,
        hasQueuedAttachments: (turn?.queuedAttachments.length ?? 0) > 0,
        foldQueuedPromptsIntoHistory: deps.foldQueuedPromptsIntoHistory,
        announceNextAbortOnEnd: turn?.announceNextAbortOnEnd === true,
    });
    if (!turn) {
        if (endPlan.shouldDispatchNext)
            deps.dispatchNextQueuedTelegramTurn();
        return;
    }
    if (turn.guestQueryId) {
        if (turn.guestInlineMessageId && deps.stopGuestPlaceholder) {
            try {
                await deps.stopGuestPlaceholder(turn.guestInlineMessageId);
            }
            catch (error) {
                deps.recordRuntimeEvent?.("delivery", error, {
                    phase: "guest-placeholder-stop",
                    guestQueryId: turn.guestQueryId,
                });
            }
        }
        if (turn.guestInlineMessageId && deps.editGuestReply) {
            const experimentText = assistant.errorMessage
                ? "Telegram bridge: Pi failed while processing the request."
                : finalText;
            if (experimentText) {
                try {
                    await deps.editGuestReply(turn.guestInlineMessageId, experimentText);
                    deps.recordRuntimeEvent?.("guest", new Error("Guest ACK edited the guest answer"), { phase: "guest-ack-edited", guestQueryId: turn.guestQueryId });
                }
                catch (error) {
                    deps.recordRuntimeEvent?.("delivery", error, {
                        phase: "guest-ack-edit",
                        guestQueryId: turn.guestQueryId,
                    });
                }
            }
            else {
                deps.recordRuntimeEvent?.("delivery", new Error("Guest ACK turn produced no editable text"), { phase: "guest-ack-edit-empty", guestQueryId: turn.guestQueryId });
            }
            if (!isDeliveryActive())
                return;
            if (endPlan.shouldDispatchNext)
                deps.dispatchNextQueuedTelegramTurn();
            return;
        }
        if (assistant.errorMessage) {
            try {
                await deps.answerGuestQuery?.(turn.guestQueryId, "Telegram bridge: Pi failed while processing the request.");
            }
            catch (error) {
                deps.recordRuntimeEvent?.("delivery", error, {
                    phase: "guest-error-reply",
                    guestQueryId: turn.guestQueryId,
                });
            }
            if (endPlan.shouldDispatchNext)
                deps.dispatchNextQueuedTelegramTurn();
            return;
        }
        const [guestAttachment] = turn.queuedAttachments;
        if (guestAttachment && deps.sendGuestAttachment) {
            try {
                await deps.sendGuestAttachment(turn, guestAttachment, finalText || undefined);
            }
            catch (error) {
                deps.recordRuntimeEvent?.("delivery", error, {
                    phase: "guest-attachment",
                    guestQueryId: turn.guestQueryId,
                });
            }
        }
        else if (outboundReply &&
            (outboundReply.voiceText || outboundReply.voiceReplies?.length) &&
            deps.sendGuestVoiceReply) {
            try {
                await deps.sendGuestVoiceReply(turn, outboundReply, finalText || undefined);
            }
            catch (error) {
                deps.recordRuntimeEvent?.("delivery", error, {
                    phase: "guest-voice",
                    guestQueryId: turn.guestQueryId,
                });
            }
        }
        else if (finalText) {
            try {
                if (deps.sendGuestReply) {
                    await deps.sendGuestReply(turn.guestQueryId, finalText);
                }
                else {
                    await deps.answerGuestQuery?.(turn.guestQueryId, finalText);
                }
            }
            catch (error) {
                // Guest queries expire after Telegram's response timeout, so a slow
                // turn can fail the only delivery attempt. Record and continue the
                // agent-end lifecycle instead of rejecting the extension hook.
                deps.recordRuntimeEvent?.("delivery", error, {
                    phase: "guest-reply",
                    guestQueryId: turn.guestQueryId,
                });
            }
        }
        if (!isDeliveryActive())
            return;
        if (endPlan.shouldDispatchNext)
            deps.dispatchNextQueuedTelegramTurn();
        return;
    }
    if (!isDeliveryActive())
        return;
    const deliverActiveTurn = async () => {
        await deps.waitForActivityIdle?.();
        if (!isDeliveryActive())
            return;
        let previewCleared = false;
        const clearTurnPreview = async () => {
            if (previewCleared)
                return;
            await clearPreview?.();
            previewCleared = true;
        };
        if (endPlan.shouldClearPreview || (!finalText && hasOutboundArtifacts)) {
            await clearTurnPreview();
            if (!isDeliveryActive())
                return;
        }
        if (endPlan.shouldSendAbortMessage || endPlan.shouldSendErrorMessage) {
            const errorMessage = assistant.errorMessage ||
                "Telegram bridge: Pi failed while processing the request.";
            const isOperationAborted = endPlan.shouldSendAbortMessage ||
                errorMessage.trim().replace(/\.$/, "") === "This operation was aborted";
            try {
                await deps.sendTextReply(turn.chatId, turn.replyToMessageId, isOperationAborted
                    ? "<b>⏹️ This operation was aborted.</b>"
                    : errorMessage, {
                    target: turn.target,
                    ...(isOperationAborted ? { parseMode: "HTML" } : {}),
                });
            }
            catch (error) {
                if (!isOperationAborted)
                    throw error;
                deps.recordRuntimeEvent?.("dispatch", error, {
                    phase: "next-abort-announcement",
                });
            }
            if (!isDeliveryActive())
                return;
            if (endPlan.shouldDispatchNext)
                deps.dispatchNextQueuedTelegramTurn();
            return;
        }
        if (finalText && turn.queuedAttachments.length === 0)
            setPreviewPendingText(finalText);
        if (!isDeliveryActive())
            return;
        let richAttachmentDelivered = false;
        if (endPlan.kind === "text" &&
            finalText &&
            !hasOutboundArtifacts &&
            deps.sendRichAttachmentReply) {
            try {
                richAttachmentDelivered = await deps.sendRichAttachmentReply(turn, finalText, { replyMarkup, isDeliveryActive });
                if (!isDeliveryActive())
                    return;
                if (richAttachmentDelivered) {
                    await clearTurnPreview();
                    if (!isDeliveryActive())
                        return;
                    setPreviewPendingText("");
                }
            }
            catch (error) {
                if (!isDeliveryActive())
                    return;
                deps.recordRuntimeEvent?.("delivery", error, {
                    phase: "rich-attachment-commit-unknown",
                    chatId: turn.chatId,
                });
                if (endPlan.shouldDispatchNext)
                    deps.dispatchNextQueuedTelegramTurn();
                return;
            }
        }
        if (!isDeliveryActive())
            return;
        let queuedAttachmentsDelivered = false;
        if (!richAttachmentDelivered && turn.queuedAttachments.length > 0) {
            await clearTurnPreview();
            if (!isDeliveryActive())
                return;
            setPreviewPendingText("");
            await deps.sendQueuedAttachments(turn, { isDeliveryActive });
            if (!isDeliveryActive())
                return;
            queuedAttachmentsDelivered = true;
        }
        if (!richAttachmentDelivered && endPlan.kind === "text" && finalText) {
            try {
                if (queuedAttachmentsDelivered) {
                    await deps.sendMarkdownReply(turn.chatId, turn.replyToMessageId, finalText, { replyMarkup, target: turn.target });
                }
                else {
                    const finalized = await finalizeMarkdownPreview(turn.chatId, finalText, turn.replyToMessageId, { replyMarkup, target: turn.target });
                    if (!isDeliveryActive())
                        return;
                    if (!finalized) {
                        await clearTurnPreview();
                        if (!isDeliveryActive())
                            return;
                        await deps.sendMarkdownReply(turn.chatId, turn.replyToMessageId, finalText, { replyMarkup, target: turn.target });
                    }
                }
                if (!isDeliveryActive())
                    return;
                setPreviewPendingText("");
            }
            catch (error) {
                deps.recordRuntimeEvent?.("delivery", error, {
                    phase: "final-text",
                    chatId: turn.chatId,
                    replyToMessageId: turn.replyToMessageId,
                });
            }
        }
        if (!isDeliveryActive())
            return;
        if (outboundReply && deps.sendOutboundReplyArtifacts) {
            try {
                await deps.sendOutboundReplyArtifacts(turn, outboundReply, {
                    replyToPrompt: !finalText,
                    isDeliveryActive,
                });
                if (!isDeliveryActive())
                    return;
            }
            catch (error) {
                deps.recordRuntimeEvent?.("delivery", error, {
                    phase: "voice-artifacts",
                    chatId: turn.chatId,
                });
                if (!isDeliveryActive())
                    return;
                if (isTelegramApiCommitUnknownError(error)) {
                    if (endPlan.shouldDispatchNext)
                        deps.dispatchNextQueuedTelegramTurn();
                    return;
                }
                // Fallback only when voice delivery is not uncertain and text wasn't already delivered.
                if (rawFinalText?.trim() && !finalText && hasOutboundArtifacts) {
                    try {
                        const fallbackMarkdown = plannedReply?.markdown ||
                            outboundReply?.voiceText ||
                            rawFinalText;
                        await deps.sendMarkdownReply(turn.chatId, turn.replyToMessageId, fallbackMarkdown, plannedReply?.replyMarkup || turn.target
                            ? {
                                replyMarkup: plannedReply?.replyMarkup,
                                target: turn.target,
                            }
                            : undefined);
                    }
                    catch (fallbackError) {
                        deps.recordRuntimeEvent?.("delivery", fallbackError, {
                            phase: "voice-fallback-text",
                            chatId: turn.chatId,
                        });
                    }
                }
            }
        }
        if (!isDeliveryActive())
            return;
        if (!richAttachmentDelivered && endPlan.shouldSendAttachmentNotice) {
            await deps.sendTextReply(turn.chatId, turn.replyToMessageId, "Attached requested file(s).", { target: turn.target });
        }
        if (!isDeliveryActive())
            return;
        if (!richAttachmentDelivered && !queuedAttachmentsDelivered) {
            await deps.sendQueuedAttachments(turn, { isDeliveryActive });
        }
        if (!isDeliveryActive())
            return;
        if (endPlan.shouldDispatchNext)
            deps.dispatchNextQueuedTelegramTurn();
    };
    if (deps.scheduleActiveTurnDelivery &&
        (endPlan.kind === "text" || endPlan.kind === "attachments-only" || endPlan.shouldSendAbortMessage || endPlan.shouldSendErrorMessage || endPlan.shouldClearPreview)) {
        deps.scheduleActiveTurnDelivery(deliverActiveTurn);
        return;
    }
    await deliverActiveTurn();
}
export function createTelegramSessionStateApplier(deps) {
    return {
        applyStartState: (state) => {
            deps.setCurrentModel(state.currentTelegramModel);
            deps.setPendingModelSwitch(state.pendingTelegramModelSwitch);
            deps.syncCounters(state);
            deps.syncFlags(state);
        },
        applyShutdownState: (state) => {
            deps.setQueuedItems(state.queuedTelegramItems);
            deps.syncCounters(state);
            deps.syncFlags(state);
            deps.setCurrentModel(state.currentTelegramModel);
            deps.setPendingModelSwitch(state.pendingTelegramModelSwitch);
        },
    };
}
function isTelegramStaleContextError(error) {
    return (error instanceof Error &&
        (error.message.includes("stale after session") ||
            error.message.includes("stale ctx")));
}
export function buildTelegramSessionStartState(currentModel) {
    return {
        currentTelegramModel: currentModel,
        activeTelegramToolExecutions: 0,
        pendingTelegramModelSwitch: undefined,
        nextQueuedTelegramItemOrder: 0,
        nextQueuedTelegramControlOrder: 0,
        telegramTurnDispatchPending: false,
        compactionInProgress: false,
    };
}
export function buildTelegramSessionShutdownState() {
    return {
        queuedTelegramItems: [],
        nextQueuedTelegramItemOrder: 0,
        nextQueuedTelegramControlOrder: 0,
        currentTelegramModel: undefined,
        activeTelegramToolExecutions: 0,
        pendingTelegramModelSwitch: undefined,
        telegramTurnDispatchPending: false,
        compactionInProgress: false,
        foldQueuedPromptsIntoHistory: false,
    };
}
export async function startTelegramSessionRuntime(deps) {
    await deps.loadConfig();
    if (deps.isSessionActive?.() === false)
        return;
    deps.applyState(buildTelegramSessionStartState(deps.currentModel));
    await deps.prepareTempDir();
    if (deps.isSessionActive?.() === false)
        return;
    try {
        deps.bindDeferredDispatchContext?.(deps.ctx);
    }
    catch (error) {
        if (!isTelegramStaleContextError(error))
            throw error;
    }
    deps.updateStatus();
}
export async function shutdownTelegramSessionRuntime(deps) {
    if (deps.isSessionActive?.() === false)
        return;
    deps.unbindDeferredDispatchContext?.();
    await deps.stopPolling();
    if (deps.isSessionActive?.() === false)
        return;
    deps.discardQueuedItems?.();
    deps.applyState(buildTelegramSessionShutdownState());
    deps.clearPendingMediaGroups();
    deps.clearModelMenuState();
    const activeTurnChatId = deps.getActiveTurnChatId();
    if (activeTurnChatId !== undefined) {
        const target = deps.getActiveTurnTarget?.();
        const previewTimeoutMs = deps.previewShutdownTimeoutMs ?? 1000;
        let timeout;
        await Promise.race([
            deps.clearPreview(activeTurnChatId, target ? { target } : undefined),
            new Promise((resolve) => {
                timeout = setTimeout(resolve, previewTimeoutMs);
            }),
        ]).finally(() => {
            if (timeout)
                clearTimeout(timeout);
        });
        if (deps.isSessionActive?.() === false)
            return;
    }
    deps.clearActiveTurn();
    deps.clearAbort();
}
export function createTelegramSessionLifecycleRuntime(deps) {
    const stateApplier = createTelegramSessionStateApplier({
        setQueuedItems: deps.setQueuedItems,
        setCurrentModel: deps.setCurrentModel,
        setPendingModelSwitch: deps.setPendingModelSwitch,
        syncCounters: deps.syncCounters,
        syncFlags: deps.syncFlags,
    });
    return createTelegramSessionLifecycleHooks({
        getCurrentModel: deps.getCurrentModel,
        loadConfig: deps.loadConfig,
        applySessionStartState: stateApplier.applyStartState,
        bindDeferredDispatchContext: deps.bindDeferredDispatchContext,
        prepareTempDir: deps.prepareTempDir,
        updateStatus: deps.updateStatus,
        isSessionActive: deps.isSessionActive,
        unbindDeferredDispatchContext: deps.unbindDeferredDispatchContext,
        discardQueuedItems: deps.discardQueuedItems,
        applySessionShutdownState: stateApplier.applyShutdownState,
        clearPendingMediaGroups: deps.clearPendingMediaGroups,
        clearModelMenuState: deps.clearModelMenuState,
        getActiveTurnChatId: deps.getActiveTurnChatId,
        getActiveTurnTarget: deps.getActiveTurnTarget,
        clearPreview: deps.clearPreview,
        clearActiveTurn: deps.clearActiveTurn,
        clearAbort: deps.clearAbort,
        stopPolling: deps.stopPolling,
        recordRuntimeEvent: deps.recordRuntimeEvent,
    });
}
export function createTelegramSessionLifecycleHooks(deps) {
    return {
        onSessionStart: async (_event, ctx) => {
            try {
                await startTelegramSessionRuntime({
                    ctx,
                    currentModel: deps.getCurrentModel(ctx),
                    loadConfig: deps.loadConfig,
                    isSessionActive: () => deps.isSessionActive?.(ctx) ?? true,
                    applyState: deps.applySessionStartState,
                    bindDeferredDispatchContext: deps.bindDeferredDispatchContext,
                    prepareTempDir: deps.prepareTempDir,
                    updateStatus: () => deps.updateStatus(ctx),
                });
            }
            catch (error) {
                deps.recordRuntimeEvent?.("session", error, { phase: "start" });
                throw error;
            }
        },
        onSessionShutdown: async (_event, ctx) => {
            try {
                await shutdownTelegramSessionRuntime({
                    isSessionActive: () => ctx === undefined ? true : (deps.isSessionActive?.(ctx) ?? true),
                    unbindDeferredDispatchContext: deps.unbindDeferredDispatchContext,
                    discardQueuedItems: ctx === undefined || !deps.discardQueuedItems
                        ? undefined
                        : () => deps.discardQueuedItems(ctx),
                    applyState: deps.applySessionShutdownState,
                    clearPendingMediaGroups: deps.clearPendingMediaGroups,
                    clearModelMenuState: deps.clearModelMenuState,
                    getActiveTurnChatId: deps.getActiveTurnChatId,
                    getActiveTurnTarget: deps.getActiveTurnTarget,
                    clearPreview: deps.clearPreview,
                    previewShutdownTimeoutMs: deps.previewShutdownTimeoutMs,
                    clearActiveTurn: deps.clearActiveTurn,
                    clearAbort: deps.clearAbort,
                    stopPolling: deps.stopPolling,
                });
            }
            catch (error) {
                deps.recordRuntimeEvent?.("session", error, { phase: "shutdown" });
                throw error;
            }
        },
    };
}
export function createTelegramQueueMutationController(deps) {
    const buildRuntimeDeps = (ctx) => ({
        ...deps,
        ctx,
    });
    return {
        append: (item, ctx) => appendTelegramQueueItemRuntime(item, buildRuntimeDeps(ctx)),
        reorder: (ctx) => reorderTelegramQueueItemsRuntime(buildRuntimeDeps(ctx)),
        clear: (ctx) => clearTelegramQueueItemsRuntime(buildRuntimeDeps(ctx)),
        removeByMessageIds: (messageIds, ctx, scope) => removeTelegramQueueItemsByMessageIdsRuntime(messageIds, buildRuntimeDeps(ctx), scope),
        removeGuestPromptByQueueOrder: (queueOrder, ctx) => removeTelegramQueuedGuestPromptByOrderRuntime(queueOrder, buildRuntimeDeps(ctx)),
        applyReactionByMessageId: (messageId, disposition, ctx, scope) => applyTelegramQueuePromptReactionDispositionRuntime(messageId, disposition, buildRuntimeDeps(ctx), scope),
    };
}
function updateTelegramQueueStatusRuntime(deps) {
    try {
        deps.updateStatus(deps.ctx);
    }
    catch (error) {
        if (!isTelegramStaleContextError(error))
            throw error;
    }
}
function commitReorderedTelegramQueueItemsRuntime(items, deps) {
    deps.setQueuedItems([...items].sort(compareTelegramQueueItems));
    updateTelegramQueueStatusRuntime(deps);
}
function appendTelegramQueueItemRuntime(item, deps) {
    const currentItems = deps.getQueuedItems();
    const nextItems = appendTelegramQueueItem(currentItems, item);
    if (nextItems === currentItems)
        return;
    commitReorderedTelegramQueueItemsRuntime(nextItems, deps);
}
export function reorderTelegramQueueItemsRuntime(deps) {
    commitReorderedTelegramQueueItemsRuntime(deps.getQueuedItems(), deps);
}
export function clearTelegramQueueItemsRuntime(deps) {
    const removedItems = deps.getQueuedItems();
    const removedCount = removedItems.length;
    if (removedCount === 0)
        return 0;
    deps.onItemsDiscarded?.(removedItems, deps.ctx);
    deps.setQueuedItems([]);
    updateTelegramQueueStatusRuntime(deps);
    return removedCount;
}
export function removeTelegramQueueItemsByMessageIdsRuntime(messageIds, deps, scope) {
    const { items, removedItems, removedCount } = removeTelegramQueueItemsByMessageIds(deps.getQueuedItems(), messageIds, scope);
    if (removedCount === 0)
        return 0;
    deps.setQueuedItems(items);
    try {
        deps.onItemsDiscarded?.(removedItems, deps.ctx);
    }
    catch (error) {
        deps.recordRuntimeEvent?.("queue", error, {
            phase: "discard-receipt-settlement",
        });
    }
    updateTelegramQueueStatusRuntime(deps);
    return removedCount;
}
export function removeTelegramQueuedGuestPromptByOrderRuntime(queueOrder, deps) {
    const { items, removedItems, removedCount } = removeTelegramQueuedGuestPromptByOrder(deps.getQueuedItems(), queueOrder);
    if (removedCount === 0)
        return false;
    // A menu Skip means permanent discard, so settle durable admission before
    // removing the live item. A failed settlement keeps the prompt retryable.
    deps.onItemsDiscarded?.(removedItems, deps.ctx);
    deps.setQueuedItems(items);
    updateTelegramQueueStatusRuntime(deps);
    return true;
}
export function applyTelegramQueuePromptReactionDispositionRuntime(messageId, disposition, deps, scope) {
    const queuedItems = deps.getQueuedItems();
    const changesLane = queuedItems.some((item) => {
        if (!isPendingTelegramTurn(item) ||
            !isTelegramQueueItemInMessageScope(item, scope) ||
            !item.sourceMessageIds.includes(messageId)) {
            return false;
        }
        const queueLane = disposition.kind === "reaction-transition"
            ? disposition.priorityEmoji === undefined
                ? item.queueLane
                : disposition.priorityEmoji === null
                    ? "default"
                    : "priority"
            : disposition.kind === "priority" ||
                disposition.kind === "priority-suppressed"
                ? "priority"
                : "default";
        return item.queueLane !== queueLane;
    });
    const destinationLaneOrder = changesLane
        ? deps.allocateLaneOrder?.()
        : undefined;
    if (changesLane && destinationLaneOrder === undefined)
        return false;
    const { changed, items } = applyTelegramQueuePromptReactionDisposition(queuedItems, messageId, disposition, destinationLaneOrder, scope);
    if (!changed)
        return false;
    commitReorderedTelegramQueueItemsRuntime(items, deps);
    return true;
}
export async function enqueueTelegramPromptTurnRuntime(messages, deps) {
    deps.assertExecutionCurrent?.();
    const historyOrders = new Set(planTelegramPromptEnqueue(deps.getQueuedItems(), deps.getFoldQueuedPromptsIntoHistory()).historyTurns.map((turn) => turn.queueOrder));
    deps.setFoldQueuedPromptsIntoHistory(false);
    const buildTurn = await deps.prepareTurn(messages);
    deps.assertExecutionCurrent?.();
    // Preserve the Pi-owned head until agent_start, plus later arrivals and current edits/reactions.
    const pendingDispatch = deps.hasPendingDispatch();
    const historyTurns = [];
    const remainingItems = deps.getQueuedItems().filter((item, index) => {
        if ((pendingDispatch && index === 0) || !isPendingTelegramTurn(item) ||
            !historyOrders.has(item.queueOrder))
            return true;
        historyTurns.push(item);
        return false;
    });
    const turn = buildTurn(historyTurns);
    deps.setQueuedItems(appendTelegramQueueItem(remainingItems, turn));
    deps.onQueued?.(turn);
    deps.updateStatus();
    deps.dispatchNextQueuedTelegramTurn();
    return turn;
}
export function createTelegramPromptEnqueueController(deps) {
    return {
        enqueue: (messages, ctx, onQueued) => enqueueTelegramPromptTurnRuntime(messages, {
            ...deps,
            prepareTurn: (nextMessages) => deps.prepareTurn(nextMessages, ctx),
            updateStatus: () => deps.updateStatus(ctx),
            dispatchNextQueuedTelegramTurn: () => deps.dispatchNextQueuedTelegramTurn(ctx),
            assertExecutionCurrent: () => deps.assertExecutionCurrent?.(messages),
            onQueued,
        }),
    };
}
export function createTelegramControlQueueController(deps) {
    return {
        enqueue: (item, ctx, onQueued) => {
            deps.appendControlItem(item, ctx);
            onQueued?.(item);
            deps.dispatchNextQueuedTelegramTurn(ctx);
        },
    };
}
// --- Control Runtime ---
function getTelegramQueueErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export async function executeTelegramControlItemRuntime(item, deps) {
    try {
        await item.execute(deps.ctx);
    }
    catch (error) {
        const message = getTelegramQueueErrorMessage(error);
        deps.recordRuntimeEvent?.("control", error, {
            controlType: item.controlType,
            chatId: item.chatId,
            replyToMessageId: item.replyToMessageId,
        });
        await deps.sendTextReply(item.chatId, item.replyToMessageId, `Telegram control action failed: ${message}`, { target: item.target });
    }
    finally {
        deps.onSettled(item);
    }
}
/**
 * Production debounce for deferred queue dispatch; the factory defaults to this
 * so the entrypoint wires ports instead of policy constants.
 */
export const TELEGRAM_DEFERRED_DISPATCH_DELAY_MS = 50;
export function createTelegramDeferredQueueDispatchRuntime(deps = {}) {
    let boundContext;
    let generation = 0;
    const timers = new Set();
    const delayMs = deps.delayMs ?? TELEGRAM_DEFERRED_DISPATCH_DELAY_MS;
    const setTimer = deps.setTimer ??
        ((callback, ms) => setTimeout(callback, ms));
    const clearTimer = deps.clearTimer ??
        ((timer) => clearTimeout(timer));
    const clearTimers = () => {
        for (const timer of timers)
            clearTimer(timer);
        timers.clear();
    };
    return {
        bind: (ctx) => {
            boundContext = ctx;
            generation += 1;
        },
        unbind: () => {
            boundContext = undefined;
            generation += 1;
            clearTimers();
        },
        isBound: () => boundContext !== undefined,
        getGeneration: () => generation,
        isGenerationActive: (expectedGeneration) => boundContext !== undefined && generation === expectedGeneration,
        request: (dispatchNextQueuedTelegramTurn) => {
            if (boundContext === undefined)
                return;
            const scheduledGeneration = generation;
            let timer;
            timer = setTimer(() => {
                timers.delete(timer);
                if (generation !== scheduledGeneration || boundContext === undefined)
                    return;
                try {
                    dispatchNextQueuedTelegramTurn(boundContext);
                }
                catch (error) {
                    try {
                        deps.recordRuntimeEvent?.("dispatch", error, {
                            phase: "deferred-queue-dispatch",
                            generation: scheduledGeneration,
                        });
                    }
                    catch {
                        // Timer diagnostics cannot escape the deferred owner.
                    }
                }
            }, delayMs);
            timer.unref?.();
            timers.add(timer);
        },
    };
}
export function createTelegramQueueDispatchWatchdogRuntime(deps) {
    const intervalMs = deps.intervalMs ?? 1000;
    const setIntervalFn = deps.setInterval ?? ((callback, ms) => setInterval(callback, ms));
    const clearIntervalFn = deps.clearInterval ?? ((timer) => clearInterval(timer));
    let ctx;
    let interval;
    let dispatchInFlight = false;
    const tick = () => {
        if (ctx === undefined || dispatchInFlight || !deps.hasQueuedItems())
            return;
        dispatchInFlight = true;
        try {
            deps.dispatchNextQueuedTelegramTurn(ctx);
        }
        catch (error) {
            try {
                deps.recordRuntimeEvent?.("dispatch", error, {
                    phase: "queue-watchdog",
                });
            }
            catch {
                // Watchdog diagnostics cannot escape the interval owner.
            }
        }
        finally {
            dispatchInFlight = false;
        }
    };
    const stop = () => {
        ctx = undefined;
        if (!interval)
            return;
        clearIntervalFn(interval);
        interval = undefined;
    };
    return {
        start: (nextCtx) => {
            ctx = nextCtx;
            if (!interval) {
                const nextInterval = setIntervalFn(tick, intervalMs);
                interval = nextInterval;
                nextInterval.unref?.();
            }
            tick();
        },
        stop,
        poke: tick,
    };
}
export function executeTelegramQueueDispatchPlan(plan, deps) {
    if (plan.kind === "none") {
        deps.onIdle();
        return;
    }
    if (plan.kind === "control") {
        deps.executeControlItem(plan.item);
        return;
    }
    deps.onPromptDispatchStart(plan.item.chatId);
    try {
        if (deps.commitPromptDispatch && !deps.commitPromptDispatch(plan.item)) {
            throw new Error("Telegram prompt dispatch could not be committed durably.");
        }
        deps.sendUserMessage(plan.item.content);
    }
    catch (error) {
        const message = getTelegramQueueErrorMessage(error);
        deps.onPromptDispatchFailure(message);
    }
}
export function createTelegramQueueDispatchRuntime(deps) {
    return createTelegramQueueDispatchController({
        getQueuedItems: deps.getQueuedItems,
        setQueuedItems: deps.setQueuedItems,
        canDispatch: createTelegramDispatchReadinessChecker({
            isCompactionInProgress: deps.isCompactionInProgress,
            hasActiveTurn: deps.hasActiveTurn,
            hasDispatchPending: deps.hasDispatchPending,
            isIdle: deps.isIdle,
            hasPendingMessages: deps.hasPendingMessages,
        }),
        hasDispatchContext: deps.hasDispatchContext,
        getDispatchGeneration: deps.getDispatchGeneration,
        isDispatchGenerationActive: deps.isDispatchGenerationActive,
        updateStatus: deps.updateStatus,
        sendTextReply: deps.sendTextReply,
        onPromptDispatchStart: deps.onPromptDispatchStart,
        commitPromptDispatch: deps.commitPromptDispatch,
        sendUserMessage: deps.sendUserMessage,
        onPromptDispatchFailure: deps.onPromptDispatchFailure,
        reconcileNextDispatchAnnouncementReplyOwnership: deps.reconcileNextDispatchAnnouncementReplyOwnership,
        isQueueItemTransportActive: deps.isQueueItemTransportActive,
        hasPendingInboundQueueMutationForItem: deps.hasPendingInboundQueueMutationForItem,
        isQueueItemAdmissionReady: deps.isQueueItemAdmissionReady,
        onControlSettled: deps.onControlSettled,
        onPromptSkipped: deps.onPromptSkipped,
        recordRuntimeEvent: deps.recordRuntimeEvent,
    });
}
export function createTelegramQueueDispatchController(deps) {
    let controlDispatchPending = false;
    let nextDispatchAnnouncementRequested = false;
    let nextDispatchAnnouncementGeneration = 0;
    let nextDispatchAnnouncementAnchor;
    const controller = {
        requestNextDispatchAnnouncement: () => {
            nextDispatchAnnouncementGeneration += 1;
            nextDispatchAnnouncementRequested = true;
            nextDispatchAnnouncementAnchor = undefined;
        },
        cancelNextDispatchAnnouncement: () => {
            nextDispatchAnnouncementGeneration += 1;
            nextDispatchAnnouncementRequested = false;
            nextDispatchAnnouncementAnchor = undefined;
        },
        dispatchNext: (ctx) => {
            if (deps.hasDispatchContext && !deps.hasDispatchContext())
                return;
            if (controlDispatchPending) {
                deps.updateStatus(ctx);
                return;
            }
            const queuedItems = deps.getQueuedItems();
            const activeItems = [];
            const protectedInactiveItems = [];
            const retainedItems = [];
            let droppedInactiveItemCount = 0;
            for (const item of queuedItems) {
                if (!deps.isQueueItemTransportActive ||
                    deps.isQueueItemTransportActive(item)) {
                    activeItems.push(item);
                    retainedItems.push(item);
                }
                else if ((item.admissionReceipts?.length ?? 0) > 0) {
                    protectedInactiveItems.push(item);
                    retainedItems.push(item);
                }
                else {
                    droppedInactiveItemCount += 1;
                }
            }
            if (droppedInactiveItemCount > 0) {
                deps.setQueuedItems(retainedItems);
                if (retainedItems.length === 0) {
                    nextDispatchAnnouncementRequested = false;
                    nextDispatchAnnouncementAnchor = undefined;
                }
                deps.recordRuntimeEvent?.("dispatch", new Error("Dropped queue work from an inactive Telegram transport generation."), { phase: "transport-generation" });
            }
            const canDispatch = deps.canDispatch(ctx);
            let nextActiveIndex = 0;
            if (canDispatch) {
                while (nextActiveIndex < activeItems.length) {
                    const candidate = activeItems[nextActiveIndex];
                    if (!candidate ||
                        candidate.kind !== "prompt" ||
                        candidate.reactionSuppressionEmoji === undefined) {
                        break;
                    }
                    if (deps.hasPendingInboundQueueMutationForItem?.(candidate)) {
                        deps.updateStatus(ctx);
                        return;
                    }
                    if (deps.isQueueItemAdmissionReady &&
                        !deps.isQueueItemAdmissionReady(candidate)) {
                        deps.updateStatus(ctx);
                        return;
                    }
                    try {
                        if (deps.onPromptSkipped && !deps.onPromptSkipped(candidate, ctx)) {
                            deps.updateStatus(ctx, "Telegram skipped prompt could not be settled durably.");
                            return;
                        }
                    }
                    catch (error) {
                        deps.recordRuntimeEvent?.("dispatch", error, {
                            phase: "skip-receipt-settlement",
                        });
                        deps.updateStatus(ctx, "Telegram skipped prompt could not be settled durably.");
                        return;
                    }
                    nextActiveIndex += 1;
                    deps.setQueuedItems([
                        ...activeItems.slice(nextActiveIndex),
                        ...protectedInactiveItems,
                    ]);
                }
            }
            const dispatchableItems = activeItems.slice(nextActiveIndex);
            const nextItem = dispatchableItems[0];
            if (nextDispatchAnnouncementRequested) {
                if (nextDispatchAnnouncementAnchor) {
                    const anchorRetained = retainedItems.includes(nextDispatchAnnouncementAnchor);
                    const anchorTransportActive = deps.isQueueItemTransportActive?.(nextDispatchAnnouncementAnchor) !== false;
                    if (!anchorRetained || !anchorTransportActive) {
                        nextDispatchAnnouncementRequested = false;
                        nextDispatchAnnouncementAnchor = undefined;
                    }
                }
                else if (nextItem) {
                    nextDispatchAnnouncementAnchor = nextItem;
                }
                else if (retainedItems.length === 0) {
                    nextDispatchAnnouncementRequested = false;
                }
            }
            if (nextItem &&
                deps.hasPendingInboundQueueMutationForItem?.(nextItem)) {
                deps.updateStatus(ctx);
                return;
            }
            if (nextItem &&
                deps.isQueueItemAdmissionReady &&
                !deps.isQueueItemAdmissionReady(nextItem)) {
                deps.updateStatus(ctx);
                return;
            }
            const dispatchBasisItems = deps.getQueuedItems();
            const dispatchPlan = planNextTelegramQueueAction(dispatchableItems, canDispatch);
            const commitDispatchPlan = () => {
                if (dispatchPlan.kind === "none")
                    return true;
                const currentItems = deps.getQueuedItems();
                if (dispatchPlan.kind === "prompt") {
                    const queueDrifted = currentItems.length !== dispatchBasisItems.length ||
                        currentItems.some((item, index) => item !== dispatchBasisItems[index]);
                    const dispatchEligibilityDrifted = !deps.canDispatch(ctx) ||
                        deps.hasPendingInboundQueueMutationForItem?.(dispatchPlan.item) === true ||
                        (deps.isQueueItemAdmissionReady?.(dispatchPlan.item) === false) ||
                        (deps.isQueueItemTransportActive?.(dispatchPlan.item) === false);
                    if (queueDrifted || dispatchEligibilityDrifted) {
                        const selectedItemRetained = currentItems.includes(dispatchPlan.item);
                        const selectedTransportActive = deps.isQueueItemTransportActive?.(dispatchPlan.item) !== false;
                        nextDispatchAnnouncementRequested =
                            selectedItemRetained && selectedTransportActive;
                        nextDispatchAnnouncementAnchor = nextDispatchAnnouncementRequested
                            ? dispatchPlan.item
                            : undefined;
                        deps.updateStatus(ctx);
                        if (nextDispatchAnnouncementRequested && queueDrifted && !dispatchEligibilityDrifted) {
                            controller.dispatchNext(ctx);
                        }
                        return false;
                    }
                }
                deps.setQueuedItems([
                    ...dispatchPlan.remainingItems,
                    ...protectedInactiveItems,
                ]);
                nextDispatchAnnouncementAnchor = undefined;
                return true;
            };
            const executePlan = () => {
                if (!commitDispatchPlan())
                    return;
                executeTelegramQueueDispatchPlan(dispatchPlan, {
                    executeControlItem: (item) => {
                        controlDispatchPending = true;
                        const dispatchGeneration = deps.getDispatchGeneration?.();
                        deps.updateStatus(ctx);
                        void executeTelegramControlItemRuntime(item, {
                            ctx,
                            sendTextReply: deps.sendTextReply,
                            recordRuntimeEvent: deps.recordRuntimeEvent,
                            onSettled: (settledItem) => {
                                try {
                                    deps.onControlSettled?.(settledItem, ctx);
                                }
                                catch (error) {
                                    deps.recordRuntimeEvent?.("control", error, {
                                        phase: "receipt-settlement",
                                        controlType: settledItem.controlType,
                                    });
                                }
                                controlDispatchPending = false;
                                if (deps.hasDispatchContext && !deps.hasDispatchContext())
                                    return;
                                if (dispatchGeneration !== undefined &&
                                    deps.isDispatchGenerationActive &&
                                    !deps.isDispatchGenerationActive(dispatchGeneration)) {
                                    return;
                                }
                                deps.updateStatus(ctx);
                                controller.dispatchNext(ctx);
                            },
                        });
                    },
                    onPromptDispatchStart: (chatId) => {
                        deps.onPromptDispatchStart(ctx, chatId);
                    },
                    commitPromptDispatch: deps.commitPromptDispatch
                        ? (item) => deps.commitPromptDispatch(item, ctx)
                        : undefined,
                    sendUserMessage: deps.sendUserMessage,
                    onPromptDispatchFailure: (message) => {
                        deps.onPromptDispatchFailure(ctx, message);
                    },
                    onIdle: () => {
                        deps.updateStatus(ctx);
                    },
                });
            };
            if (dispatchPlan.kind === "prompt" && nextDispatchAnnouncementRequested) {
                nextDispatchAnnouncementRequested = false;
                controlDispatchPending = true;
                const announcementGeneration = nextDispatchAnnouncementGeneration;
                const dispatchGeneration = deps.getDispatchGeneration?.();
                deps.updateStatus(ctx);
                void deps.sendTextReply(dispatchPlan.item.chatId, dispatchPlan.item.replyToMessageId, "<b>⏩ Dispatching next queued turn.</b>", { target: dispatchPlan.item.target }).catch((error) => {
                    deps.recordRuntimeEvent?.("dispatch", error, {
                        phase: "next-announcement",
                    });
                }).finally(() => {
                    try {
                        deps.reconcileNextDispatchAnnouncementReplyOwnership?.(dispatchPlan.item);
                    }
                    catch (error) {
                        deps.recordRuntimeEvent?.("dispatch", error, {
                            phase: "next-announcement-reply-ownership",
                        });
                    }
                    controlDispatchPending = false;
                    if (deps.hasDispatchContext && !deps.hasDispatchContext())
                        return;
                    if (dispatchGeneration !== undefined &&
                        deps.isDispatchGenerationActive &&
                        !deps.isDispatchGenerationActive(dispatchGeneration))
                        return;
                    if (announcementGeneration !== nextDispatchAnnouncementGeneration) {
                        if (nextDispatchAnnouncementRequested)
                            controller.dispatchNext(ctx);
                        return;
                    }
                    executePlan();
                });
                return;
            }
            executePlan();
        },
    };
    return controller;
}
