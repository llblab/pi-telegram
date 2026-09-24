/**
 * Telegram bus-aware API runtime
 * Zones: multi-instance bus, telegram api transport, live instance routing
 * Wraps the direct Telegram Bot API runtime so follower instances can route outbound calls through the bus leader
 */
import { markTelegramBusCrossTargetDelivery, stripTelegramBusApiMetadata, } from "./bus.js";
import { buildTelegramAnswerGuestQueryBody, isTelegramMessageNotModifiedError, } from "./telegram-api.js";
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function asBoolean(value) {
    return Boolean(value);
}
function asSentMessage(value) {
    return asRecord(value);
}
function withDefaultThreadTarget(body, target) {
    if (target?.threadId === undefined)
        return body;
    if (body.message_thread_id !== undefined)
        return body;
    return body.chat_id === target.chatId
        ? { ...body, message_thread_id: target.threadId }
        : body;
}
function markFollowerCrossTargetDelivery(body, defaultTarget) {
    if (!defaultTarget || body.chat_id !== defaultTarget.chatId)
        return body;
    const threadId = body.message_thread_id;
    const isDifferentTarget = threadId === undefined
        ? defaultTarget.threadId !== undefined
        : threadId !== defaultTarget.threadId;
    return isDifferentTarget ? markTelegramBusCrossTargetDelivery(body) : body;
}
function rejectTelegramDirectOwnership(method) {
    return Promise.reject(new Error(`Telegram ${method} requires direct transport ownership.`));
}
export function createTelegramBusAwareApiRuntime(deps) {
    return {
        call(method, body, options) {
            return deps.ownsDirect()
                ? deps.directRuntime.call(method, body, options)
                : deps.callFollowerApi("call", [
                    method,
                    body,
                    options,
                ]);
        },
        callMultipart(method, fields, fileField, filePath, fileName, options) {
            return deps.ownsDirect()
                ? deps.directRuntime.callMultipart(method, fields, fileField, filePath, fileName, options)
                : deps.callFollowerApi("callMultipart", [
                    method,
                    fields,
                    fileField,
                    filePath,
                    fileName,
                    options,
                ]);
        },
        downloadFile(fileId, suggestedName) {
            return deps.ownsDirect()
                ? deps.directRuntime.downloadFile(fileId, suggestedName)
                : deps.callFollowerApi("downloadFile", [
                    fileId,
                    suggestedName,
                ]);
        },
        deleteWebhook(signal) {
            return deps.ownsDirect()
                ? deps.directRuntime.deleteWebhook(signal)
                : rejectTelegramDirectOwnership("deleteWebhook");
        },
        getUpdates(body, signal) {
            return deps.ownsDirect()
                ? deps.directRuntime.getUpdates(body, signal)
                : rejectTelegramDirectOwnership("getUpdates");
        },
        setMyCommands(commands) {
            return deps.ownsDirect()
                ? deps.directRuntime.setMyCommands(commands)
                : deps
                    .callFollowerApi("call", ["setMyCommands", { commands }])
                    .then(asBoolean);
        },
        sendChatAction(chatId, action, options) {
            const body = withDefaultThreadTarget({
                chat_id: chatId,
                action,
                ...(options?.message_thread_id !== undefined
                    ? { message_thread_id: options.message_thread_id }
                    : {}),
            }, deps.getDefaultTarget?.());
            return deps.ownsDirect()
                ? deps.directRuntime.sendChatAction(chatId, action, options)
                : deps
                    .callFollowerApi("call", ["sendChatAction", body])
                    .then(asBoolean);
        },
        sendTypingAction(chatId, options) {
            const body = withDefaultThreadTarget({
                chat_id: chatId,
                action: "typing",
                ...(options?.message_thread_id !== undefined
                    ? { message_thread_id: options.message_thread_id }
                    : {}),
            }, deps.getDefaultTarget?.());
            return deps.ownsDirect()
                ? deps.directRuntime.sendTypingAction(chatId, options)
                : deps
                    .callFollowerApi("call", ["sendChatAction", body])
                    .then(asBoolean);
        },
        sendRecordVoiceAction(chatId, options) {
            const body = withDefaultThreadTarget({
                chat_id: chatId,
                action: "record_voice",
                ...(options?.message_thread_id !== undefined
                    ? { message_thread_id: options.message_thread_id }
                    : {}),
            }, deps.getDefaultTarget?.());
            return deps.ownsDirect()
                ? deps.directRuntime.sendRecordVoiceAction(chatId, options)
                : deps
                    .callFollowerApi("call", ["sendChatAction", body])
                    .then(asBoolean);
        },
        sendMessageDraft(chatId, draftId, text, options) {
            const body = {
                chat_id: chatId,
                draft_id: draftId,
            };
            if (text !== undefined)
                body.text = text;
            if (options?.parse_mode !== undefined)
                body.parse_mode = options.parse_mode;
            if (options?.entities !== undefined)
                body.entities = options.entities;
            if (options?.message_thread_id !== undefined) {
                body.message_thread_id = options.message_thread_id;
            }
            const scopedBody = withDefaultThreadTarget(body, deps.getDefaultTarget?.());
            return deps.ownsDirect()
                ? deps.directRuntime.sendMessageDraft(chatId, draftId, text, options)
                : deps
                    .callFollowerApi("call", ["sendMessageDraft", scopedBody])
                    .then(asBoolean);
        },
        sendMessage(body) {
            return deps.ownsDirect()
                ? deps.directRuntime.sendMessage(stripTelegramBusApiMetadata(body))
                : deps
                    .callFollowerApi("call", [
                    "sendMessage",
                    markFollowerCrossTargetDelivery(body, deps.getDefaultTarget?.()),
                ])
                    .then(asSentMessage);
        },
        sendRichMessage(body) {
            return deps.ownsDirect()
                ? deps.directRuntime.sendRichMessage(stripTelegramBusApiMetadata(body))
                : deps
                    .callFollowerApi("call", [
                    "sendRichMessage",
                    markFollowerCrossTargetDelivery(body, deps.getDefaultTarget?.()),
                ])
                    .then(asSentMessage);
        },
        sendRichMessageDraft(body) {
            return deps.ownsDirect()
                ? deps.directRuntime.sendRichMessageDraft(body)
                : deps
                    .callFollowerApi("call", ["sendRichMessageDraft", body])
                    .then(asBoolean);
        },
        async editMessageText(body) {
            if (deps.ownsDirect())
                return deps.directRuntime.editMessageText(body);
            try {
                await deps.callFollowerApi("call", ["editMessageText", body]);
                return "edited";
            }
            catch (error) {
                if (isTelegramMessageNotModifiedError(error))
                    return "unchanged";
                throw error;
            }
        },
        async editMessageReplyMarkup(chatId, messageId, replyMarkup) {
            if (deps.ownsDirect()) {
                await deps.directRuntime.editMessageReplyMarkup(chatId, messageId, replyMarkup);
                return;
            }
            await deps.callFollowerApi("call", [
                "editMessageReplyMarkup",
                { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup },
            ]);
        },
        async answerCallbackQuery(callbackQueryId, text) {
            if (deps.ownsDirect()) {
                await deps.directRuntime.answerCallbackQuery(callbackQueryId, text);
                return;
            }
            await deps.callFollowerApi("call", [
                "answerCallbackQuery",
                {
                    callback_query_id: callbackQueryId,
                    ...(text !== undefined ? { text } : {}),
                },
            ]);
        },
        async answerGuestQuery(guestQueryId, text, options) {
            if (deps.ownsDirect()) {
                await deps.directRuntime.answerGuestQuery(guestQueryId, text, options);
                return;
            }
            await deps.callFollowerApi("call", [
                "answerGuestQuery",
                buildTelegramAnswerGuestQueryBody(guestQueryId, text, options),
            ]);
        },
        answerGuestQueryForInlineMessage(guestQueryId, text, options) {
            // Guest answers can only be edited while this instance owns direct
            // transport; follower forwarding cannot preserve the inline message id.
            return deps.ownsDirect()
                ? deps.directRuntime.answerGuestQueryForInlineMessage(guestQueryId, text, options)
                : rejectTelegramDirectOwnership("answerGuestQueryForInlineMessage");
        },
        editGuestInlineMessage(inlineMessageId, content) {
            return deps.ownsDirect()
                ? deps.directRuntime.editGuestInlineMessage(inlineMessageId, content)
                : rejectTelegramDirectOwnership("editGuestInlineMessage");
        },
        async deleteMessage(chatId, messageId) {
            if (deps.ownsDirect())
                return deps.directRuntime.deleteMessage(chatId, messageId);
            await deps.callFollowerApi("call", [
                "deleteMessage",
                {
                    chat_id: chatId,
                    message_id: messageId,
                },
            ]);
        },
        prepareTempDir() {
            return deps.directRuntime.prepareTempDir();
        },
    };
}
