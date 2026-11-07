/**
 * Telegram runtime storage housekeeping
 * Zones: filesystem diagnostics, unclean-shutdown recovery
 * Owns best-effort removal of obsolete recovery folders and orphaned session journal families
 */
/**
 * Remove recovery folders written by earlier releases (runtime root and session folders).
 * Current releases delete damaged files instead of quarantining them; nothing reads these copies.
 */
export declare function removeTelegramLegacyRecoveryStorage(runtimeDir: string): string[];
export interface TelegramSessionFolderSweeperDeps {
    getSessionsDir: () => string;
    getProfileName: () => string | undefined;
    /** Sessions holding a Workspace slot binding, live registrations and this process's own session. */
    getKeptSessionIds: () => Iterable<string | undefined>;
    /** Private opt-in whole-sweep hold; unknown history cannot be classified by a missing marker. */
    preserveJournalFamilies?: true;
    getNowMs?: () => number;
    intervalMs?: number;
}
/**
 * Leader housekeeping (operator policy): a session without a Workspace slot loses its
 * current-profile journal family; the folder disappears once no profile uses it.
 */
export declare function createTelegramSessionFolderSweeper(deps: TelegramSessionFolderSweeperDeps): {
    sweep: () => string[];
};
