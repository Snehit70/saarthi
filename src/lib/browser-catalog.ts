import { homedir } from "node:os";
import { join } from "node:path";
import type { WindowInfo } from "./types.js";

export const BROWSER_IDS = [
  "zen",
  "firefox",
  "librewolf",
  "floorp",
  "helium",
  "chromium",
  "chrome",
  "brave",
  "vivaldi",
  "edge",
] as const;
export type BrowserId = (typeof BROWSER_IDS)[number];
export type BrowserSelector = BrowserId | "auto";

export interface BrowserDefinition {
  id: BrowserId;
  family: "firefox" | "chromium";
  classes: readonly string[];
  desktopIds: readonly string[];
  commands: string[];
}

// Match browser identities, never titles or broad substrings such as "chrome".
// Electron applications and Chromium PWAs must not become navigation targets.
export const BROWSERS: readonly BrowserDefinition[] = [
  {
    id: "zen",
    family: "firefox",
    classes: ["zen", "zen-alpha", "zen-beta", "zen-browser", "app.zen_browser.zen"],
    desktopIds: ["zen", "zen-browser", "app.zen_browser.zen"],
    commands: ["zen-browser", "flatpak run app.zen_browser.zen", "zen"],
  },
  {
    id: "firefox",
    family: "firefox",
    classes: ["firefox", "firefox-esr", "org.mozilla.firefox"],
    desktopIds: ["firefox", "firefox-esr", "org.mozilla.firefox"],
    commands: ["firefox", "firefox-esr", "flatpak run org.mozilla.firefox"],
  },
  {
    id: "librewolf",
    family: "firefox",
    classes: ["librewolf", "io.gitlab.librewolf-community"],
    desktopIds: ["librewolf", "io.gitlab.librewolf-community"],
    commands: ["librewolf", "flatpak run io.gitlab.librewolf-community"],
  },
  {
    id: "floorp",
    family: "firefox",
    classes: ["floorp", "one.ablaze.floorp"],
    desktopIds: ["floorp", "one.ablaze.floorp"],
    commands: ["floorp", "flatpak run one.ablaze.floorp"],
  },
  {
    id: "helium",
    family: "chromium",
    classes: ["helium", "net.imput.helium"],
    desktopIds: ["helium", "net.imput.helium", "helium-browser"],
    commands: ["helium", "helium-browser", join(homedir(), "AppImages", "helium.appimage")],
  },
  {
    id: "chromium",
    family: "chromium",
    classes: ["chromium", "chromium-browser", "org.chromium.chromium"],
    desktopIds: ["chromium", "chromium-browser", "org.chromium.chromium"],
    commands: ["chromium", "chromium-browser", "flatpak run org.chromium.Chromium"],
  },
  {
    id: "chrome",
    family: "chromium",
    classes: [
      "google-chrome",
      "google-chrome-stable",
      "google-chrome-beta",
      "google-chrome-unstable",
      "com.google.chrome",
    ],
    desktopIds: [
      "google-chrome",
      "google-chrome-stable",
      "google-chrome-beta",
      "google-chrome-unstable",
      "com.google.chrome",
    ],
    commands: ["google-chrome-stable", "google-chrome", "flatpak run com.google.Chrome"],
  },
  {
    id: "brave",
    family: "chromium",
    classes: ["brave-browser", "brave-browser-beta", "brave-browser-nightly", "brave", "com.brave.browser"],
    desktopIds: ["brave-browser", "brave", "com.brave.browser"],
    commands: ["brave-browser", "brave", "flatpak run com.brave.Browser"],
  },
  {
    id: "vivaldi",
    family: "chromium",
    classes: ["vivaldi-stable", "vivaldi-snapshot", "vivaldi", "com.vivaldi.vivaldi"],
    desktopIds: ["vivaldi-stable", "vivaldi", "com.vivaldi.vivaldi"],
    commands: ["vivaldi-stable", "vivaldi", "flatpak run com.vivaldi.Vivaldi"],
  },
  {
    id: "edge",
    family: "chromium",
    classes: ["microsoft-edge", "microsoft-edge-dev", "microsoft-edge-beta", "com.microsoft.edge"],
    desktopIds: ["microsoft-edge", "microsoft-edge-dev", "com.microsoft.edge"],
    commands: ["microsoft-edge", "microsoft-edge-stable", "flatpak run com.microsoft.Edge"],
  },
];

export function browserDefinition(id: BrowserId): BrowserDefinition {
  return BROWSERS.find((browser) => browser.id === id)!;
}

export function browserForWindow(window: WindowInfo): BrowserId | null {
  const identity = window.class.toLowerCase();
  return BROWSERS.find((browser) => browser.classes.includes(identity))?.id ?? null;
}

export function browserForDesktopId(desktopId: string | null): BrowserId | null {
  const identity = desktopId?.toLowerCase().replace(/\.desktop$/, "");
  return BROWSERS.find((browser) => browser.desktopIds.includes(identity ?? ""))?.id ?? null;
}

export function browserWindows(
  windows: WindowInfo[],
  browser?: BrowserId,
  titleContains?: string,
  includeHidden = false,
): WindowInfo[] {
  const needle = titleContains?.toLowerCase();
  return windows
    .filter((window) => {
      const identity = browserForWindow(window);
      return (
        identity &&
        (!browser || identity === browser) &&
        (includeHidden || (window.mapped && !window.hidden)) &&
        (!needle || window.title.toLowerCase().includes(needle))
      );
    })
    .sort((a, b) => Number(b.focused) - Number(a.focused) || a.id.localeCompare(b.id));
}
