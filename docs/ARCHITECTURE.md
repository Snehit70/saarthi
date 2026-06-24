# Saarthi Architecture

## Runtime Model

Saarthi is an installed Node.js CLI for one local Hyprland user session. Each `saarthi <noun> <verb>` invocation is a fresh process. There is no daemon, MCP transport, HTTP endpoint, remote bridge, arbitrary shell tool, or clipboard tool.

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
- `src/handlers/*`: 62 command handlers grouped by domain.
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
- `test/registry-contract.test.ts` snapshots all 62 registry keys and rejects command collisions.
- `scripts/cli-smoke.ts` drives the built binary, checks help for every command, and invokes every read-only command with `--json` against deterministic system-boundary fixtures.
