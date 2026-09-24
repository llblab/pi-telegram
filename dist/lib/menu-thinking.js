/**
 * Telegram thinking menu UI helpers
 * Zones: telegram ui, thinking controls, menu composition
 * Owns thinking-menu text, reply markup, callback handling, and thinking-menu message rendering
 */
import { isThinkingLevel, THINKING_LEVELS, } from "./model.js";
function parseTelegramThinkingMenuCallbackAction(data) {
    if (!data?.startsWith("thinking:set:"))
        return undefined;
    return { kind: "thinking:set", level: data.slice("thinking:set:".length) };
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
export async function handleTelegramThinkingMenuCallbackAction(callbackQueryId, data, activeModel, deps) {
    const action = parseTelegramThinkingMenuCallbackAction(data);
    if (!action)
        return false;
    if (!isThinkingLevel(action.level)) {
        await deps.answerCallbackQuery(callbackQueryId, "Invalid thinking level.");
        return true;
    }
    if (deps.isVoiceReplyActive?.()) {
        await deps.answerCallbackQuery(callbackQueryId, "Thinking controls are disabled during voice replies.");
        return true;
    }
    if (!activeModel?.reasoning) {
        await deps.answerCallbackQuery(callbackQueryId, "This model has no reasoning controls.");
        return true;
    }
    deps.setThinkingLevel(action.level);
    await deps.updateStatusMessage();
    await deps.answerCallbackQuery(callbackQueryId, `Thinking: ${deps.getCurrentThinkingLevel()}`);
    return true;
}
export function buildThinkingMenuText() {
    return "<b>🧠 Choose a thinking level:</b>";
}
export function buildThinkingMenuReplyMarkup(currentThinkingLevel) {
    const rows = [[{ text: "⬆️ Main menu", callback_data: "menu:back" }]];
    const levelButtons = THINKING_LEVELS.map((level) => ({
        text: level === currentThinkingLevel ? `🟢 ${level}` : level,
        callback_data: `thinking:set:${level}`,
    }));
    rows.push(levelButtons.slice(0, 1), levelButtons.slice(1, 4), levelButtons.slice(4, 7));
    return { inline_keyboard: rows };
}
export function buildTelegramThinkingMenuRenderPayload(_activeModel, currentThinkingLevel) {
    return {
        nextMode: "thinking",
        text: buildThinkingMenuText(),
        mode: "html",
        replyMarkup: buildThinkingMenuReplyMarkup(currentThinkingLevel),
    };
}
export async function openTelegramThinkingMenu(deps) {
    if (deps.isVoiceReplyActive?.())
        return;
    const state = await deps.getModelMenuState();
    const messageId = await sendTelegramMenuMessage(state, buildTelegramThinkingMenuRenderPayload(deps.getActiveModel(), deps.getThinkingLevel()), deps);
    if (messageId === undefined)
        return;
    state.messageId = messageId;
    state.mode = "thinking";
    deps.storeModelMenuState(state);
}
export async function updateTelegramThinkingMenuMessage(state, activeModel, currentThinkingLevel, deps) {
    if (deps.isVoiceReplyActive?.())
        return;
    await editTelegramMenuMessage(state, buildTelegramThinkingMenuRenderPayload(activeModel, currentThinkingLevel), deps);
}
