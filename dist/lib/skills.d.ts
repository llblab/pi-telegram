/**
 * Bundled Telegram skill discovery
 * Zones: pi agent, telegram guidance
 * Owns source-checkout skill contribution; installed packages use their manifest
 */
import type { ExtensionAPI } from "./pi.ts";
export declare function getTelegramExtensionPackageRoot(modulePath: string): string;
export interface TelegramRawExtensionCheckoutOptions {
    agentDir?: string;
    cwd?: string;
}
export declare function isRawTelegramExtensionCheckout(modulePath: string, options?: TelegramRawExtensionCheckoutOptions): boolean;
export declare const TELEGRAM_SKILLS_PATH: string;
export declare function registerTelegramSkillDiscovery(pi: Pick<ExtensionAPI, "on">, modulePath?: string, options?: TelegramRawExtensionCheckoutOptions): boolean;
