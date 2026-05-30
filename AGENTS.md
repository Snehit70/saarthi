# AGENTS.md

## Working Rules

- MCP servers are stdio processes owned by each MCP host/client session; do not manage MCP with systemd.
- Check whether an MCP server process is already running before starting another one.
- Manage only the eyes overlay HUD with the user systemd unit:
  - `systemctl --user restart saarthi-overlay.service`
  - `systemctl --user status saarthi-overlay.service --no-pager`
  - `journalctl --user -u saarthi-overlay.service -n 100 --no-pager`
- Do not start `saarthi-mcp.service`; disable and remove it if present.
- Prefer stdio transport; do not expose HTTP/remote transport.
- Validate all window ids against live `hyprctl -j clients` before dispatching mutating commands.
- Route every app launch through the launch policy (`config/policy.json`); never bypass alias/deny/rate-limit checks.
- Do not add arbitrary shell execution or clipboard access tools.
- Mutating tools must append audit events and emit telemetry; preserve the act-then-verify pattern.
- Keep `execFile` with argument arrays — no shell string interpolation.
