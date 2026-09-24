/**
 * Telegram inbound handler pipeline
 * Zones: telegram inbound, command templates, prompt preparation
 * Owns MIME/type matching, command-template execution, fallback handling, and prompt injection before prompt enqueueing
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { buildCommandTemplateInvocation, expandCommandTemplateConfigs, normalizeCommandTemplateConfig, substituteCommandTemplateToken, } from "./command-templates.js";
import { getTelegramVoiceTranscriptionProviders } from "./voice.js";
const DEFAULT_INBOUND_HANDLER_TIMEOUT_MS = 120_000;
const INBOUND_HANDLER_REGISTRY_KEY = "__piTelegramInboundHandlers__";
const MAX_INBOUND_HANDLER_OUTPUT_LENGTH = 24_000;
const MAX_INBOUND_HANDLER_FAILURE_STREAM_LENGTH = 4_000;
const BUILT_IN_TEXT_ATTACHMENT_MAX_BYTES = 1_000_000;
function getOrCreateInboundHandlerRegistry() {
    const existing = globalThis[INBOUND_HANDLER_REGISTRY_KEY];
    if (existing &&
        typeof existing === "object" &&
        existing !== null &&
        "handlers" in existing &&
        existing.handlers instanceof Map) {
        return existing;
    }
    const registry = {
        handlers: new Map(),
    };
    globalThis[INBOUND_HANDLER_REGISTRY_KEY] =
        registry;
    return registry;
}
export function registerTelegramInboundHandler(kind, handler) {
    const normalizedKind = kind.trim() || "*";
    const registry = getOrCreateInboundHandlerRegistry();
    const list = registry.handlers.get(normalizedKind) ?? [];
    list.push(handler);
    registry.handlers.set(normalizedKind, list);
    return () => {
        const updated = registry.handlers.get(normalizedKind) ?? [];
        const index = updated.indexOf(handler);
        if (index !== -1) {
            updated.splice(index, 1);
            registry.handlers.set(normalizedKind, updated);
        }
    };
}
export function getTelegramInboundProgrammaticHandlers(kind) {
    const registry = getOrCreateInboundHandlerRegistry();
    return [
        ...(registry.handlers.get(kind) ?? []),
        ...(kind === "*" ? [] : (registry.handlers.get("*") ?? [])),
    ];
}
export function clearTelegramInboundHandlers() {
    getOrCreateInboundHandlerRegistry().handlers.clear();
}
function truncateTelegramInboundText(text, maxLength) {
    if (text.length <= maxLength)
        return text;
    return `${text.slice(0, maxLength).trimEnd()}… [truncated ${text.length - maxLength} chars]`;
}
function truncateTelegramInboundOutput(text) {
    return truncateTelegramInboundText(text, MAX_INBOUND_HANDLER_OUTPUT_LENGTH);
}
function truncateTelegramInboundFailureStream(text) {
    return truncateTelegramInboundText(text.trimEnd(), MAX_INBOUND_HANDLER_FAILURE_STREAM_LENGTH);
}
function normalizeInboundProgrammaticHandlerText(result) {
    const text = typeof result === "string" ? result : result?.text;
    const normalized = text?.trim();
    return normalized ? truncateTelegramInboundOutput(normalized) : undefined;
}
function normalizeStringList(value) {
    if (Array.isArray(value)) {
        return value
            .map(String)
            .map((item) => item.trim())
            .filter(Boolean);
    }
    if (typeof value === "string" && value.trim())
        return [value.trim()];
    return [];
}
function matchesWildcard(pattern, value) {
    if (!value)
        return false;
    const normalizedPattern = pattern.toLowerCase();
    const normalizedValue = value.toLowerCase();
    if (normalizedPattern === "*")
        return true;
    const escaped = normalizedPattern
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(normalizedValue);
}
function handlerHasSelectors(handler) {
    return (normalizeStringList(handler.match).length > 0 ||
        normalizeStringList(handler.mime).length > 0 ||
        normalizeStringList(handler.type).length > 0);
}
function matchesAnyPattern(patterns, value) {
    return patterns.some((pattern) => matchesWildcard(pattern, value));
}
function isTelegramTextMimeType(mimeType) {
    return matchesWildcard("text/*", mimeType);
}
export function telegramInboundHandlerMatchesFile(handler, file) {
    if (!handlerHasSelectors(handler))
        return true;
    const matchPatterns = normalizeStringList(handler.match);
    const mimePatterns = normalizeStringList(handler.mime);
    const typePatterns = normalizeStringList(handler.type);
    if (matchesAnyPattern(mimePatterns, file.mimeType))
        return true;
    if (matchesAnyPattern(typePatterns, file.kind))
        return true;
    if (matchesAnyPattern(matchPatterns, file.mimeType))
        return true;
    return matchesAnyPattern(matchPatterns, file.kind);
}
export function findTelegramInboundHandlers(handlers, file) {
    if (!Array.isArray(handlers))
        return [];
    return handlers.filter((handler) => !!handler &&
        typeof handler === "object" &&
        telegramInboundHandlerMatchesFile(handler, file));
}
function hasInboundFilePlaceholder(value) {
    return /\{file\}/.test(value);
}
function getTelegramInboundHandlerTemplateValues(file, text = "") {
    return {
        file: file.path,
        mime: file.mimeType ?? "",
        text,
        type: file.kind ?? "",
    };
}
function buildTelegramInboundTemplateInvocation(handler, file, cwd, appendFileIfMissing = true) {
    const values = getTelegramInboundHandlerTemplateValues(file);
    const templateConfig = normalizeCommandTemplateConfig(handler);
    const hadFilePlaceholder = typeof templateConfig.template === "string"
        ? hasInboundFilePlaceholder(templateConfig.template)
        : false;
    const invocation = buildCommandTemplateInvocation(handler, values, cwd, {
        emptyMessage: "Inbound handler template is empty",
        missingLabel: "inbound handler template",
    });
    if (appendFileIfMissing && !hadFilePlaceholder)
        invocation.args.push(file.path);
    return invocation;
}
export function buildTelegramInboundHandlerInvocation(handler, file, cwd, appendFileIfMissing = true) {
    const { template } = normalizeCommandTemplateConfig(handler);
    if (!template)
        throw new Error("Inbound handler template is required");
    return buildTelegramInboundTemplateInvocation(handler, file, cwd, appendFileIfMissing);
}
function resolveTelegramInboundNumericControlField(value, values, label) {
    if (value === undefined)
        return undefined;
    const resolved = typeof value === "string"
        ? substituteCommandTemplateToken(value, values, label)
        : value;
    if (resolved === "")
        return undefined;
    const numeric = Number(resolved);
    if (!Number.isFinite(numeric) || numeric < 0)
        throw new Error(`Command template ${label} must be a non-negative number.`);
    return numeric;
}
function getTelegramInboundHandlerConfiguredTimeout(handler) {
    const timeout = typeof handler === "string" ? undefined : handler.timeout;
    return resolveTelegramInboundNumericControlField(timeout, {}, "timeout");
}
function getTelegramInboundHandlerTimeout(handler) {
    return (getTelegramInboundHandlerConfiguredTimeout(handler) ??
        DEFAULT_INBOUND_HANDLER_TIMEOUT_MS);
}
function getRemainingTelegramInboundTimeout(timeout, startedAt) {
    return Math.max(1, timeout - (Date.now() - startedAt));
}
function getTelegramInboundInitialCompositionStepTimeout(handler, step) {
    const timeout = getTelegramInboundHandlerTimeout(handler);
    const stepTimeout = getTelegramInboundHandlerConfiguredTimeout(step);
    return stepTimeout === undefined ? timeout : Math.min(stepTimeout, timeout);
}
function getTelegramInboundCompositionStepTimeout(handler, step, startedAt) {
    const remaining = getRemainingTelegramInboundTimeout(getTelegramInboundHandlerTimeout(handler), startedAt);
    const stepTimeout = getTelegramInboundHandlerConfiguredTimeout(step);
    return stepTimeout === undefined
        ? remaining
        : Math.min(stepTimeout, remaining);
}
function getTelegramInboundHandlerKind(handler) {
    if (Array.isArray(handler.template))
        return "composition";
    if (handler.template)
        return "template";
    return "unknown";
}
function formatTelegramInboundHandlerFailure(result) {
    const parts = [
        `Inbound handler exited with code ${result.code}${result.killed ? " (killed)" : ""}`,
    ];
    if (result.stderr.trim())
        parts.push(`stderr:\n${truncateTelegramInboundFailureStream(result.stderr)}`);
    if (result.stdout.trim())
        parts.push(`stdout:\n${truncateTelegramInboundFailureStream(result.stdout)}`);
    return parts.join("\n\n");
}
async function executeTelegramInboundHandlerInvocation(handler, file, cwd, deps, appendFileIfMissing = true, timeout = getTelegramInboundHandlerTimeout(handler), stdin) {
    const invocation = buildTelegramInboundHandlerInvocation(handler, file, cwd, appendFileIfMissing);
    const result = await deps.execCommand(invocation.command, invocation.args, {
        cwd,
        timeout,
        ...(typeof handler === "object" && handler.retry !== undefined
            ? {
                retry: resolveTelegramInboundNumericControlField(handler.retry, {}, "retry"),
            }
            : {}),
        ...(stdin !== undefined ? { stdin } : {}),
    });
    if (result.code !== 0)
        throw new Error(formatTelegramInboundHandlerFailure(result));
    return truncateTelegramInboundOutput(result.stdout);
}
function getTelegramInboundHandlerCompositionSteps(handler) {
    if (Array.isArray(handler.template)) {
        return expandCommandTemplateConfigs(handler);
    }
    return [];
}
function getTelegramTextHandlerFile() {
    return {
        path: "",
        fileName: "message.txt",
        mimeType: "text/plain",
        kind: "text",
        isImage: false,
    };
}
function findTelegramTextHandlers(handlers) {
    if (!Array.isArray(handlers))
        return [];
    const textFile = getTelegramTextHandlerFile();
    return handlers.filter((handler) => !!handler &&
        typeof handler === "object" &&
        handlerHasSelectors(handler) &&
        telegramInboundHandlerMatchesFile(handler, textFile));
}
function buildTelegramTextHandlerInvocation(handler, text, cwd) {
    const values = getTelegramInboundHandlerTemplateValues(getTelegramTextHandlerFile(), text);
    const { template } = normalizeCommandTemplateConfig(handler);
    if (!template)
        throw new Error("Text handler template is required");
    return buildCommandTemplateInvocation(handler, values, cwd, {
        emptyMessage: "Text handler template is empty",
        missingLabel: "text handler template",
    });
}
async function executeTelegramTextHandlerInvocation(handler, text, cwd, deps, timeout = getTelegramInboundHandlerTimeout(handler)) {
    const invocation = buildTelegramTextHandlerInvocation(handler, text, cwd);
    const result = await deps.execCommand(invocation.command, invocation.args, {
        cwd,
        timeout,
        stdin: text,
        ...(typeof handler === "object" && handler.retry !== undefined
            ? {
                retry: resolveTelegramInboundNumericControlField(handler.retry, {}, "retry"),
            }
            : {}),
    });
    if (result.code !== 0)
        throw new Error(formatTelegramInboundHandlerFailure(result));
    return truncateTelegramInboundOutput(result.stdout);
}
async function executeTelegramTextHandler(handler, text, cwd, deps) {
    const steps = getTelegramInboundHandlerCompositionSteps(handler);
    if (steps.length === 0) {
        return (await executeTelegramTextHandlerInvocation(handler, text, cwd, deps)).trim();
    }
    const startedAt = Date.now();
    let output = text;
    for (const [index, step] of steps.entries()) {
        try {
            output = await executeTelegramTextHandlerInvocation(step, output, cwd, deps, index === 0
                ? getTelegramInboundInitialCompositionStepTimeout(handler, step)
                : getTelegramInboundCompositionStepTimeout(handler, step, startedAt));
        }
        catch (error) {
            if (typeof step === "object" && step.failure === "root")
                throw error;
            output = "";
        }
        if (index > 0 && !output)
            output = text;
    }
    return output.trim();
}
async function processTelegramTextHandlers(options) {
    if (!options.rawText)
        return options.rawText;
    let text = options.rawText;
    for (const handler of findTelegramTextHandlers(options.handlers)) {
        try {
            const output = await executeTelegramTextHandler(handler, text, options.cwd, options);
            if (output)
                text = output;
        }
        catch (error) {
            options.recordRuntimeEvent?.("inbound-text-handler", error, {
                handler: getTelegramInboundHandlerKind(handler),
            });
        }
    }
    for (const handler of getTelegramInboundProgrammaticHandlers("text")) {
        try {
            const output = normalizeInboundProgrammaticHandlerText(await handler({ kind: "text", text, mimeType: "text/plain" }, { cwd: options.cwd }));
            if (output)
                text = output;
        }
        catch (error) {
            options.recordRuntimeEvent?.("inbound-programmatic-handler", error, {
                kind: "text",
            });
        }
    }
    return text;
}
function isTelegramVoiceLikeFile(file) {
    return (file.kind === "voice" ||
        file.kind === "audio" ||
        matchesWildcard("audio/*", file.mimeType));
}
async function processTelegramFileWithProgrammaticHandlers(file, options) {
    const kind = file.kind || "*";
    for (const handler of getTelegramInboundProgrammaticHandlers(kind)) {
        try {
            const output = normalizeInboundProgrammaticHandlerText(await handler({
                kind,
                file,
                mimeType: file.mimeType,
            }, { cwd: options.cwd }));
            if (output)
                return output;
        }
        catch (error) {
            options.recordRuntimeEvent?.("inbound-programmatic-handler", error, {
                fileName: file.fileName || basename(file.path),
                kind,
            });
        }
    }
    return undefined;
}
async function transcribeTelegramVoiceFileWithProviders(file, options) {
    if (!isTelegramVoiceLikeFile(file))
        return undefined;
    for (const provider of getTelegramVoiceTranscriptionProviders()) {
        try {
            const result = await provider(file, {});
            const text = typeof result === "string" ? result : result?.text;
            if (text?.trim())
                return truncateTelegramInboundOutput(text.trim());
        }
        catch (error) {
            options.recordRuntimeEvent?.("voice-transcription-provider", error, {
                fileName: file.fileName || basename(file.path),
            });
        }
    }
    return undefined;
}
async function readBuiltInTelegramTextAttachment(file) {
    if (!isTelegramTextMimeType(file.mimeType))
        return undefined;
    const content = await readFile(file.path, "utf8");
    const normalized = content.trim();
    if (!normalized ||
        Buffer.byteLength(normalized, "utf8") > BUILT_IN_TEXT_ATTACHMENT_MAX_BYTES) {
        return undefined;
    }
    const name = file.fileName || basename(file.path);
    return truncateTelegramInboundOutput(`[${name}]\n${normalized}`);
}
async function executeTelegramInboundHandler(handler, file, cwd, deps) {
    const steps = getTelegramInboundHandlerCompositionSteps(handler);
    if (steps.length === 0) {
        const output = await executeTelegramInboundHandlerInvocation(handler, file, cwd, deps);
        return output.trim();
    }
    const startedAt = Date.now();
    let output = "";
    for (const [index, step] of steps.entries()) {
        try {
            output = await executeTelegramInboundHandlerInvocation(step, file, cwd, deps, false, index === 0
                ? getTelegramInboundInitialCompositionStepTimeout(handler, step)
                : getTelegramInboundCompositionStepTimeout(handler, step, startedAt), index === 0 ? undefined : output);
        }
        catch (error) {
            if (typeof step === "object" && step.failure === "root")
                throw error;
            output = "";
        }
    }
    return output.trim();
}
export async function processTelegramInboundHandlers(options) {
    const rawText = await processTelegramTextHandlers({
        rawText: options.rawText,
        handlers: options.handlers,
        cwd: options.cwd,
        execCommand: options.execCommand,
        recordRuntimeEvent: options.recordRuntimeEvent,
    });
    const promptFiles = [...options.files];
    const outputs = [];
    for (const file of options.files) {
        let hasOutput = false;
        const handlers = findTelegramInboundHandlers(options.handlers, file);
        for (const handler of handlers) {
            try {
                const output = await executeTelegramInboundHandler(handler, file, options.cwd, options);
                if (output) {
                    outputs.push({ file, output, handler });
                    hasOutput = true;
                }
                break;
            }
            catch (error) {
                options.recordRuntimeEvent?.("inbound-handler", error, {
                    fileName: file.fileName || basename(file.path),
                    handler: getTelegramInboundHandlerKind(handler),
                });
            }
        }
        if (!hasOutput) {
            try {
                const output = await processTelegramFileWithProgrammaticHandlers(file, {
                    cwd: options.cwd,
                    recordRuntimeEvent: options.recordRuntimeEvent,
                });
                if (output) {
                    outputs.push({ file, output, handler: { type: "programmatic" } });
                    hasOutput = true;
                }
            }
            catch (error) {
                options.recordRuntimeEvent?.("inbound-programmatic-handler", error, {
                    fileName: file.fileName || basename(file.path),
                });
            }
        }
        if (!hasOutput) {
            try {
                const output = await transcribeTelegramVoiceFileWithProviders(file, {
                    recordRuntimeEvent: options.recordRuntimeEvent,
                });
                if (output) {
                    outputs.push({ file, output, handler: { type: "voice-provider" } });
                    hasOutput = true;
                }
            }
            catch (error) {
                options.recordRuntimeEvent?.("voice-transcription-provider", error, {
                    fileName: file.fileName || basename(file.path),
                });
            }
        }
        if (!hasOutput) {
            try {
                const output = await readBuiltInTelegramTextAttachment(file);
                if (output)
                    outputs.push({ file, output, handler: { type: "text" } });
            }
            catch (error) {
                options.recordRuntimeEvent?.("inbound-handler", error, {
                    fileName: file.fileName || basename(file.path),
                    handler: "built-in-text",
                });
            }
        }
    }
    return {
        rawText,
        promptFiles,
        handlerOutputs: outputs.map((output) => output.output),
        handledFiles: outputs,
    };
}
export function createTelegramInboundHandlerRuntime(deps) {
    return {
        process: (files, rawText, ctx) => processTelegramInboundHandlers({
            files,
            rawText,
            handlers: deps.getHandlers(),
            cwd: deps.getCwd(ctx),
            execCommand: deps.execCommand,
            recordRuntimeEvent: deps.recordRuntimeEvent,
        }),
    };
}
