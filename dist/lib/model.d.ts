/**
 * Telegram model control domain helpers
 * Zones: pi agent model control, telegram controls, queue continuation
 * Owns model identity, thinking levels, scoped resolution, current-model state, and in-flight model switching
 */
import type { PendingTelegramTurn } from "./queue.ts";
export interface MenuModel {
    provider: string;
    id: string;
    name?: string;
    reasoning?: boolean;
}
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface ScopedTelegramModel<TModel extends MenuModel = MenuModel> {
    model: TModel;
    thinkingLevel?: ThinkingLevel;
}
export declare const THINKING_LEVELS: readonly ThinkingLevel[];
export interface CurrentModelStore<TContext, TModel extends MenuModel = MenuModel> {
    get: (ctx: TContext) => TModel | undefined;
    getStored: () => TModel | undefined;
    set: (model: TModel | undefined) => void;
}
export interface CurrentModelUpdateRuntime<TContext, TModel extends MenuModel = MenuModel> {
    setCurrentModel: (model: TModel | undefined, ctx: TContext) => void;
    onModelSelect: (event: {
        model: TModel | undefined;
    }, ctx: TContext) => void;
}
export type CurrentModelRuntime<TContext, TModel extends MenuModel = MenuModel> = CurrentModelStore<TContext, TModel> & CurrentModelUpdateRuntime<TContext, TModel>;
export declare function createCurrentModelStore<TContext, TModel extends MenuModel = MenuModel>(getContextModel: (ctx: TContext) => TModel | undefined): CurrentModelStore<TContext, TModel>;
export declare function createCurrentModelUpdateRuntime<TContext, TModel extends MenuModel = MenuModel>(deps: {
    setCurrentModel: (model: TModel | undefined) => void;
    updateStatus: (ctx: TContext) => void;
}): CurrentModelUpdateRuntime<TContext, TModel>;
export declare function createCurrentModelRuntime<TContext, TModel extends MenuModel = MenuModel>(deps: {
    getContextModel: (ctx: TContext) => TModel | undefined;
    updateStatus: (ctx: TContext) => void;
}): CurrentModelRuntime<TContext, TModel>;
export declare function modelsMatch(a: Pick<MenuModel, "provider" | "id"> | undefined, b: Pick<MenuModel, "provider" | "id"> | undefined): boolean;
export declare function getCanonicalModelId(model: Pick<MenuModel, "provider" | "id">): string;
export declare function isThinkingLevel(value: string): value is ThinkingLevel;
export declare function parseTelegramScopedModelPatternList(value: string): string[];
export declare function parseTelegramCliScopedModelPatterns(args: string[]): string[] | undefined;
export declare function resolveScopedModelPatterns<TModel extends MenuModel = MenuModel>(patterns: string[], availableModels: TModel[]): ScopedTelegramModel<TModel>[];
export declare function sortScopedModels<TModel extends MenuModel = MenuModel>(models: ScopedTelegramModel<TModel>[], currentModel: TModel | undefined): ScopedTelegramModel<TModel>[];
export interface PendingModelSwitchStore<TSelection> {
    get: () => TSelection | undefined;
    set: (selection: TSelection | undefined) => void;
    clear: () => void;
    has: () => boolean;
}
export interface TelegramInFlightModelSwitchState {
    isIdle: boolean;
    hasAbortHandler: boolean;
}
export declare function createPendingModelSwitchStore<TSelection>(): PendingModelSwitchStore<TSelection>;
export declare function canRestartAgentRunForTelegramModelSwitch(state: TelegramInFlightModelSwitchState): boolean;
export declare function shouldTriggerPendingTelegramModelSwitchAbort(state: {
    hasPendingModelSwitch: boolean;
    hasContinuationTurn: boolean;
    hasAbortHandler: boolean;
    activeToolExecutions: number;
}): boolean;
export declare function restartTelegramModelSwitchContinuation<TTurn, TSelection>(state: {
    activeTurn: TTurn | undefined;
    abort: (() => void) | undefined;
    selection: TSelection;
    queueContinuation: (turn: TTurn, selection: TSelection) => void;
}): boolean;
export declare function buildTelegramModelSwitchContinuationText<TModel extends MenuModel>(telegramPrefix: string, model: TModel, thinkingLevel?: ScopedTelegramModel<TModel>["thinkingLevel"]): string;
export type TelegramModelSwitchContinuationSource = Pick<PendingTelegramTurn, "chatId" | "replyToMessageId" | "target">;
export declare function buildTelegramModelSwitchContinuationTurn<TModel extends MenuModel>(options: {
    turn: TelegramModelSwitchContinuationSource;
    selection: ScopedTelegramModel<TModel>;
    telegramPrefix?: string;
    queueOrder: number;
    laneOrder: number;
}): PendingTelegramTurn;
export declare function createTelegramModelSwitchContinuationTurnBuilder<TModel extends MenuModel>(deps: {
    telegramPrefix?: string;
    allocateItemOrder: () => number;
    allocateControlOrder: () => number;
}): (options: {
    turn: TelegramModelSwitchContinuationSource;
    selection: ScopedTelegramModel<TModel>;
}) => PendingTelegramTurn;
export declare function createTelegramModelSwitchContinuationQueue<TContext, TSelection extends ScopedTelegramModel>(deps: {
    createContinuationTurn: (options: {
        turn: TelegramModelSwitchContinuationSource;
        selection: TSelection;
    }) => PendingTelegramTurn;
    appendQueuedItem: (item: PendingTelegramTurn, ctx: TContext) => void;
}): (turn: TelegramModelSwitchContinuationSource, selection: TSelection, ctx: TContext) => void;
export declare function createTelegramModelSwitchContinuationQueueRuntime<TContext, TSelection extends ScopedTelegramModel>(deps: {
    telegramPrefix?: string;
    allocateItemOrder: () => number;
    allocateControlOrder: () => number;
    appendQueuedItem: (item: PendingTelegramTurn, ctx: TContext) => void;
}): (turn: TelegramModelSwitchContinuationSource, selection: TSelection, ctx: TContext) => void;
export interface TelegramModelSwitchControllerDeps<TContext, TSelection> {
    isIdle: (ctx: TContext) => boolean;
    getPendingModelSwitch: () => TSelection | undefined;
    setPendingModelSwitch: (selection: TSelection | undefined) => void;
    getActiveTurn: () => PendingTelegramTurn | undefined;
    getAbortHandler: () => (() => void) | undefined;
    hasAbortHandler: () => boolean;
    getActiveToolExecutions: () => number;
    queueContinuation: (turn: TelegramModelSwitchContinuationSource, selection: TSelection, ctx: TContext) => void;
    updateStatus: (ctx: TContext) => void;
}
export interface TelegramModelSwitchController<TContext, TSelection> {
    canOfferInFlightSwitch: (ctx: TContext) => boolean;
    stagePendingSwitch: (selection: TSelection, ctx: TContext, continuationTurn?: TelegramModelSwitchContinuationSource) => void;
    clearPendingSwitch: () => void;
    queueContinuation: (turn: TelegramModelSwitchContinuationSource, selection: TSelection, ctx: TContext) => void;
    triggerPendingAbort: (ctx: TContext) => boolean;
    restartInterruptedTurn: (selection: TSelection, ctx: TContext, continuationTurn?: TelegramModelSwitchContinuationSource) => boolean;
}
export interface TelegramModelSwitchControllerRuntimeDeps<TContext, TSelection extends ScopedTelegramModel> extends Omit<TelegramModelSwitchControllerDeps<TContext, TSelection>, "queueContinuation"> {
    telegramPrefix?: string;
    allocateItemOrder: () => number;
    allocateControlOrder: () => number;
    appendQueuedItem: (item: PendingTelegramTurn, ctx: TContext) => void;
}
export declare function createTelegramModelSwitchControllerRuntime<TContext, TSelection extends ScopedTelegramModel>(deps: TelegramModelSwitchControllerRuntimeDeps<TContext, TSelection>): TelegramModelSwitchController<TContext, TSelection>;
export declare function createTelegramModelSwitchController<TContext, TSelection>(deps: TelegramModelSwitchControllerDeps<TContext, TSelection>): TelegramModelSwitchController<TContext, TSelection>;
