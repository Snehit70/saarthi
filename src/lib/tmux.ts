import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commandExists, sleep } from "./util.js";

const execFileAsync = promisify(execFile);

export type TmuxErrorCode =
  | "TMUX_UNAVAILABLE"
  | "TMUX_NO_SERVER"
  | "TMUX_TARGET_NOT_FOUND"
  | "TMUX_TARGET_AMBIGUOUS"
  | "TMUX_PANE_BUSY"
  | "TMUX_COMMAND_TIMEOUT"
  | "TMUX_FAILED";

export class TmuxError extends Error {
  constructor(
    public readonly code: TmuxErrorCode,
    message: string,
    public readonly candidates?: string[],
  ) {
    super(message);
    this.name = "TmuxError";
  }
}

// Shells whose prompt we can drive with a shell command + exit-code sentinel.
// Anything else in pane_current_command means the pane is running a foreground
// program (editor, REPL, ssh, pager, dev server) and must not be auto-driven.
const KNOWN_SHELLS = new Set(["bash", "zsh", "fish", "sh", "dash", "ksh", "ash"]);

// Conservative allowlist of obviously non-mutating commands. Classification is
// advisory metadata (surfaced to the agent and audit); the skill decides when to
// pause for consent. Anything not here is reported as "mutating".
const SAFE_COMMANDS = new Set([
  "ls", "ll", "la", "pwd", "cat", "bat", "echo", "printf", "whoami", "date",
  "uname", "id", "env", "printenv", "which", "type", "head", "tail", "wc",
  "grep", "rg", "ag", "ack", "fd", "find", "ps", "df", "du", "free", "uptime",
  "hostname", "stat", "file", "tree", "jq", "yq", "column", "sort", "uniq",
  "history", "tldr", "man", "test", "true", "false", "sleep", "seq",
  "pytest", "jest", "vitest", "tsc", "eslint", "mypy", "ruff", "cargo-check",
]);

// git subcommands that only read repository state.
const SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "blame", "describe", "remote", "branch",
  "tag", "stash", "shortlog", "reflog", "rev-parse", "ls-files", "config",
]);

export interface TmuxPane {
  session: string;
  windowIndex: number;
  windowName: string;
  windowActive: boolean;
  paneIndex: number;
  paneId: string; // %N
  target: string; // session:window.pane
  active: boolean;
  sessionAttached: boolean;
  command: string; // pane_current_command
  pid: number;
  title: string;
  width: number;
  height: number;
  cwd: string;
  isShell: boolean;
}

export interface TmuxSession {
  name: string;
  attached: boolean;
  windows: number;
}

const FIELD_SEP = "\u241f"; // U+241F glyph: printable, survives tmux's octal-escaping of control bytes, never appears in pane data
const PANE_FORMAT = [
  "#{session_name}",
  "#{window_index}",
  "#{window_name}",
  "#{window_active}",
  "#{pane_index}",
  "#{pane_id}",
  "#{pane_active}",
  "#{session_attached}",
  "#{pane_current_command}",
  "#{pane_pid}",
  "#{pane_title}",
  "#{pane_width}",
  "#{pane_height}",
  "#{pane_current_path}",
].join(FIELD_SEP);

export async function tmuxAvailable(): Promise<boolean> {
  return commandExists("tmux");
}

async function runTmux(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("tmux", args);
    return stdout;
  } catch (err) {
    const stderr = String((err as { stderr?: string })?.stderr ?? (err as Error)?.message ?? "");
    if (/no server running|error connecting/i.test(stderr)) {
      throw new TmuxError("TMUX_NO_SERVER", "No tmux server is running");
    }
    if (/command not found|ENOENT/i.test(stderr)) {
      throw new TmuxError("TMUX_UNAVAILABLE", "tmux is not installed");
    }
    throw new TmuxError("TMUX_FAILED", stderr.trim() || "tmux command failed");
  }
}

/** Parse the delimited output of `tmux list-panes -a` into structured panes. */
export function parsePanesOutput(stdout: string): TmuxPane[] {
  const panes: TmuxPane[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = line.split(FIELD_SEP);
    if (f.length < 14) continue;
    const session = f[0]!;
    const windowIndex = Number(f[1]);
    const paneIndex = Number(f[4]);
    const command = f[8]!;
    panes.push({
      session,
      windowIndex,
      windowName: f[2]!,
      windowActive: f[3] === "1",
      paneIndex,
      paneId: f[5]!,
      target: `${session}:${windowIndex}.${paneIndex}`,
      active: f[6] === "1",
      sessionAttached: f[7] === "1",
      command,
      pid: Number(f[9]),
      title: f[10]!,
      width: Number(f[11]),
      height: Number(f[12]),
      cwd: f[13]!,
      isShell: KNOWN_SHELLS.has(command),
    });
  }
  return panes;
}

export async function listPanes(): Promise<TmuxPane[]> {
  const stdout = await runTmux(["list-panes", "-a", "-F", PANE_FORMAT]);
  return parsePanesOutput(stdout);
}

export function sessionsFromPanes(panes: TmuxPane[]): TmuxSession[] {
  const byName = new Map<string, TmuxSession>();
  const windows = new Map<string, Set<number>>();
  for (const p of panes) {
    if (!byName.has(p.session)) {
      byName.set(p.session, { name: p.session, attached: p.sessionAttached, windows: 0 });
      windows.set(p.session, new Set());
    }
    if (p.sessionAttached) byName.get(p.session)!.attached = true;
    windows.get(p.session)!.add(p.windowIndex);
  }
  for (const [name, session] of byName) session.windows = windows.get(name)!.size;
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve a free-form target to a single pane (Q5):
 *  1. explicit `session:window.pane`, `session:window`, or pane id `%N`
 *  2. a bare session name -> that session's active pane
 *  3. no input -> the attached session's active pane
 * Ambiguity or no match throws so the agent can ask instead of guessing.
 */
export function resolveTarget(panes: TmuxPane[], input?: string): TmuxPane {
  const query = input?.trim();
  if (!query) {
    const attachedActive = panes.filter((p) => p.sessionAttached && p.active && p.windowActive);
    if (attachedActive.length === 1) return attachedActive[0]!;
    if (attachedActive.length === 0) {
      throw new TmuxError(
        "TMUX_TARGET_NOT_FOUND",
        "No attached tmux session to act on. Name a session or session:window.pane.",
      );
    }
    throw new TmuxError(
      "TMUX_TARGET_AMBIGUOUS",
      "Multiple attached panes are active. Name the target explicitly.",
      attachedActive.map((p) => `${p.target} (${p.session}, ${p.command})`),
    );
  }

  // Pane id form: %N
  if (/^%\d+$/.test(query)) {
    const byId = panes.filter((p) => p.paneId === query);
    if (byId.length === 1) return byId[0]!;
    throw new TmuxError("TMUX_TARGET_NOT_FOUND", `No pane with id ${query}`);
  }

  // Explicit session:window[.pane]
  if (query.includes(":")) {
    const exact = panes.filter((p) => p.target === query);
    if (exact.length === 1) return exact[0]!;
    const [sess, rest] = query.split(":");
    const win = Number(rest?.split(".")[0]);
    const winMatches = panes.filter((p) => p.session === sess && p.windowIndex === win);
    if (winMatches.length >= 1) {
      return winMatches.find((p) => p.active) ?? winMatches[0]!;
    }
    throw new TmuxError("TMUX_TARGET_NOT_FOUND", `No pane matched target ${query}`);
  }

  // Bare session name
  const sessionPanes = panes.filter((p) => p.session === query);
  if (sessionPanes.length === 0) {
    throw new TmuxError("TMUX_TARGET_NOT_FOUND", `No tmux session named "${query}"`);
  }
  return sessionPanes.find((p) => p.active && p.windowActive) ?? sessionPanes.find((p) => p.active) ?? sessionPanes[0]!;
}

/** Advisory classification of a command line as a read-only "safe" command or "mutating". */
export function classifyCommand(command: string): "safe" | "mutating" {
  const trimmed = command.trim();
  if (!trimmed) return "safe";
  // A pipeline/chain is only as safe as all its segments.
  const segments = trimmed.split(/\s*(?:\|\||&&|;|\||\n)\s*/).filter(Boolean);
  if (segments.length > 1) {
    return segments.every((seg) => classifyCommand(seg) === "safe") ? "safe" : "mutating";
  }
  const tokens = trimmed.split(/\s+/);
  let i = 0;
  // Skip leading VAR=value assignments and `env`.
  while (tokens[i] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i += 1;
  const head = tokens[i];
  if (!head) return "safe";
  const base = head.replace(/^.*\//, ""); // strip path
  if (base === "sudo" || base === "doas") return "mutating";
  if (base === "git") {
    const sub = tokens[i + 1];
    return sub && SAFE_GIT_SUBCOMMANDS.has(sub) ? "safe" : "mutating";
  }
  return SAFE_COMMANDS.has(base) ? "safe" : "mutating";
}

export interface CaptureOptions {
  lines?: number; // tail of output to return
  scrollback?: number; // how far back to read (0 = visible only)
}

export async function capturePane(target: string, opts: CaptureOptions = {}): Promise<string> {
  const args = ["capture-pane", "-p", "-t", target];
  if (opts.scrollback && opts.scrollback > 0) args.push("-S", `-${opts.scrollback}`);
  const raw = (await runTmux(args)).replace(/\s+$/, "");
  if (opts.lines && opts.lines > 0) {
    return raw.split("\n").slice(-opts.lines).join("\n");
  }
  return raw;
}

export interface SendKeysOptions {
  enter?: boolean;
  literal?: boolean; // send as literal text (default) vs key names (Enter, C-c)
  confirmBusy?: boolean;
}

export async function sendKeys(pane: TmuxPane, keys: string, opts: SendKeysOptions = {}): Promise<void> {
  if (!pane.isShell && !opts.confirmBusy) {
    throw new TmuxError(
      "TMUX_PANE_BUSY",
      `Pane ${pane.target} is running "${pane.command}", not a shell. Confirm before sending keys.`,
    );
  }
  const args = ["send-keys", "-t", pane.target];
  if (opts.literal !== false) args.push("-l");
  args.push("--", keys);
  await runTmux(args);
  if (opts.enter) {
    await runTmux(["send-keys", "-t", pane.target, "Enter"]);
  }
}

export interface RunCommandOptions {
  timeoutMs?: number;
  pollMs?: number;
  scrollback?: number;
  maxOutputLines?: number;
  confirmBusy?: boolean;
}

export interface RunCommandResult {
  target: string;
  command: string;
  classification: "safe" | "mutating";
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  interrupted: boolean;
  durationMs: number;
}

/**
 * Run a shell command in a pane and wait for completion via start/end sentinels
 * (Q6). The exit code is parsed from the end marker; output is the text strictly
 * between the markers. fish uses $status, not $? . On timeout, sends C-c to the
 * command it started (Q7) and returns the captured tail.
 */
export async function runCommand(
  pane: TmuxPane,
  command: string,
  opts: RunCommandOptions = {},
): Promise<RunCommandResult> {
  if (!pane.isShell && !opts.confirmBusy) {
    throw new TmuxError(
      "TMUX_PANE_BUSY",
      `Pane ${pane.target} is running "${pane.command}", not a shell. Confirm before running a command here.`,
    );
  }
  const timeoutMs = opts.timeoutMs ?? 120000;
  const pollMs = opts.pollMs ?? 250;
  const scrollback = opts.scrollback ?? 3000;
  const started = Date.now();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const startMark = `__SAARTHI_${id}_START__`;
  const endHead = `__SAARTHI_${id}_END_`;
  const endRe = new RegExp(`${endHead}(\\d+|[A-Za-z_]+)__`);
  const codeVar = pane.command === "fish" ? "$status" : '"$?"';

  // Leading space keeps the wrapped line out of history where HIST_IGNORE_SPACE
  // is set; the start/end markers bracket the real output for clean extraction.
  const wrapped =
    ` printf '\\n${startMark}\\n'; ${command}; printf '${endHead}%s__\\n' ${codeVar}`;

  await runTmux(["send-keys", "-t", pane.target, "-l", "--", wrapped]);
  await runTmux(["send-keys", "-t", pane.target, "Enter"]);

  let interrupted = false;
  while (Date.now() - started < timeoutMs) {
    await sleep(pollMs);
    const buf = await capturePane(pane.target, { scrollback });
    const match = buf.match(endRe);
    if (match) {
      const exit = Number(match[1]);
      return {
        target: pane.target,
        command,
        classification: classifyCommand(command),
        exitCode: Number.isFinite(exit) ? exit : null,
        output: extractBetween(buf, startMark, endHead),
        timedOut: false,
        interrupted: false,
        durationMs: Date.now() - started,
      };
    }
  }

  // Timed out: interrupt the command we started, then return the tail.
  await runTmux(["send-keys", "-t", pane.target, "C-c"]).catch(() => undefined);
  interrupted = true;
  const tail = await capturePane(pane.target, { scrollback, lines: opts.maxOutputLines ?? 60 });
  return {
    target: pane.target,
    command,
    classification: classifyCommand(command),
    exitCode: null,
    output: tail,
    timedOut: true,
    interrupted,
    durationMs: Date.now() - started,
  };
}

/** Return the text strictly between the last start marker and the following end marker. */
function extractBetween(buf: string, startMark: string, endHead: string): string {
  const lines = buf.split("\n");
  let startIdx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]!.includes(startMark)) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return "";
  const out: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (lines[i]!.includes(endHead)) break;
    out.push(lines[i]!);
  }
  return out.join("\n").replace(/\s+$/, "");
}
