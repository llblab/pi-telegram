/**
 * Telegram per-chat time injection runtime
 * Zones: telegram inbound, prompt content
 * Owns the formatted `[time]` line and the per-chat interval bookkeeping that decides when to emit it
 */
export function formatTelegramTimeInjectionLine(now, timezone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).formatToParts(now);
    const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
    const year = get("year");
    const month = get("month");
    const day = get("day");
    const hourRaw = get("hour");
    const hour = hourRaw === "24" ? "00" : hourRaw;
    const minute = get("minute");
    const second = get("second");
    return `${year}-${month}-${day} ${hour}:${minute}:${second} ${timezone}`;
}
export function createTimeInjectionRuntime(deps) {
    const lastInjectedAt = new Map();
    return {
        resolveLine: (chatId, now = new Date()) => {
            const config = deps.getConfig();
            if (config.injectionMode === "hidden")
                return null;
            let line;
            try {
                line = formatTelegramTimeInjectionLine(now, config.timezone);
            }
            catch (error) {
                deps.recordRuntimeEvent?.("time-injection", error, {
                    timezone: config.timezone,
                });
                return null;
            }
            if (config.injectionMode === "always")
                return line;
            const previous = lastInjectedAt.get(chatId);
            const nowMs = now.getTime();
            if (previous !== undefined &&
                nowMs - previous < config.interval) {
                return null;
            }
            lastInjectedAt.set(chatId, nowMs);
            return line;
        },
    };
}
