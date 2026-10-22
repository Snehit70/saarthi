vi.mock("../src/lib/desktop-environment.js",()=>({desktopEnvironment:async()=>({...process.env})}));
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowInfo } from "../src/lib/types.js";

const mocks = vi.hoisted(() => ({
  focus: vi.fn(),
  assertFocus: vi.fn(),
  shortcut: vi.fn(),
  type: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("../src/lib/hyprland.js", async () => ({
  ...(await vi.importActual("../src/lib/hyprland.js")),
  focusWindow: mocks.focus,
  assertWindowFocus: mocks.assertFocus,
  sendShortcut: mocks.shortcut,
}));
vi.mock("../src/lib/typing.js", async () => ({
  ...(await vi.importActual("../src/lib/typing.js")),
  typeText: mocks.type,
}));
vi.mock("../src/lib/util.js", async () => ({
  ...(await vi.importActual("../src/lib/util.js")),
  commandExists: vi.fn(async () => true),
}));
vi.mock("node:child_process", async () => ({ ...(await vi.importActual("node:child_process")), spawn: mocks.spawn }));

import { BROWSER_IDS, browserForDesktopId, browserForWindow, browserWindows } from "../src/lib/browser-catalog.js";
import {
  focusBrowserWindow,
  openBrowserUrl,
  selectBrowser,
  validateBrowserUrl,
  waitForBrowserReadiness,
  waitForBrowserWindowAfterLaunch,
} from "../src/lib/browser-control.js";

const window = (overrides: Partial<WindowInfo> = {}): WindowInfo => ({
  id: "0x1",
  class: "helium",
  title: "Example Domain",
  workspace: "1",
  monitor: 0,
  floating: false,
  fullscreen: false,
  focused: true,
  mapped: true,
  hidden: false,
  position: { x: 0, y: 0 },
  size: { width: 100, height: 100 },
  ...overrides,
});
const launch = {
  allowedAppAliases: [...BROWSER_IDS],
  deniedExecutables: ["sudo"],
  deniedSubstrings: [";", "&&"],
  maxCommandLength: 240,
  maxLaunchesPerMinute: 30,
  allowCustomCommand: false,
};
const options = () => ({
  browser: "helium" as const,
  url: "https://example.com/",
  mode: "new-tab" as const,
  typeDelayMs: 0,
  timeoutMs: 10,
  pollMs: 1,
  readinessMode: "none" as const,
  readyTimeoutMs: 0,
  readyPollMs: 1,
  listWindows: vi.fn(async () => [window()]),
  launch,
  beforeLaunch: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertFocus.mockResolvedValue(window());
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
});

describe("browser identities and targeting", () => {
  it.each([
    ["zen-alpha", "zen"],
    ["org.mozilla.firefox", "firefox"],
    ["LibreWolf", "librewolf"],
    ["one.ablaze.floorp", "floorp"],
    ["helium", "helium"],
    ["org.chromium.Chromium", "chromium"],
    ["Google-chrome", "chrome"],
    ["Brave-browser", "brave"],
    ["vivaldi-stable", "vivaldi"],
    ["microsoft-edge", "edge"],
  ])("recognizes %s as %s", (identity, expected) =>
    expect(browserForWindow(window({ class: identity }))).toBe(expected),
  );

  it.each(["zen-notes", "chromium-pwa", "chrome-abcd-Default", "code", "electron", "org.gnome.Zenity", "not-helium"])(
    "rejects unrelated class %s even with a browser title",
    (identity) => {
      expect(browserForWindow(window({ class: identity, title: "Google Chrome Zen Firefox" }))).toBeNull();
    },
  );

  it("uses a unique title filter before resolving browser ambiguity", () => {
    const windows = [
      window({ focused: false, title: "Inbox" }),
      window({ id: "0x2", class: "firefox", focused: false, title: "Documentation" }),
    ];
    expect(selectBrowser(windows, "auto", undefined, null, "Documentation")).toBe("firefox");
  });

  it("resolves XDG desktop ids without a Zen fallback", () => {
    expect(browserForDesktopId("net.imput.helium.desktop")).toBe("helium");
    expect(browserForDesktopId("org.mozilla.firefox.desktop")).toBe("firefox");
    expect(browserForDesktopId("unknown.desktop")).toBeNull();
  });

  it("filters hidden windows and selects explicit identity/id before focus", async () => {
    const windows = [
      window(),
      window({ id: "0x2", class: "firefox", focused: false }),
      window({ id: "0x3", hidden: true }),
    ];
    expect(browserWindows(windows).map((w) => w.id)).toEqual(["0x1", "0x2"]);
    expect(selectBrowser(windows)).toBe("helium");
    expect(selectBrowser(windows, "auto", "0x2")).toBe("firefox");
    expect(() => selectBrowser(windows, "helium", "0x2")).toThrow("matching browser");
    expect((await focusBrowserWindow(windows, { browser: "firefox" }, false)).id).toBe("0x2");
  });

  it("fails on ambiguous browser families or windows instead of selecting the first", async () => {
    const windows = [window({ focused: false }), window({ id: "0x2", class: "firefox", focused: false })];
    expect(() => selectBrowser(windows)).toThrow("Multiple browsers");
    await expect(
      focusBrowserWindow([window({ focused: false }), window({ id: "0x2", focused: false })], {}, false),
    ).rejects.toThrow("Multiple browser windows");
  });
});

describe("browser readiness", () => {
  it.each(["New Tab", "New Tab - Google Chrome", "Mozilla Firefox", "New Tab | Helium", "Brave"])(
    "does not treat %s as a loaded page",
    async (title) => {
      const result = await waitForBrowserReadiness({
        windowId: "0x1",
        titleBefore: "Old page",
        mode: "title-change",
        timeoutMs: 0,
        pollMs: 1,
        listWindows: async () => [window({ title })],
      });
      expect(result.ready).toBe(false);
    },
  );

  it("never substitutes an unrelated or cached window after disappearance", async () => {
    await expect(
      waitForBrowserReadiness({
        windowId: "0x1",
        mode: "none",
        timeoutMs: 0,
        pollMs: 1,
        listWindows: async () => [window({ id: "0x2" })],
      }),
    ).rejects.toThrow("disappeared");
    let calls = 0;
    await expect(
      waitForBrowserReadiness({
        windowId: "0x1",
        titleBefore: "Example Domain",
        mode: "title-change",
        timeoutMs: 50,
        pollMs: 1,
        listWindows: async () => (++calls === 1 ? [window()] : []),
      }),
    ).rejects.toThrow("disappeared");
  });

  it("inspects once at a zero timeout and rejects empty title anchors", async () => {
    const listWindows = vi.fn(async () => [window()]);
    const result = await waitForBrowserReadiness({
      windowId: "0x1",
      mode: "title-change",
      titleBefore: "Example Domain",
      timeoutMs: 0,
      pollMs: 5000,
      listWindows,
    });
    expect(result.ready).toBe(false);
    expect(listWindows).toHaveBeenCalledTimes(1);
    await expect(
      waitForBrowserReadiness({
        windowId: "0x1",
        mode: "title-contains",
        titleContains: " ",
        timeoutMs: 0,
        pollMs: 1,
        listWindows,
      }),
    ).rejects.toThrow("requires titleContains");
  });

  it("waits for a new window of the requested browser only", async () => {
    const result = await waitForBrowserWindowAfterLaunch({
      browser: "firefox",
      baselineIds: new Set(["0x1"]),
      preferNewWindow: true,
      timeoutMs: 0,
      pollMs: 1,
      listWindows: async () => [window(), window({ id: "0x2", class: "kitty" })],
    });
    expect(result.window).toBeNull();
  });
});

describe("browser navigation and launch policy", () => {
  it("reuses an existing browser with no launcher or launch-policy charge", async () => {
    const args = options();
    const result = await openBrowserUrl({ ...args, launch: { ...launch, allowedAppAliases: [] } });
    expect(result.effectiveMode).toBe("new-tab");
    expect(mocks.shortcut.mock.calls).toEqual([
      ["CTRL", "T"],
      ["CTRL", "L"],
      ["", "RETURN"],
    ]);
    expect(mocks.type).toHaveBeenCalledWith(args.url, 0);
    expect(args.beforeLaunch).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("rejects Firefox-only about:home for Chromium before any mutation", async () => {
    await expect(openBrowserUrl({ ...options(), url: "about:home" })).rejects.toThrow("Firefox-family");
    expect(mocks.focus).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("stops before typing when focus changes", async () => {
    mocks.assertFocus.mockRejectedValue(new Error("focus drift"));
    await expect(openBrowserUrl(options())).rejects.toThrow("focus drift");
    expect(mocks.type).not.toHaveBeenCalled();
    expect(mocks.shortcut).not.toHaveBeenCalled();
  });

  it.each([{ windowId: "0xdead" }, { titleContains: "missing" }, { mode: "current-tab" as const }])(
    "does not silently launch after an explicit target is missing: %j",
    async (target) => {
      await expect(openBrowserUrl({ ...options(), ...target, listWindows: async () => [] })).rejects.toThrow();
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it("rejects denied aliases, executables, and rate limits before spawning", async () => {
    const args = {
      ...options(),
      browser: "firefox" as const,
      mode: "new-window" as const,
      listWindows: async () => [],
    };
    await expect(openBrowserUrl({ ...args, launch: { ...launch, allowedAppAliases: [] } })).rejects.toThrow("disabled");
    await expect(openBrowserUrl({ ...args, launch: { ...launch, deniedExecutables: ["firefox"] } })).rejects.toThrow(
      "not allowed",
    );
    await expect(
      openBrowserUrl({
        ...args,
        beforeLaunch: () => {
          throw new Error("rate limit");
        },
      }),
    ).rejects.toThrow("rate limit");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("passes URL metacharacters as one spawn argument and charges only real launches", async () => {
    const args = options();
    let calls = 0;
    const url = "https://example.com/?a=1&b=$(ignored)";
    const result = await openBrowserUrl({
      ...args,
      url,
      browser: "firefox",
      mode: "new-window",
      listWindows: async () => (++calls === 1 ? [] : [window({ class: "firefox" })]),
    });
    expect(mocks.spawn).toHaveBeenCalledWith("firefox", ["--new-window", url], expect.objectContaining({ detached: true, stdio: "ignore" }));
    expect(args.beforeLaunch).toHaveBeenCalledTimes(1);
    expect(result.wasNewWindow).toBe(true);
  });

  it("dry-run resolves the plan without launching, input, focus, or rate-limit changes", async () => {
    const args = options();
    const result = await openBrowserUrl({ ...args, dryRun: true, listWindows: async () => [] });
    expect(result.effectiveMode).toBe("new-window-fallback");
    expect(args.beforeLaunch).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.focus).not.toHaveBeenCalled();
    expect(mocks.type).not.toHaveBeenCalled();
  });

  it.each(["https://example.com/\npath", "https://example.com/\tpath", "https://example.com/a b"])(
    "rejects whitespace before URL normalization",
    (url) => expect(() => validateBrowserUrl(url)).toThrow("whitespace"),
  );
});
