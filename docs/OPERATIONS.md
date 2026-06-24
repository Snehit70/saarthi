# Operations

## Install And Upgrade

Check that no development process is already running before starting one. The normal CLI does not need a server process.

```bash
pnpm install
pnpm build
npm link
command -v saarthi
saarthi --help
```

After source changes, run `pnpm build`. The npm-linked command points at `dist/src/cli.js`, so no service or client reconnect is required.

## Overlay Service

Only the overlay HUD is managed by systemd:

```bash
scripts/install-overlay-service.sh
systemctl --user restart saarthi-overlay.service
systemctl --user status saarthi-overlay.service --no-pager
journalctl --user -u saarthi-overlay.service -n 100 --no-pager
```

Remove any obsolete service if found:

```bash
systemctl --user disable --now saarthi-mcp.service || true
rm -f ~/.config/systemd/user/saarthi-mcp.service
systemctl --user daemon-reload
```

Never start `saarthi-mcp.service`. Saarthi has no long-lived command service.

## Run Context

Group commands from one agent run:

```bash
export SAARTHI_SESSION_ID="agent-$(date +%s)"
saarthi overlay task-start --label "desktop task"
```

Finish explicitly:

```bash
saarthi overlay task-complete --status done
```

Use `error` or `timeout` when appropriate. Inspect current state at `~/.local/state/saarthi/status.json`.

## Verification

```bash
pnpm test
pnpm build
pnpm smoke
```

Optional live checks:

```bash
saarthi observability desktop-health --json | jq .
saarthi window list --json | jq '.windows | length'
pnpm smoke:screenshot
```

`pnpm smoke:screenshot` performs a real capture. Read/view the returned path and remove the generated test image when no longer needed.

Dry-run mutations with:

```bash
SAARTHI_DRY_RUN=1 saarthi window focus 0xABC --json
```

## Exit Handling

Stdout is reserved for result data. Stderr contains validation or operational errors.

```bash
if payload=$(saarthi window get 0xABC --json); then
  jq .window <<<"$payload"
else
  code=$?
  printf 'saarthi failed with exit %s\n' "$code" >&2
fi
```

Exit `2` indicates command/argument validation. Other stable categories are documented by `src/cli/execute.ts` and cover platform/socket, window, dispatch, screenshot, input, OCR/accessibility, app launch, timeout, and tmux failures.

## Logs And State

```text
~/.local/state/saarthi/audit.jsonl
~/.local/state/saarthi/status.json
~/.local/state/saarthi/overlay-task.json
~/.local/state/saarthi/grid-session.json
~/.local/state/saarthi/launch-timestamps.json
logs/actions/run.jsonl
```

Export one session trace:

```bash
saarthi observability session-trace-export --session-id "$SAARTHI_SESSION_ID" --json
```

All state files that replace process memory are local to the current user. Status and JSON state writes use atomic temp-plus-rename updates.

## Dependencies

Check only the capability being diagnosed:

```bash
command -v hyprctl grim wtype ydotool tesseract magick tmux python3
hyprctl -j version
hyprctl configerrors
systemctl is-active ydotool.service
```

AT-SPI also needs Python GI bindings. Screenshot capture needs `grim`; grid rendering and screenshot comparison need ImageMagick; OCR needs `tesseract`.

## Troubleshooting

### No Hyprland socket

Confirm the command runs as the desktop user and inspect `/run/user/$UID/hypr/*/.socket.sock`. A stale `HYPRLAND_INSTANCE_SIGNATURE` is tolerated because Saarthi probes live candidates.

### Dispatcher appears successful but nothing changed

Inspect stdout for `error:`. Hyprland 0.55 Lua dispatch can return process exit zero with an error string. Keep command construction in `src/lib/hyprland.ts`.

### Window command rejected

Refresh live ids before mutating:

```bash
saarthi window list --include-hidden --json
```

Use mapped, actionable windows only.

### Screenshot failure

Confirm `grim` works in the same user/Wayland session and the target still exists. Successful commands return a file path; inspect that file separately.

### Mouse input failure

Confirm `ydotool.service` is active and its socket belongs to the current user at `/run/user/$UID/.ydotool_socket`.

### Grid reports no session

Run `saarthi grid show`, inspect its image, then use cell commands. `saarthi grid hide` intentionally deletes the persisted session.

### App launch unexpectedly rate-limited

Inspect `~/.local/state/saarthi/launch-timestamps.json`. Entries are milliseconds and are pruned to the trailing minute. Do not delete the state merely to bypass policy.

### Overlay looks stuck

Complete the explicit task, then inspect service logs and `status.json`:

```bash
saarthi overlay task-complete --status error
journalctl --user -u saarthi-overlay.service -n 100 --no-pager
```

### tmux refusal

Use `saarthi tmux list --json` to resolve targets. Do not override `TMUX_PANE_BUSY` without user confirmation.
