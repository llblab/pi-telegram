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
4. If a live polling owner exists, ask interactively whether to move singleton ownership here

## Acquisition timing

Lock writes must be caused by an explicit user-initiated runtime event, such as a start/connect command or a confirmed takeover prompt.

Extension initialization and session-start hooks may read `locks.json`, update local status, install ownership watchers, and resume local work when the existing lock already points at the current `pid`/`cwd`. After a full process restart, a session-start hook may replace a stale lock from the same `cwd` to restore explicitly requested ownership. They must not create ownership from an inactive lock, take over a live polling owner, or replace a stale lock from another directory by themselves. Such locks should stay visible as state until the user runs the start/connect command. Session replacement should suspend local runtime work and ownership watchers without releasing the lock, so the next session in the same `pid`/`cwd` can resume from explicit ownership.

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

Extensions may prefix those states with their own compact name, such as `wakeup off` or `telegram on`.

## Interactive takeover

Start/connect commands should make singleton moves easy:

1. If no live owner exists, take ownership without an extra prompt
2. If a live polling owner exists, ask whether to move singleton ownership to this pi instance
3. On confirmation, write the current `{ "pid": ..., "cwd": ... }` to this extension's key in `locks.json`
4. The previous owner must notice that `locks.json` no longer points at its own `pid`/`cwd` and stop singleton-owned work such as polling/watchers without deleting the new lock or unrelated session-local queues

Takeover prompts should use the extension name as the dialog title, then the question, a blank line, and source/target lines:

```text
pi-singleton
move singleton lock here?

from: pid 2590864, cwd /old
to: /new
```

Avoid repeating the extension name in the body. Color is encouraged: extension title/name accent, question warning, `from:`/`to:` muted.

The previous owner may use `fs.watch`, mtime polling, or an existing status/timer tick. Long-lived watchers should compare against a snapshotted `pid`/`cwd` identity rather than a live pi context object, because session replacement such as `/new` makes captured contexts stale. The important contract is graceful singleton-runtime shutdown after ownership mismatch while session-local state that does not require polling remains owned by its original instance.

## Reset

Delete `~/.pi/agent/locks.json` to reset singleton runtime ownership for all participating extensions without deleting their configuration files.

## Atomicity

Every ownership mutation runs inside a short cross-process transaction acquired through exclusive file creation. The transaction covers the complete registry read/check/write sequence, so concurrent processes cannot both win an ordinary acquisition or stale-overwrite unrelated extension/profile keys. The registry payload itself still commits through same-directory temp-file replacement.

A guard is written completely to a private staged file and published with one exclusive hard-link operation, so no live empty/partially written generation becomes recoverable by age. A crashed transaction owner leaves a complete guard that a later process recovers only when the recorded owner PID is no longer alive. Recovery contenders serialize through a second atomically published guard so one process cannot rename a newer live transaction generation. Cleanup compares the exact random guard generation before unlinking. Malformed guards, unsupported atomic publication, and unverifiable recovery fail closed after bounded contention rather than risking concurrent registry mutation.

Transactional reads treat only a missing registry as empty. Read, parse, and shape failures abort without replacing the existing file or erasing unrelated ownership keys.

Each runtime retains the profile key plus exact owner identity it acquired. New leaders receive a collision-resistant epoch independent from heartbeat timestamps and a monotonic same-process runtime generation. Refresh, release, and thread-state snapshot publication commit only while the profile key, PID, cwd, instance id, epoch, and runtime generation still match. Snapshot rename runs inside the same lock-registry transaction guard as its final owner check. Forced replacement additionally requires the exact previously observed owner; same-process lifecycle handoff permits only a newer runtime generation to replace an older one. A delayed old runtime cannot reverse that transition, publish prepared thread state, or reinterpret its retained owner token under another profile key.

Direct Bot API authority follows this exact ownership check. Accepted local queue work may continue through Pi after ownership moves, but stale preview/final/menu/file mutations fail closed instead of bypassing the replacement transport owner. Follower recovery retries registration while the exact external owner remains live and promotes only after an election transaction confirms that the observed owner still remains stale or that no owner appeared after an inactive observation; IPC unreachability alone never authorizes takeover. Simultaneous election losers re-register with the winner using their carried exact thread target.

The ownership heartbeat starts immediately after acquisition, before binding handoff or slow leader startup. It remains active through provisioning/server/polling startup; startup errors release the exact acquired lock after cleanup, and ownership loss during startup stops the partial runtime and returns failure rather than announcing leadership. Topic provisioning also stamps the acquired epoch and rechecks it before and after every persistence and Bot API boundary, including `epoch → undefined` loss.

## Migration

Migrations from legacy lock files or legacy keys should be one-off cleanup work. Runtime ownership should read and write only `locks.json` under the canonical identity key.
