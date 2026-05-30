import { describe, expect, it } from "vitest";
import {
  normalizeKey,
  normalizeModifiers,
  sanitizeTypedText,
  toHyprShortcutKey,
  toHyprShortcutMods,
} from "../src/lib/input.js";

describe("sanitizeTypedText", () => {
  it("returns ordinary text unchanged", () => {
    expect(sanitizeTypedText("hello world")).toBe("hello world");
  });

  it("allows tab and newline (not in the control blocklist)", () => {
    expect(sanitizeTypedText("a\tb\nc")).toBe("a\tb\nc");
  });

  it("rejects empty text", () => {
    expect(() => sanitizeTypedText("")).toThrow("cannot be empty");
  });

  it("rejects overly long text", () => {
    expect(() => sanitizeTypedText("x".repeat(4001))).toThrow("too long");
  });

  it("rejects control characters", () => {
    expect(() => sanitizeTypedText(`bad${String.fromCharCode(0x00)}char`)).toThrow("control characters");
    expect(() => sanitizeTypedText(`bell${String.fromCharCode(0x07)}`)).toThrow("control characters");
    expect(() => sanitizeTypedText(`del${String.fromCharCode(0x7f)}`)).toThrow("control characters");
  });
});

describe("normalizeKey", () => {
  it("normalizes named keys with spacing/case", () => {
    expect(normalizeKey("Page Up")).toBe("page_up");
    expect(normalizeKey("ENTER")).toBe("enter");
  });

  it("accepts single letters and digits", () => {
    expect(normalizeKey("a")).toBe("a");
    expect(normalizeKey("5")).toBe("5");
  });

  it("rejects unsupported keys", () => {
    expect(() => normalizeKey("f13")).toThrow("Unsupported key");
  });
});

describe("normalizeModifiers", () => {
  it("dedupes and lowercases", () => {
    expect(normalizeModifiers(["Ctrl", "ctrl", "SHIFT"])).toEqual(["ctrl", "shift"]);
  });

  it("rejects unsupported modifiers", () => {
    expect(() => normalizeModifiers(["hyper"])).toThrow("Unsupported modifier");
  });
});

describe("hypr shortcut mapping", () => {
  it("maps modifiers to hypr tokens", () => {
    expect(toHyprShortcutMods(["ctrl", "shift"])).toBe("CTRL SHIFT");
  });

  it("maps named and letter keys", () => {
    expect(toHyprShortcutKey("enter")).toBe("RETURN");
    expect(toHyprShortcutKey("page_down")).toBe("PAGEDOWN");
    expect(toHyprShortcutKey("a")).toBe("A");
  });
});
