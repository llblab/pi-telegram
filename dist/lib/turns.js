/**
 * Telegram turn-building helpers
 * Zones: telegram inbound, pi agent prompt content, queue
 * Owns prompt-turn summary and content construction so queued Telegram turns are assembled consistently
 */
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { buildTelegramReplyContextBlock, collectTelegramFileInfos, collectTelegramMessageIds, downloadTelegramMessageFiles, extractTelegramForwardContextText, extractTelegramMessagesPromptText, extractTelegramMessagesText, extractTelegramMessageText, formatTelegramHistoryText, guessMediaType, } from "./media.js";
import { createTelegramQueueAdmissionReceipt, truncateTelegramQueueSummary, } from "./queue.js";
import { computeVoicePromptContribution, computeVoiceTurnFlags, getTelegramVoiceReplyMode, } from "./voice.js";
export const TELEGRAM_PREFIX = "[telegram]";
export const TELEGRAM_GUEST_TURN_NOTE = "[guest] delivery: answer quickly with one concise, self-contained reply";
function getTelegramTurnTarget(message) {
    return Number.isInteger(message.message_thread_id)
        ? { chatId: message.chat.id, threadId: message.message_thread_id }
        : { chatId: message.chat.id };
}
function formatTelegramPrefixAttributeValue(value) {
    return value
        .replace(/[\]\n\r|]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
export function createTelegramTurnPrefix(attributes = {}) {
    const parts = [TELEGRAM_PREFIX.slice(1, -1)];
    for (const [key, value] of Object.entries(attributes)) {
        const normalized = value ? formatTelegramPrefixAttributeValue(value) : "";
        if (normalized)
            parts.push(`${key}:${normalized}`);
    }
    return `[${parts.join("|")}]`;
}
export function formatTelegramTurnPrefix(_message, basePrefix = TELEGRAM_PREFIX) {
    return basePrefix;
}
export { truncateTelegramQueueSummary };
export function formatTelegramTurnStatusSummary(rawText, files, handlerOutputs = []) {
    const textSummary = truncateTelegramQueueSummary(rawText);
    if (textSummary)
        return textSummary;
    const handlerSummary = truncateTelegramQueueSummary(handlerOutputs.join(" "));
    if (handlerSummary)
        return handlerSummary;
    if (files.length === 1) {
        const fileName = basename(files[0]?.fileName || files[0]?.path || "attachment");
        return `📎 ${truncateTelegramQueueSummary(fileName, 4, 32) || "attachment"}`;
    }
    if (files.length > 1)
        return `📎 ${files.length} attachments`;
    return "(empty message)";
}
function appendTelegramListSection(text, title, items) {
    if (items.length === 0)
        return text;
    const prefix = text.length > 0 ? `${text}\n\n` : "";
    return `${prefix}[${title}]\n${items.map((item) => `- ${item}`).join("\n")}`;
}
function appendTelegramAttachmentSection(text, files) {
    if (files.length === 0)
        return text;
    const dirs = [...new Set(files.map((file) => dirname(file.path)))];
    const sameDir = dirs.length === 1;
    const header = sameDir ? `[attachments] ${dirs[0]}` : "[attachments]";
    const items = sameDir
        ? files.map((file) => `/${basename(file.path)}`)
        : files.map((file) => file.path);
    const prefix = text.length > 0 ? `${text}\n\n` : "";
    return `${prefix}${header}\n${items.map((item) => `- ${item}`).join("\n")}`;
}
function appendTelegramSourceContext(text, sourceContext) {
    if (!sourceContext)
        return text;
    return text ? `${text}\n\n${sourceContext}` : sourceContext;
}
function buildTelegramForwardContextBlock(options) {
    const metadata = options.context.replace(/:\s+/g, ":");
    const from = metadata.match(/^from:(.+)$/)?.[1];
    let block = `[forward|${metadata}]${options.text ? ` ${options.text}` : ""}`;
    if (options.files.length === 0)
        return block;
    const dirs = [...new Set(options.files.map((file) => dirname(file.path)))];
    const sameDir = dirs.length === 1;
    const header = `[attachments${from ? `|from:${from}` : ""}]${sameDir ? ` ${dirs[0]}` : ""}`;
    const items = sameDir
        ? options.files.map((file) => `/${basename(file.path)}`)
        : options.files.map((file) => file.path);
    block += `\n\n${header}\n${items.map((item) => `- ${item}`).join("\n")}`;
    return block;
}
function appendTelegramPromptText(prompt, rawText) {
    if (!rawText)
        return prompt;
    if (rawText.startsWith("\n"))
        return `${prompt}${rawText}`;
    return `${prompt} ${rawText}`;
}
function appendTelegramVoiceContext(prompt, entries) {
    const prefix = prompt.length > 0 ? `${prompt}\n\n` : "";
    const pairs = Object.entries(entries);
    if (pairs.length === 1) {
        const [key, value] = pairs[0];
        return `${prefix}[voice] ${key}: ${value}`;
    }
    return `${prefix}[voice]\n${pairs
        .map(([key, value]) => `- ${key}: ${value}`)
        .join("\n")}`;
}
// --- Voice Policy And Tagging ---
export function buildTelegramTurnPrompt(options) {
    let prompt = options.telegramPrefix;
    if ((options.historyTurns?.length ?? 0) > 0) {
        prompt +=
            "\n\nEarlier Telegram messages arrived after an aborted turn. Treat them as prior user messages, in order:";
        for (const [index, turn] of (options.historyTurns ?? []).entries()) {
            prompt += `\n\n${index + 1}. ${turn.historyText}`;
        }
        prompt += "\n\nCurrent Telegram message:";
    }
    if (options.rawText.length > 0) {
        prompt =
            (options.historyTurns?.length ?? 0) > 0
                ? `${prompt}\n${options.rawText}`
                : appendTelegramPromptText(prompt, options.rawText);
    }
    const displayFiles = options.displayFiles ?? options.promptFiles ?? options.files;
    prompt = appendTelegramAttachmentSection(prompt, displayFiles);
    prompt = appendTelegramListSection(prompt, "outputs", options.handlerOutputs ?? []);
    prompt = appendTelegramSourceContext(prompt, options.sourceContext);
    if (options.voiceContext) {
        prompt = appendTelegramVoiceContext(prompt, options.voiceContext);
    }
    if (options.timeLine) {
        prompt = `${prompt}\n\n[time] ${options.timeLine}`;
    }
    if (options.guestTurn) {
        prompt = `${prompt}\n\n${TELEGRAM_GUEST_TURN_NOTE}`;
    }
    return prompt;
}
function splitTelegramPromptAttachmentSuffix(prompt) {
    const marker = "\n\n[attachments]";
    const markerIndex = prompt.indexOf(marker);
    if (markerIndex === -1) {
        return {
            promptWithoutAttachments: prompt,
            attachmentSuffix: "",
            attachmentFiles: [],
        };
    }
    const promptWithoutAttachments = prompt.slice(0, markerIndex);
    const attachmentSuffix = prompt.slice(markerIndex);
    const attachmentLines = [];
    let readingAttachments = false;
    let attachmentDir;
    for (const line of attachmentSuffix.split("\n")) {
        const trimmed = line.trim();
        const attachmentMatch = trimmed.match(/^\[attachments\](?:\s+(.+))?$/);
        if (attachmentMatch) {
            readingAttachments = true;
            attachmentDir = attachmentMatch[1]?.trim();
            continue;
        }
        if (readingAttachments && /^\[[^\]]+\](?:\s+.*)?$/.test(trimmed))
            break;
        if (readingAttachments)
            attachmentLines.push(line);
    }
    const attachmentFiles = attachmentLines
        .map((line) => line.match(/^- (.+)$/)?.[1]?.trim())
        .filter((path) => !!path)
        .map((path) => attachmentDir ? join(attachmentDir, path.replace(/^\/+/, "")) : path)
        .map((path) => ({
        path,
        fileName: basename(path),
        isImage: false,
        kind: "document",
    }));
    return { promptWithoutAttachments, attachmentSuffix, attachmentFiles };
}
function buildEditedTelegramPromptText(options) {
    const { promptWithoutAttachments, attachmentSuffix, attachmentFiles } = splitTelegramPromptAttachmentSuffix(options.existingPrompt);
    const currentMessageMarker = "Current Telegram message:";
    const currentMessageIndex = promptWithoutAttachments.lastIndexOf(currentMessageMarker);
    if (currentMessageIndex !== -1) {
        const prefix = promptWithoutAttachments.slice(0, currentMessageIndex + currentMessageMarker.length);
        const separator = options.rawText.length > 0 ? "\n" : "";
        return {
            text: `${prefix}${separator}${options.rawText}${attachmentSuffix}`,
            attachmentFiles,
        };
    }
    return {
        text: `${appendTelegramPromptText(options.telegramPrefix, options.rawText)}${attachmentSuffix}`,
        attachmentFiles,
    };
}
export function updateTelegramPromptTurnText(options) {
    let attachmentFiles = [];
    const nextContent = options.turn.content.map((block, index) => {
        if (index !== 0 || block.type !== "text")
            return block;
        const updated = buildEditedTelegramPromptText({
            existingPrompt: block.text,
            telegramPrefix: options.telegramPrefix,
            rawText: options.rawText,
        });
        attachmentFiles = updated.attachmentFiles;
        return {
            ...block,
            text: updated.text,
        };
    });
    return {
        ...options.turn,
        content: nextContent,
        historyText: formatTelegramHistoryText(options.rawText, attachmentFiles),
        statusSummary: formatTelegramTurnStatusSummary(options.statusText ?? options.rawText, attachmentFiles),
    };
}
export function updateQueuedTelegramPromptTurnText(options) {
    if (options.sourceMessageId === undefined) {
        return { items: options.items, changed: false };
    }
    let changed = false;
    const items = options.items.map((item) => {
        if (item.kind !== "prompt" ||
            !item.sourceMessageIds.includes(options.sourceMessageId)) {
            return item;
        }
        changed = true;
        return updateTelegramPromptTurnText({
            turn: item,
            telegramPrefix: options.telegramPrefix,
            rawText: options.rawText,
            statusText: options.statusText,
        });
    });
    return { items, changed };
}
export function createTelegramQueuedPromptEditRuntime(deps) {
    return {
        updateFromEditedMessage: (message, ctx) => {
            const { changed, items } = updateQueuedTelegramPromptTurnText({
                items: deps.getQueuedItems(),
                sourceMessageId: message.message_id,
                telegramPrefix: TELEGRAM_PREFIX,
                rawText: extractTelegramMessagesPromptText([message]),
                statusText: extractTelegramMessagesText([message]),
            });
            deps.setQueuedItems(items);
            if (changed)
                deps.updateStatus(ctx);
            return changed;
        },
    };
}
export function createTelegramPromptTurnRuntimePreparer(deps) {
    return async (messages, ctx) => {
        const rawText = extractTelegramMessagesText(messages);
        const firstMessage = messages[0];
        if (firstMessage)
            deps.assertExecutionCurrent?.(firstMessage);
        const replyFiles = firstMessage?.reply_to_message
            ? await downloadTelegramMessageFiles([firstMessage.reply_to_message], { downloadFile: deps.downloadFile })
            : [];
        if (firstMessage)
            deps.assertExecutionCurrent?.(firstMessage);
        const processedReply = deps.processAttachments && replyFiles.length > 0
            ? await deps.processAttachments(replyFiles, "", ctx)
            : undefined;
        if (firstMessage)
            deps.assertExecutionCurrent?.(firstMessage);
        const replyContext = firstMessage
            ? buildTelegramReplyContextBlock(firstMessage, processedReply?.promptFiles ?? replyFiles, processedReply?.handlerOutputs)
            : "";
        const forwardEntries = messages.flatMap((message) => {
            const context = extractTelegramForwardContextText(message, deps.getAllowedUserId?.());
            return context
                ? [
                    {
                        context,
                        text: extractTelegramMessageText(message),
                        message,
                        fileNames: new Set(collectTelegramFileInfos([message]).map((file) => file.fileName)),
                    },
                ]
                : [];
        });
        const files = await downloadTelegramMessageFiles(messages, {
            downloadFile: deps.downloadFile,
        });
        if (firstMessage)
            deps.assertExecutionCurrent?.(firstMessage);
        const processed = deps.processAttachments
            ? await deps.processAttachments(files, rawText, ctx)
            : { rawText, promptFiles: files };
        if (firstMessage)
            deps.assertExecutionCurrent?.(firstMessage);
        const sourceBlocks = [];
        let promptRawText = processed.rawText;
        const forwardedFilePaths = new Set();
        const getForwardFiles = (entry) => (processed.promptFiles ?? files).filter((file) => {
            if (!entry.fileNames.has(file.fileName))
                return false;
            forwardedFilePaths.add(file.path);
            return true;
        });
        if (forwardEntries.length === 1 && messages.length === 1) {
            const [forward] = forwardEntries;
            sourceBlocks.push(buildTelegramForwardContextBlock({
                context: forward.context,
                text: processed.rawText,
                files: getForwardFiles(forward),
            }));
            promptRawText = "";
        }
        else if (forwardEntries.length > 0 && processed.rawText === rawText) {
            const forwardedMessages = new Set(forwardEntries.map((entry) => entry.message));
            promptRawText = messages
                .filter((message) => !forwardedMessages.has(message))
                .map(extractTelegramMessageText)
                .filter(Boolean)
                .join("\n\n");
            sourceBlocks.push(...forwardEntries.map((entry) => buildTelegramForwardContextBlock({
                context: entry.context,
                text: entry.text,
                files: getForwardFiles(entry),
            })));
        }
        else if (forwardEntries.length > 0) {
            sourceBlocks.push(...forwardEntries.map((entry) => buildTelegramForwardContextBlock({
                context: entry.context,
                text: "",
                files: getForwardFiles(entry),
            })));
        }
        if (replyContext)
            sourceBlocks.push(replyContext);
        const sourceContext = sourceBlocks.join("\n\n");
        // Compute voice mode once and pass it to both the turn builder and the prompt contribution helper
        const voiceReplyMode = deps.getVoiceReplyMode?.();
        const chatId = messages[0]?.chat.id;
        const timeLine = deps.resolveTimeLine && chatId !== undefined
            ? deps.resolveTimeLine(chatId)
            : null;
        const threadLabel = firstMessage
            ? deps.getTelegramThreadLabel?.(firstMessage)
            : undefined;
        const telegramPrefix = createTelegramTurnPrefix({
            thread: threadLabel,
            "from-thread": firstMessage?.pi_telegram_agent_source_thread,
        });
        const buildTurn = await prepareTelegramPromptTurn({
            telegramPrefix,
            messages,
            readBinaryFile: readFile,
            rawText: promptRawText,
            sourceContext,
            statusText: processed.rawText,
            files,
            promptFiles: processed.promptFiles,
            displayFiles: (processed.promptFiles ?? files).filter((file) => !forwardedFilePaths.has(file.path)),
            handlerOutputs: processed.handlerOutputs,
            timeLine,
            inferImageMimeType: guessMediaType,
            voiceReplyMode,
            voicePromptContribution: computeVoicePromptContribution(voiceReplyMode, files, rawText),
            admissionScope: deps.getAdmissionScope?.(),
            admissionJournalBinding: deps.getAdmissionJournalBinding?.(),
        });
        return (historyTurns) => {
            if (firstMessage)
                deps.assertExecutionCurrent?.(firstMessage);
            return buildTurn(deps.allocateQueueOrder(), historyTurns);
        };
    };
}
function getTelegramVoicePromptContext(voiceReplyMode, hasVoiceFile) {
    if (voiceReplyMode !== "always" &&
        !(voiceReplyMode === "mirror" && hasVoiceFile)) {
        return undefined;
    }
    return { delivery: "automatic voice" };
}
function collectTelegramTurnAdmissionReceipts(messages, historyTurns, admissionScope, admissionJournalBinding) {
    const receipts = new Map();
    const addReceipt = (receipt) => {
        const existing = receipts.get(receipt.receiptId);
        if (existing) {
            if (existing.queueKind !== receipt.queueKind ||
                existing.journalBindingKey !== receipt.journalBindingKey ||
                existing.sourceUpdateIds.length !== receipt.sourceUpdateIds.length ||
                existing.sourceUpdateIds.some((updateId, index) => updateId !== receipt.sourceUpdateIds[index])) {
                throw new Error(`Conflicting Telegram turn receipt: ${receipt.receiptId}`);
            }
            return;
        }
        receipts.set(receipt.receiptId, structuredClone(receipt));
    };
    for (const turn of historyTurns) {
        for (const receipt of turn.admissionReceipts ?? [])
            addReceipt(receipt);
    }
    const sourceUpdateIds = messages.flatMap((message) => typeof message.pi_telegram_source_update_id === "number"
        ? [message.pi_telegram_source_update_id]
        : []);
    if (sourceUpdateIds.length > 0) {
        const currentReceipt = createTelegramQueueAdmissionReceipt({
            queueKind: "prompt",
            scope: admissionScope ?? "",
            sourceUpdateIds,
        });
        if (currentReceipt) {
            addReceipt({
                ...currentReceipt,
                ...(admissionJournalBinding
                    ? { journalBindingKey: admissionJournalBinding }
                    : {}),
            });
        }
    }
    return [...receipts.values()];
}
async function prepareTelegramPromptTurn(options) {
    const images = [];
    for (const file of options.files) {
        if (!file.isImage)
            continue;
        const mediaType = file.mimeType || options.inferImageMimeType(file.path);
        if (!mediaType)
            continue;
        const buffer = await options.readBinaryFile(file.path);
        images.push({
            type: "image",
            data: Buffer.from(buffer).toString("base64"),
            mimeType: mediaType,
        });
    }
    return (queueOrder, historyTurns) => buildPreparedTelegramPromptTurn({ ...options, queueOrder, historyTurns }, images);
}
function buildPreparedTelegramPromptTurn(options, images) {
    const firstMessage = options.messages[0];
    if (!firstMessage) {
        throw new Error("Missing Telegram message for turn creation");
    }
    const hasVoiceFile = options.files.some((f) => f.kind === "voice" || f.kind === "audio");
    const voiceReplyMode = options.voiceReplyMode ?? getTelegramVoiceReplyMode();
    const content = [
        {
            type: "text",
            text: buildTelegramTurnPrompt({
                telegramPrefix: formatTelegramTurnPrefix(firstMessage, options.telegramPrefix),
                rawText: options.rawText,
                files: options.files,
                promptFiles: options.promptFiles,
                displayFiles: options.displayFiles,
                handlerOutputs: options.handlerOutputs,
                sourceContext: options.sourceContext,
                historyTurns: options.historyTurns,
                timeLine: options.timeLine,
                voiceContext: getTelegramVoicePromptContext(voiceReplyMode, hasVoiceFile),
            }),
        },
        ...images,
    ];
    if (options.voicePromptContribution?.trim()) {
        const textItem = content.find((c) => c.type === "text");
        if (textItem) {
            textItem.text = `${textItem.text}\n\n${options.voicePromptContribution.trim()}`;
        }
    }
    const admissionReceipts = collectTelegramTurnAdmissionReceipts(options.messages, options.historyTurns ?? [], options.admissionScope, options.admissionJournalBinding);
    return {
        kind: "prompt",
        chatId: firstMessage.chat.id,
        target: getTelegramTurnTarget(firstMessage),
        replyToMessageId: firstMessage.message_id,
        sourceMessageIds: collectTelegramMessageIds(options.messages),
        queueOrder: options.queueOrder,
        queueLane: "default",
        laneOrder: options.queueOrder,
        queuedAttachments: [],
        content,
        historyText: appendTelegramSourceContext(formatTelegramHistoryText(options.rawText, options.displayFiles ?? options.promptFiles ?? options.files, options.handlerOutputs), options.sourceContext),
        statusSummary: formatTelegramTurnStatusSummary(options.statusText ?? options.rawText, options.displayFiles ?? options.promptFiles ?? options.files, options.handlerOutputs),
        ...(admissionReceipts.length > 0 ? { admissionReceipts } : {}),
        // Voice tagging (used for preview suppression and prompt guidance)
        ...computeVoiceTurnFlags(voiceReplyMode, hasVoiceFile),
    };
}
export async function buildTelegramPromptTurn(options) {
    const buildTurn = await prepareTelegramPromptTurn(options);
    return buildTurn(options.queueOrder, options.historyTurns ?? []);
}
export async function buildTelegramPromptTurnRuntime(options) {
    return buildTelegramPromptTurn({
        ...options,
        readBinaryFile: readFile,
    });
}
