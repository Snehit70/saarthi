import { z } from "zod";
import { audit } from "../lib/audit.js";
import { focusWindow, getWindowOrThrow, HyprlandError, sendShortcut } from "../lib/hyprland.js";
import type { WindowId } from "../lib/types.js";
import { sleep } from "../lib/util.js";
import {
  normalizeKey,
  normalizeModifiers,
  sanitizeTypedText,
  toHyprShortcutKey,
  toHyprShortcutMods,
} from "../lib/input.js";
import { server } from "../registry.js";
import { dryRun } from "../runtime.js";

import { typeText, typingTimeout } from "../lib/typing.js";
import { assertWindowFocus } from "../lib/hyprland.js";

server.registerTool(
  "type_text",
  {
    title: "Type Text",
    description: "Type text into the currently focused input field.",
    inputSchema: {
      text: z.string().min(1).max(4000),
      windowId: z
        .string()
        .regex(/^0x[0-9a-fA-F]+$/)
        .optional()
        .describe("Reject input if this window is no longer focused."),
      delayMs: z.number().int().min(0).max(1000).default(0),
      sensitive: z
        .boolean()
        .default(false)
        .describe("Mask the typed text in the status overlay/feed (e.g. passwords)."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ text, delayMs, windowId }) => {
    const safeText = sanitizeTypedText(text);
    await audit("type_text", { textLength: safeText.length, delayMs, windowId }, dryRun);

    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN type_text length=${safeText.length} delayMs=${delayMs}` }],
        structuredContent: { typed: false, dryRun: true, textLength: safeText.length, delayMs },
      };
    }

    if (windowId) await assertWindowFocus(windowId as WindowId);
    await typeText(safeText, delayMs);

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
      sensitive: z
        .boolean()
        .default(false)
        .describe("Mask the typed text in the status overlay/feed (e.g. passwords)."),
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
    typingTimeout(safeText, delayMs);
    await getWindowOrThrow(windowId as WindowId);
    await audit("window_focus_and_type", { windowId, textLength: safeText.length, focusSettleMs, delayMs }, dryRun);

    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN focus_and_type window=${windowId} textLength=${safeText.length}` }],
        structuredContent: { typed: false, dryRun: true, windowId, textLength: safeText.length },
      };
    }

    await focusWindow(windowId as WindowId);
    if (focusSettleMs > 0) await sleep(focusSettleMs);
    await assertWindowFocus(windowId as WindowId);
    await typeText(safeText, delayMs);

    return {
      content: [
        { type: "text", text: JSON.stringify({ typed: true, windowId, textLength: safeText.length }, null, 2) },
      ],
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
      windowId: z
        .string()
        .regex(/^0x[0-9a-fA-F]+$/)
        .optional()
        .describe("Reject each keypress if this window is no longer focused."),
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
  async ({ key, modifiers, repeat, delayMs, windowId }) => {
    const safeKey = normalizeKey(key);
    const safeMods = normalizeModifiers(modifiers);
    await audit("key_press", { key: safeKey, modifiers: safeMods, repeat, delayMs, windowId }, dryRun);
    if (dryRun) {
      return {
        content: [
          { type: "text", text: `DRY_RUN key_press key=${safeKey} modifiers=${safeMods.join("+")} repeat=${repeat}` },
        ],
        structuredContent: { dryRun: true, key: safeKey, modifiers: safeMods, repeat, delayMs },
      };
    }
    const shortcutMods = toHyprShortcutMods(safeMods);
    const shortcutKey = toHyprShortcutKey(safeKey);
    for (let i = 0; i < repeat; i += 1) {
      if (windowId) await assertWindowFocus(windowId as WindowId);
      await sendShortcut(shortcutMods, shortcutKey);
      if (i < repeat - 1 && delayMs > 0) await sleep(delayMs);
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ sent: true, key: safeKey, modifiers: safeMods, repeat, delayMs }, null, 2),
        },
      ],
      structuredContent: { sent: true, key: safeKey, modifiers: safeMods, repeat, delayMs },
    };
  },
);
