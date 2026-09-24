/**
 * Telegram outbound surface helpers
 * Zones: telegram outbound, command templates, voice delivery
 * Owns configured outbound handler execution, text transforms, public assistant-output reply composition and mutation fencing, voice-file generation/delivery, runtime-event bridge, and compatibility re-exports; assistant markup parsing lives in outbound-markup and button callback actions live in outbound-buttons
 */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveTelegramTempDir } from "./paths.js";
import * as Replies from "./replies.js";
import { isTelegramApiCommitUnknownError } from "./telegram-api.js";
import { planTelegramButtonReply, } from "./outbound-buttons.js";
import { planTelegramVoiceReply, stripTelegramCommentMarkupForDelivery, } from "./outbound-markup.js";
import { createTelegramVoiceReplySender as createTelegramVoiceReplySenderWithPorts } from "./outbound-voice.js";
const OUTBOUND_HANDLER_REGISTRY_KEY = "__piTelegramOutboundHandlers__";
const VOICE_EVENT_RECORDER_KEY = "__piTelegramVoiceEventRecorder__";
import { buildCommandTemplateInvocation, expandCommandTemplateConfigs, substituteCommandTemplateToken, } from "./command-templates.js";
const DEFAULT_VOICE_TIMEOUT_MS = 120_000;
export function bindTelegramRuntimeEventRecorder(recorder) {
    globalThis[VOICE_EVENT_RECORDER_KEY] = recorder;
}
export function recordTelegramRuntimeEvent(category, error, details) {
    const recorder = globalThis[VOICE_EVENT_RECORDER_KEY];
    if (typeof recorder === "function") {
        recorder(category, error, details);
    }
}
export { normalizeMarkdownAfterVoiceExtraction, planTelegramVoiceReply, stripTelegramCommentMarkupForDelivery, stripTelegramCommentMarkupForPreview, stripTelegramVoiceMarkupForPreview, } from "./outbound-markup.js";
// --- Programmatic Outbound Handler Registry Runtime ---
function getOrCreateOutboundHandlerRegistry() {
    const existing = globalThis[OUTBOUND_HANDLER_REGISTRY_KEY];
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
    globalThis[OUTBOUND_HANDLER_REGISTRY_KEY] =
        registry;
    return registry;
}
export function registerTelegramOutboundHandler(kind, handler) {
    const registry = getOrCreateOutboundHandlerRegistry();
    const list = registry.handlers.get(kind) ?? [];
    list.push(handler);
    registry.handlers.set(kind, list);
    return () => {
        const updated = registry.handlers.get(kind) ?? [];
        const index = updated.indexOf(handler);
        if (index !== -1) {
            updated.splice(index, 1);
            registry.handlers.set(kind, updated);
        }
    };
}
export function getTelegramOutboundProgrammaticHandlers(kind) {
    const registry = getOrCreateOutboundHandlerRegistry();
    return [...(registry.handlers.get(kind) ?? [])];
}
// --- Voice Reply Timeout Helpers ---
function resolveOutboundNumericControlField(value, values, label) {
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
function getVoiceReplyConfiguredTimeout(config) {
    const timeout = typeof config === "string" ? undefined : config?.timeout;
    return resolveOutboundNumericControlField(timeout, {}, "timeout");
}
function getVoiceReplyTimeout(config) {
    return getVoiceReplyConfiguredTimeout(config) ?? DEFAULT_VOICE_TIMEOUT_MS;
}
function getRemainingVoiceReplyTimeout(timeout, startedAt) {
    return Math.max(1, timeout - (Date.now() - startedAt));
}
function getVoiceReplyCompositionStepTimeout(handlerTimeout, step, startedAt) {
    const remaining = getRemainingVoiceReplyTimeout(handlerTimeout, startedAt);
    const stepTimeout = getVoiceReplyConfiguredTimeout(step);
    return stepTimeout === undefined
        ? remaining
        : Math.min(stepTimeout, remaining);
}
function formatVoiceReplyExecutionFailure(label, result) {
    const parts = [
        `${label} exited with code ${result.code}${result.killed ? " (killed)" : ""}`,
    ];
    if (result.stderr.trim())
        parts.push(`stderr:\n${result.stderr.trimEnd()}`);
    if (result.stdout.trim())
        parts.push(`stdout:\n${result.stdout.trimEnd()}`);
    return parts.join("\n\n");
}
async function runVoiceReplyCommand(label, config, values, options) {
    if (!options.execCommand) {
        throw new Error("execCommand is required for command template execution");
    }
    const invocation = buildCommandTemplateInvocation(config, values, options.cwd, {
        emptyMessage: "Outbound voice template is empty",
        missingLabel: "outbound voice template",
    });
    const result = await options.execCommand(invocation.command, invocation.args, {
        cwd: options.cwd,
        timeout: options.timeout,
        ...(typeof config === "object" && config.retry !== undefined
            ? {
                retry: resolveOutboundNumericControlField(config.retry, {}, "retry"),
            }
            : {}),
        ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    });
    if (result.code !== 0)
        throw new Error(formatVoiceReplyExecutionFailure(label, result));
    return result;
}
function normalizeOutboundHandlerStringList(value) {
    if (Array.isArray(value))
        return value
            .map(String)
            .map((item) => item.trim())
            .filter(Boolean);
    if (typeof value === "string" && value.trim())
        return [value.trim()];
    return [];
}
function outboundHandlerMatchesType(handler, type) {
    const selectors = [
        ...normalizeOutboundHandlerStringList(handler.type),
        ...normalizeOutboundHandlerStringList(handler.match),
    ];
    if (selectors.length === 0)
        return false;
    return selectors.includes(type);
}
export function findTelegramOutboundHandlers(handlers, type) {
    if (!Array.isArray(handlers))
        return [];
    return handlers.filter((handler) => !!handler &&
        typeof handler === "object" &&
        outboundHandlerMatchesType(handler, type));
}
function getTelegramVoiceHandlerCompositionSteps(handler) {
    if (Array.isArray(handler.template)) {
        return expandCommandTemplateConfigs(handler);
    }
    return [];
}
function extractVoiceReplyPath(stdout) {
    const path = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!path)
        throw new Error("Voice generator did not print an output path");
    return path;
}
function getVoiceReplyOutputPath(config, values, stdout) {
    const output = config.output ?? "stdout";
    if (output === "stdout")
        return extractVoiceReplyPath(stdout);
    const keyMatch = output.match(/^\{?([A-Za-z_][A-Za-z0-9_-]*)\}?$/);
    if (keyMatch && Object.hasOwn(values, keyMatch[1])) {
        return values[keyMatch[1]] ?? "";
    }
    return output.replace(/\{([A-Za-z_][A-Za-z0-9_-]*)\}/g, (_match, key) => values[key] ?? "");
}
function getVoiceReplyTemplateValues(text, options) {
    return {
        text,
        type: "voice",
        mp3: options.mp3Path,
        ogg: options.oggPath,
        ...(options.lang ? { lang: options.lang } : {}),
        ...(options.rate ? { rate: options.rate } : {}),
    };
}
function getDefaultTelegramVoiceTempDir() {
    return resolveTelegramTempDir();
}
async function generateTelegramVoiceReplyFileWithHandler(text, options) {
    await mkdir(options.tempDir, { recursive: true });
    const artifactId = randomUUID();
    const values = getVoiceReplyTemplateValues(text, {
        lang: options.lang,
        rate: options.rate,
        mp3Path: join(options.tempDir, `${artifactId}-voice.mp3`),
        oggPath: join(options.tempDir, `${artifactId}-voice.ogg`),
    });
    const steps = getTelegramVoiceHandlerCompositionSteps(options.handler);
    if (steps.length > 0) {
        const startedAt = Date.now();
        let stdout = text;
        for (const [index, step] of steps.entries()) {
            try {
                const result = await runVoiceReplyCommand(`Outbound voice template step ${index + 1}`, step, values, {
                    cwd: options.cwd,
                    timeout: getVoiceReplyCompositionStepTimeout(options.timeout, step, startedAt),
                    execCommand: options.execCommand,
                    stdin: stdout,
                });
                stdout = result.stdout;
            }
            catch (error) {
                if (typeof step === "object" && step.failure === "root")
                    throw error;
                stdout = "";
            }
        }
        return getVoiceReplyOutputPath(options.handler, values, stdout);
    }
    const result = await runVoiceReplyCommand("Outbound voice template", options.handler, values, {
        cwd: options.cwd,
        timeout: options.timeout,
        execCommand: options.execCommand,
        stdin: text,
    });
    return getVoiceReplyOutputPath(options.handler, values, result.stdout);
}
export async function generateTelegramVoiceReplyFile(text, options) {
    const handler = options.handler;
    if (!handler?.template)
        return undefined;
    return generateTelegramVoiceReplyFileWithHandler(text, {
        lang: options.lang,
        rate: options.rate,
        handler,
        tempDir: options.tempDir ?? getDefaultTelegramVoiceTempDir(),
        cwd: options.cwd ?? process.cwd(),
        timeout: getVoiceReplyTimeout(handler),
        execCommand: options.execCommand,
    });
}
function getOutboundTextTemplateValues(text) {
    return { text, type: "text" };
}
async function transformTelegramOutboundTextWithHandler(text, options) {
    const values = getOutboundTextTemplateValues(text);
    const steps = getTelegramVoiceHandlerCompositionSteps(options.handler);
    if (steps.length > 0) {
        const startedAt = Date.now();
        let stdout = text;
        for (const [index, step] of steps.entries()) {
            try {
                const result = await runVoiceReplyCommand(`Outbound text template step ${index + 1}`, step, values, {
                    cwd: options.cwd,
                    timeout: getVoiceReplyCompositionStepTimeout(getVoiceReplyTimeout(options.handler), step, startedAt),
                    execCommand: options.execCommand,
                    stdin: stdout,
                });
                stdout = result.stdout;
            }
            catch (error) {
                if (typeof step === "object" && step.failure === "root")
                    throw error;
                stdout = "";
            }
            if (!stdout)
                stdout = text;
        }
        return stdout.trim() || text;
    }
    const result = await runVoiceReplyCommand("Outbound text template", options.handler, values, {
        cwd: options.cwd,
        timeout: getVoiceReplyTimeout(options.handler),
        execCommand: options.execCommand,
        stdin: text,
    });
    return result.stdout.trim() || text;
}
export async function transformTelegramOutboundText(text, options) {
    let transformed = text;
    for (const handler of findTelegramOutboundHandlers(options.handlers, "text")) {
        try {
            transformed = await transformTelegramOutboundTextWithHandler(transformed, {
                handler,
                cwd: options.cwd ?? process.cwd(),
                execCommand: options.execCommand,
            });
        }
        catch (error) {
            options.recordRuntimeEvent?.("outbound-text-handler", error, {
                handler: outboundHandlerMatchesType(handler, "text")
                    ? "text"
                    : "unknown",
            });
        }
    }
    return transformed;
}
function isTelegramInlineKeyboardLike(replyMarkup) {
    if (!replyMarkup || typeof replyMarkup !== "object")
        return false;
    const keyboard = replyMarkup
        .inline_keyboard;
    return Array.isArray(keyboard);
}
async function transformTelegramOutboundReplyMarkup(replyMarkup, options) {
    if (!isTelegramInlineKeyboardLike(replyMarkup))
        return replyMarkup;
    const translatedRows = [];
    for (const row of replyMarkup.inline_keyboard) {
        const translatedRow = [];
        for (const button of row) {
            const text = await transformTelegramOutboundText(button.text, options);
            translatedRow.push({ ...button, text });
        }
        translatedRows.push(translatedRow);
    }
    return { ...replyMarkup, inline_keyboard: translatedRows };
}
export async function transformTelegramOutboundTextReply(text, options) {
    const transformOptions = {
        handlers: options.handlers,
        cwd: options.cwd,
        execCommand: options.execCommand,
        recordRuntimeEvent: options.recordRuntimeEvent,
    };
    const transformedText = await transformTelegramOutboundText(text, transformOptions);
    const replyMarkup = await transformTelegramOutboundReplyMarkup(options.replyMarkup, transformOptions);
    return { text: transformedText, ...(replyMarkup ? { replyMarkup } : {}) };
}
export function createTelegramOutboundTextReplyRuntime(deps) {
    return {
        sendTextReply: async (chatId, replyToMessageId, text, options) => {
            const transformed = await transformTelegramOutboundText(text, {
                handlers: deps.getHandlers?.(),
                cwd: deps.cwd,
                execCommand: deps.execCommand,
                recordRuntimeEvent: deps.recordRuntimeEvent,
            });
            return deps.sendTextReply(chatId, replyToMessageId, transformed, options);
        },
        sendMarkdownReply: async (chatId, replyToMessageId, markdown, options) => {
            const deliveryMarkdown = stripTelegramCommentMarkupForDelivery(markdown);
            if (!deliveryMarkdown)
                return undefined;
            const transformed = await transformTelegramOutboundTextReply(deliveryMarkdown, {
                handlers: deps.getHandlers?.(),
                cwd: deps.cwd,
                execCommand: deps.execCommand,
                recordRuntimeEvent: deps.recordRuntimeEvent,
                replyMarkup: options?.replyMarkup,
            });
            return deps.sendMarkdownReply(chatId, replyToMessageId, transformed.text, {
                ...options,
                ...(transformed.replyMarkup
                    ? { replyMarkup: transformed.replyMarkup }
                    : {}),
            });
        },
    };
}
export function createTelegramOutboundTextPreviewRuntime(deps) {
    const wrap = (finalize) => async (chatId, markdown, replyToMessageId, options) => {
        const transformed = await transformTelegramOutboundTextReply(markdown, {
            handlers: deps.getHandlers?.(),
            cwd: deps.cwd,
            execCommand: deps.execCommand,
            recordRuntimeEvent: deps.recordRuntimeEvent,
            replyMarkup: options?.replyMarkup,
        });
        return finalize(chatId, transformed.text, replyToMessageId, {
            ...options,
            ...(transformed.replyMarkup
                ? { replyMarkup: transformed.replyMarkup }
                : {}),
        });
    };
    return {
        finalizeMarkdownPreview: wrap(deps.finalizeMarkdownPreview),
        preparePreviewDelivery(isDeliveryActive) {
            const prepared = deps.preparePreviewDelivery?.(isDeliveryActive);
            return prepared ? { ...prepared, finalizeMarkdownPreview: wrap(prepared.finalizeMarkdownPreview) } : undefined;
        },
    };
}
// --- Voice Policy Re-Exports ---
export { clearTelegramVoiceSynthesisProviders, clearTelegramVoiceTranscriptionProviders, computeVoicePromptContribution, computeVoiceTurnFlags, getTelegramVoiceReplyMode, getTelegramVoiceSynthesisProviders, getTelegramVoiceTranscriptionProviders, hasTelegramVoiceSynthesisProvider, hasTelegramVoiceTranscriptionProvider, isVoiceTurn, registerTelegramVoiceSynthesisProvider, registerTelegramVoiceTranscriptionProvider, shouldSuppressPreviewForVoice, } from "./voice.js";
export function createTelegramVoiceReplySender(deps) {
    return createTelegramVoiceReplySenderWithPorts(deps, {
        findVoiceHandlers: (handlers) => findTelegramOutboundHandlers(handlers, "voice"),
        generateVoiceFile: (text, options) => generateTelegramVoiceReplyFile(text, {
            lang: options.lang,
            rate: options.rate,
            handler: options.handler,
            tempDir: options.tempDir,
            cwd: options.cwd,
            execCommand: options.execCommand,
        }),
        getProgrammaticVoiceHandlers: () => getTelegramOutboundProgrammaticHandlers("voice"),
    });
}
export { createTelegramButtonActionStore, createTelegramButtonPromptTurn, createTelegramButtonReplyPlanner, handleTelegramButtonCallbackQuery, markTelegramButtonSelected, planTelegramButtonReply, } from "./outbound-buttons.js";
export function createTelegramOutboundReplyPlanner(store, getRenderingMode = () => "rich") {
    return (markdown, options) => {
        const buttonReply = planTelegramButtonReply(markdown, {
            registerAction: store.register,
            rendering: getRenderingMode(),
            ...(options?.binding ? { binding: options.binding } : {}),
        });
        // Button replies can also contain <!-- telegram_voice --> markup
        const voiceReply = planTelegramVoiceReply(buttonReply.markdown);
        return {
            markdown: voiceReply.markdown,
            ...(buttonReply.replyMarkup
                ? { replyMarkup: buttonReply.replyMarkup }
                : {}),
            ...(voiceReply.voiceText ? { voiceText: voiceReply.voiceText } : {}),
            ...(voiceReply.voiceReplies
                ? { voiceReplies: voiceReply.voiceReplies }
                : {}),
            ...(voiceReply.lang ? { lang: voiceReply.lang } : {}),
            ...(voiceReply.rate ? { rate: voiceReply.rate } : {}),
        };
    };
}
/**
 * Create an artifact sender that delivers planned voice replies for a turn.
 * Iterates over `voiceReplies` (or a single `voiceText`) and sends each as
 * a Telegram voice message via the voice reply sender. Throws if no voice
 * reply could be delivered.
 */
// --- Outbound Reply Artifacts ---
export function createTelegramOutboundReplyArtifactSender(deps) {
    return async (turn, plan, options) => {
        const isDeliveryActive = () => deps.isDeliveryActive?.() !== false && options?.isDeliveryActive?.() !== false;
        const sendVoiceReply = createTelegramVoiceReplySender({ ...deps, isDeliveryActive });
        // Normalize voice replies: either use explicit voiceReplies array or fall back to voiceText
        const voiceReplies = plan.voiceReplies?.length
            ? plan.voiceReplies
            : plan.voiceText
                ? [{ text: plan.voiceText, lang: plan.lang, rate: plan.rate }]
                : [];
        let anyDelivered = false;
        for (const reply of voiceReplies) {
            if (!isDeliveryActive())
                return;
            try {
                await sendVoiceReply(turn, reply.text, {
                    lang: reply.lang ?? plan.lang,
                    rate: reply.rate ?? plan.rate,
                    // Only attach reply parameters to the first voice message
                    replyToPrompt: options?.replyToPrompt === true && !anyDelivered,
                    replyMarkup: !anyDelivered ? plan.replyMarkup : undefined,
                });
                anyDelivered = true;
            }
            catch (error) {
                if (isTelegramApiCommitUnknownError(error))
                    throw error;
                // sendVoiceReply already recorded the error; continue to next reply
            }
        }
        if (!isDeliveryActive())
            return;
        if (!anyDelivered) {
            throw new Error("Failed to send voice reply: every voice synthesis provider failed.");
        }
    };
}
export function createTelegramAssistantOutputMutationFence(isAuthorityActive) {
    return {
        run(mutation, ...args) {
            if (!isAuthorityActive()) {
                return Promise.reject(new Error("Assistant output lost admission authority before transport mutation."));
            }
            return mutation(...args);
        },
    };
}
export function createTelegramAssistantOutputSender(deps) {
    return async function sendAssistantOutput(event, authority, isAuthorityActive) {
        const target = authority.target;
        if (!target) {
            throw new Error("Assistant output has no authorized Telegram target.");
        }
        const mutationFence = createTelegramAssistantOutputMutationFence(isAuthorityActive);
        const replyRuntime = Replies.createTelegramRenderedMessageDeliveryRuntime({
            recordOwnership: deps.recordOwnership,
            sendMessage(body) {
                return mutationFence.run(deps.sendMessage, body);
            },
            sendRichMessage(body) {
                return mutationFence.run(deps.sendRichMessage, body);
            },
            getAssistantRenderingMode: deps.getAssistantRenderingMode,
            editMessage(body) {
                return mutationFence.run(deps.editMessage, body);
            },
        });
        const outboundRuntime = createTelegramOutboundTextReplyRuntime({
            sendTextReply: replyRuntime.sendTextReply,
            sendMarkdownReply: replyRuntime.sendMarkdownReply,
            execCommand: deps.execCommand,
            getHandlers: deps.getHandlers,
            recordRuntimeEvent: deps.recordRuntimeEvent,
        });
        const buttonReply = deps.planButtonReply?.(event.text) ?? {
            markdown: event.text,
        };
        await outboundRuntime.sendMarkdownReply(target.chatId, event.source === "telegram" ? event.replyToMessageId : undefined, buttonReply.markdown, {
            target,
            ...(buttonReply.replyMarkup
                ? { replyMarkup: buttonReply.replyMarkup }
                : {}),
        });
    };
}
