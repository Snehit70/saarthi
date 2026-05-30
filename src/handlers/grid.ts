import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logRunEvent } from "../lib/runlog.js";
import { HyprlandError } from "../lib/hyprland.js";
import { captureScreenshot } from "../lib/screenshot.js";
import { defaultGridForSize } from "../lib/grid.js";
import type { WindowId } from "../lib/types.js";
import { commandExists, sleep } from "../lib/util.js";
import { cellToRelativePoint, ensureGridSessionFresh, resolveTargetOrigin } from "../lib/pointer.js";
import { performMouseClick, performMouseMove } from "../lib/mouse.js";
import { server } from "../server.js";
import { gridSession, screenshotDirDefault } from "../runtime.js";

const execFileAsync = promisify(execFile);

server.registerTool(
  "grid_show",
  {
    title: "Grid Show",
    description: "Capture screenshot and render a numbered grid overlay for deterministic cell-based targeting.",
    inputSchema: {
      target: z.enum(["full", "monitor", "active_window", "window"]).default("active_window"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      cols: z.number().int().min(6).max(24).optional(),
      rows: z.number().int().min(4).max(16).optional(),
      filenamePrefix: z.string().min(1).max(64).default("grid"),
      outputDir: z.string().optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ target, monitorName, windowId, cols, rows, filenamePrefix, outputDir }) => {
    if (!(await commandExists("magick"))) {
      throw new HyprlandError("INPUT_FAILED", "ImageMagick 'magick' is required for grid_show");
    }

    const shot = await captureScreenshot({ target, monitorName, windowId: windowId as WindowId | undefined });
    const density = cols && rows ? { cols, rows } : defaultGridForSize(shot.width);
    const cellWidth = shot.width / density.cols;
    const cellHeight = shot.height / density.rows;

    const dir = outputDir ?? screenshotDirDefault;
    await mkdir(dir, { recursive: true });
    const safePrefix = filenamePrefix.replace(/[^a-zA-Z0-9._-]/g, "_");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const sourcePath = join(dir, `${stamp}-${safePrefix}-source.png`);
    const gridPath = join(dir, `${stamp}-${safePrefix}-overlay.png`);
    await writeFile(sourcePath, shot.png);

    const lineDrawArgs: string[] = [];
    for (let c = 1; c < density.cols; c += 1) {
      const x = Math.round(c * cellWidth);
      lineDrawArgs.push("-draw", `line ${x},0 ${x},${shot.height}`);
    }
    for (let r = 1; r < density.rows; r += 1) {
      const y = Math.round(r * cellHeight);
      lineDrawArgs.push("-draw", `line 0,${y} ${shot.width},${y}`);
    }

    const textDrawArgs: string[] = [];
    let cell = 1;
    for (let r = 0; r < density.rows; r += 1) {
      for (let c = 0; c < density.cols; c += 1) {
        const cx = Math.round(c * cellWidth + cellWidth / 2);
        const cy = Math.round(r * cellHeight + cellHeight / 2);
        textDrawArgs.push("-draw", `text ${cx},${cy} '${cell}'`);
        cell += 1;
      }
    }

    const renderGrid = async (withFont: boolean): Promise<void> => {
      const args = [
        sourcePath,
        "-stroke",
        "rgba(255,255,0,0.85)",
        "-strokewidth",
        "1",
        "-fill",
        "rgba(0,0,0,0.0)",
        ...lineDrawArgs,
        "-fill",
        "rgba(255,80,80,0.95)",
      ];
      if (withFont) args.push("-font", "DejaVu-Sans-Mono");
      args.push("-pointsize", "16", ...textDrawArgs, gridPath);
      await execFileAsync("magick", args);
    };
    try {
      await renderGrid(true);
    } catch {
      await renderGrid(false);
    }

    const origin = await resolveTargetOrigin(target, monitorName, windowId as WindowId | undefined);
    gridSession.current = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      target,
      monitorName: origin.resolvedMonitorName,
      windowId: origin.resolvedWindowId,
      sourcePath,
      gridPath,
      width: shot.width,
      height: shot.height,
      cols: density.cols,
      rows: density.rows,
      cellWidth,
      cellHeight,
      originAbsoluteX: origin.originX,
      originAbsoluteY: origin.originY,
    };

    await logRunEvent({
      action: "grid_show",
      sessionId: gridSession.current.id,
      target,
      monitorName: gridSession.current.monitorName,
      windowId: gridSession.current.windowId,
      cols: density.cols,
      rows: density.rows,
      sourcePath,
      gridPath,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              sessionId: gridSession.current.id,
              target,
              cols: density.cols,
              rows: density.rows,
              width: shot.width,
              height: shot.height,
              sourcePath,
              gridPath,
            },
            null,
            2,
          ),
        },
      ],
      structuredContent: {
        sessionId: gridSession.current.id,
        target,
        cols: density.cols,
        rows: density.rows,
        width: shot.width,
        height: shot.height,
        sourcePath,
        gridPath,
      },
    };
  },
);

server.registerTool(
  "grid_cell_to_point",
  {
    title: "Grid Cell To Point",
    description: "Resolve a grid cell id to relative and absolute coordinates using active grid session.",
    inputSchema: {
      cellId: z.number().int().positive(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ cellId }) => {
    if (!gridSession.current) {
      throw new HyprlandError("WINDOW_NOT_FOUND", "No active grid session. Call grid_show first.");
    }
    gridSession.current = await ensureGridSessionFresh(gridSession.current);
    const point = cellToRelativePoint(gridSession.current, cellId);
    const payload = {
      sessionId: gridSession.current.id,
      cellId,
      row: point.row + 1,
      col: point.col + 1,
      relative: { x: point.x, y: point.y },
      absolute: {
        x: gridSession.current.originAbsoluteX + point.x,
        y: gridSession.current.originAbsoluteY + point.y,
      },
      gridPath: gridSession.current.gridPath,
    };
    await logRunEvent({ action: "grid_cell_to_point", ...payload });
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  },
);

server.registerTool(
  "grid_cell_rect",
  {
    title: "Grid Cell Rect",
    description: "Return absolute rectangle bounds for a grid cell in the active grid session.",
    inputSchema: {
      cellId: z.number().int().min(1),
      insetPx: z.number().int().min(0).max(200).default(0),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ cellId, insetPx }) => {
    if (!gridSession.current) throw new HyprlandError("WINDOW_NOT_FOUND", "No active grid session. Call grid_show first.");
    const session = await ensureGridSessionFresh(gridSession.current);
    const rows = session.rows;
    const cols = session.cols;
    const maxCell = rows * cols;
    if (cellId < 1 || cellId > maxCell) {
      throw new HyprlandError("NUMERIC_INVALID", `cellId must be within 1..${maxCell}`);
    }
    const zero = cellId - 1;
    const row = Math.floor(zero / cols);
    const col = zero % cols;
    const left = Math.round(session.originAbsoluteX + col * session.cellWidth + insetPx);
    const top = Math.round(session.originAbsoluteY + row * session.cellHeight + insetPx);
    const width = Math.max(1, Math.round(session.cellWidth - insetPx * 2));
    const height = Math.max(1, Math.round(session.cellHeight - insetPx * 2));
    const rect = { x: left, y: top, width, height };
    await logRunEvent({ action: "grid_cell_rect", cellId, insetPx, rect, sessionId: session.id });
    return {
      content: [{ type: "text", text: JSON.stringify({ cellId, rect, sessionId: session.id }, null, 2) }],
      structuredContent: { cellId, rect, sessionId: session.id },
    };
  },
);

server.registerTool(
  "grid_move",
  {
    title: "Grid Move",
    description: "Move cursor to the center of a grid cell in active grid session.",
    inputSchema: {
      cellId: z.number().int().positive(),
      settleMs: z.number().int().min(0).max(3000).default(80),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ cellId, settleMs }) => {
    if (!gridSession.current) throw new HyprlandError("WINDOW_NOT_FOUND", "No active grid session. Call grid_show first.");
    gridSession.current = await ensureGridSessionFresh(gridSession.current);
    const point = cellToRelativePoint(gridSession.current, cellId);
    const absX = gridSession.current.originAbsoluteX + point.x;
    const absY = gridSession.current.originAbsoluteY + point.y;
    await performMouseMove(absX, absY);
    if (settleMs > 0) await sleep(settleMs);
    const payload = { sessionId: gridSession.current.id, cellId, absoluteX: absX, absoluteY: absY, relativeX: point.x, relativeY: point.y };
    await logRunEvent({ action: "grid_move", ...payload });
    return {
      content: [{ type: "text", text: JSON.stringify({ moved: true, ...payload }, null, 2) }],
      structuredContent: { moved: true, ...payload },
    };
  },
);

server.registerTool(
  "grid_click",
  {
    title: "Grid Click",
    description: "Click at the center of a grid cell in active grid session.",
    inputSchema: {
      cellId: z.number().int().positive(),
      button: z.enum(["left", "middle", "right"]).default("left"),
      settleMs: z.number().int().min(0).max(3000).default(120),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ cellId, button, settleMs }) => {
    if (!gridSession.current) throw new HyprlandError("WINDOW_NOT_FOUND", "No active grid session. Call grid_show first.");
    gridSession.current = await ensureGridSessionFresh(gridSession.current);
    const point = cellToRelativePoint(gridSession.current, cellId);
    const absX = gridSession.current.originAbsoluteX + point.x;
    const absY = gridSession.current.originAbsoluteY + point.y;
    await performMouseClick(absX, absY, button, settleMs);
    const payload = { sessionId: gridSession.current.id, cellId, button, absoluteX: absX, absoluteY: absY, relativeX: point.x, relativeY: point.y };
    await logRunEvent({ action: "grid_click", ...payload });
    return {
      content: [{ type: "text", text: JSON.stringify({ clicked: true, ...payload }, null, 2) }],
      structuredContent: { clicked: true, ...payload },
    };
  },
);

server.registerTool(
  "grid_hide",
  {
    title: "Grid Hide",
    description: "Clear active grid session state.",
    inputSchema: {},
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const previous = gridSession.current;
    gridSession.current = null;
    await logRunEvent({ action: "grid_hide", previousSessionId: previous?.id ?? null });
    return {
      content: [{ type: "text", text: JSON.stringify({ cleared: true, previousSessionId: previous?.id ?? null }, null, 2) }],
      structuredContent: { cleared: true, previousSessionId: previous?.id ?? null },
    };
  },
);
