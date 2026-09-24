/**
 * Telegram inbound handler pipeline
 * Zones: telegram inbound, command templates, prompt preparation
 * Owns MIME/type matching, command-template execution, fallback handling, and prompt injection before prompt enqueueing
 */
import { type CommandTemplateConfig, type CommandTemplateObjectConfig } from "./command-templates.ts";
type TelegramInboundCommandTemplateConfig = string | CommandTemplateObjectConfig;
export interface TelegramInboundHandlerConfig {
    match?: string | string[];
    mime?: string | string[];
    type?: string | string[];
    template?: string | TelegramInboundCommandTemplateConfig[];
    args?: string[];
    defaults?: Record<string, unknown>;
    timeout?: number | string;
}
export interface TelegramInboundHandlerFile {
    path: string;
    fileName?: string;
    mimeType?: string;
    kind?: string;
    isImage?: boolean;
}
export interface TelegramInboundHandlerOutput {
    file: TelegramInboundHandlerFile;
    output: string;
    handler: TelegramInboundHandlerConfig;
}
export interface TelegramInboundHandlerProcessResult<TFile extends TelegramInboundHandlerFile = TelegramInboundHandlerFile> {
    rawText: string;
    promptFiles: TFile[];
    handlerOutputs: string[];
    handledFiles: TelegramInboundHandlerOutput[];
}
export interface TelegramInboundHandlerExecOptions {
    cwd?: string;
    timeout?: number;
    signal?: AbortSignal;
    stdin?: string;
    retry?: number;
}
export interface TelegramInboundHandlerExecResult {
    stdout: string;
    stderr: string;
    code: number;
    killed: boolean;
}
export interface TelegramInboundHandlerRuntimeDeps<TContext> {
    getHandlers: () => TelegramInboundHandlerConfig[] | undefined;
    execCommand: (command: string, args: string[], options?: TelegramInboundHandlerExecOptions) => Promise<TelegramInboundHandlerExecResult>;
    getCwd: (ctx: TContext) => string;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface TelegramInboundHandlerRuntime<TContext> {
    process: <TFile extends TelegramInboundHandlerFile>(files: TFile[], rawText: string, ctx: TContext) => Promise<TelegramInboundHandlerProcessResult<TFile>>;
}
export type TelegramInboundProgrammaticHandlerResult = string | {
    text: string;
} | undefined;
export interface TelegramInboundProgrammaticHandlerInput {
    kind: string;
    text?: string;
    file?: TelegramInboundHandlerFile;
    mimeType?: string;
}
export type TelegramInboundProgrammaticHandler = (input: TelegramInboundProgrammaticHandlerInput, options?: {
    cwd?: string;
}) => Promise<TelegramInboundProgrammaticHandlerResult>;
export interface TelegramInboundHandlerRegistry {
    handlers: Map<string, TelegramInboundProgrammaticHandler[]>;
}
interface InboundHandlerInvocation {
    command: string;
    args: string[];
}
export declare function registerTelegramInboundHandler(kind: string, handler: TelegramInboundProgrammaticHandler): () => void;
export declare function getTelegramInboundProgrammaticHandlers(kind: string): TelegramInboundProgrammaticHandler[];
export declare function clearTelegramInboundHandlers(): void;
export declare function telegramInboundHandlerMatchesFile(handler: TelegramInboundHandlerConfig, file: TelegramInboundHandlerFile): boolean;
export declare function findTelegramInboundHandlers(handlers: TelegramInboundHandlerConfig[] | undefined, file: TelegramInboundHandlerFile): TelegramInboundHandlerConfig[];
export declare function buildTelegramInboundHandlerInvocation(handler: CommandTemplateConfig, file: TelegramInboundHandlerFile, cwd: string, appendFileIfMissing?: boolean): InboundHandlerInvocation;
export declare function processTelegramInboundHandlers<TFile extends TelegramInboundHandlerFile>(options: {
    files: TFile[];
    rawText: string;
    handlers?: TelegramInboundHandlerConfig[];
    cwd: string;
    execCommand: TelegramInboundHandlerRuntimeDeps<unknown>["execCommand"];
    recordRuntimeEvent?: TelegramInboundHandlerRuntimeDeps<unknown>["recordRuntimeEvent"];
}): Promise<TelegramInboundHandlerProcessResult<TFile>>;
export declare function createTelegramInboundHandlerRuntime<TContext>(deps: TelegramInboundHandlerRuntimeDeps<TContext>): TelegramInboundHandlerRuntime<TContext>;
export {};
