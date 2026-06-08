import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { focusWindow, HyprlandError, sendShortcut } from "./hyprland.js";
import type { WindowInfo } from "./types.js";
import { commandExists, sleep } from "./util.js";
import {
  type BrowserOpenMode,
  type BrowserOpenUrlResult,
  type BrowserReadinessMode,
  type BrowserReadinessResult,
  type ZenShortcutInfo,
  ZEN_FLATPAK_ID,
} from "./browser-types.js";

const execFileAsync = promisify(execFile);

export function isZenWindow(window: WindowInfo): boolean {
  const className = window.class.toLowerCase();
  return className === "zen" || className === "zen-alpha" || className === ZEN_FLATPAK_ID || className.startsWith("zen-");
}

export function zenWindows(windows: WindowInfo[], titleContains?: string): WindowInfo[] {
  const titleNeedle = titleContains?.toLowerCase();
  return windows
    .filter(isZenWindow)
    .filter((window) => (titleNeedle ? window.title.toLowerCase().includes(titleNeedle) : true))
    .sort((a, b) => Number(b.focused) - Number(a.focused) || Number(b.mapped) - Number(a.mapped) || a.workspace.localeCompare(b.workspace));
}

export function defaultReadinessMode(url: string, requested?: BrowserReadinessMode): BrowserReadinessMode {
  if (requested) return requested;
  return url.startsWith("about:") ? "none" : "title-change";
}

export async function focusZenWindow(
  windows: WindowInfo[],
  args: { windowId?: string; titleContains?: string; includeHidden?: boolean },
  performFocus: boolean,
): Promise<WindowInfo> {
  const matches = zenWindows(windows, args.titleContains);
  const best = args.windowId ? matches.find((window) => window.id === args.windowId) : matches[0];
  if (!best) {
    throw new HyprlandError("WINDOW_NOT_FOUND", args.windowId ? `Zen window not found: ${args.windowId}` : "No Zen window found");
  }
  if (performFocus) await focusWindow(best.id);
  return best;
}

export function validateBrowserUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new HyprlandError("APP_LAUNCH_FAILED", "Browser URL must be absolute");
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    if (url.username || url.password) {
      throw new HyprlandError("APP_LAUNCH_FAILED", "Browser URL must not include credentials");
    }
    return url.toString();
  }
  if (url.protocol === "about:" && (input === "about:home" || input === "about:blank")) {
    return input;
  }
  throw new HyprlandError("APP_LAUNCH_FAILED", "Browser URL scheme is not allowed");
}

export async function spawnZen(url: string, mode: "new-window" | "new-tab"): Promise<void> {
  const args = ["run", ZEN_FLATPAK_ID, mode === "new-tab" ? "--new-tab" : "--new-window", url];
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("flatpak", args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}

export function shortcutToHypr(shortcut: ZenShortcutInfo): { mods: string; key: string; label: string } {
  const mods: string[] = [];
  if (shortcut.modifiers.control || shortcut.modifiers.accel) mods.push("CTRL");
  if (shortcut.modifiers.alt) mods.push("ALT");
  if (shortcut.modifiers.shift) mods.push("SHIFT");
  if (shortcut.modifiers.meta) mods.push("SUPER");
  const rawKey = shortcut.keycode ?? shortcut.key;
  if (!rawKey) throw new HyprlandError("INPUT_FAILED", `Zen shortcut ${shortcut.action ?? shortcut.id ?? "unknown"} has no key`);
  const keyMap: Record<string, string> = {
    VK_LEFT: "LEFT",
    VK_RIGHT: "RIGHT",
    VK_RETURN: "RETURN",
    VK_TAB: "TAB",
    VK_ESCAPE: "ESCAPE",
    VK_DELETE: "DELETE",
  };
  const key = keyMap[rawKey] ?? rawKey.toUpperCase();
  return { mods: mods.join(" "), key, label: `${mods.join("+")}${mods.length ? "+" : ""}${key}` };
}

export async function typeWithWtype(text: string, delayMs = 0): Promise<void> {
  if (!(await commandExists("wtype"))) {
    throw new HyprlandError("INPUT_FAILED", "wtype is not installed");
  }
  if (delayMs > 0) {
    await execFileAsync("wtype", ["-d", String(delayMs), text]);
  } else {
    await execFileAsync("wtype", [text]);
  }
}

function blankLikeZenTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return normalized === "" || normalized === "zen browser" || normalized === "new tab";
}

export async function waitForZenReadiness(args: {
  windowId: string;
  titleBefore?: string | null;
  mode: BrowserReadinessMode;
  titleContains?: string;
  timeoutMs: number;
  pollMs: number;
  listWindows: () => Promise<WindowInfo[]>;
}): Promise<BrowserReadinessResult> {
  const started = Date.now();
  let attempts = 0;
  let last: WindowInfo | null = null;

  while (Date.now() - started <= args.timeoutMs) {
    attempts += 1;
    last = (await args.listWindows()).find((window) => window.id === args.windowId) ?? last;
    if (!last) {
      await sleep(args.pollMs);
      continue;
    }

    const title = last.title;
    const titleNeedle = args.titleContains?.trim().toLowerCase();
    if (args.mode === "none") {
      return {
        ready: true,
        mode: args.mode,
        reason: "no-wait",
        attempts,
        waitedMs: Date.now() - started,
        titleBefore: args.titleBefore ?? null,
        titleAfter: title,
        window: last,
      };
    }
    if (args.mode === "title-contains" && titleNeedle && title.toLowerCase().includes(titleNeedle)) {
      return {
        ready: true,
        mode: args.mode,
        reason: "title-matched",
        attempts,
        waitedMs: Date.now() - started,
        titleBefore: args.titleBefore ?? null,
        titleAfter: title,
        window: last,
      };
    }
    if (args.mode === "title-change" && title !== args.titleBefore && !blankLikeZenTitle(title)) {
      return {
        ready: true,
        mode: args.mode,
        reason: "title-changed",
        attempts,
        waitedMs: Date.now() - started,
        titleBefore: args.titleBefore ?? null,
        titleAfter: title,
        window: last,
      };
    }
    await sleep(args.pollMs);
  }

  if (!last) {
    const windows = await args.listWindows();
    last = windows.find((window) => window.id === args.windowId) ?? windows[0];
  }
  if (!last) {
    throw new HyprlandError("WINDOW_NOT_FOUND", `Zen window disappeared while waiting for readiness: ${args.windowId}`);
  }
  return {
    ready: false,
    mode: args.mode,
    reason: "timeout",
    attempts,
    waitedMs: Date.now() - started,
    titleBefore: args.titleBefore ?? null,
    titleAfter: last.title,
    window: last,
  };
}

export async function waitForZenWindowAfterLaunch(args: {
  baselineIds: Set<string>;
  preferNewWindow: boolean;
  titleContains?: string;
  timeoutMs: number;
  pollMs: number;
  listWindows: () => Promise<WindowInfo[]>;
}): Promise<{ window: WindowInfo | null; attempts: number; wasNewWindow: boolean }> {
  const started = Date.now();
  let attempts = 0;
  while (Date.now() - started <= args.timeoutMs) {
    attempts += 1;
    const matches = zenWindows(await args.listWindows(), args.titleContains);
    const newMatches = matches.filter((window) => !args.baselineIds.has(window.id));
    if (newMatches.length > 0) return { window: newMatches[0], attempts, wasNewWindow: true };
    if (!args.preferNewWindow && matches.length > 0) return { window: matches[0], attempts, wasNewWindow: false };
    await sleep(args.pollMs);
  }
  return { window: null, attempts, wasNewWindow: false };
}

async function tryReusableZenWindow(windows: WindowInfo[], titleContains?: string): Promise<WindowInfo | null> {
  try {
    return await focusZenWindow(windows, { titleContains }, false);
  } catch (error) {
    if (error instanceof HyprlandError && error.code === "WINDOW_NOT_FOUND") return null;
    throw error;
  }
}

export async function openZenUrl(args: {
  url: string;
  mode: BrowserOpenMode;
  titleContains?: string;
  typeDelayMs: number;
  timeoutMs: number;
  pollMs: number;
  readinessMode: BrowserReadinessMode;
  readyTitleContains?: string;
  readyTimeoutMs: number;
  readyPollMs: number;
  listWindows: () => Promise<WindowInfo[]>;
}): Promise<BrowserOpenUrlResult> {
  const beforeWindows = await args.listWindows();
  const baselineIds = new Set(beforeWindows.map((window) => window.id));
  const reusableWindow = args.mode !== "new-window" ? await tryReusableZenWindow(beforeWindows, args.titleContains) : null;
  const effectiveMode: BrowserOpenMode | "new-window-fallback" = reusableWindow
    ? args.mode
    : args.mode === "new-window"
      ? "new-window"
      : "new-window-fallback";

  let targetWindow: WindowInfo;
  let attempts: number;
  let wasNewWindow: boolean;
  let titleBefore: string | null;

  if (reusableWindow) {
    titleBefore = reusableWindow.title;
    await focusWindow(reusableWindow.id);
    if (args.mode === "new-tab") await sendShortcut("CTRL", "T");
    await sendShortcut("CTRL", "L");
    await typeWithWtype(args.url, args.typeDelayMs);
    await sendShortcut("", "RETURN");
    targetWindow = reusableWindow;
    attempts = 1;
    wasNewWindow = false;
  } else {
    titleBefore = null;
    await spawnZen(args.url, "new-window");
    const wait = await waitForZenWindowAfterLaunch({
      baselineIds,
      preferNewWindow: true,
      titleContains: args.titleContains,
      timeoutMs: args.timeoutMs,
      pollMs: args.pollMs,
      listWindows: args.listWindows,
    });
    if (!wait.window) {
      throw new HyprlandError("WINDOW_NOT_FOUND", `Zen did not expose a matching window within ${args.timeoutMs}ms`);
    }
    await focusWindow(wait.window.id);
    targetWindow = wait.window;
    attempts = wait.attempts;
    wasNewWindow = wait.wasNewWindow;
  }

  const readiness = await waitForZenReadiness({
    windowId: targetWindow.id,
    titleBefore,
    mode: args.readinessMode,
    titleContains: args.readyTitleContains,
    timeoutMs: args.readyTimeoutMs,
    pollMs: args.readyPollMs,
    listWindows: args.listWindows,
  });

  return {
    effectiveMode,
    reusableWindow,
    targetWindow,
    attempts,
    wasNewWindow,
    titleBefore,
    readiness,
  };
}
