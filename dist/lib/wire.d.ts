/**
 * Non-coercing decoded wire-value inspection
 * Zones: wire fields, record shape, integer bounds
 * Owns shared shallow predicates and the artifact-document field bounds shared by declaration, IPC and API issuance;
 * excludes schemas, lossless decoding, required fields, normalization, storage and execution authority.
 */
/** Non-array object shape only; not a plain-object or JSON-serializability guarantee. */
export declare function isWireRecord(value: unknown): value is Record<string, unknown>;
/** Checks only own enumerable string keys, not required, inherited or symbol fields. */
export declare function hasOnlyWireKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean;
export declare function isNonEmptyWireString(value: unknown): value is string;
export declare function isNonNegativeWireInteger(value: unknown): value is number;
/** Bound for one producer-authorized artifact document, shared by declaration, IPC wire validation and Bot API issuance. */
export declare const TELEGRAM_ARTIFACT_MAX_BYTES = 1048576;
export declare const TELEGRAM_ARTIFACT_CAPTION_MAX_LENGTH = 1024;
/** Explicit basename only: no separators or control characters, and not a relative-directory name. */
export declare function isTelegramArtifactFileName(name: unknown): name is string;
export declare function isTelegramArtifactCaption(caption: unknown): caption is string;
