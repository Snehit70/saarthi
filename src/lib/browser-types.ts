import type { WindowInfo } from "./types.js";

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

export type BrowserOpenMode = "new-tab" | "new-window" | "current-tab";

export interface BrowserOpenUrlResult {
  effectiveMode: BrowserOpenMode | "new-window-fallback";
  reusableWindow: WindowInfo | null;
  targetWindow: WindowInfo;
  attempts: number;
  wasNewWindow: boolean;
  titleBefore: string | null;
  readiness: BrowserReadinessResult;
}
