# AGENTS.md (domain-dag)

## Knowledge & Conventions

### Meta-Protocol Principles

- 'Domain Ownership': Every durable responsibility should have a single owning source module or package.
- 'Acyclic Direction': Local source imports should form a directed acyclic graph.
- 'Composition Boundary': Entrypoints compose ports and runtimes; domain modules do not import entrypoints.
- 'Transportability': The skill and validator must avoid project-specific names, absolute local paths, stack-only assumptions, and external dependencies.
- 'Explicit Non-Ownership': Durable module contracts should state what they own and what they reject.
- 'Interface Surface Pressure': Wide callback/parameter/export surfaces are architectural pressure to group related concepts into named contracts, not automatic failures.
- 'Shape Before Rules': First identify whether the project is flat, layered, package-based, hexagonal, or hybrid; then choose validation rules.

### Operating Principles

- Use `scripts/validate-domain-dag.sh` for graph audits.
- Prefer config-driven project rules over hard-coded repository assumptions.
- Keep validator defaults portable; make stack-specific checks opt-in via config.
- Use import aliases from config when a project routes local imports through bundler/tsconfig/package aliases.
- Treat cycles and reverse entrypoint imports as hard failures.
- Treat generic shared-bucket names as warnings unless a project config upgrades them.
- Add custom alias, layer, forbidden-edge, header-clause, and surface-width rules only for discovered project constraints.

### Discovered Constraints

- Shared-bucket names are heuristic, not proof of bad architecture.
  - Trigger: `utils`, `types`, `shared`, or similar names appear.
  - Action: Audit ownership and either move content to an owner or allow the exception.
- Header labels are a navigation aid, not the graph itself.
  - Trigger: A project lacks module headers but has clean boundaries.
  - Action: Warn by default; use strict/config only when headers are adopted standard.
- Layer checks must be opt-in.
  - Trigger: Generic validation across unknown projects.
  - Action: Validate universal graph invariants by default; enforce local direction only from config.
- Header clauses are earned standards.
  - Trigger: A project adopts explicit ownership headers such as owner/exclusion clauses.
  - Action: Configure `headerRequiredClauses`; do not bake local wording into the skill default.
- Wide interfaces are pressure, not proof.
  - Trigger: A child boundary accumulates many callbacks, methods, exports, or parameters.
  - Action: Prefer grouped contracts/ports when stable; use `surfaceRules` as warnings unless noise-free.
- Decomposition has a stop rule.
  - Trigger: Further extraction would mostly pass host state through or hide control flow.
  - Action: Stop, review, and document the boundary rather than creating one-use wrappers.
- Flat and layered DAGs are both first-class.
  - Trigger: An extension/CLI has one entrypoint plus cohesive flat domain files, or a frontend/service has earned layered route/use-case/domain separation.
  - Action: Preserve the local shape if dependency direction and ownership are clear; do not impose the other shape for aesthetic consistency.
- Severity is a ladder.
  - Trigger: A heuristic finds pressure but not a concrete break.
  - Action: Keep it as a warning until repeated evidence proves it should fail builds.
