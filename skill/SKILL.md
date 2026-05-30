---
name: saarthi-computer-use
description: Use when controlling the local Hyprland desktop through the saarthi server, especially browser, WhatsApp Web, PDF viewer, window/workspace, screenshot, accessibility-tree (ui_find), OCR, grid, mouse (click/drag), keyboard, and wait/verify tasks that require verified real-screen interaction.
---

# saarthi Computer Use

Use this skill for real desktop work through the `saarthi` MCP server. The goal is reliable interaction, not fastest possible clicking.

## Server and Overlay Control

The Saarthi MCP server is stdio-only and belongs to the current MCP host/client
session. Do not start or restart `saarthi-mcp.service`; if it exists, disable it.
Use MCP tools directly after the client starts the stdio server.

The eyes overlay HUD is the only persistent user service:

```bash
systemctl --user restart saarthi-overlay.service
systemctl --user status saarthi-overlay.service --no-pager
journalctl --user -u saarthi-overlay.service -n 100 --no-pager
```

If the overlay service is not installed yet:

```bash
/home/snehit/projects/saarthi/scripts/install-overlay-service.sh
```

Cleanup for the old invalid MCP service:

```bash
systemctl --user disable --now saarthi-mcp.service || true
rm -f ~/.config/systemd/user/saarthi-mcp.service
systemctl --user daemon-reload
```

## Core Rule

Every meaningful action must be grounded in the current screen:

1. focus the target window
2. take or inspect a screenshot
3. choose a target — prefer the accessibility tree (`ui_find`) for exact, addressable elements; fall back to grid/OCR/window metadata
4. let the UI settle (`wait_for_stable` / `wait_for_text`) when it may still be loading or animating
5. move or click
6. verify the resulting state before the next action (`screenshot_compare`, OCR, or `ui_find`)

Do not type, send, delete, archive, block, clear, or navigate away unless the current state proves the target is correct.

## Preferred Tool Order

1. `desktop_health`, `window_find`, `window_get`, `window_focus`
2. `workspace_topology` when task depends on monitor columns/left-right workspace placement
3. `workspace_focus_relative` for deterministic left/right column hops (`createIfAbsent=true` when a monitor has no workspace)
4. `window_focus_best` when `window_find` has multiple candidates
5. `wait_for_stable` after launching/navigating, before inspecting
6. `ui_find` first — exact element targets with clickable `cx,cy` (use when the app exposes accessibility)
7. `desktop_screenshot_save`, then `grid_show` / `find_text_on_screen` when accessibility is unavailable (browsers, Electron, canvas)
8. `grid_cell_rect` for deterministic region bounds, then `desktop_screenshot_area` when you need stable cropped verification
9. `grid_cell_to_point`, `grid_move`, `mouse_verify_in_view`
10. `mouse_click` (with `ui_find` center, `target: "full"`), `grid_click`, `click_text`, or `mouse_drag` for sliders/selections
11. `action_step` for atomic verify loops when action certainty is critical
12. `screenshot_compare` / `wait_for_text` / OCR verification
13. `type_text` / `window_focus_and_type` only after target state is verified (`sensitive: true` for secrets)

Prefer `target: "window"` with a concrete `windowId` over `active_window` for multi-step work. This avoids focus drift.

## Accessibility-First Targeting

When the target app exposes the accessibility tree, `ui_find` beats OCR and grid:

1. `ui_find` with `nameContains` / `role` (and `interactive: true`) scoped to the focused app.
2. Read the matched element's `cx,cy` (screen coordinates) and `states` (e.g. `sensitive`/`enabled`).
3. Click with `mouse_click` `target: "full"`, `x=cx`, `y=cy`.
4. Use `ui_tree` to understand an unfamiliar UI before acting.

Coverage is toolkit-dependent: GTK/Qt and most native apps expose a usable tree; Chromium/Electron and Firefox expose content only with accessibility enabled. If `ui_find` returns nothing meaningful, fall back to grid/OCR.

## Verification and Settling

- After launching/navigating, call `wait_for_stable` (target the window) so you act on a settled frame, not a half-loaded one.
- Use `wait_for_text` (`mode: "appear"`) to block until expected content shows, or `"disappear"` to confirm a spinner/dialog cleared.
- To prove an action changed something, capture a baseline, act, then `screenshot_compare` (or `action_step` which does before/after + verify in one call).

## Input Primitives

- Double/triple click: `mouse_click` with `clickCount`.
- Sliders, selections, drag-and-drop: `mouse_drag` (both endpoints relative to the same target).
- Hover/motion-driven UIs: `mouse_move` with `smooth: true` so the cursor glides and fires motion events.
- Typing secrets (passwords): `type_text` / `window_focus_and_type` with `sensitive: true` so the value is masked in the status overlay.

## Grid Workflow

Use grid targeting when the UI is visually dense or OCR is ambiguous.

1. Run `grid_show` on the target window.
2. Inspect the overlay image path.
3. Pick the cell center closest to the intended UI element.
4. Run `grid_cell_rect` if you want exact region bounds and cropped screenshot verification.
5. Run `desktop_screenshot_area` with that rectangle when region proof matters.
6. Run `grid_cell_to_point` if you need exact cursor coordinates.
7. Run `grid_move`.
8. Run `mouse_verify_in_view`.
9. Run `grid_click`.
10. Verify with screenshot or OCR.
11. Run `grid_hide` when the grid session is no longer useful.

Use coarse grid first. If the cell is too large, call `grid_show` again with higher `cols`/`rows` rather than guessing inside a large cell.

## OCR Policy

OCR is a hint, not proof. Prefer `ui_find` when the app exposes accessibility; reach for OCR when it does not.

- Use OCR to locate candidate text.
- Verify the match is in the expected region.
- Avoid acting on text if the same label can appear in multiple places.
- Prefer partial tokens for discovery (`CODE`, `TEJAS`) but verify final state with stronger anchors (header title, input placeholder, selected row).
- For non-fullscreen targets, use tools that convert target-relative coordinates internally (`click_text`, `mouse_move_to_text`) or grid tools.

## Browser and WhatsApp Web

Before messaging:

1. focus the browser window with `window_focus`
2. confirm WhatsApp is loaded with screenshot or OCR
3. select the chat/group
4. verify the right-pane header matches the intended chat/group
5. click the composer
6. type the message
7. send only if the user explicitly allowed sending in this turn
8. verify the message appears and the composer is clear

For WhatsApp chat selection:

- Use left-list grid cells or OCR anchors for the row.
- Avoid row-right icons for mute/pin/menu.
- If a context menu opens, press `escape`, verify it closed, and retry with a safer row/title/left-side cell.
- Do not type into the composer if the right header is wrong.

## Send Policy

Default behavior is prepare-only:

- type message
- stop before send
- report screenshot path

Only click send or press Enter when the user explicitly says sending is allowed. After sending, verify with a screenshot that the outgoing message is visible.

## Recovery Rules

- If focus drifts: `window_focus` the known `windowId`, then screenshot.
- If cursor might be off-target: `mouse_verify_in_view`.
- If a modal/context menu appears: `key_press` `escape`, then screenshot.
- If a click does not change state: do not repeat the same point. Use grid/OCR to choose a different target.
- If URL bar/sidebar search traps input: click page content or use `escape`, then re-focus the address/page target.

## Failure Taxonomy

Use these labels when reporting a blocked action:

- `focus_drift`: target window lost focus
- `cursor_out_of_view`: pointer outside target bounds
- `ocr_ambiguous`: text match is not unique or not region-safe
- `a11y_unavailable`: app exposes no useful accessibility tree (fell back to grid/OCR)
- `wrong_hotspot`: click opened a menu or wrong control
- `state_not_changed`: click landed but expected UI did not change (confirm with `screenshot_compare`)
- `not_settled`: acted before the UI stabilised (`wait_for_stable`/`wait_for_text` would have helped)
- `verification_failed`: expected text/header/input state not found

## Run Evidence

For non-trivial tasks, report:

- target window id
- baseline screenshot path
- key grid cells or OCR anchors used
- final verification screenshot path
- whether the final action was sent/performed or only prepared

Check `logs/actions/run.jsonl` when diagnosing repeated failures.
