import { HyprlandError } from "./hyprland.js";

export function sanitizeTypedText(input: string): string {
  if (input.length === 0) {
    throw new HyprlandError("INPUT_FAILED", "Typed text cannot be empty");
  }
  if (input.length > 4000) {
    throw new HyprlandError("INPUT_FAILED", "Typed text is too long");
  }
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    const isControl =
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f;
    if (isControl) {
      throw new HyprlandError("INPUT_FAILED", "Typed text contains unsupported control characters");
    }
  }
  return input;
}

export const ALLOWED_KEYS = [
  "enter",
  "tab",
  "escape",
  "backspace",
  "delete",
  "left",
  "right",
  "up",
  "down",
  "home",
  "end",
  "page_up",
  "page_down",
  "f5",
] as const;

export const ALLOWED_MODIFIERS = ["ctrl", "alt", "shift", "super"] as const;

export type AllowedKey = (typeof ALLOWED_KEYS)[number];
export type AllowedModifier = (typeof ALLOWED_MODIFIERS)[number];

export function normalizeKey(key: string): AllowedKey {
  const normalized = key.trim().toLowerCase().replace(/\s+/g, "_");
  if ((ALLOWED_KEYS as readonly string[]).includes(normalized)) {
    return normalized as AllowedKey;
  }
  if (/^[a-z0-9]$/.test(normalized)) {
    return normalized as AllowedKey;
  }
  throw new HyprlandError("INPUT_FAILED", `Unsupported key: ${key}`);
}

export function normalizeModifiers(modifiers: string[]): AllowedModifier[] {
  const out: AllowedModifier[] = [];
  for (const mod of modifiers) {
    const normalized = mod.trim().toLowerCase();
    if (!(ALLOWED_MODIFIERS as readonly string[]).includes(normalized)) {
      throw new HyprlandError("INPUT_FAILED", `Unsupported modifier: ${mod}`);
    }
    if (!out.includes(normalized as AllowedModifier)) out.push(normalized as AllowedModifier);
  }
  return out;
}

export function toHyprShortcutMods(mods: AllowedModifier[]): string {
  const map: Record<AllowedModifier, string> = { ctrl: "CTRL", alt: "ALT", shift: "SHIFT", super: "SUPER" };
  return mods.map((m) => map[m]).join(" ");
}

export function toHyprShortcutKey(key: AllowedKey): string {
  const map: Record<AllowedKey, string> = {
    enter: "RETURN",
    tab: "TAB",
    escape: "ESCAPE",
    backspace: "BACKSPACE",
    delete: "DELETE",
    left: "LEFT",
    right: "RIGHT",
    up: "UP",
    down: "DOWN",
    home: "HOME",
    end: "END",
    page_up: "PAGEUP",
    page_down: "PAGEDOWN",
    f5: "F5",
  };
  if (map[key]) return map[key];
  // Letter/digit keys for extension-driven keyboard navigation (for example Vimium hints).
  if (/^[a-z0-9]$/.test(key)) return key.toUpperCase();
  throw new HyprlandError("INPUT_FAILED", `Unsupported shortcut key: ${key}`);
}
