# AGENTS.md

## Working Rules

- Check whether an MCP server process is already running before starting another one.
- Prefer stdio transport; do not expose HTTP/remote transport.
- Validate all window ids against live `hyprctl -j clients` before dispatching mutating commands.
- Route every app launch through the launch policy (`config/policy.json`); never bypass alias/deny/rate-limit checks.
- Do not add arbitrary shell execution or clipboard access tools.
- Mutating tools must append audit events and emit telemetry; preserve the act-then-verify pattern.
- Keep `execFile` with argument arrays — no shell string interpolation.
