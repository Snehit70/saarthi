---
name: saarthi-computer-use
description: Use when controlling the local Hyprland desktop through the saarthi CLI, including browser, tmux, window/workspace, screenshot, accessibility, OCR, grid, mouse, keyboard, and verified real-screen interaction.
---

# Saarthi Computer Use

Use the `saarthi` CLI for local desktop work. The objective is reliable, verified interaction, not the fastest possible click sequence.

## Start A Run

Saarthi is a stateless CLI. Export one session id before the first command so audit and trace events from separate invocations stay grouped:

```bash
export SAARTHI_SESSION_ID="${SAARTHI_SESSION_ID:-agent-$(date +%s)}"
saarthi --help
```

Discover commands on demand instead of guessing flags:

```bash
saarthi window --help
saarthi window find --help
```

Commands use `saarthi <noun> <verb>`. Use human output for direct inspection and `--json` for scripts:

```bash
saarthi window list
saarthi window list --json | jq '.windows[] | {id, class, title}'
```

Only result data is written to stdout. Errors are written to stderr. Branch on the exit status, not error text:

```bash
if result=$(saarthi window get 0xABC --json); then
  printf '%s\n' "$result" | jq .window
else
  code=$?
  printf 'window lookup failed (exit %s)\n' "$code" >&2
fi
```

## Overlay Lifecycle

Bookend every desktop task. Overlay task state persists across separate CLI invocations:

```bash
saarthi overlay task-start --label "review desktop"
saarthi overlay task-ping --state waiting
saarthi overlay task-complete --status done
```

Use `error` or `timeout` on failure. Completion is mandatory before handing the turn back when the task will not resume.

The eyes overlay is the only persistent Saarthi user service. Do not create or start an MCP service.

```bash
systemctl --user restart saarthi-overlay.service
systemctl --user status saarthi-overlay.service --no-pager
journalctl --user -u saarthi-overlay.service -n 100 --no-pager
```

## Screenshot Rule

Screenshot and grid commands return a PNG path, not inline image data. Always inspect the returned file before using it as evidence:

```bash
path=$(saarthi screenshot capture --target full --json | jq -r .path)
# Read/view $path with the agent's image-reading capability before acting.
```

Never report a screenshot as inspected merely because capture succeeded. Capture and visual inspection are separate steps.

## Core Loop

1. Focus or identify the target window.
2. Capture and inspect the current screen.
3. Prefer accessibility coordinates; fall back to grid, OCR, or window metadata.
4. Wait for dynamic UI to settle.
5. Act once.
6. Verify the resulting state before continuing.

Example discovery sequence:

```bash
saarthi observability desktop-health --json
saarthi window find --class-contains zen --limit 5 --json
saarthi window focus 0xABC --json
saarthi observe wait-for-stable --target window --window-id 0xABC --json
saarthi ui find --name-contains Submit --interactive --json
```

Prefer a concrete `windowId` over `active_window` during multi-step work to prevent focus drift. Validate any window id against a fresh `saarthi window list --json` before a mutating command.

## Consent

Reversible actions are free: focus, navigate, search, scroll, inspect, open menus, and type into a field.

Ask for explicit confirmation immediately before:

1. Sending or dispatching a message.
2. Posting, publishing, replying, or submitting a form.
3. Deleting, archiving, clearing, removing, or blocking data.
4. Buying, paying, or confirming a financial transaction.

Approval covers one action unless the user explicitly broadens it. Enter in a URL bar is navigation; Enter in a message composer is a send and is gated.

## Targeting Order

Use this order for GUI work:

1. `saarthi window find/get/focus` and `saarthi workspace topology`.
2. `saarthi observe wait-for-stable` after launch or navigation.
3. `saarthi ui find/tree` for addressable accessibility elements.
4. `saarthi screenshot capture`, then inspect the returned path.
5. `saarthi grid show` or `saarthi text find` when accessibility is unavailable.
6. `saarthi mouse move/click/drag` or `saarthi grid click` for the action.
7. `saarthi observe screenshot-compare` or `wait-for-text` for verification.

Accessibility coordinates expire after scrolling, waiting, navigation, or relayout. Re-run `saarthi ui find` immediately before clicking if the screen could have changed.

## Grid Workflow

Grid sessions persist across commands under `~/.local/state/saarthi/`:

```bash
grid_path=$(saarthi grid show --target window --window-id 0xABC --json | jq -r .gridPath)
# Read/view $grid_path before choosing a cell.
saarthi grid cell-to-point 14 --json
saarthi grid move 14 --json
saarthi mouse verify-in-view --target window --window-id 0xABC --json
saarthi grid click 14 --json
saarthi grid hide --json
```

Use a coarse grid first. Regenerate with more rows/columns instead of guessing within a large cell. Always hide the session when it is no longer needed.

## Input And Verification

```bash
saarthi input key-press --key escape --json
saarthi input type --text "query" --sensitive --json
saarthi mouse click --target full --x 100 --y 200 --json
saarthi observe wait-for-text --query "Loaded" --mode appear --json
```

Set `--sensitive` when typing secrets so status labels redact content. A timeout or `{stable:false}`/`{ok:false}` is not success; capture evidence and use one alternate targeting method before stopping.

## Terminal Control

Use tmux commands for terminal work instead of screenshots or GUI typing:

```bash
saarthi tmux list --json
saarthi tmux capture --target saarthi:1.1 --json
saarthi tmux run-command --target saarthi:1.1 --command "git status --short" --json
saarthi tmux send-keys --target saarthi:1.1 --keys Escape --no-literal --json
```

Rules:

- Target a named session/pane. Never guess after `TMUX_TARGET_NOT_FOUND` or `TMUX_TARGET_AMBIGUOUS`.
- Reads are free. Confirm mutating shell commands under the same consent rules.
- `TMUX_PANE_BUSY` requires user confirmation before retrying with `--confirm-busy`.
- Branch on the returned command `exitCode`; output text is not proof of success.
- Do not create or kill tmux sessions, windows, or panes.

## Browsers

Discover the actual session before choosing a browser:

```bash
saarthi browser discover --json
saarthi browser focus --browser helium --json
saarthi browser open-url https://example.com --browser firefox --json
saarthi browser action --window-id 0xABC --action next-tab --json
saarthi browser action --window-id 0xABC --action find --query "Sign in" --json
```

Supported identities are Zen, Firefox, LibreWolf, Floorp, Helium, Chromium, Chrome, Brave, Vivaldi, and Edge. Automatic selection prefers the focused browser, then a single running identity. Specify a browser or exact window when matches are ambiguous. A running browser can be reused even if its launcher is unavailable. Actual launches still require policy approval and a launch slot.

Use existing browser profiles for host browser work. Do not change their preferences or inspect credentials. An explicitly requested isolated desktop uses its own fresh automation profiles through `desktop launch`; never attach these to the host profile. Zen workspace stepping remains Zen-only and uses configured shortcuts.

Use accessibility when available, then OCR/grid. Phrase OCR supports labels such as "Sign in" on the same line. Check the actual screenshot before choosing a query. Empty AT-SPI page results are a routing signal, not evidence that the page has no controls.

For a configured Vimium extension, `browser vimium-hint --visible-text` sends an observed hint label. `--no-commit` opens hints without typing. The command never appends Enter, because some Vimium modes activate as soon as a label matches. Confirm gated action kinds before sending hint text, then verify the resulting state. If a filtering mode needs Enter, inspect first and send it as a separate explicitly targeted keypress.

Title readiness is only a heuristic. URL opening exits `17` on readiness timeout even when navigation may already have occurred. Inspect before retrying to avoid duplicate tabs or repeated actions. `browser action` and Vimium return `verificationRequired`; verify with page accessibility, OCR, or a fresh screenshot.

The `input` commands send global foreground input, including across different Hyprland workspaces. Use the separate `desktop` commands for independent native input. Set `--window-id` on `input type` and `input key-press` to reject focus drift. Focus checks reduce accidental input but do not provide background isolation or an atomic transaction with the compositor.

## Hyprland Adapter Safety

This machine uses Hyprland 0.55+ Lua dispatcher semantics. Keep dispatcher construction in `src/lib/hyprland.ts`, use `execFile` argument arrays, and treat stdout beginning with `error:` as failure even when `hyprctl` exits zero.

Never bypass Saarthi launch policy with handwritten shell dispatches. All app launches must pass `config/policy.json` alias, deny, and persisted rate-limit checks.

## Recovery

- Focus drift: revalidate the id, focus it, and inspect a new screenshot.
- Stale coordinates: re-run accessibility/OCR/grid discovery.
- Modal or context menu: press Escape once, then verify it closed.
- No state change: try exactly one alternate targeting method and verify again.
- Ambiguous OCR: do not act until a unique region-safe anchor exists.
- Unsettled UI: wait for stable/text and recapture.

Use these failure labels when reporting evidence: `focus_drift`, `cursor_out_of_view`, `ocr_ambiguous`, `a11y_unavailable`, `wrong_hotspot`, `state_not_changed`, `not_settled`, and `verification_failed`. `a11y_unavailable` is a routing signal, not a terminal failure.

## Evidence

For non-trivial tasks report the target window id, baseline screenshot path, accessibility/OCR/grid anchor used, final verification screenshot path, and whether the final action was performed or only prepared. Use `saarthi observability session-trace-export --json` and `logs/actions/run.jsonl` for diagnosis.

## Semantic actions and image history

Prefer `ui act --window-id ID --name EXACT --role text --action set-text --text VALUE` for verifiable replacement, and `ui read-text` for exact readback. Do not use password fields. A selector must identify one current enabled on-screen element. `ui find/tree --window-id ID` scopes traversal and translates frame-relative positions into screen coordinates.

For “paste the last four images here only”, identify and focus the exact destination first. Run `clipboard images --limit 4` for metadata, then `clipboard paste-images --window-id ID --target-name EXACT --count 4`. The destination must expose a uniquely named focused editable field. The command skips text entries and never presses Enter. Inspect the resulting attachment list and count before claiming success. With inaccessible browser composers, export images and use the native file chooser, then verify attachments. Do not substitute a guessed field.

The preferred original clipboard MIME is restored, including an empty selection. Other MIME representations are not preserved; history watchers may record temporary images. If a user copies new content during the operation, the command stops and keeps that new selection. Keep exported files and entered text out of public logs and PRs.

For repeated semantic work, a private JSON plan passed to `ui batch --window-id ID --steps-file PATH` reduces process overhead. Maximum 20 steps; every target is re-resolved and every text write checked. On a partial failure inspect completed work before constructing a new plan. Never replay the entire batch blindly.

Exit 18 means another Saarthi process owns desktop input. Wait for that operation to finish and inspect before retrying. The input lease releases on owner death; it does not protect against the user's keyboard or unrelated automation.

After an accessibility invocation, treat `verificationRequired` literally. A successful advertised button action can precede its UI effect. Observe the expected task identity, saved count, or next-record identity before editing subsequent records. If a bounded wait ends with unchanged state, fail and inspect; do not continue using the previous task's data.

## Background work and planning ahead

Prefer non-disruptive operations when the user wants to keep working. `screenshot capture --target window --window-id ID` uses native surface capture by default, even on an inactive workspace. `screenshot workspace --workspace 4 --json` returns a private set of window PNGs and positions. View every screenshot you rely on. This is not an exact composited workspace scene. Missing capture support must fail without focusing; use `--allow-focus` only when foreground disruption is explicitly acceptable.

`app launch-and-wait --app-name ALIAS --workspace 4` uses a silent launch rule by default. Verify the returned window and workspace, because applications can reuse existing windows. Ordinary keyboard, pointer and foreground accessibility actions still share the user's seat. Do not promise input isolation merely because a window is on another workspace.

For browser work without global input, use the optional existing Open Browser Use connection:

1. Inspect `open-browser-use profiles --connected` and select the task's actual browser/profile. Saarthi does not start or install a browser bridge.
2. Use explicit `--browser-target`, `--profile` and a unique `--session-id` for `browser background-open/tabs/act/finish`. These commands control only their session's owned tabs. They never claim unrelated user tabs.
3. Use a private, user-owned `chmod 600` JSON step file with `tabId`, exact `expectedUrl` and `action:"inspect"`. Inspect returns current control selectors. Resolve selectors again after navigation or layout changes. Password fields are unsupported.
4. Choose `fill`, `click`, `read`, `files`, `wait-text` or `screenshot` using observed targets. `files` accepts explicit local paths, stages bounded file bytes, and attaches them without opening a native dialog or changing extension permissions. Hidden file inputs are supported. Verify the application's actual attachment list afterward; file-list readback is not server upload completion.
5. Capture the owned background tab with a browser `screenshot` step. A native browser-window screenshot shows its physically selected tab, which can differ from the task's logical active tab.
6. Finish with `browser background-finish`; keep owned tab ids only for a requested live handoff. Never close or move unrelated user tabs.

Before a predictable sequence, plan 4–10 steps ahead based on current observations. Put the plan in a private JSON file and use `plan run --plan-file PATH`. Include an explicit owned tab allowlist and a browser connection. Native capture steps additionally declare window id, PID and allowed workspace. The executor supports browser actions and native capture, without global keyboard/mouse actions. Browser tab ownership does not establish the containing Hyprland workspace.

Every browser mutation must immediately precede a same-tab `wait-text` checkpoint or a `read` checkpoint with `expectText`. Use checks that establish actual task progress, such as attachment names, saved indicators, next-record identity or the requested result. Pause planning at unknown navigation, permission, native-dialog or layout boundaries. Do not fill a plan with guesses to reach the minimum step count. Use a single background action when fewer than four steps are justified.

The plan shares one browser connection and session lease, checks scope throughout, records durable progress before each operation and stops on the first failure. An existing plan id always refuses execution. Inspect the reported completed count, in-flight step and actual page; prepare a new id with only remaining work. Never blindly replay a completed or uncertain action. Confirmation fields require existing user authorization under the consent rules above.

Examples and the full schema are in `docs/BACKGROUND-WORK.md`. Cross-origin frames, shadow-root selectors, trusted native events and system permission dialogs may require another supported workflow. Keep private plans, entered text, attachments and page output out of public logs and PRs.

## Independent native desktop

For native tasks that must run while the user keeps typing or moving their mouse,
use `desktop start`. This launches a private headless Sway desktop with a separate
seat. A hidden Hyprland workspace alone does not provide this isolation.

1. Start one desktop only when needed, then keep its returned id. Inspect existing
   task state before creating another. At most three desktops may run.
2. Launch policy aliases through `desktop launch --desktop-id ID --app-name APP`.
   Apps must start inside the private desktop. Existing host windows cannot move
   into it. Private browser profiles do not inherit logins or extensions.
3. Read `desktop status` and view `desktop capture`. Its integer window ids belong
   to the private Sway tree and must never be passed to host Hyprland commands.
4. Write 1 to 10 typed actions to a private mode-600 JSON file. Each action requires
   the current private window id and exact PID. Run `desktop input --desktop-id ID
   --actions-file PATH`. Use observed coordinates and verify actual app state.
5. For native file pickers, inspect again after opening the dialog. Use its new
   window id and PID, Ctrl+L, the requested absolute path and an explicit navigation
   Enter. Verify selected filenames or attachments after the picker closes.
6. Stop on unknown state or partial failure. Inspect the uncertain action before
   preparing the remaining batch. A successful receipt proves dispatch, not task
   completion. Do not automatically replay a failed batch.
7. Save requested artifacts, then call `desktop stop` when finished. This closes
   session-owned apps, bus, compositor and device clients. Never signal host apps.

The latest keyboard client stays alive until its replacement is active, with no
command listener. If it dies, stop and recreate the desktop. No input falls back
to the host. Different desktops use separate input leases. They share the user's
filesystem, so this is not a security sandbox. Software rendering and Wayland-only
apps limit compatibility. Use the existing background browser adapter for logged-in
tab tasks. Full schemas and limitations: `docs/ISOLATED-DESKTOP.md`.
