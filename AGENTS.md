# AGENTS.md

## Working Rules

- Saarthi is a per-invocation CLI; do not start a server process for normal use.
- Before starting any development/watch process, check whether one is already running.
- Manage only the eyes overlay HUD with the user systemd unit:
  - `systemctl --user restart saarthi-overlay.service`
  - `systemctl --user status saarthi-overlay.service --no-pager`
  - `journalctl --user -u saarthi-overlay.service -n 100 --no-pager`
- Do not start `saarthi-mcp.service`; disable and remove it if present.
- Do not add daemon, HTTP, remote, or MCP transport.
- Validate all window ids against live `hyprctl -j clients` before dispatching mutating commands.
- Route every app launch through the launch policy (`config/policy.json`); never bypass alias/deny/rate-limit checks.
- Do not add arbitrary shell execution or clipboard access tools.
- Mutating commands must append audit events and emit telemetry; preserve the act-then-verify pattern.
- Keep `execFile` with argument arrays — no shell string interpolation.
