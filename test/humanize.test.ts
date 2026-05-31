import { describe, expect, it } from "vitest";
import { humanizeAction } from "../src/lib/humanize.js";

describe("humanizeAction", () => {
  it("quotes typed text and truncates long input", () => {
    expect(humanizeAction("type_text", { text: "praxis" })).toBe('Typing "praxis"');
    const long = "x".repeat(60);
    const out = humanizeAction("type_text", { text: long });
    expect(out.startsWith('Typing "')).toBe(true);
    expect(out).toContain("…");
  });

  it("describes text-anchored clicks", () => {
    expect(humanizeAction("click_text", { query: "Submit" })).toBe('Clicking "Submit"');
    expect(humanizeAction("mouse_move_to_text", { text: "OK" })).toBe('Clicking "OK"');
  });

  it("builds key combos", () => {
    expect(humanizeAction("key_press", { modifiers: ["ctrl", "shift"], key: "t" })).toBe("Pressing ctrl+shift+t");
    expect(humanizeAction("key_press", { key: "enter" })).toBe("Pressing enter");
  });

  it("names launches by app", () => {
    expect(humanizeAction("app_launch", { appName: "zen" })).toBe("Launching zen");
    expect(humanizeAction("app_launch_and_wait", { command: "kitty" })).toBe("Launching kitty");
    expect(humanizeAction("browser_open_url", { url: "https://web.whatsapp.com/" })).toBe("Opening web.whatsapp.com in Zen");
  });

  it("uses action_step label when present", () => {
    expect(humanizeAction("action_step", { label: "Open settings" })).toBe("Open settings");
  });

  it("falls back to a title-cased tool name for unmapped tools", () => {
    expect(humanizeAction("some_new_tool", {})).toBe("Some new tool");
  });

  it("handles missing/invalid args gracefully", () => {
    expect(humanizeAction("type_text", undefined)).toBe("Typing");
    expect(humanizeAction("window_focus", null)).toBe("Focusing window");
  });

  it("masks typed text when the call is marked sensitive", () => {
    expect(humanizeAction("type_text", { text: "hunter2", sensitive: true })).toBe("Typing (hidden)");
    expect(humanizeAction("window_focus_and_type", { text: "secret", sensitive: true })).toBe("Typing (hidden)");
  });

  it("masks typed text when global redaction is requested", () => {
    expect(humanizeAction("type_text", { text: "hunter2" }, { redactText: true })).toBe("Typing (hidden)");
    // non-typing tools are unaffected by redaction
    expect(humanizeAction("click_text", { query: "Submit" }, { redactText: true })).toBe('Clicking "Submit"');
  });
});
