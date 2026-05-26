# Deep Review Report

Date: 2026-05-25
Reviewer: Codex
Scope: `src/**`, `scripts/smoke-test.ts`, tests, runtime/build scripts

## Findings

### High: Build artifact path inconsistency could mask runtime failures (Fixed)

- Location: `package.json` scripts (`start`) and `scripts/smoke-test.ts` spawn path
- Issue: Build output layout changed to `dist/src/index.js` (because `rootDir: "."`), but runtime references still pointed at `dist/index.js`.
- Impact: A stale `dist/index.js` could make smoke/start appear healthy while running outdated code.
- Fix applied:
  - `start` now uses `node dist/src/index.js`
  - smoke script now spawns `dist/src/index.js`
  - `build` now runs `clean` first (`rm -rf dist`) to prevent stale artifacts

### Medium: Tool-handler integration tests are still limited (Partially fixed)

- Location: `test/hyprland.test.ts`
- Previous issue: tests covered only numeric clamp and PNG parsing.
- Improvement applied:
  - added tests for monitor-bound absolute clamping
  - added tests for structured error formatting behavior
  - added tests for window query filtering (`window_find` primitive)
- Remaining gap:
  - no isolated tests yet for full dispatcher command strings inside each MCP tool handler
  - no mocked MCP-level tests for `window_get`/`window_find` response contracts
  - no automated assertion yet for workspace-restore timing around screenshot capture

### Medium: Absolute move/resize bounds were global only (Fixed)

- Location: `src/index.ts`, `src/lib/hyprland.ts`
- Issue: values were clamped to broad global ranges, not monitor dimensions.
- Fix applied:
  - absolute move clamps to monitor coordinate bounds
  - absolute resize clamps to monitor width/height

### Low: Error taxonomy was message-only (Fixed)

- Location: `src/lib/hyprland.ts`, `src/lib/screenshot.ts`, `src/index.ts`
- Issue: failures had no stable code prefix.
- Fix applied:
  - introduced `HyprlandError` with codes
  - standardized formatted error shape (`[CODE] message`)

## Review Strengths

- Tool scope is intentionally narrow and safety-oriented.
- Uses `execFile` with argument arrays (no shell interpolation).
- Validates window IDs and blocks hidden/unmapped window actions.
- Auto-discovers working Hyprland socket and handles stale env signatures.
- Mutating calls are audited to append-only JSONL.
- Dry-run mode is practical and integrated into smoke workflow.

## Validation Performed

- Type check: `npx tsc -p tsconfig.json`
- Unit tests: `npx vitest run`
- Smoke test: `node dist/scripts/smoke-test.js`

## Residual Risk Summary

- Primary residual risk is still integration coverage depth in live compositor edge cases.
- Runtime behavior depends on live Hyprland state and external binaries (`hyprctl`, `grim`), so hermetic CI remains limited without mocking.
