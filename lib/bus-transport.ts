/**
 * Telegram bus local transport boundary
 * Zones: multi-instance bus, IPC transport, Windows named pipes, Unix sockets
 * Owns endpoint derivation, transport-kind detection, retry/error classification, and small timing policy.
 */

import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";

export type TelegramBusTransportKind = "pipe" | "socket";

export type TelegramBusTransportEventRecorder = (
  phase: string,
  details: Record<string, unknown>,
) => void;

export type TelegramBusTransportEndpointDiagnostics = Record<
  string,
  unknown
> & {
  endpoint: string;
  transport: TelegramBusTransportKind;
};

export interface TelegramBusTransportRetryPolicy {
  attempts: number;
  delayMs: number;
}

export interface TelegramBusTransportRetryPolicyOverrides {
  attempts?: number;
  delayMs?: number;
}

export type TelegramBusTransportOperation = "registration" | "operation";

export const TELEGRAM_BUS_REGISTRATION_RETRY: TelegramBusTransportRetryPolicy = {
  attempts: 10,
  delayMs: 150,
};

export const TELEGRAM_BUS_OPERATION_RETRY: TelegramBusTransportRetryPolicy = {
  attempts: 3,
  delayMs: 100,
};

export const TELEGRAM_BUS_PIPE_REGISTRATION_RETRY =
  TELEGRAM_BUS_REGISTRATION_RETRY;

export const TELEGRAM_BUS_PIPE_OPERATION_RETRY = TELEGRAM_BUS_OPERATION_RETRY;

export function getTelegramBusPipePath(input: {
  agentDir: string;
  scope: string;
}): string {
  const digest = createHash("sha256")
    .update(resolve(input.agentDir))
    .digest("base64url")
    .slice(0, 16);
  const scope = input.scope.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
  return `\\\\.\\pipe\\pi-telegram-${digest}-${scope}`;
}

export function isTelegramBusPipePath(endpoint: string): boolean {
  return /^\\\\[.?]\\pipe\\/i.test(endpoint);
}

export function getTelegramBusTransportKind(
  endpoint: string,
): TelegramBusTransportKind {
  return isTelegramBusPipePath(endpoint) ? "pipe" : "socket";
}

export function getTelegramBusEndpointDiagnostics(
  endpoint: string,
): TelegramBusTransportEndpointDiagnostics {
  return {
    endpoint,
    transport: getTelegramBusTransportKind(endpoint),
  };
}

export function getTelegramBusTransportRetryPolicy(input: {
  endpoint: string;
  operation: TelegramBusTransportOperation;
  overrides?: TelegramBusTransportRetryPolicyOverrides;
}): TelegramBusTransportRetryPolicy | undefined {
  const base =
    input.operation === "registration"
      ? TELEGRAM_BUS_REGISTRATION_RETRY
      : isTelegramBusPipePath(input.endpoint)
        ? TELEGRAM_BUS_OPERATION_RETRY
        : undefined;
  if (!base && !input.overrides) return undefined;
  return {
    attempts: Math.max(1, input.overrides?.attempts ?? base?.attempts ?? 1),
    delayMs: Math.max(0, input.overrides?.delayMs ?? base?.delayMs ?? 0),
  };
}

export function getTelegramBusLeaderEndpoint(input: {
  agentDir: string;
  platform: NodeJS.Platform | string;
}): string {
  return input.platform === "win32"
    ? getTelegramBusPipePath({ agentDir: input.agentDir, scope: "bus" })
    : join(input.agentDir, "tmp", "telegram", "bus.sock");
}

export function getTelegramBusFollowerEndpoint(input: {
  agentDir: string;
  platform: NodeJS.Platform | string;
  instanceId: string;
}): string {
  return input.platform === "win32"
    ? getTelegramBusPipePath({
        agentDir: input.agentDir,
        scope: `follower-${input.instanceId}`,
      })
    : join(
        input.agentDir,
        "tmp",
        "telegram",
        "followers",
        `${input.instanceId.replace(/[^a-zA-Z0-9_.-]/g, "_")}.sock`,
      );
}

export interface TelegramBusTransportErrorInfo {
  message: string;
  code?: string;
  syscall?: string;
  kind: "connect" | "timeout" | "auth" | "protocol" | "unknown";
  retryable: boolean;
}

export function classifyTelegramBusTransportError(
  error: unknown,
): TelegramBusTransportErrorInfo {
  const message = error instanceof Error ? error.message : String(error);
  const maybeNodeError = error as NodeJS.ErrnoException;
  const code =
    typeof maybeNodeError?.code === "string" ? maybeNodeError.code : undefined;
  const syscall =
    typeof maybeNodeError?.syscall === "string"
      ? maybeNodeError.syscall
      : undefined;
  const timeout = code === "ETIMEDOUT" || /timed out/i.test(message);
  const retryable =
    code === "ENOENT" ||
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

export function isRetryableTelegramBusTransportError(error: unknown): boolean {
  return classifyTelegramBusTransportError(error).retryable;
}

export function createTelegramBusTransportTimeoutError(
  message: string,
): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = "ETIMEDOUT";
  return error;
}

export function delayTelegramBusTransportRetry(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export interface TelegramBusTransportProbeResult
  extends TelegramBusTransportEndpointDiagnostics {
  reachable: boolean;
  error?: TelegramBusTransportErrorInfo;
}

export function probeTelegramBusEndpoint(input: {
  endpoint: string;
  timeoutMs?: number;
}): Promise<TelegramBusTransportProbeResult> {
  const timeoutMs = input.timeoutMs ?? 250;
  const diagnostics = getTelegramBusEndpointDiagnostics(input.endpoint);
  return new Promise((resolve) => {
    const socket = createConnection(input.endpoint);
    let settled = false;
    const settle = (result: TelegramBusTransportProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(result);
    };
    const timeout = setTimeout(() => {
      settle({
        ...diagnostics,
        reachable: false,
        error: classifyTelegramBusTransportError(
          createTelegramBusTransportTimeoutError(
            "Timed out probing Telegram bus endpoint",
          ),
        ),
      });
    }, timeoutMs);
    timeout.unref?.();
    socket.once("connect", () => settle({ ...diagnostics, reachable: true }));
    socket.once("error", (error) =>
      settle({
        ...diagnostics,
        reachable: false,
        error: classifyTelegramBusTransportError(error),
      }),
    );
  });
}
