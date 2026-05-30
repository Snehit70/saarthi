# Tool Contracts

## Error format

Operational errors raised by the Hyprland adapter use a stable prefixed format:

- `[NO_SOCKET] ...`
- `[PLATFORM_UNSUPPORTED] ...`
- `[WINDOW_NOT_FOUND] ...`
- `[WINDOW_NOT_ACTIONABLE] ...`
- `[ACTIVE_WINDOW_MISSING] ...`
- `[NUMERIC_INVALID] ...`
- `[SCREENSHOT_FAILED] ...`
- `[APP_LAUNCH_FAILED] ...`
- `[INPUT_FAILED] ...`
- `[OCR_FAILED] ...`
- `[ATSPI_FAILED] ...`
- `[ACTION_TIMEOUT] ...`

## `app_list`

### Inputs

- `installedOnly?: boolean` (default `false`)

### Behavior

Returns known app aliases with clear names, one-line descriptions, and best-effort install detection.
For Flatpak launch forms (`flatpak run <app-id>`), install detection validates app id availability with `flatpak info`.

### Structured output

- `apps[]` with:
  - `name`
  - `description`
  - `installed`
  - `launchCommand`

## `metrics_report`

### Inputs

- `sessionId?: string` (defaults to current server session)
- `sinceIso?: string`
- `lastN?: number` (default `5000`)
- `includeLegacy?: boolean` (default `false`)

### Behavior

Computes KPI metrics from audit telemetry:

- error rate
- duration percentiles (`p50`, `p95`) from `durationMs` samples
- loop/retry counters
- task completion stats (when `taskId` is present)
- per-action totals and error rates

Session scoping is strict by default: only events with exact matching `sessionId` are included.
Set `includeLegacy=true` to also include legacy rows that have no `sessionId`.

## `session_trace_export`

### Inputs

- `sessionId?: string`
- `taskId?: string`
- `sinceIso?: string`
- `lastN?: number` (default `500`)
- `outputPath?: string`
- `includeLegacy?: boolean` (default `false`)

### Behavior

Exports merged audit + run trace events to a JSON file for later analysis.
Session filtering is strict by default; `includeLegacy=true` also includes legacy rows without `sessionId`.
  - `launchCommand`

## `desktop_health`

### Inputs

- none

### Behavior

Returns session and compositor health data.

### Structured output

- `sessionType: string | null`
- `desktop: string | null`
- `hyprlandInstance: string`
- `monitorCount: number`
- `focusedMonitor: string | null`
- `activeWindow: WindowInfo | null`

## `workspace_list`

### Inputs

- `includeWindowCounts?: boolean` (default `true`)

### Behavior

Lists Hyprland workspaces and optional occupancy counts.

### Structured output

- `workspaces[]` with:
  - `name`
  - `id`
  - `monitor`
  - `hasFullscreen`
  - `windowCount` (when enabled)
  - `isEmpty` (when enabled)

## `workspace_topology`

### Inputs

- none

### Behavior

Returns monitor ordering and workspace mapping for multi-monitor planning.
Monitors are ordered by global coordinates (`x`, then `y`) and include left/right neighbors.

### Structured output

- `focusedWorkspace: string | null`
- `monitors[]` with:
  - `name`
  - `index`
  - `geometry`
  - `focused`
  - `leftNeighbor`
  - `rightNeighbor`
- `workspaces[]` with:
  - `id`
  - `name`
  - `monitor`
  - `monitorIndex`
  - `hasFullscreen`
  - `focused`

## `workspace_pick_empty`

### Inputs

- `rangeStart?: number` (default `1`)
- `rangeEnd?: number` (default `10`)

### Behavior

Picks first empty numeric workspace in the given range based on current mapped windows.

### Structured output

- `workspace: string | null`
- `rangeStart`
- `rangeEnd`

## `workspace_focus_relative`

### Inputs

- `direction: "left" | "right"`
- `fallback?: "stay" | "wrap"` (default `stay`)
- `createIfAbsent?: boolean` (default `true`)

### Behavior

Moves focus to a workspace on neighboring monitor by monitor-column order (`x`, then `y`).
If no neighbor exists, `wrap` jumps to opposite edge monitor; `stay` keeps current monitor workspace.
When target monitor has no workspace and `createIfAbsent=true`, it creates/switches to first free numeric workspace in policy bounds.
If `createIfAbsent=false` and the neighbor has no workspace, it stays on current workspace (`changed=false`).
If numeric workspace range is exhausted, it also stays on current workspace with reason `no_available_numeric_workspace`.

## `app_launch`

### Inputs

- `command?: string`
- `appName?: string` (one of `app_list` names)
- `workspace?: string`
- `preferEmptyWorkspace?: boolean` (default `false`)
- `rangeStart?: number` (default `1`)
- `rangeEnd?: number` (default `10`)
- `keepCurrentWorkspace?: boolean` (default `true`)

### Behavior

- Resolves command from `appName` if command is not provided.
- Applies strict command parsing from `config/policy.json` and rejects blocked patterns/unsafe quoting.
- Optionally picks an empty workspace automatically.
- Launches via `hyprctl dispatch exec`.
- Restores original workspace when `keepCurrentWorkspace` is enabled.
- Enforces launch rate limit from policy.

## `window_wait_for`

### Inputs

- query fields from `window_find`:
  - `classEquals?`
  - `classContains?`
  - `titleContains?`
  - `workspace?`
  - `focusedOnly?`
  - `includeHidden?`
- `timeoutMs?` (default `10000`)
- `pollMs?` (default `200`)

### Behavior

Polls for a matching window until timeout.

### Structured output

- `window`
- `attempts`

## `app_launch_and_wait`

### Inputs

- launch fields from `app_launch`
- wait query fields:
  - `classEquals?`
  - `classContains?`
  - `titleContains?`
- wait controls:
  - `timeoutMs?` (default `12000`)
  - `pollMs?` (default `200`)

### Behavior

Launches app/command, then waits for a matching window.

### Structured output

- `launchCommand`
- `workspace`
- `window`
- `attempts`

## `action_verify_window_state`

### Inputs

- `windowId`
- optional expectations:
  - `expectedWorkspace`
  - `expectedFocused`
  - `expectedX`
  - `expectedY`
  - `expectedWidth`
  - `expectedHeight`
- `tolerancePx?` (default `4`)

### Behavior

Verifies current window state against expected values and returns mismatch details.

### Structured output

- `ok`
- `mismatches[]`
- `window`

## `type_text`

### Inputs

- `text: string`
- `delayMs?: number` (default `0`)
- `sensitive?: boolean` (default `false`) — masks the text in the status overlay/feed (`Typing (hidden)`); use for passwords. Audit logs and results only ever store text length.

### Behavior

Types text into the currently focused input field using Wayland virtual keyboard (`wtype`).

## `window_focus_and_type`

### Inputs

- `windowId`
- `text`
- `focusSettleMs?: number` (default `120`)
- `delayMs?: number` (default `0`)
- `sensitive?: boolean` (default `false`) — see `type_text`.

### Behavior

Focuses target window, waits for focus settle, then types text into the active input field.

## `window_list`

### Inputs

- `workspace?: string`
- `includeHidden?: boolean` (default `false`)

### Behavior

Lists windows from `hyprctl -j clients`, normalized.

### Structured output

- `windows: WindowInfo[]`

## `window_get`

### Inputs

- `windowId: "0x..."`

### Behavior

Returns one actionable window by id (must be mapped and not hidden).

### Structured output

- `window: WindowInfo`

## `window_find`

### Inputs

- `classEquals?: string`
- `classContains?: string` (case-insensitive)
- `titleContains?: string` (case-insensitive)
- `workspace?: string`
- `focusedOnly?: boolean` (default `false`)
- `includeHidden?: boolean` (default `false`)
- `limit?: number` (default `5`, max `20`)

### Behavior

Filters live windows for agent composition flows like:

- find Zathura by class/title
- focus the first match
- screenshot by window id

### Structured output

- `windows: WindowInfo[]`
- `count: number`

`WindowInfo`:

- `id` (`0x...`)
- `class`
- `title`
- `workspace`
- `monitor`
- `floating`
- `fullscreen`
- `focused`
- `mapped`
- `hidden`
- `position { x, y }`
- `size { width, height }`

## `window_focus_best`

### Inputs

- `classEquals?: string`
- `classContains?: string`
- `titleContains?: string`
- `workspace?: string`
- `includeHidden?: boolean` (default `false`)
- `preferredWorkspace?: string`
- `preferredMonitor?: string`
- `limit?: number` (default `5`)

### Behavior

Finds matching windows, ranks candidates, focuses best actionable match, and returns candidate scores.
Hidden/unmapped top candidates are skipped if lower-ranked actionable matches exist.

## `desktop_screenshot`

### Inputs

- `target: "full" | "monitor" | "active_window" | "window"`
- `monitorName?: string` (required when target is `monitor`)
- `windowId?: string` (required when target is `window`)

### Behavior

- full: `grim -`
- monitor: `grim -o <monitor> -`
- active/window:
  - resolve target window + workspace
  - switch to target workspace when needed
  - focus target window
  - refresh geometry
  - capture with `grim -g "x,y wxh" -`
  - restore previous workspace

### Output

- Content item 1: `image/png` base64
- Content item 2: metadata JSON text
- `structuredContent`:
  - `width`
  - `height`
  - `target`
  - `geometry`
  - `monitorName`

## `desktop_screenshot_save`

### Inputs

- `target: "full" | "monitor" | "active_window" | "window"`
- `monitorName?: string`
- `windowId?: string`
- `filenamePrefix?: string` (default `screenshot`)
- `outputDir?: string` (default `~/Pictures/saarthi`)

### Behavior

Captures PNG exactly like `desktop_screenshot`, then writes file to disk.

### Structured output

- `path: string`
- `width: number`
- `height: number`
- `target: string`

## `desktop_screenshot_area`

### Inputs

- `x: number`
- `y: number`
- `width: number`
- `height: number`
- `savePath?: string`

### Behavior

Captures absolute rectangular region using `grim -g "<x>,<y> <width>x<height>"`.

### Structured output

- `path: string`
- `geometry: { x, y, width, height }`

## `window_focus`

### Inputs

- `windowId: "0x..."`

### Behavior

Validates actionable window, logs audit event, then runs:

- `hyprctl dispatch focuswindow address:<windowId>`

## `window_move`

### Inputs

- `windowId: "0x..."`
- `mode: "absolute" | "delta"`
- `x: number`
- `y: number`

### Behavior

- `delta`: values clamped/truncated via `clampMoveResize`.
- `absolute`: values are clamped to the target window monitor bounds before dispatch.

Dispatch:

- absolute: `hyprctl dispatch movewindowpixel exact <x> <y>,address:<id>`
- delta: `hyprctl dispatch movewindowpixel <x> <y>,address:<id>`

## `window_resize`

### Inputs

- `windowId: "0x..."`
- `mode: "absolute" | "delta"`
- `width: number`
- `height: number`

### Behavior

- `delta`: values clamped/truncated to `[1, 10000]`.
- `absolute`: values clamped to target monitor dimensions.

Dispatch:

- absolute: `hyprctl dispatch resizewindowpixel exact <w> <h>,address:<id>`
- delta: `hyprctl dispatch resizewindowpixel <w> <h>,address:<id>`

## `workspace_focus`

### Inputs

- `workspace: string`

### Behavior

Switches focused workspace:

- `hyprctl dispatch workspace <workspace>`

## `window_send_to_workspace`

### Inputs

- `windowId: "0x..."`
- `workspace: string`

### Behavior

Validates actionable window, logs audit event, runs:

- `hyprctl dispatch movetoworkspace <workspace>,address:<windowId>`

## Dry-run mode

Set `USE_MCP_DRY_RUN=1`.

In dry-run:

- mutating tools only validate + audit
- no Hyprland dispatch is executed
- tool output contains the intended dispatcher command

## `key_press`

### Inputs

- `key` (supported: `enter`, `tab`, `escape`, `backspace`, `delete`, arrows, `home`, `end`, `page_up`, `page_down`, `f5`, letters `a-z`, digits `0-9`)
- `modifiers?: string[]` (`ctrl`, `alt`, `shift`, `super`)
- `repeat?: number` (default `1`)
- `delayMs?: number` (default `80`)

### Behavior

Sends a keyboard shortcut to the focused window via Hyprland `sendshortcut`.

## `grid_show`

### Inputs

- `target?: "full" | "monitor" | "active_window" | "window"` (default `active_window`)
- `monitorName?: string`
- `windowId?: string`
- `cols?: number` (`6..24`)
- `rows?: number` (`4..16`)
- `filenamePrefix?: string`
- `outputDir?: string`

### Behavior

Captures screenshot and writes a numbered grid overlay image. Stores active grid session for cell-based move/click actions.

## `grid_cell_to_point`

### Inputs

- `cellId: number` (1-based)

### Behavior

Resolves cell id to relative and absolute coordinates using active grid session.

## `grid_cell_rect`

### Inputs

- `cellId: number` (1-based)
- `insetPx?: number` (default `0`)

### Behavior

Returns absolute rectangle (`x/y/width/height`) for selected grid cell. Use this with `desktop_screenshot_area` for precise area capture.

## `grid_move`

### Inputs

- `cellId: number`
- `settleMs?: number`

### Behavior

Moves cursor to center of given grid cell.

## `grid_click`

### Inputs

- `cellId: number`
- `button?: "left" | "middle" | "right"`
- `settleMs?: number`

### Behavior

Clicks at center of given grid cell.

## `grid_hide`

### Inputs

- none

### Behavior

Clears active grid session state.

## `mouse_get_position`

### Inputs

- `target?: "full" | "monitor" | "active_window" | "window"` (default `full`)
- `monitorName?: string` (used when `target="monitor"`, defaults to focused monitor)
- `windowId?: string` (required when `target="window"`)
- `relativeToX?: number`
- `relativeToY?: number`

### Behavior

Returns cursor absolute position, target-relative position, target bounds, in-view status, and optional delta/distance to a target point.

## `mouse_verify_in_view`

### Inputs

- `target?: "full" | "monitor" | "active_window" | "window"` (default `active_window`)
- `monitorName?: string`
- `windowId?: string`

### Behavior

Checks if cursor lies within current target bounds and returns `{ inView, absolute, relative, bounds }`.

## `resolve_text_point`

### Inputs

- `query: string`
- `target?: "full" | "monitor" | "active_window" | "window"` (default `active_window`)
- `monitorName?: string`
- `windowId?: string`
- `confidenceMin?: number` (default `35`)
- `matchIndex?: number` (default `0`)
- `offsetX?: number` (default `0`)
- `offsetY?: number` (default `0`)

### Behavior

Runs OCR, picks one match, and returns both relative and absolute coordinates for the click/move point.

## `mouse_move_to_text`

### Inputs

- Same targeting/OCR inputs as `resolve_text_point`
- `settleMs?: number` (default `60`)

### Behavior

Resolves text point and moves cursor there.

## `click_text`

### Inputs

- Same targeting/OCR inputs as `resolve_text_point`
- `button?: "left" | "middle" | "right"` (default `left`)
- `settleMs?: number` (default `120`)

### Behavior

Resolves text point and clicks there.

## `mouse_click`

### Inputs

- `x: number`
- `y: number`
- `target?: "full" | "monitor" | "active_window" | "window"` (default `full`)
- `monitorName?: string` (used when `target="monitor"`, defaults to focused monitor)
- `windowId?: string` (required when `target="window"`)
- `button?: "left" | "middle" | "right"` (default `left`)
- `settleMs?: number` (default `80`)
- `clickCount?: number` (`1..3`, default `1`) — single/double/triple click.

### Behavior

Converts `(x,y)` to absolute screen coordinates from the selected target, moves via Hyprland cursor dispatch, then clicks with `ydotool` (`clickCount` times, ~45ms apart).

## `mouse_move`

### Inputs

- `x: number`
- `y: number`
- `target?: "full" | "monitor" | "active_window" | "window"` (default `full`)
- `monitorName?: string` (used when `target="monitor"`, defaults to focused monitor)
- `windowId?: string` (required when `target="window"`)
- `settleMs?: number` (default `40`)
- `smooth?: boolean` (default `false`) — glide along an eased path from the current cursor position so hover/motion-driven UIs fire.
- `steps?: number` (`2..200`, default `24`) — used when `smooth`.
- `stepDelayMs?: number` (`0..100`, default `8`) — used when `smooth`.

### Behavior

Converts `(x,y)` to absolute screen coordinates from the selected target, then moves cursor using Hyprland `dispatch movecursor` (instant, or eased when `smooth`).

## `mouse_drag`

### Inputs

- `fromX: number`, `fromY: number`
- `toX: number`, `toY: number`
- `target?: "full" | "monitor" | "active_window" | "window"` (default `full`) — both endpoints are relative to the same target
- `monitorName?: string`
- `windowId?: string`
- `button?: "left" | "middle" | "right"` (default `left`)
- `steps?: number` (`2..200`, default `28`)
- `stepDelayMs?: number` (`0..100`, default `8`)
- `settleMs?: number` (default `80`)

### Behavior

Presses the button at the start point, drags along an eased path to the end point, then releases (sliders, selections, drag-and-drop). Uses `ydotool` button down/up codes around Hyprland `movecursor` steps.

## `mouse_scroll`

### Inputs

- `axis?: "vertical" | "horizontal"` (default `vertical`)
- `amount: number` (`-50..50`, sign selects direction)
- `settleMs?: number` (default `60`)

### Behavior

Sends wheel events via `ydotool`:

- vertical: up/down
- horizontal: left/right

## `find_text_on_screen`

### Inputs

- `query: string`
- `target?: "full" | "monitor" | "active_window" | "window"` (default `active_window`)
- `monitorName?: string`
- `windowId?: string`
- `confidenceMin?: number` (default `35`)
- `limit?: number` (default `5`)

### Behavior

Captures screenshot, runs Tesseract OCR (TSV), and returns matching text boxes sorted by confidence.

## `click_wait_retry`

### Inputs

- `clickText: string`
- `expectText: string`
- `target?: "full" | "monitor" | "active_window" | "window"`
- `monitorName?: string`
- `windowId?: string`
- `maxAttempts?: number` (default `3`)
- `waitAfterClickMs?: number` (default `1000`)
- `confidenceMin?: number` (default `35`)

### Behavior

Loop primitive: find `clickText` with OCR -> click center -> wait -> verify `expectText`. Retries up to `maxAttempts`.

## `action_step`

### Inputs

- `action: "click_text" | "grid_click" | "mouse_click" | "key_press" | "type_text"`
- `verify?: "none" | "text_present" | "text_absent"` (default `none`)
- screenshot/target controls:
  - `target?: "full" | "monitor" | "active_window" | "window"` (default `active_window`)
  - `monitorName?`
  - `windowId?`
  - `outputDir?`
  - `filenamePrefix?`
- action controls (depends on `action`):
  - text/OCR: `query`, `confidenceMin`, `matchIndex`, `offsetX`, `offsetY`, `button`
  - grid: `cellId`, `button`
  - mouse: `x`, `y`, `button`
  - keyboard: `key`, `modifiers`, `repeat`
  - typing: `text`
- `settleMs?: number` (default `250`)

### Behavior

Atomic loop:

1. capture and save before screenshot
2. perform one action
3. wait settle delay
4. capture and save after screenshot
5. verify expected outcome (`none` or OCR text present/absent)

### Structured output

- `ok: boolean`
- `beforePath`
- `afterPath`
- `action` summary
- `verification` summary

## `wait_for_text`

### Inputs

- `query: string`
- `target?: "full" | "monitor" | "active_window" | "window"` (default `full`)
- `monitorName?: string`, `windowId?: string`
- `mode?: "appear" | "disappear"` (default `appear`)
- `timeoutMs?: number` (`200..60000`, default `8000`)
- `pollMs?: number` (`100..5000`, default `400`)
- `confidenceMin?: number` (default `55`)

### Behavior

Polls the screen with OCR until `query` appears (or disappears), or the timeout elapses. Use to wait on page loads / dialogs before acting.

### Structured output

- `ok: boolean` (condition met before timeout)
- `mode`, `query`, `attempts`, `elapsedMs`
- `match`: `{ relativeX, relativeY, absoluteX, absoluteY }` on `appear`, else `null`

## `wait_for_stable`

### Inputs

- `target?: "full" | "monitor" | "active_window" | "window"` (default `active_window`)
- `monitorName?: string`, `windowId?: string`
- `timeoutMs?: number` (`200..60000`, default `8000`)
- `pollMs?: number` (`100..5000`, default `350`)
- `threshold?: number` (`0..1`, default `0.01`) — normalised diff at/under which two frames count as "same"
- `stableFrames?: number` (`2..10`, default `2`) — consecutive same frames required

### Behavior

Captures the target repeatedly and compares consecutive frames (`magick compare` RMSE) until it stops changing for `stableFrames`, or the timeout elapses. Use for settle detection before acting on an animating/loading UI.

### Structured output

- `stable: boolean`, `frames`, `elapsedMs`, `lastDiff`, `threshold`

## `screenshot_compare`

### Inputs

- `pathA?: string`, `pathB?: string` — compare two existing PNGs, **or**
- `baselinePath?: string` + capture target (`target`, `monitorName`, `windowId`) — compare a baseline against a fresh capture
- `threshold?: number` (`0..1`, default `0.02`)
- `saveDiffPath?: string` — optional visual diff image

### Behavior

Returns a normalised difference score (`magick compare` RMSE) between two images. Pairs with `action_step` to confirm a change actually happened.

### Structured output

- `changed: boolean` (diff > threshold), `diffScore` (normalised), `raw`, `threshold`, `diffPath`

## `ui_find`

### Inputs

- `nameContains?: string` — case-insensitive substring on the accessible name
- `role?: string` — exact AT-SPI role (e.g. `push button`, `entry`, `link`)
- `interactive?: boolean` (default `true`) — restrict to interactive roles
- `focused?: boolean` (default `true`) — limit to the focused app (pid resolved via the active window)
- `appName?: string`, `pid?: number` — override the focused-app scope
- `includeOffscreen?: boolean` (default `false`)
- `maxDepth?: number` (`1..40`, default `16`), `maxNodes?: number` (`1..2000`, default `300`)

### Behavior

Queries the accessibility tree (AT-SPI) for structured, addressable elements. More reliable than OCR where apps expose accessibility (GTK/Qt and most native apps; browsers/Electron only with a11y enabled — OCR is the fallback there).

### Structured output

- `apps[]`: `{ name, pid, children }`
- `elements[]`: `{ role, name, depth, path, x, y, w, h, cx, cy, states[], actions[] }`
- `count`, `truncated`

`cx,cy` are screen coordinates ready for `mouse_click` with `target: "full"`.

## `ui_tree`

### Inputs

- `focused?: boolean` (default `true`), `appName?: string`, `pid?: number`
- `includeOffscreen?: boolean` (default `true`)
- `maxDepth?: number` (`1..40`, default `18`), `maxNodes?: number` (`1..2000`, default `500`)

### Behavior

Dumps an application's accessibility tree as a flat, depth-tagged element list for planning/inspection. Same element shape as `ui_find`.
