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

export interface BrowserExtensionInfo {
  id: string;
  name: string;
  active: boolean;
  userDisabled: boolean;
  hidden: boolean;
}

export interface BrowserContainerInfo {
  name: string | null;
  userContextId: number;
  public: boolean;
}

export interface ZenShortcutInfo {
  id: string | null;
  action: string | null;
  key: string | null;
  keycode: string | null;
  disabled: boolean;
  modifiers: {
    control: boolean;
    alt: boolean;
    shift: boolean;
    meta: boolean;
    accel: boolean;
  };
}

export interface ZenDeviceInfo {
  singleProfile: boolean;
  defaultProfileName: string | null;
  defaultProfilePath: string | null;
  preferences: {
    verticalTabsRightSide: boolean | null;
    urlbarBehavior: string | null;
    workspacesContinueWhereLeftOff: boolean | null;
    activeWorkspaceId: string | null;
    workspaceSyncEnabled: boolean | null;
  };
  containers: BrowserContainerInfo[];
  extensions: BrowserExtensionInfo[];
  knownExtensions: Record<string, boolean>;
  shortcuts: {
    workspaceForward: ZenShortcutInfo | null;
    workspaceBackward: ZenShortcutInfo | null;
    pinTabToggle: ZenShortcutInfo | null;
    copyUrl: ZenShortcutInfo | null;
    compactModeToggle: ZenShortcutInfo | null;
  };
  reliability: {
    navigationDefault: "new-tab";
    inPageTargeting: ["vimium-hints", "atspi", "ocr-grid"];
    chromeTargeting: "urlbar-and-zen-shortcuts";
    configurationPolicy: "read-only";
    authStrategy: "reuse-existing-local-profile";
    sessionState: "user-owned-cookies-localStorage-saved-passwords";
    profileConcurrency: "do-not-start-independent-automation-against-same-profile";
  };
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
    device: ZenDeviceInfo;
  };
  firefox: {
    installed: boolean;
    profilesRoot: string;
    profiles: BrowserProfileInfo[];
  };
  runningWindows: WindowInfo[];
}

type IniSection = Record<string, string>;
type PrefMap = Record<string, unknown>;

const KNOWN_EXTENSION_PATTERNS: Record<string, RegExp> = {
  vimium: /(^vimium$|\bvimium\b|d7742d87-e61d-4b78-b8a1-b469842139fa)/i,
  uBlockOrigin: /ublock0@raymondhill\.net|ublock origin/i,
  darkReader: /addon@darkreader\.org|dark reader/i,
  sponsorBlock: /sponsorblocker@ajay\.app|sponsorblock/i,
  unhook: /myallychou@gmail\.com|unhook/i,
  consentOMatic: /gdpr@cavi\.au\.dk|consent-o-matic/i,
  tampermonkey: /firefox@tampermonkey\.net|tampermonkey/i,
  controlPanelForTwitter: /control panel for twitter|5cce4ab5-3d47-41b9-af5e-8203eea05245/i,
  sinkItForReddit: /sink it for reddit|09acf9ff-55d4-4366-a1a9-c9b3c8877c09/i,
};

const ZEN_SHORTCUT_ACTIONS = {
  workspaceForward: "cmd_zenWorkspaceForward",
  workspaceBackward: "cmd_zenWorkspaceBackward",
  pinTabToggle: "cmd_zenTogglePinTab",
  copyUrl: "cmd_zenCopyCurrentURL",
  compactModeToggle: "cmd_toggleCompactModeIgnoreHover",
} as const;

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

function parsePrefs(input: string): PrefMap {
  const prefs: PrefMap = {};
  for (const line of input.split(/\r?\n/)) {
    const match = line.match(/^user_pref\("([^"]+)",\s*(.+)\);$/);
    if (!match) continue;
    try {
      prefs[match[1]] = JSON.parse(match[2]);
    } catch {
      prefs[match[1]] = match[2];
    }
  }
  return prefs;
}

async function readPrefs(path: string): Promise<PrefMap> {
  try {
    return parsePrefs(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

function boolPref(prefs: PrefMap, key: string): boolean | null {
  const value = prefs[key];
  return typeof value === "boolean" ? value : null;
}

function stringPref(prefs: PrefMap, key: string): string | null {
  const value = prefs[key];
  return typeof value === "string" ? value : null;
}

export function parseExtensionsJson(input: string): BrowserExtensionInfo[] {
  const parsed = JSON.parse(input) as { addons?: unknown[] };
  return (parsed.addons ?? [])
    .filter((addon): addon is Record<string, unknown> => Boolean(addon) && typeof addon === "object" && (addon as Record<string, unknown>).type === "extension")
    .map((addon) => {
      const locale = addon.defaultLocale && typeof addon.defaultLocale === "object" ? (addon.defaultLocale as Record<string, unknown>) : {};
      return {
        id: typeof addon.id === "string" ? addon.id : "",
        name: typeof locale.name === "string" ? locale.name : "",
        active: addon.active === true,
        userDisabled: addon.userDisabled === true,
        hidden: addon.hidden === true,
      };
    })
    .filter((extension) => extension.id && extension.name);
}

async function readExtensions(profilePath: string | null): Promise<BrowserExtensionInfo[]> {
  if (!profilePath) return [];
  try {
    return parseExtensionsJson(await readFile(join(profilePath, "extensions.json"), "utf8"));
  } catch {
    return [];
  }
}

export function detectKnownExtensions(extensions: BrowserExtensionInfo[]): Record<string, boolean> {
  const activeVisible = extensions.filter((extension) => extension.active && !extension.hidden);
  return Object.fromEntries(
    Object.entries(KNOWN_EXTENSION_PATTERNS).map(([name, pattern]) => [
      name,
      activeVisible.some((extension) => pattern.test(`${extension.name} ${extension.id}`)),
    ]),
  );
}

export function parseContainersJson(input: string): BrowserContainerInfo[] {
  const parsed = JSON.parse(input) as { identities?: unknown[] };
  return (parsed.identities ?? [])
    .filter((identity): identity is Record<string, unknown> => Boolean(identity) && typeof identity === "object")
    .map((identity) => ({
      name: typeof identity.name === "string" ? identity.name : null,
      userContextId: typeof identity.userContextId === "number" ? identity.userContextId : Number(identity.userContextId),
      public: identity.public === true,
    }))
    .filter((identity) => Number.isFinite(identity.userContextId));
}

async function readContainers(profilePath: string | null): Promise<BrowserContainerInfo[]> {
  if (!profilePath) return [];
  try {
    return parseContainersJson(await readFile(join(profilePath, "containers.json"), "utf8"));
  } catch {
    return [];
  }
}

export function parseZenShortcutsJson(input: string): ZenShortcutInfo[] {
  const parsed = JSON.parse(input) as { shortcuts?: unknown[] };
  return (parsed.shortcuts ?? [])
    .filter((shortcut): shortcut is Record<string, unknown> => Boolean(shortcut) && typeof shortcut === "object")
    .map((shortcut) => {
      const mods = shortcut.modifiers && typeof shortcut.modifiers === "object" ? (shortcut.modifiers as Record<string, unknown>) : {};
      return {
        id: typeof shortcut.id === "string" ? shortcut.id : null,
        action: typeof shortcut.action === "string" ? shortcut.action : null,
        key: typeof shortcut.key === "string" && shortcut.key ? shortcut.key : null,
        keycode: typeof shortcut.keycode === "string" && shortcut.keycode ? shortcut.keycode : null,
        disabled: shortcut.disabled === true,
        modifiers: {
          control: mods.control === true,
          alt: mods.alt === true,
          shift: mods.shift === true,
          meta: mods.meta === true,
          accel: mods.accel === true,
        },
      };
    });
}

async function readZenShortcuts(profilePath: string | null): Promise<ZenShortcutInfo[]> {
  if (!profilePath) return [];
  try {
    return parseZenShortcutsJson(await readFile(join(profilePath, "zen-keyboard-shortcuts.json"), "utf8"));
  } catch {
    return [];
  }
}

function findShortcut(shortcuts: ZenShortcutInfo[], action: string): ZenShortcutInfo | null {
  return shortcuts.find((shortcut) => shortcut.action === action && !shortcut.disabled) ?? null;
}

async function discoverZenDeviceInfo(profiles: BrowserProfileInfo[]): Promise<ZenDeviceInfo> {
  const defaultProfile = profiles.find((profile) => profile.isDefault) ?? profiles[0] ?? null;
  const profilePath = defaultProfile?.path ?? null;
  const [prefs, extensions, containers, shortcuts] = await Promise.all([
    profilePath ? readPrefs(join(profilePath, "prefs.js")) : Promise.resolve({}),
    readExtensions(profilePath),
    readContainers(profilePath),
    readZenShortcuts(profilePath),
  ]);

  return {
    singleProfile: profiles.length === 1,
    defaultProfileName: defaultProfile?.name ?? null,
    defaultProfilePath: profilePath,
    preferences: {
      verticalTabsRightSide: boolPref(prefs, "zen.tabs.vertical.right-side"),
      urlbarBehavior: stringPref(prefs, "zen.urlbar.behavior"),
      workspacesContinueWhereLeftOff: boolPref(prefs, "zen.workspaces.continue-where-left-off"),
      activeWorkspaceId: stringPref(prefs, "zen.workspaces.active"),
      workspaceSyncEnabled: boolPref(prefs, "services.sync.engine.workspaces"),
    },
    containers,
    extensions: extensions.filter((extension) => !extension.hidden),
    knownExtensions: detectKnownExtensions(extensions),
    shortcuts: {
      workspaceForward: findShortcut(shortcuts, ZEN_SHORTCUT_ACTIONS.workspaceForward),
      workspaceBackward: findShortcut(shortcuts, ZEN_SHORTCUT_ACTIONS.workspaceBackward),
      pinTabToggle: findShortcut(shortcuts, ZEN_SHORTCUT_ACTIONS.pinTabToggle),
      copyUrl: findShortcut(shortcuts, ZEN_SHORTCUT_ACTIONS.copyUrl),
      compactModeToggle: findShortcut(shortcuts, ZEN_SHORTCUT_ACTIONS.compactModeToggle),
    },
    reliability: {
      navigationDefault: "new-tab",
      inPageTargeting: ["vimium-hints", "atspi", "ocr-grid"],
      chromeTargeting: "urlbar-and-zen-shortcuts",
      configurationPolicy: "read-only",
      authStrategy: "reuse-existing-local-profile",
      sessionState: "user-owned-cookies-localStorage-saved-passwords",
      profileConcurrency: "do-not-start-independent-automation-against-same-profile",
    },
  };
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
  const zenDevice = await discoverZenDeviceInfo(zenProfiles);

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
      device: zenDevice,
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

export async function requireZenShortcut(action: keyof typeof ZEN_SHORTCUT_ACTIONS): Promise<ZenShortcutInfo> {
  const home = homedir();
  const profiles = await firstProfilesIni([
    join(home, ".var", "app", ZEN_FLATPAK_ID, ".zen", "profiles.ini"),
    join(home, ".var", "app", ZEN_FLATPAK_ID, "config", "zen", "profiles.ini"),
  ]);
  const defaultProfile = profiles.find((profile) => profile.isDefault) ?? profiles[0] ?? null;
  const shortcuts = await readZenShortcuts(defaultProfile?.path ?? null);
  const shortcut = findShortcut(shortcuts, ZEN_SHORTCUT_ACTIONS[action]);
  if (!shortcut) {
    throw new HyprlandError("INPUT_FAILED", `Zen shortcut is not configured: ${action}`);
  }
  return shortcut;
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

export type BrowserReadinessMode = "none" | "title-change" | "title-contains";

export interface BrowserReadinessResult {
  ready: boolean;
  mode: BrowserReadinessMode;
  reason: "no-wait" | "title-changed" | "title-matched" | "timeout";
  attempts: number;
  waitedMs: number;
  titleBefore: string | null;
  titleAfter: string | null;
  window: WindowInfo;
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
