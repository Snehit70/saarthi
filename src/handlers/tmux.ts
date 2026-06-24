import { z } from "zod";
import { audit } from "../lib/audit.js";
import {
  capturePane,
  classifyCommand,
  listPanes,
  resolveTarget,
  runCommand,
  sendKeys,
  sessionsFromPanes,
  TmuxError,
  tmuxAvailable,
} from "../lib/tmux.js";
import { server } from "../registry.js";
import { dryRun } from "../runtime.js";

function tmuxErrorCode(err: unknown): string {
  return err instanceof TmuxError ? err.code : "TMUX_FAILED";
}

async function ensureTmux(): Promise<void> {
  if (!(await tmuxAvailable())) {
    throw new TmuxError("TMUX_UNAVAILABLE", "tmux is not installed on this machine");
  }
}

server.registerTool(
  "tmux_list",
  {
    title: "tmux List",
    description:
      "List all tmux sessions, windows, and panes with each pane's running command (pane_current_command), active flags, size, and cwd. Read-only; the primary way to discover targets without focusing any window.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    await ensureTmux();
    const panes = await listPanes();
    const sessions = sessionsFromPanes(panes);
    return {
      content: [{ type: "text", text: JSON.stringify({ sessions, panes }, null, 2) }],
      structuredContent: { sessions, panes },
    };
  },
);

server.registerTool(
  "tmux_capture",
  {
    title: "tmux Capture Pane",
    description:
      "Capture the visible text (and optional scrollback) of a tmux pane. Use this instead of screenshots/OCR to read terminal state. Read-only.",
    inputSchema: {
      target: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("session:window.pane, session:window, %paneId, a session name, or omit for the attached active pane"),
      lines: z.number().int().min(1).max(5000).optional().describe("return only the last N lines"),
      scrollback: z.number().int().min(0).max(50000).default(0).describe("lines of scrollback to include (0 = visible only)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ target, lines, scrollback }) => {
    await ensureTmux();
    const panes = await listPanes();
    const pane = resolveTarget(panes, target);
    const text = await capturePane(pane.target, { lines, scrollback });
    return {
      content: [{ type: "text", text }],
      structuredContent: { target: pane.target, command: pane.command, isShell: pane.isShell, text },
    };
  },
);

server.registerTool(
  "tmux_run_command",
  {
    title: "tmux Run Command",
    description:
      "Run a shell command in a tmux pane and wait for completion, returning the exit code and the command's output (via start/end sentinels — no prompt guessing). Refuses non-shell panes unless confirmBusy. classification is advisory: 'mutating' commands should be confirmed with the user first per the consent model; 'safe' read-only commands can run freely.",
    inputSchema: {
      command: z.string().min(1).max(8000),
      target: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("session:window.pane, session name, %paneId, or omit for the attached active pane"),
      confirmBusy: z
        .boolean()
        .default(false)
        .describe("set true only after confirming with the user that it is OK to send into a non-shell pane"),
      timeoutMs: z.number().int().min(200).max(900000).default(120000),
      pollMs: z.number().int().min(50).max(5000).default(250),
      scrollback: z.number().int().min(0).max(50000).default(3000),
      maxOutputLines: z.number().int().min(1).max(5000).default(200),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ command, target, confirmBusy, timeoutMs, pollMs, scrollback, maxOutputLines }) => {
    await ensureTmux();
    const classification = classifyCommand(command);
    const panes = await listPanes();
    const pane = resolveTarget(panes, target);

    if (dryRun) {
      await audit("tmux_run_command", { command, target: pane.target, classification }, dryRun, {
        result: "ok",
        errorCode: null,
      });
      return {
        content: [
          {
            type: "text",
            text: `DRY_RUN tmux_run_command target=${pane.target} classification=${classification} command=${command}`,
          },
        ],
        structuredContent: { ran: false, dryRun: true, target: pane.target, classification, command },
      };
    }

    try {
      const result = await runCommand(pane, command, {
        timeoutMs,
        pollMs,
        scrollback,
        maxOutputLines,
        confirmBusy,
      });
      await audit("tmux_run_command", { command, target: pane.target, classification }, dryRun, {
        result: result.timedOut ? "error" : "ok",
        errorCode: result.timedOut ? "TMUX_COMMAND_TIMEOUT" : null,
        durationMs: result.durationMs,
      });
      const lines = result.output.split("\n").slice(-maxOutputLines).join("\n");
      return {
        content: [{ type: "text", text: JSON.stringify({ ...result, output: lines }, null, 2) }],
        structuredContent: { ...result, output: lines },
      };
    } catch (err) {
      await audit("tmux_run_command", { command, target: pane.target, classification }, dryRun, {
        result: "error",
        errorCode: tmuxErrorCode(err),
      });
      throw err;
    }
  },
);

server.registerTool(
  "tmux_send_keys",
  {
    title: "tmux Send Keys",
    description:
      "Send raw keys to a tmux pane for interactive programs (REPLs, editors, pickers) or control keys. Use key names like Enter, Escape, C-c, Up when literal=false; literal text when literal=true. Refuses non-shell panes unless confirmBusy. Does not wait for or parse output — use tmux_capture to read the result.",
    inputSchema: {
      keys: z.string().min(1).max(8000),
      target: z.string().min(1).max(200).optional(),
      literal: z.boolean().default(true).describe("true: send as literal text; false: interpret as tmux key names (Enter, C-c, Up)"),
      enter: z.boolean().default(false).describe("press Enter after sending"),
      confirmBusy: z.boolean().default(false),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ keys, target, literal, enter, confirmBusy }) => {
    await ensureTmux();
    const panes = await listPanes();
    const pane = resolveTarget(panes, target);

    if (dryRun) {
      await audit("tmux_send_keys", { target: pane.target, literal, enter }, dryRun, { result: "ok", errorCode: null });
      return {
        content: [{ type: "text", text: `DRY_RUN tmux_send_keys target=${pane.target} literal=${literal} enter=${enter}` }],
        structuredContent: { sent: false, dryRun: true, target: pane.target },
      };
    }

    try {
      await sendKeys(pane, keys, { literal, enter, confirmBusy });
      await audit("tmux_send_keys", { target: pane.target, literal, enter }, dryRun, { result: "ok", errorCode: null });
      return {
        content: [{ type: "text", text: JSON.stringify({ sent: true, target: pane.target, enter }, null, 2) }],
        structuredContent: { sent: true, target: pane.target, enter },
      };
    } catch (err) {
      await audit("tmux_send_keys", { target: pane.target, literal, enter }, dryRun, {
        result: "error",
        errorCode: tmuxErrorCode(err),
      });
      throw err;
    }
  },
);
