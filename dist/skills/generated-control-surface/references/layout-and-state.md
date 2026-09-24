# Complex Layout And Interaction State

Read this reference only for complex grids, navigation collections, or repeated stateful clicks.

## Semantic Rows

Model the surface as ordered ragged rows, not a rectangle to fill. Infer independent, peer, ordered, hierarchical, and spatial relationships before choosing row boundaries.

- Non-spatial controls default to one full-width row each.
- A horizontal pair is earned only by genuine peers with unmistakably compact labels and no plausible wrapping or truncation.
- Three through five columns are for short symbols, coordinates, glyphs, or codes whose position carries meaning.
- Six through eight columns require single-glyph or similarly minimal position-bearing labels. Never exceed eight columns on a phone surface.
- Vary row width intentionally; never pad for symmetry with empty, duplicate, or no-op controls. A blank disabled cell is appropriate only when it represents a real unavailable position in a spatial grid.
- Preserve reading order: orientation/navigation, primary content or choices, secondary controls, then separated destructive actions.
- Rectangular grids require genuine spatial or coordinate correspondence. Vertical continuity may justify many rows; non-spatial button walls should paginate or group.

Useful shapes include `1`, `2`, `1 → 2`, `2 → 1`, `1 → 2 → N×1`, repeated `2`, and true `R×C`. Treat these as vocabulary, never templates to impose.

## Metadata And Collections

Use compact stacked key-value rows for path-like, numeric, identifier, or machine state, for example `- **Path:** /...` and `- **Entries:** 1–10 of 52`. Do not join unrelated metadata with decorative separators or duplicate button labels as a plain inventory.

When a Markdown grid has no semantic column headings, use its first data row as the syntactic header and render remaining rows once. Never invent blank, dash-only, or duplicate headings that add false topology.

Navigation collections may expose up to 12 scannable entries; paginate or categorize larger sets. Keep stable ordering and coordinates across regeneration.

## Interaction State

Encode the smallest sufficient action delta when visible context establishes one unambiguous state. Add stable target or state identity when delivery may be delayed, reordered, routed elsewhere, or detached from the projection.

Keep trivial state in conversation. Persist a small human-auditable artifact when state becomes too large or long-lived for reliable reconstruction. Use a deterministic state-transition owner when rules become correctness-sensitive.

Evaluate repeated clicks against current state, not stale button appearance. Preserve tap-ahead when the transport queues each click independently. In source-then-destination interaction, retain the source selection without duplicating the whole surface; regenerate after a completed transition, invalid input, or evidence that the transport cannot preserve the intermediate view.

Omit unavailable controls when layout does not matter. Preserve occupied or selected cells when spatial topology depends on stable coordinates, using the transport's disabled state without a fabricated prompt. Keep a useful enabled navigation or inspection action.

Place each control group beside the content it governs when in-body blocks are supported; keep global navigation and whole-view actions in the footer. Do not duplicate one action in both positions merely for visibility. Row topology and current-state validation stay the same across compact and named representations and across placements; renderer limits and selection feedback belong to the transport.
