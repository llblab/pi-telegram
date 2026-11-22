/**
 * Telegram outbound markup parsing helpers
 * Zones: telegram outbound, assistant markup
 * Owns assistant action comment/fence parsing, declarative UI wire validation, and markup stripping shared by voice and outbound delivery
 */

import type { TelegramInlineKeyboardButtonStyle } from "./keyboard.ts";
import { isWireRecord as isTelegramActionPayload } from "./wire.ts";

export interface TelegramHtmlComment {
  raw: string;
  content: string;
  start: number;
  end: number;
}

interface TelegramTopLevelFenceState {
  marker: "`" | "~";
  length: number;
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
  const match = line.match(/^[ \t]*(`{3,}|~{3,})/);
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
  const match = line.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/);
  const sequence = match?.[1];
  return (
    !!sequence &&
    sequence[0] === fence.marker &&
    sequence.length >= fence.length
  );
}

export function collectTelegramHtmlComments(markdown: string): {
  comments: TelegramHtmlComment[];
  openCommentStart?: number;
} {
  const comments: TelegramHtmlComment[] = [];
  let offset = 0;
  while (offset < markdown.length) {
    const start = markdown.indexOf("<!--", offset);
    if (start === -1) break;
    const closeIndex = markdown.indexOf("-->", start + 4);
    if (closeIndex === -1) return { comments, openCommentStart: start };
    const end = closeIndex + 3;
    const raw = markdown.slice(start, end);
    comments.push({ raw, content: raw.slice(4, -3), start, end });
    offset = end;
  }
  return { comments };
}

export function replaceTelegramButtonFences(
  markdown: string,
  replace: (payload: string, closed: boolean, element: string) => string,
  elements: readonly string[] = ["telegram_button"],
): string {
  let result = "";
  let copied = 0;
  let offset = 0;
  let fence: TelegramTopLevelFenceState | undefined;
  let actionStart: number | undefined;
  let contentStart = 0;
  let actionElement = "";
  while (offset < markdown.length) {
    const end = getMarkdownLineEnd(markdown, offset);
    const line = getMarkdownLineText(markdown, offset, end);
    if (fence) {
      if (isTopLevelClosingFence(line, fence)) {
        if (actionStart !== undefined) {
          result += markdown.slice(copied, actionStart);
          result += replace(markdown.slice(contentStart, offset), true, actionElement) + "\n";
          copied = end;
          actionStart = undefined;
        }
        fence = undefined;
      }
    } else if (line.includes("<!--")) {
      const close = markdown.indexOf("-->", offset + line.indexOf("<!--") + 4);
      if (close < 0) break;
      offset = getMarkdownLineEnd(markdown, close + 3);
      continue;
    } else {
      fence = getTopLevelOpeningFence(line);
      const element = line.match(/^[ \t]*(?:`{3,}|~{3,})[ \t]*(telegram_[a-z_]+)[ \t]*$/)?.[1];
      if (fence && element && elements.includes(element)) {
        actionElement = element;
        actionStart = offset;
        contentStart = end;
      }
    }
    offset = end;
  }
  if (actionStart !== undefined) {
    result += markdown.slice(copied, actionStart);
    return result + replace(markdown.slice(contentStart), false, actionElement);
  }
  return result + markdown.slice(copied);
}

export function replaceTelegramHtmlComments(
  markdown: string,
  replacer: (comment: TelegramHtmlComment) => string,
): string {
  const { comments } = collectTelegramHtmlComments(markdown);
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

function findOpenOrPartialHtmlCommentIndex(markdown: string): number {
  const start = markdown.indexOf("<!--");
  return start >= 0 ? start : (markdown.match(/<(?:!-?)?$/u)?.index ?? -1);
}

function parseTolerantTelegramAttributes(
  source: string,
  names: readonly string[],
): Record<string, string> | undefined {
  const attributes: Record<string, string> = {};
  const namePattern = names.join("|");
  const pattern = new RegExp(
    `\\b(${namePattern})\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s]+))`,
    "gu",
  );
  for (const match of source.matchAll(pattern)) {
    const value = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (value) attributes[match[1]!] = value;
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

function removeTelegramJsonTrailingCommas(source: string): string {
  let normalized = "";
  let inString = false;
  let escaped = false;
  for (let offset = 0; offset < source.length; offset += 1) {
    const character = source[offset]!;
    if (inString) {
      normalized += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      normalized += character;
      continue;
    }
    if (character === ",") {
      let next = offset + 1;
      while (/\s/u.test(source[next] ?? "")) next += 1;
      if (source[next] === "}" || source[next] === "]") continue;
    }
    normalized += character;
  }
  return normalized;
}

function parseTelegramJsonObjectCandidate(
  source: string,
): Record<string, unknown> | undefined {
  const normalized = removeTelegramJsonTrailingCommas(source);
  for (const candidate of normalized === source
    ? [source]
    : [source, normalized]) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (isTelegramActionPayload(value)) return value;
    } catch {
      // Try the bounded trailing-comma normalization before rejecting JSON.
    }
  }
  return undefined;
}

function looksLikeTelegramNamedJsonObject(
  source: string,
  offset: number,
): boolean {
  return /^\{\s*"(?:[^"\\]|\\.)*"\s*:/u.test(source.slice(offset));
}

/** Blank one structured span so tolerant attribute parsing never reads keys inside rejected JSON or matrices. */
function blankTelegramActionSpan(
  text: string,
  start: number,
  end: number,
): string {
  return `${text.slice(0, start)}${" ".repeat(end - start)}${text.slice(end)}`;
}

/**
 * Scans one action comment for its first accepted structured payload. Otherwise returns the attribute envelope
 * with every structured span blanked; implausible `[` starts are skipped without a parse attempt.
 */
function scanTelegramActionComment<T>(
  comment: TelegramHtmlComment,
  command: string,
  parseStructured: (content: string, offset: number) => T | undefined,
): { payload: T } | { attributeEnvelope: string } | undefined {
  let content = comment.content.replace(/^\s+/, "").replace(/^!/, "");
  if (!content.startsWith(command)) return undefined;
  content = content.slice(command.length);
  let attributeEnvelope = content;
  for (let offset = 0; offset < content.length; offset += 1) {
    const char = content[offset];
    if (char !== "{" && char !== "[") continue;
    if (char === "{" || isPlausibleTelegramMatrixStart(content, offset)) {
      const payload = parseStructured(content, offset);
      if (payload !== undefined) return { payload };
    }
    const end = findTelegramStructuredPayloadEnd(content, offset);
    if (end === undefined) continue;
    attributeEnvelope = blankTelegramActionSpan(attributeEnvelope, offset, end);
    offset = end - 1;
  }
  return { attributeEnvelope };
}

function parseTelegramActionPayload(
  comment: TelegramHtmlComment,
  command: string,
): Record<string, unknown> | undefined {
  const scanned = scanTelegramActionComment(
    comment,
    command,
    (content, offset) =>
      content[offset] === "{"
        ? parseTelegramAdaptiveActionPayloadRows(
            content.slice(offset),
            parseTelegramVoiceCompactActionPayload,
            { allowTrailing: true },
          )?.rows[0]![0]
        : undefined,
  );
  if (!scanned) return undefined;
  if ("payload" in scanned) return scanned.payload;
  return parseTolerantTelegramAttributes(scanned.attributeEnvelope, [
    "text",
    "value",
    "lang",
    "rate",
  ]);
}

const TELEGRAM_COMPACT_ACTION_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

type TelegramCompactActionPayloadParser = (
  atoms: readonly string[],
) => Record<string, unknown> | undefined;

function parseTelegramButtonCompactActionPayload(
  atoms: readonly string[],
): Record<string, unknown> | undefined {
  const [label, prompt, selectedStyle, disabled] = atoms;
  if (atoms.length === 1) return label ? { value: label } : undefined;
  const isDisabled = disabled === "1" || disabled === "true";
  if (!prompt && !(atoms.length === 4 && isDisabled)) return undefined;
  const action = label ? { label, prompt } : { prompt };
  if (atoms.length === 2) return action;
  if (
    selectedStyle !== "primary" &&
    selectedStyle !== "success" &&
    selectedStyle !== "danger" &&
    !(atoms.length === 4 && selectedStyle === "")
  )
    return undefined;
  if (
    atoms.length === 4 &&
    !isDisabled &&
    disabled !== "0" &&
    disabled !== "false"
  ) {
    return undefined;
  }
  return {
    ...action,
    ...(selectedStyle ? { selected_style: selectedStyle } : {}),
    ...(atoms.length === 4 ? { disabled: isDisabled } : {}),
  };
}

function parseTelegramVoiceCompactActionPayload(
  atoms: readonly string[],
): Record<string, unknown> | undefined {
  const [text, lang, rate] = atoms;
  if (!text) return undefined;
  if (atoms.length === 1) return { text };
  if (!lang) return undefined;
  if (atoms.length === 2) return { text, lang };
  if (!rate) return undefined;
  return { text, lang, rate };
}

function parseTelegramAdaptiveActionPayloadRows(
  source: string,
  parseCompactPayload: TelegramCompactActionPayloadParser,
  options: { allowTrailing?: boolean; maxCompactAtoms?: number; allowMatrixGroups?: boolean } = {},
): { rows: Record<string, unknown>[][]; end: number } | undefined {
  let offset = 0;
  const isStructuralWhitespace = (character: string | undefined): boolean =>
    character === " " ||
    character === "\t" ||
    character === "\r" ||
    character === "\n";
  const skipWhitespace = (): void => {
    while (isStructuralWhitespace(source[offset])) offset += 1;
  };
  const consumeOptionalSeparator = (): boolean => {
    skipWhitespace();
    if (source[offset] !== ",") return true;
    offset += 1;
    skipWhitespace();
    return source[offset] !== ",";
  };
  const normalizeAtom = (value: string): string | undefined => {
    const normalized = value.trim();
    return !TELEGRAM_COMPACT_ACTION_CONTROL_PATTERN.test(normalized)
      ? normalized
      : undefined;
  };
  const parseCompactCell = (): Record<string, unknown> | undefined => {
    if (source[offset] !== "{") return undefined;
    offset += 1;
    const atomSources: string[][] = [[]];
    while (offset < source.length) {
      const character = source[offset]!;
      if (character === "\\") {
        const escaped = source[offset + 1];
        if (escaped !== "|" && escaped !== "}" && escaped !== "\\") {
          return undefined;
        }
        atomSources.at(-1)!.push(escaped);
        offset += 2;
        continue;
      }
      if (character === "|") {
        if (atomSources.length >= (options.maxCompactAtoms ?? 3))
          return undefined;
        atomSources.push([]);
        offset += 1;
        continue;
      }
      if (character === "}") {
        offset += 1;
        const atoms = atomSources.map((atom) => normalizeAtom(atom.join("")));
        if (atoms.some((atom) => atom === undefined)) return undefined;
        return parseCompactPayload(atoms as string[]);
      }
      atomSources.at(-1)!.push(character);
      offset += 1;
    }
    return undefined;
  };
  const parseJsonObjectCell = (): Record<string, unknown> | undefined => {
    if (source[offset] !== "{") return undefined;
    const start = offset;
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{" || character === "[") {
        stack.push(character);
        continue;
      }
      if (character !== "}" && character !== "]") continue;
      const opening = stack.pop();
      if (
        (character === "}" && opening !== "{") ||
        (character === "]" && opening !== "[")
      )
        return undefined;
      if (stack.length > 0) continue;
      const candidate = source.slice(start, index + 1);
      const value = parseTelegramJsonObjectCandidate(candidate);
      if (!value) return undefined;
      offset = index + 1;
      return value;
    }
    return undefined;
  };
  const parseCell = (): Record<string, unknown> | undefined => {
    const start = offset;
    const jsonCell = parseJsonObjectCell();
    if (jsonCell) return jsonCell;
    offset = start;
    if (looksLikeTelegramNamedJsonObject(source, start)) return undefined;
    return parseCompactCell();
  };
  const parseRow = (): Record<string, unknown>[] | undefined => {
    if (source[offset] !== "[") return undefined;
    offset += 1;
    const row: Record<string, unknown>[] = [];
    while (offset < source.length) {
      skipWhitespace();
      if (source[offset] === "]") {
        offset += 1;
        return row.length > 0 ? row : undefined;
      }
      if (source[offset] !== "{") return undefined;
      const cell = parseCell();
      if (!cell) return undefined;
      row.push(cell);
      if (!consumeOptionalSeparator()) return undefined;
    }
    return undefined;
  };
  const parseMatrix = (): Record<string, unknown>[][] | undefined => {
    if (source[offset] !== "[") return undefined;
    offset += 1;
    const rows: Record<string, unknown>[][] = [];
    while (offset < source.length) {
      skipWhitespace();
      const character = source[offset];
      if (character === "]") {
        offset += 1;
        return rows.length > 0 ? rows : undefined;
      }
      if (character === "{") {
        const cell = parseCell();
        if (!cell) return undefined;
        rows.push([cell]);
      } else if (character === "[") {
        const row = parseRow();
        if (!row) return undefined;
        rows.push(row);
      } else {
        return undefined;
      }
      if (!consumeOptionalSeparator()) return undefined;
    }
    return undefined;
  };

  const parseTopLevelRows = (): Record<string, unknown>[][] | undefined => {
    const rows: Record<string, unknown>[][] = [];
    while (offset < source.length) {
      skipWhitespace();
      const character = source[offset];
      if (character === "{") {
        const cell = parseCell();
        if (!cell) return undefined;
        rows.push([cell]);
      } else if (character === "[" && options.allowMatrixGroups) {
        const matrix = parseMatrix();
        if (!matrix) return undefined;
        rows.push(...matrix);
      } else {
        break;
      }
      if (!consumeOptionalSeparator()) return undefined;
    }
    return rows.length > 0 ? rows : undefined;
  };

  skipWhitespace();
  const rows = parseTopLevelRows();
  if (!rows) return undefined;
  skipWhitespace();
  if (!options.allowTrailing && offset !== source.length) return undefined;
  return { rows, end: offset };
}

function findTelegramStructuredPayloadEnd(
  source: string,
  start: number,
): number | undefined {
  const stack: string[] = [source[start]!];
  let inString = false;
  let escaped = false;
  for (let offset = start + 1; offset < source.length; offset += 1) {
    const character = source[offset]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "[" || character === "{") {
      stack.push(character);
      continue;
    }
    if (character !== "]" && character !== "}") continue;
    const expected = character === "]" ? "[" : "{";
    if (stack.at(-1) === expected) stack.pop();
    if (stack.length === 0) return offset + 1;
  }
  return undefined;
}

function isPlausibleTelegramMatrixStart(
  source: string,
  start: number,
): boolean {
  let offset = start + 1;
  while (/\s/u.test(source[offset] ?? "")) offset += 1;
  return (
    source[offset] === "{" || source[offset] === "[" || source[offset] === "]"
  );
}

export function parseTelegramButtonPayloadRows(
  source: string,
): Record<string, unknown>[][] | undefined {
  return parseTelegramAdaptiveActionPayloadRows(
    source.trim(),
    parseTelegramButtonCompactActionPayload,
    { maxCompactAtoms: 4, allowMatrixGroups: true },
  )?.rows;
}

export function parseTelegramActionPayloadRows(
  comment: TelegramHtmlComment,
  command: string,
): Record<string, unknown>[][] | undefined {
  const scanned = scanTelegramActionComment(
    comment,
    command,
    (content, offset) =>
      parseTelegramAdaptiveActionPayloadRows(
        content.slice(offset),
        parseTelegramButtonCompactActionPayload,
        { allowTrailing: true, maxCompactAtoms: 4, allowMatrixGroups: true },
      )?.rows,
  );
  if (!scanned) return undefined;
  if ("payload" in scanned) return scanned.payload;
  const attributes = parseTolerantTelegramAttributes(
    scanned.attributeEnvelope,
    ["label", "prompt", "value", "selected_style", "disabled"],
  );
  if (!attributes) return undefined;
  return [
    [
      {
        ...attributes,
        ...(attributes.disabled === "true" || attributes.disabled === "false"
          ? { disabled: attributes.disabled === "true" }
          : {}),
      },
    ],
  ];
}

// --- Declarative UI Wire Contract ---

export interface TelegramUiQuestion {
  readonly id?: string;
  readonly question: string;
  readonly timeoutMs: number;
  readonly cancelLabel: string;
}

export interface TelegramUiChoiceCell {
  readonly label: string;
  readonly value: string;
  readonly style?: TelegramInlineKeyboardButtonStyle;
  readonly disabled: boolean;
}

export type TelegramUiChoiceRows = readonly (readonly TelegramUiChoiceCell[])[];

export interface TelegramUiChoiceQuestion extends TelegramUiQuestion {
  readonly rows: TelegramUiChoiceRows;
  /** Exact number of choices required; omitted means one. */
  readonly select?: number;
}

export type TelegramUiDeclaration =
  | { readonly kind: "choice"; readonly batched: boolean; readonly questions: readonly TelegramUiChoiceQuestion[]; readonly timeoutMs: number }
  | (TelegramUiQuestion & { readonly kind: "confirm"; readonly confirmLabel: string; readonly confirmStyle?: TelegramInlineKeyboardButtonStyle })
  | (TelegramUiQuestion & { readonly kind: "text_input"; readonly maxLength: number; readonly multiline: boolean })
  | (TelegramUiQuestion & { readonly kind: "attachment"; readonly accept: readonly string[]; readonly maxFiles: number; readonly maxBytes: number });

export type TelegramUiDeclarationParseResult =
  | { readonly ok: true; readonly declaration: TelegramUiDeclaration }
  | { readonly ok: false; readonly reason: "unsupported-element" | "invalid-declaration"; readonly message: string };

const TELEGRAM_UI_COMMON_KEYS = ["id", "question", "timeoutMs", "cancelLabel"];
const TELEGRAM_UI_MAX_SOURCE_LENGTH = 65_536;
const TELEGRAM_UI_MAX_TIMEOUT_MS = 3_600_000;
const TELEGRAM_UI_DEFAULT_TIMEOUT_MS = 300_000;
const TELEGRAM_UI_SELECTION_DEFAULT_TIMEOUT_MS = 60 * 60_000;
const TELEGRAM_UI_SELECTION_HEAD_TIMEOUT_MS = 86_400_000;

class TelegramUiDeclarationError extends Error {}

function invalidTelegramUi(message: string): never {
  throw new TelegramUiDeclarationError(message);
}

function telegramUiRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isTelegramActionPayload(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    invalidTelegramUi("Unexpected declaration shape or property.");
  }
  return value;
}

function telegramUiText(value: unknown, maxLength: number, allowEmpty = false): string {
  if (typeof value !== "string") invalidTelegramUi("Expected a string.");
  const normalized = value.trim();
  if ((!allowEmpty && !normalized) || normalized.length > maxLength ||
      !normalized.isWellFormed() || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(normalized)) {
    invalidTelegramUi("Invalid single-line string or length.");
  }
  return normalized;
}

function telegramUiInteger(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    invalidTelegramUi("Invalid positive integer or bound.");
  }
  return value as number;
}

function telegramUiBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") invalidTelegramUi("Expected a boolean.");
  return value;
}

function telegramUiStyle(value: unknown): TelegramUiChoiceCell["style"] {
  if (value === undefined || value === "primary" || value === "success" || value === "danger") return value;
  return invalidTelegramUi("Invalid button style.");
}

function telegramUiCommon(record: Record<string, unknown>, cancelLabel = "❌ Cancel", defaultTimeoutMs = TELEGRAM_UI_DEFAULT_TIMEOUT_MS): TelegramUiQuestion {
  return {
    ...(record.id !== undefined ? { id: telegramUiText(record.id, 128) } : {}),
    question: telegramUiText(record.question, 1024),
    timeoutMs: telegramUiInteger(record.timeoutMs, defaultTimeoutMs, TELEGRAM_UI_MAX_TIMEOUT_MS),
    cancelLabel: record.cancelLabel === undefined ? cancelLabel : telegramUiText(record.cancelLabel, 128),
  };
}

function parseTelegramUiChoiceCompactCell(atoms: readonly string[]): Record<string, unknown> | undefined {
  const cell = parseTelegramButtonCompactActionPayload(atoms);
  return cell ? {
    label: cell.label ?? cell.value ?? cell.prompt ?? "",
    value: cell.prompt ?? cell.value ?? cell.label ?? "",
    ...(cell.selected_style !== undefined ? { style: cell.selected_style } : {}),
    ...(cell.disabled !== undefined ? { disabled: cell.disabled } : {}),
  } : undefined;
}

function normalizeTelegramUiChoiceRows(value: unknown): TelegramUiChoiceRows {
  let rawRows: unknown[][];
  if (typeof value === "string") {
    if (value.length > TELEGRAM_UI_MAX_SOURCE_LENGTH) invalidTelegramUi("Choice payload is too large.");
    const parsed = parseTelegramAdaptiveActionPayloadRows(value, parseTelegramUiChoiceCompactCell,
      { maxCompactAtoms: 4, allowMatrixGroups: true });
    if (!parsed) invalidTelegramUi("Invalid Choice matrix literal.");
    rawRows = parsed.rows;
  } else if (Array.isArray(value)) {
    rawRows = value.map((item: unknown) => Array.isArray(item) ? item : [item]);
  } else {
    rawRows = [[value]];
  }
  if (rawRows.length < 1 || rawRows.length > 64) invalidTelegramUi("Invalid Choice row count.");
  const values = new Set<string>();
  let count = 0;
  const rows = rawRows.map((row) => {
    if (row.length < 1 || row.length > 8) invalidTelegramUi("Invalid Choice row width.");
    return Object.freeze(row.map((item) => {
      if (++count > 64) invalidTelegramUi("Too many Choice options.");
      const cell = telegramUiRecord(typeof item === "string" ? { label: item } : item, ["label", "value", "style", "disabled"]);
      const disabled = telegramUiBoolean(cell.disabled, false);
      const labelSource = cell.label === undefined ? (cell.value === undefined ? (disabled ? "" : undefined) : cell.value) : cell.label;
      const label = telegramUiText(labelSource, 128, disabled);
      const semanticValue = telegramUiText(cell.value === undefined ? label : cell.value, 256, disabled);
      const style = telegramUiStyle(cell.style);
      if (!disabled) {
        if (values.has(semanticValue)) invalidTelegramUi("Duplicate enabled Choice value.");
        values.add(semanticValue);
      }
      return Object.freeze({ label, value: semanticValue, ...(style ? { style } : {}), disabled });
    }));
  });
  if (values.size === 0) invalidTelegramUi("Choice needs an enabled option.");
  return Object.freeze(rows);
}

/** Representation only. Private opt-in changes omitted Confirm/Choice defaults, not explicit bounds or runtime authority. */
export function parseTelegramUiDeclaration(element: string, source: string, questionHeadTail?: true): TelegramUiDeclarationParseResult {
  if (questionHeadTail !== undefined && questionHeadTail !== true)
    throw new TypeError("Question head/tail policy must be true or omitted.");
  const selectionTimeoutMs = questionHeadTail ? TELEGRAM_UI_SELECTION_HEAD_TIMEOUT_MS : TELEGRAM_UI_SELECTION_DEFAULT_TIMEOUT_MS;
  if (!["telegram_confirm", "telegram_choice", "telegram_text_input", "telegram_attachment"].includes(element)) {
    return { ok: false, reason: "unsupported-element", message: "Unknown UI element." };
  }
  if (source.length > TELEGRAM_UI_MAX_SOURCE_LENGTH) {
    return { ok: false, reason: "invalid-declaration", message: "Declaration is too large." };
  }
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { return { ok: false, reason: "invalid-declaration", message: "Invalid JSON configuration." }; }
  try {
    let declaration: TelegramUiDeclaration;
    if (element === "telegram_choice") {
      const rawQuestions: unknown[] = Array.isArray(value) ? value : [value];
      if (rawQuestions.length < 1 || rawQuestions.length > 32) invalidTelegramUi("Invalid question count.");
      const ids = new Set<string>();
      const questions = rawQuestions.map((item) => {
        const record = telegramUiRecord(item, [...TELEGRAM_UI_COMMON_KEYS, "choices", "select"]);
        const common = telegramUiCommon(record, "❌ Cancel", selectionTimeoutMs);
        if (common.id !== undefined) {
          if (ids.has(common.id)) invalidTelegramUi("Duplicate question ID.");
          ids.add(common.id);
        }
        const rows = normalizeTelegramUiChoiceRows(record.choices);
        const select = telegramUiInteger(record.select, 1, 64);
        if (select > rows.flat().filter(cell => !cell.disabled).length) invalidTelegramUi("Selection count exceeds enabled choices.");
        return Object.freeze({ ...common, rows, ...(select > 1 ? { select } : {}) });
      });
      declaration = { kind: "choice", batched: Array.isArray(value), questions: Object.freeze(questions),
        timeoutMs: Math.min(selectionTimeoutMs, questions.reduce((sum, question) => sum + question.timeoutMs, 0)) };
    } else if (element === "telegram_confirm") {
      const record = telegramUiRecord(typeof value === "string" ? { question: value } : value, [...TELEGRAM_UI_COMMON_KEYS, "confirmLabel", "confirmStyle"]);
      const style = telegramUiStyle(record.confirmStyle);
      declaration = { kind: "confirm", ...telegramUiCommon(record, "❌ No", selectionTimeoutMs),
        confirmLabel: record.confirmLabel === undefined ? "✅ Yes" : telegramUiText(record.confirmLabel, 128),
        ...(style ? { confirmStyle: style } : {}) };
    } else if (element === "telegram_text_input") {
      const record = telegramUiRecord(value, [...TELEGRAM_UI_COMMON_KEYS, "maxLength", "multiline"]);
      declaration = { kind: "text_input", ...telegramUiCommon(record),
        maxLength: telegramUiInteger(record.maxLength, 4096, 16_384), multiline: telegramUiBoolean(record.multiline, false) };
    } else {
      const record = telegramUiRecord(value, [...TELEGRAM_UI_COMMON_KEYS, "accept", "maxFiles", "maxBytes"]);
      const accept = record.accept === undefined ? ["*/*"] : record.accept;
      if (!Array.isArray(accept) || accept.length < 1 || accept.length > 16) invalidTelegramUi("Invalid MIME filter count.");
      const filters = accept.map((filter: unknown) => {
        const mime = telegramUiText(filter, 128).toLowerCase();
        if (mime !== "*/*" && !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/(?:[a-z0-9][a-z0-9!#$&^_.+-]*|\*)$/u.test(mime)) {
          invalidTelegramUi("Invalid MIME filter.");
        }
        return mime;
      });
      if (new Set(filters).size !== filters.length) invalidTelegramUi("Duplicate MIME filter.");
      declaration = { kind: "attachment", ...telegramUiCommon(record), accept: Object.freeze(filters),
        maxFiles: telegramUiInteger(record.maxFiles, 1, 10), maxBytes: telegramUiInteger(record.maxBytes, 10_485_760, 20_971_520) };
    }
    return { ok: true, declaration: Object.freeze(declaration) };
  } catch (error) {
    if (!(error instanceof TelegramUiDeclarationError)) throw error;
    return { ok: false, reason: "invalid-declaration", message: error.message };
  }
}

/** Emit canonical matrix syntax; conversion preserves semantics, not original spelling. */
export function formatTelegramUiChoiceRows(rows: TelegramUiChoiceRows, format: "json" | "cml"): string {
  const normalized = normalizeTelegramUiChoiceRows(rows);
  if (format === "json") return JSON.stringify(normalized);
  const atom = (value: string): string => value.replace(/[\\|}]/gu, "\\$&");
  const cell = (value: TelegramUiChoiceCell): string => {
    // Compact fallback can reinterpret quoted labels or reveal the value of an explicitly blank label.
    if (value.label.startsWith('"') || (value.label === "" && value.value !== "")) return JSON.stringify(value);
    const label = atom(value.label), semanticValue = atom(value.value);
    if (value.disabled) return `{${label}|${semanticValue}|${value.style ?? ""}|1}`;
    if (value.style) return `{${label}|${semanticValue}|${value.style}}`;
    return value.label === value.value ? `{${label}}` : `{${label}|${semanticValue}}`;
  };
  return `[${normalized.map((row) => row.length === 1 ? cell(row[0]!) : `[${row.map(cell).join("")}]`).join("")}]`;
}

function normalizeMarkdownAfterVoiceExtraction(markdown: string): string {
  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}

function isTelegramCommentOnlyLinePrefix(value: string): boolean {
  return /^[ \t]*(?:(?:>[ \t]*)+)?(?:(?:[-+*]|\d+[.)])[ \t]+)?$/u.test(value);
}

function stripTelegramHtmlCommentBlocks(markdown: string): string {
  let result = "";
  let offset = 0;
  while (offset < markdown.length) {
    const start = markdown.indexOf("<!--", offset);
    if (start === -1) return result + markdown.slice(offset);
    const close = markdown.indexOf("-->", start + 4);
    const lineStart = markdown.lastIndexOf("\n", start - 1) + 1;
    const afterComment = close === -1 ? markdown.length : close + 3;
    const newlineAfterComment = markdown.indexOf("\n", afterComment);
    const lineEnd =
      newlineAfterComment === -1 ? markdown.length : newlineAfterComment;
    const commentOwnsLine =
      isTelegramCommentOnlyLinePrefix(markdown.slice(lineStart, start)) &&
      markdown.slice(afterComment, lineEnd).trim().length === 0;
    result += markdown.slice(offset, commentOwnsLine ? lineStart : start);
    if (close === -1) return result;
    offset = commentOwnsLine
      ? newlineAfterComment === -1
        ? markdown.length
        : newlineAfterComment + 1
      : afterComment;
  }
  return result;
}

export function stripTelegramCommentMarkupForPreview(markdown: string): string {
  const withoutClosedBlocks = stripTelegramHtmlCommentBlocks(
    replaceTelegramButtonFences(markdown, () => "", ["telegram_button", "telegram_confirm", "telegram_choice"]),
  );
  const openBlockIndex =
    findOpenOrPartialHtmlCommentIndex(withoutClosedBlocks);
  const previewMarkdown =
    openBlockIndex >= 0
      ? withoutClosedBlocks.slice(0, openBlockIndex)
      : withoutClosedBlocks;
  return normalizeMarkdownAfterVoiceExtraction(previewMarkdown);
}

export function stripTelegramCommentMarkupForDelivery(
  markdown: string,
): string {
  const withoutClosedBlocks = stripTelegramHtmlCommentBlocks(markdown);
  const openBlockIndex =
    findOpenOrPartialHtmlCommentIndex(withoutClosedBlocks);
  const deliveryMarkdown =
    openBlockIndex >= 0
      ? withoutClosedBlocks.slice(0, openBlockIndex)
      : withoutClosedBlocks;
  return normalizeMarkdownAfterVoiceExtraction(deliveryMarkdown);
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

export function getTelegramActionString(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function planTelegramVoiceReply(
  markdown: string,
): TelegramVoiceReplyPlan {
  const voiceReplies: TelegramVoiceReplyItem[] = [];
  let lang: string | undefined;
  let rate: string | undefined;
  const stripped = replaceTelegramHtmlComments(markdown, (comment) => {
    const command = "telegram_voice";
    const normalizedContent = comment.content
      .replace(/^\s+/, "")
      .replace(/^!/, "");
    if (!normalizedContent.startsWith(command)) return comment.raw;
    const payload = parseTelegramActionPayload(comment, command);
    if (!payload) return "";
    const text =
      getTelegramActionString(payload, "text") ??
      getTelegramActionString(payload, "value");
    const itemLang = getTelegramActionString(payload, "lang");
    const itemRate = getTelegramActionString(payload, "rate");
    if (text) {
      voiceReplies.push({
        text,
        ...(itemLang ? { lang: itemLang } : {}),
        ...(itemRate ? { rate: itemRate } : {}),
      });
    }
    if (itemLang) lang = itemLang;
    if (itemRate) rate = itemRate;
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
