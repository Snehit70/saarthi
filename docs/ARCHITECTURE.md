# saarthi Architecture

## Purpose

`saarthi` is a local MCP server for Hyprland desktop operations and agentic UI automation. Its surface (44 tools) covers:

- inspect desktop, windows, and workspace/monitor topology
- query windows by class/title/focus/workspace and rank/pick best targets
- capture screenshots (full, monitor, window, area, grid cell)
- focus/move/resize windows and move them across workspaces
- launch apps under policy, then wait for and verify the resulting window
- keyboard typing and key presses
- mouse move/click/scroll, including grid-based and OCR-text-based targeting
- on-screen text search (`tesseract` OCR) and text-anchored clicking
- composite act-and-verify primitives (`action_step`, `click_wait_retry`)
- telemetry, trace export, and KPI metrics reporting

The server intentionally still does **not** expose shell execution, clipboard access, or network/remote transport. Earlier v1 docs described input automation and app launch as out of scope; that is no longer accurate — those capabilities now ship behind policy and audit controls.

## Runtime Model

- Transport: MCP stdio
- Process model: one Node process serving one MCP host connection
- Host user: current desktop user (required for Hyprland socket access)
- Target environment: Linux + Wayland + Hyprland

## High-level Data Flow

1. MCP host sends tool call over stdio.
2. The matching `src/handlers/*` tool handler validates input with `zod` schemas and dispatches to adapters.
3. Hyprland adapter resolves live compositor signature from `/run/user/$UID/hypr/*/.socket.sock`.
4. Adapter executes `hyprctl` or `grim` with `execFile` (no shell interpolation).
5. Response is normalized to MCP `content` + optional `structuredContent`.
6. Mutating tools append JSONL audit events.

## Module Layout

Entry and shared runtime:

- `src/index.ts`: thin entry — imports the handler modules (which register tools on import) and connects the stdio transport.
- `src/server.ts`: the single `McpServer` instance, imported by every handler module.
- `src/runtime.ts`: shared runtime state/config singletons (dry-run flag, session id, log paths, loaded policy, launch rate limiter, and the mutable grid-session holder).

Tool handlers (one module per domain, each registers its tools on import):

- `src/handlers/apps.ts`, `windows.ts`, `workspaces.ts`, `screenshots.ts`, `input.ts`, `mouse.ts`, `grid.ts`, `text.ts`, `observability.ts`, `composite.ts`.

Adapters and helpers (`src/lib/`):

- `hyprland.ts`: Hyprland discovery, JSON query, dispatch execution, normalization.
- `screenshot.ts`: screenshot capture and PNG extraction.
- `image.ts`: PNG metadata parse and monitor/window geometry helpers.
- `grid.ts`: grid overlay cell/point/rect geometry helpers.
- `pointer.ts`: pointer/grid target resolution and window-wait helpers.
- `mouse.ts`: mouse move/click/scroll execution via `ydotool`/`hyprctl`.
- `text-locate.ts`: OCR-based on-screen text search and click-point resolution.
- `ocr.ts`: tesseract TSV parsing.
- `input.ts`: keyboard key/modifier normalization and typed-text sanitization.
- `apps.ts`: app catalog, launch-command resolution, and launch rate limiter.
- `workspace.ts`: empty-workspace selection within policy bounds.
- `policy.ts`: launch policy loading, command parsing, alias resolution.
- `audit.ts`: append-only audit logger.
- `runlog.ts`: repo-local action trace log writer.
- `util.ts`: generic helpers (sleep, JSONL read, command existence, numeric parsing).
- `types.ts`: shared type definitions.

Other:

- `config/policy.json`: launch policy config (allowed aliases, denied patterns, rate limit, workspace bounds).
- `scripts/smoke-test.ts`: stdio smoke validation via MCP client.

## Hyprland Socket Strategy

The server does not trust `HYPRLAND_INSTANCE_SIGNATURE` alone. It:

1. lists `/run/user/$UID/hypr/*/.socket.sock`
2. prefers env signature first if present
3. probes each candidate with `hyprctl -j version`
4. uses the first working signature

This handles stale env signatures and compositor restarts.

## Error Semantics

- Tool-level validation errors: returned as MCP tool call errors.
- Hyprland adapter failures: raised as `HyprlandError`.
- Startup fatal errors: printed to stderr and process exits non-zero.

## Output Shapes

- Read tools return both human-readable JSON text and machine-readable `structuredContent`.
- Screenshot tool returns image content (`image/png`, base64) plus metadata text payload.
- Mutating tools return command outcome text (or dry-run command summary).

## Window Screenshot Correctness

For `target = "window"` and `target = "active_window"`, capture is workspace-aware:

1. resolve target window metadata
2. record current focused workspace
3. switch to target workspace (if different)
4. focus target window by address
5. refresh window geometry from live state
6. run `grim -g ...`
7. restore original workspace

This avoids stale-geometry captures from the currently visible workspace.

## Composition Pattern

This server is intentionally primitive-first so agents can chain actions:

1. discover candidates with `window_find`
2. validate exact target with `window_get` or `window_list`
3. act via `window_focus`, `desktop_screenshot`, `window_move`, `window_resize`, `workspace_focus`, or `window_send_to_workspace`

Example chain for a semantic request like "screenshot zathura":

- `window_find(classContains=\"zathura\", limit=1)` -> get `windowId`
- `desktop_screenshot(target=\"window\", windowId=<id>)`

## Non-goals

- Multi-compositor support (GNOME/KWin/Sway)
- Remote/HTTP transport
- session-user isolation bridge
- arbitrary shell execution
- clipboard access
