# AGENTS.md

## Repository overview

Humble Bundle Downloader is a Bun-based TypeScript CLI that authenticates with Humble Bundle, inspects your library, and downloads or audits content with caching and optional transformations (such as PDF → CBZ). Its high-level goals are reliable library synchronization, clear CLI UX, and parity with the original Python workflow where feasible.【default】

## Role of AI agents

AI agents are collaborators that may:

- Implement scoped features, fixes, and refactors.
- Add or update tests, documentation, and tooling to support changes.
- Run local checks to validate changes.

AI agents must **not**:

- Change external behavior or CLI UX without explicit user approval.
- Introduce breaking changes to CLI flags, file layout, or cache formats without approval.
- Add network calls, telemetry, or third-party services without approval.

## Coding standards and expectations

### Languages & versions

- Primary language: TypeScript (ESM).【default】
- Runtime: Bun for execution and testing; Node is supported for distributed CLI builds where applicable.【default】
- TypeScript version is defined in `package.json` and should remain authoritative.

### Formatting & linting

- Format with Prettier; keep code aligned with existing formatting rules.
- Lint with ESLint (see `npm run lint` / `bun run lint`).
- Do not introduce new formatting or linting tools without approval.

### Error-handling philosophy

- Favor explicit, user-facing errors with actionable messages.
- Propagate errors with context; avoid swallowing exceptions.
- Fail fast for invalid CLI input; continue gracefully for per-item download issues where safe.

### Testing requirements

- Add or update tests for behavior changes.
- Run `bun test` when code or logic changes are introduced.
- Run `bun run lint` and `bun run format:check` for non-trivial edits when feasible.【default】

## Project structure conventions

- `src/` contains all TypeScript source code.
  - `src/cli/`: CLI entrypoints and argument parsing.
  - `src/config/`: configuration resolution and defaults.
  - `src/auth/`: session/auth handling.
  - `src/api/`: HTTP clients and API helpers.
  - `src/download/`: download orchestration and queueing.
  - `src/utils/`: shared utilities.
- `bin/` holds executable shims for Bun/Node entrypoints.
- `tests/` contains unit/integration tests.
- `README.md` is the user-facing documentation.
- Build output (when generated) belongs in `dist/`.

## Safe-change rules

Changes allowed **without** confirmation:

- Bug fixes that preserve CLI behavior and output.
- Internal refactors that do not alter external behavior.
- Documentation updates, clarifications, or examples.
- Test additions or maintenance.

Changes requiring **explicit user approval**:

- New CLI flags or changes to existing flags/defaults.
- Any change to download paths, cache format, or filesystem layout.
- Network/API behavior changes (new endpoints, authentication shifts).
- Dependency changes that increase footprint or runtime requirements.
- Removal of features, commands, or modules.

## Refactors vs. behavior changes

- Refactors must be behavior-preserving and validated with tests.
- If behavior changes are necessary, call them out early and obtain approval.

## Backward compatibility

- Maintain compatibility with existing CLI options and cache data.
- If a migration is required, provide a safe, reversible plan and obtain approval.

## Performance vs. readability

- Prefer clear, maintainable code unless a performance bottleneck is documented.
- Measure and justify performance optimizations with benchmarks or tests.

## Documentation responsibilities

- Update `README.md` for user-facing changes.
- Add inline comments only when logic is non-obvious; keep comments current.
- Note significant behavior changes in release notes or changelog if one exists.【default】

## When in doubt

1. Follow system/developer/user instructions first.
2. Preserve existing external behavior.
3. Ask for approval before introducing breaking or user-visible changes.
4. Prefer small, well-tested increments.
5. Document assumptions and defaults explicitly.
