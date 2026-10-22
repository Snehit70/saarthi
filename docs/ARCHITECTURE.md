# Saarthi Architecture

## Runtime Model

Saarthi is an installed Node.js CLI for one local Hyprland user session. Each `saarthi <noun> <verb>` invocation is a fresh process. There is no daemon, MCP transport, HTTP endpoint, remote bridge, or arbitrary shell tool.

The independent eyes HUD remains a user systemd service and reads `~/.local/state/saarthi/status.json`.

## Command Flow

1. `src/cli.ts` loads `src/register-tools.ts` and the command registry.
2. `src/cli/execute.ts` resolves the noun/verb, parses argv, and validates it through the command's zod schema.
3. The dispatch wrapper emits overlay start/done state and invokes the registered handler.
4. Handlers call adapters in `src/lib/*`.
5. Adapters use `execFile` argument arrays to call Hyprland and local utilities.
6. The CLI prints human text or the existing `structuredContent` under `--json`.
7. Errors go to stderr with stable categorized exit codes.

## Registry

`src/registry.ts` is an in-house registry whose `registerTool(name, config, handler)` shape matches the removed frontend. Existing handler bodies and zod `inputSchema` objects remain the single source of truth.

Tool registry keys remain snake_case internally for audit continuity. `src/registry.ts` maps them to public `saarthi <noun> <kebab-case-verb>` commands, with explicit mappings where the old name did not encode the intended noun.

Generated root, noun, and command help comes from this registry and its zod shapes.

## Modules

- `src/cli.ts`: executable entry with node shebang.
- `src/cli/execute.ts`: help, argv parsing, zod validation, dispatch, output, and exit mapping.
- `src/registry.ts`: command registration and noun/verb mapping.
- `src/register-tools.ts`: explicit registration imports for all handler domains.
- `src/handlers/*`: 69 command handlers grouped by domain.
- `src/lib/*`: Hyprland, screenshot, input, OCR, accessibility, browser, tmux, policy, state, audit, and telemetry adapters.
- `scripts/cli-smoke.ts`: built-binary command/help smoke harness.

## Cross-Invocation State

Process-local state from the old long-lived frontend is externalized under `~/.local/state/saarthi/`:

- grid session: persisted by `grid show`, refreshed by cell commands, removed by `grid hide`
- launch timestamps: locked, pruned to the trailing minute, and atomically rewritten
- session id: read from `SAARTHI_SESSION_ID`, otherwise generated per invocation
- overlay task: persisted by task start/ping/complete

State and status snapshots use unique temporary files plus rename. Launch rate-limit updates also use a filesystem lock to prevent separate processes from racing through the policy cap.

## Output And Errors

Human output uses the first text result. `--json` emits `structuredContent` verbatim. Screenshot commands write PNG files and include a path; they never emit inline base64 image content.

Validation failures exit `2`. Hyprland, screenshot, input, OCR, app-launch, action-timeout, and tmux failures map to stable non-zero categories defined in `src/cli/execute.ts`.

## Safety Boundaries

- `config/policy.json` controls app aliases, blocked command patterns, launch caps, and workspace bounds.
- All mutating handlers retain audit events and act-then-verify behavior.
- Window actions resolve live Hyprland state and reject missing/hidden targets.
- Dispatcher construction is centralized in `src/lib/hyprland.ts` and uses Hyprland 0.55+ Lua expressions.
- `hyprctl` stdout beginning with `error:` is a failure even when its process exit code is zero.

## Test Architecture

- Pure adapter tests verify domain behavior without coupling to CLI internals.
- CLI tests exercise public argv, stdout/stderr, JSON, help, coercion, positional arguments, and exit codes.
- State/status tests use real temporary files and independent limiter instances.
- `test/registry-contract.test.ts` snapshots all 69 registry keys and rejects command collisions.
- `scripts/cli-smoke.ts` drives the built binary, checks help for every command, and invokes every read-only command with `--json` against deterministic system-boundary fixtures.

## Browser and perception adapters

`browser-catalog.ts` defines known browser classes, desktop ids, and launcher candidates. `browser-control.ts` owns target resolution, policy-approved launch, focus checks, and readiness. `browser-zen.ts` retains compatibility exports and Zen shortcut conversion; Zen workspace stepping remains browser-specific.

Socket discovery is shared by a single promise within each CLI invocation. Polls always fetch fresh compositor state. A failed read invalidates discovery for the next call, and mutations are never replayed automatically. Hyprland subprocesses have 3-second timeouts and 4 MiB output limits. Executable discovery searches PATH with filesystem checks instead of spawning `which`.

Typing shares one stdin-based `wtype` adapter across input, browser, and composite commands. Screenshot setup is inside the workspace-restoration scope. Screenshot, OCR, and image-comparison subprocesses have 10-second timeouts. These are per-operation limits; outer polling deadlines do not preempt an in-progress subprocess.

AT-SPI queries require both visible and showing states for on-screen results, reject defunct/stale nodes, and bound visited nodes independently of matched results. Failed focused-app PID resolution is an error. Phrase OCR joins only adjacent words on the same Tesseract line, applies the minimum word confidence, and validates geometry before returning click targets.

## Semantic input and clipboard

`ui act`, `ui read-text`, and bounded `ui batch` resolve exact elements through a live window PID and matched accessible frame. GTK Wayland frame-relative extents are translated to compositor coordinates. Each step checks current focus and accessibility states. Text enters the Python helper over stdin and is verified with the explicit AT-SPI Text interface. Batch errors include the completed count and do not replay work.

`clipboard images` returns metadata only. Exports use private directories and verified image signatures. Scoped pastes require a focused editable element, compare clipboard hashes before input, and restore one preferred original MIME payload or an empty selection. A detected external copy takes precedence over restoration. Full MIME-offer preservation and clipboard-history rollback are outside this implementation.

The CLI wraps mutating dispatch in an advisory kernel `flock` lease held by a child whose stdin belongs to the invoking process. Closing that pipe, including parent death, releases the lease. Conflicts return `INPUT_BUSY`, exit 18. Nested actions inherit ownership. Supported input subprocesses receive the lease abort signal. This serializes Saarthi processes, not all desktop participants.
