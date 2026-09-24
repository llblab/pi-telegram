/**
 * Telegram preview streaming helpers
 * Zones: telegram outbound, native rich markdown drafts
 * Owns safe draft preview selection, runtime updates, and preview finalization
 */
import { normalizeTelegramNativeMarkdown } from "./replies.js";
import { stripTelegramCommentMarkupForPreview } from "./outbound-markup.js";
import { getTelegramTargetThreadParams, } from "./target.js";
import { shouldSuppressPreviewForVoice } from "./voice.js";
const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;
const TELEGRAM_DRAFT_PREVIEW_MAX_CHARS = 4096;
// Native draft cadence: at most one frame per interval, and a fresh preview
// segment holds its first frame for one full interval so the opening frame is
// an accumulated passage rather than a single streamed word.
const TELEGRAM_DRAFT_INTERVAL_MS = 2_000;
export function createTelegramPreviewControllerRuntime(deps) {
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
function sealTelegramPreviewState(state) {
    if (!state)
        return;
    state.sealed = true;
    state.flushRequested = false;
    if (state.flushTimer)
        clearTimeout(state.flushTimer);
    state.flushTimer = undefined;
}
export function createTelegramNativeMarkdownPreviewFinalizer(deps) {
    return (...args) => prepareTelegramNativeMarkdownPreviewFinalizer(deps)(...args);
}
function prepareTelegramNativeMarkdownPreviewFinalizer(deps) {
    const state = deps.getState();
    sealTelegramPreviewState(state);
    const inFlight = state?.flushPromise ?? state?.precedingFlush;
    return async (chatId, markdown, replyToMessageId, options) => {
        if (deps.isDeliveryActive?.() === false)
            return false;
        await inFlight?.catch(() => { });
        if (deps.getState() !== state || deps.isDeliveryActive?.() === false)
            return false;
        await deps.sendMarkdownReply(chatId, replyToMessageId, markdown, options);
        if (deps.getState() === state && deps.isDeliveryActive?.() !== false)
            deps.discard?.();
        return true;
    };
}
export function createTelegramAssistantPreviewRuntime(deps) {
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
                    if (controller.getState() === state && isDeliveryActive())
                        controller.setPendingText(text);
                },
                clearPreview: async (chatId, options) => {
                    if (controller.getState() !== state || !isDeliveryActive())
                        return;
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
export function createTelegramPreviewController(deps) {
    let state;
    let generation = 0;
    const maxDraftId = deps.maxDraftId ?? TELEGRAM_DRAFT_ID_MAX;
    const maxMessageLength = deps.maxMessageLength ?? TELEGRAM_DRAFT_PREVIEW_MAX_CHARS;
    let draftSupport = deps.initialDraftSupport ?? "unknown";
    let nextDraftId = 0;
    const setState = (nextState) => {
        if (state !== nextState)
            sealTelegramPreviewState(state);
        state = nextState;
    };
    const getRuntimeDeps = (operationGeneration = generation) => ({
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
        canSend: () => operationGeneration === generation && (deps.canSend?.() ?? true),
        recordRuntimeEvent: deps.recordRuntimeEvent,
    });
    return {
        getState: () => state,
        setState,
        setPendingText: (text) => {
            if (state)
                state.pendingText = text;
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
            if (!state)
                return undefined;
            sealTelegramPreviewState(state);
            const prior = state.publicationPromise ?? state.flushPromise ?? state.precedingFlush;
            let settle;
            state.publicationPromise = new Promise((resolve) => { settle = resolve; });
            return { wait: async () => { await prior?.catch(() => { }); }, settle };
        },
        prepareClear: (chatId, options) => {
            const admittedState = state;
            const runtime = getRuntimeDeps();
            return async () => {
                if (state !== admittedState)
                    return;
                await clearTelegramPreview(chatId, runtime, {
                    ...options,
                    isDeliveryActive: () => runtime.canSend?.() !== false && options?.isDeliveryActive?.() !== false,
                });
            };
        },
        clear: (chatId, options) => clearTelegramPreview(chatId, getRuntimeDeps(), options),
        flush: (chatId, options) => flushTelegramPreview(chatId, getRuntimeDeps(), options),
        scheduleFlush: (chatId, options) => {
            if (!state)
                return;
            void flushTelegramPreview(chatId, getRuntimeDeps(), options);
        },
        finalize: (chatId, _replyToMessageId, options) => finalizeTelegramPreview(chatId, getRuntimeDeps(), options),
    };
}
export function createTelegramAssistantMessagePreviewHooks(deps) {
    return {
        onMessageStart: async (event) => {
            await handleTelegramAssistantMessagePreviewStart(event.message, deps);
        },
        onMessageUpdate: async (event) => {
            await handleTelegramAssistantMessagePreviewUpdate(event.message, deps);
        },
    };
}
/**
 * Returns true when the active turn is a Telegram Guest Mode query. A guest
 * query allows exactly one answer within a limited Telegram response window,
 * so it must never emit streaming draft previews.
 */
export function shouldSuppressPreviewForGuestTurn(turn) {
    return !!turn?.guestQueryId;
}
export async function handleTelegramAssistantMessagePreviewStart(message, deps) {
    const turn = deps.getActiveTurn();
    if (!turn || !deps.isAssistantMessage(message))
        return;
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
export async function handleTelegramAssistantMessagePreviewUpdate(message, deps) {
    const turn = deps.getActiveTurn();
    if (!turn || !deps.isAssistantMessage(message))
        return;
    if (deps.canSend && !deps.canSend()) {
        deps.setState(undefined);
        return;
    }
    if (shouldSuppressPreviewForVoice(turn))
        return;
    if (shouldSuppressPreviewForGuestTurn(turn))
        return;
    let state = deps.getState();
    if (!state) {
        state = deps.createPreviewState();
        deps.setState(state);
    }
    if (state.sealed)
        return;
    const hadVisibleText = state.pendingText.length > 0;
    state.pendingText = stripTelegramCommentMarkupForPreview(deps.getMessageText(message));
    // The first visible text of a preview segment opens an initial accumulation
    // window, so the segment's first frame cannot ship as a single word even
    // when the previous cadence boundary has already passed (fresh turn, slow
    // first token, or message rollover after tool work). Later deltas keep the
    // trailing deadline instead of sliding it on every update.
    const interval = deps.minDraftIntervalMs ?? 0;
    if (interval > 0 &&
        !hadVisibleText &&
        !state.lastSentText &&
        state.pendingText.length > 0) {
        state.nextDraftAt = Math.max(state.nextDraftAt ?? 0, Date.now() + interval);
    }
    deps.schedulePreviewFlush(turn.chatId, { target: turn.target });
}
export function buildTelegramPreviewFinalText(state) {
    const finalText = state.pendingText.trim();
    if (finalText)
        return finalText;
    return state.lastSentText.trim() || undefined;
}
export function createTelegramPreviewRuntimeState() {
    return {
        mode: "draft",
        pendingText: "",
        lastSentText: "",
    };
}
export function allocateTelegramDraftId(currentDraftId, maxDraftId) {
    return currentDraftId >= maxDraftId ? 1 : currentDraftId + 1;
}
export function shouldUseTelegramDraftPreview(_options) {
    return true;
}
export async function clearTelegramPreview(chatId, deps, options = {}) {
    const state = deps.getState();
    if (!state || options.isDeliveryActive?.() === false)
        return;
    sealTelegramPreviewState(state);
    const inFlight = state.flushPromise ?? state.precedingFlush;
    if (inFlight && options.awaitFlush !== false) {
        state.flushRequested = false;
        await inFlight.catch(() => { });
        if (deps.getState() !== state)
            return;
    }
    if (options.isDeliveryActive?.() === false)
        return;
    deps.setState(undefined);
    if (state.mode === "draft" && state.draftId !== undefined && deps.canSend?.() !== false) {
        try {
            await deps.sendDraft(chatId, state.draftId, undefined, {
                ...getTelegramTargetThreadParams(options.target ?? { chatId }),
            });
        }
        catch (error) {
            deps.recordRuntimeEvent?.("preview", error, {
                phase: "clear-draft",
                chatId,
                draftId: state.draftId,
            });
        }
    }
}
function createTelegramDraftInlineState() {
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
function isTelegramDraftInlineStateClosed(state) {
    return (state.codeTicks === 0 &&
        !state.htmlComment &&
        !state.displayMath &&
        !state.fence &&
        !state.strongAsterisk &&
        !state.emphasisAsterisk &&
        !state.strongUnderscore &&
        !state.emphasisUnderscore &&
        !state.strike &&
        !state.linkText &&
        !state.linkDestination);
}
function countRepeatedChars(text, index, char) {
    let count = 0;
    while (text[index + count] === char)
        count += 1;
    return count;
}
function isEscapedMarkdownChar(text, index) {
    let slashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
        slashCount += 1;
    }
    return slashCount % 2 === 1;
}
function isInlineDelimiterCandidate(text, index, length) {
    const previous = text[index - 1] ?? "";
    const next = text[index + length] ?? "";
    if (!next || /\s/.test(next))
        return previous.length > 0 && !/\s/.test(previous);
    if (!previous || /\s/.test(previous))
        return true;
    return /[\p{P}\p{S}]/u.test(previous) || /[\p{P}\p{S}]/u.test(next);
}
function updateTelegramDraftInlineStateForLine(line, state) {
    if (state.fence || state.displayMath)
        return;
    for (let index = 0; index < line.length; index += 1) {
        if (state.htmlComment) {
            const closeIndex = line.indexOf("-->", index);
            if (closeIndex === -1)
                return;
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
        if (isEscapedMarkdownChar(line, index))
            continue;
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
        if (line.startsWith("~~", index) &&
            isInlineDelimiterCandidate(line, index, 2)) {
            state.strike = !state.strike;
            index += 1;
            continue;
        }
        if (line.startsWith("**", index) &&
            isInlineDelimiterCandidate(line, index, 2)) {
            state.strongAsterisk = !state.strongAsterisk;
            index += 1;
            continue;
        }
        if (line[index] === "*" && isInlineDelimiterCandidate(line, index, 1)) {
            state.emphasisAsterisk = !state.emphasisAsterisk;
            continue;
        }
        if (line.startsWith("__", index) &&
            isInlineDelimiterCandidate(line, index, 2)) {
            state.strongUnderscore = !state.strongUnderscore;
            index += 1;
            continue;
        }
        if (line[index] === "_" && isInlineDelimiterCandidate(line, index, 1)) {
            state.emphasisUnderscore = !state.emphasisUnderscore;
        }
    }
}
function updateTelegramDraftBlockStateForLine(line, state) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (state.fence) {
        if (new RegExp(`^ {0,3}${state.fence.marker}{${state.fence.length},}\\s*$`).test(line)) {
            state.fence = undefined;
        }
        return true;
    }
    if (state.displayMath) {
        if (line.trim() === "$$")
            state.displayMath = false;
        return true;
    }
    if (fenceMatch) {
        const markerText = fenceMatch[1] ?? "```";
        state.fence = {
            marker: markerText[0],
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
function findSafeTelegramRichMarkdownDraftEnd(markdown) {
    const state = createTelegramDraftInlineState();
    let offset = 0;
    let safeEnd = 0;
    for (const line of markdown.split("\n")) {
        const lineEnd = offset + line.length;
        const consumedAsBlock = updateTelegramDraftBlockStateForLine(line, state);
        if (!consumedAsBlock)
            updateTelegramDraftInlineStateForLine(line, state);
        const nextOffset = lineEnd + 1;
        if (isTelegramDraftInlineStateClosed(state))
            safeEnd = lineEnd;
        offset = nextOffset;
    }
    if (isTelegramDraftInlineStateClosed(state))
        return markdown.length;
    return safeEnd;
}
function hasTelegramPreviewVisibleContent(markdown) {
    return /[\p{L}\p{N}]/u.test(markdown);
}
export function getSafeTelegramRichMarkdownDraftPrefix(markdown, maxMessageLength) {
    const source = markdown.trim();
    if (!source)
        return undefined;
    const limited = source.length > maxMessageLength
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
        if (candidateEnd <= 0)
            return undefined;
        const candidate = limited.slice(0, candidateEnd).trimEnd();
        if (hasTelegramPreviewVisibleContent(candidate) &&
            findSafeTelegramRichMarkdownDraftEnd(candidate) === candidate.length) {
            return candidate || undefined;
        }
    }
    return undefined;
}
function buildTelegramNativeMarkdownPreviewSnapshot(state, maxMessageLength) {
    const safeText = getSafeTelegramRichMarkdownDraftPrefix(state.pendingText, maxMessageLength);
    if (!safeText || safeText === state.lastSentText)
        return undefined;
    return { text: safeText };
}
async function performTelegramPreviewFlush(chatId, state, deps, options = {}) {
    if (deps.canSend && !deps.canSend()) {
        await clearTelegramPreview(chatId, deps, {
            awaitFlush: false,
            target: options.target,
        });
        return;
    }
    const snapshot = buildTelegramNativeMarkdownPreviewSnapshot(state, deps.maxMessageLength);
    if (!snapshot)
        return;
    if (shouldUseTelegramDraftPreview({
        draftSupport: deps.getDraftSupport(),
        snapshot,
    })) {
        const draftId = state.draftId ?? deps.allocateDraftId();
        state.draftId = draftId;
        state.nextDraftAt = Date.now() + (deps.minDraftIntervalMs ?? 0);
        try {
            const delivered = await deps.sendDraft(chatId, draftId, normalizeTelegramNativeMarkdown(snapshot.text), { ...getTelegramTargetThreadParams(options.target ?? { chatId }) });
            if (delivered === false || deps.getState() !== state || deps.canSend?.() === false)
                return;
            deps.setDraftSupport("supported");
            state.mode = "draft";
            state.lastSentText = snapshot.text;
            return;
        }
        catch (error) {
            deps.recordRuntimeEvent?.("preview", error, {
                phase: "draft",
                chatId,
                draftId,
            });
            return;
        }
    }
}
export async function flushTelegramPreview(chatId, deps, options = {}) {
    const state = deps.getState();
    if (!state || state.sealed)
        return;
    if (state.flushPromise) {
        state.flushRequested = true;
        await state.flushPromise;
        return;
    }
    state.flushPromise = (async () => {
        if (state.precedingFlush) {
            await state.precedingFlush.catch(() => { });
            state.precedingFlush = undefined;
            if (deps.getState() !== state || state.sealed)
                return;
        }
        do {
            state.flushRequested = false;
            const delay = (state.nextDraftAt ?? 0) - Date.now();
            if (delay > 0) {
                if (!state.flushTimer) {
                    state.flushTimer = setTimeout(() => {
                        state.flushTimer = undefined;
                        if (deps.getState() === state && !state.sealed)
                            void flushTelegramPreview(chatId, deps, options);
                    }, delay);
                    state.flushTimer.unref?.();
                }
                break;
            }
            if (state.flushTimer)
                clearTimeout(state.flushTimer);
            state.flushTimer = undefined;
            try {
                await performTelegramPreviewFlush(chatId, state, deps, options);
            }
            catch (error) {
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
    }
    finally {
        if (deps.getState() === state) {
            state.flushPromise = undefined;
        }
    }
}
export async function finalizeTelegramPreview(chatId, deps, options = {}) {
    const state = deps.getState();
    if (!state)
        return false;
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
