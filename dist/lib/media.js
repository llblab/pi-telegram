/**
 * Telegram media and text extraction helpers
 * Zones: telegram inbound, media groups, filesystem paths
 * Normalizes inbound Telegram messages into reusable file, text, id, history, and media-group metadata
 */
import { basename, dirname } from "node:path";
import * as Machine from "./machine.js";
const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 1200;
const TELEGRAM_REPLY_CONTEXT_MAX_LENGTH = 1000;
const ATTACHMENT_MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;
function attachmentString(value, max) {
    return typeof value === "string" && value.length > 0 && value.length <= max && !!value.trim() && value.isWellFormed() &&
        !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);
}
/** @internal Shared bounded producer metadata; never a receiver, actual-byte or file-use grant. */
export function normalizeTelegramAttachmentRequestConstraints(constraints) {
    const maxBytes = constraints?.maxBytes, accept = constraints?.accept;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 20_971_520 ||
        !Array.isArray(accept) || accept.length < 1 || accept.length > 16)
        throw new TypeError("Invalid attachment preflight constraints.");
    const filters = Array.from({ length: accept.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(accept, String(index));
        const filter = descriptor && "value" in descriptor ? descriptor.value : undefined;
        if (!attachmentString(filter, 128))
            throw new TypeError("Invalid attachment MIME filter.");
        const mime = filter.trim().toLowerCase();
        if (mime !== "*/*" && !ATTACHMENT_MIME.test(mime) &&
            !(mime.endsWith("/*") && ATTACHMENT_MIME.test(`${mime.slice(0, -1)}x`)))
            throw new TypeError("Invalid attachment MIME filter.");
        return mime;
    });
    if (new Set(filters).size !== filters.length)
        throw new TypeError("Duplicate attachment MIME filter.");
    return Object.freeze({ accept: Object.freeze(filters), maxBytes });
}
function guessExtensionFromMime(mimeType, fallback) {
    if (!mimeType)
        return fallback;
    const normalized = mimeType.toLowerCase();
    if (normalized === "image/jpeg")
        return ".jpg";
    if (normalized === "image/png")
        return ".png";
    if (normalized === "image/webp")
        return ".webp";
    if (normalized === "image/gif")
        return ".gif";
    if (normalized === "audio/ogg")
        return ".ogg";
    if (normalized === "audio/mpeg")
        return ".mp3";
    if (normalized === "audio/wav")
        return ".wav";
    if (normalized === "video/mp4")
        return ".mp4";
    if (normalized === "application/pdf")
        return ".pdf";
    return fallback;
}
export function guessMediaType(path) {
    const normalized = path.toLowerCase();
    if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) {
        return "image/jpeg";
    }
    if (normalized.endsWith(".png"))
        return "image/png";
    if (normalized.endsWith(".webp"))
        return "image/webp";
    if (normalized.endsWith(".gif"))
        return "image/gif";
    return undefined;
}
function isImageMimeType(mimeType) {
    return mimeType?.toLowerCase().startsWith("image/") ?? false;
}
function getObjectField(value, field) {
    if (typeof value !== "object" || value === null || !(field in value)) {
        return undefined;
    }
    return Reflect.get(value, field);
}
function joinRichTextParts(parts, separator = "") {
    return parts.filter(Boolean).join(separator).trim();
}
function extractTelegramRichText(value) {
    if (typeof value === "string")
        return value;
    if (Array.isArray(value)) {
        return joinRichTextParts(value.map(extractTelegramRichText));
    }
    if (typeof value !== "object" || value === null)
        return "";
    const text = getObjectField(value, "text");
    if (text !== undefined)
        return extractTelegramRichText(text);
    const expression = getObjectField(value, "expression");
    if (typeof expression === "string")
        return expression;
    const alternativeText = getObjectField(value, "alternative_text");
    if (typeof alternativeText === "string")
        return alternativeText;
    return "";
}
function extractTelegramRichBlockText(block) {
    if (typeof block !== "object" || block === null)
        return "";
    const directText = extractTelegramRichText(getObjectField(block, "text"));
    if (directText)
        return directText;
    const summary = extractTelegramRichText(getObjectField(block, "summary"));
    const nestedBlocks = extractTelegramRichMessageBlocksText(getObjectField(block, "blocks"));
    const items = getObjectField(block, "items");
    const itemText = Array.isArray(items)
        ? items
            .map((item) => {
            const label = getObjectField(item, "label");
            const body = extractTelegramRichMessageBlocksText(getObjectField(item, "blocks"));
            return typeof label === "string" && body ? `${label} ${body}` : body;
        })
            .filter(Boolean)
            .join("\n")
        : "";
    const cells = getObjectField(block, "cells");
    const cellText = Array.isArray(cells)
        ? cells
            .map((row) => Array.isArray(row)
            ? row
                .map((cell) => extractTelegramRichText(getObjectField(cell, "text")))
                .filter(Boolean)
                .join(" | ")
            : "")
            .filter(Boolean)
            .join("\n")
        : "";
    const caption = extractTelegramRichText(getObjectField(block, "caption"));
    return joinRichTextParts([summary, nestedBlocks, itemText, cellText, caption], "\n");
}
function extractTelegramRichMessageBlocksText(blocks) {
    if (!Array.isArray(blocks))
        return "";
    return joinRichTextParts(blocks.map(extractTelegramRichBlockText), "\n\n");
}
function extractTelegramRichMessageText(richMessage) {
    return extractTelegramRichMessageBlocksText(richMessage?.blocks);
}
export function extractTelegramMessageText(message) {
    return (extractTelegramRichMessageText(message.rich_message) ||
        message.text ||
        message.caption ||
        "").trim();
}
function truncateTelegramReplyContextText(text) {
    if (text.length <= TELEGRAM_REPLY_CONTEXT_MAX_LENGTH)
        return text;
    return `${text.slice(0, TELEGRAM_REPLY_CONTEXT_MAX_LENGTH).trimEnd()}…`;
}
function formatTelegramUser(user) {
    if (!user)
        return undefined;
    if (user.username)
        return user.username;
    if (typeof user.id === "number")
        return String(user.id);
    const name = [user.first_name, user.last_name]
        .filter(Boolean)
        .join(" ")
        .trim();
    return name || undefined;
}
function formatTelegramForwardOriginIdentifier(message) {
    const origin = message.forward_origin;
    const user = origin?.sender_user ?? message.forward_from;
    if (user?.username)
        return user.username;
    if (typeof user?.id === "number")
        return String(user.id);
    const chat = origin?.sender_chat ?? origin?.chat;
    if (chat?.username)
        return chat.username;
    if (typeof chat?.id === "number")
        return String(chat.id);
    return origin?.sender_user_name ?? message.forward_sender_name;
}
export function extractTelegramForwardContextText(message, allowedUserId) {
    const originUser = message.forward_origin?.sender_user ?? message.forward_from;
    const isOwnerOrigin = typeof allowedUserId === "number" && originUser?.id === allowedUserId;
    const origin = formatTelegramForwardOriginIdentifier(message);
    if (!origin || isOwnerOrigin)
        return "";
    return `from: ${origin}`;
}
function extractTelegramReplyContextText(message) {
    const quoted = (extractTelegramRichMessageText(message.reply_to_message?.rich_message) ||
        message.reply_to_message?.text ||
        message.reply_to_message?.caption ||
        "").trim();
    return quoted ? truncateTelegramReplyContextText(quoted) : "";
}
export function buildTelegramReplyContextBlock(message, replyFiles = [], replyOutputs = []) {
    const from = formatTelegramUser(message.reply_to_message?.from);
    const header = from ? `[reply|from:${from}]` : "[reply]";
    const text = extractTelegramReplyContextText(message);
    const dirs = [...new Set(replyFiles.map((file) => dirname(file.path)))];
    const sameDir = dirs.length === 1;
    const attachmentHeader = sameDir
        ? `[attachments${from ? `|from:${from}` : ""}] ${dirs[0]}`
        : `[attachments${from ? `|from:${from}` : ""}]`;
    const fileLines = sameDir
        ? replyFiles.map((file) => `- /${basename(file.path)}`)
        : replyFiles.map((file) => `- ${file.path}`);
    const replyBlock = text ? `${header} ${text}` : header;
    const sections = [replyBlock];
    if (fileLines.length > 0) {
        sections.push(`${attachmentHeader}\n${fileLines.join("\n")}`);
    }
    if (replyOutputs.length > 0) {
        const outputHeader = `[outputs${from ? `|from:${from}` : ""}]`;
        sections.push(`${outputHeader}\n${replyOutputs.map((output) => `- ${output}`).join("\n")}`);
    }
    if (text || fileLines.length > 0 || replyOutputs.length > 0) {
        return sections.join("\n\n");
    }
    return "";
}
function appendTelegramReplyContext(text, replyContext) {
    if (!replyContext)
        return text;
    return text ? `${text}\n\n${replyContext}` : `_\n\n${replyContext}`;
}
export function extractTelegramMessagesText(messages) {
    return messages.map(extractTelegramMessageText).filter(Boolean).join("\n\n");
}
export function extractTelegramMessagesPromptText(messages) {
    const text = extractTelegramMessagesText(messages);
    const firstMessage = messages[0];
    if (!firstMessage)
        return text;
    return appendTelegramReplyContext(text, buildTelegramReplyContextBlock(firstMessage));
}
export function extractFirstTelegramMessageText(messages) {
    return messages.map(extractTelegramMessageText).find(Boolean) ?? "";
}
function hasTelegramMessagePromptContent(message) {
    return (!!extractTelegramMessageText(message) ||
        (Array.isArray(message.photo) && message.photo.length > 0) ||
        !!message.document ||
        !!message.video ||
        !!message.audio ||
        !!message.voice ||
        !!message.animation ||
        !!message.sticker);
}
export function hasTelegramMessagesPromptContent(messages) {
    return messages.some(hasTelegramMessagePromptContent);
}
export function collectTelegramMessageIds(messages) {
    return [...new Set(messages.map((message) => message.message_id))];
}
export function getTelegramMediaGroupKey(message) {
    if (!message.media_group_id)
        return undefined;
    const threadKey = typeof message.message_thread_id === "number"
        ? `thread:${message.message_thread_id}`
        : "private";
    return `${message.chat.id}:${threadKey}:${message.media_group_id}`;
}
export function createTelegramPendingGroupsState() {
    return { groups: new Map(), nextTimerId: 0, nextDispatchId: 0 };
}
/**
 * Pure transition for delayed input groups shared by media albums and split text. A group dispatches one batch at a
 * time; messages that arrive meanwhile wait for the next batch, a failure keeps the batch for a retry, and suspension
 * keeps every admitted message for the replacement context.
 */
export function transitionTelegramPendingGroups(state, event, config) {
    const groups = new Map(state.groups);
    const effects = [];
    let { nextTimerId, nextDispatchId } = state;
    let result = 0;
    const cancelTimer = (group) => {
        if (group.timerId === null)
            return group;
        effects.push({ type: "cancelTimer", timerId: group.timerId });
        return { ...group, timerId: null };
    };
    const armTimer = (key, group, delayMs) => {
        if (group.suspended)
            return group;
        nextTimerId += 1;
        effects.push({ type: "armTimer", key, timerId: nextTimerId, delayMs });
        return { ...group, timerId: nextTimerId };
    };
    const startDispatch = (key, group) => {
        if (group.dispatch)
            return group;
        if (config.requireContext && group.context === undefined)
            return group;
        const boundary = group.boundaryId === undefined
            ? -1
            : group.messages.findIndex((message) => message.message_id === group.boundaryId);
        const batch = boundary < 0
            ? [...group.messages]
            : group.messages.slice(0, boundary + 1);
        nextDispatchId += 1;
        effects.push({
            type: "dispatch",
            key,
            dispatchId: nextDispatchId,
            messages: batch,
            ...(group.context === undefined ? {} : { context: group.context }),
        });
        const { boundaryId: _consumed, ...rest } = group;
        return {
            ...rest,
            dispatch: {
                id: nextDispatchId,
                messageIds: batch.map((message) => message.message_id),
            },
        };
    };
    const drop = (key, group) => {
        cancelTimer(group);
        groups.delete(key);
    };
    switch (event.type) {
        case "queued": {
            let group = groups.get(event.key) ?? {
                messages: [],
                timerId: null,
                dispatch: null,
                suspended: false,
            };
            const duplicate = group.messages.findIndex((message) => message.message_id === event.message.message_id);
            group = {
                ...group,
                messages: duplicate < 0
                    ? [...group.messages, event.message]
                    : group.messages.map((message, index) => index === duplicate ? event.message : message),
                context: event.context,
                meta: event.meta,
            };
            const held = group.suspended || group.dispatch !== null || group.timerId !== null;
            if (event.rearm === "always" || !held)
                group = armTimer(event.key, cancelTimer(group), event.delayMs);
            groups.set(event.key, group);
            break;
        }
        case "batchClosed": {
            const group = groups.get(event.key);
            const last = group?.messages.at(-1);
            if (group && last)
                groups.set(event.key, { ...group, boundaryId: last.message_id });
            break;
        }
        case "timerFired": {
            const group = groups.get(event.key);
            if (!group || group.timerId !== event.timerId)
                break;
            groups.set(event.key, startDispatch(event.key, { ...group, timerId: null }));
            break;
        }
        case "dispatchSettled": {
            const group = groups.get(event.key);
            if (!group || group.dispatch?.id !== event.dispatchId)
                break;
            const sent = new Set(group.dispatch.messageIds);
            const remaining = event.ok
                ? group.messages.filter((message) => !sent.has(message.message_id))
                : group.messages;
            if (remaining.length === 0) {
                drop(event.key, group);
                break;
            }
            const settled = { ...group, messages: remaining, dispatch: null };
            groups.set(event.key, settled.timerId === null
                ? armTimer(event.key, settled, config.debounceMs)
                : settled);
            break;
        }
        case "flushRequested": {
            const group = groups.get(event.key);
            if (!group)
                break;
            groups.set(event.key, startDispatch(event.key, cancelTimer(group)));
            break;
        }
        case "suspended":
            for (const [key, group] of groups)
                groups.set(key, { ...cancelTimer(group), suspended: true });
            break;
        case "resumed":
            for (const [key, group] of groups) {
                const resumed = {
                    ...group,
                    context: event.context,
                    suspended: false,
                };
                groups.set(key, resumed.dispatch === null && resumed.timerId === null
                    ? armTimer(key, resumed, config.debounceMs)
                    : resumed);
            }
            break;
        case "removed": {
            const removed = new Set(event.messageIds);
            for (const [key, group] of groups) {
                if (!group.messages.some((message) => removed.has(message.message_id)))
                    continue;
                drop(key, group);
                result += 1;
            }
            break;
        }
        case "keyCleared": {
            const group = groups.get(event.key);
            if (group)
                drop(event.key, group);
            break;
        }
        case "cleared":
            for (const [key, group] of groups)
                drop(key, group);
            break;
    }
    return { state: { groups, nextTimerId, nextDispatchId }, effects, result };
}
/**
 * The shell around `transitionTelegramPendingGroups`: it owns timer handles and each key's latest dispatcher, turns
 * every dispatch outcome, including a synchronous throw, into `dispatchSettled`, and keeps each batch's promise for
 * flush callers.
 */
export function createTelegramPendingGroups(options) {
    const config = {
        debounceMs: options.debounceMs,
        requireContext: options.requireContext,
    };
    const timers = new Map();
    const dispatchers = new Map();
    const batches = new Map();
    const machine = Machine.createTelegramMachineRunner({
        initial: createTelegramPendingGroupsState(),
        transition: (state, event) => transitionTelegramPendingGroups(state, event, config),
        run(effect) {
            switch (effect.type) {
                case "armTimer": {
                    const timer = options.setTimer(() => {
                        timers.delete(effect.timerId);
                        machine.dispatch({
                            type: "timerFired",
                            key: effect.key,
                            timerId: effect.timerId,
                        });
                    }, effect.delayMs);
                    timer.unref?.();
                    timers.set(effect.timerId, timer);
                    return;
                }
                case "cancelTimer": {
                    const timer = timers.get(effect.timerId);
                    timers.delete(effect.timerId);
                    if (timer !== undefined)
                        options.clearTimer(timer);
                    return;
                }
                case "dispatch": {
                    const settle = (ok) => {
                        batches.delete(effect.dispatchId);
                        machine.dispatch({
                            type: "dispatchSettled",
                            key: effect.key,
                            dispatchId: effect.dispatchId,
                            ok,
                        });
                    };
                    let outcome;
                    try {
                        // Synchronous on purpose: a fired timer hands its batch to admission in the same turn.
                        outcome = dispatchers.get(effect.key)?.(effect.messages, effect.context);
                    }
                    catch (error) {
                        outcome = Promise.reject(error);
                    }
                    const batch = Promise.resolve(outcome).then(() => settle(true), (error) => {
                        settle(false);
                        throw error;
                    });
                    batch.catch(() => undefined);
                    batches.set(effect.dispatchId, batch);
                    return;
                }
            }
        },
    });
    const dispatch = (event) => {
        const step = machine.dispatch(event);
        for (const key of dispatchers.keys())
            if (!machine.state.groups.has(key))
                dispatchers.delete(key);
        return step.result;
    };
    const keyOf = (messageId) => {
        for (const [key, group] of machine.state.groups)
            if (group.messages.some((message) => message.message_id === messageId))
                return key;
        return undefined;
    };
    const awaitBatch = async (key) => {
        const id = machine.state.groups.get(key)?.dispatch?.id;
        if (id !== undefined)
            await batches.get(id);
    };
    return {
        get: (key) => machine.state.groups.get(key),
        queue({ dispatchMessages, ...event }) {
            dispatchers.set(event.key, dispatchMessages);
            dispatch({ type: "queued", ...event });
        },
        clearKey: (key) => {
            dispatch({ type: "keyCleared", key });
        },
        closeBatch: (key) => {
            dispatch({ type: "batchClosed", key });
        },
        removeMessages: (messageIds) => dispatch({ type: "removed", messageIds }),
        async flushMessage(messageId) {
            const key = keyOf(messageId);
            if (key === undefined)
                return false;
            dispatch({ type: "flushRequested", key });
            await awaitBatch(key);
            // The batch in flight may have predated this message; send what is left once it settles.
            if (keyOf(messageId) === key &&
                !machine.state.groups.get(key)?.dispatch) {
                dispatch({ type: "flushRequested", key });
                await awaitBatch(key);
            }
            return true;
        },
        suspend: () => {
            dispatch({ type: "suspended" });
        },
        resume: (context) => {
            dispatch({ type: "resumed", context });
        },
        clear: () => {
            dispatch({ type: "cleared" });
        },
    };
}
export function createTelegramMediaGroupController(options = {}) {
    const debounceMs = options.debounceMs ?? TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS;
    const groups = createTelegramPendingGroups({
        debounceMs,
        requireContext: false,
        setTimer: options.setTimer ??
            ((callback, ms) => setTimeout(callback, ms)),
        clearTimer: options.clearTimer ?? clearTimeout,
    });
    return {
        queueMessage: ({ message, context, dispatchMessages }) => {
            const key = getTelegramMediaGroupKey(message);
            if (!key)
                return false;
            groups.queue({
                key,
                message,
                ...(context === undefined ? {} : { context }),
                delayMs: debounceMs,
                rearm: "always",
                dispatchMessages,
            });
            return true;
        },
        removeMessages: groups.removeMessages,
        flushMessage: groups.flushMessage,
        suspend: groups.suspend,
        resume: groups.resume,
        clear: groups.clear,
    };
}
export function createTelegramMediaGroupDispatchRuntime(deps) {
    return {
        handleMessage: async (message, ctx) => {
            const queuedMediaGroup = deps.mediaGroups.queueMessage({
                message,
                context: ctx,
                dispatchMessages: (messages, queuedCtx) => queuedCtx === undefined
                    ? Promise.resolve()
                    : deps.dispatchMessages(messages, queuedCtx),
            });
            if (queuedMediaGroup) {
                deps.onDeferredMessage?.(message);
                return;
            }
            await deps.dispatchMessages([message], ctx);
        },
    };
}
/** Pure `[title]` bullet section appended after a blank line; empty items leave text unchanged. */
export function appendTelegramListSection(text, title, items) {
    if (items.length === 0)
        return text;
    const prefix = text.length > 0 ? `${text}\n\n` : "";
    return `${prefix}[${title}]\n${items.map((item) => `- ${item}`).join("\n")}`;
}
export function appendTelegramAttachmentSection(text, files) {
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
export function formatTelegramHistoryText(rawText, files, handlerOutputs = []) {
    let summary = rawText.length > 0 ? rawText : "(no text)";
    summary = appendTelegramAttachmentSection(summary, files);
    summary = appendTelegramListSection(summary, "outputs", handlerOutputs);
    return summary;
}
export async function downloadTelegramMessageFiles(messages, deps) {
    const downloaded = [];
    for (const file of collectTelegramFileInfos(messages)) {
        downloaded.push({
            path: await deps.downloadFile(file.file_id, file.fileName, file.source),
            fileName: file.fileName,
            isImage: file.isImage,
            mimeType: file.mimeType,
            kind: file.kind,
        });
    }
    return downloaded;
}
function collectTelegramRichBlockFileInfos(blocks, messageId) {
    if (!Array.isArray(blocks))
        return [];
    const files = [];
    let mediaIndex = 0;
    const visit = (entries) => {
        if (!Array.isArray(entries))
            return;
        for (const entry of entries) {
            if (typeof entry !== "object" || entry === null)
                continue;
            const type = getObjectField(entry, "type");
            if (type === "photo" ||
                type === "animation" ||
                type === "audio" ||
                type === "video" ||
                type === "voice_note") {
                mediaIndex += 1;
            }
            if (type === "photo") {
                const photos = getObjectField(entry, "photo");
                if (Array.isArray(photos)) {
                    const photo = photos
                        .filter((value) => typeof value === "object" &&
                        value !== null &&
                        typeof getObjectField(value, "file_id") === "string")
                        .sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0))
                        .at(-1);
                    if (photo) {
                        files.push({
                            file_id: photo.file_id,
                            fileName: `photo-${messageId}-${mediaIndex}.jpg`,
                            index: mediaIndex,
                            mimeType: "image/jpeg",
                            kind: "photo",
                            isImage: true,
                        });
                    }
                }
            }
            const fileField = type === "animation"
                ? "animation"
                : type === "audio"
                    ? "audio"
                    : type === "video"
                        ? "video"
                        : type === "voice_note"
                            ? "voice_note"
                            : undefined;
            if (fileField) {
                const media = getObjectField(entry, fileField);
                const fileId = getObjectField(media, "file_id");
                const mimeType = getObjectField(media, "mime_type");
                const fileName = getObjectField(media, "file_name");
                if (typeof fileId === "string") {
                    const kind = type === "voice_note" ? "voice" : type;
                    const fallbackExtension = kind === "voice" ? ".ogg" : kind === "audio" ? ".mp3" : ".mp4";
                    files.push({
                        file_id: fileId,
                        index: mediaIndex,
                        ...(typeof fileName === "string" ? { userFileName: fileName } : {}),
                        fileName: typeof fileName === "string"
                            ? fileName
                            : `${kind}-${messageId}-${mediaIndex}${guessExtensionFromMime(typeof mimeType === "string" ? mimeType : undefined, fallbackExtension)}`,
                        mimeType: typeof mimeType === "string" ? mimeType : undefined,
                        kind,
                        isImage: false,
                    });
                }
            }
            visit(getObjectField(entry, "blocks"));
            const items = getObjectField(entry, "items");
            if (Array.isArray(items)) {
                for (const item of items)
                    visit(getObjectField(item, "blocks"));
            }
        }
    };
    visit(blocks);
    return files;
}
export function collectTelegramFileInfos(messages) {
    const files = [];
    for (const message of messages) {
        const firstOfMessage = files.length;
        files.push(...collectTelegramRichBlockFileInfos(message.rich_message?.blocks, message.message_id));
        if (Array.isArray(message.photo) && message.photo.length > 0) {
            const photo = [...message.photo]
                .sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0))
                .pop();
            if (photo) {
                files.push({
                    file_id: photo.file_id,
                    fileName: `photo-${message.message_id}.jpg`,
                    mimeType: "image/jpeg",
                    kind: "photo",
                    isImage: true,
                });
            }
        }
        if (message.document) {
            const fileName = message.document.file_name ||
                `document-${message.message_id}${guessExtensionFromMime(message.document.mime_type, "")}`;
            files.push({
                file_id: message.document.file_id,
                fileName,
                ...(message.document.file_name
                    ? { userFileName: message.document.file_name }
                    : {}),
                mimeType: message.document.mime_type,
                kind: "document",
                isImage: isImageMimeType(message.document.mime_type),
            });
        }
        if (message.video) {
            const fileName = message.video.file_name ||
                `video-${message.message_id}${guessExtensionFromMime(message.video.mime_type, ".mp4")}`;
            files.push({
                file_id: message.video.file_id,
                fileName,
                ...(message.video.file_name
                    ? { userFileName: message.video.file_name }
                    : {}),
                mimeType: message.video.mime_type,
                kind: "video",
                isImage: false,
            });
        }
        // Generic audio files (e.g. MP3 uploads) — can also trigger voice replies in "mirror" mode
        if (message.audio) {
            const fileName = message.audio.file_name ||
                `audio-${message.message_id}${guessExtensionFromMime(message.audio.mime_type, ".mp3")}`;
            files.push({
                file_id: message.audio.file_id,
                fileName,
                ...(message.audio.file_name
                    ? { userFileName: message.audio.file_name }
                    : {}),
                mimeType: message.audio.mime_type,
                kind: "audio",
                isImage: false,
            });
        }
        // Voice messages (recorded via microphone) — primary trigger for "mirror" voice reply mode
        if (message.voice) {
            files.push({
                file_id: message.voice.file_id,
                fileName: `voice-${message.message_id}${guessExtensionFromMime(message.voice.mime_type, ".ogg")}`,
                mimeType: message.voice.mime_type,
                kind: "voice",
                isImage: false,
            });
        }
        if (message.animation) {
            const fileName = message.animation.file_name ||
                `animation-${message.message_id}${guessExtensionFromMime(message.animation.mime_type, ".mp4")}`;
            files.push({
                file_id: message.animation.file_id,
                fileName,
                ...(message.animation.file_name
                    ? { userFileName: message.animation.file_name }
                    : {}),
                mimeType: message.animation.mime_type,
                kind: "animation",
                isImage: false,
            });
        }
        if (message.sticker) {
            // Sticker format is defined by Bot API flags, not a documented MIME field.
            const video = message.sticker.is_video === true;
            const animated = message.sticker.is_animated === true;
            const extension = video ? ".webm" : animated ? ".tgs" : ".webp";
            files.push({
                file_id: message.sticker.file_id,
                fileName: `sticker-${message.message_id}${extension}`,
                mimeType: video
                    ? "video/webm"
                    : animated
                        ? "application/x-tgsticker"
                        : "image/webp",
                kind: "sticker",
                isImage: !video && !animated,
            });
        }
        for (const file of files.slice(firstOfMessage)) {
            file.source = {
                kind: file.kind,
                messageId: message.message_id,
                ...(file.index !== undefined ? { index: file.index } : {}),
                ...(file.userFileName ? { userFileName: file.userFileName } : {}),
                ...(message.chat ? { chat: message.chat } : {}),
            };
        }
    }
    const seenFileIds = new Set();
    return files.filter((file) => {
        if (seenFileIds.has(file.file_id))
            return false;
        seenFileIds.add(file.file_id);
        return true;
    });
}
