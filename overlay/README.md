# Saarthi Overlay HUD

The overlay is an optional always-on-top HUD that shows Saarthi's active task, current command, and recent read/act steps. It is independent of the per-invocation CLI and is the only persistent Saarthi user service.

## Data Flow

```text
saarthi CLI dispatch wrapper             overlay host
recordStepStart / recordStepDone
             writes atomically -> ~/.local/state/saarthi/status.json
                                      |
                                      v
                              Gio.FileMonitor -> host.py -> index.html
```

`src/cli/execute.ts` emits command status. `src/lib/status.ts` persists explicit task lifecycle in `overlay-task.json` and writes `status.json` through a unique temp file plus rename. Separate CLI processes therefore share the task while each command settles its own current step.

## Status Contract

```jsonc
{
  "schema": 2,
  "sessionId": "agent-run-id",
  "state": "active" | "idle",
  "updatedAt": "ISO-8601",
  "task": {
    "id": "...",
    "label": "desktop task",
    "state": "working" | "waiting" | "dormant_waiting" | "complete" | "error" | "timeout",
    "stats": { "steps": 0, "reads": 0, "acts": 0, "errors": 0, "retries": 0 }
  } | null,
  "current": { "id": 1, "tool": "window_list", "label": "...", "kind": "read", "state": "running", "ts": "..." } | null,
  "recent": []
}
```

Set `SAARTHI_STATUS=0` to suppress writes. Set `SAARTHI_REDACT_TYPED=1`, or pass `--sensitive` to input commands, to hide typed content from status labels. Audit payloads record text length rather than text.

## Run

Requirements on Fedora/Hyprland are Python 3 with PyGObject, GTK 3, gtk-layer-shell, and WebKit2GTK 4.1.

```bash
pnpm overlay
pnpm overlay:demo
```

The demo does not read live command state. `index.html?demo=1` can also be opened directly for browser preview.

## User Service

```bash
/home/snehit/projects/saarthi/scripts/install-overlay-service.sh
systemctl --user restart saarthi-overlay.service
systemctl --user status saarthi-overlay.service --no-pager
journalctl --user -u saarthi-overlay.service -n 100 --no-pager
```

Do not create a Saarthi command/server systemd unit.

## Tuning

`host.py` owns `IDLE_LINGER_MS`, `TOP_MARGIN`, and `RIGHT_MARGIN`. Card geometry and colors are CSS variables in `index.html`.
