# Saarthi

Saarthi is a local Hyprland desktop-automation CLI. It exposes 62 commands through a discoverable `saarthi <noun> <verb>` tree without loading a large tool-schema catalog into every agent session.

It can inspect and control windows/workspaces, capture screenshots, launch policy-approved apps, drive keyboard/mouse input, query accessibility and OCR, operate existing tmux panes, automate the local Zen browser, and verify UI state. It intentionally does not expose arbitrary shell execution, clipboard access, remote transport, or an MCP server.

## Install

Requirements: Node.js 22+, pnpm, Hyprland, and the external tools needed by the commands you use (`hyprctl`, `grim`, `wtype`, `ydotool`, `tesseract`, ImageMagick, tmux, and AT-SPI Python bindings).

```bash
pnpm install
pnpm build
npm link
saarthi --help
```

`package.json` installs `saarthi` from `dist/src/cli.js`. Re-run `pnpm build` after source changes; the linked command immediately uses the rebuilt file.

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
pnpm test
pnpm build
pnpm smoke
```

The verification layers are:

- adapter tests for domain behavior
- CLI unit/dispatch tests for argv, schemas, outputs, exit codes, state, and status
- registry snapshot coverage for all 62 commands
- built-binary smoke for generated help and every read-only `--json` command

`pnpm smoke:screenshot` is the optional live screenshot check and writes a real PNG.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/OPERATIONS.md](docs/OPERATIONS.md), and [skill/SKILL.md](skill/SKILL.md).
