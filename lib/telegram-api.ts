/**
 * Telegram API transport helpers
 * Zones: telegram transport, filesystem, runtime diagnostics
 *
 * Wraps bot API calls, file uploads/downloads (including voice messages),
 * multipart sending, runtime transport binding, and Telegram temp-file lifecycle.
 */

import { randomUUID } from "node:crypto";
import { createWriteStream, openAsBlob } from "node:fs";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { request as requestHttps } from "node:https";
import { join } from "node:path";
import { resolveTelegramTempDir } from "./paths.ts";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const TELEGRAM_API_BASE = "https://api.telegram.org";

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

function getTelegramApiTempDir(): string {
  return resolveTelegramTempDir();
}
const TELEGRAM_TEMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TELEGRAM_INBOUND_FILE_MAX_BYTES = getTelegramInboundFileByteLimitFromEnv(
  process.env,
  ["PI_TELEGRAM_INBOUND_FILE_MAX_BYTES", "TELEGRAM_MAX_FILE_SIZE_BYTES"],
  TELEGRAM_FILE_MAX_BYTES,
);

export type TelegramNetworkFamilyPolicy =
  "auto" | "ipv4" | "ipv6" | "ipv4-fallback";

const TELEGRAM_NETWORK_FAMILY_ENV = "PI_TELEGRAM_NETWORK_FAMILY";
const TELEGRAM_NETWORK_FAMILY_VALUES = new Set<TelegramNetworkFamilyPolicy>([
  "auto",
  "ipv4",
  "ipv6",
  "ipv4-fallback",
]);
type TelegramNetworkFamily = 4 | 6;

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

export interface TelegramRichMessage {
  blocks?: unknown[];
  is_rtl?: boolean;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  rich_message?: TelegramRichMessage;
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

export interface TelegramGuestMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  rich_message?: TelegramRichMessage;
  guest_query_id: string;
  guest_bot_caller_user?: TelegramUser;
  guest_bot_caller_chat?: TelegramChat;
  reply_to_message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  message_reaction?: TelegramMessageReactionUpdated;
  guest_message?: TelegramGuestMessage;
  deleted_business_messages?: { message_ids?: unknown };
}

export interface TelegramSentMessage {
  message_id: number;
}

export interface TelegramReplyParameters {
  message_id: number;
  allow_sending_without_reply?: boolean;
  chat_id?: number;
  message_thread_id?: number;
}

export type TelegramSendMessageBody = Record<string, unknown> & {
  chat_id: number;
  text: string;
  parse_mode?: "HTML";
  reply_markup?: unknown;
  reply_parameters?: TelegramReplyParameters;
};

export type TelegramInputRichMessage =
  | {
      markdown: string;
      html?: never;
      is_rtl?: boolean;
      skip_entity_detection?: boolean;
    }
  | {
      html: string;
      markdown?: never;
      is_rtl?: boolean;
      skip_entity_detection?: boolean;
    };

export type TelegramSendRichMessageBody = Record<string, unknown> & {
  chat_id: number;
  rich_message: TelegramInputRichMessage;
  reply_markup?: unknown;
  reply_parameters?: TelegramReplyParameters;
};

export type TelegramInputRichMessageContent = {
  rich_message: TelegramInputRichMessage;
};

export type TelegramEditMessageTextBody = Record<string, unknown> & {
  chat_id: number;
  message_id: number;
  text?: string;
  rich_message?: TelegramInputRichMessage;
  parse_mode?: "HTML";
  reply_markup?: unknown;
};

export type TelegramSendMessageDraftBody = Record<string, unknown> & {
  chat_id: number;
  draft_id: number;
  text?: string;
  parse_mode?: string;
  entities?: unknown[];
  message_thread_id?: number;
};

export type TelegramSendRichMessageDraftBody = Record<string, unknown> & {
  chat_id: number;
  draft_id: number;
  rich_message: TelegramInputRichMessage;
  message_thread_id?: number;
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

export type TelegramGuestCachedMediaResult =
  | {
      type: "document";
      id: string;
      title: string;
      document_file_id: string;
      caption?: string;
      parse_mode?: string;
    }
  | {
      type: "photo";
      id: string;
      photo_file_id: string;
      caption?: string;
      parse_mode?: string;
    }
  | {
      type: "audio";
      id: string;
      audio_file_id: string;
      caption?: string;
      parse_mode?: string;
    }
  | {
      type: "voice";
      id: string;
      voice_file_id: string;
      title: string;
      caption?: string;
      parse_mode?: string;
    };

export interface TelegramAnswerGuestQueryOptions {
  parseMode?: string;
  richMessage?: TelegramInputRichMessage;
  result?: TelegramGuestCachedMediaResult;
}

export interface TelegramAnswerCallbackQueryOptions {
  recordRuntimeEvent?: (
    kind: "api",
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
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
  answerGuestQuery?: (
    guestQueryId: string,
    text?: string,
    options?: TelegramAnswerGuestQueryOptions,
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
  sendChatAction: (
    chatId: number,
    action: string,
    options?: { message_thread_id?: number },
  ) => Promise<boolean>;
  sendTypingAction: (
    chatId: number,
    options?: { message_thread_id?: number },
  ) => Promise<unknown>;
  sendRecordVoiceAction: (
    chatId: number,
    options?: { message_thread_id?: number },
  ) => Promise<unknown>;
  sendMessageDraft: (
    chatId: number,
    draftId: number,
    text?: string,
    options?: {
      parse_mode?: string;
      entities?: unknown[];
      message_thread_id?: number;
    },
  ) => Promise<boolean>;
  sendMessage: (body: TelegramSendMessageBody) => Promise<TelegramSentMessage>;
  sendRichMessage: (
    body: TelegramSendRichMessageBody,
  ) => Promise<TelegramSentMessage>;
  sendRichMessageDraft: (
    body: TelegramSendRichMessageDraftBody,
  ) => Promise<boolean>;
  editMessageText: (
    body: TelegramEditMessageTextBody,
  ) => Promise<"edited" | "unchanged">;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  answerGuestQuery: (
    guestQueryId: string,
    text?: string,
    options?: TelegramAnswerGuestQueryOptions,
  ) => Promise<void>;
  deleteMessage: (chatId: number, messageId: number) => Promise<void>;
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
    await writeFile(targetPath, buffer, { mode: 0o600 });
    return;
  }
  await pipeline(
    Readable.from(response.body, { objectMode: false }),
    createTelegramDownloadLimitTransform(maxFileSizeBytes),
    createWriteStream(targetPath, { mode: 0o600 }),
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

function getTelegramNetworkFamilyPolicy(
  env: NodeJS.ProcessEnv = process.env,
): TelegramNetworkFamilyPolicy {
  const value = env[TELEGRAM_NETWORK_FAMILY_ENV]?.trim().toLowerCase();
  if (
    TELEGRAM_NETWORK_FAMILY_VALUES.has(value as TelegramNetworkFamilyPolicy)
  ) {
    return value as TelegramNetworkFamilyPolicy;
  }
  return "ipv4-fallback";
}

function getTelegramNetworkFamily(
  policy: TelegramNetworkFamilyPolicy,
): TelegramNetworkFamily | undefined {
  if (policy === "ipv4") return 4;
  if (policy === "ipv6") return 6;
  return undefined;
}

function isTelegramTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return false;
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
    return true;
  }
  if (error instanceof AggregateError) return true;
  const code = getErrorCode(error);
  if (
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENETUNREACH" ||
    code === "EHOSTUNREACH" ||
    code === "ECONNRESET" ||
    code === "EAI_AGAIN"
  ) {
    return true;
  }
  return isTelegramTransportFailure(error.cause);
}

function getTelegramRequestBodyBuffer(
  body: BodyInit | null | undefined,
): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new Error("Unsupported Telegram HTTPS request body");
}

async function buildTelegramMultipartBody(
  fields: Record<string, string>,
  fileField: string,
  fileBlob: Blob,
  fileName: string,
): Promise<{ body: Buffer; contentType: string }> {
  const boundary = `pi-telegram-${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${fileBlob.type || "application/octet-stream"}\r\n\r\n`,
    ),
    Buffer.from(await fileBlob.arrayBuffer()),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function telegramHttpsFetch(
  input: string | URL | Request,
  init: RequestInit,
  family: TelegramNetworkFamily,
): Promise<Response> {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  const body = getTelegramRequestBodyBuffer(init.body);
  const headers = new Headers(init.headers);
  if (body && !headers.has("content-length")) {
    headers.set("content-length", String(body.byteLength));
  }
  return new Promise<Response>((resolve, reject) => {
    const req = requestHttps(
      url,
      {
        method: init.method ?? "GET",
        family,
        headers: Object.fromEntries(headers.entries()),
      },
      (res) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) responseHeaders.set(key, value.join(", "));
          else if (value !== undefined) responseHeaders.set(key, String(value));
        }
        resolve(
          new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
            status: res.statusCode ?? 200,
            statusText: res.statusMessage,
            headers: responseHeaders,
          }),
        );
      },
    );
    req.on("error", reject);
    if (init.signal) {
      if (init.signal.aborted)
        req.destroy(new DOMException("Aborted", "AbortError"));
      else {
        init.signal.addEventListener(
          "abort",
          () => req.destroy(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }
    }
    req.end(body);
  });
}

let telegramHttpsFetchForTesting: typeof telegramHttpsFetch | undefined;

export function setTelegramApiHttpsFetchForTesting(
  fetchImpl: typeof telegramHttpsFetch | undefined,
): () => void {
  const previous = telegramHttpsFetchForTesting;
  telegramHttpsFetchForTesting = fetchImpl;
  return () => {
    telegramHttpsFetchForTesting = previous;
  };
}

async function telegramFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  family?: TelegramNetworkFamily,
): Promise<Response> {
  if (!family) return fetch(input, init);
  return (telegramHttpsFetchForTesting ?? telegramHttpsFetch)(
    input,
    init,
    family,
  );
}

async function callTelegramTransportRequest(
  request: (family?: TelegramNetworkFamily) => Promise<Response>,
): Promise<Response> {
  const policy = getTelegramNetworkFamilyPolicy();
  if (policy === "auto") return request();
  const family = getTelegramNetworkFamily(policy);
  if (family) return request(family);
  try {
    return await request();
  } catch (error) {
    if (!isTelegramTransportFailure(error)) throw error;
    return request(4);
  }
}

function getErrorCode(error: Error): string | undefined {
  const maybeCode = (error as { code?: unknown }).code;
  return typeof maybeCode === "string" ? maybeCode : undefined;
}

function getErrorAddress(error: Error): string | undefined {
  const maybeAddress = (error as { address?: unknown }).address;
  return typeof maybeAddress === "string" ? maybeAddress : undefined;
}

function getErrorPort(error: Error): number | undefined {
  const maybePort = (error as { port?: unknown }).port;
  return typeof maybePort === "number" ? maybePort : undefined;
}

function getErrorFamily(error: Error): number | string | undefined {
  const maybeFamily = (error as { family?: unknown }).family;
  if (typeof maybeFamily === "number" || typeof maybeFamily === "string") {
    return maybeFamily;
  }
  return undefined;
}

function describeTelegramErrorSummary(error: Error): {
  name: string;
  message: string;
  code?: string;
} {
  return {
    name: error.name,
    message: error.message,
    ...(getErrorCode(error) ? { code: getErrorCode(error) } : {}),
  };
}

function describeTelegramTransportAttempt(error: Error): {
  name: string;
  code?: string;
  address?: string;
  port?: number;
  family?: number | string;
} {
  return {
    name: error.name,
    ...(getErrorCode(error) ? { code: getErrorCode(error) } : {}),
    ...(getErrorAddress(error) ? { address: getErrorAddress(error) } : {}),
    ...(getErrorPort(error) ? { port: getErrorPort(error) } : {}),
    ...(getErrorFamily(error) ? { family: getErrorFamily(error) } : {}),
  };
}

function describeTelegramTransportError(error: unknown):
  | {
      error: { name: string; message: string; code?: string };
      cause?: { name: string; message: string; code?: string };
      attempts?: Array<{
        name: string;
        code?: string;
        address?: string;
        port?: number;
        family?: number | string;
      }>;
    }
  | undefined {
  if (!isTelegramTransportFailure(error) || !(error instanceof Error)) {
    return undefined;
  }
  const cause = error.cause instanceof Error ? error.cause : undefined;
  const aggregate =
    error instanceof AggregateError
      ? error
      : cause instanceof AggregateError
        ? cause
        : undefined;
  const attempts = aggregate?.errors
    .filter((attempt): attempt is Error => attempt instanceof Error)
    .map(describeTelegramTransportAttempt);
  return {
    error: describeTelegramErrorSummary(error),
    ...(cause ? { cause: describeTelegramErrorSummary(cause) } : {}),
    ...(attempts && attempts.length > 0 ? { attempts } : {}),
  };
}

function withTelegramTransportDiagnostics(
  error: unknown,
  details: Record<string, unknown>,
): Record<string, unknown> {
  const transport = describeTelegramTransportError(error);
  return transport ? { ...details, transport } : details;
}

async function callTelegramWithRetry<TResponse>(
  method: string,
  request: (family?: TelegramNetworkFamily) => Promise<Response>,
  options: TelegramApiCallOptions | undefined,
): Promise<TResponse> {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? 3);
  const retryBaseDelayMs = options?.retryBaseDelayMs ?? 500;
  const sleep = options?.sleep ?? sleepTelegramRetry;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return unwrapTelegramApiResult(
        method,
        await parseTelegramApiResponse<TResponse>(
          await callTelegramTransportRequest(request),
          method,
        ),
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
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
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
    async (family) =>
      telegramFetch(
        `${TELEGRAM_API_BASE}/bot${configuredBotToken}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: options?.signal,
        },
        family,
      ),
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
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/getMe`;
  const response = await callTelegramTransportRequest((family) =>
    fetchImpl === fetch ? telegramFetch(url, {}, family) : fetchImpl(url),
  );
  return response.json() as Promise<TelegramBotIdentityResponse>;
}

/**
 * Low-level helper to send a multipart/form-data request to the Telegram Bot API.
 * This is the core implementation used for uploading voice messages, photos,
 * documents, animations, etc. It handles FormData construction, retry logic
 * (via callTelegramWithRetry), and error recording under the "multipart" category.
 */
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
    async (family) => {
      if (family) {
        const multipart = await buildTelegramMultipartBody(
          fields,
          fileField,
          fileBlob,
          fileName,
        );
        return telegramFetch(
          `${TELEGRAM_API_BASE}/bot${configuredBotToken}/${method}`,
          {
            method: "POST",
            headers: { "content-type": multipart.contentType },
            body: multipart.body as unknown as BodyInit,
            signal: options?.signal,
          },
          family,
        );
      }
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) {
        form.set(key, value);
      }
      form.set(fileField, fileBlob, fileName);
      return telegramFetch(
        `${TELEGRAM_API_BASE}/bot${configuredBotToken}/${method}`,
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
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  const targetPath = join(
    tempDir,
    `${randomUUID()}-${sanitizeFileName(suggestedName)}`,
  );
  const response = await callTelegramTransportRequest((family) =>
    telegramFetch(
      `${TELEGRAM_API_BASE}/file/bot${configuredBotToken}/${file.file_path}`,
      { signal: options?.signal },
      family,
    ),
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
  options: TelegramAnswerCallbackQueryOptions = {},
): Promise<void> {
  try {
    await callTelegram<boolean>(
      botToken,
      "answerCallbackQuery",
      text
        ? { callback_query_id: callbackQueryId, text }
        : { callback_query_id: callbackQueryId },
    );
  } catch (error) {
    options.recordRuntimeEvent?.(
      "api",
      error,
      withTelegramTransportDiagnostics(error, {
        method: "answerCallbackQuery",
      }),
    );
  }
}

export async function deleteTelegramMessage(
  botToken: string | undefined,
  chatId: number,
  messageId: number,
): Promise<void> {
  try {
    await callTelegram<boolean>(botToken, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch {
    // ignore
  }
}

export function createTelegramChatActionSender<TAction extends string>(
  sendChatAction: (
    chatId: number,
    action: TAction,
    options?: { message_thread_id?: number },
  ) => Promise<unknown>,
  action: TAction,
): (
  chatId: number,
  options?: { message_thread_id?: number },
) => Promise<unknown> {
  return (chatId, options) => sendChatAction(chatId, action, options);
}

export function createTelegramNativeMarkdownDraftSender(deps: {
  sendMessageDraft: TelegramBridgeApiRuntime["sendMessageDraft"];
  sendRichMessageDraft: TelegramBridgeApiRuntime["sendRichMessageDraft"];
}): TelegramBridgeApiRuntime["sendMessageDraft"] {
  return (chatId, draftId, text, options) => {
    if (text === undefined) {
      return deps.sendMessageDraft(chatId, draftId, text, options);
    }
    return deps.sendRichMessageDraft({
      chat_id: chatId,
      draft_id: draftId,
      rich_message: { markdown: text, skip_entity_detection: true },
      ...(options?.message_thread_id !== undefined
        ? { message_thread_id: options.message_thread_id }
        : {}),
    });
  };
}

export function createTelegramAssistantDraftSender(deps: {
  getAssistantRenderingMode: () => "rich" | "html";
  renderMarkdownToHtmlDraft: (markdown: string) => string;
  sendMessageDraft: TelegramBridgeApiRuntime["sendMessageDraft"];
  sendRichMessageDraft: TelegramBridgeApiRuntime["sendRichMessageDraft"];
}): TelegramBridgeApiRuntime["sendMessageDraft"] {
  const sendNativeDraft = createTelegramNativeMarkdownDraftSender(deps);
  return (chatId, draftId, text, options) => {
    if (text === undefined || deps.getAssistantRenderingMode() === "rich") {
      return sendNativeDraft(chatId, draftId, text, options);
    }
    return deps.sendMessageDraft(
      chatId,
      draftId,
      deps.renderMarkdownToHtmlDraft(text),
      {
        ...options,
        parse_mode: "HTML",
      },
    );
  };
}

export function createDefaultTelegramBridgeApiRuntime(deps: {
  getBotToken: () => string | undefined;
  recordRuntimeEvent: TelegramBridgeApiRuntimeDeps["recordRuntimeEvent"];
}): TelegramBridgeApiRuntime {
  return createTelegramBridgeApiRuntime({
    client: createTelegramApiClient(deps.getBotToken, {
      recordRuntimeEvent: deps.recordRuntimeEvent,
    }),
    tempDir: getTelegramApiTempDir(),
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
      return await deps.client.call<TResponse>(method, body, options);
    } catch (error) {
      deps.recordRuntimeEvent(
        "api",
        error,
        withTelegramTransportDiagnostics(error, { method }),
      );
      throw error;
    }
  };
  return {
    call: callRecorded,

    /**
     * Sends a multipart/form-data request (used for sending voice messages,
     * photos, documents, animations, etc.).
     * Errors are recorded under the "multipart" category for diagnostics.
     */
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
        deps.recordRuntimeEvent(
          "multipart",
          error,
          withTelegramTransportDiagnostics(error, { method, fileName }),
        );
        throw error;
      }
    },

    /**
     * Downloads a file from the Telegram servers into the local temp directory.
     * Used for inbound voice messages, photos, documents, etc.
     */
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
        deps.recordRuntimeEvent(
          "download",
          error,
          withTelegramTransportDiagnostics(error, { suggestedName }),
        );
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
    sendChatAction: (chatId, action, options) =>
      callRecorded<boolean>("sendChatAction", {
        chat_id: chatId,
        action,
        ...(options?.message_thread_id !== undefined
          ? { message_thread_id: options.message_thread_id }
          : {}),
      }),
    sendTypingAction: createTelegramChatActionSender(
      (chatId, action, options) =>
        callRecorded<boolean>("sendChatAction", {
          chat_id: chatId,
          action,
          ...(options?.message_thread_id !== undefined
            ? { message_thread_id: options.message_thread_id }
            : {}),
        }),
      "typing",
    ),
    sendRecordVoiceAction: createTelegramChatActionSender(
      (chatId, action, options) =>
        callRecorded<boolean>("sendChatAction", {
          chat_id: chatId,
          action,
          ...(options?.message_thread_id !== undefined
            ? { message_thread_id: options.message_thread_id }
            : {}),
        }),
      "record_voice",
    ),
    sendMessageDraft: (chatId, draftId, text, options) => {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        draft_id: draftId,
      };
      if (text !== undefined) body.text = text;
      if (options?.parse_mode !== undefined)
        body.parse_mode = options.parse_mode;
      if (options?.entities !== undefined) body.entities = options.entities;
      if (options?.message_thread_id !== undefined)
        body.message_thread_id = options.message_thread_id;
      return callRecorded<boolean>("sendMessageDraft", body);
    },
    sendMessage: (body) =>
      callRecorded<TelegramSentMessage>("sendMessage", body),
    sendRichMessage: (body) =>
      callRecorded<TelegramSentMessage>("sendRichMessage", body),
    sendRichMessageDraft: (body) =>
      callRecorded<boolean>("sendRichMessageDraft", body),
    editMessageText: async (body) => {
      try {
        await deps.client.call("editMessageText", body);
        return "edited";
      } catch (error) {
        if (isTelegramMessageNotModifiedError(error)) return "unchanged";
        deps.recordRuntimeEvent(
          "api",
          error,
          withTelegramTransportDiagnostics(error, {
            method: "editMessageText",
          }),
        );
        throw error;
      }
    },
    answerCallbackQuery: async (callbackQueryId, text) => {
      try {
        await deps.client.answerCallbackQuery(callbackQueryId, text);
      } catch (error) {
        deps.recordRuntimeEvent(
          "api",
          error,
          withTelegramTransportDiagnostics(error, {
            method: "answerCallbackQuery",
          }),
        );
      }
    },
    answerGuestQuery: (
      guestQueryId: string,
      text: string | undefined,
      options: TelegramAnswerGuestQueryOptions | undefined,
    ) => {
      const body: Record<string, unknown> = { guest_query_id: guestQueryId };
      if (options?.result) {
        body.result = options.result;
      } else if (text !== undefined || options?.richMessage) {
        const inputContent: Record<string, unknown> = options?.richMessage
          ? { rich_message: options.richMessage }
          : { message_text: text };
        if (!options?.richMessage && options?.parseMode) {
          inputContent.parse_mode = options.parseMode;
        }
        body.result = {
          type: "article",
          id: "1",
          title: "Response",
          input_message_content: inputContent,
        };
      }
      return callRecorded<void>("answerGuestQuery", body);
    },
    prepareTempDir: () =>
      prepareTelegramTempDir(deps.tempDir, deps.tempFileMaxAgeMs),
    deleteMessage: (chatId, messageId) =>
      callRecorded<boolean>("deleteMessage", {
        chat_id: chatId,
        message_id: messageId,
      }).then(() => {}),
  };
}

/**
 * Creates a low-level Telegram Bot API client.
 * This is the main entry point for all direct Bot API communication
 * (both JSON calls and multipart uploads for files/voice).
 */
export function createTelegramApiClient(
  getBotToken: () => string | undefined,
  options: TelegramAnswerCallbackQueryOptions = {},
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
      await answerTelegramCallbackQuery(
        getBotToken(),
        callbackQueryId,
        text,
        options,
      );
    },
  };
}
