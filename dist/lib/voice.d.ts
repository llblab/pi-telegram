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
export type TelegramVoiceReplyMode = "manual" | "mirror" | "always";
export type TelegramVoiceSynthesisProviderResult = string | undefined;
export interface TelegramVoiceTurnView {
    voiceReplyPreferred?: boolean;
    voiceReplyRequired?: boolean;
    hasVoiceInput?: boolean;
    userText?: string;
}
export interface TelegramVoiceSynthesisProvider {
    (text: string, options?: {
        lang?: string;
        rate?: string;
    }): Promise<TelegramVoiceSynthesisProviderResult>;
    getVoicePolicy?: () => {
        replyMode?: TelegramVoiceReplyMode;
    };
    getVoicePromptContribution?: (view: TelegramVoiceTurnView) => string | undefined;
}
export type TelegramVoiceTranscriptionProviderResult = string | {
    text: string;
    language?: string;
} | undefined;
export interface TelegramVoiceTranscriptionFile {
    path: string;
    fileName?: string;
    mimeType?: string;
    kind?: string;
}
export interface TelegramVoiceTranscriptionProvider {
    (file: TelegramVoiceTranscriptionFile, options?: {
        language?: string;
    }): Promise<TelegramVoiceTranscriptionProviderResult>;
}
/**
 * Register a high-level Telegram voice synthesis provider.
 *
 * Stable public API callers must pass a stable `options.id` so diagnostics,
 * replacement, and cleanup can identify the provider. Omitted ids remain a
 * compatibility path for pre-matrix callers and receive generated session-local
 * ids.
 */
export declare function registerTelegramVoiceSynthesisProvider(provider: TelegramVoiceSynthesisProvider | ((text: string, options?: {
    lang?: string;
    rate?: string;
}) => Promise<TelegramVoiceSynthesisProviderResult>), options?: {
    id?: string;
}): () => void;
export declare function getTelegramVoiceSynthesisProviders(): TelegramVoiceSynthesisProvider[];
export declare function hasTelegramVoiceSynthesisProvider(): boolean;
export declare function clearTelegramVoiceSynthesisProviders(): void;
/**
 * Register a high-level Telegram voice transcription provider.
 *
 * Stable public API callers must pass a stable `options.id`. Omitted ids remain
 * a compatibility path for pre-matrix callers and receive generated
 * session-local ids.
 */
export declare function registerTelegramVoiceTranscriptionProvider(provider: TelegramVoiceTranscriptionProvider, options?: {
    id?: string;
}): () => void;
export declare function getTelegramVoiceTranscriptionProviders(): TelegramVoiceTranscriptionProvider[];
export declare function hasTelegramVoiceTranscriptionProvider(): boolean;
export declare function clearTelegramVoiceTranscriptionProviders(): void;
export declare const TELEGRAM_VOICE_REPLY_MODES: readonly ["manual", "mirror", "always"];
/**
 * Returns the active voice reply mode for the current session.
 *
 * Pi-telegram owns reply-mode policy through telegram.json. If
 * config.voice.replyMode is missing, invalid, or legacy `hidden`, the effective
 * mode is manual.
 */
export declare function getTelegramVoiceReplyMode(config?: {
    voice?: {
        replyMode?: string;
    };
}): TelegramVoiceReplyMode;
/** Small helper to compute the two voice flags from mode + hasVoiceFile */
export declare function computeVoiceTurnFlags(voiceReplyMode: TelegramVoiceReplyMode | undefined, hasVoiceFile: boolean): {
    voiceReplyPreferred: boolean;
    voiceReplyRequired: boolean;
};
/** Returns true if the given turn is tagged as a voice turn */
export declare function isVoiceTurn(turn: {
    voiceReplyPreferred?: boolean;
    voiceReplyRequired?: boolean;
} | null | undefined): boolean;
export declare function computeVoicePromptContribution(voiceReplyMode: TelegramVoiceReplyMode | undefined, files: Array<{
    kind?: string;
}>, rawText: string): string | undefined;
/**
 * Returns true if the current turn should not show a text preview
 * (e.g. because it's a voice reply).
 */
export declare function shouldSuppressPreviewForVoice(turn: {
    voiceReplyPreferred?: boolean;
    voiceReplyRequired?: boolean;
} | null | undefined): boolean;
export { normalizeMarkdownAfterVoiceExtraction, planTelegramVoiceReply, stripTelegramCommentMarkupForDelivery, stripTelegramCommentMarkupForPreview, stripTelegramVoiceMarkupForPreview, } from "./outbound-markup.ts";
