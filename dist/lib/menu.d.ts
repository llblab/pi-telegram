/**
 * Telegram menu and inline-keyboard rendering helpers
 * Zones: telegram ui, controls, status menu
 * Owns app-menu/status state, inline UI text, and callback composition while model/thinking/queue menu details live in dedicated domains
 */
import { type TelegramMenuMessageRuntimeDeps, type TelegramModelMenuState, type TelegramModelMenuStateBuilderContext, type TelegramModelMenuStateBuilderDeps, type TelegramReplyMarkup } from "./menu-model.ts";
import { type MenuModel, type ScopedTelegramModel, type TelegramModelSwitchContinuationSource, type ThinkingLevel } from "./model.ts";
import type { TelegramInputRichMessage } from "./telegram-api.ts";
import { type TelegramSectionRegistry } from "./sections.ts";
export { applyTelegramModelPageSelection, applyTelegramModelScopeSelection, buildModelMenuReplyMarkup, buildModelPageMenuReplyMarkup, buildTelegramModelCallbackPlan, buildTelegramModelMenuRenderPayload, buildTelegramModelMenuState, buildTelegramModelMenuStateRuntime, buildTelegramModelPageMenuRenderPayload, createTelegramModelMenuRuntime, createTelegramModelMenuStateBuilder, formatScopedModelButtonText, getModelMenuItems, getStoredTelegramModelMenuState, getTelegramModelMenuPage, getTelegramModelSelection, handleTelegramModelMenuCallbackAction, MODEL_MENU_TITLE, MODEL_PAGE_MENU_TITLE, openTelegramModelMenu, pruneStoredTelegramModelMenus, resolveCachedTelegramModelMenuInputs, sendTelegramModelMenuMessage, storeTelegramModelMenuState, TELEGRAM_MODEL_PAGE_SIZE, updateTelegramModelMenuMessage, } from "./menu-model.ts";
export type { BuildTelegramModelCallbackPlanParams, BuildTelegramModelMenuStateParams, CachedTelegramModelMenuInputs, MenuSettingsManager, StoredTelegramModelMenuState, TelegramMenuMessageRuntimeDeps, TelegramMenuMutationResult, TelegramMenuRenderPayload, TelegramMenuSelectionResult, TelegramModelCallbackPlan, TelegramModelMenuCallbackDeps, TelegramModelMenuInputCacheDeps, TelegramModelMenuOpenDeps, TelegramModelMenuPage, TelegramModelMenuRuntime, TelegramModelMenuRuntimeContext, TelegramModelMenuRuntimeOptions, TelegramModelMenuState, TelegramModelMenuStateBuilderContext, TelegramModelMenuStateBuilderDeps, TelegramModelMenuStoreOptions, TelegramModelScope, TelegramReplyMarkup, } from "./menu-model.ts";
export { buildStatusReplyMarkup, buildTelegramStatusMenuRenderPayload, handleTelegramStatusMenuCallbackAction, openTelegramStatusMenu, sendTelegramStatusMessage, updateTelegramStatusMessage, } from "./menu-status.ts";
export type { TelegramStatusMenuCallbackDeps, TelegramStatusMenuOpenDeps, } from "./menu-status.ts";
export { buildTelegramThinkingMenuRenderPayload, buildThinkingMenuReplyMarkup, buildThinkingMenuText, handleTelegramThinkingMenuCallbackAction, openTelegramThinkingMenu, updateTelegramThinkingMenuMessage, } from "./menu-thinking.ts";
export type { TelegramThinkingMenuCallbackDeps, TelegramThinkingMenuOpenDeps, } from "./menu-thinking.ts";
export interface TelegramMenuCallbackEntryDeps {
    handleStatusAction: () => Promise<boolean>;
    handleThinkingAction: () => Promise<boolean>;
    handleModelAction: () => Promise<boolean>;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
}
export interface MenuCallbackQuery {
    id: string;
    data?: string;
    message?: {
        message_id?: number;
        message_thread_id?: number;
        chat?: {
            id?: number;
        };
    };
}
export interface StoredTelegramMenuCallbackDeps<TModel extends MenuModel = MenuModel> {
    getStoredModelMenuState: (messageId: number | undefined, chatId?: number) => TelegramModelMenuState<TModel> | undefined;
    handleStatusAction: (state: TelegramModelMenuState<TModel>) => Promise<boolean>;
    handleThinkingAction: (state: TelegramModelMenuState<TModel>) => Promise<boolean>;
    handleModelAction: (state: TelegramModelMenuState<TModel>) => Promise<boolean>;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
}
export interface TelegramMenuCallbackRuntimeDeps<TContext, TModel extends MenuModel = MenuModel> {
    getStoredModelMenuState: (messageId: number | undefined, chatId?: number) => TelegramModelMenuState<TModel> | undefined;
    getActiveModel: (ctx: TContext) => TModel | undefined;
    getThinkingLevel: () => ThinkingLevel;
    setThinkingLevel: (level: ThinkingLevel) => void;
    updateStatus: (ctx: TContext) => void;
    updateModelMenuMessage: (state: TelegramModelMenuState<TModel>, ctx: TContext) => Promise<void>;
    updateThinkingMenuMessage: (state: TelegramModelMenuState<TModel>, ctx: TContext) => Promise<void>;
    updateStatusMessage: (state: TelegramModelMenuState<TModel>, ctx: TContext) => Promise<void>;
    updateSettingsMenuMessage?: (state: TelegramModelMenuState<TModel>, ctx: TContext) => Promise<void>;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    isIdle: (ctx: TContext) => boolean;
    hasAbortHandler: () => boolean;
    hasActiveToolExecutions: () => boolean;
    persistScopedModelPatterns?: (patterns: string[], ctx: TContext) => Promise<void>;
    setModel: (model: TModel) => Promise<boolean>;
    setCurrentModel: (model: TModel, ctx: TContext) => void;
    stagePendingModelSwitch: (selection: ScopedTelegramModel<TModel>, ctx: TContext, continuationTurn: TelegramModelSwitchContinuationSource) => void;
    restartInterruptedTelegramTurn: (selection: ScopedTelegramModel<TModel>, ctx: TContext, continuationTurn: TelegramModelSwitchContinuationSource) => Promise<boolean> | boolean;
    sectionRegistry?: TelegramSectionRegistry;
    editInteractiveMessage?: (chatId: number, messageId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: TelegramReplyMarkup) => Promise<void>;
    sendInteractiveMessage?: (chatId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: TelegramReplyMarkup, options?: {
        target?: {
            chatId: number;
            threadId?: number;
        };
    }) => Promise<number | undefined>;
    sendSectionRichMessage?: (chatId: number, message: TelegramInputRichMessage, options?: {
        target?: {
            chatId: number;
            threadId?: number;
        };
    }) => Promise<number | undefined>;
    enqueueSectionPrompt?: (prompt: string, ctx: TContext, target?: {
        chatId: number;
        threadId?: number;
    }, source?: unknown) => Promise<void>;
    deleteMessage?: (chatId: number, messageId: number) => Promise<void>;
    isVoiceReplyActive?: () => boolean;
}
export interface TelegramMenuActionRuntimeDeps<TContext, TModel extends MenuModel = MenuModel> extends TelegramMenuMessageRuntimeDeps {
    getModelMenuState: (chatId: number, ctx: TContext, threadId?: number) => Promise<TelegramModelMenuState<TModel>>;
    getActiveModel: (ctx: TContext) => TModel | undefined;
    getThinkingLevel: () => ThinkingLevel;
    getQueueItemCount?: () => number;
    buildStatusHtml: (ctx: TContext) => string;
    storeModelMenuState: (state: TelegramModelMenuState<TModel>) => void;
    isIdle: (ctx: TContext) => boolean;
    canOfferInFlightModelSwitch: (ctx: TContext) => boolean;
    sendTextReply: (chatId: number, replyToMessageId: number, text: string, options?: {
        target?: {
            chatId: number;
            threadId?: number;
        };
        parseMode?: "HTML";
    }) => Promise<unknown>;
    sectionRegistry?: TelegramSectionRegistry;
    isVoiceReplyActive?: () => boolean;
}
export interface TelegramMenuActionRuntime<TContext, TModel extends MenuModel = MenuModel> {
    updateModelMenuMessage: (state: TelegramModelMenuState<TModel>, ctx: TContext) => Promise<void>;
    updateThinkingMenuMessage: (state: TelegramModelMenuState<TModel>, ctx: TContext) => Promise<void>;
    updateStatusMessage: (state: TelegramModelMenuState<TModel>, ctx: TContext) => Promise<void>;
    sendStatusMessage: (chatId: number, replyToMessageId: number, ctx: TContext, threadId?: number) => Promise<void>;
    openModelMenu: (chatId: number, replyToMessageId: number, ctx: TContext, threadId?: number) => Promise<void>;
    openThinkingMenu: (chatId: number, replyToMessageId: number, ctx: TContext) => Promise<void>;
}
export type TelegramMenuCallbackAction = {
    kind: "ignore";
} | {
    kind: "status";
    action: "model" | "thinking" | "queue" | "settings";
} | {
    kind: "thinking:set";
    level: string;
} | {
    kind: "model";
    action: "noop" | "scope" | "page" | "pages" | "open" | "pick" | "pick-selected" | "scope-enable" | "scope-disable" | "scope-toggle";
    value?: string;
};
export declare function parseTelegramMenuCallbackAction(data: string | undefined): TelegramMenuCallbackAction;
export declare function handleTelegramMenuCallbackEntry(callbackQueryId: string, data: string | undefined, state: TelegramModelMenuState | undefined, deps: TelegramMenuCallbackEntryDeps): Promise<void>;
export declare function handleStoredTelegramMenuCallback<TModel extends MenuModel = MenuModel>(query: MenuCallbackQuery, deps: StoredTelegramMenuCallbackDeps<TModel>): Promise<void>;
export interface TelegramMenuCallbackRuntimeAdapterDeps<TContext, TModel extends MenuModel = MenuModel> {
    getStoredModelMenuState: (messageId: number | undefined, chatId?: number) => TelegramModelMenuState<TModel> | undefined;
    getActiveModel: (ctx: TContext) => TModel | undefined;
    getThinkingLevel: () => ThinkingLevel;
    setThinkingLevel: (level: ThinkingLevel) => void;
    updateStatus: (ctx: TContext, error?: string) => void;
    updateModelMenuMessage: (state: TelegramModelMenuState<TModel>, ctx: TContext) => Promise<void>;
    updateThinkingMenuMessage: (state: TelegramModelMenuState<TModel>, ctx: TContext) => Promise<void>;
    updateStatusMessage: (state: TelegramModelMenuState<TModel>, ctx: TContext) => Promise<void>;
    updateSettingsMenuMessage?: (state: TelegramModelMenuState<TModel>, ctx: TContext) => Promise<void>;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    isIdle: (ctx: TContext) => boolean;
    hasAbortHandler: () => boolean;
    getActiveToolExecutions: () => number;
    persistScopedModelPatterns?: (patterns: string[], ctx: TContext) => Promise<void>;
    setModel: (model: TModel) => Promise<boolean>;
    setCurrentModel: (model: TModel, ctx: TContext) => void;
    stagePendingModelSwitch: (selection: ScopedTelegramModel<TModel>, ctx: TContext, continuationTurn: TelegramModelSwitchContinuationSource) => void;
    restartInterruptedTelegramTurn: (selection: ScopedTelegramModel<TModel>, ctx: TContext, continuationTurn: TelegramModelSwitchContinuationSource) => Promise<boolean> | boolean;
    sectionRegistry?: TelegramSectionRegistry;
    editInteractiveMessage?: (chatId: number, messageId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: TelegramReplyMarkup) => Promise<void>;
    sendInteractiveMessage?: (chatId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: TelegramReplyMarkup, options?: {
        target?: {
            chatId: number;
            threadId?: number;
        };
    }) => Promise<number | undefined>;
    sendSectionRichMessage?: (chatId: number, message: TelegramInputRichMessage, options?: {
        target?: {
            chatId: number;
            threadId?: number;
        };
    }) => Promise<number | undefined>;
    enqueueSectionPrompt?: (prompt: string, ctx: TContext, target?: {
        chatId: number;
        threadId?: number;
    }, source?: unknown) => Promise<void>;
    deleteMessage?: (chatId: number, messageId: number) => Promise<void>;
}
export declare function createTelegramMenuCallbackHandler<TQuery extends MenuCallbackQuery, TContext, TModel extends MenuModel = MenuModel>(deps: TelegramMenuCallbackRuntimeDeps<TContext, TModel>): (query: TQuery, ctx: TContext) => Promise<void>;
export declare function createTelegramMenuCallbackHandlerForContext<TQuery extends MenuCallbackQuery, TContext, TModel extends MenuModel = MenuModel>(deps: TelegramMenuCallbackRuntimeAdapterDeps<TContext, TModel>): (query: TQuery, ctx: TContext) => Promise<void>;
export declare function handleTelegramMenuCallbackRuntime<TQuery extends MenuCallbackQuery, TContext, TModel extends MenuModel = MenuModel>(query: TQuery, ctx: TContext, deps: TelegramMenuCallbackRuntimeDeps<TContext, TModel>): Promise<void>;
export interface TelegramMenuActionRuntimeWithStateBuilderDeps<TModel extends MenuModel = MenuModel, TContext extends TelegramModelMenuStateBuilderContext<TModel> = TelegramModelMenuStateBuilderContext<TModel>> extends Omit<TelegramMenuActionRuntimeDeps<TContext, TModel>, "getModelMenuState">, TelegramModelMenuStateBuilderDeps<TModel, TContext> {
    isVoiceReplyActive?: () => boolean;
}
export declare function createTelegramMenuActionRuntimeWithStateBuilder<TModel extends MenuModel = MenuModel, TContext extends TelegramModelMenuStateBuilderContext<TModel> = TelegramModelMenuStateBuilderContext<TModel>>(deps: TelegramMenuActionRuntimeWithStateBuilderDeps<TModel, TContext>): TelegramMenuActionRuntime<TContext, TModel>;
export declare function createTelegramMenuActionRuntime<TContext, TModel extends MenuModel = MenuModel>(deps: TelegramMenuActionRuntimeDeps<TContext, TModel>): TelegramMenuActionRuntime<TContext, TModel>;
