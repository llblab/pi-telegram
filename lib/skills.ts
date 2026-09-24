/**
 * Bundled Telegram skill discovery
 * Zones: pi agent, telegram guidance
 * Owns source-checkout skill contribution; installed packages use their manifest
 */

import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "./pi.ts";

const TELEGRAM_SKILLS_MODULE_PATH = fileURLToPath(import.meta.url);

export const TELEGRAM_SKILLS_PATH = fileURLToPath(
  new URL("../skills", import.meta.url),
);

export function registerTelegramSkillDiscovery(
  pi: Pick<ExtensionAPI, "on">,
  modulePath = TELEGRAM_SKILLS_MODULE_PATH,
): boolean {
  // A raw source extension has no package manifest owner. Compiled npm/git
  // packages do, so contributing again would bypass their resource filters.
  if (extname(modulePath) !== ".ts") return false;
  pi.on("resources_discover", () => ({
    skillPaths: [TELEGRAM_SKILLS_PATH],
  }));
  return true;
}
