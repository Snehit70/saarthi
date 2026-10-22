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
- Explicit isolated-desktop requests may start a private headless compositor and session bus. Keep the CLI per-invocation; never attach these input tools to the host seat or add a Saarthi command server. Launch all contained apps through policy and clean up only verified session-owned processes.
- Background browser commands may act as a per-invocation client of an already connected local Open Browser Use socket. Never install/start a bridge or claim unrelated user tabs implicitly.
- Validate host window ids against live `hyprctl -j clients` before mutating commands. Isolated desktop container ids must instead match the selected private compositor tree and exact PID; never convert them into host window ids.
- Route every app launch through the launch policy (`config/policy.json`); never bypass alias/deny/rate-limit checks.
- Clipboard access tools are allowed. Keep clipboard data out of logs and scope paste operations to an explicitly validated destination.
- Do not add arbitrary shell execution tools.
- Mutating commands must append audit events and emit telemetry; preserve the act-then-verify pattern.
- Keep `execFile` with argument arrays — no shell string interpolation.
