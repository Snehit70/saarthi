import {
  activeWindow,
  filterWindowsByQuery,
  getWindowOrThrow,
  HyprlandError,
  listMonitors,
  listWindows,
} from "./hyprland.js";
import { cellToRelativePoint as gridCellToRelativePoint } from "./grid.js";
import { sleep } from "./util.js";
import type { WindowId } from "./types.js";

export type PointerTarget = "full" | "monitor" | "active_window" | "window";

export interface ResolvedPointer {
  x: number;
  y: number;
  target: PointerTarget;
  monitorName: string | null;
  windowId: WindowId | null;
}

export interface GridSession {
  id: string;
  createdAt: string;
  target: PointerTarget;
  monitorName: string | null;
  windowId: WindowId | null;
  sourcePath: string;
  gridPath: string;
  width: number;
  height: number;
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  originAbsoluteX: number;
  originAbsoluteY: number;
}

export function cellToRelativePoint(session: GridSession, cellId: number): { x: number; y: number; row: number; col: number } {
  return gridCellToRelativePoint(session.cols, session.rows, session.width, session.height, cellId);
}

export async function resolveTargetOrigin(
  target: PointerTarget,
  monitorName?: string,
  windowId?: WindowId,
): Promise<{ originX: number; originY: number; resolvedMonitorName: string | null; resolvedWindowId: WindowId | null }> {
  if (target === "full") {
    return { originX: 0, originY: 0, resolvedMonitorName: null, resolvedWindowId: null };
  }
  if (target === "monitor") {
    const monitors = await listMonitors();
    const mon = monitorName ? monitors.find((m) => m.name === monitorName) : monitors.find((m) => m.focused);
    if (!mon) throw new HyprlandError("WINDOW_NOT_FOUND", monitorName ? `Monitor not found: ${monitorName}` : "Focused monitor not found");
    return { originX: mon.x, originY: mon.y, resolvedMonitorName: mon.name, resolvedWindowId: null };
  }
  if (target === "active_window") {
    const win = await activeWindow();
    if (!win) throw new HyprlandError("ACTIVE_WINDOW_MISSING", "No active window available for target 'active_window'");
    return { originX: win.position.x, originY: win.position.y, resolvedMonitorName: null, resolvedWindowId: win.id };
  }
  if (!windowId) throw new HyprlandError("WINDOW_NOT_FOUND", "windowId is required when target is 'window'");
  const win = await getWindowOrThrow(windowId);
  return { originX: win.position.x, originY: win.position.y, resolvedMonitorName: null, resolvedWindowId: win.id };
}

export interface TargetBounds {
  originX: number;
  originY: number;
  width: number;
  height: number;
  resolvedTarget: string;
}

export async function resolveTargetBounds(
  target: PointerTarget,
  monitorName?: string,
  windowId?: WindowId,
): Promise<TargetBounds> {
  const monitors = await listMonitors();
  if (target === "full") {
    if (monitors.length === 0) throw new HyprlandError("WINDOW_NOT_FOUND", "No monitors found");
    const minX = Math.min(...monitors.map((m) => m.x));
    const minY = Math.min(...monitors.map((m) => m.y));
    const maxX = Math.max(...monitors.map((m) => m.x + m.width));
    const maxY = Math.max(...monitors.map((m) => m.y + m.height));
    return { originX: minX, originY: minY, width: maxX - minX, height: maxY - minY, resolvedTarget: "full" };
  }
  if (target === "monitor") {
    const mon = monitorName ? monitors.find((m) => m.name === monitorName) : monitors.find((m) => m.focused);
    if (!mon) throw new HyprlandError("WINDOW_NOT_FOUND", monitorName ? `Monitor not found: ${monitorName}` : "Focused monitor not found");
    return { originX: mon.x, originY: mon.y, width: mon.width, height: mon.height, resolvedTarget: `monitor:${mon.name}` };
  }
  if (target === "active_window") {
    const win = await activeWindow();
    if (!win) throw new HyprlandError("ACTIVE_WINDOW_MISSING", "No active window available");
    return {
      originX: win.position.x,
      originY: win.position.y,
      width: win.size.width,
      height: win.size.height,
      resolvedTarget: `window:${win.id}`,
    };
  }
  if (!windowId) throw new HyprlandError("WINDOW_NOT_FOUND", "windowId is required when target is 'window'");
  const win = await getWindowOrThrow(windowId);
  return {
    originX: win.position.x,
    originY: win.position.y,
    width: win.size.width,
    height: win.size.height,
    resolvedTarget: `window:${win.id}`,
  };
}

export async function ensureGridSessionFresh(session: GridSession): Promise<GridSession> {
  if (session.target === "window") {
    if (!session.windowId) throw new HyprlandError("WINDOW_NOT_FOUND", "Grid session window target missing windowId");
    const win = await getWindowOrThrow(session.windowId);
    return {
      ...session,
      originAbsoluteX: win.position.x,
      originAbsoluteY: win.position.y,
      width: win.size.width,
      height: win.size.height,
      cellWidth: win.size.width / session.cols,
      cellHeight: win.size.height / session.rows,
      windowId: win.id,
    };
  }
  if (session.target === "active_window") {
    const win = await activeWindow();
    if (!win) throw new HyprlandError("ACTIVE_WINDOW_MISSING", "No active window for active_window grid session");
    if (session.windowId && session.windowId !== win.id) {
      throw new HyprlandError("WINDOW_NOT_ACTIONABLE", `Active window changed during grid session (expected ${session.windowId}, got ${win.id})`);
    }
    return {
      ...session,
      originAbsoluteX: win.position.x,
      originAbsoluteY: win.position.y,
      width: win.size.width,
      height: win.size.height,
      cellWidth: win.size.width / session.cols,
      cellHeight: win.size.height / session.rows,
      windowId: win.id,
    };
  }
  if (session.target === "monitor") {
    const monitors = await listMonitors();
    const mon = session.monitorName ? monitors.find((m) => m.name === session.monitorName) : monitors.find((m) => m.focused);
    if (!mon) throw new HyprlandError("WINDOW_NOT_FOUND", session.monitorName ? `Monitor not found: ${session.monitorName}` : "Focused monitor not found");
    return {
      ...session,
      originAbsoluteX: mon.x,
      originAbsoluteY: mon.y,
      width: mon.width,
      height: mon.height,
      cellWidth: mon.width / session.cols,
      cellHeight: mon.height / session.rows,
      monitorName: mon.name,
    };
  }
  const bounds = await resolveTargetBounds("full");
  return {
    ...session,
    originAbsoluteX: bounds.originX,
    originAbsoluteY: bounds.originY,
    width: bounds.width,
    height: bounds.height,
    cellWidth: bounds.width / session.cols,
    cellHeight: bounds.height / session.rows,
  };
}

export async function resolvePointerCoordinates(
  x: number,
  y: number,
  target: PointerTarget,
  monitorName?: string,
  windowId?: WindowId,
): Promise<ResolvedPointer> {
  if (target === "full") {
    return { x, y, target, monitorName: null, windowId: null };
  }

  if (target === "window") {
    if (!windowId) {
      throw new HyprlandError("WINDOW_NOT_FOUND", "windowId is required when target is 'window'");
    }
    const win = await getWindowOrThrow(windowId);
    return {
      x: win.position.x + x,
      y: win.position.y + y,
      target,
      monitorName: null,
      windowId: win.id,
    };
  }

  if (target === "active_window") {
    const win = await activeWindow();
    if (!win) {
      throw new HyprlandError("ACTIVE_WINDOW_MISSING", "No active window available for target 'active_window'");
    }
    return {
      x: win.position.x + x,
      y: win.position.y + y,
      target,
      monitorName: null,
      windowId: win.id,
    };
  }

  const monitors = await listMonitors();
  const mon = monitorName ? monitors.find((m) => m.name === monitorName) : monitors.find((m) => m.focused);
  if (!mon) {
    throw new HyprlandError("WINDOW_NOT_FOUND", monitorName ? `Monitor not found: ${monitorName}` : "Focused monitor not found");
  }
  return {
    x: mon.x + x,
    y: mon.y + y,
    target,
    monitorName: mon.name,
    windowId: null,
  };
}

export async function waitForWindow(
  query: {
    classEquals?: string;
    classContains?: string;
    titleContains?: string;
    workspace?: string;
    focusedOnly?: boolean;
    includeHidden?: boolean;
  },
  timeoutMs: number,
  pollMs: number,
): Promise<{ found: Awaited<ReturnType<typeof listWindows>>[number] | null; attempts: number }> {
  const started = Date.now();
  let attempts = 0;
  while (Date.now() - started <= timeoutMs) {
    attempts += 1;
    const windows = await listWindows({ workspace: query.workspace, includeHidden: query.includeHidden ?? false });
    const matches = filterWindowsByQuery(windows, query);
    if (matches.length > 0) {
      return { found: matches[0], attempts };
    }
    await sleep(pollMs);
  }
  return { found: null, attempts };
}
