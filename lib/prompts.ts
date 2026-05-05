/**
 * Telegram prompt injection helpers
 * Owns Telegram-specific system prompt suffixes injected into pi agent turns
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

const LOG_DIR = join(homedir(), ".pi", "agent", "logs");
export const LOG_FILE = join(LOG_DIR, "telegram-bridge.log");
export const MAX_LOG_ENTRIES = 200;

/** Write a JSON debug log entry (~/.pi/agent/logs/telegram-bridge.log) */
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

/** Prune old log entries — keep only MAX_LOG_ENTRIES most recent */
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

const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge extension is active.
- Messages forwarded from Telegram are prefixed with "[telegram]".
- [telegram] messages may include [attachments] sections with a base directory plus relative local file entries. Resolve and read those files as needed.
- Telegram is often read on narrow phone screens, so prefer narrow table columns when presenting tabular data; wide monospace tables can become unreadable.
- If a [telegram] user asked for a file or generated artifact, use telegram_attach with the local path instead of only mentioning the path in text.
- Do not assume mentioning a local file path in plain text will send it to Telegram. Use telegram_attach.
- When a [telegram] message starts with "❗CONFIRM:", the user put 🤔 reaction on it. Use __ask_user__ tool to ask if they want to proceed. Only process if they confirm.
- **TRANSLATION**: If the user's message is not in English, auto-detect its language and translate it to English internally before processing. Then respond in English. Before delivering the final reply, translate it back to the user's original language. Preserve code blocks (\`\`\`), markdown formatting, emoji, URLs, @mentions, and #hashtags during translation. Never translate slash commands (/start, /help, etc.). If the message is already in English, skip translation entirely. This bypasses paid translation APIs (Google Translate, DeepL) — use the LLM's built-in multilingual capability instead.`;

export function buildTelegramBridgeSystemPrompt(options: {
  prompt: string;
  systemPrompt: string;
  telegramPrefix?: string;
  systemPromptSuffix: string;
}): { systemPrompt: string } {
  const telegramPrefix = options.telegramPrefix ?? TELEGRAM_PREFIX;
  const suffix = options.prompt.trimStart().startsWith(telegramPrefix)
    ? `${options.systemPromptSuffix}\n- The current user message came from Telegram.`
    : options.systemPromptSuffix;
  return { systemPrompt: options.systemPrompt + suffix };
}

export function createTelegramBeforeAgentStartHook(
  options: { telegramPrefix?: string; systemPromptSuffix?: string } = {},
): (event: BeforeAgentStartEvent) => { systemPrompt: string } {
  pruneTelegramBridgeLogs();
  return (event) => {
    const suffix = options.systemPromptSuffix ?? SYSTEM_PROMPT_SUFFIX;
    const result = buildTelegramBridgeSystemPrompt({
      prompt: event.prompt,
      systemPrompt: event.systemPrompt,
      telegramPrefix: options.telegramPrefix,
      systemPromptSuffix: suffix,
    });
    logTelegramBridgePrompt({
      timestamp: new Date().toISOString(),
      originalPrompt: event.prompt,
      systemPromptSuffix: suffix,
    });
    return result;
  };
}
