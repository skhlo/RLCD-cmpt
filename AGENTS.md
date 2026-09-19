# RLCD-cmpt

A fork of pi-blackhole for cache-first semantic recall using Jev. The current
runtime remains upstream v0.5.5; the new feature is specified, not implemented.
Start with README.md and work_docs/proposals/README.md for the selected design.
The inherited package name is still `pi-blackhole`; changing it or publishing a
release requires a separate task.

## Commands

```bash
pnpm test          # vitest run (no live model requests)
pnpm typecheck     # tsc --noEmit (src/**/*.ts + index.ts only)
pnpm lint          # oxlint .
pnpm format:check  # oxfmt --check .
pnpm build         # tsup bundle → dist/ (gitignored)
pnpm check         # typecheck + lint + format check
```

- CI order: `build` → `typecheck` → `lint` → `test` → `format:check` (.github/workflows/ci.yml).
- Normal commits run lint-staged; normal pushes run typecheck + tests (the hook skips Markdown-only pushes). Preserve these hooks.
- pnpm only (`packageManager: pnpm@11.2.2`). TypeScript pinned to 6.0.3 for @typescript-eslint v8 compat — never bump TS alone (enforced by a dependabot `ignore` rule in `.github/dependabot.yml`).
- Formatting is configured in `.oxfmtrc.json`; lint-staged lives in `package.json`. The original proposal archive is excluded from formatting and must remain byte-identical to its recorded hashes.
- Prepare script (`scripts/prepare.mjs`) builds dist via tsup on install; must never break consumer installs.

## Testing quirks

- Source imports use `.js` extensions (`../om/tokens.js`); vitest's alias strips them. Keep this convention in new files.
- **`tests/` is NOT in tsconfig.json** — running tsc over tests surfaces ~150 pre-existing type errors tracked as a separate cleanup. Do not "fix" test type errors; oxlint covers unused vars there.
- `src/pi-base/**/*.test.ts` is excluded from tsconfig and type-aware lint by design.
- Tests are pure unit tests with fake agent loops — no LLM/network. `tests/vcc-support/real-sessions.ts` optionally samples `~/.pi/agent/sessions`, but nothing requires real data.

## Architecture

- `index.ts` is the extension entry registered by `pi.extensions` in package.json. It installs the host inline-compaction adapter, captures provider streams, and registers consolidation, compaction, commands, and the unified `recall` tool. The build also emits `dist/index.js`; Git installs without dev dependencies can load the source entry directly.
- `src/core/` — unified config (`unified-config.ts` = defaults, parsing, and runtime resolution; env overrides are shared through `config-env.ts`). The settings UI/save path uses ConfigManager in `src/pi-base/blackhole-settings.ts`; keep its validation consistent with the runtime loader.
- `src/extract/` — vcc compaction section extraction (goals, files, commits, preferences, brief).
- `src/om/` — observational memory: `agents/` (observer → reflector → dropper agent loops), `ledger/`, `runtime.ts`, `consolidation.ts`, `compaction-trigger.ts`, `cooldown.ts` (persisted fallback cooldowns), `pending.ts` (manual-mode disk buffers), `inline-compaction.ts`.
- `src/project-recall/` — project-scoped memory: `corpus.ts` (project session scan + pending orphan attribution), `dedup.ts`, `format-export.ts`, `session-dir.ts`.
- `src/hooks/` — `before-compact.ts` (`session_before_compact`), `compact-failed.ts` (`session_compact_failed` pi >=0.84.3), `compaction-context.ts` (`context` append-mode projection).
- `src/commands/` — `pi-vcc.ts` (`/blackhole`), `memory.ts` (`/blackhole-memory`), `vcc-recall.ts` (`/blackhole-recall`), `blackhole-export.ts` (`/blackhole-export`), `cleanup.ts`.
- `src/tools/recall.ts` — session-history search/expand/drill-down.
- `src/pi-base/` — **vendored copy of pi's internal core** (config manager + settings modal). Treat as upstream code: copy verbatim, surgical rewiring only, never rewrite from memory. Changes here also apply to the pi-utils monorepo context.
- `docs/` — committed product docs: `architecture.md`, `observational-memory.md`, `recall.md`, `vcc-compaction.md`, `APPEND_COMPACTION.md`. `docs/archived_docs/` is local-only (gitignored) — working notes, bughunts, handovers.
- `work_docs/` — separate planning - committed and tracked directory.

## Workflow conventions

- `main` is the integration baseline. Work in `feat/`, `fix/`, `chore/`, or `docs/` topic branches and use pull requests. The operator merges; agents never merge a PR or arm auto-merge here.
- Use Conventional Commits. Keep the shared main checkout on `main`; use a separate worktree for each task.
- Imported `dev` and other upstream refs are historical context, not this fork's development workflow. Do not delete remote branches or tags.
- Release/version changes require explicit authorization. The inherited npm publication workflow remains scoped to the upstream repository.
- Runtime docs must agree with current configuration defaults. Historical proposals remain unchanged; the selected proposal and detailed design own their corrections and planned behavior.

## Debugging / runtime

- Develop and test in a normal clone/worktree, not an installed Pi Git-package checkout. Installed source pins and home rollout are coordinated through dotfiles after fixture validation and explicit host approval.
- `debug: true` → pre-compaction snapshot at `/tmp/pi-blackhole-debug.json`; `debugLog: true` → JSONL at `~/.pi/agent/pi-blackhole/debug.ndjson`.
- Config lives at `~/.pi/agent/pi-blackhole/pi-blackhole-config.json`; cooldowns at `pi-blackhole-cooldown.json`. `PI_BLACKHOLE_PASSIVE=true` disables compaction + memory entirely.

## Testing

- **T1. Prove the test fails without the fix.** Run the test against the code before the fix or guard exists, confirm it fails, then confirm it passes after. A console log showing which branch executed is a useful sanity check while writing the test, but red before green is the actual proof. If a test can't fail, it isn't testing anything.
- **T2. Arm every precondition the branch needs.** If the code path depends on prior state (a flag, a prior call, session data), set that state explicitly in the test. Don't assume execution reaches the new guard by default, check what runs before it.
- **T3. Cover every branch, not just the happy path.** Each conditional (if/else, fallback, empty vs populated input) needs its own test case. A theme-present case and a theme-absent case are two tests, not one.
- **T4. Assert the specific thing that would break, not a generic proxy.** A broad negative check, like asserting a substring is absent from the whole output, passes even when an unrelated change happens to introduce that same substring elsewhere. Assert against a stable, unique token or the actual structure.
- **T5. One behavior per test case.** If one assertion in a block throws, every assertion after it silently stops running and its coverage disappears from the failure report. Split sequential checks into separate test cases.
- **T6. Clean up in a finally block or an after-hook, never inline after assertions.** If an assertion throws before cleanup runs, tmp files, mocks, or state leak into the next test run.
- **T7. Don't bypass type or null safety checks to make a test compile.** Non-null assertions, unsafe casts, and untyped escapes (`any` or equivalent) silence the same runtime uncertainty the code under test is supposed to handle. Type the value the way production does and narrow it explicitly.
- **T8. Match mocks to real output shape.** If the real dependency wraps, escapes, or transforms its return value, the mock has to do the same. A stripped-down mock can make a test pass by exercising a code path that never runs in production.

## Agent skills

### Issue tracker

Before reading or publishing issues, PRs, dependencies, or wayfinding updates, read `docs/agents/issue-tracker.md`. The tracker is `skhlo/RLCD-cmpt` on GitHub.

### Triage labels

Before classifying or selecting tickets, read `docs/agents/triage-labels.md`. A `ready-for-agent` ticket is actionable only after all its native blockers are complete.

### Domain docs

Before design, implementation, or architectural review, read `CONTEXT.md` and `docs/agents/domain.md`, plus any relevant ADRs. This repository has one context; ADRs are created only when a decision warrants one.
