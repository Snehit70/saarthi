# AGENTS.md

## Working Rules

- Check whether an MCP server process is already running before starting another one.
- Keep v1 scope limited to Hyprland window movement/focus/resize/workspace move and screenshots.
- Do not add shell execution or input automation tools in v1.
- Prefer stdio transport; do not expose HTTP transport by default.
- Validate all window ids against live `hyprctl -j clients` before dispatching commands.
