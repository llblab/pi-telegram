/**
 * Telegram reply delivery helpers
 * Zones: telegram outbound, native rich markdown, UI/compat rendering transport
 * Owns native assistant replies, rendered UI delivery, guest placeholder rotation, reply transport wiring, and plain text replies
 */
import { assertTelegramInlineKeyboardCallbackData } from "./keyboard.js";
import { renderTelegramMessage, } from "./rendering.js";
import { getTelegramTargetThreadParams, } from "./target.js";
import { assertTelegramApiCallAuthority, captureTelegramUiAuthorityOptions, getTelegramUiAuthorityAssertion, isTelegramApiCommitUnknownError, TelegramApiAuthorityError, } from "./telegram-api.js";
export { renderTelegramMessage, };
export function renderTelegramMarkdownToHtmlDraft(markdown) {
    return renderTelegramMessage(markdown, { mode: "markdown" })
        .map((chunk) => chunk.text)
        .join("\n");
}
export const TELEGRAM_RICH_MESSAGE_MAX_CHARS = 32768;
export const TELEGRAM_RICH_MESSAGE_MAX_BLOCKS = 500;
const lastRepliedToMessageIdByTarget = new Map();
const replyDedupPreservedOnNextReset = new Map();
let replyDedupGeneration = 0;
function getReplyDedupTargetKey(chatId, target) {
    const threadId = target?.threadId;
    return typeof threadId === "number"
        ? `${chatId}:thread:${threadId}`
        : `${chatId}:private`;
}
export function resetTransportReplyDedup() {
    replyDedupGeneration += 1;
    lastRepliedToMessageIdByTarget.clear();
    for (const [key, messageId] of replyDedupPreservedOnNextReset) {
        lastRepliedToMessageIdByTarget.set(key, messageId);
    }
    replyDedupPreservedOnNextReset.clear();
}
/** Keeps a successfully published transition notice as the first reply of the
 * next agent turn. The following agent-start reset consumes this one-shot
 * preservation, so later messages in that turn do not repeat the reply header. */
export function preserveTransportReplyDedupOnNextReset(chatId, messageId, target) {
    const key = getReplyDedupTargetKey(chatId, target);
    if (lastRepliedToMessageIdByTarget.get(key) !== messageId)
        return;
    replyDedupPreservedOnNextReset.set(key, messageId);
}
export function buildTelegramReplyParameters(chatId, messageId, target) {
    if (messageId === undefined || messageId <= 0)
        return undefined;
    const key = getReplyDedupTargetKey(chatId, target);
    if (lastRepliedToMessageIdByTarget.get(key) === messageId) {
        return undefined;
    }
    lastRepliedToMessageIdByTarget.set(key, messageId);
    return {
        message_id: messageId,
        allow_sending_without_reply: true,
    };
}
// Answer publications are caller-serialized. A rejected send releases its anchor;
// an uncertain ACK retains it because Telegram may already have delivered it.
export async function withTelegramReplyParameters(chatId, messageId, target, send) {
    const key = getReplyDedupTargetKey(chatId, target);
    const generation = replyDedupGeneration;
    const previous = lastRepliedToMessageIdByTarget.get(key);
    const parameters = buildTelegramReplyParameters(chatId, messageId, target);
    try {
        return await send(parameters);
    }
    catch (error) {
        if (parameters &&
            !isTelegramApiCommitUnknownError(error) &&
            !(error instanceof TelegramApiAuthorityError && error.requestIssued) &&
            generation === replyDedupGeneration &&
            lastRepliedToMessageIdByTarget.get(key) === messageId) {
            if (previous === undefined)
                lastRepliedToMessageIdByTarget.delete(key);
            else
                lastRepliedToMessageIdByTarget.set(key, previous);
        }
        throw error;
    }
}
function getAgentMessageField(message, field) {
    if (typeof message !== "object" || message === null || !(field in message)) {
        return undefined;
    }
    return Reflect.get(message, field);
}
export function isAssistantAgentMessage(message) {
    return getAgentMessageField(message, "role") === "assistant";
}
function extractAgentTextContent(content) {
    const blocks = Array.isArray(content) ? content : [];
    return blocks
        .filter((block) => typeof block === "object" && block !== null && "type" in block)
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("")
        .trim();
}
export function getAgentMessageText(message) {
    return extractAgentTextContent(getAgentMessageField(message, "content"));
}
export function extractLatestAssistantMessageText(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (!message || !isAssistantAgentMessage(message))
            continue;
        const rawStopReason = getAgentMessageField(message, "stopReason");
        const rawErrorMessage = getAgentMessageField(message, "errorMessage");
        const stopReason = typeof rawStopReason === "string" ? rawStopReason : undefined;
        const errorMessage = typeof rawErrorMessage === "string" ? rawErrorMessage : undefined;
        const text = getAgentMessageText(message);
        return { text: text || undefined, stopReason, errorMessage };
    }
    return {};
}
/**
 * Extract the run's answer without trusting an empty final assistant message.
 * A low-level run may end with a completed assistant message whose content was
 * suppressed (a companion extension preserving an earlier draft, for example
 * State Flow's fallback final:true patch turn). In that case the run's answer
 * is the latest earlier completed assistant message that carries text;
 * tool-use prefaces, errors, and aborts stay excluded.
 */
export function extractRunAssistantMessage(messages) {
    const latest = extractLatestAssistantMessageText(messages);
    if (latest.text || latest.stopReason !== "stop")
        return latest;
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (!message || !isAssistantAgentMessage(message))
            continue;
        const rawStopReason = getAgentMessageField(message, "stopReason");
        if (rawStopReason === "toolUse" ||
            rawStopReason === "error" ||
            rawStopReason === "aborted") {
            continue;
        }
        const text = getAgentMessageText(message);
        if (!text)
            continue;
        const rawErrorMessage = getAgentMessageField(message, "errorMessage");
        return {
            text,
            stopReason: typeof rawStopReason === "string" ? rawStopReason : undefined,
            errorMessage: typeof rawErrorMessage === "string" ? rawErrorMessage : undefined,
            recoveredFromEarlier: true,
        };
    }
    return latest;
}
export function buildTelegramReplyTransport(deps) {
    return {
        sendRenderedChunks: async (chatId, chunks, options) => {
            return sendTelegramRenderedChunks(chatId, chunks, deps, options);
        },
        editRenderedMessage: async (chatId, messageId, chunks, options) => {
            return editTelegramRenderedMessage(chatId, messageId, chunks, deps, options);
        },
    };
}
export async function sendTelegramRenderedChunks(chatId, chunks, deps, options) {
    return sendTelegramChunkSequence(chatId, chunks, options?.replyToMessageId, options, deps.recordOwnership, (chunk, fields, callOptions) => deps.sendMessage({
        chat_id: chatId,
        text: chunk.text,
        parse_mode: chunk.parseMode,
        ...fields,
    }, callOptions));
}
/**
 * Ordered chunk delivery: only the first chunk replies, only the last carries markup, and authority is rechecked
 * before issuance and after every response/ownership publication.
 */
async function sendTelegramChunkSequence(chatId, chunks, replyToMessageId, options, recordOwnership, send) {
    const authorityOptions = captureTelegramUiAuthorityOptions(options);
    const target = options?.target && { ...options.target }, assertAuthority = getTelegramUiAuthorityAssertion(authorityOptions), replyMarkup = options?.replyMarkup;
    assertTelegramInlineKeyboardCallbackData(replyMarkup);
    let lastMessageId;
    for (const [index, chunk] of chunks.entries()) {
        assertTelegramApiCallAuthority(assertAuthority, false);
        const sent = await withTelegramReplyParameters(chatId, index === 0 ? replyToMessageId : undefined, target, async (replyParameters) => {
            const sent = await send(chunk, {
                reply_markup: index === chunks.length - 1 ? replyMarkup : undefined,
                ...(replyParameters ? { reply_parameters: replyParameters } : {}),
                ...(target ? getTelegramTargetThreadParams(target) : {}),
            }, authorityOptions);
            assertTelegramApiCallAuthority(assertAuthority, true);
            return sent;
        });
        assertTelegramApiCallAuthority(assertAuthority, true);
        lastMessageId = sent.message_id;
        recordOwnership?.({ chatId, messageId: sent.message_id, target });
        assertTelegramApiCallAuthority(assertAuthority, true);
    }
    return lastMessageId;
}
export async function editTelegramRenderedMessage(chatId, messageId, chunks, deps, options) {
    options = { ...options, target: options?.target && { ...options.target } };
    const authorityOptions = captureTelegramUiAuthorityOptions(options);
    const assertAuthority = getTelegramUiAuthorityAssertion(authorityOptions);
    assertTelegramApiCallAuthority(assertAuthority, false);
    assertTelegramInlineKeyboardCallbackData(options?.replyMarkup);
    if (chunks.length === 0)
        return messageId;
    const [firstChunk, ...remainingChunks] = chunks;
    if (!assertAuthority)
        deps.recordOwnership?.({ chatId, messageId, target: options.target });
    await deps.editMessage({
        chat_id: chatId,
        message_id: messageId,
        text: firstChunk.text,
        parse_mode: firstChunk.parseMode,
        reply_markup: remainingChunks.length === 0 ? options?.replyMarkup : undefined,
        ...(options?.target ? getTelegramTargetThreadParams(options.target) : {}),
    }, authorityOptions);
    assertTelegramApiCallAuthority(assertAuthority, true);
    if (assertAuthority)
        deps.recordOwnership?.({ chatId, messageId, target: options.target });
    assertTelegramApiCallAuthority(assertAuthority, true);
    if (remainingChunks.length > 0) {
        return sendTelegramRenderedChunks(chatId, remainingChunks, deps, {
            replyMarkup: options?.replyMarkup,
            target: options?.target,
            ...authorityOptions,
        });
    }
    return messageId;
}
/** Edit one fixed assistant message without chunk spill, rendering downgrade or transport fallback. */
export async function editTelegramSingleMarkdownMessage(chatId, messageId, markdown, rendering, replyMarkup, deps, options) {
    const captured = captureTelegramUiAuthorityOptions(options);
    const assertAuthority = getTelegramUiAuthorityAssertion(captured);
    assertTelegramApiCallAuthority(assertAuthority, false);
    assertTelegramInlineKeyboardCallbackData(replyMarkup);
    const chunks = rendering === "rich" ? splitTelegramNativeMarkdown(markdown) :
        renderTelegramMessage(markdown, { mode: "markdown" });
    if (chunks.length !== 1)
        throw new TypeError("Telegram Markdown edit must fit one message.");
    const chunk = chunks[0];
    await deps.editMessage({
        chat_id: chatId, message_id: messageId, reply_markup: replyMarkup,
        ...(typeof chunk === "string" ? { rich_message: { markdown: chunk } } : { text: chunk.text, parse_mode: chunk.parseMode }),
    }, captured);
    assertTelegramApiCallAuthority(assertAuthority, true);
}
export async function sendTelegramPlainReply(text, deps, options) {
    options = { ...options, target: options?.target && { ...options.target } };
    const chunks = deps.renderTelegramMessage(text, {
        mode: options?.parseMode === "HTML" ? "html" : "plain",
    });
    return deps.sendRenderedChunks(chunks, {
        target: options?.target,
        replyToMessageId: options?.replyToMessageId,
        assertAuthority: options.assertAuthority,
    });
}
function normalizeIndentedTelegramNativeMarkdownList(line) {
    return line.replace(/^( +|\t+)([-*+] |\d+\. )/, (_match, indent, marker) => {
        const visibleIndent = indent
            .replace(/ /g, "\u00A0")
            .replace(/\t/g, "\u00A0\u00A0");
        return `${visibleIndent}${marker}`;
    });
}
function normalizeTelegramNativeMarkdownLine(line) {
    let result = normalizeIndentedTelegramNativeMarkdownList(line.replace(/^( {0,3}>)[ \t]/, "$1"));
    const codeSpans = [];
    result = result.replace(/`+[^`]*`+/g, (code) => {
        const token = `\u0000${codeSpans.length}\u0000`;
        codeSpans.push(code);
        return token;
    });
    result = result.replace(/(^|[^\\$])\$([A-Z][A-Z0-9]{1,})(?!\$)(?=\b|[.,;:)/-])/g, (_match, prefix, ticker) => `${prefix}\\$${ticker}`);
    return result.replace(/\u0000(\d+)\u0000/g, (_match, index) => codeSpans[Number(index)] ?? "");
}
export function parseTelegramMarkdownFenceOpening(line) {
    const markerText = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    return markerText
        ? { marker: markerText[0], length: markerText.length }
        : undefined;
}
export function isTelegramMarkdownFenceClosing(line, fence) {
    return new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`).test(line);
}
/** Fence state after one line: outside a fence a marker opens one; inside, a matching marker closes it. */
function advanceTelegramMarkdownFence(fence, line) {
    if (!fence)
        return parseTelegramMarkdownFenceOpening(line);
    return isTelegramMarkdownFenceClosing(line, fence) ? undefined : fence;
}
function hasClosingDisplayMathDelimiter(lines, startIndex) {
    let fence;
    for (let index = startIndex + 1; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (!fence && line.trim() === "$$")
            return true;
        fence = advanceTelegramMarkdownFence(fence, line);
    }
    return false;
}
export function normalizeTelegramNativeMarkdown(markdown) {
    const lines = markdown.replace(/\r\n/g, "\n").split("\n");
    let fence;
    let displayMath = false;
    return lines
        .map((line, index) => {
        const inFence = fence !== undefined;
        if (!inFence && line.trim() === "$$") {
            if (displayMath) {
                displayMath = false;
                return "```";
            }
            if (hasClosingDisplayMathDelimiter(lines, index)) {
                displayMath = true;
                return "```math";
            }
        }
        if (displayMath)
            return line;
        const nextFence = advanceTelegramMarkdownFence(fence, line);
        if (nextFence !== fence) {
            fence = nextFence;
            return line;
        }
        if (!inFence)
            return normalizeTelegramNativeMarkdownLine(line);
        return line;
    })
        .join("\n");
}
export function splitTelegramNativeMarkdown(markdown) {
    const normalizedMarkdown = normalizeTelegramNativeMarkdown(markdown);
    if (normalizedMarkdown.length <= TELEGRAM_RICH_MESSAGE_MAX_CHARS &&
        countTelegramNativeMarkdownBlocks(normalizedMarkdown) <=
            TELEGRAM_RICH_MESSAGE_MAX_BLOCKS) {
        return [normalizedMarkdown];
    }
    const chunks = [];
    let current = "";
    let currentBlockCount = 0;
    for (const rawBlock of splitTelegramNativeMarkdownBlocks(normalizedMarkdown)) {
        for (const block of splitTelegramNativeMarkdownCountedBlocks(rawBlock)) {
            const blockCount = countTelegramNativeMarkdownBlocks(block);
            const candidate = current ? `${current}\n\n${block}` : block;
            const exceedsChars = candidate.length > TELEGRAM_RICH_MESSAGE_MAX_CHARS;
            const exceedsBlocks = currentBlockCount + blockCount > TELEGRAM_RICH_MESSAGE_MAX_BLOCKS;
            if (!exceedsChars && !exceedsBlocks) {
                current = candidate;
                currentBlockCount += blockCount;
                continue;
            }
            if (current)
                chunks.push(current.trimEnd());
            if (block.length <= TELEGRAM_RICH_MESSAGE_MAX_CHARS &&
                blockCount <= TELEGRAM_RICH_MESSAGE_MAX_BLOCKS) {
                current = block;
                currentBlockCount = blockCount;
                continue;
            }
            chunks.push(...splitTelegramNativeMarkdownLongBlock(block));
            current = "";
            currentBlockCount = 0;
        }
    }
    if (current)
        chunks.push(current.trimEnd());
    return chunks;
}
function splitTelegramNativeMarkdownBlocks(markdown) {
    const blocks = [];
    const current = [];
    let fence;
    const flush = () => {
        if (current.length === 0)
            return;
        blocks.push(current.join("\n"));
        current.length = 0;
    };
    for (const line of markdown.split("\n")) {
        if (!fence && line.trim().length === 0) {
            flush();
            continue;
        }
        current.push(line);
        fence = advanceTelegramMarkdownFence(fence, line);
    }
    flush();
    return blocks;
}
function splitTelegramNativeMarkdownCountedBlocks(block) {
    if (countTelegramNativeMarkdownBlocks(block) <= TELEGRAM_RICH_MESSAGE_MAX_BLOCKS) {
        return [block];
    }
    const chunks = [];
    let current = [];
    let fence;
    for (const line of block.split("\n")) {
        if (!fence && current.length >= TELEGRAM_RICH_MESSAGE_MAX_BLOCKS) {
            chunks.push(current.join("\n"));
            current = [];
        }
        current.push(line);
        fence = advanceTelegramMarkdownFence(fence, line);
    }
    if (current.length > 0)
        chunks.push(current.join("\n"));
    return chunks;
}
function countTelegramNativeMarkdownBlocks(block) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(block))
        return 1;
    const lines = block.split("\n").filter((line) => line.trim().length > 0);
    if (lines.some((line) => /^\s*([-*+] |\d+\. |>|\||<tg-button-row>)/.test(line))) {
        return Math.max(1, lines.length);
    }
    return 1;
}
function splitTelegramNativeMarkdownLongBlock(block) {
    return (splitTelegramNativeMarkdownLongFenceBlock(block) ??
        splitTelegramNativeMarkdownLongWrappedInlineBlock(block) ??
        splitTelegramNativeMarkdownLongPlainBlock(block));
}
function splitTelegramNativeMarkdownLongPlainBlock(block) {
    const chunks = [];
    let remaining = block;
    while (remaining.length > TELEGRAM_RICH_MESSAGE_MAX_CHARS) {
        const window = remaining.slice(0, TELEGRAM_RICH_MESSAGE_MAX_CHARS + 1);
        const splitIndex = findTelegramNativeMarkdownSplitIndex(window);
        chunks.push(remaining.slice(0, splitIndex).trimEnd());
        remaining = remaining.slice(splitIndex).trimStart();
    }
    if (remaining.length > 0)
        chunks.push(remaining);
    return chunks;
}
function splitTelegramNativeMarkdownLongFenceBlock(block) {
    const lines = block.split("\n");
    const opening = lines[0] ?? "";
    const closing = lines[lines.length - 1] ?? "";
    const openingFence = parseTelegramMarkdownFenceOpening(opening);
    if (!openingFence || !closing || lines.length < 2)
        return undefined;
    if (!isTelegramMarkdownFenceClosing(closing, openingFence)) {
        return undefined;
    }
    const maxContentLength = TELEGRAM_RICH_MESSAGE_MAX_CHARS - opening.length - closing.length - 2;
    if (maxContentLength <= 0)
        return undefined;
    const content = lines.slice(1, -1).join("\n");
    return splitTelegramNativeMarkdownWrappedContent(content, maxContentLength, (chunk) => `${opening}\n${chunk}${chunk.endsWith("\n") ? "" : "\n"}${closing}`);
}
function splitTelegramNativeMarkdownLongWrappedInlineBlock(block) {
    const delimiter = ["**", "__", "~~", "`", "*", "_"].find((candidate) => block.startsWith(candidate) &&
        block.endsWith(candidate) &&
        block.length > candidate.length * 2);
    if (!delimiter)
        return undefined;
    const maxContentLength = TELEGRAM_RICH_MESSAGE_MAX_CHARS - delimiter.length * 2;
    if (maxContentLength <= 0)
        return undefined;
    return splitTelegramNativeMarkdownWrappedContent(block.slice(delimiter.length, -delimiter.length), maxContentLength, (chunk) => `${delimiter}${chunk}${delimiter}`);
}
function splitTelegramNativeMarkdownWrappedContent(content, maxContentLength, wrap) {
    const chunks = [];
    let remaining = content;
    while (remaining.length > maxContentLength) {
        const window = remaining.slice(0, maxContentLength + 1);
        const splitIndex = findTelegramNativeMarkdownSplitIndex(window, maxContentLength);
        chunks.push(wrap(remaining.slice(0, splitIndex)));
        remaining = remaining.slice(splitIndex);
    }
    if (remaining.length > 0)
        chunks.push(wrap(remaining));
    return chunks;
}
function findTelegramNativeMarkdownSplitIndex(text, hardLimit = TELEGRAM_RICH_MESSAGE_MAX_CHARS) {
    const paragraphIndex = text.lastIndexOf("\n\n", hardLimit);
    if (paragraphIndex > 0)
        return paragraphIndex + 2;
    const lineIndex = text.lastIndexOf("\n", hardLimit);
    if (lineIndex > 0)
        return lineIndex + 1;
    const spaceIndex = text.lastIndexOf(" ", hardLimit);
    if (spaceIndex > 0)
        return spaceIndex + 1;
    return hardLimit;
}
export async function sendTelegramNativeMarkdownReply(chatId, replyToMessageId, markdown, deps, options) {
    return sendTelegramChunkSequence(chatId, splitTelegramNativeMarkdown(markdown), replyToMessageId, options, deps.recordOwnership, (chunk, fields, callOptions) => deps.sendRichMessage({ chat_id: chatId, rich_message: { markdown: chunk }, ...fields }, callOptions));
}
async function sendTelegramNativeRichMessage(chatId, richMessage, deps, options) {
    options = { ...options, target: options?.target && { ...options.target } };
    const assertAuthority = options.assertAuthority;
    assertTelegramApiCallAuthority(assertAuthority, false);
    const sent = await deps.sendRichMessage({
        chat_id: chatId,
        rich_message: richMessage,
        ...(options?.target ? getTelegramTargetThreadParams(options.target) : {}),
    }, assertAuthority ? { assertAuthority } : undefined);
    assertTelegramApiCallAuthority(assertAuthority, true);
    deps.recordOwnership?.({
        chatId,
        messageId: sent.message_id,
        target: options?.target,
    });
    assertTelegramApiCallAuthority(assertAuthority, true);
    return sent.message_id;
}
export function createTelegramRenderedMessageDeliveryRuntime(deps) {
    const replyTransport = buildTelegramReplyTransport({
        recordOwnership: deps.recordOwnership,
        sendMessage: deps.sendMessage,
        editMessage: deps.editMessage,
    });
    return {
        replyTransport,
        ...createTelegramRenderedMessageRuntime({
            renderTelegramMessage: deps.renderTelegramMessage ?? renderTelegramMessage,
            replyTransport,
            recordOwnership: deps.recordOwnership,
            getAssistantRenderingMode: deps.getAssistantRenderingMode,
            sendRichMessage: deps.sendRichMessage,
        }),
    };
}
export function createTelegramRenderedMessageRuntime(deps) {
    return {
        sendTextReply: async (chatId, replyToMessageId, text, options) => {
            return sendTelegramPlainReply(text, {
                renderTelegramMessage: deps.renderTelegramMessage,
                sendRenderedChunks: (chunks, chunkOptions) => deps.replyTransport.sendRenderedChunks(chatId, chunks, {
                    target: chunkOptions?.target,
                    assertAuthority: chunkOptions?.assertAuthority,
                    replyToMessageId: chunkOptions?.replyToMessageId ?? replyToMessageId,
                }),
            }, options);
        },
        sendMarkdownReply: async (chatId, replyToMessageId, markdown, options) => {
            options = {
                ...options,
                target: options?.target && { ...options.target },
            };
            const renderingMode = deps.getAssistantRenderingMode?.() ?? "rich";
            if (renderingMode === "html") {
                return deps.replyTransport.sendRenderedChunks(chatId, deps.renderTelegramMessage(markdown, { mode: "markdown" }), {
                    replyMarkup: options?.replyMarkup,
                    target: options?.target,
                    replyToMessageId,
                    assertAuthority: options.assertAuthority,
                });
            }
            return sendTelegramNativeMarkdownReply(chatId, replyToMessageId, markdown, {
                recordOwnership: deps.recordOwnership,
                sendRichMessage: deps.sendRichMessage,
            }, options);
        },
        editInteractiveMessage: async (chatId, messageId, text, mode, replyMarkup, options) => {
            options = {
                ...options,
                target: options?.target && { ...options.target },
            };
            await deps.replyTransport.editRenderedMessage(chatId, messageId, deps.renderTelegramMessage(text, { mode }), { ...options, replyMarkup });
        },
        sendInteractiveMessage: async (chatId, text, mode, replyMarkup, options) => {
            options = {
                ...options,
                target: options?.target && { ...options.target },
            };
            return deps.replyTransport.sendRenderedChunks(chatId, deps.renderTelegramMessage(text, { mode }), {
                replyMarkup,
                target: options?.target,
                replyToMessageId: options?.replyToMessageId,
                ...captureTelegramUiAuthorityOptions(options),
            });
        },
        sendSectionRichMessage: (chatId, message, options) => sendTelegramNativeRichMessage(chatId, message, {
            recordOwnership: deps.recordOwnership,
            sendRichMessage: deps.sendRichMessage,
        }, options),
    };
}
/**
 * Guest reply sender: answers guest queries with native Rich Markdown content.
 * Guest queries use InlineQueryResult input_message_content rather than chat
 * sendRichMessage, so this stays as a dedicated guest transport adapter.
 */
export function createGuestMarkdownReplySender(deps) {
    return async (guestQueryId, markdown) => {
        const [richMarkdown = markdown] = splitTelegramNativeMarkdown(markdown);
        await deps.answerGuestQuery(guestQueryId, undefined, {
            richMessage: { markdown: richMarkdown },
        });
    };
}
/**
 * Guest reply editor: replaces the early Guest Mode placeholder ACK with
 * native Rich Markdown content addressed by `inline_message_id` instead of a
 * chat/message pair.
 */
export function createGuestMarkdownReplyEditor(deps) {
    return async (inlineMessageId, markdown, options) => {
        const [richMarkdown = markdown] = splitTelegramNativeMarkdown(markdown);
        await deps.editGuestInlineMessage(inlineMessageId, {
            richMessage: { markdown: richMarkdown },
        }, options);
    };
}
/**
 * Guest Mode placeholder rotation: the early ACK is the first placeholder
 * frame and the runtime steps the remaining frames once per interval, moving
 * the globe every second while the trailing dots grow once every two seconds.
 *
 * Rotation completes whole six-frame cycles and only stops once at least
 * `TELEGRAM_GUEST_PLACEHOLDER_MIN_MS` has elapsed, so a pending answer holds
 * the finished cycle's last frame (`🌏 Working on it...`) instead of whatever
 * step a hard time cap happens to cut. The `TELEGRAM_GUEST_PLACEHOLDER_MAX_MS`
 * safety bound keeps the edit stream clear of the first flood-control
 * rejections measured in live guest runs (+26.5 s at ~53 edits, +27.8 s at
 * ~28 edits): rotation caps at 23 edits and never starts a frame after 26 s.
 */
export const TELEGRAM_GUEST_PLACEHOLDER_FRAME_MS = 1_000;
export const TELEGRAM_GUEST_PLACEHOLDER_MIN_MS = 20_000;
export const TELEGRAM_GUEST_PLACEHOLDER_MAX_MS = 26_000;
export const TELEGRAM_GUEST_PLACEHOLDER_FRAMES = [
    "<b>🌎 Working on it.</b>",
    "<b>🌍 Working on it.</b>",
    "<b>🌏 Working on it..</b>",
    "<b>🌎 Working on it..</b>",
    "<b>🌍 Working on it...</b>",
    "<b>🌏 Working on it...</b>",
];
// Telegram does not expose deletion for inline messages. This non-printing,
// non-empty edit visually clears a guest placeholder after its query is skipped.
export const TELEGRAM_DISMISSED_GUEST_PLACEHOLDER_TEXT = "\u2063";
export function buildTelegramGuestPlaceholderFrame(step) {
    const frames = TELEGRAM_GUEST_PLACEHOLDER_FRAMES;
    const index = ((step % frames.length) + frames.length) % frames.length;
    return frames[index];
}
function getTelegramGuestPlaceholderRetryDelayMs(error, fallbackMs) {
    const retryAfterSeconds = error?.retryAfterSeconds;
    return typeof retryAfterSeconds === "number" && retryAfterSeconds > 0
        ? Math.max(fallbackMs, retryAfterSeconds * 1_000)
        : fallbackMs;
}
export function createTelegramGuestPlaceholderRuntime(deps) {
    const intervalMs = deps.intervalMs ?? TELEGRAM_GUEST_PLACEHOLDER_FRAME_MS;
    const minMs = deps.minMs ?? TELEGRAM_GUEST_PLACEHOLDER_MIN_MS;
    const maxMs = deps.maxMs ?? TELEGRAM_GUEST_PLACEHOLDER_MAX_MS;
    const now = deps.now ?? Date.now;
    const setTimer = deps.setTimer ??
        ((callback, ms) => setTimeout(callback, ms));
    const clearTimer = deps.clearTimer ??
        ((timer) => clearTimeout(timer));
    const sessions = new Map();
    const finishRotation = (session, elapsedMs) => {
        if (session.finished)
            return;
        session.finished = true;
        deps.recordRuntimeEvent?.("guest", "Guest placeholder rotation reached its bound", {
            phase: "guest-placeholder-capped",
            minMs,
            maxMs,
            elapsedMs,
            step: session.step,
        });
    };
    const scheduleFrame = (inlineMessageId, session, delayMs) => {
        if (session.stopped)
            return;
        const elapsedMs = now() - session.startedAtMs;
        const frameCount = TELEGRAM_GUEST_PLACEHOLDER_FRAMES.length;
        const cycleComplete = session.step > 0 && session.step % frameCount === frameCount - 1;
        if (cycleComplete && elapsedMs >= minMs) {
            finishRotation(session, elapsedMs);
            return;
        }
        if (elapsedMs + delayMs > maxMs) {
            finishRotation(session, elapsedMs);
            return;
        }
        const timer = setTimer(() => {
            session.timer = undefined;
            runFrame(inlineMessageId, session);
        }, delayMs);
        timer.unref?.();
        session.timer = timer;
    };
    const runFrame = (inlineMessageId, session) => {
        if (session.stopped)
            return;
        session.step += 1;
        let nextDelayMs = intervalMs;
        session.inflight = (async () => {
            try {
                await deps.editGuestInlineMessage(inlineMessageId, {
                    text: buildTelegramGuestPlaceholderFrame(session.step),
                    parseMode: "HTML",
                });
            }
            catch (error) {
                nextDelayMs = getTelegramGuestPlaceholderRetryDelayMs(error, intervalMs);
                deps.recordRuntimeEvent?.("guest", error, {
                    phase: "guest-placeholder-edit",
                    retryAfterMs: nextDelayMs,
                });
            }
            finally {
                session.inflight = undefined;
                scheduleFrame(inlineMessageId, session, nextDelayMs);
            }
        })();
    };
    const stop = async (inlineMessageId) => {
        const session = sessions.get(inlineMessageId);
        if (!session)
            return;
        sessions.delete(inlineMessageId);
        session.stopped = true;
        if (session.timer !== undefined) {
            clearTimer(session.timer);
            session.timer = undefined;
        }
        try {
            await session.inflight;
        }
        catch {
            // Frame failures are reported as runtime events; stopping stays fail-open.
        }
    };
    return {
        start(inlineMessageId) {
            const existing = sessions.get(inlineMessageId);
            if (existing) {
                existing.stopped = true;
                if (existing.timer !== undefined)
                    clearTimer(existing.timer);
            }
            const session = {
                step: 0,
                stopped: false,
                startedAtMs: now(),
                finished: false,
            };
            sessions.set(inlineMessageId, session);
            scheduleFrame(inlineMessageId, session, intervalMs);
        },
        stop,
        stopAll() {
            for (const session of sessions.values()) {
                session.stopped = true;
                if (session.timer !== undefined)
                    clearTimer(session.timer);
            }
            sessions.clear();
        },
        async dismiss(inlineMessageId) {
            await stop(inlineMessageId);
            try {
                await deps.editGuestInlineMessage(inlineMessageId, {
                    text: TELEGRAM_DISMISSED_GUEST_PLACEHOLDER_TEXT,
                    parseMode: "HTML",
                });
            }
            catch (error) {
                deps.recordRuntimeEvent?.("guest", error, {
                    phase: "guest-placeholder-dismiss",
                });
            }
        },
    };
}
