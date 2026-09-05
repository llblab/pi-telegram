---
name: generated-control-surface
description: Proactively generate truthful prompt-button controls; every active surface emits useful buttons with semantic emoji labels, while stable deterministic loops route to Generative Apps.
---

# Generated Control Surface

Compile a temporary interface from current evidence, available capabilities, and user intent:

```text
state + capabilities + intent → projection + likely next actions
```

The surface projects reality; it does not own domain state, grant authority, or create a shadow application.

## Admission

Proactively use controls whenever a tap can reduce response effort, ambiguity, turnaround time, or supervision cost. On a prompt-button transport, every response produced under this Skill must include at least one useful button; never finish with prose alone. A bounded confirmation or choice should expose 2–6 safe concrete actions.

At workflow handoff, offer a small high-confidence next-action set when the completed step clearly unlocks it. Preserve free-form reply when choices are not exhaustive. When no domain mutation qualifies, offer the most useful truthful continuation—such as inspect details, refine scope, refresh mutable evidence, navigate back, or continue the parent workflow—rather than a decorative control or generic “What next?”.

Every button must advance, inspect, clarify, recover, navigate, or supervise the current intent. Never duplicate visible prose, represent unclear consequences, or repeat a command that introduces no new decision.

## Ownership And Truth

Identify one controlled object, target, and capability owner. Build from one declared truth mode when ambiguity matters:

- **Live:** Freshly inspected mutable state.
- **Contract:** Stable documented capability.
- **Conversation:** Choices established in the dialogue.
- **Adapted:** A labeled subset or transformation.

Never present remembered or inferred state as live. Preserve material identity, ordering, values, warnings, failures, authority, and completeness. Label filtering, truncation, pagination, and unavailable evidence. Refresh affected state after mutation before claiming success or rendering dependent controls.

Use the real capability owner—tool, API, repository, Actor runtime, filesystem, media system, workflow, or conversation. Do not invent parallel state, lifecycle, navigation, or callbacks.

## Surface Contract

A surface is an ordered ragged sequence of rows. Each button carries:

- A short, distinct label.
- The smallest self-contained next-request prompt.
- Optional presentation state supported by the transport, including disabled controls when their visible unavailability helps explain current state.

A disabled control is not an action: it needs no prompt or selected style and must not enqueue a prompt or invoke a bound method. Prefer a meaningful label; omit it only for an intentional blank cell in a spatial layout, never as decorative padding. Preserve its label and position when that makes a changing surface easier to understand; otherwise omit irrelevant controls. Explain non-obvious unavailability without relying on color alone. Retain at least one useful enabled action, such as refresh or navigation. Derive disabled state from the same evidence as the view; an old enabled control still requires current domain validation. Use the transport owner's disabled encoding rather than a dummy prompt or no-op callback.

Prompts must name any target, operation, constraint, or freshness identity whose omission could change the action. Reuse visible context only when it remains unambiguous under delayed or reordered clicks. Never encode volatile output that should be freshly inspected.

Every generated human-readable action label must use `emoji + space + text`; emoji-free text labels are invalid. Choose the emoji by action semantics, keep its meaning consistent, and never rely on emoji or color alone. Coordinates, established symbolic controls, and intentionally spatial glyphs already satisfy the marker role through their domain grammar. If prompt buttons are unavailable, preserve the same choices as a numbered list.

## Layout Kernel

- Use one full-width row for an independent, primary, long, or consequential action.
- Use two columns only for unmistakably short textual peers.
- Reserve three through eight columns for compact position-bearing glyphs or codes.
- Preserve hierarchy and reading order; never pad, duplicate, or shorten necessary wording for symmetry.
- Use Back/Up only for real hierarchy and Refresh only for mutable projections.
- Prefer 2–6 decision controls. Paginate or group larger non-spatial collections.

For complex grids, navigation collections, or stateful repeated clicks, read [`references/layout-and-state.md`](./references/layout-and-state.md).

Place a control group beside the section it governs when the transport supports in-body blocks; use a footer for whole-answer actions. Placement must not change the matrix or action semantics. Serialize the resulting rows with the active transport contract. This Skill owns admission and composition, not transport syntax.

## Safety

A click is an ordinary user request under the same authority and validation rules as typed text. Never infer permission from the existence of a button.

Classify actions as read-only, ordinary mutation, privileged, destructive, secret-bearing, external, or irreversible. High-impact actions use two stages:

1. Open a confirmation surface naming exact target, effect, and recovery boundary.
2. Offer a distinct request for the exact operation.

Re-check mutable targets immediately before execution. Never expose secrets, credentials, hidden reasoning, private keys, tokens, cookies, wallet material, or sensitive content in labels, prompts, or projections. Access denial never authorizes privilege escalation.

## Reuse Boundary

Keep one-off, interpretive, changing, and context-heavy interaction here. When state and transitions become stable, repeated, bounded, and deterministic, follow `generative-apps` and compile only the deterministic loop. Existing transport menus, runtime callbacks, and installed apps remain with their owners.

For capability-specific composition guidance, read only the applicable reference:

- Console, filesystem, workflows, Actor Runs, and design choices: [`references/capability-adapters.md`](./references/capability-adapters.md)

## Procedure

1. Identify intent, controlled object, owner, and truth mode.
2. Inspect only the evidence needed for a truthful projection.
3. Admit only high-leverage actions and classify their impact.
4. Arrange semantic rows, then serialize through the transport owner.
5. Treat the click as a new request, validate authority, act, and refresh reality.

## Failure And Empty States

Show concise failure evidence and emit valid recovery controls such as diagnose, retry, refresh, back, or narrower scope. If a target disappears, return to its nearest valid owner or parent. Empty collections retain the safest useful navigation, inspection, or refinement control rather than degrading to prose-only output.

## Final Check

Before sending:

- At least one useful button is present whenever the transport supports prompt buttons.
- Every human-readable button label begins with a semantic emoji and one ASCII space.
- State, actions, owner, and target agree.
- Live claims are fresh; adaptation and incompleteness are explicit.
- Every prompt is sufficient and every label follows its semantic emoji rule.
- Row grouping reflects real hierarchy or peer relationships.
- High-impact actions require confirmation.
- No secret or hidden reasoning appears.
- The surface remains readable on a phone and free-form feedback remains possible.
