/**
 * Voice Domain
 * Zones: telegram, voice
 *
 * This module is the single owner of all Voice-specific coordination logic:
 * - Voice reply policy (mirror / voice / manual) via getTelegramVoiceReplyMode()
 * - Voice turn tagging (voiceReplyPreferred / voiceReplyRequired)
 * - Voice-specific prompt contributions for the LLM
 * - Voice provider registry (registration + policy/prompt hooks)
 * - Voice markup parsing (planTelegramVoiceReply + helpers)
 * - Voice suppression helpers (isVoiceTurn, shouldSuppressPreviewForVoice)
 *
 * Separation of concerns:
 * - All decision logic and domain rules live here.
 * - Actual delivery (sending the audio via Telegram) stays in outbound-handlers.ts.
 *
 * This module was introduced in Commit 2 to stop the previous scattering of
 * Voice logic across turns.ts, queue.ts, preview.ts and outbound-handlers.ts.
 */

import type { TelegramConfig } from "./config.ts";
import type { DownloadedTelegramTurnFile } from "./turns.ts";

import {
  getTelegramVoiceProviders,
  type TelegramVoiceReplyMode,
  type TelegramVoiceTurnView,
  type TelegramVoiceProvider,
  type TelegramVoiceProviderResult,
} from "./outbound-handlers.ts";

// ======================================================
// === Voice Reply Modes
// ======================================================

export const TELEGRAM_VOICE_REPLY_MODES = ["mirror", "voice", "manual"] as const;

/**
 * Returns the active voice reply mode for the current session.
 *
 * Priority:
 *   1. Explicit setting from telegram.json (config.voice.replyMode)
 *   2. Current voice provider's policy via getVoicePolicy() (preferred)
 *   3. Fallback to "manual"
 *
 * When multiple providers are registered, the first one (in registration order)
 * that returns a valid replyMode wins.
 */
export function getTelegramVoiceReplyMode(
  config?: TelegramConfig,
): TelegramVoiceReplyMode {
  // 1. Config file wins if valid
  const configMode = config?.voice?.replyMode;
  if (configMode && (TELEGRAM_VOICE_REPLY_MODES as readonly string[]).includes(configMode)) {
    return configMode as TelegramVoiceReplyMode;
  }

  // 2. Ask registered voice providers (new preferred path)
  for (const provider of getTelegramVoiceProviders()) {
    if (typeof provider.getVoicePolicy === "function") {
      const policy = provider.getVoicePolicy();
      const mode = policy?.replyMode;
      if (mode && (TELEGRAM_VOICE_REPLY_MODES as readonly string[]).includes(mode)) {
        return mode;
      }
    }
  }

  // 3. Safe default
  return "manual";
}

/**
 * Returns whether the user wants the voice provider's transcript attached
 * as a caption on the voice message.
 *
 * Reads from `config.voice.sendTranscript`.
 * Default: false (no transcript text sent at all).
 */
export function getTelegramVoiceSendTranscript(config?: TelegramConfig): boolean {
  return !!config?.voice?.sendTranscript;
}

// ======================================================
// === Voice Turn Helpers
// ======================================================

/** Small helper to compute the two voice flags from mode + hasVoiceFile */
export function computeVoiceTurnFlags(
  voiceReplyMode: TelegramVoiceReplyMode | undefined,
  hasVoiceFile: boolean,
) {
  return {
    voiceReplyPreferred: hasVoiceFile && voiceReplyMode === "mirror",
    voiceReplyRequired: voiceReplyMode === "voice",
  };
}

/** Returns true if the given turn is tagged as a voice turn */
export function isVoiceTurn(
  turn: { voiceReplyPreferred?: boolean; voiceReplyRequired?: boolean } | null | undefined,
): boolean {
  return !!(turn?.voiceReplyPreferred || turn?.voiceReplyRequired);
}

// ======================================================
// === Voice Prompt Contribution
// ======================================================

export function computeVoicePromptContribution(
  voiceReplyMode: TelegramVoiceReplyMode | undefined,
  files: DownloadedTelegramTurnFile[],
  rawText: string,
): string | undefined {
  const hasVoiceFile = files.some((f) => f.kind === "voice" || f.kind === "audio");

  const isVoiceTagged =
    voiceReplyMode === "voice" || (voiceReplyMode === "mirror" && hasVoiceFile);

  if (!isVoiceTagged) return undefined;

  const view: TelegramVoiceTurnView = {
    ...computeVoiceTurnFlags(voiceReplyMode, hasVoiceFile),
    hasVoiceInput: hasVoiceFile,
    userText: rawText,
  };

  // Let the voice provider supply additional instructions for the LLM when in voice mode.
  // When multiple providers are registered, the first one (in registration order)
  // that returns a non-empty string wins.
  for (const provider of getTelegramVoiceProviders()) {
    if (typeof provider.getVoicePromptContribution === "function") {
      const contribution = provider.getVoicePromptContribution(view);
      if (contribution?.trim()) {
        return contribution.trim();
      }
    }
  }

  return undefined;
}

// ======================================================
// === Preview Suppression
// ======================================================

/**
 * Returns true if the current turn should not show a text preview
 * (e.g. because it's a voice reply).
 */
export function shouldSuppressPreviewForVoice(
  turn: { voiceReplyPreferred?: boolean; voiceReplyRequired?: boolean } | null | undefined,
): boolean {
  return !!(turn?.voiceReplyPreferred || turn?.voiceReplyRequired);
}






// Complete Voice surface re-export from outbound-handlers.ts
// Re-export only what actually lives in outbound-handlers.ts.
//
// NOTE: This creates a deliberate import cycle (voice.ts ↔ outbound-handlers.ts).
// It is accepted to keep the thin voice domain (policy + tagging) in one module
// while the Telegram HTML comment parser + provider registry + delivery live in
// outbound-handlers. See tests/invariants.test.ts for the explicit exception.
export {
  registerTelegramVoiceProvider,
  getTelegramVoiceProviders,
  hasTelegramVoiceProvider,
  clearTelegramVoiceProviders,
  planTelegramVoiceReply,
  stripTelegramCommentMarkupForPreview,
  stripTelegramCommentMarkupForDelivery,
  stripTelegramVoiceMarkupForPreview,
  normalizeMarkdownAfterVoiceExtraction,
  type TelegramVoiceReplyMode,
  type TelegramVoiceTurnView,
  type TelegramVoiceProvider,
  type TelegramVoiceProviderResult,
} from "./outbound-handlers.ts";
