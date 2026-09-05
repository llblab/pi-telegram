/**
 * Telegram prompt injection helpers
 * Zones: pi agent prompts, telegram guidance
 * Owns Telegram-specific system prompt suffixes injected into pi agent turns
 */

import type { BeforeAgentStartEvent } from "./pi.ts";
import { TELEGRAM_PREFIX } from "./turns.ts";

export const TELEGRAM_CONNECTED_CONTEXT_MESSAGE =
  "Telegram session connected. Use Telegram features for Telegram-originated turns or explicit Telegram requests; connectivity alone is not user intent.";
export const TELEGRAM_DISCONNECTED_CONTEXT_MESSAGE =
  "Telegram session disconnected. Do not use Telegram delivery, actions, or Telegram-specific reply features unless the user reconnects it.";

const LOCAL_SYSTEM_PROMPT_SUFFIX = `

${TELEGRAM_CONNECTED_CONTEXT_MESSAGE} For Telegram work, consult bundled Skills in routing order: \`telegram-bridge\` for the transport and turn protocol, \`generated-control-surface\` when contextual controls materially shorten feedback, then \`generative-apps\` when the interaction warrants a reusable deterministic app. Load a Skill only if its instructions are not already present in the current context. Do not use Telegram-specific features from unrelated local/TUI prompts.`;

const TELEGRAM_TURN_SYSTEM_PROMPT_SUFFIX = `

Telegram turn note: Follow the applicable bundled Telegram Skills in routing order; load only missing instructions.`;

export const TELEGRAM_ATTACH_PROMPT_SNIPPET =
  "Queue files for the active Telegram reply; outside Telegram turns, send files directly to Telegram.";
export const TELEGRAM_ATTACH_PROMPT_GUIDELINES = [
  "When handling a [telegram] message and the user asked for a file or generated artifact, call telegram_attach with the local path instead of only mentioning the path in text.",
  "When a local/TUI user explicitly asks to send a generated file to Telegram, telegram_attach can deliver it to the paired/default Telegram chat even without an active Telegram turn.",
  "For an explicit thread target, provide chat_id plus thread_id; registered multi-instance followers default to their assigned thread target.",
] as const;
export const TELEGRAM_MESSAGE_PROMPT_SNIPPET =
  "Send direct Telegram Markdown text when the user explicitly asks for Telegram delivery outside the normal reply flow.";
export const TELEGRAM_MESSAGE_PROMPT_GUIDELINES = [
  "Use telegram_message only when the user explicitly asks to send a message to Telegram from the local/TUI side, or names a concrete Telegram delivery target.",
  "For a live Pi thread target, provide thread as its case-insensitive name or numeric id; the bridge sends visibly and admits one attributed turn to that live instance. Unknown, ambiguous, same, or offline targets fail before sending.",
  "Add buttons by embedding the same top-level telegram_button HTML comments used in normal Telegram replies; Telegram does not support standalone buttons.",
  "During an active Telegram turn, omit telegram_message for the current target and answer normally; use thread only when the user requests delivery to a different live Pi thread.",
] as const;

const TELEGRAM_TOOL_METADATA_LINES = Object.fromEntries(
  [
    `- telegram_attach: ${TELEGRAM_ATTACH_PROMPT_SNIPPET}`,
    `- telegram_message: ${TELEGRAM_MESSAGE_PROMPT_SNIPPET}`,
    ...TELEGRAM_ATTACH_PROMPT_GUIDELINES.map((line) => `- ${line}`),
    ...TELEGRAM_MESSAGE_PROMPT_GUIDELINES.map((line) => `- ${line}`),
  ].map((line) => [line, true]),
) as Record<string, true>;

const TELEGRAM_MODEL_CONTEXT_TOOL_NAMES = new Set([
  "telegram_attach",
  "telegram_bind",
  "telegram_message",
]);
const TELEGRAM_MODEL_CONTEXT_MEMORY_KEY = Symbol.for(
  "@llblab/pi-telegram:model-context-suspended-tools",
);

export interface TelegramModelContextAvailabilityMemory {
  suspended: boolean;
  toolNames: Set<string>;
}

function getTelegramModelContextAvailabilityMemory(): TelegramModelContextAvailabilityMemory {
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const existing = globals[TELEGRAM_MODEL_CONTEXT_MEMORY_KEY];
  if (
    existing &&
    typeof existing === "object" &&
    "toolNames" in existing &&
    (existing as { toolNames?: unknown }).toolNames instanceof Set
  ) {
    return existing as TelegramModelContextAvailabilityMemory;
  }
  const memory: TelegramModelContextAvailabilityMemory = {
    suspended: false,
    toolNames: new Set<string>(),
  };
  globals[TELEGRAM_MODEL_CONTEXT_MEMORY_KEY] = memory;
  return memory;
}

export interface TelegramModelContextAvailabilityRuntime {
  reconcile: () => void;
}

export interface TelegramModelContextAvailabilityBinding
  extends TelegramModelContextAvailabilityRuntime {
  bind: (runtime: TelegramModelContextAvailabilityRuntime) => void;
}

export function createTelegramModelContextAvailabilityBinding(): TelegramModelContextAvailabilityBinding {
  let runtime: TelegramModelContextAvailabilityRuntime | undefined;
  return {
    bind(next) {
      runtime = next;
    },
    reconcile() {
      runtime?.reconcile();
    },
  };
}

export function createTelegramModelContextAvailabilityRuntime(deps: {
  getActiveTools: () => string[];
  setActiveTools: (names: string[]) => void;
  isAvailable: () => boolean;
  canReconcile?: () => boolean;
  memory?: TelegramModelContextAvailabilityMemory;
}): TelegramModelContextAvailabilityRuntime {
  const memory =
    deps.memory ?? getTelegramModelContextAvailabilityMemory();
  return {
    reconcile() {
      if (deps.canReconcile && !deps.canReconcile()) return;
      const activeTools = deps.getActiveTools();
      if (!deps.isAvailable()) {
        if (!memory.suspended) {
          memory.toolNames.clear();
          for (const name of activeTools) {
            if (TELEGRAM_MODEL_CONTEXT_TOOL_NAMES.has(name)) {
              memory.toolNames.add(name);
            }
          }
          memory.suspended = true;
        }
        const nextTools = activeTools.filter(
          (name) => !TELEGRAM_MODEL_CONTEXT_TOOL_NAMES.has(name),
        );
        if (nextTools.length !== activeTools.length) {
          deps.setActiveTools(nextTools);
        }
        return;
      }
      if (!memory.suspended) return;
      const nextTools = [...activeTools];
      for (const name of TELEGRAM_MODEL_CONTEXT_TOOL_NAMES) {
        if (memory.toolNames.has(name) && !nextTools.includes(name)) {
          nextTools.push(name);
        }
      }
      memory.toolNames.clear();
      memory.suspended = false;
      if (nextTools.length !== activeTools.length) {
        deps.setActiveTools(nextTools);
      }
    },
  };
}

export type TelegramSystemPrompt = string | string[];

type TelegramBeforeAgentStartEvent = Omit<
  BeforeAgentStartEvent,
  "systemPrompt"
> & {
  systemPrompt: TelegramSystemPrompt;
};

type TelegramBeforeAgentStartResult = {
  systemPrompt: TelegramSystemPrompt;
};

type TelegramBeforeAgentStartHook = (
  event: TelegramBeforeAgentStartEvent,
) => TelegramBeforeAgentStartResult;

export function buildTelegramBridgeSystemPrompt(options: {
  prompt: string;
  systemPrompt: TelegramSystemPrompt;
  telegramPrefix?: string;
  localSystemPromptSuffix: string;
  telegramTurnSystemPromptSuffix: string;
}): TelegramBeforeAgentStartResult {
  const basePrompt = options.systemPrompt ?? "";
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
    systemPrompt: Array.isArray(basePrompt)
      ? [
          ...basePrompt,
          options.localSystemPromptSuffix + telegramSuffix,
        ]
      : basePrompt +
        options.localSystemPromptSuffix +
        telegramSuffix,
  };
}

export function createTelegramBeforeAgentStartHook(
  options: {
    telegramPrefix?: string;
    localSystemPromptSuffix?: string;
    telegramTurnSystemPromptSuffix?: string;
  } = {},
): TelegramBeforeAgentStartHook {
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

function stripTelegramToolMetadataFromString(systemPrompt: string): string {
  return systemPrompt
    .split("\n")
    .filter((line) => TELEGRAM_TOOL_METADATA_LINES[line] !== true)
    .join("\n");
}

function stripTelegramToolMetadataFromSystemPrompt(
  systemPrompt: TelegramSystemPrompt | undefined,
): TelegramSystemPrompt {
  if (!systemPrompt) return "";
  return Array.isArray(systemPrompt)
    ? systemPrompt.map(stripTelegramToolMetadataFromString)
    : stripTelegramToolMetadataFromString(systemPrompt);
}

export interface TelegramProactivePromptHookDeps<TContext> {
  baseHook?: TelegramBeforeAgentStartHook;
  reconcileAvailability?: () => void;
  isAvailable: (ctx: TContext) => boolean;
}

export function createTelegramProactiveBeforeAgentStartHook<TContext>(
  deps: TelegramProactivePromptHookDeps<TContext>,
): (
  event: TelegramBeforeAgentStartEvent,
  ctx: TContext,
) => Promise<TelegramBeforeAgentStartResult> {
  const baseHook = deps.baseHook ?? createTelegramBeforeAgentStartHook();
  return async (event, ctx) => {
    deps.reconcileAvailability?.();
    if (!deps.isAvailable(ctx)) {
      return {
        systemPrompt: stripTelegramToolMetadataFromSystemPrompt(
          event.systemPrompt,
        ),
      };
    }
    return baseHook(event);
  };
}
