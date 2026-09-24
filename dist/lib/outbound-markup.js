/**
 * Telegram outbound markup parsing helpers
 * Zones: telegram outbound, assistant markup
 * Owns top-level assistant action comment extraction, attribute parsing, and markup stripping shared by voice and outbound delivery
 */
function getMarkdownLineEnd(markdown, offset) {
    const newlineIndex = markdown.indexOf("\n", offset);
    return newlineIndex === -1 ? markdown.length : newlineIndex + 1;
}
function getMarkdownLineText(markdown, offset, end) {
    return markdown.slice(offset, end).replace(/\r?\n$/, "");
}
function getTopLevelOpeningFence(line) {
    const match = line.match(/^(?: {0,3})(`{3,}|~{3,})/);
    const sequence = match?.[1];
    if (!sequence)
        return undefined;
    return {
        marker: sequence[0],
        length: sequence.length,
    };
}
function isTopLevelClosingFence(line, fence) {
    const match = line.match(/^(?: {0,3})(`{3,}|~{3,})([ \t]*)$/);
    const sequence = match?.[1];
    return (!!sequence &&
        sequence[0] === fence.marker &&
        sequence.length >= fence.length);
}
export function collectTopLevelHtmlComments(markdown) {
    const comments = [];
    let offset = 0;
    let fence;
    while (offset < markdown.length) {
        const lineEnd = getMarkdownLineEnd(markdown, offset);
        const line = getMarkdownLineText(markdown, offset, lineEnd);
        if (fence) {
            if (isTopLevelClosingFence(line, fence))
                fence = undefined;
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
            if (closeIndex === -1)
                return { comments, openCommentStart: offset };
            const end = closeIndex + 3;
            const raw = markdown.slice(offset, end);
            const content = raw.slice(4, -3);
            comments.push({ raw, content, start: offset, end });
            offset = getMarkdownLineEnd(markdown, end);
            continue;
        }
        offset = lineEnd;
    }
    return { comments };
}
export function replaceTelegramButtonFences(markdown, replace) {
    let result = "";
    let copied = 0;
    let offset = 0;
    let fence;
    let actionStart;
    let contentStart = 0;
    while (offset < markdown.length) {
        const end = getMarkdownLineEnd(markdown, offset);
        const line = getMarkdownLineText(markdown, offset, end);
        if (fence) {
            if (isTopLevelClosingFence(line, fence)) {
                if (actionStart !== undefined) {
                    result += markdown.slice(copied, actionStart);
                    result += replace(markdown.slice(contentStart, offset), true) + "\n";
                    copied = end;
                    actionStart = undefined;
                }
                fence = undefined;
            }
        }
        else if (line.includes("<!--")) {
            const close = markdown.indexOf("-->", offset + line.indexOf("<!--") + 4);
            if (close < 0)
                break;
            offset = getMarkdownLineEnd(markdown, close + 3);
            continue;
        }
        else {
            fence = getTopLevelOpeningFence(line);
            if (fence && /^```telegram_button[ \t]*$/.test(line)) {
                actionStart = offset;
                contentStart = end;
            }
        }
        offset = end;
    }
    if (actionStart !== undefined) {
        result += markdown.slice(copied, actionStart);
        return result + replace(markdown.slice(contentStart), false);
    }
    return result + markdown.slice(copied);
}
export function replaceTopLevelHtmlComments(markdown, replacer) {
    const { comments } = collectTopLevelHtmlComments(markdown);
    if (comments.length === 0)
        return markdown;
    let result = "";
    let offset = 0;
    for (const comment of comments) {
        result += markdown.slice(offset, comment.start);
        result += replacer(comment);
        offset = comment.end;
    }
    return result + markdown.slice(offset);
}
export function findTopLevelOpenOrPartialHtmlCommentIndex(markdown) {
    const { openCommentStart } = collectTopLevelHtmlComments(markdown);
    if (openCommentStart !== undefined)
        return openCommentStart;
    let offset = 0;
    let fence;
    while (offset < markdown.length) {
        const lineEnd = getMarkdownLineEnd(markdown, offset);
        const line = getMarkdownLineText(markdown, offset, lineEnd);
        const isLastLine = lineEnd >= markdown.length;
        if (fence) {
            if (isTopLevelClosingFence(line, fence))
                fence = undefined;
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
export function parseTopLevelTelegramComment(comment, command) {
    let normalizedContent = comment.content.replace(/^\s+/, "");
    normalizedContent = normalizedContent.replace(/^!/, "");
    const [rawHead = "", ...bodyLines] = normalizedContent.split(/\r?\n/);
    let head = rawHead.trimStart();
    if (!head.startsWith(command))
        return undefined;
    const nextChar = head[command.length];
    if (nextChar !== undefined && !/\s|:/.test(nextChar))
        return undefined;
    return {
        head: head.slice(command.length),
        ...(bodyLines.length > 0 ? { body: bodyLines.join("\n") } : {}),
    };
}
function parseTolerantTelegramAttributes(source, names) {
    const attributes = {};
    const namePattern = names.join("|");
    const pattern = new RegExp(`\\b(${namePattern})\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s]+))`, "gu");
    for (const match of source.matchAll(pattern)) {
        const value = (match[2] ?? match[3] ?? match[4] ?? "").trim();
        if (value)
            attributes[match[1]] = value;
    }
    return Object.keys(attributes).length > 0 ? attributes : undefined;
}
function isTelegramActionPayload(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function removeTelegramJsonTrailingCommas(source) {
    let normalized = "";
    let inString = false;
    let escaped = false;
    for (let offset = 0; offset < source.length; offset += 1) {
        const character = source[offset];
        if (inString) {
            normalized += character;
            if (escaped)
                escaped = false;
            else if (character === "\\")
                escaped = true;
            else if (character === '"')
                inString = false;
            continue;
        }
        if (character === '"') {
            inString = true;
            normalized += character;
            continue;
        }
        if (character === ",") {
            let next = offset + 1;
            while (/\s/u.test(source[next] ?? ""))
                next += 1;
            if (source[next] === "}" || source[next] === "]")
                continue;
        }
        normalized += character;
    }
    return normalized;
}
function parseTelegramJsonObjectCandidate(source) {
    const normalized = removeTelegramJsonTrailingCommas(source);
    for (const candidate of normalized === source ? [source] : [source, normalized]) {
        try {
            const value = JSON.parse(candidate);
            if (isTelegramActionPayload(value))
                return value;
        }
        catch {
            // Try the bounded trailing-comma normalization before rejecting JSON.
        }
    }
    return undefined;
}
function looksLikeTelegramNamedJsonObject(source, offset) {
    return /^\{\s*"(?:[^"\\]|\\.)*"\s*:/u.test(source.slice(offset));
}
export function parseTelegramActionPayload(comment, command) {
    let content = comment.content.replace(/^\s+/, "").replace(/^!/, "");
    if (!content.startsWith(command))
        return undefined;
    content = content.slice(command.length);
    let attributeEnvelope = content;
    for (let offset = 0; offset < content.length; offset += 1) {
        if (content[offset] !== "{" && content[offset] !== "[")
            continue;
        if (content[offset] === "[" &&
            !isPlausibleTelegramMatrixStart(content, offset)) {
            const noiseEnd = findTelegramStructuredPayloadEnd(content, offset);
            if (noiseEnd !== undefined) {
                attributeEnvelope = `${attributeEnvelope.slice(0, offset)}${" ".repeat(noiseEnd - offset)}${attributeEnvelope.slice(noiseEnd)}`;
                offset = noiseEnd - 1;
            }
            continue;
        }
        if (content[offset] === "{") {
            const parsed = parseTelegramAdaptiveActionPayloadRows(content.slice(offset), parseTelegramVoiceCompactActionPayload, { allowTrailing: true });
            if (parsed)
                return parsed.rows[0][0];
        }
        const end = findTelegramStructuredPayloadEnd(content, offset);
        if (end === undefined)
            continue;
        attributeEnvelope = `${attributeEnvelope.slice(0, offset)}${" ".repeat(end - offset)}${attributeEnvelope.slice(end)}`;
        offset = end - 1;
    }
    return parseTolerantTelegramAttributes(attributeEnvelope, [
        "text",
        "value",
        "lang",
        "rate",
    ]);
}
const TELEGRAM_COMPACT_ACTION_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
function parseTelegramButtonCompactActionPayload(atoms) {
    const [label, prompt, selectedStyle, disabled] = atoms;
    if (atoms.length === 1)
        return label ? { value: label } : undefined;
    const isDisabled = disabled === "1" || disabled === "true";
    if (!prompt && !(atoms.length === 4 && isDisabled))
        return undefined;
    const action = label ? { label, prompt } : { prompt };
    if (atoms.length === 2)
        return action;
    if (selectedStyle !== "primary" &&
        selectedStyle !== "success" &&
        selectedStyle !== "danger" &&
        !(atoms.length === 4 && selectedStyle === ""))
        return undefined;
    if (atoms.length === 4 && !isDisabled && disabled !== "0" && disabled !== "false") {
        return undefined;
    }
    return {
        ...action,
        ...(selectedStyle ? { selected_style: selectedStyle } : {}),
        ...(atoms.length === 4 ? { disabled: isDisabled } : {}),
    };
}
function parseTelegramVoiceCompactActionPayload(atoms) {
    const [text, lang, rate] = atoms;
    if (!text)
        return undefined;
    if (atoms.length === 1)
        return { text };
    if (!lang)
        return undefined;
    if (atoms.length === 2)
        return { text, lang };
    if (!rate)
        return undefined;
    return { text, lang, rate };
}
function parseTelegramAdaptiveActionPayloadRows(source, parseCompactPayload, options = {}) {
    let offset = 0;
    const isStructuralWhitespace = (character) => character === " " ||
        character === "\t" ||
        character === "\r" ||
        character === "\n";
    const skipWhitespace = () => {
        while (isStructuralWhitespace(source[offset]))
            offset += 1;
    };
    const consumeOptionalSeparator = () => {
        skipWhitespace();
        if (source[offset] !== ",")
            return true;
        offset += 1;
        skipWhitespace();
        return source[offset] !== ",";
    };
    const normalizeAtom = (value) => {
        const normalized = value.trim();
        return !TELEGRAM_COMPACT_ACTION_CONTROL_PATTERN.test(normalized)
            ? normalized
            : undefined;
    };
    const parseCompactCell = () => {
        if (source[offset] !== "{")
            return undefined;
        offset += 1;
        const atomSources = [[]];
        while (offset < source.length) {
            const character = source[offset];
            if (character === "\\") {
                const escaped = source[offset + 1];
                if (escaped !== "|" && escaped !== "}" && escaped !== "\\") {
                    return undefined;
                }
                atomSources.at(-1).push(escaped);
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
                if (atoms.some((atom) => atom === undefined))
                    return undefined;
                return parseCompactPayload(atoms);
            }
            atomSources.at(-1).push(character);
            offset += 1;
        }
        return undefined;
    };
    const parseJsonObjectCell = () => {
        if (source[offset] !== "{")
            return undefined;
        const start = offset;
        const stack = [];
        let inString = false;
        let escaped = false;
        for (let index = start; index < source.length; index += 1) {
            const character = source[index];
            if (inString) {
                if (escaped)
                    escaped = false;
                else if (character === "\\")
                    escaped = true;
                else if (character === '"')
                    inString = false;
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
            if (character !== "}" && character !== "]")
                continue;
            const opening = stack.pop();
            if ((character === "}" && opening !== "{") ||
                (character === "]" && opening !== "["))
                return undefined;
            if (stack.length > 0)
                continue;
            const candidate = source.slice(start, index + 1);
            const value = parseTelegramJsonObjectCandidate(candidate);
            if (!value)
                return undefined;
            offset = index + 1;
            return value;
        }
        return undefined;
    };
    const parseCell = () => {
        const start = offset;
        const jsonCell = parseJsonObjectCell();
        if (jsonCell)
            return jsonCell;
        offset = start;
        if (looksLikeTelegramNamedJsonObject(source, start))
            return undefined;
        return parseCompactCell();
    };
    const parseRow = () => {
        if (source[offset] !== "[")
            return undefined;
        offset += 1;
        const row = [];
        while (offset < source.length) {
            skipWhitespace();
            if (source[offset] === "]") {
                offset += 1;
                return row.length > 0 ? row : undefined;
            }
            if (source[offset] !== "{")
                return undefined;
            const cell = parseCell();
            if (!cell)
                return undefined;
            row.push(cell);
            if (!consumeOptionalSeparator())
                return undefined;
        }
        return undefined;
    };
    const parseMatrix = () => {
        if (source[offset] !== "[")
            return undefined;
        offset += 1;
        const rows = [];
        while (offset < source.length) {
            skipWhitespace();
            const character = source[offset];
            if (character === "]") {
                offset += 1;
                return rows.length > 0 ? rows : undefined;
            }
            if (character === "{") {
                const cell = parseCell();
                if (!cell)
                    return undefined;
                rows.push([cell]);
            }
            else if (character === "[") {
                const row = parseRow();
                if (!row)
                    return undefined;
                rows.push(row);
            }
            else {
                return undefined;
            }
            if (!consumeOptionalSeparator())
                return undefined;
        }
        return undefined;
    };
    const parseVerticalSequence = () => {
        const rows = [];
        while (offset < source.length) {
            skipWhitespace();
            if (source[offset] !== "{")
                break;
            const cell = parseCell();
            if (!cell)
                return undefined;
            rows.push([cell]);
            if (!consumeOptionalSeparator())
                return undefined;
        }
        return rows.length > 0 ? rows : undefined;
    };
    skipWhitespace();
    const rows = source[offset] === "{"
        ? parseVerticalSequence()
        : parseMatrix();
    if (!rows)
        return undefined;
    skipWhitespace();
    if (!options.allowTrailing && offset !== source.length)
        return undefined;
    return { rows, end: offset };
}
function findTelegramStructuredPayloadEnd(source, start) {
    const stack = [source[start]];
    let inString = false;
    let escaped = false;
    for (let offset = start + 1; offset < source.length; offset += 1) {
        const character = source[offset];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (character === "\\")
                escaped = true;
            else if (character === '"')
                inString = false;
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
        if (character !== "]" && character !== "}")
            continue;
        const expected = character === "]" ? "[" : "{";
        if (stack.at(-1) === expected)
            stack.pop();
        if (stack.length === 0)
            return offset + 1;
    }
    return undefined;
}
function isPlausibleTelegramMatrixStart(source, start) {
    let offset = start + 1;
    while (/\s/u.test(source[offset] ?? ""))
        offset += 1;
    return (source[offset] === "{" ||
        source[offset] === "[" ||
        source[offset] === "]");
}
export function parseTelegramButtonPayloadRows(source) {
    return parseTelegramAdaptiveActionPayloadRows(source.trim(), parseTelegramButtonCompactActionPayload, { maxCompactAtoms: 4 })?.rows;
}
export function parseTelegramActionPayloadRows(comment, command) {
    let content = comment.content.replace(/^\s+/, "").replace(/^!/, "");
    if (!content.startsWith(command))
        return undefined;
    content = content.slice(command.length);
    let attributeEnvelope = content;
    for (let offset = 0; offset < content.length; offset += 1) {
        if (content[offset] !== "[" && content[offset] !== "{")
            continue;
        if (content[offset] === "[" &&
            !isPlausibleTelegramMatrixStart(content, offset)) {
            const noiseEnd = findTelegramStructuredPayloadEnd(content, offset);
            if (noiseEnd !== undefined) {
                attributeEnvelope = `${attributeEnvelope.slice(0, offset)}${" ".repeat(noiseEnd - offset)}${attributeEnvelope.slice(noiseEnd)}`;
                offset = noiseEnd - 1;
            }
            continue;
        }
        const parsed = parseTelegramAdaptiveActionPayloadRows(content.slice(offset), parseTelegramButtonCompactActionPayload, { allowTrailing: true, maxCompactAtoms: 4 });
        if (parsed)
            return parsed.rows;
        const end = findTelegramStructuredPayloadEnd(content, offset);
        if (end === undefined)
            continue;
        attributeEnvelope = `${attributeEnvelope.slice(0, offset)}${" ".repeat(end - offset)}${attributeEnvelope.slice(end)}`;
        offset = end - 1;
    }
    const attributes = parseTolerantTelegramAttributes(attributeEnvelope, [
        "label",
        "prompt",
        "value",
        "selected_style",
        "disabled",
    ]);
    if (!attributes)
        return undefined;
    return [[{
                ...attributes,
                ...(attributes.disabled === "true" || attributes.disabled === "false"
                    ? { disabled: attributes.disabled === "true" }
                    : {}),
            }]];
}
export function normalizeMarkdownAfterVoiceExtraction(markdown) {
    return markdown.replace(/\n{3,}/g, "\n\n").trim();
}
function isTelegramCommentOnlyLinePrefix(value) {
    return /^[ \t]*(?:(?:>[ \t]*)+)?(?:(?:[-+*]|\d+[.)])[ \t]+)?$/u.test(value);
}
function stripTelegramHtmlCommentBlocks(markdown) {
    let result = "";
    let offset = 0;
    while (offset < markdown.length) {
        const start = markdown.indexOf("<!--", offset);
        if (start === -1)
            return result + markdown.slice(offset);
        const close = markdown.indexOf("-->", start + 4);
        const lineStart = markdown.lastIndexOf("\n", start - 1) + 1;
        const afterComment = close === -1 ? markdown.length : close + 3;
        const newlineAfterComment = markdown.indexOf("\n", afterComment);
        const lineEnd = newlineAfterComment === -1 ? markdown.length : newlineAfterComment;
        const commentOwnsLine = isTelegramCommentOnlyLinePrefix(markdown.slice(lineStart, start)) &&
            markdown.slice(afterComment, lineEnd).trim().length === 0;
        result += markdown.slice(offset, commentOwnsLine ? lineStart : start);
        if (close === -1)
            return result;
        offset = commentOwnsLine
            ? newlineAfterComment === -1
                ? markdown.length
                : newlineAfterComment + 1
            : afterComment;
    }
    return result;
}
export function stripTelegramCommentMarkupForPreview(markdown) {
    const withoutClosedBlocks = stripTelegramHtmlCommentBlocks(replaceTelegramButtonFences(markdown, () => ""));
    const openBlockIndex = findTopLevelOpenOrPartialHtmlCommentIndex(withoutClosedBlocks);
    const previewMarkdown = openBlockIndex >= 0
        ? withoutClosedBlocks.slice(0, openBlockIndex)
        : withoutClosedBlocks;
    return normalizeMarkdownAfterVoiceExtraction(previewMarkdown);
}
export function stripTelegramCommentMarkupForDelivery(markdown) {
    const withoutClosedBlocks = stripTelegramHtmlCommentBlocks(markdown);
    const openBlockIndex = findTopLevelOpenOrPartialHtmlCommentIndex(withoutClosedBlocks);
    const deliveryMarkdown = openBlockIndex >= 0
        ? withoutClosedBlocks.slice(0, openBlockIndex)
        : withoutClosedBlocks;
    return normalizeMarkdownAfterVoiceExtraction(deliveryMarkdown);
}
export function stripTelegramVoiceMarkupForPreview(markdown) {
    return stripTelegramCommentMarkupForPreview(markdown);
}
function getTelegramActionString(payload, key) {
    const value = payload[key];
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
}
export function planTelegramVoiceReply(markdown) {
    const voiceReplies = [];
    let lang;
    let rate;
    const stripped = replaceTopLevelHtmlComments(markdown, (comment) => {
        const command = "telegram_voice";
        const normalizedContent = comment.content.replace(/^\s+/, "").replace(/^!/, "");
        if (!normalizedContent.startsWith(command))
            return comment.raw;
        const payload = parseTelegramActionPayload(comment, command);
        if (!payload)
            return "";
        const text = getTelegramActionString(payload, "text") ??
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
        if (itemLang)
            lang = itemLang;
        if (itemRate)
            rate = itemRate;
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
