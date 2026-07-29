/**
 * Bridge-owned Telegram activity verbosity projection
 * Zones: telegram activity, rich rendering, operational delivery
 * Owns persistent bounded thinking and tool disclosures; excludes activity normalization, assistant answer rendering, and transport authority policy
 */

import type { TelegramActivityEvent } from "./activity.ts";
import {
  escapeHtml,
  renderTelegramInlineMarkdownHtml,
} from "./rendering.ts";
import type {
  TelegramEditMessageTextBody,
  TelegramInputRichBlock,
  TelegramInputRichMessage,
  TelegramSendMessageBody,
  TelegramSendRichMessageBody,
  TelegramSentMessage,
} from "./telegram-api.ts";
import type { TelegramTarget } from "./target.ts";

export const TELEGRAM_ACTIVITY_DETAIL_MAX_CHARS = 1_200;
export const TELEGRAM_ACTIVITY_MESSAGE_MAX_CHARS = 3_900;
export const TELEGRAM_ACTIVITY_MESSAGE_MAX_TOOLS = 6;
export const TELEGRAM_REASONING_MESSAGE_MAX_FRAMES = 24;
export const TELEGRAM_REASONING_BUFFER_MAX_CHARS = 1_200;
export const TELEGRAM_TOOL_UPDATE_MAX_ENTRIES = 4;

interface ToolActivity {
  id: string;
  name: string;
  args: string;
  updates: string[];
  droppedUpdates: number;
  result?: string;
  isError?: boolean;
  complete: boolean;
}

interface ToolMessage {
  messageId: number;
  tools: ToolActivity[];
  target: TelegramTarget;
  format: "rich" | "html";
}

interface ReasoningMessage {
  messageId: number;
  target: TelegramTarget;
}

function targetEquals(left: TelegramTarget, right: TelegramTarget): boolean {
  return left.chatId === right.chatId && left.threadId === right.threadId;
}

function redactActivityText(text: string): string {
  return text
    .replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, "[REDACTED_BOT_TOKEN]")
    .replace(
      /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}\b/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(["']?(?:api[_-]?key|token|password|secret)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
      "$1[REDACTED]",
    );
}

function formatActivityJson(value: unknown, depth = 0): string[] {
  const indent = "  ".repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}[]`];
    if (
      value.every(
        (entry) =>
          entry !== null && typeof entry === "object" && !Array.isArray(entry),
      )
    ) {
      const lines = [`${indent}[{`];
      value.forEach((entry, index) => {
        const fields = Object.entries(entry as Record<string, unknown>);
        fields.forEach(([key, nested], fieldIndex) => {
          const nestedLines = formatActivityJson(nested, depth + 1);
          const nestedIndent = "  ".repeat(depth + 1);
          lines.push(
            `${nestedIndent}${JSON.stringify(key)}: ${nestedLines[0]!.slice(nestedIndent.length)}`,
            ...nestedLines.slice(1),
          );
          if (fieldIndex < fields.length - 1) {
            lines[lines.length - 1] += ",";
          }
        });
        lines.push(
          index < value.length - 1 ? `${indent}}, {` : `${indent}}]`,
        );
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
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [`${indent}{}`];
    const lines = [`${indent}{`];
    entries.forEach(([key, nested], index) => {
      const nestedLines = formatActivityJson(nested, depth + 1);
      const nestedIndent = "  ".repeat(depth + 1);
      lines.push(
        `${nestedIndent}${JSON.stringify(key)}: ${nestedLines[0]!.slice(nestedIndent.length)}`,
        ...nestedLines.slice(1),
      );
      if (index < entries.length - 1) lines[lines.length - 1] += ",";
    });
    lines.push(`${indent}}`);
    return lines;
  }
  return [`${indent}${JSON.stringify(value)}`];
}

function serializeActivityValue(value: unknown): string {
  const seen = new WeakSet<object>();
  let text: string;
  try {
    const normalized =
      JSON.stringify(
        value,
        (_key, nested) => {
          if (typeof nested === "bigint") return nested.toString();
          if (nested && typeof nested === "object") {
            if (seen.has(nested)) return "[Circular]";
            seen.add(nested);
          }
          return nested;
        },
      ) ?? JSON.stringify(String(value));
    text = formatActivityJson(JSON.parse(normalized)).join("\n");
  } catch {
    text = JSON.stringify(String(value));
  }
  const redacted = redactActivityText(text);
  if (redacted.length <= TELEGRAM_ACTIVITY_DETAIL_MAX_CHARS) return redacted;
  const omitted = redacted.length - TELEGRAM_ACTIVITY_DETAIL_MAX_CHARS;
  return `${redacted.slice(0, TELEGRAM_ACTIVITY_DETAIL_MAX_CHARS)}\n… [${omitted} chars truncated]`;
}

function neutralizeActivityAutoLinks(text: string): string {
  return text.replace(/\b(https?:\/\/)(?=\S)/gi, "$1\u200b");
}

function escapeActivityEvidenceHtml(text: string): string {
  return escapeHtml(neutralizeActivityAutoLinks(text));
}

function renderThinkingActivityEvidenceHtml(text: string): string {
  return renderTelegramInlineMarkdownHtml(neutralizeActivityAutoLinks(text), {
    allowLinks: false,
  });
}

function capitalizeActivityLabel(label: string): string {
  return label.length > 0 ? `${label[0]!.toUpperCase()}${label.slice(1)}` : label;
}

function renderToolActivityHtml(tool: ToolActivity): string {
  const evidence = [`"arguments": ${tool.args}`];
  if (tool.droppedUpdates > 0) {
    evidence.push(`… [${tool.droppedUpdates} earlier updates omitted]`);
  }
  tool.updates.forEach((update, index) => {
    evidence.push(
      `"update ${tool.droppedUpdates + index + 1}": ${update}`,
    );
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
    `<b>${escapeHtml(capitalizeActivityLabel(tool.name))}:</b> <code>${status}</code>`,
    `<blockquote expandable>${escapeActivityEvidenceHtml(evidence.join("\n\n"))}</blockquote>`,
  ].join("\n");
}

export function renderTelegramToolActivityHtml(
  tools: readonly ToolActivity[],
): string {
  return tools.map(renderToolActivityHtml).join("\n\n");
}

function createToolActivityDetail(
  summary: string,
  text: string,
  isOpen = false,
): TelegramInputRichBlock {
  return {
    type: "details",
    summary: { type: "bold", text: summary },
    blocks: [{ type: "pre", text, language: "json" }],
    ...(isOpen ? { is_open: true as const } : {}),
  };
}

function renderToolActivityRichBlocks(
  tool: ToolActivity,
): TelegramInputRichBlock[] {
  const status = tool.complete
    ? tool.isError
      ? "failed"
      : "done"
    : "running";
  const evidenceBlocks: TelegramInputRichBlock[] = [
    createToolActivityDetail("Arguments", tool.args, true),
  ];
  tool.updates.forEach((update, index) => {
    const number = tool.droppedUpdates + index + 1;
    const omitted =
      index === 0 && tool.droppedUpdates > 0
        ? ` · ${tool.droppedUpdates} earlier omitted`
        : "";
    evidenceBlocks.push(
      createToolActivityDetail(`Update ${number}${omitted}`, update),
    );
  });
  if (tool.complete && tool.result !== undefined) {
    evidenceBlocks.push(
      createToolActivityDetail(tool.isError ? "Error" : "Result", tool.result),
    );
  }
  return [
    {
      type: "details",
      summary: [
        {
          type: "bold",
          text: `${capitalizeActivityLabel(tool.name)}:`,
        },
        " ",
        { type: "code", text: status },
      ],
      blocks: evidenceBlocks,
    },
  ];
}

export function renderTelegramToolActivityRichMessage(
  tools: readonly ToolActivity[],
): TelegramInputRichMessage {
  return {
    blocks: tools.flatMap(renderToolActivityRichBlocks),
    skip_entity_detection: true,
  };
}

function toolMessageSize(tools: readonly ToolActivity[]): number {
  return renderTelegramToolActivityHtml(tools).length;
}

function isKnownSafeRichActivityRejection(error: unknown): boolean {
  return error instanceof Error && /HTTP 400: Bad Request:/i.test(error.message);
}

export function renderTelegramThinkingActivityHtml(text: string): string {
  return `<blockquote expandable>${renderThinkingActivityEvidenceHtml(text)}</blockquote>`;
}

export interface TelegramActivityVerbosityRuntime {
  accept: (event: TelegramActivityEvent) => void;
  reset: () => void;
  stop: () => void;
  waitForIdle: () => Promise<void>;
}

export function createTelegramActivityVerbosityRuntime<TAuthority>(deps: {
  getActivityMode: () => "quiet" | "thinking" | "tools" | "verbose";
  refreshActivityMode?: () => Promise<void>;
  resolveTarget: (event: TelegramActivityEvent) => TelegramTarget | undefined;
  captureAuthority: () => TAuthority;
  isAuthorityActive: (authority: TAuthority) => boolean;
  sendMessage: (body: TelegramSendMessageBody) => Promise<TelegramSentMessage>;
  sendRichMessage: (
    body: TelegramSendRichMessageBody,
  ) => Promise<TelegramSentMessage>;
  editMessageText: (
    body: TelegramEditMessageTextBody,
  ) => Promise<"edited" | "unchanged">;
  recordFailure?: (
    operation:
      | "config-refresh"
      | "reasoning-send"
      | "reasoning-edit"
      | "tool-send"
      | "tool-edit",
    event: TelegramActivityEvent,
    error: unknown,
  ) => void;
}): TelegramActivityVerbosityRuntime {
  let active = true;
  let generation = 0;
  let tail = Promise.resolve();
  let activityId: string | undefined;
  let authority: TAuthority | undefined;
  let target: TelegramTarget | undefined;
  let reasoningBuffer = "";
  let reasoningChars = 0;
  let reasoningMessageFrames = 0;
  let lastReasoningMessageChars = 0;
  let reasoningMessage: ReasoningMessage | undefined;
  let reasoningBlocked = false;
  let toolMessage: ToolMessage | undefined;
  const tools = new Map<string, ToolActivity>();
  const toolOrder: string[] = [];

  const clearActivity = () => {
    activityId = undefined;
    authority = undefined;
    target = undefined;
    reasoningBuffer = "";
    reasoningChars = 0;
    reasoningMessageFrames = 0;
    lastReasoningMessageChars = 0;
    reasoningMessage = undefined;
    reasoningBlocked = false;
    toolMessage = undefined;
    tools.clear();
    toolOrder.length = 0;
  };
  const hasAuthority = (): boolean =>
    authority !== undefined && deps.isAuthorityActive(authority);
  const ensureActivity = (event: TelegramActivityEvent): boolean => {
    if (deps.getActivityMode() === "quiet") return false;
    if (activityId === event.activityId) return hasAuthority();
    clearActivity();
    const resolvedTarget = deps.resolveTarget(event);
    if (!resolvedTarget) return false;
    activityId = event.activityId;
    target = { ...resolvedTarget };
    authority = deps.captureAuthority();
    return hasAuthority();
  };
  const closeToolBatch = () => {
    toolMessage = undefined;
  };
  const publishReasoning = async (
    event: TelegramActivityEvent,
    acceptedGeneration: number,
  ) => {
    if (
      generation !== acceptedGeneration ||
      !target ||
      !hasAuthority() ||
      reasoningBlocked
    ) {
      return;
    }
    let retained = reasoningBuffer;
    let body = "";
    do {
      const omitted = reasoningChars - retained.length;
      const text = redactActivityText(
        omitted > 0
          ? `… [${omitted} earlier chars omitted]\n${retained}`
          : retained,
      );
      body = renderTelegramThinkingActivityHtml(text);
      if (body.length <= TELEGRAM_ACTIVITY_MESSAGE_MAX_CHARS) break;
      retained = retained.slice(-Math.max(1, Math.floor(retained.length * 0.75)));
    } while (retained.length > 1);
    const canEdit =
      reasoningMessage && targetEquals(reasoningMessage.target, target);
    try {
      if (canEdit && reasoningMessage) {
        await deps.editMessageText({
          chat_id: target.chatId,
          message_id: reasoningMessage.messageId,
          text: body,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
      } else {
        const sent = await deps.sendMessage({
          chat_id: target.chatId,
          ...(target.threadId === undefined
            ? {}
            : { message_thread_id: target.threadId }),
          text: body,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        reasoningMessage = {
          messageId: sent.message_id,
          target: { ...target },
        };
      }
      if (generation !== acceptedGeneration) return;
      reasoningMessageFrames += 1;
      lastReasoningMessageChars = reasoningChars;
    } catch (error) {
      deps.recordFailure?.(
        canEdit ? "reasoning-edit" : "reasoning-send",
        event,
        error,
      );
      reasoningBlocked = true;
    }
  };
  const publishTool = async (
    event: TelegramActivityEvent,
    tool: ToolActivity,
    acceptedGeneration: number,
  ) => {
    if (
      generation !== acceptedGeneration ||
      !target ||
      !hasAuthority()
    ) {
      return;
    }
    const canAppend =
      toolMessage &&
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
                  rich_message:
                    renderTelegramToolActivityRichMessage(nextTools),
                }
              : {
                  text: renderTelegramToolActivityHtml(nextTools),
                  parse_mode: "HTML" as const,
                  link_preview_options: { is_disabled: true },
                }),
          });
        } catch (error) {
          if (
            toolMessage.format !== "rich" ||
            !isKnownSafeRichActivityRejection(error)
          ) {
            throw error;
          }
          await deps.editMessageText({
            chat_id: target.chatId,
            message_id: toolMessage.messageId,
            text: renderTelegramToolActivityHtml(nextTools),
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          });
          toolMessage.format = "html";
        }
        if (generation !== acceptedGeneration) return;
        toolMessage.tools = nextTools;
        return;
      }
      const body = {
        chat_id: target.chatId,
        ...(target.threadId === undefined
          ? {}
          : { message_thread_id: target.threadId }),
      };
      let sent: TelegramSentMessage;
      let format: ToolMessage["format"] = "rich";
      try {
        sent = await deps.sendRichMessage({
          ...body,
          rich_message: renderTelegramToolActivityRichMessage([tool]),
        });
      } catch (error) {
        if (!isKnownSafeRichActivityRejection(error)) throw error;
        sent = await deps.sendMessage({
          ...body,
          text: renderTelegramToolActivityHtml([tool]),
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        format = "html";
      }
      if (generation !== acceptedGeneration) return;
      toolMessage = {
        messageId: sent.message_id,
        tools: [tool],
        target: { ...target },
        format,
      };
    } catch (error) {
      deps.recordFailure?.(canAppend ? "tool-edit" : "tool-send", event, error);
      closeToolBatch();
    }
  };
  const process = async (
    event: TelegramActivityEvent,
    acceptedGeneration: number,
  ) => {
    if (event.type === "agent-start" && deps.refreshActivityMode) {
      try {
        await deps.refreshActivityMode();
      } catch (error) {
        deps.recordFailure?.("config-refresh", event, error);
        clearActivity();
        activityId = event.activityId;
        return;
      }
    }
    if (!ensureActivity(event)) {
      if (
        activityId === event.activityId &&
        deps.getActivityMode() === "quiet"
      ) {
        clearActivity();
      }
      return;
    }
    const mode = deps.getActivityMode();
    const showThinking = mode === "thinking" || mode === "verbose";
    const showTools = mode === "tools" || mode === "verbose";
    if (
      event.type === "assistant-text-delta" ||
      event.type === "assistant-segment" ||
      event.type === "reasoning-delta" ||
      event.type === "reasoning-end"
    ) {
      closeToolBatch();
    }
    if (event.type === "reasoning-delta") {
      if (!showThinking) return;
      reasoningChars += event.delta.length;
      reasoningBuffer = `${reasoningBuffer}${event.delta}`.slice(
        -TELEGRAM_REASONING_BUFFER_MAX_CHARS,
      );
      if (
        reasoningMessageFrames < TELEGRAM_REASONING_MESSAGE_MAX_FRAMES &&
        (reasoningMessageFrames === 0 ||
          reasoningChars - lastReasoningMessageChars >= 160)
      ) {
        await publishReasoning(event, acceptedGeneration);
      }
      return;
    }
    if (event.type === "reasoning-end") {
      if (!showThinking) return;
      if (reasoningChars === 0 && event.text) {
        reasoningChars = event.text.length;
        reasoningBuffer = event.text.slice(
          -TELEGRAM_REASONING_BUFFER_MAX_CHARS,
        );
      }
      if (
        reasoningChars > 0 &&
        reasoningChars > lastReasoningMessageChars &&
        !reasoningBlocked
      ) {
        await publishReasoning(event, acceptedGeneration);
      }
      reasoningBuffer = "";
      reasoningChars = 0;
      reasoningMessageFrames = 0;
      lastReasoningMessageChars = 0;
      reasoningMessage = undefined;
      reasoningBlocked = false;
      return;
    }
    if (event.type === "tool-start") {
      if (!showTools) return;
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
      if (!showTools) return;
      const tool = tools.get(event.toolCallId);
      if (!tool) return;
      tool.updates.push(serializeActivityValue(event.update));
      if (tool.updates.length > TELEGRAM_TOOL_UPDATE_MAX_ENTRIES) {
        tool.updates.shift();
        tool.droppedUpdates += 1;
      }
      return;
    }
    if (event.type === "tool-end") {
      if (!showTools) return;
      const tool = tools.get(event.toolCallId) ?? {
        id: event.toolCallId,
        name: event.toolName,
        args: serializeActivityValue(undefined),
        updates: [],
        droppedUpdates: 0,
        complete: false,
      };
      if (!tools.has(event.toolCallId)) toolOrder.push(event.toolCallId);
      tool.result = serializeActivityValue(event.result);
      tool.isError = event.isError;
      tool.complete = true;
      tools.set(event.toolCallId, tool);
      while (toolOrder.length > 0) {
        const next = tools.get(toolOrder[0]!);
        if (!next?.complete) break;
        toolOrder.shift();
        tools.delete(next.id);
        await publishTool(event, next, acceptedGeneration);
        if (generation !== acceptedGeneration) return;
      }
      return;
    }
    if (event.type === "agent-end" || event.type === "agent-settled") {
      if (
        reasoningMessage &&
        reasoningChars > lastReasoningMessageChars &&
        !reasoningBlocked
      ) {
        await publishReasoning(event, acceptedGeneration);
      }
      clearActivity();
    }
  };
  return {
    accept(event) {
      if (!active) return;
      const acceptedGeneration = generation;
      tail = tail
        .then(() => {
          if (!active || generation !== acceptedGeneration) return;
          return process(event, acceptedGeneration);
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
