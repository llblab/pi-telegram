/**
 * Bundled Telegram skill discovery
 * Zones: pi agent, telegram guidance
 * Owns source-checkout skill contribution; installed packages use their manifest
 */
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentDir } from "./paths.js";
const TELEGRAM_SKILLS_MODULE_PATH = fileURLToPath(import.meta.url);
export function getTelegramExtensionPackageRoot(modulePath) {
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
        if (parent === current)
            return dirname(modulePath);
        current = parent;
    }
}
export function isRawTelegramExtensionCheckout(modulePath, options = {}) {
    const packageRoot = resolve(getTelegramExtensionPackageRoot(modulePath));
    const agentDir = resolve(options.agentDir ?? resolveAgentDir());
    const cwd = resolve(options.cwd ?? process.cwd());
    return dirname(packageRoot) === join(agentDir, "extensions") ||
        dirname(packageRoot) === join(cwd, ".pi", "extensions");
}
export const TELEGRAM_SKILLS_PATH = join(getTelegramExtensionPackageRoot(TELEGRAM_SKILLS_MODULE_PATH), "skills");
export function registerTelegramSkillDiscovery(pi, modulePath = TELEGRAM_SKILLS_MODULE_PATH, options = {}) {
    // Pi auto-discovers extension entrypoints but not their manifest Skills.
    // Manifest-loaded packages own Skills and filters through `pi.skills`.
    if (!isRawTelegramExtensionCheckout(modulePath, options))
        return false;
    pi.on("resources_discover", () => ({
        skillPaths: [join(getTelegramExtensionPackageRoot(modulePath), "skills")],
    }));
    return true;
}
