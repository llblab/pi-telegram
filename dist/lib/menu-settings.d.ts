/**
 * Telegram settings menu UI helpers
 * Zones: telegram ui, settings controls, menu composition
 * Owns hidden settings-menu rendering, settings callbacks, and persisted toggle wiring
 */
import type { TelegramActivityVerbosity, TelegramAssistantRenderingMode, TelegramTimeMode, TelegramThreadDisplayMode } from "./config.ts";
import type { TelegramInlineKeyboardMarkup } from "./keyboard.ts";
import type { TelegramModelMenuState } from "./menu-model.ts";
import type { MenuModel } from "./model.ts";
import { type TelegramSectionRegistry } from "./sections.ts";
import type { TelegramVoiceReplyMode } from "./voice.ts";
export type TelegramSettingsMenuReplyMarkup = TelegramInlineKeyboardMarkup;
export interface TelegramSettingsStateDeps {
    getThreadDisplayMode?: () => TelegramThreadDisplayMode | undefined;
    isThreadDisplayCustom?: () => boolean;
    areDraftPreviewsEnabled: () => boolean;
    getAssistantRenderingMode: () => TelegramAssistantRenderingMode;
    getActivityVerbosity: () => TelegramActivityVerbosity;
    getTimeInjectionMode: () => TelegramTimeMode;
    getVoiceReplyMode: () => TelegramVoiceReplyMode;
    isVoiceReplyModeConfigured: () => boolean;
    isAutomaticThreadCleanupEnabled: () => boolean;
}
export interface TelegramSettingsMutationDeps extends TelegramSettingsStateDeps {
    setThreadDisplayMode?: (mode: TelegramThreadDisplayMode) => Promise<void>;
    setDraftPreviewsEnabled: (enabled: boolean) => Promise<void>;
    setAssistantRenderingMode: (mode: TelegramAssistantRenderingMode) => Promise<void>;
    setActivityVerbosity: (verbosity: TelegramActivityVerbosity) => Promise<void>;
    setVoiceReplyMode: (mode: TelegramVoiceReplyMode | undefined) => Promise<void>;
    setTimeInjectionMode: (mode: TelegramTimeMode) => Promise<void>;
    setAutomaticThreadCleanupEnabled: (enabled: boolean) => Promise<void>;
    reviewInactiveThreads?: () => Promise<{
        count: number;
        operationId?: string;
    }>;
    cleanInactiveThreads?: (operationId: string) => Promise<{
        deleted: number;
        outcomeUnknown: number;
        blocked?: number;
        recovery?: "commit-ready" | "deletion-outcome-unknown" | "authority-blocked";
    }>;
}
export interface TelegramSettingsMenuOpenDeps<TModel extends MenuModel = MenuModel> extends TelegramSettingsStateDeps {
    getModelMenuState: () => Promise<TelegramModelMenuState<TModel>>;
    sendSettingsMenu: (state: TelegramModelMenuState<TModel>, text: string, replyMarkup: TelegramSettingsMenuReplyMarkup) => Promise<number | undefined>;
    storeModelMenuState: (state: TelegramModelMenuState<TModel>) => void;
}
export interface TelegramSettingsMenuCallbackDeps extends TelegramSettingsMutationDeps {
    updateSettingsMessage: (text: string, replyMarkup: TelegramSettingsMenuReplyMarkup) => Promise<void>;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    sectionRegistry?: TelegramSectionRegistry;
}
export interface TelegramSettingsMenuRuntime<TContext> {
    openSettingsMenu: (chatId: number, replyToMessageId: number, ctx: TContext) => Promise<void>;
    handleCallbackQuery: (query: {
        id: string;
        data?: string;
        message?: {
            message_id?: number;
            message_thread_id?: number;
            chat?: {
                id?: number;
            };
        };
    }, ctx: TContext) => Promise<boolean>;
    updateSettingsMenuMessage: (state: TelegramModelMenuState, ctx: TContext) => Promise<void>;
}
export interface TelegramSettingsMenuMessageUpdateDeps extends TelegramSettingsStateDeps {
    updateSettingsMessage: (text: string, replyMarkup: TelegramSettingsMenuReplyMarkup) => Promise<void>;
}
export interface TelegramSettingsMenuRuntimeDeps<TContext, TModel extends MenuModel = MenuModel> extends TelegramSettingsMutationDeps {
    reloadConfig?: () => Promise<void>;
    getModelMenuState: (chatId: number, ctx: TContext, threadId?: number) => Promise<TelegramModelMenuState<TModel>>;
    getStoredModelMenuState: (messageId: number | undefined, chatId?: number) => TelegramModelMenuState<TModel> | undefined;
    storeModelMenuState: (state: TelegramModelMenuState<TModel>) => void;
    editInteractiveMessage: (chatId: number, messageId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: TelegramSettingsMenuReplyMarkup) => Promise<void>;
    sendInteractiveMessage: (chatId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: TelegramSettingsMenuReplyMarkup) => Promise<number | undefined>;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
}
export declare const SETTINGS_MENU_TITLE = "<b>\u2699\uFE0F Settings:</b>";
export declare const AUTOMATIC_THREAD_CLEANUP_SETTINGS_TITLE = "<b>\uD83E\uDDF9 Thread cleanup:</b>";
export declare const INACTIVE_THREAD_REVIEW_TITLE = "<b>\uD83D\uDD0E Inactive tabs review:</b>";
export declare const DRAFT_PREVIEWS_SETTINGS_TITLE = "<b>\uD83D\uDCDD Draft previews:</b>";
export declare const ASSISTANT_RENDERING_SETTINGS_TITLE = "<b>\uD83E\uDDFE Assistant rendering:</b>";
export declare const ACTIVITY_VERBOSITY_SETTINGS_TITLE = "<b>\uD83D\uDD2C Activity:</b>";
export declare const TIME_INJECTION_MODE_SETTINGS_TITLE = "<b>\uD83D\uDD52 Time injection mode:</b>";
export declare const VOICE_REPLY_MODE_SETTINGS_TITLE = "<b>\uD83D\uDC44 Voice reply mode:</b>";
export declare const THREAD_DISPLAY_SETTINGS_TITLE = "<b>\uD83E\uDDF5 Thread display:</b>";
export declare function buildTelegramSettingsMenuText(): string;
export declare function buildThreadDisplaySettingsText(mode: TelegramThreadDisplayMode, custom?: boolean): string;
export declare function buildAutomaticThreadCleanupSettingsText(enabled: boolean): string;
export declare function buildInactiveThreadReviewText(count: number): string;
export declare function buildInactiveThreadReviewReplyMarkup(operationId?: string, canCleanInactiveThreads?: boolean): TelegramSettingsMenuReplyMarkup;
export declare function buildDraftPreviewsSettingsText(enabled: boolean): string;
export declare function buildAssistantRenderingSettingsText(mode: TelegramAssistantRenderingMode): string;
export declare function buildActivityVerbositySettingsText(verbosity: TelegramActivityVerbosity): string;
export declare function buildVoiceReplyModeSettingsText(mode: TelegramVoiceReplyMode, configured?: boolean): string;
export declare function buildTimeInjectionModeSettingsText(mode: TelegramTimeMode): string;
export declare function buildTelegramSettingsMenuReplyMarkup(draftPreviewsEnabled: boolean, assistantRenderingModeOrVoiceReplyMode: TelegramAssistantRenderingMode | TelegramVoiceReplyMode, voiceReplyModeOrTimeInjectionMode: TelegramVoiceReplyMode | TelegramTimeMode, timeInjectionModeOrSectionRegistry?: TelegramTimeMode | TelegramSectionRegistry, sectionRegistryOrVoiceReplyModeConfigured?: TelegramSectionRegistry | boolean, voiceReplyModeConfigured?: boolean, automaticThreadCleanupEnabled?: boolean, activityVerbosity?: TelegramActivityVerbosity, threadDisplayMode?: TelegramThreadDisplayMode, threadDisplayCustom?: boolean): TelegramSettingsMenuReplyMarkup;
export declare function openTelegramSettingsMenu<TModel extends MenuModel = MenuModel>(deps: TelegramSettingsMenuOpenDeps<TModel>, sectionRegistry?: TelegramSectionRegistry): Promise<void>;
export declare function buildThreadDisplaySettingsReplyMarkup(mode: TelegramThreadDisplayMode, custom?: boolean): TelegramSettingsMenuReplyMarkup;
export declare function buildAutomaticThreadCleanupSettingsReplyMarkup(enabled: boolean, canReviewInactiveThreads?: boolean): TelegramSettingsMenuReplyMarkup;
export declare function buildDraftPreviewsSettingsReplyMarkup(enabled: boolean): TelegramSettingsMenuReplyMarkup;
export declare function buildAssistantRenderingSettingsReplyMarkup(mode: TelegramAssistantRenderingMode): TelegramSettingsMenuReplyMarkup;
export declare function buildActivityVerbositySettingsReplyMarkup(verbosity: TelegramActivityVerbosity): TelegramSettingsMenuReplyMarkup;
export declare function buildTimeInjectionModeSettingsReplyMarkup(mode: TelegramTimeMode): TelegramSettingsMenuReplyMarkup;
export declare function buildVoiceReplyModeSettingsReplyMarkup(mode: TelegramVoiceReplyMode, configured?: boolean): TelegramSettingsMenuReplyMarkup;
export declare function updateTelegramSettingsMenuMessage(deps: TelegramSettingsMenuMessageUpdateDeps, sectionRegistry?: TelegramSectionRegistry): Promise<void>;
export declare function updateAutomaticThreadCleanupSettingsMessage(deps: TelegramSettingsMenuCallbackDeps): Promise<void>;
export declare function updateDraftPreviewsSettingsMessage(deps: TelegramSettingsMenuCallbackDeps): Promise<void>;
export declare function updateAssistantRenderingSettingsMessage(deps: TelegramSettingsMenuCallbackDeps): Promise<void>;
export declare function updateActivityVerbositySettingsMessage(deps: TelegramSettingsMenuCallbackDeps): Promise<void>;
export declare function updateTimeInjectionModeSettingsMessage(deps: TelegramSettingsMenuCallbackDeps): Promise<void>;
export declare function updateVoiceReplyModeSettingsMessage(deps: TelegramSettingsMenuCallbackDeps): Promise<void>;
export declare function handleTelegramSettingsMenuCallbackAction(callbackQueryId: string, data: string | undefined, deps: TelegramSettingsMenuCallbackDeps): Promise<boolean>;
export declare function createTelegramSettingsMenuRuntime<TContext, TModel extends MenuModel = MenuModel>(deps: TelegramSettingsMenuRuntimeDeps<TContext, TModel>, sectionRegistry?: TelegramSectionRegistry): TelegramSettingsMenuRuntime<TContext>;
