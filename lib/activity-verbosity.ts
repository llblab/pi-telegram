/**
 * Bridge-owned Telegram activity verbosity projection
 * Zones: telegram activity, rich rendering, operational delivery
 * Owns persistent bounded thinking and tool disclosures; excludes activity normalization, assistant answer rendering, and transport authority policy
 */

import type {
  TelegramActivityEvent,
  TelegramActivityPublicationRuntime,
} from "./activity.ts";
import { escapeHtml, renderTelegramInlineMarkdownHtml } from "./rendering.ts";
import {
  areTelegramTargetsEqual as targetEquals,
  type TelegramTarget,
} from "./target.ts";
import type {
  TelegramEditMessageTextBody,
  TelegramInputRichBlock,
  TelegramInputRichMessage,
  TelegramSendMessageBody,
  TelegramSendRichMessageBody,
  TelegramSentMessage,
} from "./telegram-api.ts";

const TELEGRAM_ACTIVITY_DETAIL_MAX_CHARS = 1_200;
const TELEGRAM_ACTIVITY_MESSAGE_MAX_CHARS = 3_900;
export const TELEGRAM_ACTIVITY_MESSAGE_MAX_TOOLS = 6;
const TELEGRAM_REASONING_MESSAGE_MAX_FRAMES = 24;
export const TELEGRAM_REASONING_BUFFER_MAX_CHARS = 1_200;
// Match native answer drafts: accumulate the opening frame for one full
// interval, then publish at most one updated frame per interval.
const TELEGRAM_REASONING_MIN_INTERVAL_MS = 2_000;
export const TELEGRAM_TOOL_UPDATE_MAX_ENTRIES = 4;

// Stream mode: one message per turn carrying quoted thinking/tool lines
// above the live answer tail; edits are throttled like native drafts.
const TELEGRAM_STREAM_MIN_INTERVAL_MS = 2_000;
const TELEGRAM_STREAM_MAX_CHARS = TELEGRAM_ACTIVITY_MESSAGE_MAX_CHARS;
const TELEGRAM_STREAM_THINKING_TAIL_CHARS = 600;
const TELEGRAM_STREAM_MAX_TOOL_LINES = 8;
const TELEGRAM_STREAM_ARGS_MAX_CHARS = 90;
const TELEGRAM_STREAM_ANSWER_TAIL_CHARS = 2_400;
const TELEGRAM_STREAM_MAX_FRAMES = 150;

interface StreamToolLine {
  id: string;
  name: string;
  argsLine: string;
  status: "running" | "done" | "failed";
}

interface StreamMessageState {
  activityId: string;
  messageId?: number;
  target?: TelegramTarget;
  lastBody?: string;
  thinking: string;
  thinkingClosed: boolean;
  tools: StreamToolLine[];
  droppedTools: number;
  answer: string;
  frames: number;
  lastPublishMs: number;
  blocked: boolean;
  settled: boolean;
  lastEvent?: TelegramActivityEvent;
}

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

function redactActivityText(text: string): string {
  return text
    .replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, "[REDACTED_BOT_TOKEN]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}\b/gi, "$1[REDACTED]")
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
      JSON.stringify(value, (_key, nested) => {
        if (typeof nested === "bigint") return nested.toString();
        if (nested && typeof nested === "object") {
          if (seen.has(nested)) return "[Circular]";
          seen.add(nested);
        }
        return nested;
      }) ?? JSON.stringify(String(value));
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

function formatToolActivityLabel(label: string): string {
  return label
    .split("_")
    .filter(Boolean)
    .map((word) => {
      const repeatedPrefix = word.match(/^([a-z])\1*/iu)?.[0] ?? "";
      if (repeatedPrefix.length === 2 || repeatedPrefix.length === 3) {
        return `${repeatedPrefix.toUpperCase()}${word.slice(repeatedPrefix.length)}`;
      }
      return `${word[0]!.toUpperCase()}${word.slice(1)}`;
    })
    .join(" ");
}

function truncateStreamText(text: string): string {
  const redacted = redactActivityText(text);
  return redacted.length <= TELEGRAM_STREAM_ARGS_MAX_CHARS
    ? redacted
    : `${redacted.slice(0, TELEGRAM_STREAM_ARGS_MAX_CHARS - 1)}…`;
}

/** One compact `key: first-line value` for a tool's arguments. */
export function buildTelegramStreamArgsLine(args: unknown): string {
  const firstLine = (text: string): string =>
    text.trim().split("\n")[0]?.trim() ?? "";
  if (typeof args === "string") return truncateStreamText(firstLine(args));
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim())
        return truncateStreamText(`${key}: ${firstLine(value)}`);
      if (typeof value === "number" || typeof value === "boolean")
        return truncateStreamText(`${key}: ${value}`);
    }
    return "";
  }
  if (args === undefined || args === null) return "";
  return truncateStreamText(firstLine(String(args)));
}

export function buildTelegramStreamToolLineHtml(tool: StreamToolLine): string {
  const args = tool.argsLine
    ? `\n<code>${escapeActivityEvidenceHtml(tool.argsLine)}</code>`
    : "";
  return `🔧 <b>${escapeHtml(formatToolActivityLabel(tool.name))}</b> <code>${tool.status}</code>${args}`;
}

/**
 * Pure composition of the single stream message: quoted thinking, one quoted
 * block of compact tool lines, then the live answer tail as inline HTML.
 */
export function buildTelegramStreamMessageHtml(input: {
  thinking: string;
  tools: readonly StreamToolLine[];
  droppedTools: number;
  answer: string;
}): string {
  const parts: string[] = [];
  if (input.thinking.trim()) {
    parts.push(
      `<blockquote expandable>💭 ${renderThinkingActivityEvidenceHtml(redactActivityText(input.thinking))}</blockquote>`,
    );
  }
  if (input.tools.length > 0) {
    const rows = input.tools.map(buildTelegramStreamToolLineHtml);
    if (input.droppedTools > 0) {
      rows.unshift(`… [${input.droppedTools} earlier tools]`);
    }
    parts.push(`<blockquote>${rows.join("\n")}</blockquote>`);
  }
  if (input.answer.trim()) {
    parts.push(
      renderTelegramInlineMarkdownHtml(
        neutralizeActivityAutoLinks(redactActivityText(input.answer)),
        { allowLinks: false },
      ),
    );
  }
  return parts.join("\n\n");
}

/** Compose under the message cap, trimming tools, then thinking, never the answer's head. */
function composeStreamBody(
  state: StreamMessageState,
  thinkingCap = TELEGRAM_STREAM_THINKING_TAIL_CHARS,
  answerCap = TELEGRAM_STREAM_ANSWER_TAIL_CHARS,
): string {
  let toolCount = state.tools.length;
  const build = (thinkingCapNow: number, answerCapNow: number): string =>
    buildTelegramStreamMessageHtml({
      thinking: state.thinking.slice(-Math.max(1, Math.floor(thinkingCapNow))),
      tools: state.tools.slice(state.tools.length - toolCount),
      droppedTools: state.droppedTools + (state.tools.length - toolCount),
      answer: state.answer.slice(-Math.max(1, Math.floor(answerCapNow))),
    });
  let thinkingCapNow = thinkingCap;
  let answerCapNow = answerCap;
  let html = build(thinkingCapNow, answerCapNow);
  while (html.length > TELEGRAM_STREAM_MAX_CHARS && toolCount > 0) {
    toolCount -= 1;
    html = build(thinkingCapNow, answerCapNow);
  }
  while (
    html.length > TELEGRAM_STREAM_MAX_CHARS &&
    thinkingCapNow > 80
  ) {
    thinkingCapNow = Math.floor(thinkingCapNow * 0.6);
    html = build(thinkingCapNow, answerCapNow);
  }
  while (html.length > TELEGRAM_STREAM_MAX_CHARS && answerCapNow > 80) {
    answerCapNow = Math.floor(answerCapNow * 0.6);
    html = build(thinkingCapNow, answerCapNow);
  }
  return html;
}

function renderToolActivityHtml(tool: ToolActivity): string {
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
  const status = tool.complete ? (tool.isError ? "failed" : "done") : "running";
  return [
    `<b>${escapeHtml(formatToolActivityLabel(tool.name))}:</b> <code>${status}</code>`,
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
    summary: { type: "code", text: summary },
    blocks: [{ type: "pre", text, language: "json" }],
    ...(isOpen ? { is_open: true as const } : {}),
  };
}

function renderToolActivityRichBlocks(
  tool: ToolActivity,
): TelegramInputRichBlock[] {
  const status = tool.complete ? (tool.isError ? "failed" : "done") : "running";
  const evidenceBlocks: TelegramInputRichBlock[] = [
    createToolActivityDetail("arguments", tool.args, true),
  ];
  tool.updates.forEach((update, index) => {
    const number = tool.droppedUpdates + index + 1;
    const omitted =
      index === 0 && tool.droppedUpdates > 0
        ? ` (${tool.droppedUpdates} earlier omitted)`
        : "";
    evidenceBlocks.push(
      createToolActivityDetail(`update ${number}${omitted}`, update),
    );
  });
  if (tool.complete && tool.result !== undefined) {
    evidenceBlocks.push(
      createToolActivityDetail(tool.isError ? "error" : "result", tool.result),
    );
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
  return (
    error instanceof Error && /HTTP 400: Bad Request:/i.test(error.message)
  );
}

export function renderTelegramThinkingActivityHtml(text: string): string {
  return `<blockquote expandable>${renderThinkingActivityEvidenceHtml(text)}</blockquote>`;
}

export interface TelegramActivityVerbosityRuntime {
  accept: (event: TelegramActivityEvent) => void;
  reset: () => void;
  stop: () => void;
  waitForIdle: () => Promise<void>;
  /** Delete the live stream-mode message and drop its state; safe with no message. */
  clearStreamMessage: () => Promise<void>;
  /** Message id of the live stream-mode message, for diagnostics and tests. */
  getStreamMessageId: () => number | undefined;
}

export function createTelegramActivityVerbosityRuntime<TAuthority>(deps: {
  enqueue?: TelegramActivityPublicationRuntime["enqueue"];
  getActivityMode: () => "quiet" | "thinking" | "tools" | "verbose" | "stream";
  refreshActivityMode?: () => Promise<void>;
  getNowMs?: () => number;
  setReasoningTimeout?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearReasoningTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
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
  deleteMessage?: (chatId: number, messageId: number) => Promise<void>;
  recordFailure?: (
    operation:
      | "config-refresh"
      | "reasoning-send"
      | "reasoning-edit"
      | "tool-send"
      | "tool-edit"
      | "stream-send"
      | "stream-edit"
      | "stream-delete",
    event: TelegramActivityEvent,
    error: unknown,
  ) => void;
}): TelegramActivityVerbosityRuntime {
  let active = true;
  let generation = 0;
  let tail = Promise.resolve();
  const getNowMs = deps.getNowMs ?? Date.now;
  let activityId: string | undefined;
  let authority: TAuthority | undefined;
  let target: TelegramTarget | undefined;
  let reasoningBuffer = "";
  let reasoningChars = 0;
  let reasoningMessageFrames = 0;
  let lastReasoningMessageChars = 0;
  let reasoningMessage: ReasoningMessage | undefined;
  let reasoningBlocked = false;
  let lastReasoningPublishMs = 0;
  let reasoningFlushTimer: ReturnType<typeof setTimeout> | undefined;
  let toolMessage: ToolMessage | undefined;
  const tools = new Map<string, ToolActivity>();
  const toolOrder: string[] = [];
  let stream: StreamMessageState | undefined;
  let streamTimer: ReturnType<typeof setTimeout> | undefined;

  const clearReasoningFlushTimer = () => {
    if (!reasoningFlushTimer) return;
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
  const clearStreamTimer = () => {
    if (!streamTimer) return;
    (deps.clearReasoningTimeout ?? clearTimeout)(streamTimer);
    streamTimer = undefined;
  };
  const clearStreamState = () => {
    clearStreamTimer();
    stream = undefined;
  };
  /** A replaced activity takes its stream message with it: best-effort delete behind the queue. */
  const retireStream = () => {
    const retiring = stream;
    clearStreamTimer();
    stream = undefined;
    if (!retiring?.messageId || !retiring.target || !deps.deleteMessage) return;
    const chatId = retiring.target.chatId;
    const messageId = retiring.messageId;
    const enqueue =
      deps.enqueue ?? ((next: () => Promise<void>) => tail.then(next));
    tail = enqueue(async () => {
      if (!active) return;
      await deps.deleteMessage?.(chatId, messageId);
    }).catch(() => undefined);
  };
  const hasAuthority = (): boolean =>
    authority !== undefined && deps.isAuthorityActive(authority);
  const isCurrent = (
    acceptedGeneration: number,
    admittedAuthority: TAuthority | undefined,
  ): boolean =>
    active &&
    generation === acceptedGeneration &&
    admittedAuthority !== undefined &&
    deps.isAuthorityActive(admittedAuthority);
  const ensureActivity = (
    event: TelegramActivityEvent,
    admittedTarget: TelegramTarget | undefined,
    admittedAuthority: TAuthority,
  ): boolean => {
    if (deps.getActivityMode() === "quiet") return false;
    if (activityId === event.activityId) return hasAuthority();
    retireStream();
    clearActivity();
    if (!admittedTarget) return false;
    activityId = event.activityId;
    target = admittedTarget;
    authority = admittedAuthority;
    return hasAuthority();
  };
  const closeToolBatch = () => {
    toolMessage = undefined;
  };
  const publishReasoning = async (
    event: TelegramActivityEvent,
    acceptedGeneration: number,
  ) => {
    const admittedAuthority = authority;
    if (
      !isCurrent(acceptedGeneration, admittedAuthority) ||
      !target ||
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
      retained = retained.slice(
        -Math.max(1, Math.floor(retained.length * 0.75)),
      );
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
        if (!isCurrent(acceptedGeneration, admittedAuthority)) return;
        reasoningMessage = {
          messageId: sent.message_id,
          target: { ...target },
        };
      }
      if (!isCurrent(acceptedGeneration, admittedAuthority)) return;
      reasoningMessageFrames += 1;
      lastReasoningMessageChars = reasoningChars;
      lastReasoningPublishMs = getNowMs();
    } catch (error) {
      if (!isCurrent(acceptedGeneration, admittedAuthority)) return;
      reasoningBlocked = true;
      deps.recordFailure?.(
        canEdit ? "reasoning-edit" : "reasoning-send",
        event,
        error,
      );
    }
  };
  const scheduleReasoningPublish = (
    event: TelegramActivityEvent,
    acceptedGeneration: number,
  ) => {
    if (reasoningFlushTimer || reasoningBlocked) return;
    const elapsed =
      reasoningMessageFrames === 0 ? 0 : getNowMs() - lastReasoningPublishMs;
    const delayMs = Math.max(0, TELEGRAM_REASONING_MIN_INTERVAL_MS - elapsed);
    const schedule = deps.setReasoningTimeout ?? setTimeout;
    reasoningFlushTimer = schedule(() => {
      reasoningFlushTimer = undefined;
      const admittedAuthority = authority;
      const task = async () => {
        if (
          !isCurrent(acceptedGeneration, admittedAuthority) ||
          reasoningChars <= lastReasoningMessageChars
        )
          return;
        await publishReasoning(event, acceptedGeneration);
      };
      const enqueue =
        deps.enqueue ?? ((next: () => Promise<void>) => tail.then(next));
      tail = enqueue(task).catch((error) => {
        deps.recordFailure?.("reasoning-send", event, error);
      });
    }, delayMs) as ReturnType<typeof setTimeout>;
    reasoningFlushTimer?.unref?.();
  };
  const publishStream = async (
    event: TelegramActivityEvent,
    acceptedGeneration: number,
  ) => {
    const admittedAuthority = authority;
    if (
      !isCurrent(acceptedGeneration, admittedAuthority) ||
      !target ||
      !stream ||
      stream.blocked
    ) {
      return;
    }
    const state = stream;
    const body = composeStreamBody(state);
    if (!body) return;
    if (body === state.lastBody) {
      state.lastPublishMs = getNowMs();
      return;
    }
    const canEdit =
      state.messageId !== undefined &&
      state.target !== undefined &&
      targetEquals(state.target, target);
    try {
      if (canEdit && state.messageId !== undefined) {
        await deps.editMessageText({
          chat_id: target.chatId,
          message_id: state.messageId,
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
        if (!isCurrent(acceptedGeneration, admittedAuthority)) return;
        state.messageId = sent.message_id;
        state.target = { ...target };
      }
      if (!isCurrent(acceptedGeneration, admittedAuthority)) return;
      state.lastBody = body;
      state.lastPublishMs = getNowMs();
      state.frames += 1;
    } catch (error) {
      if (!isCurrent(acceptedGeneration, admittedAuthority)) return;
      state.blocked = true;
      clearStreamTimer();
      deps.recordFailure?.(
        canEdit ? "stream-edit" : "stream-send",
        event,
        error,
      );
    }
  };
  const scheduleStreamPublish = (
    event: TelegramActivityEvent,
    acceptedGeneration: number,
    immediate = false,
  ) => {
    if (!stream || stream.blocked || stream.settled) return;
    if (stream.frames >= TELEGRAM_STREAM_MAX_FRAMES) return;
    if (streamTimer && !immediate) return;
    const elapsed =
      stream.frames === 0 ? 0 : getNowMs() - stream.lastPublishMs;
    const delayMs = immediate
      ? 0
      : Math.max(0, TELEGRAM_STREAM_MIN_INTERVAL_MS - elapsed);
    const schedule = deps.setReasoningTimeout ?? setTimeout;
    if (streamTimer) (deps.clearReasoningTimeout ?? clearTimeout)(streamTimer);
    streamTimer = schedule(() => {
      streamTimer = undefined;
      const admittedAuthority = authority;
      const task = async () => {
        if (
          !isCurrent(acceptedGeneration, admittedAuthority) ||
          !stream ||
          stream.settled
        )
          return;
        await publishStream(event, acceptedGeneration);
      };
      const enqueue =
        deps.enqueue ?? ((next: () => Promise<void>) => tail.then(next));
      tail = enqueue(task).catch((error) => {
        deps.recordFailure?.("stream-send", event, error);
      });
    }, delayMs) as ReturnType<typeof setTimeout>;
    streamTimer?.unref?.();
  };
  const processStream = async (
    event: TelegramActivityEvent,
    acceptedGeneration: number,
  ) => {
    const admittedAuthority = authority;
    if (!isCurrent(acceptedGeneration, admittedAuthority) || !target) return;
    if (!stream) {
      stream = {
        activityId: event.activityId,
        thinking: "",
        thinkingClosed: false,
        tools: [],
        droppedTools: 0,
        answer: "",
        frames: 0,
        lastPublishMs: 0,
        blocked: false,
        settled: false,
      };
    }
    const state = stream;
    state.lastEvent = event;
    if (state.settled) return;
    if (event.type === "reasoning-delta") {
      if (state.thinkingClosed) {
        state.thinking = "";
        state.thinkingClosed = false;
      }
      state.thinking = (state.thinking + event.delta).slice(
        -TELEGRAM_STREAM_THINKING_TAIL_CHARS,
      );
      scheduleStreamPublish(event, acceptedGeneration);
      return;
    }
    if (event.type === "reasoning-end") {
      if (!state.thinking && event.text) {
        state.thinking = event.text.slice(
          -TELEGRAM_STREAM_THINKING_TAIL_CHARS,
        );
      }
      state.thinkingClosed = true;
      scheduleStreamPublish(event, acceptedGeneration);
      return;
    }
    if (event.type === "tool-start") {
      state.tools.push({
        id: event.toolCallId,
        name: event.toolName,
        argsLine: buildTelegramStreamArgsLine(event.args),
        status: "running",
      });
      while (state.tools.length > TELEGRAM_STREAM_MAX_TOOL_LINES) {
        state.tools.shift();
        state.droppedTools += 1;
      }
      scheduleStreamPublish(event, acceptedGeneration, true);
      return;
    }
    if (event.type === "tool-update") return;
    if (event.type === "tool-end") {
      const tool = state.tools.find((entry) => entry.id === event.toolCallId);
      if (tool) {
        tool.status = event.isError ? "failed" : "done";
      } else {
        state.tools.push({
          id: event.toolCallId,
          name: event.toolName,
          argsLine: "",
          status: event.isError ? "failed" : "done",
        });
        while (state.tools.length > TELEGRAM_STREAM_MAX_TOOL_LINES) {
          state.tools.shift();
          state.droppedTools += 1;
        }
      }
      scheduleStreamPublish(event, acceptedGeneration, true);
      return;
    }
    if (event.type === "assistant-text-delta") {
      state.answer = (state.answer + event.delta).slice(
        -TELEGRAM_STREAM_ANSWER_TAIL_CHARS,
      );
      scheduleStreamPublish(event, acceptedGeneration);
      return;
    }
    if (event.type === "assistant-segment") {
      if (event.text.trim()) {
        state.answer = event.text.slice(
          -TELEGRAM_STREAM_ANSWER_TAIL_CHARS,
        );
        scheduleStreamPublish(event, acceptedGeneration);
      }
      return;
    }
    if (event.type === "agent-end" || event.type === "agent-settled") {
      clearStreamTimer();
      await publishStream(event, acceptedGeneration);
      if (!isCurrent(acceptedGeneration, admittedAuthority)) return;
      state.settled = true;
    }
  };
  const publishTool = async (
    event: TelegramActivityEvent,
    tool: ToolActivity,
    acceptedGeneration: number,
  ) => {
    const admittedAuthority = authority;
    if (!isCurrent(acceptedGeneration, admittedAuthority) || !target) {
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
          if (!isCurrent(acceptedGeneration, admittedAuthority)) return;
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
          if (!isCurrent(acceptedGeneration, admittedAuthority)) return;
          toolMessage.format = "html";
        }
        if (!isCurrent(acceptedGeneration, admittedAuthority)) return;
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
        if (!isCurrent(acceptedGeneration, admittedAuthority)) return;
        if (!isKnownSafeRichActivityRejection(error)) throw error;
        sent = await deps.sendMessage({
          ...body,
          text: renderTelegramToolActivityHtml([tool]),
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        format = "html";
      }
      if (!isCurrent(acceptedGeneration, admittedAuthority)) return;
      toolMessage = {
        messageId: sent.message_id,
        tools: [tool],
        target: { ...target },
        format,
      };
    } catch (error) {
      if (!isCurrent(acceptedGeneration, admittedAuthority)) return;
      closeToolBatch();
      deps.recordFailure?.(canAppend ? "tool-edit" : "tool-send", event, error);
    }
  };
  const process = async (
    event: TelegramActivityEvent,
    acceptedGeneration: number,
    admittedTarget: TelegramTarget | undefined,
    admittedAuthority: TAuthority,
  ) => {
    if (event.type === "agent-start" && deps.refreshActivityMode) {
      try {
        await deps.refreshActivityMode();
      } catch (error) {
        if (!isCurrent(acceptedGeneration, admittedAuthority)) return;
        clearActivity();
        activityId = event.activityId;
        deps.recordFailure?.("config-refresh", event, error);
        return;
      }
    }
    if (!isCurrent(acceptedGeneration, admittedAuthority)) return;
    if (!ensureActivity(event, admittedTarget, admittedAuthority)) {
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
    if (mode === "stream") {
      await processStream(event, acceptedGeneration);
      return;
    }
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
      if (reasoningMessageFrames < TELEGRAM_REASONING_MESSAGE_MAX_FRAMES) {
        scheduleReasoningPublish(event, acceptedGeneration);
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
      clearReasoningFlushTimer();
      if (
        reasoningChars > 0 &&
        reasoningChars > lastReasoningMessageChars &&
        !reasoningBlocked
      ) {
        await publishReasoning(event, acceptedGeneration);
      }
      if (!isCurrent(acceptedGeneration, admittedAuthority)) return;
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
        if (!isCurrent(acceptedGeneration, admittedAuthority)) return;
      }
      return;
    }
    if (event.type === "agent-end" || event.type === "agent-settled") {
      clearReasoningFlushTimer();
      if (reasoningChars > lastReasoningMessageChars && !reasoningBlocked) {
        await publishReasoning(event, acceptedGeneration);
      }
      if (!isCurrent(acceptedGeneration, admittedAuthority)) return;
      clearActivity();
    }
  };
  return {
    accept(event) {
      if (!active) return;
      const acceptedGeneration = generation;
      const resolvedTarget = deps.resolveTarget(event);
      const admittedTarget = resolvedTarget ? { ...resolvedTarget } : undefined;
      const admittedAuthority = deps.captureAuthority();
      const enqueue =
        deps.enqueue ?? ((task: () => Promise<void>) => tail.then(task));
      tail = enqueue(async () => {
        if (
          !active ||
          generation !== acceptedGeneration ||
          !deps.isAuthorityActive(admittedAuthority)
        )
          return;
        await process(
          event,
          acceptedGeneration,
          admittedTarget,
          admittedAuthority,
        );
      }).catch((error) => {
        deps.recordFailure?.("tool-send", event, error);
      });
    },
    reset() {
      generation += 1;
      clearActivity();
      clearStreamState();
      tail = Promise.resolve();
    },
    stop() {
      active = false;
      generation += 1;
      clearActivity();
      clearStreamState();
      tail = Promise.resolve();
    },
    async clearStreamMessage() {
      const state = stream;
      clearStreamState();
      const queued = tail;
      await queued.catch(() => undefined);
      if (!state?.messageId || !state.target || !deps.deleteMessage) return;
      const chatId = state.target.chatId;
      const messageId = state.messageId;
      if (!active) return;
      try {
        await deps.deleteMessage(chatId, messageId);
      } catch (error) {
        deps.recordFailure?.(
          "stream-delete",
          state.lastEvent ?? {
            activityId: state.activityId,
            sequence: 0,
            source: "telegram",
            timestamp: 0,
            type: "agent-settled",
          },
          error,
        );
      }
    },
    getStreamMessageId() {
      return stream?.messageId;
    },
    waitForIdle() {
      return tail;
    },
  };
}
