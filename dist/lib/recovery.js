/**
 * Telegram runtime storage housekeeping
 * Zones: filesystem diagnostics, unclean-shutdown recovery
 * Owns best-effort removal of obsolete recovery folders and orphaned session journal families
 */
import { lstatSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { decodeTelegramSessionDirectoryName, getTelegramProfilePathSuffix, } from "./paths.js";
/**
 * Remove recovery folders written by earlier releases (runtime root and session folders).
 * Current releases delete damaged files instead of quarantining them; nothing reads these copies.
 */
export function removeTelegramLegacyRecoveryStorage(runtimeDir) {
    const removed = [];
    const remove = (path) => {
        try {
            if (!lstatSync(path).isDirectory())
                return;
            rmSync(path, {
                recursive: true,
                force: true,
                maxRetries: 3,
                retryDelay: 50,
            });
            removed.push(path);
        }
        catch {
            // Best-effort housekeeping; a later startup retries.
        }
    };
    remove(join(runtimeDir, "recovery"));
    let sessions = [];
    try {
        sessions = readdirSync(join(runtimeDir, "sessions"));
    }
    catch {
        /* no sessions yet */
    }
    for (const session of sessions)
        remove(join(runtimeDir, "sessions", session, "recovery"));
    return removed;
}
const TELEGRAM_SESSION_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
/**
 * Leader housekeeping (operator policy): a session without a Workspace slot loses its
 * current-profile journal family; the folder disappears once no profile uses it.
 */
export function createTelegramSessionFolderSweeper(deps) {
    const preserveJournalFamilies = deps.preserveJournalFamilies;
    if (preserveJournalFamilies !== undefined && preserveJournalFamilies !== true)
        throw new Error("Telegram session journal preservation must be true or omitted.");
    const getNowMs = deps.getNowMs ?? Date.now;
    const intervalMs = deps.intervalMs ?? TELEGRAM_SESSION_SWEEP_INTERVAL_MS;
    let lastSweepAtMs;
    return {
        sweep() {
            if (preserveJournalFamilies)
                return [];
            const now = getNowMs();
            if (lastSweepAtMs !== undefined && now - lastSweepAtMs < intervalMs)
                return [];
            lastSweepAtMs = now;
            const sessionsDir = deps.getSessionsDir();
            const kept = new Set(deps.getKeptSessionIds());
            const suffix = getTelegramProfilePathSuffix(deps.getProfileName()).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
            const family = new RegExp(`^journal\\.[a-f0-9]{16}${suffix}\\.json(?:\\.segments|\\.retained)?$`, "u");
            const removed = [];
            let names;
            try {
                names = readdirSync(sessionsDir);
            }
            catch {
                return removed;
            }
            for (const name of names) {
                const sessionId = decodeTelegramSessionDirectoryName(name);
                if (sessionId === undefined || kept.has(sessionId))
                    continue;
                const folder = join(sessionsDir, name);
                try {
                    if (!lstatSync(folder).isDirectory())
                        continue;
                    for (const entry of readdirSync(folder)) {
                        if (!family.test(entry))
                            continue;
                        const path = join(folder, entry);
                        rmSync(path, {
                            recursive: true,
                            force: true,
                            maxRetries: 3,
                            retryDelay: 50,
                        });
                        removed.push(path);
                    }
                    if (readdirSync(folder).length === 0) {
                        rmdirSync(folder);
                        removed.push(folder);
                    }
                }
                catch {
                    // Best-effort housekeeping; the next sweep retries.
                }
            }
            return removed;
        },
    };
}
