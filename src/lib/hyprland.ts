import { readdir } from "node:fs/promises";
import { access, constants } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { monitorWindowBounds, parsePngDimensions } from "./image.js";
import type { HyprClient, MonitorInfo, WindowId, WindowInfo } from "./types.js";

const execFileAsync = promisify(execFile);

export type ErrorCode =
  | "NO_SOCKET"
  | "PLATFORM_UNSUPPORTED"
  | "WINDOW_NOT_FOUND"
  | "WINDOW_NOT_ACTIONABLE"
  | "ACTIVE_WINDOW_MISSING"
  | "NUMERIC_INVALID"
  | "SCREENSHOT_FAILED"
  | "APP_LAUNCH_FAILED"
  | "INPUT_FAILED"
  | "OCR_FAILED"
  | "ATSPI_FAILED"
  | "ACTION_TIMEOUT";

export class HyprlandError extends Error {
  public readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "HyprlandError";
  }
}

export function formatError(err: unknown): string {
  if (err instanceof HyprlandError) {
    return `[${err.code}] ${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function uidRuntimeDir(): string {
  const getuid = process.getuid;
  if (!getuid) {
    throw new HyprlandError("PLATFORM_UNSUPPORTED", "process.getuid() is unavailable on this platform");
  }
  return `/run/user/${getuid()}/hypr`;
}

async function socketCandidates(): Promise<string[]> {
  const base = uidRuntimeDir();
  const entries = await readdir(base, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
  return dirs.map((dir) => join(base, dir, ".socket.sock"));
}

async function pickWorkingSignature(): Promise<string> {
  const candidates = await socketCandidates();
  const envSig = process.env.HYPRLAND_INSTANCE_SIGNATURE;

  const ordered = envSig
    ? [join(uidRuntimeDir(), envSig, ".socket.sock"), ...candidates.filter((p) => !p.includes(envSig))]
    : candidates;

  for (const sock of ordered) {
    try {
      await access(sock, constants.R_OK | constants.W_OK);
      const sig = sock.split("/").slice(-2, -1)[0];
      const { stdout } = await execFileAsync("hyprctl", ["-j", "version"], {
        env: { ...process.env, HYPRLAND_INSTANCE_SIGNATURE: sig },
      });
      if (stdout && sig) return sig;
    } catch {
      continue;
    }
  }

  throw new HyprlandError("NO_SOCKET", "No working Hyprland socket found under /run/user/$UID/hypr");
}

async function hyprctlJson<T>(args: string[]): Promise<T> {
  const sig = await pickWorkingSignature();
  const { stdout, stderr } = await execFileAsync("hyprctl", ["-j", ...args], {
    env: { ...process.env, HYPRLAND_INSTANCE_SIGNATURE: sig },
  });
  if (stderr && stderr.trim()) {
    throw new HyprlandError("NO_SOCKET", stderr.trim());
  }
  return JSON.parse(stdout) as T;
}

export async function hyprctlDispatch(dispatcher: string, params: string): Promise<string> {
  const sig = await pickWorkingSignature();
  const { stdout, stderr } = await execFileAsync("hyprctl", ["dispatch", dispatcher, params], {
    env: { ...process.env, HYPRLAND_INSTANCE_SIGNATURE: sig },
  });
  if (stderr && stderr.trim()) {
    throw new HyprlandError("NO_SOCKET", stderr.trim());
  }
  return stdout.trim();
}

export async function listMonitors(): Promise<MonitorInfo[]> {
  const monitors = await hyprctlJson<Array<Record<string, unknown>>>(["monitors"]);
  return monitors.map((m) => ({
    id: Number(m.id),
    name: String(m.name),
    width: Number(m.width),
    height: Number(m.height),
    x: Number(m.x),
    y: Number(m.y),
    focused: Boolean(m.focused),
  }));
}

function normalizeClient(client: HyprClient, focusedId: WindowId | null): WindowInfo {
  return {
    id: client.address,
    class: client.class,
    title: client.title,
    workspace: client.workspace?.name ?? "",
    monitor: client.monitor,
    floating: client.floating,
    fullscreen: client.fullscreen,
    focused: focusedId === client.address,
    mapped: client.mapped,
    hidden: client.hidden,
    position: { x: client.at[0], y: client.at[1] },
    size: { width: client.size[0], height: client.size[1] },
  };
}

export async function activeWindow(): Promise<WindowInfo | null> {
  const active = await hyprctlJson<Partial<HyprClient>>(["activewindow"]);
  if (!active.address) return null;
  const clients = await hyprctlJson<HyprClient[]>(["clients"]);
  const full = clients.find((c) => c.address === active.address);
  if (!full) return null;
  return normalizeClient(full, active.address as WindowId);
}

export async function listWindows(filters: { workspace?: string; includeHidden?: boolean }): Promise<WindowInfo[]> {
  const [clients, active] = await Promise.all([
    hyprctlJson<HyprClient[]>(["clients"]),
    hyprctlJson<Partial<HyprClient>>(["activewindow"]),
  ]);

  return clients
    .filter((c) => (filters.workspace ? c.workspace?.name === filters.workspace : true))
    .filter((c) => (filters.includeHidden ? true : !c.hidden && c.mapped))
    .map((c) => normalizeClient(c, (active.address as WindowId | undefined) ?? null));
}

export interface WindowQuery {
  classEquals?: string;
  classContains?: string;
  titleContains?: string;
  workspace?: string;
  focusedOnly?: boolean;
  includeHidden?: boolean;
}

function includesCI(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function filterWindowsByQuery(windows: WindowInfo[], query: WindowQuery): WindowInfo[] {
  return windows
    .filter((w) => (query.workspace ? w.workspace === query.workspace : true))
    .filter((w) => (query.classEquals ? w.class === query.classEquals : true))
    .filter((w) => (query.classContains ? includesCI(w.class, query.classContains) : true))
    .filter((w) => (query.titleContains ? includesCI(w.title, query.titleContains) : true))
    .filter((w) => (query.focusedOnly ? w.focused : true));
}

export async function getWindowOrThrow(windowId: WindowId): Promise<WindowInfo> {
  const windows = await listWindows({ includeHidden: true });
  const found = windows.find((w) => w.id === windowId);
  if (!found) throw new HyprlandError("WINDOW_NOT_FOUND", `Window not found: ${windowId}`);
  if (!found.mapped || found.hidden) {
    throw new HyprlandError("WINDOW_NOT_ACTIONABLE", `Window not actionable (hidden/unmapped): ${windowId}`);
  }
  return found;
}

export async function healthCheck(): Promise<Record<string, unknown>> {
  const sig = await pickWorkingSignature();
  const [monitors, current] = await Promise.all([listMonitors(), activeWindow()]);
  return {
    sessionType: process.env.XDG_SESSION_TYPE ?? null,
    desktop: process.env.XDG_CURRENT_DESKTOP ?? null,
    hyprlandInstance: sig,
    monitorCount: monitors.length,
    focusedMonitor: monitors.find((m) => m.focused)?.name ?? null,
    activeWindow: current,
  };
}

export async function focusedWorkspaceName(): Promise<string | null> {
  const monitors = await hyprctlJson<Array<Record<string, unknown>>>(["monitors"]);
  const focused = monitors.find((m) => Boolean(m.focused));
  if (!focused) return null;
  const activeWorkspace = focused.activeWorkspace as { name?: string } | undefined;
  return activeWorkspace?.name ?? null;
}

export interface WorkspaceInfo {
  name: string;
  id: number;
  monitor: string | null;
  hasFullscreen: boolean;
}

export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  const workspaces = await hyprctlJson<Array<Record<string, unknown>>>(["workspaces"]);
  return workspaces.map((w) => ({
    name: String(w.name ?? ""),
    id: Number(w.id ?? 0),
    monitor: typeof w.monitor === "string" ? w.monitor : null,
    hasFullscreen: Boolean(w.hasfullscreen),
  }));
}

export function pickFirstEmptyWorkspace(
  windows: WindowInfo[],
  rangeStart: number,
  rangeEnd: number,
): string | null {
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd)) {
    throw new HyprlandError("NUMERIC_INVALID", "Workspace range must be finite");
  }
  const start = Math.trunc(Math.min(rangeStart, rangeEnd));
  const end = Math.trunc(Math.max(rangeStart, rangeEnd));
  const occupied = new Set(windows.map((w) => w.workspace));
  for (let i = start; i <= end; i += 1) {
    const name = String(i);
    if (!occupied.has(name)) return name;
  }
  return null;
}

export async function captureGeometryForTarget(target: "active_window" | "window", windowId?: WindowId): Promise<string> {
  const win = target === "active_window" ? await activeWindow() : await getWindowOrThrow(windowId as WindowId);
  if (!win) throw new HyprlandError("ACTIVE_WINDOW_MISSING", "No active window available");
  return `${win.position.x},${win.position.y} ${win.size.width}x${win.size.height}`;
}

export function clampMoveResize(value: number, min = -10000, max = 10000): number {
  if (!Number.isFinite(value)) throw new HyprlandError("NUMERIC_INVALID", "Numeric value must be finite");
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function clampAbsolutePointToMonitor(
  monitor: MonitorInfo,
  point: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: clampMoveResize(point.x, monitor.x, monitor.x + monitor.width - 1),
    y: clampMoveResize(point.y, monitor.y, monitor.y + monitor.height - 1),
  };
}

export function clampAbsoluteSizeToMonitor(
  monitor: MonitorInfo,
  size: { width: number; height: number },
): { width: number; height: number } {
  return {
    width: clampMoveResize(size.width, 1, monitor.width),
    height: clampMoveResize(size.height, 1, monitor.height),
  };
}

export async function monitorForWindow(windowId: WindowId): Promise<MonitorInfo | null> {
  const [win, monitors] = await Promise.all([getWindowOrThrow(windowId), listMonitors()]);
  return monitorWindowBounds(win, monitors);
}

export async function cursorPosition(): Promise<{ x: number; y: number }> {
  const pos = await hyprctlJson<unknown>(["cursorpos"]);
  if (typeof pos === "object" && pos !== null) {
    const rec = pos as Record<string, unknown>;
    const x = Number(rec.x);
    const y = Number(rec.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y };
    }
  }
  throw new HyprlandError("INPUT_FAILED", "Could not read cursor position from Hyprland");
}

export { parsePngDimensions };
