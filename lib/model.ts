/**
 * Telegram model control domain helpers
 * Zones: pi agent model control, telegram controls, queue continuation
 * Owns model identity, thinking levels, scoped resolution, current-model state, and in-flight model switching
 */

import type { PendingTelegramTurn } from "./queue.ts";
import { TELEGRAM_PREFIX } from "./turns.ts";

export interface MenuModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
}

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface ScopedTelegramModel<TModel extends MenuModel = MenuModel> {
  model: TModel;
  thinkingLevel?: ThinkingLevel;
}

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export interface CurrentModelStore<
  TContext,
  TModel extends MenuModel = MenuModel,
> {
  get: (ctx: TContext) => TModel | undefined;
  getStored: () => TModel | undefined;
  set: (model: TModel | undefined) => void;
}

export interface CurrentModelUpdateRuntime<
  TContext,
  TModel extends MenuModel = MenuModel,
> {
  setCurrentModel: (model: TModel | undefined, ctx: TContext) => void;
  onModelSelect: (event: { model: TModel | undefined }, ctx: TContext) => void;
}

export type CurrentModelRuntime<
  TContext,
  TModel extends MenuModel = MenuModel,
> = CurrentModelStore<TContext, TModel> &
  CurrentModelUpdateRuntime<TContext, TModel>;

export function createCurrentModelStore<
  TContext,
  TModel extends MenuModel = MenuModel,
>(
  getContextModel: (ctx: TContext) => TModel | undefined,
): CurrentModelStore<TContext, TModel> {
  let currentModel: TModel | undefined;
  return {
    get: (ctx) => currentModel ?? getContextModel(ctx),
    getStored: () => currentModel,
    set: (model) => {
      currentModel = model;
    },
  };
}

export function createCurrentModelUpdateRuntime<
  TContext,
  TModel extends MenuModel = MenuModel,
>(deps: {
  setCurrentModel: (model: TModel | undefined) => void;
  updateStatus: (ctx: TContext) => void;
}): CurrentModelUpdateRuntime<TContext, TModel> {
  const setAndUpdate = (model: TModel | undefined, ctx: TContext): void => {
    deps.setCurrentModel(model);
    deps.updateStatus(ctx);
  };
  return {
    setCurrentModel: setAndUpdate,
    onModelSelect: (event, ctx) => {
      setAndUpdate(event.model, ctx);
    },
  };
}

export function createCurrentModelRuntime<
  TContext,
  TModel extends MenuModel = MenuModel,
>(deps: {
  getContextModel: (ctx: TContext) => TModel | undefined;
  updateStatus: (ctx: TContext) => void;
}): CurrentModelRuntime<TContext, TModel> {
  const store = createCurrentModelStore(deps.getContextModel);
  return {
    ...store,
    ...createCurrentModelUpdateRuntime({
      setCurrentModel: store.set,
      updateStatus: deps.updateStatus,
    }),
  };
}

export function modelsMatch(
  a: Pick<MenuModel, "provider" | "id"> | undefined,
  b: Pick<MenuModel, "provider" | "id"> | undefined,
): boolean {
  return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

export function getCanonicalModelId(
  model: Pick<MenuModel, "provider" | "id">,
): string {
  return `${model.provider}/${model.id}`;
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVELS.includes(value as ThinkingLevel);
}

export function parseTelegramScopedModelPatternList(value: string): string[] {
  return value
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean);
}

export function parseTelegramCliScopedModelPatterns(
  args: string[],
): string[] | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--models") {
      const patterns = parseTelegramScopedModelPatternList(args[i + 1] ?? "");
      return patterns.length > 0 ? patterns : undefined;
    }
    if (arg.startsWith("--models=")) {
      const patterns = parseTelegramScopedModelPatternList(
        arg.slice("--models=".length),
      );
      return patterns.length > 0 ? patterns : undefined;
    }
  }
  return undefined;
}

function escapeRegex(text: string): string {
  return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globMatches(text: string, pattern: string): boolean {
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      regex += ".*";
      continue;
    }
    if (char === "?") {
      regex += ".";
      continue;
    }
    if (char === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end !== -1) {
        const content = pattern.slice(i + 1, end);
        regex += content.startsWith("!")
          ? `[^${content.slice(1)}]`
          : `[${content}]`;
        i = end;
        continue;
      }
    }
    regex += escapeRegex(char);
  }
  regex += "$";
  return new RegExp(regex, "i").test(text);
}

function isAliasModelId(id: string): boolean {
  if (id.endsWith("-latest")) return true;
  return !/-\d{8}$/.test(id);
}

function findExactModelReferenceMatch<TModel extends MenuModel = MenuModel>(
  modelReference: string,
  availableModels: TModel[],
): TModel | undefined {
  const trimmedReference = modelReference.trim();
  if (!trimmedReference) return undefined;
  const normalizedReference = trimmedReference.toLowerCase();
  const canonicalMatches = availableModels.filter(
    (model) => getCanonicalModelId(model).toLowerCase() === normalizedReference,
  );
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  if (canonicalMatches.length > 1) return undefined;
  const slashIndex = trimmedReference.indexOf("/");
  if (slashIndex !== -1) {
    const provider = trimmedReference.substring(0, slashIndex).trim();
    const modelId = trimmedReference.substring(slashIndex + 1).trim();
    if (provider && modelId) {
      const providerMatches = availableModels.filter(
        (model) =>
          model.provider.toLowerCase() === provider.toLowerCase() &&
          model.id.toLowerCase() === modelId.toLowerCase(),
      );
      if (providerMatches.length === 1) return providerMatches[0];
      if (providerMatches.length > 1) return undefined;
    }
  }
  const idMatches = availableModels.filter(
    (model) => model.id.toLowerCase() === normalizedReference,
  );
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

function tryMatchScopedModel<TModel extends MenuModel = MenuModel>(
  modelPattern: string,
  availableModels: TModel[],
): TModel | undefined {
  const exactMatch = findExactModelReferenceMatch(
    modelPattern,
    availableModels,
  );
  if (exactMatch) return exactMatch;
  const matches = availableModels.filter(
    (model) =>
      model.id.toLowerCase().includes(modelPattern.toLowerCase()) ||
      model.name?.toLowerCase().includes(modelPattern.toLowerCase()),
  );
  if (matches.length === 0) return undefined;
  const aliases = matches.filter((model) => isAliasModelId(model.id));
  const datedVersions = matches.filter((model) => !isAliasModelId(model.id));
  if (aliases.length > 0) {
    aliases.sort((a, b) => b.id.localeCompare(a.id));
    return aliases[0];
  }
  datedVersions.sort((a, b) => b.id.localeCompare(a.id));
  return datedVersions[0];
}

function parseScopedModelPattern<TModel extends MenuModel = MenuModel>(
  pattern: string,
  availableModels: TModel[],
): { model: TModel | undefined; thinkingLevel?: ThinkingLevel } {
  const exactMatch = tryMatchScopedModel(pattern, availableModels);
  if (exactMatch) {
    return { model: exactMatch, thinkingLevel: undefined };
  }
  const lastColonIndex = pattern.lastIndexOf(":");
  if (lastColonIndex === -1) {
    return { model: undefined, thinkingLevel: undefined };
  }
  const prefix = pattern.substring(0, lastColonIndex);
  const suffix = pattern.substring(lastColonIndex + 1);
  if (isThinkingLevel(suffix)) {
    const parsedPrefix = parseScopedModelPattern(prefix, availableModels);
    if (parsedPrefix.model) {
      return { model: parsedPrefix.model, thinkingLevel: suffix };
    }
    return parsedPrefix;
  }
  return parseScopedModelPattern(prefix, availableModels);
}

export function resolveScopedModelPatterns<
  TModel extends MenuModel = MenuModel,
>(
  patterns: string[],
  availableModels: TModel[],
): ScopedTelegramModel<TModel>[] {
  const resolved: ScopedTelegramModel<TModel>[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    if (
      pattern.includes("*") ||
      pattern.includes("?") ||
      pattern.includes("[")
    ) {
      const colonIndex = pattern.lastIndexOf(":");
      let globPattern = pattern;
      let thinkingLevel: ThinkingLevel | undefined;
      if (colonIndex !== -1) {
        const suffix = pattern.substring(colonIndex + 1);
        if (isThinkingLevel(suffix)) {
          thinkingLevel = suffix;
          globPattern = pattern.substring(0, colonIndex);
        }
      }
      const matches = availableModels.filter(
        (model) =>
          globMatches(getCanonicalModelId(model), globPattern) ||
          globMatches(model.id, globPattern),
      );
      for (const model of matches) {
        const key = getCanonicalModelId(model);
        if (seen.has(key)) continue;
        seen.add(key);
        resolved.push({ model, thinkingLevel });
      }
      continue;
    }
    const matched = parseScopedModelPattern(pattern, availableModels);
    if (!matched.model) continue;
    const key = getCanonicalModelId(matched.model);
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({
      model: matched.model,
      thinkingLevel: matched.thinkingLevel,
    });
  }
  return resolved;
}

export function sortScopedModels<TModel extends MenuModel = MenuModel>(
  models: ScopedTelegramModel<TModel>[],
  currentModel: TModel | undefined,
): ScopedTelegramModel<TModel>[] {
  const sorted = [...models];
  sorted.sort((a, b) => {
    const aIsCurrent = modelsMatch(a.model, currentModel);
    const bIsCurrent = modelsMatch(b.model, currentModel);
    if (aIsCurrent && !bIsCurrent) return -1;
    if (!aIsCurrent && bIsCurrent) return 1;
    const providerCompare = a.model.provider.localeCompare(b.model.provider);
    if (providerCompare !== 0) return providerCompare;
    return a.model.id.localeCompare(b.model.id);
  });
  return sorted;
}

// --- In-Flight Model Switching ---

export interface PendingModelSwitchStore<TSelection> {
  get: () => TSelection | undefined;
  set: (selection: TSelection | undefined) => void;
  clear: () => void;
  has: () => boolean;
}

export interface TelegramInFlightModelSwitchState {
  isIdle: boolean;
  hasActiveTelegramTurn: boolean;
  hasAbortHandler: boolean;
}

export function createPendingModelSwitchStore<
  TSelection,
>(): PendingModelSwitchStore<TSelection> {
  let selection: TSelection | undefined;
  return {
    get: () => selection,
    set: (nextSelection) => {
      selection = nextSelection;
    },
    clear: () => {
      selection = undefined;
    },
    has: () => selection !== undefined,
  };
}

export function canRestartTelegramTurnForModelSwitch(
  state: TelegramInFlightModelSwitchState,
): boolean {
  return !state.isIdle && state.hasActiveTelegramTurn && state.hasAbortHandler;
}

export function shouldTriggerPendingTelegramModelSwitchAbort(state: {
  hasPendingModelSwitch: boolean;
  hasActiveTelegramTurn: boolean;
  hasAbortHandler: boolean;
  activeToolExecutions: number;
}): boolean {
  return (
    state.hasPendingModelSwitch &&
    state.hasActiveTelegramTurn &&
    state.hasAbortHandler &&
    state.activeToolExecutions === 0
  );
}

export function restartTelegramModelSwitchContinuation<
  TTurn,
  TSelection,
>(state: {
  activeTurn: TTurn | undefined;
  abort: (() => void) | undefined;
  selection: TSelection;
  queueContinuation: (turn: TTurn, selection: TSelection) => void;
}): boolean {
  if (!state.activeTurn || !state.abort) return false;
  state.queueContinuation(state.activeTurn, state.selection);
  state.abort();
  return true;
}

function truncateTelegramModelSwitchStatusSummary(
  text: string,
  maxWords = 4,
  maxLength = 32,
): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const words = normalized.split(" ");
  let summary = words.slice(0, maxWords).join(" ");
  if (summary.length === 0) summary = normalized;
  if (summary.length > maxLength) {
    summary = summary.slice(0, maxLength).trimEnd();
  }
  return summary.length < normalized.length || words.length > maxWords
    ? `${summary}…`
    : summary;
}

export function buildTelegramModelSwitchContinuationText<
  TModel extends MenuModel,
>(
  telegramPrefix: string,
  model: TModel,
  thinkingLevel?: ScopedTelegramModel<TModel>["thinkingLevel"],
): string {
  const modelLabel = `${model.provider}/${model.id}`;
  const thinkingSuffix = thinkingLevel
    ? ` Keep the selected thinking level (${thinkingLevel}) if it still applies.`
    : "";
  return `${telegramPrefix} Continue the interrupted previous Telegram request using the newly selected model (${modelLabel}). Resume from the last unfinished step instead of restarting from scratch unless necessary.${thinkingSuffix}`;
}

export function buildTelegramModelSwitchContinuationTurn<
  TModel extends MenuModel,
>(options: {
  turn: Pick<PendingTelegramTurn, "chatId" | "replyToMessageId">;
  selection: ScopedTelegramModel<TModel>;
  telegramPrefix?: string;
  queueOrder: number;
  laneOrder: number;
}): PendingTelegramTurn {
  const modelLabel = `${options.selection.model.provider}/${options.selection.model.id}`;
  const statusLabel = truncateTelegramModelSwitchStatusSummary(
    `continue on ${options.selection.model.id}`,
  );
  return {
    kind: "prompt",
    chatId: options.turn.chatId,
    replyToMessageId: options.turn.replyToMessageId,
    sourceMessageIds: [],
    queueOrder: options.queueOrder,
    queueLane: "control",
    laneOrder: options.laneOrder,
    queuedAttachments: [],
    content: [
      {
        type: "text",
        text: buildTelegramModelSwitchContinuationText(
          options.telegramPrefix ?? TELEGRAM_PREFIX,
          options.selection.model,
          options.selection.thinkingLevel,
        ),
      },
    ],
    historyText: `Continue interrupted Telegram request on ${modelLabel}`,
    statusSummary: `↻ ${statusLabel || "continue"}`,
  };
}

export function createTelegramModelSwitchContinuationTurnBuilder<
  TModel extends MenuModel,
>(deps: {
  telegramPrefix?: string;
  allocateItemOrder: () => number;
  allocateControlOrder: () => number;
}): (options: {
  turn: Pick<PendingTelegramTurn, "chatId" | "replyToMessageId">;
  selection: ScopedTelegramModel<TModel>;
}) => PendingTelegramTurn {
  return (options) =>
    buildTelegramModelSwitchContinuationTurn({
      ...options,
      telegramPrefix: deps.telegramPrefix,
      queueOrder: deps.allocateItemOrder(),
      laneOrder: deps.allocateControlOrder(),
    });
}

export function createTelegramModelSwitchContinuationQueue<
  TContext,
  TSelection extends ScopedTelegramModel,
>(deps: {
  createContinuationTurn: (options: {
    turn: Pick<PendingTelegramTurn, "chatId" | "replyToMessageId">;
    selection: TSelection;
  }) => PendingTelegramTurn;
  appendQueuedItem: (item: PendingTelegramTurn, ctx: TContext) => void;
}): (turn: PendingTelegramTurn, selection: TSelection, ctx: TContext) => void {
  return (turn, selection, ctx) => {
    deps.appendQueuedItem(
      deps.createContinuationTurn({ turn, selection }),
      ctx,
    );
  };
}

export function createTelegramModelSwitchContinuationQueueRuntime<
  TContext,
  TSelection extends ScopedTelegramModel,
>(deps: {
  telegramPrefix?: string;
  allocateItemOrder: () => number;
  allocateControlOrder: () => number;
  appendQueuedItem: (item: PendingTelegramTurn, ctx: TContext) => void;
}): (turn: PendingTelegramTurn, selection: TSelection, ctx: TContext) => void {
  return createTelegramModelSwitchContinuationQueue<TContext, TSelection>({
    createContinuationTurn: createTelegramModelSwitchContinuationTurnBuilder({
      telegramPrefix: deps.telegramPrefix,
      allocateItemOrder: deps.allocateItemOrder,
      allocateControlOrder: deps.allocateControlOrder,
    }),
    appendQueuedItem: deps.appendQueuedItem,
  });
}

export interface TelegramModelSwitchControllerDeps<TContext, TSelection> {
  isIdle: (ctx: TContext) => boolean;
  getPendingModelSwitch: () => TSelection | undefined;
  setPendingModelSwitch: (selection: TSelection | undefined) => void;
  getActiveTurn: () => PendingTelegramTurn | undefined;
  getAbortHandler: () => (() => void) | undefined;
  hasAbortHandler: () => boolean;
  getActiveToolExecutions: () => number;
  queueContinuation: (
    turn: PendingTelegramTurn,
    selection: TSelection,
    ctx: TContext,
  ) => void;
  updateStatus: (ctx: TContext) => void;
}

export interface TelegramModelSwitchController<TContext, TSelection> {
  canOfferInFlightSwitch: (ctx: TContext) => boolean;
  stagePendingSwitch: (selection: TSelection, ctx: TContext) => void;
  clearPendingSwitch: () => void;
  queueContinuation: (
    turn: PendingTelegramTurn,
    selection: TSelection,
    ctx: TContext,
  ) => void;
  triggerPendingAbort: (ctx: TContext) => boolean;
  restartInterruptedTurn: (selection: TSelection, ctx: TContext) => boolean;
}

export interface TelegramModelSwitchControllerRuntimeDeps<
  TContext,
  TSelection extends ScopedTelegramModel,
> extends Omit<
  TelegramModelSwitchControllerDeps<TContext, TSelection>,
  "queueContinuation"
> {
  telegramPrefix?: string;
  allocateItemOrder: () => number;
  allocateControlOrder: () => number;
  appendQueuedItem: (item: PendingTelegramTurn, ctx: TContext) => void;
}

export function createTelegramModelSwitchControllerRuntime<
  TContext,
  TSelection extends ScopedTelegramModel,
>(
  deps: TelegramModelSwitchControllerRuntimeDeps<TContext, TSelection>,
): TelegramModelSwitchController<TContext, TSelection> {
  return createTelegramModelSwitchController({
    isIdle: deps.isIdle,
    getPendingModelSwitch: deps.getPendingModelSwitch,
    setPendingModelSwitch: deps.setPendingModelSwitch,
    getActiveTurn: deps.getActiveTurn,
    getAbortHandler: deps.getAbortHandler,
    hasAbortHandler: deps.hasAbortHandler,
    getActiveToolExecutions: deps.getActiveToolExecutions,
    queueContinuation: createTelegramModelSwitchContinuationQueueRuntime({
      telegramPrefix: deps.telegramPrefix,
      allocateItemOrder: deps.allocateItemOrder,
      allocateControlOrder: deps.allocateControlOrder,
      appendQueuedItem: deps.appendQueuedItem,
    }),
    updateStatus: deps.updateStatus,
  });
}

export function createTelegramModelSwitchController<TContext, TSelection>(
  deps: TelegramModelSwitchControllerDeps<TContext, TSelection>,
): TelegramModelSwitchController<TContext, TSelection> {
  return {
    canOfferInFlightSwitch: (ctx) =>
      canRestartTelegramTurnForModelSwitch({
        isIdle: deps.isIdle(ctx),
        hasActiveTelegramTurn: !!deps.getActiveTurn(),
        hasAbortHandler: deps.hasAbortHandler(),
      }),
    stagePendingSwitch: (selection, ctx) => {
      deps.setPendingModelSwitch(selection);
      deps.updateStatus(ctx);
    },
    clearPendingSwitch: () => {
      deps.setPendingModelSwitch(undefined);
    },
    queueContinuation: deps.queueContinuation,
    triggerPendingAbort: (ctx) => {
      if (
        !shouldTriggerPendingTelegramModelSwitchAbort({
          hasPendingModelSwitch: !!deps.getPendingModelSwitch(),
          hasActiveTelegramTurn: !!deps.getActiveTurn(),
          hasAbortHandler: deps.hasAbortHandler(),
          activeToolExecutions: deps.getActiveToolExecutions(),
        })
      ) {
        return false;
      }
      const selection = deps.getPendingModelSwitch();
      const turn = deps.getActiveTurn();
      const abort = deps.getAbortHandler();
      if (!selection || !turn || !abort) return false;
      deps.setPendingModelSwitch(undefined);
      deps.queueContinuation(turn, selection, ctx);
      abort();
      return true;
    },
    restartInterruptedTurn: (selection, ctx) =>
      restartTelegramModelSwitchContinuation({
        activeTurn: deps.getActiveTurn(),
        abort: deps.getAbortHandler(),
        selection,
        queueContinuation: (turn, nextSelection) => {
          deps.queueContinuation(turn, nextSelection, ctx);
        },
      }),
  };
}
