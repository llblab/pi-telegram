/**
 * Telegram outbound voice delivery helpers
 * Zones: telegram outbound, voice delivery
 * Owns native Telegram voice upload orchestration across configured voice handlers, programmatic outbound voice handlers, and registered synthesis providers
 */
import { type TelegramTarget } from "./target.ts";
export interface TelegramVoiceReplyTurnView {
    chatId: number;
    replyToMessageId: number;
    target?: TelegramTarget;
}
export interface TelegramVoiceReplySenderDeps {
    execCommand: (command: string, args: string[], options?: {
        cwd?: string;
        timeout?: number;
        signal?: AbortSignal;
        stdin?: string;
        retry?: number;
    }) => Promise<{
        stdout: string;
        stderr: string;
        code: number;
        killed: boolean;
    }>;
    sendMultipart: (method: string, fields: Record<string, string>, fileField: string, filePath: string, fileName: string) => Promise<unknown>;
    sendChatAction?: (chatId: number, action: string) => Promise<unknown>;
    sendRecordVoiceAction?: (chatId: number) => Promise<unknown>;
    isDeliveryActive?: () => boolean;
    getHandlers?: () => unknown[] | undefined;
    cwd?: string;
    tempDir?: string;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export type TelegramOutboundProgrammaticVoiceHandler = (text: string, options?: {
    lang?: string;
    rate?: string;
}) => Promise<string>;
export interface TelegramVoiceReplySenderPorts<THandler = unknown> {
    findVoiceHandlers?: (handlers: unknown[] | undefined) => THandler[];
    generateVoiceFile?: (text: string, options: {
        lang?: string;
        rate?: string;
        handler: THandler;
        tempDir?: string;
        cwd?: string;
        execCommand: TelegramVoiceReplySenderDeps["execCommand"];
    }) => Promise<string | undefined>;
    getProgrammaticVoiceHandlers?: () => TelegramOutboundProgrammaticVoiceHandler[];
}
export declare function createTelegramVoiceReplySender<THandler = unknown>(deps: TelegramVoiceReplySenderDeps, ports?: TelegramVoiceReplySenderPorts<THandler>): (turn: TelegramVoiceReplyTurnView, text: string, options?: {
    lang?: string;
    rate?: string;
    replyToPrompt?: boolean;
    replyMarkup?: unknown;
}) => Promise<void>;
