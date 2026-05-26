# Operations Guide

## Prerequisites

- Wayland + Hyprland session running under the same user
- `hyprctl` in PATH
- `grim` in PATH
- `wtype` in PATH
- `tesseract` in PATH (OCR tools)
- `ydotool` + `ydotoold` (mouse tools)
- Node 20+

## Build and test

```bash
npx tsc -p tsconfig.json
npx vitest run
```

If your `pnpm` policy blocks scripts via `ERR_PNPM_IGNORED_BUILDS`, use direct `npx` commands as above.

## Start server

Development:

```bash
pnpm dev
```

Compiled:

```bash
pnpm build
pnpm start
```

## ydotool service setup (required for mouse primitives)

Install:

```bash
sudo dnf install ydotool
```

On Fedora, default service may create root-owned socket under `/tmp`, which breaks user MCP calls.
Use service override so socket is created in user runtime dir:

```bash
sudo systemctl stop ydotool.service
sudo systemctl edit ydotool.service
```

Override content:

```ini
[Service]
ExecStart=
ExecStart=/usr/bin/ydotoold --socket-path=/run/user/1000/.ydotool_socket --socket-own=1000:1000 --socket-perm=0660
```

Reload and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ydotool.service
```

Verify:

```bash
systemctl is-active ydotool.service
ls -l /run/user/1000/.ydotool_socket
ydotool mousemove --absolute 200 200
```

Expected:

- service is `active`
- socket owner is your user
- `ydotool mousemove` exits without socket connection error

## Smoke tests

Basic:

```bash
npx tsc -p tsconfig.json
node dist/scripts/smoke-test.js
```

With screenshot capture:

```bash
npx tsc -p tsconfig.json
node dist/scripts/smoke-test.js --with-screenshot
```

Dry-run smoke (recommended first pass):

```bash
USE_MCP_DRY_RUN=1 node dist/scripts/smoke-test.js
```

The smoke script validates all current tools:

- `desktop_health`
- `desktop_screenshot`
- `window_list`
- `window_get`
- `window_find`
- `window_focus`
- `window_move`
- `window_resize`
- `workspace_focus`
- `window_send_to_workspace`

With `--with-screenshot`, smoke also validates grid/in-view flow:

- `grid_show`
- `grid_cell_to_point`
- `grid_move`
- `grid_click`
- `grid_hide`
- `mouse_verify_in_view`

## Manual composition test (Zathura flow)

Use this sequence in your MCP client/Codex:

1. `window_find` with `classContains: "zathura"` and `limit: 1`
2. extract `windows[0].id`
3. `desktop_screenshot` with `target: "window"` and that `windowId`

For persistent proof and later inspection:

4. `desktop_screenshot_save` with the same `windowId`
5. open the returned `path` and verify the image content before reporting success

## Audit logs

Mutating tool calls append to:

- `~/.local/state/saarthi/audit.jsonl`
- `./logs/actions/run.jsonl` (repo-local action traces for grid and verification tools)

Event shape:

- `timestamp`
- `action`
- `payload`
- `dryRun`

Run-log event shape (repo-local):

- `ts`
- `action`
- action-specific payload (`sessionId`, `cellId`, `absolute/relative`, `inView`, etc.)

Quick inspection:

```bash
tail -n 50 logs/actions/run.jsonl
```

```bash
rg -n '"action":"grid_' logs/actions/run.jsonl
```

## Common failure modes

### No working Hyprland socket

Symptom:

- `No working Hyprland socket found under /run/user/$UID/hypr`

Checks:

- confirm Hyprland running for current user
- list available sockets under `/run/user/$UID/hypr`
- verify this process has permission to read/write the socket

### Screenshot failure

Symptom:

- grim stderr output or `Not a PNG image`

Checks:

- confirm `grim` can run manually
- verify target monitor/window exists
- check if Wayland permission/session constraints changed

### Tool call rejected for window

Symptom:

- `Window not found`
- `Window not actionable (hidden/unmapped)`

Checks:

- call `window_list` with `includeHidden: true`
- use a mapped visible window id

### Vimium hints do not appear

Symptom:

- `f` is sent but hint labels are not visible.

Checks:

- ensure target browser window is focused (`window_focus`)
- exit active input/modal first (`escape` x2)
- if still hidden, send literal `f` via `type_text` as fallback
- capture screenshot and verify hints before continuing

### Input field captures control keys

Symptom:

- navigation keys are inserted into search/input boxes instead of driving UI state.

Checks:

- clear active field before retrying
- avoid typing URL/search text unless address/search target is explicitly focused
- prefer `window`-target screenshots for verification to avoid active-window drift

### Modal traps (confirmation dialogs)

Symptom:

- modal appears (for example "Clear search history?") and blocks normal navigation.

Checks:

- run Vimium hints on modal itself
- select safe dismiss action (`Cancel`) unless destructive action is intended
- verify modal closed before next step

### ydotool installed but MCP mouse tools still fail

Symptom:

- `mouse_move`/`mouse_click` fail with ydotool socket error.

Checks:

- `systemctl is-active ydotool.service` should be `active`
- ensure socket path is `/run/user/<uid>/.ydotool_socket`
- ensure socket owner/group allows current user access
- if socket appears under `/tmp/.ydotool_socket` owned by root, apply service override above

## Field Learnings (Zen + WhatsApp + Vimium)

1. Vimium-first is workable, but only with strict per-step verification screenshots.
2. Focus drift is the primary failure source, not window discovery.
3. Search input in WhatsApp can trap control flow; clear input before attempting mode switches.
4. `mouse_click` is required as deterministic recovery fallback when keyboard state becomes ambiguous.
5. If `mouse_click` is unavailable (`ydotool` missing), recovery may require manual user intervention.

## Recommended reliable sequence (for chat send tasks)

1. `window_focus` target browser.
2. `escape` twice.
3. trigger Vimium hints (`key_press("f")` or fallback `type_text("f")`).
4. screenshot and verify hint map.
5. click category/chat target through hints.
6. verify expected panel/chat header.
7. trigger hints again and open message input.
8. type message text.
9. send (`enter`) only after final pre-send verification.

## Safe rollout checklist

1. Run smoke in dry-run mode.
2. Run smoke with live mutations on a non-critical workspace.
3. Validate audit JSONL entries are generated.
4. Validate screenshot output in your MCP client.
