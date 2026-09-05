---
name: generative-apps
description: Design, author, review, install, replace, invoke, or debug reusable Generative Apps that combine generated button interfaces, deterministic bound methods, and optional model-mediated prompts. Use for standalone applications and bounded view/controller adapters rendered through pi-telegram; prefer Generated Control Surface when no reusable deterministic program is earned.
---

# Generative Apps

## Concept

A Generative App is a reusable application authored by the model for a concrete task. It combines persistent state, named methods, textual output, and a generated button interface. The model acts primarily as author/compiler; the installed program then renders evolving views and executes routine transitions without requiring inference on every click.

```text
intent → model authors app → reusable state + methods + generated views
```

One surface may deliberately mix two action planes:

```text
bound method  → deterministic local transition
ordinary prompt → model interpretation, explanation, teaching, or adaptation
```

This is broader than one Telegram implementation. Telegram is the first renderer; a future TUI or web renderer may reuse the concept once a second implementation proves the common contract. Keep renderer-specific wire and lifecycle details with the owning runtime.

Generative Apps complement `generated-control-surface`:

```text
Generated Control Surface → current context → model → one ephemeral surface
Generative App             → model → reusable program → many evolving surfaces
```

Both Skills use the same logical button matrix and `label + prompt` interaction model. An app may place groups beside their related content using the transport's in-body button blocks or keep whole-view controls in the footer; placement does not change binding, disabled state, or method authority. The Telegram runtime owns its full JSON/CML notation and callback routing; this Skill owns reusable program judgment, while `generated-control-surface` owns ephemeral agent-authored composition. Shared rendering needs no third button Skill and does not collapse those responsibilities.

An app may mix deterministic `app::method` controls and ordinary prompts in one view, including one control group. Compact and named cells may coexist under the shared transport grammar; neither representation nor placement creates another action plane. Compile only the stable transitions that benefit from inference bypass; keep explanation, interpretation, teaching, and adaptation on the model-mediated plane. When no reusable state or deterministic loop earns a script, load and use `generated-control-surface` instead.

The `generated` / `generative` distinction is intentional. Do not rename `generated-control-surface` to a competing generative term.

## Ownership

This Skill owns agent operating judgment:

- Whether a Generative App is warranted.
- Standalone versus adapter selection.
- Authoring and capability review.
- Install, replace, invoke, and validation workflow.
- Safety boundaries and stop decisions.

This Skill also owns the transport-independent concept, vocabulary, application shapes, hybrid action model, and relationship to Generated Control Surface.

[`../../docs/generative-apps.md`](../../docs/generative-apps.md) owns only the concrete `pi-telegram` runtime reference: Telegram wire syntax, managed layout, executable ABI, state timeline, generation/revision fencing, worker execution, locking, installation transactions, callback routing, lifecycle behavior, and current limitations. Do not duplicate those implementation details here.

## When To Use

Use a Generative App when:

- Interaction repeats or contains several stable transitions.
- State and valid actions fit a small auditable contract.
- Direct methods materially improve latency, cost, reliability, or UX.
- Model judgment remains optional rather than required for every action.
- One clear owner exists for application or external domain state.

Prefer `generated-control-surface` for one-shot, interpretive, rapidly changing, or wholly model-mediated interaction. Do not create decorative apps, generic remote terminals, arbitrary command runners, or deterministic facades over ambiguous high-impact decisions.

## Choose The Shape

### Standalone deterministic application

The app owns a closed state machine such as a game, form, selector, simulation, or compact workflow. Its state must reconstruct the current view and explain the previous transition.

### View/controller adapter

Another capability remains the authoritative real owner. The app stores validated adapter configuration and a last-observed projection only. Re-read the owner before mutation or explicit status; never promote cached view state into domain authority.

## Authoring Workflow

1. Identify the repeated feedback loop, real state owner, and actions that are truly deterministic.
2. Choose one stable lowercase app and one self-contained `<app>.mjs` source outside the managed installation directory.
3. Keep `init` and every exported method small, named, bounded, shell-free, and capability-specific.
4. Render one complete next view after each action. Derive disabled controls from current state using the shared transport contract; visible disabled controls neither invoke methods nor enqueue prompts. Revalidate domain preconditions when an enabled control is invoked, because previously rendered views may be stale.
5. Mix action planes intentionally:

```text
app::method(argument) → bounded method without a model turn
ordinary prompt          → model-mediated interpretation or explanation
```

6. Review state fields, arguments, process calls, rendered values, secrets, destructive effects, and failure paths.
7. Install with `telegram_bind({ app, script, argument })`.
8. Replace the same logical app only with explicit `replace: true`; never create `-v2` identities merely to reload code.
9. Invoke read-only diagnostics with `telegram_bind({ app, method, argument, display: false })` when agent-side evidence is needed.
10. Keep the maintained source with its capability owner; managed `genapps/` state is runtime installation, not source ownership.

## Safety Rules

- A direct click authorizes only its exact installed method and validated JSON argument.
- Use exact executable plus argv through the bounded process port; never expose generic `exec` or shell text.
- Keep credentials and unrelated private state out of source, state, output, and diagnostics.
- Route consequences requiring contextual judgment through an ordinary model prompt.
- Fail closed on unavailable owners, stale actions, malformed state, absent methods, process failures, or uncertain effects.
- Do not claim automatic refresh, removal, voice output, or other behavior still marked incomplete in the runtime document.

## Validation

Before presenting an app as working:

- Confirm app, source stem, installed identity, and bound prompts agree.
- Inspect the installed initial view and persisted bounded state.
- Exercise at least one real bound action and prove it bypasses Pi queue/model admission.
- Exercise at least one ordinary prompt when the app intentionally uses the model plane.
- Verify the placements actually used by the app and prove disabled cells invoke nothing. A successful ordinary prompt-button smoke is not evidence of app-method dispatch or stale-revision rejection.
- Verify replacement rejects stale buttons and failed initialization preserves the prior app.
- For adapters, prove fresh external status and terminal mutation evidence.
- Confirm failures are bounded, redacted, and do not silently render success.

Stop and return to ordinary model interaction when the workflow cannot be represented safely as reviewed bounded methods plus explicit model prompts.
