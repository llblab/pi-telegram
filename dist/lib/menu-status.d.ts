/**
 * Telegram status menu UI helpers
 * Zones: telegram ui, status controls, menu composition
 * Owns status-menu payloads, status callback handling, and status-menu message rendering
 */
import { type TelegramSectionRegistry } from "./sections.ts";
import { type TelegramMenuMessageRuntimeDeps, type TelegramMenuRenderPayload, type TelegramModelMenuState, type TelegramReplyMarkup } from "./menu-model.ts";
import { type MenuModel, type ThinkingLevel } from "./model.ts";
export interface TelegramStatusMenuCallbackDeps {
    updateModelMenuMessage: () => Promise<void>;
    updateThinkingMenuMessage: () => Promise<void>;
    updateSettingsMenuMessage?: () => Promise<void>;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    isVoiceReplyActive?: () => boolean;
}
export interface TelegramStatusMenuOpenDeps<TModel extends MenuModel = MenuModel> {
    isIdle: () => boolean;
    sendBusyMessage: () => Promise<void>;
    getModelMenuState: () => Promise<TelegramModelMenuState<TModel>>;
    buildStatusHtml: () => string;
    getActiveModel: () => TModel | undefined;
    getThinkingLevel: () => ThinkingLevel;
    getQueueItemCount?: () => number;
    sendStatusMenu: (state: TelegramModelMenuState<TModel>, statusHtml: string, activeModel: TModel | undefined, thinkingLevel: ThinkingLevel, queueItemCount: number) => Promise<number | undefined>;
    storeModelMenuState: (state: TelegramModelMenuState<TModel>) => void;
}
export declare function openTelegramStatusMenu<TModel extends MenuModel = MenuModel>(deps: TelegramStatusMenuOpenDeps<TModel>): Promise<void>;
export declare function handleTelegramStatusMenuCallbackAction(callbackQueryId: string, data: string | undefined, activeModel: MenuModel | undefined, deps: TelegramStatusMenuCallbackDeps): Promise<boolean>;
export declare function buildStatusReplyMarkup(activeModel: MenuModel | undefined, currentThinkingLevel: ThinkingLevel, queueItemCount?: number, sectionRegistry?: TelegramSectionRegistry, isVoiceReplyActive?: boolean): TelegramReplyMarkup;
export declare function buildTelegramStatusMenuRenderPayload(statusText: string, activeModel: MenuModel | undefined, currentThinkingLevel: ThinkingLevel, queueItemCount?: number, sectionRegistry?: TelegramSectionRegistry, isVoiceReplyActive?: boolean): TelegramMenuRenderPayload;
export declare function updateTelegramStatusMessage(state: TelegramModelMenuState, statusText: string, activeModel: MenuModel | undefined, currentThinkingLevel: ThinkingLevel, deps: TelegramMenuMessageRuntimeDeps, queueItemCount?: number, sectionRegistry?: TelegramSectionRegistry, isVoiceReplyActive?: boolean): Promise<void>;
export declare function sendTelegramStatusMessage(state: TelegramModelMenuState, statusText: string, activeModel: MenuModel | undefined, currentThinkingLevel: ThinkingLevel, deps: TelegramMenuMessageRuntimeDeps, queueItemCount?: number, sectionRegistry?: TelegramSectionRegistry, isVoiceReplyActive?: boolean): Promise<number | undefined>;
