import { z } from "zod";
import { audit } from "../lib/audit.js";
import { logRunEvent } from "../lib/runlog.js";
import { cursorPosition } from "../lib/hyprland.js";
import type { WindowId } from "../lib/types.js";
import { sleep } from "../lib/util.js";
import { resolvePointerCoordinates, resolveTargetBounds } from "../lib/pointer.js";
import { performEasedMove, performMouseClick, performMouseDrag, performMouseMove, performMouseScroll } from "../lib/mouse.js";
import { server } from "../registry.js";
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
      smooth: z.boolean().default(false).describe("Move along an eased path from the current cursor position (fires hover/motion events)."),
      steps: z.number().int().min(2).max(200).default(24),
      stepDelayMs: z.number().int().min(0).max(100).default(8),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ x, y, target, monitorName, windowId, settleMs, smooth, steps, stepDelayMs }) => {
    await audit("mouse_move", { x, y, target, monitorName, windowId, settleMs, smooth }, dryRun);
    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN mouse_move x=${x} y=${y} target=${target} smooth=${smooth}` }],
        structuredContent: { dryRun: true, moved: false, x, y, target, smooth },
      };
    }
    const resolved = await resolvePointerCoordinates(x, y, target, monitorName, windowId as WindowId | undefined);
    if (smooth) {
      await performEasedMove(resolved.x, resolved.y, steps, stepDelayMs);
    } else {
      await performMouseMove(resolved.x, resolved.y);
    }
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
      clickCount: z.number().int().min(1).max(3).default(1).describe("1 = single, 2 = double, 3 = triple click."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ x, y, target, monitorName, windowId, button, settleMs, clickCount }) => {
    await audit("mouse_click", { x, y, target, monitorName, windowId, button, settleMs, clickCount }, dryRun);
    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN mouse_click x=${x} y=${y} target=${target} button=${button} clickCount=${clickCount}` }],
        structuredContent: { dryRun: true, clicked: false, x, y, target, button, clickCount },
      };
    }
    const resolved = await resolvePointerCoordinates(x, y, target, monitorName, windowId as WindowId | undefined);
    await performMouseClick(resolved.x, resolved.y, button, settleMs, clickCount);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ clicked: true, x, y, target, button, clickCount, absoluteX: resolved.x, absoluteY: resolved.y }, null, 2),
        },
      ],
      structuredContent: { clicked: true, x, y, target, button, clickCount, absoluteX: resolved.x, absoluteY: resolved.y },
    };
  },
);

server.registerTool(
  "mouse_drag",
  {
    title: "Mouse Drag",
    description: "Press at a start point, drag along an eased path to an end point, then release (sliders, selections, drag-and-drop). Both points are relative to the same target.",
    inputSchema: {
      fromX: z.number().int().min(0),
      fromY: z.number().int().min(0),
      toX: z.number().int().min(0),
      toY: z.number().int().min(0),
      target: z.enum(["full", "monitor", "active_window", "window"]).default("full"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      button: z.enum(["left", "middle", "right"]).default("left"),
      steps: z.number().int().min(2).max(200).default(28),
      stepDelayMs: z.number().int().min(0).max(100).default(8),
      settleMs: z.number().int().min(0).max(3000).default(80),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ fromX, fromY, toX, toY, target, monitorName, windowId, button, steps, stepDelayMs, settleMs }) => {
    await audit("mouse_drag", { fromX, fromY, toX, toY, target, monitorName, windowId, button }, dryRun);
    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN mouse_drag (${fromX},${fromY})->(${toX},${toY}) target=${target} button=${button}` }],
        structuredContent: { dryRun: true, dragged: false, fromX, fromY, toX, toY, target, button },
      };
    }
    const from = await resolvePointerCoordinates(fromX, fromY, target, monitorName, windowId as WindowId | undefined);
    const to = await resolvePointerCoordinates(toX, toY, target, monitorName, windowId as WindowId | undefined);
    await performMouseDrag(from.x, from.y, to.x, to.y, button, steps, stepDelayMs, settleMs);
    const out = { dragged: true, fromX, fromY, toX, toY, target, button, fromAbsolute: { x: from.x, y: from.y }, toAbsolute: { x: to.x, y: to.y } };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
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
