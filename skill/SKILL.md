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

## Zen Browser

Start with live discovery:

```bash
saarthi browser discover --json
saarthi browser focus --title-contains Zen --json
saarthi browser open-url --url https://example.com --readiness title-change --json
```

Use the existing local Zen profile so authentication, containers, and extensions remain intact. Do not attach a second automation engine, modify browser settings, inspect stored credentials, or create a clean profile for user-facing work.

For page targeting, prefer `saarthi browser vimium-hint`; use `saarthi ui find` if accessibility is available, then OCR/grid. Browser chrome should use browser commands, shortcuts, or verified grid coordinates rather than Vimium.

Current machine facts that must still be rediscovered when relevant:

- Zen is the Flatpak app `app.zen_browser.zen`.
- Vertical tabs are on the right and the URL bar floats.
- Page AT-SPI has historically been unavailable; verify before relying on it.

Do not act on page content when `browser open-url` returns `readiness.ready:false`. Wait for a strong page anchor or inspect a fresh screenshot first.

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
