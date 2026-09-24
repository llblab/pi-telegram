/**
 * Telegram inbound routing composition
 * Zones: telegram inbound, orchestration, queue/menu/command composition
 * Wires authorized updates into menus, commands, media grouping, and prompt queueing, and owns exact assistant-output target/route authority capture
 */
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import * as Bus from "./bus.js";
import * as Commands from "./commands.js";
import * as Media from "./media.js";
import * as Menu from "./menu.js";
import * as OutboundHandlers from "./outbound.js";
import * as PromptTemplates from "./prompt-templates.js";
import * as Queue from "./queue.js";
import * as Replies from "./replies.js";
import * as TextGroups from "./text-groups.js";
import * as ThreadNaming from "./thread-naming.js";
import * as ThreadReconciler from "./thread-reconciler.js";
import * as Turns from "./turns.js";
function formatTelegramPromptPeer(peer) {
    if (!peer)
        return undefined;
    if (typeof peer.username === "string" && peer.username.length > 0) {
        return peer.username;
    }
    const displayName = [peer.first_name, peer.last_name]
        .filter((part) => typeof part === "string" && part.length > 0)
        .join(" ");
    if (displayName)
        return displayName;
    if (typeof peer.title === "string" && peer.title.length > 0) {
        return peer.title;
    }
    return typeof peer.id === "number" ? String(peer.id) : undefined;
}
function isTelegramPromptOwnerPeer(peer, ownerUserId) {
    return ownerUserId !== undefined && peer?.id === ownerUserId;
}
function isTelegramPromptBotPeer(peer) {
    return peer?.is_bot === true;
}
export function resolveTelegramGuestPromptPeer(input) {
    if (input.chatType !== "private") {
        return formatTelegramPromptPeer(input.chat);
    }
    if (!isTelegramPromptOwnerPeer(input.from, input.ownerUserId) &&
        !isTelegramPromptBotPeer(input.from)) {
        return formatTelegramPromptPeer(input.from);
    }
    for (const candidate of [
        input.chat,
        input.guestBotCallerUser,
        input.guestBotCallerChat,
        input.replyFrom,
    ]) {
        if (isTelegramPromptOwnerPeer(candidate, input.ownerUserId) ||
            isTelegramPromptBotPeer(candidate)) {
            continue;
        }
        const peer = formatTelegramPromptPeer(candidate);
        if (peer)
            return peer;
    }
    return undefined;
}
function appendTelegramSourceAttachmentSection(text, from, files, outputs = []) {
    if (files.length === 0 && outputs.length === 0)
        return text;
    const dirs = [...new Set(files.map((file) => dirname(file.path)))];
    const sameDir = dirs.length === 1;
    const source = from ? `|from:${from}` : "";
    const header = sameDir
        ? `[attachments${source}] ${dirs[0]}`
        : `[attachments${source}]`;
    const items = sameDir
        ? files.map((file) => `/${basename(file.path)}`)
        : files.map((file) => file.path);
    const sections = text ? [text] : [];
    if (items.length > 0) {
        sections.push(`${header}\n${items.map((item) => `- ${item}`).join("\n")}`);
    }
    if (outputs.length > 0) {
        const outputHeader = `[outputs${source}]`;
        sections.push(`${outputHeader}\n${outputs.map((output) => `- ${output}`).join("\n")}`);
    }
    return sections.join("\n\n");
}
function getContextCwd(ctx) {
    if (!ctx || typeof ctx !== "object")
        return undefined;
    const cwd = ctx.cwd;
    return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}
function getLeaderTopicProfileKey(ctx, instanceId) {
    const cwd = getContextCwd(ctx);
    if (cwd)
        return `cwd:${cwd}`;
    return instanceId ? `leader:${instanceId}` : undefined;
}
function isCurrentLeaderTopicRecord(record, profileKey, instanceId) {
    if (instanceId && record.instanceId === instanceId)
        return true;
    return !!profileKey && record.profileKey === profileKey;
}
function hasActiveLeaderTopic(records, profileKey, instanceId) {
    return records.some((record) => {
        if (record.status !== "active")
            return false;
        return isCurrentLeaderTopicRecord(record, profileKey, instanceId);
    });
}
function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}
const TELEGRAM_UNBOUND_REROUTE_CALLBACK_PREFIX = "reroute:";
const TELEGRAM_UNBOUND_REROUTE_RESTORE_MENU_CALLBACK_PREFIX = "rerouterestore:";
const TELEGRAM_UNBOUND_REROUTE_NEW_SLOT_CALLBACK_PREFIX = "reroutenew:";
const TELEGRAM_SLOT_CAPACITY_MESSAGE = "No Telegram instance slot is available. Automatic reclamation is disabled for safety.";
function formatTelegramUnboundRerouteCallbackData(rerouteId, threadId) {
    return `${TELEGRAM_UNBOUND_REROUTE_CALLBACK_PREFIX}${rerouteId}:${threadId}`;
}
function formatTelegramUnboundRerouteRestoreMenuCallbackData(rerouteId) {
    return `${TELEGRAM_UNBOUND_REROUTE_RESTORE_MENU_CALLBACK_PREFIX}${rerouteId}`;
}
function formatTelegramUnboundRerouteNewSlotCallbackData(rerouteId, threadId) {
    return `${TELEGRAM_UNBOUND_REROUTE_NEW_SLOT_CALLBACK_PREFIX}${rerouteId}:${threadId}`;
}
function parseTelegramUnboundRerouteRestoreMenuCallbackData(data) {
    const match = data?.match(/^rerouterestore:([a-z0-9]+)$/);
    const rerouteId = match?.[1];
    return rerouteId ? { rerouteId } : undefined;
}
function parseTelegramUnboundRerouteCallbackData(data) {
    const match = data?.match(/^(reroute|reroutenew):([a-z0-9]+):(\d+)$/);
    const prefix = match?.[1];
    const rerouteId = match?.[2];
    const threadId = Number(match?.[3]);
    if (!prefix || !rerouteId || !Number.isSafeInteger(threadId))
        return undefined;
    return { rerouteId, threadId, useNewSlot: prefix === "reroutenew" };
}
function getTelegramThreadRecordLabel(record, getDisplayTitle) {
    return getDisplayTitle?.(record.target) ?? getRestoredThreadName(record, record.slot ?? "");
}
function getNextTelegramSlotPreference(slot) {
    if (!slot || !/^[A-Z]$/.test(slot))
        return undefined;
    const index = slot.charCodeAt(0) - "A".charCodeAt(0);
    return String.fromCharCode("A".charCodeAt(0) + ((index + 1) % 26));
}
function getRestoredThreadName(record, slot) {
    return record.threadName &&
        Threads.isTelegramTopicThreadNameValidForSlot(record.threadName, slot)
        ? record.threadName
        : (Threads.chooseTelegramThreadName({ slot }) ?? "Pi");
}
function isTelegramLiveThreadTarget(record, liveTargets) {
    if (!liveTargets)
        return record.status === "active";
    return liveTargets.some((target) => target.chatId === record.target.chatId &&
        target.threadId === record.target.threadId);
}
function getTelegramRoutableThreadRecords(records, liveTargets) {
    return records.filter((record) => record.status === "active" &&
        isTelegramLiveThreadTarget(record, liveTargets));
}
function formatTelegramAllTabMenuChooserText(command) {
    return [
        "<b>🧵 Choose target thread:</b>",
        "",
        `You used <code>/${escapeHtml(command)}</code> from the <b>All</b> tab.`,
        "Select the Pi thread that should handle it:",
        "To restore into a new thread, send a plain message in that destination thread first.",
    ].join("\n");
}
function buildTelegramUnboundRerouteChooserMarkup(rerouteId, records, options) {
    const activeRecords = records.filter((record) => record.status === "active");
    const canRestoreAnyLiveThread = options.canRestore && activeRecords.length > 0;
    const rows = activeRecords.map((record) => [
        {
            text: `↪️ ${getTelegramThreadRecordLabel(record, options.getDisplayTitle)}`,
            callback_data: formatTelegramUnboundRerouteCallbackData(rerouteId, record.target.threadId),
        },
    ]);
    return {
        inline_keyboard: canRestoreAnyLiveThread
            ? [
                ...rows,
                [
                    {
                        text: "🔁 Replace/restore thread…",
                        callback_data: formatTelegramUnboundRerouteRestoreMenuCallbackData(rerouteId),
                    },
                ],
            ]
            : rows,
    };
}
function buildTelegramUnboundRerouteRestoreChooserMarkup(rerouteId, records, getDisplayTitle) {
    return {
        inline_keyboard: records
            .filter((record) => record.status === "active")
            .map((record) => [
            {
                text: `➡️ ${getTelegramThreadRecordLabel(record, getDisplayTitle)}`,
                callback_data: formatTelegramUnboundRerouteNewSlotCallbackData(rerouteId, record.target.threadId),
            },
        ]),
    };
}
function formatTelegramUnboundRerouteRestoreChooserText() {
    return [
        "<b>🧵 Replace/restore Telegram thread:</b>",
        "",
        "Choose the Pi instance to move to this new Telegram thread:",
    ].join("\n");
}
function formatTelegramUnboundTopicGuidance() {
    return [
        "<b>⚠️ New thread is not a Pi instance.</b>",
        "",
        "To create a bound Telegram tab:",
        "<code>1.</code> Start another Pi instance in your terminal.",
        "<code>2.</code> Run <code>/telegram-connect</code> in that instance.",
        "<code>3.</code> The bridge will create and bind a fresh Telegram tab for it.",
    ].join("\n");
}
function formatTelegramTargetKey(target) {
    return `${target.chatId}:${target.threadId ?? "all"}`;
}
function formatTelegramUnboundRerouteChooserText(_records, options = {}) {
    const rerouteText = [
        "<b>🧵 Choose target thread:</b>",
        "",
        "Your message is still in this Telegram thread.",
        "Select the Pi thread that should handle it:",
    ].join("\n");
    return options.includeGuidance === false
        ? rerouteText
        : [formatTelegramUnboundTopicGuidance(), "", rerouteText].join("\n");
}
import * as Threads from "./threads.js";
import * as Updates from "./updates.js";
import { getTelegramVoiceReplyMode } from "./voice.js";
async function deleteReservedTelegramTopicThroughReconciler(deps, target, messageId) {
    if (!deps.threadStore)
        return false;
    const nowMs = Date.now();
    const currentLeaderEpoch = deps.getCurrentLeaderEpoch?.();
    const plan = ThreadReconciler.planThreadReconciliation({
        nowMs,
        currentLeaderEpoch,
        previousState: deps.getThreadReconciliationMachineState?.(),
        records: deps.threadStore.list(),
        reservations: deps.threadStore.listReservations(),
        observations: deps.threadStore.listSyncObservations(),
        reservedMessages: [
            {
                target,
                observedAtMs: nowMs,
                messageId,
                ...(currentLeaderEpoch !== undefined
                    ? { leaderEpoch: currentLeaderEpoch }
                    : {}),
            },
        ],
    });
    deps.recordThreadReconciliationPlan?.(plan);
    await ThreadReconciler.applyThreadReconciliationPlan(plan, {
        isCleanupTargetProtected: Threads.createTelegramCleanupTargetProtection(deps.threadStore),
        callApi: deps.callApi,
        markStaleByTarget: (staleTarget, syncStatus, lastSyncError) => deps.threadStore?.markStaleByTarget(staleTarget, syncStatus, lastSyncError) ?? false,
        persist: () => deps.threadStore?.persist() ?? Promise.resolve(),
        getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
        recordRuntimeEvent: deps.recordRuntimeEvent,
    });
    return plan.actions.some((action) => action.kind === "close-delete-reserved-topic");
}
export const TELEGRAM_ALL_TAB_COMMAND_MAX_AGE_MS = 60 * 60_000;
export function isTelegramAllTabCommandExpired(message, nowMs = Date.now()) {
    return message.message_thread_id === undefined &&
        typeof message.date === "number" && Number.isFinite(message.date) &&
        message.date > 0 && Number.isFinite(nowMs) &&
        nowMs - message.date * 1000 >= TELEGRAM_ALL_TAB_COMMAND_MAX_AGE_MS;
}
export function createTelegramInboundBusProjectionRuntime(deps) {
    return {
        getTargetOwnership(target) {
            return Bus.getTelegramFollowerTargetOwnership({
                target,
                followers: deps.listFollowers(),
                activeThreadRecords: deps.listThreadRecords(),
                currentInstanceId: deps.instanceId,
            });
        },
        getLiveThreadTargets() {
            return Bus.listTelegramBusLiveThreadTargets({
                leaderTarget: deps.getLeaderTarget(),
                followers: deps.listFollowers(),
            });
        },
        getLocalThreadLabelForTarget(target) {
            const followerTarget = deps.getFollowerTarget();
            const leaderTarget = deps.getLeaderTarget();
            const isLocalFollowerTarget = deps.isFollowerRegistered() &&
                followerTarget?.chatId === target.chatId &&
                followerTarget.threadId === target.threadId;
            const isLocalLeaderTarget = leaderTarget?.chatId === target.chatId &&
                leaderTarget.threadId === target.threadId;
            if (!isLocalFollowerTarget && !isLocalLeaderTarget)
                return undefined;
            return deps.getCurrentIdentity(target).threadName;
        },
    };
}
const TELEGRAM_OWNED_CALLBACK_PREFIXES = [
    "allmenu:",
    TELEGRAM_UNBOUND_REROUTE_CALLBACK_PREFIX,
    "compact:",
    "menu:",
    "model:",
    "new:",
    "queue:",
    "section:",
    "settings:",
    "status:",
    "tgbtn:",
    "thinking:",
];
function isTelegramOwnedCallbackData(data) {
    return TELEGRAM_OWNED_CALLBACK_PREFIXES.some((prefix) => data.startsWith(prefix));
}
export function createTelegramInboundRouteRuntime(deps) {
    const pendingUnboundReroutes = new Map();
    const guidedUnboundTopicKeys = new Set();
    let nextUnboundRerouteId = 0;
    const requestDispatchNextQueuedTelegramTurn = (ctx) => {
        deps.dispatchNextQueuedTelegramTurn(ctx);
        if (deps.requestDeferredDispatchNextQueuedTelegramTurn &&
            deps.hasDeferredDispatchContext?.() !== false) {
            deps.requestDeferredDispatchNextQueuedTelegramTurn(deps.dispatchNextQueuedTelegramTurn);
        }
    };
    const resolveTelegramThreadLabel = (message) => {
        const chatId = message.chat.id;
        const threadId = message.message_thread_id;
        if (!threadId)
            return undefined;
        const localLabel = deps.getDisplayTitle?.({ chatId, threadId }) ??
            deps.getLocalThreadLabelForTarget?.({ chatId, threadId });
        if (localLabel)
            return localLabel;
        if (!deps.threadStore)
            return undefined;
        const records = deps.threadStore.list();
        const currentInstanceId = deps.getCurrentInstanceId?.();
        for (const record of records) {
            if (record.target.chatId !== chatId ||
                record.target.threadId !== threadId) {
                continue;
            }
            if (currentInstanceId &&
                record.instanceId &&
                record.instanceId !== currentInstanceId) {
                continue;
            }
            return record.threadName &&
                Threads.isTelegramTopicThreadNameValidForSlot(record.threadName, record.slot)
                ? record.threadName
                : getRestoredThreadName(record, record.slot ?? "");
        }
        return undefined;
    };
    const createAdmissionReceipts = (queueKind, sources) => {
        const sourceUpdateIds = Updates.collectTelegramAdmissionSourceUpdateIds(sources);
        if (sourceUpdateIds.length === 0)
            return [];
        const receipt = Queue.createTelegramQueueAdmissionReceipt({
            queueKind,
            scope: deps.getAdmissionScope?.() ?? "",
            sourceUpdateIds,
        });
        const journalBindingKey = deps.getAdmissionJournalBinding?.();
        return receipt
            ? [{
                    ...receipt,
                    ...(journalBindingKey ? { journalBindingKey } : {}),
                }]
            : [];
    };
    const reportQueueAdmission = (sources, receipts) => {
        Updates.reportTelegramQueueAdmission(sources, receipts);
    };
    const removePendingReroute = (id) => {
        pendingUnboundReroutes.get(id)?.stopExpiry?.();
        pendingUnboundReroutes.delete(id);
    };
    const expirePendingCommand = (id, pending) => {
        if (pending.destinationSelected || pending.expiresAtMs === undefined ||
            Date.now() < pending.expiresAtMs)
            return false;
        if (pendingUnboundReroutes.get(id) !== pending)
            return true;
        for (const message of pending.messages)
            Updates.reportTelegramUpdateCompleted(message);
        removePendingReroute(id);
        return true;
    };
    const armPendingCommandExpiry = (id, pending) => {
        if (pending.dispatchKind !== "command" || pending.sourceTarget.threadId !== undefined)
            return;
        pending.stopExpiry?.();
        const execution = Updates.getTelegramUpdateExecutionFence(pending.messages[0]);
        const onAbort = () => removePendingReroute(id);
        let timer;
        let stopped = false;
        pending.pauseExpiry = () => {
            if (timer !== undefined)
                clearTimeout(timer);
            timer = undefined;
        };
        pending.stopExpiry = () => {
            stopped = true;
            pending.pauseExpiry?.();
            execution?.signal.removeEventListener("abort", onAbort);
        };
        execution?.signal.addEventListener("abort", onAbort, { once: true });
        if (execution?.signal.aborted) {
            onAbort();
            return;
        }
        if (pending.expiresAtMs === undefined) {
            const date = pending.messages[0]?.date;
            if (typeof date !== "number" || !Number.isFinite(date) || date <= 0 || date * 1000 > Date.now())
                return;
            pending.expiresAtMs = date * 1000 + TELEGRAM_ALL_TAB_COMMAND_MAX_AGE_MS;
        }
        const schedule = () => {
            if (stopped || pending.destinationSelected || pendingUnboundReroutes.get(id) !== pending)
                return;
            if (expirePendingCommand(id, pending))
                return;
            const delay = Math.min(TELEGRAM_ALL_TAB_COMMAND_MAX_AGE_MS, pending.expiresAtMs - Date.now());
            timer = setTimeout(schedule, Math.max(1, delay));
            timer.unref?.();
        };
        schedule();
    };
    const prunePendingUnboundReroutes = () => {
        const nowMs = Date.now();
        for (const [id, entry] of pendingUnboundReroutes) {
            if (entry.dispatchKind === "command" && entry.sourceTarget.threadId === undefined) {
                expirePendingCommand(id, entry);
            }
            else if (nowMs - entry.createdAtMs > 30 * 60_000) {
                removePendingReroute(id);
            }
        }
    };
    const storePendingUnboundReroute = (messages, dispatchKind = "prompt") => {
        prunePendingUnboundReroutes();
        if (pendingUnboundReroutes.size >= 100) {
            throw new Error("Telegram route chooser capacity reached; source remains retryable.");
        }
        nextUnboundRerouteId += 1;
        const id = nextUnboundRerouteId.toString(36);
        pendingUnboundReroutes.set(id, {
            sourceTarget: {
                chatId: messages[0].chat.id,
                ...(typeof messages[0].message_thread_id === "number"
                    ? { threadId: messages[0].message_thread_id }
                    : {}),
            },
            messages,
            createdAtMs: Date.now(),
            dispatchKind,
        });
        const pending = pendingUnboundReroutes.get(id);
        armPendingCommandExpiry(id, pending);
        return id;
    };
    const rememberRerouteChooser = (id, messageId) => {
        const pending = pendingUnboundReroutes.get(id);
        if (!pending)
            return;
        pending.chooserMessageId = messageId;
        if (messageId === undefined || pending.dispatchKind !== "command" ||
            pending.sourceTarget.threadId !== undefined || pending.selectionAttempted)
            return;
        const source = pending.messages[0];
        const text = source?.text?.trim();
        const execution = Updates.getTelegramUpdateExecutionFence(source);
        const sourceIds = Updates.collectTelegramAdmissionSourceUpdateIds(pending.messages);
        if (!text || Commands.parseTelegramCommand(text)?.name !== "start" ||
            source?.from?.id === undefined || !execution?.isCurrent() || sourceIds.length !== 1 ||
            expirePendingCommand(id, pending))
            return;
        for (const [oldId, old] of pendingUnboundReroutes) {
            if (oldId === id || old.dispatchKind !== "command" || old.selectionAttempted || old.dispatching ||
                old.sourceTarget.threadId !== undefined || old.sourceTarget.chatId !== pending.sourceTarget.chatId)
                continue;
            const oldSource = old.messages[0];
            const oldIds = Updates.collectTelegramAdmissionSourceUpdateIds(old.messages);
            if (oldSource?.from?.id !== source.from.id || oldSource?.text?.trim() !== text ||
                oldIds.length !== 1 || oldIds[0] >= sourceIds[0] ||
                Updates.getTelegramUpdateExecutionFence(oldSource)?.signal !== execution.signal)
                continue;
            if (Updates.reportTelegramUpdateCompleted(oldSource))
                removePendingReroute(oldId);
        }
    };
    const matchesRerouteChooser = (pending, query) => {
        const message = query.message;
        return !!message && pending.chooserMessageId !== undefined &&
            message.message_id === pending.chooserMessageId &&
            message.chat.id === pending.sourceTarget.chatId &&
            (message.message_thread_id === undefined ||
                message.message_thread_id === pending.sourceTarget.threadId);
    };
    const pendingUnboundRerouteMediaGroups = new Map();
    const threadNameDialog = ThreadNaming.createTelegramThreadNameDialogRuntime();
    const getThreadNameDialogScope = () => deps.getCurrentInstanceId?.() ?? "local";
    const menuCallbackHandler = Menu.createTelegramMenuCallbackHandlerForContext({
        getStoredModelMenuState: deps.modelMenuRuntime.getState,
        getActiveModel: deps.currentModelRuntime.get,
        getThinkingLevel: deps.getThinkingLevel,
        setThinkingLevel: deps.setThinkingLevel,
        updateStatus: deps.updateStatus,
        updateModelMenuMessage: deps.menuActions.updateModelMenuMessage,
        updateThinkingMenuMessage: deps.menuActions.updateThinkingMenuMessage,
        updateStatusMessage: deps.menuActions.updateStatusMessage,
        updateSettingsMenuMessage: deps.updateSettingsMenuMessage,
        answerCallbackQuery: deps.answerCallbackQuery,
        isIdle: deps.isIdle,
        hasAbortHandler: deps.bridgeRuntime.abort.hasHandler,
        getActiveToolExecutions: deps.bridgeRuntime.lifecycle.getActiveToolExecutions,
        persistScopedModelPatterns: deps.persistScopedModelPatterns,
        setModel: deps.setModel,
        setCurrentModel: deps.currentModelRuntime.setCurrentModel,
        stagePendingModelSwitch: deps.modelSwitchController.stagePendingSwitch,
        restartInterruptedTelegramTurn: deps.modelSwitchController.restartInterruptedTurn,
        sectionRegistry: deps.sectionRegistry,
        editInteractiveMessage: deps.editInteractiveMessage,
        sendInteractiveMessage: deps.sendInteractiveMessage,
        sendSectionRichMessage: deps.sendSectionRichMessage,
        deleteMessage: deps.deleteMessage,
        enqueueSectionPrompt: async (prompt, ctx, target, source) => {
            const chatId = target?.chatId ?? deps.configStore.getAllowedUserId();
            if (typeof chatId !== "number")
                return;
            const order = deps.bridgeRuntime.queue.allocateItemOrder();
            const admissionReceipts = createAdmissionReceipts("prompt", source === undefined ? [] : [source]);
            const turn = {
                kind: "prompt",
                chatId,
                ...(target ? { target } : {}),
                replyToMessageId: 0,
                sourceMessageIds: [],
                queueOrder: order,
                queueLane: "default",
                laneOrder: order,
                queuedAttachments: [],
                content: [
                    {
                        type: "text",
                        text: `[telegram] ${prompt}`,
                    },
                ],
                historyText: Turns.truncateTelegramQueueSummary(prompt),
                statusSummary: Turns.truncateTelegramQueueSummary(prompt),
                ...(admissionReceipts.length > 0 ? { admissionReceipts } : {}),
            };
            deps.queueMutationRuntime.append(turn, ctx);
            reportQueueAdmission(source === undefined ? [] : [source], admissionReceipts);
            deps.updateStatus(ctx);
            requestDispatchNextQueuedTelegramTurn(ctx);
        },
    });
    const cloneTelegramMessagesForThread = (messages, threadId) => {
        return messages.map((message) => Updates.carryTelegramUpdateExecutionFence(message, {
            ...message,
            message_id: 0,
            message_thread_id: threadId,
            reply_to_message: undefined,
        }));
    };
    const applyThreadCleanupPlan = async (plan, assertExecutionCurrent) => {
        assertExecutionCurrent?.();
        deps.recordThreadReconciliationPlan?.(plan);
        const result = await ThreadReconciler.applyThreadReconciliationPlan(plan, {
            isCleanupTargetProtected(target) {
                assertExecutionCurrent?.();
                return isRerouteTargetProtected(target);
            },
            callApi: deps.callApi,
            markStaleByTarget: (staleTarget, syncStatus, lastSyncError) => deps.threadStore?.markStaleByTarget(staleTarget, syncStatus, lastSyncError) ?? false,
            persist: () => deps.threadStore?.persist() ?? Promise.resolve(),
            removePendingProvisionById: (id) => deps.threadStore?.removePendingProvision(id) ?? false,
            getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
            recordRuntimeEvent: deps.recordRuntimeEvent,
        });
        assertExecutionCurrent?.();
        return (result.incompleteActions?.length ?? 0) === 0;
    };
    const isRerouteTargetProtected = (target) => {
        const matches = (candidate) => candidate.chatId === target.chatId && candidate.threadId === target.threadId;
        return (deps.getLiveThreadTargets?.() ?? []).some(matches) ||
            (deps.threadStore?.list() ?? []).some((record) => matches(record.target)) ||
            (deps.threadStore?.listReservations() ?? []).some((record) => matches(record.target)) ||
            (deps.threadStore?.listPendingProvisions() ?? []).some((record) => !!record.target && matches(record.target));
    };
    const dismissRerouteChooserMessage = async (query, assertExecutionCurrent) => {
        const chatId = query.message?.chat?.id;
        const messageId = query.message?.message_id;
        if (typeof chatId !== "number" ||
            typeof messageId !== "number" ||
            !deps.deleteMessage) {
            return false;
        }
        try {
            assertExecutionCurrent?.();
            await deps.deleteMessage(chatId, messageId);
            assertExecutionCurrent?.();
            return true;
        }
        catch (error) {
            assertExecutionCurrent?.();
            deps.recordRuntimeEvent?.("telegram", error, {
                phase: "reroute-chooser-delete",
                chatId,
                messageId,
                threadId: query.message?.message_thread_id,
            });
            return false;
        }
    };
    const closeReroutedUnboundTopic = async (target, messageId, assertExecutionCurrent) => {
        if (!target || !deps.threadStore)
            return true;
        const nowMs = Date.now();
        const currentLeaderEpoch = deps.getCurrentLeaderEpoch?.();
        const plan = ThreadReconciler.planThreadReconciliation({
            nowMs,
            currentLeaderEpoch,
            previousState: deps.getThreadReconciliationMachineState?.(),
            records: deps.threadStore.list(),
            reservations: deps.threadStore.listReservations(),
            pendingProvisions: deps.threadStore.listPendingProvisions(),
            unboundMessages: [
                {
                    target,
                    observedAtMs: nowMs,
                    ...(typeof messageId === "number" ? { messageId } : {}),
                    ...(currentLeaderEpoch !== undefined
                        ? { leaderEpoch: currentLeaderEpoch }
                        : {}),
                },
            ],
        });
        return applyThreadCleanupPlan(plan, assertExecutionCurrent);
    };
    const closePreviousLeaderThread = async (target, assertExecutionCurrent) => {
        if (!target || !deps.threadStore)
            return true;
        const currentLeaderEpoch = deps.getCurrentLeaderEpoch?.();
        return applyThreadCleanupPlan({
            actions: [
                {
                    kind: "close-delete-previous-leader-topic",
                    target,
                    reason: "previous-leader",
                    instanceId: deps.getCurrentInstanceId?.(),
                    ...(currentLeaderEpoch !== undefined
                        ? { leaderEpoch: currentLeaderEpoch }
                        : {}),
                },
            ],
        }, assertExecutionCurrent);
    };
    const closeReplacedFollowerThread = async (target, instanceId, assertExecutionCurrent) => {
        if (!target || !deps.threadStore)
            return true;
        const currentLeaderEpoch = deps.getCurrentLeaderEpoch?.();
        return applyThreadCleanupPlan({
            actions: [
                {
                    kind: "close-delete-replaced-follower-topic",
                    target,
                    reason: "replaced-follower",
                    instanceId,
                    ...(currentLeaderEpoch !== undefined
                        ? { leaderEpoch: currentLeaderEpoch }
                        : {}),
                },
            ],
        }, assertExecutionCurrent);
    };
    const retryPendingRerouteCleanup = async (cleanup, assertExecutionCurrent) => {
        if (cleanup.kind === "unbound") {
            return closeReroutedUnboundTopic(cleanup.target, cleanup.messageId, assertExecutionCurrent);
        }
        if (cleanup.kind === "previous-leader") {
            return closePreviousLeaderThread(cleanup.target, assertExecutionCurrent);
        }
        return closeReplacedFollowerThread(cleanup.target, cleanup.instanceId, assertExecutionCurrent);
    };
    let dispatchReroutedCommandMessages;
    const dispatchPendingRerouteMessages = async (pending, messages, ctx) => {
        if (pending.dispatchKind === "command" && dispatchReroutedCommandMessages) {
            await dispatchReroutedCommandMessages(messages, ctx);
            if (pending.sourceTarget.threadId === undefined) {
                for (const message of messages)
                    Updates.reportTelegramUpdateCompleted(message);
            }
            return;
        }
        await promptEnqueue(messages, ctx);
    };
    const finalizePendingReroute = async (rerouteId, pending, query, successMessage, assertExecutionCurrent = Updates.createTelegramUpdateExecutionFenceGuard(query)) => {
        assertExecutionCurrent();
        const dismissed = await dismissRerouteChooserMessage(query, assertExecutionCurrent);
        assertExecutionCurrent();
        if (dismissed) {
            removePendingReroute(rerouteId);
            await deps.answerCallbackQuery(query.id, successMessage);
            return;
        }
        pending.finalizeMessage = successMessage;
        await deps.answerCallbackQuery(query.id, `${successMessage} Chooser cleanup is still pending. Try again.`);
    };
    const forwardPendingRerouteMessages = async (pending, instanceId, threadId, ctx, assertExecutionCurrent) => {
        assertExecutionCurrent?.();
        const forwardMessage = deps.foreignOwnedUpdateForwarder?.forwardMessage;
        if (!forwardMessage)
            return false;
        const messages = cloneTelegramMessagesForThread(pending.messages, threadId);
        const outcomes = await Promise.allSettled(messages.map((message) => forwardMessage({
            message,
            ownership: { instanceId },
            ctx,
        })));
        assertExecutionCurrent?.();
        pending.messages = pending.messages.filter((_, index) => {
            const outcome = outcomes[index];
            if (outcome?.status === "fulfilled" &&
                outcome.value.status === "accepted") {
                if (pending.dispatchKind === "command" && pending.sourceTarget.threadId === undefined) {
                    Updates.reportTelegramUpdateCompleted(pending.messages[index]);
                }
                return false;
            }
            if (outcome?.status === "rejected") {
                deps.recordRuntimeEvent?.("bus", outcome.reason, {
                    phase: "reroute-foreign-forward",
                    instanceId,
                    threadId,
                    messageIndex: index,
                });
            }
            return true;
        });
        return pending.messages.length === 0;
    };
    const handleUnboundRerouteRestoreMenuCallback = async (query, _ctx) => {
        const parsed = parseTelegramUnboundRerouteRestoreMenuCallbackData(query.data);
        if (!parsed)
            return false;
        const assertExecutionCurrent = Updates.createTelegramUpdateExecutionFenceGuard(query);
        assertExecutionCurrent();
        const chatId = query.message?.chat?.id;
        const messageId = query.message?.message_id;
        const pending = pendingUnboundReroutes.get(parsed.rerouteId);
        if (typeof chatId !== "number" ||
            typeof messageId !== "number" ||
            !deps.threadStore ||
            !pending ||
            !matchesRerouteChooser(pending, query) ||
            expirePendingCommand(parsed.rerouteId, pending)) {
            await deps.answerCallbackQuery(query.id, "Message route expired.");
            return true;
        }
        if (pending.sourceTarget.threadId === undefined) {
            await deps.answerCallbackQuery(query.id, "Restore needs a destination thread. Send a plain message in a new Telegram thread first.");
            return true;
        }
        await deps.threadStore.load();
        assertExecutionCurrent();
        const activeRecords = getTelegramRoutableThreadRecords(deps.threadStore.list(), deps.getLiveThreadTargets?.());
        const replyMarkup = buildTelegramUnboundRerouteRestoreChooserMarkup(parsed.rerouteId, activeRecords, deps.getDisplayTitle);
        if (deps.editInteractiveMessage) {
            await deps.editInteractiveMessage(chatId, messageId, formatTelegramUnboundRerouteRestoreChooserText(), "html", replyMarkup);
        }
        else if (deps.sendInteractiveMessage) {
            const chooserId = await deps.sendInteractiveMessage(chatId, formatTelegramUnboundRerouteRestoreChooserText(), "html", replyMarkup, { target: pending.sourceTarget, replyToMessageId: messageId });
            assertExecutionCurrent();
            rememberRerouteChooser(parsed.rerouteId, chooserId);
        }
        assertExecutionCurrent();
        await deps.answerCallbackQuery(query.id, "Choose instance to restore.");
        return true;
    };
    const executeUnboundRerouteCallbackOperation = async (query, ctx) => {
        const parsed = parseTelegramUnboundRerouteCallbackData(query.data);
        if (!parsed)
            return false;
        const assertExecutionCurrent = Updates.createTelegramUpdateExecutionFenceGuard(query);
        assertExecutionCurrent();
        const chatId = query.message?.chat?.id;
        const pending = pendingUnboundReroutes.get(parsed.rerouteId);
        if (typeof chatId !== "number" || !deps.threadStore || !pending ||
            !matchesRerouteChooser(pending, query) || expirePendingCommand(parsed.rerouteId, pending)) {
            await deps.answerCallbackQuery(query.id, "Message route expired.");
            return true;
        }
        await deps.threadStore.load();
        assertExecutionCurrent();
        if (pendingUnboundReroutes.get(parsed.rerouteId) !== pending ||
            expirePendingCommand(parsed.rerouteId, pending)) {
            await deps.answerCallbackQuery(query.id, "Message route expired.");
            return true;
        }
        if (pending.finalizeMessage) {
            await finalizePendingReroute(parsed.rerouteId, pending, query, pending.finalizeMessage, assertExecutionCurrent);
            return true;
        }
        if (pending.foreignRetry) {
            const retry = pending.foreignRetry;
            const allForwarded = await forwardPendingRerouteMessages(pending, retry.instanceId, retry.threadId, ctx, assertExecutionCurrent);
            if (!allForwarded) {
                await deps.answerCallbackQuery(query.id, "Target thread is unavailable; retrying will send only remaining messages.");
                return true;
            }
            pending.foreignRetry = undefined;
            if (retry.cleanup)
                pending.cleanup = retry.cleanup;
        }
        if (pending.cleanup) {
            const cleanupComplete = await retryPendingRerouteCleanup(pending.cleanup, assertExecutionCurrent);
            if (!cleanupComplete) {
                await deps.answerCallbackQuery(query.id, "Message routed, but thread cleanup is still pending. Try again.");
                return true;
            }
            pending.cleanup = undefined;
            await finalizePendingReroute(parsed.rerouteId, pending, query, "Thread cleanup completed.", assertExecutionCurrent);
            return true;
        }
        const record = getTelegramRoutableThreadRecords(deps.threadStore.list(), deps.getLiveThreadTargets?.()).find((candidate) => candidate.target.chatId === chatId &&
            candidate.target.threadId === parsed.threadId);
        if (!record) {
            await deps.answerCallbackQuery(query.id, "Thread is not active yet.");
            return true;
        }
        const reroutedMessages = cloneTelegramMessagesForThread(pending.messages, parsed.threadId);
        const sourceTarget = typeof pending.sourceTarget.threadId === "number"
            ? { chatId, threadId: pending.sourceTarget.threadId }
            : undefined;
        const sourceMessageId = pending.chooserMessageId;
        if (parsed.useNewSlot && !sourceTarget) {
            await deps.answerCallbackQuery(query.id, "Restore needs a destination thread. Send a plain message in a new Telegram thread first.");
            return true;
        }
        if (parsed.useNewSlot && sourceTarget && record.target.chatId === sourceTarget.chatId &&
            record.target.threadId === sourceTarget.threadId) {
            await deps.answerCallbackQuery(query.id, "🚫 Selected thread is already the destination.");
            return true;
        }
        if (parsed.useNewSlot && sourceTarget && isRerouteTargetProtected(sourceTarget)) {
            await deps.answerCallbackQuery(query.id, "🚫 Thread restore source is already owned.");
            return true;
        }
        pending.destinationSelected = true;
        pending.selectionAttempted = true;
        pending.pauseExpiry?.();
        const currentInstanceId = deps.getCurrentInstanceId?.();
        const leaderProfileKey = getLeaderTopicProfileKey(ctx, currentInstanceId);
        const isCurrentLeaderRecord = isCurrentLeaderTopicRecord(record, leaderProfileKey, currentInstanceId);
        if (parsed.useNewSlot && !isCurrentLeaderRecord) {
            if (!record.slot || !/^[A-Z]$/u.test(record.slot)) {
                await deps.answerCallbackQuery(query.id, "Follower thread slot authority is unavailable.");
                return true;
            }
            if (!sourceTarget ||
                !deps.replaceFollowerThreadTarget ||
                !deps.foreignOwnedUpdateForwarder?.forwardMessage) {
                await deps.answerCallbackQuery(query.id, "Follower thread restore is not available yet.");
                return true;
            }
            assertExecutionCurrent();
            const replaced = await deps.replaceFollowerThreadTarget({
                record,
                target: sourceTarget,
                oldTarget: record.target,
            });
            assertExecutionCurrent();
            if (!replaced) {
                await deps.answerCallbackQuery(query.id, "Follower thread is unavailable.");
                return true;
            }
            const nowMs = Date.now();
            const slot = record.slot;
            const threadName = getRestoredThreadName(record, slot);
            assertExecutionCurrent();
            deps.threadStore.markStaleByTarget(record.target, "deleted", "Follower thread was replaced by restore source.");
            deps.threadStore.upsert({
                ...record,
                target: sourceTarget,
                status: "active",
                syncStatus: "open",
                updatedAtMs: nowMs,
                threadName,
                lastSyncObservedAtMs: nowMs,
                lastReconcileAction: "follower-thread-restore",
                rerouteConfirmedAtMs: nowMs,
            });
            await deps.threadStore.persist();
            assertExecutionCurrent();
            if (deps.callApi) {
                try {
                    assertExecutionCurrent();
                    await deps.callApi("editForumTopic", {
                        chat_id: sourceTarget.chatId,
                        message_thread_id: sourceTarget.threadId,
                        name: deps.getDisplayTitle?.(sourceTarget) ??
                            Threads.getTelegramTopicTitleForThreadName(threadName, slot),
                    });
                    assertExecutionCurrent();
                }
                catch (renameError) {
                    deps.recordRuntimeEvent?.("telegram", renameError, {
                        phase: "follower-topic-reroute-restore-rename",
                        chatId: sourceTarget.chatId,
                        threadId: sourceTarget.threadId,
                        slot: record.slot,
                    });
                }
            }
            const cleanup = {
                kind: "replaced-follower",
                target: record.target,
                instanceId: record.instanceId,
            };
            const allForwarded = await forwardPendingRerouteMessages(pending, record.instanceId, sourceTarget.threadId, ctx, assertExecutionCurrent);
            if (!allForwarded) {
                pending.foreignRetry = {
                    instanceId: record.instanceId,
                    threadId: sourceTarget.threadId,
                    cleanup,
                };
                await deps.answerCallbackQuery(query.id, "Thread restored; retrying will send only remaining messages before old-thread cleanup.");
                return true;
            }
            const cleanupComplete = await retryPendingRerouteCleanup(cleanup, assertExecutionCurrent);
            if (!cleanupComplete) {
                pending.cleanup = cleanup;
                await deps.answerCallbackQuery(query.id, "Thread restored, but old-thread cleanup is still pending. Try again.");
                return true;
            }
            await finalizePendingReroute(parsed.rerouteId, pending, query, "Message routed.");
            return true;
        }
        if (record.instanceId &&
            record.instanceId !== currentInstanceId &&
            !isCurrentLeaderRecord) {
            if (!deps.foreignOwnedUpdateForwarder?.forwardMessage) {
                await deps.answerCallbackQuery(query.id, "Open that thread and resend the message there.");
                return true;
            }
            const allForwarded = await forwardPendingRerouteMessages(pending, record.instanceId, parsed.threadId, ctx, assertExecutionCurrent);
            if (!allForwarded) {
                await deps.answerCallbackQuery(query.id, "Target thread is unavailable; retrying will send only remaining messages.");
                return true;
            }
            const cleanupComplete = await closeReroutedUnboundTopic(sourceTarget, sourceMessageId, assertExecutionCurrent);
            if (!cleanupComplete && sourceTarget) {
                pending.cleanup = {
                    kind: "unbound",
                    target: sourceTarget,
                    ...(typeof sourceMessageId === "number"
                        ? { messageId: sourceMessageId }
                        : {}),
                };
                await deps.answerCallbackQuery(query.id, "Message routed, but thread cleanup is still pending. Try again.");
                return true;
            }
            await finalizePendingReroute(parsed.rerouteId, pending, query, "Message routed.");
            return true;
        }
        if (sourceTarget &&
            isCurrentLeaderRecord &&
            parsed.useNewSlot &&
            (record.target.chatId !== sourceTarget.chatId ||
                record.target.threadId !== sourceTarget.threadId)) {
            const slot = deps.threadStore.allocateSlot(leaderProfileKey ?? record.profileKey, getNextTelegramSlotPreference(record.slot), undefined, { excludeCurrentRecord: true });
            if (!slot) {
                await deps.answerCallbackQuery(query.id, TELEGRAM_SLOT_CAPACITY_MESSAGE);
                return true;
            }
            deps.threadStore.markStaleByTarget(record.target, "deleted", "Current leader thread was replaced by a new-slot reroute source.");
            const nowMs = Date.now();
            const threadName = getRestoredThreadName(record, slot);
            deps.threadStore.upsert({
                ...record,
                target: sourceTarget,
                status: "active",
                updatedAtMs: nowMs,
                threadName,
                instanceId: currentInstanceId,
                slot,
                lastReconcileAction: "reroute-new-slot",
                rerouteConfirmedAtMs: nowMs,
            });
            await deps.threadStore.persist();
            assertExecutionCurrent();
            deps.setCurrentLeaderIdentity?.({
                target: sourceTarget,
                slot,
                threadName,
            });
            if (deps.callApi) {
                try {
                    assertExecutionCurrent();
                    await deps.callApi("editForumTopic", {
                        chat_id: sourceTarget.chatId,
                        message_thread_id: sourceTarget.threadId,
                        name: deps.getDisplayTitle?.(sourceTarget) ??
                            Threads.getTelegramTopicTitleForThreadName(threadName, slot),
                    });
                    assertExecutionCurrent();
                }
                catch (renameError) {
                    deps.recordRuntimeEvent?.("telegram", renameError, {
                        phase: "leader-topic-reroute-reclaim-rename",
                        chatId: sourceTarget.chatId,
                        threadId: sourceTarget.threadId,
                        slot,
                    });
                }
            }
            deps.recordRuntimeEvent?.("bus", "Bus leader reclaimed reroute source thread", {
                phase: "leader-topic-reroute-reclaim",
                chatId: sourceTarget.chatId,
                threadId: sourceTarget.threadId,
                staleThreadId: record.target.threadId,
                slot,
            });
            await dispatchPendingRerouteMessages(pending, cloneTelegramMessagesForThread(pending.messages, sourceTarget.threadId), ctx);
            pending.messages = [];
            const cleanupComplete = await closePreviousLeaderThread(record.target, assertExecutionCurrent);
            if (!cleanupComplete) {
                pending.cleanup = {
                    kind: "previous-leader",
                    target: record.target,
                };
                await deps.answerCallbackQuery(query.id, "Thread restored, but old-thread cleanup is still pending. Try again.");
                return true;
            }
            await finalizePendingReroute(parsed.rerouteId, pending, query, "Message routed.");
            return true;
        }
        await dispatchPendingRerouteMessages(pending, reroutedMessages, ctx);
        pending.messages = [];
        const cleanupComplete = await closeReroutedUnboundTopic(sourceTarget, sourceMessageId, assertExecutionCurrent);
        if (!cleanupComplete && sourceTarget) {
            pending.cleanup = {
                kind: "unbound",
                target: sourceTarget,
                ...(typeof sourceMessageId === "number"
                    ? { messageId: sourceMessageId }
                    : {}),
            };
            await deps.answerCallbackQuery(query.id, "Message routed, but thread cleanup is still pending. Try again.");
            return true;
        }
        await finalizePendingReroute(parsed.rerouteId, pending, query, "Message routed.");
        return true;
    };
    const executeUnboundRerouteCallback = (query, ctx) => {
        if (!parseTelegramUnboundRerouteCallbackData(query.data) ||
            !deps.runWorkspaceOperation) {
            return executeUnboundRerouteCallbackOperation(query, ctx);
        }
        return deps.runWorkspaceOperation({
            operationId: `workspace-reroute:${query.id}`,
            operationKind: "workspace.route-unbound-thread",
            scopes: [{ kind: "profile" }],
        }, () => executeUnboundRerouteCallbackOperation(query, ctx));
    };
    const handleUnboundRerouteCallback = async (query, ctx) => {
        const parsed = parseTelegramUnboundRerouteCallbackData(query.data);
        const pending = parsed && pendingUnboundReroutes.get(parsed.rerouteId);
        if (!parsed || !pending || pending.dispatchKind !== "command" ||
            pending.sourceTarget.threadId !== undefined || !matchesRerouteChooser(pending, query)) {
            return executeUnboundRerouteCallback(query, ctx);
        }
        if (pending.dispatching) {
            await deps.answerCallbackQuery(query.id, "Command routing is already in progress.");
            return true;
        }
        pending.dispatching = true;
        try {
            return await executeUnboundRerouteCallback(query, ctx);
        }
        finally {
            pending.dispatching = false;
            if (pendingUnboundReroutes.get(parsed.rerouteId) === pending &&
                pending.destinationSelected && pending.messages.length > 0 &&
                !pending.cleanup && !pending.finalizeMessage) {
                pending.destinationSelected = false;
                armPendingCommandExpiry(parsed.rerouteId, pending);
            }
        }
    };
    const callbackHandler = async (query, ctx) => {
        const assertExecutionCurrent = Updates.createTelegramUpdateExecutionFenceGuard(query);
        assertExecutionCurrent();
        if (await handleUnboundRerouteRestoreMenuCallback(query, ctx))
            return;
        if (await handleUnboundRerouteCallback(query, ctx))
            return;
        if (deps.buttonActionStore) {
            const handled = await OutboundHandlers.handleTelegramButtonCallbackQuery(query, ctx, {
                resolveAction: deps.buttonActionStore.resolve,
                answerCallbackQuery: deps.answerCallbackQuery,
                ...(deps.invokeBoundButtonAction
                    ? {
                        invokeBoundAction: (buttonQuery, action, context) => deps.invokeBoundButtonAction(action, buttonQuery, context),
                    }
                    : {}),
                editMessageReplyMarkup: deps.editMessageReplyMarkup
                    ? async (chatId, messageId, replyMarkup) => {
                        try {
                            await deps.editMessageReplyMarkup?.(chatId, messageId, replyMarkup);
                        }
                        catch (error) {
                            deps.recordRuntimeEvent?.("telegram", error, {
                                phase: "button-selection-mark",
                                chatId,
                                messageId,
                            });
                        }
                    }
                    : undefined,
                enqueueButtonPrompt: (buttonQuery, action, context) => {
                    const chatId = buttonQuery.message?.chat?.id;
                    const messageId = buttonQuery.message?.message_id;
                    if (typeof chatId !== "number" || typeof messageId !== "number")
                        return false;
                    const queueOrder = deps.bridgeRuntime.queue.allocateItemOrder();
                    const admissionReceipts = createAdmissionReceipts("prompt", [
                        buttonQuery,
                    ]);
                    const turn = {
                        ...OutboundHandlers.createTelegramButtonPromptTurn({
                            chatId,
                            target: typeof buttonQuery.message?.message_thread_id === "number"
                                ? {
                                    chatId,
                                    threadId: buttonQuery.message.message_thread_id,
                                }
                                : { chatId },
                            replyToMessageId: messageId,
                            queueOrder,
                            action,
                            telegramPrefix: Turns.createTelegramTurnPrefix({
                                thread: resolveTelegramThreadLabel({
                                    chat: { id: chatId },
                                    message_thread_id: buttonQuery.message?.message_thread_id,
                                }),
                            }),
                        }),
                        ...(admissionReceipts.length > 0 ? { admissionReceipts } : {}),
                    };
                    const result = Queue.appendTelegramPromptTurnOnce(deps.telegramQueueStore.getQueuedItems(), turn);
                    if (!result.appended) {
                        reportQueueAdmission([buttonQuery], admissionReceipts);
                        return false;
                    }
                    Updates.assertTelegramUpdateExecutionCurrent(buttonQuery);
                    deps.telegramQueueStore.setQueuedItems(result.items);
                    reportQueueAdmission([buttonQuery], admissionReceipts);
                    deps.updateStatus(context);
                    requestDispatchNextQueuedTelegramTurn(context);
                    return true;
                },
            });
            assertExecutionCurrent();
            if (handled)
                return;
        }
        if (query.data?.startsWith("thread-name:")) {
            const chatId = query.message?.chat?.id;
            const dialogMessageId = query.message?.message_id;
            if (typeof chatId !== "number" || typeof dialogMessageId !== "number") {
                await deps.answerCallbackQuery(query.id, "⌛ Rename dialog expired.");
                return;
            }
            const target = typeof query.message?.message_thread_id === "number"
                ? { chatId, threadId: query.message.message_thread_id }
                : { chatId };
            const action = query.data.slice("thread-name:".length);
            if (action !== "reset" && action !== "cancel") {
                await deps.answerCallbackQuery(query.id, "⌛ Rename dialog expired.");
                return;
            }
            const selected = threadNameDialog.select({
                scope: getThreadNameDialogScope(),
                target,
                dialogMessageId,
                action,
            });
            if (selected.kind === "expired") {
                await deps.answerCallbackQuery(query.id, "⌛ Rename dialog expired.");
                return;
            }
            if (selected.kind === "cancel") {
                await deps.editInteractiveMessage?.(chatId, dialogMessageId, "<b>✖ Rename cancelled.</b>", "html", { inline_keyboard: [] });
                await deps.answerCallbackQuery(query.id);
                return;
            }
            try {
                const result = await deps.resetCurrentThreadName?.(target);
                if (!result?.ok) {
                    throw new Error(result?.message ?? "Thread display name reset is unavailable.");
                }
                await deps.editInteractiveMessage?.(chatId, dialogMessageId, result.message
                    ? Commands.formatTelegramInformationHeading("✅", result.message)
                    : Commands.formatTelegramAutomaticThreadDisplayNameRestoredHeading(result.threadName ?? "automatic"), "html", { inline_keyboard: [] });
                await deps.answerCallbackQuery(query.id);
            }
            catch (error) {
                threadNameDialog.open({
                    scope: getThreadNameDialogScope(), target, dialogMessageId,
                });
                deps.recordRuntimeEvent?.("telegram-command", error, {
                    command: "name", phase: "reset",
                });
                await deps.answerCallbackQuery(query.id, "⚠️ Thread name reset failed.");
            }
            return;
        }
        const handledByNew = await Commands.handleTelegramNewConfirmationCallback(query, {
            ctx,
            answerCallbackQuery: deps.answerCallbackQuery,
            editInteractiveMessage: deps.editInteractiveMessage ?? (async () => { }),
            deleteMessage: deps.deleteMessage ?? (async () => { }),
            runNew: async (newCtx) => {
                await Commands.handleTelegramNewCommand({
                    isIdle: () => deps.isIdle(newCtx),
                    hasPendingMessages: () => deps.hasPendingMessages(newCtx),
                    hasActiveTelegramTurn: deps.activeTurnRuntime.has,
                    hasDispatchPending: deps.bridgeRuntime.lifecycle.hasDispatchPending,
                    hasQueuedTelegramItems: deps.telegramQueueStore.hasQueuedItems,
                    isCompactionInProgress: deps.bridgeRuntime.lifecycle.isCompactionInProgress,
                    requestNewSession: deps.requestNewSession
                        ? () => deps.requestNewSession(query)
                        : undefined,
                    sendTextReply: async (text) => {
                        const chatId = query.message?.chat?.id;
                        const messageId = query.message?.message_id;
                        if (typeof chatId !== "number" || typeof messageId !== "number")
                            return;
                        await deps.editInteractiveMessage?.(chatId, messageId, text, "html", { inline_keyboard: [] });
                    },
                    recordRuntimeEvent: deps.recordRuntimeEvent,
                });
            },
        });
        assertExecutionCurrent();
        if (handledByNew)
            return;
        const handledByCompact = await Commands.handleTelegramCompactConfirmationCallback(query, {
            ctx,
            answerCallbackQuery: deps.answerCallbackQuery,
            editInteractiveMessage: deps.editInteractiveMessage ?? (async () => { }),
            runCompact: async (compactCtx, chatId, replyToMessageId, target) => {
                await Commands.handleTelegramCompactCommand({
                    isIdle: () => deps.isIdle(compactCtx),
                    hasPendingMessages: () => deps.hasPendingMessages(compactCtx),
                    hasActiveTelegramTurn: deps.activeTurnRuntime.has,
                    hasDispatchPending: deps.bridgeRuntime.lifecycle.hasDispatchPending,
                    hasQueuedTelegramItems: deps.telegramQueueStore.hasQueuedItems,
                    isCompactionInProgress: deps.bridgeRuntime.lifecycle.isCompactionInProgress,
                    setCompactionInProgress: deps.bridgeRuntime.lifecycle.setCompactionInProgress,
                    updateStatus: () => deps.updateStatus(compactCtx),
                    dispatchNextQueuedTelegramTurn: () => deps.dispatchNextQueuedTelegramTurn(compactCtx),
                    requestDeferredDispatchNextQueuedTelegramTurn: deps.requestDeferredDispatchNextQueuedTelegramTurn
                        ? (dispatch) => deps.requestDeferredDispatchNextQueuedTelegramTurn?.(() => dispatch())
                        : undefined,
                    compact: (callbacks) => deps.compact(compactCtx, callbacks),
                    startTypingLoop: deps.startTypingLoop
                        ? () => deps.startTypingLoop?.(compactCtx, chatId, {
                            target,
                        })
                        : undefined,
                    stopTypingLoop: deps.stopTypingLoop,
                    sendTextReply: (text, options) => deps
                        .sendTextReply(chatId, replyToMessageId, text, {
                        target,
                        parseMode: options?.parseMode,
                    })
                        .then(() => { }),
                    suppressStartNotice: true,
                    recordRuntimeEvent: deps.recordRuntimeEvent,
                });
            },
        });
        assertExecutionCurrent();
        if (handledByCompact)
            return;
        const handledByQueue = await deps.queueMenuCallbackHandler(query, ctx);
        assertExecutionCurrent();
        if (handledByQueue)
            return;
        const handledBySettings = await deps.settingsMenuCallbackHandler?.(query, ctx);
        assertExecutionCurrent();
        if (handledBySettings)
            return;
        const callbackData = query.data;
        if (callbackData && !isTelegramOwnedCallbackData(callbackData)) {
            const chatId = query.message?.chat?.id;
            const messageId = query.message?.message_id;
            if (typeof chatId === "number" && typeof messageId === "number") {
                const queueOrder = deps.bridgeRuntime.queue.allocateItemOrder();
                const target = typeof query.message?.message_thread_id === "number"
                    ? { chatId, threadId: query.message.message_thread_id }
                    : { chatId };
                const admissionReceipts = createAdmissionReceipts("prompt", [query]);
                const turn = {
                    kind: "prompt",
                    chatId,
                    target,
                    replyToMessageId: messageId,
                    sourceMessageIds: [messageId],
                    queueOrder,
                    queueLane: "priority",
                    laneOrder: queueOrder,
                    queuedAttachments: [],
                    content: [{ type: "text", text: `[callback] ${callbackData}` }],
                    historyText: callbackData,
                    statusSummary: callbackData,
                    ...(admissionReceipts.length > 0 ? { admissionReceipts } : {}),
                };
                const result = Queue.appendTelegramPromptTurnOnce(deps.telegramQueueStore.getQueuedItems(), turn);
                if (result.appended) {
                    Updates.assertTelegramUpdateExecutionCurrent(query);
                    deps.telegramQueueStore.setQueuedItems(result.items);
                    reportQueueAdmission([query], admissionReceipts);
                    deps.updateStatus(ctx);
                    requestDispatchNextQueuedTelegramTurn(ctx);
                }
                else {
                    reportQueueAdmission([query], admissionReceipts);
                }
            }
            await deps.answerCallbackQuery(query.id);
            return;
        }
        await menuCallbackHandler(query, ctx);
    };
    const preparePromptTurn = Turns.createTelegramPromptTurnRuntimePreparer({
        allocateQueueOrder: deps.bridgeRuntime.queue.allocateItemOrder,
        downloadFile: deps.downloadFile,
        processAttachments: deps.inboundHandlerRuntime.process,
        resolveTimeLine: deps.resolveTimeLine,
        getAllowedUserId: deps.configStore.getAllowedUserId,
        getAdmissionScope: deps.getAdmissionScope,
        getAdmissionJournalBinding: deps.getAdmissionJournalBinding,
        assertExecutionCurrent(message) {
            Updates.assertTelegramUpdateExecutionCurrent(message);
        },
        // Voice policy resolves missing, invalid, and legacy manual config to hidden.
        getVoiceReplyMode: () => getTelegramVoiceReplyMode(deps.configStore.get()),
        getTelegramThreadLabel: resolveTelegramThreadLabel,
    });
    const enqueueContinueTurn = async (message, ctx) => {
        deps.bridgeRuntime.lifecycle.setFoldQueuedPromptsIntoHistory(false);
        const continueMessage = {
            ...message,
            text: "continue",
            caption: undefined,
        };
        const buildTurn = await preparePromptTurn([continueMessage], ctx);
        const turn = buildTurn([]);
        const continueTurn = {
            ...turn,
            queueLane: "control",
            laneOrder: deps.bridgeRuntime.queue.allocateControlOrder(),
            statusSummary: "continue",
        };
        Updates.assertTelegramUpdateExecutionCurrent(message);
        deps.queueMutationRuntime.append(continueTurn, ctx);
        reportQueueAdmission([continueMessage], continueTurn.admissionReceipts ?? []);
        requestDispatchNextQueuedTelegramTurn(ctx);
    };
    const reservedCommandNames = () => new Set(Commands.getTelegramReservedCommandNames());
    const getPromptTemplateCommands = () => PromptTemplates.getTelegramPromptTemplateCommands(deps.getCommands(), reservedCommandNames());
    const commandHandler = Commands.createTelegramCommandHandlerTargetRuntime({
        assertExecutionCurrent(message) {
            Updates.assertTelegramUpdateExecutionCurrent(message);
        },
        hasAbortHandler: deps.bridgeRuntime.abort.hasHandler,
        clearPendingModelSwitch: deps.modelSwitchController.clearPendingSwitch,
        hasQueuedTelegramItems: deps.telegramQueueStore.hasQueuedItems,
        clearQueuedTelegramItems: deps.queueMutationRuntime.clear,
        setFoldQueuedPromptsIntoHistory: deps.bridgeRuntime.lifecycle.setFoldQueuedPromptsIntoHistory,
        abortCurrentTurn: deps.bridgeRuntime.abort.abortTurn,
        isIdle: deps.isIdle,
        hasPendingMessages: deps.hasPendingMessages,
        hasActiveTelegramTurn: deps.activeTurnRuntime.has,
        hasDispatchPending: deps.bridgeRuntime.lifecycle.hasDispatchPending,
        isCompactionInProgress: deps.bridgeRuntime.lifecycle.isCompactionInProgress,
        setCompactionInProgress: deps.bridgeRuntime.lifecycle.setCompactionInProgress,
        updateStatus: deps.updateStatus,
        isContextActive: deps.isContextActive,
        dispatchNextQueuedTelegramTurn: deps.dispatchNextQueuedTelegramTurn,
        requestNextDispatchAnnouncement: deps.requestNextDispatchAnnouncement,
        cancelNextTransitionAnnouncements: () => {
            deps.activeTurnRuntime.clearNextAbortAnnouncement();
            deps.cancelNextDispatchAnnouncement?.();
        },
        requestDeferredDispatchNextQueuedTelegramTurn: deps.requestDeferredDispatchNextQueuedTelegramTurn,
        startTypingLoop: deps.startTypingLoop,
        stopTypingLoop: deps.stopTypingLoop,
        enqueueContinueTurn,
        compact: deps.compact,
        requestNewSession: deps.requestNewSession,
        allocateItemOrder: deps.bridgeRuntime.queue.allocateItemOrder,
        allocateControlOrder: deps.bridgeRuntime.queue.allocateControlOrder,
        appendControlItem: deps.queueMutationRuntime.append,
        getAdmissionScope: deps.getAdmissionScope,
        getAdmissionJournalBinding: deps.getAdmissionJournalBinding,
        onControlQueued: (message, receipt) => reportQueueAdmission([message], [receipt]),
        showStatus: deps.menuActions.sendStatusMessage,
        openModelMenu: deps.menuActions.openModelMenu,
        openThinkingMenu: (message, ctx) => {
            const chatId = message.chat.id;
            return deps.menuActions.openThinkingMenu(chatId, message.message_id, ctx);
        },
        openQueueMenu: (message, ctx) => {
            const chatId = message.chat.id;
            return deps.openQueueMenu(chatId, message.message_id, ctx);
        },
        openSettingsMenu: deps.openSettingsMenu,
        getAllowedUserId: deps.configStore.getAllowedUserId,
        persistAllowedUserId: deps.configStore.persistAllowedUserId,
        setMyCommands: deps.setMyCommands,
        validateThreadName: deps.validateThreadName,
        renameCurrentThread: deps.renameCurrentThread,
        resetCurrentThreadName: deps.resetCurrentThreadName,
        openThreadNameDialog: async (message) => {
            const target = Updates.getTelegramMessageTarget(message);
            if (!deps.sendInteractiveMessage || !target) {
                await deps.sendTextReply(message.chat.id, message.message_id, Commands.formatTelegramInformationHeading("🏷️", "Usage: /name Navigator"), { parseMode: "HTML", target });
                return;
            }
            const hasManualName = deps.threadStore?.listWorkspaceBindings().some((binding) => binding.target.chatId === target.chatId &&
                binding.target.threadId === target.threadId &&
                typeof binding.manualThreadName === "string") ?? false;
            const instructions = hasManualName
                ? "<b>🏷️ Send a new Thread name using printable ASCII, reset to automatic, or cancel.</b>"
                : "<b>🏷️ Send a Thread name using printable ASCII, or cancel.</b>";
            const buttons = hasManualName
                ? [
                    { text: "↩️ Reset to automatic", callback_data: "thread-name:reset" },
                    { text: "✖ Cancel rename", callback_data: "thread-name:cancel" },
                ]
                : [{ text: "✖ Cancel rename", callback_data: "thread-name:cancel" }];
            const dialogMessageId = await deps.sendInteractiveMessage(target.chatId, instructions, "html", { inline_keyboard: buttons.map((button) => [button]) }, { target });
            if (typeof dialogMessageId !== "number")
                return;
            threadNameDialog.open({
                scope: getThreadNameDialogScope(),
                target,
                dialogMessageId,
            });
        },
        getPromptTemplateCommands,
        sendTextReply: deps.sendTextReply,
        markActiveTurnNextAbortAnnouncement: deps.activeTurnRuntime.markNextAbortAnnouncement,
        getActiveTurnReply: () => {
            const activeTurn = deps.activeTurnRuntime.get();
            if (!activeTurn)
                return undefined;
            return async (text, options) => {
                await deps.sendTextReply(activeTurn.chatId, activeTurn.replyToMessageId, text, { target: activeTurn.target, parseMode: options?.parseMode });
            };
        },
        sendInteractiveMessage: deps.sendInteractiveMessage,
        recordRuntimeEvent: deps.recordRuntimeEvent,
    });
    const promptEnqueueController = Queue.createTelegramPromptEnqueueController({
        ...deps.telegramQueueStore,
        hasPendingDispatch: deps.bridgeRuntime.lifecycle.hasDispatchPending,
        getFoldQueuedPromptsIntoHistory: deps.bridgeRuntime.lifecycle.shouldFoldQueuedPromptsIntoHistory,
        setFoldQueuedPromptsIntoHistory: deps.bridgeRuntime.lifecycle.setFoldQueuedPromptsIntoHistory,
        prepareTurn: async (messages, turnCtx) => {
            const buildTurn = await preparePromptTurn(messages, turnCtx);
            return (historyTurns) => {
                const turn = buildTurn(historyTurns);
                return turn.replyToMessageId > 0
                    ? turn
                    : { ...turn, replyToMessageId: 0 };
            };
        },
        updateStatus: deps.updateStatus,
        dispatchNextQueuedTelegramTurn: requestDispatchNextQueuedTelegramTurn,
        assertExecutionCurrent: (messages) => Updates.assertTelegramUpdateExecutionCurrent(messages[0]),
    });
    const promptEnqueue = async (messages, ctx) => {
        return promptEnqueueController.enqueue(messages, ctx, (turn) => {
            reportQueueAdmission(messages, turn.admissionReceipts ?? []);
        });
    };
    const sendUnboundRerouteChooserNow = async (messages, _ctx, reportDeferred = true) => {
        const message = messages[0];
        if (!message || !deps.threadStore)
            return;
        const records = deps.threadStore.list();
        const activeRecords = getTelegramRoutableThreadRecords(records, deps.getLiveThreadTargets?.());
        const sourceTarget = typeof message.message_thread_id === "number"
            ? { chatId: message.chat.id, threadId: message.message_thread_id }
            : undefined;
        const sourceKey = sourceTarget
            ? formatTelegramTargetKey(sourceTarget)
            : undefined;
        const includeGuidance = sourceKey
            ? !guidedUnboundTopicKeys.has(sourceKey)
            : true;
        if (sourceKey)
            guidedUnboundTopicKeys.add(sourceKey);
        if (activeRecords.length === 0) {
            await deps.sendTextReply(message.chat.id, message.message_id, [
                includeGuidance ? formatTelegramUnboundTopicGuidance() : undefined,
                `This thread is not bound to a Pi instance. Open an active Pi thread or run ${Commands.formatTelegramPiCommandHtml("/telegram-connect")} from a Pi session to bind one.`,
            ]
                .filter((line) => typeof line === "string")
                .join("\n\n"), { parseMode: "HTML", target: sourceTarget });
            return;
        }
        const rerouteId = storePendingUnboundReroute(messages);
        if (reportDeferred) {
            for (const source of messages) {
                Updates.reportTelegramUpdateDeferred(source);
            }
        }
        const text = formatTelegramUnboundRerouteChooserText(activeRecords, {
            includeGuidance,
        });
        const replyMarkup = buildTelegramUnboundRerouteChooserMarkup(rerouteId, activeRecords, { canRestore: sourceTarget !== undefined, getDisplayTitle: deps.getDisplayTitle });
        if (deps.sendInteractiveMessage) {
            const chooserId = await deps.sendInteractiveMessage(message.chat.id, text, "html", replyMarkup, sourceTarget
                ? { target: sourceTarget, replyToMessageId: message.message_id }
                : { replyToMessageId: message.message_id });
            rememberRerouteChooser(rerouteId, chooserId);
            return;
        }
        const chooserId = await deps.sendTextReply(message.chat.id, message.message_id, text, {
            parseMode: "HTML",
            target: sourceTarget,
        });
        rememberRerouteChooser(rerouteId, chooserId);
    };
    const sendUnboundRerouteChooser = async (message, ctx) => {
        const groupKey = Media.getTelegramMediaGroupKey(message);
        if (!groupKey) {
            await sendUnboundRerouteChooserNow([message], ctx);
            return;
        }
        const existing = pendingUnboundRerouteMediaGroups.get(groupKey);
        if (existing)
            clearTimeout(existing.timer);
        const messages = [...(existing?.messages ?? []), message];
        const timer = setTimeout(() => {
            pendingUnboundRerouteMediaGroups.delete(groupKey);
            void sendUnboundRerouteChooserNow(messages, ctx, false);
        }, 1200);
        timer.unref?.();
        pendingUnboundRerouteMediaGroups.set(groupKey, { messages, timer });
        Updates.reportTelegramUpdateDeferred(message);
    };
    const getKnownTelegramAllTabCommand = (text) => {
        const command = Commands.parseTelegramCommand(text);
        if (!command)
            return undefined;
        if (reservedCommandNames().has(command.name))
            return command;
        if (Commands.findTelegramExtensionCommand(command.name))
            return command;
        if (getPromptTemplateCommands().some((template) => template.command === command.name)) {
            return command;
        }
        return undefined;
    };
    const sendAllTabCommandChooser = async (command, commandText, message, options = {}) => {
        if (!deps.threadStore)
            return false;
        const records = deps.threadStore.list();
        const activeRecords = getTelegramRoutableThreadRecords(records, deps.getLiveThreadTargets?.());
        if (activeRecords.length === 0)
            return false;
        const commandMessage = Updates.carryTelegramUpdateExecutionFence(message, {
            ...message,
            text: commandText,
            caption: undefined,
        });
        const rerouteId = storePendingUnboundReroute([commandMessage], "command");
        Updates.reportTelegramUpdateDeferred(commandMessage);
        const text = formatTelegramAllTabMenuChooserText(command.name);
        const replyMarkup = buildTelegramUnboundRerouteChooserMarkup(rerouteId, activeRecords, { canRestore: typeof message.message_thread_id === "number", getDisplayTitle: deps.getDisplayTitle });
        let chooserId;
        try {
            if (deps.sendInteractiveMessage) {
                chooserId = await deps.sendInteractiveMessage(message.chat.id, text, "html", replyMarkup, options.target || options.replyToSource
                    ? {
                        ...(options.target ? { target: options.target } : {}),
                        ...(options.replyToSource
                            ? { replyToMessageId: message.message_id }
                            : {}),
                    }
                    : undefined);
            }
            else if (deps.callApi) {
                const chooser = await deps.callApi("sendMessage", {
                    chat_id: message.chat.id,
                    text,
                    parse_mode: "HTML",
                    reply_markup: replyMarkup,
                    ...(typeof options.target?.threadId === "number"
                        ? { message_thread_id: options.target.threadId }
                        : {}),
                    ...(options.replyToSource
                        ? {
                            reply_parameters: {
                                message_id: message.message_id,
                                allow_sending_without_reply: true,
                            },
                        }
                        : {}),
                });
                chooserId = chooser?.message_id;
            }
            else {
                chooserId = await deps.sendTextReply(message.chat.id, message.message_id, text, {
                    parseMode: "HTML",
                    target: options.target,
                });
            }
        }
        catch (error) {
            removePendingReroute(rerouteId);
            throw error;
        }
        rememberRerouteChooser(rerouteId, chooserId);
        Updates.reportTelegramUpdateCompleted(commandMessage);
        return true;
    };
    const commandOrPrompt = Commands.createTelegramCommandOrPromptRuntime({
        extractRawText: Media.extractFirstTelegramMessageText,
        assertExecutionCurrent(message) {
            Updates.assertTelegramUpdateExecutionCurrent(message);
        },
        shouldIgnoreMessages: (messages) => !Media.hasTelegramMessagesPromptContent(messages),
        consumeThreadNameInput: async (messages) => {
            const message = messages[0];
            if (!message || messages.length !== 1)
                return false;
            const target = Updates.getTelegramMessageTarget(message);
            if (!target)
                return false;
            const candidate = threadNameDialog.inspect(target);
            if (!candidate || candidate.scope !== getThreadNameDialogScope() ||
                candidate.phase !== "input")
                return false;
            const name = Media.extractFirstTelegramMessageText(messages).trim();
            if (/^[A-Z]$/.test(name) && deps.resetCurrentThreadName) {
                const consumed = threadNameDialog.consumeName({
                    scope: getThreadNameDialogScope(), target, text: name,
                });
                if (consumed.kind !== "name")
                    return false;
                const result = await deps.resetCurrentThreadName(target);
                if (!result.ok) {
                    threadNameDialog.open({
                        scope: getThreadNameDialogScope(), target,
                        dialogMessageId: candidate.dialogMessageId,
                    });
                }
                const replyText = result.ok && !result.message
                    ? Commands.formatTelegramAutomaticThreadDisplayNameRestoredHeading(result.threadName ?? name)
                    : Commands.formatTelegramInformationHeading(result.ok ? "✅" : "⚠️", result.message ?? "Thread display name reset failed.");
                if (result.ok) {
                    Updates.assertTelegramUpdateExecutionCurrent(message);
                    Updates.reportTelegramUpdateCompleted(message);
                    void deps.sendTextReply(target.chatId, message.message_id, replyText, { parseMode: "HTML", target }).catch((error) => deps.recordRuntimeEvent?.("telegram-command", error, {
                        command: "name", phase: "reset-result",
                    }));
                    return true;
                }
                await deps.sendTextReply(target.chatId, message.message_id, replyText, { parseMode: "HTML", target });
                return true;
            }
            const validationError = deps.validateThreadName?.(name);
            if (!name || validationError) {
                await deps.sendTextReply(target.chatId, message.message_id, validationError
                    ? Commands.formatTelegramInvalidInstanceName(validationError)
                    : Commands.formatTelegramInformationHeading("⚠️", "Send 1–96 printable ASCII characters."), { parseMode: "HTML", target });
                return true;
            }
            const consumed = threadNameDialog.consumeName({
                scope: getThreadNameDialogScope(), target, text: name,
            });
            if (consumed.kind !== "name")
                return false;
            const result = await deps.renameCurrentThread?.(target, consumed.name);
            if (!result?.ok) {
                threadNameDialog.open({
                    scope: getThreadNameDialogScope(),
                    target,
                    dialogMessageId: candidate.dialogMessageId,
                });
            }
            const replyText = result?.ok && !result.message
                ? Commands.formatTelegramThreadDisplayNameSavedHeading(result.threadName ?? consumed.name)
                : Commands.formatTelegramInformationHeading(result?.ok ? "✅" : "⚠️", result?.message ?? "Thread display name update failed.");
            if (result?.ok) {
                Updates.assertTelegramUpdateExecutionCurrent(message);
                Updates.reportTelegramUpdateCompleted(message);
                void deps.sendTextReply(target.chatId, message.message_id, replyText, { parseMode: "HTML", target }).catch((error) => deps.recordRuntimeEvent?.("telegram-command", error, {
                    command: "name", phase: "rename-result",
                }));
                return true;
            }
            await deps.sendTextReply(target.chatId, message.message_id, replyText, { parseMode: "HTML", target });
            return true;
        },
        handleCommand: commandHandler,
        executeExtensionCommand: async (command, message, ctx) => {
            const extensionCommand = Commands.findTelegramExtensionCommand(command.name);
            if (!extensionCommand)
                return false;
            const sourceTarget = Updates.getTelegramMessageTarget(message);
            const assertExecutionCurrent = Updates.createTelegramUpdateExecutionFenceGuard(message);
            try {
                assertExecutionCurrent();
                await extensionCommand.handler({
                    name: command.name,
                    args: command.args,
                    reply: async (text) => {
                        assertExecutionCurrent();
                        await deps.sendTextReply(message.chat.id, message.message_id, text, { target: sourceTarget });
                        assertExecutionCurrent();
                    },
                    enqueuePrompt: async (prompt) => {
                        assertExecutionCurrent();
                        await promptEnqueue([
                            {
                                ...message,
                                text: prompt,
                                caption: undefined,
                            },
                        ], ctx);
                    },
                });
                assertExecutionCurrent();
            }
            catch (error) {
                deps.recordRuntimeEvent?.("telegram-command", error, {
                    command: command.name,
                });
                assertExecutionCurrent();
                await deps.sendTextReply(message.chat.id, message.message_id, "Command failed.", { target: sourceTarget });
            }
            return true;
        },
        expandPromptTemplateCommand: (commandName, args) => PromptTemplates.expandTelegramPromptTemplateCommand(commandName, args, getPromptTemplateCommands()),
        replaceMessageText: (message, text) => ({ ...message, text, caption: undefined }),
        enqueueTurn: async (messages, ctx) => {
            await promptEnqueue(messages, ctx);
        },
    });
    dispatchReroutedCommandMessages = (messages, ctx) => commandOrPrompt.dispatchMessages(messages, ctx);
    const mediaDispatch = Media.createTelegramMediaGroupDispatchRuntime({
        mediaGroups: deps.mediaGroupRuntime,
        dispatchMessages: commandOrPrompt.dispatchMessages,
        onDeferredMessage: Updates.reportTelegramUpdateDeferred,
    });
    const textDispatch = TextGroups.createTelegramTextGroupDispatchRuntime({
        textGroups: deps.textGroupRuntime,
        dispatchMessages: commandOrPrompt.dispatchMessages,
        dispatchSingleMessage: mediaDispatch.handleMessage,
        onDeferredMessage: Updates.reportTelegramUpdateDeferred,
    });
    const editRuntime = Turns.createTelegramQueuedPromptEditRuntime({
        ...deps.telegramQueueStore,
        updateStatus: deps.updateStatus,
    });
    const handleTelegramTopicLifecycleUpdate = async (lifecycle, ctx) => {
        const assertExecutionCurrent = Updates.createTelegramUpdateExecutionFenceGuard(lifecycle.message);
        assertExecutionCurrent();
        await deps.handleTelegramTopicLifecycleUpdate?.(lifecycle, ctx);
        assertExecutionCurrent();
        if (lifecycle.kind !== "created" || !deps.threadStore) {
            return;
        }
        await deps.threadStore.load();
        assertExecutionCurrent();
    };
    // Answer the guest query immediately so the agent-end edit can replace the
    // early ACK once the turn settles. The ACK is the first placeholder frame and
    // the loop rotates through the remaining frames until the replacement.
    const TELEGRAM_GUEST_ACK_HTML = Replies.buildTelegramGuestPlaceholderFrame(0);
    const handleAuthorizedTelegramGuestMessage = async (guestMessage, ctx) => {
        const assertExecutionCurrent = Updates.createTelegramUpdateExecutionFenceGuard(guestMessage);
        assertExecutionCurrent();
        let guestInlineMessageId;
        if (deps.answerGuestQueryForInlineMessage) {
            try {
                guestInlineMessageId = await deps.answerGuestQueryForInlineMessage(guestMessage.guest_query_id, TELEGRAM_GUEST_ACK_HTML, { parseMode: "HTML" });
                if (guestInlineMessageId) {
                    deps.startGuestPlaceholder?.(guestInlineMessageId);
                }
                deps.recordRuntimeEvent?.("guest", new Error("Guest ACK answered the guest query"), {
                    phase: "guest-ack-sent",
                    guestQueryId: guestMessage.guest_query_id,
                    hasInlineMessageId: !!guestInlineMessageId,
                });
            }
            catch (error) {
                deps.recordRuntimeEvent?.("guest", error, {
                    phase: "guest-ack-failed",
                    guestQueryId: guestMessage.guest_query_id,
                });
            }
            assertExecutionCurrent();
        }
        const text = guestMessage.text ?? "";
        const gm = guestMessage;
        // Build telegram prefix with guest context
        const chatRaw = gm.chat;
        const chatType = chatRaw?.type;
        const fromRaw = gm.from;
        const replyMsg = gm.reply_to_message;
        const replyFromRaw = replyMsg?.from;
        const guestBotCallerUser = gm.guest_bot_caller_user;
        const guestBotCallerChat = gm.guest_bot_caller_chat;
        const ownerUserId = deps.configStore.getAllowedUserId();
        const replyPeer = formatTelegramPromptPeer(replyFromRaw);
        const guestPeer = resolveTelegramGuestPromptPeer({
            chatType,
            chat: chatRaw,
            from: fromRaw,
            replyFrom: replyFromRaw,
            guestBotCallerUser,
            guestBotCallerChat,
            ownerUserId,
        });
        const prefixParts = ["telegram"];
        if (guestPeer) {
            prefixParts.push(`guest:${guestPeer}`);
        }
        else if (chatType === "private") {
            deps.recordRuntimeEvent?.("guest", new Error("Private Guest Mode remote peer could not be resolved"), {
                phase: "peer-attribution",
                chatId: typeof chatRaw?.id === "number" ? chatRaw.id : undefined,
                fromId: typeof fromRaw?.id === "number" ? fromRaw.id : undefined,
                hasReplyFrom: !!replyFromRaw,
                hasCallerUser: !!guestBotCallerUser,
                hasCallerChat: !!guestBotCallerChat,
            });
        }
        const telegramPrefix = `[${prefixParts.join("|")}]`;
        // Extract reply context
        const replyText = replyMsg
            ? (replyMsg.text || replyMsg.caption || "").trim()
            : "";
        // Download files, run inbound handlers
        const guestMsg = guestMessage;
        const replyFiles = guestMsg.reply_to_message
            ? await Media.downloadTelegramMessageFiles([guestMsg.reply_to_message], { downloadFile: deps.downloadFile })
            : [];
        assertExecutionCurrent();
        const processedReply = replyFiles.length > 0
            ? await deps.inboundHandlerRuntime.process(replyFiles, "", ctx)
            : undefined;
        assertExecutionCurrent();
        const files = await Media.downloadTelegramMessageFiles([guestMsg], {
            downloadFile: deps.downloadFile,
        });
        assertExecutionCurrent();
        const processed = await deps.inboundHandlerRuntime.process(files, text, ctx);
        assertExecutionCurrent();
        const rawText = processed.rawText || text;
        let sourceContext = "";
        if (replyMsg) {
            const replyHeader = replyPeer ? `[reply|from:${replyPeer}]` : "[reply]";
            const replyBlock = replyText
                ? `${replyHeader} ${replyText}`
                : replyHeader;
            sourceContext = appendTelegramSourceAttachmentSection(replyBlock, replyPeer, processedReply?.promptFiles ?? replyFiles, processedReply?.handlerOutputs);
        }
        const promptText = Turns.buildTelegramTurnPrompt({
            telegramPrefix,
            rawText,
            files,
            promptFiles: processed.promptFiles,
            handlerOutputs: processed.handlerOutputs,
            sourceContext,
            // Guest Mode allows exactly one reply within Telegram's limited response
            // window; the note travels with the turn text so the agent sees it at
            // execution time without a guest-specific system prompt variant.
            guestTurn: true,
        });
        const order = deps.bridgeRuntime.queue.allocateItemOrder();
        const content = [
            { type: "text", text: promptText },
        ];
        for (const file of processed.promptFiles) {
            if (file.isImage && file.mimeType) {
                try {
                    const buffer = await readFile(file.path);
                    assertExecutionCurrent();
                    content.push({
                        type: "image",
                        data: Buffer.from(buffer).toString("base64"),
                        mimeType: file.mimeType,
                    });
                }
                catch {
                    // skip unreadable files
                }
            }
        }
        const admissionReceipts = createAdmissionReceipts("prompt", [guestMessage]);
        const guestTurn = {
            kind: "prompt",
            chatId: 0,
            replyToMessageId: 0,
            guestQueryId: guestMessage.guest_query_id,
            ...(guestInlineMessageId ? { guestInlineMessageId } : {}),
            sourceMessageIds: [],
            queueOrder: order,
            queueLane: "default",
            laneOrder: order,
            queuedAttachments: [],
            content,
            historyText: Turns.formatTelegramTurnStatusSummary(processed.rawText || text, processed.promptFiles, processed.handlerOutputs),
            statusSummary: Turns.truncateTelegramQueueSummary(processed.rawText || text),
            ...(admissionReceipts.length > 0 ? { admissionReceipts } : {}),
        };
        const items = deps.telegramQueueStore.getQueuedItems();
        Updates.assertTelegramUpdateExecutionCurrent(guestMessage);
        deps.telegramQueueStore.setQueuedItems(Queue.appendTelegramQueueItem(items, guestTurn));
        reportQueueAdmission([guestMessage], admissionReceipts);
        deps.updateStatus(ctx);
        requestDispatchNextQueuedTelegramTurn(ctx);
    };
    return Updates.createTelegramPairedUpdateRuntime({
        getAllowedUserId: deps.configStore.getAllowedUserId,
        getCurrentInstanceId: deps.getCurrentInstanceId,
        getMessageOwnership: deps.getMessageOwnership,
        getTargetOwnership: deps.getTargetOwnership,
        recordMessageOwnership: deps.recordMessageOwnership,
        handleTelegramTopicLifecycleUpdate,
        foreignOwnedUpdateForwarder: deps.foreignOwnedUpdateForwarder,
        persistAllowedUserId: deps.configStore.persistAllowedUserId,
        updateStatus: deps.updateStatus,
        removePendingMediaGroupMessages: deps.mediaGroupRuntime.removeMessages,
        flushPendingMediaGroupMessage: deps.mediaGroupRuntime.flushMessage,
        flushPendingTextGroupMessage: deps.textGroupRuntime.flushMessage,
        removeQueuedTelegramTurnsByMessageIds: deps.queueMutationRuntime.removeByMessageIds,
        applyQueuedTelegramTurnReactionByMessageId: deps.queueMutationRuntime.applyReactionByMessageId,
        answerCallbackQuery: deps.answerCallbackQuery,
        answerGuestQuery: deps.answerGuestQuery,
        handleAuthorizedTelegramCallbackQuery: callbackHandler,
        sendTextReply: deps.sendTextReply,
        handleAuthorizedTelegramMessage: async (message, ctx) => {
            const assertExecutionCurrent = Updates.createTelegramUpdateExecutionFenceGuard(message);
            assertExecutionCurrent();
            if (typeof message.message_thread_id === "number") {
                await deps.handleTelegramThreadTargetObserved?.({
                    chatId: message.chat.id,
                    threadId: message.message_thread_id,
                }, ctx);
                assertExecutionCurrent();
            }
            const text = Media.extractFirstTelegramMessageText([
                message,
            ]).trim();
            if (deps.threadStore && typeof message.message_thread_id !== "number") {
                await deps.threadStore.load();
                assertExecutionCurrent();
                if (deps.threadStore.getBotState().threadMode === "disabled") {
                    await textDispatch.handleMessage(message, ctx);
                    return;
                }
                const records = deps.threadStore.list();
                const bindings = getTelegramRoutableThreadRecords(records, deps.getLiveThreadTargets?.());
                const command = getKnownTelegramAllTabCommand(text);
                // Returning before deferral lets the admission worker terminally settle expired replay.
                if (command && command.name !== "thread" && isTelegramAllTabCommandExpired(message))
                    return;
                if (bindings.length > 0 && command && command.name !== "thread") {
                    if (await sendAllTabCommandChooser(command, text, message, {
                        replyToSource: true,
                    })) {
                        return;
                    }
                }
                if (bindings.length > 0 && !text.startsWith("/")) {
                    const probeTarget = bindings[0]?.target;
                    if (probeTarget?.threadId && deps.callApi) {
                        try {
                            await deps.callApi("sendChatAction", {
                                chat_id: probeTarget.chatId,
                                message_thread_id: probeTarget.threadId,
                                action: "typing",
                            });
                        }
                        catch (error) {
                            if (Threads.isTelegramTopicModeUnavailableError(error) ||
                                Threads.isTelegramTopicTargetStaleError(error)) {
                                deps.threadStore.setBotState({
                                    threadMode: "disabled",
                                    updatedAtMs: Date.now(),
                                    lastReconcileAction: "thread-mode-unavailable-threadless-prompt",
                                });
                                await deps.threadStore.persist();
                                assertExecutionCurrent();
                                await textDispatch.handleMessage(message, ctx);
                                return;
                            }
                            deps.recordRuntimeEvent?.("telegram", error, {
                                phase: "threadless-topic-capability-check",
                                chatId: probeTarget.chatId,
                                threadId: probeTarget.threadId,
                            });
                        }
                    }
                    await deps.sendTextReply(message.chat.id, message.message_id, "This bot is in threaded multi-instance mode. Send prompts in a bound Pi thread tab so they route to the right instance.");
                    return;
                }
            }
            await textDispatch.handleMessage(message, ctx);
        },
        handleAuthorizedTelegramEditedMessage: editRuntime.updateFromEditedMessage,
        handleAuthorizedTelegramGuestMessage,
        handleUnboundTelegramTopicMessage: (message, ctx) => {
            const operation = async () => {
                const assertExecutionCurrent = Updates.createTelegramUpdateExecutionFenceGuard(message);
                assertExecutionCurrent();
                if (!deps.threadStore) {
                    await textDispatch.handleMessage(message, ctx);
                    return;
                }
                await deps.threadStore.load();
                assertExecutionCurrent();
                if (deps.threadStore.getBotState().threadMode === "disabled") {
                    await textDispatch.handleMessage(message, ctx);
                    return;
                }
                const target = Updates.getTelegramMessageTarget(message);
                if (!target?.threadId) {
                    await textDispatch.handleMessage(message, ctx);
                    return;
                }
                const text = Media.extractFirstTelegramMessageText([
                    message,
                ]).trim();
                const instanceId = deps.getCurrentInstanceId?.();
                const leaderProfileKey = getLeaderTopicProfileKey(ctx, instanceId);
                const records = deps.threadStore.list();
                const routableRecords = getTelegramRoutableThreadRecords(records, deps.getLiveThreadTargets?.());
                const hasAnyRoutableThread = routableRecords.length > 0;
                const existing = records.find((r) => {
                    return (r.target.chatId === target.chatId &&
                        r.target.threadId === target.threadId);
                });
                if (existing) {
                    const isLeaderTopic = (instanceId && existing.instanceId === instanceId) ||
                        (!!leaderProfileKey && existing.profileKey === leaderProfileKey);
                    if (existing.status === "active" && isLeaderTopic) {
                        if (typeof existing.rerouteConfirmedAtMs !== "number") {
                            const nowMs = Date.now();
                            deps.threadStore.upsert({
                                ...existing,
                                updatedAtMs: nowMs,
                                rerouteConfirmedAtMs: nowMs,
                            });
                            await deps.threadStore.persist();
                            assertExecutionCurrent();
                        }
                        await textDispatch.handleMessage(message, ctx);
                        return;
                    }
                    if (existing.status === "starting") {
                        await deps.sendTextReply(target.chatId, message.message_id, "Instance " +
                            getTelegramThreadRecordLabel(existing, deps.getDisplayTitle) +
                            " is starting. Please wait…", { target });
                        return;
                    }
                    if (existing.status === "active") {
                        await deps.sendTextReply(target.chatId, message.message_id, "Instance " +
                            escapeHtml(getTelegramThreadRecordLabel(existing, deps.getDisplayTitle)) +
                            ` is not currently registered with the Telegram bus. This thread is preserved; retry shortly. If it does not recover, run ${Commands.formatTelegramPiCommandHtml("/telegram-connect")} in that Pi instance.`, { parseMode: "HTML", target });
                        return;
                    }
                    await deps.sendTextReply(target.chatId, message.message_id, "Topic " +
                        (existing.slot ?? "?") +
                        " is " +
                        existing.status +
                        ". Start a Pi instance to claim it.", { target });
                    return;
                }
                const deletedObservation = deps.threadStore
                    .listSyncObservations()
                    .find((observation) => observation.syncStatus === "deleted" &&
                    observation.target.chatId === target.chatId &&
                    observation.target.threadId === target.threadId);
                if (deletedObservation) {
                    deps.recordRuntimeEvent?.("inbound-worker", "Discarded update from a confirmed deleted Telegram thread", {
                        phase: "discard-deleted-thread",
                        chatId: target.chatId,
                        threadId: target.threadId,
                        messageId: message.message_id,
                    });
                    return;
                }
                const reservations = deps.threadStore.listReservations();
                const reservation = reservations.find((reservation) => reservation.target.chatId === target.chatId &&
                    reservation.target.threadId === target.threadId);
                if (reservation) {
                    await deps.sendTextReply(target.chatId, message.message_id, "Previous leader thread (" +
                        (reservation.slot ?? "?") +
                        "). Closing and deleting this old topic. Use the current thread tab instead.", { target });
                    await deleteReservedTelegramTopicThroughReconciler(deps, { chatId: target.chatId, threadId: target.threadId }, message.message_id);
                    return;
                }
                const command = getKnownTelegramAllTabCommand(text);
                if (command && hasAnyRoutableThread) {
                    if (await sendAllTabCommandChooser(command, text, message, {
                        target: { chatId: target.chatId, threadId: target.threadId },
                        replyToSource: true,
                    })) {
                        return;
                    }
                }
                if (leaderProfileKey && deps.callApi) {
                    const currentLeaderRecord = records.find((record) => {
                        if (record.status !== "active")
                            return false;
                        if (instanceId && record.instanceId === instanceId)
                            return true;
                        return record.profileKey === leaderProfileKey;
                    });
                    if (currentLeaderRecord &&
                        (currentLeaderRecord.target.chatId !== target.chatId ||
                            currentLeaderRecord.target.threadId !== target.threadId)) {
                        let currentLeaderIsStale = false;
                        try {
                            await deps.callApi("sendChatAction", {
                                chat_id: currentLeaderRecord.target.chatId,
                                message_thread_id: currentLeaderRecord.target.threadId,
                                action: "typing",
                            });
                        }
                        catch (error) {
                            currentLeaderIsStale =
                                Threads.isTelegramTopicTargetStaleError(error);
                            if (!currentLeaderIsStale)
                                throw error;
                        }
                        if (currentLeaderIsStale) {
                            const slot = deps.threadStore.allocateSlot(leaderProfileKey);
                            if (!slot) {
                                deps.threadStore.markStaleByTarget(currentLeaderRecord.target, "deleted", "Current leader thread is stale during unbound prompt routing.");
                                await deps.threadStore.persist();
                                assertExecutionCurrent();
                                await deps.sendTextReply(target.chatId, message.message_id, TELEGRAM_SLOT_CAPACITY_MESSAGE, { target });
                                return;
                            }
                            deps.threadStore.markStaleByTarget(currentLeaderRecord.target, "deleted", "Current leader thread is stale during unbound prompt routing.");
                            const threadName = getRestoredThreadName(currentLeaderRecord, slot);
                            deps.threadStore.upsert({
                                ...currentLeaderRecord,
                                profileKey: leaderProfileKey,
                                owner: {
                                    kind: "leader",
                                    cwd: typeof ctx.cwd === "string"
                                        ? ctx.cwd
                                        : undefined,
                                    instanceId,
                                },
                                target: { chatId: target.chatId, threadId: target.threadId },
                                status: "active",
                                updatedAtMs: Date.now(),
                                threadName,
                                instanceId,
                                slot,
                            });
                            await deps.threadStore.persist();
                            assertExecutionCurrent();
                            deps.setCurrentLeaderIdentity?.({
                                target: { chatId: target.chatId, threadId: target.threadId },
                                slot,
                                threadName,
                            });
                            deps.recordRuntimeEvent?.("bus", "Bus leader reclaimed stale-current unbound thread", {
                                phase: "leader-topic-unbound-stale-reclaim",
                                chatId: target.chatId,
                                threadId: target.threadId,
                                staleThreadId: currentLeaderRecord.target.threadId,
                                slot,
                                profileKey: leaderProfileKey,
                            });
                            await textDispatch.handleMessage(message, ctx);
                            return;
                        }
                    }
                }
                if (leaderProfileKey &&
                    !hasActiveLeaderTopic(records, leaderProfileKey, instanceId) &&
                    !hasAnyRoutableThread) {
                    const priorLeaderRecord = deps.threadStore.getByProfileKey(leaderProfileKey);
                    const priorLeaderIdentity = deps.threadStore.getIdentityByProfileKey(leaderProfileKey);
                    const slot = deps.threadStore.allocateSlot(leaderProfileKey, priorLeaderRecord?.slot ?? priorLeaderIdentity?.slot);
                    if (!slot) {
                        await deps.sendTextReply(target.chatId, message.message_id, TELEGRAM_SLOT_CAPACITY_MESSAGE, { target });
                        return;
                    }
                    const identityThreadName = priorLeaderIdentity?.threadName &&
                        Threads.isTelegramTopicThreadNameValidForSlot(priorLeaderIdentity.threadName, slot)
                        ? priorLeaderIdentity.threadName
                        : undefined;
                    const threadName = priorLeaderRecord?.threadName ??
                        identityThreadName ??
                        Threads.chooseTelegramThreadName({ slot }) ??
                        "Pi";
                    deps.threadStore.upsert({
                        profileKey: leaderProfileKey,
                        owner: {
                            kind: "leader",
                            cwd: typeof ctx.cwd === "string"
                                ? ctx.cwd
                                : undefined,
                            instanceId,
                        },
                        target: { chatId: target.chatId, threadId: target.threadId },
                        status: "active",
                        createdAtMs: priorLeaderRecord?.createdAtMs ?? Date.now(),
                        updatedAtMs: Date.now(),
                        threadName,
                        instanceId,
                        slot,
                    });
                    await deps.threadStore.persist();
                    assertExecutionCurrent();
                    deps.setCurrentLeaderIdentity?.({
                        target: { chatId: target.chatId, threadId: target.threadId },
                        slot,
                        threadName,
                    });
                    deps.recordRuntimeEvent?.("bus", "Bus leader reclaimed unbound thread", {
                        phase: "leader-topic-reclaim",
                        chatId: target.chatId,
                        threadId: target.threadId,
                        slot,
                        profileKey: leaderProfileKey,
                    });
                    await textDispatch.handleMessage(message, ctx);
                    return;
                }
                await sendUnboundRerouteChooser(message, ctx);
                return;
            };
            if (!deps.runWorkspaceOperation)
                return operation();
            return deps.runWorkspaceOperation({
                operationId: `workspace-unbound:${message.chat.id}:${message.message_id}`,
                operationKind: "workspace.route-unbound-thread",
                scopes: [{ kind: "profile" }],
            }, operation);
        },
    });
}
export function createTelegramAssistantOutputAuthorityRuntime(deps) {
    const getCurrentTarget = () => {
        const preferred = deps.getPreferredTarget();
        if (preferred)
            return { ...preferred };
        const chatId = deps.getFallbackChatId();
        return chatId === undefined ? undefined : { chatId };
    };
    return {
        captureAuthority() {
            const target = getCurrentTarget();
            const directEpoch = deps.ownsDirect() ? deps.getDirectEpoch() : undefined;
            const followerGeneration = deps.isFollowerRegistered()
                ? deps.getFollowerGeneration()
                : undefined;
            return {
                transportStamp: deps.getTransportStamp(),
                route: directEpoch !== undefined
                    ? "direct"
                    : followerGeneration !== undefined
                        ? "follower"
                        : "none",
                directEpoch,
                followerGeneration,
                target,
            };
        },
        isAuthorityActive(authority) {
            if (!deps.isTransportStampActive(authority.transportStamp))
                return false;
            const target = getCurrentTarget();
            if (authority.target === undefined ||
                target?.chatId !== authority.target.chatId ||
                target?.threadId !== authority.target.threadId) {
                return false;
            }
            if (authority.route === "direct") {
                return (deps.ownsDirect() && deps.getDirectEpoch() === authority.directEpoch);
            }
            if (authority.route === "follower") {
                return (!deps.ownsDirect() &&
                    deps.isFollowerRegistered() &&
                    deps.getFollowerGeneration() === authority.followerGeneration);
            }
            return false;
        },
        canDeliver() {
            return deps.ownsDirect() || deps.isFollowerRegistered();
        },
    };
}
