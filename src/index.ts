import { z } from "zod";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { audit } from "./lib/audit.js";
import { logRunEvent } from "./lib/runlog.js";
import {
  activeWindow,
  clampAbsolutePointToMonitor,
  clampAbsoluteSizeToMonitor,
  clampMoveResize,
  cursorPosition,
  filterWindowsByQuery,
  focusedWorkspaceName,
  formatError,
  getWindowOrThrow,
  healthCheck,
  hyprctlDispatch,
  HyprlandError,
  listWorkspaces,
  listMonitors,
  listWindows,
  monitorForWindow,
  pickFirstEmptyWorkspace,
} from "./lib/hyprland.js";
import { captureScreenshot } from "./lib/screenshot.js";
import { cellToRelativePoint as gridCellToRelativePoint, defaultGridForSize } from "./lib/grid.js";
import type { WindowId } from "./lib/types.js";

const dryRun = process.env.USE_MCP_DRY_RUN === "1";
const screenshotDirDefault = join(homedir(), "Pictures", "use-mcp");
const execFileAsync = promisify(execFile);

interface AppCatalogEntry {
  name: string;
  description: string;
  commands: string[];
}

const APP_CATALOG: AppCatalogEntry[] = [
  { name: "zen", description: "Privacy-focused web browser for tabs, web apps, and research.", commands: ["zen-browser", "flatpak run app.zen_browser.zen", "zen"] },
  { name: "zathura", description: "Keyboard-first PDF/document viewer.", commands: ["zathura"] },
  { name: "kitty", description: "GPU-accelerated terminal emulator.", commands: ["kitty"] },
  { name: "code", description: "Visual Studio Code editor and IDE.", commands: ["code"] },
  { name: "firefox", description: "General-purpose web browser.", commands: ["firefox"] },
  { name: "chromium", description: "Chromium browser for web testing.", commands: ["chromium", "google-chrome-stable", "google-chrome"] },
  { name: "nautilus", description: "File manager for browsing and opening files.", commands: ["nautilus"] },
];

async function commandExists(cmd: string): Promise<boolean> {
  // For compound commands like "flatpak run ...", validate only the executable.
  const bin = cmd.trim().split(/\s+/)[0];
  const { stdout } = await execFileAsync("sh", ["-lc", `command -v ${bin} >/dev/null 2>&1 && echo yes || true`]);
  return String(stdout).trim() === "yes";
}

async function resolveAppLaunchCommand(appName: string): Promise<string | null> {
  const app = APP_CATALOG.find((a) => a.name === appName);
  if (!app) return null;
  for (const cmd of app.commands) {
    if (await commandExists(cmd)) return cmd;
  }
  return null;
}

function sanitizeLaunchCommand(input: string): string {
  const cmd = input.trim();
  if (!cmd) {
    throw new HyprlandError("APP_LAUNCH_FAILED", "Launch command cannot be empty");
  }
  if (cmd.length > 240) {
    throw new HyprlandError("APP_LAUNCH_FAILED", "Launch command is too long");
  }
  // Block shell control characters/operators to reduce command injection risk.
  if (/[;&|`$><\n\r]/.test(cmd)) {
    throw new HyprlandError("APP_LAUNCH_FAILED", "Launch command contains unsafe shell characters");
  }
  // Block privilege-escalation launch patterns.
  if (/\b(sudo|pkexec|doas)\b/i.test(cmd)) {
    throw new HyprlandError("APP_LAUNCH_FAILED", "Privilege escalation commands are not allowed");
  }
  return cmd;
}

function sanitizeTypedText(input: string): string {
  if (input.length === 0) {
    throw new HyprlandError("INPUT_FAILED", "Typed text cannot be empty");
  }
  if (input.length > 4000) {
    throw new HyprlandError("INPUT_FAILED", "Typed text is too long");
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(input)) {
    throw new HyprlandError("INPUT_FAILED", "Typed text contains unsupported control characters");
  }
  return input;
}

const ALLOWED_KEYS = [
  "enter",
  "tab",
  "escape",
  "backspace",
  "delete",
  "left",
  "right",
  "up",
  "down",
  "home",
  "end",
  "page_up",
  "page_down",
  "f5",
] as const;

const ALLOWED_MODIFIERS = ["ctrl", "alt", "shift", "super"] as const;

type AllowedKey = (typeof ALLOWED_KEYS)[number];
type AllowedModifier = (typeof ALLOWED_MODIFIERS)[number];

function normalizeKey(key: string): AllowedKey {
  const normalized = key.trim().toLowerCase().replace(/\s+/g, "_");
  if ((ALLOWED_KEYS as readonly string[]).includes(normalized)) {
    return normalized as AllowedKey;
  }
  if (/^[a-z0-9]$/.test(normalized)) {
    return normalized as AllowedKey;
  }
  throw new HyprlandError("INPUT_FAILED", `Unsupported key: ${key}`);
}

function normalizeModifiers(modifiers: string[]): AllowedModifier[] {
  const out: AllowedModifier[] = [];
  for (const mod of modifiers) {
    const normalized = mod.trim().toLowerCase();
    if (!(ALLOWED_MODIFIERS as readonly string[]).includes(normalized)) {
      throw new HyprlandError("INPUT_FAILED", `Unsupported modifier: ${mod}`);
    }
    if (!out.includes(normalized as AllowedModifier)) out.push(normalized as AllowedModifier);
  }
  return out;
}

function toHyprShortcutMods(mods: AllowedModifier[]): string {
  const map: Record<AllowedModifier, string> = { ctrl: "CTRL", alt: "ALT", shift: "SHIFT", super: "SUPER" };
  return mods.map((m) => map[m]).join(" ");
}

function toHyprShortcutKey(key: AllowedKey): string {
  const map: Record<AllowedKey, string> = {
    enter: "RETURN",
    tab: "TAB",
    escape: "ESCAPE",
    backspace: "BACKSPACE",
    delete: "DELETE",
    left: "LEFT",
    right: "RIGHT",
    up: "UP",
    down: "DOWN",
    home: "HOME",
    end: "END",
    page_up: "PAGEUP",
    page_down: "PAGEDOWN",
    f5: "F5",
  };
  if (map[key]) return map[key];
  // Letter/digit keys for extension-driven keyboard navigation (for example Vimium hints).
  if (/^[a-z0-9]$/.test(key)) return key.toUpperCase();
  throw new HyprlandError("INPUT_FAILED", `Unsupported shortcut key: ${key}`);
}

interface TextMatch {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

function parseTesseractTsv(tsv: string): TextMatch[] {
  const lines = tsv.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const out: TextMatch[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split("\t");
    if (cols.length < 12) continue;
    const conf = Number(cols[10]);
    const text = cols[11]?.trim() ?? "";
    if (!text || !Number.isFinite(conf)) continue;
    out.push({
      text,
      x: Number(cols[6]),
      y: Number(cols[7]),
      width: Number(cols[8]),
      height: Number(cols[9]),
      confidence: conf,
    });
  }
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type PointerTarget = "full" | "monitor" | "active_window" | "window";

interface ResolvedPointer {
  x: number;
  y: number;
  target: PointerTarget;
  monitorName: string | null;
  windowId: WindowId | null;
}

interface GridSession {
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

let activeGridSession: GridSession | null = null;

function cellToRelativePoint(session: GridSession, cellId: number): { x: number; y: number; row: number; col: number } {
  return gridCellToRelativePoint(session.cols, session.rows, session.width, session.height, cellId);
}

async function resolveTargetOrigin(
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

interface TargetBounds {
  originX: number;
  originY: number;
  width: number;
  height: number;
  resolvedTarget: string;
}

async function resolveTargetBounds(
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

async function ensureGridSessionFresh(session: GridSession): Promise<GridSession> {
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

async function resolvePointerCoordinates(
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

async function waitForWindow(
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

async function performMouseClick(x: number, y: number, button: "left" | "middle" | "right", settleMs: number): Promise<void> {
  if (!(await commandExists("ydotool"))) {
    throw new HyprlandError("INPUT_FAILED", "ydotool is not installed");
  }
  const buttonCode = button === "left" ? "0xC0" : button === "middle" ? "0xC2" : "0xC1";
  await performMouseMove(x, y);
  if (settleMs > 0) await sleep(settleMs);
  await execFileAsync("ydotool", ["click", buttonCode]);
}

async function performMouseMove(x: number, y: number): Promise<void> {
  await hyprctlDispatch("movecursor", `${x} ${y}`);
}

async function performMouseScroll(axis: "vertical" | "horizontal", amount: number): Promise<void> {
  if (!(await commandExists("ydotool"))) {
    throw new HyprlandError("INPUT_FAILED", "ydotool is not installed");
  }
  // ydotool click wheel codes: 0xC4 wheel-up, 0xC5 wheel-down, 0xC6 wheel-left, 0xC7 wheel-right
  const steps = Math.min(50, Math.max(1, Math.abs(Math.trunc(amount))));
  let wheelCode = "0xC4";
  if (axis === "vertical") {
    wheelCode = amount >= 0 ? "0xC4" : "0xC5";
  } else {
    wheelCode = amount >= 0 ? "0xC7" : "0xC6";
  }
  await execFileAsync("ydotool", ["click", "--repeat", String(steps), wheelCode]);
}

async function performFindTextOnScreen(input: {
  query: string;
  target: "full" | "monitor" | "active_window" | "window";
  monitorName?: string;
  windowId?: WindowId;
  confidenceMin: number;
  limit: number;
}): Promise<{ matches: TextMatch[]; width: number; height: number; target: string }> {
  if (!(await commandExists("tesseract"))) {
    throw new HyprlandError("OCR_FAILED", "tesseract is not installed");
  }
  const shot = await captureScreenshot({ target: input.target, monitorName: input.monitorName, windowId: input.windowId });
  const tempDir = await mkdtemp(join(tmpdir(), "use-mcp-ocr-"));
  const imagePath = join(tempDir, "screen.png");
  try {
    await writeFile(imagePath, shot.png);
    const { stdout, stderr } = await execFileAsync("tesseract", [imagePath, "stdout", "--psm", "6", "tsv"]);
    if (stderr && String(stderr).trim()) {
      throw new HyprlandError("OCR_FAILED", String(stderr).trim());
    }
    const needle = input.query.toLowerCase();
    const words = parseTesseractTsv(String(stdout))
      .filter((w) => w.confidence >= input.confidenceMin)
      .filter((w) => w.text.toLowerCase().includes(needle))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, input.limit);
    return { matches: words, width: shot.width, height: shot.height, target: shot.target };
  } catch (error) {
    if (error instanceof HyprlandError) throw error;
    throw new HyprlandError("OCR_FAILED", error instanceof Error ? error.message : String(error));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function resolveTextClickPoint(input: {
  query: string;
  target: PointerTarget;
  monitorName?: string;
  windowId?: WindowId;
  confidenceMin: number;
  matchIndex: number;
  offsetX: number;
  offsetY: number;
}): Promise<{
  match: TextMatch;
  absoluteX: number;
  absoluteY: number;
  relativeX: number;
  relativeY: number;
  target: PointerTarget;
}> {
  const found = await performFindTextOnScreen({
    query: input.query,
    target: input.target,
    monitorName: input.monitorName,
    windowId: input.windowId,
    confidenceMin: input.confidenceMin,
    limit: Math.max(1, input.matchIndex + 1),
  });
  const match = found.matches[input.matchIndex];
  if (!match) {
    throw new HyprlandError("OCR_FAILED", `No OCR match for '${input.query}' at index ${input.matchIndex}`);
  }

  const relativeX = match.x + Math.floor(match.width / 2) + input.offsetX;
  const relativeY = match.y + Math.floor(match.height / 2) + input.offsetY;
  const resolved = await resolvePointerCoordinates(relativeX, relativeY, input.target, input.monitorName, input.windowId);
  return {
    match,
    absoluteX: resolved.x,
    absoluteY: resolved.y,
    relativeX,
    relativeY,
    target: input.target,
  };
}

const server = new McpServer({
  name: "use-mcp",
  version: "0.1.0",
});

server.registerTool(
  "app_list",
  {
    title: "App List",
    description: "List known app launch aliases with one-line descriptions.",
    inputSchema: {
      installedOnly: z.boolean().default(false),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ installedOnly }) => {
    const entries = await Promise.all(
      APP_CATALOG.map(async (app) => {
        let launchCommand: string | null = null;
        for (const cmd of app.commands) {
          if (await commandExists(cmd)) {
            launchCommand = cmd;
            break;
          }
        }
        return {
          name: app.name,
          description: app.description,
          installed: launchCommand !== null,
          launchCommand,
        };
      }),
    );

    const filtered = installedOnly ? entries.filter((e) => e.installed) : entries;
    return {
      content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
      structuredContent: { apps: filtered },
    };
  },
);

server.registerTool(
  "type_text",
  {
    title: "Type Text",
    description: "Type text into the currently focused input field.",
    inputSchema: {
      text: z.string().min(1).max(4000),
      delayMs: z.number().int().min(0).max(1000).default(0),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ text, delayMs }) => {
    const safeText = sanitizeTypedText(text);
    await audit("type_text", { textLength: safeText.length, delayMs }, dryRun);

    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN type_text length=${safeText.length} delayMs=${delayMs}` }],
        structuredContent: { typed: false, dryRun: true, textLength: safeText.length, delayMs },
      };
    }

    if (!(await commandExists("wtype"))) {
      throw new HyprlandError("INPUT_FAILED", "wtype is not installed");
    }

    if (delayMs > 0) {
      await execFileAsync("wtype", ["-d", String(delayMs), safeText]);
    } else {
      await execFileAsync("wtype", [safeText]);
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ typed: true, textLength: safeText.length, delayMs }, null, 2) }],
      structuredContent: { typed: true, textLength: safeText.length, delayMs },
    };
  },
);

server.registerTool(
  "window_focus_and_type",
  {
    title: "Window Focus And Type",
    description: "Focus a window, wait briefly, then type text into its focused input.",
    inputSchema: {
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/),
      text: z.string().min(1).max(4000),
      focusSettleMs: z.number().int().min(0).max(3000).default(120),
      delayMs: z.number().int().min(0).max(1000).default(0),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ windowId, text, focusSettleMs, delayMs }) => {
    const safeText = sanitizeTypedText(text);
    await getWindowOrThrow(windowId as WindowId);
    await audit("window_focus_and_type", { windowId, textLength: safeText.length, focusSettleMs, delayMs }, dryRun);

    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN focus_and_type window=${windowId} textLength=${safeText.length}` }],
        structuredContent: { typed: false, dryRun: true, windowId, textLength: safeText.length },
      };
    }

    if (!(await commandExists("wtype"))) {
      throw new HyprlandError("INPUT_FAILED", "wtype is not installed");
    }

    await hyprctlDispatch("focuswindow", `address:${windowId}`);
    if (focusSettleMs > 0) await sleep(focusSettleMs);

    if (delayMs > 0) {
      await execFileAsync("wtype", ["-d", String(delayMs), safeText]);
    } else {
      await execFileAsync("wtype", [safeText]);
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ typed: true, windowId, textLength: safeText.length }, null, 2) }],
      structuredContent: { typed: true, windowId, textLength: safeText.length },
    };
  },
);

server.registerTool(
  "key_press",
  {
    title: "Key Press",
    description: "Send a single keyboard key with optional modifiers to the focused window.",
    inputSchema: {
      key: z.string().min(1).max(32),
      modifiers: z.array(z.string().min(1).max(16)).max(4).default([]),
      repeat: z.number().int().min(1).max(20).default(1),
      delayMs: z.number().int().min(0).max(2000).default(80),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ key, modifiers, repeat, delayMs }) => {
    const safeKey = normalizeKey(key);
    const safeMods = normalizeModifiers(modifiers);
    await audit("key_press", { key: safeKey, modifiers: safeMods, repeat, delayMs }, dryRun);
    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN key_press key=${safeKey} modifiers=${safeMods.join("+")} repeat=${repeat}` }],
        structuredContent: { dryRun: true, key: safeKey, modifiers: safeMods, repeat, delayMs },
      };
    }
    const shortcutMods = toHyprShortcutMods(safeMods);
    const shortcutKey = toHyprShortcutKey(safeKey);
    for (let i = 0; i < repeat; i += 1) {
      await hyprctlDispatch("sendshortcut", `${shortcutMods},${shortcutKey}`);
      if (i < repeat - 1 && delayMs > 0) await sleep(delayMs);
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ sent: true, key: safeKey, modifiers: safeMods, repeat, delayMs }, null, 2) }],
      structuredContent: { sent: true, key: safeKey, modifiers: safeMods, repeat, delayMs },
    };
  },
);

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
    activeGridSession = {
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
      sessionId: activeGridSession.id,
      target,
      monitorName: activeGridSession.monitorName,
      windowId: activeGridSession.windowId,
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
              sessionId: activeGridSession.id,
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
        sessionId: activeGridSession.id,
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
    if (!activeGridSession) {
      throw new HyprlandError("WINDOW_NOT_FOUND", "No active grid session. Call grid_show first.");
    }
    activeGridSession = await ensureGridSessionFresh(activeGridSession);
    const point = cellToRelativePoint(activeGridSession, cellId);
    const payload = {
      sessionId: activeGridSession.id,
      cellId,
      row: point.row + 1,
      col: point.col + 1,
      relative: { x: point.x, y: point.y },
      absolute: {
        x: activeGridSession.originAbsoluteX + point.x,
        y: activeGridSession.originAbsoluteY + point.y,
      },
      gridPath: activeGridSession.gridPath,
    };
    await logRunEvent({ action: "grid_cell_to_point", ...payload });
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
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
    if (!activeGridSession) throw new HyprlandError("WINDOW_NOT_FOUND", "No active grid session. Call grid_show first.");
    activeGridSession = await ensureGridSessionFresh(activeGridSession);
    const point = cellToRelativePoint(activeGridSession, cellId);
    const absX = activeGridSession.originAbsoluteX + point.x;
    const absY = activeGridSession.originAbsoluteY + point.y;
    await performMouseMove(absX, absY);
    if (settleMs > 0) await sleep(settleMs);
    const payload = { sessionId: activeGridSession.id, cellId, absoluteX: absX, absoluteY: absY, relativeX: point.x, relativeY: point.y };
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
    if (!activeGridSession) throw new HyprlandError("WINDOW_NOT_FOUND", "No active grid session. Call grid_show first.");
    activeGridSession = await ensureGridSessionFresh(activeGridSession);
    const point = cellToRelativePoint(activeGridSession, cellId);
    const absX = activeGridSession.originAbsoluteX + point.x;
    const absY = activeGridSession.originAbsoluteY + point.y;
    await performMouseClick(absX, absY, button, settleMs);
    const payload = { sessionId: activeGridSession.id, cellId, button, absoluteX: absX, absoluteY: absY, relativeX: point.x, relativeY: point.y };
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
    const previous = activeGridSession;
    activeGridSession = null;
    await logRunEvent({ action: "grid_hide", previousSessionId: previous?.id ?? null });
    return {
      content: [{ type: "text", text: JSON.stringify({ cleared: true, previousSessionId: previous?.id ?? null }, null, 2) }],
      structuredContent: { cleared: true, previousSessionId: previous?.id ?? null },
    };
  },
);

server.registerTool(
  "mouse_get_position",
  {
    title: "Mouse Get Position",
    description: "Get current mouse cursor position and optional deltas to a point.",
    inputSchema: {
      target: z.enum(["full", "monitor", "active_window", "window"]).default("full"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      relativeToX: z.number().int().min(0).optional(),
      relativeToY: z.number().int().min(0).optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ target, monitorName, windowId, relativeToX, relativeToY }) => {
    const pos = await cursorPosition();
    const bounds = await resolveTargetBounds(target, monitorName, windowId as WindowId | undefined);

    const relative = { x: pos.x - bounds.originX, y: pos.y - bounds.originY };
    const inView = relative.x >= 0 && relative.y >= 0 && relative.x < bounds.width && relative.y < bounds.height;
    const payload: Record<string, unknown> = {
      absolute: pos,
      relative,
      inView,
      bounds: { originX: bounds.originX, originY: bounds.originY, width: bounds.width, height: bounds.height },
      target,
      resolvedTarget: bounds.resolvedTarget,
    };
    if (typeof relativeToX === "number" && typeof relativeToY === "number") {
      payload.deltaToPoint = { dx: relativeToX - relative.x, dy: relativeToY - relative.y };
      payload.distanceToPoint = Math.hypot(relativeToX - relative.x, relativeToY - relative.y);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  },
);

server.registerTool(
  "mouse_verify_in_view",
  {
    title: "Mouse Verify In View",
    description: "Check whether cursor is currently visible inside target bounds.",
    inputSchema: {
      target: z.enum(["full", "monitor", "active_window", "window"]).default("active_window"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ target, monitorName, windowId }) => {
    const pos = await cursorPosition();
    const bounds = await resolveTargetBounds(target, monitorName, windowId as WindowId | undefined);
    const relative = { x: pos.x - bounds.originX, y: pos.y - bounds.originY };
    const inView = relative.x >= 0 && relative.y >= 0 && relative.x < bounds.width && relative.y < bounds.height;
    const payload = {
      inView,
      absolute: pos,
      relative,
      bounds: { originX: bounds.originX, originY: bounds.originY, width: bounds.width, height: bounds.height },
      target,
      resolvedTarget: bounds.resolvedTarget,
    };
    await logRunEvent({ action: "mouse_verify_in_view", ...payload });
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  },
);

server.registerTool(
  "resolve_text_point",
  {
    title: "Resolve Text Point",
    description: "Find text on screen and return relative/absolute center point for mouse targeting.",
    inputSchema: {
      query: z.string().min(1).max(120),
      target: z.enum(["full", "monitor", "active_window", "window"]).default("active_window"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      confidenceMin: z.number().min(0).max(100).default(35),
      matchIndex: z.number().int().min(0).max(20).default(0),
      offsetX: z.number().int().min(-500).max(500).default(0),
      offsetY: z.number().int().min(-500).max(500).default(0),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ query, target, monitorName, windowId, confidenceMin, matchIndex, offsetX, offsetY }) => {
    const point = await resolveTextClickPoint({
      query,
      target,
      monitorName,
      windowId: windowId as WindowId | undefined,
      confidenceMin,
      matchIndex,
      offsetX,
      offsetY,
    });
    const payload = {
      query,
      target,
      matchIndex,
      confidenceMin,
      point: {
        absoluteX: point.absoluteX,
        absoluteY: point.absoluteY,
        relativeX: point.relativeX,
        relativeY: point.relativeY,
      },
      match: point.match,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  },
);

server.registerTool(
  "mouse_move_to_text",
  {
    title: "Mouse Move To Text",
    description: "Find text and move cursor to its resolved point.",
    inputSchema: {
      query: z.string().min(1).max(120),
      target: z.enum(["full", "monitor", "active_window", "window"]).default("active_window"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      confidenceMin: z.number().min(0).max(100).default(35),
      matchIndex: z.number().int().min(0).max(20).default(0),
      offsetX: z.number().int().min(-500).max(500).default(0),
      offsetY: z.number().int().min(-500).max(500).default(0),
      settleMs: z.number().int().min(0).max(3000).default(60),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ query, target, monitorName, windowId, confidenceMin, matchIndex, offsetX, offsetY, settleMs }) => {
    const point = await resolveTextClickPoint({
      query,
      target,
      monitorName,
      windowId: windowId as WindowId | undefined,
      confidenceMin,
      matchIndex,
      offsetX,
      offsetY,
    });
    await audit("mouse_move_to_text", { query, target, matchIndex, confidenceMin, offsetX, offsetY, x: point.absoluteX, y: point.absoluteY }, dryRun);
    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN mouse_move_to_text query='${query}' x=${point.absoluteX} y=${point.absoluteY}` }],
        structuredContent: { dryRun: true, moved: false },
      };
    }
    await performMouseMove(point.absoluteX, point.absoluteY);
    if (settleMs > 0) await sleep(settleMs);
    const payload = { moved: true, query, target, absoluteX: point.absoluteX, absoluteY: point.absoluteY, relativeX: point.relativeX, relativeY: point.relativeY };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  },
);

server.registerTool(
  "click_text",
  {
    title: "Click Text",
    description: "Find text on screen and click its resolved point.",
    inputSchema: {
      query: z.string().min(1).max(120),
      target: z.enum(["full", "monitor", "active_window", "window"]).default("active_window"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      confidenceMin: z.number().min(0).max(100).default(35),
      matchIndex: z.number().int().min(0).max(20).default(0),
      offsetX: z.number().int().min(-500).max(500).default(0),
      offsetY: z.number().int().min(-500).max(500).default(0),
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
  async ({ query, target, monitorName, windowId, confidenceMin, matchIndex, offsetX, offsetY, button, settleMs }) => {
    const point = await resolveTextClickPoint({
      query,
      target,
      monitorName,
      windowId: windowId as WindowId | undefined,
      confidenceMin,
      matchIndex,
      offsetX,
      offsetY,
    });
    await audit("click_text", { query, target, matchIndex, confidenceMin, offsetX, offsetY, button, x: point.absoluteX, y: point.absoluteY }, dryRun);
    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN click_text query='${query}' x=${point.absoluteX} y=${point.absoluteY} button=${button}` }],
        structuredContent: { dryRun: true, clicked: false },
      };
    }
    await performMouseClick(point.absoluteX, point.absoluteY, button, settleMs);
    const payload = {
      clicked: true,
      query,
      target,
      button,
      absoluteX: point.absoluteX,
      absoluteY: point.absoluteY,
      relativeX: point.relativeX,
      relativeY: point.relativeY,
      match: point.match,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  },
);

server.registerTool(
  "mouse_move",
  {
    title: "Mouse Move",
    description: "Move cursor to coordinates relative to full screen, monitor, active window, or specific window.",
    inputSchema: {
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      target: z.enum(["full", "monitor", "active_window", "window"]).default("full"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      settleMs: z.number().int().min(0).max(3000).default(40),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ x, y, target, monitorName, windowId, settleMs }) => {
    await audit("mouse_move", { x, y, target, monitorName, windowId, settleMs }, dryRun);
    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN mouse_move x=${x} y=${y} target=${target}` }],
        structuredContent: { dryRun: true, moved: false, x, y, target },
      };
    }
    const resolved = await resolvePointerCoordinates(x, y, target, monitorName, windowId as WindowId | undefined);
    await performMouseMove(resolved.x, resolved.y);
    if (settleMs > 0) await sleep(settleMs);
    return {
      content: [{ type: "text", text: JSON.stringify({ moved: true, x, y, target, absoluteX: resolved.x, absoluteY: resolved.y }, null, 2) }],
      structuredContent: { moved: true, x, y, target, absoluteX: resolved.x, absoluteY: resolved.y },
    };
  },
);

server.registerTool(
  "mouse_click",
  {
    title: "Mouse Click",
    description: "Click at coordinates relative to full screen, monitor, active window, or specific window.",
    inputSchema: {
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      target: z.enum(["full", "monitor", "active_window", "window"]).default("full"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      button: z.enum(["left", "middle", "right"]).default("left"),
      settleMs: z.number().int().min(0).max(3000).default(80),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ x, y, target, monitorName, windowId, button, settleMs }) => {
    await audit("mouse_click", { x, y, target, monitorName, windowId, button, settleMs }, dryRun);
    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN mouse_click x=${x} y=${y} target=${target} button=${button}` }],
        structuredContent: { dryRun: true, clicked: false, x, y, target, button },
      };
    }
    const resolved = await resolvePointerCoordinates(x, y, target, monitorName, windowId as WindowId | undefined);
    await performMouseClick(resolved.x, resolved.y, button, settleMs);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ clicked: true, x, y, target, button, absoluteX: resolved.x, absoluteY: resolved.y }, null, 2),
        },
      ],
      structuredContent: { clicked: true, x, y, target, button, absoluteX: resolved.x, absoluteY: resolved.y },
    };
  },
);

server.registerTool(
  "mouse_scroll",
  {
    title: "Mouse Scroll",
    description: "Scroll vertically or horizontally using wheel events.",
    inputSchema: {
      axis: z.enum(["vertical", "horizontal"]).default("vertical"),
      amount: z.number().int().min(-50).max(50),
      settleMs: z.number().int().min(0).max(3000).default(60),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ axis, amount, settleMs }) => {
    if (amount === 0) {
      return {
        content: [{ type: "text", text: JSON.stringify({ scrolled: false, axis, amount }, null, 2) }],
        structuredContent: { scrolled: false, axis, amount },
      };
    }
    await audit("mouse_scroll", { axis, amount, settleMs }, dryRun);
    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN mouse_scroll axis=${axis} amount=${amount}` }],
        structuredContent: { dryRun: true, scrolled: false, axis, amount },
      };
    }
    await performMouseScroll(axis, amount);
    if (settleMs > 0) await sleep(settleMs);
    return {
      content: [{ type: "text", text: JSON.stringify({ scrolled: true, axis, amount }, null, 2) }],
      structuredContent: { scrolled: true, axis, amount },
    };
  },
);

server.registerTool(
  "find_text_on_screen",
  {
    title: "Find Text On Screen",
    description: "Run OCR on a screenshot and return best matching text boxes.",
    inputSchema: {
      query: z.string().min(1).max(120),
      target: z.enum(["full", "monitor", "active_window", "window"]).default("active_window"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      confidenceMin: z.number().min(0).max(100).default(35),
      limit: z.number().int().min(1).max(20).default(5),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ query, target, monitorName, windowId, confidenceMin, limit }) => {
    const found = await performFindTextOnScreen({
      query,
      target,
      monitorName,
      windowId: windowId as WindowId | undefined,
      confidenceMin,
      limit,
    });
    return {
      content: [{ type: "text", text: JSON.stringify({ query, matches: found.matches, width: found.width, height: found.height }, null, 2) }],
      structuredContent: { query, matches: found.matches, width: found.width, height: found.height, target: found.target },
    };
  },
);

server.registerTool(
  "click_wait_retry",
  {
    title: "Click Wait Retry",
    description: "Cycle: find text with OCR, click its center, wait, then verify expected text appears.",
    inputSchema: {
      clickText: z.string().min(1).max(120),
      expectText: z.string().min(1).max(120),
      target: z.enum(["full", "monitor", "active_window", "window"]).default("active_window"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      maxAttempts: z.number().int().min(1).max(8).default(3),
      waitAfterClickMs: z.number().int().min(100).max(8000).default(1000),
      confidenceMin: z.number().min(0).max(100).default(35),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ clickText, expectText, target, monitorName, windowId, maxAttempts, waitAfterClickMs, confidenceMin }) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const clickFound = await performFindTextOnScreen({
        query: clickText,
        target,
        monitorName,
        windowId: windowId as WindowId | undefined,
        confidenceMin,
        limit: 1,
      });
      const match = clickFound.matches[0];
      if (!match) {
        if (attempt === maxAttempts) throw new HyprlandError("ACTION_TIMEOUT", `Could not find click text: ${clickText}`);
        await sleep(waitAfterClickMs);
        continue;
      }
      const cx = match.x + Math.floor(match.width / 2);
      const cy = match.y + Math.floor(match.height / 2);
      const resolved = await resolvePointerCoordinates(cx, cy, target, monitorName, windowId as WindowId | undefined);
      await performMouseClick(resolved.x, resolved.y, "left", 80);
      await sleep(waitAfterClickMs);
      const verifyFound = await performFindTextOnScreen({
        query: expectText,
        target,
        monitorName,
        windowId: windowId as WindowId | undefined,
        confidenceMin,
        limit: 1,
      });
      if (verifyFound.matches.length > 0) {
        await audit("click_wait_retry", { clickText, expectText, target, attempt, x: resolved.x, y: resolved.y, success: true }, dryRun);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, attempts: attempt, click: { x: resolved.x, y: resolved.y } }, null, 2) }],
          structuredContent: { success: true, attempts: attempt, click: { x: resolved.x, y: resolved.y } },
        };
      }
    }
    await audit("click_wait_retry", { clickText, expectText, target, success: false }, dryRun);
    throw new HyprlandError("ACTION_TIMEOUT", `Expected text did not appear: ${expectText}`);
  },
);

server.registerTool(
  "desktop_health",
  {
    title: "Desktop Health",
    description: "Report local Hyprland session health and active desktop status.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const data = await healthCheck();
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: data,
    };
  },
);

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
  "desktop_screenshot",
  {
    title: "Desktop Screenshot",
    description: "Capture screenshot of full desktop, monitor, active window, or specific window.",
    inputSchema: {
      target: z.enum(["full", "monitor", "active_window", "window"]),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ target, monitorName, windowId }) => {
    const shot = await captureScreenshot({ target, monitorName, windowId: windowId as WindowId | undefined });
    return {
      content: [
        {
          type: "image",
          data: shot.png.toString("base64"),
          mimeType: "image/png",
        },
        {
          type: "text",
          text: JSON.stringify(
            {
              width: shot.width,
              height: shot.height,
              target: shot.target,
              geometry: shot.geometry,
              monitorName: shot.monitorName ?? null,
            },
            null,
            2,
          ),
        },
      ],
      structuredContent: {
        width: shot.width,
        height: shot.height,
        target: shot.target,
        geometry: shot.geometry ?? null,
        monitorName: shot.monitorName ?? null,
      },
    };
  },
);

server.registerTool(
  "desktop_screenshot_save",
  {
    title: "Desktop Screenshot Save",
    description: "Capture screenshot and save PNG to disk.",
    inputSchema: {
      target: z.enum(["full", "monitor", "active_window", "window"]),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      filenamePrefix: z.string().min(1).max(64).default("screenshot"),
      outputDir: z.string().optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ target, monitorName, windowId, filenamePrefix, outputDir }) => {
    const shot = await captureScreenshot({ target, monitorName, windowId: windowId as WindowId | undefined });
    const dir = outputDir ?? screenshotDirDefault;
    const safePrefix = filenamePrefix.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safePrefix}.png`;
    const path = join(dir, filename);

    await mkdir(dir, { recursive: true });
    await writeFile(path, shot.png);

    await audit(
      "desktop_screenshot_save",
      { target, monitorName: monitorName ?? null, windowId: windowId ?? null, path, width: shot.width, height: shot.height },
      dryRun,
    );

    return {
      content: [{ type: "text", text: JSON.stringify({ path, width: shot.width, height: shot.height, target }, null, 2) }],
      structuredContent: { path, width: shot.width, height: shot.height, target },
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
  "workspace_list",
  {
    title: "Workspace List",
    description: "List workspaces with occupancy details.",
    inputSchema: {
      includeWindowCounts: z.boolean().default(true),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ includeWindowCounts }) => {
    const [workspaces, windows] = await Promise.all([listWorkspaces(), includeWindowCounts ? listWindows({ includeHidden: false }) : []]);
    const counts = new Map<string, number>();
    if (includeWindowCounts) {
      for (const w of windows) {
        counts.set(w.workspace, (counts.get(w.workspace) ?? 0) + 1);
      }
    }
    const out = workspaces.map((ws) => ({
      ...ws,
      windowCount: includeWindowCounts ? counts.get(ws.name) ?? 0 : undefined,
      isEmpty: includeWindowCounts ? (counts.get(ws.name) ?? 0) === 0 : undefined,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      structuredContent: { workspaces: out },
    };
  },
);

server.registerTool(
  "workspace_pick_empty",
  {
    title: "Workspace Pick Empty",
    description: "Pick first empty numeric workspace in a range.",
    inputSchema: {
      rangeStart: z.number().int().min(1).max(99).default(1),
      rangeEnd: z.number().int().min(1).max(99).default(10),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ rangeStart, rangeEnd }) => {
    const windows = await listWindows({ includeHidden: false });
    const workspace = pickFirstEmptyWorkspace(windows, rangeStart, rangeEnd);
    return {
      content: [{ type: "text", text: JSON.stringify({ workspace, rangeStart, rangeEnd }, null, 2) }],
      structuredContent: { workspace, rangeStart, rangeEnd },
    };
  },
);

server.registerTool(
  "app_launch",
  {
    title: "App Launch",
    description: "Launch an app command, optionally in a specific or empty workspace.",
    inputSchema: {
      command: z.string().min(1).max(240).optional(),
      appName: z.string().min(1).max(64).optional(),
      workspace: z.string().optional(),
      preferEmptyWorkspace: z.boolean().default(false),
      rangeStart: z.number().int().min(1).max(99).default(1),
      rangeEnd: z.number().int().min(1).max(99).default(10),
      keepCurrentWorkspace: z.boolean().default(true),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ command, appName, workspace, preferEmptyWorkspace, rangeStart, rangeEnd, keepCurrentWorkspace }) => {
    const started = Date.now();
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const resolvedCommand = command ?? (appName ? await resolveAppLaunchCommand(appName) : null);
    if (!resolvedCommand) {
      throw new HyprlandError("APP_LAUNCH_FAILED", "No launch command available. Provide command or a valid installed appName.");
    }
    const safeCommand = sanitizeLaunchCommand(resolvedCommand);
    if (!(await commandExists(safeCommand))) {
      throw new HyprlandError("APP_LAUNCH_FAILED", "Launch executable not found in PATH");
    }

    let targetWorkspace = workspace;
    if (!targetWorkspace && preferEmptyWorkspace) {
      const windows = await listWindows({ includeHidden: false });
      targetWorkspace = pickFirstEmptyWorkspace(windows, rangeStart, rangeEnd) ?? undefined;
    }

    const originalWorkspace = keepCurrentWorkspace ? await focusedWorkspaceName() : null;
    const launchCommand = targetWorkspace ? `[workspace ${targetWorkspace}] ${safeCommand}` : safeCommand;

    const payload = {
      appName: appName ?? null,
      command: safeCommand,
      workspace: targetWorkspace ?? null,
      preferEmptyWorkspace,
      rangeStart,
      rangeEnd,
      keepCurrentWorkspace,
      launchCommand,
    };

    if (dryRun) {
      await audit("app_launch", payload, dryRun, {
        requestId,
        result: "ok",
        errorCode: null,
        durationMs: Date.now() - started,
      });
      return {
        content: [{ type: "text", text: `DRY_RUN launch ${launchCommand}` }],
        structuredContent: { launchCommand, workspace: targetWorkspace ?? null, dryRun: true },
      };
    }
    try {
      await hyprctlDispatch("exec", launchCommand);

      if (keepCurrentWorkspace && originalWorkspace && targetWorkspace && originalWorkspace !== targetWorkspace) {
        try {
          await hyprctlDispatch("workspace", originalWorkspace);
        } catch {
          // Keep launch success even if workspace restore fails.
        }
      }

      await audit("app_launch", payload, dryRun, {
        requestId,
        result: "ok",
        errorCode: null,
        durationMs: Date.now() - started,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ launched: true, workspace: targetWorkspace ?? null, appName: appName ?? null, command: safeCommand }, null, 2),
          },
        ],
        structuredContent: { launched: true, workspace: targetWorkspace ?? null, appName: appName ?? null, command: safeCommand },
      };
    } catch (err) {
      const errorCode = err instanceof HyprlandError ? err.code : "APP_LAUNCH_FAILED";
      await audit("app_launch", payload, dryRun, {
        requestId,
        result: "error",
        errorCode,
        durationMs: Date.now() - started,
      });
      throw err;
    }
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
  "app_launch_and_wait",
  {
    title: "App Launch And Wait",
    description: "Launch app and wait for a matching window.",
    inputSchema: {
      command: z.string().min(1).max(240).optional(),
      appName: z.string().min(1).max(64).optional(),
      workspace: z.string().optional(),
      preferEmptyWorkspace: z.boolean().default(false),
      rangeStart: z.number().int().min(1).max(99).default(1),
      rangeEnd: z.number().int().min(1).max(99).default(10),
      keepCurrentWorkspace: z.boolean().default(true),
      classEquals: z.string().optional(),
      classContains: z.string().optional(),
      titleContains: z.string().optional(),
      timeoutMs: z.number().int().min(100).max(120000).default(12000),
      pollMs: z.number().int().min(50).max(5000).default(200),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (args) => {
    const resolvedCommand = args.command ?? (args.appName ? await resolveAppLaunchCommand(args.appName) : null);
    if (!resolvedCommand) {
      throw new HyprlandError("APP_LAUNCH_FAILED", "No launch command available. Provide command or a valid installed appName.");
    }
    const safeCommand = sanitizeLaunchCommand(resolvedCommand);
    if (!(await commandExists(safeCommand))) {
      throw new HyprlandError("APP_LAUNCH_FAILED", "Launch executable not found in PATH");
    }

    let targetWorkspace = args.workspace;
    if (!targetWorkspace && args.preferEmptyWorkspace) {
      const windows = await listWindows({ includeHidden: false });
      targetWorkspace = pickFirstEmptyWorkspace(windows, args.rangeStart, args.rangeEnd) ?? undefined;
    }
    const originalWorkspace = args.keepCurrentWorkspace ? await focusedWorkspaceName() : null;
    const launchCommand = targetWorkspace ? `[workspace ${targetWorkspace}] ${safeCommand}` : safeCommand;

    if (!dryRun) {
      await hyprctlDispatch("exec", launchCommand);
      if (args.keepCurrentWorkspace && originalWorkspace && targetWorkspace && originalWorkspace !== targetWorkspace) {
        try {
          await hyprctlDispatch("workspace", originalWorkspace);
        } catch {
          // keep success
        }
      }
    }

    const wait = await waitForWindow(
      {
        classEquals: args.classEquals,
        classContains: args.classContains,
        titleContains: args.titleContains,
        workspace: targetWorkspace,
      },
      args.timeoutMs,
      args.pollMs,
    );
    if (dryRun) {
      return {
        content: [{ type: "text", text: JSON.stringify({ dryRun: true, launchCommand, waitedAttempts: wait.attempts }, null, 2) }],
        structuredContent: { dryRun: true, launchCommand, waitedAttempts: wait.attempts },
      };
    }
    if (!wait.found) {
      throw new HyprlandError("WINDOW_NOT_FOUND", `Launch succeeded but no matching window appeared within ${args.timeoutMs}ms`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ launchCommand, workspace: targetWorkspace ?? null, window: wait.found, attempts: wait.attempts }, null, 2) }],
      structuredContent: { launchCommand, workspace: targetWorkspace ?? null, window: wait.found, attempts: wait.attempts },
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

    const output = await hyprctlDispatch("focuswindow", `address:${windowId}`);
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

    const params = mode === "absolute" ? `exact ${xx} ${yy},address:${windowId}` : `${xx} ${yy},address:${windowId}`;

    await audit("window_move", { windowId, mode, x: xx, y: yy }, dryRun);

    if (dryRun) {
      return { content: [{ type: "text", text: `DRY_RUN movewindowpixel ${params}` }] };
    }

    const output = await hyprctlDispatch("movewindowpixel", params);
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

    const params = mode === "absolute" ? `exact ${w} ${h},address:${windowId}` : `${w} ${h},address:${windowId}`;

    await audit("window_resize", { windowId, mode, width: w, height: h }, dryRun);

    if (dryRun) {
      return { content: [{ type: "text", text: `DRY_RUN resizewindowpixel ${params}` }] };
    }

    const output = await hyprctlDispatch("resizewindowpixel", params);
    return { content: [{ type: "text", text: output || "ok" }] };
  },
);

server.registerTool(
  "workspace_focus",
  {
    title: "Workspace Focus",
    description: "Switch focus to a target workspace.",
    inputSchema: {
      workspace: z.string().min(1),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ workspace }) => {
    await audit("workspace_focus", { workspace }, dryRun);
    const params = workspace;

    if (dryRun) {
      return { content: [{ type: "text", text: `DRY_RUN workspace ${params}` }] };
    }

    const output = await hyprctlDispatch("workspace", params);
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
    const params = `${workspace},address:${windowId}`;

    await audit("window_send_to_workspace", { windowId, workspace }, dryRun);

    if (dryRun) {
      return { content: [{ type: "text", text: `DRY_RUN movetoworkspace ${params}` }] };
    }

    const output = await hyprctlDispatch("movetoworkspace", params);
    return { content: [{ type: "text", text: output || "ok" }] };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = formatError(error);
  process.stderr.write(`use-mcp fatal error: ${message}\n`);
  process.exit(1);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
