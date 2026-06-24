import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HyprlandError } from "./hyprland.js";
import type { LaunchPolicy } from "./policy.js";
import { parseLaunchCommand } from "./policy.js";
import { commandExists } from "./util.js";
import { readStateSync, statePath, withStateLockSync, writeStateAtomicSync } from "./state.js";

const execFileAsync = promisify(execFile);

export interface AppCatalogEntry {
  name: string;
  description: string;
  commands: string[];
}

export const APP_CATALOG: AppCatalogEntry[] = [
  { name: "zen", description: "Privacy-focused web browser for tabs, web apps, and research.", commands: ["zen-browser", "flatpak run app.zen_browser.zen", "zen"] },
  { name: "zathura", description: "Keyboard-first PDF/document viewer.", commands: ["zathura"] },
  { name: "kitty", description: "GPU-accelerated terminal emulator.", commands: ["kitty"] },
  { name: "code", description: "Visual Studio Code editor and IDE.", commands: ["code"] },
  { name: "firefox", description: "General-purpose web browser.", commands: ["firefox"] },
  { name: "chromium", description: "Chromium browser for web testing.", commands: ["chromium", "google-chrome-stable", "google-chrome"] },
  { name: "nautilus", description: "File manager for browsing and opening files.", commands: ["nautilus"] },
];

export async function isLaunchCommandAvailable(command: string, launch: LaunchPolicy): Promise<boolean> {
  const parsed = parseLaunchCommand(command, launch);
  if (!(await commandExists(parsed.executable))) return false;
  if (parsed.executable === "flatpak" && parsed.args[0] === "run" && parsed.args[1]) {
    try {
      await execFileAsync("flatpak", ["info", parsed.args[1]]);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

export async function resolveAppLaunchCommand(appName: string, launch: LaunchPolicy): Promise<string | null> {
  if (!launch.allowedAppAliases.includes(appName)) return null;
  const app = APP_CATALOG.find((a) => a.name === appName);
  if (!app) return null;
  for (const cmd of app.commands) {
    if (await isLaunchCommandAvailable(cmd, launch)) {
      return parseLaunchCommand(cmd, launch).normalized;
    }
  }
  return null;
}

/**
 * Creates a sliding-window rate limiter for launches. The returned function
 * records an attempt and throws `APP_LAUNCH_FAILED` if the per-minute cap is hit.
 */
export function createLaunchRateLimiter(maxLaunchesPerMinute: number): () => void {
  const timestampsMs: number[] = [];
  return () => {
    const now = Date.now();
    const windowStart = now - 60_000;
    while (timestampsMs.length > 0 && timestampsMs[0] < windowStart) {
      timestampsMs.shift();
    }
    if (timestampsMs.length >= maxLaunchesPerMinute) {
      throw new HyprlandError("APP_LAUNCH_FAILED", `Launch rate limit exceeded (${maxLaunchesPerMinute}/min)`);
    }
    timestampsMs.push(now);
  };
}

export function createPersistentLaunchRateLimiter(
  maxLaunchesPerMinute: number,
  path = statePath("launch-timestamps.json"),
  nowMs: () => number = Date.now,
): () => void {
  return () => withStateLockSync(path, () => {
    const now = nowMs();
    const windowStart = now - 60_000;
    const timestamps = (readStateSync<unknown[]>(path) ?? [])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= windowStart)
      .sort((a, b) => a - b);
    if (timestamps.length >= maxLaunchesPerMinute) {
      throw new HyprlandError("APP_LAUNCH_FAILED", `Launch rate limit exceeded (${maxLaunchesPerMinute}/min)`);
    }
    timestamps.push(now);
    writeStateAtomicSync(path, timestamps);
  });
}
