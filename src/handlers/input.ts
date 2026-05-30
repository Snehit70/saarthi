import { z } from "zod";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { audit } from "../lib/audit.js";
import { getWindowOrThrow, hyprctlDispatch, HyprlandError } from "../lib/hyprland.js";
import type { WindowId } from "../lib/types.js";
import { commandExists, sleep } from "../lib/util.js";
import {
  normalizeKey,
  normalizeModifiers,
  sanitizeTypedText,
  toHyprShortcutKey,
  toHyprShortcutMods,
} from "../lib/input.js";
import { server } from "../server.js";
import { dryRun } from "../runtime.js";

const execFileAsync = promisify(execFile);

server.registerTool(
  "type_text",
  {
    title: "Type Text",
    description: "Type text into the currently focused input field.",
    inputSchema: {
      text: z.string().min(1).max(4000),
      delayMs: z.number().int().min(0).max(1000).default(0),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ text, delayMs }) => {
    const safeText = sanitizeTypedText(text);
    await audit("type_text", { textLength: safeText.length, delayMs }, dryRun);

    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN type_text length=${safeText.length} delayMs=${delayMs}` }],
        structuredContent: { typed: false, dryRun: true, textLength: safeText.length, delayMs },
      };
    }

    if (!(await commandExists("wtype"))) {
      throw new HyprlandError("INPUT_FAILED", "wtype is not installed");
    }

    if (delayMs > 0) {
      await execFileAsync("wtype", ["-d", String(delayMs), safeText]);
    } else {
      await execFileAsync("wtype", [safeText]);
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ typed: true, textLength: safeText.length, delayMs }, null, 2) }],
      structuredContent: { typed: true, textLength: safeText.length, delayMs },
    };
  },
);

server.registerTool(
  "window_focus_and_type",
  {
    title: "Window Focus And Type",
    description: "Focus a window, wait briefly, then type text into its focused input.",
    inputSchema: {
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/),
      text: z.string().min(1).max(4000),
      focusSettleMs: z.number().int().min(0).max(3000).default(120),
      delayMs: z.number().int().min(0).max(1000).default(0),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ windowId, text, focusSettleMs, delayMs }) => {
    const safeText = sanitizeTypedText(text);
    await getWindowOrThrow(windowId as WindowId);
    await audit("window_focus_and_type", { windowId, textLength: safeText.length, focusSettleMs, delayMs }, dryRun);

    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN focus_and_type window=${windowId} textLength=${safeText.length}` }],
        structuredContent: { typed: false, dryRun: true, windowId, textLength: safeText.length },
      };
    }

    if (!(await commandExists("wtype"))) {
      throw new HyprlandError("INPUT_FAILED", "wtype is not installed");
    }

    await hyprctlDispatch("focuswindow", `address:${windowId}`);
    if (focusSettleMs > 0) await sleep(focusSettleMs);

    if (delayMs > 0) {
      await execFileAsync("wtype", ["-d", String(delayMs), safeText]);
    } else {
      await execFileAsync("wtype", [safeText]);
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ typed: true, windowId, textLength: safeText.length }, null, 2) }],
      structuredContent: { typed: true, windowId, textLength: safeText.length },
    };
  },
);

server.registerTool(
  "key_press",
  {
    title: "Key Press",
    description: "Send a single keyboard key with optional modifiers to the focused window.",
    inputSchema: {
      key: z.string().min(1).max(32),
      modifiers: z.array(z.string().min(1).max(16)).max(4).default([]),
      repeat: z.number().int().min(1).max(20).default(1),
      delayMs: z.number().int().min(0).max(2000).default(80),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ key, modifiers, repeat, delayMs }) => {
    const safeKey = normalizeKey(key);
    const safeMods = normalizeModifiers(modifiers);
    await audit("key_press", { key: safeKey, modifiers: safeMods, repeat, delayMs }, dryRun);
    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN key_press key=${safeKey} modifiers=${safeMods.join("+")} repeat=${repeat}` }],
        structuredContent: { dryRun: true, key: safeKey, modifiers: safeMods, repeat, delayMs },
      };
    }
    const shortcutMods = toHyprShortcutMods(safeMods);
    const shortcutKey = toHyprShortcutKey(safeKey);
    for (let i = 0; i < repeat; i += 1) {
      await hyprctlDispatch("sendshortcut", `${shortcutMods},${shortcutKey}`);
      if (i < repeat - 1 && delayMs > 0) await sleep(delayMs);
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ sent: true, key: safeKey, modifiers: safeMods, repeat, delayMs }, null, 2) }],
      structuredContent: { sent: true, key: safeKey, modifiers: safeMods, repeat, delayMs },
    };
  },
);
