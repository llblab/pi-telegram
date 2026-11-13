/**
 * Telegram bus local transport boundary
 * Zones: multi-instance bus, IPC transport, Windows named pipes, Unix sockets
 * Owns endpoint derivation, transport-kind detection, retry/error classification, and small timing policy.
 */
export type TelegramBusEndpointLayout = "consolidated";
export declare const TELEGRAM_BUS_MAX_DIRECT_UNIX_ENDPOINT_BYTES = 80;
export type TelegramBusTransportKind = "pipe" | "socket";
export type TelegramBusTransportEventRecorder = (phase: string, details: Record<string, unknown>) => void;
export type TelegramBusTransportEndpointDiagnostics = Record<string, unknown> & {
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
export declare const TELEGRAM_BUS_REGISTRATION_RETRY: TelegramBusTransportRetryPolicy;
export declare function getTelegramBusPipePath(input: {
    agentDir: string;
    scope: string;
}): string;
export declare function isTelegramBusPipePath(endpoint: string): boolean;
export declare function getTelegramBusTransportKind(endpoint: string): TelegramBusTransportKind;
export declare function getTelegramBusEndpointDiagnostics(endpoint: string): TelegramBusTransportEndpointDiagnostics;
export declare function getTelegramBusTransportRetryPolicy(input: {
    endpoint: string;
    operation: TelegramBusTransportOperation;
    overrides?: TelegramBusTransportRetryPolicyOverrides;
}): TelegramBusTransportRetryPolicy | undefined;
export declare function getTelegramBusLeaderEndpoint(input: {
    agentDir: string;
    platform: NodeJS.Platform | string;
    profileName?: string;
    layout?: TelegramBusEndpointLayout;
}): string;
export declare function getTelegramBusFollowerEndpoint(input: {
    agentDir: string;
    platform: NodeJS.Platform | string;
    instanceId: string;
    profileName?: string;
    layout?: TelegramBusEndpointLayout;
}): string;
export interface TelegramBusTransportErrorInfo {
    message: string;
    code?: string;
    syscall?: string;
    kind: "connect" | "timeout" | "auth" | "protocol" | "unknown";
    retryable: boolean;
}
export declare function classifyTelegramBusTransportError(error: unknown): TelegramBusTransportErrorInfo;
export declare function isRetryableTelegramBusTransportError(error: unknown): boolean;
export declare function createTelegramBusTransportTimeoutError(message: string): NodeJS.ErrnoException;
/** Local pre-issuance budget exhaustion; not an ACK refusal or a remote no-effect certificate. */
export declare class TelegramBusConnectionReadinessExpiredError extends Error {
    constructor();
}
export declare function delayTelegramBusTransportRetry(ms: number): Promise<void>;
export interface TelegramBusTransportProbeResult extends TelegramBusTransportEndpointDiagnostics {
    reachable: boolean;
    error?: TelegramBusTransportErrorInfo;
}
export declare function probeTelegramBusEndpoint(input: {
    endpoint: string;
    timeoutMs?: number;
}): Promise<TelegramBusTransportProbeResult>;
