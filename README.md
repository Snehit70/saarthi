# Saarthi

Saarthi is a local Hyprland desktop-automation CLI. It exposes 75 commands through a discoverable `saarthi <noun> <verb>` tree without loading a large tool-schema catalog into every agent session.

It can inspect and control windows/workspaces, capture screenshots, launch policy-approved apps, drive keyboard/mouse input, query accessibility and OCR, operate existing tmux panes, automate local Firefox-family and Chromium-family browsers, and verify UI state. It intentionally does not expose arbitrary shell execution, remote transport, or an MCP server.

## Install

Requirements: Node.js 22+, Bun 1.3.3+, Hyprland, and the external tools needed by the commands you use (`hyprctl`, `grim`, `wtype`, `ydotool`, `tesseract`, ImageMagick, tmux, `flock`, `cliphist`, `wl-clipboard`, and AT-SPI Python bindings).

```bash
bun install
bun run build
bun link
saarthi --help
```

`package.json` installs `saarthi` from `dist/src/cli.js`. Re-run `bun run build` after source changes; the linked command immediately uses the rebuilt file.

### Migrating from the MCP server

Saarthi used to run as an MCP server. If you registered it with an MCP host (e.g. Claude Code), remove that registration on each machine — it is what loaded ~90 tool schemas into every session, and the CLI replaces it. Nothing in this repo can remove it for you; it lives in your host config.

- Claude Code: delete the `saarthi_mcp` entry from `mcpServers` in `~/.claude.json` (or run `claude mcp remove saarthi_mcp`).
- Drop any `mcp__saarthi_mcp__*` permission entries from `.claude/settings.local.json` and allow `Bash(saarthi *)` instead.

After that, agents call the CLI through their shell rather than connecting to a server.

## Usage

```bash
export SAARTHI_SESSION_ID="agent-$(date +%s)"

saarthi window --help
saarthi window list
saarthi window list --json | jq '.windows[] | {id, class, title}'
saarthi workspace focus 3 --json
saarthi screenshot capture --target full --json
```

Human-readable text is the default. `--json` emits the handler's structured payload to stdout. Errors go to stderr and operational failures use stable non-zero exit codes.

Screenshots are written to disk and return a path. An agent must read/view that path after capture; capture success is not visual inspection.

Natural primary arguments can be positional for common commands:

```bash
saarthi window focus 0xABC
saarthi grid click 14
saarthi workspace focus 3
```

All options remain discoverable through command help:

```bash
saarthi browser open-url --help
```

## Browser control

`browser discover` inventories Zen, Firefox, LibreWolf, Floorp, Helium, Chromium, Chrome, Brave, Vivaldi, and Edge. It reports installed launchers separately from running windows and launch-policy availability. Native and listed Flatpak installs are supported; Helium also recognizes `~/AppImages/helium.appimage`.

```bash
saarthi browser discover --json
saarthi browser focus --browser helium --json
saarthi browser open-url https://example.com --browser firefox --json
saarthi browser action --window-id 0xABC --action next-tab --json
saarthi browser action --window-id 0xABC --action find --query "Sign in" --json
```

Automatic selection uses the focused browser, then a single running browser identity. With several unfocused browsers or matching windows, provide `--browser`, `--window-id`, or a unique `--title-contains`. With no running browser, URL opening uses discovered desktop defaults or an installed policy-approved browser. Explicit missing targets fail instead of opening an unrelated window.

New-tab navigation preserves the current page. Current-tab navigation requires `--current-tab-reason`. Launches pass the shared alias, command, and rate-limit policy; reusing an existing window does not consume a launch slot. Browser alias defaults now include the ten listed browsers; remove unwanted aliases from `config/policy.json` to disable their launches.

Title readiness is a heuristic, not proof that a page has loaded. A readiness timeout exits `17`; navigation may already have occurred, so inspect before retrying. Use accessibility, phrase OCR, or a fresh screenshot to verify the next page action. `browser action` and Vimium return `verificationRequired` because sending a shortcut does not establish the resulting page state.

Keyboard and mouse input is foreground input. `input type` and `input key-press` accept `--window-id` to reject focus drift. Typing uses stdin rather than process arguments and limits estimated duration to 120 seconds. For background tab work, use the optional adapter below.

## Semantic actions and clipboard images

Resolve elements by exact accessible name in a live focused window. Text replacement verifies readback. Password reads are refused; ambiguous, stale, hidden, disabled, or mismatched targets fail closed.

```bash
saarthi ui find --window-id 0xABC --name-contains Composer --json
saarthi ui act --window-id 0xABC --name "Target composer" --role text --action focus --json
saarthi ui read-text --window-id 0xABC --name "Target composer" --role text --json
saarthi clipboard images --limit 4 --json
saarthi clipboard paste-images --window-id 0xABC --target-name "Target composer" --count 4 --json
```

`paste-images` skips text history entries, requires a uniquely named focused editable field, verifies each injected image, and sends Ctrl+V without Enter. It restores the previous preferred MIME payload, or clears the selection if it was empty. It preserves a new clipboard selection detected during the operation. Full multi-format clipboard restoration is not supported. History watchers may retain the temporary images. A successful paste command still requires checking the destination's attachment state.

If the application does not expose an addressable field, use `clipboard export-images` and attach the returned private files through its browser file input or native file chooser. This requires separate destination verification.

`ui batch --window-id 0xABC --steps-file /private/plan.json` runs up to 20 structured semantic steps. Each target is resolved again, text writes are verified, and a failure reports how many steps completed. Inspect before retrying; completed actions are never replayed automatically. Send, submit, delete, and payment actions require confirmation flags.

A kernel-held input lease serializes Saarthi mutations across processes. A conflicting invocation exits `18` before input. The lease is released when its owner dies. It does not isolate the desktop from a person typing or from other applications. AT-SPI coordinate translation now aligns the selected frame with live compositor bounds, including negative screen origins.

## Background work and file selection

Window screenshots use `grim -T` and a native Wayland mapping helper by default. They do not focus or switch workspaces. Build the helper with a C compiler, `pkg-config`, Wayland development headers and `wayland-scanner`; `SAARTHI_REQUIRE_NATIVE=1 bun run build` makes its prerequisites mandatory. Unsupported capture fails without a foreground fallback. `--allow-focus` explicitly opts into the older focus/crop path.

```bash
saarthi screenshot capture --target window --window-id 0xABC --json
saarthi screenshot workspace --workspace 4 --max-windows 12 --json
saarthi app launch-and-wait --app-name zathura --workspace 4 --class-contains zathura --json
```

Workspace capture returns a private image set and window positions. It does not reconstruct compositor wallpaper, stacking, panels or effects. A mapped window that cannot be exported causes an error; capture supported windows individually when needed. `keepCurrentWorkspace` uses Hyprland's silent launch rule. Applications that reuse an existing process/window can ignore initial placement, so verify the returned workspace.

An optional adapter uses an **already connected** Open Browser Use extension/profile. Saarthi starts no browser service and never claims unrelated tabs. Discover profiles with `open-browser-use profiles --connected`, then explicitly select the browser, profile and a task-specific session on every command:

```bash
saarthi browser background-open --browser-target chrome --profile Default --session-id report-task --url https://example.com --label "Report task" --json
saarthi browser background-tabs --browser-target chrome --profile Default --session-id report-task --json
saarthi browser background-act --browser-target chrome --profile Default --session-id report-task --step-file /private/step.json --json
saarthi browser background-finish --browser-target chrome --profile Default --session-id report-task --json
```

Step files must be user-owned regular files, at most 1 MiB, with private permissions such as `chmod 600`. Actions are `inspect`, `read`, `fill`, `click`, `files`, `wait-text`, and `screenshot`. Each step declares an owned `tabId` and exact `expectedUrl`. `inspect` returns bounded controls with selectors; every action resolves its selector again. Password fields and unconfirmed submissions/deletions/payments are refused. There is no caller-supplied JavaScript or shell command.

A `files` step takes explicit paths, checks regular files and a 128 MiB total limit, and transfers bytes in chunks over the existing socket. It assigns the complete file list once, dispatches input/change events, and checks names/sizes. Hidden file inputs are supported. This avoids both native dialogs and extension file-URL permission changes. A verified file list is not proof of a server upload; inspect the application's attachment state. Sites requiring trusted native events, cross-origin frames, shadow DOM, permissions or native dialogs need a separate supported workflow.

Prepare 4–10 steps ahead with `plan run --plan-file /private/plan.json`. The plan declares allowed session tabs and native windows, including each native window's PID and workspace. Browser changes require an immediate text checkpoint. One browser connection serves the plan, with a session-specific lease instead of the global desktop-input lease. Progress is synced before each step. A started plan id cannot be replayed, including after failure or process death. Inspect the receipt and actual application state, then prepare a new id containing only remaining work.

See [the plan example and recovery instructions](docs/BACKGROUND-WORK.md). A browser tab scope does not assert which Hyprland workspace contains its window. Ordinary native keyboard/mouse actions still share your seat; a reserved workspace alone cannot isolate them.

## Computer-use benchmark

[SaarthiBench](benchmarks/README.md) contains 64 native GTK workflows across clipboard, documents, data, forms, files, recovery, long sequences, and preservation. It checks saved artifacts, exact text, image order, file hashes, unrelated drafts, and accidental sends, with action and wall-time budgets. The scripted reference track is a synthetic integration suite, not an autonomous benchmark score. The 56 real-application challenge designs remain unrun, and an independent agent comparison with Codex remains to be run.

## Persistent State

Cross-invocation state lives under `~/.local/state/saarthi/`:

- `grid-session.json`: active grid targeting session
- `launch-timestamps.json`: policy rate-limit window
- `overlay-task.json`: explicit overlay task lifecycle
- `status.json`: atomic HUD status snapshot
- `audit.jsonl`: append-only audit events

Set `SAARTHI_SESSION_ID` once per agent run to group audit and trace events. Without it, each invocation gets its own generated id.

## Overlay

The eyes overlay is independent of the CLI and remains the only Saarthi user service:

```bash
scripts/install-overlay-service.sh
systemctl --user restart saarthi-overlay.service
systemctl --user status saarthi-overlay.service --no-pager
journalctl --user -u saarthi-overlay.service -n 100 --no-pager
```

Do not create a Saarthi MCP service. The CLI emits start/done status for every command and persists explicit task lifecycle commands:

```bash
saarthi overlay task-start --label "desktop task"
saarthi overlay task-ping --state waiting
saarthi overlay task-complete --status done
```

## Safety

- Window ids are validated against live Hyprland state before mutating commands.
- App launches always pass `config/policy.json` aliases, deny rules, and the persisted rate limiter.
- Mutating commands append audit events and preserve act-then-verify workflows.
- Process execution uses `execFile` with argument arrays, never interpolated shell strings.
- `SAARTHI_DRY_RUN=1` exercises mutating command paths without desktop mutations.

Hyprland 0.55+ mutations use Lua dispatcher expressions centralized in `src/lib/hyprland.ts`. A stdout line beginning with `error:` is treated as failure even if `hyprctl` exits zero.

## Development

```bash
bun run test
bun run build
bun run smoke
```

The verification layers are:

- adapter tests for domain behavior
- CLI unit/dispatch tests for argv, schemas, outputs, exit codes, state, and status
- registry snapshot coverage for all 75 commands
- built-binary smoke for generated help and every read-only `--json` command

`bun run smoke:screenshot` is the optional live screenshot check and writes a real PNG.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/OPERATIONS.md](docs/OPERATIONS.md), and [skill/SKILL.md](skill/SKILL.md).
