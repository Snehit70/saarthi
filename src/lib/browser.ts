import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { HyprlandError } from "./hyprland.js";
import { isLaunchCommandAvailable } from "./apps.js";
import type { LaunchPolicy } from "./policy.js";
import type { WindowInfo } from "./types.js";
import { commandExists, sleep } from "./util.js";

const execFileAsync = promisify(execFile);

export const ZEN_FLATPAK_ID = "app.zen_browser.zen";
export const ZEN_LAUNCH_COMMAND = `flatpak run ${ZEN_FLATPAK_ID}`;

export interface BrowserProfileInfo {
  name: string;
  path: string;
  isDefault: boolean;
  source: string;
}

export interface LocalBrowserDiscovery {
  primary: "zen-flatpak";
  defaultBrowser: string | null;
  httpHandler: string | null;
  httpsHandler: string | null;
  zen: {
    installed: boolean;
    policyAllowed: boolean;
    appId: string;
    launchCommand: string;
    profilesRoot: string;
    profiles: BrowserProfileInfo[];
  };
  firefox: {
    installed: boolean;
    profilesRoot: string;
    profiles: BrowserProfileInfo[];
  };
  runningWindows: WindowInfo[];
}

type IniSection = Record<string, string>;

function parseIni(input: string): Record<string, IniSection> {
  const sections: Record<string, IniSection> = {};
  let current: IniSection | null = null;
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      current = {};
      sections[section[1]] = current;
      continue;
    }
    if (!current) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    current[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return sections;
}

async function readProfilesIni(path: string): Promise<BrowserProfileInfo[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const sections = parseIni(raw);
  const baseDir = dirname(path);
  return Object.entries(sections)
    .filter(([name]) => /^Profile\d+$/.test(name))
    .map(([, section]) => {
      const profilePath = section.Path ?? "";
      const isRelative = section.IsRelative !== "0";
      return {
        name: section.Name ?? "",
        path: isRelative ? resolve(baseDir, profilePath) : profilePath,
        isDefault: section.Default === "1",
        source: path,
      };
    })
    .filter((profile) => profile.name && profile.path);
}

async function firstProfilesIni(paths: string[]): Promise<BrowserProfileInfo[]> {
  for (const path of paths) {
    const profiles = await readProfilesIni(path);
    if (profiles.length > 0) return profiles;
  }
  return [];
}

async function commandOutput(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args);
    const text = stdout.trim();
    return text || null;
  } catch {
    return null;
  }
}

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

export async function discoverLocalBrowsers(launch: LaunchPolicy, windows: WindowInfo[]): Promise<LocalBrowserDiscovery> {
  const home = homedir();
  const zenProfilesRoot = join(home, ".var", "app", ZEN_FLATPAK_ID, ".zen");
  const firefoxProfilesRoot = join(home, ".mozilla", "firefox");
  const [zenInstalled, firefoxInstalled, defaultBrowser, httpHandler, httpsHandler, zenProfiles, firefoxProfiles] = await Promise.all([
    isLaunchCommandAvailable(ZEN_LAUNCH_COMMAND, launch),
    commandExists("firefox"),
    commandOutput("xdg-settings", ["get", "default-web-browser"]),
    commandOutput("xdg-mime", ["query", "default", "x-scheme-handler/http"]),
    commandOutput("xdg-mime", ["query", "default", "x-scheme-handler/https"]),
    firstProfilesIni([
      join(zenProfilesRoot, "profiles.ini"),
      join(home, ".var", "app", ZEN_FLATPAK_ID, "config", "zen", "profiles.ini"),
    ]),
    firstProfilesIni([join(firefoxProfilesRoot, "profiles.ini")]),
  ]);

  return {
    primary: "zen-flatpak",
    defaultBrowser,
    httpHandler,
    httpsHandler,
    zen: {
      installed: zenInstalled,
      policyAllowed: launch.allowedAppAliases.includes("zen"),
      appId: ZEN_FLATPAK_ID,
      launchCommand: ZEN_LAUNCH_COMMAND,
      profilesRoot: zenProfilesRoot,
      profiles: zenProfiles,
    },
    firefox: {
      installed: firefoxInstalled,
      profilesRoot: firefoxProfilesRoot,
      profiles: firefoxProfiles,
    },
    runningWindows: zenWindows(windows),
  };
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
