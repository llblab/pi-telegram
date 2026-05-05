/**
 * Telegram API transport helpers
 * Zones: telegram transport, filesystem, runtime diagnostics
 * Wraps bot API calls, file downloads, runtime transport binding, and Telegram temp-file cleanup
 */

import { randomUUID } from "node:crypto";
import { createWriteStream, openAsBlob } from "node:fs";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const TELEGRAM_FILE_MAX_BYTES = 50 * 1024 * 1024;

export function getTelegramInboundFileByteLimitFromEnv(
  env: NodeJS.ProcessEnv,
  names: string[],
  defaultValue = TELEGRAM_FILE_MAX_BYTES,
): number {
  for (const name of names) {
    const rawValue = env[name]?.trim();
    if (!rawValue) continue;
    const parsed = Number(rawValue);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return defaultValue;
}

const TEMP_DIR = join(homedir(), ".pi", "agent", "tmp", "telegram");
const TELEGRAM_TEMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TELEGRAM_INBOUND_FILE_MAX_BYTES = getTelegramInboundFileByteLimitFromEnv(
  process.env,
  ["PI_TELEGRAM_INBOUND_FILE_MAX_BYTES", "TELEGRAM_MAX_FILE_SIZE_BYTES"],
  TELEGRAM_FILE_MAX_BYTES,
);

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVideo {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramAudio {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramAnimation {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramSticker {
  file_id: string;
  emoji?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  media_group_id?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  video?: TelegramVideo;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  animation?: TelegramAnimation;
  sticker?: TelegramSticker;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramReactionTypeEmoji {
  type: "emoji";
  emoji: string;
}

export interface TelegramReactionTypeCustomEmoji {
  type: "custom_emoji";
  custom_emoji_id: string;
}

export interface TelegramReactionTypePaid {
  type: "paid";
}

export type TelegramReactionType =
  | TelegramReactionTypeEmoji
  | TelegramReactionTypeCustomEmoji
  | TelegramReactionTypePaid;

export interface TelegramMessageReactionUpdated {
  chat: TelegramChat;
  message_id: number;
  user?: TelegramUser;
  actor_chat?: TelegramChat;
  old_reaction: TelegramReactionType[];
  new_reaction: TelegramReactionType[];
  date: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  message_reaction?: TelegramMessageReactionUpdated;
  deleted_business_messages?: { message_ids?: unknown };
}

export interface TelegramSentMessage {
  message_id: number;
}

export interface TelegramReplyParameters {
  message_id: number;
  allow_sending_without_reply: true;
}

export type TelegramSendMessageBody = Record<string, unknown> & {
  chat_id: number;
  text: string;
  parse_mode?: "HTML";
  reply_markup?: unknown;
  reply_parameters?: TelegramReplyParameters;
};

export type TelegramEditMessageTextBody = Record<string, unknown> & {
  chat_id: number;
  message_id: number;
  text: string;
  parse_mode?: "HTML";
};

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export interface TelegramApiCallOptions {
  signal?: AbortSignal;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface TelegramGetFileResult {
  file_path: string;
  file_size?: number;
}

export interface TelegramFileDownloadOptions {
  signal?: AbortSignal;
  maxFileSizeBytes?: number;
}

export interface TelegramApiClient {
  call: <TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: TelegramApiCallOptions,
  ) => Promise<TResponse>;
  callMultipart: <TResponse>(
    method: string,
    fields: Record<string, string>,
    fileField: string,
    filePath: string,
    fileName: string,
    options?: TelegramApiCallOptions,
  ) => Promise<TResponse>;
  downloadFile: (
    fileId: string,
    suggestedName: string,
    tempDir: string,
    options?: TelegramFileDownloadOptions,
  ) => Promise<string>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
}

export interface TelegramBridgeApiRuntimeDeps {
  client: TelegramApiClient;
  tempDir: string;
  maxFileSizeBytes: number;
  tempFileMaxAgeMs: number;
  recordRuntimeEvent: (
    kind: "api" | "multipart" | "download",
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramBridgeApiRuntime {
  call: <TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: TelegramApiCallOptions,
  ) => Promise<TResponse>;
  callMultipart: <TResponse>(
    method: string,
    fields: Record<string, string>,
    fileField: string,
    filePath: string,
    fileName: string,
    options?: TelegramApiCallOptions,
  ) => Promise<TResponse>;
  downloadFile: (fileId: string, suggestedName: string) => Promise<string>;
  deleteWebhook: (signal?: AbortSignal) => Promise<boolean>;
  getUpdates: (
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<TelegramUpdate[]>;
  setMyCommands: (
    commands: readonly { command: string; description: string }[],
  ) => Promise<boolean>;
  sendChatAction: (chatId: number, action: "typing") => Promise<boolean>;
  sendTypingAction: (chatId: number) => Promise<unknown>;
  sendMessageDraft: (
    chatId: number,
    draftId: number,
    text: string,
  ) => Promise<boolean>;
  sendMessage: (body: TelegramSendMessageBody) => Promise<TelegramSentMessage>;
  editMessageText: (
    body: TelegramEditMessageTextBody,
  ) => Promise<"edited" | "unchanged">;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  prepareTempDir: () => Promise<number>;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

class TelegramApiHttpError extends Error {
  readonly status: number | undefined;
  readonly retryAfterSeconds: number | undefined;
  constructor(
    message: string,
    status: number | undefined,
    retryAfterSeconds: number | undefined,
  ) {
    super(message);
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function isTelegramMessageNotModifiedError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("message is not modified")
  );
}

function isRetryableTelegramApiError(error: unknown): boolean {
  return (
    error instanceof TelegramApiHttpError &&
    (error.status === 429 ||
      (error.status !== undefined && error.status >= 500))
  );
}

function getTelegramRetryDelayMs(
  error: unknown,
  attempt: number,
  baseDelayMs: number,
): number {
  if (
    error instanceof TelegramApiHttpError &&
    error.retryAfterSeconds !== undefined
  ) {
    return Math.max(0, error.retryAfterSeconds * 1000);
  }
  return Math.max(0, baseDelayMs * 2 ** attempt);
}

function sleepTelegramRetry(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertTelegramFileSizeWithinLimit(
  size: number | undefined,
  maxFileSizeBytes: number | undefined,
): void {
  if (size === undefined || maxFileSizeBytes === undefined) return;
  if (size <= maxFileSizeBytes) return;
  throw new Error(
    `Telegram file exceeds size limit (${size} bytes > ${maxFileSizeBytes} bytes)`,
  );
}

function createTelegramDownloadLimitTransform(
  maxFileSizeBytes: number | undefined,
): Transform {
  let downloadedBytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloadedBytes += chunk.byteLength;
      try {
        assertTelegramFileSizeWithinLimit(downloadedBytes, maxFileSizeBytes);
        callback(undefined, chunk);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
}

async function writeTelegramDownloadResponse(
  response: Response,
  targetPath: string,
  maxFileSizeBytes: number | undefined,
): Promise<void> {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    assertTelegramFileSizeWithinLimit(buffer.byteLength, maxFileSizeBytes);
    await writeFile(targetPath, buffer);
    return;
  }
  await pipeline(
    Readable.from(response.body, { objectMode: false }),
    createTelegramDownloadLimitTransform(maxFileSizeBytes),
    createWriteStream(targetPath),
  );
}

async function removeTelegramPartialDownload(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}

async function parseTelegramApiResponse<TResponse>(
  response: Response,
  method: string,
): Promise<TelegramApiResponse<TResponse>> {
  let data: TelegramApiResponse<TResponse> | undefined;
  try {
    if (typeof response.text === "function") {
      const text = await response.text();
      data = text
        ? (JSON.parse(text) as TelegramApiResponse<TResponse>)
        : undefined;
    } else {
      data = (await response.json()) as TelegramApiResponse<TResponse>;
    }
  } catch {
    data = undefined;
  }
  if (response.ok === false) {
    const status = `HTTP ${response.status}`;
    const description = data?.description ? `: ${data.description}` : "";
    const retryAfterHeader = response.headers?.get("retry-after");
    const retryAfterSeconds =
      data?.parameters?.retry_after ??
      (retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined);
    throw new TelegramApiHttpError(
      `Telegram API ${method} failed: ${status}${description}`,
      response.status,
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
    );
  }
  return (
    data ?? {
      ok: false,
      description: `Telegram API ${method} returned invalid JSON`,
    }
  );
}

function unwrapTelegramApiResult<TResponse>(
  method: string,
  data: TelegramApiResponse<TResponse>,
): TResponse {
  if (!data.ok || data.result === undefined) {
    throw new Error(data.description || `Telegram API ${method} failed`);
  }
  return data.result;
}

async function callTelegramWithRetry<TResponse>(
  method: string,
  request: () => Promise<Response>,
  options: TelegramApiCallOptions | undefined,
): Promise<TResponse> {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? 3);
  const retryBaseDelayMs = options?.retryBaseDelayMs ?? 500;
  const sleep = options?.sleep ?? sleepTelegramRetry;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return unwrapTelegramApiResult(
        method,
        await parseTelegramApiResponse<TResponse>(await request(), method),
      );
    } catch (error) {
      if (attempt >= maxAttempts - 1 || !isRetryableTelegramApiError(error)) {
        throw error;
      }
      await sleep(getTelegramRetryDelayMs(error, attempt, retryBaseDelayMs));
    }
  }
}

export async function cleanupTelegramTempFiles(
  tempDir: string,
  maxAgeMs: number,
  now = Date.now(),
): Promise<number> {
  let removedCount = 0;
  let entries: Array<{ isFile(): boolean; name: string }>;
  try {
    entries = await readdir(tempDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(tempDir, entry.name);
    try {
      const stats = await stat(path);
      if (now - stats.mtimeMs <= maxAgeMs) continue;
      await unlink(path);
      removedCount += 1;
    } catch {
      // ignore
    }
  }
  return removedCount;
}

export async function prepareTelegramTempDir(
  tempDir: string,
  maxAgeMs: number,
): Promise<number> {
  await mkdir(tempDir, { recursive: true });
  return cleanupTelegramTempFiles(tempDir, maxAgeMs);
}

function assertTelegramBotTokenConfigured(
  botToken: string | undefined,
): string {
  if (!botToken) throw new Error("Telegram bot token is not configured");
  return botToken;
}

export async function callTelegram<TResponse>(
  botToken: string | undefined,
  method: string,
  body: Record<string, unknown>,
  options?: TelegramApiCallOptions,
): Promise<TResponse> {
  const configuredBotToken = assertTelegramBotTokenConfigured(botToken);
  return callTelegramWithRetry(
    method,
    async () =>
      fetch(`https://api.telegram.org/bot${configuredBotToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: options?.signal,
      }),
    options,
  );
}

export type TelegramBotIdentityResponse = Pick<
  TelegramApiResponse<TelegramUser>,
  "ok" | "result" | "description"
>;

export async function fetchTelegramBotIdentity(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TelegramBotIdentityResponse> {
  const response = await fetchImpl(
    `https://api.telegram.org/bot${botToken}/getMe`,
  );
  return response.json() as Promise<TelegramBotIdentityResponse>;
}

export async function callTelegramMultipart<TResponse>(
  botToken: string | undefined,
  method: string,
  fields: Record<string, string>,
  fileField: string,
  filePath: string,
  fileName: string,
  options?: TelegramApiCallOptions,
): Promise<TResponse> {
  const configuredBotToken = assertTelegramBotTokenConfigured(botToken);
  const fileBlob = await openAsBlob(filePath);
  return callTelegramWithRetry(
    method,
    async () => {
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) {
        form.set(key, value);
      }
      form.set(fileField, fileBlob, fileName);
      return fetch(
        `https://api.telegram.org/bot${configuredBotToken}/${method}`,
        {
          method: "POST",
          body: form,
          signal: options?.signal,
        },
      );
    },
    options,
  );
}

export async function downloadTelegramFile(
  botToken: string | undefined,
  fileId: string,
  suggestedName: string,
  tempDir: string,
  options?: TelegramFileDownloadOptions,
): Promise<string> {
  const configuredBotToken = assertTelegramBotTokenConfigured(botToken);
  const file = await callTelegram<TelegramGetFileResult>(
    configuredBotToken,
    "getFile",
    { file_id: fileId },
    { signal: options?.signal },
  );
  assertTelegramFileSizeWithinLimit(file.file_size, options?.maxFileSizeBytes);
  await mkdir(tempDir, { recursive: true });
  const targetPath = join(
    tempDir,
    `${randomUUID()}-${sanitizeFileName(suggestedName)}`,
  );
  const response = await fetch(
    `https://api.telegram.org/file/bot${configuredBotToken}/${file.file_path}`,
    { signal: options?.signal },
  );
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: ${response.status}`);
  }
  const contentLength = response.headers?.get("content-length");
  assertTelegramFileSizeWithinLimit(
    contentLength ? Number.parseInt(contentLength, 10) : undefined,
    options?.maxFileSizeBytes,
  );
  try {
    await writeTelegramDownloadResponse(
      response,
      targetPath,
      options?.maxFileSizeBytes,
    );
  } catch (error) {
    await removeTelegramPartialDownload(targetPath);
    throw error;
  }
  return targetPath;
}

export async function answerTelegramCallbackQuery(
  botToken: string | undefined,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  try {
    await callTelegram<boolean>(
      botToken,
      "answerCallbackQuery",
      text
        ? { callback_query_id: callbackQueryId, text }
        : { callback_query_id: callbackQueryId },
    );
  } catch {
    // ignore
  }
}

export function createTelegramChatActionSender<TAction extends string>(
  sendChatAction: (chatId: number, action: TAction) => Promise<unknown>,
  action: TAction,
): (chatId: number) => Promise<unknown> {
  return (chatId) => sendChatAction(chatId, action);
}

export function createDefaultTelegramBridgeApiRuntime(deps: {
  getBotToken: () => string | undefined;
  recordRuntimeEvent: TelegramBridgeApiRuntimeDeps["recordRuntimeEvent"];
}): TelegramBridgeApiRuntime {
  return createTelegramBridgeApiRuntime({
    client: createTelegramApiClient(deps.getBotToken),
    tempDir: TEMP_DIR,
    maxFileSizeBytes: TELEGRAM_INBOUND_FILE_MAX_BYTES,
    tempFileMaxAgeMs: TELEGRAM_TEMP_FILE_MAX_AGE_MS,
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
}

export function createTelegramBridgeApiRuntime(
  deps: TelegramBridgeApiRuntimeDeps,
): TelegramBridgeApiRuntime {
  const callRecorded = async <TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: TelegramApiCallOptions,
  ): Promise<TResponse> => {
    try {
      return await deps.client.call(method, body, options);
    } catch (error) {
      deps.recordRuntimeEvent("api", error, { method });
      throw error;
    }
  };
  return {
    call: callRecorded,
    callMultipart: async (
      method,
      fields,
      fileField,
      filePath,
      fileName,
      options,
    ) => {
      try {
        return await deps.client.callMultipart(
          method,
          fields,
          fileField,
          filePath,
          fileName,
          options,
        );
      } catch (error) {
        deps.recordRuntimeEvent("multipart", error, { method, fileName });
        throw error;
      }
    },
    downloadFile: async (fileId, suggestedName) => {
      try {
        return await deps.client.downloadFile(
          fileId,
          suggestedName,
          deps.tempDir,
          {
            maxFileSizeBytes: deps.maxFileSizeBytes,
          },
        );
      } catch (error) {
        deps.recordRuntimeEvent("download", error, { suggestedName });
        throw error;
      }
    },
    deleteWebhook: (signal) =>
      callRecorded<boolean>(
        "deleteWebhook",
        { drop_pending_updates: false },
        { signal },
      ),
    getUpdates: (body, signal) =>
      callRecorded<TelegramUpdate[]>("getUpdates", body, { signal }),
    setMyCommands: (commands) =>
      callRecorded<boolean>("setMyCommands", { commands }),
    sendChatAction: (chatId, action) =>
      callRecorded<boolean>("sendChatAction", {
        chat_id: chatId,
        action,
      }),
    sendTypingAction: createTelegramChatActionSender(
      (chatId, action) =>
        callRecorded<boolean>("sendChatAction", {
          chat_id: chatId,
          action,
        }),
      "typing",
    ),
    sendMessageDraft: (chatId, draftId, text) => {
      if (text.length === 0) return Promise.resolve(false);
      return callRecorded<boolean>("sendMessageDraft", {
        chat_id: chatId,
        draft_id: draftId,
        text,
      });
    },
    sendMessage: (body) =>
      callRecorded<TelegramSentMessage>("sendMessage", body),
    editMessageText: async (body) => {
      try {
        await deps.client.call("editMessageText", body);
        return "edited";
      } catch (error) {
        if (isTelegramMessageNotModifiedError(error)) return "unchanged";
        deps.recordRuntimeEvent("api", error, { method: "editMessageText" });
        throw error;
      }
    },
    answerCallbackQuery: (callbackQueryId, text) => {
      return deps.client.answerCallbackQuery(callbackQueryId, text);
    },
    prepareTempDir: () =>
      prepareTelegramTempDir(deps.tempDir, deps.tempFileMaxAgeMs),
  };
}

export function createTelegramApiClient(
  getBotToken: () => string | undefined,
): TelegramApiClient {
  return {
    call: async (method, body, options) => {
      return callTelegram(getBotToken(), method, body, options);
    },
    callMultipart: async (
      method,
      fields,
      fileField,
      filePath,
      fileName,
      options,
    ) => {
      return callTelegramMultipart(
        getBotToken(),
        method,
        fields,
        fileField,
        filePath,
        fileName,
        options,
      );
    },
    downloadFile: async (fileId, suggestedName, tempDir, options) => {
      return downloadTelegramFile(
        getBotToken(),
        fileId,
        suggestedName,
        tempDir,
        options,
      );
    },
    answerCallbackQuery: async (callbackQueryId, text) => {
      await answerTelegramCallbackQuery(getBotToken(), callbackQueryId, text);
    },
  };
}
