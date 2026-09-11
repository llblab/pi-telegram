/**
 * Telegram bus-aware API runtime
 * Zones: multi-instance bus, telegram api transport, live instance routing
 * Wraps the direct Telegram Bot API runtime so follower instances can route outbound calls through the bus leader
 */

import {
  markTelegramBusCrossTargetDelivery,
  stripTelegramBusApiMetadata,
} from "./bus.ts";
import {
  buildTelegramAnswerGuestQueryBody,
  isTelegramMessageNotModifiedError,
} from "./telegram-api.ts";
import type {
  TelegramAnswerGuestQueryOptions,
  TelegramApiCallOptions,
  TelegramBridgeApiRuntime,
  TelegramEditGuestInlineMessageContent,
  TelegramEditMessageTextBody,
  TelegramSendMessageBody,
  TelegramSendMessageDraftBody,
  TelegramSendRichMessageBody,
  TelegramSendRichMessageDraftBody,
  TelegramSentMessage,
  TelegramUpdate,
} from "./telegram-api.ts";

export type TelegramBusApiCall = (
  method: string,
  args: unknown[],
) => Promise<unknown>;

export interface TelegramBusAwareApiRuntimeDeps {
  directRuntime: TelegramBridgeApiRuntime;
  ownsDirect: () => boolean;
  callFollowerApi: TelegramBusApiCall;
  getDefaultTarget?: () => { chatId: number; threadId?: number } | undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asBoolean(value: unknown): boolean {
  return Boolean(value);
}

function asSentMessage(value: unknown): TelegramSentMessage {
  return asRecord(value) as unknown as TelegramSentMessage;
}

function withDefaultThreadTarget(
  body: Record<string, unknown>,
  target: { chatId: number; threadId?: number } | undefined,
): Record<string, unknown> {
  if (target?.threadId === undefined) return body;
  if (body.message_thread_id !== undefined) return body;
  return body.chat_id === target.chatId
    ? { ...body, message_thread_id: target.threadId }
    : body;
}

function markFollowerCrossTargetDelivery<T extends Record<string, unknown>>(
  body: T,
  defaultTarget: { chatId: number; threadId?: number } | undefined,
): T {
  if (!defaultTarget || body.chat_id !== defaultTarget.chatId) return body;
  const threadId = body.message_thread_id;
  const isDifferentTarget =
    threadId === undefined
      ? defaultTarget.threadId !== undefined
      : threadId !== defaultTarget.threadId;
  return isDifferentTarget ? markTelegramBusCrossTargetDelivery(body) : body;
}

function rejectTelegramDirectOwnership(method: string): Promise<never> {
  return Promise.reject(
    new Error(`Telegram ${method} requires direct transport ownership.`),
  );
}

export function createTelegramAggregateTypingActionSender(
  runtime: Pick<TelegramBridgeApiRuntime, "call">,
): (chatId: number) => Promise<unknown> {
  return (chatId) =>
    runtime.call("sendChatAction", { chat_id: chatId, action: "typing" });
}

export function createTelegramBusAwareApiRuntime(
  deps: TelegramBusAwareApiRuntimeDeps,
): TelegramBridgeApiRuntime {
  return {
    call<TResponse>(
      method: string,
      body: Record<string, unknown>,
      options?: TelegramApiCallOptions,
    ): Promise<TResponse> {
      return deps.ownsDirect()
        ? deps.directRuntime.call<TResponse>(method, body, options)
        : (deps.callFollowerApi("call", [
            method,
            body,
            options,
          ]) as Promise<TResponse>);
    },
    callMultipart<TResponse>(
      method: string,
      fields: Record<string, string>,
      fileField: string,
      filePath: string,
      fileName: string,
      options?: TelegramApiCallOptions,
    ): Promise<TResponse> {
      return deps.ownsDirect()
        ? deps.directRuntime.callMultipart<TResponse>(
            method,
            fields,
            fileField,
            filePath,
            fileName,
            options,
          )
        : (deps.callFollowerApi("callMultipart", [
            method,
            fields,
            fileField,
            filePath,
            fileName,
            options,
          ]) as Promise<TResponse>);
    },
    downloadFile(fileId: string, suggestedName: string): Promise<string> {
      return deps.ownsDirect()
        ? deps.directRuntime.downloadFile(fileId, suggestedName)
        : (deps.callFollowerApi("downloadFile", [
            fileId,
            suggestedName,
          ]) as Promise<string>);
    },
    deleteWebhook(signal?: AbortSignal): Promise<boolean> {
      return deps.ownsDirect()
        ? deps.directRuntime.deleteWebhook(signal)
        : rejectTelegramDirectOwnership("deleteWebhook");
    },
    getUpdates(
      body: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<TelegramUpdate[]> {
      return deps.ownsDirect()
        ? deps.directRuntime.getUpdates(body, signal)
        : rejectTelegramDirectOwnership("getUpdates");
    },
    setMyCommands(commands): Promise<boolean> {
      return deps.ownsDirect()
        ? deps.directRuntime.setMyCommands(commands)
        : deps
            .callFollowerApi("call", ["setMyCommands", { commands }])
            .then(asBoolean);
    },
    sendChatAction(
      chatId: number,
      action: string,
      options?: { message_thread_id?: number },
    ): Promise<boolean> {
      const body = withDefaultThreadTarget(
        {
          chat_id: chatId,
          action,
          ...(options?.message_thread_id !== undefined
            ? { message_thread_id: options.message_thread_id }
            : {}),
        },
        deps.getDefaultTarget?.(),
      );
      return deps.ownsDirect()
        ? deps.directRuntime.sendChatAction(chatId, action, options)
        : deps
            .callFollowerApi("call", ["sendChatAction", body])
            .then(asBoolean);
    },
    sendTypingAction(
      chatId: number,
      options?: { message_thread_id?: number },
    ): Promise<unknown> {
      const body = withDefaultThreadTarget(
        {
          chat_id: chatId,
          action: "typing",
          ...(options?.message_thread_id !== undefined
            ? { message_thread_id: options.message_thread_id }
            : {}),
        },
        deps.getDefaultTarget?.(),
      );
      return deps.ownsDirect()
        ? deps.directRuntime.sendTypingAction(chatId, options)
        : deps
            .callFollowerApi("call", ["sendChatAction", body])
            .then(asBoolean);
    },
    sendRecordVoiceAction(
      chatId: number,
      options?: { message_thread_id?: number },
    ): Promise<unknown> {
      const body = withDefaultThreadTarget(
        {
          chat_id: chatId,
          action: "record_voice",
          ...(options?.message_thread_id !== undefined
            ? { message_thread_id: options.message_thread_id }
            : {}),
        },
        deps.getDefaultTarget?.(),
      );
      return deps.ownsDirect()
        ? deps.directRuntime.sendRecordVoiceAction(chatId, options)
        : deps
            .callFollowerApi("call", ["sendChatAction", body])
            .then(asBoolean);
    },
    sendMessageDraft(
      chatId: number,
      draftId: number,
      text?: string,
      options?: TelegramSendMessageDraftBody extends Record<string, unknown>
        ? {
            parse_mode?: string;
            entities?: unknown[];
            message_thread_id?: number;
          }
        : never,
    ): Promise<boolean> {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        draft_id: draftId,
      };
      if (text !== undefined) body.text = text;
      if (options?.parse_mode !== undefined)
        body.parse_mode = options.parse_mode;
      if (options?.entities !== undefined) body.entities = options.entities;
      if (options?.message_thread_id !== undefined) {
        body.message_thread_id = options.message_thread_id;
      }
      const scopedBody = withDefaultThreadTarget(
        body,
        deps.getDefaultTarget?.(),
      );
      return deps.ownsDirect()
        ? deps.directRuntime.sendMessageDraft(chatId, draftId, text, options)
        : deps
            .callFollowerApi("call", ["sendMessageDraft", scopedBody])
            .then(asBoolean);
    },
    sendMessage(body: TelegramSendMessageBody): Promise<TelegramSentMessage> {
      return deps.ownsDirect()
        ? deps.directRuntime.sendMessage(stripTelegramBusApiMetadata(body))
        : deps
            .callFollowerApi("call", [
              "sendMessage",
              markFollowerCrossTargetDelivery(
                body,
                deps.getDefaultTarget?.(),
              ),
            ])
            .then(asSentMessage);
    },
    sendRichMessage(
      body: TelegramSendRichMessageBody,
    ): Promise<TelegramSentMessage> {
      return deps.ownsDirect()
        ? deps.directRuntime.sendRichMessage(stripTelegramBusApiMetadata(body))
        : deps
            .callFollowerApi("call", [
              "sendRichMessage",
              markFollowerCrossTargetDelivery(
                body,
                deps.getDefaultTarget?.(),
              ),
            ])
            .then(asSentMessage);
    },
    sendRichMessageDraft(
      body: TelegramSendRichMessageDraftBody,
    ): Promise<boolean> {
      return deps.ownsDirect()
        ? deps.directRuntime.sendRichMessageDraft(body)
        : deps
            .callFollowerApi("call", ["sendRichMessageDraft", body])
            .then(asBoolean);
    },
    async editMessageText(
      body: TelegramEditMessageTextBody,
    ): Promise<"edited" | "unchanged"> {
      if (deps.ownsDirect()) return deps.directRuntime.editMessageText(body);
      try {
        await deps.callFollowerApi("call", ["editMessageText", body]);
        return "edited";
      } catch (error) {
        if (isTelegramMessageNotModifiedError(error)) return "unchanged";
        throw error;
      }
    },
    async editMessageReplyMarkup(
      chatId: number,
      messageId: number,
      replyMarkup: unknown,
    ): Promise<void> {
      if (deps.ownsDirect()) {
        await deps.directRuntime.editMessageReplyMarkup(
          chatId,
          messageId,
          replyMarkup,
        );
        return;
      }
      await deps.callFollowerApi("call", [
        "editMessageReplyMarkup",
        { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup },
      ]);
    },
    async answerCallbackQuery(
      callbackQueryId: string,
      text?: string,
    ): Promise<void> {
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
    async answerGuestQuery(
      guestQueryId: string,
      text?: string,
      options?: TelegramAnswerGuestQueryOptions,
    ): Promise<void> {
      if (deps.ownsDirect()) {
        await deps.directRuntime.answerGuestQuery(guestQueryId, text, options);
        return;
      }
      await deps.callFollowerApi("call", [
        "answerGuestQuery",
        buildTelegramAnswerGuestQueryBody(guestQueryId, text, options),
      ]);
    },
    answerGuestQueryForInlineMessage(
      guestQueryId: string,
      text?: string,
      options?: TelegramAnswerGuestQueryOptions,
    ): Promise<string | undefined> {
      // Guest answers can only be edited while this instance owns direct
      // transport; follower forwarding cannot preserve the inline message id.
      return deps.ownsDirect()
        ? deps.directRuntime.answerGuestQueryForInlineMessage(
            guestQueryId,
            text,
            options,
          )
        : rejectTelegramDirectOwnership("answerGuestQueryForInlineMessage");
    },
    editGuestInlineMessage(
      inlineMessageId: string,
      content: TelegramEditGuestInlineMessageContent,
    ): Promise<void> {
      return deps.ownsDirect()
        ? deps.directRuntime.editGuestInlineMessage(inlineMessageId, content)
        : rejectTelegramDirectOwnership("editGuestInlineMessage");
    },
    async deleteMessage(chatId: number, messageId: number): Promise<void> {
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
    prepareTempDir(): Promise<number> {
      return deps.directRuntime.prepareTempDir();
    },
  };
}
