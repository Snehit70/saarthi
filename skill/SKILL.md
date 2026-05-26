---
name: saarthi-computer-use
description: Use when controlling the local Hyprland desktop through the saarthi server, especially browser, WhatsApp Web, PDF viewer, window/workspace, screenshot, OCR, grid, mouse, and keyboard tasks that require verified real-screen interaction.
---

# saarthi Computer Use

Use this skill for real desktop work through the `saarthi` MCP server. The goal is reliable interaction, not fastest possible clicking.

## Core Rule

Every meaningful action must be grounded in the current screen:

1. focus the target window
2. take or inspect a screenshot
3. choose a target using grid/OCR/window metadata
4. move or click
5. verify the resulting state before the next action

Do not type, send, delete, archive, block, clear, or navigate away unless the current state proves the target is correct.

## Preferred Tool Order

1. `desktop_health`, `window_find`, `window_get`, `window_focus`
2. `workspace_topology` when task depends on monitor columns/left-right workspace placement
3. `workspace_focus_relative` for deterministic left/right column hops (`createIfAbsent=true` when a monitor has no workspace)
4. `window_focus_best` when `window_find` has multiple candidates
5. `desktop_screenshot_save`
6. `grid_show` for visual targeting, or `find_text_on_screen` for text discovery
7. `grid_cell_rect` for deterministic region bounds, then `desktop_screenshot_area` when you need stable cropped verification
8. `grid_cell_to_point`, `grid_move`, `mouse_verify_in_view`
9. `grid_click` or `mouse_click`
10. `desktop_screenshot_save` or OCR verification
11. `type_text` / `window_focus_and_type` only after target state is verified

Prefer `target: "window"` with a concrete `windowId` over `active_window` for multi-step work. This avoids focus drift.

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

OCR is a hint, not proof.

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
- `wrong_hotspot`: click opened a menu or wrong control
- `state_not_changed`: click landed but expected UI did not change
- `verification_failed`: expected text/header/input state not found

## Run Evidence

For non-trivial tasks, report:

- target window id
- baseline screenshot path
- key grid cells or OCR anchors used
- final verification screenshot path
- whether the final action was sent/performed or only prepared

Check `logs/actions/run.jsonl` when diagnosing repeated failures.
