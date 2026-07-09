/**
 * Telegram prompt injection helpers
 * Zones: pi agent prompts, telegram guidance
 * Owns Telegram-specific system prompt suffixes injected into pi agent turns
 */

import { Type } from "@sinclair/typebox";

import { getTelegramDiagnosticsDisplayPaths } from "./paths.ts";
import type { BeforeAgentStartEvent, ExtensionAPI } from "./pi.ts";
import { TELEGRAM_PREFIX } from "./turns.ts";

const LOCAL_SYSTEM_PROMPT_SUFFIX = `

Telegram bridge available. Do not use it from local/TUI prompts unless explicitly asked.`;

const TELEGRAM_TURN_SYSTEM_PROMPT_SUFFIX = `

Telegram turn note: If context was compacted or you need the pi-telegram bridge contract, call tool \`telegram_help\`; hidden comments are valid only for explicit \`telegram_voice\` or \`telegram_button\` actions with payload.`;

function buildTelegramHelpText(profileName?: string): string {
  const diagnosticsPaths = getTelegramDiagnosticsDisplayPaths(profileName);
  return `--- TELEGRAM BRIDGE HELP ---

How to understand Telegram turns:
- \`[telegram|thread:name|from:user|guest:group]\` marks Telegram origin and attributes.
- \`thread\` is the visible Thread identity in Threaded Mode; it is not a bus role.
- \`[reply]\` is quoted context only; act on the user's current instruction.
- \`[attachments]\` are local files; \`[outputs]\` are handler results/transcripts; \`[time]\` is wall-clock context; \`[voice]\` gives reply-mode policy.

How to answer Telegram turns:
- Reply in concise, scannable mobile Telegram Rich Markdown.
- Use \`$...$\` for inline math and \`$$...$$\` for block math.
- Real code blocks must stay literal.
- For generated/requested files, call \`telegram_attach(local_path)\`; do not only mention the path.

Assistant-authored Telegram actions:
- \`telegram_voice\` and \`telegram_button\` are hidden top-level HTML comments, not Pi tools.
- Put action comments at column zero, outside code, quotes, lists, and indented examples.
- Voice forms: \`<!-- telegram_voice text="Short summary" -->\` or \`<!-- telegram_voice: Short summary -->\`.
- Keep voice text TTS-friendly; avoid raw Markdown, code, and tables in voice text.
- Voice delivery generates and attaches OGG automatically; do not also call \`telegram_attach\` for the same audio.
- Button forms: \`<!-- telegram_button: OK -->\`, \`<!-- telegram_button label=Continue prompt="Continue with the current plan." -->\`, or multiline \`<!-- telegram_button label="Show risks"\nList the main risks first.\n-->\`.
- If hidden comments would be the whole reply, add visible text such as \`Choose one:\`.

Local/TUI direct delivery:
- Do not send Telegram actions from local/TUI prompts unless explicitly asked.
- Use \`telegram_attach\` for files and \`telegram_message\` for direct Markdown text.
- Direct delivery requires this Pi instance to own \`/telegram-connect\` or be registered with the Threaded Mode bus.
- For explicit targets, pass \`chat_id\` plus optional \`thread_id\`; registered followers default to their assigned Thread target.
- Do not use \`telegram_message\` for ordinary Telegram-originated replies; answer normally and let the bridge deliver the active turn reply.

Threaded Mode:
- pi-telegram supports private-chat Threaded Mode when Telegram exposes thread support for the bot.
- Product/user language is Thread; Bot API primitive names may still say topic.
- Threaded Mode has one leader transport and visible follower Pi processes joined manually through \`/telegram-connect\`.
- Thread names are bridge-assigned or preserved identities; do not invent rename prompts or use a rename tool.
- The \`All\` surface is for routing/control, not hidden Pi process creation.

Configurable handlers:
- \`telegram.json\` can add no-code \`inboundHandlers\`/\`outboundHandlers\` using command templates before writing an extension.
- For speech-to-text, configure an \`inboundHandlers\` entry matching \`type: "voice"\` or \`mime: "audio/*"\`; stdout becomes \`[outputs]\` prompt context.
- If command-template config is not enough, build a companion extension through the public pi-telegram APIs; do not import package-private \`lib/*\` paths.

Debugging pi-telegram:
- Inspect \`${diagnosticsPaths.state}\` for runtime state, roster, bindings, slots, reservations, and diagnostics.
- Inspect \`${diagnosticsPaths.logs}\` for redacted runtime event evidence.
- Use terminal \`telegram-status\` for compact human health; use \`telegram-status --debug\` for the full human-readable diagnostic dump.`;
}

export function getTelegramHelpText(profileName?: string): string {
  return buildTelegramHelpText(profileName);
}

export function registerTelegramHelpTool(
  pi: ExtensionAPI,
  options: { getActiveProfileName?: () => string | undefined } = {},
): void {
  pi.registerTool({
    name: "telegram_help",
    label: "Telegram Help",
    description:
      "Read pi-telegram usage guidance for delivery actions, Threaded Mode, handlers, formatting, and debugging.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [
          {
            type: "text",
            text: getTelegramHelpText(options.getActiveProfileName?.()),
          },
        ],
        details: {},
      };
    },
  });
}

export function buildTelegramBridgeSystemPrompt(options: {
  prompt: string;
  systemPrompt: string;
  telegramPrefix?: string;
  localSystemPromptSuffix: string;
  telegramTurnSystemPromptSuffix: string;
}): { systemPrompt: string } {
  const telegramPrefix = options.telegramPrefix ?? TELEGRAM_PREFIX;
  const telegramHead = telegramPrefix.endsWith("]")
    ? telegramPrefix.slice(0, -1)
    : telegramPrefix;
  const trimmedPrompt = options.prompt.trimStart();
  const telegramTurn =
    trimmedPrompt.startsWith(`${telegramHead}]`) ||
    trimmedPrompt.startsWith(`${telegramHead}|`);
  const telegramSuffix = telegramTurn
    ? `${options.telegramTurnSystemPromptSuffix}\n- The current user message came from Telegram.`
    : "";
  return {
    systemPrompt:
      options.systemPrompt + options.localSystemPromptSuffix + telegramSuffix,
  };
}

export function createTelegramBeforeAgentStartHook(
  options: {
    telegramPrefix?: string;
    localSystemPromptSuffix?: string;
    telegramTurnSystemPromptSuffix?: string;
  } = {},
): (event: BeforeAgentStartEvent) => { systemPrompt: string } {
  return (event) =>
    buildTelegramBridgeSystemPrompt({
      prompt: event.prompt,
      systemPrompt: event.systemPrompt,
      telegramPrefix: options.telegramPrefix,
      localSystemPromptSuffix:
        options.localSystemPromptSuffix ?? LOCAL_SYSTEM_PROMPT_SUFFIX,
      telegramTurnSystemPromptSuffix:
        options.telegramTurnSystemPromptSuffix ??
        TELEGRAM_TURN_SYSTEM_PROMPT_SUFFIX,
    });
}

export interface TelegramProactivePromptHookDeps<TContext> {
  baseHook?: (event: BeforeAgentStartEvent) => { systemPrompt: string };
  isConfigured: () => boolean;
  isProactivePushEnabled: () => boolean;
  isCurrentOwner: (ctx: TContext) => boolean;
}

export function createTelegramProactiveBeforeAgentStartHook<TContext>(
  deps: TelegramProactivePromptHookDeps<TContext>,
): (
  event: BeforeAgentStartEvent,
  ctx: TContext,
) => Promise<{ systemPrompt: string }> {
  const baseHook = deps.baseHook ?? createTelegramBeforeAgentStartHook();
  return async (event, ctx) => {
    if (!deps.isConfigured()) return { systemPrompt: event.systemPrompt };
    const result = baseHook(event);
    if (!deps.isProactivePushEnabled()) return result;
    if (!deps.isCurrentOwner(ctx)) return result;
    return result;
  };
}
