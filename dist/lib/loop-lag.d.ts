/**
 * Event-loop stall diagnostics
 * Zones: shared utils
 * Owns process-wide counters of synchronous blocking that callers report and a drift-based stall monitor that
 * attributes each stall to them; knows nothing about locks, transports or who blocked, and never changes behavior
 */
/** Accumulated synchronous blocking of one kind: total milliseconds, number of occurrences, longest single one. */
export interface TelegramSyncBlockTotals {
    ms: number;
    count: number;
    maxMs: number;
}
/** Reports one synchronous wait or hold that kept the event loop from running. Cheap; safe on any hot path. */
export declare function recordTelegramSyncBlock(label: string, ms: number): void;
export declare function readTelegramSyncBlockTotals(): Record<string, Readonly<TelegramSyncBlockTotals>>;
export interface TelegramEventLoopStall {
    /** How far past its schedule the timer fired. */
    lagMs: number;
    /** Synchronous blocking reported during the stall window, by label; `maxMs` is the longest single occurrence. */
    blocked: Record<string, TelegramSyncBlockTotals>;
    /**
     * Process CPU time (user plus system) spent in the stall window. Near `lagMs` with no `blocked` entries means CPU-bound
     * JavaScript in this process; far below `lagMs` means waiting (reported lock waits, or the OS descheduled the process).
     */
    cpuMs?: number;
}
export interface TelegramEventLoopLagMonitorDeps {
    /** Receives one stall at or above the threshold; a throwing sink never reaches the timer callback. */
    record: (stall: TelegramEventLoopStall) => void;
    thresholdMs?: number;
    intervalMs?: number;
    getNowMs?: () => number;
    /** Cumulative process CPU milliseconds; defaults to `process.cpuUsage()`. Omitted from stalls when it throws. */
    readCpuMs?: () => number;
    /** Test seam: returns a canceller. Default is an unreferenced `setInterval`. */
    schedule?: (tick: () => void, intervalMs: number) => () => void;
}
/** Detects stalls by timer drift: a blocked loop fires the next tick late, by the length of the stall. */
export declare function createTelegramEventLoopLagMonitor(deps: TelegramEventLoopLagMonitorDeps): {
    start: () => void;
    stop: () => void;
};
