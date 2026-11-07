/**
 * Non-coercing decoded wire-value inspection
 * Zones: wire fields, record shape, integer bounds
 * Owns shared shallow predicates and the artifact-document field bounds shared by declaration, IPC and API issuance;
 * excludes schemas, lossless decoding, required fields, normalization, storage and execution authority.
 */

/** Non-array object shape only; not a plain-object or JSON-serializability guarantee. */
export function isWireRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Checks only own enumerable string keys, not required, inherited or symbol fields. */
export function hasOnlyWireKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function isNonEmptyWireString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isNonNegativeWireInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Bound for one producer-authorized artifact document, shared by declaration, IPC wire validation and Bot API issuance. */
export const TELEGRAM_ARTIFACT_MAX_BYTES = 1_048_576;
export const TELEGRAM_ARTIFACT_CAPTION_MAX_LENGTH = 1024;

/** Explicit basename only: no separators or control characters, and not a relative-directory name. */
export function isTelegramArtifactFileName(name: unknown): name is string {
  return typeof name === "string" && !!name.trim() && name.isWellFormed() && name !== "." && name !== ".." &&
    Buffer.byteLength(name, "utf8") <= 255 && !/[\\/\x00-\x1f\x7f-\x9f]/u.test(name);
}

export function isTelegramArtifactCaption(caption: unknown): caption is string {
  return typeof caption === "string" && caption.isWellFormed() && caption.length <= TELEGRAM_ARTIFACT_CAPTION_MAX_LENGTH;
}
