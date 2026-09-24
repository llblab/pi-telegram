/**
 * Telegram reply delivery helpers
 * Zones: telegram outbound, native rich markdown, UI/compat rendering transport
 * Owns native assistant replies, rendered UI delivery, guest placeholder rotation, reply transport wiring, and plain text replies
 */
import { assertTelegramInlineKeyboardCallbackData } from "./keyboard.js";
import { getTelegramTargetThreadParams, } from "./target.js";
import { isTelegramApiCommitUnknownError } from "./telegram-api.js";
import { renderTelegramMessage, } from "./rendering.js";
export { renderTelegramMessage, };
export function renderTelegramMarkdownToHtmlDraft(markdown) {
    return renderTelegramMessage(markdown, { mode: "markdown" })
        .map((chunk) => chunk.text)
        .join("\n");
}
export const TELEGRAM_RICH_MESSAGE_MAX_CHARS = 32768;
export const TELEGRAM_RICH_MESSAGE_MAX_BLOCKS = 500;
export function createReplyDedupRuntime() {
    const replied = new Map();
    return {
        shouldReply(promptMessageId) {
            if (replied.has(promptMessageId))
                return false;
            replied.set(promptMessageId, true);
            return true;
        },
        reset() {
            replied.clear();
        },
    };
}
// --- Transport-level dedup ---
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
        if (parameters && !isTelegramApiCommitUnknownError(error)
            && generation === replyDedupGeneration
            && lastRepliedToMessageIdByTarget.get(key) === messageId) {
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
    assertTelegramInlineKeyboardCallbackData(options?.replyMarkup);
    let lastMessageId;
    for (const [index, chunk] of chunks.entries()) {
        const sent = await withTelegramReplyParameters(chatId, index === 0 ? options?.replyToMessageId : undefined, options?.target, (replyParameters) => deps.sendMessage({
            chat_id: chatId,
            text: chunk.text,
            parse_mode: chunk.parseMode,
            reply_markup: index === chunks.length - 1 ? options?.replyMarkup : undefined,
            ...(replyParameters ? { reply_parameters: replyParameters } : {}),
            ...(options?.target ? getTelegramTargetThreadParams(options.target) : {}),
        }));
        lastMessageId = sent.message_id;
        deps.recordOwnership?.({
            chatId,
            messageId: sent.message_id,
            target: options?.target,
        });
    }
    return lastMessageId;
}
export async function editTelegramRenderedMessage(chatId, messageId, chunks, deps, options) {
    assertTelegramInlineKeyboardCallbackData(options?.replyMarkup);
    if (chunks.length === 0)
        return messageId;
    const [firstChunk, ...remainingChunks] = chunks;
    deps.recordOwnership?.({ chatId, messageId, target: options?.target });
    await deps.editMessage({
        chat_id: chatId,
        message_id: messageId,
        text: firstChunk.text,
        parse_mode: firstChunk.parseMode,
        reply_markup: remainingChunks.length === 0 ? options?.replyMarkup : undefined,
        ...(options?.target ? getTelegramTargetThreadParams(options.target) : {}),
    });
    if (remainingChunks.length > 0) {
        return sendTelegramRenderedChunks(chatId, remainingChunks, deps, {
            replyMarkup: options?.replyMarkup,
            target: options?.target,
        });
    }
    return messageId;
}
export async function sendTelegramPlainReply(text, deps, options) {
    const chunks = deps.renderTelegramMessage(text, {
        mode: options?.parseMode === "HTML" ? "html" : "plain",
    });
    return deps.sendRenderedChunks(chunks, {
        target: options?.target,
        replyToMessageId: options?.replyToMessageId,
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
function hasClosingDisplayMathDelimiter(lines, startIndex) {
    let fence;
    for (let index = startIndex + 1; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (!fence && line.trim() === "$$")
            return true;
        if (!fence && fenceMatch) {
            const markerText = fenceMatch[1] ?? "```";
            fence = { marker: markerText[0], length: markerText.length };
            continue;
        }
        if (fence &&
            new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`).test(line)) {
            fence = undefined;
        }
    }
    return false;
}
export function normalizeTelegramNativeMarkdown(markdown) {
    const lines = markdown.replace(/\r\n/g, "\n").split("\n");
    let fence;
    let displayMath = false;
    return lines
        .map((line, index) => {
        const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
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
        if (!inFence && fenceMatch) {
            const markerText = fenceMatch[1] ?? "```";
            fence = {
                marker: markerText[0],
                length: markerText.length,
            };
            return line;
        }
        if (inFence &&
            new RegExp(`^ {0,3}${fence?.marker}{${fence?.length},}\\s*$`).test(line)) {
            fence = undefined;
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
        const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (!fence && line.trim().length === 0) {
            flush();
            continue;
        }
        current.push(line);
        if (!fence && fenceMatch) {
            const markerText = fenceMatch[1] ?? "```";
            fence = { marker: markerText[0], length: markerText.length };
            continue;
        }
        if (fence &&
            new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`).test(line)) {
            fence = undefined;
        }
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
        const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (!fence && current.length >= TELEGRAM_RICH_MESSAGE_MAX_BLOCKS) {
            chunks.push(current.join("\n"));
            current = [];
        }
        current.push(line);
        if (!fence && fenceMatch) {
            const markerText = fenceMatch[1] ?? "```";
            fence = { marker: markerText[0], length: markerText.length };
            continue;
        }
        if (fence &&
            new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`).test(line)) {
            fence = undefined;
        }
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
    const openingMatch = opening?.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!openingMatch || !closing || lines.length < 2)
        return undefined;
    const markerText = openingMatch[1] ?? "```";
    const marker = markerText[0];
    if (!new RegExp(`^ {0,3}${marker}{${markerText.length},}\\s*$`).test(closing)) {
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
    assertTelegramInlineKeyboardCallbackData(options?.replyMarkup);
    let lastMessageId;
    const chunks = splitTelegramNativeMarkdown(markdown);
    for (const [index, chunk] of chunks.entries()) {
        const sent = await withTelegramReplyParameters(chatId, index === 0 ? replyToMessageId : undefined, options?.target, (replyParameters) => deps.sendRichMessage({
            chat_id: chatId,
            rich_message: { markdown: chunk },
            reply_markup: index === chunks.length - 1 ? options?.replyMarkup : undefined,
            ...(replyParameters ? { reply_parameters: replyParameters } : {}),
            ...(options?.target ? getTelegramTargetThreadParams(options.target) : {}),
        }));
        lastMessageId = sent.message_id;
        deps.recordOwnership?.({
            chatId,
            messageId: sent.message_id,
            target: options?.target,
        });
    }
    return lastMessageId;
}
export async function sendTelegramNativeRichMessage(chatId, richMessage, deps, options) {
    const sent = await deps.sendRichMessage({
        chat_id: chatId,
        rich_message: richMessage,
        ...(options?.target ? getTelegramTargetThreadParams(options.target) : {}),
    });
    deps.recordOwnership?.({ chatId, messageId: sent.message_id, target: options?.target });
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
                    replyToMessageId: chunkOptions?.replyToMessageId ?? replyToMessageId,
                }),
            }, options);
        },
        sendMarkdownReply: async (chatId, replyToMessageId, markdown, options) => {
            const renderingMode = deps.getAssistantRenderingMode?.() ?? "rich";
            if (renderingMode === "html") {
                return deps.replyTransport.sendRenderedChunks(chatId, deps.renderTelegramMessage(markdown, { mode: "markdown" }), {
                    replyMarkup: options?.replyMarkup,
                    target: options?.target,
                    replyToMessageId,
                });
            }
            return sendTelegramNativeMarkdownReply(chatId, replyToMessageId, markdown, {
                recordOwnership: deps.recordOwnership,
                sendRichMessage: deps.sendRichMessage,
            }, options);
        },
        editInteractiveMessage: async (chatId, messageId, text, mode, replyMarkup) => {
            await deps.replyTransport.editRenderedMessage(chatId, messageId, deps.renderTelegramMessage(text, { mode }), { replyMarkup });
        },
        sendInteractiveMessage: async (chatId, text, mode, replyMarkup, options) => {
            return deps.replyTransport.sendRenderedChunks(chatId, deps.renderTelegramMessage(text, { mode }), {
                replyMarkup,
                target: options?.target,
                replyToMessageId: options?.replyToMessageId,
            });
        },
        sendSectionRichMessage: (chatId, message, options) => sendTelegramNativeRichMessage(chatId, message, {
            recordOwnership: deps.recordOwnership,
            sendRichMessage: deps.sendRichMessage,
        }, options),
    };
}
// --- Dedup-wrapped Reply Wrappers ---
/** Wrap a sendTextReply with reply dedup so only the first message
 *  in a turn carries reply metadata. */
export function dedupSendTextReply(dedup, inner) {
    return async (chatId, replyToMessageId, text, options) => {
        const effectiveReplyTo = dedup.shouldReply(replyToMessageId)
            ? replyToMessageId
            : undefined;
        return inner(chatId, effectiveReplyTo, text, options);
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
    return async (inlineMessageId, markdown) => {
        const [richMarkdown = markdown] = splitTelegramNativeMarkdown(markdown);
        await deps.editGuestInlineMessage(inlineMessageId, {
            richMessage: { markdown: richMarkdown },
        });
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
