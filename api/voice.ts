/**
 * Public Telegram voice API
 * Zones: package boundary, extension interop
 * Exposes the stable STT/TTS provider surface and voice policy helpers
 */

export {
  TELEGRAM_VOICE_REPLY_MODES,
  computeVoicePromptContribution,
  computeVoiceTurnFlags,
  getTelegramVoiceReplyMode,
  getTelegramVoiceSendTranscript,
  isVoiceTurn,
  registerTelegramVoiceSynthesisProvider,
  registerTelegramVoiceTranscriptionProvider,
  applyVoiceCompanionTextPolicy,
  shouldSuppressCompanionTextForVoiceTurn,
  shouldSuppressPreviewForVoice,
  type TelegramVoiceProviderPolicy,
  type TelegramVoiceReplyMode,
  type TelegramVoiceSynthesisProvider,
  type TelegramVoiceSynthesisProviderResult,
  type TelegramVoiceTranscriptionFile,
  type TelegramVoiceTranscriptionProvider,
  type TelegramVoiceTranscriptionProviderResult,
  type TelegramVoiceTurnView,
} from "../lib/voice.ts";
