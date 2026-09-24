/**
 * Telegram status menu UI helpers
 * Zones: telegram ui, status controls, menu composition
 * Owns status-menu payloads, status callback handling, and status-menu message rendering
 */
import { formatTelegramCommandEmojiPrefix } from "./commands.js";
import { getTelegramSectionMainMenuRows, } from "./sections.js";
import { formatStatusButtonLabel, } from "./menu-model.js";
import { getCanonicalModelId, } from "./model.js";
function isTelegramStatusMenuCallbackAction(data, action) {
    return data === `menu:${action}` || data === `status:${action}`;
}
function applyTelegramMenuRenderPayload(state, payload) {
    state.mode = payload.nextMode;
    return payload;
}
async function editTelegramMenuMessage(state, payload, deps) {
    const appliedPayload = applyTelegramMenuRenderPayload(state, payload);
    await deps.editInteractiveMessage(state.chatId, state.messageId, appliedPayload.text, appliedPayload.mode, appliedPayload.replyMarkup);
}
function sendTelegramMenuMessage(state, payload, deps) {
    const appliedPayload = applyTelegramMenuRenderPayload(state, payload);
    return deps.sendInteractiveMessage(state.chatId, appliedPayload.text, appliedPayload.mode, appliedPayload.replyMarkup, state.threadId !== undefined
        ? { target: { chatId: state.chatId, threadId: state.threadId } }
        : undefined);
}
export async function openTelegramStatusMenu(deps) {
    const state = await deps.getModelMenuState();
    const messageId = await deps.sendStatusMenu(state, deps.buildStatusHtml(), deps.getActiveModel(), deps.getThinkingLevel(), deps.getQueueItemCount?.() ?? 0);
    if (messageId === undefined)
        return;
    state.messageId = messageId;
    state.mode = "status";
    deps.storeModelMenuState(state);
}
export async function handleTelegramStatusMenuCallbackAction(callbackQueryId, data, activeModel, deps) {
    if (isTelegramStatusMenuCallbackAction(data, "model")) {
        await deps.updateModelMenuMessage();
        await deps.answerCallbackQuery(callbackQueryId);
        return true;
    }
    if (isTelegramStatusMenuCallbackAction(data, "settings")) {
        if (!deps.updateSettingsMenuMessage)
            return false;
        await deps.updateSettingsMenuMessage();
        await deps.answerCallbackQuery(callbackQueryId);
        return true;
    }
    if (!isTelegramStatusMenuCallbackAction(data, "thinking"))
        return false;
    if (deps.isVoiceReplyActive?.()) {
        await deps.answerCallbackQuery(callbackQueryId, "Thinking controls are disabled during voice replies.");
        return true;
    }
    if (!activeModel?.reasoning) {
        await deps.answerCallbackQuery(callbackQueryId, "This model has no reasoning controls.");
        return true;
    }
    await deps.updateThinkingMenuMessage();
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
}
export function buildStatusReplyMarkup(activeModel, currentThinkingLevel, queueItemCount = 0, sectionRegistry, isVoiceReplyActive) {
    const rows = [];
    rows.push([
        {
            text: formatStatusButtonLabel(`${formatTelegramCommandEmojiPrefix("model")}Model`, activeModel ? getCanonicalModelId(activeModel) : "unknown"),
            callback_data: "menu:model",
        },
    ]);
    if (activeModel?.reasoning && !isVoiceReplyActive) {
        rows.push([
            {
                text: formatStatusButtonLabel(`${formatTelegramCommandEmojiPrefix("thinking")}Thinking`, currentThinkingLevel),
                callback_data: "menu:thinking",
            },
        ]);
    }
    rows.push([
        {
            text: `${queueItemCount === 0 ? "⌛" : "⏳"} Queue: ${queueItemCount}`,
            callback_data: "menu:queue",
        },
    ]);
    if (sectionRegistry) {
        const sectionRows = getTelegramSectionMainMenuRows(sectionRegistry);
        for (const row of sectionRows) {
            rows.push([row]);
        }
    }
    rows.push([
        {
            text: "⚙️ Settings",
            callback_data: "menu:settings",
        },
    ]);
    return { inline_keyboard: rows };
}
export function buildTelegramStatusMenuRenderPayload(statusText, activeModel, currentThinkingLevel, queueItemCount = 0, sectionRegistry, isVoiceReplyActive) {
    return {
        nextMode: "status",
        text: statusText,
        mode: "html",
        replyMarkup: buildStatusReplyMarkup(activeModel, currentThinkingLevel, queueItemCount, sectionRegistry, isVoiceReplyActive),
    };
}
export async function updateTelegramStatusMessage(state, statusText, activeModel, currentThinkingLevel, deps, queueItemCount = 0, sectionRegistry, isVoiceReplyActive) {
    await editTelegramMenuMessage(state, buildTelegramStatusMenuRenderPayload(statusText, activeModel, currentThinkingLevel, queueItemCount, sectionRegistry, isVoiceReplyActive), deps);
}
export function sendTelegramStatusMessage(state, statusText, activeModel, currentThinkingLevel, deps, queueItemCount = 0, sectionRegistry, isVoiceReplyActive) {
    return sendTelegramMenuMessage(state, buildTelegramStatusMenuRenderPayload(statusText, activeModel, currentThinkingLevel, queueItemCount, sectionRegistry, isVoiceReplyActive), deps);
}
