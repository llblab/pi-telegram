/**
 * Assemble one host-matched private kernel image; checkout tooling, never runtime installation.
 * Zones: native build artifacts, package identity
 * Usage: node scripts/package-native-lock.mjs --binary <compiled.node> --out <new-directory>
 * Admit ELF/GLIBC or bounded x64 Mach-O deployment metadata before loading/writing output.
 * No download, compiler, Pi import, backend activation or configured storage lookup.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function validateLinuxNativeVersionNeeds(dynamic, versions) {
  const libraries = [...dynamic.matchAll(/Shared library: \[([^\]]+)\]/gu)].map(match => match[1]);
  assert.deepEqual(libraries, ["libc.so.6"], "Linux kernel image must depend only on libc");
  const names = [...versions.matchAll(/Name:\s+(GLIBC_[A-Za-z0-9_.]+)/gu)].map(match => match[1]);
  assert.ok(names.length > 0, "Linux kernel image must expose inspectable GLIBC version needs");
  const required = names.map(name => {
    const match = /^GLIBC_(\d+)\.(\d+)(?:\.(\d+))?$/u.exec(name);
    assert.ok(match, `Unknown native GLIBC requirement: ${name}`);
    return match.slice(1).map(value => Number(value ?? 0));
  });
  for (const [major, minor, patch] of required)
    assert.ok(major < 2 || major === 2 && (minor < 28 || minor === 28 && patch === 0),
      "Linux native image exceeds the Node 22 GLIBC 2.28 baseline");
  required.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
  const highest = required[0];
  return { family: "glibc", baseline: "2.28", highestRequired: highest[2] ? highest.join(".") : highest.slice(0, 2).join("."), libraries };
}

export function validateDarwinNativeImage(bytes) {
  assert.ok(bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf, "Expected a thin little-endian 64-bit Mach-O image");
  assert.equal(bytes.readUInt32LE(4), 0x01000007, "Darwin kernel image must target x86_64");
  const subtype = bytes.readUInt32LE(8);
  assert.ok(subtype === 3 || subtype === 0x80000003, "Unqualified Darwin CPU subtype");
  assert.equal(bytes.readUInt32LE(12), 8, "Darwin kernel image must be a loadable bundle");
  const count = bytes.readUInt32LE(16), commandBytes = bytes.readUInt32LE(20), end = 32 + commandBytes;
  assert.ok(count > 0 && count <= 128 && commandBytes <= 65536 && end <= bytes.length, "Unbounded or truncated Mach-O commands");
  let offset = 32, deployment;
  const version = value => `${value >>> 16}.${value >>> 8 & 255}.${value & 255}`;
  for (let index = 0; index < count; index++) {
    assert.ok(offset + 8 <= end, "Missing Mach-O command header");
    const kind = bytes.readUInt32LE(offset), size = bytes.readUInt32LE(offset + 4);
    assert.ok(size >= 8 && size % 4 === 0 && offset + size <= end, "Invalid Mach-O command extent");
    if (kind === 0x32 || kind === 0x24) {
      assert.equal(deployment, undefined, "Conflicting Mach-O deployment commands");
      let minimum, sdk;
      if (kind === 0x32) {
        assert.ok(size >= 24, "Truncated Mach-O build version");
        assert.equal(bytes.readUInt32LE(offset + 8), 1, "Darwin kernel image must target macOS");
        assert.equal(size, 24 + bytes.readUInt32LE(offset + 20) * 8, "Invalid Mach-O build tools extent");
        minimum = bytes.readUInt32LE(offset + 12); sdk = bytes.readUInt32LE(offset + 16);
      } else {
        assert.equal(size, 16, "Invalid Mach-O minimum-version extent");
        minimum = bytes.readUInt32LE(offset + 8); sdk = bytes.readUInt32LE(offset + 12);
      }
      assert.ok(minimum > 0 && sdk > 0, "Missing Darwin deployment version evidence");
      assert.ok(minimum <= 11 * 65536, `Darwin native image exceeds the Node 22 macOS 11 baseline (${version(minimum)})`);
      deployment = { platform: "macos", baseline: "11.0", minimumOS: version(minimum), sdk: version(sdk) };
    }
    offset += size;
  }
  assert.equal(offset, end, "Unclassified Mach-O command bytes");
  assert.ok(deployment, "Missing macOS deployment command");
  return deployment;
}

export function inspectLinuxNativeImage(binary) {
  const inspect = flag => execFileSync("readelf", [flag, "--", binary], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
  return validateLinuxNativeVersionNeeds(inspect("--dynamic"), inspect("--version-info"));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  assert.ok(args.length === 4 && args[0] === "--binary" && args[2] === "--out", "Expected one compiled image and a fresh output directory");
  assert.ok(["linux", "darwin", "win32"].includes(process.platform) && process.arch === "x64", "Unqualified native packaging target");
  const binary = resolve(args[1]), output = resolve(args[3]);
  const sourcePath = fileURLToPath(new URL("../native/locks.c", import.meta.url));
  for (const path of [binary, sourcePath]) {
    const stat = lstatSync(path);
    assert.ok(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= 10 * 1024 * 1024,
      "Package only bounded single-link regular build inputs");
  }
  // This admission precedes dlopen and output creation; a newer build host cannot silently raise the minimum.
  const libc = process.platform === "linux" ? inspectLinuxNativeImage(binary) : undefined;
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  const binaryBytes = readFileSync(binary), sourceBytes = readFileSync(sourcePath);
  const deployment = process.platform === "darwin" ? validateDarwinNativeImage(binaryBytes) : undefined;
  mkdirSync(output, { mode: 0o700 });
  const image = join(output, "locks.node");
  copyFileSync(binary, image);
  writeFileSync(join(output, "locks.c"), sourceBytes, { flag: "wx" });
  assert.equal(digest(readFileSync(image)), digest(binaryBytes), "Copied image must preserve the original build bytes");
  const native = createRequire(import.meta.url)(image);
  assert.equal(native.backendKind, `pi-telegram-kernel-v1-${process.platform}`);
  assert.equal(native.napi, 8, "Distributable images require the frozen N-API level");
  assert.deepEqual(Reflect.ownKeys(native).sort(), ["backendKind", "napi", "release", "tryAcquire"], "No fixture/fault or raw-resource API may enter a distributable image");
  for (const method of ["tryAcquire", "release"]) assert.equal(typeof native[method], "function");
  const binarySha256 = digest(binaryBytes);
  assert.equal(digest(readFileSync(image)), binarySha256, "Image identity cannot change during package inspection");
  assert.equal(digest(readFileSync(sourcePath)), digest(sourceBytes), "Native source cannot change during package assembly");
  const manifest = {
    version: 1, backendKind: native.backendKind, platform: process.platform, arch: process.arch,
    napi: 8, minimumNode: "22.19.0", builtWithNode: process.versions.node,
    ...(libc ? { libc } : {}), ...(deployment ? { deployment } : {}),
    source: { file: "locks.c", sha256: digest(sourceBytes), bytes: sourceBytes.length },
    binary: { file: "locks.node", sha256: binarySha256, bytes: binaryBytes.length },
  };
  writeFileSync(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(manifest, null, 2));
}
