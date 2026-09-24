/**
 * Pi prompt-template bridge helpers
 * Zones: pi agent prompts, telegram controls, filesystem
 * Discovers Pi prompt-template slash commands and expands them before Telegram queue dispatch
 */
import { readFileSync } from "node:fs";
const TELEGRAM_BOT_COMMAND_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;
function stripPromptTemplateFrontmatter(content) {
    if (!content.startsWith("---"))
        return content;
    const lines = content.split("\n");
    if (lines[0]?.trim() !== "---")
        return content;
    for (let index = 1; index < lines.length; index += 1) {
        if (lines[index]?.trim() === "---")
            return lines.slice(index + 1).join("\n");
    }
    return content;
}
export function parsePromptTemplateArgs(argsString) {
    const args = [];
    let current = "";
    let quote;
    for (const char of argsString) {
        if (quote) {
            if (char === quote) {
                quote = undefined;
            }
            else {
                current += char;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === " " || char === "\t") {
            if (current)
                args.push(current);
            current = "";
            continue;
        }
        current += char;
    }
    if (current)
        args.push(current);
    return args;
}
export function substitutePromptTemplateArgs(content, args) {
    let result = content.replace(/\$(\d+)/g, (_, num) => {
        const index = Number.parseInt(num, 10) - 1;
        return args[index] ?? "";
    });
    result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startValue, lengthValue) => {
        const start = Math.max(Number.parseInt(startValue, 10) - 1, 0);
        if (lengthValue) {
            const length = Number.parseInt(lengthValue, 10);
            return args.slice(start, start + length).join(" ");
        }
        return args.slice(start).join(" ");
    });
    const allArgs = args.join(" ");
    return result.replace(/\$ARGUMENTS/g, allArgs).replace(/\$@/g, allArgs);
}
export function isTelegramPromptTemplateCommandName(name) {
    return TELEGRAM_BOT_COMMAND_NAME_PATTERN.test(name);
}
export function mapPiPromptTemplateNameToTelegramCommandName(name) {
    const command = name
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 32)
        .replace(/_+$/g, "");
    return isTelegramPromptTemplateCommandName(command) ? command : undefined;
}
export function getTelegramPromptTemplateCommands(commands, reservedNames = new Set()) {
    const seen = new Set();
    const promptCommands = [];
    for (const command of commands) {
        if (command.source !== "prompt")
            continue;
        const telegramCommand = mapPiPromptTemplateNameToTelegramCommandName(command.name);
        if (!telegramCommand)
            continue;
        if (reservedNames.has(telegramCommand))
            continue;
        if (seen.has(telegramCommand))
            continue;
        const sourcePath = command.sourceInfo?.path;
        if (!sourcePath)
            continue;
        seen.add(telegramCommand);
        promptCommands.push({
            command: telegramCommand,
            description: command.description,
            path: sourcePath,
        });
    }
    return promptCommands.sort((a, b) => a.command.localeCompare(b.command));
}
export function createTelegramPromptTemplateCommandGetter(deps) {
    return () => {
        return getTelegramPromptTemplateCommands(deps.getCommands(), new Set([
            ...(deps.reservedCommandNames ?? []),
            ...(deps.getReservedCommandNames?.() ?? []),
        ]));
    };
}
export function expandTelegramPromptTemplateCommand(commandName, args, commands, readTemplate = (path) => readFileSync(path, "utf-8")) {
    const command = commands.find((candidate) => candidate.command === commandName);
    if (!command)
        return undefined;
    const content = stripPromptTemplateFrontmatter(readTemplate(command.path));
    return substitutePromptTemplateArgs(content, parsePromptTemplateArgs(args));
}
