import { resolveBrowserProfile, type NativeProfile } from "./browser-profiles.js";
import { desktopEnvironment } from "./desktop-environment.js";
import { spawn } from "node:child_process";
import { assertWindowFocus, focusWindow, HyprlandError, sendShortcut } from "./hyprland.js";
import {
  browserDefinition,
  browserForWindow,
  browserWindows,
  type BrowserId,
  type BrowserSelector,
} from "./browser-catalog.js";
import { resolveAppLaunchCommand } from "./apps.js";
import { parseLaunchCommand, type LaunchPolicy } from "./policy.js";
import { typeText, typingTimeout } from "./typing.js";
import { sleep } from "./util.js";
import type { WindowInfo } from "./types.js";
import type {
  BrowserOpenMode,
  BrowserOpenUrlResult,
  BrowserReadinessMode,
  BrowserReadinessResult,
} from "./browser-types.js";

export function selectBrowser(
  windows: WindowInfo[],
  requested: BrowserSelector = "auto",
  windowId?: string,
  fallback: BrowserId | null = null,
  titleContains?: string,
): BrowserId {
  if (windowId) {
    const target = windows.find((window) => window.id === windowId);
    const identity = target && browserForWindow(target);
    if (!identity || (requested !== "auto" && requested !== identity)) {
      throw new HyprlandError("WINDOW_NOT_FOUND", `No matching browser window: ${windowId}`);
    }
    return identity;
  }
  if (requested !== "auto") return requested;
  const candidates = browserWindows(windows, undefined, titleContains);
  const focused = candidates.find((window) => window.focused);
  if (focused) return browserForWindow(focused)!;
  const identities = [...new Set(candidates.map((window) => browserForWindow(window)!))];
  if (identities.length === 1) return identities[0];
  if (identities.length > 1)
    throw new HyprlandError("INPUT_FAILED", "Multiple browsers are open; specify --browser or --window-id");
  if (fallback) return fallback;
  throw new HyprlandError("WINDOW_NOT_FOUND", "No browser window found; specify --browser to launch one");
}

export async function focusBrowserWindow(
  windows: WindowInfo[],
  args: { browser?: BrowserId; windowId?: string; titleContains?: string; includeHidden?: boolean },
  performFocus: boolean,
): Promise<WindowInfo> {
  const matches = browserWindows(windows, args.browser, args.titleContains, args.includeHidden);
  const best = args.windowId
    ? matches.find((window) => window.id === args.windowId)
    : (matches.find((window) => window.focused) ?? (matches.length === 1 ? matches[0] : undefined));
  if (!best) {
    if (!args.windowId && matches.length > 1)
      throw new HyprlandError(
        "INPUT_FAILED",
        "Multiple browser windows match; specify --window-id or --title-contains",
      );
    throw new HyprlandError(
      "WINDOW_NOT_FOUND",
      `No matching ${args.browser ?? "browser"} window${args.windowId ? `: ${args.windowId}` : ""}`,
    );
  }
  if (performFocus) {
    await focusWindow(best.id);
    return assertBrowserFocus(best.id);
  }
  return best;
}

export const assertBrowserFocus = assertWindowFocus;

export function defaultReadinessMode(url: string, requested?: BrowserReadinessMode): BrowserReadinessMode {
  return requested ?? (url.startsWith("about:") ? "none" : "title-change");
}

export function validateBrowserUrl(input: string): string {
  // URL() silently removes newlines and tabs. Reject them before normalizing.
  if (/[\u0000-\u0020\u007f]/.test(input))
    throw new HyprlandError("APP_LAUNCH_FAILED", "Browser URL contains whitespace or control characters");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new HyprlandError("APP_LAUNCH_FAILED", "Browser URL must be absolute");
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    if (url.username || url.password)
      throw new HyprlandError("APP_LAUNCH_FAILED", "Browser URL must not include credentials");
    return url.toString();
  }
  if (input === "about:home" || input === "about:blank") return input;
  throw new HyprlandError("APP_LAUNCH_FAILED", "Browser URL scheme is not allowed");
}

export const typeWithWtype = typeText;

function blankBrowserTitle(title: string): boolean {
  return /^(?:new tab|new private tab|new incognito tab|about:blank|about:home|zen browser|mozilla firefox|firefox|librewolf|floorp|helium|chromium|google chrome|brave|vivaldi|microsoft edge)?(?:\s*[-|–—]\s*(?:zen browser|mozilla firefox|firefox|librewolf|floorp|helium|chromium|google chrome|brave|vivaldi|microsoft edge))?$/i.test(
    title.trim(),
  );
}

export async function waitForBrowserReadiness(args: {
  windowId: string;
  titleBefore?: string | null;
  mode: BrowserReadinessMode;
  titleContains?: string;
  timeoutMs: number;
  pollMs: number;
  listWindows: () => Promise<WindowInfo[]>;
}): Promise<BrowserReadinessResult> {
  if (args.mode === "title-contains" && !args.titleContains?.trim())
    throw new HyprlandError("INPUT_FAILED", "title-contains readiness requires titleContains");
  const started = Date.now();
  let attempts = 0;
  while (true) {
    attempts += 1;
    const window = (await args.listWindows()).find(
      (candidate) => candidate.id === args.windowId && candidate.mapped && !candidate.hidden,
    );
    if (!window)
      throw new HyprlandError(
        "WINDOW_NOT_FOUND",
        `Browser window disappeared while waiting for readiness: ${args.windowId}`,
      );
    const matched =
      args.mode === "title-contains" && window.title.toLowerCase().includes(args.titleContains!.trim().toLowerCase());
    const changed =
      args.mode === "title-change" && window.title !== args.titleBefore && !blankBrowserTitle(window.title);
    const ready = args.mode === "none" || matched || changed;
    const waitedMs = Date.now() - started;
    if (ready || waitedMs >= args.timeoutMs)
      return {
        ready,
        mode: args.mode,
        reason: ready ? (args.mode === "none" ? "no-wait" : matched ? "title-matched" : "title-changed") : "timeout",
        attempts,
        waitedMs,
        titleBefore: args.titleBefore ?? null,
        titleAfter: window.title,
        window,
      };
    await sleep(Math.min(Math.max(1, args.pollMs), args.timeoutMs - waitedMs));
  }
}

export async function waitForBrowserWindowAfterLaunch(args: {
  browser: BrowserId;
  baselineIds: Set<string>;
  preferNewWindow: boolean;
  titleContains?: string;
  timeoutMs: number;
  pollMs: number;
  listWindows: () => Promise<WindowInfo[]>;
}): Promise<{ window: WindowInfo | null; attempts: number; wasNewWindow: boolean }> {
  const started = Date.now();
  let attempts = 0;
  while (true) {
    attempts += 1;
    const matches = browserWindows(await args.listWindows(), args.browser, args.titleContains);
    const fresh = matches.filter((window) => !args.baselineIds.has(window.id));
    if (fresh.length === 1) return { window: fresh[0], attempts, wasNewWindow: true };
    if (fresh.length > 1)
      throw new HyprlandError("INPUT_FAILED", "Multiple new browser windows appeared; specify a narrower target");
    if (!args.preferNewWindow && matches.length === 1) return { window: matches[0], attempts, wasNewWindow: false };
    const remaining = args.timeoutMs - (Date.now() - started);
    if (remaining <= 0) return { window: null, attempts, wasNewWindow: false };
    await sleep(Math.min(Math.max(1, args.pollMs), remaining));
  }
}

export async function resolveBrowserLaunch(browser: BrowserId, launch: LaunchPolicy): Promise<string> {
  const command = await resolveAppLaunchCommand(browser, launch);
  if (!command) throw new HyprlandError("APP_LAUNCH_FAILED", `${browser} is unavailable or disabled by launch policy`);
  return command;
}

async function spawnBrowser(command: string, url: string, launch: LaunchPolicy, profile?: NativeProfile): Promise<void> {
  const parsed = parseLaunchCommand(command, launch);
  const windowArgs = [
    ...(profile ? [`--user-data-dir=${profile.userDataDir}`, `--profile-directory=${profile.directory}`] : []),
    "--new-window",
    url,
  ];
  const env = await desktopEnvironment();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(parsed.executable, [...parsed.args, ...windowArgs], { env, detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function openBrowserUrl(args: {
  browser: BrowserId;
  windowId?: string;
  profile?: string;
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
  launch: LaunchPolicy;
  beforeLaunch: () => void;
  dryRun?: boolean;
}): Promise<BrowserOpenUrlResult> {
  const url = validateBrowserUrl(args.url);
  if (args.profile && (args.windowId || args.mode !== "new-window"))
    throw new HyprlandError(
      "INPUT_FAILED",
      "Profile selection requires a new window and cannot reuse an unverified window id",
    );
  const profile = args.profile ? await resolveBrowserProfile(args.browser, args.profile) : undefined;
  if (url === "about:home" && browserDefinition(args.browser).family === "chromium") {
    throw new HyprlandError(
      "INPUT_FAILED",
      "about:home requires a Firefox-family browser; use about:blank for portability",
    );
  }
  const before = await args.listWindows();
  let reusableWindow: WindowInfo | null = null;
  if (args.mode !== "new-window") {
    try {
      reusableWindow = await focusBrowserWindow(before, args, false);
    } catch (error) {
      if (
        !(error instanceof HyprlandError) ||
        error.code !== "WINDOW_NOT_FOUND" ||
        args.windowId ||
        args.titleContains ||
        args.mode === "current-tab"
      )
        throw error;
    }
  } else if (args.windowId)
    throw new HyprlandError("INPUT_FAILED", "--window-id cannot be combined with new-window mode");
  const effectiveMode = reusableWindow ? args.mode : args.mode === "new-window" ? "new-window" : "new-window-fallback";
  const command = reusableWindow ? null : await resolveBrowserLaunch(args.browser, args.launch);
  if (args.dryRun)
    return {
      profile: profile ?? null,
      effectiveMode,
      reusableWindow,
      targetWindow: reusableWindow,
      command,
      attempts: 0,
      wasNewWindow: false,
      titleBefore: reusableWindow?.title ?? null,
      readiness: null,
    };
  let targetWindow: WindowInfo;
  let attempts = 1;
  let wasNewWindow = false;
  const titleBefore = reusableWindow?.title ?? null;
  if (reusableWindow) {
    typingTimeout(url, args.typeDelayMs);
    await focusWindow(reusableWindow.id);
    const shortcut = async (mods: string, key: string) => {
      await assertBrowserFocus(reusableWindow!.id);
      await sendShortcut(mods, key);
    };
    if (args.mode === "new-tab") await shortcut("CTRL", "T");
    await shortcut("CTRL", "L");
    await assertBrowserFocus(reusableWindow.id);
    await typeText(url, args.typeDelayMs);
    await shortcut("", "RETURN");
    targetWindow = reusableWindow;
  } else {
    args.beforeLaunch();
    await spawnBrowser(command!, url, args.launch, profile);
    const wait = await waitForBrowserWindowAfterLaunch({
      ...args,
      baselineIds: new Set(before.map((window) => window.id)),
      preferNewWindow: true,
    });
    if (!wait.window)
      throw new HyprlandError(
        "WINDOW_NOT_FOUND",
        `${args.browser} did not expose a matching window within ${args.timeoutMs}ms`,
      );
    targetWindow = wait.window;
    await focusWindow(targetWindow.id);
    attempts = wait.attempts;
    wasNewWindow = wait.wasNewWindow;
  }
  const readiness = await waitForBrowserReadiness({
    windowId: targetWindow.id,
    titleBefore,
    mode: args.readinessMode,
    titleContains: args.readyTitleContains,
    timeoutMs: args.readyTimeoutMs,
    pollMs: args.readyPollMs,
    listWindows: args.listWindows,
  });
  return { profile: profile ?? null, effectiveMode, reusableWindow, targetWindow, command, attempts, wasNewWindow, titleBefore, readiness };
}
