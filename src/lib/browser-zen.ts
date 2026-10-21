// Compatibility exports for callers that explicitly target Zen.
import {
  focusBrowserWindow,
  openBrowserUrl,
  waitForBrowserReadiness,
  waitForBrowserWindowAfterLaunch,
} from "./browser-control.js";
import { browserForWindow, browserWindows } from "./browser-catalog.js";
import type { WindowInfo } from "./types.js";
import type { ZenShortcutInfo } from "./browser-types.js";
import { HyprlandError } from "./hyprland.js";
export { defaultReadinessMode, validateBrowserUrl, typeWithWtype } from "./browser-control.js";
export const isZenWindow = (window: WindowInfo): boolean => browserForWindow(window) === "zen";
export const zenWindows = (windows: WindowInfo[], titleContains?: string): WindowInfo[] =>
  browserWindows(windows, "zen", titleContains);
export const focusZenWindow = (
  windows: WindowInfo[],
  args: Parameters<typeof focusBrowserWindow>[1],
  performFocus: boolean,
) => focusBrowserWindow(windows, { ...args, browser: "zen" }, performFocus);
export const waitForZenReadiness = waitForBrowserReadiness;
export const waitForZenWindowAfterLaunch = (
  args: Omit<Parameters<typeof waitForBrowserWindowAfterLaunch>[0], "browser">,
) => waitForBrowserWindowAfterLaunch({ ...args, browser: "zen" });
export const openZenUrl = (args: Omit<Parameters<typeof openBrowserUrl>[0], "browser">) =>
  openBrowserUrl({ ...args, browser: "zen" });

export function shortcutToHypr(shortcut: ZenShortcutInfo): { mods: string; key: string; label: string } {
  const mods: string[] = [];
  if (shortcut.modifiers.control || shortcut.modifiers.accel) mods.push("CTRL");
  if (shortcut.modifiers.alt) mods.push("ALT");
  if (shortcut.modifiers.shift) mods.push("SHIFT");
  if (shortcut.modifiers.meta) mods.push("SUPER");
  const rawKey = shortcut.keycode ?? shortcut.key;
  if (!rawKey)
    throw new HyprlandError("INPUT_FAILED", `Zen shortcut ${shortcut.action ?? shortcut.id ?? "unknown"} has no key`);
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
