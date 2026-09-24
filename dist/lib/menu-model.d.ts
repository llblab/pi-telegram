/**
 * Telegram model menu UI helpers
 * Zones: telegram ui, model controls, menu composition
 * Owns model-menu state, scoped model pages, model callback planning, and model-menu message rendering
 */
import type { TelegramInlineKeyboardMarkup } from "./keyboard.ts";
import { type MenuModel, type ScopedTelegramModel, type TelegramModelSwitchContinuationSource, type ThinkingLevel } from "./model.ts";
export type TelegramModelScope = "all" | "scoped";
export interface TelegramModelMenuState<TModel extends MenuModel = MenuModel> {
    chatId: number;
    threadId?: number;
    messageId: number;
    page: number;
    scope: TelegramModelScope;
    scopedModels: ScopedTelegramModel<TModel>[];
    allModels: ScopedTelegramModel<TModel>[];
    note?: string;
    selectedModelIndex?: number;
    selectedModelKey?: string;
    scopedModelPatterns?: string[];
    canMutateScope?: boolean;
    mode: "status" | "model" | "model-pages" | "model-detail" | "thinking" | "queue" | "settings";
}
export interface StoredTelegramModelMenuState<TModel extends MenuModel = MenuModel> {
    state: TelegramModelMenuState<TModel>;
    updatedAt: number;
}
export interface TelegramModelMenuStoreOptions {
    maxAgeMs: number;
    maxStoredMenus: number;
    now?: number;
}
export interface CachedTelegramModelMenuInputs<TModel extends MenuModel = MenuModel> {
    expiresAt: number;
    availableModels: TModel[];
    configuredScopedModelPatterns: string[];
    cliScopedModelPatterns?: string[];
}
export interface TelegramModelMenuInputCacheDeps<TModel extends MenuModel = MenuModel> {
    cacheTtlMs: number;
    now?: number;
    reloadSettings: () => Promise<void>;
    refreshAvailableModels: () => TModel[];
    getConfiguredScopedModelPatterns: () => string[] | undefined;
    getCliScopedModelPatterns: () => string[] | undefined;
}
export interface TelegramModelMenuRuntimeContext<TModel extends MenuModel = MenuModel> {
    modelRegistry: {
        refresh: () => void;
        getAvailable: () => TModel[];
    };
}
export interface TelegramModelMenuRuntimeOptions<TContext extends TelegramModelMenuRuntimeContext<TModel>, TModel extends MenuModel = MenuModel> {
    chatId: number;
    threadId?: number;
    activeModel: TModel | undefined;
    cachedInputs: CachedTelegramModelMenuInputs<TModel> | undefined;
    cacheTtlMs: number;
    ctx: TContext;
    reloadSettings: () => Promise<void>;
    getConfiguredScopedModelPatterns: () => string[] | undefined;
    getCliScopedModelPatterns?: () => string[] | undefined;
}
export interface MenuSettingsManager {
    reload?: () => Promise<void>;
    flush?: () => Promise<void>;
    getEnabledModels: () => string[] | undefined;
    setEnabledModels?: (patterns: string[] | undefined) => void;
}
export type TelegramModelMenuStateBuilderContext<TModel extends MenuModel = MenuModel> = TelegramModelMenuRuntimeContext<TModel> & {
    cwd: string;
};
export interface TelegramModelMenuStateBuilderDeps<TModel extends MenuModel = MenuModel, TContext extends TelegramModelMenuStateBuilderContext<TModel> = TelegramModelMenuStateBuilderContext<TModel>> {
    runtime: TelegramModelMenuRuntime<TModel>;
    createSettingsManager: (cwd: string) => MenuSettingsManager | PromiseLike<MenuSettingsManager>;
    getActiveModel: (ctx: TContext) => TModel | undefined;
}
export type TelegramReplyMarkup = TelegramInlineKeyboardMarkup;
export interface TelegramMenuMessageRuntimeDeps {
    editInteractiveMessage: (chatId: number, messageId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: TelegramReplyMarkup) => Promise<void>;
    sendInteractiveMessage: (chatId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: TelegramReplyMarkup, options?: {
        target?: {
            chatId: number;
            threadId?: number;
        };
    }) => Promise<number | undefined>;
}
export type TelegramModelMenuCallbackDeps<TModel extends MenuModel = MenuModel> = {
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    updateModelMenuMessage: () => Promise<void>;
    updateStatusMessage: () => Promise<void>;
    persistScopedModelPatterns?: (patterns: string[]) => Promise<void>;
    setModel: (model: TModel) => Promise<boolean>;
    setCurrentModel: (model: TModel) => void;
    setThinkingLevel: (level: ThinkingLevel) => void;
    stagePendingModelSwitch: (selection: ScopedTelegramModel<TModel>, continuationTurn: TelegramModelSwitchContinuationSource) => void;
    restartInterruptedTelegramTurn: (selection: ScopedTelegramModel<TModel>, continuationTurn: TelegramModelSwitchContinuationSource) => Promise<boolean> | boolean;
};
export interface TelegramModelMenuOpenDeps<TModel extends MenuModel = MenuModel> {
    isIdle: () => boolean;
    canOfferInFlightModelSwitch: () => boolean;
    sendBusyMessage: () => Promise<void>;
    sendNoModelsMessage: () => Promise<void>;
    getModelMenuState: () => Promise<TelegramModelMenuState<TModel>>;
    getActiveModel: () => TModel | undefined;
    sendModelMenu: (state: TelegramModelMenuState<TModel>, activeModel: TModel | undefined) => Promise<number | undefined>;
    storeModelMenuState: (state: TelegramModelMenuState<TModel>) => void;
}
export interface BuildTelegramModelMenuStateParams<TModel extends MenuModel = MenuModel> {
    chatId: number;
    threadId?: number;
    activeModel: TModel | undefined;
    availableModels: TModel[];
    configuredScopedModelPatterns: string[];
    cliScopedModelPatterns?: string[];
}
export type TelegramMenuMutationResult = "invalid" | "unchanged" | "changed";
export type TelegramMenuSelectionResult<TModel extends MenuModel = MenuModel> = {
    kind: "invalid";
} | {
    kind: "missing";
} | {
    kind: "selected";
    selection: ScopedTelegramModel<TModel>;
};
export interface TelegramModelMenuPage<TModel extends MenuModel = MenuModel> {
    page: number;
    pageCount: number;
    start: number;
    items: ScopedTelegramModel<TModel>[];
}
export interface TelegramMenuRenderPayload {
    nextMode: TelegramModelMenuState["mode"];
    text: string;
    mode: "markdown" | "html" | "plain";
    replyMarkup: TelegramReplyMarkup;
}
export type TelegramModelCallbackPlan<TModel extends MenuModel = MenuModel> = {
    kind: "ignore";
} | {
    kind: "answer";
    text?: string;
} | {
    kind: "update-menu";
    text?: string;
} | {
    kind: "persist-scope";
    patterns: string[];
    text: string;
} | {
    kind: "refresh-status";
    selection: ScopedTelegramModel<TModel>;
    callbackText: string;
    shouldApplyThinkingLevel: boolean;
} | {
    kind: "switch-model";
    selection: ScopedTelegramModel<TModel>;
    mode: "idle" | "restart-now" | "restart-after-tool";
    callbackText: string;
};
export interface BuildTelegramModelCallbackPlanParams<TModel extends MenuModel = MenuModel> {
    data: string | undefined;
    state: TelegramModelMenuState<TModel>;
    activeModel: TModel | undefined;
    currentThinkingLevel: ThinkingLevel;
    isIdle: boolean;
    canRestartBusyRun: boolean;
    hasActiveToolExecutions: boolean;
}
export interface TelegramModelMenuRuntime<TModel extends MenuModel = MenuModel> {
    storeState: (state: TelegramModelMenuState<TModel>) => void;
    getState: (messageId: number | undefined, chatId?: number) => TelegramModelMenuState<TModel> | undefined;
    clear: () => void;
    clearCachedInputs: () => void;
    buildState: <TContext extends TelegramModelMenuRuntimeContext<TModel>>(options: Omit<TelegramModelMenuRuntimeOptions<TContext, TModel>, "cachedInputs" | "cacheTtlMs">) => Promise<TelegramModelMenuState<TModel>>;
}
export declare const TELEGRAM_MODEL_PAGE_SIZE = 6;
export declare const MODEL_MENU_TITLE = "<b>\uD83E\uDD16 Choose a model:</b>";
export declare const MODEL_PAGE_MENU_TITLE = "<b>Choose a page:</b>";
export declare const MODEL_DETAIL_MENU_TITLE = "<b>\uD83E\uDD16 Model:</b>";
export declare function formatScopedModelButtonText<TModel extends MenuModel = MenuModel>(entry: ScopedTelegramModel<TModel>, currentModel: TModel | undefined): string;
export declare function formatStatusButtonLabel(label: string, value: string): string;
export declare function getModelMenuItems<TModel extends MenuModel = MenuModel>(state: TelegramModelMenuState<TModel>): ScopedTelegramModel<TModel>[];
export declare function pruneStoredTelegramModelMenus<TModel extends MenuModel = MenuModel>(menus: Map<string, StoredTelegramModelMenuState<TModel>>, options: TelegramModelMenuStoreOptions): void;
export declare function storeTelegramModelMenuState<TModel extends MenuModel = MenuModel>(menus: Map<string, StoredTelegramModelMenuState<TModel>>, state: TelegramModelMenuState<TModel>, options: TelegramModelMenuStoreOptions): void;
export declare function getStoredTelegramModelMenuState<TModel extends MenuModel = MenuModel>(menus: Map<string, StoredTelegramModelMenuState<TModel>>, messageId: number | undefined, options: TelegramModelMenuStoreOptions, chatId?: number): TelegramModelMenuState<TModel> | undefined;
export declare function createTelegramModelMenuRuntime<TModel extends MenuModel = MenuModel>(options?: Partial<TelegramModelMenuStoreOptions>): TelegramModelMenuRuntime<TModel>;
export declare function createTelegramModelMenuStateBuilder<TModel extends MenuModel = MenuModel, TContext extends TelegramModelMenuStateBuilderContext<TModel> = TelegramModelMenuStateBuilderContext<TModel>>(deps: TelegramModelMenuStateBuilderDeps<TModel, TContext>): (chatId: number, ctx: TContext, threadId?: number) => Promise<TelegramModelMenuState<TModel>>;
export declare function resolveCachedTelegramModelMenuInputs<TModel extends MenuModel = MenuModel>(cachedInputs: CachedTelegramModelMenuInputs<TModel> | undefined, deps: TelegramModelMenuInputCacheDeps<TModel>): Promise<CachedTelegramModelMenuInputs<TModel>>;
export declare function buildTelegramModelMenuState<TModel extends MenuModel = MenuModel>(params: BuildTelegramModelMenuStateParams<TModel>): TelegramModelMenuState<TModel>;
export declare function buildTelegramModelMenuStateRuntime<TContext extends TelegramModelMenuRuntimeContext<TModel>, TModel extends MenuModel = MenuModel>(options: TelegramModelMenuRuntimeOptions<TContext, TModel>): Promise<{
    state: TelegramModelMenuState<TModel>;
    cachedInputs: CachedTelegramModelMenuInputs<TModel>;
}>;
export declare function applyTelegramModelScopeSelection(state: TelegramModelMenuState, value: string | undefined): TelegramMenuMutationResult;
export declare function applyTelegramModelPageSelection(state: TelegramModelMenuState, value: string | undefined): TelegramMenuMutationResult;
export declare function getTelegramModelSelection<TModel extends MenuModel = MenuModel>(state: TelegramModelMenuState<TModel>, value: string | undefined): TelegramMenuSelectionResult<TModel>;
export declare function applyTelegramModelDetailSelection(state: TelegramModelMenuState, value: string | undefined): TelegramMenuMutationResult;
export declare function getTelegramSelectedDetailModel<TModel extends MenuModel = MenuModel>(state: TelegramModelMenuState<TModel>): TelegramMenuSelectionResult<TModel>;
export declare function isTelegramModelScoped(state: TelegramModelMenuState, model: MenuModel): boolean;
export declare function focusTelegramModelListPage(state: TelegramModelMenuState, model: MenuModel, pageSize?: number): void;
export declare function setTelegramModelScope(state: TelegramModelMenuState, model: MenuModel, enabled: boolean): {
    patterns: string[];
    enabled: boolean;
};
export declare function buildTelegramModelCallbackPlan<TModel extends MenuModel = MenuModel>(params: BuildTelegramModelCallbackPlanParams<TModel>): TelegramModelCallbackPlan<TModel>;
export declare function openTelegramModelMenu<TModel extends MenuModel = MenuModel>(deps: TelegramModelMenuOpenDeps<TModel>): Promise<void>;
export declare function handleTelegramModelMenuCallbackAction<TModel extends MenuModel = MenuModel>(callbackQueryId: string, params: BuildTelegramModelCallbackPlanParams<TModel>, deps: TelegramModelMenuCallbackDeps<TModel>): Promise<boolean>;
export declare function getTelegramModelMenuPage(state: TelegramModelMenuState, pageSize: number): TelegramModelMenuPage;
export declare function buildModelMenuReplyMarkup(state: TelegramModelMenuState, currentModel: MenuModel | undefined, pageSize: number): TelegramReplyMarkup;
export declare function buildModelDetailMenuReplyMarkup(state: TelegramModelMenuState, currentModel: MenuModel | undefined): TelegramReplyMarkup;
export declare function buildModelDetailMenuText(state: TelegramModelMenuState): string;
export declare function buildModelPageMenuReplyMarkup(state: TelegramModelMenuState, pageSize: number): TelegramReplyMarkup;
export declare function buildTelegramModelPageMenuRenderPayload(state: TelegramModelMenuState): TelegramMenuRenderPayload;
export declare function buildTelegramModelMenuRenderPayload(state: TelegramModelMenuState, activeModel: MenuModel | undefined): TelegramMenuRenderPayload;
export declare function updateTelegramModelMenuMessage(state: TelegramModelMenuState, activeModel: MenuModel | undefined, deps: TelegramMenuMessageRuntimeDeps): Promise<void>;
export declare function sendTelegramModelMenuMessage(state: TelegramModelMenuState, activeModel: MenuModel | undefined, deps: TelegramMenuMessageRuntimeDeps): Promise<number | undefined>;
