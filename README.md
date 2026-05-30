# saarthi

Local MCP server for Hyprland window/workspace control, screenshots, and basic UI automation primitives.

## Scope (v1)

- `app_list`
- `desktop_health`
- `metrics_report`
- `session_trace_export`
- `desktop_screenshot`
- `desktop_screenshot_save`
- `desktop_screenshot_area`
- `workspace_list`
- `workspace_topology`
- `workspace_pick_empty`
- `app_launch`
- `window_wait_for`
- `app_launch_and_wait`
- `action_verify_window_state`
- `type_text`
- `window_focus_and_type`
- `window_list`
- `window_get`
- `window_find`
- `window_focus_best`
- `window_focus`
- `window_move`
- `window_resize`
- `workspace_focus`
- `workspace_focus_relative`
- `window_send_to_workspace`
- `key_press`
- `mouse_get_position`
- `mouse_verify_in_view`
- `grid_show`
- `grid_cell_to_point`
- `grid_cell_rect`
- `grid_move`
- `grid_click`
- `grid_hide`
- `resolve_text_point`
- `mouse_move_to_text`
- `click_text`
- `mouse_move`
- `mouse_click`
- `mouse_scroll`
- `find_text_on_screen`
- `click_wait_retry`
- `action_step`

No shell execution, clipboard, or remote transport.

## Requirements

- Linux Wayland session with Hyprland
- `hyprctl`
- `grim`
- `wtype` (for `type_text`)
- `tesseract` (for `find_text_on_screen`)
- `ydotool` (for `mouse_click` / reliable focus-recovery)
- `ImageMagick` (`magick`, for `grid_show`)
- Node 20+
- `pnpm`

## Install

```bash
pnpm install
```

## Run (stdio)

```bash
pnpm dev
```

For mouse primitives (`mouse_move`, `mouse_click`, `mouse_scroll`), ensure `ydotool.service` is active and user-accessible socket is configured.  
`mouse_move`/`mouse_click` now accept `target` (`full|monitor|active_window|window`) so you can pass relative coordinates directly.
See `docs/OPERATIONS.md` for exact Fedora override steps.

## Skill

Use the repo skill playbook at `skill/SKILL.md` for strict computer-use execution loops (focus lock, screenshot verification gates, and failure taxonomy).

## Overlay HUD (optional)

A small always-on-top HUD that pops up in the top-right while saarthi is acting,
with animated "thinking" eyes, the current action, and a live feed of recent
steps. The server emits a status feed to `~/.local/state/saarthi/status.json`
on every tool call (disable with `SAARTHI_STATUS=0`); a separate Wayland
layer-shell process renders it.

```bash
overlay/saarthi-overlay          # live
overlay/saarthi-overlay --demo   # standalone visual demo
```

See `overlay/README.md` for the status contract, requirements, and Hyprland autostart.

## Safety

- Uses current user session only.
- Auto-discovers active Hyprland socket under `/run/user/$UID/hypr`.
- Validates window ids before mutating actions.
- Enforces launch policy from `config/policy.json` (allowed aliases, denied patterns, rate limit, workspace bounds).
- Writes mutating call audits to `~/.local/state/saarthi/audit.jsonl`.
- Writes repo-local action traces to `logs/actions/run.jsonl` for post-run analysis.
- Dry-run mode:

```bash
USE_MCP_DRY_RUN=1 pnpm dev
```

## Build/Test

```bash
npx vitest run
npx tsc -p tsconfig.json
```

## Smoke Test

Run without screenshots:

```bash
pnpm smoke
```

Run with screenshot validation:

```bash
pnpm smoke:screenshot
```

## Primitive Composition Example

Find Zathura anywhere and capture that window:

1. `window_find` with:
   - `classContains: "zathura"` or `titleContains: ".pdf"`
   - `limit: 1`
2. Read the first match `windows[0].id`
3. Call `desktop_screenshot` with:
   - `target: "window"`
   - `windowId: "<id>"`

Launch an app into an empty workspace:

1. `workspace_pick_empty` with `rangeStart: 1`, `rangeEnd: 10`
2. `app_launch` with:
   - `appName: "zen"` (or raw `command`)
   - `workspace: "<picked workspace>"`
   - `keepCurrentWorkspace: true`

Grid-to-area screenshot:

1. `grid_show` on target screen/window
2. `grid_cell_rect` for chosen `cellId`
3. `desktop_screenshot_area` with returned rectangle

## Next

- Roadmap: `docs/ROADMAP.md`
- Operational learnings and recovery patterns: `docs/OPERATIONS.md`
