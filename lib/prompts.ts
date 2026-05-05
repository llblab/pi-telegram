/**
 * Telegram prompt injection helpers
 * Owns Telegram-specific system prompt suffixes injected into pi agent turns
 *
 * Features:
 * - Google Translate bypass (reverse-engineered token) for input translation
 * - LLM-native TRANSLATION instruction as fallback for response translation
 * - Debug logging with auto-prune
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BeforeAgentStartEvent } from "./pi.ts";
import { TELEGRAM_PREFIX } from "./turns.ts";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const LOG_DIR = join(homedir(), ".pi", "agent", "logs");
export const LOG_FILE = join(LOG_DIR, "telegram-bridge.log");
export const MAX_LOG_ENTRIES = 200;

export function logTelegramBridgePrompt(options: {
  timestamp: string;
  originalPrompt: string;
  systemPromptSuffix: string;
}): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(
      LOG_FILE,
      JSON.stringify({
        ts: options.timestamp,
        prompt: options.originalPrompt.slice(0, 500),
        suffix: options.systemPromptSuffix.slice(0, 300),
      }) + "\n",
      "utf-8",
    );
  } catch {
    /* silent */
  }
}

export function pruneTelegramBridgeLogs(): void {
  try {
    if (!existsSync(LOG_FILE)) return;
    const lines = readFileSync(LOG_FILE, "utf-8").trim().split("\n").filter(Boolean);
    if (lines.length <= MAX_LOG_ENTRIES) return;
    const pruned = lines.slice(lines.length - MAX_LOG_ENTRIES).join("\n") + "\n";
    writeFileSync(LOG_FILE, pruned, "utf-8");
  } catch {
    /* silent */
  }
}

// ---------------------------------------------------------------------------
// Google Translate bypass — reverse-engineered token generation
// https://translate.google.com/translate_a/single
// No API key required. Free.
// ---------------------------------------------------------------------------

function hexCharAsNumber(xd: string): number {
  return xd >= "a" ? xd.charCodeAt(0) - 87 : Number(xd);
}

function shiftLeftOrRightThenSumOrXor(num: number, opArray: string[]): number {
  return opArray.reduce((acc: number, opString: string) => {
    const op1 = opString[1];
    const op2 = opString[0];
    const xd = opString[2];
    const shiftAmount = hexCharAsNumber(xd);
    const mask = op1 === "+" ? acc >>> shiftAmount : acc << shiftAmount;
    return op2 === "+" ? (acc + mask & 0xffffffff) : (acc ^ mask);
  }, num);
}

function transformQuery(query: string): number[] {
  const e: number[] = [];
  let f = 0;
  for (let g = 0; g < query.length; g++) {
    let l = query.charCodeAt(g);
    if (l < 128) {
      e[f++] = l;
    } else if (l < 2048) {
      e[f++] = (l >> 6) | 0xc0;
      e[f++] = l & 0x3f | 0x80;
    } else if (0xd800 === (l & 0xfc00) && g + 1 < query.length && 0xdc00 === (query.charCodeAt(g + 1) & 0xfc00)) {
      l = (1 << 16) + ((l & 0x03ff) << 10) + (query.charCodeAt(++g) & 0x03ff);
      e[f++] = (l >> 18) | 0xf0;
      e[f++] = (l >> 12) & 0x3f | 0x80;
      e[f++] = l & 0x3f | 0x80;
    } else {
      e[f++] = (l >> 12) | 0xe0;
      e[f++] = (l >> 6) & 0x3f | 0x80;
      e[f++] = l & 0x3f | 0x80;
    }
  }
  return e;
}

function normalizeHash(encodingRound2: number): number {
  if (encodingRound2 < 0) {
    encodingRound2 = (encodingRound2 & 0x7fffffff) + 0x80000000;
  }
  return encodingRound2 % 1e6;
}

function calcHash(query: string, windowTkk: string): string {
  const bytesArray = transformQuery(query);
  const d = windowTkk.split(".");
  const tkkIndex = Number(d[0]) || 0;
  const tkkKey = Number(d[1]) || 0;
  const encodingRound1 = bytesArray.reduce((acc: number, current: number) => {
    acc += current;
    return shiftLeftOrRightThenSumOrXor(acc, ["+-a", "^+6"]);
  }, tkkIndex);
  const encodingRound2 = shiftLeftOrRightThenSumOrXor(encodingRound1, ["+-3", "^+b", "+-f"]) ^ tkkKey;
  const normalizedResult = normalizeHash(encodingRound2);
  return `${normalizedResult}.${normalizedResult ^ tkkIndex}`;
}

/** Translate text via Google Translate bypass (free, no API key needed) */
export async function translateViaGoogle(
  text: string,
  from: string,
  to: string,
): Promise<string> {
  const tkk = `410958.${Date.now()}`;
  const token = calcHash(text, tkk);
  const params = new URLSearchParams({
    client: "gtx",
    sl: from,
    tl: to,
    hl: to,
    dt: "t",
    q: text,
    tk: token,
  });
  const url = `https://translate.google.com/translate_a/single?${params.toString()}`;
  try {
    const res = await fetch(url);
    const raw = await res.text();
    const parsed = JSON.parse(raw);
    return parsed[0]?.[0]?.[0] ?? text;
  } catch {
    return text;
  }
}

/** Detect language via Google Translate bypass. Returns ISO 639-1 code. */
export async function detectLanguageViaGoogle(text: string): Promise<string> {
  const tkk = `410958.${Date.now()}`;
  const token = calcHash(text, tkk);
  const params = new URLSearchParams({
    client: "gtx",
    sl: "auto",
    tl: "en",
    hl: "en",
    dt: "at",
    q: text,
    tk: token,
  });
  const url = `https://translate.google.com/translate_a/single?${params.toString()}`;
  try {
    const res = await fetch(url);
    const raw = await res.text();
    const parsed = JSON.parse(raw);
    return parsed[2] ?? "auto";
  } catch {
    return "auto";
  }
}

// ---------------------------------------------------------------------------
// ISO 639-1 → language name mapping
// ---------------------------------------------------------------------------

const LANG_NAMES: Record<string, string> = {
  vi: "Vietnamese", zh: "Chinese", ja: "Japanese", ko: "Korean",
  ar: "Arabic", th: "Thai", hi: "Hindi", bn: "Bangla",
  pt: "Portuguese", es: "Spanish", fr: "French", de: "German",
  ru: "Russian", it: "Italian", nl: "Dutch", tr: "Turkish",
  pl: "Polish", uk: "Ukrainian", ro: "Romanian", cs: "Czech",
  hu: "Hungarian", sv: "Swedish", da: "Danish", fi: "Finnish",
  el: "Greek", he: "Hebrew", id: "Indonesian", ms: "Malay",
  tl: "Filipino", ta: "Tamil", te: "Telugu", kn: "Kannada",
  ml: "Malayalam", mr: "Marathi", gu: "Gujarati", pa: "Punjabi",
  ur: "Urdu", fa: "Persian", ku: "Kurdish", km: "Khmer",
  lo: "Lao", my: "Burmese", ne: "Nepali", si: "Sinhala",
  am: "Amharic", hy: "Armenian", ka: "Georgian", is: "Icelandic",
  ha: "Hausa", sw: "Swahili", yo: "Yoruba", zu: "Zulu",
  ca: "Catalan", eu: "Basque", gl: "Galician", hr: "Croatian",
  sr: "Serbian", sk: "Slovak", sl: "Slovenian", et: "Estonian",
  lt: "Lithuanian", lv: "Latvian", sq: "Albanian", mk: "Macedonian",
  mn: "Mongolian", az: "Azerbaijani", uz: "Uzbek", kk: "Kazakh",
  af: "Afrikaans", cy: "Welsh", ht: "Haitian Creole", la: "Latin",
  no: "Norwegian", bs: "Bosnian", mt: "Maltese", ga: "Irish",
};

// ---------------------------------------------------------------------------
// System prompt suffix
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge extension is active.
- Messages forwarded from Telegram are prefixed with "[telegram]".
- [telegram] messages may include [attachments] sections with a base directory plus relative local file entries. Resolve and read those files as needed.
- Telegram is often read on narrow phone screens, so prefer narrow table columns when presenting tabular data; wide monospace tables can become unreadable.
- If a [telegram] user asked for a file or generated artifact, use telegram_attach with the local path instead of only mentioning the path in text.
- Do not assume mentioning a local file path in plain text will send it to Telegram. Use telegram_attach.
- When a [telegram] message starts with "\u2757CONFIRM:", the user put \u{1f914} reaction on it. Use __ask_user__ tool to ask if they want to proceed. Only process if they confirm.`;

const TELEGRAM_TRANSLATION_LINE = `\n- The current user message came from Telegram.`;

// ---------------------------------------------------------------------------
// Telegram prefix detection
// ---------------------------------------------------------------------------

/** Extract the raw message text by stripping the Telegram prefix */
function extractTelegramMessage(prompt: string): string | null {
  const trimmed = prompt.trimStart();
  if (trimmed.startsWith(TELEGRAM_PREFIX)) {
    return trimmed.slice(TELEGRAM_PREFIX.length).trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// English-only ASCII check (fast path — avoid network call for EN-only text)
// ---------------------------------------------------------------------------

function hasOnlyAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Main exported functions
// ---------------------------------------------------------------------------

export function buildTelegramBridgeSystemPrompt(options: {
  prompt: string;
  systemPrompt: string;
  telegramPrefix?: string;
  systemPromptSuffix: string;
}): { systemPrompt: string } {
  const telegramPrefix = options.telegramPrefix ?? TELEGRAM_PREFIX;
  const suffix = options.prompt.trimStart().startsWith(telegramPrefix)
    ? `${options.systemPromptSuffix}${TELEGRAM_TRANSLATION_LINE}`
    : options.systemPromptSuffix;
  return { systemPrompt: options.systemPrompt + suffix };
}

/**
 * Create a before-agent-start hook that:
 * 1. Detects non-English Telegram messages via Google Translate bypass
 * 2. Translates the message to English (for accurate understanding)
 * 3. Adds detailed translation info to the system prompt
 * 4. Keeps LLM-native translation for response generation
 */
export function createTelegramBeforeAgentStartHook(
  options: { telegramPrefix?: string; systemPromptSuffix?: string } = {},
): (event: BeforeAgentStartEvent) => Promise<{ systemPrompt: string }> | { systemPrompt: string } {
  pruneTelegramBridgeLogs();

  return (event: BeforeAgentStartEvent) => {
    const baseSuffix = options.systemPromptSuffix ?? SYSTEM_PROMPT_SUFFIX;
    const isTelegram = event.prompt.trimStart().startsWith(options.telegramPrefix ?? TELEGRAM_PREFIX);

    if (!isTelegram) {
      // Non-Telegram messages — just append suffix as-is
      logTelegramBridgePrompt({
        timestamp: new Date().toISOString(),
        originalPrompt: event.prompt,
        systemPromptSuffix: baseSuffix,
      });
      return { systemPrompt: event.systemPrompt + baseSuffix };
    }

    const userMessage = extractTelegramMessage(event.prompt);

    // Fast path: if message is pure ASCII, it's English — no translation needed
    if (userMessage && hasOnlyAscii(userMessage)) {
      const suffix = `${baseSuffix}${TELEGRAM_TRANSLATION_LINE}`;
      logTelegramBridgePrompt({
        timestamp: new Date().toISOString(),
        originalPrompt: event.prompt,
        systemPromptSuffix: suffix,
      });
      return { systemPrompt: event.systemPrompt + suffix };
    }

    // Async path: detect & translate via Google Translate bypass
    return (async () => {
      try {
        const detectedLang = await detectLanguageViaGoogle(userMessage ?? "");
        const langName = LANG_NAMES[detectedLang] ?? detectedLang;

        if (detectedLang === "en" || detectedLang === "auto") {
          // English or undetected — just add Telegram marker
          const suffix = `${baseSuffix}${TELEGRAM_TRANSLATION_LINE}`;
          logTelegramBridgePrompt({
            timestamp: new Date().toISOString(),
            originalPrompt: event.prompt,
            systemPromptSuffix: suffix,
          });
          return { systemPrompt: event.systemPrompt + suffix };
        }

        // Non-English — translate via Google Translate bypass
        const translated = await translateViaGoogle(userMessage ?? "", detectedLang, "en");

        // Build enhanced system prompt with translation info + LLM-native TRANSLATION fallback
        const translationNotice =
          `\n- **Language Detection**: The user's message is in ${langName} (ISO: ${detectedLang}).` +
          `\n- **English Translation (via Google Translate)**: "${translated}"` +
          `\n- **ACTION REQUIRED**: The user's original message above is in ${langName}. Respond in ${langName}.` +
          `\n  Use the English translation above ONLY for understanding the content accurately.` +
          `\n  Your final reply MUST be in ${langName}.` +
          `\n  If you cannot write in ${langName}, respond in English and state that you cannot write in ${langName}.`;

        const suffix = `${baseSuffix}${TELEGRAM_TRANSLATION_LINE}${translationNotice}`;
        logTelegramBridgePrompt({
          timestamp: new Date().toISOString(),
          originalPrompt: event.prompt,
          systemPromptSuffix: suffix,
        });
        return { systemPrompt: event.systemPrompt + suffix };
      } catch {
        // Fallback: just use base suffix with Telegram marker
        const suffix = `${baseSuffix}${TELEGRAM_TRANSLATION_LINE}`;
        return { systemPrompt: event.systemPrompt + suffix };
      }
    })();
  };
}

/**
 * Translate the agent's response back to the original language via Google Translate bypass.
 * To be called from the agent_end hook.
 */
export function createTelegramAfterAgentEndHook(): (
  response: string,
  originalLang: string,
) => Promise<string> {
  return async (response: string, originalLang: string): Promise<string> => {
    if (originalLang === "en" || originalLang === "auto") return response;
    try {
      return await translateViaGoogle(response, "en", originalLang);
    } catch {
      return response;
    }
  };
}
