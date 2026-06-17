import { describe, expect, it } from "vitest";
import {
  detectKnownExtensions,
  parseContainersJson,
  parseExtensionsJson,
  parseZenShortcutsJson,
  shortcutToHypr,
  validateBrowserUrl,
  waitForZenReadiness,
  zenWindows,
} from "../src/lib/browser.js";
import type { WindowInfo } from "../src/lib/types.js";

function windowInfo(overrides: Partial<WindowInfo>): WindowInfo {
  return {
    id: "0x1",
    class: "zen",
    title: "Zen Browser",
    workspace: "1",
    monitor: 0,
    floating: false,
    fullscreen: false,
    focused: false,
    mapped: true,
    hidden: false,
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    ...overrides,
  };
}

describe("browser URL policy", () => {
  it("allows http, https, about:home, and about:blank", () => {
    expect(validateBrowserUrl("https://web.whatsapp.com/")).toBe("https://web.whatsapp.com/");
    expect(validateBrowserUrl("http://localhost:3000/path?q=1#top")).toBe("http://localhost:3000/path?q=1#top");
    expect(validateBrowserUrl("about:home")).toBe("about:home");
    expect(validateBrowserUrl("about:blank")).toBe("about:blank");
  });

  it("rejects local files, mail handlers, custom schemes, relative URLs, and credentials", () => {
    expect(() => validateBrowserUrl("file:///home/snehit/secrets.txt")).toThrow("scheme is not allowed");
    expect(() => validateBrowserUrl("mailto:a@example.com")).toThrow("scheme is not allowed");
    expect(() => validateBrowserUrl("slack://open")).toThrow("scheme is not allowed");
    expect(() => validateBrowserUrl("/relative")).toThrow("absolute");
    expect(() => validateBrowserUrl("https://user:pass@example.com/")).toThrow("credentials");
  });
});

describe("Zen window matching", () => {
  it("matches local Zen class variants and ranks the focused window first", () => {
    const matches = zenWindows([
      windowInfo({ id: "0x1", class: "kitty", title: "zen note", focused: true }),
      windowInfo({ id: "0x2", class: "app.zen_browser.zen", title: "WhatsApp", focused: false }),
      windowInfo({ id: "0x3", class: "zen", title: "Zen Browser", focused: true }),
      windowInfo({ id: "0x4", class: "org.gnome.Zenity", title: "Zenity", focused: false }),
    ]);
    expect(matches.map((window) => window.id)).toEqual(["0x3", "0x2"]);
  });

  it("can filter Zen windows by title", () => {
    const matches = zenWindows([
      windowInfo({ id: "0x2", class: "app.zen_browser.zen", title: "WhatsApp" }),
      windowInfo({ id: "0x3", class: "zen", title: "Zen Browser" }),
    ], "whatsapp");
    expect(matches.map((window) => window.id)).toEqual(["0x2"]);
  });
});

describe("Zen device discovery parsing", () => {
  it("extracts visible extensions and known active extensions", () => {
    const extensions = parseExtensionsJson(JSON.stringify({
      addons: [
        { id: "{d7742d87-e61d-4b78-b8a1-b469842139fa}", type: "extension", defaultLocale: { name: "Vimium" }, active: true, userDisabled: false, hidden: false },
        { id: "uBlock0@raymondhill.net", type: "extension", defaultLocale: { name: "uBlock Origin" }, active: true, userDisabled: false, hidden: false },
        { id: "addon@darkreader.org", type: "extension", defaultLocale: { name: "Dark Reader" }, active: false, userDisabled: true, hidden: false },
        { id: "system@mozilla", type: "extension", defaultLocale: { name: "Hidden System" }, active: true, userDisabled: false, hidden: true },
      ],
    }));
    expect(extensions).toHaveLength(4);
    expect(detectKnownExtensions(extensions)).toMatchObject({
      vimium: true,
      uBlockOrigin: true,
      darkReader: false,
    });
  });

  it("parses public Firefox containers", () => {
    const containers = parseContainersJson(JSON.stringify({
      identities: [
        { name: null, userContextId: 1, public: true },
        { name: "College", userContextId: 2, public: true },
        { name: "internal", userContextId: 5, public: false },
      ],
    }));
    expect(containers).toEqual([
      { name: null, userContextId: 1, public: true },
      { name: "College", userContextId: 2, public: true },
      { name: "internal", userContextId: 5, public: false },
    ]);
  });

  it("parses Zen shortcuts and converts accel/alt keycodes for Hyprland", () => {
    const shortcuts = parseZenShortcutsJson(JSON.stringify({
      shortcuts: [
        {
          id: "zen-workspace-forward",
          action: "cmd_zenWorkspaceForward",
          key: "",
          keycode: "VK_RIGHT",
          disabled: false,
          modifiers: { control: false, alt: true, shift: false, meta: false, accel: true },
        },
      ],
    }));
    expect(shortcuts[0]).toMatchObject({ action: "cmd_zenWorkspaceForward", keycode: "VK_RIGHT" });
    expect(shortcutToHypr(shortcuts[0])).toEqual({ mods: "CTRL ALT", key: "RIGHT", label: "CTRL+ALT+RIGHT" });
  });
});

describe("Zen navigation readiness", () => {
  it("returns ready when a page title changes away from a blank Zen title", async () => {
    let calls = 0;
    const ready = await waitForZenReadiness({
      windowId: "0x1",
      titleBefore: "Zen Browser",
      mode: "title-change",
      timeoutMs: 500,
      pollMs: 1,
      listWindows: async () => {
        calls += 1;
        return [windowInfo({ id: "0x1", title: calls < 2 ? "Zen Browser" : "Example Domain — Zen Browser" })];
      },
    });
    expect(ready).toMatchObject({
      ready: true,
      reason: "title-changed",
      titleBefore: "Zen Browser",
      titleAfter: "Example Domain — Zen Browser",
    });
  });

  it("returns ready when title-contains matches", async () => {
    const ready = await waitForZenReadiness({
      windowId: "0x1",
      mode: "title-contains",
      titleContains: "Inbox",
      timeoutMs: 100,
      pollMs: 1,
      listWindows: async () => [windowInfo({ id: "0x1", title: "Inbox (4) — Zen Browser" })],
    });
    expect(ready).toMatchObject({ ready: true, reason: "title-matched" });
  });

  it("returns ready false instead of throwing when the title never settles", async () => {
    const ready = await waitForZenReadiness({
      windowId: "0x1",
      titleBefore: "Zen Browser",
      mode: "title-change",
      timeoutMs: 5,
      pollMs: 1,
      listWindows: async () => [windowInfo({ id: "0x1", title: "Zen Browser" })],
    });
    expect(ready.ready).toBe(false);
    expect(ready.reason).toBe("timeout");
    expect(ready.titleAfter).toBe("Zen Browser");
  });
});
