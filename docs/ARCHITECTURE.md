# use-mcp Architecture

## Purpose

`use-mcp` is a local MCP server for Hyprland desktop operations with a narrow v1 scope:

- inspect desktop and windows
- query windows by class/title/focus/workspace
- capture screenshots
- focus/move/resize windows
- move windows across workspaces

The server intentionally does **not** expose shell execution, keyboard typing, mouse clicking, clipboard, app launch, or network transport.

## Runtime Model

- Transport: MCP stdio
- Process model: one Node process serving one MCP host connection
- Host user: current desktop user (required for Hyprland socket access)
- Target environment: Linux + Wayland + Hyprland

## High-level Data Flow

1. MCP host sends tool call over stdio.
2. `src/index.ts` validates input with `zod` schemas and dispatches to adapters.
3. Hyprland adapter resolves live compositor signature from `/run/user/$UID/hypr/*/.socket.sock`.
4. Adapter executes `hyprctl` or `grim` with `execFile` (no shell interpolation).
5. Response is normalized to MCP `content` + optional `structuredContent`.
6. Mutating tools append JSONL audit events.

## Module Layout

- `src/index.ts`: MCP server and tool registration.
- `src/lib/hyprland.ts`: Hyprland discovery, JSON query, dispatch execution, normalization.
- `src/lib/screenshot.ts`: screenshot capture and PNG extraction.
- `src/lib/image.ts`: PNG metadata parse and monitor/window geometry helpers.
- `src/lib/audit.ts`: append-only audit logger.
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

## Non-goals (v1)

- Multi-compositor support (GNOME/KWin/Sway)
- Remote/HTTP transport
- session-user isolation bridge
- mouse/keyboard automation
- policy engine beyond static scope limits
