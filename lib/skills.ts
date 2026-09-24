/**
 * Bundled Telegram skill discovery
 * Zones: pi agent, telegram guidance
 * Owns source-checkout skill contribution; installed packages use their manifest
 */

import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "./pi.ts";
import { resolveAgentDir } from "./paths.ts";

const TELEGRAM_SKILLS_MODULE_PATH = fileURLToPath(import.meta.url);

export function getTelegramExtensionPackageRoot(modulePath: string): string {
  let current = dirname(modulePath);
  while (true) {
    if (existsSync(join(current, "package.json"))) {
      const parent = dirname(current);
      if (basename(current) === "dist" && existsSync(join(parent, "package.json"))) {
        return parent;
      }
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return dirname(modulePath);
    current = parent;
  }
}

export interface TelegramRawExtensionCheckoutOptions {
  agentDir?: string;
  cwd?: string;
}

export function isRawTelegramExtensionCheckout(
  modulePath: string,
  options: TelegramRawExtensionCheckoutOptions = {},
): boolean {
  const packageRoot = resolve(getTelegramExtensionPackageRoot(modulePath));
  const agentDir = resolve(options.agentDir ?? resolveAgentDir());
  const cwd = resolve(options.cwd ?? process.cwd());
  return dirname(packageRoot) === join(agentDir, "extensions") ||
    dirname(packageRoot) === join(cwd, ".pi", "extensions");
}

export const TELEGRAM_SKILLS_PATH = join(
  getTelegramExtensionPackageRoot(TELEGRAM_SKILLS_MODULE_PATH),
  "skills",
);

export function registerTelegramSkillDiscovery(
  pi: Pick<ExtensionAPI, "on">,
  modulePath = TELEGRAM_SKILLS_MODULE_PATH,
  options: TelegramRawExtensionCheckoutOptions = {},
): boolean {
  // Pi auto-discovers extension entrypoints but not their manifest Skills.
  // Manifest-loaded packages own Skills and filters through `pi.skills`.
  if (!isRawTelegramExtensionCheckout(modulePath, options)) return false;
  pi.on("resources_discover", () => ({
    skillPaths: [join(getTelegramExtensionPackageRoot(modulePath), "skills")],
  }));
  return true;
}
