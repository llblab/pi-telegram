/**
 * Telegram preview and markdown rendering helpers
 * Zones: telegram rendering, shared text utils
 * Converts assistant output into Telegram-safe plain text and HTML chunks with chunk-boundary handling
 */

export const MAX_MESSAGE_LENGTH = 4096;

const TELEGRAM_TABLE_GRAPHEME_SEGMENTER =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;
const TELEGRAM_TABLE_EMOJI_GRAPHEME_PATTERN =
  /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}/u;

// --- HTML Helpers ---

interface OpenHtmlTag {
  name: string;
  openTag: string;
}

const TELEGRAM_VOID_HTML_TAGS = new Set(["br", "hr"]);

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function getHtmlTagName(tag: string): string | undefined {
  return tag.match(/^<\/?\s*([a-zA-Z][\w-]*)/)?.[1]?.toLowerCase();
}

function isHtmlClosingTag(tag: string): boolean {
  return /^<\//.test(tag);
}

function isHtmlSelfClosingTag(tag: string): boolean {
  return /\/\s*>$/.test(tag);
}

function getHtmlClosingTags(openTags: OpenHtmlTag[]): string {
  return [...openTags]
    .reverse()
    .map((tag) => `</${tag.name}>`)
    .join("");
}

function getHtmlOpeningTags(openTags: OpenHtmlTag[]): string {
  return openTags.map((tag) => tag.openTag).join("");
}

function updateOpenHtmlTags(tag: string, openTags: OpenHtmlTag[]): void {
  const name = getHtmlTagName(tag);
  if (!name || TELEGRAM_VOID_HTML_TAGS.has(name)) return;
  if (isHtmlClosingTag(tag)) {
    const index = openTags.map((openTag) => openTag.name).lastIndexOf(name);
    if (index !== -1) openTags.splice(index, 1);
    return;
  }
  if (isHtmlSelfClosingTag(tag)) return;
  openTags.push({ name, openTag: tag });
}

export function chunkHtmlPreservingTags(
  html: string,
  maxLength: number,
): string[] {
  if (html.length <= maxLength) return [html];
  const chunks: string[] = [];
  const openTags: OpenHtmlTag[] = [];
  const tagPattern = /<\/?[a-zA-Z][^>]*>/g;
  let current = "";
  let index = 0;
  const flushCurrent = (): void => {
    if (current.length === 0) return;
    chunks.push(`${current}${getHtmlClosingTags(openTags)}`);
    current = getHtmlOpeningTags(openTags);
  };
  const appendText = (text: string): void => {
    let remaining = text;
    while (remaining.length > 0) {
      const closingTags = getHtmlClosingTags(openTags);
      const available = maxLength - current.length - closingTags.length;
      if (available <= 0) {
        flushCurrent();
        continue;
      }
      const slice = remaining.slice(0, available);
      current += slice;
      remaining = remaining.slice(slice.length);
      if (remaining.length > 0) flushCurrent();
    }
  };
  const appendTag = (tag: string): void => {
    const closingTags = isHtmlClosingTag(tag)
      ? ""
      : getHtmlClosingTags(openTags);
    if (current.length + tag.length + closingTags.length > maxLength) {
      flushCurrent();
    }
    current += tag;
    updateOpenHtmlTags(tag, openTags);
  };
  for (const match of html.matchAll(tagPattern)) {
    appendText(html.slice(index, match.index));
    appendTag(match[0]);
    index = match.index + match[0].length;
  }
  appendText(html.slice(index));
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// --- Plain Preview Rendering ---

function splitPlainMarkdownLine(line: string, maxLength = 1500): string[] {
  if (line.length <= maxLength) return [line];
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [line];
  const parts: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }
    if (current.length > 0) {
      parts.push(current);
      current = "";
    }
    if (word.length <= maxLength) {
      current = word;
      continue;
    }
    for (let i = 0; i < word.length; i += maxLength) {
      parts.push(word.slice(i, i + maxLength));
    }
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts.length > 0 ? parts : [line];
}

interface ParsedMarkdownInlineLink {
  startIndex: number;
  endIndex: number;
  label: string;
  destination: string;
  isImage: boolean;
}

interface ParsedMarkdownAutolink {
  startIndex: number;
  endIndex: number;
  destination: string;
}

function isEscapedMarkdownCharacter(text: string, index: number): boolean {
  let backslashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

function findMarkdownClosingBracket(
  text: string,
  startIndex: number,
): number | undefined {
  let depth = 0;
  for (let index = startIndex; index < text.length; index += 1) {
    if (isEscapedMarkdownCharacter(text, index)) continue;
    const char = text[index] ?? "";
    if (char === "[") {
      depth += 1;
      continue;
    }
    if (char !== "]") continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  return undefined;
}

function parseMarkdownLinkTarget(
  text: string,
  openParenIndex: number,
): { destination: string; endIndex: number } | undefined {
  let index = openParenIndex + 1;
  while (index < text.length && /\s/.test(text[index] ?? "")) {
    index += 1;
  }
  if (index >= text.length) return undefined;
  let destination = "";
  if (text[index] === "<") {
    const destinationStart = index + 1;
    index += 1;
    while (index < text.length) {
      if (!isEscapedMarkdownCharacter(text, index) && text[index] === ">") {
        break;
      }
      index += 1;
    }
    if (index >= text.length) return undefined;
    destination = text.slice(destinationStart, index).trim();
    index += 1;
  } else {
    const destinationStart = index;
    let parenDepth = 0;
    while (index < text.length) {
      if (isEscapedMarkdownCharacter(text, index)) {
        index += 1;
        continue;
      }
      const char = text[index] ?? "";
      if (/\s/.test(char) && parenDepth === 0) break;
      if (char === "(") {
        parenDepth += 1;
        index += 1;
        continue;
      }
      if (char === ")") {
        if (parenDepth === 0) break;
        parenDepth -= 1;
        index += 1;
        continue;
      }
      index += 1;
    }
    destination = text.slice(destinationStart, index).trim();
  }
  if (!destination) return undefined;
  while (index < text.length && /\s/.test(text[index] ?? "")) {
    index += 1;
  }
  if (
    index < text.length &&
    (text[index] === '"' || text[index] === "'" || text[index] === "(")
  ) {
    const titleDelimiter = text[index] ?? '"';
    const closingTitleDelimiter = titleDelimiter === "(" ? ")" : titleDelimiter;
    index += 1;
    while (index < text.length) {
      if (
        !isEscapedMarkdownCharacter(text, index) &&
        text[index] === closingTitleDelimiter
      ) {
        break;
      }
      index += 1;
    }
    if (index >= text.length) return undefined;
    index += 1;
    while (index < text.length && /\s/.test(text[index] ?? "")) {
      index += 1;
    }
  }
  if (text[index] !== ")") return undefined;
  return { destination, endIndex: index };
}

function isSupportedMarkdownLinkDestination(destination: string): boolean {
  return /^(?:https?:\/\/|mailto:)/i.test(destination.trim());
}

function parseMarkdownInlineLinkAt(
  text: string,
  index: number,
): ParsedMarkdownInlineLink | undefined {
  const isImage = text[index] === "!" && text[index + 1] === "[";
  const labelStartIndex = isImage ? index + 1 : index;
  if (text[labelStartIndex] !== "[") return undefined;
  if (
    isEscapedMarkdownCharacter(text, labelStartIndex) ||
    (isImage && isEscapedMarkdownCharacter(text, index))
  ) {
    return undefined;
  }
  const labelEndIndex = findMarkdownClosingBracket(text, labelStartIndex);
  if (labelEndIndex === undefined || text[labelEndIndex + 1] !== "(") {
    return undefined;
  }
  const target = parseMarkdownLinkTarget(text, labelEndIndex + 1);
  if (!target) return undefined;
  return {
    startIndex: index,
    endIndex: target.endIndex,
    label: text.slice(labelStartIndex + 1, labelEndIndex),
    destination: target.destination,
    isImage,
  };
}

function parseMarkdownAutolinkAt(
  text: string,
  index: number,
): ParsedMarkdownAutolink | undefined {
  if (text[index] !== "<" || isEscapedMarkdownCharacter(text, index)) {
    return undefined;
  }
  let endIndex = index + 1;
  while (endIndex < text.length) {
    if (!isEscapedMarkdownCharacter(text, endIndex) && text[endIndex] === ">") {
      break;
    }
    endIndex += 1;
  }
  if (endIndex >= text.length) return undefined;
  const destination = text.slice(index + 1, endIndex).trim();
  if (!isSupportedMarkdownLinkDestination(destination)) {
    return undefined;
  }
  return { startIndex: index, endIndex, destination };
}

function replaceMarkdownLink(
  text: string,
  options: {
    renderInlineLink: (
      link: ParsedMarkdownInlineLink,
      supported: boolean,
    ) => string;
    renderAutolink: (link: ParsedMarkdownAutolink) => string;
  },
): string {
  let result = "";
  for (let index = 0; index < text.length; ) {
    const inlineLink = parseMarkdownInlineLinkAt(text, index);
    if (inlineLink) {
      result += options.renderInlineLink(
        inlineLink,
        isSupportedMarkdownLinkDestination(inlineLink.destination),
      );
      index = inlineLink.endIndex + 1;
      continue;
    }
    const autolink = parseMarkdownAutolinkAt(text, index);
    if (autolink) {
      result += options.renderAutolink(autolink);
      index = autolink.endIndex + 1;
      continue;
    }
    result += text[index] ?? "";
    index += 1;
  }
  return result;
}

function stripInlineMarkdownToPlainText(text: string): string {
  let result = replaceMarkdownLink(text, {
    renderInlineLink: (link, supported) => {
      const plainLabel = stripInlineMarkdownToPlainText(link.label).trim();
      if (plainLabel.length > 0) return plainLabel;
      return supported ? link.destination : "";
    },
    renderAutolink: (link) => link.destination,
  });
  result = result.replace(/`([^`\n]+)`/g, "$1");
  result = result.replace(/(\*\*\*|___)(.+?)\1/g, "$2");
  result = result.replace(/(\*\*|__)(.+?)\1/g, "$2");
  result = result.replace(/(\*|_)(.+?)\1/g, "$2");
  result = result.replace(/~~(.+?)~~/g, "$1");
  result = result.replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, "$1");
  return result;
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
}

function parseMarkdownFence(
  line: string,
): { marker: "`" | "~"; length: number; info?: string } | undefined {
  const match = line.match(/^\s*([`~]{3,})(.*)$/);
  if (!match) return undefined;
  const fence = match[1] ?? "";
  const marker = fence[0];
  if ((marker !== "`" && marker !== "~") || /[^`~]/.test(fence)) {
    return undefined;
  }
  if (!fence.split("").every((char) => char === marker)) return undefined;
  return {
    marker,
    length: fence.length,
    info: (match[2] ?? "").trim() || undefined,
  };
}

function isFencedCodeStart(line: string): boolean {
  return parseMarkdownFence(line) !== undefined;
}

function isMatchingMarkdownFence(
  line: string,
  fence: { marker: "`" | "~"; length: number },
): boolean {
  const match = line.match(/^\s*([`~]{3,})\s*$/);
  if (!match) return false;
  const candidate = match[1] ?? "";
  return (
    candidate.length >= fence.length &&
    candidate[0] === fence.marker &&
    candidate.split("").every((char) => char === fence.marker)
  );
}

function isIndentedCodeLine(line: string): boolean {
  return /^(?:\t| {4,})/.test(line);
}

function isIndentedMarkdownStructureLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    /^(?:[-*+]|\d+\.)\s+\[([ xX])\]\s+/.test(trimmed) ||
    /^(?:[-*+]|\d+\.)\s+/.test(trimmed) ||
    /^>\s?/.test(trimmed) ||
    /^#{1,6}\s+/.test(trimmed) ||
    parseMarkdownFence(trimmed) !== undefined
  );
}

function canStartIndentedCodeBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  if (!isIndentedCodeLine(line)) return false;
  if (isIndentedMarkdownStructureLine(line)) return false;
  if (index === 0) return true;
  return (lines[index - 1] ?? "").trim().length === 0;
}

function stripIndentedCodePrefix(line: string): string {
  if (line.startsWith("\t")) return line.slice(1);
  if (line.startsWith("    ")) return line.slice(4);
  return line;
}

function normalizeMarkdownDocument(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  while (start < lines.length && (lines[start] ?? "").trim().length === 0) {
    start += 1;
  }
  let end = lines.length;
  while (end > start && (lines[end - 1] ?? "").trim().length === 0) {
    end -= 1;
  }
  return lines.slice(start, end).join("\n");
}

function isMarkdownNumberedListMarker(marker: string): boolean {
  return /^\d+\.$/.test(marker);
}

function matchMarkdownHeadingLine(line: string): RegExpMatchArray | null {
  return line.match(/^(\s*)#{1,6}\s+(.+)$/);
}

function endsWithMarkdownHeadingLine(markdown: string): boolean {
  const lines = markdown.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) continue;
    return matchMarkdownHeadingLine(line) !== null;
  }
  return false;
}

function splitLeadingMarkdownBlankLines(markdown: string): {
  blankLines: number;
  remainingText: string;
} {
  const lines = markdown.split("\n");
  let start = 0;
  while (start < lines.length && (lines[start] ?? "").trim().length === 0) {
    start += 1;
  }
  return {
    blankLines: start,
    remainingText: lines.slice(start).join("\n"),
  };
}

export type TelegramPreviewRenderStrategy = "plain" | "rich-stable-blocks";

export interface TelegramPreviewSnapshotState {
  pendingText: string;
  lastSentText: string;
  lastSentParseMode?: "HTML";
  lastSentStrategy?: TelegramPreviewRenderStrategy;
}

export interface TelegramPreviewSnapshot extends TelegramRenderedChunk {
  sourceText: string;
  strategy: TelegramPreviewRenderStrategy;
}

export function buildTelegramPreviewFlushText(options: {
  state: TelegramPreviewSnapshotState;
  maxMessageLength: number;
  renderPreviewText: (markdown: string) => string;
}): string | undefined {
  const rawText = options.state.pendingText.trim();
  const previewText = options.renderPreviewText(rawText).trim();
  if (!previewText || previewText === options.state.lastSentText) {
    return undefined;
  }
  return previewText.length > options.maxMessageLength
    ? previewText.slice(0, options.maxMessageLength)
    : previewText;
}

function buildTelegramPlainPreviewSnapshot(options: {
  sourceText: string;
  state: TelegramPreviewSnapshotState;
  maxMessageLength: number;
  renderPreviewText: (markdown: string) => string;
}): TelegramPreviewSnapshot | undefined {
  const previewText = options.renderPreviewText(options.sourceText).trim();
  if (!previewText) return undefined;
  const truncatedPreviewText =
    previewText.length > options.maxMessageLength
      ? previewText.slice(0, options.maxMessageLength)
      : previewText;
  if (
    truncatedPreviewText === options.state.lastSentText &&
    options.state.lastSentStrategy === "plain"
  ) {
    return undefined;
  }
  return {
    text: truncatedPreviewText,
    sourceText: options.sourceText,
    strategy: "plain",
  };
}

interface TelegramStablePreviewSplit {
  stableMarkdown: string;
  unstableTail: string;
}

function buildTelegramStablePreviewSplit(
  lines: string[],
  stableEndIndex: number,
): TelegramStablePreviewSplit {
  return {
    stableMarkdown: lines.slice(0, stableEndIndex).join("\n"),
    unstableTail: lines.slice(stableEndIndex).join("\n"),
  };
}

function collectTelegramStablePreviewTextBlockLines(
  lines: string[],
  index: number,
): { nextIndex: number } {
  let nextIndex = index;
  while (nextIndex < lines.length) {
    const current = lines[nextIndex] ?? "";
    const following = lines[nextIndex + 1] ?? "";
    if (current.trim().length === 0) break;
    if (
      nextIndex !== index &&
      (isFencedCodeStart(current) ||
        canStartIndentedCodeBlock(lines, nextIndex) ||
        /^\s*>/.test(current) ||
        (current.includes("|") && isMarkdownTableSeparator(following)))
    ) {
      break;
    }
    nextIndex += 1;
  }
  return { nextIndex };
}

function splitTelegramStablePreviewMarkdown(
  markdown: string,
): TelegramStablePreviewSplit {
  const normalized = normalizeMarkdownDocument(markdown);
  if (normalized.length === 0) return { stableMarkdown: "", unstableTail: "" };
  const lines = normalized.split("\n");
  let index = 0;
  let stableEndIndex = 0;
  while (index < lines.length) {
    while (index < lines.length && (lines[index] ?? "").trim().length === 0) {
      index += 1;
    }
    if (index >= lines.length) break;
    const blockStart = index;
    const line = lines[index] ?? "";
    const nextLine = lines[index + 1] ?? "";
    const fence = parseMarkdownFence(line);
    if (fence) {
      const block = collectFencedMarkdownCodeLines(lines, index, fence);
      if (!block.closed) {
        return buildTelegramStablePreviewSplit(lines, stableEndIndex);
      }
      index = block.nextIndex;
      stableEndIndex = index;
      continue;
    }
    if (line.includes("|") && isMarkdownTableSeparator(nextLine)) {
      const block = collectMarkdownTableBlockLines(lines, index);
      index = block.nextIndex;
      if (index >= lines.length) {
        return buildTelegramStablePreviewSplit(lines, stableEndIndex);
      }
      stableEndIndex = index;
      continue;
    }
    if (canStartIndentedCodeBlock(lines, index)) {
      const block = collectIndentedMarkdownCodeLines(lines, index);
      index = block.nextIndex;
      if (index >= lines.length) {
        return buildTelegramStablePreviewSplit(lines, stableEndIndex);
      }
      stableEndIndex = index;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const block = collectMarkdownQuoteBlockLines(lines, index);
      index = block.nextIndex;
      if (index >= lines.length) {
        return buildTelegramStablePreviewSplit(lines, stableEndIndex);
      }
      stableEndIndex = index;
      continue;
    }
    const block = collectTelegramStablePreviewTextBlockLines(lines, blockStart);
    index = block.nextIndex;
    if (index >= lines.length) {
      return buildTelegramStablePreviewSplit(lines, stableEndIndex);
    }
    stableEndIndex = index;
  }
  return buildTelegramStablePreviewSplit(lines, stableEndIndex);
}

function renderTelegramStablePreviewChunk(options: {
  stableMarkdown: string;
  maxMessageLength: number;
  renderTelegramMessage: (
    text: string,
    options?: { mode?: TelegramRenderMode },
  ) => TelegramRenderedChunk[];
}): TelegramRenderedChunk | undefined {
  const stableChunk = options.renderTelegramMessage(options.stableMarkdown, {
    mode: "markdown",
  })[0];
  if (!stableChunk || stableChunk.text.length === 0) return undefined;
  if (stableChunk.text.length > options.maxMessageLength) return undefined;
  return stableChunk;
}

function appendTelegramUnstablePreviewTail(options: {
  previewText: string;
  stableMarkdown: string;
  unstableTail: string;
  maxMessageLength: number;
}): string {
  if (options.unstableTail.length === 0) return options.previewText;
  const tail = splitLeadingMarkdownBlankLines(options.unstableTail);
  const minimumBlankLinesBeforeTail = endsWithMarkdownHeadingLine(
    options.stableMarkdown,
  )
    ? 1
    : 0;
  const blankLinesBeforeTail = Math.max(
    tail.blankLines,
    minimumBlankLinesBeforeTail,
  );
  const separator =
    tail.remainingText.length > 0 ? "\n".repeat(blankLinesBeforeTail + 1) : "";
  const tailText = escapeHtml(tail.remainingText);
  const candidate = `${options.previewText}${separator}${tailText}`;
  return candidate.length <= options.maxMessageLength
    ? candidate
    : options.previewText;
}

function isTelegramPreviewSnapshotUnchanged(options: {
  text: string;
  parseMode?: "HTML";
  state: TelegramPreviewSnapshotState;
  strategy: TelegramPreviewRenderStrategy;
}): boolean {
  return (
    options.text === options.state.lastSentText &&
    options.parseMode === options.state.lastSentParseMode &&
    options.strategy === options.state.lastSentStrategy
  );
}

export function buildTelegramPreviewSnapshot(options: {
  state: TelegramPreviewSnapshotState;
  maxMessageLength: number;
  renderPreviewText: (markdown: string) => string;
  renderTelegramMessage: (
    text: string,
    options?: { mode?: TelegramRenderMode },
  ) => TelegramRenderedChunk[];
}): TelegramPreviewSnapshot | undefined {
  const sourceText = options.state.pendingText.trim();
  if (!sourceText) return undefined;
  const split = splitTelegramStablePreviewMarkdown(sourceText);
  if (split.stableMarkdown.length === 0) {
    return buildTelegramPlainPreviewSnapshot({
      sourceText,
      state: options.state,
      maxMessageLength: options.maxMessageLength,
      renderPreviewText: options.renderPreviewText,
    });
  }
  const stableChunk = renderTelegramStablePreviewChunk({
    stableMarkdown: split.stableMarkdown,
    maxMessageLength: options.maxMessageLength,
    renderTelegramMessage: options.renderTelegramMessage,
  });
  if (!stableChunk) {
    return buildTelegramPlainPreviewSnapshot({
      sourceText,
      state: options.state,
      maxMessageLength: options.maxMessageLength,
      renderPreviewText: options.renderPreviewText,
    });
  }
  const previewText = appendTelegramUnstablePreviewTail({
    previewText: stableChunk.text,
    stableMarkdown: split.stableMarkdown,
    unstableTail: split.unstableTail,
    maxMessageLength: options.maxMessageLength,
  });
  if (
    isTelegramPreviewSnapshotUnchanged({
      text: previewText,
      parseMode: stableChunk.parseMode,
      state: options.state,
      strategy: "rich-stable-blocks",
    })
  ) {
    return undefined;
  }
  return {
    text: previewText,
    parseMode: stableChunk.parseMode,
    sourceText,
    strategy: "rich-stable-blocks",
  };
}

export function renderMarkdownPreviewText(markdown: string): string {
  const normalized = normalizeMarkdownDocument(markdown);
  if (normalized.length === 0) return "";
  const output: string[] = [];
  const lines = normalized.split("\n");
  let activeFence: { marker: "`" | "~"; length: number } | undefined;
  for (const rawLine of lines) {
    const line = rawLine ?? "";
    const fence = parseMarkdownFence(line);
    if (activeFence) {
      if (fence && isMatchingMarkdownFence(line, activeFence)) {
        activeFence = undefined;
        continue;
      }
      if (line.trim().length === 0) {
        output.push("");
        continue;
      }
      output.push(line);
      continue;
    }
    if (fence) {
      activeFence = { marker: fence.marker, length: fence.length };
      continue;
    }
    if (line.trim().length === 0) {
      output.push("");
      continue;
    }
    if (isMarkdownTableSeparator(line)) {
      continue;
    }
    const heading = matchMarkdownHeadingLine(line);
    if (heading) {
      output.push(stripInlineMarkdownToPlainText(heading[2] ?? ""));
      continue;
    }
    const task = line.match(/^(\s*)([-*+]|\d+\.)\s+\[([ xX])\]\s+(.+)$/);
    if (task) {
      const indent = " ".repeat((task[1] ?? "").length);
      const listMarker = task[2] ?? "-";
      const checkboxMarker =
        (task[3] ?? " ").toLowerCase() === "x" ? "[x]" : "[ ]";
      const taskPrefix = isMarkdownNumberedListMarker(listMarker)
        ? `${listMarker} ${checkboxMarker}`
        : checkboxMarker;
      output.push(
        `${indent}${taskPrefix} ${stripInlineMarkdownToPlainText(task[4] ?? "")}`,
      );
      continue;
    }
    const bullet = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bullet) {
      output.push(
        `${" ".repeat((bullet[1] ?? "").length)}- ${stripInlineMarkdownToPlainText(bullet[2] ?? "")}`,
      );
      continue;
    }
    const numbered = line.match(/^(\s*\d+\.)\s+(.+)$/);
    if (numbered) {
      output.push(
        `${numbered[1]} ${stripInlineMarkdownToPlainText(numbered[2] ?? "")}`,
      );
      continue;
    }
    const quote = line.match(/^\s*>\s?(.+)$/);
    if (quote) {
      output.push(`> ${stripInlineMarkdownToPlainText(quote[1] ?? "")}`);
      continue;
    }
    if (/^\s*([-*_]\s*){3,}\s*$/.test(line)) {
      output.push("────────");
      continue;
    }
    output.push(stripInlineMarkdownToPlainText(line));
  }
  return output.join("\n");
}

// --- Rich Markdown Rendering ---

function renderDelimitedInlineStyle(
  text: string,
  delimiter: string,
  render: (content: string) => string,
): string {
  const escapedDelimiter = delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{N}\\\\])(${escapedDelimiter})(?=\\S)(.+?)(?<=\\S)\\2(?=[^\\p{L}\\p{N}]|$)`,
    "gu",
  );
  return text.replace(
    pattern,
    (_match, prefix: string, _wrapped: string, content: string) => {
      return `${prefix}${render(content)}`;
    },
  );
}

interface InlineMarkdownTokenState {
  tokens: string[];
}

function makeInlineMarkdownToken(
  state: InlineMarkdownTokenState,
  html: string,
): string {
  const token = `\uE000${state.tokens.length}\uE001`;
  state.tokens.push(html);
  return token;
}

function stashInlineMarkdownLinks(
  text: string,
  state: InlineMarkdownTokenState,
): string {
  return replaceMarkdownLink(text, {
    renderInlineLink: (link, supported) => {
      const plainLabel = stripInlineMarkdownToPlainText(link.label).trim();
      if (!supported)
        return plainLabel.length > 0 ? plainLabel : link.destination;
      const renderedLabel =
        plainLabel.length > 0 ? plainLabel : link.destination;
      return makeInlineMarkdownToken(
        state,
        `<a href="${escapeHtmlAttribute(link.destination)}">${escapeHtml(renderedLabel)}</a>`,
      );
    },
    renderAutolink: (link) => {
      return makeInlineMarkdownToken(
        state,
        `<a href="${escapeHtmlAttribute(link.destination)}">${escapeHtml(link.destination)}</a>`,
      );
    },
  });
}

function stashInlineMarkdownCodeSpans(
  text: string,
  state: InlineMarkdownTokenState,
): string {
  return text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    return makeInlineMarkdownToken(state, `<code>${escapeHtml(code)}</code>`);
  });
}

function applyInlineMarkdownStyles(text: string): string {
  let result = renderDelimitedInlineStyle(text, "***", (content) => {
    return `<b><i>${content}</i></b>`;
  });
  result = renderDelimitedInlineStyle(result, "___", (content) => {
    return `<b><i>${content}</i></b>`;
  });
  result = renderDelimitedInlineStyle(result, "~~", (content) => {
    return `<s>${content}</s>`;
  });
  result = renderDelimitedInlineStyle(result, "**", (content) => {
    return `<b>${content}</b>`;
  });
  result = renderDelimitedInlineStyle(result, "__", (content) => {
    return `<b>${content}</b>`;
  });
  result = renderDelimitedInlineStyle(result, "*", (content) => {
    return `<i>${content}</i>`;
  });
  return renderDelimitedInlineStyle(result, "_", (content) => {
    return `<i>${content}</i>`;
  });
}

function restoreInlineMarkdownTokens(
  text: string,
  state: InlineMarkdownTokenState,
): string {
  return text.replace(
    /\uE000(\d+)\uE001/g,
    (_match, index: string) => state.tokens[Number(index)] ?? "",
  );
}

function renderInlineMarkdown(text: string): string {
  const tokenState: InlineMarkdownTokenState = { tokens: [] };
  let result = stashInlineMarkdownLinks(text, tokenState);
  result = stashInlineMarkdownCodeSpans(result, tokenState);
  result = escapeHtml(result);
  result = applyInlineMarkdownStyles(result);
  result = result.replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, "$1");
  return restoreInlineMarkdownTokens(result, tokenState);
}

function buildListIndent(level: number): string {
  return "\u00A0".repeat(Math.max(0, level) * 2);
}

function parseMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed
    .split("|")
    .map((cell) => stripInlineMarkdownToPlainText(cell.trim()));
}

function parseMarkdownQuoteLine(
  line: string,
): { depth: number; content: string } | undefined {
  const match = line.match(/^\s*((?:>\s*)+)(.*)$/);
  if (!match) return undefined;
  const markers = match[1] ?? "";
  const depth = (markers.match(/>/g) ?? []).length;
  return {
    depth,
    content: match[2] ?? "",
  };
}

function renderMarkdownTextPiece(piece: string): string {
  const heading = matchMarkdownHeadingLine(piece);
  if (heading) {
    const indent = buildListIndent(Math.floor((heading[1] ?? "").length / 2));
    return `${indent}<b>${renderInlineMarkdown(heading[2] ?? "")}</b>`;
  }
  const task = piece.match(/^(\s*)([-*+]|\d+\.)\s+\[([ xX])\]\s+(.+)$/);
  if (task) {
    const indent = buildListIndent(Math.floor((task[1] ?? "").length / 2));
    const listMarker = task[2] ?? "-";
    const checkboxMarker =
      (task[3] ?? " ").toLowerCase() === "x" ? "[x]" : "[ ]";
    const taskPrefix = isMarkdownNumberedListMarker(listMarker)
      ? `<code>${listMarker}</code> <code>${checkboxMarker}</code>`
      : `<code>${checkboxMarker}</code>`;
    return `${indent}${taskPrefix} ${renderInlineMarkdown(task[4] ?? "")}`;
  }
  const bullet = piece.match(/^(\s*)[-*+]\s+(.+)$/);
  if (bullet) {
    const indent = buildListIndent(Math.floor((bullet[1] ?? "").length / 2));
    return `${indent}<code>-</code> ${renderInlineMarkdown(bullet[2] ?? "")}`;
  }
  const numbered = piece.match(/^(\s*)(\d+)\.\s+(.+)$/);
  if (numbered) {
    const indent = buildListIndent(Math.floor((numbered[1] ?? "").length / 2));
    return `${indent}<code>${numbered[2]}.</code> ${renderInlineMarkdown(numbered[3] ?? "")}`;
  }
  const quote = piece.match(/^>\s?(.+)$/);
  if (quote) {
    return `<blockquote>${renderInlineMarkdown(quote[1] ?? "")}</blockquote>`;
  }
  if (/^([-*_]\s*){3,}$/.test(piece.trim())) return "────────────";
  return renderInlineMarkdown(piece);
}

function renderMarkdownTextLines(block: string): string[] {
  const rendered: string[] = [];
  const lines = block.split("\n");
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    for (const piece of splitPlainMarkdownLine(line)) {
      rendered.push(renderMarkdownTextPiece(piece));
    }
  }
  return rendered;
}

function sanitizeTelegramCodeLanguage(language: string): string {
  return language.split(/\s+/)[0]?.replace(/[^A-Za-z0-9_+.-]/g, "") ?? "";
}

function renderMarkdownCodeBlock(code: string, language?: string): string[] {
  const safeLanguage = language ? sanitizeTelegramCodeLanguage(language) : "";
  const open = safeLanguage
    ? `<pre><code class="language-${escapeHtmlAttribute(safeLanguage)}">`
    : "<pre><code>";
  const close = "</code></pre>";
  const maxContentLength = MAX_MESSAGE_LENGTH - open.length - close.length;
  const chunks: string[] = [];
  let current = "";
  const pushCurrent = (): void => {
    if (current.length === 0) return;
    chunks.push(`${open}${current}${close}`);
    current = "";
  };
  const appendEscapedLine = (escapedLine: string): void => {
    if (escapedLine.length <= maxContentLength) {
      const candidate =
        current.length === 0 ? escapedLine : `${current}\n${escapedLine}`;
      if (candidate.length <= maxContentLength) {
        current = candidate;
        return;
      }
      pushCurrent();
      current = escapedLine;
      return;
    }
    pushCurrent();
    for (let i = 0; i < escapedLine.length; i += maxContentLength) {
      chunks.push(
        `${open}${escapedLine.slice(i, i + maxContentLength)}${close}`,
      );
    }
  };
  for (const line of code.split("\n")) {
    appendEscapedLine(escapeHtml(line));
  }
  pushCurrent();
  return chunks.length > 0 ? chunks : [`${open}${close}`];
}

function isTelegramTableEmojiGrapheme(grapheme: string): boolean {
  return (
    TELEGRAM_TABLE_EMOJI_GRAPHEME_PATTERN.test(grapheme) ||
    grapheme.includes("\u20e3")
  );
}

function getTelegramTableCodePointWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint === 0 || codePoint < 32) return 0;
  if (/\p{Mark}/u.test(char)) return 0;
  if ((codePoint >= 0xfe00 && codePoint <= 0xfe0f) || codePoint === 0x200d)
    return 0;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

function getTelegramTableGraphemes(text: string): string[] {
  if (TELEGRAM_TABLE_GRAPHEME_SEGMENTER) {
    return Array.from(
      TELEGRAM_TABLE_GRAPHEME_SEGMENTER.segment(text),
      (segment) => segment.segment,
    );
  }
  return Array.from(text);
}

function getTelegramTableCellWidth(text: string): number {
  return getTelegramTableGraphemes(text).reduce((width, grapheme) => {
    if (isTelegramTableEmojiGrapheme(grapheme)) return width + 2;
    return (
      width +
      Array.from(grapheme).reduce(
        (sum, char) => sum + getTelegramTableCodePointWidth(char),
        0,
      )
    );
  }, 0);
}

function padTelegramTableCellEnd(cell: string, width: number): string {
  const padding = width - getTelegramTableCellWidth(cell);
  return padding > 0 ? `${cell}${" ".repeat(padding)}` : cell;
}

function renderMarkdownTableBlock(lines: string[]): string[] {
  const rows = lines.map(parseMarkdownTableRow);
  const columnCount = Math.max(...rows.map((row) => row.length), 0);
  const normalizedRows = rows.map((row) => {
    const next = [...row];
    while (next.length < columnCount) {
      next.push("");
    }
    return next;
  });
  const widths = Array.from({ length: columnCount }, (_, columnIndex) => {
    return Math.max(
      3,
      ...normalizedRows.map((row) =>
        getTelegramTableCellWidth(row[columnIndex] ?? ""),
      ),
    );
  });
  const formatRow = (row: string[]): string => {
    return row
      .map((cell, columnIndex) =>
        padTelegramTableCellEnd(cell ?? "", widths[columnIndex] ?? 3),
      )
      .join(" | ");
  };
  const separator = widths.map((width) => "-".repeat(width)).join(" | ");
  const [header, ...body] = normalizedRows;
  const tableLines = [
    formatRow(header ?? []),
    separator,
    ...body.map(formatRow),
  ];
  return renderMarkdownCodeBlock(tableLines.join("\n"), "markdown");
}

function chunkRenderedHtmlLines(
  lines: string[],
  wrapper?: { open: string; close: string },
): string[] {
  if (lines.length === 0) return [];
  const open = wrapper?.open ?? "";
  const close = wrapper?.close ?? "";
  const maxContentLength = MAX_MESSAGE_LENGTH - open.length - close.length;
  const chunks: string[] = [];
  let current = "";
  const pushCurrent = (): void => {
    if (current.length === 0) return;
    chunks.push(`${open}${current}${close}`);
    current = "";
  };
  for (const line of lines) {
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (candidate.length <= maxContentLength) {
      current = candidate;
      continue;
    }
    pushCurrent();
    if (line.length <= maxContentLength) {
      current = line;
      continue;
    }
    for (let i = 0; i < line.length; i += maxContentLength) {
      chunks.push(`${open}${line.slice(i, i + maxContentLength)}${close}`);
    }
  }
  pushCurrent();
  return chunks;
}

function renderMarkdownTextBlock(block: string): string[] {
  return chunkRenderedHtmlLines(renderMarkdownTextLines(block));
}

function renderMarkdownQuoteBlock(lines: string[]): string[] {
  const inner = lines
    .map((line) => {
      const parsed = parseMarkdownQuoteLine(line);
      if (!parsed) return line;
      const nestedIndent = "\u00A0".repeat(Math.max(0, parsed.depth - 1) * 2);
      return `${nestedIndent}${parsed.content}`;
    })
    .join("\n");
  return chunkRenderedHtmlLines(renderMarkdownTextLines(inner), {
    open: "<blockquote>",
    close: "</blockquote>",
  });
}

interface TelegramRenderedBlockWithSpacing {
  text: string;
  blankLinesBefore: number;
}

function collectFencedMarkdownCodeLines(
  lines: string[],
  index: number,
  fence: { marker: "`" | "~"; length: number },
): { codeLines: string[]; nextIndex: number; closed: boolean } {
  const codeLines: string[] = [];
  let nextIndex = index + 1;
  while (
    nextIndex < lines.length &&
    !isMatchingMarkdownFence(lines[nextIndex] ?? "", fence)
  ) {
    codeLines.push(lines[nextIndex] ?? "");
    nextIndex += 1;
  }
  const closed = nextIndex < lines.length;
  if (closed) nextIndex += 1;
  return { codeLines, nextIndex, closed };
}

function collectMarkdownTableBlockLines(
  lines: string[],
  index: number,
): { tableLines: string[]; nextIndex: number } {
  const tableLines = [lines[index] ?? ""];
  let nextIndex = index + 2;
  while (nextIndex < lines.length) {
    const tableLine = lines[nextIndex] ?? "";
    if (tableLine.trim().length === 0 || !tableLine.includes("|")) break;
    tableLines.push(tableLine);
    nextIndex += 1;
  }
  return { tableLines, nextIndex };
}

function collectIndentedMarkdownCodeLines(
  lines: string[],
  index: number,
): { codeLines: string[]; nextIndex: number } {
  const codeLines: string[] = [];
  let nextIndex = index;
  while (nextIndex < lines.length) {
    const rawLine = lines[nextIndex] ?? "";
    if (rawLine.trim().length === 0) {
      codeLines.push("");
      nextIndex += 1;
      continue;
    }
    if (!isIndentedCodeLine(rawLine)) break;
    codeLines.push(stripIndentedCodePrefix(rawLine));
    nextIndex += 1;
  }
  return { codeLines, nextIndex };
}

function collectMarkdownQuoteBlockLines(
  lines: string[],
  index: number,
): { quoteLines: string[]; nextIndex: number } {
  const quoteLines: string[] = [];
  let nextIndex = index;
  while (nextIndex < lines.length && /^\s*>/.test(lines[nextIndex] ?? "")) {
    quoteLines.push(lines[nextIndex] ?? "");
    nextIndex += 1;
  }
  return { quoteLines, nextIndex };
}

function isMarkdownTextBlockBoundary(lines: string[], index: number): boolean {
  const current = lines[index] ?? "";
  const following = lines[index + 1] ?? "";
  if (current.trim().length === 0) return true;
  if (isFencedCodeStart(current)) return true;
  if (canStartIndentedCodeBlock(lines, index)) return true;
  if (/^\s*>/.test(current)) return true;
  return current.includes("|") && isMarkdownTableSeparator(following);
}

function collectMarkdownTextBlockLines(
  lines: string[],
  index: number,
): { textLines: string[]; nextIndex: number } {
  const textLines: string[] = [];
  let nextIndex = index;
  while (nextIndex < lines.length) {
    if (isMarkdownTextBlockBoundary(lines, nextIndex)) break;
    textLines.push(lines[nextIndex] ?? "");
    nextIndex += 1;
  }
  return { textLines, nextIndex };
}

function renderMarkdownDocumentBlocks(
  normalizedMarkdown: string,
): TelegramRenderedBlockWithSpacing[] {
  const renderedBlocks: TelegramRenderedBlockWithSpacing[] = [];
  let minimumBlankLinesBeforeNextBlock = 0;
  const pushRenderedBlocks = (
    blocks: string[],
    blankLinesBefore: number,
  ): void => {
    const effectiveBlankLinesBefore =
      renderedBlocks.length === 0
        ? blankLinesBefore
        : Math.max(blankLinesBefore, minimumBlankLinesBeforeNextBlock);
    for (const [blockIndex, block] of blocks.entries()) {
      renderedBlocks.push({
        text: block,
        blankLinesBefore: blockIndex === 0 ? effectiveBlankLinesBefore : 0,
      });
    }
    minimumBlankLinesBeforeNextBlock = 0;
  };
  const lines = normalizedMarkdown.split("\n");
  let index = 0;
  let pendingBlankLines = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const nextLine = lines[index + 1] ?? "";
    if (line.trim().length === 0) {
      pendingBlankLines += 1;
      index += 1;
      continue;
    }
    const heading = matchMarkdownHeadingLine(line);
    if (heading) {
      pushRenderedBlocks(
        renderMarkdownTextBlock(line),
        renderedBlocks.length === 0
          ? pendingBlankLines
          : Math.max(pendingBlankLines, 1),
      );
      pendingBlankLines = 0;
      minimumBlankLinesBeforeNextBlock = 1;
      index += 1;
      continue;
    }
    const fence = parseMarkdownFence(line);
    if (fence) {
      const block = collectFencedMarkdownCodeLines(lines, index, fence);
      index = block.nextIndex;
      pushRenderedBlocks(
        renderMarkdownCodeBlock(block.codeLines.join("\n"), fence.info),
        pendingBlankLines,
      );
      pendingBlankLines = 0;
      continue;
    }
    if (line.includes("|") && isMarkdownTableSeparator(nextLine)) {
      const block = collectMarkdownTableBlockLines(lines, index);
      index = block.nextIndex;
      pushRenderedBlocks(
        renderMarkdownTableBlock(block.tableLines),
        pendingBlankLines,
      );
      pendingBlankLines = 0;
      continue;
    }
    if (canStartIndentedCodeBlock(lines, index)) {
      const block = collectIndentedMarkdownCodeLines(lines, index);
      index = block.nextIndex;
      pushRenderedBlocks(
        renderMarkdownCodeBlock(block.codeLines.join("\n")),
        pendingBlankLines,
      );
      pendingBlankLines = 0;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const block = collectMarkdownQuoteBlockLines(lines, index);
      index = block.nextIndex;
      pushRenderedBlocks(
        renderMarkdownQuoteBlock(block.quoteLines),
        pendingBlankLines,
      );
      pendingBlankLines = 0;
      continue;
    }
    const block = collectMarkdownTextBlockLines(lines, index);
    index = block.nextIndex;
    pushRenderedBlocks(
      renderMarkdownTextBlock(block.textLines.join("\n")),
      pendingBlankLines,
    );
    pendingBlankLines = 0;
  }
  return renderedBlocks;
}

interface TelegramMarkdownChunkAccumulator {
  chunks: string[];
  current: string;
}

function flushTelegramMarkdownChunkAccumulator(
  accumulator: TelegramMarkdownChunkAccumulator,
): void {
  if (accumulator.current.length === 0) return;
  accumulator.chunks.push(accumulator.current);
  accumulator.current = "";
}

function splitOversizedTelegramMarkdownBlock(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
    chunks.push(text.slice(i, i + MAX_MESSAGE_LENGTH));
  }
  return chunks;
}

function appendTelegramRenderedMarkdownBlock(
  accumulator: TelegramMarkdownChunkAccumulator,
  block: TelegramRenderedBlockWithSpacing,
): void {
  const separator = "\n".repeat(block.blankLinesBefore + 1);
  const candidate =
    accumulator.current.length === 0
      ? block.text
      : `${accumulator.current}${separator}${block.text}`;
  if (candidate.length <= MAX_MESSAGE_LENGTH) {
    accumulator.current = candidate;
    return;
  }
  flushTelegramMarkdownChunkAccumulator(accumulator);
  if (block.text.length <= MAX_MESSAGE_LENGTH) {
    accumulator.current = block.text;
    return;
  }
  accumulator.chunks.push(...splitOversizedTelegramMarkdownBlock(block.text));
}

function chunkTelegramRenderedMarkdownBlocks(
  renderedBlocks: TelegramRenderedBlockWithSpacing[],
): string[] {
  const accumulator: TelegramMarkdownChunkAccumulator = {
    chunks: [],
    current: "",
  };
  for (const block of renderedBlocks) {
    appendTelegramRenderedMarkdownBlock(accumulator, block);
  }
  flushTelegramMarkdownChunkAccumulator(accumulator);
  return accumulator.chunks;
}

function renderMarkdownToTelegramHtmlChunks(markdown: string): string[] {
  const normalized = normalizeMarkdownDocument(markdown);
  if (normalized.length === 0) return [];
  return chunkTelegramRenderedMarkdownBlocks(
    renderMarkdownDocumentBlocks(normalized),
  );
}

// --- Unified Telegram Rendering ---

export type TelegramRenderMode = "plain" | "markdown" | "html";

export interface TelegramRenderedChunk {
  text: string;
  parseMode?: "HTML";
}

function chunkParagraphs(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];
  const normalized = text.replace(/\r\n/g, "\n");
  const paragraphs = normalized.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";
  const flushCurrent = (): void => {
    if (current.trim().length > 0) chunks.push(current);
    current = "";
  };
  const splitLongBlock = (block: string): string[] => {
    if (block.length <= MAX_MESSAGE_LENGTH) return [block];
    const lines = block.split("\n");
    const lineChunks: string[] = [];
    let lineCurrent = "";
    for (const line of lines) {
      const candidate =
        lineCurrent.length === 0 ? line : `${lineCurrent}\n${line}`;
      if (candidate.length <= MAX_MESSAGE_LENGTH) {
        lineCurrent = candidate;
        continue;
      }
      if (lineCurrent.length > 0) {
        lineChunks.push(lineCurrent);
        lineCurrent = "";
      }
      if (line.length <= MAX_MESSAGE_LENGTH) {
        lineCurrent = line;
        continue;
      }
      for (let i = 0; i < line.length; i += MAX_MESSAGE_LENGTH) {
        lineChunks.push(line.slice(i, i + MAX_MESSAGE_LENGTH));
      }
    }
    if (lineCurrent.length > 0) {
      lineChunks.push(lineCurrent);
    }
    return lineChunks;
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) continue;
    const parts = splitLongBlock(paragraph);
    for (const part of parts) {
      const candidate = current.length === 0 ? part : `${current}\n\n${part}`;
      if (candidate.length <= MAX_MESSAGE_LENGTH) {
        current = candidate;
      } else {
        flushCurrent();
        current = part;
      }
    }
  }
  flushCurrent();
  return chunks;
}

export function renderTelegramMessage(
  text: string,
  options?: { mode?: TelegramRenderMode },
): TelegramRenderedChunk[] {
  const mode = options?.mode ?? "plain";
  if (mode === "plain") {
    return chunkParagraphs(text).map((chunk) => ({ text: chunk }));
  }
  if (mode === "html") {
    return chunkHtmlPreservingTags(text, MAX_MESSAGE_LENGTH).map((chunk) => ({
      text: chunk,
      parseMode: "HTML",
    }));
  }
  return renderMarkdownToTelegramHtmlChunks(text).map((chunk) => ({
    text: chunk,
    parseMode: "HTML",
  }));
}
