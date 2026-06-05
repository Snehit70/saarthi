# saarthi

Local MCP server for reliable Hyprland desktop control. Saarthi gives agents a
small, auditable set of primitives for inspecting workspaces, launching allowed
apps, moving/focusing windows, taking screenshots, reading UI text, and acting
through mouse/keyboard input.

![Saarthi overlay HUD demo](./Screenshot_2026-06-05_15-50-00_13368.png)

## What It Does

- Inspect the live Wayland/Hyprland session, monitors, workspaces, and windows.
- Capture full-screen, monitor, window, area, and grid-overlay screenshots.
- Launch approved apps through `config/policy.json`.
- Focus, move, resize, and send windows between workspaces.
- Drive verified mouse, keyboard, OCR, accessibility-tree, and grid workflows.
- Emit telemetry, audit events, and an optional desktop HUD while tools run.

Saarthi is intentionally local and stdio-only: no remote transport, no shell
execution tool, and no clipboard access.

## Quick Start

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts the MCP server over stdio for the current MCP host/client
session. Do not run the MCP server as a shared systemd service.

Build and run the compiled server:

```bash
pnpm build
pnpm start
```

## Requirements

- Linux Wayland session with Hyprland
- Node 20+
- `pnpm`
- `hyprctl`
- `grim`
- `wtype` for `type_text`
- `ydotool` for reliable mouse primitives
- `tesseract` for OCR tools
- ImageMagick `magick` for grid and screenshot comparison tools
- `python3`, `python3-gobject`, `python3-pyatspi`, and a running AT-SPI bus for accessibility-tree tools

Accessibility coverage is toolkit-dependent. GTK/Qt and many native apps expose
useful trees; browser page content may not. OCR and grid tools are the fallback.

## Tool Surface

### Desktop And Observability

- `desktop_health`
- `metrics_report`
- `session_trace_export`
- `desktop_screenshot`
- `desktop_screenshot_save`
- `desktop_screenshot_area`
- `screenshot_compare`

### Workspaces And Windows

- `workspace_list`
- `workspace_topology`
- `workspace_pick_empty`
- `workspace_focus`
- `workspace_focus_relative`
- `window_list`
- `window_get`
- `window_find`
- `window_wait_for`
- `window_focus`
- `window_focus_best`
- `window_move`
- `window_resize`
- `window_send_to_workspace`
- `action_verify_window_state`

### Apps And Input

- `app_list`
- `app_launch`
- `app_launch_and_wait`
- `type_text`
- `window_focus_and_type`
- `key_press`
- `mouse_get_position`
- `mouse_verify_in_view`
- `mouse_move`
- `mouse_click`
- `mouse_drag`
- `mouse_scroll`

### Targeting And Verification

- `grid_show`
- `grid_cell_to_point`
- `grid_cell_rect`
- `grid_move`
- `grid_click`
- `grid_hide`
- `resolve_text_point`
- `mouse_move_to_text`
- `click_text`
- `ui_find`
- `ui_tree`
- `find_text_on_screen`
- `wait_for_text`
- `wait_for_stable`
- `click_wait_retry`
- `action_step`

## Overlay HUD

The optional overlay HUD renders a small always-on-top status panel while
Saarthi is acting. The MCP server writes a best-effort status feed to
`~/.local/state/saarthi/status.json`; the overlay process watches that feed and
stays hidden when no task is active.

```bash
pnpm overlay          # live HUD
pnpm overlay:demo     # standalone demo HUD
pnpm overlay:install  # install/start the user service
```

The overlay is the only persistent user service:

```bash
/home/snehit/projects/saarthi/scripts/install-overlay-service.sh
systemctl --user restart saarthi-overlay.service
systemctl --user status saarthi-overlay.service --no-pager
journalctl --user -u saarthi-overlay.service -n 100 --no-pager
```

If an old MCP systemd service exists, remove it:

```bash
systemctl --user disable --now saarthi-mcp.service || true
rm -f ~/.config/systemd/user/saarthi-mcp.service
systemctl --user daemon-reload
```

See `overlay/README.md` for the status contract and host requirements.

## Safety Model

- Uses the current local desktop session only.
- Auto-discovers the active Hyprland socket under `/run/user/$UID/hypr`.
- Validates window ids before mutating window operations.
- Enforces app launch aliases, denies, rate limits, and workspace bounds through `config/policy.json`.
- Appends mutating-call audits to `~/.local/state/saarthi/audit.jsonl`.
- Writes repo-local action traces to `logs/actions/run.jsonl`.
- Supports dry-run mode:

```bash
USE_MCP_DRY_RUN=1 pnpm dev
```

## Validation

```bash
pnpm test
npx tsc -p tsconfig.json
pnpm smoke
pnpm smoke:screenshot
```

`pnpm smoke:screenshot` includes screenshot capture and grid/in-view validation.

## Example Workflows

Capture a known window:

1. Find the window with `window_find`, using `classContains` or `titleContains`.
2. Read `windows[0].id` from the result.
3. Call `desktop_screenshot` with `target: "window"` and that `windowId`.

Launch an app into an empty workspace:

1. Pick a workspace with `workspace_pick_empty`.
2. Launch through `app_launch` or `app_launch_and_wait`.
3. Verify state with `window_wait_for`, `desktop_screenshot_save`, or `wait_for_stable`.

Use grid targeting:

1. Run `grid_show` on the screen or window.
2. Use `grid_cell_rect` for a precise capture area, or `grid_cell_to_point` for a click target.
3. Act with `grid_click` or mouse tools.
4. Verify with screenshot comparison, OCR, or accessibility-tree checks.

## More

- Tool reference: `docs/TOOLS.md`
- Architecture: `docs/ARCHITECTURE.md`
- Operations: `docs/OPERATIONS.md`
- Roadmap: `docs/ROADMAP.md`
- Computer-use skill playbook: `skill/SKILL.md`
