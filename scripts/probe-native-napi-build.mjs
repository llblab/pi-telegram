/**
 * Load an explicitly compiled public-N-API smoke fixture and report its identity.
 * Zones: native build qualification, disposable validation
 * No lock, lifetime, filesystem permission or production-host guarantee is inferred.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

const args = process.argv.slice(2);
assert.equal(args.length, 2);
assert.equal(args[0], "--addon");
assert.ok(isAbsolute(args[1]), "Pass an explicitly compiled fixture, not a package lookup");
const binary = realpathSync(args[1]);
const sha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
const native = createRequire(import.meta.url)(binary);
assert.equal(native.fixtureKind, "public-napi-build-probe-v1");
assert.equal(native.compiledNapi, 8);
assert.ok(Number.isInteger(native.hostNapi) && native.hostNapi >= 8);
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
  fixture: native.fixtureKind, compiledNapi: native.compiledNapi, hostNapi: native.hostNapi, binarySha256: sha256 }, null, 2));
