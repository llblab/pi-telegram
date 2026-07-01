/**
 * Telegram preview streaming helpers
 * Zones: telegram outbound, native rich markdown drafts
 * Owns safe draft preview selection, runtime updates, and preview finalization
 */

import { normalizeTelegramNativeMarkdown } from "./replies.ts";
import { stripTelegramCommentMarkupForPreview } from "./outbound.ts";
import {
  getTelegramTargetThreadParams,
  type TelegramTarget,
} from "./target.ts";
import { shouldSuppressPreviewForVoice } from "./voice.ts";

const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;
const TELEGRAM_DRAFT_PREVIEW_MAX_CHARS = 4096;

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
}

export type TelegramPreviewReplyMarkup = unknown;

export interface TelegramPreviewRuntimeDeps {
  getState: () => TelegramPreviewRuntimeState | undefined;
  setState: (state: TelegramPreviewRuntimeState | undefined) => void;
  maxMessageLength: number;
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
}

export interface TelegramAssistantMessagePreviewStartDeps<
  TMessage,
  TReplyMarkup = TelegramPreviewReplyMarkup,
> {
  getActiveTurn: () => TelegramPreviewActiveTurn | undefined;
  isAssistantMessage: (message: TMessage) => boolean;
  getState: () => TelegramPreviewRuntimeState | undefined;
  setState: (state: TelegramPreviewRuntimeState | undefined) => void;
  createPreviewState: () => TelegramPreviewRuntimeState;
  finalizePreview: (chatId: number) => Promise<boolean>;
  finalizeMarkdownPreview: (
    chatId: number,
    markdown: string,
    replyToMessageId?: number,
    options?: { replyMarkup?: TReplyMarkup; target?: TelegramTarget },
  ) => Promise<boolean>;
}

export interface TelegramAssistantMessagePreviewUpdateDeps<TMessage> {
  getActiveTurn: () => TelegramPreviewActiveTurn | undefined;
  isAssistantMessage: (message: TMessage) => boolean;
  getState: () => TelegramPreviewRuntimeState | undefined;
  setState: (state: TelegramPreviewRuntimeState | undefined) => void;
  createPreviewState: () => TelegramPreviewRuntimeState;
  getMessageText: (message: TMessage) => string;
  schedulePreviewFlush: (
    chatId: number,
    options?: { target?: TelegramTarget },
  ) => void;
}

export type TelegramAssistantMessagePreviewHookDeps<
  TMessage,
  TReplyMarkup = TelegramPreviewReplyMarkup,
> = TelegramAssistantMessagePreviewStartDeps<TMessage, TReplyMarkup> &
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
  getState: () => TelegramPreviewRuntimeState | undefined;
  setState: (state: TelegramPreviewRuntimeState | undefined) => void;
  setPendingText: (text: string) => void;
  createState: () => TelegramPreviewRuntimeState;
  resetState: () => void;
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

export type TelegramAssistantPreviewRuntime<
  TMessage,
  TReplyMarkup = TelegramPreviewReplyMarkup,
> = TelegramPreviewController &
  TelegramAssistantMessagePreviewHooks<TMessage> & {
    finalizeMarkdown: (
      chatId: number,
      markdown: string,
      replyToMessageId?: number,
      options?: { replyMarkup?: TReplyMarkup; target?: TelegramTarget },
    ) => Promise<boolean>;
  };

export function createTelegramNativeMarkdownPreviewFinalizer<
  TReplyMarkup,
>(deps: {
  getState: () => TelegramPreviewRuntimeState | undefined;
  clear: (
    chatId: number,
    options?: { awaitFlush?: boolean; target?: TelegramTarget },
  ) => Promise<void>;
  discard?: () => void;
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
  return async (chatId, markdown, replyToMessageId, options) => {
    const state = deps.getState();
    if (state?.flushPromise) {
      await state.flushPromise.catch(() => {});
    }
    await deps.sendMarkdownReply(chatId, replyToMessageId, markdown, options);
    deps.discard?.();
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
  const finalizeMarkdownPreview = createTelegramNativeMarkdownPreviewFinalizer({
    getState: controller.getState,
    clear: controller.clear,
    discard: () => controller.setState(undefined),
    sendMarkdownReply: deps.sendMarkdownReply,
  });
  return {
    ...controller,
    finalizeMarkdown: finalizeMarkdownPreview,
    ...createTelegramAssistantMessagePreviewHooks({
      getActiveTurn: deps.getActiveTurn,
      isAssistantMessage: deps.isAssistantMessage,
      getState: controller.getState,
      setState: controller.setState,
      createPreviewState: controller.createState,
      finalizePreview: controller.finalize,
      finalizeMarkdownPreview,
      getMessageText: deps.getMessageText,
      schedulePreviewFlush: controller.scheduleFlush,
    }),
  };
}

export function createTelegramPreviewController(
  deps: TelegramPreviewControllerDeps,
): TelegramPreviewController {
  let state: TelegramPreviewRuntimeState | undefined;
  const maxDraftId = deps.maxDraftId ?? TELEGRAM_DRAFT_ID_MAX;
  const maxMessageLength =
    deps.maxMessageLength ?? TELEGRAM_DRAFT_PREVIEW_MAX_CHARS;
  let draftSupport = deps.initialDraftSupport ?? "unknown";
  let nextDraftId = 0;
  const getRuntimeDeps = (): TelegramPreviewRuntimeDeps => ({
    getState: () => state,
    setState: (nextState) => {
      state = nextState;
    },
    maxMessageLength,
    getDraftSupport: () => draftSupport,
    setDraftSupport: (support) => {
      draftSupport = support;
    },
    allocateDraftId: () => {
      nextDraftId = allocateTelegramDraftId(nextDraftId, maxDraftId);
      return nextDraftId;
    },
    sendDraft: deps.sendDraft,
    canSend: deps.canSend,
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
  return {
    getState: () => state,
    setState: (nextState) => {
      state = nextState;
    },
    setPendingText: (text) => {
      if (state) state.pendingText = text;
    },
    createState: () => createTelegramPreviewRuntimeState(),
    resetState: () => {
      state = createTelegramPreviewRuntimeState();
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

export function createTelegramAssistantMessagePreviewHooks<
  TMessage,
  TReplyMarkup = TelegramPreviewReplyMarkup,
>(
  deps: TelegramAssistantMessagePreviewHookDeps<TMessage, TReplyMarkup>,
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

export async function handleTelegramAssistantMessagePreviewStart<
  TMessage,
  TReplyMarkup = TelegramPreviewReplyMarkup,
>(
  message: TMessage,
  deps: TelegramAssistantMessagePreviewStartDeps<TMessage, TReplyMarkup>,
): Promise<void> {
  const turn = deps.getActiveTurn();
  if (!turn || !deps.isAssistantMessage(message)) return;
  if (shouldSuppressPreviewForVoice(turn)) {
    deps.setState(undefined);
    return;
  }
  const state = deps.getState();
  if (
    state &&
    (state.pendingText.trim().length > 0 ||
      state.lastSentText.trim().length > 0)
  ) {
    const previousText = state.pendingText.trim();
    if (previousText.length > 0) {
      await deps.finalizeMarkdownPreview(
        turn.chatId,
        previousText,
        turn.replyToMessageId,
        {
          target: turn.target,
        },
      );
    } else {
      await deps.finalizePreview(turn.chatId);
    }
  }
  deps.setState(deps.createPreviewState());
}

export async function handleTelegramAssistantMessagePreviewUpdate<TMessage>(
  message: TMessage,
  deps: TelegramAssistantMessagePreviewUpdateDeps<TMessage>,
): Promise<void> {
  const turn = deps.getActiveTurn();
  if (!turn || !deps.isAssistantMessage(message)) return;
  if (shouldSuppressPreviewForVoice(turn)) return;
  let state = deps.getState();
  if (!state) {
    state = deps.createPreviewState();
    deps.setState(state);
  }
  state.pendingText = stripTelegramCommentMarkupForPreview(
    deps.getMessageText(message),
  );
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
  options: { awaitFlush?: boolean; target?: TelegramTarget } = {},
): Promise<void> {
  const state = deps.getState();
  if (!state) return;
  if (state.flushPromise && options.awaitFlush !== false) {
    state.flushRequested = false;
    await state.flushPromise.catch(() => {});
    if (deps.getState() !== state) return;
  }
  deps.setState(undefined);
  if (state.mode === "draft" && state.draftId !== undefined) {
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
    try {
      await deps.sendDraft(
        chatId,
        draftId,
        normalizeTelegramNativeMarkdown(snapshot.text),
        { ...getTelegramTargetThreadParams(options.target ?? { chatId }) },
      );
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
  if (!state) return;
  if (state.flushPromise) {
    state.flushRequested = true;
    await state.flushPromise;
    return;
  }
  state.flushPromise = (async () => {
    do {
      state.flushRequested = false;
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
    } while (deps.getState() === state && state.flushRequested);
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
