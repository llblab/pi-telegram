# Extension Locks Standard

**Meta-contract:** transportable (bit-for-bit identical across projects), high-density (zero fluff), constant (evolve by crystallizing, not speculating), optimal minimum (add only when it hurts).

---

`locks.json` is a shared registry for singleton pi extensions.

Path:

```text
~/.pi/agent/locks.json
```

## Shape

```json
{
  "@scope/pi-singleton": {
    "pid": 2590864,
    "cwd": "/home/user/project"
  }
}
```

Top-level keys are extension identities. Values are JSON objects owned by that extension.

## Identity key

Use the most stable available identity:

1. `package.json/name` for npm-style pi packages
2. Directory name when the extension entrypoint is `index.ts` but there is no package name
3. File basename when the extension is a single file

For npm-style package extensions, the canonical value is the `package.json` `name`. Implementations may keep that value as a small local constant when it is clearer than runtime package introspection. The fallback rules are only for unpackaged extensions.

Examples:

```text
extensions/pi-singleton/package.json name=@scope/pi-singleton -> @scope/pi-singleton
extensions/pi-singleton/index.ts without package.json         -> pi-singleton
extensions/pi-singleton.ts                                    -> pi-singleton
```

## Required fields

```json
{
  "pid": 2590864
}
```

`pid` is the process that currently owns the singleton runtime. `cwd` should be stored when ownership is tied to a pi session directory.

During a user-initiated start/connect event, an extension should:

1. Read its lock entry
2. If `pid` is stale, replace the entry
3. If `pid` and `cwd` match the current pi instance, refresh or keep the entry
4. If a live external owner exists, ask interactively whether to move singleton ownership here

## Acquisition timing

Lock writes must be caused by an explicit user-initiated runtime event, such as a start/connect command or a confirmed takeover prompt.

Extension initialization and session-start hooks may read `locks.json`, update local status, install ownership watchers, and resume local work when the existing lock already points at the current `pid`/`cwd`. After a full process restart, a session-start hook may replace a stale lock from the same `cwd` to restore explicitly requested ownership. They must not create ownership from an inactive lock, take over a live external owner, or replace a stale lock from another directory by themselves. Such locks should stay visible as state until the user runs the start/connect command. Session replacement should suspend local runtime work and ownership watchers without releasing the lock, so the next session in the same `pid`/`cwd` can resume from explicit ownership.

## Optional fields

Extensions may add compact fields when useful:

```json
{
  "pid": 2590864,
  "cwd": "/repo/project",
  "mode": "connected",
  "updatedAt": "2026-04-28T00:00:00.000Z"
}
```

Do not print optional fields in normal UI unless they help the user act.

## Ownership rules

- One top-level key per singleton extension
- An extension may only mutate its own key
- Other keys must be preserved exactly
- If `cwd` is present, active-here ownership means both `pid` and `cwd` match the current pi instance
- Human-readable diagnostics should say `active here`, `active elsewhere`, or `stale`
- Debug data belongs in `locks.json`, not in normal status output

## Runtime status

Singleton extensions with footer/status presence should expose quiet but explicit local state:

- `off` when this pi instance does not own the singleton runtime
- `on` when this pi instance owns the runtime but has no pending runtime detail to show
- `[16:32:39]` when the runtime owns scheduled work and can show the next countdown

Extensions may prefix active states with their own compact name, such as `telegram on` or `wakeup [00:10:00]`. Quiet idle states may be hidden when status-line width is more valuable than an explicit off marker.

## Interactive takeover

Start/connect commands should make singleton moves easy:

1. If no live owner exists, take ownership without an extra prompt
2. If a live external owner exists, ask whether to move singleton ownership to this pi instance
3. On confirmation, write the current `{ "pid": ..., "cwd": ... }` to this extension's key in `locks.json`
4. The previous owner must notice that `locks.json` no longer points at its own `pid`/`cwd` and stop local runtime work without deleting the new lock

Takeover prompts should use the extension name as the dialog title, then the question, a blank line, and source/target lines:

```text
pi-singleton
move singleton lock here?

from: pid 2590864, cwd /old
to: /new
```

Avoid repeating the extension name in the body. Color is encouraged: extension title/name accent, question warning, `from:`/`to:` muted.

The previous owner may use `fs.watch`, mtime polling, or an existing status/timer tick. Long-lived watchers should compare against a snapshotted `pid`/`cwd` identity rather than a live pi context object, because session replacement such as `/new` makes captured contexts stale. The important contract is graceful local shutdown after ownership mismatch.

## Reset

Delete `~/.pi/agent/locks.json` to reset singleton runtime ownership for all participating extensions without deleting their configuration files.

## Atomicity

`locks.json` is one shared registry, so preserving unrelated keys in memory is not sufficient. Every writer must serialize the complete cross-process read/check/write transaction through the same guard. Otherwise two extensions can read the same snapshot, update different keys, and publish snapshots that erase one another.

The canonical guard path is:

```text
~/.pi/agent/locks.json.transaction
```

All participating extensions must follow one compatible protocol:

- Acquire the guard before every ownership acquisition, refresh, release, takeover, or other registry mutation.
- Publish fully initialized private owner metadata atomically. A portable implementation may stage a non-empty directory containing `owner.<generation>.json`, require filename/payload generation agreement, and rename that directory into the stable guard path.
- Do not depend on hard links or platform-specific advisory locks; the protocol must work on Linux, macOS, native Windows, and Android/Termux filesystems supported by Pi.
- Read and validate the latest complete registry only after guard acquisition, change only the owned extension key, and preserve every unrelated key from that guarded snapshot.
- Publish the JSON payload through a same-directory temporary file and atomic rename. Atomic payload replacement prevents torn JSON but does not replace transaction serialization.
- Release only the exact acquired owner by atomically renaming the stable guard away before cleanup. Stale recovery must prove the observed owner process is dead and must fence delayed recovery against replacement-owner ABA races.
- Fail closed on malformed owner metadata, malformed registry state, unverifiable generations, contention timeout, or unsupported atomic filesystem behavior.

Lock-free reads remain appropriate for status display when readers tolerate an old-or-new complete snapshot. Any decision that mutates shared ownership must re-read and validate under the transaction.

Cross-writer safety is compositional: every writer targeting the same registry must participate in the protocol. One compliant writer cannot guarantee lost-update safety against another writer that bypasses the shared transaction.

## Migration

Migrations from legacy lock files or legacy keys should be one-off cleanup work. Runtime ownership should read and write only `locks.json` under the canonical identity key.
