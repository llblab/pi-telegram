/**
 * Telegram prompt injection helpers
 * Zones: pi agent prompts, telegram guidance
 * Owns Telegram-specific system prompt suffixes injected into pi agent turns
 */

import type { BeforeAgentStartEvent } from "./pi.ts";
import { TELEGRAM_PREFIX } from "./turns.ts";

const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge extension is active.

Inbound context:
- \`[telegram]\` marks Telegram-originated messages.
- \`[reply]\` is quoted context from the replied-to message, not a new instruction by itself. Use it to resolve references like "this", "it", or "that message"; the actual instruction is before [reply] unless it explicitly asks to act on the quote.
- \`[attachments]\` gives a base directory plus relative local files; resolve and read them as needed. \`[outputs]\` contains attachment-handler stdout such as transcriptions or extracted text for those attachments.

Telegram-visible output:
- Telegram is often phone-width; prefer narrow table columns because wide monospace tables can become unreadable.
- For requested/generated files, call tool \`telegram_attach(local_path)\`; mentioning a local path in text does not send it.

Native outbound actions:
- Use top-level column-zero hidden Markdown comments outside code, quotes, and lists; the bridge handles them after agent_end, so do not call or register transport/TTS/text-to-OGG tools.
- \`telegram_voice\`: text is synthesized through the configured outbound-handler pipeline. Use body text for multiline voice, \`<!-- telegram_voice text="Short summary" -->\` for explicit one-line voice, or \`<!-- telegram_voice: Short summary -->\` for one-line voice with no attributes. A companion summary is optional, no specific summary format is required. Keep it TTS-friendly; avoid raw Markdown, code, formulas, tables, or long lists.
- \`telegram_button\`: callback prompt is routed back as a normal Telegram turn. Use \`<!-- telegram_button: OK -->\` when prompt equals label, \`<!-- telegram_button label=Continue prompt="Continue with the current plan." -->\` for one-line prompts, or body form \`<!-- telegram_button label="Show risks"\nList the main risks first.\n-->\` for multiline prompts.
- If only hidden action comments would remain, add visible parent text like "Choose one:".
`;

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
  options: {
    telegramPrefix?: string;
    systemPromptSuffix?: string;
  } = {},
): (event: BeforeAgentStartEvent) => { systemPrompt: string } {
  return (event) =>
    buildTelegramBridgeSystemPrompt({
      prompt: event.prompt,
      systemPrompt: event.systemPrompt,
      telegramPrefix: options.telegramPrefix,
      systemPromptSuffix: options.systemPromptSuffix ?? SYSTEM_PROMPT_SUFFIX,
    });
}
