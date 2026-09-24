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
import { resolveTelegramTempDir } from "./paths.js";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
export const TELEGRAM_API_BASE = "https://api.telegram.org";
export const TELEGRAM_FILE_MAX_BYTES = 50 * 1024 * 1024;
export function getTelegramInboundFileByteLimitFromEnv(env, names, defaultValue = TELEGRAM_FILE_MAX_BYTES) {
    for (const name of names) {
        const rawValue = env[name]?.trim();
        if (!rawValue)
            continue;
        const parsed = Number(rawValue);
        if (Number.isSafeInteger(parsed) && parsed > 0)
            return parsed;
    }
    return defaultValue;
}
function getTelegramApiTempDir() {
    return resolveTelegramTempDir();
}
const TELEGRAM_TEMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const activeTelegramApiWorkspaceAdmissionOperationIds = new Set();
const TELEGRAM_TEMP_SCRATCH_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/u;
const TELEGRAM_INBOUND_FILE_MAX_BYTES = getTelegramInboundFileByteLimitFromEnv(process.env, ["PI_TELEGRAM_INBOUND_FILE_MAX_BYTES", "TELEGRAM_MAX_FILE_SIZE_BYTES"], TELEGRAM_FILE_MAX_BYTES);
const TELEGRAM_NETWORK_FAMILY_ENV = "PI_TELEGRAM_NETWORK_FAMILY";
const TELEGRAM_NETWORK_FAMILY_VALUES = new Set([
    "auto",
    "ipv4",
    "ipv6",
    "ipv4-fallback",
]);
function parseTelegramApiTargetInteger(value) {
    const parsed = typeof value === "number" ? value :
        typeof value === "string" && /^-?\d+$/u.test(value) ? Number(value) : undefined;
    return parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined;
}
export function createTelegramApiTargetActivityRuntime() {
    const pending = new Map();
    const pendingChats = new Map();
    const messageScopedMethods = new Set([
        "deleteMessage",
        "editMessageCaption",
        "editMessageReplyMarkup",
        "editMessageText",
    ]);
    return {
        begin(method, body) {
            const chatId = parseTelegramApiTargetInteger(body.chat_id);
            const threadId = parseTelegramApiTargetInteger(body.message_thread_id);
            const messageId = parseTelegramApiTargetInteger(body.message_id);
            const chatScoped = chatId !== undefined && threadId === undefined &&
                messageId !== undefined && messageScopedMethods.has(method);
            if (chatId === undefined || (threadId === undefined && !chatScoped)) {
                return () => undefined;
            }
            const key = threadId === undefined ? undefined : `${chatId}:${threadId}`;
            if (key) {
                const existing = pending.get(key);
                if (existing)
                    existing.count += 1;
                else
                    pending.set(key, { target: { chatId, threadId: threadId }, count: 1 });
            }
            else {
                pendingChats.set(chatId, (pendingChats.get(chatId) ?? 0) + 1);
            }
            let completed = false;
            return () => {
                if (completed)
                    return;
                completed = true;
                if (!key) {
                    const count = pendingChats.get(chatId);
                    if (!count || count <= 1)
                        pendingChats.delete(chatId);
                    else
                        pendingChats.set(chatId, count - 1);
                    return;
                }
                const current = pending.get(key);
                if (!current || current.count <= 1)
                    pending.delete(key);
                else
                    current.count -= 1;
            };
        },
        hasPendingTarget(target) {
            return pendingChats.has(target.chatId) ||
                (target.threadId !== undefined && pending.has(`${target.chatId}:${target.threadId}`));
        },
        listPendingTargets() {
            return Array.from(pending.values(), ({ target }) => ({ ...target }));
        },
        listPendingChats() {
            return Array.from(pendingChats.keys());
        },
    };
}
export function createTelegramApiTargetTrackingClient(client, activity) {
    const track = async (method, body, operation) => {
        const end = activity.begin(method, body);
        try {
            return await operation();
        }
        finally {
            end();
        }
    };
    return {
        call: (method, body, options) => track(method, body, () => client.call(method, body, options)),
        callMultipart: (method, fields, fileField, filePath, fileName, options) => track(method, fields, () => client.callMultipart(method, fields, fileField, filePath, fileName, options)),
        downloadFile: client.downloadFile,
        answerCallbackQuery: client.answerCallbackQuery,
        ...(client.answerGuestQuery
            ? { answerGuestQuery: client.answerGuestQuery }
            : {}),
    };
}
export class TelegramApiWorkspaceAdmissionError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "TelegramApiWorkspaceAdmissionError";
        this.code = code;
    }
}
export function getTelegramApiWorkspaceAdmissionScope(body) {
    if (!("chat_id" in body))
        return undefined;
    const chatId = parseTelegramApiTargetInteger(body.chat_id);
    if (chatId === undefined || chatId === 0)
        return { kind: "profile" };
    if (!("message_thread_id" in body) || body.message_thread_id === undefined) {
        return { kind: "chat", chatId };
    }
    const threadId = parseTelegramApiTargetInteger(body.message_thread_id);
    if (threadId === undefined || threadId <= 0)
        return { kind: "profile" };
    return { kind: "target", target: { chatId, threadId } };
}
export function createTelegramApiWorkspaceAdmissionClient(client, admission, options = {}) {
    const admit = async (method, body, operation) => {
        const scope = getTelegramApiWorkspaceAdmissionScope(body);
        if (!scope)
            return operation();
        const currentAdmission = typeof admission === "function" ? admission() : admission;
        if (!currentAdmission) {
            throw new TelegramApiWorkspaceAdmissionError("unavailable", "Telegram API Workspace admission authority is unavailable.");
        }
        const operationId = `api:${(options.createOperationId ?? randomUUID)()}`;
        if (activeTelegramApiWorkspaceAdmissionOperationIds.has(operationId)) {
            throw new TelegramApiWorkspaceAdmissionError("duplicate-operation", "Telegram API Workspace admission operation is already active.");
        }
        activeTelegramApiWorkspaceAdmissionOperationIds.add(operationId);
        try {
            const acquired = currentAdmission.acquireAdmission({
                operationId,
                operationKind: `api.${method}`,
                scope,
            });
            if (acquired.kind === "blocked") {
                throw new TelegramApiWorkspaceAdmissionError("blocked", "Telegram API target is temporarily unavailable during Workspace retirement.");
            }
            try {
                return await operation();
            }
            finally {
                try {
                    if (!currentAdmission.releaseAdmission(acquired.lease)) {
                        throw new TelegramApiWorkspaceAdmissionError("release-lost", "Telegram API Workspace admission lease disappeared before release.");
                    }
                }
                catch (error) {
                    try {
                        options.onReleaseError?.(error, method);
                    }
                    catch {
                        // Diagnostics cannot convert an already-settled API request into replay.
                    }
                }
            }
        }
        finally {
            activeTelegramApiWorkspaceAdmissionOperationIds.delete(operationId);
        }
    };
    return {
        call: (method, body, callOptions) => admit(method, body, () => client.call(method, body, callOptions)),
        callMultipart: (method, fields, fileField, filePath, fileName, callOptions) => admit(method, fields, () => client.callMultipart(method, fields, fileField, filePath, fileName, callOptions)),
        downloadFile: client.downloadFile,
        answerCallbackQuery: client.answerCallbackQuery,
        ...(client.answerGuestQuery
            ? { answerGuestQuery: client.answerGuestQuery }
            : {}),
    };
}
function sanitizeFileName(name) {
    return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}
class TelegramApiMalformedSuccessError extends Error {
    constructor(method, detail) {
        super(`Telegram API ${method} ${detail}`);
        this.name = "TelegramApiMalformedSuccessError";
    }
}
export class TelegramApiCommitUnknownError extends Error {
    kind = "commit-unknown";
    method;
    cause;
    constructor(method, cause) {
        super(`Telegram API ${method} may have committed before transport failed.`);
        this.name = "TelegramApiCommitUnknownError";
        this.method = method;
        this.cause = cause;
    }
}
export function isTelegramApiCommitUnknownError(error) {
    return error instanceof TelegramApiCommitUnknownError;
}
class TelegramApiHttpError extends Error {
    status;
    retryAfterSeconds;
    rejectedRequestMethod;
    requestTarget;
    constructor(message, status, retryAfterSeconds, rejectedRequestMethod) {
        super(message);
        this.status = status;
        this.retryAfterSeconds = retryAfterSeconds;
        this.rejectedRequestMethod = rejectedRequestMethod;
    }
}
function attachTelegramApiRequestTarget(error, body) {
    if (!(error instanceof TelegramApiHttpError))
        return;
    const chatId = Number(body.chat_id);
    const threadId = Number(body.message_thread_id);
    if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(threadId))
        return;
    error.requestTarget = { chatId, threadId };
}
export class TelegramApiStaleTargetError extends Error {
    requestTarget;
    constructor(message, requestTarget) {
        super(message);
        this.name = "TelegramApiStaleTargetError";
        this.requestTarget = { ...requestTarget };
    }
}
export function getTelegramApiErrorRequestTarget(error) {
    const target = error instanceof TelegramApiHttpError ||
        error instanceof TelegramApiStaleTargetError
        ? error.requestTarget
        : undefined;
    return target ? { ...target } : undefined;
}
export function isTelegramStaleTargetHttpError(error) {
    if (!(error instanceof TelegramApiHttpError) || error.status !== 400)
        return false;
    return /^Telegram API \w+ failed: HTTP 400: Bad Request: (message thread not found|thread not found|topic not found|topic deleted|topic closed|thread closed|forum topic closed|message thread closed|topic_id_invalid|topic_closed)$/i.test(error.message);
}
/** Only a parsed Telegram rejection of this method proves a request had no effect. */
export function isTelegramApiRequestRejected(error, method) {
    return error instanceof TelegramApiHttpError && error.rejectedRequestMethod !== undefined &&
        error.rejectedRequestMethod === method;
}
export function isTelegramMessageNotModifiedError(error) {
    return (error instanceof Error && error.message.includes("message is not modified"));
}
const TELEGRAM_RETRY_SAFE_METHODS = new Set([
    "answerCallbackQuery",
    "closeForumTopic",
    "deleteForumTopic",
    "deleteMessage",
    "deleteWebhook",
    "editForumTopic",
    "editMessageCaption",
    "editMessageReplyMarkup",
    "editMessageText",
    "getChat",
    "getFile",
    "getMe",
    "getUpdates",
    "sendChatAction",
    "sendMessageDraft",
    "sendRichMessageDraft",
    "setMyCommands",
]);
export function isTelegramApiMethodRetrySafe(method) {
    return TELEGRAM_RETRY_SAFE_METHODS.has(method);
}
export function isRetryableTelegramApiError(error) {
    return (error instanceof TelegramApiHttpError &&
        (error.status === 429 ||
            (error.status !== undefined && error.status >= 500)));
}
export function getTelegramApiRetryAfterMs(error) {
    return error instanceof TelegramApiHttpError && error.retryAfterSeconds !== undefined
        ? Math.max(0, error.retryAfterSeconds * 1000)
        : undefined;
}
export function isTelegramMessageUnavailableError(error) {
    return error instanceof TelegramApiHttpError && error.status === 400 &&
        /Bad Request: (message to edit not found|message not found|message_id_invalid)/iu.test(error.message);
}
function getTelegramRetryDelayMs(error, attempt, baseDelayMs) {
    if (error instanceof TelegramApiHttpError &&
        error.retryAfterSeconds !== undefined) {
        return Math.max(0, error.retryAfterSeconds * 1000);
    }
    return Math.max(0, baseDelayMs * 2 ** attempt);
}
function getTelegramApiAbortReason(signal) {
    return signal.reason ?? new DOMException("Aborted", "AbortError");
}
function throwIfTelegramApiCallAborted(signal) {
    if (signal?.aborted)
        throw getTelegramApiAbortReason(signal);
}
function sleepTelegramRetry(ms, signal) {
    if (signal?.aborted)
        return Promise.reject(getTelegramApiAbortReason(signal));
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timeout);
            reject(getTelegramApiAbortReason(signal));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted)
            onAbort();
    });
}
function assertTelegramFileSizeWithinLimit(size, maxFileSizeBytes) {
    if (size === undefined || maxFileSizeBytes === undefined)
        return;
    if (size <= maxFileSizeBytes)
        return;
    throw new Error(`Telegram file exceeds size limit (${size} bytes > ${maxFileSizeBytes} bytes)`);
}
function createTelegramDownloadLimitTransform(maxFileSizeBytes) {
    let downloadedBytes = 0;
    return new Transform({
        transform(chunk, _encoding, callback) {
            downloadedBytes += chunk.byteLength;
            try {
                assertTelegramFileSizeWithinLimit(downloadedBytes, maxFileSizeBytes);
                callback(undefined, chunk);
            }
            catch (error) {
                callback(error instanceof Error ? error : new Error(String(error)));
            }
        },
    });
}
async function writeTelegramDownloadResponse(response, targetPath, maxFileSizeBytes) {
    if (!response.body) {
        const buffer = Buffer.from(await response.arrayBuffer());
        assertTelegramFileSizeWithinLimit(buffer.byteLength, maxFileSizeBytes);
        await writeFile(targetPath, buffer, { mode: 0o600 });
        return;
    }
    await pipeline(Readable.from(response.body, { objectMode: false }), createTelegramDownloadLimitTransform(maxFileSizeBytes), createWriteStream(targetPath, { mode: 0o600 }));
}
async function removeTelegramPartialDownload(path) {
    try {
        await unlink(path);
    }
    catch {
        // ignore
    }
}
async function parseTelegramApiResponse(response, method) {
    let data;
    try {
        if (typeof response.text === "function") {
            const text = await response.text();
            data = text
                ? JSON.parse(text)
                : undefined;
        }
        else {
            data = (await response.json());
        }
    }
    catch {
        data = undefined;
    }
    if (response.ok === false) {
        const status = `HTTP ${response.status}`;
        const description = data?.description ? `: ${data.description}` : "";
        const retryAfterHeader = response.headers?.get("retry-after");
        const retryAfterSeconds = data?.parameters?.retry_after ??
            (retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined);
        throw new TelegramApiHttpError(`Telegram API ${method} failed: ${status}${description}`, response.status, Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined, data?.ok === false && data.error_code === response.status &&
            [400, 401, 403, 404, 429].includes(response.status) ? method : undefined);
    }
    if (!data) {
        throw new TelegramApiMalformedSuccessError(method, "returned invalid JSON");
    }
    return data;
}
function unwrapTelegramApiResult(method, data) {
    if (data.ok && data.result === undefined) {
        throw new TelegramApiMalformedSuccessError(method, "returned no result");
    }
    if (!data.ok) {
        throw new Error(data.description || `Telegram API ${method} failed`);
    }
    return data.result;
}
function getTelegramNetworkFamilyPolicy(env = process.env) {
    const value = env[TELEGRAM_NETWORK_FAMILY_ENV]?.trim().toLowerCase();
    if (TELEGRAM_NETWORK_FAMILY_VALUES.has(value)) {
        return value;
    }
    return "ipv4-fallback";
}
function getTelegramNetworkFamily(policy) {
    if (policy === "ipv4")
        return 4;
    if (policy === "ipv6")
        return 6;
    return undefined;
}
function isTelegramTransportFailure(error) {
    if (!(error instanceof Error))
        return false;
    if (error.name === "AbortError")
        return false;
    if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
        return true;
    }
    if (error instanceof AggregateError)
        return true;
    const code = getErrorCode(error);
    if (code === "ECONNREFUSED" ||
        code === "ETIMEDOUT" ||
        code === "ENETUNREACH" ||
        code === "EHOSTUNREACH" ||
        code === "ECONNRESET" ||
        code === "EAI_AGAIN") {
        return true;
    }
    return isTelegramTransportFailure(error.cause);
}
function getTelegramRequestBodyBuffer(body) {
    if (body === undefined || body === null)
        return undefined;
    if (typeof body === "string")
        return Buffer.from(body);
    if (body instanceof Uint8Array)
        return Buffer.from(body);
    throw new Error("Unsupported Telegram HTTPS request body");
}
async function buildTelegramMultipartBody(fields, fileField, fileBlob, fileName) {
    const boundary = `pi-telegram-${randomUUID()}`;
    const chunks = [];
    for (const [key, value] of Object.entries(fields)) {
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
    }
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${fileBlob.type || "application/octet-stream"}\r\n\r\n`), Buffer.from(await fileBlob.arrayBuffer()), Buffer.from(`\r\n--${boundary}--\r\n`));
    return {
        body: Buffer.concat(chunks),
        contentType: `multipart/form-data; boundary=${boundary}`,
    };
}
async function telegramHttpsFetch(input, init, family) {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const body = getTelegramRequestBodyBuffer(init.body);
    const headers = new Headers(init.headers);
    if (body && !headers.has("content-length")) {
        headers.set("content-length", String(body.byteLength));
    }
    return new Promise((resolve, reject) => {
        const req = requestHttps(url, {
            method: init.method ?? "GET",
            family,
            headers: Object.fromEntries(headers.entries()),
        }, (res) => {
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
                if (Array.isArray(value))
                    responseHeaders.set(key, value.join(", "));
                else if (value !== undefined)
                    responseHeaders.set(key, String(value));
            }
            resolve(new Response(Readable.toWeb(res), {
                status: res.statusCode ?? 200,
                statusText: res.statusMessage,
                headers: responseHeaders,
            }));
        });
        req.on("error", reject);
        if (init.signal) {
            if (init.signal.aborted)
                req.destroy(new DOMException("Aborted", "AbortError"));
            else {
                init.signal.addEventListener("abort", () => req.destroy(new DOMException("Aborted", "AbortError")), { once: true });
            }
        }
        req.end(body);
    });
}
let telegramHttpsFetchForTesting;
export function setTelegramApiHttpsFetchForTesting(fetchImpl) {
    const previous = telegramHttpsFetchForTesting;
    telegramHttpsFetchForTesting = fetchImpl;
    return () => {
        telegramHttpsFetchForTesting = previous;
    };
}
async function telegramFetch(input, init = {}, family) {
    if (!family)
        return fetch(input, init);
    return (telegramHttpsFetchForTesting ?? telegramHttpsFetch)(input, init, family);
}
async function callTelegramTransportRequest(request, allowFallback = true) {
    const policy = getTelegramNetworkFamilyPolicy();
    if (policy === "auto")
        return request();
    const family = getTelegramNetworkFamily(policy);
    if (family)
        return request(family);
    if (!allowFallback)
        return request();
    try {
        return await request();
    }
    catch (error) {
        if (!isTelegramTransportFailure(error))
            throw error;
        return request(4);
    }
}
function getErrorCode(error) {
    const maybeCode = error.code;
    return typeof maybeCode === "string" ? maybeCode : undefined;
}
function getErrorAddress(error) {
    const maybeAddress = error.address;
    return typeof maybeAddress === "string" ? maybeAddress : undefined;
}
function getErrorPort(error) {
    const maybePort = error.port;
    return typeof maybePort === "number" ? maybePort : undefined;
}
function getErrorFamily(error) {
    const maybeFamily = error.family;
    if (typeof maybeFamily === "number" || typeof maybeFamily === "string") {
        return maybeFamily;
    }
    return undefined;
}
function describeTelegramErrorSummary(error) {
    return {
        name: error.name,
        message: error.message,
        ...(getErrorCode(error) ? { code: getErrorCode(error) } : {}),
    };
}
function describeTelegramTransportAttempt(error) {
    return {
        name: error.name,
        ...(getErrorCode(error) ? { code: getErrorCode(error) } : {}),
        ...(getErrorAddress(error) ? { address: getErrorAddress(error) } : {}),
        ...(getErrorPort(error) ? { port: getErrorPort(error) } : {}),
        ...(getErrorFamily(error) ? { family: getErrorFamily(error) } : {}),
    };
}
function describeTelegramTransportError(error) {
    if (!isTelegramTransportFailure(error) || !(error instanceof Error)) {
        return undefined;
    }
    const cause = error.cause instanceof Error ? error.cause : undefined;
    const aggregate = error instanceof AggregateError
        ? error
        : cause instanceof AggregateError
            ? cause
            : undefined;
    const attempts = aggregate?.errors
        .filter((attempt) => attempt instanceof Error)
        .map(describeTelegramTransportAttempt);
    return {
        error: describeTelegramErrorSummary(error),
        ...(cause ? { cause: describeTelegramErrorSummary(cause) } : {}),
        ...(attempts && attempts.length > 0 ? { attempts } : {}),
    };
}
function withTelegramTransportDiagnostics(error, details) {
    const transport = describeTelegramTransportError(error);
    return transport ? { ...details, transport } : details;
}
async function callTelegramWithRetry(method, request, options) {
    const retrySafe = options?.retrySafety === "safe" ||
        (options?.retrySafety !== "non-idempotent" &&
            isTelegramApiMethodRetrySafe(method));
    const maxAttempts = Math.max(1, options?.maxAttempts ?? 3);
    const retryBaseDelayMs = options?.retryBaseDelayMs ?? 500;
    const waitBeforeRetry = async (error, attempt) => {
        const ms = getTelegramRetryDelayMs(error, attempt, retryBaseDelayMs);
        if (!options?.signal?.aborted &&
            error instanceof TelegramApiHttpError &&
            error.status === 429) {
            options?.onRetryWait?.({
                method,
                delayMs: ms,
                attempt,
                ...(error.retryAfterSeconds !== undefined
                    ? { retryAfterSeconds: error.retryAfterSeconds }
                    : {}),
            });
        }
        if (options?.sleep)
            await options.sleep(ms);
        else
            await sleepTelegramRetry(ms, options?.signal);
        throwIfTelegramApiCallAborted(options?.signal);
    };
    for (let attempt = 0;; attempt += 1) {
        throwIfTelegramApiCallAborted(options?.signal);
        try {
            return unwrapTelegramApiResult(method, await parseTelegramApiResponse(await callTelegramTransportRequest(request, retrySafe), method));
        }
        catch (error) {
            const retryable = isRetryableTelegramApiError(error) &&
                !(options?.retryRateLimit === false &&
                    error instanceof TelegramApiHttpError &&
                    error.status === 429);
            if (!retrySafe) {
                if (error instanceof TelegramApiHttpError && error.status === 429) {
                    if (attempt >= maxAttempts - 1)
                        throw error;
                    await waitBeforeRetry(error, attempt);
                    continue;
                }
                if (error instanceof TelegramApiMalformedSuccessError ||
                    isTelegramTransportFailure(error) ||
                    (error instanceof TelegramApiHttpError &&
                        error.status !== undefined &&
                        error.status >= 500)) {
                    throw new TelegramApiCommitUnknownError(method, error);
                }
                throw error;
            }
            if (attempt >= maxAttempts - 1 || !retryable)
                throw error;
            await waitBeforeRetry(error, attempt);
        }
    }
}
export async function cleanupTelegramTempFiles(tempDir, maxAgeMs, now = Date.now()) {
    let removedCount = 0;
    let entries;
    try {
        entries = await readdir(tempDir, { withFileTypes: true });
    }
    catch {
        return 0;
    }
    for (const entry of entries) {
        if (!entry.isFile() || !TELEGRAM_TEMP_SCRATCH_FILE_PATTERN.test(entry.name)) {
            continue;
        }
        const path = join(tempDir, entry.name);
        try {
            const stats = await stat(path);
            if (now - stats.mtimeMs <= maxAgeMs)
                continue;
            await unlink(path);
            removedCount += 1;
        }
        catch {
            // ignore
        }
    }
    return removedCount;
}
export async function prepareTelegramTempDir(tempDir, maxAgeMs) {
    await mkdir(tempDir, { recursive: true, mode: 0o700 });
    return cleanupTelegramTempFiles(tempDir, maxAgeMs);
}
function assertTelegramBotTokenConfigured(botToken) {
    if (!botToken)
        throw new Error("Telegram bot token is not configured");
    return botToken;
}
export async function callTelegram(botToken, method, body, options) {
    const configuredBotToken = assertTelegramBotTokenConfigured(botToken);
    try {
        return await callTelegramWithRetry(method, async (family) => telegramFetch(`${TELEGRAM_API_BASE}/bot${configuredBotToken}/${method}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: options?.signal,
        }, family), options);
    }
    catch (error) {
        attachTelegramApiRequestTarget(error, body);
        throw error;
    }
}
export async function fetchTelegramBotIdentity(botToken, fetchImpl = fetch) {
    const url = `${TELEGRAM_API_BASE}/bot${botToken}/getMe`;
    const response = await callTelegramTransportRequest((family) => fetchImpl === fetch ? telegramFetch(url, {}, family) : fetchImpl(url));
    return response.json();
}
/**
 * Low-level helper to send a multipart/form-data request to the Telegram Bot API.
 * This is the core implementation used for uploading voice messages, photos,
 * documents, animations, etc. It handles FormData construction, retry logic
 * (via callTelegramWithRetry), and error recording under the "multipart" category.
 */
export async function callTelegramMultipart(botToken, method, fields, fileField, filePath, fileName, options) {
    const configuredBotToken = assertTelegramBotTokenConfigured(botToken);
    const fileBlob = await openAsBlob(filePath);
    try {
        return await callTelegramWithRetry(method, async (family) => {
            if (family) {
                const multipart = await buildTelegramMultipartBody(fields, fileField, fileBlob, fileName);
                return telegramFetch(`${TELEGRAM_API_BASE}/bot${configuredBotToken}/${method}`, {
                    method: "POST",
                    headers: { "content-type": multipart.contentType },
                    body: multipart.body,
                    signal: options?.signal,
                }, family);
            }
            const form = new FormData();
            for (const [key, value] of Object.entries(fields)) {
                form.set(key, value);
            }
            form.set(fileField, fileBlob, fileName);
            return telegramFetch(`${TELEGRAM_API_BASE}/bot${configuredBotToken}/${method}`, {
                method: "POST",
                body: form,
                signal: options?.signal,
            });
        }, options);
    }
    catch (error) {
        attachTelegramApiRequestTarget(error, fields);
        throw error;
    }
}
export async function downloadTelegramFile(botToken, fileId, suggestedName, tempDir, options) {
    const configuredBotToken = assertTelegramBotTokenConfigured(botToken);
    const file = await callTelegram(configuredBotToken, "getFile", { file_id: fileId }, { signal: options?.signal });
    assertTelegramFileSizeWithinLimit(file.file_size, options?.maxFileSizeBytes);
    await mkdir(tempDir, { recursive: true, mode: 0o700 });
    const targetPath = join(tempDir, `${randomUUID()}-${sanitizeFileName(suggestedName)}`);
    const response = await callTelegramTransportRequest((family) => telegramFetch(`${TELEGRAM_API_BASE}/file/bot${configuredBotToken}/${file.file_path}`, { signal: options?.signal }, family));
    if (!response.ok) {
        throw new Error(`Failed to download Telegram file: ${response.status}`);
    }
    const contentLength = response.headers?.get("content-length");
    assertTelegramFileSizeWithinLimit(contentLength ? Number.parseInt(contentLength, 10) : undefined, options?.maxFileSizeBytes);
    try {
        await writeTelegramDownloadResponse(response, targetPath, options?.maxFileSizeBytes);
    }
    catch (error) {
        await removeTelegramPartialDownload(targetPath);
        throw error;
    }
    return targetPath;
}
export async function answerTelegramCallbackQuery(botToken, callbackQueryId, text, options = {}) {
    try {
        await callTelegram(botToken, "answerCallbackQuery", text
            ? { callback_query_id: callbackQueryId, text }
            : { callback_query_id: callbackQueryId });
    }
    catch (error) {
        options.recordRuntimeEvent?.("api", error, withTelegramTransportDiagnostics(error, {
            method: "answerCallbackQuery",
        }));
    }
}
export async function deleteTelegramMessage(botToken, chatId, messageId) {
    try {
        await callTelegram(botToken, "deleteMessage", {
            chat_id: chatId,
            message_id: messageId,
        });
    }
    catch {
        // ignore
    }
}
export function createTelegramChatActionSender(sendChatAction, action) {
    return (chatId, options) => sendChatAction(chatId, action, options);
}
export function createTelegramNativeMarkdownDraftSender(deps) {
    return (chatId, draftId, text, options) => {
        if (text === undefined) {
            return deps.sendMessageDraft(chatId, draftId, text, options);
        }
        return deps.sendRichMessageDraft({
            chat_id: chatId,
            draft_id: draftId,
            rich_message: { markdown: text },
            ...(options?.message_thread_id !== undefined
                ? { message_thread_id: options.message_thread_id }
                : {}),
        });
    };
}
export function createTelegramAssistantDraftSender(deps) {
    const sendNativeDraft = createTelegramNativeMarkdownDraftSender(deps);
    return (chatId, draftId, text, options) => {
        if (text === undefined || deps.getAssistantRenderingMode() === "rich") {
            return sendNativeDraft(chatId, draftId, text, options);
        }
        return deps.sendMessageDraft(chatId, draftId, deps.renderMarkdownToHtmlDraft(text), {
            ...options,
            parse_mode: "HTML",
        });
    };
}
export function buildTelegramAnswerGuestQueryBody(guestQueryId, text, options) {
    const body = { guest_query_id: guestQueryId };
    if (options?.result) {
        body.result = options.result;
    }
    else if (text !== undefined || options?.richMessage) {
        const inputContent = options?.richMessage
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
    return body;
}
export function createDefaultTelegramBridgeApiRuntime(deps) {
    const client = createTelegramApiClient(deps.getBotToken, {
        recordRuntimeEvent: deps.recordRuntimeEvent,
    });
    const admittedClient = deps.workspaceAdmission
        ? createTelegramApiWorkspaceAdmissionClient(client, deps.workspaceAdmission, {
            onReleaseError(error, method) {
                deps.recordRuntimeEvent("api", error, {
                    phase: "workspace-admission-release",
                    method,
                });
            },
        })
        : client;
    const runtime = createTelegramBridgeApiRuntime({
        client: deps.targetActivity
            ? createTelegramApiTargetTrackingClient(admittedClient, deps.targetActivity)
            : admittedClient,
        tempDir: getTelegramApiTempDir(),
        maxFileSizeBytes: TELEGRAM_INBOUND_FILE_MAX_BYTES,
        tempFileMaxAgeMs: TELEGRAM_TEMP_FILE_MAX_AGE_MS,
        recordRuntimeEvent: deps.recordRuntimeEvent,
        captureRequestErrorHandler: deps.captureRequestErrorHandler,
    });
    return {
        ...runtime,
        async deleteWorkspaceThread(authorize) {
            // The exclusive deletion permit replaces ordinary target admission.
            const target = authorize();
            const deleted = await client.call("deleteForumTopic", {
                chat_id: target.chatId, message_thread_id: target.threadId,
            }, { maxAttempts: 1, retrySafety: "non-idempotent" });
            if (deleted !== true)
                throw new Error("Telegram Workspace Thread deletion was not confirmed.");
        },
    };
}
export function createTelegramBridgeApiRuntime(deps) {
    const recoverRequestError = async (handler, error) => {
        try {
            await handler?.(error);
        }
        catch (recoveryError) {
            deps.recordRuntimeEvent("api", recoveryError, { phase: "stale-target-recovery" });
        }
    };
    const now = deps.now ?? Date.now;
    const chatActionMinIntervalMs = Math.max(0, deps.chatActionMinIntervalMs ?? 2_000);
    const chatActionMaxGates = Math.max(1, deps.chatActionMaxGates ?? 256);
    const chatActionGates = new Map();
    const chatActionChatGates = new Map();
    const getChatActionKeys = (method, body) => {
        if (method !== "sendChatAction")
            return undefined;
        const chatId = body.chat_id;
        const action = body.action;
        if ((typeof chatId !== "number" && typeof chatId !== "string") ||
            typeof action !== "string") {
            return undefined;
        }
        const chat = String(chatId);
        const threadId = body.message_thread_id;
        return {
            action: `${chat}:${typeof threadId === "number" || typeof threadId === "string"
                ? String(threadId)
                : "all"}:${action}`,
            chat,
        };
    };
    const callRecorded = async (method, body, options) => {
        const recoverError = deps.captureRequestErrorHandler?.(body);
        const chatActionKeys = getChatActionKeys(method, body);
        if (chatActionKeys) {
            const nowMs = now();
            for (const [key, candidate] of chatActionGates) {
                if (!candidate.inFlight && nowMs >= candidate.notBeforeMs) {
                    chatActionGates.delete(key);
                }
            }
            for (const [key, candidate] of chatActionChatGates) {
                if (!candidate.inFlight && nowMs >= candidate.notBeforeMs) {
                    chatActionChatGates.delete(key);
                }
            }
            let gate = chatActionGates.get(chatActionKeys.action);
            if (!gate) {
                if (chatActionGates.size >= chatActionMaxGates)
                    return true;
                gate = { notBeforeMs: 0 };
                chatActionGates.set(chatActionKeys.action, gate);
            }
            let chatGate = chatActionChatGates.get(chatActionKeys.chat);
            if (!chatGate) {
                if (chatActionChatGates.size >= chatActionMaxGates) {
                    return true;
                }
                chatGate = { notBeforeMs: 0 };
                chatActionChatGates.set(chatActionKeys.chat, chatGate);
            }
            if (gate.inFlight)
                return (await gate.inFlight);
            if (chatGate.inFlight)
                return true;
            if (nowMs < gate.notBeforeMs || nowMs < chatGate.notBeforeMs) {
                return true;
            }
            let request;
            request = Promise.resolve()
                .then(() => deps.client.call(method, body, {
                ...options,
                retryRateLimit: false,
            }))
                .then((result) => {
                gate.notBeforeMs = now() + chatActionMinIntervalMs;
                return result;
            })
                .catch(async (error) => {
                await recoverRequestError(recoverError, error);
                if (error instanceof TelegramApiHttpError && error.status === 429) {
                    const retryAfterMs = Math.max(chatActionMinIntervalMs, (error.retryAfterSeconds ?? 0) * 1_000);
                    const notBeforeMs = now() + retryAfterMs;
                    gate.notBeforeMs = notBeforeMs;
                    chatGate.notBeforeMs = Math.max(chatGate.notBeforeMs, notBeforeMs);
                    deps.recordRuntimeEvent("api", error, withTelegramTransportDiagnostics(error, {
                        method,
                        rateLimited: true,
                        retryAfterMs,
                    }));
                    return true;
                }
                deps.recordRuntimeEvent("api", error, withTelegramTransportDiagnostics(error, { method }));
                throw error;
            })
                .finally(() => {
                if (gate.inFlight === request)
                    gate.inFlight = undefined;
                if (chatGate.inFlight === request)
                    chatGate.inFlight = undefined;
            });
            gate.inFlight = request;
            chatGate.inFlight = request;
            return request;
        }
        try {
            return await deps.client.call(method, body, options);
        }
        catch (error) {
            await recoverRequestError(recoverError, error);
            if (method === "deleteMessage" && error instanceof TelegramApiHttpError &&
                error.status === 400 && error.message ===
                "Telegram API deleteMessage failed: HTTP 400: Bad Request: message to delete not found") {
                return true;
            }
            deps.recordRuntimeEvent("api", error, withTelegramTransportDiagnostics(error, { method }));
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
        callMultipart: async (method, fields, fileField, filePath, fileName, options) => {
            const recoverError = deps.captureRequestErrorHandler?.(fields);
            try {
                return await deps.client.callMultipart(method, fields, fileField, filePath, fileName, options);
            }
            catch (error) {
                await recoverRequestError(recoverError, error);
                deps.recordRuntimeEvent("multipart", error, withTelegramTransportDiagnostics(error, { method, fileName }));
                throw error;
            }
        },
        /**
         * Downloads a file from the Telegram servers into the local temp directory.
         * Used for inbound voice messages, photos, documents, etc.
         */
        downloadFile: async (fileId, suggestedName) => {
            try {
                return await deps.client.downloadFile(fileId, suggestedName, deps.tempDir, {
                    maxFileSizeBytes: deps.maxFileSizeBytes,
                });
            }
            catch (error) {
                deps.recordRuntimeEvent("download", error, withTelegramTransportDiagnostics(error, { suggestedName }));
                throw error;
            }
        },
        deleteWebhook: (signal) => callRecorded("deleteWebhook", { drop_pending_updates: false }, { signal }),
        getUpdates: (body, signal) => callRecorded("getUpdates", body, { signal }),
        setMyCommands: (commands) => callRecorded("setMyCommands", { commands }),
        sendChatAction: (chatId, action, options) => callRecorded("sendChatAction", {
            chat_id: chatId,
            action,
            ...(options?.message_thread_id !== undefined
                ? { message_thread_id: options.message_thread_id }
                : {}),
        }),
        sendTypingAction: createTelegramChatActionSender((chatId, action, options) => callRecorded("sendChatAction", {
            chat_id: chatId,
            action,
            ...(options?.message_thread_id !== undefined
                ? { message_thread_id: options.message_thread_id }
                : {}),
        }), "typing"),
        sendRecordVoiceAction: createTelegramChatActionSender((chatId, action, options) => callRecorded("sendChatAction", {
            chat_id: chatId,
            action,
            ...(options?.message_thread_id !== undefined
                ? { message_thread_id: options.message_thread_id }
                : {}),
        }), "record_voice"),
        sendMessageDraft: (chatId, draftId, text, options) => {
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
            if (options?.message_thread_id !== undefined)
                body.message_thread_id = options.message_thread_id;
            return callRecorded("sendMessageDraft", body);
        },
        sendMessage: (body) => callRecorded("sendMessage", body),
        sendRichMessage: (body) => callRecorded("sendRichMessage", body),
        sendRichMessageDraft: (body) => callRecorded("sendRichMessageDraft", body),
        editMessageText: async (body) => {
            const recoverError = deps.captureRequestErrorHandler?.(body);
            try {
                await deps.client.call("editMessageText", body);
                return "edited";
            }
            catch (error) {
                if (isTelegramMessageNotModifiedError(error))
                    return "unchanged";
                await recoverRequestError(recoverError, error);
                deps.recordRuntimeEvent("api", error, withTelegramTransportDiagnostics(error, {
                    method: "editMessageText",
                }));
                throw error;
            }
        },
        editMessageReplyMarkup: async (chatId, messageId, replyMarkup) => {
            await callRecorded("editMessageReplyMarkup", {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: replyMarkup,
            });
        },
        answerCallbackQuery: async (callbackQueryId, text) => {
            try {
                await deps.client.answerCallbackQuery(callbackQueryId, text);
            }
            catch (error) {
                deps.recordRuntimeEvent("api", error, withTelegramTransportDiagnostics(error, {
                    method: "answerCallbackQuery",
                }));
            }
        },
        answerGuestQuery: (guestQueryId, text, options) => callRecorded("answerGuestQuery", buildTelegramAnswerGuestQueryBody(guestQueryId, text, options)),
        answerGuestQueryForInlineMessage: async (guestQueryId, text, options) => {
            const sent = await callRecorded("answerGuestQuery", buildTelegramAnswerGuestQueryBody(guestQueryId, text, options));
            return sent?.inline_message_id;
        },
        editGuestInlineMessage: async (inlineMessageId, content) => {
            await callRecorded("editMessageText", {
                inline_message_id: inlineMessageId,
                ...(content.richMessage
                    ? { rich_message: content.richMessage }
                    : { text: content.text }),
                ...(content.parseMode ? { parse_mode: content.parseMode } : {}),
            });
        },
        prepareTempDir: () => prepareTelegramTempDir(deps.tempDir, deps.tempFileMaxAgeMs),
        deleteMessage: (chatId, messageId) => callRecorded("deleteMessage", {
            chat_id: chatId,
            message_id: messageId,
        }).then(() => { }),
    };
}
/**
 * Creates a low-level Telegram Bot API client.
 * This is the main entry point for all direct Bot API communication
 * (both JSON calls and multipart uploads for files/voice).
 */
export function createTelegramApiClient(getBotToken, options = {}) {
    const now = options.now ?? Date.now;
    const recordRuntimeEvent = options.recordRuntimeEvent;
    const draftRetryNotBeforeByTarget = new Map();
    return {
        call: async (method, body, options) => {
            const token = getBotToken();
            // Cooldown keys retain only the public bot-id prefix, not the credential.
            const botId = token?.match(/^(\d+):/)?.[1];
            const isDraft = method === "sendMessageDraft" || method === "sendRichMessageDraft";
            const draftKey = isDraft && botId
                ? `${botId}:${String(body.chat_id)}:${String(body.message_thread_id ?? "all")}`
                : undefined;
            if (draftKey) {
                const nowMs = now();
                for (const [key, deadline] of draftRetryNotBeforeByTarget) {
                    if (nowMs >= deadline)
                        draftRetryNotBeforeByTarget.delete(key);
                }
                if (draftRetryNotBeforeByTarget.has(draftKey))
                    return false;
            }
            try {
                // A draft is a replaceable snapshot, not a body to replay after backoff.
                const retryWaitOptions = recordRuntimeEvent
                    ? {
                        onRetryWait: (wait) => {
                            recordRuntimeEvent("api", new Error(`Telegram API rate limit: waiting ${wait.delayMs} ms before retrying ${wait.method}`), {
                                phase: "retry-wait",
                                method: wait.method,
                                waitMs: wait.delayMs,
                                attempt: wait.attempt,
                                ...(wait.retryAfterSeconds !== undefined
                                    ? { retryAfterSeconds: wait.retryAfterSeconds }
                                    : {}),
                            });
                        },
                    }
                    : {};
                return await callTelegram(token, method, body, {
                    ...(isDraft ? { ...options, maxAttempts: 1 } : options),
                    ...retryWaitOptions,
                });
            }
            catch (error) {
                if (draftKey && isRetryableTelegramApiError(error)) {
                    draftRetryNotBeforeByTarget.set(draftKey, Math.max(draftRetryNotBeforeByTarget.get(draftKey) ?? 0, now() + getTelegramRetryDelayMs(error, 0, options?.retryBaseDelayMs ?? 500)));
                }
                throw error;
            }
        },
        callMultipart: async (method, fields, fileField, filePath, fileName, options) => {
            return callTelegramMultipart(getBotToken(), method, fields, fileField, filePath, fileName, options);
        },
        downloadFile: async (fileId, suggestedName, tempDir, options) => {
            return downloadTelegramFile(getBotToken(), fileId, suggestedName, tempDir, options);
        },
        answerCallbackQuery: async (callbackQueryId, text) => {
            await answerTelegramCallbackQuery(getBotToken(), callbackQueryId, text, options);
        },
    };
}
