/**
 * Telegram outbound markup parsing helpers
 * Zones: telegram outbound, assistant markup
 * Owns top-level assistant action comment extraction, attribute parsing, and markup stripping shared by voice and outbound delivery
 */

export interface TelegramTopLevelHtmlComment {
  raw: string;
  content: string;
  start: number;
  end: number;
}

interface TelegramTopLevelFenceState {
  marker: "`" | "~";
  length: number;
}

function isTelegramActionCommentContent(content: string): boolean {
  const normalizedContent = content.replace(/^\s+/, "");
  const [head = ""] = normalizedContent.split(/\r?\n/, 1);
  return ["telegram_voice", "telegram_button"].some((command) => {
    if (!head.startsWith(command)) return false;
    const nextChar = head[command.length];
    return nextChar === undefined || /\s|:/.test(nextChar);
  });
}

function getMarkdownLineEnd(markdown: string, offset: number): number {
  const newlineIndex = markdown.indexOf("\n", offset);
  return newlineIndex === -1 ? markdown.length : newlineIndex + 1;
}

function getMarkdownLineText(
  markdown: string,
  offset: number,
  end: number,
): string {
  return markdown.slice(offset, end).replace(/\r?\n$/, "");
}

function getTopLevelOpeningFence(
  line: string,
): TelegramTopLevelFenceState | undefined {
  const match = line.match(/^(?: {0,3})(`{3,}|~{3,})/);
  const sequence = match?.[1];
  if (!sequence) return undefined;
  return {
    marker: sequence[0] as "`" | "~",
    length: sequence.length,
  };
}

function isTopLevelClosingFence(
  line: string,
  fence: TelegramTopLevelFenceState,
): boolean {
  const match = line.match(/^(?: {0,3})(`{3,}|~{3,})([ \t]*)$/);
  const sequence = match?.[1];
  return (
    !!sequence &&
    sequence[0] === fence.marker &&
    sequence.length >= fence.length
  );
}

function collectPairedTelegramVoiceActionBody(
  markdown: string,
  bodyStart: number,
  commentContent: string,
): { content: string; end: number } | undefined {
  const normalizedContent = commentContent.trim();
  if (
    !normalizedContent.startsWith("telegram_voice") ||
    !isTelegramActionCommentContent(commentContent)
  ) {
    return undefined;
  }
  let offset = bodyStart;
  while (offset < markdown.length) {
    const lineEnd = getMarkdownLineEnd(markdown, offset);
    const line = getMarkdownLineText(markdown, offset, lineEnd);
    if (line === "<!-- /telegram_voice -->") {
      const body = markdown.slice(bodyStart, offset).trim();
      if (!body) return undefined;
      return {
        content: `${commentContent.trimEnd()}\n${body}`,
        end: lineEnd,
      };
    }
    if (line.startsWith("<!--")) return undefined;
    offset = lineEnd;
  }
  return undefined;
}

function collectInlineClosedTelegramActionBody(
  markdown: string,
  bodyStart: number,
  commentContent: string,
): { content: string; end: number } | undefined {
  const bodyLineEnd = getMarkdownLineEnd(markdown, bodyStart);
  const bodyLine = getMarkdownLineText(markdown, bodyStart, bodyLineEnd);
  const closeLineEnd = getMarkdownLineEnd(markdown, bodyLineEnd);
  const closeLine = getMarkdownLineText(markdown, bodyLineEnd, closeLineEnd);
  const hasRecoverableBody =
    isTelegramActionCommentContent(commentContent) &&
    bodyLine.trim() !== "" &&
    !bodyLine.startsWith("<!--") &&
    !bodyLine.startsWith("-->") &&
    closeLine === "-->";
  if (!hasRecoverableBody) return undefined;
  return {
    content: `${commentContent.trimEnd()}\n${bodyLine}`,
    end: bodyLineEnd + 3,
  };
}

export function collectTopLevelHtmlComments(markdown: string): {
  comments: TelegramTopLevelHtmlComment[];
  openCommentStart?: number;
} {
  const comments: TelegramTopLevelHtmlComment[] = [];
  let offset = 0;
  let fence: TelegramTopLevelFenceState | undefined;
  while (offset < markdown.length) {
    const lineEnd = getMarkdownLineEnd(markdown, offset);
    const line = getMarkdownLineText(markdown, offset, lineEnd);
    if (fence) {
      if (isTopLevelClosingFence(line, fence)) fence = undefined;
      offset = lineEnd;
      continue;
    }
    const nextFence = getTopLevelOpeningFence(line);
    if (nextFence) {
      fence = nextFence;
      offset = lineEnd;
      continue;
    }
    if (line.startsWith("<!--")) {
      const closeIndex = markdown.indexOf("-->", offset + 4);
      if (closeIndex === -1) return { comments, openCommentStart: offset };
      let end = closeIndex + 3;
      let raw = markdown.slice(offset, end);
      let content = raw.slice(4, -3);
      const closeColumn = closeIndex - offset;
      const closesOnOpeningLine = closeIndex < lineEnd;
      const hasOnlyWhitespaceAfterClose =
        line.slice(closeColumn + 3).trim() === "";
      const pairedVoiceBody =
        closesOnOpeningLine && hasOnlyWhitespaceAfterClose
          ? collectPairedTelegramVoiceActionBody(markdown, lineEnd, content)
          : undefined;
      const inlineBody =
        !pairedVoiceBody && closesOnOpeningLine && hasOnlyWhitespaceAfterClose
          ? collectInlineClosedTelegramActionBody(markdown, lineEnd, content)
          : undefined;
      const recoveredBody = pairedVoiceBody ?? inlineBody;
      if (recoveredBody) {
        end = recoveredBody.end;
        raw = markdown.slice(offset, end);
        content = recoveredBody.content;
      }
      comments.push({ raw, content, start: offset, end });
      offset = getMarkdownLineEnd(markdown, end);
      continue;
    }
    offset = lineEnd;
  }
  return { comments };
}

export function replaceTopLevelHtmlComments(
  markdown: string,
  replacer: (comment: TelegramTopLevelHtmlComment) => string,
): string {
  const { comments } = collectTopLevelHtmlComments(markdown);
  if (comments.length === 0) return markdown;
  let result = "";
  let offset = 0;
  for (const comment of comments) {
    result += markdown.slice(offset, comment.start);
    result += replacer(comment);
    offset = comment.end;
  }
  return result + markdown.slice(offset);
}

export function findTopLevelOpenOrPartialHtmlCommentIndex(
  markdown: string,
): number {
  const { openCommentStart } = collectTopLevelHtmlComments(markdown);
  if (openCommentStart !== undefined) return openCommentStart;
  let offset = 0;
  let fence: TelegramTopLevelFenceState | undefined;
  while (offset < markdown.length) {
    const lineEnd = getMarkdownLineEnd(markdown, offset);
    const line = getMarkdownLineText(markdown, offset, lineEnd);
    const isLastLine = lineEnd >= markdown.length;
    if (fence) {
      if (isTopLevelClosingFence(line, fence)) fence = undefined;
      offset = lineEnd;
      continue;
    }
    const nextFence = getTopLevelOpeningFence(line);
    if (nextFence) {
      fence = nextFence;
      offset = lineEnd;
      continue;
    }
    if (isLastLine && (line === "<" || line === "<!" || line === "<!-")) {
      return offset;
    }
    offset = lineEnd;
  }
  return -1;
}

export function parseTopLevelTelegramComment(
  comment: TelegramTopLevelHtmlComment,
  command: string,
): { head: string; body?: string } | undefined {
  let normalizedContent = comment.content.replace(/^\s+/, "");
  normalizedContent = normalizedContent.replace(/^!/, "");
  const [rawHead = "", ...bodyLines] = normalizedContent.split(/\r?\n/);
  let head = rawHead.trimStart();
  if (!head.startsWith(command)) return undefined;
  const nextChar = head[command.length];
  if (nextChar !== undefined && !/\s|:/.test(nextChar)) return undefined;
  return {
    head: head.slice(command.length),
    ...(bodyLines.length > 0 ? { body: bodyLines.join("\n") } : {}),
  };
}

export function parseTelegramCommentAttributes(
  input: string,
): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of input.matchAll(
    /([A-Za-z_][A-Za-z0-9_-]*)=(?:"([^"]*)"|'([^']*)'|(\S+))/g,
  )) {
    const key = match[1];
    const value = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (value) attributes[key] = value;
  }
  return attributes;
}

export function normalizeMarkdownAfterVoiceExtraction(
  markdown: string,
): string {
  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}

export function stripTelegramCommentMarkupForPreview(markdown: string): string {
  const withoutClosedBlocks = replaceTopLevelHtmlComments(markdown, () => "");
  const openBlockIndex =
    findTopLevelOpenOrPartialHtmlCommentIndex(withoutClosedBlocks);
  const previewMarkdown =
    openBlockIndex >= 0
      ? withoutClosedBlocks.slice(0, openBlockIndex)
      : withoutClosedBlocks;
  return normalizeMarkdownAfterVoiceExtraction(previewMarkdown);
}

export function stripTelegramCommentMarkupForDelivery(
  markdown: string,
): string {
  const withoutClosedBlocks = replaceTopLevelHtmlComments(markdown, () => "");
  const openBlockIndex =
    findTopLevelOpenOrPartialHtmlCommentIndex(withoutClosedBlocks);
  const deliveryMarkdown =
    openBlockIndex >= 0
      ? withoutClosedBlocks.slice(0, openBlockIndex)
      : withoutClosedBlocks;
  return normalizeMarkdownAfterVoiceExtraction(deliveryMarkdown);
}

export function stripTelegramVoiceMarkupForPreview(markdown: string): string {
  return stripTelegramCommentMarkupForPreview(markdown);
}

export interface TelegramVoiceReplyItem {
  text: string;
  lang?: string;
  rate?: string;
}

export interface TelegramVoiceReplyPlan {
  markdown: string;
  voiceText?: string;
  voiceReplies?: TelegramVoiceReplyItem[];
  lang?: string;
  rate?: string;
}

function parseVoiceReplyAttributes(input: string): {
  lang?: string;
  rate?: string;
  text?: string;
} {
  const attributes = parseTelegramCommentAttributes(input);
  return {
    ...(attributes.lang ? { lang: attributes.lang } : {}),
    ...(attributes.rate ? { rate: attributes.rate } : {}),
    ...(attributes.text ? { text: attributes.text } : {}),
  };
}

function parseVoiceCommentBody(
  head: string,
  body: string | undefined,
): {
  attrs: string;
  text: string;
} {
  const trimmedHead = head.trim();
  if (body !== undefined) {
    return { attrs: trimmedHead.replace(/^:/, "").trim(), text: body.trim() };
  }
  let colonIndex = -1;
  let inQuote = false;
  let quoteChar = "";
  for (let i = 0; i < trimmedHead.length; i++) {
    const char = trimmedHead[i];
    if (inQuote) {
      if (char === quoteChar) inQuote = false;
    } else {
      if (char === '"' || char === "'") {
        inQuote = true;
        quoteChar = char;
      } else if (char === ":") {
        colonIndex = i;
        break;
      }
    }
  }
  if (colonIndex > 0) {
    const attrsPart = trimmedHead.slice(0, colonIndex).trim();
    const textPart = trimmedHead.slice(colonIndex + 1).trim();
    const attrs = parseVoiceReplyAttributes(attrsPart);
    return { attrs: attrsPart, text: textPart || attrs.text || "", ...attrs };
  }
  if (trimmedHead.startsWith(":")) {
    return { attrs: "", text: trimmedHead.slice(1).trim() };
  }
  const attrs = parseVoiceReplyAttributes(trimmedHead);
  return { attrs: trimmedHead, text: attrs.text ?? "" };
}

export function planTelegramVoiceReply(
  markdown: string,
): TelegramVoiceReplyPlan {
  const voiceReplies: TelegramVoiceReplyItem[] = [];
  let lang: string | undefined;
  let rate: string | undefined;
  const stripped = replaceTopLevelHtmlComments(markdown, (comment) => {
    let command = parseTopLevelTelegramComment(comment, "telegram_voice");
    if (!command) {
      let content = comment.content.replace(/^\s+/, "").replace(/^!/, "");
      if (content.startsWith("telegram_voice")) {
        const headPart = content.slice("telegram_voice".length).trim();
        command = { head: headPart, body: undefined };
      }
    }
    if (!command) return "";
    const parsed = parseVoiceCommentBody(command.head, command.body);
    const attrs = parseVoiceReplyAttributes(parsed.attrs);
    if (parsed.text) {
      voiceReplies.push({
        text: parsed.text,
        ...(attrs.lang ? { lang: attrs.lang } : {}),
        ...(attrs.rate ? { rate: attrs.rate } : {}),
      });
    }
    if (attrs.lang) lang = attrs.lang;
    if (attrs.rate) rate = attrs.rate;
    return "";
  });
  const voiceText = voiceReplies
    .map((reply) => reply.text)
    .join("\n\n")
    .trim();
  return {
    markdown: stripTelegramCommentMarkupForDelivery(stripped),
    ...(voiceText ? { voiceText } : {}),
    ...(voiceReplies.length > 0 ? { voiceReplies } : {}),
    ...(lang ? { lang } : {}),
    ...(rate ? { rate } : {}),
  };
}
