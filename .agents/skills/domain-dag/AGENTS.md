# Domain DAG Maintenance

- Architecture semantics, calibration, extraction, severity, and configuration are owned by [SKILL.md](./SKILL.md); keep this file limited to development constraints for the skill and validator.
- Keep the skill and validator portable: no project-specific names, absolute local paths, stack-only assumptions, or external dependencies. Express project-specific checks through configuration rather than hard-coded repository rules.
- Run the bundled validator against the consuming project root using the invocation in [SKILL.md](./SKILL.md#validation); project-local configuration owns project-specific checks.
- In human-readable validator output, separate section banners and final summaries from diagnostics with a blank line. Keep `--json` output free of those text banners and spacing rules.
