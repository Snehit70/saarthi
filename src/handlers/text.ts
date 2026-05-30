import { z } from "zod";
import { audit } from "../lib/audit.js";
import type { WindowId } from "../lib/types.js";
import { sleep } from "../lib/util.js";
import { performMouseClick, performMouseMove } from "../lib/mouse.js";
import { performFindTextOnScreen, resolveTextClickPoint } from "../lib/text-locate.js";
import { server } from "../server.js";
import { dryRun } from "../runtime.js";

server.registerTool(
  "resolve_text_point",
  {
    title: "Resolve Text Point",
    description: "Find text on screen and return relative/absolute center point for mouse targeting.",
    inputSchema: {
      query: z.string().min(1).max(120),
      target: z.enum(["full", "monitor", "active_window", "window"]).default("active_window"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      confidenceMin: z.number().min(0).max(100).default(35),
      matchIndex: z.number().int().min(0).max(20).default(0),
      offsetX: z.number().int().min(-500).max(500).default(0),
      offsetY: z.number().int().min(-500).max(500).default(0),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ query, target, monitorName, windowId, confidenceMin, matchIndex, offsetX, offsetY }) => {
    const point = await resolveTextClickPoint({
      query,
      target,
      monitorName,
      windowId: windowId as WindowId | undefined,
      confidenceMin,
      matchIndex,
      offsetX,
      offsetY,
    });
    const payload = {
      query,
      target,
      matchIndex,
      confidenceMin,
      point: {
        absoluteX: point.absoluteX,
        absoluteY: point.absoluteY,
        relativeX: point.relativeX,
        relativeY: point.relativeY,
      },
      match: point.match,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  },
);

server.registerTool(
  "mouse_move_to_text",
  {
    title: "Mouse Move To Text",
    description: "Find text and move cursor to its resolved point.",
    inputSchema: {
      query: z.string().min(1).max(120),
      target: z.enum(["full", "monitor", "active_window", "window"]).default("active_window"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      confidenceMin: z.number().min(0).max(100).default(35),
      matchIndex: z.number().int().min(0).max(20).default(0),
      offsetX: z.number().int().min(-500).max(500).default(0),
      offsetY: z.number().int().min(-500).max(500).default(0),
      settleMs: z.number().int().min(0).max(3000).default(60),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ query, target, monitorName, windowId, confidenceMin, matchIndex, offsetX, offsetY, settleMs }) => {
    const point = await resolveTextClickPoint({
      query,
      target,
      monitorName,
      windowId: windowId as WindowId | undefined,
      confidenceMin,
      matchIndex,
      offsetX,
      offsetY,
    });
    await audit("mouse_move_to_text", { query, target, matchIndex, confidenceMin, offsetX, offsetY, x: point.absoluteX, y: point.absoluteY }, dryRun);
    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN mouse_move_to_text query='${query}' x=${point.absoluteX} y=${point.absoluteY}` }],
        structuredContent: { dryRun: true, moved: false },
      };
    }
    await performMouseMove(point.absoluteX, point.absoluteY);
    if (settleMs > 0) await sleep(settleMs);
    const payload = { moved: true, query, target, absoluteX: point.absoluteX, absoluteY: point.absoluteY, relativeX: point.relativeX, relativeY: point.relativeY };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  },
);

server.registerTool(
  "click_text",
  {
    title: "Click Text",
    description: "Find text on screen and click its resolved point.",
    inputSchema: {
      query: z.string().min(1).max(120),
      target: z.enum(["full", "monitor", "active_window", "window"]).default("active_window"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      confidenceMin: z.number().min(0).max(100).default(35),
      matchIndex: z.number().int().min(0).max(20).default(0),
      offsetX: z.number().int().min(-500).max(500).default(0),
      offsetY: z.number().int().min(-500).max(500).default(0),
      button: z.enum(["left", "middle", "right"]).default("left"),
      settleMs: z.number().int().min(0).max(3000).default(120),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ query, target, monitorName, windowId, confidenceMin, matchIndex, offsetX, offsetY, button, settleMs }) => {
    const point = await resolveTextClickPoint({
      query,
      target,
      monitorName,
      windowId: windowId as WindowId | undefined,
      confidenceMin,
      matchIndex,
      offsetX,
      offsetY,
    });
    await audit("click_text", { query, target, matchIndex, confidenceMin, offsetX, offsetY, button, x: point.absoluteX, y: point.absoluteY }, dryRun);
    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN click_text query='${query}' x=${point.absoluteX} y=${point.absoluteY} button=${button}` }],
        structuredContent: { dryRun: true, clicked: false },
      };
    }
    await performMouseClick(point.absoluteX, point.absoluteY, button, settleMs);
    const payload = {
      clicked: true,
      query,
      target,
      button,
      absoluteX: point.absoluteX,
      absoluteY: point.absoluteY,
      relativeX: point.relativeX,
      relativeY: point.relativeY,
      match: point.match,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  },
);

server.registerTool(
  "find_text_on_screen",
  {
    title: "Find Text On Screen",
    description: "Run OCR on a screenshot and return best matching text boxes.",
    inputSchema: {
      query: z.string().min(1).max(120),
      target: z.enum(["full", "monitor", "active_window", "window"]).default("active_window"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      confidenceMin: z.number().min(0).max(100).default(35),
      limit: z.number().int().min(1).max(20).default(5),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ query, target, monitorName, windowId, confidenceMin, limit }) => {
    const found = await performFindTextOnScreen({
      query,
      target,
      monitorName,
      windowId: windowId as WindowId | undefined,
      confidenceMin,
      limit,
    });
    return {
      content: [{ type: "text", text: JSON.stringify({ query, matches: found.matches, width: found.width, height: found.height }, null, 2) }],
      structuredContent: { query, matches: found.matches, width: found.width, height: found.height, target: found.target },
    };
  },
);
