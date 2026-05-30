# saarthi overlay HUD

A small always-on-top desktop HUD that pops up in the top-right corner while
saarthi is controlling the desktop, showing animated "thinking" eyes, the
current action, and a live feed of recent steps.

It is a separate, optional process — the MCP server runs fine without it.

## How it works

```
saarthi MCP server                      overlay host (this dir)
──────────────────                      ───────────────────────
registerTool wrapper (src/server.ts)
  on every tool call emits  ──writes──▶  ~/.local/state/saarthi/status.json
  { state, current, recent[] }            (atomic write)
                                              │ Gio.FileMonitor (inotify)
                                              ▼
                                          host.py reads + pushes into
                                          index.html via window.saarthiUpdate()
                                          shows on "active", hides after idle
```

- **Rendering:** `index.html` — a self-contained web HUD (HTML/CSS/JS), no build
  step, no network. Drives off `window.saarthiUpdate(snapshot)`.
- **Host:** `host.py` — GTK 3 + `gtk-layer-shell` + WebKit2GTK 4.1 via PyGObject.
  Anchors the page to the top-right on the `OVERLAY` layer, transparent and
  click-through, never grabbing keyboard focus.

## Status contract

`~/.local/state/saarthi/status.json`:

```jsonc
{
  "schema": 1,
  "sessionId": "…",
  "state": "active" | "idle",
  "updatedAt": "ISO-8601",
  "current": { "id", "tool", "label", "kind", "state", "ts" } | null,
  "recent":  [ /* last 6 steps, oldest→newest */ ]
}
```

`kind` is `"read"` or `"act"` (derived from each tool's `readOnlyHint`);
step `state` is `"running" | "done" | "error"`.

The server stops emitting if `SAARTHI_STATUS=0` is set.

## Requirements (Fedora + Hyprland — all preinstalled here)

- `python3` + PyGObject (`python3-gobject`)
- `gtk3`, `gtk-layer-shell`, `webkit2gtk4.1`
- a `wlr-layer-shell` compositor (Hyprland)

## Run

```bash
# live — follows the status file written by the MCP server
overlay/saarthi-overlay
# or: python3 overlay/host.py

# standalone visual demo (no MCP server needed)
overlay/saarthi-overlay --demo
```

Preview the HUD in any browser without GTK: open `index.html?demo=1`.

## Autostart on Hyprland

Add to `~/.config/hypr/hyprland.conf`:

```
exec-once = python3 /home/snehit/projects/saarthi/overlay/host.py
```

## Tuning

In `host.py`: `IDLE_LINGER_MS` (how long it stays after going idle),
`TOP_MARGIN` / `RIGHT_MARGIN` (placement). Card width and colors live in the
`:root` CSS block of `index.html`.
