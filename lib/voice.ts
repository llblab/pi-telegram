/**
 * Voice Domain
 * Zones: telegram, voice
 *
 * This module is the single owner of all Voice-specific coordination logic:
 * - Voice reply policy (mirror / voice / manual) via getTelegramVoiceReplyMode()
 * - Voice turn tagging (voiceReplyPreferred / voiceReplyRequired)
 * - Voice-specific prompt contributions for the LLM
 * - Voice synthesis provider registry (registration + policy/prompt hooks)
 * - Voice markup parsing (planTelegramVoiceReply + helpers)
 * - Voice suppression helpers (isVoiceTurn, shouldSuppressPreviewForVoice)
 *
 * Separation of concerns:
 * - All decision logic and domain rules live here.
 * - Actual delivery (sending the audio via Telegram) stays in outbound.ts.
 *
 * Keeps voice policy, turn tagging, prompt contributions, and markup helpers
 * out of the queue, preview, turn-building, and delivery domains.
 */

const VOICE_SYNTHESIS_PROVIDER_REGISTRY_KEY =
  "__piTelegramVoiceSynthesisProviders__";
const VOICE_TRANSCRIPTION_PROVIDER_REGISTRY_KEY =
  "__piTelegramVoiceTranscriptionProviders__";

let nextGeneratedVoiceSynthesisProviderId = 0;
let nextGeneratedVoiceTranscriptionProviderId = 0;

function getNextAvailableProviderId<T>(
  registry: Map<string, T>,
  prefix: string,
  nextId: () => number,
): string {
  let id: string;
  do {
    id = `${prefix}-${nextId()}`;
  } while (registry.has(id));
  return id;
}

export type TelegramVoiceReplyMode = "hidden" | "mirror" | "always";

export type TelegramVoiceSynthesisProviderResult =
  | string
  | {
      audioPath: string;
      transcriptText?: string;
    }
  | undefined;

export interface TelegramVoiceTurnView {
  voiceReplyPreferred?: boolean;
  voiceReplyRequired?: boolean;
  hasVoiceInput?: boolean;
  userText?: string;
}

export interface TelegramVoiceSynthesisProvider {
  (
    text: string,
    options?: { lang?: string; rate?: string },
  ): Promise<TelegramVoiceSynthesisProviderResult>;
  getVoicePolicy?: () => { replyMode?: TelegramVoiceReplyMode };
  getVoicePromptContribution?: (
    view: TelegramVoiceTurnView,
  ) => string | undefined;
}

export type TelegramVoiceTranscriptionProviderResult =
  string | { text: string; language?: string } | undefined;

export interface TelegramVoiceTranscriptionFile {
  path: string;
  fileName?: string;
  mimeType?: string;
  kind?: string;
}

export interface TelegramVoiceTranscriptionProvider {
  (
    file: TelegramVoiceTranscriptionFile,
    options?: { language?: string },
  ): Promise<TelegramVoiceTranscriptionProviderResult>;
}

// --- Voice Synthesis Provider Registry ---

function getOrCreateVoiceSynthesisProviderRegistry(): Map<
  string,
  TelegramVoiceSynthesisProvider
> {
  const existing = (globalThis as Record<string, unknown>)[
    VOICE_SYNTHESIS_PROVIDER_REGISTRY_KEY
  ];
  if (existing instanceof Map)
    return existing as Map<string, TelegramVoiceSynthesisProvider>;
  const registry = new Map<string, TelegramVoiceSynthesisProvider>();
  (globalThis as Record<string, unknown>)[
    VOICE_SYNTHESIS_PROVIDER_REGISTRY_KEY
  ] = registry;
  return registry;
}

/**
 * Register a high-level Telegram voice synthesis provider.
 *
 * Stable public API callers must pass a stable `options.id` so diagnostics,
 * replacement, and cleanup can identify the provider. Omitted ids remain a
 * compatibility path for pre-matrix callers and receive generated session-local
 * ids.
 */
export function registerTelegramVoiceSynthesisProvider(
  provider:
    | TelegramVoiceSynthesisProvider
    | ((
        text: string,
        options?: { lang?: string; rate?: string },
      ) => Promise<TelegramVoiceSynthesisProviderResult>),
  options?: { id?: string },
): () => void {
  const registry = getOrCreateVoiceSynthesisProviderRegistry();
  const id =
    options?.id ??
    getNextAvailableProviderId(
      registry,
      "voice-synthesis-provider",
      () => nextGeneratedVoiceSynthesisProviderId++,
    );
  const normalized =
    typeof provider === "function"
      ? (Object.assign(
          (text: string, options?: { lang?: string; rate?: string }) =>
            provider(text, options),
          {
            getVoicePolicy: (provider as TelegramVoiceSynthesisProvider)
              .getVoicePolicy,
            getVoicePromptContribution: (
              provider as TelegramVoiceSynthesisProvider
            ).getVoicePromptContribution,
          },
        ) as TelegramVoiceSynthesisProvider)
      : provider;
  registry.set(id, normalized);
  return () => {
    if (registry.get(id) === normalized) registry.delete(id);
  };
}

export function getTelegramVoiceSynthesisProviders(): TelegramVoiceSynthesisProvider[] {
  return Array.from(getOrCreateVoiceSynthesisProviderRegistry().values());
}

export function hasTelegramVoiceSynthesisProvider(): boolean {
  return getOrCreateVoiceSynthesisProviderRegistry().size > 0;
}

export function clearTelegramVoiceSynthesisProviders(): void {
  getOrCreateVoiceSynthesisProviderRegistry().clear();
}

function getOrCreateVoiceTranscriptionProviderRegistry(): Map<
  string,
  TelegramVoiceTranscriptionProvider
> {
  const existing = (globalThis as Record<string, unknown>)[
    VOICE_TRANSCRIPTION_PROVIDER_REGISTRY_KEY
  ];
  if (existing instanceof Map) {
    return existing as Map<string, TelegramVoiceTranscriptionProvider>;
  }
  const registry = new Map<string, TelegramVoiceTranscriptionProvider>();
  (globalThis as Record<string, unknown>)[
    VOICE_TRANSCRIPTION_PROVIDER_REGISTRY_KEY
  ] = registry;
  return registry;
}

/**
 * Register a high-level Telegram voice transcription provider.
 *
 * Stable public API callers must pass a stable `options.id`. Omitted ids remain
 * a compatibility path for pre-matrix callers and receive generated
 * session-local ids.
 */
export function registerTelegramVoiceTranscriptionProvider(
  provider: TelegramVoiceTranscriptionProvider,
  options?: { id?: string },
): () => void {
  const registry = getOrCreateVoiceTranscriptionProviderRegistry();
  const id =
    options?.id ??
    getNextAvailableProviderId(
      registry,
      "voice-transcription-provider",
      () => nextGeneratedVoiceTranscriptionProviderId++,
    );
  registry.set(id, provider);
  return () => {
    if (registry.get(id) === provider) registry.delete(id);
  };
}

export function getTelegramVoiceTranscriptionProviders(): TelegramVoiceTranscriptionProvider[] {
  return Array.from(getOrCreateVoiceTranscriptionProviderRegistry().values());
}

export function hasTelegramVoiceTranscriptionProvider(): boolean {
  return getOrCreateVoiceTranscriptionProviderRegistry().size > 0;
}

export function clearTelegramVoiceTranscriptionProviders(): void {
  getOrCreateVoiceTranscriptionProviderRegistry().clear();
}

// --- Voice Reply Modes ---

export const TELEGRAM_VOICE_REPLY_MODES = [
  "hidden",
  "mirror",
  "always",
] as const;

/**
 * Returns the active voice reply mode for the current session.
 *
 * Pi-telegram owns reply-mode policy through telegram.json. If
 * config.voice.replyMode is missing, invalid, or legacy `manual`, the effective
 * mode is hidden.
 */
export function getTelegramVoiceReplyMode(config?: {
  voice?: { replyMode?: string };
}): TelegramVoiceReplyMode {
  const configMode = config?.voice?.replyMode;
  if (
    configMode &&
    (TELEGRAM_VOICE_REPLY_MODES as readonly string[]).includes(configMode)
  ) {
    return configMode as TelegramVoiceReplyMode;
  }
  return "hidden";
}

/**
 * Returns whether the user wants the voice synthesis provider's transcript attached
 * as a caption on the voice message.
 *
 * Reads from `config.voice.sendTranscript`.
 * Default: false (no transcript text sent at all).
 */
export function getTelegramVoiceSendTranscript(config?: {
  voice?: { sendTranscript?: boolean };
}): boolean {
  return !!config?.voice?.sendTranscript;
}

// --- Voice Turn Helpers ---

/** Small helper to compute the two voice flags from mode + hasVoiceFile */
export function computeVoiceTurnFlags(
  voiceReplyMode: TelegramVoiceReplyMode | undefined,
  hasVoiceFile: boolean,
) {
  return {
    voiceReplyPreferred: hasVoiceFile && voiceReplyMode === "mirror",
    voiceReplyRequired: voiceReplyMode === "always",
  };
}

/** Returns true if the given turn is tagged as a voice turn */
export function isVoiceTurn(
  turn:
    | { voiceReplyPreferred?: boolean; voiceReplyRequired?: boolean }
    | null
    | undefined,
): boolean {
  return !!(turn?.voiceReplyPreferred || turn?.voiceReplyRequired);
}

// --- Voice Prompt Contribution ---

export function computeVoicePromptContribution(
  voiceReplyMode: TelegramVoiceReplyMode | undefined,
  files: Array<{ kind?: string }>,
  rawText: string,
): string | undefined {
  const hasVoiceFile = files.some(
    (f) => f.kind === "voice" || f.kind === "audio",
  );

  const isVoiceTagged =
    voiceReplyMode === "always" ||
    (voiceReplyMode === "mirror" && hasVoiceFile);

  if (!isVoiceTagged) return undefined;

  const view: TelegramVoiceTurnView = {
    ...computeVoiceTurnFlags(voiceReplyMode, hasVoiceFile),
    hasVoiceInput: hasVoiceFile,
    userText: rawText,
  };

  // Let the voice synthesis provider supply additional instructions for the LLM when in voice mode.
  // When multiple providers are registered, the first one (in registration order)
  // that returns a non-empty string wins.
  for (const provider of getTelegramVoiceSynthesisProviders()) {
    if (typeof provider.getVoicePromptContribution === "function") {
      const contribution = provider.getVoicePromptContribution(view);
      if (contribution?.trim()) {
        return contribution.trim();
      }
    }
  }

  return undefined;
}

// --- Preview Suppression ---

/**
 * Returns true if the current turn should not show a text preview
 * (e.g. because it's a voice reply).
 */
export function shouldSuppressPreviewForVoice(
  turn:
    | { voiceReplyPreferred?: boolean; voiceReplyRequired?: boolean }
    | null
    | undefined,
): boolean {
  return !!(turn?.voiceReplyPreferred || turn?.voiceReplyRequired);
}

// --- Outbound Markup Re-Exports ---

export {
  normalizeMarkdownAfterVoiceExtraction,
  planTelegramVoiceReply,
  stripTelegramCommentMarkupForDelivery,
  stripTelegramCommentMarkupForPreview,
  stripTelegramVoiceMarkupForPreview,
} from "./outbound-markup.ts";
