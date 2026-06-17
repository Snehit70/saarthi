import { z } from "zod";
import { audit } from "../lib/audit.js";
import {
  clampAbsolutePointToMonitor,
  clampAbsoluteSizeToMonitor,
  clampMoveResize,
  filterWindowsByQuery,
  focusWindow,
  focusedWorkspaceName,
  getWindowOrThrow,
  HyprlandError,
  listMonitors,
  listWindows,
  moveWindow,
  monitorForWindow,
  resizeWindow,
  sendWindowToWorkspace,
  moveWindowParams,
  resizeWindowExpression,
  sendWindowToWorkspaceParams,
} from "../lib/hyprland.js";
import type { WindowId } from "../lib/types.js";
import { toNumberOrNull } from "../lib/util.js";
import { waitForWindow } from "../lib/pointer.js";
import { server } from "../server.js";
import { dryRun } from "../runtime.js";

server.registerTool(
  "window_list",
  {
    title: "Window List",
    description: "List windows in Hyprland with filters.",
    inputSchema: {
      workspace: z.string().optional(),
      includeHidden: z.boolean().default(false),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ workspace, includeHidden }) => {
    const windows = await listWindows({ workspace, includeHidden });
    return {
      content: [{ type: "text", text: JSON.stringify(windows, null, 2) }],
      structuredContent: { windows },
    };
  },
);

server.registerTool(
  "window_get",
  {
    title: "Window Get",
    description: "Get one actionable window by Hyprland id.",
    inputSchema: {
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ windowId }) => {
    const window = await getWindowOrThrow(windowId as WindowId);
    return {
      content: [{ type: "text", text: JSON.stringify(window, null, 2) }],
      structuredContent: { window },
    };
  },
);

server.registerTool(
  "window_find",
  {
    title: "Window Find",
    description: "Find windows by class/title/workspace filters for agent chaining.",
    inputSchema: {
      classEquals: z.string().optional(),
      classContains: z.string().optional(),
      titleContains: z.string().optional(),
      workspace: z.string().optional(),
      focusedOnly: z.boolean().default(false),
      includeHidden: z.boolean().default(false),
      limit: z.number().int().positive().max(20).default(5),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ classEquals, classContains, titleContains, workspace, focusedOnly, includeHidden, limit }) => {
    const windows = await listWindows({ workspace, includeHidden });
    const matches = filterWindowsByQuery(windows, {
      classEquals,
      classContains,
      titleContains,
      workspace,
      focusedOnly,
      includeHidden,
    }).slice(0, limit);
    return {
      content: [{ type: "text", text: JSON.stringify(matches, null, 2) }],
      structuredContent: { windows: matches, count: matches.length },
    };
  },
);

server.registerTool(
  "window_focus_best",
  {
    title: "Window Focus Best",
    description: "Find matching windows, rank candidates, and focus the best one.",
    inputSchema: {
      classEquals: z.string().optional(),
      classContains: z.string().optional(),
      titleContains: z.string().optional(),
      workspace: z.string().optional(),
      includeHidden: z.boolean().default(false),
      preferredWorkspace: z.string().optional(),
      preferredMonitor: z.string().optional(),
      limit: z.number().int().positive().max(20).default(5),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ classEquals, classContains, titleContains, workspace, includeHidden, preferredWorkspace, preferredMonitor, limit }) => {
    const [windows, monitors, focusedWorkspace] = await Promise.all([
      listWindows({ workspace, includeHidden }),
      listMonitors(),
      focusedWorkspaceName(),
    ]);
    const monitorById = new Map(monitors.map((m) => [m.id, m]));
    const matches = filterWindowsByQuery(windows, {
      classEquals,
      classContains,
      titleContains,
      workspace,
      focusedOnly: false,
      includeHidden,
    });
    if (matches.length === 0) {
      throw new HyprlandError("WINDOW_NOT_FOUND", "No matching window found");
    }
    const scored = matches.map((w) => {
      let score = 0;
      if (w.focused) score += 100;
      if (preferredWorkspace && w.workspace === preferredWorkspace) score += 70;
      if (preferredMonitor && monitorById.get(w.monitor)?.name === preferredMonitor) score += 60;
      if (!preferredWorkspace && focusedWorkspace && w.workspace === focusedWorkspace) score += 40;
      if (!w.hidden && w.mapped) score += 20;
      if (classEquals && w.class === classEquals) score += 20;
      if (classContains && w.class.toLowerCase().includes(classContains.toLowerCase())) score += 8;
      if (titleContains && w.title.toLowerCase().includes(titleContains.toLowerCase())) score += 8;
      const wsNum = toNumberOrNull(w.workspace);
      if (wsNum !== null) score += Math.max(0, 10 - wsNum);
      return { window: w, score, monitorName: monitorById.get(w.monitor)?.name ?? null };
    });
    scored.sort((a, b) => b.score - a.score);
    const actionable: typeof scored = [];
    for (const candidate of scored) {
      try {
        await getWindowOrThrow(candidate.window.id);
        actionable.push(candidate);
      } catch {
        // Keep candidate in ranked list for diagnostics, but skip for focus action.
      }
    }
    if (actionable.length === 0) {
      throw new HyprlandError(
        "WINDOW_NOT_ACTIONABLE",
        `No actionable match found (candidates=${scored.length}, actionable=0)`,
      );
    }
    const best = actionable[0];
    await audit(
      "window_focus_best",
      {
        query: { classEquals: classEquals ?? null, classContains: classContains ?? null, titleContains: titleContains ?? null, workspace: workspace ?? null },
        preferredWorkspace: preferredWorkspace ?? null,
        preferredMonitor: preferredMonitor ?? null,
        bestWindowId: best.window.id,
        score: best.score,
        candidateCount: scored.length,
        actionableCount: actionable.length,
      },
      dryRun,
    );
    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN focus window ${best.window.id}` }],
        structuredContent: {
          focused: false,
          best: { ...best, windowId: best.window.id },
          candidates: scored.slice(0, limit),
          actionableCandidates: actionable.slice(0, limit),
        },
      };
    }
    await focusWindow(best.window.id);
    return {
      content: [{ type: "text", text: JSON.stringify({ focused: true, window: best.window, score: best.score }, null, 2) }],
      structuredContent: {
        focused: true,
        best,
        candidates: scored.slice(0, limit),
        actionableCandidates: actionable.slice(0, limit),
      },
    };
  },
);

server.registerTool(
  "window_wait_for",
  {
    title: "Window Wait For",
    description: "Wait for a matching window to appear.",
    inputSchema: {
      classEquals: z.string().optional(),
      classContains: z.string().optional(),
      titleContains: z.string().optional(),
      workspace: z.string().optional(),
      focusedOnly: z.boolean().default(false),
      includeHidden: z.boolean().default(false),
      timeoutMs: z.number().int().min(100).max(120000).default(10000),
      pollMs: z.number().int().min(50).max(5000).default(200),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ classEquals, classContains, titleContains, workspace, focusedOnly, includeHidden, timeoutMs, pollMs }) => {
    const { found, attempts } = await waitForWindow(
      { classEquals, classContains, titleContains, workspace, focusedOnly, includeHidden },
      timeoutMs,
      pollMs,
    );
    if (!found) {
      throw new HyprlandError("WINDOW_NOT_FOUND", `No matching window appeared within ${timeoutMs}ms`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ window: found, attempts }, null, 2) }],
      structuredContent: { window: found, attempts },
    };
  },
);

server.registerTool(
  "action_verify_window_state",
  {
    title: "Action Verify Window State",
    description: "Verify that a window is in expected state.",
    inputSchema: {
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/),
      expectedWorkspace: z.string().optional(),
      expectedFocused: z.boolean().optional(),
      expectedX: z.number().optional(),
      expectedY: z.number().optional(),
      expectedWidth: z.number().optional(),
      expectedHeight: z.number().optional(),
      tolerancePx: z.number().int().min(0).max(200).default(4),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ windowId, expectedWorkspace, expectedFocused, expectedX, expectedY, expectedWidth, expectedHeight, tolerancePx }) => {
    const w = await getWindowOrThrow(windowId as WindowId);
    const mismatches: string[] = [];
    if (expectedWorkspace !== undefined && w.workspace !== expectedWorkspace) mismatches.push(`workspace expected=${expectedWorkspace} actual=${w.workspace}`);
    if (expectedFocused !== undefined && w.focused !== expectedFocused) mismatches.push(`focused expected=${expectedFocused} actual=${w.focused}`);
    if (expectedX !== undefined && Math.abs(w.position.x - expectedX) > tolerancePx) mismatches.push(`x expected=${expectedX} actual=${w.position.x}`);
    if (expectedY !== undefined && Math.abs(w.position.y - expectedY) > tolerancePx) mismatches.push(`y expected=${expectedY} actual=${w.position.y}`);
    if (expectedWidth !== undefined && Math.abs(w.size.width - expectedWidth) > tolerancePx) mismatches.push(`width expected=${expectedWidth} actual=${w.size.width}`);
    if (expectedHeight !== undefined && Math.abs(w.size.height - expectedHeight) > tolerancePx) mismatches.push(`height expected=${expectedHeight} actual=${w.size.height}`);
    const ok = mismatches.length === 0;
    return {
      content: [{ type: "text", text: JSON.stringify({ ok, mismatches, window: w }, null, 2) }],
      structuredContent: { ok, mismatches, window: w },
    };
  },
);

server.registerTool(
  "window_focus",
  {
    title: "Window Focus",
    description: "Focus a window by Hyprland address.",
    inputSchema: {
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ windowId }) => {
    await getWindowOrThrow(windowId as WindowId);
    await audit("window_focus", { windowId }, dryRun);

    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN focus window ${windowId}` }],
      };
    }

    const output = await focusWindow(windowId as WindowId);
    return { content: [{ type: "text", text: output || "ok" }] };
  },
);

server.registerTool(
  "window_move",
  {
    title: "Window Move",
    description: "Move a window in absolute or delta mode.",
    inputSchema: {
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/),
      mode: z.enum(["absolute", "delta"]),
      x: z.number(),
      y: z.number(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ windowId, mode, x, y }) => {
    await getWindowOrThrow(windowId as WindowId);

    let xx: number;
    let yy: number;
    if (mode === "absolute") {
      const monitor = await monitorForWindow(windowId as WindowId);
      if (!monitor) {
        throw new HyprlandError("WINDOW_NOT_ACTIONABLE", `Could not resolve monitor for ${windowId}`);
      }
      const clamped = clampAbsolutePointToMonitor(monitor, { x, y });
      xx = clamped.x;
      yy = clamped.y;
    } else {
      xx = clampMoveResize(x);
      yy = clampMoveResize(y);
    }

    const params = moveWindowParams(windowId as WindowId, mode, xx, yy);

    await audit("window_move", { windowId, mode, x: xx, y: yy }, dryRun);

    if (dryRun) {
      return { content: [{ type: "text", text: `DRY_RUN movewindowpixel ${params}` }] };
    }

    const output = await moveWindow(windowId as WindowId, mode, xx, yy);
    return { content: [{ type: "text", text: output || "ok" }] };
  },
);

server.registerTool(
  "window_resize",
  {
    title: "Window Resize",
    description: "Resize a window in absolute or delta mode.",
    inputSchema: {
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/),
      mode: z.enum(["absolute", "delta"]),
      width: z.number().positive(),
      height: z.number().positive(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ windowId, mode, width, height }) => {
    await getWindowOrThrow(windowId as WindowId);

    let w: number;
    let h: number;
    if (mode === "absolute") {
      const monitor = await monitorForWindow(windowId as WindowId);
      if (!monitor) {
        throw new HyprlandError("WINDOW_NOT_ACTIONABLE", `Could not resolve monitor for ${windowId}`);
      }
      const clamped = clampAbsoluteSizeToMonitor(monitor, { width, height });
      w = clamped.width;
      h = clamped.height;
    } else {
      w = clampMoveResize(width, 1, 10000);
      h = clampMoveResize(height, 1, 10000);
    }

    await audit("window_resize", { windowId, mode, width: w, height: h }, dryRun);

    if (dryRun) {
      // For absolute mode, resizeWindow converts to delta at dispatch time (requires current window size).
      // Show the Lua expression template so the dry-run message matches the actual dispatch path.
      const expr = resizeWindowExpression(windowId as WindowId, mode, w, h);
      return { content: [{ type: "text", text: `DRY_RUN dispatch ${expr}${mode === "absolute" ? " (delta computed from current window size at dispatch)" : ""}` }] };
    }

    const output = await resizeWindow(windowId as WindowId, mode, w, h);
    return { content: [{ type: "text", text: output || "ok" }] };
  },
);

server.registerTool(
  "window_send_to_workspace",
  {
    title: "Window Send To Workspace",
    description: "Move a window to a target workspace.",
    inputSchema: {
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/),
      workspace: z.string().min(1),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ windowId, workspace }) => {
    await getWindowOrThrow(windowId as WindowId);
    const params = sendWindowToWorkspaceParams(windowId as WindowId, workspace);

    await audit("window_send_to_workspace", { windowId, workspace }, dryRun);

    if (dryRun) {
      return { content: [{ type: "text", text: `DRY_RUN movetoworkspace ${params}` }] };
    }

    const output = await sendWindowToWorkspace(windowId as WindowId, workspace);
    return { content: [{ type: "text", text: output || "ok" }] };
  },
);
