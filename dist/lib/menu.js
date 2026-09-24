/**
 * Telegram menu and inline-keyboard rendering helpers
 * Zones: telegram ui, controls, status menu
 * Owns app-menu/status state, inline UI text, and callback composition while model/thinking/queue menu details live in dedicated domains
 */
import { createTelegramModelMenuStateBuilder, handleTelegramModelMenuCallbackAction, openTelegramModelMenu, sendTelegramModelMenuMessage, updateTelegramModelMenuMessage, } from "./menu-model.js";
import { handleTelegramStatusMenuCallbackAction, openTelegramStatusMenu, sendTelegramStatusMessage, updateTelegramStatusMessage, } from "./menu-status.js";
import { handleTelegramThinkingMenuCallbackAction, openTelegramThinkingMenu, updateTelegramThinkingMenuMessage, } from "./menu-thinking.js";
import { handleTelegramSectionCallback, handleTelegramSectionOpen, handleTelegramSectionSettingsOpen, parseTelegramSectionCallback, } from "./sections.js";
export { applyTelegramModelPageSelection, applyTelegramModelScopeSelection, buildModelMenuReplyMarkup, buildModelPageMenuReplyMarkup, buildTelegramModelCallbackPlan, buildTelegramModelMenuRenderPayload, buildTelegramModelMenuState, buildTelegramModelMenuStateRuntime, buildTelegramModelPageMenuRenderPayload, createTelegramModelMenuRuntime, createTelegramModelMenuStateBuilder, formatScopedModelButtonText, getModelMenuItems, getStoredTelegramModelMenuState, getTelegramModelMenuPage, getTelegramModelSelection, handleTelegramModelMenuCallbackAction, MODEL_MENU_TITLE, MODEL_PAGE_MENU_TITLE, openTelegramModelMenu, pruneStoredTelegramModelMenus, resolveCachedTelegramModelMenuInputs, sendTelegramModelMenuMessage, storeTelegramModelMenuState, TELEGRAM_MODEL_PAGE_SIZE, updateTelegramModelMenuMessage, } from "./menu-model.js";
export { buildStatusReplyMarkup, buildTelegramStatusMenuRenderPayload, handleTelegramStatusMenuCallbackAction, openTelegramStatusMenu, sendTelegramStatusMessage, updateTelegramStatusMessage, } from "./menu-status.js";
export { buildTelegramThinkingMenuRenderPayload, buildThinkingMenuReplyMarkup, buildThinkingMenuText, handleTelegramThinkingMenuCallbackAction, openTelegramThinkingMenu, updateTelegramThinkingMenuMessage, } from "./menu-thinking.js";
export function parseTelegramMenuCallbackAction(data) {
    if (data === "menu:model" || data === "status:model") {
        return { kind: "status", action: "model" };
    }
    if (data === "menu:thinking" || data === "status:thinking") {
        return { kind: "status", action: "thinking" };
    }
    if (data === "menu:queue" || data === "status:queue") {
        return { kind: "status", action: "queue" };
    }
    if (data === "menu:settings" || data === "status:settings") {
        return { kind: "status", action: "settings" };
    }
    if (data?.startsWith("thinking:set:")) {
        return {
            kind: "thinking:set",
            level: data.slice("thinking:set:".length),
        };
    }
    if (data?.startsWith("model:")) {
        const [, action, value] = data.split(":");
        if (action === "noop" ||
            action === "scope" ||
            action === "page" ||
            action === "pages" ||
            action === "open" ||
            action === "pick" ||
            action === "pick-selected" ||
            action === "scope-enable" ||
            action === "scope-disable" ||
            action === "scope-toggle") {
            return { kind: "model", action, value };
        }
    }
    return { kind: "ignore" };
}
export async function handleTelegramMenuCallbackEntry(callbackQueryId, data, state, deps) {
    if (!data) {
        await deps.answerCallbackQuery(callbackQueryId);
        return;
    }
    if (!state) {
        await deps.answerCallbackQuery(callbackQueryId, "Interactive message expired.");
        return;
    }
    const handled = (await deps.handleStatusAction()) ||
        (await deps.handleThinkingAction()) ||
        (await deps.handleModelAction());
    if (!handled) {
        await deps.answerCallbackQuery(callbackQueryId);
    }
}
export async function handleStoredTelegramMenuCallback(query, deps) {
    const state = deps.getStoredModelMenuState(query.message?.message_id, query.message?.chat?.id);
    await handleTelegramMenuCallbackEntry(query.id, query.data, state, {
        handleStatusAction: async () => {
            if (!state)
                return false;
            return deps.handleStatusAction(state);
        },
        handleThinkingAction: async () => {
            if (!state)
                return false;
            return deps.handleThinkingAction(state);
        },
        handleModelAction: async () => {
            if (!state)
                return false;
            return deps.handleModelAction(state);
        },
        answerCallbackQuery: deps.answerCallbackQuery,
    });
}
export function createTelegramMenuCallbackHandler(deps) {
    return (query, ctx) => handleTelegramMenuCallbackRuntime(query, ctx, deps);
}
export function createTelegramMenuCallbackHandlerForContext(deps) {
    return createTelegramMenuCallbackHandler({
        getStoredModelMenuState: deps.getStoredModelMenuState,
        getActiveModel: deps.getActiveModel,
        getThinkingLevel: deps.getThinkingLevel,
        setThinkingLevel: deps.setThinkingLevel,
        updateStatus: deps.updateStatus,
        updateModelMenuMessage: deps.updateModelMenuMessage,
        updateThinkingMenuMessage: deps.updateThinkingMenuMessage,
        updateStatusMessage: deps.updateStatusMessage,
        updateSettingsMenuMessage: deps.updateSettingsMenuMessage,
        answerCallbackQuery: deps.answerCallbackQuery,
        isIdle: deps.isIdle,
        hasAbortHandler: deps.hasAbortHandler,
        hasActiveToolExecutions: () => deps.getActiveToolExecutions() > 0,
        persistScopedModelPatterns: deps.persistScopedModelPatterns,
        setModel: deps.setModel,
        setCurrentModel: deps.setCurrentModel,
        stagePendingModelSwitch: deps.stagePendingModelSwitch,
        restartInterruptedTelegramTurn: deps.restartInterruptedTelegramTurn,
        sectionRegistry: deps.sectionRegistry,
        editInteractiveMessage: deps.editInteractiveMessage,
        sendInteractiveMessage: deps.sendInteractiveMessage,
        sendSectionRichMessage: deps.sendSectionRichMessage,
        enqueueSectionPrompt: deps.enqueueSectionPrompt,
        deleteMessage: deps.deleteMessage,
    });
}
export async function handleTelegramMenuCallbackRuntime(query, ctx, deps) {
    if (query.data === "menu:back") {
        const state = deps.getStoredModelMenuState(query.message?.message_id, query.message?.chat?.id);
        if (!state) {
            await deps.answerCallbackQuery(query.id, "Interactive message expired.");
            return;
        }
        await deps.updateStatusMessage(state, ctx);
        await deps.answerCallbackQuery(query.id);
        return;
    }
    // Section callbacks: dispatch before built-in menu handling
    if (deps.sectionRegistry && query.data?.startsWith("section:")) {
        const parsed = parseTelegramSectionCallback(query.data);
        if (parsed) {
            const message = query.message;
            const chatId = message?.chat?.id;
            const messageId = message?.message_id;
            const target = typeof chatId === "number"
                ? typeof message?.message_thread_id === "number"
                    ? { chatId, threadId: message.message_thread_id }
                    : { chatId }
                : undefined;
            if (typeof chatId === "number" && typeof messageId === "number") {
                const { token, action, payload } = parsed;
                if (action === "open") {
                    const state = deps.getStoredModelMenuState(messageId, chatId);
                    if (!state) {
                        await deps.answerCallbackQuery(query.id, "Interactive message expired.");
                        return;
                    }
                    const handled = await handleTelegramSectionOpen(deps.sectionRegistry, token, chatId, messageId, query.id, {
                        answerCallbackQuery: deps.answerCallbackQuery,
                        target,
                        editInteractiveMessage: deps.editInteractiveMessage ?? (async () => { }),
                        sendInteractiveMessage: deps.sendInteractiveMessage ?? (async () => undefined),
                        sendRichMessage: deps.sendSectionRichMessage ?? (async () => {
                            throw new Error("Rich Message delivery is unavailable");
                        }),
                        enqueuePrompt: deps.enqueueSectionPrompt
                            ? (prompt) => deps.enqueueSectionPrompt(prompt, ctx, target, query)
                            : async () => { },
                        deleteMessage: deps.deleteMessage ?? (async () => { }),
                    });
                    if (handled)
                        return;
                }
                else if (action === "settings") {
                    if (typeof chatId === "number" && typeof messageId === "number") {
                        const handled = await handleTelegramSectionSettingsOpen(deps.sectionRegistry, token, chatId, messageId, query.id, {
                            answerCallbackQuery: deps.answerCallbackQuery,
                            target,
                            editInteractiveMessage: deps.editInteractiveMessage ?? (async () => { }),
                            sendInteractiveMessage: deps.sendInteractiveMessage ?? (async () => undefined),
                            sendRichMessage: deps.sendSectionRichMessage ?? (async () => {
                                throw new Error("Rich Message delivery is unavailable");
                            }),
                            enqueuePrompt: deps.enqueueSectionPrompt
                                ? (prompt) => deps.enqueueSectionPrompt(prompt, ctx, target, query)
                                : async () => { },
                            deleteMessage: deps.deleteMessage ?? (async () => { }),
                        });
                        if (handled)
                            return;
                    }
                }
                else {
                    const handled = await handleTelegramSectionCallback(deps.sectionRegistry, token, action, payload, chatId, messageId, query.id, {
                        answerCallbackQuery: deps.answerCallbackQuery,
                        target,
                        editInteractiveMessage: deps.editInteractiveMessage ?? (async () => { }),
                        sendInteractiveMessage: deps.sendInteractiveMessage ?? (async () => undefined),
                        sendRichMessage: deps.sendSectionRichMessage ?? (async () => {
                            throw new Error("Rich Message delivery is unavailable");
                        }),
                        enqueuePrompt: deps.enqueueSectionPrompt
                            ? (prompt) => deps.enqueueSectionPrompt(prompt, ctx, target, query)
                            : async () => { },
                        deleteMessage: deps.deleteMessage ?? (async () => { }),
                    });
                    if (handled)
                        return;
                }
            }
        }
    }
    await handleStoredTelegramMenuCallback(query, {
        getStoredModelMenuState: deps.getStoredModelMenuState,
        handleStatusAction: async (state) => handleTelegramStatusMenuCallbackAction(query.id, query.data, deps.getActiveModel(ctx), {
            updateModelMenuMessage: () => deps.updateModelMenuMessage(state, ctx),
            updateThinkingMenuMessage: () => deps.updateThinkingMenuMessage(state, ctx),
            updateSettingsMenuMessage: () => deps.updateSettingsMenuMessage?.(state, ctx) ?? Promise.resolve(),
            answerCallbackQuery: deps.answerCallbackQuery,
            isVoiceReplyActive: deps.isVoiceReplyActive,
        }),
        handleThinkingAction: async (state) => handleTelegramThinkingMenuCallbackAction(query.id, query.data, deps.getActiveModel(ctx), {
            setThinkingLevel: (level) => {
                deps.setThinkingLevel(level);
                deps.updateStatus(ctx);
            },
            getCurrentThinkingLevel: deps.getThinkingLevel,
            updateStatusMessage: () => deps.updateStatusMessage(state, ctx),
            answerCallbackQuery: deps.answerCallbackQuery,
            isVoiceReplyActive: deps.isVoiceReplyActive,
        }),
        handleModelAction: async (state) => {
            try {
                return await handleTelegramModelMenuCallbackAction(query.id, {
                    data: query.data,
                    state,
                    activeModel: deps.getActiveModel(ctx),
                    currentThinkingLevel: deps.getThinkingLevel(),
                    isIdle: deps.isIdle(ctx),
                    canRestartBusyRun: deps.hasAbortHandler(),
                    hasActiveToolExecutions: deps.hasActiveToolExecutions(),
                }, {
                    updateModelMenuMessage: () => deps.updateModelMenuMessage(state, ctx),
                    updateStatusMessage: () => deps.updateStatusMessage(state, ctx),
                    answerCallbackQuery: deps.answerCallbackQuery,
                    persistScopedModelPatterns: deps.persistScopedModelPatterns
                        ? (patterns) => deps.persistScopedModelPatterns(patterns, ctx)
                        : undefined,
                    setModel: deps.setModel,
                    setCurrentModel: (model) => deps.setCurrentModel(model, ctx),
                    setThinkingLevel: (level) => {
                        deps.setThinkingLevel(level);
                        deps.updateStatus(ctx);
                    },
                    stagePendingModelSwitch: (selection, continuationTurn) => {
                        deps.stagePendingModelSwitch(selection, ctx, continuationTurn);
                    },
                    restartInterruptedTelegramTurn: (selection, continuationTurn) => deps.restartInterruptedTelegramTurn(selection, ctx, continuationTurn),
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                await deps.answerCallbackQuery(query.id, message);
                return true;
            }
        },
        answerCallbackQuery: deps.answerCallbackQuery,
    });
}
export function createTelegramMenuActionRuntimeWithStateBuilder(deps) {
    return createTelegramMenuActionRuntime({
        getModelMenuState: createTelegramModelMenuStateBuilder({
            runtime: deps.runtime,
            createSettingsManager: deps.createSettingsManager,
            getActiveModel: deps.getActiveModel,
        }),
        getActiveModel: deps.getActiveModel,
        getThinkingLevel: deps.getThinkingLevel,
        getQueueItemCount: deps.getQueueItemCount,
        buildStatusHtml: deps.buildStatusHtml,
        storeModelMenuState: deps.storeModelMenuState,
        isIdle: deps.isIdle,
        canOfferInFlightModelSwitch: deps.canOfferInFlightModelSwitch,
        sendTextReply: deps.sendTextReply,
        editInteractiveMessage: deps.editInteractiveMessage,
        sendInteractiveMessage: deps.sendInteractiveMessage,
        sectionRegistry: deps.sectionRegistry,
    });
}
export function createTelegramMenuActionRuntime(deps) {
    return {
        updateModelMenuMessage: (state, ctx) => updateTelegramModelMenuMessage(state, deps.getActiveModel(ctx), deps),
        updateThinkingMenuMessage: (state, ctx) => updateTelegramThinkingMenuMessage(state, deps.getActiveModel(ctx), deps.getThinkingLevel(), deps),
        updateStatusMessage: (state, ctx) => updateTelegramStatusMessage(state, deps.buildStatusHtml(ctx), deps.getActiveModel(ctx), deps.getThinkingLevel(), deps, deps.getQueueItemCount?.() ?? 0, deps.sectionRegistry, deps.isVoiceReplyActive?.()),
        sendStatusMessage: (chatId, replyToMessageId, ctx, threadId) => openTelegramStatusMenu({
            isIdle: () => deps.isIdle(ctx),
            sendBusyMessage: async () => {
                await deps.sendTextReply(chatId, replyToMessageId, "<b>⏳ Cannot open status while Pi is busy. Send /abort, /next, or /stop.</b>", { target: { chatId, threadId }, parseMode: "HTML" });
            },
            getModelMenuState: () => deps.getModelMenuState(chatId, ctx, threadId),
            buildStatusHtml: () => deps.buildStatusHtml(ctx),
            getActiveModel: () => deps.getActiveModel(ctx),
            getThinkingLevel: deps.getThinkingLevel,
            getQueueItemCount: deps.getQueueItemCount,
            sendStatusMenu: (state, statusHtml, activeModel, thinkingLevel, queueItemCount) => sendTelegramStatusMessage(state, statusHtml, activeModel, thinkingLevel, deps, queueItemCount, deps.sectionRegistry, deps.isVoiceReplyActive?.()),
            storeModelMenuState: deps.storeModelMenuState,
        }),
        openModelMenu: (chatId, replyToMessageId, ctx, threadId) => openTelegramModelMenu({
            isIdle: () => deps.isIdle(ctx),
            canOfferInFlightModelSwitch: () => deps.canOfferInFlightModelSwitch(ctx),
            sendBusyMessage: async () => {
                await deps.sendTextReply(chatId, replyToMessageId, "<b>⏳ Cannot switch model while Pi is busy. Send /abort, /next, or /stop.</b>", { target: { chatId, threadId }, parseMode: "HTML" });
            },
            sendNoModelsMessage: async () => {
                await deps.sendTextReply(chatId, replyToMessageId, "<b>🚫 No available models with configured auth.</b>", { target: { chatId, threadId }, parseMode: "HTML" });
            },
            getModelMenuState: () => deps.getModelMenuState(chatId, ctx, threadId),
            getActiveModel: () => deps.getActiveModel(ctx),
            sendModelMenu: (state, activeModel) => sendTelegramModelMenuMessage(state, activeModel, deps),
            storeModelMenuState: deps.storeModelMenuState,
        }),
        openThinkingMenu: (chatId, _replyToMessageId, ctx) => openTelegramThinkingMenu({
            getModelMenuState: () => deps.getModelMenuState(chatId, ctx),
            getActiveModel: () => deps.getActiveModel(ctx),
            getThinkingLevel: deps.getThinkingLevel,
            storeModelMenuState: deps.storeModelMenuState,
            editInteractiveMessage: deps.editInteractiveMessage,
            sendInteractiveMessage: deps.sendInteractiveMessage,
            isVoiceReplyActive: deps.isVoiceReplyActive,
        }),
    };
}
