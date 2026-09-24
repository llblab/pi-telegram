/**
 * Telegram Extension Sections registry and callback routing
 * Zones: telegram ui, extension platform, callback routing
 * Owns section registration, global registry binding, token mapping, main-menu/settings row injection, and section callback dispatch
 */
import { assertTelegramCallbackData, } from "./keyboard.js";
const SECTION_REGISTRY_KEY = "__piTelegramSectionRegistry__";
function buildTelegramSectionContext(sectionId, token, chatId, messageId, callbackQueryId, deps, backCallback = "menu:back", backLabel = "⬆️ Main menu") {
    return {
        sectionId,
        chatId,
        messageId,
        answerCallback: (text) => callbackQueryId
            ? deps.answerCallbackQuery(callbackQueryId, text)
            : Promise.resolve(),
        edit: (view) => messageId !== undefined
            ? deps.editInteractiveMessage(chatId, messageId, view.text, view.parseMode ?? "html", prependBackRow(view.replyMarkup, backCallback, backLabel))
            : Promise.resolve(),
        open: (view) => deps
            .sendInteractiveMessage(chatId, view.text, view.parseMode ?? "html", view.replyMarkup ?? { inline_keyboard: [] }, deps.target ? { target: deps.target } : undefined)
            .then(() => { }),
        openRich: (message) => deps.sendRichMessage(chatId, message, deps.target ? { target: deps.target } : undefined).then(() => { }),
        enqueuePrompt: deps.enqueuePrompt,
        callbackData: (action, payload) => buildTelegramSectionCallbackData(token, action, payload),
        deleteMessage: () => messageId !== undefined
            ? deps.deleteMessage(chatId, messageId)
            : Promise.resolve(),
    };
}
function buildTelegramSectionCallbackContext(sectionId, token, chatId, messageId, action, payload, callbackQueryId, deps, backCallback = "menu:back", backLabel = "⬆️ Back") {
    return {
        sectionId,
        chatId,
        messageId,
        action,
        payload,
        answerCallback: (text) => deps.answerCallbackQuery(callbackQueryId, text),
        edit: (view) => messageId !== undefined
            ? deps.editInteractiveMessage(chatId, messageId, view.text, view.parseMode ?? "html", prependBackRow(view.replyMarkup, backCallback, backLabel))
            : Promise.resolve(),
        open: (view) => deps
            .sendInteractiveMessage(chatId, view.text, view.parseMode ?? "html", view.replyMarkup ?? { inline_keyboard: [] }, deps.target ? { target: deps.target } : undefined)
            .then(() => { }),
        openRich: (message) => deps.sendRichMessage(chatId, message, deps.target ? { target: deps.target } : undefined).then(() => { }),
        enqueuePrompt: deps.enqueuePrompt,
        callbackData: (action, payload) => buildTelegramSectionCallbackData(token, action, payload),
        deleteMessage: () => messageId !== undefined
            ? deps.deleteMessage(chatId, messageId)
            : Promise.resolve(),
    };
}
// --- GlobalThis Bridge ---
/** @internal */
export function setGlobalTelegramSectionRegistry(registry) {
    globalThis[SECTION_REGISTRY_KEY] = registry;
}
/** @internal */
export function createAndBindTelegramSectionRegistry() {
    const registry = createTelegramExtensionSectionRegistry();
    setGlobalTelegramSectionRegistry(registry);
    return registry;
}
/**
 * Register a Telegram Extension Section from any pi extension.
 * Returns a disposer. Throws if no section registry is active.
 */
export function registerTelegramSection(section) {
    const registry = globalThis[SECTION_REGISTRY_KEY];
    if (!registry) {
        throw new Error("Telegram section registry not available. Is pi-telegram loaded and initialized?");
    }
    return registry.register(section);
}
/**
 * Get current section diagnostics. Returns empty array when registry is absent.
 * @internal
 */
export function getTelegramSectionDiagnostics() {
    const registry = globalThis[SECTION_REGISTRY_KEY];
    return registry ? registry.getDiagnostics() : [];
}
// --- Registry ---
const BACK_NAV_ROW = {
    text: "⬆️ Back",
};
function sectionErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function buildTelegramSectionCallbackData(token, action, payload) {
    const data = payload
        ? `section:${token}:${action}:${payload}`
        : `section:${token}:${action}`;
    return assertTelegramCallbackData(data, "Telegram section callback_data");
}
function prependBackRow(replyMarkup, backCallback, backLabel) {
    const backRow = {
        text: backLabel ?? BACK_NAV_ROW.text,
        callback_data: backCallback,
    };
    if (!replyMarkup || replyMarkup.inline_keyboard.length === 0) {
        return { inline_keyboard: [[backRow]] };
    }
    const firstRow = replyMarkup.inline_keyboard[0];
    const firstIsBack = firstRow.length === 1 && firstRow[0].callback_data === backCallback;
    if (firstIsBack)
        return replyMarkup;
    return {
        inline_keyboard: [[backRow], ...replyMarkup.inline_keyboard],
    };
}
/** @internal */
export function createTelegramExtensionSectionRegistry() {
    const sections = new Map();
    const errors = new Map();
    let nextToken = 0;
    const register = (section) => {
        const duplicate = [...sections.values()].find((s) => s.id === section.id);
        if (duplicate) {
            throw new Error(`Telegram section id already registered: ${section.id}`);
        }
        const token = String(nextToken++);
        const registered = {
            id: section.id,
            token,
            label: section.label,
            order: section.order ?? 0,
            registration: section,
        };
        sections.set(token, registered);
        return () => {
            sections.delete(token);
            errors.delete(token);
        };
    };
    const getSections = () => {
        return [...sections.values()].sort((a, b) => {
            if (a.order !== b.order)
                return a.order - b.order;
            return a.id.localeCompare(b.id);
        });
    };
    const getByToken = (token) => {
        return sections.get(token);
    };
    const getDiagnostics = () => {
        return getSections().map((s) => ({
            id: s.id,
            token: s.token,
            label: s.label,
            status: errors.has(s.token) ? "error" : "active",
            lastError: errors.get(s.token)?.message,
        }));
    };
    const recordError = (token, message, source = "runtime") => {
        if (sections.has(token))
            errors.set(token, { message, source });
    };
    const clearError = (token, source) => {
        const current = errors.get(token);
        if (!source || !current || current.source === source)
            errors.delete(token);
    };
    const clear = () => {
        sections.clear();
        errors.clear();
        nextToken = 0;
    };
    return {
        register,
        getSections,
        getByToken,
        getDiagnostics,
        recordError,
        clearError,
        clear,
    };
}
/** @internal */
export function getTelegramExtensionSettingsRows(registry) {
    const rows = [];
    for (const section of registry
        .getSections()
        .filter((s) => s.registration.settings)
        .sort((a, b) => {
        const orderA = a.registration.settings.order ?? 0;
        const orderB = b.registration.settings.order ?? 0;
        if (orderA !== orderB)
            return orderA - orderB;
        return a.id.localeCompare(b.id);
    })) {
        try {
            rows.push({
                label: section.registration.settings.getLabel?.() ??
                    section.registration.settings.label,
                callback_data: `section:${section.token}:settings:open`,
            });
            registry.clearError(section.token, "settings_label");
        }
        catch (error) {
            registry.recordError(section.token, sectionErrorMessage(error), "settings_label");
        }
    }
    return rows;
}
/** @internal */
export function getTelegramSectionMainMenuRows(registry) {
    const rows = [];
    for (const section of registry.getSections()) {
        try {
            rows.push({
                text: section.registration.getLabel?.() ?? section.label,
                callback_data: `section:${section.token}:open`,
            });
            registry.clearError(section.token, "main_label");
        }
        catch (error) {
            registry.recordError(section.token, sectionErrorMessage(error), "main_label");
        }
    }
    return rows;
}
/** @internal */
export function parseTelegramSectionCallback(data) {
    if (!data.startsWith("section:"))
        return undefined;
    const rest = data.slice("section:".length);
    const firstColon = rest.indexOf(":");
    if (firstColon === -1)
        return undefined;
    const token = rest.slice(0, firstColon);
    const afterToken = rest.slice(firstColon + 1);
    const secondColon = afterToken.indexOf(":");
    if (secondColon === -1) {
        return { token, action: afterToken, payload: "" };
    }
    return {
        token,
        action: afterToken.slice(0, secondColon),
        payload: afterToken.slice(secondColon + 1),
    };
}
export async function handleTelegramSectionOpen(registry, token, chatId, messageId, callbackQueryId, deps) {
    const section = registry.getByToken(token);
    if (!section) {
        await deps.answerCallbackQuery(callbackQueryId, "This section is no longer available.");
        return true;
    }
    try {
        const sectionCtx = buildTelegramSectionContext(section.id, token, chatId, messageId, callbackQueryId, deps);
        const view = await section.registration.render(sectionCtx);
        const viewWithBack = {
            ...view,
            replyMarkup: prependBackRow(view.replyMarkup, "menu:back", "⬆️ Main menu"),
        };
        await deps.editInteractiveMessage(chatId, messageId, viewWithBack.text, viewWithBack.parseMode ?? "html", viewWithBack.replyMarkup);
        await deps.answerCallbackQuery(callbackQueryId);
        registry.clearError(token, "render");
        return true;
    }
    catch (error) {
        const message = sectionErrorMessage(error);
        registry.recordError(token, message, "render");
        await deps.answerCallbackQuery(callbackQueryId, `Section error: ${message}`);
        return true;
    }
}
export async function handleTelegramSectionCallback(registry, token, action, payload, chatId, messageId, callbackQueryId, deps) {
    const section = registry.getByToken(token);
    if (!section) {
        await deps.answerCallbackQuery(callbackQueryId, "This section is no longer available.");
        return true;
    }
    // Try main handleCallback first, then settings handleCallback as fallback.
    const mainHandler = section.registration.handleCallback;
    const settingsHandler = section.registration.settings?.handleCallback;
    const handler = mainHandler ?? settingsHandler;
    if (!handler) {
        await deps.answerCallbackQuery(callbackQueryId);
        return true;
    }
    try {
        const ctx = buildTelegramSectionCallbackContext(section.id, token, chatId, messageId, action, payload, callbackQueryId, deps, mainHandler ? `section:${token}:open` : "settings:list");
        let result = await handler(ctx);
        // Fallback: if main handler passed and settings handler exists, try settings
        // with the correct navigation context (back → settings list).
        if (result === "pass" && mainHandler && settingsHandler) {
            const settingsCtx = buildTelegramSectionCallbackContext(section.id, token, chatId, messageId, action, payload, callbackQueryId, deps, "settings:list");
            result = await settingsHandler(settingsCtx);
        }
        if (result === "pass") {
            await deps.answerCallbackQuery(callbackQueryId);
        }
        registry.clearError(token, "callback");
        return true;
    }
    catch (error) {
        const message = sectionErrorMessage(error);
        registry.recordError(token, message, "callback");
        await deps.answerCallbackQuery(callbackQueryId, `Section error: ${message}`);
        return true;
    }
}
export async function handleTelegramSectionSettingsOpen(registry, token, chatId, messageId, callbackQueryId, deps) {
    const section = registry.getByToken(token);
    if (!section || !section.registration.settings) {
        await deps.answerCallbackQuery(callbackQueryId, "This section is no longer available.");
        return true;
    }
    try {
        const sectionCtx = buildTelegramSectionContext(section.id, token, chatId, messageId, callbackQueryId, deps, "settings:list", "⬆️ Back");
        const view = await section.registration.settings.open(sectionCtx);
        const viewWithBack = {
            ...view,
            replyMarkup: prependBackRow(view.replyMarkup, "settings:list", "⬆️ Back"),
        };
        await deps.editInteractiveMessage(chatId, messageId, viewWithBack.text, viewWithBack.parseMode ?? "html", viewWithBack.replyMarkup);
        await deps.answerCallbackQuery(callbackQueryId);
        registry.clearError(token, "settings_open");
        return true;
    }
    catch (error) {
        const message = sectionErrorMessage(error);
        registry.recordError(token, message, "settings_open");
        await deps.answerCallbackQuery(callbackQueryId, `Section error: ${message}`);
        return true;
    }
}
