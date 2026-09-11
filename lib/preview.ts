/**
 * Telegram preview streaming helpers
 * Zones: telegram outbound, native rich markdown drafts
 * Owns safe draft preview selection, runtime updates, and preview finalization
 */

import { normalizeTelegramNativeMarkdown } from "./replies.ts";
import type { TelegramAssistantOutputPreparation } from "./activity.ts";
import { stripTelegramCommentMarkupForPreview } from "./outbound-markup.ts";
import {
  getTelegramTargetThreadParams,
  type TelegramTarget,
} from "./target.ts";
import { shouldSuppressPreviewForVoice } from "./voice.ts";

const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;
const TELEGRAM_DRAFT_PREVIEW_MAX_CHARS = 4096;
// Native draft cadence: at most one frame per interval, and a fresh preview
// segment holds its first frame for one full interval so the opening frame is
// an accumulated passage rather than a single streamed word.
const TELEGRAM_DRAFT_INTERVAL_MS = 2_000;

export type TelegramDraftSupport = "unknown" | "supported";

export interface TelegramPreviewState {
  mode: "draft";
  draftId?: number;
  pendingText: string;
  lastSentText: string;
}

export interface TelegramPreviewRuntimeState extends TelegramPreviewState {
  flushPromise?: Promise<void>;
  flushRequested?: boolean;
  precedingFlush?: Promise<void>;
  publicationPromise?: Promise<void>;
  sealed?: boolean;
  nextDraftAt?: number;
  flushTimer?: ReturnType<typeof setTimeout>;
}

export type TelegramPreviewReplyMarkup = unknown;

export interface TelegramPreviewRuntimeDeps {
  getState: () => TelegramPreviewRuntimeState | undefined;
  setState: (state: TelegramPreviewRuntimeState | undefined) => void;
  maxMessageLength: number;
  minDraftIntervalMs?: number;
  getDraftSupport: () => TelegramDraftSupport;
  setDraftSupport: (support: TelegramDraftSupport) => void;
  allocateDraftId: () => number;
  sendDraft: (
    chatId: number,
    draftId: number,
    text?: string,
    options?: {
      parse_mode?: string;
      entities?: unknown[];
      message_thread_id?: number;
    },
  ) => Promise<unknown>;
  canSend?: () => boolean;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramPreviewActiveTurn {
  chatId: number;
  replyToMessageId?: number;
  target?: TelegramTarget;
  voiceReplyPreferred?: boolean;
  voiceReplyRequired?: boolean;
  guestQueryId?: string;
}

export interface TelegramAssistantMessagePreviewStartDeps<TMessage> {
  getActiveTurn: () => TelegramPreviewActiveTurn | undefined;
  isAssistantMessage: (message: TMessage) => boolean;
  getState: () => TelegramPreviewRuntimeState | undefined;
  setState: (state: TelegramPreviewRuntimeState | undefined) => void;
  createPreviewState: () => TelegramPreviewRuntimeState;
  canSend?: () => boolean;
}

export interface TelegramAssistantMessagePreviewUpdateDeps<TMessage> {
  getActiveTurn: () => TelegramPreviewActiveTurn | undefined;
  isAssistantMessage: (message: TMessage) => boolean;
  getState: () => TelegramPreviewRuntimeState | undefined;
  setState: (state: TelegramPreviewRuntimeState | undefined) => void;
  createPreviewState: () => TelegramPreviewRuntimeState;
  canSend?: () => boolean;
  getMessageText: (message: TMessage) => string;
  minDraftIntervalMs?: number;
  schedulePreviewFlush: (
    chatId: number,
    options?: { target?: TelegramTarget },
  ) => void;
}

export type TelegramAssistantMessagePreviewHookDeps<TMessage> = TelegramAssistantMessagePreviewStartDeps<TMessage> &
  TelegramAssistantMessagePreviewUpdateDeps<TMessage>;

export interface TelegramAssistantMessagePreviewHookEvent<TMessage> {
  message: TMessage;
}

export interface TelegramAssistantMessagePreviewHooks<TMessage> {
  onMessageStart: (
    event: TelegramAssistantMessagePreviewHookEvent<TMessage>,
  ) => Promise<void>;
  onMessageUpdate: (
    event: TelegramAssistantMessagePreviewHookEvent<TMessage>,
  ) => Promise<void>;
}

export interface TelegramPreviewControllerDeps {
  getDefaultReplyToMessageId?: () => number | undefined;
  maxMessageLength?: number;
  initialDraftSupport?: TelegramDraftSupport;
  sendDraft: (
    chatId: number,
    draftId: number,
    text?: string,
    options?: {
      parse_mode?: string;
      entities?: unknown[];
      message_thread_id?: number;
    },
  ) => Promise<unknown>;
  canSend?: () => boolean;
  maxDraftId?: number;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramPreviewController {
  seal: () => void;
  preparePublication: () => TelegramAssistantOutputPreparation | undefined;
  prepareClear: (
    chatId: number,
    options?: { target?: TelegramTarget; isDeliveryActive?: () => boolean },
  ) => () => Promise<void>;
  getState: () => TelegramPreviewRuntimeState | undefined;
  setState: (state: TelegramPreviewRuntimeState | undefined) => void;
  setPendingText: (text: string) => void;
  createState: () => TelegramPreviewRuntimeState;
  resetState: () => void;
  invalidate: () => void;
  clear: (
    chatId: number,
    options?: { awaitFlush?: boolean; target?: TelegramTarget },
  ) => Promise<void>;
  flush: (
    chatId: number,
    options?: { target?: TelegramTarget },
  ) => Promise<void>;
  scheduleFlush: (
    chatId: number,
    options?: { target?: TelegramTarget },
  ) => void;
  finalize: (
    chatId: number,
    replyToMessageId?: number,
    options?: { target?: TelegramTarget },
  ) => Promise<boolean>;
}

export type TelegramPreviewControllerRuntimeDeps =
  TelegramPreviewControllerDeps;

export function createTelegramPreviewControllerRuntime(
  deps: TelegramPreviewControllerRuntimeDeps,
): TelegramPreviewController {
  return createTelegramPreviewController({
    getDefaultReplyToMessageId: deps.getDefaultReplyToMessageId,
    maxMessageLength: deps.maxMessageLength,
    initialDraftSupport: deps.initialDraftSupport,
    sendDraft: deps.sendDraft,
    canSend: deps.canSend,
    maxDraftId: deps.maxDraftId,
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
}

export interface TelegramAssistantPreviewRuntimeDeps<
  TMessage,
  TReplyMarkup = TelegramPreviewReplyMarkup,
> extends TelegramPreviewControllerRuntimeDeps {
  getActiveTurn: () => TelegramPreviewActiveTurn | undefined;
  isAssistantMessage: (message: TMessage) => boolean;
  getMessageText: (message: TMessage) => string;
  sendMarkdownReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    markdown: string,
    options?: { replyMarkup?: TReplyMarkup; target?: TelegramTarget },
  ) => Promise<number | undefined>;
}

export interface TelegramPreparedPreviewDelivery<TReplyMarkup = unknown> {
  clearPreview: TelegramPreviewController["clear"];
  setPreviewPendingText: TelegramPreviewController["setPendingText"];
  finalizeMarkdownPreview: ReturnType<typeof createTelegramNativeMarkdownPreviewFinalizer<TReplyMarkup>>;
}

export type TelegramAssistantPreviewRuntime<
  TMessage,
  TReplyMarkup = TelegramPreviewReplyMarkup,
> = TelegramPreviewController &
  TelegramAssistantMessagePreviewHooks<TMessage> & {
    prepareDelivery: (isDeliveryActive: () => boolean) => TelegramPreparedPreviewDelivery<TReplyMarkup>;
    finalizeMarkdown: (
      chatId: number,
      markdown: string,
      replyToMessageId?: number,
      options?: { replyMarkup?: TReplyMarkup; target?: TelegramTarget },
    ) => Promise<boolean>;
  };

function sealTelegramPreviewState(state: TelegramPreviewRuntimeState | undefined): void {
  if (!state) return;
  state.sealed = true;
  state.flushRequested = false;
  if (state.flushTimer) clearTimeout(state.flushTimer);
  state.flushTimer = undefined;
}

export function createTelegramNativeMarkdownPreviewFinalizer<
  TReplyMarkup,
>(deps: {
  getState: () => TelegramPreviewRuntimeState | undefined;
  clear: (
    chatId: number,
    options?: { awaitFlush?: boolean; target?: TelegramTarget },
  ) => Promise<void>;
  discard?: () => void;
  isDeliveryActive?: () => boolean;
  sendMarkdownReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    markdown: string,
    options?: { replyMarkup?: TReplyMarkup; target?: TelegramTarget },
  ) => Promise<number | undefined>;
}): (
  chatId: number,
  markdown: string,
  replyToMessageId?: number,
  options?: { replyMarkup?: TReplyMarkup; target?: TelegramTarget },
) => Promise<boolean> {
  return (...args) => prepareTelegramNativeMarkdownPreviewFinalizer(deps)(...args);
}

function prepareTelegramNativeMarkdownPreviewFinalizer<TReplyMarkup>(
  deps: Parameters<typeof createTelegramNativeMarkdownPreviewFinalizer<TReplyMarkup>>[0],
): ReturnType<typeof createTelegramNativeMarkdownPreviewFinalizer<TReplyMarkup>> {
  const state = deps.getState();
  sealTelegramPreviewState(state);
  const inFlight = state?.flushPromise ?? state?.precedingFlush;
  return async (chatId, markdown, replyToMessageId, options) => {
    if (deps.isDeliveryActive?.() === false) return false;
    await inFlight?.catch(() => {});
    if (deps.getState() !== state || deps.isDeliveryActive?.() === false) return false;
    await deps.sendMarkdownReply(chatId, replyToMessageId, markdown, options);
    if (deps.getState() === state && deps.isDeliveryActive?.() !== false) deps.discard?.();
    return true;
  };
}

export function createTelegramAssistantPreviewRuntime<
  TMessage,
  TReplyMarkup = TelegramPreviewReplyMarkup,
>(
  deps: TelegramAssistantPreviewRuntimeDeps<TMessage, TReplyMarkup>,
): TelegramAssistantPreviewRuntime<TMessage, TReplyMarkup> {
  const controller = createTelegramPreviewControllerRuntime(deps);
  const finalizerDeps = {
    getState: controller.getState,
    clear: controller.clear,
    discard: () => controller.setState(undefined),
    sendMarkdownReply: deps.sendMarkdownReply,
  };
  return {
    ...controller,
    finalizeMarkdown: createTelegramNativeMarkdownPreviewFinalizer(finalizerDeps),
    prepareDelivery(isDeliveryActive) {
      const state = controller.getState();
      return {
        setPreviewPendingText(text) {
          if (controller.getState() === state && isDeliveryActive()) controller.setPendingText(text);
        },
        clearPreview: async (chatId, options) => {
          if (controller.getState() !== state || !isDeliveryActive()) return;
          await controller.prepareClear(chatId, { ...options, isDeliveryActive })();
        },
        finalizeMarkdownPreview: prepareTelegramNativeMarkdownPreviewFinalizer({ ...finalizerDeps, isDeliveryActive }),
      };
    },
    ...createTelegramAssistantMessagePreviewHooks({
      getActiveTurn: deps.getActiveTurn,
      isAssistantMessage: deps.isAssistantMessage,
      getState: controller.getState,
      setState: controller.setState,
      createPreviewState: controller.createState,
      canSend: deps.canSend,
      getMessageText: deps.getMessageText,
      minDraftIntervalMs: TELEGRAM_DRAFT_INTERVAL_MS,
      schedulePreviewFlush: controller.scheduleFlush,
    }),
  };
}

export function createTelegramPreviewController(
  deps: TelegramPreviewControllerDeps,
): TelegramPreviewController {
  let state: TelegramPreviewRuntimeState | undefined;
  let generation = 0;
  const maxDraftId = deps.maxDraftId ?? TELEGRAM_DRAFT_ID_MAX;
  const maxMessageLength =
    deps.maxMessageLength ?? TELEGRAM_DRAFT_PREVIEW_MAX_CHARS;
  let draftSupport = deps.initialDraftSupport ?? "unknown";
  let nextDraftId = 0;
  const setState = (nextState: TelegramPreviewRuntimeState | undefined): void => {
    if (state !== nextState) sealTelegramPreviewState(state);
    state = nextState;
  };
  const getRuntimeDeps = (
    operationGeneration = generation,
  ): TelegramPreviewRuntimeDeps => ({
    getState: () => state,
    setState,
    maxMessageLength,
    minDraftIntervalMs: TELEGRAM_DRAFT_INTERVAL_MS,
    getDraftSupport: () => draftSupport,
    setDraftSupport: (support) => {
      draftSupport = support;
    },
    allocateDraftId: () => {
      nextDraftId = allocateTelegramDraftId(nextDraftId, maxDraftId);
      return nextDraftId;
    },
    sendDraft: deps.sendDraft,
    canSend: () =>
      operationGeneration === generation && (deps.canSend?.() ?? true),
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
  return {
    getState: () => state,
    setState,
    setPendingText: (text) => {
      if (state) state.pendingText = text;
    },
    createState: () => createTelegramPreviewRuntimeState(),
    resetState: () => {
      generation += 1;
      setState({ ...createTelegramPreviewRuntimeState(), nextDraftAt: state?.nextDraftAt });
    },
    invalidate: () => {
      generation += 1;
      setState(undefined);
    },
    seal: () => sealTelegramPreviewState(state),
    preparePublication: () => {
      if (!state) return undefined;
      sealTelegramPreviewState(state);
      const prior = state.publicationPromise ?? state.flushPromise ?? state.precedingFlush;
      let settle!: () => void;
      state.publicationPromise = new Promise<void>((resolve) => { settle = resolve; });
      return { wait: async () => { await prior?.catch(() => {}); }, settle };
    },
    prepareClear: (chatId, options) => {
      const admittedState = state;
      const runtime = getRuntimeDeps();
      return async () => {
        if (state !== admittedState) return;
        await clearTelegramPreview(chatId, runtime, {
          ...options,
          isDeliveryActive: () => runtime.canSend?.() !== false && options?.isDeliveryActive?.() !== false,
        });
      };
    },
    clear: (chatId, options) =>
      clearTelegramPreview(chatId, getRuntimeDeps(), options),
    flush: (chatId, options) =>
      flushTelegramPreview(chatId, getRuntimeDeps(), options),
    scheduleFlush: (chatId, options) => {
      if (!state) return;
      void flushTelegramPreview(chatId, getRuntimeDeps(), options);
    },
    finalize: (chatId, _replyToMessageId, options) =>
      finalizeTelegramPreview(chatId, getRuntimeDeps(), options),
  };
}

export function createTelegramAssistantMessagePreviewHooks<TMessage>(
  deps: TelegramAssistantMessagePreviewHookDeps<TMessage>,
): TelegramAssistantMessagePreviewHooks<TMessage> {
  return {
    onMessageStart: async (
      event: TelegramAssistantMessagePreviewHookEvent<TMessage>,
    ): Promise<void> => {
      await handleTelegramAssistantMessagePreviewStart(event.message, deps);
    },
    onMessageUpdate: async (
      event: TelegramAssistantMessagePreviewHookEvent<TMessage>,
    ): Promise<void> => {
      await handleTelegramAssistantMessagePreviewUpdate(event.message, deps);
    },
  };
}

/**
 * Returns true when the active turn is a Telegram Guest Mode query. A guest
 * query allows exactly one answer within a limited Telegram response window,
 * so it must never emit streaming draft previews.
 */
export function shouldSuppressPreviewForGuestTurn(
  turn: { guestQueryId?: string } | null | undefined,
): boolean {
  return !!turn?.guestQueryId;
}

export async function handleTelegramAssistantMessagePreviewStart<TMessage>(
  message: TMessage,
  deps: TelegramAssistantMessagePreviewStartDeps<TMessage>,
): Promise<void> {
  const turn = deps.getActiveTurn();
  if (!turn || !deps.isAssistantMessage(message)) return;
  if (deps.canSend && !deps.canSend()) {
    deps.setState(undefined);
    return;
  }
  if (shouldSuppressPreviewForVoice(turn)) {
    deps.setState(undefined);
    return;
  }
  if (shouldSuppressPreviewForGuestTurn(turn)) {
    deps.setState(undefined);
    return;
  }
  const state = deps.getState();
  sealTelegramPreviewState(state);
  const next = deps.createPreviewState();
  // Carry the previous delivery boundary; permanent text remains with its publication owner.
  next.draftId = state?.draftId;
  next.nextDraftAt = state?.nextDraftAt;
  next.precedingFlush = state?.publicationPromise ?? state?.flushPromise ?? state?.precedingFlush;
  deps.setState(next);
}

export async function handleTelegramAssistantMessagePreviewUpdate<TMessage>(
  message: TMessage,
  deps: TelegramAssistantMessagePreviewUpdateDeps<TMessage>,
): Promise<void> {
  const turn = deps.getActiveTurn();
  if (!turn || !deps.isAssistantMessage(message)) return;
  if (deps.canSend && !deps.canSend()) {
    deps.setState(undefined);
    return;
  }
  if (shouldSuppressPreviewForVoice(turn)) return;
  if (shouldSuppressPreviewForGuestTurn(turn)) return;
  let state = deps.getState();
  if (!state) {
    state = deps.createPreviewState();
    deps.setState(state);
  }
  if (state.sealed) return;
  const hadVisibleText = state.pendingText.length > 0;
  state.pendingText = stripTelegramCommentMarkupForPreview(
    deps.getMessageText(message),
  );
  // The first visible text of a preview segment opens an initial accumulation
  // window, so the segment's first frame cannot ship as a single word even
  // when the previous cadence boundary has already passed (fresh turn, slow
  // first token, or message rollover after tool work). Later deltas keep the
  // trailing deadline instead of sliding it on every update.
  const interval = deps.minDraftIntervalMs ?? 0;
  if (
    interval > 0 &&
    !hadVisibleText &&
    !state.lastSentText &&
    state.pendingText.length > 0
  ) {
    state.nextDraftAt = Math.max(state.nextDraftAt ?? 0, Date.now() + interval);
  }
  deps.schedulePreviewFlush(turn.chatId, { target: turn.target });
}

export function buildTelegramPreviewFinalText(
  state: TelegramPreviewState,
): string | undefined {
  const finalText = state.pendingText.trim();
  if (finalText) return finalText;
  return state.lastSentText.trim() || undefined;
}

export function createTelegramPreviewRuntimeState(): TelegramPreviewRuntimeState {
  return {
    mode: "draft",
    pendingText: "",
    lastSentText: "",
  };
}

export function allocateTelegramDraftId(
  currentDraftId: number,
  maxDraftId: number,
): number {
  return currentDraftId >= maxDraftId ? 1 : currentDraftId + 1;
}

interface TelegramNativeMarkdownPreviewSnapshot {
  text: string;
}

export function shouldUseTelegramDraftPreview(_options: {
  draftSupport: TelegramDraftSupport;
  snapshot?: TelegramNativeMarkdownPreviewSnapshot;
}): boolean {
  return true;
}

export async function clearTelegramPreview(
  chatId: number,
  deps: TelegramPreviewRuntimeDeps,
  options: { awaitFlush?: boolean; target?: TelegramTarget; isDeliveryActive?: () => boolean } = {},
): Promise<void> {
  const state = deps.getState();
  if (!state || options.isDeliveryActive?.() === false) return;
  sealTelegramPreviewState(state);
  const inFlight = state.flushPromise ?? state.precedingFlush;
  if (inFlight && options.awaitFlush !== false) {
    state.flushRequested = false;
    await inFlight.catch(() => {});
    if (deps.getState() !== state) return;
  }
  if (options.isDeliveryActive?.() === false) return;
  deps.setState(undefined);
  if (state.mode === "draft" && state.draftId !== undefined && deps.canSend?.() !== false) {
    try {
      await deps.sendDraft(chatId, state.draftId, undefined, {
        ...getTelegramTargetThreadParams(options.target ?? { chatId }),
      });
    } catch (error) {
      deps.recordRuntimeEvent?.("preview", error, {
        phase: "clear-draft",
        chatId,
        draftId: state.draftId,
      });
    }
  }
}

interface TelegramDraftInlineState {
  codeTicks: number;
  htmlComment: boolean;
  displayMath: boolean;
  fence?: { marker: "`" | "~"; length: number };
  strongAsterisk: boolean;
  emphasisAsterisk: boolean;
  strongUnderscore: boolean;
  emphasisUnderscore: boolean;
  strike: boolean;
  linkText: boolean;
  linkDestination: boolean;
}

function createTelegramDraftInlineState(): TelegramDraftInlineState {
  return {
    codeTicks: 0,
    htmlComment: false,
    displayMath: false,
    strongAsterisk: false,
    emphasisAsterisk: false,
    strongUnderscore: false,
    emphasisUnderscore: false,
    strike: false,
    linkText: false,
    linkDestination: false,
  };
}

function isTelegramDraftInlineStateClosed(
  state: TelegramDraftInlineState,
): boolean {
  return (
    state.codeTicks === 0 &&
    !state.htmlComment &&
    !state.displayMath &&
    !state.fence &&
    !state.strongAsterisk &&
    !state.emphasisAsterisk &&
    !state.strongUnderscore &&
    !state.emphasisUnderscore &&
    !state.strike &&
    !state.linkText &&
    !state.linkDestination
  );
}

function countRepeatedChars(text: string, index: number, char: string): number {
  let count = 0;
  while (text[index + count] === char) count += 1;
  return count;
}

function isEscapedMarkdownChar(text: string, index: number): boolean {
  let slashCount = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && text[cursor] === "\\";
    cursor -= 1
  ) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function isInlineDelimiterCandidate(
  text: string,
  index: number,
  length: number,
): boolean {
  const previous = text[index - 1] ?? "";
  const next = text[index + length] ?? "";
  if (!next || /\s/.test(next))
    return previous.length > 0 && !/\s/.test(previous);
  if (!previous || /\s/.test(previous)) return true;
  return /[\p{P}\p{S}]/u.test(previous) || /[\p{P}\p{S}]/u.test(next);
}

function updateTelegramDraftInlineStateForLine(
  line: string,
  state: TelegramDraftInlineState,
): void {
  if (state.fence || state.displayMath) return;
  for (let index = 0; index < line.length; index += 1) {
    if (state.htmlComment) {
      const closeIndex = line.indexOf("-->", index);
      if (closeIndex === -1) return;
      state.htmlComment = false;
      index = closeIndex + 2;
      continue;
    }
    if (state.codeTicks > 0) {
      const ticks = countRepeatedChars(line, index, "`");
      if (ticks >= state.codeTicks) {
        state.codeTicks = 0;
        index += ticks - 1;
      }
      continue;
    }
    if (isEscapedMarkdownChar(line, index)) continue;
    if (line.startsWith("<!--", index)) {
      const closeIndex = line.indexOf("-->", index + 4);
      if (closeIndex === -1) {
        state.htmlComment = true;
        return;
      }
      index = closeIndex + 2;
      continue;
    }
    const ticks = countRepeatedChars(line, index, "`");
    if (ticks > 0) {
      state.codeTicks = ticks;
      index += ticks - 1;
      continue;
    }
    if (line.startsWith("][", index) || line.startsWith("](", index)) {
      state.linkText = false;
      state.linkDestination = true;
      index += 1;
      continue;
    }
    if (line[index] === "[" && !state.linkDestination) {
      state.linkText = true;
      continue;
    }
    if (line[index] === ")" && state.linkDestination) {
      state.linkDestination = false;
      continue;
    }
    if (
      line.startsWith("~~", index) &&
      isInlineDelimiterCandidate(line, index, 2)
    ) {
      state.strike = !state.strike;
      index += 1;
      continue;
    }
    if (
      line.startsWith("**", index) &&
      isInlineDelimiterCandidate(line, index, 2)
    ) {
      state.strongAsterisk = !state.strongAsterisk;
      index += 1;
      continue;
    }
    if (line[index] === "*" && isInlineDelimiterCandidate(line, index, 1)) {
      state.emphasisAsterisk = !state.emphasisAsterisk;
      continue;
    }
    if (
      line.startsWith("__", index) &&
      isInlineDelimiterCandidate(line, index, 2)
    ) {
      state.strongUnderscore = !state.strongUnderscore;
      index += 1;
      continue;
    }
    if (line[index] === "_" && isInlineDelimiterCandidate(line, index, 1)) {
      state.emphasisUnderscore = !state.emphasisUnderscore;
    }
  }
}

function updateTelegramDraftBlockStateForLine(
  line: string,
  state: TelegramDraftInlineState,
): boolean {
  const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
  if (state.fence) {
    if (
      new RegExp(
        `^ {0,3}${state.fence.marker}{${state.fence.length},}\\s*$`,
      ).test(line)
    ) {
      state.fence = undefined;
    }
    return true;
  }
  if (state.displayMath) {
    if (line.trim() === "$$") state.displayMath = false;
    return true;
  }
  if (fenceMatch) {
    const markerText = fenceMatch[1] ?? "```";
    state.fence = {
      marker: markerText[0] as "`" | "~",
      length: markerText.length,
    };
    return true;
  }
  if (line.trim() === "$$") {
    state.displayMath = true;
    return true;
  }
  return false;
}

function findSafeTelegramRichMarkdownDraftEnd(markdown: string): number {
  const state = createTelegramDraftInlineState();
  let offset = 0;
  let safeEnd = 0;
  for (const line of markdown.split("\n")) {
    const lineEnd = offset + line.length;
    const consumedAsBlock = updateTelegramDraftBlockStateForLine(line, state);
    if (!consumedAsBlock) updateTelegramDraftInlineStateForLine(line, state);
    const nextOffset = lineEnd + 1;
    if (isTelegramDraftInlineStateClosed(state)) safeEnd = lineEnd;
    offset = nextOffset;
  }
  if (isTelegramDraftInlineStateClosed(state)) return markdown.length;
  return safeEnd;
}

function hasTelegramPreviewVisibleContent(markdown: string): boolean {
  return /[\p{L}\p{N}]/u.test(markdown);
}

export function getSafeTelegramRichMarkdownDraftPrefix(
  markdown: string,
  maxMessageLength: number,
): string | undefined {
  const source = markdown.trim();
  if (!source) return undefined;
  const limited =
    source.length > maxMessageLength
      ? source.slice(0, maxMessageLength)
      : source;
  const safeEnd = findSafeTelegramRichMarkdownDraftEnd(limited);
  if (safeEnd > 0) {
    const safePrefix = limited.slice(0, safeEnd).trimEnd();
    return hasTelegramPreviewVisibleContent(safePrefix)
      ? safePrefix
      : undefined;
  }
  let candidateEnd = limited.length;
  while (candidateEnd > 0) {
    candidateEnd = limited.lastIndexOf(" ", candidateEnd - 1);
    if (candidateEnd <= 0) return undefined;
    const candidate = limited.slice(0, candidateEnd).trimEnd();
    if (
      hasTelegramPreviewVisibleContent(candidate) &&
      findSafeTelegramRichMarkdownDraftEnd(candidate) === candidate.length
    ) {
      return candidate || undefined;
    }
  }
  return undefined;
}

function buildTelegramNativeMarkdownPreviewSnapshot(
  state: TelegramPreviewState,
  maxMessageLength: number,
): TelegramNativeMarkdownPreviewSnapshot | undefined {
  const safeText = getSafeTelegramRichMarkdownDraftPrefix(
    state.pendingText,
    maxMessageLength,
  );
  if (!safeText || safeText === state.lastSentText) return undefined;
  return { text: safeText };
}

async function performTelegramPreviewFlush(
  chatId: number,
  state: TelegramPreviewRuntimeState,
  deps: TelegramPreviewRuntimeDeps,
  options: { target?: TelegramTarget } = {},
): Promise<void> {
  if (deps.canSend && !deps.canSend()) {
    await clearTelegramPreview(chatId, deps, {
      awaitFlush: false,
      target: options.target,
    });
    return;
  }
  const snapshot = buildTelegramNativeMarkdownPreviewSnapshot(
    state,
    deps.maxMessageLength,
  );
  if (!snapshot) return;
  if (
    shouldUseTelegramDraftPreview({
      draftSupport: deps.getDraftSupport(),
      snapshot,
    })
  ) {
    const draftId = state.draftId ?? deps.allocateDraftId();
    state.draftId = draftId;
    state.nextDraftAt = Date.now() + (deps.minDraftIntervalMs ?? 0);
    try {
      const delivered = await deps.sendDraft(
        chatId,
        draftId,
        normalizeTelegramNativeMarkdown(snapshot.text),
        { ...getTelegramTargetThreadParams(options.target ?? { chatId }) },
      );
      if (delivered === false || deps.getState() !== state || deps.canSend?.() === false) return;
      deps.setDraftSupport("supported");
      state.mode = "draft";
      state.lastSentText = snapshot.text;
      return;
    } catch (error) {
      deps.recordRuntimeEvent?.("preview", error, {
        phase: "draft",
        chatId,
        draftId,
      });
      return;
    }
  }
}

export async function flushTelegramPreview(
  chatId: number,
  deps: TelegramPreviewRuntimeDeps,
  options: { target?: TelegramTarget } = {},
): Promise<void> {
  const state = deps.getState();
  if (!state || state.sealed) return;
  if (state.flushPromise) {
    state.flushRequested = true;
    await state.flushPromise;
    return;
  }
  state.flushPromise = (async () => {
    if (state.precedingFlush) {
      await state.precedingFlush.catch(() => {});
      state.precedingFlush = undefined;
      if (deps.getState() !== state || state.sealed) return;
    }
    do {
      state.flushRequested = false;
      const delay = (state.nextDraftAt ?? 0) - Date.now();
      if (delay > 0) {
        if (!state.flushTimer) {
          state.flushTimer = setTimeout(() => {
            state.flushTimer = undefined;
            if (deps.getState() === state && !state.sealed) void flushTelegramPreview(chatId, deps, options);
          }, delay);
          state.flushTimer.unref?.();
        }
        break;
      }
      if (state.flushTimer) clearTimeout(state.flushTimer);
      state.flushTimer = undefined;
      try {
        await performTelegramPreviewFlush(chatId, state, deps, options);
      } catch (error) {
        deps.recordRuntimeEvent?.("preview", error, {
          phase: "flush",
          chatId,
          draftId: state.draftId,
        });
        break;
      }
    } while (deps.getState() === state && !state.sealed && state.flushRequested);
  })();
  try {
    await state.flushPromise;
  } finally {
    if (deps.getState() === state) {
      state.flushPromise = undefined;
    }
  }
}

export async function finalizeTelegramPreview(
  chatId: number,
  deps: TelegramPreviewRuntimeDeps,
  options: { target?: TelegramTarget } = {},
): Promise<boolean> {
  const state = deps.getState();
  if (!state) return false;
  if (deps.canSend && !deps.canSend()) {
    await clearTelegramPreview(chatId, deps, options);
    return false;
  }
  await flushTelegramPreview(chatId, deps, options);
  const finalText = buildTelegramPreviewFinalText(state);
  if (!finalText) {
    await clearTelegramPreview(chatId, deps, options);
    return false;
  }
  deps.setState(undefined);
  return false;
}
