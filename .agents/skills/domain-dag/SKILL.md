---
name: domain-dag
description: Validates and guides Domain DAG architecture for domain ownership, acyclic local dependency graphs, composition roots, boundary direction, public contracts, interface-surface pressure, and shared-bucket drift. Use when auditing, refactoring, or extending modular codebases across frontend, backend, extensions, CLIs, SDKs, and service packages.
metadata:
  version: 1.0.16
---

# Domain DAG

## Purpose

Maintain source code as a directed acyclic graph of cohesive responsibility modules.

A Domain DAG keeps architecture readable by making every durable module answer four questions:

1. **What does this module own?**
2. **What does it explicitly not own?**
3. **Which lower or peer contracts may it depend on?**
4. **Where is live composition allowed to happen?**

The skill is not tied to one stack or folder style. It applies to frontend features, backend bounded contexts, extension hosts, SDK packages, CLIs, workers, and service adapters.

## Core Model

```text
composition root / delivery surface
  → orchestration or use-case modules
    → domain capability modules
      → support/foundation modules
        → platform, runtime, standard library, external adapters
```

The filesystem may be flat, layered, package-based, or mixed. The graph is architectural, not decorative: ownership lives in module boundaries, import direction, public contracts, and explicit composition points.

## Common Shapes

Domain DAG is a graph discipline, not one folder template.

- **Flat domain DAG**: one entrypoint plus flat domain files/packages. Best for extensions, CLIs, small services, and runtimes where deep folders would hide rather than clarify ownership.
- **Layered domain DAG**: routes/controllers/features/use-cases compose reusable domain and support modules. Best when delivery surfaces are numerous and entity capabilities are reused across screens or endpoints.
- **Package DAG**: apps depend on packages, packages depend on foundation or peer public contracts. Best for monorepos and SDKs.
- **Hexagonal/ports DAG**: use cases depend on ports/contracts while adapters live at composition boundaries. Best for backends, workers, queues, and external integrations.
- **Hybrid DAG**: different bounded contexts use different local shapes, but the global dependency direction stays acyclic and explicit.

Choose the smallest shape that explains the code. Do not force a layered tree onto a flat extension or flatten a product frontend that has earned route/feature/domain separation.

## Axioms

### A1: Domain Ownership

Each durable responsibility has one owning module or package. Types, constants, helpers, adapters, state, policies, and tests that define a responsibility live with that owner.

### A2: Explicit Non-Ownership

A strong boundary says what it does **not** own. This prevents accumulation of adjacent workflows, transport concerns, persistence policy, UI chrome, or runtime wiring just because the code is nearby.

### A3: Directed Imports

Local imports must form a DAG. Cycles are architecture bugs because they hide ownership and make change impact non-local.

### A4: Composition Root Boundary

Entrypoints wire live ports, configuration, adapters, routes, framework lifecycles, queues, and domain runtimes. Domain modules must not import composition roots.

### A5: Shared Bucket Resistance

Files or folders named `types`, `constants`, `utils`, `helpers`, `shared`, or `common` are suspect. Use them only when the responsibility is genuinely cross-domain and cannot belong to a more specific owner.

### A6: Public Contracts Over Reach-Through

When a module needs another module's behavior, depend on the smallest public contract that expresses the capability. Avoid importing internals, broad mutable runtime state, or sibling orchestration surfaces.

### A7: Progressive Disclosure

Start with the smallest useful graph. Add layers, public barrels, forbidden edges, header clauses, and custom checks only after real project constraints make them valuable.

### A8: Interface Surface Pressure

A very wide boundary can be as harmful as a wrong dependency. Many callbacks, parameters, exported knobs, or adapter methods are pressure to group related concepts into named contracts, ports, state objects, command objects, or smaller capabilities.

## Placement Heuristics

Use these questions when creating or moving code:

- **Survival test**: If the current route/screen/job/command disappeared, would this module still be useful? If yes, it likely belongs below the orchestration layer.
- **Noun vs journey**: Business nouns/capabilities belong in domain modules. User journeys, workflows, route handlers, modal/screen flows, jobs, and shell composition belong in orchestration/features/use cases.
- **Reuse pressure**: Peer orchestration modules should not import each other for shared behavior. Extract the reusable capability down to a domain/support module, or extract generic mechanics down to foundation/UI/platform.
- **Entrypoint shim pressure**: If executable scripts grow substantive behavior, keep the executable file as a thin runner and move the behavior into a named compiled domain module when reuse, testing, packaging, or runtime compatibility benefits are plausible. Do not extract self-contained app scripts whose logic has no expected second consumer; keep them standalone when the boundary would be theater.
- **Policy locality**: Persistence policy, transaction boundaries, routing, lifecycle registration, drag/drop registration, message acknowledgement, and external transport wiring usually remain in the owning composition/use-case layer unless they are themselves reusable policies.
- **Naming is not ownership**: A `cards` feature and a `cards` domain can coexist if one owns the journey and the other owns reusable card capabilities.
- **Public surface test**: Consumers should import what the owner deliberately exposes, not whatever file is easy to reach. Public barrels, package exports, ports, facades, or documented function groups are all valid contracts when they fit the ecosystem.
- **Flat-shape caution**: In a flat DAG, file count is not the main health metric. Cohesion, acyclicity, explicit headers, and absence of shared buckets matter more.

## Calibration Protocol

Before adding or enforcing rules, calibrate the project:

1. Identify the shape: flat, layered, package, hexagonal, or hybrid.
2. Find the true composition roots: app bootstrap, extension entrypoint, HTTP router, worker runner, CLI command, SDK facade, test harness.
3. Identify the project’s public-contract mechanism: barrels, package exports, interfaces, ports, route handlers, generated clients, or documented namespaces.
4. Run generic validation first; treat warnings as leads, not facts.
5. Add project-local config only for constraints the project has actually earned.
6. Keep hard errors for low-noise invariants; keep heuristics as warnings.

## Extraction Protocol

When decomposing or extending a module:

1. Identify the host's real responsibility and write it down.
2. Find stable seams: repeated entity surfaces, reusable policy, narrow UI/control blocks, adapters, or pure transformations.
3. Extract only if the child has a clear owner and exclusion list.
4. Keep persistence, runtime lifecycle, routing, external effects, and screen/job orchestration in the host unless the extracted module explicitly owns that policy.
5. Replace cross-feature or cross-use-case reuse with lower-layer contracts rather than peer imports.
6. Run the validator and the project's normal checks.
7. Stop when the host mainly coordinates state/effects and the next extraction would hide control flow or create a one-use wrapper.

## Stop Rules

Do **not** keep decomposing just because a file is large. Stop when:

- Remaining code is orchestration glue with high local context value.
- The module is a self-contained executable application and its behavior is unlikely to be imported by another domain.
- The next slice would have no reusable responsibility beyond “some markup from the host”.
- The extracted child would need most of the host state as props.
- The boundary would create a long flat callback list instead of a meaningful contract.
- Behavior risk exceeds architectural gain.

At this point, switch to review: check for misplaced ownership, too-wide contracts, stale imports, and validator gaps.

## Anti-Patterns

- **Folder theater**: creating layers or domain folders without changing dependency direction or ownership clarity.
- **Peer feature reach-through**: one workflow imports another workflow because it wants a reusable part.
- **Shared bucket gravity**: generic `types`, `utils`, or `constants` become the real hidden domain.
- **God facade**: a public contract exposes most internals and gives consumers no smaller capability boundary.
- **RPC child component/module**: a child boundary accepts dozens of callbacks or flags instead of a named contract.
- **Premature atomization**: many one-use files obscure the main control flow and make debugging harder.
- **Validator absolutism**: heuristic warnings are promoted to errors before the signal is proven stable.

## Validation

Run the bundled validator from a project root:

```bash
SKILL_DIR=/path/to/domain-dag
bash "${SKILL_DIR}/scripts/validate-domain-dag.sh" --root .
```

Useful flags:

- `--root <path>` — project root; defaults to the current directory
- `--config <path>` — JSON config; defaults to `domain-dag.json`, then `.domain-dag.json`
- `--strict` — treat warnings as failures
- `--json` — machine-readable output

The validator checks:

- Local source import graph has no cycles, including configured local import aliases
- Domain modules do not import configured entrypoints
- Optional domain headers are present
- Optional required header clauses are present
- Shared-bucket filenames and folders are reported
- Optional flat-root, layer-order, forbidden-edge, and surface-width rules hold

## Configuration

Add a project-local `domain-dag.json` when defaults are too broad or too narrow:

```json
{
  "sourceRoots": ["src", "lib"],
  "sourceExtensions": [".ts", ".tsx", ".js", ".jsx", ".svelte"],
  "entrypoints": ["src/main.ts", "src/app/bootstrap.ts"],
  "importAliases": {
    "@/*": "src/*",
    "$lib/*": "src/lib/*"
  },
  "requireHeaders": true,
  "headerPattern": "\\b(Domain|Domains|Zone|Zones|Owns):\\s*\\S",
  "headerSeverity": "warn",
  "headerRequiredClauses": ["Owns:", "Excludes:"],
  "headerRequiredClausesSeverity": "warn",
  "flatRoots": false,
  "sharedBucketSeverity": "warn",
  "allowedSharedBuckets": ["src/platform/shared/**"],
  "surfaceRules": [
    {
      "name": "wide callback surface",
      "files": ["src/features/**"],
      "pattern": "\\b(on[A-Z][A-Za-z0-9_]*)\\b",
      "max": 15,
      "severity": "warn",
      "message": "Wide callback surface; group related handlers into contract objects"
    }
  ],
  "forbiddenEdges": [
    {
      "from": "src/domain/**",
      "to": "src/app/**",
      "severity": "error",
      "message": "Domain layer must not import app layer"
    }
  ],
  "layers": [
    {
      "name": "foundation",
      "rank": 0,
      "files": ["src/platform/**"]
    },
    {
      "name": "domain",
      "rank": 1,
      "files": ["src/domain/**"]
    },
    {
      "name": "composition",
      "rank": 2,
      "files": ["src/app/**", "src/main.ts"]
    }
  ]
}
```

Layer rule: lower ranks must not import higher ranks. Same-rank and downward imports are allowed.

`importAliases` lets the validator resolve local path aliases such as `@/*`, `$lib/*`, or package-internal aliases. Keep aliases project-local; the skill should not assume any particular bundler or language server convention.

Glob support is intentionally small and portable: `*`, `**`, and `?` are supported, but brace expansion such as `src/{a,b}/**` is not. Use multiple explicit glob entries or rules instead; the validator warns when configured globs contain unsupported braces.

`surfaceRules` are intentionally generic: by default they count unique regex matches in selected files, and with `metric: "lines"` they count file lines. Use them for local pressure signals such as too many callback props, too many exported commands, broad adapter methods, oversized widgets/modules, or other project-specific interface smells. Keep them warnings unless the signal is proven noise-free.

## Rule-Severity Ladder

Use severity deliberately:

- **Error**: objective graph break or proven boundary breach — cycles, reverse entrypoint import, configured forbidden edge, known-invalid layer direction.
- **Warning**: architectural pressure — shared bucket names, missing headers, wide interfaces, large modules, broad exports, suspicious reach-through.
- **Off / documented exception**: local shape intentionally violates a heuristic and the reason is durable.

A mature Domain DAG has few hard rules and good explanations. It does not need many rules to be strong.

## Operating Protocol

1. Identify composition roots, delivery surfaces, domain roots, and support/foundation roots.
2. Classify the project shape: flat, layered, package, hexagonal, or hybrid.
3. Build or update the ownership map: owner, public contract, explicit exclusions.
4. Run `scripts/validate-domain-dag.sh` with generic defaults.
5. If aliases, layers, or public boundaries are invisible to generic validation, add project-local config.
6. Fix hard failures before cosmetic refactors.
7. Move misplaced types/constants/helpers/policies to their owning module.
8. Replace broad concrete reach-through with narrow ports/contracts when dependency direction is wrong.
9. Group wide interfaces into named contracts when the surface is stable.
10. Add custom forbidden edges, header clauses, or surface rules only after a real boundary has been violated.
11. Stop after the smallest behavior-preserving slice that improves the graph.

## Output Policy

- **Failures**: Cycles, entrypoint reach-through, invalid configured layer edges, invalid configured forbidden edges.
- **Warnings**: Missing headers, missing configured header clauses, shared-bucket candidates, flat-root drift, configured surface pressure.
- **Pass**: The checked graph is acyclic and configured boundary rules hold.
- **Human-readable spacing**: In non-JSON mode, separate section banners from diagnostic lines with a blank line and separate final summaries from the diagnostic stream with a blank line. Example: `--- DOMAIN DAG VALIDATOR ---`, blank line, `[INFO] ...`; after the last `[PASS]` / `[WARN]` / `[FAIL]`, blank line, `Result: N error(s), M warning(s)`. Do not add this spacing inside `--json` output.

## Review Lens

A good Domain DAG review asks:

- Is every durable responsibility owned exactly once?
- Are public contracts smaller than the internals behind them?
- Are peer orchestration modules reusing each other instead of extracting a lower capability?
- Are shared buckets hiding ownership decisions?
- Are interface surfaces becoming RPC-style bags of callbacks or methods?
- Did decomposition improve change locality without hiding essential control flow?
- Are validator rules hard only where they are low-noise and project-earned?
