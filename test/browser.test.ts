import { describe, expect, it } from "vitest";
import { validateBrowserUrl, zenWindows } from "../src/lib/browser.js";
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
