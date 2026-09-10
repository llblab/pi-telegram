/**
 * Workspace slot allocation policy
 * Zones: telegram, workspace identity
 * Owns bounded profile-wide letter selection and inactivity ordering.
 * Excludes liveness discovery, persistence, routing, and Telegram deletion;
 * a selection is a proposal, never authority to retire a binding.
 */

export const TELEGRAM_WORKSPACE_SLOTS = "abcdefghijklmnopqrstuvwxyz";

export interface TelegramWorkspaceSlotOccupancy {
  bindingKey: string;
  slot: string;
  inactiveSinceMs?: number;
  protection: "eligible" | "protected" | "unknown";
}

export type TelegramWorkspaceSlotAllocation =
  | { kind: "free"; slot: string }
  | { kind: "reclaim"; candidate: TelegramWorkspaceSlotOccupancy }
  | { kind: "blocked"; reason: "invalid-state" | "protected-capacity" };

function isSlot(slot: string): boolean {
  return /^[a-z]$/u.test(slot);
}

function isValidSnapshot(
  bindings: readonly TelegramWorkspaceSlotOccupancy[],
  reservedSlots: readonly string[],
  nowMs: number,
): boolean {
  if (!Number.isFinite(nowMs) || nowMs < 0) return false;
  const slots = new Set<string>();
  const keys = new Set<string>();
  for (const binding of bindings) {
    if (!isSlot(binding.slot) || !binding.bindingKey ||
        slots.has(binding.slot) || keys.has(binding.bindingKey)) return false;
    slots.add(binding.slot);
    keys.add(binding.bindingKey);
  }
  return reservedSlots.every(isSlot);
}

function eligibleByInactivity(
  bindings: readonly TelegramWorkspaceSlotOccupancy[],
  reservedSlots: readonly string[],
  nowMs: number,
): TelegramWorkspaceSlotOccupancy[] {
  const reserved = new Set(reservedSlots);
  return bindings.filter((binding) =>
    binding.protection === "eligible" &&
    !reserved.has(binding.slot) &&
    typeof binding.inactiveSinceMs === "number" &&
    Number.isFinite(binding.inactiveSinceMs) &&
    binding.inactiveSinceMs >= 0 &&
    binding.inactiveSinceMs <= nowMs,
  ).sort((left, right) =>
    left.inactiveSinceMs! - right.inactiveSinceMs! ||
    left.slot.charCodeAt(0) - right.slot.charCodeAt(0),
  );
}

/** Caller must recheck exact ownership and protected work before retirement. */
export function planTelegramWorkspaceSlotAllocation(input: {
  bindings: readonly TelegramWorkspaceSlotOccupancy[];
  reservedSlots: readonly string[];
  nowMs: number;
}): TelegramWorkspaceSlotAllocation {
  const { bindings, reservedSlots, nowMs } = input;
  if (!isValidSnapshot(bindings, reservedSlots, nowMs)) {
    return { kind: "blocked", reason: "invalid-state" };
  }
  const occupied = new Set([
    ...bindings.map((binding) => binding.slot),
    ...reservedSlots,
  ]);
  for (const slot of TELEGRAM_WORKSPACE_SLOTS) {
    if (!occupied.has(slot)) return { kind: "free", slot };
  }
  const candidate = eligibleByInactivity(bindings, reservedSlots, nowMs)[0];
  return candidate
    ? { kind: "reclaim", candidate: { ...candidate } }
    : { kind: "blocked", reason: "protected-capacity" };
}
