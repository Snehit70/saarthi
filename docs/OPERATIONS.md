# Operations

## Install And Upgrade

Check that no development process is already running before starting one. The normal CLI does not need a server process.

```bash
bun install
bun run build
bun link
command -v saarthi
saarthi --help
```

After source changes, run `bun run build`. The linked command points at `dist/src/cli.js`, so no service or client reconnect is required.

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
bun run test
bun run build
bun run smoke
```

Optional live checks:

```bash
saarthi observability desktop-health --json | jq .
saarthi window list --json | jq '.windows | length'
bun run smoke:screenshot
```

`bun run smoke:screenshot` performs a real capture. Read/view the returned path and remove the generated test image when no longer needed.

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

## Browser and input checks

```bash
saarthi browser discover --json
saarthi browser open-url https://example.com --browser helium --mode new-window --readiness title-contains --ready-title-contains "Example Domain" --json
# Use the returned live window id for the following commands.
saarthi screenshot capture --target window --window-id 0xABC --json
saarthi browser action --window-id 0xABC --action find --query "documentation" --json
saarthi input key-press --window-id 0xABC --key escape --json
```

Inspect the returned screenshot before choosing an OCR query. Page content can differ from its window title. A readiness timeout exits 17, and a missing target exits 11. Inspect before retrying navigation or any action that may already have happened.

Host commands use the caller's actual `XDG_RUNTIME_DIR`, `WAYLAND_DISPLAY`, and D-Bus session environment for input, capture, and AT-SPI. Saarthi discovers the Hyprland signature for compositor reads and passes it to focused AT-SPI lookup. Host adapters do not guess a Wayland display or start a new session. The explicitly requested `desktop start` backend creates its own session as documented below. Empty page accessibility results require OCR/grid or screenshot targeting.

The installed wtype may reject `-d 0`; the shared adapter omits the delay flag at zero. A harmless adapter installation check is `wtype - </dev/null` in the real Wayland session. Actual text is always sent through stdin.

See [the generalization review](research/2026-10-22-generalization-review.md) for source-backed decisions, live validation, and remaining gaps.

## Clipboard and semantic input

Check `command -v cliphist wl-copy wl-paste flock python3` in the same Wayland session. `clipboard images --limit 4 --json` returns only image metadata. `ui find --window-id ID --name-contains Composer --json` checks whether a destination is addressable. Do not infer an attachment from a successful Ctrl+V; inspect the final application state. The installed skill documents the guarded paste and native chooser fallback.

Exit 18, `INPUT_BUSY`, means another Saarthi invocation holds the desktop input lease. Let that operation finish and inspect before retrying. The lease releases on owner death. Do not remove the lockfile while another invocation runs, because replacing its inode would create a second independent lock. This is coordination between Saarthi processes and does not isolate unrelated desktop input.

The benchmark fixture is an optional policy-approved desktop application. It does not require a server. See [SaarthiBench](../benchmarks/README.md) for private run setup, version freezing, scoring, and the difference between scripted tooling results and agent evaluation.

## Background capture and plans

See [BACKGROUND-WORK.md](BACKGROUND-WORK.md) for the private plan schema, file-input workflow and failure recovery. Build the native helper with `bun run build:native`. Its build is optional when prerequisites are missing, but scanner/compiler errors fail once prerequisites exist. CI requires it.

The browser adapter requires an existing connected Open Browser Use profile. A missing or ambiguous connection fails without launching anything. Browser session leases are separate from the desktop input lease and conflicts also exit 18. Never delete a live lease file. Plan receipts in `~/.local/state/saarthi/plans/` refuse duplicate ids, including after partial failure. Inspect an error's completedSteps and inFlightStep before writing a new plan. A timeout does not establish that an action had no effect.

## Private desktop input

See [ISOLATED-DESKTOP.md](ISOLATED-DESKTOP.md) for dependencies, action files, native
file pickers, profiles and recovery. `desktop start` explicitly creates a separate
headless display; normal host commands still use the caller's actual session.
Inspect existing desktop ids before starting more. Use `desktop status` and view
`desktop capture` without switching host workspaces. Always save requested work
before `desktop stop` closes session-owned applications.

A startup error names the private compositor log. Inspect that desktop's `bus.log`
and `input-devices.log` if dialogs or devices fail. A retained keyboard failure
requires stopping and recreating the session; never redirect it to the host.
Private portal behavior depends on installed desktop backends. A launch timeout
can leave an app still starting: inspect status before trying again. Private
profiles and logs remain in the runtime after stop; stop only terminates processes.
