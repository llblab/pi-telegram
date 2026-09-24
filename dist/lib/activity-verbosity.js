/**
 * Bridge-owned Telegram activity verbosity projection
 * Zones: telegram activity, rich rendering, operational delivery
 * Owns persistent bounded thinking and tool disclosures; excludes activity normalization, assistant answer rendering, and transport authority policy
 */
import { escapeHtml, renderTelegramInlineMarkdownHtml, } from "./rendering.js";
export const TELEGRAM_ACTIVITY_DETAIL_MAX_CHARS = 1_200;
export const TELEGRAM_ACTIVITY_MESSAGE_MAX_CHARS = 3_900;
export const TELEGRAM_ACTIVITY_MESSAGE_MAX_TOOLS = 6;
export const TELEGRAM_REASONING_MESSAGE_MAX_FRAMES = 24;
export const TELEGRAM_REASONING_BUFFER_MAX_CHARS = 1_200;
// Match native answer drafts: accumulate the opening frame for one full
// interval, then publish at most one updated frame per interval.
export const TELEGRAM_REASONING_MIN_INTERVAL_MS = 2_000;
export const TELEGRAM_TOOL_UPDATE_MAX_ENTRIES = 4;
function targetEquals(left, right) {
    return left.chatId === right.chatId && left.threadId === right.threadId;
}
function redactActivityText(text) {
    return text
        .replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, "[REDACTED_BOT_TOKEN]")
        .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}\b/gi, "$1[REDACTED]")
        .replace(/(["']?(?:api[_-]?key|token|password|secret)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, "$1[REDACTED]");
}
function formatActivityJson(value, depth = 0) {
    const indent = "  ".repeat(depth);
    if (Array.isArray(value)) {
        if (value.length === 0)
            return [`${indent}[]`];
        if (value.every((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry))) {
            const lines = [`${indent}[{`];
            value.forEach((entry, index) => {
                const fields = Object.entries(entry);
                fields.forEach(([key, nested], fieldIndex) => {
                    const nestedLines = formatActivityJson(nested, depth + 1);
                    const nestedIndent = "  ".repeat(depth + 1);
                    lines.push(`${nestedIndent}${JSON.stringify(key)}: ${nestedLines[0].slice(nestedIndent.length)}`, ...nestedLines.slice(1));
                    if (fieldIndex < fields.length - 1) {
                        lines[lines.length - 1] += ",";
                    }
                });
                lines.push(index < value.length - 1 ? `${indent}}, {` : `${indent}}]`);
            });
            return lines;
        }
        const lines = [`${indent}[`];
        value.forEach((entry, index) => {
            const nestedLines = formatActivityJson(entry, depth + 1);
            if (index < value.length - 1) {
                nestedLines[nestedLines.length - 1] += ",";
            }
            lines.push(...nestedLines);
        });
        lines.push(`${indent}]`);
        return lines;
    }
    if (value !== null && typeof value === "object") {
        const entries = Object.entries(value);
        if (entries.length === 0)
            return [`${indent}{}`];
        const lines = [`${indent}{`];
        entries.forEach(([key, nested], index) => {
            const nestedLines = formatActivityJson(nested, depth + 1);
            const nestedIndent = "  ".repeat(depth + 1);
            lines.push(`${nestedIndent}${JSON.stringify(key)}: ${nestedLines[0].slice(nestedIndent.length)}`, ...nestedLines.slice(1));
            if (index < entries.length - 1)
                lines[lines.length - 1] += ",";
        });
        lines.push(`${indent}}`);
        return lines;
    }
    return [`${indent}${JSON.stringify(value)}`];
}
function serializeActivityValue(value) {
    const seen = new WeakSet();
    let text;
    try {
        const normalized = JSON.stringify(value, (_key, nested) => {
            if (typeof nested === "bigint")
                return nested.toString();
            if (nested && typeof nested === "object") {
                if (seen.has(nested))
                    return "[Circular]";
                seen.add(nested);
            }
            return nested;
        }) ?? JSON.stringify(String(value));
        text = formatActivityJson(JSON.parse(normalized)).join("\n");
    }
    catch {
        text = JSON.stringify(String(value));
    }
    const redacted = redactActivityText(text);
    if (redacted.length <= TELEGRAM_ACTIVITY_DETAIL_MAX_CHARS)
        return redacted;
    const omitted = redacted.length - TELEGRAM_ACTIVITY_DETAIL_MAX_CHARS;
    return `${redacted.slice(0, TELEGRAM_ACTIVITY_DETAIL_MAX_CHARS)}\n… [${omitted} chars truncated]`;
}
function neutralizeActivityAutoLinks(text) {
    return text.replace(/\b(https?:\/\/)(?=\S)/gi, "$1\u200b");
}
function escapeActivityEvidenceHtml(text) {
    return escapeHtml(neutralizeActivityAutoLinks(text));
}
function renderThinkingActivityEvidenceHtml(text) {
    return renderTelegramInlineMarkdownHtml(neutralizeActivityAutoLinks(text), {
        allowLinks: false,
    });
}
function formatToolActivityLabel(label) {
    return label
        .split("_")
        .filter(Boolean)
        .map((word) => {
        const repeatedPrefix = word.match(/^([a-z])\1*/iu)?.[0] ?? "";
        if (repeatedPrefix.length === 2 || repeatedPrefix.length === 3) {
            return `${repeatedPrefix.toUpperCase()}${word.slice(repeatedPrefix.length)}`;
        }
        return `${word[0].toUpperCase()}${word.slice(1)}`;
    })
        .join(" ");
}
function renderToolActivityHtml(tool) {
    const evidence = [`"arguments": ${tool.args}`];
    if (tool.droppedUpdates > 0) {
        evidence.push(`… [${tool.droppedUpdates} earlier updates omitted]`);
    }
    tool.updates.forEach((update, index) => {
        evidence.push(`"update ${tool.droppedUpdates + index + 1}": ${update}`);
    });
    if (tool.complete && tool.result !== undefined) {
        evidence.push(`"${tool.isError ? "error" : "result"}": ${tool.result}`);
    }
    const status = tool.complete
        ? tool.isError
            ? "failed"
            : "done"
        : "running";
    return [
        `<b>${escapeHtml(formatToolActivityLabel(tool.name))}:</b> <code>${status}</code>`,
        `<blockquote expandable>${escapeActivityEvidenceHtml(evidence.join("\n\n"))}</blockquote>`,
    ].join("\n");
}
export function renderTelegramToolActivityHtml(tools) {
    return tools.map(renderToolActivityHtml).join("\n\n");
}
function createToolActivityDetail(summary, text, isOpen = false) {
    return {
        type: "details",
        summary: { type: "code", text: summary },
        blocks: [{ type: "pre", text, language: "json" }],
        ...(isOpen ? { is_open: true } : {}),
    };
}
function renderToolActivityRichBlocks(tool) {
    const status = tool.complete
        ? tool.isError
            ? "failed"
            : "done"
        : "running";
    const evidenceBlocks = [
        createToolActivityDetail("arguments", tool.args, true),
    ];
    tool.updates.forEach((update, index) => {
        const number = tool.droppedUpdates + index + 1;
        const omitted = index === 0 && tool.droppedUpdates > 0
            ? ` (${tool.droppedUpdates} earlier omitted)`
            : "";
        evidenceBlocks.push(createToolActivityDetail(`update ${number}${omitted}`, update));
    });
    if (tool.complete && tool.result !== undefined) {
        evidenceBlocks.push(createToolActivityDetail(tool.isError ? "error" : "result", tool.result));
    }
    return [
        {
            type: "details",
            summary: [
                {
                    type: "bold",
                    text: `${formatToolActivityLabel(tool.name)}:`,
                },
                " ",
                { type: "code", text: status },
            ],
            blocks: evidenceBlocks,
        },
    ];
}
export function renderTelegramToolActivityRichMessage(tools) {
    return {
        blocks: tools.flatMap(renderToolActivityRichBlocks),
        skip_entity_detection: true,
    };
}
function toolMessageSize(tools) {
    return renderTelegramToolActivityHtml(tools).length;
}
function isKnownSafeRichActivityRejection(error) {
    return error instanceof Error && /HTTP 400: Bad Request:/i.test(error.message);
}
export function renderTelegramThinkingActivityHtml(text) {
    return `<blockquote expandable>${renderThinkingActivityEvidenceHtml(text)}</blockquote>`;
}
export function createTelegramActivityVerbosityBinding() {
    let runtime;
    return {
        bind(next) {
            runtime = next;
        },
        accept(event) {
            runtime?.accept(event);
        },
        reset() {
            runtime?.reset();
        },
        stop() {
            runtime?.stop();
        },
        waitForIdle() {
            return runtime?.waitForIdle() ?? Promise.resolve();
        },
    };
}
export function createTelegramActivityVerbosityRuntime(deps) {
    let active = true;
    let generation = 0;
    let tail = Promise.resolve();
    const getNowMs = deps.getNowMs ?? Date.now;
    let activityId;
    let authority;
    let target;
    let reasoningBuffer = "";
    let reasoningChars = 0;
    let reasoningMessageFrames = 0;
    let lastReasoningMessageChars = 0;
    let reasoningMessage;
    let reasoningBlocked = false;
    let lastReasoningPublishMs = 0;
    let reasoningFlushTimer;
    let toolMessage;
    const tools = new Map();
    const toolOrder = [];
    const clearReasoningFlushTimer = () => {
        if (!reasoningFlushTimer)
            return;
        (deps.clearReasoningTimeout ?? clearTimeout)(reasoningFlushTimer);
        reasoningFlushTimer = undefined;
    };
    const clearActivity = () => {
        clearReasoningFlushTimer();
        activityId = undefined;
        authority = undefined;
        target = undefined;
        reasoningBuffer = "";
        reasoningChars = 0;
        reasoningMessageFrames = 0;
        lastReasoningMessageChars = 0;
        reasoningMessage = undefined;
        reasoningBlocked = false;
        lastReasoningPublishMs = 0;
        toolMessage = undefined;
        tools.clear();
        toolOrder.length = 0;
    };
    const hasAuthority = () => authority !== undefined && deps.isAuthorityActive(authority);
    const isCurrent = (acceptedGeneration, admittedAuthority) => active && generation === acceptedGeneration && admittedAuthority !== undefined && deps.isAuthorityActive(admittedAuthority);
    const ensureActivity = (event, admittedTarget, admittedAuthority) => {
        if (deps.getActivityMode() === "quiet")
            return false;
        if (activityId === event.activityId)
            return hasAuthority();
        clearActivity();
        if (!admittedTarget)
            return false;
        activityId = event.activityId;
        target = admittedTarget;
        authority = admittedAuthority;
        return hasAuthority();
    };
    const closeToolBatch = () => {
        toolMessage = undefined;
    };
    const publishReasoning = async (event, acceptedGeneration) => {
        const admittedAuthority = authority;
        if (!isCurrent(acceptedGeneration, admittedAuthority) ||
            !target ||
            reasoningBlocked) {
            return;
        }
        let retained = reasoningBuffer;
        let body = "";
        do {
            const omitted = reasoningChars - retained.length;
            const text = redactActivityText(omitted > 0
                ? `… [${omitted} earlier chars omitted]\n${retained}`
                : retained);
            body = renderTelegramThinkingActivityHtml(text);
            if (body.length <= TELEGRAM_ACTIVITY_MESSAGE_MAX_CHARS)
                break;
            retained = retained.slice(-Math.max(1, Math.floor(retained.length * 0.75)));
        } while (retained.length > 1);
        const canEdit = reasoningMessage && targetEquals(reasoningMessage.target, target);
        try {
            if (canEdit && reasoningMessage) {
                await deps.editMessageText({
                    chat_id: target.chatId,
                    message_id: reasoningMessage.messageId,
                    text: body,
                    parse_mode: "HTML",
                    link_preview_options: { is_disabled: true },
                });
            }
            else {
                const sent = await deps.sendMessage({
                    chat_id: target.chatId,
                    ...(target.threadId === undefined
                        ? {}
                        : { message_thread_id: target.threadId }),
                    text: body,
                    parse_mode: "HTML",
                    link_preview_options: { is_disabled: true },
                });
                if (!isCurrent(acceptedGeneration, admittedAuthority))
                    return;
                reasoningMessage = {
                    messageId: sent.message_id,
                    target: { ...target },
                };
            }
            if (!isCurrent(acceptedGeneration, admittedAuthority))
                return;
            reasoningMessageFrames += 1;
            lastReasoningMessageChars = reasoningChars;
            lastReasoningPublishMs = getNowMs();
        }
        catch (error) {
            if (!isCurrent(acceptedGeneration, admittedAuthority))
                return;
            reasoningBlocked = true;
            deps.recordFailure?.(canEdit ? "reasoning-edit" : "reasoning-send", event, error);
        }
    };
    const scheduleReasoningPublish = (event, acceptedGeneration) => {
        if (reasoningFlushTimer || reasoningBlocked)
            return;
        const elapsed = reasoningMessageFrames === 0
            ? 0
            : getNowMs() - lastReasoningPublishMs;
        const delayMs = Math.max(0, TELEGRAM_REASONING_MIN_INTERVAL_MS - elapsed);
        const schedule = deps.setReasoningTimeout ?? setTimeout;
        reasoningFlushTimer = schedule(() => {
            reasoningFlushTimer = undefined;
            const admittedAuthority = authority;
            const task = async () => {
                if (!isCurrent(acceptedGeneration, admittedAuthority) ||
                    reasoningChars <= lastReasoningMessageChars)
                    return;
                await publishReasoning(event, acceptedGeneration);
            };
            const enqueue = deps.enqueue ?? ((next) => tail.then(next));
            tail = enqueue(task).catch((error) => {
                deps.recordFailure?.("reasoning-send", event, error);
            });
        }, delayMs);
        reasoningFlushTimer?.unref?.();
    };
    const publishTool = async (event, tool, acceptedGeneration) => {
        const admittedAuthority = authority;
        if (!isCurrent(acceptedGeneration, admittedAuthority) || !target) {
            return;
        }
        const canAppend = toolMessage &&
            targetEquals(toolMessage.target, target) &&
            toolMessage.tools.length < TELEGRAM_ACTIVITY_MESSAGE_MAX_TOOLS &&
            toolMessageSize([...toolMessage.tools, tool]) <=
                TELEGRAM_ACTIVITY_MESSAGE_MAX_CHARS;
        try {
            if (canAppend && toolMessage) {
                const nextTools = [...toolMessage.tools, tool];
                try {
                    await deps.editMessageText({
                        chat_id: target.chatId,
                        message_id: toolMessage.messageId,
                        ...(toolMessage.format === "rich"
                            ? {
                                rich_message: renderTelegramToolActivityRichMessage(nextTools),
                            }
                            : {
                                text: renderTelegramToolActivityHtml(nextTools),
                                parse_mode: "HTML",
                                link_preview_options: { is_disabled: true },
                            }),
                    });
                }
                catch (error) {
                    if (!isCurrent(acceptedGeneration, admittedAuthority))
                        return;
                    if (toolMessage.format !== "rich" ||
                        !isKnownSafeRichActivityRejection(error)) {
                        throw error;
                    }
                    await deps.editMessageText({
                        chat_id: target.chatId,
                        message_id: toolMessage.messageId,
                        text: renderTelegramToolActivityHtml(nextTools),
                        parse_mode: "HTML",
                        link_preview_options: { is_disabled: true },
                    });
                    if (!isCurrent(acceptedGeneration, admittedAuthority))
                        return;
                    toolMessage.format = "html";
                }
                if (!isCurrent(acceptedGeneration, admittedAuthority))
                    return;
                toolMessage.tools = nextTools;
                return;
            }
            const body = {
                chat_id: target.chatId,
                ...(target.threadId === undefined
                    ? {}
                    : { message_thread_id: target.threadId }),
            };
            let sent;
            let format = "rich";
            try {
                sent = await deps.sendRichMessage({
                    ...body,
                    rich_message: renderTelegramToolActivityRichMessage([tool]),
                });
            }
            catch (error) {
                if (!isCurrent(acceptedGeneration, admittedAuthority))
                    return;
                if (!isKnownSafeRichActivityRejection(error))
                    throw error;
                sent = await deps.sendMessage({
                    ...body,
                    text: renderTelegramToolActivityHtml([tool]),
                    parse_mode: "HTML",
                    link_preview_options: { is_disabled: true },
                });
                format = "html";
            }
            if (!isCurrent(acceptedGeneration, admittedAuthority))
                return;
            toolMessage = {
                messageId: sent.message_id,
                tools: [tool],
                target: { ...target },
                format,
            };
        }
        catch (error) {
            if (!isCurrent(acceptedGeneration, admittedAuthority))
                return;
            closeToolBatch();
            deps.recordFailure?.(canAppend ? "tool-edit" : "tool-send", event, error);
        }
    };
    const process = async (event, acceptedGeneration, admittedTarget, admittedAuthority) => {
        if (event.type === "agent-start" && deps.refreshActivityMode) {
            try {
                await deps.refreshActivityMode();
            }
            catch (error) {
                if (!isCurrent(acceptedGeneration, admittedAuthority))
                    return;
                clearActivity();
                activityId = event.activityId;
                deps.recordFailure?.("config-refresh", event, error);
                return;
            }
        }
        if (!isCurrent(acceptedGeneration, admittedAuthority))
            return;
        if (!ensureActivity(event, admittedTarget, admittedAuthority)) {
            if (activityId === event.activityId &&
                deps.getActivityMode() === "quiet") {
                clearActivity();
            }
            return;
        }
        const mode = deps.getActivityMode();
        const showThinking = mode === "thinking" || mode === "verbose";
        const showTools = mode === "tools" || mode === "verbose";
        if (event.type === "assistant-text-delta" ||
            event.type === "assistant-segment" ||
            event.type === "reasoning-delta" ||
            event.type === "reasoning-end") {
            closeToolBatch();
        }
        if (event.type === "reasoning-delta") {
            if (!showThinking)
                return;
            reasoningChars += event.delta.length;
            reasoningBuffer = `${reasoningBuffer}${event.delta}`.slice(-TELEGRAM_REASONING_BUFFER_MAX_CHARS);
            if (reasoningMessageFrames < TELEGRAM_REASONING_MESSAGE_MAX_FRAMES) {
                scheduleReasoningPublish(event, acceptedGeneration);
            }
            return;
        }
        if (event.type === "reasoning-end") {
            if (!showThinking)
                return;
            if (reasoningChars === 0 && event.text) {
                reasoningChars = event.text.length;
                reasoningBuffer = event.text.slice(-TELEGRAM_REASONING_BUFFER_MAX_CHARS);
            }
            clearReasoningFlushTimer();
            if (reasoningChars > 0 &&
                reasoningChars > lastReasoningMessageChars &&
                !reasoningBlocked) {
                await publishReasoning(event, acceptedGeneration);
            }
            if (!isCurrent(acceptedGeneration, admittedAuthority))
                return;
            reasoningBuffer = "";
            reasoningChars = 0;
            reasoningMessageFrames = 0;
            lastReasoningMessageChars = 0;
            lastReasoningPublishMs = 0;
            reasoningMessage = undefined;
            reasoningBlocked = false;
            return;
        }
        if (event.type === "tool-start") {
            if (!showTools)
                return;
            tools.set(event.toolCallId, {
                id: event.toolCallId,
                name: event.toolName,
                args: serializeActivityValue(event.args),
                updates: [],
                droppedUpdates: 0,
                complete: false,
            });
            toolOrder.push(event.toolCallId);
            return;
        }
        if (event.type === "tool-update") {
            if (!showTools)
                return;
            const tool = tools.get(event.toolCallId);
            if (!tool)
                return;
            tool.updates.push(serializeActivityValue(event.update));
            if (tool.updates.length > TELEGRAM_TOOL_UPDATE_MAX_ENTRIES) {
                tool.updates.shift();
                tool.droppedUpdates += 1;
            }
            return;
        }
        if (event.type === "tool-end") {
            if (!showTools)
                return;
            const tool = tools.get(event.toolCallId) ?? {
                id: event.toolCallId,
                name: event.toolName,
                args: serializeActivityValue(undefined),
                updates: [],
                droppedUpdates: 0,
                complete: false,
            };
            if (!tools.has(event.toolCallId))
                toolOrder.push(event.toolCallId);
            tool.result = serializeActivityValue(event.result);
            tool.isError = event.isError;
            tool.complete = true;
            tools.set(event.toolCallId, tool);
            while (toolOrder.length > 0) {
                const next = tools.get(toolOrder[0]);
                if (!next?.complete)
                    break;
                toolOrder.shift();
                tools.delete(next.id);
                await publishTool(event, next, acceptedGeneration);
                if (!isCurrent(acceptedGeneration, admittedAuthority))
                    return;
            }
            return;
        }
        if (event.type === "agent-end" || event.type === "agent-settled") {
            clearReasoningFlushTimer();
            if (reasoningChars > lastReasoningMessageChars &&
                !reasoningBlocked) {
                await publishReasoning(event, acceptedGeneration);
            }
            if (!isCurrent(acceptedGeneration, admittedAuthority))
                return;
            clearActivity();
        }
    };
    return {
        accept(event) {
            if (!active)
                return;
            const acceptedGeneration = generation;
            const resolvedTarget = deps.resolveTarget(event);
            const admittedTarget = resolvedTarget ? { ...resolvedTarget } : undefined;
            const admittedAuthority = deps.captureAuthority();
            const enqueue = deps.enqueue ?? ((task) => tail.then(task));
            tail = enqueue(async () => {
                if (!active || generation !== acceptedGeneration || !deps.isAuthorityActive(admittedAuthority))
                    return;
                await process(event, acceptedGeneration, admittedTarget, admittedAuthority);
            })
                .catch((error) => {
                deps.recordFailure?.("tool-send", event, error);
            });
        },
        reset() {
            generation += 1;
            clearActivity();
            tail = Promise.resolve();
        },
        stop() {
            active = false;
            generation += 1;
            clearActivity();
            tail = Promise.resolve();
        },
        waitForIdle() {
            return tail;
        },
    };
}
