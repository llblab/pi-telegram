/**
 * Telegram bus local transport boundary
 * Zones: multi-instance bus, IPC transport, Windows named pipes, Unix sockets
 * Owns endpoint derivation, transport-kind detection, retry/error classification, and small timing policy.
 */
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
export const TELEGRAM_BUS_REGISTRATION_RETRY = {
    attempts: 10,
    delayMs: 150,
};
export const TELEGRAM_BUS_OPERATION_RETRY = {
    attempts: 3,
    delayMs: 100,
};
export function getTelegramBusPipePath(input) {
    const digest = createHash("sha256")
        .update(resolve(input.agentDir))
        .digest("base64url")
        .slice(0, 16);
    const scope = input.scope.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
    return `\\\\.\\pipe\\pi-telegram-${digest}-${scope}`;
}
export function isTelegramBusPipePath(endpoint) {
    return /^\\\\[.?]\\pipe\\/i.test(endpoint);
}
export function getTelegramBusTransportKind(endpoint) {
    return isTelegramBusPipePath(endpoint) ? "pipe" : "socket";
}
export function getTelegramBusEndpointDiagnostics(endpoint) {
    return {
        endpoint,
        transport: getTelegramBusTransportKind(endpoint),
    };
}
export function getTelegramBusTransportRetryPolicy(input) {
    const base = input.operation === "registration"
        ? TELEGRAM_BUS_REGISTRATION_RETRY
        : isTelegramBusPipePath(input.endpoint)
            ? TELEGRAM_BUS_OPERATION_RETRY
            : undefined;
    if (!base && !input.overrides)
        return undefined;
    return {
        attempts: Math.max(1, input.overrides?.attempts ?? base?.attempts ?? 1),
        delayMs: Math.max(0, input.overrides?.delayMs ?? base?.delayMs ?? 0),
    };
}
function normalizeTelegramBusEndpointScope(value) {
    return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}
export function getTelegramBusLeaderEndpoint(input) {
    const profileScope = input.profileName
        ? normalizeTelegramBusEndpointScope(input.profileName)
        : undefined;
    return input.platform === "win32"
        ? getTelegramBusPipePath({
            agentDir: input.agentDir,
            scope: profileScope ? `bus-${profileScope}` : "bus",
        })
        : join(input.agentDir, "tmp", "telegram", profileScope ? `bus.${profileScope}.sock` : "bus.sock");
}
export function getTelegramBusFollowerEndpoint(input) {
    const instanceScope = normalizeTelegramBusEndpointScope(input.instanceId);
    const profileScope = input.profileName
        ? normalizeTelegramBusEndpointScope(input.profileName)
        : undefined;
    return input.platform === "win32"
        ? getTelegramBusPipePath({
            agentDir: input.agentDir,
            scope: profileScope
                ? `follower-${profileScope}-${instanceScope}`
                : `follower-${instanceScope}`,
        })
        : join(input.agentDir, "tmp", "telegram", "followers", ...(profileScope ? [profileScope] : []), `${instanceScope}.sock`);
}
export function classifyTelegramBusTransportError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const maybeNodeError = error;
    const code = typeof maybeNodeError?.code === "string" ? maybeNodeError.code : undefined;
    const syscall = typeof maybeNodeError?.syscall === "string"
        ? maybeNodeError.syscall
        : undefined;
    const timeout = code === "ETIMEDOUT" || /timed out/i.test(message);
    const retryable = code === "ENOENT" ||
        code === "ECONNREFUSED" ||
        code === "EPIPE" ||
        code === "ECONNRESET" ||
        code === "EBUSY" ||
        timeout;
    const kind = timeout
        ? "timeout"
        : code === "ENOENT" || code === "ECONNREFUSED"
            ? "connect"
            : "unknown";
    return { message, code, syscall, kind, retryable };
}
export function isRetryableTelegramBusTransportError(error) {
    return classifyTelegramBusTransportError(error).retryable;
}
export function createTelegramBusTransportTimeoutError(message) {
    const error = new Error(message);
    error.code = "ETIMEDOUT";
    return error;
}
export function delayTelegramBusTransportRetry(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
export function probeTelegramBusEndpoint(input) {
    const timeoutMs = input.timeoutMs ?? 250;
    const diagnostics = getTelegramBusEndpointDiagnostics(input.endpoint);
    return new Promise((resolve) => {
        const socket = createConnection(input.endpoint);
        let settled = false;
        const settle = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            socket.destroy();
            resolve(result);
        };
        const timeout = setTimeout(() => {
            settle({
                ...diagnostics,
                reachable: false,
                error: classifyTelegramBusTransportError(createTelegramBusTransportTimeoutError("Timed out probing Telegram bus endpoint")),
            });
        }, timeoutMs);
        socket.once("connect", () => settle({ ...diagnostics, reachable: true }));
        socket.once("error", (error) => settle({
            ...diagnostics,
            reachable: false,
            error: classifyTelegramBusTransportError(error),
        }));
    });
}
