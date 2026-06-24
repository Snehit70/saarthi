# Next Feature Roadmap

## Goal

Evolve `saarthi` from a solid primitive set into a reliable agentic desktop-control layer that can:

1. discover targets robustly
2. act safely with predictable outcomes
3. verify outcomes automatically
4. recover from failures without user babysitting

This roadmap is ordered by practical impact and implementation risk.

## Current Baseline

Already available:

- window discovery/query (`window_list`, `window_find`, `window_get`)
- workspace/window actions (`workspace_focus`, `window_focus`, `window_move`, `window_resize`, `window_send_to_workspace`)
- app workflow primitives (`app_list`, `app_launch`, `workspace_list`, `workspace_pick_empty`)
- screenshot capture (`desktop_screenshot`, `desktop_screenshot_save`) with workspace-aware window capture
- dry-run mode + audit logging

## Priority 1: Reliability Primitives

### 1. `window_wait_for`

Purpose:

- Wait until a window matching query appears (for app launch or delayed startup).

Inputs:

- query fields from `window_find`
- `timeoutMs` (default 10000)
- `pollMs` (default 200)

Output:

- matched window object, or timeout error code

Why next:

- removes race conditions after `app_launch`
- enables robust chains like launch -> wait -> focus -> screenshot

### 2. `app_launch_and_wait`

Purpose:

- Launch app and wait for a matching window in one safe workflow.

Inputs:

- `appName` or `command`
- optional workspace preferences
- wait query (`classContains`, `titleContains`, etc.)

Output:

- launched command + matched window id + workspace

Why next:

- common workflow abstraction without removing primitive control

### 3. `tool_call_timeout` + retry policy

Purpose:

- Standardized retry for transient compositor races.

Behavior:

- add bounded retries for dispatch/read calls where idempotent
- include `attempts` in structured response metadata

Why next:

- improves stability under workspace switches and app startup jitter

## Priority 2: Verification and Observability

### 4. `action_verify_window_state`

Purpose:

- Verify that focus/move/resize/send actually applied.

Inputs:

- expected window id + expected state subset
- tolerance for coordinates/sizes

Output:

- pass/fail + diff

Why next:

- converts “command succeeded” into “state succeeded”

### 5. Enhanced audit model

Add fields:

- `requestId`
- `tool`
- `beforeState` and `afterState` snapshots (small)
- `durationMs`
- `result` (`ok`/`error`)
- `errorCode`

Why next:

- stronger incident debugging and replay

### 6. `session_trace_export`

Purpose:

- Export recent action history for debugging or review.

Inputs:

- `since` timestamp or `lastN`

Output:

- path to exported JSON file

## Priority 3: Safer Command Surface

### 7. Command policy config

Create config file:

- `/home/snehit/projects/saarthi/config/policy.json`

Policy sections:

- allowed app aliases
- denied commands/patterns
- max launch frequency
- workspace range defaults

Why next:

- moves safety policy from code constants to controlled config

### 8. Strict parser for launch commands

Current state:

- sanitization blocks dangerous shell chars

Next step:

- parse into executable + args token model
- disallow unsupported token forms
- eliminate ambiguous shell expansion paths

## Priority 4: Better Desktop Intelligence

### 9. `window_rank_candidates`

Purpose:

- score multiple matches to pick best target.

Signals:

- focused status
- visible workspace proximity
- title exactness
- recency

Why next:

- improves “find app” reliability when many windows match

### 10. `desktop_snapshot`

Purpose:

- compact state snapshot for planning.

Includes:

- focused workspace
- monitor/workspace map
- top windows per workspace
- running known app aliases (best effort)

Why next:

- helps agents decide before acting

## Priority 5: UX/Quality Features

### 11. `desktop_screenshot_compare`

Purpose:

- compare two screenshots to confirm change happened.

Outputs:

- diff score
- optional diff image path

### 12. app registry management tools

Tools:

- `app_registry_list`
- `app_registry_add`
- `app_registry_remove`

Backed by:

- project-local registry file with names + one-line descriptions + commands

Why next:

- keeps `app_list` clear and user-managed over time

## Recommended Implementation Sequence

1. `window_wait_for`
2. `app_launch_and_wait`
3. `action_verify_window_state`
4. enhanced audit fields
5. policy config
6. window ranking
7. screenshot compare
8. app registry management

This sequence gives maximum reliability first, then safety, then intelligence.

## Test Strategy For Next Phase

For each new tool:

1. unit tests for schema and pure helpers
2. mocked adapter tests for success/failure branches
3. one scenario in `scripts/cli-smoke.ts` (dry-run where needed)
4. one live manual validation recipe in `docs/OPERATIONS.md`

## Recommended First Sprint (Concrete)

Deliver in first sprint:

- `window_wait_for`
- `app_launch_and_wait`
- `action_verify_window_state` (focus + workspace + geometry checks)
- audit enrichment (`durationMs`, `errorCode`, `result`)

Acceptance:

- Launch app into empty workspace, wait for window, focus it, capture saved screenshot, verify state, and return deterministic structured outputs without manual retries.
