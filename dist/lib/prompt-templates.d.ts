/**
 * Pi prompt-template bridge helpers
 * Zones: pi agent prompts, telegram controls, filesystem
 * Discovers Pi prompt-template slash commands and expands them before Telegram queue dispatch
 */
import type { PiSlashCommandInfo } from "./pi.ts";
export interface TelegramPromptTemplateCommand {
    command: string;
    description?: string;
    path: string;
}
export type TelegramPromptTemplateReader = (path: string) => string;
export declare function parsePromptTemplateArgs(argsString: string): string[];
export declare function substitutePromptTemplateArgs(content: string, args: readonly string[]): string;
export declare function isTelegramPromptTemplateCommandName(name: string): boolean;
export declare function mapPiPromptTemplateNameToTelegramCommandName(name: string): string | undefined;
export interface TelegramPromptTemplateCommandGetterDeps {
    getCommands: () => readonly PiSlashCommandInfo[];
    reservedCommandNames?: readonly string[];
    getReservedCommandNames?: () => readonly string[];
}
export declare function getTelegramPromptTemplateCommands(commands: readonly PiSlashCommandInfo[], reservedNames?: ReadonlySet<string>): TelegramPromptTemplateCommand[];
export declare function createTelegramPromptTemplateCommandGetter(deps: TelegramPromptTemplateCommandGetterDeps): () => TelegramPromptTemplateCommand[];
export declare function expandTelegramPromptTemplateCommand(commandName: string, args: string, commands: readonly TelegramPromptTemplateCommand[], readTemplate?: TelegramPromptTemplateReader): string | undefined;
