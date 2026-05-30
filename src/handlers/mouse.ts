import { z } from "zod";
import { audit } from "../lib/audit.js";
import { logRunEvent } from "../lib/runlog.js";
import { cursorPosition } from "../lib/hyprland.js";
import type { WindowId } from "../lib/types.js";
import { sleep } from "../lib/util.js";
import { resolvePointerCoordinates, resolveTargetBounds } from "../lib/pointer.js";
import { performMouseClick, performMouseMove, performMouseScroll } from "../lib/mouse.js";
import { server } from "../server.js";
import { dryRun } from "../runtime.js";

server.registerTool(
  "mouse_get_position",
  {
    title: "Mouse Get Position",
    description: "Get current mouse cursor position and optional deltas to a point.",
    inputSchema: {
      target: z.enum(["full", "monitor", "active_window", "window"]).default("full"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      relativeToX: z.number().int().min(0).optional(),
      relativeToY: z.number().int().min(0).optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ target, monitorName, windowId, relativeToX, relativeToY }) => {
    const pos = await cursorPosition();
    const bounds = await resolveTargetBounds(target, monitorName, windowId as WindowId | undefined);

    const relative = { x: pos.x - bounds.originX, y: pos.y - bounds.originY };
    const inView = relative.x >= 0 && relative.y >= 0 && relative.x < bounds.width && relative.y < bounds.height;
    const payload: Record<string, unknown> = {
      absolute: pos,
      relative,
      inView,
      bounds: { originX: bounds.originX, originY: bounds.originY, width: bounds.width, height: bounds.height },
      target,
      resolvedTarget: bounds.resolvedTarget,
    };
    if (typeof relativeToX === "number" && typeof relativeToY === "number") {
      payload.deltaToPoint = { dx: relativeToX - relative.x, dy: relativeToY - relative.y };
      payload.distanceToPoint = Math.hypot(relativeToX - relative.x, relativeToY - relative.y);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  },
);

server.registerTool(
  "mouse_verify_in_view",
  {
    title: "Mouse Verify In View",
    description: "Check whether cursor is currently visible inside target bounds.",
    inputSchema: {
      target: z.enum(["full", "monitor", "active_window", "window"]).default("active_window"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ target, monitorName, windowId }) => {
    const pos = await cursorPosition();
    const bounds = await resolveTargetBounds(target, monitorName, windowId as WindowId | undefined);
    const relative = { x: pos.x - bounds.originX, y: pos.y - bounds.originY };
    const inView = relative.x >= 0 && relative.y >= 0 && relative.x < bounds.width && relative.y < bounds.height;
    const payload = {
      inView,
      absolute: pos,
      relative,
      bounds: { originX: bounds.originX, originY: bounds.originY, width: bounds.width, height: bounds.height },
      target,
      resolvedTarget: bounds.resolvedTarget,
    };
    await logRunEvent({ action: "mouse_verify_in_view", ...payload });
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  },
);

server.registerTool(
  "mouse_move",
  {
    title: "Mouse Move",
    description: "Move cursor to coordinates relative to full screen, monitor, active window, or specific window.",
    inputSchema: {
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      target: z.enum(["full", "monitor", "active_window", "window"]).default("full"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      settleMs: z.number().int().min(0).max(3000).default(40),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ x, y, target, monitorName, windowId, settleMs }) => {
    await audit("mouse_move", { x, y, target, monitorName, windowId, settleMs }, dryRun);
    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN mouse_move x=${x} y=${y} target=${target}` }],
        structuredContent: { dryRun: true, moved: false, x, y, target },
      };
    }
    const resolved = await resolvePointerCoordinates(x, y, target, monitorName, windowId as WindowId | undefined);
    await performMouseMove(resolved.x, resolved.y);
    if (settleMs > 0) await sleep(settleMs);
    return {
      content: [{ type: "text", text: JSON.stringify({ moved: true, x, y, target, absoluteX: resolved.x, absoluteY: resolved.y }, null, 2) }],
      structuredContent: { moved: true, x, y, target, absoluteX: resolved.x, absoluteY: resolved.y },
    };
  },
);

server.registerTool(
  "mouse_click",
  {
    title: "Mouse Click",
    description: "Click at coordinates relative to full screen, monitor, active window, or specific window.",
    inputSchema: {
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      target: z.enum(["full", "monitor", "active_window", "window"]).default("full"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      button: z.enum(["left", "middle", "right"]).default("left"),
      settleMs: z.number().int().min(0).max(3000).default(80),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ x, y, target, monitorName, windowId, button, settleMs }) => {
    await audit("mouse_click", { x, y, target, monitorName, windowId, button, settleMs }, dryRun);
    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN mouse_click x=${x} y=${y} target=${target} button=${button}` }],
        structuredContent: { dryRun: true, clicked: false, x, y, target, button },
      };
    }
    const resolved = await resolvePointerCoordinates(x, y, target, monitorName, windowId as WindowId | undefined);
    await performMouseClick(resolved.x, resolved.y, button, settleMs);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ clicked: true, x, y, target, button, absoluteX: resolved.x, absoluteY: resolved.y }, null, 2),
        },
      ],
      structuredContent: { clicked: true, x, y, target, button, absoluteX: resolved.x, absoluteY: resolved.y },
    };
  },
);

server.registerTool(
  "mouse_scroll",
  {
    title: "Mouse Scroll",
    description: "Scroll vertically or horizontally using wheel events.",
    inputSchema: {
      axis: z.enum(["vertical", "horizontal"]).default("vertical"),
      amount: z.number().int().min(-50).max(50),
      settleMs: z.number().int().min(0).max(3000).default(60),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ axis, amount, settleMs }) => {
    if (amount === 0) {
      return {
        content: [{ type: "text", text: JSON.stringify({ scrolled: false, axis, amount }, null, 2) }],
        structuredContent: { scrolled: false, axis, amount },
      };
    }
    await audit("mouse_scroll", { axis, amount, settleMs }, dryRun);
    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN mouse_scroll axis=${axis} amount=${amount}` }],
        structuredContent: { dryRun: true, scrolled: false, axis, amount },
      };
    }
    await performMouseScroll(axis, amount);
    if (settleMs > 0) await sleep(settleMs);
    return {
      content: [{ type: "text", text: JSON.stringify({ scrolled: true, axis, amount }, null, 2) }],
      structuredContent: { scrolled: true, axis, amount },
    };
  },
);
