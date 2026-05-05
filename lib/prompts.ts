/**
 * Telegram prompt injection helpers
 * Owns Telegram-specific system prompt suffixes injected into pi agent turns
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync as removeSync,
	unlinkSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";
import type { BeforeAgentStartEvent } from "./pi.ts";
import { TELEGRAM_PREFIX } from "./turns.ts";

const LOG_DIR = join(homedir(), ".pi", "agent", "logs");
export const LOG_FILE = join(LOG_DIR, "telegram-bridge.log");
export const MAX_LOG_ENTRIES = 200;

/** Ensure log directory exists */
function ensureLogDir(): void {
	try {
		mkdirSync(LOG_DIR, { recursive: true });
	} catch {
		/* ignore */
	}
}

/** Prune old log entries — keep only MAX_LOG_ENTRIES most recent */
export function pruneTelegramBridgeLogs(): void {
	try {
		if (!existsSync(LOG_FILE)) return;
		const content = readFileSync(LOG_FILE, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		if (lines.length <= MAX_LOG_ENTRIES) return;
		const pruned =
			lines.slice(lines.length - MAX_LOG_ENTRIES).join("\n") + "\n";
		const tmp = join(LOG_DIR, ".telegram-bridge-log.tmp");
		appendFileSync(tmp, pruned, "utf-8");
		try {
			removeSync(LOG_FILE);
		} catch {
			/* ignore */
		}
		try {
			appendFileSync(LOG_FILE, pruned, "utf-8");
		} catch {
			/* ignore */
		}
		try {
			removeSync(tmp);
		} catch {
			/* ignore */
		}
	} catch {
		/* ignore */
	}
}

/** Write a JSON debug log entry for prompt debugging */
export function logTelegramBridgePrompt(options: {
	timestamp: string;
	originalPrompt: string;
	systemPromptSuffix: string;
}): void {
	try {
		ensureLogDir();
		const entry =
			JSON.stringify({
				ts: options.timestamp,
				prompt: options.originalPrompt.slice(0, 500),
				suffix: options.systemPromptSuffix.slice(0, 300),
			}) + "\n";
		appendFileSync(LOG_FILE, entry, "utf-8");
	} catch {
		/* ignore */
	}
}

const SUMMARY_PATH = "/tmp/pi-telegram-context-summary";

/** One-shot: read + delete AAAK context summary. Only returns content on first call. */
function loadContextSummary(): string {
	try {
		if (existsSync(SUMMARY_PATH)) {
			const raw = readFileSync(SUMMARY_PATH, "utf-8").trim();
			unlinkSync(SUMMARY_PATH);
			if (raw)
				return `\n- Previous session context (AAAK):|previous=${raw.replace(/\n/g, "|")}`;
		}
	} catch {
		/* ignore */
	}
	return "";
}

const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge extension is active.
- Messages forwarded from Telegram are prefixed with "[telegram]".
- [telegram] messages may include [attachments] sections with a base directory plus relative local file entries. Resolve and read those files as needed.
- Telegram is often read on narrow phone screens, so prefer narrow table columns when presenting tabular data; wide monospace tables can become unreadable.
- If a [telegram] user asked for a file or generated artifact, use telegram_attach with the local path instead of only mentioning the path in text.
- Do not assume mentioning a local file path in plain text will send it to Telegram. Use telegram_attach.
- When a [telegram] message starts with "🗳CONFIRM:", the user put 🤔 reaction on it. Use __ask_user__ tool to ask if they want to proceed. Only process if they confirm.
- **TRANSLATION**: If the user's message is in Vietnamese or Chinese (or any non-English language), translate it to English internally before processing. Then respond in English. Before delivering the final reply, translate it back to the user's original language. Preserve code blocks (\`\`\`), markdown formatting, emoji, URLs, @mentions, and #hashtags during translation. Never translate slash commands (/start, /help, etc.). If the message is already in English, skip translation entirely. This bypasses paid translation APIs (Google Translate, DeepL) — use the LLM's built-in multilingual capability instead.`;

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
	// Prune old logs at start
	pruneTelegramBridgeLogs();

	return (event) => {
		const suffix =
			(options.systemPromptSuffix ?? SYSTEM_PROMPT_SUFFIX) +
			loadContextSummary();
		const result = buildTelegramBridgeSystemPrompt({
			prompt: event.prompt,
			systemPrompt: event.systemPrompt,
			telegramPrefix: options.telegramPrefix,
			systemPromptSuffix: suffix,
		});

		// Log prompt for debug (non-blocking, silent on failure)
		logTelegramBridgePrompt({
			timestamp: new Date().toISOString(),
			originalPrompt: event.prompt,
			systemPromptSuffix: suffix,
		});

		return result;
	};
}
