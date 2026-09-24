/**
 * Public Telegram voice API
 * Zones: package boundary, extension interop
 * Exposes the stable STT/TTS provider surface and voice policy helpers
 */
export { TELEGRAM_VOICE_REPLY_MODES, computeVoicePromptContribution, computeVoiceTurnFlags, getTelegramVoiceReplyMode, isVoiceTurn, registerTelegramVoiceSynthesisProvider, registerTelegramVoiceTranscriptionProvider, shouldSuppressPreviewForVoice, } from "../lib/voice.js";
